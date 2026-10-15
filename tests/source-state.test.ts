import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import type { Contest, Platform } from '../src/models.js';

/**
 * Regression tests for a bug that turned a single auth failure into a lost sync.
 *
 * run() used to mark every fetched source "ok" (which advances last_fetch_at)
 * BEFORE talking to Google. When auth then failed, the freshly fetched contests
 * were thrown away, but the sources looked up-to-date, so the next runs skipped
 * them as "not due" and the contests were never persisted. Observed in the wild:
 * a 03:52 run fetched 17 contests and failed auth, and the 04:03 run reported
 * "no sources due; nothing to do".
 *
 * The fix: advance the fetch clock only after the sync succeeds.
 */

const state = vi.hoisted(() => ({
  contests: [] as Contest[],
  failures: [] as Array<{ platform: string; error: string }>,
  authFails: false,
}));

vi.mock('../src/sources/index.js', () => ({
  fetchAll: vi.fn(async () => ({
    contests: state.contests,
    failures: state.failures,
  })),
  filterContests: (c: Contest[]) => c,
}));

vi.mock('../src/notify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/notify.js')>();
  return { ...actual, notifyDesktop: vi.fn() };
});

vi.mock('../src/google/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/google/auth.js')>();
  class AuthError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return {
    ...actual,
    AuthError,
    authenticate: vi.fn(async () => {
      if (state.authFails) throw new AuthError('authorisation expired');
      return { calendar: {}, tasks: {} };
    }),
  };
});

// Stop the sync loop from doing real Google work after auth succeeds.
vi.mock('../src/google/calendar.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/google/calendar.js')>();
  return {
    ...actual,
    syncContestEvent: vi.fn(async () => ({ outcome: 'unchanged', eventId: 'evt' })),
  };
});
vi.mock('../src/google/tasks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/google/tasks.js')>();
  return {
    ...actual,
    ensureTaskList: vi.fn(async () => 'list'),
    indexTasks: vi.fn(async () => new Map()),
    syncContestTask: vi.fn(async () => ({ outcome: 'unchanged', taskId: 'task' })),
    pruneCompletedTasks: vi.fn(async () => undefined),
  };
});

const { run } = await import('../src/run.js');

let stateDir: string;

function config() {
  const base = loadConfig();
  return {
    ...base,
    ...{
      sources: Object.fromEntries(
        Object.entries(base.sources).map(([k, v]) => [k, { ...v, enabled: true, pollIntervalMinutes: 360 }]),
      ),
    },
    notifications: { desktop: true, suppressOutageNotifications: {} },
    paths: { ...base.paths, dbFile: join(stateDir, 'test.db') },
  };
}

function contest(platform: Platform): Contest {
  const start = DateTime.fromISO('2026-10-20T12:00:00Z', { zone: 'utc' });
  return {
    platform,
    platformId: '1',
    key: `${platform}:1`,
    name: 'Some Round',
    start,
    end: start.plus({ hours: 2 }),
    url: 'https://example.invalid',
    inProgress: false,
    warnings: [],
  };
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'srcstate-'));
  state.contests = [];
  state.failures = [];
  state.authFails = false;
});

describe('source fetch clock advances only after a successful sync', () => {
  it('does NOT advance the fetch clock when auth fails', async () => {
    state.contests = [contest('codeforces')];
    state.authFails = true;

    const summary = await run(config(), { force: true, interactive: false });
    expect(summary.failures.some((f) => f.scope === 'auth')).toBe(true);

    const store = new Store(join(stateDir, 'test.db'));
    expect(store.getSourceState('codeforces').last_fetch_at).toBeNull();
    store.close();
  });

  it('advances the fetch clock on a successful run', async () => {
    state.contests = [contest('codeforces')];
    state.authFails = false;

    await run(config(), { force: true, interactive: false });

    const store = new Store(join(stateDir, 'test.db'));
    expect(store.getSourceState('codeforces').last_fetch_at).not.toBeNull();
    expect(store.getSourceState('codeforces').last_status).toBe('ok');
    store.close();
  });

  it('records a failed source as error and does not mark it ok', async () => {
    state.failures = [{ platform: 'atcoder', error: 'HTTP 503' }];

    await run(config(), { force: true, interactive: false });

    const store = new Store(join(stateDir, 'test.db'));
    expect(store.getSourceState('atcoder').last_status).toBe('error');
    expect(store.getSourceState('atcoder').last_error).toContain('503');
    store.close();
  });
});
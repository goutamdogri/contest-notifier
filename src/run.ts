import { DateTime } from 'luxon';
import type { Config } from './config.js';
import { Store } from './db.js';
import { log } from './logger.js';
import { notifyDesktop, outageNotices } from './notify.js';
import { filterContests, fetchAll } from './sources/index.js';
import { contestContentHash, type Contest, type Platform } from './models.js';
import { authenticate, AuthError, type AuthClients } from './google/auth.js';
import {
  buildEventRequest,
  discoverExistingEvents,
  readStatus,
  syncContestEvent,
} from './google/calendar.js';
import {
  buildTaskRequest,
  ensureTaskList,
  indexTasks,
  pruneCompletedTasks,
  syncContestTask,
  taskContentHash,
} from './google/tasks.js';

export interface RunSummary {
  fetched: number;
  tracked: number;
  eventsCreated: string[];
  eventsUpdated: string[];
  eventsUnchanged: string[];
  tasksCreated: string[];
  failures: Array<{ scope: string; error: string }>;
  skippedSources: Platform[];
}

function isDue(store: Store, platform: Platform, intervalMinutes: number, now: DateTime): boolean {
  const state = store.getSourceState(platform);
  if (!state.last_fetch_at) return true;
  const last = DateTime.fromISO(state.last_fetch_at);
  if (!last.isValid) return true;
  return now.diff(last, 'minutes').minutes >= intervalMinutes;
}

export interface RunOptions {
  /** Fetch every source regardless of its poll interval. */
  force?: boolean;
  /** Do not contact Google; report what would be sent. */
  dryRun?: boolean;
  /** Never prompt; fail instead if authorisation is missing. */
  interactive?: boolean;
  /** Rebuild the local cache from Google's state before syncing. */
  resync?: boolean;
  /** Print the exact request bodies instead of a summary. */
  showBodies?: boolean;
}

export async function run(config: Config, options: RunOptions = {}): Promise<RunSummary> {
  const store = new Store(config.paths.dbFile);
  const now = DateTime.now().setZone(config.timezone);

  const summary: RunSummary = {
    fetched: 0,
    tracked: 0,
    eventsCreated: [],
    eventsUpdated: [],
    eventsUnchanged: [],
    tasksCreated: [],
    failures: [],
    skippedSources: [],
  };

  try {
    const candidates = (Object.keys(config.sources) as Platform[]).filter(
      (p) => config.sources[p].enabled,
    );

    const enabled = candidates.filter((platform) => {
      if (options.force) return true;
      const due = isDue(store, platform, config.sources[platform].pollIntervalMinutes, now);
      if (!due) {
        log.info('source not due yet, skipping', {
          platform,
          intervalMinutes: config.sources[platform].pollIntervalMinutes,
        });
        summary.skippedSources.push(platform);
      }
      return due;
    });

    if (enabled.length === 0) {
      log.info('no sources due; nothing to do');
      return summary;
    }

    const { contests, failures } = await fetchAll(config, now, enabled);
    summary.fetched = contests.length;

    for (const failure of failures) {
      const platform = failure.platform;
      if (candidates.includes(platform)) store.setSourceState(platform, 'error', failure.error);
      summary.failures.push({ scope: `source:${platform}`, error: failure.error });
    }

    // Source success is recorded only after the sync below succeeds. Advancing the
    // fetch clock here would mean that when a later step fails (most often Google
    // auth), the freshly fetched contests are discarded but the sources look
    // up-to-date, so the next runs skip them and the data is lost until the poll
    // interval elapses. Left until later, a failed run simply refetches next time.
    const fetchedOk = enabled.filter((p) => !failures.some((f) => f.platform === p));

    // Alert on a provider outage the moment it happens. Gated per provider so a
    // chronically flaky source can be silenced on its own without losing alerting
    // for the others. Only failing sources produce a notice; healthy ones are silent.
    for (const notice of outageNotices(
      failures,
      config.notifications.suppressOutageNotifications,
    )) {
      notifyDesktop(notice.title, notice.body, config.notifications.desktop);
    }

    const upcoming = filterContests(contests, config, now);
    summary.tracked = upcoming.length;

    if (upcoming.length === 0) {
      log.info('no contests inside the configured horizon');
    }

    if (options.dryRun) {
      await reportDryRun(upcoming, config, options.showBodies === true);
      pruneLocally(store, upcoming, config);
      return summary;
    }

    let clients: AuthClients;
    try {
      clients = await authenticate(config, { interactive: options.interactive !== false });
    } catch (err) {
      const message = err instanceof AuthError ? err.message : (err as Error).message;
      log.error('Google authorisation failed; skipping sync', { error: message });
      summary.failures.push({ scope: 'auth', error: message });
      notifyDesktop('Contest Notifier: not authorised', message.slice(0, 300), config.notifications.desktop);
      pruneLocally(store, upcoming, config);
      return summary;
    }

    if (options.resync) {
      const discovered = await discoverExistingEvents(
        clients,
        config,
        now.minus({ days: 2 }),
        now.plus({ days: config.horizonDays + 2 }),
      );
      for (const [key, eventId] of discovered) {
        const record = store.getContest(key);
        if (record && record.calendar_event_id !== eventId) {
          store.setCalendarEventId(key, eventId);
          log.info('recovered calendar event id from Google', { key, eventId });
        }
      }
      log.info('resync complete', { recovered: discovered.size });
    }

    const taskListId = await ensureTaskList(clients, config);
    store.setMeta('taskListId', taskListId);

    // Reconcile tasks from the API so a lost local cache cannot cause duplicates.
    const remoteTasks = await indexTasks(clients, taskListId);

    for (const contest of upcoming) {
      try {
        const existing = store.getContest(contest.key);
        const knownHash = existing?.content_hash;
        const desiredHash = contestContentHash(contest);
        const knownTaskId = existing?.task_id ?? remoteTasks.get(contest.key);

        const outcome = await syncContestEvent(clients, contest, config, knownHash);
        if (outcome.outcome === 'created') summary.eventsCreated.push(contest.key);
        else if (outcome.outcome === 'updated') summary.eventsUpdated.push(contest.key);
        else summary.eventsUnchanged.push(contest.key);

        const taskResult = await syncContestTask(clients, contest, config, taskListId, {
          taskId: knownTaskId,
          hash: existing?.task_hash ?? undefined,
        });
        if (taskResult.outcome === 'created') summary.tasksCreated.push(contest.key);

        store.upsertContest({
          key: contest.key,
          platform: contest.platform,
          platform_id: contest.platformId,
          name: contest.name,
          start_utc: contest.start.toUTC().toISO() ?? '',
          end_utc: contest.end.toUTC().toISO() ?? '',
          url: contest.url,
          content_hash: desiredHash,
          calendar_event_id: outcome.eventId,
          task_id: taskResult.taskId,
          task_list_id: taskListId,
          task_hash: taskContentHash(contest, config),
        });
      } catch (err) {
        const message = (err as Error).message;
        const status = readStatus(err);
        summary.failures.push({
          scope: `contest:${contest.key}`,
          error: status ? `${status}: ${message}` : message,
        });
        log.error('failed to sync contest', { key: contest.key, error: message });
      }
    }

    // Tasks are keyed off contests that have not finished yet. The set comes from the
    // local db rather than this run's fetch, because a source skipped by its poll
    // interval must not look absent and lose its still-future tasks.
    try {
      const keep = new Set([
        ...upcoming.map((c) => c.key),
        ...store.unendedContestKeys(DateTime.now().toUTC().toISO() ?? ''),
      ]);
      await pruneCompletedTasks(clients, taskListId, keep);
    } catch (err) {
      log.warn('task pruning failed', { error: (err as Error).message });
    }

    if (summary.eventsCreated.length > 0) {
      const names = upcoming
        .filter((c) => summary.eventsCreated.includes(c.key))
        .map((c) => c.name)
        .slice(0, 3)
        .join(', ');
      const extra = summary.eventsCreated.length > 3 ? ` (+${summary.eventsCreated.length - 3} more)` : '';
      notifyDesktop(
        `Contest Notifier: ${summary.eventsCreated.length} new contest(s)`,
        `${names}${extra}`,
        config.notifications.desktop,
      );
    }

    // Sync finished, so the fetched contests are persisted; now it is safe to
    // advance the fetch clock for the sources that actually returned.
    for (const platform of fetchedOk) {
      store.setSourceState(platform, 'ok');
    }

    log.info('run complete', {
      fetched: summary.fetched,
      tracked: summary.tracked,
      eventsCreated: summary.eventsCreated.length,
      eventsUpdated: summary.eventsUpdated.length,
      eventsUnchanged: summary.eventsUnchanged.length,
      tasksCreated: summary.tasksCreated.length,
      failures: summary.failures.length,
    });

    pruneLocally(store, upcoming, config);
    return summary;
  } finally {
    store.close();
  }
}

/** Drops local rows for contests that finished, so the db tracks only live contests. */
function pruneLocally(store: Store, upcoming: Contest[], config: Config): void {
  const nowUtc = DateTime.now().setZone(config.timezone).toUTC().toISO() ?? '';
  const live = new Set(upcoming.map((c) => c.key));
  const prunable = store.staleStartedKeys(nowUtc).filter((key) => !live.has(key));
  for (const key of prunable) {
    store.deleteContest(key);
  }
  if (prunable.length > 0) {
    log.debug('contests finished and dropped from local state', { count: prunable.length });
  }
}

async function reportDryRun(
  contests: Contest[],
  config: Config,
  showBodies: boolean,
): Promise<void> {
  console.log(`\nDRY RUN - nothing will be written to Google.\n`);
  console.log(`Timezone: ${config.timezone}`);
  console.log(`Horizon:  ${config.horizonDays} days`);
  console.log(`Calendar: ${config.calendarId} (colorId "${config.calendarColorId}" = Blueberry)`);
  console.log(`Reminders: ${config.reminders.method}\n`);

  if (contests.length === 0) {
    console.log('No contests to sync.');
    return;
  }

  for (const contest of contests) {
    const { event, reminderPlan } = buildEventRequest(contest, config);
    console.log('='.repeat(78));
    console.log(`${contest.key}`);
    console.log(`  summary    ${event.summary}`);
    console.log(`  start      ${event.start?.dateTime}  (${event.start?.timeZone})`);
    console.log(`  end        ${event.end?.dateTime}`);
    console.log(`  colorId    ${event.colorId}`);
    console.log(`  event id   ${event.id}`);
    console.log(`  url        ${contest.url}`);
    for (const reminder of reminderPlan.reminders) {
      console.log(`  reminder   ${String(reminder.minutes).padStart(5)}m  ${reminder.describe()}`);
    }
    for (const dropped of reminderPlan.dropped) {
      console.log(`  SKIPPED    ${dropped}`);
    }
    for (const warning of contest.warnings) {
      console.log(`  warning    ${warning}`);
    }

    if (showBodies) {
      console.log('\n  --- events.insert requestBody ---');
      // The overrides must be exactly what the API receives: only method and minutes.
      // reminderPlan.reminders also carries label/firesAtLocal for the human-readable
      // listing above, so it is reduced rather than serialised directly.
      const overrides = reminderPlan.reminders.map((r) => ({
        method: r.method,
        minutes: r.minutes,
      }));
      console.log(
        JSON.stringify({ ...event, reminders: { useDefault: false, overrides } }, null, 2)
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n'),
      );
      console.log('\n  --- tasks.insert requestBody ---');
      console.log(
        JSON.stringify(buildTaskRequest(contest, config), null, 2)
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n'),
      );
    }
    console.log('');
  }
}

# Architecture

How contest-notifier is put together, and the operational answers to the four
questions that matter most: where data comes from, how to configure it, how to stop
and start it, and what happens when a provider breaks.

---

## 1. Data acquisition

### 1.1 Fetching contest data

Every run follows the same six stages. Each stage is isolated, so a failure in one
does not stop the others.

```txt
  ┌─ 1. Poll gate ──────────────────────────────────────────────┐
  │  Per-source interval check against local state.          │
  │  Not due -> skipped, zero network calls.                 │
  └──────────────────────────┬────────────────────────────────┘
                             v
  ┌─ 2. Fetch (parallel, allSettled) ─────────────────────────┐
  │  codeforces · atcoder · codechef · leetcode            │
  │  Each returns Contest[] or throws. Isolated.           │
  └──────────────────────────┬────────────────────────────────┘
                             v
  ┌─ 3. Validate + normalise ────────────────────────────────┐
  │  zod per row: one bad contest is skipped, not the page. │
  │  Times -> UTC DateTime. Multi-session -> session length.│
  └──────────────────────────┬────────────────────────────────┘
                             v
  ┌─ 4. Filter + sort ──────────────────────────────────────┐
  │  now+5min < start <= now+horizonDays, sorted by start    │
  └──────────────────────────┬────────────────────────────────┘
                             v
  ┌─ 5. Authenticate (once per run) ────────────────────────┐
  │  Load refresh token -> refresh -> calendar + tasks clients│
  └──────────────────────────┬────────────────────────────────┘
                             v
  ┌─ 6. Reconcile (per contest) ─────────────────────────────┐
  │  Event: hash compare -> insert | patch | skip           │
  │  Task:  hash compare -> insert | patch | skip           │
  └─────────────────────────────────────────────────────────┘
```

### 1.2 Per-provider detail

None of the four providers require authentication. All are anonymous public
endpoints. Two have official APIs, two are reverse-engineered internals.

| Provider | Endpoint | Auth | Announced | Poll interval |
| --- | --- | --- | --- | --- |
| Codeforces | `codeforces.com/api/contest.list?gym=false` | None | ~16 days ahead | 360 min |
| AtCoder | `atcoder.jp/contests/` (HTML scrape) | None | ~29 days ahead | 360 min |
| CodeChef | `codechef.com/api/list/contests/future` | None (undocumented) | ~2-4 days ahead | 60 min |
| LeetCode | `leetcode.com/graphql` (GraphQL POST) | None (undocumented) | ~1 week ahead | 360 min |

Poll intervals differ because announcement lead time differs. CodeChef is polled
hourly because it only announces contests two to four days out; polling it hourly is
what keeps new contests inside the horizon quickly. Codeforces and AtCoder are polled
every six hours, which also avoids re-downloading Codeforces' 410 KB and LeetCode's
75 KB full-history responses for no benefit.

### 1.3 Where authentication IS used

Authentication exists in exactly one place: writing to Google. Reading contests
requires nothing.

The OAuth grant is:

| Property | Value |
| --- | --- |
| Scopes | `calendar.events`, `tasks` |
| Token file | `~/.config/contest-notifier/token.json`, mode `0600` |
| Refresh | `refresh_token` grant, automatic on every run |
| Flow | PKCE (S256) with a loopback redirect on `127.0.0.1` |

`calendar.readonly` is deliberately **not** requested. It cannot write, and the only
reason to add it would be `colors.get`, which is never called. A smaller scope set
means a less alarming consent screen, and it avoids the 403 you get from `colors.get`
with a `calendar.events`-only token.

The consent screen audience **must** be "Internal", or the app must be **published**
(status "In production"). On the "Testing" audience, Google expires refresh tokens for
unverified apps after 7 days, which silently breaks the background timer roughly once a
week. "Internal" needs a Workspace organisation; for a personal Gmail account the only
option is to publish the app. Publishing an unverified app is allowed for personal use
(it shows a warning and is capped at 100 users) but the Branding page requires a home
page and privacy policy URL. `docs/` in this repo is served via GitHub Pages for exactly
that purpose.

### 1.4 The normalised shape

All four providers are forced into one `Contest` interface (`src/models.ts`), which is
what lets the Google layer stay provider-agnostic:

```ts
interface Contest {
  platform: 'codeforces' | 'atcoder' | 'codechef' | 'leetcode';
  platformId: string;      // as the platform knows it: "2275", "abc478", "weekly-contest-522"
  key: string;             // "<platform>:<platformId>", the global dedup key
  name: string;
  start: DateTime;         // always UTC internally, rendered in config.timezone
  end: DateTime;
  url: string;
  ratedRange?: string;     // AtCoder only
  inProgress: boolean;
  warnings: string[];      // surfaced in logs and the event description
}
```

### 1.5 Data store

`~/.local/state/contest-notifier/notifier.db`, via Node's built-in `node:sqlite`
(no native module to compile). Three tables:

| Table | Purpose |
| --- | --- |
| `contests` | One row per tracked contest: content hash, event id, task id, task hash |
| `source_state` | Last fetch time, last status, last error **per source** |

`last_fetch_at` is the poll-interval clock. It is advanced **only after the whole run
succeeds**, not right after the fetch. This matters: if a later step fails (most often
Google auth), advancing the clock there would discard the freshly fetched contests while
making the sources look up-to-date, so the next hourly runs would skip them as "not due"
and the data would be lost until the interval elapsed. Deferring the update makes a
failed run simply refetch next time. A source that genuinely fails to fetch is recorded
as `error` with its message and, separately, throttled.
| `meta` | Small key/value, e.g. the resolved task list id |

The database is a **cache, not the source of truth**. Google is authoritative. If it
is deleted, `contest-notifier resync` rebuilds local state from Google's side by
reading back the private `cn_key` property on each event.

### 1.6 Idempotency

A re-run must never create duplicates. Four independent mechanisms:

1. **Deterministic event IDs.** `cn` + first 30 hex chars of `SHA-256(platform:id)`.
   The same contest always maps to the same Google event id, so re-inserting is a
   server-side no-op rather than a second event.
2. **`409 CONFLICT` becomes an update.** Google rejects a duplicate insert with 409;
   the code catches it and patches instead.
3. **Content hashing.** A hash over name, start, end, url and rated range is stored
   locally. Unchanged contests produce zero API writes. A contest the platform revises
   changes the hash and triggers an in-place patch.
4. **Tasks dedup via notes.** The Tasks API has no labels and no extended properties,
   so a dedicated task list plus a `contest-notifier-key: <key>` line parsed back out
   of each task's notes is the dedup boundary. Membership in the dedicated list is
   itself the signal, so nothing can collide with your real tasks.

Verified empirically, not assumed: consecutive runs report
`eventsCreated: 0, eventsUnchanged: 14, tasksCreated: 0`.

### 1.7 A gap worth knowing

All of the above protects against **events this tool created**. If you add a contest
to your calendar by hand, the tool will not detect it and will create its own copy,
because a hand-made event carries no `cn_key` marker. A title-and-start-time match
check would close this; it is not implemented.

---

## 2. Changing configuration

### 2.1 Precedence

Later entries win:

```bash
built-in DEFAULT_CONFIG  <  ~/.config/contest-notifier/config.json  <  per-source defaults
```

The file is optional. With no file present, built-in defaults apply. Nested objects
are merged key-by-key, not replaced wholesale, so a config containing only
`{"horizonDays": 21}` does not wipe out your reminder settings.

### 2.2 Where the file lives

```bash
~/.config/contest-notifier/config.json     (or config.json in the project directory)
```

Copy the template first:

```bash
cp config.example.json ~/.config/contest-notifier/config.json
$EDITOR ~/.config/contest-notifier/config.json
```

Inspect the effective result at any time:

```bash
npm run status     # prints merged config, paths, per-source state, tracked contests
npx tsx src/cli.ts defaults   # built-in values only, ignoring your file
```

### 2.3 The complete setting reference

| Key | Default | Meaning |
| --- | --- | --- |
| `timezone` | `Asia/Kolkata` | Zone for the 06:00 anchor and all display |
| `horizonDays` | `14` | Only sync contests starting within this window |
| `calendarId` | `primary` | Target calendar |
| `calendarColorId` | `"9"` | Blueberry. `"8"` is Graphite |
| `taskListName` | `Contests` | Dedicated list, created on first run |
| `reminders.method` | `popup` | `popup` or `email` |
| `reminders.oneDayBeforeMinutes` | `1440` | 1 day before |
| `reminders.sixAmLocalHour` | `6` | Wall-clock anchor hour |
| `reminders.twoHoursBeforeMinutes` | `120` | 2 hours before |
| `reminders.fiveMinutesBeforeMinutes` | `5` | 5 minutes before |
| `filters.minLeadMinutes` | `5` | Skip contests starting sooner |
| `filters.maxEventHours` | `12` | Longer spans clamp to declared session length |
| `sources.<p>.enabled` | `true` | Per-source on/off |
| `sources.<p>.pollIntervalMinutes` | see 1.2 | Per-source minimum fetch interval |
| `notifications.desktop` | `true` | `notify-send` on new contests, auth failure, and provider outage |
| `notifications.suppressOutageNotifications.<p>` | unset | Set `true` to mute outage pop-ups for one provider |

### 2.4 Change the execution frequency

Two different knobs, and they are not interchangeable.

**Per-source fetch interval** — `pollIntervalMinutes`:

```json
{
  "sources": {
    "codechef": { "pollIntervalMinutes": 30 },
    "codeforces": { "pollIntervalMinutes": 720 }
  }
}
```

**How often the timer wakes** — in the systemd unit, not the config. See 2.6.

Keep the timer interval at or below your smallest `pollIntervalMinutes`, otherwise a
source is never actually fetched on schedule. With CodeChef at 60 and the timer at 60,
CodeChef is fetched roughly every other wake because of the randomised delay. That is
harmless, but if you want CodeChef reliably every hour, set its interval to 30.

### 2.5 Change the window size

```json
{ "horizonDays": 21 }
```

Applies on the next run, no restart needed. Currently 14 contests are tracked at 14
days; 21 would pull in a few more from the far end.

Two caveats:

- **The 1-day-before reminder needs the event to already exist.** Beyond ~14 days,
  contests are created so early that their 1-day reminder fires immediately on
  creation. Harmless but noisy. This is the main reason 14 is the sensible ceiling.
- **Extending the window cannot help CodeChef.** Its upstream only announces contests
  2-4 days ahead, so there is nothing to fetch beyond that regardless of the setting.

### 2.6 Change the timer interval

Edit `~/.config/systemd/user/contest-notifier.timer`, then reload:

```bash
# OnCalendar=*-*-* 00/2:00:00   -> every 2 hours instead of hourly
$EDITOR ~/.config/systemd/user/contest-notifier.timer
systemctl --user daemon-reload
systemctl --user restart contest-notifier.timer
```

Always edit the copy under `~/.config/systemd/user/`, **not** the one in the project
directory. The installed copy is what systemd reads; the project copy is only a
template. This is the single most common way to get confused about why a change had
no effect.

### 2.7 Changes take effect immediately

No restart is needed for any config change. The timer invokes a fresh
`node dist/cli.js run` each cycle, so config and code are re-read every time.

For **code** changes you do need to rebuild, because the timer runs `dist/`:

```bash
npm run build     # tsc -> dist/
```

---

## 3. Stopping and starting automatic execution

Two units, and the distinction matters:

| Unit | Role |
| --- | --- |
| `contest-notifier.timer` | The schedule. Triggers the service hourly. **This is what you enable/disable.** |
| `contest-notifier.service` | One run of the tool. `oneshot`, exits when done. |

### 3.1 Stop it (keep it installed)

```bash
systemctl --user stop contest-notifier.timer
systemctl --user disable contest-notifier.timer
```

`disable` removes the boot-time trigger, so it will not restart automatically. Both
verbs are needed: `stop` alone stops it now but it returns after reboot.

### 3.2 Start it again

```bash
systemctl --user enable --now contest-notifier.timer
systemctl --user list-timers contest-notifier.timer    # confirm next run
```

### 3.3 Stop it temporarily (this boot only)

```bash
systemctl --user stop contest-notifier.timer    # returns after the next reboot
```

### 3.4 Pause just one source, no systemd involved

```json
{ "sources": { "codechef": { "enabled": false } } }
```

The other three keep running. Preferable to stopping everything when only one
provider is misbehaving.

### 3.5 Full removal

```bash
systemctl --user disable --now contest-notifier.timer
rm ~/.config/systemd/user/contest-notifier.{service,timer}
systemctl --user daemon-reload
```

This leaves your calendar events, tasks, database and OAuth token in place. Delete
those separately if you want them gone.

### 3.6 Troubleshooting commands

```bash
systemctl --user status contest-notifier.timer      # is it armed, when is next
systemctl --user list-timers contest-notifier.timer
journalctl --user -u contest-notifier.service -n 50 # recent runs
journalctl --user -u contest-notifier.service -f     # follow live
journalctl --user -t contest-notifier-failure -n 20  # captured failure diagnostics
npm run status                                      # last fetch per source
```

**Silent launch failures.** A service that cannot even execute leaves *nothing* in the
app log, because no app ran. This is what `status=203/EXEC` means: systemd could not
run the `ExecStart` binary. The classic cause is a version-pinned nvm path
(`~/.nvm/versions/node/v24.13.0/bin/node`) that disappears when Node is upgraded. The
unit therefore uses `/usr/bin/node`, and carries `OnFailure=contest-notifier-failure.service`
so any failure to start — `203/EXEC`, a crash, a non-zero exit, a timeout — raises a
critical desktop notification and dumps `systemctl status` into the journal tagged
`contest-notifier-failure`. Check it is wired with
`systemctl --user show contest-notifier.service -p OnFailure`.

### 3.7 Boot behaviour

| Mechanism | Effect |
| --- | --- |
| `systemctl --user enable` | Starts the timer at every boot |
| `loginctl enable-linger $USER` | Runs even when **not logged in** |
| `Persistent=true` | Catches up on a run missed while suspended or powered off |

Linger is already enabled on this machine (`Linger=yes`), so the timer runs whether or
not you are logged in. Confirmed with `loginctl show-user $USER -p Linger`.

One real limitation: **the timer cannot fire while the machine is asleep or off.**
`Persistent=true` means it runs once shortly after waking, but contests announced
during that window are picked up on the following cycle, not instantly.

Note the contrast with the reminders themselves: the four Calendar notifications are
sent by Google, so they reach your phone even when the laptop is shut down. Only the
*creation* of events needs this machine awake.

---

## 4. Failure handling

### 4.1 A provider failure is never silent

Five mechanisms, none of which swallow the error.

**a) Structural isolation.** `fetchAll` uses `Promise.allSettled`, not
`Promise.all`. A rejection from one provider cannot cancel the others, and a partial
run that syncs 3 of 4 sources is treated as success for those 3.

**b) Errors are recorded per source.** Each failure lands in the `source_state` table
with its message, readable later:

```bash
npm run status
#   codeforces  enabled=true  every  360m  last fetch: 2 hours ago
#   atcoder     enabled=true  every  360m  last fetch: 40 minutes ago  last error: HTTP 403
```

**c) Non-zero exit code.** `run` returns `1` when `summary.failures` is non-empty.
Under systemd this surfaces as `Result: exit-code`, which `systemctl status` shows and
which is greppable in the journal:

```bash
systemctl --user show contest-notifier.service -p Result -p ExecMainStatus
```

**d) Printed problems block.** The run summary ends with a `Problems:` section naming
each failed scope:

```txt
Problems:
  [source:atcoder] GET https://atcoder.jp/contests/ failed after 4 attempt(s): HTTP 403
```

**e) Structured logging.** Every failure is logged with its scope at `error` level to
`~/.local/state/contest-notifier/notifier.log`.

**e) Desktop notification on outage.** The moment `fetchAll` reports a failure, a
pop-up is raised with the provider name and the underlying reason. The retry
boilerplate is rewritten so the cause leads:

```
Contest Notifier: CodeChef feed unavailable
HTTP 503 Service Unavailable  (https://codechef.com/api/list/contests/future)  after 4 attempts
```

This is a pop-up per *failing* provider, not per run, and only failures produce one.
A provider that is merely not due yet is silent.

**Muting one provider.** Set the flag for that platform only:

```json
"notifications": {
  "desktop": true,
  "suppressOutageNotifications": { "codechef": true }
}
```

Everything else keeps alerting; only that provider goes quiet. Suppression affects
the pop-up only. The failure is still recorded in `status`, the log, the journal and
the non-zero exit code, so a muted provider is never silently forgotten:

```
npm run status        # Problems: shows it regardless of suppression
journalctl --user -u contest-notifier.service
```

`npm run status` also prints which providers are currently muted, so you can confirm
a flag took effect:

```
desktopAlerts   on  outage muted: codechef
```

To mute everything, set `notifications.desktop` to `false`.

**On the noise trade-off.** Because the timer wakes hourly, a provider that fails on
every poll raises a pop-up each hour. That is the intended behaviour for alerting,
but it is exactly the case the mute flag exists for, which is why the flag is
per-provider rather than global.

### 4.3 Retry and backoff

Per HTTP request, in `src/http.ts`:

| Condition | Behaviour |
| --- | --- |
| 4xx (not 429) | No retry; permanent, fails fast |
| 429 | Retried with exponential backoff |
| 5xx, network error, timeout | Retried, 3 attempts |
| Backoff | 1s, 2s, 4s, capped at 8s |
| Timeout | 20s per attempt |

A 4xx is not retried because a rejected request will not become valid by asking again,
and retrying would stall the run for no gain.

### 4.4 Per-contest isolation

A failure syncing one contest is caught and recorded, then the run continues with the
rest. You get `[contest:atcoder:abc478] ...` in the `Problems:` block rather than a
run that stops at contest 3 of 14.

### 4.5 Row-level validation

Each contest row is validated individually. One unexpected contest shape is skipped;
it cannot discard the whole listing. This matters most for Codeforces, where a single
response contains 2000+ contests, and for CodeChef, whose endpoint is undocumented and
has already broken once during development.

### 4.6 Degraded auth

If the refresh token is rejected, the run does not crash:

- Logged as a warning, token file removed so the next run starts clean.
- Under systemd (`--non-interactive`) the run fails with a clear instruction rather
  than hanging on a browser prompt that will never be answered.
- A desktop notification **is** raised, because an expired grant is a genuine
  action-required condition rather than a transient fault.
- Existing events are untouched. Only new contests are missed until you re-authorise.

### 4.7 Failure matrix

| Failure | Detected by | Exit | Alert | Other sources |
| --- | --- | --- | --- | --- |
| Provider down (5xx) | `allSettled` | `1` | Log + journal | Unaffected |
| Provider 403/404 | `allSettled` | `1` | Log + journal | Unaffected |
| Provider rate-limited (429) | Backoff, then error | `1` if all retries fail | Log | Unaffected |
| Malformed row | zod, row skipped | `0` | None | Unaffected |
| No contests found | Horizon filter | `0` | None | Unaffected |
| Token expired | `authenticate` | `1` | **Desktop notification** | Fetched, not written |
| One contest fails to sync | Per-contest try/catch | `1` | Log | Others sync |
| Disk/db problem | Uncaught | `1` | Log | Run aborts |

---

## Component map

| Path | Responsibility |
| --- | --- |
| `src/cli.ts` | Commands, flags, exit codes |
| `src/run.ts` | Orchestration: gate, fetch, filter, auth, reconcile, prune |
| `src/config.ts` | Defaults, XDG paths, config merge, credential discovery |
| `src/models.ts` | `Contest`, platform list, content hash |
| `src/reminders.ts` | Offset arithmetic, 06:00 anchor, collision dedup |
| `src/http.ts` | fetch wrappers, timeout, backoff, `postJson` for GraphQL |
| `src/db.ts` | SQLite schema, migrations, contest and source state |
| `src/logger.ts` | Rotating file logger |
| `src/notify.ts` | `notify-send` desktop notifications |
| `src/sources/*.ts` | One module per provider; pure `parse*` exported for tests |
| `src/google/auth.ts` | OAuth PKCE, token persistence, refresh |
| `src/google/calendar.ts` | Event request build, sync, drift, resync |
| `src/google/tasks.ts` | List discovery, task build, notes-key dedup, prune |
| `systemd/*` | Service, timer, and `OnFailure` handler templates (copy, don't edit in place) |
| `docs/*` | GitHub Pages home page and privacy policy for OAuth branding |

## Test coverage

111 tests across 7 files. `npm run test`, `npm run typecheck`.

Deliberately weighted toward parsers and reminder arithmetic, because two providers are
undocumented and one has no API at all. Several tests exist purely as regression guards
for bugs that actually occurred: the AtCoder 9-hour timezone offset, the UTC-vs-local
06:00 anchor, the reminder sign inversion, the missing `content-type` on the LeetCode
POST (HTTP 499), and the shared-warnings-array aliasing.

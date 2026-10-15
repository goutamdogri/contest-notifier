# Contest Notifier

Watches Codeforces, AtCoder, CodeChef and LeetCode for upcoming contests and puts
each one in your Google Calendar (with reminders) and Google Tasks (as a checklist
item).

Runs in the background on your laptop via a systemd user timer.

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for how it works end to end, how to change
configuration, how to stop/start it, and what happens when a provider fails.

---

## What it creates, per contest

**One Google Calendar event**

| Field | Value |
|---|---|
| Summary | `[Codeforces] Codeforces Round (Div. 2)` |
| Colour | **Blueberry** (`colorId: "9"`) |
| Start / End | Real contest times in your timezone |
| Description | Platform, local start/end, duration, rated range, **and the contest link** |
| Reminders | 4 popups: 1 day before, that day at 06:00, 2 hours before, 5 minutes before |

**One Google Task** titled `Register for <platform>: <contest name>`, with the
contest link in the notes.

### Why the reminders are on the event and not the task

This is the single most important design decision in the project, and it is forced
by the Google APIs:

- **The Google Tasks API has no `reminders` field at all.** It is not deprecated, it
  never existed. Sending one returns `HTTP 400 Cannot find field`. So a Task cannot
  carry a notification time.
- **`Task.due` is date-only.** Google silently discards the time portion, and there
  is no `timeZone` field. A Task can show up on a date grid; it cannot be scheduled
  to alert you at 18:35.
- **Google Calendar reminders are "N minutes before start"** (valid range 0–40320,
  maximum 5 per event). There is no absolute-time reminder field.

So the three "X before" notifications map directly onto Calendar overrides, and the
06:00 notification is computed as `start − 06:00 local`:

| Requirement | Encoded as | Fires at |
|---|---|---|
| 1 day before | `{popup, 1440}` | exactly 24 h before |
| That day at 6am | `{popup, start − 06:00}` | exactly 06:00 your time |
| 2 hours before | `{popup, 120}` | exactly 2 h before |
| 5 minutes before | `{popup, 5}` | exactly 5 min before |

Two consequences worth knowing:

- **The reminders fire from Google's servers**, so they reach your phone even when
  the laptop is asleep. This tool only has to be awake to *create* the event.
- **If a contest starts before 06:00** (CodeChef sometimes starts at midnight), a
  06:00 anchor that day would fall *after* the start, so the anchor moves back to the
  previous day's 06:00. You can see this in `npm run dry-run`.

---

## Setup

### 1. Google Cloud project

1. <https://console.cloud.google.com> → create a project.
2. **APIs & Services → Library** → enable **Google Calendar API** and **Google Tasks API**.
3. **Google Auth Platform → Branding → Audience → Internal**.
   > **Do not leave this on "Testing".** Google expires refresh tokens for
   > unverified apps after **7 days**, which would silently break the background
   > timer roughly once a week. "Internal" avoids this entirely for a personal project.
4. **Google Auth Platform → Clients → Create Client → Desktop app** → download the JSON.
5. Put it in the project directory as `client_secret_*.json` (the tool finds it
   automatically), or move it to `~/.config/contest-notifier/credentials.json`.

### 2. Install

```bash
npm install
npm run build
```

### 3. Authorise

```bash
npm run auth
```

This prints a URL, waits for the browser redirect on `127.0.0.1`, and writes a
refresh token to `~/.config/contest-notifier/token.json` with mode `0600`.

### 4. Verify before letting it write anything

```bash
npm run dry-run          # what would be created, nothing is sent
npm run dry-run -- --bodies   # the exact events.insert request bodies
```

### 5. Run in the background

```bash
mkdir -p ~/.config/systemd/user
cp systemd/contest-notifier.{service,timer,failure.service} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now contest-notifier.timer

sudo loginctl enable-linger "$USER"   # optional: also runs before you log in
```

```bash
systemctl --user list-timers contest-notifier.timer
journalctl --user -u contest-notifier.service -n 50
```

> **Node path.** The `.service` file uses `/usr/bin/node` on purpose. Do **not**
> switch it to an nvm path like `~/.nvm/versions/node/v24.13.0/bin/node`: nvm
> paths are version-pinned and disappear when you upgrade Node, at which point
> systemd fails every run with `status=203/EXEC` and nothing lands in the log.
> `/usr/bin/node` (system package) never moves. If you only have Node via nvm,
> either install the system package or point `ExecStart` at a stable symlink you
> control.

> **Silent failures.** `contest-notifier.service` has
> `OnFailure=contest-notifier-failure.service`, which logs the failure and raises a
> critical desktop notification. If the hourly run ever stops working, you get a
> pop-up instead of a week of silence. Confirm it is wired up with
> `systemctl --user show contest-notifier.service -p OnFailure`.

---

## Commands

```bash
npm run auth          # authorise with Google (interactive)
npm run fetch         # list contests that would be synced; writes nothing
npm run dry-run       # full plan including reminder offsets
npm run run           # do the real sync
npm run status        # config, paths, last fetch times, tracked contests
npm run test          # unit tests
npm run typecheck     # strict TypeScript check

npx tsx src/cli.ts probe-colors   # create one event per colour id, visually confirm Blueberry
npx tsx src/cli.ts resync         # rebuild local state from Google, then sync
npx tsx src/cli.ts revoke         # revoke the authorisation and delete the token
npx tsx src/cli.ts --help
```

Useful flags: `--force` (ignore poll intervals), `--dry-run`, `--bodies`,
`--verbose`, `--quiet`, `--non-interactive`.

---

## Troubleshooting

### Nothing is being added to the calendar

Two failures look identical from the outside ("it just stopped"). Check both.

**1. Is the service even starting?** A run that cannot launch leaves no trace in
the app log, because nothing ran.

```bash
systemctl --user status contest-notifier.service
journalctl --user -u contest-notifier.service -n 30
```

- `status=203/EXEC` — systemd could not run the `ExecStart` binary. Almost always a
  stale nvm Node path. Use `/usr/bin/node` (see Setup → 5).
- `status=1` with `Google authorisation failed` in the journal — the token problem
  below.

**2. Has the Google token expired?** If the log contains `invalid_grant` or
`re-consent required`, the refresh token is dead and the tool deletes it. Re-authorise:

```bash
npm run auth
```

**Why it happens every ~7 days.** Refresh tokens for an OAuth app whose publishing
status is **Testing** expire after 7 days. The fix is in the Google Cloud console:
**Google Auth Platform → Audience**. Either

- set User type to **Internal** (Google Workspace accounts only), or
- click **Publish app** to move from Testing to **In production**.

A workspace ("Internal") project never hits this. A personal Gmail project must be
published; leaving it on Testing will keep breaking the timer weekly no matter what
the code does.

### The timer is active but the service result is "failed"

```bash
systemctl --user list-timers contest-notifier.timer   # is it scheduled?
systemctl --user show contest-notifier.service -p OnFailure   # is alerting wired?
```

With `OnFailure` set, a failing run also raises a critical desktop notification and
writes the `systemctl status` output to the journal under the
`contest-notifier-failure` tag.

---

## Configuration

Copy `config.example.json` to `~/.config/contest-notifier/config.json` (or the
project directory) to override any default. Run `npx tsx src/cli.ts defaults` to see
the built-in values.

| Key | Default | Meaning |
|---|---|---|
| `timezone` | `Asia/Kolkata` | Local zone used for the 06:00 anchor and all display |
| `horizonDays` | `14` | Only sync contests starting within this window |
| `calendarId` | `primary` | Target calendar |
| `calendarColorId` | `"9"` | Blueberry. (`"8"` is Graphite, a common mis-citation.) |
| `taskListName` | `Contests` | Dedicated list created on first run |
| `reminders.method` | `popup` | `popup` or `email` |
| `reminders.sixAmLocalHour` | `6` | The wall-clock anchor hour |
| `filters.maxEventHours` | `12` | Longer spans fall back to the declared session length |
| `sources.*.pollIntervalMinutes` | CF/ATC/LC 360, CC 60 | Per-source minimum fetch interval |
| `notifications.desktop` | `true` | Pop-ups for new contests, auth failure, and provider outage |
| `notifications.suppressOutageNotifications` | `{}` | e.g. `{ "codechef": true }` to mute outage pop-ups for one provider only |

---

## How it behaves

**Idempotent.** Each Calendar event gets a deterministic id derived from a SHA-256 of
`platform:id` (`cn<30 hex chars>`). Re-inserting the same event is a server-side
no-op returning `409`, which is then handled as an update. A crash halfway through a
run cannot create duplicates. The Tasks API has no such mechanism, so dedup there uses
a dedicated list plus a `contest-notifier-key:` line parsed back out of the notes.

**Self-healing.** Each contest's start, end, name and link are hashed. If the
platform revises a contest, the hash changes and the event is patched instead of
duplicated. `--resync` rebuilds local state from Google's side, which is the recovery
path if you ever delete `notifier.db`.

**Resilient to upstream breakage.** Only Codeforces has a real public API; the other
two are scraped or reverse-engineered, so each source is isolated and one failing
never blocks the others. Rows are validated individually so a single unexpected
contest cannot discard a whole listing.

**Polling is not uniform.** CodeChef only announces contests ~2–4 days ahead, so it
is polled hourly. Codeforces (~16 days), AtCoder (~29 days) and LeetCode (~1 week for
both the weekly and biweekly series) are polled every 6 hours, which also avoids
re-downloading Codeforces' 410 KB and LeetCode's 75 KB full-history responses
pointlessly.

LeetCode contests always start on the hour, so its events can trip the reminder
collider described under **Known limitations**: a weekly contest at 08:00 local makes
"that day at 06:00" and "2 hours before" the same instant, so only 3 reminders are set.

---

## Upstream quirks this works around

Worth knowing if a source ever breaks and you need to fix it:

**Codeforces** — official API, no auth. `contest.list` returns the entire history
(2000+ contests) with no server-side phase filter, and has **no `endTimeSeconds`**
(the end is computed from `durationSeconds`). `gym=true` returns gyms *only*, a
disjoint set, despite common belief. All Codeforces **HTML pages 403** generic HTTP
clients behind Cloudflare even with full browser headers, so the API is the only
supported path. Documented limit is 1 request / 2 seconds.

**AtCoder** — **there is no API.** The `?format=json` route was removed site-wide
(every JSON path now returns HTML) and no iCal feed exists, so the contests index is
scraped. Specific traps: times are `+0900`, which is *not* valid ISO 8601 and makes
`DateTime.fromISO` return null; the duration cell is unpadded `HH:MM` that exceeds 24
hours for marathons (`240:00`); the name cell is prefixed with `Ⓐ`/`Ⓗ` and `◉`
**text nodes** inside spans, so stripping tags is not enough. The popular
`kenkoooo.com` mirror looks like an easy win but contains **zero** future contests.

**CodeChef** — the official API is OAuth-gated and unusable anonymously, so the
undocumented internal endpoint is used. Critically, `/api/list/contests/upcoming`
(and `/past`, `/current`) are **silently broken**: they return HTTP 200 with
`status: "success"` and the 20 oldest contests ever run, from 2009. The working route
is `/api/list/contests/future`. All `page`/`limit` parameters are ignored. Use the
`*_date_iso` fields: the plain date strings carry no offset and contain a double space
(`"03 Oct 2026  00:00:32"`). `contest_duration` is a string in minutes and is *not*
`end − start` for recurring containers, which is why a 50-hour "Placement Prep
Weekends" block is clamped to its declared 120-minute session.

**LeetCode** — no public API and no iCal feed, and `/contest/` HTML **403s** generic
clients, but the internal GraphQL endpoint accepts an unauthenticated POST. Three
specific traps:

- **Schema introspection is blocked.** `{ __type(name: "ContestNode") }` returns
  `Query unavailable`, so the schema cannot be discovered programmatically; the field
  names have to be established by probing and reading the errors.
- **`upcomingContests` is a trap.** It returns only the single nearest *Weekly*
  Contest and never the *Biweekly* ones, so using it silently drops half of LeetCode's
  contests. `allContests` is the field that works, and includes both series.
- **A POST without `content-type` fails as HTTP 499**, which is LeetCode's edge
  reporting "client closed request" — the query is never parsed. This looks like a
  network error rather than a bad request, so it is easy to misdiagnose.

GraphQL also reports unknown fields as **HTTP 400** with an `errors` array rather than
a transport failure, so the response body has to be inspected even on a 4xx.

---

## Tests

```bash
npm run test     # 139 tests
npm run typecheck
```

The parsers are tested against fixtures that encode the quirks above, because both
scraped sources are undocumented and have already broken once during development.
Several tests exist purely as regression guards for bugs that actually occurred here:
the 9-hour AtCoder timezone offset, the UTC-vs-local 06:00 anchor, the reminder sign
inversion, and the decorative-glyph stripping.

---

## Known limitations

- **Codeforces Div1+Div2 rounds produce two events** at the same time, because they
  are two separate contests with separate ids. This is the platform's own truth, but
  you may want them merged.
- **No auto-registration.** Codeforces and CodeChef have no public registration API
  (Codeforces needs login + `apiSig`, CodeChef needs session cookies + CSRF) and
  scripting their signup flows would be fragile and likely against their terms. AtCoder
  needs no registration. You get a Task reminder instead.
- **Contests already started are not back-filled.** The tool only creates events for
  contests starting in the future.
- **Systemd timers do not run while the laptop is suspended**, but `Persistent=true`
  catches up on resume, and the Calendar reminders themselves are unaffected.
- **The Tasks API is not a scheduling API.** If you expected "notify me 24h before" to
  come from the Task, it cannot be done that way; that is what the Calendar event is for.
- **A contest can get 3 reminders instead of 4** when "that day at 06:00" lands on the
  same instant as another reminder. LeetCode weekly contests start at 08:00 local, which
  makes the 06:00 anchor exactly 2 hours before the start, so it collides with
  "2 hours before". The dedup keeps the earlier one and logs which it dropped, rather
  than sending the same notification twice. Move `sixAmLocalHour` in your config to
  avoid it if you would rather keep all four.
- **LeetCode biweekly and weekly can collide.** Both run on Saturday/Sunday, and in some
  weeks both fall inside the 14-day horizon at once. They are separate events because
  they are separate contests.
- **LeetCode is fetched from an endpoint its `robots.txt` disallows.** `Disallow: /graphql`
  is present, so this is a deliberate choice rather than an oversight. The documented
  REST alternative returns Cloudflare HTTP 403 and does not work. Set
  `sources.leetcode.enabled` to `false` if you would rather not.
- **A failed provider pops up on every poll.** The timer wakes hourly, so a source that
  is down for hours will notify each time rather than once. Use
  `notifications.suppressOutageNotifications` for that provider to stop the pop-ups
  without losing alerting for the others. Suppression only silences the pop-up; the
  failure is still reported by `npm run status`, the log, the journal and the exit code.

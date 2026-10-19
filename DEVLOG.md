# DEVLOG - Cachey_McCacheface

## 2026-06-25 - Sprint 0: genesis + v1 scaffold

### Origin
Started as a question in The_Lab: can I measure "usage per million tokens"
across the day to find a cheaper time to work? Research killed the original
premise and reshaped the project.

### Key findings that shaped scope
- **Time-of-day usage penalty was real but is gone.** Anthropic ran a
  weekday-morning (PT) peak-hour limit reduction (up to ~50%), then on
  2026-05-06 doubled Claude Code 5-hour limits AND removed the peak-hour
  reduction for Pro/Max. So wall-clock time is no longer a cost lever. The
  original "is daytime 3x?" question is answered: currently no.
- **Caching is the real non-determinism.** Cache read = 0.1x, 1h write = 2x,
  5m write = 1.25x. A thread left past its TTL rebuilds the prefix at write
  rate - ~20x the warm read cost on the context portion.
- **The TTL silently changed before** (1h -> 5m, ~March 2026, GitHub
  anthropics/claude-code#46829, closed "not planned"). It is invisible and
  fleet-controlled - the client requests it, the server may or may not honor.
  Hence the alarm: it's the one warning Anthropic won't surface.

### What the real data said (all my projects, 289 sessions)
- 94.1% warm hit ratio; **essentially 100% on the 1-hour tier** (77k of 670M
  write tokens touched 5m - the March regression barely grazed me).
- First re-warm estimate (470M tokens) was a ~5x overcount. Gating on the
  time gap, only **537 idle re-warms (95M tokens, ~17% of warm-read spend)**
  are avoidable. The other 80% of churn is tool-driven compaction (<1h gap) -
  not fixable by replying faster.
- Decision: headline metric is the avoidable idle waste + the live countdown,
  not the scary raw number. Honesty over drama.

### Decisions
- **Own folder, graduated from The_Lab** per the launchpad model.
- **Delivery: local Bun server, not a cowork artifact.** A sandboxed cowork
  artifact can't tail local disk; a local server can and is genuinely live.
- **Scope guard:** no `/usage` % correlation, no fast-mode pricing, no
  subagents, no DB in v1. Those need the % signal or earn their way in later.
- **Killer feature:** live warm-countdown for the active thread - the thing
  that nudges the bursty/less-parallel discipline I actually want.

### Built
- `lib/scan.js` - engine (list/parse/analyze), ASCII CLI when run directly.
- `server.js` - Bun server, `/` dashboard + `/api/summary`, 5s summary cache.
- `public/index.html` - dashboard: countdown, cards, cause split, 2 charts.
- `alarm.js` - headless tier-downgrade guard (exit 1 on downgrade).
- `launch.bat` + desktop shortcut - one-click start (server minimized, opens
  browser). Server made idempotent (graceful EADDRINUSE) so repeat clicks just
  reopen the tab. Used `ping`-delay not `timeout` (latter needs a real console).
  Cold-start verified end-to-end. Low friction = it gets used.

### Revision - multi-thread warm board (same day)
The single "active thread" hero under-modeled reality: Brad runs many parallel
threads (projects + day job + family interleaved), each with its own independent
cache and countdown. Replaced the hero with a board of every recently-touched
session. Engine now returns a `threads` array (sessions touched < 6h); the client
computes each warmth live from `lastT` (so threads cool on screen between polls),
filters to warm, sorts soonest-to-expire, and shows a "recently cooled" line for
what was just lost. Verified: 6 recent threads surfaced, warmth per-thread.

### Tier-alarm notifier + /usage research + git (same day)

**Notifier shipped.** `notify.js` pops a Windows balloon ONLY on a tier
downgrade (silent otherwise). Registered as an hourly Scheduled Task
"Cachey tier watch". Demo: `bun run notify.js --demo`. Remove with
`Unregister-ScheduledTask -TaskName "Cachey tier watch"`.

**/usage % research - CONCLUSION: not programmatically available today.**
- (a) Local cache: dead end. `~/.claude/policy-limits.json` = restriction flags
  only; `stats-cache.json` = stale aggregate token counts (last computed
  2026-03-05), no rolling-window %. Nothing local holds the live meter.
- (b) Rate-limit headers (`anthropic-ratelimit-*`): real, but the API-key path,
  not the Max subscription meter.
- (c) `/usage` endpoint: undocumented; open feature requests confirm no stable
  programmatic access (anthropics/claude-code#44328, #32796).
- (d) UI scrape: still the only fallback.
- Implication: v2's "price fast mode / calibrate weights vs the real meter" is
  BLOCKED on Anthropic shipping this. Pragmatic path: trust the deterministic
  cost-equivalent (weights known from API pricing); if % correlation is still
  wanted, add a manual `snapshot <pct>` logger (read /usage occasionally, let
  Cachey correlate over time) rather than chasing live access.

**git:** repo initialized, first commit (was not under version control before).

## 2026-07-03 - Sub-TTL miss breakdown

### Prompted by
Brad asked whether the dashboard actually measures real cache hits or just
assumes a hit from reply timing. Answer: the headline numbers (`read`,
`write`, tier) are real, pulled straight from the API's per-turn `usage`
block (`cache_read_input_tokens` / `cache_creation_input_tokens` /
`ephemeral_*_input_tokens`) - not inferred from elapsed time. The one place
timing *is* an assumption is the live per-thread countdown (a forward
projection, since there's no "is my cache warm right now" endpoint).

Follow-up: the existing `toolReWarms` bucket (re-warms with gap <=60m,
labeled "compaction / big add" in the UI) is exactly "cache missed despite
being inside the TTL window" - but it was an unlabeled aggregate (1990
events, 365M tokens in the live data) with an unverified cause. Checked all
of Brad's transcripts across every project for an actual compaction marker
(`isCompactSummary`, `compactMetadata`, the "session is being continued..."
preamble) - none exist anywhere. So "compaction" was an assumption dressed up
as a label, same species of heuristic as the idle bucket, just less honestly
flagged.

### Built
- `lib/scan.js`: `analyze()` now collects each sub-TTL-miss instance
  (project, timestamp, gap-in-minutes, rewrite tokens) instead of only
  incrementing an aggregate counter. Sorted closest-gap-first, capped at 50
  in the API response with a total count alongside (`subTtlMisses`,
  `subTtlMissesTotal`) so nothing is silently truncated.
- `public/index.html`: new "Closest calls" table below the cause-split chart,
  showing gap/project/tokens/when for the top 20, honestly labeled
  "cause unverified."
- Existing `toolReWarms` aggregate/label left unchanged - this is additive
  detail, not a redefinition of the existing metric.

### Finding (worth flagging, not yet acted on)
Every entry surfaced at the top of the sorted list has a **0.0-minute gap**
- these misses happen on the very next turn, not after some partial idle
wait. That's more consistent with synchronous auto-compaction (which fires
mid-session with no elapsed time) than with an early server-side eviction.
Weak evidence the "compaction" label was probably right for at least this
slice - but it's now inspectable instead of assumed.

### Fixed same day: tier-aware TTL gate
The gap/TTL gate was a flat 60 minutes regardless of a session's actual tier
(5m vs 1h) - would have misclassified a genuine 5m-tier expiry (e.g. a 20m
gap) as a "should-have-hit" tool re-warm. `analyze()` now tracks a
running `tier` per session (refresh-on-use: updates to whichever tier the
most recent write used - `w5m > w1h` -> `"5m"`, else `"1h"`; defaults to
`"1h"` before any write, matching the overwhelming common case) and gates
each turn against that tier's actual TTL (`TTL_5M_MIN` / `TTL_1H_MIN`)
instead of a hardcoded constant. Verified: with 100% of current sessions on
the 1h tier this is a no-op today (1990 -> 1993 tool re-warms, all from
turns accumulated between runs, not from the fix) - it only changes
behavior once a thread actually sits on the 5-minute tier.

### Next (v2 candidates, not committed)
- Resolve the `/usage` % access question (4 avenues: local cache file, rate-
  limit headers, the endpoint `/usage` calls, UI scrape) -> then price fast
  mode and calibrate the cost weights against the real meter.
- Persist daily snapshots -> plot warm ratio / waste over time.
- Desktop notification on tier downgrade (wire `check` to a scheduler).

## 2026-07-23 - Launcher regression: "Windows cannot find 'bun'"

### Symptom + root cause
Desktop shortcut -> `launch.bat` failed with "Windows cannot find 'bun'".
Bun itself was fine (installed, in the *registry* User PATH). The 2026-07-05
public-release commit (`2ab49e0`) de-hardcoded both launchers from
`C:\Users\Brad\.bun\bin\bun.exe` to bare `bun`, making them depend on the
PATH of the *spawning* process - and Explorer can carry a stale environment
that predates the `.bun\bin` entry. Everything worked before that commit
only because the full path was hardcoded.

### Fix
Both launchers now resolve bun explicitly with a portable fallback (keeps
the no-hardcoded-user-paths goal for the public repo):
- `launch.bat`: `set BUN=%USERPROFILE%\.bun\bin\bun.exe`, fall back to bare
  `bun` if that file doesn't exist (non-default installs).
- `run-notify.vbs`: same pattern via `ExpandEnvironmentStrings` +
  `FileExists`.

Verified by stripping `.bun` from PATH (reproduces the failing environment:
`where bun` finds nothing) and running `launch.bat` - server came up,
`/api/summary` returned HTTP 200. Scheduled task "Cachey tier watch" was
unaffected in practice (last run 0x0) but got the same hardening.

## 2026-10-19 - `/usage` meter is readable headlessly (v2 unblocked-ish)

### What changed in the world
The handover's "blocked on Anthropic" premise was stale twice over:
- The two issues it cited were already closed as duplicates when it was
  written (#32796 on 2026-03-10, #44328 on 2026-04-10). Canonical issue is
  **anthropics/claude-code#13585** (still OPEN, 128 thumbs, no Anthropic
  reply as of 2026-10-05); sibling #21943 (local file / API) also open.
- No official endpoint has shipped. But commenters on #13585 documented a
  zero-cost path that works today.

### Verified: headless `/usage`
```
claude -p --no-session-persistence --output-format json "/usage"
```
- Answered client-side: `total_cost_usd: 0`, all token counts 0,
  `duration_api_ms: 0`, ~5 s wall. 4 runs, identical output.
- `.result` is prose: session %, week (all models) %, week (Fable) %, each
  with a reset time. Account-wide - **matched the desktop app's `/usage`
  exactly** (7% / 60% / 0%, Brad confirmed 2026-10-19).
- Also returns an approximate "what's contributing" block (last 24h / 7d:
  % at >150k context, % from subagent-heavy sessions, top subagents/skills).
  Overlaps Cachey's own territory; not yet cross-checked against `scan`.
- `--no-session-persistence` matters: without it the call writes a transcript
  into `~/.claude/projects`, which Cachey would then scan.

### Gotchas (each one bit or would bite)
- **Git Bash mangles it.** MSYS path conversion rewrites `/usage` to
  `C:/Program Files/Git/usage`, which goes to the model as a normal prompt -
  a real ~50K-token call. Run from PowerShell / `wscript`, or set
  `MSYS_NO_PATHCONV=1`. A scheduled poller must never go through Git Bash.
- **Reset-time format is unstable:** same output had `10:59am` and `11am`.
  Parser must accept `H:MM` *and* bare `H` (a commenter's `H:MM`-only parser
  silently nulled ~1/3 of readings).
- **CLI auth is separate from the desktop app** and can expire. Expired
  state returns `is_error: true` with result
  `Failed to authenticate: OAuth session expired and could not be refreshed`
  - a poller must check `is_error`, not just parse.
- Prose is not a contract; any CLI update can change wording.

### Checked and ruled out
- `cachedUsageUtilization` in `~/.claude.json` (reported by a commenter):
  absent on this machine (CLI 2.1.280).
- Mod API `$.session.usage()` (structured `rateLimits`, reportedly since
  2.1.287): not testable here, local CLI too old. Cleaner than parsing prose
  if/when available.
- `claude.ai/api/organizations/{id}/usage`: behind Cloudflare bot
  protection; scraping it is not worth it.

### Implication (not yet decided)
The "manual `snapshot <pct>` logger" can be automated: poll headless
`/usage` (e.g. from the existing hourly scheduled task), append readings,
correlate against Cachey's computed cost-equivalent to calibrate the cost
weights. Still v2 / outside spec.md's locked scope - needs an explicit
decision. Design tension: Cachey itself stays zero-network, but the `claude`
child process it would spawn talks to Anthropic.

## 2026-10-19 - Decision: lift the scope lock for a meter logger only (v1.1)

### Decision
Option B of three: **record and display** the `/usage` meter. Don't calibrate yet.
- A) Keep the lock - rejected: the meter history only exists if something
  records it now; deciding v2 later with zero data is worse than with 2 weeks.
- **B) Logger + dashboard card - chosen.** ~1 session. spec.md gains a v1.1
  section; the "does NOT" guards are narrowed, not removed.
- C) Full calibration (Delta-% vs weighted tokens) - deferred to v2, gated on
  one clean week of B's data.

### Why calibration can't come first (measured, last 7 days, weighted units)
- Subagent transcripts are **50.8%** of weighted usage; top-level sessions
  (all v1 scans) are 49.2%. Fitting the meter against v1's numbers would fit
  against half the input. C needs the subagent guard lifted too.
- Model mix is 99.8% Opus 5.5, so one scale factor ("units per %") would do -
  no per-model terms needed. Good news for C.
- Resolution: ~380M units against 60% weekly -> 1% ~ 6M units, ~0.4%/h.
  Hourly deltas are mostly 0 or 1 integer steps: enough for one scalar over
  1-2 weeks, not enough to separate the read / write / output weights.
- Meter is account-wide (claude.ai chat, other devices); transcripts are
  this machine only. Becomes noise in any fit.

### Design calls for B
- Spawn `claude` via `Bun.spawn` with an argv array (no shell), so nothing
  can MSYS-rewrite `/usage` into a billed prompt. Resolve `claude.exe`
  explicitly (`%USERPROFILE%\.local\bin`), same stale-PATH lesson as the
  2026-07-23 bun launcher regression.
- Billed-call tripwire: `total_cost_usd > 0`, any output tokens, or
  `duration_api_ms > 0` -> append an error row, write `data/meter.disabled`,
  exit 2. Polling stays off until a human deletes the flag.
- Every reading stores the raw `.result` prose alongside parsed fields.
  Parse failures become logged error rows, never silent nulls.
- `--bare` was considered (skips hooks/MCP per poll) and rejected: it
  disables OAuth, so `/usage` can't authenticate. `--strict-mcp-config`
  instead (no MCP servers spawned per poll).
- Log lives in the repo's own `data/` (gitignored), not `~/.claude`.

### Built (same day)
- `lib/meter.js` (parser, envelope check, spawn, append, tail reader),
  `lib/meter.test.js` (11 tests: live fixture, `H:MM` and bare `H`,
  12am/12pm, time-only, Dec->Jan year wrap, DST, auth-expired, billed,
  unknown shape), `bun run meter`, `bun test`.
- `run-notify.vbs` runs `lib/meter.js` alongside `notify.js` each hour - the
  Scheduled Task itself is unchanged.
- `/api/meter` (log tail only, never spawns `claude`) + dashboard card:
  per-limit % with bar, time to reset, last-reading age, red status line for
  failed / disabled / >2h stale with the fix named (e.g. `claude /login`).

### Verified
- Live readings from PowerShell, Git Bash and `wscript run-notify.vbs`
  (the scheduler's path): all `ok`, 0 cost, ~2.8-3.1 s. `--strict-mcp-config`
  roughly halved wall time (5.6 s -> 2.8 s). Git Bash is safe because the
  argv array never passes through a shell.
- Disabled flag: present -> exit 1, `disabled` row logged, no `claude` call.
- Side effects per poll: no new transcript. `~/.claude.json` gets two keys
  rewritten (`cachedGrowthBookFeaturesAt`, `pluginUsage`) - CLI startup
  bookkeeping, not data Cachey reads. Cachey still never writes `~/.claude`
  itself; the child process does this much.
- Reset instants jitter by 1 minute between calls (17:19Z -> 17:20Z, 14:59Z
  -> 15:00Z within 30 min). Harmless for display; v2 must not treat a
  1-minute shift as a new window.
- **Not verified:** the billed tripwire end-to-end (unit-tested only - forcing
  a real billed call to prove it would cost quota). The one-week clean-log
  gate starts now.

### Found (not fixed - out of scope)
`analyze()` now reads 713 transcripts / 6.3 GB in ~22 s, synchronously, so it
blocks Bun's event loop: `/api/meter` took 34 s behind it. With a 5 s server
cache and a 15 s page poll, every refresh re-runs the full 22 s scan, so the
server is effectively always scanning. v1 was sized at 289 sessions.
Observed effect: the page itself (`/`) hit Bun.serve's 10 s `idleTimeout` and
failed to load while scans were queued - the daily-driver dashboard is
barely usable at current data volume, independent of v1.1.
Needs an incremental scan (per-file mtime cache) - its own piece of work.

## 2026-10-19 - Incremental scan: dashboard responsive again

Fixes the "Found" above. Metrics, subagent exclusion and scope guards are
unchanged; this is purely how the same numbers get computed.

### Decision
- **Per-file parse cache, in memory** (`lib/scan.js` `fileCache`), keyed by
  path + `mtimeMs` + `size`. Unchanged file -> cached records, no read.
- **Append-only tail parse.** A grown file is read from the last consumed
  byte, not from 0 - the live session files are the large ones and change on
  every poll. Guard: the 256 bytes before the old offset must still match;
  shrink or a changed prefix -> full re-parse. An unterminated last line is
  taken only if it is complete JSON, else left for the next read (same answer
  a full read gives at that moment). Stable re-sort of old ++ new equals a
  stable sort of the whole file, so record order is identical too.
- **Key prefilter:** lines without `"output_tokens"` skip `JSON.parse`
  (tool results and user lines are most of the bytes). Exact, since
  serialized JSON writes keys literally.
- **No event-loop starvation.** `analyze()` is now a generator core with two
  drivers: sync `analyze()` (CLI, `alarm.js`, `notify.js`) and
  `analyzeAsync()`, which hands the loop back every 20 ms (reads in 8 MB
  chunks, so even one huge file yields). `server.js` serves
  stale-while-revalidate: a stale summary starts one refresh and waits at most
  1 s for it, else returns the previous result. Scan starts at server boot;
  `idleTimeout` raised to 120 s so the cold first `/api/summary` isn't dropped.
- Zero deps kept. Rejected: worker thread (more moving parts than yielding
  needs) and an on-disk cache (persistence is a separate decision; the
  server is long-lived, so in-memory is enough there).

### Measured (713 files / 6.3 GB)
- Identity: one process, one fixed `now`: old full scan, new cold, new warm,
  `analyzeAsync`, old again -> all five `JSON.stringify` outputs equal.
- Before: every call ~20-27 s. After: cold 15-17 s (I/O bound), **warm
  0.12-0.15 s** (incl. re-reading the live sessions' appended bytes).
- Server (`cachey-server`): during the cold scan `/` and `/api/meter`
  answered in 2-14 ms; cold `/api/summary` 200 after 19.6 s; warm
  `/api/summary` 0.12-0.15 s. Before: `/` timed out, `/api/meter` 15-34 s.
- `lib/scan.test.js` (9 tests): cached load == full parse for appends,
  out-of-order/tied timestamps, half-written line, no trailing newline,
  CRLF, rewritten prefix, shrink, lines > 8 MB chunk, vanished file. A
  separate probe (prefix corrupted outside the signature window) confirmed
  the append path really reads only new bytes.

### Not changed
- `bun run scan` / `bun run check` are one-shot processes, so they still pay
  the cold ~15 s each run. Fine for an hourly task; an on-disk cache would
  fix it if it ever matters.
- Cache key is mtime + size: a same-size, same-mtime rewrite would be missed.
  Transcripts are append-only, so not a real case.

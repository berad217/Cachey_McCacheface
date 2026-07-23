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

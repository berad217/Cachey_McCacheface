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

### Next (v2 candidates, not committed)
- Resolve the `/usage` % access question (4 avenues: local cache file, rate-
  limit headers, the endpoint `/usage` calls, UI scrape) -> then price fast
  mode and calibrate the cost weights against the real meter.
- Persist daily snapshots -> plot warm ratio / waste over time.
- Desktop notification on tier downgrade (wire `check` to a scheduler).

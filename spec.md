# Cachey_McCacheface - spec

## What it is
A local, read-only tool that reports Claude Code cache warmth from session
transcripts (`~/.claude/projects/**/*.jsonl`), so I can see when my context is
warm vs. cold and stop quietly paying to rebuild it.

## Why
Anthropic removed the time-of-day usage penalty (May 6, 2026), so wall-clock
time is no longer a cost lever. The real lever is **cache discipline**: the
1-hour cache TTL means a thread left untouched >1h gets re-written at write
rate (2x) instead of read cheap (0.1x) - a ~20x jump on the context portion.
The tier itself is invisible and has silently changed before (1h -> 5m, March
2026), and it is the single biggest multiplier on how I work (many parallel
threads, sparse pickups). This tool makes that visible.

## v1 scope (locked)
- **Live active-thread warmth countdown** - the daily driver. Shows the active
  session, its tier, and minutes until the cache goes cold.
- **Tier-downgrade alarm** - flags if recent writes drop from 1h to 5m tier.
- **Cross-project history** - warm hit ratio, idle re-warm waste, churn by
  project. Idle (you stepped away, gated on >1h gap) is separated from
  tool-driven (compaction) churn; only idle is actionable.
- Delivery: local Bun server serving an auto-refreshing dashboard, plus a
  headless `check` for the alarm.

## v1.1 increment: meter logger (2026-10-19)
Scope lifted deliberately (see DEVLOG 2026-10-19). Adds *recording and
display* of the `/usage` meter, nothing more:
- `bun run meter` reads the meter via headless
  `claude -p --no-session-persistence --output-format json "/usage"` (0 tokens),
  parses it, and appends one reading to `data/meter.jsonl` (gitignored).
  Exits non-zero on CLI error, parse failure, or any sign the call was billed.
  A billed call also disables polling until a human clears the flag.
- The hourly tier-watch task also takes a meter reading.
- Dashboard card: week %, session %, time to reset, age of the last reading,
  and a stale state when the last poll failed or is old.

Done when: parser tests pass (`H:MM` and bare `H` resets, auth-expired, unknown
output); a live reading lands in the log; the card renders it; then one week
of hourly rows with no unexplained gaps - that week is the gate for v2.

## v1.2 increment: API-equivalent cost counter (2026-10-20)
Scope lifted deliberately (see DEVLOG 2026-10-20). Answers "what would this
usage cost on the API?" - dollars at list prices, not plan quota:
- `lib/prices.js`: per-model list prices ($/MTok: input, output, 5m write,
  1h write, read). A model not in the table is reported as unpriced, never
  guessed.
- `lib/cost.js` / `bun run cost` / `/api/cost`: every API call in this
  machine's transcripts, **subagents included**, counted once machine-wide,
  bucketed by local day. Today / this week (from Monday) / this month / since
  the first day on record.
- Two numbers per window: **logged** (exact for calls in transcripts) and an
  **estimate** = logged x a factor measured against Claude Code's own cost
  tracker (`cost-state` lines), which also sees calls that never reach a
  transcript. No factor (and no estimate) under 5 comparable sessions.
- `data/cost-daily.jsonl` (gitignored): append-only, one row per finished day,
  never rewritten. Per day the counter shows max(live, logged), so totals
  survive Claude Code's transcript cleanup.
- Folded in: compaction markers (`compact_boundary`) classify re-warms; waste
  is priced per model in dollars instead of flat weights.

Done when: price/dedupe/window/calibration/log tests pass; the CLI and the
dashboard card agree; the calibration factor reproduces the independent
2026-10-20 cross-check (~1.09).

## v1 explicitly does NOT (scope guard)
- Correlate the `/usage` % meter against computed token cost / calibrate the
  cost weights (v2). v1.1 only records and displays the meter. Calibration
  would also need subagent transcripts, which are ~51% of weighted usage
  (measured 2026-10-19). v1.2's dollar calibration is against Claude Code's
  tracker, not the meter - it says nothing about quota.
- Price fast mode against quota. (v1.2 prices it in API dollars at 2x.)
- Include subagent / workflow transcripts in the *warmth* metrics (they don't
  reflect my own pacing). The v1.2 cost counter does include them - cost is
  cost, whoever spent it.
- Persist history to a DB / plot over many days (v2 if v1 earns it). Two
  append-only exceptions: the meter log (raw readings) and the daily cost log
  (one total per day).

## Done criteria
- `bun run start` opens a dashboard showing the active thread's warm countdown,
  warm hit ratio, idle-waste %, and churn hotspots from real transcripts.
- `bun run check` exits non-zero with an ALARM line if the cache tier downgrades.
- Numbers match the ad-hoc analysis that motivated the build
  (~94% warm, 1h tier, 537 idle pickups, ~17% avoidable waste).

## Known model assumptions (revisit if wrong)
- Re-warm detection is a heuristic: the prefix read collapses versus the
  previous call + a large rebuild write. A compaction marker right before it
  -> compaction; else the gap splits it (> TTL = idle, <= TTL = other miss).
- One API response = one usage record (transcripts write a line per content
  block; dedupe by message id, field-wise max).
- Waste and cost use per-model list prices (`lib/prices.js`); fast mode is 2x
  on every component (cache columns assumed).
- TTL countdown assumes refresh-on-use from the last recorded turn.

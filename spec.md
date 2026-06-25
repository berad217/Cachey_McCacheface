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

## v1 explicitly does NOT (scope guard)
- Correlate to the `/usage` % meter (needs an unconfirmed API; that is v2).
- Price fast mode in dollars/quota (needs the % signal; v1 only flags it).
- Include subagent / workflow transcripts (they don't reflect my own pacing).
- Persist history to a DB / plot over many days (v2 if v1 earns it).

## Done criteria
- `bun run start` opens a dashboard showing the active thread's warm countdown,
  warm hit ratio, idle-waste %, and churn hotspots from real transcripts.
- `bun run check` exits non-zero with an ALARM line if the cache tier downgrades.
- Numbers match the ad-hoc analysis that motivated the build
  (~94% warm, 1h tier, 537 idle pickups, ~17% avoidable waste).

## Known model assumptions (revisit if wrong)
- Re-warm detection is a heuristic: warm prefix collapse + large rebuild write,
  gated on the preceding time gap (>60m = idle, <60m = tool). Upper-bound-ish.
- Cost weights: read 0.1x, 1h write 2.0x (relative to a fresh input token).
- TTL countdown assumes refresh-on-use from the last recorded turn.

# Handover - Cachey_McCacheface

_2026-10-20. Ephemeral delta only; durable context is in onboarding.md -> spec.md (v1.1 + v1.2 sections) -> DEVLOG.md (2026-10-19 entries, then 2026-10-20 v1.2)._

## Orientation
v1.2 (API-equivalent cost counter + v1 parse-bug fixes) is built and tested (37 pass) but **not yet committed** at the time of writing. The meter week (v1.1) is still running in the background.

## The Delta
- **The one-week meter gate runs until ~2026-10-26.** When it ends, check `data/meter.jsonl` for gaps and for non-`ok` rows. `auth` rows mean the standalone CLI login expired again; it's separate from the desktop app.
- **v2 calibration (option C) got cheaper.** Its blocker was "needs subagent transcripts"; `lib/cost.js` now parses them and prices every call per model. A meter fit could regress meter-% deltas on cost.js's daily/hourly dollars instead of flat weights. Still undecided on purpose: decide with the week's data.
- **Headline numbers moved because of bug fixes, not behaviour.** Avoidable waste 3% -> 12%, "tool" re-warms 2,918 -> 154 compaction + 137 other. Don't compare against pre-2026-10-20 screenshots or notes.
- `claude-haiku-5-5` is deliberately unpriced (tiered by prompt size; cache rates not sourced). If Claude Code starts using it for side calls in volume, the 1%-of-month rule turns the cost status line red. Then price it, with tiers.
- Branch `claude/dreamy-chaplygin-b43a3f` is left over (== `master`). Safe to delete.

## Next steps
1. Commit v1.2 (and push when Brad says so).
2. ~2026-10-26: review the meter log, then decide on v2 (option C) or keep option B.
3. Parking lot: "compact before you leave" hint on warm threads over ~200K context (needs per-thread context size in `threads`).
4. Elective: switch to the mod API `$.session.usage()` (structured; CLI >= 2.1.287). Watch anthropics/claude-code#13585 for an official endpoint.

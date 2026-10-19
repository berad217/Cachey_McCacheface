# Handover - Cachey_McCacheface

_2026-10-19. Ephemeral delta only; durable context is in onboarding.md -> spec.md (v1.1 section) -> DEVLOG.md (three 2026-10-19 entries)._

## Orientation
v1.1 shipped and pushed (`4f765cf`): the hourly task now logs the `/usage` meter to `data/meter.jsonl`, and the scan is incremental (warm ~0.13 s). Nothing in flight; this is a **waiting** stop.

## The Delta
- **The one-week meter gate runs until ~2026-10-26.** When it ends, check `data/meter.jsonl` for gaps and for non-`ok` rows. `auth` rows mean the standalone CLI login expired again; it's separate from the desktop app and had already lapsed once before today.
- **v2 calibration is undecided, on purpose.** Brad chose option B (log + display) over C (calibrate). C also needs the subagent-exclusion guard lifted, since subagents are ~51% of weighted usage. Decide with the week's data, not before.
- Branch `claude/dreamy-chaplygin-b43a3f` is left over (== `master`). Safe to delete.

## Next steps
1. ~2026-10-26: review the meter log, then decide on v2 (option C) or keep option B.
2. Elective: switch to the mod API `$.session.usage()` (structured; CLI >= 2.1.287, local is 2.1.280). Watch anthropics/claude-code#13585 for an official endpoint.
3. Parking lot: flag fast-mode turns on the dashboard (the JSONL has a `speed` field) without pricing them.

# Handover - Cachey_McCacheface

_Last updated: 2026-06-25. This is the ephemeral "where we are now" doc. The durable stuff lives in spec.md / DEVLOG.md / onboarding.md — don't duplicate it here._

## Quick Start
New session, cwd is Cachey_McCacheface:
1. Read `onboarding.md` (the tour), skim `spec.md` (locked scope + assumptions), read the latest `DEVLOG.md` entry.
2. Run `bun run scan` to see live state in the console; `bun run start` for the dashboard (http://localhost:4317).
3. Come back here for current context.

## Project Context
- **What:** local, read-only cache-warmth dashboard for Claude Code (reads `~/.claude/projects/**/*.jsonl`).
- **Phase:** v1 complete, "live with it." No active build in progress.
- **git:** `master`, genesis commit `312e18a` (2026-06-25). Local only — no remote, not pushed.
- **Stack:** Bun, vanilla JS, zero deps, zero network.

## State of the world (live bits worth knowing)
- A dev server may already be running on :4317 from a prior session. The launcher is idempotent (a second start bows out cleanly). `Get-Process bun` to check; `bun run start` or the desktop shortcut to (re)launch.
- An hourly Scheduled Task **"Cachey tier watch"** pops a Windows balloon only if the cache tier silently drops 1h→5m; silent otherwise. Remove with `Unregister-ScheduledTask -TaskName "Cachey tier watch"` (also delete `run-notify.vbs`).
  - **Launches via `run-notify.vbs` (wscript), not `bun.exe` directly (changed 2026-06-29).** `bun.exe` is a console app, so the scheduler used to pop a focusable console window every run and steal keyboard focus mid-typing. The `.vbs` runs bun with a hidden window (`Run cmd, 0, False`); the task is also flagged `Hidden`. `notify.js` is unchanged. If you ever rewire the action back to `bun.exe`, the focus-theft bug returns.

## How we got here (the why, condensed)
- Started as "is daytime usage ~3x cheaper than evening?" Research killed that premise: Anthropic **removed the time-of-day usage penalty on 2026-05-06**. The clock is not a cost lever. The real lever is **cache discipline**.
- Brad's measured profile (289 sessions): 94% warm hit ratio, ~100% on the 1-hour cache tier, anti-pattern is **sparse pickups across many parallel threads** (day job / family / scrolling interleaved). Only ~17% of warm-read spend is avoidable idle waste; the other ~80% of churn is tool-driven compaction, not reply timing.
- Delivery decision: local Bun server, **not** a cowork artifact (sandboxed browser HTML can't tail local disk).
- Multi-thread board was a deliberate fix: each session has its own cache + countdown, so the dashboard shows all currently-warm threads, not one "active" thread.

## Decisions in flight / blocked
- **`/usage` % is NOT programmatically accessible (resolved 2026-06-25).** Local cache files don't hold it; `anthropic-ratelimit-*` headers + Rate Limits API are API-key/org features, not the Max subscription meter. Open feature requests: anthropics/claude-code#44328, #32796.
- Consequence: **v2's headline (price fast mode / calibrate cost weights against the real meter) is blocked on Anthropic**, not on us.

## Known limitations (don't mistake these for bugs)
- Re-warm detection is a **heuristic** (warm-prefix-collapse + large rebuild, gated on the preceding time gap: >60m = idle/avoidable, <60m = tool/compaction). Upper-bound-ish.
- Cost weights (read 0.1x, 1h write 2.0x, output ~5x) are **assumptions from API pricing** — uncalibrated, because the % meter is unavailable.
- No test suite. Verification is empirical (`bun run scan` / hit `/api/summary`).
- v1 scope is **locked** (see spec.md "does NOT"): no /usage correlation, no fast-mode pricing, no subagent transcripts, no DB. Don't drift without a decision.

## Next steps
- **Immediate:** none. The project is at its natural "done" line — use it.
- **Elective (Brad's call):**
  - Manual `snapshot <pct>` logger — type the /usage % occasionally, let Cachey correlate it against the computed cost-equivalent over time (the hand-built workaround for the blocked API).
  - Resume v2 if Anthropic ships the usage endpoint (watch #44328 / #32796).
  - Persist daily snapshots → plot warm ratio / idle waste over many days.
  - Push to a remote if you want off-machine backup.

## Parking lot
- Idea: surface fast-mode turns on the dashboard (the `speed` field is in the JSONL) even without pricing them — at least flag "you were in fast mode but away."

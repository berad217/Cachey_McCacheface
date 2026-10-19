# Handover - Cachey_McCacheface

_Last updated: 2026-10-19 (usage meter, v1.1 logger, perf finding; rest as of 2026-07-03 — later commits `2ab49e0` public-release prep and `dd9ae9a` launcher fix are in `DEVLOG.md`). This is the ephemeral "where we are now" doc. The durable stuff lives in spec.md / DEVLOG.md / onboarding.md — don't duplicate it here._

## Quick Start
New session, cwd is Cachey_McCacheface:
1. Read `onboarding.md` (the tour), skim `spec.md` (locked scope + assumptions), read the latest `DEVLOG.md` entry.
2. Run `bun run scan` to see live state in the console; `bun run start` for the dashboard (http://localhost:4317).
3. Come back here for current context.

## Project Context
- **What:** local, read-only cache-warmth dashboard for Claude Code (reads `~/.claude/projects/**/*.jsonl`).
- **Phase:** v1 complete, "live with it," plus a small 2026-07-03 refinement (see below). No active build in progress.
- **git:** `master`, genesis commit `312e18a` (2026-06-25). Pushed to `origin` (`github.com/berad217/Cachey_McCacheface`, public).
- **Stack:** Bun, vanilla JS, zero deps, zero network.

## Since v1 shipped (2026-07-03)
Brad asked whether the dashboard measures real cache hits or assumes them from reply
timing — prompted a look under the hood, two small changes landed (full detail in
today's `DEVLOG.md` entry):
- **"Closest calls" table** (dashboard, below the cause-split chart): the `toolReWarms`
  bucket (re-warms with a gap inside the TTL, previously just an aggregate labeled
  "compaction / big add") is now also kept as a per-instance list — project, gap-in-minutes,
  tokens, when — sorted closest-gap-first, so the ones actually worth a second look aren't
  buried in a 1990-count aggregate. Every entry currently at the top has a **0.0-minute
  gap** (happens on the very next turn), which is better evidence for synchronous
  auto-compaction than for a real early eviction — but it's now inspectable, not assumed.
- **Tier-aware TTL gate** (`lib/scan.js`): the idle/tool-miss split used to gate on a flat
  60 minutes regardless of a session's actual tier. Now tracks a running per-session tier
  (refresh-on-use) and gates against that tier's real TTL (60m or 5m). No behavior change
  today — 100% of sessions are on the 1h tier — matters only if a thread ever drops to 5m.
- Confirmed no compaction-boundary marker (`isCompactSummary`, `compactMetadata`, the
  "session is being continued..." preamble) exists anywhere in Brad's transcripts, across
  every project — so "compaction" was always an inferred label, never a verified one. Worth
  remembering next time that word shows up in the UI.

## State of the world (live bits worth knowing)
- A dev server may already be running on :4317 from a prior session. The launcher is idempotent (a second start bows out cleanly). `Get-Process bun` to check; `bun run start` or the desktop shortcut to (re)launch.
- An hourly Scheduled Task **"Cachey tier watch"** pops a Windows balloon only if the cache tier silently drops 1h→5m; silent otherwise. Remove with `Unregister-ScheduledTask -TaskName "Cachey tier watch"` (also delete `run-notify.vbs`).
  - **Since 2026-10-19 (v1.1) the same hourly run also logs a `/usage` meter reading** to `data/meter.jsonl`. If `data/meter.disabled` exists, a billed call was detected and polling is off until you delete it. `auth` rows mean the standalone CLI login expired: `claude /login`.
  - **Launches via `run-notify.vbs` (wscript), not `bun.exe` directly (changed 2026-06-29).** `bun.exe` is a console app, so the scheduler used to pop a focusable console window every run and steal keyboard focus mid-typing. The `.vbs` runs bun with a hidden window (`Run cmd, 0, False`); the task is also flagged `Hidden`. `notify.js` is unchanged. If you ever rewire the action back to `bun.exe`, the focus-theft bug returns.

## How we got here (the why, condensed)
- Started as "is daytime usage ~3x cheaper than evening?" Research killed that premise: Anthropic **removed the time-of-day usage penalty on 2026-05-06**. The clock is not a cost lever. The real lever is **cache discipline**.
- Brad's measured profile (289 sessions): 94% warm hit ratio, ~100% on the 1-hour cache tier, anti-pattern is **sparse pickups across many parallel threads** (day job / family / scrolling interleaved). Only ~17% of warm-read spend is avoidable idle waste; the other ~80% of churn is tool-driven compaction, not reply timing.
- Delivery decision: local Bun server, **not** a cowork artifact (sandboxed browser HTML can't tail local disk).
- Multi-thread board was a deliberate fix: each session has its own cache + countdown, so the dashboard shows all currently-warm threads, not one "active" thread.

## Decisions in flight / blocked
- **`/usage` % IS readable headlessly (verified 2026-10-19, supersedes the 2026-06-25 "not accessible" call).** `claude -p --no-session-persistence --output-format json "/usage"` costs 0 tokens and matched the desktop `/usage` exactly. Output is prose, not a contract. Gotchas (Git Bash mangling = real billed call, unstable reset-time format, separate CLI auth that expires) are in the 2026-10-19 `DEVLOG.md` entry.
- No *official* endpoint yet. #44328 / #32796 were closed as duplicates back in Mar/Apr; the live issue is anthropics/claude-code#13585 (sibling #21943).
- Consequence: **v2's headline (calibrate cost weights against the real meter) is no longer blocked on Anthropic** — it's blocked on Brad deciding to lift the v1 scope lock.

## Known limitations (don't mistake these for bugs)
- Re-warm detection is a **heuristic** (warm-prefix-collapse + large rebuild, gated on the preceding time gap vs. the session's actual tier TTL: beyond it = idle/avoidable, inside it = "tool" bucket, cause unverified). Upper-bound-ish. The sub-TTL "tool" bucket's cause (compaction vs. something else) is inferred, not confirmed — see "Since v1 shipped" above.
- Cost weights (read 0.1x, 1h write 2.0x, output ~5x) are **assumptions from API pricing** — still uncalibrated. The % meter is now readable (see above), but nothing records it yet.
- No test suite. Verification is empirical (`bun run scan` / hit `/api/summary`).
- v1 scope is **locked** (see spec.md "does NOT"): no /usage correlation, no fast-mode pricing, no subagent transcripts, no DB. Don't drift without a decision.

## Next steps
- **Immediate:** let the meter log run. Gate: one week (to ~2026-10-26) of hourly `data/meter.jsonl` rows with no unexplained gaps. Then decide on v2 calibration (DEVLOG 2026-10-19 has why it also needs subagent transcripts).
- **Known perf bug (unfixed):** `analyze()` takes ~22 s on 6.3 GB of transcripts and blocks the server; the dashboard's 15 s poll vs 5 s cache keeps it permanently scanning. Fix = incremental per-file mtime cache. See DEVLOG 2026-10-19 "Found".
- **Elective (Brad's call):**
  - Swap to the mod API `$.session.usage()` (structured, reportedly CLI >= 2.1.287) if it pans out — cleaner than parsing prose. Official endpoint: watch #13585.
  - Persist daily snapshots → plot warm ratio / idle waste over many days.

## Parking lot
- Idea: surface fast-mode turns on the dashboard (the `speed` field is in the JSONL) even without pricing them — at least flag "you were in fast mode but away."

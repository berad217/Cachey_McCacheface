# Onboarding - Cachey_McCacheface

Welcome! You're here to help with Cachey_McCacheface — a local, read-only dashboard that reads Claude Code session transcripts and shows cache warmth: which threads are still warm, when each goes cold, and how much quota gets wasted re-warming idle ones.

**Project type:** Personal tool / utility (solo)
**Human's level:** Experienced — Brad (medicine → electrical engineering → software). Assume fluency; explain only jargon outside bio/EE/code.
**Current phase:** v1 built (2026-06-25), in "live with it" — using it before committing to v2.
**Stack:** Bun + vanilla JS. No framework, no dependencies, no network calls.

---

## Getting Oriented

All docs live at the project root:

- **spec.md** — what it is, the *locked* v1 scope, the explicit scope guards (what v1 does NOT do), and the model assumptions (re-warm heuristic, cost weights). Read this first.
- **DEVLOG.md** — why it exists and every decision so far (genesis + the research that reshaped it + revisions). Read the latest entry to catch up on a moving train.
- **README.md** — quickstart and what the dashboard shows.
- **Context / handover** — `docs/.agents/current-handover.md`. The ephemeral "where we are now" delta; read it after the latest DEVLOG entry.

---

## About This Human

See Brad's global preferences (his Claude Code `CLAUDE.md`) for the full picture. Short version: direct feedback over sugar-coating, intellectual honesty over social comfort, systems / first-principles thinking, decisive defaults (propose-and-flag, don't run clarifying-question rounds). Teflon mode is on by default — after a task, propose the next concrete move with a one-line reason.

---

## Source Map

- **lib/scan.js** — the engine. Lists/parses `~/.claude/projects/**/*.jsonl` (one record per API response: transcripts write a line per content block, deduped by message id); computes warm hit ratio, cache tier (1h vs 5m), re-warms split idle / compaction / other, per-thread warmth, and churn by project. Owns the incremental per-file parse cache that `cost.js` shares. Pure, no deps. Also a CLI (`bun run scan`).
- **lib/prices.js** — per-model API list prices and the record pricer. Unknown models are reported unpriced, never guessed. Update when a model ships.
- **lib/cost.js** — v1.2 API-equivalent cost counter (subagents included): day/week/month/all windows, calibration factor vs Claude Code's own `cost-state` tracker, append-only `data/cost-daily.jsonl` (gitignored). CLI `bun run cost`; served at `/api/cost`.
- **server.js** — Bun server on :4317. Serves the dashboard at `/` and JSON at `/api/summary` (stale-while-revalidate over an incremental scan) and `/api/cost` (60 s cache, never blocks). Idempotent — a second launch on a taken port bows out cleanly.
- **public/index.html** — the dashboard. Live board of warm threads (each with its own ticking countdown), summary cards, re-warm cause split, two charts.
- **alarm.js** — headless tier-downgrade guard (`bun run check`, exits 1 if the cache silently drops 1h → 5m).
- **lib/meter.js** — v1.1 `/usage` meter logger. Spawns headless `claude -p --no-session-persistence --strict-mcp-config --output-format json "/usage"` (0 tokens), parses the prose, appends to `data/meter.jsonl` (gitignored). Billed-call tripwire writes `data/meter.disabled`. Run hourly by `run-notify.vbs`; read by `/api/meter`.
- **launch.bat** + desktop shortcut — one-click start (server minimized, opens browser).

## Common Commands
```
bun run start    # dashboard at http://localhost:4317
bun run check    # tier-downgrade alarm (exit 1 if it fires)
bun run scan     # one-shot ASCII summary to the console
bun run meter    # one /usage meter reading -> data/meter.jsonl (exit 2 = billed, polling disabled)
bun run cost     # API-equivalent cost summary; appends finished days to data/cost-daily.jsonl
bun test         # meter parser, scan (incremental parse, dedupe, markers) and cost tests
```

---

## How We Work

Light sprint workflow:
1. Implement against the locked `spec.md` scope.
2. Verify by actually running it (`bun run scan` / `bun run cost` / hit the API). `bun test` covers the meter parser, the incremental parse invariants, and the cost math; dashboard numbers are verified empirically.
3. Update `DEVLOG.md` with decisions + rationale while they're fresh.

**The Confidence Bar:** HIGH → just do it. MODERATE → do it, note it in DEVLOG. LOW (multiple valid paths, real tradeoffs) → stop and offer 2-3 options.

**Scope discipline matters here.** v1 is deliberately bounded (see spec.md's "does NOT" list). Don't drift into v2 territory (`/usage` % correlation, fast-mode pricing, subagents, persistence) without an explicit decision.

---

## Writing Handovers

When Brad asks, when you're stuck, or at a milestone. Put it at `docs/.agents/current-handover.md` or `HANDOVER.md`. Capture the *ephemeral* conversation context — active debates, what was tried, decisions in flight — not what's already in spec/DEVLOG/code.

---

## Project-Specific Notes

- **Read-only by design.** It only *reads* transcripts; it never writes to `~/.claude`.
- **Git-tracked, pushed.** Repo on branch `master`, remote `origin` -> `github.com/berad217/Cachey_McCacheface` (public).
- **Windows + Bun.** Console output stays ASCII (Brad's rule). The dashboard is browser HTML — no such limit there.
- **The re-warm metric is a heuristic**, not ground truth: warm-prefix-collapse + large rebuild, gated on the preceding time gap (>1h = idle/avoidable, <1h = tool/compaction). Upper-bound-ish. See spec.md assumptions.
- **Why it exists (the punchline):** Anthropic removed the time-of-day usage penalty (2026-05-06), so the clock is no longer a cost lever — cache discipline is. This tool makes the invisible cache state visible. Full background in DEVLOG.md and the `reference-claude-usage-mechanics` memory.

# Cachey_McCacheface

*The dashboard the public would have voted for, if the public knew its Claude Code
cache was quietly setting money on fire.*

Your conversation context lives in a cache. While it's **warm**, every turn re-reads
the whole prefix at **0.1x**. Let it go **cold** and the next turn rebuilds that prefix
once at **~2x** — roughly a 20x swing on the context portion, paid silently, with a
countdown nobody shows you. Cachey watches the cache so you can keep typing.

It reads your session transcripts (`~/.claude/projects/**/*.jsonl`), shows which threads
are still warm and how long they've got left, and only makes noise if your cache tier
quietly downgrades from the 1-hour tier to 5-minute (which has happened before — silently,
fleet-side, with no announcement).

**No network. No dependencies. Read-only. Just Bun and a chip on its shoulder.**

## Quick start
```sh
bun run start      # dashboard at http://localhost:4317
bun run check      # headless tier-downgrade alarm (exit 1 if it fires)
bun run scan       # one-shot ASCII summary to the console
```

That's the whole install. There is no step 2. It never phones home, never writes to
`~/.claude`, and has opinions about your pacing it keeps mostly to itself.

## What you're looking at
- **Warm countdown** — each warm thread and how long until its 1-hour cache expires.
  Reply within the window and the whole prefix is re-read at 0.1x. Miss it and the next
  turn rebuilds the prefix once at ~2x. The board shows *all* currently-warm threads, not
  just the one you're staring at — because the expensive ones are the ones you forgot about.
- **Tier** — 1-hour vs 5-minute. You want 1-hour. The banner fires if recent writes start
  landing on the 5-minute tier. This is the one warning Anthropic won't give you, so Cachey
  does (quietly, via a tray balloon — it will not steal your keyboard focus; that bug has
  been shot and buried).
- **Avoidable waste** — quota spent re-warming threads you wandered away from for >1h, as a
  share of your warm-read spend. The lever you actually control. Spoiler: it's smaller than
  the scary raw number, and Cachey refuses to lie to you about it.
- **Churn by project** — where the re-writes pile up. Idle waste (your pacing) is kept
  separate from tool-driven compaction (genuinely not your fault).
- **Closest calls** — every re-warm that happened *inside* the TTL window (should have hit
  cache, didn't), listed individually — project, gap, tokens, when — closest gap first.
  The aggregate "tool re-warm" count assumes a cause it can't actually verify; this table
  lets you look at the specific instances instead of trusting the label.

## How it decides what's a "re-warm"
A heuristic, and it says so: a previously-large warm prefix collapses and a large block gets
re-written. The preceding time gap splits the blame against the session's *actual* tier TTL
(60m on the 1-hour tier, 5m on the 5-minute tier) — beyond it means you walked away
(avoidable); inside it means the cache missed despite still being in its window. That second
bucket gets labeled "tool / compaction," but that cause is inferred, not confirmed — no
compaction marker exists in Claude Code's transcripts to check against. It's an
upper-bound-ish estimate, not gospel. Honesty over drama is the house style.

## Why the ridiculous name
Lineage of Boaty McBoatface. The tool measures cache warmth; the cache is the thing that
actually moves your cost around now that Anthropic [removed the time-of-day usage penalty](DEVLOG.md)
(2026-05-06) — so the clock is no longer a lever, and cache discipline is. A serious job
deserves an unserious name. It keeps expectations honest.

## The fine print
- **Read-only by design.** It only reads transcripts. It will never touch `~/.claude`.
- **Windows + Bun**, but the engine is just JS reading JSONL — portable in spirit.
- Cost weights (read 0.1x, 1h write 2x, output ~5x) are **assumptions from API pricing**,
  not your real subscription meter — that meter isn't programmatically accessible yet.
- See [`spec.md`](spec.md) for the locked v1 scope and assumptions, and [`DEVLOG.md`](DEVLOG.md)
  for every decision and the research that reshaped the whole project.

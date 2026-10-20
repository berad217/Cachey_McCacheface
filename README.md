# Cachey_McCacheface

*The dashboard the public would have voted for, if the public knew its Claude Code
cache was quietly setting money on fire.*

Your conversation context lives in a cache. While it's **warm**, every turn re-reads
the whole prefix at a steep discount (**0.05x** of input on Opus 5.5, **0.025x** on Fable 5.1).
Let it go **cold** and the next turn rebuilds that prefix once at **2x** — a 40-80x swing
on the context portion, paid silently, with a countdown nobody shows you. Cachey watches
the cache so you can keep typing, and tells you what it all would have cost on the API.

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
bun run meter      # log one /usage meter reading (0 tokens) to data/meter.jsonl
bun run cost       # API-equivalent cost: today / week / month / all time
bun test           # parser, scan and cost tests
```

That's the whole install. There is no step 2. It never phones home, never writes to
`~/.claude`, and has opinions about your pacing it keeps mostly to itself.

## What you're looking at
- **API-equivalent cost** — what this machine's Claude Code usage (subagents included)
  would cost at API list prices: today, this week, this month, all time. Two numbers each:
  *logged* (exact, for calls written to transcripts) and an *estimate* that adds the ~9% of
  calls that never reach a transcript, calibrated against Claude Code's own cost tracker.
  Dollars, not plan quota. Finished days go to `data/cost-daily.jsonl`, so the totals
  outlive Claude Code's transcript cleanup.
- **Warm countdown** — each warm thread and how long until its 1-hour cache expires.
  Reply within the window and the whole prefix is re-read cheap. Miss it and the next
  turn rebuilds the prefix once at 2x. The board shows *all* currently-warm threads, not
  just the one you're staring at — because the expensive ones are the ones you forgot about.
- **Tier** — 1-hour vs 5-minute. You want 1-hour. The banner fires if recent writes start
  landing on the 5-minute tier. This is the one warning Anthropic won't give you, so Cachey
  does (quietly, via a tray balloon — it will not steal your keyboard focus; that bug has
  been shot and buried).
- **Avoidable waste** — what re-warming threads you wandered away from for >1h cost above
  a warm read, as a share of your warm-read spend, in API dollars at each model's own
  rates. The lever you actually control.
- **Compactions** — how many, and how many you started after the cache had already
  expired. A cold compaction makes the summarizer re-read the whole context at full price;
  compacting *before* you walk away reads it warm.
- **Churn by project** — where the re-writes pile up. Idle waste (your pacing) is kept
  separate from compaction rebuilds and other misses.
- **Closest calls** — every re-warm *inside* the TTL window with no compaction before it
  (should have hit cache, didn't), listed individually — project, gap, tokens, when —
  closest gap first, so you can look at instances instead of trusting a label.

## How it decides what's a "re-warm"
A heuristic, and it says so: the cached prefix read collapses versus the previous call and a
large block gets re-written. If Claude Code's compaction marker (`compact_boundary`, written
since ~2026-09) comes right before it, it's a compaction rebuild. Otherwise the preceding gap
splits the blame against the session's *actual* tier TTL (60m on the 1-hour tier, 5m on the
5-minute tier): beyond it, you walked away (avoidable); inside it, the cache missed despite
still being in its window, cause not recorded. Misses from before the markers existed can't be
attributed, so the "other" bucket is an upper bound. Honesty over drama is the house style.

## Why the ridiculous name
Lineage of Boaty McBoatface. The tool measures cache warmth; the cache is the thing that
actually moves your cost around now that Anthropic [removed the time-of-day usage penalty](DEVLOG.md)
(2026-05-06) — so the clock is no longer a lever, and cache discipline is. A serious job
deserves an unserious name. It keeps expectations honest.

## The fine print
- **Read-only by design.** It only reads transcripts. It will never touch `~/.claude`. Its
  own two logs live in the repo's gitignored `data/`.
- **Windows + Bun**, but the engine is just JS reading JSONL — portable in spirit.
- **The one bundled file:** `public/vendor/chart.umd.js` (Chart.js 4.4.1, MIT) is vendored
  locally so the dashboard renders its charts without a CDN call — keeping "no network" literally true.
- Dollars are **API list prices** (`lib/prices.js`, dated), not your subscription meter.
  How a plan weights cache reads and writes against its limits isn't published. A model
  missing from the price table is shown as unpriced, never guessed.
- See [`spec.md`](spec.md) for the locked v1 scope and assumptions, and [`DEVLOG.md`](DEVLOG.md)
  for every decision and the research that reshaped the whole project.

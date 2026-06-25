# Cachey_McCacheface

Local cache-warmth dashboard for Claude Code. Reads your session transcripts
(`~/.claude/projects/**/*.jsonl`), shows when your active thread's context is
warm vs. about to go cold, and alarms if your cache tier silently downgrades.

No network calls, no dependencies, read-only. Just Bun.

## Quick start
```sh
bun run start      # dashboard at http://localhost:4317
bun run check      # headless tier-downgrade alarm (exit 1 if it fires)
bun run scan       # one-shot ASCII summary to the console
```

## What you're looking at
- **Warm countdown** - the active thread and how long until its 1-hour cache
  expires. Reply within it and the whole prefix is re-read at 0.1x. Let it
  expire and the next turn rebuilds the prefix once at ~2x.
- **Tier** - 1-hour vs 5-minute. You want 1-hour. The banner fires if recent
  writes start landing on the 5-minute tier (it has silently changed before).
- **Avoidable waste** - quota spent re-warming threads you left idle >1h,
  as a share of your warm-read spend. The lever you actually control.
- **Churn by project** - where re-writes pile up. Idle (your pacing) is
  separated from tool-driven compaction (not your fault).

## How it decides what's a "re-warm"
Heuristic: a previously-large warm prefix collapses and a large block is
re-written. The preceding time gap splits the cause - >1h gap means you walked
away (avoidable); <1h means the tool compacted or bulk-loaded context.

See `spec.md` for the locked v1 scope and assumptions, `DEVLOG.md` for why.

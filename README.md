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
bun run sessions   # ASCII session inventory, Claude Code + Codex (local machine)
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

## Sessions: Claude Code and Codex

The Sessions panel lists local Claude Code sessions and Codex threads, including
CLI threads missing from the Codex desktop app and subagents with their parent id.
Each row shows its vendor, model and effort, name, working folder, app/CLI, last activity time and
the first 200 characters of its last assistant message. Codex names come from the
last matching `session_index.jsonl` entry (human renames win), then a
`Worker-Name: <name>` line in the first human prompt, then the subagent nickname,
then the working folder. Before falling back to the folder, legacy workers can
infer a name from `.babel/outbox/`: every note modified between the recorded
first and newest record timestamps must start `From: Codex worker <name>`
with the same name. Notes outside that window are ignored; absent start times,
no matching notes, unreadable notes or mixed names leave the folder fallback.
Inferred names appear muted and labelled `(inferred)`. The API's `nameSource`
is `index`, `marker`, `outbox`, `nickname` or `folder` (`index` also covers Claude's
recorded titles). Marker parsing skips generated context, just like owner linking.
If a Codex working folder has `.babel/outbox/`, its newest three note filenames and first
lines appear too (first lines are capped at 4 KiB).

Model and effort reflect the latest recorded turn: Codex uses `turn_context.model`
and `turn_context.reasoning_effort`; Claude Code uses the latest assistant's
`message.model` and top-level `perTurnEffort` (falling back to `effort`). Both
Claude effort fields are present in real transcripts on this machine. A missing
model or effort shows `-`; thinking tokens or message text never imply effort.
The API exposes these as `model` and `effort` on every row, and the CLI prints both.

Last activity is the newest valid record timestamp, tracked as lines are read
for both vendors; file modification time is only a fallback when no record has
a valid timestamp. Touching a file or appending older records does not renew
recorded activity. Outbox windows use the earliest and newest record times.

**Running** means a record is less than 60 seconds old; it is an activity
heuristic, not proof that a process is alive. **Idle** means activity within the
window (24 hours by default); **old** means beyond it. The page refreshes every
15 seconds, groups running before idle, and folds old sessions into history.
Other machines are not included.

Vendor chips above Sessions select All / Claude Code / Codex, with counts from
the full inventory. The selection is remembered in localStorage when available.
Warm Claude rows show a live `57m left · 99% warm` chip, linked by full session id;
the warm board uses that session's title and falls back to its project folder.
Cold rows have no warmth chip.

Codex workers nest under their Claude owner when the first human prompt contains
an `Owner-Session: <Claude session id>` line. Generated environment/app context
records preceding that prompt are skipped. Older prompts starting `Message from
<NAME>` (optionally followed by a comma and description) infer ownership only
when exactly one Claude session has that exact title. The row labels this as
`owner (inferred)`; ambiguous or unmatched threads stay top-level. Codex subagents
keep their Codex parent. Vendor filters promote children whose parent is hidden
to top-level rows. Each child keeps its own activity state; a running descendant
adds a worker count to its collapsed owner and brings that group above idle/history.
The sessions API includes `owner` (Claude id or null) and `ownerInferred` (boolean).

Click a session row to read its transcript beneath it. Open transcripts refresh
every 15 seconds with newest items last and scroll to the end; closed panels
make no transcript requests. Each item is capped at 2,000 characters with a
`+N chars` marker for omitted text. Codex reasoning is shown as `[reasoning hidden]`.

`GET /api/transcript?vendor=codex|claude&id=<session id>&limit=200` returns an
array of `{time, kind, text, tool?}` items, oldest first within the last `limit`
items. Kinds are `user`, `assistant`, `tool_call`, `tool_output`, and `note`.
The optional limit must be an integer from 1 to 1,000 (otherwise HTTP 400).
Unknown ids or vendors return 404. File paths resolve only from the session
inventory, never from query text; transcript reads do not modify vendor files.

The server binds to `127.0.0.1` by default. `HOST` overrides the bind address;
**don't override it**: transcripts contain private messages and tool output and
must never be exposed to the network. There is no authentication.

`GET /api/sessions?window=24` returns all rows newest first; `window` is a positive
number of hours setting the idle/old boundary, not a history filter. Invalid
values return HTTP 400. `bun run sessions` prints the same list in ASCII;
`bun run sessions 48` changes the window to 48 hours.

The reader scans `~/.codex/sessions/**/rollout-*.jsonl` and
`~/.codex/session_index.jsonl`, using `$CODEX_HOME` instead of `~/.codex` when set,
plus `~/.claude/projects/**/*.jsonl`. Unchanged files use cached metadata;
append-only growth reads new bytes and incomplete lines wait for the next poll.
Missing or unreadable files are skipped. All vendor files are opened read-only
and closed after each pass; nothing under `~/.codex` or `~/.claude` is written,
locked or renamed. This panel adds no Codex cost or cache-warmth estimates.

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

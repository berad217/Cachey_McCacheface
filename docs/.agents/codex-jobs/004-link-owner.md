# 004: one session, one row: warm timer on the row, vendor filters, Codex workers under their owner

**Why (Brad, looking at the page):** the warm-threads card names a session after its transcript folder
("AI-stuff-software-projects-Bricky-McBrickface"), while the Sessions panel names the same session by title
("ROG BRICKY", id b7d4fafd-...), so one session shows twice under two names, with the timer on only one. He also wants
filters by vendor and to see which Claude session owns each Codex worker.

**What done means:**
- **Link by session id.** The warm data and the session rows come from the same transcript file. Put the warm
  countdown and percentage as a chip on that session's row ("57m left · 99% warm"; cold sessions show no chip). The
  warm card shows the session's title when one is known, and the folder only as a fallback.
- **Vendor filter chips** above the Sessions panel: All / Claude Code / Codex, each with its count, remembered in
  localStorage (wrapped in try/catch).
- **Owner nesting.** A Codex thread whose **first user message** contains a line `Owner-Session: <claude session id>`
  nests under that Claude session's row. Show it as "owner: <title>". Fallback for threads that predate the marker: a
  first line "Message from <NAME>" matching exactly one Claude session's title gives the same nesting, labelled
  "owner (inferred)". No match: the thread stays top-level. A Codex sub-agent already nests under its
  `parent_thread_id`; keep that. `/api/sessions` rows gain `owner` and `ownerInferred`.
- Nested rows keep their own state (running/idle). A running child makes its collapsed owner show "1 worker running".
- Check every shape against real files on this box (`~/.codex/sessions`, `~/.claude/projects`), as in job 003.
  Read-only, as before.

**RED first:**
- (a) a Codex fixture with `Owner-Session:` nests under the matching Claude row;
- (b) "Message from ROG BRICKY" with exactly one Claude session titled ROG BRICKY nests with ownerInferred true, and
  two such sessions leave it top-level;
- (c) a warm Claude session's row carries the countdown, and the warm card uses its title;
- (d) the filter logic returns only the chosen vendor, with correct counts.

`bun test` stays green.

**Owns:** `lib/codex.js`, `lib/scan.js` (only what linking needs), their tests, `public/index.html`, `server.js` if a
route changes, README and DEVLOG lines.

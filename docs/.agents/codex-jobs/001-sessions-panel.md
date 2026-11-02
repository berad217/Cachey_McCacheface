# 001: a Sessions panel, Claude Code and Codex on one list

**Why:** Brad now runs Claude Code sessions and Codex threads side by side on this box. Codex threads started from
the CLI (`codex exec`) don't appear in the Codex desktop app, so he can't see them. Cachey already scans every Claude
Code transcript incrementally and shows warm threads. Make it also show every recent session from **both** vendors,
so one page answers "what is running on this machine right now?". Sessions on other machines are out of scope:
this is a stated limitation, not a gap.

**What done means:**
- **A Codex reader** in a new `lib/codex.js`.
  - It reads `~/.codex/sessions/**/rollout-*.jsonl`, or `$CODEX_HOME/sessions` when `CODEX_HOME` is set, plus `session_index.jsonl` for thread names. The last name for an id wins.
  - The first line of each rollout is `session_meta`. Its `payload` carries `id`, `cwd`, `originator` (`Codex Desktop` or the CLI's) and `source`. A `source.subagent.thread_spawn` object marks a sub-agent with `parent_thread_id` and `agent_nickname`.
  - Assistant messages are `payload.type == "message"` with `role == "assistant"` and text in `content[].text`.
  - Reuse `scan.js`'s incremental, append-only read pattern, so polling every few seconds stays cheap.
- **One session row per thread, from either vendor:**
  - vendor;
  - name (Codex: the index name, or else the sub-agent nickname; Claude: whatever the transcript carries, or else the project folder);
  - working folder;
  - app or CLI;
  - parent, for sub-agents;
  - last activity time;
  - a **running / idle / old** state (running = the file grew within the last 60 s; idle = within the window; old = beyond it);
  - the last assistant message, first 200 characters.
- **For Codex threads only:** if the thread's `cwd` has a `.babel/outbox/` folder, show its newest 3 note file names and their first lines. This is the Claude-to-Codex messaging outbox.
- **API and page:**
  - `/api/sessions` returns the rows, newest first, with a `?window=` in hours (default 24).
  - A "Sessions" panel on the dashboard shows them, grouped running → idle, and refreshes on the page's existing cycle.
  - `bun run sessions` prints the same list as ASCII.
- **Read-only, absolutely:** never write, lock or rename anything under `~/.codex` or `~/.claude`. Don't open files in a way that could hold a lock (the Codex app holds writer locks on threads it has loaded; reading the rollout files is fine).
- **Docs:** a README section, and a DEVLOG entry in this repo's style.

**RED first:** `lib/codex.test.js` on fixture rollouts made from the shapes above, failing before the reader exists:
- (a) a top-level CLI thread with an index name;
- (b) a sub-agent naming its parent;
- (c) a thread whose file grew 10 s ago reads as running, and one from 2 h ago reads as idle;
- (d) a malformed line is skipped, not fatal.

`bun test` stays green across the repo.

**Owns:** new `lib/codex.js` and `lib/codex.test.js`, plus the sessions route, panel and script in `server.js`, `public/index.html`, `package.json`, `README.md` and `DEVLOG.md`.

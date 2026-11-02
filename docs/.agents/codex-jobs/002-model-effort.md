# 002: show each session's model and effort

**Why:** the Sessions panel (job 001) lists Claude Code and Codex sessions, but not what each runs on. Brad wants to
see the model and the reasoning effort for every session at a glance, for pacing and to catch a worker on the wrong
model.

**What done means:**
- **Codex:** read the latest `turn_context` record in each rollout. It carries `model` (for example `gpt-6.1-sol`) and
  `reasoning_effort` (for example `medium`). A thread that changed model mid-way shows the latest one.
- **Claude Code:** the latest assistant record's `message.model`. Show effort only if the transcript actually records
  it somewhere; find out from real transcripts on this box, and if it isn't there, show `-` and say so in the README.
  Never guess.
- Both fields go on each `/api/sessions` row (`model`, `effort`), in `bun run sessions` and in the panel (a compact
  "gpt-6.1-sol · medium" / "claude-opus-5-5 · -" tag beside the vendor).
- Incremental and read-only, as in job 001.

**RED first:** extend `lib/codex.test.js` with fixtures:
- (a) a Codex thread with two `turn_context` records reports the later model and effort;
- (b) a Claude transcript reports its latest assistant model;
- (c) a session with neither shows `-`, not an error.

`bun test` stays green.

**Owns:** `lib/codex.js`, `lib/codex.test.js`, the panel in `public/index.html`, README and DEVLOG lines.

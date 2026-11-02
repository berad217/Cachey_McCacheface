# 003: read a session's transcript on demand (and serve on localhost only)

**Why:** the Sessions panel shows that a session exists and its last message. Brad wants to open any session, Codex or
Claude, and read what it has been doing, without opening the app it belongs to (CLI-started Codex threads don't show
in the Codex app at all).

**Step 1, before anything else: localhost only.** `server.js` calls `Bun.serve({ port })` with no hostname, so it
listens on every interface. Add `hostname: "127.0.0.1"` (overridable with `HOST`, documented in README as "don't").
Transcripts must never be reachable from the network.

**What done means:**
- `GET /api/transcript?vendor=codex|claude&id=<session id>&limit=200` returns the session's last `limit` items, oldest
  first. **Resolve the id to a file only through the session list the reader already built; never build a path from
  the query** (no traversal, no arbitrary file reads). Unknown id: 404.
- An item is `{time, kind, text, tool?}` with `kind` one of `user`, `assistant`, `tool_call`, `tool_output`, `note`.
  - **Codex:** check the real shapes in rollouts under `~/.codex/sessions` on this box, not only this description.
    Messages are `payload.type == "message"` (role `user`/`assistant`, text in `content[].text`). Tool calls are
    `function_call` / `custom_tool_call` (name, arguments), and their results are `function_call_output`. Encrypted
    `reasoning` items become one `note`: "[reasoning hidden]".
  - **Claude:** check real transcripts under `~/.claude/projects` the same way. Show user and assistant text,
    `tool_use` (name plus a one-line input summary) and `tool_result` (truncated).
  - Truncate each item's text to 2,000 characters, with a "+N chars" marker.
- **Page:** clicking a session row opens its transcript beneath it, loaded only on click and never polled while
  closed. While open, it refreshes on the page's cycle, with newest last and scrolled to the end. Escape the HTML (the
  panel already escapes tags; keep that).
- Read-only, as in jobs 001-002.

**RED first:** tests on fixture files in the real shapes:
- (a) a Codex rollout yields user, assistant, tool_call, tool_output and one reasoning note, in order;
- (b) a Claude transcript yields user, assistant, tool_use and tool_result;
- (c) an id not in the session list is refused, and a path-like id such as `..\x` is refused;
- (d) a 5,000-character output is truncated with its marker.

`bun test` stays green.

**Owns:** `server.js` (the hostname and the route), `lib/codex.js` or a new `lib/transcript.js` with its test,
`public/index.html`, README and DEVLOG lines.

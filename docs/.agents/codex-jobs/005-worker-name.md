# 005: name CLI workers by job, not by folder

**Why:** a Codex thread started from the CLI has no entry in `session_index.jsonl`, so the Sessions panel names it
after its working folder, and four workers all read "Cachey_McCacheface". From now on, the coordinator's first message
to each worker carries a `Worker-Name: <name>` line (beside the `Owner-Session:` line from job 004).

**What done means:**
- A Codex thread whose first human user message (the same one job 004 reads for `Owner-Session:`) has a line
  `Worker-Name: <name>` is named `<name>`.
- Name precedence: a `session_index.jsonl` name (a human rename in the app wins), then `Worker-Name:`, then the
  sub-agent nickname, then the folder.
- Fallback for threads that predate the marker: if the thread's `.babel/outbox/` notes start "From: Codex worker
  <name>", and every note written between the thread's first and last activity names the same worker, use that name,
  marked inferred. Otherwise keep the folder. The outbox folder is shared by successive workers, so use file times,
  not just the newest note.
- `/api/sessions` rows gain `nameSource`: `index`, `marker`, `outbox`, `nickname` or `folder`. The panel shows an
  inferred name in a muted style.
- Read-only, and check shapes against real files on this box, as before.

**RED first:**
- (a) `Worker-Name:` names a thread;
- (b) an index name beats the marker;
- (c) outbox inference picks the worker whose notes fall inside the thread's activity window, when two workers shared
  the folder;
- (d) no marker and no notes keeps the folder name.

`bun test` stays green.

**Owns:** `lib/codex.js` and its test, `public/index.html`, README and DEVLOG lines.

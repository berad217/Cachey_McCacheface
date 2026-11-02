# 006: last activity from the records, not the file's modified time

**Why (diagnosed by the coordinator on this box):** a Codex rollout's file modified time stays at the thread's start.
Thread `01a19db2…` (Cachey-001) has mtime 14:18:17 local, but its outbox notes run 14:18:46 to 14:22:25, and its last
record is later still. It looks like Windows doesn't refresh LastWriteTime on a file Codex keeps open while appending
(unconfirmed). Cachey seeds `lastActivity` from mtime, so after a server restart:
- Codex threads show stale last-activity times and wrong running/idle/old states;
- job 005's outbox inference sees a zero-length window, which is why Cachey-001 to 004 keep their folder names.

**What done means:**
- Every rollout line and every Claude transcript line carries an ISO `timestamp`. A session's `lastActivity` is the
  newest record timestamp seen; its `firstActivity` is the first. Use mtime only as a fallback when no line has one.
  Keep the incremental read: track the newest timestamp as lines are consumed.
- `running` means a record newer than 60 s, not file growth. Keep a growth-seen-now signal only if it helps a record
  without a timestamp.
- Job 005's outbox window uses `firstActivity`..`lastActivity`. Check against the real Cachey outbox on this box: notes
  01-04 belong to Cachey-001, 05-08 to 002, 09-12 to 003, 13-16 to 004 and 17-20 to 005, so those five threads should
  name themselves. Check the warm-threads data too, for anything that also leans on mtime.
- Read-only, as before.

**RED first:**
- (a) a rollout whose mtime is older than its last record reports the record time;
- (b) the state comes from record time (a record 30 s old is running, though mtime says 2 h);
- (c) two workers sharing one outbox, with mtimes stuck at their starts, each get their own name from record-time
  windows;
- (d) a file with no timestamps falls back to mtime.

`bun test` stays green.

**Owns:** `lib/codex.js`, `lib/scan.js` (only if warm data leans on mtime), their tests, README and DEVLOG lines.

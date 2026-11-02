import { test, expect, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionReader } from "./codex.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cachey-sessions-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const now = Date.parse("2026-11-02T18:00:00Z");
let n = 0;
function fixture() {
  const home = path.join(dir, String(n++));
  fs.mkdirSync(path.join(home, "sessions", "2026"), { recursive: true });
  return { home, read: createSessionReader({ codexHome: home, projectsDir: path.join(home, "projects") }) };
}
function rollout(home, id, age, extra = {}) {
  const file = path.join(home, "sessions", "2026", "rollout-" + id + ".jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: {
    id, cwd: home, originator: "codex_exec", source: "exec", ...extra,
  } }) + "\n" + JSON.stringify({ type: "response_item", payload: {
    type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello " + "x".repeat(220) }],
  } }) + "\n");
  fs.utimesSync(file, new Date(now - age), new Date(now - age));
  return file;
}
test("CLI thread gets the last index name and a bounded assistant preview", () => {
  const { home, read } = fixture();
  rollout(home, "main", 10000);
  fs.writeFileSync(path.join(home, "session_index.jsonl"), [
    { id: "main", thread_name: "Before" }, { id: "main", thread_name: "Named thread" },
  ].map(JSON.stringify).join("\n"));
  expect(read({ now })[0]).toMatchObject({ id: "main", vendor: "Codex", name: "Named thread", cwd: home, app: "CLI", state: "running" });
  expect(read({ now })[0].lastAssistant).toHaveLength(200);
});
test("subagent keeps parent and nickname; desktop is identified", () => {
  const { home, read } = fixture();
  rollout(home, "child", 10000, { originator: "Codex Desktop", source: { subagent: { thread_spawn: { parent_thread_id: "main", agent_nickname: "Scout" } } } });
  expect(read({ now })[0]).toMatchObject({ name: "Scout", parent: "main", app: "app" });
});
test("activity states use file growth time and requested window", () => {
  const { home, read } = fixture();
  rollout(home, "running", 10000);
  rollout(home, "idle", 2 * 3600000);
  rollout(home, "old", 25 * 3600000);
  expect(read({ now }).map(r => r.state)).toEqual(["running", "idle", "old"]);
  expect(read({ now, window: 1 })[1].state).toBe("old");
  expect(read({ now: now + 61000 })[0].state).toBe("idle");
});
test("index appends rename a cached thread, while touching it does not renew activity", () => {
  const { home, read } = fixture();
  const file = rollout(home, "main", 2 * 3600000);
  const index = path.join(home, "session_index.jsonl");
  fs.writeFileSync(index, JSON.stringify({ id: "main", thread_name: "First" }) + "\n");
  expect(read({ now })[0].name).toBe("First");
  fs.appendFileSync(index, JSON.stringify({ id: "main", thread_name: "Renamed" }) + "\n");
  fs.utimesSync(file, new Date(now), new Date(now));
  expect(read({ now })[0]).toMatchObject({ name: "Renamed", state: "idle", lastActivity: now - 2 * 3600000 });
});
test("malformed lines are skipped and partial appended UTF-8 messages complete later", () => {
  const { home, read } = fixture();
  const file = rollout(home, "main", 10000);
  fs.appendFileSync(file, "broken JSON\n");
  read({ now });
  const line = JSON.stringify({ payload: { type: "message", role: "assistant", content: [{ text: "New café" }] } });
  fs.appendFileSync(file, line.slice(0, -4));
  expect(read({ now })[0].lastAssistant).toStartWith("Hello");
  fs.appendFileSync(file, line.slice(-4) + "\n");
  expect(read({ now })[0].lastAssistant).toBe("New café");
});
test("Claude sessions include names, parents, folders and assistant text", () => {
  const { home, read } = fixture();
  const project = path.join(home, "projects", "project", "main", "subagents");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "agent-child.jsonl"), [
    { type: "custom-title", customTitle: "Claude scout" },
    { type: "assistant", sessionId: "main", agentId: "child", cwd: home, entrypoint: "cli", message: { content: [{ type: "text", text: "Done" }] } },
  ].map(JSON.stringify).join("\n"));
  expect(read({ now })[0]).toMatchObject({ id: "child", vendor: "Claude Code", name: "Claude scout", parent: "main", cwd: home, lastAssistant: "Done", app: "CLI" });
});
test("Codex notes show newest three first lines; rewrites and deletion invalidate cache", () => {
  const { home, read } = fixture();
  const file = rollout(home, "main", 10000);
  const outbox = path.join(home, ".babel", "outbox");
  fs.mkdirSync(outbox, { recursive: true });
  for (let i = 0; i < 4; i++) {
    const note = path.join(outbox, i + ".md");
    fs.writeFileSync(note, "Note " + i + "\nsecond line");
    fs.utimesSync(note, new Date(now + i * 1000), new Date(now + i * 1000));
  }
  expect(read({ now })[0].notes).toEqual([3, 2, 1].map(i => ({ name: i + ".md", firstLine: "Note " + i })));
  fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: "replacement", cwd: home } }));
  expect(read({ now })[0].id).toBe("replacement");
  fs.unlinkSync(file);
  expect(read({ now })).toEqual([]);
});

test("Codex uses the latest turn context model and effort, including incremental changes", () => {
  const { home, read } = fixture();
  const file = rollout(home, "main", 10000);
  const context = (model, reasoning_effort) => JSON.stringify({ type: "turn_context", payload: { model, effort: reasoning_effort, collaboration_mode: { settings: { model, reasoning_effort } } } }) + "\n";
  fs.appendFileSync(file, context("gpt-6-sol", "high") + context("gpt-6.1-sol", "medium"));
  const before = read({ now })[0];
  expect(before).toMatchObject({ model: "gpt-6.1-sol", effort: "medium" });
  fs.appendFileSync(file, context("gpt-6.1-terra", "low"));
  expect(read({ now })[0]).toMatchObject({ model: "gpt-6.1-terra", effort: "low" });
  expect(before).toMatchObject({ model: "gpt-6.1-sol", effort: "medium" });
  fs.appendFileSync(file, JSON.stringify({ type: "turn_context", payload: { model: "gpt-6.1-sol" } }) + "\n");
  expect(read({ now })[0]).toMatchObject({ model: "gpt-6.1-sol", effort: "-" });
});

test("Claude uses its latest assistant model and does not infer effort from thinking", () => {
  const { home, read } = fixture();
  const project = path.join(home, "projects", "project");
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, "main.jsonl");
  const assistant = model => JSON.stringify({ type: "assistant", sessionId: "main", message: {
    model, content: [{ type: "thinking", thinking: "Some reasoning" }],
  } }) + "\n";
  fs.writeFileSync(file, assistant("claude-sonnet-4-6") + assistant("claude-opus-5-5"));
  expect(read({ now })[0]).toMatchObject({ model: "claude-opus-5-5", effort: "-" });
  fs.appendFileSync(file, assistant("claude-sonnet-4-6"));
  expect(read({ now })[0]).toMatchObject({ model: "claude-sonnet-4-6", effort: "-" });
});

test("sessions with no recorded model or effort use dashes for either vendor", () => {
  const { home, read } = fixture();
  rollout(home, "main", 10000);
  const project = path.join(home, "projects", "project");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "claude.jsonl"), JSON.stringify({ type: "assistant", sessionId: "claude", message: {} }));
  const rows = read({ now });
  expect(rows).toHaveLength(2);
  for (const row of rows) expect(row).toMatchObject({ model: "-", effort: "-" });
});

test("Claude shows recorded per-turn effort, falls back to effort, and clears missing metadata", () => {
  const { home, read } = fixture();
  const project = path.join(home, "projects", "project");
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, "main.jsonl");
  const assistant = fields => JSON.stringify({ type: "assistant", sessionId: "main",
    message: { model: "claude-opus-5-5" }, ...fields }) + "\n";
  fs.writeFileSync(file, assistant({ effort: "high", perTurnEffort: "medium" }));
  expect(read({ now })[0].effort).toBe("medium");
  fs.appendFileSync(file, assistant({ effort: "xhigh" }));
  expect(read({ now })[0].effort).toBe("xhigh");
  fs.appendFileSync(file, assistant({}));
  expect(read({ now })[0].effort).toBe("-");
});

function claudeOwner(home, id, title, age) {
  const project = path.join(home, "projects", "owner-project");
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, id + ".jsonl");
  fs.writeFileSync(file, [
    { type: "custom-title", customTitle: title },
    { type: "assistant", sessionId: id, message: {} },
  ].map(JSON.stringify).join("\n") + "\n");
  if (age !== undefined) fs.utimesSync(file, new Date(now - age), new Date(now - age));
}
function userMessage(file, value) {
  fs.appendFileSync(file, JSON.stringify({ type: "response_item", payload: {
    type: "message", role: "user", content: [{ type: "input_text", text: value }],
  } }) + "\n");
}

test("explicit owner marker links the first user message to a Claude session", () => {
  const { home, read } = fixture();
  claudeOwner(home, "owner", "ROG BRICKY");
  const file = rollout(home, "worker", 10000);
  userMessage(file, '<environment_context>\n<cwd>C:/project</cwd>\n</environment_context>');
  userMessage(file, "Owner-Session: owner\nMessage from ROG BRICKY\nDo the job.");
  expect(read({ now }).find(r => r.id === "worker")).toMatchObject({ owner: "owner", ownerInferred: false });
  userMessage(file, "Owner-Session: another");
  expect(read({ now }).find(r => r.id === "worker").owner).toBe("owner");
});

test("legacy owner inference requires exactly one exact Claude title", () => {
  const { home, read } = fixture();
  claudeOwner(home, "owner", "ROG BRICKY", 5000);
  const file = rollout(home, "worker", 10000);
  userMessage(file, '<environment_context>\n<cwd>C:/project</cwd>\n</environment_context>');
  userMessage(file, "Message from ROG BRICKY, the Claude Code coordinator on this machine.\nPlease help.");
  fs.utimesSync(file, new Date(now - 10000), new Date(now - 10000));
  expect(read({ now }).find(r => r.id === "worker")).toMatchObject({ owner: "owner", ownerInferred: true });
  // A coordinator title recurs across days: one that went quiet before the worker's last write is not its sender.
  claudeOwner(home, "yesterday", "ROG BRICKY", 86400000);
  expect(read({ now }).find(r => r.id === "worker")).toMatchObject({ owner: "owner", ownerInferred: true });
  // Two same-titled sessions both active after the worker's last write: ambiguous, so it stays top-level.
  claudeOwner(home, "duplicate", "ROG BRICKY", 3000);
  expect(read({ now }).find(r => r.id === "worker")).toMatchObject({ owner: null, ownerInferred: false });
});

test("unmatched or later owner messages stay unowned; subagents keep their parent", () => {
  const { home, read } = fixture();
  claudeOwner(home, "owner", "ROG BRICKY");
  const file = rollout(home, "worker", 10000);
  userMessage(file, "No owner here");
  read({ now });
  userMessage(file, "Owner-Session: owner");
  const missing = rollout(home, "missing", 10000);
  userMessage(missing, "Owner-Session: absent\nMessage from ROG BRICKY");
  const child = rollout(home, "child", 10000, { source: { subagent: { thread_spawn: { parent_thread_id: "worker" } } } });
  userMessage(child, "Owner-Session: owner");
  const rows = read({ now });
  for (const id of ["worker", "missing"]) expect(rows.find(r => r.id === id)).toMatchObject({ owner: null, ownerInferred: false });
  expect(rows.find(r => r.id === "child").parent).toBe("worker");
});

test("Worker-Name in the first human prompt names a thread, ignoring generated context and later markers", () => {
  const { home, read } = fixture();
  const file = rollout(home, "worker", 10000);
  userMessage(file, '<environment_context>Worker-Name: injected</environment_context>');
  userMessage(file, "Owner-Session: owner\r\nWorker-Name: Cachey-005  \r\nDo the job.");
  expect(read({ now })[0]).toMatchObject({ name: "Cachey-005", nameSource: "marker" });
  userMessage(file, "Worker-Name: later");
  expect(read({ now })[0]).toMatchObject({ name: "Cachey-005", nameSource: "marker" });
});

test("index rename beats Worker-Name, which beats a subagent nickname", () => {
  const { home, read } = fixture();
  const file = rollout(home, "worker", 10000, { source: { subagent: { thread_spawn: { agent_nickname: "Scout" } } } });
  userMessage(file, "Worker-Name: Cachey-005");
  expect(read({ now })[0]).toMatchObject({ name: "Cachey-005", nameSource: "marker" });
  fs.writeFileSync(path.join(home, "session_index.jsonl"), JSON.stringify({ id: "worker", thread_name: "Human rename" }));
  expect(read({ now })[0]).toMatchObject({ name: "Human rename", nameSource: "index" });
});

function workerNote(home, name, worker, time) {
  const outbox = path.join(home, ".babel", "outbox");
  fs.mkdirSync(outbox, { recursive: true });
  const file = path.join(outbox, name + ".md");
  fs.writeFileSync(file, "From: Codex worker " + worker + "\nBody");
  fs.utimesSync(file, new Date(time), new Date(time));
  return file;
}
function timedRollout(home, id, start, end) {
  const file = rollout(home, id, now - end);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  lines[0].timestamp = new Date(start).toISOString();
  fs.writeFileSync(file, lines.map(JSON.stringify).join("\n") + "\n");
  fs.utimesSync(file, new Date(end), new Date(end));
  return file;
}

test("outbox inference uses all notes inside each worker's activity window, not the newest three", () => {
  const { home, read } = fixture();
  timedRollout(home, "early", now - 20000, now - 10000);
  timedRollout(home, "later", now - 9000, now - 1000);
  workerNote(home, "01", "Cachey-001", now - 19000);
  for (let i = 0; i < 4; i++) workerNote(home, "0" + (i + 2), "Cachey-002", now - 8000 + i * 1000);
  const rows = read({ now });
  expect(rows.find(r => r.id === "early")).toMatchObject({ name: "Cachey-001", nameSource: "outbox" });
  expect(rows.find(r => r.id === "later")).toMatchObject({ name: "Cachey-002", nameSource: "outbox" });
  expect(rows[0].notes).toHaveLength(3);
});

test("no marker or notes keeps the folder, and later markers do not rename it", () => {
  const { home, read } = fixture();
  const file = rollout(home, "worker", 10000);
  userMessage(file, "Do the job.");
  userMessage(file, "Worker-Name: later");
  expect(read({ now })[0]).toMatchObject({ name: path.basename(home), nameSource: "folder" });
});

test("ambiguous outbox notes refuse inference, and edits refresh the result", () => {
  const { home, read } = fixture();
  timedRollout(home, "worker", now - 20000, now - 10000);
  const note = workerNote(home, "01", "Different", now - 19000);
  for (let i = 0; i < 4; i++) workerNote(home, "0" + (i + 2), "Cachey-002", now - 18000 + i * 1000);
  expect(read({ now })[0]).toMatchObject({ name: path.basename(home), nameSource: "folder" });
  fs.unlinkSync(note);
  expect(read({ now })[0]).toMatchObject({ name: "Cachey-002", nameSource: "outbox" });
  fs.writeFileSync(note, "Unrelated note\n");
  fs.utimesSync(note, new Date(now - 19000), new Date(now - 19000));
  expect(read({ now })[0].nameSource).toBe("folder");
});

test("nickname wins over inferred notes, and missing start times never infer a worker", () => {
  const { home, read } = fixture();
  rollout(home, "child", 10000, { source: { subagent: { thread_spawn: { agent_nickname: "Scout" } } } });
  rollout(home, "unknown-start", 10000);
  workerNote(home, "01", "Cachey-002", now - 15000);
  const rows = read({ now });
  expect(rows.find(r => r.id === "child")).toMatchObject({ name: "Scout", nameSource: "nickname" });
  expect(rows.find(r => r.id === "unknown-start")).toMatchObject({ name: path.basename(home), nameSource: "folder" });
});

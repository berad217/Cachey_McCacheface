import { test, expect, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionReader } from "./codex.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cachey-transcript-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
let serial = 0;
function fixture(vendor, records) {
  const home = path.join(dir, String(serial++));
  const folder = path.join(home, vendor === "codex" ? "sessions" : "projects");
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, vendor === "codex" ? "rollout-test.jsonl" : "test.jsonl");
  const meta = vendor === "codex" ? { type: "session_meta", payload: { id: "test" } } : { sessionId: "test" };
  fs.writeFileSync(file, [meta, ...records].map(JSON.stringify).join("\n") + "\n");
  const read = createSessionReader({ codexHome: home, projectsDir: path.join(home, "projects") });
  read();
  return { read, file };
}
const cx = payload => ({ type: "response_item", timestamp: "2026-11-02T18:00:00Z", payload });

test("Codex real rollout shapes yield ordered messages, calls, results and hidden reasoning", async () => {
  const { read } = fixture("codex", [
    cx({ type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] }),
    cx({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello" }] }),
    cx({ type: "function_call", call_id: "one", name: "exec", arguments: '{"cmd":"pwd"}' }),
    cx({ type: "function_call_output", call_id: "one", output: "here" }),
    cx({ type: "reasoning", encrypted_content: "secret", summary: [] }),
    cx({ type: "custom_tool_call", call_id: "two", name: "patch", input: "patch text" }),
    cx({ type: "custom_tool_call_output", call_id: "two", output: "patched" }),
  ]);
  const items = await read.transcript({ vendor: "codex", id: "test" });
  expect(items.map(i => i.kind)).toEqual(["user", "assistant", "tool_call", "tool_output", "note", "tool_call", "tool_output"]);
  expect(items[2]).toMatchObject({ tool: "exec", text: '{"cmd":"pwd"}', time: "2026-11-02T18:00:00Z" });
  expect(items[4].text).toBe("[reasoning hidden]");
  expect(items[5].text).toBe("patch text");
  expect(await read.transcript({ vendor: "codex", id: "test", limit: 2 })).toEqual(items.slice(-2));
});

test("Claude strings and blocks yield text, one-line tool input and tool result", async () => {
  const { read } = fixture("claude", [
    { type: "user", message: { role: "user", content: "Hi" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Hello" }, { type: "tool_use", id: "one", name: "Read", input: { file_path: "a\nb" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "one", content: [{ type: "text", text: "contents" }] }] } },
  ]);
  const items = await read.transcript({ vendor: "claude", id: "test" });
  expect(items.map(i => i.kind)).toEqual(["user", "assistant", "tool_call", "tool_output"]);
  expect(items[2]).toMatchObject({ tool: "Read", text: '{"file_path":"a\\nb"}' });
  expect(items[3].text).toBe("contents");
});

test("unknown, path-like and wrong-vendor ids cannot resolve a file", async () => {
  const { read, file } = fixture("codex", []);
  for (const id of ["missing", "..\\x", file]) expect(await read.transcript({ vendor: "codex", id })).toBeNull();
  expect(await read.transcript({ vendor: "claude", id: "test" })).toBeNull();
  fs.unlinkSync(file);
  expect(await read.transcript({ vendor: "codex", id: "test" })).toBeNull();
});

test("large output is capped at 2000 characters plus an exact omitted-count marker", async () => {
  const { read } = fixture("codex", [cx({ type: "function_call_output", output: "x".repeat(5000) })]);
  const [item] = await read.transcript({ vendor: "codex", id: "test" });
  expect(item.text).toBe("x".repeat(2000) + " [+3000 chars]");
});

test("on-demand refresh reads appends, skips malformed tails and event-message duplicates", async () => {
  const { read, file } = fixture("codex", [cx({ type: "message", role: "user", content: [{ text: "first" }] })]);
  expect((await read.transcript({ vendor: "codex", id: "test" })).map(i => i.text)).toEqual(["first"]);
  fs.appendFileSync(file, [
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "duplicate" } }),
    JSON.stringify(cx({ type: "message", role: "assistant", content: [{ text: "second" }] })),
    '{"incomplete":',
  ].join("\n"));
  expect((await read.transcript({ vendor: "codex", id: "test" })).map(i => i.text)).toEqual(["first", "second"]);
});

test("Claude tool results are capped and invalid limits are rejected", async () => {
  const { read } = fixture("claude", [{ type: "user", message: { content: [{ type: "tool_result", content: "x".repeat(5000) }] } }]);
  expect((await read.transcript({ vendor: "claude", id: "test" }))[0].text).toBe("x".repeat(2000) + " [+3000 chars]");
  for (const limit of [0, -1, 1.5, 1001, "bad"]) {
    expect(read.transcript({ vendor: "claude", id: "test", limit })).rejects.toThrow(RangeError);
  }
});

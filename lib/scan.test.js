// Incremental-parse tests: the per-file cache must always agree with a full
// re-parse of the file's current contents. Run: bun test
import { test, expect, beforeEach, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSession, loadSession, loadFile } from "./scan.js";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cachey-scan-test-"));
let fp;
let n = 0;

beforeEach(() => {
  fp = path.join(DIR, "s" + n++ + ".jsonl");
});
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

const T0 = Date.parse("2026-10-19T12:00:00Z");
function turn(min, read, extra = {}) {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date(T0 + min * 60000).toISOString(),
    message: {
      model: "claude-opus-5-5",
      content: [{ type: "text", text: "café ✓ 😀" }],
      usage: {
        input_tokens: 3,
        output_tokens: 100,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: 500,
        cache_creation: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 },
        ...extra,
      },
    },
  });
}
const user = (text) => JSON.stringify({ type: "user", message: { content: text } });

function sf() {
  const st = fs.statSync(fp);
  return { path: fp, mtimeMs: st.mtimeMs, size: st.size };
}
// The invariant: cached load == full parse of what is on disk now.
function check() {
  const got = loadSession(sf());
  expect(got).toEqual(parseSession(fp));
  return got;
}

test("first load matches a full parse", () => {
  fs.writeFileSync(fp, [user("hi é"), turn(0, 0), turn(1, 30000), ""].join("\n"));
  expect(check()).toHaveLength(2);
});

test("appended turns are picked up, out-of-order and tied timestamps keep full-parse order", () => {
  fs.writeFileSync(fp, [turn(5, 1), turn(2, 2), turn(5, 3), ""].join("\n"));
  check();
  fs.appendFileSync(fp, [turn(5, 4), turn(1, 5), user("x"), turn(5, 6), ""].join("\n"));
  const recs = check();
  expect(recs.map((r) => r.read)).toEqual([5, 2, 1, 3, 4, 6]);
});

test("a half-written line is deferred, then read once complete", () => {
  const line = turn(1, 777);
  const cut = line.indexOf('"usage"'); // before "output_tokens" appears
  fs.writeFileSync(fp, turn(0, 1) + "\n" + line.slice(0, cut));
  expect(check()).toHaveLength(1);
  fs.appendFileSync(fp, line.slice(cut) + "\n");
  expect(check()).toHaveLength(2);
});

test("a complete final line with no newline counts, and appending after it works", () => {
  fs.writeFileSync(fp, turn(0, 1) + "\n" + turn(1, 2));
  expect(check()).toHaveLength(2);
  fs.appendFileSync(fp, "\n" + turn(2, 3) + "\n");
  expect(check()).toHaveLength(3);
});

test("CRLF line endings", () => {
  fs.writeFileSync(fp, [turn(0, 1), user("a"), turn(1, 2), ""].join("\r\n"));
  check();
  fs.appendFileSync(fp, turn(2, 3) + "\r\n");
  expect(check()).toHaveLength(3);
});

test("a rewritten prefix forces a full re-parse", () => {
  fs.writeFileSync(fp, [turn(0, 1), turn(1, 2), ""].join("\n"));
  check();
  fs.writeFileSync(fp, [turn(0, 9), turn(1, 8), turn(2, 7), ""].join("\n"));
  expect(check().map((r) => r.read)).toEqual([9, 8, 7]);
});

test("a shrunk file forces a full re-parse", () => {
  fs.writeFileSync(fp, [turn(0, 1), turn(1, 2), turn(2, 3), ""].join("\n"));
  check();
  fs.writeFileSync(fp, turn(0, 4) + "\n");
  expect(check().map((r) => r.read)).toEqual([4]);
});

test("lines larger than the read chunk", () => {
  const big = user("z".repeat(9 * 1024 * 1024));
  fs.writeFileSync(fp, [turn(0, 1), big, turn(1, 2), ""].join("\n"));
  check();
  fs.appendFileSync(fp, [big, turn(2, 3), ""].join("\n"));
  expect(check()).toHaveLength(3);
});

// One API response, one line per content block: same message id on each line.
function block(min, id, output, read = 1000) {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date(T0 + min * 60000).toISOString(),
    message: {
      id,
      model: "claude-opus-5-5",
      content: [{ type: "text", text: "x" }],
      usage: { input_tokens: 2, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: 0 },
    },
  });
}
const compactMarker = (min, preTokens) =>
  JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    timestamp: new Date(T0 + min * 60000).toISOString(),
    compactMetadata: { trigger: "manual", preTokens, durationMs: 30000 },
  });

test("lines of one response count once", () => {
  fs.writeFileSync(fp, [block(0, "msg_a", 50), block(0, "msg_a", 50), block(0, "msg_a", 50), block(1, "msg_b", 9), ""].join("\n"));
  expect(check().map((r) => r.id)).toEqual(["msg_a", "msg_b"]);
});

test("a response's later line with a larger output count wins (field-wise max)", () => {
  fs.writeFileSync(fp, [block(0, "msg_a", 16), block(0, "msg_a", 16), block(0, "msg_a", 237), ""].join("\n"));
  const recs = check();
  expect(recs).toHaveLength(1);
  expect(recs[0].output).toBe(237);
});

test("a response split across an append grows without mutating the cached records", () => {
  fs.writeFileSync(fp, [block(0, "msg_a", 16), ""].join("\n"));
  const first = check();
  const before = first[0];
  fs.appendFileSync(fp, [block(0, "msg_a", 542), block(1, "msg_b", 7), ""].join("\n"));
  const recs = check();
  expect(recs.map((r) => [r.id, r.output])).toEqual([["msg_a", 542], ["msg_b", 7]]);
  expect(before.output).toBe(16); // the earlier result is untouched
});

test("a compaction marker tags the next response, also across an append", () => {
  fs.writeFileSync(fp, [block(0, "msg_a", 5), compactMarker(10, 450000), ""].join("\n"));
  check();
  fs.appendFileSync(fp, [block(11, "msg_b", 5), block(12, "msg_c", 5), ""].join("\n"));
  const recs = check();
  expect(recs.map((r) => (r.compact ? r.compact.preTokens : null))).toEqual([null, 450000, null]);
});

test("a message quoting the marker keys is not mistaken for one", () => {
  const quoting = JSON.stringify({ type: "user", message: { content: 'see "compact_boundary" and "cost-state"' } });
  fs.writeFileSync(fp, [quoting, block(0, "msg_a", 5), ""].join("\n"));
  const { recs, costState } = loadFile(sf());
  expect(recs[0].compact).toBeNull();
  expect(costState).toBeNull();
});

test("the latest nonzero cost-state snapshot is kept", () => {
  const cs = (usd) => JSON.stringify({ type: "cost-state", totalCostUSD: usd, hasUnknownModelCost: false, modelUsage: {} });
  fs.writeFileSync(fp, [cs(0), block(0, "msg_a", 5), cs(12.5), cs(0), ""].join("\n"));
  expect(loadFile(sf()).costState.totalCostUSD).toBe(12.5);
  fs.appendFileSync(fp, cs(20) + "\n");
  expect(loadFile(sf()).costState.totalCostUSD).toBe(20);
});

test("a vanished file returns no records", () => {
  fs.writeFileSync(fp, turn(0, 1) + "\n");
  const s = sf();
  loadSession(s);
  fs.rmSync(fp);
  expect(loadSession({ ...s, size: s.size + 1 })).toEqual([]);
});

// Cost counter tests: list-price math, machine-wide dedupe, day windows,
// calibration against Claude Code's tracker, and the append-only daily log.
// Run: bun test
import { test, expect, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { priceRecord, modelKey, reWarmPenaltyUsd } from "./prices.js";
import { cost, localDate, readLog } from "./cost.js";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cachey-cost-test-"));
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

const rec = (o) => ({ model: "claude-opus-5-5", input: 0, output: 0, read: 0, write: 0, w1h: 0, w5m: 0, ...o });
const close = (a, b) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

test("list price per component, per model", () => {
  close(priceRecord(rec({ input: 1e6 })).usd, 4);
  close(priceRecord(rec({ output: 1e6 })).usd, 20);
  close(priceRecord(rec({ read: 1e6 })).usd, 0.2);
  close(priceRecord(rec({ write: 1e6, w1h: 1e6 })).usd, 8);
  close(priceRecord(rec({ write: 1e6, w5m: 1e6 })).usd, 5);
  close(priceRecord(rec({ model: "claude-fable-5-1", read: 1e6 })).usd, 0.25);
});

test("cache writes without a TTL breakdown price at the 5-minute rate", () => {
  close(priceRecord(rec({ write: 1e6 })).usd, 5);
  close(priceRecord(rec({ write: 2e6, w1h: 1e6 })).usd, 8 + 5);
});

test("fast mode doubles, web searches add $0.01 each", () => {
  close(priceRecord(rec({ input: 1e6, fast: true })).usd, 8);
  close(priceRecord(rec({ webSearch: 14 })).usd, 0.14);
});

test("snapshot-dated and variant ids normalize; unknown models are flagged, never guessed", () => {
  expect(modelKey("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  expect(modelKey("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
  close(priceRecord(rec({ model: "claude-haiku-4-5-20251001", input: 1e6 })).usd, 1);
  expect(priceRecord(rec({ model: "claude-haiku-5-5", input: 1e6 }))).toEqual({ usd: 0, known: false, ignored: false });
  expect(priceRecord(rec({ model: "<synthetic>" })).ignored).toBe(true);
});

test("re-warm penalty is write minus read, at the tier actually used", () => {
  close(reWarmPenaltyUsd(rec({ write: 1e6, w1h: 1e6 })), 8 - 0.2);
  close(reWarmPenaltyUsd(rec({ write: 1e6, w5m: 1e6 })), 5 - 0.2);
  expect(reWarmPenaltyUsd(rec({ model: "claude-haiku-5-5", write: 1 }))).toBeNull();
});

// ---- cost() over a fixture projects tree ----
// "now" is Wednesday 2026-10-21, local noon. Week starts Monday 10-19.
const NOW = new Date(2026, 9, 21, 12).getTime();
const at = (d, h = 12) => new Date(2026, 9, d, h).toISOString();
function line(ts, id, model, usage) {
  return JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model, usage: { output_tokens: 0, ...usage } } });
}
const costState = (usd, unknown = false) =>
  JSON.stringify({ type: "cost-state", totalCostUSD: usd, hasUnknownModelCost: unknown, modelUsage: {} });

function fixture(name) {
  const root = path.join(DIR, name);
  const proj = path.join(root, "P--proj");
  fs.mkdirSync(path.join(proj, "s1", "subagents"), { recursive: true });
  // s1: response A today ($4 input + $2 output; its first line is a mid-stream snapshot).
  fs.writeFileSync(
    path.join(proj, "s1.jsonl"),
    [
      line(at(21), "msg_A", "claude-opus-5-5", { input_tokens: 1e6, output_tokens: 10 }),
      line(at(21), "msg_A", "claude-opus-5-5", { input_tokens: 1e6, output_tokens: 1e5 }),
      costState(7.7),
      "",
    ].join("\n"),
  );
  // s1's subagent: response B yesterday, $1.
  fs.writeFileSync(
    path.join(proj, "s1", "subagents", "agent-x.jsonl"),
    line(at(20), "msg_B", "claude-haiku-4-5-20251001", { input_tokens: 1e6 }) + "\n",
  );
  // s2: a fork that copied A, plus C last Sunday ($10) and an unpriced model today.
  fs.writeFileSync(
    path.join(proj, "s2.jsonl"),
    [
      line(at(21), "msg_A", "claude-opus-5-5", { input_tokens: 1e6, output_tokens: 1e5 }),
      line(at(18), "msg_C", "claude-sonnet-5-5", { output_tokens: 1e6 }),
      line(at(21), "msg_D", "claude-haiku-5-5", { input_tokens: 5 }),
      "",
    ].join("\n"),
  );
  return { root, proj, logPath: path.join(root, "cost-daily.jsonl") };
}

test("windows count each API call once machine-wide, including subagents", () => {
  const { root, logPath } = fixture("windows");
  const c = cost(NOW, { root, logPath, minSessions: 1 });
  close(c.windows.today.logged, 6); // A once, though two files and two lines hold it
  close(c.windows.week.logged, 7); // + B (Tue)
  close(c.windows.month.logged, 17); // + C (Sun 10-18)
  close(c.windows.all.logged, 17);
  expect(c.windows.week.from).toBe("2026-10-19");
  expect(c.windows.today.unpricedCalls).toBe(1);
  expect(c.unpriced).toEqual([{ model: "claude-haiku-5-5", calls: 1 }]);
});

test("calibration: tracker over transcript, only sessions the tracker fully covers", () => {
  const { root, logPath } = fixture("calib");
  let c = cost(NOW, { root, logPath, writeLog: false, minSessions: 1 });
  // s1 = A $6 + subagent B $1 = $7 against a $7.70 tracker; s2 has no tracker.
  close(c.calibration.factor, 1.1);
  expect(c.calibration.sessions).toBe(1);
  close(c.windows.today.estimate, 6.6);
  // Too few sessions: no factor, no estimate (never a made-up one).
  c = cost(NOW, { root, logPath, writeLog: false, minSessions: 5 });
  expect(c.calibration.factor).toBeNull();
  expect(c.windows.today.estimate).toBeNull();
});

test("calibration skips trackers that flag unknown models or cover less than the transcript", () => {
  const { root, proj, logPath } = fixture("calib-skip");
  const s1 = path.join(proj, "s1.jsonl");
  fs.appendFileSync(s1, costState(9, true) + "\n");
  expect(cost(NOW, { root, logPath, writeLog: false, minSessions: 1 }).calibration.sessions).toBe(0);
  fs.appendFileSync(s1, costState(3) + "\n"); // a restarted process: $3 < $7 of transcript
  expect(cost(NOW, { root, logPath, writeLog: false, minSessions: 1 }).calibration.sessions).toBe(0);
});

test("the log appends finished days once and keeps totals after transcripts are deleted", () => {
  const { root, proj, logPath } = fixture("log");
  let c = cost(NOW, { root, logPath, minSessions: 1 });
  expect(c.log.appended).toBe(2); // 10-18 and 10-20; today is not finished
  expect([...readLog(logPath).rows.keys()].sort()).toEqual(["2026-10-18", "2026-10-20"]);
  expect(cost(NOW, { root, logPath, minSessions: 1 }).log.appended).toBe(0);

  // Claude Code cleanup deletes yesterday's subagent transcript.
  fs.rmSync(path.join(proj, "s1", "subagents", "agent-x.jsonl"));
  c = cost(NOW, { root, logPath, minSessions: 1 });
  close(c.windows.week.logged, 7); // B's $1 now comes from the log
  expect(c.daily.find((d) => d.date === "2026-10-20").source).toBe("log");
  expect(fs.readFileSync(logPath, "utf8").trim().split("\n")).toHaveLength(2); // never rewritten
});

test("writeLog:false leaves no file behind", () => {
  const { root, logPath } = fixture("nolog");
  cost(NOW, { root, logPath, writeLog: false, minSessions: 1 });
  expect(fs.existsSync(logPath)).toBe(false);
});

test("localDate uses the local calendar", () => {
  expect(localDate(new Date(2026, 0, 1, 0, 5).getTime())).toBe("2026-01-01");
  expect(localDate(new Date(2025, 11, 31, 23, 55).getTime())).toBe("2025-12-31");
});

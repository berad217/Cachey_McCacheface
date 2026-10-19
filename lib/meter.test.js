// Parser tests for the /usage meter logger. Run: bun test
import { test, expect } from "bun:test";
import { parseUsage, parseReset, checkEnvelope, zonedToUtc } from "./meter.js";

// Captured live 2026-10-19 09:33 America/Toronto (EDT, UTC-4).
const LIVE = `You are currently using your subscription to power your Claude Code usage

Current session: 7% used · resets Oct 19, 1:19pm (America/Toronto)
Current week (all models): 60% used · resets Oct 20, 10:59am (America/Toronto)
Current week (Fable): 0% used · resets Oct 20, 11am (America/Toronto)

What's contributing to your limits usage?
Last 7d · 8166 requests · 45 sessions
  91% of your usage was at >150k context`;
const NOW = new Date("2026-10-19T13:33:00Z");

test("parses the live /usage output", () => {
  const u = parseUsage(LIVE, NOW);
  expect(u.session).toEqual({ pct: 7, resetsAt: "2026-10-19T17:19:00.000Z", resetRaw: "Oct 19, 1:19pm (America/Toronto)" });
  expect(u.week.pct).toBe(60);
  expect(u.week.resetsAt).toBe("2026-10-20T14:59:00.000Z");
  expect(Object.keys(u.scoped)).toEqual(["Fable"]);
  expect(u.scoped.Fable.pct).toBe(0);
});

test("accepts both H:MM and bare H reset formats", () => {
  // The same instant renders as "10:59am" or "11am" between calls.
  expect(parseReset("Oct 20, 10:59am", "America/Toronto", NOW)).toBe("2026-10-20T14:59:00.000Z");
  expect(parseReset("Oct 20, 11am", "America/Toronto", NOW)).toBe("2026-10-20T15:00:00.000Z");
  expect(parseReset("Oct 20, 12am", "America/Toronto", NOW)).toBe("2026-10-20T04:00:00.000Z");
  expect(parseReset("Oct 20, 12pm", "America/Toronto", NOW)).toBe("2026-10-20T16:00:00.000Z");
});

test("time-only reset means the next occurrence", () => {
  expect(parseReset("1:19pm", "America/Toronto", NOW)).toBe("2026-10-19T17:19:00.000Z");
  expect(parseReset("8am", "America/Toronto", NOW)).toBe("2026-10-20T12:00:00.000Z");
});

test("year rolls over for a January reset read in December", () => {
  const dec = new Date("2026-12-30T15:00:00Z");
  expect(parseReset("Jan 2, 3pm", "America/Toronto", dec)).toBe("2027-01-02T20:00:00.000Z");
});

test("DST-aware: same wall time, different offset across the November change", () => {
  expect(zonedToUtc(2026, 10, 2, 12, 0, "America/Toronto")).toBe(Date.parse("2026-11-02T17:00:00Z")); // EST
  expect(zonedToUtc(2026, 9, 30, 12, 0, "America/Toronto")).toBe(Date.parse("2026-10-30T16:00:00Z")); // EDT
});

test("unparseable reset keeps the percentage, nulls the instant", () => {
  const u = parseUsage("Current session: 7% used · resets soon (America/Toronto)\nCurrent week (all models): 60% used", NOW);
  expect(u.session.pct).toBe(7);
  expect(u.session.resetsAt).toBeNull();
  expect(u.week.resetRaw).toBeNull();
});

test("bad time zone does not throw", () => {
  expect(parseReset("Oct 20, 11am", "Mars/Olympus_Mons", NOW)).toBeNull();
});

test("unknown output shape fails loudly", () => {
  expect(() => parseUsage("Usage is currently unavailable.", NOW)).toThrow(/missing session/);
  expect(() => parseUsage("Current session: 7% used · resets Oct 19, 1:19pm (America/Toronto)", NOW)).toThrow(/missing weekly/);
});

test("auth-expired envelope is an auth error, not billed", () => {
  // Captured live 2026-10-19 before `claude /login`.
  const env = {
    is_error: true, total_cost_usd: 0, duration_api_ms: 0, num_turns: 1,
    usage: { input_tokens: 0, output_tokens: 0 },
    result: "Failed to authenticate: OAuth session expired and could not be refreshed",
  };
  expect(checkEnvelope(env)).toEqual({ billed: false, error: "auth" });
});

test("a billed call trips the tripwire", () => {
  // Shape of the Git Bash accident: "/usage" mangled into a model prompt.
  const env = {
    is_error: false, total_cost_usd: 0.2024818, duration_api_ms: 4884,
    usage: { input_tokens: 2, output_tokens: 310 }, result: "That input is `/usage` mangled by Git Bash...",
  };
  expect(checkEnvelope(env).billed).toBe(true);
});

test("a clean zero-cost envelope passes", () => {
  const env = { is_error: false, total_cost_usd: 0, duration_api_ms: 0, usage: { input_tokens: 0, output_tokens: 0 }, result: LIVE };
  expect(checkEnvelope(env)).toEqual({ billed: false, error: null });
});

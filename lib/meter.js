// Cachey_McCacheface - /usage meter logger (v1.1)
// Reads the account-wide usage meter through headless Claude Code
//   claude -p --no-session-persistence --output-format json "/usage"
// which is answered client-side at zero token cost, parses the prose, and
// appends one reading per run to data/meter.jsonl. Record + display only:
// no calibration against token cost (that is v2 - see spec.md).
//
// Cachey itself opens no sockets; the spawned `claude` process talks to
// Anthropic to fetch the meter. Run: bun run meter

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));
export const LOG_PATH = path.join(DATA_DIR, "meter.jsonl");
// Written when a /usage call shows any sign of being billed. Polling stays
// off until a human deletes it - a misfiring hourly job must not keep spending.
export const DISABLED_PATH = path.join(DATA_DIR, "meter.disabled");

const TIMEOUT_MS = 60000;
const TAIL_BYTES = 64 * 1024;
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const DAY_MS = 86400000;

/**
 * Resolve the claude executable without trusting PATH. Scheduler/Explorer
 * environments can carry a stale PATH (see DEVLOG 2026-07-23), so prefer
 * CACHEY_CLAUDE, then the native installer's location, then PATH lookup.
 * @returns {string}
 */
export function resolveClaude() {
  if (process.env.CACHEY_CLAUDE) return process.env.CACHEY_CLAUDE;
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const native = path.join(os.homedir(), ".local", "bin", exe);
  return fs.existsSync(native) ? native : "claude";
}

/**
 * Offset of an IANA time zone from UTC at a given instant.
 * @param {string} tz IANA zone name, e.g. "America/Toronto".
 * @param {number} utcMs Instant to evaluate (DST-aware).
 * @returns {number} Offset in ms (zone wall time minus UTC).
 * @throws {RangeError} If tz is not a valid IANA zone.
 */
function tzOffsetMs(tz, utcMs) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Convert a wall-clock time in an IANA zone to a UTC instant.
 * @param {number} y Year.
 * @param {number} mo Month, 0-based.
 * @param {number} d Day of month.
 * @param {number} h Hour, 0-23.
 * @param {number} mi Minute.
 * @param {string} tz IANA zone name.
 * @returns {number} UTC ms.
 */
export function zonedToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo, d, h, mi);
  // Two passes so a guess that lands across a DST edge settles on the right offset.
  const first = guess - tzOffsetMs(tz, guess);
  return guess - tzOffsetMs(tz, first);
}

/**
 * Parse a /usage reset string into an ISO instant. The CLI omits the year,
 * and omits minutes on the hour ("11am" vs "10:59am" - the same instant can
 * render either way between calls), so both forms are accepted.
 * @param {string} s Reset text, e.g. "Oct 20, 10:59am" or "11am".
 * @param {string} tz IANA zone the CLI printed alongside it.
 * @param {Date} now Reference time used to infer the year / day.
 * @returns {string|null} ISO timestamp, or null if unrecognised.
 */
export function parseReset(s, tz, now) {
  const m = /^(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(String(s).trim());
  if (!m) return null;
  let hour = +m[3] % 12;
  if (m[5].toLowerCase() === "pm") hour += 12;
  const minute = m[4] ? +m[4] : 0;
  try {
    const nowMs = now.getTime();
    const local = new Date(nowMs + tzOffsetMs(tz, nowMs)); // wall clock in tz, read via UTC getters
    if (m[1]) {
      const mo = MONTHS[m[1].toLowerCase()];
      if (mo === undefined) return null;
      let y = local.getUTCFullYear();
      let t = zonedToUtc(y, mo, +m[2], hour, minute, tz);
      // Resets are always in the near future; a date well behind us means the
      // year rolled over (a Dec reading of a Jan reset).
      if (t < nowMs - 2 * DAY_MS) t = zonedToUtc(++y, mo, +m[2], hour, minute, tz);
      return new Date(t).toISOString();
    }
    // Time only: the next occurrence of that wall time.
    let t = zonedToUtc(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute, tz);
    if (t < nowMs) t += DAY_MS;
    return new Date(t).toISOString();
  } catch {
    return null; // unknown time zone
  }
}

/**
 * Parse the prose that /usage returns in the JSON envelope's `.result`.
 * @param {string} text The `.result` string.
 * @param {Date} [now] Reference time for year inference.
 * @returns {{session: object, week: object, scoped: Object<string, object>}}
 *   Each limit is {pct, resetsAt, resetRaw}; `scoped` holds per-model weeklies.
 * @throws {Error} If the session or all-models weekly line is missing - prose
 *   is not a contract, so an unrecognised shape must fail loudly.
 */
export function parseUsage(text, now = new Date()) {
  const out = { session: null, week: null, scoped: {} };
  const re = /^Current (session|week \(([^)]+)\)):\s*(\d+(?:\.\d+)?)% used(?:\s*\S\s*resets\s+(.+?)\s*\(([^)]+)\))?\s*$/gm;
  for (const m of String(text).matchAll(re)) {
    const limit = {
      pct: Number(m[3]),
      resetsAt: m[4] ? parseReset(m[4], m[5], now) : null,
      resetRaw: m[4] ? m[4] + " (" + m[5] + ")" : null,
    };
    if (m[1] === "session") out.session = limit;
    else if (m[2] === "all models") out.week = limit;
    else out.scoped[m[2]] = limit;
  }
  if (!out.session || !out.week) {
    throw new Error("unrecognised /usage output: missing " + (!out.session ? "session" : "weekly") + " line");
  }
  return out;
}

/**
 * Inspect the CLI's JSON envelope for errors and for any sign the call was
 * billed. /usage should never reach the model; if it did (e.g. a shell
 * rewrote "/usage" into a path), every hourly run would spend real quota.
 * @param {object} env Parsed `--output-format json` envelope.
 * @returns {{billed: boolean, error: string|null}} error is "auth",
 *   "cli_error", or null.
 */
export function checkEnvelope(env) {
  const u = (env && env.usage) || {};
  const billed =
    (env.total_cost_usd || 0) > 0 ||
    (env.duration_api_ms || 0) > 0 ||
    (u.input_tokens || 0) > 0 ||
    (u.output_tokens || 0) > 0;
  let error = null;
  if (env.is_error) error = /authenticat|oauth|log ?in/i.test(String(env.result)) ? "auth" : "cli_error";
  return { billed, error };
}

/**
 * Run headless /usage once.
 * @param {string} [claude] Executable path.
 * @returns {Promise<{envelope: object|null, stdout: string, stderr: string, exitCode: number|null, timedOut: boolean, ms: number}>}
 */
export async function runUsage(claude = resolveClaude()) {
  const t0 = Date.now();
  // argv array, no shell: nothing can MSYS-convert "/usage" into a path and
  // turn it into a billed prompt. --strict-mcp-config with no --mcp-config
  // starts zero MCP servers. cwd=tmpdir keeps project CLAUDE.md/settings out.
  const proc = Bun.spawn(
    [claude, "-p", "--no-session-persistence", "--strict-mcp-config", "--output-format", "json", "/usage"],
    { cwd: os.tmpdir(), stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true }
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  let envelope = null;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    // not JSON: spawn failure or CLI crash; caller logs stdout/stderr
  }
  return { envelope, stdout, stderr, exitCode, timedOut, ms: Date.now() - t0 };
}

/**
 * Append one row to the meter log, creating data/ if needed.
 * @param {object} row
 * @throws {Error} On write failure (disk full, permissions).
 */
function appendRow(row) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(LOG_PATH, JSON.stringify(row) + "\n");
}

/**
 * Take one meter reading and append it to the log. Failures are logged as
 * rows too, so gaps in the series always have an explanation.
 * @param {Date} [now]
 * @returns {Promise<object>} The row appended: {ts, ok:true, session, week,
 *   scoped, raw, cliMs} or {ts, ok:false, error, detail, raw?}.
 */
export async function recordReading(now = new Date()) {
  const ts = now.toISOString();
  let row;
  if (fs.existsSync(DISABLED_PATH)) {
    row = { ts, ok: false, error: "disabled", detail: "delete " + DISABLED_PATH + " to resume" };
    appendRow(row);
    return row;
  }
  let r;
  try {
    r = await runUsage();
  } catch (e) {
    row = { ts, ok: false, error: "spawn", detail: String((e && e.message) || e) };
    appendRow(row);
    return row;
  }
  const env = r.envelope;
  if (r.timedOut) {
    row = { ts, ok: false, error: "timeout", detail: "no answer in " + TIMEOUT_MS / 1000 + "s" };
  } else if (!env) {
    row = { ts, ok: false, error: "spawn", detail: ("exit " + r.exitCode + ": " + (r.stderr || r.stdout)).slice(0, 500) };
  } else {
    const chk = checkEnvelope(env);
    if (chk.billed) {
      row = { ts, ok: false, error: "billed", detail: "cost $" + env.total_cost_usd + ", api " + env.duration_api_ms + "ms - polling disabled", raw: env.result };
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DISABLED_PATH, ts + " " + row.detail + "\n");
    } else if (chk.error) {
      row = { ts, ok: false, error: chk.error, detail: String(env.result).slice(0, 300), raw: env.result };
    } else {
      try {
        row = { ts, ok: true, ...parseUsage(env.result, now), raw: env.result, cliMs: r.ms };
      } catch (e) {
        row = { ts, ok: false, error: "parse", detail: e.message, raw: env.result };
      }
    }
  }
  appendRow(row);
  return row;
}

/**
 * Latest rows from the meter log, reading only the file's tail.
 * @param {string} [logPath]
 * @returns {{last: object|null, lastOk: object|null, disabled: boolean}}
 */
export function readLatest(logPath = LOG_PATH) {
  const disabled = fs.existsSync(DISABLED_PATH);
  let text = "";
  try {
    const fd = fs.openSync(logPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { last: null, lastOk: null, disabled }; // no log yet
  }
  let last = null, lastOk = null;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && !lastOk; i--) {
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      continue; // blank, or a line cut by the tail window
    }
    if (!last) last = row;
    if (row.ok) lastOk = row;
  }
  return { last, lastOk, disabled };
}

// One reading when run directly: `bun run meter`.
// Exit 0 = ok, 1 = failed reading (logged), 2 = billed (polling now disabled).
if (import.meta.main) {
  try {
    const row = await recordReading();
    if (row.ok) {
      const fmt = (l) => l.pct + "%" + (l.resetsAt ? " (resets " + l.resetsAt.slice(0, 16).replace("T", " ") + "Z)" : "");
      const scoped = Object.entries(row.scoped).map(([k, l]) => ", " + k + " " + fmt(l)).join("");
      console.log("[OK] meter: session " + fmt(row.session) + ", week " + fmt(row.week) + scoped + " in " + row.cliMs + "ms");
      process.exit(0);
    }
    // detail can echo CLI prose; keep the console ASCII-only.
    console.log("[" + (row.error === "billed" ? "ALARM" : "FAIL") + "] meter " + row.error + ": " + String(row.detail).replace(/[^\x20-\x7e]/g, "?"));
    process.exit(row.error === "billed" ? 2 : 1);
  } catch (e) {
    console.log("[FAIL] meter: could not write " + LOG_PATH + ": " + ((e && e.message) || e));
    process.exit(1);
  }
}

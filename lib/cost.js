// Cachey_McCacheface - API-equivalent cost counter.
// Prices every API call in this machine's Claude Code transcripts - top-level
// sessions AND their subagents - at list rates (lib/prices.js), buckets by
// local day, and appends finished days to a log so totals outlive transcript
// cleanup (Claude Code deletes old transcripts).
//
// Two numbers, labeled as what they are:
//  - logged:   calls written to transcripts. Exact for those calls.
//  - estimate: logged x a factor measured against Claude Code's own cost
//              tracker (`cost-state` lines), which also counts calls that never
//              reach a transcript. Logged ran ~9% low against it (2026-10-20).
// API dollars, not plan quota.
//
// No network, no deps. Reads transcripts; writes only data/cost-daily.jsonl.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECTS_DIR, isSubagentPath, loadRecords, drain, drainAsync, evictMissing } from "./scan.js";
import { priceRecord, modelKey, PRICES_AS_OF } from "./prices.js";

export const COST_LOG = fileURLToPath(new URL("../data/cost-daily.jsonl", import.meta.url));

// A tracker snapshot below this share of the session's transcript cost does not
// cover the whole session (it restarts with the process), so it can't calibrate.
const COMPARABLE_FLOOR = 0.97;
const CALIBRATION_MIN_SESSIONS = 5;
const DAILY_DAYS = 35; // days returned for the dashboard chart

/**
 * List every transcript: top-level sessions (<project>/<session>.jsonl) and
 * subagent transcripts (<project>/<session>/subagents/*.jsonl).
 * @param {string} root projects directory
 * @returns {{path:string, mtimeMs:number, size:number, project:string, session:string, sub:boolean}[]}
 */
export function listAllFiles(root = PROJECTS_DIR) {
  const out = [];
  const add = (fp, project, session, sub) => {
    try {
      const st = fs.statSync(fp);
      out.push({ path: fp, mtimeMs: st.mtimeMs, size: st.size, project, session, sub });
    } catch {
      // vanished between readdir and stat
    }
  };
  let projects;
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const pd of projects) {
    if (!pd.isDirectory()) continue;
    const pdir = path.join(root, pd.name);
    let entries;
    try {
      entries = fs.readdirSync(pdir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isFile() && ent.name.endsWith(".jsonl")) {
        add(path.join(pdir, ent.name), pd.name, ent.name.slice(0, -6), false);
      } else if (ent.isDirectory()) {
        const sdir = path.join(pdir, ent.name, "subagents");
        let subs;
        try {
          subs = fs.readdirSync(sdir);
        } catch {
          continue; // no subagents for this session
        }
        for (const f of subs) if (f.endsWith(".jsonl")) add(path.join(sdir, f), pd.name, ent.name, true);
      }
    }
  }
  return out;
}

/**
 * Local calendar date of an instant, YYYY-MM-DD.
 * @param {number} t epoch ms
 * @returns {string}
 */
export function localDate(t) {
  const d = new Date(t);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/**
 * Read the daily log. Malformed lines are skipped; a date logged twice (two
 * writers racing) keeps the larger total.
 * @param {string} logPath
 * @returns {{rows: Map<string, object>, error: string|null}}
 */
export function readLog(logPath) {
  const rows = new Map();
  let raw;
  try {
    raw = fs.readFileSync(logPath, "utf8");
  } catch (e) {
    return { rows, error: e && e.code === "ENOENT" ? null : String(e && e.message ? e.message : e) };
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o.date !== "string" || typeof o.usd !== "number") continue;
    const prev = rows.get(o.date);
    if (!prev || o.usd > prev.usd) rows.set(o.date, o);
  }
  return { rows, error: null };
}

function round(n, places = 4) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function newDay() {
  return { usd: 0, calls: 0, unpricedCalls: 0, byModel: {} };
}

function addToDay(D, r, pr) {
  const m = modelKey(r.model);
  const M =
    D.byModel[m] ||
    (D.byModel[m] = { usd: 0, calls: 0, input: 0, output: 0, read: 0, w5m: 0, w1h: 0, priced: pr.known });
  M.calls++;
  M.input += r.input;
  M.output += r.output;
  M.read += r.read;
  M.w1h += r.w1h;
  M.w5m += r.w5m + Math.max(0, r.write - r.w1h - r.w5m); // unsplit writes price at 5m
  D.calls++;
  if (pr.known) {
    M.usd += pr.usd;
    D.usd += pr.usd;
  } else {
    D.unpricedCalls++;
  }
}

/**
 * Compute the cost summary. Sync.
 * @param {number} now epoch ms (injectable for tests)
 * @param {{root?:string, logPath?:string, writeLog?:boolean, minSessions?:number}} opts
 * @returns {object} cost summary
 */
export function cost(now = Date.now(), opts = {}) {
  return drain(costSteps(now, opts));
}

/**
 * Same as cost(), yielding to the event loop while it works.
 * @param {number} now epoch ms
 * @param {object} opts see cost()
 * @returns {Promise<object>} cost summary
 */
export function costAsync(now = Date.now(), opts = {}) {
  return drainAsync(costSteps(now, opts));
}

function* costSteps(now, opts) {
  const root = opts.root || PROJECTS_DIR;
  const logPath = opts.logPath || COST_LOG;
  const writeLog = opts.writeLog !== false;
  const minSessions = opts.minSessions || CALIBRATION_MIN_SESSIONS;

  const files = listAllFiles(root);
  // analyze() owns (and evicts) top-level session entries; this owns subagents.
  evictMissing(new Set(files.map((f) => f.path)), isSubagentPath);

  const globalSeen = new Set();
  const days = new Map();
  const sessions = new Map();
  for (const f of files) {
    const { recs, costState } = yield* loadRecords(f);
    const sk = f.project + "/" + f.session;
    let S = sessions.get(sk);
    if (!S) sessions.set(sk, (S = { usd: 0, unpriced: 0, seen: new Set(), costState: null }));
    if (!f.sub && costState) S.costState = costState;
    for (const r of recs) {
      const pr = priceRecord(r);
      if (pr.ignored) continue;
      // Calibration: one session (top-level + its subagents) against its own
      // tracker, so dedupe within the session.
      if (!r.id || !S.seen.has(r.id)) {
        if (r.id) S.seen.add(r.id);
        if (pr.known) S.usd += pr.usd;
        else S.unpriced++;
      }
      // Counter: each API call once, machine-wide. Resumed and forked sessions
      // copy earlier history (same message ids) into new files.
      if (r.id) {
        if (globalSeen.has(r.id)) continue;
        globalSeen.add(r.id);
      }
      const date = localDate(r.t);
      let D = days.get(date);
      if (!D) days.set(date, (D = newDay()));
      addToDay(D, r, pr);
    }
  }

  // Calibration factor: Claude Code's tracker vs our transcript pricing, over
  // sessions where the tracker demonstrably covers the whole session.
  let trackerUsd = 0;
  let transcriptUsd = 0;
  let n = 0;
  for (const S of sessions.values()) {
    const cs = S.costState;
    if (!cs || cs.hasUnknownModelCost || S.unpriced || S.usd <= 0) continue;
    if (cs.totalCostUSD < COMPARABLE_FLOOR * S.usd) continue;
    trackerUsd += cs.totalCostUSD;
    transcriptUsd += S.usd;
    n++;
  }
  const factor = n >= minSessions && transcriptUsd > 0 ? trackerUsd / transcriptUsd : null;

  // Daily log: append each finished day not yet logged. Never rewrites a row.
  const today = localDate(now);
  const { rows: logRows, error: readError } = readLog(logPath);
  const toAppend = [];
  for (const [date, D] of [...days].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (date >= today || logRows.has(date)) continue;
    const byModel = {};
    for (const [m, M] of Object.entries(D.byModel)) byModel[m] = { ...M, usd: round(M.usd) };
    const row = {
      date,
      usd: round(D.usd),
      calls: D.calls,
      unpricedCalls: D.unpricedCalls,
      byModel,
      pricesAsOf: PRICES_AS_OF,
      writtenAt: new Date(now).toISOString(),
    };
    toAppend.push(row);
    logRows.set(date, row);
  }
  let logError = readError;
  if (writeLog && toAppend.length) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, toAppend.map((r) => JSON.stringify(r)).join("\n") + "\n");
    } catch (e) {
      logError = String(e && e.message ? e.message : e);
    }
  }

  // Per day, the larger of live and logged: live wins while transcripts exist
  // (and can only grow); the log wins once cleanup has deleted them. Half a
  // cent of slack, since logged totals are rounded.
  const merged = new Map();
  for (const date of new Set([...days.keys(), ...logRows.keys()])) {
    const live = days.get(date);
    const row = logRows.get(date);
    const useLive = live && (!row || live.usd >= row.usd - 0.005);
    const src = useLive ? live : row;
    merged.set(date, {
      usd: src.usd,
      calls: src.calls || 0,
      unpricedCalls: src.unpricedCalls || 0,
      byModel: src.byModel || {},
      source: useLive ? "live" : "log",
    });
  }
  const dates = [...merged.keys()].sort();
  const from = dates[0] || today;

  const d = new Date(now);
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  const weekStart = localDate(monday.getTime());
  const monthStart = today.slice(0, 8) + "01";

  const windowSum = (start) => {
    let usd = 0;
    let calls = 0;
    let unpricedCalls = 0;
    for (const date of dates) {
      if (date < start || date > today) continue;
      const m = merged.get(date);
      usd += m.usd;
      calls += m.calls;
      unpricedCalls += m.unpricedCalls;
    }
    return { from: start, logged: usd, estimate: factor === null ? null : usd * factor, calls, unpricedCalls };
  };

  const modelTotals = (start) => {
    const acc = {};
    for (const date of dates) {
      if (date < start || date > today) continue;
      for (const [m, M] of Object.entries(merged.get(date).byModel)) {
        const a = acc[m] || (acc[m] = { model: m, usd: 0, calls: 0, priced: M.priced !== false });
        a.usd += M.usd || 0;
        a.calls += M.calls || 0;
      }
    }
    return Object.values(acc).sort((a, b) => b.usd - a.usd || b.calls - a.calls);
  };

  const allModels = modelTotals(from);
  const unpriced = allModels.filter((m) => !m.priced).map((m) => ({ model: m.model, calls: m.calls }));
  const firstLive = [...days.keys()].sort()[0] || null;

  return {
    generatedAt: now,
    pricesAsOf: PRICES_AS_OF,
    windows: {
      today: windowSum(today),
      week: windowSum(weekStart),
      month: windowSum(monthStart),
      all: windowSum(from),
    },
    byModel: { month: modelTotals(monthStart), all: allModels },
    unpriced,
    calibration: { factor, sessions: n, minSessions, trackerUsd, transcriptUsd },
    daily: dates.slice(-DAILY_DAYS).map((date) => ({ date, usd: merged.get(date).usd, source: merged.get(date).source })),
    log: { path: logPath, days: logRows.size, appended: writeLog ? toAppend.length : 0, error: logError },
    coverage: {
      files: files.length,
      subagentFiles: files.filter((f) => f.sub).length,
      liveFrom: firstLive,
      loggedOnlyDays: dates.filter((x) => merged.get(x).source === "log" && !days.has(x)).length,
    },
  };
}

// ASCII report when run directly: `bun run cost`
if (import.meta.main) {
  const c = cost();
  const usd = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
  console.log("=== Cachey cost: API-equivalent, list prices as of " + c.pricesAsOf + " ===");
  const w = c.windows;
  for (const [label, x] of [["today", w.today], ["this week", w.week], ["this month", w.month], ["since " + w.all.from, w.all]]) {
    const est = x.estimate === null ? "" : "   est " + usd(x.estimate);
    console.log(pad(label, 18) + pad(usd(x.logged), 14) + est);
  }
  const k = c.calibration;
  console.log(
    k.factor === null
      ? "calibration: not enough sessions with a full tracker snapshot (" + k.sessions + " < " + k.minSessions + ")"
      : "calibration: x" + k.factor.toFixed(3) + " from " + k.sessions + " sessions (tracker " + usd(k.trackerUsd) + " vs transcripts " + usd(k.transcriptUsd) + ")",
  );
  console.log("unpriced models: " + (c.unpriced.length ? c.unpriced.map((u) => u.model + " (" + u.calls + " calls)").join(", ") : "none"));
  console.log("log: " + c.log.path + " - " + c.log.days + " days, +" + c.log.appended + " appended" + (c.log.error ? " - ERROR: " + c.log.error : ""));
}

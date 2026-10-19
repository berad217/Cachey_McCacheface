// Cachey_McCacheface - cache analysis engine
// Reads Claude Code session transcripts (~/.claude/projects/**/*.jsonl) and
// derives cache-warmth metrics: tier (1h vs 5m), warm hit ratio, and how much
// quota is burned re-warming context after you step away.
//
// No network, no deps. Pure read of local transcripts.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

// Cache tier TTLs (minutes). Refresh-on-use: the timer resets each time the
// cached prefix is read, so "minutes since last activity" is what matters.
const TTL_1H_MIN = 60;
const TTL_5M_MIN = 5;

// A re-warm is detected when a previously-large warm prefix collapses and a
// large block is re-written. Gating on the preceding time gap separates the
// two causes: a gap beyond the *applicable* TTL = you stepped away
// (avoidable); a shorter gap = the tool compacted or bulk-loaded context (not
// your reply timing). The applicable TTL is per-session and tracks whichever
// tier the most recent write used - it is NOT a flat 60 minutes, since a
// thread on the 5-minute tier has a 5-minute window, not a 1-hour one.
const REWARM_WRITE_MIN = 10000; // a "large" rebuild write
const PREV_READ_MIN = 20000; // there was a meaningful warm prefix to lose

// Token cost weights, relative to one fresh input token.
const W_READ = 0.1; // cache read
const W_WRITE_1H = 2.0; // cache write, 1-hour tier
const RECENT_WINDOW_MS = 48 * 3600 * 1000; // window for the tier-downgrade alarm

/**
 * List top-level session transcripts (one per interactive session). Subagent
 * and workflow transcripts live in subdirectories and are intentionally
 * excluded - they are spawned within a turn and don't reflect your own pacing.
 * @returns {{project: string, file: string, path: string, mtimeMs: number, size: number}[]}
 */
export function listSessionFiles() {
  const out = [];
  let projects;
  try {
    projects = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return out;
  }
  for (const proj of projects) {
    const pdir = path.join(PROJECTS_DIR, proj);
    let st;
    try {
      st = fs.statSync(pdir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    let files;
    try {
      files = fs.readdirSync(pdir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = path.join(pdir, f);
      try {
        const fst = fs.statSync(fp);
        out.push({ project: proj, file: f, path: fp, mtimeMs: fst.mtimeMs, size: fst.size });
      } catch {
        // file vanished between readdir and stat; skip
      }
    }
  }
  return out;
}

/**
 * Parse one transcript into time-ordered usage records.
 * @param {string} fp absolute path to a .jsonl transcript
 * @returns {{t:number,model:string,read:number,write:number,input:number,output:number,w1h:number,w5m:number,speed:string}[]}
 */
export function parseSession(fp) {
  let raw;
  try {
    raw = fs.readFileSync(fp, "utf8");
  } catch {
    return [];
  }
  const recs = [];
  for (const line of raw.split(/\r?\n/)) parseLine(line, recs);
  recs.sort((a, b) => a.t - b.t);
  return recs;
}

/**
 * Parse one transcript line, appending a usage record to `recs` if it has one.
 * @param {string} line one JSONL line (no terminator)
 * @param {object[]} recs output array
 */
function parseLine(line, recs) {
  if (!line) return;
  // Only assistant turns carry usage. Skipping lines without the key avoids
  // JSON.parse on the (often huge) tool-result and user lines; serialized JSON
  // writes keys literally, so this never drops a record.
  if (!line.includes('"output_tokens"')) return;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  const u = o && o.message && o.message.usage;
  if (!u || typeof u.output_tokens !== "number") return;
  const t = Date.parse(o.timestamp);
  if (Number.isNaN(t)) return;
  const cc = u.cache_creation || {};
  recs.push({
    t,
    model: o.message.model || "",
    read: u.cache_read_input_tokens || 0,
    write: u.cache_creation_input_tokens || 0,
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    w1h: cc.ephemeral_1h_input_tokens || 0,
    w5m: cc.ephemeral_5m_input_tokens || 0,
    speed: u.speed || u.service_tier || "",
  });
}

// Per-file parse cache, in memory for the life of the process:
// path -> { mtimeMs, size, offset, sig, recs }. `offset` is the byte position
// up to which the file has been consumed (always a line boundary); `sig` is the
// last SIG_BYTES bytes before it, used to confirm the file was only appended to.
const fileCache = new Map();
const CHUNK_BYTES = 8 * 1024 * 1024;
const SIG_BYTES = 256;
// Shared read buffer. Safe across interleaved scans: loadRecords copies what
// it keeps out of it before every yield.
const chunk = Buffer.alloc(CHUNK_BYTES);

function readSig(fd, offset) {
  const len = Math.min(SIG_BYTES, offset);
  const buf = Buffer.alloc(len);
  const n = len ? fs.readSync(fd, buf, 0, len, offset - len) : 0;
  return n === len ? buf : null;
}

/**
 * Bring one file's usage records up to date, re-reading only what changed.
 * Unchanged (same mtimeMs + size) -> cached records. Grown with an intact
 * prefix (transcripts are append-only) -> parse just the new bytes. Anything
 * else -> parse from byte 0. Returns the same records, in the same order, as
 * parseSession() on the file's current contents. Generator: yields between
 * chunks so an async driver can keep the event loop responsive.
 * @param {{path: string, mtimeMs: number, size: number}} sf from listSessionFiles()
 * @returns {Generator<void, object[]>} time-ordered usage records
 */
function* loadRecords(sf) {
  let e = fileCache.get(sf.path);
  if (e && e.mtimeMs === sf.mtimeMs && e.size === sf.size) return e.recs;
  let fd;
  try {
    fd = fs.openSync(sf.path, "r");
  } catch {
    fileCache.delete(sf.path);
    return [];
  }
  try {
    const appendOnly = e && sf.size >= e.offset && (() => {
      const sig = readSig(fd, e.offset);
      return sig !== null && sig.equals(e.sig);
    })();
    if (!appendOnly) e = { mtimeMs: 0, size: 0, offset: 0, sig: Buffer.alloc(0), recs: [] };

    const fresh = [];
    let pos = e.offset; // byte position of the start of `carry`
    let carry = Buffer.alloc(0);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, CHUNK_BYTES, pos + carry.length);
      if (n === 0) break;
      const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      const nl = buf.lastIndexOf(0x0a);
      if (nl < 0) {
        carry = Buffer.from(buf);
      } else {
        // Split on a byte-level newline, so no UTF-8 sequence is ever cut.
        for (const line of buf.toString("utf8", 0, nl + 1).split(/\r?\n/)) parseLine(line, fresh);
        pos += nl + 1;
        carry = Buffer.from(buf.subarray(nl + 1));
      }
      yield;
    }
    // Unterminated tail: the line being written right now, or a final line with
    // no newline. Take it only if it is complete JSON (a full read would parse
    // it); otherwise leave it unconsumed and re-read it next time. The check is
    // JSON validity, not parseLine's key filter: a half-written assistant line
    // may not have reached "output_tokens" yet.
    if (carry.length) {
      const tail = carry.toString("utf8").replace(/\r$/, "");
      let complete = true;
      try {
        JSON.parse(tail);
      } catch {
        complete = false;
      }
      if (complete) {
        parseLine(tail, fresh);
        pos += carry.length;
      }
    }

    let recs = e.recs;
    if (fresh.length) {
      // Stable sort of (already-sorted old ++ new) == stable sort of the whole
      // file in line order, so this matches parseSession() exactly.
      recs = recs.concat(fresh);
      recs.sort((a, b) => a.t - b.t);
    }
    fileCache.set(sf.path, { mtimeMs: sf.mtimeMs, size: sf.size, offset: pos, sig: readSig(fd, pos) || Buffer.alloc(0), recs });
    return recs;
  } catch {
    fileCache.delete(sf.path);
    return [];
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Cache-aware parseSession(): same records, re-reading only what changed.
 * @param {{path: string, mtimeMs: number, size: number}} sf from listSessionFiles()
 * @returns {object[]} time-ordered usage records
 */
export function loadSession(sf) {
  return drain(loadRecords(sf));
}

// Run a generator to completion synchronously.
function drain(gen) {
  let r;
  while (!(r = gen.next()).done);
  return r.value;
}

// Run a generator to completion, handing the event loop back every YIELD_MS of
// work so a slow (cold) scan never starves other requests.
const YIELD_MS = 20;
async function drainAsync(gen) {
  let t0 = performance.now();
  let r;
  while (!(r = gen.next()).done) {
    if (performance.now() - t0 > YIELD_MS) {
      await new Promise((res) => setTimeout(res, 0));
      t0 = performance.now();
    }
  }
  return r.value;
}

function cleanName(proj) {
  return proj
    .replace(/^[A-Za-z]--/, "")
    .replace(/^software-projects-/i, "")
    .replace(/^tools-/i, "");
}

/**
 * Analyze all sessions and return the full dashboard summary. Synchronous;
 * re-parses only transcripts that changed since the last call in this process.
 * @param {number} now epoch ms (injectable for tests)
 */
export function analyze(now = Date.now()) {
  return drain(analyzeSteps(now));
}

/**
 * Same result as analyze(), but yields to the event loop while it works, so a
 * cold scan in the server never blocks other requests.
 * @param {number} now epoch ms
 * @returns {Promise<object>} the dashboard summary
 */
export function analyzeAsync(now = Date.now()) {
  return drainAsync(analyzeSteps(now));
}

function* analyzeSteps(now) {
  const files = listSessionFiles();
  const seen = new Set(files.map((sf) => sf.path));
  for (const p of fileCache.keys()) if (!seen.has(p)) fileCache.delete(p);
  const projects = {};
  const g = {
    sessions: 0,
    turns: 0,
    read: 0,
    write: 0,
    input: 0,
    output: 0,
    w1h: 0,
    w5m: 0,
    coldStarts: 0,
    idleReWarms: 0,
    idleReWarmTokens: 0,
    toolReWarms: 0,
    toolReWarmTokens: 0,
    fastModeTurns: 0,
    recent1h: 0,
    recent5m: 0,
    gapBuckets: { "1-3h": 0, "3-12h": 0, ">12h": 0 },
  };

  let active = null;
  const sessionsSummary = [];
  const subTtlMisses = [];

  for (const sf of files) {
    const recs = yield* loadRecords(sf);
    if (!recs.length) continue;

    const P =
      projects[sf.project] ||
      (projects[sf.project] = {
        name: sf.project,
        sessions: 0,
        turns: 0,
        read: 0,
        write: 0,
        reWarmTokens: 0,
        idleReWarms: 0,
        w1h: 0,
        w5m: 0,
      });
    P.sessions++;
    g.sessions++;

    let prevRead = 0;
    let prevT = null;
    let sread = 0;
    let swrite = 0;
    let s1h = 0;
    let s5m = 0;
    let tier = "1h"; // tier established by the most recent write; refresh-on-use
    recs.forEach((r, i) => {
      g.turns++;
      P.turns++;
      g.read += r.read;
      g.write += r.write;
      g.input += r.input;
      g.output += r.output;
      g.w1h += r.w1h;
      g.w5m += r.w5m;
      sread += r.read;
      swrite += r.write;
      s1h += r.w1h;
      s5m += r.w5m;
      P.read += r.read;
      P.write += r.write;
      P.w1h += r.w1h;
      P.w5m += r.w5m;

      if (now - r.t < RECENT_WINDOW_MS) {
        g.recent1h += r.w1h;
        g.recent5m += r.w5m;
      }
      if (/fast|priority/i.test(r.speed)) g.fastModeTurns++;

      if (i === 0) {
        g.coldStarts++;
      } else {
        const gapMin = (r.t - prevT) / 60000;
        const reWarm = prevRead > PREV_READ_MIN && r.read < 0.5 * prevRead && r.write > REWARM_WRITE_MIN;
        const ttlMin = tier === "5m" ? TTL_5M_MIN : TTL_1H_MIN;
        if (reWarm) {
          if (gapMin > ttlMin) {
            g.idleReWarms++;
            g.idleReWarmTokens += r.write;
            P.idleReWarms++;
            P.reWarmTokens += r.write;
            if (gapMin < 180) g.gapBuckets["1-3h"]++;
            else if (gapMin < 720) g.gapBuckets["3-12h"]++;
            else g.gapBuckets[">12h"]++;
          } else {
            g.toolReWarms++;
            g.toolReWarmTokens += r.write;
            P.reWarmTokens += r.write;
            // Gap was inside the TTL window, so cache should have hit. Cause
            // (compaction, big tool add, or a real early eviction) is not
            // distinguishable from the transcript - no compaction marker exists
            // in the data. Keep the instance so it can be inspected directly
            // rather than folded into an aggregate that assumes a cause.
            subTtlMisses.push({ project: cleanName(sf.project), t: r.t, gapMin, tokens: r.write });
          }
        }
      }
      if (r.w1h > 0 || r.w5m > 0) tier = r.w5m > r.w1h ? "5m" : "1h";
      prevRead = Math.max(prevRead, r.read);
      prevT = r.t;
    });

    const last = recs[recs.length - 1];
    const sTier = s5m > s1h ? "5m" : "1h";
    sessionsSummary.push({
      project: cleanName(sf.project),
      id: sf.file.replace(/\.jsonl$/, "").slice(0, 8),
      lastT: last.t,
      tier: sTier,
      ttlMin: sTier === "5m" ? TTL_5M_MIN : TTL_1H_MIN,
      warmRatio: sread + swrite > 0 ? sread / (sread + swrite) : 0,
      turns: recs.length,
    });
    if (!active || last.t > active.lastT) {
      active = { project: sf.project, file: sf.file, lastT: last.t, recs };
    }
  }

  const warmRatio = g.read + g.write > 0 ? g.read / (g.read + g.write) : 0;
  const tier1hPct = g.w1h + g.w5m > 0 ? g.w1h / (g.w1h + g.w5m) : 1;
  const idleWasteEite = g.idleReWarmTokens * (W_WRITE_1H - W_READ);
  const warmReadEite = g.read * W_READ;
  const wastePct = warmReadEite > 0 ? idleWasteEite / warmReadEite : 0;

  let activeView = null;
  if (active) {
    let aread = 0;
    let awrite = 0;
    let a1h = 0;
    let a5m = 0;
    for (const r of active.recs) {
      aread += r.read;
      awrite += r.write;
      a1h += r.w1h;
      a5m += r.w5m;
    }
    const aTier = a5m > a1h ? "5m" : "1h";
    const ttlMin = aTier === "5m" ? TTL_5M_MIN : TTL_1H_MIN;
    const minsSince = (now - active.lastT) / 60000;
    activeView = {
      project: cleanName(active.project),
      tier: aTier,
      ttlMin,
      minsSinceLast: minsSince,
      warmMinsRemaining: Math.max(0, ttlMin - minsSince),
      warm: minsSince < ttlMin,
      sessionWarmRatio: aread + awrite > 0 ? aread / (aread + awrite) : 0,
      sessionTurns: active.recs.length,
    };
  }

  const recentTotal = g.recent1h + g.recent5m;
  const recent5mShare = recentTotal > 0 ? g.recent5m / recentTotal : 0;
  const alarm = { recent5mShare, downgrade: recent5mShare > 0.05 };

  const projectList = Object.values(projects)
    .map((p) => ({
      name: cleanName(p.name),
      sessions: p.sessions,
      turns: p.turns,
      read: p.read,
      write: p.write,
      reWarmTokens: p.reWarmTokens,
      idleReWarms: p.idleReWarms,
      tier: p.w5m > p.w1h ? "5m" : "1h",
    }))
    .sort((a, b) => b.reWarmTokens - a.reWarmTokens);

  // All sessions touched recently enough that one could still be warm (or just
  // cooled). The client computes each countdown live from lastT, so a thread
  // can cool off on screen between server polls.
  const RECENT_THREAD_MS = 6 * 3600 * 1000;
  const threads = sessionsSummary
    .filter((s) => now - s.lastT < RECENT_THREAD_MS)
    .sort((a, b) => b.lastT - a.lastT);

  // Closest-to-instant misses first - the ones most worth a second look.
  subTtlMisses.sort((a, b) => a.gapMin - b.gapMin);
  const subTtlMissesTotal = subTtlMisses.length;

  return {
    generatedAt: now,
    global: { ...g, warmRatio, tier1hPct, idleWasteEite, warmReadEite, wastePct },
    active: activeView,
    threads,
    alarm,
    projects: projectList,
    subTtlMisses: subTtlMisses.slice(0, 50),
    subTtlMissesTotal,
  };
}

// Compact ASCII report when run directly: `bun run lib/scan.js`
if (import.meta.main) {
  const d = analyze();
  const g = d.global;
  const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(0) + "M" : n >= 1e3 ? (n / 1e3).toFixed(0) + "k" : "" + n);
  console.log("=== Cachey_McCacheface ===");
  console.log("sessions:", g.sessions, " turns:", g.turns);
  console.log("warm hit ratio:", (g.warmRatio * 100).toFixed(1) + "%");
  console.log("tier:", (g.tier1hPct * 100).toFixed(2) + "% on 1-hour");
  console.log("idle re-warms (avoidable):", g.idleReWarms, " tokens:", fmt(g.idleReWarmTokens));
  console.log("tool re-warms (compaction):", g.toolReWarms, " tokens:", fmt(g.toolReWarmTokens));
  console.log("avoidable waste:", (g.wastePct * 100).toFixed(0) + "% of warm-read spend");
  const warm = (d.threads || [])
    .map((t) => ({ ...t, rem: t.ttlMin - (d.generatedAt - t.lastT) / 60000 }))
    .filter((t) => t.rem > 0)
    .sort((a, b) => a.rem - b.rem);
  console.log("warm threads now:", warm.length);
  for (const t of warm) {
    console.log("  - " + t.project + " (" + t.tier + ") warm ~" + t.rem.toFixed(0) + "m, hit " + (t.warmRatio * 100).toFixed(0) + "%");
  }
  if (d.alarm.downgrade) {
    console.log("[ALARM] recent 5-minute tier share:", (d.alarm.recent5mShare * 100).toFixed(1) + "%");
  }
}

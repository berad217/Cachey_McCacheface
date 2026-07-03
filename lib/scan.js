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
 * @returns {{project: string, file: string, path: string, mtimeMs: number}[]}
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
        out.push({ project: proj, file: f, path: fp, mtimeMs: fs.statSync(fp).mtimeMs });
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
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const u = o && o.message && o.message.usage;
    if (!u || typeof u.output_tokens !== "number") continue;
    const t = Date.parse(o.timestamp);
    if (Number.isNaN(t)) continue;
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
  recs.sort((a, b) => a.t - b.t);
  return recs;
}

function cleanName(proj) {
  return proj
    .replace(/^[A-Za-z]--/, "")
    .replace(/^software-projects-/i, "")
    .replace(/^tools-/i, "");
}

/**
 * Analyze all sessions and return the full dashboard summary.
 * @param {number} now epoch ms (injectable for tests)
 */
export function analyze(now = Date.now()) {
  const files = listSessionFiles();
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
    const recs = parseSession(sf.path);
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

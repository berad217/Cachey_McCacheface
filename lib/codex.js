// Local session inventory. Read-only handles are closed after every incremental
// pass; no vendor database, writer lock, process probe or network is involved.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readTranscript } from "./transcript.js";

function filesUnder(dir, accept, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(file, accept, out);
    else if (entry.isFile() && accept(entry.name)) {
      try { out.push({ file, ...fs.statSync(file) }); } catch { /* vanished */ }
    }
  }
  return out;
}

function text(content) {
  return Array.isArray(content) ? content.filter(c => typeof c?.text === "string").map(c => c.text).join("\n") : "";
}

const recorded = value => typeof value === "string" && value.trim() ? value : "-";

// Like scan.js: cache unchanged files, verify the consumed prefix on growth,
// read new bytes in chunks, and defer incomplete trailing JSON until next pass.
function load(file, cache, fresh, consume) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const stat = fs.fstatSync(fd);
    let e = cache.get(file);
    if (e && e.size === stat.size && e.mtimeMs === stat.mtimeMs) return e;
    const signature = offset => {
      const b = Buffer.alloc(Math.min(offset, 256));
      return b.subarray(0, fs.readSync(fd, b, 0, b.length, offset - b.length));
    };
    const append = e && stat.size > e.size && signature(e.offset).equals(e.sig);
    const grewAt = !e || stat.size !== e.size ? stat.mtimeMs : e.grewAt;
    if (!append) e = { offset: 0, data: fresh() };
    let pos = e.offset;
    let carry = Buffer.alloc(0);
    const chunk = Buffer.alloc(256 * 1024);
    const parse = line => {
      let value;
      try { value = JSON.parse(line); } catch { return false; }
      if (value && typeof value === "object") consume(e.data, value);
      return true;
    };
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos + carry.length);
      if (!n) break;
      const buf = Buffer.concat([carry, chunk.subarray(0, n)]);
      const nl = buf.lastIndexOf(10);
      if (nl >= 0) {
        for (const line of buf.toString("utf8", 0, nl + 1).split(/\r?\n/)) parse(line);
        pos += nl + 1;
      }
      carry = Buffer.from(buf.subarray(nl + 1));
    }
    if (carry.length && parse(carry.toString("utf8"))) pos += carry.length;
    e = { ...e, offset: pos, sig: signature(pos), size: stat.size, mtimeMs: stat.mtimeMs, grewAt };
    cache.set(file, e);
    return e;
  } catch { cache.delete(file); return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function codexLine(row, v) {
  const p = v.payload;
  if (!p || typeof p !== "object") return;
  if (v.type === "response_item" && p.type === "message" && p.role === "user" && !row.firstUserSeen) {
    // Desktop/CLI inject environment and app context as user records before the prompt.
    const prompt = text(p.content).replace(/<(environment_context|recommended_plugins|external_codex_apps_open_page)\b[^>]*>[\s\S]*?<\/\1>/g, "").trim();
    if (prompt) {
      row.firstUserSeen = true;
      row.ownerMarker = prompt.match(/^Owner-Session:[ \t]*([^\s]+)[ \t]*\r?$/m)?.[1] || null;
      row.ownerTitle = prompt.split(/\r?\n/, 1)[0].match(/^Message from ([^,]+)(?:,|$)/)?.[1] || null;
    }
  }
  if (v.type === "turn_context") {
    row.model = recorded(p.model);
    // Real 0.166 rollouts carry `effort` (and collaboration_mode.settings.reasoning_effort); keep the older key as a fallback.
    row.effort = recorded(p.effort ?? p.collaboration_mode?.settings?.reasoning_effort ?? p.reasoning_effort);
  }
  if (v.type === "session_meta") {
    const spawn = p.source?.subagent?.thread_spawn;
    Object.assign(row, { id: p.id, cwd: p.cwd || "", name: spawn?.agent_nickname || "",
      parent: spawn?.parent_thread_id || null,
      app: /desktop/i.test(p.originator || "") ? "app" : "CLI" });
  }
  if (p.type === "message" && p.role === "assistant") {
    const message = text(p.content);
    if (message) row.lastAssistant = message.slice(0, 200);
  }
}

function claudeLine(row, v) {
  if (typeof v.cwd === "string") row.cwd = v.cwd;
  if (v.customTitle || v.slug) row.name = v.customTitle || row.name || v.slug;
  if (v.customTitle || v.slug) row.hasTitle = true;
  if (v.agentId) { row.id = v.agentId; row.parent = v.sessionId || row.parent; }
  else if (v.sessionId && !row.parent) row.id = v.sessionId;
  if (v.entrypoint) row.app = /desktop/i.test(v.entrypoint) ? "app" : "CLI";
  if (v.type === "assistant") {
    row.model = recorded(v.message?.model);
    // Claude records the per-turn override separately from the session setting.
    row.effort = recorded(v.perTurnEffort);
    if (row.effort === "-") row.effort = recorded(v.effort);
    const message = text(v.message?.content);
    if (message) row.lastAssistant = message.slice(0, 200);
  }
}

function notes(cwd) {
  if (!cwd) return [];
  const dir = path.join(cwd, ".babel", "outbox");
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter(e => e.isFile()).flatMap(e => {
    try { return [{ name: e.name, mtimeMs: fs.statSync(path.join(dir, e.name)).mtimeMs }]; } catch { return []; }
  }).sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name)).slice(0, 3).flatMap(e => {
    let fd;
    try {
      fd = fs.openSync(path.join(dir, e.name), "r");
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return [{ name: e.name, firstLine: buf.toString("utf8", 0, n).split(/\r?\n/)[0] }];
    } catch { return []; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  });
}

export function createSessionReader({
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  projectsDir = path.join(os.homedir(), ".claude", "projects"),
} = {}) {
  const cache = new Map();
  const indexCache = new Map();
  const transcriptFiles = new Map();
  const read = ({ now = Date.now(), window: hours = 24 } = {}) => {
    transcriptFiles.clear();
    hours = Number(hours);
    if (!Number.isFinite(hours) || hours <= 0) hours = 24;
    const names = load(path.join(codexHome, "session_index.jsonl"), indexCache, () => new Map(), (m, v) => {
      if (typeof v.id === "string" && typeof v.thread_name === "string") m.set(v.id, v.thread_name);
    })?.data || new Map();
    const rows = new Map();
    const listed = new Set();
    for (const [vendor, files, consume] of [
      ["Codex", filesUnder(path.join(codexHome, "sessions"), n => n.startsWith("rollout-") && n.endsWith(".jsonl")), codexLine],
      ["Claude Code", filesUnder(projectsDir, n => n.endsWith(".jsonl")), claudeLine],
    ]) {
      for (const { file } of files) {
        listed.add(file);
        const subagent = vendor === "Claude Code" && /[\\/]subagents[\\/]/.test(file);
        const e = load(file, cache, () => ({
          id: path.basename(file, ".jsonl").replace(/^agent-/, ""), cwd: "", name: "", app: "CLI",
          parent: subagent ? path.basename(path.dirname(path.dirname(file))) : null, lastAssistant: "",
          model: "-", effort: "-", firstUserSeen: false, ownerMarker: null, ownerTitle: null,
        }), consume);
        if (!e) continue;
        const row = { ...e.data, vendor, lastActivity: e.grewAt,
          state: now - e.grewAt < 60000 ? "running" : now - e.grewAt <= hours * 3600000 ? "idle" : "old" };
        row.name = (vendor === "Codex" && names.get(row.id)) || row.name ||
          (row.cwd ? path.win32.basename(row.cwd.replaceAll("/", "\\")) : vendor === "Claude Code" ? path.relative(projectsDir, file).split(path.sep)[0] : row.id);
        const key = vendor + ":" + row.id;
        if (!rows.has(key) || rows.get(key).lastActivity < row.lastActivity) {
          rows.set(key, row);
          transcriptFiles.set((vendor === "Codex" ? "codex" : "claude") + ":" + row.id, file);
        }
      }
    }
    for (const file of cache.keys()) if (!listed.has(file)) cache.delete(file);
    const claudeRows = [...rows.values()].filter(r => r.vendor === "Claude Code");
    const titledClaudeRows = claudeRows.filter(r => r.hasTitle);
    const noteCache = new Map();
    return [...rows.values()].sort((a, b) => b.lastActivity - a.lastActivity).map(row => {
      row.owner = null;
      row.ownerInferred = false;
      if (row.vendor === "Codex") {
        const matches = row.ownerMarker ? claudeRows.filter(r => r.id === row.ownerMarker) :
          row.ownerTitle ? titledClaudeRows.filter(r => r.name === row.ownerTitle) : [];
        if (matches.length === 1) {
          row.owner = matches[0].id;
          row.ownerInferred = !row.ownerMarker;
        }
        if (!noteCache.has(row.cwd)) noteCache.set(row.cwd, notes(row.cwd));
        row.notes = noteCache.get(row.cwd);
      }
      delete row.firstUserSeen;
      delete row.ownerMarker;
      delete row.ownerTitle;
      delete row.hasTitle;
      return row;
    });
  };
  read.transcript = async ({ vendor, id, limit = 200 } = {}) => {
    if (!["codex", "claude"].includes(vendor) || typeof id !== "string" || /[\\/]/.test(id)) return null;
    if (!Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 1000) throw new RangeError("limit must be an integer from 1 to 1000");
    read(); // Refresh the same inventory, including deletions and changed ids.
    const file = transcriptFiles.get(vendor + ":" + id);
    if (!file) return null;
    try { return await readTranscript(file, vendor, Number(limit)); }
    catch (e) { if (["ENOENT", "EACCES", "EPERM"].includes(e.code)) return null; throw e; }
  };
  return read;
}

export const sessions = createSessionReader();

if (import.meta.main) {
  const ascii = value => String(value ?? "").replace(/[^\x20-\x7e]/g, "?");
  for (const row of sessions({ window: process.argv[2] || 24 })) {
    console.log(ascii(`${row.state} | ${row.vendor} | ${row.model} | ${row.effort} | ${row.name} | ${row.app} | ${row.cwd} | parent: ${row.parent || "-"} | ${new Date(row.lastActivity).toISOString()}`));
    if (row.lastAssistant) console.log("  " + ascii(row.lastAssistant));
    for (const note of row.notes || []) console.log("  " + ascii(note.name + ": " + note.firstLine));
  }
}

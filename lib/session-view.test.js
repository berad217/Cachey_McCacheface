import { test, expect } from "bun:test";
import fs from "node:fs";
import vm from "node:vm";

function page(storage = {}) {
  const elements = new Map();
  const handlers = new Map();
  let warmElements = [];
  let details = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "", addEventListener(type, fn) { handlers.set(id + ":" + type, fn); }, querySelector() { return null; } });
    return elements.get(id);
  };
  const ctx = vm.createContext({
    document: { getElementById: element, querySelectorAll: selector => selector === "[data-warm-session]" ? warmElements : details, documentElement: {} },
    localStorage: { getItem: k => storage[k], setItem: (k, v) => { storage[k] = v; } },
    getComputedStyle: () => ({ getPropertyValue: () => "green" }),
    setInterval() {}, fetch: () => new Promise(() => {}), Date, AbortController, URLSearchParams,
  });
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], ctx);
  return { run: code => vm.runInContext(code, ctx), element, handlers,
    setWarmElements: els => { warmElements = els; }, setDetails: els => { details = els; } };
}

test("warm countdown joins a full session id and warm cards use escaped session titles", () => {
  const p = page();
  p.run(`state = {threads: [{ id: "full-session-id", project: "folder", lastT: Date.now(), ttlMin: 60, warmRatio: .99, tier: "1h" }]};
    renderSessions([{id: "full-session-id", vendor: "Claude Code", name: "ROG <BRICKY>", state: "idle", lastActivity: Date.now()}]); renderThreads();`);
  expect(p.element("sessions").innerHTML).toContain("99% warm");
  expect(p.element("sessions").innerHTML).toContain("60m left");
  expect(p.element("board").innerHTML).toContain("ROG &lt;BRICKY&gt;");
  p.run(`state.threads[0].lastT -= 61 * 60000; renderSessions(sessionRows);`);
  expect(p.element("sessions").innerHTML).not.toContain("% warm");
});

test("vendor filters select only that vendor and count the unfiltered rows", () => {
  const p = page();
  p.run(`renderSessions([
    {id: "owner", vendor: "Claude Code", name: "Owner", state: "idle", lastActivity: Date.now()},
    {id: "worker", vendor: "Codex", name: "Worker", owner: "owner", state: "running", lastActivity: Date.now()},
    {id: "child", vendor: "Codex", name: "Child", parent: "worker", state: "idle", lastActivity: Date.now()}
  ]);`);
  expect(p.element("sessions").innerHTML).toContain("1 worker running");
  expect(p.element("sessions").innerHTML).toContain("owner: Owner");
  expect(p.run(`JSON.stringify(sessionSelection(sessionRows, "Codex").counts)`)).toBe('{"All":3,"Claude Code":1,"Codex":2}');
  p.run(`vendorFilter = "Codex"; renderSessions(sessionRows);`);
  expect(p.element("sessions").innerHTML).not.toContain('data-session="[&quot;claude&quot;');
  expect(p.element("sessions").innerHTML).toContain("Worker");
  p.run(`vendorFilter = "Claude Code"; renderSessions(sessionRows);`);
  expect(p.element("sessions").innerHTML).not.toContain('data-session="[&quot;codex&quot;');
});

test("filter choice is persisted, validated and safe with unavailable storage", () => {
  const storage = { "cachey.vendorFilter": "Codex" };
  const p = page(storage);
  expect(p.run("vendorFilter")).toBe("Codex");
  p.handlers.get("vendorfilters:click")({ target: { closest: () => ({ dataset: { vendor: "Claude Code" } }) } });
  expect(storage["cachey.vendorFilter"]).toBe("Claude Code");
  expect(page({ "cachey.vendorFilter": "invalid" }).run("vendorFilter")).toBe("All");
  const blocked = new Proxy({}, { get() { throw new Error("storage denied"); }, set() { throw new Error("storage denied"); } });
  const b = page(blocked);
  expect(b.run("vendorFilter")).toBe("All");
  expect(() => b.handlers.get("vendorfilters:click")({ target: { closest: () => ({ dataset: { vendor: "Codex" } }) } })).not.toThrow();
});

test("nesting keeps same-vendor parents ahead of owners and breaks cyclic links", () => {
  const p = page();
  const forest = JSON.parse(p.run(`JSON.stringify((() => {
    const rows = [
      {id: "owner", vendor: "Claude Code"},
      {id: "worker", vendor: "Codex", owner: "owner"},
      {id: "child", vendor: "Codex", parent: "worker", owner: "owner"},
      {id: "unmatched", vendor: "Codex", owner: "absent"}
    ];
    const tree = sessionForest(rows);
    return { roots: tree.roots.map(r => r.id), ownerChildren: tree.children.get(sessionKey(rows[0])).map(r => r.id), workerChildren: tree.children.get(sessionKey(rows[1])).map(r => r.id) };
  })())`));
  expect(forest).toEqual({ roots: ["owner", "unmatched"], ownerChildren: ["worker"], workerChildren: ["child"] });
  expect(p.run(`sessionForest([{id: "a", vendor: "Codex", parent: "b"}, {id: "b", vendor: "Codex", parent: "a"}]).roots.length`)).toBe(1);
});

test("live chip updates hide cooled sessions and never attach Claude warmth to Codex ids", () => {
  const p = page();
  const chip = { dataset: { warmSession: '["claude","same"]' } };
  p.setWarmElements([chip]);
  p.run(`sessionRows = [{id: "same", vendor: "Claude Code"}]; state = {threads: [{id: "same", ttlMin: 60, lastT: Date.now() - 3 * 60000, warmRatio: .99}]}; renderThreads();`);
  expect(chip.textContent).toMatch(/5[67]m left · 99% warm/);
  expect(chip.hidden).toBe(false);
  expect(p.run(`warmth({id: "same", vendor: "Codex"})`)).toBe("");
  p.run(`state.threads[0].lastT -= 60 * 60000; renderThreads();`);
  expect(chip.hidden).toBe(true);
  expect(chip.textContent).toBe("");
});

test("collapsing an owner cancels hidden child reads while retaining child expansion state", () => {
  const p = page();
  const owner = { tagName: "DETAILS", dataset: { session: '["claude","owner"]' }, open: false,
    parentElement: null, matches: () => true };
  const child = { tagName: "DETAILS", dataset: { session: '["codex","child"]' }, open: true, parentElement: owner };
  p.setDetails([owner, child]);
  p.run(`openTranscripts.add('["claude","owner"]'); openTranscripts.add('["codex","child"]');
    globalThis.childRequest = new AbortController(); transcriptRequests.set('["codex","child"]', childRequest);`);
  p.handlers.get("sessions:toggle")({ target: owner });
  expect(p.run("childRequest.signal.aborted")).toBe(true);
  expect(p.run("transcriptRequests.size")).toBe(0);
  expect(p.run(`openTranscripts.has('["codex","child"]')`)).toBe(true);
  expect(p.run(`openTranscripts.has('["claude","owner"]')`)).toBe(false);
});

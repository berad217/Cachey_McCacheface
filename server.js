// Cachey_McCacheface - local dashboard server (Bun).
// Serves the live dashboard and a JSON summary endpoint. No external network.
// Run: bun run start  ->  http://localhost:4317

import { analyzeAsync } from "./lib/scan.js";
import { readLatest } from "./lib/meter.js";

const PORT = Number(process.env.PORT || 4317);

// Stale-while-revalidate summary. The scan itself is incremental (only changed
// transcripts are re-parsed) and yields to the event loop, so other routes stay
// responsive even during the cold first scan. A request for a stale summary
// starts one refresh and waits at most FRESH_WAIT_MS for it; past that it gets
// the previous result and the refresh finishes in the background.
let cache = { at: 0, data: null };
let inflight = null;
const CACHE_MS = 5000;
const FRESH_WAIT_MS = 1000;

/** Start a scan unless one is running. Resolves to the new summary, or null on failure. */
function refresh() {
  if (!inflight) {
    const now = Date.now();
    const started = performance.now();
    inflight = analyzeAsync(now)
      .then(
        (data) => {
          cache = { at: now, data };
          if (performance.now() - started > 2000) {
            console.log("scan finished in " + ((performance.now() - started) / 1000).toFixed(1) + "s");
          }
          return data;
        },
        (e) => {
          console.error("scan failed: " + (e && e.message ? e.message : e));
          return null;
        },
      )
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

async function summary() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  const p = refresh();
  if (!cache.data) {
    const data = await p; // first scan: nothing older to serve
    if (!data) throw new Error("scan failed");
    return data;
  }
  const stale = cache.data;
  const fresh = await Promise.race([p, Bun.sleep(FRESH_WAIT_MS).then(() => null)]);
  return fresh || stale;
}

const indexUrl = new URL("./public/index.html", import.meta.url);
const chartUrl = new URL("./public/vendor/chart.umd.js", import.meta.url);

try {
  Bun.serve({
    port: PORT,
    // The cold first scan of a large transcript history can outlast Bun's 10s
    // default; /api/summary waits for it rather than dropping the socket.
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/summary") {
        return new Response(JSON.stringify(await summary()), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }
      if (url.pathname === "/api/meter") {
        // Latest logged /usage reading (written hourly by lib/meter.js). Reads
        // the log tail only; never spawns claude from a request.
        return new Response(JSON.stringify(readLatest()), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }
      if (url.pathname === "/vendor/chart.umd.js") {
        return new Response(Bun.file(chartUrl), { headers: { "content-type": "text/javascript; charset=utf-8" } });
      }
      return new Response(Bun.file(indexUrl), { headers: { "content-type": "text/html; charset=utf-8" } });
    },
    error() {
      return new Response("Cachey_McCacheface error", { status: 500 });
    },
  });
  console.log("Cachey_McCacheface dashboard running at http://localhost:" + PORT);
  console.log("API: http://localhost:" + PORT + "/api/summary");
  refresh(); // warm the parse cache before the first page load asks for it
} catch (e) {
  // Second launch / port already taken: the existing instance is serving. Bow out cleanly.
  if (String(e && e.code) === "EADDRINUSE" || /in use|EADDRINUSE/i.test(String(e))) {
    console.log("Cachey_McCacheface already running on :" + PORT + " - reusing it.");
    process.exit(0);
  }
  throw e;
}

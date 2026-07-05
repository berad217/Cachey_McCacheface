// Cachey_McCacheface - local dashboard server (Bun).
// Serves the live dashboard and a JSON summary endpoint. No external network.
// Run: bun run start  ->  http://localhost:4317

import { analyze } from "./lib/scan.js";

const PORT = Number(process.env.PORT || 4317);

// Cache the summary briefly so rapid polls don't re-scan every transcript.
let cache = { at: 0, data: null };
const CACHE_MS = 5000;

function summary() {
  const now = Date.now();
  if (cache.data && now - cache.at < CACHE_MS) return cache.data;
  const data = analyze(now);
  cache = { at: now, data };
  return data;
}

const indexUrl = new URL("./public/index.html", import.meta.url);
const chartUrl = new URL("./public/vendor/chart.umd.js", import.meta.url);

try {
  Bun.serve({
    port: PORT,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/summary") {
        return new Response(JSON.stringify(summary()), {
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
} catch (e) {
  // Second launch / port already taken: the existing instance is serving. Bow out cleanly.
  if (String(e && e.code) === "EADDRINUSE" || /in use|EADDRINUSE/i.test(String(e))) {
    console.log("Cachey_McCacheface already running on :" + PORT + " - reusing it.");
    process.exit(0);
  }
  throw e;
}

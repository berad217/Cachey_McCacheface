// Cachey_McCacheface - headless tier-downgrade guard.
// Exits 1 (and prints an ALARM line) if recent cache writes show the cache
// silently dropping from the 1-hour tier to the 5-minute tier - the one
// warning Anthropic won't give you. Wire to a scheduler/notifier later.
// Run: bun run check

import { analyze } from "./lib/scan.js";

const d = analyze();
const a = d.alarm;
const share = ((a && a.recent5mShare) || 0) * 100;

if (a && a.downgrade) {
  console.log("[ALARM] Cache tier downgrade: " + share.toFixed(1) + "% of recent writes on the 5-minute tier.");
  console.log("        Your warm window may have collapsed from ~60 min to ~5 min. Batch your turns.");
  process.exit(1);
}

console.log("[OK] Cache tier healthy: 1-hour dominant (recent 5-minute share " + share.toFixed(1) + "%).");
process.exit(0);

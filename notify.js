// Cachey_McCacheface - desktop notifier for cache tier downgrades.
// Meant to run unattended (e.g. an hourly Scheduled Task). Pops a Windows
// balloon ONLY when the cache tier downgrades 1h -> 5m; silent otherwise.
// Manual test: bun run notify.js --demo

import { analyze } from "./lib/scan.js";

function balloon(title, text) {
  // Non-blocking Windows balloon via NotifyIcon - no external modules needed.
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$n = New-Object System.Windows.Forms.NotifyIcon",
    "$n.Icon = [System.Drawing.SystemIcons]::Warning",
    "$n.BalloonTipTitle = " + JSON.stringify(title),
    "$n.BalloonTipText = " + JSON.stringify(text),
    "$n.Visible = $true",
    "$n.ShowBalloonTip(15000)",
    "Start-Sleep -Seconds 12",
    "$n.Dispose()",
  ].join("\n");
  Bun.spawnSync(["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps]);
}

const demo = process.argv.includes("--demo");
const d = analyze();
const a = d.alarm;

if (demo) {
  balloon("Cachey_McCacheface", "Demo alert - this is what a cache tier downgrade looks like.");
  console.log("[demo] balloon fired.");
} else if (a && a.downgrade) {
  const pct = (a.recent5mShare * 100).toFixed(0);
  balloon(
    "Cachey: cache tier downgrade",
    pct + "% of recent writes are on the 5-minute tier. Your warm window may have collapsed from ~60 to ~5 min - batch your turns."
  );
  console.log("[ALARM] notified: 5m share " + pct + "%");
} else {
  console.log("[OK] tier healthy; no notification.");
}

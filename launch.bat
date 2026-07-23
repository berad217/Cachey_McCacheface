@echo off
rem Cachey_McCacheface one-click launcher.
rem Starts the dashboard server (minimized) and opens it in your browser.
rem Click again any time - if it's already running it just reopens the tab.
title Cachey_McCacheface
cd /d "%~dp0"
rem Resolve bun without relying on PATH: Explorer-spawned cmd can carry a stale
rem environment (missing .bun\bin), so prefer the default install location and
rem only fall back to PATH lookup for non-standard installs.
set "BUN=%USERPROFILE%\.bun\bin\bun.exe"
if not exist "%BUN%" set "BUN=bun"
start "Cachey_McCacheface" /min "%BUN%" server.js
ping -n 2 127.0.0.1 >nul
start "" "http://localhost:4317"
exit

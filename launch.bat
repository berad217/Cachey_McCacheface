@echo off
rem Cachey_McCacheface one-click launcher.
rem Starts the dashboard server (minimized) and opens it in your browser.
rem Click again any time - if it's already running it just reopens the tab.
title Cachey_McCacheface
cd /d "%~dp0"
start "Cachey_McCacheface" /min bun server.js
ping -n 2 127.0.0.1 >nul
start "" "http://localhost:4317"
exit

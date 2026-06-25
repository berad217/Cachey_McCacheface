@echo off
rem Cachey_McCacheface one-click launcher.
rem Starts the dashboard server (minimized) and opens it in your browser.
rem Click again any time - if it's already running it just reopens the tab.
title Cachey_McCacheface
cd /d "P:\software_projects\Cachey_McCacheface"
start "Cachey_McCacheface" /min "C:\Users\Brad\.bun\bin\bun.exe" server.js
ping -n 2 127.0.0.1 >nul
start "" "http://localhost:4317"
exit

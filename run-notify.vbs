' Cachey_McCacheface - windowless launcher for the hourly tier-watch task.
' Task Scheduler runs bun.exe (a console app) directly, which pops a focusable
' console window on every run and steals keyboard focus. wscript.exe has no
' console of its own, and Run(cmd, 0, False) launches bun with a HIDDEN window
' (0) without waiting (False). The NotifyIcon balloon in notify.js still shows
' if a real cache-tier downgrade is detected - only the console window is gone.
' Since v1.1 the same hourly run also takes one /usage meter reading
' (lib/meter.js -> data/meter.jsonl). The two are independent: a meter failure
' is logged as a row and never affects the tier alarm.
Dim shell, fso, here, bun
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
' Prefer the default bun install location; scheduler/Explorer environments can
' carry a stale PATH without .bun\bin. Fall back to PATH for custom installs.
bun = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.bun\bin\bun.exe"
If Not fso.FileExists(bun) Then bun = "bun"
shell.Run """" & bun & """ """ & here & "\notify.js""", 0, False
shell.Run """" & bun & """ """ & here & "\lib\meter.js""", 0, False

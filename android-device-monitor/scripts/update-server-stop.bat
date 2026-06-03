@echo off
setlocal
set "PORT=8384"

rem Quick-stop the auto-update server. Double-click to run.
rem Kills whatever process is LISTENING on the update port (default 8384),
rem so it works no matter how the server was started.

echo Stopping update server on port %PORT% ...
set "KILLED="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do (
    echo  - killing PID %%a
    taskkill /PID %%a /F >nul 2>&1
    set "KILLED=1"
)

if defined KILLED (
    echo Done. Update server stopped.
) else (
    echo No update server was running on port %PORT%.
)

%SystemRoot%\System32\ping.exe -n 4 127.0.0.1 >nul

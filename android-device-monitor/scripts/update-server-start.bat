@echo off
setlocal
title AndroidTool Update Server (port 8384)

rem Quick-start the auto-update server. Double-click to run.
rem Serves update-releases\latest over HTTP so friends' apps can auto-update.
rem This window shows the server logs; close it (or run update-server-stop.bat) to stop.

cd /d "%~dp0.."

echo ============================================================
echo  AndroidTool Update Server
echo  Serving: update-releases\latest   Port: 8384   Listen: 0.0.0.0
echo  Friends point their app update URL to:  http://<this-PC-IP>:8384/
echo  Stop: close this window, press Ctrl+C, or run update-server-stop.bat
echo ============================================================
echo.

node "scripts\serve-updates.js"

echo.
echo Update server stopped.
pause

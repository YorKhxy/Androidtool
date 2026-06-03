@echo off
setlocal
title Make Update Package

rem Quick-build the hot-update package. Double-click to run.
rem Produces NSIS installer + latest.yml + .blockmap in dist\ (electron-updater artifacts).
rem Remember to bump "version" in package.json before each release.

cd /d "%~dp0.."

rem Pass-through args: e.g. make-update-package.bat -NoVersionBump  (skip auto version bump)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-update-package.ps1" %*
if errorlevel 1 (
    echo.
    echo Make update package FAILED.
    pause
    exit /b 1
)

echo.
echo Update package is ready in dist\. You can now run update-server-start.bat.
pause

@echo off
setlocal
title Make Update Package

rem Quick-build the hot-update package. Double-click to run.
rem Produces NSIS installer + latest.yml + .blockmap in dist\ (electron-updater artifacts).
rem Remember to bump "version" in package.json before each release.

cd /d "%~dp0.."

rem 透传参数：例如 make-update-package.bat -NoVersionBump 可跳过自动自增版本号。
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

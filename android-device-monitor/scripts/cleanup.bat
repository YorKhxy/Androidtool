@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0.."

echo ========================================
echo   Android Device Monitor - Cleanup Tool
echo ========================================
echo.

echo Step 1: Stopping running instances...
taskkill /f /im AndroidDeviceMonitor*.exe 2>nul
echo Done.

echo.
echo Step 2: Waiting for file locks to release...
ping -n 2 127.0.0.1 >nul
echo Done.

echo.
echo Step 3: Cleaning old builds, keeping only the latest...

set "releaseRoot=src\release"

for /d %%month in ("%releaseRoot%\*") do (
    set "latestBuild="
    set "count=0"
    
    for /d %%build in ("%%month\*") do (
        set "latestBuild=%%build"
        set /a count+=1
    )
    
    if !count! gtr 1 (
        echo.
        echo Processing: %%month
        echo Total builds found: !count!
        echo Keeping latest: !latestBuild!
        
        for /d %%build in ("%%month\*") do (
            if not "%%build"=="!latestBuild!" (
                echo Removing: %%build
                rmdir /s /q "%%build" 2>nul
            )
        )
    )
)

echo.
echo Done! Only the latest builds are kept.
echo.
pause
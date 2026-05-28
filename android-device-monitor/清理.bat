@echo off
setlocal enabledelayedexpansion

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

for /d %%m in (src\release\*) do (
    call :processMonth "%%m"
)

echo.
echo Done! Only the latest builds are kept.
echo.
pause
exit /b

:processMonth
set "monthDir=%~1"
set "latestBuild="
set "count=0"

for /d %%b in ("%monthDir%\*") do (
    set "latestBuild=%%b"
    set /a count+=1
)

if !count! gtr 1 (
    echo.
    echo Processing: %monthDir%
    echo Total builds found: !count!
    echo Keeping latest: !latestBuild!
    
    for /d %%b in ("%monthDir%\*") do (
        if not "%%b"=="!latestBuild!" (
            echo Removing: %%b
            rmdir /s /q "%%b" 2>nul
        )
    )
)
exit /b
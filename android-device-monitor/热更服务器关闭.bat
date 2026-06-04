@echo off
rem Chinese-named launcher -> calls scripts\update-server-stop.bat
echo Stopping hot-update server...
call "%~dp0scripts\update-server-stop.bat"

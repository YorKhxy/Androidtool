@echo off
rem Chinese-named launcher -> calls scripts\make-update-package.bat
echo Building hot-update package...
call "%~dp0scripts\make-update-package.bat" %*

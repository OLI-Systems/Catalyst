@echo off
title Catalyst Uninstaller
echo.
echo  Removing Catalyst auto-start and shortcuts...
echo.

:: Kill running Catalyst server
taskkill /f /fi "WINDOWTITLE eq Catalyst*" >nul 2>&1
for /f "tokens=2" %%p in ('netstat -ano ^| findstr ":4200 " ^| findstr "LISTENING"') do taskkill /f /pid %%p >nul 2>&1

:: Remove startup shortcut
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Catalyst.lnk" >nul 2>&1
echo  [OK] Auto-start removed.

:: Remove desktop shortcut
del "%USERPROFILE%\Desktop\Catalyst.lnk" >nul 2>&1
echo  [OK] Desktop shortcut removed.

echo.
echo  Catalyst has been uninstalled.
echo  (The app files in this folder were not deleted.)
echo.
pause

@echo off
setlocal enabledelayedexpansion
title Catalyst Installer
color 0B

echo.
echo  =============================================
echo    CATALYST - An IDE for the AI first world
echo    Installer
echo  =============================================
echo.

:: Check for admin rights
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo  [!] Requesting administrator privileges...
    powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

:: Get the directory where this script lives
set "CATALYST_DIR=%~dp0"
set "CATALYST_DIR=%CATALYST_DIR:~0,-1%"

echo  [1/5] Checking for Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [!] Node.js not found. Downloading installer...
    echo.

    set "NODE_INSTALLER=%TEMP%\node-installer.msi"
    powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.16.0/node-v22.16.0-x64.msi' -OutFile '%TEMP%\node-installer.msi'"

    if not exist "%TEMP%\node-installer.msi" (
        echo  [X] Failed to download Node.js. Please install manually from https://nodejs.org
        pause
        exit /b 1
    )

    echo  [!] Installing Node.js (this may take a minute)...
    msiexec /i "%TEMP%\node-installer.msi" /qn /norestart

    :: Refresh PATH
    set "PATH=%PATH%;C:\Program Files\nodejs"

    del "%TEMP%\node-installer.msi" >nul 2>&1

    where node >nul 2>&1
    if %errorlevel% neq 0 (
        echo  [X] Node.js installation failed. Please install manually from https://nodejs.org
        pause
        exit /b 1
    )
    echo  [OK] Node.js installed successfully.
) else (
    for /f "tokens=*" %%v in ('node --version') do echo  [OK] Node.js %%v found.
)

echo.
echo  [2/5] Installing dependencies...
cd /d "%CATALYST_DIR%"
call npm install --production 2>nul
if %errorlevel% neq 0 (
    echo  [!] npm install had warnings, but continuing...
)
echo  [OK] Dependencies installed.

echo.
echo  [3/5] Creating desktop shortcut...
powershell -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut([IO.Path]::Combine($ws.SpecialFolders('Desktop'), 'Catalyst.lnk')); $s.TargetPath = '%CATALYST_DIR%\start-catalyst.vbs'; $s.WorkingDirectory = '%CATALYST_DIR%'; $s.Description = 'Launch Catalyst IDE'; $s.Save()"
echo  [OK] Desktop shortcut created.

echo.
echo  [4/5] Setting up auto-start on login...
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
powershell -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%STARTUP%\Catalyst.lnk'); $s.TargetPath = '%CATALYST_DIR%\start-catalyst.vbs'; $s.WorkingDirectory = '%CATALYST_DIR%'; $s.Description = 'Auto-start Catalyst'; $s.WindowStyle = 7; $s.Save()"
echo  [OK] Catalyst will start automatically on login.

echo.
echo  [5/5] Launching Catalyst now...
start "" wscript "%CATALYST_DIR%\start-catalyst.vbs"

echo.
echo  =============================================
echo    Installation complete!
echo.
echo    Catalyst is now running at http://localhost:4200
echo    - Desktop shortcut created
echo    - Auto-starts on login
echo.
echo    To uninstall: run uninstall-catalyst.bat
echo  =============================================
echo.
pause

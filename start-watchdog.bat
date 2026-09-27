@echo off
call "%~dp0scripts\ensure-node.bat"
if errorlevel 1 exit /b 1

title QQ Bot Moderation - Watchdog Mode
echo ========================================
echo   QQ Bot Content Moderation - Watchdog
echo   (auto-restart on crash)
echo ========================================
echo.

echo [1/2] Checking Ollama status...
curl -s http://127.0.0.1:11434/api/tags >nul 2>&1
if %errorlevel% equ 0 (
    echo       Ollama: OK
) else (
    echo       WARNING: Ollama not responding, is the tray app running?
)

echo [2/2] Starting moderation service with watchdog (port 11451)...
:: Kill any process on port 11451
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":11451" ^| findstr "LISTENING" 2^>nul') do (
    taskkill /F /PID %%a >nul 2>&1
)
cd /d "%~dp0"
node scripts\watchdog.js

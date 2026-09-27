@echo off
call "%~dp0scripts\ensure-node.bat"
if errorlevel 1 exit /b 1

REM ---- T08c: bootstrap runtime env (deps / dirs / config seed / prompts+optional checks) ----
REM Skip with:  start.bat --skip-bootstrap
if /i not "%~1"=="--skip-bootstrap" (
    echo [prep] Bootstrapping GRS runtime environment...
    node "%~dp0scripts\bootstrap.js"
    if errorlevel 1 echo [prep] WARNING: environment not fully ready - startup may fail
)

title QQ Bot Content Moderation System
echo ========================================
echo   QQ Bot Content Moderation - Start
echo ========================================
echo.

:: Models now use default location (%USERPROFILE%\.ollama\models)
:: Ollama tray app manages serve automatically

:: Step 1: Check Ollama is running
echo [1/3] Checking Ollama status...
curl -s http://127.0.0.1:11434/api/tags >nul 2>&1
if %errorlevel% equ 0 (
    echo       Ollama: OK
) else (
    echo       WARNING: Ollama not responding, is the tray app running?
)

:: Step 2: Start Node.js moderation service
echo [2/3] Starting moderation service (port 11451)...
:: Kill any process on port 11451
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":11451" ^| findstr "LISTENING" 2^>nul') do (
    taskkill /F /PID %%a >nul 2>&1
)
cd /d "%~dp0"
start /b "" node src/server.js
timeout /t 3 /nobreak >nul
echo       Moderation service started

:: Step 3: Health check
echo [3/3] Checking service status...
curl -s http://127.0.0.1:11451/health >nul 2>&1
if %errorlevel% equ 0 (
    echo       Service: OK
) else (
    echo       Service may need a moment, please wait
)

echo.
echo ========================================
echo   Start complete!
echo.
echo   Web UI:  http://localhost:11451
echo   Health:  http://localhost:11451/health
echo.
echo   Text model: gpt-oss-safeguard:20b
echo   Vision model: qwen3-vl:8b-instruct
echo   Comparison model: qwen3:8b (daily 4AM)
echo ========================================
echo.
echo Press any key to open browser...
pause >nul
start http://localhost:11451

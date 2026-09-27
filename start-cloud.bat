@echo off
call "%~dp0scripts\ensure-node.bat"
if errorlevel 1 exit /b 1

cd /d "%~dp0"

REM ============================================
REM  QQ Bot Content Moderation - Cloud Only Mode
REM  No local GPU/Ollama required, uses Alibaba Cloud Qwen API
REM ============================================

echo ========================================
echo   QQ Bot Moderation - Cloud Lightweight
echo ========================================
echo.
echo Mode: cloud-only (cloud API only, no local model)
echo No GPU / Ollama required
echo.

REM Set environment variable
set MODERATION_MODE=cloud-only

REM Check Alibaba Cloud API Key
if "%DASHSCOPE_API_KEY%"=="" (
    echo [WARN] DASHSCOPE_API_KEY environment variable is not set
    echo Please set it in config/default.json - qwenCloud.apiKey
    echo Or run: set DASHSCOPE_API_KEY=your_key_here
    echo.
)

REM Start service
node src/server.js

pause

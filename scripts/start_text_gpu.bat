@echo off
REM ===== Text GPU Instance (GPU 0 - RTX 4070 Ti Super) =====
REM This instance runs qwen3:14b for text moderation on port 11434

echo Starting Ollama Text Instance on GPU 0 (port 11434)...

REM Stop default Ollama service first
taskkill /F /IM ollama.exe 2>nul
timeout /t 2 /nobreak >nul

REM Set GPU 0 (4070 Ti Super) for text model
set CUDA_VISIBLE_DEVICES=0
set OLLAMA_HOST=127.0.0.1:11434

REM Start Ollama serve
"%LOCALAPPDATA%\Programs\Ollama\ollama.exe" serve

pause

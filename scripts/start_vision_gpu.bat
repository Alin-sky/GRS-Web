@echo off
REM ===== Vision GPU Instance (GPU 1 - RTX 3060 Ti) =====
REM This instance runs qwen2.5vl:7b for image moderation on port 11435

echo Starting Ollama Vision Instance on GPU 1 (port 11435)...

REM Set GPU 1 (3060 Ti) for vision model
set CUDA_VISIBLE_DEVICES=1
set OLLAMA_HOST=127.0.0.1:11435

REM Start a second Ollama instance
"%LOCALAPPDATA%\Programs\Ollama\ollama.exe" serve

pause

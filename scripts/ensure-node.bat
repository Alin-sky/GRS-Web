@echo off
REM ============================================================
REM  ensure-node.bat - make sure Node.js >= 22.5.0 is available
REM  Priority: local portable -> system Node -> auto download
REM  Called via "call", so PATH changes propagate to the caller.
REM  NOTE: ASCII-only + CRLF on purpose. Multi-byte characters in
REM  a batch file make cmd.exe mis-parse the byte stream and
REM  spawn garbage commands like "'xx' is not recognized".
REM ============================================================

set "NODE_VERSION=22.22.2"
set "MIN_NODE_VERSION=22.5.0"

REM Locate project root (this file lives in <root>\scripts\).
set "PROJECT_ROOT=%~dp0.."
for %%i in ("%PROJECT_ROOT%") do set "PROJECT_ROOT=%%~fi"
set "RUNTIME_NODE=%PROJECT_ROOT%\runtime\node"
set "TMP_NODE_ZIP=%TEMP%\grs-node-v%NODE_VERSION%-win-x64.zip"
set "TMP_NODE_DIR=%TEMP%\grs-node-v%NODE_VERSION%-win-x64"

REM [1] Local portable Node.js first.
if exist "%RUNTIME_NODE%\node.exe" goto :use_portable

REM [2] System Node.js version check.
where node >nul 2>&1
if errorlevel 1 goto :download

for /f "tokens=*" %%v in ('node --version 2^>nul') do set "SYS_NODE_VER=%%v"
if not defined SYS_NODE_VER goto :download

powershell -NoProfile -ExecutionPolicy Bypass -Command "$v='%SYS_NODE_VER%' -replace '^v',''; $parts=$v.Split('.'); if($parts.Length -lt 3){ exit 1 }; $major=[int]$parts[0]; $minor=[int]$parts[1]; $patch=[int]$parts[2]; $need='%MIN_NODE_VERSION%'.Split('.'); if($major -gt [int]$need[0]){ exit 0 }; if($major -lt [int]$need[0]){ exit 1 }; if($minor -gt [int]$need[1]){ exit 0 }; if($minor -lt [int]$need[1]){ exit 1 }; if($patch -ge [int]$need[2]){ exit 0 } else { exit 1 }"
if errorlevel 1 goto :download

echo [ensure-node] Using system Node.js %SYS_NODE_VER%
exit /b 0

:use_portable
set "PATH=%RUNTIME_NODE%;%PATH%"
echo [ensure-node] Using local portable Node.js
"%RUNTIME_NODE%\node.exe" --version
exit /b 0

REM [3] Download portable Node.js (mirror first, official as fallback).
:download
echo [ensure-node] Node.js ^>= %MIN_NODE_VERSION% not found, downloading portable v%NODE_VERSION% ...

set "DL_PRIMARY=https://npmmirror.com/mirrors/node/v%NODE_VERSION%/node-v%NODE_VERSION%-win-x64.zip"
set "DL_FALLBACK=https://nodejs.org/dist/v%NODE_VERSION%/node-v%NODE_VERSION%-win-x64.zip"

if exist "%TMP_NODE_ZIP%" del /f /q "%TMP_NODE_ZIP%" >nul 2>&1
if exist "%TMP_NODE_DIR%" rmdir /s /q "%TMP_NODE_DIR%" >nul 2>&1

echo [ensure-node] Trying mirror: %DL_PRIMARY%
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ensure-node-download.ps1" -Url "%DL_PRIMARY%" -OutFile "%TMP_NODE_ZIP%" -TimeoutSec 300
if errorlevel 1 (
  echo [ensure-node] Mirror download failed, trying official source...
  if exist "%TMP_NODE_ZIP%" del /f /q "%TMP_NODE_ZIP%" >nul 2>&1
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ensure-node-download.ps1" -Url "%DL_FALLBACK%" -OutFile "%TMP_NODE_ZIP%" -TimeoutSec 300
)
if errorlevel 1 goto :fail
if not exist "%TMP_NODE_ZIP%" goto :fail

echo [ensure-node] Extracting...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Expand-Archive -Path '%TMP_NODE_ZIP%' -DestinationPath '%TEMP%' -Force; $src=Join-Path '%TEMP%' ('node-v' + '%NODE_VERSION%' + '-win-x64'); if(-not (Test-Path (Join-Path $src 'node.exe'))){ Write-Host '[ensure-node] node.exe not found in archive'; exit 1 }; $target='%RUNTIME_NODE%'; New-Item -ItemType Directory -Force -Path $target | Out-Null; Copy-Item -Path (Join-Path $src '*') -Destination $target -Recurse -Force; Remove-Item $src -Recurse -Force -ErrorAction SilentlyContinue; exit 0"
if errorlevel 1 goto :fail

REM [4] Verify the extracted binary really exists and really runs.
if not exist "%RUNTIME_NODE%\node.exe" goto :fail
"%RUNTIME_NODE%\node.exe" --version >nul 2>&1
if errorlevel 1 goto :fail

if exist "%TMP_NODE_ZIP%" del /f /q "%TMP_NODE_ZIP%" >nul 2>&1

set "PATH=%RUNTIME_NODE%;%PATH%"
echo [ensure-node] Portable Node.js is ready
"%RUNTIME_NODE%\node.exe" --version
exit /b 0

:fail
echo.
echo [ensure-node] ERROR: failed to prepare Node.js automatically.
echo Please install Node.js %MIN_NODE_VERSION% or newer manually:
echo   https://nodejs.org/en/download/
echo Then run start.bat again.
echo.
if exist "%TMP_NODE_ZIP%" del /f /q "%TMP_NODE_ZIP%" >nul 2>&1
if exist "%TMP_NODE_DIR%" rmdir /s /q "%TMP_NODE_DIR%" >nul 2>&1
exit /b 1

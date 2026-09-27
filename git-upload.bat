@echo off
title GRS Git Upload
cd /d "%~dp0"
REM ============================================================
REM  git-upload.bat - one-click upload to GitHub
REM  ASCII-only + CRLF on purpose (see scripts\ensure-node.bat header).
REM ============================================================

echo ========================================
echo   GRS Git Upload - push to GitHub
echo ========================================
echo.

echo [1/5] Staging changes...
REM R11/T06: prompt bodies are local-only and must NOT be pushed (see .gitignore).
git add -A -- ":!nul" ":!prompts"
if errorlevel 1 goto :error
REM Only the README + *.example.md skeletons inside prompts/ may be tracked (optional - soft fail).
git add -- "prompts/README.md" "prompts/*.example.md" >nul 2>nul || echo [WARN] prompts skeletons not staged (optional)
echo [OK] Staged
echo.

echo [2/5] Sensitive file check (soft warning)...
git diff --cached --name-only | findstr /i /c:"config" /c:"sensitive_words" /c:".env" /c:"prompts" >nul
if errorlevel 1 goto :nosensitive
echo.
echo [WARN] Sensitive files are staged:
echo   config\default.json / sensitive_words.json / .env
echo   prompts\*.md (prompt bodies must stay local - do not commit)
echo   These may contain API keys, passwords or word lists.
echo   Please check .gitignore before continuing.
echo   You may ignore this warning if it is a false positive.
echo   (This step is a WARN only. Step [4/5] is the hard BLOCK.)
echo.
:nosensitive

git diff --cached --quiet
if not errorlevel 1 goto :nocommit

echo [3/5] Committing...
git commit -m "sync: %date% %time%"
if errorlevel 1 goto :error
echo [OK] Committed
echo.

REM ============================================================
REM  [4/5] INTEGRITY GATE - hard block, runs AFTER commit and
REM    immediately BEFORE push, so HEAD is exactly what gets pushed.
REM  Why this exists: this script is incremental-commit + direct push.
REM    A tree can silently omit source files that never got staged,
REM    and the script would still report [OK] Done. The prompt below
REM    also offers a FORCE push on failure, which would overwrite a
REM    working remote tree with a broken one.
REM  This gate differs from step [2/5]: [2/5] only warns; [4/5] blocks.
REM ============================================================
echo [4/5] Integrity gate (hard block)...

REM  Check 1: no untracked, non-ignored source files may remain.
REM    After `git add -A`, anything still untracked under src/ means
REM    the add silently skipped it. This is the precise tripwire.
git ls-files --others --exclude-standard -- src/ > "%TEMP%\grs_gate_untracked.txt" 2>nul
findstr /r "." "%TEMP%\grs_gate_untracked.txt" >nul 2>nul
if not errorlevel 1 goto :gateuntracked
del "%TEMP%\grs_gate_untracked.txt" >nul 2>nul
echo   untracked src files: none

REM  Check 2: src/ file count floor. Disk src/ has 62 files; the
REM    historic low was 57. Threshold 60 is a backstop tripwire for a
REM    mass-omission that somehow left nothing untracked.
REM    Counting uses a pure-batch loop on purpose: a bare `find` in
REM    this shell resolves to Git's GNU find and scans the C: drive.
set "SRCN=0"
for /f "usebackq delims=" %%L in (`git ls-tree -r HEAD --name-only -- src/`) do set /a SRCN+=1
echo   src/ files in HEAD tree: %SRCN% (minimum 60)
if %SRCN% LSS 60 goto :gatecount

REM  Check 3: sensitive files must never enter the tree.
REM    config/default.json holds the real key (the repo should only
REM    carry config/default.example.json). *.bak-* holds a real
REM    Aliyun AccessKey.
git ls-tree -r HEAD --name-only > "%TEMP%\grs_gate_tree.txt" 2>nul
findstr /i /c:"config/default.json" /c:".env" /c:".bak-" /c:"sensitive_words.json" "%TEMP%\grs_gate_tree.txt" > "%TEMP%\grs_gate_hits.txt" 2>nul
if not errorlevel 1 goto :gatesensitive
del "%TEMP%\grs_gate_hits.txt" >nul 2>nul
del "%TEMP%\grs_gate_tree.txt" >nul 2>nul
echo   sensitive files in HEAD tree: none

REM  Check 4: text hygiene - raw control / invisible characters.
REM    These bytes make a file impossible to round-trip through GBK:
REM    U+200B becomes U+FFFD + "?", and that "?" next to "-" builds a
REM    bogus regex range. src/security/output-schema.js was verified to
REM    sit on the main branch carrying 15 such bytes - the gate below is
REM    what stops that from being pushed again. pre-publish-check.js
REM    already implements rule 3.6 (severity=error); this step just
REM    makes the gate actually call it.
REM    Scans ONLY tracked files (pre-publish-check.js defaults to
REM    `git ls-files`, i.e. exactly the publish set). This matters: the
REM    walk mode (--no-git) descends into wd14\.venv and buries the real
REM    errors under tens of thousands of .pyc noise hits.
REM    Run AFTER `git add -A`: index content == disk content == what the
REM    push would send, so disk-vs-HEAD drift cannot hide a bad byte.
call :findnode
if not defined NODE_EXE goto :gatehygskipped
"%NODE_EXE%" "scripts\pre-publish-check.js" --max-fail=error > "%TEMP%\grs_gate_hyg.txt" 2>&1
if errorlevel 1 goto :gatehygiene
echo   text hygiene: clean
goto :gateok

:gatehygskipped
echo   [WARN] Node.js not found - hygiene scan SKIPPED (see scripts\ensure-node.bat)
goto :gateok

:gatehygiene
echo.
echo [BLOCK] pre-publish-check reported error-level findings in the tree to be pushed.
REM  Print EVERY error line, not just HYGIENE ones: filtering to a single
REM  rule silently swallowed unrelated errors (VERSION/coupling-check-failed)
REM  during testing, leaving the operator with no reason at all.
findstr /i /r /c:"^ *error " "%TEMP%\grs_gate_hyg.txt" > "%TEMP%\grs_gate_hyg2.txt" 2>nul
if errorlevel 1 findstr /i /c:"error" "%TEMP%\grs_gate_hyg.txt" > "%TEMP%\grs_gate_hyg2.txt" 2>nul
type "%TEMP%\grs_gate_hyg2.txt"
echo.
echo   Full report is in %TEMP%\grs_gate_hyg.txt
del "%TEMP%\grs_gate_hyg2.txt" >nul 2>nul
goto :gatefail

:gateok
echo [OK] Gate passed
echo.
goto :pushstep

REM ---- locate a usable node.exe: project portable first, then PATH ----
:findnode
set "PROJECT_ROOT=%~dp0"
for %%i in ("%PROJECT_ROOT%") do set "PROJECT_ROOT=%%~fi"
set "NODE_EXE="
if exist "%PROJECT_ROOT%\runtime\node\node.exe" set "NODE_EXE=%PROJECT_ROOT%\runtime\node\node.exe"
if defined NODE_EXE goto :eof
for /f "delims=" %%n in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%n"
goto :eof

:gateuntracked
echo.
echo [BLOCK] These src files are on disk but NOT tracked in HEAD:
type "%TEMP%\grs_gate_untracked.txt"
del "%TEMP%\grs_gate_untracked.txt" >nul 2>nul
goto :gatefail

:gatecount
echo.
echo [BLOCK] src/ file count in HEAD tree is below the safety floor.
echo   counted=%SRCN%  minimum=60
echo   A tree this sparse usually means a mass-omission.
goto :gatefail

:gatesensitive
echo.
echo [BLOCK] Sensitive files found in HEAD tree:
type "%TEMP%\grs_gate_hits.txt"
del "%TEMP%\grs_gate_hits.txt" >nul 2>nul
goto :gatefail

:gatefail
echo.
echo ========================================
echo   [BLOCKED] Integrity gate failed.
echo   Push was NOT attempted. The remote is untouched.
echo ========================================
echo   The local commit was still created, so nothing is lost.
echo   Inspect:  git ls-tree -r HEAD --name-only -- src/
echo   Then fix the omission and re-run this script.
echo.
exit /b 1

:pushstep
echo [5/5] Pushing to GitHub...
git push origin main
if errorlevel 1 goto :pushfail
goto :pushdone

:pushfail
echo.
echo [WARN] Normal push failed. Common causes:
echo   1. No network - check your proxy (can the browser open github.com?)
echo   2. Remote history diverged from local (first sync, or remote changed)
echo.
set "FORCE="
set /p FORCE=Force push to overwrite remote? Type y to confirm, Enter to skip:
if /i not "%FORCE%"=="y" goto :error
echo.
echo Force pushing (local state wins)...
git push -f origin main
if errorlevel 1 goto :error

:pushdone
echo [OK] Pushed

echo.
echo ========================================
echo   [OK] Done. Uploaded to GitHub.
echo ========================================
echo.
exit /b 0

:nocommit
echo.
echo   Nothing to commit.
echo   To pull remote updates: git pull origin main
echo.
exit /b 0

:error
echo.
echo ========================================
echo   [FAIL] Operation failed. See the errors above.
echo ========================================
echo.
exit /b 1

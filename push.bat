@echo off
title GRS Git Sync
cd /d "%~dp0"

REM ============================================================
REM  push.bat - pull remote updates, then push local commits.
REM  ASCII-only + CRLF on purpose (see scripts\ensure-node.bat header).
REM
REM  Why this file no longer pushes directly:
REM    It used to run `git push origin main` on its own, which made it a
REM    bypass around the integrity gate in git-upload.bat. A tree with
REM    missing files or corrupt bytes could be pushed from here with no
REM    check at all. All pushes must go through the gate now.
REM ============================================================

echo ========================================
echo   GRS Git Sync - Pull then Push
echo ========================================
echo.

echo [1/3] Fetching remote updates...
git fetch origin
if errorlevel 1 goto :error
echo [OK] Fetch complete
echo.

echo [2/3] Merging remote changes...
git merge origin/main --no-edit --ff-only
if errorlevel 1 goto :error
echo [OK] Merge complete
echo.

echo [3/3] Handing off to the gated uploader...
echo   (push.bat does NOT push by itself - the integrity gate lives in
echo    git-upload.bat and would be bypassed otherwise.)
call "%~dp0git-upload.bat"
if errorlevel 1 goto :error
goto :done

:done
echo.
echo ========================================
echo   [OK] All done!
echo ========================================
echo.
pause
exit /b 0

:error
echo.
echo ========================================
echo   [FAIL] Operation failed
echo   If the failure came from the integrity gate, nothing was pushed
echo   and the remote is untouched. Read the [BLOCK] reasons above.
echo ========================================
echo.
pause
exit /b 1
@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM  rollback.bat - restore pre-refactor code from .backup
REM  ASCII-only + CRLF on purpose (see ensure-node.bat header).
REM ============================================================

echo ============================================================
echo   Plugin system refactor rollback
echo   Restore original code from .backup\pre-plugin-refactor-20260905
echo ============================================================
echo.

set "ROOT=%~dp0.."
set "BAK=%ROOT%\.backup\pre-plugin-refactor-20260905"

if not exist "%BAK%" (
  echo [ERROR] Backup folder not found: %BAK%
  echo Please make sure .backup\pre-plugin-refactor-20260905\ is in place.
  echo.
  exit /b 1
)

echo [INFO] The following will be overwritten by the backup:
echo    - src\        plugin system source (reverted to pre-refactor)
echo    - plugins\    plugin directory (reverted to pre-refactor)
echo    - public\     frontend pages (reverted to pre-refactor)
echo    - config\     config files
echo    - package.json / package-lock.json
echo.
echo [WARN] Files added or modified by the refactor will be removed or
echo        reverted. This operation cannot be undone.
echo        (data\ is NOT included; runtime data is preserved)
echo.
set "CONFIRM="
set /p CONFIRM=Type Y to confirm rollback, anything else to cancel:
if /i not "%CONFIRM%"=="Y" (
  echo Cancelled.
  echo.
  endlocal
  exit /b 0
)

echo.
echo [1/6] Stopping running services...
taskkill /F /IM node.exe >nul 2>&1

echo [2/6] Rolling back src\ ...
robocopy "%BAK%\src" "%ROOT%\src" /MIR /NFL /NDL /NJH /NJS /NP >nul

echo [3/6] Rolling back plugins\ ...
robocopy "%BAK%\plugins" "%ROOT%\plugins" /MIR /NFL /NDL /NJH /NJS /NP >nul

echo [4/6] Rolling back public\ ...
robocopy "%BAK%\public" "%ROOT%\public" /MIR /NFL /NDL /NJH /NJS /NP >nul

echo [5/6] Rolling back config\ ...
robocopy "%BAK%\config" "%ROOT%\config" /MIR /NFL /NDL /NJH /NJS /NP >nul

echo [6/6] Rolling back package.json / package-lock.json ...
copy /Y "%BAK%\package.json" "%ROOT%\package.json" >nul
copy /Y "%BAK%\package-lock.json" "%ROOT%\package-lock.json" >nul

echo.
echo ============================================================
echo   Rollback finished.
echo   Next steps:
echo     1. Sync dependencies:  npm install
echo     2. Start the service:  node src\server.js
echo ============================================================
echo.
endlocal

@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo   WD14 Tagger Service (anime image tagging)
echo   Port: 9898  -  runs on CPU, no GPU required
echo ==========================================
echo.

rem Keep the venv isolated: a host-injected PYTHONPATH can load a foreign
rem sitecustomize.py that hooks os.unlink, which makes pip abort mid-install.
set "PYTHONPATH="

set "VENV=%~dp0wd14\.venv"
set "PY=%VENV%\Scripts\python.exe"

rem ---- Fast path: only when the venv can REALLY import its deps.
rem      Checking that python.exe merely exists is not enough: a venv can be
rem      created without pip (empty Scripts, no site-packages), which used to
rem      make this script skip setup and fail later with ModuleNotFoundError.
if not exist "%PY%" goto :setup
"%PY%" -c "import fastapi,uvicorn,PIL,onnxruntime;from imgutils.tagging import get_wd14_tags" >nul 2>nul
if errorlevel 1 goto :setup
goto :run

:setup
echo [wd14] Preparing Python environment in wd14\.venv
echo.
if exist "%PY%" goto :repair

set "BASEPY="
py -3.11 -c "import sys" >nul 2>nul
if %errorlevel%==0 set "BASEPY=py -3.11"
if defined BASEPY goto :havepy
py -3.12 -c "import sys" >nul 2>nul
if %errorlevel%==0 set "BASEPY=py -3.12"
if defined BASEPY goto :havepy
py -3 -c "import sys" >nul 2>nul
if %errorlevel%==0 set "BASEPY=py -3"
if defined BASEPY goto :havepy
python -c "import sys" >nul 2>nul
if %errorlevel%==0 set "BASEPY=python"
:havepy
if not defined BASEPY goto :nopython

echo [wd14] Using interpreter: %BASEPY%
%BASEPY% -m venv "%~dp0wd14\.venv"
if errorlevel 1 goto :fail

:repair
"%PY%" -m pip --version >nul 2>nul
if not errorlevel 1 goto :install
echo [wd14] pip is missing in the virtual environment, repairing ...
"%PY%" -m ensurepip --upgrade --default-pip
if errorlevel 1 goto :fail

:install
echo [wd14] Installing dependencies (one time, several hundred MB) ...
"%PY%" -m pip install --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple
rem NOTE: the anime tagging library is published on PyPI as "dghs-imgutils"
rem (its import name is "imgutils"). The plain "imgutils" package is an
rem unrelated utility by a different author and does NOT provide
rem imgutils.tagging, so it must never be used here.
"%PY%" -m pip install fastapi uvicorn pillow onnxruntime dghs-imgutils -i https://pypi.tuna.tsinghua.edu.cn/simple
if errorlevel 1 goto :fail
echo [wd14] Dependencies installed.
echo.

:run
echo [wd14] Starting service on http://127.0.0.1:9898
echo [wd14] The model is preloaded in the background at startup (mirror: hf-mirror.com).
echo [wd14] Expect roughly 10-90s before the model is ready - GET /health reports
echo [wd14] status/ready/phase meanwhile. Toggle with WD14_PRELOAD=1 (default, async),
echo [wd14] WD14_PRELOAD=0 (lazy, load on first request) or WD14_PRELOAD=sync (blocking).
echo.
"%PY%" "%~dp0wd14\wd14_service.py" %*
goto :end

:nopython
echo [wd14] ERROR: Python 3 was not found.
echo        Install Python 3.11 or 3.12 from https://www.python.org/downloads/
echo        Tick "Add python.exe to PATH" during setup, then run this script again.
echo.
pause
exit /b 1

:fail
echo.
echo [wd14] ERROR: setup failed. Read the messages above.
echo.
pause
exit /b 1

:end
pause

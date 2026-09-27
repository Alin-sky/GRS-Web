@echo off
echo ========================================
echo   Set OLLAMA_MODELS at System Level
echo   Right-click this file -> Run as admin
echo ========================================
echo.

:: This requires admin - it will fail without it
setx OLLAMA_MODELS "<模型目录>" /M
if %errorlevel% equ 0 (
    echo.
    echo SUCCESS! System-level env var set.
    echo All programs will now use <模型目录>
    echo You can delete this file.
) else (
    echo.
    echo FAILED - you need to run this as Administrator!
    echo Right-click this .bat file -> "Run as administrator"
)

echo.
pause

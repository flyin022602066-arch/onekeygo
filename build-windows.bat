@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 20 or newer is required.
  pause
  exit /b 1
)

echo [1/2] Installing dependencies...
call npm run setup
if errorlevel 1 goto :failed

echo [2/2] Building Windows installer...
call npm run desktop:dist
if errorlevel 1 goto :failed

echo.
echo Build completed. Output: desktop\release
pause
exit /b 0

:failed
echo.
echo [ERROR] Build failed. Review the output above.
pause
exit /b 1

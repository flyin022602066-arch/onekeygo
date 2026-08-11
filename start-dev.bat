@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 20 or newer is required.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm is required. Please install Node.js 20 or newer.
  pause
  exit /b 1
)

if not exist "backend\node_modules" (
  echo [ERROR] Dependencies are missing. Run: npm run setup
  pause
  exit /b 1
)
if not exist "frontend\node_modules" (
  echo [ERROR] Dependencies are missing. Run: npm run setup
  pause
  exit /b 1
)
if not exist "desktop\node_modules" (
  echo [ERROR] Dependencies are missing. Run: npm run setup
  pause
  exit /b 1
)

echo Starting Mijing Studio development build...
call npm run desktop:dev
if errorlevel 1 (
  echo.
  echo [ERROR] Development desktop failed to start.
  pause
  exit /b 1
)

endlocal

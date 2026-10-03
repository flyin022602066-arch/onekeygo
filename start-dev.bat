@echo off
setlocal
cd /d "%~dp0"

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

rem Keep the source Electron instance independent from a packaged instance,
rem while explicitly sharing the production project database and media.
set "MIJING_DEV_MODE=1"
rem APPDATA can be redirected by a shell or the Codex host; USERPROFILE is
rem stable for the Windows account that owns the packaged app's data.
set "MIJING_DATA_DIR=%USERPROFILE%\AppData\Roaming\onekeygo-studio-desktop"
echo Starting the latest source build with the existing project database...
call npm run desktop:dev
if errorlevel 1 (
  echo.
  echo [ERROR] Development desktop failed to start.
  pause
  exit /b 1
)
endlocal

@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.13 or newer is required.
  pause
  exit /b 1
)
if not exist node_modules\playwright-core\package.json goto install
if not exist node_modules\fflate\package.json goto install
if not exist node_modules\@garmin\fitsdk\package.json goto install
if not exist node_modules\@xmldom\xmldom\package.json goto install
goto run
:install
  call npm.cmd ci --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
:run
node server.mjs
if errorlevel 1 pause

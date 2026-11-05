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
if not exist node_modules\vue\package.json goto install
if not exist node_modules\element-plus\package.json goto install
if not exist node_modules\maplibre-gl\package.json goto install
if not exist node_modules\vite\package.json goto install
if not exist node_modules\@vitejs\plugin-vue\package.json goto install
goto run
:install
  call npm.cmd ci --include=dev --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
:run
call npm.cmd start
if errorlevel 1 pause

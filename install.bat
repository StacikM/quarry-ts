@echo off
rem Interactive installer for Quarry.ts (Windows): checks Node.js, installs, builds,
rem then asks how you want the server set up. Double-click it, or run:  install.bat
setlocal
cd /d "%~dp0"

echo === Quarry.ts installer (Minecraft 1.21.11) ===

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Quarry.ts needs Node.js 24 or newer: https://nodejs.org/
  goto :failed
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 (
  for /f %%v in ('node --version') do echo Your Node.js is %%v, but Quarry.ts needs version 24 or newer: https://nodejs.org/
  goto :failed
)
where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. It normally comes with Node.js: https://nodejs.org/
  goto :failed
)

echo.
echo Installing dependencies (this can take a minute)...
call npm install --no-audit --no-fund
if errorlevel 1 goto :failed

echo.
echo Building the server...
call npm run build
if errorlevel 1 goto :failed

node scripts\setup.cjs
if errorlevel 1 goto :failed

echo.
set "START=Y"
set /p "START=Start the server now? [Y/n] "
if /i "%START:~0,1%"=="n" (
  echo Start it later with:  npm start
  goto :end
)
call npm start
goto :end

:failed
echo.
echo Installation did not finish. Fix the problem above and run install.bat again.
pause
exit /b 1

:end
endlocal

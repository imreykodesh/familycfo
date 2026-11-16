@echo off
rem FamilyCFO - double-click to build and start the app, then open it in the browser.
rem Close this window (or press Ctrl+C) to stop it. Options: start-windows.cmd --skip-build / --demo / --no-open
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title FamilyCFO

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)

node scripts\start.mjs %*
if errorlevel 1 (
  echo.
  echo FamilyCFO stopped with an error - see the messages above.
  pause
  exit /b 1
)
endlocal

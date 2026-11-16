@echo off
rem FamilyCFO: builds the Windows installer (release\FamilyCFO-<version>-x64.exe). Double-click to run.
setlocal
cd /d "%~dp0"
set CSC_IDENTITY_AUTO_DISCOVERY=false
set PUPPETEER_SKIP_DOWNLOAD=1

if not exist node_modules (
  echo [0/4] Installing dependencies...
  call npm ci --ignore-scripts || goto :fail
  call npm --prefix web ci || goto :fail
)

echo [1/4] Building the web UI...
call npm --prefix web run build || goto :fail

echo [2/4] Bundling the desktop app...
call npm run desktop:bundle || goto :fail

echo [3/4] Building the installer...
call npx electron-builder --win --x64 --publish never
set BUILD_ERR=%ERRORLEVEL%

echo [4/4] Restoring better-sqlite3 for Node...
call npm rebuild better-sqlite3
if not "%BUILD_ERR%"=="0" goto :fail

echo.
echo Done. The installer is in the release folder.
start "" "%~dp0release"
pause
exit /b 0

:fail
echo.
echo BUILD FAILED - see the messages above.
pause
exit /b 1

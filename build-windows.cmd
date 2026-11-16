@echo off
rem FamilyCFO: builds the Windows installer (release\FamilyCFO-<version>-x64.exe). Double-click to run.
setlocal
cd /d "%~dp0"
set CSC_IDENTITY_AUTO_DISCOVERY=false
set PUPPETEER_SKIP_DOWNLOAD=1

if not exist node_modules (
  echo [0/5] Installing dependencies...
  call npm ci --ignore-scripts || goto :fail
  call npm --prefix web ci || goto :fail
)

echo [1/5] Checking the code (typecheck: API + desktop)...
call npm run typecheck || goto :fail

echo [2/5] Building the web UI (typecheck + build)...
call npm --prefix web run build || goto :fail

echo [3/5] Bundling the desktop app...
call npm run desktop:bundle || goto :fail

rem the previous unpacked app can stay locked (antivirus / file watchers): move it aside so the build can recreate it
if exist release\win-unpacked (
  if exist release\win-unpacked-old rmdir /s /q release\win-unpacked-old
  ren release\win-unpacked win-unpacked-old
  rmdir /s /q release\win-unpacked-old 2>nul
)

echo [4/5] Building the installer...
call npx electron-builder --win --x64 --publish never
set BUILD_ERR=%ERRORLEVEL%

echo [5/5] Restoring better-sqlite3 for Node...
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

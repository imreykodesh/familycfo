@echo off
rem Double-click launcher for git-sync.ps1 (two-way smart sync: pull, and push if there is anything to push). Works from any project root.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0git-sync.ps1" %*

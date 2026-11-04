@echo off
title PSG Project Controls
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
echo Starting PSG Project Controls... leave this window open while you use it.
start "" http://localhost:3000
node server.js
pause

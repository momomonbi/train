@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22以降をインストールして、もう一度実行してください。
  echo https://nodejs.org/
  pause
  exit /b 1
)
echo ブラウザーで http://127.0.0.1:8780 を開いてください。
node server.mjs
pause

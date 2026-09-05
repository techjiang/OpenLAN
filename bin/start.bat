@echo off
chcp 65001 >nul
title OpenLAN - 局域网急速传输
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 https://nodejs.org 18+ 版本
  pause
  exit /b 1
)
if not exist node_modules\qrcode (
  echo [初始化] 首次运行正在安装依赖，请稍候...
  call npm install --no-audit --no-fund
)
node server/index.js %*
pause

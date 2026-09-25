@echo off
chcp 65001 >nul
title 本地密码库
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo 请先安装 Node.js 24，然后重新运行。
  pause
  exit /b 1
)
node scripts\launch.mjs
if errorlevel 1 pause

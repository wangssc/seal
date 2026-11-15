@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   Seal 发布（跑一次就够）
echo   ----------------------------------------------------------
echo   需要先放一个 token.txt 在本目录，两行：
echo     第一行：GitHub 个人访问令牌（classic，勾 repo）
echo     第二行：npm 令牌（不发布 npm 就留空）
echo   生成地址：https://github.com/settings/tokens
echo.
if not exist token.txt (
  echo   [!] 没有 token.txt，先把令牌写进去再双击这个文件。
  echo.
  pause
  exit /b 1
)
node publish.js
echo.
pause

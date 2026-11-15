@echo off
rem UTF-8 batch: cmd mis-reads a batch whose codepage changes mid-file, so re-enter
rem ourselves once under 65001 and do the real work in the child.
if /i not "%~1"=="run" (
  "%SystemRoot%\System32\chcp.com" 65001 >nul
  cmd /c ""%~f0" run"
  exit /b
)

setlocal
title seal demo
set "SEAL=%~dp0..\bin\seal.js"
set "BOX=%~dp0sandbox"

echo.
echo ======== seal 演示 ========
echo 造一个假的交付：两个文件，盖章。然后改一个字节，让甲方来验。
echo.

if exist "%BOX%" rd /s /q "%BOX%"
md "%BOX%"
> "%BOX%\quote.md" echo # 报价单 v3
>>"%BOX%\quote.md" echo 含税合计 12800 元
> "%BOX%\tax.js" echo module.exports = { rate: 0.06 };

cd /d "%BOX%"

echo [1/4] 交付物就这两个文件：
dir /b
echo.
echo [2/4] 盖章
node "%SEAL%"
echo.
echo [3/4] 偷偷改一个字节（quote.md 最后一个字节异或 1，肉眼看不出）
node -e "const fs=require('fs');const f='quote.md';const b=fs.readFileSync(f);b[b.length-1]^=1;fs.writeFileSync(f,b)"
echo.
echo [4/4] 甲方来验
node "%SEAL%" verify
echo.
echo 凭证：%BOX%\seal-out\receipt.json
echo 这就是它存在的理由：文件被人动了一个字节，凭证当场指出来，不用翻聊天记录。
if not "%SEAL_DEMO_NOPAUSE%"=="1" pause

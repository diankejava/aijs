@echo off
:: 将控制台代码页切换为 UTF-8，以正确显示中文字符
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ================================
echo    Git Push Retry Script
echo ================================

:: 检查当前目录是否为 Git 仓库
git rev-parse --is-inside-work-tree >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] 当前目录不是一个 Git 仓库，请切换到正确的目录。
    pause
    exit /b 1
)

set count=0

:loop
set /a count+=1
echo [第 !count! 次尝试] 正在执行 git push ...
git push

if %errorlevel% equ 0 (
    echo [SUCCESS] 推送成功！
    goto end
) else (
    echo [FAIL] 推送失败，等待 10 秒后重试...
    timeout /t 10 /nobreak >nul
    goto loop
)

:end
echo 操作完成。
endlocal
pause
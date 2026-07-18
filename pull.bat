@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM 切换到你的 Git 仓库目录（按实际路径修改）
@REM cd /d "D:\MyRepo"

set RETRY=0
:loop
set /a RETRY+=1
echo [%date% %time%] 第 !RETRY! 次尝试: git pull origin main ...
git pull origin main

if !errorlevel! equ 0 (
    echo 拉取成功！
    goto :success
) else (
    echo 拉取失败，错误码: !errorlevel!，10秒后重试...
    timeout /t 10 /nobreak >nul
    goto :loop
)

:success
endlocal
exit /b 0
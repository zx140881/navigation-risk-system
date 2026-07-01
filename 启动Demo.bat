@echo off
chcp 65001 >nul
title 船舶态势预警系统 Demo 启动器
echo.
echo ====================================================
echo   船舶态势数字映射与动态风险预警系统  DEMO v6.2
echo ====================================================
echo.

:: 检查 Python 是否安装
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Python，请先安装 Python 3.x
    echo 下载地址: https://www.python.org/downloads/
    echo.
    echo 安装时请勾选 "Add Python to PATH"
    pause
    exit /b 1
)

echo [信息] 正在启动本地服务器...
echo.
echo ----------------------------------------------------
echo   启动成功后，请在浏览器中访问以下地址：
echo.
echo     本机访问:  http://localhost:8888/demo.html
echo.
echo   如果需要局域网内其他人访问，请使用：
echo.
echo     局域网访问: http://你的局域网IP:8888/demo.html
echo     (在cmd中输入 ipconfig 可查看你的局域网IP)
echo.
echo   按 Ctrl+C 可停止服务器
echo ----------------------------------------------------
echo.

cd /d "%~dp0"
python -m http.server 8888 --bind 0.0.0.0 --directory "%~dp0"
pause

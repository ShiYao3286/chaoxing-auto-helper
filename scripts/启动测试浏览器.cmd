@echo off
chcp 65001 >nul
setlocal

rem ============================================================
rem  一键启动测试浏览器（已加载本扩展）
rem  用法：双击本文件
rem  需要：Edge 浏览器
rem ============================================================

cd /d "%~dp0.."

set "EXT_DIR=%CD%\extension"
set "PROFILE=%TEMP%\csworker_test_profile"
set "PORT=9335"

if not exist "%EXT_DIR%\manifest.json" (
    echo [错误] 找不到扩展目录：%EXT_DIR%
    echo 请在仓库根目录运行本脚本。
    pause
    exit /b 1
)

echo ============================================================
echo  启动测试浏览器
echo ============================================================
echo  扩展目录：%EXT_DIR%
echo  调试端口：%PORT%
echo  用户配置：%PROFILE%
echo.

rem 找 Edge
set "EDGE="
for %%P in (
    "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
    "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do (
    if exist %%P set "EDGE=%%~P"
)

if "%EDGE%"=="" (
    echo [提示] 没找到 Edge，尝试使用 Chrome...

    for %%P in (
        "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
        "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
    ) do (
        if exist %%P set "EDGE=%%~P"
    )
)

if "%EDGE%"=="" (
    echo [错误] 没找到 Edge 或 Chrome。
    echo 请手动启动浏览器并加上这些参数：
    echo   --remote-debugging-port=%PORT%
    echo   --load-extension="%EXT_DIR%"
    echo   --disable-extensions-except="%EXT_DIR%"
    pause
    exit /b 1
)

echo 使用浏览器：%EDGE%
echo.

start "" "%EDGE%" ^
  --remote-debugging-port=%PORT% ^
  --user-data-dir="%PROFILE%" ^
  --load-extension="%EXT_DIR%" ^
  --disable-extensions-except="%EXT_DIR%" ^
  --no-first-run ^
  --no-default-browser-check ^
  about:blank

echo 已启动。等待 6 秒让扩展加载...
timeout /t 6 /nobreak >nul

echo.
echo 验证调试端口...
curl -s http://127.0.0.1:%PORT%/json/version >nul 2>&1
if errorlevel 1 (
    echo [警告] 调试端口 %PORT% 无法访问。
    echo   可能原因：
    echo   1. 浏览器启动失败
    echo   2. 端口被占用
    echo   3. 该浏览器版本不支持远程调试
) else (
    echo 调试端口 OK。
)

echo.
echo ============================================================
echo  下一步：另开一个终端，运行测试
echo ============================================================
echo.
echo   node tests\fontdecoder.test.cjs
echo   node tests\test-api-features.cjs
echo   node tests\test-vision.cjs
echo   node tests\test-screenshot.cjs
echo.
echo  浏览器窗口关闭后，测试环境自动失效。
echo ============================================================
echo.
pause

@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

rem ============================================================
rem  跑全部测试（17 组 / 381 项）
rem  用法：先双击「启动测试浏览器.cmd」，等浏览器起来后双击本文件
rem
rem  说明：
rem   - 静态服务用 tests\static-server.cjs（自写，不依赖 npx http-server）
rem   - 端到端脚本版测试不需要扩展，但也用同一个浏览器实例
rem ============================================================

cd /d "%~dp0.."

echo ============================================================
echo  学习通自动学习助手 · 全量测试
echo ============================================================
echo.

set PASS=0
set FAIL=0

rem ---------- 启动依赖服务 ----------
echo [准备] 启动静态服务 + mock API
echo ------------------------------------------------------------
start /b node tests\static-server.cjs 8793 >nul 2>&1
start /b node tests\static-server.cjs 8792 >nul 2>&1
start /b node tests\mock-api.cjs 9911 >nul 2>&1
timeout /t 3 /nobreak >nul
echo 完成
echo.

rem ---------- 1. 内核与构建（纯 Node）----------
echo [1/4] 内核单元测试
echo ------------------------------------------------------------
node tests\core.test.cjs
if errorlevel 1 (set /a FAIL+=1) else (set /a PASS+=1)
echo.

echo [2/4] 油猴产物校验
echo ------------------------------------------------------------
node build\build-userscript.cjs
if errorlevel 1 (set /a FAIL+=1) else (set /a PASS+=1)
node tests\test-build.cjs
if errorlevel 1 (set /a FAIL+=1) else (set /a PASS+=1)
echo.

echo [3/4] 扩展设置页结构
echo ------------------------------------------------------------
node tests\test-options-theme.cjs
if errorlevel 1 (set /a FAIL+=1) else (set /a PASS+=1)
echo.

rem ---------- 4. 扩展侧集成 ----------
echo [4/4] 扩展侧集成测试
echo ------------------------------------------------------------
for %%T in (
    test-kernel-health.cjs
    test-api-features.cjs
    test-endpoint-fix.cjs
    test-v13.cjs
    test-panel-queue.cjs
    test-videoquiz.cjs
    test-video-fix.cjs
    test-speed-giveup.cjs
    test-vision.cjs
    test-screenshot.cjs
) do (
    echo   -- %%T
    node tests\%%T
    if errorlevel 1 (set /a FAIL+=1) else (set /a PASS+=1)
)
echo.

rem ---------- 5. 脚本版专属 ----------
echo [附加] 油猴脚本测试
echo ------------------------------------------------------------
for %%T in (
    test-settings-ui.cjs
    test-userscript.cjs
    test-userscript-bus.cjs
) do (
    echo   -- %%T
    node tests\%%T
    if errorlevel 1 (set /a FAIL+=1) else (set /a PASS+=1)
)
echo.

rem ---------- 6. 字体实机（可选）----------
if exist "%WINDIR%\Fonts\simhei.ttf" (
    echo [可选] 字体解码实机准确率
    echo ------------------------------------------------------------
    copy /y "%WINDIR%\Fonts\simhei.ttf" "tests\simhei-lite.ttf" >nul 2>&1
    node tests\cdp-test.cjs
    if errorlevel 1 (set /a FAIL+=1) else (set /a PASS+=1)
    echo.
)

echo ============================================================
echo  结果：%PASS% 组通过，%FAIL% 组失败
echo ============================================================
echo.
echo 提示：
echo   - 如果扩展侧测试失败，确认「启动测试浏览器.cmd」已经跑过
echo   - 静态服务和 mock 是后台进程，可在任务管理器结束 node.exe
echo.
pause

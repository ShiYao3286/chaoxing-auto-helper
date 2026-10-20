@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

rem ============================================================
rem  跑全部测试
rem  用法：先双击「启动测试浏览器.cmd」，等浏览器起来后双击本文件
rem ============================================================

cd /d "%~dp0.."

echo ============================================================
echo  学习通自动学习助手 · 全量测试
echo ============================================================
echo.

set PASS=0
set FAIL=0

echo [1/6] 语法与 manifest 检查
echo ------------------------------------------------------------
node -e "const fs=require('fs'),p=require('path');let f=0;const r='extension';try{const m=JSON.parse(fs.readFileSync(p.join(r,'manifest.json'),'utf8'));console.log('[OK] manifest: '+m.name+' v'+m.version);const refs=[...Object.values(m.icons||{}),m.background?.service_worker,m.action?.default_popup,m.options_page];(m.content_scripts||[]).forEach(c=>(c.js||[]).forEach(x=>refs.push(x)));for(const x of [...new Set(refs)])if(!fs.existsSync(p.join(r,x))){console.log('[MISS] '+x);f++;}}catch(e){console.log('[FAIL] '+e.message);f++;}function w(d){let o=[];for(const x of fs.readdirSync(d,{withFileTypes:true})){const q=p.join(d,x.name);if(x.isDirectory())o=o.concat(w(q));else if(x.name.endsWith('.js'))o.push(q);}return o;}for(const x of w(r)){try{new Function(fs.readFileSync(x,'utf8'));console.log('[OK] '+p.relative(r,x));}catch(e){console.log('[FAIL] '+p.relative(r,x)+': '+e.message);f++;}}process.exit(f?1:0);"
if errorlevel 1 (set /a FAIL+=1) else (set /a PASS+=1)
echo.

echo [2/6] 字体解码器单元测试
echo ------------------------------------------------------------
node tests\fontdecoder.test.cjs
if errorlevel 1 (set /a FAIL+=1) else (set /a PASS+=1)
echo.

echo [3/6] API 功能测试（需要测试浏览器 + mock 服务）
echo ------------------------------------------------------------
node -e "if(!require('fs').existsSync('tests/mock-api.cjs')){process.exit(2)}" >nul 2>&1
start /b node tests\mock-api.cjs 9911 >nul 2>&1
timeout /t 2 /nobreak >nul
node tests\test-api-features.cjs
if errorlevel 1 (set /a FAIL+=1) else (set /a PASS+=1)
echo.

echo [4/6] 截图解题与协同判断
echo ------------------------------------------------------------
start /b npx --yes http-server tests -p 8792 --cors -c-1 >nul 2>&1
timeout /t 3 /nobreak >nul
node tests\test-vision.cjs
if errorlevel 1 (set /a FAIL+=1) else (set /a PASS+=1)
echo.

echo [5/6] 真实截图能力
echo ------------------------------------------------------------
node tests\test-screenshot.cjs
if errorlevel 1 (set /a FAIL+=1) else (set /a PASS+=1)
echo.

echo [6/6] 字体解码实机准确率
echo ------------------------------------------------------------
if exist "%WINDIR%\Fonts\simhei.ttf" (
    copy /y "%WINDIR%\Fonts\simhei.ttf" "tests\simhei-lite.ttf" >nul 2>&1
    start /b npx --yes http-server tests -p 8791 --cors -c-1 >nul 2>&1
    timeout /t 3 /nobreak >nul
    node tests\cdp-test.cjs
    if errorlevel 1 (set /a FAIL+=1) else (set /a PASS+=1)
) else (
    echo [跳过] 系统没有 simhei.ttf
)
echo.

echo ============================================================
echo  结果：%PASS% 组通过，%FAIL% 组失败
echo ============================================================
echo.
echo 提示：
echo   - 如果第 3-6 项失败，确认「启动测试浏览器.cmd」已经跑过
echo   - mock 服务和 http-server 是后台进程，可在任务管理器结束 node.exe
echo.

pause

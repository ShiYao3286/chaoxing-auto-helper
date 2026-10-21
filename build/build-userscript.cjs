#!/usr/bin/env node
/**
 * 构建油猴脚本
 *
 * 把共享内核 + 内容逻辑 + 脚本宿主拼成一个 .user.js。
 *
 * 为什么要构建而不是手写两份：
 *   刷课/答题逻辑有 3800 行，写两份必然漂移。
 *   这里按固定顺序拼接同一批源文件，任何功能改动两个形态同时生效。
 *
 * 用法：node build/build-userscript.cjs [--check]
 *   --check 只校验不写文件（CI 用）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const OUT_DIR = path.join(ROOT, 'userscript');
/**
 * 产物文件名刻意用纯 ASCII
 *
 * 原因：GitHub Actions 的 action-gh-release 处理中文路径时会把文件名截成
 * "user.js"（丢掉中文部分），用户下载后看到一个没有辨识度的文件。
 * 扩展包叫 chaoxing-auto-helper.zip，脚本叫 chaoxing-auto-helper.user.js，
 * 两者命名一致，也不会在 Windows/macOS/Linux 之间出编码问题。
 *
 * 脚本内部的 @name 仍是中文「学习通自动学习助手」，装在油猴里显示中文。
 */
const OUT_NAME = 'chaoxing-auto-helper.user.js';
const OUT_FILE = path.join(OUT_DIR, OUT_NAME);

/** 拼接顺序（与 manifest 的 content_scripts 一致，只把 host 换成脚本版） */
const PARTS = [
  'src/core/namespace.js',
  'src/core/config.js',
  'src/core/prompt.js',
  'src/core/api.js',
  'src/host/host-userscript.js',
  'src/ui/theme.js',
  'src/ui/panel.js',
  'src/ui/settings.js',
  'src/content/fontdecoder.js',
  'src/content/inject.js'
];

/** 允许出现 chrome.* 的文件（宿主层自己也不该有，这里留空表示一律不许） */
const CHROME_ALLOWED = [];

let errCount = 0;
function fail(msg) {
  console.error('::error::' + msg);
  errCount++;
}

/* ============================================================
 * 1. 读版本号（与 manifest 同源，防止两处漂移）
 * ============================================================ */

const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const VERSION = manifest.version;
if (!/^\d+\.\d+\.\d+/.test(VERSION)) {
  fail('manifest 版本号格式不对：' + VERSION);
}

/* ============================================================
 * 2. 拼装
 * ============================================================ */

const header = `// ==UserScript==
// @name         学习通自动学习助手
// @namespace    https://github.com/ShiYao3286/chaoxing-auto-helper
// @version      ${VERSION}
// @description  超星学习通章节自动学习：任务队列驱动、任务点真实判定、测验自动作答（走你自己的 API）
// @author       ShiYao3286
// @license      MIT
// @match        *://*.chaoxing.com/*
// @match        *://*.edu.cn/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-idle
// @noframes     false
// ==/UserScript==

/*
 * 这个文件是构建产物，不要直接改。
 * 源码在 extension/src/{core,host,ui,content}/，改完跑：
 *   node build/build-userscript.cjs
 *
 * 与扩展版的差异（能力）：
 *   - 没有真实截图 → 截图解题自动降级为「文字重绘」
 *   - 没有后台 Service Worker → 跨帧协调走 BroadcastChannel
 *   - 配置存 GM_setValue（与扩展的 chrome.storage 互不相通）
 */
`;

const chunks = [header];
const missing = [];

for (const rel of PARTS) {
  const p = path.join(EXT, rel);
  if (!fs.existsSync(p)) { missing.push(rel); continue; }
  const code = fs.readFileSync(p, 'utf8');
  chunks.push(`\n/* ============================================================================\n * ${rel}\n * ============================================================================ */\n`);
  chunks.push(code);
}

if (missing.length) {
  fail('缺少源文件：' + missing.join(', '));
}

const out = chunks.join('\n');

/* ============================================================
 * 3. 校验
 * ============================================================ */

// 3.1 不能有 chrome.* 残留
for (const rel of PARTS) {
  if (CHROME_ALLOWED.some(a => rel.includes(a))) continue;
  const p = path.join(EXT, rel);
  if (!fs.existsSync(p)) continue;
  const code = fs.readFileSync(p, 'utf8');
  // 去掉注释行再找
  const lines = code.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const bad = lines.filter(l => /chrome\.(runtime|storage|tabs|windows|contextMenus)/.test(l));
  if (bad.length) {
    fail(rel + ' 含 ' + bad.length + ' 处 chrome.* 调用（脚本版不可用）：' +
         bad[0].trim().slice(0, 100));
  }
}

// 3.2 头部完整性
const REQUIRED = [
  '// @name', '// @version', '// @match', '// @grant        GM_xmlhttpRequest',
  '// @grant        GM_getValue', '// @grant        GM_setValue', '// @connect'
];
for (const r of REQUIRED) {
  if (!out.includes(r)) fail('头部缺少：' + r);
}
if (!/@match\s+\*:\/\/\*\.chaoxing\.com/.test(out)) fail('缺少 chaoxing 的 @match');
if (!/@match\s+\*:\/\/\*\.edu\.cn/.test(out)) fail('缺少 edu.cn 的 @match');

// 3.3 版本一致
const verInFile = (out.match(/\/\/ @version\s+([\d.]+)/) || [])[1];
if (verInFile !== VERSION) {
  fail('产物版本 ' + verInFile + ' 与 manifest ' + VERSION + ' 不一致');
}

// 3.4 UI 不得硬编码颜色（必须走 CSTheme 令牌）
const uiFiles = ['src/ui/panel.js', 'src/ui/theme.js'];
for (const rel of uiFiles) {
  const p = path.join(EXT, rel);
  if (!fs.existsSync(p)) continue;
  const code = fs.readFileSync(p, 'utf8');
  // theme.js 是令牌定义处，允许写颜色
  if (rel.endsWith('theme.js')) continue;
  const lines = code.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l));
  const hard = lines.filter(l => /#[0-9a-fA-F]{6}\b/.test(l) && !/rgba?\(/.test(l));
  if (hard.length) {
    fail(rel + ' 有 ' + hard.length + ' 处硬编码颜色，应改用 CSTheme：' + hard[0].trim().slice(0, 80));
  }
}

// 3.5 体积报告（超 1MB 提醒）
const sizeKB = Math.round(Buffer.byteLength(out, 'utf8') / 1024);
if (sizeKB > 1024) {
  console.warn('⚠️  产物较大：' + sizeKB + ' KB');
}

/* ============================================================
 * 4. 语法检查 + 写出
 * ============================================================ */

if (errCount === 0) {
  // 用 Node 的语法检查器验证产物（这里只做 --check，不执行）
  try {
    // 包一层函数避免顶层 return 之类的问题暴露不出来
    // eslint-disable-next-line no-new-func
    new Function(out.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, ''));
  } catch (e) {
    fail('产物语法错误：' + e.message);
  }
}

if (errCount > 0) {
  console.error('\n❌ 构建失败，共 ' + errCount + ' 个问题');
  process.exit(1);
}

const isCheck = process.argv.includes('--check');
if (isCheck) {
  console.log('✅ 校验通过（--check 模式，未写文件）');
  console.log('   版本：' + VERSION + '　体积：' + sizeKB + ' KB');
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, out, 'utf8');

console.log('✅ 构建完成');
console.log('   产物：' + path.relative(ROOT, OUT_FILE));
console.log('   版本：' + VERSION);
console.log('   体积：' + sizeKB + ' KB（' + PARTS.length + ' 个源文件）');

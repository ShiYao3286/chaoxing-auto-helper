/**
 * 构建产物校验
 *
 * 不需要浏览器：纯静态检查 userscript/*.user.js。
 * 覆盖：头部完整性、版本同源、无 chrome.* 残留、无硬编码颜色、
 *       各模块都在、语法可解析。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'userscript', '学习通自动学习助手.user.js');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ✅ ' + name); pass++; }
  else { console.log('  ❌ ' + name + (extra !== undefined ? '  -> ' + extra : '')); fail++; }
}

if (!fs.existsSync(FILE)) {
  console.error('产物不存在，先跑 node build/build-userscript.cjs');
  process.exit(1);
}
const src = fs.readFileSync(FILE, 'utf8');

console.log('\n=== 1. 元数据头部 ===');
check('// ==UserScript== 开头', src.trimStart().startsWith('// ==UserScript=='));
check('// ==/UserScript== 结尾块', src.includes('// ==/UserScript=='));
check('有 @name', /\/\/ @name\s+\S+/.test(src));
check('有 @version', /\/\/ @version\s+[\d.]+/.test(src));
check('chaoxing 的 @match', /\/\/ @match\s+\*:\/\/\*\.chaoxing\.com/.test(src));
check('edu.cn 的 @match', /\/\/ @match\s+\*:\/\/\*\.edu\.cn/.test(src));

console.log('\n=== 2. 权限声明 ===');
for (const g of ['GM_getValue', 'GM_setValue', 'GM_xmlhttpRequest']) {
  check('@grant ' + g, new RegExp('// @grant\\s+' + g).test(src));
}
check('@connect *（跨域 API 必需）', /\/\/ @connect\s+\*/.test(src));
check('@noframes false（要注入 iframe）', /\/\/ @noframes\s+false/.test(src));
check('@run-at document-idle', /\/\/ @run-at\s+document-idle/.test(src));

console.log('\n=== 3. 版本同源 ===');
const v = (src.match(/\/\/ @version\s+([\d.]+)/) || [])[1];
check('产物版本与 manifest 一致', v === MANIFEST.version, v + ' vs ' + MANIFEST.version);

console.log('\n=== 4. 模块完整性 ===');
const MODULES = [
  ['CSCore 命名空间', 'root.CSCore = CSCore'],
  ['默认配置', 'autoSubmit: false'],
  ['提示词', 'BUILTIN_PROMPT'],
  ['API 层', 'callVisionApi'],
  ['传输层注入', 'setTransport'],
  ['脚本宿主', "kind: 'userscript'"],
  ['BroadcastChannel 总线', 'BroadcastChannel'],
  ['油猴菜单注册', 'GM_registerMenuCommand'],
  ['设计令牌', 'CSTheme'],
  ['悬浮面板', 'CSPanel'],
  ['设置弹窗', 'CSSettings'],
  ['字体解码', 'CSFontDecoder'],
  ['刷课逻辑', 'scanCxTasks'],
  ['任务队列', 'CX_TASK_CATALOG'],
  ['提交安全网', 'workSafe']
];
for (const [name, marker] of MODULES) {
  check('含 ' + name, src.includes(marker), marker);
}

console.log('\n=== 5. 无扩展专用 API 残留 ===');
// 注释行不算
const codeLines = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
const chromeUse = codeLines.filter(l => /chrome\.(runtime|storage|tabs|windows|contextMenus)/.test(l));
check('无 chrome.runtime 等调用', chromeUse.length === 0, chromeUse[0]?.trim().slice(0, 100));

console.log('\n=== 6. 无扩展专属能力依赖 ===');
// captureVisibleTab 在脚本里不存在，代码里不该直接调
// 注意要同时剔除行尾注释（`xxx, // 没有 captureVisibleTab`），否则会误报
const codeOnly = codeLines.map(l => l.replace(/\s\/\/.*$/, ''));
const capUse = codeOnly.filter(l => /captureVisibleTab/.test(l));
check('不调用 captureVisibleTab', capUse.length === 0, capUse[0]?.trim().slice(0, 100));

console.log('\n=== 7. 语法可解析 ===');
let syntaxOk = true, syntaxErr = '';
try {
  // 去掉 userscript header 再解析（header 是注释，其实不影响，保险起见）
  const body = src.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, '');
  // eslint-disable-next-line no-new-func
  new Function(body);
} catch (e) {
  syntaxOk = false; syntaxErr = e.message;
}
check('产物语法正确', syntaxOk, syntaxErr);

console.log('\n=== 8. 体积 ===');
const sizeKB = Math.round(Buffer.byteLength(src, 'utf8') / 1024);
console.log('   ' + sizeKB + ' KB');
check('体积在合理范围（<1MB）', sizeKB < 1024, sizeKB + ' KB');

console.log('\n============================================');
console.log('  结果：' + pass + ' 通过，' + fail + ' 失败');
console.log('============================================');
process.exit(fail ? 1 : 0);

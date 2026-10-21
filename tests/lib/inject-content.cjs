/**
 * 测试用：内容脚本注入器
 *
 * 各测试原本各自手写注入顺序（fontdecoder.js → inject.js）。
 * 抽了内核之后顺序变成 7 个文件，散落在 7 个测试里极易漂移。
 * 统一到这里，顺序与 manifest.json 的 content_scripts.js 保持一致。
 */
const fs = require('fs');
const path = require('path');

/**
 * 与 manifest 保持一致的注入顺序
 *
 * 改这个数组时必须同步改 manifest.json 的 content_scripts.js，
 * tests/test-build.cjs 会校验两者一致。
 */
const CONTENT_SCRIPTS = [
  'src/core/namespace.js',
  'src/core/config.js',
  'src/core/prompt.js',
  'src/core/api.js',
  'src/host/host-extension.js',
  'src/ui/theme.js',
  'src/ui/panel.js',
  'src/ui/settings.js',
  'src/content/fontdecoder.js',
  'src/content/inject.js'
];

/** 扩展根目录 */
function extRoot() {
  return path.join(__dirname, '..', '..', 'extension');
}

/** 读某个脚本的源码 */
function readScript(rel) {
  return fs.readFileSync(path.join(extRoot(), rel), 'utf8');
}

/**
 * 生成注入语句数组（每条都可以直接丢给 Runtime.evaluate）
 *
 * 加 `;1` 是因为 CDP 的 evaluate 对「以函数声明结尾」的脚本
 * 有时返回 undefined 或报语法错，补一个表达式让结果稳定。
 */
function buildInjectExpressions() {
  return CONTENT_SCRIPTS.map(rel => readScript(rel) + '\n;1');
}

/**
 * 一次性注入所有内容脚本
 * @param {(sid:any, expr:string, awaitPromise:boolean)=>Promise<any>} ev
 * @param {any} sessionId
 * @param {number} settleMs 注入后等待时间
 */
async function injectContent(ev, sessionId, settleMs = 1200) {
  const exprs = buildInjectExpressions();
  for (const expr of exprs) {
    const r = await ev(sessionId, expr, false);
    if (typeof r === 'string' && r.startsWith('EX: ')) {
      throw new Error('注入失败：' + r.slice(0, 400));
    }
  }
  await new Promise(r => setTimeout(r, settleMs));
}

module.exports = {
  CONTENT_SCRIPTS,
  extRoot,
  readScript,
  buildInjectExpressions,
  injectContent
};

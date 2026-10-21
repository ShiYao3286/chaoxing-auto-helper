/**
 * 设置页结构校验
 *
 * 换皮只允许改样式，绝不能动 HTML 结构和 id ——
 * options.js 完全依赖这些 id 抓元素，缺一个就整块功能失效。
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'extension', 'src', 'options', 'options.html');
const html = fs.readFileSync(FILE, 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ✅ ' + name); pass++; }
  else { console.log('  ❌ ' + name + (extra !== undefined ? '  -> ' + extra : '')); fail++; }
}

console.log('\n=== 1. 结构完整性 ===');
check('style 块成对', (html.match(/<style>/g) || []).length === 1 &&
                     (html.match(/<\/style>/g) || []).length === 1);
check('script 标签存在', (html.match(/<script/g) || []).length >= 1);

// 这些 id 是 options.js 的抓手，一个都不能少
// 清单直接从当前 HTML 导出，作为「换皮不许动结构」的回归基线
const REQUIRED_IDS = [
  'antiPause', 'apiKey', 'autoFill', 'autoNext', 'autoSubmit',
  'bodyTemplate', 'btnDiag', 'btnModels', 'btnReset', 'btnSave',
  'btnScrape', 'btnShot', 'btnTestApi', 'btnTestQuiz', 'btnTestVision',
  'btnVisionModels', 'customBox', 'debug', 'diagMsg', 'diagOut',
  'docAutoScroll', 'docStep', 'endpoint', 'endpointPreview',
  'endpointPreviewMsg', 'extraHeaders', 'loopInterval', 'model',
  'modelDot', 'modelList', 'modelMsg', 'modelStatus', 'modelsUrl',
  'mute', 'prompt', 'provider', 'quizEnabled', 'rate',
  'responsePath', 'saveMsg', 'shotPreview', 'temperature', 'testMsg',
  'ver', 'visionApiKey', 'visionBadge', 'visionEnabled', 'visionEndpoint',
  'visionMaxShots', 'visionMode', 'visionModel', 'visionModelDot',
  'visionModelMsg', 'visionModelStatus', 'visionOwnBox', 'visionSameApi',
  'visionTestMsg'
];
const missing = REQUIRED_IDS.filter(id => !html.includes('id="' + id + '"'));
check('关键 id 全部保留（' + REQUIRED_IDS.length + ' 个）', missing.length === 0, missing.join(', '));

console.log('\n=== 2. 设计令牌 ===');
const TOKENS = ['--cs-primary:#2d6cdf', '--cs-ok:#2da44e', '--cs-warn:#b26a00',
                '--cs-r-card: 12px', 'linear-gradient(135deg'];
for (const t of TOKENS) {
  check('含令牌 ' + t.replace(/\s/g, ''), html.replace(/\s/g, '').includes(t.replace(/\s/g, '')));
}

console.log('\n=== 3. 不再有旧硬编码 ===');
// 旧版用的是 #d8dee4 描边和 #f6f8fa 背景，换皮后应该走变量
check('无旧描边色 #d8dee4', !html.includes('#d8dee4'));
check('无旧背景 #f6f8fa', !html.includes('#f6f8fa'));

console.log('\n=== 4. options.js 引用的 id 必须全在 HTML 里 ===');
const js = fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', 'options', 'options.js'), 'utf8');
// 抓 $('#xxx') 和 getElementById('xxx')
const refIds = new Set();
for (const m of js.matchAll(/\$\(\s*['"]#([\w-]+)['"]\s*\)/g)) refIds.add(m[1]);
for (const m of js.matchAll(/getElementById\(\s*['"]([\w-]+)['"]\s*\)/g)) refIds.add(m[1]);
const refMissing = [...refIds].filter(id => !html.includes('id="' + id + '"'));
check('引用的 ' + refIds.size + ' 个 id 全部存在', refMissing.length === 0, refMissing.join(', '));

console.log('\n============================================');
console.log('  结果：' + pass + ' 通过，' + fail + ' 失败');
console.log('============================================');
process.exit(fail ? 1 : 0);

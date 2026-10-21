/**
 * 内核单元测试
 *
 * 在 Node 的 vm 里按顺序加载 core/*.js，验证纯逻辑与默认值。
 * 不需要浏览器，不需要扩展。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const CORE_DIR = path.join(__dirname, '..', 'extension', 'src', 'core');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ✅ ' + name); pass++; }
  else { console.log('  ❌ ' + name + (extra !== undefined ? '  -> ' + extra : '')); fail++; }
}

/** 建一个干净的沙箱，按顺序加载内核，返回 CSCore */
function loadCore(files) {
  const ctx = { console, URL, JSON, Date, setTimeout, clearTimeout, AbortController };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  const list = files || ['namespace.js', 'config.js', 'prompt.js', 'api.js'];
  for (const f of list) {
    vm.runInContext(fs.readFileSync(path.join(CORE_DIR, f), 'utf8'), ctx, { filename: f });
  }
  return ctx.CSCore;
}

console.log('\n=== 1. 命名空间与加载顺序 ===');
const C = loadCore();
check('CSCore 存在', !!C);
check('VERSION 是字符串', typeof C.VERSION === 'string', C.VERSION);
check('三个子模块都在', !!C.config && !!C.prompt && !!C.api);
check('重复加载不覆盖', (() => {
  const before = C.VERSION;
  return loadCore() !== C && before === C.VERSION;
})());

// 顺序错误应当抛错
let orderErr = null;
try { loadCore(['config.js']); } catch (e) { orderErr = e.message; }
check('未加载 namespace 就加载 config 会报错', /namespace\.js 必须先加载/.test(orderErr || ''), orderErr);

let orderErr2 = null;
try { loadCore(['namespace.js', 'api.js']); } catch (e) { orderErr2 = e.message; }
check('未加载 config 就加载 api 会报错', /config\.js 必须在 api\.js 之前/.test(orderErr2 || ''), orderErr2);

console.log('\n=== 2. 默认配置 ===');
const D = C.config.DEFAULTS;
check('auto.rate = 2', D.auto.rate === 2);
check('quiz.autoSubmit 默认 false', D.quiz.autoSubmit === false, D.quiz.autoSubmit);
check('vision.mode 默认 auto', D.vision.mode === 'auto', D.vision.mode);
check('autoNext 默认 true', D.auto.autoNext === true);
check('skipUnfinished 默认 true', D.auto.skipUnfinished === true);

console.log('\n=== 3. mergeDefaults ===');
const m1 = C.config.mergeDefaults(null);
check('null 返回完整默认', m1.auto.rate === 2 && m1.quiz.model === 'gpt-4o-mini');
const m2 = C.config.mergeDefaults({ auto: { rate: 1.5 } });
check('覆盖 rate 生效', m2.auto.rate === 1.5, m2.auto.rate);
check('未覆盖项保留默认', m2.auto.mute === true && m2.quiz.autoSubmit === false);
check('不污染 DEFAULTS', C.config.DEFAULTS.auto.rate === 2, C.config.DEFAULTS.auto.rate);
const m3 = C.config.mergeDefaults({ quiz: { autoSubmit: true } });
check('autoSubmit 可被开启', m3.quiz.autoSubmit === true);

console.log('\n=== 4. 提示词 ===');
check('BUILTIN_PROMPT 非空', typeof C.prompt.BUILTIN_PROMPT === 'string' && C.prompt.BUILTIN_PROMPT.length > 100);
check('BUILTIN_PROMPT 含输出格式', /"answers"/.test(C.prompt.BUILTIN_PROMPT));
check('VISION_PROMPT 含置信度说明', /confidence/.test(C.prompt.VISION_PROMPT));
check('VISION_PROMPT 要求 uncertain', /uncertain/.test(C.prompt.VISION_PROMPT));

console.log('\n=== 5. 地址推导 ===');
const cases = [
  ['https://api.deepseek.com/v1/chat/completions', 'https://api.deepseek.com/v1/models'],
  ['https://api.openai.com/v1/chat/completions', 'https://api.openai.com/v1/models'],
  ['https://x.com/v1/', 'https://x.com/v1/models'],
  ['https://x.com/v1/models', 'https://x.com/v1/models'],
  ['', '']
];
for (const [input, want] of cases) {
  const got = C.api.deriveModelsUrl(input);
  check('derive(' + (input || '空') + ')', got === want, got);
}

console.log('\n=== 6. 地址规整 ===');
const normCases = [
  ['https://api.deepseek.com', 'https://api.deepseek.com/v1/chat/completions'],
  ['https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/chat/completions'],
  ['https://api.deepseek.com/v1/', 'https://api.deepseek.com/v1/chat/completions'],
  ['https://api.deepseek.com/v1/chat', 'https://api.deepseek.com/v1/chat/completions'],
  ['https://x.com/api', 'https://x.com/api/v1/chat/completions'],
  ['https://x.com/v1/chat/completions', 'https://x.com/v1/chat/completions']
];
for (const [input, want] of normCases) {
  const got = C.api.normalizeChatEndpoint(input);
  check('normalize(' + input + ')', got === want, got);
}

console.log('\n=== 7. JSON 提取 ===');
check('纯 JSON', JSON.stringify(C.api.extractJson('{"a":1}')) === '{"a":1}');
check('围栏 JSON', JSON.stringify(C.api.extractJson('```json\n{"a":2}\n```')) === '{"a":2}');
check('夹带文字', JSON.stringify(C.api.extractJson('好的，结果如下：{"a":3} 以上')) === '{"a":3}');
check('数组兜底', JSON.stringify(C.api.extractJson('xx [1,2] yy')) === '[1,2]');
check('无法解析返回 null', C.api.extractJson('完全不是 json') === null);
check('对象原样返回', JSON.stringify(C.api.extractJson({ a: 4 })) === '{"a":4}');

console.log('\n=== 8. getByPath ===');
check('点路径', C.api.getByPath({ a: { b: { c: 7 } } }, 'a.b.c') === 7);
check('数组索引', C.api.getByPath({ d: [{ id: 'x' }] }, 'd.0.id') === 'x');
check('空路径返回 undefined', C.api.getByPath({ a: 1 }, '') === undefined);
check('不存在的路径', C.api.getByPath({ a: 1 }, 'a.b.c') === undefined);

console.log('\n=== 9. buildHeaders ===');
const h1 = C.api.buildHeaders({ apiKey: 'sk-1' });
check('带 Bearer', h1.Authorization === 'Bearer sk-1');
check('Content-Type 固定', h1['Content-Type'] === 'application/json');
const h2 = C.api.buildHeaders({ apiKey: '', extraHeaders: '{"X-Test":"1"}' });
check('自定义头生效', h2['X-Test'] === '1');
check('无 Key 时不加 Authorization', !h2.Authorization);
const h3 = C.api.buildHeaders({ extraHeaders: '不是json' });
check('坏的自定义头被忽略', h3['Content-Type'] === 'application/json');

console.log('\n=== 10. 传输层注入 ===');
check('初始未注入', C.api.hasTransport() === false);
let got = null;
C.api.setTransport(async (opts) => { got = opts; return { ok: true, status: 200, text: '{}' }; });
check('注入成功', C.api.hasTransport() === true);

C.api.setTransport(() => { throw new Error('should not'); });

// 用假传输层跑通 callAnswerApi
C.api.setTransport(async (opts) => {
  got = opts;
  return {
    ok: true, status: 200,
    text: JSON.stringify({
      choices: [{ message: { content: '{"answers":[{"num":1,"answer":["B"]}]}' } }]
    })
  };
});
(async () => {
  const cfg = C.config.mergeDefaults({ quiz: { endpoint: 'https://x.com/v1', apiKey: 'sk', model: 'm' } });
  const r = await C.api.callAnswerApi(cfg, [{ num: 1, type: 'single', text: 'q' }]);
  check('callAnswerApi 走传输层', got && got.method === 'POST' && got.url === 'https://x.com/v1/chat/completions', got && got.url);
  check('答案解析正确', r.answers[0].answer[0] === 'B', JSON.stringify(r));

  // 模型列表
  C.api.setTransport(async () => ({
    ok: true, status: 200,
    text: JSON.stringify({ data: [{ id: 'm2' }, { id: 'm1' }, { id: 'm1' }] })
  }));
  const models = await C.api.fetchModels(cfg);
  check('模型列表去重排序', JSON.stringify(models.models) === '["m1","m2"]', JSON.stringify(models.models));
  check('模型数量正确', models.count === 2, models.count);

  // 连通测试
  C.api.setTransport(async () => ({
    ok: true, status: 200,
    text: JSON.stringify({ model: 'echo-model', choices: [{ message: { content: 'OK' } }] })
  }));
  const tc = await C.api.testConnection(cfg);
  check('连通返回模型回显', tc.model === 'echo-model', tc.model);
  check('连通返回耗时', typeof tc.ms === 'number' && tc.ms >= 0);

  // 视觉
  C.api.setTransport(async () => ({
    ok: true, status: 200,
    text: JSON.stringify({ choices: [{ message: { content: '{"answers":[{"num":1,"answer":["C"],"confidence":1}],"uncertain":false}' } }] })
  }));
  const vis = await C.api.callVisionApi(cfg, ['AAAA'], 'image/png');
  check('视觉解析答案', vis.answers[0].answer[0] === 'C', JSON.stringify(vis.answers));
  check('视觉 uncertain 为 false', vis.uncertain === false);

  // 传输层缺失时报错（只加载 namespace + config + prompt + api 但没注入传输层）
  const C2 = loadCore();
  let terr = null;
  try { await C2.api.request({ url: 'x' }); } catch (e) { terr = e.message; }
  check('传输层缺失时明确报错', /传输层未注入/.test(terr || ''), terr);

  console.log('\n============================================');
  console.log('  结果：' + pass + ' 通过，' + fail + ' 失败');
  console.log('============================================');
  process.exit(fail ? 1 : 0);
})();

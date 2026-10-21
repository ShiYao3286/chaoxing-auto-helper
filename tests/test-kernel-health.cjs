/**
 * 内核抽取后的健康检查
 *
 * 验证真实扩展里：
 *   1. Service Worker 能起来，且 importScripts 加载了内核
 *   2. 内核通过传输层真的能发 HTTP 请求（用 mock API）
 *   3. content script 里 Host 存在且能用
 *   4. 七个 content_scripts 文件都注入成功（data-cs-booted）
 *
 * 运行前：启动测试浏览器（9335）、http-server（8793）、mock API（9911）
 */
const http = require('http');
const crypto = require('crypto');
const path = require('path');

const CDP = process.env.DSH_CDP || 'http://127.0.0.1:9335';
const WEB = process.env.DSH_WEB || 'http://127.0.0.1:8793';
const MOCK = 'http://127.0.0.1:9911';

let socket = null, idCounter = 0;
const pending = new Map();
let buf = Buffer.alloc(0);

function getJSON(p) {
  return new Promise((res, rej) => {
    http.get(CDP + p, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); })
      .on('error', rej);
  });
}
function connect(w) {
  return new Promise((resolve, reject) => {
    const u = new URL(w);
    const k = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { 'Connection': 'Upgrade', 'Upgrade': 'websocket', 'Sec-WebSocket-Key': k, 'Sec-WebSocket-Version': '13' }
    });
    req.on('upgrade', (r, s) => { socket = s; s.on('data', onData); resolve(); });
    req.on('error', reject); req.end();
  });
}
function onData(ch) {
  buf = Buffer.concat([buf, ch]);
  while (buf.length >= 2) {
    const op = buf[0] & 0x0f;
    let len = buf[1] & 0x7f, off = 2;
    if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    if (buf.length < off + len) return;
    const pl = buf.subarray(off, off + len); buf = buf.subarray(off + len);
    if (op === 1) {
      try { const m = JSON.parse(pl.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch { /* ignore */ }
    }
  }
}
function send(m, p, s) {
  return new Promise(res => {
    const id = ++idCounter; pending.set(id, res);
    const pl = Buffer.from(JSON.stringify({ id, method: m, params: p || {}, sessionId: s }));
    const len = pl.length; let h;
    if (len < 126) h = Buffer.from([0x81, 0x80 | len]);
    else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(len), 2); }
    const mask = crypto.randomBytes(4); const mk = Buffer.alloc(len);
    for (let i = 0; i < len; i++) mk[i] = pl[i] ^ mask[i % 4];
    socket.write(Buffer.concat([h, mask, mk]));
  });
}
async function ev(sid, expr, ap = true) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: ap, timeout: 60000 }, sid);
  if (r.result?.exceptionDetails) {
    return 'EX: ' + ((r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 500));
  }
  return r.result?.result?.value;
}

let pass = 0, fail = 0;
function check(n, c, e) {
  if (c) { console.log('  ✅ ' + n); pass++; }
  else { console.log('  ❌ ' + n + (e !== undefined ? '  -> ' + e : '')); fail++; }
}

(async () => {
  const ver = await getJSON('/json/version');
  await connect(ver.webSocketDebuggerUrl);

  console.log('\n=== 1. Service Worker 与内核 ===');
  let list = await send('Target.getTargets');
  let sw = (list.result.targetInfos || []).find(t => /src\/background\.js/.test(t.url || ''));
  check('Service Worker 已启动', !!sw, sw?.url);

  if (!sw) { console.log('Service Worker 没起来，无法继续'); process.exit(1); }

  const { result: { sessionId: sid } } = await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  await send('Runtime.enable', {}, sid);

  const core = JSON.parse(await ev(sid, `JSON.stringify({
    hasCore: typeof CSCore,
    version: typeof CSCore !== 'undefined' ? CSCore.VERSION : null,
    hasDefaults: typeof CSCore !== 'undefined' && !!CSCore.config.DEFAULTS,
    hasApi: typeof CSCore !== 'undefined' && typeof CSCore.api.callAnswerApi === 'function',
    hasTransport: typeof CSCore !== 'undefined' && CSCore.api.hasTransport(),
    aliasDerive: typeof deriveModelsUrl === 'function',
    aliasNorm: typeof normalizeChatEndpoint === 'function'
  })`));
  console.log('   ' + JSON.stringify(core));
  check('CSCore 已通过 importScripts 加载', core.hasCore === 'object', core.hasCore);
  check('内核版本可读', typeof core.version === 'string', core.version);
  check('默认配置可用', core.hasDefaults === true);
  check('API 层可用', core.hasApi === true);
  check('传输层已注入', core.hasTransport === true);
  check('兼容别名 deriveModelsUrl 在', core.aliasDerive === true);
  check('兼容别名 normalizeChatEndpoint 在', core.aliasNorm === true);

  console.log('\n=== 2. 内核真的能发请求（走 mock API）===');
  const realReq = await ev(sid, `(async () => {
    try {
      const r = await CSCore.api.fetchModels({ quiz: { endpoint: '${MOCK}/v1/chat/completions', apiKey: 'sk-test', model: 'gpt-4o-mini' } });
      return JSON.stringify({ ok: true, count: r.count, url: r.url });
    } catch (e) { return JSON.stringify({ ok: false, err: String(e.message).slice(0,200) }); }
  })()`);
  console.log('   ' + realReq);
  const rr = JSON.parse(realReq);
  check('模型列表请求成功', rr.ok === true, rr.err);
  check('拉到多个模型', rr.count >= 5, rr.count);

  const realAnswer = await ev(sid, `(async () => {
    try {
      const r = await CSCore.api.callAnswerApi(
        { quiz: { endpoint: '${MOCK}/v1/chat/completions', apiKey: 'sk-test', model: 'gpt-4o-mini' } },
        [{ num: 1, type: 'single', text: '1+1=?', options: [{letter:'A',text:'2'},{letter:'B',text:'3'}] }]
      );
      return JSON.stringify({ ok: true, n: (r.answers||[]).length });
    } catch (e) { return JSON.stringify({ ok: false, err: String(e.message).slice(0,200) }); }
  })()`);
  console.log('   ' + realAnswer);
  const ra = JSON.parse(realAnswer);
  check('答题请求成功', ra.ok === true, ra.err);
  check('解析出答案', ra.n >= 1, ra.n);

  console.log('\n=== 3. 消息路由仍然正常 ===');
  const cfgResp = await ev(sid, `(async () => {
    return new Promise(res => {
      chrome.runtime.onMessage.dispatch
        ? res('no-dispatch')
        : res('manual-only');
    });
  })()`);
  // 直接用 getCfg 验证配置链路
  const cfg2 = await ev(sid, `(async () => {
    const c = await getCfg();
    return JSON.stringify({ ok: !!c, rate: c.auto.rate, autoSubmit: c.quiz.autoSubmit });
  })()`);
  console.log('   ' + cfg2);
  const c2 = JSON.parse(cfg2);
  check('getCfg 正常返回', c2.ok === true);
  check('默认倍速 2', c2.rate === 2, c2.rate);
  check('自动提交默认关', c2.autoSubmit === false, c2.autoSubmit);

  console.log('\n=== 4. content script 里 Host 可用 ===');
  // 说明：真实扩展只向 chaoxing.com / edu.cn 注入，fake 页不在 matches 里，
  // 所以这里用注入的方式验证「Host 在经典脚本地环境里能否工作」。
  const cr = await send('Target.createTarget', { url: WEB + '/fake-quiz.html?kernel=' + Date.now() });
  const { result: { sessionId: pageSid } } = await send('Target.attachToTarget', { targetId: cr.result.targetId, flatten: true });
  await send('Runtime.enable', {}, pageSid);
  await new Promise(r => setTimeout(r, 1500));

  // 桩：模拟扩展隔离世界的 chrome.runtime
  await ev(pageSid, `
    window.chrome = window.chrome || {};
    window.chrome.runtime = window.chrome.runtime || {};
    window.chrome.runtime.sendMessage = async (m) => {
      const t = m && m.type;
      if (t === 'cfg:get') return { ok: true, cfg: { auto: { debug: true, rate: 2 }, quiz: {}, vision: { mode: 'off' }, ui: {} } };
      if (t === 'state:get') return { ok: true, running: false };
      if (t === 'tab:busy') return { ok: true, busy: false, agg: {} };
      return { ok: true };
    };
    window.chrome.runtime.onMessage = { addListener: fn => { window.__ON_MSG__ = fn; } };
    window.chrome.runtime.openOptionsPage = () => {};
  `, false);

  const { injectContent } = require('./lib/inject-content.cjs');
  await injectContent(ev, pageSid, 1500);

  const hostInfo = JSON.parse(await ev(pageSid, `JSON.stringify({
    booted: document.documentElement.getAttribute('data-cs-booted'),
    hasHost: !!window.CSHost,
    hostKind: window.CSHost && window.CSHost.kind,
    caps: window.CSHost && window.CSHost.caps,
    hasCS: typeof window.CS,
    hasCore: typeof window.CSCore
  })`));
  console.log('   ' + JSON.stringify(hostInfo));
  check('内容脚本注入成功', hostInfo.booted === '1', hostInfo.booted);
  check('Host 存在', hostInfo.hasHost === true);
  check('Host 是扩展形态', hostInfo.hostKind === 'extension', hostInfo.hostKind);
  check('具备截图能力', hostInfo.caps && hostInfo.caps.screenshot === true);
  check('内核在内容脚本里也可用', hostInfo.hasCore === 'object', hostInfo.hasCore);
  check('window.CS 已暴露', hostInfo.hasCS === 'object', hostInfo.hasCS);

  console.log('\n=== 5. 面板能挂载 ===');
  const panelInfo = JSON.parse(await ev(pageSid, `(async () => {
    window.CS.panel();
    await new Promise(r => setTimeout(r, 600));
    return JSON.stringify({
      panel: !!document.getElementById('cs-panel'),
      queue: !!document.getElementById('cs-queue'),
      status: document.getElementById('cs-status')?.textContent || ''
    });
  })()`));
  console.log('   ' + JSON.stringify(panelInfo));
  check('悬浮面板已挂载', panelInfo.panel === true);
  check('队列行存在', panelInfo.queue === true);

  console.log('\n============================================');
  console.log('  结果：' + pass + ' 通过，' + fail + ' 失败');
  console.log('============================================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

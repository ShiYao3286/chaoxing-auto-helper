/**
 * 油猴脚本产物功能测试
 *
 * 直接把 .user.js 注入 fake 页面（不需要装 Tampermonkey），
 * 用 GM_* 桩模拟油猴环境，验证：
 *   1. 宿主层起来、能读配置
 *   2. 截图能力如实报告为「不支持」
 *   3. 配置能存能读（GM 桩）
 *   4. 面板能挂载、队列能渲染
 *   5. 跨帧总线能建起来
 *   6. 答题逻辑走传输层（GM_xmlhttpRequest 桩）
 *   7. 任务队列扫描正常
 *
 * 运行前：启动测试浏览器（9335）、http-server（8793）
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CDP = process.env.DSH_CDP || 'http://127.0.0.1:9335';
const WEB = process.env.DSH_WEB || 'http://127.0.0.1:8793';

let socket = null, idCounter = 0;
const pending = new Map();
let buf = Buffer.alloc(0);

const getJSON = p => new Promise((res, rej) => {
  http.get(CDP + p, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});
function connect(w) {
  return new Promise((resolve, reject) => {
    const u = new URL(w), k = crypto.randomBytes(16).toString('base64');
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': k, 'Sec-WebSocket-Version': '13' } });
    req.on('upgrade', (r, s) => { socket = s; s.on('data', onData); resolve(); });
    req.on('error', reject); req.end();
  });
}
function onData(ch) {
  buf = Buffer.concat([buf, ch]);
  while (buf.length >= 2) {
    const op = buf[0] & 0x0f; let len = buf[1] & 0x7f, off = 2;
    if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    if (buf.length < off + len) return;
    const pl = buf.subarray(off, off + len); buf = buf.subarray(off + len);
    if (op === 1) { try { const m = JSON.parse(pl.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch { /* ignore */ } }
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
    const mk = crypto.randomBytes(4), m2 = Buffer.alloc(len);
    for (let i = 0; i < len; i++) m2[i] = pl[i] ^ mk[i % 4];
    socket.write(Buffer.concat([h, mk, m2]));
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
function checkAsync(n, v, expect) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  check(n, !s.startsWith('EX: '), s.slice(0, 300));
  return v;
}

const USERSCRIPT = path.join(__dirname, '..', 'userscript', '学习通自动学习助手.user.js');

(async () => {
  const ver = await getJSON('/json/version');
  await connect(ver.webSocketDebuggerUrl);

  if (!fs.existsSync(USERSCRIPT)) {
    console.log('产物不存在，先跑 node build/build-userscript.cjs');
    process.exit(1);
  }
  const code = fs.readFileSync(USERSCRIPT, 'utf8');

  const cr = await send('Target.createTarget', { url: WEB + '/fake-quiz.html?us=' + Date.now() });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: cr.result.targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await new Promise(r => setTimeout(r, 1500));

  console.log('\n=== 0. 装 GM_* 桩 ===');
  // 模拟油猴环境：GM 存储 + GM_xmlhttpRequest
  //
  // 注意：不能在这里用页面 fetch 转发到 mock API ——
  // 页面在 8793、API 在 9911，浏览器会按 CORS 拦掉。
  // 真实油猴的 GM_xmlhttpRequest 走扩展层网络栈，不受这个限制，
  // 所以这里直接构造响应，验证的是「调用链是否走通」而不是真的联网。
  const stub = await ev(sessionId, `
    (() => {
      const store = {};
      window.__GM_STORE__ = store;
      window.GM_getValue = (k, def) => (k in store ? store[k] : def);
      window.GM_setValue = (k, v) => { store[k] = v; };
      window.GM_registerMenuCommand = () => {};
      window.GM_addStyle = () => {};
      window.__XHR_CALLS__ = 0;
      window.__XHR_LOG__ = [];
      window.GM_xmlhttpRequest = (o) => {
        window.__XHR_CALLS__++;
        const path = String(o.url).replace(/^https?:\\/\\/[^/]+/, '');
        window.__XHR_LOG__.push({ method: o.method, path });
        // /models 返回模型列表，其它返回一条答案
        let body;
        if (/\\/models/.test(path)) {
          body = JSON.stringify({ data: [{ id: 'gpt-4o-mini' }, { id: 'qwen-vl-max' }] });
        } else {
          body = JSON.stringify({
            model: 'gpt-4o-mini',
            choices: [{ message: { content: '{"answers":[{"num":1,"type":"single","answer":["B"]}]}' } }]
          });
        }
        setTimeout(() => {
          o.onload && o.onload({ status: 200, responseText: body });
        }, 10);
      };
      return 'stubbed';
    })()
  `, false);
  check('GM 桩就绪', stub === 'stubbed', stub);

  console.log('\n=== 1. 注入产物 ===');
  const inj = await ev(sessionId, code + '\n;1', false);
  await new Promise(r => setTimeout(r, 2000));
  checkAsync('产物注入无异常', inj);

  const boot = JSON.parse(await ev(sessionId, `JSON.stringify({
    host: typeof window.CSHost,
    kind: window.CSHost && window.CSHost.kind,
    core: typeof window.CSCore,
    panel: typeof window.CSPanel,
    theme: typeof window.CSTheme,
    cs: typeof window.CS,
    booted: document.documentElement.getAttribute('data-cs-booted'),
    tabId: document.documentElement.getAttribute('data-cs-tabid')
  })`));
  console.log('   ' + JSON.stringify(boot));
  check('Host 已建立', boot.host === 'object');
  check('Host 是脚本形态', boot.kind === 'userscript', boot.kind);
  check('内核已加载', boot.core === 'object');
  check('面板模块已加载', boot.panel === 'object');
  check('主题已加载', boot.theme === 'object');
  check('刷课逻辑已启动', boot.cs === 'object', boot.cs);
  check('注入标记已打', boot.booted === '1', boot.booted);
  check('tabId 已写入 <html>', !!boot.tabId, boot.tabId);

  console.log('\n=== 2. 能力如实上报 ===');
  const caps = JSON.parse(await ev(sessionId, `JSON.stringify(window.CSHost.caps)`));
  console.log('   ' + JSON.stringify(caps));
  check('截图能力为 false（脚本做不到）', caps.screenshot === false, caps.screenshot);
  check('跨域请求能力为 true', caps.backgroundFetch === true);
  check('存储能力为 true', caps.storage === true);

  console.log('\n=== 3. 配置读写（GM 存储）===');
  const cfgFlow = JSON.parse(await ev(sessionId, `(async () => {
    const before = await window.CSHost.getCfg();
    await window.CSHost.setCfg({ auto: { rate: 1.75 } });
    const after = await window.CSHost.getCfg();
    return JSON.stringify({
      beforeRate: before.auto.rate,
      afterRate: after.auto.rate,
      stored: !!window.__GM_STORE__['cs.cfg'],
      autoSubmit: after.quiz.autoSubmit
    });
  })()`));
  console.log('   ' + JSON.stringify(cfgFlow));
  check('默认配置可读', cfgFlow.beforeRate === 2, cfgFlow.beforeRate);
  check('配置可写', cfgFlow.afterRate === 1.75, cfgFlow.afterRate);
  check('落到 GM 存储', cfgFlow.stored === true);
  check('默认不自动提交', cfgFlow.autoSubmit === false);

  console.log('\n=== 4. 运行态 ===');
  const runFlow = JSON.parse(await ev(sessionId, `(async () => {
    await window.CSHost.setRunning(true);
    await new Promise(r => setTimeout(r, 300));
    const on = await window.CSHost.getRunning();
    await window.CSHost.setRunning(false);
    await new Promise(r => setTimeout(r, 300));
    const off = await window.CSHost.getRunning();
    return JSON.stringify({ on, off });
  })()`));
  console.log('   ' + JSON.stringify(runFlow));
  check('可置为运行中', runFlow.on === true, runFlow.on);
  check('可置为停止', runFlow.off === false, runFlow.off);

  console.log('\n=== 5. 面板挂载 ===');
  const panel = JSON.parse(await ev(sessionId, `(async () => {
    window.CS.panel();
    await new Promise(r => setTimeout(r, 500));
    const mountedRate = document.getElementById('cs-rate')?.value;
    // 挂载后再改配置：panel 支持 fillCfg 重新回填
    const cfg = await window.CSHost.getCfg();
    window.CSPanel.fillCfg(cfg);
    const refilledRate = document.getElementById('cs-rate')?.value;
    return JSON.stringify({
      mounted: !!document.getElementById('cs-panel'),
      mountedRate,
      refilledRate,
      hasQueue: !!document.getElementById('cs-queue'),
      hasStart: !!document.getElementById('cs-start'),
      titleText: document.querySelector('#cs-panel .cs-title')?.textContent || ''
    });
  })()`));
  console.log('   ' + JSON.stringify(panel));
  check('面板已挂载', panel.mounted === true);
  check('队列行存在', panel.hasQueue === true);
  check('开始按钮存在', panel.hasStart === true);
  check('标题正确', /学习通/.test(panel.titleText || ''), panel.titleText);
  check('fillCfg 能回填已保存的倍速 1.75', panel.refilledRate === '1.75', panel.refilledRate);

  console.log('\n=== 6. 任务队列扫描 ===');
  const queue = JSON.parse(await ev(sessionId, `(() => {
    document.body.insertAdjacentHTML('beforeend', \`
      <div id="cards2">
        <div class="ans-attach-ct"><div class="ans-job-icon ans-job-icon-clear" aria-label="任务点已完成"></div>
          <iframe src="/mooc-ans/ananas/modules/video/index.html"></iframe></div>
        <div class="ans-attach-ct"><div class="ans-job-icon" aria-label="任务点未完成"></div>
          <iframe src="/mooc-ans/ananas/modules/work/index.html"></iframe></div>
      </div>\`);
    const q = window.CS.scanCxTasks(document);
    window.CS.state.taskQueue = q;
    return JSON.stringify(q.map(t => ({ type: t.type, done: t.done, supported: t.supported })));
  })()`));
  console.log('   ' + JSON.stringify(queue));
  check('扫出 2 个任务', queue.length === 2, queue.length);
  check('视频标为已完成', queue[0].done === true, JSON.stringify(queue[0]));
  check('测验标为未完成', queue[1].done === false, JSON.stringify(queue[1]));

  console.log('\n=== 7. 截图如实降级 ===');
  const shot = JSON.parse(await ev(sessionId, `(async () => {
    const r = await window.CSHost.send('page:screenshot', { rect: { x:0,y:0,w:10,h:10 } });
    return JSON.stringify({ ok: r && r.ok, error: r && r.error });
  })()`));
  console.log('   ' + JSON.stringify(shot));
  check('截图接口如实返回失败', shot.ok === false, JSON.stringify(shot));
  check('错误信息说明原因', /不支持|降级/.test(shot.error || ''), shot.error);

  console.log('\n=== 8. 答题走 GM_xmlhttpRequest ===');
  const ans = JSON.parse(await ev(sessionId, `(async () => {
    await window.CSHost.setCfg({ quiz: {
      endpoint: 'http://127.0.0.1:9911/v1/chat/completions',
      apiKey: 'sk-test', model: 'gpt-4o-mini'
    }});
    window.__XHR_CALLS__ = 0;
    const r = await window.CSHost.send('quiz:answer', {
      questions: [{ num: 1, type: 'single', text: '1+1=?', options: [{letter:'A',text:'2'},{letter:'B',text:'3'}] }]
    });
    // 同时直接调内核，拿到原始错误
    let directErr = null, directOk = false, directN = 0;
    try {
      const d = await window.CSCore.api.callAnswerApi(
        { quiz: { endpoint: 'http://127.0.0.1:9911/v1/chat/completions', apiKey: 'sk-test', model: 'gpt-4o-mini' } },
        [{ num: 1, type: 'single', text: 'q' }]
      );
      directOk = true; directN = (d.answers || []).length;
    } catch (e) { directErr = String(e && e.message || e); }
    return JSON.stringify({
      ok: r && r.ok,
      err: r && r.error,
      answers: r && r.result && (r.result.answers || []).length,
      directOk, directN, directErr,
      xhrCalls: window.__XHR_CALLS__,
      firstPath: window.__XHR_LOG__[0] && window.__XHR_LOG__[0].path
    });
  })()`));
  console.log('   ' + JSON.stringify(ans));
  check('确实走了 GM_xmlhttpRequest', ans.xhrCalls >= 1, ans.xhrCalls);
  check('请求路径正确', ans.firstPath === '/v1/chat/completions', ans.firstPath);
  check('直接调内核成功', ans.directOk === true, ans.directErr);
  check('直接调内核解析出答案', ans.directN >= 1, ans.directN);
  check('Host.send 成功', ans.ok === true, ans.err);

  console.log('\n=== 9. 跨帧总线 ===');
  const bus = JSON.parse(await ev(sessionId, `JSON.stringify({
    hasBroadcastChannel: typeof BroadcastChannel !== 'undefined',
    debug: window.CSHost._debug ? {
      tabId: window.CSHost._debug.tabId,
      frameKey: window.CSHost._debug.frameKey,
      isTop: window.CSHost._debug.isTop,
      hasBus: window.CSHost._debug.hasBus ? window.CSHost._debug.hasBus() : null
    } : null
  })`));
  console.log('   ' + JSON.stringify(bus));
  check('浏览器支持 BroadcastChannel', bus.hasBroadcastChannel === true);
  check('有 tabId', !!bus.debug?.tabId, bus.debug?.tabId);
  check('frameKey 为 top', bus.debug?.frameKey === 'top', bus.debug?.frameKey);
  check('总线已建立', bus.debug?.hasBus === true, bus.debug?.hasBus);

  console.log('\n============================================');
  console.log('  结果：' + pass + ' 通过，' + fail + ' 失败');
  console.log('============================================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

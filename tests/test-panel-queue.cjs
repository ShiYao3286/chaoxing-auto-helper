/**
 * 面板队列行视觉验证
 *
 * 单独确认 v1.3.0 新加的 #cs-queue 真的渲染出来、样式正常。
 * 跑完会把截图存到 tests/shot-panel-queue.png
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

  const extRoot = path.join(__dirname, '..', 'extension');
  const { injectContent } = require('./lib/inject-content.cjs');
  const cr = await send('Target.createTarget', { url: WEB + '/fake-quiz.html?panel=' + Date.now() });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: cr.result.targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await new Promise(r => setTimeout(r, 1200));

  await ev(sessionId, `
    window.chrome = window.chrome || {};
    window.chrome.runtime = window.chrome.runtime || {};
    window.chrome.runtime.sendMessage = async (m) => {
      const t = m && m.type;
      if (t === 'cfg:get') return { ok: true, cfg: { auto: { debug: true }, quiz: {}, vision: { mode: 'off' }, ui: {} } };
      if (t === 'state:get') return { ok: true, running: false };
      return { ok: true };
    };
    window.chrome.runtime.onMessage = { addListener: fn => window.__ON_MSG__ = fn };
  `, false);

  await injectContent(ev, sessionId, 1200);

  console.log('\n=== 1. 挂载面板 ===');
  await ev(sessionId, `window.CS.panel();1`, false);
  await new Promise(r => setTimeout(r, 500));

  const mounted = JSON.parse(await ev(sessionId, `JSON.stringify({
    panel: !!document.getElementById('cs-panel'),
    queue: !!document.getElementById('cs-queue'),
    jobs: !!document.getElementById('cs-jobs'),
    status: !!document.getElementById('cs-status')
  })`));
  console.log('   ' + JSON.stringify(mounted));
  check('面板已挂载', mounted.panel === true, mounted.panel);
  check('队列行存在', mounted.queue === true, mounted.queue);
  check('状态行存在', mounted.status === true, mounted.status);

  console.log('\n=== 2. 注入队列数据，检查渲染 ===');
  const rendered = JSON.parse(await ev(sessionId, `
    window.CS.state.taskQueue = [
      { order:0, type:'video',  label:'视频', done:true,  supported:true,  title:'1.1 微课视频' },
      { order:1, type:'work',   label:'测验', done:false, supported:true,  title:'1.2 章节测验' },
      { order:2, type:'pdf',    label:'PDF',  done:false, supported:true,  title:'1.3 电子教材' },
      { order:3, type:'live',   label:'live', done:false, supported:false, title:'1.4 直播' }
    ];
    window.CS.state.status = '任务 1/4 · 当前：测验';
    // 触发一次渲染：renderStatus 由 setStatus 驱动，直接调内部入口
    window.CS.state.lastStatus = '';
    if (typeof window.CS.renderStatus === 'function') window.CS.renderStatus();
    JSON.stringify({
      html: document.getElementById('cs-queue').innerHTML,
      visible: document.getElementById('cs-queue').style.display !== 'none',
      jobsHidden: document.getElementById('cs-jobs').style.display === 'none'
    });
  `));
  console.log('   html: ' + (rendered.html || '').slice(0, 200));
  check('队列行可见', rendered.visible === true, rendered.visible);
  check('有 4 个任务标签', (rendered.html.match(/cs-qitem/g) || []).length === 4,
        (rendered.html.match(/cs-qitem/g) || []).length);
  check('完成的标 done 类', /cs-qitem done/.test(rendered.html), rendered.html.slice(0, 120));
  check('不支持的打删除线类', /cs-qitem skip/.test(rendered.html), rendered.html.slice(0, 120));
  check('带标题浮层', /title="1\.2 章节测验"/.test(rendered.html), rendered.html.slice(0, 200));

  console.log('\n=== 3. 截图 ===');
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  if (shot.result?.data) {
    const out = path.join(__dirname, 'shot-panel-queue.png');
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log('   📷 已保存: ' + out);
    check('截图已保存', fs.existsSync(out), out);
  } else {
    check('截图已保存', false, 'captureScreenshot 无返回');
  }

  console.log('\n============================================');
  console.log('  结果：' + pass + ' 通过，' + fail + ' 失败');
  console.log('============================================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

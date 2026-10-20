// 诊断：用 DOM 标记判断每个 frame 的扩展注入情况
const http = require('http');
const crypto = require('crypto');

const CDP = process.env.DSH_CDP || 'http://127.0.0.1:9335';

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
      try { const m = JSON.parse(pl.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
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
async function ev(sid, expr, ctx, ap = true) {
  const params = { expression: expr, returnByValue: true, awaitPromise: ap, timeout: 45000 };
  if (ctx != null) params.contextId = ctx;
  const r = await send('Runtime.evaluate', params, sid);
  if (r.result?.exceptionDetails) {
    return 'EX: ' + ((r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 200));
  }
  return r.result?.result?.value;
}

(async () => {
  const ver = await getJSON('/json/version');
  await connect(ver.webSocketDebuggerUrl);

  const list = await send('Target.getTargets');
  const pg = (list.result.targetInfos || []).find(t => /studentstudy/.test(t.url || ''));
  if (!pg) { console.log('没找到学习页面'); process.exit(1); }

  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: pg.targetId, flatten: true });
  await send('Page.enable', {}, sessionId);

  const ft = await send('Page.getFrameTree', {}, sessionId);
  const flat = [];
  (function walk(n, d) {
    if (!n) return;
    flat.push({ d, id: n.frame.id, url: n.frame.url || '' });
    (n.childFrames || []).forEach(c => walk(c, d + 1));
  })(ft.result.frameTree, 0);

  console.log('=== 各 frame 的注入与内容情况 ===\n');
  let injected = 0, hasVideo = 0, total = 0;

  for (const f of flat) {
    total++;
    const w = await send('Page.createIsolatedWorld', { frameId: f.id, worldName: 'diag_' + Date.now() + Math.random() }, sessionId);
    const ctx = w.result?.executionContextId;
    if (ctx == null) continue;

    const r = await ev(sessionId, `JSON.stringify({
      booted: document.documentElement.getAttribute('data-cs-booted'),
      frameKind: document.documentElement.getAttribute('data-cs-frame'),
      videos: document.querySelectorAll('video').length,
      ql: document.querySelectorAll('.questionLi').length,
      panel: !!document.getElementById('cs-panel')
    })`, ctx);

    const j = JSON.parse(r);
    if (j.booted === '1') injected++;
    if (j.videos > 0) hasVideo++;

    const label = f.url === 'about:blank' ? '(about:blank)' : f.url.slice(0, 58);
    const mark = j.booted === '1' ? '✅注入' : '❌未注入';
    const extra = [
      j.videos > 0 ? `视频×${j.videos}` : '',
      j.ql > 0 ? `题目×${j.ql}` : '',
      j.panel ? '面板' : ''
    ].filter(Boolean).join(' ');

    console.log(`${'  '.repeat(f.d)}[d${f.d}] ${mark}  ${label}`);
    if (extra) console.log(`${'  '.repeat(f.d)}      ${extra}`);
  }

  console.log(`\n汇总：${injected}/${total} 个 frame 注入成功，${hasVideo} 个含视频`);
  socket.destroy();
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

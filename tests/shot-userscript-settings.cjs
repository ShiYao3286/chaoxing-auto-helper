/**
 * 脚本版设置弹窗截图（视觉基线）
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
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: ap, timeout: 30000 }, sid);
  return r.result?.result?.value;
}

(async () => {
  const ver = await getJSON('/json/version');
  await connect(ver.webSocketDebuggerUrl);
  const code = fs.readFileSync(path.join(__dirname, '..', 'userscript', '学习通自动学习助手.user.js'), 'utf8');

  const cr = await send('Target.createTarget', { url: WEB + '/fake-quiz.html?shot=' + Date.now() });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: cr.result.targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await new Promise(r => setTimeout(r, 1500));

  await send('Emulation.setDeviceMetricsOverride', {
    width: 900, height: 900, deviceScaleFactor: 1, mobile: false
  }, sessionId);

  await ev(sessionId, `
    window.GM_getValue = (k, d) => d;
    window.GM_setValue = () => {};
    window.GM_registerMenuCommand = () => {};
    window.GM_xmlhttpRequest = (o) => setTimeout(() => o.onload && o.onload({ status: 200, responseText: '{"data":[{"id":"gpt-4o-mini"}]}' }), 10);
    'ok'
  `, false);

  await ev(sessionId, code + '\n;1', false);
  await new Promise(r => setTimeout(r, 1500));

  await ev(sessionId, `
    window.CSSettings.open({
      getCfg: () => ({
        quiz: { endpoint: 'https://api.deepseek.com/v1/chat/completions', apiKey: 'sk-abc123', model: 'deepseek-chat', temperature: 0.2, autoSubmit: false },
        vision: { enabled: true, mode: 'auto', model: 'qwen-vl-max' },
        auto: { rate: 2, mute: true, autoNext: true, docAutoScroll: true, antiPause: true, debug: true, quizEnabled: true, minDwellSeconds: 5 }
      }),
      setCfg: async () => {}
    });
    1
  `, false);
  await new Promise(r => setTimeout(r, 800));

  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const out = path.join(__dirname, '..', 'docs', 'images', 'userscript-settings.png');
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log('📷 ' + out + '  (' + Math.round(fs.statSync(out).size / 1024) + ' KB)');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

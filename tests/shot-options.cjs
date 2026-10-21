/**
 * 截取扩展设置页（换皮后的视觉基线）
 *
 * 输出 docs/images/options-restyled.png
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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

(async () => {
  const ver = await getJSON('/json/version');
  await connect(ver.webSocketDebuggerUrl);

  const list = await send('Target.getTargets');
  const t = (list.result.targetInfos || []).find(x => /options\.html/.test(x.url || ''));
  if (!t) { console.log('没找到设置页，请先打开'); process.exit(1); }

  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);

  // 设置窗口尺寸，拍个完整的
  await send('Emulation.setDeviceMetricsOverride', {
    width: 860, height: 1180, deviceScaleFactor: 1, mobile: false
  }, sessionId);
  await new Promise(r => setTimeout(r, 1200));

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
  const out = path.join(__dirname, '..', 'docs', 'images', 'options-restyled.png');
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log('📷 ' + out + '  (' + Math.round(fs.statSync(out).size / 1024) + ' KB)');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

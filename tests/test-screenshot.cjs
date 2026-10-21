// 验证真实截图能力：captureVisibleTab + 裁剪
// 用法：node test-screenshot.cjs
//   （无需传参，自动定位扩展里的 fontdecoder.js / inject.js）
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CDP = process.env.DSH_CDP || 'http://127.0.0.1:9335';
const PAGE = (process.env.DSH_WEB || 'http://127.0.0.1:8792') + '/fake-quiz.html';

/** 找扩展根目录 */
function findExtRoot() {
  if (process.argv[2] && fs.existsSync(process.argv[2])) return path.resolve(process.argv[2]);
  const cands = [
    path.join(__dirname, '..', 'extension'),
    path.join(__dirname, '..'),
  ];
  for (const c of cands) if (fs.existsSync(path.join(c, 'manifest.json'))) return c;
  throw new Error('找不到扩展目录');
}

const EXT = findExtRoot();
const { injectContent } = require('./lib/inject-content.cjs');

let socket = null, idCounter = 0;
const pending = new Map();
let buf = Buffer.alloc(0);

function getJSON(p) {
  return new Promise((res, rej) => {
    http.get(CDP + p, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); })
      .on('error', rej);
  });
}
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const r = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { 'Connection': 'Upgrade', 'Upgrade': 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' }
    });
    r.on('upgrade', (resp, sock) => { socket = sock; sock.on('data', onData); resolve(); });
    r.on('error', reject); r.end();
  });
}
function onData(chunk) {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 2) {
    const opcode = buf[0] & 0x0f;
    let len = buf[1] & 0x7f, off = 2;
    if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    if (buf.length < off + len) return;
    const payload = buf.subarray(off, off + len); buf = buf.subarray(off + len);
    if (opcode === 1) {
      try { const m = JSON.parse(payload.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
    }
  }
}
function send(method, params, sessionId) {
  return new Promise(resolve => {
    const id = ++idCounter; pending.set(id, resolve);
    const payload = Buffer.from(JSON.stringify({ id, method, params: params || {}, sessionId }));
    const len = payload.length; let header;
    if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
    const mask = crypto.randomBytes(4); const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    socket.write(Buffer.concat([header, mask, masked]));
  });
}
async function ev(sid, expr, ap = true) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: ap, timeout: 60000 }, sid);
  if (r.result?.exceptionDetails) {
    const e = r.result.exceptionDetails;
    throw new Error('EX: ' + (e.exception?.description || e.text || '').slice(0, 400));
  }
  return r.result?.result?.value;
}

let pass = 0, fail = 0;
function check(n, c, e) { if (c) { console.log('  ✅ ' + n); pass++; } else { console.log('  ❌ ' + n + (e ? '  -> ' + e : '')); fail++; } }

(async () => {
  const ver = await getJSON('/json/version');
  await connect(ver.webSocketDebuggerUrl);

  console.log('=== 1. 准备真实页面 ===');
  // 关掉旧页面
  const l0 = await send('Target.getTargets');
  for (const t of (l0.result.targetInfos || []).filter(t => /fake-quiz/.test(t.url || ''))) {
    await send('Target.closeTarget', { targetId: t.targetId });
  }
  await new Promise(r => setTimeout(r, 800));

  const cr = await send('Target.createTarget', { url: PAGE + '?t=' + Date.now() });
  const { result: { sessionId: pg } } = await send('Target.attachToTarget', { targetId: cr.result.targetId, flatten: true });
  await send('Runtime.enable', {}, pg);
  await send('Page.enable', {}, pg);
  await new Promise(r => setTimeout(r, 3000));

  check('页面加载', (await ev(pg, 'document.querySelectorAll(".TiMu").length', false)) === 5);

  console.log('\n=== 2. 验证后台截图能力 ===');
  // 找到扩展的 service worker
  const list = await send('Target.getTargets');
  let ext = (list.result.targetInfos || []).find(t => /src\/background\.js/.test(t.url || ''));
  if (!ext) {
    // 唤醒
    const anyExt = (list.result.targetInfos || []).find(t => /chrome-extension:\/\//.test(t.url || ''));
    if (anyExt) {
      const id0 = new URL(anyExt.url).host;
      await send('Target.createTarget', { url: `chrome-extension://${id0}/src/options/options.html` });
      await new Promise(r => setTimeout(r, 2500));
    }
    const l2 = await send('Target.getTargets');
    ext = (l2.result.targetInfos || []).find(t => /src\/background\.js/.test(t.url || ''));
  }
  check('service worker 可用', !!ext);
  if (!ext) { process.exit(1); }

  const { result: { sessionId: sw } } = await send('Target.attachToTarget', { targetId: ext.targetId, flatten: true });
  await send('Runtime.enable', {}, sw);

  // 直接在 SW 里调 captureVisibleTab
  const tabId = cr.result.targetId;
  console.log('  (页面 targetId = ' + tabId + ')');

  // 用 chrome.tabs.query 找到真实 tabId
  const tabInfo = await ev(sw, `(async()=>{
    const tabs = await chrome.tabs.query({});
    return JSON.stringify(tabs.map(t => ({id:t.id, url:(t.url||'').slice(0,60), active:t.active})));
  })()`);
  console.log('  可见标签页:', tabInfo);

  const tabs = JSON.parse(tabInfo);
  const fakeTab = tabs.find(t => /fake-quiz/.test(t.url));

  if (!fakeTab) {
    console.log('  ⚠ 未找到测试页标签，跳过真实截图验证');
    check('发现测试页标签', false, tabInfo);
  } else {
    // 激活该标签后截图
    const shot = await ev(sw, `(async()=>{
      try {
        await chrome.tabs.update(${fakeTab.id}, {active:true});
        await new Promise(r=>setTimeout(r,800));
        const w = (await chrome.tabs.get(${fakeTab.id})).windowId; const url = await chrome.tabs.captureVisibleTab(w, {format:'png'});
        return JSON.stringify({ ok:true, len:url.length, head:url.slice(0,50) });
      } catch(e) {
        return JSON.stringify({ ok:false, error:e.message });
      }
    })()`);
    const s = JSON.parse(shot);
    check('captureVisibleTab 成功', s.ok === true, s.error || '');
    if (s.ok) {
      check('返回 PNG dataURL', /^data:image\/png;base64,/.test(s.head), s.head);
      check('图片大小合理', s.len > 5000, s.len + ' 字符');

      // 验证裁剪
      const crop = await ev(sw, `(async()=>{
        try {
          const w = (await chrome.tabs.get(${fakeTab.id})).windowId; const url = await chrome.tabs.captureVisibleTab(w, {format:'png'});
          const res = await cropImage(url, {x:20, y:100, w:600, h:400}, 1);
          const b64 = res.dataUrl.split(',')[1];
          const bin = atob(b64);
          const arr = new Uint8Array(bin.length);
          for (let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
          const blob = new Blob([arr], {type:'image/png'});
          const bmp = await createImageBitmap(blob);
          return JSON.stringify({ ok:true, w:bmp.width, h:bmp.height, len:res.dataUrl.length, clamped: res.clamped });
        } catch(e) {
          return JSON.stringify({ ok:false, error:e.message });
        }
      })()`);
      const c = JSON.parse(crop);
      check('裁剪成功', c.ok === true, c.error || '');
      if (c.ok) {
        // 请求区域可能超出可视高度，裁剪会自动收缩到实际范围——属正常
        check('裁剪宽度正确', Math.abs(c.w - 600) <= 2, `实际 ${c.w}x${c.h}`);
        check('裁剪高度合理（>0 且不超请求）', c.h > 0 && c.h <= 400, `实际 ${c.w}x${c.h}`);
        if (c.clamped) {
          console.log(`     （裁剪被收缩：请求 600x400 → 实际 ${c.w}x${c.h}，属正常）`);
        }
      }
    }
  }

  console.log('\n=== 3. 验证内容脚本端截图 ===');
  await ev(pg, `
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = {};
    const _send = async (msg) => {
      // 转到 SW 执行
      return { ok:false, error:'stub' };
    };
    window.chrome.runtime.sendMessage = _send;
    window.chrome.runtime.onMessage = { addListener: fn => window.__ON_MSG__ = fn };
    window.chrome.runtime.openOptionsPage = () => {};
  `, false);

  const fs = require('fs');
  await injectContent(ev, pg, 1200);

  // 测试降级重绘路径（因为 stub 的 page:screenshot 会失败）
  const cap = await ev(pg, `(async()=>{
    return await new Promise(res=>{
      window.__ON_MSG__({type:'quiz:capture'}, {}, res);
    });
  })()`);
  check('截图接口有返回', cap && typeof cap === 'object', JSON.stringify(cap).slice(0, 100));
  check('截图返回有效图片', cap?.ok === true && !!(cap?.dataUrl || cap?.images), JSON.stringify(cap).slice(0,80));
  check('返回有效 dataUrl', /^data:image\/png;base64,/.test(cap?.dataUrl || ''), (cap?.dataUrl || '').slice(0, 40));

  // 保存截图看效果
  if (cap?.dataUrl) {
    const b64 = cap.dataUrl.split(',')[1];
    fs.writeFileSync('tests/shot-degraded.png', Buffer.from(b64, 'base64'));
    console.log('  📷 降级截图已保存: tests/shot-degraded.png');
  }

  console.log('\n=========================');
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  console.log('=========================');

  socket.destroy();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

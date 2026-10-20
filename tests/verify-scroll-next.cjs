// 验证：滚动当前标签内容到底 → 点下一节（不切标签）
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
  const params = { expression: expr, returnByValue: true, awaitPromise: ap, timeout: 90000 };
  if (ctx != null) params.contextId = ctx;
  const r = await send('Runtime.evaluate', params, sid);
  if (r.result?.exceptionDetails) {
    return 'EX: ' + ((r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 250));
  }
  return r.result?.result?.value;
}

(async () => {
  const ver = await getJSON('/json/version');
  await connect(ver.webSocketDebuggerUrl);

  const list = await send('Target.getTargets');
  const pg = (list.result.targetInfos || []).find(t => /studentstudy/.test(t.url || '') && t.type === 'page');
  if (!pg) { console.log('无页面'); process.exit(1); }

  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: pg.targetId, flatten: true });
  await send('Page.enable', {}, sessionId);

  const ft = await send('Page.getFrameTree', {}, sessionId);
  const top = ft.result.frameTree.frame.id;
  const w = await send('Page.createIsolatedWorld', { frameId: top, worldName: 't' }, sessionId);
  const topCtx = w.result.executionContextId;

  console.log('=== 1. 当前状态 ===');
  console.log(await ev(sessionId, `JSON.stringify({
    booted: document.documentElement.getAttribute('data-cs-booted'),
    activeTab: (() => {
      const t = [...document.querySelectorAll('li[id^="dct"]')].find(x => /active/.test(x.className||''));
      return t ? (t.getAttribute('title')||t.textContent||'').trim() : 'none';
    })(),
    tabs: [...document.querySelectorAll('li[id^="dct"]')].map(t=>({
      title:(t.getAttribute('title')||'').trim(), active:/active/.test(t.className||'')
    })),
    pageScroll: Math.round((document.scrollingElement||document.documentElement).scrollTop),
    pageMax: (() => { const se=document.scrollingElement||document.documentElement; return se.scrollHeight - se.clientHeight; })()
  })`, topCtx, false));

  console.log('\n=== 2. 检查「下一节」按钮 ===');
  console.log(await ev(sessionId, `(() => {
    const sels = ['#prevNextFocusNext', '.nextChapter', '.prev_next.next'];
    const found = [];
    for (const s of sels) {
      const els = [...document.querySelectorAll(s)];
      els.forEach(e => {
        const r = e.getBoundingClientRect();
        found.push({
          sel: s,
          text: (e.innerText||'').trim().slice(0,10),
          visible: r.width>0 && r.height>0 && r.top>0 && r.top<window.innerHeight,
          top: Math.round(r.top),
          cls: (e.className||'').toString().slice(0,40)
        });
      });
    }
    return JSON.stringify(found, null, 1);
  })()`, topCtx, false));

  console.log('\n=== 3. 启动扩展，观察滚动与翻页 ===');
  await ev(sessionId, `document.getElementById('cs-start')?.click();1`, topCtx, false);

  let lastActive = '', lastTop = -1;
  for (let i = 0; i < 14; i++) {
    await new Promise(r => setTimeout(r, 2200));
    const s = JSON.parse(await ev(sessionId, `(() => {
      const se = document.scrollingElement||document.documentElement;
      const t = [...document.querySelectorAll('li[id^="dct"]')].find(x => /active/.test(x.className||''));
      return JSON.stringify({
        top: Math.round(se.scrollTop),
        max: se.scrollHeight - se.clientHeight,
        tab: t ? (t.getAttribute('title')||'').trim() : 'none',
        status: (document.getElementById('cs-status')?.textContent||'').slice(0,40)
      });
    })()`, topCtx, false));

    const moved = s.top !== lastTop ? '↓' : '·';
    const tabChanged = s.tab !== lastActive && lastActive ? ' 【切标签!】' : '';
    console.log(`  [${(i*2.2).toFixed(1)}s] ${moved} top=${s.top}/${s.max} tab=${s.tab}${tabChanged} | ${s.status}`);
    lastTop = s.top; lastActive = s.tab;

    if (/已到最后一节|停止/.test(s.status)) { console.log('  → 已停止'); break; }
  }

  await ev(sessionId, `document.getElementById('cs-stop')?.click();1`, topCtx, false);

  console.log('\n=== 4. 最终检查 ===');
  console.log(await ev(sessionId, `JSON.stringify({
    activeTab: (() => {
      const t = [...document.querySelectorAll('li[id^="dct"]')].find(x => /active/.test(x.className||''));
      return t ? (t.getAttribute('title')||'').trim() : 'none';
    })(),
    status: document.getElementById('cs-status')?.textContent,
    pageUrl: location.href.slice(0,80)
  })`, topCtx, false));

  socket.destroy();
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

/**
 * 精确定位测验页的「提交」等操作按钮
 * 只找位于题目列表之外的、真正的操作按钮
 */
const http = require('http');
const crypto = require('crypto');

const CDP = `http://127.0.0.1:${process.argv[2] || 9335}`;

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
  const params = { expression: expr, returnByValue: true, awaitPromise: ap, timeout: 60000 };
  if (ctx != null) params.contextId = ctx;
  const r = await send('Runtime.evaluate', params, sid);
  if (r.result?.exceptionDetails) {
    return 'EX: ' + ((r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 400));
  }
  return r.result?.result?.value;
}

(async () => {
  const ver = await getJSON('/json/version');
  await connect(ver.webSocketDebuggerUrl);

  const list = await send('Target.getTargets');
  const pg = (list.result.targetInfos || []).find(t => /studentstudy/.test(t.url || '') && t.type === 'page');
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: pg.targetId, flatten: true });
  await send('Page.enable', {}, sessionId);

  const ft = await send('Page.getFrameTree', {}, sessionId);
  const flat = [];
  (function walk(n, d) {
    if (!n) return;
    flat.push({ d, id: n.frame.id, url: n.frame.url || '' });
    (n.childFrames || []).forEach(c => walk(c, d + 1));
  })(ft.result.frameTree, 0);

  const work = flat.find(f => /work\/doHomeWork/.test(f.url));
  if (!work) { console.log('不在测验页'); process.exit(1); }

  const w = await send('Page.createIsolatedWorld', { frameId: work.id, worldName: 'sub' }, sessionId);
  const ctx = w.result.executionContextId;

  console.log('='.repeat(72));
  console.log('测验页操作按钮（排除选项）');
  console.log('='.repeat(72));

  console.log(await ev(sessionId, `(() => {
    const out = [];
    // 排除 .TiMu / .Zy_ulTop 里的元素
    for (const e of document.querySelectorAll('a,button,input[type=button],input[type=submit],[class*=btn],[class*=Btn]')) {
      if (e.closest('.TiMu') || e.closest('.Zy_ulTop') || e.closest('.mark_item')) continue;
      const t = (e.innerText || e.value || '').trim();
      const r = e.getBoundingClientRect();
      if (r.width < 5 || r.height < 5) continue;
      out.push({
        text: t.slice(0, 20), tag: e.tagName,
        cls: (e.className || '').toString().slice(0, 50), id: e.id,
        onclick: (e.getAttribute('onclick') || '').slice(0, 80),
        href: (e.getAttribute('href') || '').slice(0, 50),
        top: Math.round(r.top + (document.scrollingElement?.scrollTop || 0))
      });
    }
    const seen = new Set();
    return JSON.stringify(out.filter(x => {
      const k = x.text + '|' + x.cls;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    }).slice(0, 30), null, 1);
  })()`, ctx, false));

  console.log('\n' + '='.repeat(72));
  console.log('页面底部区域（提交按钮通常在这）');
  console.log('='.repeat(72));
  console.log(await ev(sessionId, `(() => {
    const se = document.scrollingElement || document.documentElement;
    const out = [];
    for (const e of document.querySelectorAll('div,section,footer')) {
      const cls = (e.className || '').toString();
      if (!/bottom|footer|submit|save|handle|operat|btnbox|btnBox/i.test(cls)) continue;
      const t = (e.innerText || '').replace(/\\s+/g, ' ').trim();
      if (t.length > 100) continue;
      const r = e.getBoundingClientRect();
      out.push({
        tag: e.tagName, cls: cls.slice(0, 55), id: e.id,
        text: t.slice(0, 60),
        visible: r.width > 0 && r.height > 0,
        top: Math.round(r.top + se.scrollTop)
      });
    }
    return JSON.stringify(out.slice(0, 15), null, 1);
  })()`, ctx, false));

  console.log('\n' + '='.repeat(72));
  console.log('全局函数（提交相关）');
  console.log('='.repeat(72));
  console.log(await ev(sessionId, `(() => {
    const names = Object.keys(window).filter(k => {
      try {
        return typeof window[k] === 'function'
          && /submit|save|hand|confirm|commit/i.test(k);
      } catch { return false; }
    });
    return JSON.stringify(names.slice(0, 25));
  })()`, ctx, false));

  console.log('\n' + '='.repeat(72));
  console.log('题目类型分布（20 题）');
  console.log('='.repeat(72));
  console.log(await ev(sessionId, `(() => {
    const qs = [...document.querySelectorAll('.TiMu')];
    return JSON.stringify(qs.map(q => {
      const typeEl = q.querySelector('.newZy_TItle');
      const type = (typeEl?.innerText || '').trim();
      const num = q.getAttribute('data');
      const opts = q.querySelectorAll('.Zy_ulTop li').length;
      const inputs = q.querySelectorAll('input[type=text], textarea').length;
      // 题型标记
      const isMulti = /多选/.test(type);
      const isSingle = /单选/.test(type);
      const isJudge = /判断/.test(type);
      const isFill = /填空/.test(type) || inputs > 0;
      return { num, type: type.slice(0, 15), optCount: opts, inputCount: inputs,
               isMulti, isSingle, isJudge, isFill };
    }), null, 1);
  })()`, ctx, false));

  socket.destroy();
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

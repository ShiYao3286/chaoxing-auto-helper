/**
 * 采集：提交按钮 + 确认弹窗
 *
 * 目标：
 *   1. 页面上「暂时保存」「提交」按钮的完整结构
 *   2. 点「提交」后弹出的确认框结构（提示 / 确认提交? / 取消 / 提交）
 *   3. 确定它们各自在哪个 frame、用什么选择器能点到
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

const H = (t) => console.log('\n' + '='.repeat(74) + '\n' + t + '\n' + '='.repeat(74));

(async () => {
  const ver = await getJSON('/json/version');
  await connect(ver.webSocketDebuggerUrl);

  const list = await send('Target.getTargets');
  const pg = (list.result.targetInfos || []).find(t => /studentstudy/.test(t.url || '') && t.type === 'page');
  if (!pg) { console.log('找不到学习通页面'); process.exit(1); }

  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: pg.targetId, flatten: true });
  await send('Page.enable', {}, sessionId);

  const ft = await send('Page.getFrameTree', {}, sessionId);
  const flat = [];
  (function walk(n, d) {
    if (!n) return;
    flat.push({ d, id: n.frame.id, url: n.frame.url || '' });
    (n.childFrames || []).forEach(c => walk(c, d + 1));
  })(ft.result.frameTree, 0);

  console.log('当前 frames:');
  flat.forEach(f => { if (f.url !== 'about:blank') console.log('  [d' + f.d + '] ' + f.url.slice(0, 70)); });

  /* ================================================================
   * 1. 在所有 frame 里找「提交」「暂时保存」按钮
   * ================================================================ */
  H('1. 提交 / 暂时保存 按钮');

  const frameCtx = {};
  for (const f of flat) {
    if (!f.url || f.url === 'about:blank') continue;
    const w = await send('Page.createIsolatedWorld', { frameId: f.id, worldName: 'p' + f.d + Date.now() + Math.random() }, sessionId);
    const ctx = w.result?.executionContextId;
    if (ctx == null) continue;
    frameCtx[f.d] = ctx;

    const r = await ev(sessionId, `(() => {
      const out = [];

      // A. 已知 class
      for (const sel of ['a.btnSubmit', 'a.btnSave', '.btnSubmit', '.btnSave', '.workBtnIndex']) {
        for (const e of document.querySelectorAll(sel)) {
          const rect = e.getBoundingClientRect();
          out.push({
            sel,
            tag: e.tagName,
            cls: (e.className || '').toString(),
            id: e.id,
            text: (e.innerText || '').trim().slice(0, 15),
            onclick: e.getAttribute('onclick'),
            href: (e.getAttribute('href') || '').slice(0, 40),
            visible: rect.width > 0 && rect.height > 0 && e.offsetParent !== null,
            rect: { w: Math.round(rect.width), h: Math.round(rect.height) }
          });
        }
      }

      // B. 按文字找（兜底）
      for (const e of document.querySelectorAll('a, button, div[class*=btn], span[class*=btn]')) {
        const t = (e.innerText || '').trim();
        if (!/^(提交|交卷|暂存|暂时保存|保存)$/.test(t)) continue;
        const rect = e.getBoundingClientRect();
        if (rect.width < 5 || rect.height < 5) continue;
        const dup = out.some(x => x.cls === (e.className || '').toString() && x.text === t);
        if (dup) continue;
        out.push({
          sel: '(by-text)',
          tag: e.tagName,
          cls: (e.className || '').toString(),
          id: e.id,
          text: t,
          onclick: e.getAttribute('onclick'),
          visible: e.offsetParent !== null,
          rect: { w: Math.round(rect.width), h: Math.round(rect.height) }
        });
      }

      return JSON.stringify({
        url: location.href.slice(0, 50),
        count: out.length,
        buttons: out
      }, null, 2);
    })()`, ctx, false);

    const j = JSON.parse(r);
    if (j.count > 0) {
      console.log('\n[d' + f.d + '] ' + f.url.slice(0, 55));
      console.log(r);
    }
  }

  /* ================================================================
   * 2. 确认弹窗（点提交后出现的）
   * ================================================================ */
  H('2. 确认弹窗结构（DOM 里的所有弹层）');

  for (const f of flat) {
    if (!f.url || f.url === 'about:blank') continue;
    const ctx = frameCtx[f.d];
    if (ctx == null) continue;

    const r = await ev(sessionId, `(() => {
      const out = [];

      // 找所有弹层类容器
      const cands = document.querySelectorAll(
        '[class*=pop], [class*=dialog], [class*=modal], [class*=mask], ' +
        '[id*=pop], [id*=dialog], [id*=confirm], [class*=layer], [class*=Layer]'
      );

      for (const e of cands) {
        const rect = e.getBoundingClientRect();
        const txt = (e.innerText || '').replace(/\\s+/g, ' ').trim();
        const cs = getComputedStyle(e);

        // 只关心含"提交/确认"字样的，或者明显可见的
        const interesting = /提交|确认|确定|取消/.test(txt);
        if (!interesting && rect.width < 50) continue;

        out.push({
          tag: e.tagName,
          cls: (e.className || '').toString().slice(0, 70),
          id: e.id,
          text: txt.slice(0, 100),
          display: cs.display,
          visibility: cs.visibility,
          zIndex: cs.zIndex,
          visible: rect.width > 0 && rect.height > 0 && cs.display !== 'none' && e.offsetParent !== null,
          rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
          // 内部按钮
          innerBtns: [...e.querySelectorAll('a, button, input[type=button]')]
            .map(b => ({
              tag: b.tagName,
              cls: (b.className || '').toString().slice(0, 50),
              id: b.id,
              text: (b.innerText || b.value || '').trim().slice(0, 15),
              onclick: (b.getAttribute('onclick') || '').slice(0, 60),
              visible: b.offsetParent !== null
            }))
            .slice(0, 8)
        });
      }

      const seen = new Set();
      const uniq = out.filter(x => {
        const k = x.cls + '|' + x.id;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

      return JSON.stringify({ url: location.href.slice(0, 45), count: uniq.length, dialogs: uniq.slice(0, 10) }, null, 2);
    })()`, ctx, false);

    const j = JSON.parse(r);
    if (j.count > 0) {
      console.log('\n[d' + f.d + '] ' + f.url.slice(0, 55));
      console.log(r);
    }
  }

  /* ================================================================
   * 3. 相关全局函数
   * ================================================================ */
  H('3. 提交相关全局函数');

  for (const f of flat) {
    if (!f.url || f.url === 'about:blank') continue;
    const ctx = frameCtx[f.d];
    if (ctx == null) continue;

    const r = await ev(sessionId, `(() => {
      const out = [];
      for (const k of Object.keys(window)) {
        try {
          if (typeof window[k] !== 'function') continue;
          if (!/submit|Submit|confirm|Confirm|checkAnswer|saveWork|noSubmit/i.test(k)) continue;
          out.push({ name: k, src: window[k].toString().replace(/\\s+/g, ' ').slice(0, 200) });
        } catch {}
      }
      return JSON.stringify({ url: location.href.slice(0, 45), funcs: out.slice(0, 12) }, null, 2);
    })()`, ctx, false);

    const j = JSON.parse(r);
    if (j.funcs.length > 0) {
      console.log('\n[d' + f.d + '] ' + f.url.slice(0, 55));
      console.log(r);
    }
  }

  socket.destroy();
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

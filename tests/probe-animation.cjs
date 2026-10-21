/**
 * 采集：动画资源页面元素
 *
 * 目标：搞清楚「动画资源」这种任务点的结构
 *   - 它是什么形式（视频？flash？canvas？iframe？）
 *   - 完成条件是什么
 *   - 任务点标记长什么样
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
  if (!pg) { console.log('找不到页面'); process.exit(1); }

  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: pg.targetId, flatten: true });
  await send('Page.enable', {}, sessionId);

  const ft0 = await send('Page.getFrameTree', {}, sessionId);
  const top0 = ft0.result.frameTree.frame.id;
  const w0 = await send('Page.createIsolatedWorld', { frameId: top0, worldName: 'nav' }, sessionId);
  const c0 = w0.result.executionContextId;

  H('切换到「动画资源」标签');

  console.log(await ev(sessionId, `(() => {
    const t=[...document.querySelectorAll('li[id^="dct"]')].find(x=>/动画资源/.test(x.getAttribute('title')||''));
    if(!t) return '没找到动画资源标签';
    t.click();
    return '已点击: ' + (t.getAttribute('title')||'') + '  onclick=' + (t.getAttribute('onclick')||'').slice(0,60);
  })()`, c0, false));

  await new Promise(r => setTimeout(r, 14000));

  const ft = await send('Page.getFrameTree', {}, sessionId);
  const flat = [];
  (function walk(n, d) {
    if (!n) return;
    flat.push({ d, id: n.frame.id, url: n.frame.url || '' });
    (n.childFrames || []).forEach(c => walk(c, d + 1));
  })(ft.result.frameTree, 0);

  console.log('\n=== frames ===');
  flat.forEach(f => { if (f.url !== 'about:blank') console.log('  [d' + f.d + '] ' + f.url.slice(0, 80)); });

  for (const f of flat) {
    if (!f.url || f.url === 'about:blank') continue;

    const w = await send('Page.createIsolatedWorld', { frameId: f.id, worldName: 'p' + f.d + Date.now() + Math.random() }, sessionId);
    const ctx = w.result?.executionContextId;
    if (ctx == null) continue;

    // 基础信息
    const basic = await ev(sessionId, `(() => {
      const se = document.scrollingElement || document.documentElement;
      return JSON.stringify({
        url: location.href.slice(0, 60),
        bodyLen: (document.body?.innerText || '').length,
        docRange: se ? se.scrollHeight - se.clientHeight : 0,
        videos: document.querySelectorAll('video').length,
        canvases: document.querySelectorAll('canvas').length,
        embeds: document.querySelectorAll('embed, object').length,
        iframes: [...document.querySelectorAll('iframe')].filter(x => x.offsetHeight > 60).length
      });
    })()`, ctx, false);

    const j = JSON.parse(basic);
    if (j.bodyLen < 20 && j.videos === 0 && j.canvases === 0 && j.embeds === 0) continue;

    console.log('\n' + '─'.repeat(70));
    console.log(`[d${f.d}] ${f.url.slice(0, 70)}`);
    console.log('基础: ' + basic);

    // 任务点图标
    const icons = await ev(sessionId, `(() => {
      const out = [];
      for (const e of document.querySelectorAll('[class*="ans-job"]')) {
        out.push({
          tag: e.tagName,
          cls: (e.className || '').toString(),
          aria: e.getAttribute('aria-label'),
          text: (e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
          html: e.outerHTML.slice(0, 300)
        });
      }
      return JSON.stringify(out, null, 2);
    })()`, ctx, false);
    if (icons && icons !== '[]') console.log('\n任务点图标:\n' + icons);

    // 动画/媒体元素
    const media = await ev(sessionId, `(() => {
      const out = {
        video: [...document.querySelectorAll('video')].map(v => ({
          id: v.id, cls: (v.className || '').toString().slice(0, 40),
          dur: isFinite(v.duration) ? +v.duration.toFixed(1) : null,
          ct: +v.currentTime.toFixed(1), paused: v.paused, rate: v.playbackRate,
          src: (v.currentSrc || v.src || '').slice(0, 60)
        })),
        canvas: [...document.querySelectorAll('canvas')].map(c => ({
          id: c.id, cls: (c.className || '').toString().slice(0, 40),
          w: c.width, h: c.height
        })),
        embed: [...document.querySelectorAll('embed, object')].map(e => ({
          tag: e.tagName, type: e.getAttribute('type') || '',
          src: (e.getAttribute('src') || e.getAttribute('data') || '').slice(0, 70)
        })),
        // 可能的动画容器
        animLike: [...document.querySelectorAll('[class*=anim],[class*=Anim],[id*=anim],[id*=Anim],[class*=flash],[class*=Flash]')]
          .slice(0, 8).map(e => ({
            tag: e.tagName, id: e.id, cls: (e.className || '').toString().slice(0, 50),
            h: e.offsetHeight
          }))
      };
      return JSON.stringify(out, null, 2);
    })()`, ctx, false);
    console.log('\n媒体元素:\n' + media);

    // 页面文字
    const txt = await ev(sessionId, `(() => {
      const t = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
      return JSON.stringify({
        head: t.slice(0, 250),
        hasDone: /已完成/.test(t),
        hasTodo: /待完成|未完成/.test(t),
        taskTexts: [...new Set((t.match(/[^。\\n]{0,30}任务点[^。\\n]{0,30}/g) || []))].slice(0, 5)
      }, null, 2);
    })()`, ctx, false);
    console.log('\n页面文字:\n' + txt);
  }

  socket.destroy();
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

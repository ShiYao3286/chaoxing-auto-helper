/**
 * 探查视频任务的完成度判定依据
 * 目标：找出「视频看完没有」的可靠信号
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

  // 先切回微课学习
  const ft0 = await send('Page.getFrameTree', {}, sessionId);
  const topId = ft0.result.frameTree.frame.id;
  let w = await send('Page.createIsolatedWorld', { frameId: topId, worldName: 'nav' }, sessionId);
  let ctx = w.result.executionContextId;

  console.log('=== 跳回 5.4.3 微课章节 ===');
  console.log(await ev(sessionId, `(() => {
    const n = document.getElementById('cur1210130608');
    if (!n) return '没找到';
    (n.querySelector('.posCatalog_name') || n).click();
    return '已点击';
  })()`, ctx, false));

  await new Promise(r => setTimeout(r, 9000));

  const ft = await send('Page.getFrameTree', {}, sessionId);
  const flat = [];
  (function walk(n, d) {
    if (!n) return;
    flat.push({ d, id: n.frame.id, url: n.frame.url || '' });
    (n.childFrames || []).forEach(c => walk(c, d + 1));
  })(ft.result.frameTree, 0);

  console.log('\n当前 frames:');
  flat.forEach(f => { if (f.url !== 'about:blank') console.log('  [d' + f.d + '] ' + f.url.slice(0, 75)); });

  // ============ 视频帧：找完成度信号 ============
  const vidFrame = flat.find(f => /ananas\/modules\/video/.test(f.url));
  if (vidFrame) {
    w = await send('Page.createIsolatedWorld', { frameId: vidFrame.id, worldName: 'v2' }, sessionId);
    ctx = w.result.executionContextId;

    console.log('\n' + '='.repeat(72));
    console.log('视频帧：完成度信号探查');
    console.log('='.repeat(72));

    console.log('\n【A】video 元素全部属性:');
    console.log(await ev(sessionId, `(() => {
      const v = document.querySelector('video');
      if (!v) return '无';
      const attrs = {};
      for (const a of v.attributes) attrs[a.name] = a.value.slice(0, 60);
      return JSON.stringify({
        duration: v.duration, durationFinite: isFinite(v.duration),
        currentTime: v.currentTime, readyState: v.readyState, networkState: v.networkState,
        paused: v.paused, ended: v.ended, playbackRate: v.playbackRate,
        attrs,
        dataset: {...v.dataset}
      }, null, 2);
    })()`, ctx, false));

    console.log('\n【B】页面全局变量（可能存着时长/进度）:');
    console.log(await ev(sessionId, `(() => {
      const keys = Object.keys(window).filter(k => {
        try {
          const s = k.toLowerCase();
          return /time|duration|progress|video|play|watch|job|task|finish|complete|study/.test(s)
            && typeof window[k] !== 'function'
            && typeof window[k] !== 'object';
        } catch { return false; }
      });
      const out = {};
      for (const k of keys.slice(0, 30)) {
        try { out[k] = String(window[k]).slice(0, 60); } catch {}
      }
      // 对象型的也查一下关键几个
      const objs = {};
      for (const k of ['videojs','player','video','ansVideo','videoData','playerData','taskInfo','jobInfo']) {
        try {
          if (window[k] != null) {
            objs[k] = typeof window[k] === 'object'
              ? Object.keys(window[k]).slice(0, 15)
              : String(window[k]).slice(0, 40);
          }
        } catch {}
      }
      return JSON.stringify({ scalars: out, objects: objs }, null, 1);
    })()`, ctx, false));

    console.log('\n【C】播放器进度条 DOM:');
    console.log(await ev(sessionId, `(() => {
      const out = [];
      for (const e of document.querySelectorAll('[class*=progress],[class*=time],[class*=duration],[class*=control]')) {
        const t = (e.innerText || '').replace(/\\s+/g, ' ').trim();
        const cls = (e.className || '').toString();
        if (!cls) continue;
        out.push({
          cls: cls.slice(0, 55),
          text: t.slice(0, 40),
          role: e.getAttribute('role') || '',
          ariaValueNow: e.getAttribute('aria-valuenow') || '',
          style: (e.getAttribute('style') || '').slice(0, 60)
        });
      }
      const seen = new Set();
      return JSON.stringify(out.filter(x => {
        const k = x.cls + '|' + x.text;
        if (seen.has(k)) return false;
        seen.add(k); return true;
      }).slice(0, 15), null, 1);
    })()`, ctx, false));

    console.log('\n【D】本帧 body 文本（找「已完成/未完成」）:');
    console.log(await ev(sessionId, `(() => {
      const t = (document.body?.innerText || '').replace(/\\s+/g, ' ');
      return JSON.stringify({
        text: t.slice(0, 400),
        hasCompleted: /已完成|完成了/.test(t),
        hasUnfinished: /未完成|待完成/.test(t)
      }, null, 2);
    })()`, ctx, false));
  }

  // ============ cards 帧：任务点完成标记 ============
  const cardFrame = flat.find(f => /knowledge\/cards/.test(f.url));
  if (cardFrame) {
    w = await send('Page.createIsolatedWorld', { frameId: cardFrame.id, worldName: 'c2' }, sessionId);
    ctx = w.result.executionContextId;

    console.log('\n' + '='.repeat(72));
    console.log('cards 帧：任务点完成标记');
    console.log('='.repeat(72));

    console.log(await ev(sessionId, `(() => {
      const html = document.body?.innerHTML || '';
      const text = (document.body?.innerText || '').replace(/\\s+/g, ' ');
      return JSON.stringify({
        text: text.slice(0, 350),
        // 任务点图标
        marks: [...document.querySelectorAll('[class*=job],[class*=task],[class*=point],[class*=finish],[class*=complete]')]
          .map(e => ({ cls: (e.className || '').toString().slice(0, 50), text: (e.innerText || '').trim().slice(0, 20) }))
          .filter(x => x.text || x.cls).slice(0, 12),
        // 关键：找 jobid / taskid 等属性
        jobAttrs: [...document.querySelectorAll('[jobid],[taskid],[data-jobid],[data-taskid]')]
          .map(e => ({
            tag: e.tagName,
            cls: (e.className || '').toString().slice(0, 40),
            jobid: e.getAttribute('jobid'),
            taskid: e.getAttribute('taskid'),
            dataJobid: e.getAttribute('data-jobid')
          })).slice(0, 8),
        hasCompletedText: /已完成/.test(text),
        hasUnfinishedText: /未完成|待完成/.test(text)
      }, null, 2);
    })()`, ctx, false));
  }

  // ============ 顶层：jobhint ============
  w = await send('Page.createIsolatedWorld', { frameId: topId, worldName: 't2' }, sessionId);
  ctx = w.result.executionContextId;

  console.log('\n' + '='.repeat(72));
  console.log('顶层：jobhint（任务点计数）');
  console.log('='.repeat(72));
  console.log(await ev(sessionId, `(() => {
    const jh = document.getElementById('jobhint');
    return JSON.stringify({
      exists: !!jh,
      text: jh ? (jh.textContent || '').trim() : null,
      title: jh ? (jh.getAttribute('title') || '') : null,
      html: jh ? jh.outerHTML.slice(0, 300) : null,
      // 当前激活节点
      cur: (() => {
        const c = [...document.querySelectorAll('.posCatalog_select')].find(n => /active|current/i.test(n.className || ''));
        return c ? {
          id: c.id,
          text: (c.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
          done: !!c.querySelector('.icon_Completed'),
          todo: !!c.querySelector('.catalog_points_yi')
        } : null;
      })()
    }, null, 2);
  })()`, ctx, false));

  socket.destroy();
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

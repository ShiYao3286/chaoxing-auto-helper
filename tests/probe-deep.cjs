/**
 * 深度探查：视频任务进度 + 视频下方的题目结构
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

  // ============ A. 视频帧深度探查 ============
  const vidFrame = flat.find(f => /ananas\/modules\/video/.test(f.url));
  if (vidFrame) {
    const w = await send('Page.createIsolatedWorld', { frameId: vidFrame.id, worldName: 'v' }, sessionId);
    const ctx = w.result.executionContextId;

    console.log('='.repeat(70));
    console.log('A. 视频帧（ananas/modules/video）');
    console.log('='.repeat(70));
    console.log(await ev(sessionId, `(() => {
      const v = document.querySelector('video');
      if (!v) return '无视频';
      const p = window.videojs && v.id ? window.videojs.getPlayer(v.id) : null;
      return JSON.stringify({
        video: {
          id: v.id, cls: v.className,
          duration: isFinite(v.duration) ? +v.duration.toFixed(1) : v.duration,
          currentTime: +v.currentTime.toFixed(1),
          paused: v.paused, ended: v.ended, readyState: v.readyState,
          networkState: v.networkState,
          buffered: v.buffered.length ? {start:+v.buffered.start(0).toFixed(1), end:+v.buffered.end(v.buffered.length-1).toFixed(1)} : null,
          src: (v.currentSrc||v.src||'').slice(0,80)
        },
        player: p ? {exists:true, duration:typeof p.duration==='function'?p.duration():null,
                     currentTime:typeof p.currentTime==='function'?p.currentTime():null} : {exists:false},
        // 页面上的进度显示
        progressTexts: [...document.querySelectorAll('[class*=progress],[class*=time],[class*=duration]')]
          .map(e=>({cls:(e.className||'').toString().slice(0,40), text:(e.textContent||'').trim().slice(0,30)}))
          .filter(x=>x.text).slice(0,8),
        bodyText: (document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,200)
      }, null, 2);
    })()`, ctx, false));
  } else {
    console.log('A. 视频帧: 不存在（可能不是视频任务点）');
  }

  // ============ B. knowledge/cards 帧：题目结构 ============
  const cardFrame = flat.find(f => /knowledge\/cards/.test(f.url));
  if (cardFrame) {
    const w = await send('Page.createIsolatedWorld', { frameId: cardFrame.id, worldName: 'c' }, sessionId);
    const ctx = w.result.executionContextId;

    console.log('\n' + '='.repeat(70));
    console.log('B. knowledge/cards 帧（题目在这里）');
    console.log('='.repeat(70));

    // B1. 找所有可能承载题目的容器
    console.log('\n[B1] 题目容器全面扫描:');
    console.log(await ev(sessionId, `(() => {
      const sels = [
        '.questionLi','.TiMu','.mark_item','.Cy_TItle','.answerList','.stem_answer',
        '.question','.timu','.subject','.answer','.option','.choice',
        '[class*=question]','[class*=TiMu]','[class*=timu]','[class*=subject]',
        '.mark_item .questionLi','.ans-attach-online'
      ];
      const out = {};
      for (const s of sels) {
        try {
          const els = document.querySelectorAll(s);
          if (els.length) {
            out[s] = { count: els.length, first: {
              tag: els[0].tagName,
              cls: (els[0].className||'').toString().slice(0,60),
              text: (els[0].innerText||'').replace(/\\s+/g,' ').trim().slice(0,80)
            }};
          }
        } catch {}
      }
      return JSON.stringify(out, null, 1);
    })()`, ctx, false));

    // B2. 找 iframe 里的内容
    console.log('\n[B2] 本帧 iframe 列表:');
    console.log(await ev(sessionId, `(() => {
      return JSON.stringify([...document.querySelectorAll('iframe')].map(f => ({
        src: (f.src||'').slice(0,70),
        w: f.offsetWidth, h: f.offsetHeight,
        visible: f.offsetParent !== null && f.offsetWidth > 50,
        cls: (f.className||'').toString().slice(0,50),
        id: f.id
      })), null, 1);
    })()`, ctx, false));

    // B3. 完整 body 文本，看有什么
    console.log('\n[B3] 本帧全部可见文本:');
    console.log(await ev(sessionId, `(() => {
      return JSON.stringify({
        bodyHTML_LEN: document.body?.innerHTML?.length || 0,
        bodyText: (document.body?.innerText||'').replace(/\\s+/g,' ').slice(0, 500),
        // 所有直接子元素
        topChildren: [...(document.body?.children||[])].map(e=>({
          tag: e.tagName, cls:(e.className||'').toString().slice(0,50), id:e.id,
          h: e.offsetHeight, children: e.children.length
        }))
      }, null, 2);
    })()`, ctx, false));
  }

  // ============ C. 顶层：任务点完成状态 ============
  const topFrame = flat.find(f => f.d === 0);
  if (topFrame) {
    const w = await send('Page.createIsolatedWorld', { frameId: topFrame.id, worldName: 't' }, sessionId);
    const ctx = w.result.executionContextId;

    console.log('\n' + '='.repeat(70));
    console.log('C. 顶层：当前章节任务点状态');
    console.log('='.repeat(70));
    console.log(await ev(sessionId, `(() => {
      // jobhint 是任务点计数
      const jh = document.getElementById('jobhint');
      // 找当前激活的课程树节点
      const cur = [...document.querySelectorAll('.posCatalog_select')].find(n => /active|current/i.test(n.className||''));
      // 找"任务点"相关文字
      const txt = (document.body?.innerText||'').replace(/\\s+/g,' ');
      const m = txt.match(/[^。\\n]{0,40}任务点[^。\\n]{0,40}/g) || [];
      return JSON.stringify({
        jobhint: jh ? {
          text: (jh.textContent||'').trim(),
          title: (jh.getAttribute('title')||'').slice(0,50),
          visible: jh.offsetParent !== null,
          html: jh.outerHTML.slice(0,300)
        } : null,
        currentTreeNode: cur ? {
          id: cur.id,
          text: (cur.textContent||'').replace(/\\s+/g,' ').trim().slice(0,80),
          done: !!cur.querySelector('.icon_Completed'),
          todo: !!cur.querySelector('.catalog_points_yi'),
          todoCount: (cur.querySelector('.orangeNew')?.textContent||'').trim()
        } : null,
        taskPointTexts: [...new Set(m)].slice(0, 8)
      }, null, 2);
    })()`, ctx, false));
  }

  socket.destroy();
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

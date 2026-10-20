/**
 * 全量元素采集脚本
 *
 * 目的：一次性把学习通页面里所有跟「任务点 / 视频 / 题目 / 按钮」
 * 相关的元素结构抓出来，供后续修复代码参考。
 *
 * 用法：node probe-all.cjs [CDP端口]
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

  console.log('='.repeat(70));
  console.log('页面: ' + pg.url.slice(0, 100));
  console.log('Frame 数: ' + flat.filter(f => f.url && f.url !== 'about:blank').length);
  console.log('='.repeat(70));

  for (const f of flat) {
    if (!f.url || f.url === 'about:blank') continue;

    const w = await send('Page.createIsolatedWorld', { frameId: f.id, worldName: 'probe' + Date.now() + Math.random() }, sessionId);
    const ctx = w.result?.executionContextId;
    if (ctx == null) continue;

    console.log('\n' + '─'.repeat(70));
    console.log(`[d${f.d}] ${f.url.slice(0, 90)}`);
    console.log('─'.repeat(70));

    // ---- 基础信息 ----
    const basic = await ev(sessionId, `(() => {
      const se = document.scrollingElement || document.documentElement;
      return JSON.stringify({
        title: (document.title || '').slice(0, 40),
        booted: document.documentElement.getAttribute('data-cs-booted'),
        bodyLen: (document.body?.innerText || '').length,
        docRange: se ? se.scrollHeight - se.clientHeight : 0,
        videos: document.querySelectorAll('video').length,
        iframes: [...document.querySelectorAll('iframe')].filter(x => x.offsetHeight > 80).length
      });
    })()`, ctx, false);
    console.log('基础: ' + basic);

    // ---- 视频信息 ----
    const vid = await ev(sessionId, `(() => {
      const vs = [...document.querySelectorAll('video')];
      if (!vs.length) return '[]';
      return JSON.stringify(vs.map(v => ({
        id: v.id,
        cls: (v.className || '').toString().slice(0, 40),
        src: (v.currentSrc || v.src || '').slice(0, 60),
        duration: isFinite(v.duration) ? +v.duration.toFixed(1) : null,
        currentTime: +v.currentTime.toFixed(1),
        paused: v.paused,
        ended: v.ended,
        readyState: v.readyState,
        rate: v.playbackRate,
        // 播放器外层容器
        parentCls: (v.parentElement?.className || '').toString().slice(0, 50),
        // 上层是否有 videojs
        hasVideojs: !!(window.videojs && v.id && window.videojs.getPlayer && window.videojs.getPlayer(v.id))
      })));
    })()`, ctx, false);
    if (vid && vid !== '[]') console.log('视频: ' + vid);

    // ---- 任务点标记 ----
    const tp = await ev(sessionId, `(() => {
      const sels = {
        icon_Completed: '.icon_Completed',
        catalog_points_yi: '.catalog_points_yi',
        orangeNew: '.orangeNew',
        posCatalog_select: '.posCatalog_select',
        prevTips: '.prevTips',
        jobhint: '.jobhint',
        mark_item: '.mark_item',
        ansAttach: '.ans-attach-online',
        // 任务点常见容器
        taskPoint: '[class*=taskPoint],[class*=taskpoint],[class*=task_point]'
      };
      const out = {};
      for (const [k, s] of Object.entries(sels)) {
        try {
          const els = [...document.querySelectorAll(s)];
          if (els.length) {
            out[k] = {
              count: els.length,
              sample: els.slice(0, 3).map(e => ({
                tag: e.tagName,
                cls: (e.className || '').toString().slice(0, 50),
                id: e.id,
                text: (e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
                title: (e.getAttribute('title') || '').slice(0, 30),
                visible: e.offsetParent !== null
              }))
            };
          }
        } catch {}
      }
      return JSON.stringify(out, null, 1);
    })()`, ctx, false);
    if (tp && tp !== '{}') console.log('任务点标记: ' + tp);

    // ---- 页面文字里的任务点提示 ----
    const hints = await ev(sessionId, `(() => {
      const t = (document.body?.innerText || '');
      const pats = [
        /任务点[^\\n]{0,30}/g,
        /待完成[^\\n]{0,20}/g,
        /已完成[^\\n]{0,20}/g,
        /观看时长[^\\n]{0,40}/g,
        /不可倍速[^\\n]{0,30}/g
      ];
      const found = new Set();
      for (const p of pats) {
        const m = t.match(p);
        if (m) m.slice(0, 5).forEach(x => found.add(x.replace(/\\s+/g, ' ').trim()));
      }
      return JSON.stringify([...found].slice(0, 12), null, 1);
    })()`, ctx, false);
    if (hints && hints !== '[]') console.log('文字提示: ' + hints);

    // ---- 题目相关 ----
    const quiz = await ev(sessionId, `(() => {
      const sels = {
        questionLi: '.questionLi',
        TiMu: '.TiMu',
        mark_item: '.mark_item',
        Cy_TItle: '.Cy_TItle',
        answerList: '.answerList',
        stem_answer: '.stem_answer',
        radio: 'input[type=radio]',
        checkbox: 'input[type=checkbox]',
        textarea: 'textarea',
        questionContainer: '[class*=question]',
        timu: '[class*=TiMu],[class*=timu]'
      };
      const out = {};
      for (const [k, s] of Object.entries(sels)) {
        try {
          const n = document.querySelectorAll(s).length;
          if (n) out[k] = n;
        } catch {}
      }
      // 如果找到题目，抓第一题的完整结构
      let firstQ = null;
      const qEl = document.querySelector('.questionLi, .TiMu, .mark_item');
      if (qEl) {
        firstQ = {
          tag: qEl.tagName,
          cls: (qEl.className || '').toString().slice(0, 60),
          html: qEl.outerHTML.slice(0, 600),
          text: (qEl.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 150)
        };
      }
      return JSON.stringify({ counts: out, firstQ }, null, 1);
    })()`, ctx, false);
    if (quiz && quiz !== '{"counts":{}}') console.log('题目: ' + quiz);

    // ---- 按钮 ----
    const btns = await ev(sessionId, `(() => {
      const out = [];
      const sels = ['#prevNextFocusNext', '.nextChapter', '.preChapter', '#prevNextFocusPrev'];
      for (const s of sels) {
        for (const e of document.querySelectorAll(s)) {
          const r = e.getBoundingClientRect();
          out.push({
            sel: s,
            text: (e.innerText || '').trim().slice(0, 8),
            visible: r.width > 0 && r.height > 0 && e.offsetParent !== null,
            w: Math.round(r.width), h: Math.round(r.height)
          });
        }
      }
      // 按文字找
      const byText = [...document.querySelectorAll('a,button')].filter(e => {
        const t = (e.innerText || '').trim();
        return /^(下一节|上一节|提交|交卷)$/.test(t) && e.offsetParent !== null;
      }).map(e => ({
        text: (e.innerText || '').trim(),
        cls: (e.className || '').toString().slice(0, 40)
      }));
      return JSON.stringify({ bySel: out, byText }, null, 1);
    })()`, ctx, false);
    if (btns && btns !== '{"bySel":[],"byText":[]}') console.log('按钮: ' + btns);

    // ---- 选项卡 ----
    const tabs = await ev(sessionId, `(() => {
      const t = [...document.querySelectorAll('li[id^="dct"], .orientationleft li')];
      if (!t.length) return '[]';
      return JSON.stringify(t.map(li => ({
        id: li.id,
        title: (li.getAttribute('title') || li.textContent || '').trim().slice(0, 15),
        active: /active/.test(li.className || ''),
        cls: (li.className || '').toString().slice(0, 30),
        onclick: (li.getAttribute('onclick') || '').slice(0, 60)
      })));
    })()`, ctx, false);
    if (tabs && tabs !== '[]') console.log('选项卡: ' + tabs);
  }

  // ---- 全局：课程树任务点状态 ----
  console.log('\n' + '='.repeat(70));
  console.log('课程树节点状态（前 20 个）');
  console.log('='.repeat(70));
  const treeTop = flat.find(f => f.d === 0);
  if (treeTop) {
    const w = await send('Page.createIsolatedWorld', { frameId: treeTop.id, worldName: 'tree' }, sessionId);
    const ctx = w.result?.executionContextId;
    const tree = await ev(sessionId, `(() => {
      const nodes = [...document.querySelectorAll('.posCatalog_select')];
      return JSON.stringify(nodes.slice(0, 20).map(n => ({
        name: (n.querySelector('.posCatalog_name')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 45),
        done: !!n.querySelector('.icon_Completed'),
        todo: !!n.querySelector('.catalog_points_yi'),
        todoCount: (n.querySelector('.orangeNew')?.textContent || '').trim(),
        active: /active|current/i.test(n.className || '')
      })), null, 1);
    })()`, ctx, false);
    console.log(tree);
  }

  socket.destroy();
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

/**
 * 测验页面元素全量采集
 * 目标：搞清学习通测验页的题目结构、选项、填空、按钮
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

  console.log('当前 frames:');
  flat.forEach(f => { if (f.url !== 'about:blank') console.log('  [d' + f.d + '] ' + f.url.slice(0, 80)); });

  for (const f of flat) {
    if (!f.url || f.url === 'about:blank') continue;

    const w = await send('Page.createIsolatedWorld', { frameId: f.id, worldName: 'q' + Date.now() + Math.random() }, sessionId);
    const ctx = w.result?.executionContextId;
    if (ctx == null) continue;

    const basic = await ev(sessionId, `(() => {
      const se = document.scrollingElement || document.documentElement;
      return JSON.stringify({
        title: document.title,
        bodyLen: (document.body?.innerText || '').length,
        docRange: se ? se.scrollHeight - se.clientHeight : 0,
        videos: document.querySelectorAll('video').length
      });
    })()`, ctx, false);

    // 只关注有内容的帧
    const j = JSON.parse(basic);
    if (j.bodyLen < 50 && j.videos === 0) continue;

    console.log('\n' + '='.repeat(72));
    console.log(`[d${f.d}] ${f.url.slice(0, 85)}`);
    console.log('基础: ' + basic);
    console.log('='.repeat(72));

    // ---- 1. 题目容器全扫描 ----
    console.log('\n【1】题目容器扫描:');
    console.log(await ev(sessionId, `(() => {
      const sels = [
        '.questionLi', '.TiMu', '.mark_item', '.Cy_TItle', '.stem_answer',
        '.answerList', '.question', '.timu', '.subject', '.option', '.choice',
        '.ans-attach-online', '.ans-job-icon', '.mark_table',
        '[class*=question]', '[class*=TiMu]', '[class*=timu]',
        '.queTitle', '.queBody', '.answerBg', '.singleQuesId',
        'ul.answerList', 'li.num_option', '.judge', '.fill',
        'input[type=radio]', 'input[type=checkbox]', 'textarea'
      ];
      const out = {};
      for (const s of sels) {
        try {
          const els = document.querySelectorAll(s);
          if (els.length) {
            out[s] = {
              count: els.length,
              sample: {
                tag: els[0].tagName,
                cls: (els[0].className || '').toString().slice(0, 55),
                id: els[0].id,
                text: (els[0].innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 70)
              }
            };
          }
        } catch {}
      }
      return JSON.stringify(out, null, 1);
    })()`, ctx, false));

    // ---- 2. 页面文字结构 ----
    console.log('\n【2】页面文字（前 800 字）:');
    console.log(await ev(sessionId, `(() => {
      return JSON.stringify((document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 800));
    })()`, ctx, false));

    // ---- 3. 题目完整 HTML（第一题）----
    console.log('\n【3】第一题完整结构:');
    console.log(await ev(sessionId, `(() => {
      // 按优先级找题目元素
      const cands = [
        '.questionLi', '.TiMu', '.mark_item', '.Cy_TItle',
        '#questionLi', '.mark_table .TiMu', '[class*=question]:not(.trans-question-box)'
      ];
      for (const s of cands) {
        const els = document.querySelectorAll(s);
        for (const el of els) {
          const t = (el.innerText || '').trim();
          if (t.length > 10) {
            return JSON.stringify({
              matchedSel: s,
              tag: el.tagName,
              cls: (el.className || '').toString().slice(0, 60),
              id: el.id,
              html: el.outerHTML.slice(0, 1200),
              text: t.replace(/\\s+/g, ' ').slice(0, 200)
            }, null, 2);
          }
        }
      }
      return '未找到题目元素';
    })()`, ctx, false));

    // ---- 4. 按钮 ----
    console.log('\n【4】按钮:');
    console.log(await ev(sessionId, `(() => {
      const out = [];
      for (const e of document.querySelectorAll('a, button, input[type=button], input[type=submit], .btn, .jb_btn, [class*=btn]')) {
        const t = (e.innerText || e.value || '').trim();
        if (!t || t.length > 20) continue;
        const r = e.getBoundingClientRect();
        if (r.width < 5 || r.height < 5) continue;
        out.push({ text: t, tag: e.tagName, cls: (e.className || '').toString().slice(0, 40), id: e.id });
      }
      // 去重
      const seen = new Set();
      return JSON.stringify(out.filter(x => {
        const k = x.text + '|' + x.cls;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).slice(0, 20), null, 1);
    })()`, ctx, false));
  }

  socket.destroy();
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

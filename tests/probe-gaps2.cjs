/**
 * 补采（不导航版）
 * 直接在当前已加载的测验页上采集，避免页面重载
 */
const http = require('http');
const crypto = require('crypto');

const PORT = process.argv[2] || 9335;
const CDP = `http://127.0.0.1:${PORT}`;

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
  const pg = (list.result.targetInfos || []).find(t => /studentstudy|doHomeWork/.test(t.url || '') && t.type === 'page');
  if (!pg) { console.log('找不到页面'); process.exit(1); }

  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: pg.targetId, flatten: true });
  await send('Page.enable', {}, sessionId);

  const ft = await send('Page.getFrameTree', {}, sessionId);
  const flat = [];
  (function walk(n, d) { if (!n) return; flat.push({ d, id: n.frame.id, url: n.frame.url || '' }); (n.childFrames || []).forEach(c => walk(c, d + 1)); })(ft.result.frameTree, 0);

  console.log('当前 frames:');
  flat.forEach(f => { if (f.url !== 'about:blank') console.log('  [d' + f.d + '] ' + f.url.slice(0, 70)); });

  const workFrame = flat.find(f => /work\/doHomeWork/.test(f.url));
  if (!workFrame) { console.log('\n当前不是测验页，请先跳到测验章节'); process.exit(1); }

  const w = await send('Page.createIsolatedWorld', { frameId: workFrame.id, worldName: 'q' }, sessionId);
  const ctx = w.result.executionContextId;

  // 确认题目已加载
  const ready = await ev(sessionId, `JSON.stringify({
    timu: document.querySelectorAll('.TiMu').length,
    bodyLen: (document.body?.innerText||'').length
  })`, ctx, false);
  console.log('\n题目加载状态: ' + ready);
  if (JSON.parse(ready).timu === 0) {
    console.log('题目还没渲染出来，等 10 秒再试...');
    await new Promise(r => setTimeout(r, 10000));
    const again = await ev(sessionId, `document.querySelectorAll('.TiMu').length`, ctx, false);
    console.log('等待后题目数: ' + again);
    if (again === 0) { console.log('仍然没有，退出'); process.exit(1); }
  }

  /* ===== 补采 1：填空题 ===== */
  H('补采1：填空题完整结构');

  console.log(await ev(sessionId, `(() => {
    const qs = [...document.querySelectorAll('.TiMu')];
    const fills = qs.filter(q => /填空/.test((q.querySelector('.newZy_TItle')?.innerText || '')));
    if (!fills.length) {
      // 兜底：找没有选项但有输入框的题
      const alt = qs.filter(q => q.querySelectorAll('.Zy_ulTop li').length === 0);
      return JSON.stringify({ msg:'没匹配到填空文字', 无选项题数: alt.length,
        types: qs.map(q=>(q.querySelector('.newZy_TItle')?.innerText||'').trim()).filter((v,i,a)=>a.indexOf(v)===i) });
    }
    const q = fills[0];
    return JSON.stringify({
      count: fills.length,
      dataAttr: q.getAttribute('data'),
      outerHTML: q.outerHTML.slice(0, 2200),
      allInputs: [...q.querySelectorAll('input, textarea, [contenteditable]')].map(i => ({
        tag: i.tagName, type: i.type || '',
        cls: (i.className || '').toString().slice(0, 50),
        id: i.id, name: i.name, placeholder: i.placeholder || '',
        outerHTML: i.outerHTML.slice(0, 180)
      })),
      titleHTML: (q.querySelector('.Zy_TItle')?.outerHTML || '').slice(0, 700)
    }, null, 2);
  })()`, ctx, false));

  /* ===== 补采 2：判断题 ===== */
  H('补采2：判断题（选项文字是什么）');

  console.log(await ev(sessionId, `(() => {
    const qs = [...document.querySelectorAll('.TiMu')];
    const judges = qs.filter(q => /判断/.test((q.querySelector('.newZy_TItle')?.innerText || '')));
    if (!judges.length) return '没找到判断题';
    const q = judges[0];
    return JSON.stringify({
      count: judges.length,
      outerHTML: q.outerHTML.slice(0, 1800),
      options: [...q.querySelectorAll('.Zy_ulTop li')].map(li => ({
        role: li.getAttribute('role'),
        qid: li.getAttribute('qid'),
        qtype: li.getAttribute('qtype'),
        onclick: li.getAttribute('onclick'),
        letter: li.querySelector('.num_option_dx')?.getAttribute('data'),
        letterText: (li.querySelector('.num_option_dx')?.innerText || '').trim(),
        optText: (li.querySelector('a.after')?.innerText || '').trim()
      }))
    }, null, 2);
  })()`, ctx, false));

  /* ===== 补采 3：多选题点击行为 ===== */
  H('补采3：多选题点击行为（能否取消）');

  console.log(await ev(sessionId, `(async () => {
    const qs = [...document.querySelectorAll('.TiMu')];
    const multi = qs.find(q => /多选/.test((q.querySelector('.newZy_TItle')?.innerText || '')));
    if (!multi) return '没找到多选题';
    const li = multi.querySelector('.Zy_ulTop li');
    const qid = li.getAttribute('qid');
    const read = () => document.getElementById('answer' + qid)?.value ?? '(无此元素)';
    const readCls = () => (li.querySelector('.num_option_dx')?.className || '').toString();

    const before = { v: read(), c: readCls() };
    li.click();
    await new Promise(r => setTimeout(r, 350));
    const first = { v: read(), c: readCls() };
    li.click();
    await new Promise(r => setTimeout(r, 350));
    const second = { v: read(), c: readCls() };
    li.click();   // 还原
    await new Promise(r => setTimeout(r, 250));

    return JSON.stringify({
      qid, before, afterClick1: first, afterClick2: second,
      可取消: first.v !== second.v,
      隐藏域存在: first.v !== '(无此元素)'
    }, null, 2);
  })()`, ctx, false));

  /* ===== 补采 4：单选题点击行为 ===== */
  H('补采4：单选题点击行为');

  console.log(await ev(sessionId, `(async () => {
    const qs = [...document.querySelectorAll('.TiMu')];
    const single = qs.find(q => /单选/.test((q.querySelector('.newZy_TItle')?.innerText || '')));
    if (!single) return '没找到单选题';
    const lis = [...single.querySelectorAll('.Zy_ulTop li')];
    if (lis.length < 2) return '选项不足 2 个';
    const qid = lis[0].getAttribute('qid');
    const read = () => document.getElementById('answer' + qid)?.value ?? '(无)';
    const readType = () => document.getElementById('answertype' + qid)?.value ?? '(无)';

    const before = read();
    lis[0].click();
    await new Promise(r => setTimeout(r, 350));
    const afterA = read();
    lis[1].click();
    await new Promise(r => setTimeout(r, 350));
    const afterB = read();
    lis[0].click();  // 还原
    await new Promise(r => setTimeout(r, 250));

    return JSON.stringify({
      qid, before, afterA, afterB,
      answertype: readType(),
      单选生效: afterA !== before && afterB !== afterA
    }, null, 2);
  })()`, ctx, false));

  /* ===== 补采 5：答案隐藏域命名 ===== */
  H('补采5：答案隐藏域全部清单');

  console.log(await ev(sessionId, `(() => {
    const inputs = [...document.querySelectorAll('input[id^="answer"]')];
    const groups = {};
    inputs.forEach(i => {
      const m = i.id.match(/^answer(type)?(\\d+)$/);
      if (m) {
        const key = m[2];
        if (!groups[key]) groups[key] = {};
        groups[key][m[1] ? 'type' : 'value'] = i.value || '';
      }
    });
    return JSON.stringify({
      total: inputs.length,
      groupCount: Object.keys(groups).length,
      sample: Object.entries(groups).slice(0, 8).map(([k, v]) => ({ qid: k, ...v }))
    }, null, 2);
  })()`, ctx, false));

  /* ===== 补采 6：提交按钮精确信息 ===== */
  H('补采6：提交按钮精确属性');

  console.log(await ev(sessionId, `(() => {
    const out = [];
    for (const sel of ['a.btnSubmit', 'a.btnSave', '.workBtnIndex', '.btnSubmit', '.btnSave']) {
      for (const e of document.querySelectorAll(sel)) {
        const r = e.getBoundingClientRect();
        out.push({
          sel,
          tag: e.tagName,
          cls: (e.className || '').toString(),
          text: (e.innerText || '').trim(),
          onclick: e.getAttribute('onclick'),
          visible: r.width > 0 && r.height > 0,
          rect: { w: Math.round(r.width), h: Math.round(r.height) }
        });
      }
    }
    const seen = new Set();
    return JSON.stringify(out.filter(x => {
      const k = x.cls + x.text;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    }), null, 1);
  })()`, ctx, false));

  /* ===== 补采 7：提交相关全局函数 ===== */
  H('补采7：提交相关全局函数（在 work 帧内）');

  console.log(await ev(sessionId, `(() => {
    const out = [];
    for (const k of Object.keys(window)) {
      try {
        if (typeof window[k] !== 'function') continue;
        if (!/submit|save|check|verify|confirm|review|answer|choice/i.test(k)) continue;
        const src = window[k].toString().replace(/\\s+/g, ' ').slice(0, 130);
        out.push({ name: k, src });
      } catch {}
    }
    return JSON.stringify(out.slice(0, 20), null, 1);
  })()`, ctx, false));

  socket.destroy();
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

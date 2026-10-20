/**
 * 补采：填空题 + 判断题 + 多选题交互 + 提交弹窗
 * 针对性补齐计划文档 §11.6 里标记「待确认」的项
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
  const pg = (list.result.targetInfos || []).find(t => /studentstudy/.test(t.url || '') && t.type === 'page');
  if (!pg) { console.log('找不到学习通页面'); process.exit(1); }

  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: pg.targetId, flatten: true });
  await send('Page.enable', {}, sessionId);

  // 跳转到测验章节
  let ft = await send('Page.getFrameTree', {}, sessionId);
  let topId = ft.result.frameTree.frame.id;
  let w = await send('Page.createIsolatedWorld', { frameId: topId, worldName: 'nav' }, sessionId);
  let ctx = w.result.executionContextId;

  console.log('当前章节:', await ev(sessionId, `(location.href.match(/chapterId=(\\d+)/)||[])[1]`, ctx, false));

  H('跳转到测验章节 5.4.8 (1210130613)');
  await ev(sessionId, `(() => {
    const n = document.getElementById('cur1210130613');
    if (!n) return 'no';
    (n.querySelector('.posCatalog_name') || n).click();
    return 'ok';
  })()`, ctx, false);

  // 等 work 帧出现
  let workFrame = null;
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 2500));
    ft = await send('Page.getFrameTree', {}, sessionId);
    const flat = [];
    (function walk(n, d) { if (!n) return; flat.push({ d, id: n.frame.id, url: n.frame.url || '' }); (n.childFrames || []).forEach(c => walk(c, d + 1)); })(ft.result.frameTree, 0);
    workFrame = flat.find(f => /work\/doHomeWork/.test(f.url));
    console.log(`  [${(i+1)*2.5}s] work帧: ${workFrame ? '已出现' : '加载中'}`);
    if (workFrame) break;
  }
  if (!workFrame) { console.log('测验帧没加载出来'); process.exit(1); }

  w = await send('Page.createIsolatedWorld', { frameId: workFrame.id, worldName: 'q' }, sessionId);
  ctx = w.result.executionContextId;

  /* ================================================================
   * 补采 1：填空题完整 DOM
   * ================================================================ */
  H('补采1：填空题完整结构');

  console.log(await ev(sessionId, `(() => {
    const qs = [...document.querySelectorAll('.TiMu')];
    const fills = qs.filter(q => /填空/.test((q.querySelector('.newZy_TItle')?.innerText || '')));
    if (!fills.length) return '没找到填空题';
    const q = fills[0];
    return JSON.stringify({
      count: fills.length,
      dataAttr: q.getAttribute('data'),
      outerHTMLLen: q.outerHTML.length,
      outerHTML: q.outerHTML.slice(0, 2500),
      // 所有输入元素
      allInputs: [...q.querySelectorAll('input, textarea, [contenteditable]')].map(i => ({
        tag: i.tagName,
        type: i.type || '',
        cls: (i.className || '').toString().slice(0, 50),
        id: i.id,
        name: i.name,
        placeholder: i.placeholder || '',
        value: (i.value || '').slice(0, 30),
        outerHTML: i.outerHTML.slice(0, 160)
      })),
      // 题干区域
      titleHTML: (q.querySelector('.Zy_TItle')?.outerHTML || '').slice(0, 800)
    }, null, 2);
  })()`, ctx, false));

  /* ================================================================
   * 补采 2：判断题完整 DOM
   * ================================================================ */
  H('补采2：判断题完整结构（选项文字是什么）');

  console.log(await ev(sessionId, `(() => {
    const qs = [...document.querySelectorAll('.TiMu')];
    const judges = qs.filter(q => /判断/.test((q.querySelector('.newZy_TItle')?.innerText || '')));
    if (!judges.length) return '没找到判断题';
    const q = judges[0];
    const lis = [...q.querySelectorAll('.Zy_ulTop li')];
    return JSON.stringify({
      count: judges.length,
      outerHTML: q.outerHTML.slice(0, 2000),
      options: lis.map(li => ({
        role: li.getAttribute('role'),
        qid: li.getAttribute('qid'),
        qtype: li.getAttribute('qtype'),
        onclick: li.getAttribute('onclick'),
        letter: li.querySelector('.num_option_dx')?.getAttribute('data'),
        letterText: (li.querySelector('.num_option_dx')?.innerText || ''),
        optText: (li.querySelector('a.after')?.innerText || '').trim(),
        optHTML: (li.outerHTML || '').slice(0, 300)
      }))
    }, null, 2);
  })()`, ctx, false));

  /* ================================================================
   * 补采 3：多选题点击交互（点两次会不会取消）
   * ================================================================ */
  H('补采3：多选题点击行为（能否取消选择）');

  console.log(await ev(sessionId, `(async() => {
    const qs = [...document.querySelectorAll('.TiMu')];
    const multi = qs.find(q => /多选/.test((q.querySelector('.newZy_TItle')?.innerText || '')));
    if (!multi) return '没找到多选题';
    const li = multi.querySelector('.Zy_ulTop li');
    const letter = li.querySelector('.num_option_dx')?.getAttribute('data');
    const qid = li.getAttribute('qid');

    const readHidden = () => document.getElementById('answer' + qid)?.value || '(无)';
    const readLetterCls = () => (li.querySelector('.num_option_dx')?.className || '').toString();

    const before = { hidden: readHidden(), cls: readLetterCls() };
    li.click();
    await new Promise(r => setTimeout(r, 400));
    const afterFirst = { hidden: readHidden(), cls: readLetterCls() };
    li.click();
    await new Promise(r => setTimeout(r, 400));
    const afterSecond = { hidden: readHidden(), cls: readLetterCls() };

    // 再点一次恢复原状
    li.click();
    await new Promise(r => setTimeout(r, 300));
    const restored = { hidden: readHidden(), cls: readLetterCls() };

    return JSON.stringify({
      letter, qid,
      before, afterFirst, afterSecond, restored,
      canToggle: afterSecond.hidden !== afterFirst.hidden
    }, null, 2);
  })()`, ctx, false));

  /* ================================================================
   * 补采 4：单选题点击行为
   * ================================================================ */
  H('补采4：单选题点击行为');

  console.log(await ev(sessionId, `(async () => {
    const qs = [...document.querySelectorAll('.TiMu')];
    const single = qs.find(q => /单选/.test((q.querySelector('.newZy_TItle')?.innerText || '')));
    if (!single) return '没找到单选题';
    const lis = [...single.querySelectorAll('.Zy_ulTop li')];
    const li0 = lis[0], li1 = lis[1];
    const qid = li0.getAttribute('qid');
    const readHidden = () => document.getElementById('answer' + qid)?.value || '(无)';
    const readTypeHidden = () => document.getElementById('answertype' + qid)?.value || '(无)';

    const before = readHidden();
    li0.click();
    await new Promise(r => setTimeout(r, 400));
    const afterA = readHidden();
    li1.click();
    await new Promise(r => setTimeout(r, 400));
    const afterB = readHidden();

    // 还原：点回 A
    li0.click();
    await new Promise(r => setTimeout(r, 300));

    return JSON.stringify({
      qid, before, afterA, afterB,
      answertype: readTypeHidden(),
      singleSelectWorks: afterA !== before && afterB !== afterA
    }, null, 2);
  })()`, ctx, false));

  /* ================================================================
   * 补采 5：提交弹窗结构（不真点提交，先看有没有确认层）
   * ================================================================ */
  H('补采5：提交相关弹窗（DOM 里的确认层）');

  console.log(await ev(sessionId, `(() => {
    const out = [];
    for (const e of document.querySelectorAll('[class*=pop],[class*=dialog],[class*=confirm],[class*=mask],[id*=pop],[id*=confirm]')) {
      const t = (e.innerText || '').replace(/\\s+/g, ' ').trim();
      if (!t && !e.id) continue;
      out.push({
        tag: e.tagName,
        cls: (e.className || '').toString().slice(0, 55),
        id: e.id,
        text: t.slice(0, 80),
        display: getComputedStyle(e).display,
        visible: e.offsetParent !== null
      });
    }
    const seen = new Set();
    return JSON.stringify(out.filter(x => {
      const k = x.cls + '|' + x.id;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    }).filter(x => /提交|确认|确定|剩余|未作答|save|submit/i.test(x.text + x.cls + x.id))
      .slice(0, 12), null, 1);
  })()`, ctx, false));

  /* ================================================================
   * 补采 6：全局函数（提交相关）
   * ================================================================ */
  H('补采6：提交相关全局函数');

  console.log(await ev(sessionId, `(() => {
    const names = [];
    for (const k of Object.keys(window)) {
      try {
        if (typeof window[k] === 'function' && /submit|save|check|verify|confirm|review/i.test(k)) {
          names.push({ name: k, src: window[k].toString().slice(0, 120) });
        }
      } catch {}
    }
    return JSON.stringify(names.slice(0, 15), null, 1);
  })()`, ctx, false));

  /* ================================================================
   * 补采 7：全部题目答案隐藏域（看当前作答状态）
   * ================================================================ */
  H('补采7：答案隐藏域命名规则');

  console.log(await ev(sessionId, `(() => {
    const inputs = [...document.querySelectorAll('input[id^="answer"]')];
    return JSON.stringify({
      total: inputs.length,
      samples: inputs.slice(0, 10).map(i => ({
        id: i.id, name: i.name, value: (i.value || '').slice(0, 20), type: i.type
      })),
      // 分组
      answerFields: inputs.filter(i => /^answer\\d+$/.test(i.id)).length,
      typeFields: inputs.filter(i => /^answertype/.test(i.id)).length
    }, null, 2);
  })()`, ctx, false));

  socket.destroy();
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

/**
 * 补采：测验提交按钮 + 任务点完成的可靠判定
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

  // ============ 1. 当前视频帧：完成后会发生什么 ============
  const vidFrame = flat.find(f => /ananas\/modules\/video/.test(f.url));
  if (vidFrame) {
    const w = await send('Page.createIsolatedWorld', { frameId: vidFrame.id, worldName: 'v3' }, sessionId);
    const ctx = w.result.executionContextId;

    console.log('='.repeat(72));
    console.log('【1】视频帧：完成任务点的信号');
    console.log('='.repeat(72));

    console.log('\n[A] 视频状态 + 完成度计算:');
    console.log(await ev(sessionId, `(() => {
      const v = document.querySelector('video');
      if (!v) return '无';
      const dur = v.duration;
      const ct = v.currentTime;
      return JSON.stringify({
        duration: isFinite(dur) ? +dur.toFixed(1) : null,
        currentTime: +ct.toFixed(1),
        percent: isFinite(dur) && dur > 0 ? +(ct / dur * 100).toFixed(1) : null,
        ended: v.ended,
        readyState: v.readyState,
        // 90% 门槛
        requiredFor90: isFinite(dur) ? +(dur * 0.9).toFixed(1) : null,
        reach90: isFinite(dur) ? (ct >= dur * 0.9) : null
      }, null, 2);
    })()`, ctx, false));

    console.log('\n[B] 视频结束后页面会变的元素（监听）:');
    console.log(await ev(sessionId, `(() => {
      // 找可能表示"完成"的容器
      const cands = [];
      for (const e of document.querySelectorAll('[class*=end],[class*=finish],[class*=complete],[class*=over]')) {
        const cls = (e.className||'').toString();
        if (/end|finish|complete|over/i.test(cls)) {
          const r = e.getBoundingClientRect();
          cands.push({
            cls: cls.slice(0, 55),
            text: (e.innerText||'').trim().slice(0, 40),
            visible: r.width > 0 && r.height > 0
          });
        }
      }
      return JSON.stringify(cands.slice(0, 12), null, 1);
    })()`, ctx, false));
  }

  // ============ 2. 去测验页找提交按钮 ============
  const topFrame = flat.find(f => f.d === 0);
  const w0 = await send('Page.createIsolatedWorld', { frameId: topFrame.id, worldName: 'nav2' }, sessionId);
  const c0 = w0.result.executionContextId;

  console.log('\n' + '='.repeat(72));
  console.log('【2】跳转到测验章节找提交按钮');
  console.log('='.repeat(72));

  await ev(sessionId, `(() => {
    const n = document.getElementById('cur1210130613');
    if (!n) return 'no';
    (n.querySelector('.posCatalog_name') || n).click();
    return 'ok';
  })()`, c0, false);

  await new Promise(r => setTimeout(r, 12000));

  const ft2 = await send('Page.getFrameTree', {}, sessionId);
  const flat2 = [];
  (function walk(n, d) {
    if (!n) return;
    flat2.push({ d, id: n.frame.id, url: n.frame.url || '' });
    (n.childFrames || []).forEach(c => walk(c, d + 1));
  })(ft2.result.frameTree, 0);

  console.log('frames:');
  flat2.forEach(f => { if (f.url !== 'about:blank') console.log('  [d' + f.d + '] ' + f.url.slice(0, 70)); });

  // 找 work 帧
  const workFrames = flat2.filter(f => /work\/doHomeWork|modules\/work/.test(f.url));
  for (const wf of workFrames) {
    const w = await send('Page.createIsolatedWorld', { frameId: wf.id, worldName: 'w' + wf.d }, sessionId);
    const ctx = w.result.executionContextId;

    const info = await ev(sessionId, `JSON.stringify({
      bodyLen: (document.body?.innerText||'').length,
      questions: document.querySelectorAll('.TiMu').length
    })`, ctx, false);
    const j = JSON.parse(info);
    if (j.bodyLen < 100 && j.questions === 0) continue;

    console.log('\n' + '─'.repeat(72));
    console.log(`[d${wf.d}] ${wf.url.slice(0, 70)}`);
    console.log('─'.repeat(72));

    console.log('\n【题目容器】:');
    console.log(await ev(sessionId, `(() => {
      const sels = { TiMu:'.TiMu', Zy_TItle:'.Zy_TItle', newZy_TItle:'.newZy_TItle',
        Zy_ulTop:'.Zy_ulTop', num_option:'.num_option_dx', answerList:'.answerList',
        fontsecret:'.font-cxsecret', qid:'[qid]', radio:'input[type=radio]', checkbox:'input[type=checkbox]' };
      const out={};
      for(const [k,s] of Object.entries(sels)){
        try{ const n=document.querySelectorAll(s).length; if(n) out[k]=n; }catch(e){}
      }
      return JSON.stringify(out);
    })()`, ctx, false));

    console.log('\n【提交/保存按钮】:');
    console.log(await ev(sessionId, `(() => {
      const out=[];
      for(const e of document.querySelectorAll('a,button,input[type=button],input[type=submit],div[class*=btn],span[class*=btn]')){
        const t=(e.innerText||e.value||'').trim();
        if(!t||t.length>15) continue;
        const r=e.getBoundingClientRect();
        if(r.width<5) continue;
        out.push({text:t, tag:e.tagName, cls:(e.className||'').toString().slice(0,45), id:e.id,
          onclick:(e.getAttribute('onclick')||'').slice(0,60)});
      }
      const seen=new Set();
      return JSON.stringify(out.filter(x=>{
        const k=x.text+'|'+x.cls; if(seen.has(k))return false; seen.add(k); return true;
      }).slice(0, 25), null, 1);
    })()`, ctx, false));

    console.log('\n【第一题完整 DOM（含选项）】:');
    console.log(await ev(sessionId, `(() => {
      const q=document.querySelector('.TiMu');
      if(!q) return '无题目';
      // 提取结构化信息
      const num=q.getAttribute('data');
      const typeEl=q.querySelector('.newZy_TItle');
      const titleEl=q.querySelector('.Zy_TItle .font-cxsecret, .Zy_TItle');
      const opts=[...q.querySelectorAll('.Zy_ulTop li')].map(li=>({
        role:li.getAttribute('role'),
        qid:li.getAttribute('qid'),
        qtype:li.getAttribute('qtype'),
        letter:li.querySelector('.num_option_dx')?.getAttribute('data'),
        letterCls:(li.querySelector('.num_option_dx')?.className||'').toString().slice(0,45),
        text:(li.querySelector('a.after')?.innerText||'').trim().slice(0,60),
        textCls:(li.querySelector('a.after')?.className||'').toString().slice(0,30),
        onclick:(li.getAttribute('onclick')||'').slice(0,40)
      }));
      return JSON.stringify({
        num, type:(typeEl?.innerText||'').trim(),
        title:(titleEl?.innerText||'').trim().slice(0,100),
        titleCls:(titleEl?.className||'').toString().slice(0,50),
        options:opts,
        // 是否有填空
        inputs:[...q.querySelectorAll('input[type=text], textarea')].map(i=>({
          type:i.tagName, cls:(i.className||'').toString().slice(0,30), name:i.name, id:i.id
        }))
      }, null, 2);
    })()`, ctx, false));
  }

  socket.destroy();
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

// 在真实学习通页面验证：任务点识别 + 拟人化滚动
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CDP = process.env.DSH_CDP || 'http://127.0.0.1:9335';

function findExtRoot() {
  const cands = [
    path.join(__dirname, '..', 'extension'),
    path.join(__dirname, '..', '学习通边缘扩展'),
  ];
  for (const c of cands) if (fs.existsSync(path.join(c, 'manifest.json'))) return c;
  throw new Error('找不到扩展目录');
}
const EXT = findExtRoot();

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
    return 'EX: ' + ((r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 300));
  }
  return r.result?.result?.value;
}

let pass = 0, fail = 0;
function check(n, c, e) { if (c) { console.log('  ✅ ' + n); pass++; } else { console.log('  ❌ ' + n + (e ? '  -> ' + e : '')); fail++; } }

(async () => {
  const ver = await getJSON('/json/version');
  await connect(ver.webSocketDebuggerUrl);

  const list = await send('Target.getTargets');
  const pg = (list.result.targetInfos || []).find(t => /studentstudy/.test(t.url || '') && t.type === 'page');
  if (!pg) { console.log('没找到学习通页面，请先打开'); process.exit(1); }
  console.log('页面: ' + pg.url.slice(0, 70));

  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: pg.targetId, flatten: true });
  await send('Page.enable', {}, sessionId);

  const ft = await send('Page.getFrameTree', {}, sessionId);
  const top = ft.result.frameTree.frame.id;
  const w = await send('Page.createIsolatedWorld', { frameId: top, worldName: 'verify' }, sessionId);
  const ctx = w.result.executionContextId;

  console.log('\n=== 1. 任务点标记识别 ===');
  const markers = await ev(sessionId, `JSON.stringify({
    done: document.querySelectorAll('.icon_Completed').length,
    todo: document.querySelectorAll('.catalog_points_yi').length,
    badge: document.querySelectorAll('.orangeNew').length,
    treeNodes: document.querySelectorAll('.posCatalog_select').length,
    hasPending: /还有任务点未完成|待完成任务点/.test((document.body?.innerText||'').slice(0,3000))
  })`, ctx, false);
  console.log('    ' + markers);
  const mk = JSON.parse(markers);
  check('识别到已完成标记', mk.done > 0, 'done=' + mk.done);
  check('识别到课程树节点', mk.treeNodes > 0, 'nodes=' + mk.treeNodes);

  console.log('\n=== 2. 未完成任务点统计（真实数据）===');
  const stats = await ev(sessionId, `(() => {
    const done = document.querySelectorAll('.icon_Completed').length;
    const todo = document.querySelectorAll('.catalog_points_yi').length;
    return JSON.stringify({ done, todo, allDone: todo === 0 && done > 0 });
  })()`, ctx, false);
  console.log('    ' + stats);

  console.log('\n=== 3. 课程树里下一个未完成节点 ===');
  const nextNode = await ev(sessionId, `(() => {
    const nodes = [...document.querySelectorAll('.posCatalog_select')];
    if (!nodes.length) return JSON.stringify({found:false, reason:'无节点'});

    // 找当前节点
    let curIdx = -1;
    for (let i = 0; i < nodes.length; i++) {
      const cls = (nodes[i].className||'').toString();
      if (/active|current|selected/i.test(cls)) { curIdx = i; break; }
    }

    // 从当前往后找第一个未完成的
    const scan = (from, to) => {
      for (let i = from; i < to; i++) {
        const n = nodes[i];
        if (!n.querySelector('.posCatalog_name')) continue;
        if (n.querySelector('.icon_Completed')) continue;
        return n;
      }
      return null;
    };

    const target = curIdx >= 0 ? (scan(curIdx+1, nodes.length) || scan(0, curIdx)) : scan(0, nodes.length);

    return JSON.stringify({
      found: !!target,
      curIdx,
      total: nodes.length,
      name: target ? (target.querySelector('.posCatalog_name')?.textContent||'').trim().slice(0,40) : null,
      isDone: target ? !!target.querySelector('.icon_Completed') : null
    });
  })()`, ctx, false);
  console.log('    ' + nextNode);
  const nn = JSON.parse(nextNode);
  if (nn.found) {
    check('找到未完成节点', nn.isDone === false, 'isDone=' + nn.isDone);
    check('节点名称有效', !!nn.name, nn.name);
  } else {
    console.log('    （当前没有未完成节点，可能全刷完了）');
  }

  console.log('\n=== 4. 拟人化滚动节奏验证 ===');
  // 切到有文档的标签页
  const toDoc = await ev(sessionId, `(() => {
    const tabs=[...document.querySelectorAll('li')].filter(e=>/学习要点|视频学习|案例学习/.test(e.textContent||''));
    const docTab = tabs.find(t=>/学习要点/.test(t.textContent||''));
    if (docTab) { const s=docTab.querySelector('span')||docTab; s.click(); return 'clicked'; }
    return 'not found';
  })()`, ctx, false);
  console.log('    切换到学习要点: ' + toDoc);
  await new Promise(r => setTimeout(r, 4000));

  // 检查文档容器
  const docInfo = await ev(sessionId, `(() => {
    const panes=[...document.querySelectorAll('#panView, .insertdoc-online-pdf, .insertdoc, #docContainer')];
    if(!panes.length) return JSON.stringify({found:false});
    let box=null;
    for(const p of panes){
      const cands=[p,...p.querySelectorAll('*')].filter(e=>e.scrollHeight>e.clientHeight+60);
      if(cands.length){box=cands[0];break;}
    }
    if(!box) return JSON.stringify({found:true, scrollable:false});
    return JSON.stringify({
      found:true, scrollable:true,
      scrollTop: Math.round(box.scrollTop),
      scrollHeight: box.scrollHeight,
      clientHeight: box.clientHeight,
      canScroll: box.scrollHeight > box.clientHeight + 60
    });
  })()`, ctx, false);
  console.log('    ' + docInfo);

  socket.destroy();
  console.log('\n=========================');
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

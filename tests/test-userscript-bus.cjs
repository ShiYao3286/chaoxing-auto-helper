/**
 * 跨帧总线测试（脚本版）
 *
 * 扩展靠 background 汇总 busy；脚本版靠 BroadcastChannel。
 * 这里用同源多 iframe 页面验证：
 *   1. 子帧能拿到顶层的 tabId
 *   2. 子帧 frameKey 是序号链，顶层是 'top'
 *   3. 子帧广播 busy → 顶层 tab:busy 能感知
 *   4. 子帧上报 detail → 顶层能取回
 *   5. 顶层广播 state:changed → 子帧收到
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CDP = process.env.DSH_CDP || 'http://127.0.0.1:9335';
const WEB = process.env.DSH_WEB || 'http://127.0.0.1:8793';

let socket = null, idCounter = 0;
const pending = new Map();
let buf = Buffer.alloc(0);

const getJSON = p => new Promise((res, rej) => {
  http.get(CDP + p, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});
function connect(w) {
  return new Promise((resolve, reject) => {
    const u = new URL(w), k = crypto.randomBytes(16).toString('base64');
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': k, 'Sec-WebSocket-Version': '13' } });
    req.on('upgrade', (r, s) => { socket = s; s.on('data', onData); resolve(); });
    req.on('error', reject); req.end();
  });
}
function onData(ch) {
  buf = Buffer.concat([buf, ch]);
  while (buf.length >= 2) {
    const op = buf[0] & 0x0f; let len = buf[1] & 0x7f, off = 2;
    if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    if (buf.length < off + len) return;
    const pl = buf.subarray(off, off + len); buf = buf.subarray(off + len);
    if (op === 1) { try { const m = JSON.parse(pl.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch { /* ignore */ } }
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
    const mk = crypto.randomBytes(4), m2 = Buffer.alloc(len);
    for (let i = 0; i < len; i++) m2[i] = pl[i] ^ mk[i % 4];
    socket.write(Buffer.concat([h, mk, m2]));
  });
}
async function ev(sid, expr, ap = true) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: ap, timeout: 30000 }, sid);
  if (r.result?.exceptionDetails) {
    return 'EX: ' + ((r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 400));
  }
  return r.result?.result?.value;
}

let pass = 0, fail = 0;
function check(n, c, e) {
  if (c) { console.log('  ✅ ' + n); pass++; }
  else { console.log('  ❌ ' + n + (e !== undefined ? '  -> ' + e : '')); fail++; }
}

const USERSCRIPT = path.join(__dirname, '..', 'userscript', '学习通自动学习助手.user.js');

(async () => {
  const ver = await getJSON('/json/version');
  await connect(ver.webSocketDebuggerUrl);
  const code = fs.readFileSync(USERSCRIPT, 'utf8');

  // 造一个带 2 个同源 iframe 的宿主页
  const HOST_HTML = `<!DOCTYPE html><html><body>
    <iframe id="f0" src="/fake-quiz.html?sub=0"></iframe>
    <iframe id="f1" src="/fake-quiz.html?sub=1"></iframe>
  </body></html>`;

  const cr = await send('Target.createTarget', { url: WEB + '/blank-host.html' });
  const { result: { sessionId: topSid } } = await send('Target.attachToTarget', { targetId: cr.result.targetId, flatten: true });
  await send('Runtime.enable', {}, topSid);
  await new Promise(r => setTimeout(r, 1200));

  // 把宿主页内容写进去（同源，写 document 最简单）
  await ev(topSid, `document.open();document.write(${JSON.stringify(HOST_HTML)});document.close();1`, false);
  await new Promise(r => setTimeout(r, 2500));

  console.log('\n=== 1. 顶层注入 ===');
  const GM_STUB = `
    window.GM_getValue = function(){ return arguments[1]; };
    window.GM_setValue = function(){};
    window.GM_registerMenuCommand = function(){};
    window.GM_xmlhttpRequest = function(){};
  `;
  await ev(topSid, GM_STUB, false);
  const topInj = await ev(topSid, code + '\n;1', false);
  check('顶层注入无异常', !String(topInj).startsWith('EX:'), String(topInj).slice(0, 200));
  await new Promise(r => setTimeout(r, 800));

  const topInfo = JSON.parse(await ev(topSid, `JSON.stringify({
    kind: window.CSHost && window.CSHost.kind,
    frameKey: window.CSHost?._debug?.frameKey,
    tabId: window.CSHost?._debug?.tabId,
    hasBus: window.CSHost?._debug?.hasBus ? window.CSHost._debug.hasBus() : null,
    htmlTabId: document.documentElement.getAttribute('data-cs-tabid')
  })`));
  console.log('   ' + JSON.stringify(topInfo));
  check('顶层 Host 是脚本形态', topInfo.kind === 'userscript', topInfo.kind);
  check('顶层 frameKey = top', topInfo.frameKey === 'top', topInfo.frameKey);
  check('顶层生成 tabId', !!topInfo.tabId, topInfo.tabId);
  check('tabId 写进 <html>', topInfo.htmlTabId === topInfo.tabId, topInfo.htmlTabId);
  check('总线已建立', topInfo.hasBus === true, topInfo.hasBus);

  console.log('\n=== 2. 子帧注入 ===');
  // 遍历 iframe 的 window
  const subInject = await ev(topSid, `(async () => {
    const out = [];
    for (const f of document.querySelectorAll('iframe')) {
      try {
        const w = f.contentWindow;
        if (!w) { out.push({ ok:false, why:'no window' }); continue; }
        // 注入 GM 桩到子帧
        w.eval(${JSON.stringify(GM_STUB)});
        w.eval(${JSON.stringify(code)});
        await new Promise(r => setTimeout(r, 300));
        out.push({
          ok: true,
          frameKey: w.CSHost?._debug?.frameKey,
          tabId: w.CSHost?._debug?.tabId,
          hasBus: w.CSHost?._debug?.hasBus ? w.CSHost._debug.hasBus() : null
        });
      } catch (e) { out.push({ ok:false, why:String(e && e.message).slice(0,120) }); }
    }
    return JSON.stringify(out);
  })()`);
  const subs = JSON.parse(subInject);
  console.log('   ' + JSON.stringify(subs));
  check('两个子帧都注入了', subs.length === 2 && subs.every(s => s.ok), JSON.stringify(subs));
  check('子帧能读到顶层 tabId', subs[0] && subs[0].tabId === topInfo.tabId, subs[0]?.tabId);
  check('子帧 frameKey 是序号链', subs[0] && subs[0].frameKey === '0', subs[0]?.frameKey);
  check('第二个子帧 key = 1', subs[1] && subs[1].frameKey === '1', subs[1]?.frameKey);
  check('子帧总线已建立', subs.every(s => s.hasBus === true));

  console.log('\n=== 3. 子帧忙 → 顶层能感知 ===');
  // 子帧 0 广播 busy
  await ev(topSid, `(async () => {
    const w = document.querySelectorAll('iframe')[0].contentWindow;
    await w.CSHost.sendNoWait('frame:status', { status: '视频学习中', busy: true });
    await new Promise(r => setTimeout(r, 600));
    return 1;
  })()`, false);
  await new Promise(r => setTimeout(r, 600));

  const busySeen = JSON.parse(await ev(topSid, `(async () => {
    const r = await window.CSHost.send('tab:busy');
    return JSON.stringify({ busy: r && r.busy, count: r && r.agg && r.agg.count });
  })()`));
  console.log('   ' + JSON.stringify(busySeen));
  check('顶层看到有人在忙', busySeen.busy === true, busySeen.busy);
  check('agg.count 包含子帧', busySeen.count >= 2, busySeen.count);

  console.log('\n=== 4. 子帧上报明细 → 顶层能取回 ===');
  const detailFlow = JSON.parse(await ev(topSid, `(async () => {
    const w = document.querySelectorAll('iframe')[1].contentWindow;
    await w.CSHost.sendNoWait('frame:taskdetail', {
      detail: { total: 2, done: 1, items: [{kind:'视频', done:true},{kind:'测验', done:false}] }
    });
    await new Promise(r => setTimeout(r, 700));
    const r = await window.CSHost.send('tab:busy');
    return JSON.stringify({
      total: r && r.agg && r.agg.detail && r.agg.detail.total,
      done: r && r.agg && r.agg.detail && r.agg.detail.done
    });
  })()`));
  console.log('   ' + JSON.stringify(detailFlow));
  check('顶层取回任务点明细', detailFlow.total === 2, detailFlow.total);
  check('明细完成数正确', detailFlow.done === 1, detailFlow.done);

  console.log('\n=== 5. 顶层广播开始 → 子帧收到 ===');
  const cmdFlow = JSON.parse(await ev(topSid, `(async () => {
    // 让子帧 0 监听 state:changed
    const w = document.querySelectorAll('iframe')[0].contentWindow;
    w.__GOT_CMD__ = null;
    w.CSHost.on((msg) => { if (msg && msg.type === 'state:changed') w.__GOT_CMD__ = msg.running; });
    await window.CSHost.setRunning(true);
    await new Promise(r => setTimeout(r, 800));
    return JSON.stringify({ got: w.__GOT_CMD__ });
  })()`));
  console.log('   ' + JSON.stringify(cmdFlow));
  check('子帧收到开始命令', cmdFlow.got === true, cmdFlow.got);

  console.log('\n============================================');
  console.log('  结果：' + pass + ' 通过，' + fail + ' 失败');
  console.log('============================================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

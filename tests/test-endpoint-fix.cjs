// 验证：地址自动补全在真实浏览器里生效
const http = require('http');
const crypto = require('crypto');

const CDP = process.env.DSH_CDP || 'http://127.0.0.1:9335';
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
async function ev(sid, expr, ap = true) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: ap, timeout: 60000 }, sid);
  if (r.result?.exceptionDetails) {
    const e = r.result.exceptionDetails;
    throw new Error('EX: ' + (e.exception?.description || e.text || '').slice(0, 400));
  }
  return r.result?.result?.value;
}

let pass = 0, fail = 0;
function check(n, c, e) { if (c) { console.log('  ✅ ' + n); pass++; } else { console.log('  ❌ ' + n + (e ? '  -> ' + e : '')); fail++; } }

(async () => {
  const ver = await getJSON('/json/version');
  await connect(ver.webSocketDebuggerUrl);

  const list = await send('Target.getTargets');
  let ext = (list.result.targetInfos || []).find(t => /src\/background\.js/.test(t.url || ''));
  if (!ext) {
    const anyExt = (list.result.targetInfos || []).find(t => /chrome-extension:\/\//.test(t.url || ''));
    if (anyExt) {
      const id0 = new URL(anyExt.url).host;
      await send('Target.createTarget', { url: `chrome-extension://${id0}/src/options/options.html` });
      await new Promise(r => setTimeout(r, 3000));
    }
    const l2 = await send('Target.getTargets');
    ext = (l2.result.targetInfos || []).find(t => /src\/background\.js/.test(t.url || ''));
  }
  if (!ext) { console.log('扩展未加载'); process.exit(1); }
  const extId = new URL(ext.url).host;
  console.log('扩展 ID:', extId);

  const cr = await send('Target.createTarget', { url: `chrome-extension://${extId}/src/options/options.html` });
  const { result: { sessionId: opt } } = await send('Target.attachToTarget', { targetId: cr.result.targetId, flatten: true });
  await send('Runtime.enable', {}, opt);
  await new Promise(r => setTimeout(r, 2500));

  console.log('\n=== 1. 预览元素存在 ===');
  const has = await ev(opt, `JSON.stringify({
    preview: !!document.getElementById('endpointPreview'),
    msg: !!document.getElementById('endpointPreviewMsg')
  })`);
  check('预览元素已注入', JSON.parse(has).preview === true, has);

  console.log('\n=== 2. 输入 /v1 时显示自动补全 ===');
  const r1 = await ev(opt, `(async()=>{
    const el = document.getElementById('endpoint');
    el.value = 'http://127.0.0.1:8326/v1';
    el.dispatchEvent(new Event('input', {bubbles:true}));
    await new Promise(r=>setTimeout(r,150));
    const box = document.getElementById('endpointPreview');
    return JSON.stringify({
      visible: box.style.display !== 'none',
      text: document.getElementById('endpointPreviewMsg').textContent,
      dot: box.querySelector('.dot-s').className
    });
  })()`);
  const p1 = JSON.parse(r1);
  check('预览可见', p1.visible === true, r1);
  check('提示自动补全', /自动补全/.test(p1.text), p1.text);
  check('补全为完整地址', p1.text.includes('/v1/chat/completions'), p1.text);

  console.log('\n=== 3. 输入完整地址时显示"将请求" ===');
  const r2 = await ev(opt, `(async()=>{
    const el = document.getElementById('endpoint');
    el.value = 'http://127.0.0.1:8326/v1/chat/completions';
    el.dispatchEvent(new Event('input', {bubbles:true}));
    await new Promise(r=>setTimeout(r,150));
    return JSON.stringify({
      text: document.getElementById('endpointPreviewMsg').textContent,
      dot: document.getElementById('endpointPreview').querySelector('.dot-s').className
    });
  })()`);
  const p2 = JSON.parse(r2);
  check('提示"将请求"', /将请求/.test(p2.text), p2.text);
  check('标记为正常状态', p2.dot.includes('ok'), p2.dot);

  console.log('\n=== 4. background 里的 normalizeChatEndpoint 生效 ===');
  // 直接测 SW 里的函数
  const { result: { sessionId: sw } } = await send('Target.attachToTarget', { targetId: ext.targetId, flatten: true });
  await send('Runtime.enable', {}, sw);

  const fnTest = await ev(sw, `(() => {
    const cases = [
      ['http://127.0.0.1:8326/v1', 'http://127.0.0.1:8326/v1/chat/completions'],
      ['https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/chat/completions'],
      ['https://api.deepseek.com/v1/chat/completions', 'https://api.deepseek.com/v1/chat/completions']
    ];
    const out = cases.map(([inp, want]) => {
      const got = normalizeChatEndpoint(inp);
      return { inp, got, ok: got === want };
    });
    return JSON.stringify(out);
  })()`, false);
  const ft = JSON.parse(fnTest);
  for (const t of ft) {
    check('规整 ' + t.inp, t.ok, t.got);
  }

  console.log('\n=== 5. 用错误地址测试连通，报错应指明路径 ===');
  const testBad = await ev(opt, `(async()=>{
    document.getElementById('endpoint').value = 'http://127.0.0.1:9999/v1';
    document.getElementById('apiKey').value = 'test';
    document.getElementById('btnTestApi').click();
    await new Promise(r=>setTimeout(r,5000));
    return document.getElementById('testMsg').textContent.slice(0,150);
  })()`);
  check('连不通时有明确报错', /❌|失败|超时|ECONN/i.test(testBad), testBad);

  console.log('\n=========================');
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  socket.destroy();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

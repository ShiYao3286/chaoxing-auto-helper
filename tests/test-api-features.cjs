// 在真实 Edge 里测试扩展的新功能：模型拉取 / 连通测试 / 视觉接口
const http = require('http');
const crypto = require('crypto');

const CDP = 'http://127.0.0.1:9335';
const MOCK = 'http://127.0.0.1:9911';

let socket = null, idCounter = 0;
const pending = new Map();
let buf = Buffer.alloc(0);

function req(url, method, body, headers) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const data = body ? Buffer.from(body) : null;
    const r = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method: method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(headers || {}), ...(data ? { 'Content-Length': data.length } : {}) }
    }, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => res({ status: resp.statusCode, body: d }));
    });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}

function getJSON(p) {
  return new Promise((res, rej) => {
    http.get(CDP + p, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); })
      .on('error', rej);
  });
}
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const r = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { 'Connection': 'Upgrade', 'Upgrade': 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' }
    });
    r.on('upgrade', (resp, sock) => { socket = sock; sock.on('data', onData); resolve(); });
    r.on('error', reject); r.end();
  });
}
function onData(chunk) {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 2) {
    const opcode = buf[0] & 0x0f;
    let len = buf[1] & 0x7f, off = 2;
    if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    if (buf.length < off + len) return;
    const payload = buf.subarray(off, off + len); buf = buf.subarray(off + len);
    if (opcode === 1) {
      try { const m = JSON.parse(payload.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
    }
  }
}
function send(method, params, sessionId) {
  return new Promise(resolve => {
    const id = ++idCounter; pending.set(id, resolve);
    const payload = Buffer.from(JSON.stringify({ id, method, params: params || {}, sessionId }));
    const len = payload.length; let header;
    if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
    const mask = crypto.randomBytes(4); const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    socket.write(Buffer.concat([header, mask, masked]));
  });
}
async function ev(sid, expr, ap = true) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: ap, timeout: 120000 }, sid);
  if (r.result?.exceptionDetails) {
    const e = r.result.exceptionDetails;
    throw new Error('EX: ' + (e.exception?.description || e.text || '').slice(0, 400));
  }
  return r.result?.result?.value;
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ✅ ' + name); pass++; }
  else { console.log('  ❌ ' + name + (extra !== undefined ? '  -> ' + extra : '')); fail++; }
}

(async () => {
  const ver = await getJSON('/json/version');
  await connect(ver.webSocketDebuggerUrl);

  const list = await send('Target.getTargets');
  let ext = (list.result.targetInfos || []).find(t => /src\/background\.js/.test(t.url || ''));

  // MV3 的 service worker 会休眠，找不到就唤醒它（打开设置页会触发）
  if (!ext) {
    console.log('service worker 休眠中，尝试唤醒…');
    const anyExt = (list.result.targetInfos || []).find(t => /chrome-extension:\/\//.test(t.url || ''));
    if (anyExt) {
      const extId0 = new URL(anyExt.url).host;
      await send('Target.createTarget', { url: `chrome-extension://${extId0}/src/options/options.html` });
      await new Promise(r => setTimeout(r, 3000));
    }
    const list2 = await send('Target.getTargets');
    ext = (list2.result.targetInfos || []).find(t => /src\/background\.js/.test(t.url || ''));
  }

  if (!ext) { console.log('扩展未加载'); process.exit(1); }
  const extId = new URL(ext.url).host;
  console.log('扩展 ID:', extId);

  // 用 service worker 上下文直接调内部函数做单元验证
  const { result: { sessionId: sw } } = await send('Target.attachToTarget', { targetId: ext.targetId, flatten: true });
  await send('Runtime.enable', {}, sw);

  console.log('\n=== 1. deriveModelsUrl 推导 ===');
  const derive = await ev(sw, `(() => {
    const cases = [
      ['https://api.openai.com/v1/chat/completions', 'https://api.openai.com/v1/models'],
      ['https://api.deepseek.com/v1/chat/completions', 'https://api.deepseek.com/v1/models'],
      ['https://x.com/v1/models', 'https://x.com/v1/models'],
      ['https://x.com/api/completions', 'https://x.com/api/models'],
      ['http://127.0.0.1:9911/v1/chat/completions', 'http://127.0.0.1:9911/v1/models']
    ];
    return JSON.stringify(cases.map(([i, want]) => ({ i, got: deriveModelsUrl(i), ok: deriveModelsUrl(i) === want })));
  })()`, false);
  const dr = JSON.parse(derive);
  for (const d of dr) check('推导 ' + d.i, d.ok, d.got);
  // 但这些是内部函数，未必挂在全局

  console.log('\n=== 2. 通过设置页测模型拉取 ===');
  const opts = `chrome-extension://${extId}/src/options/options.html?t=` + Date.now();
  const cr = await send('Target.createTarget', { url: opts });
  const { result: { sessionId: opt } } = await send('Target.attachToTarget', { targetId: cr.result.targetId, flatten: true });
  await send('Runtime.enable', {}, opt);
  await new Promise(r => setTimeout(r, 2500));

  // 填好配置
  const fill = await ev(opt, `(() => {
    document.getElementById('endpoint').value = '${MOCK}/v1/chat/completions';
    document.getElementById('apiKey').value = 'sk-test-1234567890';
    document.getElementById('model').value = 'gpt-4o-mini';
    document.getElementById('visionModel').value = 'qwen-vl-max';
    document.getElementById('temperature').value = '0.2';
    return 'filled';
  })()`, false);
  check('表单填充', fill === 'filled');

  // 点"拉取模型"
  const pull = await ev(opt, `(async() => {
    document.getElementById('btnModels').click();
    await new Promise(r => setTimeout(r, 3000));
    const msg = document.getElementById('modelMsg')?.textContent || '';
    const opts = [...document.querySelectorAll('#modelList option')].map(o => o.value);
    return JSON.stringify({ msg, count: opts.length, first: opts.slice(0, 3), all: opts });
  })()`);
  const pullR = JSON.parse(pull);
  check('模型拉取成功', /✅/.test(pullR.msg), pullR.msg);
  check('拉到多个模型', pullR.count >= 5, pullR.count + ' 个');
  // 模型列表按字母序，用包含判断而非首位判断
  check('模型列表含预期模型', pullR.all.includes('gpt-4o-mini') && pullR.all.includes('qwen-vl-max'),
        JSON.stringify(pullR.all.slice(0, 4)));

  console.log('\n=== 3. 连通性测试 ===');
  const testConn = await ev(opt, `(async () => {
    document.getElementById('btnTestApi').click();
    await new Promise(r => setTimeout(r, 4000));
    return document.getElementById('testMsg')?.textContent || '';
  })()`);
  check('连通测试成功', /✅/.test(testConn), testConn.slice(0, 150));
  check('返回耗时', /\d+ms/.test(testConn), testConn.slice(0, 80));
  check('模型回显', /模型回显/.test(testConn));

  console.log('\n=== 4. 视觉接口测试 ===');
  const testVis = await ev(opt, `(async () => {
    document.getElementById('btnTestVision').click();
    await new Promise(r => setTimeout(r, 5000));
    return document.getElementById('visionTestMsg')?.textContent || '';
  })()`);
  check('视觉接口测试成功', /✅/.test(testVis), testVis.slice(0, 150));

  console.log('\n=== 5. 错误场景：无效 Key ===');
  await req(MOCK + '/__mode', 'POST', '{}');   // 复位
  const badKey = await ev(opt, `(async () => {
    document.getElementById('apiKey').value = 'x';
    document.getElementById('btnTestApi').click();
    await new Promise(r => setTimeout(r, 4000));
    return document.getElementById('testMsg')?.textContent || '';
  })()`);
  check('无效 Key 报错', /❌/.test(badKey) && /401|HTTP/i.test(badKey), badKey.slice(0, 120));

  console.log('\n=== 6. 错误场景：模型拉取 404 ===');
  await req(MOCK + '/__mode', 'POST', JSON.stringify({ models: '404' }));
  const m404 = await ev(opt, `(async () => {
    document.getElementById('apiKey').value = 'sk-test-1234567890';
    document.getElementById('btnModels').click();
    await new Promise(r => setTimeout(r, 3000));
    return document.getElementById('modelMsg')?.textContent || '';
  })()`);
  check('404 正确报错', /失败/.test(m404) && /404/.test(m404), m404.slice(0, 120));

  console.log('\n=== 7. 错误场景：模型列表为空 ===');
  await req(MOCK + '/__mode', 'POST', JSON.stringify({ models: 'empty' }));
  const mEmpty = await ev(opt, `(async () => {
    document.getElementById('btnModels').click();
    await new Promise(r => setTimeout(r, 3000));
    return document.getElementById('modelMsg')?.textContent || '';
  })()`);
  check('空列表正确报错', /失败|为空/.test(mEmpty), mEmpty.slice(0, 120));

  console.log('\n=== 8. 错误场景：返回非 JSON ===');
  await req(MOCK + '/__mode', 'POST', JSON.stringify({ models: 'notjson' }));
  const mNJ = await ev(opt, `(async () => {
    document.getElementById('btnModels').click();
    await new Promise(r => setTimeout(r, 3000));
    return document.getElementById('modelMsg')?.textContent || '';
  })()`);
  check('非 JSON 正确报错', /失败/.test(mNJ) && /JSON/i.test(mNJ), mNJ.slice(0, 120));

  console.log('\n=== 9. 视觉模型不支持图片 ===');
  await req(MOCK + '/__mode', 'POST', JSON.stringify({ models: 'ok', chat: 'ok', vision: 'reject' }));
  const vReject = await ev(opt, `(async () => {
    document.getElementById('btnTestVision').click();
    await new Promise(r => setTimeout(r, 4000));
    return document.getElementById('visionTestMsg')?.textContent || '';
  })()`);
  check('不支持图片时报错', /❌/.test(vReject), vReject.slice(0, 150));

  // 复位
  await req(MOCK + '/__mode', 'POST', JSON.stringify({ models: 'ok', chat: 'ok', vision: 'ok' }));

  console.log('\n=== 10. 配置持久化 ===');
  const persist = await ev(opt, `(async () => {
    document.getElementById('apiKey').value = 'sk-test-1234567890';
    document.getElementById('btnSave').click();
    await new Promise(r => setTimeout(r, 1500));
    const back = await chrome.runtime.sendMessage({type:'cfg:get'});
    return JSON.stringify({
      endpoint: back?.cfg?.quiz?.endpoint,
      modelsUrl: back?.cfg?.quiz?.modelsUrl,
      visionModel: back?.cfg?.vision?.model,
      visionMode: back?.cfg?.vision?.mode,
      visionEnabled: back?.cfg?.vision?.enabled,
      modelListLen: back?.cfg?.quiz?.modelList?.length || 0
    });
  })()`);
  const p = JSON.parse(persist);
  check('endpoint 持久化', p.endpoint === MOCK + '/v1/chat/completions', p.endpoint);
  check('视觉模型持久化', p.visionModel === 'qwen-vl-max', p.visionModel);
  check('视觉模式持久化', p.visionMode === 'auto', p.visionMode);
  check('模型列表被缓存', p.modelListLen >= 5, p.modelListLen);

  console.log('\n=========================');
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  console.log('=========================');

  socket.destroy();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

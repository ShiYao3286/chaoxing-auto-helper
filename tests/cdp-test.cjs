// 在真实 Edge 里测试字体解码器准确率
// 用法：node cdp-test.cjs [扩展目录] [测试页路径]
//   两个参数都可省略，会自动定位
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CDP = process.env.DSH_CDP || 'http://127.0.0.1:9335';

/** 找扩展根目录 */
function findExtRoot() {
  if (process.argv[2] && fs.existsSync(process.argv[2])) {
    const p = path.resolve(process.argv[2]);
    if (fs.existsSync(path.join(p, 'manifest.json'))) return p;
    // 允许直接传 fontdecoder.js
    if (p.endsWith('fontdecoder.js')) return path.resolve(p, '..', '..', '..');
  }
  const cands = [
    path.join(__dirname, '..', 'extension'),
    path.join(__dirname, '..'),
  ];
  for (const c of cands) if (fs.existsSync(path.join(c, 'manifest.json'))) return c;
  throw new Error('找不到扩展目录');
}

const EXT = findExtRoot();
const FD_PATH = path.join(EXT, 'src', 'content', 'fontdecoder.js');
const PAGE_PATH = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(__dirname, 'font-test.html');

let socket = null, idCounter = 0;
const pending = new Map();
let buf = Buffer.alloc(0);

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
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: {
        'Connection': 'Upgrade', 'Upgrade': 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13'
      }
    });
    req.on('upgrade', (r, sock) => { socket = sock; sock.on('data', onData); resolve(); });
    req.on('error', reject);
    req.end();
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
    const payload = buf.subarray(off, off + len);
    buf = buf.subarray(off + len);
    if (opcode === 1) {
      try {
        const m = JSON.parse(payload.toString());
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      } catch { /* ignore */ }
    }
  }
}

function send(method, params, sessionId) {
  return new Promise(resolve => {
    const id = ++idCounter;
    pending.set(id, resolve);
    const payload = Buffer.from(JSON.stringify({ id, method, params: params || {}, sessionId }));
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    socket.write(Buffer.concat([header, mask, masked]));
  });
}

/* 测试用例 */
const CASES = [
  '中国革命的首要问题是',
  '新民主主义革命的对象有哪些',
  '帝国主义封建主义官僚资本主义',
  '民族资本主义的垄断性买办性',
  '《辛丑条约》的签订使中国丧失了独立自主地位'
];

async function evaluate(sessionId, expr, awaitPromise = true) {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise,
    timeout: 120000
  }, sessionId);
  if (r.result?.exceptionDetails) {
    const ex = r.result.exceptionDetails;
    throw new Error('页面异常: ' + (ex.exception?.description || ex.text || JSON.stringify(ex)).slice(0, 400));
  }
  return r.result?.result?.value;
}

(async () => {
  const ver = await getJSON('/json/version');
  await connect(ver.webSocketDebuggerUrl);

  const list = await send('Target.getTargets');
  let page = (list.result.targetInfos || []).find(t => /font-test\.html/.test(t.url || ''));

  if (!page) {
    const fileUrl = 'file:///' + PAGE_PATH.replace(/\\/g, '/');
    const cr = await send('Target.createTarget', { url: fileUrl });
    page = { targetId: cr.result.targetId };
    await new Promise(r => setTimeout(r, 3000));
  }

  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.reload', { ignoreCache: true }, sessionId);
  await new Promise(r => setTimeout(r, 7000));

  // 检查字体
  const fontState = await evaluate(sessionId, `(async () => {
    try { await document.fonts.ready; return JSON.stringify({
      check: document.fonts.check('20px CSReal'),
      size: document.fonts.size
    }); } catch (e) { return 'err:' + e.message; }
  })()`);
  console.log('字体状态:', fontState);

  // 注入解码器
  const fdSrc = fs.readFileSync(FD_PATH, 'utf8');
  await evaluate(sessionId, fdSrc + '\n;1', false);

  // 诊断
  const diag = await evaluate(sessionId, 'JSON.stringify(window.CSFontDecoder.diagnose(document))', false);
  const d = JSON.parse(diag);
  console.log('诊断: 可疑字体=' + d.suspicious.length + ', 系统字体=' + d.systemFont +
              ', 网格=' + d.gridSize + ', 一级字数=' + d.freqCharCount);

  // 解码
  const results = await evaluate(sessionId, `(async () => {
    const probe = document.querySelector('.puzzled');
    const cases = ${JSON.stringify(CASES)};
    const out = [];
    for (const c of cases) {
      const t0 = performance.now();
      let r;
      try { r = await window.CSFontDecoder.decode(c, probe); }
      catch (e) { out.push({ src: c, error: e.message }); continue; }

      const got = r.text;
      let diff = '';
      for (let i = 0; i < c.length; i++) diff += (c[i] === got[i]) ? '·' : '^';

      out.push({
        src: c, got, exact: got === c, changed: r.changed,
        avg: r.avgScore, low: r.lowConfidence, diff,
        ms: Math.round(performance.now() - t0)
      });
    }
    return JSON.stringify(out);
  })()`);

  console.log('\n=== 解码结果 (28x28) ===');
  let pass = 0, total = 0;
  for (const r of JSON.parse(results)) {
    total++;
    if (r.error) { console.log('❌ 异常: ' + r.error); continue; }
    if (r.exact) pass++;
    console.log((r.exact ? '✅' : '❌') + ' ' + r.ms + 'ms avg=' + r.avg + ' low=' + r.low);
    console.log('   原: ' + r.src);
    console.log('   得: ' + r.got);
    if (!r.exact) console.log('   差: ' + r.diff);
  }
  console.log(`\n准确率: ${pass}/${total}`);

  socket.destroy();
  process.exit(pass === total ? 0 : 1);
})().catch(e => { console.error('ERR: ' + e.message); process.exit(1); });

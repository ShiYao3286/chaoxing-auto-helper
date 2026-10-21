// 测试截图解题 + 模型/脚本协同判断
// 用法：node test-vision.cjs
//   （无需传参，会自动定位扩展里的 fontdecoder.js / inject.js）
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CDP = process.env.DSH_CDP || 'http://127.0.0.1:9335';
const MOCK = 'http://127.0.0.1:9911';
const PAGE = (process.env.DSH_WEB || 'http://127.0.0.1:8792') + '/fake-quiz.html';

/** 找扩展根目录 */
function findExtRoot() {
  if (process.argv[2] && fs.existsSync(process.argv[2])) return path.resolve(process.argv[2]);
  const cands = [
    path.join(__dirname, '..', 'extension'),
    path.join(__dirname, '..'),
  ];
  for (const c of cands) if (fs.existsSync(path.join(c, 'manifest.json'))) return c;
  throw new Error('找不到扩展目录');
}

const EXT = findExtRoot();
const { injectContent } = require('./lib/inject-content.cjs');

let socket = null, idCounter = 0;
const pending = new Map();
let buf = Buffer.alloc(0);

function req(url, method, body) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const data = body ? Buffer.from(body) : null;
    const r = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method: method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': data.length } : {}) }
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
    throw new Error('EX: ' + (e.exception?.description || e.text || '').slice(0, 500));
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

  // 确保 mock 是正常状态
  await req(MOCK + '/__mode', 'POST', JSON.stringify({ models: 'ok', chat: 'ok', vision: 'ok' }));

  const list = await send('Target.getTargets');
  const ext = (list.result.targetInfos || []).find(t => /src\/background\.js/.test(t.url || ''));
  const extId = ext ? new URL(ext.url).host : null;

  // 打开测试页
  const cr = await send('Target.createTarget', { url: PAGE + '?t=' + Date.now() });
  const { result: { sessionId: pg } } = await send('Target.attachToTarget', { targetId: cr.result.targetId, flatten: true });
  await send('Runtime.enable', {}, pg);
  await new Promise(r => setTimeout(r, 3000));

  /* ---------- 注入内容脚本（绕过匹配域名限制）---------- */
  console.log('\n=== 准备：注入内容脚本 ===');

  const cfgJson = JSON.stringify({
    auto: { rate: 2, mute: true, autoNext: true, docAutoScroll: true, docStep: 400, loopInterval: 2500, antiPause: true, quizEnabled: true, debug: true },
    quiz: {
      provider: 'openai', endpoint: MOCK + '/v1/chat/completions', apiKey: 'sk-test-1234567890',
      model: 'gpt-4o-mini', temperature: 0.2, autoFill: true, autoSubmit: false,
      extraHeaders: '', bodyTemplate: '', responsePath: '', prompt: ''
    },
    vision: {
      enabled: true, mode: 'auto', useSameApi: true, endpoint: '', apiKey: '',
      model: 'qwen-vl-max', maxShots: 3
    },
    ui: {}
  });

  await ev(pg, `
    window.__VISION_CALLS__ = 0;
    window.__TEXT_CALLS__ = 0;
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = {};
    window.chrome.runtime.sendMessage = async function(msg){
      const t = msg && msg.type;
      if (t === 'cfg:get') return { ok:true, cfg: ${cfgJson} };
      if (t === 'state:get') return { ok:true, running:false };
      if (t === 'frame:status') return { ok:true };
      if (t === 'tab:busy') return { ok:true, busy:false };
      if (t === 'cfg:set') return { ok:true, cfg: ${cfgJson} };
      if (t === 'state:set') return { ok:true };
      if (t === 'quiz:answer') {
        window.__TEXT_CALLS__++;
        return { ok:true, result:{ answers:[
          {num:1,type:'single',answer:['B']},
          {num:2,type:'multi',answer:['A','B','C']},
          {num:3,type:'judge',answer:['错']},
          {num:4,type:'fill',answer:['帝国主义']},
          {num:5,type:'judge',answer:['对']}
        ]}};
      }
      if (t === 'vision:answer') {
        window.__VISION_CALLS__++;
        return { ok:true, result:{
          answers:[
            {num:1,type:'single',answer:['B'],confidence:1.0},
            {num:2,type:'multi',answer:['A','B','C'],confidence:0.95},
            {num:3,type:'judge',answer:['错'],confidence:0.9},
            {num:4,type:'fill',answer:['帝国主义'],confidence:0.9},
            {num:5,type:'judge',answer:['对'],confidence:0.9}
          ],
          uncertain:false, note:'', lowConfidenceNums:[]
        }};
      }
      if (t === 'page:screenshot') {
        // 模拟返回一张 1x1 的图
        return { ok:true, dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', mime:'image/png', cropped:true };
      }
      return { ok:true };
    };
    window.chrome.runtime.onMessage = { addListener: function(fn){ window.__ON_MSG__ = fn; } };
    window.chrome.runtime.openOptionsPage = function(){};
  `, false);

  await injectContent(ev, pg, 1500);

  check('内容脚本注入成功', await ev(pg, 'typeof window.CS', false) === 'object');

  /* ---------- 1. 文本可信度评估 ---------- */
  console.log('\n=== 1. 文本可信度评估 ===');
  const assess = await ev(pg, `(async()=>{
    const r = await window.CS.scrape();
    if(!r.ok) return JSON.stringify({err:r.reason});
    // 调内部评估函数（通过消息通道）
    return JSON.stringify({ questions: r.questions.length });
  })()`);
  check('抓题成功', JSON.parse(assess).questions === 5, assess);

  const assessMsg = await ev(pg, `(async()=>{
    return await new Promise(res=>{
      window.__ON_MSG__({type:'quiz:assess'}, {}, res);
    });
  })()`);
  check('可信度评估接口可用', assessMsg?.ok === true, JSON.stringify(assessMsg));
  check('正常题目被判为可信', assessMsg?.assess?.reliable === true,
        JSON.stringify(assessMsg?.assess?.reasons || []));

  /* ---------- 2. 截图能力 ---------- */
  console.log('\n=== 2. 截图能力 ===');
  const cap = await ev(pg, `(async()=>{
    return await new Promise(res=>{
      window.__ON_MSG__({type:'quiz:capture'}, {}, res);
    });
  })()`);
  check('截图接口返回 dataUrl', cap?.ok === true && /^data:image/.test(cap?.dataUrl || ''),
        cap?.error || (cap?.dataUrl || '').slice(0, 40));

  /* ---------- 3. auto 模式：文本可信 → 不截图 ---------- */
  console.log('\n=== 3. auto 模式：文本可信时不截图 ===');
  await ev(pg, 'window.__VISION_CALLS__ = 0; window.__TEXT_CALLS__ = 0; window.CS.state.quizDoneSig="";', false);
  const autoRun = await ev(pg, `(async()=>{
    window.__VISION_CALLS__ = 0; window.__TEXT_CALLS__ = 0;
    window.CS.state.quizDoneSig = '';
    window.__ON_MSG__({type:'state:changed', running:true}, {}, ()=>{});
    await new Promise(r=>setTimeout(r, 9000));
    window.__ON_MSG__({type:'state:changed', running:false}, {}, ()=>{});
    return JSON.stringify({ vision: window.__VISION_CALLS__, text: window.__TEXT_CALLS__ });
  })()`);
  const ar = JSON.parse(autoRun);
  check('走了文本通道', ar.text >= 1, JSON.stringify(ar));
  check('未调视觉通道', ar.vision === 0, JSON.stringify(ar));

  /* ---------- 4. always 模式：强制截图 ---------- */
  console.log('\n=== 4. always 模式：强制截图 ===');
  const alwaysRun = await ev(pg, `(async()=>{
    window.__VISION_CALLS__ = 0; window.__TEXT_CALLS__ = 0;
    window.CS.cfg.vision.mode = 'always';
    window.CS.state.quizDoneSig = '';
    window.__ON_MSG__({type:'state:changed', running:true}, {}, ()=>{});
    await new Promise(r=>setTimeout(r, 9000));
    window.__ON_MSG__({type:'state:changed', running:false}, {}, ()=>{});
    const res = { vision: window.__VISION_CALLS__, text: window.__TEXT_CALLS__ };
    window.CS.cfg.vision.mode = 'auto';
    return JSON.stringify(res);
  })()`);
  const lr = JSON.parse(alwaysRun);
  check('调用了视觉通道', lr.vision >= 1, JSON.stringify(lr));
  check('跳过文本通道', lr.text === 0, JSON.stringify(lr));

  /* ---------- 5. off 模式：从不截图 ---------- */
  console.log('\n=== 5. off 模式：从不截图 ===');
  const offRun = await ev(pg, `(async()=>{
    window.__VISION_CALLS__ = 0; window.__TEXT_CALLS__ = 0;
    window.CS.cfg.vision.mode = 'off';
    window.CS.state.quizDoneSig = '';
    window.__ON_MSG__({type:'state:changed', running:true}, {}, ()=>{});
    await new Promise(r=>setTimeout(r, 9000));
    window.__ON_MSG__({type:'state:changed', running:false}, {}, ()=>{});
    const res = { vision: window.__VISION_CALLS__, text: window.__TEXT_CALLS__ };
    window.CS.cfg.vision.mode = 'auto';
    return JSON.stringify(res);
  })()`);
  const or = JSON.parse(offRun);
  check('off 模式不截图', or.vision === 0, JSON.stringify(or));
  check('off 模式走文本', or.text >= 1, JSON.stringify(or));

  /* ---------- 6. 文本不可靠 → 自动转截图 ---------- */
  console.log('\n=== 6. 文本不可靠时自动转截图 ===');
  // 把题干预先改成乱码，触发不可靠判定
  const dirtyRun = await ev(pg, `(async()=>{
    // 注入混淆字符
    const p = document.querySelectorAll('.TiMu .Zy_TItle');
    const originals = [...p].map(e => e.innerHTML);
    p[0].innerHTML = '<i class="fl">1</i><div class="font-cxsecret fontLabel">' +
            '<span class="newZy_TItle">【单选题】</span>忞忖忟命応首要忚忝忛？</div>';

    window.__VISION_CALLS__ = 0; window.__TEXT_CALLS__ = 0;
    window.CS.state.quizDoneSig = '';
    window.__ON_MSG__({type:'state:changed', running:true}, {}, ()=>{});
    await new Promise(r=>setTimeout(r, 9000));
    window.__ON_MSG__({type:'state:changed', running:false}, {}, ()=>{});

    const res = { vision: window.__VISION_CALLS__, text: window.__TEXT_CALLS__ };
    // 还原
    p.forEach((e,i) => e.innerHTML = originals[i]);
    return JSON.stringify(res);
  })()`);
  const dr = JSON.parse(dirtyRun);
  check('检测到乱码并转截图', dr.vision >= 1, JSON.stringify(dr));

  /* ---------- 7. 文本 API 失败 → 转截图 ---------- */
  console.log('\n=== 7. 文本 API 失败时转截图 ===');
  const failoverRun = await ev(pg, `(async()=>{
    const orig = window.chrome.runtime.sendMessage;
    window.chrome.runtime.sendMessage = async function(msg){
      if (msg && msg.type === 'quiz:answer') {
        window.__TEXT_CALLS__ = (window.__TEXT_CALLS__||0) + 1;
        return { ok:false, error:'模拟文本 API 故障' };
      }
      return orig(msg);
    };
    window.__VISION_CALLS__ = 0; window.__TEXT_CALLS__ = 0;
    window.CS.state.quizDoneSig = '';
    window.__ON_MSG__({type:'state:changed', running:true}, {}, ()=>{});
    await new Promise(r=>setTimeout(r, 9000));
    window.__ON_MSG__({type:'state:changed', running:false}, {}, ()=>{});
    const res = { vision: window.__VISION_CALLS__, text: window.__TEXT_CALLS__ };
    window.chrome.runtime.sendMessage = orig;
    return JSON.stringify(res);
  })()`);
  const fr = JSON.parse(failoverRun);
  check('文本失败后调用了视觉', fr.vision >= 1, JSON.stringify(fr));

  /* ---------- 8. 视觉模型标注不确定 → 不自动提交 ---------- */
  console.log('\n=== 8. 视觉标注不确定时跳过自动提交 ===');
  const unsureRun = await ev(pg, `(async()=>{
    const orig = window.chrome.runtime.sendMessage;
    window.chrome.runtime.sendMessage = async function(msg){
      if (msg && msg.type === 'vision:answer') {
        return { ok:true, result:{
          answers:[{num:1,answer:['B'],confidence:0.4}],
          uncertain:true, note:'第1题文字模糊', lowConfidenceNums:[1]
        }};
      }
      return orig(msg);
    };
    window.CS.cfg.vision.mode = 'always';
    window.CS.cfg.quiz.autoSubmit = true;   // 开启自动提交以验证会被跳过

    let submitted = false;
    const btn = document.querySelector('a.btnSubmit') || document.getElementById('submitBtn');
    const origClick = btn.click.bind(btn);
    btn.click = () => { submitted = true; origClick(); };

    window.CS.state.quizDoneSig = '';
    window.__ON_MSG__({type:'state:changed', running:true}, {}, ()=>{});
    await new Promise(r=>setTimeout(r, 9000));
    window.__ON_MSG__({type:'state:changed', running:false}, {}, ()=>{});

    const res = { submitted, status: window.CS.state.status };
    window.chrome.runtime.sendMessage = orig;
    window.CS.cfg.quiz.autoSubmit = false;
    window.CS.cfg.vision.mode = 'auto';
    return JSON.stringify(res);
  })()`);
  const ur = JSON.parse(unsureRun);
  check('视觉标注不确定时不提交', ur.submitted === false, JSON.stringify(ur));
  check('状态里提示了复核', /不确定|复核/.test(ur.status || ''), ur.status);

  /* ---------- 9. 填写结果验证 ---------- */
  console.log('\n=== 9. 最终页面状态 ===');
  const finalState = await ev(pg, `JSON.stringify({
    checked: [...document.querySelectorAll('.check_answer')].map(e=>e.textContent.trim()),
    fill: (()=>{ try { return document.getElementById('ueditor_0').contentDocument.body.innerText.trim(); } catch(e){ return 'ERR'; } })()
  })`, false);
  const fs2 = JSON.parse(finalState);
  check('页面有选中答案', fs2.checked.length > 0, JSON.stringify(fs2.checked));
  check('填空题已填写', fs2.fill && fs2.fill.length > 0, fs2.fill);

  console.log('\n=========================');
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  console.log('=========================');

  socket.destroy();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR:', e.message, e.stack); process.exit(1); });

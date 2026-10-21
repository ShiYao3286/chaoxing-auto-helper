/**
 * 视频弹题功能测试
 *
 * 验证：
 *   1. 能检测到弹题
 *   2. 能抓题干和选项
 *   3. 能填答案
 *   4. 能提交并判断结果
 *   5. 答错能重试
 *   6. 答对后能继续播放
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
    return 'EX: ' + ((r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 400));
  }
  return r.result?.result?.value;
}

let pass = 0, fail = 0;
function check(n, c, e) {
  if (c) { console.log('  ✅ ' + n); pass++; }
  else { console.log('  ❌ ' + n + (e ? '  -> ' + e : '')); fail++; }
}

(async () => {
  const ver = await getJSON('/json/version');
  await connect(ver.webSocketDebuggerUrl);

  // 找扩展目录
  const extRoot = path.join(__dirname, '..', 'extension');
  if (!fs.existsSync(path.join(extRoot, 'manifest.json'))) {
    console.log('找不到扩展目录');
    process.exit(1);
  }

  // 创建测试页
  const cr = await send('Target.createTarget', { url: WEB + '/fake-videoquiz.html?t=' + Date.now() });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: cr.result.targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await new Promise(r => setTimeout(r, 3500));

  // 注入 mock chrome.runtime
  const cfgJson = JSON.stringify({
    auto: {
      rate: 2, mute: true, autoNext: false, docAutoScroll: false,
      loopInterval: 1500, antiPause: false, quizEnabled: true, debug: true,
      videoThreshold: 0.9, minDwellSeconds: 0
    },
    quiz: { autoFill: true, autoSubmit: false },
    vision: { enabled: false, mode: 'off' },
    ui: {}
  });

  await ev(sessionId, `
    window.__TEXT_CALLS__ = 0;
    window.__ANSWER__ = 'B';   // 模拟 API 返回 B
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = {};
    window.chrome.runtime.sendMessage = async (m) => {
      const t = m && m.type;
      if (t === 'cfg:get') return { ok: true, cfg: ${cfgJson} };
      if (t === 'state:get') return { ok: true, running: false };
      if (t === 'state:set') return { ok: true };
      if (t === 'frame:status') return { ok: true };
      if (t === 'tab:busy') return { ok: true, busy: false };
      if (t === 'quiz:answer') {
        window.__TEXT_CALLS__++;
        return { ok: true, result: { answers: [{ num: '1', answer: [window.__ANSWER__] }] } };
      }
      if (t === 'page:screenshot') return { ok: true, dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mime: 'image/png' };
      return { ok: true };
    };
    window.chrome.runtime.onMessage = { addListener: fn => window.__ON_MSG__ = fn };
    window.chrome.runtime.openOptionsPage = () => {};
  `, false);

  // 注入内容脚本
  const { injectContent } = require('./lib/inject-content.cjs');
  await injectContent(ev, sessionId, 1500);

  console.log('\n=== 准备 ===');
  const ready = JSON.parse(await ev(sessionId, `JSON.stringify({
    hasCS: typeof window.CS,
    hasVideo: !!document.getElementById('v'),
    hasQuizMask: !!document.getElementById('quizMask')
  })`));
  console.log('   ' + JSON.stringify(ready));
  check('内容脚本注入成功', ready.hasCS === 'object');

  /* ---------- 1. 检测弹题 ---------- */
  console.log('\n=== 1. 检测视频弹题 ===');

  // 先确认没弹题时不误报
  const noQuiz = await ev(sessionId, `window.CS.hasVideoQuiz ? window.CS.hasVideoQuiz() : 'no-api'`, false);
  check('无弹题时不误报', noQuiz === false || noQuiz === 'no-api', String(noQuiz));

  // 弹出题目
  await ev(sessionId, `document.getElementById('btnShow').click();1`, false);
  await new Promise(r => setTimeout(r, 1200));

  const hasQuiz = await ev(sessionId, `window.CS.hasVideoQuiz ? window.CS.hasVideoQuiz() : null`, false);
  check('检测到弹题', hasQuiz === true, String(hasQuiz));

  /* ---------- 2. 抓题 ---------- */
  console.log('\n=== 2. 抓取题干和选项 ===');
  const scraped = JSON.parse(await ev(sessionId, `(() => {
    const r = window.CS.scrapeVideoQuiz ? window.CS.scrapeVideoQuiz() : null;
    if (!r) return JSON.stringify({ ok: false });
    return JSON.stringify({
      ok: true,
      title: r.title,
      type: r.type,
      optCount: r.options.length,
      letters: r.options.map(o => o.letter)
    });
  })()`));
  console.log('   ' + JSON.stringify(scraped));
  check('抓到题干', scraped.ok && scraped.title && scraped.title.includes('中国革命'), scraped.title);
  check('题型是单选', scraped.type === 'single', scraped.type);
  check('抓到 4 个选项', scraped.optCount === 4, scraped.optCount);
  check('选项字母正确', JSON.stringify(scraped.letters) === '["A","B","C","D"]', JSON.stringify(scraped.letters));

  /* ---------- 3. 填答案 ---------- */
  console.log('\n=== 3. 填答案 ===');
  const fillRes = JSON.parse(await ev(sessionId, `(() => {
    const r = window.CS.scrapeVideoQuiz();
    const f = window.CS.fillVideoQuiz(r, ['B']);
    const checked = [...document.querySelectorAll('input[name="ans-videoquiz-opt"]')]
      .filter(i => i.checked).map(i => i.value);
    return JSON.stringify({ fill: f, checked });
  })()`));
  console.log('   ' + JSON.stringify(fillRes));
  check('填答案成功', fillRes.fill.ok === true, JSON.stringify(fillRes.fill));
  check('选中了 B', JSON.stringify(fillRes.checked) === '["B"]', JSON.stringify(fillRes.checked));

  /* ---------- 4. 提交并答对 ---------- */
  console.log('\n=== 4. 提交并答对 ===');
  const subRes = JSON.parse(await ev(sessionId, `(async () => {
    const r = await window.CS.submitVideoQuiz();
    return JSON.stringify(r);
  })()`));
  console.log('   ' + JSON.stringify(subRes));
  check('提交后判定为答对', subRes.status === 'continued' || subRes.status === 'submitted', subRes.status);

  const afterCorrect = JSON.parse(await ev(sessionId, `JSON.stringify({
    maskShown: document.getElementById('quizMask').classList.contains('show'),
    videoPaused: document.getElementById('v').paused,
    continueShown: document.getElementById('videoquiz-continue').classList.contains('show')
  })`));
  console.log('   ' + JSON.stringify(afterCorrect));
  check('弹题已关闭', afterCorrect.maskShown === false);
  check('视频恢复播放', afterCorrect.videoPaused === false);

  /* ---------- 5. 答错重试 ---------- */
  console.log('\n=== 5. 答错重试 ===');
  await ev(sessionId, `(() => {
    window.__ANSWER__ = 'A';   // 故意答错
    window.__submitted = [];
    document.getElementById('btnShow').click();
    return 1;
  })()`, false);
  await new Promise(r => setTimeout(r, 1200));

  const retryRes = JSON.parse(await ev(sessionId, `(async () => {
    const r = window.CS.scrapeVideoQuiz();
    window.CS.fillVideoQuiz(r, ['A']);      // 错误答案
    const s = await window.CS.submitVideoQuiz();
    return JSON.stringify({ submit: s, submitted: window.__submitted });
  })()`));
  console.log('   ' + JSON.stringify(retryRes));
  check('答错后判定为 retry 或 continued', ['retry', 'continued'].includes(retryRes.submit.status), retryRes.submit.status);

  /* ---------- 6. 完整自动流程 ---------- */
  console.log('\n=== 6. 完整自动流程（handleVideoQuiz）===');
  await ev(sessionId, `(() => {
    window.__ANSWER__ = 'B';
    window.__submitted = [];
    window.__TEXT_CALLS__ = 0;
    window.CS.state.videoQuizSig = '';
    document.getElementById('btnShow').click();
    return 1;
  })()`, false);
  await new Promise(r => setTimeout(r, 1000));

  const autoRes = JSON.parse(await ev(sessionId, `(async () => {
    const handled = await window.CS.handleVideoQuiz();
    return JSON.stringify({
      handled,
      textCalls: window.__TEXT_CALLS__,
      submitted: window.__submitted,
      maskShown: document.getElementById('quizMask').classList.contains('show'),
      videoPaused: document.getElementById('v').paused
    });
  })()`));
  console.log('   ' + JSON.stringify(autoRes));
  check('自动处理了弹题', autoRes.handled === true);
  check('调用了答题 API', autoRes.textCalls >= 1, autoRes.textCalls);
  check('自动提交了答案', autoRes.submitted.length >= 1, JSON.stringify(autoRes.submitted));
  check('最终答对并关闭弹题', autoRes.maskShown === false);

  /* ---------- 7. 多选题 ---------- */
  console.log('\n=== 7. 多选题填答 ===');
  // 先确保弹题是打开状态
  await ev(sessionId, `document.getElementById('btnShow').click();1`, false);
  await new Promise(r => setTimeout(r, 1000));

  const multiRes = JSON.parse(await ev(sessionId, `(() => {
    try {
      const topic = document.querySelector('.tkTopic');
      if (!topic) return JSON.stringify({ err: 'no topic' });
      const old = topic.textContent;
      topic.textContent = '【多选题】以下哪些是正确答案？';

      const inputs = [...document.querySelectorAll('input[name="ans-videoquiz-opt"]')];
      inputs.forEach(i => { i.type = 'checkbox'; i.checked = false; });

      const r = window.CS.scrapeVideoQuiz();
      if (!r) {
        topic.textContent = old;
        return JSON.stringify({ err: 'scrape failed' });
      }
      const f = window.CS.fillVideoQuiz(r, ['A', 'C']);
      const checked = [...document.querySelectorAll('input[name="ans-videoquiz-opt"]')]
        .filter(i => i.checked).map(i => i.value).sort();

      // 还原
      topic.textContent = old;
      inputs.forEach(i => { i.type = 'radio'; i.checked = false; });

      return JSON.stringify({ type: r.type, fill: f, checked });
    } catch (e) {
      return JSON.stringify({ err: e.message });
    }
  })()`));
  console.log('   ' + JSON.stringify(multiRes));
  check('识别为多选题', multiRes.type === 'multi', multiRes.type);
  check('多选填了 A 和 C', JSON.stringify(multiRes.checked) === '["A","C"]', JSON.stringify(multiRes.checked));

  socket.destroy();
  console.log('\n=========================');
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

/**
 * v1.3.0 测试：任务队列（搜题酱模型）+ 提交安全网
 *
 * 覆盖：
 *   1. URL 任务类型识别（/ananas/modules/xxx）
 *   2. 任务队列扫描：类型 / 完成状态 / 是否支持
 *   3. 只看未完成的：openCxTasks / isQueueDone
 *   4. 整门课完成判定：#prevNextFocusNext 隐藏
 *   5. 路由指纹与代际（routeEpoch）
 *   6. 填答安全标记：隐藏域核对通过 = safe，否则 unsafe
 *   7. 暂存（save）而不是硬交
 *   8. 提交弹窗：未做完 → 取消；正常 → 提交并读分数
 *
 * 运行前：启动测试浏览器（9335）+ http-server（8793）
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
      try { const m = JSON.parse(pl.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch { /* ignore */ }
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
    return 'EX: ' + ((r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 500));
  }
  return r.result?.result?.value;
}

let pass = 0, fail = 0;
function check(n, c, e) {
  if (c) { console.log('  ✅ ' + n); pass++; }
  else { console.log('  ❌ ' + n + (e !== undefined ? '  -> ' + e : '')); fail++; }
}

(async () => {
  const ver = await getJSON('/json/version');
  await connect(ver.webSocketDebuggerUrl);

  const extRoot = path.join(__dirname, '..', 'extension');

  const cr = await send('Target.createTarget', { url: WEB + '/fake-quiz.html?t=' + Date.now() });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: cr.result.targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await new Promise(r => setTimeout(r, 1500));

  const cfgJson = JSON.stringify({
    auto: {
      rate: 1, mute: true, autoNext: false, docAutoScroll: false,
      loopInterval: 1500, antiPause: false, quizEnabled: true, debug: true,
      videoThreshold: 0.9, minDwellSeconds: 0, skipUnfinished: true
    },
    quiz: { autoFill: true, autoSubmit: true },
    vision: { enabled: false, mode: 'off' },
    ui: {}
  });

  await ev(sessionId, `
    window.chrome = window.chrome || {};
    window.chrome.runtime = window.chrome.runtime || {};
    window.chrome.runtime.sendMessage = async (m) => {
      const t = m && m.type;
      if (t === 'cfg:get') return { ok: true, cfg: ${cfgJson} };
      if (t === 'state:get') return { ok: true, running: false };
      if (t === 'state:set') return { ok: true };
      if (t === 'frame:status') return { ok: true };
      if (t === 'frame:taskdetail') return { ok: true };
      if (t === 'tab:busy') return { ok: true, busy: false, agg: {} };
      return { ok: true };
    };
    window.chrome.runtime.onMessage = { addListener: fn => window.__ON_MSG__ = fn };
    window.chrome.runtime.openOptionsPage = () => {};
    document.body.innerHTML = '<div id="stage"></div>';
  `, false);

  const { injectContent } = require('./lib/inject-content.cjs');
  await injectContent(ev, sessionId, 1200);

  console.log('\n=== 1. URL 任务类型识别 ===');
  const types = JSON.parse(await ev(sessionId, `JSON.stringify([
    window.CS.extractCxRawTaskType('/mooc-ans/ananas/modules/video/index.html?a=1'),
    window.CS.extractCxRawTaskType('https://x.chaoxing.com/ananas/modules/work/index.html'),
    window.CS.extractCxRawTaskType('/ananas/modules/pdf/index.html'),
    window.CS.extractCxRawTaskType('/ananas/modules/zt/topicAttachment/index.html'),
    window.CS.extractCxRawTaskType('/ananas/dialog/ballchart/index.html'),
    window.CS.extractCxRawTaskType('/ananas/modules/live/index.html?x=1#y')
  ])`));
  console.log('   ' + JSON.stringify(types));
  check('video 识别正确', types[0] === 'video', types[0]);
  check('work 识别正确', types[1] === 'work', types[1]);
  check('pdf 识别正确', types[2] === 'pdf', types[2]);
  check('zt 识别正确', types[3] === 'zt', types[3]);
  check('ballchart 识别正确', types[4] === 'ballchart', types[4]);
  check('live 识别正确', types[5] === 'live', types[5]);

  console.log('\n=== 2. 任务队列扫描 ===');
  await ev(sessionId, `
    document.body.innerHTML = \`
      <div id="cards">
        <div class="ans-attach-ct videoContainer ans-job-finished">
          <div class="ans-job-icon ans-job-video ans-job-icon-clear" aria-label="任务点已完成"></div>
          <iframe src="/mooc-ans/ananas/modules/video/index.html?a=1"></iframe>
        </div>
        <div class="ans-attach-ct">
          <div class="ans-job-icon" aria-label="任务点未完成"></div>
          <iframe src="/mooc-ans/ananas/modules/work/index.html?a=2"></iframe>
        </div>
        <div class="ans-attach-ct">
          <div class="ans-job-icon" aria-label="任务点未完成"></div>
          <iframe src="/mooc-ans/ananas/modules/pdf/index.html?a=3"></iframe>
        </div>
        <div class="ans-attach-ct">
          <div class="ans-job-icon" aria-label="任务点未完成"></div>
          <iframe src="/mooc-ans/ananas/modules/live/index.html?a=4"></iframe>
        </div>
      </div>
      <div id="toolbar"><a id="prevNextFocusNext" style="display:block" href="#">下一节</a></div>
    \`;
    document.getElementById('prevNextFocusNext').removeAttribute('href');
  `, false);
  await new Promise(r => setTimeout(r, 600));

  const queue = JSON.parse(await ev(sessionId, `(() => {
    const q = window.CS.scanCxTasks(document);
    window.CS.state.taskQueue = q;
    return JSON.stringify(q.map(t => ({ type: t.type, done: t.done, supported: t.supported, label: t.label })));
  })()`));
  console.log('   ' + JSON.stringify(queue));
  check('扫出 4 个任务', queue.length === 4, queue.length);
  check('视频任务已完成', queue[0].type === 'video' && queue[0].done === true, JSON.stringify(queue[0]));
  check('测验任务未完成', queue[1].type === 'work' && queue[1].done === false, JSON.stringify(queue[1]));
  check('PDF 任务受支持', queue[2].type === 'pdf' && queue[2].supported === true, JSON.stringify(queue[2]));
  check('live 任务不支持', queue[3].type === 'live' && queue[3].supported === false, JSON.stringify(queue[3]));
  check('类型中文名正确', queue[1].label === '测验', queue[1].label);

  console.log('\n=== 3. 只看未完成的 ===');
  const qstat = JSON.parse(await ev(sessionId, `JSON.stringify({
    open: window.CS.openCxTasks().map(t => t.type),
    done: window.CS.isQueueDone(),
    summary: window.CS.queueSummary()
  })`));
  console.log('   ' + JSON.stringify(qstat));
  check('未完成队列 = work + pdf', JSON.stringify(qstat.open) === '["work","pdf"]', JSON.stringify(qstat.open));
  check('队列未完成', qstat.done === false, qstat.done);
  check('摘要含当前任务', qstat.summary.includes('当前：测验'), qstat.summary);

  // 把 work / pdf 标记完成，队列应结束
  const qdone = await ev(sessionId, `(() => {
    window.CS.state.taskQueue.forEach(t => { if (t.supported) t.done = true; });
    return window.CS.isQueueDone();
  })()`, false);
  check('全部完成后 isQueueDone=true', qdone === true, qdone);

  console.log('\n=== 4. 整门课完成判定 ===');
  const nextVisible = await ev(sessionId, `window.CS.isCourseComplete()`, false);
  check('下一节可见时未完成', nextVisible === false, nextVisible);
  await ev(sessionId, `document.getElementById('prevNextFocusNext').style.display='none';1`, false);
  const nextHidden = await ev(sessionId, `window.CS.isCourseComplete()`, false);
  check('下一节隐藏 → 整课完成', nextHidden === true, nextHidden);
  await ev(sessionId, `document.getElementById('prevNextFocusNext').style.display='block';1`, false);

  console.log('\n=== 5. 路由指纹 / 代际 ===');
  const route = JSON.parse(await ev(sessionId, `(() => {
    const before = window.CS.state.routeEpoch;
    const fp = window.CS.routeFingerprint();
    window.CS.state.routeEpoch = before + 1;
    return JSON.stringify({
      hasFields: 'href' in fp && 'mainIframeSrc' in fp && 'mainDocumentHref' in fp,
      bumped: window.CS.state.routeEpoch === before + 1
    });
  })()`));
  console.log('   ' + JSON.stringify(route));
  check('指纹三字段齐全', route.hasFields === true, JSON.stringify(route));
  check('代际可递增', route.bumped === true, route.bumped);

  console.log('\n=== 6. 填答安全标记 ===');
  await ev(sessionId, `
    document.body.innerHTML = \`
      <div class="TiMu" data="1">
        <div class="Zy_TItle">
          <i>1</i>
          <div class="fontLabel"><span class="newZy_TItle">【单选题】</span>中国共产党人的初心和使命是什么？</div>
        </div>
        <ul class="Zy_ulTop">
          <li qid="7001" qtype="0"><span class="num_option" data="A">A</span><a class="after">为中国人民谋幸福</a></li>
          <li qid="7001" qtype="0"><span class="num_option" data="B">B</span><a class="after">为中华民族谋复兴</a></li>
          <li qid="7001" qtype="0"><span class="num_option" data="C">C</span><a class="after">以上都是</a></li>
        </ul>
      </div>
      <input type="hidden" id="answertype7001" value="0">
      <input type="hidden" id="answer7001" value="">
      <a class="btnSave" href="javascript:;" style="display:inline-block;padding:6px 14px">保存</a>
      <a class="btnSubmit" href="javascript:;" style="display:inline-block;padding:6px 14px">提交</a>
      <div id="workpop" style="display:none;padding:20px">
        <div id="popcontent">确认提交？</div>
        <a id="popok" href="javascript:;" style="display:inline-block;padding:6px 14px">提交</a>
        <a id="popno" href="javascript:;" style="display:inline-block;padding:6px 14px">取消</a>
      </div>
      <div class="dividerCon" style="display:none"><div class="achievement">本次成绩 <i>88</i></div></div>
    \`;
    window.__saved = false;
    window.__submitted = false;
    window.__cancelled = false;
    document.querySelector('.btnSave').addEventListener('click', () => { window.__saved = true; });
    document.querySelector('.btnSubmit').addEventListener('click', () => {
      document.getElementById('workpop').style.display = 'block';
    });
    document.getElementById('popno').addEventListener('click', () => {
      window.__cancelled = true;
      document.getElementById('workpop').style.display = 'none';
    });
    document.getElementById('popok').addEventListener('click', () => {
      window.__submitted = true;
      document.getElementById('workpop').style.display = 'none';
    });
    // 模拟学习通：点选项是「切换」——已选中的再点会取消（单选互斥）
    document.querySelectorAll('.Zy_ulTop li').forEach(li => {
      li.addEventListener('click', () => {
        const span = li.querySelector('.num_option');
        const already = span.classList.contains('check_answer');
        document.querySelectorAll('.num_option').forEach(s => s.classList.remove('check_answer'));
        document.getElementById('answer7001').value = '';
        if (!already) {
          span.classList.add('check_answer');
          document.getElementById('answer7001').value = span.getAttribute('data');
        }
      });
    });
  `, false);
  await new Promise(r => setTimeout(r, 400));

  const fillOk = JSON.parse(await ev(sessionId, `(async () => {
    const s = await window.CS.scrape();
    const rep = await window.CS.fill(s.questions, [{ num: '1', answer: ['B'] }]);
    return JSON.stringify({ ok: s.ok, count: s.questions.length, rep: rep[0], hidden: document.getElementById('answer7001').value });
  })()`));
  console.log('   ' + JSON.stringify(fillOk));
  check('抓到 1 道题', fillOk.ok === true && fillOk.count === 1, JSON.stringify(fillOk));
  check('隐藏域写入 B', fillOk.hidden === 'B', fillOk.hidden);
  check('填答标为安全', fillOk.rep.safe === true, JSON.stringify(fillOk.rep));
  check('安全理由为空', !fillOk.rep.safeReason, fillOk.rep.safeReason);

  const fillBad = JSON.parse(await ev(sessionId, `(async () => {
    const s = await window.CS.scrape();
    const rep = await window.CS.fill(s.questions, [{ num: '1', answer: ['D'] }]);
    return JSON.stringify({ rep: rep[0], hidden: document.getElementById('answer7001').value });
  })()`));
  console.log('   ' + JSON.stringify(fillBad));
  check('找不到选项 → 不安全', fillBad.rep.safe === false, JSON.stringify(fillBad.rep));
  check('不安全有原因', !!fillBad.rep.safeReason, fillBad.rep.safeReason);

  console.log('\n=== 7. 暂存（不硬交） ===');
  const tmp = await ev(sessionId, `(async () => {
    window.__saved = false;
    const r = await window.CS.doTmpSave();
    return JSON.stringify({ r, saved: window.__saved });
  })()`);
  const tmpObj = JSON.parse(tmp);
  console.log('   ' + tmp);
  check('暂存调用成功', tmpObj.r.ok === true, tmp);
  check('确实点了保存按钮', tmpObj.saved === true, tmpObj.saved);

  console.log('\n=== 8. 提交弹窗：未做完 → 取消 ===');
  const cancel = JSON.parse(await ev(sessionId, `(async () => {
    window.__submitted = false;
    window.__cancelled = false;
    document.getElementById('popcontent').innerText = '您还有未做完的题目，确定要提交吗？';
    const r = await window.CS.doSubmitQuiz();
    return JSON.stringify({ r, submitted: window.__submitted, cancelled: window.__cancelled });
  })()`));
  console.log('   ' + JSON.stringify(cancel));
  check('未做完被拦截', cancel.r.ok === false && cancel.r.cancelled === true, JSON.stringify(cancel.r));
  check('未真正提交', cancel.submitted === false, cancel.submitted);
  check('点了取消', cancel.cancelled === true, cancel.cancelled);

  console.log('\n=== 9. 提交弹窗：正常提交 + 读分数 ===');
  const submit = JSON.parse(await ev(sessionId, `(async () => {
    window.__submitted = false;
    window.__cancelled = false;
    document.getElementById('popcontent').innerText = '确认提交本次测验？';
    document.querySelector('.dividerCon').style.display = 'block';
    const r = await window.CS.doSubmitQuiz();
    return JSON.stringify({ r, submitted: window.__submitted, score: window.CS.state.score });
  })()`));
  console.log('   ' + JSON.stringify(submit));
  check('提交成功', submit.r.ok === true, JSON.stringify(submit.r));
  check('确认按钮被点击', submit.submitted === true, submit.submitted);
  check('读到分数 88', submit.score === '88', submit.score);

  console.log('\n============================================');
  console.log('  结果：' + pass + ' 通过，' + fail + ' 失败');
  console.log('============================================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

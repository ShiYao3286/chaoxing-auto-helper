// 验证 v1.2.0 核心逻辑：任务点校验 + 视频完成检测
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
  const params = { expression: expr, returnByValue: true, awaitPromise: ap, timeout: 90000 };
  if (ctx != null) params.contextId = ctx;
  const r = await send('Runtime.evaluate', params, sid);
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

const H = (t) => console.log('\n' + '='.repeat(70) + '\n' + t + '\n' + '='.repeat(70));

(async () => {
  const ver = await getJSON('/json/version');
  await connect(ver.webSocketDebuggerUrl);

  const list = await send('Target.getTargets');
  const pg = (list.result.targetInfos || []).find(t => /studentstudy/.test(t.url || '') && t.type === 'page');
  if (!pg) { console.log('找不到页面'); process.exit(1); }

  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: pg.targetId, flatten: true });
  await send('Page.enable', {}, sessionId);

  const ft = await send('Page.getFrameTree', {}, sessionId);
  const flat = [];
  (function walk(n, d) { if (!n) return; flat.push({ d, id: n.frame.id, url: n.frame.url || '' }); (n.childFrames || []).forEach(c => walk(c, d + 1)); })(ft.result.frameTree, 0);

  const top = flat.find(f => f.d === 0);
  const topW = await send('Page.createIsolatedWorld', { frameId: top.id, worldName: 'v' }, sessionId);
  const topCtx = topW.result.executionContextId;

  console.log('页面: ' + pg.url.slice(0, 70));
  flat.forEach(f => { if (f.url !== 'about:blank') console.log('  [d' + f.d + '] ' + f.url.slice(0, 60)); });

  /* ===== 1. 扩展是否注入新代码 ===== */
  H('1. 扩展注入检查');

  const booted = await ev(sessionId, `document.documentElement.getAttribute('data-cs-booted')`, topCtx, false);
  check('扩展已注入', booted === '1', 'booted=' + booted);

  const panel = await ev(sessionId, `!!document.getElementById('cs-status')`, topCtx, false);
  check('悬浮面板存在', panel === true);

  /* ===== 2. _studystate 读取 ===== */
  H('2. #_studystate 解析（新增能力）');

  const ss = await ev(sessionId, `(() => {
    const el = document.getElementById('_studystate');
    if (!el) return JSON.stringify({ exists: false });
    const raw = el.value;
    const mNext = raw.match(/nextChapterId\\s*:\\s*(\\d+)/);
    const mUnfinish = raw.match(/unfinishCount\\s*:\\s*(\\d+)/);
    return JSON.stringify({
      exists: true,
      raw,
      nextChapterId: mNext ? mNext[1] : null,
      unfinishCount: mUnfinish ? +mUnfinish[1] : null
    });
  })()`, topCtx, false);

  console.log('   ' + ss);
  const sso = JSON.parse(ss);
  check('_studystate 存在', sso.exists === true);
  if (sso.exists) {
    check('能解析 nextChapterId', sso.nextChapterId !== null, sso.nextChapterId);
    check('能解析 unfinishCount', sso.unfinishCount !== null, String(sso.unfinishCount));
  }

  /* ===== 3. 目录树状态 ===== */
  H('3. 目录树任务点状态');

  const tree = await ev(sessionId, `(() => {
    const nodes = [...document.querySelectorAll('.posCatalog_select')];
    const done = nodes.filter(n => n.querySelector('.icon_Completed')).length;
    const todo = nodes.filter(n => n.querySelector('.catalog_points_yi')).length;
    const cur = nodes.find(n => /active|current/i.test(n.className || ''));
    return JSON.stringify({
      total: nodes.length, done, todo,
      curId: cur ? cur.id : null,
      curDone: cur ? !!cur.querySelector('.icon_Completed') : null,
      curTodoCnt: cur ? (cur.querySelector('.jobUnfinishCount')?.value || '0') : null
    });
  })()`, topCtx, false);

  console.log('   ' + tree);
  const t = JSON.parse(tree);
  check('目录树节点已采集', t.total > 0, 'total=' + t.total);
  // 注意：125 个节点里有 7 个是一级模块（不算章节，既无完成也无待完成标记）
  check('章节节点 = 已完成 + 未完成', t.done + t.todo > 0 && t.done + t.todo <= t.total, t.done + '+' + t.todo + '/' + t.total + '（差值为一级模块）');
  check('当前节点有标识', t.curId !== null, t.curId);

  /* ===== 4. 视频检测（切到微课学习） ===== */
  H('4. 视频完成检测（核心新功能）');

  // 先切到微课学习标签
  await ev(sessionId, `(() => {
    const t = [...document.querySelectorAll('li[id^="dct"]')].find(x => /微课学习/.test(x.getAttribute('title') || ''));
    if (t) t.click();
    return !!t;
  })()`, topCtx, false);

  await new Promise(r => setTimeout(r, 8000));

  // 重新取 frame
  const ft2 = await send('Page.getFrameTree', {}, sessionId);
  const flat2 = [];
  (function walk(n, d) { if (!n) return; flat2.push({ d, id: n.frame.id, url: n.frame.url || '' }); (n.childFrames || []).forEach(c => walk(c, d + 1)); })(ft2.result.frameTree, 0);

  const vidFrame = flat2.find(f => /ananas\/modules\/video/.test(f.url));
  check('视频帧存在', !!vidFrame, vidFrame ? vidFrame.url.slice(0, 50) : '无');

  if (vidFrame) {
    const vw = await send('Page.createIsolatedWorld', { frameId: vidFrame.id, worldName: 'vv' }, sessionId);
    const vctx = vw.result.executionContextId;

    // 视频初始状态
    const before = await ev(sessionId, `(() => {
      const v = document.querySelector('video');
      if (!v) return JSON.stringify({ exists: false });
      return JSON.stringify({
        exists: true,
        duration: isFinite(v.duration) ? +v.duration.toFixed(1) : null,
        currentTime: +v.currentTime.toFixed(1),
        paused: v.paused,
        readyState: v.readyState,
        percent: isFinite(v.duration) && v.duration > 0 ? +(v.currentTime / v.duration * 100).toFixed(1) : null
      });
    })()`, vctx, false);

    console.log('   播放前: ' + before);
    const b = JSON.parse(before);
    check('视频元素存在', b.exists === true);

    // 播放并等待时长加载
    console.log('   → 调用 play() 等待时长加载…');
    const after = await ev(sessionId, `(async () => {
      const v = document.querySelector('video');
      if (!v) return JSON.stringify({ ok: false });
      try { await v.play(); } catch (e) {}

      // 等时长出现（最多 8 秒，跟代码里的 waitFor 一致）
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (isFinite(v.duration) && v.duration > 0) break;
        await new Promise(r => setTimeout(r, 300));
      }

      const dur = v.duration;
      const cur = v.currentTime;
      return JSON.stringify({
        ok: true,
        duration: isFinite(dur) ? +dur.toFixed(1) : null,
        currentTime: +cur.toFixed(1),
        paused: v.paused,
        readyState: v.readyState,
        percent: isFinite(dur) && dur > 0 ? +(cur / dur * 100).toFixed(1) : null,
        threshold: isFinite(dur) ? +(dur * 0.9).toFixed(1) : null,
        done: isFinite(dur) && dur > 0 ? (cur / dur >= 0.9) : false
      });
    })()`, vctx);

    console.log('   播放后: ' + after);
    const a = JSON.parse(after);

    if (a.ok) {
      check('play 后能读到 duration', a.duration !== null && a.duration > 0, 'duration=' + a.duration);
      check('readyState 升到 4', a.readyState === 4, 'rs=' + a.readyState);
      check('视频在播放', a.paused === false);
      check('能算出完成百分比', a.percent !== null, a.percent + '%');
      check('未达标时 done=false', a.done === false, 'percent=' + a.percent + '%');
    }
  }

  /* ===== 5. 观察扩展实际行为 ===== */
  H('5. 启动扩展，观察是否等待视频完成');

  await ev(sessionId, `document.getElementById('cs-start')?.click();1`, topCtx, false);

  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const st = await ev(sessionId, `document.getElementById('cs-status')?.textContent || '(空)'`, topCtx, false);
    let vinfo = '';
    if (vidFrame) {
      const vw2 = await send('Page.createIsolatedWorld', { frameId: vidFrame.id, worldName: 'p' + i }, sessionId);
      vinfo = await ev(sessionId, `(() => {
        const v = document.querySelector('video');
        if (!v) return '';
        const pct = isFinite(v.duration) && v.duration > 0 ? Math.round(v.currentTime / v.duration * 100) : 0;
        return pct + '% (' + v.currentTime.toFixed(0) + '/' + (isFinite(v.duration) ? v.duration.toFixed(0) : '?') + ')';
      })()`, vw2.result.executionContextId, false);
    }
    console.log(`  [${(i+1)*3}s] ${String(st).slice(0, 45)} | 视频 ${vinfo}`);
  }

  await ev(sessionId, `document.getElementById('cs-stop')?.click();1`, topCtx, false);

  socket.destroy();
  console.log('\n=========================');
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

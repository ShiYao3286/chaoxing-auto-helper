// 验证「倍速被拒就自动放弃」的核心逻辑
//
// 场景（对应用户真实反馈）：
//   - 平台强制锁 1x 时，扩展不应该一直硬改 2x
//   - 应该试 1~2 次发现改不动，就永久放弃，专心保证能播
//   - 状态栏要明确告知用户"已自动放弃加速"
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CDP = process.env.DSH_CDP || 'http://127.0.0.1:9335';
const WEB = process.env.DSH_WEB || 'http://127.0.0.1:8793';

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

  const cr = await send('Target.createTarget', { url: WEB + '/fake-video.html?t=' + Date.now() });
  const { result: { sessionId: pg } } = await send('Target.attachToTarget', { targetId: cr.result.targetId, flatten: true });
  await send('Runtime.enable', {}, pg);
  await new Promise(r => setTimeout(r, 3000));

  check('页面加载', (await ev(pg, '!!document.querySelector("video")', false)) === true);

  // 注入内容脚本（stub 后台）
  const cfgJson = JSON.stringify({
    auto: { rate: 2, mute: true, autoNext: false, docAutoScroll: true, docStep: 400, loopInterval: 1500, antiPause: true, quizEnabled: false, debug: true },
    quiz: { autoFill: true, autoSubmit: false },
    vision: { enabled: false, mode: 'off' },
    ui: {}
  });

  await ev(pg, `
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = {};
    window.chrome.runtime.sendMessage = async (msg) => {
      const t = msg && msg.type;
      if (t === 'cfg:get') return { ok:true, cfg: ${cfgJson} };
      if (t === 'state:get') return { ok:true, running:false };
      if (t === 'frame:status') return { ok:true };
      if (t === 'tab:busy') return { ok:true, busy:false };
      return { ok:true };
    };
    window.chrome.runtime.onMessage = { addListener: fn => window.__ON_MSG__ = fn };
    window.chrome.runtime.openOptionsPage = () => {};
  `, false);

  const { injectContent } = require('./lib/inject-content.cjs');
  await injectContent(ev, pg, 1500);

  check('内容脚本注入', (await ev(pg, 'typeof window.CS', false)) === 'object');

  console.log('\n=== 1. 模拟平台强制锁 1x ===');
  // 让页面强制把 rate 改回 1（模拟学习通行为）
  // 注意：不能有"不可倍速"文案，否则走的是 speedLocked 分支，
  // 测不到"试了被拒 → 放弃"这条路径
  const lockResult = await ev(pg, `(async()=>{
    // 移除任何锁定提示，确保走 trySetRate 路径
    document.getElementById('lockTip')?.remove();

    // 每 100ms 强制改回 1x（模拟播放器反制）
    window.__forceRate1 = setInterval(() => {
      const v = document.querySelector('video');
      if (v && Math.abs(v.playbackRate - 1) > 0.01) v.playbackRate = 1;
    }, 100);

    window.CS.start();
    await new Promise(r=>setTimeout(r, 10000));

    return JSON.stringify({
      giveUp: window.CS.state.speedGiveUp,
      reverts: window.CS.state.speedReverts,
      locked: window.CS.state.speedLocked,
      status: window.CS.state.status,
      actualRate: document.querySelector('video').playbackRate,
      paused: document.querySelector('video').paused
    });
  })()`);
  const lr = JSON.parse(lockResult);
  console.log('    ' + lockResult.replace(/\n/g, '\n    '));

  check('识别出倍速被拒', lr.giveUp === true || lr.reverts >= 2, JSON.stringify(lr));
  check('已放弃加速（不再硬改）', lr.giveUp === true, 'giveUp=' + lr.giveUp);
  check('倍速为 1x', Math.abs(lr.actualRate - 1) < 0.1, 'rate=' + lr.actualRate);
  check('视频仍在播放（没被搞停）', lr.paused === false, 'paused=' + lr.paused);
  check('状态栏告知已放弃加速', /放弃|锁定/.test(lr.status), lr.status);

  console.log('\n=== 2. 放弃后不再反复尝试 ===');
  const stillTrying = await ev(pg, `(async()=>{
    const revertsBefore = window.CS.state.speedReverts;
    await new Promise(r=>setTimeout(r, 4000));
    return JSON.stringify({
      revertsBefore,
      revertsAfter: window.CS.state.speedReverts,
      stillGiveUp: window.CS.state.speedGiveUp,
      paused: document.querySelector('video').paused
    });
  })()`);
  const st = JSON.parse(stillTrying);
  check('放弃后不再累计尝试次数', st.revertsAfter === st.revertsBefore,
        `${st.revertsBefore} -> ${st.revertsAfter}`);
  check('保持放弃状态', st.stillGiveUp === true);
  check('视频持续播放', st.paused === false);

  console.log('\n=== 3. 任务点完成后应重置，允许重新尝试 ===');
  // 注意：本测试用的 4 秒素材开了 loop，每次回绕浏览器会重置
  // playbackRate。真实学习通视频是十几分钟，不会这样。
  // 所以这里只验证"放弃状态被重置、且重新尝试设置倍速"，
  // 不要求倍速长期保持。
  const reset = await ev(pg, `(async()=>{
    // 停止强制改回（模拟平台不再锁倍速）
    clearInterval(window.__forceRate1);

    // 关键：必须把「不可倍速」提示一并移除，
    // 否则 checkLockSignals 会正确判定为仍锁定 —— 那是产品正确行为，不是 bug
    document.getElementById('lockTip')?.remove();
    document.getElementById('doneTip')?.remove();

    const d = document.createElement('div');
    d.id = 'doneTip';
    d.textContent = '任务点已完成';
    document.body.insertBefore(d, document.body.firstChild);

    // 确保视频在播（暂停状态不会去设倍速）
    const v0 = document.querySelector('video');
    if (v0.paused) { try { await v0.play(); } catch(e){} }

    await new Promise(r=>setTimeout(r, 6000));

    const v = document.querySelector('video');
    const out = {
      giveUp: window.CS.state.speedGiveUp,
      locked: window.CS.state.speedLocked,
      reverts: window.CS.state.speedReverts,
      rate: v.playbackRate,
      paused: v.paused,
      status: window.CS.state.status
    };

    // 清理，避免污染下一个用例
    document.getElementById('doneTip')?.remove();
    return JSON.stringify(out);
  })()`);
  const rr = JSON.parse(reset);
  check('完成后重置放弃状态', rr.giveUp === false, JSON.stringify(rr));
  check('放弃状态已重置，重新允许加速', rr.giveUp === false && rr.locked === false, JSON.stringify(rr));

  console.log('\n=== 4. 检测到风控页应停止 ===');
  // 先彻底重置状态，避免上一步残留
  await ev(pg, `(async()=>{
    window.CS.stop();
    await new Promise(r=>setTimeout(r, 800));
    window.CS.state.speedGiveUp = false;
    window.CS.state.speedLocked = false;
    window.CS.state.speedReverts = 0;
    window.CS.state.antispider = false;
    document.getElementById('doneTip')?.remove();
    document.getElementById('lockTip')?.remove();
    return 'reset';
  })()`);
  const anti = await ev(pg, `(async()=>{
    window.CS.stop();
    await new Promise(r=>setTimeout(r, 500));

    // 模拟风控文案
    const d = document.createElement('div');
    d.id = 'anti';
    d.textContent = '【9010】操作异常，请输入图片中的验证码';
    document.body.insertBefore(d, document.body.firstChild);

    window.CS.state.antispider = false;
    window.CS.start();
    await new Promise(r=>setTimeout(r, 3000));

    const out = {
      antispider: window.CS.state.antispider,
      stopped: window.CS.state.stopped,
      status: window.CS.state.status
    };
    d.remove();
    return JSON.stringify(out);
  })()`);
  const ar = JSON.parse(anti);
  check('识别出风控页', ar.antispider === true, JSON.stringify(ar));
  check('自动停止运行', ar.stopped === true, 'stopped=' + ar.stopped);
  check('状态栏提示完成验证', /验证/.test(ar.status), ar.status);

  await ev(pg, 'window.CS.stop();1', false);

  console.log('\n=========================');
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  socket.destroy();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR:', e.message, e.stack); process.exit(1); });

// 验证视频修复：倍速被锁时不硬改、状态如实反映
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CDP = process.env.DSH_CDP || 'http://127.0.0.1:9335';
const PAGE = (process.env.DSH_WEB || 'http://127.0.0.1:8793') + '/fake-video.html';

function findExtRoot() {
  const cands = [
    path.join(__dirname, '..', '学习通自动学习助手', 'extension'),
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

  const cr = await send('Target.createTarget', { url: PAGE + '?t=' + Date.now() });
  const { result: { sessionId: pg } } = await send('Target.attachToTarget', { targetId: cr.result.targetId, flatten: true });
  await send('Runtime.enable', {}, pg);
  await new Promise(r => setTimeout(r, 3000));

  console.log('=== 准备 ===');
  check('页面有 video', (await ev(pg, '!!document.querySelector("video")', false)) === true);

  // 注入内容脚本（带 stub）
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

  console.log('\n=== 1. 页面有"不可倍速"提示时，应识别为锁定 ===');
  const lockDetect = await ev(pg, `(async()=>{
    // 先手动跑一次 runVideo 让状态更新
    window.CS.start();
    await new Promise(r=>setTimeout(r, 3000));
    return JSON.stringify({
      speedLocked: window.CS.state.speedLocked,
      status: window.CS.state.status
    });
  })()`);
  const ld = JSON.parse(lockDetect);
  check('识别出倍速被锁', ld.speedLocked === true, JSON.stringify(ld));

  console.log('\n=== 2. 锁定时不应强行改倍速 ===');
  const noForce = await ev(pg, `(async()=>{
    const v = document.querySelector('video');
    const before = v.playbackRate;
    const enforcedBefore = Number(v.dataset.punished || 0);
    await new Promise(r=>setTimeout(r, 4000));
    return JSON.stringify({
      before,
      after: v.playbackRate,
      paused: v.paused,
      punished: v.dataset.punished === '1',
      currentTime: +v.currentTime.toFixed(2)
    });
  })()`);
  const nf = JSON.parse(noForce);
  check('倍速保持 1x（未硬改）', Math.abs(nf.after - 1) < 0.05, 'rate=' + nf.after);
  check('视频未被播放器反制暂停', nf.punished === false, 'punished=' + nf.punished);
  check('视频真的在播放', nf.paused === false, JSON.stringify(nf));

  console.log('\n=== 3. 状态栏应如实反映 ===');
  const st = await ev(pg, `JSON.stringify({ status: window.CS.state.status, busy: window.CS.state.busy })`);
  const s = JSON.parse(st);
  check('状态显示播放中', /播放中/.test(s.status), s.status);
  check('状态提示了倍速锁定', /锁定倍速|不可倍速/.test(s.status), s.status);

  console.log('\n=== 4. 解锁后应恢复倍速 ===');
  const unlock = await ev(pg, `(async()=>{
    // 模拟任务点完成：锁定提示消失 + 出现完成提示 + 平台不再反制倍速
    document.getElementById('lockTip')?.remove();
    const d = document.createElement('div');
    d.id = 'doneTip';
    d.textContent = '任务点已完成';
    document.body.insertBefore(d, document.body.firstChild);
    window.__enforce = false;

    await new Promise(r=>setTimeout(r, 4500));
    const v = document.querySelector('video');
    const out = {
      speedLocked: window.CS.state.speedLocked,
      giveUp: window.CS.state.speedGiveUp,
      rate: v.playbackRate,
      paused: v.paused,
      enforceCount: window.__enforceCount
    };
    d.remove();
    return JSON.stringify(out);
  })()`);
  const ul = JSON.parse(unlock);
  check('解锁检测生效', ul.speedLocked === false, JSON.stringify(ul));
  check('重新允许加速（未被放弃）', ul.giveUp === false, JSON.stringify(ul));

  console.log('\n=== 5. play() 被拒时状态应如实报错 ===');
  const blockPlay = await ev(pg, `(async()=>{
    window.CS.stop();
    const v = document.querySelector('video');
    v.pause();
    window.__blockAutoPlay = true;   // 模拟自动播放拦截
    window.CS.start();
    await new Promise(r=>setTimeout(r, 3500));
    const out = { status: window.CS.state.status, paused: v.paused };
    window.__blockAutoPlay = false;
    return JSON.stringify(out);
  })()`);
  const bp = JSON.parse(blockPlay);
  check('play 被拒时状态如实提示', /未能播放|手动/.test(bp.status), bp.status);
  check('不再谎报"播放中"', !/▶ 视频播放中/.test(bp.status), bp.status);

  await ev(pg, 'window.CS.stop();1', false);
  console.log('\n=========================');
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  socket.destroy();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR:', e.message, e.stack); process.exit(1); });

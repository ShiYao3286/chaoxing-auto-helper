/**
 * 脚本版设置弹窗测试
 *
 * 脚本没有设置页，弹窗是唯一配置入口，必须验证：
 *   1. 能打开、字段齐全
 *   2. 能回填已保存的配置
 *   3. 保存后配置真的写进 GM 存储
 *   4. 恢复默认有效
 *   5. 取消不写盘
 *   6. 拉取模型 / 测试连通按钮接了内核
 *   7. 油猴菜单已注册
 *   8. 视觉上符合设计令牌（无硬编码色泄漏）
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

  const cr = await send('Target.createTarget', { url: WEB + '/fake-quiz.html?st=' + Date.now() });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: cr.result.targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await new Promise(r => setTimeout(r, 1500));

  console.log('\n=== 0. 装 GM 桩 ===');
  await ev(sessionId, `
    (() => {
      const store = {};
      window.__GM_STORE__ = store;
      window.__MENU__ = [];
      window.GM_getValue = (k, def) => (k in store ? store[k] : def);
      window.GM_setValue = (k, v) => { store[k] = v; };
      window.GM_registerMenuCommand = (label, fn) => { window.__MENU__.push({ label, hasFn: typeof fn === 'function' }); };
      window.GM_xmlhttpRequest = (o) => {
        const path = String(o.url).replace(/^https?:\\/\\/[^/]+/, '');
        let body;
        if (/\\/models/.test(path)) body = JSON.stringify({ data: [{ id: 'gpt-4o-mini' }, { id: 'deepseek-chat' }] });
        else body = JSON.stringify({ model: 'gpt-4o-mini', choices: [{ message: { content: 'OK' } }] });
        setTimeout(() => { o.onload && o.onload({ status: 200, responseText: body }); }, 10);
      };
      return 'ok';
    })()
  `, false);

  console.log('\n=== 1. 注入产物 ===');
  const inj = await ev(sessionId, code + '\n;1', false);
  check('注入无异常', !String(inj).startsWith('EX:'), String(inj).slice(0, 200));
  await new Promise(r => setTimeout(r, 1500));

  check('CSSettings 已加载', (await ev(sessionId, 'typeof window.CSSettings', false)) === 'object');

  console.log('\n=== 2. 油猴菜单已注册 ===');
  const menu = JSON.parse(await ev(sessionId, 'JSON.stringify(window.__MENU__)'));
  console.log('   ' + JSON.stringify(menu));
  check('注册了 3 条菜单', menu.length === 3, menu.length);
  check('有「设置」菜单', menu.some(m => /设置/.test(m.label)), JSON.stringify(menu.map(m => m.label)));
  check('菜单都绑了回调', menu.every(m => m.hasFn));

  console.log('\n=== 3. 打开弹窗，字段齐全 ===');
  const opened = JSON.parse(await ev(sessionId, `(() => {
    window.CSSettings.open({
      getCfg: () => window.CSHost && window.__LAST_CFG__ || {
        quiz: { endpoint: 'https://api.test/v1', apiKey: 'sk-old', model: 'old-model', temperature: 0.3, autoSubmit: false },
        vision: { enabled: true, mode: 'auto', model: 'gpt-4o' },
        auto: { rate: 1.5, mute: true, autoNext: false, docAutoScroll: true, antiPause: true, debug: true, quizEnabled: true, minDwellSeconds: 3 }
      },
      setCfg: async (c) => { window.__SAVED__ = c; },
      onSaved: () => {}
    });
    const m = document.getElementById('cs-settings-mask');
    const need = ['st-endpoint','st-apiKey','st-model','st-temperature','st-visionEnabled',
                  'st-visionMode','st-visionModel','st-quizEnabled','st-autoSubmit','st-minDwell',
                  'st-rate','st-mute','st-autoNext','st-docAutoScroll','st-antiPause','st-debug',
                  'st-btnModels','st-btnTest','st-btnSave','st-btnCancel','st-btnReset','st-close'];
    const miss = need.filter(id => !document.getElementById(id));
    return JSON.stringify({
      mask: !!m,
      panel: !!document.getElementById('cs-settings'),
      missing: miss,
      fields: need.length
    });
  })()`));
  console.log('   ' + JSON.stringify(opened));
  check('遮罩层已挂载', opened.mask === true);
  check('弹窗已挂载', opened.panel === true);
  check('全部 ' + opened.fields + ' 个字段都在', opened.missing.length === 0, opened.missing.join(','));

  console.log('\n=== 4. 回填已保存配置 ===');
  const filled = JSON.parse(await ev(sessionId, `JSON.stringify({
    endpoint: document.getElementById('st-endpoint').value,
    apiKey: document.getElementById('st-apiKey').value,
    model: document.getElementById('st-model').value,
    rate: document.getElementById('st-rate').value,
    minDwell: document.getElementById('st-minDwell').value,
    autoNext: document.getElementById('st-autoNext').checked,
    visionMode: document.getElementById('st-visionMode').value
  })`));
  console.log('   ' + JSON.stringify(filled));
  check('回填接口地址', filled.endpoint === 'https://api.test/v1', filled.endpoint);
  check('回填 Key', filled.apiKey === 'sk-old', filled.apiKey);
  check('回填倍速 1.5', filled.rate === '1.5', filled.rate);
  check('回填最低停留 3', filled.minDwell === '3', filled.minDwell);
  check('回填自动下一节 false', filled.autoNext === false, filled.autoNext);
  check('回填视觉模式', filled.visionMode === 'auto', filled.visionMode);

  console.log('\n=== 5. 测试连通按钮走内核 ===');
  const testConn = JSON.parse(await ev(sessionId, `(async () => {
    document.getElementById('st-endpoint').value = 'http://x/v1/chat/completions';
    document.getElementById('st-apiKey').value = 'sk-test';
    document.getElementById('st-model').value = 'gpt-4o-mini';
    document.getElementById('st-btnTest').click();
    await new Promise(r => setTimeout(r, 900));
    const msg = document.getElementById('st-apiMsg');
    return JSON.stringify({ text: msg.textContent, cls: msg.className });
  })()`));
  console.log('   ' + JSON.stringify(testConn));
  check('连通测试显示成功', /连通正常/.test(testConn.text || ''), testConn.text);
  check('消息样式为 ok', /ok/.test(testConn.cls), testConn.cls);

  console.log('\n=== 6. 拉取模型按钮 ===');
  const pull = JSON.parse(await ev(sessionId, `(async () => {
    document.getElementById('st-model').value = '';
    document.getElementById('st-btnModels').click();
    await new Promise(r => setTimeout(r, 900));
    const msg = document.getElementById('st-apiMsg');
    return JSON.stringify({
      text: msg.textContent,
      pickedModel: document.getElementById('st-model').value
    });
  })()`));
  console.log('   ' + JSON.stringify(pull));
  check('拉取成功提示', /拉到\s*\d+\s*个模型/.test(pull.text || ''), pull.text);
  check('自动挑了模型', !!pull.pickedModel, pull.pickedModel);

  console.log('\n=== 7. 保存写盘 ===');
  const saved = JSON.parse(await ev(sessionId, `(async () => {
    document.getElementById('st-endpoint').value = 'http://127.0.0.1:9911/v1/chat/completions';
    document.getElementById('st-apiKey').value = 'sk-saved';
    document.getElementById('st-model').value = 'gpt-4o-mini';
    document.getElementById('st-rate').value = '2.5';
    document.getElementById('st-autoSubmit').checked = true;
    document.getElementById('st-minDwell').value = '8';
    document.getElementById('st-btnSave').click();
    await new Promise(r => setTimeout(r, 700));
    return JSON.stringify({
      saved: window.__SAVED__ ? {
        endpoint: window.__SAVED__.quiz.endpoint,
        apiKey: window.__SAVED__.quiz.apiKey,
        rate: window.__SAVED__.auto.rate,
        autoSubmit: window.__SAVED__.quiz.autoSubmit,
        minDwell: window.__SAVED__.auto.minDwellSeconds
      } : null,
      closed: !document.getElementById('cs-settings-mask')
    });
  })()`));
  console.log('   ' + JSON.stringify(saved));
  check('setCfg 被调用', !!saved.saved, JSON.stringify(saved));
  check('接口地址已保存', saved.saved?.endpoint === 'http://127.0.0.1:9911/v1/chat/completions', saved.saved?.endpoint);
  check('倍速已保存 2.5', saved.saved?.rate === 2.5, saved.saved?.rate);
  check('自动提交已保存 true', saved.saved?.autoSubmit === true, saved.saved?.autoSubmit);
  check('最低停留已保存 8', saved.saved?.minDwell === 8, saved.saved?.minDwell);
  check('保存后自动关闭', saved.closed === true, saved.closed);

  console.log('\n=== 8. 恢复默认 ===');
  const reset = JSON.parse(await ev(sessionId, `(() => {
    window.CSSettings.open({ getCfg: () => ({ quiz: { endpoint: 'http://changed/v1', rate: 9 }, auto: { rate: 9 } }), setCfg: async () => {} });
    document.getElementById('st-rate').value = '9';
    document.getElementById('st-btnReset').click();
    const v = document.getElementById('st-rate').value;
    window.CSSettings.close();
    return JSON.stringify({ rateAfterReset: v });
  })()`));
  console.log('   ' + JSON.stringify(reset));
  check('恢复默认后倍速回到 2', reset.rateAfterReset === '2', reset.rateAfterReset);

  console.log('\n=== 9. 取消不写盘 ===');
  const cancel = JSON.parse(await ev(sessionId, `(() => {
    window.__SAVED__ = null;
    window.CSSettings.open({ getCfg: () => ({}), setCfg: async (c) => { window.__SAVED__ = c; } });
    document.getElementById('st-rate').value = '3.5';
    document.getElementById('st-btnCancel').click();
    return JSON.stringify({ saved: window.__SAVED__, closed: !document.getElementById('cs-settings-mask') });
  })()`));
  console.log('   ' + JSON.stringify(cancel));
  check('取消后没有保存', cancel.saved === null, JSON.stringify(cancel.saved));
  check('取消后弹窗关闭', cancel.closed === true);

  console.log('\n=== 10. Esc 关闭 ===');
  const esc = JSON.parse(await ev(sessionId, `(() => {
    window.CSSettings.open({ getCfg: () => ({}), setCfg: async () => {} });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    return JSON.stringify({ closed: !document.getElementById('cs-settings-mask') });
  })()`));
  check('Esc 能关闭弹窗', esc.closed === true, esc.closed);

  console.log('\n=== 11. 样式走令牌 ===');
  // 注意：运行时 CSS 里的十六进制色是 ${C.white} 这类令牌「展开后」的结果，
  // 真正的判据是**源码**里不许硬编码 —— 这里检查源码文件。
  const srcCheck = JSON.parse(await ev(sessionId, `(() => {
    const css = document.getElementById('cs-settings-style')?.textContent || '';
    return JSON.stringify({
      hasVars: css.includes('--cs-primary:#2d6cdf'),
      usesVar: css.includes('var(--cs-')
    });
  })()`));
  console.log('   ' + JSON.stringify(srcCheck));
  check('令牌块存在', srcCheck.hasVars === true);
  check('正文使用 var()', srcCheck.usesVar === true);

  // 源码级检查（Node 侧）
  const settingsSrc = fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', 'ui', 'settings.js'), 'utf8');
  const hardHex = settingsSrc.split('\n')
    .filter(l => !/^\s*(\/\/|\*)/.test(l))          // 去掉注释
    .filter(l => /#[0-9a-fA-F]{6}\b/.test(l));
  check('settings.js 源码无硬编码颜色', hardHex.length === 0,
        hardHex.length ? hardHex[0].trim().slice(0, 80) : '');

  const panelSrc = fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', 'ui', 'panel.js'), 'utf8');
  const panelHex = panelSrc.split('\n')
    .filter(l => !/^\s*(\/\/|\*)/.test(l))
    .filter(l => /#[0-9a-fA-F]{6}\b/.test(l));
  check('panel.js 源码无硬编码颜色', panelHex.length === 0,
        panelHex.length ? panelHex[0].trim().slice(0, 80) : '');

  console.log('\n============================================');
  console.log('  结果：' + pass + ' 通过，' + fail + ' 失败');
  console.log('============================================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

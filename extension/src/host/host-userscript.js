/**
 * 宿主适配层 · 油猴脚本版
 *
 * 与 host-extension.js 严格同一套接口，内核无需感知差异：
 *   Host.send(type, payload)        → Promise<resp|null>
 *   Host.sendNoWait(type, payload)  → void
 *   Host.on(fn)                     → fn(msg, reply)
 *   Host.getCfg() / Host.setCfg()
 *   Host.getRunning() / Host.setRunning()
 *   Host.openOptions()
 *
 * 和扩展版的三个根本差异：
 *   ① 没有后台 Service Worker → 配置存 GM_setValue
 *   ② 没有 chrome.runtime → 跨帧协调靠 BroadcastChannel
 *   ③ 没有 captureVisibleTab → 截图走内核已有的「文字重绘」降级
 *
 * 依赖的油猴 API（@grant 见构建产物头部）：
 *   GM_getValue / GM_setValue / GM_xmlhttpRequest
 *   GM_registerMenuCommand / GM_addStyle（可选）
 */
(function (root) {
  'use strict';

  if (root.CSHost) return;

  const KEY_CFG = 'cs.cfg';
  const KEY_RUNNING = 'cs.running';

  /* ============================================================
   * 0. 油猴 API 兜底
   *
   * 在普通页面（没装油猴 / 我们的测试环境）里，GM_* 不存在。
   * 这时退化成 localStorage，保证同一份代码能跑起来。
   * ============================================================ */

  const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

  function kvGet(k, def) {
    try {
      if (hasGM) return GM_getValue(k, def);
      const v = localStorage.getItem(k);
      return v == null ? def : JSON.parse(v);
    } catch { return def; }
  }

  function kvSet(k, v) {
    try {
      if (hasGM) { GM_setValue(k, v); return; }
      localStorage.setItem(k, JSON.stringify(v));
    } catch { /* ignore */ }
  }

  /**
   * 跨域请求：脚本版唯一的网络出口
   *
   * 为什么要用 GM_xmlhttpRequest 而不是 fetch：
   *   页面里的 fetch 受同源策略限制，调 api.openai.com 会被 CORS 挡。
   *   GM_xmlhttpRequest 走扩展层网络栈，不受页面 CORS 约束。
   */
  function httpRequest(opts) {
    const { method, url, headers, body, timeout } = opts;

    // 没有油猴 API：退化到 fetch（同源可用，跨域大概率失败）
    if (typeof GM_xmlhttpRequest !== 'function') {
      return fetch(url, { method, headers, body })
        .then(async r => ({ ok: r.ok, status: r.status, text: await r.text() }));
    }

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: method || 'GET',
        url,
        headers: headers || {},
        data: body,
        timeout: timeout || 30000,
        onload: (r) => resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, text: r.responseText }),
        onerror: () => reject(new Error('网络请求失败（检查油猴是否已授权该域名）')),
        ontimeout: () => reject(new Error('请求超时（' + Math.round((timeout || 30000) / 1000) + ' 秒）'))
      });
    });
  }

  /* ============================================================
   * 1. 跨帧总线
   *
   * 扩展靠 background 的共享内存做"有没有别的帧在忙"。
   * 脚本没有后台，用 BroadcastChannel 在**同一标签页的同源帧**之间广播。
   *
   * 关键难点：广播消息需要区分帧。
   *   - 扩展有 frameId，脚本没有
   *   - 用「顶层到当前的 iframe 序号链」生成 frameKey
   *   - 跨域读不到 window.top 时退化成单帧模式
   * ============================================================ */

  const IS_TOP = (() => {
    try { return window.top === window.self; } catch { return false; }
  })();

  /** 生成稳定的 tabId：顶层生成一次写进 <html>，子帧读它（同源可读，DOM 跨世界共享） */
  function getTabId() {
    if (!IS_TOP) {
      try {
        const id = window.top.document.documentElement.getAttribute('data-cs-tabid');
        if (id) return id;
      } catch { /* 跨域，走单帧模式 */ }
      return null;
    }
    // 顶层：没有就生成
    try {
      const el = document.documentElement;
      let id = el.getAttribute('data-cs-tabid');
      if (!id) {
        id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        el.setAttribute('data-cs-tabid', id);
      }
      return id;
    } catch { return null; }
  }

  /** 当前帧的 key：顶层是 'top'，子帧是 iframe 序号链 */
  function getFrameKey() {
    if (IS_TOP) return 'top';
    try {
      const parts = [];
      let win = window;
      let guard = 0;
      while (win !== win.parent && guard++ < 8) {
        const parent = win.parent;
        const frames = [...parent.document.querySelectorAll('iframe')];
        const idx = frames.findIndex(f => {
          try { return f.contentWindow === win; } catch { return false; }
        });
        parts.unshift(idx >= 0 ? String(idx) : 'x');
        win = parent;
      }
      if (parts.length) return parts.join('.');
    } catch { /* 跨域 */ }
    // 拿不到位置：用随机 key（同帧内多次调用要保持一致，所以缓存）
    if (!root.__CS_FRAME_KEY__) {
      root.__CS_FRAME_KEY__ = 'r' + Math.random().toString(36).slice(2, 8);
    }
    return root.__CS_FRAME_KEY__;
  }

  const TAB_ID = getTabId();
  const FRAME_KEY = getFrameKey();
  const BUS_NAME = TAB_ID ? 'cs-bus-' + TAB_ID : null;

  let _bus = null;
  /** 其他帧的最新状态：frameKey -> {status, busy, detail, detailTs, ts} */
  const _peers = new Map();
  /** 本地消息处理函数（对应 chrome.runtime.onMessage） */
  const _handlers = [];

  function ensureBus() {
    if (_bus !== null || !BUS_NAME) return _bus;
    try {
      _bus = new BroadcastChannel(BUS_NAME);
      _bus.onmessage = (ev) => {
        const m = ev.data;
        if (!m || !m.__cs) return;
        if (m.from === FRAME_KEY) return;   // 自己的消息，忽略

        if (m.kind === 'peer') {
          _peers.set(m.from, {
            status: m.status || '',
            busy: !!m.busy,
            detail: m.detail || null,
            detailTs: m.detailTs || 0,
            ts: Date.now()
          });
        } else if (m.kind === 'cmd') {
          // 顶层发的命令（开始/停止）：所有帧都要响应
          for (const fn of _handlers) {
            try { fn({ type: m.type, ...(m.payload || {}) }, () => {}); } catch { /* ignore */ }
          }
        }
      };
    } catch {
      _bus = null;
    }
    return _bus;
  }

  /** 清理超时的 peer（对方可能已离开或停止上报） */
  function prunePeers() {
    const now = Date.now();
    for (const [k, v] of _peers) {
      if (now - v.ts > 15000) _peers.delete(k);
    }
  }

  function hasBus() { return !!ensureBus(); }

  /** 广播自己的状态 */
  function broadcastPeer(payload) {
    const bus = ensureBus();
    if (!bus) return;
    try {
      bus.postMessage({
        __cs: 1,
        kind: 'peer',
        from: FRAME_KEY,
        status: payload.status || '',
        busy: !!payload.busy,
        detail: payload.detail || null,
        detailTs: Date.now()
      });
    } catch { /* ignore */ }
  }

  /** 顶层广播命令给所有帧 */
  function broadcastCmd(type, payload) {
    const bus = ensureBus();
    if (!bus) return;
    try {
      bus.postMessage({ __cs: 1, kind: 'cmd', from: FRAME_KEY, type, payload });
    } catch { /* ignore */ }
  }

  /* ============================================================
   * 2. 消息分发（等价于扩展的 background 路由）
   * ============================================================ */

  /** 合并配置 */
  function readCfg() {
    const saved = kvGet(KEY_CFG, null);
    const CS = root.CSCore;
    if (CS && CS.config && CS.config.mergeDefaults) return CS.config.mergeDefaults(saved);
    return saved || {};
  }

  async function handleMessage(msg) {
    const CS = root.CSCore;
    const t = msg && msg.type;

    switch (t) {
      case 'cfg:get':
        return { ok: true, cfg: readCfg() };

      case 'cfg:set': {
        const cur = readCfg();
        const next = CS.config.mergeDefaults({ ...cur, ...(msg.patch || {}) });
        kvSet(KEY_CFG, next);
        return { ok: true, cfg: next };
      }

      case 'state:get':
        return { ok: true, running: !!kvGet(KEY_RUNNING, false) };

      case 'state:set': {
        const running = !!msg.running;
        kvSet(KEY_RUNNING, running);
        // 广播给本页所有帧（脚本没有跨标签页广播能力）
        broadcastCmd('state:changed', { running });
        return { ok: true, running };
      }

      case 'frame:status': {
        broadcastPeer({ status: msg.status, busy: msg.busy });
        return { ok: true };
      }

      case 'frame:taskdetail': {
        broadcastPeer({ detail: msg.detail });
        return { ok: true };
      }

      case 'tab:busy': {
        prunePeers();
        const now = Date.now();
        let busy = false;
        for (const v of _peers.values()) {
          if (v.busy && now - v.ts < 8000) { busy = true; break; }
        }
        // 找出最新的明细（子帧上报的任务点）
        let detail = null;
        let best = 0;
        for (const v of _peers.values()) {
          if (v.detail && v.detailTs > best && now - v.detailTs < 20000) {
            detail = v.detail; best = v.detailTs;
          }
        }
        return { ok: true, busy, agg: { status: '', busy, count: _peers.size + 1, detail } };
      }

      case 'tab:agg': {
        prunePeers();
        return { ok: true, agg: { status: '', busy: false, count: _peers.size + 1, detail: null } };
      }

      case 'font:fetch': {
        // 字体反爬：脚本拿的是 base64
        try {
          const r = await httpRequest({ method: 'GET', url: msg.url, timeout: 30000 });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const b64 = btoa(unescape(encodeURIComponent(r.text)));
          return { ok: true, b64 };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }

      case 'quiz:answer': {
        const cfg = readCfg();
        const result = await CS.api.callAnswerApi(cfg, msg.questions);
        return { ok: true, result };
      }

      case 'quiz:test': {
        const cfg = readCfg();
        const testQ = [{ num: 1, type: 'single', text: '测试题目：1+1=？', options: [{ letter: 'A', text: '2' }, { letter: 'B', text: '3' }] }];
        const result = await CS.api.callAnswerApi(cfg, testQ);
        return { ok: true, result };
      }

      case 'models:list': {
        const r = await CS.api.fetchModels(readCfg());
        return { ok: true, ...r };
      }

      case 'api:test': {
        const r = await CS.api.testConnection(readCfg());
        return { ok: true, ...r };
      }

      case 'api:testWith': {
        const cur = readCfg();
        const merged = CS.config.mergeDefaults({ ...cur, quiz: { ...cur.quiz, ...(msg.quiz || {}) } });
        const withVision = CS.config.mergeDefaults({ ...merged, vision: { ...merged.vision, ...(msg.vision || {}) } });
        if (msg.what === 'models' || msg.kind === 'models') {
          return { ok: true, ...(await CS.api.fetchModels(merged)) };
        }
        if (msg.what === 'vision' || msg.kind === 'vision') {
          const pix = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
          return { ok: true, ...(await CS.api.callVisionApi(withVision, [pix], 'image/png')) };
        }
        return { ok: true, ...(await CS.api.testConnection(merged)) };
      }

      case 'vision:answer': {
        const r = await CS.api.callVisionApi(readCfg(), msg.images || [], msg.mime || 'image/png');
        return { ok: true, result: r };
      }

      case 'page:screenshot': {
        // 脚本没有 captureVisibleTab。返回失败让调用方走「文字重绘」降级：
        // inject.js 里 captureQuizImage() 已经处理了这个分支。
        return { ok: false, error: '脚本版不支持真实截图，已降级为文字重绘' };
      }

      case 'open:options': {
        openSettings();
        return { ok: true };
      }

      default:
        return { ok: false, error: 'unknown message type: ' + t };
    }
  }

  /* ============================================================
   * 3. 对外接口
   * ============================================================ */

  function send(type, payload) {
    return handleMessage({ type, ...(payload || {}) }).catch((e) => {
      // 不要静默吞掉：返回一个带 error 的结构，调用方才能知道发生了什么
      // （扩展版对应 chrome.runtime.sendMessage 的 reject 语义）
      return { ok: false, error: (e && e.message) || String(e) };
    });
  }

  function sendNoWait(type, payload) {
    // 本地分发是同步/异步都可，这里吞掉错误即可（心跳类消息不需要结果）
    handleMessage({ type, ...(payload || {}) }).catch(() => {});
  }

  function on(fn) {
    _handlers.push(fn);
    return () => {
      const i = _handlers.indexOf(fn);
      if (i >= 0) _handlers.splice(i, 1);
    };
  }

  /**
   * 打开设置
   *
   * 脚本没有设置页，用 CSPanel 那套视觉造一个弹窗（ui/settings.js）。
   */
  function openSettings() {
    try {
      if (root.CSSettings && typeof root.CSSettings.open === 'function') {
        root.CSSettings.open({
          getCfg: readCfg,
          setCfg: async (patchOrFull) => {
            // 设置弹窗会传「完整配置对象」，这里直接覆盖保存
            const CS = root.CSCore;
            const next = CS.config.mergeDefaults(patchOrFull);
            kvSet(KEY_CFG, next);
            return next;
          }
        });
        return;
      }
    } catch (e) {
      console.error('[学习通助手] 打开设置失败', e);
    }
    alert('设置面板未加载');
  }

  /**
   * 油猴菜单：脚本没有工具栏图标，唯一入口就是这里
   *
   * 用户在 Tampermonkey 的面板里点脚本名 → 出现「⚙ 设置」菜单。
   */
  function registerMenu() {
    try {
      if (typeof GM_registerMenuCommand !== 'function') return;
      GM_registerMenuCommand('⚙ 设置', openSettings);
      GM_registerMenuCommand('▶ 开始刷课', () => {
        sendNoWait('state:set', { running: true });
      });
      GM_registerMenuCommand('■ 停止', () => {
        sendNoWait('state:set', { running: false });
      });
    } catch { /* 没有 GM 菜单命令就算了 */ }
  }

  /* ============================================================
   * 4. 心跳
   *
   * 扩展有 background 做状态汇总；脚本靠每个帧自己定时广播，
   * 让顶层能持续知道"还有没有人在忙"。
   * ============================================================ */

  let _beatTimer = null;
  let _lastBeat = { status: '', busy: false };

  function beat(status, busy) {
    _lastBeat = { status: status || '', busy: !!busy };
    if (_beatTimer) return;
    _beatTimer = setInterval(() => {
      broadcastPeer(_lastBeat);
    }, 2000);
  }

  const CSHost = {
    kind: 'userscript',
    send,
    sendNoWait,
    on,

    getCfg: () => handleMessage({ type: 'cfg:get' }).then(r => r?.cfg || null),
    setCfg: (patch) => send('cfg:set', { patch }),
    getRunning: () => handleMessage({ type: 'state:get' }).then(r => !!r?.running),
    setRunning: (v) => { sendNoWait('state:set', { running: !!v }); },
    openOptions: openSettings,

    /** 调试用 */
    _debug: {
      tabId: TAB_ID,
      frameKey: FRAME_KEY,
      isTop: IS_TOP,
      hasBus,
      peerCount: () => _peers.size,
      beat
    },

    caps: {
      screenshot: false,      // 没有 captureVisibleTab
      backgroundFetch: true,  // GM_xmlhttpRequest 可跨域
      storage: true           // GM_setValue
    }
  };

  root.CSHost = CSHost;

  /**
   * 注入传输层
   *
   * 漏了这一步的话，core/api.js 里的 request() 会直接抛「传输层未注入」，
   * 所有答题/视觉/模型请求全部失效。扩展版在 background.js 里注入，
   * 脚本版就在这里注入 —— 这是两个宿主唯一必须各自做的初始化。
   */
  try {
    if (root.CSCore && root.CSCore.api && typeof root.CSCore.api.setTransport === 'function') {
      root.CSCore.api.setTransport(httpRequest);
    }
  } catch { /* 内核未加载时忽略，inject.js 会报错 */ }

  // 启动心跳（让顶层能感知到本帧还活着）
  beat('待机', false);

  // 注册油猴菜单（只有顶层注册，避免每个 iframe 都塞三条菜单）
  if (IS_TOP) registerMenu();
})(typeof globalThis !== 'undefined' ? globalThis : self);

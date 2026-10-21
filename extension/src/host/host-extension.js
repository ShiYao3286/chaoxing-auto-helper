/**
 * 宿主适配层 · Edge 扩展版
 *
 * 职责：把「内核需要的宿主能力」用 chrome.* 实现。
 * 内核（core/、content/、ui/）不直接碰 chrome.*，只调 Host.*。
 *
 * 这样同一份内核换一个 Host（host-userscript.js）就能跑在油猴里。
 *
 * 接口（与 host-userscript.js 严格对齐）：
 *   Host.send(type, payload)        发消息，等回复 → Promise<resp|null>
 *   Host.sendNoWait(type, payload)  发消息，不等待 → void
 *   Host.on(fn)                     收消息；fn(msg, sender, reply)
 *   Host.getCfg() / Host.setCfg(p)  读写配置
 *   Host.getRunning() / setRunning  运行态
 *   Host.openOptions()              打开设置页
 *
 * 注意：content script 跑在隔离世界，chrome.* 是扩展 API 不是页面的。
 */
(function (root) {
  'use strict';

  if (root.CSHost) return;

  /**
   * 发消息并等回复
   *
   * 不设超时：真正的 API 调用最长要 120 秒（视觉模型），
   * 之前加 5 秒兜底会把正常请求截断成 null —— 那是个 bug。
   * chrome.runtime.sendMessage 的 Promise 一定会 settle
   * （没有接收方时 reject），所以不需要额外兜底。
   */
  function send(type, payload) {
    return new Promise((resolve) => {
      try {
        const p = chrome.runtime.sendMessage({ type, ...(payload || {}) });
        // MV3 返回 Promise；老版本走回调或无返回
        if (p && typeof p.then === 'function') {
          p.then(v => resolve(v)).catch(() => resolve(null));
        } else {
          resolve(null);
        }
      } catch {
        resolve(null);
      }
    });
  }

  /** 不关心回复的发送（心跳类消息，避免 unhandled rejection） */
  function sendNoWait(type, payload) {
    try {
      const p = chrome.runtime.sendMessage({ type, ...(payload || {}) });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* ignore */ }
  }

  /**
   * 注册消息监听
   *
   * 回调签名严格为 fn(msg, reply) —— 与 host-userscript.js 一致。
   *
   * 踩过的坑：这里曾经写成 fn(msg, sender, reply)（照抄 chrome 的三参数），
   * 但 inject.js 注册的是 (msg, reply)，于是 reply 被绑成了 sender 对象，
   * 调用 reply() 抛 TypeError，消息永远没有应答 —— 表现为整组测试卡死。
   * 统一成两参数，sender 挂在 reply.sender 上备用。
   */
  function on(fn) {
    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        let answered = false;
        const reply = (v) => {
          if (answered) return;
          answered = true;
          try { sendResponse(v || { ok: true }); } catch { /* ignore */ }
        };
        reply.sender = sender;
        try {
          fn(msg, reply);
        } catch (e) {
          reply({ ok: false, error: e?.message || String(e) });
        }
        return true;   // 保持通道开启，允许异步 reply
      });
    } catch { /* ignore */ }
  }

  const CSHost = {
    kind: 'extension',
    send,
    sendNoWait,
    on,

    getCfg: () => send('cfg:get').then(r => r?.cfg || null),
    setCfg: (patch) => send('cfg:set', { patch }),
    getRunning: () => send('state:get').then(r => !!r?.running),
    setRunning: (v) => sendNoWait('state:set', { running: !!v }),
    openOptions: () => sendNoWait('open:options'),

    /** 是否具备扩展专有能力 */
    caps: {
      screenshot: true,      // captureVisibleTab
      backgroundFetch: true, // Service Worker 里的 fetch（绕 CORS）
      storage: true
    }
  };

  root.CSHost = CSHost;
})(typeof globalThis !== 'undefined' ? globalThis : self);

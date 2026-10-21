/**
 * 学习通自动学习助手 — 后台 Service Worker (MV3)
 *
 * 职责（v1.4.0 起，逻辑已抽到内核）：
 *  1. 加载内核（core/）+ 注入传输层（Service Worker 里可用的 fetch）
 *  2. 配置读写（chrome.storage）
 *  3. 汇总各 frame 运行状态，供顶层面板显示
 *  4. 字体文件下载代理
 *  5. 截图 + 裁剪（扩展专有）
 *  6. 消息路由
 *
 * 纯逻辑（默认值、地址推导、提示词、API 调用、JSON 解析）都在 core/ 里，
 * 这里只保留「必须跑在 Service Worker 里」的部分。
 */

'use strict';

/* ============================================================
 * 0. 加载内核
 * ============================================================ */

importScripts(
  '/src/core/namespace.js',
  '/src/core/config.js',
  '/src/core/prompt.js',
  '/src/core/api.js'
);

const CS = self.CSCore;

/** 内核 → 宿主的传输层：Service Worker 里的 fetch 不受页面 CORS 限制 */
CS.api.setTransport(async ({ method, url, headers, body, timeout }) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout || 30000);
  let resp;
  try {
    resp = await fetch(url, {
      method: method || 'GET',
      headers: headers || {},
      body: body || undefined,
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      throw new Error('请求超时（' + Math.round((timeout || 30000) / 1000) + ' 秒）');
    }
    throw new Error('网络请求失败：' + e.message);
  }
  clearTimeout(timer);
  const text = await resp.text();
  return { ok: resp.ok, status: resp.status, text };
});

/** 供外部读的默认值 */
const DEFAULTS = CS.config.DEFAULTS;
const mergeDefaults = CS.config.mergeDefaults;

/* ------------------------------------------------------------
 * 兼容别名
 *
 * 这几个函数原本是 background.js 的顶层 function，在经典脚本里
 * 自动成为全局，测试脚本和诊断代码会直接按名字调用。
 * 抽进 core / 改名之后补上别名，调用方无需改动。
 * ------------------------------------------------------------ */
const deriveModelsUrl = CS.api.deriveModelsUrl;
const normalizeChatEndpoint = CS.api.normalizeChatEndpoint;
const getByPath = CS.api.getByPath;
const extractJson = CS.api.extractJson;
const buildHeaders = CS.api.buildHeaders;
const callAnswerApi = CS.api.callAnswerApi;
const fetchModels = CS.api.fetchModels;
const testConnection = CS.api.testConnection;
const callVisionApi = CS.api.callVisionApi;

/* ============================================================
 * 1. 配置读写
 * ============================================================ */

async function getCfg() {
  const { cfg } = await chrome.storage.local.get('cfg');
  return mergeDefaults(cfg);
}

chrome.runtime.onInstalled.addListener(async () => {
  const { cfg } = await chrome.storage.local.get('cfg');
  if (!cfg) await chrome.storage.local.set({ cfg: DEFAULTS, running: false });
  initContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  // 浏览器重启后确保处于停止态
  chrome.storage.local.set({ running: false });
});

function initContextMenus() {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'cs-open-options',
        title: '学习通助手：打开设置',
        contexts: ['action']
      });
    });
  } catch { /* ignore */ }
}

try {
  chrome.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId === 'cs-open-options') chrome.runtime.openOptionsPage();
  });
} catch { /* ignore */ }

/* ============================================================
 * 2. 各 frame 运行状态汇总
 * ============================================================ */

/** tabId -> Map<frameId, {status, busy, ts}> */
const frameStatus = new Map();

function pruneStatus() {
  const now = Date.now();
  for (const [tabId, frames] of frameStatus) {
    for (const [fid, st] of frames) {
      if (now - st.ts > 15000) frames.delete(fid);
    }
    if (frames.size === 0) frameStatus.delete(tabId);
  }
}

function setFrameStatus(tabId, frameId, status) {
  if (tabId == null || frameId == null) return;
  let frames = frameStatus.get(tabId);
  if (!frames) { frames = new Map(); frameStatus.set(tabId, frames); }
  frames.set(frameId, { ...status, ts: Date.now() });
}

/**
 * 子帧上报的任务点明细
 *
 * 为什么需要：.ans-job-icon 只在 cards 帧（d1）里有，
 * 顶层面板自己查不到。之前子帧发了 frame:taskdetail
 * 但没有接收方，消息直接报错丢弃 —— 面板因此永远没有明细。
 * 这里存到对应 frame 状态里，由 aggregate() 带回顶层。
 */
function setFrameDetail(tabId, frameId, detail) {
  if (tabId == null || frameId == null || !detail) return;
  let frames = frameStatus.get(tabId);
  if (!frames) { frames = new Map(); frameStatus.set(tabId, frames); }
  const prev = frames.get(frameId) || {};
  frames.set(frameId, { ...prev, detail, detailTs: Date.now() });
}

/** 是否有别的 frame 正在忙（排除调用方自己） */
function anyBusy(tabId, excludeFrameId) {
  pruneStatus();
  const frames = frameStatus.get(tabId);
  if (!frames) return false;
  const now = Date.now();
  for (const [fid, st] of frames) {
    if (fid === excludeFrameId) continue;
    if (st.busy && now - st.ts < 8000) return true;
  }
  return false;
}

function aggregate(tabId) {
  pruneStatus();
  const frames = frameStatus.get(tabId);
  if (!frames || frames.size === 0) return { status: '待机', busy: false, count: 0, detail: null };
  const list = [...frames.values()].sort((a, b) => b.ts - a.ts);
  const busy = list.some(s => s.busy && Date.now() - s.ts < 8000);
  const detail = list.find(s => s.detail && Date.now() - (s.detailTs || 0) < 20000)?.detail || null;
  return { status: list[0].status || '待机', busy, count: list.length, detail };
}

chrome.tabs.onRemoved.addListener(tabId => frameStatus.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') frameStatus.delete(tabId);
});

/* ============================================================
 * 3. 字体下载代理（字体反爬解码用）
 * ============================================================ */

const fontCache = new Map();

async function fetchFontBase64(url) {
  if (!url) throw new Error('缺少字体地址');
  if (fontCache.has(url)) return fontCache.get(url);
  if (url.startsWith('data:')) return url.slice(url.indexOf(',') + 1);

  const resp = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
  if (!resp.ok) throw new Error('字体下载失败 HTTP ' + resp.status);

  const buf = await resp.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  const b64 = btoa(bin);
  if (fontCache.size > 20) fontCache.clear();
  fontCache.set(url, b64);
  return b64;
}

/* ============================================================
 * 4. 截图 + 裁剪（扩展专有，Service Worker 里没有 DOM 用 OffscreenCanvas）
 * ============================================================ */

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/png';
  const bin = atob(payload);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function cropDataUrl(dataUrl, rect, dpr) {
  const blob = dataUrlToBlob(dataUrl);
  const bitmap = await createImageBitmap(blob);

  const sx = Math.max(0, Math.round(rect.x * dpr));
  const sy = Math.max(0, Math.round(rect.y * dpr));
  const sw = Math.max(1, Math.round(rect.w * dpr));
  const sh = Math.max(1, Math.round(rect.h * dpr));

  // 请求区域可能超出可视范围：收缩到图内（这是正确行为）
  const cw = Math.min(sw, bitmap.width - sx);
  const ch = Math.min(sh, bitmap.height - sy);
  const clamped = (cw !== sw || ch !== sh);

  let canvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(Math.max(1, cw), Math.max(1, ch));
  } else {
    throw new Error('当前环境不支持 OffscreenCanvas');
  }

  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, sx, sy, cw, ch, 0, 0, cw, ch);

  const outBlob = await canvas.convertToBlob({ type: 'image/png' });
  const outBuf = await outBlob.arrayBuffer();
  const outBytes = new Uint8Array(outBuf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < outBytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, outBytes.subarray(i, i + CHUNK));
  }
  return { dataUrl: 'data:image/png;base64,' + btoa(bin), clamped };
}

/** 老名字（测试脚本按这个名字调用），必须在 cropDataUrl 定义之后 */
const cropImage = cropDataUrl;

/* ============================================================
 * 5. 消息路由
 * ============================================================ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender?.tab?.id;
  const frameId = sender?.frameId;

  (async () => {
    try {
      switch (msg?.type) {

        case 'cfg:get': {
          sendResponse({ ok: true, cfg: await getCfg() });
          break;
        }

        case 'cfg:set': {
          const cur = await getCfg();
          const next = mergeDefaults({ ...cur, ...msg.patch });
          await chrome.storage.local.set({ cfg: next });
          sendResponse({ ok: true, cfg: next });
          break;
        }

        case 'state:get': {
          const { running } = await chrome.storage.local.get('running');
          sendResponse({ ok: true, running: !!running });
          break;
        }

        case 'state:set': {
          await chrome.storage.local.set({ running: !!msg.running });
          // 广播到所有标签页
          const tabs = await chrome.tabs.query({});
          for (const t of tabs) {
            chrome.tabs.sendMessage(t.id, { type: 'state:changed', running: !!msg.running }).catch(() => {});
          }
          sendResponse({ ok: true, running: !!msg.running });
          break;
        }

        case 'frame:status': {
          setFrameStatus(tabId, frameId, {
            status: msg.status ?? '',
            busy: !!msg.busy,
            kind: msg.kind || ''
          });
          sendResponse({ ok: true });
          break;
        }

        case 'frame:taskdetail': {
          setFrameDetail(tabId, frameId, msg.detail);
          sendResponse({ ok: true });
          break;
        }

        case 'tab:busy': {
          const tid = tabId ?? msg.tabId;
          // 排除调用方自己，否则顶层会一直认为"有人忙"
          sendResponse({ ok: true, busy: anyBusy(tid, frameId), agg: aggregate(tid) });
          break;
        }

        case 'tab:agg': {
          const tid = tabId ?? msg.tabId;
          sendResponse({ ok: true, agg: aggregate(tid) });
          break;
        }

        case 'font:fetch': {
          const b64 = await fetchFontBase64(msg.url);
          sendResponse({ ok: true, b64 });
          break;
        }

        case 'quiz:answer': {
          const cfg = await getCfg();
          const result = await CS.api.callAnswerApi(cfg, msg.questions);
          sendResponse({ ok: true, result });
          break;
        }

        case 'quiz:test': {
          const cfg = await getCfg();
          const testQ = [{ num: 1, type: 'single', text: '测试题目：1+1=？', options: [{ letter: 'A', text: '2' }, { letter: 'B', text: '3' }] }];
          const result = await CS.api.callAnswerApi(cfg, testQ);
          sendResponse({ ok: true, result });
          break;
        }

        case 'models:list': {
          const cfg = await getCfg();
          const r = await CS.api.fetchModels(cfg);
          sendResponse({ ok: true, ...r });
          break;
        }

        case 'api:test': {
          const cfg = await getCfg();
          const r = await CS.api.testConnection(cfg);
          sendResponse({ ok: true, ...r });
          break;
        }

        case 'api:testWith': {
          // 用「设置页当前填的」配置去试，而不是已保存的配置
          const cur = await getCfg();
          const merged = mergeDefaults({ ...cur, quiz: { ...cur.quiz, ...(msg.quiz || {}) } });
          const withVision = mergeDefaults({ ...merged, vision: { ...merged.vision, ...(msg.vision || {}) } });

          // 三个用途：拉模型列表 / 测视觉接口 / 测文本接口
          if (msg.what === 'models' || msg.kind === 'models') {
            const r = await CS.api.fetchModels(merged);
            sendResponse({ ok: true, ...r });
          } else if (msg.what === 'vision' || msg.kind === 'vision') {
            const pix = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
            const r = await CS.api.callVisionApi(withVision, [pix], 'image/png');
            sendResponse({ ok: true, ...r });
          } else {
            const r = await CS.api.testConnection(merged);
            sendResponse({ ok: true, ...r });
          }
          break;
        }

        case 'vision:answer': {
          const cfg = await getCfg();
          const r = await CS.api.callVisionApi(cfg, msg.images || [], msg.mime || 'image/png');
          sendResponse({ ok: true, result: r });
          break;
        }

        case 'page:screenshot': {
          // captureVisibleTab 第一个参数是 windowId，不是 tabId（踩过坑）
          const win = await chrome.windows.getLastFocused({ populate: false });
          const dataUrl = await chrome.tabs.captureVisibleTab(win.id, { format: 'png' });
          const dpr = msg.dpr || 1;
          const rect = msg.rect;
          if (!rect) {
            sendResponse({ ok: true, dataUrl, clamped: false });
            break;
          }
          const cropped = await cropDataUrl(dataUrl, rect, dpr);
          sendResponse({ ok: true, dataUrl: cropped.dataUrl, clamped: cropped.clamped });
          break;
        }

        case 'open:options': {
          chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          break;
        }

        default: {
          sendResponse({ ok: false, error: 'unknown message type: ' + msg?.type });
        }
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();

  return true;   // 异步 sendResponse
});

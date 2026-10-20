/**
 * 学习通自动学习助手 — 后台 Service Worker (MV3)
 *
 * 职责：
 *  1. 提供默认配置 & 配置读写
 *  2. 代理答题 API 请求（绕过页面 CORS 限制）
 *  3. 代理字体文件下载（字体反爬解码用）
 *  4. 汇总各 frame 的运行状态，供顶层面板显示
 */

'use strict';

/* ============================================================
 * 1. 默认配置
 * ============================================================ */

const DEFAULTS = {
  auto: {
    rate: 2.0,              // 视频倍速
    mute: true,             // 静音
    autoNext: true,         // 完成后自动下一节
    docAutoScroll: true,    // 文档/PPT 自动滚动
    docStep: 400,           // 单次滚动像素
    docInterval: 1200,      // 滚动间隔 ms
    loopInterval: 2500,     // 主循环间隔 ms
    antiPause: true,        // 防切屏暂停
    quizEnabled: true,      // 是否处理章节测验
    debug: true
  },
  quiz: {
    provider: 'openai',     // openai | custom
    endpoint: 'https://api.openai.com/v1/chat/completions',
    modelsUrl: '',          // 拉模型列表用，留空则从 endpoint 推导
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.2,
    extraHeaders: '',       // JSON 字符串，custom 模式追加请求头
    bodyTemplate: '',       // custom 模式：完整 body 模板，支持 {{prompt}} {{text}} {{model}}
    responsePath: '',       // custom 模式：响应中答案的 JSON 路径，如 data.answer
    autoFill: true,         // 自动把答案填进页面
    autoSubmit: false,      // 绝不默认自动提交
    prompt: '',             // 自定义提示词（留空用内置）
    modelList: []           // 上次拉取到的模型列表（缓存）
  },

  /* ---- 截图解题（视觉兜底）---- */
  vision: {
    enabled: true,          // 总开关
    mode: 'auto',           // auto | always | off
                            //   auto  : 脚本判断文本不可靠，或模型自评不确定时才截图
                            //   always: 每套题都先截图
                            //   off   : 从不截图
    useSameApi: true,       // 复用上面答题 API 的地址与 Key
    endpoint: '',           // 独立配置时使用
    apiKey: '',
    model: '',              // 视觉模型，如 gpt-4o / qwen-vl-max / glm-4v
    maxShots: 3,            // 最多截几张（长题目分屏）
    autoSubmitAfter: false  // 截图作答后是否自动提交（默认否）
  },

  ui: {
    collapsed: false,
    pos: null
  }
};

/** 深合并默认值 */
function mergeDefaults(saved) {
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  if (!saved || typeof saved !== 'object') return out;
  for (const k of Object.keys(out)) {
    if (saved[k] && typeof saved[k] === 'object') Object.assign(out[k], saved[k]);
    else if (saved[k] !== undefined) out[k] = saved[k];
  }
  return out;
}

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

/** 判断某标签页是否有任意 frame 正在忙 */
function anyBusy(tabId) {
  pruneStatus();
  const frames = frameStatus.get(tabId);
  if (!frames) return false;
  for (const st of frames.values()) {
    if (st.busy && Date.now() - st.ts < 8000) return true;
  }
  return false;
}

function aggregate(tabId) {
  pruneStatus();
  const frames = frameStatus.get(tabId);
  if (!frames || frames.size === 0) return { status: '待机', busy: false, count: 0 };
  const list = [...frames.values()].sort((a, b) => b.ts - a.ts);
  const busy = list.some(s => s.busy && Date.now() - s.ts < 8000);
  return { status: list[0].status || '待机', busy, count: list.length };
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
  if (fontCache.has(url)) return fontCache.get(url);

  const resp = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
  if (!resp.ok) throw new Error('字体下载失败 HTTP ' + resp.status);

  const buf = await resp.arrayBuffer();
  if (buf.byteLength > 8 * 1024 * 1024) throw new Error('字体过大');

  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  const b64 = btoa(bin);
  fontCache.set(url, b64);
  if (fontCache.size > 40) fontCache.delete(fontCache.keys().next().value);
  return b64;
}

/* ============================================================
 * 4. 答题（文本）
 * ============================================================ */

function getByPath(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((acc, key) => {
    if (acc == null) return undefined;
    const idx = Number(key);
    if (Array.isArray(acc) && Number.isInteger(idx)) return acc[idx];
    return acc[key];
  }, obj);
}

/** 从模型返回文本里抠出 JSON */
function extractJson(text) {
  if (!text) return null;
  if (typeof text === 'object') return text;

  let s = String(text).trim();

  // 去掉 ```json ``` 围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  try { return JSON.parse(s); } catch { /* continue */ }

  // 截取第一个 { 到最后一个 }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const frag = s.slice(start, end + 1);
    try { return JSON.parse(frag); } catch { /* continue */ }
  }

  // 兜底：数组
  const as = s.indexOf('[');
  const ae = s.lastIndexOf(']');
  if (as >= 0 && ae > as) {
    try { return JSON.parse(s.slice(as, ae + 1)); } catch { /* continue */ }
  }
  return null;
}

const BUILTIN_PROMPT = `你是思政课教师，正在完成《毛泽东思想和中国特色社会主义理论体系概论》的章节测验。

给定题目（JSON），请逐题作答。要求：
1. 严格依据马克思主义理论/毛泽东思想的学术共识，不要臆造。
2. 单选题返回一个字母；多选题返回全部正确字母（按字母顺序）；判断题返回 "对" 或 "错"；填空题按空顺序返回原文。
3. 只输出 JSON，不要解释、不要 markdown 围栏。

输出格式：
{"answers":[{"num":1,"type":"single","answer":["B"]},{"num":2,"type":"multi","answer":["A","C"]},{"num":4,"type":"fill","answer":["帝国主义"]},{"num":5,"type":"judge","answer":["错"]}]}

其中 type 取值：single / multi / fill / judge。`;

async function callAnswerApi(cfg, questions) {
  const q = cfg.quiz;
  if (!q.endpoint) throw new Error('未配置 API 地址，请到扩展设置里填写');

  const systemPrompt = (q.prompt && q.prompt.trim()) || BUILTIN_PROMPT;
  const userText = JSON.stringify({ questions }, null, 2);
  const fullText = systemPrompt + '\n\n【题目】\n' + userText;

  let url = normalizeChatEndpoint(q.endpoint);
  let headers = { 'Content-Type': 'application/json' };
  let body;

  if (q.provider === 'custom' && q.bodyTemplate) {
    // 自定义模板模式
    let tpl = q.bodyTemplate;
    tpl = tpl
      .replace(/\{\{\s*prompt\s*\}\}/g, JSON.stringify(systemPrompt))
      .replace(/\{\{\s*text\s*\}\}/g, JSON.stringify(userText))
      .replace(/\{\{\s*full\s*\}\}/g, JSON.stringify(fullText))
      .replace(/\{\{\s*model\s*\}\}/g, q.model || '')
      .replace(/\{\{\s*apiKey\s*\}\}/g, q.apiKey || '');
    try { body = JSON.parse(tpl); }
    catch (e) { throw new Error('自定义 body 模板不是合法 JSON：' + e.message); }

    if (q.extraHeaders) {
      try { Object.assign(headers, JSON.parse(q.extraHeaders)); }
      catch { throw new Error('自定义请求头不是合法 JSON'); }
    }
    if (q.apiKey && !headers.Authorization) headers.Authorization = 'Bearer ' + q.apiKey;
  } else {
    // OpenAI 兼容模式
    if (q.apiKey) headers.Authorization = 'Bearer ' + q.apiKey;
    body = {
      model: q.model || 'gpt-4o-mini',
      temperature: typeof q.temperature === 'number' ? q.temperature : 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText }
      ]
    };
    if (q.extraHeaders) {
      try { Object.assign(headers, JSON.parse(q.extraHeaders)); } catch { /* ignore */ }
    }
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('API 请求超时（120 秒）');
    throw new Error('API 请求失败：' + e.message);
  }
  clearTimeout(timer);

  const rawText = await resp.text();
  if (!resp.ok) {
    throw new Error('API 返回 HTTP ' + resp.status + '：' + rawText.slice(0, 300));
  }

  let json;
  try { json = JSON.parse(rawText); }
  catch { json = null; }

  // 提取答案内容
  let content;
  if (q.provider === 'custom' && q.responsePath) {
    content = getByPath(json, q.responsePath);
  } else {
    content = json?.choices?.[0]?.message?.content
      ?? json?.choices?.[0]?.text
      ?? json?.content
      ?? json?.answer
      ?? json?.data
      ?? rawText;
  }

  const parsed = extractJson(content);
  if (!parsed) {
    throw new Error('无法从 API 响应中解析 JSON 答案。原始内容：' + String(content).slice(0, 300));
  }

  if (Array.isArray(parsed)) return { answers: parsed };
  if (parsed.answers) return parsed;
  if (parsed.data?.answers) return parsed.data;
  return { answers: [] , raw: parsed };
}

/* ============================================================
 * 5. 模型列表 / 连通性测试
 * ============================================================ */

/**
 * 从 chat/completions 地址推导 models 地址
 *   https://x/v1/chat/completions  ->  https://x/v1/models
 */
function deriveModelsUrl(endpoint) {
  if (!endpoint) return '';
  let u = endpoint.trim();

  // 已经是 /models 就别动
  if (/\/models\/?$/i.test(u)) return u;

  // 去掉 chat/completions 及其变体
  u = u.replace(/\/chat\/completions\/?$/i, '');
  u = u.replace(/\/completions\/?$/i, '');
  u = u.replace(/\/embeddings\/?$/i, '');
  // 保险：末尾斜杠去掉
  u = u.replace(/\/+$/, '');

  // 已经以 /v1 之类结尾就补 /models
  if (/\/v\d+$/i.test(u) || /\/api$/i.test(u)) return u + '/models';
  return u + '/models';
}

/**
 * 规整聊天接口地址
 *
 * 用户经常只填到 /v1 或干脆填个域名，直接拿去 POST 会 404。
 * 这里按常见形态补全，避免踩坑：
 *   https://x                -> https://x/v1/chat/completions
 *   https://x/v1             -> https://x/v1/chat/completions
 *   https://x/v1/            -> https://x/v1/chat/completions
 *   https://x/v1/chat        -> https://x/v1/chat/completions
 *   已经是完整地址            -> 原样返回
 */
function normalizeChatEndpoint(endpoint) {
  if (!endpoint) return '';
  let u = endpoint.trim().replace(/\s+/g, '');

  // 已经完整就直接用
  if (/\/chat\/completions$/i.test(u)) return u;

  // 只写到 /chat 或 /completions
  if (/\/chat$/i.test(u)) return u + '/completions';
  if (/\/completions$/i.test(u)) return u.replace(/\/completions$/i, '/chat/completions');

  // 末尾斜杠去掉
  u = u.replace(/\/+$/, '');

  // 以 /v1、/v2、/api 等结尾：补完整路径
  if (/\/v\d+$/i.test(u)) return u + '/chat/completions';
  if (/\/api$/i.test(u)) return u + '/v1/chat/completions';

  // 只有域名（无路径）：补 /v1/chat/completions
  try {
    const parsed = new URL(u);
    if (!parsed.pathname || parsed.pathname === '/') {
      return u + '/v1/chat/completions';
    }
  } catch { /* 不是合法 URL，原样返回 */ }

  return u;
}

/** 构造请求头 */
function buildHeaders(q) {
  const headers = { 'Content-Type': 'application/json' };
  if (q.apiKey) headers.Authorization = 'Bearer ' + q.apiKey;
  if (q.extraHeaders) {
    try { Object.assign(headers, JSON.parse(q.extraHeaders)); }
    catch { /* 忽略错误的自定义头 */ }
  }
  return headers;
}

/** 带超时的 fetch */
async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 30000);
  try {
    const resp = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(timer);
    return resp;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('请求超时（' + Math.round((ms || 30000) / 1000) + ' 秒）');
    throw new Error('网络请求失败：' + e.message);
  }
}

/**
 * 拉取可用模型列表
 * 兼容 OpenAI 的 {data:[{id:...}]}，以及一些变体
 */
async function fetchModels(cfg) {
  const q = cfg.quiz;
  const url = q.modelsUrl && q.modelsUrl.trim()
    ? q.modelsUrl.trim()
    : deriveModelsUrl(q.endpoint);

  if (!url) throw new Error('未配置接口地址，无法推导模型列表地址');

  const resp = await fetchWithTimeout(url, {
    method: 'GET',
    headers: buildHeaders(q)
  }, 20000);

  const text = await resp.text();

  if (!resp.ok) {
    throw new Error('HTTP ' + resp.status + '：' + text.slice(0, 300));
  }

  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error('返回的不是 JSON：' + text.slice(0, 200)); }

  // 常见结构
  let arr = null;
  if (Array.isArray(json)) arr = json;
  else if (Array.isArray(json.data)) arr = json.data;
  else if (Array.isArray(json.models)) arr = json.models;
  else if (Array.isArray(json.result)) arr = json.result;
  else if (json.data && Array.isArray(json.data.models)) arr = json.data.models;

  if (!arr) {
    throw new Error('返回格式无法识别，期望含 data/models 数组。原始：' + text.slice(0, 200));
  }

  const ids = arr
    .map(m => {
      if (typeof m === 'string') return m;
      return m.id || m.name || m.model || m.model_name || '';
    })
    .filter(Boolean);

  const uniq = [...new Set(ids)].sort();

  if (!uniq.length) throw new Error('模型列表为空');

  return { url, models: uniq, count: uniq.length };
}

/**
 * 连通性测试：发一条极短请求，确认地址/Key/模型三者都对
 * 返回耗时、模型回显、首字等内容
 */
async function testConnection(cfg) {
  const q = cfg.quiz;
  if (!q.endpoint) throw new Error('未配置接口地址');

  const t0 = Date.now();
  const headers = buildHeaders(q);

  let body;
  if (q.provider === 'custom' && q.bodyTemplate) {
    let tpl = q.bodyTemplate;
    tpl = tpl
      .replace(/\{\{\s*prompt\s*\}\}/g, JSON.stringify('你是助手'))
      .replace(/\{\{\s*text\s*\}\}/g, JSON.stringify('回复 OK'))
      .replace(/\{\{\s*full\s*\}\}/g, JSON.stringify('你是助手\n\n回复 OK'))
      .replace(/\{\{\s*model\s*\}\}/g, q.model || '')
      .replace(/\{\{\s*apiKey\s*\}\}/g, q.apiKey || '');
    try { body = JSON.parse(tpl); }
    catch (e) { throw new Error('请求体模板不是合法 JSON：' + e.message); }
  } else {
    body = {
      model: q.model || 'gpt-4o-mini',
      messages: [{ role: 'user', content: '回复 OK 两个字母即可' }],
      max_tokens: 16,
      temperature: 0
    };
  }

  const resp = await fetchWithTimeout(normalizeChatEndpoint(q.endpoint), {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  }, 45000);

  const text = await resp.text();
  const ms = Date.now() - t0;

  if (!resp.ok) {
    throw new Error('HTTP ' + resp.status + '：' + text.slice(0, 400));
  }

  let json;
  try { json = JSON.parse(text); } catch { json = null; }

  const content = json?.choices?.[0]?.message?.content
    ?? json?.choices?.[0]?.text
    ?? json?.content
    ?? json?.answer
    ?? '';

  const echoModel = json?.model || q.model || '';

  return {
    ok: true,
    ms,
    httpStatus: resp.status,
    model: echoModel,
    reply: String(content).slice(0, 200),
    raw: text.slice(0, 500)
  };
}

/* ============================================================
 * 6. 截图解题（视觉）
 * ============================================================ */

/**
 * 裁剪图片区域
 * Service Worker 里没有 DOM，用 OffscreenCanvas 做。
 */
async function cropImage(dataUrl, rect, dpr) {
  // dataUrl 转 blob：Service Worker 里 fetch(dataURL) 不总是可用，
  // 手动把 base64 解成 Uint8Array 更稳。
  let blob;
  try {
    const b64 = dataUrl.split(',')[1];
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    blob = new Blob([arr], { type: 'image/png' });
  } catch (e) {
    throw new Error('dataURL 解码失败：' + e.message);
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (e) {
    throw new Error('图片解码失败：' + e.message);
  }

  // CSS 像素 -> 图片像素
  const sx = Math.max(0, Math.round(rect.x * dpr));
  const sy = Math.max(0, Math.round(rect.y * dpr));
  const sw = Math.max(1, Math.round(rect.w * dpr));
  const sh = Math.max(1, Math.round(rect.h * dpr));

  const cw = Math.min(sw, bitmap.width - sx);
  const ch = Math.min(sh, bitmap.height - sy);
  if (cw < 1 || ch < 1) throw new Error('裁剪区域超出截图范围');

  // 收缩了就记下来，让调用方知道（题目被截断时要提示用户）
  const clamped = (cw < sw - 2 || ch < sh - 2)
    ? { requested: { w: sw, h: sh }, actual: { w: cw, h: ch } }
    : null;

  let canvas, ctx;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(cw, ch);
    ctx = canvas.getContext('2d');
  } else {
    // 兜底（极少走到）
    canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    ctx = canvas.getContext('2d');
  }

  ctx.drawImage(bitmap, sx, sy, cw, ch, 0, 0, cw, ch);

  let outBlob;
  if (canvas.convertToBlob) {
    outBlob = await canvas.convertToBlob({ type: 'image/png' });
  } else {
    outBlob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  }

  // blob -> dataURL
  const buf = await outBlob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  const outUrl = 'data:image/png;base64,' + btoa(bin);

  return { dataUrl: outUrl, clamped };
}

const VISION_PROMPT = `你是阅卷老师，正在看一张学习通章节测验的截图。

请完成两件事：

【1】逐题作答
- 单选题返回一个字母
- 多选题返回全部正确字母
- 判断题返回 "对" 或 "错"
- 填空题按空顺序返回原文

【2】自评置信度（这一步很重要）
对每道题给出 confidence（0~1）：
- 1.0  = 题干清晰、确定答案
- 0.7  = 大致确定，但有干扰项
- 0.4  = 题干模糊、被遮挡、或文字识别不清
- 0.1  = 完全看不清，只能猜

只要有一题 confidence < 0.6，或截图里有看不清/被截断的内容，
把 uncertain 设为 true 并说明原因（放在 note 里）。

只输出 JSON，不要 markdown 围栏，不要解释。格式：

{"answers":[{"num":1,"type":"single","answer":["B"],"confidence":1.0}],
 "uncertain":false,
 "note":""}`;

/** 视觉模型的 base64 图片消息 */
function buildVisionBody(model, imageB64, mime, prompt) {
  return {
    model,
    temperature: 0.1,
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        {
          type: 'image_url',
          image_url: { url: `data:${mime || 'image/png'};base64,${imageB64}` }
        }
      ]
    }]
  };
}

/**
 * 调视觉模型解截图
 * @param {object} cfg
 * @param {string[]} imagesB64  多张截图（长题目分屏）
 * @param {string} mime
 */
async function callVisionApi(cfg, imagesB64, mime) {
  const v = cfg.vision || {};
  const q = cfg.quiz || {};

  // 决定用哪个地址/Key/模型
  const useSame = v.useSameApi !== false;
  const rawEndpoint = useSame ? q.endpoint : (v.endpoint || q.endpoint);
  const endpoint = normalizeChatEndpoint(rawEndpoint);
  const apiKey = useSame ? q.apiKey : (v.apiKey || q.apiKey);
  const model = (v.model && v.model.trim()) || q.model;

  if (!endpoint) throw new Error('未配置视觉 API 地址');
  if (!model) throw new Error('未配置视觉模型名');
  if (!imagesB64 || !imagesB64.length) throw new Error('没有可用截图');

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
  if (q.extraHeaders) {
    try { Object.assign(headers, JSON.parse(q.extraHeaders)); } catch { /* ignore */ }
  }

  // 多张截图：拼成一条消息里的多张图
  let body;
  if (imagesB64.length === 1) {
    body = buildVisionBody(model, imagesB64[0], mime, VISION_PROMPT);
  } else {
    const content = [{ type: 'text', text: VISION_PROMPT + '\n\n下面是同一套测验的连续截图，请合并理解。' }];
    for (const b64 of imagesB64) {
      content.push({ type: 'image_url', image_url: { url: `data:${mime || 'image/png'};base64,${b64}` } });
    }
    body = { model, temperature: 0.1, max_tokens: 2500, messages: [{ role: 'user', content }] };
  }

  const resp = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  }, 120000);

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error('视觉 API HTTP ' + resp.status + '：' + text.slice(0, 400));
  }

  let json;
  try { json = JSON.parse(text); } catch { json = null; }

  const content = json?.choices?.[0]?.message?.content
    ?? json?.content
    ?? json?.answer
    ?? text;

  const parsed = extractJson(content);
  if (!parsed) {
    throw new Error('无法解析视觉模型返回的 JSON：' + String(content).slice(0, 300));
  }

  const answers = parsed.answers || parsed.data?.answers || (Array.isArray(parsed) ? parsed : []);
  const uncertain = !!parsed.uncertain;
  const note = parsed.note || '';

  // 统计低置信度题
  const lowConf = answers.filter(a => typeof a.confidence === 'number' && a.confidence < 0.6);

  return {
    answers,
    uncertain: uncertain || lowConf.length > 0,
    note,
    lowConfidenceNums: lowConf.map(a => a.num),
    model
  };
}

/* ============================================================
 * 7. 消息路由
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

        case 'tab:busy': {
          const tid = tabId ?? msg.tabId;
          sendResponse({ ok: true, busy: anyBusy(tid), agg: aggregate(tid) });
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
          const result = await callAnswerApi(cfg, msg.questions);
          sendResponse({ ok: true, result });
          break;
        }

        case 'quiz:test': {
          const cfg = await getCfg();
          const testQ = [{ num: 1, type: 'single', text: '中国革命的首要问题是？', options: ['A 农民问题', 'B 分清敌友', 'C 土地问题', 'D 领导权问题'] }];
          const result = await callAnswerApi(cfg, testQ);
          sendResponse({ ok: true, result });
          break;
        }

        /* ---- 模型列表 ---- */
        case 'models:list': {
          const cfg = await getCfg();
          const r = await fetchModels(cfg);
          // 顺手缓存
          cfg.quiz.modelList = r.models;
          await chrome.storage.local.set({ cfg });
          sendResponse({ ok: true, ...r });
          break;
        }

        /* ---- 连通性测试 ---- */
        case 'api:test': {
          const cfg = await getCfg();
          const r = await testConnection(cfg);
          sendResponse({ ok: true, ...r });
          break;
        }

        /* ---- 用指定临时配置测（设置页改动后不保存也能测）---- */
        case 'api:testWith': {
          const cur = await getCfg();
          const merged = mergeDefaults({
            ...cur,
            quiz: { ...cur.quiz, ...(msg.quiz || {}) },
            vision: { ...cur.vision, ...(msg.vision || {}) }
          });
          if (msg.what === 'models') {
            const r = await fetchModels(merged);
            // 缓存到已保存的配置里，供设置页回显（不覆盖用户当前未保存的输入）
            if (cur.quiz) {
              cur.quiz.modelList = r.models;
              await chrome.storage.local.set({ cfg: cur });
            }
            sendResponse({ ok: true, ...r });
          } else if (msg.what === 'vision') {
            // 视觉连通性：用一张 1x1 的透明 PNG 试
            const pix = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
            const r = await callVisionApi(merged, [pix], 'image/png');
            sendResponse({ ok: true, model: r.model, answers: r.answers.length });
          } else {
            const r = await testConnection(merged);
            sendResponse({ ok: true, ...r });
          }
          break;
        }

        /* ---- 截图解题 ---- */
        case 'vision:answer': {
          const cfg = await getCfg();
          const r = await callVisionApi(cfg, msg.images || [], msg.mime || 'image/png');
          sendResponse({ ok: true, result: r });
          break;
        }

        /* ---- 页面截图（裁剪到题目区域）---- */
        case 'page:screenshot': {
          const tid = tabId ?? msg.tabId;
          if (tid == null) { sendResponse({ ok: false, error: '无法定位标签页' }); break; }

          try {
            // 注意：captureVisibleTab 的第一个参数是 windowId，不是 tabId。
            // 直接传 tabId 会报 "No window with id: xxx"。
            const tab = await chrome.tabs.get(tid);
            if (!tab || tab.windowId == null) throw new Error('无法获取窗口 ID');

            // 确保目标标签是激活状态，否则截到的是别的页面
            if (!tab.active) {
              await chrome.tabs.update(tid, { active: true });
              await new Promise(r => setTimeout(r, 350));
            }

            const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

            // 2. 裁剪到题目区域
            const rect = msg.rect || null;
            const dpr = msg.dpr || 1;

            if (!rect || rect.w < 4 || rect.h < 4) {
              sendResponse({ ok: true, dataUrl, mime: 'image/png', cropped: false });
              break;
            }

            const result = await cropImage(dataUrl, rect, dpr);
            sendResponse({
              ok: true,
              dataUrl: result.dataUrl,
              mime: 'image/png',
              cropped: true,
              clamped: result.clamped
            });
          } catch (e) {
            sendResponse({ ok: false, error: '截图失败：' + e.message });
          }
          break;
        }

        case 'open:options': {
          chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ ok: false, error: '未知消息类型: ' + msg?.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();

  return true; // 异步响应
});

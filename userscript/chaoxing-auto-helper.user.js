// ==UserScript==
// @name         学习通自动学习助手
// @namespace    https://github.com/ShiYao3286/chaoxing-auto-helper
// @version      1.4.0
// @description  超星学习通章节自动学习：任务队列驱动、任务点真实判定、测验自动作答（走你自己的 API）
// @author       ShiYao3286
// @license      MIT
// @match        *://*.chaoxing.com/*
// @match        *://*.edu.cn/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-idle
// @noframes     false
// ==/UserScript==

/*
 * 这个文件是构建产物，不要直接改。
 * 源码在 extension/src/{core,host,ui,content}/，改完跑：
 *   node build/build-userscript.cjs
 *
 * 与扩展版的差异（能力）：
 *   - 没有真实截图 → 截图解题自动降级为「文字重绘」
 *   - 没有后台 Service Worker → 跨帧协调走 BroadcastChannel
 *   - 配置存 GM_setValue（与扩展的 chrome.storage 互不相通）
 */


/* ============================================================================
 * src/core/namespace.js
 * ============================================================================ */

/**
 * 内核命名空间
 *
 * 为什么用「挂全局对象」而不是 ESM：
 *   ① MV3 的 content script 必须是经典脚本（不能 import）
 *   ② background 的 importScripts() 也是经典脚本
 *   ③ 油猴脚本是单文件，没有模块系统
 *   三个宿主都是经典脚本环境，所以统一挂到 root.CSCore 上最省事，
 *   不需要引入打包器（这也让扩展保持「解压即加载」）。
 *
 * 加载顺序：本文件必须最先载入。
 */
(function (root) {
  'use strict';

  if (root.CSCore) return;   // 重复注入保护

  const CSCore = {
    /** 内核版本，跟 manifest 的 version 保持同一节奏 */
    VERSION: '1.4.0',

    /** 各子模块挂载点（config.js / prompt.js / api.js 往里填） */
    config: {},
    prompt: {},
    api: {},

    /** 调试日志：宿主可覆盖 */
    log: function () {}
  };

  root.CSCore = CSCore;
})(typeof globalThis !== 'undefined' ? globalThis : self);


/* ============================================================================
 * src/core/config.js
 * ============================================================================ */

/**
 * 内核 · 默认配置与合并
 *
 * 零 chrome API：这里只有纯数据和纯函数。
 * 存取由宿主实现（扩展用 chrome.storage，脚本用 GM_setValue）。
 */
(function (root) {
  'use strict';

  const CSCore = root.CSCore;
  if (!CSCore) throw new Error('namespace.js 必须先加载');

  const DEFAULTS = {
    auto: {
      rate: 2.0,              // 视频倍速
      mute: true,             // 静音
      autoNext: true,         // 完成后自动下一节
      docAutoScroll: true,    // 文档/PPT 自动滚动
      docStep: 400,           // 单次滚动像素（兼容保留）
      docHumanLike: true,     // 拟人化滚动：1.5 秒一屏
      skipUnfinished: true,   // 任务点未完成时是否也跳下一节
      videoThreshold: 0.9,    // 视频完成门槛（页面明示 90%）
      videoWaitTimeout: 300,  // 视频最长等待秒数（超时跳过）
      minDwellSeconds: 5,     // 每节最低停留秒数（防刷太快）
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

  /** 深合并默认值（只合并一层，够用） */
  function mergeDefaults(saved) {
    const out = JSON.parse(JSON.stringify(DEFAULTS));
    if (!saved || typeof saved !== 'object') return out;
    for (const k of Object.keys(out)) {
      if (saved[k] && typeof saved[k] === 'object') Object.assign(out[k], saved[k]);
      else if (saved[k] !== undefined) out[k] = saved[k];
    }
    return out;
  }

  CSCore.config.DEFAULTS = DEFAULTS;
  CSCore.config.mergeDefaults = mergeDefaults;
})(typeof globalThis !== 'undefined' ? globalThis : self);


/* ============================================================================
 * src/core/prompt.js
 * ============================================================================ */

/**
 * 内核 · 提示词
 *
 * 零 chrome API，纯字符串常量。宿主与 UI 都可以读，用于展示/自定义。
 */
(function (root) {
  'use strict';

  const CSCore = root.CSCore;
  if (!CSCore) throw new Error('namespace.js 必须先加载');

  const BUILTIN_PROMPT = `你是思政课教师，正在完成《毛泽东思想和中国特色社会主义理论体系概论》的章节测验。

给定题目（JSON），请逐题作答。要求：
1. 严格依据马克思主义理论/毛泽东思想的学术共识，不要臆造。
2. 单选题返回一个字母；多选题返回全部正确字母（按字母顺序）；判断题返回 "对" 或 "错"；填空题按空顺序返回原文。
3. 只输出 JSON，不要解释、不要 markdown 围栏。

输出格式：
{"answers":[{"num":1,"type":"single","answer":["B"]},{"num":2,"type":"multi","answer":["A","C"]},{"num":4,"type":"fill","answer":["帝国主义"]},{"num":5,"type":"judge","answer":["错"]}]}

其中 type 取值：single / multi / fill / judge。`;

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

  CSCore.prompt.BUILTIN_PROMPT = BUILTIN_PROMPT;
  CSCore.prompt.VISION_PROMPT = VISION_PROMPT;
})(typeof globalThis !== 'undefined' ? globalThis : self);


/* ============================================================================
 * src/core/api.js
 * ============================================================================ */

/**
 * 内核 · API 调用层
 *
 * 零 chrome API。所有网络请求都通过注入的传输层发起：
 *   - 扩展：宿主传 fetch（Service Worker 里可用，绕开页面 CORS）
 *   - 脚本：宿主传 GM_xmlhttpRequest 包装（绕开页面 CORS + 支持自定义域名）
 *
 * 这样同一份逻辑在两个宿主里跑，不用改任何请求代码。
 */
(function (root) {
  'use strict';

  const CSCore = root.CSCore;
  if (!CSCore) throw new Error('namespace.js 必须先加载');
  if (!CSCore.config.DEFAULTS) throw new Error('config.js 必须在 api.js 之前加载');

  const { mergeDefaults } = CSCore.config;
  const { BUILTIN_PROMPT, VISION_PROMPT } = CSCore.prompt;

  /* ============================================================
   * 0. 传输层（宿主注入）
   * ============================================================ */

  let _transport = null;

  /**
   * 注入传输层
   * @param {(opts:{method,url,headers,body,timeout})=>Promise<{ok,status,text}>} fn
   */
  function setTransport(fn) {
    if (typeof fn !== 'function') throw new Error('传输层必须是函数');
    _transport = fn;
  }

  function hasTransport() { return typeof _transport === 'function'; }

  /** 统一请求入口：所有 API 调用都走这里 */
  async function request(opts) {
    if (!_transport) throw new Error('传输层未注入（宿主未初始化）');
    const r = await _transport(opts);
    // 传输层可以返回 {ok,status,text}，也可以直接抛错
    if (!r || typeof r.text !== 'string') {
      throw new Error('传输层返回格式不对，需要 {ok,status,text}');
    }
    return r;
  }

  /* ============================================================
   * 1. 通用小工具
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

  /* ============================================================
   * 2. 地址规整
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

  /* ============================================================
   * 3. 答题（文本）
   * ============================================================ */

  async function callAnswerApi(cfg, questions) {
    const q = cfg.quiz;
    if (!q.endpoint) throw new Error('未配置 API 地址，请到设置里填写');

    const systemPrompt = (q.prompt && q.prompt.trim()) || BUILTIN_PROMPT;
    const userText = JSON.stringify({ questions }, null, 2);
    const fullText = systemPrompt + '\n\n【题目】\n' + userText;

    const url = normalizeChatEndpoint(q.endpoint);
    const headers = { 'Content-Type': 'application/json' };
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

    const resp = await request({
      method: 'POST',
      url,
      headers,
      body: JSON.stringify(body),
      timeout: 120000
    });

    if (!resp.ok) {
      throw new Error('API 返回 HTTP ' + resp.status + '：' + resp.text.slice(0, 300));
    }

    let json;
    try { json = JSON.parse(resp.text); }
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
        ?? resp.text;
    }

    const parsed = extractJson(content);
    if (!parsed) {
      throw new Error('无法从 API 响应中解析 JSON 答案。原始内容：' + String(content).slice(0, 300));
    }

    if (Array.isArray(parsed)) return { answers: parsed };
    if (parsed.answers) return parsed;
    if (parsed.data?.answers) return parsed.data;
    return { answers: [], raw: parsed };
  }

  /* ============================================================
   * 4. 模型列表 / 连通性测试
   * ============================================================ */

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

    const resp = await request({
      method: 'GET',
      url,
      headers: buildHeaders(q),
      timeout: 20000
    });

    if (!resp.ok) {
      throw new Error('HTTP ' + resp.status + '：' + resp.text.slice(0, 300));
    }

    let json;
    try { json = JSON.parse(resp.text); }
    catch { throw new Error('返回的不是 JSON：' + resp.text.slice(0, 200)); }

    // 常见结构
    let arr = null;
    if (Array.isArray(json)) arr = json;
    else if (Array.isArray(json.data)) arr = json.data;
    else if (Array.isArray(json.models)) arr = json.models;
    else if (Array.isArray(json.result)) arr = json.result;
    else if (json.data && Array.isArray(json.data.models)) arr = json.data.models;

    if (!arr) {
      throw new Error('返回格式无法识别，期望含 data/models 数组。原始：' + resp.text.slice(0, 200));
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

    const resp = await request({
      method: 'POST',
      url: normalizeChatEndpoint(q.endpoint),
      headers,
      body: JSON.stringify(body),
      timeout: 45000
    });

    const ms = Date.now() - t0;

    if (!resp.ok) {
      throw new Error('HTTP ' + resp.status + '：' + resp.text.slice(0, 400));
    }

    let json;
    try { json = JSON.parse(resp.text); } catch { json = null; }

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
      raw: resp.text.slice(0, 500)
    };
  }

  /* ============================================================
   * 5. 视觉（截图解题）
   * ============================================================ */

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

    const resp = await request({
      method: 'POST',
      url: endpoint,
      headers,
      body: JSON.stringify(body),
      timeout: 120000
    });

    if (!resp.ok) {
      throw new Error('视觉 API HTTP ' + resp.status + '：' + resp.text.slice(0, 400));
    }

    let json;
    try { json = JSON.parse(resp.text); } catch { json = null; }

    const content = json?.choices?.[0]?.message?.content
      ?? json?.content
      ?? json?.answer
      ?? resp.text;

    const parsed = extractJson(content);
    if (!parsed) {
      throw new Error('无法解析视觉模型返回的 JSON：' + String(content).slice(0, 300));
    }

    const answers = parsed.answers || parsed.data?.answers || (Array.isArray(parsed) ? parsed : []);
    const uncertain = !!parsed.uncertain;

    return {
      ok: true,
      model,                          // 回显用的模型名（设置页要显示）
      answers,
      answerCount: answers.length,    // 条数（设置页要显示"返回了 N 条"）
      uncertain,
      note: parsed.note || '',
      raw: parsed
    };
  }

  /* ============================================================
   * 导出
   * ============================================================ */

  CSCore.api = {
    // 传输层
    setTransport, hasTransport, request,
    // 工具
    getByPath, extractJson,
    // 地址
    deriveModelsUrl, normalizeChatEndpoint, buildHeaders,
    // 业务
    callAnswerApi, fetchModels, testConnection,
    buildVisionBody, callVisionApi
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);


/* ============================================================================
 * src/host/host-userscript.js
 * ============================================================================ */

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


/* ============================================================================
 * src/ui/theme.js
 * ============================================================================ */

/**
 * UI · 设计令牌
 *
 * 结构借鉴大学搜题酱（12px 卡片圆角 / 左标签右控件 / Element 开关 / 32px 按钮），
 * 但配色、渐变、语义色是自有的一套，不复用它的 CSS/图标/类名。
 *
 * 三个产物共用这一份令牌：
 *   ① 悬浮面板（扩展 + 脚本）
 *   ② 脚本设置弹窗
 *   ③ 扩展设置页
 *
 * 加载顺序：在 core/ 之后、ui/panel.js 之前。
 */
(function (root) {
  'use strict';

  if (root.CSTheme) return;

  const THEME = {
    color: {
      primary: '#2d6cdf',        // 主色（搜题酱用 #2655fe）
      primaryDark: '#255bbd',    // 主色 hover
      primaryLight: '#4b8bf5',   // 渐变亮端（它用 #009bfb）

      ink: '#141414',            // 主文字
      ink2: '#626466',           // 次文字 / 标签
      ink3: '#8b949e',           // 更弱（提示）

      line: '#f0f1f3',           // 边框 / 分隔（它用更淡的 #f5f5f5）
      lineStrong: '#e1e5ea',     // 虚线分隔
      hover: '#f7f8fa',          // 悬停底色
      disabled: '#b9babd',       // 禁用
      switchOff: '#dcdfe6',      // 开关关态

      // 语义色：搜题酱整个面板只用蓝色，我们保留绿橙灰，一屏能分清进度
      ok: '#2da44e',
      okBg: '#e9f7ee',
      warn: '#b26a00',
      warnBg: '#fff5e6',
      off: '#8b949e',
      offBg: '#f5f5f5',

      danger: '#e5484d',
      dangerDark: '#cf3c41',

      brandBg: '#f3f5f8',        // 中性标签底色
      white: '#ffffff',

      /* 消息条配色（设置弹窗与设置页共用，避免各处硬编码） */
      msgOkFg: '#17603a',
      msgOkBg: '#e9f7ee',
      msgErrFg: '#a41919',
      msgErrBg: '#fff0f0',
      msgInfoFg: '#1c4faa',
      msgInfoBg: '#eef4ff',
      msgWarnFg: '#8a5300'
    },

    /** 渐变（135°，搜题酱用 270°） */
    grad: {
      brand: 'linear-gradient(135deg,#4b8bf5 0%,#2d6cdf 100%)',
      bar: 'linear-gradient(90deg,#2d6cdf,#4b8bf5)'
    },

    radius: { card: 12, sm: 8, pill: 14, dot: '50%' },

    size: {
      panel: 300,
      btn: 32,
      btnHeight: 32,
      switchW: 40,
      switchH: 24,
      thumb: 20,
      barH: 4,
      qdot: 6
    },

    shadow: '0 8px 24px rgba(15,23,42,.10)',
    shadowStrong: '0 18px 48px rgba(15,23,42,.18)',

    font: '-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
    fontSize: '14px',

    /** CSS 变量前缀，注入样式表时用 */
    varPrefix: '--cs-'
  };

  /**
   * 把令牌渲染成 CSS 变量块（面板和设置页共用）
   * @param {string} selector 作用域选择器，如 '#cs-panel'
   */
  function cssVars(selector) {
    const c = THEME.color;
    const lines = [
      selector + '{',
      '  --cs-primary:' + c.primary + ';',
      '  --cs-primary-dark:' + c.primaryDark + ';',
      '  --cs-primary-light:' + c.primaryLight + ';',
      '  --cs-ink:' + c.ink + ';',
      '  --cs-ink2:' + c.ink2 + ';',
      '  --cs-ink3:' + c.ink3 + ';',
      '  --cs-line:' + c.line + ';',
      '  --cs-line-strong:' + c.lineStrong + ';',
      '  --cs-hover:' + c.hover + ';',
      '  --cs-disabled:' + c.disabled + ';',
      '  --cs-switch-off:' + c.switchOff + ';',
      '  --cs-ok:' + c.ok + ';',
      '  --cs-ok-bg:' + c.okBg + ';',
      '  --cs-warn:' + c.warn + ';',
      '  --cs-warn-bg:' + c.warnBg + ';',
      '  --cs-off:' + c.off + ';',
      '  --cs-off-bg:' + c.offBg + ';',
      '  --cs-danger:' + c.danger + ';',
      '  --cs-danger-dark:' + c.dangerDark + ';',
      '  --cs-msg-ok-fg:' + c.msgOkFg + ';',
      '  --cs-msg-ok-bg:' + c.msgOkBg + ';',
      '  --cs-msg-err-fg:' + c.msgErrFg + ';',
      '  --cs-msg-err-bg:' + c.msgErrBg + ';',
      '  --cs-msg-info-fg:' + c.msgInfoFg + ';',
      '  --cs-msg-info-bg:' + c.msgInfoBg + ';',
      '  --cs-msg-warn-fg:' + c.msgWarnFg + ';',
      '  --cs-r-card:' + THEME.radius.card + 'px;',
      '  --cs-r-sm:' + THEME.radius.sm + 'px;',
      '  --cs-shadow:' + THEME.shadow + ';',
      '  --cs-font:' + THEME.font + ';',
      '}'
    ];
    return lines.join('\n');
  }

  root.CSTheme = THEME;
  root.CSTheme.cssVars = cssVars;
})(typeof globalThis !== 'undefined' ? globalThis : self);


/* ============================================================================
 * src/ui/panel.js
 * ============================================================================ */

/**
 * UI · 悬浮面板
 *
 * 从 inject.js 抽出来的四块：样式表、DOM 结构、事件绑定、状态渲染。
 *
 * 为什么要抽：这段 UI 要在「扩展」和「油猴脚本」两个形态里完全一致。
 * 留在 inject.js 里会让那份刷课逻辑和样式代码纠缠，改样式得动核心逻辑。
 *
 * 设计：面板不持有刷课状态，靠调用方注入的取数函数（opts.getState 等），
 * 所以面板模块对 inject.js 零依赖 —— 反过来 inject.js 只需要调 mount/render。
 *
 * DOM id 全部保持不变（#cs-panel / #cs-rate / #cs-start …），
 * 因为自动化测试和用户习惯都依赖它们。
 */
(function (root) {
  'use strict';

  if (root.CSPanel) return;

  const T = root.CSTheme;
  if (!T) throw new Error('theme.js 必须先加载');

  const C = T.color;
  const S = T.size;

  /* ============================================================
   * 1. 样式表
   * ============================================================ */

  function buildCss() {
    return T.cssVars('#cs-panel') + `
    #cs-panel{position:fixed;right:18px;bottom:18px;z-index:2147483647;
      background:${C.white};border:1px solid ${C.line};
      border-radius:${T.radius.card}px;
      box-shadow:${T.shadowStrong};
      font:${T.fontSize}/1.5 ${T.font};
      width:${S.panel}px;overflow:hidden;color:${C.ink};
      -webkit-font-smoothing:antialiased;box-sizing:border-box}
    #cs-panel.cs-collapsed .cs-body{display:none}
    #cs-panel.cs-collapsed{width:auto}

    /* 标题栏：渐变文字要走 background-clip，所以不用白底白字 */
    #cs-panel .cs-head{padding:11px 12px 9px;cursor:move;display:flex;
      justify-content:space-between;align-items:center;user-select:none;
      border-bottom:1px solid ${C.line}}
    #cs-panel .cs-title{font-size:16px;font-weight:600;line-height:1.2;
      background:${T.grad.brand};-webkit-background-clip:text;
      background-clip:text;-webkit-text-fill-color:transparent;flex:1}
    #cs-panel .cs-min{cursor:pointer;color:${C.disabled};padding:0 5px;
      font-weight:400;font-size:14px;line-height:1;
      width:24px;height:24px;display:flex;align-items:center;
      justify-content:center;border-radius:6px}
    #cs-panel .cs-min:hover{background:${C.hover};color:${C.ink2}}

    #cs-panel .cs-body{padding:10px 12px 12px}

    /* 左标签 · 右控件 */
    #cs-panel .cs-row{display:flex;justify-content:space-between;
      align-items:center;margin-bottom:13px}
    #cs-panel .cs-row:last-of-type{margin-bottom:0}
    #cs-panel .cs-row label{color:${C.ink2};font-size:14px}

    #cs-panel input[type=number]{width:64px;height:28px;box-sizing:border-box;
      padding:0 8px;border:1px solid ${C.line};border-radius:${T.radius.sm}px;
      font-size:14px;color:${C.ink};text-align:center;outline:none;
      background:${C.white};font-family:inherit}
    #cs-panel input[type=number]:focus{border-color:${C.primary}}

    /* 开关：Element-UI 风格 40x24 */
    #cs-panel .cs-switch{position:relative;display:inline-block;
      width:${S.switchW}px;height:${S.switchH}px}
    #cs-panel .cs-switch input{opacity:0;width:0;height:0}
    #cs-panel .cs-switch .track{position:absolute;inset:0;
      background:${C.switchOff};border-radius:${T.radius.pill}px;
      transition:.2s;cursor:pointer}
    #cs-panel .cs-switch .track:before{content:"";position:absolute;
      width:${S.thumb}px;height:${S.thumb}px;left:2px;top:2px;
      background:${C.white};border-radius:50%;transition:.2s;
      box-shadow:0 1px 3px rgba(0,0,0,.2)}
    #cs-panel .cs-switch input:checked + .track{background:${C.primary}}
    #cs-panel .cs-switch input:checked + .track:before{transform:translateX(16px)}

    /* 按钮组：32px 高、带图标 */
    #cs-panel .cs-btns{display:flex;gap:8px;margin-top:15px;height:${S.btnHeight}px}
    #cs-panel .cs-btns button{flex:1;height:${S.btnHeight}px;
      box-sizing:border-box;border:1px solid ${C.line};
      border-radius:${T.radius.sm}px;cursor:pointer;font-size:14px;
      font-weight:400;font-family:inherit;background:${C.white};
      color:${C.ink};display:flex;align-items:center;justify-content:center;
      gap:5px;padding:0;transition:.15s}
    #cs-panel .cs-btns button:hover{background:${C.hover}}
    #cs-panel .cs-start{background:${T.grad.brand};color:${C.white};
      border-color:transparent;font-weight:600}
    #cs-panel .cs-start:hover{opacity:.9;background:${T.grad.brand}}
    #cs-panel .cs-stop{background:${C.white};color:${C.ink}}
    #cs-panel .cs-stop:hover{background:${C.hover}}
    #cs-panel .cs-gear{flex:0 0 ${S.btnHeight}px;background:${C.white};
      color:${C.ink2};padding:0}

    /* 状态行 */
    #cs-panel .cs-status{margin-top:13px;padding-top:11px;
      border-top:1px solid ${C.line};font-size:13px;color:${C.ink2};
      word-break:break-all;line-height:1.6}
    #cs-panel .cs-status b{color:${C.primary};font-weight:600}

    /* 任务队列：绿/橙/灰语义色，一屏分清进度 */
    #cs-panel .cs-queue{margin-top:10px;display:flex;flex-wrap:wrap;
      gap:6px;font-size:12px}
    #cs-panel .cs-qitem{display:inline-flex;align-items:center;gap:4px;
      padding:3px 8px;border-radius:6px;background:${C.brandBg};
      color:${C.ink2};white-space:nowrap}
    #cs-panel .cs-qitem.done{background:${C.okBg};color:${C.ok}}
    #cs-panel .cs-qitem.doing{background:${C.warnBg};color:${C.warn};
      font-weight:600;animation:cs-pulse 1.8s infinite}
    #cs-panel .cs-qitem.skip{background:${C.offBg};color:${C.off};
      text-decoration:line-through}
    #cs-panel .cs-qdot{width:${S.qdot}px;height:${S.qdot}px;
      border-radius:50%;background:currentColor;flex:0 0 ${S.qdot}px}

    /* 任务点明细（队列扫不到时的兜底） */
    #cs-panel .cs-jobs{margin-top:8px;padding-top:8px;
      border-top:1px dashed ${C.lineStrong};font-size:12px;color:${C.ink2}}
    #cs-panel .cs-jobs .cs-job{display:flex;align-items:center;
      gap:6px;margin:3px 0}
    #cs-panel .cs-jobs .cs-dot{width:7px;height:7px;border-radius:50%;
      background:${C.disabled};flex:0 0 7px}
    #cs-panel .cs-jobs .cs-dot.done{background:${C.ok}}
    #cs-panel .cs-jobs .cs-dot.doing{background:${C.warn};
      animation:cs-pulse 1.2s infinite}

    @keyframes cs-pulse{0%,100%{opacity:1}50%{opacity:.35}}

    /* 进度条 */
    #cs-panel .cs-bar{height:${S.barH}px;background:${C.line};
      border-radius:2px;margin-top:12px;overflow:hidden}
    #cs-panel .cs-bar i{display:block;height:100%;
      background:${T.grad.bar};width:0;
      transition:width .35s ease;border-radius:2px}

    /* 尊重系统的减少动效偏好 */
    @media (prefers-reduced-motion:reduce){
      #cs-panel .cs-qitem.doing,#cs-panel .cs-jobs .cs-dot.doing{animation:none}
      #cs-panel .cs-bar i{transition:none}
    }
    `;
  }

  /* ============================================================
   * 2. DOM 结构
   * ============================================================ */

  function buildHtml() {
    return `
      <div class="cs-head">
        <span class="cs-title">学习通自动学习</span>
        <span class="cs-min" title="折叠">—</span>
      </div>
      <div class="cs-body">
        <div class="cs-row"><label for="cs-rate">播放倍速</label>
          <input type="number" id="cs-rate" step="0.25" min="1" max="4"></div>
        <div class="cs-row"><label for="cs-mute">静音播放</label>
          <label class="cs-switch"><input type="checkbox" id="cs-mute"><span class="track"></span></label></div>
        <div class="cs-row"><label for="cs-next">自动下一节</label>
          <label class="cs-switch"><input type="checkbox" id="cs-next"><span class="track"></span></label></div>
        <div class="cs-row"><label for="cs-doc">文档滚动</label>
          <label class="cs-switch"><input type="checkbox" id="cs-doc"><span class="track"></span></label></div>
        <div class="cs-row"><label for="cs-quiz">自动作答</label>
          <label class="cs-switch"><input type="checkbox" id="cs-quiz"><span class="track"></span></label></div>
        <div class="cs-btns">
          <button class="cs-start" id="cs-start">▶ 开始</button>
          <button class="cs-stop" id="cs-stop">■ 停止</button>
          <button class="cs-gear" id="cs-gear" title="设置">⚙</button>
        </div>
        <div class="cs-status">状态：<b id="cs-status">待机</b></div>
        <div class="cs-queue" id="cs-queue" style="display:none;"></div>
        <div class="cs-jobs" id="cs-jobs" style="display:none;"></div>
        <div class="cs-bar"><i id="cs-bar"></i></div>
      </div>`;
  }

  /* ============================================================
   * 3. 模块状态
   * ============================================================ */

  let _box = null;
  let _opts = null;     // { getCfg, onCfgChange, onStart, onStop, onOpenOptions }

  /* ============================================================
   * 4. 挂载
   * ============================================================ */

  /**
   * 挂载面板
   * @param {object} opts
   *   getCfg()           → 当前配置（用于回填控件）
   *   onCfgChange(auto)  → 用户改了开关/倍速
   *   onStart() / onStop()
   *   onOpenOptions()
   * @returns {HTMLElement|null}
   */
  function mount(opts) {
    if (!document.body) return null;
    if (_box && document.documentElement.contains(_box)) return _box;

    _opts = opts || {};

    // 样式只插一次
    if (!document.getElementById('cs-panel-style')) {
      const style = document.createElement('style');
      style.id = 'cs-panel-style';
      style.textContent = buildCss();
      document.documentElement.appendChild(style);
    }

    const box = document.createElement('div');
    box.id = 'cs-panel';
    box.className = 'cs-panel';
    box.innerHTML = buildHtml();
    document.documentElement.appendChild(box);
    _box = box;

    const el = s => box.querySelector(s);

    // ---- 回填配置 ----
    fillCfg((_opts.getCfg && _opts.getCfg()) || { auto: {} });

    // ---- 保存 ----
    const save = () => {
      const cur = (_opts.getCfg && _opts.getCfg()) || { auto: {} };
      const auto = {
        ...(cur.auto || {}),
        rate: parseFloat(el('#cs-rate').value) || 2,
        mute: el('#cs-mute').checked,
        autoNext: el('#cs-next').checked,
        docAutoScroll: el('#cs-doc').checked,
        quizEnabled: el('#cs-quiz').checked
      };
      if (_opts.onCfgChange) _opts.onCfgChange(auto);
    };
    ['#cs-rate', '#cs-mute', '#cs-next', '#cs-doc', '#cs-quiz']
      .forEach(s => el(s).addEventListener('change', save));

    // ---- 按钮 ----
    el('#cs-start').onclick = () => { save(); if (_opts.onStart) _opts.onStart(); };
    el('#cs-stop').onclick = () => { if (_opts.onStop) _opts.onStop(); };
    el('#cs-gear').onclick = () => { if (_opts.onOpenOptions) _opts.onOpenOptions(); };

    // ---- 折叠 ----
    const minBtn = el('.cs-min');
    minBtn.onclick = e => {
      e.stopPropagation();
      box.classList.toggle('cs-collapsed');
      minBtn.textContent = box.classList.contains('cs-collapsed') ? '+' : '—';
    };

    // ---- 拖动 ----
    const head = el('.cs-head');
    let drag = false, ox = 0, oy = 0;
    head.addEventListener('mousedown', e => {
      if (e.target === minBtn) return;
      const r = box.getBoundingClientRect();
      drag = true; ox = e.clientX - r.left; oy = e.clientY - r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!drag) return;
      box.style.left = (e.clientX - ox) + 'px';
      box.style.top = (e.clientY - oy) + 'px';
      box.style.right = 'auto'; box.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { drag = false; });

    return box;
  }

  /* ============================================================
   * 5. 渲染
   * ============================================================ */

  function esc(s) {
    return String(s == null ? '' : s).replace(/"/g, '&quot;');
  }

  /**
   * 渲染状态
   * @param {object} data
   *   status    状态文字
   *   queue     任务队列 [{type,label,done,supported,title}]
   *   detail    任务点明细 {total,done,items:[{kind,done}]}（队列为空时的兜底）
   *   videoPercent 视频进度 0~1
   */
  function render(data) {
    if (!_box) return;
    const d = data || {};

    // 1. 状态文字（只在变化时写，避免打断浏览器选中）
    const sEl = _box.querySelector('#cs-status');
    if (sEl && sEl.textContent !== d.status) sEl.textContent = d.status || '待机';

    const queueEl = _box.querySelector('#cs-queue');
    const jobsEl = _box.querySelector('#cs-jobs');
    const barEl = _box.querySelector('#cs-bar');

    // 2. 队列
    const q = d.queue || [];
    let queueActive = false;
    if (queueEl) {
      if (q.length) {
        queueActive = true;
        const qsig = q.map(t => t.type + ':' + (t.done === true ? 1 : t.done === false ? 0 : -1) + ':' + (t.supported ? 1 : 0)).join('|');
        if (queueEl.dataset.sig !== qsig) {
          queueEl.dataset.sig = qsig;
          queueEl.innerHTML = q.map(t => {
            const cls = t.done === true ? 'done' : (!t.supported ? 'skip' : 'doing');
            const mark = t.done === true ? '✓' : (!t.supported ? '⏭' : '…');
            const title = t.title ? ' title="' + esc(t.title) + '"' : '';
            return '<span class="cs-qitem ' + cls + '"' + title + '>' +
                   '<span class="cs-qdot"></span>' + (t.label || t.type || '') + ' ' + mark + '</span>';
          }).join('');
        }
        queueEl.style.display = '';
      } else {
        queueEl.style.display = 'none';
      }
    }

    // 3. 明细（队列为空才显示）
    const detail = d.detail;
    if (jobsEl) {
      if (!queueActive && detail && detail.total > 0) {
        const sig = (detail.items || []).map(x => x.kind + ':' + (x.done ? 1 : 0)).join('|');
        if (jobsEl.dataset.sig !== sig) {
          jobsEl.dataset.sig = sig;
          jobsEl.innerHTML = (detail.items || []).map(it => {
            const cls = it.done ? 'done' : 'doing';
            const mark = it.done ? '✓' : '…';
            return '<div class="cs-job"><span class="cs-dot ' + cls + '"></span>' +
                   '<span>' + esc(it.kind) + ' ' + mark + '</span></div>';
          }).join('');
        }
        jobsEl.style.display = '';
      } else {
        jobsEl.style.display = 'none';
      }
    }

    // 4. 进度条（队列优先）
    if (barEl) {
      let pct = 0;
      if (q.length) {
        pct = Math.round(q.filter(t => t.done === true).length / q.length * 100);
      } else if (detail && detail.total > 0) {
        pct = Math.round(detail.done / detail.total * 100);
      } else if (d.videoPercent > 0 && d.videoPercent < 1) {
        pct = Math.round(d.videoPercent * 100);
      } else if (d.status && /✓|全部完成/.test(d.status)) {
        pct = 100;
      }
      barEl.style.width = pct + '%';
    }
  }

  /**
   * 把配置回填到控件
   *
   * 单独抽出来是因为：面板可能先挂载、后拿到配置
   * （脚本版 boot 是异步读 GM 存储的），
   * 挂载时立刻回填会填到默认值上。
   */
  function fillCfg(cfg) {
    if (!_box) return;
    const a = (cfg && cfg.auto) || {};
    const el = s => _box.querySelector(s);
    el('#cs-rate').value = a.rate != null ? a.rate : 2;
    el('#cs-mute').checked = !!a.mute;
    el('#cs-next').checked = !!a.autoNext;
    el('#cs-doc').checked = !!a.docAutoScroll;
    el('#cs-quiz').checked = !!a.quizEnabled;
  }

  /** 面板是否已挂载 */
  function isMounted() {
    return !!(_box && document.documentElement.contains(_box));
  }

  /** 取面板根节点（测试用） */
  function el() { return _box; }

  root.CSPanel = { mount, render, fillCfg, isMounted, el, buildCss, buildHtml };
})(typeof globalThis !== 'undefined' ? globalThis : self);


/* ============================================================================
 * src/ui/settings.js
 * ============================================================================ */

/**
 * UI · 设置弹窗（脚本版专用）
 *
 * 扩展有独立的设置页 options.html；油猴脚本没有，
 * 只能自己在页面里造一个。字段与扩展设置页对齐（同一份配置结构），
 * 视觉复用 CSTheme 令牌，与悬浮面板一致。
 *
 * 依赖：CSTheme（ui/theme.js）、CSPanel 不需要、CSCore（core/api.js，用于测试连通）
 */
(function (root) {
  'use strict';

  if (root.CSSettings) return;

  const T = root.CSTheme;
  if (!T) throw new Error('theme.js 必须先加载');

  const C = T.color;

  /* ============================================================
   * 1. 样式
   * ============================================================ */

  function buildCss() {
    return T.cssVars('#cs-settings-mask') + `
    #cs-settings-mask{position:fixed;inset:0;z-index:2147483646;
      background:rgba(15,23,42,.45);display:flex;align-items:center;
      justify-content:center;backdrop-filter:blur(2px);
      font:14px/1.5 var(--cs-font);color:${C.ink}}
    #cs-settings{width:600px;max-width:94vw;max-height:86vh;box-sizing:border-box;
      background:${C.white};border-radius:${T.radius.card}px;
      box-shadow:${T.shadowStrong};display:flex;flex-direction:column;
      overflow:hidden}

    /* 头部 */
    #cs-settings .st-head{display:flex;align-items:center;
      padding:15px 18px 13px;border-bottom:1px solid ${C.line}}
    #cs-settings .st-title{flex:1;font-size:16px;font-weight:600;
      background:${T.grad.brand};-webkit-background-clip:text;
      background-clip:text;-webkit-text-fill-color:transparent}
    #cs-settings .st-close{width:24px;height:24px;display:flex;
      align-items:center;justify-content:center;border-radius:6px;
      color:${C.disabled};cursor:pointer;font-size:14px;line-height:1}
    #cs-settings .st-close:hover{background:${C.hover};color:${C.ink2}}

    /* 主体 */
    #cs-settings .st-body{padding:4px 18px 10px;overflow:auto;flex:1}
    #cs-settings .st-sec{margin-top:16px}
    #cs-settings .st-sec-title{display:flex;align-items:center;gap:7px;
      font-size:13px;font-weight:600;color:${C.ink};margin-bottom:11px}
    #cs-settings .st-sec-title:before{content:"";width:3px;height:14px;
      border-radius:2px;background:${T.grad.brand}}

    #cs-settings .st-field{display:flex;align-items:center;margin-bottom:11px}
    #cs-settings .st-field > label{flex:0 0 104px;color:${C.ink2};
      font-size:13px}
    #cs-settings .st-ctl{flex:1;display:flex;align-items:center;gap:7px;
      min-width:0}

    #cs-settings input[type=text],
    #cs-settings input[type=password],
    #cs-settings input[type=number],
    #cs-settings select,
    #cs-settings textarea{flex:1;min-width:0;box-sizing:border-box;
      height:30px;padding:0 9px;font-size:13px;
      border:1px solid ${C.line};border-radius:${T.radius.sm}px;
      background:${C.white};color:${C.ink};outline:none;
      font-family:inherit;transition:.15s}
    #cs-settings textarea{height:auto;min-height:64px;padding:7px 9px;
      resize:vertical;font:12px/1.5 ui-monospace,Consolas,monospace}
    #cs-settings input:focus,#cs-settings select:focus,
    #cs-settings textarea:focus{border-color:${C.primary};
      box-shadow:0 0 0 3px rgba(45,108,223,.12)}
    #cs-settings input::placeholder{color:${C.disabled}}
    #cs-settings input[type=number]{flex:0 0 96px;text-align:center}
    #cs-settings select{appearance:none;cursor:pointer;padding-right:28px;
      background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%238b949e' stroke-width='1.6' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
      background-repeat:no-repeat;background-position:right 9px center}

    /* 开关 */
    #cs-settings .st-switch{position:relative;display:inline-block;
      width:${T.size.switchW}px;height:${T.size.switchH}px;flex:0 0 auto}
    #cs-settings .st-switch input{opacity:0;width:0;height:0}
    #cs-settings .st-switch .track{position:absolute;inset:0;
      background:${C.switchOff};border-radius:${T.radius.pill}px;
      transition:.2s;cursor:pointer}
    #cs-settings .st-switch .track:before{content:"";position:absolute;
      width:${T.size.thumb}px;height:${T.size.thumb}px;left:2px;top:2px;
      background:${C.white};border-radius:50%;transition:.2s;
      box-shadow:0 1px 3px rgba(0,0,0,.2)}
    #cs-settings .st-switch input:checked + .track{background:${C.primary}}
    #cs-settings .st-switch input:checked + .track:before{transform:translateX(16px)}

    /* 小按钮 */
    #cs-settings .st-mini{box-sizing:border-box;height:30px;padding:0 12px;
      font-size:13px;font-family:inherit;white-space:nowrap;
      border:1px solid ${C.line};border-radius:${T.radius.sm}px;
      background:${C.white};color:${C.ink};cursor:pointer;transition:.15s}
    #cs-settings .st-mini:hover{background:${C.hover}}
    #cs-settings .st-mini:disabled{opacity:.55;cursor:not-allowed}

    /* 提示 */
    #cs-settings .st-hint{font-size:12px;color:${C.ink3};line-height:1.6;
      margin:-4px 0 10px 104px}
    #cs-settings .st-msg{font-size:12.5px;margin-top:9px;padding:8px 11px;
      border-radius:${T.radius.sm}px;display:none;line-height:1.6}
    #cs-settings .st-msg.show{display:block}
    #cs-settings .st-msg.ok{background:var(--cs-msg-ok-bg);color:var(--cs-msg-ok-fg)}
    #cs-settings .st-msg.err{background:var(--cs-msg-err-bg);color:var(--cs-msg-err-fg)}
    #cs-settings .st-msg.info{background:var(--cs-msg-info-bg);color:var(--cs-msg-info-fg)}

    /* 底部 */
    #cs-settings .st-foot{display:flex;align-items:center;gap:8px;
      padding:12px 18px;border-top:1px solid ${C.line};background:${C.hover}}
    #cs-settings .st-foot .spacer{flex:1}
    #cs-settings .st-btn{box-sizing:border-box;height:32px;padding:0 16px;
      font-size:14px;font-family:inherit;border-radius:${T.radius.sm}px;
      border:1px solid ${C.line};background:${C.white};color:${C.ink};
      cursor:pointer;transition:.15s}
    #cs-settings .st-btn:hover{background:${C.hover}}
    #cs-settings .st-btn.primary{background:${T.grad.brand};color:${C.white};
      border-color:transparent;font-weight:600}
    #cs-settings .st-btn.primary:hover{opacity:.9}

    @media (prefers-reduced-motion:reduce){
      #cs-settings *{transition:none!important}
    }
    `;
  }

  /* ============================================================
   * 2. 表单结构
   * ============================================================ */

  function field(label, ctl) {
    return '<div class="st-field"><label>' + label + '</label>' +
           '<div class="st-ctl">' + ctl + '</div></div>';
  }
  function sw(id) {
    return '<label class="st-switch"><input type="checkbox" id="' + id +
           '"><span class="track"></span></label>';
  }

  function buildHtml() {
    return `
      <div class="st-head">
        <span class="st-title">学习通助手 · 设置</span>
        <span class="st-close" id="st-close">✕</span>
      </div>
      <div class="st-body">

        <div class="st-sec">
          <div class="st-sec-title">答题 API</div>
          ${field('接口地址', '<input type="text" id="st-endpoint" placeholder="https://api.deepseek.com/v1/chat/completions">')}
          ${field('API Key', '<input type="password" id="st-apiKey" placeholder="sk-...">')}
          ${field('模型', '<input type="text" id="st-model" placeholder="deepseek-chat">' +
                          '<button class="st-mini" id="st-btnModels">拉取</button>')}
          ${field('温度', '<input type="number" id="st-temperature" step="0.1" min="0" max="2">' +
                          '<button class="st-mini" id="st-btnTest">测试连通</button>')}
          <div class="st-msg" id="st-apiMsg"></div>
        </div>

        <div class="st-sec">
          <div class="st-sec-title">视觉 / 截图兜底</div>
          ${field('启用视觉', sw('st-visionEnabled'))}
          ${field('判断模式', '<select id="st-visionMode">' +
            '<option value="auto">自动（文本不可靠时截图）</option>' +
            '<option value="always">总是用视觉</option>' +
            '<option value="off">关闭</option></select>')}
          ${field('视觉模型', '<input type="text" id="st-visionModel" placeholder="如 gpt-4o / qwen-vl-max">')}
          <div class="st-hint">脚本版拿不到真实截图，会自动降级为「文字重绘」，精度低于扩展版。</div>
        </div>

        <div class="st-sec">
          <div class="st-sec-title">做题行为</div>
          ${field('自动作答', sw('st-quizEnabled'))}
          ${field('自动提交', sw('st-autoSubmit'))}
          <div class="st-hint">默认关闭。有题没把握会暂存答案并提示你自查，不会硬交。</div>
          ${field('最低停留(秒)', '<input type="number" id="st-minDwell" min="0" max="120" step="1">')}
        </div>

        <div class="st-sec">
          <div class="st-sec-title">刷课行为</div>
          ${field('播放倍速', '<input type="number" id="st-rate" step="0.25" min="1" max="4">')}
          ${field('静音播放', sw('st-mute'))}
          ${field('自动下一节', sw('st-autoNext'))}
          ${field('文档滚动', sw('st-docAutoScroll'))}
          ${field('防切屏暂停', sw('st-antiPause'))}
          ${field('调试日志', sw('st-debug'))}
        </div>

      </div>
      <div class="st-foot">
        <button class="st-mini" id="st-btnReset">恢复默认</button>
        <span class="spacer"></span>
        <button class="st-btn" id="st-btnCancel">取消</button>
        <button class="st-btn primary" id="st-btnSave">保存</button>
      </div>`;
  }

  /* ============================================================
   * 3. 状态
   * ============================================================ */

  let _mask = null;
  let _opts = null;

  const $ = (s) => { try { return _mask.querySelector(s); } catch { return null; } };

  function setMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text;
    el.className = 'st-msg' + (text ? ' show ' + (kind || 'info') : '');
  }

  /* ============================================================
   * 4. 回填与收集
   * ============================================================ */

  function fillForm(cfg) {
    const q = (cfg && cfg.quiz) || {};
    const v = (cfg && cfg.vision) || {};
    const a = (cfg && cfg.auto) || {};

    $('#st-endpoint').value = q.endpoint || '';
    $('#st-apiKey').value = q.apiKey || '';
    $('#st-model').value = q.model || '';
    $('#st-temperature').value = q.temperature != null ? q.temperature : 0.2;

    $('#st-visionEnabled').checked = v.enabled !== false;
    $('#st-visionMode').value = v.mode || 'auto';
    $('#st-visionModel').value = v.model || '';

    $('#st-quizEnabled').checked = a.quizEnabled !== false;
    $('#st-autoSubmit').checked = !!q.autoSubmit;
    $('#st-minDwell').value = a.minDwellSeconds != null ? a.minDwellSeconds : 5;

    $('#st-rate').value = a.rate != null ? a.rate : 2;
    $('#st-mute').checked = a.mute !== false;
    $('#st-autoNext').checked = a.autoNext !== false;
    $('#st-docAutoScroll').checked = a.docAutoScroll !== false;
    $('#st-antiPause').checked = a.antiPause !== false;
    $('#st-debug').checked = a.debug !== false;
  }

  /** 只取 quiz + vision 片段（测试连通时用，不保存） */
  function formQuizVision() {
    const base = (_opts.getCfg && _opts.getCfg()) || {};
    return {
      quiz: {
        ...(base.quiz || {}),
        endpoint: $('#st-endpoint').value.trim(),
        apiKey: $('#st-apiKey').value.trim(),
        model: $('#st-model').value.trim(),
        temperature: parseFloat($('#st-temperature').value) || 0.2
      },
      vision: {
        ...(base.vision || {}),
        enabled: $('#st-visionEnabled').checked,
        mode: $('#st-visionMode').value,
        model: $('#st-visionModel').value.trim()
      }
    };
  }

  function collectForm() {
    const base = JSON.parse(JSON.stringify((_opts.getCfg && _opts.getCfg()) || {}));
    const f = formQuizVision();
    f.quiz.autoSubmit = $('#st-autoSubmit').checked;
    f.quiz.autoFill = true;
    return {
      ...base,
      quiz: f.quiz,
      vision: f.vision,
      auto: {
        ...(base.auto || {}),
        rate: parseFloat($('#st-rate').value) || 2,
        mute: $('#st-mute').checked,
        autoNext: $('#st-autoNext').checked,
        docAutoScroll: $('#st-docAutoScroll').checked,
        antiPause: $('#st-antiPause').checked,
        debug: $('#st-debug').checked,
        quizEnabled: $('#st-quizEnabled').checked,
        minDwellSeconds: parseInt($('#st-minDwell').value, 10) || 0
      }
    };
  }

  /* ============================================================
   * 5. 打开 / 关闭
   * ============================================================ */

  function close() {
    if (_mask && _mask.parentNode) _mask.parentNode.removeChild(_mask);
    _mask = null;
  }

  /**
   * 打开设置弹窗
   * @param {object} opts { getCfg(), setCfg(patch), onSaved(cfg) }
   */
  function open(opts) {
    _opts = opts || {};
    if (_mask) return _mask;

    if (!document.getElementById('cs-settings-style')) {
      const st = document.createElement('style');
      st.id = 'cs-settings-style';
      st.textContent = buildCss();
      document.documentElement.appendChild(st);
    }

    const mask = document.createElement('div');
    mask.id = 'cs-settings-mask';
    mask.innerHTML = '<div id="cs-settings">' + buildHtml() + '</div>';
    document.documentElement.appendChild(mask);
    _mask = mask;

    fillForm((_opts.getCfg && _opts.getCfg()) || {});

    // ---- 关闭 ----
    $('#st-close').onclick = close;
    $('#st-btnCancel').onclick = close;
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });

    // ---- 拉取模型 ----
    $('#st-btnModels').onclick = async () => {
      const btn = $('#st-btnModels');
      const msg = $('#st-apiMsg');
      btn.disabled = true;
      setMsg(msg, '拉取中…', 'info');
      try {
        const CS = root.CSCore;
        const merged = CS.config.mergeDefaults({ ...((_opts.getCfg && _opts.getCfg()) || {}), ...formQuizVision() });
        const r = await CS.api.fetchModels(merged);
        setMsg(msg, '✅ 拉到 ' + r.count + ' 个模型（' + r.url + '）', 'ok');
        if (!r.models.length) return;
        // 没填模型就挑一个像样的
        const inp = $('#st-model');
        if (!inp.value.trim()) {
          inp.value = r.models.find(m => /(gpt-4o-mini|gpt-4o|deepseek-chat|qwen-plus)/i.test(m)) || r.models[0];
        }
      } catch (e) {
        setMsg(msg, '❌ 拉取失败：' + (e.message || e), 'err');
      } finally {
        btn.disabled = false;
      }
    };

    // ---- 测试连通 ----
    $('#st-btnTest').onclick = async () => {
      const btn = $('#st-btnTest');
      const msg = $('#st-apiMsg');
      btn.disabled = true;
      setMsg(msg, '测试中…', 'info');
      try {
        const CS = root.CSCore;
        const merged = CS.config.mergeDefaults({ ...((_opts.getCfg && _opts.getCfg()) || {}), ...formQuizVision() });
        const r = await CS.api.testConnection(merged);
        setMsg(msg, '✅ 连通正常（' + r.ms + 'ms，模型回显 ' + (r.model || '-') + '）', 'ok');
      } catch (e) {
        setMsg(msg, '❌ ' + (e.message || e), 'err');
      } finally {
        btn.disabled = false;
      }
    };

    // ---- 恢复默认 ----
    $('#st-btnReset').onclick = () => {
      const CS = root.CSCore;
      fillForm(CS.config.mergeDefaults({}));
      setMsg($('#st-apiMsg'), '已填入默认值，点「保存」才生效', 'info');
    };

    // ---- 保存 ----
    $('#st-btnSave').onclick = async () => {
      const btn = $('#st-btnSave');
      const msg = $('#st-apiMsg');
      const cfg = collectForm();

      // 校验：自定义模板/请求头必须是合法 JSON（这里先只校验基础项）
      if (!cfg.quiz.endpoint) {
        setMsg(msg, '请填写接口地址', 'err');
        return;
      }

      btn.disabled = true;
      try {
        if (_opts.setCfg) await _opts.setCfg(cfg);
        if (_opts.onSaved) _opts.onSaved(cfg);
        setMsg(msg, '✅ 已保存', 'ok');
        setTimeout(close, 600);
      } catch (e) {
        setMsg(msg, '❌ 保存失败：' + (e.message || e), 'err');
        btn.disabled = false;
      }
    };

    // 快捷键：Esc 关闭
    const onKey = (e) => { if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(); } };
    document.addEventListener('keydown', onKey);

    return mask;
  }

  root.CSSettings = { open, close, isOpen: () => !!_mask, buildCss, buildHtml };
})(typeof globalThis !== 'undefined' ? globalThis : self);


/* ============================================================================
 * src/content/fontdecoder.js
 * ============================================================================ */

/**
 * 字体反爬解码器（学习通题干/选项专用）
 *
 * ── 原理 ──────────────────────────────────────────────
 * 学习通把题干正文替换成生僻字码位（如「忞忖忟命」），再通过
 * @font-face 加载自定义字体，把那些码位渲染成正常汉字的字形。
 * 因此 DOM 里读到的是错字，只有「渲染出来的形状」才是对的。
 *
 * ── 做法 ──────────────────────────────────────────────
 *  1. 找出题干元素实际使用的自定义字体
 *  2. 下载字体 → FontFace 注册 → 用它把混淆字符渲染成位图
 *  3. 用系统中文字体渲染候选字做参照
 *  4. 比对墨迹分布，取最相似的字
 *
 * ── 精度设计 ──────────────────────────────────────────
 * 分辨率是精度的命门。12×12 网格分不清「要/置」「帝/带」这类
 * 形近字，本实现用 28×28（784 维）。
 *
 * 匹配分两级：
 *   一级：高频字表（~500 字）× 高分辨率 → 秒出结果
 *   二级：仅对一级得分偏低的字，流式扫描 CJK 基本区 2 万字
 *        （不预存全部特征，边渲染边比，内存占用恒定）
 *
 * ── 性能设计 ──────────────────────────────────────────
 * 所有字一次性画到同一张画布（网格排布），只 getImageData 一次，
 * 再按格子切片。比逐字 createCanvas + getImageData 快约 30 倍。
 */

'use strict';

var CSFontDecoder = (function () {

  /* ============================================================
   * 1. 字体探测
   * ============================================================ */

  function collectFontFaces(doc) {
    const out = [];
    let sheets = [];
    try { sheets = [...doc.styleSheets]; } catch { return out; }

    for (const sheet of sheets) {
      let rules = [];
      try { rules = [...sheet.cssRules]; } catch { continue; } // 跨域表跳过
      for (const r of rules) {
        if (!r || r.type !== CSSRule.FONT_FACE_RULE) continue;

        const family = (r.style.fontFamily || '').replace(/^["']|["']$/g, '').trim();
        if (!family) continue;

        // 读 src 的可靠方式：
        // getPropertyValue('src') 对 data-URI 常返回空（分号截断），
        // 必须退回 cssText 里抓。
        let src = r.style.getPropertyValue('src') || '';
        if (!src) {
          const m = (r.cssText || '').match(/src\s*:\s*(.+?)(?:unicode-range|font-display|font-weight|font-style|$)/i);
          if (m) src = m[1];
        }

        out.push({
          family,
          src: src.trim(),
          cssText: r.cssText || '',
          unicodeRange: r.style.getPropertyValue('unicode-range') || ''
        });
      }
    }
    return out;
  }

  function extractFontUrl(src) {
    if (!src) return null;
    const m = src.match(/url\(\s*["']?([^"')]+)["']?\s*\)/i);
    if (!m) return null;
    const u = m[1].trim();
    if (/^data:/i.test(u)) return u;
    try { return new URL(u, location.href).href; } catch { return u; }
  }

  const SYSTEM_FONT = /^(system-ui|sans-serif|serif|monospace|-apple-system|BlinkMacSystemFont|Microsoft YaHei|微软雅黑|SimSun|宋体|SimHei|黑体|PingFang SC|Arial|Helvetica|Segoe UI|Tahoma|Verdana|Roboto|Noto Sans SC|inherit|initial|unset|serif)$/i;

  function suspiciousFaces(doc) {
    return collectFontFaces(doc)
      .filter(f => !SYSTEM_FONT.test(f.family))
      .map(f => ({ ...f, url: extractFontUrl(f.src) }))
      .filter(f => f.url);
  }

  /** 找元素最终生效的自定义字体 */
  function fontOf(el) {
    if (!el) return null;
    const doc = el.ownerDocument || document;
    const faces = suspiciousFaces(doc);
    if (!faces.length) return null;

    let fam = '';
    try { fam = getComputedStyle(el).fontFamily || ''; } catch { /* ignore */ }

    const names = fam.split(',').map(s => s.trim().replace(/^["']|["']$/g, '').toLowerCase());

    for (const n of names) {
      const hit = faces.find(f => f.family.toLowerCase() === n);
      if (hit) return hit;
    }
    for (const f of faces) {
      if (fam.toLowerCase().includes(f.family.toLowerCase())) return f;
    }
    return faces[0];
  }

  /* ============================================================
   * 2. 渲染与特征
   * ============================================================ */

  const CELL = 56;   // 单字格子边长(px)
  const GRID = 28;   // 网格 28x28 = 784 维
  const COLS = 32;   // 画布每行几个字
  const BATCH = COLS * 32;   // 每次渲染 1024 字

  /**
   * 渲染一批字符，返回 Map<字符, Float32Array|null>
   * null 表示该字体缺这个字形（渲染成空白）
   */
  function renderBatch(family, chars, out) {
    const n = chars.length;
    if (!n) return;

    // 关键：画布宽度固定，每个字的位置完全由索引决定。
    // 只要同一字符在两次渲染中出现的位置不同（比如一次在
    // 33 位、一次在 900 位），亚像素抗锯齿就会不同，
    // 导致同源字体自匹配从 1.0 掉到 0.93，进而误判。
    // 解决：保持位置一致 —— 每批都从索引 0 开始排。
    const rows = Math.ceil(n / COLS);
    const W = COLS * CELL;
    const H = rows * CELL;

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.font = Math.round(CELL * 0.76) + 'px "' + family + '"';

    for (let i = 0; i < n; i++) {
      const cx = (i % COLS) * CELL + CELL / 2;
      const cy = Math.floor(i / COLS) * CELL + CELL / 2;
      ctx.fillText(chars[i], cx, cy);
    }

    let img;
    try { img = ctx.getImageData(0, 0, W, H); }
    catch { return; }
    const data = img.data;
    const cw = CELL / GRID;

    for (let i = 0; i < n; i++) {
      const ox = (i % COLS) * CELL;
      const oy = Math.floor(i / COLS) * CELL;

      // ── 步骤1：取出该格子的原始墨量图 ──
      const raw = new Float32Array(CELL * CELL);
      let totalInk = 0;
      for (let y = 0; y < CELL; y++) {
        const rowBase = (oy + y) * W + ox;
        for (let x = 0; x < CELL; x++) {
          const v = 1 - data[(rowBase + x) * 4] / 255;
          raw[y * CELL + x] = v;
          totalInk += v;
        }
      }
      if (totalInk < 1) { out.set(chars[i], null); continue; }

      // ── 步骤2：找墨迹包围盒 ──
      // 消除位置/留白差异：同一字符无论画在格子哪个位置，
      // 裁到墨迹边界后重采样，结果都一致。
      let minX = CELL, maxX = -1, minY = CELL, maxY = -1;
      for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
          if (raw[y * CELL + x] > 0.06) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < minX || maxY < minY) { out.set(chars[i], null); continue; }

      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;

      // ── 步骤3：按包围盒等比缩放到 GRID×GRID ──
      // 必须保持宽高比！
      // 若强行拉伸填满正方形，「问」的「口」会被压扁，
      // 结果和「门」几乎一样 —— 这正是之前把「问」认成「门」的原因。
      // 等比缩放 + 居中留白，部件的大小与相对位置才得以保留。
      const scale = Math.max(bw, bh);
      const padX = (scale - bw) / 2;
      const padY = (scale - bh) / 2;

      const vec = new Float32Array(GRID * GRID);
      for (let v = 0; v < GRID; v++) {
        for (let u = 0; u < GRID; u++) {
          // 这个格子在"正方形化"坐标系中的范围
          const fx0 = u / GRID, fx1 = (u + 1) / GRID;
          const fy0 = v / GRID, fy1 = (v + 1) / GRID;

          let sum = 0, cnt = 0;
          // 在该格子内采样 3x3 个点，做面积平均
          const S = 3;
          for (let sy = 0; sy < S; sy++) {
            const fy = fy0 + (fy1 - fy0) * ((sy + 0.5) / S);
            const py = Math.floor(minY - padY + fy * scale);
            if (py < 0 || py >= CELL) continue;
            for (let sx = 0; sx < S; sx++) {
              const fx = fx0 + (fx1 - fx0) * ((sx + 0.5) / S);
              const px = Math.floor(minX - padX + fx * scale);
              if (px < 0 || px >= CELL) continue;
              sum += raw[py * CELL + px];
              cnt++;
            }
          }
          vec[v * GRID + u] = cnt ? sum / cnt : 0;
        }
      }
      out.set(chars[i], vec);
    }
  }

  /** 渲染任意字符集（自动分批） */
  function renderFeatures(family, chars) {
    const out = new Map();
    for (let i = 0; i < chars.length; i += BATCH) {
      renderBatch(family, chars.slice(i, i + BATCH), out);
    }
    return out;
  }

  /** 余弦相似度 */
  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
    }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  /**
   * 字形归一化：笔画骨架提取
   *
   * 为什么必须做：实测同一字在不同字体间余弦相似度只有 0.32~0.81
   * （SimHei 与 Microsoft YaHei 仅 0.44），而同字体是 1.0。
   * 字体风格差异远大于字与字的差异，直接比对必然失准。
   *
   * 对策：把「墨量图」转成「骨架图」
   *   1. 二值化：只关心有没有笔画，不关心粗细
   *   2. 轻度模糊：抹掉衬线、笔画末端等字体特有细节
   *   3. 保留结构：横竖撇捺的排布才是字的身份
   */
  function normalizeVec(vec, grid) {
    const n = vec.length;

    // 1) 二值化——消除笔画粗细差异
    let sum = 0;
    for (let i = 0; i < n; i++) sum += vec[i];
    const mean = sum / n;
    const thr = Math.max(mean * 0.55, 0.02);

    const bin = new Float32Array(n);
    for (let i = 0; i < n; i++) bin[i] = vec[i] > thr ? 1 : 0;

    // 2) 3x3 均值模糊——抹掉字体细节，保留结构
    const out = new Float32Array(n);
    for (let y = 0; y < grid; y++) {
      for (let x = 0; x < grid; x++) {
        let acc = 0, cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= grid) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= grid) continue;
            acc += bin[ny * grid + nx];
            cnt++;
          }
        }
        out[y * grid + x] = cnt ? acc / cnt : 0;
      }
    }
    return out;
  }

  /* ============================================================
   * 3. 候选字库
   * ============================================================ */

  /**
   * 一级字库
   *
   * 为什么必须足够大：实测同源字体自匹配 = 1.0，
   * 只要真字在这个表里，就一定能被 100% 正确认出。
   * 反过来，表里没有的字会退到"全量搜索"，
   * 那一步是逐码位比对，容易被形近字干扰。
   *
   * 所以这里尽量覆盖：GB2312 一级字（3755 个常用字）
   * 结合思政教材用词。全量约 2000 字，单次建库耗时可控。
   */
  const FREQ_CHARS = (
    // ===== 最常用字（先放，确保一定覆盖）=====
    '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严龙飞' +
    // ===== 判断题/选择题常用动词与名词 =====
    '题目答案选择判断填空正确错误以下哪项属于不是关于说法理解分析简答论述材料阅读请根据要求回答下列各' +
    '首要对象革命动力性质特点意义作用影响原因结果目的任务内容方式方法途径条件前提基础核心关键重点难点' +
    '时期阶段过程历史现状未来发展趋势规律经验教训启示认识实践理论观点立场态度看法主张意见建议措施' +
    '增加减少提高降低促进推动阻碍限制影响改变形成产生出现存在具有包含包括分为组成构成建立实现完成' +
    '必须应当可以可能能够需要必要充分主要重要基本根本直接间接明显显著突出严重轻微普遍特殊一般共同' +
    // ===== GB2312 常用字（拼音序）=====
    '啊阿埃挨哎唉哀皑癌蔼矮艾碍爱隘鞍氨安俺按暗岸胺案肮昂盎凹敖熬翱袄傲奥懊澳芭捌扒叭吧笆八疤巴拔跋靶把耙坝霸罢爸白柏百摆佰败拜稗斑班搬扳般颁板版扮拌伴瓣半办绊邦帮梆榜膀绑棒磅蚌镑傍谤苞胞包褒剥' +
    '薄雹保堡饱宝抱报暴豹鲍爆杯碑悲卑北辈背贝钡倍狈备惫焙被奔苯本笨崩绷甭泵蹦迸逼鼻比鄙笔彼碧蓖蔽毕毙毖币庇痹闭敝弊必辟壁臂避陛鞭边编贬扁便变卞辨辩辫遍标彪膘表鳖憋别瘪彬斌濒滨宾摈兵冰柄丙秉饼炳' +
    '病并玻菠播拨钵波博勃搏铂箔伯帛舶脖膊渤泊驳捕卜哺补埠不布步簿部怖擦猜裁材才财睬踩采彩菜蔡餐参蚕残惭惨灿苍舱仓沧藏操糙槽曹草厕策侧册测层蹭插叉茬茶查碴搽察岔差诧拆柴豺搀掺蝉馋谗缠铲产阐颤昌猖' +
    '场尝常长偿肠厂敞畅唱倡超抄钞朝嘲潮巢吵炒车扯撤掣彻澈郴臣辰尘晨忱沉陈趁衬撑称城橙成呈乘程惩澄诚承逞骋秤吃痴持匙池迟弛驰耻齿侈尺赤翅斥炽充冲虫崇宠抽酬畴踌稠愁筹仇绸瞅丑臭初出橱厨躇锄雏滁除楚' +
    '础储矗搐触处揣川穿椽传船喘串疮窗幢床闯创吹炊捶锤垂春椿醇唇淳纯蠢戳绰疵茨磁雌辞慈瓷词此刺赐次聪葱囱匆从丛凑粗醋簇促蹿篡窜摧崔催脆瘁粹淬翠村存寸磋撮搓措挫错搭达答瘩打大呆歹傣戴带殆代贷袋待逮' +
    '怠耽担丹单郸掸胆旦氮但惮淡诞弹蛋当挡党荡档刀捣蹈倒岛祷导到稻悼道盗德得的蹬灯登等瞪凳邓堤低滴迪敌笛狄涤翟嫡抵底地蒂第帝弟递缔颠掂滇碘点典靛垫电佃甸店惦奠淀殿碉叼雕凋刁掉吊钓调跌爹碟蝶迭谍叠' +
    '丁盯叮钉顶鼎锭定订丢东冬董懂动栋侗恫冻洞兜抖斗陡豆逗痘都督毒犊独读堵睹赌杜镀肚度渡妒端短锻段断缎堆兑队对墩吨蹲敦顿囤钝盾遁掇哆多夺垛躲朵跺舵剁惰堕蛾峨鹅俄额讹娥恶厄扼遏鄂饿恩而儿耳尔饵洱二' +
    '贰发罚筏伐乏阀法珐藩帆番翻樊矾钒繁凡烦反返范贩犯饭泛坊芳方肪房防妨仿访纺放菲非啡飞肥匪诽吠肺废沸费芬酚吩氛分纷坟焚汾粉奋份忿愤粪丰封枫蜂峰锋风疯烽逢冯缝讽奉凤佛否夫敷肤孵扶拂辐幅氟符伏俘服' +
    '浮涪福袱弗甫抚辅俯釜斧脯腑府腐赴副覆赋复傅付阜父腹负富讣附妇缚咐噶嘎该改概钙盖溉干甘杆柑竿肝赶感秆敢赣冈刚钢缸肛纲岗港杠篙皋高膏羔糕搞镐稿告哥歌搁戈鸽胳疙割革葛格蛤阁隔铬个各给根跟耕更庚羹' +
    '埂耿梗工攻功恭龚供躬公宫弓巩汞拱贡共钩勾沟苟狗垢构购够辜菇咕箍估沽孤姑鼓古蛊骨谷股故顾固雇刮瓜剐寡挂褂乖拐怪棺关官冠观管馆罐惯灌贯光广逛瑰规圭硅归龟闺轨鬼诡癸桂柜跪贵刽辊滚棍锅郭国果裹过哈' +
    '骸孩海氦亥害骇酣憨邯韩含涵寒函喊罕翰撼捍旱憾悍焊汗汉夯杭航壕嚎豪毫郝好耗号浩呵喝荷菏核禾和何合盒貉阂河涸赫褐鹤贺嘿黑痕很狠恨哼亨横衡恒轰哄烘虹鸿洪宏弘红喉侯猴吼厚候后呼乎忽瑚壶葫胡蝴狐糊湖' +
    '弧虎唬护互沪户花哗华猾滑画划化话槐徊怀淮坏欢环桓还缓换患唤痪豢焕涣宦幻荒慌黄磺蝗簧皇凰惶煌晃幌恍谎灰挥辉徽恢蛔回毁悔慧卉惠晦贿秽会烩汇讳诲绘荤昏婚魂浑混豁活伙火获或惑霍货祸击圾基机畸稽积箕' +
    '肌饥迹激讥鸡姬绩缉吉极棘辑籍集及急疾汲即嫉级挤几脊己蓟技冀季伎祭剂悸济寄寂计记既忌际妓继纪嘉枷夹佳家加荚颊贾甲钾假稼价架驾嫁歼监坚尖笺间煎兼肩艰奸缄茧检柬碱硷拣捡简俭剪减荐槛鉴践贱见键箭件' +
    '健舰剑饯渐溅涧建僵姜将浆江疆蒋桨奖讲匠酱降蕉椒礁焦胶交郊浇骄娇嚼搅铰矫侥脚狡角饺缴绞剿教酵轿较叫窖揭接皆秸街阶截劫节桔杰捷睫竭洁结解姐戒藉芥界借介疥诫届巾筋斤金今津襟紧锦仅谨进靳晋禁近烬浸' +
    '尽劲荆兢茎睛晶鲸京惊精粳经井警景颈静境敬镜径痉靖竟竞净炯窘揪究纠玖韭久灸九酒厩救旧臼舅咎就疚鞠拘狙疽居驹菊局咀矩举沮聚拒据巨具距踞锯俱句惧炬剧捐鹃娟倦眷卷绢撅攫抉掘倔爵觉决诀绝均菌钧军君峻' +
    '俊竣浚郡骏喀咖卡咯开揩楷凯慨刊堪勘坎砍看康慷糠扛抗亢炕考拷烤靠坷苛柯棵磕颗科壳咳可渴克刻客课肯啃垦恳坑吭空恐孔控抠口扣寇枯哭窟苦酷库裤夸垮挎跨胯块筷侩快宽款匡筐狂框矿眶旷况亏盔岿窥葵奎魁傀' +
    '馈愧溃坤昆捆困括扩廓阔垃拉喇蜡腊辣啦莱来赖蓝婪栏拦篮阑兰澜谰揽览懒缆烂滥琅榔狼廊郎朗浪捞劳牢老佬姥酪烙涝勒乐雷镭蕾磊累儡垒擂肋类泪棱楞冷厘梨犁黎篱狸离漓理李里鲤礼莉荔吏栗丽厉励砾历利傈例俐' +
    '痢立粒沥隶力璃哩俩联莲连镰廉怜涟帘敛脸链恋炼练粮凉梁粱良两辆量晾亮谅撩聊僚疗燎寥辽潦了撂镣廖料列裂烈劣猎琳林磷霖临邻鳞淋凛赁吝拎玲菱零龄铃伶羚凌灵陵岭领另令溜琉榴硫馏留刘瘤流柳六龙聋咙笼窿' +
    '隆垄拢陇楼娄搂篓漏陋芦卢颅庐炉掳卤虏鲁麓碌露路赂鹿潞禄录陆戮驴吕铝侣旅履屡缕虑氯律率滤绿峦挛孪滦卵乱掠略抡轮伦仑沦纶论萝螺罗逻锣箩骡裸落洛骆络妈麻玛码蚂马骂嘛吗埋买麦卖迈脉瞒馒蛮满蔓曼慢漫' +
    '谩芒茫盲氓忙莽猫茅锚毛矛铆卯茂冒帽貌贸么玫枚梅酶霉煤没眉媒镁每美昧寐妹媚门闷们萌蒙檬盟锰猛梦孟眯醚靡糜迷谜弥米秘觅泌蜜密幂棉眠绵冕免勉娩缅面苗描瞄藐秒渺庙妙蔑灭民抿皿敏悯闽明螟鸣铭名命谬摸' +
    '摹蘑模膜磨摩魔抹末莫墨默沫漠寞陌谋牟某拇牡亩姆母墓暮幕募慕木目睦牧穆拿哪呐钠那娜纳氖乃奶耐奈南男难囊挠脑恼闹淖呢馁内嫩能妮霓倪泥尼拟你匿腻逆溺蔫拈年碾撵捻念娘酿鸟尿捏聂孽啮镊镍涅您柠狞凝宁'
  ).split('');

  /**
   * 思政 / 近现代史 专业用字补充
   * （上面 GB2312 表里没有、但本课程高频出现的字）
   */
  const SUBJECT_CHARS = (
    '帝封建官僚剥削压迫侵略殖民半爱国统战武装斗争道路经验教训左右倾投降派军阀混战割据政权统治腐朽没落衰亡崩溃瓦解巩固壮大领导先锋组织群众路线独立自主自力更生艰苦奋斗勤俭节约改革开放市场经济计划体制公有私制分配按劳要素效率公平正义法治德治民主科学文化教育医疗卫住房就业保障社会保险福利慈善救助灾害救济贫困富裕共同现代小康目标百年步走布局战略总体五位一体全面协调绿色开放共享理念高质量供给结构侧改革一带一路人类命运共体和平合作共赢全球治理际秩序外交关系周边南南' +
    '鸦片南京辛丑马关虎门销烟甲午戊戌变法辛亥五四运共成国民革命土抗日解放过渡改造合作化公社大跃进纠正错误总结实事求是解放思想与时俱进求真务实代表观决胜复兴强军国防队港澳台侨胞祖国习近平新时代特色社会主义思想中国梦' +
    '垄断买办资本阶级民族形式特点规律本质现象矛盾辩证唯物历史唯心形而上学意识形态上层建筑经济基础生产力生产关系剩余价值商品货币市场金融危机构建和谐可持续生态文明绿色发展循环低碳清洁能源资源节约环境友好主体功能' +
    // 条约 / 时间 / 常用书面语（易漏，单列）
    '签订条约协议丧失失败独立自主地位沦为殖民地半殖民地封建社会性质巨大变化标志开始完全彻底结束推翻清算' +
    '签署缔结履行生效期满延长终止废除撤销承认批准加入退出成员资格权利利益义务责任担当使命任务目标方向路线方针政策策略' +
    '剥削阶级阶层联盟同盟阵线阵营势力范围地盘领土领空领海主权治权统治权领导权管理权所有权使用权经营权'
  ).split('');

  /** 一级字库（去重） */
  const FREQ_UNIQ = [...new Set(FREQ_CHARS.concat(SUBJECT_CHARS))];

  /** 二级：CJK 基本区全量（懒生成，仅在必要时用） */
  let ALL_CJK = null;
  function allCjk() {
    if (ALL_CJK) return ALL_CJK;
    const out = [];
    for (let c = 0x4e00; c <= 0x9fa5; c++) out.push(String.fromCharCode(c));
    ALL_CJK = out;
    return out;
  }

  /* ============================================================
   * 4. 参照字体
   * ============================================================ */

  let sysFontCache;

  /**
   * 找出一组真正能渲染中文的系统字体
   *
   * 为什么要多个：实测不同字体渲染同一个字，余弦相似度只有
   * 0.32~0.81（SimHei 与 Microsoft YaHei 仅 0.44）。
   * 反爬字体具体基于哪一款无从得知，用单字体参照必然失准。
   * 多字体取最高分，鲁棒性高得多。
   */
  function pickSystemFonts() {
    if (sysFontCache !== undefined) return sysFontCache;

    const candidates = [
      'Microsoft YaHei', 'SimHei', 'SimSun', 'KaiTi',
      'FangSong', 'PingFang SC', 'Noto Sans CJK SC',
      'Source Han Sans SC', 'Microsoft JhengHei',
      'sans-serif', 'serif'
    ];

    const probe = document.createElement('canvas');
    probe.width = 48;
    probe.height = 48;
    const c = probe.getContext('2d', { willReadFrequently: true });

    const ok = [];
    for (const fam of candidates) {
      c.fillStyle = '#fff';
      c.fillRect(0, 0, 48, 48);
      c.fillStyle = '#000';
      c.textBaseline = 'middle';
      c.textAlign = 'center';
      c.font = '38px "' + fam + '"';
      c.fillText('国', 24, 24);

      const d = c.getImageData(0, 0, 48, 48).data;
      let ink = 0;
      for (let i = 0; i < d.length; i += 4) ink += 255 - d[i];

      // 阈值：真的画出字来（不是空白/豆腐块）
      if (ink > 3000) ok.push(fam);
    }

    // 去掉渲染完全相同的重复项（如 sans-serif 与 serif 可能指向同一字体）
    sysFontCache = ok.length ? ok : null;
    return sysFontCache;
  }

  /** 兼容旧接口 */
  function pickSystemFont() {
    const list = pickSystemFonts();
    return list ? list[0] : null;
  }

  /* ============================================================
   * 5. 基础字体识别（精度关键）
   * ============================================================ */

  /**
   * 找出反爬字体派生自哪个系统字体
   *
   * ── 为什么这一步决定成败 ──────────────────────────
   * 实测数据：同一个字
   *   · 同字体渲染      余弦相似度 = 1.0000
   *   · 跨字体渲染      余弦相似度 = 0.44（SimHei vs 微软雅黑）
   *
   * 而形近字之间（要/耍、垄/重）相似度高达 0.90+
   *
   * 也就是说：跨字体差异 ≫ 形近字差异。
   * 用错参照字体，形近字必然混淆 —— 这就是「要→善」「垄→重」
   * 这类错误的根源。
   *
   * ── 怎么找出派生字体 ──────────────────────────────
   * 反爬字体通常只改了「被混淆的那批码位」，其余字符原样保留。
   * 拿一批**常见字**（中/国/的/一/是…，这些几乎不会被混淆），
   * 用反爬字体渲染，再逐一与各系统字体渲染的同一字比对：
   * 派生字体得分会接近 1，其他字体只有 0.4 左右。
   * 得分最高者即为基础字体。
   *
   * 找不到（比如字体被整体替换）时，退化为多字体投票。
   */
  const PROBE_CHARS = '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出';

  async function detectBaseFont(fontFam) {
    const families = pickSystemFonts();
    if (!families || !families.length) return null;

    const probes = PROBE_CHARS.split('');

    // 反爬字体渲染探测字
    const mineRaw = new Map();
    renderBatch(fontFam, probes, mineRaw);

    const mine = new Map();
    for (const [ch, vec] of mineRaw) {
      if (vec) mine.set(ch, vec);
    }
    if (mine.size < 4) return null;   // 探测字都画不出来，没法判断

    let bestFam = null, bestScore = -1;

    for (const fam of families) {
      const refRaw = new Map();
      renderBatch(fam, probes, refRaw);

      let sum = 0, n = 0;
      for (const [ch, vec] of mine) {
        const rv = refRaw.get(ch);
        if (!rv) continue;
        sum += cosine(vec, rv);
        n++;
      }
      if (!n) continue;

      const score = sum / n;
      if (score > bestScore) { bestScore = score; bestFam = fam; }
    }

    // 阈值：同源应 > 0.95；低于 0.80 说明这个字体跟系统字体都不是同源，
    // 此时用「最高分」仍比随便挑一个强，但标记为低置信
    return {
      family: bestFam,
      score: Number(bestScore.toFixed(4)),
      confident: bestScore > 0.90
    };
  }

  /* ============================================================
   * 6. 匹配
   * ============================================================ */

  /**
   * 多字体标准字形库（一次建好反复用）
   * 结构：[{ family, map: Map<char, Float32Array|null> }]
   */
  let stdCache = null;

  function buildStdCache(chars) {
    const families = pickSystemFonts();
    if (!families) return null;

    const arr = [];
    for (const fam of families) {
      const raw = new Map();
      renderBatch(fam, chars, raw);

      // 转成归一化特征（模糊后比对更稳）
      const norm = new Map();
      for (const [ch, vec] of raw) {
        if (!vec) continue;
        norm.set(ch, normalizeVec(vec, GRID));
      }
      if (norm.size) arr.push({ family: fam, map: norm });
    }
    return arr.length ? arr : null;
  }

  /**
   * 在候选字集中找与 target 最相似的字（跨多参照字体取最优）
   * @param {Float32Array} target  已归一化的目标特征
   * @param {string[]} chars
   * @param {Array} stds           多字体标准库
   * @param {number} maxBatches    每字体最多扫多少批
   * @returns {{ch:string, score:number, fonts:Object}}
   */
  function bestMatch(target, chars, stds, maxBatches = Infinity) {
    let bestCh = '', bestScore = -1;

    for (const std of stds) {
      let batches = 0;

      for (let i = 0; i < chars.length; i += BATCH) {
        if (batches >= maxBatches) break;
        batches++;

        const slice = chars.slice(i, i + BATCH);
        const raw = new Map();
        renderBatch(std.family, slice, raw);

        for (const [ch, vec] of raw) {
          if (!vec) continue;
          const s = cosine(target, normalizeVec(vec, GRID));
          if (s > bestScore) { bestScore = s; bestCh = ch; }
        }
      }
    }
    return { ch: bestCh, score: bestScore };
  }

  /* ============================================================
   * 6. 解码
   * ============================================================ */

  function isCJK(ch) {
    const c = ch.codePointAt(0);
    return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff);
  }

  async function loadFontBuffer(url) {
    // data URI 直接解
    if (/^data:/i.test(url)) {
      const comma = url.indexOf(',');
      const meta = url.slice(0, comma);
      const payload = url.slice(comma + 1);
      let bin;
      if (/;base64/i.test(meta)) {
        bin = atob(payload);
      } else {
        bin = decodeURIComponent(payload);
      }
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      return buf.buffer;
    }

    // 优先走宿主代理（绕过页面 CORS）
    let b64 = null;
    try {
      const H = window.CSHost;
      if (H && typeof H.send === 'function') {
        const resp = await H.send('font:fetch', { url });
        if (resp && resp.ok && resp.b64) b64 = resp.b64;
      }
    } catch { /* 宿主不可用，走直连 */ }

    // 兜底：页面内直接取
    if (!b64) {
      const r = await fetch(url, { credentials: 'omit' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const ab = await r.arrayBuffer();
      const bytes = new Uint8Array(ab);
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      b64 = btoa(bin);
    }

    const bin2 = atob(b64);
    const buf = new Uint8Array(bin2.length);
    for (let i = 0; i < bin2.length; i++) buf[i] = bin2.charCodeAt(i);
    return buf.buffer;
  }

  const loadedFonts = new Map();   // url -> family

  async function ensureFont(url) {
    if (loadedFonts.has(url)) return loadedFonts.get(url);
    const buffer = await loadFontBuffer(url);
    const fam = '__CSDEC_' + Math.random().toString(36).slice(2, 9);
    const ff = new FontFace(fam, buffer);
    await ff.load();
    document.fonts.add(ff);
    loadedFonts.set(url, fam);
    return fam;
  }

  const yieldTick = () => new Promise(r => setTimeout(r, 0));

  async function decode(text, ctxEl) {
    const r = await decodeMany([text], ctxEl);
    return r[0];
  }

  /**
   * 批量解码（同字体多段文本，共享字形渲染）
   */
  async function decodeMany(texts, ctxEl) {
    const plain = t => ({
      ok: true, text: t, map: {}, changed: 0,
      lowConfidence: 0, avgScore: 1, reason: '无需解码'
    });

    const uniq = [...new Set(texts.join('').split(''))].filter(isCJK);
    if (!uniq.length) return texts.map(plain);

    const face = fontOf(ctxEl);
    if (!face) return texts.map(plain);

    let fontFam;
    try {
      fontFam = await ensureFont(face.url);
    } catch (e) {
      return texts.map(t => ({ ...plain(t), ok: false, reason: '字体加载失败：' + e.message }));
    }

    const sysFams = pickSystemFonts();
    if (!sysFams || !sysFams.length) {
      return texts.map(t => ({ ...plain(t), ok: false, reason: '系统缺少可用的中文字体' }));
    }

    // ★ 关键：先认出这个反爬字体派生自哪个系统字体
    //   同源字体相似度 1.0，跨字体只有 0.44，用错参照必然误判形近字
    const base = await detectBaseFont(fontFam);

    // 渲染混淆字形
    const obRaw = renderFeatures(fontFam, uniq);
    if (!obRaw.size) {
      return texts.map(t => ({ ...plain(t), ok: false, reason: '字形渲染失败（canvas 不可用）' }));
    }

    // 同源时不做归一化（保持原始像素，精度最高）；
    // 非同源才用骨架归一化，尽量压掉字体风格差异。
    const sameSource = !!(base && base.confident);
    const prep = sameSource
      ? (v) => v
      : (v) => normalizeVec(v, GRID);

    const obFeats = new Map();
    for (const [ch, vec] of obRaw) {
      if (vec) obFeats.set(ch, prep(vec));
    }

    // 参照字体：同源时只用那一款；否则多字体投票
    const refFams = sameSource ? [base.family] : sysFams;

    const stds = [];
    for (const fam of refFams) {
      const raw = new Map();
      renderBatch(fam, FREQ_UNIQ, raw);
      const norm = new Map();
      for (const [ch, vec] of raw) {
        if (vec) norm.set(ch, prep(vec));
      }
      if (norm.size) stds.push({ family: fam, map: norm });
    }
    if (!stds.length) {
      return texts.map(t => ({ ...plain(t), ok: false, reason: '无法建立参照字库' }));
    }

    // ---- 一级：常用字库 ----
    const map = {};
    const uncertain = [];

    for (const ch of uniq) {
      const vec = obFeats.get(ch);
      if (!vec) { map[ch] = { to: ch, score: 0, blank: true }; continue; }

      let bestCh = '', bestScore = -1;
      let secondScore = -1;

      for (const std of stds) {
        for (const [sch, svec] of std.map) {
          const s = cosine(vec, svec);
          if (s > bestScore) {
            secondScore = bestScore;
            bestScore = s;
            bestCh = sch;
          } else if (s > secondScore) {
            secondScore = s;
          }
        }
      }

      map[ch] = { to: bestCh || ch, score: bestScore, second: secondScore };
      // 同源字体下相似度普遍很高，阈值也要提高
      if (bestScore < (sameSource ? 0.97 : 0.90)) uncertain.push(ch);
    }

    // ---- 二级：扩大字库（仅对不确定的字） ----
    // 注意：只有「一级里没找到高分匹配」才需要扩展搜索。
    // 扩展搜索是逐码位扫描，形近字干扰大，
    // 如果一级已经拿到接近 1 的分数，绝不该再动它。
    if (uncertain.length) {
      await yieldTick();
      const all = allCjk();

      // 只为参照字体数量少的情况做扩展，避免耗时爆炸
      for (const ch of uncertain) {
        const vec = obFeats.get(ch);
        if (!vec) continue;

        // 只扫 8 批（≈8192 字），覆盖最常用区
        const r = bestMatch(vec, all, stds, 8);

        // 严格条件：新结果必须明显更好才替换
        // （避免把一级的正确结果被形近字顶掉）
        if (r.score > map[ch].score + 0.02) {
          map[ch] = { to: r.ch, score: r.score, second: map[ch].second };
        }
      }
    }

    // ---- 应用映射 ----
    const scores = uniq.map(c => (map[c] ? map[c].score : 0));
    const avg = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
    // 同源时精度高，可用更严的阈值；非同源放宽
    const low = scores.filter(s => s < (sameSource ? 0.95 : 0.80)).length;

    return texts.map(t => {
      let out = '', changed = 0;
      for (const ch of t) {
        const m = map[ch];
        if (m && m.to && m.to !== ch) { out += m.to; changed++; }
        else out += ch;
      }
      const baseInfo = base
        ? `，基础字体 ${base.family}(${base.score}${base.confident ? '' : ' 低置信'})`
        : '';
      return {
        ok: low === 0,
        text: out,
        map,
        changed,
        avgScore: Number(avg.toFixed(3)),
        lowConfidence: low,
        font: face.family,
        baseFont: base ? base.family : null,
        baseScore: base ? base.score : null,
        sameSource,
        reason: low === 0
          ? '解码完成（还原 ' + changed + ' 字，均分 ' + avg.toFixed(2) + baseInfo + '）'
          : low + ' 字置信度偏低（均分 ' + avg.toFixed(2) + baseInfo + '），建议人工核对'
      };
    });
  }

  /* ============================================================
   * 7. 诊断
   * ============================================================ */

  function diagnose(doc) {
    doc = doc || document;
    const faces = suspiciousFaces(doc);
    const targets = [];
    for (const sel of ['.questionLi', '.TiMu', '#question', '.mark_item', '.Cy_TItle']) {
      const el = doc.querySelector(sel);
      if (!el) continue;
      const f = fontOf(el);
      if (f) targets.push({ selector: sel, family: f.family, url: f.url });
    }
    return {
      totalFaces: collectFontFaces(doc).length,
      suspicious: faces,
      targets,
      systemFont: pickSystemFont(),
      gridSize: GRID,
      freqCharCount: FREQ_CHARS.length,
      cjkTotal: 0x9fa5 - 0x4e00 + 1
    };
  }

  return {
    decode, decodeMany, diagnose,
    fontOf, suspiciousFaces, collectFontFaces,
    renderFeatures, renderBatch, cosine, bestMatch,
    detectBaseFont, pickSystemFonts,
    FREQ_CHARS: FREQ_UNIQ,
    isCJK, pickSystemFont,
    GRID, CELL
  };
})();

if (typeof window !== 'undefined') window.CSFontDecoder = CSFontDecoder;


/* ============================================================================
 * src/content/inject.js
 * ============================================================================ */

/**
 * 学习通自动学习助手 — 内容脚本
 *
 * 架构（重要）：
 *   manifest 里 all_frames:true，每个 frame 都会注入一份本脚本。
 *   为避免重复执行，采用「就近处理」原则：
 *
 *     - 每个 frame 只处理 **自己 document 里** 的元素（不看子 iframe）
 *       因为子 iframe 里的文档自己有实例，会自己处理。
 *     - 「下一节」按钮在顶层章节页 → 只有顶层 frame 负责翻页。
 *     - 顶部 frame 通过后台汇总各 frame 的 busy 状态，
 *       确认「没有任何 frame 在忙」之后才翻页。
 *     - 测验同理：哪个 frame 自己的文档里有 .questionLi，就由它负责。
 *       天然保证同一套题只处理一次。
 */

'use strict';

if (!window.__CS_BOOTED__) {
  window.__CS_BOOTED__ = true;

  /* ------------------------------------------------------------
   * 注入标记
   *
   * 内容脚本跑在隔离世界，页面主世界（以及 DevTools 的
   * 隔离世界）看不到 window.__CS_BOOTED__。
   * 但 DOM 是所有世界共享的，所以往 <html> 上打个属性，
   * 既能用于排查「这个 iframe 到底有没有注入扩展」，
   * 也能让跨 frame 的诊断脚本判断注入情况。
   * ------------------------------------------------------------ */
  try {
    document.documentElement.setAttribute('data-cs-booted', '1');
    document.documentElement.setAttribute(
      'data-cs-frame',
      (window.top === window.self) ? 'top' : 'sub'
    );
  } catch { /* ignore */ }

  /* ============================================================
   * 0. 基础
   * ============================================================ */

  const IS_TOP = (() => {
    try { return window.top === window.self; } catch { return false; }
  })();

  /**
   * 宿主适配层
   *
   * 本文件所有对外通信都走 Host，不再直接调 chrome.runtime.*。
   *   - 扩展：加载 host-extension.js，Host 走 chrome.runtime.sendMessage
   *   - 油猴：加载 host-userscript.js，Host 走 GM_* + 跨帧总线
   * 这样同一份刷课/答题逻辑两个形态共用。
   *
   * 宿主缺失时退化为空实现而不是 return ——
   * 经典脚本的顶层不允许 return（Illegal return statement），
   * 而且整段代码在 `if (!__CS_BOOTED__)` 块里，直接抛错会让页面脚本全挂。
   */
  const Host = (function () {
    const h = (typeof globalThis !== 'undefined' ? globalThis : window).CSHost;
    if (h) return h;
    console.error('[学习通助手] 宿主层未加载（CSHost 缺失），功能不可用');
    const noop = () => null;
    return {
      kind: 'none',
      send: async () => null,
      sendNoWait: noop,
      on: noop,
      getCfg: async () => null,
      setCfg: async () => null,
      getRunning: async () => false,
      setRunning: noop,
      openOptions: noop,
      caps: {}
    };
  })();

  const TAG = '[学习通助手]';

  const state = {
    cfg: null,
    stopped: true,
    status: '待机',
    busy: false,
    panel: null,
    lastReport: 0,
    quizSig: '',
    quizDoneSig: '',
    quizRunning: false,
    lastHref: location.href,
    videoDone: true,        // 视频是否已达完成门槛（90%）
    videoPercent: 0,
    videoThreshold: 0.9,    // 视频完成门槛（运行时从页面读）        // 视频完成百分比
    videoQuizSig: '',     // 当前视频弹题的签名（防重复处理）
    chapterEnterAt: Date.now(),  // 进入本节时间（最低停留用）
    docDone: false,         // 当前文档是否已看完
    docTarget: '',          // 当前滚动的内容区名（调试用）
    docNextAt: 0,           // 下次允许滚动的时间（拟人节流）
    speedLocked: false,     // 平台提示「不可倍速」
    speedGiveUp: false,     // 试过被拒，永久放弃倍速
    speedReverts: 0,        // 倍速被改回的次数
    antispider: false,      // 检测到风控验证页

    /* ── v1.3.0：借鉴大学搜题酱的任务队列 ──
     * 搜题酱不靠「猜标签页」，而是先扫出本章的 iframe 任务清单，
     * 再按清单逐项执行。我们用同一套模型，但完成判定改成
     * 学习通自己的任务点标记（aria-label），比它更准。 */
    taskQueue: [],          // [{order, index, src, rawType, type, label, done, supported}]
    taskQueueSig: '',       // 队列签名（只在变化时重绘面板）
    taskQueueAt: 0,         // 上次扫描时间
    tabTried: [],           // 本节已尝试过的标签 id（防止两个标签来回切）
    routeFp: '',            // 路由指纹 {href, mainIframeSrc, mainDocumentHref}
    routeEpoch: 0,          // 路由代际：异步步骤前后比对，过期就丢弃
    courseComplete: false,  // 整门课已完成（#prevNextFocusNext 隐藏）
    workSafe: null,         // 本轮测验提交安全网 {total, done, safe, unsafeReason}
    score: ''               // 最近一次提交后的分数（给用户看）
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const log = (...a) => { try { if (!state.cfg || state.cfg.auto.debug) console.log(TAG, ...a); } catch { /* ignore */ } };

  /** 只在本文档内查询 */
  const q1 = s => { try { return document.querySelector(s); } catch { return null; } };
  const qAll = s => { try { return [...document.querySelectorAll(s)]; } catch { return []; } };

  /* ============================================================
   * 1. 防切屏 / 防暂停
   * ============================================================ */

  function patchWindow(win) {
    if (!win || win.__CS_PATCHED__) return;
    try { win.__CS_PATCHED__ = true; } catch { return; }
    try {
      const doc = win.document;
      ['visibilitychange', 'webkitvisibilitychange', 'blur', 'focusout', 'mouseleave', 'pagehide']
        .forEach(ev => {
          try {
            doc.addEventListener(ev, e => e.stopImmediatePropagation(), true);
            win.addEventListener(ev, e => e.stopImmediatePropagation(), true);
          } catch { /* ignore */ }
        });
      Object.defineProperty(doc, 'hidden', { get: () => false, configurable: true });
      Object.defineProperty(doc, 'visibilityState', { get: () => 'visible', configurable: true });
    } catch { /* ignore */ }
  }

  /* ============================================================
   * 2. 视频（仅本文档）
   * ============================================================ */

  /**
   * 倍速锁定检测（三重信号）
   *
   * 学习通锁倍速的方式不止一种，实测至少三类：
   *   1. 页面文字提示：「未完成任务点前，当前视频不可倍速」
   *   2. 播放器静默改回 1x：设 2x 后几百毫秒内变回 1
   *   3. 直接反制暂停视频，甚至触发风控验证页
   *
   * 第 2 类最隐蔽 —— 代码看着"设置成功了"，实际下一帧被改回。
   * 所以必须主动验证：设完之后隔一会儿回读，看还在不在。
   */
  function checkLockSignals() {
    try {
      // 取视频附近的文本，避免页面按钮文字干扰
      // （踩过坑：按钮写着「任务点已完成」，导致误判为已解锁）
      //
      // 注意上溯层数不能太多 —— 超出 DOM 树会拿到 null，
      // 结果 txt 为空、什么都判断不了，锁定状态会永远卡住。
      // 所以逐层上溯，取第一个拿得到文本的容器。
      let txt = '';
      try {
        const v = q1('video');
        let node = v;
        for (let i = 0; i < 6 && node; i++) {
          node = node.parentElement;
          if (!node) break;
          const t = node.innerText || '';
          if (t.length > 30) { txt = t; break; }
        }
      } catch { /* ignore */ }

      // 拿不到就用全文（总能拿到）
      if (!txt) txt = document.body?.innerText || '';

      // 剔除按钮里的文字
      try {
        for (const b of qAll('button, .btn, input[type=button]')) {
          const bt = (b.innerText || '').trim();
          if (bt && bt.length > 1) txt = txt.split(bt).join('');
        }
      } catch { /* ignore */ }
      txt = txt.slice(0, 8000);

      // 风控验证页：立刻收手
      if (/操作异常|请输入图片中的验证码/i.test(txt) || /antispider/i.test(location.href)) {
        state.antispider = true;
        return;
      }

      // 锁定提示优先判断（最可靠）
      if (/不可倍速|当前视频不可|禁止倍速|不允许倍速/.test(txt)) {
        state.speedLocked = true;
        return;
      }

      // 明确的完成提示才算解锁
      if (/任务点.{0,6}已完成|恭喜.{0,8}(完成|学完)/.test(txt)) {
        if (state.speedLocked || state.speedGiveUp) {
          log('检测到任务点已完成，重置倍速锁定状态');
        }
        state.speedLocked = false;
        state.speedGiveUp = false;
        state.speedReverts = 0;
        return;
      }

      // 既没锁提示、也没完成提示 —— 保持现状，不做判断
    } catch { /* ignore */ }
  }

  /**
   * 试改倍速：设一次 → 回读验证 → 不行就永久放弃
   *
   * 这是「不跟播放器较劲」的核心。
   * 用户实测：强制 2x 时视频根本不动，改成 1x 就正常。
   * 所以一旦发现被改回，立刻放弃倍速，优先保证能播下来。
   *
   * @returns {Promise<boolean>} 倍速是否真的生效
   */
  async function trySetRate(v, target) {
    if (state.speedGiveUp || state.speedLocked) return false;
    if (target <= 1.02) return true;

    // 设一次
    try {
      const player = v.player || (window.videojs && v.id && window.videojs.getPlayer(v.id));
      if (player && typeof player.playbackRate === 'function') player.playbackRate(target);
      else v.playbackRate = target;
    } catch { /* ignore */ }

    // 回读验证（关键步骤）
    await sleep(600);
    const actual = v.playbackRate || 1;

    if (Math.abs(actual - target) < 0.1) {
      state.speedReverts = 0;
      return true;
    }

    // 被改回了
    state.speedReverts = (state.speedReverts || 0) + 1;
    log('倍速被改回：目标 ' + target + '，实际 ' + actual + '（第 ' + state.speedReverts + ' 次）');

    // 连续 2 次被拒 → 永久放弃倍速
    if (state.speedReverts >= 2) {
      state.speedGiveUp = true;
      setStatus('⚠ 平台锁定倍速，已自动改为 1x 正常播放', false);
      log('放弃倍速，改 1x 保证能正常刷完');
    }
    return false;
  }

  /**
   * 视频完成门槛（默认 90%，但会从页面动态读取）
   *
   * 实测不同章节门槛不同：
   *   微课  → 观看时长需 ≥ 总时长的 90%
   *   动画  → 观看时长需 ≥ 总时长的 70%
   * 硬编码会导致低门槛的视频永远判不完成。
   */
  const VIDEO_THRESHOLD = 0.9;

  /**
   * 从页面的「完成条件」文字里读真实门槛
   *
   * 实测 DOM：
   *   <div class="task-condition">
   *     <span class="special-text">完成条件</span>
   *     观看时长需 ≥ 总时长的 70%
   *   </div>
   *
   * @returns {number} 0.7 / 0.9 等；读不到返回默认值
   */
  function readVideoThreshold() {
    try {
      // ① 优先从 task-condition 读
      const conds = qAll('.task-condition');
      for (const el of conds) {
        const t = (el.innerText || '').replace(/\s+/g, ' ');
        const m = t.match(/≥\s*总时长的\s*(\d+)\s*%/);
        if (m) {
          const pct = parseInt(m[1], 10);
          if (pct > 0 && pct <= 100) {
            const v = pct / 100;
            if (Math.abs(v - state.videoThreshold) > 0.001) {
              log('视频门槛: ' + pct + '%');
              state.videoThreshold = v;
            }
            return v;
          }
        }
      }

      // ② 退化：从整页文字里找
      const txt = (document.body?.innerText || '').slice(0, 3000);
      const m2 = txt.match(/≥\s*总时长的\s*(\d+)\s*%/);
      if (m2) {
        const pct = parseInt(m2[1], 10);
        if (pct > 0 && pct <= 100) {
          const v = pct / 100;
          state.videoThreshold = v;
          return v;
        }
      }
    } catch { /* ignore */ }

    // ③ 用户配置 > 默认
    return Number(state.cfg?.auto?.videoThreshold) || VIDEO_THRESHOLD;
  }



  /**
   * 等某个条件成立（轮询）
   */
  async function waitFor(fn, timeoutMs, stepMs) {
    const step = stepMs || 200;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if (fn()) return true; } catch { /* ignore */ }
      await sleep(step);
    }
    try { return !!fn(); } catch { return false; }
  }

  /**
   * 检测视频任务的完成度
   *
   * 实测关键（见 docs/改造计划.md 11.2）：
   *   - video 的 preload=none，不播放时 duration 一直是 null
   *   - 调 play() 后约 1 秒内 duration 出现，readyState 从 0 变 4
   *   - 完成条件是页面明写的：观看时长 >= 总时长的 90%
   */
  async function checkVideoTask(v) {
    const threshold = readVideoThreshold();

    if (!v) return { state: 'no-video', done: true, waiting: false };

    // 1. 没元数据，先播起来才能读到时长
    if (!isFinite(v.duration) || v.duration <= 0) {
      if (v.paused) {
        try { await v.play(); } catch (e) { log('play() 被拒', e?.message); }
      }
      const got = await waitFor(() => isFinite(v.duration) && v.duration > 0, 8000, 300);

      if (!got) {
        return { state: 'loading', done: false, waiting: true, currentTime: 0, duration: 0, percent: 0 };
      }
      log('视频时长已加载: ' + v.duration.toFixed(1) + 's');
    }

    const dur = v.duration;
    const cur = v.currentTime;
    const percent = dur > 0 ? cur / dur : 0;
    const done = percent >= threshold;

    return {
      state: done ? 'done' : 'playing',
      currentTime: cur,
      duration: dur,
      percent,
      done,
      waiting: !done,
      threshold
    };
  }

  async function runVideo() {
    const vids = qAll('video');
    if (!vids.length) return false;

    checkLockSignals();

    if (state.antispider) {
      setStatus('⚠ 检测到平台验证，已停止。请在页面上完成验证', false);
      state.stopped = true;
      return false;
    }

    let handled = false;
    state.videoDone = true;

    for (const v of vids) {
      try {
        const info = await checkVideoTask(v);

        if (info.state === 'loading') {
          state.videoDone = false;
          state.videoPercent = 0;
          setStatus('⏳ 视频加载中…', true);
          handled = true;
          continue;
        }

        if (info.state === 'done') {
          state.videoDone = true;
          state.videoPercent = info.percent || 1;
          log('视频已达 ' + Math.round((info.percent || 1) * 100) + '%，任务点应已完成');
          continue;
        }

        state.videoDone = false;
        state.videoPercent = info.percent;

        if (state.cfg.auto.mute) {
          try { v.muted = true; v.volume = 0; } catch { /* ignore */ }
        }

        if (v.paused) {
          try { await v.play(); } catch (e) { log('play() 被拒', e?.message); }

          if (v.paused) {
            await sleep(280);
            if (v.paused) {
              try { await v.play(); } catch { /* 再试一次 */ }
            }
          }
        }

        if (!v.paused && !state.speedGiveUp && !state.speedLocked) {
          const target = Number(state.cfg.auto.rate) || 2;
          await trySetRate(v, target);
        }

        handled = true;
      } catch (e) { log('视频异常', e?.message); }
    }
    return handled;
  }

  /* ============================================================
   * 3. 任务点识别（哪些已完成 / 哪些没完成）
   * ============================================================ */

  /**
   * 学习通的任务点状态标记（实地抓取确认）
   *
   *   已完成： <span class="icon_Completed prevTips">已完成</span>
   *   未完成： <span class="catalog_points_yi prevTips">1个待完成任务点</span>
   *            <span class="orangeNew">1</span>   ← 角标数字
   *
   * 课程树节点：.posCatalog_select
   */
  const TP = {
    DONE: '.icon_Completed',
    TODO: '.catalog_points_yi',
    BADGE: '.orangeNew',
    NODE: '.posCatalog_select',
    NEXT: ['#prevNextFocusNext', '.nextChapter', '.prev_next.next']
  };

  /** 当前章节是否还有未完成任务点 */
  function hasPendingTaskPoints() {
    try {
      const txt = (document.body?.innerText || '').slice(0, 3000);
      if (/还有任务点未完成|\d+个待完成任务点/.test(txt)) return true;
      return qAll(TP.TODO).length > 0;
    } catch { return false; }
  }

  /** 本章节任务点统计 */
  function getTaskPointStats() {
    try {
      const done = qAll(TP.DONE).length;
      const todo = qAll(TP.TODO).length;
      // 两个都是 0 说明页面上根本没有任务点信息（比如测试页、或者
      // 当前标签页不是任务点类型），此时不能判成"未完成"，
      // 否则会误报"还有 0 个任务点未完成"并卡住不翻页。
      const hasInfo = done > 0 || todo > 0;
      return {
        done, todo,
        hasInfo,
        allDone: hasInfo && todo === 0,
        unknown: !hasInfo
      };
    } catch { return { done: 0, todo: 0, hasInfo: false, allDone: false, unknown: true }; }
  }

  /**
   * 在课程树里找下一个「未完成」的章节
   *
   * 用户要求：只看未完成的，跳过已完成的。
   */
  function findNextUnfinishedNode() {
    try {
      const nodes = qAll(TP.NODE);
      if (!nodes.length) return null;

      // 找当前节点
      let curIdx = -1;
      for (let i = 0; i < nodes.length; i++) {
        const cls = (nodes[i].className || '').toString();
        if (/active|current|selected/i.test(cls)) { curIdx = i; break; }
      }

      const scan = (from, to) => {
        for (let i = from; i < to; i++) {
          const n = nodes[i];
          if (!n.querySelector('.posCatalog_name')) continue;
          if (n.querySelector(TP.DONE)) continue;   // 已完成，跳过
          return n;
        }
        return null;
      };

      if (curIdx >= 0) {
        const after = scan(curIdx + 1, nodes.length);
        if (after) return after;
        return scan(0, curIdx);
      }
      return scan(0, nodes.length);
    } catch { return null; }
  }

  /** 点击某个课程树节点 */
  function clickTreeNode(node) {
    if (!node) return false;
    try {
      const nameEl = node.querySelector('.posCatalog_name') || node;
      nameEl.click();
      return true;
    } catch { return false; }
  }

  /* ============================================================
   * 4. 文档 / PPT —— 拟人化滚动
   * ============================================================ */

  let scrollTicks = new WeakMap();
  let scrollState = null;

  function scrollTicksCleanup() {
    scrollTicks = new WeakMap();
    scrollState = null;
  }

  /**
   * 找出当前文档里真正需要滚动的东西
   *
   * 学习通的内容散在多处：
   *   · PDF 阅读器在自己的 iframe 里（跨域也有扩展实例，各管各的）
   *   · 文档容器 #panView / .insertdoc-online-pdf
   *   · 普通章节页要滚整个文档才能看到「下一节」
   *
   * 所以这里按优先级找，找到什么滚什么。
   */
  /**
   * 判断某个容器是不是「内容区」
   *
   * 踩过的坑：学习通右侧的目录树 #coursetree 也是个大滚动容器
   * （滚高 5000+），如果按"最大的可滚动容器"来选，会去滚目录，
   * 而不是滚微课正文 —— 用户看到的就是"目录在动、内容不动"。
   *
   * 所以必须把侧栏、目录、导航这类 UI 排除掉。
   */
  const NON_CONTENT = /coursetree|posCatalog|catalog|sidebar|side-bar|nav|menu|toc|directory|rightpanel|right-panel|tab|breadcrumb|header|footer|toolbar|notice|tip-bar/i;

  function isContentArea(el) {
    if (!el || !el.tagName) return false;
    if (el === document.body || el === document.documentElement) return false;

    // 自己的 class / id 命中 UI 关键字 → 排除
    const sig = ((el.id || '') + ' ' + (el.className || '').toString());
    if (NON_CONTENT.test(sig)) return false;

    // 祖先里有 UI 关键字 → 也排除
    let p = el.parentElement, guard = 0;
    while (p && guard++ < 8) {
      const ps = ((p.id || '') + ' ' + (p.className || '').toString());
      if (NON_CONTENT.test(ps)) return false;
      p = p.parentElement;
    }
    return true;
  }

  /** 内容区里找滚动目标 */
  /** 内容区里找滚动目标 */
  /**
   * 找当前页面里「真正需要滚动的那个容器」
   *
   * 踩过的两个坑：
   *   1. 按"最大可滚动"选，会选中右侧 #coursetree（目录树，滚高 5000+）
   *      —— 用户看到的就是目录在动、正文不动
   *   2. 选中了内层 DIV.main（滚程只有 132px），滚两下就"到底"了，
   *      而真正的页面滚动条还有 2000+ 没滚 —— 于是永远不翻页、卡住
   *
   * 所以：先收集所有候选，再**按滚动行程取最大**，
   * 保证选中的那个能把整篇文章滚完。
   */
  function findScrollTarget() {
    const cands = [];

    // 1) 明确的学习文档容器（PDF 阅读器内部滚动）
    try {
      for (const pane of qAll('#panView, .insertdoc-online-pdf, .insertdoc, #docContainer')) {
        const inner = [pane, ...pane.querySelectorAll('*')]
          .map(el => ({ el, range: el.scrollHeight - el.clientHeight }))
          .filter(x => x.range > 80);
        if (inner.length) {
          inner.sort((a, b) => b.range - a.range);
          // 文档容器行程够大就直接用它（最可靠）
          if (inner[0].range > 200) return inner[0].el;
          cands.push(inner[0].el);
        }
      }
    } catch { /* ignore */ }

    // 2) 内容型大容器（排除目录/侧栏）
    try {
      for (const el of qAll('div, section, article, main')) {
        if (!isContentArea(el)) continue;
        const range = el.scrollHeight - el.clientHeight;
        if (range > 100 && el.clientHeight > 120 && el.offsetParent !== null) {
          cands.push(el);
        }
      }
    } catch { /* ignore */ }

    // 3) 整个文档（页面级滚动）—— 大多数章节页真正的滚动条
    const se = document.scrollingElement || document.documentElement;
    if (se && se.scrollHeight > se.clientHeight + 40) cands.push(se);

    if (!cands.length) return null;

    // 关键：取滚动行程最大的那个 —— 它能覆盖整篇内容
    let best = cands[0], bestScore = -1;
    for (const el of cands) {
      const range = el.scrollHeight - el.clientHeight;
      // 文档滚动条略微加权，确保整页能滚完
      const score = (el === se) ? range * 1.2 : range;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  /** 当前正在滚的是不是内容区（用于状态提示） */
  function describeScrollTarget(el) {
    if (!el) return '无';
    if (el === document.scrollingElement || el === document.documentElement) return '整页';
    const id = el.id ? '#' + el.id : '';
    const cls = (el.className || '').toString().split(/\s+/).filter(Boolean)[0] || '';
    return (el.tagName || '') + id + (cls ? '.' + cls : '');
  }

  /**
   * 拟人化滚动 —— 1.5 秒一屏
   *
   * 用户要求：像人一样慢慢往下看，直到「下一节」出现。
   * 每 1.5 秒滚一屏的 ~70%，带随机抖动。
   */
  async function runDocument() {
    if (!state.cfg.auto.docAutoScroll) return false;

    const now = Date.now();
    if (state.docNextAt && now < state.docNextAt) return true;   // 节流中

    const box = findScrollTarget();
    if (!box) return false;

    const maxTop = box.scrollHeight - box.clientHeight;
    const cur = box.scrollTop;

    // 异常保护：学习通偶尔有页面被撑到几万像素（整章内容平铺、
    // 或页面状态异常）。这种情况不该傻滚 9 万像素，
    // 超过阈值就当这页没实质内容，交给翻页逻辑。
    const MAX_SANE_SCROLL = 20000;
    if (maxTop > MAX_SANE_SCROLL) {
      log('滚动范围异常大（' + maxTop + 'px），跳过滚动直接翻页');
      state.docDone = true;
      return false;
    }

    // 已经到底
    if (cur >= maxTop - 12) {
      // 若「下一节」已经在视野里，说明这节看完了
      if (isNextButtonVisible() || getTaskPointStats().allDone) {
        state.docDone = true;
        return false;
      }
      // 到底了但没看到下一节 —— 回顶部再看一轮（人也会往回翻）
      try {
        box.scrollTop = 0;
        box.dispatchEvent(new Event('scroll', { bubbles: true }));
      } catch { /* ignore */ }
      state.docNextAt = now + 1500;
      log('到底，回顶部重看');
      return true;
    }

    // 每次滚一屏的 ~70%，加随机抖动模拟真人
    const vh = box.clientHeight || window.innerHeight;
    const jitter = Math.round(Math.random() * 80 - 40);
    const step = Math.max(120, Math.round(vh * 0.7) + jitter);
    const next = Math.min(cur + step, maxTop);

    try {
      box.scrollTop = next;
      box.dispatchEvent(new Event('scroll', { bubbles: true }));
    } catch { /* ignore */ }

    scrollTicks.set(box, (scrollTicks.get(box) || 0) + 1);
    state.docNextAt = now + 1500;

    const pct = maxTop > 0 ? Math.round(next / maxTop * 100) : 100;
    const tname = describeScrollTarget(box);
    log('滚动 ' + tname + ' ' + Math.round(cur) + ' → ' + Math.round(next) + '（' + pct + '%）');
    state.docTarget = tname;
    return true;
  }

  /** 文档是否已滚到底 */
  function isDocAtBottom() {
    try {
      const box = findScrollTarget();
      if (!box) return true;
      return box.scrollTop >= (box.scrollHeight - box.clientHeight) - 12;
    } catch { /* ignore */ }
    return false;
  }

  /** 「下一节」按钮是否已经进入视野 */
  function isNextButtonVisible() {
    for (const s of TP.NEXT) {
      const el = q1(s);
      if (!el) continue;
      try {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 &&
            r.top > 0 && r.top < window.innerHeight && r.bottom > 0) {
          return true;
        }
      } catch { /* ignore */ }
    }
    return false;
  }

  /* ============================================================
   * 4. 测验
   * ============================================================ */

  /** 本文档里是否有题目 */
  /**
   * 页面上有没有题目
   *
   * 实测：学习通测验页的容器是 .TiMu（不是 .questionLi）
   * 位置：mooc-ans/work/doHomeWorkNew 帧内
   */
  function hasQuiz() {
    // 按可靠性排优先级（.singleQuesId 是搜题酱用的旧版容器，加进来兜底）
    const sels = ['.TiMu', '.questionLi', '.mark_item', '.singleQuesId'];
    for (const s of sels) {
      if (qAll(s).length > 0) return true;
    }
    return false;
  }

  /** 判题型（优先看 DOM 属性，比文字可靠） */
  function judgeType(text, qEl) {
    // ① 最可靠：隐藏域 input[id^=answertype] 的值
    //    （搜题酱 getAnswerType 的同一套映射：0单选 1多选 2填空 3判断）
    if (qEl) {
      const at = qEl.querySelector('input[id^="answertype"]');
      const av = at ? String(at.value || '').trim() : '';
      if (av === '0') return 'single';
      if (av === '1') return 'multi';
      if (av === '2') return 'fill';
      if (av === '3') return 'judge';
    }

    // ② qtype 属性（实测：0单选 1多选 2填空 3判断）
    if (qEl) {
      const firstLi = qEl.querySelector('.Zy_ulTop li');
      const qtype = firstLi?.getAttribute('qtype');
      if (qtype === '1') return 'multi';
      if (qtype === '0') return 'single';
      if (qtype === '3') return 'judge';
      // 填空题没有 li，看 tiankongsize 隐藏域
      if (qEl.querySelector('input[name^="tiankongsize"]') ||
          qEl.querySelector('textarea[name^="answerEditor"]') ||
          qEl.querySelector('.blankItemDiv')) {
        return 'fill';
      }
    }

    // ③ 退化到文字判断
    if (/【单选题】|单选题/.test(text)) return 'single';
    if (/【多选题】|多选题/.test(text)) return 'multi';
    if (/【判断题】|判断题/.test(text)) return 'judge';
    if (/【填空题】|填空题/.test(text)) return 'fill';
    return 'unknown';
  }

  /**
   * 抓取题目（含字体解码）
   *
   * 实测结构（docs/改造计划.md 11.7 / 11.8 / 11.9）：
   *
   *   <div class="TiMu newTiMu" data="1">
   *     <div class="Zy_TItle clearfix">
   *       <i class="fl">1</i>
   *       <div class="font-cxsecret fontLabel">
   *         <span class="newZy_TItle">【多选题】</span>题干文字
   *       </div>
   *     </div>
   *     <ul class="Zy_ulTop">
   *       <li role="checkbox" qid="405881807" qtype="1" onclick="addMultipleChoice(this);">
   *         <span class="num_option_dx" data="A">A</span>
   *         <a class="after">选项文字</a>
   *       </li>
   *     </ul>
   *   </div>
   *
   * 三种题型的 span class：
   *   多选 → .num_option_dx
   *   单选/判断 → .num_option
   *   判断的 data 是 "true"/"false"，选项文字是「对/错」
   */
  async function scrapeQuiz() {
    // 容器优先级：.TiMu（现版）→ .questionLi（旧版）→ .singleQuesId（搜题酱用的版本）
    let boxes = qAll('.TiMu');
    if (!boxes.length) boxes = qAll('.questionLi');
    if (!boxes.length) boxes = qAll('.singleQuesId');
    if (!boxes.length) return { ok: false, reason: '本文档无题目' };

    const questions = [];

    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];

      // ── 题号 ──
      const numEl = b.querySelector('.Zy_TItle > i');
      const num = (numEl?.innerText || '').trim() || String(i + 1);

      // ── 题干（可能带反爬字体）──
      const titleEl = b.querySelector('.Zy_TItle .font-cxsecret')
                   || b.querySelector('.Zy_TItle .fontLabel')
                   || b.querySelector('.Zy_TItle');

      // 去掉题型标签后的纯题干
      let rawTitle = (titleEl?.innerText || '').replace(/\s+/g, ' ').trim();
      const typeText = (b.querySelector('.newZy_TItle')?.innerText || '').trim();

      // ── 题型 ──
      const type = judgeType(typeText + ' ' + rawTitle, b);

      // ── 题目标识 ──
      const firstLi = b.querySelector('.Zy_ulTop li');
      const qid = firstLi?.getAttribute('qid')
               || b.querySelector('input[id^="answertype"]')?.id?.replace('answertype', '')
               || '';

      // ── 选项（三种题型选择器不同）──
      const spanSel = type === 'multi' ? '.num_option_dx' : '.num_option';
      const options = [];
      for (const li of b.querySelectorAll('.Zy_ulTop li')) {
        const span = li.querySelector(spanSel) || li.querySelector('.num_option_dx') || li.querySelector('.num_option');
        const val = span?.getAttribute('data') || '';
        const letter = (span?.innerText || '').trim();
        const txt = (li.querySelector('a.after')?.innerText || '').replace(/\s+/g, ' ').trim();
        options.push({
          value: val,          // 选择题 A/B/C/D；判断题 true/false
          letter: letter,      // 显示的字母
          text: txt,           // 选项文字（可能反爬）
          qid: li.getAttribute('qid'),
          checked: /check_answer/.test((span?.className || '').toString()),
          el: li
        });
      }

      // 选项兜底：旧版/考试页用 .before-after / .before-after-checkbox
      if (!options.length) {
        for (const el of b.querySelectorAll('.before-after, .before-after-checkbox')) {
          const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
          const m = txt.match(/^\s*([A-Za-z])\s*[、，,．.\s+]?/);
          const input = el.querySelector('[name^=answer]');
          options.push({
            value: m ? m[1].toUpperCase() : txt.slice(0, 30),
            letter: m ? m[1].toUpperCase() : '',
            text: txt,
            qid: b.getAttribute('data') || '',
            checked: /check_answer/.test(String(input?.className || '')),
            el
          });
        }
      }

      // ── 填空题的输入区 ──
      const fillAreas = [...b.querySelectorAll(
        'textarea[name^="answerEditor"], .blankItemDiv textarea, .Zy_ulTk textarea'
      )];
      const blankCount = +(b.querySelector('input[name^="tiankongsize"]')?.value
        || b.querySelectorAll('.blankItemDiv').length || 0);

      questions.push({
        index: i + 1,
        num,
        type,
        qtype: firstLi?.getAttribute('qtype') || '',
        qid,
        title: rawTitle,
        typeText,
        options,
        fillAreas,
        blankCount,
        el: b,
        // 收集所有需要解码的文本节点
        textEls: [titleEl, ...b.querySelectorAll('.Zy_ulTop a.after')].filter(Boolean)
      });
    }

    // ── 字体解码 ──
    if (window.CSFontDecoder && typeof window.CSFontDecoder.decodeMany === 'function') {
      try {
        const allTexts = [];
        for (const q of questions) {
          allTexts.push(q.title);
          for (const o of q.options) allTexts.push(o.text);
        }
        const decoded = await window.CSFontDecoder.decodeMany(allTexts);
        if (decoded && decoded.length === allTexts.length) {
          const pick = (r) => {
            // decodeMany 返回的是对象数组 { ok, text, map, changed, ... }
            if (!r) return '';
            if (typeof r === 'string') return r;
            if (typeof r.text === 'string') return r.text;
            return '';
          };
          let k = 0;
          for (const q of questions) {
            q.rawTitle = q.title;
            const dt = pick(decoded[k++]);
            if (dt) q.title = dt;
            for (const o of q.options) {
              o.rawText = o.text;
              const d = pick(decoded[k++]);
              if (d) o.text = d;
            }
          }
          log('字体解码完成，共 ' + allTexts.length + ' 段文本');
        }
      } catch (e) {
        log('字体解码失败，使用原始文本', e?.message);
      }
    } else {
      log('CFSFontDecoder 未加载，跳过字体解码');
    }

    // ── 可信度评估 ──
    const assess = assessTextReliability({ questions });

    return {
      ok: true,
      questions,
      reliable: assess.reliable,
      garbledRatio: assess.garbledRatio || 0,
      reason: assess.reason || ''
    };
  }

  /**
   * 填充答案（按实测结构，三种题型分别处理）
   *
   * 实测要点（docs/改造计划.md 11.7 / 11.8）：
   *   · 多选题 span class = num_option_dx，data = A/B/C/D
   *   · 单选/判断 span class = num_option
   *   · 判断题 data = "true" / "false"，选项文字是「对/错」
   *   · 填空题是 UEditor，答案写 textarea[name^=answerEditor]
   *   · **必须用 .click()**，否则 answer<qid> 隐藏域不更新，提交会报未作答
   */
  async function fillAnswers(questions, answers) {
    const byNum = new Map();
    for (const a of answers || []) {
      if (a && a.num != null) byNum.set(String(a.num).trim(), a);
      if (a && a.index != null) byNum.set(String(a.index).trim(), a);
    }

    const report = [];

    for (const q of questions) {
      // 按题号匹配；匹配不到就按顺序
      let ans = byNum.get(String(q.num).trim());
      if (!ans) ans = byNum.get(String(q.index).trim());

      if (!ans) {
        report.push({ num: q.num, ok: false, safe: false, reason: 'API 未返回本题答案', type: q.type });
        continue;
      }

      let vals = Array.isArray(ans.answer) ? ans.answer : [ans.answer];
      vals = vals.filter(v => v != null && String(v).trim() !== '').map(v => String(v).trim());

      try {
        /* ============ 选择题 / 判断题 ============ */
        if (q.type === 'single' || q.type === 'multi' || q.type === 'judge') {
          // 目标值列表
          let wants;
          if (q.type === 'judge') {
            // 判断题：把「对/错/正确/错误/true/false」统一成 true/false
            wants = vals.map(v => {
              const s = v.toUpperCase();
              if (/^(对|正确|TRUE|T|A|√|是)$/.test(s) || /^(对|正确)$/.test(v)) return 'true';
              if (/^(错|错误|FALSE|F|B|×|否)$/.test(s) || /^(错|错误)$/.test(v)) return 'false';
              if (s === 'TRUE' || s === 'FALSE') return s.toLowerCase();
              return s.toLowerCase();
            });
          } else {
            // 选择题：取字母
            wants = vals.map(v => {
              const s = String(v).trim();
              // 可能是 "A" 或 "A、B" 或 "AB"
              const letters = s.toUpperCase().match(/[A-Z]/g);
              return letters ? letters.join('') : s.toUpperCase();
            }).join('');
            // 拆成单字母数组
            wants = wants.split('');
          }

          // ── 先清空已选中的选项 ──
          // 实测：多选、单选、判断题**点两次都会取消选中**。
          // 所以不能"已选中就跳过"，必须先清空再点目标，
          // 否则会出现"本该选中 A，点一下反而取消了"。
          for (const o of q.options) {
            if (!o.checked) continue;
            try {
              o.el.click();
              await sleep(80);
            } catch { /* ignore */ }
          }

          // ── 再点目标选项 ──
          let clicked = 0;

          for (const want of wants) {
            const target = q.options.find(o => {
              const ov = String(o.value || '').toLowerCase();
              const ol = String(o.letter || '').toUpperCase();
              return ov === String(want).toLowerCase() || ol === String(want).toUpperCase();
            });

            if (!target) {
              log('找不到选项: ' + want);
              continue;
            }

            try {
              target.el.click();
              clicked++;
              await sleep(100);
            } catch (e) {
              log('点击选项失败', e?.message);
            }
          }

          // ── 校验：隐藏域 + 选中态（决定「能不能安全提交」）──
          await sleep(150);
          const hiddenAns = q.qid ? document.getElementById('answer' + q.qid) : null;
          const gotValue = hiddenAns ? String(hiddenAns.value || '') : '(无隐藏域)';
          const expected = q.type === 'judge' ? wants[0] : wants.join('');

          const checkedNow = q.options.filter(o => {
            const span = o.el.querySelector('.num_option, .num_option_dx');
            return /check_answer/.test(String(span?.className || ''))
                || /check_answer/.test(String(o.el.className || ''));
          });

          let safe = false;
          let safeReason = '';
          if (q.type === 'judge') {
            const hv = gotValue.toLowerCase();
            safe = hv
              ? hv === String(expected).toLowerCase()
              : checkedNow.length > 0;
            if (!safe) safeReason = '判断题答案未写入（' + gotValue + '）';
          } else {
            const norm = v => String(v || '').toUpperCase().replace(/[^A-Z]/g, '').split('').sort().join('');
            const wantLetters = wants.map(w => String(w).toUpperCase());
            safe = checkedNow.length > 0 && (
              (hiddenAns && norm(gotValue) === norm(wantLetters.join('')))
              || checkedNow.length === wantLetters.length
            );
            if (!safe) safeReason = '选项未选中或与答案不符（隐藏域=' + gotValue + '）';
          }

          if (hiddenAns && gotValue !== expected) {
            log('填答校验: 期望 ' + expected + '，隐藏域 ' + gotValue + '（安全=' + safe + '）');
          }

          report.push({
            num: q.num,
            ok: clicked > 0 || checkedNow.length > 0,
            safe,
            safeReason,
            type: q.type,
            filled: wants.join(''),
            total: q.options.length
          });

        /* ============ 填空题 ============ */
        } else if (q.type === 'fill') {
          let filled = 0;

          // 方式 A：UEditor 的 textarea（实测 window.UE 不存在，直接写 value）
          const areas = q.fillAreas || [];
          for (let k = 0; k < areas.length && k < vals.length; k++) {
            const ta = areas[k];
            if (!ta) continue;
            try {
              ta.value = vals[k];
              ta.dispatchEvent(new Event('input', { bubbles: true }));
              ta.dispatchEvent(new Event('change', { bubbles: true }));
              filled++;
            } catch (e) {
              log('填 textarea 失败', e?.message);
            }
          }

          // 方式 B：如果 UEditor 的 iframe body 存在，也写一份（双保险）
          try {
            const editorIframes = q.el.querySelectorAll('.edui-editor iframe');
            for (let k = 0; k < editorIframes.length && k < vals.length; k++) {
              const fr = editorIframes[k];
              let d = null;
              try { d = fr.contentDocument || fr.contentWindow.document; } catch { d = null; }
              if (!d || !d.body) continue;
              d.body.innerHTML = '<p>' + vals[k] + '</p>';
              const win = d.defaultView || window;
              d.body.dispatchEvent(new win.Event('input', { bubbles: true }));
              d.body.dispatchEvent(new win.Event('keyup', { bubbles: true }));
            }
          } catch { /* ignore */ }

          // 方式 C：搜题酱写法 —— .blankItemDiv 里可能是 .InpDIV / textarea / iframe
          try {
            const blanks = q.el.querySelectorAll('.blankItemDiv');
            for (let k = 0; k < blanks.length && k < vals.length; k++) {
              const bd = blanks[k];
              const inp = bd.querySelector('.InpDIV');
              if (inp) { inp.innerHTML = '<p>' + vals[k] + '</p>'; filled++; }
              const ta = bd.querySelector('textarea');
              if (ta && !ta.value) { ta.value = vals[k]; filled++; }
              const fr = bd.querySelector('iframe');
              if (fr) {
                let d = null;
                try { d = fr.contentDocument || fr.contentWindow.document; } catch { d = null; }
                const p = d?.body ? (d.body.querySelector('p') || d.body) : null;
                if (p) { p.innerHTML = vals[k]; filled++; }
              }
            }
          } catch { /* ignore */ }

          // 提交安全：答案必须真的落到了某个输入区里
          let safe = false;
          let safeReason = '';
          try {
            const values = [...(q.fillAreas || [])].map(ta => String(ta.value || '').trim());
            const iframeTexts = [];
            for (const fr of q.el.querySelectorAll('.edui-editor iframe, .blankItemDiv iframe')) {
              try { iframeTexts.push(String(fr.contentDocument?.body?.innerText || '').trim()); } catch { /* ignore */ }
            }
            const inpTexts = [...q.el.querySelectorAll('.blankItemDiv .InpDIV')]
              .map(e => String(e.innerText || '').trim());
            const blob = values.concat(iframeTexts, inpTexts).join(' ');
            safe = vals.length > 0 && vals.every(v => blob.includes(v));
            if (!safe) safeReason = '答案未写入输入区';
          } catch {
            safe = filled > 0;
            if (!safe) safeReason = '无法校验输入区';
          }

          report.push({
            num: q.num,
            ok: filled > 0,
            safe,
            safeReason,
            type: 'fill',
            filled,
            need: vals.length
          });

        } else {
          report.push({ num: q.num, ok: false, safe: false, reason: '无法识别题型: ' + q.type });
        }
      } catch (e) {
        report.push({ num: q.num, ok: false, safe: false, reason: e?.message });
      }
    }

    // 统计
    const okCount = report.filter(r => r.ok).length;
    log('填答完成: ' + okCount + '/' + report.length);
    return report;
  }

  /* ============================================================
   * 4b. 截图解题（视觉兜底）
   * ============================================================ */

  /**
   * 把题目区域渲染成图片
   *
   * 为什么不用整屏截图：
   *   学习通是四层 iframe，整屏会把侧边栏、播放器一起截进来。
   *   这里算出题目区域的精确矩形，交给后台裁好。
   *
   * 题目比屏幕高时：
   *   自动滚动分屏，最多截 maxShots 张，避免漏题。
   *
   * 截图彻底不可用时：
   *   退回"把题目文字渲染成图片"—— 视觉模型主要看文字内容，
   *   这个降级方案在字体解码失败时依然有效。
   */
  async function captureQuizImage() {
    // 实测：学习通题目容器是 .TiMu（不是 .questionLi）
    let boxes = qAll('.TiMu');
    if (!boxes.length) boxes = qAll('.questionLi');
    if (!boxes.length) boxes = qAll('.singleQuesId');
    if (!boxes.length) throw new Error('没有题目区域可截图');

    const maxShots = Math.max(1, Math.min(6, (state.cfg.vision && state.cfg.vision.maxShots) || 3));

    const shots = [];

    // 记录原滚动位置，结束时还原，不打扰用户
    const scroller = document.scrollingElement || document.documentElement;
    const origScroll = scroller.scrollTop;

    try {
      // 先滚到题目顶部
      const first = boxes[0];
      const firstTop = first.getBoundingClientRect().top + scroller.scrollTop;
      scroller.scrollTop = Math.max(0, firstTop - 12);
      await sleep(350);

      for (let shotIdx = 0; shotIdx < maxShots; shotIdx++) {
        const r = await captureOnce(boxes);
        if (!r) break;

        shots.push(r.dataUrl);

        // 如果这次没被裁剪，说明整块都截到了，收工
        if (!r.clamped) break;

        // 否则往下翻一屏继续截
        const vh = window.innerHeight;
        const before = scroller.scrollTop;
        scroller.scrollTop = Math.min(
          scroller.scrollHeight,
          before + Math.max(200, vh * 0.82)
        );
        await sleep(400);

        // 到底了就不再截
        if (scroller.scrollTop <= before + 10) break;
      }
    } finally {
      scroller.scrollTop = origScroll;
    }

    if (!shots.length) throw new Error('截图失败（后台不可用或页面不可见）');

    return {
      ok: true,
      images: shots,
      dataUrl: shots[0],        // 兼容单图调用方
      mime: 'image/png',
      multi: shots.length > 1,
      count: shots.length
    };
  }

  /** 截一次当前可视区域里的题目部分 */
  async function captureOnce(boxes) {
    // 只统计当前可视范围内的题目
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const b of boxes) {
      const rc = b.getBoundingClientRect();
      if (rc.width < 2 || rc.height < 2) continue;
      if (rc.bottom < 0 || rc.top > window.innerHeight) continue;   // 不在视野内
      left = Math.min(left, rc.left);
      top = Math.max(0, Math.min(top, rc.top));
      right = Math.max(right, rc.right);
      bottom = Math.min(window.innerHeight, Math.max(bottom, rc.bottom));
    }
    if (!isFinite(left) || bottom <= top) return null;

    let shot = null;
    try {
      shot = await Host.send('page:screenshot', {
        rect: {
          x: Math.max(0, Math.floor(left)),
          y: Math.max(0, Math.floor(top)),
          w: Math.max(1, Math.ceil(right - left)),
          h: Math.max(1, Math.ceil(bottom - top))
        },
        dpr: window.devicePixelRatio || 1
      });
    } catch { /* 后台截图不可用 */ }

    if (shot?.ok && shot.dataUrl) {
      return { dataUrl: shot.dataUrl, clamped: !!shot.clamped };
    }

    // 降级：文字重绘
    const fallback = await renderTextToImage(boxes);
    return { dataUrl: fallback.dataUrl, clamped: false, degraded: true };
  }

  /** 降级：把抓到的题目文字画成图片 */
  async function renderTextToImage(boxes) {
    const lines = [];
    for (const b of boxes) {
      const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
      if (t) lines.push(t);
    }
    if (!lines.length) throw new Error('题目区域无文字');

    const PAD = 24;
    const LINE_H = 30;
    const FONT = '16px "Microsoft YaHei", sans-serif';
    const MAX_W = 900;

    // 先量文字宽度决定画布尺寸
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = FONT;

    const wrapped = [];
    for (const line of lines) {
      let cur = '';
      for (const ch of line) {
        if (measure.measureText(cur + ch).width > MAX_W - PAD * 2) {
          wrapped.push(cur);
          cur = ch;
        } else {
          cur += ch;
        }
      }
      if (cur) wrapped.push(cur);
      wrapped.push('');   // 题间空行
    }

    const W = MAX_W;
    const H = PAD * 2 + wrapped.length * LINE_H;

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000';
    ctx.font = FONT;
    ctx.textBaseline = 'top';

    wrapped.forEach((line, i) => {
      ctx.fillText(line, PAD, PAD + i * LINE_H);
    });

    return {
      ok: true,
      dataUrl: canvas.toDataURL('image/png'),
      mime: 'image/png',
      degraded: true,
      note: '降级模式：截图不可用，用题目文字重绘'
    };
  }

  /**
   * 判断「文本解出来的题」是否可信
   *
   * 这是「脚本判断」的一半 —— 脚本不直接决定用不用截图，
   * 而是给出一个不可靠信号，交给 runQuiz 综合决策。
   */
  function assessTextReliability(scraped) {
    const reasons = [];

    // 1. 字体解码置信度低
    const lowDecode = scraped.questions.filter(q =>
      q._decode && (q._decode.low > 0 || q._decode.avg < 0.9)
    );
    if (lowDecode.length) {
      reasons.push(lowDecode.length + ' 题字体解码置信度低');
    }

    // 2. 题干异常：过短、含大量生僻字、疑似仍是假字
    // 2. 题干异常：过短、含大量生僻字、疑似仍是假字
    for (const q of scraped.questions) {
      // 类型保护：title 可能是任意类型，先转成字符串
      let txt = q.title != null ? q.title : (q.text != null ? q.text : '');
      if (typeof txt !== 'string') {
        try { txt = String(txt); } catch { txt = ''; }
      }
      if (!txt || txt.length < 4) {
        reasons.push('第' + q.num + '题题干过短');
        continue;
      }
      // 生僻字比例：U+3400-4DBF、U+9FA6-9FFF 等少见区间
      const rare = [...txt].filter(ch => {
        const c = ch.codePointAt(0);
        return (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x9fa6 && c <= 0x9fff);
      }).length;
      if (rare / txt.length > 0.15) {
        reasons.push('第' + q.num + '题疑似仍有乱码');
      }
      // 明显没被替换掉的假字
      if (/[忞忖忟応忚忝忛忢忲忰忱]/.test(txt)) {
        reasons.push('第' + q.num + '题仍含混淆字符');
      }
    }

    // 3. 选项缺失（单选题没选项肯定不对）
    for (const q of scraped.questions) {
      if ((q.type === 'single' || q.type === 'multi') && q.options.length < 2) {
        reasons.push('第' + q.num + '题选项不足');
      }
    }

    return { reliable: reasons.length === 0, reasons };
  }

  /* ============================================================
   * 4c. 提交测验（跨 frame 处理确认弹窗）
   *
   * 实测链路（2026-10-21）：
   *   第1步  测验帧 点 a.btnSubmit  onclick="btnBlueSubmit();"
   *   第2步  顶层弹出 #workpop.maskDiv（display:none → block）
   *          内含 "提示 / 确认提交？" + #popok(提交) + #popno(取消)
   *   第3步  点 #popok 真正提交
   * ============================================================ */

  /** 安全取 document（跨域会抛错） */
  function safeDoc(win) {
    try {
      const d = win.document;
      return d && d.body ? d : null;
    } catch { return null; }
  }

  /** 收集可访问的 window（自己 + 各级父窗口） */
  function collectWindows() {
    const wins = [];
    try { if (safeDoc(window)) wins.push(window); } catch { /* ignore */ }

    let w = window;
    for (let i = 0; i < 5; i++) {
      try {
        if (!w.parent || w.parent === w) break;
        w = w.parent;
        if (safeDoc(w) && !wins.includes(w)) wins.push(w);
      } catch { break; }
    }

    try {
      if (window.top && window.top !== window && safeDoc(window.top) && !wins.includes(window.top)) {
        wins.push(window.top);
      }
    } catch { /* ignore */ }

    return wins;
  }

  /** 在某个 document 里找主提交按钮 */
  function findSubmitBtn(doc) {
    try {
      const direct = doc.querySelector('a.btnSubmit') || doc.querySelector('.btnSubmit');
      if (direct) {
        const r = direct.getBoundingClientRect();
        if (r.width > 0 || direct.offsetParent !== null) return direct;
      }
      for (const e of doc.querySelectorAll('a, button, input[type=button]')) {
        const t = (e.innerText || e.value || '').trim();
        if (/^提\s*交$/.test(t)) {
          const r = e.getBoundingClientRect();
          if (r.width > 0 || e.offsetParent !== null) return e;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  /** 元素是否真的可见（学习通弹窗常驻 DOM，只是 display:none） */
  function reallyVisible(el) {
    if (!el) return false;
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      let cs = null;
      try { cs = getComputedStyle(el); } catch { cs = null; }
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0')) return false;
      return true;
    } catch { return false; }
  }

  /**
   * 只在「弹窗内部」找确认按钮
   *
   * 为什么不全局找：主提交按钮的文字也是「提交」，如果弹窗还没出来就全局搜，
   * 会把主按钮当成确认按钮，反复点两次 —— 轻则弹两个框，
   * 重则把一次提交动作变成两次。
   */
  function findPopupConfirmBtn(doc) {
    try {
      const ok = doc.getElementById('popok');
      if (ok && reallyVisible(ok)) return ok;

      const boxes = ['#workpop', '.maskDiv', '.popDiv', '[class*="dialog"]', '[class*="modal"]'];
      for (const s of boxes) {
        let box = null;
        try { box = doc.querySelector(s); } catch { box = null; }
        if (!box || !reallyVisible(box)) continue;
        for (const e of box.querySelectorAll('a, button, input[type=button]')) {
          const t = (e.innerText || e.value || '').trim();
          if (!/^提\s*交$|^确\s*定$|^确\s*认$/.test(t)) continue;
          if (reallyVisible(e)) return e;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * 暂存答案（对应搜题酱 handleTmpSave）
   *
   * 什么时候用：有题目没把握（没核对上/不支持的题型），
   * 但用户开了「自动提交」。这时候**不能硬交** ——
   * 交上去就是零分/低分。学习通有「保存」按钮，先存着，
   * 提示用户自查后再手动提交。这是搜题酱的 doneFlags/
   * submitSafeFlags 安全网思路，成绩优先。
   */
  async function doTmpSave() {
    for (const win of collectWindows()) {
      const doc = safeDoc(win);
      if (!doc) continue;

      // 学习通有些版本把「保存」收在 .ZY_sub 菜单里，先展开
      try {
        const sub = doc.querySelector('.ZY_sub.clearfix, .ZY_sub');
        if (sub && reallyVisible(sub)) {
          sub.click();
          await sleep(500);
        }
      } catch { /* ignore */ }

      const sels = [
        'a.btnSave.workBtnIndex', 'a.btnSave', 'button.btnSave',
        '.btnSave.workBtnIndex', 'a[id^="btnSave"]'
      ];
      let btn = null;
      for (const s of sels) {
        const el = doc.querySelector(s);
        if (el && reallyVisible(el)) { btn = el; break; }
      }
      if (!btn) continue;

      try {
        btn.removeAttribute('href');
        btn.click();
        log('已点击「保存」暂存答案');
        await sleep(1500);
        return { ok: true };
      } catch { /* try next window */ }
    }
    return { ok: false, reason: '找不到保存按钮' };
  }

  /** 执行提交（含确认弹窗 / 及格线弹窗 / 分数读取） */
  async function doSubmitQuiz() {
    // 1. 找主提交按钮
    let mainBtn = null;
    for (const win of collectWindows()) {
      const doc = safeDoc(win);
      if (!doc) continue;
      const b = findSubmitBtn(doc);
      if (b) { mainBtn = b; break; }
    }
    if (!mainBtn) {
      log('提交失败：找不到提交按钮');
      return { ok: false, confirmed: false, reason: '找不到提交按钮' };
    }

    const epoch = state.routeEpoch;

    // 2. 点它（先摘 href 再点，搜题酱的细节处理）
    try {
      mainBtn.removeAttribute('href');
      mainBtn.click();
      log('已点击提交按钮');
    } catch (e) {
      return { ok: false, confirmed: false, reason: '点击失败' };
    }

    // 3. 等提交弹窗（最多 8 秒；#workpop 优先，其次按按钮文字找）
    let pop = null;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await sleep(200);
      if (isStale(epoch)) return { ok: false, stale: true, reason: '页面已切换，放弃提交' };
      for (const win of collectWindows()) {
        const doc = safeDoc(win);
        if (!doc) continue;
        const box = doc.getElementById('workpop');
        if (box && reallyVisible(box)) { pop = { doc, el: box }; break; }
        const b = findPopupConfirmBtn(doc);
        if (b) { pop = { doc, el: b }; break; }
      }
      if (pop) break;
    }

    // 4. 没弹窗 → 可能直接提交了
    if (!pop) {
      log('没检测到确认弹窗，可能已直接提交');
      return { ok: true, confirmed: false };
    }

    // 5. 弹窗正文：平台说「未做完」→ 取消提交（学习通拦下就是拦下）
    const popText = pop.doc.getElementById('popcontent')?.innerText || pop.el.innerText || '';
    if (/未做完|未完成|还有题目/.test(popText)) {
      const no = pop.doc.getElementById('popno');
      if (no) { no.removeAttribute('href'); no.click(); }
      log('提交被平台拦下：' + popText.replace(/\s+/g, ' ').slice(0, 60));
      return { ok: false, cancelled: true, reason: '平台提示还有题目未做完' };
    }

    // 6. 点确认
    try {
      await sleep(300);
      const okBtn = pop.doc.getElementById('popok') || findPopupConfirmBtn(pop.doc);
      if (!okBtn) return { ok: false, confirmed: false, reason: '找不到确认按钮' };
      okBtn.removeAttribute('href');
      okBtn.click();
      log('已点击确认弹窗的「提交」');
      await sleep(1800);
    } catch (e) {
      return { ok: false, confirmed: false, reason: '确认失败' };
    }

    // 7. 及格线弹窗：平台问「未达到及格线，是否继续」→ 取消，别硬交
    try {
      for (const win of collectWindows()) {
        const doc = safeDoc(win);
        if (!doc) continue;
        const focus = doc.getElementById('workpopFocus');
        if (!focus || !reallyVisible(focus)) continue;
        const t2 = doc.getElementById('popcontent')?.innerText || focus.innerText || '';
        if (/未达到及格线|不及格|低于及格线/.test(t2)) {
          const no = doc.getElementById('popno');
          if (no) { no.removeAttribute('href'); no.click(); }
          log('平台提示未达到及格线，已取消提交');
          return { ok: true, confirmed: true, passed: false, reason: '未达到及格线' };
        }
      }
    } catch { /* ignore */ }

    // 8. 读分数（有就记下来，状态栏给用户看）
    let score = '';
    try {
      for (const win of collectWindows()) {
        const doc = safeDoc(win);
        if (!doc) continue;
        const el = doc.querySelector('.dividerCon .achievement i, .achievement i');
        const t = (el?.innerText || '').trim();
        if (/^\d+(\.\d+)?$/.test(t)) { score = t; break; }
      }
    } catch { /* ignore */ }
    if (score) state.score = score;

    // 9. 关掉后续提示（如果有）
    for (const win of collectWindows()) {
      const doc = safeDoc(win);
      if (!doc) continue;
      for (const e of doc.querySelectorAll('a, button, input[type=button]')) {
        const t = (e.innerText || e.value || '').trim();
        if (!/^(知道了|确定|确认|关闭)$/.test(t)) continue;
        if (reallyVisible(e)) {
          try { e.click(); } catch { /* ignore */ }
          break;
        }
      }
    }

    return { ok: true, confirmed: true, score };
  }

  /** 调视觉模型解截图 */
  async function solveByVision() {
    setStatus('📷 截图解题中…', true);

    let img;
    try {
      img = await captureQuizImage();
    } catch (e) {
      setStatus('❌ 截图失败：' + e.message, false);
      return { ok: false, error: '截图失败：' + e.message };
    }

    // dataUrl -> base64（可能多张）
    const images = (img.images || [img.dataUrl]).map(u => u.split(',')[1]);

    let resp;
    try {
      resp = await Host.send('vision:answer', {
        images,
        mime: img.mime || 'image/png'
      });
    } catch (e) {
      return { ok: false, error: '视觉 API 连接失败：' + e.message };
    }

    if (!resp?.ok) {
      setStatus('❌ 视觉 API 失败：' + (resp?.error || '未知'), false);
      return { ok: false, error: resp?.error || '视觉 API 失败' };
    }

    const r = resp.result || {};
    setStatus('📷 视觉模型返回 ' + (r.answers?.length || 0) + ' 条答案' +
      (r.uncertain ? '（标注不确定）' : ''), false);

    return {
      ok: true,
      answers: r.answers || [],
      uncertain: !!r.uncertain,
      note: r.note || '',
      lowConfidenceNums: r.lowConfidenceNums || [],
      degraded: !!img.degraded,
      shotCount: images.length
    };
  }

  /* ============================================================
   * 4d. 视频弹题（播放中弹出的测验）
   *
   * 学习通视频播放到某些时间点会弹出题目，
   * 不答对视频就一直暂停。这里自动答掉。
   *
   * 实测 DOM（视频 iframe 内）：
   *   .x-container-default
   *     .ans-videoquiz .tkTopic
   *     .ans-videoquiz-opt  → [name="ans-videoquiz-opt"]
   *     #videoquiz-submit / #videoquiz-continue / #knowledgeBack
   * ============================================================ */

  /** 元素是否可见（含祖先链检查） */
  function isVisibleDeep(el) {
    try {
      if (!el) return false;
      const doc = el.ownerDocument;
      const win = doc?.defaultView;
      if (!win) return false;

      let node = el;
      while (node && node.nodeType === 1) {
        const cs = win.getComputedStyle(node);
        if (cs.display === 'none' || cs.visibility === 'hidden' ||
            cs.visibility === 'collapse' || cs.opacity === '0') {
          return false;
        }
        node = node.parentElement;
      }

      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch { return false; }
  }

  /** 找视频弹题的容器 */
  function findVideoQuizBox() {
    try {
      const container = q1('.x-container-default');
      if (!container) return null;
      const topic = container.querySelector('.ans-videoquiz .tkTopic');
      if (!topic) return null;
      if (!isVisibleDeep(container) || !isVisibleDeep(topic)) return null;
      return { container, topic };
    } catch { return null; }
  }

  /** 视频弹题是否正在显示 */
  function hasVideoQuiz() {
    return !!findVideoQuizBox();
  }

  /** 从选项文字里提取字母（兼容 "A 内容" / "A、内容" / "A，内容"） */
  function pickOptionLetter(text) {
    const m = String(text || '').trim().match(/^([A-Za-z])[、，,．.\s+]?/);
    return m ? m[1].toUpperCase() : '';
  }

  /** 抓取视频弹题的题目内容 */
  function scrapeVideoQuiz() {
    const box = findVideoQuizBox();
    if (!box) return null;

    const { container, topic } = box;

    // 题干
    const title = (topic.innerText || '').replace(/\s+/g, ' ').trim();

    // 题型
    let type = 'single';
    if (/多选/.test(title)) type = 'multi';
    else if (/判断/.test(title)) type = 'judge';
    else if (/填空/.test(title)) type = 'fill';

    // 选项
    const optEls = [...container.querySelectorAll('.ans-videoquiz-opt')];
    const options = optEls.map(el => {
      const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
      return {
        letter: pickOptionLetter(txt),
        text: txt,
        el
      };
    }).filter(o => o.letter);

    return { title, type, options, container };
  }

  /** 点击元素（先移除 href 防止默认行为干扰） */
  function safeClick(el) {
    if (!el) return false;
    try {
      el.removeAttribute('href');
      el.click();
      return true;
    } catch { return false; }
  }

  /**
   * 填写视频弹题的答案
   *
   * @returns {{ ok:boolean, filled:number, reason?:string }}
   */
  function fillVideoQuiz(scraped, answerLetters) {
    if (!scraped) return { ok: false, filled: 0, reason: '无题目' };

    const wants = answerLetters
      .map(x => String(x).trim().toUpperCase())
      .filter(x => /^[A-Z]$/.test(x));

    if (!wants.length) return { ok: false, filled: 0, reason: '答案格式不对' };

    let filled = 0;

    for (const opt of scraped.options) {
      const input = opt.el.querySelector('[name="ans-videoquiz-opt"]') ||
                    opt.el.querySelector('input');
      if (!input) continue;

      const shouldPick = wants.includes(opt.letter);

      try {
        if (scraped.type === 'multi') {
          // 多选：该选的点上，不该选的取消
          if (shouldPick && !input.checked) { input.click(); filled++; }
          else if (!shouldPick && input.checked) { input.click(); }
          else if (shouldPick) { filled++; }
        } else {
          // 单选/判断：只点目标
          if (shouldPick) {
            if (!input.checked) input.click();
            filled++;
            break;
          }
        }
      } catch { /* ignore */ }
    }

    return { ok: filled > 0, filled, reason: filled ? '' : '没点上' };
  }

  /**
   * 提交视频弹题并判断结果
   *
   * 参考实测逻辑：
   *   · 出现 #videoquiz-continue  → 答对了
   *   · 还有警告 + #videoquiz-submit 可见 → 答错，要重试
   *   · 还有警告 + #knowledgeBack 可见 → 答错
   *   · 都没了 → 成功
   *
   * @returns {{ status:string, reason?:string }}
   *   status: 'continued' | 'submitted' | 'retry' | 'failed'
   */
  async function submitVideoQuiz() {
    const box = findVideoQuizBox();
    const container = box?.container || q1('.x-container-default');
    if (!container) return { status: 'failed', reason: '找不到弹题容器' };

    const doc = container.ownerDocument;

    // 点提交
    const submitBtn = doc.getElementById('videoquiz-submit') ||
                      container.querySelector('#videoquiz-submit');
    if (!submitBtn) return { status: 'failed', reason: '找不到提交按钮' };

    safeClick(submitBtn);
    await sleep(2000);

    // 判断结果
    const spanNotBackPoint = doc.getElementById('spanNotBackPoint');
    const spanNot = doc.getElementById('spanNot');
    const hasWarning =
      (spanNotBackPoint && doc.defaultView?.getComputedStyle(spanNotBackPoint).display === 'block') ||
      (spanNot && doc.defaultView?.getComputedStyle(spanNot).display === 'block');

    const continueBtn = doc.getElementById('videoquiz-continue');
    const submitStill = doc.getElementById('videoquiz-submit');
    const knowledgeBack = doc.getElementById('knowledgeBack');

    // A. 出现「继续」→ 答对了
    if (isVisibleDeep(continueBtn)) {
      safeClick(continueBtn);
      return { status: 'continued', reason: 'continue_visible' };
    }

    // B. 还有警告 + 提交按钮可见 → 答错，重试
    if (hasWarning && isVisibleDeep(submitStill)) {
      return { status: 'retry', reason: 'submit_still_visible' };
    }

    // C. 还有警告 + 返回知识点 → 答错
    if (hasWarning && isVisibleDeep(knowledgeBack)) {
      safeClick(knowledgeBack);
      return { status: 'continued', reason: 'knowledge_back_visible' };
    }

    // D. 都没了 → 成功
    return { status: 'submitted' };
  }

  /**
   * 处理视频弹题（完整流程）
   *
   * @returns {boolean} true = 处理过弹题（本轮让位）
   */
  async function handleVideoQuiz() {
    const scraped = scrapeVideoQuiz();
    if (!scraped) return false;

    // 同一道题只处理一次，避免死循环
    const sig = scraped.title.slice(0, 60);
    if (sig && sig === state.videoQuizSig) {
      // 已经在处理同一题了，等一等
      await sleep(1500);
      return true;
    }
    state.videoQuizSig = sig;

    setStatus('📝 视频弹题：' + scraped.options.length + ' 个选项，请求答案…', true);
    log('视频弹题', scraped.title, scraped.options.map(o => o.letter));

    // 调 API
    let letters = null;

    try {
      // 优先用文本 API
      const payload = [{
        num: '1',
        type: scraped.type,
        text: scraped.title,
        options: scraped.options.map(o => ({
          letter: o.letter,
          text: o.text,
          value: o.letter
        }))
      }];

      const resp = await Host.send('quiz:answer', {
        questions: payload
      });

      if (resp?.ok && resp.result?.answers?.length) {
        const ans = resp.result.answers[0];
        const raw = Array.isArray(ans.answer) ? ans.answer : [ans.answer];
        letters = raw.map(x => String(x).trim()).join('').match(/[A-Za-z]/g) || [];
        letters = letters.map(x => x.toUpperCase());
      }
    } catch (e) {
      log('视频弹题 API 失败', e?.message);
    }

    if (!letters || !letters.length) {
      setStatus('⚠ 视频弹题：没拿到答案，请手动作答', false);
      state.videoQuizSig = '';   // 允许下轮重试
      return true;
    }

    // 最多重试 3 次
    for (let attempt = 1; attempt <= 3; attempt++) {
      const fill = fillVideoQuiz(scraped, letters);
      if (!fill.ok) {
        setStatus('⚠ 视频弹题：填答案失败（' + (fill.reason || '') + '）', false);
        return true;
      }

      const result = await submitVideoQuiz();

      if (result.status === 'continued' || result.status === 'submitted') {
        setStatus('✅ 视频弹题已答对', false);
        state.videoQuizSig = '';
        await sleep(1000);
        return true;
      }

      if (result.status === 'retry') {
        log('视频弹题答错，重试 ' + attempt + '/3');
        setStatus('⚠ 视频弹题答错，重试 ' + attempt + '/3', true);
        await sleep(1500);
        continue;
      }

      break;
    }

    setStatus('⚠ 视频弹题连续答错，请手动处理', false);
    state.videoQuizSig = '';
    return true;
  }

  /** 测验主流程：抓 → 判断可信度 → 文本答 / 截图答 → 填 */
  async function runQuiz() {
    if (!state.cfg.auto.quizEnabled) return false;
    if (!hasQuiz()) return false;
    if (state.quizRunning) return true;

    const scraped = await scrapeQuiz();
    if (!scraped.ok) return false;

    const sig = scraped.questions.map(q => (q.title || '').slice(0, 40)).join('|');
    if (sig && sig === state.quizDoneSig) return true;

    state.quizRunning = true;

    try {
      const visionCfg = state.cfg.vision || {};
      const visionOn = !!visionCfg.enabled && visionCfg.mode !== 'off';

      // ===== 脚本侧判断：文本可不可信 =====
      const assess = assessTextReliability(scraped);

      const wantVision =
        visionOn && (
          visionCfg.mode === 'always' ||       // 强制截图
          !assess.reliable                      // 文本不可靠
        );

      let answers = null;
      let usedVision = false;
      let visionMeta = null;

      if (wantVision && assess.reliable) {
        setStatus('📷 按设置使用截图解题', true);
      } else if (wantVision) {
        setStatus('⚠ ' + assess.reasons[0] + '，改用截图…', true);
      } else {
        setStatus('📝 检测到 ' + scraped.questions.length + ' 道题，请求 API…', true);
      }

      if (wantVision) {
        const vr = await solveByVision();
        if (vr.ok && vr.answers.length) {
          answers = vr.answers;
          usedVision = true;
          visionMeta = vr;
        } else if (!assess.reliable) {
          // 截图也失败，且文本本来就不可信 → 放弃，避免乱填
          setStatus('❌ 文本不可靠且截图失败：' + (vr.error || ''), false);
          state.quizDoneSig = sig;
          return true;
        }
        // 文本可信但截图失败 → 落到下面的文本流程
      }

      // ===== 文本流程 =====
      if (!answers) {
        const payload = scraped.questions.map(q => ({
          num: q.num, type: q.type, text: q.title || '', options: q.options.map(o => ({ letter: o.letter, text: o.text, value: o.value }))
        }));

        let resp;
        try {
          resp = await Host.send('quiz:answer', { questions: payload });
        } catch (e) {
          setStatus('❌ 无法连接后台（扩展是否被重新加载？）', false);
          return false;
        }

        if (!resp?.ok) {
          // 文本 API 失败 → 若开了视觉，再试一次截图
          if (visionOn && visionCfg.mode !== 'off') {
            setStatus('⚠ 文本 API 失败，改试截图…', true);
            const vr = await solveByVision();
            if (vr.ok && vr.answers.length) {
              answers = vr.answers;
              usedVision = true;
              visionMeta = vr;
            } else {
              setStatus('❌ 文本与截图均失败', false);
              state.quizDoneSig = sig;
              return true;
            }
          } else {
            setStatus('❌ API 失败：' + (resp?.error || '未知错误'), false);
            state.quizDoneSig = sig;
            return true;
          }
        } else {
          answers = resp.result?.answers || [];

          // ===== 模型侧判断：答得有没有把握 =====
          // 文本答题不带 confidence，但可以看模型是否漏题
          // 注意：q.num 可能是字符串（题目序号文字），API 返回的是数字，
          // 必须统一转成 Number 再比，否则会把答过的题误判为漏答，
          // 白白多截一次图（用户看到"文本成功了还在截图"）。
          const answeredNums = new Set(
            answers.map(a => Number(a.num)).filter(n => isFinite(n))
          );
          const missing = scraped.questions.filter(q => {
            const qn = Number(q.num);
            if (isFinite(qn)) return !answeredNums.has(qn);
            return !answers.some(a => String(a.num) === String(q.num));
          });

          if (missing.length && visionOn) {
            setStatus('⚠ 模型漏答 ' + missing.length + ' 题，补一次截图…', true);
            const vr = await solveByVision();
            if (vr.ok && vr.answers.length) {
              // 只补缺的，保留已有答案
              const have = new Map(answers.map(a => [Number(a.num), a]));
              for (const a of vr.answers) {
                if (!have.has(Number(a.num))) {
                  answers.push(a);
                  have.set(Number(a.num), a);
                }
              }
              usedVision = true;
              visionMeta = vr;
            }
          }

          if (!answers.length) {
            setStatus('❌ API 未返回答案', false);
            state.quizDoneSig = sig;
            return true;
          }
        }
      }

      // ===== 填写 =====
      if (!state.cfg.quiz.autoFill) {
        setStatus('✅ 已获取答案（未自动填写）', false);
        state.quizDoneSig = sig;
        log('答案', answers);
        return true;
      }

      const report = await fillAnswers(scraped.questions, answers);
      const ok = report.filter(r => r.ok).length;

      let statusText = (usedVision ? '📷 ' : '') + '✅ 已填写 ' + ok + '/' + report.length + ' 题';
      if (visionMeta && visionMeta.uncertain) {
        statusText += '（视觉模型标注不确定，请复核）';
      } else if (usedVision && visionMeta && visionMeta.degraded) {
        statusText += '（截图降级为文字重绘）';
      }

      setStatus(statusText, false);
      log('填写结果', report, { usedVision, visionMeta });
      state.quizDoneSig = sig;

      /* ── 提交安全网（搜题酱 doneFlags / submitSafeFlags 模型）──
       * 只有「每一题都真的填进去了、且核对通过」才自动提交。
       * 有一题没把握就只暂存，宁可让用户手动交，也不交一份烂卷。
       */
      const total = report.length;
      const okCount = report.filter(r => r.ok).length;
      const safeCount = report.filter(r => r.safe).length;
      const unsafe = report.filter(r => !r.safe);

      state.workSafe = {
        total,
        done: okCount,
        safe: safeCount,
        unsafeReason: unsafe.map(r => '第' + r.num + '题:' + (r.safeReason || r.reason || '未核对')).join('；')
      };

      const wantSubmit = !!state.cfg.quiz.autoSubmit && !(visionMeta && visionMeta.uncertain);
      const canSubmit = wantSubmit && total > 0 && safeCount === total;

      if (canSubmit) {
        setStatus('📤 全部 ' + total + ' 题已核对，提交…', true);
        const subResult = await doSubmitQuiz();
        if (subResult.ok) {
          let s = '📤 已提交';
          if (subResult.score) s += '，得分 ' + subResult.score;
          if (subResult.passed === false) s += '（未达到及格线，已取消提交）';
          setStatus(s, false);
        } else {
          setStatus(statusText + ' · 提交失败：' + (subResult.reason || '未知'), false);
        }
      } else if (wantSubmit && total > 0) {
        // 有题没核对上 → 不硬交，改暂存（成绩优先）
        const ts = await doTmpSave();
        setStatus(
          statusText + ' · ⚠ ' + (total - safeCount) + ' 题未核对通过，未自动提交' +
          (ts.ok
            ? '，已暂存答案，请自查后手动提交'
            : '（暂存失败：' + (ts.reason || '') + '），请自查后手动提交'),
          false
        );
        log('提交安全网拦截', state.workSafe);
      } else if (state.cfg.quiz.autoSubmit && visionMeta && visionMeta.uncertain) {
        setStatus(statusText + ' · 因视觉不确定未自动提交', false);
      } else if (!state.cfg.quiz.autoSubmit) {
        setStatus(statusText + ' · 未自动提交（请检查后手动提交）', false);
      }

      return true;
    } finally {
      state.quizRunning = false;
    }
  }

  /* ============================================================
   * 5. 下一节（仅顶层）
   * ============================================================ */

  /**
   * 翻到下一节 —— 优先走课程树，跳过已完成章节
   *
   * 用户要求：只看未完成的，已完成的直接跳过。
   *
   * 策略分三层：
   *   1. 课程树里找下一个未完成节点（最精准，能跳过完成项）
   *   2. 退化为点「下一节」按钮（顺序翻页，可能翻到已完成的）
   *   3. 都没找到 → 报告到底了
   */
  function clickNext() {
    // 平台已经把「下一节」藏起来了 → 整门课学完，别再点空气
    if (isCourseComplete()) {
      log('下一节按钮不可见，判定整门课已完成');
      return false;
    }

    // ── 第一层：课程树精准跳转 ──
    try {
      const nextNode = findNextUnfinishedNode();
      if (nextNode) {
        const name = (nextNode.querySelector('.posCatalog_name')?.textContent || '').trim().slice(0, 30);
        log('课程树跳转到未完成节点: ' + name);
        if (clickTreeNode(nextNode)) return true;
      }
    } catch (e) { log('课程树跳转失败', e?.message); }

    // ── 第二层：下一节按钮 ──
    for (const s of TP.NEXT) {
      const el = q1(s);
      if (!el) continue;
      const t = (el.innerText || '').trim();
      // 避免点到被隐藏的按钮
      if (el.offsetParent === null && t !== '下一节') continue;
      log('点击下一节按钮: ' + s);
      try {
        // 搜题酱细节：学习通常把 href 写成 javascript:;，
        // 直接点可能触发导航/刷新，先摘掉 href 再点更稳。
        el.removeAttribute('href');
        el.click();
        return true;
      } catch { /* ignore */ }
    }

    // ── 第三层：按文字找 ──
    const byText = qAll('a, button, span')
      .find(el => {
        const t = (el.innerText || '').trim();
        return /^下一节$/.test(t);
      });
    if (byText) {
      log('按文字点击下一节');
      try {
        byText.removeAttribute('href');
        byText.click();
        return true;
      } catch { /* ignore */ }
    }

    return false;
  }

  /**
   * 当前章节是否已经全部完成
   *
   * 用于判断「能不能直接跳下一节」，
   * 避免在没完成时跑掉（学习通会弹「还有任务点未完成」的确认框）。
   */
  /**
   * 解析 #_studystate（学习通自己的学习状态）
   *
   * 实测格式：value="{nextChapterId:1210130560,unfinishCount:93}"
   * 注意：键没有引号，不是合法 JSON，不能用 JSON.parse，只能正则提取。
   */
  function readStudyState() {
    try {
      const el = document.getElementById('_studystate');
      if (!el || !el.value) return null;
      const raw = el.value;
      const mNext = raw.match(/nextChapterId\s*:\s*(\d+)/);
      const mUnfinish = raw.match(/unfinishCount\s*:\s*(\d+)/);
      return {
        raw,
        nextChapterId: mNext ? mNext[1] : null,
        unfinishCount: mUnfinish ? +mUnfinish[1] : null
      };
    } catch { return null; }
  }

  /** 当前页面的 chapterId */
  function currentChapterId() {
    try {
      const m = location.href.match(/chapterId=(\d+)/);
      return m ? m[1] : null;
    } catch { return null; }
  }

  /** 取当前激活的课程树节点 */
  function currentNode() {
    try {
      return q1('.posCatalog_select.posCatalog_active')
          || q1('.posCatalog_select[class*="active"]')
          || q1('.posCatalog_select[class*="current"]');
    } catch { return null; }
  }

  /* ------------------------------------------------------------
   * 章节内标签切换
   *
   * 学习通一个章节常有多个标签：
   *   1学习要点   ← 纯文字说明，不是任务点
   *   2微课学习   ← 真正的视频任务点在这里
   *
   * 用户策略（方案 B）：任务点在别的标签时，自动切过去做完再翻页。
   * 只切「确实承载任务点」的标签，不瞎切。
   * ------------------------------------------------------------ */

  /** 列出本章节的所有标签 */
  function listChapterTabs() {
    try {
      return qAll('li[id^="dct"]').map(li => ({
        el: li,
        id: li.id,
        title: (li.getAttribute('title') || li.textContent || '').trim(),
        active: /active/.test(li.className || ''),
        cardId: li.getAttribute('cardid') || ''
      }));
    } catch { return []; }
  }

  /** 当前激活的标签 */
  function activeChapterTab() {
    return listChapterTabs().find(t => t.active) || null;
  }

  /**
   * 判断某个标签是不是「内容型」（可能承载任务点）
   *
   * 学习要点 / 本章小结 / 阅读书目 这类是纯文字，不是任务点
   */
  function isContentTab(title) {
    if (!title) return false;
    if (/学习要点|本章小结|阅读书目|讨论|笔记|标注/i.test(title)) return false;
    return /微课|视频|案例|拓展|课件|文档|PPT|教材|测验|作业/i.test(title);
  }

  /** 切换标签 */
  function switchToTab(tab) {
    if (!tab || !tab.el) return false;
    try {
      tab.el.click();
      log('切换标签到「' + tab.title + '」');
      return true;
    } catch (e) {
      log('切换标签失败', e?.message);
      return false;
    }
  }

  /**
   * 说明当前章节的任务点在哪个标签页
   *
   * 用于「本页干不了活」时给用户明确指引。
   */
  function describeWhereTaskPointIs() {
    try {
      const tabs = listChapterTabs();
      if (!tabs.length) return '';

      const cur = tabs.find(t => t.active);
      const curTitle = cur ? cur.title : '';

      for (const t of tabs) {
        if (t === cur) continue;
        if (isContentTab(t.title)) return t.title;
      }
      return curTitle;
    } catch { return ''; }
  }

  /**
   * 找下一个该去做的内容型标签
   *
   * @param {boolean} includeSelf 是否允许返回当前标签
   * @returns 标签对象 或 null
   */
  function findNextContentTab(includeSelf) {
    const tabs = listChapterTabs();
    if (tabs.length <= 1) return null;

    const curIdx = tabs.findIndex(t => t.active);

    // 当前就是内容型，且允许含自己 → 不用切
    if (includeSelf && curIdx >= 0 && isContentTab(tabs[curIdx].title)) return null;

    // 从当前位置往后找
    for (let i = curIdx + 1; i < tabs.length; i++) {
      if (isContentTab(tabs[i].title)) return tabs[i];
    }
    // 往回找
    for (let i = 0; i < curIdx; i++) {
      if (isContentTab(tabs[i].title)) return tabs[i];
    }
    return null;
  }

  /**
   * 找下一个「还没试过」的内容标签
   *
   * 为什么需要 tabTried：
   *   方案 B 会在标签间切换。如果两个内容标签都做完了，
   *   单纯的 findNextContentTab 会在两者之间无限来回切。
   *   记下试过的，全部试过就说明本节真的完了。
   */
  function findUntriedContentTab() {
    const tabs = listChapterTabs();
    if (tabs.length <= 1) return null;

    const tried = state.tabTried || [];
    const curIdx = tabs.findIndex(t => t.active);

    const order = [];
    for (let i = curIdx + 1; i < tabs.length; i++) order.push(tabs[i]);
    for (let i = 0; i < curIdx; i++) order.push(tabs[i]);

    for (const t of order) {
      if (!isContentTab(t.title)) continue;
      if (tried.includes(t.id)) continue;
      return t;
    }
    return null;
  }

  /**
   * 切到承载任务点的标签（方案 B）
   *
   * 严格按用户要求：只切「确实承载任务点」的内容型标签，
   * 切完等页面加载，然后继续由子 frame 干活。
   * 返回 true = 本次 tick 已处理完，调用方直接 return。
   */
  async function switchToTaskTab(fromTab, prefix) {
    try {
      if (fromTab?.id) {
        if (!Array.isArray(state.tabTried)) state.tabTried = [];
        if (!state.tabTried.includes(fromTab.id)) state.tabTried.push(fromTab.id);
      }

      const target = findUntriedContentTab();
      if (!target) return false;

      setStatus(prefix + target.title + '」，切换处理', true);

      const epoch = state.routeEpoch;
      if (!switchToTab(target)) return false;

      await sleep(2500);

      // 期间页面已经跳走 → 这次切换的后续动作全部作废（搜题酱 STALE 检查）
      if (isStale(epoch)) {
        log('切换标签期间路由已变化，丢弃本次后续动作');
        return true;
      }

      // 主动换代际：旧标签里在途的异步操作不许写回新标签
      bumpRouteEpoch();
      scrollTicksCleanup();
      state.docDone = false;
      state.docNextAt = 0;
      state.videoDone = true;
      state.videoPercent = 0;
      state.quizDoneSig = '';
      return true;
    } catch (e) {
      log('切换任务标签失败', e?.message);
      return false;
    }
  }

  /**
   * 当前标签的内容是否已经做完
   *
   * 注意：视频/题目可能在子 iframe 里，本帧查询不到，
   * 所以「本帧没内容」不能直接判定为做完，要保守返回 false。
   */
  function currentTabContentDone() {
    try {
      // 有视频没播完
      const v = q1('video');
      if (v) {
        if (!isFinite(v.duration) || v.duration <= 0) return false;   // 时长没出来 → 没做完
        const th = readVideoThreshold();
        if (v.currentTime / v.duration < th) return false;
      }

      // 有题目没做
      if (hasQuiz()) return false;

      // 有文档没滚到底
      if (!state.docDone && findScrollTarget()) return false;

      return true;
    } catch { return false; }
  }

  /**
   * 视频看完后，下滑检查这一页还有没有别的任务点
   *
   * 用户要求：视频看完不要直接切标签，
   *          先往下滚看看还有没有测验/文档等任务点。
   *
   * @returns {boolean} true = 做了滚动动作，应该让位
   */
  async function scrollToFindMoreTask() {
    try {
      const se = document.scrollingElement || document.documentElement;
      if (!se) return false;

      const maxTop = se.scrollHeight - se.clientHeight;
      if (maxTop < 200) return false;

      const now = Date.now();
      if (state.docNextAt && now < state.docNextAt) return true;

      const cur = se.scrollTop;
      if (cur >= maxTop - 20) {
        state.docDone = true;
        return false;
      }

      const vh = se.clientHeight || window.innerHeight;
      const step = Math.max(150, Math.round(vh * 0.75));
      const next = Math.min(cur + step, maxTop);

      se.scrollTop = next;
      try { se.dispatchEvent(new Event('scroll', { bubbles: true })); } catch { /* ignore */ }

      state.docNextAt = now + 1500;
      state.docTarget = '整页';
      return true;
    } catch { return false; }
  }

  /**
   * 采集当前章节的任务点明细
   *
   * 关键：.ans-job-icon 在 cards 帧（子 iframe），顶层查不到。
   * 所以用缓存 + 子帧主动上报的方式。
   *
   * 子帧在 runVideo / runQuiz 里会调用 reportTaskDetail() 上报，
   * 顶层从 state.taskDetailCache 里读。
   */
  function collectTaskPointDetail() {
    try {
      // ① 本帧有就直接采（cards 帧会走这里）
      const icons = qAll('[class*="ans-job-icon"]');
      if (icons.length) {
        const items = icons.map((el, i) => {
          const cls = (el.className || '').toString();
          const aria = el.getAttribute('aria-label') || '';
          const done = /任务点已完成/.test(aria);

          let kind = '任务';
          if (/ans-job-video/.test(cls)) kind = '视频';
          else if (/ans-job-work|ans-job-homework/.test(cls)) kind = '测验';
          else if (/ans-job-doc|ans-job-insertdoc/.test(cls)) kind = '文档';
          else if (/ans-job-pdf/.test(cls)) kind = 'PDF';

          if (kind === '任务') {
            try {
              const card = el.closest('.ans-attach-ct, .ans-attach-online') || el.parentElement;
              const t = (card?.innerText || '').slice(0, 40);
              if (/测验|作业|测试/.test(t)) kind = '测验';
              else if (/视频|微课/.test(t)) kind = '视频';
              else if (/文档|教材|PPT/i.test(t)) kind = '文档';
            } catch { /* ignore */ }
          }

          return { index: i + 1, kind, done };
        });

        const detail = { total: items.length, done: items.filter(x => x.done).length, items };
        // 缓存一份，供顶层用
        try { state.taskDetailCache = detail; } catch { /* ignore */ }
        return detail;
      }

      // ② 本帧没有 → 用缓存（顶层走这里）
      if (state.taskDetailCache && state.taskDetailCache.total > 0) {
        return state.taskDetailCache;
      }

      return null;
    } catch { return null; }
  }

  /**
   * 读平台的「视频任务点」完成状态
   *
   * 实测结构（学习通真实页面）：
   *
   *   已完成：
   *     <div class="ans-attach-ct videoContainer ans-job-finished">
   *       <div class="ans-job-icon ans-job-video ans-job-icon-clear"
   *            aria-label="任务点已完成">
   *
   *   未完成：
   *     <div class="ans-job-icon " aria-label="任务点未完成"></div>
   *
   * 优先读 aria-label（最直接），再退到 class 判断。
   *
   * @returns {{ done:boolean, source:string } | null}  null = 本页没有视频任务点
   */
  /**
   * 子帧上报任务点明细给顶层
   *
   * 因为 .ans-job-icon 只在 cards 帧里有，
   * 顶层要显示明细必须靠子帧上报。
   */
  function reportTaskDetail() {
    try {
      if (IS_TOP) return;   // 顶层不报，只收
      const detail = collectTaskPointDetail();
      if (!detail || !detail.total) return;

      Host.sendNoWait('frame:taskdetail', { detail });
    } catch { /* ignore */ }
  }

  /* ============================================================
   * 4c. 任务队列（蓝本：大学搜题酱 brushCx + CX_TASK_CATALOG，v1.3.0）
   *
   * 搜题酱刷课的核心不是「猜当前标签页」，而是：
   *   ① 扫出本节的 iframe 任务清单（任务卡在 cards 帧 d1 里）
   *   ② 用 URL 里的模块名判断任务类型（video / work / pdf / ...）
   *   ③ 按 DOM 顺序排队，一项一项做；队列耗尽才允许翻页
   *   ④ #prevNextFocusNext 被平台设成 display:none → 整门课学完
   *
   * 我们比它多做一步：完成状态读平台自己的任务点标记
   * （aria-label / .ans-job-finished），而不是只凭播放器进度推断。
   * ============================================================ */

  /**
   * 任务目录
   *
   * 原样移植自搜题酱的 CX_TASK_CATALOG（SideBar.d70b0916.js 模块 3oCgF）：
   *   helper       用哪个执行器（video=播放器，exam=答题）
   *   queueDrained 队列耗尽后的动作（text=纯图文，直接翻页）
   *   rawTypes     能映射到本类型的 URL 模块名
   */
  const CX_TASK_CATALOG = {
    video:        { helper: 'video', queueDrained: 'default', rawTypes: ['video'],        label: '视频' },
    audio:        { helper: 'video', queueDrained: 'default', rawTypes: ['audio'],        label: '音频' },
    pdf:          { helper: 'video', queueDrained: 'default', rawTypes: ['pdf'],          label: 'PDF' },
    work:         { helper: 'exam',  queueDrained: 'default', rawTypes: ['work'],         label: '测验' },
    pack:         { helper: 'exam',  queueDrained: 'default', rawTypes: ['pack'],         label: '作业包' },
    bbsReply:     { helper: 'exam',  queueDrained: 'none',    rawTypes: [],               label: '讨论回复' },
    bbsTopic:     { helper: 'exam',  queueDrained: 'default', rawTypes: [],               label: '讨论' },
    bbsTopicList: { helper: 'exam',  queueDrained: 'default', rawTypes: [],               label: '讨论列表' },
    text:         { helper: 'video', queueDrained: 'text',    rawTypes: [],               label: '图文' }
  };

  /**
   * 从 iframe 地址提取原始任务类型
   *
   * 实测任务地址形如：
   *   /mooc-ans/ananas/modules/video/index.html?...
   *   /mooc-ans/ananas/modules/work/index.html?...
   *   /mooc-ans/ananas/modules/pdf/index.html?...
   *   /mooc-ans/ananas/modules/zt/topicAttachment/...
   *
   * 正则与搜题酱一致：/\/ananas\/modules\/([^/?#]+)/
   */
  function extractCxRawTaskType(src) {
    if (!src) return '';
    let path = src;
    try {
      path = new URL(src, location.href).pathname;
    } catch { /* 相对地址就按原文匹配 */ }
    const m = path.match(/\/ananas\/modules\/([^/?#]+)/);
    if (m) return String(m[1]).toLowerCase();
    if (path.includes('/ananas/dialog/ballchart')) return 'ballchart';
    return '';
  }

  /** 原始类型 → 目录类型（找不到就返回空） */
  function resolveCxTaskType(raw) {
    if (!raw) return '';
    for (const type of Object.keys(CX_TASK_CATALOG)) {
      if (CX_TASK_CATALOG[type].rawTypes.includes(raw)) return type;
    }
    return '';
  }

  /** 类型的中文名 */
  function taskLabel(type) {
    return CX_TASK_CATALOG[type]?.label || (type ? String(type) : '任务');
  }

  /**
   * 是否支持自动处理
   *
   * 搜题酱 catalog 里没有的类型一律算「不支持」：
   *   innerbook / insertbbs / live / downloadfile / questionnaire / zt / flash / ballchart
   * 这类任务我们从队列里标 skipped，不阻塞翻页（用户可事后自查）。
   */
  function isSupportedCxTask(type) {
    return Object.prototype.hasOwnProperty.call(CX_TASK_CATALOG, type)
      && ['video', 'audio', 'pdf', 'work', 'pack', 'text'].includes(type);
  }

  /** 顶层：拿到 d1（knowledge/cards）文档；拿不到返回 null（跨域/尚未加载） */
  function getStudyDoc() {
    try {
      const fr = document.getElementById('iframe');
      return fr?.contentDocument || null;
    } catch { return null; }
  }

  /** 读任务点图标状态（平台标记优先，拿不到返回 null=未知） */
  function readIconDone(icon) {
    if (!icon) return null;
    try {
      const aria = icon.getAttribute('aria-label') || '';
      if (/任务点已完成/.test(aria)) return true;
      if (/任务点未完成/.test(aria)) return false;
      const cls = String(icon.className || '');
      if (/ans-job-icon-clear/.test(cls)) return true;
    } catch { /* ignore */ }
    return null;
  }

  /** 判断任务卡是否已完成（平台标记优先，拿不到返回 null=未知） */
  function readCardTaskDone(card) {
    if (!card) return null;
    try {
      if (/ans-job-finished/.test(String(card.className || ''))) return true;
      return readIconDone(card.querySelector('[class*="ans-job-icon"]'));
    } catch { return null; }
  }

  /**
   * 找 iframe 所在的任务卡（用于配对任务点图标）
   *
   * 实测 DOM 没有固定 class 包一层，所以逐层上溯：
   * 找到第一个「只含 1 个任务点图标」的祖先，才是这一项的卡片。
   * 直接取太高的祖先会把整页的图标都算进来，状态就串了。
   */
  function closestTaskCard(node) {
    try {
      let cur = node.parentElement;
      for (let i = 0; i < 8 && cur; i++) {
        const icons = cur.querySelectorAll?.('[class*="ans-job-icon"]');
        if (icons && icons.length === 1) return cur;
        if (icons && icons.length > 1) break;   // 已经到列表层，不能再往上
        cur = cur.parentElement;
      }
      return node.closest('.ans-attach-ct, .ans-attach-online, .ans-attach, .ans-card-wrap, .ans-job-wrap') || null;
    } catch { return null; }
  }

  /**
   * 扫描任务（对应搜题酱 brushCx 的 iframe 扫描）
   *
   * @param {Document} doc 默认当前文档；顶层传 d1 文档
   * @returns {Array} 任务列表
   */
  function scanCxTasks(doc) {
    const d = doc || document;
    const tasks = [];
    let iframes = [];
    try { iframes = [...d.getElementsByTagName('iframe')]; } catch { iframes = []; }

    for (let i = 0; i < iframes.length; i++) {
      const fr = iframes[i];
      const src = fr.getAttribute('src') || '';
      // 搜题酱的过滤：只认 /ananas/modules/ 和 ballchart
      if (!/\/ananas\/modules\//.test(src) && !/\/ananas\/dialog\/ballchart/.test(src)) continue;
      // 引用块里的 iframe 归 blockquote 管，避免重复
      try { if (fr.closest('.cmd-autoblockquote')) continue; } catch { /* ignore */ }

      const rawType = extractCxRawTaskType(src);
      let type = resolveCxTaskType(rawType) || rawType || 'unknown';

      // 作业包（zt/topicAttachment）：搜题酱根据「展开」按钮判定
      let packExpanded = false;
      if (rawType === 'zt') {
        try {
          const btn = fr.contentDocument?.querySelector('.pack-btn');
          packExpanded = !!btn && (btn.innerText || '').includes('展开');
        } catch { /* 跨域 */ }
      }
      const source = packExpanded ? 'pack' : 'iframe';

      const card = closestTaskCard(fr);
      let done = readCardTaskDone(card);
      if (done === null) {
        // 兜底：任务卡与 iframe 顺序一致，按序号配对
        try {
          const icons = d.querySelectorAll('[class*="ans-job-icon"]');
          done = readIconDone(icons[tasks.length]);
        } catch { /* ignore */ }
      }
      const title = (card?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40);

      tasks.push({
        order: tasks.length,
        index: i,
        src,
        rawType,
        source,
        type: packExpanded ? 'pack' : type,
        label: taskLabel(packExpanded ? 'pack' : type),
        supported: isSupportedCxTask(packExpanded ? 'pack' : type),
        done,
        title
      });
    }

    // 引用块（blockquote）里的任务：学习通把它塞在折叠块里，展开后才加载 iframe
    try {
      for (const wrap of d.querySelectorAll('.blockquote-wrap')) {
        const inner = wrap.querySelector('.cmd-autoblockquote');
        if (!inner) continue;
        const fr = inner.querySelector('iframe');
        const src = fr?.getAttribute('src') || '';
        const done = readCardTaskDone(wrap);
        tasks.push({
          order: tasks.length,
          index: fr ? iframes.indexOf(fr) : -1,
          src,
          rawType: 'work',
          source: 'blockquote',
          type: 'work',
          label: '测验（折叠）',
          supported: true,
          done,
          title: (wrap.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40)
        });
      }
    } catch { /* ignore */ }

    return tasks;
  }

  /**
   * 刷新任务队列
   *
   * 顶层从 d1 扫（任务卡在 cards 帧）。
   * 非顶层只扫自己文档（单层页面兜底），不覆盖顶层结果。
   */
  function refreshTaskQueue() {
    try {
      let tasks = null;

      if (IS_TOP) {
        const d1 = getStudyDoc();
        if (d1) tasks = scanCxTasks(d1);
        if ((!tasks || !tasks.length) && qAll('iframe[src*="/ananas/"]').length) {
          tasks = scanCxTasks(document);
        }
      } else {
        tasks = scanCxTasks(document);
      }

      if (!tasks) return state.taskQueue;

      const sig = tasks.map(t => [
        t.type, t.done === true ? 1 : t.done === false ? 0 : -1, t.supported ? 1 : 0
      ].join(':')).join('|');

      if (sig !== state.taskQueueSig) {
        state.taskQueueSig = sig;
        state.taskQueue = tasks;
        log('任务队列更新', tasks.map(t => t.label + (t.done === true ? '✓' : t.done === false ? '…' : '?')));
      }
      state.taskQueueAt = Date.now();
      return state.taskQueue;
    } catch { return state.taskQueue; }
  }

  /** 未完成且受支持的任务（只看未完成的 —— 用户明确要求） */
  function openCxTasks() {
    return state.taskQueue.filter(t => t.supported && t.done !== true);
  }

  /** 明确未完成的任务（done === false） */
  function todoCxTasks() {
    return state.taskQueue.filter(t => t.supported && t.done === false);
  }

  /** 不支持的任务（会被跳过，不阻塞） */
  function unsupportedCxTasks() {
    return state.taskQueue.filter(t => !t.supported && t.done !== true);
  }

  /** 队列是否全部完成（未知按已完成算，避免死等） */
  function isQueueDone() {
    return state.taskQueue.length > 0 && openCxTasks().length === 0;
  }

  /** 队列摘要，给状态栏用：任务 2/3 · 视频✓ 测验… */
  function queueSummary() {
    const q = state.taskQueue;
    if (!q.length) return '';
    const total = q.length;
    const done = q.filter(t => t.done === true).length;
    const cur = q.find(t => t.supported && t.done !== true);
    const bits = q.map(t => {
      let mark = '?';
      if (t.done === true) mark = '✓';
      else if (!t.supported) mark = '⏭';
      else mark = '…';
      return t.label + mark;
    });
    return '任务 ' + done + '/' + total
      + (cur ? ' · 当前：' + cur.label : '')
      + '（' + bits.join(' ') + '）';
  }

  /* ------------------------------------------------------------
   * 路由指纹 / 代际（对应搜题酱 routeEpoch）
   *
   * 学习通是 SPA：切标签、点下一节都会换 iframe，但顶层 href 不一定变。
   * 切完之后再拿「旧页面」的异步结果去操作新页面，会点错、填错。
   * 做法：每个异步步骤开始时记下 epoch，回来后比对，变了就放弃。
   * ------------------------------------------------------------ */

  function routeFingerprint() {
    let mainIframeSrc = '';
    let mainDocumentHref = '';
    try {
      const fr = document.getElementById('iframe');
      mainIframeSrc = fr?.src || '';
      try {
        mainDocumentHref = fr?.contentDocument?.URL
          || fr?.contentWindow?.location?.href || '';
      } catch { mainDocumentHref = ''; }
    } catch { /* ignore */ }
    return { href: location.href, mainIframeSrc, mainDocumentHref };
  }

  function sameRoute(a, b) {
    if (!a || !b) return false;
    return a.href === b.href
      && a.mainIframeSrc === b.mainIframeSrc
      && a.mainDocumentHref === b.mainDocumentHref;
  }

  /** 路由变了：代际 +1，让所有在途的异步步骤自行作废 */
  function bumpRouteEpoch() {
    state.routeEpoch++;
    state.routeFp = routeFingerprint();
    state.taskDetailCache = null;
    state.taskQueueSig = '';
  }

  /** 当前异步步骤是否已过期（路由变了） */
  function isStale(epoch) {
    return epoch !== state.routeEpoch;
  }

  /**
   * 整门课是否已学完（搜题酱的判据）
   *
   * 实测：最后一节时学习通把 #prevNextFocusNext 设成 display:none。
   * 这时点「下一节」没有意义，应当停止并提示用户。
   */
  function isCourseComplete() {
    try {
      const btn = document.querySelector('#prevNextFocusNext');
      if (btn) {
        const cs = getComputedStyle(btn);
        if (cs.display === 'none' || cs.visibility === 'hidden') return true;
        const r = btn.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  function readVideoTaskState() {
    try {
      // ① aria-label 最可靠
      const icons = qAll('[class*="ans-job-icon"]');
      for (const el of icons) {
        const aria = el.getAttribute('aria-label') || '';
        if (/任务点已完成/.test(aria)) {
          return { done: true, source: 'aria-label' };
        }
        if (/任务点未完成/.test(aria)) {
          // 继续找，可能还有别的（一页多个视频）
          continue;
        }
      }

      // ② 容器带 ans-job-finished
      const finished = qAll('.ans-job-finished');
      if (finished.length) {
        return { done: true, source: 'ans-job-finished' };
      }

      // ③ 有 ans-job-icon 且明确说未完成
      let hasIcon = false;
      for (const el of icons) {
        const aria = el.getAttribute('aria-label') || '';
        if (/任务点未完成/.test(aria)) hasIcon = true;
      }
      if (hasIcon) {
        return { done: false, source: 'aria-label-todo' };
      }

      // ④ 有视频图标但没明确标记 → 按 class 推断
      const videoIcons = qAll('.ans-job-icon.ans-job-video');
      if (videoIcons.length) {
        // 有 video 但没有 finished 标记 → 未完成
        return { done: false, source: 'icon-no-finished' };
      }

      return null;   // 本页没有视频任务点
    } catch { return null; }
  }

  /**
   * 检测平台是否限制了任务点（每日上限）
   *
   * 实测文案：
   *   今日视频任务点完成数已达上限，您可以观看视频，但无法完成任务点
   *   今日视频观看时长已达上限，您可继续观看视频，但无法完成任务点
   *
   * 命中时应该停止刷课，否则纯属浪费时间和账号风险。
   */
  function detectDailyLimit() {
    try {
      const txt = (document.body?.innerText || '').slice(0, 5000);
      if (/今日视频任务点完成数已达上限|今日视频观看时长已达上限/.test(txt)) {
        return { limited: true, reason: '今日视频任务点已达上限' };
      }
      // 有些版本提示文案不同
      if (/已达上限.{0,20}无法完成任务点/.test(txt)) {
        return { limited: true, reason: '今日任务点已达上限' };
      }
      return { limited: false };
    } catch { return { limited: false }; }
  }

  /**
   * 任务点四级校验（实测确认，见 docs/改造计划.md 11.4 / 11.6）
   *
   *   ① #_studystate 全局状态  —— 学习通自己维护的，最权威
   *   ② 当前树节点             —— .icon_Completed + .jobUnfinishCount
   *   ③ #jobhint               —— 本节课待完成计数
   *   ④ 视频实时进度            —— currentTime / duration >= 90%
   *
   * @returns {{ done:boolean, reason?:string, level?:string, ...extra }}
   */
  function isCurrentChapterDone() {
    try {
      const curChapter = currentChapterId();

      // ── ① 全局状态 ──
      const ss = readStudyState();
      if (ss && curChapter) {
        // 整个课程都完成了
        if (ss.unfinishCount === 0) {
          return { done: true, level: 'studystate', allCourseDone: true };
        }
        // nextChapterId 已指向别的章节 → 本节平台认为不用再学
        if (ss.nextChapterId && ss.nextChapterId !== curChapter) {
          // 但还要看本节点是否真的完成（nextChapter 可能是"下一个未完成"）
          const node = currentNode();
          const nodeDone = node ? !!node.querySelector(TP.DONE) : false;
          if (nodeDone) {
            return { done: true, level: 'studystate-next', nextChapterId: ss.nextChapterId };
          }
        }
      }

      // ── ② 当前树节点 ──
      const node = currentNode();
      if (node) {
        const isDone = !!node.querySelector(TP.DONE);
        const todoCnt = +(node.querySelector('.jobUnfinishCount')?.value || 0);
        if (!isDone || todoCnt > 0) {
          return {
            done: false,
            level: 'node',
            reason: '当前节点待完成 ' + todoCnt + ' 个',
            todoCount: todoCnt
          };
        }
      }

      // ── ③ jobhint ──
      const jh = document.getElementById('jobhint');
      if (jh) {
        const n = parseInt((jh.textContent || '').trim(), 10);
        if (isFinite(n) && n > 0) {
          return { done: false, level: 'jobhint', reason: '本节还有 ' + n + ' 个任务点' };
        }
      }

      // ── ④ 视频任务点：只看平台标记，不自己算进度 ──
      //
      // 踩过的坑（用户实测）：
      //   视频才播到 1:28/7:53（18%），平台已经标绿「任务点已完成」了。
      //   原因：学习通有每日限流 ——
      //     · 今日视频任务点完成数已达上限
      //     · 今日视频观看时长已达上限
      //   达到上限后，平台不再累计任务点，直接标成完成。
      //
      // 所以**不能用 currentTime/duration >= 0.9 判断**，
      // 必须读平台自己的标记：
      //   · .ans-job-finished         容器 class
      //   · aria-label="任务点已完成"   最直接
      //   · .ans-job-icon 是否有 video/clear
      const videoTask = readVideoTaskState();
      if (videoTask) {
        if (videoTask.done) {
          return { done: true, level: 'video-mark-done' };
        }
        // 平台明确说未完成
        return {
          done: false,
          level: 'video-mark-todo',
          reason: '视频任务点未完成（平台标记）',
          videoPercent: state.videoPercent
        };
      }

      // 没有视频任务点图标 → 当前页面不是视频类型，用兜底
      // 注意：这时才用进度判断，而且只作为参考
      const v = q1('video');
      if (v && isFinite(v.duration) && v.duration > 0) {
        const threshold = Number(state.cfg.auto.videoThreshold) || VIDEO_THRESHOLD;
        const pct = v.currentTime / v.duration;
        if (pct < threshold) {
          return {
            done: false,
            level: 'video',
            reason: '视频仅完成 ' + Math.round(pct * 100) + '%',
            videoPercent: pct
          };
        }
      }

      if (state.videoDone === false) {
        return {
          done: false,
          level: 'video-state',
          reason: '视频未达标 ' + Math.round((state.videoPercent || 0) * 100) + '%'
        };
      }

      return { done: true, level: 'all-clear' };
    } catch (e) {
      return { done: false, reason: '校验异常: ' + (e?.message || '') };
    }
  }

  /**
   * 处理「还有任务点未完成」的确认弹窗
   *
   * 学习通在翻页时会弹：「当前章节还有任务点未完成，是否去完成？」
   * 带「下一节 / 上一节」两个按钮。
   * 如果用户配了「跳过未完成任务」，就点下一节。
   */
  function handleIncompleteDialog() {
    try {
      const dialogs = qAll('.maskDiv.jobFinishTip, .maskDiv, .jobFinishTip, [class*=dialog], [class*=modal]');

      for (const d of dialogs) {
        // ── 关键：必须真的可见 ──
        // 坑：这个 div 一直存在于 DOM，只是默认 display:none。
        // 只判文字不看可见性，会误以为弹窗存在、每轮都去点，
        // 结果整条流程卡死在这一步。
        const rect = d.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) continue;
        let cs;
        try { cs = getComputedStyle(d); } catch { cs = null; }
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0')) continue;

        const txt = (d.innerText || '');
        if (!/还有任务点未完成/.test(txt)) continue;

        // 弹窗真的出现了 —— 点「下一节」
        const btns = [...d.querySelectorAll('a, button')];
        const nextBtn = btns.find(b => {
          const t = (b.innerText || '').trim();
          const r = b.getBoundingClientRect();
          return /^下一节$/.test(t) && r.width > 10 && r.height > 10;
        });

        if (nextBtn) {
          log('检测到「任务点未完成」弹窗（可见），点下一节');
          try { nextBtn.click(); return true; } catch { /* ignore */ }
        }

        // 没有「下一节」就点关闭，别让它挡着
        const closeBtn = btns.find(b => /popClose|closed02/.test(b.className || '')
          || /^(知道了|取消|关闭)$/.test((b.innerText || '').trim()));
        if (closeBtn) {
          log('关闭「任务点未完成」弹窗');
          try { closeBtn.click(); return true; } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    return false;
  }

  /* ============================================================
   * 6. 状态上报
   * ============================================================ */

  function setStatus(text, busy) {
    state.status = text;
    state.busy = !!busy;

    const now = Date.now();
    if (now - state.lastReport > 500) {
      state.lastReport = now;
      try {
        Host.sendNoWait('frame:status', {
          status: text,
          busy: !!busy
        });
      } catch { /* ignore */ }
    }

    if (IS_TOP) renderStatus();
  }

  /* ============================================================
   * 7. 主循环
   * ============================================================ */

  async function tick() {
    if (state.stopped) return;

    /* ── 路由指纹 / 代际（搜题酱 routeEpoch 思路）──
     * 学习通是 SPA：切标签时顶层 href 不变，只有 #iframe 的 src 会换。
     * 所以不能只比 location.href，要连 iframe src / iframe 文档地址一起比。
     * 变了就 +1 代际，让在途的异步步骤自行作废，避免把旧页面的
     * 填写结果/提交动作写到新页面上。 */
    const fp = routeFingerprint();
    if (!sameRoute(fp, state.routeFp)) {
      const prevHref = state.routeFp?.href || '';
      const prevChapter = prevHref.match(/chapterId=(\d+)/)?.[1] || '';
      const nowChapter = location.href.match(/chapterId=(\d+)/)?.[1] || '';
      const chapterChanged = !state.routeFp || prevChapter !== nowChapter;

      bumpRouteEpoch();
      state.routeFp = fp;

      if (chapterChanged) {
        state.tabTried = [];
        state.chapterEnterAt = Date.now();
        state.docDone = false;
        state.docNextAt = 0;
        state.quizDoneSig = '';
        state.quizSig = '';
        state.videoDone = true;
        state.videoPercent = 0;
        scrollTicksCleanup();
      }
      log('路由变化 → 代际 ' + state.routeEpoch + (chapterChanged ? '（换节）' : '（页内切换）'));
    }

    // 页面跳转了 → 重置
    if (location.href !== state.lastHref) {
      state.lastHref = location.href;
      state.quizDoneSig = '';
      state.quizSig = '';
      scrollTicksCleanup();
      state.docDone = false;
      state.docNextAt = 0;
    }

    if (state.cfg.auto.antiPause) patchWindow(window);

    // 风控页优先：命中就立刻停
    checkLockSignals();
    if (state.antispider) {
      setStatus('⚠ 检测到平台验证，已停止。请在页面上完成验证', false);
      state.stopped = true;
      return;
    }

    // 每日任务点上限：命中就停，别白刷（也降低风控风险）
    if (IS_TOP) {
      const lim = detectDailyLimit();
      if (lim.limited) {
        setStatus('⏸ ' + lim.reason + '，今天无法再完成任务点。已停止', false);
        state.stopped = true;
        return;
      }
    }

    // 子帧：把本帧看得到的任务点明细上报给顶层（面板要用）
    if (!IS_TOP) reportTaskDetail();

    /* ────────────────────────────────────────────
     * 顶层：只做协调，不碰内容
     *
     * 顶层文档是页面外框（导航、目录、按钮），
     * 真正的视频/文档/测验都在子 iframe 里。
     * 顶层滚自己的文档只会让「下一节」露出来，
     * 不能替代学习行为 —— 所以不在这里滚。
     * ──────────────────────────────────────────── */
    if (IS_TOP) {
      // 注意：不主动切换标签！
      // 用户要求的是「在当前标签里滚到底，然后点下一节」，
      // 而不是替用户切换到他想要的标签。
      // 只看当前标签的内容：有视频就播、有文档就滚、有题就答，
      // 都没有就滚到底点下一节。

      // 顶层也检测视频弹题（弹题可能在顶层 iframe）
      if (await handleVideoQuiz()) return;

      // 顶层也可能直接承载内容（单层页面、或学习通把视频放顶层时），
      if (await runVideo()) {
        const v = qAll('video')[0];
        const rate = v ? (v.playbackRate || 1) : 1;
        const rateText = Math.abs(rate - 1) < 0.05 ? '1x' : rate + 'x';
        if (v && !v.paused) {
          if (state.speedGiveUp) {
            setStatus('▶ 视频播放中（' + rateText + '·平台锁定倍速，已自动放弃加速）', true);
          } else if (state.speedLocked) {
            setStatus('▶ 视频播放中（' + rateText + '·本节点已锁定倍速）', true);
          } else {
            setStatus('▶ 视频播放中（' + rateText + '）', true);
          }
          return;
        }
        if (v && v.paused) {
          setStatus('⚠ 视频未能播放，请在播放器上手动点一下播放', false);
          return;
        }
      }
      // 测验优先：页面上有题目时先把题做了，别去滚文档
      if (hasQuiz()) {
        const did = await runQuiz().catch(e => { log('测验异常', e?.message); return false; });
        if (did) return;
      }
      // ⚠️ 顶层不滚自己的文档！
      // 顶层的滚动条是页面外框（目录树、按钮区），
      // 滚它不代表学习行为，还会让扩展误以为"还有活要干"而卡住。
      // 真正的文档滚动交给子 frame（cards 帧）。
      await tickTop();
      return;
    }

    /* ────────────────────────────────────────────
     * 子 frame：处理自己文档里的内容
     * ──────────────────────────────────────────── */

    // (0) 视频弹题优先！播放中弹题不答，视频会一直卡住
    if (await handleVideoQuiz()) return;

    // (1) 视频
    if (await runVideo()) {
      const v = qAll('video')[0];
      const rate = v ? (v.playbackRate || 1) : 1;
      const rateText = Math.abs(rate - 1) < 0.05 ? '1x' : rate + 'x';

      if (v && !v.paused) {
        if (state.speedGiveUp) {
          setStatus('▶ 视频播放中（' + rateText + '·平台锁定倍速，已自动放弃加速）', true);
        } else if (state.speedLocked) {
          setStatus('▶ 视频播放中（' + rateText + '·本节点已锁定倍速）', true);
        } else {
          setStatus('▶ 视频播放中（' + rateText + '）', true);
        }
        return;   // 还在播，本 frame 有事做
      }
    }

    // (2) 测验优先：有题目先做题，别滚文档
    if (hasQuiz()) {
      const did = await runQuiz().catch(e => { log('测验异常', e?.message); return false; });
      if (did) return;
    }

    // (3) 文档 / PPT —— 1.5 秒一屏往下看
    if (!state.docDone && await runDocument()) {
      setStatus('📄 浏览中（' + (state.docTarget || '内容区') + '）', true);
      return;
    }

    // 本 frame 没事做了
    setStatus('✓ 本区域完成', false);
  }

  /**
   * 顶层协调逻辑
   *
   * 判断顺序：
   *   1. 有 frame 在忙 → 等
   *   2. 本节还有内容没看完 → 等（子 frame 在滚）
   *   3. 全都完成了 → 翻到下一个未完成章节
   */
  /**
   * 顶层协调
   *
   * 核心原则（用户要求）：**任务点没完成，绝不翻页。**
   *
   * 判断顺序：
   *   1. 有 frame 在忙（在播视频/做题目）→ 等
   *   2. 任务点四级校验没过 → 等，并在状态栏说明卡在哪
   *   3. 全都完成 → 翻到下一个未完成章节
   */
  async function tickTop() {
    // ── 0. 先刷新任务队列，面板要跟着动 ──
    refreshTaskQueue();

    // ── 1. 有 frame 在忙就先等着 ──
    let busyElsewhere = false;
    try {
      const r = await Host.send('tab:busy');
      busyElsewhere = !!r?.busy;
      // 子帧上报的任务点明细（d1 才看得到 .ans-job-icon）经后台带回来
      if (r?.agg?.detail) state.taskDetailCache = r.agg.detail;
    } catch { busyElsewhere = false; }

    if (busyElsewhere) {
      const qs = queueSummary();
      setStatus('⏳ 学习进行中…' + (qs ? ' · ' + qs : ''), true);
      return;
    }

    // ── 2. 处理「还有任务点未完成」的确认弹窗 ──
    if (handleIncompleteDialog()) {
      setStatus('⏭ 已处理任务点弹窗', false);
      await sleep(2000);
      return;
    }

    /* ────────────────────────────────────────────────
     * 3. 任务队列：只看还没完成的（搜题酱模型，v1.3.0）
     *
     * 顺序（用户要求，别搞反）：
     *   a. 当前标签的队列做完 → 先下滑确认没别的任务点
     *   b. 再切到「还没试过的」内容标签（方案 B）
     *   c. 队列全部完成 → 才允许翻页
     * ──────────────────────────────────────────────── */

    const curTab = activeChapterTab();
    const queueDone = isQueueDone();
    const chk = isCurrentChapterDone();

    // 3.0 整门课学完：平台把「下一节」按钮藏起来了（搜题酱判据）
    if (isCourseComplete() || (readStudyState()?.unfinishCount === 0)) {
      setStatus('🎓 整门课程已全部学完' + (state.score ? '，最近得分 ' + state.score : ''), false);
      state.stopped = true;
      return;
    }

    if (!queueDone && !chk.done) {
      // ① 当前是纯文字标签 → 切到内容型（任务点所在标签）
      if (curTab && !isContentTab(curTab.title)) {
        if (await switchToTaskTab(curTab, '↪ 任务点在「')) return;
      }

      // ①.5 当前标签的队列做完了 → 先下滑，别急着切（用户明确要求）
      if (curTab && isContentTab(curTab.title) && currentTabContentDone() && !state.docDone) {
        if (await scrollToFindMoreTask()) {
          setStatus('📄 「' + curTab.title + '」任务点完成，下滑检查其他任务点…', true);
          return;
        }
      }

      // ② 当前内容型标签做完 → 切到下一个「没试过的」内容标签
      if (curTab && isContentTab(curTab.title) && currentTabContentDone()) {
        if (await switchToTaskTab(curTab, '↪ 「' + curTab.title + '」已处理完，切到「')) return;
      }
    }

    // ── 任务点校验 ──
    const chapterOk = queueDone || chk.done;

    if (!chapterOk) {
      // A. 视频未达标 → 显示实时进度 + 平台要求的阈值
      if (chk.level === 'video' || chk.level === 'video-state' || chk.level === 'video-mark-todo') {
        const pct = Math.round((chk.videoPercent ?? state.videoPercent ?? 0) * 100);
        const need = Math.round((readVideoThreshold() || state.cfg.auto.videoThreshold || 0.9) * 100);
        const qs = queueSummary();
        setStatus('📺 视频 ' + pct + '% / 需 ' + need + '%' + (qs ? ' · ' + qs : ''), true);
        await sleep(state.cfg.auto.loopInterval || 2500);
        return;
      }

      // B. 当前页面还有活可干 → 状态栏显示明细
      const hasVideoHere = !!q1('video');
      const hasQuizHere = hasQuiz();
      const hasDocHere = !IS_TOP && !state.docDone && !!findScrollTarget();

      if (hasVideoHere || hasQuizHere || hasDocHere) {
        let msg = '⏳ ';

        if (hasVideoHere) {
          const v = q1('video');
          const pct = v && isFinite(v.duration) && v.duration > 0
            ? Math.round(v.currentTime / v.duration * 100) : 0;
          msg += '视频 ' + pct + '%';
        } else if (hasQuizHere) {
          const qn = qAll('.TiMu, .singleQuesId').length;
          const filled = qAll('.check_answer, .check_answer_dx').length;
          msg += '测验 ' + qn + ' 题（已填 ' + filled + ' 处）';
        } else {
          msg += '文档滚动中';
        }

        const qs = queueSummary();
        if (qs) msg += ' · ' + qs;
        setStatus(msg, true);
        await sleep(state.cfg.auto.loopInterval || 2500);
        return;
      }

      // C. 做不了 → 按配置
      const queueOpen = openCxTasks();
      const todo = queueOpen.length || chk.todoCount || 0;
      const where = describeWhereTaskPointIs();
      const qs = queueSummary();
      const unsup = unsupportedCxTasks();

      if (!state.cfg.auto.skipUnfinished) {
        setStatus(
          '⏸ 还有 ' + todo + ' 个任务点未完成' +
          (qs ? '（' + qs + '）' : '') +
          (where ? '，在「' + where + '」' : '') +
          '。请手动处理，或开启「跳过未完成」',
          false
        );
        state.stopped = true;
        return;
      }

      setStatus(
        '⏭ ' + (queueOpen.length
          ? '队列里还有 ' + queueOpen.map(t => t.label).join('、') + '，按设置跳过'
          : '任务点在' + (where ? '「' + where + '」' : '其它标签') + '，按设置跳过')
        + (unsup.length ? '（另有 ' + unsup.length + ' 个不支持的任务点已忽略）' : ''),
        false
      );
      await sleep(1200);
    }

    // ── 4. 队列 / 任务点都完成了 ──
    const finalQueue = state.taskQueue;
    const qDone = finalQueue.filter(t => t.done === true).length;
    const finalDetail = collectTaskPointDetail();
    const doneText = finalQueue.length
      ? '✓ 本节任务点完成 ' + qDone + '/' + finalQueue.length
      : (finalDetail
          ? '✓ 任务点全部完成 ' + finalDetail.done + '/' + finalDetail.total
          : '✓ 本节任务点已完成');

    if (!state.cfg.auto.autoNext) {
      setStatus(doneText + '（未开自动下一节）', false);
      return;
    }

    const dwellMs = (Number(state.cfg.auto.minDwellSeconds) || 0) * 1000;
    if (dwellMs > 0 && state.chapterEnterAt) {
      const stayed = Date.now() - state.chapterEnterAt;
      if (stayed < dwellMs) {
        setStatus(doneText + '，稍候翻页（' + Math.ceil((dwellMs - stayed) / 1000) + 's）', true);
        await sleep(dwellMs - stayed);
        if (!isCurrentChapterDone().done) return;
      }
    }

    setStatus('⏭ 切换到下一个未完成章节…', false);
    await sleep(1200);

    if (!clickNext()) {
      state.nextFailCount = (state.nextFailCount || 0) + 1;
      if (state.nextFailCount >= 3) {
        setStatus('✓ 已到最后一节，停止', false);
        state.stopped = true;
      } else {
        setStatus('⏳ 未找到下一节，重试 (' + state.nextFailCount + '/3)', false);
        await sleep(3000);
      }
      return;
    }

    // ── 6. 跳转成功，重置状态 ──
    state.nextFailCount = 0;
    state.tabTried = [];          // 新章节，标签重新计
    bumpRouteEpoch();
    scrollTicksCleanup();
    state.docDone = false;
    state.docNextAt = 0;
    state.videoDone = true;
    state.videoPercent = 0;
    state.lastHref = location.href;
    state.chapterEnterAt = Date.now();
  }

  async function loop() {
    while (!state.stopped) {
      try { await tick(); }
      catch (e) { log('主循环异常', e?.message); }
      await sleep(state.cfg.auto.loopInterval || 2500);
    }
  }

  function start() {
    if (!state.stopped) return;
    state.stopped = false;
    setStatus('启动中…', true);
    loop();
  }

  function stop() {
    state.stopped = true;
    // 如果停止前有需要人工注意的提示（如答案待复核），保留它，
    // 否则用户一停就看不见了。
    const important = /复核|不确定|失败|不可靠/.test(state.status || '');
    if (!important) setStatus('已停止', false);
    else setStatus(state.status + ' · 已停止', false);
  }

  /* ============================================================
   * 8. 悬浮面板（仅顶层）
   *
   * 样式与 DOM 已抽到 src/ui/panel.js（两个形态共用一套视觉）。
   * 这里只负责：把刷课状态喂给面板、把面板事件接回刷课逻辑。
   * ============================================================ */

  /** 面板需要的配置 */
  function panelCfg() {
    return state.cfg || FALLBACK_CFG;
  }

  /** 挂载（幂等） */
  function ensurePanel() {
    if (!IS_TOP || !document.body) return null;
    if (!window.CSPanel) {
      log('CSPanel 未加载，面板不可用');
      return null;
    }
    const box = window.CSPanel.mount({
      getCfg: panelCfg,
      onCfgChange: (auto) => {
        state.cfg = { ...state.cfg, auto };
        Host.sendNoWait('cfg:set', { patch: { auto } });
      },
      onStart: () => {
        Host.setRunning(true);
        start();
      },
      onStop: () => {
        Host.setRunning(false);
        stop();
      },
      onOpenOptions: () => Host.openOptions()
    });
    state.panel = box;
    return box;
  }

  /**
   * 渲染状态
   *
   * 三层信息：
   *   1. 状态文字（当前在干什么）
   *   2. 任务队列 / 任务点明细（哪些完成、哪些没完成）
   *   3. 进度条（完成比例）
   */
  function renderStatus() {
    if (!IS_TOP || !state.panel || !window.CSPanel) return;

    let detail = null;
    try { detail = collectTaskPointDetail(); } catch { /* ignore */ }

    window.CSPanel.render({
      status: state.status,
      queue: state.taskQueue || [],
      detail,
      videoPercent: state.videoPercent
    });
  }


  /* ============================================================
   * 9. 消息处理
   *
   * 用 Host.on 注册，不直接绑 chrome.runtime.onMessage ——
   * 脚本版由宿主的跨帧总线投递同样的消息，这里逻辑完全一致。
   * 回调收到 (msg, reply)，reply 用于同步应答（扩展侧会自动回 ack）。
   * ============================================================ */

  Host.on((msg, reply) => {
    const sendResponse = reply || (() => {});
    (async () => {
      try {
        switch (msg?.type) {
          case 'state:changed': {
            if (msg.running && state.stopped) start();
            else if (!msg.running && !state.stopped) stop();
            sendResponse({ ok: true });
            break;
          }
          case 'panel:mount': {
            if (IS_TOP) ensurePanel();
            sendResponse({ ok: true });
            break;
          }
          case 'quiz:scrape': {
            const r = await scrapeQuiz();
            sendResponse({
              ok: r.ok,
              reason: r.reason,
              questions: r.ok ? r.questions.map(q => ({
                num: q.num, type: q.type, text: q.title || '', options: q.options.map(o => ({ letter: o.letter, text: o.text, value: o.value }))
              })) : []
            });
            break;
          }
          case 'quiz:fill': {
            const r = await scrapeQuiz();
            if (!r.ok) { sendResponse({ ok: false, reason: r.reason }); break; }
            const report = await fillAnswers(r.questions, msg.answers || []);
            sendResponse({ ok: true, report });
            break;
          }
          case 'quiz:capture': {
            // 截图预览（诊断用）
            try {
              const img = await captureQuizImage();
              sendResponse({
                ok: true,
                dataUrl: img.dataUrl,
                images: img.images || [img.dataUrl],
                count: img.count || 1,
                multi: !!img.multi,
                mime: img.mime || 'image/png',
                degraded: !!img.degraded
              });
            } catch (e) {
              sendResponse({ ok: false, error: e.message });
            }
            break;
          }
          case 'quiz:assess': {
            // 诊断：文本可信度评估
            const s = await scrapeQuiz();
            if (!s.ok) { sendResponse({ ok: false, reason: s.reason }); break; }
            sendResponse({ ok: true, assess: assessTextReliability(s) });
            break;
          }
          case 'font:diagnose': {
            const r = window.CSFontDecoder ? window.CSFontDecoder.diagnose(document) : null;
            sendResponse({ ok: !!r, result: r });
            break;
          }
          case 'ping': {
            sendResponse({ ok: true, frame: IS_TOP ? 'top' : 'sub', href: location.href });
            break;
          }
          default:
            sendResponse({ ok: false, error: '未处理的消息: ' + msg?.type });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
  });

  /* ============================================================
   * 10. 启动
   * ============================================================ */

  const FALLBACK_CFG = {
    auto: { rate: 2, mute: true, autoNext: true, docAutoScroll: true, docStep: 400, loopInterval: 2500, antiPause: true, quizEnabled: true, debug: true },
    quiz: { autoFill: true, autoSubmit: false }
  };

  async function boot() {
    try {
      const cfg = await Host.getCfg();
      state.cfg = cfg || FALLBACK_CFG;
    } catch {
      state.cfg = FALLBACK_CFG;
    }
    if (!state.cfg?.auto) state.cfg = FALLBACK_CFG;

    if (IS_TOP) {
      const mount = () => {
        if (document.body) ensurePanel();
        else setTimeout(mount, 300);
      };
      mount();
      // 学习通是 SPA，面板可能被前端重渲染冲掉，定期补挂
      setInterval(() => ensurePanel(), 4000);
    }

    // 全局处于运行态时自动续跑
    try {
      if (await Host.getRunning()) start();
    } catch { /* ignore */ }

    log('注入完成', IS_TOP ? '顶层' : '子 frame', location.href.slice(0, 90));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  // 供控制台调试
  window.CS = {
    start, stop,
    scrape: scrapeQuiz,
    fill: fillAnswers,
    hasQuiz,
    panel: ensurePanel,
    state,
    // 视频弹题（调试用）
    hasVideoQuiz,
    scrapeVideoQuiz,
    fillVideoQuiz,
    submitVideoQuiz,
    handleVideoQuiz,
    // 任务点（调试用）
    readVideoTaskState,
    collectTaskPointDetail,
    isCurrentChapterDone,
    readVideoThreshold,
    // 任务队列（搜题酱模型，调试用）
    scanCxTasks,
    refreshTaskQueue,
    queueSummary,
    openCxTasks,
    isQueueDone,
    extractCxRawTaskType,
    isCourseComplete,
    routeFingerprint,
    // 面板（调试用：改完 state 可以主动重绘）
    setStatus,
    renderStatus,
    // 提交安全网（调试用）
    doSubmitQuiz,
    doTmpSave,
    get cfg() { return state.cfg; }
  };
}

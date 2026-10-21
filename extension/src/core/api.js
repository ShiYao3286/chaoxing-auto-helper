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

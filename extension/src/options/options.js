'use strict';

/* ============================================================
 * 设置页逻辑
 * ============================================================ */

const $ = s => document.querySelector(s);

function showMsg(el, text, kind = 'info') {
  el.textContent = text;
  el.className = 'msg show ' + kind;
}
function hideMsg(el) {
  el.className = 'msg';
  el.textContent = '';
}

/** 行内状态提示 */
function setInline(dotEl, msgEl, text, state) {
  if (dotEl) dotEl.className = 'dot-s' + (state ? ' ' + state : '');
  if (msgEl) msgEl.textContent = text;
  if (dotEl) dotEl.parentElement.style.display = 'flex';
}

let CFG = null;

/* ============================================================
 * 1. 读取 / 回填
 * ============================================================ */

async function loadCfg() {
  const r = await chrome.runtime.sendMessage({ type: 'cfg:get' });
  CFG = r?.cfg;
  if (!CFG) {
    showMsg($('#saveMsg'), '读取配置失败', 'err');
    return;
  }
  fillForm(CFG);
}

function fillForm(cfg) {
  const q = cfg.quiz || {};
  const v = cfg.vision || {};
  const a = cfg.auto || {};

  // 答题 API
  $('#provider').value = q.provider || 'openai';
  $('#endpoint').value = q.endpoint || '';
  $('#apiKey').value = q.apiKey || '';
  $('#model').value = q.model || '';
  $('#modelsUrl').value = q.modelsUrl || '';
  $('#temperature').value = q.temperature ?? 0.2;
  $('#extraHeaders').value = q.extraHeaders || '';
  $('#bodyTemplate').value = q.bodyTemplate || '';
  $('#responsePath').value = q.responsePath || '';
  $('#prompt').value = q.prompt || '';

  // 缓存过的模型列表
  if (Array.isArray(q.modelList) && q.modelList.length) {
    renderModelOptions(q.modelList);
  }

  // 视觉
  $('#visionEnabled').checked = v.enabled !== false;
  $('#visionMode').value = v.mode || 'auto';
  $('#visionSameApi').checked = v.useSameApi !== false;
  $('#visionEndpoint').value = v.endpoint || '';
  $('#visionApiKey').value = v.apiKey || '';
  $('#visionModel').value = v.model || '';
  $('#visionMaxShots').value = v.maxShots || 3;

  // 作答
  $('#autoFill').checked = q.autoFill !== false;
  $('#autoSubmit').checked = !!q.autoSubmit;

  // 刷课
  $('#rate').value = a.rate;
  $('#docStep').value = a.docStep;
  $('#loopInterval').value = a.loopInterval;
  $('#mute').checked = !!a.mute;
  $('#antiPause').checked = !!a.antiPause;
  $('#autoNext').checked = !!a.autoNext;
  $('#docAutoScroll').checked = !!a.docAutoScroll;
  $('#quizEnabled').checked = !!a.quizEnabled;
  $('#debug').checked = !!a.debug;

  toggleCustom();
  toggleVisionOwn();
  updateVisionBadge();
  updateEndpointPreview();
}

/** 自定义模式字段显隐 */
function toggleCustom() {
  const isCustom = $('#provider').value === 'custom';
  $('#customBox').classList.toggle('hidden', !isCustom);
}

/** 视觉独立配置显隐 */
function toggleVisionOwn() {
  const same = $('#visionSameApi').checked;
  $('#visionOwnBox').classList.toggle('hidden', same);
}

/** 视觉徽标 */
function updateVisionBadge() {
  const on = $('#visionEnabled').checked;
  const mode = $('#visionMode').value;
  const badge = $('#visionBadge');
  if (!on || mode === 'off') {
    badge.textContent = '未启用';
    badge.style.background = '#f0f3f4';
    badge.style.color = '#6e7781';
  } else if (mode === 'always') {
    badge.textContent = '总是截图';
    badge.style.background = '#fff4e5';
    badge.style.color = '#8a5300';
  } else {
    badge.textContent = '自动判断';
    badge.style.background = '#eef4ff';
    badge.style.color = '#1c4faa';
  }
}

/**
 * 实时预览接口地址最终会变成什么
 *
 * 用户经常只填到 /v1，直接 POST 会 404（真实踩过）。
 * 这里把补全后的实际地址显示出来，一眼看出对不对。
 */
function updateEndpointPreview() {
  const input = $('#endpoint');
  const box = $('#endpointPreview');
  const msg = $('#endpointPreviewMsg');
  if (!input || !box || !msg) return;

  const raw = input.value.trim();
  if (!raw) {
    box.style.display = 'none';
    return;
  }

  // 必须与 background.js 的 normalizeChatEndpoint 保持一致
  function normalize(u) {
    let s = u.replace(/\s+/g, '');
    if (/\/chat\/completions$/i.test(s)) return s;
    if (/\/chat$/i.test(s)) return s + '/completions';
    if (/\/completions$/i.test(s)) return s.replace(/\/completions$/i, '/chat/completions');
    s = s.replace(/\/+$/, '');
    if (/\/v\d+$/i.test(s)) return s + '/chat/completions';
    if (/\/api$/i.test(s)) return s + '/v1/chat/completions';
    try {
      const p = new URL(s);
      if (!p.pathname || p.pathname === '/') return s + '/v1/chat/completions';
    } catch { /* 非法 URL 原样返回 */ }
    return s;
  }

  const full = normalize(raw);
  const dot = box.querySelector('.dot-s');
  box.style.display = 'flex';

  if (full === raw) {
    dot.className = 'dot-s ok';
    msg.textContent = '将请求：' + full;
  } else if (/\/chat\/completions$/i.test(full)) {
    dot.className = 'dot-s wait';
    msg.textContent = '将自动补全为：' + full;
  } else {
    dot.className = 'dot-s';
    msg.textContent = '将请求：' + full;
  }
}

/** 渲染 datalist */
function renderModelOptions(models) {
  const dl = $('#modelList');
  dl.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    dl.appendChild(opt);
  }
  // 记到 CFG 里，这样保存时不会丢
  if (CFG) {
    CFG.quiz = CFG.quiz || {};
    CFG.quiz.modelList = models;
  }
}

/* ============================================================
 * 2. 收集表单
 * ============================================================ */

function collectForm() {
  const cfg = JSON.parse(JSON.stringify(CFG || {}));

  cfg.quiz = {
    ...(cfg.quiz || {}),
    provider: $('#provider').value,
    endpoint: $('#endpoint').value.trim(),
    modelsUrl: $('#modelsUrl').value.trim(),
    apiKey: $('#apiKey').value.trim(),
    model: $('#model').value.trim(),
    temperature: parseFloat($('#temperature').value) || 0.2,
    extraHeaders: $('#extraHeaders').value.trim(),
    bodyTemplate: $('#bodyTemplate').value.trim(),
    responsePath: $('#responsePath').value.trim(),
    prompt: $('#prompt').value,
    autoFill: $('#autoFill').checked,
    autoSubmit: $('#autoSubmit').checked,
    // 保留已拉取的模型列表缓存
    modelList: (cfg.quiz && Array.isArray(cfg.quiz.modelList)) ? cfg.quiz.modelList : []
  };

  cfg.vision = {
    ...(cfg.vision || {}),
    enabled: $('#visionEnabled').checked,
    mode: $('#visionMode').value,
    useSameApi: $('#visionSameApi').checked,
    endpoint: $('#visionEndpoint').value.trim(),
    apiKey: $('#visionApiKey').value.trim(),
    model: $('#visionModel').value.trim(),
    maxShots: parseInt($('#visionMaxShots').value, 10) || 3
  };

  cfg.auto = {
    ...(cfg.auto || {}),
    rate: parseFloat($('#rate').value) || 2,
    docStep: parseInt($('#docStep').value, 10) || 400,
    loopInterval: parseInt($('#loopInterval').value, 10) || 2500,
    mute: $('#mute').checked,
    antiPause: $('#antiPause').checked,
    autoNext: $('#autoNext').checked,
    docAutoScroll: $('#docAutoScroll').checked,
    quizEnabled: $('#quizEnabled').checked,
    debug: $('#debug').checked
  };

  return cfg;
}

/** 只取当前表单里的 quiz/vision 片段（用于测试而不保存） */
function formQuizVision() {
  const f = collectForm();
  return { quiz: f.quiz, vision: f.vision };
}

/* ============================================================
 * 3. 保存
 * ============================================================ */

function validate(cfg) {
  if (cfg.quiz.provider === 'custom' && cfg.quiz.bodyTemplate) {
    try { JSON.parse(cfg.quiz.bodyTemplate); }
    catch { return '请求体模板不是合法 JSON'; }
  }
  if (cfg.quiz.extraHeaders) {
    try { JSON.parse(cfg.quiz.extraHeaders); }
    catch { return '额外请求头不是合法 JSON'; }
  }
  return null;
}

async function save(silent) {
  const msg = $('#saveMsg');
  const cfg = collectForm();

  const err = validate(cfg);
  if (err) { showMsg(msg, err, 'err'); return false; }

  const r = await chrome.runtime.sendMessage({ type: 'cfg:set', patch: cfg });
  if (r?.ok) {
    CFG = r.cfg;
    if (!silent) {
      showMsg(msg, '已保存', 'ok');
      setTimeout(() => hideMsg(msg), 2200);
    }
    return true;
  }
  showMsg(msg, '保存失败：' + (r?.error || '未知'), 'err');
  return false;
}

/* ============================================================
 * 4. 拉取模型列表
 * ============================================================ */

async function pullModels(which) {
  const isVision = which === 'vision';
  const dot = isVision ? $('#visionModelDot') : $('#modelDot');
  const msgEl = isVision ? $('#visionModelMsg') : $('#modelMsg');
  const btn = isVision ? $('#btnVisionModels') : $('#btnModels');

  btn.disabled = true;
  setInline(dot, msgEl, '拉取中…', 'wait');

  try {
    const { quiz, vision } = formQuizVision();

    const r = await chrome.runtime.sendMessage({
      type: 'api:testWith',
      what: 'models',
      quiz,
      vision
    });

    if (!r?.ok) {
      setInline(dot, msgEl, '拉取失败：' + (r?.error || '未知'), 'err');
      return;
    }

    renderModelOptions(r.models);
    setInline(dot, msgEl, `✅ 拉到 ${r.count} 个模型（${r.url}）`, 'ok');

    // 如果当前没填模型，自动选一个看起来合适的
    const targetInput = isVision ? $('#visionModel') : $('#model');
    if (!targetInput.value.trim() && r.models.length) {
      const pick = isVision
        ? r.models.find(m => /(vl|vision|gpt-4|gpt-4o|claude|gemini|glm-4v|qwen.*vl)/i.test(m))
        : r.models.find(m => /(gpt-4o-mini|gpt-4o|deepseek-chat|qwen-plus|gpt-3\.5)/i.test(m));
      if (pick) targetInput.value = pick;
      else targetInput.value = r.models[0];
    }

    // 同时把列表写进 datalist，方便两个输入框共用
    if (!isVision) {
      const dl = $('#modelList');
      if (!dl.children.length) renderModelOptions(r.models);
    }
  } catch (e) {
    setInline(dot, msgEl, '拉取异常：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

/* ============================================================
 * 5. 连通性测试
 * ============================================================ */

async function testApi() {
  const msg = $('#testMsg');
  showMsg(msg, '正在请求（最长 45 秒）…', 'info');

  try {
    const { quiz, vision } = formQuizVision();
    const r = await chrome.runtime.sendMessage({
      type: 'api:testWith',
      what: 'text',
      quiz,
      vision
    });

    if (!r?.ok) {
      showMsg(msg, '❌ ' + (r?.error || '未知错误'), 'err');
      return;
    }

    let text = `✅ 连通正常 · ${r.ms}ms · HTTP ${r.httpStatus}\n模型回显：${r.model || '(未返回)'}`;
    if (r.reply) text += `\n模型回复：${r.reply}`;
    showMsg(msg, text, 'ok');
  } catch (e) {
    showMsg(msg, '❌ ' + e.message, 'err');
  }
}

async function testQuiz() {
  const msg = $('#testMsg');
  showMsg(msg, '正在试答…', 'info');
  try {
    await save(true);   // 先落盘，因为用的是正式答题通道
    const r = await chrome.runtime.sendMessage({ type: 'quiz:test' });
    if (r?.ok) {
      const answers = r.result?.answers || [];
      if (answers.length) {
        const a = answers[0];
        showMsg(msg, '✅ 试答成功。示例题返回：' +
          (Array.isArray(a.answer) ? a.answer.join('') : a.answer), 'ok');
      } else {
        showMsg(msg, '接口通了但没解析出答案：' + JSON.stringify(r.result).slice(0, 300), 'info');
      }
    } else {
      showMsg(msg, '❌ ' + (r?.error || '未知'), 'err');
    }
  } catch (e) {
    showMsg(msg, '❌ ' + e.message, 'err');
  }
}

async function testVision() {
  const msg = $('#visionTestMsg');
  const btn = $('#btnTestVision');
  showMsg(msg, '正在请求（最长 2 分钟）…', 'info');
  btn.disabled = true;

  try {
    const { quiz, vision } = formQuizVision();
    const r = await chrome.runtime.sendMessage({
      type: 'api:testWith',
      what: 'vision',
      quiz,
      vision
    });

    if (!r?.ok) {
      showMsg(msg, '❌ ' + (r?.error || '未知错误'), 'err');
      return;
    }

    showMsg(msg, `✅ 视觉接口正常。模型：${r.model}，返回了 ${r.answerCount != null ? r.answerCount : r.answers?.length} 条答案结构。`, 'ok');
  } catch (e) {
    showMsg(msg, '❌ ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

/* ============================================================
 * 6. 诊断
 * ============================================================ */

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    return { ok: false, error: '页面未注入脚本（请刷新学习通页面后重试）' };
  }
}

async function diagnose() {
  const out = $('#diagOut');
  const msg = $('#diagMsg');
  hideMsg(msg);
  out.innerHTML = '';
  $('#shotPreview').innerHTML = '';

  const tab = await getActiveTab();
  if (!tab) { showMsg(msg, '没有活动标签页', 'err'); return; }

  const r = await sendToTab(tab.id, { type: 'font:diagnose' });
  if (!r?.ok) { showMsg(msg, r?.error || '诊断失败', 'err'); return; }

  const d = r.result;
  const sus = d.suspicious || [];
  const tg = d.targets || [];

  showMsg(msg,
    sus.length ? `检测到 ${sus.length} 个自定义字体` : '未检测到自定义字体，该页面可能没有字体反爬',
    sus.length ? 'ok' : 'info');

  let html = '<dl class="kv">';
  html += `<dt>@font-face 总数</dt><dd>${d.totalFaces}</dd>`;
  html += `<dt>可疑（反爬）字体</dt><dd>${sus.length}</dd>`;
  html += `<dt>系统可用中文字体</dt><dd>${d.systemFont || '(未检测到)'}</dd>`;
  html += `<dt>网格 / 一级字数</dt><dd>${d.gridSize || '?'}×${d.gridSize || '?'} / ${d.freqCharCount || '?'}</dd>`;
  html += '</dl>';

  if (sus.length) {
    html += '<h3 style="font-size:13px;margin:16px 0 8px">可疑字体</h3>';
    html += '<div style="font-size:12px;font-family:ui-monospace,Consolas,monospace">';
    for (const f of sus.slice(0, 12)) {
      html += `<div style="padding:6px 0;border-bottom:1px solid #eaedf0;word-break:break-all">`;
      html += `<b>${escapeHtml(f.family)}</b><br><span style="color:#6e7781">${escapeHtml(f.url.slice(0, 130))}</span></div>`;
    }
    html += '</div>';
  }

  if (tg.length) {
    html += '<h3 style="font-size:13px;margin:16px 0 8px">元素实际使用字体</h3>';
    html += '<div style="font-size:12px;font-family:ui-monospace,Consolas,monospace">';
    for (const t of tg) html += `<div style="padding:4px 0"><b>${escapeHtml(t.selector)}</b> → ${escapeHtml(t.family)}</div>`;
    html += '</div>';
  }

  out.innerHTML = html;
}

async function scrapeCurrentQuiz() {
  const out = $('#diagOut');
  const msg = $('#diagMsg');
  hideMsg(msg);
  out.innerHTML = '';
  $('#shotPreview').innerHTML = '';

  const tab = await getActiveTab();
  if (!tab) { showMsg(msg, '没有活动标签页', 'err'); return; }

  const r = await sendToTab(tab.id, { type: 'quiz:scrape' });
  if (!r?.ok) { showMsg(msg, r?.reason || r?.error || '抓取失败', 'err'); return; }

  const qs = r.questions || [];
  showMsg(msg, `抓到 ${qs.length} 道题`, 'ok');

  let html = '';
  for (const q of qs) {
    html += `<div style="padding:10px 0;border-bottom:1px solid #eaedf0">`;
    html += `<div style="font-weight:600"><span class="tag">${escapeHtml(q.type || q.typeLabel || '?')}</span> ${q.num}. ${escapeHtml(q.text || '')}</div>`;
    if (q.options?.length) {
      html += '<div style="margin-top:6px;color:#57606a;font-size:12px">';
      for (const o of q.options) html += `<div>${escapeHtml(o)}</div>`;
      html += '</div>';
    }
    if (q._decode) {
      const bad = (q._decode.low || 0) > 0;
      html += `<div style="margin-top:6px;font-size:11px;color:${bad ? '#c9252d' : '#17603a'}">`;
      html += `字体解码：${bad ? `⚠ ${q._decode.low} 字置信度低` : '✓ 全部高置信'}（均分 ${q._decode.avg}）`;
      html += '</div>';
    }
    html += '</div>';
  }
  out.innerHTML = html || '<div style="color:#6e7781">没有题目</div>';
}

/** 截图预览：验证截图能力是否可用 */
async function previewShot() {
  const out = $('#shotPreview');
  const msg = $('#diagMsg');
  hideMsg(msg);
  out.innerHTML = '';

  const tab = await getActiveTab();
  if (!tab) { showMsg(msg, '没有活动标签页', 'err'); return; }

  showMsg(msg, '截图中…', 'info');

  const r = await sendToTab(tab.id, { type: 'quiz:capture' });
  if (!r?.ok) {
    showMsg(msg, r?.error || '截图失败', 'err');
    return;
  }

  showMsg(msg, r.degraded
    ? '已生成（降级模式：用题目文字重绘）'
    : '截图成功', r.degraded ? 'warn' : 'ok');

  out.innerHTML =
    `<div style="font-size:12px;color:#6e7781;margin-bottom:8px">` +
    `${r.degraded ? '降级：文字重绘' : '真实截图裁剪'} · ${Math.round((r.dataUrl.length * 0.75) / 1024)} KB</div>` +
    `<img src="${r.dataUrl}" style="max-width:100%;border:1px solid #d8dee4;border-radius:8px">`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* ============================================================
 * 7. 绑定
 * ============================================================ */

document.addEventListener('DOMContentLoaded', async () => {
  await loadCfg();

  // 显隐联动
  $('#provider').addEventListener('change', toggleCustom);
  $('#visionSameApi').addEventListener('change', toggleVisionOwn);
  $('#visionEnabled').addEventListener('change', updateVisionBadge);
  $('#visionMode').addEventListener('change', updateVisionBadge);

  // 接口地址实时预览（防止只填到 /v1 导致 404）
  const ep = $('#endpoint');
  if (ep) {
    ep.addEventListener('input', updateEndpointPreview);
    ep.addEventListener('change', updateEndpointPreview);
  }

  // 主操作
  $('#btnSave').addEventListener('click', () => save(false));
  $('#btnTestApi').addEventListener('click', testApi);
  $('#btnTestQuiz').addEventListener('click', testQuiz);
  $('#btnTestVision').addEventListener('click', testVision);

  // 模型拉取
  $('#btnModels').addEventListener('click', () => pullModels('text'));
  $('#btnVisionModels').addEventListener('click', () => pullModels('vision'));

  // 诊断
  $('#btnDiag').addEventListener('click', diagnose);
  $('#btnScrape').addEventListener('click', scrapeCurrentQuiz);
  $('#btnShot').addEventListener('click', previewShot);

  // 恢复默认
  $('#btnReset').addEventListener('click', async () => {
    if (!confirm('恢复默认设置？API Key 也会被清空。')) return;
    await chrome.storage.local.set({ cfg: null });
    await chrome.runtime.sendMessage({ type: 'cfg:set', patch: {} });
    const r = await chrome.runtime.sendMessage({ type: 'cfg:get' });
    CFG = r?.cfg;
    fillForm(CFG);
    showMsg($('#saveMsg'), '已恢复默认', 'ok');
    setTimeout(() => hideMsg($('#saveMsg')), 2200);
  });

  // 版本
  try {
    $('#ver').textContent = chrome.runtime.getManifest().version;
  } catch { /* ignore */ }
});

'use strict';

/* ============================================================
 * 工具栏弹窗
 * ============================================================ */

const $ = s => document.querySelector(s);

let CFG = null;
let tabId = null;

/* ---------- 取当前标签页 ---------- */

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;

  const host = $('#host');
  try {
    host.textContent = new URL(tab.url).hostname;
  } catch {
    host.textContent = '不支持的页面';
  }

  const onSite = /chaoxing\.com|edu\.cn/i.test(tab?.url || '');
  if (!onSite) {
    $('#btnStart').disabled = true;
    $('#btnStart').textContent = '非学习通页面';
  }

  // 读配置
  const r = await chrome.runtime.sendMessage({ type: 'cfg:get' });
  CFG = r?.cfg;
  if (CFG) fillForm(CFG);

  // API 未配置提醒
  const q = CFG?.quiz || {};
  const hasKey = !!(q.endpoint && (q.apiKey || q.provider === 'custom'));
  $('#apiWarn').classList.toggle('hidden', hasKey);

  // 读运行态
  refreshState();
  setInterval(refreshState, 1000);
}

function fillForm(cfg) {
  const a = cfg.auto;
  $('#p-rate').value = a.rate;
  $('#p-mute').checked = !!a.mute;
  $('#p-next').checked = !!a.autoNext;
  $('#p-quiz').checked = !!a.quizEnabled;
}

/* ---------- 状态刷新 ---------- */

async function refreshState() {
  try {
    const st = await chrome.runtime.sendMessage({ type: 'state:get' });
    const running = !!st?.running;
    $('#dot').classList.toggle('on', running);

    let text = running ? '运行中' : '待机';
    if (tabId != null) {
      const agg = await chrome.runtime.sendMessage({ type: 'tab:agg', tabId });
      if (agg?.ok && agg.agg?.status) text = agg.agg.status;
    }
    $('#status').textContent = text;
  } catch { /* ignore */ }
}

/* ---------- 保存面板上的快捷开关 ---------- */

async function saveQuick() {
  const patch = {
    auto: {
      ...(CFG?.auto || {}),
      rate: parseFloat($('#p-rate').value) || 2,
      mute: $('#p-mute').checked,
      autoNext: $('#p-next').checked,
      quizEnabled: $('#p-quiz').checked
    }
  };
  const r = await chrome.runtime.sendMessage({ type: 'cfg:set', patch });
  if (r?.ok) CFG = r.cfg;
}

['#p-rate', '#p-mute', '#p-next', '#p-quiz'].forEach(s => {
  document.addEventListener('DOMContentLoaded', () => {
    const el = $(s);
    if (el) el.addEventListener('change', saveQuick);
  });
});

/* ---------- 按钮 ---------- */

document.addEventListener('DOMContentLoaded', () => {
  init();

  $('#btnStart').addEventListener('click', async () => {
    await saveQuick();
    await chrome.runtime.sendMessage({ type: 'state:set', running: true });
    if (tabId != null) {
      try { await chrome.tabs.sendMessage(tabId, { type: 'state:changed', running: true }); }
      catch { /* 页面未注入，需要刷新 */ }
    }
    refreshState();
  });

  $('#btnStop').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'state:set', running: false });
    if (tabId != null) {
      try { await chrome.tabs.sendMessage(tabId, { type: 'state:changed', running: false }); }
      catch { /* ignore */ }
    }
    refreshState();
  });

  $('#btnOptions').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
});

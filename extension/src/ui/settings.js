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

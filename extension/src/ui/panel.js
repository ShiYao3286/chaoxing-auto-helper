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

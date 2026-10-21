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

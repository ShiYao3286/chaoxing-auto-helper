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
    speedLocked: false,     // 平台提示「不可倍速」
    speedGiveUp: false,     // 试过被拒，永久放弃倍速
    speedReverts: 0,        // 倍速被改回的次数
    antispider: false       // 检测到风控验证页
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

  async function runVideo() {
    const vids = qAll('video');
    if (!vids.length) return false;

    checkLockSignals();

    // 检测到风控页：停止一切操作
    if (state.antispider) {
      setStatus('⚠ 检测到平台验证，已停止。请在页面上完成验证', false);
      state.stopped = true;
      return false;
    }

    let handled = false;

    for (const v of vids) {
      try {
        if (v.ended) continue;

        if (state.cfg.auto.mute) {
          try { v.muted = true; v.volume = 0; } catch { /* ignore */ }
        }

        // ── 顺序很重要：先让它真的播起来，再谈加速 ──
        // 反过来容易触发播放器的"异常行为"判定。
        if (v.paused) {
          try { await v.play(); } catch (e) { log('play() 被拒', e?.message); }

          if (v.paused) {
            await sleep(280);
            if (v.paused) {
              try { await v.play(); } catch { /* 再试一次 */ }
            }
          }
        }

        // 播起来了才动倍速
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
   * 3. 文档 / PPT（仅本文档）
   * ============================================================ */

  let scrollTicks = new WeakMap();

  function scrollTicksCleanup() {
    scrollTicks = new WeakMap();
  }

  async function runDocument() {
    if (!state.cfg.auto.docAutoScroll) return false;

    const panes = qAll('#panView, .insertdoc-online-pdf, .insertdoc, #docContainer, .pdfViewer, iframe[src*="pdf"]');
    if (!panes.length) return false;

    let handled = false;
    const step = Number(state.cfg.auto.docStep) || 400;

    for (const pane of panes) {
      let boxes;
      try {
        boxes = [pane, ...pane.querySelectorAll('*')]
          .filter(el => el && el.scrollHeight > el.clientHeight + 80);
      } catch { continue; }

      for (const box of boxes) {
        if (box === document.documentElement || box === document.body) continue;
        if ((scrollTicks.get(box) || 0) > 400) continue;

        const maxTop = box.scrollHeight - box.clientHeight;
        if (box.scrollTop >= maxTop - 10) { scrollTicks.set(box, 999); continue; }

        try {
          box.scrollTop = Math.min(box.scrollTop + step, maxTop);
          box.dispatchEvent(new Event('scroll', { bubbles: true }));
        } catch { /* ignore */ }
        scrollTicks.set(box, (scrollTicks.get(box) || 0) + 1);
        handled = true;
      }
    }
    return handled;
  }

  /* ============================================================
   * 4. 测验
   * ============================================================ */

  /** 本文档里是否有题目 */
  function hasQuiz() {
    return !!q1('.questionLi');
  }

  function judgeType(text) {
    if (/【单选题】|单选题/.test(text)) return 'single';
    if (/【多选题】|多选题/.test(text)) return 'multi';
    if (/【判断题】|判断题/.test(text)) return 'judge';
    if (/【填空题】|填空题/.test(text)) return 'fill';
    return 'unknown';
  }

  /** 抓题（含字体解码） */
  async function scrapeQuiz() {
    if (!window.CSFontDecoder) {
      // 字体解码器没加载时退化为直接读文本
      log('CFSFontDecoder 未加载，跳过字体解码');
    }

    const boxes = qAll('.questionLi');
    if (!boxes.length) return { ok: false, reason: '本文档无题目' };

    const questions = [];

    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const rawText = (b.innerText || '').replace(/\s+/g, ' ').trim();
      const type = judgeType(rawText);

      // 选项
      const opts = [];
      for (const o of [...b.querySelectorAll('span[class*="num_option"], .answerList dd, .option')]) {
        const txt = (o.innerText || '').replace(/\s+/g, ' ').trim();
        if (!txt) continue;
        const letter = txt.charAt(0).toUpperCase();
        if (!/^[A-Z]$/.test(letter)) continue;
        opts.push({ letter, text: txt.slice(1).trim(), el: o });
      }

      // 判断题：A 对 / B 错
      if (type === 'judge' && !opts.length) {
        const radios = [...b.querySelectorAll('input[type=radio], .radio, label')];
        const txts = radios.map(r => (r.innerText || r.value || '').trim()).filter(Boolean);
        if (txts.includes('对') || txts.includes('错')) {
          opts.push({ letter: 'A', text: '对', el: radios[0] });
          opts.push({ letter: 'B', text: '错', el: radios[1] });
        }
      }

      // 填空
      const fillFrames = [...b.querySelectorAll('iframe[id^="ueditor_"]')];

      // ---- 字体反爬解码 ----
      let realText = rawText;
      let decodeInfo = null;
      if (window.CSFontDecoder) {
        try {
          const probe = b.querySelector('p, .stem, .mark_name') || b;
          const r = await window.CSFontDecoder.decode(rawText, probe);
          if (r.map && Object.keys(r.map).length) {
            realText = r.text;
            decodeInfo = { font: r.font, avg: r.avgScore, low: r.lowConfidence };
          }
        } catch (e) { log('字体解码失败', e?.message); }
      }

      // 去掉题号、题型标签，留纯题干
      let stem = realText
        .replace(/【.+?题】/, '')
        .replace(/^[\s\d]+[.、．]?\s*/, '')
        .trim();

      // 关键：innerText 会把选项文字也拼进题干。
      // 逐个把选项文本从题干里剔除，否则提示词会被选项污染，
      // 模型可能误把某个选项当成题干的一部分。
      for (const o of opts) {
        const variants = [
          o.letter + ' ' + o.text,
          o.letter + o.text,
          o.letter + '、' + o.text,
          o.text
        ];
        for (const v of variants) {
          if (v && v.length > 1) stem = stem.split(v).join(' ');
        }
      }
      stem = stem.replace(/\s+/g, ' ').trim();
      if (!stem) stem = realText;   // 兜底：剔除过度时用原文

      questions.push({
        num: i + 1,
        type,
        text: stem,
        options: opts.map(o => `${o.letter} ${o.text}`),
        _box: b,
        _opts: opts,
        _fill: fillFrames
      });
    }

    return { ok: true, questions };
  }

  /** 填充答案 */
  async function fillAnswers(questions, answers) {
    const byNum = new Map();
    for (const a of answers || []) {
      if (a && a.num != null) byNum.set(Number(a.num), a);
    }

    const report = [];

    for (const q of questions) {
      const ans = byNum.get(q.num);
      if (!ans) { report.push({ num: q.num, ok: false, reason: 'API 未返回此题的答案' }); continue; }

      let vals = Array.isArray(ans.answer) ? ans.answer : [ans.answer];
      vals = vals.filter(v => v != null && String(v).trim() !== '')
        .map(v => String(v).trim());

      try {
        if (q.type === 'single' || q.type === 'multi' || q.type === 'judge') {
          let letters = vals.map(v => v.toUpperCase());

          if (q.type === 'judge') {
            letters = letters.map(L => {
              if (/^(对|正确|TRUE|T|A|√)$/.test(L)) return 'A';
              if (/^(错|错误|FALSE|F|B|×)$/.test(L)) return 'B';
              return L;
            });
          }

          let clicked = 0;
          for (const L of letters) {
            const opt = q._opts.find(o => o.letter === L);
            if (!opt) continue;
            const already = /check_answer|checked|active|selected/i.test(opt.el.className || '');
            if (!already) {
              try { opt.el.click(); } catch { /* ignore */ }
            }
            clicked++;
          }
          report.push({ num: q.num, ok: clicked > 0, type: q.type, filled: letters.join('') });

        } else if (q.type === 'fill') {
          let n = 0;
          for (let k = 0; k < q._fill.length && k < vals.length; k++) {
            const f = q._fill[k];
            let d = null;
            try { d = f.contentDocument || f.contentWindow.document; } catch { d = null; }
            if (!d || !d.body) continue;
            d.body.innerHTML = '<p>' + vals[k] + '</p>';
            const win = d.defaultView || window;
            d.body.dispatchEvent(new win.Event('input', { bubbles: true }));
            d.body.dispatchEvent(new win.Event('keyup', { bubbles: true }));
            n++;
          }
          report.push({ num: q.num, ok: n > 0, type: 'fill', filled: n, need: q._fill.length });

        } else {
          report.push({ num: q.num, ok: false, reason: '无法识别题型' });
        }
      } catch (e) {
        report.push({ num: q.num, ok: false, reason: e?.message });
      }
    }

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
    const boxes = qAll('.questionLi');
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
      shot = await chrome.runtime.sendMessage({
        type: 'page:screenshot',
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
    for (const q of scraped.questions) {
      if (!q.text || q.text.length < 4) {
        reasons.push('第' + q.num + '题题干过短');
        continue;
      }
      // 生僻字比例：U+3400-4DBF、U+9FA6-9FFF 等少见区间
      const rare = [...q.text].filter(ch => {
        const c = ch.codePointAt(0);
        return (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x9fa6 && c <= 0x9fff);
      }).length;
      if (rare / q.text.length > 0.15) {
        reasons.push('第' + q.num + '题疑似仍有乱码');
      }
      // 明显没被替换掉的假字
      if (/[忞忖忟応忚忝忛忢忲忰忱]/.test(q.text)) {
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
      resp = await chrome.runtime.sendMessage({
        type: 'vision:answer',
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

  /** 测验主流程：抓 → 判断可信度 → 文本答 / 截图答 → 填 */
  async function runQuiz() {
    if (!state.cfg.auto.quizEnabled) return false;
    if (!hasQuiz()) return false;
    if (state.quizRunning) return true;

    const scraped = await scrapeQuiz();
    if (!scraped.ok) return false;

    const sig = scraped.questions.map(q => q.text.slice(0, 40)).join('|');
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
          num: q.num, type: q.type, text: q.text, options: q.options
        }));

        let resp;
        try {
          resp = await chrome.runtime.sendMessage({ type: 'quiz:answer', questions: payload });
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
          const answeredNums = new Set(answers.map(a => Number(a.num)));
          const missing = scraped.questions.filter(q => !answeredNums.has(q.num));

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

      // 提交条件：配置开了自动提交，且视觉没标注不确定
      const canSubmit = state.cfg.quiz.autoSubmit &&
        !(visionMeta && visionMeta.uncertain);

      if (canSubmit) {
        const btn = qAll('button, a, input[type=button], input[type=submit]')
          .find(b => /^\s*提\s*交\s*$/.test((b.innerText || b.value || '').trim()));
        if (btn) {
          await sleep(800);
          try { btn.click(); setStatus('📤 已提交', false); } catch { /* ignore */ }
        }
      } else if (state.cfg.quiz.autoSubmit && visionMeta && visionMeta.uncertain) {
        setStatus(statusText + ' · 因不确定未自动提交', false);
      }

      return true;
    } finally {
      state.quizRunning = false;
    }
  }

  /* ============================================================
   * 5. 下一节（仅顶层）
   * ============================================================ */

  function clickNext() {
    const sels = [
      '#prevNextFocusNext', '.prev_next .next', '.jb_btn_next',
      '.nodeItem .next', 'a.next', '.next-btn'
    ];
    for (const s of sels) {
      const el = q1(s);
      if (el) {
        log('点击下一节', s);
        try { el.click(); return true; } catch { /* ignore */ }
      }
    }

    // 无明确按钮时点「下一节」文字
    const byText = qAll('a, button, span, div')
      .find(el => {
        const t = (el.innerText || '').trim();
        return /^下一节$/.test(t) && el.offsetParent !== null;
      });
    if (byText) {
      log('按文字点击下一节');
      try { byText.click(); return true; } catch { /* ignore */ }
    }
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
        chrome.runtime.sendMessage({
          type: 'frame:status',
          status: text,
          busy: !!busy
        }).catch(() => {});
      } catch { /* ignore */ }
    }

    if (IS_TOP) renderStatus();
  }

  /* ============================================================
   * 7. 主循环
   * ============================================================ */

  async function tick() {
    if (state.stopped) return;

    // 页面跳转了 → 重置测验记录与滚动进度
    if (location.href !== state.lastHref) {
      state.lastHref = location.href;
      state.quizDoneSig = '';
      state.quizSig = '';
      scrollTicksCleanup();
    }

    if (state.cfg.auto.antiPause) patchWindow(window);

    // 风控页优先判断：命中就立刻停，别的什么都不做
    checkLockSignals();
    if (state.antispider) {
      setStatus('⚠ 检测到平台验证，已停止。请在页面上完成验证', false);
      state.stopped = true;
      return;
    }

    // (1) 本文档的视频
    if (await runVideo()) {
      // 状态必须反映真实情况，否则用户以为在刷、其实没动
      const v = qAll('video')[0];
      const rate = v ? (v.playbackRate || 1) : 1;
      const rateText = Math.abs(rate - 1) < 0.05 ? '1x' : rate + 'x';

      if (v && !v.paused) {
        if (state.speedGiveUp) {
          // 试过加速被拒，已自动放弃 —— 明确告诉用户，别以为是扩展坏了
          setStatus('▶ 视频播放中（' + rateText + '·平台锁定倍速，已自动放弃加速）', true);
        } else if (state.speedLocked) {
          setStatus('▶ 视频播放中（' + rateText + '·本节点已锁定倍速）', true);
        } else {
          setStatus('▶ 视频播放中（' + rateText + '）', true);
        }
      } else if (v && v.paused) {
        setStatus('⚠ 视频未能播放，请在播放器上手动点一下播放', false);
      }
      return;
    }

    // (2) 本文档的文档/PPT
    if (await runDocument()) {
      setStatus('📄 文档滚动中', true);
      return;
    }

    // (3) 本文档的测验
    if (hasQuiz()) {
      const did = await runQuiz().catch(e => { log('测验异常', e?.message); return false; });
      if (did) return;
    }

    setStatus('✓ 本区域无待办', false);

    // (4) 只有顶层负责翻页，且要等所有 frame 都闲下来
    if (!IS_TOP) return;
    if (!state.cfg.auto.autoNext) return;

    let busyElsewhere = true;
    try {
      const r = await chrome.runtime.sendMessage({ type: 'tab:busy' });
      busyElsewhere = !!r?.busy;
    } catch { busyElsewhere = false; }

    if (busyElsewhere) return; // 还有其他 frame 在跑，别急着翻页

    setStatus('⏭ 切换下一节…', false);
    await sleep(1000);
    if (!clickNext()) {
      setStatus('⚠ 未找到下一节按钮', false);
      await sleep(state.cfg.auto.loopInterval * 2);
    }
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
   * ============================================================ */

  const PANEL_CSS = `
    #cs-panel{position:fixed;right:18px;bottom:18px;z-index:2147483647;
      background:#fff;border:1px solid #d8dee4;border-radius:12px;
      box-shadow:0 8px 28px rgba(0,0,0,.16);
      font:13px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
      width:236px;overflow:hidden;color:#1f2328}
    #cs-panel.cs-collapsed .cs-body{display:none}
    #cs-panel .cs-head{background:linear-gradient(135deg,#2d6cdf,#3f8cff);color:#fff;
      padding:9px 12px;font-weight:600;cursor:move;display:flex;
      justify-content:space-between;align-items:center;user-select:none}
    #cs-panel .cs-min{cursor:pointer;opacity:.85;padding:0 5px;font-weight:400}
    #cs-panel .cs-body{padding:10px 12px 12px}
    #cs-panel .cs-row{display:flex;justify-content:space-between;align-items:center;margin:7px 0}
    #cs-panel .cs-row label{color:#57606a}
    #cs-panel input[type=number]{width:64px;padding:3px 6px;border:1px solid #d0d7de;
      border-radius:5px;font-size:13px}
    #cs-panel input[type=checkbox]{transform:scale(1.15);cursor:pointer;accent-color:#2d6cdf}
    #cs-panel .cs-btns{display:flex;gap:6px;margin-top:12px}
    #cs-panel .cs-btns button{flex:1;padding:7px 0;border:0;border-radius:7px;
      cursor:pointer;font-size:13px;font-weight:500;transition:.15s}
    #cs-panel .cs-start{background:#2d6cdf;color:#fff}
    #cs-panel .cs-start:hover{background:#255bbd}
    #cs-panel .cs-stop{background:#e5484d;color:#fff}
    #cs-panel .cs-stop:hover{background:#cf3c41}
    #cs-panel .cs-gear{flex:0 0 34px;background:#f0f3f6;color:#57606a}
    #cs-panel .cs-gear:hover{background:#e4e9ee}
    #cs-panel .cs-status{margin-top:10px;padding-top:8px;border-top:1px dashed #e1e5ea;
      font-size:12px;color:#57606a;word-break:break-all}
    #cs-panel .cs-status b{color:#2d6cdf;font-weight:600}
    #cs-panel.cs-collapsed{width:auto}
  `;

  function ensurePanel() {
    if (!IS_TOP || !document.body) return null;
    if (state.panel && document.documentElement.contains(state.panel)) return state.panel;

    const style = document.createElement('style');
    style.id = 'cs-panel-style';
    style.textContent = PANEL_CSS;
    if (!document.getElementById('cs-panel-style')) document.documentElement.appendChild(style);

    const box = document.createElement('div');
    box.id = 'cs-panel';
    box.innerHTML = `
      <div class="cs-head">
        <span>学习通自动学习</span>
        <span class="cs-min" title="折叠">—</span>
      </div>
      <div class="cs-body">
        <div class="cs-row"><label>倍速</label><input type="number" id="cs-rate" step="0.25" min="1" max="4"></div>
        <div class="cs-row"><label>静音</label><input type="checkbox" id="cs-mute"></div>
        <div class="cs-row"><label>自动下一节</label><input type="checkbox" id="cs-next"></div>
        <div class="cs-row"><label>文档滚动</label><input type="checkbox" id="cs-doc"></div>
        <div class="cs-row"><label>自动作答</label><input type="checkbox" id="cs-quiz"></div>
        <div class="cs-btns">
          <button class="cs-start" id="cs-start">开始</button>
          <button class="cs-stop" id="cs-stop">停止</button>
          <button class="cs-gear" id="cs-gear" title="设置">⚙</button>
        </div>
        <div class="cs-status">状态：<b id="cs-status">待机</b></div>
      </div>`;
    document.documentElement.appendChild(box);

    const el = s => box.querySelector(s);
    const a = state.cfg.auto;
    el('#cs-rate').value = a.rate;
    el('#cs-mute').checked = !!a.mute;
    el('#cs-next').checked = !!a.autoNext;
    el('#cs-doc').checked = !!a.docAutoScroll;
    el('#cs-quiz').checked = !!a.quizEnabled;

    const save = () => {
      const auto = {
        ...state.cfg.auto,
        rate: parseFloat(el('#cs-rate').value) || 2,
        mute: el('#cs-mute').checked,
        autoNext: el('#cs-next').checked,
        docAutoScroll: el('#cs-doc').checked,
        quizEnabled: el('#cs-quiz').checked
      };
      state.cfg = { ...state.cfg, auto };
      chrome.runtime.sendMessage({ type: 'cfg:set', patch: { auto } }).catch(() => {});
    };

    ['#cs-rate', '#cs-mute', '#cs-next', '#cs-doc', '#cs-quiz']
      .forEach(s => el(s).addEventListener('change', save));

    el('#cs-start').onclick = () => {
      save();
      chrome.runtime.sendMessage({ type: 'state:set', running: true }).catch(() => {});
      start();
    };
    el('#cs-stop').onclick = () => {
      chrome.runtime.sendMessage({ type: 'state:set', running: false }).catch(() => {});
      stop();
    };
    el('#cs-gear').onclick = () => {
      chrome.runtime.sendMessage({ type: 'open:options' }).catch(() => {});
    };

    const minBtn = el('.cs-min');
    minBtn.onclick = e => {
      e.stopPropagation();
      box.classList.toggle('cs-collapsed');
      minBtn.textContent = box.classList.contains('cs-collapsed') ? '+' : '—';
    };

    // 拖动
    const head = box.querySelector('.cs-head');
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

    state.panel = box;
    return box;
  }

  function renderStatus() {
    if (!IS_TOP || !state.panel) return;
    const s = state.panel.querySelector('#cs-status');
    if (s && s.textContent !== state.status) s.textContent = state.status;
  }

  /* ============================================================
   * 9. 消息处理
   * ============================================================ */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
                num: q.num, type: q.type, text: q.text, options: q.options
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
    return true;
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
      const r = await chrome.runtime.sendMessage({ type: 'cfg:get' });
      state.cfg = r?.cfg || FALLBACK_CFG;
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
      const st = await chrome.runtime.sendMessage({ type: 'state:get' });
      if (st?.running) start();
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
    get cfg() { return state.cfg; }
  };
}

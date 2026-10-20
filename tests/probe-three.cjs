/**
 * ============================================================
 * 三类元素综合采集（一次跑完）
 * ============================================================
 *
 * 【1】视频任务点
 *   - video 元素属性、时长、进度
 *   - 完成度门槛（90%）
 *   - 播放器容器结构
 *   - 视频帧里所有可点元素
 *
 * 【2】题目
 *   - 题目容器 .TiMu 完整结构
 *   - 四种题型（单选/多选/判断/填空）
 *   - 选项元素、点击方式
 *   - 提交按钮
 *
 * 【3】任务点完成状态
 *   - jobhint 计数
 *   - 课程树节点标记
 *   - 各个位置的「已完成/待完成」文字
 *
 * 用法: node probe-three.cjs [port]
 */
const http = require('http');
const crypto = require('crypto');

const PORT = process.argv[2] || 9335;
const CDP = `http://127.0.0.1:${PORT}`;

let socket = null, idCounter = 0;
const pending = new Map();
let buf = Buffer.alloc(0);

function getJSON(p) {
  return new Promise((res, rej) => {
    http.get(CDP + p, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); })
      .on('error', rej);
  });
}
function connect(w) {
  return new Promise((resolve, reject) => {
    const u = new URL(w);
    const k = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { 'Connection': 'Upgrade', 'Upgrade': 'websocket', 'Sec-WebSocket-Key': k, 'Sec-WebSocket-Version': '13' }
    });
    req.on('upgrade', (r, s) => { socket = s; s.on('data', onData); resolve(); });
    req.on('error', reject); req.end();
  });
}
function onData(ch) {
  buf = Buffer.concat([buf, ch]);
  while (buf.length >= 2) {
    const op = buf[0] & 0x0f;
    let len = buf[1] & 0x7f, off = 2;
    if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    if (buf.length < off + len) return;
    const pl = buf.subarray(off, off + len); buf = buf.subarray(off + len);
    if (op === 1) {
      try { const m = JSON.parse(pl.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
    }
  }
}
function send(m, p, s) {
  return new Promise(res => {
    const id = ++idCounter; pending.set(id, res);
    const pl = Buffer.from(JSON.stringify({ id, method: m, params: p || {}, sessionId: s }));
    const len = pl.length; let h;
    if (len < 126) h = Buffer.from([0x81, 0x80 | len]);
    else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(len), 2); }
    const mask = crypto.randomBytes(4); const mk = Buffer.alloc(len);
    for (let i = 0; i < len; i++) mk[i] = pl[i] ^ mask[i % 4];
    socket.write(Buffer.concat([h, mask, mk]));
  });
}
async function ev(sid, expr, ctx, ap = true) {
  const params = { expression: expr, returnByValue: true, awaitPromise: ap, timeout: 60000 };
  if (ctx != null) params.contextId = ctx;
  const r = await send('Runtime.evaluate', params, sid);
  if (r.result?.exceptionDetails) {
    return 'EX: ' + ((r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 400));
  }
  return r.result?.result?.value;
}

const H = (t) => console.log('\n' + '='.repeat(76) + '\n' + t + '\n' + '='.repeat(76));

(async () => {
  const ver = await getJSON('/json/version');
  await connect(ver.webSocketDebuggerUrl);

  const list = await send('Target.getTargets');
  const pg = (list.result.targetInfos || []).find(t => /studentstudy/.test(t.url || '') && t.type === 'page');
  if (!pg) { console.log('找不到学习通页面'); process.exit(1); }

  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: pg.targetId, flatten: true });
  await send('Page.enable', {}, sessionId);

  const ft = await send('Page.getFrameTree', {}, sessionId);
  const flat = [];
  (function walk(n, d) {
    if (!n) return;
    flat.push({ d, id: n.frame.id, url: n.frame.url || '' });
    (n.childFrames || []).forEach(c => walk(c, d + 1));
  })(ft.result.frameTree, 0);

  const live = flat.filter(f => f.url && f.url !== 'about:blank');
  console.log(`当前页面: ${pg.url.slice(0, 80)}`);
  console.log(`Frame 数: ${live.length}`);
  live.forEach(f => console.log(`  [d${f.d}] ${f.url.slice(0, 72)}`));

  // 每个 frame 开一个隔离世界
  const ctxs = {};
  for (const f of live) {
    const w = await send('Page.createIsolatedWorld', { frameId: f.id, worldName: 'p' + f.d + Date.now() + Math.random() }, sessionId);
    if (w.result?.executionContextId != null) ctxs[f.d] = { ctx: w.result.executionContextId, url: f.url };
  }

  /* ==================================================================
   * 【1】视频任务点
   * ================================================================== */
  H('【1】视频任务点');

  const vidFrame = live.find(f => /ananas\/modules\/video/.test(f.url));
  if (!vidFrame) {
    console.log('当前页面没有视频帧（可能在别的章节/标签）');
    console.log('提示：视频帧 URL 形如 ananas/modules/video/index.html');
  } else {
    const ctx = ctxs[vidFrame.d].ctx;

    console.log('\n── 1.1 video 元素属性 ──');
    console.log(await ev(sessionId, `(() => {
      const v = document.querySelector('video');
      if (!v) return '无 video 元素';
      const attrs = {};
      for (const a of v.attributes) attrs[a.name] = (a.value || '').slice(0, 50);
      const dur = v.duration, ct = v.currentTime;
      return JSON.stringify({
        sel: 'video#' + (v.id || '') + '.' + (v.className||''),
        duration: isFinite(dur) ? +dur.toFixed(1) : null,
        currentTime: +ct.toFixed(1),
        percent: isFinite(dur) && dur > 0 ? +(ct/dur*100).toFixed(1) : null,
        threshold90: isFinite(dur) ? +(dur*0.9).toFixed(1) : null,
        reached90: isFinite(dur) ? ct >= dur*0.9 : null,
        paused: v.paused, ended: v.ended,
        readyState: v.readyState, networkState: v.networkState,
        playbackRate: v.playbackRate, muted: v.muted,
        src: (v.currentSrc || v.src || '').slice(0, 70),
        attrs
      }, null, 2);
    })()`, ctx, false));

    console.log('\n── 1.2 播放器容器（video-js）──');
    console.log(await ev(sessionId, `(() => {
      const pl = document.querySelector('.video-js, #video, .vjs-tech')?.closest('.video-js, [class*=player]');
      if (!pl) return '无播放器容器';
      return JSON.stringify({
        tag: pl.tagName,
        cls: (pl.className || '').toString().slice(0, 70),
        id: pl.id,
        children: [...pl.children].map(c => ({
          tag: c.tagName, cls: (c.className||'').toString().slice(0,45), id: c.id
        })).slice(0, 10)
      }, null, 2);
    })()`, ctx, false));

    console.log('\n── 1.3 视频帧内可点元素（播放/倍速/音量）──');
    console.log(await ev(sessionId, `(() => {
      const out = [];
      for (const e of document.querySelectorAll('button, [class*=vjs-], [role=button], a')) {
        const cls = (e.className || '').toString();
        const title = e.getAttribute('title') || '';
        const aria = e.getAttribute('aria-label') || '';
        const t = (e.innerText || '').trim();
        if (!cls && !title && !aria && !t) continue;
        const r = e.getBoundingClientRect();
        out.push({
          tag: e.tagName,
          cls: cls.slice(0, 50),
          title: title.slice(0, 30),
          aria: aria.slice(0, 30),
          text: t.slice(0, 20),
          visible: r.width > 0 && r.height > 0
        });
      }
      const seen = new Set();
      return JSON.stringify(out.filter(x => {
        const k = x.cls + '|' + x.title + '|' + x.text;
        if (seen.has(k)) return false;
        seen.add(k); return true;
      }).filter(x => /play|pause|rate|speed|volume|mute|倍速|播放|暂停/i.test(x.cls + x.title + x.aria + x.text))
        .slice(0, 15), null, 1);
    })()`, ctx, false));

    console.log('\n── 1.4 倍速菜单项（实测有哪些档位）──');
    console.log(await ev(sessionId, `(() => {
      const items = [...document.querySelectorAll('.vjs-playback-rate .vjs-menu-item, [class*=rate] li, [class*=speed] li')];
      return JSON.stringify({
        count: items.length,
        items: items.map(i => ({
          text: (i.innerText || '').trim().slice(0, 12),
          cls: (i.className || '').toString().slice(0, 45),
          active: /selected|active/i.test(i.className || '')
        })).slice(0, 12)
      }, null, 1);
    })()`, ctx, false));

    console.log('\n── 1.5 视频帧 body 文本（找完成提示）──');
    console.log(await ev(sessionId, `(() => {
      const t = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
      return JSON.stringify({
        text: t.slice(0, 300),
        hasCompletedText: /已完成|恭喜|学完/.test(t),
        hasUnfinishedText: /未完成|待完成|还需/.test(t)
      }, null, 2);
    })()`, ctx, false));
  }

  /* ==================================================================
   * 【2】题目
   * ================================================================== */
  H('【2】题目');

  const workFrame = live.find(f => /work\/doHomeWork|modules\/work/.test(f.url) && /doHomeWork/.test(f.url));
  if (!workFrame) {
    console.log('当前页面没有题目帧');
    console.log('提示：题目帧 URL 形如 mooc-ans/work/doHomeWorkNew?courseId=...');
  } else {
    const ctx = ctxs[workFrame.d].ctx;

    console.log('\n── 2.1 题目容器统计 ──');
    console.log(await ev(sessionId, `(() => {
      const sels = {
        TiMu: '.TiMu', Zy_TItle: '.Zy_TItle', Zy_ulTop: '.Zy_ulTop',
        newZy_TItle: '.newZy_TItle', num_option_dx: '.num_option_dx',
        answerList: '.answerList', fontsecret: '.font-cxsecret',
        radio: 'input[type=radio]', checkbox: 'input[type=checkbox]',
        textInput: 'input[type=text]', textarea: 'textarea'
      };
      const out = {};
      for (const [k, s] of Object.entries(sels)) {
        try { const n = document.querySelectorAll(s).length; if (n) out[k] = n; } catch {}
      }
      return JSON.stringify(out, null, 1);
    })()`, ctx, false));

    console.log('\n── 2.2 四种题型的完整结构（各取一题）──');
    console.log(await ev(sessionId, `(() => {
      const qs = [...document.querySelectorAll('.TiMu')];
      if (!qs.length) return '无题目';
      const byType = {};
      for (const q of qs) {
        const type = (q.querySelector('.newZy_TItle')?.innerText || '').trim();
        const key = /多选/.test(type) ? 'multi'
                  : /单选/.test(type) ? 'single'
                  : /判断/.test(type) ? 'judge'
                  : /填空/.test(type) ? 'fill' : 'other';
        if (byType[key]) continue;

        const opts = [...q.querySelectorAll('.Zy_ulTop li')].map(li => ({
          role: li.getAttribute('role'),
          qid: li.getAttribute('qid'),
          qtype: li.getAttribute('qtype'),
          onclick: (li.getAttribute('onclick') || '').slice(0, 45),
          letter: li.querySelector('.num_option_dx')?.getAttribute('data') || '',
          letterCls: (li.querySelector('.num_option_dx')?.className || '').toString().slice(0, 45),
          text: (li.querySelector('a.after')?.innerText || '').trim().slice(0, 50),
          textCls: (li.querySelector('a.after')?.className || '').toString().slice(0, 30)
        }));

        const inputs = [...q.querySelectorAll('input, textarea')].map(i => ({
          tag: i.tagName, type: i.type, cls: (i.className||'').toString().slice(0,35),
          name: i.name, id: i.id, placeholder: i.placeholder
        }));

        byType[key] = {
          type,
          dataAttr: q.getAttribute('data'),
          title: (q.querySelector('.Zy_TItle .font-cxsecret')?.innerText || q.querySelector('.Zy_TItle')?.innerText || '')
            .replace(/\\s+/g, ' ').trim().slice(0, 100),
          titleCls: (q.querySelector('.Zy_TItle .font-cxsecret')?.className || '').toString().slice(0, 50),
          optCount: opts.length,
          opts: opts.slice(0, 4),
          inputs,
          // 题目容器关键属性
          qidFirst: opts[0]?.qid || '',
          qtypeFirst: opts[0]?.qtype || ''
        };
      }
      return JSON.stringify(byType, null, 2);
    })()`, ctx, false));

    console.log('\n── 2.3 提交/保存按钮 ──');
    console.log(await ev(sessionId, `(() => {
      const out = [];
      for (const e of document.querySelectorAll('a, button, input[type=button], input[type=submit]')) {
        if (e.closest('.TiMu') || e.closest('.Zy_ulTop')) continue;
        const t = (e.innerText || e.value || '').trim();
        if (!t || t.length > 15) continue;
        const r = e.getBoundingClientRect();
        if (r.width < 5) continue;
        out.push({
          text: t, tag: e.tagName,
          cls: (e.className || '').toString().slice(0, 45),
          onclick: (e.getAttribute('onclick') || '').slice(0, 60)
        });
      }
      const seen = new Set();
      return JSON.stringify(out.filter(x => {
        const k = x.text + '|' + x.cls;
        if (seen.has(k)) return false;
        seen.add(k); return true;
      }).slice(0, 20), null, 1);
    })()`, ctx, false));

    console.log('\n── 2.4 题型分布 ──');
    console.log(await ev(sessionId, `(() => {
      const qs = [...document.querySelectorAll('.TiMu')];
      const dist = {};
      qs.forEach((q, i) => {
        const t = (q.querySelector('.newZy_TItle')?.innerText || '').trim();
        const k = t || '未知';
        if (!dist[k]) dist[k] = { count: 0, nums: [] };
        dist[k].count++;
        if (dist[k].nums.length < 3) dist[k].nums.push(i + 1);
      });
      return JSON.stringify(dist, null, 1);
    })()`, ctx, false));
  }

  /* ==================================================================
   * 【3】任务点完成状态
   * ================================================================== */
  H('【3】任务点完成状态');

  const topFrame = live.find(f => f.d === 0);
  const topCtx = ctxs[topFrame.d].ctx;

  console.log('\n── 3.1 jobhint（全局待完成计数）──');
  console.log(await ev(sessionId, `(() => {
    const jh = document.getElementById('jobhint');
    if (!jh) return '不存在';
    return JSON.stringify({
      text: (jh.textContent || '').trim(),
      title: (jh.getAttribute('title') || ''),
      display: getComputedStyle(jh).display,
      visible: jh.offsetParent !== null,
      html: jh.outerHTML.slice(0, 250)
    }, null, 2);
  })()`, topCtx, false));

  console.log('\n── 3.2 当前章节在课程树里的状态 ──');
  console.log(await ev(sessionId, `(() => {
    const cur = [...document.querySelectorAll('.posCatalog_select')].find(n => /active|current/i.test(n.className || ''));
    if (!cur) return '无激活节点';
    return JSON.stringify({
      id: cur.id,
      cls: (cur.className || '').toString(),
      text: (cur.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100),
      done: !!cur.querySelector('.icon_Completed'),
      todo: !!cur.querySelector('.catalog_points_yi'),
      todoText: (cur.querySelector('.catalog_points_yi')?.textContent || '').trim(),
      todoCount: (cur.querySelector('.orangeNew')?.textContent || '').trim(),
      innerMarks: [...cur.querySelectorAll('[class*=icon],[class*=point],[class*=orange]')]
        .map(e => ({ cls: (e.className||'').toString().slice(0,45), text: (e.textContent||'').trim().slice(0,20) }))
    }, null, 2);
  })()`, topCtx, false));

  console.log('\n── 3.3 节课标题区（任务点提示文字）──');
  console.log(await ev(sessionId, `(() => {
    // 找标题区域
    const titleArea = document.querySelector('.chapterTitle, .orientationleft, #mainFrame');
    const txt = (document.body?.innerText || '').replace(/\\s+/g, ' ');
    // 提取任务点相关片段
    const m = txt.match(/[^。！\\n]{0,50}(任务点|待完成|已完成)[^。！\\n]{0,50}/g) || [];
    return JSON.stringify({
      taskPointTexts: [...new Set(m)].slice(0, 8),
      // 顶部是否有完成任务提示
      hasAllDone: /任务点已全部完成|已完成全部任务点/.test(txt)
    }, null, 2);
  })()`, topCtx, false));

  console.log('\n── 3.4 cards 帧里的任务点容器 ──');
  const cardFrame = live.find(f => /knowledge\/cards/.test(f.url));
  if (cardFrame) {
    const ctx = ctxs[cardFrame.d].ctx;
    console.log(await ev(sessionId, `(() => {
      const out = [];
      // 任务点图标常见 class
      for (const e of document.querySelectorAll('[class*=job],[class*=Job],[class*=task],[class*=Task],[class*=point],[class*=Point],[class*=finish],[class*=Finish],[class*=complete],[class*=Complete]')) {
        const cls = (e.className || '').toString();
        if (!cls) continue;
        const r = e.getBoundingClientRect();
        out.push({
          tag: e.tagName,
          cls: cls.slice(0, 55),
          text: (e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30),
          visible: r.width > 0 && r.height > 0
        });
      }
      const seen = new Set();
      return JSON.stringify(out.filter(x => {
        const k = x.cls + '|' + x.text;
        if (seen.has(k)) return false;
        seen.add(k); return true;
      }).slice(0, 15), null, 1);
    })()`, ctx, false));

    console.log('\n── 3.5 cards 帧 body 文本开头 ──');
    console.log(await ev(sessionId, `(() => {
      const t = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
      return JSON.stringify({
        head: t.slice(0, 250),
        hasDone: /已完成/.test(t),
        hasTodo: /待完成|未完成/.test(t)
      }, null, 2);
    })()`, ctx, false));
  }

  /* ==================================================================
   * 汇总
   * ================================================================== */
  H('【4】汇总：代码里该用什么选择器');

  console.log(`
视频任务点：
  容器      video#video_html5_api.vjs-tech        (在 ananas/modules/video 帧)
  时长      video.duration                        (play 之后才有值!)
  进度      video.currentTime
  完成门槛  currentTime / duration >= 0.9
  倍速      video.playbackRate
  播放      video.play()

题目：
  容器      .TiMu                                 (在 work/doHomeWorkNew 帧)
  题型      .TiMu .newZy_TItle                    → 【单选题】等
  题干      .TiMu .Zy_TItle .font-cxsecret        (字体反爬)
  选项列表  .TiMu .Zy_ulTop li
  选项字母  .num_option_dx[data]
  选项文字  li a.after                            (字体反爬)
  题目标识  li[qid] + li[qtype]                   (qtype: 0单选 1多选 3判断)
  点击选项  li[onclick] = addSingleChoice/addMultipleChoice
  填空      .TiMu input[type=text]
  提交      a.btnSubmit  (onclick="btnBlueSubmit();")
  暂存      a.btnSave    (onclick="noSubmit();")

任务点完成状态：
  全局计数  #jobhint  (0 = 全部完成)
  当前节点  .posCatalog_select.active 或 [class*=current]
  已完成    .icon_Completed        (文字"已完成")
  待完成    .catalog_points_yi     (文字"1个待完成任务点")
  计数角标  .orangeNew
  节点ID    #cur<chapterId>
`);

  socket.destroy();
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

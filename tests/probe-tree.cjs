/**
 * ============================================================
 * 目录树 + 任务点状态 完整结构采集
 * ============================================================
 *
 * 目标：把课程目录树（右侧「目录」栏）的完整结构搞清楚
 *
 *   1. 树层级结构（模块 → 专题 → 章节 → 子节点）
 *   2. 每个节点的完整 HTML 和 class 组合
 *   3. 已完成 / 未完成 / 进行中 三种状态的所有标记
 *   4. 任务点类型图标（视频/文档/测验/讨论/PPT...）
 *   5. 任务点数量的所有表现形式
 *
 * 用法: node probe-tree.cjs [port]
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
  const topId = ft.result.frameTree.frame.id;
  const w = await send('Page.createIsolatedWorld', { frameId: topId, worldName: 'tree' }, sessionId);
  const ctx = w.result.executionContextId;

  /* ==================================================================
   * 1. 目录树的整体容器结构
   * ================================================================== */
  H('1. 目录树容器结构');

  console.log(await ev(sessionId, `(() => {
    const out = {};
    // 可能的目录容器
    const sels = ['#coursetree', '.posCatalog', '#mainid', '#catalog', '.catalog',
                  '#chapterTree', '.chapter_tree', '#dirTree', '.directory'];
    for (const s of sels) {
      const n = document.querySelectorAll(s);
      if (n.length) {
        out[s] = {
          count: n.length,
          first: {
            tag: n[0].tagName,
            cls: (n[0].className || '').toString().slice(0, 60),
            id: n[0].id,
            children: n[0].children.length,
            htmlHead: n[0].outerHTML.slice(0, 300)
          }
        };
      }
    }
    return JSON.stringify(out, null, 2);
  })()`, ctx, false));

  /* ==================================================================
   * 2. 树的层级结构（一级/二级/三级节点）
   * ================================================================== */
  H('2. 树层级结构（各种节点的 class 组合）');

  console.log(await ev(sessionId, `(() => {
    const nodes = [...document.querySelectorAll('.posCatalog_select')];
    const byClass = {};
    for (const n of nodes) {
      const cls = (n.className || '').toString().trim();
      if (!byClass[cls]) byClass[cls] = { count: 0, sample: null };
      byClass[cls].count++;
      if (!byClass[cls].sample) {
        byClass[cls].sample = {
          id: n.id,
          text: (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60)
        };
      }
    }
    return JSON.stringify({
      totalNodes: nodes.length,
      classVariants: byClass
    }, null, 2);
  })()`, ctx, false));

  /* ==================================================================
   * 3. 三种状态的所有标记
   * ================================================================== */
  H('3. 已完成 / 未完成 / 进行中 的状态标记');

  console.log(await ev(sessionId, `(() => {
    const nodes = [...document.querySelectorAll('.posCatalog_select')];

    const gotDone = [], gotTodo = [], gotNormal = [];
    for (const n of nodes) {
      const name = (n.querySelector('.posCatalog_name')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 50);
      if (!name) continue;

      const isDone = !!n.querySelector('.icon_Completed');
      const isTodo = !!n.querySelector('.catalog_points_yi');

      if (isDone) gotDone.push({ name, id: n.id, cls: n.className.toString() });
      else if (isTodo) gotTodo.push({ name, id: n.id, cls: n.className.toString() });
      else gotNormal.push({ name, id: n.id, cls: n.className.toString() });
    }

    return JSON.stringify({
      统计: { 已完成: gotDone.length, 未完成: gotTodo.length, 无标记: gotNormal.length },
      已完成样本: gotDone.slice(0, 3),
      未完成样本: gotTodo.slice(0, 3),
      无标记样本: gotNormal.slice(0, 3)
    }, null, 2);
  })()`, ctx, false));

  /* ==================================================================
   * 4. 单个节点的完整 HTML（三种状态各取一个）
   * ================================================================== */
  H('4. 单节点完整 HTML（三种状态各一个）');

  console.log(await ev(sessionId, `(() => {
    const nodes = [...document.querySelectorAll('.posCatalog_select')];
    const pick = (pred) => nodes.find(n => n.querySelector('.posCatalog_name') && pred(n));
    const out = {};

    const done = pick(n => n.querySelector('.icon_Completed'));
    const todo = pick(n => n.querySelector('.catalog_points_yi'));
    const plain = pick(n => !n.querySelector('.icon_Completed') && !n.querySelector('.catalog_points_yi'));

    if (done) out.已完成 = {
      id: done.id,
      cls: done.className.toString(),
      outerHTML: done.outerHTML.slice(0, 1200)
    };
    if (todo) out.未完成 = {
      id: todo.id,
      cls: todo.className.toString(),
      outerHTML: todo.outerHTML.slice(0, 1200)
    };
    if (plain) out.无标记 = {
      id: plain.id,
      cls: plain.className.toString(),
      outerHTML: plain.outerHTML.slice(0, 900)
    };

    return JSON.stringify(out, null, 2);
  })()`, ctx, false));

  /* ==================================================================
   * 5. 任务点类型图标
   * ================================================================== */
  H('5. 任务点类型图标（视频/文档/测验/讨论...）');

  console.log(await ev(sessionId, `(() => {
    // 收集所有出现过的 icon class
    const iconClasses = {};
    for (const e of document.querySelectorAll('[class*="icon_"], [class*="icon-"], [class*="Icon"]')) {
      const cls = (e.className || '').toString();
      const m = cls.match(/icon_[A-Za-z]+|icon-[a-z]+/g);
      if (!m) continue;
      for (const c of m) {
        if (!iconClasses[c]) iconClasses[c] = { count: 0, texts: [] };
        iconClasses[c].count++;
        const t = (e.textContent || '').trim();
        if (t && iconClasses[c].texts.length < 2) iconClasses[c].texts.push(t.slice(0, 20));
      }
    }
    return JSON.stringify(iconClasses, null, 2);
  })()`, ctx, false));

  /* ==================================================================
   * 6. 任务点数量的所有表现形式
   * ================================================================== */
  H('6. 任务点数量的所有表现形式');

  console.log(await ev(sessionId, `(() => {
    const out = {};

    // orangeNew 角标
    const orange = [...document.querySelectorAll('.orangeNew')];
    out.orangeNew = {
      count: orange.length,
      sample: orange.slice(0, 3).map(e => ({
        text: (e.textContent || '').trim(),
        cls: e.className.toString(),
        parentCls: (e.parentElement?.className || '').toString().slice(0, 50),
        parentHTML: (e.parentElement?.outerHTML || '').slice(0, 250)
      }))
    };

    // catalog_points_yi
    const yi = [...document.querySelectorAll('.catalog_points_yi')];
    out.catalog_points_yi = {
      count: yi.length,
      sample: yi.slice(0, 2).map(e => ({
        text: (e.textContent || '').trim(),
        html: e.outerHTML.slice(0, 300)
      }))
    };

    // prevTips（鼠标悬停提示）
    const tips = [...document.querySelectorAll('.prevTips')];
    out.prevTips = {
      count: tips.length,
      titles: [...new Set(tips.map(e => (e.getAttribute('title') || e.textContent || '').trim().slice(0, 30)))].slice(0, 8)
    };

    // jobhint
    const jh = document.getElementById('jobhint');
    out.jobhint = jh ? { text: jh.textContent.trim(), display: getComputedStyle(jh).display } : null;

    return JSON.stringify(out, null, 2);
  })()`, ctx, false));

  /* ==================================================================
   * 7. 各章节类型的分类统计
   * ================================================================== */
  H('7. 各章节类型（按标题关键字分类）');

  console.log(await ev(sessionId, `(() => {
    const nodes = [...document.querySelectorAll('.posCatalog_select')];
    const cats = {
      微课: 0, 视频: 0, 文档: 0, 教材: 0, PPT: 0,
      测验: 0, 作业: 0, 讨论: 0, 小结: 0, 书目: 0, 其他: 0
    };
    const byCat = {};
    for (const n of nodes) {
      const name = (n.querySelector('.posCatalog_name')?.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!name) continue;
      let cat = '其他';
      if (/微课/.test(name)) cat = '微课';
      else if (/视频/.test(name)) cat = '视频';
      else if (/教材/.test(name)) cat = '教材';
      else if (/PPT/i.test(name)) cat = 'PPT';
      else if (/测验/.test(name)) cat = '测验';
      else if (/作业/.test(name)) cat = '作业';
      else if (/讨论/.test(name)) cat = '讨论';
      else if (/小结/.test(name)) cat = '小结';
      else if (/书目|阅读/.test(name)) cat = '书目';
      else if (/文档/.test(name)) cat = '文档';

      cats[cat]++;
      if (!byCat[cat]) byCat[cat] = { done: 0, todo: 0, sample: name.slice(0, 40) };
      if (n.querySelector('.icon_Completed')) byCat[cat].done++;
      if (n.querySelector('.catalog_points_yi')) byCat[cat].todo++;
    }
    return JSON.stringify({ 总数: cats, 各类完成情况: byCat }, null, 2);
  })()`, ctx, false));

  /* ==================================================================
   * 8. 当前激活节点的完整信息
   * ================================================================== */
  H('8. 当前激活节点的完整信息');

  console.log(await ev(sessionId, `(() => {
    const cur = [...document.querySelectorAll('.posCatalog_select')].find(n => /active|current/i.test(n.className || ''));
    if (!cur) return '无激活节点';
    return JSON.stringify({
      id: cur.id,
      cls: cur.className.toString(),
      完整HTML: cur.outerHTML.slice(0, 1500),
      所有子元素class: [...cur.querySelectorAll('*')].map(e => ({
        tag: e.tagName,
        cls: (e.className || '').toString().slice(0, 55),
        text: (e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30)
      })).slice(0, 15)
    }, null, 2);
  })()`, ctx, false));

  /* ==================================================================
   * 9. 树节点点击方式
   * ================================================================== */
  H('9. 树节点点击方式');

  console.log(await ev(sessionId, `(() => {
    const nodes = [...document.querySelectorAll('.posCatalog_select')].slice(0, 3);
    return JSON.stringify(nodes.map(n => ({
      id: n.id,
      tag: n.tagName,
      cls: n.className.toString(),
      onclick: n.getAttribute('onclick'),
      // 名字元素（真正绑点击的可能是它）
      nameEl: (() => {
        const ne = n.querySelector('.posCatalog_name');
        return ne ? {
          cls: ne.className.toString(),
          onclick: ne.getAttribute('onclick'),
          href: ne.getAttribute('href'),
          tag: ne.tagName
        } : null;
      })(),
      // 内部 a 标签
      anchors: [...n.querySelectorAll('a')].map(a => ({
        cls: (a.className || '').toString().slice(0, 40),
        href: (a.getAttribute('href') || '').slice(0, 60),
        onclick: (a.getAttribute('onclick') || '').slice(0, 60),
        text: (a.textContent || '').trim().slice(0, 20)
      }))
    })), null, 2);
  })()`, ctx, false));

  /* ==================================================================
   * 10. 树里展开/折叠的机制
   * ================================================================== */
  H('10. 树的展开/折叠机制');

  console.log(await ev(sessionId, `(() => {
    const nodes = [...document.querySelectorAll('.posCatalog_select')];
    const collapsed = nodes.filter(n => /collapse|closed|fold/i.test(n.className || ''));
    const expanded = nodes.filter(n => /expand|open|unfold/i.test(n.className || ''));
    const toggles = [...document.querySelectorAll('.posCatalog_rotate, .rotate, [class*=arrow], [class*=toggle]')];
    return JSON.stringify({
      总数: nodes.length,
      折叠态: collapsed.length,
      展开态: expanded.length,
      展开按钮: toggles.slice(0, 5).map(e => ({
        tag: e.tagName,
        cls: (e.className || '').toString().slice(0, 50),
        text: (e.textContent || '').trim().slice(0, 15)
      })),
      // 是否有 display:none 的子节点
      隐藏节点数: nodes.filter(n => n.offsetParent === null).length
    }, null, 2);
  })()`, ctx, false));

  socket.destroy();
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

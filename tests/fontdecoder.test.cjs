// 字体解码器单元测试（Node 环境，用 canvas 桩模拟渲染）
// 用法：node fontdecoder.test.cjs [扩展目录]
//      不传参数时自动查找仓库里的 extension/ 目录
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** 找扩展根目录（含 manifest.json 的那一层） */
function findExtRoot() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  const here = __dirname;
  const candidates = [
    path.join(here, '..', 'extension'),
    path.join(here, '..'),
    path.join(here, '..', 'extension'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'manifest.json'))) return c;
  }
  throw new Error('找不到扩展目录，请把扩展路径作为第一个参数传入');
}

const ROOT = findExtRoot();

/* ---------- canvas 桩：用确定性笔画模拟"字形" ---------- */
function makeCanvas() {
  let W = 0;
  let H = 0;
  let data = null;

  // 模拟浏览器：resize 时重建缓冲区（内容清空）
  function resize(nw, nh) {
    W = nw;
    H = nh;
    data = new Uint8ClampedArray(Math.max(0, W * H * 4)).fill(255);
  }

  function ensure() {
    if (!data || data.length !== W * H * 4) resize(W, H);
  }

  const ctx = {
    fillStyle: '#000',
    textBaseline: '',
    textAlign: '',
    font: '',

    fillRect(x, y, w, h) {
      ensure();
      const v = (this.fillStyle === '#fff') ? 255 : 0;
      for (let yy = Math.round(y); yy < Math.round(y + h); yy++) {
        for (let xx = Math.round(x); xx < Math.round(x + w); xx++) {
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const p = (yy * W + xx) * 4;
          data[p] = v; data[p + 1] = v; data[p + 2] = v; data[p + 3] = 255;
        }
      }
    },

    fillText(ch, cx, cy) {
      const c = ch.codePointAt(0);
      const size = 30;
      const rows = [(c % 5) + 2, ((c >> 3) % 5) + 2, ((c >> 6) % 5) + 2];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const y = Math.round(cy - size / 2 + i * (size / 3));
        this.fillRect(Math.round(cx - size / 2 + r), y, size - r * 2, Math.max(2, Math.round(size / 8)));
      }
    },

    clearRect() { ensure(); data.fill(255); },

    getImageData(x, y, w, h) {
      ensure();
      return { width: w, height: h, data };
    }
  };

  return {
    get width() { return W; },
    set width(v) { resize(v, H); },
    get height() { return H; },
    set height(v) { resize(W, v); },
    getContext() {
      ensure();
      return ctx;
    }
  };
}

const documentStub = {
  createElement(t) {
    if (t === 'canvas') return makeCanvas();
    return { style: {}, appendChild() {} };
  },
  styleSheets: [],
  fonts: { add() {} },
  querySelector() { return null; },
  documentElement: { appendChild() {} }
};

const ctxObj = {
  console,
  document: documentStub,
  location: { href: 'https://mooc1.chaoxing.com/' },
  CSSRule: { FONT_FACE_RULE: 5 },
  FontFace: class { async load() { return this; } },
  getComputedStyle() { return { fontFamily: 'CustomFake' }; },
  chrome: { runtime: { sendMessage: async () => ({ ok: false }) } },
  Math, Set, Map, Float32Array, Uint8Array, Uint8ClampedArray,
  Array, Object, JSON, Promise, Number, String, RegExp, Error,
  atob: s => Buffer.from(s, 'base64').toString('binary'),
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  setTimeout, clearTimeout
};
ctxObj.window = ctxObj;
ctxObj.globalThis = ctxObj;
vm.createContext(ctxObj);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/content/fontdecoder.js'), 'utf8'), ctxObj);

const D = ctxObj.CSFontDecoder;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  [PASS] ' + name); pass++; }
  else { console.log('  [FAIL] ' + name + (extra !== undefined ? '  -> ' + extra : '')); fail++; }
}

(async () => {
  console.log('== 1. 模块导出 ==');
  check('CSFontDecoder 存在', !!D);
  check('decode 是函数', typeof D.decode === 'function');
  check('decodeMany 是函数', typeof D.decodeMany === 'function');
  check('renderFeatures 是函数', typeof D.renderFeatures === 'function');
  check('cosine 是函数', typeof D.cosine === 'function');
  check('diagnose 是函数', typeof D.diagnose === 'function');
  check('suspiciousFaces 是函数', typeof D.suspiciousFaces === 'function');

  console.log('\n== 2. 特征向量 ==');
  const feats = D.renderFeatures('Any', ['中', '国', '人', '民']);
  check('返回 4 个字的特征', feats.size === 4, feats.size);
  const v1 = feats.get('中');
  const expectDim = D.GRID * D.GRID;
  check(`特征维度 = ${expectDim}`, v1 && v1.length === expectDim, v1 && v1.length);
  check('特征非全零', v1 && v1.some(x => x > 0));
  check('不同字特征可区分', (() => {
    const a = feats.get('中'), b = feats.get('国');
    if (!a || !b) return false;
    return a.some((x, i) => Math.abs(x - b[i]) > 1e-9);
  })());

  console.log('\n== 3. 余弦相似度 ==');
  const A = new Float32Array([1, 0, 0]);
  const B = new Float32Array([1, 0, 0]);
  const C = new Float32Array([0, 1, 0]);
  check('相同向量 = 1', Math.abs(D.cosine(A, B) - 1) < 1e-6, D.cosine(A, B));
  check('正交向量 = 0', Math.abs(D.cosine(A, C)) < 1e-6, D.cosine(A, C));
  check('零向量返回 0 不 NaN', D.cosine(new Float32Array([0, 0, 0]), A) === 0);

  console.log('\n== 4. 渲染确定性 ==');
  const f2 = D.renderFeatures('Any', ['中', '国', '人', '民']);
  check('同输入同输出', f2.get('中').every((x, i) => Math.abs(x - v1[i]) < 1e-9));

  console.log('\n== 4b. 位置无关性（关键）==');
  // 同一字符放在不同位置渲染，特征必须一致，
  // 否则建库和查表会因为排版位置不同而误判
  const mk = (pos) => {
    const arr = new Array(900).fill(' ');
    arr[pos] = '问';
    const m = new Map();
    D.renderBatch('SimHei', arr, m);
    return m.get('问');
  };
  const p0 = mk(0), p31 = mk(31), p32 = mk(32), p900 = mk(899);
  check('pos0 vs pos31 一致', p0 && p31 && D.cosine(p0, p31) > 0.9999);
  check('pos0 vs pos32 一致', p0 && p32 && D.cosine(p0, p32) > 0.9999);
  check('pos0 vs pos899 一致', p0 && p900 && D.cosine(p0, p900) > 0.9999);

  console.log('\n== 5. CJK 判定 ==');
  check('中是 CJK', D.isCJK('中'));
  check('A 不是 CJK', !D.isCJK('A'));
  check('逗号不是 CJK', !D.isCJK('，'));
  check('生僻字忞是 CJK', D.isCJK('忞'));
  check('扩展A区 㐀 是 CJK', D.isCJK('㐀'));

  console.log('\n== 6. 一级字库 ==');
  check('字库 >= 2000 字', D.FREQ_CHARS.length >= 2000, D.FREQ_CHARS.length);
  check('字库无重复', new Set(D.FREQ_CHARS).size === D.FREQ_CHARS.length,
    D.FREQ_CHARS.length + ' vs ' + new Set(D.FREQ_CHARS).size);
  // 这些字缺一个都会导致整句解码出错，必须覆盖
  const MUST_HAVE = '的一是在不了有和人这中大为上个国我以要他时来用们问题目答案选择判断填空签丧失帝封建官僚资本民族垄断';
  const missing = [...MUST_HAVE].filter(c => !D.FREQ_CHARS.includes(c));
  check('关键常用字全覆盖', missing.length === 0, missing.join(' '));

  console.log('\n== 7. 无自定义字体时不误伤 ==');
  const orig = D.suspiciousFaces;
  D.suspiciousFaces = () => [];
  const r = await D.decode('中国革命', documentStub.createElement('div'));
  check('原样返回', r.text === '中国革命' && r.changed === 0, JSON.stringify(r));
  D.suspiciousFaces = orig;

  console.log('\n== 8. 纯符号文本快速返回 ==');
  const r2 = await D.decode('123 ABC', documentStub.createElement('div'));
  check('无中文不报错', r2.ok === true && r2.text === '123 ABC', JSON.stringify(r2));

  console.log('\n== 9. diagnose 不崩 ==');
  let diag;
  try { diag = D.diagnose(documentStub); } catch (e) { diag = null; }
  check('diagnose 返回对象', diag && typeof diag === 'object');
  check('含 suspicious 数组', Array.isArray(diag.suspicious));
  check('含 freqCharCount', typeof diag.freqCharCount === 'number');

  console.log('\n== 10. decodeMany 批量 ==');
  const many = await D.decodeMany(['abc', '中文测试'], documentStub.createElement('div'));
  check('返回同长度数组', Array.isArray(many) && many.length === 2, many && many.length);
  check('第一项原样', many[0].text === 'abc');

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();

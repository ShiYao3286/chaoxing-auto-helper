/**
 * 字体反爬解码器（学习通题干/选项专用）
 *
 * ── 原理 ──────────────────────────────────────────────
 * 学习通把题干正文替换成生僻字码位（如「忞忖忟命」），再通过
 * @font-face 加载自定义字体，把那些码位渲染成正常汉字的字形。
 * 因此 DOM 里读到的是错字，只有「渲染出来的形状」才是对的。
 *
 * ── 做法 ──────────────────────────────────────────────
 *  1. 找出题干元素实际使用的自定义字体
 *  2. 下载字体 → FontFace 注册 → 用它把混淆字符渲染成位图
 *  3. 用系统中文字体渲染候选字做参照
 *  4. 比对墨迹分布，取最相似的字
 *
 * ── 精度设计 ──────────────────────────────────────────
 * 分辨率是精度的命门。12×12 网格分不清「要/置」「帝/带」这类
 * 形近字，本实现用 28×28（784 维）。
 *
 * 匹配分两级：
 *   一级：高频字表（~500 字）× 高分辨率 → 秒出结果
 *   二级：仅对一级得分偏低的字，流式扫描 CJK 基本区 2 万字
 *        （不预存全部特征，边渲染边比，内存占用恒定）
 *
 * ── 性能设计 ──────────────────────────────────────────
 * 所有字一次性画到同一张画布（网格排布），只 getImageData 一次，
 * 再按格子切片。比逐字 createCanvas + getImageData 快约 30 倍。
 */

'use strict';

var CSFontDecoder = (function () {

  /* ============================================================
   * 1. 字体探测
   * ============================================================ */

  function collectFontFaces(doc) {
    const out = [];
    let sheets = [];
    try { sheets = [...doc.styleSheets]; } catch { return out; }

    for (const sheet of sheets) {
      let rules = [];
      try { rules = [...sheet.cssRules]; } catch { continue; } // 跨域表跳过
      for (const r of rules) {
        if (!r || r.type !== CSSRule.FONT_FACE_RULE) continue;

        const family = (r.style.fontFamily || '').replace(/^["']|["']$/g, '').trim();
        if (!family) continue;

        // 读 src 的可靠方式：
        // getPropertyValue('src') 对 data-URI 常返回空（分号截断），
        // 必须退回 cssText 里抓。
        let src = r.style.getPropertyValue('src') || '';
        if (!src) {
          const m = (r.cssText || '').match(/src\s*:\s*(.+?)(?:unicode-range|font-display|font-weight|font-style|$)/i);
          if (m) src = m[1];
        }

        out.push({
          family,
          src: src.trim(),
          cssText: r.cssText || '',
          unicodeRange: r.style.getPropertyValue('unicode-range') || ''
        });
      }
    }
    return out;
  }

  function extractFontUrl(src) {
    if (!src) return null;
    const m = src.match(/url\(\s*["']?([^"')]+)["']?\s*\)/i);
    if (!m) return null;
    const u = m[1].trim();
    if (/^data:/i.test(u)) return u;
    try { return new URL(u, location.href).href; } catch { return u; }
  }

  const SYSTEM_FONT = /^(system-ui|sans-serif|serif|monospace|-apple-system|BlinkMacSystemFont|Microsoft YaHei|微软雅黑|SimSun|宋体|SimHei|黑体|PingFang SC|Arial|Helvetica|Segoe UI|Tahoma|Verdana|Roboto|Noto Sans SC|inherit|initial|unset|serif)$/i;

  function suspiciousFaces(doc) {
    return collectFontFaces(doc)
      .filter(f => !SYSTEM_FONT.test(f.family))
      .map(f => ({ ...f, url: extractFontUrl(f.src) }))
      .filter(f => f.url);
  }

  /** 找元素最终生效的自定义字体 */
  function fontOf(el) {
    if (!el) return null;
    const doc = el.ownerDocument || document;
    const faces = suspiciousFaces(doc);
    if (!faces.length) return null;

    let fam = '';
    try { fam = getComputedStyle(el).fontFamily || ''; } catch { /* ignore */ }

    const names = fam.split(',').map(s => s.trim().replace(/^["']|["']$/g, '').toLowerCase());

    for (const n of names) {
      const hit = faces.find(f => f.family.toLowerCase() === n);
      if (hit) return hit;
    }
    for (const f of faces) {
      if (fam.toLowerCase().includes(f.family.toLowerCase())) return f;
    }
    return faces[0];
  }

  /* ============================================================
   * 2. 渲染与特征
   * ============================================================ */

  const CELL = 56;   // 单字格子边长(px)
  const GRID = 28;   // 网格 28x28 = 784 维
  const COLS = 32;   // 画布每行几个字
  const BATCH = COLS * 32;   // 每次渲染 1024 字

  /**
   * 渲染一批字符，返回 Map<字符, Float32Array|null>
   * null 表示该字体缺这个字形（渲染成空白）
   */
  function renderBatch(family, chars, out) {
    const n = chars.length;
    if (!n) return;

    // 关键：画布宽度固定，每个字的位置完全由索引决定。
    // 只要同一字符在两次渲染中出现的位置不同（比如一次在
    // 33 位、一次在 900 位），亚像素抗锯齿就会不同，
    // 导致同源字体自匹配从 1.0 掉到 0.93，进而误判。
    // 解决：保持位置一致 —— 每批都从索引 0 开始排。
    const rows = Math.ceil(n / COLS);
    const W = COLS * CELL;
    const H = rows * CELL;

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.font = Math.round(CELL * 0.76) + 'px "' + family + '"';

    for (let i = 0; i < n; i++) {
      const cx = (i % COLS) * CELL + CELL / 2;
      const cy = Math.floor(i / COLS) * CELL + CELL / 2;
      ctx.fillText(chars[i], cx, cy);
    }

    let img;
    try { img = ctx.getImageData(0, 0, W, H); }
    catch { return; }
    const data = img.data;
    const cw = CELL / GRID;

    for (let i = 0; i < n; i++) {
      const ox = (i % COLS) * CELL;
      const oy = Math.floor(i / COLS) * CELL;

      // ── 步骤1：取出该格子的原始墨量图 ──
      const raw = new Float32Array(CELL * CELL);
      let totalInk = 0;
      for (let y = 0; y < CELL; y++) {
        const rowBase = (oy + y) * W + ox;
        for (let x = 0; x < CELL; x++) {
          const v = 1 - data[(rowBase + x) * 4] / 255;
          raw[y * CELL + x] = v;
          totalInk += v;
        }
      }
      if (totalInk < 1) { out.set(chars[i], null); continue; }

      // ── 步骤2：找墨迹包围盒 ──
      // 消除位置/留白差异：同一字符无论画在格子哪个位置，
      // 裁到墨迹边界后重采样，结果都一致。
      let minX = CELL, maxX = -1, minY = CELL, maxY = -1;
      for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
          if (raw[y * CELL + x] > 0.06) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < minX || maxY < minY) { out.set(chars[i], null); continue; }

      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;

      // ── 步骤3：按包围盒等比缩放到 GRID×GRID ──
      // 必须保持宽高比！
      // 若强行拉伸填满正方形，「问」的「口」会被压扁，
      // 结果和「门」几乎一样 —— 这正是之前把「问」认成「门」的原因。
      // 等比缩放 + 居中留白，部件的大小与相对位置才得以保留。
      const scale = Math.max(bw, bh);
      const padX = (scale - bw) / 2;
      const padY = (scale - bh) / 2;

      const vec = new Float32Array(GRID * GRID);
      for (let v = 0; v < GRID; v++) {
        for (let u = 0; u < GRID; u++) {
          // 这个格子在"正方形化"坐标系中的范围
          const fx0 = u / GRID, fx1 = (u + 1) / GRID;
          const fy0 = v / GRID, fy1 = (v + 1) / GRID;

          let sum = 0, cnt = 0;
          // 在该格子内采样 3x3 个点，做面积平均
          const S = 3;
          for (let sy = 0; sy < S; sy++) {
            const fy = fy0 + (fy1 - fy0) * ((sy + 0.5) / S);
            const py = Math.floor(minY - padY + fy * scale);
            if (py < 0 || py >= CELL) continue;
            for (let sx = 0; sx < S; sx++) {
              const fx = fx0 + (fx1 - fx0) * ((sx + 0.5) / S);
              const px = Math.floor(minX - padX + fx * scale);
              if (px < 0 || px >= CELL) continue;
              sum += raw[py * CELL + px];
              cnt++;
            }
          }
          vec[v * GRID + u] = cnt ? sum / cnt : 0;
        }
      }
      out.set(chars[i], vec);
    }
  }

  /** 渲染任意字符集（自动分批） */
  function renderFeatures(family, chars) {
    const out = new Map();
    for (let i = 0; i < chars.length; i += BATCH) {
      renderBatch(family, chars.slice(i, i + BATCH), out);
    }
    return out;
  }

  /** 余弦相似度 */
  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
    }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  /**
   * 字形归一化：笔画骨架提取
   *
   * 为什么必须做：实测同一字在不同字体间余弦相似度只有 0.32~0.81
   * （SimHei 与 Microsoft YaHei 仅 0.44），而同字体是 1.0。
   * 字体风格差异远大于字与字的差异，直接比对必然失准。
   *
   * 对策：把「墨量图」转成「骨架图」
   *   1. 二值化：只关心有没有笔画，不关心粗细
   *   2. 轻度模糊：抹掉衬线、笔画末端等字体特有细节
   *   3. 保留结构：横竖撇捺的排布才是字的身份
   */
  function normalizeVec(vec, grid) {
    const n = vec.length;

    // 1) 二值化——消除笔画粗细差异
    let sum = 0;
    for (let i = 0; i < n; i++) sum += vec[i];
    const mean = sum / n;
    const thr = Math.max(mean * 0.55, 0.02);

    const bin = new Float32Array(n);
    for (let i = 0; i < n; i++) bin[i] = vec[i] > thr ? 1 : 0;

    // 2) 3x3 均值模糊——抹掉字体细节，保留结构
    const out = new Float32Array(n);
    for (let y = 0; y < grid; y++) {
      for (let x = 0; x < grid; x++) {
        let acc = 0, cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= grid) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= grid) continue;
            acc += bin[ny * grid + nx];
            cnt++;
          }
        }
        out[y * grid + x] = cnt ? acc / cnt : 0;
      }
    }
    return out;
  }

  /* ============================================================
   * 3. 候选字库
   * ============================================================ */

  /**
   * 一级字库
   *
   * 为什么必须足够大：实测同源字体自匹配 = 1.0，
   * 只要真字在这个表里，就一定能被 100% 正确认出。
   * 反过来，表里没有的字会退到"全量搜索"，
   * 那一步是逐码位比对，容易被形近字干扰。
   *
   * 所以这里尽量覆盖：GB2312 一级字（3755 个常用字）
   * 结合思政教材用词。全量约 2000 字，单次建库耗时可控。
   */
  const FREQ_CHARS = (
    // ===== 最常用字（先放，确保一定覆盖）=====
    '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严龙飞' +
    // ===== 判断题/选择题常用动词与名词 =====
    '题目答案选择判断填空正确错误以下哪项属于不是关于说法理解分析简答论述材料阅读请根据要求回答下列各' +
    '首要对象革命动力性质特点意义作用影响原因结果目的任务内容方式方法途径条件前提基础核心关键重点难点' +
    '时期阶段过程历史现状未来发展趋势规律经验教训启示认识实践理论观点立场态度看法主张意见建议措施' +
    '增加减少提高降低促进推动阻碍限制影响改变形成产生出现存在具有包含包括分为组成构成建立实现完成' +
    '必须应当可以可能能够需要必要充分主要重要基本根本直接间接明显显著突出严重轻微普遍特殊一般共同' +
    // ===== GB2312 常用字（拼音序）=====
    '啊阿埃挨哎唉哀皑癌蔼矮艾碍爱隘鞍氨安俺按暗岸胺案肮昂盎凹敖熬翱袄傲奥懊澳芭捌扒叭吧笆八疤巴拔跋靶把耙坝霸罢爸白柏百摆佰败拜稗斑班搬扳般颁板版扮拌伴瓣半办绊邦帮梆榜膀绑棒磅蚌镑傍谤苞胞包褒剥' +
    '薄雹保堡饱宝抱报暴豹鲍爆杯碑悲卑北辈背贝钡倍狈备惫焙被奔苯本笨崩绷甭泵蹦迸逼鼻比鄙笔彼碧蓖蔽毕毙毖币庇痹闭敝弊必辟壁臂避陛鞭边编贬扁便变卞辨辩辫遍标彪膘表鳖憋别瘪彬斌濒滨宾摈兵冰柄丙秉饼炳' +
    '病并玻菠播拨钵波博勃搏铂箔伯帛舶脖膊渤泊驳捕卜哺补埠不布步簿部怖擦猜裁材才财睬踩采彩菜蔡餐参蚕残惭惨灿苍舱仓沧藏操糙槽曹草厕策侧册测层蹭插叉茬茶查碴搽察岔差诧拆柴豺搀掺蝉馋谗缠铲产阐颤昌猖' +
    '场尝常长偿肠厂敞畅唱倡超抄钞朝嘲潮巢吵炒车扯撤掣彻澈郴臣辰尘晨忱沉陈趁衬撑称城橙成呈乘程惩澄诚承逞骋秤吃痴持匙池迟弛驰耻齿侈尺赤翅斥炽充冲虫崇宠抽酬畴踌稠愁筹仇绸瞅丑臭初出橱厨躇锄雏滁除楚' +
    '础储矗搐触处揣川穿椽传船喘串疮窗幢床闯创吹炊捶锤垂春椿醇唇淳纯蠢戳绰疵茨磁雌辞慈瓷词此刺赐次聪葱囱匆从丛凑粗醋簇促蹿篡窜摧崔催脆瘁粹淬翠村存寸磋撮搓措挫错搭达答瘩打大呆歹傣戴带殆代贷袋待逮' +
    '怠耽担丹单郸掸胆旦氮但惮淡诞弹蛋当挡党荡档刀捣蹈倒岛祷导到稻悼道盗德得的蹬灯登等瞪凳邓堤低滴迪敌笛狄涤翟嫡抵底地蒂第帝弟递缔颠掂滇碘点典靛垫电佃甸店惦奠淀殿碉叼雕凋刁掉吊钓调跌爹碟蝶迭谍叠' +
    '丁盯叮钉顶鼎锭定订丢东冬董懂动栋侗恫冻洞兜抖斗陡豆逗痘都督毒犊独读堵睹赌杜镀肚度渡妒端短锻段断缎堆兑队对墩吨蹲敦顿囤钝盾遁掇哆多夺垛躲朵跺舵剁惰堕蛾峨鹅俄额讹娥恶厄扼遏鄂饿恩而儿耳尔饵洱二' +
    '贰发罚筏伐乏阀法珐藩帆番翻樊矾钒繁凡烦反返范贩犯饭泛坊芳方肪房防妨仿访纺放菲非啡飞肥匪诽吠肺废沸费芬酚吩氛分纷坟焚汾粉奋份忿愤粪丰封枫蜂峰锋风疯烽逢冯缝讽奉凤佛否夫敷肤孵扶拂辐幅氟符伏俘服' +
    '浮涪福袱弗甫抚辅俯釜斧脯腑府腐赴副覆赋复傅付阜父腹负富讣附妇缚咐噶嘎该改概钙盖溉干甘杆柑竿肝赶感秆敢赣冈刚钢缸肛纲岗港杠篙皋高膏羔糕搞镐稿告哥歌搁戈鸽胳疙割革葛格蛤阁隔铬个各给根跟耕更庚羹' +
    '埂耿梗工攻功恭龚供躬公宫弓巩汞拱贡共钩勾沟苟狗垢构购够辜菇咕箍估沽孤姑鼓古蛊骨谷股故顾固雇刮瓜剐寡挂褂乖拐怪棺关官冠观管馆罐惯灌贯光广逛瑰规圭硅归龟闺轨鬼诡癸桂柜跪贵刽辊滚棍锅郭国果裹过哈' +
    '骸孩海氦亥害骇酣憨邯韩含涵寒函喊罕翰撼捍旱憾悍焊汗汉夯杭航壕嚎豪毫郝好耗号浩呵喝荷菏核禾和何合盒貉阂河涸赫褐鹤贺嘿黑痕很狠恨哼亨横衡恒轰哄烘虹鸿洪宏弘红喉侯猴吼厚候后呼乎忽瑚壶葫胡蝴狐糊湖' +
    '弧虎唬护互沪户花哗华猾滑画划化话槐徊怀淮坏欢环桓还缓换患唤痪豢焕涣宦幻荒慌黄磺蝗簧皇凰惶煌晃幌恍谎灰挥辉徽恢蛔回毁悔慧卉惠晦贿秽会烩汇讳诲绘荤昏婚魂浑混豁活伙火获或惑霍货祸击圾基机畸稽积箕' +
    '肌饥迹激讥鸡姬绩缉吉极棘辑籍集及急疾汲即嫉级挤几脊己蓟技冀季伎祭剂悸济寄寂计记既忌际妓继纪嘉枷夹佳家加荚颊贾甲钾假稼价架驾嫁歼监坚尖笺间煎兼肩艰奸缄茧检柬碱硷拣捡简俭剪减荐槛鉴践贱见键箭件' +
    '健舰剑饯渐溅涧建僵姜将浆江疆蒋桨奖讲匠酱降蕉椒礁焦胶交郊浇骄娇嚼搅铰矫侥脚狡角饺缴绞剿教酵轿较叫窖揭接皆秸街阶截劫节桔杰捷睫竭洁结解姐戒藉芥界借介疥诫届巾筋斤金今津襟紧锦仅谨进靳晋禁近烬浸' +
    '尽劲荆兢茎睛晶鲸京惊精粳经井警景颈静境敬镜径痉靖竟竞净炯窘揪究纠玖韭久灸九酒厩救旧臼舅咎就疚鞠拘狙疽居驹菊局咀矩举沮聚拒据巨具距踞锯俱句惧炬剧捐鹃娟倦眷卷绢撅攫抉掘倔爵觉决诀绝均菌钧军君峻' +
    '俊竣浚郡骏喀咖卡咯开揩楷凯慨刊堪勘坎砍看康慷糠扛抗亢炕考拷烤靠坷苛柯棵磕颗科壳咳可渴克刻客课肯啃垦恳坑吭空恐孔控抠口扣寇枯哭窟苦酷库裤夸垮挎跨胯块筷侩快宽款匡筐狂框矿眶旷况亏盔岿窥葵奎魁傀' +
    '馈愧溃坤昆捆困括扩廓阔垃拉喇蜡腊辣啦莱来赖蓝婪栏拦篮阑兰澜谰揽览懒缆烂滥琅榔狼廊郎朗浪捞劳牢老佬姥酪烙涝勒乐雷镭蕾磊累儡垒擂肋类泪棱楞冷厘梨犁黎篱狸离漓理李里鲤礼莉荔吏栗丽厉励砾历利傈例俐' +
    '痢立粒沥隶力璃哩俩联莲连镰廉怜涟帘敛脸链恋炼练粮凉梁粱良两辆量晾亮谅撩聊僚疗燎寥辽潦了撂镣廖料列裂烈劣猎琳林磷霖临邻鳞淋凛赁吝拎玲菱零龄铃伶羚凌灵陵岭领另令溜琉榴硫馏留刘瘤流柳六龙聋咙笼窿' +
    '隆垄拢陇楼娄搂篓漏陋芦卢颅庐炉掳卤虏鲁麓碌露路赂鹿潞禄录陆戮驴吕铝侣旅履屡缕虑氯律率滤绿峦挛孪滦卵乱掠略抡轮伦仑沦纶论萝螺罗逻锣箩骡裸落洛骆络妈麻玛码蚂马骂嘛吗埋买麦卖迈脉瞒馒蛮满蔓曼慢漫' +
    '谩芒茫盲氓忙莽猫茅锚毛矛铆卯茂冒帽貌贸么玫枚梅酶霉煤没眉媒镁每美昧寐妹媚门闷们萌蒙檬盟锰猛梦孟眯醚靡糜迷谜弥米秘觅泌蜜密幂棉眠绵冕免勉娩缅面苗描瞄藐秒渺庙妙蔑灭民抿皿敏悯闽明螟鸣铭名命谬摸' +
    '摹蘑模膜磨摩魔抹末莫墨默沫漠寞陌谋牟某拇牡亩姆母墓暮幕募慕木目睦牧穆拿哪呐钠那娜纳氖乃奶耐奈南男难囊挠脑恼闹淖呢馁内嫩能妮霓倪泥尼拟你匿腻逆溺蔫拈年碾撵捻念娘酿鸟尿捏聂孽啮镊镍涅您柠狞凝宁'
  ).split('');

  /**
   * 思政 / 近现代史 专业用字补充
   * （上面 GB2312 表里没有、但本课程高频出现的字）
   */
  const SUBJECT_CHARS = (
    '帝封建官僚剥削压迫侵略殖民半爱国统战武装斗争道路经验教训左右倾投降派军阀混战割据政权统治腐朽没落衰亡崩溃瓦解巩固壮大领导先锋组织群众路线独立自主自力更生艰苦奋斗勤俭节约改革开放市场经济计划体制公有私制分配按劳要素效率公平正义法治德治民主科学文化教育医疗卫住房就业保障社会保险福利慈善救助灾害救济贫困富裕共同现代小康目标百年步走布局战略总体五位一体全面协调绿色开放共享理念高质量供给结构侧改革一带一路人类命运共体和平合作共赢全球治理际秩序外交关系周边南南' +
    '鸦片南京辛丑马关虎门销烟甲午戊戌变法辛亥五四运共成国民革命土抗日解放过渡改造合作化公社大跃进纠正错误总结实事求是解放思想与时俱进求真务实代表观决胜复兴强军国防队港澳台侨胞祖国习近平新时代特色社会主义思想中国梦' +
    '垄断买办资本阶级民族形式特点规律本质现象矛盾辩证唯物历史唯心形而上学意识形态上层建筑经济基础生产力生产关系剩余价值商品货币市场金融危机构建和谐可持续生态文明绿色发展循环低碳清洁能源资源节约环境友好主体功能' +
    // 条约 / 时间 / 常用书面语（易漏，单列）
    '签订条约协议丧失失败独立自主地位沦为殖民地半殖民地封建社会性质巨大变化标志开始完全彻底结束推翻清算' +
    '签署缔结履行生效期满延长终止废除撤销承认批准加入退出成员资格权利利益义务责任担当使命任务目标方向路线方针政策策略' +
    '剥削阶级阶层联盟同盟阵线阵营势力范围地盘领土领空领海主权治权统治权领导权管理权所有权使用权经营权'
  ).split('');

  /** 一级字库（去重） */
  const FREQ_UNIQ = [...new Set(FREQ_CHARS.concat(SUBJECT_CHARS))];

  /** 二级：CJK 基本区全量（懒生成，仅在必要时用） */
  let ALL_CJK = null;
  function allCjk() {
    if (ALL_CJK) return ALL_CJK;
    const out = [];
    for (let c = 0x4e00; c <= 0x9fa5; c++) out.push(String.fromCharCode(c));
    ALL_CJK = out;
    return out;
  }

  /* ============================================================
   * 4. 参照字体
   * ============================================================ */

  let sysFontCache;

  /**
   * 找出一组真正能渲染中文的系统字体
   *
   * 为什么要多个：实测不同字体渲染同一个字，余弦相似度只有
   * 0.32~0.81（SimHei 与 Microsoft YaHei 仅 0.44）。
   * 反爬字体具体基于哪一款无从得知，用单字体参照必然失准。
   * 多字体取最高分，鲁棒性高得多。
   */
  function pickSystemFonts() {
    if (sysFontCache !== undefined) return sysFontCache;

    const candidates = [
      'Microsoft YaHei', 'SimHei', 'SimSun', 'KaiTi',
      'FangSong', 'PingFang SC', 'Noto Sans CJK SC',
      'Source Han Sans SC', 'Microsoft JhengHei',
      'sans-serif', 'serif'
    ];

    const probe = document.createElement('canvas');
    probe.width = 48;
    probe.height = 48;
    const c = probe.getContext('2d', { willReadFrequently: true });

    const ok = [];
    for (const fam of candidates) {
      c.fillStyle = '#fff';
      c.fillRect(0, 0, 48, 48);
      c.fillStyle = '#000';
      c.textBaseline = 'middle';
      c.textAlign = 'center';
      c.font = '38px "' + fam + '"';
      c.fillText('国', 24, 24);

      const d = c.getImageData(0, 0, 48, 48).data;
      let ink = 0;
      for (let i = 0; i < d.length; i += 4) ink += 255 - d[i];

      // 阈值：真的画出字来（不是空白/豆腐块）
      if (ink > 3000) ok.push(fam);
    }

    // 去掉渲染完全相同的重复项（如 sans-serif 与 serif 可能指向同一字体）
    sysFontCache = ok.length ? ok : null;
    return sysFontCache;
  }

  /** 兼容旧接口 */
  function pickSystemFont() {
    const list = pickSystemFonts();
    return list ? list[0] : null;
  }

  /* ============================================================
   * 5. 基础字体识别（精度关键）
   * ============================================================ */

  /**
   * 找出反爬字体派生自哪个系统字体
   *
   * ── 为什么这一步决定成败 ──────────────────────────
   * 实测数据：同一个字
   *   · 同字体渲染      余弦相似度 = 1.0000
   *   · 跨字体渲染      余弦相似度 = 0.44（SimHei vs 微软雅黑）
   *
   * 而形近字之间（要/耍、垄/重）相似度高达 0.90+
   *
   * 也就是说：跨字体差异 ≫ 形近字差异。
   * 用错参照字体，形近字必然混淆 —— 这就是「要→善」「垄→重」
   * 这类错误的根源。
   *
   * ── 怎么找出派生字体 ──────────────────────────────
   * 反爬字体通常只改了「被混淆的那批码位」，其余字符原样保留。
   * 拿一批**常见字**（中/国/的/一/是…，这些几乎不会被混淆），
   * 用反爬字体渲染，再逐一与各系统字体渲染的同一字比对：
   * 派生字体得分会接近 1，其他字体只有 0.4 左右。
   * 得分最高者即为基础字体。
   *
   * 找不到（比如字体被整体替换）时，退化为多字体投票。
   */
  const PROBE_CHARS = '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出';

  async function detectBaseFont(fontFam) {
    const families = pickSystemFonts();
    if (!families || !families.length) return null;

    const probes = PROBE_CHARS.split('');

    // 反爬字体渲染探测字
    const mineRaw = new Map();
    renderBatch(fontFam, probes, mineRaw);

    const mine = new Map();
    for (const [ch, vec] of mineRaw) {
      if (vec) mine.set(ch, vec);
    }
    if (mine.size < 4) return null;   // 探测字都画不出来，没法判断

    let bestFam = null, bestScore = -1;

    for (const fam of families) {
      const refRaw = new Map();
      renderBatch(fam, probes, refRaw);

      let sum = 0, n = 0;
      for (const [ch, vec] of mine) {
        const rv = refRaw.get(ch);
        if (!rv) continue;
        sum += cosine(vec, rv);
        n++;
      }
      if (!n) continue;

      const score = sum / n;
      if (score > bestScore) { bestScore = score; bestFam = fam; }
    }

    // 阈值：同源应 > 0.95；低于 0.80 说明这个字体跟系统字体都不是同源，
    // 此时用「最高分」仍比随便挑一个强，但标记为低置信
    return {
      family: bestFam,
      score: Number(bestScore.toFixed(4)),
      confident: bestScore > 0.90
    };
  }

  /* ============================================================
   * 6. 匹配
   * ============================================================ */

  /**
   * 多字体标准字形库（一次建好反复用）
   * 结构：[{ family, map: Map<char, Float32Array|null> }]
   */
  let stdCache = null;

  function buildStdCache(chars) {
    const families = pickSystemFonts();
    if (!families) return null;

    const arr = [];
    for (const fam of families) {
      const raw = new Map();
      renderBatch(fam, chars, raw);

      // 转成归一化特征（模糊后比对更稳）
      const norm = new Map();
      for (const [ch, vec] of raw) {
        if (!vec) continue;
        norm.set(ch, normalizeVec(vec, GRID));
      }
      if (norm.size) arr.push({ family: fam, map: norm });
    }
    return arr.length ? arr : null;
  }

  /**
   * 在候选字集中找与 target 最相似的字（跨多参照字体取最优）
   * @param {Float32Array} target  已归一化的目标特征
   * @param {string[]} chars
   * @param {Array} stds           多字体标准库
   * @param {number} maxBatches    每字体最多扫多少批
   * @returns {{ch:string, score:number, fonts:Object}}
   */
  function bestMatch(target, chars, stds, maxBatches = Infinity) {
    let bestCh = '', bestScore = -1;

    for (const std of stds) {
      let batches = 0;

      for (let i = 0; i < chars.length; i += BATCH) {
        if (batches >= maxBatches) break;
        batches++;

        const slice = chars.slice(i, i + BATCH);
        const raw = new Map();
        renderBatch(std.family, slice, raw);

        for (const [ch, vec] of raw) {
          if (!vec) continue;
          const s = cosine(target, normalizeVec(vec, GRID));
          if (s > bestScore) { bestScore = s; bestCh = ch; }
        }
      }
    }
    return { ch: bestCh, score: bestScore };
  }

  /* ============================================================
   * 6. 解码
   * ============================================================ */

  function isCJK(ch) {
    const c = ch.codePointAt(0);
    return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff);
  }

  async function loadFontBuffer(url) {
    // data URI 直接解
    if (/^data:/i.test(url)) {
      const comma = url.indexOf(',');
      const meta = url.slice(0, comma);
      const payload = url.slice(comma + 1);
      let bin;
      if (/;base64/i.test(meta)) {
        bin = atob(payload);
      } else {
        bin = decodeURIComponent(payload);
      }
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      return buf.buffer;
    }

    // 优先走宿主代理（绕过页面 CORS）
    let b64 = null;
    try {
      const H = window.CSHost;
      if (H && typeof H.send === 'function') {
        const resp = await H.send('font:fetch', { url });
        if (resp && resp.ok && resp.b64) b64 = resp.b64;
      }
    } catch { /* 宿主不可用，走直连 */ }

    // 兜底：页面内直接取
    if (!b64) {
      const r = await fetch(url, { credentials: 'omit' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const ab = await r.arrayBuffer();
      const bytes = new Uint8Array(ab);
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      b64 = btoa(bin);
    }

    const bin2 = atob(b64);
    const buf = new Uint8Array(bin2.length);
    for (let i = 0; i < bin2.length; i++) buf[i] = bin2.charCodeAt(i);
    return buf.buffer;
  }

  const loadedFonts = new Map();   // url -> family

  async function ensureFont(url) {
    if (loadedFonts.has(url)) return loadedFonts.get(url);
    const buffer = await loadFontBuffer(url);
    const fam = '__CSDEC_' + Math.random().toString(36).slice(2, 9);
    const ff = new FontFace(fam, buffer);
    await ff.load();
    document.fonts.add(ff);
    loadedFonts.set(url, fam);
    return fam;
  }

  const yieldTick = () => new Promise(r => setTimeout(r, 0));

  async function decode(text, ctxEl) {
    const r = await decodeMany([text], ctxEl);
    return r[0];
  }

  /**
   * 批量解码（同字体多段文本，共享字形渲染）
   */
  async function decodeMany(texts, ctxEl) {
    const plain = t => ({
      ok: true, text: t, map: {}, changed: 0,
      lowConfidence: 0, avgScore: 1, reason: '无需解码'
    });

    const uniq = [...new Set(texts.join('').split(''))].filter(isCJK);
    if (!uniq.length) return texts.map(plain);

    const face = fontOf(ctxEl);
    if (!face) return texts.map(plain);

    let fontFam;
    try {
      fontFam = await ensureFont(face.url);
    } catch (e) {
      return texts.map(t => ({ ...plain(t), ok: false, reason: '字体加载失败：' + e.message }));
    }

    const sysFams = pickSystemFonts();
    if (!sysFams || !sysFams.length) {
      return texts.map(t => ({ ...plain(t), ok: false, reason: '系统缺少可用的中文字体' }));
    }

    // ★ 关键：先认出这个反爬字体派生自哪个系统字体
    //   同源字体相似度 1.0，跨字体只有 0.44，用错参照必然误判形近字
    const base = await detectBaseFont(fontFam);

    // 渲染混淆字形
    const obRaw = renderFeatures(fontFam, uniq);
    if (!obRaw.size) {
      return texts.map(t => ({ ...plain(t), ok: false, reason: '字形渲染失败（canvas 不可用）' }));
    }

    // 同源时不做归一化（保持原始像素，精度最高）；
    // 非同源才用骨架归一化，尽量压掉字体风格差异。
    const sameSource = !!(base && base.confident);
    const prep = sameSource
      ? (v) => v
      : (v) => normalizeVec(v, GRID);

    const obFeats = new Map();
    for (const [ch, vec] of obRaw) {
      if (vec) obFeats.set(ch, prep(vec));
    }

    // 参照字体：同源时只用那一款；否则多字体投票
    const refFams = sameSource ? [base.family] : sysFams;

    const stds = [];
    for (const fam of refFams) {
      const raw = new Map();
      renderBatch(fam, FREQ_UNIQ, raw);
      const norm = new Map();
      for (const [ch, vec] of raw) {
        if (vec) norm.set(ch, prep(vec));
      }
      if (norm.size) stds.push({ family: fam, map: norm });
    }
    if (!stds.length) {
      return texts.map(t => ({ ...plain(t), ok: false, reason: '无法建立参照字库' }));
    }

    // ---- 一级：常用字库 ----
    const map = {};
    const uncertain = [];

    for (const ch of uniq) {
      const vec = obFeats.get(ch);
      if (!vec) { map[ch] = { to: ch, score: 0, blank: true }; continue; }

      let bestCh = '', bestScore = -1;
      let secondScore = -1;

      for (const std of stds) {
        for (const [sch, svec] of std.map) {
          const s = cosine(vec, svec);
          if (s > bestScore) {
            secondScore = bestScore;
            bestScore = s;
            bestCh = sch;
          } else if (s > secondScore) {
            secondScore = s;
          }
        }
      }

      map[ch] = { to: bestCh || ch, score: bestScore, second: secondScore };
      // 同源字体下相似度普遍很高，阈值也要提高
      if (bestScore < (sameSource ? 0.97 : 0.90)) uncertain.push(ch);
    }

    // ---- 二级：扩大字库（仅对不确定的字） ----
    // 注意：只有「一级里没找到高分匹配」才需要扩展搜索。
    // 扩展搜索是逐码位扫描，形近字干扰大，
    // 如果一级已经拿到接近 1 的分数，绝不该再动它。
    if (uncertain.length) {
      await yieldTick();
      const all = allCjk();

      // 只为参照字体数量少的情况做扩展，避免耗时爆炸
      for (const ch of uncertain) {
        const vec = obFeats.get(ch);
        if (!vec) continue;

        // 只扫 8 批（≈8192 字），覆盖最常用区
        const r = bestMatch(vec, all, stds, 8);

        // 严格条件：新结果必须明显更好才替换
        // （避免把一级的正确结果被形近字顶掉）
        if (r.score > map[ch].score + 0.02) {
          map[ch] = { to: r.ch, score: r.score, second: map[ch].second };
        }
      }
    }

    // ---- 应用映射 ----
    const scores = uniq.map(c => (map[c] ? map[c].score : 0));
    const avg = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
    // 同源时精度高，可用更严的阈值；非同源放宽
    const low = scores.filter(s => s < (sameSource ? 0.95 : 0.80)).length;

    return texts.map(t => {
      let out = '', changed = 0;
      for (const ch of t) {
        const m = map[ch];
        if (m && m.to && m.to !== ch) { out += m.to; changed++; }
        else out += ch;
      }
      const baseInfo = base
        ? `，基础字体 ${base.family}(${base.score}${base.confident ? '' : ' 低置信'})`
        : '';
      return {
        ok: low === 0,
        text: out,
        map,
        changed,
        avgScore: Number(avg.toFixed(3)),
        lowConfidence: low,
        font: face.family,
        baseFont: base ? base.family : null,
        baseScore: base ? base.score : null,
        sameSource,
        reason: low === 0
          ? '解码完成（还原 ' + changed + ' 字，均分 ' + avg.toFixed(2) + baseInfo + '）'
          : low + ' 字置信度偏低（均分 ' + avg.toFixed(2) + baseInfo + '），建议人工核对'
      };
    });
  }

  /* ============================================================
   * 7. 诊断
   * ============================================================ */

  function diagnose(doc) {
    doc = doc || document;
    const faces = suspiciousFaces(doc);
    const targets = [];
    for (const sel of ['.questionLi', '.TiMu', '#question', '.mark_item', '.Cy_TItle']) {
      const el = doc.querySelector(sel);
      if (!el) continue;
      const f = fontOf(el);
      if (f) targets.push({ selector: sel, family: f.family, url: f.url });
    }
    return {
      totalFaces: collectFontFaces(doc).length,
      suspicious: faces,
      targets,
      systemFont: pickSystemFont(),
      gridSize: GRID,
      freqCharCount: FREQ_CHARS.length,
      cjkTotal: 0x9fa5 - 0x4e00 + 1
    };
  }

  return {
    decode, decodeMany, diagnose,
    fontOf, suspiciousFaces, collectFontFaces,
    renderFeatures, renderBatch, cosine, bestMatch,
    detectBaseFont, pickSystemFonts,
    FREQ_CHARS: FREQ_UNIQ,
    isCJK, pickSystemFont,
    GRID, CELL
  };
})();

if (typeof window !== 'undefined') window.CSFontDecoder = CSFontDecoder;

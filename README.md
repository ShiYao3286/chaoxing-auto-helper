# 学习通自动学习助手

> 超星学习通章节自动学习 + 测验自动作答。**两种装法，同一份内核**：
> ① Edge/Chrome 扩展（Manifest V3）② 油猴用户脚本（单文件）。
> 刷课全自动，答题走你自己的 API；文字解不出来时自动改用截图解题。

![Manifest](https://img.shields.io/badge/manifest-v3-blue)
![Chrome](https://img.shields.io/badge/Chrome-102%2B-green)
![Edge](https://img.shields.io/badge/Edge-102%2B-green)
![Userscript](https://img.shields.io/badge/userscript-Tampermonkey-orange)
![License](https://img.shields.io/badge/license-MIT-lightgrey)
[![Release](https://img.shields.io/github/v/release/ShiYao3286/chaoxing-auto-helper)](https://github.com/ShiYao3286/chaoxing-auto-helper/releases/latest)

**[⬇ 下载最新版](https://github.com/ShiYao3286/chaoxing-auto-helper/releases/latest)**

---

## 两种形态怎么选

| | **扩展版** | **脚本版** |
|---|---|---|
| 装法 | 解压 + 「加载解压缩的扩展」 | 装 Tampermonkey + 安装 `.user.js` |
| 入口 | 工具栏图标 → 设置页 | 油猴菜单 → 页内弹窗 |
| 任务队列 / 任务点判定 | ✅ | ✅ |
| 视频 / 文档 / 自动下一节 | ✅ | ✅ |
| 抓题 / 字体解码 / 作答 / 填写 | ✅ | ✅ |
| 提交安全网（暂存而非硬交） | ✅ | ✅ |
| 视频弹题 | ✅ | ✅ |
| **真实截图** | ✅ | ❌ 降级为文字重绘 |
| **跨标签页保持运行** | ✅ | ❌ 只在本页 |
| 配置存储 | `chrome.storage` | `GM_setValue`（互不相通） |

> **一句话**：想全功能用扩展版；浏览器不让装扩展、或只想装一次就用脚本版。

详细差异与脚本版安装见 **[docs/脚本版说明.md](docs/脚本版说明.md)**。

---

## 功能

### 刷课

- **任务队列驱动** —— 先清点本节全部任务点（视频/音频/PDF/测验/作业包/文档），再按顺序逐项做
- 视频自动播放：倍速、静音、防切屏暂停
- 持续纠正被播放器偷偷改回的倍速；平台锁 1x 就老实接受 1x
- 文档 / PPT 拟人化滚动（1.5 秒一屏，不一次到底）
- **任务点真的完成才翻页** —— 读平台标记（`aria-label` 优先），不靠瞎猜
- **自动切到承载任务点的标签** —— 只切到真有任务点的那一个，不瞎逛
- 每日限流自动识别并停止，不白刷
- 整门课学完自动停（`#prevNextFocusNext` 被平台隐藏即判定完成）
- 四层 iframe 嵌套自动穿透，各 frame 协同不抢跑
- 课程树智能跳转，已完成的章节直接跳过

### 答题

- 自动抓取章节测验题目（单选 / 多选 / 判断 / 填空）
- **自动破解字体反爬** —— 学习通把题干换成生僻字码位，靠自定义字体渲染回真字，直接抓 DOM 拿到的是乱码
- 调用你自己配置的 API 作答（OpenAI 兼容，或完全自定义请求体）
- 自动填写答案，默认**不自动提交**
- **提交安全网** —— 每道题核对通过才允许自动提交；有题没把握就**暂存**并提示你自查，绝不硬交


### 截图兜底

- 文字解不可靠时，自动改用视觉模型看截图
- 脚本和模型**双向判断**是否该截图
- 视觉模型标注"不确定"时，即使开了自动提交也**跳过提交**

### API 工具

- 一键拉取模型列表（自动推导 `/models` 端点）
- 连通性测试（验证地址 / Key / 模型）
- 分别验证文本接口和视觉接口
- 6 种错误场景都有明确中文提示

---

## 快速开始

### 1. 安装扩展

**推荐：直接下载发布包**

去 [Releases](https://github.com/ShiYao3286/chaoxing-auto-helper/releases/latest) 下载 `chaoxing-auto-helper.zip`，然后：

```text
1. 解压到任意目录（解压后第一层应能看到 manifest.json）
2. Edge 地址栏输入 edge://extensions/
3. 打开左下角「开发人员模式」
4. 点「加载解压缩的扩展」
5. 选择 解压出来的那个目录
6. 刷新已打开的学习通页面
```

> ⚠️ **选目录时最容易出错**：要选到**直接包含 `manifest.json`** 的那一层。
> 如果你解压后得到 `chaoxing-auto-helper/extension/`，就进到 `extension` 里再选。

**从源码安装**（想改代码的话）

```text
1. git clone https://github.com/ShiYao3286/chaoxing-auto-helper.git
2. edge://extensions/ → 开发人员模式
3. 加载解压缩的扩展 → 选仓库里的 extension/ 目录
```

### 2. 配置 API

点工具栏图标 → 设置，填三项：

| 字段 | 示例 |
|---|---|
| 接口地址 | `https://api.deepseek.com/v1/chat/completions` |
| API Key | `sk-xxxxxxxx` |
| 模型 | 点「拉取模型」从列表选，或手填 |

然后点 **「测试连通」**，显示 `✅ 连通正常` 即可。

**支持的服务**（OpenAI 兼容的都行）：

```text
OpenAI        https://api.openai.com/v1/chat/completions
DeepSeek      https://api.deepseek.com/v1/chat/completions
通义千问      https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
本地 Ollama   http://127.0.0.1:11434/v1/chat/completions
各类中转站    https://你的域名/v1/chat/completions
```

### 3. 开始使用

打开学习通章节页（URL 含 `/mycourse/studentstudy`），右下角出现面板，设置好后点「开始」。

---

## 用脚本版（油猴）

适合「不想装扩展」或「浏览器不让装扩展」的情况。

### 1. 装 Tampermonkey

Edge 加载项商店搜 `Tampermonkey` 装上（Chrome 用 Chrome 应用商店）。

### 2. 装脚本

去 [Releases](https://github.com/ShiYao3286/chaoxing-auto-helper/releases/latest) 下载
`学习通自动学习助手.user.js`，Tampermonkey 会自动弹出安装页 → 点「安装」。

或者把 `.user.js` 直接拖进浏览器窗口。

### 3. 允许跨域（**必做**）

首次调答题 API 时 Tampermonkey 会问：

```text
要访问 api.deepseek.com 吗？  [ 拒绝 ]  [ 总是允许 ]
```

**必须点「总是允许」**，否则请求发不出去。
（原因：页面 `fetch` 被 CORS 拦，脚本走 `GM_xmlhttpRequest`，需要用户授权域名。）

### 4. 配置

点 Tampermonkey 图标 → 「学习通自动学习助手」→ **「⚙ 设置」**，
在页内弹窗里填接口地址 / Key / 模型，点「测试连通」→「保存」。

> 脚本版没有真实截图，视觉解题会自动降级为「文字重绘」，精度低于扩展版。

完整说明（含能力差异表、FAQ）见 **[docs/脚本版说明.md](docs/脚本版说明.md)**。

---

## 截图解题怎么配

如果字体反爬没完全解开（诊断里看到乱码），用截图兜底：

```text
设置 → 截图解题
  ✓ 启用
  触发时机：自动判断
  ✓ 复用答题 API
  视觉模型：gpt-4o / qwen-vl-max / glm-4v-plus 等
```

点 **「测试视觉接口」** 验证。纯文本模型（如 `deepseek-chat`）会在这里报错，这是提前发现问题。

> ⚠️ **脚本版没有真实截图能力**（拿不到 `captureVisibleTab`），会自动降级成「把题干文字画成图片」。
> 如果题干本身已被字体反爬混淆成假字，画出来仍是假字 —— 这种情况请用扩展版。

触发逻辑：

```text
文本可信 ──────────→ 文本 API ──→ 填写
   └─ 不可靠 ──→ 截图 ──→ 视觉模型 ──→ 填写
文本 API 失败 ────→ 自动改试截图
模型漏答 ──────→ 补一次截图（只补缺的，不覆盖已有）
```

**脚本侧判据**：字体解码置信度低、题干仍有混淆字符、生僻字比例异常、选项不足、模型漏答
**模型侧判据**：每题自评 `confidence < 0.6`，或自标 `uncertain`

---

## 目录结构

```text
学习通自动学习助手/
├── extension/                 扩展本体（加载这个目录）
│   ├── manifest.json
│   ├── icons/
│   └── src/
│       ├── core/              内核（零 chrome API，两形态共用）
│       │   ├── namespace.js   CSCore 命名空间
│       │   ├── config.js      默认配置 / mergeDefaults
│       │   ├── prompt.js      内置提示词
│       │   └── api.js         答题 / 模型列表 / 连通测试 / 视觉（走注入的传输层）
│       ├── host/              宿主适配层
│       │   ├── host-extension.js  chrome.* 实现
│       │   └── host-userscript.js GM_* + BroadcastChannel 实现
│       ├── ui/                界面（两形态共用）
│       │   ├── theme.js       设计令牌
│       │   ├── panel.js       悬浮面板
│       │   └── settings.js    设置弹窗（脚本版用）
│       ├── content/           刷课/答题逻辑（两形态共用）
│       │   ├── fontdecoder.js 字体反爬解码器
│       │   └── inject.js      任务队列 + 刷课 + 任务点检测 + 抓题 + 填写 + 提交安全网
│       ├── background.js      Service Worker：消息路由、截图裁剪、字体代理、frame 汇总
│       ├── options/           设置页（扩展专有）
│       └── popup/             工具栏弹窗
├── userscript/
│   └── 学习通自动学习助手.user.js   ← 构建产物（油猴脚本，不要手改）
├── build/
│   └── build-userscript.cjs   拼接内核 + 5 项校验
├── tests/                     测试套件
│   ├── *.test.cjs             单元测试
│   ├── test-*.cjs             浏览器集成测试
│   ├── lib/inject-content.cjs 统一注入内容脚本
│   ├── static-server.cjs      极简静态服务器（替代 http-server）
│   ├── probe-*.cjs            页面元素采集工具（调样式用）
│   ├── mock-api.cjs           模拟 OpenAI 服务
│   └── *.html                 模拟学习通页面
├── docs/                      技术文档
│   ├── 改造计划.md            v1.2.0 / v1.3.0 完整设计与实测记录
│   ├── 技术原理.md            架构、刷课、任务队列、字体反爬、提交安全网、宿主抽象、UI 令牌
│   ├── 脚本化改造计划.md      一份内核 → 两种形态的改造方案与完成情况
│   ├── 脚本版说明.md          油猴脚本安装 / 授权 / 能力差异 / FAQ
│   ├── 搜题酱架构剖析.md      搜题酱 v1.17.5 刷课实现逆向分析 + 取舍对照
│   ├── 对话纪要.md            需求演进、关键决策、踩坑与版本历史
│   ├── API格式.md
│   ├── 常见问题.md
│   ├── 上传GitHub.md
│   └── 发布流程.md
├── scripts/                   辅助脚本
│   ├── 启动测试浏览器.cmd
│   └── 跑全部测试.cmd
├── .github/workflows/         自动打包发布（扩展 zip + 油猴 .user.js）
├── .gitignore
├── LICENSE
└── README.md
```

---

## 技术原理简述

学习通把题干文字做了**字体混淆**：

1. DOM 里放生僻字码位（如「忞忖忟命」）
2. 用 `@font-face` 加载自定义字体
3. 这些码位在该字体下渲染成正常汉字

所以 `element.innerText` 拿到的是错字，拿去答题必然错。

**破解思路**：下载字体 → 渲染成位图 → 和系统字体比对找最像的字。

**关键洞察**（实测数据）：

| 场景 | 余弦相似度 |
|---|---|
| 同一字体渲染同一个字 | **1.0000** |
| 跨字体渲染同一个字 | 0.44 |
| 形近字之间（要/耍、垄/重） | 0.90+ |

跨字体差异 **远大于** 形近字差异。所以随便挑个系统字体当参照，形近字必然混淆。

**解决办法**：先用一批绝不会被混淆的常用字（的一是在不了有和…）判断这个反爬字体**派生自哪个系统字体**，再用那个字体做参照。这样识别率接近 100%。

### 刷课怎么判断"学完了"

不是靠猜，是读平台自己的标记（四级校验）：

| 层级 | 依据 | 可靠性 |
|------|------|--------|
| ① | `#_studystate`（学习通自己的状态） | 最高 |
| ② | 课程树节点 `.icon_Completed` / `.jobUnfinishCount` | 高 |
| ③ | `#jobhint`（本节待完成计数） | 中 |
| ④ | 视频任务点 `aria-label="任务点已完成"` | 高 |

⚠️ **不能用视频进度判断**。学习通有每日限流，达到上限后即使只播了 18% 也会标成完成。脚本检测到限流会主动停止，避免白刷。

### 为什么要自动切标签

学习通一个章节常有多个标签：

```
1学习要点    ← 纯文字说明，不是任务点
2微课学习    ← 真正的视频/文档在这里
```

停在「学习要点」上滚，任务点永远做不完。所以扩展会自动切到承载任务点的标签，做完再翻页。

### 任务队列（v1.3.0）

v1.2.0 是「看图标 → 判断 → 行动」，v1.3.0 改成「先清点 → 排队 → 逐项做」。

学习通的任务点 iframe 地址里带模块名，任务类型直接能读出来：

```text
/ananas/modules/video  → 视频
/ananas/modules/audio  → 音频
/ananas/modules/pdf    → PDF
/ananas/modules/work   → 章节测验
/ananas/modules/zt/topicAttachment → 作业包
```

所以脚本会把本章**所有**任务点扫成一张清单，按 DOM 顺序逐项做，做完才允许翻页。
不支持的类型（讨论/直播）标记跳过，不阻塞。

这套结构参考了大学搜题酱的刷课实现（它有任务目录 + 队列 + 提交安全网），
但解题仍然走**你自己的 API**，不向任何第三方上传题目。

### 提交安全网（v1.3.0）

开了自动提交也不会乱交：

| 情况 | 动作 |
|---|---|
| 每题填好且核对通过 | 提交，显示得分 |
| 有题没把握（题型不支持 / 平台没认） | **暂存**答案 + 提示你自查，不提交 |
| 弹窗提示「还有未做完」 | 点取消，不硬交 |
| 弹窗提示「未达到及格线」 | 点取消，不硬交 |

「核对通过」是读平台的隐藏域 `#answer<qid>` —— 平台认了才算填进去，不是看自己以为点了。

详见 [docs/技术原理.md](docs/技术原理.md)、[docs/改造计划.md](docs/改造计划.md)
和 [docs/搜题酱架构剖析.md](docs/搜题酱架构剖析.md)。

---

## 测试

```bash
# 单元测试（纯 Node，不需要浏览器）
node tests/core.test.cjs            # 内核
node tests/fontdecoder.test.cjs     # 字体解码
node tests/test-build.cjs           # 油猴产物校验
node tests/test-options-theme.cjs   # 设置页结构

# 浏览器集成测试（需要先启动测试浏览器 + 静态服务 + mock API）
node tests/test-v13.cjs             # 任务队列 / 提交安全网
node tests/test-panel-queue.cjs     # 面板队列行
node tests/test-settings-ui.cjs     # 脚本设置弹窗
node tests/test-userscript.cjs      # 油猴产物功能
node tests/test-userscript-bus.cjs  # 跨帧总线
node tests/test-api-features.cjs
node tests/test-vision.cjs
node tests/test-screenshot.cjs
node tests/test-videoquiz.cjs
node tests/test-kernel-health.cjs
```

完整说明见 [tests/README.md](tests/README.md)。

当前状态（**17 组全过**）：

| 测试 | 结果 |
|---|---|
| 内核单元（config/prompt/api/传输层） | 57/57 |
| 油猴产物校验（头部/权限/版本/无 chrome 残留/语法） | 30/30 |
| 油猴产物功能（Host/配置/面板/队列/答题/截图降级） | 38/38 |
| 跨帧总线（真实双 iframe） | 16/16 |
| 脚本设置弹窗（22 字段/保存/取消/Esc/菜单） | 42/42 |
| 设置页结构（55 个 id 全保留） | 11/11 |
| 字体解码单元 | 33/33 |
| 字体解码实机 | 5/5（均分 1.0） |
| 任务队列 / 提交安全网 | 34/34 |
| 面板队列行渲染 | 9/9 |
| 视频弹题 | 19/19 |
| 倍速放弃 | 15/15 |
| 视频修复 | 12/12 |
| 地址规整 | 10/10 |
| API 功能 | 22/22 |
| 截图解题协同 | 17/17 |
| 真实截图裁剪 | 11/11 |
| **合计** | **381 项全过** |

> 两种形态各跑一遍：扩展侧 `test-kernel-health` 验 Service Worker + importScripts；
> 脚本侧 `test-userscript` 验产物注入。`test-build` 里有一条硬规矩 ——
> 除宿主文件外任何源码出现 `chrome.*` 就构建失败，防止未来有人图方便破坏可移植性。

---

## 环境要求

- Edge 102+ 或 Chrome 102+
- Node.js 18+（仅测试需要）

---

## 免责声明

本项目仅供**技术学习与研究**，用于理解浏览器扩展开发、字体反爬机制、以及 LLM 接口集成。

学习通有反作弊机制，页面自身会提示：

> 严惩学生刷课等作弊行为…直接提交教务处处理

使用本项目产生的任何后果由使用者自行承担。**请勿用于违反学校规定的场景。**

扩展只在你本地运行，不收集、不上传任何数据。API Key 存在浏览器本地 `chrome.storage.local`。

---

## License

[MIT](LICENSE)

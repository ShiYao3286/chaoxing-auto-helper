# 学习通自动学习助手

> 超星学习通章节自动学习 + 测验自动作答的 Edge/Chrome 扩展（Manifest V3）。
> 刷课全自动，答题走你自己的 API；文字解不出来时自动改用截图解题。

![Manifest](https://img.shields.io/badge/manifest-v3-blue)
![Chrome](https://img.shields.io/badge/Chrome-102%2B-green)
![Edge](https://img.shields.io/badge/Edge-102%2B-green)
![License](https://img.shields.io/badge/license-MIT-lightgrey)
[![Release](https://img.shields.io/github/v/release/ShiYao3286/chaoxing-auto-helper)](https://github.com/ShiYao3286/chaoxing-auto-helper/releases/latest)

**[⬇ 下载最新版](https://github.com/ShiYao3286/chaoxing-auto-helper/releases/latest)** · 解压后用「加载解压缩的扩展」装

---

## 功能

### 刷课

- 视频自动播放：倍速、静音、防切屏暂停
- 持续纠正被播放器偷偷改回的倍速
- 文档 / PPT 自动滚动到底
- 任务点完成后自动切换下一节
- 四层 iframe 嵌套自动穿透，各 frame 协同不抢跑

### 答题

- 自动抓取章节测验题目（单选 / 多选 / 判断 / 填空）
- **自动破解字体反爬** —— 学习通把题干换成生僻字码位，靠自定义字体渲染回真字，直接抓 DOM 拿到的是乱码
- 调用你自己配置的 API 作答（OpenAI 兼容，或完全自定义请求体）
- 自动填写答案，默认**不自动提交**

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
│       ├── background.js      Service Worker：配置、API 代理、截图裁剪
│       ├── content/
│       │   ├── fontdecoder.js 字体反爬解码器
│       │   └── inject.js      刷课 + 抓题 + 可信度评估 + 填写
│       ├── options/           设置页
│       └── popup/             工具栏弹窗
├── tests/                     测试套件
│   ├── *.test.cjs
│   ├── *.cjs                  浏览器集成测试
│   ├── mock-api.cjs           模拟 OpenAI 服务
│   └── *.html                 模拟学习通页面
├── docs/                      技术文档
│   ├── 技术原理.md
│   ├── API格式.md
│   └── 常见问题.md
├── scripts/                   辅助脚本
│   ├── 安装浏览器.cmd
│   └── 跑全部测试.cmd
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

详见 [docs/技术原理.md](docs/技术原理.md)。

---

## 测试

```bash
# 单元测试（纯 Node，不需要浏览器）
node tests/fontdecoder.test.cjs

# 浏览器集成测试（需要先启动 Edge 和 mock 服务）
node tests/test-api-features.cjs
node tests/test-vision.cjs
node tests/test-screenshot.cjs
node tests/cdp-test.cjs
```

完整说明见 [tests/README.md](tests/README.md)。

当前状态：

| 测试 | 结果 |
|---|---|
| 语法 + manifest 引用 | 全部通过 |
| 字体解码单元 | 33/33 |
| 字体解码实机 | 5/5（均分 1.0） |
| API 功能 | 22/22 |
| 截图解题协同 | 17/17 |
| 真实截图裁剪 | 11/11 |

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

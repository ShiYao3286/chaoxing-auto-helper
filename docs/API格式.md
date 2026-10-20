# API 格式说明

扩展需要你的 API 按约定格式收发数据。本文给出完整规范，自建服务或对接中转站时参考。

---

## 一、答题接口（文本）

### 请求

扩展 POST 到你在设置里填的地址，默认是 OpenAI 兼容格式：

```http
POST https://api.example.com/v1/chat/completions
Content-Type: application/json
Authorization: Bearer sk-xxxx

{
  "model": "gpt-4o-mini",
  "temperature": 0.2,
  "messages": [
    { "role": "system", "content": "<内置提示词>" },
    { "role": "user",   "content": "<题目 JSON 字符串>" }
  ]
}
```

其中 `user` 消息的内容是一段 JSON 字符串：

```json
{
  "questions": [
    {
      "num": 1,
      "type": "single",
      "text": "中国革命的首要问题是？",
      "options": ["A 农民问题", "B 分清敌友", "C 土地问题", "D 领导权问题"]
    },
    {
      "num": 2,
      "type": "multi",
      "text": "中国新民主主义革命的对象有哪些？",
      "options": ["A 帝国主义", "B 封建主义", "C 官僚资本主义", "D 民族资本主义"]
    },
    {
      "num": 3,
      "type": "judge",
      "text": "封建主义是近代中国贫困落后和一切灾祸的总根源",
      "options": ["A 对", "B 错"]
    },
    {
      "num": 4,
      "type": "fill",
      "text": "（）是中国新民主主义革命的首要对象",
      "options": []
    }
  ]
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `num` | number | 题号，从 1 开始 |
| `type` | string | `single` / `multi` / `judge` / `fill` |
| `text` | string | 题干（已破解字体反爬，是真实文字） |
| `options` | string[] | 选项数组，格式为「字母 + 空格 + 内容」 |

### 期望响应

**标准 OpenAI 结构**：

```json
{
  "choices": [
    {
      "message": {
        "content": "{\"answers\":[{\"num\":1,\"type\":\"single\",\"answer\":[\"B\"]}]}"
      }
    }
  ]
}
```

`content` 里必须是这段 JSON：

```json
{
  "answers": [
    { "num": 1, "type": "single", "answer": ["B"] },
    { "num": 2, "type": "multi",  "answer": ["A", "B", "C"] },
    { "num": 3, "type": "judge",  "answer": ["错"] },
    { "num": 4, "type": "fill",   "answer": ["帝国主义"] }
  ]
}
```

### 答案格式

| 题型 | `answer` 格式 | 示例 |
|---|---|---|
| 单选 | 单元素数组，一个大写字母 | `["B"]` |
| 多选 | 多元素数组，按字母序 | `["A","B","C"]` |
| 判断 | 单元素数组，`对` 或 `错` | `["错"]` |
| 填空 | 按空顺序的文本数组 | `["帝国主义"]` |

> 判断题也接受 `正确`/`错误`、`true`/`false`、`A`/`B`、`√`/`×`，扩展会自动归一化。

---

## 二、视觉接口（截图解题）

### 请求

默认复用答题接口的地址和 Key，只把模型换成视觉模型：

```http
POST https://api.example.com/v1/chat/completions
Content-Type: application/json
Authorization: Bearer sk-xxxx

{
  "model": "gpt-4o",
  "temperature": 0.1,
  "max_tokens": 2000,
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "<视觉提示词>" },
        {
          "type": "image_url",
          "image_url": { "url": "data:image/png;base64,iVBORw0KGgo..." }
        }
      ]
    }
  ]
}
```

多张截图时 `content` 里会有多个 `image_url` 对象。

### 期望响应

在标准答案结构基础上，**每题多一个 `confidence`**：

```json
{
  "answers": [
    { "num": 1, "type": "single", "answer": ["B"], "confidence": 1.0 },
    { "num": 2, "type": "multi",  "answer": ["A","B","C"], "confidence": 0.95 },
    { "num": 3, "type": "judge",  "answer": ["错"], "confidence": 0.9 }
  ],
  "uncertain": false,
  "note": ""
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `confidence` | number | 0~1，该题把握程度 |
| `uncertain` | boolean | 整体是否不确定 |
| `note` | string | 不确定时的原因说明 |

**触发"跳过自动提交"的条件**：
- 任意一题 `confidence < 0.6`，或
- `uncertain === true`

---

## 三、自定义模式

如果接口不是 OpenAI 风格，切到「自定义」，填三项。

### 3.1 请求体模板

一段 JSON 文本，支持占位符：

| 占位符 | 替换为 |
|---|---|
| `{{prompt}}` | 系统提示词（**已带引号**，可直接放 JSON 里） |
| `{{text}}` | 题目 JSON（已带引号） |
| `{{full}}` | 两者拼接（已带引号） |
| `{{model}}` | 模型名（未加引号） |
| `{{apiKey}}` | API Key（未加引号） |

示例：

```json
{
  "model": {{model}},
  "prompt": {{prompt}},
  "input": {{text}},
  "stream": false
}
```

> 注意 `{{prompt}}` 和 `{{text}}` 会替换成**带引号的 JSON 字符串字面量**，所以模板里不要自己再加引号。

### 3.2 额外请求头

JSON 对象，会合并进请求头：

```json
{
  "X-Api-Key": "your-key",
  "X-Custom-Header": "value"
}
```

如果这里指定了 `Authorization`，扩展就用你的；否则自动加 `Bearer <apiKey>`。

### 3.3 响应取值路径

点号路径，从响应 JSON 里取出答案内容：

```
data.answer
result.content
output.text
choices.0.message.content
```

留空则自动尝试 OpenAI 标准位置。

---

## 四、模型列表接口

### 请求

```http
GET https://api.example.com/v1/models
Authorization: Bearer sk-xxxx
```

地址从答题接口自动推导：

```
https://x/v1/chat/completions  →  https://x/v1/models
https://x/api/completions      →  https://x/api/models
https://x/v1/models            →  原样
```

路径不标准时，在设置页「模型列表地址」里单独指定。

### 期望响应

任一结构都可以：

```json
{ "data": [ { "id": "gpt-4o-mini" }, { "id": "gpt-4o" } ] }
```

```json
{ "models": [ { "name": "gpt-4o-mini" } ] }
```

```json
[ "gpt-4o-mini", "gpt-4o" ]
```

扩展会提取 `id` / `name` / `model` / `model_name` 字段并去重排序。

---

## 五、内置提示词

不填「自定义提示词」时使用这段：

```text
你是思政课教师，正在完成《毛泽东思想和中国特色社会主义理论体系概论》的章节测验。

给定题目（JSON），请逐题作答。要求：
1. 严格依据马克思主义理论/毛泽东思想的学术共识，不要臆造。
2. 单选题返回一个字母；多选题返回全部正确字母（按字母顺序）；
   判断题返回 "对" 或 "错"；填空题按空顺序返回原文。
3. 只输出 JSON，不要解释、不要 markdown 围栏。
```

视觉提示词额外强调：

```text
对每道题给出 confidence（0~1）：
- 1.0  = 题干清晰、确定答案
- 0.7  = 大致确定，但有干扰项
- 0.4  = 题干模糊、被遮挡、或文字识别不清
- 0.1  = 完全看不清，只能猜

只要有一题 confidence < 0.6，或截图里有看不清/被截断的内容，
把 uncertain 设为 true 并说明原因（放在 note 里）。
```

---

## 六、解析容错

扩展对模型返回做了多层容错，以下情况都能正确处理：

| 情况 | 处理 |
|---|---|
| 返回带 ```` ```json ```` 围栏 | 剥掉围栏 |
| JSON 前后有解释文字 | 截取第一个 `{` 到最后一个 `}` |
| 直接返回数组而非对象 | 当作答案数组 |
| 包在 `data.answers` 里 | 自动提取 |
| 判断题写「正确/错误」 | 归一化成「对/错」 |
| 判断题写 `true/false` | 归一化成「对/错」 |
| 答案不是数组而是字符串 | 包成数组 |

以下情况会明确报错（不会静默失败）：

- HTTP 非 2xx（显示状态码和响应片段）
- 响应不是 JSON
- 拿不到 `content` 字段
- `content` 里解析不出 JSON
- 模型返回了 `answers` 但内容为空

---

## 七、错误码对照

| 现象 | 常见原因 |
|---|---|
| `HTTP 401` | API Key 错误或未传 |
| `HTTP 404` | 地址错误，多半是少了 `/chat/completions` |
| `HTTP 429` | 触发限流 |
| `HTTP 500/502/503` | 服务端问题 |
| `请求超时` | 服务不可达，或模型响应太慢 |
| `无法从响应中解析 JSON` | 模型没按格式返回，换模型或加强提示词 |
| `model does not support image` | 用纯文本模型跑了视觉请求 |

---

## 八、自建服务示例

最小可用的 Node 服务：

```js
const http = require('http');

http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const { messages } = JSON.parse(body);
    // 在这里接你自己的模型
    const answer = { answers: [{ num: 1, type: 'single', answer: ['B'] }] };

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      model: 'my-model',
      choices: [{
        message: { role: 'assistant', content: JSON.stringify(answer) }
      }]
    }));
  });
}).listen(3000);
```

设置里填 `http://127.0.0.1:3000/v1/chat/completions` 即可。

> 记得 host_permissions 已包含 `<all_urls>`，本地地址也能访问。

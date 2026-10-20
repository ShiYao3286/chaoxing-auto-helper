# 测试套件

全部基于**真实浏览器**（CDP 驱动）+ **本地 mock API**，不是模拟测试。

---

## 测试文件

| 文件 | 作用 | 项数 | 需要环境 |
|---|---|---|---|
| `fontdecoder.test.cjs` | 字体解码器单元测试 | 33 | 仅 Node |
| `cdp-test.cjs` | 字体解码实机准确率 | 5 段文本 | 浏览器 + HTTP |
| `test-api-features.cjs` | 模型拉取 / 连通测试 / 错误场景 | 22 | 浏览器 + mock |
| `test-vision.cjs` | 截图解题 + 协同判断 | 17 | 浏览器 + 服务 |
| `test-screenshot.cjs` | 真实截图 + 裁剪 | 11 | 浏览器 + 服务 |
| `mock-api.cjs` | 模拟 OpenAI 兼容服务 | — | 无 |
| `fake-quiz.html` | 模拟学习通测验页 | — | HTTP |
| `font-test.html` | 字体反爬测试页 | — | HTTP |

---

## 最省事的跑法

```text
1. 双击 scripts/启动测试浏览器.cmd
2. 等浏览器起来
3. 双击 scripts/跑全部测试.cmd
```

脚本会自动处理 mock 服务、HTTP 服务、端口占用。

---

## 手动跑法

### 准备环境

**① 启动带扩展的浏览器**

```batch
cd /d <仓库路径>
set EXT_DIR=%CD%\extension

start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --remote-debugging-port=9335 ^
  --user-data-dir=%TEMP%\csworker_test ^
  --load-extension="%EXT_DIR%" ^
  --disable-extensions-except="%EXT_DIR%" ^
  --no-first-run --no-default-browser-check about:blank
```

> `--disable-extensions-except` 不能省，否则可能加载不上。

**② 启动 mock API**

```bash
node tests/mock-api.cjs 9911
```

**③ 启动页面服务**

```bash
npx http-server tests -p 8792 --cors -c-1
```

### 跑测试

```bash
# 1. 单元测试（不需要浏览器）
node tests/fontdecoder.test.cjs

# 2. API 功能
node tests/test-api-features.cjs

# 3. 截图解题
node tests/test-vision.cjs

# 4. 真实截图
node tests/test-screenshot.cjs

# 5. 字体解码实机（需要先放字体文件，见下）
node tests/cdp-test.cjs
```

全部测试都**不需要传参数** —— 脚本会自动定位扩展目录和测试页。

---

## 预期结果

| 测试 | 通过数 |
|---|---|
| 语法 + manifest | 6/6 |
| 字体解码单元 | 33/33 |
| 字体解码实机 | 5/5（均分 1.0） |
| API 功能 | 22/22 |
| 截图解题协同 | 17/17 |
| 真实截图裁剪 | 11/11 |

---

## 各测试覆盖什么

### fontdecoder.test.cjs（33 项）

纯 Node 环境，用 canvas 桩模拟渲染。

- 模块导出完整性
- 特征向量维度（784 = 28×28）
- **位置无关性** —— 同一字符画在不同位置，特征必须一致
- 余弦相似度数学正确性
- CJK 字符判定边界
- 字库完整性（关键常用字一个都不能漏）
- 不误伤：非反爬页面原样返回

### test-api-features.cjs（22 项）

在真实浏览器里操作设置页。

- 模型地址推导（5 种 URL 形态）
- 模型拉取成功 / 404 / 空列表 / 非 JSON
- 连通测试成功 / 无效 Key
- 视觉接口成功 / 模型不支持图片
- 配置持久化、模型列表缓存

### test-vision.cjs（17 项）

验证"脚本 + 模型双向判断"。

| 场景 | 预期 |
|---|---|
| auto + 文本可信 | 走文本，**不**调视觉 |
| always | 走视觉，跳过文本 |
| off | 走文本，**不**调视觉 |
| 文本含乱码 | 自动转视觉 |
| 文本 API 失败 | 自动转视觉 |
| 视觉标注不确定 | **跳过自动提交** |
| 点停止 | 保留"待复核"提示 |

### test-screenshot.cjs（11 项）

- `captureVisibleTab` 真实截屏
- OffscreenCanvas 裁剪
- 裁剪超范围时自动收缩
- 截图不可用时的文字重绘降级

### cdp-test.cjs（5 段文本）

用真实教材文本验证解码准确率，逐字比对。

需要字体文件：

```bash
copy C:\Windows\Fonts\simhei.ttf tests\simhei-lite.ttf
npx http-server tests -p 8791 --cors -c-1
node tests/cdp-test.cjs
```

---

## 切换 mock 的错误场景

```bash
curl -X POST http://127.0.0.1:9911/__mode ^
  -H "Content-Type: application/json" ^
  -d "{\"models\":\"404\",\"chat\":\"ok\",\"vision\":\"ok\"}"
```

可取值：

| 字段 | 可选值 |
|---|---|
| `models` | `ok` `empty` `404` `notjson` `noarray` |
| `chat` | `ok` `401` `500` `notjson` |
| `vision` | `ok` `reject` `notjson` |

---

## 踩过的坑（排查参考）

**1. MV3 Service Worker 会休眠**

MV3 的 background 空闲约 30 秒就停。测试脚本会自动唤醒（打开设置页触发）。如果报"扩展未加载"，说明唤醒失败 —— 检查浏览器启动参数。

**2. `captureVisibleTab` 第一个参数是 windowId**

不是 tabId。传错会报 `No window with id: xxx`。测试里专门验证了这点。

**3. Service Worker 里 `fetch(dataURL)` 不可靠**

会报 `Failed to fetch`。必须手动 base64 解码成 `Uint8Array` 再建 Blob。

**4. 权限不足**

`captureVisibleTab` 需要 `<all_urls>` 或 `activeTab`。manifest 里已包含 `<all_urls>`。

**5. 裁剪尺寸不等于请求值**

请求区域超出可视高度时，裁剪会自动收缩 —— **这是正确行为**。测试只断言"宽度正确 + 高度 ≤ 请求值"。

**6. headless 模式的限制**

`--headless=new` 对扩展支持有限但够用。某些版本下真实截图可能返回黑图，此时会走文字重绘降级路径，功能仍然验证通过。

**7. 端口冲突**

默认端口：`9335`（CDP）、`9911`（mock）、`8791`/`8792`（HTTP）。
被占用就改各脚本顶部的常量。

---

## 清理

```text
- 关闭测试浏览器窗口
- 任务管理器结束残留的 node.exe（mock / http-server）
- 删除 %TEMP%\csworker_test 目录
- 删除 tests\simhei-lite.ttf（大文件，已在 .gitignore）
```

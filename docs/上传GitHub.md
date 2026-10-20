# 上传 GitHub 步骤

三种方式任选，**推荐方式二**（GitHub Desktop，不用敲命令）。

项目目录：`E:\ai处理文件\学习通刷课脚本\学习通自动学习助手`

---

## 上传前检查

```text
✅ 已确认目录里没有 API Key
✅ 已确认没有测试产物（shot-*.png / simhei-lite.ttf）
✅ .gitignore / .gitattributes / LICENSE 已就位
```

**特别提醒**：扩展的配置存在浏览器的 `chrome.storage.local` 里，**不在项目文件中**。所以仓库里不会有你的 Key。但如果你在别处存过测试用的 key，务必别带进来。

---

## 方式一：网页上传（最简单，但没法改）

适合只想放上去、不打算持续改的情况。

1. GitHub 右上角 **+** → **New repository**
2. 仓库名填 `chaoxing-auto-helper` 或 `学习通自动学习助手`
3. 选 **Public**，**不要**勾选任何初始化选项（README / .gitignore / LICENSE 都别勾）
4. 点 **Create repository**
5. 页面出现后点 **uploading an existing file**
6. 把 `学习通自动学习助手` 目录里的**所有内容**拖进去
   - 注意：拖的是**目录里的内容**，不是目录本身
   - 浏览器支持拖文件夹，子目录结构会保留
7. 填提交信息，点 **Commit changes**

> 缺点：以后改代码还得网页操作，很麻烦。文件多的时候网页上传也容易失败。

---

## 方式二：GitHub Desktop（推荐）

图形界面，适合持续维护。

### 1. 装软件

下载安装 [GitHub Desktop](https://desktop.github.com/)。

### 2. 创建仓库

```text
File → New repository...
```

- **Name**：`chaoxing-auto-helper`
- **Local path**：选一个空目录的上级，比如 `E:\ai处理文件\github`
- **不勾** Initialize with README（我们已经有 README 了）
- **不勾** Git ignore / License（文件已就位）
- 点 **Create repository**

### 3. 把项目文件拷进去

打开刚才创建的目录（`E:\ai处理文件\github\chaoxing-auto-helper`），把 `学习通自动学习助手` 里的**所有文件**复制过去。

> 拷完应该是这样：
> ```
> chaoxing-auto-helper\
> ├── extension\
> ├── tests\
> ├── docs\
> ├── scripts\
> ├── README.md
> ├── LICENSE
> ├── .gitignore
> └── .gitattributes
> ```

### 4. 提交

回到 GitHub Desktop：

- 左侧 **Changes** 会列出所有文件
- 左下角 Summary 填：`初始提交：学习通自动学习助手`
- 点 **Commit to main**

### 5. 发布

- 顶部点 **Publish repository**
- **不勾** Keep this code private（除非你想私有）
- 点 **Publish repository**

完成。会给你一个 `https://github.com/你的用户名/chaoxing-auto-helper`。

---

## 方式三：命令行

如果你已经装了 Git。

```bash
cd /d "E:\ai处理文件\学习通刷课脚本\学习通自动学习助手"

git init
git add .
git commit -m "初始提交：学习通自动学习助手"

git branch -M main
git remote add origin https://github.com/你的用户名/chaoxing-auto-helper.git
git push -u origin main
```

**注意**：
- 先在 GitHub 网页上**创建空仓库**（不要勾初始化选项）
- 第一次 push 会要求登录，用 Personal Access Token 而不是密码
- 生成 Token：GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token，勾 `repo` 权限

---

## 上传后建议做的三件事

### 1. 加个截图

README 里现在是纯文字。建议截几张图放到 `docs/images/` 下（目录已建好，里面有 `.gitkeep` 占位），然后在 README 里用标准 Markdown 图片语法引用。

截图建议：

- 设置页的 API 配置区（**Key 必须打码**）
- 页面上的悬浮面板
- 诊断页的输出

> 图片文件放进 `docs/images/` 之后，README 里的相对路径才有效。

### 2. 检查语言统计

GitHub 会自动统计。如果发现 `.md` 占了很大比例，`.gitattributes` 里已经标了 `linguist-documentation`，稍等几分钟会更新。

### 3. 写 Release

```text
仓库页 → Releases → Create a new release
```

- Tag：`v1.0.0`
- Title：`v1.0.0 首个版本`
- 描述里写清楚功能点
- 可以把 `extension/` 打包成 zip 一起上传，方便别人直接下载

---

## 常见问题

### 中文文件名会乱码吗

不会。Git 支持 UTF-8 文件名，GitHub 页面也能正常显示中文。

但命令行用户在某些旧终端里可能看到转义字符 —— 这是终端问题，文件本身没问题。

### .cmd 文件上传后换行错了

`.gitattributes` 里已经指定 `*.cmd text eol=crlf`，Git 会自动处理。

如果是先上传后加的这个文件，可能需要重新 normalize：

```bash
git add --renormalize .
git commit -m "统一换行符"
```

### 想把扩展单独发布到 Edge 商店

那需要另外准备：

- 更详细的商店描述
- 隐私政策页面（必须，说明不收集数据）
- 打包好的 zip

个人用的话直接分享仓库就够了。

### 不想公开

创建仓库时选 **Private**，或者用 GitHub Desktop 的 Publish 时勾上 Keep this code private。

---

## 目录结构速查

```
学习通自动学习助手/          ← 这个目录整体作为仓库根
├── extension/               ← 用户加载这个目录装扩展
├── tests/                   ← 测试套件
├── docs/                    ← 技术文档
├── scripts/                 ← 一键脚本
├── README.md                ← 首页
├── LICENSE                  ← MIT
├── .gitignore
└── .gitattributes
```

**不要**把 `学习通自动学习助手` 这个目录本身也放进仓库 —— 仓库根就应该是它的内容。

# ClawTab — 开发指南

## 项目概述

ClawTab 是一个 Chrome 浏览器扩展，将浏览器连接到 OpenClaw Gateway，让 AI Agent 能够感知和控制浏览器标签页。它是 OpenClaw 生态中浏览器自动化的核心组件。

## 目录结构

```
clawtab/
├── manifest.json              # Chrome Extension Manifest V3
├── background.js              # Service Worker — WebSocket 通信、设备配对、任务执行引擎、sidebar 消息处理
├── popup/
│   ├── popup.html             # 弹出窗口 HTML
│   ├── popup.css              # 样式
│   └── popup.js               # 弹出窗口逻辑 — UI 渲染、事件绑定、i18n
├── sidebar/
│   ├── sidebar.html           # 侧边栏 HTML（Chrome Side Panel）
│   ├── sidebar.css            # 侧边栏样式（与 popup 同风格）
│   └── sidebar.js             # 侧边栏逻辑 — 聊天、Agent 切换、轮询
├── content/
│   └── content.js             # Content Script — 页面内 JS 执行、截图
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   ├── icon128.png
│   └── generate_icons.js      # 图标生成脚本
├── README.md                  # 用户文档（中英文）
├── AGENT_PROTOCOL.md          # Agent 通信协议规范
└── DEVELOPMENT.md             # 本文件
```

## 开发环境

### 前置要求
- Chrome / Chromium 浏览器（Manifest V3）
- 一个运行中的 OpenClaw Gateway 实例

### 加载扩展
1. 打开 `chrome://extensions/`
2. 开启右上角**开发者模式**
3. 点击 **加载已解压的扩展程序** → 选择项目根目录
4. 修改代码后，在 `chrome://extensions/` 点击扩展的 🔄 刷新按钮

### 调试
- **background.js**：在 `chrome://extensions/` 点击扩展卡片的 "Service Worker" 链接，打开 DevTools
- **popup.js**：右键点击扩展图标 → 检查弹出窗口
- **content.js**：在任意网页打开 DevTools → Console

### 固定 Extension ID
`manifest.json` 中包含一个固定的 `key` 字段，确保 Extension ID 始终为：
```
olfpncdbjlggonplhnlnbhkfianddhmp
```
**不要修改这个 key**，否则：
- Gateway 的 `allowedOrigins` 会失效
- 已配对的设备 token 会失效
- 用户需要重新配对

## 架构设计

### 通信架构

```
┌─────────────┐    WebSocket     ┌──────────────────┐
│   ClawTab    │ ◄─────────────► │  OpenClaw Gateway │
│ (background) │                 │                   │
└──────┬──────┘                 └────────┬──────────┘
       │ chrome.runtime                  │
       │ .sendMessage()                  │ Agent 发指令到
       │                                │ clawtab-{browserId} session
┌──────┴──────┐                 ┌────────┴──────────┐
│   popup.js   │                │    AI Agent        │
│   (UI 渲染)  │                │    (main/dajin)    │
└─────────────┘                └───────────────────┘
```

### 连接流程

1. **用户填写配置** → Gateway URL + Token + Browser Name
2. **WebSocket 握手** → 发送 `connect` 请求（含 device.id + publicKey）
3. **设备配对挑战** → Gateway 返回 `connect.challenge`，插件用 Ed25519 私钥签名后重发
4. **配对等待** → 如果设备未批准（NOT_PAIRED），显示配对面板，每 5 秒轮询重试
5. **配对批准** → 服务器端执行 `openclaw devices approve <requestId>`
6. **连接成功** → 收到 `connect.success`，存储 `deviceToken`，下次直接用
7. **会话轮询** → 连接后每 3 秒轮询 `chat.history` 获取 Agent 指令

### 任务执行流程

```
Agent 发 browser_check → 插件返回标签页快照 + 截图
Agent 发 task_plan     → 插件依次执行 steps
  ├── 每步执行后推送 task_step_result
  └── 全部完成后推送 task_result
Agent 或用户 task_cancel → 中止当前任务
```

### 互斥锁机制
- 同一时间只有一个 Agent 可以执行任务
- `taskStatus = 'running'` 时拒绝新指令，返回 BUSY + 占用者信息
- 任务完成/失败/取消自动释放锁

### popup.js 五层架构
经过多次重构，popup.js 采用以下清晰架构：
1. **I18N 对象** — 顶部定义所有翻译文本（中/英）
2. **Lang 初始化** — 第一步读 chrome.storage 设置语言
3. **setStatus(key)** — 唯一设置 statusText 的入口，同步写 `data-i18n`
4. **render(data)** — 纯函数，state → DOM 映射
5. **Events** — 事件绑定，实时查找 DOM 元素（不缓存引用）

## ⚠️ 已知坑 & 注意事项

### 1. popup.js 不要缓存 DOM 引用
**问题**：`const el = document.getElementById('xxx')` 如果在 DOMContentLoaded 时某些元素还未渲染，会得到 null，后续 `el.addEventListener()` 崩溃，**连带阻断所有后续事件绑定**。

**正确做法**：事件处理中实时 `document.getElementById()`，或用事件委托。

### 2. Gateway allowedOrigins 修改需要完整重启
**问题**：修改 `gateway.controlUi.allowedOrigins` 或 `gateway.auth` 后，SIGUSR1 热重载**无效**。

**正确做法**：
```bash
systemctl restart openclaw-gateway
# 或
openclaw gateway restart
```

### 3. NOT_PAIRED 时不要自动重连
**问题**：Gateway 在 NOT_PAIRED 时会主动关闭 WebSocket → 触发 `onclose` → `wsScheduleReconnect` 循环 → UI 闪烁。

**正确做法**：`pairingPending` 状态下 `onclose` 不触发重连，改为每 5 秒手动轮询重试。

### 4. wsDisconnect() 需要静默关闭
**问题**：手动断开时如果不先清除 `onclose`/`onerror` 回调，`ws.close()` 会触发重连逻辑。

**正确做法**：
```javascript
function wsDisconnect() {
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
    ws = null;
  }
}
```

### 5. statusText 必须走 data-i18n 机制
**问题**：直接设置 `statusText.textContent = 'xxx'` 会导致语言切换时该文字不更新。

**正确做法**：`setStatus(key)` 同时设 `textContent` 和 `data-i18n`/`data-status-key`，`applyI18n()` 统一处理。

### 6. 设置菜单用内联样式
**问题**：CSS class toggle 容易被浏览器缓存影响，`.open` class 的 `display: block` 不生效。

**正确做法**：用 `el.style.cssText` 设置 `display:block; position:absolute; ...`

### 7. Ed25519 设备身份
每个浏览器实例生成唯一的 Ed25519 密钥对（存储在 chrome.storage），用于设备配对的 challenge-response 签名。密钥一旦生成不可更换，否则需要重新配对。

## 关键 ID 和配置

| 项目 | 值 |
|------|------|
| Extension ID | `olfpncdbjlggonplhnlnbhkfianddhmp` |
| Gateway Token | `01a08b454887e59bcc388d4029fc67a93116b520354e0e21bc06e5246ac3b599` |
| Gateway 配对命令 | `openclaw devices approve <requestId>` |
| 本地开发路径 | `/root/.openclaw/workspaces/main/vivian-browser-extension/` |
| GitHub 仓库 | https://github.com/parksben/clawtab |

## Git 工作流

- 直接在 `main` 分支开发（目前是个人项目）
- Commit message 格式：`type: description`（feat/fix/refactor/docs/chore）
- 推送：`git push origin main`

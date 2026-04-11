# ClawTab — 开发指南

## 项目概述

ClawTab 是一个 Chrome 浏览器扩展，将浏览器连接到 OpenClaw Gateway，让 AI Agent 能够感知和控制浏览器标签页。它是 OpenClaw 生态中浏览器自动化的核心组件。

## 目录结构

```
clawtab/
├── manifest.json              # Chrome Extension Manifest V3
├── background.js              # Service Worker — WebSocket 通信、设备配对、clawtab_cmd 执行引擎、sidebar 消息处理
├── popup/
│   ├── popup.html             # 弹出窗口 HTML
│   ├── popup.css              # 弹出窗口样式
│   └── popup.js               # 弹出窗口逻辑 — UI 渲染、事件绑定、i18n
├── sidebar/
│   ├── sidebar.html           # 侧边栏 HTML（Chrome Side Panel）
│   ├── sidebar.css            # 侧边栏样式（与 popup 同风格）
│   ├── sidebar.js             # 侧边栏逻辑 — 聊天、Agent 切换、轮询、元素拾取
│   └── lib/
│       └── marked.min.js      # marked.js v15.0.12（GFM markdown 渲染，本地内置）
├── shared/
│   └── icons.js               # Lucide SVG sprite（popup 和 sidebar 共用）
├── content/
│   └── content.js             # Content Script — 元素高亮拾取、flash 动效、DOM 提取
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   ├── icon128.png
│   └── generate_icons.js      # 图标生成脚本
├── README.md                  # 用户文档（中英文）
├── PRD.md                     # 需求文档
├── AGENT_PROTOCOL.md          # Agent 通信协议规范
└── DEVELOPMENT.md             # 本文件
```

## 开发环境

### 前置要求
- Chrome / Chromium 浏览器（Manifest V3，建议 114+）
- 一个运行中的 OpenClaw Gateway 实例

### 加载扩展
1. 打开 `chrome://extensions/`
2. 开启右上角**开发者模式**
3. 点击 **加载已解压的扩展程序** → 选择项目根目录
4. 修改代码后，在 `chrome://extensions/` 点击扩展的刷新按钮

### 调试
- **background.js**：在 `chrome://extensions/` 点击扩展卡片的 "Service Worker" 链接，打开 DevTools
- **popup.js**：右键点击扩展图标 → 检查弹出窗口
- **sidebar.js**：在侧边栏内右键 → 检查，或从 DevTools Sources 打开
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
       │ .sendMessage()                  │ Agent 读写
       │                                │ clawtab-{channel} session
  ┌────┴────┐   ┌──────────┐   ┌────────┴──────────┐
  │ popup.js │   │sidebar.js│   │    AI Agent        │
  │ (UI 渲染)│   │ (聊天 UI)│   │    (main/dajin)    │
  └─────────┘   └──────────┘   └───────────────────┘
```

### 连接流程

1. **用户填写配置** → Gateway URL + Token + 渠道名称（Channel Name）
2. **WebSocket 握手** → 发送 `connect` 请求（含 device.id + publicKey，mode: `operator`）
3. **设备配对挑战** → Gateway 返回 `connect.challenge`，插件用 Ed25519 私钥签名（payload 格式 `v2|devId|clawtab|operator|role|scopes|ts|token|nonce`）后重发
4. **配对等待** → 如果设备未批准（NOT_PAIRED），显示配对面板，每 5 秒轮询重试
5. **配对批准** → 服务器端执行 `openclaw devices approve <requestId>`
6. **连接成功** → 收到 `connect.success`，存储 `deviceToken`，下次直接用；自动打开 Side Panel
7. **会话轮询** → 连接后每 3 秒轮询 `chat.history` 拉取 Agent 发出的 `clawtab_cmd` 指令

### clawtab_cmd 执行流程

```
Agent 写入 clawtab_cmd（perceive）→ background 轮询检测 → 截取 DOM + 截图 → sendResult
Agent 写入 clawtab_cmd（act）      → background 执行操作 → sendResult（含 captureAfter 截图）
Agent 写入 clawtab_cmd（task_done）→ 更新工具栏图标为完成状态
```

结果通过 `chat.send`（deliver:false）回写为 `clawtab_result` JSON 块，Agent 继续读取。

### 互斥锁机制
- `S.loop.status` 处于 `acting` / `perceiving` 时，新指令返回 `BUSY`
- `thinking` 状态（等待 Agent 下一步）不阻塞新指令
- 任务完成 / 失败 / 取消后状态回到 `idle`（8–10 秒延迟展示完成/失败状态后自动归位）

### sidebar.js 核心机制

- **自适应轮询**：`setTimeout` 链（非 `setInterval`），`STATE.waiting=true` 时 1 秒，空闲时 3 秒
- **本地回声去重**：发送时立即追加本地气泡（`data-local-echo` 标记），服务器确认时用 `replaceWith()` 原地替换
- **isTerminalMsg()**：判断 assistant 消息是否为终态（有正文文本 = 终态；纯 tool_use 或 clawtab_cmd perceive/act = 中间态，不清除 waiting）
- **marked.js 渲染**：`formatText()` 调用 `marked.parse()` + `sanitizeHtml()`（过滤 script/iframe/事件属性）
- **标签页状态持久化**：`saveTabState()` / `restoreTabState()` 在 `tab_activated` 消息时触发

### popup.js 五层架构
1. **I18N 对象** — 顶部定义所有翻译文本（中/英）
2. **Lang 初始化** — 第一步读 chrome.storage 设置语言
3. **setStatus(key)** — 唯一设置 statusText 的入口，同步写 `data-i18n`
4. **render(data)** — 纯函数，state → DOM 映射
5. **Events** — 事件绑定，实时查找 DOM 元素（不缓存引用）

## 已知坑 & 注意事项

### 1. popup.js 不要缓存 DOM 引用
**问题**：`const el = document.getElementById('xxx')` 如果在 DOMContentLoaded 时某些元素还未渲染，会得到 null，后续 `el.addEventListener()` 崩溃，**连带阻断所有后续事件绑定**。

**正确做法**：事件处理中实时 `document.getElementById()`，或用事件委托。

### 2. Gateway allowedOrigins 修改需要完整重启
**问题**：修改 `gateway.controlUi.allowedOrigins` 或 `gateway.auth` 后，SIGUSR1 热重载**无效**。

**正确做法**：
```bash
systemctl restart openclaw-gateway
```

### 3. NOT_PAIRED 时不要自动重连
**问题**：Gateway 在 NOT_PAIRED 时会主动关闭 WebSocket → 触发 `onclose` → `wsScheduleReconnect` 循环 → UI 闪烁。

**正确做法**：`pairingPending` 状态下 `onclose` 不触发重连，改为每 5 秒手动轮询重试。

### 4. wsDisconnect() 需要静默关闭
**问题**：手动断开时如果不先清除 `onclose`/`onerror` 回调，`ws.close()` 会触发重连逻辑。

**正确做法**：
```javascript
function wsDisconnect() {
  if (ws) { ws.onclose = null; ws.onerror = null; ws.close(); ws = null; }
}
```

### 5. statusText 必须走 data-i18n 机制
**问题**：直接设置 `statusText.textContent = 'xxx'` 会导致语言切换时该文字不更新。

**正确做法**：`setStatus(key)` 同时设 `textContent` 和 `data-i18n`，`applyI18n()` 统一处理。

### 6. Ed25519 签名 payload 必须使用 operator 模式
**问题**：签名 payload 中 clientId/clientMode 必须与 connect 请求体完全一致，否则服务器校验失败，缺少 `operator.read`/`operator.write` scope 导致 chat 接口报错。

**正确做法**：`signConnect` 和 connect 请求体都使用 `clientId:'webchat'`、`mode:'webchat'`；同时保留 `role:'operator'` 和 `scopes:['operator.read','operator.write']`。`client.id` 必须是 Gateway JSON Schema 白名单内的合法值，`'clawtab'` 不在白名单中。

### 7. flash_element 叠加层必须是单例
**问题**：每次调用 `flash_element` 都 `createElement` 会在 DOM 中堆积无数叠加层。

**正确做法**：`getElementById` 查找已有元素复用；`animation:'none' + void el.offsetWidth` 重启 CSS 动画。

### 8. sidebar waiting 状态在断连时必须强制清除
**问题**：WebSocket 断连后 `STATE.waiting` 仍为 true，导致发送按钮一直禁用。

**正确做法**：在 `status_update` 的 disconnected 分支强制 `STATE.waiting=false` + `hideThinking()`。

## 关键 ID 和配置

| 项目 | 值 |
|------|------|
| Extension ID | `olfpncdbjlggonplhnlnbhkfianddhmp` |
| Gateway 配对命令 | `openclaw devices approve <requestId>` |
| GitHub 仓库 | https://github.com/parksben/clawtab |

## Git 工作流

- 直接在 `main` 分支开发（目前是个人项目）
- Commit message 格式：`type: description`（feat/fix/refactor/docs/chore）
- 推送：`git push origin main`

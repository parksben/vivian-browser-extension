# ClawTab

**ClawTab** is a Chrome extension that connects your browser to an [OpenClaw](https://github.com/openclaw/openclaw) Gateway, enabling AI agents to observe and control your browser tabs.

## Features

- **Connect to any OpenClaw Gateway** — local or remote, via WebSocket
- **Persistent sidebar chat** — a Side Panel opens automatically after connecting; chat with any agent directly from your browser
- **Multi-agent selector** — switch between agents in the sidebar; each agent has its own independent session and chat history
- **Full Markdown rendering** — agent replies render GFM markdown (headings, lists, code blocks, tables, etc.) via bundled marked.js
- **Page element picker** — click the crosshair button in the sidebar to pick DOM elements on the current page and attach them to your message
- **Tab awareness** — list all open tabs, read page content, and capture screenshots
- **Task execution engine** — agents issue `perceive` / `act` commands; ClawTab executes and reports results in real time
- **Exclusive agent lock** — only one agent can occupy the browser at a time; concurrent requests are rejected with a clear reason
- **Channel identity** — set a channel name so the Gateway creates a dedicated session visible in the Web UI
- **Auto handshake** — ClawTab sends a greeting on connect so the session appears immediately in the OpenClaw Web UI
- **Auto-save** — URL, token, and channel name are remembered across sessions
- **Fixed extension ID** — pinned via `manifest.json` key, survives reinstalls
- **Bilingual UI** — switch between Chinese / English in the popup

## Installation

1. Download: **[clawtab-main.zip](https://github.com/parksben/clawtab/archive/refs/heads/main.zip)**
2. Unzip the file
3. Go to `chrome://extensions/` → enable **Developer mode**
4. Click **Load unpacked** → select the unzipped folder

Fixed extension ID: `olfpncdbjlggonplhnlnbhkfianddhmp`

## Setup

1. Click the ClawTab icon in your toolbar
2. Fill in **Gateway URL**, **Access Token**, and a **Channel Name** (used as the session identifier in the Web UI)
3. Click **Connect**
4. The sidebar opens automatically — chat with agents directly from there
5. The session `agent:main:clawtab-{channel}` appears in the OpenClaw Web UI

## Gateway Configuration

Add ClawTab's origin to `gateway.controlUi.allowedOrigins`:

```json
{
  "gateway": {
    "auth": { "mode": "token", "token": "your-token" },
    "controlUi": {
      "allowedOrigins": [
        "https://your-domain.com",
        "chrome-extension://olfpncdbjlggonplhnlnbhkfianddhmp"
      ]
    }
  }
}
```

> **Restart required:** After modifying `allowedOrigins` or `gateway.auth`, you must **fully restart** the OpenClaw Gateway. A hot-reload (SIGUSR1) is **not** sufficient for these settings.
>
> ```bash
> systemctl restart openclaw-gateway
> ```

## Agent Protocol

See [AGENT_PROTOCOL.md](./AGENT_PROTOCOL.md) for the full specification.

The primary agent interface is a **chat session** (`agent:{id}:clawtab-{channel}`) where the agent exchanges natural-language messages with ClawTab. To trigger browser automation, the agent embeds a `clawtab_cmd` JSON block in a chat message:

```json
{
  "type": "clawtab_cmd",
  "cmdId": "cmd-001",
  "action": "perceive",
  "agentId": "main"
}
```

ClawTab executes the command and replies in the same session with a `clawtab_result` JSON block (hidden from the sidebar UI, visible only to the agent).

### Actions

| action | description |
|---|---|
| `perceive` | Capture the active tab's DOM structure + screenshot |
| `act` | Execute a single browser operation (see ops below) |
| `task_start` | Signal the start of a multi-step task (updates the toolbar icon) |
| `task_done` | Signal task completion |
| `task_fail` | Signal task failure |
| `cancel` | Abort any in-progress command |

### `act` operations

The `act` action accepts a `payload` with an `op` field:

| op | key fields | description |
|---|---|---|
| `navigate` | `value` (URL) | Navigate the active tab |
| `click` | `target` (CSS selector or text) | Click an element |
| `fill` | `target`, `value` | Type into an input field |
| `clear` | `target` | Clear an input field |
| `press` | `value` (key name) | Dispatch a keyboard event |
| `select` | `target`, `value` | Choose a `<select>` option |
| `hover` | `target` | Mouse over an element |
| `scroll` | `target` (x), `value` (y) | Scroll to absolute position |
| `scroll_by` | `target` (dx), `value` (dy) | Scroll by relative offset |
| `scroll_to_element` | `target` | Scroll element into view |
| `wait` | `value` (ms) | Pause execution |
| `wait_for` | `target` | Wait for element to appear |
| `get_text` | `target` | Read element's text content |
| `get_attr` | `target`, `value` (attr name) | Read an element attribute |
| `eval` | `value` (JS code) | Execute arbitrary JavaScript |
| `screenshot_element` | `target` | Capture a single element as JPEG |
| `new_tab` | `value` (URL, optional) | Open a new tab |
| `close_tab` | `target` (tabId) | Close a tab |
| `switch_tab` | `target` (tabId) | Switch to a tab |
| `go_back` | — | Browser back |
| `go_forward` | — | Browser forward |

Optional on every `act`: `tabId`, `captureAfter` (screenshot after op), `waitAfter` (ms delay).

### Exclusive lock

- Only **one agent** can run commands at a time
- If the browser is busy, the response is `{ ok: false, errorCode: "BUSY" }` with the current status
- The lock releases automatically when the command completes, fails, or is cancelled

## Privacy & Security

- ClawTab only connects to the Gateway URL you explicitly configure
- No data is sent to any third-party services

## License

MIT

---

# ClawTab [中文]

**ClawTab** 是一个 Chrome 扩展，将你的浏览器连接到 [OpenClaw](https://github.com/openclaw/openclaw) Gateway，让 AI Agent 能够感知和控制浏览器标签页。

## 功能特性

- **连接任意 OpenClaw Gateway** — 本地或远程，通过 WebSocket
- **常驻侧边栏聊天** — 连接后自动打开侧边栏，直接在浏览器中与 Agent 对话
- **多 Agent 切换** — 侧边栏支持切换不同 Agent，每个 Agent 维护独立会话和历史记录
- **完整 Markdown 渲染** — Agent 回复支持完整 GFM markdown（标题、列表、代码块、表格等），通过内置 marked.js 渲染
- **页面元素拾取** — 点击侧边栏的拾取按钮，可在当前页面选中 DOM 元素并附加到消息中
- **标签页感知** — 列出所有标签页、读取页面内容、截图
- **任务执行引擎** — Agent 发送 `perceive` / `act` 指令，ClawTab 执行并实时上报结果
- **互斥占用锁** — 同一时间只有一个 Agent 可以占用浏览器，并发请求会被直接拒绝并说明原因
- **渠道标识** — 设置渠道名称，Gateway 会创建专属会话并在 Web UI 中可见
- **自动握手** — 连接成功后自动发送握手消息，Web UI 中会话即刻出现
- **自动保存** — URL、Token、渠道名称在会话间持久保存
- **固定 Extension ID** — 通过 `manifest.json` key 锁定，重装不变
- **中英文切换** — popup 右上角一键切换语言

## 安装

1. 下载：**[clawtab-main.zip](https://github.com/parksben/clawtab/archive/refs/heads/main.zip)**
2. 解压
3. 打开 `chrome://extensions/`，开启右上角**开发者模式**
4. 点击**加载已解压的扩展程序**，选择解压后的文件夹

固定 Extension ID：`olfpncdbjlggonplhnlnbhkfianddhmp`

## 使用

1. 点击工具栏中的 ClawTab 图标
2. 填写 **Gateway URL**、**Access Token**，以及**渠道名称**（作为 Web UI 中的会话标识）
3. 点击**保存并连接**
4. 浏览器右侧自动弹出侧边栏，在侧边栏中直接与 Agent 对话
5. Web UI 中可找到 `agent:main:clawtab-{渠道名称}` 会话

## Gateway 配置

将 ClawTab 的 origin 加入 `gateway.controlUi.allowedOrigins`：

```json
{
  "gateway": {
    "auth": { "mode": "token", "token": "你的token" },
    "controlUi": {
      "allowedOrigins": [
        "https://你的域名.com",
        "chrome-extension://olfpncdbjlggonplhnlnbhkfianddhmp"
      ]
    }
  }
}
```

> **需要重启：** 修改 `allowedOrigins` 或 `gateway.auth` 后，必须**完整重启** OpenClaw Gateway 才能生效，热重载（SIGUSR1）对这些配置**无效**。
>
> ```bash
> systemctl restart openclaw-gateway
> ```

## Agent 协议

完整规范见 [AGENT_PROTOCOL.md](./AGENT_PROTOCOL.md)。

Agent 的主要交互方式是**聊天会话**（`agent:{id}:clawtab-{渠道名称}`）。要触发浏览器自动化，Agent 在聊天消息中嵌入 `clawtab_cmd` JSON 块：

```json
{
  "type": "clawtab_cmd",
  "cmdId": "cmd-001",
  "action": "perceive",
  "agentId": "main"
}
```

ClawTab 执行指令后，在同一会话中回复 `clawtab_result` JSON 块（侧边栏 UI 不显示，仅 Agent 可见）。

### 指令动作

| action | 描述 |
|---|---|
| `perceive` | 截取当前标签页 DOM 结构 + 截图 |
| `act` | 执行单步浏览器操作（见下表） |
| `task_start` | 标记多步任务开始（更新工具栏图标） |
| `task_done` | 标记任务完成 |
| `task_fail` | 标记任务失败 |
| `cancel` | 中止当前指令 |

### `act` 操作列表

| op | 主要字段 | 描述 |
|---|---|---|
| `navigate` | `value`（URL） | 导航到指定 URL |
| `click` | `target`（选择器或文本） | 点击元素 |
| `fill` | `target`、`value` | 填写输入框 |
| `clear` | `target` | 清空输入框 |
| `press` | `value`（键名） | 触发键盘事件 |
| `select` | `target`、`value` | 选择下拉选项 |
| `hover` | `target` | 鼠标悬停 |
| `scroll` | `target`（x）、`value`（y） | 滚动到绝对坐标 |
| `scroll_by` | `target`（dx）、`value`（dy） | 相对滚动 |
| `scroll_to_element` | `target` | 滚动到元素 |
| `wait` | `value`（ms） | 等待 |
| `wait_for` | `target` | 等待元素出现 |
| `get_text` | `target` | 读取元素文本 |
| `get_attr` | `target`、`value`（属性名） | 读取元素属性 |
| `eval` | `value`（JS 代码） | 执行任意 JavaScript |
| `screenshot_element` | `target` | 截取单个元素 |
| `new_tab` | `value`（URL，可选） | 新建标签页 |
| `close_tab` | `target`（tabId） | 关闭标签页 |
| `switch_tab` | `target`（tabId） | 切换标签页 |
| `go_back` | — | 浏览器后退 |
| `go_forward` | — | 浏览器前进 |

每个 `act` 可附加可选字段：`tabId`、`captureAfter`（操作后截图）、`waitAfter`（等待毫秒）。

## License

MIT

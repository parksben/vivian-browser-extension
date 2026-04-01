# ClawTab

**ClawTab** is a Chrome extension that connects your browser to an [OpenClaw](https://github.com/openclaw/openclaw) Gateway, enabling AI agents to observe and control your browser tabs.

## Features

- 🔌 **Connect to any OpenClaw Gateway** — local or remote, via WebSocket
- 👁️ **Tab awareness** — list all open tabs, read page content, and capture screenshots
- 🤖 **Agent selector** — choose which agents are allowed to control your browser
- ⚡ **Task execution engine** — agents send multi-step task plans; ClawTab executes and reports progress in real time
- 🔒 **Exclusive agent lock** — only one agent can occupy the browser at a time; concurrent requests are rejected with a clear reason
- 🏷️ **Browser identity** — set a custom name so the Gateway knows which browser is connected
- 💾 **Auto-save** — URL, token, and browser name are remembered across sessions
- 📌 **Fixed extension ID** — pinned via `manifest.json` key, survives reinstalls
- 🌐 **Bilingual UI** — switch between Chinese / English in the popup

## Installation

1. Download: **[clawtab-main.zip](https://github.com/parksben/clawtab/archive/refs/heads/main.zip)**
2. Unzip the file
3. Go to `chrome://extensions/` → enable **Developer mode**
4. Click **Load unpacked** → select the unzipped folder

Fixed extension ID: `olfpncdbjlggonplhnlnbhkfianddhmp`

## Setup

1. Click the ClawTab icon in your toolbar
2. Fill in **Gateway URL**, **Access Token**, and an optional **Browser Name**
3. Click **Connect**
4. Once connected, check which **Agents** are allowed to control this browser

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

> ⚠️ **Restart required:** After modifying `allowedOrigins` or `gateway.auth`, you must **fully restart** the OpenClaw Gateway. A hot-reload (SIGUSR1) is **not** sufficient for these settings.
>
> ```bash
> systemctl restart openclaw-gateway
> ```

## Agent Protocol

See [AGENT_PROTOCOL.md](./AGENT_PROTOCOL.md) for the full specification.

### Quick start — standard pre-flight sequence

Before automation, the agent should:

**0. Check browser status**
```json
{ "type": "browser_check", "checkId": "chk-001", "agentId": "main" }
```
Returns: browser name, authorization status, `busy` flag (whether another agent is currently occupying it), and a snapshot of all open tabs (with screenshot of the active tab).

**1. If `busy: true` → abort**
The browser is occupied by another agent. The response includes `occupiedByAgent` with the agent ID currently in control.

**2. Send task plan**
```json
{
  "type": "task_plan",
  "taskId": "task-001",
  "taskName": "Collect page title",
  "agentId": "main",
  "steps": [
    { "type": "execute_js", "label": "Get title", "tabId": 1, "code": "document.title" },
    { "type": "screenshot", "label": "Capture", "tabId": 1 }
  ]
}
```

**3. Receive results**
ClawTab pushes `task_step_result` after each step, and `task_result` when done.

### Exclusive lock

- Only **one agent** can run a task at a time
- If another agent sends `task_plan` while the browser is occupied, it immediately receives:
  ```
  Browser is currently occupied by agent "main". Task "xxx" is in progress. Please try again later.
  ```
- The lock is released automatically when the task completes, fails, or is cancelled
- The user can also cancel the current task from the ClawTab popup

### Supported step types

| type | fields | description |
|---|---|---|
| `navigate` | `tabId`, `url` | Navigate a tab |
| `execute_js` | `tabId`, `code` | Run JS, returns result |
| `screenshot` | `tabId` | Capture JPEG screenshot |
| `get_content` | `tabId` | Get page text + HTML |
| `wait` | `ms` | Pause |

Optional per step: `label`, `timeout` (ms), `abortOnError: false`

## Privacy & Security

- ClawTab only connects to the Gateway URL you explicitly configure
- Agent access is restricted to the agents you select in the popup
- No data is sent to any third-party services

## License

MIT

---

# ClawTab [中文]

**ClawTab** 是一个 Chrome 扩展，将你的浏览器连接到 [OpenClaw](https://github.com/openclaw/openclaw) Gateway，让 AI Agent 能够感知和控制浏览器标签页。

## 功能特性

- 🔌 **连接任意 OpenClaw Gateway** — 本地或远程，通过 WebSocket
- 👁️ **标签页感知** — 列出所有标签页、读取页面内容、截图
- 🤖 **Agent 选择器** — 选择哪些 Agent 可以控制你的浏览器
- ⚡ **任务执行引擎** — Agent 发送多步骤任务计划，ClawTab 执行并实时上报进度
- 🔒 **互斥占用锁** — 同一时间只有一个 Agent 可以占用浏览器，并发请求会被直接拒绝并说明原因
- 🏷️ **浏览器标识** — 设置自定义名称，让 Gateway 识别是哪台浏览器
- 💾 **自动保存** — URL、Token、浏览器名称在会话间持久保存
- 📌 **固定 Extension ID** — 通过 `manifest.json` key 锁定，重装不变
- 🌐 **中英文切换** — popup 右上角一键切换语言

## 安装

1. 下载：**[clawtab-main.zip](https://github.com/parksben/clawtab/archive/refs/heads/main.zip)**
2. 解压
3. 打开 `chrome://extensions/`，开启右上角**开发者模式**
4. 点击**加载已解压的扩展程序**，选择解压后的文件夹

固定 Extension ID：`olfpncdbjlggonplhnlnbhkfianddhmp`

## 使用

1. 点击工具栏中的 ClawTab 图标
2. 填写 **Gateway URL**、**Access Token**，以及可选的**浏览器名称**
3. 点击**保存并连接**
4. 连接成功后，勾选允许控制浏览器的 Agent

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

> ⚠️ **需要重启：** 修改 `allowedOrigins` 或 `gateway.auth` 后，必须**完整重启** OpenClaw Gateway 才能生效，热重载（SIGUSR1）对这些配置**无效**。
>
> ```bash
> systemctl restart openclaw-gateway
> ```

## Agent 协议

完整规范见 [AGENT_PROTOCOL.md](./AGENT_PROTOCOL.md)。

### 快速上手 — 标准调用流程

**0. 检查浏览器状态**
```json
{ "type": "browser_check", "checkId": "chk-001", "agentId": "main" }
```
返回：浏览器名称、授权状态、`busy` 标志（是否被其他 Agent 占用）、所有标签页快照（含活跃标签截图）。

**1. 如果 `busy: true` → 终止**
浏览器已被其他 Agent 占用，响应中包含 `occupiedByAgent` 字段说明当前占用者。

**2. 发送任务计划**
```json
{
  "type": "task_plan",
  "taskId": "task-001",
  "taskName": "获取页面标题",
  "agentId": "main",
  "steps": [
    { "type": "execute_js", "label": "获取标题", "tabId": 1, "code": "document.title" },
    { "type": "screenshot", "label": "截图",     "tabId": 1 }
  ]
}
```

**3. 接收结果**
ClawTab 每步完成后推送 `task_step_result`，全部完成后推送 `task_result`。

### 互斥占用锁

- 同一时间只有**一个 Agent** 可以执行任务
- 占用期间其他 Agent 发送 `task_plan` 会立即收到错误：
  ```
  Browser is currently occupied by agent "main". Task "xxx" is in progress. Please try again later.
  ```
- 任务完成/失败/取消后自动释放锁
- 用户也可以在 ClawTab popup 中手动取消当前任务

### 支持的步骤类型

| 类型 | 字段 | 描述 |
|---|---|---|
| `navigate` | `tabId`, `url` | 导航到指定 URL |
| `execute_js` | `tabId`, `code` | 执行 JS，返回结果 |
| `screenshot` | `tabId` | 截取 JPEG 截图 |
| `get_content` | `tabId` | 获取页面文本和 HTML |
| `wait` | `ms` | 等待指定毫秒 |

每个步骤可选：`label`（显示名称）、`timeout`（超时毫秒）、`abortOnError: false`（失败后继续）

## License

MIT

# ClawTab

> 中文文档：[README_ZH.md](./README_ZH.md)

**ClawTab** is a Chrome extension that connects your browser to an [OpenClaw](https://github.com/openclaw/openclaw) Gateway, enabling AI agents to observe and control your browser tabs.

## Quick Start

### 1. Install the extension

1. Download: **[clawtab-main.zip](https://github.com/parksben/clawtab/archive/refs/heads/main.zip)**
2. Unzip, then go to `chrome://extensions/` and enable **Developer mode**
3. Click **Load unpacked** → select the unzipped folder

### 2. Configure the Gateway

Run this one-liner on the machine where OpenClaw Gateway is installed:

```bash
curl -fsSL https://raw.githubusercontent.com/parksben/clawtab/main/scripts/setup-gateway.sh | bash
```

The script auto-detects your config file, adds ClawTab's extension origin to `allowedOrigins`, and restarts the service. A backup of your config is saved automatically.

> **Manual setup:** If you prefer to edit the config yourself, add
> `chrome-extension://olfpncdbjlggonplhnlnbhkfianddhmp` to
> `gateway.controlUi.allowedOrigins`, then restart the Gateway with
> `systemctl restart openclaw-gateway`.

### 3. Connect

1. Click the **ClawTab** icon — the sidebar opens
2. Fill in **Gateway URL**, **Access Token**, and a **Channel Name**
3. Click **Connect** — the sidebar switches to chat mode automatically

The session `agent:main:clawtab-{channel}` appears in the OpenClaw Web UI.

## Features

- **Sidebar-first UI** — one click opens the sidebar with all controls; no popup
- **Config page** — URL, token, channel name; export/import config; language toggle
- **Persistent chat** — chat with agents directly from the sidebar after connecting
- **Multi-agent selector** — switch agents; each has its own session and history
- **Full Markdown rendering** — GFM markdown via bundled marked.js
- **Element picker** — click a crosshair button to pick DOM elements and attach them to messages
- **Task status bar** — live goal, step, and screenshot thumbnail while a task runs
- **Tab awareness** — list all tabs, read page content, capture screenshots
- **Task execution engine** — agents issue `perceive` / `act` commands; ClawTab executes in real time
- **Exclusive agent lock** — one agent at a time; concurrent requests are rejected with a clear reason
- **Bilingual UI** — English / Chinese, switchable in the sidebar

## Agent Protocol

Agents control the browser by embedding a `clawtab_cmd` JSON block in a chat message:

```json
{
  "type": "clawtab_cmd",
  "cmdId": "act-001",
  "action": "act",
  "agentId": "main",
  "payload": { "op": "click", "target": ".submit-btn", "captureAfter": true }
}
```

ClawTab executes the command and replies with a `clawtab_result` block (hidden from the sidebar UI, visible only to the agent).

See [AGENT_PROTOCOL.md](./AGENT_PROTOCOL.md) for the full command reference.

## Privacy & Security

ClawTab only connects to the Gateway URL you explicitly configure. No data is sent to any third-party services.

## License

MIT

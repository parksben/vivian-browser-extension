# ClawTab

> English docs: [README.md](./README.md)

**ClawTab** 是一个 Chrome 扩展，将你的浏览器连接到 [OpenClaw](https://github.com/openclaw/openclaw) Gateway，让 AI Agent 能够感知和控制浏览器标签页。

## 快速开始

### 1. 安装扩展

1. 下载：**[clawtab-main.zip](https://github.com/parksben/clawtab/archive/refs/heads/main.zip)**
2. 解压，打开 `chrome://extensions/`，开启右上角**开发者模式**
3. 点击**加载已解压的扩展程序** → 选择解压后的文件夹

### 2. 配置 Gateway

在安装了 OpenClaw Gateway 的机器上执行：

```bash
curl -fsSL https://raw.githubusercontent.com/parksben/clawtab/main/scripts/setup-gateway.sh | bash
```

脚本会自动定位配置文件，将 ClawTab 的扩展 origin 写入 `allowedOrigins`，并重启服务。执行前会自动备份原始配置。

> **手动配置：** 如需手动修改，将
> `chrome-extension://olfpncdbjlggonplhnlnbhkfianddhmp` 添加到
> `gateway.controlUi.allowedOrigins`，然后执行
> `systemctl restart openclaw-gateway` 重启 Gateway。

### 3. 连接

1. 点击工具栏中的 **ClawTab** 图标 — 侧边栏打开
2. 填写 **Gateway URL**、**Access Token** 和**渠道名称**
3. 点击 **Connect** — 侧边栏自动切换到聊天页

Web UI 中可找到 `agent:main:clawtab-{渠道名称}` 会话。

## 功能特性

- **侧边栏优先** — 一键打开侧边栏，所有控制集中在一处，无弹窗
- **Config 页** — Gateway 地址、Token、渠道名称；支持导出/导入配置；语言切换
- **常驻侧边栏聊天** — 连接后直接在侧边栏与 Agent 对话
- **多 Agent 切换** — 支持多 Agent，每个 Agent 维护独立会话和历史
- **完整 Markdown 渲染** — 内置 marked.js，支持完整 GFM 语法
- **元素拾取** — 点击十字准心按钮，在页面中选取 DOM 元素并附加到消息
- **任务状态栏** — 任务运行时显示目标、当前步骤和实时截图缩略图
- **标签页感知** — 列出所有标签页、读取页面内容、截图
- **任务执行引擎** — Agent 发送 `perceive` / `act` 指令，ClawTab 实时执行
- **互斥占用锁** — 同一时间只允许一个 Agent 控制浏览器
- **中英文切换** — 侧边栏支持一键切换语言

## Agent 协议

Agent 通过在聊天消息中嵌入 `clawtab_cmd` JSON 块来控制浏览器：

```json
{
  "type": "clawtab_cmd",
  "cmdId": "act-001",
  "action": "act",
  "agentId": "main",
  "payload": { "op": "click", "target": ".submit-btn", "captureAfter": true }
}
```

ClawTab 执行后回复 `clawtab_result` 块（侧边栏不显示，仅 Agent 可见）。

完整命令参考见 [AGENT_PROTOCOL.md](./AGENT_PROTOCOL.md)。

## 隐私与安全

ClawTab 仅连接到你明确配置的 Gateway 地址，不向任何第三方服务发送数据。

## License

MIT

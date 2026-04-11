# ClawTab — 需求文档 (PRD)

## 产品定位

ClawTab 是 OpenClaw 生态的浏览器客户端，让 AI Agent 能够：
- **感知**浏览器状态（标签页列表、页面内容、DOM 结构、截图）
- **控制**浏览器行为（导航、点击、填表、截图、执行 JS 等）
- **对话**：用户和 Agent 通过常驻侧边栏双向聊天

它是 Agent 实现 Web 自动化任务的基础设施。

## 核心功能需求

### F1: Gateway 连接（✅ 已实现）
- 用户输入 Gateway URL + Token + **渠道名称（Channel Name）**
- WebSocket 连接，标准 OpenClaw 握手协议（operator 模式）
- 连接状态实时显示（连接中 / 已连接 / 断开 / 重连中）
- 配置自动保存到 chrome.storage
- Session Key 格式：`agent:{agentId}:clawtab-{渠道名称}`

### F2: 设备配对（✅ 已实现）
- 首次连接自动生成 Ed25519 密钥对
- Challenge-Response 签名流程（payload 格式 `v2|devId|clawtab|operator|role|scopes|ts|token|nonce`）
- 未配对时显示专属配对面板（含设备 ID + 审批命令）
- 配对成功后 deviceToken 持久化，下次直接用
- NOT_PAIRED 状态下不触发自动重连（改为 5 秒配对轮询）

### F3: clawtab_cmd 执行引擎（✅ 已实现）
Agent 通过聊天会话发送 `clawtab_cmd` JSON 块触发自动化：

**动作（action）：**
- `perceive` — 截取当前标签页 DOM 结构 + 截图
- `act` — 执行单步浏览器操作
- `task_start` / `task_done` / `task_fail` — 任务生命周期标记
- `cancel` — 中止当前操作

**`act` 支持的操作（op）：**
`navigate` · `click` · `fill` · `clear` · `press` · `select` · `hover` · `scroll` · `scroll_by` · `scroll_to_element` · `wait` · `wait_for` · `get_text` · `get_attr` · `eval` · `screenshot_element` · `new_tab` · `close_tab` · `switch_tab` · `go_back` · `go_forward`

每条 `act` 可附加 `captureAfter`（操作后截图）、`waitAfter`（延迟毫秒）。

结果通过 `clawtab_result` JSON 块回写到同一聊天会话（`deliver:false`，Agent 可见但侧边栏不展示）。

### F4: 互斥占用锁（✅ 已实现）
- 同一时间只有一个 Agent 可以执行操作
- 占用期间其他指令返回 `BUSY` + 当前状态信息
- 操作完成 / 失败 / 取消自动释放

### F5: browser_check 预检（✅ 已实现）
- Agent 发送 `browser_check` 获取浏览器快照
- 返回：browserId、授权状态、是否忙碌、所有标签页列表 + 活跃标签截图

### F6: 中英文 UI（✅ 已实现）
- 右上角齿轮菜单切换中 / 英文
- 所有 UI 文本通过 data-i18n 机制统一管理

### F7: 配置导入/导出（✅ 已实现）
- 导出为 `.clawtab` / `.json` 文件
- 导入后显示配置表单供确认

### F8: 自动重连（✅ 已实现）
- 连接断开后自动重连，最多 3 次，指数退避
- 3 次失败后显示配置面板 + 错误提示
- NOT_PAIRED 状态下不触发自动重连

### F9: 连接握手消息（✅ 已实现）
- 连接成功后自动向 clawtab session 发送一条 `deliver:true` 的握手消息
- 内容：`🦾 ClawTab 已连接 · {渠道名称} · N 个标签页`
- 效果：Web UI 的会话列表中立即出现该 session

### F10: 常驻侧边栏聊天（✅ 已实现）
- 连接成功后自动打开 Chrome Side Panel（需 Chrome 114+）
- 侧边栏（`sidebar/`）提供完整聊天 UI：
  - **Agent 选择器**：下拉切换 agent，每个 agent 独立 session，切换时历史清空
  - **消息气泡**：用户消息右对齐（紫色），Agent 回复左对齐（白色）
  - **完整 GFM Markdown 渲染**：通过内置 marked.js（v15.0.12）支持标题、列表、代码块、表格、引用块、链接等
  - **clawtab_cmd 摘要行**：Agent 浏览器指令渲染为紧凑摘要（Lucide SVG 图标 + 操作描述），不展示原始 JSON
  - **clawtab_result 隐藏**：内部结果消息不在聊天中显示
  - **工具调用摘要**：`tool_use` 类型 content block 渲染为摘要行
  - **思考指示器**：发送消息后显示三点动画，等待 Agent 回复；60 秒安全超时自动解除
  - **本地回声去重**：发送后立即显示乐观本地气泡，服务器确认时原地替换，无重复
  - **自适应轮询**：等待 Agent 回复时 1 秒轮询，空闲时 3 秒轮询
  - **页面元素拾取**：拾取按钮（十字指针图标）激活后可在当前页面选中 DOM 元素，选中的元素作为标签附加到消息
  - **附件标签**：附加元素显示为可点击的标签（点击后高亮闪烁元素）、可删除；发送时附带 selector + 文本上下文
  - **标签页状态持久化**：切换浏览器标签页时自动保存/恢复输入框内容和附件列表
  - **状态徽章**：连接状态（已连接 / 重连中 / 未连接）实时更新

### F11: 连接后隐藏设置按钮（✅ 已实现）
- Popup 连接成功状态下，右上角齿轮设置按钮自动隐藏
- 未连接 / 配对等待状态下正常显示

### F12: 页面元素拾取（✅ 已实现）
- 侧边栏拾取按钮激活后，content.js 进入高亮拾取模式
- 鼠标悬停元素时显示高亮边框（蓝色半透明叠加层，position:fixed）
- 点击元素后退出拾取模式，将元素信息（tag、id、classes、text、selector）传回侧边栏
- 侧边栏切换标签页时自动退出拾取模式

## 待开发功能

### F13: 任务队列
- 当前是拒绝并发，未来可以排队等待
- 优先级机制

### F14: 安全增强
- step 执行前的安全检查（危险 URL、恶意 JS 检测）
- 用户确认机制（高风险操作弹窗确认）
- 操作审计日志

## 已修复问题

| # | 描述 | 状态 |
|---|------|------|
| 1 | UI 闪烁 — NOT_PAIRED 触发 WS 断开 → onclose 重连循环 | ✅ pairingPending 状态下不重连 |
| 2 | 配对码不出现 — pairingPending 状态未正确传递到 popup | ✅ broadcastStatus 含 pairingPending |
| 3 | 设置菜单无法弹出 — null DOM 引用崩溃 | ✅ popup.js 重写 |
| 4 | statusText 中英文反转 | ✅ data-i18n 统一机制 |
| 5 | 工具栏图标显示为 canvas 绘制的"C"而非设计 logo | ✅ idle/connected 状态使用 PNG 文件 |
| 6 | Web UI 中找不到 clawtab session | ✅ channel 改为 webchat + 握手消息 |
| 7 | 聊天发送失败（missing scope: operator.read/write） | ✅ signConnect 签名 payload 改为 `clawtab/operator` 模式 |
| 8 | 用户消息发送后出现重复气泡 | ✅ 本地回声去重（data-local-echo + replaceWith） |
| 9 | 发送后 running 态永远不清除 | ✅ isTerminalMsg() 区分终态 / 中间工具调用 |
| 10 | 断连后 waiting 锁不释放，输入框无法使用 | ✅ status_update 断连时强制清除 waiting |
| 11 | 侧边栏消息不支持 Markdown | ✅ 内置 marked.js v15.0.12，完整 GFM 渲染 |
| 12 | flash_element 动效每次都新建 overlay div | ✅ 改为单例复用，animation:none + offsetWidth 重启动画 |

## 技术约束

- **Manifest V3**：Service Worker 生命周期有限，通过 `chrome.alarms` 保活
- **无构建工具**：纯 JS/CSS/HTML，不使用 webpack/vite/TypeScript
- **固定 Extension ID**：通过 manifest.json `key` 字段锁定，不可更改
- **Lucide 图标**：所有 UI 图标使用 Lucide SVG sprite（`shared/icons.js`），不使用 emoji

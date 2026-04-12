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

### F5: 中英文 UI（✅ 已实现）
- Config 页顶栏和 Chat 页顶栏各有一个语言切换按钮（globe 图标）
- 两个页面的所有 UI 文本通过 data-i18n 机制统一管理，切换即时生效
- 默认语言为英文；用户切换后持久化到 chrome.storage

### F6: 配置导入/导出（✅ 已实现）
- Config 页顶栏提供导出（download 图标）和导入（folder-open 图标）按钮
- 导出为 `.json` 文件；导入后自动填充表单并断开当前连接

### F7: 自动重连（✅ 已实现）
- 连接断开后自动重连，最多 3 次，指数退避
- 3 次失败后显示配置面板 + 错误提示
- NOT_PAIRED 状态下不触发自动重连

### F8: 连接握手消息（✅ 已实现）
- 连接成功后自动向 clawtab session 发送一条 `deliver:true` 的握手消息
- 效果：Web UI 的会话列表中立即出现该 session
- 握手标志持久化到 storage，SW 重启后不重发

### F9: 全功能侧边栏（✅ 已实现）
点击插件图标直接打开 Chrome Side Panel（需 Chrome 114+），**无弹窗**。侧边栏分两个页面：

**Config 页（连接配置）：**
- 顶栏：功能标题（"Connect OpenClaw"，i18n）+ 语言切换（globe）+ 导出（download）+ 导入（folder-open）
- 表单：Gateway URL、Access Token（密码框+眼睛切换）、渠道名称（含提示文字）
- 连接按钮：点击后显示旋转 spinner 并禁用；由 `showPage('config')` 统一重置
- 配对等待状态：表单区域整体替换为配对码展示（设备 ID 缩略 + CLI 命令 + 复制按钮）
- 重连失败提示横幅：连接 3 次失败后显示红色错误提示
- 表单草稿自动保存（600 ms 防抖），下次打开自动填充

**Chat 页（聊天）：**
- 顶栏：小 logo、Agent 选择下拉、状态徽章（已连接 / 重连中 / 未连接）、语言切换（globe）、断连按钮（power-off）
- 任务状态栏（运行时显示）：任务目标文字 + 当前步骤状态 + 最新截图缩略图（点击全屏） + 取消按钮
- 消息区：用户消息右对齐（紫色气泡），Agent 回复左对齐（白色气泡）
- 完整 GFM Markdown 渲染（内置 marked.js v15.0.12）
- clawtab_cmd 摘要行（Lucide 图标 + 操作描述）；clawtab_result 隐藏
- 工具调用（tool_use）摘要行；思考指示器（三点动画）；60 秒安全超时
- 本地回声去重（乐观本地气泡，服务器确认后原地替换）
- 自适应轮询（等待 Agent 回复时 1 秒，空闲时 3 秒）
- 元素拾取按钮 + 附件标签（含 selector 上下文，可删除，可高亮闪烁）
- 标签页状态持久化（切换浏览器标签页时保存/恢复输入框 + 附件）
- 截图全屏 lightbox

**页面路由逻辑：**

| background 状态 | 显示页面 |
|-----------------|----------|
| `pairingPending: true` | Config 页（配对码展示） |
| `wsConnected: true` | Chat 页 |
| `gaveUp: true` | Config 页（红色错误提示） |
| 其他断连状态 | Config 页（表单） |

### F10: 连接成功自动切换（✅ 已实现）
- background 广播 `status_update(wsConnected:true)` → sidebar 自动切换到 Chat 页
- 手动点击断连 → `bg('disconnect')` → sidebar 切回 Config 页，不再自动重连

### F11: 页面元素拾取（✅ 已实现）
- 侧边栏拾取按钮激活后，content.js 进入高亮拾取模式
- 鼠标悬停元素时显示高亮边框（蓝色半透明叠加层，position:fixed）
- 点击元素后退出拾取模式，将元素信息（tag、id、classes、text、selector）传回侧边栏
- 侧边栏切换标签页时自动退出拾取模式

## 待开发功能

### F12: 任务队列
- 当前是拒绝并发，未来可以排队等待
- 优先级机制

### F13: 安全增强
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
| 7 | 聊天发送失败（missing scope: operator.read/write） | ✅ signConnect 签名使用 `openclaw-control-ui`/`webchat` 身份 |
| 8 | 用户消息发送后出现重复气泡 | ✅ 本地回声去重（data-local-echo + replaceWith） |
| 9 | 发送后 running 态永远不清除 | ✅ isTerminalMsg() 区分终态 / 中间工具调用 |
| 10 | 断连后 waiting 锁不释放，输入框无法使用 | ✅ status_update 断连时强制清除 waiting |
| 11 | 侧边栏消息不支持 Markdown | ✅ 内置 marked.js v15.0.12，完整 GFM 渲染 |
| 12 | flash_element 动效每次都新建 overlay div | ✅ 改为单例复用，animation:none + offsetWidth 重启动画 |
| 13 | `client.id='clawtab'` 被 Gateway JSON Schema 拒绝（1008 错误） | ✅ 改用 `openclaw-control-ui`（Gateway 合法值之一） |
| 14 | `sessions.create` / `chat.send` / `chat.history` Schema 不匹配 | ✅ sessionKey→key，删除 channel，补 idempotencyKey，删除 after 字段 |
| 15 | 握手消息在每次 Service Worker 重启后重复发送 | ✅ 持久化 `hs_{sessionKey}` 标志（API 调用前写入，失败时撤销）+ connect-ok 双重检查 |
| 16 | 手动断连后插件自动重连 | ✅ `wsManualDisconnect` 标志持久化到 storage，alarms / init() 均检查 |
| 17 | sidebar.html pairing 区域误写 `${icon(...)}` 模板字符串 | ✅ 改为 `<svg><use href="#icon-link"></use></svg>` |
| 18 | SW 重启后 doPoll 重放历史消息，旧 clawtab_cmd 被重复执行 | ✅ doPoll 用 lastSeenMsgId 定位切片，只处理新消息 |
| 19 | 连接配置顶栏显示品牌信息；语言/导出/导入按钮语义不直观 | ✅ 顶栏改为功能标题 "Connect OpenClaw"；语言改 globe 图标；导出/导入改 download / folder-open |
| 20 | 点击连接后按钮立即恢复可点击（1.5 s setTimeout），可重复触发 | ✅ 改用 loading class + CSS spinner；由 showPage('config') 统一重置按钮状态 |

## 技术约束

- **Manifest V3**：Service Worker 生命周期有限，通过 `chrome.alarms` 保活
- **无构建工具**：纯 JS/CSS/HTML，不使用 webpack/vite/TypeScript
- **固定 Extension ID**：通过 manifest.json `key` 字段锁定，不可更改
- **Lucide 图标**：所有 UI 图标使用 Lucide SVG sprite（`shared/icons.js`），不使用 emoji

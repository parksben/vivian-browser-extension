# ClawTab — 需求文档 (PRD)

## 产品定位

ClawTab 是 OpenClaw 生态的浏览器客户端，让 AI Agent 能够：
- **感知**浏览器状态（标签页列表、页面内容、截图）
- **控制**浏览器行为（导航、执行 JS、填表、点击、截图等）

它是 Agent 实现 Web 自动化任务的基础设施。

## 核心功能需求

### F1: Gateway 连接（✅ 已实现）
- 用户输入 Gateway URL + Token + **渠道名称（Channel Name）**
- WebSocket 连接，标准 OpenClaw 握手协议
- 连接状态实时显示（连接中/已连接/断开/重连中）
- 配置自动保存到 chrome.storage
- Session Key 格式：`agent:main:clawtab-{渠道名称}`，channel 为 `webchat`（Web UI 可见）

### F2: 设备配对（✅ 基本实现，待验证）
- 首次连接自动生成 Ed25519 密钥对
- Challenge-Response 签名流程
- 未配对时显示专属配对面板（含设备 ID + 审批命令）
- 配对成功后 deviceToken 持久化，下次直接用
- **待验证**：端到端配对流程、配对后自动重连

### F3: 任务执行引擎（✅ 已实现）
- 接收 Agent 发送的 `task_plan`（多步骤计划）
- 依次执行每个 step，实时推送 `task_step_result`
- 支持的 step 类型：
  - `navigate` — 导航到 URL
  - `execute_js` — 在页面执行 JavaScript
  - `screenshot` — 截取页面 JPEG 截图
  - `get_content` — 获取页面文本 + HTML
  - `wait` — 等待指定毫秒
  - `scroll_to_element` — 滚动到元素
  - `scroll_by` — 滚动指定像素
  - `wait_for` — 等待元素出现
  - `get_text` — 获取元素文本
  - `get_attr` — 获取元素属性
  - `click` — 点击元素
  - `fill` — 填写表单
  - `new_tab` / `close_tab` / `switch_tab` — 标签页管理
  - `go_back` / `go_forward` — 前进/后退
  - `screenshot_element` — 元素截图
  - `clear` — 清空输入框
- 全部完成后推送 `task_result`
- 支持 `task_cancel` 中止

### F4: 互斥占用锁（✅ 已实现）
- 同一时间只有一个 Agent 可以占用浏览器
- 并发请求返回 BUSY + 占用者信息
- 任务完成/失败/取消自动释放

### F5: browser_check 预检（✅ 已实现）
- Agent 发送 `browser_check` 获取浏览器状态
- 返回：浏览器名称、授权状态、是否忙碌、所有标签页列表 + 活跃标签截图

### F6: 中英文 UI（✅ 已实现）
- 右上角齿轮菜单切换中/英文
- 所有 UI 文本通过 data-i18n 机制统一管理

### F7: 配置导入/导出（✅ 已实现）
- 导出为 .clawtab/.json 文件
- 导入后显示配置表单供确认

### F8: 自动重连（✅ 已实现，有条件）
- 连接断开后自动重连，最多 3 次
- 3 次失败后显示配置面板 + 错误提示
- NOT_PAIRED 状态下不触发自动重连（改为配对轮询）

### F9: 连接握手消息（✅ 已实现）
- 连接成功后自动向 clawtab session 发送一条 `deliver:true` 的握手消息
- 消息内容：`🦾 ClawTab 已连接 · {渠道名称} · N 个标签页`
- 效果：Web UI 的会话列表中立即出现该 session，无需手动查找

### F10: 常驻侧边栏聊天（✅ 已实现）
- 连接成功后自动打开 Chrome Side Panel（Chrome 114+ 支持）
- 侧边栏（`sidebar/`）提供完整聊天 UI：
  - **Agent 选择器**：下拉切换 main / dajin / coder 等，每个 agent 独立 session（`agent:{id}:clawtab-{渠道名称}`），切换时历史清空
  - **消息气泡**：用户消息右对齐（紫色），Agent 回复左对齐（白色），支持粗体 / 内联代码 / 换行
  - **clawtab_cmd 摘要行**：Agent 发出的浏览器指令显示为 `⚙️ 感知页面 · 截图` 等紧凑样式，不展示原始 JSON
  - **clawtab_result 隐藏**：内部结果消息不在聊天中显示
  - **轮询**：每 3s 增量拉取新消息，追加不闪屏
  - **发送**：Enter 发送，Shift+Enter 换行；消息通过 `deliver:true` 触发 Agent 响应

### F11: 连接后隐藏设置按钮（✅ 已实现）
- Popup 连接成功状态下，右上角齿轮设置按钮自动隐藏
- 未连接 / 配对等待状态下正常显示

## 待开发功能

### F12: 高级 step 类型
- `hover` — 鼠标悬停
- `drag_drop` — 拖拽
- `select_option` — 下拉选择
- `upload_file` — 文件上传
- `iframe_switch` — iframe 切换
- `keyboard` — 键盘事件（快捷键等）

### F13: 任务队列
- 当前是拒绝并发，未来可以排队等待
- 优先级机制

### F14: 安全增强
- step 执行前的安全检查（危险 URL、恶意 JS 检测）
- 用户确认机制（高风险操作弹窗确认）
- 操作审计日志

## 当前 Bug / 待修复项

| # | 描述 | 状态 |
|---|------|------|
| 1 | UI 闪烁 — NOT_PAIRED 触发 WS 断开 → onclose 重连循环 | ✅ 已修复（pairingPending 不重连） |
| 2 | 配对码不出现 — pairingPending 状态未正确传递到 popup | ✅ 已修复（broadcastStatus 含 pairingPending） |
| 3 | 设置菜单(⚙️)无法弹出 — null DOM 引用崩溃 | ✅ 已修复（popup.js 重写） |
| 4 | statusText 中英文反转 | ✅ 已修复（data-i18n 统一机制） |
| 5 | 配对后端到端通信 | ❓ 待验证 |
| 6 | 工具栏图标显示为 canvas 绘制的"C"而非设计 logo | ✅ 已修复（idle/connected 状态使用 PNG 文件） |
| 7 | Web UI 中找不到 clawtab session | ✅ 已修复（channel 改为 webchat + 握手消息） |

## 技术约束

- **Manifest V3**：Service Worker 生命周期有限，不能长期后台运行，需要 `chrome.alarms` 保活
- **无构建工具**：纯 JS/CSS/HTML，不使用 webpack/vite/TypeScript
- **固定 Extension ID**：通过 manifest.json `key` 字段锁定，不可更改

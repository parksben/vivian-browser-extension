# ClawTab — 需求文档 (PRD)

## 产品定位

ClawTab 是 OpenClaw 生态的浏览器客户端，让 AI Agent 能够：
- **感知**浏览器状态（标签页列表、页面内容、截图）
- **控制**浏览器行为（导航、执行 JS、填表、点击、截图等）

它是 Agent 实现 Web 自动化任务的基础设施。

## 核心功能需求

### F1: Gateway 连接（✅ 已实现）
- 用户输入 Gateway URL + Token + Browser Name
- WebSocket 连接，标准 OpenClaw 握手协议
- 连接状态实时显示（连接中/已连接/断开/重连中）
- 配置自动保存到 chrome.storage

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

## 待开发功能

### F9: Agent 选择器（⏸️ 暂时移除）
- 曾实现过，后来在重构中移除
- 原设计：连接后勾选允许控制浏览器的 Agent 列表
- 如需恢复，参考 git 历史 commit `0146b3f`

### F10: 高级 step 类型
- `hover` — 鼠标悬停
- `drag_drop` — 拖拽
- `select_option` — 下拉选择
- `upload_file` — 文件上传
- `iframe_switch` — iframe 切换
- `keyboard` — 键盘事件（快捷键等）

### F11: 任务队列
- 当前是拒绝并发，未来可以排队等待
- 优先级机制

### F12: 安全增强
- step 执行前的安全检查（危险 URL、恶意 JS 检测）
- 用户确认机制（高风险操作弹窗确认）
- 操作审计日志

### F13: UI/UX 改进
- 连接成功后 header 布局优化（标题居左，状态+按钮居右）
- 任务执行时的进度条/动画
- 历史任务列表
- 错误信息更友好的展示

## 当前 Bug / 待修复项

| # | 描述 | 状态 |
|---|------|------|
| 1 | UI 闪烁 — NOT_PAIRED 触发 WS 断开 → onclose 重连循环 | ✅ 已修复（pairingPending 不重连） |
| 2 | 配对码不出现 — pairingPending 状态未正确传递到 popup | ✅ 已修复（broadcastStatus 含 pairingPending） |
| 3 | 设置菜单(⚙️)无法弹出 — null DOM 引用崩溃 | ✅ 已修复（popup.js 重写） |
| 4 | statusText 中英文反转 | ✅ 已修复（data-i18n 统一机制） |
| 5 | 配对后端到端通信 | ❓ 待验证 |
| 6 | 连接后 header 布局问题 | ❓ 待验证 |

## 技术约束

- **Manifest V3**：Service Worker 生命周期有限，不能长期后台运行，需要 `chrome.alarms` 保活
- **无构建工具**：纯 JS/CSS/HTML，不使用 webpack/vite/TypeScript
- **固定 Extension ID**：通过 manifest.json `key` 字段锁定，不可更改

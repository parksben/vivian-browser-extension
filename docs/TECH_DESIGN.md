# ClawTab — 技术设计

> 记录 ClawTab 扩展的整体架构、关键设计选择以及"为什么这么做"。

## 技术栈

- **纯原生 JS**：无构建步骤、无 npm、无 framework。Chrome MV3 直接加载。
- **唯一 vendor 依赖**：`marked.js`（v15.0.12，bundle 在 `sidebar/lib/`）用于 markdown 渲染。
- **图标**：`shared/icons.js` 内置 Lucide SVG sprite，UI 内任何图标都用其中的 `<use href="#icon-xxx">`。

## 模块划分

| 文件 | 角色 |
|------|------|
| `background.js` | Service Worker：管理 WebSocket、命令轮询、Tab 操作的统一入口 |
| `sidebar/sidebar.js` | 侧边栏 UI（Config + Chat 双页），消息渲染、用户输入 |
| `content/content.js` | 内容脚本：注入到所有页面，承担 DOM 元素拾取 |
| `shared/icons.js` | 跨组件共享的 Lucide 图标 sprite |

三者完全隔离，仅通过 `chrome.runtime.sendMessage` 通信，没有共享内存。

## 连接 / 配对流程

```
用户填配置 → WebSocket 连接 → Ed25519 challenge-response 握手
  → CLI `openclaw devices approve <id>` 完成配对
  → 持久化 deviceToken（下次直接复用）
  → 启动 chat.history 轮询（~3s）
  → 解析 ```json clawtab_cmd ``` → 执行 → 回写 clawtab_result
```

## 消息渲染与去重（重要）

侧边栏轮询 `chat.history` 拉取整段历史（最多 50 条）。这意味着每个轮询周期都会拿到大量"已经渲染过"的消息。如果 dedup 不可靠，UI 会出现"消息无限重复滚动"的现象。

### 设计决策：基于 `msgKey()` 的复合 key 去重

在 `fetchHistory()` 中维护一个 `seenKeys` Set，对每条返回的消息计算一个稳定的 key，已经存在的 key 直接跳过。

`msgKey(m)` 的优先级：

1. **`m.id` 优先**：Gateway 返回了消息 id 时，直接用 `id:<m.id>` 作为 key。这是最准确的方式。
2. **内容 + 角色兜底**：当 `m.id` 缺失（例如握手消息以 `idempotencyKey` 形式发送、Gateway 在 `chat.history` 中可能不返回稳定 id）时，回退到 `c:<role>|<content 前缀>`。

```js
function msgKey(m) {
  if (m.id) return `id:${m.id}`;
  return `c:${m.role}|${msgText(m).slice(0, 300)}`;
}
```

并且在循环里 `seenKeys.add(key)`，这样**同一次响应内**重复的消息也会被去重。

### 为什么不只用 `m.id`

历史教训：之前的 `e04e581` 已经做过纯 id 去重，但生产中仍出现握手消息无限重复刷屏。原因是握手消息 / 部分系统消息在 `chat.history` 中可能不带稳定 id，纯 id dedup 直接漏过。改成 id-or-content 的 key 之后，无论 Gateway 是否补 id，UI 都能稳定收敛。

### 为什么不每次 `renderAll()` 重建 DOM

`renderAll()` 会清空 `#messages` 再重建，会破坏用户当前的滚动位置和选区。坚持"freshMsgs 才 append"的增量渲染，前提是 dedup 必须万无一失，因此把所有保险都堆在 `msgKey` 这个函数里。

### 本地回显

发送消息时先 push 一条 `{ id: 'local-<ts>', role: 'user', ... }`。`fetchHistory` 通过比较 `msgText` 找到对应的服务端消息，**就地替换** `STATE.messages` 中的 local 项以及 DOM 节点，避免出现"local + server"两份。

## Service Worker 易失性

MV3 Service Worker 是临时进程：

- 内存中的 `STATE.*`、`processedCmds` Set、WebSocket 实例都会被清空。
- 因此关键进度全部用 `chrome.storage.local` 持久化：`lastSeenMsgId`、`hs_<sessionKey>`（握手已发送标记）、`deviceToken`、配置项等。

## 握手只发一次（重要）

握手消息（`🦾 ClawTab 已连接 ...`）通过 `chat.send` 发给 Agent，提示其加载 `clawtab_cmd` 协议。在生产中观察到的"握手被发两次"问题来自三处可被同时触发的副作用，本节明确规定它们的行为，避免再次回归。

### 三层防护

1. **持久化标记 `hs_<sessionKey>` 一旦写入就不撤销。**
   - 写入时机：`sendHandshake()` 进入 try 之前就 `chrome.storage.local.set({[hsKey]: true})`。
   - 失败时**不删除**：即使 `wsRequest('chat.send', ...)` 因为 WS 中途掉线、超时而 reject，本地标记保留。原因是 Gateway 可能其实已收到并入库，只是响应丢了；删除标记会让下一次重连再发一遍，触发 Agent 重复回复。
   - 唯一清除时机：用户切换到不同的 `sessionKey`（换 channel name，标记天然按 key 隔离）。即使是 `isNewSession=true`（Gateway 报告全新会话）也**不**清除 —— 否则 Gateway 端的状态抖动会被放大成用户可见的重复消息。

2. **进程内单飞锁 `_handshakeInFlight`。**
   - 防止单个 SW 进程内多个 `connect.ok` 处理函数并发触发 `sendHandshake`：典型场景是 WS 掉线后 `wsScheduleReconnect` 与原 connect-ok 的 `await` 链交错。
   - 进入函数立刻置 `true`，`finally` 重置为 `false`。SW 重启会清空，由第 1 层接力。

3. **进入函数后再读一次 storage 标记。**
   - 覆盖 SW 重启的那一瞬：旧进程刚把 `hs_*` 写入磁盘但还没发出 `chat.send` 就被杀，新进程启动后又走到 `sendHandshake`。再读一次磁盘标记即可识别"已经在处理中或已发出"，直接返回。

### 调用条件统一

`connect.ok` 处理函数里只有一处发握手的入口：

```js
const alreadySent = !!(await chrome.storage.local.get([hsKey]))[hsKey];
if (isNewSession) {
  S.lastSeenMsgId = null;
  await chrome.storage.local.remove([`lsid_${S.sessionKey}`]);
  // 注意：故意不清 hsKey
}
if (!alreadySent && !S.lastSeenMsgId) await sendHandshake();
```

不再像旧版本那样"`isNewSession` 分支无条件重发"，把 Gateway 状态的不确定性挡在客户端这一层。

### 副作用：极端情况下握手可能漏发

如果第一次发送真的失败（例如 Gateway 收到了但 wsRequest 抛错、且 Gateway 也确实没入库），按上述策略我们不会重试，Agent 会缺少协议上下文。这是显式权衡：用户可见的"重复回复"远比"少一次提示"刺眼，且用户可以通过换一个 channel name 重新发起握手。

## 链接打开方式

聊天气泡里的 markdown 链接（裸 URL 或 `[text](url)`）通过两层处理保证"点击 = 在新标签打开"：

1. `sanitizeHtml()` 把所有 `<a>` 强制改写为 `target="_blank" rel="noopener noreferrer"`，并去掉任何已有的 target / rel。
2. `#messages` 容器上挂一个 click 委托，对 `http(s)://` 链接 `preventDefault` 后调用 `chrome.tabs.create({ url, active: true })`。

只用 `target="_blank"` 在 sidepanel 中并不可靠（部分 Chrome 版本会无声吞掉、或试图把 sidepanel 自身导航走），所以两层都要保留。click 委托的 `preventDefault` 也避免了同时触发"target 跳转 + tabs.create"导致重复打开。

## UI 约定

- **双页结构**：Config / Chat，由 `status_update` 消息驱动切换。
- **i18n**：所有可见字符串通过 `data-i18n` 属性 + `applyI18n()`，禁止直接对 `statusText` 等元素 `textContent =`。`applyI18n` 同时支持 `data-i18n-ph`（placeholder）和 `data-i18n-title`（title 提示）。
- **Toolbar 图标**：稳定状态用 PNG，瞬时状态（connecting / perceiving / thinking / acting / failed）用 canvas 现场绘制带颜色的"C"角标。

## 诊断日志（重要）

`background.js` 是日志唯一的写入与持久化点，sidebar / content 通过 `chrome.runtime.sendMessage({type:'log_event'})` 单向推送，由 background 落到统一的 ring buffer。这样无论是哪条上下文产生的事件，最终都汇聚到一个有序时间线，导出时不需要做合并。

### 数据结构

```js
S.logs: Array<{ t: number, level: 'info'|'warn'|'error', src: 'bg'|'sidebar'|'content', msg: string, data?: string }>
```

- `LOG_CAP = 500`，超出时从前面 splice，标准 ring buffer。
- `data` 字段是 `safeSerialize()` 处理过的 JSON 字符串：循环引用降级为 `[circular]`、单字段超过 `LOG_DATA_MAX_CHARS` (600) 自动截断，整个序列化结果再加一道总长上限。**这是为了防止把整张截图 base64 写进日志撑爆 storage**。

### 持久化策略

- `loadLogs()` 在 SW init 时一次性从 `chrome.storage.local.get('diag_logs')` 恢复。
- 每次 `logEvent` 写入后调用 `persistLogsSoon()`：250 ms 防抖写盘。SW 被杀的极端情况下可能丢最近 250 ms 内的日志，但避免了对 storage 的高频写。
- `chrome.storage.local` 单 key 容量 5 MB，500 条 × ≤1.2 KB ≈ 600 KB 上限，留足余量。

### 导出流程

`sidebar` 触发 → `bg({type:'diag_get'})` → background 当场拼装 bundle：

| 字段 | 来源 |
|------|------|
| `state` | `S` 中的连接状态 + loop 状态（最近 16 条 history） |
| `config` | `chrome.storage.local.get(['gatewayUrl','gatewayToken','browserName','deviceToken','manualDisconnect'])`，**先经 `redactConfig()` 抹掉 token / secret / password / key 字段，只保留前 4 + 后 2 字符 + 长度** |
| `logs` | `S.logs.slice()`（直接拷自内存，避开 250 ms 防抖窗） |
| `chatHistory` | 临时打一次 `chat.history` (limit 50)，未连接时为空数组 |

sidebar 拿到 bundle 后由 `formatDiagBundle()` 拼成可读纯文本，浏览器原生下载。

### 为什么不直接共享 `chrome.storage.local`

- 三方上下文（content / sidebar）写 storage 会绕过 `safeSerialize` 的截断逻辑；统一走 background `logEvent` 才能保证 ring buffer 大小可控。
- background 顺带做了 console mirror，开发期间在 SW devtools 里能直接看到，无需先导出再翻文件。

### redactConfig 的覆盖范围

`/token|secret|password|key/i` 命中即 redact。这是宁可错杀的策略，新加配置项时如果命名带这些字眼会被自动遮蔽，避免遗漏导致 token 流出到用户分享的日志包里。

## 已知坑（汇总自 DEVELOPMENT.md）

参见根目录 `CLAUDE.md` 的 "Key Pitfalls" 段，覆盖了 DOM 缓存、握手幂等、`status_update` 状态清理、Ed25519 payload 等关键点。

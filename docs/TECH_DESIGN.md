# ClawTab — 技术设计

> 记录 ClawTab 扩展的整体架构、关键设计选择以及"为什么这么做"。

## 技术栈（迁移中）

目前处于 Phase 3。完成迁移后的目标：**React + TypeScript + Tailwind + Vite + @crxjs/vite-plugin**。
历史上是纯原生 JS、无构建步骤；迁移分阶段推进，每个阶段都能构建出可加载的 `dist/`。详见 `## 迁移路线` 一节。

- **构建**：Vite + `@crxjs/vite-plugin` 处理 MV3 manifest；`pnpm build` 输出 `dist/`，`pnpm build:watch` 重复构建。
- **类型**：严格模式 TypeScript，共享类型放 `src/shared/types/`。
- **Markdown**：`marked.js` 仍然 bundle 在 `sidebar/lib/`（Phase 4 会改 import 形式）。
- **图标**：`shared/icons.js` 内置 Lucide SVG sprite；Phase 4 接入 React 后改用 `lucide-react`。

## 模块划分

| 路径 | 角色 |
|------|------|
| `src/background/index.ts` | Service Worker：管理 WebSocket、命令轮询、Tab 操作的统一入口（从 1590 行的 `background.js` 迁移而来，phase 3） |
| `src/content/index.ts` | 内容脚本：注入到所有页面，承担 DOM 元素拾取（phase 2） |
| `src/shared/types/` | 跨组件共享类型（messages / protocol / state / picker） |
| `src/manifest.ts` | `@crxjs/vite-plugin` 读取的 MV3 manifest 源 |
| `sidebar/sidebar.html`, `sidebar/sidebar.js`, `sidebar/sidebar.css` | **尚未迁移**，phase 4 会替换为 `src/sidebar/` 下的 React 组件树 |
| `shared/icons.js` | SVG sprite，phase 4 后会随 sidebar 一起退役 |

三者通过 `chrome.runtime.sendMessage` 通信，没有共享内存。所有消息体走 `src/shared/types/messages.ts` 的 discriminated union，加新消息类型时 TS 会在 `src/background/index.ts` 的 switch 里报穷举错误。

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

### 清空上下文是握手重发的唯一入口

聊天输入框左侧的"清空上下文"按钮显式触发握手重发。流程在 `sidebar_reset_context` handler：

```
sidebar: 清 STATE.messages / DOM
  ↓ bg({type:'sidebar_reset_context'})
bg: chat.send('/new', deliver=true)      ← 让 agent 侧重置记忆
bg: storage.remove([hs_<sk>, lsid_<sk>]) ← 本地清标记与轮询游标
bg: sendHandshake()                       ← 标记已清，所以这次会真发
```

其他路径（connect.ok、reconnect、SW 重启）仍然按上面的三层防护保持"最多一次"。

## 清空上下文（`/new`）

聊天输入框左侧"新对话"按钮的完整 UX 与数据流：

1. **仅在已连接时可用**（按 `STATE.wsConnected` 联动 disabled，与拾取按钮的启用逻辑复用同一个 `updateStatus()`）。
2. **点击 → confirm**（国际化文案 `clearContextConfirm`）。用户确认后执行重置。
3. **sidebar 本地清理**：`STATE.messages`、`STATE.lastMsgId`、`STATE.pendingEchoContent`、`STATE.waiting` 一次性清掉；隐藏 thinking indicator；`renderAll()` 重绘为"空会话"占位态。
4. **调用 `sidebar_reset_context`**：由 background 负责三件事（保持原子 —— 前两步一个也不能漏）：
   1. `chat.send` 消息体 `"/new"`，`deliver:true`，由 Gateway 识别为 slash command 重置该 session。
   2. `chrome.storage.local.remove([hs_<sk>, lsid_<sk>])`。
   3. `sendHandshake()` 再走一遍（此时 hs 标记已清，`sendHandshake` 内部的 storage 再检查 → miss → 真发）。
5. **渲染过滤**：`/new` 自己会出现在 `chat.history` 里，但 `buildMsgNode` 和 `renderAll` 的 `visible` filter 都会跳过 `role === 'user' && text.trim() === '/new'`，不在 UI 上渲染这条"基础设施消息"。
6. 用户可见的结果：点完之后先是空白，短暂延迟后出现新的"🦾 ClawTab 已连接…"气泡 + agent 对握手的回复，工具立即可用。

### 为什么清空 UI 这一步必须走在 `/new` 之前

先清 UI + 先清 `lastMsgId`，意味着接下来 polling 拉回来的 `/new` 和新握手都会当成"新消息"去 append，而不是被旧的 seenKeys 拦下来。顺序反过来会看到"旧消息还在界面上、新握手被 dedup 掉"。

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

---

## 迁移路线：React + TypeScript + Tailwind + Vite

项目当前是纯原生 JS（~4500 LOC，无构建步骤）。这一节记录向 React/TS/Tailwind/Vite 技术栈迁移的 **10 阶段路线图**，以及每个阶段的范围与退出条件。

### 关键原则

1. **用户不可见变更之前的每一步都是 docs-first**：先更 `REQUIREMENTS.md` / `TECH_DESIGN.md`，后改代码。
2. **每个 phase 结束都是可加载、可运行的扩展**：
   - Phase 1 起 `pnpm build` 产出 `dist/`，`Load unpacked → dist/` 可用。
   - 根目录旧文件**一直保留到 Phase 7**，所以老方式（直接 Load unpacked 仓库根目录）在迁移中途仍然能跑，GitHub zip 下载链接不会断。
3. **关键不变式原样搬运**（CLAUDE.md 的 Key Pitfalls 与本文件前面小节的设计）：
   - 握手三层防护（进程锁 + storage 标记 + 进入后再检查），错误时绝不删标记。
   - `connect.ok` 单 gate `!alreadySent && !lastSeenMsgId`，`isNewSession=true` 分支不清握手标记。
   - `fetchHistory` 的 `msgKey` 去重（id 优先 + content fallback）。
   - `isHiddenInfraMsg` 过滤 `/new`。
   - 链接通过 `chrome.tabs.create` 打开，不能仅靠 `target="_blank"`。
   - SW 易失性 + `chrome.storage.local` 持久化策略。
4. **Lucide-only**：用 `lucide-react` 命名导入，禁止混入其他 icon 库。
5. **小步提交**：每个 phase 一次 `git push`，README 的 zip 下载链接随时可用。

### 技术栈决定

- **Vite 6** + `@vitejs/plugin-react` + **`@crxjs/vite-plugin@^2.0.0-beta`**：目前唯一能正确处理 MV3 Service Worker `type:"module"` + sidepanel 的构建方案，替代品（rollup-plugin-chrome-extension）已停维护。
- **React 19** + **TypeScript 5.6 strict**。
- **Tailwind v3**（不上 v4 —— 扩展场景里 v4 的 CSS layer 语义仍有 quirks）。
- **lucide-react**：tree-shake 友好，命名导入。
- **状态管理**：`useReducer` + 一个 Context 就够，不上 Zustand/Redux —— state 拆下来约 8–12 个 action。
- **Tooltip**：自研 ~50 行（`position:fixed` + `getBoundingClientRect()` + 边缘翻转），不引 radix-ui（sidepanel 包体敏感）。
- **测试**：只对 `reducer.ts` / `msgKey` / `isHiddenInfraMsg` / `safeSerialize` 这几个纯函数加 Vitest，防止"握手重复"那类 bug 回归。不写组件测试。

### 10 阶段节奏

| Phase | 范围 | 退出条件 |
|-------|------|----------|
| 0 ✅ | **docs-only**：本路线图写入 `TECH_DESIGN.md`，`CLAUDE.md` 加一段"迁移进行中"提示。 | 代码零改动。 |
| 1 ✅ | **脚手架**：`package.json` / `tsconfig.json` / `vite.config.ts` / `src/manifest.ts` / `.gitignore`。`@crxjs` 指向**现有**的 `background.js` / `sidebar/*` / `content/*` / `shared/*`。 | `pnpm build` 产出 `dist/`，Load unpacked `dist/` 行为 = Load unpacked 根目录。 |
| 2 | **`content.js` + `shared/types` 迁 TS**。老 `shared/icons.js` 仍通过 `publicDir` 拷给旧 sidebar。 | content 脚本是 `.ts`，其他不变，扩展行为不变。 |
| 3 | **background.js 模块化迁 TS**（最高风险）。按现有 SECTION 切文件，握手三层防护原样保留。 | 12 个测试流程全部通过：冷连接、WS 掉线重连、SW 手动 Terminate、`/new`、配对、日志导出、拾取+发送、任务取消、agent 切换、SW 重启冷启动、Gateway 掉线恢复、连续快速 connect/disconnect。 |
| 4 | **接入 Tailwind**，老 `sidebar.css` 仍生效。 | 产物体积变化可忽略。 |
| 5 | **React 外壳接管页面路由**，页面内容暂用 `dangerouslySetInnerHTML` 保留旧 HTML，`status_update` 驱动 `Config \| Pairing \| Chat` 页面切换走 `useReducer`。 | sidebar 挂载方式变了但看起来一样。 |
| 6 | **ChatPage 组件化**：`ChatHeader` / `MessageList` / `MessageBubble` / `ToolRow` / `ThinkingIndicator` / `EmptyState` / `TaskBar` / `Lightbox`。`fetchHistory` + `msgKey` dedup + `pendingEchoContent` echo-replace 原样搬进 reducer，配 Vitest。 | 聊天、去重、链接新标签打开全部 OK。 |
| 7 | **ConfigPage + InputArea + 拾取 + 清空上下文 + 诊断**组件化，**删除**老 `sidebar/` + `shared/icons.js` + 根目录 `background.js` / `manifest.json` / `content/`。根目录只留 docs + 构建配置。 | Phase 3 的 12 项测试再跑一遍。 |
| 8 | **UI 改进**：Tooltip primitive、所有 icon-only 按钮加 tooltip、语言切换改 Globe 图标+动态目标语言 tooltip。 | REQUIREMENTS.md 记录按钮清单与文案。 |
| 9 | **收尾**：`CLAUDE.md` 里"旧工作流"注释删掉，README 改成 `pnpm build --watch`，包体审计（期望 sidebar JS <300 KB）。 | 迁移结束。 |

### Phase 1 实现注记：`passThroughLegacyFiles` 插件

当前 `sidebar/sidebar.html` 里的三个 `<script>` 标签（`lib/marked.min.js` / `../shared/icons.js` / `sidebar.js`）都是没有 `type="module"` 的传统脚本。Vite 默认只处理 ES module script，对非 module 脚本会打印警告、保留 HTML 里的 `<script src>` 引用、**但不会把被引用的文件拷进 `dist/`**。结果是 `dist/sidebar/sidebar.html` 引用了一堆不存在的路径。

`vite.config.ts` 里 `passThroughLegacyFiles()` 这个 custom plugin 就是为 Phase 1 设计的过渡件：在 `generateBundle` 钩子里直接 `readFileSync` 三个文件再 `emitFile` 回 `dist/` 的原始路径，HTML 的相对 `<script src>` 能解析到。

这三个文件分别在 Phase 7（`sidebar.js`、`marked.min.js`）和 Phase 7（`shared/icons.js`）被 React 版彻底取代，届时这个 plugin 连同它 watch 的 3 个路径一起删除。

### 本阶段（Phase 0）就是这一节本身

这一段写入即完成 Phase 0，不改动任何代码文件。下一 commit（Phase 1）加构建工具链，**不动任何现有业务代码**。

### 关于 zip 下载链接

整个迁移过程中 `https://github.com/parksben/clawtab/archive/refs/heads/main.zip` **始终可用**：
- Phase 1–6：根目录仍然是一份完整、独立的老 JS 扩展，可直接 Load unpacked。
- Phase 7 之后：zip 解压后需要 `pnpm install && pnpm build`，然后 Load unpacked 解压出的 `dist/`。Phase 7 的 commit message + README 会明确这一切换点。

### 风险与开放问题

1. **`chrome.sidePanel` HMR 未必稳定**：Vite 的 HMR WebSocket 可能跟 sidepanel 的 CSP + @crxjs 注入的桥 iframe 合不来。退路：`vite build --watch` + 手动 reload 扩展，仍是一次点击。
2. **SW module quirks**：`type: "module"` 下 Chrome 对相对路径和 `import()` 很敏感，所有 SW 代码只用 top-level 静态 import。
3. **Tailwind 动态 class 被 purge**：所有条件 class 必须走 `clsx(...)`，禁止字符串拼接（如 `\`bg-${color}\``）。
4. **content.js 不能用 Tailwind**：host 页面没加载 Tailwind CSS，`content/` 下的所有样式必须保留为 inline `cssText` 或 `element.style.*`。
5. **lucide-react 必须命名导入** `{ Globe }`，禁 `import * as Icons`，否则 tree-shake 失效。
6. **IndexedDB 数据库名 `clawtab-v2` 不能改**：否则现有用户的 Ed25519 设备密钥丢失、会被迫重新配对。

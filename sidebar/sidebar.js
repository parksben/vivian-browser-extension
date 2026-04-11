/**
 * ClawTab sidebar.js
 * Chat UI for communicating with OpenClaw agents via the clawtab session.
 */

// ── I18N ───────────────────────────────────────────────────────────────────

const SB_I18N = {
  en: {
    connected:    'Connected',
    disconnected: 'Not connected',
    reconnecting: 'Reconnecting…',
    placeholderOn:  'Message… (⌘/Ctrl+Enter to send)',
    placeholderOff: 'Connect OpenClaw in the extension popup first',
    placeholderReconnecting: 'Reconnecting, please wait…',
    emptyConnect: 'Connect OpenClaw in the extension popup first',
    emptyChat:    'Send a message to {agent} to start chatting',
  },
  zh: {
    connected:    '已连接',
    disconnected: '未连接',
    reconnecting: '重连中…',
    placeholderOn:  '发消息… (⌘/Ctrl+Enter 发送)',
    placeholderOff: '请先在插件中连接 OpenClaw',
    placeholderReconnecting: '重连中，请稍候…',
    emptyConnect: '请先在插件面板中连接 OpenClaw',
    emptyChat:    '向 {agent} 发消息，开始对话',
  },
};

let sbLang = 'zh';
const sbt = key => SB_I18N[sbLang]?.[key] ?? SB_I18N.zh[key] ?? key;

// ── State ──────────────────────────────────────────────────────────────────

const STATE = {
  wsConnected:        false,
  reconnecting:       false,
  channelName:        '',
  selectedAgent:      'main',
  lastMsgId:          null,
  messages:           [],
  pollTimer:          null,   // setTimeout handle for adaptive polling
  sending:            false,
  waiting:            false,  // true while waiting for agent reply
  waitingTimer:       null,   // safety-timeout handle
  pendingEchoContent: null,   // text of the local echo pending server confirmation
  pickMode:           false,
  attachments:        [],     // [{ tag, id, classes, text, selector }]
  activeTabId:        null,
  tabStates:          {},     // { [tabId]: { input, attachments } }
};

// Default agent list (overridden if agents.list API works)
const DEFAULT_AGENTS = ['main', 'dajin', 'coder', 'wechat-new', 'biz-coder'];

// ── Helpers ────────────────────────────────────────────────────────────────

function sessionKey() {
  return `agent:${STATE.selectedAgent}:clawtab-${STATE.channelName}`;
}

function bg(msg) {
  return chrome.runtime.sendMessage(msg);
}

function msgText(msg) {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content))
    return msg.content.filter(b => b.type === 'text').map(b => b.text || '').join('');
  if (msg.blocks)
    return msg.blocks.filter(b => b.type === 'text').map(b => b.text || '').join('');
  return '';
}

/** Extract JSON payload from a ```json ... ``` fenced block */
function extractJsonBlock(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/** Extract tool_use content blocks from a message */
function extractToolCalls(msg) {
  const blocks = Array.isArray(msg.content) ? msg.content
               : Array.isArray(msg.blocks)  ? msg.blocks : [];
  return blocks.filter(b => b.type === 'tool_use');
}

/**
 * Returns true when an assistant message represents the end of a turn:
 * - Regular text response (not just tool calls)
 * - clawtab_cmd with a terminal action (task_done / task_fail / cancel)
 * Pure tool calls (clawtab_cmd act/perceive, tool_use blocks) are NOT terminal
 * because the agent is still in the middle of executing something.
 */
function isTerminalMsg(m) {
  if (m.role !== 'assistant') return false;
  const text = msgText(m);
  const json = extractJsonBlock(text);
  if (json?.type === 'clawtab_cmd') {
    return ['task_done', 'task_fail', 'cancel'].includes(json.action);
  }
  const cleaned = text.replace(/```json[\s\S]*?```/g, '').trim();
  if (cleaned) return true;                   // has visible text → final reply
  return extractToolCalls(m).length === 0;    // empty message → treat as terminal
}

/** Summarise a clawtab_cmd action for display — returns HTML string */
function summariseCmd(cmd) {
  const iconMap = {
    perceive:   'eye',
    act:        'mouse-pointer',
    task_start: 'settings',
    task_done:  'settings',
    task_fail:  'alert-triangle',
    cancel:     'power-off',
  };
  const labelMap = {
    perceive:   '感知页面',
    act:        '操作页面',
    task_start: '任务开始',
    task_done:  '任务完成',
    task_fail:  '任务失败',
    cancel:     '已取消',
  };
  const opMap = {
    navigate:   '导航',
    click:      '点击',
    fill:       '填写',
    screenshot: '截图',
    scroll:     '滚动',
    eval:       '执行脚本',
    get_text:   '读取文本',
    new_tab:    '新标签页',
    close_tab:  '关闭标签页',
  };
  const op = cmd.payload?.op;
  const ic    = iconMap[cmd.action]  || 'settings';
  const base  = labelMap[cmd.action] || esc(cmd.action);
  const detail = op ? (opMap[op] || esc(op)) : '';
  return `${icon(ic, 13)} ${base}${detail ? ' · ' + detail : ''}`;
}

/** Summarise a tool_use content block — returns HTML string */
function summariseToolCall(tc) {
  const name = esc(tc.name || tc.id || 'tool');
  const input = tc.input || {};
  const skip = new Set(['code','content','text','html','script','query']);
  const preview = Object.entries(input)
    .filter(([k]) => !skip.has(k))
    .slice(0, 2)
    .map(([k, v]) => `${esc(k)}: ${esc(String(v).slice(0, 40))}`)
    .join(' · ');
  return `${icon('settings', 13)} ${name}${preview ? ' · ' + preview : ''}`;
}

/** Escape HTML */
const esc = s => String(s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

marked.setOptions({ gfm: true, breaks: true });

function sanitizeHtml(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[\s\S]*?>/gi, '')
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
    .replace(/href\s*=\s*["']?\s*javascript:[^"'\s>]*/gi, 'href="#"');
}

/** Full GFM markdown → sanitized HTML via marked */
function formatText(raw) {
  if (!raw) return '';
  try { return sanitizeHtml(marked.parse(String(raw))); }
  catch (_) { return esc(raw).replace(/\n/g, '<br>'); }
}

// ── Thinking indicator ────────────────────────────────────────────────────

function showThinking() {
  hideThinking(); // avoid duplicates
  const el = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'sb-thinking';
  div.id = 'thinkingIndicator';
  div.innerHTML = `<span class="sb-thinking-dots"><span></span><span></span><span></span></span>`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function hideThinking() {
  const el = document.getElementById('thinkingIndicator');
  if (el) el.remove();
}

function updateSendBtn() {
  const btn = document.getElementById('sendBtn');
  if (btn) btn.disabled = !STATE.wsConnected || STATE.waiting;
}

// ── Element picker ─────────────────────────────────────────────────────────

function togglePickMode() {
  if (STATE.pickMode) {
    STATE.pickMode = false;
    document.getElementById('pickBtn')?.classList.remove('active');
    bg({ type: 'exit_pick_mode' }).catch(() => {});
  } else {
    STATE.pickMode = true;
    document.getElementById('pickBtn')?.classList.add('active');
    bg({ type: 'enter_pick_mode' }).catch(() => {});
  }
}

function exitPickModeUI() {
  if (!STATE.pickMode) return;
  STATE.pickMode = false;
  document.getElementById('pickBtn')?.classList.remove('active');
}

function formatAttachLabel(a, i) {
  return `#${i + 1}:${a.tag}`;
}

function attachTooltip(a) {
  const idPart  = a.id ? `#${a.id}` : '';
  const clsPart = !a.id && a.classes.length ? `.${a.classes.join('.')}` : '';
  const txtPart = a.text ? `\n"${a.text.slice(0, 60)}"` : '';
  return `${a.tag}${idPart}${clsPart}${txtPart}\n${a.selector}`;
}

function renderAttachments() {
  const el = document.getElementById('attachments');
  if (!el) return;
  el.innerHTML = '';
  for (let i = 0; i < STATE.attachments.length; i++) {
    const a = STATE.attachments[i];
    const tag = document.createElement('span');
    tag.className = 'sb-attach-tag';
    tag.title = attachTooltip(a);
    tag.innerHTML =
      `<span class="sb-attach-tag-label">${esc(formatAttachLabel(a, i))}</span>` +
      `<button class="sb-attach-tag-del" data-idx="${i}" title="移除">×</button>`;
    tag.addEventListener('click', (e) => {
      if (e.target.closest('.sb-attach-tag-del')) return;
      bg({ type: 'flash_element', selector: a.selector }).catch(() => {});
    });
    el.appendChild(tag);
  }
  el.querySelectorAll('.sb-attach-tag-del').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx, 10);
      STATE.attachments.splice(idx, 1);
      renderAttachments();
      showPickAutocomplete();
    });
  });
}

// ── Autocomplete for #n:tag references ────────────────────────────────────

let _acActiveIdx = -1;

function getAutocompleteContext(input) {
  const before = input.value.slice(0, input.selectionStart);
  const m = before.match(/#([\w:]*)$/);
  if (!m) return null;
  return { hashStart: input.selectionStart - m[0].length, typed: m[1] };
}

function showPickAutocomplete() {
  const input    = document.getElementById('msgInput');
  const dropdown = document.getElementById('pickAutocomplete');
  if (!dropdown || !STATE.attachments.length) { hidePickAutocomplete(); return; }

  const ctx = getAutocompleteContext(input);
  if (!ctx) { hidePickAutocomplete(); return; }

  const options = STATE.attachments
    .map((a, i) => formatAttachLabel(a, i))          // '#1:div', '#2:span' …
    .filter(label => label.startsWith('#' + ctx.typed));

  if (!options.length) { hidePickAutocomplete(); return; }

  _acActiveIdx = -1;
  dropdown.innerHTML = '';
  for (const label of options) {
    const item = document.createElement('div');
    item.className = 'sb-autocomplete-item';
    item.textContent = label;
    item.dataset.value = label;
    item.addEventListener('mousedown', e => {
      e.preventDefault(); // keep focus in textarea
      selectAutocomplete(label);
    });
    dropdown.appendChild(item);
  }
  dropdown.style.display = 'block';
}

function hidePickAutocomplete() {
  const dropdown = document.getElementById('pickAutocomplete');
  if (dropdown) { dropdown.style.display = 'none'; _acActiveIdx = -1; }
}

function selectAutocomplete(label) {
  const input = document.getElementById('msgInput');
  const ctx   = getAutocompleteContext(input);
  if (!ctx) return;
  const val    = input.value;
  const newVal = val.slice(0, ctx.hashStart) + label + val.slice(input.selectionStart);
  input.value  = newVal;
  const newPos = ctx.hashStart + label.length;
  input.setSelectionRange(newPos, newPos);
  hidePickAutocomplete();
}

// ── Tab state save/restore ─────────────────────────────────────────────────

function saveTabState(tabId) {
  if (tabId == null) return;
  const input = document.getElementById('msgInput')?.value || '';
  STATE.tabStates[tabId] = { input, attachments: [...STATE.attachments] };
}

function restoreTabState(tabId) {
  const saved = STATE.tabStates[tabId];
  const input = document.getElementById('msgInput');
  if (saved) {
    if (input) { input.value = saved.input; input.style.height = ''; }
    STATE.attachments = [...saved.attachments];
  } else {
    if (input) { input.value = ''; input.style.height = ''; }
    STATE.attachments = [];
  }
  renderAttachments();
}

// ── Render ─────────────────────────────────────────────────────────────────

function renderAll() {
  const el = document.getElementById('messages');

  if (!STATE.wsConnected) {
    el.innerHTML = `
      <div class="sb-empty">
        <div class="sb-empty-icon">${icon('message-square', 40)}</div>
        <div>${sbt('emptyConnect')}</div>
      </div>`;
    return;
  }

  // Filter: keep only displayable messages
  const visible = STATE.messages.filter(m => {
    const text = msgText(m);
    const json = extractJsonBlock(text);
    if (json?.type === 'clawtab_result') return false; // hide internal browser results
    if (text.trim()) return true;
    return extractToolCalls(m).length > 0; // tool_use-only messages are visible
  });

  if (visible.length === 0) {
    el.innerHTML = `
      <div class="sb-empty">
        <div class="sb-empty-icon">${icon('message-square', 40)}</div>
        <div>${sbt('emptyChat').replace('{agent}', `<strong>${STATE.selectedAgent}</strong>`)}</div>
      </div>`;
    return;
  }

  el.innerHTML = '';
  for (const msg of visible) {
    const node = buildMsgNode(msg);
    if (node) el.appendChild(node);
  }

  // Scroll to bottom
  el.scrollTop = el.scrollHeight;
}

function buildMsgNode(msg) {
  const role = msg.role === 'user' ? 'user' : 'assistant';
  const text = msgText(msg);
  const toolCalls = extractToolCalls(msg);

  // clawtab_cmd JSON block → single tool summary row
  const json = extractJsonBlock(text);
  if (json?.type === 'clawtab_cmd') {
    const row = document.createElement('div');
    row.className = 'sb-tool-row';
    row.innerHTML = summariseCmd(json);
    return row;
  }

  // Tool-use-only message (no text, only tool_use blocks)
  if (!text.trim() && toolCalls.length) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:contents';
    for (const tc of toolCalls) {
      const row = document.createElement('div');
      row.className = 'sb-tool-row';
      row.innerHTML = summariseToolCall(tc);
      wrap.appendChild(row);
    }
    return wrap;
  }

  // Regular message — strip json fenced blocks then render
  const cleaned = text.replace(/```json[\s\S]*?```/g, '').trim();
  if (!cleaned && !toolCalls.length) return null;

  const wrap = document.createElement('div');
  wrap.className = `sb-msg ${role}`;

  const body = document.createElement('div');
  body.className = 'sb-msg-body';

  if (cleaned) {
    const bubble = document.createElement('div');
    bubble.className = 'sb-bubble markdown';
    bubble.innerHTML = formatText(cleaned);
    body.appendChild(bubble);
  }

  // Any tool_use blocks from content array shown below the text bubble
  for (const tc of toolCalls) {
    const row = document.createElement('div');
    row.className = 'sb-tool-row';
    row.innerHTML = summariseToolCall(tc);
    body.appendChild(row);
  }

  // Inline attachment tags below user messages
  if (role === 'user' && msg.attachments?.length) {
    const tagsDiv = document.createElement('div');
    tagsDiv.className = 'sb-msg-attachments';
    msg.attachments.forEach((a, i) => {
      const tag = document.createElement('span');
      tag.className = 'sb-attach-tag sb-attach-tag--inline';
      tag.title = attachTooltip(a);
      tag.innerHTML = `<span class="sb-attach-tag-label">${esc(formatAttachLabel(a, i))}</span>`;
      tag.addEventListener('click', () => {
        bg({ type: 'flash_element', selector: a.selector }).catch(() => {});
      });
      tagsDiv.appendChild(tag);
    });
    body.appendChild(tagsDiv);
  }

  wrap.appendChild(body);
  return wrap;
}

function appendErrorNode(text) {
  const el = document.getElementById('messages');
  const emptyEl = el.querySelector('.sb-empty');
  if (emptyEl) el.innerHTML = '';
  const node = document.createElement('div');
  node.className = 'sb-send-error';
  node.textContent = text;
  el.appendChild(node);
  el.scrollTop = el.scrollHeight;
}

function appendMsgNode(msg) {
  const el = document.getElementById('messages');
  const emptyEl = el.querySelector('.sb-empty');
  if (emptyEl) el.innerHTML = ''; // clear empty state on first real message
  const node = buildMsgNode(msg);
  if (node) {
    el.appendChild(node);
    el.scrollTop = el.scrollHeight;
  }
}

// ── Polling ────────────────────────────────────────────────────────────────

function startPolling() {
  stopPolling();
  schedulePoll(0);
}

function stopPolling() {
  clearTimeout(STATE.pollTimer);
  STATE.pollTimer = null;
}

// Adaptive: 1 s while waiting for a reply, 3 s otherwise.
function schedulePoll(ms) {
  STATE.pollTimer = setTimeout(async () => {
    STATE.pollTimer = null;
    await fetchHistory();
    if (STATE.wsConnected && STATE.channelName) {
      schedulePoll(STATE.waiting ? 1000 : 3000);
    }
  }, ms);
}

async function fetchHistory() {
  if (!STATE.wsConnected || !STATE.channelName) return;
  try {
    const res = await bg({
      type:       'sidebar_fetch_history',
      sessionKey: sessionKey(),
      after:      STATE.lastMsgId,
    });
    if (!res?.ok) {
      console.warn('[Sidebar] fetchHistory failed:', res?.error);
      return;
    }
    if (!res.messages?.length) return;

    // Collect new messages and advance cursor
    const freshMsgs = [];
    for (const m of res.messages) {
      STATE.lastMsgId = m.id;
      freshMsgs.push(m);
    }

    // ── Local echo dedup ────────────────────────────────────────────────
    // If the server echoes back our pending local message, replace the
    // optimistic DOM node with the confirmed server version instead of
    // appending a duplicate.
    if (STATE.pendingEchoContent !== null) {
      const idx = freshMsgs.findIndex(
        m => m.role === 'user' && msgText(m) === STATE.pendingEchoContent
      );
      if (idx !== -1) {
        // Replace local entry in STATE.messages with server-confirmed version
        const localIdx = STATE.messages.findIndex(m => m.id?.startsWith('local-'));
        if (localIdx !== -1) STATE.messages[localIdx] = freshMsgs[idx];
        else                 STATE.messages.push(freshMsgs[idx]);
        // Swap out the pending DOM node (keeps visual position)
        const echoNode = document.querySelector('[data-local-echo]');
        if (echoNode) {
          const server = buildMsgNode(freshMsgs[idx]);
          if (server) echoNode.replaceWith(server);
          else        echoNode.remove();
        }
        freshMsgs.splice(idx, 1); // consumed — don't append again
        STATE.pendingEchoContent = null;
      }
    }
    // ───────────────────────────────────────────────────────────────────

    STATE.messages.push(...freshMsgs);

    // Clear waiting only when a terminal assistant message arrives
    // (not on mid-task tool calls / browser commands)
    if (STATE.waiting && freshMsgs.some(isTerminalMsg)) {
      STATE.waiting = false;
      clearTimeout(STATE.waitingTimer);
      hideThinking();
      updateSendBtn();
    }

    // Incremental append — no full re-render flicker
    const el = document.getElementById('messages');
    const emptyEl = el.querySelector('.sb-empty');
    if (emptyEl) el.innerHTML = '';
    for (const m of freshMsgs) {
      const node = buildMsgNode(m);
      if (node) el.appendChild(node);
    }
    el.scrollTop = el.scrollHeight;
  } catch (_) {}
}

// ── Send ───────────────────────────────────────────────────────────────────

async function sendMessage() {
  const input = document.getElementById('msgInput');
  const text  = input.value.trim();
  if (!text || !STATE.wsConnected || STATE.sending || STATE.waiting) return;

  STATE.sending = true;
  const btn = document.getElementById('sendBtn');
  btn.disabled = true;
  input.value  = '';
  input.style.height = '';

  // Build message text, appending element reference context as a JSON block.
  // Background's sendResult uses the same ```json``` convention, so OpenClaw's
  // agent pipeline already knows how to extract selector + screenshot from it.
  let fullText = text;
  if (STATE.attachments.length > 0) {
    const refs = STATE.attachments.map((a, i) => {
      const ref = { ref: formatAttachLabel(a, i), selector: a.selector, tag: a.tag };
      if (a.text)       ref.text       = a.text.slice(0, 80);
      if (a.screenshot) ref.screenshot = a.screenshot;  // base64 JPEG data URL
      return ref;
    });
    fullText += '\n\n```json\n' +
      JSON.stringify({ type: 'element_refs', refs }, null, 2) +
      '\n```';
  }

  // Clear attachments immediately on send (save copy for bubble)
  const sentAttachments = [...STATE.attachments];
  STATE.attachments = [];
  renderAttachments();

  // Optimistic local echo (show original text only, not the appended context)
  const localMsg = { id: `local-${Date.now()}`, role: 'user', content: text, attachments: sentAttachments };
  STATE.messages.push(localMsg);
  appendMsgNode(localMsg);
  // Mark the DOM node so fetchHistory can find and replace it
  const echoNode = document.getElementById('messages').lastElementChild;
  if (echoNode) echoNode.dataset.localEcho = '1';
  STATE.pendingEchoContent = text; // track for server-echo dedup

  try {
    const res = await bg({
      type:       'sidebar_ensure_and_send',
      sessionKey: sessionKey(),
      message:    fullText,
    });
    if (!res?.ok) {
      // Send failed — show inline error, don't enter waiting state
      STATE.pendingEchoContent = null; // nothing was sent, dedup not needed
      const errMsg = res?.error || '未知错误，请检查连接后重试';
      const detail = res?.code ? ` [${res.code}]` : '';
      console.warn('[Sidebar] send failed:', errMsg, res?.code || '');
      appendErrorNode(errMsg + detail);
      return; // finally block will re-enable the send button
    }
    // Show thinking indicator and lock send until agent replies
    STATE.waiting = true;
    updateSendBtn();
    showThinking();
    // Safety timeout: auto-clear after 60 s and surface an error
    clearTimeout(STATE.waitingTimer);
    STATE.waitingTimer = setTimeout(() => {
      if (!STATE.waiting) return;
      STATE.waiting = false;
      hideThinking();
      updateSendBtn();
      appendErrorNode('Agent 未在 60 秒内响应，请检查连接或重试');
    }, 60000);
  } catch (e) {
    STATE.pendingEchoContent = null;
    console.warn('[Sidebar] send exception:', e.message);
    appendErrorNode('发送异常：' + e.message);
  } finally {
    STATE.sending = false;
    if (!STATE.waiting) updateSendBtn();
  }
}

// ── Status ─────────────────────────────────────────────────────────────────

function updateStatus() {
  const dot       = document.getElementById('statusDot');
  const text      = document.getElementById('statusText');
  const input     = document.getElementById('msgInput');
  const inputArea = document.querySelector('.sb-input-area');
  const pickBtn   = document.getElementById('pickBtn');

  if (STATE.wsConnected) {
    dot.className     = 'sb-status-dot connected';
    text.textContent  = sbt('connected');
    input.disabled    = false;
    input.placeholder = sbt('placeholderOn');
    inputArea?.classList.remove('sb-disconnected');
    if (pickBtn) pickBtn.disabled = false;
  } else if (STATE.reconnecting) {
    dot.className     = 'sb-status-dot connecting';
    text.textContent  = sbt('reconnecting');
    input.disabled    = true;
    input.placeholder = sbt('placeholderReconnecting');
    inputArea?.classList.add('sb-disconnected');
    if (pickBtn) pickBtn.disabled = true;
  } else {
    dot.className     = 'sb-status-dot';
    text.textContent  = sbt('disconnected');
    input.disabled    = true;
    input.placeholder = sbt('placeholderOff');
    inputArea?.classList.add('sb-disconnected');
    if (pickBtn) pickBtn.disabled = true;
  }
  updateSendBtn();
}

// ── Agent selector ─────────────────────────────────────────────────────────

async function loadAgents() {
  const sel = document.getElementById('agentSelect');
  sel.innerHTML = '';

  let agents = DEFAULT_AGENTS;
  try {
    const res = await bg({ type: 'sidebar_list_agents' });
    if (res?.agents?.length > 0) {
      agents = res.agents.map(a => (typeof a === 'string' ? a : a.id || String(a)));
    }
  } catch (_) {}

  for (const a of agents) {
    const opt = document.createElement('option');
    opt.value = a; opt.textContent = a;
    if (a === STATE.selectedAgent) opt.selected = true;
    sel.appendChild(opt);
  }
}

function switchAgent(newAgent) {
  if (newAgent === STATE.selectedAgent) return;
  STATE.selectedAgent = newAgent;
  STATE.messages      = [];
  STATE.lastMsgId     = null;
  STATE.waiting       = false;
  clearTimeout(STATE.waitingTimer);
  hideThinking();
  stopPolling();
  updateSendBtn();
  renderAll();
  if (STATE.wsConnected) {
    fetchHistory();
    startPolling();
  }
}

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  // Load language setting from storage (shared with popup)
  try {
    const stored = await chrome.storage.local.get('lang');
    if (stored.lang) sbLang = stored.lang;
  } catch (_) {}

  await loadAgents();

  try {
    const s = await bg({ type: 'get_status' });
    if (s) {
      STATE.wsConnected  = s.wsConnected  || false;
      STATE.reconnecting = s.reconnecting || false;
      STATE.channelName  = s.browserId    || '';
    }
  } catch (_) {}

  // Track which tab is currently active for input/attachment state persistence
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) STATE.activeTabId = tab.id;
  } catch (_) {}

  updateStatus();
  renderAll();

  if (STATE.wsConnected && STATE.channelName) {
    await fetchHistory();
    startPolling();
  }
}

// ── Event listeners ────────────────────────────────────────────────────────

document.getElementById('sendBtn').addEventListener('click', sendMessage);

document.getElementById('pickBtn').addEventListener('click', () => {
  if (!STATE.wsConnected) return;
  togglePickMode();
});

document.getElementById('msgInput').addEventListener('keydown', e => {
  const dropdown = document.getElementById('pickAutocomplete');
  const open = dropdown && dropdown.style.display !== 'none';

  if (open) {
    const items = [...dropdown.querySelectorAll('.sb-autocomplete-item')];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _acActiveIdx = Math.min(_acActiveIdx + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('active', i === _acActiveIdx));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      _acActiveIdx = Math.max(_acActiveIdx - 1, 0);
      items.forEach((el, i) => el.classList.toggle('active', i === _acActiveIdx));
      return;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.metaKey && !e.ctrlKey)) {
      if (_acActiveIdx >= 0 && items[_acActiveIdx]) {
        e.preventDefault();
        selectAutocomplete(items[_acActiveIdx].dataset.value);
        return;
      }
      // Tab with no selection: pick first option
      if (e.key === 'Tab' && items.length) {
        e.preventDefault();
        selectAutocomplete(items[0].dataset.value);
        return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hidePickAutocomplete();
      return;
    }
  }

  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !STATE.waiting) {
    e.preventDefault();
    sendMessage();
  }
});

document.getElementById('msgInput').addEventListener('input', e => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  // Trigger autocomplete whenever there are attachments
  if (STATE.attachments.length > 0) showPickAutocomplete();
  else hidePickAutocomplete();
});

document.getElementById('msgInput').addEventListener('blur', () => {
  // Delay so mousedown on a dropdown item fires before blur hides it
  setTimeout(hidePickAutocomplete, 150);
});

document.getElementById('agentSelect').addEventListener('change', e => {
  switchAgent(e.target.value);
});

// Listen to background status broadcasts
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'status_update') {
    const wasConnected = STATE.wsConnected;
    const prevChannel  = STATE.channelName;
    STATE.wsConnected  = msg.wsConnected  || false;
    STATE.reconnecting = msg.reconnecting || false;
    STATE.channelName  = msg.browserId    || STATE.channelName;
    updateStatus();

    if (!wasConnected && STATE.wsConnected) {
      // ── Reconnected ──────────────────────────────────────────────────
      // Reset messages only if the channel changed; otherwise resume from
      // where we left off so users don't see a blank flash.
      const channelChanged = prevChannel && prevChannel !== STATE.channelName;
      if (channelChanged) {
        STATE.messages          = [];
        STATE.lastMsgId         = null;
        STATE.pendingEchoContent = null;
      }
      // Always clear any stuck waiting state from before the disconnect
      STATE.waiting = false;
      clearTimeout(STATE.waitingTimer);
      hideThinking();
      updateSendBtn();
      renderAll();
      fetchHistory();
      startPolling();

    } else if (wasConnected && !STATE.wsConnected) {
      // ── Disconnected ─────────────────────────────────────────────────
      exitPickModeUI();
      stopPolling();
      // Release the waiting lock so the user isn't stuck with a disabled input
      if (STATE.waiting) {
        STATE.waiting = false;
        clearTimeout(STATE.waitingTimer);
        hideThinking();
        updateSendBtn();
      }
      renderAll();
    }
    return;
  }

  if (msg.type === 'element_picked') {
    // Auto-exit pick mode after one element is picked
    exitPickModeUI();
    STATE.attachments.push(msg.element);
    renderAttachments();
    return;
  }

  if (msg.type === 'pick_mode_exited') {
    // Escape pressed in page
    exitPickModeUI();
    return;
  }

  if (msg.type === 'tab_activated') {
    const prevTabId = STATE.activeTabId;
    const newTabId  = msg.tabId;
    if (prevTabId === newTabId) return;

    // Save input + attachments for the tab we're leaving
    saveTabState(prevTabId);

    // Exit pick mode (background already sent exit_pick_mode to all tabs)
    exitPickModeUI();

    STATE.activeTabId = newTabId;

    // Restore or clear for the new tab
    restoreTabState(newTabId);
    return;
  }
});

// ── Boot ───────────────────────────────────────────────────────────────────
init();

// Notify background this sidebar is open
chrome.runtime.sendMessage({ type: 'sidebar_opened' }).catch(()=>{});

// Notify background when user closes the sidebar via Chrome's built-in UI
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    chrome.runtime.sendMessage({ type: 'sidebar_closed' }).catch(()=>{});
  }
});

// Sync language if user changes it in the popup while sidebar is open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.lang) {
    sbLang = changes.lang.newValue || 'zh';
    updateStatus();
    renderAll();
  }
});

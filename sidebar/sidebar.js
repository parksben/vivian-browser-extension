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
  wsConnected:   false,
  reconnecting:  false,
  channelName:   '',
  selectedAgent: 'main',
  lastMsgId:     null,
  messages:      [],
  polling:       null,
  sending:       false,
  waiting:       false,   // true while waiting for agent reply
  waitingTimer:  null,    // safety-timeout handle
  pickMode:      false,
  attachments:   [],      // [{ tag, id, classes, text, selector }]
  activeTabId:   null,
  tabStates:     {},      // { [tabId]: { input, attachments } }
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

/** Summarise a clawtab_cmd action name for display */
function summariseCmd(cmd) {
  const actionMap = {
    perceive:   '🔍 感知页面',
    act:        '🖱️ 操作页面',
    task_start: '▶️ 任务开始',
    task_done:  '✅ 任务完成',
    task_fail:  '❌ 任务失败',
    cancel:     '🚫 已取消',
  };
  const op = cmd.payload?.op;
  const opMap = {
    navigate: '🌐 导航',
    click:    '🖱️ 点击',
    fill:     '✏️ 填写',
    screenshot: '📸 截图',
    scroll:   '↕️ 滚动',
    eval:     '⚡ 执行脚本',
    get_text: '📋 读取文本',
    new_tab:  '➕ 新标签页',
    close_tab:'✖️ 关闭标签页',
  };
  const base = actionMap[cmd.action] || `⚙️ ${cmd.action}`;
  const detail = op ? (opMap[op] || op) : '';
  return detail ? `${base} · ${detail}` : base;
}

/** Escape HTML */
const esc = s => String(s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

/** Very basic markdown → HTML (bold, inline code, line breaks) */
function formatText(raw) {
  return esc(raw)
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
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
    tag.innerHTML = `<span class="sb-attach-tag-label">${esc(formatAttachLabel(a, i))}</span>` +
      `<button class="sb-attach-tag-del" data-idx="${i}" title="移除">×</button>`;
    el.appendChild(tag);
  }
  el.querySelectorAll('.sb-attach-tag-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      STATE.attachments.splice(idx, 1);
      renderAttachments();
      showPickAutocomplete(); // refresh dropdown if open
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
    if (!json) return true;
    if (json.type === 'clawtab_result') return false; // hide internal results
    return true; // clawtab_cmd will be rendered as a tool-row, keep it
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
  if (!text.trim()) return null;

  const json = extractJsonBlock(text);
  if (json?.type === 'clawtab_cmd') {
    // Show as tool summary row
    const row = document.createElement('div');
    row.className = 'sb-tool-row';
    row.textContent = summariseCmd(json);
    return row;
  }

  // Remove any leftover ```json``` blocks from the display text
  const cleaned = text.replace(/```json[\s\S]*?```/g, '').trim();
  if (!cleaned) return null;

  const wrap = document.createElement('div');
  wrap.className = `sb-msg ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'sb-bubble';
  bubble.innerHTML = formatText(cleaned);
  wrap.appendChild(bubble);
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
  if (STATE.polling) return;
  STATE.polling = setInterval(fetchHistory, 3000);
}

function stopPolling() {
  if (STATE.polling) { clearInterval(STATE.polling); STATE.polling = null; }
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

    const freshMsgs = [];
    for (const m of res.messages) {
      STATE.lastMsgId = m.id;
      freshMsgs.push(m);
    }
    STATE.messages.push(...freshMsgs);

    // If we were waiting for a reply, check if an assistant message arrived
    if (STATE.waiting && freshMsgs.some(m => m.role === 'assistant')) {
      STATE.waiting = false;
      clearTimeout(STATE.waitingTimer);
      hideThinking();
      updateSendBtn();
    }

    // Incremental append (avoid full re-render flicker)
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

  // Build message text, appending element reference context
  let fullText = text;
  if (STATE.attachments.length > 0) {
    const lines = STATE.attachments.map((a, i) => {
      const ref     = formatAttachLabel(a, i);           // '#1:div'
      const idPart  = a.id ? `#${a.id}` : '';
      const clsPart = !a.id && a.classes.length ? `.${a.classes[0]}` : '';
      const txtPart = a.text ? ` "${a.text.slice(0, 50)}"` : '';
      return `${ref}  ${a.tag}${idPart}${clsPart}${txtPart}  \`${a.selector}\``;
    });
    fullText += '\n\n---\n页面元素引用：\n' + lines.join('\n');
  }

  // Clear attachments immediately on send
  STATE.attachments = [];
  renderAttachments();

  // Optimistic local echo (show original text only, not the appended context)
  const localMsg = { id: `local-${Date.now()}`, role: 'user', content: text };
  STATE.messages.push(localMsg);
  appendMsgNode(localMsg);

  try {
    const res = await bg({
      type:       'sidebar_ensure_and_send',
      sessionKey: sessionKey(),
      message:    fullText,
    });
    if (!res?.ok) {
      // Send failed — show inline error, don't enter waiting state
      const errMsg = res?.error || '未知错误，请检查连接后重试';
      console.warn('[Sidebar] send failed:', errMsg);
      appendErrorNode(errMsg);
      return; // finally block will re-enable the send button
    }
    // Show thinking indicator and lock send until agent replies
    STATE.waiting = true;
    updateSendBtn();
    showThinking();
    // Safety timeout: auto-clear after 60s
    clearTimeout(STATE.waitingTimer);
    STATE.waitingTimer = setTimeout(() => {
      STATE.waiting = false;
      hideThinking();
      updateSendBtn();
    }, 60000);
  } catch (e) {
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
    const wasConnected  = STATE.wsConnected;
    STATE.wsConnected   = msg.wsConnected  || false;
    STATE.reconnecting  = msg.reconnecting || false;
    STATE.channelName   = msg.browserId    || STATE.channelName;
      updateStatus();

    if (!wasConnected && STATE.wsConnected) {
      STATE.messages  = [];
      STATE.lastMsgId = null;
      renderAll();
      fetchHistory();
      startPolling();
    } else if (wasConnected && !STATE.wsConnected) {
      exitPickModeUI();
      stopPolling();
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

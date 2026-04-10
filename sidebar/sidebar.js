/**
 * ClawTab sidebar.js
 * Chat UI for communicating with OpenClaw agents via the clawtab session.
 */

// ── State ──────────────────────────────────────────────────────────────────

const STATE = {
  wsConnected:   false,
  channelName:   '',
  selectedAgent: 'main',
  lastMsgId:     null,
  messages:      [],
  polling:       null,
  sending:       false,
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

// ── Render ─────────────────────────────────────────────────────────────────

function renderAll() {
  const el = document.getElementById('messages');

  if (!STATE.wsConnected) {
    el.innerHTML = `
      <div class="sb-empty">
        <div class="sb-empty-icon">🦞</div>
        <div>请先在插件面板中连接 OpenClaw</div>
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
        <div class="sb-empty-icon">💬</div>
        <div>向 <strong>${STATE.selectedAgent}</strong> 发消息，开始对话</div>
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
    if (!res?.ok || !res.messages?.length) return;

    const freshMsgs = [];
    for (const m of res.messages) {
      STATE.lastMsgId = m.id;
      freshMsgs.push(m);
    }
    STATE.messages.push(...freshMsgs);

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
  if (!text || !STATE.wsConnected || STATE.sending) return;

  STATE.sending = true;
  const btn = document.getElementById('sendBtn');
  btn.disabled = true;
  input.value  = '';
  input.style.height = '';

  // Optimistic local echo
  const localMsg = { id: `local-${Date.now()}`, role: 'user', content: text };
  STATE.messages.push(localMsg);
  appendMsgNode(localMsg);

  try {
    await bg({
      type:       'sidebar_ensure_and_send',
      sessionKey: sessionKey(),
      message:    text,
    });
  } catch (e) {
    console.warn('[Sidebar] send failed:', e.message);
  } finally {
    STATE.sending = false;
    btn.disabled  = !STATE.wsConnected;
  }
}

// ── Status ─────────────────────────────────────────────────────────────────

function updateStatus() {
  const dot  = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  const btn  = document.getElementById('sendBtn');

  if (STATE.wsConnected) {
    dot.className  = 'sb-status-dot connected';
    text.textContent = '已连接';
    btn.disabled   = false;
  } else {
    dot.className  = 'sb-status-dot';
    text.textContent = '未连接';
    btn.disabled   = true;
  }
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
  stopPolling();
  renderAll();
  if (STATE.wsConnected) {
    fetchHistory();
    startPolling();
  }
}

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  await loadAgents();

  try {
    const s = await bg({ type: 'get_status' });
    if (s) {
      STATE.wsConnected = s.wsConnected || false;
      STATE.channelName = s.browserId || '';
    }
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

document.getElementById('msgInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

document.getElementById('msgInput').addEventListener('input', e => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
});

document.getElementById('agentSelect').addEventListener('change', e => {
  switchAgent(e.target.value);
});

// Listen to background status broadcasts
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type !== 'status_update') return;
  const wasConnected  = STATE.wsConnected;
  STATE.wsConnected   = msg.wsConnected || false;
  STATE.channelName   = msg.browserId   || STATE.channelName;
  updateStatus();

  if (!wasConnected && STATE.wsConnected) {
    STATE.messages  = [];
    STATE.lastMsgId = null;
    renderAll();
    fetchHistory();
    startPolling();
  } else if (wasConnected && !STATE.wsConnected) {
    stopPolling();
    renderAll();
  }
});

// ── Boot ───────────────────────────────────────────────────────────────────
init();

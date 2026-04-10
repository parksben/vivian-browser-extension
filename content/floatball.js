/**
 * ClawTab floatball.js — content script
 * Floating ball + expandable chat panel with drag support.
 */
(function () {
  'use strict';
  if (window.__ctFloatball) return;
  window.__ctFloatball = true;

  // ── Constants ──────────────────────────────────────────────────────────────
  const BALL_SIZE  = 52;   // px — must match CSS
  const PANEL_W    = 360;  // px — must match CSS
  const PANEL_H_MAX = 520; // px — maximum panel height
  const PANEL_H_MIN = 280; // px — minimum usable height
  const MARGIN     = 16;   // px — safe distance from viewport edges
  const GAP        = 8;    // px — gap between ball and panel

  // ── Chat state ─────────────────────────────────────────────────────────────
  const STATE = {
    wsConnected:   false,
    channelName:   '',
    selectedAgent: 'main',
    lastMsgId:     null,
    messages:      [],
    polling:       null,
    sending:       false,
    panelOpen:     false,
  };

  // Ball position (top-left corner of ball, in viewport px)
  const POS = {
    x: window.innerWidth  - MARGIN - BALL_SIZE,
    y: window.innerHeight - MARGIN - BALL_SIZE,
  };

  const DEFAULT_AGENTS = ['main', 'dajin', 'coder', 'wechat-new', 'biz-coder'];

  // ── Build DOM ──────────────────────────────────────────────────────────────
  const root = document.createElement('div');
  root.id = 'ct-root';
  root.className = 'ct-hidden';

  root.innerHTML = `
    <div id="ct-panel">
      <div class="ct-header" id="ct-panel-header">
        <div class="ct-brand">
          <img class="ct-logo" src="${chrome.runtime.getURL('icons/icon48.png')}" alt="">
          <span class="ct-title">ClawTab</span>
        </div>
        <div class="ct-header-right">
          <select class="ct-agent-select" id="ct-agent-select"></select>
          <div class="ct-status-badge">
            <div class="ct-status-dot" id="ct-status-dot"></div>
            <span id="ct-status-text">未连接</span>
          </div>
          <button class="ct-close-btn" id="ct-close-btn" title="关闭">✕</button>
        </div>
      </div>
      <div class="ct-messages" id="ct-messages"></div>
      <div class="ct-input-area">
        <textarea class="ct-input" id="ct-input" rows="1"
          placeholder="发消息…（Enter 发送，Shift+Enter 换行）"></textarea>
        <button class="ct-send-btn" id="ct-send-btn" disabled>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>
    </div>
    <div id="ct-ball">
      <img src="${chrome.runtime.getURL('icons/icon48.png')}" alt="ClawTab">
      <div id="ct-ball-dot"></div>
    </div>
  `;

  document.documentElement.appendChild(root);

  const ball  = document.getElementById('ct-ball');
  const panel = document.getElementById('ct-panel');

  // ── Position helpers ───────────────────────────────────────────────────────

  /** Clamp ball position within viewport with safe margins */
  function clampBall() {
    POS.x = Math.max(MARGIN, Math.min(POS.x, window.innerWidth  - BALL_SIZE - MARGIN));
    POS.y = Math.max(MARGIN, Math.min(POS.y, window.innerHeight - BALL_SIZE - MARGIN));
  }

  /** Apply POS to ball element */
  function applyBallPos() {
    clampBall();
    ball.style.left = POS.x + 'px';
    ball.style.top  = POS.y + 'px';
    if (STATE.panelOpen) positionPanel();
  }

  /**
   * Calculate and apply panel position + height.
   * Opens above the ball if there's enough room, otherwise below.
   * Aligns horizontally so panel stays within the viewport.
   */
  function positionPanel() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Available vertical space above / below the ball
    const spaceAbove = POS.y - MARGIN - GAP;
    const spaceBelow = vh - (POS.y + BALL_SIZE) - MARGIN - GAP;

    // Choose direction: prefer above; fall back to below; take max if neither fits
    let openAbove, panelH;
    if (spaceAbove >= PANEL_H_MIN || spaceAbove >= spaceBelow) {
      openAbove = true;
      panelH = Math.min(PANEL_H_MAX, spaceAbove);
    } else {
      openAbove = false;
      panelH = Math.min(PANEL_H_MAX, spaceBelow);
    }
    panelH = Math.max(PANEL_H_MIN, panelH);

    // Vertical position
    const panelTop = openAbove
      ? POS.y - panelH - GAP
      : POS.y + BALL_SIZE + GAP;

    // Horizontal: right-align panel with right edge of ball, then clamp
    let panelLeft = POS.x + BALL_SIZE - PANEL_W;
    panelLeft = Math.max(MARGIN, Math.min(panelLeft, vw - PANEL_W - MARGIN));

    panel.style.top    = panelTop + 'px';
    panel.style.left   = panelLeft + 'px';
    panel.style.height = panelH + 'px';
  }

  // ── Drag — ball ────────────────────────────────────────────────────────────

  function makeBallDraggable() {
    let dragging = false, moved = false;
    let startMouseX, startMouseY, startPosX, startPosY;

    function onStart(clientX, clientY) {
      dragging = true;
      moved    = false;
      startMouseX = clientX;
      startMouseY = clientY;
      startPosX   = POS.x;
      startPosY   = POS.y;
      ball.classList.add('ct-dragging');
      document.body.style.userSelect = 'none';
    }

    function onMove(clientX, clientY) {
      if (!dragging) return;
      const dx = clientX - startMouseX;
      const dy = clientY - startMouseY;
      if (!moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) moved = true;
      POS.x = startPosX + dx;
      POS.y = startPosY + dy;
      applyBallPos();
    }

    function onEnd() {
      if (!dragging) return;
      dragging = false;
      ball.classList.remove('ct-dragging');
      document.body.style.userSelect = '';
      if (!moved) {
        // It was a tap/click — toggle panel
        if (STATE.panelOpen) closePanel(); else openPanel();
      }
    }

    // Mouse
    ball.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      onStart(e.clientX, e.clientY);
    });
    document.addEventListener('mousemove', e => onMove(e.clientX, e.clientY));
    document.addEventListener('mouseup',   () => onEnd());

    // Touch
    ball.addEventListener('touchstart', e => {
      const t = e.touches[0];
      onStart(t.clientX, t.clientY);
    }, { passive: true });
    ball.addEventListener('touchmove', e => {
      const t = e.touches[0];
      onMove(t.clientX, t.clientY);
    }, { passive: true });
    ball.addEventListener('touchend', () => onEnd());
  }

  // ── Drag — panel (via header) ──────────────────────────────────────────────

  function makePanelDraggable() {
    const header = document.getElementById('ct-panel-header');
    let dragging = false;
    // Store panel's absolute left/top during drag (independent of ball)
    let panelLeft, panelTop;
    let startMouseX, startMouseY;

    function onStart(clientX, clientY) {
      dragging    = true;
      startMouseX = clientX;
      startMouseY = clientY;
      panelLeft   = parseInt(panel.style.left,  10) || 0;
      panelTop    = parseInt(panel.style.top,   10) || 0;
      document.body.style.userSelect = 'none';
    }

    function onMove(clientX, clientY) {
      if (!dragging) return;
      const panelH = parseInt(panel.style.height, 10) || PANEL_H_MIN;
      let newLeft  = panelLeft + (clientX - startMouseX);
      let newTop   = panelTop  + (clientY - startMouseY);
      // Clamp panel within viewport
      newLeft = Math.max(MARGIN, Math.min(newLeft, window.innerWidth  - PANEL_W  - MARGIN));
      newTop  = Math.max(MARGIN, Math.min(newTop,  window.innerHeight - panelH   - MARGIN));
      panel.style.left = newLeft + 'px';
      panel.style.top  = newTop  + 'px';
    }

    function onEnd() {
      dragging = false;
      document.body.style.userSelect = '';
    }

    // Mouse
    header.addEventListener('mousedown', e => {
      // Don't intercept clicks on interactive controls inside header
      if (e.target.closest('select, button')) return;
      e.preventDefault();
      onStart(e.clientX, e.clientY);
    });
    document.addEventListener('mousemove', e => onMove(e.clientX, e.clientY));
    document.addEventListener('mouseup',   () => onEnd());

    // Touch
    header.addEventListener('touchstart', e => {
      if (e.target.closest('select, button')) return;
      const t = e.touches[0];
      onStart(t.clientX, t.clientY);
    }, { passive: true });
    header.addEventListener('touchmove', e => {
      const t = e.touches[0];
      onMove(t.clientX, t.clientY);
    }, { passive: true });
    header.addEventListener('touchend', () => onEnd());
  }

  // ── Panel open / close ─────────────────────────────────────────────────────

  function openPanel() {
    STATE.panelOpen = true;
    positionPanel();
    panel.classList.add('ct-open');
    // Scroll to bottom after animation
    setTimeout(() => {
      const el = document.getElementById('ct-messages');
      if (el) el.scrollTop = el.scrollHeight;
    }, 220);
  }

  function closePanel() {
    STATE.panelOpen = false;
    panel.classList.remove('ct-open');
  }

  // Re-clamp on window resize
  window.addEventListener('resize', () => {
    applyBallPos();
    if (STATE.panelOpen) positionPanel();
  });

  // ── Chat helpers ───────────────────────────────────────────────────────────

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

  function extractJsonBlock(text) {
    const m = text.match(/```json\s*([\s\S]*?)```/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  }

  function summariseCmd(cmd) {
    const actionMap = {
      perceive:   '🔍 感知页面',
      act:        '🖱️ 操作页面',
      task_start: '▶️ 任务开始',
      task_done:  '✅ 任务完成',
      task_fail:  '❌ 任务失败',
      cancel:     '🚫 已取消',
    };
    const opMap = {
      navigate:   '🌐 导航',
      click:      '🖱️ 点击',
      fill:       '✏️ 填写',
      screenshot: '📸 截图',
      scroll:     '↕️ 滚动',
      eval:       '⚡ 执行脚本',
      get_text:   '📋 读取文本',
      new_tab:    '➕ 新标签页',
      close_tab:  '✖️ 关闭标签页',
    };
    const op     = cmd.payload?.op;
    const base   = actionMap[cmd.action] || `⚙️ ${cmd.action}`;
    const detail = op ? (opMap[op] || op) : '';
    return detail ? `${base} · ${detail}` : base;
  }

  const esc = s => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function formatText(raw) {
    return esc(raw)
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  function buildMsgNode(msg) {
    const text = msgText(msg);
    if (!text.trim()) return null;

    const json = extractJsonBlock(text);
    if (json?.type === 'clawtab_result') return null;
    if (json?.type === 'clawtab_cmd') {
      const row = document.createElement('div');
      row.className = 'ct-tool-row';
      row.textContent = summariseCmd(json);
      return row;
    }

    const cleaned = text.replace(/```json[\s\S]*?```/g, '').trim();
    if (!cleaned) return null;

    const role = msg.role === 'user' ? 'user' : 'assistant';
    const wrap = document.createElement('div');
    wrap.className = `ct-msg ${role}`;
    const bubble = document.createElement('div');
    bubble.className = 'ct-bubble';
    bubble.innerHTML = formatText(cleaned);
    wrap.appendChild(bubble);
    return wrap;
  }

  function renderMessages() {
    const el = document.getElementById('ct-messages');
    if (!el) return;

    if (!STATE.wsConnected) {
      el.innerHTML = `<div class="ct-empty"><div class="ct-empty-icon">🦞</div><div>请先连接 OpenClaw</div></div>`;
      return;
    }

    const visible = STATE.messages.filter(m => {
      const json = extractJsonBlock(msgText(m));
      return !json || json.type !== 'clawtab_result';
    });

    if (visible.length === 0) {
      el.innerHTML = `<div class="ct-empty"><div class="ct-empty-icon">💬</div><div>向 <strong>${STATE.selectedAgent}</strong> 发消息，开始对话</div></div>`;
      return;
    }

    el.innerHTML = '';
    for (const msg of visible) {
      const node = buildMsgNode(msg);
      if (node) el.appendChild(node);
    }
    el.scrollTop = el.scrollHeight;
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

      const el = document.getElementById('ct-messages');
      if (el?.querySelector('.ct-empty')) el.innerHTML = '';

      for (const m of res.messages) {
        STATE.lastMsgId = m.id;
        STATE.messages.push(m);
        const node = buildMsgNode(m);
        if (node && el) el.appendChild(node);
      }
      if (el) el.scrollTop = el.scrollHeight;
    } catch (_) {}
  }

  // ── Send ───────────────────────────────────────────────────────────────────

  async function sendMessage() {
    const input = document.getElementById('ct-input');
    const text  = input?.value.trim();
    if (!text || !STATE.wsConnected || STATE.sending) return;

    STATE.sending = true;
    const btn = document.getElementById('ct-send-btn');
    if (btn) btn.disabled = true;
    input.value = '';
    input.style.height = '';

    const localMsg = { id: `local-${Date.now()}`, role: 'user', content: text };
    STATE.messages.push(localMsg);
    const el = document.getElementById('ct-messages');
    if (el?.querySelector('.ct-empty')) el.innerHTML = '';
    const node = buildMsgNode(localMsg);
    if (node && el) { el.appendChild(node); el.scrollTop = el.scrollHeight; }

    try {
      await bg({
        type:       'sidebar_ensure_and_send',
        sessionKey: sessionKey(),
        message:    text,
      });
    } catch (e) {
      console.warn('[ClawTab] send failed:', e.message);
    } finally {
      STATE.sending = false;
      if (btn) btn.disabled = !STATE.wsConnected;
    }
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  function updateStatus() {
    const dot     = document.getElementById('ct-status-dot');
    const txt     = document.getElementById('ct-status-text');
    const btn     = document.getElementById('ct-send-btn');
    const ballDot = document.getElementById('ct-ball-dot');

    if (STATE.wsConnected) {
      dot?.classList.add('connected');
      ballDot?.classList.add('connected');
      if (txt) txt.textContent = '已连接';
      if (btn) btn.disabled = false;
    } else {
      dot?.classList.remove('connected');
      ballDot?.classList.remove('connected');
      if (txt) txt.textContent = '未连接';
      if (btn) btn.disabled = true;
    }
  }

  // ── Agent selector ─────────────────────────────────────────────────────────

  async function loadAgents() {
    const sel = document.getElementById('ct-agent-select');
    if (!sel) return;
    sel.innerHTML = '';

    let agents = DEFAULT_AGENTS;
    try {
      const res = await bg({ type: 'sidebar_list_agents' });
      if (res?.agents?.length > 0)
        agents = res.agents.map(a => (typeof a === 'string' ? a : a.id || String(a)));
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
    renderMessages();
    if (STATE.wsConnected) { fetchHistory(); startPolling(); }
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  async function init() {
    // Apply initial ball position
    applyBallPos();

    await loadAgents();

    try {
      const s = await bg({ type: 'get_status' });
      if (s) {
        STATE.wsConnected = s.wsConnected || false;
        STATE.channelName = s.browserId   || '';
      }
    } catch (_) {}

    if (STATE.wsConnected) root.classList.remove('ct-hidden');
    updateStatus();
    renderMessages();

    if (STATE.wsConnected && STATE.channelName) {
      await fetchHistory();
      startPolling();
    }
  }

  // ── Wire up events ─────────────────────────────────────────────────────────

  makeBallDraggable();
  makePanelDraggable();

  document.getElementById('ct-close-btn').addEventListener('click', closePanel);

  document.getElementById('ct-send-btn').addEventListener('click', sendMessage);

  document.getElementById('ct-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  document.getElementById('ct-input').addEventListener('input', e => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 100) + 'px';
  });

  document.getElementById('ct-agent-select').addEventListener('change', e => {
    switchAgent(e.target.value);
  });

  // Background status broadcasts
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type !== 'status_update') return;
    const wasConnected = STATE.wsConnected;
    STATE.wsConnected  = msg.wsConnected || false;
    STATE.channelName  = msg.browserId   || STATE.channelName;

    if (STATE.wsConnected) root.classList.remove('ct-hidden');
    else root.classList.add('ct-hidden');

    updateStatus();

    if (!wasConnected && STATE.wsConnected) {
      STATE.messages  = [];
      STATE.lastMsgId = null;
      renderMessages();
      fetchHistory();
      startPolling();
    } else if (wasConnected && !STATE.wsConnected) {
      stopPolling();
      closePanel();
      renderMessages();
    }
  });

  // ── Boot ───────────────────────────────────────────────────────────────────
  init();
})();

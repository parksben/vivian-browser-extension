/**
 * ClawTab sidebar.js
 * Two-page sidebar: Config (connection settings) + Chat (agent conversation).
 * All popup functionality is merged here; the popup is no longer used.
 */

// ── I18N ───────────────────────────────────────────────────────────────────

const SB_I18N = {
  en: {
    // ── Config page ──
    connectTitle:     'Connect OpenClaw',
    configTitle:      'Connection Settings',
    gatewayUrl:       'Gateway URL',
    gatewayUrlPh:     'wss://your-gateway.example.com',
    token:            'Access Token',
    tokenPh:          'Paste your token here',
    channelName:      'Channel Name',
    channelNamePh:    'e.g. browser-home',
    channelNameHint:  'A unique name to identify this browser',
    connect:          'Connect',
    connecting:       'Connecting…',
    disconnect:       'Disconnect',
    exportConfig:     'Export config',
    importConfig:     'Import config',
    importSuccess:    'Config imported!',
    importError:      'Invalid config file',
    connFailed:       'Connection failed — check your settings',
    pairingTitle:     'Pairing required',
    pairingDesc:      'Send this pairing code to your OpenClaw agent:',
    pairingOr:        'Or run on your Gateway:',
    pairingCancel:    'Cancel',
    taskCancel:       'Cancel Task',
    // ── Chat page ──
    connected:    'Connected',
    disconnected: 'Not connected',
    reconnecting: 'Reconnecting…',
    placeholderOn:  'Message… (⌘/Ctrl+Enter to send)',
    placeholderOff: 'Connect OpenClaw to start chatting',
    placeholderReconnecting: 'Reconnecting, please wait…',
    emptyConnect: 'Connect OpenClaw to start chatting',
    emptyChat:    'Send a message to {agent} to start chatting',
    // ── Loop status texts ──
    loopIdle:       'Ready',
    loopPerceiving: 'Analyzing page…',
    loopThinking:   'Thinking…',
    loopActing:     'Executing…',
    loopDone:       'Task complete',
    loopFailed:     'Task failed',
    loopCancelled:  'Cancelled',
    // ── Diagnostics ──
    exportLogs:    'Export logs',
    clearLogs:     'Clear logs',
    clearLogsConfirm: 'Clear all diagnostic logs on this browser?',
    logsCleared:   'Logs cleared',
    exportFailed:  'Failed to export logs',
  },
  zh: {
    // ── Config page ──
    connectTitle:     '连接 OpenClaw',
    configTitle:      '连接配置',
    gatewayUrl:       'Gateway 地址',
    gatewayUrlPh:     'wss://your-gateway.example.com',
    token:            '访问令牌',
    tokenPh:          '粘贴令牌',
    channelName:      '渠道名称',
    channelNamePh:    '例：browser-home',
    channelNameHint:  '唯一标识当前浏览器的名称',
    connect:          '保存并连接',
    connecting:       '连接中…',
    disconnect:       '断开连接',
    exportConfig:     '导出配置',
    importConfig:     '导入配置',
    importSuccess:    '配置已导入！',
    importError:      '无效的配置文件',
    connFailed:       '连接失败，请检查配置',
    pairingTitle:     '需要配对',
    pairingDesc:      '将配对码发送给 OpenClaw Agent：',
    pairingOr:        '或在 Gateway 上运行：',
    pairingCancel:    '取消',
    taskCancel:       '取消任务',
    // ── Chat page ──
    connected:    '已连接',
    disconnected: '未连接',
    reconnecting: '重连中…',
    placeholderOn:  '发消息… (⌘/Ctrl+Enter 发送)',
    placeholderOff: '请先连接 OpenClaw',
    placeholderReconnecting: '重连中，请稍候…',
    emptyConnect: '请先连接 OpenClaw',
    emptyChat:    '向 {agent} 发消息，开始对话',
    // ── Loop status texts ──
    loopIdle:       '就绪',
    loopPerceiving: '正在分析页面…',
    loopThinking:   '思考中…',
    loopActing:     '正在执行操作…',
    loopDone:       '任务完成',
    loopFailed:     '任务失败',
    loopCancelled:  '已取消',
    // ── Diagnostics ──
    exportLogs:    '导出日志',
    clearLogs:     '清除日志',
    clearLogsConfirm: '确定要清除浏览器里所有诊断日志吗？',
    logsCleared:   '日志已清除',
    exportFailed:  '导出日志失败',
  },
};

let sbLang = 'en';
const sbt = key => SB_I18N[sbLang]?.[key] ?? SB_I18N.zh[key] ?? key;

// ── State ──────────────────────────────────────────────────────────────────

const STATE = {
  wsConnected:        false,
  reconnecting:       false,
  connecting:         false,  // true while user-initiated connect is in progress
  channelName:        '',
  selectedAgent:      'main',
  lastMsgId:          null,
  messages:           [],
  pollTimer:          null,
  sending:            false,
  waiting:            false,
  waitingTimer:       null,
  pendingEchoContent: null,
  pickMode:           false,
  attachments:        [],
  activeTabId:        null,
  tabStates:          {},
  pairingDeviceId:    null,  // stored so copy button can use it
};

const DEFAULT_AGENTS = ['main', 'dajin', 'coder', 'wechat-new', 'biz-coder'];

// ── Helpers ────────────────────────────────────────────────────────────────

function sessionKey() {
  return `agent:${STATE.selectedAgent}:clawtab-${STATE.channelName}`;
}

function bg(msg) {
  return chrome.runtime.sendMessage(msg);
}

// Fire-and-forget structured log to the background ring buffer.
function clog(level, message, data) {
  bg({ type: 'log_event', level, src: 'sidebar', msg: message, data }).catch(() => {});
}

function msgText(msg) {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content))
    return msg.content.filter(b => b.type === 'text').map(b => b.text || '').join('');
  if (msg.blocks)
    return msg.blocks.filter(b => b.type === 'text').map(b => b.text || '').join('');
  return '';
}

// Stable identity for dedup: prefer id, fall back to role+content so messages
// missing a server-side id (e.g. the handshake echo) can't slip past the filter
// and keep re-rendering on every poll tick.
function msgKey(m) {
  if (m.id) return `id:${m.id}`;
  return `c:${m.role}|${msgText(m).slice(0, 300)}`;
}

function extractJsonBlock(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function extractToolCalls(msg) {
  const blocks = Array.isArray(msg.content) ? msg.content
               : Array.isArray(msg.blocks)  ? msg.blocks : [];
  return blocks.filter(b => b.type === 'tool_use');
}

function isTerminalMsg(m) {
  if (m.role !== 'assistant') return false;
  const text = msgText(m);
  const json = extractJsonBlock(text);
  if (json?.type === 'clawtab_cmd') {
    return ['task_done', 'task_fail', 'cancel'].includes(json.action);
  }
  const cleaned = text.replace(/```json[\s\S]*?```/g, '').trim();
  if (cleaned) return true;
  return extractToolCalls(m).length === 0;
}

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

const esc = s => String(s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

marked.setOptions({ gfm: true, breaks: true });

function sanitizeHtml(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[\s\S]*?>/gi, '')
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
    .replace(/href\s*=\s*["']?\s*javascript:[^"'\s>]*/gi, 'href="#"')
    // Force every link to open in a new browser tab. The click delegate on
    // #messages also calls chrome.tabs.create so this is belt-and-braces.
    .replace(/<a\b([^>]*)>/gi, (_, attrs) => {
      const stripped = attrs
        .replace(/\s+target\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '')
        .replace(/\s+rel\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '');
      return `<a${stripped} target="_blank" rel="noopener noreferrer">`;
    });
}

function formatText(raw) {
  if (!raw) return '';
  try { return sanitizeHtml(marked.parse(String(raw))); }
  catch (_) { return esc(raw).replace(/\n/g, '<br>'); }
}

// ── Toast ──────────────────────────────────────────────────────────────────

function showToast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'sb-toast ' + (isError ? 'error' : 'ok');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// ── I18N application ───────────────────────────────────────────────────────

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (key) el.textContent = sbt(key);
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const key = el.dataset.i18nPh;
    if (key) el.placeholder = sbt(key);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.dataset.i18nTitle;
    if (key) el.title = sbt(key);
  });
  // Language toggle buttons: show target language as visible text label
  const langLabel = sbLang === 'en' ? '中文' : 'English';
  const lt1 = document.getElementById('langToggle');
  const lt2 = document.getElementById('langToggleChat');
  if (lt1) lt1.textContent = langLabel;
  if (lt2) lt2.textContent = langLabel;
  const expBtn = document.getElementById('exportConfigBtn');
  const impBtn = document.getElementById('importConfigBtn');
  if (expBtn) expBtn.title = sbt('exportConfig');
  if (impBtn) impBtn.title = sbt('importConfig');
}

// ── Page routing ───────────────────────────────────────────────────────────

function showPage(name) {
  document.querySelectorAll('.sb-page').forEach(el => el.classList.remove('active'));
  document.getElementById(`page-${name}`)?.classList.add('active');
  if (name === 'config') {
    // Reset connect button and form inputs — but NOT if user-initiated connect is in progress
    if (!STATE.connecting) {
      const btn = document.getElementById('connectBtn');
      if (btn) { btn.disabled = false; btn.classList.remove('loading'); btn.textContent = sbt('connect'); }
      ['sbGatewayUrl', 'sbGatewayToken', 'sbBrowserName'].forEach(id => {
        const el = document.getElementById(id); if (el) el.disabled = false;
      });
    }
  }
}

function showRetryTip() {
  document.getElementById('retryTip')?.classList.add('show');
}

function hideRetryTip() {
  document.getElementById('retryTip')?.classList.remove('show');
}

function showPairingSection(deviceId) {
  STATE.pairingDeviceId = deviceId || null;
  document.getElementById('configForm').style.display = 'none';
  document.getElementById('pairingSection').style.display = '';

  const code = document.getElementById('pairingCode');
  if (code) code.textContent = deviceId ? deviceId.slice(0, 24) + '…' : '—';

  const cmd = document.getElementById('pairingCmd');
  if (cmd) cmd.textContent = deviceId
    ? `openclaw devices approve ${deviceId.slice(0, 16)}`
    : 'openclaw devices approve';
}

function hidePairingSection() {
  STATE.pairingDeviceId = null;
  document.getElementById('configForm').style.display = '';
  document.getElementById('pairingSection').style.display = 'none';
}

// ── Task bar ───────────────────────────────────────────────────────────────

function updateTaskBar(loop) {
  const taskBar = document.getElementById('taskBar');
  if (!taskBar) return;
  const status = loop?.status || 'idle';

  if (status === 'idle') {
    taskBar.classList.remove('active');
    return;
  }
  taskBar.classList.add('active');

  const goalEl = document.getElementById('taskGoal');
  if (goalEl) goalEl.textContent = loop.goal || '';

  const statusTextEl = document.getElementById('taskStatusText');
  if (statusTextEl) {
    const keyMap = {
      perceiving: 'loopPerceiving',
      thinking:   'loopThinking',
      acting:     'loopActing',
      done:       'loopDone',
      failed:     'loopFailed',
      cancelled:  'loopCancelled',
    };
    statusTextEl.textContent = loop.statusText || sbt(keyMap[status] || 'loopIdle');
  }

  const thumbEl = document.getElementById('taskThumb');
  if (thumbEl) {
    if (loop.lastScreenshot) {
      thumbEl.style.display = '';
      thumbEl.src = loop.lastScreenshot;
    } else {
      thumbEl.style.display = 'none';
    }
  }
}

// ── Config actions ─────────────────────────────────────────────────────────

let _draftTimer;
function saveDraft() {
  clearTimeout(_draftTimer);
  _draftTimer = setTimeout(async () => {
    await chrome.storage.local.set({
      gatewayUrlDraft:   document.getElementById('sbGatewayUrl')?.value.trim()   || '',
      gatewayTokenDraft: document.getElementById('sbGatewayToken')?.value.trim() || '',
      browserNameDraft:  document.getElementById('sbBrowserName')?.value.trim()  || '',
    });
  }, 600);
}

async function doConnect() {
  const urlEl   = document.getElementById('sbGatewayUrl');
  const tokenEl = document.getElementById('sbGatewayToken');
  const nameEl  = document.getElementById('sbBrowserName');
  const url   = urlEl.value.trim();
  const token = tokenEl.value.trim();
  const name  = nameEl.value.trim()
              || ('browser-' + Math.random().toString(36).slice(2, 6));

  if (!url) {
    urlEl.classList.add('input-error');
    setTimeout(() => urlEl.classList.remove('input-error'), 1500);
    return;
  }
  if (!token) {
    tokenEl.classList.add('input-error');
    setTimeout(() => tokenEl.classList.remove('input-error'), 1500);
    return;
  }

  await chrome.storage.local.set({
    gatewayUrl: url, gatewayToken: token, browserName: name,
    gatewayUrlDraft: url, gatewayTokenDraft: token, browserNameDraft: name,
  });

  const btn = document.getElementById('connectBtn');
  const FORM_INPUTS = ['sbGatewayUrl', 'sbGatewayToken', 'sbBrowserName'];
  STATE.connecting = true;
  FORM_INPUTS.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = true; });
  btn.disabled = true;
  btn.classList.add('loading');
  btn.textContent = sbt('connecting');
  try {
    await bg({ type: 'connect', url, token, name });
    // bg resolved — connection in progress; status_update drives page routing and clears STATE.connecting
  } catch(_) {
    // IPC failure — restore immediately
    STATE.connecting = false;
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.textContent = sbt('connect');
    FORM_INPUTS.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = false; });
  }
}

async function doDisconnect() {
  try { await bg({ type: 'disconnect' }); } catch(_) {}
  showPage('config');
  hidePairingSection();
  hideRetryTip();
}

async function doExport() {
  const d = await chrome.storage.local.get(['gatewayUrl','gatewayToken','browserName']);
  const json = JSON.stringify({
    _clawtab: true,
    gatewayUrl:   d.gatewayUrl   || '',
    gatewayToken: d.gatewayToken || '',
    browserName:  d.browserName  || '',
  }, null, 2);
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([json], { type: 'application/json' })),
    download: 'clawtab-config.json',
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function doImport(file) {
  try {
    const cfg = JSON.parse(await file.text());
    if (!cfg.gatewayUrl) throw new Error('invalid');
    const { gatewayUrl: url = '', gatewayToken: token = '', browserName: name = '' } = cfg;
    await chrome.storage.local.set({
      gatewayUrl: url, gatewayToken: token, browserName: name,
      gatewayUrlDraft: url, gatewayTokenDraft: token, browserNameDraft: name,
    });
    document.getElementById('sbGatewayUrl').value   = url;
    document.getElementById('sbGatewayToken').value = token;
    document.getElementById('sbBrowserName').value  = name;
    try { await bg({ type: 'disconnect' }); } catch(_) {}
    showPage('config');
    hidePairingSection();
    hideRetryTip();
    showToast(sbt('importSuccess'));
  } catch {
    showToast(sbt('importError'), true);
  }
}

// ── Diagnostics: export / clear ─────────────────────────────────────────────

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3,'0')}`;
}

function formatDiagBundle(b) {
  const lines = [];
  lines.push('ClawTab 诊断报告 / Diagnostic Report');
  lines.push(`生成时间 / Generated: ${fmtTime(b.generatedAt)}`);
  lines.push(`扩展版本 / Version:   ${b.version}`);
  lines.push('');

  lines.push('══════════════════════════════════════════════════════════');
  lines.push('## 当前状态 / Current State');
  const s = b.state || {};
  lines.push(`wsConnected:      ${s.wsConnected}`);
  lines.push(`reconnecting:     ${s.reconnecting}`);
  lines.push(`pairingPending:   ${s.pairingPending}`);
  lines.push(`wsGaveUp:         ${s.wsGaveUp}`);
  lines.push(`wsReconnectCount: ${s.wsReconnectCount}`);
  lines.push(`browserId:        ${s.browserId || '—'}`);
  lines.push(`sessionKey:       ${s.sessionKey || '—'}`);
  lines.push(`deviceId:         ${s.deviceId || '—'}`);
  lines.push(`lastSeenMsgId:    ${s.lastSeenMsgId || '—'}`);
  lines.push(`tabCount:         ${s.tabCount}`);
  lines.push(`lastCmd:          ${s.lastCmd || '—'}`);
  lines.push(`loop.status:      ${s.loop?.status || 'idle'}`);
  lines.push(`loop.goal:        ${s.loop?.goal || '—'}`);
  lines.push(`loop.agentId:     ${s.loop?.agentId || '—'}`);
  lines.push(`loop.stepIndex:   ${s.loop?.stepIndex ?? 0}`);
  lines.push(`loop.statusText:  ${s.loop?.statusText || '—'}`);
  lines.push(`loop.errorMsg:    ${s.loop?.errorMsg || '—'}`);
  lines.push(`loop.startedAt:   ${s.loop?.startedAt ? fmtTime(s.loop.startedAt) : '—'}`);
  if (Array.isArray(s.loop?.history) && s.loop.history.length) {
    lines.push('loop.recentSteps:');
    for (const h of s.loop.history) {
      lines.push(`  - [${h.status}] ${h.op}: ${h.desc || ''} (${h.durationMs || 0}ms)${h.error ? ' ← ' + h.error : ''}`);
    }
  }
  lines.push('');

  lines.push('## 配置 / Config (tokens redacted)');
  const cfg = b.config || {};
  for (const k of Object.keys(cfg)) lines.push(`${k}: ${cfg[k] ?? '—'}`);
  lines.push('');

  lines.push('══════════════════════════════════════════════════════════');
  const logs = b.logs || [];
  lines.push(`## 日志 / Logs (${logs.length} entries)`);
  for (const e of logs) {
    const time = fmtTime(e.t).slice(11); // HH:mm:ss.SSS
    const level = (e.level || 'info').toUpperCase().padEnd(5);
    const src = (e.src || 'bg').padEnd(7);
    let line = `[${time}] [${level}] [${src}] ${e.msg}`;
    if (e.data) line += ` | ${e.data}`;
    lines.push(line);
  }
  lines.push('');

  lines.push('══════════════════════════════════════════════════════════');
  const hist = b.chatHistory || [];
  lines.push(`## 聊天历史 / Chat History (${hist.length} messages)`);
  for (const m of hist) {
    const role = m.role || '?';
    const id   = m.id || '';
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter(b => b.type === 'text').map(b => b.text || '').join('')
        : (m.blocks?.filter(b => b.type === 'text').map(b => b.text || '').join('') || '');
    lines.push(`--- [${role}] ${id} ---`);
    lines.push(text || '(empty)');
  }
  lines.push('');

  return lines.join('\n');
}

async function exportLogs() {
  let res;
  try {
    res = await bg({ type: 'diag_get' });
  } catch (e) {
    showToast(sbt('exportFailed'), true);
    return;
  }
  if (!res?.ok) {
    showToast(sbt('exportFailed'), true);
    return;
  }
  const text = formatDiagBundle(res);
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const fname = `clawtab-diag-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.txt`;
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })),
    download: fname,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  clog('info', 'logs exported', { bytes: text.length, fname });
}

async function clearLogs() {
  if (!confirm(sbt('clearLogsConfirm'))) return;
  try { await bg({ type: 'log_clear' }); showToast(sbt('logsCleared')); }
  catch(_) {}
}

// ── Thinking indicator ─────────────────────────────────────────────────────

function showThinking() {
  hideThinking();
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

// ── Autocomplete ───────────────────────────────────────────────────────────

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
    .map((a, i) => formatAttachLabel(a, i))
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
      e.preventDefault();
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

  const visible = STATE.messages.filter(m => {
    const text = msgText(m);
    const json = extractJsonBlock(text);
    if (json?.type === 'clawtab_result') return false;
    if (text.trim()) return true;
    return extractToolCalls(m).length > 0;
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
  el.scrollTop = el.scrollHeight;
}

function buildMsgNode(msg) {
  const role = msg.role === 'user' ? 'user' : 'assistant';
  const text = msgText(msg);
  const toolCalls = extractToolCalls(msg);

  const json = extractJsonBlock(text);
  if (json?.type === 'clawtab_cmd') {
    const row = document.createElement('div');
    row.className = 'sb-tool-row';
    row.innerHTML = summariseCmd(json);
    return row;
  }

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

  for (const tc of toolCalls) {
    const row = document.createElement('div');
    row.className = 'sb-tool-row';
    row.innerHTML = summariseToolCall(tc);
    body.appendChild(row);
  }

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
  if (emptyEl) el.innerHTML = '';
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
    });
    if (!res?.ok) {
      clog('warn', 'fetchHistory failed', { error: res?.error });
      return;
    }
    if (!res.messages?.length) return;

    // Deduplicate by msgKey() — uses id when available, falls back to role+content
    // so messages without a server-side id (handshake/system echoes) can't keep
    // re-appearing on every poll tick. Also dedups within the same response.
    const seenKeys = new Set(STATE.messages.map(msgKey));
    const freshMsgs = [];
    for (const m of res.messages) {
      if (m.id) STATE.lastMsgId = m.id;
      const key = msgKey(m);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      freshMsgs.push(m);
    }
    if (!freshMsgs.length) return;

    if (STATE.pendingEchoContent !== null) {
      const idx = freshMsgs.findIndex(
        m => m.role === 'user' && msgText(m) === STATE.pendingEchoContent
      );
      if (idx !== -1) {
        const localIdx = STATE.messages.findIndex(m => m.id?.startsWith('local-'));
        if (localIdx !== -1) STATE.messages[localIdx] = freshMsgs[idx];
        else                 STATE.messages.push(freshMsgs[idx]);
        const echoNode = document.querySelector('[data-local-echo]');
        if (echoNode) {
          const server = buildMsgNode(freshMsgs[idx]);
          if (server) echoNode.replaceWith(server);
          else        echoNode.remove();
        }
        freshMsgs.splice(idx, 1);
        STATE.pendingEchoContent = null;
      }
    }

    STATE.messages.push(...freshMsgs);

    if (STATE.waiting && freshMsgs.some(isTerminalMsg)) {
      STATE.waiting = false;
      clearTimeout(STATE.waitingTimer);
      hideThinking();
      updateSendBtn();
    }

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

  let fullText = text;
  if (STATE.attachments.length > 0) {
    const refs = STATE.attachments.map((a, i) => {
      const ref = { ref: formatAttachLabel(a, i), selector: a.selector, tag: a.tag };
      if (a.text)       ref.text       = a.text.slice(0, 80);
      if (a.screenshot) ref.screenshot = a.screenshot;
      return ref;
    });
    fullText += '\n\n```json\n' +
      JSON.stringify({ type: 'element_refs', refs }, null, 2) +
      '\n```';
  }

  const sentAttachments = [...STATE.attachments];
  STATE.attachments = [];
  renderAttachments();

  const localMsg = { id: `local-${Date.now()}`, role: 'user', content: text, attachments: sentAttachments };
  STATE.messages.push(localMsg);
  appendMsgNode(localMsg);
  const echoNode = document.getElementById('messages').lastElementChild;
  if (echoNode) echoNode.dataset.localEcho = '1';
  STATE.pendingEchoContent = text;

  try {
    const res = await bg({
      type:       'sidebar_ensure_and_send',
      sessionKey: sessionKey(),
      message:    fullText,
    });
    if (!res?.ok) {
      STATE.pendingEchoContent = null;
      const errMsg = res?.error || '未知错误，请检查连接后重试';
      const detail = res?.code ? ` [${res.code}]` : '';
      clog('warn', 'send failed', { error: errMsg, code: res?.code });
      appendErrorNode(errMsg + detail);
      return;
    }
    STATE.waiting = true;
    updateSendBtn();
    showThinking();
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
    clog('error', 'send exception', { error: e.message });
    appendErrorNode('发送异常：' + e.message);
  } finally {
    STATE.sending = false;
    if (!STATE.waiting) updateSendBtn();
  }
}

// ── Status (chat page) ─────────────────────────────────────────────────────

function updateStatus() {
  const dot       = document.getElementById('statusDot');
  const text      = document.getElementById('statusText');
  const input     = document.getElementById('msgInput');
  const inputArea = document.querySelector('.sb-input-area');
  const pickBtn   = document.getElementById('pickBtn');

  if (STATE.wsConnected) {
    if (dot)       dot.className     = 'sb-status-dot connected';
    if (text)      text.textContent  = sbt('connected');
    if (input)     input.disabled    = false;
    if (input)     input.placeholder = sbt('placeholderOn');
    inputArea?.classList.remove('sb-disconnected');
    if (pickBtn)   pickBtn.disabled  = false;
  } else if (STATE.reconnecting) {
    if (dot)       dot.className     = 'sb-status-dot connecting';
    if (text)      text.textContent  = sbt('reconnecting');
    if (input)     input.disabled    = true;
    if (input)     input.placeholder = sbt('placeholderReconnecting');
    inputArea?.classList.add('sb-disconnected');
    if (pickBtn)   pickBtn.disabled  = true;
  } else {
    if (dot)       dot.className     = 'sb-status-dot';
    if (text)      text.textContent  = sbt('disconnected');
    if (input)     input.disabled    = true;
    if (input)     input.placeholder = sbt('placeholderOff');
    inputArea?.classList.add('sb-disconnected');
    if (pickBtn)   pickBtn.disabled  = true;
  }
  updateSendBtn();
}

// ── Agent selector ─────────────────────────────────────────────────────────

async function loadAgents() {
  const sel = document.getElementById('agentSelect');
  if (!sel) return;
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
  // 1. Language
  try {
    const stored = await chrome.storage.local.get('lang');
    if (stored.lang) sbLang = stored.lang;
  } catch (_) {}
  applyI18n();

  // 2. Populate form drafts
  try {
    const d = await chrome.storage.local.get([
      'gatewayUrlDraft', 'gatewayTokenDraft', 'browserNameDraft',
      'gatewayUrl', 'gatewayToken', 'browserName',
    ]);
    document.getElementById('sbGatewayUrl').value   = d.gatewayUrlDraft   || d.gatewayUrl   || '';
    document.getElementById('sbGatewayToken').value = d.gatewayTokenDraft || d.gatewayToken || '';
    document.getElementById('sbBrowserName').value  = d.browserNameDraft  || d.browserName  || '';
  } catch (_) {}

  // 3. Get status and route to correct page
  let s = null;
  try { s = await bg({ type: 'get_status' }); } catch (_) {}

  if (s) {
    STATE.wsConnected  = s.wsConnected  || false;
    STATE.reconnecting = s.reconnecting || false;
    STATE.channelName  = s.browserId    || '';

    if (s.pairingPending) {
      showPage('config');
      showPairingSection(s.deviceId);
    } else if (s.wsConnected) {
      showPage('chat');
      updateTaskBar(s.loop);
    } else {
      showPage('config');
      hidePairingSection();
      if (s.gaveUp) showRetryTip(); else hideRetryTip();
    }
  } else {
    showPage('config');
  }

  // 4. Load agents and resolve active tab
  await loadAgents();
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

// ── Config page events ──

document.getElementById('connectBtn').addEventListener('click', doConnect);

document.getElementById('disconnectBtn').addEventListener('click', doDisconnect);

document.getElementById('pairingCancelBtn').addEventListener('click', async () => {
  try { await bg({ type: 'disconnect' }); } catch(_) {}
  showPage('config');
  hidePairingSection();
  hideRetryTip();
});

document.getElementById('pairingCopyBtn').addEventListener('click', async () => {
  const deviceId = STATE.pairingDeviceId;
  if (!deviceId) return;
  const cmd = `openclaw devices approve ${deviceId}`;
  try {
    await navigator.clipboard.writeText(cmd);
    const btn = document.getElementById('pairingCopyBtn');
    const origHtml = btn.innerHTML;
    btn.innerHTML = `<svg class="icon" width="14" height="14"><use href="#icon-check"></use></svg>`;
    setTimeout(() => { btn.innerHTML = origHtml; }, 2000);
  } catch (_) {}
});

// Lang toggles (both config and chat pages)
function handleLangToggle() {
  sbLang = sbLang === 'en' ? 'zh' : 'en';
  chrome.storage.local.set({ lang: sbLang });
  applyI18n();
  updateStatus();
}
document.getElementById('langToggle').addEventListener('click', handleLangToggle);
document.getElementById('langToggleChat').addEventListener('click', handleLangToggle);

// Export / import
document.getElementById('exportConfigBtn').addEventListener('click', doExport);
document.getElementById('importConfigBtn').addEventListener('click', () => {
  document.getElementById('importFile').click();
});
document.getElementById('importFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  await doImport(file);
  e.target.value = '';
});

// Diagnostic logs — both the chat-header icon button and the config-page row
// trigger the same export / clear flow.
document.getElementById('exportLogsBtn')?.addEventListener('click', exportLogs);
document.getElementById('exportLogsBtnConfig')?.addEventListener('click', exportLogs);
document.getElementById('clearLogsBtn')?.addEventListener('click', clearLogs);

// Token eye toggle
document.getElementById('toggleToken').addEventListener('click', () => {
  const inp = document.getElementById('sbGatewayToken');
  inp.type = inp.type === 'password' ? 'text' : 'password';
});

// Form draft auto-save
['sbGatewayUrl', 'sbGatewayToken', 'sbBrowserName'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', saveDraft);
});

// ── Chat page events ──

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
  if (STATE.attachments.length > 0) showPickAutocomplete();
  else hidePickAutocomplete();
});

document.getElementById('msgInput').addEventListener('blur', () => {
  setTimeout(hidePickAutocomplete, 150);
});

document.getElementById('agentSelect').addEventListener('change', e => {
  switchAgent(e.target.value);
});

// Task cancel
document.getElementById('taskCancelBtn').addEventListener('click', async () => {
  try { await bg({ type: 'cancel' }); } catch(_) {}
});

// Task thumbnail → lightbox
document.getElementById('taskThumb').addEventListener('click', () => {
  const src = document.getElementById('taskThumb').src;
  if (!src) return;
  const lb    = document.getElementById('lightbox');
  const lbImg = document.getElementById('lightboxImg');
  if (lb && lbImg) {
    lbImg.src = src;
    lb.style.display = 'flex';
  }
});

// Lightbox dismiss
document.getElementById('lightbox').addEventListener('click', () => {
  document.getElementById('lightbox').style.display = 'none';
});

// Open chat-bubble links in a new browser tab. The sidepanel itself is too
// small to host arbitrary URLs and target="_blank" alone is unreliable here,
// so go through chrome.tabs.create.
document.getElementById('messages').addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (!href || !/^https?:\/\//i.test(href)) return;
  e.preventDefault();
  chrome.tabs.create({ url: href, active: true }).catch(() => {
    window.open(href, '_blank', 'noopener,noreferrer');
  });
});

// ── Background messages ──

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'status_update') {
    const wasConnected = STATE.wsConnected;
    const prevChannel  = STATE.channelName;
    STATE.wsConnected  = msg.wsConnected  || false;
    STATE.reconnecting = msg.reconnecting || false;
    STATE.channelName  = msg.browserId    || STATE.channelName;

    // ── Page routing ──
    if (msg.pairingPending) {
      STATE.connecting = false;
      showPage('config');
      showPairingSection(msg.deviceId);
    } else if (msg.wsConnected) {
      STATE.connecting = false;
      showPage('chat');
      hidePairingSection();
      hideRetryTip();
      updateTaskBar(msg.loop);
    } else {
      // Not connected and not pairing — clear connecting flag on definitive outcomes
      if (!msg.reconnecting || msg.gaveUp) STATE.connecting = false;
      showPage('config');
      hidePairingSection();
      if (msg.gaveUp) showRetryTip(); else hideRetryTip();
    }

    updateStatus();

    if (!wasConnected && STATE.wsConnected) {
      const channelChanged = prevChannel && prevChannel !== STATE.channelName;
      if (channelChanged) {
        STATE.messages           = [];
        STATE.lastMsgId          = null;
        STATE.pendingEchoContent = null;
      }
      STATE.waiting = false;
      clearTimeout(STATE.waitingTimer);
      hideThinking();
      updateSendBtn();
      renderAll();
      fetchHistory();
      startPolling();

    } else if (wasConnected && !STATE.wsConnected) {
      exitPickModeUI();
      stopPolling();
      if (STATE.waiting) {
        STATE.waiting = false;
        clearTimeout(STATE.waitingTimer);
        hideThinking();
        updateSendBtn();
      }
      renderAll();
    }

    // Update task bar if already on chat page
    if (msg.wsConnected) updateTaskBar(msg.loop);
    return;
  }

  if (msg.type === 'element_picked') {
    exitPickModeUI();
    STATE.attachments.push(msg.element);
    renderAttachments();
    return;
  }

  if (msg.type === 'pick_mode_exited') {
    exitPickModeUI();
    return;
  }

  if (msg.type === 'tab_activated') {
    const prevTabId = STATE.activeTabId;
    const newTabId  = msg.tabId;
    if (prevTabId === newTabId) return;

    saveTabState(prevTabId);
    exitPickModeUI();
    STATE.activeTabId = newTabId;
    restoreTabState(newTabId);
    return;
  }
});

// ── Boot ───────────────────────────────────────────────────────────────────
init();

chrome.runtime.sendMessage({ type: 'sidebar_opened' }).catch(() => {});
clog('info', 'sidebar opened', { ua: navigator.userAgent });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    chrome.runtime.sendMessage({ type: 'sidebar_closed' }).catch(() => {});
  }
});

// Sync language if changed externally (e.g. by another session)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.lang) {
    sbLang = changes.lang.newValue || 'en';
    applyI18n();
    updateStatus();
    renderAll();
  }
});

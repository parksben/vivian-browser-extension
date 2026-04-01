/**
 * popup.js - ClawTab Popup Controller
 */

// ── i18n ───────────────────────────────────────────────────────────────────

const I18N = {
  zh: {
    config: '连接配置',
    browserName: '浏览器名称',
    browserNameHint: '（连接标识，可自定义）',
    connect: '保存并连接',
    disconnect: '断开',
    agents: '监控 Agent',
    agentsHint: '选择哪些 Agent 可以控制浏览器',
    status: '运行状态',
    browserIdLabel: '浏览器标识',
    tabsLabel: '监控标签页',
    lastCmd: '最后指令：',
    loading: '加载中…',
    noAgents: '未找到 Agent',
    loadFailed: '加载失败',
    connected: '已连接',
    connecting: '连接中…',
    pairing: '等待配对…',
    disconnected: '未连接',
    connecting2: '连接中…',
    task: '任务进度',
    cancelTask: '取消任务',
    taskRunning: '执行中',
    taskDone: '已完成',
    taskFailed: '失败',
    taskCancelled: '已取消',
  },
  en: {
    config: 'Connection',
    browserName: 'Browser Name',
    browserNameHint: '(custom identifier)',
    connect: 'Connect',
    disconnect: 'Disconnect',
    agents: 'Monitor Agents',
    agentsHint: 'Select agents allowed to control this browser',
    status: 'Status',
    browserIdLabel: 'Browser ID',
    tabsLabel: 'Active Tabs',
    lastCmd: 'Last Command:',
    loading: 'Loading…',
    noAgents: 'No agents found',
    loadFailed: 'Failed to load',
    connected: 'Connected',
    connecting: 'Connecting…',
    pairing: 'Awaiting pairing…',
    disconnected: 'Disconnected',
    connecting2: 'Connecting…',
    task: 'Task Progress',
    cancelTask: 'Cancel Task',
    taskRunning: 'Running',
    taskDone: 'Done',
    taskFailed: 'Failed',
    taskCancelled: 'Cancelled',
  }
};

let currentLang = 'zh';

function t(key) {
  return I18N[currentLang]?.[key] || I18N.zh[key] || key;
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  // 更新动态文字
  const statusTextEl = document.getElementById('statusText');
  if (statusTextEl && statusTextEl.dataset.status) {
    statusTextEl.textContent = t(statusTextEl.dataset.status) || statusTextEl.dataset.status;
  }
  document.getElementById('langBtn').textContent = currentLang === 'zh' ? 'EN' : '中文';
}

// ── DOM refs ───────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const statusDot      = $('statusDot');
const statusText     = $('statusText');
const langBtn        = $('langBtn');
const gatewayUrlInput  = $('gatewayUrl');
const gatewayTokenInput = $('gatewayToken');
const browserNameInput  = $('browserName');
const connectBtn     = $('connectBtn');
const disconnectBtn  = $('disconnectBtn');
const toggleTokenBtn = $('toggleToken');
const statGateway    = $('statGateway');
const statBrowserName = $('statBrowserName');
const statTabs       = $('statTabs');
const statLastCmd    = $('statLastCmd');
const agentSection   = $('agentSection');
const agentList      = $('agentList');

const taskSection    = $('taskSection');
const taskStatusBadge = $('taskStatusBadge');
const taskNameEl     = $('taskName');
const taskStepsEl    = $('taskSteps');
const cancelTaskBtn  = $('cancelTaskBtn');

const occupiedBanner = $('occupiedBanner');

// ── Task Panel ────────────────────────────────────────────────────────────

const STEP_ICON = { running: '⏳', done: '✅', failed: '❌', pending: '○' };
const STEP_TYPE_LABEL = { navigate: 'Navigate', execute_js: 'Execute JS', screenshot: 'Screenshot', get_content: 'Get Content', wait: 'Wait' };

function renderTask(task) {
  if (!task) { taskSection.style.display = 'none'; return; }
  taskSection.style.display = '';

  taskNameEl.textContent = task.name || task.id;

  const statusKey = { running: 'taskRunning', done: 'taskDone', failed: 'taskFailed', cancelled: 'taskCancelled' }[task.status] || 'taskRunning';
  taskStatusBadge.textContent = t(statusKey);
  taskStatusBadge.className = `task-status-badge ${task.status}`;

  taskStepsEl.innerHTML = '';
  task.steps.forEach((step, i) => {
    let stepStatus = 'pending';
    if (i < task.currentStep) stepStatus = task.results[i]?.ok === false ? 'failed' : 'done';
    else if (i === task.currentStep && task.status === 'running') stepStatus = 'running';
    else if (task.status === 'done') stepStatus = task.results[i]?.ok === false ? 'failed' : 'done';

    const row = document.createElement('div');
    row.className = `task-step ${stepStatus}`;
    row.innerHTML = `<span class="step-icon">${STEP_ICON[stepStatus]}</span><span class="step-label">${step.label || STEP_TYPE_LABEL[step.type] || step.type}</span>`;
    taskStepsEl.appendChild(row);
  });

  cancelTaskBtn.style.display = task.status === 'running' ? '' : 'none';
}

cancelTaskBtn.addEventListener('click', async () => {
  try { await chrome.runtime.sendMessage({ type: 'task_cancel' }); } catch (_) {}
});

// ── Status UI ─────────────────────────────────────────────────────────────

const STATUS_DOT = {
  connected: 'connected',
  connecting: 'connecting',
  pairing: 'connecting',
  disconnected: 'disconnected',
};

function updateStatusUI(status, data = {}) {
  const dotClass = STATUS_DOT[status] || 'disconnected';
  statusDot.className = `status-dot ${dotClass}`;
  statusText.dataset.status = status;
  statusText.textContent = t(status) || status;

  if (data.wsUrl) {
    let display = data.wsUrl;
    try { display = new URL(data.wsUrl).host; } catch (_) {}
    statGateway.textContent = display;
    statGateway.title = data.wsUrl;
  } else if (status === 'disconnected') {
    statGateway.textContent = '—';
  }

  if (data.browserName !== undefined) statBrowserName.textContent = data.browserName || '—';
  if (data.tabCount !== undefined) statTabs.textContent = data.tabCount;
  if (data.lastCommand) statLastCmd.textContent = data.lastCommand;

  if (status === 'connected') {
    agentSection.style.display = '';
    loadAgents();
  } else {
    agentSection.style.display = 'none';
  }
}

// ── Agent list ────────────────────────────────────────────────────────────

async function loadAgents() {
  agentList.innerHTML = `<div class="agent-loading">${t('loading')}</div>`;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'agents_list' });
    const agents = resp?.agents || [];
    const { selectedAgents } = await chrome.storage.local.get(['selectedAgents']);
    const selected = new Set(selectedAgents || agents);

    if (agents.length === 0) {
      // 加载失败时展示手动输入区域
      agentList.innerHTML = `
        <div class="agent-loading" style="margin-bottom:6px;">${t('noAgents')}</div>
        <div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">手动添加 Agent ID：</div>
        <div style="display:flex;gap:6px;">
          <input type="text" id="manualAgentInput" placeholder="main" style="flex:1;font-size:12px;padding:5px 8px;border:1.5px solid #e2e8f0;border-radius:8px;background:#f8fafc;outline:none;" />
          <button id="manualAgentAdd" style="padding:5px 10px;background:#6366f1;color:#fff;border:none;border-radius:8px;font-size:11px;font-weight:600;cursor:pointer;">添加</button>
        </div>`;
      document.getElementById('manualAgentAdd')?.addEventListener('click', async () => {
        const val = document.getElementById('manualAgentInput')?.value.trim();
        if (!val) return;
        const { selectedAgents: prev } = await chrome.storage.local.get(['selectedAgents']);
        const next = [...new Set([...(prev || []), val])];
        await chrome.storage.local.set({ selectedAgents: next });
        chrome.runtime.sendMessage({ type: 'update_selected_agents', agents: next }).catch(() => {});
        loadAgents();
      });
      return;
    }

    agentList.innerHTML = '';
    agents.forEach(agentId => {
      const row = document.createElement('label');
      row.className = 'agent-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.className = 'agent-cb'; cb.value = agentId;
      cb.checked = selected.has(agentId);
      cb.addEventListener('change', saveSelectedAgents);
      const icon = document.createElement('span');
      icon.className = 'agent-icon';
      icon.textContent = agentId === 'main' ? '🤖' : agentId.includes('wechat') ? '💬' : '🔹';
      const label = document.createElement('span');
      label.className = 'agent-label'; label.textContent = agentId;
      row.append(cb, icon, label);
      agentList.appendChild(row);
    });
  } catch (e) {
    agentList.innerHTML = `<div class="agent-loading">${t('loadFailed')}</div>`;
  }
}

async function saveSelectedAgents() {
  const selected = [...agentList.querySelectorAll('input[type=checkbox]')]
    .filter(cb => cb.checked).map(cb => cb.value);
  await chrome.storage.local.set({ selectedAgents: selected });
  chrome.runtime.sendMessage({ type: 'update_selected_agents', agents: selected }).catch(() => {});
}

// ── Draft auto-save ───────────────────────────────────────────────────────

let draftTimer = null;
function scheduleDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 600);
}

async function saveDraft() {
  await chrome.storage.local.set({
    gatewayUrlDraft: gatewayUrlInput.value.trim(),
    gatewayTokenDraft: gatewayTokenInput.value.trim(),
    browserNameDraft: browserNameInput.value.trim(),
  });
}

gatewayUrlInput.addEventListener('input', scheduleDraftSave);
gatewayTokenInput.addEventListener('input', scheduleDraftSave);
browserNameInput.addEventListener('input', scheduleDraftSave);

// ── Load config ───────────────────────────────────────────────────────────

async function loadConfig() {
  const data = await chrome.storage.local.get([
    'gatewayUrl', 'gatewayToken', 'browserName',
    'gatewayUrlDraft', 'gatewayTokenDraft', 'browserNameDraft',
    'lang',
  ]);
  gatewayUrlInput.value   = data.gatewayUrlDraft   || data.gatewayUrl   || '';
  gatewayTokenInput.value = data.gatewayTokenDraft || data.gatewayToken || '';
  browserNameInput.value  = data.browserNameDraft  || data.browserName  || '';
  if (data.lang) currentLang = data.lang;
  applyI18n();
}

// ── Fetch status ──────────────────────────────────────────────────────────

async function fetchStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'get_status' });
    if (resp) updateStatusUI(resp.status, { wsUrl: resp.wsUrl, browserName: resp.browserName, tabCount: resp.tabCount, lastCommand: resp.lastCommand });
    if (resp?.currentTask) renderTask(resp.currentTask);
    if (resp?.occupiedByAgent) { occupiedBanner.style.display = ''; occupiedBanner.textContent = `🔒 Occupied by agent: ${resp.occupiedByAgent}`; }
    else { occupiedBanner.style.display = 'none'; }
  } catch (e) {
    updateStatusUI('disconnected');
  }
}

// ── Connect ───────────────────────────────────────────────────────────────

connectBtn.addEventListener('click', async () => {
  const url   = gatewayUrlInput.value.trim();
  const token = gatewayTokenInput.value.trim();
  const name  = browserNameInput.value.trim() || ('Browser-' + Math.random().toString(36).slice(2, 6));

  if (!url) { gatewayUrlInput.classList.add('input-error'); setTimeout(() => gatewayUrlInput.classList.remove('input-error'), 1500); gatewayUrlInput.focus(); return; }
  if (!token) { gatewayTokenInput.classList.add('input-error'); setTimeout(() => gatewayTokenInput.classList.remove('input-error'), 1500); gatewayTokenInput.focus(); return; }

  await chrome.storage.local.set({ gatewayUrl: url, gatewayToken: token, browserName: name, gatewayUrlDraft: url, gatewayTokenDraft: token, browserNameDraft: name });

  updateStatusUI('connecting', { wsUrl: url });
  connectBtn.disabled = true;
  connectBtn.textContent = t('connecting2');

  try { await chrome.runtime.sendMessage({ type: 'connect', url, token, name }); } catch (e) {}

  setTimeout(async () => {
    connectBtn.disabled = false;
    connectBtn.textContent = t('connect');
    await fetchStatus();
  }, 1500);
});

// ── Disconnect ────────────────────────────────────────────────────────────

disconnectBtn.addEventListener('click', async () => {
  try { await chrome.runtime.sendMessage({ type: 'disconnect' }); } catch (e) {}
  updateStatusUI('disconnected', { tabCount: 0, lastCommand: '—' });
});

// ── Toggle token visibility ───────────────────────────────────────────────

toggleTokenBtn.addEventListener('click', () => {
  gatewayTokenInput.type = gatewayTokenInput.type === 'password' ? 'text' : 'password';
});

// ── Language toggle ───────────────────────────────────────────────────────

langBtn.addEventListener('click', async () => {
  currentLang = currentLang === 'zh' ? 'en' : 'zh';
  await chrome.storage.local.set({ lang: currentLang });
  applyI18n();
  // 重新渲染 agent loading 状态文字（如果在加载中）
  const loadingEl = agentList.querySelector('.agent-loading');
  if (loadingEl) loadingEl.textContent = t('loading');
});

// ── Background status push ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'status_update') {
    updateStatusUI(msg.status, { wsUrl: msg.wsUrl, browserName: msg.browserName, tabCount: msg.tabCount, lastCommand: msg.lastCommand });
  }
  if (msg.type === 'task_update') { renderTask(msg.task); }
  if (msg.type === 'occupied_update') {
    if (msg.agentId) { occupiedBanner.style.display = ''; occupiedBanner.textContent = `🔒 Occupied by agent: ${msg.agentId}`; }
    else { occupiedBanner.style.display = 'none'; }
  }
});

// ── Init ──────────────────────────────────────────────────────────────────

(async () => {
  await loadConfig();
  await fetchStatus();
})();

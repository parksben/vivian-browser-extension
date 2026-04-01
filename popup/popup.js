/**
 * popup.js - ClawTab Popup Controller
 */

// ── i18n ───────────────────────────────────────────────────────────────────

const I18N = {
  zh: {
    config: '连接配置',
    browserName: '浏览器名称',
    browserNameHint: '（连接标识）',
    connect: '保存并连接',
    disconnect: '断开',
    status: '运行状态',
    browserIdLabel: '浏览器标识',
    tabsLabel: '监控标签页',
    lastCmd: '最后指令：',
    connected: '已连接',
    connecting: '连接中… ⏳',
    pairing: '等待配对批准…',
    disconnected: '未连接',
    connecting2: '连接中…',
    task: '任务进度',
    cancelTask: '取消任务',
    taskRunning: '执行中',
    taskDone: '已完成',
    taskFailed: '失败',
    taskCancelled: '已取消',
    pairingHint: '请在 Gateway 运行 openclaw devices approve 批准连接',
  },
  en: {
    config: 'Connection',
    browserName: 'Browser Name',
    browserNameHint: '(identifier)',
    connect: 'Connect',
    disconnect: 'Disconnect',
    status: 'Status',
    browserIdLabel: 'Browser ID',
    tabsLabel: 'Active Tabs',
    lastCmd: 'Last Command:',
    connected: 'Connected',
    connecting: 'Connecting… ⏳',
    pairing: 'Awaiting pairing approval…',
    disconnected: 'Disconnected',
    connecting2: 'Connecting…',
    task: 'Task Progress',
    cancelTask: 'Cancel Task',
    taskRunning: 'Running',
    taskDone: 'Done',
    taskFailed: 'Failed',
    taskCancelled: 'Cancelled',
    pairingHint: 'Run: openclaw devices approve on your Gateway',
  }
};

let currentLang = 'en'; // 默认英文

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
const statusDot       = $('statusDot');
const statusText      = $('statusText');
const langBtn         = $('langBtn');
const gatewayUrlInput = $('gatewayUrl');
const gatewayTokenInput = $('gatewayToken');
const browserNameInput  = $('browserName');
const connectBtn      = $('connectBtn');
const disconnectBtn   = $('disconnectBtn');
const toggleTokenBtn  = $('toggleToken');
const statGateway     = $('statGateway');
const statBrowserName = $('statBrowserName');
const statTabs        = $('statTabs');
const statLastCmd     = $('statLastCmd');
const taskSection     = $('taskSection');
const taskStatusBadge = $('taskStatusBadge');
const taskNameEl      = $('taskName');
const taskStepsEl     = $('taskSteps');
const cancelTaskBtn   = $('cancelTaskBtn');
const occupiedBanner  = $('occupiedBanner');
const pairingBanner   = $('pairingBanner');

// ── Task Panel ────────────────────────────────────────────────────────────

function renderTask(data) {
  const { taskStatus, taskName, taskAgentId, taskSteps, taskCurrentStep, taskResults } = data;
  if (!taskStatus || taskStatus === 'idle' || !taskSteps?.length) {
    taskSection.style.display = 'none'; return;
  }
  taskSection.style.display = '';

  const statusKey = { running: 'taskRunning', done: 'taskDone', failed: 'taskFailed', cancelled: 'taskCancelled' }[taskStatus] || 'taskRunning';
  taskStatusBadge.textContent = t(statusKey);
  taskStatusBadge.className = `task-status-badge ${taskStatus}`;
  taskNameEl.textContent = `${taskAgentId ? '['+taskAgentId+'] ' : ''}${taskName || ''}`;

  taskStepsEl.innerHTML = '';
  taskSteps.forEach((step, i) => {
    let s = 'pending';
    if (taskStatus === 'done') s = (taskResults?.[i]?.ok === false) ? 'failed' : 'done';
    else if (i < taskCurrentStep) s = (taskResults?.[i]?.ok === false) ? 'failed' : 'done';
    else if (i === taskCurrentStep && taskStatus === 'running') s = 'running';

    const row = document.createElement('div');
    row.className = `task-step ${s}`;
    const icons = { running:'⏳', done:'✅', failed:'❌', pending:'○' };
    row.innerHTML = `<span class="step-icon">${icons[s]}</span><span class="step-label">${step.label || step.type}</span>`;
    taskStepsEl.appendChild(row);
  });

  cancelTaskBtn.style.display = taskStatus === 'running' ? '' : 'none';
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

function updateStatusUI(data) {
  const connected = data.wsConnected;
  const taskRunning = data.taskStatus === 'running';

  // WS 状态
  const dotClass = taskRunning ? 'running' : connected ? 'connected' : 'disconnected';
  statusDot.className = `status-dot ${dotClass}`;
  statusDot.style.background = taskRunning ? '#22c55e' : '';

  const statusKey = taskRunning ? 'taskRunning' : connected ? 'connected' : 'disconnected';
  statusText.dataset.status = statusKey;
  statusText.textContent = t(statusKey);

  // Stats
  if (data.wsUrl) {
    try { statGateway.textContent = new URL(data.wsUrl).host; statGateway.title = data.wsUrl; }
    catch(_) { statGateway.textContent = data.wsUrl; }
  } else { statGateway.textContent = '—'; }
  statBrowserName.textContent = data.browserId || '—';
  statTabs.textContent = data.tabCount ?? 0;
  if (data.lastCmd) statLastCmd.textContent = data.lastCmd;

  // 配对提示
  const needsPairing = !data.wsConnected && data.pairingPending;
  if (needsPairing) {
    pairingBanner.style.display = '';
    pairingBanner.innerHTML = `⏳ ${t('pairing')}<br><code>openclaw devices approve</code>`;
  } else {
    pairingBanner.style.display = 'none';
  }

  // 占用 banner
  if (data.taskStatus === 'running' && data.taskAgentId) {
    occupiedBanner.style.display = '';
    occupiedBanner.textContent = `🔒 ${data.taskAgentId} · ${data.taskName || data.taskCmdId || ''}`;
  } else { occupiedBanner.style.display = 'none'; }

  // 任务面板
  renderTask(data);
}

// ── Agent list ────────────────────────────────────────────────────────────

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
    if (resp) updateStatusUI(resp);
  } catch (e) {
    updateStatusUI({ wsConnected: false });
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
  }, 1500);});

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
  if (msg.type === 'status_update') updateStatusUI(msg);
});

// ── Init ──────────────────────────────────────────────────────────────────

(async () => {
  await loadConfig();
  await fetchStatus();
})();

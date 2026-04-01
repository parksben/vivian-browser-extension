/**
 * popup.js - ClawTab v3
 */

// ── i18n ─────────────────────────────────────────────────────────────────
const I18N = {
  en: {
    config: 'Connection', browserName: 'Browser Name', browserNameHint: '(identifier)',
    connect: 'Connect', disconnect: 'Disconnect',
    browserIdLabel: 'Browser ID', tabsLabel: 'Tabs',
    cancel: 'Cancel Task',
    idle: 'Ready',
    connecting: 'Connecting…',
    disconnected: 'Disconnected',
    perceiving: 'Analyzing page…',
    thinking: 'Thinking…',
    acting: 'Executing…',
    done: 'Task complete',
    failed: 'Task failed',
    cancelled: 'Cancelled',
    // pairing
    pairingTitle: '🔗 Pairing required',
    pairingDesc: 'Send this pairing code to your OpenClaw agent to complete the setup:',
    pairingCmd: 'Or run on your Gateway:',
    switchLang: '切换中文',
    pairingOr: '或在服务器上运行：',
    pairingCopy: '已复制！',
    cancel: '取消',
    connFailed: '连接失败，请检查配置',
    notConfigured: '未配置',
    exportConfig: 'Export config…',
    importConfig: 'Import config…',
    exportSuccess: 'Config exported!',
    importSuccess: 'Config imported!',
    importError: 'Invalid config file',
    // loop status texts
    loopIdle: 'Ready — waiting for instructions',
    loopPerceiving: 'Capturing page snapshot…',
    loopThinking: 'Analyzing result',
    loopActing: 'Executing action',
    loopDone: 'All done ✅',
    loopFailed: 'Something went wrong',
    loopCancelled: 'Task cancelled',
  },
  zh: {
    config: '连接配置', browserName: '浏览器名称', browserNameHint: '（标识）',
    connect: '保存并连接', disconnect: '断开',
    browserIdLabel: '标识', tabsLabel: '标签页',
    cancel: '取消任务',
    idle: '就绪',
    connecting: '连接中…',
    disconnected: '未连接',
    perceiving: '分析页面中…',
    thinking: '思考中…',
    acting: '执行操作中…',
    done: '任务完成',
    failed: '任务失败',
    cancelled: '已取消',
    // pairing
    pairingTitle: '🔗 需要配对',
    pairingDesc: '将以下配对码发送给 OpenClaw Agent 完成绑定：',
    pairingCmd: '或在 Gateway 上运行：',
    switchLang: 'Switch to English',
    pairingOr: 'Or run on your server:',
    pairingCopy: 'Copied!',
    cancel: 'Cancel',
    connFailed: 'Connection failed — check config',
    notConfigured: 'Not configured',
    exportConfig: '导出配置…',
    importConfig: '导入配置…',
    exportSuccess: '配置已导出！',
    importSuccess: '配置已导入！',
    importError: '无效的配置文件',
    // loop status texts
    loopIdle: '就绪，等待指令',
    loopPerceiving: '正在截图并分析页面…',
    loopThinking: '正在分析结果',
    loopActing: '正在执行操作',
    loopDone: '全部完成 ✅',
    loopFailed: '任务遇到错误',
    loopCancelled: '任务已取消',
  },
};
let lang = 'en';
const t = k => I18N[lang]?.[k] || I18N.en[k] || k;

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  $('langBtn').textContent = lang === 'en' ? '中文' : 'EN';
}

// ── DOM refs ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── State ─────────────────────────────────────────────────────────────────
let lastData = null;
let configCollapsed = false;

// ── Status dot mapping ────────────────────────────────────────────────────
const DOT_CLASS = {
  connected:'connected', perceiving:'perceiving', thinking:'thinking',
  acting:'acting', done:'done', failed:'failed', cancelled:'failed',
  pairing:'pairing', disconnected:'',
};

// ── Main render ───────────────────────────────────────────────────────────
function render(data) {
  lastData = data;
  const { wsConnected, pairingPending, reconnecting, gaveUp, loop, browserId, wsUrl, tabCount } = data;

  // Status badge
  const loopStatus = loop?.status || 'idle';
  const dotClass = (wsConnected || reconnecting) ? (DOT_CLASS[loopStatus] || 'connected') : (pairingPending ? 'pairing' : 'disconnected');
  $('statusDot').className = `status-dot ${dotClass}`;
  const statusKey = wsConnected ? loopStatus : (pairingPending ? 'pairing' : 'disconnected');
  $('statusText').textContent = wsConnected
    ? (() => {
      const keyMap = {idle:'loopIdle',perceiving:'loopPerceiving',thinking:'loopThinking',
        acting:'loopActing',done:'loopDone',failed:'loopFailed',cancelled:'loopCancelled'};
      return loop?.statusText || t(keyMap[loopStatus]) || loopStatus;
    })()
    : pairingPending ? t('pairingTitle')
    : reconnecting  ? t('connecting')
    : gaveUp ? t('connFailed')
    : t('notConfigured');

  // Config section: 未连接 且 不在重连中 才显示
  $('configSection').style.display = (wsConnected || reconnecting || pairingPending) ? 'none' : '';
  // 3次重连失败后，显示错误提示
  const retryTip = $('retryTip');
  if (retryTip) retryTip.style.display = gaveUp ? '' : 'none';

  // Pairing section（大面板）
  const pairSec = $('pairingSection');
  if (pairingPending) {
    pairSec.style.display = '';
    const deviceId = data.deviceId || '';
    $('pairingCodeText').textContent = deviceId ? deviceId.slice(0,24)+'…' : '—';
    $('pairingCmd').textContent = deviceId ? `openclaw devices approve ${deviceId.slice(0,16)}` : 'openclaw devices approve';
    $('pairingCopyBtn').onclick = async () => {
      const cmd = `openclaw devices approve ${deviceId}`;
      await navigator.clipboard.writeText(cmd).catch(()=>{});
      $('pairingCopyBtn').textContent = '✓';
      setTimeout(()=>{ $('pairingCopyBtn').textContent = '⎘'; }, 2000);
    };
  } else {
    pairSec.style.display = 'none';
  }

  // 连接成功后显示断联按钮，隐藏品牌标题（节省空间）
  $('brandArea').style.display = wsConnected ? 'none' : '';
  $('disconnectInlineBtn').style.display = wsConnected ? '' : 'none';

  // Loop section: 只在任务执行中显示（非 idle）
  const loopEl = $('loopSection');
  const hasTask = (wsConnected || reconnecting) && loop?.status && loop.status !== 'idle';
  if (hasTask) {
    loopEl.style.display = '';
    renderLoop(loop);
  } else {
    loopEl.style.display = 'none';
  }

  // Stats bar
  const statsBar = $('statsBar');
  if (wsConnected || reconnecting) {
    statsBar.style.display = '';
    let gw = '—';
    try { gw = new URL(wsUrl).host; } catch(_) { gw = wsUrl || '—'; }
    $('statGateway').textContent = gw;
    $('statBrowserName').textContent = browserId || '—';
    $('statTabs').textContent = tabCount ?? 0;
  } else {
    statsBar.style.display = 'none';
  }
}

function renderLoop(loop) {
  if (!loop) return;
  const { status, goal, agentId, stepIndex, history, lastScreenshot, lastUrl, lastTitle, statusText, errorMsg, startedAt } = loop;

  // Goal
  const goalEl = $('loopGoal');
  if (goal) {
    goalEl.style.display = '';
    goalEl.textContent = `🎯 ${goal}`;
  } else {
    goalEl.style.display = 'none';
  }

  // Indicator + status text
  const ind = $('loopIndicator');
  ind.className = `loop-indicator ${status}`;

  const stEl = $('loopStatusText');
  stEl.className = `loop-status-text ${status}`;

  // 状态文字：优先用 background 下发的 statusText，否则用 i18n
  const loopI18nKey = {
    idle: 'loopIdle', perceiving: 'loopPerceiving', thinking: 'loopThinking',
    acting: 'loopActing', done: 'loopDone', failed: 'loopFailed', cancelled: 'loopCancelled',
  }[status] || 'loopIdle';
  const displayText = (statusText && statusText !== t(status)) ? statusText : t(loopI18nKey);

  if (status === 'thinking') {
    stEl.classList.add('thinking-dots');
    stEl.textContent = t('loopThinking').replace('…','').replace('中','');
  } else {
    stEl.classList.remove('thinking-dots');
    stEl.textContent = displayText;
  }

  // Step counter
  $('loopStep').textContent = stepIndex > 0 ? `Step ${stepIndex}` : '';

  // Screenshot
  const swrap = $('screenshotWrap');
  if (lastScreenshot && status !== 'idle') {
    swrap.style.display = '';
    $('screenshotImg').src = lastScreenshot;
    $('screenshotLabel').textContent = lastTitle || lastUrl || '';
    swrap.className = `screenshot-wrap${status === 'perceiving' ? ' scanning' : ''}`;
  } else {
    swrap.style.display = 'none';
  }

  // History
  const histEl = $('historyList');
  const recent = (history || []).slice(-6);
  if (recent.length > 0) {
    histEl.style.display = '';
    histEl.innerHTML = '';
    recent.forEach(h => {
      const item = document.createElement('div');
      const isLast = h === recent[recent.length - 1];
      const running = isLast && ['acting', 'perceiving'].includes(status);
      item.className = `history-item ${running ? 'running' : h.status}`;
      const icon = running ? '⏳' : h.status === 'done' ? '✅' : h.status === 'failed' ? '❌' : '○';
      const ms = h.durationMs ? `${(h.durationMs/1000).toFixed(1)}s` : '';
      item.innerHTML = `<span class="h-icon">${icon}</span><span class="h-desc ${h.status==='failed'?'failed':''}">${escHtml(h.desc||h.op)}</span><span class="h-time">${ms}</span>`;
      histEl.appendChild(item);
    });
  } else {
    histEl.style.display = 'none';
  }

  // Cancel button
  const cancelRow = $('cancelRow');
  cancelRow.style.display = ['acting','perceiving','thinking'].includes(status) ? '' : 'none';
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function collapseConfig(collapse) {
  configCollapsed = collapse;
  $('configBody').style.display = collapse ? 'none' : '';
  $('collapseConfig').textContent = collapse ? '▸' : '▾';
}

// ── Config collapse toggle ────────────────────────────────────────────────
$('collapseConfig').addEventListener('click', () => collapseConfig(!configCollapsed));

// ── Screenshot lightbox ───────────────────────────────────────────────────
$('screenshotWrap').addEventListener('click', () => {
  if (!lastData?.loop?.lastScreenshot) return;
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML = `<img src="${lastData.loop.lastScreenshot}" />`;
  lb.addEventListener('click', () => lb.remove());
  document.body.appendChild(lb);
});

// ── Draft auto-save ───────────────────────────────────────────────────────
let draftTimer;
function scheduleDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(async () => {
    await chrome.storage.local.set({
      gatewayUrlDraft: $('gatewayUrl').value.trim(),
      gatewayTokenDraft: $('gatewayToken').value.trim(),
      browserNameDraft: $('browserName').value.trim(),
    });
  }, 600);
}
['gatewayUrl','gatewayToken','browserName'].forEach(id => $(`${id}`).addEventListener('input', scheduleDraft));

// ── Load config ───────────────────────────────────────────────────────────
async function loadConfig() {
  const d = await chrome.storage.local.get([
    'gatewayUrl','gatewayToken','browserName',
    'gatewayUrlDraft','gatewayTokenDraft','browserNameDraft','lang',
  ]);
  $('gatewayUrl').value   = d.gatewayUrlDraft   || d.gatewayUrl   || '';
  $('gatewayToken').value = d.gatewayTokenDraft || d.gatewayToken || '';
  $('browserName').value  = d.browserNameDraft  || d.browserName  || '';
  if (d.lang) lang = d.lang;
  applyI18n();
}

// ── Connect ───────────────────────────────────────────────────────────────
$('connectBtn').addEventListener('click', async () => {
  const url   = $('gatewayUrl').value.trim();
  const token = $('gatewayToken').value.trim();
  const name  = $('browserName').value.trim() || ('browser-'+Math.random().toString(36).slice(2,6));
  if (!url)   { $('gatewayUrl').classList.add('input-error'); setTimeout(()=>$('gatewayUrl').classList.remove('input-error'),1500); return; }
  if (!token) { $('gatewayToken').classList.add('input-error'); setTimeout(()=>$('gatewayToken').classList.remove('input-error'),1500); return; }
  await chrome.storage.local.set({gatewayUrl:url,gatewayToken:token,browserName:name,
    gatewayUrlDraft:url,gatewayTokenDraft:token,browserNameDraft:name});
  $('connectBtn').disabled = true;
  $('connectBtn').textContent = t('connecting') || 'Connecting…';
  // 不立刻改 UI 状态，等 background 推送真实状态
  try { await chrome.runtime.sendMessage({type:'connect',url,token,name}); } catch(_){}
  setTimeout(async ()=>{ $('connectBtn').disabled=false; $('connectBtn').textContent=t('connect'); await fetchStatus(); },1500);
});

async function doDisconnect() {
  try { await chrome.runtime.sendMessage({type:'disconnect'}); } catch(_){}
  render({wsConnected:false,pairingPending:false,reconnecting:false,gaveUp:false,tabCount:0,loop:{status:'idle'}});
}
$('disconnectInlineBtn').addEventListener('click', doDisconnect);

$('toggleToken').addEventListener('click', () => {
  const inp = $('gatewayToken');
  inp.type = inp.type==='password' ? 'text' : 'password';
});

$('cancelBtn').addEventListener('click', async () => {
  try { await chrome.runtime.sendMessage({type:'cancel'}); } catch(_){}
});

// ── Settings menu (event delegation on document) ─────────────────────────
function openSettingsMenu() {
  const m = document.getElementById('settingsMenu');
  if (!m) return;
  m.style.cssText = 'display:block;position:absolute;right:0;top:calc(100% + 6px);background:#fff;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.15);min-width:160px;z-index:9999;border:1px solid #e2e8f0;overflow:hidden;';
}
function closeSettingsMenu() {
  const m = document.getElementById('settingsMenu');
  if (m) m.style.display = 'none';
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('#settingsBtn');
  const menu = e.target.closest('#settingsMenu');
  if (btn) {
    e.stopPropagation();
    const m = document.getElementById('settingsMenu');
    if (m && m.style.display === 'block') closeSettingsMenu();
    else openSettingsMenu();
    return;
  }
  if (!menu) closeSettingsMenu();
});

// Lang toggle
$('langToggle').addEventListener('click', async () => {
  lang = lang==='en' ? 'zh' : 'en';
  await chrome.storage.local.set({lang});
  applyI18n();
  if (lastData) render(lastData);
  closeSettingsMenu();
});

// Export config
$('exportConfig').addEventListener('click', async () => {
  const d = await chrome.storage.local.get(['gatewayUrl','gatewayToken','browserName']);
  const cfg = { gatewayUrl: d.gatewayUrl||'', gatewayToken: d.gatewayToken||'', browserName: d.browserName||'', _clawtab: true };
  const json = JSON.stringify(cfg, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'clawtab-config.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  closeSettingsMenu();
});

// Import config
$('importConfig').addEventListener('click', () => {
  $('importFile').click();
  closeSettingsMenu();
});

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0]; if (!file) return;
  try {
    const text = await file.text();
    const cfg = JSON.parse(text);
    if (!cfg._clawtab && !cfg.gatewayUrl) throw new Error('invalid');
    const url = cfg.gatewayUrl||''; const token = cfg.gatewayToken||''; const name = cfg.browserName||'';
    // 存储
    await chrome.storage.local.set({ gatewayUrl:url, gatewayToken:token, browserName:name,
      gatewayUrlDraft:url, gatewayTokenDraft:token, browserNameDraft:name });
    // 填入表单
    $('gatewayUrl').value = url;
    $('gatewayToken').value = token;
    $('browserName').value = name;
    // 断开当前连接，展示配置区让用户确认后重新连接
    try { await chrome.runtime.sendMessage({type:'disconnect'}); } catch(_){}
    $('configSection').style.display = '';
    $('loopSection').style.display = 'none';
    $('statsBar').style.display = 'none';
    showToast(t('importSuccess'));
  } catch(_) {
    showToast(t('importError'), true);
  }
  e.target.value = '';
});

// ── Toast ────────────────────────────────────────────────────────────────
function showToast(msg, isError=false) {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;bottom:12px;left:50%;transform:translateX(-50%);
    background:${isError?'#fee2e2':'#f0fdf4'};color:${isError?'#b91c1c':'#15803d'};
    padding:7px 14px;border-radius:8px;font-size:11px;font-weight:600;
    box-shadow:0 2px 8px rgba(0,0,0,.12);z-index:999;white-space:nowrap;`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(()=>el.remove(), 2500);
}


// Pairing cancel
$('pairingCancelBtn').addEventListener('click', async () => {
  try { await chrome.runtime.sendMessage({type:'disconnect'}); } catch(_){}
  render({wsConnected:false,pairingPending:false,reconnecting:false,gaveUp:false,tabCount:0,loop:{status:'idle'}});
});
// ── Fetch status ──────────────────────────────────────────────────────────
async function fetchStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({type:'get_status'});
    if (resp) render(resp);
  } catch(_) { render({wsConnected:false,pairingPending:false,reconnecting:false,gaveUp:false,tabCount:0,browserId:'',wsUrl:'',loop:{status:'idle'}}); }
}

// ── Background push ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type==='status_update') render(msg);
});

// ── Init ──────────────────────────────────────────────────────────────────
(async () => {
  await loadConfig();
  // 先检查是否有保存配置，有则先显示 connecting（等 SW 重连）
  const saved = await chrome.storage.local.get(['gatewayUrl','gatewayToken']);
  if (saved.gatewayUrl && saved.gatewayToken) {
    // 有配置：先显示 connecting 占位
    $('configSection').style.display = 'none';
    $('statsBar').style.display = 'none';
    $('loopSection').style.display = 'none';
    $('statusDot').className = 'status-dot pairing';
    $('statusText').textContent = t('connecting');
  } else {
    // 无配置：显示 notConfigured
    $('statusDot').className = 'status-dot disconnected';
    $('statusText').textContent = t('notConfigured');
  }
  // 实际状态 500ms 后从 background 拉取（给 SW 重连时间）
  setTimeout(fetchStatus, 500);
})();

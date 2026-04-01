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
  const { wsConnected, pairingPending, loop, browserId, wsUrl, tabCount } = data;

  // Status badge
  const loopStatus = loop?.status || 'idle';
  const dotClass = wsConnected ? (DOT_CLASS[loopStatus] || 'connected') : (pairingPending ? 'pairing' : 'disconnected');
  $('statusDot').className = `status-dot ${dotClass}`;
  const statusKey = wsConnected ? loopStatus : (pairingPending ? 'pairing' : 'disconnected');
  $('statusText').textContent = wsConnected
    ? (() => {
      const keyMap = {idle:'loopIdle',perceiving:'loopPerceiving',thinking:'loopThinking',
        acting:'loopActing',done:'loopDone',failed:'loopFailed',cancelled:'loopCancelled'};
      return loop?.statusText || t(keyMap[loopStatus]) || loopStatus;
    })()
    : pairingPending ? t('pairingTitle') : t('disconnected');

  // Config section: collapse when connected
  $('configSection').style.display = wsConnected ? 'none' : '';

  // Pairing banner
  if (pairingPending) {
    $('pairingBanner').style.display = '';
    const deviceId = data.deviceId || '';
    const approveCmd = deviceId
      ? `openclaw devices approve ${deviceId.slice(0,16)}…`
      : 'openclaw devices approve';
    $('pairingBanner').innerHTML = `
      <div class="pairing-title">${t('pairingTitle')}</div>
      <div class="pairing-desc">${t('pairingDesc')}</div>
      ${deviceId ? `<div class="pairing-code" id="pairingCode" title="Click to copy">${deviceId.slice(0,20)}…<button class="copy-btn" data-val="${deviceId}">⎘</button></div>` : ''}
      <div class="pairing-desc pairing-or">${t('pairingCmd')}</div>
      <code class="pairing-cmd">${deviceId ? `openclaw devices approve ${deviceId.slice(0,8)}` : 'openclaw devices approve'}</code>
    `;
    // 复制按钮
    $('pairingBanner').querySelector('.copy-btn')?.addEventListener('click', async (e) => {
      const val = e.target.dataset.val;
      await navigator.clipboard.writeText(`openclaw devices approve ${val}`).catch(()=>{});
      e.target.textContent = '✓';
      setTimeout(() => { e.target.textContent = '⎘'; }, 2000);
    });
  } else {
    $('pairingBanner').style.display = 'none';
  }

  // Loop section
  const loopEl = $('loopSection');
  if (wsConnected) {
    loopEl.style.display = '';
    renderLoop(loop);
  } else {
    loopEl.style.display = 'none';
  }

  // Stats bar
  const statsBar = $('statsBar');
  if (wsConnected) {
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
  $('connectBtn').textContent = t('connecting');
  try { await chrome.runtime.sendMessage({type:'connect',url,token,name}); } catch(_){}
  setTimeout(async ()=>{ $('connectBtn').disabled=false; $('connectBtn').textContent=t('connect'); await fetchStatus(); },1500);
});

$('disconnectBtn').addEventListener('click', async () => {
  try { await chrome.runtime.sendMessage({type:'disconnect'}); } catch(_){}
  render({wsConnected:false,pairingPending:false,tabCount:0,loop:{status:'idle'}});
});

$('toggleToken').addEventListener('click', () => {
  const inp = $('gatewayToken');
  inp.type = inp.type==='password' ? 'text' : 'password';
});

$('cancelBtn').addEventListener('click', async () => {
  try { await chrome.runtime.sendMessage({type:'cancel'}); } catch(_){}
});

// ── Lang toggle ───────────────────────────────────────────────────────────
$('langBtn').addEventListener('click', async () => {
  lang = lang==='en' ? 'zh' : 'en';
  await chrome.storage.local.set({lang});
  applyI18n();
  if (lastData) render(lastData);
});

// ── Fetch status ──────────────────────────────────────────────────────────
async function fetchStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({type:'get_status'});
    if (resp) render(resp);
  } catch(_) { render({wsConnected:false,pairingPending:false,tabCount:0,loop:{status:'idle'}}); }
}

// ── Background push ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type==='status_update') render(msg);
});

// ── Init ──────────────────────────────────────────────────────────────────
(async () => {
  await loadConfig();
  await fetchStatus();
})();

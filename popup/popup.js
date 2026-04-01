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
    idle: 'Ready', perceiving: 'Analyzing page…', thinking: 'Thinking…',
    acting: 'Executing…', done: 'Done', failed: 'Failed', cancelled: 'Cancelled',
    pairingMsg: '⏳ Waiting for pairing approval. Run on your Gateway:',
  },
  zh: {
    config: '连接配置', browserName: '浏览器名称', browserNameHint: '（标识）',
    connect: '保存并连接', disconnect: '断开',
    browserIdLabel: '标识', tabsLabel: '标签页',
    cancel: '取消任务',
    idle: '就绪', perceiving: '分析页面中…', thinking: '思考中…',
    acting: '执行操作中…', done: '完成', failed: '失败', cancelled: '已取消',
    pairingMsg: '⏳ 等待配对批准，在 Gateway 上运行：',
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
  const dotClass = wsConnected ? (DOT_CLASS[loopStatus] || 'connected') : (pairingPending ? 'pairing' : '');
  $('statusDot').className = `status-dot ${dotClass}`;
  const statusKey = wsConnected ? loopStatus : (pairingPending ? 'pairing' : 'disconnected');
  $('statusText').textContent = wsConnected ? (loop?.statusText || t(loopStatus)) : (pairingPending ? t('pairingMsg').slice(0,15)+'…' : '—');

  // Config section: collapse when connected
  if (wsConnected && !configCollapsed) { collapseConfig(true); }
  if (!wsConnected) { collapseConfig(false); }

  // Pairing banner
  if (pairingPending) {
    $('pairingBanner').style.display = '';
    $('pairingBanner').innerHTML = `${t('pairingMsg')}<br><code>openclaw devices approve</code>`;
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

  // 思考中加三点动画
  if (status === 'thinking') {
    stEl.classList.add('thinking-dots');
    stEl.textContent = t('thinking').replace('…', '');
  } else {
    stEl.classList.remove('thinking-dots');
    stEl.textContent = statusText || t(status) || status;
  }

  // Step counter
  $('loopStep').textContent = stepIndex > 0 ? `Step ${stepIndex}` : '';

  // Screenshot
  const swrap = $('screenshotWrap');
  if (lastScreenshot) {
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

/**
 * ClawTab popup.js
 * Architecture:
 *   - I18N: single source of truth, all text goes through t()
 *   - State: one render() call updates everything
 *   - Lang: stored in chrome.storage, loaded once at init, applied via applyI18n()
 */

// ═══════════════════════════════════════════════════════
// 1. I18N — single source of truth
// ═══════════════════════════════════════════════════════

const I18N = {
  en: {
    // Connection
    config:          'Connection',
    browserName:     'Browser Name',
    browserNameHint: '(identifier)',
    connect:         'Connect',
    disconnect:      'Disconnect',
    connecting:      'Connecting…',
    // Settings menu
    switchLang:   '切换中文',
    exportConfig: 'Export config',
    importConfig: 'Import config',
    importSuccess: 'Config imported!',
    importError:   'Invalid config file',
    // Status texts (all statusText keys go here)
    notConfigured: 'Not configured',
    disconnected:  'Disconnected',
    pairing:       'Awaiting pairing…',
    connFailed:    'Connection failed — check config',
    loopIdle:       'Ready',
    loopPerceiving: 'Analyzing page…',
    loopThinking:   'Thinking…',
    loopActing:     'Executing…',
    loopDone:       'Task complete',
    loopFailed:     'Task failed',
    loopCancelled:  'Cancelled',
    // Pairing panel
    pairingTitle: '🔗 Pairing required',
    pairingDesc:  'Send this pairing code to your OpenClaw agent:',
    pairingOr:    'Or run on your Gateway:',
    // Stats
    browserIdLabel: 'Browser ID',
    tabsLabel:      'Tabs',
    // Task
    cancel:       'Cancel Task',
    taskRunning:  'Running',
    taskDone:     'Done',
    taskFailed:   'Failed',
    taskCancelled:'Cancelled',
  },
  zh: {
    config:          '连接配置',
    browserName:     '浏览器名称',
    browserNameHint: '（标识）',
    connect:         '保存并连接',
    disconnect:      '断开',
    connecting:      '连接中…',
    switchLang:   'Switch to English',
    exportConfig: '导出配置',
    importConfig: '导入配置',
    importSuccess: '配置已导入！',
    importError:   '无效的配置文件',
    notConfigured: '未配置',
    disconnected:  '未连接',
    pairing:       '等待配对批准…',
    connFailed:    '连接失败，请检查配置',
    loopIdle:       '就绪',
    loopPerceiving: '正在分析页面…',
    loopThinking:   '思考中…',
    loopActing:     '正在执行操作…',
    loopDone:       '任务完成',
    loopFailed:     '任务失败',
    loopCancelled:  '已取消',
    pairingTitle: '🔗 需要配对',
    pairingDesc:  '将配对码发送给 OpenClaw Agent：',
    pairingOr:    '或在 Gateway 上运行：',
    browserIdLabel: '标识',
    tabsLabel:      '标签页',
    cancel:       '取消任务',
    taskRunning:  '执行中',
    taskDone:     '已完成',
    taskFailed:   '失败',
    taskCancelled:'已取消',
  },
};

// ═══════════════════════════════════════════════════════
// 2. Language — single variable, load once
// ═══════════════════════════════════════════════════════

let lang = 'en'; // default, overridden by storage in init

const t = key => I18N[lang]?.[key] ?? I18N.en[key] ?? key;

/**
 * Apply current lang to ALL translatable elements.
 * Rules:
 *   - [data-i18n="key"]  → textContent = t(key)
 *   - #langToggle        → shows the OTHER language name
 */
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key);
  });
  const lb = document.getElementById('langToggle');
  if (lb) lb.textContent = lang === 'en' ? '切换中文' : 'Switch to English';
}

/**
 * Set status text by i18n key.
 * Stores the key in data-i18n so applyI18n() can re-translate on lang switch.
 */
function setStatus(key, customText) {
  const el = document.getElementById('statusText');
  if (!el) return;
  if (customText) {
    // Dynamic text (e.g. "Clicking #btn") — not in i18n dict, display as-is
    el.removeAttribute('data-i18n');
    el.textContent = customText;
  } else {
    el.dataset.i18n = key;
    el.textContent = t(key);
  }
}

// ═══════════════════════════════════════════════════════
// 3. Render — single function, pure state → DOM
// ═══════════════════════════════════════════════════════

let lastData = null;

function render(data) {
  lastData = data;
  const { wsConnected, pairingPending, reconnecting, gaveUp, deviceId,
          loop, browserId, wsUrl, tabCount } = data;
  const loopStatus = loop?.status || 'idle';

  // ── Status badge ──
  const dotStates = {
    connected:'connected', perceiving:'perceiving', thinking:'thinking',
    acting:'acting', done:'done', failed:'failed', cancelled:'failed',
  };
  const dot = document.getElementById('statusDot');
  if (dot) {
    dot.className = 'status-dot ' + (
      wsConnected ? (dotStates[loopStatus] || 'connected') :
      pairingPending ? 'pairing' : ''
    );
  }

  // ── Status text (ALL via setStatus → data-i18n) ──
  if (wsConnected) {
    const keyMap = {
      idle:'loopIdle', perceiving:'loopPerceiving', thinking:'loopThinking',
      acting:'loopActing', done:'loopDone', failed:'loopFailed', cancelled:'loopCancelled',
    };
    const custom = loop?.statusText; // e.g. "Clicking #btn-login"
    setStatus(keyMap[loopStatus] || 'loopIdle', custom || null);
  } else if (pairingPending) { setStatus('pairing');
  } else if (reconnecting)   { setStatus('connecting');
  } else if (gaveUp)         { setStatus('connFailed');
  } else if (wsUrl)          { setStatus('disconnected');
  } else                     { setStatus('notConfigured');
  }

  // ── Sections visibility ──
  const show = id => { const e = document.getElementById(id); if (e) e.style.display = ''; };
  const hide = id => { const e = document.getElementById(id); if (e) e.style.display = 'none'; };

  if (wsConnected) {
    hide('configSection'); hide('pairingSection');
    show('statsBar');
    // Loop section only when task is running
    const hasTask = loopStatus !== 'idle';
    if (hasTask) { show('loopSection'); renderLoop(loop); }
    else          hide('loopSection');
    // Header
    hide('brandArea'); show('disconnectInlineBtn');
  } else if (pairingPending) {
    hide('configSection'); show('pairingSection');
    hide('statsBar'); hide('loopSection');
    show('brandArea'); hide('disconnectInlineBtn');
    renderPairing(deviceId);
  } else {
    show('configSection'); hide('pairingSection');
    hide('statsBar'); hide('loopSection');
    show('brandArea'); hide('disconnectInlineBtn');
    const tip = document.getElementById('retryTip');
    if (tip) tip.style.display = gaveUp ? '' : 'none';
  }

  // ── Stats ──
  if (wsConnected) {
    const gw = document.getElementById('statGateway');
    const bn = document.getElementById('statBrowserName');
    const tb = document.getElementById('statTabs');
    if (gw) { try { gw.textContent = new URL(wsUrl).host; } catch { gw.textContent = wsUrl || '—'; } }
    if (bn) bn.textContent = browserId || '—';
    if (tb) tb.textContent = tabCount ?? 0;
  }

  // ── Occupied banner ──
  const ob = document.getElementById('occupiedBanner');
  if (ob) {
    if (wsConnected && loop?.status === 'running' && loop?.agentId) {
      ob.style.display = '';
      ob.textContent = `🔒 ${loop.agentId} · ${loop.taskName || ''}`;
    } else ob.style.display = 'none';
  }
}

function renderPairing(deviceId) {
  const ct = document.getElementById('pairingCodeText');
  const cmd = document.getElementById('pairingCmd');
  if (ct) ct.textContent = deviceId ? deviceId.slice(0, 24) + '…' : '—';
  if (cmd) cmd.textContent = deviceId
    ? `openclaw devices approve ${deviceId.slice(0, 16)}`
    : 'openclaw devices approve';
  const cb = document.getElementById('pairingCopyBtn');
  if (cb) cb.onclick = async () => {
    await navigator.clipboard.writeText(`openclaw devices approve ${deviceId}`).catch(() => {});
    cb.textContent = '✓'; setTimeout(() => cb.textContent = '⎘', 2000);
  };
}

function renderLoop(loop) {
  if (!loop) return;
  const { status, goal, agentId, stepIndex, history, lastScreenshot,
          lastUrl, lastTitle, errorMsg } = loop;

  const goal_el = document.getElementById('loopGoal');
  if (goal_el) { goal_el.style.display = goal ? '' : 'none'; if (goal) goal_el.textContent = `🎯 ${goal}`; }

  const ind = document.getElementById('loopIndicator');
  if (ind) ind.className = `loop-indicator ${status}`;

  const stEl = document.getElementById('loopStatusText');
  if (stEl) {
    stEl.className = `loop-status-text ${status}`;
    if (status === 'thinking') stEl.classList.add('thinking-dots');
    else stEl.classList.remove('thinking-dots');
  }

  const stepEl = document.getElementById('loopStep');
  if (stepEl) stepEl.textContent = stepIndex > 0 ? `Step ${stepIndex}` : '';

  const swrap = document.getElementById('screenshotWrap');
  if (swrap) {
    if (lastScreenshot && status !== 'idle') {
      swrap.style.display = '';
      const img = document.getElementById('screenshotImg');
      const lbl = document.getElementById('screenshotLabel');
      if (img) img.src = lastScreenshot;
      if (lbl) lbl.textContent = lastTitle || lastUrl || '';
      swrap.className = `screenshot-wrap${status === 'perceiving' ? ' scanning' : ''}`;
    } else swrap.style.display = 'none';
  }

  const histEl = document.getElementById('historyList');
  if (histEl) {
    const recent = (history || []).slice(-6);
    if (recent.length > 0) {
      histEl.style.display = '';
      histEl.innerHTML = '';
      recent.forEach(h => {
        const isLast = h === recent[recent.length - 1];
        const running = isLast && ['acting','perceiving'].includes(status);
        const icon = running ? '⏳' : h.status === 'done' ? '✅' : h.status === 'failed' ? '❌' : '○';
        const ms = h.durationMs ? `${(h.durationMs/1000).toFixed(1)}s` : '';
        const item = document.createElement('div');
        item.className = `history-item ${running ? 'running' : h.status}`;
        item.innerHTML = `<span class="h-icon">${icon}</span><span class="h-desc">${esc(h.desc||h.op)}</span><span class="h-time">${ms}</span>`;
        histEl.appendChild(item);
      });
    } else histEl.style.display = 'none';
  }

  const cr = document.getElementById('cancelRow');
  if (cr) cr.style.display = ['acting','perceiving','thinking'].includes(status) ? '' : 'none';
}

const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// ═══════════════════════════════════════════════════════
// 4. Events
// ═══════════════════════════════════════════════════════

// Settings menu — event delegation, no stored refs
document.addEventListener('click', (e) => {
  const menu = document.getElementById('settingsMenu');
  if (!menu) return;
  if (e.target.closest('#settingsBtn')) {
    e.stopPropagation();
    menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
    return;
  }
  if (!e.target.closest('#settingsMenu')) menu.style.display = 'none';
});

// Connect
document.getElementById('connectBtn').addEventListener('click', async () => {
  const url   = document.getElementById('gatewayUrl').value.trim();
  const token = document.getElementById('gatewayToken').value.trim();
  const name  = document.getElementById('browserName').value.trim() || ('browser-' + Math.random().toString(36).slice(2, 6));
  if (!url)   { document.getElementById('gatewayUrl').classList.add('input-error');   setTimeout(() => document.getElementById('gatewayUrl').classList.remove('input-error'), 1500);   return; }
  if (!token) { document.getElementById('gatewayToken').classList.add('input-error'); setTimeout(() => document.getElementById('gatewayToken').classList.remove('input-error'), 1500); return; }
  await chrome.storage.local.set({ gatewayUrl:url, gatewayToken:token, browserName:name,
    gatewayUrlDraft:url, gatewayTokenDraft:token, browserNameDraft:name });
  const btn = document.getElementById('connectBtn');
  btn.disabled = true; btn.textContent = t('connecting');
  try { await chrome.runtime.sendMessage({ type:'connect', url, token, name }); } catch(_) {}
  setTimeout(async () => { btn.disabled = false; btn.textContent = t('connect'); await fetchStatus(); }, 1500);
});

// Disconnect inline
document.getElementById('disconnectInlineBtn').addEventListener('click', async () => {
  try { await chrome.runtime.sendMessage({ type:'disconnect' }); } catch(_) {}
  render({ wsConnected:false, pairingPending:false, reconnecting:false, gaveUp:false,
           wsUrl:'', browserId:'', tabCount:0, loop:{ status:'idle' } });
});

// Toggle token visibility
document.getElementById('toggleToken').addEventListener('click', () => {
  const inp = document.getElementById('gatewayToken');
  inp.type = inp.type === 'password' ? 'text' : 'password';
});

// Cancel task
document.getElementById('cancelBtn').addEventListener('click', async () => {
  try { await chrome.runtime.sendMessage({ type:'cancel' }); } catch(_) {}
});

// Pairing cancel
document.getElementById('pairingCancelBtn').addEventListener('click', async () => {
  try { await chrome.runtime.sendMessage({ type:'disconnect' }); } catch(_) {}
  render({ wsConnected:false, pairingPending:false, reconnecting:false, gaveUp:false,
           wsUrl:'', browserId:'', tabCount:0, loop:{ status:'idle' } });
});

// Lang toggle
document.getElementById('langToggle').addEventListener('click', async () => {
  lang = lang === 'en' ? 'zh' : 'en';
  await chrome.storage.local.set({ lang });
  applyI18n();
  if (lastData) render(lastData); // re-render with new lang
  document.getElementById('settingsMenu').style.display = 'none';
});

// Export config
document.getElementById('exportConfig').addEventListener('click', async () => {
  const d = await chrome.storage.local.get(['gatewayUrl','gatewayToken','browserName']);
  const json = JSON.stringify({ _clawtab:true, gatewayUrl:d.gatewayUrl||'', gatewayToken:d.gatewayToken||'', browserName:d.browserName||'' }, null, 2);
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([json], { type:'application/json' })),
    download: 'clawtab-config.json',
  });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  document.getElementById('settingsMenu').style.display = 'none';
});

// Import config
document.getElementById('importConfig').addEventListener('click', () => {
  document.getElementById('importFile').click();
  document.getElementById('settingsMenu').style.display = 'none';
});

document.getElementById('importFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0]; if (!file) return;
  try {
    const cfg = JSON.parse(await file.text());
    if (!cfg.gatewayUrl) throw new Error('invalid');
    const { gatewayUrl:url='', gatewayToken:token='', browserName:name='' } = cfg;
    await chrome.storage.local.set({ gatewayUrl:url, gatewayToken:token, browserName:name,
      gatewayUrlDraft:url, gatewayTokenDraft:token, browserNameDraft:name });
    document.getElementById('gatewayUrl').value = url;
    document.getElementById('gatewayToken').value = token;
    document.getElementById('browserName').value = name;
    try { await chrome.runtime.sendMessage({ type:'disconnect' }); } catch(_) {}
    render({ wsConnected:false, pairingPending:false, reconnecting:false, gaveUp:false,
             wsUrl:'', browserId:'', tabCount:0, loop:{ status:'idle' } });
    showToast(t('importSuccess'));
  } catch { showToast(t('importError'), true); }
  e.target.value = '';
});

// Screenshot lightbox
document.getElementById('screenshotWrap').addEventListener('click', () => {
  if (!lastData?.loop?.lastScreenshot) return;
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML = `<img src="${lastData.loop.lastScreenshot}" />`;
  lb.addEventListener('click', () => lb.remove());
  document.body.appendChild(lb);
});

// Draft auto-save
let draftTimer;
['gatewayUrl','gatewayToken','browserName'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(async () => {
      await chrome.storage.local.set({
        gatewayUrlDraft:   document.getElementById('gatewayUrl').value.trim(),
        gatewayTokenDraft: document.getElementById('gatewayToken').value.trim(),
        browserNameDraft:  document.getElementById('browserName').value.trim(),
      });
    }, 600);
  });
});

// Background push
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'status_update') render(msg);
});

// Toast
function showToast(msg, isError=false) {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;bottom:12px;left:50%;transform:translateX(-50%);background:${isError?'#fee2e2':'#f0fdf4'};color:${isError?'#b91c1c':'#15803d'};padding:7px 14px;border-radius:8px;font-size:11px;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,.12);z-index:999;white-space:nowrap;`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

async function fetchStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({ type:'get_status' });
    if (resp) render(resp);
  } catch { render({ wsConnected:false, pairingPending:false, reconnecting:false, gaveUp:false,
                     wsUrl:'', browserId:'', tabCount:0, loop:{ status:'idle' } }); }
}

// ═══════════════════════════════════════════════════════
// 5. Init — clean, sequential, single pass
// ═══════════════════════════════════════════════════════

(async () => {
  // Step 1: load lang from storage FIRST, apply i18n
  const stored = await chrome.storage.local.get(['lang', 'gatewayUrl','gatewayToken','browserName',
    'gatewayUrlDraft','gatewayTokenDraft','browserNameDraft']);
  if (stored.lang) lang = stored.lang;
  applyI18n(); // NOW all data-i18n elements get correct language

  // Step 2: fill form fields
  document.getElementById('gatewayUrl').value   = stored.gatewayUrlDraft   || stored.gatewayUrl   || '';
  document.getElementById('gatewayToken').value = stored.gatewayTokenDraft || stored.gatewayToken || '';
  document.getElementById('browserName').value  = stored.browserNameDraft  || stored.browserName  || '';

  // Step 3: set initial UI state (uses lang already set above)
  if (stored.gatewayUrl && stored.gatewayToken) {
    // Has config → show connecting while SW reconnects
    document.getElementById('configSection').style.display = 'none';
    document.getElementById('statsBar').style.display = 'none';
    document.getElementById('loopSection').style.display = 'none';
    document.getElementById('brandArea').style.display = '';
    document.getElementById('disconnectInlineBtn').style.display = 'none';
    document.getElementById('statusDot').className = 'status-dot pairing';
    setStatus('connecting'); // uses current lang
  } else {
    // No config → show config form
    setStatus('notConfigured'); // uses current lang
  }

  // Step 4: get real status from background (after brief delay for SW to reconnect)
  setTimeout(fetchStatus, 500);
})();

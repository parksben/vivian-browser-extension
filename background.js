/**
 * background.js - ClawTab Service Worker
 * 管理 WebSocket 连接 + 自动化任务执行引擎
 */

const VERSION = '1.0.0';

// ── 状态 ──────────────────────────────────────────────────────────────────
let ws = null;
let wsUrl = null;
let wsToken = null;
let wsBrowserName = '';
let pendingConnectId = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
let isConnected = false;
let lastCommand = '';
let tabCount = 0;

// 当前任务状态
let currentTask = null; // { id, name, agentId, steps[], currentStep, status, results[] }
let occupiedByAgent = null; // 当前占用插件的 agentId

// ── 图标 ──────────────────────────────────────────────────────────────────
function drawIcon(connected) {
  const sizes = [16, 48, 128];
  const imageData = {};
  for (const size of sizes) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = connected ? '#6366f1' : '#94a3b8';
    const r = size * 0.22;
    ctx.beginPath();
    ctx.moveTo(r, 0); ctx.lineTo(size - r, 0);
    ctx.quadraticCurveTo(size, 0, size, r);
    ctx.lineTo(size, size - r);
    ctx.quadraticCurveTo(size, size, size - r, size);
    ctx.lineTo(r, size);
    ctx.quadraticCurveTo(0, size, 0, size - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.floor(size * 0.5)}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('C', size / 2, size / 2 + size * 0.02);
    imageData[size] = ctx.getImageData(0, 0, size, size);
  }
  chrome.action.setIcon({ imageData });
}

// ── Device Identity（Ed25519，与 PinchChat 协议一致）──────────────────────
const DB_NAME = 'clawtab-device', DB_VERSION = 1, STORE = 'identity';

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function dbGet(db, key) {
  return new Promise((res, rej) => { const r = db.transaction(STORE,'readonly').objectStore(STORE).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

function dbPut(db, key, val) {
  return new Promise((res, rej) => { const r = db.transaction(STORE,'readwrite').objectStore(STORE).put(val, key); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
}

function ab2b64url(ab) {
  let s = ''; new Uint8Array(ab).forEach(b => s += String.fromCharCode(b));
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

async function getOrCreateDeviceIdentity() {
  try {
    const db = await openDB();
    const saved = await dbGet(db, 'device');
    if (saved?.version === 1) {
      const priv = await crypto.subtle.importKey('jwk', saved.jwkPrivate, { name: 'Ed25519' }, true, ['sign']);
      const pub  = await crypto.subtle.importKey('jwk', saved.jwkPublic,  { name: 'Ed25519' }, true, ['verify']);
      db.close();
      return { id: saved.deviceId, publicKeyRaw: saved.publicKeyRaw, keyPair: { privateKey: priv, publicKey: pub } };
    }
    // 新建
    const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
    const pubBytes = spki.slice(12);
    const pubRaw = ab2b64url(pubBytes);
    const hashBuf = await crypto.subtle.digest('SHA-256', pubBytes);
    const deviceId = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2,'0')).join('');
    const jwkPub  = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const jwkPriv = await crypto.subtle.exportKey('jwk', kp.privateKey);
    await dbPut(db, 'device', { version: 1, deviceId, publicKeyRaw: pubRaw, jwkPublic: jwkPub, jwkPrivate: jwkPriv });
    db.close();
    return { id: deviceId, publicKeyRaw: pubRaw, keyPair: kp };
  } catch (e) {
    console.warn('[ClawTab] device identity error:', e);
    return null;
  }
}

async function signDevicePayload(privateKey, payload) {
  const enc = new TextEncoder().encode(payload);
  const sig = await crypto.subtle.sign('Ed25519', privateKey, enc);
  return ab2b64url(sig);
}

function buildDevicePayload({ deviceId, token, role, scopes, signedAtMs, nonce }) {
  const v = nonce ? 'v2' : 'v1';
  const parts = [v, deviceId, 'webchat', 'webchat', role, scopes.join(','), String(signedAtMs), token || ''];
  if (nonce) parts.push(nonce);
  return parts.join('|');
}

// ── WebSocket 管理 ────────────────────────────────────────────────────────
let deviceIdentity = null;
let pendingNonce = null;

// 预加载 device identity
getOrCreateDeviceIdentity().then(id => { deviceIdentity = id; });

function connect(url, token, name) {
  if (ws) {
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws.close(); } catch (_) {}
    ws = null;
  }
  wsUrl = url; wsToken = token; wsBrowserName = name || '';
  if (!url || !token) return;
  setStatus('connecting');
  try { ws = new WebSocket(url); } catch (e) {
    setStatus('disconnected'); scheduleReconnect(); return;
  }

  ws.onopen = () => {
    // 先发 connect req，Gateway 会回 connect.challenge（含 nonce），再签名
    const connectId = 'connect-' + Date.now();
    pendingConnectId = connectId;
    pendingNonce = null;
    ws.send(JSON.stringify({
      type: 'req', id: connectId, method: 'connect',
      params: {
        minProtocol: 3, maxProtocol: 3,
        client: { id: 'webchat', version: '1.71.3', platform: 'web', mode: 'webchat' },
        role: 'operator',
        scopes: ['operator.read', 'operator.write', 'operator.admin', 'operator.approvals'],
        caps: [], commands: [], permissions: {},
        auth: { token: wsToken },
        locale: 'zh-CN',
        userAgent: `clawtab/${VERSION}${wsBrowserName ? ' (' + wsBrowserName + ')' : ''}`
      }
    }));
  };

  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    // connect.challenge — 收到 nonce，重新发带签名的 connect
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      pendingNonce = msg.payload?.nonce || null;
      if (deviceIdentity && pendingNonce) {
        const connectId = pendingConnectId;
        const role = 'operator';
        const scopes = ['operator.read', 'operator.write', 'operator.admin', 'operator.approvals'];
        const signedAtMs = Date.now();
        const payload = buildDevicePayload({ deviceId: deviceIdentity.id, token: wsToken, role, scopes, signedAtMs, nonce: pendingNonce });
        const signature = await signDevicePayload(deviceIdentity.keyPair.privateKey, payload);
        ws.send(JSON.stringify({
          type: 'req', id: connectId, method: 'connect',
          params: {
            minProtocol: 3, maxProtocol: 3,
            client: { id: 'webchat', version: '1.71.3', platform: 'web', mode: 'webchat' },
            role, scopes, caps: [], commands: [], permissions: {},
            auth: { token: wsToken },
            device: { id: deviceIdentity.id, publicKey: deviceIdentity.publicKeyRaw, signature, signedAt: signedAtMs, nonce: pendingNonce },
            locale: 'zh-CN',
            userAgent: `clawtab/${VERSION}${wsBrowserName ? ' (' + wsBrowserName + ')' : ''}`
          }
        }));
      }
      return;
    }

    // 握手响应
    if (msg.type === 'res' && msg.id === pendingConnectId) {
      pendingConnectId = null;
      if (msg.ok) {
        reconnectDelay = 1000;
        clearTimeout(reconnectTimer);
        isConnected = true;
        setStatus('connected');
        drawIcon(true);
        reportTabs();
        sendBrowserInfo();
      } else {
        const code = msg.payload?.code || msg.error?.code || '';
        if (code === 'NOT_PAIRED') { setStatus('pairing'); }
        else { setStatus('disconnected'); scheduleReconnect(); }
      }
      return;
    }

    if (msg.type === 'event') {
      const payload = msg.payload || msg;
      await handleCommand(payload);
      return;
    }
  };

  ws.onerror = () => {};
  ws.onclose = () => {
    isConnected = false; ws = null;
    setStatus('disconnected'); drawIcon(false);
    scheduleReconnect();
  };
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data)); return true;
  }
  return false;
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (!wsUrl || !wsToken) return;
  reconnectTimer = setTimeout(() => connect(wsUrl, wsToken, wsBrowserName), reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

function setStatus(status) {
  broadcastToPopup({ type: 'status_update', status, lastCommand, tabCount, wsUrl, browserName: wsBrowserName });
}

function broadcastToPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// 连接后上报浏览器信息（供 agent 查询）
function sendBrowserInfo() {
  send({ type: 'browser_info', browserName: wsBrowserName, extensionId: chrome.runtime.id, version: VERSION, userAgent: navigator.userAgent });
}

// ── 指令处理 ─────────────────────────────────────────────────────────────
async function handleCommand(msg) {
  lastCommand = msg.type;
  setStatus(isConnected ? 'connected' : 'disconnected');

  const TO = (ms, label) => new Promise((_, r) => setTimeout(() => r(new Error(`Timeout: ${label}`)), ms));

  try {
    switch (msg.type) {
      case 'get_tabs':           await reportTabs(); break;
      case 'get_page_content':   await Promise.race([getPageContent(msg.tabId), TO(10000, 'get_page_content')]); break;
      case 'execute_js':         await Promise.race([executeJS(msg), TO(15000, 'execute_js')]); break;
      case 'navigate':           await Promise.race([navigateTab(msg), TO(10000, 'navigate')]); break;
      case 'screenshot':         await Promise.race([takeScreenshot(msg), TO(15000, 'screenshot')]); break;

      // ── 任务系统 ──────────────────────────────────────────────────────
      case 'browser_check':      await handleBrowserCheck(msg); break;
      case 'task_plan':          await handleTaskPlan(msg); break;
      case 'task_cancel':        handleTaskCancel(msg); break;

      default:
        console.warn('[ClawTab] Unknown command:', msg.type);
    }
  } catch (e) {
    console.error('[ClawTab] Command error:', msg.type, e);
    if (msg.actionId) send({ type: 'action_result', actionId: msg.actionId, ok: false, result: e.message });
  }
}

// ── browser_check：agent 连接前的标准检查 ─────────────────────────────────
async function handleBrowserCheck(msg) {
  const { checkId, agentId } = msg;
  const tabs = await chrome.tabs.query({});
  const busy = occupiedByAgent && occupiedByAgent !== agentId;
  const snapshot = await Promise.all(
    tabs.filter(t => t.url && !t.url.startsWith('chrome')).slice(0, 10).map(async t => {
      let screenshot = null;
      if (t.active) {
        try { screenshot = await chrome.tabs.captureVisibleTab(t.windowId, { format: 'jpeg', quality: 60 }); } catch (_) {}
      }
      return { id: t.id, url: t.url, title: t.title, active: t.active, screenshot };
    })
  );
  send({ type: 'browser_check_result', checkId, browserName: wsBrowserName, extensionVersion: VERSION, agentId, busy, occupiedByAgent: busy ? occupiedByAgent : null, tabs: snapshot, totalTabs: tabs.length });
}

// ── task_plan：接收并执行任务计划 ─────────────────────────────────────────
async function handleTaskPlan(msg) {
  const { taskId, taskName, agentId, steps } = msg;

  // 互斥锁：检查是否被其他 agent 占用
  if (occupiedByAgent && occupiedByAgent !== agentId) {
    send({
      type: 'task_result', taskId, ok: false,
      error: `Browser is currently occupied by agent "${occupiedByAgent}". Task "${currentTask?.name || ''}" is in progress. Please try again later.`
    });
    return;
  }

  // 加锁
  occupiedByAgent = agentId;
  broadcastToPopup({ type: 'occupied_update', agentId });

  currentTask = { id: taskId, name: taskName, agentId, steps, currentStep: 0, status: 'running', results: [] };
  broadcastToPopup({ type: 'task_update', task: currentTask });
  send({ type: 'task_started', taskId, taskName, stepCount: steps.length });

  try {
    for (let i = 0; i < steps.length; i++) {
      currentTask.currentStep = i;
      broadcastToPopup({ type: 'task_update', task: { ...currentTask } });

      const step = steps[i];
      let result;
      try {
        result = await executeStep(step);
        currentTask.results.push({ step: i, ok: true, result });
        send({ type: 'task_step_result', taskId, stepIndex: i, step, ok: true, result });
      } catch (e) {
        currentTask.results.push({ step: i, ok: false, error: e.message });
        send({ type: 'task_step_result', taskId, stepIndex: i, step, ok: false, error: e.message });
        if (step.abortOnError !== false) {
          currentTask.status = 'failed';
          broadcastToPopup({ type: 'task_update', task: { ...currentTask } });
          send({ type: 'task_result', taskId, ok: false, error: e.message, results: currentTask.results });
          return;
        }
      }
      broadcastToPopup({ type: 'task_update', task: { ...currentTask } });
    }

    currentTask.status = 'done';
    broadcastToPopup({ type: 'task_update', task: { ...currentTask } });
    send({ type: 'task_result', taskId, ok: true, results: currentTask.results });
  } finally {
    // 释放锁
    occupiedByAgent = null;
    broadcastToPopup({ type: 'occupied_update', agentId: null });
    setTimeout(() => { currentTask = null; broadcastToPopup({ type: 'task_update', task: null }); }, 5000);
  }
}

async function executeStep(step) {
  const TO = (ms) => new Promise((_, r) => setTimeout(() => r(new Error('Step timeout')), ms));
  const timeout = step.timeout || 15000;

  switch (step.type) {
    case 'navigate': {
      await chrome.tabs.update(step.tabId, { url: step.url });
      await new Promise(r => setTimeout(r, 1000));
      return `Navigated to ${step.url}`;
    }
    case 'execute_js': {
      const results = await Promise.race([
        chrome.scripting.executeScript({
          target: { tabId: step.tabId },
          world: 'MAIN',
          func: (code) => { try { return eval(code); } catch(e) { return { __error: e.message }; } },
          args: [step.code]
        }),
        TO(timeout)
      ]);
      const r = results?.[0]?.result;
      if (r?.__error) throw new Error(r.__error);
      return typeof r === 'object' ? JSON.stringify(r) : String(r ?? '');
    }
    case 'screenshot': {
      const tab = await chrome.tabs.get(step.tabId);
      await chrome.tabs.update(step.tabId, { active: true });
      await new Promise(r => setTimeout(r, 400));
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
      return dataUrl;
    }
    case 'get_content': {
      const results = await chrome.scripting.executeScript({
        target: { tabId: step.tabId }, func: extractPageContent
      });
      return results?.[0]?.result || {};
    }
    case 'wait':
      await new Promise(r => setTimeout(r, step.ms || 1000));
      return 'waited ' + (step.ms || 1000) + 'ms';
    default:
      throw new Error(`Unknown step type: ${step.type}`);
  }
}

function handleTaskCancel({ taskId }) {
  if (currentTask?.id === taskId) {
    currentTask.status = 'cancelled';
    broadcastToPopup({ type: 'task_update', task: { ...currentTask } });
    send({ type: 'task_result', taskId, ok: false, error: 'Cancelled by user' });
    occupiedByAgent = null;
    broadcastToPopup({ type: 'occupied_update', agentId: null });
    setTimeout(() => { currentTask = null; broadcastToPopup({ type: 'task_update', task: null }); }, 3000);
  }
}

// ── 基础功能 ──────────────────────────────────────────────────────────────
async function reportTabs() {
  const tabs = await chrome.tabs.query({});
  tabCount = tabs.length;
  setStatus(isConnected ? 'connected' : 'disconnected');
  send({ type: 'tabs_list', tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, favIconUrl: t.favIconUrl || '', active: t.active, windowId: t.windowId })) });
}

async function getPageContent(tabId) {
  let targetTabId = tabId;
  if (!targetTabId) {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!t) throw new Error('No active tab');
    targetTabId = t.id;
  }
  const tab = await chrome.tabs.get(targetTabId);
  let results;
  try { results = await chrome.scripting.executeScript({ target: { tabId: targetTabId }, func: extractPageContent }); }
  catch { send({ type: 'page_content', tabId: targetTabId, url: tab.url, title: tab.title, text: '[inaccessible]', html: '' }); return; }
  const c = results[0]?.result || { text: '', html: '' };
  send({ type: 'page_content', tabId: targetTabId, url: tab.url, title: tab.title, text: c.text, html: c.html });
}

function extractPageContent() {
  const text = document.body?.innerText || '';
  const clone = document.body?.cloneNode(true);
  if (clone) {
    clone.querySelectorAll('script,style,noscript,svg').forEach(el => el.remove());
    return { text: text.slice(0, 50000), html: clone.innerHTML.replace(/\s{2,}/g,' ').slice(0, 100000) };
  }
  return { text: text.slice(0, 50000), html: '' };
}

async function executeJS(msg) {
  const { actionId, tabId, code } = msg;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: (c) => { try { return eval(c); } catch(e) { return { __error: e.message }; } },
      args: [code]
    });
    const r = results?.[0]?.result;
    if (r?.__error) send({ type: 'action_result', actionId, ok: false, result: r.__error });
    else send({ type: 'action_result', actionId, ok: true, result: JSON.stringify(r) });
  } catch (e) { send({ type: 'action_result', actionId, ok: false, result: e.message }); }
}

async function navigateTab({ actionId, tabId, url }) {
  try { await chrome.tabs.update(tabId, { url }); send({ type: 'action_result', actionId, ok: true, result: `Navigated to ${url}` }); }
  catch (e) { send({ type: 'action_result', actionId, ok: false, result: e.message }); }
}

async function takeScreenshot({ actionId, tabId }) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await new Promise(r => setTimeout(r, 300));
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    send({ type: 'action_result', actionId, ok: true, result: dataUrl });
  } catch (e) { send({ type: 'action_result', actionId, ok: false, result: e.message }); }
}

// ── Popup 消息处理 ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'connect') {
    connect(msg.url, msg.token, msg.name); sendResponse({ ok: true });
  } else if (msg.type === 'disconnect') {
    clearTimeout(reconnectTimer); wsUrl = wsToken = null;
    if (ws) { try { ws.close(); } catch (_) {} ws = null; }
    isConnected = false; drawIcon(false); sendResponse({ ok: true });
  } else if (msg.type === 'get_status') {
    sendResponse({ status: isConnected ? 'connected' : 'disconnected', lastCommand, tabCount, wsUrl, browserName: wsBrowserName, currentTask, occupiedByAgent });
  } else if (msg.type === 'task_cancel' && currentTask) {
    handleTaskCancel({ taskId: currentTask.id });
    sendResponse({ ok: true });
  }
  return true;
});

// ── 标签页监听 ────────────────────────────────────────────────────────────
chrome.tabs.onCreated.addListener(() => { if (isConnected) reportTabs(); });
chrome.tabs.onRemoved.addListener(() => { if (isConnected) reportTabs(); });
chrome.tabs.onUpdated.addListener((_, info) => { if (info.status === 'complete' && isConnected) reportTabs(); });

// ── 初始化 ────────────────────────────────────────────────────────────────
async function init() {
  drawIcon(false);
  const { gatewayUrl, gatewayToken, browserName } = await chrome.storage.local.get(['gatewayUrl', 'gatewayToken', 'browserName']);
  if (gatewayUrl && gatewayToken) connect(gatewayUrl, gatewayToken, browserName || '');
}

chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'keepalive' && !isConnected && wsUrl && wsToken && !reconnectTimer) connect(wsUrl, wsToken, wsBrowserName);
});

init();

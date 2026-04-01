/**
 * ClawTab background.js
 * Service Worker — Gateway WS + Session Polling + Task Executor
 */

// ═══════════════════════════════════════════════════════
// SECTION 1: Constants & State
// ═══════════════════════════════════════════════════════

const VERSION = '2.0.0';
const POLL_IDLE_MS     = 3000;   // 空闲轮询间隔
const POLL_MAX_MS      = 30000;  // 最大退避间隔
const CMD_EXPIRE_MS    = 120000; // 指令超时（2分钟）
const STEP_TIMEOUT_MS  = 20000;  // 单步超时
const RESULT_TTL_MS    = 300000; // 结果保留 5 分钟

// 单一状态树
const S = {
  // WS
  ws: null,
  wsUrl: '',
  wsToken: '',
  wsReconnectDelay: 1000,
  wsReconnectTimer: null,
  wsConnected: false,
  wsPendingConnectId: null,
  wsPendingNonce: null,
  pairingPending: false,   // 等待配对批准中

  // 身份
  browserId: '',
  deviceIdentity: null,

  // Session 轮询
  sessionKey: '',
  sessionExists: false,
  pollTimer: null,
  pollInterval: POLL_IDLE_MS,
  pollBackoff: 1000,
  pollPaused: false,
  lastSeenMsgId: null,

  // 任务
  taskStatus: 'idle',    // idle | running | done | failed | cancelled
  taskCmdId: null,
  taskName: '',
  taskAgentId: '',
  taskSteps: [],
  taskCurrentStep: 0,
  taskResults: [],
  processedCmds: new Set(),

  // Stats
  tabCount: 0,
  lastCmd: '',
};

// ═══════════════════════════════════════════════════════
// SECTION 2: Icon
// ═══════════════════════════════════════════════════════

function drawIcon(state) {
  // state: 'disconnected' | 'connecting' | 'connected' | 'running'
  const colors = {
    disconnected: '#94a3b8',
    connecting:   '#f59e0b',
    connected:    '#6366f1',
    running:      '#22c55e',
  };
  const color = colors[state] || colors.disconnected;
  const sizes = [16, 48, 128];
  const imageData = {};
  for (const sz of sizes) {
    const c = new OffscreenCanvas(sz, sz);
    const ctx = c.getContext('2d');
    const r = sz * 0.22;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(r, 0); ctx.lineTo(sz-r, 0);
    ctx.quadraticCurveTo(sz, 0, sz, r);
    ctx.lineTo(sz, sz-r);
    ctx.quadraticCurveTo(sz, sz, sz-r, sz);
    ctx.lineTo(r, sz);
    ctx.quadraticCurveTo(0, sz, 0, sz-r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.floor(sz*0.5)}px Arial`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('C', sz/2, sz/2 + sz*0.02);
    imageData[sz] = ctx.getImageData(0, 0, sz, sz);
  }
  chrome.action.setIcon({ imageData });
}

// ═══════════════════════════════════════════════════════
// SECTION 3: Popup broadcast
// ═══════════════════════════════════════════════════════

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function broadcastStatus() {
  broadcast({
    type: 'status_update',
    wsConnected: S.wsConnected,
    pairingPending: S.pairingPending,
    browserId: S.browserId,
    wsUrl: S.wsUrl,
    tabCount: S.tabCount,
    lastCmd: S.lastCmd,
    taskStatus: S.taskStatus,
    taskName: S.taskName,
    taskAgentId: S.taskAgentId,
    taskCurrentStep: S.taskCurrentStep,
    taskSteps: S.taskSteps,
    taskResults: S.taskResults,
    sessionKey: S.sessionKey,
    pollInterval: S.pollInterval,
  });
}

// ═══════════════════════════════════════════════════════
// SECTION 4: Device Identity (Ed25519)
// ═══════════════════════════════════════════════════════

const IDB = { name: 'clawtab-v2', version: 1, store: 'device' };

function openIDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB.name, IDB.version);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(IDB.store)) r.result.createObjectStore(IDB.store); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) { const db = await openIDB(); return new Promise((res, rej) => { const r = db.transaction(IDB.store,'readonly').objectStore(IDB.store).get(key); r.onsuccess=()=>{db.close();res(r.result);}; r.onerror=()=>rej(r.error); }); }
async function idbSet(key, val) { const db = await openIDB(); return new Promise((res, rej) => { const r = db.transaction(IDB.store,'readwrite').objectStore(IDB.store).put(val,key); r.onsuccess=()=>{db.close();res();}; r.onerror=()=>rej(r.error); }); }

function b64url(ab) { let s=''; new Uint8Array(ab).forEach(b=>s+=String.fromCharCode(b)); return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }

async function loadOrCreateDevice() {
  try {
    const saved = await idbGet('device');
    if (saved?.version === 1) {
      const priv = await crypto.subtle.importKey('jwk', saved.jwkPrivate, {name:'Ed25519'}, true, ['sign']);
      const pub  = await crypto.subtle.importKey('jwk', saved.jwkPublic,  {name:'Ed25519'}, true, ['verify']);
      return { id: saved.deviceId, publicKeyRaw: saved.publicKeyRaw, keyPair: { privateKey: priv, publicKey: pub } };
    }
    const kp   = await crypto.subtle.generateKey('Ed25519', true, ['sign','verify']);
    const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
    const pub  = spki.slice(12);
    const pubRaw = b64url(pub);
    const hash = await crypto.subtle.digest('SHA-256', pub);
    const deviceId = Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join('');
    const jwkPub  = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const jwkPriv = await crypto.subtle.exportKey('jwk', kp.privateKey);
    await idbSet('device', { version:1, deviceId, publicKeyRaw:pubRaw, jwkPublic:jwkPub, jwkPrivate:jwkPriv });
    return { id: deviceId, publicKeyRaw: pubRaw, keyPair: kp };
  } catch(e) { console.warn('[ClawTab] device identity error:', e); return null; }
}

async function signConnect({ deviceId, publicKeyRaw, keyPair }, { token, role, scopes, signedAtMs, nonce }) {
  const v = nonce ? 'v2' : 'v1';
  const parts = [v, deviceId, 'webchat', 'webchat', role, scopes.join(','), String(signedAtMs), token||''];
  if (nonce) parts.push(nonce);
  const sig = await crypto.subtle.sign('Ed25519', keyPair.privateKey, new TextEncoder().encode(parts.join('|')));
  return { id: deviceId, publicKey: publicKeyRaw, signature: b64url(sig), signedAt: signedAtMs, nonce };
}

// ═══════════════════════════════════════════════════════
// SECTION 5: Gateway WebSocket
// ═══════════════════════════════════════════════════════

const CONNECT_SCOPES = ['operator.read', 'operator.write'];

function wsSend(data) {
  if (S.ws?.readyState === WebSocket.OPEN) { S.ws.send(JSON.stringify(data)); return true; }
  return false;
}

async function wsConnect(url, token, browserId) {
  wsDisconnect();
  S.wsUrl = url; S.wsToken = token; S.browserId = browserId;
  S.sessionKey = `agent:main:clawtab-${browserId}`;

  drawIcon('connecting');
  broadcastStatus();

  try { S.ws = new WebSocket(url); }
  catch(e) { wsScheduleReconnect(); return; }

  S.ws.onopen = async () => {
    const cid = 'connect-' + Date.now();
    S.wsPendingConnectId = cid;
    S.wsPendingNonce = null;

    // 已配对时使用 deviceToken，未配对时发带 device identity 的 connect 触发配对
    const stored = await chrome.storage.local.get(['deviceToken']);
    const deviceToken = stored.deviceToken || null;

    const params = {
      minProtocol:3, maxProtocol:3,
      client:{ id:'webchat', version:'1.71.3', platform:'web', mode:'webchat' },
      role:'operator', scopes:CONNECT_SCOPES,
      caps:[], commands:[], permissions:{},
      auth: deviceToken ? { token, deviceToken } : { token },
      locale:'zh-CN',
      userAgent:`clawtab/${VERSION}${browserId?' ('+browserId+')':''}`,
    };

    // 带 device identity 公钥（告诉 Gateway 我是谁，触发 challenge）
    if (S.deviceIdentity) {
      params.device = { id: S.deviceIdentity.id, publicKey: S.deviceIdentity.publicKeyRaw };
    }

    wsSend({ type:'req', id:cid, method:'connect', params });
  };

  S.ws.onmessage = async (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    await wsHandleMsg(msg);
  };

  S.ws.onerror = () => {};
  S.ws.onclose = (ev) => {
    console.log(`[ClawTab] WS closed: ${ev.code} ${ev.reason}`);
    S.ws = null; S.wsConnected = false;
    // 如果任务进行中，标记为断线失败
    if (S.taskStatus === 'running') {
      finishTask(false, 'Connection lost during task execution');
    }
    stopPolling();
    drawIcon('disconnected');
    broadcastStatus();
    wsScheduleReconnect();
  };
}

async function wsHandleMsg(msg) {
  // connect.challenge → 用 device identity 签名 nonce，重发 connect
  if (msg.type === 'event' && msg.event === 'connect.challenge') {
    S.wsPendingNonce = msg.payload?.nonce || null;
    if (S.deviceIdentity && S.wsPendingNonce && S.wsPendingConnectId) {
      const role = 'operator', scopes = CONNECT_SCOPES;
      const signedAtMs = Date.now();
      const device = await signConnect(S.deviceIdentity, { token:S.wsToken, role, scopes, signedAtMs, nonce:S.wsPendingNonce });
      const stored = await chrome.storage.local.get(['deviceToken']);
      wsSend({ type:'req', id:S.wsPendingConnectId, method:'connect', params:{
        minProtocol:3, maxProtocol:3,
        client:{ id:'webchat', version:'1.71.3', platform:'web', mode:'webchat' },
        role, scopes, caps:[], commands:[], permissions:{},
        auth: stored.deviceToken
          ? { token:S.wsToken, deviceToken: stored.deviceToken }
          : { token:S.wsToken },
        device,
        locale:'zh-CN',
        userAgent:`clawtab/${VERSION}${S.browserId?' ('+S.browserId+')':''}`,
      }});
    }
    return;
  }

  // connect response
  if (msg.type === 'res' && msg.id === S.wsPendingConnectId) {
    S.wsPendingConnectId = null;
    if (msg.ok) {
      S.wsConnected = true;
      S.pairingPending = false;
      S.wsReconnectDelay = 1000;
      clearTimeout(S.wsReconnectTimer);
      // 存 deviceToken（配对成功后 Gateway 颁发，下次直接用）
      if (msg.payload?.auth?.deviceToken) {
        await chrome.storage.local.set({ deviceToken: msg.payload.auth.deviceToken });
        console.log('[ClawTab] deviceToken saved');
      }
      console.log('[ClawTab] connected, scopes:', msg.payload?.auth?.scopes || msg.payload?.scopes);
      drawIcon('connected');
      broadcastStatus();
      await ensureSession();
      await syncLastSeenId();
      startPolling();
      reportTabs();
    } else {
      const code = msg.payload?.code || '';
      const errMsg = msg.payload?.message || '';
      console.warn('[ClawTab] connect failed:', code, errMsg);
      if (code === 'NOT_PAIRED') {
        S.wsConnected = false;
        S.pairingPending = true;
        drawIcon('connecting');
        broadcastStatus();
        // 不重连，等待用户在 Gateway 批准后手动重连
      } else {
        wsScheduleReconnect();
      }
    }
    return;
  }

  // 其他 res（chat.send / chat.history / sessions.create 等）
  if (msg.type === 'res') {
    resolvePending(msg.id, msg);
    return;
  }
}

// 待响应的 req 回调
const pendingReqs = new Map();

function wsRequest(method, params, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!S.wsConnected || !S.ws) { reject(new Error('not connected')); return; }
    const id = method.replace('.','_') + '-' + Date.now();
    const timer = setTimeout(() => {
      pendingReqs.delete(id);
      reject(new Error(`Request timeout: ${method}`));
    }, timeoutMs);
    pendingReqs.set(id, { resolve, reject, timer });
    wsSend({ type:'req', id, method, params });
  });
}

function resolvePending(id, msg) {
  const p = pendingReqs.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pendingReqs.delete(id);
  if (msg.ok) p.resolve(msg.payload || {});
  else p.reject(Object.assign(new Error(msg.payload?.message || 'request failed'), { code: msg.payload?.code }));
}

function wsDisconnect() {
  clearTimeout(S.wsReconnectTimer);
  stopPolling();
  if (S.ws) { try { S.ws.close(); } catch(_) {} S.ws = null; }
  S.wsConnected = false;
}

function wsScheduleReconnect() {
  if (!S.wsUrl || !S.wsToken) return;
  clearTimeout(S.wsReconnectTimer);
  S.wsReconnectTimer = setTimeout(() => wsConnect(S.wsUrl, S.wsToken, S.browserId), S.wsReconnectDelay);
  S.wsReconnectDelay = Math.min(S.wsReconnectDelay * 2, 30000);
}

// ═══════════════════════════════════════════════════════
// SECTION 6: Session & Polling
// ═══════════════════════════════════════════════════════

async function ensureSession() {
  if (!S.sessionKey) return;
  try {
    await wsRequest('sessions.create', { channel: 'clawtab', sessionKey: S.sessionKey }, 8000);
    S.sessionExists = true;
  } catch(e) {
    // 已存在不算错误
    if (e.code === 'SESSION_EXISTS' || e.message?.includes('exists')) { S.sessionExists = true; }
    else console.warn('[ClawTab] ensureSession error:', e.message);
  }
}

async function syncLastSeenId() {
  // 拉取现有消息，记录最新 ID，防止重复处理历史指令
  try {
    const saved = await chrome.storage.local.get([`lastSeenId_${S.sessionKey}`]);
    const stored = saved[`lastSeenId_${S.sessionKey}`];
    if (stored) { S.lastSeenMsgId = stored; return; }
    // 没有存储记录，拉一次历史，记录最新 ID（不处理）
    const res = await wsRequest('chat.history', { sessionKey: S.sessionKey, limit: 50 }, 8000);
    const msgs = res.messages || [];
    if (msgs.length > 0) {
      S.lastSeenMsgId = msgs[msgs.length - 1].id;
      await saveLastSeenId();
    }
  } catch(e) {
    console.warn('[ClawTab] syncLastSeenId:', e.message);
  }
}

async function saveLastSeenId() {
  if (S.lastSeenMsgId) {
    await chrome.storage.local.set({ [`lastSeenId_${S.sessionKey}`]: S.lastSeenMsgId });
  }
}

function startPolling() {
  stopPolling();
  S.pollInterval = POLL_IDLE_MS;
  S.pollBackoff = POLL_IDLE_MS;
  S.pollPaused = false;
  schedulePoll(0);
}

function stopPolling() {
  clearTimeout(S.pollTimer);
  S.pollTimer = null;
}

function schedulePoll(delayMs) {
  clearTimeout(S.pollTimer);
  S.pollTimer = setTimeout(doPoll, delayMs);
}

async function doPoll() {
  if (!S.wsConnected || S.pollPaused) return;

  try {
    const res = await wsRequest('chat.history', {
      sessionKey: S.sessionKey,
      limit: 10,
      ...(S.lastSeenMsgId ? { after: S.lastSeenMsgId } : {}),
    }, 8000);

    const msgs = (res.messages || []).filter(m => m.role === 'user' || m.role === 'assistant');

    // 重置退避
    S.pollBackoff = POLL_IDLE_MS;

    for (const msg of msgs) {
      // 更新 lastSeenMsgId
      S.lastSeenMsgId = msg.id;
      await saveLastSeenId();

      // 只处理 assistant 发来的 clawtab_cmd
      if (msg.role !== 'assistant') continue;
      let parsed = null;
      try {
        const text = typeof msg.content === 'string' ? msg.content : (msg.blocks?.find(b=>b.type==='text')?.text || '');
        const match = text.match(/```json\s*([\s\S]*?)```|(\{[\s\S]*"type"\s*:\s*"clawtab_cmd"[\s\S]*\})/);
        if (match) parsed = JSON.parse(match[1] || match[2]);
      } catch(_) {}
      if (parsed?.type === 'clawtab_cmd') await handleCmd(parsed);
    }

    schedulePoll(S.pollInterval);
  } catch(e) {
    // 退避
    S.pollBackoff = Math.min(S.pollBackoff * 2, POLL_MAX_MS);
    console.warn('[ClawTab] poll error:', e.message, `retry in ${S.pollBackoff}ms`);
    schedulePoll(S.pollBackoff);
  }
}

// ═══════════════════════════════════════════════════════
// SECTION 7: Command Handler
// ═══════════════════════════════════════════════════════

async function handleCmd(cmd) {
  const { cmdId, agentId, action, payload, timeout = CMD_EXPIRE_MS, issuedAt } = cmd;

  // 1. 去重检查
  if (S.processedCmds.has(cmdId)) {
    console.log(`[ClawTab] duplicate cmd ${cmdId}, skipping`);
    return;
  }

  // 2. 过期检查
  if (issuedAt && Date.now() - issuedAt > (timeout || CMD_EXPIRE_MS)) {
    console.log(`[ClawTab] cmd ${cmdId} expired`);
    await sendResult({ cmdId, ok: false, error: 'Command expired', errorCode: 'EXPIRED' });
    return;
  }

  // 3. 占用检查
  if (S.taskStatus === 'running') {
    await sendResult({ cmdId, ok: false, error: `Browser is busy executing task "${S.taskName}" (cmd: ${S.taskCmdId})`, errorCode: 'BUSY', busyCmdId: S.taskCmdId });
    return;
  }

  S.processedCmds.add(cmdId);
  // 防止 Set 无限增长
  if (S.processedCmds.size > 200) {
    const first = S.processedCmds.values().next().value;
    S.processedCmds.delete(first);
  }

  S.lastCmd = action;

  switch (action) {
    case 'browser_check': await handleBrowserCheck(cmd); break;
    case 'task_plan':     await handleTaskPlan(cmd); break;
    case 'task_cancel':   await handleTaskCancel(cmd); break;
    case 'get_tabs':      await handleGetTabs(cmd); break;
    default:
      await sendResult({ cmdId, ok: false, error: `Unknown action: ${action}`, errorCode: 'UNKNOWN_ACTION' });
  }
}

// ═══════════════════════════════════════════════════════
// SECTION 8: Actions
// ═══════════════════════════════════════════════════════

async function handleBrowserCheck({ cmdId, agentId }) {
  const tabs = await chrome.tabs.query({});
  const activeTab = tabs.find(t => t.active) || tabs[0];
  let screenshot = null;
  if (activeTab) {
    try { screenshot = await chrome.tabs.captureVisibleTab(activeTab.windowId, { format:'jpeg', quality:50 }); } catch(_){}
  }
  await sendResult({
    cmdId, ok: true,
    data: {
      browserName: S.browserId,
      extensionVersion: VERSION,
      totalTabs: tabs.length,
      activeTab: activeTab ? { id: activeTab.id, url: activeTab.url, title: activeTab.title } : null,
      screenshot,
      tabs: tabs.slice(0, 20).map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active })),
    }
  });
}

async function handleGetTabs({ cmdId }) {
  const tabs = await chrome.tabs.query({});
  await sendResult({ cmdId, ok: true, data: { tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId })) }});
}

async function handleTaskPlan(cmd) {
  const { cmdId, agentId, payload } = cmd;
  const { taskName, steps } = payload || {};

  if (!steps?.length) {
    await sendResult({ cmdId, ok: false, error: 'No steps provided', errorCode: 'INVALID_PARAMS' });
    return;
  }

  // 开始任务
  S.taskStatus    = 'running';
  S.taskCmdId     = cmdId;
  S.taskName      = taskName || cmdId;
  S.taskAgentId   = agentId || '';
  S.taskSteps     = steps;
  S.taskCurrentStep = 0;
  S.taskResults   = [];
  S.pollPaused    = true; // 执行中暂停轮询

  drawIcon('running');
  broadcastStatus();

  // 发送"已接受"确认
  await sendProgress({ cmdId, status: 'started', stepCount: steps.length });

  try {
    for (let i = 0; i < steps.length; i++) {
      S.taskCurrentStep = i;
      broadcastStatus();

      const step = steps[i];
      let result;
      try {
        result = await Promise.race([
          executeStep(step),
          new Promise((_, rej) => setTimeout(() => rej(new Error('Step timeout')), step.timeout || STEP_TIMEOUT_MS))
        ]);
        S.taskResults.push({ stepIndex: i, ok: true, result });
        await sendProgress({ cmdId, status: 'step_done', stepIndex: i, step, ok: true, result });
      } catch(e) {
        S.taskResults.push({ stepIndex: i, ok: false, error: e.message });
        await sendProgress({ cmdId, status: 'step_failed', stepIndex: i, step, ok: false, error: e.message });
        if (step.abortOnError !== false) {
          finishTask(false, `Step ${i} failed: ${e.message}`);
          await sendResult({ cmdId, ok: false, error: `Step ${i} ("${step.label||step.type}") failed: ${e.message}`, errorCode: 'STEP_FAILED', stepIndex: i, results: S.taskResults });
          return;
        }
      }
      broadcastStatus();
    }

    finishTask(true);
    await sendResult({ cmdId, ok: true, data: { results: S.taskResults } });
  } catch(e) {
    finishTask(false, e.message);
    await sendResult({ cmdId, ok: false, error: e.message, errorCode: 'TASK_ERROR', results: S.taskResults });
  }
}

async function handleTaskCancel({ cmdId: cancelCmdId, payload }) {
  const targetCmdId = payload?.cmdId || S.taskCmdId;
  if (S.taskStatus !== 'running' || S.taskCmdId !== targetCmdId) {
    await sendResult({ cmdId: cancelCmdId, ok: false, error: 'No matching running task', errorCode: 'NOT_FOUND' });
    return;
  }
  finishTask(false, 'Cancelled by agent');
  await sendResult({ cmdId: cancelCmdId, ok: true, data: { message: `Task "${S.taskName}" cancelled` } });
  // 也通知原 task 的 result
  await sendResult({ cmdId: targetCmdId, ok: false, error: 'Cancelled by agent', errorCode: 'CANCELLED', results: S.taskResults });
}

function finishTask(ok, errorMsg) {
  S.taskStatus = ok ? 'done' : (errorMsg?.includes('Cancel') ? 'cancelled' : 'failed');
  S.pollPaused = false;
  drawIcon(S.wsConnected ? 'connected' : 'disconnected');
  broadcastStatus();
  // 5s 后清空任务状态
  setTimeout(() => {
    if (S.taskCmdId && S.taskStatus !== 'running') {
      S.taskStatus = 'idle'; S.taskCmdId = null; S.taskName = '';
      S.taskSteps = []; S.taskResults = []; S.taskAgentId = '';
      broadcastStatus();
    }
  }, 5000);
  // 任务完成后立即轮询一次
  schedulePoll(300);
}

// ═══════════════════════════════════════════════════════
// SECTION 9: Step Executor
// ═══════════════════════════════════════════════════════

async function executeStep(step) {
  switch (step.type) {
    case 'navigate': {
      await chrome.tabs.update(step.tabId, { url: step.url });
      // 等待加载完成
      await waitForTabLoad(step.tabId, step.timeout || 15000);
      return `Navigated to ${step.url}`;
    }
    case 'execute_js': {
      const res = await chrome.scripting.executeScript({
        target: { tabId: step.tabId }, world: 'MAIN',
        func: (code) => { try { return { ok:true, value: eval(code) }; } catch(e) { return { ok:false, error:e.message }; } },
        args: [step.code]
      });
      const r = res?.[0]?.result;
      if (!r?.ok) throw new Error(r?.error || 'JS execution failed');
      return typeof r.value === 'object' ? JSON.stringify(r.value) : String(r.value ?? '');
    }
    case 'screenshot': {
      const tab = await chrome.tabs.get(step.tabId);
      await chrome.tabs.update(step.tabId, { active: true });
      await new Promise(r => setTimeout(r, 400));
      return await chrome.tabs.captureVisibleTab(tab.windowId, { format:'jpeg', quality: step.quality || 70 });
    }
    case 'get_content': {
      const res = await chrome.scripting.executeScript({ target:{ tabId:step.tabId }, func: extractContent });
      return res?.[0]?.result || {};
    }
    case 'click': {
      await chrome.scripting.executeScript({
        target:{ tabId:step.tabId }, world:'MAIN',
        func:(sel) => { const el = document.querySelector(sel); if(!el) throw new Error(`Element not found: ${sel}`); el.click(); },
        args:[step.selector]
      });
      return `Clicked ${step.selector}`;
    }
    case 'fill': {
      await chrome.scripting.executeScript({
        target:{ tabId:step.tabId }, world:'MAIN',
        func:(sel,val) => {
          const el = document.querySelector(sel);
          if(!el) throw new Error(`Element not found: ${sel}`);
          el.value = val;
          el.dispatchEvent(new Event('input', {bubbles:true}));
          el.dispatchEvent(new Event('change', {bubbles:true}));
        },
        args:[step.selector, step.value]
      });
      return `Filled ${step.selector}`;
    }
    case 'wait':
      await new Promise(r => setTimeout(r, step.ms || 1000));
      return `Waited ${step.ms||1000}ms`;
    case 'wait_for': {
      const start = Date.now();
      const maxWait = step.ms || 10000;
      while (Date.now() - start < maxWait) {
        const res = await chrome.scripting.executeScript({
          target:{ tabId:step.tabId }, world:'MAIN',
          func:(sel) => !!document.querySelector(sel), args:[step.selector]
        });
        if (res?.[0]?.result) return `Element found: ${step.selector}`;
        await new Promise(r => setTimeout(r, 300));
      }
      throw new Error(`wait_for timeout: ${step.selector}`);
    }
    case 'scroll': {
      await chrome.scripting.executeScript({
        target:{ tabId:step.tabId }, world:'MAIN',
        func:(x,y) => window.scrollTo(x, y), args:[step.x||0, step.y||0]
      });
      return `Scrolled to (${step.x||0}, ${step.y||0})`;
    }
    default:
      throw new Error(`Unknown step type: ${step.type}`);
  }
}

function extractContent() {
  const title = document.title;
  const desc = document.querySelector('meta[name="description"]')?.content || '';
  const text = document.body?.innerText?.slice(0, 10000) || '';
  const links = Array.from(document.querySelectorAll('a[href]')).slice(0,50).map(a=>({text:a.textContent.trim().slice(0,100),href:a.href}));
  return { title, description: desc, text, links, url: location.href };
}

function waitForTabLoad(tabId, maxMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, maxMs);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(listener); resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ═══════════════════════════════════════════════════════
// SECTION 10: Send result/progress back to session
// ═══════════════════════════════════════════════════════

async function sendResult(result) {
  const msg = JSON.stringify({ type: 'clawtab_result', ...result, browserId: S.browserId, completedAt: Date.now() }, null, 2);
  try {
    await wsRequest('chat.send', { sessionKey: S.sessionKey, message: `\`\`\`json\n${msg}\n\`\`\``, deliver: false }, 8000);
  } catch(e) {
    console.warn('[ClawTab] sendResult failed:', e.message);
    // 放入本地队列，重连后重发（TODO: 实现离线队列）
  }
}

async function sendProgress(progress) {
  const msg = JSON.stringify({ type: 'clawtab_progress', ...progress, browserId: S.browserId, ts: Date.now() }, null, 2);
  try {
    await wsRequest('chat.send', { sessionKey: S.sessionKey, message: `\`\`\`json\n${msg}\n\`\`\``, deliver: false }, 5000);
  } catch(e) {
    console.warn('[ClawTab] sendProgress failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════
// SECTION 11: Tab tracking
// ═══════════════════════════════════════════════════════

async function reportTabs() {
  const tabs = await chrome.tabs.query({});
  S.tabCount = tabs.length;
  broadcastStatus();
}

chrome.tabs.onCreated.addListener(reportTabs);
chrome.tabs.onRemoved.addListener(reportTabs);
chrome.tabs.onUpdated.addListener((_, info) => { if (info.status === 'complete') reportTabs(); });

// ═══════════════════════════════════════════════════════
// SECTION 12: Popup message handler
// ═══════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'connect':
        S.deviceIdentity = await loadOrCreateDevice();
        await wsConnect(msg.url, msg.token, msg.name || 'browser');
        sendResponse({ ok: true });
        break;
      case 'disconnect':
        wsDisconnect();
        S.wsConnected = false;
        drawIcon('disconnected');
        broadcastStatus();
        sendResponse({ ok: true });
        break;
      case 'get_status':
        sendResponse({
          wsConnected: S.wsConnected,
          browserId: S.browserId,
          wsUrl: S.wsUrl,
          tabCount: S.tabCount,
          lastCmd: S.lastCmd,
          taskStatus: S.taskStatus,
          taskName: S.taskName,
          taskAgentId: S.taskAgentId,
          taskCurrentStep: S.taskCurrentStep,
          taskSteps: S.taskSteps,
          taskResults: S.taskResults,
          sessionKey: S.sessionKey,
        });
        break;
      case 'task_cancel':
        if (S.taskStatus === 'running') {
          finishTask(false, 'Cancelled by user');
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'No running task' });
        }
        break;
      default:
        sendResponse({ ok: false, error: 'unknown message type' });
    }
  })();
  return true;
});

// ═══════════════════════════════════════════════════════
// SECTION 13: Init & Keepalive
// ═══════════════════════════════════════════════════════

async function init() {
  drawIcon('disconnected');
  S.deviceIdentity = await loadOrCreateDevice();
  const data = await chrome.storage.local.get(['gatewayUrl', 'gatewayToken', 'browserName']);
  if (data.gatewayUrl && data.gatewayToken) {
    await wsConnect(data.gatewayUrl, data.gatewayToken, data.browserName || 'browser');
  }
}

chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'keepalive') return;
  if (!S.wsConnected && S.wsUrl && S.wsToken && !S.wsReconnectTimer) {
    wsConnect(S.wsUrl, S.wsToken, S.browserId);
  }
  // 心跳：如果连接正常但轮询停了，重启
  if (S.wsConnected && !S.pollTimer && !S.pollPaused) {
    schedulePoll(0);
  }
});

init();

/**
 * ClawTab background.js v3
 * Architecture: perceive → agent thinks → act → perceive loop
 */

// ═══════════════════════════════════════════════════════
// SECTION 1: Constants
// ═══════════════════════════════════════════════════════

const VERSION       = '3.0.0';
const POLL_IDLE_MS  = 3000;
const POLL_MAX_MS   = 30000;
const CMD_EXPIRE_MS = 180000; // 3 min
const ACT_TIMEOUT   = 20000;
const PERC_TIMEOUT  = 15000;

// ═══════════════════════════════════════════════════════
// SECTION 2: State
// ═══════════════════════════════════════════════════════

const S = {
  // WS
  ws: null, wsUrl: '', wsToken: '',
  wsConnected: false, pairingPending: false,
  wsReconnectDelay: 1000, wsReconnectTimer: null,
  wsReconnectCount: 0,   // 连续失败次数
  wsGaveUp: false,       // 超过3次，停止重连
  wsManualDisconnect: false, // 用户主动断连，不自动重连
  wsDisconnectTimer: null, // 断线保护 timer（避免闪烁）
  wsPendingConnectId: null, wsPendingNonce: null,

  // Identity
  browserId: '', deviceIdentity: null,

  // Session polling
  sessionKey: '', sessionExists: false,
  pollTimer: null, pollInterval: POLL_IDLE_MS,
  pollBackoff: POLL_IDLE_MS, pollPaused: false,
  lastSeenMsgId: null,

  // Agent loop state
  loop: {
    status: 'idle',       // idle | perceiving | thinking | acting | done | failed | cancelled
    goal: '',             // 任务目标描述
    agentId: '',
    cmdId: null,          // 当前操作的 cmdId
    taskId: null,         // 整个任务 id（agent 维护）
    tabId: null,
    stepIndex: 0,         // 当前第几步
    history: [],          // [{ step, op, desc, status, durationMs, result? }]
    lastScreenshot: null, // 最新截图 base64
    lastUrl: '',
    lastTitle: '',
    statusText: '',       // 展示给用户的状态文字
    errorMsg: '',
    startedAt: null,
    processedCmds: new Set(),
  },

  // Stats
  tabCount: 0, lastCmd: '',
};

// ═══════════════════════════════════════════════════════
// SECTION 3: Icon
// ═══════════════════════════════════════════════════════

const ICON_COLORS = {
  idle:        '#94a3b8',
  connecting:  '#f59e0b',
  connected:   '#6366f1',
  perceiving:  '#3b82f6',
  thinking:    '#8b5cf6',
  acting:      '#22c55e',
  done:        '#6366f1',
  failed:      '#ef4444',
  cancelled:   '#94a3b8',
};

function drawIcon(state) {
  // idle / connected: use the designed PNG logo
  if (state === 'idle' || state === 'connected' || state === 'done') {
    chrome.action.setIcon({ path: { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' } });
    return;
  }
  // transient states (connecting / perceiving / thinking / acting / failed / cancelled):
  // draw a colour-coded canvas badge so the user can see activity at a glance
  const color = ICON_COLORS[state] || ICON_COLORS.idle;
  const sizes = [16, 48, 128];
  const imageData = {};
  for (const sz of sizes) {
    const c = new OffscreenCanvas(sz, sz);
    const ctx = c.getContext('2d');
    const r = sz * 0.22;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(r,0); ctx.lineTo(sz-r,0);
    ctx.quadraticCurveTo(sz,0,sz,r);
    ctx.lineTo(sz,sz-r); ctx.quadraticCurveTo(sz,sz,sz-r,sz);
    ctx.lineTo(r,sz); ctx.quadraticCurveTo(0,sz,0,sz-r);
    ctx.lineTo(0,r); ctx.quadraticCurveTo(0,0,r,0);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.floor(sz*0.5)}px Arial`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('C', sz/2, sz/2+sz*0.02);
    imageData[sz] = ctx.getImageData(0,0,sz,sz);
  }
  chrome.action.setIcon({ imageData });
}

// ═══════════════════════════════════════════════════════
// SECTION 4: Broadcast to sidebar
// ═══════════════════════════════════════════════════════

function broadcast(msg) {
  // Send to extension pages (sidebar)
  chrome.runtime.sendMessage(msg).catch(()=>{});
  // Send to content scripts in all normal tabs
  chrome.tabs.query({}, tabs => {
    for (const tab of tabs) {
      if (tab.id && tab.url && !tab.url.startsWith('chrome')) {
        chrome.tabs.sendMessage(tab.id, msg).catch(()=>{});
      }
    }
  });
}

function broadcastStatus() {
  broadcast({
    type: 'status_update',
    wsConnected:   S.wsConnected,
    pairingPending: S.pairingPending,
    reconnecting:  !S.wsConnected && !!S.wsUrl && !S.pairingPending,
    gaveUp:        S.wsGaveUp || false,
    deviceId:      S.deviceIdentity?.id || '',
    browserId:     S.browserId,
    wsUrl:         S.wsUrl,
    tabCount:      S.tabCount,
    lastCmd:       S.lastCmd,
    loop: {
      status:         S.loop.status,
      goal:           S.loop.goal,
      agentId:        S.loop.agentId,
      stepIndex:      S.loop.stepIndex,
      history:        S.loop.history.slice(-8), // 最近8条
      lastScreenshot: S.loop.lastScreenshot,
      lastUrl:        S.loop.lastUrl,
      lastTitle:      S.loop.lastTitle,
      statusText:     S.loop.statusText,
      errorMsg:       S.loop.errorMsg,
      startedAt:      S.loop.startedAt,
    },
  });
}

function setLoopStatus(status, statusText, extra = {}) {
  S.loop.status = status;
  // statusText 是动态内容（如操作描述），留空则 sidebar 用 i18n key 翻译
  S.loop.statusText = statusText || '';
  Object.assign(S.loop, extra);
  const iconState = ['perceiving','thinking','acting'].includes(status)
    ? status : S.wsConnected ? 'connected' : 'idle';
  drawIcon(iconState);
  broadcastStatus();
}

// ═══════════════════════════════════════════════════════
// SECTION 5: Device Identity
// ═══════════════════════════════════════════════════════

const IDB = { name: 'clawtab-v2', version: 1, store: 'device' };
function openIDB() {
  return new Promise((res,rej) => {
    const r = indexedDB.open(IDB.name, IDB.version);
    r.onupgradeneeded = () => { if(!r.result.objectStoreNames.contains(IDB.store)) r.result.createObjectStore(IDB.store); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) { const db=await openIDB(); return new Promise((res,rej)=>{ const r=db.transaction(IDB.store,'readonly').objectStore(IDB.store).get(key); r.onsuccess=()=>{db.close();res(r.result);}; r.onerror=()=>rej(r.error); }); }
async function idbSet(key,val) { const db=await openIDB(); return new Promise((res,rej)=>{ const r=db.transaction(IDB.store,'readwrite').objectStore(IDB.store).put(val,key); r.onsuccess=()=>{db.close();res();}; r.onerror=()=>rej(r.error); }); }
function b64url(ab) { let s=''; new Uint8Array(ab).forEach(b=>s+=String.fromCharCode(b)); return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }

async function loadOrCreateDevice() {
  try {
    const saved = await idbGet('device');
    if (saved?.version===1) {
      const priv = await crypto.subtle.importKey('jwk',saved.jwkPrivate,{name:'Ed25519'},true,['sign']);
      const pub  = await crypto.subtle.importKey('jwk',saved.jwkPublic, {name:'Ed25519'},true,['verify']);
      return { id:saved.deviceId, publicKeyRaw:saved.publicKeyRaw, keyPair:{privateKey:priv,publicKey:pub} };
    }
    const kp   = await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
    const spki = await crypto.subtle.exportKey('spki',kp.publicKey);
    const pub  = spki.slice(12);
    const pubRaw = b64url(pub);
    const hash = await crypto.subtle.digest('SHA-256',pub);
    const deviceId = Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join('');
    const jwkPub  = await crypto.subtle.exportKey('jwk',kp.publicKey);
    const jwkPriv = await crypto.subtle.exportKey('jwk',kp.privateKey);
    await idbSet('device',{version:1,deviceId,publicKeyRaw:pubRaw,jwkPublic:jwkPub,jwkPrivate:jwkPriv});
    return { id:deviceId, publicKeyRaw:pubRaw, keyPair:kp };
  } catch(e) { console.warn('[ClawTab] device identity error:',e); return null; }
}

async function signConnect(dev, {token,role,scopes,signedAtMs,nonce}) {
  const parts=['v2',dev.id,'openclaw-control-ui','webchat',role,scopes.join(','),String(signedAtMs),token||'',nonce];
  const sig = await crypto.subtle.sign('Ed25519',dev.keyPair.privateKey,new TextEncoder().encode(parts.join('|')));
  return { id:dev.id, publicKey:dev.publicKeyRaw, signature:b64url(sig), signedAt:signedAtMs, nonce };
}

// ═══════════════════════════════════════════════════════
// SECTION 6: WebSocket
// ═══════════════════════════════════════════════════════

const SCOPES = ['operator.read','operator.write'];
const pendingReqs = new Map();

function wsSend(data) {
  if (S.ws?.readyState===WebSocket.OPEN) { S.ws.send(JSON.stringify(data)); return true; }
  return false;
}

function wsRequest(method, params, timeoutMs=10000) {
  return new Promise((resolve,reject) => {
    if (!S.wsConnected||!S.ws) { reject(new Error('not connected')); return; }
    const id = method.replace(/\./g,'_')+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,6);
    const timer = setTimeout(()=>{ pendingReqs.delete(id); reject(new Error(`Timeout: ${method}`)); }, timeoutMs);
    pendingReqs.set(id,{resolve,reject,timer});
    wsSend({type:'req',id,method,params});
  });
}

function resolvePending(id,msg) {
  const p=pendingReqs.get(id); if(!p) return;
  clearTimeout(p.timer); pendingReqs.delete(id);
  if(msg.ok) p.resolve(msg.payload||{});
  else {
    // Server may return errors in msg.error OR msg.payload
    const errObj  = msg.error ?? msg.payload;
    const errMsg  = (typeof errObj==='object' && errObj!==null)
                    ? (errObj.message || errObj.error || JSON.stringify(errObj))
                    : (typeof errObj==='string' ? errObj : null) || 'failed';
    const errCode = (typeof errObj==='object' && errObj!==null)
                    ? (errObj.code || errObj.errorCode || '') : '';
    console.warn('[ClawTab] wsReq failed:', msg.id?.split('-')[0], '| msg:', errMsg, '| code:', errCode);
    p.reject(Object.assign(new Error(errMsg), {code: errCode}));
  }
}

async function wsConnect(url,token,browserId) {
  // 幂等保护：相同参数且正在连接中，直接返回，不打断
  if (S.ws && S.ws.readyState === WebSocket.CONNECTING &&
      S.wsUrl === url && S.wsToken === token) {
    console.log('[ClawTab] wsConnect: already connecting to same endpoint, skip');
    return;
  }
  wsDisconnect(); // 静默关闭旧连接，不触发 onclose 回调
  S.wsUrl=url; S.wsToken=token; S.browserId=browserId;
  S.sessionKey=`agent:main:clawtab-${browserId}`;
  // 注意：不在这里重置 wsReconnectCount / wsReconnectDelay
  // 重置只在用户主动发起连接时（connect handler / init）执行，
  // 这样 wsScheduleReconnect 的计数器才能真正累计并在 3 次后 giveUp。
  drawIcon('connecting'); broadcastStatus();
  console.log('[ClawTab] wsConnect →', url, '| channel:', browserId, '| retry#', S.wsReconnectCount);

  try { S.ws=new WebSocket(url); } catch(e) { wsScheduleReconnect(); return; }

  S.ws.onopen = async () => {
    console.log('[ClawTab] onopen — sending connect request');
    const cid='connect-'+Date.now();
    S.wsPendingConnectId=cid; S.wsPendingNonce=null;
    const stored=await chrome.storage.local.get(['deviceToken']);
    const params={
      minProtocol:3,maxProtocol:3,
      client:{id:'openclaw-control-ui',version:'1.71.3',platform:'browser_extension',mode:'webchat'},
      role:'operator',scopes:SCOPES,caps:[],commands:[],permissions:{},
      auth:stored.deviceToken?{token,deviceToken:stored.deviceToken}:{token},
      locale:'zh-CN',
      userAgent:`clawtab/${VERSION}${browserId?' ('+browserId+')':''}`,
    };
    // 初始 connect 不带 device 字段——等 challenge 来了再签名重发
    // (带不完整的 device 会触发 schema 校验失败)
    wsSend({type:'req',id:cid,method:'connect',params});
  };

  S.ws.onmessage = async (ev) => {
    let msg; try{msg=JSON.parse(ev.data);}catch{return;}
    // challenge
    if (msg.type==='event'&&msg.event==='connect.challenge') {
      S.wsPendingNonce=msg.payload?.nonce||null;
      console.log('[ClawTab] challenge received | deviceIdentity:', !!S.deviceIdentity, '| nonce:', !!S.wsPendingNonce);
      if (S.deviceIdentity&&S.wsPendingNonce&&S.wsPendingConnectId) {
        const role='operator',scopes=SCOPES,signedAtMs=Date.now();
        const device=await signConnect(S.deviceIdentity,{token:S.wsToken,role,scopes,signedAtMs,nonce:S.wsPendingNonce});
        const stored=await chrome.storage.local.get(['deviceToken']);
        console.log('[ClawTab] sending signed connect | devId:', S.deviceIdentity.id?.slice(0,8));
        wsSend({type:'req',id:S.wsPendingConnectId,method:'connect',params:{
          minProtocol:3,maxProtocol:3,
          client:{id:'openclaw-control-ui',version:'1.71.3',platform:'browser_extension',mode:'webchat'},
          role,scopes,caps:[],commands:[],permissions:{},
          auth:stored.deviceToken?{token:S.wsToken,deviceToken:stored.deviceToken}:{token:S.wsToken},
          device,locale:'zh-CN',
          userAgent:`clawtab/${VERSION}${S.browserId?' ('+S.browserId+')':''}`,
        }});
      } else {
        console.warn('[ClawTab] challenge: cannot sign — missing deviceIdentity/nonce/connectId');
      }
      return;
    }
    // connect res
    if (msg.type==='res'&&msg.id===S.wsPendingConnectId) {
      S.wsPendingConnectId=null;
      if (msg.ok) {
        S.wsConnected=true; S.pairingPending=false; S.wsReconnectDelay=1000;
        S.wsReconnectCount=0; S.wsGaveUp=false;
        clearTimeout(S.wsDisconnectTimer); S.wsDisconnectTimer=null;
        clearTimeout(S.wsReconnectTimer);
        const dt = msg.payload?.auth?.deviceToken;
        if (dt) {
          await chrome.storage.local.set({deviceToken: dt});
          console.log('[ClawTab] deviceToken saved:', dt.slice(0,12)+'...');
        }
        console.log('[ClawTab] connect ok, payload keys:', Object.keys(msg.payload||{}));
        drawIcon('connected'); broadcastStatus();
        const isNewSession = await ensureSession(); await syncLastSeenId();
        startPolling(); reportTabs();
        const hsKey=`hs_${S.sessionKey}`;
        if (isNewSession) {
          // Fresh session on the Gateway — clear stale local state and always (re-)send handshake
          S.lastSeenMsgId = null;
          await chrome.storage.local.remove([`lsid_${S.sessionKey}`, hsKey]);
          await sendHandshake();
        } else {
          const hsFlag=await chrome.storage.local.get([hsKey]);
          if (!S.lastSeenMsgId && !hsFlag[hsKey]) await sendHandshake();
        }
        // 不在连接时自动截图，截图只在任务执行中更新
      } else {
        const code=msg.payload?.code||'';
        console.warn('[ClawTab] connect failed | code:', code, '| payload:', JSON.stringify(msg.payload));
        if (code==='NOT_PAIRED') {
          S.pairingPending=true;
          clearTimeout(S.wsReconnectTimer);
          drawIcon('connecting'); broadcastStatus();
          // 每5s 自动重试，直到配对成功
          S.wsReconnectTimer = setTimeout(() => {
            if (S.pairingPending) wsConnect(S.wsUrl, S.wsToken, S.browserId);
          }, 5000);
        }
        else wsScheduleReconnect();
      }
      return;
    }
    // other res
    if (msg.type==='res') { resolvePending(msg.id,msg); return; }
  };

  S.ws.onerror=(e)=>{ console.warn('[ClawTab] ws onerror', e?.message||''); };
  S.ws.onclose=(ev)=>{
    console.log('[ClawTab] onclose | code:', ev?.code, '| reason:', ev?.reason||'(none)');
    S.ws=null; S.wsConnected=false;
    if (S.loop.status==='acting'||S.loop.status==='perceiving') {
      setLoopStatus('failed','Connection lost during task',{errorMsg:'WebSocket disconnected'});
      sendResult({cmdId:S.loop.cmdId,ok:false,error:'Connection lost',errorCode:'DISCONNECTED'});
    }
    stopPolling();
    // 配对等待中：不重连、不更新UI（已经显示配对码了）
    if (S.pairingPending) return;
    // 断线保护：延迟 1.5s 再更新 UI，避免短暂断线引起界面闪烁
    clearTimeout(S.wsDisconnectTimer);
    S.wsDisconnectTimer = setTimeout(() => {
      if (!S.wsConnected && !S.pairingPending) {
        drawIcon(S.wsGaveUp ? 'idle' : 'connecting');
        broadcastStatus();
      }
    }, 1500);
    wsScheduleReconnect();
  };
}

function wsDisconnect() {
  clearTimeout(S.wsReconnectTimer); clearTimeout(S.wsDisconnectTimer); stopPolling();
  if (S.ws) {
    // 静默关闭：先清掉回调再 close，避免触发 onclose → wsScheduleReconnect
    S.ws.onclose = null; S.ws.onerror = null; S.ws.onmessage = null;
    try { S.ws.close(); } catch(_) {}
    S.ws = null;
  }
  S.wsConnected = false;
}

function wsScheduleReconnect() {
  if (!S.wsUrl||!S.wsToken) return;
  S.wsReconnectCount++;
  console.warn('[ClawTab] wsScheduleReconnect | attempt #'+S.wsReconnectCount+' | delay:'+S.wsReconnectDelay+'ms');
  if (S.wsReconnectCount > 3) {
    // 连续失败3次，停止重连，回退到配置界面
    S.wsGaveUp = true;
    S.wsUrl = ''; S.wsToken = '';
    drawIcon('idle');
    broadcastStatus();
    console.warn('[ClawTab] 3 reconnect failures, giving up');
    return;
  }
  clearTimeout(S.wsReconnectTimer);
  S.wsReconnectTimer=setTimeout(()=>wsConnect(S.wsUrl,S.wsToken,S.browserId),S.wsReconnectDelay);
  S.wsReconnectDelay=Math.min(S.wsReconnectDelay*2,30000);
}

// ═══════════════════════════════════════════════════════
// SECTION 7: Session & Polling
// ═══════════════════════════════════════════════════════

async function ensureSession() {
  try { await wsRequest('sessions.create',{key:S.sessionKey,agentId:'main'},8000); S.sessionExists=true; return true; }
  catch(e) {
    if(e.code==='SESSION_EXISTS'||e.message?.includes('exists')) { S.sessionExists=true; return false; }
    console.warn('[ClawTab] ensureSession failed (non-fatal):', e.message, '| code:', e.code);
    return false;
  }
}

async function syncLastSeenId() {
  try {
    const saved=await chrome.storage.local.get([`lsid_${S.sessionKey}`]);
    if (saved[`lsid_${S.sessionKey}`]) { S.lastSeenMsgId=saved[`lsid_${S.sessionKey}`]; return; }
    const res=await wsRequest('chat.history',{sessionKey:S.sessionKey,limit:50},8000);
    const msgs=res.messages||[];
    if (msgs.length>0) { S.lastSeenMsgId=msgs[msgs.length-1].id; await saveLastSeenId(); }
  } catch(e) { console.warn('[ClawTab] syncLastSeenId:',e.message); }
}

async function saveLastSeenId() {
  if (S.lastSeenMsgId) await chrome.storage.local.set({[`lsid_${S.sessionKey}`]:S.lastSeenMsgId});
}

function startPolling() {
  stopPolling(); S.pollInterval=POLL_IDLE_MS; S.pollBackoff=POLL_IDLE_MS; S.pollPaused=false;
  schedulePoll(0);
}
function stopPolling() { clearTimeout(S.pollTimer); S.pollTimer=null; }
function schedulePoll(ms) { clearTimeout(S.pollTimer); S.pollTimer=setTimeout(doPoll,ms); }

async function doPoll() {
  if (!S.wsConnected||S.pollPaused) return;
  try {
    const res=await wsRequest('chat.history',{
      sessionKey:S.sessionKey,limit:20,
    },8000);
    S.pollBackoff=POLL_IDLE_MS;
    const allMsgs=res.messages||[];
    const seenIdx=S.lastSeenMsgId?allMsgs.findIndex(m=>m.id===S.lastSeenMsgId):-1;
    // lastSeenMsgId is set but the referenced message slid out of the 20-msg window.
    // Fast-forward to the end of the current window to avoid re-executing old commands.
    if (seenIdx===-1 && S.lastSeenMsgId) {
      if (allMsgs.length>0) { S.lastSeenMsgId=allMsgs[allMsgs.length-1].id; await saveLastSeenId(); }
      schedulePoll(S.pollInterval);
      return;
    }
    const newMsgs=seenIdx>=0?allMsgs.slice(seenIdx+1):allMsgs;
    for (const msg of newMsgs) {
      S.lastSeenMsgId=msg.id; await saveLastSeenId();
      if (msg.role!=='assistant') continue;
      const text=typeof msg.content==='string'?msg.content:(msg.blocks?.find(b=>b.type==='text')?.text||'');
      const match=text.match(/```json\s*([\s\S]*?)```/);
      if (!match) continue;
      let parsed; try{parsed=JSON.parse(match[1]);}catch{continue;}
      if (parsed?.type==='clawtab_cmd') await handleCmd(parsed);
    }
    schedulePoll(S.pollInterval);
  } catch(e) {
    S.pollBackoff=Math.min(S.pollBackoff*2,POLL_MAX_MS);
    schedulePoll(S.pollBackoff);
  }
}

// ═══════════════════════════════════════════════════════
// SECTION 8: Command dispatcher
// ═══════════════════════════════════════════════════════

async function handleCmd(cmd) {
  const {cmdId,agentId,action,payload,issuedAt,timeout=CMD_EXPIRE_MS}=cmd;

  // 去重
  if (S.loop.processedCmds.has(cmdId)) return;
  // 过期
  if (issuedAt&&Date.now()-issuedAt>timeout) {
    await sendResult({cmdId,ok:false,error:'Command expired',errorCode:'EXPIRED'}); return;
  }
  // 占用（只有 perceive 可以打断，act 不行）
  if (['acting','perceiving'].includes(S.loop.status)&&action!=='cancel') {
    await sendResult({cmdId,ok:false,error:`Browser is busy: ${S.loop.status} (task: ${S.loop.goal})`,errorCode:'BUSY',busyStatus:S.loop.status}); return;
  }

  S.loop.processedCmds.add(cmdId);
  if (S.loop.processedCmds.size>300) { const f=S.loop.processedCmds.values().next().value; S.loop.processedCmds.delete(f); }

  S.lastCmd=action; S.loop.cmdId=cmdId; S.loop.agentId=agentId||'';
  S.pollPaused=true; // 执行期间暂停轮询

  try {
    switch(action) {
      case 'perceive': await handlePerceive(cmd); break;
      case 'act':      await handleAct(cmd); break;
      case 'task_start': handleTaskStart(cmd); await sendResult({cmdId,ok:true}); break;
      case 'task_done':  handleTaskDone(cmd);  await sendResult({cmdId,ok:true}); break;
      case 'task_fail':  handleTaskFail(cmd);  await sendResult({cmdId,ok:true}); break;
      case 'cancel':   await handleCancel(cmd); break;
      default: await sendResult({cmdId,ok:false,error:`Unknown action: ${action}`,errorCode:'UNKNOWN_ACTION'});
    }
  } finally {
    S.pollPaused=false;
    schedulePoll(300); // 完成后快速轮询
  }
}

// ═══════════════════════════════════════════════════════
// SECTION 9: Task lifecycle (agent drives these)
// ═══════════════════════════════════════════════════════

function handleTaskStart({payload}) {
  const {taskId,goal,agentId,tabId}=payload||{};
  S.loop.taskId=taskId||null;
  S.loop.goal=goal||'';
  S.loop.agentId=agentId||'';
  S.loop.tabId=tabId||null;
  S.loop.stepIndex=0;
  S.loop.history=[];
  S.loop.startedAt=Date.now();
  S.loop.errorMsg='';
  setLoopStatus('thinking','Starting task…');
}

function handleTaskDone({payload}) {
  const summary=payload?.summary||'Task completed';
  pushHistory({op:'done',desc:summary,status:'done',durationMs:Date.now()-S.loop.startedAt});
  setLoopStatus('done',`✅ ${summary}`);
  setTimeout(()=>{ if(S.loop.status==='done') { S.loop.status='idle'; S.loop.goal=''; broadcastStatus(); } },8000);
}

function handleTaskFail({payload}) {
  const err=payload?.error||'Task failed';
  setLoopStatus('failed',`❌ ${err}`,{errorMsg:err});
  setTimeout(()=>{ if(S.loop.status==='failed') { S.loop.status='idle'; S.loop.goal=''; broadcastStatus(); } },10000);
}

async function handleCancel({cmdId}) {
  const wasRunning=['acting','perceiving','thinking'].includes(S.loop.status);
  setLoopStatus('cancelled','Cancelled by user');
  setTimeout(()=>{ S.loop.status='idle'; S.loop.goal=''; broadcastStatus(); },5000);
  await sendResult({cmdId,ok:true,data:{message:'Task cancelled',wasRunning}});
}

// ═══════════════════════════════════════════════════════
// SECTION 10: Perceive
// ═══════════════════════════════════════════════════════

async function handlePerceive({cmdId,payload}) {
  const {tabId,include=['screenshot','title','url','dom']}=payload||{};
  const targetTabId=tabId||S.loop.tabId||(await getActiveTabId());

  setLoopStatus('perceiving','Analyzing page…');
  const stepStart=Date.now();

  try {
    const tab=await chrome.tabs.get(targetTabId);
    const result={url:tab.url,title:tab.title,tabId:targetTabId};

    if (include.includes('screenshot')||include.includes('all')) {
      await chrome.tabs.update(targetTabId,{active:true});
      await new Promise(r=>setTimeout(r,200));
      result.screenshot=await chrome.tabs.captureVisibleTab(tab.windowId,{format:'jpeg',quality:60});
      S.loop.lastScreenshot=result.screenshot;
    }

    if (include.includes('dom')||include.includes('all')) {
      const res=await chrome.scripting.executeScript({target:{tabId:targetTabId},func:extractDOM});
      result.dom=res?.[0]?.result||{};
    }

    if (include.includes('scroll_position')) {
      const res=await chrome.scripting.executeScript({target:{tabId:targetTabId},world:'MAIN',
        func:()=>({x:window.scrollX,y:window.scrollY,height:document.documentElement.scrollHeight})});
      result.scrollPosition=res?.[0]?.result||{};
    }

    S.loop.lastUrl=result.url; S.loop.lastTitle=result.title;
    S.loop.stepIndex++;

    pushHistory({op:'perceive',desc:`Analyzed: ${tab.title?.slice(0,40)||tab.url}`,status:'done',durationMs:Date.now()-stepStart});
    setLoopStatus('thinking','Thinking…');

    await sendResult({cmdId,ok:true,data:result});
  } catch(e) {
    pushHistory({op:'perceive',desc:'Analyze failed',status:'failed',durationMs:Date.now()-stepStart});
    setLoopStatus(S.loop.status==='idle'?'idle':'thinking',`Perceive failed: ${e.message}`);
    await sendResult({cmdId,ok:false,error:e.message,errorCode:'PERCEIVE_FAILED'});
  }
}

function extractDOM() {
  function simplify(el, depth=0) {
    if (depth>4) return null;
    const tag=el.tagName?.toLowerCase();
    if (!tag||['script','style','svg','noscript','head'].includes(tag)) return null;
    const node={tag};
    const id=el.id; if(id) node.id=id;
    const cls=Array.from(el.classList).slice(0,3).join(' '); if(cls) node.class=cls;
    const text=el.childNodes.length===1&&el.childNodes[0].nodeType===3?el.textContent?.trim().slice(0,80):'';
    if(text) node.text=text;
    if(['a','button','input','select','textarea'].includes(tag)) {
      node.interactive=true;
      if(el.href) node.href=el.href;
      if(el.type) node.type=el.type;
      if(el.placeholder) node.placeholder=el.placeholder;
      if(el.value&&tag!=='input') node.value=el.value?.slice(0,50);
      node.visible=!!(el.offsetWidth||el.offsetHeight||el.getClientRects().length);
    }
    const children=Array.from(el.children).map(c=>simplify(c,depth+1)).filter(Boolean);
    if(children.length) node.children=children;
    return node;
  }
  const interactive=Array.from(document.querySelectorAll('a,button,input,select,textarea,[role="button"],[onclick]'))
    .slice(0,50).map(el=>{
      const rect=el.getBoundingClientRect();
      return{tag:el.tagName.toLowerCase(),id:el.id||null,text:el.textContent?.trim().slice(0,60)||null,
        placeholder:el.placeholder||null,type:el.type||null,href:el.href||null,
        selector:el.id?`#${el.id}`:el.className?`.${el.className.split(' ')[0]}`:el.tagName.toLowerCase(),
        visible:rect.width>0&&rect.height>0};
    }).filter(el=>el.visible);
  return {
    title:document.title,url:location.href,
    simplified:simplify(document.body),
    interactive,
    metaDescription:document.querySelector('meta[name="description"]')?.content||'',
  };
}

// ═══════════════════════════════════════════════════════
// SECTION 11: Act
// ═══════════════════════════════════════════════════════

async function handleAct({cmdId,payload}) {
  const {tabId,op,target,value,waitAfter=500,captureAfter=true,timeout=ACT_TIMEOUT}=payload||{};
  const targetTabId=tabId||S.loop.tabId||(await getActiveTabId());

  const opDesc=describeOp(op,target,value);
  setLoopStatus('acting',opDesc);
  const stepStart=Date.now();

  try {
    const result=await Promise.race([
      executeAct(targetTabId,op,target,value,waitAfter),
      new Promise((_,rej)=>setTimeout(()=>rej(new Error(`Act timeout: ${op}`)),timeout))
    ]);

    // 操作后截图
    if (captureAfter) {
      try {
        await new Promise(r=>setTimeout(r,400));
        const tab=await chrome.tabs.get(targetTabId);
        result.screenshot=await chrome.tabs.captureVisibleTab(tab.windowId,{format:'jpeg',quality:65});
        S.loop.lastScreenshot=result.screenshot;
        result.urlAfter=tab.url; result.titleAfter=tab.title;
        S.loop.lastUrl=tab.url; S.loop.lastTitle=tab.title;
      } catch(_){}
    }

    S.loop.stepIndex++;
    pushHistory({op,desc:opDesc,status:'done',durationMs:Date.now()-stepStart});
    setLoopStatus('thinking','Thinking…');
    await sendResult({cmdId,ok:true,data:result});
  } catch(e) {
    pushHistory({op,desc:opDesc,status:'failed',durationMs:Date.now()-stepStart,error:e.message});
    setLoopStatus('thinking',`Act failed: ${e.message}`);
    await sendResult({cmdId,ok:false,error:e.message,errorCode:'ACT_FAILED',op});
  }
}

function describeOp(op, target, value) {
  const t = target ? `"${String(target).slice(0, 30)}"` : null;
  const v = value  ? `"${String(value).slice(0, 30)}"` : null;
  switch (op) {
    case 'click':             return t ? `Clicking ${t}` : 'Clicking element';
    case 'fill':              return t && v ? `Typing ${v} into ${t}` : 'Filling input';
    case 'clear':             return t ? `Clearing ${t}` : 'Clearing input';
    case 'navigate':          return v ? `Navigating to ${v}` : 'Navigating…';
    case 'scroll':            return `Scrolling to (${target||0}, ${value||0})`;
    case 'scroll_by':         return `Scrolling by (${target||0}, ${value||0})`;
    case 'scroll_to_element': return t ? `Scrolling to ${t}` : 'Scrolling to element';
    case 'press':             return v ? `Pressing ${v}` : 'Pressing key';
    case 'select':            return t ? `Selecting in ${t}` : 'Selecting option';
    case 'hover':             return t ? `Hovering ${t}` : 'Hovering element';
    case 'wait':              return `Waiting ${value || target || 1000}ms`;
    case 'wait_for':          return t ? `Waiting for ${t}` : 'Waiting for element';
    case 'get_text':          return t ? `Reading text from ${t}` : 'Reading text';
    case 'get_attr':          return t ? `Reading ${v||'attr'} from ${t}` : 'Reading attribute';
    case 'new_tab':           return `Opening new tab${t ? ': '+t : ''}`;
    case 'close_tab':         return `Closing tab ${target || ''}`;
    case 'switch_tab':        return t ? `Switching to tab ${t}` : 'Switching tab';
    case 'go_back':           return 'Going back';
    case 'go_forward':        return 'Going forward';
    case 'screenshot_element':return t ? `Capturing ${t}` : 'Capturing element';
    case 'eval':              return 'Running script';
    default:                  return op;
  }
}

async function executeAct(tabId, op, target, value, waitAfter) {
  switch (op) {

    case 'navigate': {
      await chrome.tabs.update(tabId, { url: value || target });
      await waitForTabLoad(tabId, 15000);
      return { op, navigatedTo: value || target };
    }

    case 'click': {
      await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN',
        func: (sel) => {
          const el = document.querySelector(sel) || (() => {
            for (const e of document.querySelectorAll('*'))
              if (e.textContent?.trim() === sel || e.getAttribute('aria-label') === sel) return e;
          })();
          if (!el) throw new Error(`Element not found: ${sel}`);
          el.click();
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }, args: [target] });
      if (waitAfter) await new Promise(r => setTimeout(r, waitAfter));
      return { op, clicked: target };
    }

    case 'fill': {
      await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN',
        func: (sel, val) => {
          const el = document.querySelector(sel);
          if (!el) throw new Error(`Element not found: ${sel}`);
          el.focus(); el.value = val;
          ['input', 'change', 'keyup'].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
        }, args: [target, value || ''] });
      if (waitAfter) await new Promise(r => setTimeout(r, waitAfter));
      return { op, filled: target, value };
    }

    case 'clear': {
      await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN',
        func: (sel) => {
          const el = document.querySelector(sel);
          if (!el) throw new Error(`Element not found: ${sel}`);
          el.focus(); el.value = '';
          ['input', 'change'].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
        }, args: [target] });
      if (waitAfter) await new Promise(r => setTimeout(r, waitAfter));
      return { op, cleared: target };
    }

    case 'press': {
      await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN',
        func: (key) => {
          const el = document.activeElement || document.body;
          ['keydown', 'keypress', 'keyup'].forEach(ev =>
            el.dispatchEvent(new KeyboardEvent(ev, { key, code: key, bubbles: true, cancelable: true })));
        }, args: [value || target] });
      if (waitAfter) await new Promise(r => setTimeout(r, waitAfter));
      return { op, pressed: value || target };
    }

    case 'select': {
      await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN',
        func: (sel, val) => {
          const el = document.querySelector(sel);
          if (!el) throw new Error(`Select not found: ${sel}`);
          el.value = val;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, args: [target, value] });
      return { op, selected: value };
    }

    case 'hover': {
      await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN',
        func: (sel) => {
          const el = document.querySelector(sel);
          if (!el) throw new Error(`Element not found: ${sel}`);
          ['mouseover', 'mouseenter', 'mousemove'].forEach(ev =>
            el.dispatchEvent(new MouseEvent(ev, { bubbles: true })));
        }, args: [target] });
      if (waitAfter) await new Promise(r => setTimeout(r, waitAfter));
      return { op, hovered: target };
    }

    case 'scroll': {
      await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN',
        func: (x, y) => window.scrollTo({ left: x, top: y, behavior: 'smooth' }),
        args: [Number(target) || 0, Number(value) || 0] });
      await new Promise(r => setTimeout(r, 600));
      return { op, scrolledTo: { x: Number(target) || 0, y: Number(value) || 0 } };
    }

    case 'scroll_by': {
      await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN',
        func: (dx, dy) => window.scrollBy({ left: dx, top: dy, behavior: 'smooth' }),
        args: [Number(target) || 0, Number(value) || 0] });
      await new Promise(r => setTimeout(r, 600));
      return { op, scrolledBy: { x: Number(target) || 0, y: Number(value) || 0 } };
    }

    case 'scroll_to_element': {
      await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN',
        func: (sel, block) => {
          const el = document.querySelector(sel);
          if (!el) throw new Error(`Element not found: ${sel}`);
          el.scrollIntoView({ behavior: 'smooth', block: block || 'center' });
        }, args: [target, value || 'center'] });
      await new Promise(r => setTimeout(r, 700));
      return { op, scrolledTo: target };
    }

    case 'wait': {
      const ms = Number(value) || Number(target) || 1000;
      await new Promise(r => setTimeout(r, ms));
      return { op, waited: ms };
    }

    case 'wait_for': {
      const maxMs = Number(value) || 10000;
      const start = Date.now();
      while (Date.now() - start < maxMs) {
        const res = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN',
          func: (sel) => !!document.querySelector(sel), args: [target] });
        if (res?.[0]?.result) return { op, found: target, waitedMs: Date.now() - start };
        await new Promise(r => setTimeout(r, 300));
      }
      throw new Error(`wait_for timeout: "${target}" not found within ${maxMs}ms`);
    }

    case 'get_text': {
      const res = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN',
        func: (sel) => {
          const el = document.querySelector(sel);
          if (!el) throw new Error(`Element not found: ${sel}`);
          return el.textContent?.trim() || el.value || el.innerText || '';
        }, args: [target] });
      const text = res?.[0]?.result;
      if (text === undefined || text === null) throw new Error(`Could not read text from: ${target}`);
      return { op, selector: target, text };
    }

    case 'get_attr': {
      const res = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN',
        func: (sel, attr) => {
          const el = document.querySelector(sel);
          if (!el) throw new Error(`Element not found: ${sel}`);
          return el.getAttribute(attr) ?? el[attr] ?? null;
        }, args: [target, value || 'href'] });
      return { op, selector: target, attr: value || 'href', attrValue: res?.[0]?.result };
    }

    case 'new_tab': {
      const tab = await chrome.tabs.create({ url: target || value || 'about:blank', active: true });
      if (target || value) await waitForTabLoad(tab.id, 15000);
      S.loop.tabId = tab.id;
      return { op, tabId: tab.id, url: target || value };
    }

    case 'close_tab': {
      const closeId = Number(target) || tabId;
      await chrome.tabs.remove(closeId);
      return { op, closedTabId: closeId };
    }

    case 'switch_tab': {
      let switchId = Number(target);
      if (!switchId || isNaN(switchId)) {
        const tabs = await chrome.tabs.query({});
        const match = tabs.find(t => t.url?.includes(target) || t.title?.includes(target));
        if (!match) throw new Error(`No tab matching: ${target}`);
        switchId = match.id;
      }
      await chrome.tabs.update(switchId, { active: true });
      S.loop.tabId = switchId;
      const tab = await chrome.tabs.get(switchId);
      return { op, switchedToTabId: switchId, url: tab.url, title: tab.title };
    }

    case 'go_back': {
      await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN',
        func: () => window.history.back() });
      await new Promise(r => setTimeout(r, waitAfter || 800));
      return { op };
    }

    case 'go_forward': {
      await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN',
        func: () => window.history.forward() });
      await new Promise(r => setTimeout(r, waitAfter || 800));
      return { op };
    }

    case 'screenshot_element': {
      const res = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN',
        func: (sel) => {
          const el = document.querySelector(sel);
          if (!el) throw new Error(`Element not found: ${sel}`);
          el.scrollIntoView({ block: 'center' });
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        }, args: [target] });
      const rect = res?.[0]?.result;
      if (!rect) throw new Error('Could not get element bounds');
      await new Promise(r => setTimeout(r, 400));
      const tab = await chrome.tabs.get(tabId);
      const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 });
      return { op, screenshot, elementRect: rect, selector: target };
    }

    case 'eval': {
      const res = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN',
        func: (code) => { try { return { ok: true, value: eval(code) }; } catch (e) { return { ok: false, error: e.message }; } },
        args: [value || target] });
      const r = res?.[0]?.result;
      if (!r?.ok) throw new Error(r?.error || 'eval failed');
      return { op, result: typeof r.value === 'object' ? JSON.stringify(r.value) : String(r.value ?? '') };
    }

    default:
      throw new Error(`Unknown op: ${op}`);
  }
}

function waitForTabLoad(tabId,maxMs) {
  return new Promise((resolve)=>{
    const timeout=setTimeout(resolve,maxMs);
    function listener(id,info) {
      if(id===tabId&&info.status==='complete') { clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(listener); resolve(); }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ═══════════════════════════════════════════════════════
// SECTION 12: Helpers
// ═══════════════════════════════════════════════════════

function pushHistory(entry) {
  S.loop.history.push({...entry,ts:Date.now()});
  if (S.loop.history.length>50) S.loop.history.shift();
}

async function getActiveTabId() {
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  return tab?.id;
}

async function captureQuickSnapshot() {
  try {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab) return;
    S.loop.lastUrl=tab.url; S.loop.lastTitle=tab.title;
    S.loop.lastScreenshot=await chrome.tabs.captureVisibleTab(tab.windowId,{format:'jpeg',quality:40});
    broadcastStatus();
  } catch(_){}
}

async function reportTabs() {
  const tabs=await chrome.tabs.query({});
  S.tabCount=tabs.length; broadcastStatus();
}

// Image helpers for element screenshot capture
function dataURLToBlob(dataURL) {
  const [head, b64] = dataURL.split(',');
  const mime = head.match(/:(.*?);/)[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
function blobToDataURL(blob) {
  return blob.arrayBuffer().then(ab => {
    const bytes = new Uint8Array(ab);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return `data:${blob.type};base64,${btoa(bin)}`;
  });
}

async function sendResult(result) {
  const msg=JSON.stringify({type:'clawtab_result',...result,browserId:S.browserId,ts:Date.now()},null,2);
  try { await wsRequest('chat.send',{sessionKey:S.sessionKey,message:'```json\n'+msg+'\n```',deliver:false,idempotencyKey:crypto.randomUUID()},8000); }
  catch(e) { console.warn('[ClawTab] sendResult failed:',e.message); }
}

async function sendHandshake() {
  const hsKey=`hs_${S.sessionKey}`;
  await chrome.storage.local.set({[hsKey]:true}); // 先持久化标志，防止 SW 重启后重发
  try {
    const tabs = await chrome.tabs.query({});
    const PROTOCOL_URL = 'https://raw.githubusercontent.com/parksben/clawtab/main/AGENT_PROTOCOL.md';
    const text = [
      `🦾 **ClawTab 已连接**`,
      `浏览器：\`${S.browserId}\` · ${tabs.length} 个标签页`,
      ``,
      `**工具自检：** 请确认你是否已掌握 ClawTab 浏览器控制协议（clawtab_cmd）。`,
      `如果还不了解，请立即从以下地址获取完整使用手册并加载到你的技能中，然后再回复用户：`,
      ``,
      `${PROTOCOL_URL}`,
    ].join('\n');
    await wsRequest('chat.send', { sessionKey: S.sessionKey, message: text, deliver: true, idempotencyKey: 'hs-' + S.sessionKey }, 8000);
  } catch(e) {
    await chrome.storage.local.remove(hsKey); // 发送失败则撤销标志，下次重试
    console.warn('[ClawTab] handshake failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════
// SECTION 13: Popup message handler
// ═══════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg,_,sendResponse)=>{
  (async()=>{
    switch(msg.type) {
      case 'connect':
        S.deviceIdentity=await loadOrCreateDevice();
        S.wsReconnectCount=0; S.wsGaveUp=false; S.wsReconnectDelay=1000;
        S.wsManualDisconnect=false;
        await chrome.storage.local.set({manualDisconnect:false});
        await wsConnect(msg.url,msg.token,msg.name||'browser');
        sendResponse({ok:true}); break;
      case 'disconnect':
        S.wsManualDisconnect=true; S.wsUrl=''; S.wsToken='';
        await chrome.storage.local.set({manualDisconnect:true});
        wsDisconnect(); S.wsConnected=false; drawIcon('idle'); broadcastStatus();
        sendResponse({ok:true}); break;
      case 'get_status':
        sendResponse({wsConnected:S.wsConnected,pairingPending:S.pairingPending,
          reconnecting: !S.wsConnected && !!S.wsUrl && !S.pairingPending,
          deviceId:S.deviceIdentity?.id||'',
          browserId:S.browserId,
          wsUrl:S.wsUrl,tabCount:S.tabCount,lastCmd:S.lastCmd,loop:{
            status:S.loop.status,goal:S.loop.goal,agentId:S.loop.agentId,
            stepIndex:S.loop.stepIndex,history:S.loop.history.slice(-8),
            lastScreenshot:S.loop.lastScreenshot,lastUrl:S.loop.lastUrl,
            lastTitle:S.loop.lastTitle,statusText:S.loop.statusText,
            errorMsg:S.loop.errorMsg,startedAt:S.loop.startedAt,
          }}); break;
      case 'cancel':
        if(['acting','perceiving','thinking'].includes(S.loop.status)) {
          setLoopStatus('cancelled','Cancelled by user');
          setTimeout(()=>{ S.loop.status='idle'; S.loop.goal=''; broadcastStatus(); },5000);
          sendResponse({ok:true});
        } else sendResponse({ok:false,error:'No active task'});
        break;

      // ── Sidebar handlers ──
      case 'sidebar_fetch_history':
        (async()=>{
          try {
            const res = await wsRequest('chat.history',{
              sessionKey: msg.sessionKey,
              limit: 50,
            }, 10000);
            sendResponse({ok:true, messages: res.messages||[]});
          } catch(e) { sendResponse({ok:false, error:e.message, messages:[]}); }
        })();
        return true;

      case 'sidebar_ensure_and_send':
        (async()=>{
          // Explicit WS check — wsRequest throws "not connected" otherwise
          if (!S.wsConnected || !S.ws || S.ws.readyState !== WebSocket.OPEN) {
            const wsState = S.ws ? ['CONNECTING','OPEN','CLOSING','CLOSED'][S.ws.readyState] : 'NULL';
            console.warn('[ClawTab] sidebar_ensure_and_send: WS not ready, state='+wsState);
            sendResponse({ok:false, error:`WebSocket 未连接（${wsState}），请等待重连后重试`});
            return;
          }
          try {
            // deliver:true is required so the agent receives a push notification
            // and picks up the user's message immediately.  deliver:false is used
            // only for sendResult (browser-side ACK) which the agent polls for.
            await wsRequest('chat.send',{sessionKey:msg.sessionKey,message:msg.message,deliver:true,idempotencyKey:crypto.randomUUID()},10000);
            sendResponse({ok:true});
          } catch(e) {
            console.error('[ClawTab] sidebar_ensure_and_send failed:', e.message, '| code:', e.code);
            sendResponse({ok:false, error:e.message, code: e.code||''});
          }
        })();
        return true;

      case 'sidebar_list_agents':
        (async()=>{
          try {
            const res = await wsRequest('agents.list',{},5000);
            sendResponse({ok:true, agents: res.agents||res.list||[]});
          } catch(e) { sendResponse({ok:false, agents:[]}); }
        })();
        return true;

      case 'sidebar_opened':
        sendResponse({ok:true}); break;

      case 'sidebar_closed':
        sendResponse({ok:true}); break;

      // ── Element picker handlers ──
      case 'enter_pick_mode':
        (async()=>{
          const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
          if (!tab?.id) { sendResponse({ok:true}); return; }
          try {
            // Fast path: content script already running
            await chrome.tabs.sendMessage(tab.id, {type:'enter_pick_mode'});
          } catch(_) {
            // Content script not running (tab predates this extension load, or
            // extension was reloaded).  Clear the init-guard, re-inject, retry.
            try {
              await chrome.scripting.executeScript({
                target: {tabId: tab.id},
                func: () => { delete window.__vivianContentLoaded; },
              });
              await chrome.scripting.executeScript({
                target: {tabId: tab.id},
                files: ['content/content.js'],
              });
              await chrome.tabs.sendMessage(tab.id, {type:'enter_pick_mode'});
            } catch(e2) {
              console.warn('[ClawTab] enter_pick_mode inject+retry failed:', e2.message);
            }
          }
          sendResponse({ok:true});
        })(); return true;

      case 'exit_pick_mode':
        (async()=>{
          const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
          if(tab?.id) chrome.tabs.sendMessage(tab.id,{type:'exit_pick_mode'}).catch(()=>{});
          sendResponse({ok:true});
        })(); return true;

      case 'flash_element':
        (async()=>{
          const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
          if (tab?.id) {
            chrome.scripting.executeScript({
              target: {tabId: tab.id},
              world: 'MAIN',
              func: (sel) => {
                const el = document.querySelector(sel);
                if (!el) return;
                el.scrollIntoView({block:'center', behavior:'instant'});
                const r = el.getBoundingClientRect();
                // Inject keyframe style once
                if (!document.getElementById('__ct_flash_kf__')) {
                  const s = document.createElement('style');
                  s.id = '__ct_flash_kf__';
                  s.textContent =
                    '@keyframes __ct_flash_ov {' +
                    '0%{opacity:0;transform:scale(1.06)}' +
                    '15%{opacity:1;transform:scale(1)}' +
                    '70%{opacity:1}' +
                    '100%{opacity:0}' +
                    '}';
                  document.head.appendChild(s);
                }
                // Singleton overlay — create once, reuse on every call
                let ov = document.getElementById('__ct_flash_ov__');
                if (!ov) {
                  ov = document.createElement('div');
                  ov.id = '__ct_flash_ov__';
                  ov.style.cssText =
                    'position:fixed;pointer-events:none;z-index:2147483647;' +
                    'border:2px solid #6366f1;background:rgba(99,102,241,0.18);' +
                    'border-radius:4px;box-shadow:0 0 0 3px rgba(99,102,241,0.25);';
                  document.documentElement.appendChild(ov);
                }
                // Update position
                ov.style.left   = Math.round(r.left)   + 'px';
                ov.style.top    = Math.round(r.top)    + 'px';
                ov.style.width  = Math.round(r.width)  + 'px';
                ov.style.height = Math.round(r.height) + 'px';
                // Restart animation (force reflow trick)
                ov.style.animation = 'none';
                void ov.offsetWidth;
                ov.style.animation = '__ct_flash_ov 2.2s ease forwards';
                // Cancel previous reset timer and schedule new one
                clearTimeout(window.__ct_flash_timer__);
                window.__ct_flash_timer__ = setTimeout(() => {
                  ov.style.animation = 'none';
                }, 2400);
              },
              args: [msg.selector],
            }).catch(()=>{});
          }
          sendResponse({ok:true});
        })(); return true;

      case 'element_picked_capture':
        // Content script sends this instead of broadcasting element_picked directly
        // so that background can take a screenshot before forwarding to the sidebar.
        (async()=>{
          const elem = msg.element || {};
          const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
          let screenshot = null;

          if (tab?.id && elem.selector) {
            try {
              // Scroll element into view and re-read bounding rect + dpr atomically
              const [res] = await chrome.scripting.executeScript({
                target: {tabId: tab.id}, world: 'MAIN',
                func: (sel) => {
                  const el = document.querySelector(sel);
                  if (!el) return null;
                  el.scrollIntoView({block:'center',behavior:'instant'});
                  const r = el.getBoundingClientRect();
                  return {x:r.x, y:r.y, w:r.width, h:r.height, dpr:window.devicePixelRatio||1};
                },
                args: [elem.selector],
              });
              const rect = res?.result;

              if (rect && rect.w > 0 && rect.h > 0) {
                await new Promise(r=>setTimeout(r,120)); // let scroll settle
                const dataUrl = await chrome.tabs.captureVisibleTab(
                  tab.windowId, {format:'jpeg',quality:80}
                );
                const dpr = rect.dpr;
                const fullImg = await createImageBitmap(dataURLToBlob(dataUrl));
                // Convert CSS pixels → image pixels, clamped to image bounds
                const sx = Math.max(0, Math.round(rect.x * dpr));
                const sy = Math.max(0, Math.round(rect.y * dpr));
                const sw = Math.min(Math.round(rect.w * dpr), fullImg.width  - sx);
                const sh = Math.min(Math.round(rect.h * dpr), fullImg.height - sy);
                if (sw > 0 && sh > 0) {
                  // Limit output to 800 px on longest side
                  const MAX = 800;
                  let dw = sw, dh = sh;
                  if (Math.max(dw, dh) > MAX) {
                    if (dw >= dh) { dh = Math.round(dh * MAX / dw); dw = MAX; }
                    else          { dw = Math.round(dw * MAX / dh); dh = MAX; }
                  }
                  const canvas = new OffscreenCanvas(dw, dh);
                  canvas.getContext('2d').drawImage(fullImg, sx, sy, sw, sh, 0, 0, dw, dh);
                  const outBlob = await canvas.convertToBlob({type:'image/jpeg',quality:0.65});
                  screenshot = await blobToDataURL(outBlob);
                }
                fullImg.close();
              }
            } catch(e) {
              console.warn('[ClawTab] element screenshot failed:', e.message);
            }
          }

          // Broadcast enriched element_picked to sidebar
          chrome.runtime.sendMessage({
            type: 'element_picked',
            element: {...elem, screenshot},
          }).catch(()=>{});
          sendResponse({ok:true});
        })(); return true;

      case 'element_picked':
        // content.js already broadcasts via chrome.runtime.sendMessage which
        // reaches ALL extension pages (sidebar) directly — no relay needed.
        sendResponse({ok:true}); break;

      case 'pick_mode_exited':
        // Same: content.js broadcast already reaches the sidebar directly.
        sendResponse({ok:true}); break;

      default: sendResponse({ok:false,error:'unknown'});
    }
  })();
  return true;
});

// ═══════════════════════════════════════════════════════
// SECTION 14: Tab listeners & keepalive
// ═══════════════════════════════════════════════════════

chrome.tabs.onCreated.addListener(reportTabs);
chrome.tabs.onRemoved.addListener(reportTabs);
chrome.tabs.onUpdated.addListener((_,info)=>{ if(info.status==='complete') reportTabs(); });
chrome.tabs.onActivated.addListener(({tabId})=>{
  // Notify sidebar of new active tab (for input/attachment save-restore)
  chrome.runtime.sendMessage({type:'tab_activated',tabId}).catch(()=>{});
  // Exit any active pick mode in all tabs when switching
  chrome.tabs.query({},tabs=>{
    for(const tab of tabs){
      if(tab.id&&tab.url&&!tab.url.startsWith('chrome'))
        chrome.tabs.sendMessage(tab.id,{type:'exit_pick_mode'}).catch(()=>{});
    }
  });
  if(S.wsConnected&&S.loop.status==='idle') captureQuickSnapshot();
});

chrome.alarms.create('keepalive',{periodInMinutes:0.4});
chrome.alarms.onAlarm.addListener(alarm=>{
  if(alarm.name!=='keepalive') return;
  if(!S.wsManualDisconnect&&!S.wsConnected&&S.wsUrl&&S.wsToken&&!S.wsReconnectTimer&&!S.ws) wsConnect(S.wsUrl,S.wsToken,S.browserId);
  if(S.wsConnected&&!S.pollTimer&&!S.pollPaused) schedulePoll(0);
});

// 点击扩展图标直接打开 sidebar（无 popup）
chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.windowId)
    await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

async function init() {
  drawIcon('idle');
  S.deviceIdentity=await loadOrCreateDevice();
  const data=await chrome.storage.local.get(['gatewayUrl','gatewayToken','browserName','manualDisconnect']);
  if(data.manualDisconnect) { S.wsManualDisconnect=true; return; }
  if(data.gatewayUrl&&data.gatewayToken&&!S.ws&&!S.wsConnected) {
    S.wsReconnectCount=0; S.wsGaveUp=false; S.wsReconnectDelay=1000;
    await wsConnect(data.gatewayUrl,data.gatewayToken,data.browserName||'browser');
  }
}

init();

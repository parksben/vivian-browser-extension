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
// SECTION 4: Broadcast to popup
// ═══════════════════════════════════════════════════════

function broadcast(msg) { chrome.runtime.sendMessage(msg).catch(()=>{}); }

function broadcastStatus() {
  broadcast({
    type: 'status_update',
    wsConnected: S.wsConnected,
    pairingPending: S.pairingPending,
    deviceId: S.deviceIdentity?.id || '',
    browserId: S.browserId,
    wsUrl: S.wsUrl,
    tabCount: S.tabCount,
    lastCmd: S.lastCmd,
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
  // statusText 是动态内容（如操作描述），留空则 popup 用 i18n
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
  const v=nonce?'v2':'v1';
  const parts=[v,dev.id,'webchat','webchat',role,scopes.join(','),String(signedAtMs),token||''];
  if(nonce) parts.push(nonce);
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
  else p.reject(Object.assign(new Error(msg.payload?.message||'failed'),{code:msg.payload?.code}));
}

async function wsConnect(url,token,browserId) {
  wsDisconnect();
  S.wsUrl=url; S.wsToken=token; S.browserId=browserId;
  S.sessionKey=`agent:main:clawtab-${browserId}`;
  drawIcon('connecting'); broadcastStatus();

  try { S.ws=new WebSocket(url); } catch(e) { wsScheduleReconnect(); return; }

  S.ws.onopen = async () => {
    const cid='connect-'+Date.now();
    S.wsPendingConnectId=cid; S.wsPendingNonce=null;
    const stored=await chrome.storage.local.get(['deviceToken']);
    const params={
      minProtocol:3,maxProtocol:3,
      client:{id:'webchat',version:'1.71.3',platform:'web',mode:'webchat'},
      role:'operator',scopes:SCOPES,caps:[],commands:[],permissions:{},
      auth:stored.deviceToken?{token,deviceToken:stored.deviceToken}:{token},
      locale:'zh-CN',
      userAgent:`clawtab/${VERSION}${browserId?' ('+browserId+')':''}`,
    };
    if (S.deviceIdentity) params.device={id:S.deviceIdentity.id,publicKey:S.deviceIdentity.publicKeyRaw};
    wsSend({type:'req',id:cid,method:'connect',params});
  };

  S.ws.onmessage = async (ev) => {
    let msg; try{msg=JSON.parse(ev.data);}catch{return;}
    // challenge
    if (msg.type==='event'&&msg.event==='connect.challenge') {
      S.wsPendingNonce=msg.payload?.nonce||null;
      if (S.deviceIdentity&&S.wsPendingNonce&&S.wsPendingConnectId) {
        const role='operator',scopes=SCOPES,signedAtMs=Date.now();
        const device=await signConnect(S.deviceIdentity,{token:S.wsToken,role,scopes,signedAtMs,nonce:S.wsPendingNonce});
        const stored=await chrome.storage.local.get(['deviceToken']);
        wsSend({type:'req',id:S.wsPendingConnectId,method:'connect',params:{
          minProtocol:3,maxProtocol:3,
          client:{id:'webchat',version:'1.71.3',platform:'web',mode:'webchat'},
          role,scopes,caps:[],commands:[],permissions:{},
          auth:stored.deviceToken?{token:S.wsToken,deviceToken:stored.deviceToken}:{token:S.wsToken},
          device,locale:'zh-CN',
          userAgent:`clawtab/${VERSION}${S.browserId?' ('+S.browserId+')':''}`,
        }});
      }
      return;
    }
    // connect res
    if (msg.type==='res'&&msg.id===S.wsPendingConnectId) {
      S.wsPendingConnectId=null;
      if (msg.ok) {
        S.wsConnected=true; S.pairingPending=false; S.wsReconnectDelay=1000;
        clearTimeout(S.wsReconnectTimer);
        if (msg.payload?.auth?.deviceToken) {
          await chrome.storage.local.set({deviceToken:msg.payload.auth.deviceToken});
        }
        drawIcon('connected'); broadcastStatus();
        await ensureSession(); await syncLastSeenId();
        startPolling(); reportTabs();
        // 连接后立即感知当前页面
        captureQuickSnapshot();
      } else {
        const code=msg.payload?.code||'';
        if (code==='NOT_PAIRED') { S.pairingPending=true; drawIcon('connecting'); broadcastStatus(); }
        else wsScheduleReconnect();
      }
      return;
    }
    // other res
    if (msg.type==='res') { resolvePending(msg.id,msg); return; }
  };

  S.ws.onerror=()=>{};
  S.ws.onclose=()=>{
    S.ws=null; S.wsConnected=false;
    if (S.loop.status==='acting'||S.loop.status==='perceiving') {
      setLoopStatus('failed','Connection lost during task',{errorMsg:'WebSocket disconnected'});
      sendResult({cmdId:S.loop.cmdId,ok:false,error:'Connection lost',errorCode:'DISCONNECTED'});
    }
    stopPolling(); drawIcon(S.pairingPending?'connecting':'idle'); broadcastStatus();
    wsScheduleReconnect();
  };
}

function wsDisconnect() {
  clearTimeout(S.wsReconnectTimer); stopPolling();
  if (S.ws){try{S.ws.close();}catch(_){} S.ws=null;}
  S.wsConnected=false;
}

function wsScheduleReconnect() {
  if (!S.wsUrl||!S.wsToken) return;
  clearTimeout(S.wsReconnectTimer);
  S.wsReconnectTimer=setTimeout(()=>wsConnect(S.wsUrl,S.wsToken,S.browserId),S.wsReconnectDelay);
  S.wsReconnectDelay=Math.min(S.wsReconnectDelay*2,30000);
}

// ═══════════════════════════════════════════════════════
// SECTION 7: Session & Polling
// ═══════════════════════════════════════════════════════

async function ensureSession() {
  try { await wsRequest('sessions.create',{channel:'clawtab',sessionKey:S.sessionKey},8000); S.sessionExists=true; }
  catch(e) { if(e.code==='SESSION_EXISTS'||e.message?.includes('exists')) S.sessionExists=true; }
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
      sessionKey:S.sessionKey,limit:10,
      ...(S.lastSeenMsgId?{after:S.lastSeenMsgId}:{}),
    },8000);
    S.pollBackoff=POLL_IDLE_MS;
    for (const msg of (res.messages||[])) {
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

function describeOp(op,target,value) {
  const t=target?`"${String(target).slice(0,30)}"`:null;
  const v=value?`"${String(value).slice(0,30)}"`:null;
  switch(op) {
    case 'click':    return t?`Clicking ${t}`:'Clicking element';
    case 'fill':     return t&&v?`Typing ${v} into ${t}`:'Filling input';
    case 'navigate': return v?`Navigating to ${v}`:'Navigating…';
    case 'scroll':   return `Scrolling page`;
    case 'press':    return v?`Pressing ${v}`:'Pressing key';
    case 'select':   return t?`Selecting in ${t}`:'Selecting option';
    case 'hover':    return t?`Hovering ${t}`:'Hovering element';
    case 'wait':     return `Waiting ${target||500}ms`;
    default:         return op;
  }
}

async function executeAct(tabId,op,target,value,waitAfter) {
  switch(op) {
    case 'navigate': {
      await chrome.tabs.update(tabId,{url:value||target});
      await waitForTabLoad(tabId,15000);
      return {op,navigatedTo:value||target};
    }
    case 'click': {
      await chrome.scripting.executeScript({target:{tabId},world:'MAIN',
        func:(sel)=>{
          const el=document.querySelector(sel)||(()=>{
            const els=document.querySelectorAll('*');
            for(const e of els) if(e.textContent?.trim()===sel||e.getAttribute('aria-label')===sel) return e;
            return null;
          })();
          if(!el) throw new Error(`Element not found: ${sel}`);
          el.click();
          el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
        },args:[target]});
      if(waitAfter) await new Promise(r=>setTimeout(r,waitAfter));
      return {op,clicked:target};
    }
    case 'fill': {
      await chrome.scripting.executeScript({target:{tabId},world:'MAIN',
        func:(sel,val)=>{
          const el=document.querySelector(sel);
          if(!el) throw new Error(`Element not found: ${sel}`);
          el.focus();
          el.value=val;
          ['input','change','keyup'].forEach(ev=>el.dispatchEvent(new Event(ev,{bubbles:true})));
        },args:[target,value||'']});
      if(waitAfter) await new Promise(r=>setTimeout(r,waitAfter));
      return {op,filled:target,value};
    }
    case 'press': {
      await chrome.scripting.executeScript({target:{tabId},world:'MAIN',
        func:(key)=>{
          const focused=document.activeElement||document.body;
          ['keydown','keypress','keyup'].forEach(ev=>focused.dispatchEvent(new KeyboardEvent(ev,{key,code:key,bubbles:true})));
        },args:[value||target]});
      if(waitAfter) await new Promise(r=>setTimeout(r,waitAfter));
      return {op,pressed:value||target};
    }
    case 'scroll': {
      await chrome.scripting.executeScript({target:{tabId},world:'MAIN',
        func:(x,y)=>window.scrollTo({left:x,top:y,behavior:'smooth'}),args:[target||0,value||0]});
      await new Promise(r=>setTimeout(r,600));
      return {op,scrolledTo:{x:target,y:value}};
    }
    case 'select': {
      await chrome.scripting.executeScript({target:{tabId},world:'MAIN',
        func:(sel,val)=>{
          const el=document.querySelector(sel);
          if(!el) throw new Error(`Select not found: ${sel}`);
          el.value=val;
          el.dispatchEvent(new Event('change',{bubbles:true}));
        },args:[target,value]});
      return {op,selected:value};
    }
    case 'hover': {
      await chrome.scripting.executeScript({target:{tabId},world:'MAIN',
        func:(sel)=>{
          const el=document.querySelector(sel);
          if(!el) throw new Error(`Element not found: ${sel}`);
          el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
          el.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}));
        },args:[target]});
      if(waitAfter) await new Promise(r=>setTimeout(r,waitAfter));
      return {op,hovered:target};
    }
    case 'wait': {
      await new Promise(r=>setTimeout(r,Number(target)||value||1000));
      return {op,waited:Number(target)||value||1000};
    }
    case 'eval': {
      const res=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',
        func:(code)=>{ try{return{ok:true,value:eval(code)};}catch(e){return{ok:false,error:e.message};} },
        args:[value||target]});
      const r=res?.[0]?.result;
      if(!r?.ok) throw new Error(r?.error||'eval failed');
      return {op,result:typeof r.value==='object'?JSON.stringify(r.value):String(r.value??'')};
    }
    default: throw new Error(`Unknown op: ${op}`);
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

async function sendResult(result) {
  const msg=JSON.stringify({type:'clawtab_result',...result,browserId:S.browserId,ts:Date.now()},null,2);
  try { await wsRequest('chat.send',{sessionKey:S.sessionKey,message:'```json\n'+msg+'\n```',deliver:false},8000); }
  catch(e) { console.warn('[ClawTab] sendResult failed:',e.message); }
}

// ═══════════════════════════════════════════════════════
// SECTION 13: Popup message handler
// ═══════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg,_,sendResponse)=>{
  (async()=>{
    switch(msg.type) {
      case 'connect':
        S.deviceIdentity=await loadOrCreateDevice();
        await wsConnect(msg.url,msg.token,msg.name||'browser');
        sendResponse({ok:true}); break;
      case 'disconnect':
        wsDisconnect(); S.wsConnected=false; drawIcon('idle'); broadcastStatus();
        sendResponse({ok:true}); break;
      case 'get_status':
        sendResponse({wsConnected:S.wsConnected,pairingPending:S.pairingPending,
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
chrome.tabs.onActivated.addListener(()=>{ if(S.wsConnected&&S.loop.status==='idle') captureQuickSnapshot(); });

chrome.alarms.create('keepalive',{periodInMinutes:0.4});
chrome.alarms.onAlarm.addListener(alarm=>{
  if(alarm.name!=='keepalive') return;
  if(!S.wsConnected&&S.wsUrl&&S.wsToken&&!S.wsReconnectTimer) wsConnect(S.wsUrl,S.wsToken,S.browserId);
  if(S.wsConnected&&!S.pollTimer&&!S.pollPaused) schedulePoll(0);
});

async function init() {
  drawIcon('idle');
  S.deviceIdentity=await loadOrCreateDevice();
  const data=await chrome.storage.local.get(['gatewayUrl','gatewayToken','browserName']);
  if(data.gatewayUrl&&data.gatewayToken) await wsConnect(data.gatewayUrl,data.gatewayToken,data.browserName||'browser');
}

init();

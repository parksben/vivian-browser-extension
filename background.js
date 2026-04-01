/**
 * background.js - Service Worker
 * 管理 WebSocket 连接生命周期，接收 Gateway 指令并执行
 */

const VERSION = '1.0.0';

let ws = null;
let wsUrl = null;
let wsToken = null;
let wsClientId = 'vivian-ext-' + Math.random().toString(36).slice(2, 8);
let pendingConnectId = null;
let reconnectTimer = null;
let reconnectDelay = 1000; // 初始重连延迟 1s
const MAX_RECONNECT_DELAY = 30000; // 最大重连延迟 30s
let isConnected = false;
let lastCommand = '';
let tabCount = 0;

// ─────────────────────────────────────────────
// Icon 动态生成（OffscreenCanvas）
// ─────────────────────────────────────────────

function drawIcon(connected) {
  const sizes = [16, 48, 128];
  const imageData = {};

  for (const size of sizes) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');

    // 背景
    const bgColor = connected ? '#22d3ee' : '#64748b';
    ctx.fillStyle = bgColor;
    // 圆角矩形（近似）
    const r = size * 0.2;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(size - r, 0);
    ctx.quadraticCurveTo(size, 0, size, r);
    ctx.lineTo(size, size - r);
    ctx.quadraticCurveTo(size, size, size - r, size);
    ctx.lineTo(r, size);
    ctx.quadraticCurveTo(0, size, 0, size - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fill();

    // 字母 V
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.floor(size * 0.6)}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('V', size / 2, size / 2 + size * 0.03);

    imageData[size] = ctx.getImageData(0, 0, size, size);
  }

  chrome.action.setIcon({ imageData });
}

// ─────────────────────────────────────────────
// WebSocket 管理
// ─────────────────────────────────────────────

function connect(url, token) {
  if (ws) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try { ws.close(); } catch (_) {}
    ws = null;
  }

  wsUrl = url;
  wsToken = token;

  if (!url || !token) return;

  setStatus('connecting');

  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.error('[Vivian] WebSocket init error:', e);
    setStatus('disconnected');
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[Vivian] WebSocket connected, sending handshake...');
    // OpenClaw Gateway 标准握手协议
    const connectId = 'connect-' + Date.now();
    pendingConnectId = connectId;
    ws.send(JSON.stringify({
      type: 'req',
      id: connectId,
      method: 'connect',
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: { id: wsClientId, version: '1.71.3', platform: 'web', mode: 'webchat' },
        role: 'operator',
        scopes: ['operator.read', 'operator.write', 'operator.admin', 'operator.approvals'],
        caps: [], commands: [], permissions: {},
        auth: { token: wsToken },
        locale: 'zh-CN',
        userAgent: 'vivian-browser-extension/' + VERSION
      }
    }));
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      console.warn('[Vivian] Invalid JSON:', event.data);
      return;
    }

    // 处理握手响应
    if (msg.type === 'res' && msg.id === pendingConnectId) {
      pendingConnectId = null;
      if (msg.ok) {
        console.log('[Vivian] Handshake OK, connected!');
        reconnectDelay = 1000;
        clearTimeout(reconnectTimer);
        isConnected = true;
        setStatus('connected');
        drawIcon(true);
        reportTabs();
      } else {
        const code = msg.payload?.code || msg.error?.code || '';
        console.error('[Vivian] Handshake failed:', code, msg);
        if (code === 'NOT_PAIRED') {
          setStatus('pairing');
        } else {
          setStatus('disconnected');
          scheduleReconnect();
        }
      }
      return;
    }

    // 处理 connect.challenge 事件（无需 device identity，直接忽略）
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      // 不需要 device identity，Gateway 会在 connect req 后直接响应
      return;
    }

    // 处理来自 Gateway 的指令（event 类型）
    if (msg.type === 'event') {
      await handleCommand(msg.payload || msg);
      return;
    }

    console.log('[Vivian] Unhandled msg type:', msg.type, msg);
  };

  ws.onerror = (err) => {
    console.error('[Vivian] WebSocket error:', err);
  };

  ws.onclose = (ev) => {
    console.log('[Vivian] WebSocket closed:', ev.code, ev.reason);
    isConnected = false;
    ws = null;
    setStatus('disconnected');
    drawIcon(false);
    scheduleReconnect();
  };
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (!wsUrl || !wsToken) return;
  console.log(`[Vivian] Reconnecting in ${reconnectDelay}ms...`);
  reconnectTimer = setTimeout(() => {
    connect(wsUrl, wsToken);
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

function setStatus(status) {
  // 广播给 popup
  chrome.runtime.sendMessage({ type: 'status_update', status, lastCommand, tabCount })
    .catch(() => {}); // popup 可能未打开，忽略错误
}

// ─────────────────────────────────────────────
// 指令处理
// ─────────────────────────────────────────────

async function handleCommand(msg) {
  lastCommand = msg.type;
  setStatus(isConnected ? 'connected' : 'disconnected');

  const timeout = (ms, label) => new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms)
  );

  try {
    switch (msg.type) {
      case 'get_tabs':
        await reportTabs();
        break;

      case 'get_page_content':
        await Promise.race([
          getPageContent(msg.tabId),
          timeout(10000, 'get_page_content')
        ]);
        break;

      case 'execute_js':
        await Promise.race([
          executeJS(msg),
          timeout(10000, 'execute_js')
        ]);
        break;

      case 'navigate':
        await Promise.race([
          navigateTab(msg),
          timeout(10000, 'navigate')
        ]);
        break;

      case 'screenshot':
        await Promise.race([
          takeScreenshot(msg),
          timeout(10000, 'screenshot')
        ]);
        break;

      default:
        console.warn('[Vivian] Unknown command:', msg.type);
    }
  } catch (e) {
    console.error('[Vivian] Command error:', e);
    if (msg.actionId) {
      send({ type: 'action_result', actionId: msg.actionId, ok: false, result: e.message });
    }
  }
}

// ─────────────────────────────────────────────
// 功能实现
// ─────────────────────────────────────────────

async function reportTabs() {
  const tabs = await chrome.tabs.query({});
  tabCount = tabs.length;
  setStatus(isConnected ? 'connected' : 'disconnected');
  send({
    type: 'tabs_list',
    tabs: tabs.map(t => ({
      id: t.id,
      url: t.url,
      title: t.title,
      favIconUrl: t.favIconUrl || '',
      active: t.active,
      windowId: t.windowId
    }))
  });
}

async function getPageContent(tabId) {
  // 若没有指定 tabId，使用当前激活标签页
  let targetTabId = tabId;
  if (!targetTabId) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) throw new Error('No active tab');
    targetTabId = activeTab.id;
  }

  const tab = await chrome.tabs.get(targetTabId);

  // 注入脚本获取页面内容
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      func: extractPageContent
    });
  } catch (e) {
    // 某些页面（chrome://、扩展页）不允许注入
    send({
      type: 'page_content',
      tabId: targetTabId,
      url: tab.url,
      title: tab.title,
      text: '[无法访问此页面内容]',
      html: ''
    });
    return;
  }

  const content = results[0]?.result || { text: '', html: '' };
  send({
    type: 'page_content',
    tabId: targetTabId,
    url: tab.url,
    title: tab.title,
    text: content.text,
    html: content.html
  });
}

// 在页面上下文中执行，提取内容
function extractPageContent() {
  const text = document.body?.innerText || '';
  const clone = document.body?.cloneNode(true);
  if (clone) {
    // 移除 script/style/noscript
    clone.querySelectorAll('script, style, noscript, svg').forEach(el => el.remove());
    const html = clone.innerHTML
      .replace(/\s{2,}/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim();
    return { text: text.slice(0, 50000), html: html.slice(0, 100000) };
  }
  return { text: text.slice(0, 50000), html: '' };
}

async function executeJS(msg) {
  const { actionId, tabId, code } = msg;

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      func: new Function(`return (async () => { ${code} })()`), // eslint-disable-line no-new-func
      args: []
    });
  } catch (e) {
    // 使用字符串注入方式
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (codeStr) => {
          try {
            // eslint-disable-next-line no-eval
            return eval(codeStr);
          } catch (err) {
            return { __error: err.message };
          }
        },
        args: [code]
      });
    } catch (e2) {
      send({ type: 'action_result', actionId, ok: false, result: e2.message });
      return;
    }
  }

  const result = results?.[0]?.result;
  if (result && typeof result === 'object' && result.__error) {
    send({ type: 'action_result', actionId, ok: false, result: result.__error });
  } else {
    send({ type: 'action_result', actionId, ok: true, result: JSON.stringify(result) });
  }
}

async function navigateTab(msg) {
  const { actionId, tabId, url } = msg;
  try {
    await chrome.tabs.update(tabId, { url });
    send({ type: 'action_result', actionId, ok: true, result: `Navigated to ${url}` });
  } catch (e) {
    send({ type: 'action_result', actionId, ok: false, result: e.message });
  }
}

async function takeScreenshot(msg) {
  const { actionId, tabId } = msg;
  try {
    // 需要先把目标标签激活（captureVisibleTab 只能截当前可见标签页）
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    // 等待标签激活
    await new Promise(r => setTimeout(r, 300));
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    send({ type: 'action_result', actionId, ok: true, result: dataUrl });
  } catch (e) {
    send({ type: 'action_result', actionId, ok: false, result: e.message });
  }
}

// ─────────────────────────────────────────────
// 初始化 & 生命周期
// ─────────────────────────────────────────────

async function init() {
  drawIcon(false);
  const { gatewayUrl, gatewayToken } = await chrome.storage.local.get(['gatewayUrl', 'gatewayToken']);
  if (gatewayUrl && gatewayToken) {
    connect(gatewayUrl, gatewayToken);
  }
}

// 监听来自 popup 的消息
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'connect') {
    connect(msg.url, msg.token);
    sendResponse({ ok: true });
  } else if (msg.type === 'disconnect') {
    clearTimeout(reconnectTimer);
    wsUrl = null;
    wsToken = null;
    if (ws) {
      try { ws.close(); } catch (_) {}
      ws = null;
    }
    isConnected = false;
    drawIcon(false);
    sendResponse({ ok: true });
  } else if (msg.type === 'get_status') {
    sendResponse({ status: isConnected ? 'connected' : 'disconnected', lastCommand, tabCount, wsUrl });
  }
  return true; // 保持异步响应
});

// 标签页变化时更新计数
chrome.tabs.onCreated.addListener(() => reportTabsIfConnected());
chrome.tabs.onRemoved.addListener(() => reportTabsIfConnected());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === 'complete') reportTabsIfConnected();
});

function reportTabsIfConnected() {
  if (isConnected) reportTabs();
}

// Service Worker 激活时初始化
init();

// 防止 Service Worker 被终止（使用 alarm 保活）
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    // 检查 ws 状态，若断连且有配置则重连
    if (!isConnected && wsUrl && wsToken && !reconnectTimer) {
      connect(wsUrl, wsToken);
    }
  }
});

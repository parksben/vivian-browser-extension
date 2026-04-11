/**
 * content.js - 注入页面的内容脚本
 * 负责在页面上下文中执行来自 background 的操作指令
 */

(function () {
  'use strict';

  // 防止重复注入
  if (window.__vivianContentLoaded) return;
  window.__vivianContentLoaded = true;

  // 监听来自 background 的消息
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    handleMessage(msg)
      .then(result => sendResponse({ ok: true, result }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // 保持异步
  });

  async function handleMessage(msg) {
    const timeout = (ms) => new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), ms)
    );

    switch (msg.type) {
      case 'get_content':
        return getContent();

      case 'click':
        return await Promise.race([click(msg.selector), timeout(10000)]);

      case 'fill':
        return await Promise.race([fill(msg.selector, msg.value), timeout(10000)]);

      case 'scroll':
        return scroll(msg.x, msg.y);

      case 'eval':
        return await Promise.race([evalCode(msg.code), timeout(10000)]);

      case 'enter_pick_mode':
        enterPickMode();
        return { status: 'entered' };

      case 'exit_pick_mode':
        exitPickMode();
        return { status: 'exited' };

      default:
        throw new Error(`Unknown message type: ${msg.type}`);
    }
  }

  // 获取页面内容
  function getContent() {
    const text = document.body?.innerText || '';
    const clone = document.body?.cloneNode(true);
    if (clone) {
      clone.querySelectorAll('script, style, noscript, svg').forEach(el => el.remove());
      const html = clone.innerHTML
        .replace(/\s{2,}/g, ' ')
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim();
      return {
        text: text.slice(0, 50000),
        html: html.slice(0, 100000),
        url: location.href,
        title: document.title
      };
    }
    return { text: text.slice(0, 50000), html: '', url: location.href, title: document.title };
  }

  // 点击元素
  async function click(selector) {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    el.click();
    return `Clicked: ${selector}`;
  }

  // 填写表单
  async function fill(selector, value) {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    el.focus();
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return `Filled: ${selector} = ${value}`;
  }

  // 滚动页面
  function scroll(x, y) {
    window.scrollTo(x ?? 0, y ?? 0);
    return `Scrolled to (${x}, ${y})`;
  }

  // 执行代码
  async function evalCode(code) {
    try {
      // eslint-disable-next-line no-eval
      const result = eval(code);
      if (result instanceof Promise) {
        return await result;
      }
      return result;
    } catch (e) {
      throw new Error(`Eval error: ${e.message}`);
    }
  }

  // ── Element picker mode ────────────────────────────────────────────────────

  let _pickMode = false;
  let _pickHighlight = null;
  const _pickHandlers = {};

  function enterPickMode() {
    if (_pickMode) return;
    _pickMode = true;

    // Highlight overlay (pointer-events: none so it doesn't interfere with hover targets)
    _pickHighlight = document.createElement('div');
    _pickHighlight.id = '__clawtab_pick_hl__';
    _pickHighlight.style.cssText = [
      'position:fixed', 'pointer-events:none', 'z-index:2147483647',
      'border:2px solid #6366f1', 'background:rgba(99,102,241,0.12)',
      'border-radius:3px', 'box-shadow:0 0 0 1px rgba(99,102,241,0.3)',
      'transition:top .08s,left .08s,width .08s,height .08s', 'display:none',
    ].join(';');
    document.documentElement.appendChild(_pickHighlight);

    _pickHandlers.mousemove = (e) => {
      const el = e.target;
      if (!el || el === _pickHighlight) return;
      const rect = el.getBoundingClientRect();
      const hl = _pickHighlight;
      hl.style.display = 'block';
      hl.style.left   = rect.left + 'px';
      hl.style.top    = rect.top  + 'px';
      hl.style.width  = rect.width  + 'px';
      hl.style.height = rect.height + 'px';
    };

    _pickHandlers.click = (e) => {
      const el = e.target;
      if (!el || el === _pickHighlight) return;
      e.preventDefault();
      e.stopPropagation();
      const info = captureElement(el);
      exitPickMode();
      // Send to background only — background will take the screenshot and
      // broadcast the enriched element_picked message to the sidebar.
      chrome.runtime.sendMessage({ type: 'element_picked_capture', element: info }).catch(() => {});
    };

    _pickHandlers.keydown = (e) => {
      if (e.key === 'Escape') {
        exitPickMode();
        chrome.runtime.sendMessage({ type: 'pick_mode_exited' }).catch(() => {});
      }
    };

    document.addEventListener('mousemove', _pickHandlers.mousemove, true);
    document.addEventListener('click',     _pickHandlers.click,     true);
    document.addEventListener('keydown',   _pickHandlers.keydown,   true);
    document.documentElement.style.cursor = 'crosshair';
  }

  function exitPickMode() {
    if (!_pickMode) return;
    _pickMode = false;
    if (_pickHighlight) { _pickHighlight.remove(); _pickHighlight = null; }
    document.removeEventListener('mousemove', _pickHandlers.mousemove, true);
    document.removeEventListener('click',     _pickHandlers.click,     true);
    document.removeEventListener('keydown',   _pickHandlers.keydown,   true);
    document.documentElement.style.cursor = '';
  }

  function captureElement(el) {
    const tag     = el.tagName.toLowerCase();
    const id      = el.id || '';
    const classes = Array.from(el.classList).slice(0, 4);
    const text    = (el.textContent || el.value || el.placeholder || el.alt || '').trim().slice(0, 80);
    const selector = computePickSelector(el);
    // Bounding rect + device pixel ratio — background uses these to crop the screenshot
    const r = el.getBoundingClientRect();
    const rect = {
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height),
      dpr: window.devicePixelRatio || 1,
    };
    return { tag, id, classes, text, selector, rect };
  }

  function computePickSelector(el) {
    // Try ID-based selector first — only if the ID is unique in the document
    if (el.id) {
      const sel = '#' + CSS.escape(el.id);
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (_) {}
    }
    // Build a full :nth-child path (guaranteed globally unique).
    // Stop early when we hit a uniquely-IDed ancestor to keep the selector short.
    const parts = [];
    let cur = el;
    while (cur && cur !== document.documentElement) {
      if (cur !== el && cur.id) {
        const anc = '#' + CSS.escape(cur.id);
        try {
          if (document.querySelectorAll(anc).length === 1) { parts.unshift(anc); break; }
        } catch (_) {}
      }
      const parent = cur.parentElement;
      const tag = cur.tagName.toLowerCase();
      if (parent) {
        const idx = Array.from(parent.children).indexOf(cur) + 1;
        parts.unshift(`${tag}:nth-child(${idx})`);
      } else {
        parts.unshift(tag);
      }
      cur = parent;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }
})();

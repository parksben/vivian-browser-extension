// Content script — injected into every page. Handles:
//   - Remote commands (click / fill / scroll / eval / get_content)
//   - Element picker mode (enter / exit / captureElement)
//
// Invariants (see CLAUDE.md Key Pitfalls):
//   - The picker highlight overlay and cursor restoration must never leak
//     between enter/exit cycles.
//   - Messages to the background are fire-and-forget for "element_picked_capture"
//     and "pick_mode_exited" — background takes the screenshot and broadcasts
//     the enriched element back to the sidebar.
//   - No Tailwind here. The host page doesn't load extension CSS; all styling
//     must be inline via element.style.* or cssText.

import type {
  BackgroundToContentMessage,
  ContentResponse,
  ElementPickedCaptureRequest,
  PickModeExitedContentRequest,
} from '@/shared/types/messages';
import type { CapturedElement, PickRect } from '@/shared/types/picker';

// Prevent duplicate injection. The legacy name is kept so existing tabs with
// the old content script still refuse a second inject.
interface ContentGlobal {
  __vivianContentLoaded?: boolean;
}
const g = window as unknown as ContentGlobal;
if (g.__vivianContentLoaded) {
  // already injected
} else {
  g.__vivianContentLoaded = true;
  install();
}

function install(): void {
  chrome.runtime.onMessage.addListener(
    (msg: BackgroundToContentMessage, _sender, sendResponse: (r: ContentResponse) => void) => {
      handleMessage(msg)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
      return true; // keep the channel open for async sendResponse
    },
  );
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms));
}

async function handleMessage(msg: BackgroundToContentMessage): Promise<unknown> {
  switch (msg.type) {
    case 'get_content':
      return getContent();
    case 'click':
      return Promise.race([click(msg.selector), timeout(10_000)]);
    case 'fill':
      return Promise.race([fill(msg.selector, msg.value), timeout(10_000)]);
    case 'scroll':
      return scroll(msg.x, msg.y);
    case 'eval':
      return Promise.race([evalCode(msg.code), timeout(10_000)]);
    case 'enter_pick_mode':
      enterPickMode();
      return { status: 'entered' };
    case 'exit_pick_mode':
      exitPickMode();
      return { status: 'exited' };
    default: {
      const exhaustive: never = msg;
      throw new Error(`Unknown message type: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// ── Content extraction ──────────────────────────────────────────────────────

interface PageContent {
  text: string;
  html: string;
  url: string;
  title: string;
}

function getContent(): PageContent {
  const text = document.body?.innerText ?? '';
  const clone = document.body?.cloneNode(true) as HTMLElement | null;
  if (clone) {
    clone.querySelectorAll('script, style, noscript, svg').forEach((el) => el.remove());
    const html = clone.innerHTML
      .replace(/\s{2,}/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim();
    return {
      text: text.slice(0, 50_000),
      html: html.slice(0, 100_000),
      url: location.href,
      title: document.title,
    };
  }
  return {
    text: text.slice(0, 50_000),
    html: '',
    url: location.href,
    title: document.title,
  };
}

// ── Remote ops ──────────────────────────────────────────────────────────────

async function click(selector: string): Promise<string> {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  el.click();
  return `Clicked: ${selector}`;
}

async function fill(selector: string, value: string): Promise<string> {
  const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  el.focus();
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return `Filled: ${selector} = ${value}`;
}

function scroll(x?: number, y?: number): string {
  window.scrollTo(x ?? 0, y ?? 0);
  return `Scrolled to (${x}, ${y})`;
}

async function evalCode(code: string): Promise<unknown> {
  try {
    // eslint-disable-next-line no-eval
    const result = eval(code) as unknown;
    if (result instanceof Promise) return await result;
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Eval error: ${msg}`);
  }
}

// ── Element picker mode ─────────────────────────────────────────────────────

let pickMode = false;
let pickHighlight: HTMLDivElement | null = null;

interface PickHandlers {
  mousemove?: (e: MouseEvent) => void;
  click?: (e: MouseEvent) => void;
  keydown?: (e: KeyboardEvent) => void;
}
const pickHandlers: PickHandlers = {};

function enterPickMode(): void {
  if (pickMode) return;
  pickMode = true;

  pickHighlight = document.createElement('div');
  pickHighlight.id = '__clawtab_pick_hl__';
  pickHighlight.style.cssText = [
    'position:fixed',
    'pointer-events:none',
    'z-index:2147483647',
    'border:2px solid #6366f1',
    'background:rgba(99,102,241,0.12)',
    'border-radius:3px',
    'box-shadow:0 0 0 1px rgba(99,102,241,0.3)',
    'transition:top .08s,left .08s,width .08s,height .08s',
    'display:none',
  ].join(';');
  document.documentElement.appendChild(pickHighlight);

  pickHandlers.mousemove = (e) => {
    const el = e.target as Element | null;
    if (!el || el === pickHighlight) return;
    const rect = el.getBoundingClientRect();
    const hl = pickHighlight;
    if (!hl) return;
    hl.style.display = 'block';
    hl.style.left = rect.left + 'px';
    hl.style.top = rect.top + 'px';
    hl.style.width = rect.width + 'px';
    hl.style.height = rect.height + 'px';
  };

  pickHandlers.click = (e) => {
    const el = e.target as Element | null;
    if (!el || el === pickHighlight) return;
    e.preventDefault();
    e.stopPropagation();
    const info = captureElement(el as HTMLElement);
    exitPickMode();
    const reply: ElementPickedCaptureRequest = {
      type: 'element_picked_capture',
      element: info,
    };
    chrome.runtime.sendMessage(reply).catch(() => {});
  };

  pickHandlers.keydown = (e) => {
    if (e.key === 'Escape') {
      exitPickMode();
      const exited: PickModeExitedContentRequest = { type: 'pick_mode_exited' };
      chrome.runtime.sendMessage(exited).catch(() => {});
    }
  };

  document.addEventListener('mousemove', pickHandlers.mousemove, true);
  document.addEventListener('click', pickHandlers.click, true);
  document.addEventListener('keydown', pickHandlers.keydown, true);
  document.documentElement.style.cursor = 'crosshair';
}

function exitPickMode(): void {
  if (!pickMode) return;
  pickMode = false;
  if (pickHighlight) {
    pickHighlight.remove();
    pickHighlight = null;
  }
  if (pickHandlers.mousemove)
    document.removeEventListener('mousemove', pickHandlers.mousemove, true);
  if (pickHandlers.click)
    document.removeEventListener('click', pickHandlers.click, true);
  if (pickHandlers.keydown)
    document.removeEventListener('keydown', pickHandlers.keydown, true);
  document.documentElement.style.cursor = '';
}

function captureElement(el: HTMLElement): CapturedElement {
  const tag = el.tagName.toLowerCase();
  const id = el.id || '';
  const classes = Array.from(el.classList).slice(0, 4);
  const inputValue =
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : '';
  const text =
    (el.textContent || inputValue || el.getAttribute('placeholder') || el.getAttribute('alt') || '')
      .trim()
      .slice(0, 80);
  const selector = computePickSelector(el);
  const r = el.getBoundingClientRect();
  const rect: PickRect = {
    x: Math.round(r.x),
    y: Math.round(r.y),
    w: Math.round(r.width),
    h: Math.round(r.height),
    dpr: window.devicePixelRatio || 1,
  };
  return { tag, id, classes, text, selector, rect };
}

function computePickSelector(el: HTMLElement): string {
  if (el.id) {
    const sel = '#' + CSS.escape(el.id);
    try {
      if (document.querySelectorAll(sel).length === 1) return sel;
    } catch {
      /* ignore */
    }
  }
  const parts: string[] = [];
  let cur: HTMLElement | null = el;
  while (cur && cur !== document.documentElement) {
    if (cur !== el && cur.id) {
      const anc = '#' + CSS.escape(cur.id);
      try {
        if (document.querySelectorAll(anc).length === 1) {
          parts.unshift(anc);
          break;
        }
      } catch {
        /* ignore */
      }
    }
    const parent: HTMLElement | null = cur.parentElement;
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

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClawTab is a Chrome Extension (Manifest V3) that connects a browser to an OpenClaw Gateway, enabling AI agents to observe and control browser tabs. It is **pure vanilla JavaScript** — no build tools, no npm, no TypeScript, no framework.

## Development Workflow

**Load/Reload the extension:**
1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" → select this directory
4. After edits, click the refresh icon on the extension card

There is no build step, no `npm install`, and no test suite. Changes take effect immediately after reloading the extension.

## Architecture

The extension has three isolated components that communicate via `chrome.runtime.sendMessage`:

| File | Role |
|------|------|
| `background.js` | Service Worker — central hub managing WebSocket, command polling, tab operations |
| `sidebar/sidebar.js` | Sidebar UI — dual-page (Config + Chat), renders messages, handles user input |
| `content/content.js` | Content script — DOM element picker, injected into all pages |

**`shared/icons.js`** provides the Lucide SVG sprite used across sidebar components.

### Connection & Pairing Flow

```
User fills config (URL, Token, Channel)
  → WebSocket connect → Ed25519 challenge-response handshake
  → Device pairing approved via CLI: openclaw devices approve <id>
  → deviceToken stored → reused on next connection
  → Chat polling loop (~3 sec) for clawtab_cmd JSON blocks
  → Execute command → send clawtab_result → agent reads result
```

### Command Execution

`background.js` polls `chat.history` for messages containing `clawtab_cmd` JSON blocks. Supported actions: `perceive` (DOM + JPEG screenshot), `act` (20+ browser operations), `task_start`, `task_done`, `task_fail`, `cancel`. Results are returned as `clawtab_result` JSON blocks (hidden from the chat UI).

An **exclusive lock** ensures only one agent can execute `act`/`perceive` at a time; others receive `BUSY`.

## Key Pitfalls (from DEVELOPMENT.md)

1. **Never cache DOM lookups in sidebar.js** — always call `document.getElementById()` in real-time; stale references silently fail after page re-renders.

2. **Gateway config requires full restart** — `SIGUSR1` reload won't pick up `allowedOrigins` changes; must fully restart the Gateway process.

3. **NOT_PAIRED state skips auto-reconnect** — manually polls every 5 sec instead of the normal 3-attempt exponential backoff.

4. **`wsDisconnect()` must null WebSocket callbacks** — clear `onclose`/`onerror` before calling `.close()` to prevent recursive reconnect triggers.

5. **`statusText` uses `data-i18n` attributes** — never assign `textContent` directly or it breaks on language switch; use the i18n helper.

6. **Ed25519 signature payload** — must use `openclaw-control-ui` + `webchat` mode; using `clawtab` or `operator` mode will reject pairing.

7. **`flash_element` overlay is a singleton** — reuse the single overlay element; reset animation via `animation:none` + `offsetWidth` trick to force reflow before restarting.

8. **Clear `STATE.waiting` on disconnect** — the `status_update` handler must force `STATE.waiting = false` or the sidebar gets stuck in a waiting state.

9. **Message replay uses `lastSeenMsgId`** — Service Worker restart clears the in-memory `processedCmds` Set; always track progress via `lastSeenMsgId` to avoid re-executing commands.

10. **Handshake idempotency** — store the `hs_{sessionKey}` flag to `chrome.storage` *before* the API call; delete it on failure to prevent ghost handshake state on SW restart.

## Storage & State

- All persistent state uses `chrome.storage.local` (config, deviceToken, language preference, handshake flags).
- Service Worker is ephemeral — in-memory state (`processedCmds` Set, WebSocket instance, `STATE.*`) is lost on SW termination; code must handle cold-start recovery.

## UI Conventions

- **Two pages**: Config and Chat, toggled by `status_update` messages from the background worker.
- **Bilingual**: EN/ZH toggle stored in `chrome.storage`. All user-visible strings go through the i18n helper via `data-i18n` attributes.
- **Icons**: Extension toolbar icon uses PNG for stable states (idle, connected, done) and canvas-drawn colored "C" badges for transient states (orange=connecting, blue=perceiving, purple=thinking, green=acting, red=failed).
- **Markdown**: Chat messages are rendered via `marked.js` (v15.0.12, bundled in `sidebar/lib/`).

## After Every Change: Push and Share Download Link

After completing any modification, push to GitHub and share the zip download link with the user:

```bash
git push origin main
```

Download link (always points to latest main):
**https://github.com/parksben/clawtab/archive/refs/heads/main.zip**

## Protocol Reference

See `AGENT_PROTOCOL.md` for the full `clawtab_cmd`/`clawtab_result` message format.
See `DEVELOPMENT.md` (Chinese) for extended debugging notes and architecture diagrams.

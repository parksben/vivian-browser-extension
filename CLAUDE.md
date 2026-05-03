# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClawTab is a Chrome Extension (Manifest V3) that connects a browser to an OpenClaw Gateway, enabling AI agents to observe and control browser tabs. The extension is built with **React + TypeScript + Tailwind + Vite + @crxjs/vite-plugin**, with `pnpm` as the package manager. Vite's dev server drives a real HMR loop — `pnpm dev` keeps a live `dist/` updated, the sidepanel hot-reloads on save, and Chrome auto-reloads the extension when background / content scripts change.

## Development Workflow

### Default loop — `pnpm dev`

1. `pnpm install` (once)
2. `pnpm dev` — leaves Vite running and writes a live `dist/`
3. `chrome://extensions/` → **Developer mode** → **Load unpacked** → select `dist/` (only needs to happen once per machine; the dev server keeps `dist/` valid as you edit)
4. Edit code:
   - **`src/sidebar/**`** — sidepanel hot-reloads instantly (React HMR)
   - **`src/background/index.ts`** — rebuilt; Chrome reloads the extension automatically. Reopen the sidepanel if it was open.
   - **`src/content/index.ts`** — rebuilt; Chrome reloads. **Refresh any tab** that already had the old content script injected, otherwise the new code only runs in tabs opened after the reload.
   - **`src/manifest.ts`** — rebuilt; Chrome reloads.

`@crxjs` writes the dev `dist/` so the manifest paths point at the live Vite server (sidepanel HTML imports `http://localhost:5173/...`). Don't ship `dist/` from a `pnpm dev` run — it's not self-contained. Use `pnpm build` for that.

### Other scripts

- `pnpm build` — one-shot production build to a self-contained `dist/`
- `pnpm build:watch` — same as build but watches; use when you specifically want a dev-server-free `dist/` (rare)
- `pnpm pack:crx` — after `pnpm build`, packs `dist/` into `clawtab.crx` (and `clawtab-{version}.crx`). Reads `key.pem` if present, else generates an ephemeral signing key.
- `pnpm typecheck` — `tsc --noEmit` over `src/`
- `pnpm test` / `pnpm test:watch` — Vitest (~36 tests against `message-utils` + `reducer`)

## Architecture

The extension has three isolated runtimes that talk via `chrome.runtime.sendMessage`. Every message body is in the discriminated union at [src/shared/types/messages.ts](src/shared/types/messages.ts) — adding a new message type without handling it in the background switch fails to compile.

| Path | Role |
|------|------|
| [src/background/index.ts](src/background/index.ts) | Service Worker — central hub: WebSocket lifecycle, command polling (`chat.history` every 1–3s), command dispatcher (`perceive` / `act` / `task_*` / `cancel`), diagnostic ring buffer |
| [src/content/index.ts](src/content/index.ts) | Content script — DOM element picker, page ops (`click` / `fill` / `scroll` / `eval` / `get_content`); injected into all pages |
| [src/sidebar/](src/sidebar/) | React + Tailwind sidepanel — `App.tsx` owns the reducer; `components/` has Config / Chat / TaskBar / MessageBubble / InputArea / Tooltip / IconButton |
| [src/shared/types/](src/shared/types/) | `messages.ts` (RPC + broadcasts), `protocol.ts` (clawtab_cmd / result / ChatMessage), `state.ts` (StatusSnapshot, DiagBundle), `picker.ts` (CapturedElement) |

State management in the sidebar: a single `useReducer` in [src/sidebar/App.tsx](src/sidebar/App.tsx) driven by [src/sidebar/state/reducer.ts](src/sidebar/state/reducer.ts). The reducer is pure (no `chrome.*` IO), so all dedup / page-routing / waiting-flag transitions are unit-tested in [src/sidebar/state/reducer.test.ts](src/sidebar/state/reducer.test.ts).

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

The background polls `chat.history` for assistant messages containing a `clawtab_cmd` JSON block. Supported actions: `perceive` (DOM + JPEG screenshot), `act` (20+ browser ops), `task_start`, `task_done`, `task_fail`, `cancel`. Results go back as `clawtab_result` blocks (filtered out of the chat UI). An exclusive lock ensures only one agent can execute `act`/`perceive` at a time; others receive `BUSY`.

## Key Pitfalls (load-bearing — do not regress)

These are paid-for in production. Before touching the relevant code, re-read the matching section of [docs/TECH_DESIGN.md](docs/TECH_DESIGN.md).

1. **Handshake three-layer dedup** — `sendHandshake()` uses (a) in-flight lock `S.handshakeInFlight`, (b) persistent `hs_<sessionKey>` flag in `chrome.storage.local` set BEFORE the network call, (c) post-set re-check covering SW-restart races. **Never remove the flag in the catch block** — a WS drop mid-request can reject our promise even though the Gateway already stored the message; removing the flag causes the agent to receive (and respond to) a duplicate handshake on every reconnect.

2. **connect.ok single-gate** — there is exactly one `sendHandshake()` call site, gated by `!alreadySent && !S.lastSeenMsgId`. The `isNewSession=true` branch must NOT clear `hsKey` (only `lastSeenMsgId` + `lsid_*`). Clearing `hsKey` on flapping gateway state is what produced the duplicate-handshake bug.

3. **Chat dedup via `msgKey()`** — `msgKey(m)` prefers `m.id` and falls back to `c:<role>|<content>`. The handshake echo from `chat.history` lacks a stable id, so id-only dedup leaks. Both `selectVisibleMessages` and `HYDRATE_HISTORY` use `msgKey()`. Tests in [src/sidebar/lib/message-utils.test.ts](src/sidebar/lib/message-utils.test.ts) pin this — they fail the moment id-only dedup creeps back.

4. **`/new` is hidden infrastructure** — `isHiddenInfraMsg(m)` filters `role:'user' && text==='/new'` from both `selectVisibleMessages` and `MessageBubble` (returns `null`). Without this, "Clear context" doesn't actually look cleared.

5. **Link clicks open new tabs via `chrome.tabs.create`** — `target="_blank"` alone is unreliable inside Chrome's sidepanel iframe. `MessageList.tsx` registers a delegated click handler that calls `chrome.tabs.create({ url, active: true })` and `preventDefault`s. `markdown.ts:sanitizeHtml` also rewrites every `<a>` to `target="_blank" rel="noopener noreferrer"` as defense in depth.

6. **Service Worker is ephemeral** — in-memory `S.*` is wiped on SW termination. Anything that must survive sits in `chrome.storage.local`: `gatewayUrl/gatewayToken/browserName`, `deviceToken`, `manualDisconnect`, `hs_<sessionKey>`, `lsid_<sessionKey>`, `diag_logs`. The diagnostic logger calls `loadLogs()` first thing in `init()` to merge with any boot-window entries.

7. **`wsDisconnect` must null WS callbacks** — clear `onclose` / `onerror` / `onmessage` BEFORE calling `.close()`, else `onclose` re-fires `wsScheduleReconnect`.

8. **NOT_PAIRED state skips auto-reconnect** — instead it polls every 5 sec; the keepalive alarm respects this.

9. **Ed25519 signature payload** — must use `openclaw-control-ui` + `webchat` mode; using `clawtab` or `operator` mode rejects pairing.

10. **`flash_element` overlay is a singleton** — reuse the single overlay element; reset animation via `animation:none` + `void offsetWidth` to force reflow.

11. **`clear context` ordering** — sidebar must clear `STATE.messages` / `STATE.lastMsgId` BEFORE the `chat.send('/new')` round-trip, otherwise the polling that picks up `/new` plus the re-dispatched handshake gets de-duped against the pre-existing seen-keys set.

## UI Conventions

- **Two pages**: Config and Chat, derived from the reducer's `state.page` field (driven by `status_update` broadcasts).
- **Bilingual**: EN/ZH toggle persisted in `chrome.storage.local.lang`. All visible strings go through `t(lang, key)` from `i18n.ts`.
- **Icons**: only `lucide-react` is allowed in UI. Toolbar icon uses PNG for stable states (idle, connected, done) and canvas-drawn coloured "C" badges for transient states (orange=connecting, blue=perceiving, purple=thinking, green=acting, red=failed).
- **Tooltips on every icon button**: every icon-only control sits inside `<IconButton tooltip={...}>`. The shared component requires the `tooltip` prop. The language toggle's tooltip is dynamic — it shows the **target** language (`Switch to 中文` / `Switch to English`).
- **Markdown**: chat messages render through `marked` + `sanitizeHtml`. Component styles live in `.md-bubble` / `.md-bubble-user` (Tailwind `@layer components` in `styles.css`).

## Docs-First Authoring

Before any code change (including typos), update [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) and/or [docs/TECH_DESIGN.md](docs/TECH_DESIGN.md). REQUIREMENTS = "what + why" (user-visible behavior, decisions). TECH_DESIGN = "how + why this approach" (architecture, invariants, trade-offs). README is part of the doc set when toolchain / setup / structure / headline features change.

## After Every Change: Push and Share Download Link

After completing any modification, push to GitHub:

```bash
git push origin main
```

The push triggers `.github/workflows/build.yml` which produces a fresh `clawtab.crx` and uploads it as a workflow artifact. Share the link to the latest run from the **[Build extension](../../actions/workflows/build.yml)** Actions tab; the user downloads the `clawtab-crx` artifact (it arrives as a zip wrapper from GitHub's UI — inside is the real `.crx`) and drags it onto `chrome://extensions/`.

If a release-link is wanted (clean URL, no zip wrapping, no 30-day expiry), push a `v*` tag — the same workflow attaches the `.crx` files directly to a GitHub Release.

Source-build path (for users who'd rather build themselves):
**https://github.com/parksben/clawtab/archive/refs/heads/main.zip** → unzip → `pnpm install && pnpm build` → Load unpacked `dist/`.

## Protocol Reference

- [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md) — full `clawtab_cmd` / `clawtab_result` message format
- [DEVELOPMENT.md](DEVELOPMENT.md) — extended Chinese debugging notes (pre-migration; some sections refer to the old vanilla layout, but the diagrams are still accurate at the protocol level)

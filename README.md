# ClawTab

> 中文文档：[README_ZH.md](./README_ZH.md)

**ClawTab** is a Chrome extension that connects your browser to an [OpenClaw](https://github.com/openclaw/openclaw) Gateway, enabling AI agents to observe and control your browser tabs.

## Highlights

- **AI chat in the sidebar** — click the icon to open the sidebar and talk to agents directly; config, chat, and task controls all in one place
- **Full browser automation** — agents can read page content, click, fill forms, and navigate; results are reported back in real time
- **Live task visibility** — while a task runs, a status bar shows the goal, current step, and a live screenshot thumbnail (click to fullscreen)
- **Multi-agent support** — switch between agents in the sidebar; each agent keeps its own session and chat history
- **One-click diagnostics** — every connection / poll / handshake / perceive / act event is logged into a 500-entry ring buffer; export the bundle as a `.txt` file straight from the chat header

## Quick Start

### Option A — Install a prebuilt `.crx` (recommended for users)

Every push to `main` produces a fresh `.crx` via GitHub Actions. The Actions UI wraps artifacts in a zip when you download them, so the unwrap path is:

1. Open the latest run on the **[Build extension](../../actions/workflows/build.yml)** page.
2. Download the `clawtab-crx` artifact at the bottom (it arrives as `clawtab-crx.zip`).
3. Unzip — inside is `clawtab.crx`.
4. `chrome://extensions/` → enable **Developer mode** → drag the `.crx` onto the page.

Tagged releases (`v*`) additionally publish the `.crx` directly on the **Releases** page so the download link doesn't expire and isn't zip-wrapped.

### Option B — Build from source

1. Download: **[clawtab-main.zip](https://github.com/parksben/clawtab/archive/refs/heads/main.zip)**
2. Unzip the archive, then in that folder run:
   ```bash
   pnpm install
   pnpm build
   ```
   This produces a `dist/` directory.
3. Open `chrome://extensions/` and enable **Developer mode**
4. Click **Load unpacked** → select the **`dist/`** directory (not the repo root)

### 2. Configure the Gateway

Run this on the machine where OpenClaw Gateway is installed:

```bash
curl -fsSL https://raw.githubusercontent.com/parksben/clawtab/main/scripts/setup-gateway.sh | bash
```

The script auto-detects your config, adds ClawTab's origin to `allowedOrigins`, and restarts the service. A backup is saved automatically.

> **Manual setup:** Add the following origin to `gateway.controlUi.allowedOrigins`, then run `systemctl restart openclaw-gateway`.
> ClawTab has a fixed extension ID — every user adds the same origin:
>
> ```
> chrome-extension://olfpncdbjlggonplhnlnbhkfianddhmp
> ```

### 3. Connect

1. Click the **ClawTab** icon — the sidebar opens
2. Fill in **Gateway URL**, **Access Token**, and a **Channel Name**
3. Click **Connect** — the sidebar switches to chat mode automatically

The session `agent:main:clawtab-{channel}` appears in the OpenClaw Web UI.

## Project Structure

```
src/
  background/index.ts    # Service Worker (WebSocket, polling, perceive/act dispatcher)
  content/index.ts       # Content script (element picker, page ops)
  sidebar/               # React + Tailwind sidebar
    App.tsx              # state owner, polling loop, runtime message subscription
    main.tsx             # React root
    index.html           # sidepanel entry
    styles.css           # Tailwind layers + .md-bubble component styles
    i18n.ts              # zh/en strings + t() helper
    components/          # ConfigPage / ChatPage / ChatHeader / TaskBar /
                         # MessageList / MessageBubble / InputArea /
                         # IconButton / Tooltip / Toast
    hooks/useLang.ts     # persisted language preference
    state/reducer.ts     # pure useReducer reducer + selectVisibleMessages
    lib/                 # markdown / messages / message-utils
  shared/types/          # cross-context types (messages / protocol / state / picker)
  manifest.ts            # @crxjs MV3 manifest source
icons/*.png              # toolbar icons
docs/REQUIREMENTS.md     # what ClawTab does + user-visible behavior
docs/TECH_DESIGN.md      # how it's built + key invariants
```

## Development

The recommended loop is **`pnpm dev`** — Vite serves the bundle to a live `dist/`, the sidepanel hot-reloads on save, and the background / content scripts are rebuilt and Chrome reloads the extension automatically. **You only need to do `Load unpacked → dist/` once**; everything after that is just save + see.

```bash
pnpm install     # once
pnpm dev         # leave running; chrome://extensions → Load unpacked → dist/
```

What hot-reloads vs. needs intervention:

| Edit | Effect |
|------|--------|
| `src/sidebar/**` (React component, CSS, i18n) | Instant HMR inside the open sidepanel |
| `src/background/index.ts` | Rebuilt + Chrome auto-reloads the extension. Reopen the sidepanel if it was open. |
| `src/content/index.ts` | Rebuilt + Chrome auto-reloads. **Refresh any tab** that already had the old content script. |
| `src/manifest.ts` | Rebuilt + Chrome auto-reloads. |

Other scripts:

| Command | Purpose |
|---------|---------|
| `pnpm build` | One-shot production build into `dist/` (used by CI + the CRX packer) |
| `pnpm build:watch` | Same as `build` but in watch mode — useful when you want a stable, dev-server-free `dist/` (e.g. for sharing) |
| `pnpm pack:crx` | Run after `pnpm build` to produce `clawtab.crx` (and `clawtab-{version}.crx`). Picks up `key.pem` if present, otherwise generates an ephemeral signing key. |
| `pnpm typecheck` | `tsc --noEmit` over `src/` |
| `pnpm test` | Run Vitest suite (36 tests covering message dedup + reducer state machine) |
| `pnpm test:watch` | Vitest in watch mode |

### CI / release flow

`.github/workflows/build.yml` runs on every push to `main`:

1. `pnpm install` → `pnpm typecheck` → `pnpm test` → `pnpm build` → `pnpm pack:crx`
2. Uploads `clawtab.crx` + `clawtab-{version}.crx` as a 30-day workflow artifact.
3. On tag pushes matching `v*`, additionally publishes a GitHub Release with the `.crx` files attached.

If you set the `CLAWTAB_CRX_KEY` repo secret to the contents of a 2048-bit RSA private key (PEM), the action signs CRX builds with the same key across runs. Without the secret, CI generates an ephemeral signing key per run — that still installs cleanly because Chrome derives the extension ID from `manifest.json.key`, not from the signing key.

## Privacy & Security

ClawTab only connects to the Gateway URL you explicitly configure. No data is sent to any third-party services.

## License

MIT


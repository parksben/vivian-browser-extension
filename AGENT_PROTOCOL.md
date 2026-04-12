# ClawTab Agent Protocol

How OpenClaw agents interact with ClawTab to perform browser automation.

---

## Primary Interface — Chat Session (`clawtab_cmd`)

The recommended way for agents to control the browser is through a **chat session**. ClawTab polls the session every 1–3 seconds and processes any `clawtab_cmd` JSON blocks it finds.

### Session key format

```
agent:{agentId}:clawtab-{channelName}
```

Example: `agent:main:clawtab-work`

### Sending a command

Embed a `clawtab_cmd` JSON block in a chat message sent to the session:

```json
{
  "type": "clawtab_cmd",
  "cmdId": "unique-cmd-id",
  "action": "perceive",
  "agentId": "main"
}
```

ClawTab detects the block during its polling loop, executes it, and replies with a `clawtab_result` block (sent with `deliver:false`, so the sidebar UI hides it):

```json
{
  "type": "clawtab_result",
  "cmdId": "unique-cmd-id",
  "ok": true,
  "data": { ... },
  "browserId": "my-channel",
  "ts": 1744000000000
}
```

---

## Actions

### `perceive` — Observe the browser

Captures the active tab's DOM structure and a JPEG screenshot.

```json
{
  "type": "clawtab_cmd",
  "cmdId": "perceive-001",
  "action": "perceive",
  "agentId": "main"
}
```

**Result `data`:**
```json
{
  "tabId": 123,
  "url": "https://example.com",
  "title": "Example",
  "screenshot": "data:image/jpeg;base64,...",
  "dom": {
    "title": "Example",
    "url": "https://example.com",
    "interactive": [ ... ]
  }
}
```

---

### `act` — Execute a browser operation

```json
{
  "type": "clawtab_cmd",
  "cmdId": "act-001",
  "action": "act",
  "agentId": "main",
  "payload": {
    "op": "click",
    "target": "button.submit",
    "captureAfter": true,
    "waitAfter": 500
  }
}
```

**`payload` fields:**

| field | type | description |
|---|---|---|
| `op` | string | Operation type (see table below) |
| `target` | string | CSS selector, element text, or x/dx/tabId depending on op |
| `value` | string | URL, fill value, attribute name, key name, or y/dy depending on op |
| `tabId` | number | Target tab ID (defaults to active tab) |
| `captureAfter` | boolean | Take a screenshot after the operation |
| `waitAfter` | number | Milliseconds to wait after the operation |
| `timeout` | number | Abort operation after this many ms (default: 30 000) |

**Supported `op` values:**

| op | `target` | `value` | description |
|---|---|---|---|
| `navigate` | — | URL | Navigate active tab to URL |
| `click` | CSS selector or visible text | — | Click an element |
| `fill` | CSS selector | text to type | Type into input field |
| `clear` | CSS selector | — | Clear input field |
| `press` | — | key name (e.g. `Enter`) | Dispatch keyboard event on focused element |
| `select` | CSS selector | option value | Choose a `<select>` option |
| `hover` | CSS selector | — | Mouse over element |
| `scroll` | x (px) | y (px) | Scroll to absolute coordinates |
| `scroll_by` | dx (px) | dy (px) | Scroll by relative offset |
| `scroll_to_element` | CSS selector | — | Scroll element into view |
| `wait` | — | ms | Pause |
| `wait_for` | CSS selector | — | Wait up to timeout for element to appear |
| `get_text` | CSS selector | — | Read element's text content |
| `get_attr` | CSS selector | attribute name | Read an element attribute |
| `eval` | — | JavaScript code | Execute arbitrary script; returns result |
| `screenshot_element` | CSS selector | — | Capture element as JPEG |
| `new_tab` | — | URL (optional) | Open a new tab |
| `close_tab` | tabId | — | Close a tab |
| `switch_tab` | tabId | — | Switch to a tab |
| `go_back` | — | — | Browser back |
| `go_forward` | — | — | Browser forward |

**Result `data` (on success):**
```json
{
  "op": "click",
  "clicked": "button.submit",
  "screenshot": "data:image/jpeg;base64,...",   // only if captureAfter:true
  "urlAfter": "https://example.com/next",       // only if captureAfter:true
  "titleAfter": "Next Page"
}
```

---

### `task_start` — Begin a multi-step task

Updates the ClawTab toolbar icon to "thinking" state and records the task goal.

```json
{
  "type": "clawtab_cmd",
  "cmdId": "ts-001",
  "action": "task_start",
  "agentId": "main",
  "payload": {
    "taskId": "task-abc",
    "goal": "Collect product prices",
    "tabId": 123
  }
}
```

---

### `task_done` — Signal completion

```json
{
  "type": "clawtab_cmd",
  "cmdId": "td-001",
  "action": "task_done",
  "payload": { "summary": "Collected 5 prices" }
}
```

---

### `task_fail` — Signal failure

```json
{
  "type": "clawtab_cmd",
  "cmdId": "tf-001",
  "action": "task_fail",
  "payload": { "error": "Element not found: .price" }
}
```

---

### `cancel` — Abort current operation

```json
{
  "type": "clawtab_cmd",
  "cmdId": "cancel-001",
  "action": "cancel"
}
```

---

## Exclusive lock

- Only **one agent** can send `act` or `perceive` commands at a time
- When busy, ClawTab responds immediately:
  ```json
  { "ok": false, "errorCode": "BUSY", "busyStatus": "acting" }
  ```
- Lock releases automatically when the command finishes, fails, or is cancelled
- `task_start` / `task_done` / `task_fail` / `cancel` are never blocked by the lock

---

## Error handling

All results follow the same envelope:

```json
{ "ok": false, "error": "Element not found: .btn", "errorCode": "ACT_FAILED", "op": "click" }
```

Common `errorCode` values:

| code | meaning |
|---|---|
| `BUSY` | Another command is in progress |
| `EXPIRED` | Command `issuedAt` is older than the timeout |
| `ACT_FAILED` | The `act` operation threw an error |
| `UNKNOWN_ACTION` | Unrecognised `action` value |

---

## Typical conversation flow

```
Agent  → chat.send: "Take a screenshot of the current page"
         (also sends clawtab_cmd perceive)
ClawTab← executes perceive
ClawTab→ chat.send: clawtab_result { ok:true, data:{ screenshot, dom } }
Agent  ← reads result, decides next step
Agent  → chat.send: clawtab_cmd act { op:'click', target:'.buy-btn' }
ClawTab← executes click
ClawTab→ chat.send: clawtab_result { ok:true, data:{ clicked, screenshot } }
Agent  → chat.send: clawtab_cmd task_done { summary:'Clicked buy button' }
```

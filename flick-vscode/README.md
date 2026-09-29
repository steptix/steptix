# Flick (VS Code extension)

A chat-style panel inside VS Code for driving the **Steptix Sessions
API** with natural-language steps. It is a fresh, independent reimplementation
of the desktop **Flick** app described in [`SPEC-FLICK.md`](../docs/specs/SPEC-FLICK.md) —
it shared no code with the Tauri `flick/` project, which was removed in favour
of this extension ([issue 049](../issues/resolved/049-remove-flick-tauri.md)).
This is now the only Flick client.

## What it does

- Shows on two surfaces, either or both open at once, kept in sync:
  - **Docked sidebar view** — run **Flick: Open in Side Bar**. Lives in the
    secondary side bar (right) on VS Code >= 1.95, and falls back to the
    activity bar on older versions.
  - **Editor tab** — run **Flick: Open in Editor**. Because it is an editor
    tab, you can drag it into its own editor group or use **Move into New
    Window** to float Flick in a separate window.
- A tab per session inside the UI (each session tab = one server-side browser
  session, keyed by a generated GUID).
- Type steps (plain lines, `1.` numbered, or `- ` dashed — prefixes stripped),
  press **Enter** to submit (**Shift+Enter** for a newline).
- Each batch shows a **user message card** then a **result card** with
  collapsible per-step rows: status badge, reasoning, actions, captured
  outputs, and a screenshot thumbnail (click to open full-size).
- Failed/error steps auto-expand. A batch footer shows `completed / total` and
  the overall status.
- Sessions, chat history, and screenshots persist locally across reloads.
- A connection dot polls the API (`GET /sessions`) and a banner flags
  **stale sessions** (server returned 404) so you know a new browser will start
  on the next step.

## Settings

Configured through VS Code settings (`flick.*`) — the idiomatic equivalent of
the spec's `settings.json`. Editable in-panel via the ⚙ button or in the
Settings UI:

| Setting                 | Default                  | Purpose                                            |
|-------------------------|--------------------------|----------------------------------------------------|
| `flick.apiUrl`          | `http://127.0.0.1:3100`  | Sessions API base URL                              |
| `flick.apiKey`          | (empty)                  | `x-api-key` header value                           |
| `flick.defaultBaseUrl`  | (empty)                  | `config.baseUrl` sent on a session's first request |
| `flick.defaultTimeout`  | (empty)                  | `config.timeout` sent on a session's first request |

## Deliberate adaptations from SPEC-FLICK.md

The spec describes a standalone Tauri desktop window; this is a VS Code
extension, so:

- **Window behaviour** — initial size/position, bottom-right anchoring, upward
  expansion animation, always-on-top, and the dynamic window title are dropped.
  VS Code owns window management; Flick is shown as a docked sidebar view
  and/or an editor-tab webview panel, the latter movable into its own editor
  group or floated into a separate window.
- **Theming** — the spec's light-only palette is replaced with VS Code theme
  variables so the panel matches the editor in any theme. Pass/fail/error keep
  semantic green/red/orange.
- **Local persistence** — files live under the extension's global storage
  directory (`sessions.json`, `history/<guid>.json`, `screenshots/<guid>/`)
  instead of an OS app-data folder.
- **Settings storage** — VS Code configuration instead of a `settings.json`.
- **Delete confirmation** — VS Code's native modal dialog instead of a custom
  one.

Everything else — tabs, session lifecycle, step parsing, result/step cards,
screenshots, connection status, stale-session detection, toasts — follows the
spec.

## Develop

```powershell
cd c:\Projects\vibe\steptix\flick-vscode
npm install
npm run build          # or: npm run watch
npm run dev            # build + launch an Extension Development Host
```

`F5` in this folder (Run Flick Extension) also launches the dev host.

## Package & install

```powershell
npm run package        # produces flick-vscode-<version>.vsix
& "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd" `
    --install-extension flick-vscode-0.3.0.vsix --force
```

Reload the VS Code window afterwards.

## Architecture

```
src/
  shared/         protocol.ts (message types), parse-steps.ts  — shared by both sides
  extension/      extension.ts   activation + wiring (dual-surface registration)
                  controller.ts  all host state, message handlers, polling;
                                 broadcasts to every attached webview
                  panel.ts       FlickPanel (editor tab) + FlickSidebarProvider
                  api-client.ts  Sessions API HTTP client
                  store.ts       sessions / history / screenshot persistence
                  settings.ts    VS Code config <-> FlickSettings
                  html.ts        CSP'd webview HTML scaffold
  webview/        main.ts        the chat UI (vanilla TS, no framework)
                  styles.css     theme-variable styling
```

`esbuild.js` produces two bundles: `dist/extension/extension.js` (Node/CJS) and
`dist/webview/main.js` (browser/IIFE); `styles.css` is copied alongside.

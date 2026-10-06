# SteptixUI → VS Code Extension: Implementation Plan

## Goal

A VS Code extension that lets a user edit and run `steptix` tests
(natural-language Markdown step files) inside their own workspace. The user
runs a `steptix` server manually outside VS Code; the extension is
a thin HTTP/SSE client. Same runtime is shared with the existing Electron
runner via a new `runner-core` package.

## Locked decisions

- Extension ID `pkent.testbench`, viewType `steptix.editor`, settings namespace `steptix.*`
- **Test file** = any `.md` whose body contains a heading matching `/^#{2,}\s+steps\s*$/i`
- **Default editor** for matching `.md` files is the Steptix editor (kill switch via `steptix.openMarkdownAsTest`)
- **Server is user-managed.** Extension never spawns or bundles `steptix`; it speaks HTTP+SSE to whatever server the user started
- **Per-run `.env`**: extension reads the file, ships its parsed contents in the request body; server applies them to the per-session child process only (request env wins, no inheritance of secrets)
- **`.env` resolution**: walk up from the test file to the nearest ancestor containing `.env`, stop at workspace root; on miss, fall back to `steptix.defaultEnvFile` setting; on miss, hard-fail in run log. Every resolution step logged to the "Steptix" output channel
- **Required `.env` keys**: `STEPTIX_SERVER_URL` (full URL incl. scheme/host/port), `STEPTIX_SERVER_API_KEY`. Other keys (e.g. `AI_API_KEY`, `AI_MODEL`) passed through as-is
- **Session ID** = absolute path of the test file. Same file across two VS Code windows reuses one server-side session
- **Concurrency**: multiple `.env`s within one workspace, possibly pointing at different `STEPTIX_SERVER_URL`s, are supported. Each run resolves independently
- **Step-only gutter affordances** (▶, status, breakpoints, run menu) only on numbered lines beneath the steps heading
- **F5 on a non-step line** → nearest step at-or-below, else above, else status-bar no-op
- **Right-click gutter on non-step line** → no menu
- **Commands**: `runSelected` (F5), `runAll`, `stop`, `toggleBreakpoint`, `reopenAsText` (never registered; since removed), `revealEnvFile`, `showRunLog`
- **Repo strategy**: extension lives at `steptix/steptix/` (sibling of `flick/`, `src/`). Shared client code lives in a new top-level package `steptix/runner-core/`. Both `steptix/` and `src/ui/` (Electron) consume `runner-core` via `file:` link
- **VS Code engine** `^1.85.0`
- **Electron runner is preserved** and migrated onto `runner-core`. It gains breakpoint UI as part of this work
- Vite bundles the webview; `tsc` builds the extension host
- **Error UX is a first-class concern.** Every failure mode the user can hit must surface a message that names the problem, names the file/setting/key involved, and names the exact next action to fix it. See "Error catalogue" section below

---

## Error catalogue

Every error reaches the user via two channels: **inline run-log** (red banner in the webview, shown in place of step output) and the **"Steptix" output channel** (full detail incl. paths searched, response bodies). Both carry the same `code`, `message`, `fix`, and `docs` hint. Where applicable the message ends with a **clickable command link** (e.g. `[Open Settings]`, `[Reveal .env]`, `[Show Run Log]`) so the user is one click from the fix.

**Format:** `STXxxx: <one-line summary>. <what to do, concretely>.` — never end on the diagnosis alone.

| Code | Trigger | User-facing message (template) |
|---|---|---|
| `STX001` | Walk-up + fallback both miss | `STX001: No .env file found for this test. Searched: <list of dirs up to workspace root>, then fallback setting "steptix.defaultEnvFile" (=<value or "unset">). Fix: create a .env next to this test (or any ancestor folder up to workspace root) with STEPTIX_SERVER_URL and STEPTIX_SERVER_API_KEY, or set "steptix.defaultEnvFile" in Settings. [Open Settings] [Create .env here]` |
| `STX002` | *Retired.* A `.env` without `STEPTIX_SERVER_URL` falls back to the environment, the machine `.env`, then `http://127.0.0.1:3100` ([stories/machine-server-url.md](../stories/machine-server-url.md)). The number stays unused. | — |
| `STX003` | `.env` found but `STEPTIX_SERVER_API_KEY` missing | `STX003: STEPTIX_SERVER_API_KEY is missing from <abs path to .env>. Fix: add STEPTIX_SERVER_API_KEY=<your-key>. The key must match what the Steptix server was started with. [Reveal .env]` |
| `STX004` | `STEPTIX_SERVER_URL` present but unparseable | `STX004: STEPTIX_SERVER_URL in <abs path> is not a valid URL: "<value>". Fix: use a full URL like http://localhost:3100 — include scheme, host, and port. [Reveal .env]` |
| `STX005` | `.env` parse error (malformed line) | `STX005: Could not parse <abs path> at line <n>: "<line>". Fix: each entry must be KEY=VALUE on its own line. Comments start with #. [Reveal .env]` |
| `STX010` | Server unreachable (ECONNREFUSED, DNS, timeout) | `STX010: Cannot reach the Steptix server at <STEPTIX_SERVER_URL> (<error kind>). Fix: start the server (`+`npm run server`+` in the Steptix repo) and confirm it's listening on <host:port>. If running on another machine, check firewall and that STEPTIX_SERVER_URL uses the right host. [Show Run Log]` |
| `STX011` | 401 from server | `STX011: Server rejected the API key (401). Fix: STEPTIX_SERVER_API_KEY in <abs path to .env> must match the STEPTIX_SERVER_API_KEY the server was started with. [Reveal .env]` |
| `STX012` | 404 / endpoint missing (server too old) | `STX012: Server at <STEPTIX_SERVER_URL> does not support streaming (?stream=1 returned 404). Fix: update the Steptix server — this extension requires server build with SSE streaming.` |
| `STX013` | 5xx from server | `STX013: Server returned <status> while starting the run. Detail in run log. Fix: check the server's terminal for a stack trace; this is a server-side bug or misconfiguration. [Show Run Log]` |
| `STX014` | SSE stream dropped mid-run | `STX014: Connection to the server was lost mid-run (<reason>). The session may still be running on the server. Fix: check the server is still up and re-run; use "Steptix: Stop" to abort the orphaned session. [Show Run Log]` |
| `STX020` | File opened in Steptix but no `## Steps` heading | `STX020: This file has no "## Steps" heading, so there's nothing to run. Fix: add a "## Steps" heading followed by a numbered list, or open as plain Markdown.` (The planned `[Reopen as Text]` action was removed: its command was never registered.) |
| `STX021` | F5 with no resolvable target step | `STX021: No step at or below the cursor to run. Fix: place the cursor on a numbered step under "## Steps", or use "Steptix: Run All".` |
| `STX030` | Workspace not open (single-file mode) | `STX030: Steptix needs an open folder so it can resolve .env. Fix: File → Open Folder and pick the folder containing your tests.` |
| `STX031` | Two windows hold the same session and one issues stop | `STX031: This session is also active in another VS Code window. Stopping here will stop it everywhere. [Stop Anyway] [Cancel]` |

**Implementation rules:**

- All errors flow through one helper `reportError(code, ctx)` in `runner-core/src/errors.ts` that produces the `{ code, message, fix, actions }` payload from a single source-of-truth table — never hand-format error strings at call sites
- Every error message **must** include the absolute path of any file involved, and the literal name of any setting key involved, so the user can search/grep
- Every error has at least one **action button** in the inline banner; clicking the button runs a registered VS Code command (settings open, reveal file, show output, etc.)
- The output channel always logs the full diagnostic *before* the user-visible banner appears, so by the time they click "Show Run Log" the detail is already there
- Error tests are mandatory — `runner-core/tests/errors.test.js` asserts every code in the catalogue produces a message that mentions (a) the failing input/path and (b) a verb-led fix sentence

---

## Settings (final)

| Key | Type | Default | Purpose |
|---|---|---|---|
| `steptix.defaultEnvFile` | string | `""` | Absolute or workspace-relative path used when walk-up finds no `.env` |
| `steptix.editor.wordWrap` | boolean | `true` | Webview editor wrap |
| `steptix.openMarkdownAsTest` | boolean | `true` | Master switch for default-on Steptix editor binding |

Removed from prior draft: `steptix.testsDir`, `steptix.server.port`, `steptix.steptix.path`.

---

## Same-repo work items in `steptix` core (blocking server-side)

These ship in `src/server/` and must land before Phase 6.

1. **SSE streaming** on `POST /sessions/:id/steps?stream=1`. Events:
   - `step:start { line }`
   - `step:pass { line, output? }`
   - `step:fail { line, error }`
   - `paused { line }`
   - `output { msg, kind }`
   - `done { status }`
2. **Breakpoints**: honour `breakpoints: number[]` in request body. Server pauses between specified step indices. Resume via follow-up `POST /sessions/:id/resume`
3. **Per-request env injection**: honour `env: Record<string,string>` in request body. Apply to the spawned per-session child process only — never mutate the server's `process.env`. Request env wins; do not inherit secrets from server process
4. **Session ID is opaque**: server already accepts arbitrary string IDs; confirm absolute paths (with drive letters, slashes, spaces) round-trip safely as URL path segments via `encodeURIComponent`

Tests live with the server changes in `steptix/src/server/__tests__/`.

---

## Repo layout (target)

```
steptix/
  src/                       (existing core + API server)
  src/ui/                    (Electron — preserved, migrates onto runner-core)
  flick/                     (existing Svelte/Tauri sibling)
  runner-core/               ← NEW shared client package
    package.json             name: "steptix-runner-core"
    src/api-client.ts        HTTP + SSE client
    src/sse-parser.ts        chunked SSE frame parser
    src/protocol.ts          typed message union (host ↔ webview)
    src/step-lines.ts        step classifier + nearest helpers
    src/render-step-result.ts  pure helper for log entries + screenshot
    src/run-state.ts         per-session state machine
    src/env-file.ts          .env parser + walk-up resolver
    tests/
  steptix/                 ← VS Code extension
    src/extension/           (host)
    src/webview/             (React + Monaco)
    src/shared/              (extension-only types)
    tests/
    package.json             depends on "steptix-runner-core": "file:../runner-core"
    PLAN.md, SPEC.md
  package.json               (root, untouched apart from server work)
```

---

## Phase 0 — Pre-flight inventory (no edits)

Confirm against current code:

- API server endpoints used: `POST /sessions/:id/steps`, `GET /sessions/:id`, `GET /sessions`, `DELETE /sessions/:id`, plus the new `?stream=1` and `/resume`
- Auth: `x-api-key` header → value comes from `.env`'s `STEPTIX_SERVER_API_KEY`
- SteptixUI today uses ESM Vite + Monaco workers (`?worker` import); webview must replicate worker plumbing under VS Code's CSP

No code changes in this phase.

---

## Phase 1 — Extract `runner-core` package

**Goal:** stand up the shared client package with no consumers yet.

**Files added:**

- `runner-core/package.json` — `"type": "module"`, no runtime deps beyond `undici` (or built-in `fetch`)
- `runner-core/tsconfig.json` — emits `dist/` as ESM + d.ts
- `runner-core/src/api-client.ts` — `streamSteps(serverUrl, apiKey, sessionId, { steps, breakpoints?, env, parameters? }, signal) → AsyncIterable<Event>`. Plus `closeSession`, `listSessions`, `resume`
- `runner-core/src/sse-parser.ts` — chunk → frame → typed event
- `runner-core/src/protocol.ts` — host↔webview message union (used by both extension and Electron)
- `runner-core/src/step-lines.ts` — `classifyLines`, `isStepLine`, `nearestStepAtOrBelow`, `nearestStepAtOrAbove`, plus `isTestFile(text): boolean` (matches `/^#{2,}\s+steps\s*$/im`)
- `runner-core/src/render-step-result.ts`
- `runner-core/src/run-state.ts`
- `runner-core/src/env-file.ts` — pure `.env` parser + `resolveEnvFile({ testFile, workspaceRoot, fallbackPath }): { path, source, searchedDirs } | { miss: true, searchedDirs, fallbackPath }`. Source is `"walkup" | "fallback"`. Always returns the search path so the caller can render `STX001`
- `runner-core/src/errors.ts` — single source of truth for the error catalogue: `reportError(code, ctx) → { code, message, fix, actions[] }`. All call sites use this helper; no hand-formatted error strings

**Tests added (under `runner-core/tests/`):**

- `step-lines.test.js` ~12 — heading detection (`##`, `### `, mixed case, trailing whitespace), frontmatter handling, indented `1.` not a step, `1)` not supported (documented)
- `sse-parser.test.js` ~6 — multi-event chunks, partial frames, comments
- `api-client.test.js` ~5 — `x-api-key` header, body shape (incl. `env`), AbortController cancels stream
- `env-file.test.js` ~6 — walk-up across nested folders, stop at workspace root, fallback path, missing → returns `searchedDirs`, parser handles quotes/comments
- `errors.test.js` ~14 — every code in the catalogue produces a message that mentions (a) the failing input/path/setting and (b) a verb-led fix sentence; round-trips `code` field
- `protocol.test.js` ~10 — JSON round-trip + narrowing helpers
- `render-step-result.test.js` ~5

**Acceptance:** `cd runner-core && npm test && npm run build` clean.

---

## Phase 2 — Server work in `steptix`

**Goal:** SSE + breakpoints + per-request env land in the API server.

**Files changed under `src/server/`:**

- `api-server.ts` — `?stream=1` opens text/event-stream response; flushes events as the runner produces them
- `session-runner.ts` (or equivalent) — accepts `{ breakpoints, env }`, spawns per-session child with `env` only (no merge with `process.env`); honours pause/resume
- New `POST /sessions/:id/resume`

**Tests added under `src/server/__tests__/`:**

- `sse-stream.test.ts` — happy path emits ordered `step:start … done`
- `breakpoints.test.ts` — pause at configured indices, resume continues
- `request-env.test.ts` — child sees only request env; server `process.env` untouched
- `auth.test.ts` — bad/missing `x-api-key` → 401

**Acceptance:** existing vitest suite green; new tests pass.

**Risk:** `process.env` leak — explicit assertion in `request-env.test.ts` guards this.

---

## Phase 3 — Migrate Electron runner onto `runner-core`

**Goal:** Electron app keeps working but pulls API client / protocol / step-lines from `runner-core`. Adds breakpoint UI.

**Files changed under `src/ui/`:**

- Replace inline API client + SSE handling with `runner-core/api-client`
- Replace any local step classification with `runner-core/step-lines`
- Add breakpoint gutter + pause/resume controls (matching extension UX)

**Tests added:** existing Electron tests updated to import from `runner-core`. New `breakpoint-ui.test.ts` ~3 cases.

**Acceptance:** `npm run ui` (Electron) launches, runs a known-good test end-to-end, breakpoint pauses + resumes.

**Why now:** validates `runner-core`'s API surface before the extension consumes it. If Electron can't be expressed in terms of `runner-core`, the package is wrong.

---

## Phase 4 — Extension project structure

**Goal:** `steptix/` builds two artifacts: webview bundle + extension host bundle.

**Files added:**

- `steptix/tsconfig.extension.json` — target ES2022, module Node16, outDir `dist/extension`, includes `src/extension/**`, `src/shared/**`
- `steptix/vite.config.webview.js` — `root: 'src/webview'`, `build.outDir: '../../dist/webview'`, `base: './'`
- `steptix/.vscode/launch.json` — "Run Extension" → `--extensionDevelopmentPath`
- `steptix/.vscodeignore` — exclude `tests/`, `src/`, only ship `dist/` + `package.json` + icon

**Files moved (from current `steptix/` root into `src/webview/`):**

- `steptix-runner.jsx` → `src/webview/steptix-runner.jsx`
- `index.html` → `src/webview/index.html`
- `selection-lines.js`, `line-tracking.js`, `gutter-menu.js`, `gutter-rightclick.js` → `src/webview/lib/`
- `app-settings.json` → removed (replaced by VS Code config)
- `tests/*.test.js` paths updated

**Files removed:**

- `serve-steptix.mjs`, `serve-steptix.ps1`, `server.err.log`, `server.out.log`

**`steptix/package.json` changes:**

- `"main": "dist/extension/extension.js"`
- `"engines": { "vscode": "^1.85.0" }`
- `"activationEvents": ["onCustomEditor:steptix.editor", "onLanguage:markdown"]` — second is needed so the extension activates and can decide whether to claim a `.md` file
- `"contributes"`: customEditors, commands, keybindings, configuration (Phases 8, 9)
- New deps: `"steptix-runner-core": "file:../runner-core"`
- New devDeps: `@types/vscode@^1.85`, `@types/node@^20`, `typescript@^5`, `concurrently`, `@vscode/vsce`
- Scripts: `build:webview`, `build:extension`, `build`, `watch:webview`, `watch:extension`, `watch`, `package`

**Acceptance:** `npm run build` produces `dist/webview/index.html` + assets and `dist/extension/extension.js`. Existing webview tests still pass against new paths.

**Risks:** Vite asset paths under webview URIs; mitigated by `base: './'` + host-side HTML rewrite (Phase 5).

---

## Phase 5 — Extension host scaffold

**Goal:** Activation, custom editor provider, webview wiring, message router.

**Files added under `steptix/src/extension/`:**

- `extension.ts` — `activate(context)`: registers `SteptixEditorProvider`, commands, output channel
- `editor-provider.ts` — `vscode.CustomTextEditorProvider`. `resolveCustomTextEditor` builds HTML, posts `init` with `document.getText()`, listens for messages, applies edits via `WorkspaceEdit`. Subscribes to `workspace.onDidChangeTextDocument` for external edits
- `editor-binding.ts` — gates which `.md` files claim the Steptix editor:
  - If `steptix.openMarkdownAsTest` is `false` → never claim by default
  - Else, on first read, run `isTestFile(text)`; only register the custom editor as `priority: "default"` for that doc if it matches. Implementation detail: VS Code can't *conditionally* register per-document, so the customEditor is registered with `selector: "*.md"` + `priority: "default"`, and `resolveCustomTextEditor` checks `isTestFile`. If non-test, immediately call `vscode.commands.executeCommand('vscode.openWith', uri, 'default')` and dispose
- `webview-html.ts` — reads `dist/webview/index.html`, rewrites assets via `panel.webview.asWebviewUri`, injects CSP:

  ```
  default-src 'none';
  script-src ${webview.cspSource} 'unsafe-inline';
  style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com;
  font-src https://fonts.gstatic.com;
  img-src ${webview.cspSource} data: https:;
  worker-src ${webview.cspSource} blob:;
  ```

- `output-channel.ts` — singleton `vscode.OutputChannel("Steptix")`
- `breakpoint-store.ts` — persists breakpoints in `context.workspaceState` keyed by absolute path

**Tests added under `steptix/tests/`:**

- `editor-binding.test.js` ~4 — test-file vs non-test markdown, kill-switch off
- `webview-html.test.js` ~3 — CSP injected, asset URIs rewritten

**Acceptance:** `code --extensionDevelopmentPath=.` opens; opening a `.md` with `## Steps` shows Steptix editor; opening a plain `.md` opens the normal editor.

---

## Phase 6 — Run flow

**Goal:** wire the run path: webview → host → server (over SSE) → events back.

**Files added under `steptix/src/extension/`:**

- `run-controller.ts` — owns one run-per-editor. On `run` message:
  1. Resolve `.env` via `runner-core/env-file.resolveEnvFile`. Log the search to "Steptix" channel. On miss → `reportError('STX001', { searchedDirs, fallbackSetting })` and abort
  2. Read+parse `.env`. Parse error → `STX005`. Missing `STEPTIX_SERVER_URL` → the fallback chain (no error; STX002 is retired). Unparseable URL → `STX004`. Missing `STEPTIX_SERVER_API_KEY` → `STX003`. All include the absolute `.env` path
  3. Build session ID = `document.uri.fsPath`
  4. Call `runner-core/api-client.streamSteps(...)`. Map transport failures to error codes: `ECONNREFUSED`/DNS/timeout → `STX010`, 401 → `STX011`, 404 → `STX012`, 5xx → `STX013`, mid-stream drop → `STX014`. All include `STEPTIX_SERVER_URL`
  5. Forward each SSE event to the webview; mirror to "Steptix" output channel
  6. On `stop` message → abort via `AbortController`

  Every error path goes through `reportError` (see Error catalogue) — never throw a raw `Error` to the webview.
- `webview-messenger.ts` — typed wrapper over `panel.webview.postMessage` using `runner-core/protocol`

**Files changed under `steptix/src/webview/`:**

- `steptix-runner.jsx`:
  - Replace `appSettings` import with `acquireVsCodeApi()`; subscribe to `message` events
  - Compute `stepLineSet` via `runner-core/step-lines`
  - Decoration block: emit step-only icons only for lines in `stepLineSet`. Whole-line selection unchanged
  - `onContextMenu`: bail if `lineNumber` not in `stepLineSet`
  - F5 handler `runSelected`: filter selection through `stepLineSet`; cursor on non-step → `nearestStepAtOrBelow` then `nearestStepAtOrAbove`; post `{ type: 'run', lines }`
  - Remove `MOCK_ERRORS`, `INITIAL_SCRIPT`, local `executeSteps`. Replace with message-driven state: `step:start`, `step:pass`, `step:fail`, `paused`, `output`, `done`, `error`
  - Breakpoint toggle → `{ type: 'breakpoint:toggle', line, on }`
  - On `init`: `{ scriptText, breakpoints, wordWrap }`
  - On user edit: `{ type: 'edit', text }`
- `lib/run-dispatch.js` — pure helper `(selectedLines, cursorLine, stepLineSet) → number[]`
- `lib/vscode-shim.js` — fallback for browser-standalone dev

**Tests added:**

- `tests/run-controller.test.js` ~6 — mocks `runner-core/api-client`; asserts env resolution, missing-env error, SSE event forwarding, abort
- `tests/run-dispatch.test.js` ~6 — F5 fallback rules, multi-select filtering

**Acceptance:** with a manually-started server and a `.env` next to a `.md` test, F5 runs the file, events stream back in real time, breakpoints pause + resume.

---

## Phase 7 — Tests-tree view (optional MVP)

**Goal:** sidebar listing every `.md` test in the workspace (anything matching `isTestFile`). Click → opens in Steptix editor. Run icon per node.

**Files added:**

- `src/extension/tests-tree.ts` — `vscode.TreeDataProvider`. Walks workspace via `vscode.workspace.findFiles('**/*.md')`, filters by `isTestFile` (reads file head; cache invalidated on `onDidChange`)

**Tests added:** `tests/tests-tree.test.js` ~3.

**Acceptance:** Sidebar shows nested test files; clicking opens editor; "Run" icon triggers `runAll` for that file.

---

## Phase 8 — Settings & commands

**Goal:** VS Code-native config surface (final list above).

**`steptix/package.json` additions:**

- `contributes.configuration` — three keys from the settings table
- `contributes.commands` — seven commands. Implementations under `src/extension/commands/`:
  - `run-selected.ts` (F5)
  - `run-all.ts`
  - `stop.ts`
  - `toggle-breakpoint.ts`
  - `reopen-as-text.ts` — `vscode.commands.executeCommand('vscode.openWith', uri, 'default')`
  - `reveal-env-file.ts` — runs the same resolver and reveals the resolved `.env` (or shows the search path on miss)
  - `show-run-log.ts` — focuses the "Steptix" output channel

**Tests added:** `tests/commands-registry.test.js` ~4 — vscode mock, asserts seven commands register and dispose.

**Acceptance:** Command Palette shows all seven; Settings UI shows the three keys; `wordWrap` toggle re-renders editor live.

---

## Phase 9 — F5 keybinding

**`steptix/package.json` keybindings:**

```jsonc
{
  "command": "steptix.runSelected",
  "key": "f5",
  "when": "resourceExtname == .md && activeCustomEditorId == steptix.editor"
}
```

Plus `-workbench.action.debug.start` with the same `when` to suppress default debug F5.

**Acceptance:** F5 in Steptix editor runs target; F5 elsewhere still triggers debug picker.

**Risk:** if `activeCustomEditorId` isn't set when the webview has focus, fall back to `activeWebviewPanelId`.

---

## Phase 10 — Build & dev loop

**`steptix/package.json` scripts:**

- `npm run watch` → `concurrently npm:watch:*` (Vite + `tsc --watch`)
- `npm run dev` → first build then `code --extensionDevelopmentPath=.`
- `.vscode/launch.json` "Run Extension" + "Attach to Extension Host"

**Acceptance:** Edit JSX → webview rebuilds → reload-window in dev host shows changes within 2s.

---

## Phase 11 — Marketplace prep

**Files added:** `icon.png` (128×128), rewritten `README.md` (covering: start the server first, put `.env` next to your tests, F5 to run), `CHANGELOG.md`, `LICENSE`, finalized `.vscodeignore`.

**Acceptance:** `npm run package` produces `pkent-steptix-0.1.0.vsix` (small — no `steptix` bundled). `code --install-extension <vsix>` works on a clean profile and a clean user folder containing only a `.md` test + `.env`, against a manually-started server on another machine.

---

## Cross-phase test summary

| Suite | Cases | Location |
|---|---|---|
| step-lines | ~12 | runner-core |
| sse-parser | ~6 | runner-core |
| api-client | ~5 | runner-core |
| env-file | ~6 | runner-core |
| errors | ~14 | runner-core |
| protocol | ~10 | runner-core |
| render-step-result | ~5 | runner-core |
| sse-stream | ~3 | steptix/src/server |
| breakpoints (server) | ~3 | steptix/src/server |
| request-env | ~2 | steptix/src/server |
| auth | ~2 | steptix/src/server |
| breakpoint-ui (electron) | ~3 | src/ui |
| editor-binding | ~4 | steptix |
| webview-html | ~3 | steptix |
| run-controller | ~6 | steptix |
| run-dispatch | ~6 | steptix |
| tests-tree | ~3 | steptix |
| commands-registry | ~4 | steptix |

Plus the existing 51 webview tests preserved (paths updated in Phase 4).

---

## Critical files for implementation

- `runner-core/src/api-client.ts`
- `runner-core/src/env-file.ts`
- `runner-core/src/errors.ts`
- `runner-core/src/step-lines.ts`
- `runner-core/src/protocol.ts`
- `steptix/src/server/api-server.ts` (SSE, breakpoints, env)
- `steptix/src/extension/extension.ts`
- `steptix/src/extension/editor-provider.ts`
- `steptix/src/extension/editor-binding.ts`
- `steptix/src/extension/run-controller.ts`
- `steptix/src/webview/steptix-runner.jsx`
- `steptix/package.json` (contributes block)

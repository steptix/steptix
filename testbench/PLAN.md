# TestBenchUI → VS Code Extension: Implementation Plan

## Locked decisions

- Extension ID `pkent.testbench`, viewType `testbench.editor`, settings namespace `testbench.*`
- File pattern: `.md` files in workspace tests dir
- Tests dir: parse `ai-ui-auto.config.ts` → `tests.dir`; `testbench.testsDir` setting overrides
- **Repo strategy: live as `testbench/` subfolder inside `ai-ui-automation`** (sibling to `flick/`). Own `package.json`, own build, depends on parent via `"ai-ui-automation": "file:.."`
- Vite bundles webview, `tsc` builds extension host
- API server: extension spawns `ai-ui-automation`'s server on activation, kills on deactivate
- Replaces ai-ui-automation's Electron desktop runner
- Min VS Code engine `^1.85.0`
- Step-only gutter affordances (▶, status, breakpoints, run menu) — only on numbered lines under `## Steps`
- Whole-line selection still works everywhere; Alt+Click multi-select filters non-steps at run time
- F5 on non-step line → nearest step at-or-below, else above, else status-bar no-op
- Right-click gutter on non-step line → no menu
- Commands: `runSelected` (F5), `runAll`, `stop`, `toggleBreakpoint`, `reopenAsText`, `installAiUiAutomation`
- Output channel "TestBench" mirrors webview log; one run per editor
- **Streaming**: add SSE on `POST /sessions/:id/steps?stream=1` (same-repo work item, no longer cross-repo)
- **Package exports**: add `"./server"` export to `ai-ui-automation`'s `package.json` so extension imports `{ startServer } from 'ai-ui-automation/server'` (same-repo work item)

---

## Phase 0 — Pre-flight inventory (no edits)

**Findings from exploration of ai-ui-automation:**

- API server: Express, `c:/Projects/vibe/ai-ui-automation/src/server/api-server.ts`
- Endpoints we'll call:
  - `POST /sessions/:id/steps` — body `{ config?, steps: string[], parameters? }`. Auth: `x-api-key` header
  - `GET /sessions/:id` — current state + screenshot
  - `GET /sessions` — list
  - `DELETE /sessions/:id` — close
- Server entry: `startServer(config)` and `createApiServer(config)` exported from `src/server/api-server.ts`
- Config: `tests.dir` lives under `tests` key, default `./fixtures/tests`. `server.port = 3100`. `server.apiKey` reads `SERVER_API_KEY` env, **throws if absent**
- TestBenchUI today uses ESM Vite + Monaco workers (`?worker` import); webview must replicate worker plumbing under VS Code's CSP

**Same-repo work items in ai-ui-automation (sequenced before Phase 5):**

1. Add `"./server": "./dist/server/api-server.js"` to root `package.json` `exports` map
2. Add SSE streaming to `POST /sessions/:id/steps?stream=1`. Events:
   - `step:start { line }`
   - `step:pass { line, output? }`
   - `step:fail { line, error }`
   - `paused { line }` (breakpoint)
   - `output { msg, kind }`
   - `done { status }`
3. Honour `breakpoints: number[]` in the request body — server pauses between specified step indices; resume via a follow-up `POST /sessions/:id/resume`

Blocking for Phase 5/6 but can be developed in the same commits.

**Repo layout after subtree merge:**

```
ai-ui-automation/
  src/                       (existing core + API server)
  flick/                     (existing Svelte/Tauri sibling)
  testbench/                 ← TestBenchUI moved here
    src/                     (will be created in Phase 1: webview/, extension/, shared/)
    tests/
    package.json             (own; depends on parent via "file:..")
    PLAN.md, SPEC.md
  package.json               (root, untouched)
```

---

## Phase 1 — Project structure pivot

**Goal:** Repo builds two artifacts: webview bundle + extension host bundle.

**Files added:**

- `tsconfig.extension.json` — TS config for host (target ES2022, module Node16, outDir `dist/extension`, includes `src/extension/**`)
- `vite.config.webview.js` — replaces root `vite.config.js`. `root: 'src/webview'`, `build.outDir: '../../dist/webview'`, `build.rollupOptions.input: 'src/webview/index.html'`, `base: './'`
- `.vscode/launch.json` — "Run Extension" pointing at `--extensionDevelopmentPath`
- `.vscodeignore` — exclude `tests/`, source, only ship `dist/` + `package.json` + icon

**Files moved:**

- `testbench-runner.jsx` → `src/webview/testbench-runner.jsx`
- `index.html` → `src/webview/index.html`
- `selection-lines.js`, `line-tracking.js`, `gutter-menu.js`, `gutter-rightclick.js` → `src/webview/lib/`
- `app-settings.json` → removed (replaced by VS Code config; see Phase 9)
- `tests/*.test.js` paths updated to `../src/webview/lib/...`

**Files removed:**

- `serve-testbench.mjs`, `serve-testbench.ps1`, `server.err.log`, `server.out.log`

**`package.json` changes:**

- `"main": "dist/extension/extension.js"`
- `"engines": { "vscode": "^1.85.0" }`
- `"activationEvents": ["onCustomEditor:testbench.editor"]`
- `"contributes"`: customEditors, commands, keybindings, configuration (Phases 4, 9, 10)
- New scripts: `build:webview`, `build:extension`, `build`, `watch:webview`, `watch:extension`, `watch`, `package`
- New devDeps: `@types/vscode@^1.85`, `@types/node@^20`, `typescript@^5`, `concurrently`, `@vscode/vsce`

**Tests added:** none.

**Acceptance:** `npm run build` produces `dist/webview/index.html` + assets and `dist/extension/extension.js`. Existing `npm test` still passes (51 tests across 14 suites — only import paths updated).

**Risks:** Vite asset paths under webview URIs; mitigated by `base: './'` + host-side HTML rewrite (Phase 4).

---

## Phase 2 — Step-line classifier

**Goal:** Pure module deciding which lines are step lines.

**Files added:**

- `src/webview/lib/step-lines.js` — exports:
  - `classifyLines(text) → Array<{ line, kind: 'step'|'frontmatter'|'heading'|'prose'|'blank' }>`
  - `isStepLine(text, lineNumber)`
  - `nearestStepAtOrBelow(text, line)`, `nearestStepAtOrAbove(text, line)`

**Algorithm:** parse YAML frontmatter (`---` first non-blank line ends at next `---`); locate `## Steps` heading (case-insensitive, trailing whitespace OK); inside Steps section a step line matches `/^\s*\d+\.\s+/`. Block ends at next `^#{1,6}\s` heading or EOF. Blank lines do not end the block.

**Tests added:** `tests/step-lines.test.js` (~12 cases): pure prose → no steps; frontmatter + 5 numbered items → 5 lines; indented `  1. sub` → not a step; `If prompted ...` continuation → not a step; multi `##` sections → Steps ends at next heading; nearest helpers fall back correctly.

**Acceptance:** `node --test tests/step-lines.test.js` passes.

**Risks:** `1)` style not supported in MVP — document the constraint.

---

## Phase 3 — Webview adaptation

**Goal:** Gate gutter affordances on step classification; replace local `executeSteps` with postMessage; preserve all existing UX rules.

**Files changed:**

- `src/webview/testbench-runner.jsx`:
  - Replace `appSettings` import with `acquireVsCodeApi()`; subscribe to `message` events
  - Compute `stepLineSet = new Set(classifyLines(scriptText).filter(l => l.kind === 'step').map(l => l.line))` memoized
  - Decoration block: emit step-only icons (status, breakpoint, ▶ pointer) only for lines in `stepLineSet`. Whole-line selection decoration unchanged
  - `onContextMenu`: if `lineNumber` not in `stepLineSet`, return early
  - F5 handler `runSelected`: filter selected lines through `stepLineSet`; if cursor on non-step with no selection → `nearestStepAtOrBelow` fallback to `nearestStepAtOrAbove`; post `{ type: 'run', lines: [...] }`
  - Remove `MOCK_ERRORS`, `INITIAL_SCRIPT`, local `executeSteps`. Replace with message-driven state updates: `step:start`, `step:pass`, `step:fail`, `paused`, `output`, `done`, `error`
  - Breakpoint toggle posts `{ type: 'breakpoint:toggle', line, on }`
  - On `init`, host sends `{ scriptText, theme, wordWrap, breakpoints }`
  - On user edits, post `{ type: 'edit', text }` so host can write through via `WorkspaceEdit`

**Files added:**

- `src/webview/lib/run-dispatch.js` — pure helper `(selectedLines, cursorLine, stepLineSet) → number[]`. Encapsulates the F5-target logic for unit testing.
- `src/webview/lib/vscode-shim.js` — fallback for browser-standalone dev when `acquireVsCodeApi` is undefined.

**Tests added:**

- `tests/run-dispatch.test.js` (~6 cases): F5 on non-step → next step below; after-last → above; multi-select filters non-steps; no selection + no steps → `[]`
- Extend `tests/gutter-menu.test.js` with case asserting menu builder receives `isStepLine: false` and returns empty list

**Acceptance:** Open `dist/webview/index.html` standalone in browser still renders editor (via shim). `npm test` shows new tests passing.

**Risks:** `acquireVsCodeApi` callable once; the shim path must be branch-safe.

---

## Phase 4 — Extension host scaffold

**Goal:** Activation, custom editor provider, webview wiring, message router.

**Files added:**

- `src/extension/extension.ts` — `activate(context)`: registers `TestBenchEditorProvider`, six commands (Phase 9), output channel, disposes server lifecycle on `deactivate`
- `src/extension/editor-provider.ts` — implements `vscode.CustomTextEditorProvider`. `resolveCustomTextEditor` builds HTML, posts `init` with `document.getText()`, listens for messages, applies edits via `WorkspaceEdit`. Subscribes to `workspace.onDidChangeTextDocument` to forward external edits to the webview
- `src/extension/webview-html.ts` — reads `dist/webview/index.html`, rewrites assets via `panel.webview.asWebviewUri`, injects CSP:

  ```
  default-src 'none';
  script-src ${webview.cspSource} 'unsafe-inline';
  style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com;
  font-src https://fonts.gstatic.com;
  img-src ${webview.cspSource} data: https:;
  worker-src ${webview.cspSource} blob:;
  ```

- `src/extension/run-controller.ts` — owns one run-per-editor. On `run`, opens an SSE connection to `POST /sessions/:id/steps?stream=1` with `{ steps, breakpoints, parameters }`, forwards events to webview. On `stop`, aborts via `AbortController`. Session ID derived from `document.uri.toString()` hash
- `src/extension/output-channel.ts` — singleton `vscode.OutputChannel`
- `src/extension/breakpoint-store.ts` — persists breakpoints in `context.workspaceState` keyed by URI string. Uses webview's `line-tracking.js` for live remap; persisted state is the snapshot at last save

**Tests added:**

- `tests/host-message-router.test.js` (~5 cases) — fake panel + fake apiClient, asserts `run` opens stream, forwards events
- `tests/webview-html.test.js` (~3) — fixture HTML, asserts CSP injected and asset URIs rewritten

Tests run under `node --test` against compiled JS with a local `vscode` shim.

**Acceptance:** `code --extensionDevelopmentPath=.` opens; opening a workspace `.md` test file shows TestBench editor.

**Risks:** Custom editor `selector.filenamePattern` doesn't natively support "only inside testsDir." Use `**/*.md` with `priority: "option"` so users explicitly opt in; pair with a "TestBench: Open as Test" command for unambiguous opening.

---

## Phase 5 — API server lifecycle

**Goal:** Spawn ai-ui-automation server on activation, kill on deactivate.

**Files added:**

- `src/extension/api-server-lifecycle.ts`:
  - `start()`: resolves `ai-ui-automation` via the `file:..` link in `testbench/package.json`. The dep is always present (it's the parent repo) — no install flow needed
  - Generates random `SERVER_API_KEY` via `crypto.randomUUID()`
  - Picks free port: try `testbench.server.port` (default 3100), fall back via `net.createServer().listen(0)`
  - Spawns `node` against `dist/extension/server-bootstrap.cjs` with `SERVER_API_KEY`/host/port via env. Bootstrap does:

    ```js
    const { startServer } = require('ai-ui-automation/server');
    startServer({ port: +process.env.PORT });
    ```

    (Relies on the `./server` export added in Phase 0 same-repo work item)
  - Health-check loop: `GET /sessions` with key, 10× × 250ms; fail → output channel error
  - Pipes stdout/stderr to "TestBench" output channel
- `src/extension/api-client.ts` — `streamSteps(sessionId, steps, breakpoints?, parameters?, signal) → AsyncIterable<Event>`. Uses `fetch` with `Accept: text/event-stream`, parses SSE frames, yields typed events. Plus `closeSession`, `listSessions` helpers

**Tests added:**

- `tests/api-server-lifecycle.test.js` (~6) — mocks `child_process.spawn` + `fetch`; asserts random key generation, port fallback when 3100 busy, missing-dep flow surfaces install action
- `tests/api-client.test.js` (~5) — mock `fetch`; asserts request headers include `x-api-key`, body shape, SSE parsing yields ordered events including a final `done`

**Acceptance:** Status bar item "TestBench: server ready (port 3100)" appears within 3s of opening a `.md` file in the dev host.

**Risks:**

- `./server` export and SSE streaming must land in `ai-ui-automation` (same-repo) before this phase ships
- Bootstrap must set `process.env` before importing (the server throws at config-load if `SERVER_API_KEY` is absent)

---

## Phase 6 — Message protocol

**Goal:** Typed contract between webview and host.

**Files added:**

- `src/shared/protocol.ts` — TS union of all messages, plus `.js` re-export with JSDoc types for the JSX webview
- Host → webview: `init { text, breakpoints, theme, wordWrap }`, `step:start { line }`, `step:pass { line, output? }`, `step:fail { line, error }`, `paused { line }`, `output { msg, kind }`, `done { status }`, `error { message }`, `documentChanged { text }`
- Webview → host: `ready`, `run { lines }`, `stop`, `breakpoint:toggle { line, on }`, `edit { text }`, `requestSettings`

**Tests added:** `tests/protocol.test.js` (~10) — JSON round-trip every variant; type-narrow assertions (e.g. `isRunMessage`).

**Acceptance:** Malformed messages logged + ignored, no crash.

---

## Phase 7 — Tests-dir discovery

**Goal:** Resolve where `.md` test files live.

**Files added:**

- `src/extension/tests-dir.ts` — `resolveTestsDir(workspaceFolder): Promise<string>`:
  1. `testbench.testsDir` setting (resolved against workspace root)
  2. Else parse `<workspace>/ai-ui-auto.config.ts` with regex extractor `tests:\s*{[^}]*dir:\s*['"]([^'"]+)['"]` (no TS execution). When the workspace root *is* `ai-ui-automation`, this is the canonical path
  3. Else `tests/`
  4. Else workspace root

**Tests added:** `tests/tests-dir.test.js` (~5) — fixture configs covering all four branches.

**Acceptance:** "TestBench: Show Tests Dir" command pops absolute path.

**Risks:** Template strings / env interpolation in `dir` won't parse — MVP limitation.

---

## Phase 8 — Migration of Electron runner UI bits

**Goal:** Lift only what's useful from `../src/ui/` (the existing Electron renderer in the parent repo).

**Lift:** per-step result rendering pattern (status, screenshot thumbnail) — adapt into webview's run log. Screenshots are `data:image/png;base64,...` per SPEC-SESSIONS-API.

**Leave:** all Electron `main`/`renderer` plumbing, IPC layer, electron-builder config. Once the extension reaches feature parity, delete the Electron runner from `../src/ui/` in a follow-up commit.

**Files added:**

- `src/webview/lib/render-step-result.js` — pure helper: `(stepResult) → { entries: LogEntry[], screenshot?: dataUri }`

**Tests added:** `tests/render-step-result.test.js` (~5) — passed/failed/output-capture/multi-output cases mirroring SPEC-SESSIONS-API fixtures.

**Acceptance:** Running a known-good test shows screenshots inline.

**Risks:** Large base64 blobs — consider lazy load in a perf pass.

---

## Phase 9 — Settings & commands

**Goal:** VS Code-native config surface.

**`package.json` additions:**

- `contributes.configuration`:
  - `testbench.testsDir` (string, default `""`)
  - `testbench.editor.wordWrap` (boolean, default `true`) — replaces `app-settings.json`
  - `testbench.server.port` (number, default 3100)
  - `testbench.aiUiAutomation.path` (string, optional override)
- `contributes.commands`: six commands. Implementations in `src/extension/commands/`:
  - `run-selected.ts` (F5)
  - `run-all.ts`
  - `stop.ts`
  - `toggle-breakpoint.ts`
  - `reopen-as-text.ts` — `vscode.commands.executeCommand('vscode.openWith', uri, 'default')`
  - `install-ai-ui-automation.ts`

**Tests added:** `tests/commands-registry.test.js` (~3) — vscode mock, asserts six commands register and dispose.

**Acceptance:** Command Palette shows all six; settings UI shows `TestBench` section; `wordWrap` toggle re-renders active editor live.

---

## Phase 10 — F5 keybinding

**Goal:** F5 only fires inside TestBench editor.

**`package.json` keybindings:**

```jsonc
{
  "command": "testbench.runSelected",
  "key": "f5",
  "when": "resourceExtname == .md && activeCustomEditorId == testbench.editor"
}
```

Plus `-workbench.action.debug.start` with same `when` to suppress default debug F5 in this context.

**Tests added:** none (declarative).

**Acceptance:** F5 in TestBench editor runs target; F5 elsewhere still triggers debug picker.

**Risks:** If `activeCustomEditorId` context key isn't set when webview has focus, fall back to `activeWebviewPanelId`.

---

## Phase 11 — Build & dev loop

**Goal:** One command for dev iteration.

**`package.json` scripts (finalized):**

- `npm run watch` → `concurrently npm:watch:*` (Vite + `tsc --watch`)
- `npm run dev` → first build then `code --extensionDevelopmentPath=.`
- `.vscode/launch.json` "Run Extension" + "Attach to Extension Host"

**Tests added:** none.

**Acceptance:** Edit JSX → webview rebuilds → reload-window in dev host shows changes within 2s.

---

## Phase 12 — Marketplace prep (optional)

**Goal:** Publishable VSIX.

**Files added:** `icon.png` (128×128), rewritten `README.md`, `CHANGELOG.md`, `LICENSE`, finalized `.vscodeignore`.

**Acceptance:** `npm run package` produces `pkent-testbench-0.1.0.vsix` < 5 MB; `code --install-extension <vsix>` works on a clean profile.

---

## Cross-phase test summary

51 existing tests preserved. New test files (target counts):

- `step-lines.test.js` ~12
- `run-dispatch.test.js` ~6
- `host-message-router.test.js` ~5
- `webview-html.test.js` ~3
- `api-server-lifecycle.test.js` ~6
- `api-client.test.js` ~5
- `protocol.test.js` ~10
- `tests-dir.test.js` ~5
- `render-step-result.test.js` ~5
- `commands-registry.test.js` ~3

Total new ~60 cases; combined ~111 cases across ~24 suites, all under `node --test`.

---

## Same-repo work items in ai-ui-automation (sequenced before Phase 5)

Same as Phase 0 list — repeated here as the actionable checklist:

1. Add `"./server": "./dist/server/api-server.js"` to root `package.json` `exports`
2. Implement SSE on `POST /sessions/:id/steps?stream=1` emitting `step:start`, `step:pass`, `step:fail`, `paused`, `output`, `done`
3. Honour `breakpoints: number[]` in request body — server pauses between specified step indices, resumes on a follow-up `POST /sessions/:id/resume`

Blocking for Phase 5/6 but live in the same monorepo, so single commits can span both.

---

## Critical files for implementation

(All paths relative to `ai-ui-automation/testbench/`.)

- `package.json`
- `src/extension/extension.ts`
- `src/extension/editor-provider.ts`
- `src/extension/api-server-lifecycle.ts`
- `src/extension/run-controller.ts`
- `src/webview/testbench-runner.jsx`
- `src/webview/lib/step-lines.js`
- `src/shared/protocol.ts`

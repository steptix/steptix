# Flick-vscode — First-class CDP Attach via the Adopt dropdown

> **Verification rule for this story.** "Done" means the user can: (1) click
> "Adopt ▾" in the flick-vscode topbar and see one section per running
> Chromium-based browser (Chrome or Edge) started with
> `--remote-debugging-port=9222` (or 9223, or 9229), each labelled with the
> actual engine name parsed from `/json/version`, (2) click any tab and
> submit a step, with the underlying runner attaching to that exact tab via
> `cdpTab: targetId:<id>` and driving it, (3) click "Launch with CDP" from
> the dropdown and have a dedicated-profile browser appear (Chrome or Edge
> depending on what the user picked — both buttons visible when both are
> installed) with debugging enabled, immediately discoverable in the same
> dropdown without a manual refresh, and (4) see a `CDP:9222` badge on the
> resulting session tab so the mode is unambiguous at a glance. A live VS
> Code integration test that drives this end-to-end against a real browser
> is the contract; passing unit suites alone do not count.

## Context

The core runner already supports CDP attach via per-test `## Config` keys
(`cdp: <port>`, `cdpTab: <selector>`) — see
[stories/cdp-connection.md](cdp-connection.md). But flick-vscode is
chat-driven, not file-driven: users don't author a markdown test, they type
steps into a composer. So none of that CDP machinery is reachable today
through the extension. Users wanting a real Chrome with their profile have
to either drop down to the CLI or hand-edit a markdown test outside the
extension's flow.

The "Adopt ▾" dropdown added in commit `e283d3a` already establishes the
mental model "attach to something that already exists" — currently scoped
to server-side sessions. Extending it to also enumerate live Chrome tabs
makes CDP discoverable in the same gesture, with no new top-level menu.

## UX

The Adopt dropdown gains a second section, below the existing "Server
sessions" list:

```
┌────────────────────────────────────────────────┐
│  Adopt ▾                                       │
├────────────────────────────────────────────────┤
│  SERVER SESSIONS                            ⟳  │
│   ● flick-9f3a   (in use)                      │
│   ○ flick-2c1b                                 │
│                                                │
│  CHROME TABS  (port 9222)                   ⟳  │
│   🌐 GitHub · PR #482 — pkent/flick            │
│   🌐 localhost:3000 — Dashboard                │
│   ─────────                                    │
│   ＋ New tab in this Chrome                    │
│                                                │
│  EDGE TABS  (port 9223)                     ⟳  │
│   🌐 outlook.office.com — Inbox                │
│   ─────────                                    │
│   ＋ New tab in this Edge                      │
│                                                │
│  🚀 Launch with CDP:  [ Chrome ]  [ Edge ]     │
└────────────────────────────────────────────────┘
```

- **Engine-aware section headers.** For each responding port, the dropdown
  parses the `Browser` field of `/json/version` (e.g.
  `"Chrome/120.0.6099.130"`, `"Edge/120.0.2210.91"`, `"HeadlessChrome/…"`)
  and renders the section header + "+ New tab in this X" copy accordingly.
  Unknown Chromium variants fall back to `BROWSER TABS`.
- **Empty discovery.** When no ports respond, the tab sections collapse to
  one line — `No Chromium browser with CDP enabled.` — and the launch CTA
  remains.
- **Click a tab.** Creates a new local session, marks it `cdp: { port, tab:
  "targetId:<id>" }`, switches focus to it. First `submitSteps` carries
  these in the request config; the server passes them through to the
  runner, which attaches to that exact tab.
- **"＋ New tab in this X."** Same as above but `tab: "new"`. The runner
  opens a fresh tab inside that browser and closes it at teardown
  (existing behaviour).
- **Launch CTA — adaptive.** The launch row at the bottom of the dropdown
  changes shape based on what's installed:
  - **Only Chrome installed:** `🚀 Launch Chrome with CDP…`
  - **Only Edge installed:** `🚀 Launch Edge with CDP…`
  - **Both installed (split button):** `🚀 Launch with CDP:  [ Chrome ]
    [ Edge ]`. Last-used moves to primary (left) position on subsequent
    launches; persisted per-workspace.
  - **Neither installed:** `🚀 No Chromium browser found.` (disabled,
    with a tooltip linking to install instructions).
- **Launch behaviour.** Spawns the chosen engine with
  `--remote-debugging-port=9222 --user-data-dir=<workspace>/.flick/<engine>-profile`
  (`chrome-profile` or `edge-profile`). On success the dropdown
  auto-refreshes and the new browser's tabs (initially one `about:blank`)
  appear. On failure (binary not found, port busy, spawn error), shows an
  actionable toast with a copy-pasteable command.
- **Badge.** Sessions adopted via CDP show a small `CDP:9222` chip on
  their topbar tab, parallel to how the "in use" marker works for server
  sessions. Engine isn't on the badge — it's implied by the port and
  visible in the dropdown.
- **Refresh.** Dropdown queries on open + a manual ⟳ button per section.
  No polling.

## Locked decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Scan ports `[9222, 9223, 9229]` | Covers the common defaults without scanning a wide range |
| 2 | Add `targetId:<id>` selector to the runner | Only stable per-tab identifier; substring matches are ambiguous when duplicates exist |
| 3 | Refresh on open + manual button only | No polling — keeps idle cost zero |
| 4 | Launch helper uses dedicated profile at `<workspace>/.flick/<engine>-profile` | No fight with the user's everyday browser; trade-off is no logged-in sessions in the launched browser |
| 5 | Support both Chrome and Edge in the launch helper; show split button when both are installed | Edge is the default browser on Windows for most users — silently shadowing it is unacceptable. Discovery + attach against any Chromium engine already work for free via CDP |

## Protocol changes

New shapes in [flick-vscode/src/shared/protocol.ts](../flick-vscode/src/shared/protocol.ts):

```ts
export interface CdpAttachment {
  port: number;
  /** Tab selector string passed verbatim to the runner's parseCdpTabSpec. */
  tab: string;
}

export interface SessionMeta {
  // ...existing fields
  /** Present iff this session is CDP-attached. Drives the badge and the
   *  first-submit config payload. */
  cdp?: CdpAttachment;
}

export type CdpEngine = 'chrome' | 'edge' | 'chromium' | 'unknown';

export interface CdpDiscoveryTab {
  targetId: string;
  title: string;
  url: string;
  faviconUrl?: string;
}

export interface CdpDiscoveryPort {
  port: number;
  /** Parsed from /json/version's `Browser` field. 'unknown' for Chromium
   *  variants whose user-agent string doesn't match a known prefix. */
  engine: CdpEngine;
  /** null = port reachable but enumeration failed; empty array = reachable, no pages. */
  tabs: CdpDiscoveryTab[] | null;
  error?: string;
}

/** Which launch buttons the dropdown shows. Refreshed when the dropdown opens. */
export interface CdpInstalledBrowsers {
  chrome: boolean;
  edge: boolean;
  /** Last-used engine, persisted per-workspace; null on first run. Determines
   *  which button is rendered first when both are installed. */
  lastLaunched: 'chrome' | 'edge' | null;
}
```

New host→webview messages:

```ts
| { type: 'cdpDiscovery'; ports: CdpDiscoveryPort[]; installed: CdpInstalledBrowsers }
| { type: 'cdpLaunchResult'; engine: 'chrome' | 'edge'; ok: boolean; port?: number; error?: string }
```

New webview→host messages:

```ts
| { type: 'discoverCdp' }                                            // refresh request
| { type: 'adoptCdpTab'; port: number; targetId: string }            // creates session, focuses it
| { type: 'newTabInCdp'; port: number }                              // tab: "new" variant
| { type: 'launchBrowserCdp'; engine: 'chrome' | 'edge'; port: number }  // default 9222
```

`StepsRequestConfig` in [api-client.ts:64-68](../flick-vscode/src/extension/api-client.ts#L64) gains `cdp?: { port: number; tab?: string }`. The server's `StepRequest` already passes unknown config keys through to the runner ([src/server/api-server.ts:78-80](../src/server/api-server.ts#L78-L80)); the only server-side change is widening the inline type so TS doesn't strip the field.

## Runner: `targetId:` selector

Add to [src/browser/manager.ts](../src/browser/manager.ts):

1. `parseCdpTabSpec` recognises `targetId:<id>` → `{ kind: 'targetId', value: id }` (id must be non-empty hex-ish; reject empty).
2. `resolveCdpTab` for `targetId` uses CDP's `Target.getTargets` (via `context.newCDPSession(page)`) to map Playwright `Page` objects to their underlying `targetId`. Match exact, fail with the existing "no tab matches" error including tab list.
3. New `targetId:` selector never opens a fresh tab — if the id is gone, the test fails fast.
4. Add cases to [tests/browser-manager-cdp.test.ts](../tests/browser-manager-cdp.test.ts).

## Extension: CDP discovery

New module `flick-vscode/src/extension/cdp-discovery.ts`:

- `discoverCdpPorts(ports: number[], timeoutMs = 1500): Promise<CdpDiscoveryPort[]>`
- For each port in parallel: `GET http://127.0.0.1:<port>/json/version` (alive), then `GET /json/list` (tabs).
- Parse the `Browser` field from `/json/version` into a `CdpEngine`:
  - Prefix matches: `"Edge/…"` → `'edge'`, `"Chrome/…"` → `'chrome'`, `"HeadlessChrome/…"` → `'chrome'`, `"Chromium/…"` → `'chromium'`, anything else reachable → `'unknown'`.
- Filter `type === 'page'`; drop URLs starting with `devtools://` or `chrome-extension://`.
- Map each to `CdpDiscoveryTab` (id → targetId, take faviconUrl if the browser provides one).
- Per-port error capture: a thrown fetch returns `{ port, engine: 'unknown', tabs: null, error }`; reachable-but-no-pages returns `{ port, engine, tabs: [] }`.
- No retries; the manual refresh button is the retry surface.

The controller wires `discoverCdp` → `discoverCdpPorts(SCAN_PORTS)` → posts `cdpDiscovery` back, **also including `installed: CdpInstalledBrowsers`** so the webview knows which launch buttons to render. `adoptCdpTab` and `newTabInCdp` create a session with `cdp` set on `SessionMeta` and broadcast `sessions`.

## Extension: Browser launcher

New module `flick-vscode/src/extension/browser-launcher.ts`:

- `detectInstalled(): { chrome: string | null; edge: string | null }` — returns the resolved binary path for each engine, or `null` if not found. Cached after first call (paths don't change mid-session).
- `launchBrowserWithCdp(engine: 'chrome' | 'edge', port: number, profileDir: string): Promise<{ ok: true; pid: number } | { ok: false; error: string }>`
- Resolve binary path per engine:

  **Chrome:**
  - Windows: `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`, then `%PROGRAMFILES%\Google\Chrome\Application\chrome.exe`, then `%PROGRAMFILES(X86)%\...`.
  - macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
  - Linux: `which google-chrome` / `google-chrome-stable` / `chromium`.

  **Edge:**
  - Windows: `%PROGRAMFILES(X86)%\Microsoft\Edge\Application\msedge.exe`, then `%PROGRAMFILES%\Microsoft\Edge\Application\msedge.exe`, then `%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe`.
  - macOS: `/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`.
  - Linux: `which microsoft-edge` / `microsoft-edge-stable`.

  Fall back: error `'Chrome not found'` / `'Edge not found'` carrying the canonical command for the user to copy.

- `spawn(binaryPath, ['--remote-debugging-port='+port, '--user-data-dir='+profileDir, '--no-first-run', '--no-default-browser-check'], { detached: true, stdio: 'ignore' }).unref()`. **Array form is mandatory** — string concat would be a command-injection vector if `profileDir` ever contained spaces or quotes.
- Profile dir is per-workspace and per-engine: `path.join(workspaceFolder, '.flick', engine + '-profile')` → `.flick/chrome-profile` or `.flick/edge-profile`. Created on demand.
- After spawn, poll `/json/version` on the port for up to 5s; success → `cdpLaunchResult { engine, ok: true, port }`; the controller persists `lastLaunched: engine` to workspace state so next dropdown shows that engine's button first. Webview re-discovers automatically.

## Webview: dropdown sections + CDP badge

In [flick-vscode/src/webview/main.ts](../flick-vscode/src/webview/main.ts), extend the Adopt dropdown render (current implementation around lines 300–397):

- Render one server-sessions section + one section **per responding port**, with `<h4>` headers (`SERVER SESSIONS`, `CHROME TABS (port N)`, `EDGE TABS (port N)`, etc., driven by `port.engine`). Unknown engines render as `BROWSER TABS (port N)`.
- Empty-state for server sessions: "No active sessions." When `ports` is empty across the board: replace all CDP sections with one line — "No Chromium browser with CDP enabled."
- The "+ New tab in this X" row uses the same engine label as the section header.
- Sticky footer row — **adaptive launch CTA** driven by `installed`:
  - `{chrome: true, edge: false}` → single button `🚀 Launch Chrome with CDP…`
  - `{chrome: false, edge: true}` → single button `🚀 Launch Edge with CDP…`
  - `{chrome: true, edge: true}` → split button `🚀 Launch with CDP:  [ Chrome ] [ Edge ]`. Order: `installed.lastLaunched` first if set, else Chrome first.
  - `{chrome: false, edge: false}` → disabled row `🚀 No Chromium browser found.` with a tooltip "Install Chrome or Edge to use Launch."
  - Each button fires `launchBrowserCdp { engine, port: 9222 }`.
- Each tab row is a button: favicon (if any) + title + truncated URL on second line.
- Posts `discoverCdp` on dropdown open; posts again on ⟳ click.

In [flick-vscode/src/webview/styles.css](../flick-vscode/src/webview/styles.css):

- New `.adopt-section` / `.adopt-section-header` styles.
- `.session-tab .cdp-badge` — small pill, e.g. `background: var(--vscode-charts-orange); color: #fff;`.

In the session tab renderer, when `session.cdp` is present, append a `<span class="cdp-badge">CDP:{port}</span>` next to the session name.

## Server change (minimal)

Widen the inline `config` type in [src/server/api-server.ts:78-80](../src/server/api-server.ts#L78-L80) and the `StepRequest.config` shape in [src/server/session-manager.ts](../src/server/session-manager.ts) to include `cdp?: { port: number; tab?: string }`. No new validation needed — the runner already validates the shape on receive. (A loose pass-through here keeps the server schema-agnostic about CDP, matching how `baseUrl`/`timeout` are handled today.)

## Out of scope

- **Auto-launch at extension activation.** Manual only — matches the philosophy of [stories/cdp-connection.md](cdp-connection.md#why-cdp-doesnt-auto-launch-chrome).
- **Picking the user's real browser profile.** Could be a follow-up toggle ("Use my real Chrome/Edge profile") but pulls in foot-guns (must close existing browser first); ship without it.
- **Brave, Opera, Vivaldi, Arc.** All Chromium-based and discoverable for free if the user manually launches them with `--remote-debugging-port=...`, but the launch helper only supports Chrome and Edge in v1. The `engine: 'unknown'` discovery fallback keeps them functional via the dropdown — just no one-click launch.
- **Live tab polling.** Manual + on-open refresh only.
- **Multi-port launch.** The Launch buttons only spawn on 9222.
- **`cdp:` field in `aiui.config.ts`.** Still future, per the older story.

---

# Plan

## Workstream graph

```
W0 — Spec lands (this doc)
 │
 ▼
W1 — Protocol shapes (small; unblocks everything else)
 │
 ├──────────┬──────────┬─────────────┐
 ▼          ▼          ▼             ▼
W2          W3         W4            W5
runner      cdp-       chrome-       webview UI
targetId:   discovery  launcher      (dropdown +
selector    module     module        badge + msgs)
 │          │          │             │
 └────┬─────┴─────┬────┘             │
      ▼           ▼                  │
   W6 controller plumbing  ─────────┘
   (wires messages, stores cdp on SessionMeta,
    forwards to api-client)
                  │
                  ▼
              W7 — server StepRequest type widen
                  │
                  ▼
              W8 — integration + live tests
                  │
                  ▼
              W9 — patch-version bump, package, manual smoke
```

W2, W3, W4 are fully independent and can run **in parallel** once W1 lands. W5 can also run in parallel (it mocks the host with stub messages). W6 fans them in.

## Subagent assignments

Each row is one `general-purpose` agent unless noted. Prompts state the file paths, the exact contract, and the test it must satisfy — so agents synthesise nothing critical.

| ID | Owner | Files | Independent? | Estimated effort |
|---|---|---|---|---|
| W1 | one agent | `flick-vscode/src/shared/protocol.ts`, narrow type-only edits in `controller.ts` and `api-client.ts` to keep TS green | sequential | 30 min |
| W2 | parallel agent A | `src/browser/manager.ts`, `tests/browser-manager-cdp.test.ts` | parallel after W1 | 2 h |
| W3 | parallel agent B | `flick-vscode/src/extension/cdp-discovery.ts` (new), `flick-vscode/tests/unit/cdp-discovery.test.ts` (new) | parallel after W1 | 2 h |
| W4 | parallel agent C | `flick-vscode/src/extension/browser-launcher.ts` (new), `flick-vscode/tests/unit/browser-launcher.test.ts` (new) — Chrome + Edge resolution, both engines spawned via same code path | parallel after W1 | 3 h |
| W5 | parallel agent D | `flick-vscode/src/webview/main.ts`, `flick-vscode/src/webview/styles.css` — adaptive launch CTA (single / split / disabled), per-engine section headers | parallel after W1 | 3.5 h |
| W6 | one agent | `flick-vscode/src/extension/controller.ts`, `flick-vscode/src/extension/api-client.ts`, extend `flick-vscode/tests/integration/controller.test.ts` | after W2–W5 | 3 h |
| W7 | one agent | `src/server/api-server.ts`, `src/server/session-manager.ts` | after W1 (can run alongside W2–W5) | 30 min |
| W8 | one agent | `flick-vscode/tests/vscode/suite/adopt-flow.test.cjs` (extend), `flick-vscode/tests/vscode-live/suite/cdp-flow.test.cjs` (new) | after W6, W7 | 3 h |
| W9 | main thread | `flick-vscode/package.json` patch bump, `npm run build && npm run package`, install VSIX, manual smoke | last | 30 min |

Total wall time ≈ **1 day** if W2–W5 run in parallel, plus integration testing on top.

## Code review

For each workstream PR (or commit, since this is a personal repo):

1. **Author agent** finishes its work, posts a short summary of changes.
2. **Main thread verifies** with `git diff` (no agent narration trusted blind — agents describe intent, the diff is the ground truth).
3. **Run `simplify` skill** on each workstream's changed files before declaring done. This catches stub duplication and over-abstraction.
4. **Spawn `general-purpose` "reviewer" agent** for W6 and W8 specifically — they touch the most surface and are the most error-prone. Prompt: "Review this branch's diff for: (a) message-protocol round-trip completeness — every webview→host message has a controller handler and every host→webview message has a webview handler; (b) error paths surfaced via toasts or banners, never silently swallowed; (c) memory of `session.cdp` survives reload (persisted to store)." Reviewer agent only reads — never edits.
5. **Final security pass** with the `security-review` skill before merging to main — checks for: command injection in the chrome-launcher spawn args (must be array form, never string concat), HTTP fetches to localhost only (no SSRF surface), no credentials leaked into logs.

## Test matrix

### Unit (vitest, repo root)

- **W2 / `tests/browser-manager-cdp.test.ts`** — extend:
  - `parseCdpTabSpec('targetId:ABC123')` → `{ kind: 'targetId', value: 'ABC123' }`
  - `parseCdpTabSpec('targetId:')` → `{ kind: 'invalid' }`
  - `resolveCdpTab` finds the matching page by mocked target id; missing id throws the standard "no tab matches" error.

### Unit (node:test, [flick-vscode/tests/unit](../flick-vscode/tests/unit))

- **W3 / `cdp-discovery.test.ts`** (new):
  - Mocks `fetch` to return canned `/json/version` + `/json/list` payloads. Asserts:
    - All three ports queried in parallel.
    - Filters out `devtools://` and non-`page` types.
    - Per-port error → `{ port, tabs: null, error }`, doesn't fail the whole call.
    - Empty list → `{ port, tabs: [] }`.
- **W4 / `browser-launcher.test.ts`** (new):
  - Mocks `fs.existsSync` and `child_process.spawn`; asserts:
    - `detectInstalled()` returns `{chrome, edge}` paths correctly per OS, `null` when each binary is missing.
    - Resolution order on Windows/macOS/Linux for both engines.
    - Both engines launched via the same code path — same flags, same array-form spawn (regression guard for injection).
    - Profile dir is `.flick/chrome-profile` when `engine: 'chrome'`, `.flick/edge-profile` when `engine: 'edge'`, both `mkdirSync(..., { recursive: true })`'d.
    - "Not found" errors carry the copy-paste command for the specific engine the user picked.
    - `lastLaunched` persistence: simulate a Chrome launch, then an Edge launch, assert the workspace state's `cdpLastLaunched` is updated each time.

### Integration (node:test, [flick-vscode/tests/integration](../flick-vscode/tests/integration))

- **W6 / extend `controller.test.ts`**:
  - Add a `FakeBrowserServer` (parallel to the existing `FakeApiServer`) that serves `/json/version` (with configurable `Browser` field) and `/json/list` on a random port.
  - Test cases:
    - `discoverCdp` posts `cdpDiscovery` listing the fake server's tabs and the correct `engine` (Chrome vs Edge vs unknown) based on the `Browser` string.
    - `adoptCdpTab` creates a `SessionMeta` with `cdp: { port, tab: 'targetId:<id>' }`, broadcasts `sessions`.
    - `submitSteps` on a fresh CDP session includes `cdp` in the request body sent to `FakeApiServer`; on subsequent submits it does not (matches `used` semantics).
    - `discoverCdp` against an unreachable port returns `{ port, engine: 'unknown', tabs: null, error }`.
    - `discoverCdp` also returns `installed: CdpInstalledBrowsers` with `lastLaunched` read from workspace state.
    - `launchBrowserCdp` with `engine: 'edge'` calls the launcher with the Edge binary and writes `lastLaunched: 'edge'` to workspace state; next `discoverCdp` reflects it.

### Live VS Code (no real Chrome, [flick-vscode/tests/vscode/suite](../flick-vscode/tests/vscode/suite))

- **W8 / extend `adopt-flow.test.cjs`** (or new `cdp-flow.test.cjs` if the file grows too long):
  - Starts two `FakeBrowserServer` instances on different ports, one identifying as Chrome and one as Edge.
  - Drives the extension via `__testHooks` to: open sidebar → fire `discoverCdp` → assert webview received `cdpDiscovery` with one Chrome-labelled section and one Edge-labelled section → fire `adoptCdpTab` against an Edge tab → assert a new session tab exists with `cdp.port` matching Edge's port.

### Live (real Chrome, [flick-vscode/tests/vscode-live/suite](../flick-vscode/tests/vscode-live/suite))

- **W8 / new `cdp-live-flow.test.cjs`**:
  - Spawns a real browser via the same `browser-launcher` module the extension uses (so the test exercises that code path too). Test runs **once per available engine** on the host (Chrome and Edge), via a `for (const engine of detectInstalledEngines())` loop — both must pass when both are installed; the test is skipped (not failed) on a host missing both.
  - Navigates one of its tabs to `data:text/html,<title>FlickLiveCdp</title>...`.
  - Drives the extension to discover, adopt that tab by title (via `targetId:` captured from `/json/list`), submit a trivial step ("read the page title"), assert the response references the page and that `cdpDiscovery` labelled the section correctly per engine.
  - Tears down: closes the spawned browser.
  - **Required to merge.** This is the verification rule for the story.

## Risks / open

- **Chrome 122+ / Edge equivalent default behaviour** rejects `--remote-debugging-port` on the default profile. Our launcher uses `--user-data-dir`, which is the official workaround for both engines, so we're fine — but worth a comment at the spawn site.
- **VS Code sandbox + spawn.** The extension host runs in a Node process with full `child_process` access (it already shells out to the runner). No new sandbox surface.
- **Multiple workspaces.** Profile dir is per-workspace per-engine. If the user has two windows open on different folders and launches Edge in each, two profiles → two Edges. Fine, but worth a release note.
- **Stale `targetId` after browser restart.** Session keeps the dead id; next `submitSteps` fails preflight tab-not-found. Acceptable v1 behaviour — the error is clear and the user re-adopts.
- **Engine detection misclassification.** A future browser variant whose `Browser` field starts with neither `Chrome/`, `Edge/`, `HeadlessChrome/`, nor `Chromium/` lands in `engine: 'unknown'` and the dropdown renders `BROWSER TABS` for it. Adoption + attach still work — only the label is generic. Add new prefixes as they appear in the wild.

---

# Delta 1 — Only show reachable ports; Launch is the entry point

> **Status:** refinement of the shipped v1 (flick-vscode 0.4.x). Shipped
> behaviour rendered one section per *scanned* port — and since
> `discoverCdpPorts` returns a result for every port in `[9222, 9223, 9229]`
> (unreachable ones come back as `{ engine: 'unknown', tabs: null, error:
> 'fetch failed' }`), a machine with no debug browser running showed **up to
> three errored "BROWSER TABS (port N)" sections**. The `ports.length === 0`
> "No Chromium browser with CDP enabled." branch never fired because the list
> is never empty. This delta makes the port sections conditional on a real
> connection, so the Launch CTA is the entry point when nothing is attached.

## Rule

A port section renders **iff the port is reachable** (its `/json/version`
returned 2xx) **and isn't a Node.js inspector**. This splits today's single
"error" notion in two, and excludes one reachable-but-not-a-browser case:

- **Alive-check failed** (connection refused / timeout / non-2xx) → nothing is
  listening there → **hidden**.
- **Reachable but `/json/list` failed** → a real browser with a hiccup →
  **shown** with its error.
- **Reachable but `engine: 'node'`** → a Node.js `--inspect` endpoint, not an
  attachable browser → **hidden** (see "Node.js inspector exclusion" below).

## Behaviour matrix

| Port state | Dropdown shows |
|---|---|
| Alive-check failed (nothing listening) | nothing — hidden |
| Reachable, `engine: 'node'` (Node.js inspector) | nothing — hidden |
| Reachable, has page tabs | `CHROME TABS (port N)` + tab rows + `＋ New tab in this <Engine>` |
| Reachable, zero adoptable tabs (all filtered) | minimal section: header + `＋ New tab` only (no "No open pages." line) |
| Reachable, `/json/list` errored (`tabs: null`) | header + error subtitle + `＋ New tab` |
| No visible ports at all | CDP area empty; only the Launch CTA below (no hint line, no ⟳) |

`about:blank` tabs (and any page with an empty title on `about:blank`) render
with the friendly label **"New Tab"** instead of the raw hex `targetId`, so a
freshly launched browser's starting tab is clickable and legible.

## Changes

1. **Protocol** — add `reachable: boolean` to `CdpDiscoveryPort` in
   [flick-vscode/src/shared/protocol.ts](../flick-vscode/src/shared/protocol.ts).
   `true` once `/json/version` returns 2xx, regardless of what `/json/list`
   does. Needed because a reachable browser with an empty `Browser` field is
   *also* `engine: 'unknown'` with `tabs: null` — shape alone can't tell it
   apart from a refused connection, so an explicit flag is required.
2. **cdp-discovery.ts** — set `reachable` in `probePort`: `false` on the
   early-return alive-check failure path, `true` once the version fetch
   succeeds (before the `/json/list` call). Discovery still returns one entry
   per scanned port — the unreachable-port integration test depends on that.
3. **webview main.ts** — `renderCdpSection` filters `state.cdpPorts` to
   `p.reachable && p.engine !== 'node'` before rendering. Drop the
   "No Chromium browser with CDP enabled." placeholder and the "No open
   pages." text. When the filtered list is empty, the CDP area renders
   nothing (the Launch CTA still shows below). Add a friendly-label helper for
   `about:blank` in `renderCdpTabRow`. No ⟳ in the empty state — the dropdown
   already re-discovers on every open and after each launch.
4. **Tests** — extend `cdp-discovery.test.ts` to assert `reachable` is `true`
   for the responding cases, `false` for the unreachable case, and `engine:
   'node'` (reachable, tabs filtered to `[]`) for the Node inspector case.
   Add `reachable` assertions to the controller integration suite. Webview
   render isn't unit-tested; the live `cdp-flow.test.cjs` already launches a
   real browser so a reachable section still appears there.

## Node.js inspector exclusion

Port 9229 is in the scan list but is also the **Node.js `--inspect`
default** — any `tsx` / dev-server / API-server process with a debugger
attached answers CDP's `/json/version` there with `Browser:
"node.js/v22.x"` and a single `type: "node"` target. Before this fix it
rendered as a bogus `BROWSER TABS (port 9229)` section (reachable, zero
page-tabs → minimal section). It's now classified as `engine: 'node'` and
filtered out of the dropdown.

- **Decision:** keep scanning `[9222, 9223, 9229]` (don't change the port
  list) but classify and hide `node.js`. This handles a Node inspector on
  *any* scanned port, not just 9229 — e.g. a process started with
  `--inspect=9222`.
- `classifyEngine` adds `node.js/` → `'node'`; `CdpEngine` gains `'node'`.
- The webview filter becomes `p.reachable && p.engine !== 'node'`. Genuine
  unknown-Chromium browsers (`engine: 'unknown'`, e.g. Brave/Arc) still show
  via the `BROWSER TABS` fallback — only Node endpoints are excluded.

## Out of scope (still)

- Manual ⟳ in the empty state — re-discover-on-open covers it.
- A "no browser connected" hint near the Launch buttons — the button labels
  (`🚀 Launch Chrome with CDP…`) are self-explanatory.

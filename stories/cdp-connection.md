# CDP Connection — Attach to a Live Chrome via Chrome DevTools Protocol

## Context

By default the harness launches a fresh Chromium (or Chrome) via `playwright.chromium.launch()`. This is great for clean, isolated test runs but makes three classes of test painful or impossible:

1. **Tests against an already-authenticated session** — re-running a long login flow on every test (SSO, MFA, hardware keys) is slow and flaky.
2. **Tests that depend on a real Chrome profile** — sites that fingerprint the browser look at extensions, history, saved passwords, autofill, and the absence of bot-like signals. A fresh Playwright Chromium fails this even with the stealth plugin.
3. **Tests that need to interact with the user's own installed Chrome extensions** — password managers, ad blockers, internal corporate extensions.

CDP mode lets a test attach to a Chrome instance that the user already started with `--remote-debugging-port=<port>`. The harness opens (or selects) a tab inside that real browser, drives it via Playwright's `connectOverCDP`, and leaves the browser running when the test ends.

The user is responsible for starting Chrome with the right flag — the harness does not launch Chrome in CDP mode (see "Why CDP doesn't auto-launch Chrome" below).

## Per-test syntax

Specified in the `## Config` section of the test markdown file:

```markdown
## Config
- baseUrl: https://app.example.com
- cdp: 9222
- cdpTab: new
```

| Key       | Required | Default | Meaning |
|-----------|----------|---------|---------|
| `cdp`     | no       | unset   | Port number Chrome was started with. Presence of this key (with a positive integer value) **enables CDP mode**. There is no separate `cdp: true` form — the port is mandatory because the user explicitly wants to be able to run multiple Chrome instances on different ports. |
| `cdpTab`  | no       | `new`   | Which tab to drive. See "Tab selection" below. |

CDP mode is **per-test**, not global. A test suite can mix CDP and non-CDP tests freely — each gets its own browser session.

### Tab selection

`cdpTab` accepts:

- `new` *(default)* — open a fresh tab via `context.newPage()`. The new tab is closed at end-of-test; pre-existing tabs are left untouched.
- `<integer>` (zero-indexed, e.g. `0`, `1`, `2`) — attach to the Nth existing tab in the order Playwright reports them.
- `url~<substring>` — attach to the first tab whose URL contains `<substring>` (case-insensitive).
- `title~<substring>` — attach to the first tab whose title contains `<substring>` (case-insensitive).
- `active` — attach to the most recently focused tab. Resolved via the CDP `Target.getTargets` call: the harness picks the tab whose target was last activated.

When `cdpTab` selects an existing tab (anything other than `new`), the harness does **not** close the tab at end-of-test — it was the user's, and it stays the user's.

If no tab matches the selector, the test fails immediately with a clear error listing the open tabs (label + URL + title) so the author can fix the selector without rerunning to discover the tabs.

## Behaviour

When `cdp: <port>` is set on a test, the harness:

1. **Preflights** the port. Hits `http://localhost:<port>/json/version` with a short timeout (~2s). If that fails, the test fails with a clear, actionable error before any browser code runs:

   > Cannot connect to Chrome on port 9222. Start Chrome with:
   > `chrome.exe --remote-debugging-port=9222 --user-data-dir=<some-dir>`
   > and try again. (underlying error: ECONNREFUSED 127.0.0.1:9222)

2. **Connects** via `chromium.connectOverCDP('http://localhost:<port>')`.
3. **Selects the user's context** — `browser.contexts()[0]`. CDP exposes the running profile as the default context; you cannot create a new context with custom options against this connection.
4. **Resolves the target tab** per `cdpTab` (above).
5. **Wires up `PageTracker`** with the resolved tab as the "main" page. Pre-existing tabs that the test did not select are *ignored* by `PageTracker` — they are still present in `context.pages()`, but `PageTracker` filters them out so they don't pollute the multi-tab UX (e.g., `[switch tab]` instructions, popup detection).
6. **Runs the test** as normal.
7. **At teardown:**
   - If `cdpTab: new`: close the tab that was opened.
   - Otherwise: leave the tab open (the user owns it).
   - Always call `browser.close()` on the CDP-connected `Browser` handle. This severs the WebSocket; it does **not** close the user's actual Chrome process.

## Limitations vs default launch mode

These Playwright features are **degraded or unavailable** in CDP mode. They silently no-op rather than fail — but a `logger.warn` is emitted at session start when an incompatible config is set:

| Feature | Behaviour in CDP mode |
|---|---|
| Custom `viewport`, `windowSize`, `locale`, `timezoneId`, `userAgent`, `extraHTTPHeaders`, `permissions` | Ignored. The user's profile values apply. |
| `browser.headed` / `headless` | Ignored — Chrome is already running, headed or otherwise. |
| `browser.stealth` | Ignored — real Chrome doesn't need stealth. (This is a feature, not a bug.) |
| `browser.bypassCSP` | Cannot be set — CDP contexts don't honour the `bypassCSP` flag. |
| `slowMo` | Ignored on the connect call. |
| `browser.tracing.start` (Playwright traces) | Not supported on CDP-connected browsers. |
| Video recording, HAR recording | Not supported on CDP-connected browsers. |
| Cookie / storage isolation between tests | **None.** All CDP tests against the same Chrome share one profile. |
| Parallel CDP tests against the same port | Not supported — they share state. Different ports are fine. |

The standard automation primitives — `page.click`, `page.fill`, `page.evaluate`, `page.goto`, `page.screenshot`, `page.waitForSelector`, all DOM/screenshot capture used by the AI driver — work identically.

## Why CDP doesn't auto-launch Chrome

The harness deliberately does not launch Chrome in CDP mode. The user's own Chrome — with their profile, extensions, signed-in sessions, and history — is the *whole point*; auto-launching a Chrome with `--user-data-dir` pointing at a fresh directory would defeat every reason CDP was added. The user is expected to start Chrome manually (typically once, then leave it running across many test runs).

## Run-mode compatibility

The change lives in `src/browser/manager.ts` (the shared `launchBrowser` function), so all three run modes pick it up automatically:

- **CLI / F5** (`npm run` or `node dist/cli`) — same code path.
- **VS Code extension** — shells out to the same CLI/runner; the `localhost:<port>` connection is a TCP/WebSocket call from the Node process and is not affected by extension sandboxing.
- **Flick (Tauri)** — invokes the Node runner from its Rust backend; same code path. CDP mode actually *removes* a packaging concern for Flick, since the bundled Playwright Chromium is irrelevant when connecting to the user's Chrome.

## Files Changed

- `src/parser/types.ts` — `TestConfig` gains optional `cdp` and `cdpTab` string fields.
- `src/browser/manager.ts` — `launchBrowser` accepts an optional `cdp` block (port + tab spec), branches into a `connectOverCDP` flow, runs preflight, resolves the tab, and configures `PageTracker` to ignore pre-existing tabs.
- `src/runner/test-runner.ts` — reads `test.config.cdp` / `test.config.cdpTab`, validates them, passes a CDP options object to `launchBrowser`, and warns on incompatible global browser config (`headless`, `bypassCSP`, etc.) when CDP is engaged.
- `tests/parser.test.ts` — covers `cdp` and `cdpTab` parsing.
- `tests/browser-manager-cdp.test.ts` — new: tab resolver, preflight error, PageTracker filtering. Browser launch itself is integration-tested separately (requires a running Chrome on a known port).

## Future enhancements (out of scope)

- A `cdp:` field in `steptix.config.json` to set a default port for tests that omit it.
- Auto-discovery of running Chrome instances (`http://localhost:<scan>/json/version` across a range).
- Tab focus/foreground after attach (CDP `Page.bringToFront`).
- Automatic profile-dir spin-up via the harness (an opt-in convenience for users who *do* want a managed Chrome).

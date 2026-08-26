# Per-test viewport — mobile-width runs declared in the test file

## In plain terms

Sites that respond to CSS breakpoints render a genuinely different UI at phone
width — the nav collapses into a hamburger, tables stack into cards, whole
sections appear or disappear. Today there is no way to test that UI without
editing the server's own `aiui.config.json` and restarting it, which flips
*every* test on that server to the new size. And even that only works headless:
the headed browser (the default, and what TestBench users watch) ignores
`browser.viewport` entirely and takes its size from the window.

This story adds one line to a test file:

```markdown
## Config
- viewport: mobile
```

That test — and only that test — renders its pages at exactly 390 CSS pixels
wide, headed or headless, on whatever server runs it. Other tests on the same
server are untouched.

The value is either a preset or explicit dimensions:

| Value | Page size | Meant for |
|---|---|---|
| `mobile` | 390 × 844 | phone-side of common breakpoints |
| `tablet` | 768 × 1024 | tablet-side |
| `desktop` | 1440 × 900 | the current default, spelled out |
| `<width>x<height>` (e.g. `390x844`) | exactly that | testing a breakpoint edge (767 vs 768) |

One viewport per test file. The mobile and desktop variants of the same journey
are two thin test files sharing a skill for the flow — that pattern already
exists and stays the recommendation.

**What this is not:** device emulation. No touch events, no mobile user agent,
no devicePixelRatio change. A site that branches on CSS breakpoints sees its
mobile layout; a site that sniffs the UA or checks for touch does not. That is
a deliberate non-goal (§9).

### What it looks like in practice

**You write** `- viewport: mobile` in the Config section and hit Run.
**You get:** a phone-shaped browser window, the site's hamburger-menu layout,
and a log line — `viewport 390×844 (mobile, from test config)` — so the size
in effect is never a guess.

**You edit** the same line to `- viewport: 768x1024` while the session from the
last run is still alive, and hit Run again.
**You get:** a log line `viewport changed (mobile → 768x1024) — restarting
browser session`, a fresh browser at the new size, and the run proceeds. No
manual Restart Browser, no silently stale size.

**You write** `- viewport: 390` (no height).
**You get:** the run refused before any browser launches: *"Invalid '## Config:
viewport: 390' — expected a preset (mobile | tablet | desktop) or
`<width>x<height>` (e.g. `390x844`)."*

**You write** `- viewport: mobile` in a test that also declares `- cdp: 9222`.
**You get:** refused, same shape of error — a viewport cannot be imposed on the
user's own running Chrome, and silently ignoring it would be worse.

**You run** the sibling test with no `viewport:` key on the same server, at the
same time.
**You get:** today's behavior exactly — desktop size from the server's config.

> **Verification rule for this story.** "Done" means: (1) a test declaring
> `viewport: mobile`, run through TestBench against a server whose own config
> is the desktop default, renders its page at exactly 390 CSS px
> (`window.innerWidth`) in **headed** mode; (2) editing the value and
> re-running on a live session gets the new size without a manual Restart
> Browser; (3) a concurrent test without the key on the same server still gets
> the default; (4) the CLI runner honors the same key; (5) an invalid value
> fails before any browser launches, naming the given value and the accepted
> forms; (6) `viewport:` + `cdp:` in one file is refused.

## Context

What exists today, and why each piece forces a design choice:

- `browser.viewport` applies **headless only**; headed launches pass
  `viewport: null` and take the window's size
  ([manager.ts:1331](../src/browser/manager.ts)). So a per-test viewport that
  only worked headless would silently no-op in the default setup — §2 makes it
  exact in both modes.
- On the server path, a session's browser launches from the **server startup**
  browser config; only `video` is per-project
  ([session-manager.ts:1903](../src/server/session-manager.ts)). Sessions are
  created on the first step batch and map to one test file — so "per test"
  lands naturally as "per session launch" (§4).
- Per-session `config` on the wire (`baseUrl`, `timeout`, `cdp`) is
  **write-once**: a batch carrying `config` to an existing session throws
  ([session-manager.ts:1318](../src/server/session-manager.ts)). TestBench
  cooperates by omitting `config` after the first send
  (`configSentForSession`, [run-controller.ts:2221](../testbench-native/src/extension/run-controller.ts)).
  Viewport joins this write-once block — but unlike `baseUrl`, a stale value
  defeats the feature's whole point, so the *client* recycles the session on a
  mismatch (§5).
- Both Config-section parsers are generic key-value scans
  ([markdown.ts:489](../src/parser/markdown.ts),
  [test-meta.ts:62](../runner-core/src/test-meta.ts)), so the new key parses
  everywhere for free; only types and consumers change. `$VAR` resolution
  (TestBench) and `${env.X}` interpolation (server/CLI) apply to Config values
  already, so `viewport: $VIEWPORT` works without new code.
- The MCP `run_test` path builds its wire `config` from an explicit whitelist
  ([assemble.ts:567](../src/mcp/assemble.ts)) — viewport must be added there
  or MCP-run tests silently lose the key (§7).

## §1 Authoring

One `## Config` key, `viewport:`, whose value is a preset name or
`<width>x<height>`:

- Presets: `mobile` → 390×844, `tablet` → 768×1024, `desktop` → 1440×900.
- Explicit form: positive integers joined by `x`. Whitespace around the value
  is trimmed; the whole value is case-insensitive (`Mobile`, `390X844` are
  fine).
- Bounds: each dimension 100–10000 inclusive. Outside that, or anything else
  unparseable, is a refusal with the error text shown above — always naming
  the offending value and listing the accepted forms.
- Interpolation: values may arrive via `$VAR` (TestBench `.env` resolution) or
  `${env.X}` (server/CLI interpolation); validation runs on the resolved
  string.
- `viewport:` alongside `cdp:` in one file is an error at the same layer that
  validates the value (CLI: parse-to-launch; server: session creation).

Precedence: test-file `viewport:` > project `browser.fixedViewport` (§8) >
none (today's behavior, `browser.viewport`/`windowSize` untouched).

## §2 Semantics — exact page size, both modes

A new optional `BrowserConfig` field carries the resolved size:

```ts
/** When set, every context this launch creates gets EXACTLY this viewport —
 *  headed or headless — instead of the viewport/windowSize pair. Set by the
 *  runner/server from a test's `## Config: viewport:`; settable in
 *  aiui.config.json to pin a whole project (§8). */
fixedViewport?: { width: number; height: number };
```

`launchBrowser` honors it in both modes:

- `newContext` gets `viewport: fixedViewport` even when headed (today's headed
  path passes `null`). Playwright then renders the page at that exact size —
  which is the property a breakpoint test needs.
- The headed `--window-size` is derived from the viewport plus a small chrome
  allowance (implementer-tuned; intent: the visible window looks like the
  device, not a letterboxed desktop window with a phone-width page in one
  corner).
- Every browser the test opens inherits it: the mid-test `openBrowser` action
  relaunches from `config.browser`
  ([step-executor.ts:1191](../src/runner/step-executor.ts)), so a secondary
  browser in a `viewport: mobile` test is also mobile. An engine/headed
  override on the action does not clear it.
- CDP attach refuses `fixedViewport` (error, not the existing warn — the whole
  test was authored around a size we cannot impose on an attached browser).
- Video recording follows the context size, so a mobile test records a
  phone-shaped video with no extra work.
- Screenshots, `fullPageScreenshots`, scroll behavior: unchanged — all already
  derive from the context's viewport.

## §3 The wire

The step request's `config` block gains one optional string:

```jsonc
"config": { "baseUrl": "...", "timeout": "...", "viewport": "mobile" }
```

- The **raw spec string** travels; the server resolves and validates it. One
  validator, one error message, and dumb clients — TestBench forwards whatever
  the file says, like it does `baseUrl`.
- Write-once semantics are unchanged: `config` is still refused on an existing
  session. The resolved value is retained on `sessionConfig` (like `cdp`) so
  logs and future listings can name it.
- Validation runs at session creation **before** the browser launches; an
  invalid value fails the batch with the §1 error and no browser side effects.
- `SPEC-SESSIONS-API.md` documents the field.

## §4 Server

At session creation, resolve the spec and launch with
`{ ...browserCfg, fixedViewport }`. The server's startup config is never
mutated; concurrent sessions without the key are untouched. The launch log
names the size and its source:

```
Launching chromium (headed) — viewport 390×844 (mobile, from test config)
```

## §5 TestBench

- Forward `viewport` from `parseConfig` into the request's `config`, through
  `resolveValue` like `baseUrl` ([run-controller.ts:1826](../testbench-native/src/extension/run-controller.ts)).
- **Recycle on change:** the controller already tracks whether config was sent
  (`configSentForSession`); extend that to remember *which* viewport value was
  sent. On Run, if a live session exists and the file's (resolved) viewport
  differs from the sent one, close the session first — the existing
  `closeSession` path, which already resets the flag — log
  `viewport changed (a → b) — restarting browser session`, and proceed as a
  fresh session. Unchanged value: no recycle, sessions keep their signed-in
  state exactly as today. `baseUrl`/`timeout` edits keep their current
  (non-recycling) behavior; changing that is not this story.
- Bump the extension patch version (repo rule: runner-core is bundled).

## §6 CLI runner

`test-runner` resolves the parsed test's `viewport` before launch (next to
[parseCdpOptionsFromTestConfig](../src/runner/test-runner.ts), which is also
the model for the error style), errors on `cdp` conflict, and passes
`{ ...config.browser, fixedViewport }` to `launchBrowser` and the executor —
which is what makes the `openBrowser` inheritance in §2 free.

## §7 MCP

`viewport` joins `baseUrl`/`timeout` in the file-config string merge and the
`WireConfig` whitelist ([assemble.ts](../src/mcp/assemble.ts)), and the run
tool's `config` argument ([schemas.ts](../src/mcp/schemas.ts)) — so an agent
can run a file at a viewport without editing it, with the same per-key
tool-over-file precedence that `baseUrl` has. Session-reuse UX on the MCP path
(the write-once throw when a reused session's file config changed) is baseUrl
parity, unchanged by this story.

## §8 Project-wide pin (bonus knob)

`fixedViewport` lives on `BrowserConfig`, so `aiui.config.json` can set it:

```jsonc
"browser": { "fixedViewport": { "width": 390, "height": 844 } }
```

meaning *every* test in the project renders at exactly that size, headed or
headless — a mobile-only test suite in one line. A test's own `viewport:` key
overrides it per §1 precedence. Document the distinction from the legacy pair:
`viewport` (headless-only), `windowSize` (headed window), `fixedViewport`
(exact page size, both modes). Regenerate `schema/aiui.config.schema.json`.

## §9 Non-goals

- Touch, mobile UA, devicePixelRatio, Playwright device descriptors — CSS
  breakpoints only. A later "device emulation" story can extend the same key.
- Mid-run viewport changes (per-step resize).
- A viewport matrix (one file, N sizes) — two files sharing a skill.
- Improving the MCP session-reuse flow for changed config.

## §10 Tests

- **Resolver unit tests** (new module, e.g. `src/config/viewport.ts`): presets,
  explicit form, case/whitespace, `×`-free strictness, bounds, every error
  message names the value.
- **Parser**: `viewport:` lands on `TestConfig` (generic scan — one assertion),
  and `${env.X}` interpolation applies to it.
- **Browser manager**: with `fixedViewport`, the created context gets exactly
  that viewport in headless AND headed launch paths; without it, behavior is
  byte-for-byte today's (the minimum-scenario rule: no test may set
  `fixedViewport` in shared fixtures/defaults).
- **Server seam** (per repo convention, through the real api-server entry):
  batch with `config.viewport` → launch called with the resolved
  `fixedViewport`; invalid value → the §1 error, no launch; `viewport`+`cdp` →
  refused; a second session without the key on the same server launches with
  the startup config.
- **runner-core** (`node --test`): the request type carries `viewport`; the
  suite that pins the wire shape covers it.
- **TestBench** (integration harness, FakeApiClient): viewport forwarded on
  first send; changed value closes the old session before the next run;
  unchanged value does not.
- **MCP**: assemble tests — file `viewport` reaches the wire config; tool
  argument overrides file per key.
- **CLI**: test-runner launches with the resolved viewport; cdp conflict
  errors.
- **Live proof** (manual or live-suite): a `viewport: mobile` run against
  `fixtures/test-app` asserting `window.innerWidth` is 390 in headed mode —
  verification rule (1).

# Multi-browser — drive Chrome and Edge from one test

> **Verification rule for this story.** "Done" means a new fixture
> `fixtures/tests/multi-browser-demo.md` runs through
> `npx aiui run … --env local` against a live test-app and exercises **two
> distinct `Browser` processes in the same test run** — typically one Chrome
> (channel `chrome`) and one Edge (channel `msedge`) — with the test author
> writing only natural-language steps plus the new `[openBrowser ...]` /
> `[switchBrowser ...]` / `[closeBrowser ...]` shorthand. The fixture must
> demonstrate isolated cookie/auth state across the two browsers (e.g. Alice
> signed in on Chrome cannot see Bob's session on Edge) and the report must
> tag each step with which browser/page it ran on. Vitest passing alone does
> not constitute "done"; the end-to-end CLI flow is the contract.

## Context

The framework launches **exactly one `Browser` instance per test**. The test
runner calls [`launchBrowser`](../src/browser/manager.ts#L462) once at
[test-runner.ts:185](../src/runner/test-runner.ts#L185) and holds the result
as a single `BrowserSession` (browser + context + initial page +
`PageTracker`). Every action, assertion, screenshot, and tool call routes
through that one session.

Within that session you can have many pages — popups, `_blank` tabs, and
explicit `[openPage as=...]` actions all attach to **the same
`BrowserContext`** ([manager.ts:524](../src/browser/manager.ts#L524)). They
share cookies, localStorage, IndexedDB, service workers, auth state, and
extra HTTP headers. There's no way today to spawn an isolated session, let
alone a different browser engine or channel.

Two scenarios this blocks today:

| Scenario | Today |
|---|---|
| **Cross-browser smoke** — same workflow on Chrome and Edge in one test | Impossible. You'd have to run the test twice with `--browser` swapped, and there's no `'edge'` knob anyway because [manager.ts:495](../src/browser/manager.ts#L495) hardcodes `channel: 'chrome'` for chromium. |
| **Multi-actor flows** — Alice on browser A approves a request, Bob on browser B sees it appear | Impossible. A second `[openPage]` shares Alice's cookies, so Bob is just Alice in another tab. |

The right primitive isn't "another tab," it's "another fully-isolated
`Browser` process" — which Playwright already supports via repeat
`browserType.launch()` calls. The framework just doesn't expose it.

## User-facing surface

Mirror the existing `openPage as=...` / `switchPage to=...` grammar — that
pattern is already familiar to anyone who's written a multi-tab test
([fixtures/tests/new-window-navigation.md](../fixtures/tests/new-window-navigation.md)).

Three new actions:

```
[openBrowser as="<label>" engine="<chromium|firefox|webkit>" channel="<chrome|msedge|...>" headed=<bool>]
[switchBrowser to="<label>"]
[closeBrowser as="<label>"]
```

Worked example:

```markdown
## Steps
1. Navigate to /login and sign in as alice               (initial browser — Chrome)
2. [openBrowser as="edge" channel="msedge"]              (auto-switches to "edge")
3. Navigate to /login and sign in as bob                 (Edge instance, isolated cookies)
4. Click "Send approval request to alice"
5. Verify the toast says "Request sent"
6. [switchBrowser to="default"]                          (back to Chrome — Alice)
7. Verify the inbox shows Bob's request                  (cross-browser propagation via the server)
8. Click "Approve"
9. [switchBrowser to="edge"]
10. Verify the status pill on Bob's request now reads "Approved"
```

Key behaviors:

- **`openBrowser` auto-switches by default.** Just like
  [`openPage`](../src/runner/step-executor.ts#L654) auto-promotes the new
  page to active, `openBrowser` promotes the new browser to active so the
  next step targets it without an explicit `switchBrowser`. Saves a turn,
  matches the precedent.
- **The initial browser's label is `default`.** Whatever engine/channel the
  CLI/config picked starts the test. CLI flags (`--browser firefox`) set the
  *initial* browser's engine; `openBrowser` can pick anything for spawned
  ones.
- **`engine` defaults to the test config's engine.** So
  `[openBrowser as="edge" channel="msedge"]` is enough — no need to spell
  out `engine="chromium"` since chromium is the default and Edge is just a
  chromium channel.
- **`closeBrowser` is optional.** All tracked browsers are closed in the
  test runner's `finally` block at end of test, in reverse-creation order.
  Authors only write `closeBrowser` when they explicitly want to test
  resource teardown or release a heavy session early.

The AI can also emit these actions directly when a step says "in another
browser", "as a different user", "open Edge in parallel" etc. — analogous
to how it emits `openPage` / `switchPage` today.

## Core primitive — `BrowserTracker`

Direct mirror of [`PageTracker`](../src/browser/manager.ts#L91). Each
tracked unit is a full `BrowserSession` (browser + context + that
session's own `PageTracker`):

```ts
class BrowserTracker {
  private sessions = new Map<string, BrowserSession>();
  private activeLabel = 'default';

  add(label: string, session: BrowserSession): void;
  switchTo(label: string): void;
  has(label: string): boolean;
  getActive(): BrowserSession;
  getActivePage(): Page;            // shorthand: getActive().pageTracker.getActive()
  remove(label: string): Promise<void>;
  list(): BrowserSummary[];
  closeAll(): Promise<void>;
}
```

The test runner stops holding a single `session` and instead holds a
`tracker`. Every site that today reads `session.page` becomes
`tracker.getActivePage()`. There are roughly 30 such sites in
`step-executor.ts` and `test-runner.ts` — the change is mechanical but
broad.

## Engine/channel matrix

`openBrowser`'s `engine` × `channel` collapses to four practical pairings:

| Pairing | engine | channel |
|---|---|---|
| Chrome | `chromium` | `chrome` (default) |
| Edge | `chromium` | `msedge` |
| Chrome Beta | `chromium` | `chrome-beta` |
| Firefox | `firefox` | n/a (channel ignored) |
| WebKit | `webkit` | n/a |

Phase 1 must thread `channel` through `launchBrowser`, which is currently
hardcoded ([manager.ts:495](../src/browser/manager.ts#L495)).

## Where the framework changes

| Layer | Change | LOC |
|---|---|---|
| [manager.ts](../src/browser/manager.ts) | Make `channel` a parameter of `launchBrowser`. Expose `engine`/`channel`/`headed` overrides cleanly. | small |
| [test-runner.ts](../src/runner/test-runner.ts) | Replace `session` with `tracker`. Initial browser registered as `default`. `finally` closes all tracked browsers, not just one. | medium |
| [step-executor.ts](../src/runner/step-executor.ts) | Every reference to `session.page` / `pageTracker` reads from the tracker's active session. ~30 call sites. | medium-large |
| [actions.ts](../src/browser/actions.ts) | New `openBrowser`, `switchBrowser`, `closeBrowser` action types and executors. | small |
| [action-parser.ts](../src/ai/action-parser.ts) | Validate the new action shapes (label required for open/switch/close, engine/channel optional). | small |
| [invocation-parser.ts](../src/parser/invocation-parser.ts) | Parse the bracket shorthand. Bare scalar literals already supported (added in arrays-in-tools), so `headed=false` works without quoting. | small |
| [prompts.ts](../src/ai/prompts.ts) | Rule N: "If a step references another browser/user, emit `openBrowser as=<label>` (it auto-switches), then continue. Switch back with `switchBrowser to=default`. The active browser/page identity is in the test-info block — never lose track." | small |
| [report/generator.ts](../src/report/generator.ts) | Step rows tagged with `[browser=<label>, page=<label>]`. New top-of-report panel listing tracked browsers and their engine/channel. | medium |
| [tools/executor.ts](../src/tools/executor.ts) | Tool args get the active session's `page`/`context`/`browser` by default. (Cross-browser tools — Phase 2 — would accept an explicit `browser="<label>"` arg.) | small |

## Sharp edges

1. **AI losing track of which browser it's on.** Without explicit grounding,
   the AI will click on browser A's button text it remembers from earlier
   while the active browser is B. **Mitigation:** the `formatTestInfo` block
   in every prompt includes `Active browser: edge (chromium/msedge)` and
   `Active page: p1 (https://...)`. The AI sees the switch as part of its
   conversation context.
2. **Conversation history conflation.** History is global, not per-browser.
   A turn that clicked "Submit" in browser A shouldn't be misread as
   relevant to browser B. The active-browser identity in the test-info
   block is what disambiguates. Every prompt shows both the *label* and the
   *URL* of the active page so the AI grounds in the right DOM.
3. **Resource cost.** Each browser is its own OS process. Three browsers ≈
   3× startup time and memory footprint. Acceptable for rare multi-actor
   tests; not a default. The single-browser case stays the fast path —
   `BrowserTracker` is a thin wrapper, not a full pool.
4. **Closure on failure.** If a step throws mid-test, the `finally` must
   call `tracker.closeAll()` — closing all tracked browsers in reverse
   creation order. One-line change in test-runner.
5. **Same-label collision.** `[openBrowser as="default"]` should reject
   immediately with a clear error: "label 'default' is reserved for the
   initial browser; pick another."
6. **Tools.** Tools today get `page`, `context`, `browser` from the runner.
   Phase 1: they implicitly get the active browser's session. Phase 2: an
   explicit `browser="<label>"` arg lets a tool target a specific session
   (e.g. `[tool: extract_inbox_count browser="default"]`). Out of scope for
   the binding fixture.

## Phases

### Phase 1 — ship-able feature
- `openBrowser` (auto-switches), `switchBrowser`, `closeBrowser` actions, both AI-emitted and `[bracket]` shorthand
- `BrowserTracker` + active-pointer
- All actions/assertions/tools route through the active session
- Active-browser identity surfaced in every AI prompt via the test-info block
- Reports show the active browser per step and a top-of-report browsers panel
- `channel: 'msedge'` (and other channels) supported on the chromium engine
- Binding fixture `multi-browser-demo.md` passes against a live test-app

### Phase 2 — out of scope here
- Tools that target a specific browser via `browser="<label>"` arg
- Cross-browser comparison assertions (`compare table in browser=alice and browser=bob`)
- Concurrent / parallel action execution across browsers (today everything is sequential — fine)
- Persistent contexts, downloads-folder isolation, geo overrides per browser

## Decisions baked in (not open)

| Question | Decision |
|---|---|
| Initial browser's label | `default` |
| CLI `--browser` semantics with `openBrowser` | CLI sets the *initial* browser's engine; `openBrowser` can pick anything for spawned ones |
| API-only mode (skip browser launch) | Not part of this story |
| `openBrowser` auto-switch | Yes — matches `openPage` precedent. Authors don't write a separate `switchBrowser` after `openBrowser`. |

## Resolved decisions

1. **`closeBrowser` is uniformly permissive.** It closes whatever label you
   point it at — including `default`, including the active browser,
   including the last remaining browser. No special-casing. If a subsequent
   step has no active session to run on, it fails naturally with
   "no active browser session." The author owns the consequence; framework
   consistency wins over hand-holding.
2. **Switching to an unknown label fails the step loudly,** with an error
   listing the registered labels. Soft-fails make bugs invisible.
3. **`launchBrowser` validates non-default channels at launch time.**
   `channel: 'msedge'` requires Edge installed on the runner host; if the
   binary isn't found, emit a useful error ("Microsoft Edge not found —
   install it or change `channel`") rather than letting Playwright's stack
   trace bubble up.

## Binding fixture sketch

```markdown
---
tags: [smoke, multi-browser]
timeout: 120s
---

# Multi-browser demo — Chrome (Alice) + Edge (Bob)

## Config
- baseUrl: ${env.BASE_URL}

## Steps
1. Navigate to /login and sign in as "alice@example.com" with password "alice-pass"
2. Verify the page heading reads "Inbox — alice"
3. [openBrowser as="edge" channel="msedge"]
4. Navigate to /login and sign in as "bob@example.com" with password "bob-pass"
5. Verify the page heading reads "Inbox — bob" (proves the cookie jars are isolated; if they weren't, Bob would still be Alice)
6. Click "Compose" and send a message to alice with subject "ping"
7. [switchBrowser to="default"]
8. Wait for the inbox to refresh and verify the row "ping" from bob is visible
9. Click the row and verify the message body
```

This requires a small addition to the test-app: a multi-user login endpoint
and a basic inbox/messaging surface. Scope of test-app changes is part of
the implementation work, not the framework story.

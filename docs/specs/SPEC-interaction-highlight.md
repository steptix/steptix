# Interaction highlight: show which element each action touched

**Status:** Implemented on branch `claude/interaction-highlight` (PR
steptix/steptix#86) in the three phases of §14, with the decisions of §13, and
reviewed in six rounds. §§1–12 describe the code as built and why; §16 is the
history of how it got there.
**Date:** 2026-10-13 (written); 2026-10-14 (accepted, implemented, brought up
to date with the code)
**Audience:** anyone changing the highlight, or anything that reads the page or
takes a screenshot while a ring may be up
**Depends on:** `executeAction` (src/browser/actions.ts), the DOM capture
(src/browser/scripts/capture-dom.js), `captureScreenshot`
(src/browser/screenshot.ts), the run-settings resolution
(src/config/run-settings.ts), and the recorder toolbar's in-page pattern
(src/browser/scripts/record-toolbar.js)

---

## 1. Summary

When the option is on, every element Steptix clicks, types into, selects,
hovers, drags, uploads to, dismisses, sends keys to, reads or counts gets an
animated ring for `durationMs` (default 3 s), and the ring then fades out. The
point is to watch a run, live, in its video or in the report's screenshots,
and see which element each action touched. A project turns it on in
`steptix.config.json`:

```json
{ "browser": { "highlight": true } }
```

**Verdict: built, and cheap.** A throwaway prototype (§15) first showed the
construction working in Chromium, Firefox and WebKit, on a page whose CSP
blocks both inline style attributes and `<style>` elements. The unit suite now
re-proves the main points against the shipped code (§10.1); the drawing and CSP
cases run in every installed engine, the rest in Chromium:

- the overlay draws with no CSP violation;
- clicks and fills still land on the element under the ring, and
  `elementFromPoint` still answers that element;
- the DOM snapshot, `find`, `locateTexts`, page diagnosis and the settle
  fingerprint do not change;
- iframe and open-shadow-DOM targets are ringed in the right place.

The measured cost is within run-to-run noise for clicks and typing, about
1.1–1.9 ms for a read and 2.1–2.6 ms for a count (§5.1).

The prototype also found the one thing the overlay broke: Steptix's DOM capture
walks every child of `<html>`, so `captureDomSnapshot` emitted
`<steptix-highlight><!-- hidden: aria-hidden --></steptix-highlight>` into what
the AI reads. The capture now skips Steptix's own host (§4.1).

The design in brief:

- **Where it hooks.** A fire-and-forget `mark(locator, kind, max?, options?)`
  at the act site of each element handler in `executeAction`, on the final
  Locator (§2.2). Code-behind entries and fixture tools get a `page` Proxy that
  marks before each acting or reading call; the login broker marks explicitly
  (§2.3).
- **How it draws.** A page script, src/browser/scripts/highlight.js, run with
  `locator.evaluateAll` in the element's own frame. The overlay is a
  `<steptix-highlight>` host with a closed shadow root, shown in the browser's
  top layer as a manual popover, styled by an adopted stylesheet and animated
  with Web Animations: the recorder toolbar's construction, for the same
  reasons (§3). Each ring is two elements, so its fade runs on the compositor
  and finishes on time even while the page's main thread is blocked (§3.3
  item 11; measured in Chromium).
- **What is kept clean.** The DOM capture skips the host. Every screenshot a
  model reads is taken with the rings hidden, and when a ring that may be up
  cannot be hidden in time the capture gives no picture rather than one with a
  ring in it (§4.2, §4.3).
- **Off by default.** Per run it can be switched by CLI flag, by the
  `highlight` run setting (Sessions API, MCP) and by the `steptix.highlight`
  VS Code setting (§7).

### 1.1 Where the code lives

| File | What it holds |
| --- | --- |
| src/browser/highlight.ts | `resolveHighlight`, `ringsOutOfScreenshots`, `reportAudience`, the sink (`createHighlighter`, `highlighterFor`), the late-element wait, the ring records, `hiddenFor`, `hiddenForReport`, `endRings`, `pagesOf`, `onRegistry`, `RingsNotHiddenError` |
| src/browser/scripts/highlight.js | the in-page controller: host, rings, animations, registry handle |
| src/browser/highlight-page.ts | `highlightingPage`, `highlightingApi`, `unwrapHighlighted`: the Proxy for code-behind and tools |
| src/browser/actions.ts | `executeAction` (records `highlighted`, supplies `settled`), `executeActionMarked`, and the `mark` calls in each handler |
| src/browser/screenshot.ts | `captureScreenshot(page, fullPage, audience)` and `ScreenshotAudience` |
| src/browser/scripts/capture-dom.js, src/browser/dom-cleaner.ts | the snapshot's skip of Steptix's host (`isHighlightHost`), with the tag and key substituted by `buildDomCleanerScript` |
| src/config/{types,loader,defaults,run-settings}.ts | `HighlightConfig`, `assertHighlight`, `switchHighlight`, `applyCliOverrides`, `highlight: false`, `HIGHLIGHT_MODES`, `resolveRunSettings` |
| src/cli/commands/run.ts | `--highlight` / `--no-highlight` |
| src/runner/step-executor.ts | `highlightOption`, the capture audiences, `highlighted` on each sub-action |
| src/runner/test-runner.ts, src/server/session-manager.ts | `endBrowserRings` for `[use computer]`, tool highlighters, report audiences, `screenshotsToModel`, `SessionManager.highlighterFor` |
| src/runner/computer-step.ts | `EnterComputerModeInput.endBrowserRings` |
| src/codebehind/execute.ts | the wrapped page and APIs for an entry, `StepApiRuntime.highlight` for `step.read` / `step.count` |
| src/tools/executor.ts | the wrapped page for a tool (`ExecuteToolStepOptions.highlight`) |
| src/credentials/{broker,login-fields}.ts | `attemptLogin(page, hint, highlight)`, `typeInto`, `submitLogin` |
| src/server/{api-server,errand-runner,compile-runner}.ts | the run-setting parse, the tab peek's forced hide, errands' and compiles' audiences |
| src/mcp/{schemas,tools,types,run-fold}.ts | the `highlight` argument, `get_run_settings`, `screenshotsToModel` |
| src/ai/diagnose.ts, src/recorder/step-recorder.ts, src/codebehind/compile.ts | model-bound captures outside the executor |
| src/report/{types,generator}.ts | `SubActionResult.highlighted`, `data-highlighted` |
| steptix-vscode/src/extension/{run-settings-core,run-controller}.ts, runner-core/src/api-client.ts | the `steptix.highlight` setting and `StreamStepsRequest.runSettings` |

---

## 2. Where actions happen, and the hook point

### 2.1 Every path that touches an element

| Path | Where | How it is ringed |
| --- | --- | --- |
| AI steps: click, double/right-click, hold | `executeClick`; a hidden checkbox or radio clicks a stand-in label or ancestor (`hiddenToggleClick`, `clickInPlaceOf`) | `mark` in `executeAction`'s handler (§2.2) |
| type / fill | `executeType`: `fill`, or `pressSequentially` key by key when the step asks for it (`sequential`, SPEC-web-survey-fixes.md §2.3), with a click-then-keyboard fallback for non-fillable targets | §2.2 |
| select, hover, dismiss | `executeSelect`, `executeHover`, `executeDismiss` | §2.2 |
| drag | `executeDrag`: source and destination, then `page.mouse` at coordinates, with `dragTo` as fallback | §2.2 |
| upload | `executeUpload`: visible input, chooser click, or a hidden `input[type=file]` | §2.2 |
| keyboard / keypress | `executeKeyboard`: whatever has focus | §2.2 |
| read, read of every match, count, readTable | `executeRead`, `executeReadMultiple`, `executeCount`, `readTableRecords` | §2.2 |
| Skills, MCP `run_steps`, errands | through `executeStep` | §2.2 |
| Code-behind `step.read` / `step.count` | `recordedRead` → `executeAction`, with `StepApiRuntime.highlight` | §2.2 |
| Code-behind entries | `entry.run(ctx)` with `ctx.page`, `ctx.tabs`, `ctx.browsers` (`runCodeBehindEntry`, src/codebehind/execute.ts) | the page Proxy (§2.3) |
| Fixture tools | `ToolContext.page` (`executeToolStep`, src/tools/executor.ts) | the page Proxy (§2.3) |
| Login broker (`log_into_site`) | `typeInto` / `submitLogin` (src/credentials/login-fields.ts) | explicit marks (§2.3) |
| Compiled `If` conditions | `runCodeBehindCondition` | not ringed: the counterpart of the AI's condition judge, a read for Steptix's own purposes |
| `extract_csrf` | src/api/csrf-handler.ts | not ringed: a page-level read for an API call |
| `find` / `expand` | `findInDom` / `expandDomSubtree` (src/browser/dom-cleaner.ts) | not ringed: reads for the model's context |
| Assertions | AI-written JS through `page.evaluate` (step-executor.ts) | not ringed: Node never learns which element was checked |
| Recorder | observes the human; performs nothing | n/a |
| `[use computer]` | nut.js on the real screen; no DOM | n/a (§6) |

**Engines and CDP add no paths.** CDP-attached browsers (`connectOverCdpSession`,
src/browser/manager.ts) hand the same Playwright `Page` to the same handlers,
and Firefox and WebKit differ only at launch. A hook on a Locator is engine-
and CDP-agnostic by construction. The one engine difference is on the hiding
side: only a CDP connection can put two Page objects on one tab, and the
tab record that hides across them is keyed by its endpoint and Chromium's
target id (§4.3 rule 9).

### 2.2 The hook in `executeAction`

`ExecuteActionOptions.highlight` is a `HighlightSink`, absent when the
highlight is off. `executeAction` wraps it before calling
`executeActionMarked`, for two reasons:

- the wrapper notes every `mark` call, so the result carries `highlighted`
  (`read` wins if an action asks for both) on every return path (§11);
- it adds `MarkOptions.settled`, a promise that settles `true` or `false` when
  the action does, which bounds the wait for a late element (§5.5).

Inside, a `mark` function is handed to each handler. It is `NO_MARK` when the
highlight is off, and otherwise forwards to the sink inside a try/catch, so a
sink that throws cannot fail a step. Each handler calls it on the **final**
Locator, immediately before the Playwright call that acts or reads:

| Handler | What is marked | Kind, `max` |
| --- | --- | --- |
| `executeClick` | the Locator actually pressed, in its `press` helper: the stand-in label or box for a hidden toggle, not the invisible input | act |
| `executeType` | the element the step names, once, after `uncoverForTyping` and before `fill`, `pressSequentially` or the click-and-keyboard fallback. Usually the field; a `type` aimed at a `<label>` rings the label, the element acted on, while the text lands in the field it labels | act |
| `executeSelect`, `executeHover` | the visible first match | act |
| `executeDismiss` | the element about to be clicked, once its visibility check passed | act |
| `executeDrag` | the source, then the destination, after its own scrolling and before `pointerReaches` and either way of dragging | act, act |
| `executeUpload` | the visible input or the chooser trigger; nothing for a hidden input, which has no box | act |
| `executeKeyboard` | `page.locator('*:focus').last()`, with `wait: false` | act |
| `executeRead` | the first match | read |
| `executeReadMultiple` | every match | read, `max: 20` |
| `executeCount` | what was counted, after counting, and only when the count is above 0 | read, `max: 20` |
| `readTableRecords` | the table element, through an optional third parameter: one ring, never one per cell | read, `max: 1` |

Notes on the less obvious rows:

- **Keyboard.** An open shadow root's host matches `:focus` along with the
  element focused inside it, and comes first in document order, so the last
  match is the inner one. Focus inside a frame rings the `<iframe>`, the
  deepest a page-level locator can name. With nothing focused nothing is
  drawn, though the mark is still requested. `wait: false` because an element
  focused after the keys went in is not what they went to.
- **Count.** It marks after the counts, which are this action, so a count of 0
  asks the page nothing.
- **readTable.** A caller of `readTableRecords` that passes no mark rings
  nothing.

**Why per handler rather than one call at the top of `executeAction`?** The top
knows only the root and the selector, and the handlers then change what they
act on. A hidden toggle clicks a different element (`clickInPlaceOf`). A drag
has a second target. An upload may fall back to a hidden input. Reads and
counts act on many elements. `singularTargetOf` knows the singular target, but
it runs only when `measure` or `ambiguousTarget: 'fail'` is on, and a hidden
toggle skips it. Ringing the selector rather than the element touched would
show the wrong element in exactly the cases the feature exists for.

**Rule: mark at the act, never in a probe.** Several helpers touch the target
without acting on it: iframe promotion's `count()`, the ambiguity count,
`uncoverForTyping`, `pointerReaches`, `waitForStableCount` and
`settleMatchCount`. None of them marks, which keeps one ring per action and
makes "every ring is an action" true. tests/highlight.test.ts pins it: an
ambiguity refusal marks zero elements, and iframe promotion never marks the
iframe.

**Not highlighted:** `wait` and `scroll` (they position or wait; the next
action rings the element), `navigate`, `find`/`expand`, AI-written assertion
JS, compiled conditions, and `extract_csrf`. Each is either not an interaction
with an element or a read for Steptix's own purposes.

### 2.3 The paths that bypass `executeAction`

**Login broker.** `LoginBroker.attemptLogin(page, hint, highlight)` passes the
sink to `typeInto`, which marks the field before focusing it, and to
`submitLogin`, which marks the submit control, or the field it presses Enter
in. The sink comes from `SessionManager.highlighterFor(sessionId)`:

- it resolves `session.browserConfig`, the project's `browser` section that
  the session's last batch retained, because a login has no test file to
  resolve a project from. A session that has run no batch carries the server's
  section, the same fallback every out-of-band read gets;
- it folds the session's `highlight` run setting over that with
  `switchHighlight`, so a session told `off` never rings a login and one told
  `on` does, whether or not a batch has run since;
- it answers `undefined` while `session.surface === 'computer'` (§6).

The broker's marks carry no `settled`, so they never wait for a late element.

**Code-behind entries and fixture tools.** `highlightingPage(page, sink)` in
src/browser/highlight-page.ts returns a `Proxy`. `runCodeBehindEntry` hands it
to the entry as `ctx.page` and wraps `ctx.tabs` and `ctx.browsers` with
`highlightingApi`, which wraps the pages their methods return, so
`await ctx.tabs.active()` is the same proxy as `ctx.page`. `executeToolStep`
wraps `ctx.page`. With the highlight off, both get the real objects.

- **What it wraps.** It recognises Playwright's `Page`, `Frame`, `Locator` and
  `FrameLocator` by constructor name, since the package exports their types but
  no values to test `instanceof` against. It wraps every one a method returns,
  including inside arrays and resolved promises, rather than a fixed list of
  factories. That covers `locator`, `getBy*`, `frameLocator`, `first`, `last`,
  `nth`, `filter`, `and`, `or`, `owner`, `contentFrame`, `mainFrame`,
  `frames()`, `page()` and `all()`.
- **What it marks.** Before `click`, `dblclick`, `tap`, `fill`, `type`,
  `pressSequentially`, `press`, `check`, `uncheck`, `setChecked`,
  `selectOption`, `hover`, `setInputFiles` and `dragTo` (act; `dragTo` marks
  its target too). Before `textContent`, `innerText`, `inputValue` and
  `getAttribute` (read). Before `allTextContents`, `allInnerTexts` and `count`
  (read, `max: 20`, no late wait). Before the Page and Frame selector
  shorthands (`page.click(selector)` and the rest) and `dragAndDrop`, on the
  first match, as the shorthands themselves act.
- **When the call settles.** Each wrapped call makes its own `settled`
  promise, settled when the call returns or throws. So a
  `try { click({ timeout }) } catch {}` for an optional banner does not ring
  the banner when it turns up later, unclicked.
- **What it must keep, and why.**
  - *Playwright's reads of its arguments.* `dragTo(target)`, `and(other)`,
    `or(other)` and `{ has: locator }` read `_frame` and `_selector` off the
    locator they are given. Arguments are unwrapped at the top level and one
    level into a plain options object, where `{ has, hasNot }` live, so
    Playwright never sees a proxy.
  - *`instanceof` and identity.* A proxy's prototype is its target's, and one
    target yields one proxy per sink (a WeakMap per sink), with its methods
    cached so `proxy.click === proxy.click`. `constructor` is returned
    unwrapped, so `proxy.constructor` is the class. Wrapping a proxy returns it
    unchanged, never a proxy of a proxy.
  - *No recursion.* Methods run on the target and marks are made on target
    locators, so neither Playwright's internal calls nor the ring's own
    `evaluateAll` pass through a proxy again.
  - *Steptix's own identity checks never see a proxy.* The tab and browser
    APIs take strings and functions, so nothing proxied reaches a
    `PageTracker` or `BrowserTracker`.

This is **best effort**, by decision (§13, decision 3). What escapes it:

- pages reached around it: `ctx.context.pages()`, `ctx.browser.contexts()`,
  and an `ElementHandle` from `locator.elementHandle()`;
- input with no element: `page.mouse` / `page.keyboard` at coordinates;
- acting inside the page: `page.evaluate(() => el.click())`.

Generated code rarely uses any of these: src/codebehind/entry-actions.ts
already classifies them as acting calls that the review pass watches.

A compiled `step.read` / `step.count` goes through `executeAction` like the
AI's read, with the sink from `RunCodeBehindOptions.highlight`, which the step
executor sets from the run's config (`highlightOption`).

**Rejected alternatives for the bypassing paths:**

- **Playwright's client instrumentation** (`connection._instrumentation`,
  `onApiCallBegin`) sees every API call on a connection, so it would cover
  everything. But it is private API, its callbacks are synchronous, it sees
  all of Steptix's own probes with nothing that tells a probe from an act, and
  selectors arrive in Playwright's internal form.
- **In-page event listeners** (capture-phase `pointerdown`/`input`/`change`
  via `addInitScript`) see no reads, miss the synthetic events of
  `selectOption` and `setInputFiles`, and cannot tell Steptix's input from the
  page's own synthetic clicks or a human using a headed window.

---

## 3. How to draw it without changing the page under test

### 3.1 The options

| Risk | A. Overlay host, closed shadow root, top layer | B. Style the element (`outline`/`box-shadow`) | C. CDP `Overlay.highlightNode` | D. Playwright `locator.highlight()` |
| --- | --- | --- | --- | --- |
| Layout shift | none: `position: fixed`, out of flow | none for `outline`/`box-shadow`, but clipped by `overflow: hidden` ancestors | none | none |
| Intercepting clicks | none with `pointer-events: none` (measured: clicks land, `elementFromPoint` answers the element) | none | none | none |
| Strict CSP | **works**: measured, 0 violations in all three engines with CSSOM + Web Animations, and with an adopted sheet under `style-src 'none'` | `style.setProperty` works, but it writes the element's `style` attribute | not subject to CSP | Playwright's own injection |
| Changes the page's DOM | adds one host under `<html>` (sibling of `<body>`) | **mutates the element under test**: attribute MutationObservers fire, a framework re-render can wipe it, restoring the old value races the page, and assertion JS reading `getComputedStyle` sees it | no | adds `x-pw-glass` under `<html>` |
| iframes, shadow DOM | free: the script runs in the element's own frame via `locator.evaluateAll` | free | needs a per-target session for out-of-process iframes | free |
| Scroll / move during the ring | one rAF loop re-reads `getBoundingClientRect` | follows automatically | static | follows |
| Element removed | ring removed on the next frame | goes with the element | stale box | stale |
| Navigation | goes with the document | goes with the document | cleared | goes with the document |
| Overlapping highlights | yes: one ring per element | yes | **no**: one highlight per target | **no**: one glass pane, no duration |
| Animation, styling | full | limited | colours only | none |
| Engines | all three | all three | **Chromium only** | all three |
| Covers modal dialogs and z-index-max headers | yes, top layer (measured in all three) | n/a | yes | yes |
| Supported use | ours | ours | DevTools protocol | Playwright documents it as "Useful for debugging, don't commit the code that uses" it (playwright-core types.d.ts, `highlight()`) |

### 3.2 Chosen: A

A is the only option that meets every constraint at once: all three engines,
overlapping rings, animation, no mutation of the element under test, and
strict CSP. It is also not new to this codebase: the recorder toolbar uses the
same construction for the same reasons (record-toolbar.js, `resetHost`).

B is rejected because it edits the element under test. C is Chromium-only and
cannot overlap. D cannot overlap, cannot time out, and its own documentation
says not to ship it.

### 3.3 The in-page controller (src/browser/scripts/highlight.js)

The file is one function expression, `steptixHighlight(elements, args)`, with
`args = { tag, key, kind, durationMs, colors, max, withHref? }`. `tag` and
`key` are `HIGHLIGHT_TAG` (`'steptix-highlight'`) and `HIGHLIGHT_REGISTRY_KEY`
(`'steptix.highlight'`) from highlight.ts, passed in so the two sides cannot
drift. Plain ES5-style JS rather than TypeScript, for capture-dom.js's reason:
no esbuild/TS helper such as `__name` may reach the page. Choices, each with
its reason:

1. **`evaluateAll`, not `evaluate`.** `evaluateAll` resolves the current
   matches and returns at once. `evaluate` auto-waits for an element, which
   would leave a dangling call waiting the full timeout when the element is
   gone. The script is passed as a **function**, not a string:
   `evaluateAll(string)` evaluates the string as an expression and never calls
   the function it yields. So `loadHighlightScript` builds the function with
   `new Function('return (' + text + ')')`, and Playwright serialises it back
   to the same text. The file is read on first use (`highlightScriptFn`), not
   at import: highlight.ts is reachable from `steptix/tools` through the tool
   executor's wrapper, and a project's tool file can be bundled with what it
   imports, so `import.meta.url` can be the bundle's own location with no
   scripts/ beside it. Reading at import made every tool in such a bundle fail
   to load (measured: tests/api-server-tools.test.ts, 15 failures).
2. **One host per document, created lazily.** The host is a
   `<steptix-highlight>` element appended to `document.documentElement`, made
   on the first ring and removed (`teardown`) when the last one retires. There
   is no `addInitScript`, so pages already open, CDP tabs and frames all work
   on first use. `controllerFor` finds an existing host by scanning the direct
   children of `<html>` for the tag **and** a handle whose `mark` is this
   script's own code (item 9); anything else is passed over and a host of
   Steptix's own is built.
3. **Host hardening.** `resetHost` follows the recorder's: per-property
   `setProperty(…, 'important')` of `all: initial`, `position: fixed`,
   `display: block`, a 0×0 box at the viewport's corner (`left: 0; top: 0;
   width: 0; height: 0`) with `overflow: visible`, zero margin, padding and
   border, `z-index: 2147483647`, `pointer-events: none`, and explicitly no
   `transform`, `filter` or `contain`, any of which would make the host the
   rings' containing block instead of the viewport. The host has
   `aria-hidden="true"` and **no** `id`, `class`, `role`, `aria-live`, `open`
   or text: those are what `DIAGNOSE_SCRIPT` (src/browser/page-state.ts) and
   the notice recorder (src/browser/notices.ts) look for.
4. **Top layer.** `popover="manual"` and `showPopover()` in a try/catch,
   falling back to the z-index alone. `mount` re-raises the host (hide, then
   show) when a ring is added while another `:modal` or `:popover-open`
   element exists, so it stays above a dialog the page opened after it. It
   re-raises on a mark, not continuously. Measured: a manual popover leaves the
   page's own `popover="auto"` menu open, and a modal dialog stays modal and
   keeps focus.
5. **Closed shadow root.** One adopted `CSSStyleSheet` holds the ring styles
   (§8), and rings are built with `createElement` and `setAttribute` only: no
   `<style>`, no style attribute, no `innerHTML`, so a strict CSP and Trusted
   Types have nothing to refuse.
6. **One ring per element.** A `WeakMap<Element, Ring>` lives on the
   controller. Marking an element that already has a live ring restarts it, in
   the new kind's colour, as the newest. Different elements get separate
   rings. Past `MAX_RINGS` (32) live rings, the oldest is retired.
7. **One rAF loop for all live rings.** `tick` repositions each ring from
   `getBoundingClientRect()`, outset by 3 px (`OUTSET`). A ring whose element's
   box is zero or entirely off screen gets `display: none`. A ring whose
   element is disconnected is retired on the next frame, with no fade: the
   test for it is then a condition (two animation frames), not a clock. Each
   tick also re-applies the hidden state, because a hide entry can lapse with
   no call to say so (§4.3), and stamps `Date.now()` on `<html>` under
   `Symbol.for('steptix.highlight.tick')`: the hide's paint wait reads it to
   tell a document Chrome is drawing from one it is not (§4.3 rule 2). The
   loop stops with the last ring.
8. **Timing lives in the page, as Web Animations.** `rec.node.animate(frames,
   { duration: durationMs, easing: 'linear', fill: 'forwards' })`, and the
   envelope animation's `finished` retires the ring. Web Animations give the
   controller an `Animation` object to restart, finish and await; a CSS
   animation would need class toggling and `animationend` listeners. The page
   runs no `setTimeout`.
9. **A registry handle, for tests.** `host[Symbol.for('steptix.highlight')] =
   { mark, rings(), hide(token?), restore(token?), finishAll() }`. `rings()`
   reports each live ring's kind, box, whether it is on screen and hidden, its
   computed border width (what proves the sheet applied under a strict CSP),
   and which properties its envelope and glow animations move. A ring inside a
   closed root is invisible to `document.getAnimations()` (measured), so there
   is no other deterministic way in. **Steptix's own hide, restore and end
   never call the handle**: they write the document directly (`onRegistry`,
   §4.3), because a page can replace the handle's methods with ones that never
   return.

   **The forged-host check.** `isOwnCode(handle.mark)` takes a handle only if
   `Function.prototype.toString` of its `mark` is longer than 200 characters
   and is a substring of `steptixHighlight`'s own source. A page's own
   `<steptix-highlight>`, or one forging the handle, fails it and is never
   handed the elements being ringed.

   **What a hostile page can still do, honestly.** The script runs in the
   page's main world, the same JavaScript world as the page's own scripts. So
   a page can find the host and the handle, hide or end Steptix's rings, forge
   a host of its own, and observe which element is being ringed through a
   patched `getBoundingClientRect` or `animate`, if nothing else. The
   forged-host check closes the cheapest way to see the targets, not every
   way. A page can also break the hiding: it can overwrite the handle on
   Steptix's own host, so that the hide and the DOM snapshot's skip no longer
   recognise it, or patch `Date.now`, which the lapse of a hide entry reads,
   so entries lapse early or never. There is no clock in the main world that
   the page cannot replace. The paint wait in a hide or end (§4.3 rule 2)
   calls the changed document's own `requestAnimationFrame`, `setTimeout`
   and `Date.now`, also when it is asked through its parent. A page that
   replaces them can end the wait before the paint, and a capture may then
   show that frame's ring; or it can keep the wait from ending, and the frame
   then counts as not landed (§4.3 rules 5 and 6).
   Hostile pages only: documented, not defended.
10. **No box, no ring.** A hidden file input or a `display: none` toggle has a
    zero-size box and draws nothing. `max` counts rings **drawn**, not
    elements looked at, so a read of every match whose first twenty are hidden
    still rings the visible ones.
11. **Each ring is two elements, so the fade runs on the compositor.** The
    outer `.ring` is the envelope: it is placed, has `will-change: opacity,
    transform`, and its one animation moves only opacity and transform (the
    draw-in, the hold and the fade to 0). The inner `.glow` carries the
    border, the halo layers and the `box-shadow` pulse. The reason is
    measured: `box-shadow` cannot run on the compositor, so a one-element ring
    that animated it ran its whole animation, fade included, on the main
    thread, and a page that blocked its main thread froze the ring at full
    strength past any lifetime. With the split, a blocked page freezes only the
    glow, and the envelope still reaches opacity 0 on schedule. Chromium, an
    out-of-process iframe busy for 8 s, a raw CDP grab after the ring's
    lifetime: 1991 blue-dominant pixels with one element (the ring), 111 with
    the split (the clean page counts 111). A blocked main frame, read from the
    display compositor's own frames, behaves the same headless and headed. Not
    measured in Firefox and WebKit, which both run opacity and transform Web
    Animations off the main thread but could not be observed while blocked
    (§12).
12. **What it answers.** The number of rings drawn, for tests. With
    `withHref`, which the sink always passes, `{ drawn, href }`: the URL of the
    document that drew, which Node uses to find the frame when the locator
    enters a frame (§4.3).

---

## 4. Keeping Steptix's own reads clean

### 4.1 What reads the page, and what each does with the overlay

| Reader | How it reads | Sees the overlay? | What keeps it clean |
| --- | --- | --- | --- |
| DOM snapshot for the AI (`captureDomSnapshot` → capture-dom.js) | walks **every child of `<html>` except `<head>`** (SPEC-web-survey-fixes §2.48) | it would: the prototype measured one `<steptix-highlight>` line | the top-level loop skips Steptix's host (below) |
| Stall detection (`pageFingerprint`, step-executor.ts: URL plus snapshot) | the snapshot above | would, via the snapshot | the same skip |
| Failure diagnosis (`diagnoseFailure`, src/ai/diagnose.ts) | snapshot + screenshot | would | the skip, plus §4.2 |
| `find` / `expand` (find-in-dom.js) | walk from `document.body` or a stamped element | no: the host is not under `<body>` | nothing |
| `locateTexts` (src/browser/locate-text.ts) | `body` descendants | no | nothing |
| `captureVisibleText` | `document.body.innerText` | no | nothing |
| `DIAGNOSE_SCRIPT` (page-state.ts) | `document.querySelectorAll('*')`, leaf text and modal selectors | matched but inert: no text, role or class | the bare host (§3.3 item 3) |
| Selectors, `count`, `read` (Playwright locators) | pierce **open** shadow roots only | `body …`, text and role selectors: no. `*` and `html > *` match the host. | accepted residual (§12) |
| Covered-element detection | Playwright's hit-target check and `pointerReaches` (`composedPath`) | no: `pointer-events: none` elements are not hit-tested | nothing |
| Settle waits (`domQuiesceScript`, `wait stable`, `FINGERPRINT_SCRIPT`) | observe or read `document.body` | no: the host's mutations are on `<html>` | nothing. The quiesce observer falls back to `documentElement` only when there is no `<body>`. |
| Notice recorder (src/browser/notices.ts) | observes the whole document, keeps only `role` alert, status or log, `[aria-live]` and `output` | ignored | the bare host |
| Recorder (record-steps.js, record-toolbar.js) | event targets via `composedPath()[0]`; the toolbar re-raises itself above any new top-layer element | a `pointer-events: none` host is never a target; the toolbar may re-raise above a ring, which is harmless | crops are hidden (§4.2) |

**The skip, exactly.** capture-dom.js's `isHighlightHost(el)` is true for an
element whose lower-cased tag is the highlight tag **and** which carries the
registry handle (`el[Symbol.for('steptix.highlight')]`). It is applied in the
top-level loop over `<html>`'s children only, which is where Steptix's host
lives. A page's own `<steptix-highlight>`, nested or at the top level without
the handle, is the page's, and the AI reads it like any other element. The tag
and key reach the script as `__HIGHLIGHT_TAG_JSON__` and
`__HIGHLIGHT_KEY_JSON__`, substituted by `buildDomCleanerScript`
(src/browser/dom-cleaner.ts) from the same constants highlight.js is handed.
capture-dom.js does not skip the recorder's hosts and should not start to:
those are removed before a run, and widening the skip is a separate decision.

### 4.2 Screenshots: who each one is for

There are two audiences, and `captureScreenshot(page, fullPage, audience)`
takes which one (`ScreenshotAudience`, src/browser/screenshot.ts):

- **`'report'`, the default: show the rings.** The report, its filmstrip, a
  step's end and failure pictures. The ring is the point there: a filmstrip
  frame that rings the element just clicked answers "what did step 4 click?"
  without reading the log. It goes through `hiddenForReport`, which hides only
  when the last highlighter to draw on that page had `inScreenshots: false`.
- **`'model'`: never show them.** Anything a model reads goes through
  `hiddenFor` (§4.3). A ring left from the previous action would be page state
  the page does not have, and the prompt tells the model to "use it to
  understand the current visual state of the page" (src/ai/prompts.ts).

The video is not a capture, and always shows the rings.

**The run's own config decides a report capture's audience.**
`reportAudience(config.browser)` answers `'model'` when
`browser.highlight.inScreenshots` is `false`, whatever `enabled` says, and
`'report'` otherwise. Every report capture site that has the run's config
passes it: the pre-turn capture when `ai.sendScreenshots` is off, the
post-action filmstrip, step-end and failure captures and the code-behind
step's end capture in step-executor.ts, test-runner.ts's failure screenshot,
session-manager.ts's report captures, the interactive REPL
(src/runner/interactive-repl.ts) and the Runner UI (src/ui/main/runner-adapter.ts).
Why the run decides rather than the last highlighter alone: a batch whose
pictures go to an agent must hide a ring that `log_into_site` drew, to be
shown, a moment earlier.

**Runs whose report pictures go to a model.** `ringsOutOfScreenshots(browser)`
returns the section with `inScreenshots: false` written in. With the highlight
off it writes `{ enabled: false, inScreenshots: false }` rather than leaving
`false`: the run draws nothing, but a ring another caller drew on the same page
must still stay out of its pictures, and `reportAudience` reads the switch
whatever `enabled` says. It is applied to:

- **errands** (`ErrandRunner`, its `runConfig`): an errand writes no report,
  and its receipt hands its pictures to the agent;
- **CLI compile runs** (`createTestFileRunner`, src/codebehind/compile.ts):
  `buildRepairPrompt` sends the repair model a compile run's failure
  screenshot, which is a report capture;
- **any batch with `screenshotsToModel: true`** (`StepRequest`,
  session-manager.ts), below.

**`screenshotsToModel`.** `run_steps` and `run_test_file` can return a step's
screenshot to the agent (`screenshots_return`), and that picture is the
report's. The MCP client decides `screenshots_return`, so the server cannot
know at capture time; the client therefore sends `screenshotsToModel: true` on
the steps request whenever `screenshots_return` is not `none` (the default
`on-failure` included), and the server runs that batch through
`ringsOutOfScreenshots`. The server's compile runner (`CodeBehindCompiler`,
src/server/compile-runner.ts) sends it on its own steps requests, for the
repair model. It is per request and not retained, unlike run settings: it says
who reads this batch's output, and the next batch on the session may be a
person's. `get_last_run` returns what such a batch stored, so it needs nothing
more.

**Every capture whose image goes to a model:**

| Capture | How |
| --- | --- |
| The acting model's pre-turn capture, and the branched-step poll, when `ai.sendScreenshots` is on | `'model'` |
| The assertion-code capture and the condition judge's capture (taken only for the model) | `'model'` |
| Failure diagnosis (`diagnoseFailure`) | a fresh `'model'` capture; falls back to the step's own picture only for a page `pageEverRinged` says was never ringed, since that picture was taken for the report. Otherwise the model gets no image. |
| `GET /sessions/:id` (what MCP's `get_page_content` and `peek_tab` of a session tab read) | `'model'` |
| The raw-CDP tab peek (`GET /cdp/browsers/:port/tabs/:targetId/content`, `captureTabScreenshot`) | `hiddenFor(…, { force: true })` (§4.3) |
| An errand's two explicit failure captures | `'model'` |
| Errands, compiles, `screenshotsToModel` batches | every capture, through `ringsOutOfScreenshots` |
| Recorder crops (src/recorder/step-recorder.ts), sent to a model with the target outlined in red | `hiddenFor` |
| `[use computer]`'s screen grab | `endRings` first (§6) |

With the highlight off nothing is ever recorded, so every one of these takes
its picture directly, as before, except the CDP tab peek. Its forced hide
always asks every frame, with the 500 ms budget (§4.3 rules 3 and 13). A
frame in the page's process that Playwright reports no address for is asked
through its `<iframe>` element in the parent.

**`inScreenshots: false`** (§7.1) is for people who diff report screenshots or
reuse them in docs: report captures then hide the rings too. The model side is
not configurable.

**Could a report picture mislead?** A ring sits on top of the page, so a
reader could take it for the page's own focus ring or a validation state; the
style (§8) is chosen to look like neither. The post-action settle
(`waitForPostActionSettle`) lands roughly 0.6–1.5 s after the action, so the
ring is usually captured at full strength, but the phase is not deterministic
and the same run can show a slightly different glow. That is acceptable for a
picture, and it is why the feature is opt-in.

### 4.3 Hiding: how `hiddenFor` and `endRings` decide

The goal is a hard one: a capture a model reads must not show a ring, even when
the page is busy, the ring is in a cross-origin frame, two Playwright Page
objects drive one tab, or another process drew it. A raw CDP grab
(`captureTabScreenshot`) and `[use computer]`'s `screen.grab()` do not wait for
frames, and a busy cross-origin frame keeps showing its last painted frame,
ring and all. The rules below are the result of many review rounds (§16); each
one carries its reason.

**Records.** highlight.ts keeps, at module level rather than per highlighter,
because the executor builds its action options per action and the ring a step's
last click drew is still up for the next step's first capture:

- per Page (`ringsOn`, a `PageRecord`): `until` (the latest ring's end on our
  clock), `inScreenshots`, `frames` (a `Map<Frame, until>` of frames that
  drew), and `inFlight` (draws sent and not yet answered);
- per CDP connection: `endpointOfBrowser` (Browser → endpoint, e.g.
  `localhost:9222`) and `browsersAt` (the connections still open to each
  endpoint), filled by `registerCdpBrowser` from `connectOverCdpSession`;
- per CDP tab (`tabRecords`, a `TabRecord` keyed by endpoint and target
  id): `until` (the latest ring's end) and `drawing` (draws on the tab not
  yet answered);
- `pendingAt`: target-id lookups in flight for a ring just drawn, per
  endpoint;
- `detaching`, a `WeakSet` of Pages whose owner said they are disconnecting
  from tabs that stay open (`pagesDetaching`, called by `closeBrowser`);
- `everRinged`, a `WeakSet` of every Page a ring was ever drawn on or asked
  for, never cleared, read only by `pageEverRinged` (§4.2's diagnosis row).

**Stamping.** `mark` stamps the record before the draw is even sent, so a
capture racing the draw already hides, and again when the draw lands, so a
ring that landed late is hidden for its whole life. Each stamp is `now +
durationMs + RING_CLOCK_MARGIN_MS` (1 s, for the frames between the page
drawing and the clock reading). A run with the highlight off never stamps, so
it never pays.

**The gate: free when nothing of ours may show.** `ringRecordFor` looks no
further than the page's own record unless the page is on a registered CDP
endpoint that has a tab record or a lookup in flight (`tabRecordOf`); a page
anywhere else never looks a target id up. `hiddenFor` calls `fn` directly,
with no round trip, only when nothing may show: no `until` still ahead, no
held frame, no draw in flight on the page and no record for its tab
(`viewMayShow`). That is what lets every model-bound capture go through `hiddenFor`
whatever the config says. A page "may show" a ring of ours (`viewMayShow`)
while its `until` has not passed, a draw is in flight, a frame is still held,
or its tab has a record.

**Rules.**

1. **One hide entry per capture, on `documentElement`.** Each capture gets a
   random token and writes `entries[token] = Date.now() + HIDE_LAPSE_MS` under
   `Symbol.for('steptix.highlight.hidden')` on the frame's `<html>`, on the
   frame's own clock (rule 2). The restore removes its own entry, and the host
   is visible only while no live entry remains. Entries rather than a flag, so two overlapping captures (a
   `GET /sessions/:id` during a batch's own model capture) cannot show the
   rings to each other; on the document rather than the host, so a host built
   while a capture holds them hidden starts hidden. An entry lapses after
   `HIDE_LAPSE_MS` (60 s, equal in highlight.ts and highlight.js) in case its
   restore never lands: a frame that stopped answering, or a navigation that
   left the hidden document in the back/forward cache. 60 s is above the
   longest capture (Playwright's screenshot gives up at 30 s, a tab peek at
   15 s), so no capture outlives its own entry.
2. **The write is inline and synchronous. The only page code it calls is
   the paint wait's.**
   - `onRegistry` is one evaluation (`registryCall`). It runs in the frame
     itself (`frame.evaluate`), or, for an in-process frame with no address,
     on its document through the frame's `<iframe>` element in the parent
     (rule 3).
   - It writes or removes the entry, and sets each Steptix host's
     `visibility` with `setProperty(…, 'important')`; `'end'` removes the
     hosts.
   - It identifies Steptix's hosts by tag and registry symbol, and never
     calls the handle.
   - **A hide or an end then waits for the document to paint the change**:
     two animation frames, or `PAINT_WAIT_MS` (200 ms) at most. A screenshot
     composites an out-of-process frame's last painted picture. A hide that
     had landed in the DOM but not yet been painted showed the whole ring in
     3 of 8 captures 1.4 s after a click, through Steptix's own launch
     (review24/oopif-stale.mjs). It waits only when all three of these hold:
     - **A Steptix host is there.** With no host there, nothing waits. A
       hide waits whenever there is one, even one an overlapping capture
       has already hidden, because that capture's change may not be painted
       yet.
     - **It is an end, or a hide in a frame other than the main frame.** A
       capture (`page.screenshot`, the peek's `Page.captureScreenshot`)
       draws the main document afresh, so a hide there is in the picture
       once it has landed. An end is followed by a grab of the screen
       (`[use computer]`, rule 14), which draws nothing new, so it waits in
       every frame. A child frame in the page's own process may not need
       the wait either, but it is not told apart from an out-of-process
       one, so it waits.
     - **The document is being drawn**: its ring controller ran an animation
       frame within `DRAWN_WITHIN_MS` (100 ms), read from the stamp each one
       leaves (§3.3 item 7). Chrome runs no animation frames in a document it
       is not drawing, such as a cross-site frame scrolled out of view, and a
       capture shows nothing of it. Waiting there cost every capture the
       whole 200 ms for as long as the ring stayed up (review25/offpersist.mjs,
       §16.16).
     - The stamp is also stale where a capture does draw, and each case is
       safe for its own reason, measured rather than argued:
       - **A background tab** runs an animation frame every 1–2 s, so a hide
         there usually skips the wait. The capture itself makes Chrome draw
         the tab afresh, the hide included: `page.screenshot` waits for a
         new frame, and the peek starts a screencast first. bg-oop.mjs, a
         background tab and a minimized window, model capture and peek, a
         ring in an out-of-process frame, the main frame or both: 0 ring
         pixels in every run.
       - **A frame scrolled back into view** is stale until its first
         animation frame. Chrome keeps no picture of a frame it stopped
         drawing (a full-page capture shows none of an out-of-view frame,
         offscreen.mjs), and it runs the controller's animation frame, which
         applies the entries, before it draws the frame again.
         review26/scrollin.mjs, a capture straight after the frame came
         back: 0 of 130 showed the ring in the review's runs, and 0 of 80
         here (model capture through launched Chromium, CDP and Steptix's
         launch, and the peek, 20 each), most with the wait skipped on a
         stamp about 700 ms old. A picture taken at that moment with nothing
         hidden showed the ring in 10 of 10.
   - **Every clock reading is the changed document's own** (its window's
     `Date.now`): the stamp's age, the entry's lapse time and which entries
     are live. That document's controller stamps its frames and lapses its
     entries on that clock. Through the parent (rule 3) the call runs in the
     PARENT's realm, and a parent whose `Date.now` is shifted (a page
     correcting for server time) made the hide misjudge both, on 6762bc15:
     - 5 s ahead, every hide there took the stamp as stale and skipped the
       wait: 21 of 200 CDP captures and 8 of 80 launched ones showed the
       whole ring (review26/skew-stale.mjs; 0 of 200 on 37eff1f8, which
       always waited).
     - 70 s behind, the entry it wrote had already lapsed on the frame's
       clock, and the controller showed the host again on its next frame:
       40 of 40 (and 20 of 20 on 37eff1f8, where this began).
   - The wait calls the document's own `requestAnimationFrame`, `setTimeout`
     and `Date.now`, which a page can replace (§3.3 item 9).
   - A restore does not wait: showing late is harmless.
   - Beyond that wait, it awaits nothing in the page, so a planted host
     cannot hold a capture up.
   - It answers whether a Steptix host is still under `<html>` after the
     call; `'probe'` only answers.
   - With no host and no ring of ours known to be up, a hide writes nothing
     at all on the page, so a forced peek leaves no trace on a tab Steptix
     never drew on.
   - A frame runs its evaluations in the order they were sent, so a restore
     never lands before its own hide.
3. **Every attached frame is asked** (`framesToAsk`), each in the way that
   cannot hang.
   - **A frame whose address reads `''` or `':'` is one Playwright reports
     no address for.** That covers three cases:
     - **No document of its own yet:** a `loading=lazy` iframe below the
       fold, or a response that never arrives.
     - **A live document in the page's process:** a `javascript:false` or
       `javascript:void(0)` iframe the parent fills (a common ad pattern),
       or a frame left on its initial document by a 204 or a download.
       Playwright never reports a `javascript:` navigation.
     - **A cross-site frame that loaded before a CDP attach.**
   - An evaluation inside the first kind waits for a document that may
     never come. Treating every no-address frame as document-less (65d0cd98)
     left rings in the second kind unhidden: 3300–4100 ring pixels on
     launched Chromium, CDP, Firefox and WebKit (review23/docless.mjs).
   - **Out of process (the third kind): asked itself.** Only an
     out-of-process frame gets a CDP session of its own (`outOfProcess`).
     For an in-process frame Playwright refuses one at once, with no browser
     round trip: "This frame does not have a separate CDP session". Each
     Frame is asked once and the answer cached. A check that does not answer
     within 1 s counts as out of process.
   - **In the page's process (the first two kinds): asked through its
     `<iframe>` element in the parent** (`frame.frameElement()`, looked up
     once per Frame, `parentRoute`).
     - The lookup runs on the parent's main thread, so a busy parent answers
       it as late as its busy spell (1931 ms during a 2 s block,
       review24/fe-busy.mjs). A lookup still pending after 1 s keeps the
       frame asked, its call chained on the lookup, so the frame counts as
       not landed, and rules 5 and 6 wait for it.
     - Only a rejected lookup (the frame went away) skips the frame.
     - The handle is disposed when the frame detaches (`disposeOnDetach`).
       An ad slot that replaced its `javascript:` iframe 200 times kept 200
       elements alive (review24/handles.mjs); it now keeps the 1 attached.
     - From the parent, the frame's `contentDocument` is reachable:
       `javascript:` and initial documents share the parent's origin. The
       same registry call (`registryCall`) hides, restores, ends or probes
       that document's hosts without entering the frame's own context, so a
       lazy frame cannot hang it. A lazy frame's empty initial document
       answers "no host" at once, and does not hold up confirmation.
   - Measured on a Page attached after load, Chrome with
     `--site-per-process` (review21/signal.mjs):

     | Frame | `url()` | Own CDP session | Evaluate in its own context |
     | --- | --- | --- | --- |
     | cross-site iframe | `''` | yes (2.9 ms) | answers (4 ms) |
     | lazy iframe below the fold, same-site and cross-site | `':'` | no (0.6 ms) | no answer in 2 s |
     | iframe whose response never arrives | `':'` | no (0.6 ms) | no answer in 2 s |
     | same-site iframe | its URL | no | answers |
     | `about:blank` iframe | `about:blank` | no | answers |

   - **On a page not attached over CDP**, every no-address frame is in the
     page's process and is asked through its parent.
   - A frame whose element lookup was rejected (detached meanwhile) is
     skipped, and any held entry for it is dropped
     (`forgetFramesWithoutDocument`).
   - When no ring of ours may be up, each frame gets `TOGGLE_TIMEOUT_MS`
     (500 ms), and the capture goes ahead regardless.
4. **Frames that drew are held as Playwright Frame objects.** When a draw
   lands, `framesThatDrew` records the locator's own frame (Playwright's
   `_frame`) when the locator does not enter a frame. One that does
   (`frameLocator(…).locator(…)`) is matched by the `href` the draw answered
   with, and every frame at that address is held; if none is there any more,
   every frame from the locator's own down. A Frame keeps its identity across
   `pushState`, a hash change and a navigation, where an address-keyed entry
   was orphaned by them: the frame was then treated as never having drawn, and
   nothing could clear the entry. A detached frame drops out of the record.
5. **A draw on its way counts as a ring of ours.** `trackDraw` counts each
   draw from the moment it is sent until it answers or fails, on its page and,
   for a Page on a registered CDP endpoint, on its tab. While one is in flight a capture hides with
   `ours = true`, so its entry is written before any host exists and a host
   built during the capture starts hidden, and each frame's hide **must land**,
   up to `MAX_HIDE_WAIT_MS` (15 s), with no escape on the clock: that ring has
   not started, so no lifetime of it has passed. Draws are read as the wait
   goes, not once at its start: when every draw on the page or tab has
   settled, the frame's wait falls back to rule 6, so a draw that lands early
   does not leave a busy frame's wait at 15 s. A page that cannot tell its
   tab (rule 9) waits on every draw in flight on its endpoint. The reason was measured: a
   keydown handler that blocked for 5.5 s queued the draw behind it past the
   pre-draw stamp, and the capture after the act skipped the hide and caught
   the ring as it landed, 1–3 times in 6 runs. Now 12 of 12 are clean.
6. **Otherwise each hide is awaited until it lands or the ring's lifetime has
   passed** (at least 500 ms, at most 15 s): the frame's own held time if it
   drew, else the page's `until`. A timer can fire a little before the clock
   reaches the lifetime (3 of 400 did, review23/early.mjs). When it does, the
   remainder is waited too, so the edge does not cost a picture. If neither holds for any frame, `hiddenFor`
   throws `RingsNotHiddenError`; `captureScreenshot` catches it and returns
   `null`, as for a failed capture, and the tab peek answers its failure
   status. Better no picture than one with a ring. "Lifetime passed" is
   enough because of the compositor fade (§3.3 item 11): a ring that painted
   before its frame blocked is at opacity 0 by then; a ring that had not
   painted is not on screen while the frame stays blocked; `page.screenshot`
   waits for the frame, and the hide sent before it lands first; and any later
   capture still hides, because of rule 7.
7. **The page's answer decides, not the clock.** A frame's held entry is
   dropped only when that frame answers that no Steptix host is left (the
   controller removes its host when its last ring retires), or when the frame
   is gone. Never because a clock says the lifetime passed. The reason was
   measured: a frame that blocks straight after the draw's task, before the
   next paint, starts its Web Animation only when it unblocks, and shows the
   ring for a whole `durationMs` from then. When an answer landing after the
   lifetime was enough to drop the entry, that answer landed on unblock and
   the next model capture skipped the hide: 1153 ring pixels in 3 of 3 runs.
   Now that capture shows the clean page (65), while a raw grab of the same
   moment still shows the ring.
8. **Each page that drew confirms its own frames after the ring.**
   `confirmWhenOver` schedules a `'probe'` of each held frame once its ring is
   due, and drops each frame that answers "no host". A frame that still has a
   host is asked again after `CONFIRM_RETRY_FIRST_MS` (1 s), doubling to at
   most `CONFIRM_RETRY_MAX_MS` (30 s), at most `CONFIRM_RETRIES` (10) times:
   11 probes in all. Each probe has the 500 ms budget, and a frame that does
   not answer within it is not clear and is asked again. While the page's tab
   has a record (rule 9), the same
   rounds probe every frame of the tab, and one in which every frame answers
   "no host", with no draw on the tab in flight, ends the record. A page on a
   registered endpoint schedules this once each draw has answered, drawn or
   not, so a mark that found nothing still has its tab confirmed. The timer is
   `unref`'d and cleared on close. Without this,
   a page that drew and was then left alone (an MCP session between batches)
   kept its records, and every other session's model capture in the process
   kept paying a target-id lookup for it. The page's own captures keep asking
   either way.
9. **Other Page objects on the same tab.** Two Playwright Page objects can be
   one browser tab only when both are connected over CDP to the same browser:
   an errand's attach and a session's on one CDP tab. Every connection
   Steptix makes goes through `connectOverCdpSession`, which registers its
   Browser with its endpoint (`registerCdpBrowser`). A Page whose Browser is
   not registered (a launched browser, Firefox, WebKit) keeps its own record
   and nothing else: it never looks a target id up and never consults a tab
   record. So highlight-off pages in any other browser pay nothing, ever.

   A ring drawn through a registered Page is also recorded for its tab, keyed
   by endpoint and target id (looked up once per Page: `lookUpTargetId`,
   `newCDPSession` and `Target.getTargetInfo`, the question
   `resolvePageTargetId` in manager.ts asks). **While the record exists,
   every Page on the tab holds every frame**, the drawing Page included. A
   capture there hides with a ring of ours known to be up, each frame's hide
   awaited until it lands or the record's `until` has passed (rule 6), and
   an end gives each frame its grace (rule 14).

   A capture waits for lookups still in flight on its endpoint. A lookup is
   bounded at `TARGET_ID_WAIT_MS` (1 s), because attaching to a busy tab
   takes as long as the busy spell. A page whose lookup has outrun the budget
   once answers null at once until the lookup lands (`slowLookups`).
   - **A page that cannot tell its tab holds every frame.** When its lookup
     failed or ran out of time while its endpoint has records, it may be on
     any of those tabs. It holds every frame as if its tab had the record,
     with the latest of their lifetimes, and it confirms nothing. Counting it
     as "no record" left a ring unhidden while the tab was busy: a lookup took
     2756 ms, and the capture showed 1683 ring pixels in 3 of 3 runs
     (review19/busy.mjs); now 0.
   - **A lookup also drops records of tabs that are gone.** While its
     endpoint has records, the lookup asks the same session for
     `Target.getTargets` and drops every record of that endpoint whose tab
     no longer exists (`dropRecordsOfClosedTabs`). A tab the user closed,
     with no Steptix Page on it that had looked it up, then costs the next
     new Page on the endpoint one lookup, not every one
     (review20/userclose-real.mjs: 1, 0, 0).
10. **A tab record ends three ways, and only three.** No timer and no clock
    decide it:
    1. **Confirmed clear.** A capture (`confirmTab`) or a confirmation round
       (rule 8) through ANY Page on the tab finds every frame free of our
       hosts, with no draw on the tab in flight.
       - Every frame must answer. One that cannot answer within its budget
         is not clear.
       - No ring may have been stamped on the page or its endpoint while the
         round ran (`countMark`, `marksOf`). A draw that starts and lands
         during a round could otherwise be missed by answers that predate
         it. That was measured: 1877 ring pixels in 3 of 3 runs
         (review19/stale-real2.mjs); now 0.
       - Such a round confirms nothing, and the next round asks again.
       - The same check guards a frame's own entry.
    2. **The tab closed.** Steptix's own teardown closes it: any close of a
       Page that its owner did not mark with `pagesDetaching` is its tab
       closing (`forgetPage`), which covers `page.close()`, a context or
       browser closed, and `closeBrowser` on a launched session or on the tab
       an attach opened. `closeBrowser` on a CDP attach calls
       `pagesDetaching(…)` for every page of the connection before it
       severs it, which is how an errand hands a session's tab back; that
       close leaves the record alone. Nothing is read from connection state:
       on a CDP detach the Page's `close` fires while its Browser still
       reports connected.
    3. **Nobody can capture it any more.** The last connection to the
       endpoint disconnects (`browsersAt`).

    Why this is enough: a ring of ours can be on a tab only after a draw
    through a registered Page on it, which made the record before the draw
    was sent (the pre-draw stamp, with `pendingAt` covering its lookup).
    Every Page that could photograph that tab is on the same endpoint, finds
    the record, and hides until one of the three ends. End 1 means nothing of
    ours is on the tab, end 2 means there is no tab, and end 3 means no Page
    is left to photograph it. A host that never retires, on a tab a detached
    errand drew on, therefore stays hidden from every model capture through
    any Page for as long as it is there.

    Earlier designs (`departed`, `orphaned`, `heldUntil`, hold timers,
    sole-drawer exemptions, §16.11) bounded the record on a clock instead,
    and each one either dropped a live record or held a dead one.
11. **A ring stamped while a picture is taken.** After `fn`, `hiddenFor`
    checks whether a ring was stamped where the picture can see it
    (`stampedMeanwhile`). If one was, it discards the picture and takes it
    again through the hide, once in all.
    - **"Where the picture can see it"** means on this page, or on another
      Page of its own tab. A stamp elsewhere on the same CDP browser counts
      only once this page's tab is found to have a record, or cannot be told.
      Without that, a highlight-off capture was retaken whenever another tab
      drew: 20 viewport shots became 32, and a full-page run went from 8.6 s
      to 17.4 s (review21/retake.mjs). Now it is 20 and 20.
    - **When `fn` ran with nothing hidden:** a capture racing a mark on the
      same page leaked in 3 of 6 runs (review19/race.mjs); now 0 of 30.
    - **When `fn` ran on the hide path:** a ring drawn in a frame attached
      or committed after the hide went out leaked in 6 of 6 runs
      (review21/newframe-det.mjs); now 0 of 6.
    - `fn` may therefore run twice. Steptix's `fn` is always a screenshot.
12. **Restore.** After `fn`, every frame asked is sent its restore.
    - Where the hide landed, the restore is waited on, within the 500 ms
      budget.
    - Where the hide did not land, the restore is not waited on: a frame runs
      its evaluations in order, so the restore lands after its hide whenever
      that does.
    - A restore where nothing was hidden does nothing.
13. **The forced peek.** The CDP tab peek attaches a Page of its own, which
    has no record of rings a session drew, and the ring may be another
    process's altogether (a CLI run on the same CDP browser), so `force: true`
    always asks every frame (rule 3). With no ring of ours
    known on the tab
    it gives each frame 500 ms and goes ahead: the cross-process residual
    (§12).
14. **`endRings(pages)`, for `[use computer]`.** For each page that may show a
    ring, it cancels the late-element waits pending there (§5.5), waits up to
    15 s for draws in flight so none can build a host after the end, then
    sends `'end'`, which removes every Steptix host. A frame that drew gets its
    ring's lifetime plus `END_GRACE_MS` (2 s), capped at `MAX_HIDE_WAIT_MS`
    (15 s); any other frame, until the
    page's `until` (at least 500 ms, at most 15 s). Then it goes on, logging
    at debug, because the screen grab that follows cannot be withheld and a
    frame that does not answer by then is usually held by a modal (a print
    preview, an alert) that covers the page anyway. In Chromium the ring has
    already faded by then (rule 6). A frame that did not answer stays held, so
    every capture after it still asks.

| Constant | Value | Where |
| --- | --- | --- |
| `HIGHLIGHT_MANY_MAX` | 20 | highlight.ts |
| `MAX_RINGS` | 32 | highlight.js |
| `OUTSET` | 3 px | highlight.js |
| `RING_CLOCK_MARGIN_MS` | 1 000 | highlight.ts |
| `LATE_RING_WAIT_MS` | 5 000 | highlight.ts |
| `TOGGLE_TIMEOUT_MS` | 500 | highlight.ts |
| `MAX_HIDE_WAIT_MS` | 15 000 | highlight.ts |
| `END_GRACE_MS` | 2 000 | highlight.ts |
| `HIDE_LAPSE_MS` | 60 000 | highlight.ts and highlight.js |
| `PAINT_WAIT_MS` | 200 | highlight.ts (sent to the page) |
| `DRAWN_WITHIN_MS` | 100 | highlight.ts (sent to the page) |
| `TARGET_ID_WAIT_MS` | 1 000 | highlight.ts |
| `CONFIRM_RETRY_FIRST_MS`, `CONFIRM_RETRY_MAX_MS`, `CONFIRM_RETRIES` | 1 000, 30 000, 10 | highlight.ts |

---

## 5. Timing

### 5.1 Steps never wait for it

`mark` returns `void`. Inside, it calls `locator.page()` and stamps the
record, then starts `drawRingsAt(…)` (`locator.evaluateAll`) without awaiting
it. The evaluate is issued just **before** the act, so the ring appears as the
action happens, and Playwright handles the two protocol calls concurrently.

Failures are caught and logged once per page at debug level (`noteOnce`): a
detached frame, a context destroyed by the navigation the click started, or a
page that tampered with `attachShadow`. A ring must never fail a step.

**Cost, measured** on SecureBank's sign-in page in headless Chromium, 40
repetitions per action, two alternating rounds with the highlight off and on,
medians in milliseconds:

| action | off | on |
| --- | --- | --- |
| type | 30.2–30.7 | 30.9–32.5 |
| click | 35.8–42.5 | 40.6–41.8 |
| read | 5.3–5.4 | 6.5–7.2 |
| count | 4.7 | 6.8–7.3 |

Type and click are within run-to-run noise. Read and count, which are
themselves one short evaluate, pay about 1.1–1.9 ms and 2.1–2.6 ms, because the draw runs on
the same main thread just before them. One draw's evaluate round trip, ring
included, was 3.9 ms median. Either cost is small next to the post-action
settle of 0.6–1.5 s.

A click that navigates takes its ring down with the old document. The ring
shows for the length of the click, typically tens to hundreds of milliseconds.
Carrying a ring into the next document would mean guessing which element there
corresponds, and is not done.

### 5.2 Overlap

Actions faster than the ring are the normal case: a `type` then a `click` in
one turn. Each element gets its own ring, and re-marking an element restarts
its ring. A cap of 32 live rings per document retires the oldest, so a long
burst cannot pile up.

### 5.3 Reads of many elements

A read of every match, or a count, can match hundreds of elements. Their marks
pass `max: 20` (`HIGHLIGHT_MANY_MAX`, fixed by §13 decision 7). The page rings
the first 20 matches **with a box**, in document order, and ignores the rest.
`readTable` rings only the table (`max: 1`). Any mark with a `max` never waits
for a late element, `readTable`'s included: its matches were taken already
(`mayWait` in `createHighlighter` requires `max === undefined`).

### 5.4 Reduced motion, and tests without timers

- **`prefers-reduced-motion: reduce`** is decided **in script**, with
  `matchMedia`, not with a `@media` rule in the adopted sheet. Measured: with
  `page.emulateMedia({ reducedMotion: 'reduce' })`, `matchMedia` answered true
  in all three engines, while a `@media (prefers-reduced-motion: reduce)` rule
  in an adopted sheet took effect in Chromium and Firefox **but not in
  WebKit**. Under reduced motion the envelope animates opacity alone (no
  scale), holds at full strength, and fades over the last 5% of `durationMs`
  (150 ms at the default); the glow does not animate.
- **The clock is injected.** "Was a ring drawn here recently" reads
  `HighlightClock.now`, passed to `createHighlighter(settings, { now })`,
  `hiddenFor`, `hiddenForReport` and `endRings`. This is the existing pattern
  of `ThresholdWait` and `waitForStableCount`.
- **The Node side's timers are budgets only** (the per-frame waits, the
  target-id bound, the confirmation retries), all `setTimeout`, and the tests
  fake them with `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })`
  against fake frames whose `evaluate` lands only when the test lets it
  (tests/highlight-hide-landed.test.ts).
- **In the page, tests end rings deterministically** through the handle's
  `finishAll()`, which finishes every animation and resolves once the rings
  and the host are gone. A test that wants a static ring for a pixel check
  emulates reduced motion and passes a long `durationMs`.
- **Test hooks** in highlight.ts: `drawRings` (a draw the test can await),
  `lateRingWaitsPending()` (to show a late wait ended, without sleeping), and
  `resetRingRecordsForTests()`, which clears the process-wide records before
  each case so one case's far-future clock cannot make later cases pass
  vacuously.

### 5.5 Elements that appear during the act

A mark goes out just before the act, and `evaluateAll` does not wait, so an
element still arriving (a dialog animating in, a row the fetch has not
delivered, the normal case for compiled code that acts straight after the
previous step) would get no ring. So a mark with no `max` that drew nothing, and
has `MarkOptions.settled`, waits for its element (`waitForLateElement`), never
awaited by anyone:

- it watches `locator.first().waitFor({ state: 'attached' })`, bounded at
  `LATE_RING_WAIT_MS` (5 s), and draws once more if the element attaches
  before the act settles, or if the act succeeded (what it acted on was
  there);
- it draws nothing if the act failed, the 5 s bound ran out, `endRings`
  cancelled it, or the page navigated: an element that arrives after the act,
  or in a new document, is not the act's, whatever its selector says;
- the navigation that ends it is of the locator's own frame (Playwright's
  private `_frame`) or the main frame; another frame's, such as an ad
  rotating, says nothing about this element. A locator that enters a frame
  resolves from its **outer** frame, so for it a navigation of any frame below
  that one counts too (`frameOfLocator` reads `_selector` for
  `internal:control=enter-frame`). A test pins both private fields, so a
  Playwright rename fails a test rather than quietly narrowing the guard.

Marks with no `settled` (the login broker), any mark with a `max` (a read of
every match, a count, `readTable`), and the keyboard's `wait: false` never
wait.

---

## 6. Computer mode (`[use computer]`)

**Out of scope for drawing.** Computer mode drives the real mouse and keyboard
through nut.js, and the model reads `screen.grab()` of the whole primary
display (SPEC-use-computer.md; src/desktop/nut-adapter.ts). A highlight there
would have to be a native window that is topmost, transparent and
click-through, different on each OS (a layered window on Windows, a borderless
window that ignores mouse events on macOS, an override-redirect shaped window
on X11, nothing on Wayland), and a new native dependency. Worse,
`screen.grab()` excludes nothing, so the overlay would be in the very
screenshot the model reads next, and there is no `hide` for a desktop overlay
without another platform-specific mechanism.

**What is in scope:**

1. **Entering `[use computer]` ends the browser's rings for good.**
   `enterComputerMode` takes `endBrowserRings` and awaits it before the
   capture probe, so the probe sees what the first turn will. Both runners
   pass `() => endRings(pagesOf(tracker))`: every tab of every browser the
   tracker holds (test-runner.ts, session-manager.ts). It ends rather than
   hides because nothing would restore the rings, and anything that did would
   bring one back mid-turn. §4.3 rule 14 says how long it waits.
2. **Nothing rings on the computer surface.** `endRings` runs only on entry,
   so anything that drew afterwards would be in the next screen grab. So no
   highlighter is handed to `[tool: …]` steps while the surface is `computer`
   (CLI and server), code-behind entries and their `step.read` / `step.count`
   get none there (`opts.computer`), and `SessionManager.highlighterFor`
   answers `undefined`, so a `log_into_site` between batches of a session left
   on the computer surface draws nothing.
3. **Considered and declined (§13, decision 6):** marking the click point on a
   computer-mode report screenshot after the fact.

---

## 7. Config

### 7.1 Key and shape

`browser.highlight`, beside `browser.video` and `browser.slowMo`, the other
watch-the-run settings:

```jsonc
"browser": {
  "highlight": true                   // { "enabled": true } with the defaults
}
```

```jsonc
"browser": {
  "highlight": {
    "enabled": true,                  // default true once the object is written
    "durationMs": 3000,               // 500–10000; default 3000
    "colors": { "act": "#3b82f6", "read": "#a855f7" },   // #rgb or #rrggbb
    "inScreenshots": true             // report captures; a model never sees it
  }
}
```

- **Default: off** (`highlight: false` in src/config/defaults.ts). The rings
  paint over the page under test and put a host element in its DOM, however
  carefully, and that should be a choice (§13, decision 1).
- **The object form is on unless `enabled: false`.** Writing
  `{ "durationMs": 5000 }` turns the rings on: writing the object is turning
  them on. `enabled: false` keeps the settings for `--highlight` to switch on.
- **No `style` option.** There is one designed effect (§8).
- **Types.** `HighlightConfig` and `HighlightColors` in src/config/types.ts,
  with `BrowserConfig.highlight?: boolean | HighlightConfig`. The full JSDoc is
  on the interface, which the generated schema shows for the object form, as
  for `DesktopConfig`.
- **Validation at load.** `assertHighlight` in src/config/loader.ts, beside
  `assertBlockAds`, so that a quoted `"false"` cannot be read as truthy and
  switch the rings on (the reason the loader gives for checking the `desktop`
  section). The message names the key at fault:
  `Invalid browser.highlight in <file>: …` for the section itself and for an
  unknown key, `Invalid browser.highlight.<key> in <file>: …` for a bad
  `enabled`, `inScreenshots`, `durationMs` or `colors`, and
  `Invalid browser.highlight.colors.<act|read> in <file>: …` for a bad colour.
  A wrong value is shown through `describeValue`; an unknown key is quoted
  (`JSON.stringify`) after the list of allowed keys. It throws for:
  - anything but a boolean or a plain object;
  - an unknown key (only `enabled`, `durationMs`, `colors`, `inScreenshots`):
    stricter than other sections on purpose, because a misspelt `duration` or
    `colours` would otherwise be a setting that silently does nothing;
  - a non-boolean `enabled` or `inScreenshots`;
  - a `durationMs` that is not a finite number from 500 to 10000;
  - `colors` that is not an object, has a key other than `act` and `read`, or
    has a value that is not `#rgb` or `#rrggbb` (`HEX_COLOUR`). Hex only,
    because Node cannot ask a browser whether another CSS colour parses.
- **Normalised once.** `resolveHighlight(browser): ResolvedHighlight | null`
  in src/browser/highlight.ts, the way `resolveVideoMode` normalises
  `browser.video`. Every read site gets `null` (off) or a complete object
  (`HIGHLIGHT_DEFAULTS` filled in), so no caller writes `?? 3000`. `true` is on
  with the defaults; `false`, `undefined` and anything unrecognised are off. It
  takes `{ highlight?: unknown }` rather than `BrowserConfig`: actions.ts
  imports highlight.ts, and the report types the Runner UI's renderer
  type-checks import actions.ts, so importing the config types there pulled
  the ambient `@pkent/aigateway` module into that check and failed
  `npm run lint`.
- **Schema and docs.** The generated schema/steptix.config.schema.json
  (`npm run build:schema`, part of `build`) carries `HighlightConfig` with
  `additionalProperties: false`, the 500–10000 range and the hex pattern, so
  the editor refuses what the loader refuses; the extension ships it through
  `jsonValidation`. README's config section and docs/specs/SPEC.md's config
  list carry the example. templates/init/steptix.config.json does not: it is
  strict JSON with no room for a comment, and it is the live suite's fixture
  workspace, not a starter config.

### 7.2 Per-test and per-run overrides

- **Front matter or `## Config`: none.** Whether the rings show is a
  preference of whoever is watching, not a property of the test or the site.
- **CLI.** `steptix run --highlight` / `--no-highlight` (src/cli/commands/run.ts).
  Both options are declared, so the default stays `undefined`: with only
  `--no-highlight`, commander would default to true and switch the rings on
  for every run. `applyCliOverrides` applies `switchHighlight(value, on)`,
  which sets `enabled` on an object and keeps its duration and colours, and
  turns a boolean into the other boolean.
- **The `highlight` run setting** (`'on' | 'off' | 'default'`, `HighlightMode`,
  §13 decision 4) follows the `ai` setting in every layer:
  - `HIGHLIGHT_MODES` and `RUN_SETTING_KEYS` (src/config/run-settings.ts);
    `parseRunSettings` (src/server/api-server.ts) refuses any other value with
    a 400 naming the valid ones;
  - `mergeRunSettings` retains `on` / `off` on the session, and `default`
    deletes the override;
  - `resolveRunSettings` applies `switchHighlight` (the CLI flags' rule) over
    the project's value, with source `session`;
  - `EffectiveSettings.highlight` (`'on' | 'off'`) and
    `sources.highlight`, echoed by `GET /config` and the done event;
  - MCP: the `highlight` argument on `run_steps` and `run_test_file`
    (`readRunSettings`), `highlight` and its source in `get_run_settings`'
    output, and `highlight` in a run result's `effectiveSettings`, all
    nullable for a server that predates the setting;
  - the login broker honours it (§2.3).
- **The VS Code setting `steptix.highlight`** (`default` / `on` / `off`,
  default `default`), read per request. It declares no `scope`, so it is
  window-scoped: the user or workspace value applies to every folder in the
  window, and a folder's own settings file is not consulted. It is the
  first thing Steptix sends as `runSettings`, through runner-core's
  `StreamStepsRequest.runSettings`, typed to carry `highlight` only. The
  decision is `highlightRunSettings` in run-settings-core.ts, pure so
  `node --test` covers it:
  - `on` or `off` is always sent;
  - because the server **retains** run settings, a `default` that follows an
    override must be sent, to clear it;
  - a `default` with nothing to clear is not sent, so a server older than the
    setting never refuses a run over a key it does not know.

  The controller remembers what each session was sent (`highlightSent`).
  `highlightRequestFor` returns the request's body and a `commit` closure that
  the request calls on its first frame, so a request that an older server
  refused commits nothing and no other request can commit it. The memory is
  cleared when the controller forgets its sessions, and per batch session when
  that session closes.

### 7.3 How the setting reaches each path

| Path | Route |
| --- | --- |
| CLI | `loadConfig` → `applyCliOverrides` → `StepExecutorOptions.config` → `highlightOption(config)` → `ExecuteActionOptions.highlight`, built where `ambiguousTarget` is |
| Server / Sessions API, MCP, VS Code | `resolveRunSettings` re-sources `browser.highlight` from the project with `base(server, project)`, exactly like `ambiguousTarget`, then applies the run setting |
| Code-behind `step.read` / `step.count` | `RunCodeBehindOptions.highlight` → `StepApiRuntime.highlight` |
| Code-behind entries | `RunCodeBehindOptions.highlight` → the wrapped `ctx.page`, `ctx.tabs`, `ctx.browsers` |
| Fixture tools | `highlighterFor(config.browser)` → `ExecuteToolStepOptions.highlight`, on the browser surface only |
| Errands | their project's config, the way a session resolves it, through `ringsOutOfScreenshots` |
| Login broker | `SessionManager.highlighterFor(sessionId)` from `session.browserConfig` and `session.runSettings.highlight` |

**The trap on the server path.** `resolveRunSettings` spreads the **server's**
startup config and re-sources only named keys, so a new per-project
`browser.*` key reaches the CLI correctly and is silently the server's value
everywhere else. `browser.highlight` is re-sourced there. It is not hoisted
onto `ProjectBundle`, because nothing reads it at session creation: it is read
per action. The live test (§10.2) is what proves the re-sourcing end to end.

---

## 8. Visual design: "trace and glow"

One effect, two hues:

| Kind | Actions | Hue | Why |
| --- | --- | --- | --- |
| act | click, type, select, hover, drag, upload, dismiss, keyboard; the login broker's fields and submit | blue `#3b82f6` | neutral and "doing" |
| read | read, read every match, count, readTable, `step.read` / `step.count`, the wrapper's read methods | violet `#a855f7` | clearly different from blue at a glance |

**Red is avoided.** It means error, and the recorder's crops already tell a
model "the target is outlined in red" (src/ai/prompts.ts). **Green** is avoided
because it reads as "passed", and amber as "warning".

**Visible on light and dark pages.** The ring's look is three layers: a 2px
coloured border, a 2px white halo outside it (85% opacity), and a 1px dark
hairline outside that (35% opacity), then the glow. Whatever the background,
one of the three contrasts with it.

**Two elements per ring** (§3.3 item 11). The outer `.ring` is placed and
carries only the envelope; the inner `.glow` fills it and carries the look.
The sheet adopted into the closed root (`RING_CSS` in highlight.js):

```css
.ring{position:fixed;box-sizing:border-box;pointer-events:none;margin:0;padding:0;
  background:transparent;border:0;transform-origin:50% 50%;will-change:opacity,transform}
.glow{position:absolute;left:0;top:0;right:0;bottom:0;box-sizing:border-box;pointer-events:none;
  margin:0;padding:0;background:transparent;border:2px solid var(--stx-c,#3b82f6);border-radius:6px;
  box-shadow:0 0 0 2px rgba(255,255,255,0.85),0 0 0 3px rgba(0,0,0,0.35),0 0 12px 3px var(--stx-glow,transparent)}
```

Per ring, script sets `left`, `top`, `width` and `height` on `.ring` (the
element's box outset by 3 px), `data-kind`, and two custom properties that the
glow inherits: `--stx-c` (the kind's colour) and `--stx-glow` (that colour at
55% as `rgba()`).

The motion is two Web Animations with the same timing, `{ duration:
durationMs, easing: 'linear', fill: 'forwards' }`; offsets scale with
`durationMs`. The envelope, on `.ring` (`envelopeFor`):

```js
[
  { offset: 0,    opacity: 0, transform: 'scale(1.12)', easing: 'cubic-bezier(.2,.8,.2,1)' }, // draws in onto the element
  { offset: 0.06, opacity: 1, transform: 'scale(1)' },  // ~180 ms at 3 s
  { offset: 0.8,  opacity: 1, transform: 'scale(1)' },  // hold
  { offset: 1,    opacity: 0, transform: 'scale(1)' },  // fade over the last 20%, ~600 ms
]
```

The glow pulse, on `.glow` (`glowFor`), with `halo = 0 0 0 2px
rgba(255,255,255,0.85), 0 0 0 3px rgba(0,0,0,0.35)`:

```js
[
  { offset: 0,    boxShadow: halo + ', 0 0 12px 3px rgba(<c>,0.55)' },
  { offset: 0.06, boxShadow: halo + ', 0 0 12px 3px rgba(<c>,0.55)' },
  { offset: 0.15, boxShadow: halo + ', 0 0 20px 8px rgba(<c>,0.6)' },  // one glow pulse
  { offset: 0.25, boxShadow: halo + ', 0 0 12px 3px rgba(<c>,0.55)' },
  { offset: 1,    boxShadow: halo + ', 0 0 12px 3px rgba(<c>,0.55)' },
]
```

Under reduced motion the envelope is `[{ opacity: 1 }, { opacity: 1, offset:
0.95 }, { opacity: 0 }]` and the glow is not animated: the sheet's steady glow
stands. If the glow animation fails on its own, the envelope, which decides the
ring's life, still runs.

**`rgba()`, not `color-mix()`.** Colours are hex only (§7.1), so the script
computes `rgba(r,g,b,α)` itself (`rgba` in highlight.js, expanding `#rgb`). An
older CDP-attached Chrome without `color-mix()` would drop the whole
`box-shadow`, halo included, over the unknown function; with `rgba()` it keeps
the glow too.

**The look is unchanged by the two-element split.** In Firefox and WebKit a
ring 3.5 s into a 10 s life is pixel-identical to the one-element ring. In
Chromium it differs by at most 50 per channel in the glow's blur, from
rasterising on the envelope's own layer; the border is unchanged.

---

## 9. Constraints from CLAUDE.md

- **No site-specific code.** The controller knows only HTML, CSS and ARIA
  standards: `popover`, `aria-hidden`, `:modal`, `:popover-open`, the top
  layer and `prefers-reduced-motion`. Test fixtures use invented names
  (`#item`, `#go`, "Order 12 was placed."). The live test drives SecureBank
  from a `.md` file, never from framework code.
- **Windows, Linux and macOS.** Nothing in this is platform-specific. Browser
  tests run headless; the CSP fixture server binds with
  `listenFetchable(server, host)` (tests/listen-fetchable.cjs).
- **Unit tests are not timed** (§5.4): an injected `now`, faked `setTimeout`,
  `finishAll()`, `lateRingWaitsPending()`, and conditions rather than sleeps.
- **Extension version bump.** Phase 1 changed no tracked file under
  `steptix-vscode/` or `runner-core/`, but the extension ships the generated
  schema (`jsonValidation`, `copy:schema`), so editor completion for
  `browser.highlight` arrives only with a rebuilt VSIX; it bumped the patch
  anyway, so the Extensions panel shows the change. Phases 2–3 and review
  rounds 1–2 changed files under `steptix-vscode/` or `runner-core/` (the live
  test, the `steptix.highlight` setting, runner-core's `runSettings`, the
  controller's memory) and bumped each time: 0.5.193 to **0.5.198**
  (steptix-vscode/package.json). Review rounds 3–6 changed neither, so the
  extension stays at 0.5.198.

---

## 10. Test plan, as implemented

### 10.1 Unit tests

The spec's eight cases, and where each lives:

| Case | File | What it covers |
| --- | --- | --- |
| 1. Config | tests/highlight-config.test.ts | the loader accepts `true`, `false` and the object form and refuses the bad shapes with the message format; the generated schema agrees with the loader (Ajv); `resolveHighlight` normalises and never hands out the shared defaults; `ringsOutOfScreenshots`; `resolveRunSettings` takes the project's value over the server's; `--highlight` / `--no-highlight` keep the object's settings |
| 2. Marks | tests/highlight.test.ts | a recording sink through `executeAction`: click (one act), a hidden checkbox (the label), type including the key-by-key route and the click-and-keyboard fallback, select and hover, read, read every match (`max` 20), count (`max` 20, nothing for 0); measuring, the hoisted wait and the ambiguity refusal mark nothing; iframe promotion marks one act, on the element inside the frame, and none on the iframe; a throwing sink cannot fail the action |
| 3. Never awaited | tests/highlight.test.ts | a sink whose promise never settles, and the action still resolves |
| 4. The controller | tests/highlight.test.ts | per engine: one ring around the element; one ring per element; `max`; the 33rd ring retires the oldest; `finishAll()` removes the host; a removed element's ring is gone two animation frames later; iframe and open-shadow targets; a zero-size target adds no host; scale normally, opacity only under reduced motion; the envelope moves only opacity and transform on `.ring` and the glow is `.glow`'s |
| 5. Strict CSP | tests/highlight.test.ts | per engine, against a `listenFetchable` server sending `default-src 'none'; script-src 'self'; style-src 'none'; img-src 'self'`: zero violations and a 2px computed border, while the page's own `setAttribute('style')` is refused, which proves CSP was on |
| 6. Readers ignore it | tests/highlight.test.ts | with a ring live, `captureDomSnapshot`, `findInDom`, `locateTexts`, page diagnosis and the page signal equal what they were before; the ringed element stays clickable and under its own centre |
| 7. Hidden from the model | tests/highlight.test.ts | under reduced motion: a report capture shows the ring colour at the ring's edge, `hiddenFor` shows the background, the next capture shows the ring again; past the ring's life, after `finishAll`, the first capture confirms the frame and the next asks no frame |
| 8. Engines | tests/highlight.test.ts | cases 4 and 5 run in Chromium, and in Firefox and WebKit wherever they are installed (`describe.skipIf`) |

What the review rounds added:

| File | Covers |
| --- | --- |
| tests/highlight-paths.test.ts | the phase-2 handlers (drag both ends, upload visible and hidden, dismiss, keyboard focus inside an open shadow root, readTable as one ring); `highlighted` on results and in the report; `step.read` / `step.count` through the run's sink; the login broker's marks; report versus model captures and `inScreenshots: false`; `endRings`; overlapping hides; a host rebuilt mid-capture starts hidden; late elements through the sink, `executeAction` and the page wrapper; restamping when a draw lands; the run deciding its pictures' audience; hide/restore/end never calling a forged host's functions; a forged host passed over; a lapsing entry; `max` counting rings drawn; the snapshot keeping a page's own `<steptix-highlight>`; which navigation ends a late wait, the pin on `_frame` / `_selector`; `endRings` cancelling late waits; Frame identity across `pushState` and hash changes; pruning; a ring that starts after its frame unblocks; `pageEverRinged` after `endRings` and close; nothing for an off page after `page.close()`, `closeBrowser`, `browser.close()` or a persistent context's `close()`; a javascript: frame the page filled is hidden from a model capture (review 23); asked through its parent, it is judged on its own clock: with the parent's `Date.now` 5 s ahead the hide still waits for the paint, 70 s behind the host is still hidden a frame later, and in a frame running no animation frames with the parent 70 s ahead the hide alone hides it (review 26) |
| tests/highlight-hide-landed.test.ts | fake frames and fake timers: a capture waits for its hide to land; no picture when it cannot; the lifetime escape for frames that did and did not draw; `endRings` waits for the end, gives a held frame its grace, logs, and keeps an unreached frame held; a never-answering target-id lookup costs a bounded wait; an entry kept while the frame still has a host; the page's own confirmation and its 11-probe cap; draws in flight; nothing asked with the highlight off; Pages on one CDP endpoint (rules 9 and 10): a launched-browser page and a page on another endpoint never look a target id up, every Page holds every frame (one that drew and confirmed included), each of the three ends, a ring drawn while a departed drawer's record lives (R), two drawers of which one leaves (V), a host that never retires on a detached errand's tab, and a capture started inside the detaching Page's `close` event; review 19: a frame with no address hidden and, unanswering, not clear (in a capture and in the drawing Page's confirmation); a Page whose lookup runs out of time holds every frame and confirms nothing; a capture round and a confirmation round that a draw starts and lands during confirm nothing; draws in flight keep the record through a capture and through a confirmation; a capture waits for a lookup in flight; a ring stamped during an unhidden picture is retaken; a lookup drops the record of a closed tab; review 21: a frame with no document is not asked (attached and launched) and does not stop confirmation, a held entry for one is dropped, a draw landing mid-wait ends the no-escape wait, a restore is not waited on where its hide never landed, an off capture is not retaken for another tab's draw but is for its own tab's, and the hide path retakes once; review 23: the lifetime edge waits out an early timer, an unknown tab waits on its endpoint's draws, a frame whose element cannot be found is skipped and its held entry dropped; review 24: an element lookup that outruns its budget keeps the frame asked and its entry held, and the element is disposed when its frame detaches |
| tests/highlight-cdp-tab.test.ts | two Page objects on one CDP tab, each connection registered as `connectOverCdpSession` registers it: a ring drawn through one is hidden from, and ended through, the other; a page in another browser pays no round trip; the tab record holds every frame until they answer; a Page detaching through `closeBrowser` leaves its record for the others, even for a capture started inside its `close` event; records reset before each case; `closeBrowser` on an attach that opened its own tab leaves nothing for an off page; a cross-site frame (`--site-per-process`) that loaded before the attach is hidden from the attached Page's model capture, while a lazy frame with no document beside it is never entered; a javascript: frame the page filled is hidden too; 25 captures of a static ring in an out-of-process frame show no ring pixels, the ring drawn again every five captures and still up after the last, and on a fresh ring the frame has painted since its hide landed; a hide waits for a paint in a cross-site frame in view and not in one scrolled out of view, which Chrome is not drawing; a hide in the main frame does not wait for a paint and an end there does; frames are told apart by their element ids; a restore is waited for as a condition, and the cases that launch, connect or close browsers have budgets past the default, for a loaded machine |
| tests/highlight-peek.test.ts | the forced hide: writes nothing on a tab never drawn on, hides a ring this process has no record of, never enters the context of a frame with no document (it is asked through its parent), and takes the picture at once |
| tests/highlight-model-captures.test.ts | pins every model-bound capture site's `'model'` audience (pre-turn, assertion code, condition judge, diagnosis and its fallback), the report sites of a run whose pictures go to a model, and `endBrowserRings` before the `[use computer]` capture probe |
| tests/highlight-page.test.ts | the wrapper against real Chromium: marks exactly what a compiled-style entry touches and every call still works; `dragTo`, `and()` / `or()` with proxied locators; the page shorthands; nothing for `evaluate`, the keyboard or navigation; prototype and one proxy per object; tab API pages equal `ctx.page`; real rings with no recursion; entries and tools get the wrapped page only with the highlight on |
| tests/run-settings.test.ts, tests/api-server-run-settings.test.ts | the run setting's resolution and merge; on, retained and cleared over HTTP; a 400 for an unknown value; `screenshotsToModel` for one batch only |
| tests/session-lazy-launch.test.ts | `highlighterFor` follows the session's setting and answers undefined on the computer surface; `GET /sessions/:id` captures for a model; a `screenshotsToModel` batch's error capture |
| tests/mcp-seam.test.ts, tests/mcp-run-fold.test.ts | the `highlight` argument and `screenshotsToModel` on the wire; an older server omitting `highlight` |
| tests/codebehind-compile-parameters.test.ts, tests/api-server-codebehind.test.ts | compile runs keep rings out of every capture |
| steptix-vscode/tests/run-settings-core.test.js, runner-core/tests/api-client.test.js | the `steptix.highlight` send rule; `runSettings` carried verbatim |

### 10.2 Live test

steptix-vscode/tests/integration/live/highlight.test.cjs runs
templates/highlight/tests/highlight-securebank.md through the extension and a
real server. The project is templates/highlight/, beside
templates/video-record/, so a sharded run copies it into each shard and
`rebaseConfigPaths` has nothing to rewrite; a project of its own because
turning the highlight on in templates/init/ would put rings in every other live
test's report. Its `steptix.config.json` sets `browser.highlight: true`,
`browser.captureScreenshotsPerAction: true` and `ai.sendScreenshots: true`, so
the hide path runs.

The fixture signs in to SecureBank (`fixtures/test-app`, port 8787) with
credentials from `## Parameters`, rejecting the cookie banner if it is shown,
then reads the Available Balance and counts the Recent Transactions. The test
asserts:

- the run passes, and the project's `browser.highlight` reached the server's
  executor at all (the §7.3 re-sourcing, end to end);
- every sub-action of an element-touching kind carries the expected
  `data-highlighted` (`act` for click, type, select and hover; `read` for read
  and count), and kinds that touch no element carry none. It checks each
  sub-action against its kind rather than counting rings, because the model
  may split or merge steps;
- both kinds appear, and at least two type sub-actions;
- every ringed sub-action has its own screenshot;
- no `ai-request-content` block, and nothing else in the report, mentions
  `steptix-highlight`.

Pixels are not asserted live: where the fade is at capture time is not
deterministic (§4.2). The unit tests cover pixels.

---

## 11. Reporting

`SubActionResult.highlighted?: 'act' | 'read'` (src/report/types.ts) records
that a ring was **requested**, not that one was drawn: the draw is
fire-and-forget, and it draws nothing when the target is absent or has no box
(a keyboard action with nothing focused, a hidden match). `executeAction` sets
it on `ActionExecutionResult.highlighted` from the noting sink (§2.2), `read`
winning if an action asked for both; the step executor copies it onto the
sub-action (step-executor.ts). It is absent when the highlight is off or the
action had no element to ask about.

Only `executeAction` sets it. Code-behind entries, fixture tools and the
login broker draw through their own marks (§2.3) and never carry
`highlighted`, even when they drew.

`renderSubAction` (src/report/generator.ts) renders it as a `data-highlighted`
attribute on the sub-action's element and nothing visible: the screenshots
show the ring, and the attribute is what a check of a report can read without
pixels. That gives the live test its coverage assertion, and a reader a way to
tell "this action asked to ring an element" from "this action had no element".

---

## 12. Risks

- **The host is in the page's DOM.** Page code observing `<html>`'s
  `childList` sees one element come and go. `document.querySelectorAll('*')`,
  a `*` or `html > *` selector, and a `:popover-open` query each count it while
  a ring is live, so a test whose own selector is `*` counts one more during a
  ring. Documented in `HighlightConfig`'s JSDoc and the README. No Steptix
  reader is affected (§4.1). The recorder toolbar carries the same footprint.
  - **Showing the host fires popover events on it**, which a page listening
    on `document` in the capture phase sees. A draw that shows the host fires
    `beforetoggle` and `toggle`. One that re-raises it above a page's popover
    or modal dialog fires `beforetoggle` twice, closing then opening, and one
    `toggle`, in Chromium and Firefox; WebKit sent that `toggle` later.
  - **The page's own top layer is undisturbed.** In all three engines, with
    two draws each: the page's open popover stayed open, its modal dialog
    stayed modal, focus did not move (no `focusin` or `focusout`), clicks
    still landed, and Escape still closed the page's popover
    (review28/popover.mjs).
- **The page can tamper.** A page that patches `attachShadow`,
  `Element.prototype.animate` or `requestAnimationFrame` can break the ring;
  the draw fails silently and cannot fail a step. A hostile page can also see
  the targets, overwrite the handle on Steptix's host so that hiding and the
  snapshot skip no longer recognise it, patch `Date.now` so hide entries
  lapse early or never, or patch the timers the paint wait calls so a hide
  is taken as painted before it is (§3.3 item 9). Documented, not defended.
- **Clipping is not reproduced.** A ring in the top layer is not clipped by
  the element's scroll container, and draws above a fixed header that covers
  the element. That shows where the element is; a reader might still be
  surprised.
- **Top-layer churn.** When the page opens a dialog after a ring, the host is
  re-raised on the next mark, not continuously; a ring already live under a
  newly opened modal stays under it until it fades.
- **Screenshots vary run to run** in glow phase (§4.2). Nothing in the repo
  compares them.
- **Code-behind and tool coverage is best effort** (§2.3).
- **The late-element guard reads Playwright's private `_frame` and
  `_selector`** (§5.5). A test pins both, so a rename fails a test.
- **A peek can show another process's ring.** The forced hide of a CDP tab
  peek gives each frame 500 ms when this process has no ring of its own on the
  tab. If another process (a CLI run on the same CDP browser) drew a ring
  inside a cross-origin frame that is busy past that budget, the peek's picture
  can show it (§4.3 rule 13). The README states this gap.
- **Firefox and WebKit under `[use computer]` are unmeasured.** The
  compositor fade (§3.3 item 11) was measured in Chromium only. If either
  engine's compositor does not run the fade while the page's main thread is
  blocked past the ring's lifetime plus 2 s, `[use computer]`'s first screen
  grab could show a ring frozen at the moment the page blocked.
- **Two animation frames may not be enough under extreme CPU load.** With
  48 busy threads on a 12-core machine, 1 of 40 model captures of a static
  ring in an out-of-process frame showed the ring although its hide had
  waited for the paint (review26/loadwait.mjs). 320 repeats of that run
  showed none, nor did 120 captures here at 24 and 48 threads, CDP and
  launched, each of which waited. Observed once and not reproduced; the
  path is the same as on 37eff1f8. Two animation frames may not guarantee
  that the change has been presented when the machine is that loaded.
- **What the cross-Page hiding costs, exactly** (§4.3 rules 9 and 10).
  - Pages in a launched browser, Firefox, WebKit, or connected to another
    CDP endpoint pay nothing, ever.
  - After a ring on a CDP tab, each Page connected to the SAME browser
    endpoint pays one target-id lookup (a CDP attach plus
    `Target.getTargetInfo`, cached per Page) while that tab's record lives.
  - Pages ON that tab also pay the hide and restore evaluations on each
    model capture, as the drawing page does.
  - The record lives until a capture or confirmation through any Page finds
    the tab clear, until the tab closes, or until the endpoint disconnects.
    The drawing page confirms its tab on its own after each ring (§4.3 rule
    8), so after an ordinary ring the cost ends within seconds.
  - **It can last longer in four cases.**
    - **A host that never retires** (a page that pauses its animations): it
      is hidden for as long as it is there.
    - **A ring in a cross-site frame scrolled out of view.** Chrome does not
      draw that frame, so its ring's animation and loop do not run, and the
      ring retires only once the frame is back in view
      (review25/offpersist.mjs: a 3 s ring's host was still there 45 s
      later, and gone straight after the frame came back). Each model
      capture meanwhile asks that frame, with no paint wait: 11–53 ms per
      capture (§16.16).
    - **A detached errand's ring that no remaining Page drew after:** the
      record lives until that Page's next model capture, or until it
      disconnects. Measured (review18/q1w-same.mjs, the session idle and
      connected): every new Page on that browser paid one lookup through
      +80 s.
    - **A frame on the tab that never answers** (an ad that never commits,
      or one that stays busy): no round can confirm the tab while it is
      there.
  - A tab the user closes takes its record with it at the next lookup on
    the endpoint (§4.3 rule 9).
  - **A hide in a child frame with a ring of ours waits for that frame to
    paint** (§4.3 rule 2): about two animation frames, at most 200 ms.
    - The 200 ms is a timer in the frame. Playwright keeps every page it
      drives `visible`, a background tab and a minimized window included
      (review25/bg-oop.mjs: `visible` in all 45 runs), so that timer is not
      held back the way a hidden page's is, and the cap holds.
    - In a background tab animation frames come 1–2 s apart
      (review25/bg-oop.mjs), so a hide there usually finds no recent one and
      does not wait at all. Neither does a hide in the main frame, in a frame
      with no host, or in a frame Chrome is not drawing.
    - The common case, a page with no frames and a ring in the main frame
      (review25/cost25.mjs, launched, median of 10): a model capture
      straight after the click takes 53 ms with the highlight on and 34 ms
      with it off, and 1.5 s later 41 ms and 39 ms. The 19 ms is the hide
      and restore round trips (3–6 ms together) and the picture taking
      longer because the hide has to be drawn into it (45–53 ms against
      29–34 ms for one taken with nothing changed).
    - In review24/handles.mjs, 200 captures with a ring up and a
      `javascript:` frame replaced before each took 9.4 s; 200 with the
      highlight off took 7.3 s.
  - **An `<iframe>` element lookup stuck on a busy parent** counts as a frame
    not answering: each capture during the busy spell waits for it as rules 5
    and 6 say, until the lookup lands.
  - **A frame Playwright reports no address for costs one parent evaluation
    per capture while a ring may be up** (§4.3 rule 3).
    - There is a one-time element lookup per Frame, and on a Page attached
      over CDP one "own CDP session?" check per Frame.
    - The realistic case is a `loading=lazy` iframe below the fold. Its own
      context is never entered.
    - Measured with review21/lazy-persist.mjs; model captures after a click,
      first through last:

      | Mode | ms |
      | --- | --- |
      | attach-after-load | 36, 18, 19, 17 |
      | attach-then-goto | 37, 52, 16, 28 |
      | launched | 46, 29, 23, 21 |

    - At cceb1e99 the first capture after the click took 4503–4536 ms on
      CDP (1073 ms launched), and about 1040 ms every capture after.
  - **A frame that never answers holds up `page.screenshot` itself,
    highlight or not.** An iframe whose evaluation is pending blocks the
    screenshot (review21/pending-eval.mjs), so the 1027 ms that §16.12
    quoted for review4/slowframe.mjs timed a trivial `fn`, not a real
    capture.
  - A bare `browser.close()` on a CDP connection, not made through
    `closeBrowser`, is taken as closing its tabs: their records go, and
    another Page on a tab that in fact stays open loses them.
- **A draw queued behind an iframe busy for more than 15 s gives no
  picture.** A model capture while the draw is unanswered must see its hide
  land, so past 15 s it is `RingsNotHiddenError` and `captureScreenshot`
  returns `null`, where the same capture with the highlight off would wait and
  return a picture. This is the intended trade: no picture rather than a
  ringed one, and the act into that frame waits on the same frame anyway.

---

## 13. Decisions

Decided by the user on 2026-10-14, after review of this spec.

1. **Off by default.** `browser.highlight` defaults to `false` (§7.1).
2. **Rings show in report screenshots and video by default.**
   `inScreenshots: false` opts out. Screenshots that go to a model never show
   them, whatever the setting (§4.2).
3. **Compiled code-behind and fixture tools are covered** in phase 3, by the
   best-effort page wrapper with the escape routes listed in §2.3.
4. **There is a per-run toggle** in phase 3: a `highlight` run setting
   (`'default' | 'on' | 'off'`) across the Sessions API, MCP (`run_steps`,
   `run_test_file`, `get_run_settings`) and a VS Code setting (§7.2). It is in
   addition to the config file and the `--highlight` CLI flag.
5. **Two kinds:** blue for act, violet for read (§8). Typing gets no hue of
   its own.
6. **Computer mode:** no drawing (§6), and no after-the-fact click markers on
   its report screenshots.
7. **Reads of many elements ring at most 20,** a fixed cap that is not
   configurable (§5.3).

---

## 14. Phased plan

All three phases are done; §16 records each phase's commit and what it found.

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | `browser.highlight` type, validation, schema, docs, CLI flag; `resolveRunSettings` re-source; src/browser/highlight.ts (`resolveHighlight`, the sink, `hiddenFor`); scripts/highlight.js; marks in click (with the stand-in), type, select, hover, read, read every, count; the capture-dom.js skip; hiding for the model's captures and diagnosis; unit tests 1–8; extension patch bump for the schema. Frames, open shadow DOM, CDP browsers and all three engines come with this phase. | done, cbd24c90 |
| 2 | Remaining handlers (drag both ends, upload, dismiss, keyboard's focused element, readTable); `step.read`/`step.count` via `StepApiRuntime`; login broker; `inScreenshots`; recorder crops; ending rings on entering `[use computer]`; report `highlighted`; live test; measuring step-time cost on SecureBank. | done, 82a75077 |
| 3 | Code-behind and tool page wrapper with its `instanceof`/argument-forwarding tests; the `highlight` run setting across the Sessions API, MCP, `get_run_settings` and a VS Code setting. | done, 23d4bf82 |

---

## 15. Prototype record (historical)

Kept as the record of the feasibility study that preceded the build. It
measured a throwaway construction, not the shipped code: one element per ring,
drawn through `locator.evaluate`, where the code draws two elements per ring
through `locator.evaluateAll` (§3.3).

A throwaway script (not committed) using Playwright 1.59.1's bundled
Chromium, Firefox and WebKit served pages with
`Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'`
(and `style-src 'none'` for the adopted-sheet case). It drew the §3.3
construction through `locator.evaluate`.

| Check | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| CSP live (style attribute and `<style>` refused) | yes | yes | yes |
| Overlay produced CSP violations | 0 | 0 | 0 |
| Ring computed border under CSP | 2px | 2px | 2px |
| `@keyframes` in an adopted sheet under `style-src 'none'` | applied | applied | applied |
| `@media (prefers-reduced-motion)` in that sheet follows `emulateMedia` | yes | yes | **no** |
| `matchMedia('(prefers-reduced-motion: reduce)')` follows it | yes | yes | yes |
| Shown in the top layer (`showPopover`) | yes | yes | yes |
| `elementFromPoint` at the target's centre | the target | the target | the target |
| Click on the ringed target | ok | ok | ok |
| `body` aria snapshot, `body.innerText`, `getByText` count | unchanged | unchanged | unchanged |
| `locator('body *').count()` / `locator('*').count()` | same / +1 | same / +1 | same / +1 |
| iframe target, open shadow target | ringed | ringed | ringed |
| Target removed mid-ring | ring gone within 2 frames | same | same |
| Page's `popover="auto"` menu stays open | yes | yes | yes |
| Modal dialog stays modal, focus stays in it, click inside works | yes | yes | yes |
| Ring visible above a `z-index: 2147483647` fixed header | yes | yes | yes |
| `document.getAnimations()` sees the closed-root ring | no | no | no |

Against Steptix's own capture: `captureDomSnapshot` from the main checkout's
`dist/` (capture-dom.js identical to this branch's) returned one extra line,
`<steptix-highlight><!-- hidden: aria-hidden --></steptix-highlight>`, with a
ring live. That is the §4.1 skip's reason.

WebKit reported two `style-src-elem` violations during the run. They were
traced to Playwright's own `page.screenshot` (zero violations before the
capture, one after each), not to the overlay.

---

## 16. Implementation history

A log for the curious, one entry per phase and review round. The body above is
the reference; each entry names where its outcome now lives. The spec itself
was written in 7bc94860 and its decisions recorded in c0e1a6cd.

### 16.1 Phase 1 (cbd24c90)

Config, the sink, the controller, the snapshot skip and model-capture hiding,
with unit cases 1–8 (4 and 5 in all three engines); steptix-vscode 0.5.194 for
the schema.
Departures from the first draft: a removed element's ring goes on the next
frame with no fade (§3.3 item 7); the glow is `rgba()`, not `color-mix()`
(§8); the script is a function built with `new Function` from the file text,
because `evaluateAll(string)` never calls the function it yields (§3.3 item
1); the "drawn recently" record is per Page at module level, because the
executor builds options per action (§4.3); more captures are model-bound than
the draft named (§4.2); the object form is on unless `enabled: false` (§7.1);
no example in templates/init (§7.1); `resolveHighlight` takes
`{ highlight?: unknown }` to keep `npm run lint` passing (§7.1).

### 16.2 Phase 2 (82a75077)

The remaining handlers, `step.read` / `step.count`, the login broker,
`inScreenshots`, recorder crops, `[use computer]`, `highlighted` and the live
test; 0.5.195. `captureScreenshot` gained its audience parameter instead of
wrapping each call site (§4.2). `[use computer]` ends rather than hides, since
a hidden ring returns as soon as anything restores it (§6). Keyboard rings
`*:focus` `.last()` for open shadow roots (§2.2). The measured step-time cost
(§5.1) came from this phase.

### 16.3 Phase 3 (23d4bf82)

The page Proxy for code-behind and tools, the `highlight` run setting and
`steptix.highlight`; 0.5.196. A batch whose screenshots go back to an agent
says so with `screenshotsToModel`, since only the MCP client knows
`screenshots_return` (§4.2). The wrapper recognises Playwright classes by name
and wraps whatever a method returns, rather than a fixed list (§2.3).
Compiled conditions are not wrapped (§2.1). A `default` is sent only to clear
an earlier override (§7.2). highlight.js is read on first use, after a bundled
tool failed to load with it read at import (§3.3 item 1).

### 16.4 Review round 1 (49325e78)

Compile runs keep rings out of every capture, because the repair model sees a
compile run's failure screenshot (§4.2). The run's own config decides a report
capture's audience (`reportAudience`), so a `screenshotsToModel` batch hides a
ring a login drew to be shown. Hiding became a count on the document, so
overlapping captures cannot show the rings to each other. A mark that finds
nothing waits for its element, bounded at 5 s (§5.5). "Drawn recently" gained a
1 s margin and a restamp when the draw lands. Diagnosis falls back to the
step's picture only for a never-ringed page. 0.5.197.

### 16.5 Review round 2 (fd14721c)

The tab peek's forced hide always asks, because the ring may be another
process's. Hide, restore and end became a few synchronous DOM writes per
committed frame, never calling the page-reachable handle, with a 500 ms
budget, so a planted host or a never-answering iframe cannot stall a capture
(§4.3 rules 2–3). The count became per-capture entries that lapse (then 20 s).
A draw ignores a host whose `mark` is not its own code (§3.3 item 9). A late
ring waits only while its act does (`MarkOptions.settled`), and the keyboard
mark never waits (§5.5). `max` counts rings drawn (§3.3 item 10). The snapshot
skips only Steptix's own host (§4.1). VS Code commits its memory through a
closure the request owns (§7.2). 0.5.198.

### 16.6 Review round 3 (4ad55928)

A model capture waits until every frame's hide has landed or the ring's
lifetime has passed, because the raw CDP peek and the screen grab do not wait
for frames; failing that, `RingsNotHiddenError` and no picture (§4.3 rule 6).
"Drawn recently" also became process-wide, for two Page objects on one CDP tab.
A late wait ends only on navigation of its own frame or the main frame, so a
rotating ad frame no longer ends it. Tools and code-behind get no highlighter
on the computer surface, and `endRings` cancels late waits (§6). A forced peek
writes nothing on a tab never drawn on. The hide entry's lapse became 60 s,
above the longest capture (§4.3 rule 1). The page-side limits went into §3.3
item 9 and the README.

### 16.7 Review round 4 (973b51ad)

A frame that drew a ring got no lifetime escape, because a busy frame ran
neither the ring's fade (then a main-thread animation, since `box-shadow` was
in its keyframes) nor its retire; round 5's follow-up withdrew this for model
captures. Draws began answering which document drew. The cross-Page record was
scoped to the tab by CDP target id, so one session's ring no longer put every
page in the process into the strict wait (§4.3 rule 9). The login broker draws
nothing on the computer surface (§6). A locator that enters a frame ends its
late wait when a frame below its outer frame navigates, with a test pinning
`_frame` / `_selector` (§5.5). `resetRingRecordsForTests()` stopped later
cases passing vacuously (§5.4).

### 16.8 Review round 5 (5dcf01da)

Held frames became Playwright Frame objects rather than URLs, because
`pushState` or a hash change orphaned a URL-keyed entry: the frame was treated
as never having drawn, and nothing could clear the entry (§4.3 rule 4). The tab
record holds every frame for other Page objects until they answer. Stale
records are pruned on close, and each drawing page confirms its own frames
after the ring (§4.3 rules 8 and 10). Target-id lookups are bounded at 1 s,
since attaching to a busy tab takes as long as the busy spell. `endRings` gives
a held frame its lifetime plus 2 s instead of 15 s, since an unanswering frame
is usually held by a modal (§4.3 rule 14).

### 16.9 Review round 5 follow-up: the fade runs on the compositor (a88809a4)

The cause of every "busy frame shows the ring" residual was that `box-shadow`
cannot composite, so the one-element ring's whole animation ran on the main
thread. Each ring became two elements: the envelope animates only opacity and
transform, the glow carries the border and pulse (§3.3 item 11, §8). Measured
in Chromium: a busy OOPIF grabbed after the lifetime went from 1991 ring pixels
to 111 (clean); a blocked main frame's compositor frames fade on schedule,
headless and headed. Firefox and WebKit could not be observed while blocked
(§12). With the fade composited, "lifetime passed" was again enough for a frame
that drew, and round 4's strict rule was withdrawn; `endRings` kept its
lifetime-plus-2 s cap as margin for engines whose fade is unmeasured.

### 16.10 Review round 6: the page's answer decides, not the clock (82a2ef03, fb9008e8)

Both findings came from a safety decision made on Node's clock while the
page's clock had stopped. H1: a ring whose frame blocks before its first paint
starts only on unblock; an answer landing after the lifetime dropped the
entry, and the next capture showed the ring (1153 pixels, 3 of 3 runs). H2: a
draw queued behind a 5.5 s keydown landed after `until` had passed, during the
capture (1–3 leaks in 6 runs). Now an entry goes only when its frame answers
that no Steptix host is left (§4.3 rule 7), with confirmation retries 1 s
doubling to 30 s, ten times; and a draw in flight counts as a ring of ours
whose hide must land, with no clock escape, while `endRings` waits for it
first (§4.3 rule 5). After the fix: model captures clean (65) while a raw grab
of the same moment still showed the ring, and 12 of 12 keyboard runs clean.
Three tests that had advanced the clock past a still-live ring now end it
first. fb9008e8 pinned the 11-probe cap and recorded the two residuals a
seventh review round proved (§12): the process-wide gate held open by a page
that keeps its ring alive, and no picture behind an iframe busy past 15 s.

### 16.11 Spec audit

An audit of the rewritten spec against the code found two gaps in "a model
never sees a ring".

- **A drawing Page closing deleted its tab's record** (`forgetPage`), even
  with the ring still live. A model capture through another Page on that tab
  then found no record and shot unhidden: an errand that drew and detached
  within a few seconds left a ring in the session's next `get_page_content`.
  The record now stays when its last drawer disconnects from a tab that
  stays open, and holds every frame for the other Pages until one of them
  confirms "no host", or for at most 60 s (§4.3 rule 10).
- A focused review of that fix (review 14) found it inferred tab death from
  `browser.isConnected()` at the next lookup. On a CDP detach the Page's
  `close` fires 0.3–2.8 ms before the Browser reports disconnected, so a
  capture in that gap deleted the live record. And `closeBrowser` closes the
  context before the browser, so a dead tab's record was kept 60 s, and every
  highlight-off Page paid an attach. On Playwright 1.59.1 a persistent
  context also has a Browser object, so "no Browser means persistent context"
  was false.
  - Now the owner of the teardown says it: `closeBrowser` calls
    `pagesDetaching` before severing a CDP connection, and only that
    orphans a record. Every other close drops it at once.
  - An `unref`'d timer drops an orphan after `TAB_ORPHAN_KEEP_MS`, and no
    closure keeps a Browser alive.
  - Tests: a capture started inside the detaching Page's `close` event still
    hides (it failed before the fix). An off page pays nothing after
    `page.close()`, `closeBrowser` on a launched session, `browser.close()`,
    a persistent context's `close()`, and `closeBrowser` on a CDP attach
    that opened its tab. All but `page.close()` failed on 66ed37e3. The
    60 s expiry and the drop-at-once rule are covered with fake timers.
- A second focused review (review 15) found the hold lost when the Page
  left on the tab had drawn there before. It counted as the sole drawer, so
  its own long-confirmed record decided, and a late-starting ring of the
  Page that left went unhidden. A detach now marks the record `departed`,
  and no Page is the sole drawer until an every-frame-clear round (§4.3 rule
  10). The fake-page test fails on 1ddea906.
- A third focused review (review 16) found that hold unbounded while
  another drawer stayed idle, though §12 promised 60 s. No timer was armed
  unless the record was orphaned, and the detach raised `heldUntil` even
  after the departing Page's rings were all confirmed. Every new
  highlight-off Page paid an attach at +300 s.
  - Now a detach holds only when the Page left something unconfirmed.
  - The same `unref`'d 60 s timer ends any departure's hold.
  - A lapsed record is not reused for a new ring.
  - Measured with review16/q1.mjs and q1w.mjs: costs end within 60 s of the
    detach in every scenario, or at once when nothing was left unconfirmed.
  - Seven fake-page cases each catch one reverted fix.
- A fourth focused review (review 17) found that scenarios R (a ring drawn
  while a departed drawer's record lived) and V (two drawers, one leaving
  with nothing unconfirmed) left `heldUntil` raised for good. It also found
  that a host that never retires reached model captures 60 s after a
  detach, because the hold timer or the fresh-record rule dropped the record.
  It was the fifth review in a row to find holes in the same bookkeeping.
- **That bookkeeping is gone; the design is now §4.3 rules 9 and 10.**
  - Cross-Page tracking is scoped to the CDP endpoint, so only Pages that
    can share a tab take part.
  - While a tab record exists, every Page on the tab holds every frame.
  - The record ends only when confirmed clear through any Page, when the
    tab closes, or when the endpoint disconnects.
  - Removed: `departed`, `orphaned`, `heldUntil`, `departedHeldUntil`,
    the hold and orphan timers, the sole-drawer exemption, the fresh-record
    rule, `anyRingUntil` and `drawsInFlight`.
  - Measured on real CDP (review18/):
    - **Off pages in another browser:** pay nothing in every scenario
      (X, Y, Z, XB, W, R, V).
    - **Off pages on the same endpoint:** pay one lookup only until the
      record is confirmed, except in W (above).
    - **A host that never retires:** hidden from B and C at +8, 30, 62, 70,
      90 and 200 s.
  - The fake-page tests in tests/highlight-hide-landed.test.ts that pinned
    the removed mechanisms were replaced by tests of the new rules. That
    round claimed each rule, broken alone, fails at least one of them. Three
    guards did not: the draw-in-flight checks in `confirmTab` and in
    `confirmQuietly`, and the `pendingAt` wait in `tabRecordOf`. Review 19
    found them, and §16.12 adds the tests.
- The same review found tests/highlight-cdp-tab.test.ts order-dependent: a
  10 s ring recorded by one case made another's off page pay a lookup.
  - The file now calls `resetRingRecordsForTests()` before each case.
  - Every highlight test file was run shuffled, with seeds 1, 7, 10, 42 and
    2026, and passed.
- **The diagnosis fallback forgot that a page had ever drawn.**
  `pageEverRinged` read the records, which page close and `endRings` clear,
  so `diagnoseFailure` on a closed page could send the step's report picture,
  ring and all. It now reads `everRinged`, a `WeakSet` that is never cleared.

Each fix has a test that failed before it:
- tests/highlight-cdp-tab.test.ts: a third CDP connection draws and
  disconnects (through `closeBrowser` since review 14), and the other Page's
  capture still hides;
- tests/highlight-paths.test.ts: still "ever ringed" after `endRings` and
  after close.

The audit also corrected stale code comments and several spec statements:
- the off path of the CDP peek;
- the gate's own-record condition;
- `max` marks never late-waiting, `readTable` included;
- the loader's messages;
- the window scope of `steptix.highlight`;
- what carries `highlighted`;
- the measured read and count costs.

### 16.12 Review 19: what a Page cannot see or tell

A fresh review of 7a1c1790 found one high, three mediums and two lows.

- **High: cross-site frames that loaded before an attach were never asked.**
  To that connection they read `url() === ''` until they navigate, and
  `framesToAsk` skipped `''` as uncommitted. A click in such a frame left
  about 3500 ring pixels in 3 of 3 model captures. Every attached frame is
  now asked; a frame with no address that holds nothing of ours gets the
  500 ms budget, and an unanswering frame is never clear (§4.3 rules 3, 8
  and 10).
  - (Corrected in §16.13: the figure below timed a trivial `fn`, not a
    screenshot, and such a frame is now not asked at all.) The bound for the
    round-2 concern (a never-committing ad): 1027 ms per
    capture while a ring may be up (review4/slowframe.mjs).
  - Test: tests/highlight-cdp-tab.test.ts launches Chromium with
    `--site-per-process`, loads a 127.0.0.1 page with a localhost iframe,
    attaches afterwards, and draws in the frame. It fails on 7a1c1790.
- **Medium: a lookup that ran out of time counted as "no record".** A busy
  tab answered in 2756 ms, and the capture showed 1683 ring pixels. Such a
  page now holds every frame and confirms nothing (§4.3 rule 9).
- **Medium: rounds accepted answers that predate a draw.** Stamps are now
  counted per page and per endpoint, and a round confirms nothing when one
  came while it ran (§4.3 rule 10). This was 1877 ring pixels in 3 of 3
  runs, and is now 0.
- **Medium: three guards had no test** (§16.11 corrected). Each now has a
  fake-page test that fails when the guard is removed.
- **Low: a stamp during an unhidden picture.** The picture is retaken, once,
  through the hide (§4.3 rule 11). This was 3 of 6, and is now 0 of 30.
- **Low: a record outlived a tab the user closed.** A lookup now drops
  records of tabs that are gone, so the user's close costs one lookup, not
  one per new Page (§4.3 rule 9).
- **One expectation change:** tests/highlight-peek.test.ts asked no frame
  with no address. It now asks one, and checks that the peek still takes
  its picture when the frame never answers.

### 16.13 Review 21: frames with no document, and retakes in scope

- **High: a lazy iframe stalled every model capture on CDP pages.**
  - Under a tab record every frame was held, so the review-19 500 ms branch
    for an address-less frame never applied.
  - A `loading=lazy` iframe below the fold (`''` or `':'`) waited out the
    ring's lifetime and never answered, so the tab was never confirmed.
  - Measured: 4530 ms after the action, then about 1040 ms on every capture.
    With a draw in flight it took 15.5 s and gave no picture.
- **The fix is a document test, from measurement (§4.3 rule 3).**
  - A frame with no address and no CDP session of its own has no document.
    It is not asked, and its held entries are dropped.
  - A frame with no address that does have a session of its own is a
    cross-site frame that loaded before the attach: it is asked like any
    other.
  - This rested on probing each frame kind. A no-document frame reads `':'`
    when attached after load and `''` when Playwright saw the load, so the
    address alone could not tell. Only the own-session check separated the
    two cases.
- **After the fix:**
  - lazy-persist.mjs: tens of ms per capture in all three modes.
  - inflight-lazy.mjs: about 1035–1080 ms (the page's own 1 s block) with a
    picture every time, for cdp lazy, cdp none and launched lazy.
  - review19/oopif-leak.mjs and the `--site-per-process` test stay at 0
    ring pixels. That test now also checks that the lazy frame beside it is
    never asked.
- **Also:**
  - draws in flight are read as a capture waits (rule 5);
  - a restore is not waited on where its hide never landed (rule 12);
  - the retake check runs on the hide path too, and an endpoint-wide stamp
    retakes only a page whose own tab has a record (rule 11).
- **Expectation changes:**
  - tests/highlight-peek.test.ts again expects a frame with no document not
    to be asked. That is the original rule, now on a measured basis.
  - newframe-det.mjs's `fn` added frames on every call. A retake runs `fn`
    twice, so the re-run (review22/) adds them once.

### 16.14 Review 23: frames Playwright gives no address

- **High (a regression from §16.13): a ring in a `javascript:` frame was
  never hidden.**
  - `<iframe src="javascript:false">` that the parent fills reads `''` or
    `':'`, yet has a live document in the page's process. So does a frame
    left on its initial document by a 204 or a download.
  - Skipping every no-address frame left 3300–4100 ring pixels on launched
    Chromium, CDP, Firefox and WebKit (review23/docless.mjs).
- **The fix: in-process frames with no address are asked through their
  `<iframe>` element in the parent** (§4.3 rule 3).
  - The registry call reaches `contentDocument` from there, which works for
    every such frame, since they share the parent's origin.
  - It never enters the frame's own context, so a lazy frame still cannot
    hang a capture.
  - The hide itself goes the same way: through the parent, on the frame's
    document.
  - Out-of-process frames are still asked themselves.
- **After the fix:**
  - docless.mjs: 0 ring pixels for javascript:false, javascript:void(0) +
    document.write, 204 and download frames, launched and attach-after-load.
  - lazy-persist.mjs: tens of ms per capture in all three modes.
  - The new tests (a launched one and a `--site-per-process` CDP one) fail
    on 65d0cd98.
- **Low: the lifetime edge.**
  - A wait whose timer fired before the clock reached the lifetime now waits
    out the remainder (rule 6).
  - A page that cannot tell its tab now waits on the endpoint's draws in
    flight (rule 5).
- **Low: a timed test.** tests/highlight-cdp-tab.test.ts classified frames
  by racing `evaluate` against a 1 s timer. It now reads each frame
  element's `id`.

### 16.15 Review 24: painted, not just landed

- **High (it predates §16.13): a hide that had landed in an out-of-process
  frame's DOM was not yet painted.**
  - A screenshot composites that frame's last painted picture, so captures
    0.9–1.9 s after a click (a static ring, nothing for the frame to paint)
    showed the whole ring:
    - through Steptix's own launch, 3–5 of 8;
    - through CDP `--site-per-process`, 10 of 40;
    - from a `javascript:` frame inside an out-of-process frame, 8 of 40.
  - review19/oopif-leak only captured at 400 ms, while the pulse still made
    the frame paint.
- **The fix:** a hide that changed a host, and an end that removed one,
  resolve only after two animation frames in that document, 200 ms at most
  (§4.3 rule 2).
  - **Measured with oopif-stale.mjs, 0 leaks at every delay** (+0.4, 0.9,
    1.4, 1.9 and 2.4 s):
    - launched oop, 8 runs;
    - Steptix's launch, oop, 8 runs;
    - CDP oop, 40 runs;
    - CDP oopjs, 40 runs;
    - launched oopjs, 16 runs;
    - same-origin and main frame, 8 runs each.
  - **The test** (tests/highlight-cdp-tab.test.ts, `--site-per-process`,
    reduced motion so the ring is static) takes 25 captures and expects 0
    ring pixels in every one. It failed 3 of 3 times on e79b31e7. It also
    checks the mechanism directly: the frame has run an animation frame
    since its hide landed.
- **Medium: a lookup of the `<iframe>` element that outran its 1 s budget
  on a busy parent was taken as "frame gone".** The frame was skipped and its
  held entry dropped: 1934 ring pixels in 3 of 3 runs (review24/busy-js.mjs).
  - A pending lookup now keeps the frame asked, chained on the lookup.
    busy-js gives 0 pixels in 3 of 3 runs, launched and CDP.
- **Medium: element handles were never released.** They are now disposed
  when their frame detaches. handles.mjs, 200 rotations: 1 live element,
  the attached one.
- **Low:** rule 2 and §12 corrected.

### 16.16 Review 25: wait only for a paint there is

- **Medium: an out-of-view cross-site frame holding a ring cost every
  capture the whole paint budget, for as long as it stayed out of view.**
  Chrome does not draw that frame, so it runs no animation frames: each
  hide waited out the 200 ms timer. Its ring does not retire either while
  it is out of view (§12), so the cost had no end. review25/offpersist.mjs,
  a model capture every few seconds for 45 s after a 3 s ring:

  | Mode | 37eff1f8 | Now |
  | --- | --- | --- |
  | launched | 220–251 ms | 11–38 ms |
  | CDP | 216–252 ms (766 once) | 13–28 ms |
  | Steptix's launch | 226–261 ms | 22–46 ms |

  - **The fix:** the controller stamps each animation frame it runs on
    `<html>` (§3.3 item 7), and a hide or end waits for a paint only where
    the stamp is under `DRAWN_WITHIN_MS` (100 ms) old (§4.3 rule 2).
  - **A frame that was busy is still waited on.** A hide queued behind a
    1.5 s block lands when the block ends, with a stamp as old as the
    block. Chrome runs the frame's pending animation frame before the
    queued evaluation, so the stamp is fresh by then and the hide waits
    (review25/busy-oop.mjs: it waited in 40 of 40 runs, and 0 showed the
    ring; launched, CDP and Steptix's launch, with and without reduced
    motion, model capture and peek).
  - **The test** (tests/highlight-cdp-tab.test.ts) counts the frame's
    `setTimeout` calls during a capture: 0 in a cross-site frame out of
    view, at least 1 in one in view. It failed on the stamp check removed
    (1 call), and on the stamp itself removed.
- **Low: the main frame's hide waited for a paint, which buys nothing.**
  `page.screenshot` and the peek's `Page.captureScreenshot` draw the main
  document afresh. The main frame's hide no longer waits; its end still
  does, as does every hide in a child frame, a `javascript:` frame inside
  an out-of-process frame included.
  - oopif-stale.mjs, 0 leaks at every delay: main frame, launched 8 and CDP
    16 runs, through the model capture and through the peek; oop, oopjs
    and same-origin frames as in §16.15 (CDP oop and oopjs 40 runs each).
  - The test counts the main frame's `setTimeout` calls: 0 during a hide,
    at least 1 during an end. It failed with the main frame's hide waiting.
  - review25/cost25.mjs, a page with no frames, model capture after a click
    with a ring in the main frame, median of 10, ms:

    | Mode | Off: at once, 1.5 s later | On, 37eff1f8 | On, now |
    | --- | --- | --- | --- |
    | launched | 34, 39 | 68, 70 | 53, 41 |
    | CDP | 34, 38 | 69, 70 | 52, 51 |
    | Steptix's launch | 65, 60 | 133, 131 | 98, 64 |

    What is left straight after the click is the hide and restore round
    trips and the picture having to draw the hide (§12).
- **Low, spec:** rule 2 said nothing waits with nothing to change, while a
  hide waits wherever a host is, even one an overlapping capture already
  hid; and that the call runs no page code, while the wait calls the
  frame's own timers. Both are corrected, and §3.3 item 9 says what a page
  that replaces those timers can do. §12 said the wait could stretch toward
  a second in a background tab; Playwright keeps those pages `visible`, so
  the 200 ms cap holds. Two bullets of rule 3 that had run together are
  split.
- **Checked, not a regression:** a model capture of a minimized window
  through `page.screenshot` (review25/bg-oop.mjs `min model`) gave no
  picture after 30 s. It does the same with the highlight off and no ring
  ever drawn (review25/min-probe.mjs): Playwright's screenshot waits for a
  frame the minimized window does not produce, as `captureTabScreenshot`'s
  comment records. The peek, which starts a screencast first, gave 0 ring
  pixels there.

### 16.17 Review 26: the frame's own clock, and tests that outlive their ring

- **Medium (a regression in 6762bc15, beside a bug that predates it): a
  frame asked through its parent was judged on the parent's clock.** The
  frame's controller stamps its animation frames and lapses its hide
  entries on the frame's own `Date.now`. Through the parent, the hide ran in
  the parent's realm and read the parent's, which a page can shift.
  review26/skew-stale.mjs: a `javascript:` frame inside an out-of-process
  frame whose page shifts its `Date.now`, five captures per run after a
  click.

  | Parent's clock | 6762bc15 | Now (CDP 40 runs, launched 16) |
  | --- | --- | --- |
  | 5 s ahead | 18 of 200 showed the ring, CDP (the review: 21 of 200, and 8 of 80 launched) | 0 of 200, 0 of 80 |
  | 300 ms ahead | the review: 8 of 80 launched | 0 of 200, 0 of 80 |
  | 0, or 5 s behind | | 0 of 200, 0 of 80 |
  | 70 s behind | 40 of 40, CDP (37eff1f8: 20 of 20) | 0 of 200, 0 of 80 |

  - **The fix:** every clock reading in `registryCall` is the changed
    document's window's `Date.now`: the stamp's age, the entry's lapse time,
    and which entries are live (§4.3 rules 1 and 2). No other page-side code
    reads a clock across realms: the controller and its handle read their
    own document's.
  - **The tests** (tests/highlight-paths.test.ts) shift the parent's
    `Date.now` beside an in-process `javascript:` frame.
    - 5 s ahead, the hide still waits: a `setTimeout` in the frame.
    - 70 s behind, the host is still hidden an animation frame later inside
      the capture.
    - Both failed on 6762bc15.
    - A third case runs no animation frames in the frame, with the parent
      70 s ahead. There the hide alone decides which entries are live; in a
      drawn frame the controller re-applies them on its own clock at its
      next frame, before the paint wait ends, so only this case can tell.
    - Each of the three readings, put back on the parent's clock, fails one
      of the three.
- **Medium: a test that could outlive its own ring.** The review-24 case's
  25 captures could run past the ring's 10 s lifetime on a loaded machine.
  The mechanism check then found no hide (−1), or the case ran out of time:
  3 of 3 failed at 12, 24 and 36 busy threads.
  - The ring is now drawn again every five captures and before the
    mechanism check, and the case checks it is still up after the last
    capture. Its budget is 120 s.
  - The cross-site and `javascript:` cases wait for the restore as a
    condition: the restore is awaited within 500 ms, which a loaded machine
    can outrun.
  - The cases that launch, connect to or close browsers, and the hooks, have
    budgets of 90–120 s. At 24 and 36 threads those were what timed out
    next.
  - The file passed 5 of 5 times quiet, and once each at 12, 24 and 36 busy
    threads (review25/hog.cjs), taking 59 s, 240 s and 277 s.
- **Low, spec:** rule 2 now says why skipping the wait is safe where the
  stamp is stale but a capture does draw: a background tab, and a frame
  scrolled back into view. §3.3 item 9 says the clock and timers are the
  changed document's own, through the parent too.
- **Low, residual:** one capture showed the ring with the wait taken, at 48
  busy threads (§12).
- Re-measured on the fix, with every leak harness at 0:
  - oopif-stale in every mode, model capture and peek;
  - docless, busy-js, busy-oop, newframe-det and race;
  - offpersist: 12–53 ms per capture;
  - cost25: on 52, 55 and 96 ms against off 34, 36 and 65 (launched, CDP,
    Steptix's launch).

### 16.18 Review 28: comments and docs only

Stale and orphaned comments fixed, the host's popover events recorded (§12), and §2.2's `executeType` row says a `type` aimed at a `<label>` rings the label; no behaviour changed.

# Interaction highlight: show which element each action touched

**Status:** Accepted 2026-10-14, with the decisions in §13. Nothing here is implemented yet.
**Date:** 2026-10-13
**Audience:** the person deciding whether to build it, then the implementation agent
**Depends on:** `executeAction` (src/browser/actions.ts), the DOM capture
(src/browser/scripts/capture-dom.js), the run-settings resolution
(src/config/run-settings.ts), and the recorder toolbar's in-page pattern
(src/browser/scripts/record-toolbar.js)

---

## 1. Summary

When the option is on, every element Steptix clicks, types into, selects,
hovers, drags, uploads to, reads or counts gets an animated ring for about 3 s.
The ring then fades out. The point is to watch a run, live or in its video, and
see which element each action touched. A project turns it on in
`steptix.config.json`:

```json
{ "browser": { "highlight": true } }
```

**Verdict: feasible, and cheap for the paths that matter most.** The proof is
measured rather than reasoned about. A throwaway prototype (§15) drew the
recommended overlay in Chromium, Firefox and WebKit, on a page whose CSP blocks
both inline style attributes and `<style>` elements. Across the three engines:

- the overlay drew with no CSP violation;
- clicks and fills still landed on the element under the ring;
- `elementFromPoint` still answered the element under it;
- the aria snapshot and `body.innerText` did not change;
- iframe and open-shadow-DOM targets were ringed in the right place;
- a modal `<dialog>` and an open `popover="auto"` menu stayed open.

One thing it does break must be fixed in the same change, and the prototype
proved that too. Steptix's DOM capture walks every child of `<html>`, so the
real `captureDomSnapshot` emitted
`<steptix-highlight><!-- hidden: aria-hidden --></steptix-highlight>` into what
the AI reads (§4.1).

The recommendation in one paragraph:

- **Where it hooks:** a fire-and-forget `mark(locator, kind)` call at the act
  site of each element handler in `executeAction`, on the final Locator.
- **How it draws:** a page script draws a ring in an overlay that cannot be
  clicked. The overlay is a `<steptix-highlight>` host with a closed shadow
  root, put in the browser's top layer as a manual popover. It is styled by an
  adopted stylesheet and animated with Web Animations. This is the same
  construction the recorder toolbar already ships for the same reasons.
- **What is kept clean:** the DOM capture skips the host, and the highlight is
  hidden for any screenshot that goes to the model.
- **Off by default.**

Phase 1 covers every AI action on every engine, every frame and every CDP
browser. Compiled code-behind and fixture tools call Playwright directly. They
come last, through a wrapper with known escape routes (§2.3).

### 1.1 Current code facts the implementation starts from

- There is no highlight, demo mode or show-cursor feature. The nearest
  watch-the-run features are `browser.slowMo` (src/config/types.ts:136, passed
  to Playwright at src/browser/manager.ts:1488) and `browser.video`.
- `executeAction(page, action, baseUrl, signal, options)`
  (src/browser/actions.ts:856) is the one dispatcher for AI actions. It
  resolves the frame with `resolveLocatorRoot` (:32) and then switches on the
  action at :1085. Every element handler builds its own Locator from `root` and
  the final selector. No shared Locator object or wrapper exists.
- `ExecuteActionOptions` (actions.ts:680) already carries one per-project
  `browser.*` value per action: `ambiguousTarget`. It is built from
  `config.browser` at src/runner/step-executor.ts:3937-3941. That is the
  precedent for how a highlight setting reaches the handlers.
- The recorder already injects UI into pages under test.
  `<steptix-recorder>` and `<steptix-recorder-pick>` are closed-shadow-root
  hosts on `<html>`, shown as manual popovers. They are styled by one adopted
  constructable sheet plus per-property `style.setProperty`
  (record-toolbar.js:9-21, 411-423, 2346-2369). That pattern was measured
  working under `default-src 'none'; style-src 'none'; script-src 'none'` and
  Trusted Types (docs/specs/SPEC-record-steps.md, toolbar section). It is kept
  out of the DOM capture by being **removed before a run**
  (src/server/session-manager.ts:2721), not by a filter. A highlight exists
  *during* a run, so it needs a filter.
- Screenshots go through `captureScreenshot` (src/browser/screenshot.ts:32), a
  plain `page.screenshot` with no `mask`/`style`. The pre-turn capture
  (step-executor.ts:2771-2777) is what the model sees when `ai.sendScreenshots`
  is on. The post-action capture (:4057-4064) feeds only the report
  filmstrip, as its own comment says.

---

## 2. Where actions happen, and the hook point

### 2.1 Every path that touches an element

| Path | Where | Reaches `executeAction`? |
| --- | --- | --- |
| AI steps: click, double/right-click, hold | `executeClick` actions.ts:1438. A hidden checkbox or radio clicks a stand-in label or ancestor via `hiddenToggleClick` (:1561). | yes |
| type / fill | `executeType` :1836, with a click-then-keyboard fallback for non-fillable targets | yes |
| select | `executeSelect` :2071 | yes |
| drag | `executeDrag` :2294. Source and destination Locators, then `page.mouse` at coordinates, with `dragTo` as fallback. | yes |
| upload | `executeUpload` :2570. Visible input, chooser click, or a hidden `input[type=file]`. | yes |
| hover | `executeHover` :2634 | yes |
| dismiss | `executeDismiss` :3608 | yes |
| keyboard / keypress | `executeKeyboard` :3652. Whatever has focus; no selector. | yes |
| read, read of every match | `executeRead` :3860, `executeReadMultiple` :3933 | yes |
| count | `executeCount` :3722 | yes |
| readTable | `readTableRecords` :4433 | yes |
| scroll with a selector, wait | `executeScroll` :3586, `executeWait` | yes (but see §2.2) |
| Skills | src/skills/expander.ts only expands markdown, and the steps run through `executeStep` | yes |
| MCP `run_steps`, errands | through `executeStep` (src/server/errand-runner.ts:976) | yes |
| Code-behind `step.read` / `step.count` | `recordedRead` → `executeAction` (src/codebehind/execute.ts:835) | yes |
| **Code-behind entries** | `entry.run(ctx)` (execute.ts:349) with the raw `ctx.page` (`CodeBehindContext`, src/codebehind/types.ts). Generated code calls `page.locator(…).click()` directly. | **no** |
| **Fixture tools** | `ToolContext.page` (src/tools/types.ts:62-64) | **no** |
| **Login broker** (`log_into_site`) | `typeInto` / `submitLogin` (src/credentials/login-fields.ts:279, :296), Frame locators | **no** |
| `extract_csrf` | src/api/csrf-handler.ts:72-95, a page-level read for an API call | no |
| `find` / `expand` | `findInDom` / `expandDomSubtree` (src/browser/dom-cleaner.ts:865, :988). These read for the model's context, not for the test. | no |
| Assertions | AI-generated JS through `page.evaluate` (step-executor.ts:4637, :4808). Node never learns which element was checked. | no |
| Recorder | observes the human; performs nothing | n/a |
| `[use computer]` | nut.js on the real screen; no DOM (§6) | n/a |

**Engines and CDP do not add paths.** CDP-attached browsers
(`connectOverCdpSession`, manager.ts:1601) hand the same Playwright `Page` to
the same handlers. Firefox and WebKit differ only at launch (manager.ts:1497-1519).
A hook on a Locator is engine- and CDP-agnostic by construction.

### 2.2 Recommended hook: the act site in each `executeAction` handler

Add one call, `mark(target, kind)`, in each handler, on the **final** Locator,
immediately before the Playwright call that acts or reads. It is synchronous,
returns nothing, and is not awaited (§5.1).

| Handler | What is marked | Kind |
| --- | --- | --- |
| `executeClick` | the Locator actually clicked: the stand-in label for a hidden toggle, not the invisible input | act |
| `executeType` | the field (once, including the click-then-keyboard fallback) | act |
| `executeSelect`, `executeHover`, `executeDismiss` | the target | act |
| `executeDrag` | the source, then the destination | act |
| `executeUpload` | the visible input or chooser trigger; nothing for a hidden input (it has no box) | act |
| `executeKeyboard` | the focused element, if it has a box (phase 2) | act |
| `executeRead`, `executeReadMultiple` | each match, capped (§5.3) | read |
| `executeCount` | each counted match, capped | read |
| `readTableRecords` | the table element: one ring, not one per cell | read |

**Why per handler rather than one call at the top of `executeAction`?** The
top of `executeAction` knows only `root` and `eff.selector` (:963). The
handlers then change what they act on. A hidden toggle clicks a different
element (`clickInPlaceOf`, :1615). A drag has a second target. An upload may
fall back to a hidden input. Reads and counts act on many elements.
`singularTargetOf` (:2674) knows the singular target, but it runs only when
`measure` or `ambiguousTarget: 'fail'` is on (:995), and a hidden toggle skips
it (:1000). Highlighting the selector rather than the element touched would
show the wrong element in exactly the cases the feature exists for.

**Rule: mark at the act, never in a probe.** Several helpers touch the target
without acting on it:

- iframe promotion's `count()`;
- the ambiguity count;
- `uncoverForTyping` (:1898);
- `pointerReaches` (:2387);
- `waitForStableCount`.

None of them mark. That keeps one ring per action and makes "every ring is an
action" true.

**Not highlighted:** `wait` and `scroll` (they position or wait; the next
action rings the element), `find`/`expand`, AI-written assertion JS, and
`extract_csrf`. Each of these is a read for Steptix's own purposes, not an
interaction the test performs.

### 2.3 The paths that bypass `executeAction`

- **Login broker (phase 2).** Two direct calls in `typeInto` and
  `submitLogin`, on the same Frame locators they already build. That is
  explicit and exact.
- **Code-behind entries and fixture tools (phase 3).** Wrap the `page` handed
  to `entry.run(ctx)` and `ToolContext` in a highlighting wrapper, a `Proxy`.
  - It wraps the factories `locator`, `getBy*`, `frameLocator`, `first`,
    `last`, `nth`, `filter`, `and` and `or`. It uses a WeakMap cache so one
    target always yields one proxy.
  - It calls `mark` before `click`, `dblclick`, `tap`, `fill`, `type`,
    `pressSequentially`, `press`, `check`, `uncheck`, `setChecked`,
    `selectOption`, `hover`, `setInputFiles` and `dragTo` (act), and before
    `textContent`, `innerText`, `inputValue`, `getAttribute`,
    `allTextContents`, `allInnerTexts` and `count` (read).
  - It also wraps the selector-taking page shorthands (`page.click(sel)`
    etc.).

  This is **best effort**, and the spec says so. Known escapes:
  - `ctx.context.pages()` and `ctx.browser.contexts()` return unwrapped pages;
  - `page.mouse` / `page.keyboard` at coordinates have no element;
  - `page.evaluate(() => el.click())` acts inside the page.

  Generated code rarely uses any of these:
  src/codebehind/entry-actions.ts already classifies them as acting calls
  that the review pass watches. The wrapper must forward `instanceof` and
  property reads to the target so Playwright's own `dragTo(target)` and
  `{ has: locator }` keep working. That needs a unit test.

**Rejected alternatives for the bypassing paths:**

- **Playwright's client instrumentation.** `connection._instrumentation`
  `onApiCallBegin` (playwright-core/lib/client/channelOwner.js, around line
  128) sees every API call on a connection, so it would cover everything. But:
  - it is private API;
  - its `on*` callbacks are synchronous;
  - it sees **all of Steptix's own internal calls** too, the probes listed
    above, with nothing that tells a probe from an act;
  - the selectors arrive in Playwright's internal form.
- **In-page event listeners** (capture-phase `pointerdown`/`input`/`change`
  via `addInitScript`):
  - they see no reads;
  - `selectOption` and `setInputFiles` dispatch synthetic events;
  - they cannot tell Steptix's input from the page's own synthetic clicks
    (label activation) or from a human using a headed window.

---

## 3. How to draw it without changing the page under test

### 3.1 The options

| Risk | A. Overlay host, closed shadow root, top layer | B. Style the element (`outline`/`box-shadow`) | C. CDP `Overlay.highlightNode` | D. Playwright `locator.highlight()` |
| --- | --- | --- | --- | --- |
| Layout shift | none: `position: fixed`, out of flow | none for `outline`/`box-shadow`, but clipped by `overflow: hidden` ancestors | none | none |
| Intercepting clicks | none with `pointer-events: none` (measured: clicks land, `elementFromPoint` answers the element) | none | none | none |
| Strict CSP | **works**: measured, 0 violations in all three engines with CSSOM + Web Animations, and with an adopted sheet holding `@keyframes` under `style-src 'none'` | `style.setProperty` works, but it writes the element's `style` attribute | not subject to CSP | Playwright's own injection |
| Changes the page's DOM | adds one host under `<html>` (sibling of `<body>`) | **mutates the element under test**: attribute MutationObservers fire, a framework re-render can wipe it, restoring the old value races the page, and assertion JS reading `getComputedStyle` sees it | no | adds `x-pw-glass` under `<html>` |
| iframes, shadow DOM | free: the script runs in the element's own frame via `locator.evaluateAll`; measured for an iframe and an open shadow root | free | needs a per-target session for out-of-process iframes | free |
| Scroll / move during 3 s | one rAF loop re-reads `getBoundingClientRect` | follows automatically | static | follows |
| Element removed | ring removed on the next frame (measured) | goes with the element | stale box | stale |
| Navigation | goes with the document | goes with the document | cleared | goes with the document |
| Overlapping highlights | yes: one ring per element | yes | **no**: one highlight per target | **no**: one glass pane, no duration |
| Animation, styling | full | limited | colours only | none |
| Engines | all three | all three | **Chromium only** | all three |
| Covers modal dialogs and z-index-max headers | yes, top layer (measured in all three) | n/a | yes | yes |
| Supported use | ours | ours | DevTools protocol | Playwright documents it as "Useful for debugging, don't commit the code that uses" it (playwright-core types.d.ts, `highlight()`) |

### 3.2 Recommendation: A

A is the only option that meets every constraint at once:

- all three engines;
- overlapping rings;
- animation;
- no mutation of the element under test;
- strict CSP.

It is also not new to this codebase. The recorder chose the same construction,
for the same reasons, and documented why (record-toolbar.js:9-21).

B is rejected because it edits the element under test. C is Chromium-only and
cannot overlap. D cannot overlap, cannot time out, and its own documentation
says not to ship it.

### 3.3 The in-page controller (src/browser/scripts/highlight.js)

One script file, loaded like `capture-dom.js` (`loadScript`,
dom-cleaner.ts:336-342), evaluated through
`locator.evaluateAll(script, { kind, durationMs, colors, max })`. Choices, each
with its reason:

1. **`evaluateAll`, not `evaluate`.** `evaluateAll` resolves the current
   matches and returns at once. `evaluate` auto-waits for an element, which
   would leave a dangling call waiting the full timeout when the element is
   gone.
2. **One host per document, created lazily and idempotently.** The host is
   `<steptix-highlight>` under `document.documentElement`. It is found again
   with `:scope > steptix-highlight` and removed when its last ring ends.
   There is no `addInitScript`: pages that were already open, CDP tabs and
   frames all just work on first use.
3. **Host hardening.** Copy the recorder's `resetHost`
   (record-toolbar.js:93-113):
   - per-property `setProperty(…, 'important')`: `all: initial`,
     `position: fixed`, `inset: 0`, `pointer-events: none`,
     `z-index: 2147483647`, and zero margin, padding and border;
   - `aria-hidden="true"`;
   - **no** `id`, `class`, `role`, `aria-live`, `open` or text. Those are what
     `DIAGNOSE_SCRIPT` (src/browser/page-state.ts:107-157) and the notice
     recorder (src/browser/notices.ts) look for.
4. **Top layer.** Set `popover="manual"` and call `showPopover()` in a
   try/catch, falling back to z-index only, as the recorder does (:423).
   Re-raise it (hide, then show) when a ring is added while a later
   `:modal`/`:popover-open` element exists, so it stays above a dialog the
   page opened after it. Measured: a manual popover leaves the page's own
   `popover="auto"` menu open, and a modal dialog stays modal and keeps focus.
5. **Closed shadow root.** One adopted `CSSStyleSheet` with the ring styles
   (§8), and rings built with `createElement` only: no `innerHTML`, so Trusted
   Types has nothing to refuse.
6. **One ring per element.** A `WeakMap<Element, Ring>` lives on the
   controller. Marking an element that already has a ring restarts that ring,
   with the new kind's colour. Different elements get separate rings.
7. **One rAF loop for all live rings.** It repositions each ring from
   `getBoundingClientRect()`. A ring whose element is disconnected fades out
   in 150 ms. A ring whose element's rect is entirely outside the viewport is
   hidden. The loop stops when no ring is live.
8. **Timing lives in the page, as Web Animations.** `ring.animate(keyframes,
   { duration })`; `animation.finished` removes the ring. There are no
   `setTimeout` calls on either side (§5.4).
9. **A registry handle for Steptix and for tests.** Store
   `host[Symbol.for('steptix.highlight')] = { rings(), hide(), restore(),
   finishAll() }`. This is needed for two things:
   - `hide`/`restore` for model screenshots (§4.2);
   - tests: measured, a ring inside a closed root is invisible to
     `document.getAnimations()`, so there is no other deterministic way in.

   The page can reach it too. All it can do is hide or end Steptix's own ring.
10. **Zero-size targets draw nothing.** A hidden file input or a
    `display: none` toggle has no box.

---

## 4. Keeping Steptix's own reads clean

### 4.1 What reads the page, and what each does with the overlay

| Reader | How it reads | Sees the overlay? | Needed |
| --- | --- | --- | --- |
| DOM snapshot for the AI (`captureDomSnapshot`, dom-cleaner.ts:458 → capture-dom.js) | walks **every child of `<html>` except `<head>`** (capture-dom.js:640-652, SPEC-web-survey-fixes §2.48) | **yes**, measured: one `<steptix-highlight>` line | **skip `STEPTIX-HIGHLIGHT` in that top-level loop** and in `processElement` |
| Stall detection (`pageFingerprint = url + domSnapshot`, step-executor.ts:2797-2817) | the snapshot above | would, via the snapshot | fixed by the same skip |
| Failure diagnosis (src/ai/diagnose.ts:46) | snapshot + screenshot | would | the skip, plus §4.2 |
| `find` / `expand` (find-in-dom.js) | walks from `document.body` or a stamped element | no: the host is not under `<body>` | none |
| `locateTexts` (locate-text.ts:82) | `doc.body.querySelectorAll('*')` | no | none |
| `captureVisibleText` | `document.body.innerText` | no (measured: unchanged) | none |
| `DIAGNOSE_SCRIPT` (page-state.ts:115) | `document.querySelectorAll('*')`, leaf text and modal selectors | matched but inert: no text, role or class | keep the host bare (§3.3, item 3) |
| Selectors, `count`, `read` (Playwright locators) | pierce **open** shadow roots only | `body …`, text and role selectors: no (measured). `*` and `html > *` match the host. | accepted residual (§12) |
| Covered-element detection | Playwright's hit-target check ("intercepts pointer events") and the drag probe `pointerReaches` (actions.ts:2387, `composedPath`) | no: `pointer-events: none` elements are not hit-tested (measured) | none |
| Settle waits (`domQuiesceScript`, `wait stable`, `FINGERPRINT_SCRIPT`) | observe or read `document.body` (page-state.ts:236-243, :395-420; actions.ts:3402-3420) | no: the host's mutations are on `<html>` | none. The quiesce observer falls back to `documentElement` only when there is no `<body>`. |
| Notice recorder (notices.ts:56-63) | observes the whole document, keeps only `[role=alert\|status\|log]`, `[aria-live]` and `output` | ignored | keep the host bare |
| Recorder (record-steps.js, record-toolbar.js) | event targets via `composedPath()[0]`; the toolbar re-raises itself above any new top-layer element | a `pointer-events: none` host is never a target. The toolbar may re-raise above a ring, which is harmless. | during recording, hide rings before a crop (§4.2) |
| Code-behind recording (src/codebehind/recording.ts) | records the AI's actions from Node | no | none |

The skip is one line in each place, keyed on the tag name, and commented with
why. A shared exported constant, `HIGHLIGHT_TAG`, keeps capture-dom.js and
highlight.js from drifting apart. Note that capture-dom.js does not skip the
recorder's hosts and should not start to: those are removed before a run, and
widening the skip is a separate decision.

### 4.2 Screenshots: shown in the report, hidden from the model

There are two different audiences.

**The report and the video: show it.** That covers the post-action filmstrip
(step-executor.ts:4057-4064, report-only), step-end shots, failure shots and
`browser.video`. The ring is the whole point there: a filmstrip frame that
rings the element just clicked answers "what did step 4 click?" without
reading the log.

Could it mislead?

- A ring sits on top of the page, so a reader could take it for the page's own
  focus ring or a validation state. The style (§8) is chosen to look like
  neither: a double ring with a white halo and a soft glow, never red or green.
- The post-action settle lands 0.6–1.5 s after the action (page-state.ts:263-297),
  so the ring is usually captured at full strength. The phase is not
  deterministic, though, and the same run can show a slightly different glow.

That is acceptable for a picture, and it is why the feature is opt-in.

**The model: hide it.** When `ai.sendScreenshots` is on, the pre-turn capture
is the model's input (step-executor.ts:2860), and the prompt tells the model to
"use it to understand the current visual state of the page"
(src/ai/prompts.ts:910). A ring left from the previous action would then be
page state the page does not have. Diagnosis always attaches a screenshot
(diagnose.ts:46).

So any capture whose image goes to a model runs inside
`highlighter.hiddenFor(page, () => captureScreenshot(…))`:

1. If no ring was drawn on this page within `durationMs`, it captures directly
   with no extra round trip. The Node side records the last mark time per
   page, with an injected `now`.
2. Otherwise it calls `hide()` on every frame's registry in parallel,
   captures, then calls `restore()`, so the person watching still sees the
   full 3 s.

With `ai.sendScreenshots` off (the default, src/config/defaults.ts:14), this
never runs.

The recorder's crops, which are sent to a model with a red target outline
(src/recorder/crop.ts:21-27), use the same wrapper.

**A separate option is worth having but small:** `browser.highlight.inScreenshots`
(default `true`). When `false`, report captures also go through `hiddenFor`,
for people who diff report screenshots or reuse them in docs. The model side
is not configurable: it is always hidden.

---

## 5. Timing

### 5.1 Steps never wait for it

`mark(locator, kind)` returns `void`. Inside, it calls
`void locator.evaluateAll(script, args).catch(noteOnce)`. Nothing awaits it.
The evaluate is issued just **before** the act, so the ring appears as the
action happens. Playwright handles the two protocol calls concurrently.

Failures are swallowed and logged once per page at debug level: a detached
frame, a context destroyed by the navigation the click started, or a page
that tampered with `attachShadow`. A highlight must never fail a step.

The one real cost is the page's main thread running the script, a few
milliseconds. Phase 1 measures it on SecureBank. The target is no measurable
change in step time, judged against run-to-run noise.

A click that navigates takes its ring down with the old document. The ring
shows for the length of the click (Playwright's actionability checks plus
the click), typically tens to hundreds of milliseconds. Carrying a ring into
the next document would mean guessing which element there corresponds, and is
not proposed.

### 5.2 Overlap

Actions faster than 3 s are the normal case: a `type` then a `click` in one
turn. Each element gets its own ring, and re-marking an element restarts its
ring. A cap of 32 live rings per document finishes the oldest early, so a long
burst cannot pile up.

### 5.3 Reads of many elements

A read of every match, or a count, can match hundreds of elements. `mark`
takes `max` (20). The page rings the first 20 matches in document order and
ignores the rest. `readTable` rings only the table.

### 5.4 Reduced motion, and tests without timers

- **`prefers-reduced-motion: reduce`** is decided **in script**, with
  `matchMedia`, not with a `@media` rule in the adopted sheet. Measured: with
  `page.emulateMedia({ reducedMotion: 'reduce' })`, `matchMedia` answered true
  in all three engines, and a `@media (prefers-reduced-motion: reduce)` rule
  in an adopted sheet took effect in Chromium and Firefox **but not in
  WebKit**. Under reduced motion the ring appears at full strength with no
  scale and no pulse, holds, and ends with a 150 ms opacity fade.
- **No timers on the Node side.** The only clock there is "was a ring drawn
  on this page within `durationMs`" (§4.2), which takes an injected
  `now: () => number`. This is the existing pattern: `ThresholdWait` and
  `waitForStableCount` (actions.ts:3135-3191, :4136-4164) and the page-state
  watcher options (page-state.ts:496-497).
- **In the page, tests end rings deterministically** through the registry's
  `finishAll()`, which finishes every Animation. Its `finished` promise then
  removes the ring and the host. A test that wants a static ring for a pixel
  check emulates reduced motion and passes a long `durationMs`. Nothing waits
  on wall-clock time.

---

## 6. Computer mode (`[use computer]`)

**Out of scope for drawing.** Computer mode drives the real mouse and keyboard
through nut.js, and the model reads `screen.grab()` of the whole primary
display (SPEC-use-computer.md; src/desktop/nut-adapter.ts:457). A highlight
there would have to be a native window that is topmost, transparent and
click-through. Each OS needs a different one:

- a layered transparent window on Windows;
- a borderless window that ignores mouse events on macOS;
- an override-redirect shaped window on X11;
- nothing at all on Wayland, which computer mode already does not support.

nut.js creates no windows, so it would be a new native dependency on each
platform. Worse, `screen.grab()` excludes nothing, so the overlay would be in
the very screenshot the model reads next. That is the misleading case §4.2
exists to prevent, and there is no `hide` to call on a desktop overlay without
another platform-specific mechanism.

**Two small things are in scope:**

1. **Entering `[use computer]` hides live in-page rings first.** The browser
   is usually on screen. A ring from the last browser action would otherwise
   be inside `screen.grab()` for the first computer turn (`desktop.settleMs`
   is 300 ms, src/config/defaults.ts:46-51). This is the same `hiddenFor`
   machinery. Without `restore`, the rings are gone for good.
2. **Considered and declined (§13, decision 6):** marking the click point on
   a computer-mode **report** screenshot after the fact, with jimp (already a
   dependency). It would need no window, no capture interplay and no platform
   code, so it stays cheap to add later if wanted.

---

## 7. Config

### 7.1 Key and shape

`browser.highlight`, beside `browser.video` and `browser.slowMo`, the other
watch-the-run settings:

```jsonc
"browser": {
  "highlight": true                   // sugar for { "enabled": true }
}
```

```jsonc
"browser": {
  "highlight": {
    "enabled": true,
    "durationMs": 3000,               // 500–10000; default 3000
    "colors": { "act": "#3b82f6", "read": "#a855f7" },   // hex only
    "inScreenshots": true             // report captures; the model never sees it
  }
}
```

- **Default: off** (`false` in src/config/defaults.ts). The feature changes
  what is painted on the screen and in the report, and it touches the DOM of
  the page under test, however carefully. That should be a choice.
- **No `style` option in v1.** There is one designed effect (§8). Add options
  when someone asks for one.
- **Types.** `HighlightConfig` is an interface in src/config/types.ts, with
  its JSDoc on the interface. `BrowserConfig.highlight?: boolean |
  HighlightConfig`. The JSDoc goes on the interface because of the schema
  generator gotcha noted at types.ts:266-272.
- **Validation.** `assertHighlight` in src/config/loader.ts, beside
  `assertBlockAds` (:513), so that a quoted `"false"` cannot be read as
  truthy. That is the reason the loader gives for typing the `desktop` section
  (:425-444): there, the string `"false"` was truthy and switched computer
  mode on.
  It throws `Invalid browser.highlight in <file>: expected …, got …` through
  `describeValue`. Colours are hex only, because Node cannot ask a browser
  whether a CSS colour parses.
- **Normalised once.** `resolveHighlight(browser): ResolvedHighlight | null`
  in src/browser/highlight.ts, the way `resolveVideoMode` normalises
  `browser.video` (manager.ts:46). Every read site gets either `null` (off) or
  a complete object, so no caller writes `?? 3000`.
- **Schema and docs.** The generated schema/steptix.config.schema.json
  (`npm run build:schema`, part of `build`), README's config section,
  docs/specs/SPEC.md's config list, and a commented example in
  templates/init/steptix.config.json.

### 7.2 Per-test and per-run overrides

- **Front matter or `## Config`: not proposed.** Whether the rings show is a
  preference of whoever is watching, not a property of the test or the site.
  The existing `## Config` keys (`viewport`, `tableStructure`, …) describe the
  test's needs.
- **CLI: yes, cheap.** `steptix run --highlight` / `--no-highlight`, added to
  src/cli/commands/run.ts:32-53 and `applyCliOverrides` (loader.ts:597). It
  sets `enabled` and keeps the project's other fields. Useful for "show me
  this one run".
- **Per-run toggle for the server, MCP and VS Code: phase 3 (§13, decision 4).**
  It would be a `highlight: 'default' | 'on' | 'off'` key in
  `RUN_SETTING_KEYS` (run-settings.ts:36), resolved in `resolveRunSettings`
  with a source in `EffectiveSettings`. It also needs MCP's flat args and
  `get_run_settings` schemas (src/mcp/schemas.ts:209-306, :673-760), plus
  `readRunSettings` (src/mcp/tools.ts:340-360). A VS Code setting would map to
  it the way `steptix.consoleLogLevel` maps to `logging`
  (run-controller.ts:6135-6155).

### 7.3 How the setting reaches each path

- **CLI.** `loadConfig` → `applyCliOverrides` → `StepExecutorOptions.config`
  → `ExecuteActionOptions.highlight`, built where `ambiguousTarget` is built
  (step-executor.ts:3937-3941).
- **Server / Sessions API, MCP, VS Code.** This is **the trap the code warns
  about**. `resolveRunSettings` spreads the **server's** startup config and
  re-sources only named keys. A new per-project `browser.*` key "reaches the
  CLI correctly and is silently the server's value everywhere else"
  (run-settings.ts:150-153; project-bundle.ts:56-66). So `browser.highlight`
  must be:
  - re-sourced in `resolveRunSettings` with `base(server, project)`, exactly
    like `ambiguousTarget` (:246-249, :312);
  - hoisted onto `ProjectBundle` beside `ambiguousTarget`, if anything reads
    it at session creation.

  The VS Code extension and MCP send nothing new in phases 1–2. They reach the
  server, which reads the project's config per test file
  (src/server/project-bundle.ts).
- **Code-behind `step.read` / `step.count`.** These call `executeAction`
  without config options today (execute.ts:835). Thread the resolved highlight
  through `StepApiRuntime`, the same runtime object that already lends `page`
  and `signal`.
- **Errands** resolve their project the way a session does
  (`ProjectBundleResolver`), so they follow the same path.

---

## 8. Visual design: "trace and glow"

One effect, two hues:

| Kind | Actions | Hue | Why |
| --- | --- | --- | --- |
| act | click, type, select, hover, drag, upload, dismiss, keyboard | blue `#3b82f6` | neutral and "doing" |
| read | read, read every, count, readTable, `step.read`/`step.count` | violet `#a855f7` | clearly different from blue at a glance |

**Red is avoided.** It means error, and the recorder's crops already tell a
model "the target is outlined in red" (prompts.ts:3122-3146). **Green** is
avoided because it reads as "passed", and amber as "warning".

**Visible on light and dark pages.** The ring is three layers:

1. a 2px coloured border;
2. a 2px white halo outside it (85% opacity);
3. a 1px dark hairline outside that (35% opacity).

Whatever the background, one of the three contrasts with it.

The sheet adopted into the closed root. The dynamic `left/top/width/height`
are set per ring with `style.setProperty`:

```css
.ring {
  position: fixed;
  box-sizing: border-box;
  pointer-events: none;
  border: 2px solid var(--stx-c);
  border-radius: 6px;
  box-shadow:
    0 0 0 2px rgb(255 255 255 / 0.85),
    0 0 0 3px rgb(0 0 0 / 0.35),
    0 0 12px 3px color-mix(in srgb, var(--stx-c) 55%, transparent);
  /* outset 3px from the element's rect, set in script */
}
.ring[data-kind="act"]  { --stx-c: #3b82f6; }
.ring[data-kind="read"] { --stx-c: #a855f7; }
```

The motion, written as CSS for review:

```css
/* 3000ms total; the percentages scale with durationMs */
@keyframes stx-trace-glow {
  0%   { opacity: 0; transform: scale(1.12); }                    /* draws in onto the element */
  6%   { opacity: 1; transform: scale(1);    }                    /* ~180ms, ease-out */
  15%  { box-shadow: 0 0 0 2px rgb(255 255 255 / .85), 0 0 0 3px rgb(0 0 0 / .35),
                     0 0 20px 8px color-mix(in srgb, var(--stx-c) 60%, transparent); } /* one glow pulse */
  25%  { box-shadow: 0 0 0 2px rgb(255 255 255 / .85), 0 0 0 3px rgb(0 0 0 / .35),
                     0 0 12px 3px color-mix(in srgb, var(--stx-c) 55%, transparent); }
  80%  { opacity: 1; }                                            /* hold */
  100% { opacity: 0; }                                            /* fade out over the last ~600ms */
}
```

It ships as the same keyframes passed to `ring.animate(frames, { duration:
durationMs, easing: 'linear', fill: 'forwards' })`, with per-keyframe easing
`cubic-bezier(.2,.8,.2,1)` on the first segment. The reason is §3.3 item 8:
Web Animations give the controller an `Animation` object to restart, finish
and await. A CSS animation would need class toggling and `animationend`
listeners. Both forms were measured working under strict CSP.

`color-mix()` needs Chromium 111, Firefox 113 or Safari 16.2. All are older
than Playwright's bundled builds. A CDP-attached older Chrome loses only the
glow.

Under reduced motion the frames are `[{opacity:1}, {opacity:1, offset:0.95},
{opacity:0}]`.

---

## 9. Constraints from CLAUDE.md

- **No site-specific code.** The controller knows only HTML, CSS and ARIA
  standards: `popover`, `aria-hidden`, the top layer and
  `prefers-reduced-motion`. Test fixtures use invented names (`#item`,
  "Ada"). The live test drives SecureBank from a `.md` file, never from
  framework code.
- **Windows, Linux and macOS.** Nothing in this is platform-specific. Browser
  tests run headless Chromium as the existing ones do. Fixture paths are built
  with `os.tmpdir()`/`path.join`. The CSP fixture server binds with
  `listenFetchable(server, host)` (tests/listen-fetchable.cjs).
- **Unit tests are not timed** (§5.4): an injected `now`, `finishAll()`, and
  conditions rather than sleeps.
- **Extension version bump.** Phases 1–2 change no tracked file under
  `steptix-vscode/` or `runner-core/`. The extension does ship the generated
  schema through `jsonValidation` (steptix-vscode/package.json:26-30,
  `copy:schema`), though, so editor completion for `browser.highlight` arrives
  only with a rebuilt VSIX. **Bump the patch version in phase 1 anyway**, so
  the Extensions panel shows that the schema changed. Phase 3's VS Code
  setting changes the extension and runner-core outright.

---

## 10. Test plan

### 10.1 Unit tests (root suite, headless Chromium)

Model on tests/web-survey-fixes.test.ts:24-41: one browser in `beforeAll`, a
page per test via `setContent`, and `executeAction` called directly. Use
tests/type-into-wrapper.test.ts:30-52 for the SecureBank fixture.

1. **Config** (`tests/highlight-config.test.ts`, after
   tests/video-config.test.ts):
   - `true`, `false`, the object form and defaults load;
   - `"true"`, `durationMs: 50`, `colors.act: "blue"` and unknown keys are
     refused with the message format;
   - Ajv against the generated schema agrees with the loader;
   - `resolveHighlight` normalises;
   - `resolveRunSettings` takes the project's value over the server's (the
     §7.3 trap, as the `ambiguousTarget` tests do);
   - `--no-highlight` overrides.
2. **Marks** (fake sink, no drawing): `ExecuteActionOptions.highlight` is a
   recording fake `{ mark(locator, kind, max) }`. For each action, assert
   exactly the expected marks by resolving each recorded Locator's element
   identity:
   - click: one act;
   - a hidden checkbox marks the label;
   - drag marks source then destination;
   - read of every match: one read with `max: 20`;
   - readTable marks the table;
   - **probes mark nothing**: `ambiguousTarget: 'fail'` with two matches
     fails with zero marks, and iframe promotion does not mark the iframe.
3. **Never awaited.** A sink whose `mark` starts a promise that never settles,
   and `executeAction` still resolves. No timeout is involved: the assertion
   is that the action's promise settles while the sink's never does.
4. **Controller in the page** (`highlight.js` evaluated directly). Each case
   reads the registry handle:
   - one mark gives one ring whose rect contains the element's rect;
   - the same element marked twice gives one ring; two elements give two;
   - the 33rd ring finishes the oldest;
   - `finishAll()` then awaiting its animations' `finished` removes the host;
   - removing the element, then waiting two animation frames inside the page
     (a condition, not a sleep), leaves no ring;
   - an iframe target is ringed in the iframe's document;
   - an open-shadow target is ringed;
   - a zero-size target draws nothing;
   - under emulated reduced motion the ring has no `transform` keyframes.
5. **Strict CSP.** Serve
   `default-src 'none'; script-src 'self'; style-src 'none'` from a fixture
   server bound with `listenFetchable`, with a page script that records
   `securitypolicyviolation`. After a mark there are zero violations and the
   ring's computed border width is 2px. The control case is in the same test:
   a `setAttribute('style')` on that page **is** refused, so the test proves
   CSP was on.
6. **Readers ignore it** (the regression the prototype found). With a live
   ring:
   - `captureDomSnapshot` returns exactly what it returned before the mark;
   - `findInDom`, `locateTexts` and `DIAGNOSE_SCRIPT` are unchanged;
   - a click on the ringed element succeeds and `elementFromPoint` at its
     centre is the element;
   - `waitForPostActionSettle`'s fingerprint is unchanged.
7. **Hidden from the model.** Draw under reduced motion with a long duration,
   then:
   - `hiddenFor(page, captureScreenshot)`: the pixel under the ring edge is
     the page background;
   - a plain `captureScreenshot`: the pixel is the ring colour;
   - `restore()` brings it back;
   - with no recent mark (injected `now` past `durationMs`), `hiddenFor` makes
     no evaluate call (a spy on `frame.evaluate`).
8. **Engines.** Run cases 4 and 5 for Firefox and WebKit too, wherever the
   suite's environment installs them. The prototype (§15) shows they pass
   today.

### 10.2 Live test

Add a `steptix-vscode/tests/integration/live/highlight.test.cjs`, modelled on
video-recording.test.cjs:91-179. It uses its own fixture project,
`templates/highlight/`, whose `steptix.config.json` sets:

- `browser.highlight: true`;
- `captureScreenshotsPerAction: true`;
- `ai.sendScreenshots: true`, so the hide path runs.

It drives SecureBank (`fixtures/test-app`) through a short `.md`:

1. Sign in.
2. Read the balance.
3. Count the transactions.

It asserts:

- the run passes;
- the report has a per-action screenshot for each sub-action;
- the report's AI request content (the `ai-request-content` blocks) contains
  no `steptix-highlight`;
- each sub-action's new report field `highlighted` (§11) is `act` or `read` as
  expected. That turns path coverage into a live assertion rather than a
  picture to eyeball.

A pixel assertion on live screenshots is deliberately left out: the phase of
the fade at capture time is not deterministic (§4.2). The unit tests cover
pixels.

---

## 11. Reporting

Add `highlighted?: 'act' | 'read'` to each sub-action in the report data.
It records that a mark was **requested**, not that it was drawn, since the
draw is fire-and-forget. That gives:

- the live test a coverage assertion;
- a reader of the report a way to tell "this action rang the element" from
  "this action had no element".

No new report UI is proposed beyond the screenshots themselves.

---

## 12. Risks

- **The host is in the page's DOM.**
  - Page code that observes `<html>` `childList` sees one element come and go
    (measured: MutationObserver records fire).
  - `document.querySelectorAll('*')`, a `*` or `html > *` selector, and a
    `:popover-open` query each count it while a ring is live.
  - The recorder toolbar has carried the same footprint since it shipped.
  - No Steptix reader is affected after the §4.1 skip.
  - A test whose own selector is `*` would count one more during a ring.
    That is unlikely enough to accept, and documented in the config's JSDoc.
- **The page can tamper.** The script runs in the main world (Playwright's
  `evaluateAll`), so a page that patches `attachShadow`, `Element.prototype.animate`
  or `requestAnimationFrame` can break the ring. The draw is wrapped and fails
  silently. It cannot fail a step.
- **Clipping is not reproduced.** A ring drawn in the top layer is not clipped
  by the element's scroll container, and it draws above a fixed header that
  covers the element (measured). That shows where the element is, and the
  covered-element detection is unaffected. A reader might still be surprised.
- **Top-layer churn.** When the page opens a dialog after a ring, the
  controller re-raises the host on the next mark (§3.3 item 4), not
  continuously. A ring already live under a newly opened modal stays under it
  until it fades.
- **Screenshots vary run to run** in glow phase (§4.2). They are not used for
  comparisons anywhere in the repo today.
- **Main-thread cost on heavy pages**: unmeasured until phase 1. The script
  is small, and the rAF loop runs only while rings are live.
- **Code-behind coverage is best effort** (§2.3).

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

| Phase | Scope | Rough size |
| --- | --- | --- |
| 1 | `browser.highlight` type, validation, schema, docs, CLI flag; `resolveRunSettings` re-source; src/browser/highlight.ts (`resolveHighlight`, the sink, `hiddenFor`); scripts/highlight.js; marks in click (with the stand-in), type, select, hover, read, read every, count; the capture-dom.js skip; hiding for the model's pre-turn capture and diagnosis; unit tests 1–7; extension patch bump for the schema. **Frames, open shadow DOM, CDP browsers and all three engines come with this phase** (a Locator-based draw needs nothing per frame, measured in §15). | 3–4 days |
| 2 | Remaining handlers (drag both ends, upload, dismiss, keyboard's focused element, readTable); `step.read`/`step.count` via `StepApiRuntime`; login broker; `inScreenshots`; recorder crops; hide on entering `[use computer]`; report `highlighted`; live test; measuring step-time cost on SecureBank. | 2–3 days |
| 3 | Code-behind and tool page wrapper with its `instanceof`/argument-forwarding tests; the `highlight` run setting across the Sessions API, MCP, `get_run_settings` and a VS Code setting (runner-core and steptix-vscode change, so a version bump). | 3–4 days |

---

## 15. Prototype record

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

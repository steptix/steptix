# Scroll steps — "down a bit", "to the bottom", "back to the top"

## In plain terms

You should be able to write these as test steps and have them just work:

- *Scroll to the bottom of the page*
- *Scroll down a bit*
- *Scroll up to the top of the page*
- *Scroll down to the reviews section*

Today they mostly don't, and the reason is odd: the framework already has a
`scroll` action wired end to end — parser, executor, even the mutating-actions
list for cache replay — but the system prompt never tells the model it exists.
So "scroll down a bit" works only when the model happens to guess, from general
knowledge, that this action vocabulary includes `scroll` with exactly the field
names we parse. And "scroll to the bottom" can't work even with a lucky guess,
because the only primitive is *relative* scrolling: a mouse-wheel delta in
pixels. There is no way to say "the bottom".

This story makes scrolling a documented, first-class step in three moves:
teach the executor absolute scrolling (`to: "top" | "bottom"`) and
scroll-to-element (`selector`) — eased like a person would scroll, not
teleported — document the whole action in the system prompt, and give the
model textual feedback about where the viewport actually is — so "scroll to
the bottom" is verifiable even in runs where the model sees no screenshots at
all.

### What it looks like in practice

**You write:** *"Scroll to the bottom of the page"*
**You get:** one `scroll` action with `to: "bottom"` — a single eased glide to
the bottom, whatever the page height: quick off the mark, decelerating into
the stop, and finished before anything looks at the page. No guessed pixel
counts, no repeated wheel nudges. The next turn's context reports the new
position (`at bottom`), so the model knows it's done without needing the
screenshot.

**You write:** *"Scroll down a bit"*
**You get:** the existing wheel scroll, `direction: "down"` with a modest
`amount` — the model sizes "a bit" (~300px) vs "a page" (the viewport height it
already knows from Test Information).

**You write:** *"Scroll up to the top of the page"*
**You get:** `to: "top"` — back to y=0 in one action.

**You write:** *"Scroll down to the reviews section"*
**You get:** a `scroll` action with a `selector`, executed as Playwright's
`scrollIntoViewIfNeeded` — the most robust form, since it needs no pixel math
at all and works inside iframes via the existing `frame` field.

**You write:** *"Scroll to the bottom"* on an infinite feed
**You get:** the model scrolls to the current bottom, sees from the position
line that the page grew, and repeats under `needs_reeval` until the height
stops moving — bounded by the step's normal turn limit.

> **Verification rule for this story.** "Done" means, against a real page tall
> enough to scroll: (1) the step *"Scroll to the bottom of the page"* executes
> as a single `scroll` action with `to: "bottom"` in the run log — not a wheel
> hack — and the step passes; (2) *"Scroll down a bit"* executes as
> `direction: "down"` with a sane amount; (3) *"Scroll up to the top of the
> page"* returns the viewport to y=0; (4) *"Scroll down to the <named>
> section"* executes as a selector scroll; (5) at least one of these runs
> passes with `ai.sendScreenshots: false`, proving the model can verify scroll
> state from the position line alone; (6) re-running the same test replays the
> scroll steps from the step cache with zero AI calls; (7) on a headed or
> video-recorded run the absolute scroll visibly glides and decelerates into
> the stop, and no captured screenshot shows a mid-scroll frame.

## Context — what exists, and why the steps don't work today

The plumbing is already there, unused:

| Layer | State |
|---|---|
| [types.ts:53](../src/ai/types.ts) | `AIAction` has `direction` (`up/down/left/right`) and `amount` (px) |
| [action-parser.ts:312](../src/ai/action-parser.ts) | Both fields pass through, validated |
| [actions.ts:657](../src/browser/actions.ts) | `executeScroll` — `page.mouse.wheel()`, default down 300px |
| [step-executor.ts:55](../src/runner/step-executor.ts) | `scroll` is in `MUTATING_ACTIONS`, so caching treats it correctly |
| [prompts.ts](../src/ai/prompts.ts) | **Never mentions scroll.** Click, type, wait, read, find, expand, openPage, openBrowser — all documented. Scroll: absent |

That last row is the story. The model's action vocabulary is whatever the
system prompt says it is; an action the prompt doesn't name gets emitted only
by luck. And when the model does improvise, its options for "the bottom" are
all bad:

- **A huge `amount`.** `mouse.wheel` scrolls whatever is under the pointer —
  which may be an inner scrollable panel, a modal, or a table — not
  necessarily the page. It also returns before scrolling finishes (Playwright
  does not await wheel-triggered scrolling), and a fixed number is wrong on
  every lazy-loading page.
- **`keyboard: End`** ([actions.ts:711](../src/browser/actions.ts)). Works only
  while focus is on the document body — after typing into a field, it moves the
  caret, not the page. Also undocumented in the prompt.

Separately, the model is nearly blind to scroll state. The DOM snapshot
([capture-dom.js](../src/browser/scripts/capture-dom.js)) carries no
coordinates — prompt rule 4 ([prompts.ts:162](../src/ai/prompts.ts)) promises
`[pos:x,y w×h]` annotations that the capture script does not actually emit
(stale claim, tracked separately). So the only evidence a scroll happened is
the screenshot, and only in the default viewport mode
(`fullPageScreenshots: false`, [defaults.ts:24](../src/config/defaults.ts)).
Two real configurations break even that:

- `ai.sendScreenshots: false` — the cost-saving mode from the run-settings
  story. The model sees no image at all; a scroll currently has **no**
  observable effect.
- `fullPageScreenshots: true` — a full-page capture renders the whole page
  regardless of scroll position, so scrolling changes nothing in the image.

Cache replay is not a concern: a cache hit re-executes the stored action
objects through the same executor
([step-executor.ts:283](../src/runner/step-executor.ts)), so new fields ride
along for free.

## Locked decisions

- **Extend the existing `scroll` action; no new action type.** The vocabulary
  already has `scroll`, the parser already accepts it, and a second
  scroll-flavoured action would force the model to choose between
  near-synonyms. One action, three forms.

- **`to: "top" | "bottom"` is absolute, pointer-independent — and eased, not
  instant.** Executed as an in-page animation on `document.scrollingElement`:
  an ease-out curve drives `scrollTop` to the target — fast off the mark,
  decelerating as it approaches the stop — and the call resolves only when
  motion has ended. Both obvious alternatives lose. `behavior: "smooth"`
  cannot be awaited: completion needs the `scrollend` event, which WebKit
  doesn't fire, and the browser picks the duration. `behavior: "instant"`
  teleports: it dispatches no intermediate scroll positions, so
  IntersectionObserver-driven lazy-loaders and scroll-linked UI never see the
  journey — on exactly the long pages "scroll to the bottom" is for — and a
  recorded run shows a jarring jump. The eased path keeps the property an
  instant scroll would have been chosen for: completion is *our own promise*,
  not a browser event, so the executor awaits actual arrival and the
  follow-up screenshot can never catch a mid-animation frame.

- **The animation always terminates.** Duration scales with distance and is
  hard-capped (≈250ms + distance/4, max 1200ms); the `bottom` target is
  re-read every frame, so lazy growth during the glide is tracked within the
  cap; and a deadline timer races the `requestAnimationFrame` loop — rAF is
  throttled to zero on hidden pages (the same lesson `peek_tab` screenshots
  learned the hard way), and when frames stop coming the timer snaps to the
  target and resolves. No config knob for the speed: a per-project `browser.*`
  value would have to be threaded through the server's per-project bundle to
  actually apply (the run-settings story documents that trap), and nothing
  justifies that plumbing yet. Constants, revisited if anyone asks.

- **`selector` on a scroll means "bring this element into view".** The same
  eased glide, aimed at the element's position in the document scroller, then
  Playwright's `scrollIntoViewIfNeeded` as the correctness backstop — a no-op
  when the glide already landed, and the thing that handles elements inside
  *nested* scrollable containers, where the backstop is instant (honest
  limit). Routed through `root` like every other selector-bearing action, so
  the existing `frame` field works unchanged. This is the preferred form
  whenever the step names a target, because it involves no pixel arithmetic
  at all. (Today's `case 'scroll'` comment says scroll is page-only
  ([actions.ts:166](../src/browser/actions.ts)); that stops being true and
  the comment goes.)

- **The wheel path stays exactly as it is** for `direction` + `amount`. It is
  the only form that can reach an inner scrollable pane under the pointer, and
  keeping it byte-identical means existing cached runs and any tests that
  learned to emit it keep working.

- **Precedence, not rejection: `selector` > `to` > `direction`.** A model that
  sends `{ "to": "bottom", "direction": "down" }` is being redundant, not
  contradictory — every combination has one sensible reading. A strict reject
  (the predicate/`expected` precedent) is for genuinely conflicting modes;
  here it would burn a paid retry turn to punish harmless noise. The
  precedence is stated in the prompt rule.

- **The prompt rule is the load-bearing change, and it's a lettered insert.**
  The rules cross-reference each other by number (rule 22 cites rule 2, rule 3
  cites rule 12), so the scroll rule lands as a sub-rule (`12a`, after wait) in
  the established `13a`/`18a` pattern rather than renumbering anything.

- **Scroll position becomes visible text in the model's context.** One line
  beside the current URL in the step/continuation messages, captured with the
  DOM snapshot: `Scroll position: 1240–1960 of 5400px` with `(at top)` /
  `(at bottom)` / `(page does not scroll)` markers. Rationale above: with
  screenshots off the model is otherwise blind, and with full-page screenshots
  on the image doesn't change when you scroll. This line is also what makes
  the infinite-scroll loop terminate — the model can see the page height grow
  and stop when it stabilises.

## Design

### 1. The action, extended

```jsonc
// "Scroll to the bottom of the page"
{ "action": "scroll", "to": "bottom", "description": "Scroll to the bottom of the page" }

// "Scroll down a bit"
{ "action": "scroll", "direction": "down", "amount": 300, "description": "Scroll down a bit" }

// "Scroll down to the reviews section"
{ "action": "scroll", "selector": "#reviews", "description": "Bring the reviews section into view" }
```

`to` joins `AIAction` in [types.ts](../src/ai/types.ts) and gets a guarded
passthrough in [action-parser.ts](../src/ai/action-parser.ts) identical in
shape to `direction`'s: any value other than `"top"`/`"bottom"` is dropped,
leaving the action to fall through to its other fields.

### 2. Execution

`executeScroll` ([actions.ts:657](../src/browser/actions.ts)) gains the two
branches and takes `root` alongside `page`:

```ts
async function executeScroll(page: Page, root: Page | FrameLocator, action: AIAction): Promise<void> {
  if (action.selector) {
    const target = root.locator(action.selector).first();
    await animateScrollToLocator(page, target); // eased glide on the document scroller…
    await target.scrollIntoViewIfNeeded();      // …then the correctness backstop (no-op when visible)
    return;
  }
  if (action.to) {
    await page.evaluate((to) => new Promise<void>((resolve) => {
      const el = document.scrollingElement ?? document.documentElement;
      const start = el.scrollTop;
      const target = () => to === 'top' ? 0 : el.scrollHeight - el.clientHeight;
      const duration = Math.min(1200, 250 + Math.abs(target() - start) / 4);
      const deadline = setTimeout(() => { el.scrollTop = target(); resolve(); }, duration + 500);
      const t0 = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - t0) / duration);
        el.scrollTop = start + (target() - start) * (1 - Math.pow(1 - t, 3)); // ease-out cubic
        if (t < 1) { requestAnimationFrame(tick); return; }
        clearTimeout(deadline);
        resolve();
      };
      requestAnimationFrame(tick);
    }), action.to);
    return;
  }
  // wheel path, unchanged
}
```

Three details that matter:

- The maximum is `scrollHeight − clientHeight`, not `scrollHeight`. A plain
  `scrollTo` gets away with overshooting because the browser clamps; an
  animation must not, or the visible deceleration compresses against the
  clamp and dies early.
- `target()` is a function, re-read every frame, so `bottom` tracks a page
  that grows mid-glide — within the duration cap.
- `page.evaluate` serializes the callback, so the easing must live *inside*
  it — no closing over imports. The duration formula is mirrored as an
  exported pure function so tests can pin the cap and the distance scaling
  without a browser.

`animateScrollToLocator` reuses the same browser-side animator with the
target y computed from the element's bounding rect plus the current
`scrollTop`, clamped to the same maximum.

### 3. The prompt rule

A `12a` in [prompts.ts](../src/ai/prompts.ts) documenting all three forms, the
precedence, and the judgment calls: prefer `selector` when the step names a
target; use `to` for page extremes; size "a bit" around 300px and "a page"
from the viewport height in Test Information; on lazy-loading pages, `to:
"bottom"` reaches the *current* bottom — check the scroll-position line on the
next turn and repeat under `needs_reeval: true` until the total height stops
growing.

### 4. The position line

Captured in the step executor beside the existing `page.url()` call
([step-executor.ts:552](../src/runner/step-executor.ts)) via one small
evaluate (`scrollTop`, `clientHeight`, `scrollHeight` off
`document.scrollingElement`), threaded as an optional parameter into
`buildStepMessage` and `buildContinuationMessage`
([prompts.ts:647](../src/ai/prompts.ts)) and rendered next to `Current URL`.
"At bottom" is judged with a ±1px tolerance for fractional scroll positions.
Capture failure (page mid-navigation) omits the line — same non-fatal policy
as screenshot capture.

## Out of scope

- **Scrolling a named container to its extreme** ("scroll the results panel to
  the bottom"). The natural shape is `selector` + `to` combined; nothing in
  this story precludes adding it, but no current test needs it. Inner panes
  remain reachable via the wheel path.
- Horizontal extremes (`to: "left" | "right"`). The wheel path already covers
  relative horizontal scrolling.
- The branched-step message (`buildBranchedStepMessage`) — branch decisions
  don't scroll.
- Emitting real `[pos:x,y w×h]` annotations in the DOM snapshot, or fixing
  prompt rule 4's stale claim about them — a separate, pre-existing issue.
- Any MCP surface change — `peek_tab`/`navigate_tab` are a different client of
  the browser and don't run test steps.

## Composition

| File | Change |
|---|---|
| [src/ai/types.ts](../src/ai/types.ts) | `to?: 'top' \| 'bottom'` on `AIAction` |
| [src/ai/action-parser.ts](../src/ai/action-parser.ts) | Guarded passthrough for `to` |
| [src/browser/actions.ts](../src/browser/actions.ts) | `executeScroll` branches + `root` param; the eased animator + exported duration mirror; the page-only comment goes |
| [src/ai/prompts.ts](../src/ai/prompts.ts) | Rule `12a`; scroll-position parameter on the two message builders |
| [src/runner/step-executor.ts](../src/runner/step-executor.ts) | Capture scroll position beside `page.url()`, thread it into both builders |
| [tests/action-parser.test.ts](../tests/action-parser.test.ts) | `to` passthrough/validation |
| tests (new, mock-Page pattern per [tests/iframe.test.ts](../tests/iframe.test.ts)) | Executor branches |

## Tests

Parser: `to` passes through for both values; an invalid value (`"middle"`) is
dropped, not an error; `to` alongside `direction` keeps both fields.

Executor, with the mocked `Page`/`FrameLocator` pattern from
[tests/iframe.test.ts](../tests/iframe.test.ts): `to: "bottom"` calls
`page.evaluate` and **not** `mouse.wheel`; `selector` calls
`scrollIntoViewIfNeeded` through the root — including a `FrameLocator` root,
proving the `frame` field works; bare `direction`/`amount` still produces the
exact wheel deltas it does today; precedence when fields are combined.

Motion, as pure functions: the mirrored duration formula pins the cap and the
distance scaling; the easing is asserted monotonic and ending exactly at 1,
and its per-interval displacement is asserted *decreasing* over the back half
— that falling velocity into the stop is the deceleration property this story
promises, checked as arithmetic rather than by watching a video.

Message builders: the position line renders beside `Current URL` when the
value is present, and is absent — not `undefined`-shaped — when capture failed.

Two minimum-scenario cases (not the primed typical one): `to: "bottom"` on a
page already at the bottom is a clean no-op, and the position line on a page
that doesn't scroll at all says so rather than claiming "at top".

Live (manual, required to merge): the verification rule's six points against a
real long page, run once with `sendScreenshots` on and once off. Known-flaky
live tests re-run in isolation before being called regressions.

## Risks / open

- **Apps that scroll an inner element instead of the document.** Some layouts
  fix the body and scroll a `<main>` — `document.scrollingElement` won't move
  there. The model's fallbacks are the wheel path (targets the pane under the
  pointer) or a `selector` scroll to something near the bottom. Honest limit,
  documented in the prompt rule rather than solved.
- **Truly infinite feeds.** "The bottom" never stabilises; the loop is bounded
  by the step's turn limit and fails loudly rather than spinning forever.
- **Wheel completion.** The relative path keeps its pre-existing race
  (Playwright doesn't await wheel scrolling); the new absolute path is immune
  by construction — the promise resolves at arrival. Not made worse, not
  fixed.
- **The glide costs time.** Up to ~1.7s worst case per absolute scroll (the
  1200ms cap plus the deadline margin). Bounded, and scroll steps are rare;
  if a project ever runs hundreds of them, the missing speed knob becomes the
  feature request that pays for its bundle-threading.
- **rAF-hostile pages.** A page that is hidden, occluded, or throttled stops
  producing animation frames; the deadline snap guarantees the action still
  completes at the target, just without the glide. Degraded gracefully, not
  hung.
- **Steps cached before this story.** The step cache keys on step text, so a
  step that previously "solved" scrolling with a wheel hack replays that hack
  until the cache is cleared or the step text edited. Benign — if the hack
  passed, it keeps passing.
- **`scrollIntoViewIfNeeded` under sticky headers** can leave the target
  visually overlapped. Cosmetic; assertions about the element still work.

## Repo gotchas

- **Rebuild `dist/` and restart the Sessions API server** — the running server
  executes compiled output, so none of this is live until `npm run build`. No
  TestBench version bump: this is all server-side, and the extensions are HTTP
  clients.
- **Editing the system prompt invalidates the provider-side prompt cache
  prefix** (the blocks are marked cacheable) — a one-time cost on the first
  run after deploy, not a correctness issue.
- **The full vitest run is intermittently flaky** (worker-pool crash, all
  files fail at once in ~8s with 0 tests). Re-run the single file before
  believing a regression.

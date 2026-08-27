# 051 — `wait` pins to the first DOM match, not the first *visible* one

**Status:** 🟡 open — diagnosed and measured; the `selector` half is a one-line
fix, the `hidden` half is a semantic decision
**Area:** [src/browser/actions.ts:1039](../src/browser/actions.ts#L1039)
(`executeWait`, `selector` branch) and
[src/browser/actions.ts:1055](../src/browser/actions.ts#L1055) (`hidden` branch)
**Related:** [029](029-text-wait-matches-script-source-not-visible-text.md) — the
same function reading a different view of the page than the AI does.
[stories/codebehind-selector-ambiguity.md](../stories/codebehind-selector-ambiguity.md)
— found while building it; same family (selector tolerance), deliberately not
fixed there.
**Opened:** 2026-08-27

## Symptom

Two shapes, and the second is the expensive one.

*"Click Login and wait for the dashboard heading"* stalls for the full timeout
and fails, on a page where the heading was visible immediately.

*"Wait for the loading spinner to disappear"* passes in milliseconds while the
spinner is still on screen. The step after it then fails for reasons that have
nothing to do with the real cause.

Both need only one thing to be true of the page: **a match earlier in DOM order
than the one anyone means.** A link duplicated into a collapsed mobile-nav
drawer, a print-only copy, a template row, a stale spinner left in the markup —
ordinary application shapes.

## Mechanism — every other action filters to visible *before* picking

Each element-acting helper resolves its target the same way
([actions.ts:482](../src/browser/actions.ts#L482),
[495](../src/browser/actions.ts#L495),
[590](../src/browser/actions.ts#L590)):

```ts
root.locator(selector).locator('visible=true').first()
```

Filter, then pick. `executeWait` picks, then asks about state:

```ts
// selector branch — actions.ts:1048/1050
await root.locator(sel).first().waitFor({ state: 'visible', timeout });   // frame
await page.waitForSelector(sel, { state: 'visible', timeout });           // main page

// hidden branch — actions.ts:1064/1066
await root.locator(hiddenSel).first().waitFor({ state: 'hidden', timeout });
await page.waitForSelector(hiddenSel, { state: 'hidden', timeout });
```

So the wait binds to whatever is first in the document and then waits for *that
element* to change state — not for the condition the step described.

**Both branches behave the same.** `page.waitForSelector` with a `state` option
also pins to the first match; it is not a safer alternative to the `.first()`
form. Measured, not assumed — see below.

## Measured

Chromium via Playwright, 3s budget, hidden match first in DOM order and a real
visible match second.

**Waiting for something to appear:**

```
locator(sel).first().waitFor(visible) : TIMED OUT after 3005ms
page.waitForSelector(sel, visible)    : TIMED OUT after 3004ms
locator(sel).locator(visible).first() : RESOLVED in 4ms
```

The element the step wanted was ready in 4ms. Both wait forms spent the entire
budget on an element that was never going to become visible. In production that
is a 10s stall and a failed step on a page that was ready immediately.

**Waiting for something to disappear** — a stale `display:none` spinner first in
DOM, a real visible spinner second:

```
locator('.spinner').first().waitFor(hidden): RESOLVED in 23ms
page.waitForSelector('.spinner', hidden)   : RESOLVED in 3ms

...and 1 spinner(s) still VISIBLE on screen at that moment.
```

This is the one that costs real debugging time. It is not a slow failure, it is
a **false pass**: the wait reports success against a page that is still loading,
and the failure surfaces one or more steps later wearing someone else's error
message.

## Why this survived

Both forms are correct whenever the selector matches exactly one element, which
is the overwhelmingly common case — so this reads as flakiness rather than as a
bug with a mechanism. It also cannot be seen from the DOM snapshot the AI is
given: hidden elements are emitted as tag-only placeholders with their
attributes stripped, so nothing in the model's evidence says a second match
exists. Same blind spot the selector-ambiguity work documents.

## Fix — two halves, only one of them mechanical

**`selector` branch (wait for visible): one line, no ambiguity.** Chain the
visible filter before `.first()`, exactly as every acting helper does:

```ts
await root.locator(sel).locator('visible=true').first()
  .waitFor({ state: 'visible', timeout });
```

The main-page branch should drop `page.waitForSelector` for the same locator
form rather than keeping a second code path with different semantics. This makes
the wait agree with the click that follows it, which is the real invariant: a
step that waits for X and then clicks X should be talking about the same
element.

**`hidden` branch: decide what the step means first.** "Wait for this to
disappear" against multiple matches is genuinely ambiguous, and the fix is a
different *query*, not a different locator. The likely intent is **"wait until no
match is visible"**:

```ts
await expect(root.locator(hiddenSel).locator('visible=true')).toHaveCount(0, { timeout });
```

That is a behaviour change to a path that works today for single-match pages, so
it wants its own reasoning about author intent — in particular whether a step
naming one specific spinner should really block on every element that shares its
class. Worth checking the live suite for waits that currently pass and would
start blocking.

## Not to be confused with

- [029](029-text-wait-matches-script-source-not-visible-text.md) — the `text`
  wait scanning `<script>` source. Same function, different branch, different
  cause.
- `waitType: 'count'` / `'attribute'`, which do not use `.first()` and are not
  affected.

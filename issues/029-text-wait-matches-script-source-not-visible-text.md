# 029 — `wait`-for-text matches `<script>`/`<style>` source, not visible text

**Status:** 🟡 open — diagnosed; one-line fix below
**Area:** [src/browser/actions.ts:533](../src/browser/actions.ts#L533) (`executeWait` `text` branch — `document.body.textContent.includes(...)`)
**Related:** [022](022-ai-wait-timeout-hint.md) (surfaced while building the wait-timeout live test).
**Opened:** 2026-06-03

## Symptom

A step like *"Wait up to 50 seconds for the text 'Ready now' to appear"* passes
**instantly** (~0s) instead of blocking until the text is actually rendered — even
when the visible element only appears much later. A "wait for text" can resolve
against text the user never sees.

## Mechanism — the wait checks a dirtier view of the page than the AI is shown

Three places read text off the page; two deliberately exclude `<script>`/`<style>`,
the `text`-wait does not:

| Where | Scans | Skips `<script>`/`<style>`? |
|---|---|---|
| DOM cleaner (the AI's input) | builds the snapshot the AI reasons over | ✅ [dom-cleaner.ts:451](../src/browser/dom-cleaner.ts#L451) `SKIP = new Set(['script','style',…])` |
| `find` action | walks the DOM for matching text | ✅ [find-in-dom.js:15](../src/browser/scripts/find-in-dom.js#L15) — identical SKIP set |
| **`wait` for text** | `document.body.textContent.includes(text)` | ❌ [actions.ts:533](../src/browser/actions.ts#L533) |

`Element.textContent` concatenates the **source text of every `<script>` and
`<style>`** with the visible text, and includes text inside `display:none` /
`visibility:hidden` / `<template>` nodes. So the wait can match:

- a string baked into a `<script>` (analytics labels, `application/json` data
  islands, the literal a script will later inject),
- a CSS `content:` string in a `<style>`,
- pre-rendered-but-hidden flash messages.

The AI never sees any of these — the cleaned DOM strips them — so the wait the AI
emits is then evaluated against a string the AI was never shown and a human can't
see. It silently breaks the contract the cleaner establishes.

### Reproduction (the live wait fixture, issue 022)

The fixture's script *contains* the target literal and only renders the visible
`<div>` after 35s:

```html
<body><h1>Wait fixture</h1>
  <script>setTimeout(function () {
    var d = document.createElement('div');
    d.textContent = 'Ready now';   // ← lives in the script SOURCE
    document.body.appendChild(d);
  }, 35000);</script>
</body>
```

- AI input (cleaned DOM): `<body><h1>Wait fixture</h1><button id="go">Go</button></body>` — no "Ready now".
- Runtime `document.body.textContent` at t=0: includes the script source ⇒ "Ready now" present ⇒ wait matches in ~0s instead of ~35s.

This is exactly why the first live test only passed once the fixture was rewritten
to assemble the literal from parts (`['Ready','now'].join(' ')`) — a workaround
for the framework bug, not a fix.

## Fix (one line)

Match **visible** text — the same notion the cleaner gives the AI — by reading
`innerText` instead of raw `textContent` at [actions.ts:533](../src/browser/actions.ts#L533):

```js
// before — includes <script>/<style> source + hidden text
(text) => document.body?.textContent?.includes(text) ?? false
// after — rendered, visible text only
(text) => document.body?.innerText?.includes(text) ?? false
```

`innerText` excludes `<script>`/`<style>` and content hidden via
`display:none`/`visibility:hidden`, which is precisely "appeared on screen".

**Scope:** only the `text` branch. `count` counts selector matches and `attribute`
reads an attribute value — neither scans body text — so they need no change.

Minor caveat: `innerText` normalizes whitespace and reflects `text-transform`
(it's "what's painted"), which is the desired behaviour for an "appears" wait.

## Tests

- **unit** (`tests/wait-timeout.test.ts`): capture the predicate `executeWait`
  passes to `waitForFunction`, run it against a stubbed `document` where the target
  lives only in `textContent` (script source) and not `innerText` — assert it
  returns **false** (the old `textContent` check would have returned true), then
  returns **true** once `innerText` contains it. A direct regression guard.
- **live** (`steptix-vscode/.../wait-timeout.test.cjs`): revert the string-split
  workaround so the script source again contains the literal `'Ready now'`. With
  the fix the slow-success scenario blocks ~35s and passes; reverting the fix makes
  it match the script source and fail the `waitMs > 12s` assertion.

## Follow-ups (not blocking)

- The `assert`/`read` text paths go through the cleaned DOM / `find` already, so
  they're unaffected — but worth a sweep to confirm no other raw-`textContent`
  matcher exists on a user-facing "is this text visible?" path.

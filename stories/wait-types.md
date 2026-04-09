# Wait Types

## Context

Wait actions are critical in UI automation. The original implementation used a single `condition` string and tried to guess what type of wait was intended using regex heuristics. This led to misrouted conditions — plain text like `"url contains /dashboard"` being parsed as a CSS selector, and natural language page descriptions being treated as URL patterns.

The fix: let the AI be explicit. A new `waitType` field on the wait action tells the executor exactly what kind of wait to perform, eliminating all guesswork.

## Wait Types Reference

### `load` — Wait for page load state

Wait for the page to reach a specific load state. Preferred for generic "wait for page to load" steps.

```json
{ "action": "wait", "waitType": "load", "condition": "networkidle" }
```

**Condition values:** `"networkidle"` (preferred), `"load"`, `"domcontentloaded"`

**When to use:** Steps like "wait until the page loads", "wait for the page to finish loading". Defaults to `networkidle` if condition is unrecognised.

---

### `duration` — Timed delay

Wait for a fixed duration. Supports simple and compound formats.

```json
{ "action": "wait", "waitType": "duration", "condition": "2s" }
{ "action": "wait", "waitType": "duration", "condition": "1m 30s" }
```

**Condition values:** `"30s"`, `"2m"`, `"500ms"`, `"1m 30s"`, `"30 seconds"`, etc.

**When to use:** Steps that explicitly require a timed pause, e.g. "wait 5 seconds".

---

### `selector` — Wait for element to appear

Wait for a CSS selector to become visible on the page.

```json
{ "action": "wait", "waitType": "selector", "condition": ".success-message" }
```

**Condition:** A CSS selector. The wait resolves when a matching element is visible (not just attached to the DOM).

**When to use:** Steps like "wait for the success message to appear", "wait until the form is visible". Works within iframes when the action has a `frame` field.

---

### `hidden` — Wait for element to disappear

Wait for a CSS selector to become hidden or detached from the DOM.

```json
{ "action": "wait", "waitType": "hidden", "condition": ".loading-spinner" }
{ "action": "wait", "waitType": "hidden", "condition": ".overlay" }
```

**Condition:** A CSS selector. The wait resolves when no matching visible elements remain.

**When to use:** Steps like "wait for the spinner to disappear", "wait until the loading overlay is gone", "wait for the progress bar to finish". One of the most common waits in real-world UI automation.

---

### `text` — Wait for text content

Wait for specific text to appear anywhere in the page body.

```json
{ "action": "wait", "waitType": "text", "condition": "Welcome to Dashboard" }
```

**Condition:** A text string. Matched via `body.textContent.includes()`.

**When to use:** Steps like "wait until it says Welcome", "wait for the success message". Ideal when you know what text the page should show but don't know the exact element or selector.

---

### `url` — Wait for specific URL

Wait for the page URL to match a pattern.

```json
{ "action": "wait", "waitType": "url", "condition": "https://app.com/dashboard" }
{ "action": "wait", "waitType": "url", "condition": "**/dashboard" }
```

**Condition:** A URL string or glob pattern. Passed directly to Playwright's `waitForURL`.

**When to use:** Only when the step provides an explicit URL to wait for. Never guess URL paths from page names — use `load`, `text`, or `navigation` instead.

---

### `count` — Wait for element count

Wait until a CSS selector matches at least N elements.

```json
{ "action": "wait", "waitType": "count", "condition": "table tbody tr", "expected": "5" }
{ "action": "wait", "waitType": "count", "condition": ".search-result", "expected": "1" }
```

**Condition:** A CSS selector. **Expected:** Minimum number of matches (defaults to `"1"`).

**When to use:** Steps like "wait until the table has at least 5 rows", "wait for search results to load", "wait until there are 3 items in the cart".

---

### `attribute` — Wait for element attribute state

Wait for an element's attribute to reach a specific value, or for an attribute to be added/removed.

```json
{ "action": "wait", "waitType": "attribute", "selector": "#submit-btn", "expected": "!disabled" }
{ "action": "wait", "waitType": "attribute", "selector": ".progress", "expected": "aria-valuenow=100" }
{ "action": "wait", "waitType": "attribute", "selector": "#email", "expected": "aria-invalid=false" }
```

**Selector:** CSS selector for the target element. **Expected:** One of:
- `"attribute=value"` — wait for attribute to equal value
- `"!attribute"` — wait for attribute to be removed (e.g. `"!disabled"`)
- `"attribute"` — wait for attribute to be present (any value)

**When to use:** Steps like "wait until the button is enabled", "wait for the form to be valid", "wait for the progress bar to reach 100%".

---

### `navigation` — Wait for any navigation

Wait for the page URL to change from its current value. Does not require knowing the destination.

```json
{ "action": "wait", "waitType": "navigation" }
```

**Condition:** Not needed — automatically captures the current URL and waits for it to change.

**When to use:** Steps like "wait for the page to navigate", "wait for the redirect". Use this when you know a navigation will happen after an action (e.g. form submission) but don't know or care about the destination URL.

---

### `stable` — Wait for page to stabilise

Wait for the page to fully settle: network idle and no DOM mutations for 500ms.

```json
{ "action": "wait", "waitType": "stable" }
```

**Condition:** Not needed.

**When to use:** Complex SPAs where `networkidle` alone isn't sufficient because of websocket activity, polling, or cascading renders. Steps like "wait for the page to finish updating", "wait for all content to settle". This is the most conservative wait — use it when other wait types aren't reliable enough.

## Fallback Behaviour

When the AI omits `waitType`, the `inferWaitType` function applies a conservative heuristic:

1. Duration strings (e.g. `"30s"`) → `duration`
2. Load state keywords (`"networkidle"`, `"load"`, `"domcontentloaded"`) → `load`
3. URLs starting with `http` or `*` → `url`
4. Strings starting with `#`, `.`, `[` or tag+selector patterns (e.g. `div.class`) → `selector`
5. Everything else → `text`

This fallback is intentionally conservative — ambiguous strings default to `text` (content check) rather than `selector` (CSS parse), avoiding the CSS parse errors that motivated this refactor.

## Files Changed

- `src/ai/types.ts` — Added `waitType` field to `AIAction`
- `src/browser/actions.ts` — Replaced heuristic `executeWait` with switch on `waitType`, added `inferWaitType` fallback
- `src/ai/prompts.ts` — Updated AI instruction rule 12 with per-type guidance

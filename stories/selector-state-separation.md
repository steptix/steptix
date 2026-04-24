# Selectors describe elements, waitTypes describe state

## Context

A GitHub test failed with a confusing timeout:

```
Action failed [wait]: page.waitForSelector: Timeout 10000ms exceeded.
Call log:
  - waiting for locator('#query-builder-test\:visible') to be visible
```

The AI had chained a `click` with a `wait` (Layer 1 from the SPA-waits work) and written the wait selector as `#query-builder-test:visible`. The framework already passes `state: 'visible'` to Playwright's `waitForSelector`, so the `:visible` pseudo in the selector was redundant. More importantly, the framework's CSS selector sanitizer — designed to escape Tailwind's colon-bearing class names like `.hover:bg-blue-500` — didn't recognise `:visible` as a legitimate pseudo-class and escaped the colon: `#query-builder-test\:visible`. Playwright then dutifully waited for an element with a (made-up) literal class name of `\:visible`, which doesn't exist. The wait timed out after 10s and the step failed.

Two things were wrong, and each deserves its own fix:

1. **Prompt/behaviour:** the AI encoded state in a CSS selector instead of using the framework's dedicated `waitType`. The framework has explicit `waitType` values for every state we care about — the selector should describe *what element*, `waitType` describes *what state*.
2. **Sanitizer correctness:** even if the AI writes a legitimate Playwright pseudo (like `:has-text("Login")` in a click selector), the sanitizer mangles it. It was conflating "Tailwind-style class names with colons" with "CSS/Playwright pseudo-classes" and over-escaping.

This story documents the three-part fix.

## Fix 1 — Prompt guidance: keep selectors as pure CSS

Rule 12 now opens with an explicit principle:

> Keep selectors as pure CSS — describe WHAT element, and let "waitType" describe WHAT STATE. Never encode state (visibility, hidden, enabled, disabled, presence) in the selector itself via pseudo-classes like `:visible`, `:hidden`, `:not(:visible)`, `:disabled`, `:empty`. The framework applies the correct Playwright state automatically based on "waitType", so adding state pseudos to the selector is redundant and commonly fails.

This generalises the fix. Rather than a one-line nudge about `:visible`, it teaches the AI to treat `waitType` as the canonical way to express state. The mapping it should follow:

| What the AI wants | Do NOT encode in selector | Do use |
|---|---|---|
| Element becomes visible | `:visible` | `waitType: "selector"` (state is enforced automatically) |
| Element disappears | `:hidden`, `:not(:visible)` | `waitType: "hidden"` |
| Element contains text | `:has-text("X")` as state | `waitType: "text"` with the text as `condition` |
| Element in attribute state | `[disabled]` / `:disabled` | `waitType: "attribute"` with `expected: "disabled"` |
| N elements exist | (can't in plain CSS) | `waitType: "count"` with `expected: "N"` |

## Fix 2 — Sanitizer correctness: whitelist Playwright pseudos

`sanitizeCssSelector` in `src/browser/actions.ts` already had a whitelist of standard CSS pseudo-classes (`:hover`, `:focus`, `:nth-child`, etc.) that it leaves alone. Playwright's own pseudo-classes weren't on that list, so they were getting mangled.

Added to the whitelist:

- `visible`, `hidden` — Playwright state pseudos.
- `has-text`, `text` — text-matching pseudos (very useful for disambiguating elements by visible label, e.g. `button:has-text("Sign in")`).
- `nth-match` — Playwright's ordered-match pseudo.
- `light` — shadow-DOM boundary pseudo.

### Why whitelist if the prompt says "don't use them"?

The prompt and sanitizer solve different problems:

- **Prompt** stops the AI from writing state pseudos where a `waitType` should be used.
- **Sanitizer** is a pure correctness fix — its contract is "escape characters that would break CSS parsing of Tailwind-style class names." It was doing double duty, also policing usage style, which caused this bug. After the fix, the sanitizer's contract is narrower: it escapes Tailwind-shaped colons and leaves everything else alone.

The sanitizer fix matters because `:has-text()` is a legitimate, useful selector syntax that the AI *should* be able to use in click/type/select selectors. The old sanitizer would have mangled `button:has-text("OK")` the same way it mangled `:visible`, producing baffling failures. Whitelisting these pseudos removes that landmine regardless of whether the AI follows the prompt rule.

## Fix 3 — Defensive strip in `executeWait`

Belt-and-braces: `executeWait` now strips a trailing `:visible` from the selector for `waitType: "selector"`, and strips a trailing `:hidden` or `:not(:visible)` from the selector for `waitType: "hidden"`:

```ts
case 'selector': {
  const rawSel = condition.replace(/:visible$/, '');
  const sel = sanitizeCssSelector(rawSel);
  ...
  await page.waitForSelector(sel, { state: 'visible', timeout });
}

case 'hidden': {
  const rawHidden = condition
    .replace(/:hidden$/, '')
    .replace(/:not\(:visible\)$/, '');
  const hiddenSel = sanitizeCssSelector(rawHidden);
  ...
  await page.waitForSelector(hiddenSel, { state: 'hidden', timeout });
}
```

Two reasons for this safety net:

1. If the AI ignores the prompt rule, the wait still works. `state: 'visible'` / `state: 'hidden'` already enforces the condition, so stripping the redundant pseudo from the selector is a no-op in intent but prevents the selector from failing for structural reasons.
2. Even with the sanitizer fix, passing `button:visible` to `waitForSelector` goes through Playwright's query engine where `:visible` is only interpreted in locator contexts, not every API path. Stripping it makes behaviour consistent regardless of the call path.

## Why all three fixes

The three fixes solve different problems that happened to surface through the same bug:

- **Prompt** is prevention at the source. Stops the pattern for the common case.
- **Sanitizer whitelist** is a correctness fix for the sanitizer's own contract. Fixes the bug for `:has-text()` and other legitimate Playwright pseudos the AI *should* be able to use.
- **Defensive strip** is a cheap safety net for the specific redundancy (`:visible` + `state: 'visible'`). Makes the framework tolerant of the mistake rather than failing mysteriously.

Each fix is standalone-useful. Together they give defence in depth: if the AI writes the right selector, everything works. If the AI writes `button:has-text("X")`, it works (whitelist). If the AI writes `#foo:visible`, it works (strip). If the AI writes something genuinely unparseable, Playwright fails with a clear error instead of the old "timed out waiting for \\:visible" red herring.

## Files touched

- `src/ai/prompts.ts` — rule 12 preamble about pure-CSS selectors + state via `waitType`.
- `src/browser/actions.ts`:
  - `sanitizeCssSelector` pseudo-class whitelist expanded with Playwright pseudos.
  - `executeWait` strips trailing `:visible` / `:hidden` / `:not(:visible)` from wait selectors.

## Not included

- **Sanitizer rewrite.** The current sanitizer works by escape-and-whitelist. A cleaner approach would parse the selector properly and only escape colons inside identifier tokens that can be proven to be class-name characters (i.e. the part after `.` up to the next selector boundary). That's a larger project and not needed for this specific bug.
- **Prompt examples for `:has-text()` pairings.** The prompt doesn't yet model `button:has-text("Login")` as the preferred way to disambiguate buttons by visible label. Worth a follow-up — the sanitizer now supports it cleanly, and it's a more robust selector pattern than stacking classes.

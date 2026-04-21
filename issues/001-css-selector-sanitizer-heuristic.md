# 001 — CSS selector sanitizer uses a regex + pseudo-class allowlist

**Status:** open / accepted for now
**Area:** `src/browser/actions.ts` — `sanitizeCssSelector`
**Opened:** 2026-04-21

## Summary

`sanitizeCssSelector` escapes characters that are valid in Tailwind class
names and framework-generated IDs but invalid in raw CSS selector syntax
(`!`, `/`, `@`, `[]`, `:`). For the `:` case specifically, it must
distinguish a literal colon inside an identifier (e.g. React Aria's
`#react-aria-:rb4:` or Tailwind's `.hover:bg-blue-500` when the variant
appears literally in the DOM) from a real CSS pseudo-class like `:hover`.

We do this with a **hardcoded allowlist of known pseudo-class names** and a
regex. This is a heuristic, not a guarantee.

## Why this works most of the time

The AI emits selectors based on class/id strings it observes in the DOM.
The common cases we see are:

- React Aria IDs: `#react-aria-:rb4:` → escape both colons
- Tailwind variant classes: `.hover:bg-blue-500`, `.md:flex` → escape the `:`
- Real pseudo-classes: `.foo:hover`, `li:nth-child(2)` → leave alone

The allowlist (`hover`, `focus`, `nth-child`, `not`, `has`, `before`,
`after`, …) covers every pseudo-class we've actually seen come through the
pipeline.

## Known limitations

1. **Allowlist drift.** The list is static. Newer CSS pseudo-classes
   (`:user-valid`, `:user-invalid`, `:modal`, `:popover-open`, `:state()`,
   `:-webkit-autofill`, etc.) are missing and would get incorrectly
   escaped if the AI ever emitted them.
2. **Collisions.** If a class were literally named `hover` (e.g. some
   CSS-in-JS output), `.foo:hover` would ambiguously parse as "foo with
   :hover pseudo-class" when the author meant the literal class
   `foo:hover`. We side with the pseudo-class interpretation.
3. **`::` pseudo-elements.** Only single-colon handling. `.foo::before`
   works by accident (the second `:` is followed by `before`, which is in
   the list), but `::selection` and similar would be mis-escaped.
4. **No structural parsing.** We're doing regex-based approximation.
   A real CSS selector parser would distinguish identifier characters
   from pseudo-class introducers structurally.

## The alternative: a proper CSS selector parser

`postcss-selector-parser` is the de facto Node.js option.

### Performance cost

- **Per-call:** ~20–100 µs to parse a typical selector (simple ones ~10 µs,
  complex ones up to ~200 µs). The current regex is ~2–10 µs per call.
  Roughly **10× slower** per invocation.
- **Startup / bundle:** ~30 KB minified, a handful of transitive deps,
  adds ~5–15 ms to cold-start / first-require. Irrelevant for a long-
  running process; noticeable for short CLI invocations.

### In context

`sanitizeCssSelector` is called a handful of times per AI step. Each step
already costs hundreds of ms to several seconds (LLM round-trip,
Playwright action, screenshot, DOM snapshot). Going from 10 µs to 100 µs
per call adds ~90 µs per step — **0.01–0.1% of step latency. Imperceptible.**

### Trade-offs

- **+** Correctness: all pseudo-classes (including future ones),
  `::pseudo-elements`, namespaces, and escape edge cases handled right.
- **−** A new runtime dependency to audit, pin, and keep updated.
- **−** More code surface; the current regex is ~40 lines and self-
  contained.

## Decision

Keep the regex + allowlist for now. Revisit when:

- A new CSS pseudo-class shows up in real selectors and breaks things, **or**
- We hit a class-name / pseudo-class collision in real traces, **or**
- The sanitizer's logic starts accreting enough special cases that a
  proper parser becomes the simpler option.

Performance is **not** the reason to stick with regex — correctness
simplicity and dependency-surface are.

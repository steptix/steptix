# Assertion Code Cache

## Context

Assertions currently send a DOM snapshot to the AI on every test run, even when the
test hasn't changed. For large pages this is expensive in both tokens and latency.

An earlier design explored scope discovery (AI identifies relevant DOM subtrees) and a
three-tier fallback. That complexity was unnecessary once the core insight landed:

> If the goal is to run from cache with zero AI, pay the full cost once on the first
> run and cache the result forever.

The "result" worth caching isn't a pass/fail outcome — that changes per run. It's the
**verification method**: the JavaScript code that extracts the relevant data and
evaluates the assertion. The method is stable across runs; the actual values aren't.

## Design

### Single strategy — no tiers

On every assertion step:

1. **Cache hit** — run cached JS code via `page.evaluate`. Zero AI. Result is immediate.
2. **Cache miss** — capture full uncompacted DOM (collapse off, SVG off), ask AI to
   write the assertion code, cache it, run it.
3. **Code failure** (throws or returns wrong shape) — log warning, invalidate code
   cache, retry up to **2 total attempts**. On the second attempt the AI sees the full
   DOM again and writes fresh code. Hard fail if both attempts exhaust.

A genuine `{ pass: false }` from the code is a real assertion failure — it does **not**
trigger a retry.

### What the AI returns

The AI is given the full uncompacted DOM and the assertion instruction and must return:

```json
{
  "code": "(() => { const el = document.querySelector('#balance'); if (!el) return { pass: false, actual: 'element not found' }; const v = el.textContent.trim(); return { pass: v === '$24,582.90', actual: v }; })()"
}
```

The code is a self-executing function that returns `{ pass: boolean, actual: string }`.
It must handle missing elements gracefully (return `pass: false, actual: 'not found'`)
rather than throwing.

For cross-element assertions the code queries multiple selectors:

```js
(() => {
  const header = document.querySelector('#portfolio-total')?.textContent?.trim();
  const rows = [...document.querySelectorAll('#holdings tbody tr .value')];
  const sum = rows.reduce((acc, el) => acc + parseFloat(el.textContent.replace(/[^0-9.]/g, '') || '0'), 0);
  const formatted = '$' + sum.toLocaleString('en-AU', { minimumFractionDigits: 2 });
  return { pass: header === formatted, actual: `header=${header}, sum=${formatted}` };
})()
```

### Cache key and storage

Stored alongside existing step cache in the same per-test directory:

```
{cacheDir}/{sanitizedTestName}/step-{stepIndex}-assertion.json
{ "code": "(() => { ... })()" }
```

The cache is invalidated automatically when the test steps change (existing `stepsHash`
mechanism in `StepCache`). If resolved parameter values affect the assertion (e.g.
"verify the username is {{username}}"), parameter reverse-interpolation is applied to
the code before writing and forward-interpolated on read — same pattern as step cache.

### Full uncompacted DOM

The assertion DOM capture runs with both `collapseRepetitiveDom: false` and
`compactSvg: false`. The AI needs complete fidelity to write reliable selectors into
tables with many rows, collapsed lists, or SVG-heavy icon grids.

The `DOM_SNAPSHOT_CHAR_LIMIT` safety truncation still applies.

### Report

The assertion block in the HTML report shows:

- Pass / Fail status, expected, actual, explanation (unchanged)
- **From cache**: yes/no indicator
- **Assertion code**: collapsed `<details>` block showing the cached JS (useful for
  debugging selector failures after a page refactor)

## Implementation plan

1. `src/cache/step-cache.ts` — add `readAssertionCode`, `writeAssertionCode`,
   `invalidateAssertionCode` (with parameter interpolation)
2. `src/ai/prompts.ts` — add `buildAssertionCodePrompt`
3. `src/ai/action-parser.ts` — add `parseAssertionCode`
4. `src/ai/types.ts` — add `fromCache?: boolean` to `AssertionEvaluation`
5. `src/report/types.ts` — add `assertionCode?: string`, `fromCache?: boolean` to
   `AssertionResult`; remove `scopedDom` (scope discovery replaced by this)
6. `src/runner/step-executor.ts` — replace assertion evaluation block with new strategy
7. `src/report/generator.ts` + `template.ts` — render fromCache indicator and code block

## Testing

New page `fixtures/test-app/assertions.html` with:
- Single-element balance widget (simple selector)
- Transactions table (50 rows — tests that AI writes correct row selectors)
- Holdings list (complex list with nested values)
- Portfolio total that must equal the sum of holdings (cross-element assertion)

Test file `fixtures/tests/assertion-cache.md`:
- Run once to populate cache (AI generates code)
- Run again — all assertions served from cache with zero AI calls

## Non-goals

- Scope discovery / multi-tier fallback (removed — full DOM on cache miss is the right
  tradeoff when AI only runs once)
- Automatic cache invalidation on page structure change (rely on test author to bust
  cache by editing the step text, or run with `cache.enabled: false`)

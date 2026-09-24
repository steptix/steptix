# Value-only assertions — `Assert that X is at least 5`

> **Verification rule for this story.** "Done" means the demo
> `fixtures/tests/extract-orders-demo.md` runs through `npx aiui run … --env
> local` against a live test-app server with all three assertion steps
> passing — no markdown changes, no new tools, no `expected` field on the
> author's side. Vitest passing alone does not constitute "done"; the
> end-to-end CLI flow is the contract.

## Context

The framework's `assert` action today models exactly one shape:

```
DOM/API ──read──▶ actual value ──compare──▶ expected literal
```

The action requires three fields, all enforced at parse time
([src/ai/action-parser.ts:344-355](../src/ai/action-parser.ts#L344-L355)):

| Field | Meaning today |
|---|---|
| `description` | Short report label |
| `condition` | What to read (DOM selector path, API field path) |
| `expected` | The literal to compare the read value against |

Prompt rule 8 ([src/ai/prompts.ts:138](../src/ai/prompts.ts#L138)) tells the
AI all three are mandatory. The assertion-code generator
([src/ai/prompts.ts:318](../src/ai/prompts.ts#L318)) builds a prompt that
asks for JS which **reads** something and **compares** it to `expected`.

This works cleanly for the categories the framework was designed around:

| Pattern | Example |
|---|---|
| DOM equality | `Assert the title equals "Welcome"` |
| DOM count / presence | `Assert that 3 rows are visible` |
| API field | `Assert the response status is 200` |

It cannot handle a fourth shape that's just as natural in English:

| Pattern | Example |
|---|---|
| **Pure predicate over already-substituted values** | `Assert that {{order_count}} is at least 5` |
| | `Assert that {{failed_count}} equals 2` |
| | `Assert that {{failed_ids}} contains "O-1003" and "O-1007"` |

After `{{...}}` interpolation the resolved instructions become
`Assert that 8 is at least 5`, `Assert that 2 equals 2`, etc. There's
nothing in the DOM or API to read — both sides of the comparison are
already in the prompt text. The AI has no semantic value to put in
`expected`, returns the action without it, and the parser rejects the
whole turn. Two retries produce the same shape; the step fails.

This is a **framework expressivity gap**, not an authoring mistake.
Side-stepping it by writing a `verify_orders` tool with `step.expect()`
moves authoring effort out of markdown into TypeScript — which is exactly
the kind of compiled-language escape hatch the natural-language framework
exists to avoid.

## Goals

1. Authors can write `Assert that {{X}} <predicate phrasing>` in markdown
   and have it pass through the AI assertion path with no `expected`
   literal and no new tool boilerplate.
2. The three demo assertions in
   [fixtures/tests/extract-orders-demo.md](../fixtures/tests/extract-orders-demo.md)
   all pass under `npx aiui run`.
3. The existing three assertion shapes (DOM equality, DOM count, API
   field) keep working byte-for-byte. No regression in the existing
   passing tests.
4. The cache + report layers handle the new shape cleanly — no awkward
   "`expected: (none)`" rows or fingerprint collisions.

## Non-goals

- Replacing the existing `condition + expected` model. The new shape is
  **additive** — DOM/API assertions still go through the existing
  `condition + expected` path unchanged.
- Supporting predicates that need DOM access alongside substituted values
  (e.g. `Assert that {{count}} matches the row count on screen`). That's
  a hybrid; left for later.
- General natural-language predicate evaluation in arbitrary logical
  forms. The new path uses the AI to translate the resolved English
  predicate into a self-executing JS expression — same machinery as
  today, just with no DOM/API context.

## Design

### A new `against: 'predicate'` mode

The `assert` action's existing `against` field already discriminates
between `'dom' | 'api' | 'both'`
([src/ai/types.ts:124](../src/ai/types.ts#L124)). Add a fourth value:

```ts
against?: 'dom' | 'api' | 'both' | 'predicate';
```

When `against: 'predicate'`:
- `expected` is **optional** (and ignored if present).
- `condition` becomes the entire predicate — the resolved English text
  with substituted values, exactly as the AI received it.
- The assertion-code generator emits JS that evaluates the predicate
  directly, with no DOM access and no API context.

This keeps every existing shape's contract intact — the predicate path
is a new branch, not a rewrite.

### Parser changes

[src/ai/action-parser.ts:344-355](../src/ai/action-parser.ts#L344-L355)
relaxes the `expected` requirement:

```ts
// Required fields for assert: description, condition.
// expected is required for dom/api/both; optional for predicate.
if (typeof obj['description'] !== 'string' || !obj['description'].trim()) {
  throw new Error(`Assert action at index ${index} missing required "description" field`);
}
if (typeof obj['condition'] !== 'string' || !obj['condition'].trim()) {
  throw new Error(`Assert action at index ${index} missing required "condition" field`);
}
if (action.against !== 'predicate') {
  if (typeof obj['expected'] !== 'string' || !obj['expected'].trim()) {
    throw new Error(`Assert action at index ${index} missing required "expected" field (or set "against": "predicate" for self-contained predicates)`);
  }
}
```

The error message names the escape hatch so a misconfigured AI gets
nudged toward the predicate mode rather than failing opaquely.

### Prompt rule 8

[src/ai/prompts.ts:138](../src/ai/prompts.ts#L138) gains a fourth shape:

```
8. For "assert" actions, you MUST set: "description", "condition", and (in
   most cases) "expected". The "against" field discriminates four shapes:

   - against: "dom" (default): condition = what to read from the page,
     expected = the concrete literal it should equal.
       Example: { "action": "assert", "against": "dom",
                  "condition": "visible modal title text",
                  "expected": "Done", "description": "..." }

   - against: "api": condition = path into a prior API response,
     expected = the literal value at that path.
       Example: { "action": "assert", "against": "api",
                  "condition": "step_3.response.body.id",
                  "expected": "DEL-1234", "description": "..." }

   - against: "both": as above; both contexts available.

   - against: "predicate": the step instruction is already self-contained
     (parameter values were substituted via {{...}} so the resolved text
     reads like "Assert that 8 is at least 5" or "Assert that
     [\"O-1003\",\"O-1007\"] contains \"O-1003\""). condition = the
     resolved English predicate verbatim. expected is OPTIONAL — omit it.
     Use this whenever there is nothing in the DOM or prior API responses
     to fetch — the comparison is purely between values that already
     appear in the instruction text.
       Example: { "action": "assert", "against": "predicate",
                  "condition": "8 is at least 5",
                  "description": "order_count >= 5" }
```

### Assertion-code generator

[src/ai/prompts.ts:318](../src/ai/prompts.ts#L318)'s
`buildAssertionCodePrompt` gains a new branch when `against === 'predicate'`:

```
contextNote = 'The assertion is a self-contained predicate over values
already substituted into the instruction text. Do NOT call document.*
or query the DOM. Do NOT reference prior API responses. Translate the
condition directly into a self-executing JS function that returns
{ pass: <boolean>, actual: <string describing what was compared> }.';
```

No DOM snapshot is fetched, no screenshot, no API history — saves the
network roundtrip and AI tokens. The cached output is independent of
page state, so it's also a perfect cache target.

The returned JS will look something like:

```js
(() => {
  const left = 8;
  const right = 5;
  const pass = left >= right;
  return { pass, actual: `${left} >= ${right} → ${pass}` };
})()
```

The framework's existing `parseAssertionCode` and `page.evaluate` machinery
runs this verbatim — no executor changes needed.

### Cache fingerprint

[src/cache/step-cache.ts](../src/cache/step-cache.ts) (since removed) computes
`fingerprintAssertion(condition, expected, assertIndex)`. Today `expected`
is always defined; for predicate mode it'll be undefined. The
fingerprint must remain stable and collision-free:

```ts
fingerprintAssertion(condition, expected, assertIndex)
  → hash(`${condition}::${expected ?? '∅'}::${assertIndex}`)
```

A literal `∅` sentinel (or any string that can't appear in a real
`expected`) keeps the predicate fingerprint distinct from a hypothetical
`expected: ""` case while preserving the existing key shape.

### Report renderer

[src/report/generator.ts](../src/report/generator.ts) currently renders
assertion outcomes as:

```
Expected: Done
Actual:   Done
```

For predicate mode, render:

```
Predicate: 8 is at least 5
Result:    pass
```

The `AssertionResult` shape in [src/ai/types.ts](../src/ai/types.ts) already
carries `actual` and `pass` — just need the renderer to detect predicate
mode (via the parent action's `against` field) and swap the row labels.

### Step-executor changes

[src/runner/step-executor.ts:600-700](../src/runner/step-executor.ts#L600)
already plumbs `against` into `evaluateAssertion`. The DOM-snapshot fetch
at line 1275 is gated on `against === 'api'`; extend that gate to skip
DOM capture for `against === 'predicate'` too. Same with the screenshot
gate at line 1286.

## Risk

- **AI fallthrough**: a smaller model might emit `against: 'predicate'`
  for an assertion that genuinely needs DOM access (because the predicate
  reads natural and "no expected" looks easier). Mitigation: prompt rule
  8's predicate description includes the explicit "use this whenever
  there is nothing in the DOM or prior API responses to fetch". The first
  time this misfires, the predicate JS will return `{ pass: false,
  actual: "..." }` with an explanation, and the failure block will
  surface the misclassification clearly. Acceptable for v1.
- **Cache poisoning across modes**: if today a fingerprint exists for
  `(condition='8 is at least 5', expected='true')` and tomorrow the AI
  re-emits the same condition with `against: 'predicate'` and no
  `expected`, the keys differ (`expected ?? '∅'` differs from
  `'true'`) so the wrong code can't be served. Verified by reading the
  fingerprint impl.
- **Prompt rule 8 gets long**: it's already the longest rule. Adding a
  fourth shape adds another paragraph. Mitigation: the fourth shape
  doesn't introduce new fields; it only relaxes one. Net effect on AI
  behaviour is small. Future rewrite of rule 8 into a small table is
  a separate cleanup.

## Implementation order

1. Add `'predicate'` to `against` union in
   [src/ai/types.ts](../src/ai/types.ts).
2. Relax `expected` requirement in
   [src/ai/action-parser.ts](../src/ai/action-parser.ts) when
   `against === 'predicate'`. Keep the helpful error message for the
   default case.
3. Update prompt rule 8 in
   [src/ai/prompts.ts](../src/ai/prompts.ts).
4. Add `'predicate'` branch to `buildAssertionCodePrompt`'s `contextNote`,
   skip DOM/API context blocks for that mode.
5. Update `fingerprintAssertion` in
   [src/cache/step-cache.ts](../src/cache/step-cache.ts) (since removed) to handle
   `expected: undefined`.
6. Skip DOM + screenshot capture for predicate mode in
   [src/runner/step-executor.ts:1275-1289](../src/runner/step-executor.ts#L1275).
7. Update report renderer to use `Predicate:` / `Result:` labels when
   the action was a predicate assertion.
8. **Unit tests**:
   - parser accepts predicate without expected, rejects predicate with
     missing condition, still rejects DOM/API/both without expected
   - prompt rule 8 contains the new shape (regression on prompt drift)
   - `buildAssertionCodePrompt` produces the right contextNote and omits
     DOM/screenshot for predicate mode
   - fingerprint distinct between `predicate(condition='X')` and
     `dom(condition='X', expected='')`
   - report renderer uses Predicate/Result rows for predicate mode
9. **Integration test**: vitest spec that drives the full assertion
   pipeline (parse → generate code → evaluate JS → check result) for a
   predicate against a real Playwright page that has nothing relevant in
   the DOM, asserting it still passes/fails correctly.
10. **End-to-end CLI verification** (this is the success criterion, not a
    nice-to-have):
    a. Spawn the test-app server (`npx tsx fixtures/test-app/server.ts`).
    b. Run `npx aiui run fixtures/tests/extract-orders-demo.md --env local`.
    c. Confirm exit code 0 and all 3 assertion steps PASS.
    d. Kill the server.
    e. If it fails, debug the failure — DO NOT change the demo to dodge
       the problem. The demo's three assertions are the contract.

## Open questions for review before implementation

1. **Should `against: 'predicate'` be discoverable to the author via
   markdown syntax?** Today `against` is set by the AI, not the author.
   The author writes natural English; the AI infers the mode. I think
   that's right — but worth flagging that the author has no escape hatch
   if the AI chooses the wrong mode. Counter-argument: the same is true
   for every other AI-driven inference today.
2. **What does the report show for the `actual` column when a predicate
   passes vs fails?** The JS returns `{ pass, actual: '<string>' }`.
   On pass, the string might be `"8 >= 5 → true"`; on fail, `"8 < 5"`
   or similar. The renderer should display it verbatim under "Result"
   regardless. Nothing special needed.
3. **Should we accept `expected` if the AI provides it on a predicate
   assertion?** The plan above says "ignored if present". Alternative:
   reject it strictly so the AI doesn't drift. I lean toward strict
   rejection — fail loudly when the AI confuses modes — but happy to be
   overruled.

## What I will NOT do

- Add a `verify_*` fixture tool that uses `step.expect()`. (You ruled
  this out explicitly.)
- Change the demo's three assertion lines. They are the contract; if
  they don't pass after my implementation, the implementation is wrong.
- Claim "all green" based on vitest alone. The success criterion is the
  CLI flow against a live test-app, run end-to-end, with the report
  showing three green assertion rows.

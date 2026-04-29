# AI-Driven Assertions

## Context

Today the framework decides whether a step is an assertion via a regex on the
instruction text:

```ts
// src/runner/step-executor.ts (current)
return /^(verify|assert|check|confirm|ensure|should|must|expect|validate|...)/.test(stripped);
```

This causes false positives. The instruction "Confirm the action by clicking the
red button" begins with `confirm`, so the framework runs `page.evaluate` against
the post-click state and asserts something the user never asked for. It also
makes the step single-assertion: there is no way to model "click then verify the
modal title and verify the success banner appears" as one step — it has to be
three.

The AI is already being told (rule 5 in the system prompt) when to emit `assert`
actions. We should let *that* be the only signal and remove the regex.

## Decision

The presence of `assert` actions in the AI's plan is the **sole classification**
for whether a step has assertions. There is no `step_kind` field, no instruction
regex, no out-of-band hint. The action list is the truth.

## Design

### `assert` action shape

`assert` becomes a first-class action with required fields:

```ts
{
  action: "assert",
  description: string,    // human-readable label for the report
  condition: string,      // what is being checked (natural language)
  expected: string,       // expected value/state, concrete
  // optional:
  poll?: { timeoutMs?: number; intervalMs?: number },  // bounded retry on the assert
  against?: 'dom' | 'api' | 'both'                     // default 'dom'
}
```

`description`, `condition`, and `expected` are required when the action is
`assert`. A malformed `assert` action is rejected by the parser with a clear
error.

### Inline evaluation

When the executor encounters an `assert` action mid-turn, it evaluates inline
against the page state at that moment (plus API context if `against` includes
`api`). Evaluation is the same JS-snippet-via-`page.evaluate` strategy that
exists today for the post-step assertion phase, just relocated to the per-action
path:

1. Compute fingerprint = hash of `condition + expected + assertIndex`.
2. Look up cached JS code by `(stepIndex, assertIndex, fingerprint, resolvedParams)`.
3. **Cache hit** — run cached code via `page.evaluate`. Zero AI.
4. **Cache miss** — capture full uncompacted DOM, ask AI for evaluation code,
   cache it, run it.
5. **Code throws or returns wrong shape** — invalidate that one cache entry,
   regenerate, retry once. Hard fail after 2 attempts.
6. **Result `{ pass: false }`** — record as a failed assertion.

### Polling (eventual consistency)

When the AI sets `poll` on an assert (because the instruction implies eventual
consistency — "eventually shows", "after a moment"), the executor calls
`page.evaluate(jsCode)` in a loop until `pass: true` or the timeout is hit.
Default is 5000 ms timeout / 250 ms interval; the AI may override.

The poll config is metadata on *how to invoke* the JS; it is not part of the
fingerprint, so changing the timeout doesn't invalidate cached code.

### `against` modes

- `'dom'` (default): generate code that queries the DOM only. DOM is sent to
  the AI; API context is not.
- `'api'`: assertion is purely about prior API responses. DOM is not sent to
  the AI; API context is sent. Code does not call `document.*`.
- `'both'`: both DOM and API context sent. For mixed assertions.

The AI selects the mode based on the instruction; framework defaults to `'dom'`
when the AI omits it.

### Failure semantics

A failed `assert` (pass: false, OR JS error after 2 attempts) fails the step
**immediately**:

- No subsequent actions in the same turn execute.
- No re-evaluation turn is started, even if `needs_reeval: true` was set.
- The step result is `failed` with an error message naming the failed
  assertion(s) by `description`.

Multi-turn interaction: a turn may emit `[click, assert, ...]` plus
`needs_reeval: true`. Order of operations:

1. Execute `click`.
2. Evaluate `assert`. If it fails, fail the step. If it passes, continue.
3. If `needs_reeval: true`, snapshot and start the next turn.

### Cache structure

Two files per step in the existing cache directory:

```
{cacheDir}/{sanitizedTestName}/step-{stepIndex}.json           # action plan turns
{cacheDir}/{sanitizedTestName}/step-{stepIndex}-asserts.json   # assertion eval code, keyed by assertIndex
```

The asserts file is a JSON object:

```json
{
  "0": { "fingerprint": "abc123…", "code": "(() => { … })()" },
  "1": { "fingerprint": "def456…", "code": "(() => { … })()" }
}
```

Cache schema version bumps from **2 → 3**. Old caches invalidate automatically
on next run.

### Reporting

`StepResult.assertion?: AssertionResult` (singular) becomes
`StepResult.assertions: AssertionResult[]` (plural, default empty).

Each `AssertionResult` carries:

- `description`, `condition`, `expected`, `actual`, `pass`, `explanation`
- `fromCache: boolean`, `assertionCode: string`
- `turnNumber: number`, `subActionIndex: number` (interleaving in execution order)
- `aiInteraction?` (only when not from cache)

The HTML report and Runner UI render one assertion block per entry, in execution
order, interleaved with their surrounding sub-actions. Failure messages list
each failed assertion by `description`.

### Prompt changes

- Strengthen the existing rule 5 in `buildSystemPrompt`: `assert` only when the
  instruction's *intent* is verification. Action verbs that overlap with
  verification words ("Confirm by clicking", "Check the box") are not asserts.
- Document the new required fields (`description`, `condition`, `expected`) and
  optional fields (`poll`, `against`) with examples.
- Note that a failed assert short-circuits the step.

## Removals

- `isAssertionStep` regex in `src/runner/step-executor.ts`.
- The post-turn assertion-evaluation block (lines ~944–1034). Replaced by inline
  per-action evaluation.
- `StepCache.readAssertionCode` / `writeAssertionCode` / `invalidateAssertionCode`
  on a single per-step file. Replaced by per-step *map* (per-assertIndex) variants.
- `StepResult.assertion` (singular) — replaced by `assertions` (plural).

## Files affected

| File | Change |
|---|---|
| `src/ai/types.ts` | Tighten `AIAction` for `assert`: require condition/expected/description; add `poll` and `against` |
| `src/ai/action-parser.ts` | Validate `assert` actions; reject malformed |
| `src/ai/prompts.ts` | Strengthen rule 5; rework `buildAssertionCodePrompt` to take per-assert fields |
| `src/runner/step-executor.ts` | Remove `isAssertionStep`; remove post-turn assertion phase; add inline assert handler |
| `src/cache/step-cache.ts` | New per-assert map; bump SCHEMA_VERSION 2→3 |
| `src/report/types.ts` | `assertion` (singular) → `assertions: AssertionResult[]`; add `turnNumber` / `subActionIndex` / `description` |
| `src/report/generator.ts` | Render N assertion blocks interleaved with sub-actions |
| `src/ui/renderer/components/OutputPanel.tsx` | Per-assert rendering |
| `tests/multi-turn.test.ts` and assertion regex tests | Update / remove regex-based cases |
| `tests/integration/*.md` | New end-to-end assertion test matrix (see below) |

## Test matrix

New `tests/integration/` directory with `.md` files exercising every case
against the existing `fixtures/test-app` server (port 8787):

| File | Scenario |
|---|---|
| `assertion-pure-verify.md` | "Verify the page total is $148,320.50" — single assert, no actions |
| `assertion-mixed-action.md` | Click + verify in one step |
| `assertion-confirm-is-not-assert.md` | "Confirm by clicking the red button" — must NOT trigger evaluation |
| `assertion-multi-turn.md` | Navigate then verify, single step, two turns |
| `assertion-multi-assert.md` | Two assertions in one step |
| `assertion-failure.md` | Deliberately wrong expected — fails fast, names failed assert |
| `assertion-cache-invalidation.md` | Edit expected → fingerprint change → new code generated |
| `assertion-cache-hit.md` | Re-run any green test → zero AI calls for the assertion phase |

The fixture page `fixtures/test-app/assertions.html` already exists and covers
DOM-based assertions. We add a small "confirm dialog" page for the
confirm-is-not-assert case.

## Non-goals

- New YAML syntax or `[assert]` step prefix.
- Polling primitives beyond `poll.timeoutMs` / `poll.intervalMs`.
- Auto-cleanup of orphaned assertIndex entries when an AI replan reduces the
  number of asserts. Lazy: stale entries take space but are harmless and clear
  on stepsHash change.
- Allowing assert results to feed into subsequent actions (e.g. "if the count
  is 3, click X"). That belongs to a separate branched-step mechanism.

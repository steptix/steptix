# 024 — Step cache: a parameter/capture value that should change *which element* is targeted silently rides the cache

**Status:** open / medium priority (correctness; partially self-healing)
**Area:** [src/cache/step-cache.ts:83-104](../src/cache/step-cache.ts#L83) (`read` re-fills params into a frozen plan), [src/cache/step-cache.ts:274-294](../src/cache/step-cache.ts#L274) (`reverseInterpolate` — `value` only, never `selector`), [src/cache/step-cache.ts:142-157](../src/cache/step-cache.ts#L142) + [228-238](../src/cache/step-cache.ts#L228) (`readAssertion` / `fingerprintAssertion` — the per-step fingerprint precedent), [src/runner/step-executor.ts:211-242](../src/runner/step-executor.ts#L211) (cache-hit replay + self-heal on failure), [src/runner/step-executor.ts:601](../src/runner/step-executor.ts#L601) (executor replays `cachedTurn.actions`)
**Related:** [issues/012-step-cache-not-env-aware.md](012-step-cache-not-env-aware.md) (same family: a frozen plan applied to a context it wasn't built for), [issues/023-cache-reverse-interpolation-substring-collision.md](023-cache-reverse-interpolation-substring-collision.md) (the mechanical sibling — value corruption vs. value-as-selector)
**Opened:** 2026-06-03

## Summary

The cache stores the AI's action plan as a **structural** artifact — selectors,
action order — with parameter values reverse-interpolated to placeholders. The
core assumption is that a parameter value only fills a *text field* (what to
type, what URL to enter), so one plan serves every value. That assumption breaks
when the value should change **which element the AI targets**, not just what it
types. In that case the cached selector is frozen to the element chosen on the
*first* run, and re-running with a different value replays the wrong target.

Unlike [023](023-cache-reverse-interpolation-substring-collision.md) (a literal
string-corruption bug), this is a **conceptual limitation** of the
params-ride-the-cache design: the frozen selector is often perfectly well-formed
— it just points at the wrong thing.

## Mechanism

On a cache hit, [executeStep](../src/runner/step-executor.ts#L212) replays the
cached `actions` and skips the AI call entirely (no DOM snapshot, no re-planning
— [step-executor.ts:454-473](../src/runner/step-executor.ts#L454)). The selector
in the cached action came from the AI reasoning over the value present on the
**first** run.

**Key fact: the cache only templatizes `action.value`, never `action.selector`.**
`reverseInterpolate` ([step-cache.ts:284-293](../src/cache/step-cache.ts#L284))
and `forwardInterpolate` ([step-cache.ts:321-333](../src/cache/step-cache.ts#L321))
touch the `value` field alone; nothing under `src/cache` rewrites `selector`, and
the executor replays `cachedTurn.actions` directly
([step-executor.ts:601](../src/runner/step-executor.ts#L601)) rather than
re-parsing the templatized `rawResponse`. So **the selector is always stored and
replayed literally** — it is frozen to whatever the AI chose on the first run,
regardless of the new value.

That makes the value-targeting failure unconditional; the two sub-cases differ
only in *how* the frozen selector fails:

1. **Selector encoded the value** (e.g. `tr:has-text("Laptop")`). It is **not**
   rebuilt to `tr:has-text("Phone")` — there is no selector interpolation. It
   replays as the literal `…"Laptop"…`. Fortunate, because a wrong literal
   usually *misses* and triggers the fail-and-heal path below rather than
   silently matching.

2. **Selector by position / derived id** (e.g. `tbody tr:nth-child(2)`, or
   `[data-id="8841"]` looked up from the Laptop row). The new value can't even
   change it in principle. If the position is still valid on the new run, it
   matches the **wrong** element silently.

When the frozen action **fails** (selector no longer matches), the executor
self-heals: it [invalidates the step and falls through to the AI](../src/runner/step-executor.ts#L234).
When it **silently matches the wrong element** (case 2, position still valid),
the step "passes" and does the wrong thing — a false positive that no
self-healing mechanism catches.

## Worked example

```
## Parameters
product: ${data.product}

## Steps
1. In the results table, click the row for {{product}}, then click "Add to cart"
```

- **Run 1** — `product = "Laptop"`. The AI sees the table, decides the Laptop row
  is row 2, emits `{ action: "click", selector: "tbody tr:nth-child(2) a.add" }`.
  The value `Laptop` does not appear in the selector → stored concretely.
- **Run 2** — `product = "Phone"` (Phone is row 4). Cache HIT (params ride; hash
  unchanged because `{{product}}` stays a placeholder and the data value that
  changed is a *param* default, not inline step text). The frozen
  `tr:nth-child(2)` clicks the **Laptop** row. If "Add to cart" exists there too,
  the step **passes** but adds the wrong product.

## Impact

- **False positives** in the silent-match case (case 2) — the most dangerous
  outcome for a test framework.
- **Cache thrash + a wasted failed attempt** in the fail-then-heal case (case 1
  when the rebuilt selector doesn't match): the entry is overwritten, so the
  value that *was* cached now misses next time.
- Most likely on **data-driven tests** (the same step re-run across rows with
  different values) and any step whose phrasing is "do X to the item identified
  by {{value}}".

## Fix sketches

**Option 1 — fingerprint the step's resolved instruction into the per-step cache
key.** Today the per-step key is positional
([frameScopedStepKey](../src/cache/step-cache.ts#L254) — frame + line). If the
key (or a per-step fingerprint stored alongside) included a hash of the
*resolved* instruction *and* the values that fed targeting, a different value
would miss and re-ask the AI. This is the assertion-cache pattern already in the
codebase ([readAssertion fingerprint](../src/cache/step-cache.ts#L142)). Cost:
loses the "one plan serves many values" benefit for these steps.

**Option 2 — DOM-fingerprint the cache hit (Option 2 from
[012](012-step-cache-not-env-aware.md)).** Hash page state at step start; only
hit when it matches. Robust but expensive and prone to false misses.

**Option 3 — opt-in marker for "value-sensitive" steps.** Let an author mark a
step (or the framework heuristically detect "click the … for {{x}}") as
value-targeting, and force such steps to bypass the action cache while still
caching purely-structural steps. Cheapest; relies on detection quality.

**Option 4 — accept + lean on `needs_reeval` + telemetry (status quo of
[012 Option 3](012-step-cache-not-env-aware.md)).** Document the limitation;
log when a cached replay fails-and-heals so users can see their cache fighting
value drift. Doesn't fix the silent-match false positive.

**Recommended:** Option 3 (detect/marker) for the common "click the row for
{{x}}" shape, with Option 1's per-step instruction fingerprint as the principled
fallback. Note the silent-match false positive (case 2) is the part *no*
self-healing mechanism catches — it argues for one of 1–3 rather than 4.

## Open questions

1. How common is case 2 (value not in selector) in practice? Worth instrumenting
   real runs: does the AI usually encode the value in the selector (case 1, often
   self-correct) or target by position/derived-id (case 2, silent)?
2. Can we reliably *detect* value-sensitive steps from the instruction text
   (verbs + `{{placeholder}}` near a targeting noun), or does that need an author
   marker?
3. Should captured values (`[store as: x]`) always be treated as value-sensitive,
   given they often drive "find the thing I just captured"?
4. If we fingerprint the instruction per step, do we still want the param
   placeholders preserved for the *type/enter* steps (so those keep riding) —
   i.e. is this a per-step policy rather than global?

## Tests this would need

- A "click the row for {{x}}" step caches under value A, then a run with value B
  does **not** replay A's frozen positional selector (misses / re-asks under the
  chosen policy).
- A purely structural step ("click Sign in") still rides the cache across param
  changes (no regression — we only want to bust the value-sensitive ones).
- A silent-match scenario (frozen selector still valid but wrong element) is
  caught by the new key/fingerprint rather than passing.

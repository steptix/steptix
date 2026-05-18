# 012 — StepCache is env-agnostic; cached responses may misapply across envs

**Status:** open / medium priority
**Area:** [src/cache/step-cache.ts](../src/cache/step-cache.ts), [src/runner/step-executor.ts](../src/runner/step-executor.ts) — cache key construction
**Related:** Goal-1 cache rewiring for the server path (TBD)
**Opened:** 2026-05-18

## Summary

`StepCache` keys cache entries by `(sanitised testName, hash(steps))` and
stores the AI's action plan with `{{param}}` placeholders intact —
forward-interpolating parameter values at read time. This makes the cache
**env-agnostic by accident**: a step cached against `.env.dev` will
serve cached actions when the same test runs against `.env.staging`, as
long as the steps array and its hash haven't changed.

That's usually fine. The AI's plan is structural ("click selector `[data-test=login]`")
rather than env-bound. But it's not always safe:

- Dev and staging environments often have **different DOMs** — different
  banner content, A/B-tested copy, feature-flag-gated elements, slightly
  different selectors when the team forgets to mirror changes across
  environments.
- A cached "click the 'Get started' button" from dev might map to a
  selector that doesn't exist on staging. The cached action fails, and
  while `needs_reeval` self-healing kicks in (cache invalidates, re-asks
  the AI), the *cache entry has been overwritten* — the next dev run
  now misses too. The cache thrashes back and forth between envs.

In the worst case the cached selector silently *matches* on the wrong
env (different element happens to share the selector), and the step
"passes" but did the wrong thing — a hard-to-debug class of false
positive.

## Why we accepted env-agnosticism initially

In CLI mode the cache was per-process and typically used within a
single env at a time (developers usually iterate against `dev`). The
cross-env-thrashing case existed but rarely triggered.

Wiring `StepCache` into the server changes the math: the server is
long-lived, shared across env switches via `testbench-native.activeEnv`,
and the on-disk cache survives between env changes. The "rarely
triggered" case becomes "every time you flip env."

## Fix sketches

**Option 1 — include envName in the cache namespace.**

```typescript
const cacheNamespace = request.envName
  ? `${request.testFilePath}::${request.envName}`
  : request.testFilePath;
const stepCache = await StepCache.initialize(baseDir, cacheNamespace, ...);
```

Per-env subdirectory in the cache. Different envs don't share entries.
Doubles disk footprint per env tested, but disk is cheap and the
behaviour becomes predictable.

Caveat: requires `envName` to be on the request. Already is, optionally —
would need to settle on a stable default (e.g., `"default"`) for the
no-env case so cache namespaces don't oscillate between
`{testFilePath}` and `{testFilePath}::default`.

**Option 2 — fingerprint the DOM snapshot into the cache key.**

Compute a hash of the page at step-start time, include it in the cache
key. Cache hits only when the DOM matches what generated the cached
response. Robust to env differences AND to mid-session page state
drift.

Cost: page state hashing is expensive (need a stable DOM snapshot
serialiser), and false misses are common (any incidental DOM change
busts the cache even when the AI's plan would still apply).

**Option 3 — keep env-agnostic, lean harder on `needs_reeval`.**

Status quo. Accept occasional cache thrashing. Add telemetry to log
when `needs_reeval` invalidations happen frequently, surface as a hint
to the user that their cache is fighting environment drift.

## Recommendation

Option 1 (env in namespace) is the cheapest correct fix. Land it
alongside the server cache wiring rather than as a separate follow-up
— the cost is one-line key construction and the benefit is "no
inter-env thrash from day one."

Option 2 is the principled fix that also handles intra-session page
drift, but it's a much bigger lift and probably overkill until we've
seen the simpler version run for a while.

## Tests this would need

- Cache populated under `envName=dev` is NOT read when the next request
  has `envName=staging` (different namespace).
- Cache populated with no `envName` is read on a subsequent no-env
  request.
- Hash of `steps` is still the inner invalidation lever — editing a
  step under `envName=dev` invalidates only the `dev` cache, leaves
  `staging` cache alone.

## Discovered while

Designing the server-side rewiring of `StepCache` (Goal 1 of the
"reduce tokens via skip-AI cache" effort). The env-agnostic behaviour
was a latent property of the original CLI cache that becomes load-
bearing in the server's longer-lived, cross-env use case.

## Revisit when

- The server cache wiring lands — fix at that time.
- A user reports "cached action ran against the wrong selector" or
  similar cross-env weirdness.

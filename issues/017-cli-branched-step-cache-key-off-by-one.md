# 017 — CLI branched/conditional steps use a 0-based cache key, colliding with 1-based normal steps

> **RESOLVED 2026-05-26.** Fixed via Option 2: `executeBranchedStep` now passes
> an explicit **1-based** `cacheKey` (`index + 1`) to its inner `executeStep`
> calls (matched outcome + continuation), matching the normal loop's
> `executeStep(i + 1, …)` keying — so every array position maps to a unique
> 1-based `step-<n>.json` and branched/normal steps can't collide. `StepResult.index`
> is left 0-based (the group skip/display logic depends on it); the latent
> attribution off-by-one noted below is deliberately out of scope. No dedicated
> E2E test was added — `executeBranchedStep`'s inner `executeStep` is in-module
> and needs a heavy page/AI mock surface to drive; the fix is a 2-line wiring
> change guarded by the full branched-step suite + code review.

**Status:** resolved 2026-05-26 (was: open / medium priority)
**Area:** [src/runner/step-executor.ts](../src/runner/step-executor.ts) — `executeBranchedStep` (inner `executeStep` calls); [src/runner/test-runner.ts](../src/runner/test-runner.ts) — normal step loop; [src/runner/step-grouper.ts](../src/runner/step-grouper.ts) — 0-based group indices
**Related:** [016-skill-cache-key-collisions.md](016-skill-cache-key-collisions.md) (same flat `step-<id>.json` cache, different code path), [step-cache-server.md](../testbench-native/stories/specs/step-cache-server.md)
**Opened:** 2026-05-26

## Summary

The CLI runner keys a step's cache file by the index it passes as `executeStep`'s
first arg, which becomes `step-<id>.json`
([step-cache.ts:191](../src/cache/step-cache.ts#L191)). Two CLI code paths
disagree on the base of that index:

- **Normal steps** pass a **1-based** index: `executeStep(i + 1, …)`
  ([test-runner.ts:574](../src/runner/test-runner.ts#L574),
  [:600](../src/runner/test-runner.ts#L600)).
- **Branched/conditional steps** pass a **0-based** index:
  `executeStep(matchedOutcome.index, …)`
  ([step-executor.ts:1996-1997](../src/runner/step-executor.ts#L1996-L1997),
  continuation at [:2037](../src/runner/step-executor.ts#L2037)), where
  `matchedOutcome.index` is the 0-based position assigned in
  [step-grouper.ts:72](../src/runner/step-grouper.ts#L72)/[:79](../src/runner/step-grouper.ts#L79).

Both paths run with caching active — the branched call forwards `stepCache` +
`cacheEnabled` ([test-runner.ts:402-403](../src/runner/test-runner.ts#L402-L403)),
and `executeBranchedStep` forwards `opts` verbatim to its inner `executeStep`
(no `cacheKey` override). So a normal step and a branched step that are one
array position apart map to the **same** `step-<n>.json` and overwrite/replay
each other's cached plan.

## Reproduce

Test steps (0-based array index in brackets), CLI run with
`cache.enabled: true`:

```
[0] Log in as admin                      → normal → executeStep(0+1)  → step-1.json
[1] If a cookie banner is shown, dismiss → conditional (index 1)
[2] Continue to the dashboard            → continuation (index 2)
```

When the conditional at array index `[1]` matches, the branched path runs
`executeStep(matchedOutcome.index = 1, …)` → **`step-1.json`** — the same file
the normal "Log in as admin" step (key `0 + 1 = 1`) already wrote. The cookie
step replays the login step's cached actions, or vice-versa on the next run.

## Root cause

`executeBranchedStep` reuses the group's 0-based `index` (from `step-grouper`)
directly as both the `StepResult.index` and the cache identity, while the rest
of the runner treats step identity as 1-based. The codebase already assumes the
branched `result.index` is 1-based elsewhere —
[test-runner.ts:408-409](../src/runner/test-runner.ts#L408-L409) does
`test.sourceSkills[result.index - 1]` with the comment "result.index is
1-based" — so the 0-based value is also a latent off-by-one for skill
attribution and history lines on branched steps, not only for the cache.

## Scope / when it bites

- **CLI only.** The server path (`SessionManager`) does not cache branched
  steps — its `executeBranchedStep` call passes no `stepCache`
  ([session-manager.ts](../src/server/session-manager.ts), conditional-group
  branch), so the collision can't occur there (issue 016 review, finding #3).
- Requires `cache.enabled: true` **and** a test with conditional/branched
  steps. Narrow, but a silent wrong-replay when hit.
- **Independent of skills / issue 016.** Introduced with the conditional-step
  lookahead feature, not the skill-expansion cache. Issue 016's frame-scoped
  keys fix the *server* skill collisions; this is a separate CLI indexing bug.

## Fix sketch

Make the branched path use the same 1-based step identity as the normal path.
Either:

1. Pass `matchedOutcome.index + 1` (and the continuation's `+ 1`) as
   `executeStep`'s index in `executeBranchedStep`, and audit the `- 1` /
   `result.index` consumers in `test-runner.ts` so display, history, and skill
   attribution stay consistent; **or**
2. Now that `StepExecutorOptions.cacheKey` exists (issue 016), pass an explicit
   1-based `cacheKey` for branched steps while leaving `StepResult.index`
   alone — decoupling the cache identity from the display index the same way
   the server path now does. This is the smaller, lower-risk change.

Option 2 is preferred: it fixes the cache collision without touching the
0-based display/attribution semantics that other branched-step code already
depends on (or, if those are also wrong, fix them as a separate, clearly-scoped
change).

## Tests this would need

- CLI run, cache on, a conditional whose matched-outcome 0-based index equals a
  normal step's 1-based key → the two steps must write **distinct** cache files
  (no shared `step-<n>.json`).
- Re-run of the same test hits cache on both without cross-replay.
- Branched `StepResult.index` / skill attribution stays correct after the fix
  (guard against re-introducing the [test-runner.ts:409](../src/runner/test-runner.ts#L409)
  `- 1` mismatch).

## Discovered while

Reviewing the issue 016 Bug 1 fix (frame-scoped server cache keys). The review
asked whether other cache callers could collide; the CLI branched path turned
out to have a pre-existing, skills-independent off-by-one.

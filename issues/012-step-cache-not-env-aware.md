# 012 — StepCache is env-agnostic; cached responses may misapply across envs

**Status:** open / medium priority — **resolution decided (Option 1: env in the cache namespace, `"default"` sentinel for no-env), see [Resolution](#resolution-decided-option-1--env-in-the-cache-namespace); not yet implemented**
**Area:** [src/cache/step-cache.ts](../src/cache/step-cache.ts) (`sanitizeTestName`, `initialize`), [src/server/session-manager.ts:1592](../src/server/session-manager.ts#L1592) (server cache init — `cacheDir`), [src/server/session-manager.ts:1313](../src/server/session-manager.ts#L1313) (`requestedEnvName` already resolved here), [src/runner/test-runner.ts:135](../src/runner/test-runner.ts#L135) (CLI cache init), [testbench-native/src/extension/cache-paths.ts](../testbench-native/src/extension/cache-paths.ts) (`cacheDirForTest` — the extension's clear-cache mirror)
**Related:** [issues/027-cache-testname-truncation-collision.md](027-cache-testname-truncation-collision.md) (the env segment must NOT be exposed to `sanitizeTestName`'s 100-char truncation — drives the directory-segment form chosen below), [issues/028-cli-cache-key-collides-and-ignores-env.md](028-cli-cache-key-collides-and-ignores-env.md) (the CLI manifestation — same fix applies there), [issues/018-step-cache-blind-to-data-file-value-changes.md](018-step-cache-blind-to-data-file-value-changes.md) (env *values in step text* already bust the hash — this issue covers the same-text/different-DOM residue)
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

## Fix sketches (considered)

**Option 1 — include envName in the cache namespace. CHOSEN.** Give each env its
own subtree in the cache so entries are never shared across envs. Different envs
don't share entries; disk footprint multiplies by the number of envs tested, but
disk is cheap and the behaviour becomes predictable. Requires a stable sentinel
(`"default"`) for the no-env case so namespaces don't oscillate between
`{test}` and `{test}/default`. **See [Resolution](#resolution-decided-option-1--env-in-the-cache-namespace).**

**Option 2 — fingerprint the DOM snapshot into the cache key. Deferred.** Hash
the page at step-start and include it in the key; hits only when the DOM matches
what generated the cached response. Robust to env differences *and* mid-session
page drift — but page-state hashing is expensive (needs a stable DOM serialiser)
and false misses are common (any incidental DOM change busts the cache). Bigger
lift; revisit only if Option 1 proves insufficient against intra-env drift.

**Option 3 — keep env-agnostic, lean harder on `needs_reeval`. Rejected.** Status
quo plus telemetry on frequent invalidations. Leaves the silent wrong-element
false positive (a cached selector that *matches* the wrong element on another env
and "passes") uncaught — and that's the case correctness most needs closed.

---

## Resolution (decided): Option 1 — env in the cache namespace

**Decision:** namespace the on-disk cache by the active env, using the literal
`"default"` as the stable sentinel whenever no env is selected. A cache entry
populated under one env is never read under another; the no-env case maps to a
single fixed `default` namespace (never oscillates).

### Mechanism — env as a distinct directory segment (not folded into the test name)

The env goes in as its **own path segment**, `.cache/<env>/<sanitised-test>/`,
rather than being concatenated into the `testName` string
(`{testFilePath}::{env}`) as the original sketch suggested. Folding it into the
name would route it through `sanitizeTestName`'s `.slice(0, 100)` truncation
([issue 027](027-cache-testname-truncation-collision.md)) — on a long test path
the `::env` suffix would be **truncated away**, silently collapsing the very
namespacing we're adding. A separate segment is immune to that and keeps the
existing `StepCache.initialize(baseCacheDir, testName, steps)` signature
unchanged: just fold the env into `baseCacheDir`.

Define one shared helper so every call site agrees. **Export it from
[src/cache/step-cache.ts](../src/cache/step-cache.ts)** (next to `sanitizeTestName`)
for the server + CLI; the extension cannot import from `src/`, so **mirror it
into [testbench-native/src/extension/cache-paths.ts](../testbench-native/src/extension/cache-paths.ts)**
exactly as `sanitizeTestName` is already mirrored there (the cross-module parity
test below guards drift):

```ts
export const NO_ENV_NAMESPACE = 'default';
/** Sanitised, collision-free directory segment for an env (or the no-env sentinel). */
export function envCacheSegment(envName: string | null | undefined): string {
  return sanitizeTestName(envName?.trim() || NO_ENV_NAMESPACE);
}
```

`StepCache.initialize` already does `fs.mkdir(cacheDir, { recursive: true })`, so
the extra nested `<env>/` segment needs no other change in the cache primitive —
only the `cacheDir` passed in.

**Server** ([session-manager.ts:1592](../src/server/session-manager.ts#L1592)) —
`requestedEnvName` is already resolved at
[session-manager.ts:1313](../src/server/session-manager.ts#L1313):

```ts
// before: const cacheDir = pathJoin(projectRoot, projectConfig.cache.dir);
const cacheDir = pathJoin(projectRoot, projectConfig.cache.dir, envCacheSegment(requestedEnvName));
stepCache = await StepCache.initialize(cacheDir, request.testFilePath, cacheHashSource);
```

**CLI** ([test-runner.ts:135](../src/runner/test-runner.ts#L135)) — `runTest`
does **not** currently have the env name in scope (see Resolved decision 4), so
thread the CLI-resolved `cliEnvName` down (`runTests` → `runTest`, e.g. via the
existing options arg) and combine it with the per-test frontmatter override at
the call site. Note this file uses `path.join` (not the server's `pathJoin`):

```ts
// effective per-test env: frontmatter `env:` wins over the run-level --env/AUTOMATION_ENV
const effectiveEnv = test.frontmatter.env?.trim() || runEnvName /* threaded cliEnvName */;
const baseDir = path.join(config.cache.dir, envCacheSegment(effectiveEnv));
const stepCache = await StepCache.initialize(baseDir, test.title, test.steps);
```

This env-segment change is **orthogonal** to [issue 028](028-cli-cache-key-collides-and-ignores-env.md)'s
title-vs-path key change: the env lives in `baseCacheDir` (first arg), the
title/path is the separate `testName` (second arg), so the two fixes compose
without conflict if implemented separately.

### Layout

```
.cache/
  default/                         ← no --env / no env: frontmatter
    <sanitised-test>/meta.json + step-*.json
  dev/
    <sanitised-test>/…
  staging/
    <sanitised-test>/…
```

### Extension impact (must change in lockstep)

`cacheDirForTest(testFilePath)` in
[testbench-native/src/extension/cache-paths.ts:45](../testbench-native/src/extension/cache-paths.ts#L45)
currently returns `<projectRoot>/.cache/<sanitised-test>/`. It must take and
insert the env segment: `cacheDirForTest(testFilePath, envName)` →
`<projectRoot>/.cache/<env>/<sanitised-test>/`. Its only caller is the
clear-cache command at
[testbench-native/src/extension/commands/index.ts:376](../testbench-native/src/extension/commands/index.ts#L376),
which must pass the **active env** (the extension already tracks
`testbench-native.activeEnv`). Follow-on:

- **"Clear cache for this test"** clears the **active env's entry only**
  (decided) — remove `<active-env>/<sanitised-test>/`, leaving other envs'
  caches intact.
- Per CLAUDE.md, editing `cache-paths.ts` (under `testbench-native/`) requires a
  **patch-version bump** of the testbench-native `package.json`. The `src/`
  edits (`step-cache.ts`, `session-manager.ts`, `test-runner.ts`) are the root
  package — **not** bundled into the extension, so they don't trigger a bump.

### What this does and doesn't fix

- **Fixes:** cross-env thrash and the silent wrong-element false positive — dev
  and staging never share an entry, so a dev plan can't replay on staging.
- **Already handled (orthogonal):** env *values that appear in step text* already
  bust the hash via [issue 018](018-step-cache-blind-to-data-file-value-changes.md).
  This change adds isolation for the **same-text / different-DOM** residue that
  018 can't see.
- **Out of scope:** intra-env page drift (Option 2 territory) and the
  coarse-mtime data-reload window ([026](026-cache-data-edit-missed-on-coarse-mtime.md)).

## Resolved decisions

1. **Clear-cache scope — active-env-only.** "Clear cache for this test" removes
   only `<active-env>/<sanitised-test>/`; other envs' caches are left intact.
   (Reflected in *Extension impact* above.)
2. **Sentinel collision — accepted.** A real env *can* be named `default`, in
   which case it shares the no-env namespace (both map to `.cache/default/...`).
   This is fine: a project that defines an env named `default` means that env,
   and a no-env run and an `--env default` run sharing one cache is the intended
   reading of "default". Documented so it's not a surprise; no guard needed.
3. **Migration — none.** Existing flat `.cache/<test>/` dirs from before this
   change are simply orphaned (never read again, harmless). Leave them; do not
   add migration/cleanup code. A manual `clear` removes them if a user cares.
4. **CLI env source — must be threaded in (confirmed not in scope).** The CLI
   resolves the env name as `cliEnvName` at
   [run.ts:53](../src/cli/commands/run.ts#L53) (`--env` > `AUTOMATION_ENV` >
   unset) and uses it to load the bundle, but it is **not** passed into
   [`runTests`](../src/runner/test-runner.ts#L943) →
   [`runTest`](../src/runner/test-runner.ts#L110), so it is **not in scope** at
   the `StepCache.initialize` call site
   ([test-runner.ts:135](../src/runner/test-runner.ts#L135)). Implementation must
   thread the **effective per-test env** down (a new field on `TestInstance` or a
   `runTests`/`runTest` option). "Effective per-test" matters because frontmatter
   `env:` overrides the CLI flag per test
   ([run.ts:110-122](../src/cli/commands/run.ts#L110)) — the value that namespaces
   the cache must be the env that test actually ran under, not just `--env`.

## Tests this would need

- Cache populated under `envName=dev` is NOT read when the next request has
  `envName=staging` (different segment).
- Cache populated with no `envName` is read on a subsequent no-env request (both
  map to the `default` segment — proves the sentinel is stable, not oscillating).
- A no-env run and an `envName=default` run resolve to the **same** directory
  (sentinel == literal `default`).
- Hash of `steps` is still the inner invalidation lever — editing a step under
  `envName=dev` invalidates only the `dev` segment, leaves `staging` alone.
- The env segment is a **separate path component**, so a 100-char-plus test path
  does not truncate it away (guards the [027](027-cache-testname-truncation-collision.md)
  interaction).
- `step-cache.ts` and `cache-paths.ts` compute the **same** env-namespaced
  directory for the same `(testFilePath, envName)` (cross-module parity).

## Discovered while

Designing the server-side rewiring of `StepCache` (Goal 1 of the
"reduce tokens via skip-AI cache" effort). The env-agnostic behaviour
was a latent property of the original CLI cache that becomes load-
bearing in the server's longer-lived, cross-env use case.

## Revisit when

- ~~The server cache wiring lands — fix at that time.~~ **Landed** (server
  initializes `StepCache` at [session-manager.ts:1592](../src/server/session-manager.ts#L1592)),
  so the load-bearing cross-env case is now live. Resolution above is ready to
  implement.
- A user reports "cached action ran against the wrong selector" or
  similar cross-env weirdness.

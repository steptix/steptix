# 028 — CLI step cache keys by test *title* (not file path) and ignores env, so same-titled tests collide and envs share entries

**Status:** open / low-medium priority (CLI path only)
**Area:** [src/runner/test-runner.ts:135](../src/runner/test-runner.ts#L135) (`StepCache.initialize(config.cache.dir, test.title, test.steps)`), [src/cache/step-cache.ts:51-79](../src/cache/step-cache.ts#L51) (cache dir from `testName`), [src/config/defaults.ts:69-72](../src/config/defaults.ts#L69) (`cache.dir` default `.cache`, flat)
**Related:** [issues/012-step-cache-not-env-aware.md](012-step-cache-not-env-aware.md) (env-agnosticism — same root, server-side framing), [issues/027-cache-testname-truncation-collision.md](027-cache-testname-truncation-collision.md) (sibling collision class on the server path), [issues/018-step-cache-blind-to-data-file-value-changes.md](018-step-cache-blind-to-data-file-value-changes.md) (notes the CLI resolves data at parse time)
**Opened:** 2026-06-03

## Summary

On the CLI path, the step cache is keyed by the test's **`# Title`**, not its
file path, and carries **no env** in the key:

```ts
const stepCache = await StepCache.initialize(config.cache.dir, test.title, test.steps);
```

Two consequences:

1. **Title collision** — two different test files that happen to share a `# Title`
   (e.g. both start `# Login`) map to the **same** cache directory and poison each
   other.
2. **Env-agnostic** — running the same test against `--env dev` then
   `--env staging` reuses the same cache entries (this is the CLI manifestation of
   [012](012-step-cache-not-env-aware.md); 012 is framed for the server, which at
   least keys by file path).

Scope note: action caching is **opt-in** (`cache.enabled` defaults to `false`,
[defaults.ts:70](../src/config/defaults.ts#L70); enabled via `## Config: cache: on`
or `cache.enabled: true`), so this only bites users who have turned the cache on.

## Mechanism

`StepCache.initialize` derives the cache directory purely from the `testName`
argument it's given ([step-cache.ts:57](../src/cache/step-cache.ts#L57)). The CLI
passes `test.title`. The server, by contrast, passes the absolute
`testFilePath` ([session-manager.ts:1558](../src/server/session-manager.ts#L1558))
— so the server is immune to title collisions (though it has its own truncation
collision, [027](027-cache-testname-truncation-collision.md)) and the CLI is not.

Neither path includes `envName`, so `dev` and `staging` runs of the same
test/title share one directory and one set of per-step plans.

Note the CLI does **not** suffer issue 018 (data-value staleness): its parser
interpolates `${data.*}` at parse time
([markdown.ts](../src/parser/markdown.ts), per 018's resolution note), so
`test.steps` reaching the cache are already resolved and the hash is data-aware
for free. The two problems here are **title collision** and **env sharing**, not
data staleness.

## Worked examples

**Title collision.** `tests/auth/login.md` and `tests/admin/login.md` both begin
`# Login`. `sanitizeTestName("Login")` → `login` for both → both use
`.cache/login/`. Running one then the other flips `meta.stepsHash`, wiping the
directory each alternation; the two tests never hold a warm cache simultaneously,
and on a hash coincidence would replay each other's plans.

**Env sharing.** `tests/checkout.md` run with `--env dev` caches a plan whose
selectors were chosen against dev's DOM. Re-run with `--env staging`: cache HIT,
so staging replays dev's selectors. (Partial backstop: an env value that appears
*in step text* is interpolated into `test.steps` before hashing — so a step like
`Go to ${env.BASE_URL}` already busts the hash across envs, the same self-clear
018 notes for the server. The genuinely unprotected case is **same step text,
different DOM**.) If staging's DOM differs (A/B copy, feature flags), the cached
action fails and self-heals — overwriting the entry, so the next dev run misses
too (thrash). Worst case it silently matches a wrong element and "passes" (the
[012](012-step-cache-not-env-aware.md) false-positive).

## Impact

- CLI users with conventional titles (`# Login`, `# Smoke test`) across multiple
  files get **persistent cache thrash** between the colliding files.
- Multi-env CLI workflows (`--env dev` / `--env staging` from the same checkout)
  get **cross-env replay** with no isolation.
- Both are silent: misses look like "cache isn't helping"; wrong-env matches look
  like flaky app behaviour.

## Fix sketches

**Option A — key the CLI by file path, like the server (recommended base).**
Pass the test's absolute (or project-root-relative) file path as `testName`
instead of `test.title`. Eliminates title collisions and aligns the two paths.
Pairs with [027](027-cache-testname-truncation-collision.md)'s hashing so long
paths don't re-introduce a collision.

**Option B — namespace the cache by env (both paths).** Include `envName` (with a
stable `"default"` for the no-env case) in the cache directory, e.g.
`.cache/<env>/<test-key>/`. This is [012](012-step-cache-not-env-aware.md)'s
Option 1, applied to the CLI too. Closes env sharing on both CLI and server.

**Option C — both A and B (recommended overall).** File-path key + env namespace
gives the CLI parity with a fixed server and removes both failure modes at once.

Data-driven CLI rows **share one cache directory** — the `(row N)` suffix at
[test-runner.ts:119-121](../src/runner/test-runner.ts#L119) is only a
`logger.testStart()` display string; the cache key at
[test-runner.ts:135](../src/runner/test-runner.ts#L135) uses the bare
`test.title`, and the per-step key defaults to the bare `stepIndex`
([step-executor.ts:209](../src/runner/step-executor.ts#L209)). Every row
instance shares the same `test` object (same title, same steps —
`expandTestInstances`), so all rows write to the same `.cache/<title>/step-N.json`.
Rows coexist **by design** via `{{param}}` reverse/forward interpolation (one
cached plan serves all rows), not via separate dirs. A file-path key must
preserve that shared-across-rows behaviour — it must **not** fold `dataRowIndex`
into the key, or it would defeat the param read-time sharing.

## Open questions

1. Should the CLI key be the **absolute** path or a **project-root-relative**
   path? Relative shares a cache across checkouts/worktrees of the same repo (may
   be desirable or not — see CLAUDE.md's worktree isolation notes).
2. Is there an existing expectation that the CLI cache is title-addressable (any
   tooling that clears `.cache/<title>/`)? Switching to path keys would change
   directory names.
3. For env namespacing, what's the canonical sentinel for "no env selected" so the
   namespace doesn't oscillate between `<key>` and `<key>/default`? (012 raises the
   same question for the server — answer once, apply to both.)
4. Should CLI and server converge on a single shared key-construction helper so
   they can't drift again (cf. the `sanitizeTestName` duplication in
   [027](027-cache-testname-truncation-collision.md))?

## Tests this would need

- Two test files with identical `# Title` map to **different** cache directories.
- A test cached under `--env dev` is **not** read under `--env staging` (and
  vice-versa) once env namespacing lands.
- A no-env CLI run reads a no-env cache on the next no-env run (stable sentinel).
- Data-driven rows still **share** one cache (param interpolation rides it):
  assert two rows of one data-driven test resolve to the same cache dir and
  `step-N.json` — i.e. the fix didn't accidentally per-row-namespace.

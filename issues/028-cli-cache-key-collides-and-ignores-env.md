# 028 — CLI step cache keys by test *title* (not file path) and ignores env, so same-titled tests collide and envs share entries

**Status:** open / low-medium priority (CLI path only) — **resolution decided (Option A: key by a `basename + hash(project-root-relative path)` directory name, shared across CLI/server/extension; env-sharing handled separately by [012](012-step-cache-not-env-aware.md)), see [Resolution](#resolution-decided-option-a--file-path-derived-cache-dir-name); not yet implemented**
**Area:** [src/runner/test-runner.ts:135](../src/runner/test-runner.ts#L135) (`StepCache.initialize(config.cache.dir, test.title, test.steps)` — `test.title` is the key), [src/parser/types.ts:106](../src/parser/types.ts#L106) (`ParsedTest.filePath` — already in scope at the call site, no threading needed), [src/cache/step-cache.ts:51-79](../src/cache/step-cache.ts#L51) (cache dir from `testName`) + [262-268](../src/cache/step-cache.ts#L262) (`sanitizeTestName`), [src/server/project-root.ts](../src/server/project-root.ts) (`resolveProjectRoot` — to compute the relative path), [src/config/defaults.ts:69-72](../src/config/defaults.ts#L69) (`cache.dir` default `.cache`)
**Related:** [issues/012-step-cache-not-env-aware.md](012-step-cache-not-env-aware.md) (the env-sharing half — env segment wraps this dir name as `.cache/<env>/<dir>/`), [issues/027-cache-testname-truncation-collision.md](027-cache-testname-truncation-collision.md) (**the server-side sibling — this resolution's shared helper closes it too**), [issues/018-step-cache-blind-to-data-file-value-changes.md](018-step-cache-blind-to-data-file-value-changes.md) (notes the CLI resolves data at parse time)
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
`testFilePath` ([session-manager.ts:1592](../src/server/session-manager.ts#L1592))
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

## Fix sketches (considered)

**Option A — key by file path, not title. CHOSEN.** Derive the cache directory
from the test's **file path** instead of `test.title`. To bound length (a long
path would blow the dir name / re-trip [027](027-cache-testname-truncation-collision.md)'s
truncation), use a **readable basename + a hash of the project-root-relative
path**: `login-<hash>`. Eliminates title collisions, distinguishes same-named
files in different dirs, and converges with the server so both stop drifting.
**See [Resolution](#resolution-decided-option-a--file-path-derived-cache-dir-name).**

**Option B — namespace the cache by env. Handled by [012](012-step-cache-not-env-aware.md).**
The env-sharing half (`--env dev` vs `--env staging` reusing entries) is the
exact subject of 012, now resolved there with a `.cache/<env>/<dir>/` env
segment. This issue covers the **title→path key** half; 012's env segment wraps
*around* the dir name Option A produces. The two compose: `.cache/<env>/<dir>/`.

**Option C — both A and B.** Not a separate choice — it's simply Option A here +
012's env segment, applied together. That's the end state.

---

## Resolution (decided): Option A — file-path-derived cache dir name

**Decision:** name the per-test cache directory from the test's **file path**, as
a readable basename plus a 12-char hash of the **normalized, project-root-relative
path**. One shared helper, used by the CLI, the server (replacing its
`sanitizeTestName(testFilePath).slice(0,100)` — closing [027](027-cache-testname-truncation-collision.md)),
and mirrored in the extension. Env namespacing comes from [012](012-step-cache-not-env-aware.md)
as the parent segment.

### Why relative, and why hash the *normalized* path

- **Relative to the project root** (decided): stable regardless of where the repo
  is checked out, and two files can't share a relative path within one project.
  The `.cache` dir already lives under the project root, so the cache is per-project
  anyway — relative just makes the *name* predictable across clones/worktrees.
- **Normalized before hashing** (lowercase + non-alphanumeric → `-`): the server,
  CLI, and extension must compute the **same** hash for the same file. Hashing the
  raw path would diverge on Windows (`C:\…` vs `c:/…`, back- vs forward-slash). The
  existing `sanitizeTestName` already normalizes exactly this way — which is why
  the server and extension agree today — so the hash input reuses that normalization.

### The helper

Export from [src/cache/step-cache.ts](../src/cache/step-cache.ts) (beside
`sanitizeTestName`); **mirror into**
[testbench-native/src/extension/cache-paths.ts](../testbench-native/src/extension/cache-paths.ts)
(it can't import from `src/`), guarded by the cross-module parity test below.

```ts
import { relative, basename, extname } from 'node:path';
import { createHash } from 'node:crypto';

/** lowercase, non-alphanumeric runs → '-', trim leading/trailing '-'. (= sanitizeTestName without the slice) */
function normalizeForCache(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Stable, collision-resistant cache dir name for a test file. `projectRoot` may
 *  be null (no aiui.config.json marker found) — see fallback below. */
export function cacheDirName(testFilePath: string, projectRoot: string | null): string {
  // Identity = the project-root-relative path when a root is known (stable across
  // checkout locations; identical on server/CLI/extension). Fall back to the
  // absolute path when projectRoot is null — still unique and run-to-run stable,
  // just not portable across checkouts (moot without a project marker anyway).
  const identity = projectRoot ? relative(projectRoot, testFilePath) : testFilePath;
  const base = normalizeForCache(basename(testFilePath, extname(testFilePath))).slice(0, 60); // "login"
  const hash = createHash('sha256').update(normalizeForCache(identity)).digest('hex').slice(0, 12); // "tests-auth-login-md" → hash
  return `${base}-${hash}`;
}
```

`sanitizeTestName` is **idempotent** on `cacheDirName`'s output (already
lowercase `[a-z0-9-]`, length ≤ 73 < 100), so `StepCache.initialize` can keep its
signature: pass `cacheDirName(...)` as the `testName` argument and the resulting
directory is exactly `<baseCacheDir>/<cacheDirName>`. No change to `initialize`.

### Worked example — name, title, resulting directory

Two test files with the **same `# Title`** but different paths:

| file path (rel to project root) | `# Title` (old key) | `cacheDirName` (new key) |
|---|---|---|
| `tests/auth/login.md` | `# Login` | `login-3f9a1c0b7e22` |
| `tests/admin/login.md` | `# Login` | `login-b4d8e6512a07` |

Old behaviour: both `sanitizeTestName("Login")` → `login` → **same** `.cache/login/`
(collision, thrash). New: the relative path differs, so the hashes differ → two
distinct dirs. Combined with [012](012-step-cache-not-env-aware.md)'s env segment,
the on-disk layout is:

```
.cache/
  default/                              ← no --env / no frontmatter env:
    login-3f9a1c0b7e22/                 ← tests/auth/login.md   (# Login)
      meta.json
      step-1.json
      step-2.json
    login-b4d8e6512a07/                 ← tests/admin/login.md  (# Login)  ← no longer collides
      meta.json
      step-1.json
  staging/
    login-3f9a1c0b7e22/                 ← same file under --env staging, isolated from `default`
      meta.json
```

(Basename `login` from `login.md`; the hash is over the normalized relative path
`tests-auth-login-md` vs `tests-admin-login-md`. Hash digits here are
illustrative.)

### Call sites

- **CLI** ([test-runner.ts:135](../src/runner/test-runner.ts#L135), inside
  `runTest`) — `test.filePath` is in scope
  ([ParsedTest.filePath](../src/parser/types.ts#L106)), but **no project root is**:
  `runTest` doesn't compute one (the CLI uses `process.cwd()` as its root elsewhere
  — [run.ts:75](../src/cli/commands/run.ts#L75),
  [test-runner.ts:906](../src/runner/test-runner.ts#L906) inside `expandTestInstances`).
  Do **not** reuse `cwd`: it would make the cache name depend on the directory you
  invoke the CLI from. Import `resolveProjectRoot` (from
  [src/server/project-root.ts](../src/server/project-root.ts) — it's a neutral
  path-walk util, fine to use from the runner) so the identity is
  invocation-location-independent and matches the server + extension. **It is
  `async`** ([project-root.ts:21](../src/server/project-root.ts#L21) —
  `Promise<string | null>`, `fs.access`-based), so **`await` it** (the extension's
  mirror at [cache-paths.ts:13](../testbench-native/src/extension/cache-paths.ts#L13)
  is *synchronous* `fs.existsSync` — don't copy the sync form into the runner). Its
  `null` result passes straight through to the helper's null-fallback:
  ```ts
  const dir = cacheDirName(test.filePath, await resolveProjectRoot(test.filePath));
  const stepCache = await StepCache.initialize(path.join(baseDir, dir), test.title, test.steps);
  // baseDir: if 012 has NOT landed yet → just `config.cache.dir`;
  //          once 012 lands → path.join(config.cache.dir, envCacheSegment(effectiveEnv)).
  // 028 can ship independently of 012 — they touch different args (baseDir vs dir).
  ```
  `test.title` is still passed as `testName` but **no longer determines the
  directory** (the directory is the `dir` segment; `testName` is now display-only,
  and is idempotent under `sanitizeTestName` so it's harmless). The physical cache
  base (`config.cache.dir`, cwd-relative) is intentionally separate from the
  marker-root used for the *hash identity* — both resolve independently and that's
  fine.
- **Server** ([session-manager.ts:1592](../src/server/session-manager.ts#L1592)) —
  swap the current `request.testFilePath` `testName` arg for
  `cacheDirName(request.testFilePath, projectRoot)`. `projectRoot` is already in
  scope here (`projectBundle.projectRoot`, used a few lines up to build `cacheDir`)
  and is guaranteed non-null inside this block (the server disables the cache when
  no root is found). This is the [027](027-cache-testname-truncation-collision.md)
  fix — it removes the `sanitizeTestName(...).slice(0,100)` from the test-path
  identity.
- **Extension** ([cache-paths.ts:45](../testbench-native/src/extension/cache-paths.ts#L45)) —
  `cacheDirForTest` swaps its `sanitizeTestName(testFilePath)` for the mirrored
  `cacheDirName(testFilePath, resolveProjectRoot(testFilePath))` (cache-paths.ts
  already mirrors both `resolveProjectRoot` and `sanitizeTestName`). Per CLAUDE.md,
  this edit needs a **patch-version bump** of the testbench-native `package.json`;
  the `src/` edits (root package, not bundled into the extension) don't.

### Migration & scope

- **No migration.** Old `.cache/<title>/` (CLI) and `.cache/<sliced-path>/` (server)
  dirs are orphaned — never read again, harmless. Leave them; a manual `clear`
  removes them.
- **Out of scope here:** env isolation (→ [012](012-step-cache-not-env-aware.md))
  and the data-driven row behaviour below (unchanged).

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

## Resolved decisions

1. **Absolute vs relative path → relative** (to the project root). Stable across
   checkout locations/worktrees; the relative path is also the natural identity of
   "which test in this project". Hashed *after* normalization so server/CLI/
   extension agree on Windows.
2. **Title-addressable tooling → none to preserve.** The on-disk dir names change
   from `<title>` to `<basename>-<hash>`. No user-facing contract relies on the
   old name (clear-cache goes through `cacheDirForTest`, which is updated). Old
   dirs are left orphaned (no migration).
3. **No-env sentinel → `"default"`**, owned by [012](012-step-cache-not-env-aware.md)
   (the env segment that wraps this dir name). Answered once there; applies to both.
4. **Shared helper → yes.** `cacheDirName` lives in `step-cache.ts`, is reused by
   the server (closing [027](027-cache-testname-truncation-collision.md)), and is
   mirrored in `cache-paths.ts`. **Reality check on drift-guarding:** `sanitizeTestName`
   *is* referenced in the root suite — a unit block in
   [tests/step-cache.test.ts:65](../tests/step-cache.test.ts#L65) and the
   server-cache-dir computations in
   [tests/session-manager.test.ts](../tests/session-manager.test.ts) (see the
   *Tests* section) — but there is **no cross-package parity test** between
   `step-cache.ts` and the extension's `cache-paths.ts` copy; that guard is only the
   warning comment at
   [cache-paths.ts:26-31](../testbench-native/src/extension/cache-paths.ts#L26).
   Preserve that comment on the mirrored copy; a true cross-package import test is
   infeasible (root `tests/` use **vitest** against `src/`; testbench-native uses
   **node's built-in runner** against its own build) — so assert a shared fixture of
   `(input → expected dir name)` strings in *each* package's suite instead.

## Tests this would need

- Two test files with identical `# Title` but different paths map to **different**
  cache directories (the headline fix).
- Two files with the **same basename** in different dirs (`auth/login.md` vs
  `admin/login.md`) map to different directories (hash distinguishes them).
- The dir name is **stable across runs** for an unchanged file (deterministic
  hash) — cache actually persists.
- Editing a step still busts via the inner `stepsHash`, independent of the dir name.
- `cacheDirName` is computed over the **project-root-relative, normalized** path,
  so the same file at different absolute locations (e.g. two worktrees) yields the
  **same** dir name — and Windows path-format differences don't change the hash.
- `step-cache.ts` and `cache-paths.ts` produce **identical** `cacheDirName` output
  for the same `(testFilePath, projectRoot)` — asserted via a shared
  input→expected fixture in each package's suite (see decision 4; no single
  cross-package import exists today).
- `cacheDirName` with `projectRoot = null` (no marker) does not throw and yields a
  stable name (the absolute-path fallback).
- Data-driven rows still **share** one cache (param interpolation rides it):
  assert two rows of one data-driven test resolve to the same cache dir and
  `step-N.json` — i.e. the fix didn't accidentally per-row-namespace.
- (Env isolation is covered by [012](012-step-cache-not-env-aware.md)'s tests, not
  duplicated here.)

**Existing tests that must be updated (the server dir name changes):**

- [tests/session-manager.test.ts](../tests/session-manager.test.ts) computes the
  expected server cache dir as `path.join(projectRoot, '.cache', sanitizeTestName(testFilePath))`
  in **6 places** (~lines 1188, 1219, 1252, 1274, 1308, 1362). Each must switch to
  `cacheDirName(testFilePath, projectRoot)` (and, once [012](012-step-cache-not-env-aware.md)
  lands, insert the `<env>` segment) or those assertions break.
- [tests/step-cache.test.ts:65](../tests/step-cache.test.ts#L65) — the existing
  `sanitizeTestName` unit block stays (the helper isn't removed; it still backs the
  env segment and the idempotent `testName`); add a new `cacheDirName` block beside it.

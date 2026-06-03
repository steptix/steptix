# 027 — Step cache: `sanitizeTestName` truncates to 100 chars, so two long test paths can share one cache directory

**Status:** open / low-medium probability, high blast radius when it hits (cross-test poisoning) — **resolution decided: folded into [028](028-cli-cache-key-collides-and-ignores-env.md)'s shared `cacheDirName` helper (basename + hash of the normalized, project-root-relative path); see [Resolution](#resolution-decided-shared-cachedirname-helper-from-028). Not yet implemented.**
**Area:** [src/cache/step-cache.ts:262-268](../src/cache/step-cache.ts#L262) (`sanitizeTestName` — `.slice(0, 100)`), [src/cache/step-cache.ts:57](../src/cache/step-cache.ts#L57) (cache dir = `baseCacheDir/sanitizeTestName(testName)`), [src/server/session-manager.ts:1558](../src/server/session-manager.ts#L1558) (server passes the **absolute** `testFilePath` as `testName`), [testbench-native/src/extension/cache-paths.ts:32-49](../testbench-native/src/extension/cache-paths.ts#L32) (extension mirrors the same function — must stay in lockstep)
**Related:** [issues/028-cli-cache-key-collides-and-ignores-env.md](028-cli-cache-key-collides-and-ignores-env.md) (CLI keys by title — the same collision class, different key), [issues/012-step-cache-not-env-aware.md](012-step-cache-not-env-aware.md)
**Opened:** 2026-06-03

## Summary

Each test's cache lives in a directory named by `sanitizeTestName(testName)`. On
the server path, `testName` is the test's **absolute file path**
([session-manager.ts:1558](../src/server/session-manager.ts#L1558)).
`sanitizeTestName` lowercases, replaces every non-alphanumeric run with `-`,
**and truncates to the first 100 characters**
([step-cache.ts:267](../src/cache/step-cache.ts#L267)). Two distinct test files
whose sanitized absolute paths agree in their first 100 characters therefore map
to the **same** cache directory and silently share — and poison — each other's
cached entries.

## Mechanism

```ts
export function sanitizeTestName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);   // ← the collision source
}
```

The bundle hash in `meta.json` is per-directory, so when two tests share a
directory, whichever runs second sees the first's `meta.stepsHash`, decides the
bundle is "stale" (different steps), and **wipes the directory**
([step-cache.ts:65-68](../src/cache/step-cache.ts#L65)) — destroying the first
test's cache on every alternation. In the rarer case where their step hashes also
coincide, they'd read each other's per-step files outright.

Absolute paths make the first 100 chars **mostly shared boilerplate**: a deep
project root (`c:\Projects\vibe\ai-ui-automation\fixtures\tests\…`) plus a
category subdir can eat well past 100 chars before reaching the part of the path
that distinguishes two tests — exactly the regime where truncation collides.

## Worked example

Two real-looking test files under a deep tree (sanitized, lowercased, `-`-joined):

```
c-projects-vibe-ai-ui-automation-fixtures-tests-regression-checkout-flows-guest-checkout-with-promo.md
c-projects-vibe-ai-ui-automation-fixtures-tests-regression-checkout-flows-guest-checkout-with-gift.md
```

These sanitized names are **99 and 98 chars** — both *under* the 100-char cap, so
neither is truncated and they diverge at char 95 (`p` vs `g`):

```
c-projects-vibe-ai-ui-automation-fixtures-tests-regression-checkout-flows-guest-checkout-with-promo
c-projects-vibe-ai-ui-automation-fixtures-tests-regression-checkout-flows-guest-checkout-with-gift
```

So *this exact pair* is a **near-miss, not yet a collision** — shown to make the
mechanism concrete. Push the project one directory deeper, or name the leaf files
`…-guest-checkout-scenario-a.md` / `…-scenario-b.md` so the distinguishing part
falls **past char 100**, and `.slice(0, 100)` truncates both to an identical
prefix → the **same** `.cache/<first-100>` directory. Running test A then B then
A wipes the cache each switch; both pay full AI cost every run, and if hashes
ever align they replay each other's plans.

## Impact

- **Silent.** No error — the cache simply never sticks for the colliding tests
  (constant misses), or worse, cross-replays. Looks like "caching doesn't work
  for these tests".
- **Deterministic per project layout** — once two files collide they collide
  every run, so a user with a deep tree gets persistent thrash.
- **Drift hazard:** the testbench-native extension **re-implements** the same
  function ([cache-paths.ts:32](../testbench-native/src/extension/cache-paths.ts#L32))
  for its "clear cache for this test" command. Any fix must change **both** or
  the extension will compute a different directory than the server wrote (the
  file's own comment warns: "Any drift … silently breaks 'clear cache for this
  test'").

## Fix sketches

**Option A — suffix with a hash of the full name (recommended).** Keep a readable
truncated prefix for humans, but guarantee uniqueness:

```ts
const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const short = slug.slice(0, 80);
const hash = sha256(name).slice(0, 12);   // full, un-truncated name
return `${short}-${hash}`;
```

Collisions now require a full-string hash collision, not a 100-char prefix
match. Directory names stay bounded (~93 chars). Must be applied **identically**
in `cache-paths.ts`.

**Option B — hash only (no readable prefix).** `sha256(name)` → fixed-length dir.
Simplest, collision-proof, but cache dirs become opaque (harder to eyeball /
manually clear). 

**Option C — raise/remove the 100-char cap.** Why is the cap there? If it's a
Windows path-length (`MAX_PATH` ≈ 260) guard, removing it risks long-path errors
on the per-step files inside. A larger cap only widens the window rather than
closing it — not recommended on its own.

**Recommended:** Option A — preserves debuggability and closes the hole. Confirm
the original reason for the 100-char cap first (Q1) so the prefix length is set
safely under the path-length budget.

---

## Resolution (decided): shared `cacheDirName` helper from [028](028-cli-cache-key-collides-and-ignores-env.md)

This issue's Option A (truncated readable prefix + hash suffix) is **adopted**,
but the implementation is **centralized in [028](028-cli-cache-key-collides-and-ignores-env.md)**
rather than landed as a separate `sanitizeTestName` patch — the two issues are the
same collision class (027 = server path truncated to 100 chars; 028 = CLI keys by
title), and a single shared helper fixes both and stops the server/CLI/extension
copies from drifting.

The agreed helper (full definition + worked example in
[028 §Resolution](028-cli-cache-key-collides-and-ignores-env.md#resolution-decided-option-a--file-path-derived-cache-dir-name)):

```ts
cacheDirName(testFilePath, projectRoot) = `${basename}-${sha256(normalizedRelativePath).slice(0,12)}`
```

Two refinements over this issue's original sketch:

- **Hash the project-root-relative path, not the raw/absolute name.** Stable across
  checkout locations, and (normalized first) identical across the server / CLI /
  extension on Windows — the cross-module parity this issue flagged.
- **Prefix is the file *basename*, not a 80-char slice of the whole path.** Shorter
  and more readable (`login-<hash>` vs `c-projects-…-login-<hash>`), and the
  100-char truncation that caused this bug is **removed from the dir-name path**
  entirely (it survives only inside `envCacheSegment`/`sanitizeTestName` for short
  env names, where truncation can't bite).

**For this issue, that means:** the server swaps
`sanitizeTestName(request.testFilePath)` → `cacheDirName(request.testFilePath, projectRoot)`
at [session-manager.ts:1592](../src/server/session-manager.ts#L1592) (note: the
`:1558` reference in the Area header is now `:1592` after intervening edits), and
the extension's `cache-paths.ts` mirrors `cacheDirName`. The `.slice(0, 100)`
collision is closed because the test path no longer flows through it.

Open question Q1 below (why 100?) is **answered** — see Resolved note inline; it
no longer gates the fix because truncation leaves the dir-name path.

## Open questions

1. **Why 100?** The `.slice(0, 100)` was introduced whole in the original cache
   commit (`87a1feb`, "add step-level AI response cache") with **no comment and no
   `MAX_PATH`/260 reference** anywhere near it, and `git log -S 'slice(0, 100)'`
   shows it's never been touched since — so the evidence points to an **arbitrary
   tidiness choice**, not a documented path-length guard. Confirm before sizing
   the replacement: the real path budget is `<projectRoot>/.cache/<dirname>/` plus
   the longest leaf, which is `step-<key>-asserts.json` (~30 chars), so a hash
   suffix scheme (Option A) must keep the prefix well under any MAX_PATH ceiling.
2. Should the hash be over the **raw** `testName` (absolute path) or a
   project-root-relative path, so the same test in two checkouts/worktrees shares
   a cache vs. stays separate? (Ties into worktree behaviour from CLAUDE.md.)
3. Does the CLI path (keyed by `test.title`, [028](028-cli-cache-key-collides-and-ignores-env.md))
   want the same hashing helper, or is its collision better fixed by switching to
   file-path keys?
4. Are there already cache dirs on disk in the wild that a key-format change would
   orphan? (Cosmetic — stale dirs are harmless, but worth a note / cleanup.)

## Tests this would need

- Two `testName`s sharing a >100-char common prefix map to **different**
  directories.
- `sanitizeTestName` in `step-cache.ts` and `cache-paths.ts` produce
  **byte-identical** output for the same input (a cross-module parity test, so
  the two implementations can't drift).
- A normal short name still produces a readable, stable directory (no regression
  in the common case).

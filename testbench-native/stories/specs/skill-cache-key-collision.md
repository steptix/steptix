# Frame-scoped step-cache keys (skill collision fix)

Fixes [issue 016](../../../issues/resolved/016-skill-cache-key-collisions.md). Amends
the per-step cache identity in [step-cache-server.md](step-cache-server.md) §2,
which assumed every step's source line came from the test file.

## 1. Background

The server keys each step's cache file by its source line within its own file
([session-manager.ts:1544](../../../src/server/session-manager.ts#L1544)):

```ts
const stepCacheId = effectiveSourceLines?.[i] ?? i + 1;   // → step-<id>.json
```

`effectiveSourceLines[i]` is the step's line *in the file it came from*
([session-manager.ts:1019-1022](../../../src/server/session-manager.ts#L1019-L1022)):
test-file line for inline steps, skill-file line for skill-body steps. One flat
`.cache/<test>/` directory holds them all. Line numbers are unique within a
file but **not across files**, so two distinct logical steps that share a line
number collide on one `step-<n>.json`.

The guaranteed case: the **same skill invoked on two steps**. `skill.stepLines`
is fixed per skill file, so every invocation emits the same skill-file lines.
Both invocations key to the same files; the second cache-hits the first's
entry. With different args this is wrong on the *first* run, because the skill
arg is interpolated into the step text at expansion
([expander.ts:458](../../../src/skills/expander.ts#L458)) and never templatized
back out on cache write.

## 2. Goal

Make the per-step cache key **unique per logical step within a run** and
**stable across runs** of an unchanged test+skills set, so:

- repeated/cross-file steps never share a cache file (no wrong replay);
- a re-run of an unchanged test still cache-hits every step (the whole point
  of the cache).

## 3. Non-goals

- **Bug 2** (skill-body edits not invalidating the bundle hash). Orthogonal —
  key *uniqueness* vs invalidation *trigger*. Design-noted in §8; deferred
  because the fix is entangled with the batched-resume hash-stability contract
  ([step-cache-server.md](step-cache-server.md) §4).
- Env-aware keys ([issue 012](../../../issues/012-step-cache-not-env-aware.md)).
- The CLI runner path. It keys by post-expansion ordinal (`i + 1`), which is
  unique per run and does not collide; left unchanged.

## 4. Design

### 4.1 Two identities, deliberately separate

The current code conflates two things into one number:

| Concern | Wants | Correct value |
|---|---|---|
| **Display / status** (`StepResult.index`, `step:start`/`step:pass` line, log label) | the line to paint in *whichever editor shows this step* | source line in the step's own file — **may repeat** across invocations (both paint the same skill-file line; that's correct) |
| **Cache file name** | a key unique per logical step in the run, stable across runs | source line **+ the invocation's frame** |

These were the same value only because the original design assumed one file.
The fix keeps the display identity exactly as today and gives the cache a
distinct, frame-qualified key.

### 4.2 The key

The expander already mints a unique frame per `[skill: …]` invocation
(`f${++ctx.seq}`, [expander.ts:249](../../../src/skills/expander.ts#L249) /
[:256](../../../src/skills/expander.ts#L256)) and exposes it as
`origins[i].frameId`. Top-level inline steps carry frame `''`.

```ts
const stepSourceLine = effectiveSourceLines?.[i] ?? i + 1;   // display identity (unchanged)
const frameId = expansionOrigins?.[i]?.frameId;              // '' for inline, 'fN' for skill body
const stepCacheKey = frameId ? `${frameId}-${stepSourceLine}` : stepSourceLine;
```

- inline test step on line 12 → `12` → `step-12.json` (unchanged)
- skill body, frame f1, line 17 → `f1-17` → `step-f1-17.json`
- same skill again, frame f2, line 17 → `f2-17` → `step-f2-17.json`

**Unique per run** because frames are unique per invocation and each body line
appears once per frame. **Stable across runs** because expansion of an
unchanged test+skills set visits invocations in the same order, minting the
same frame ids.

### 4.3 Why frame ids are safe across edits

A frame id only shifts when the expansion order changes — i.e. a `[skill: …]`
call is added/removed/reordered. Any such edit also edits the test's step text,
so the bundle hash (over `fullSteps`) changes and the whole cache is cleared.
So a frame-id shift never produces a *stale wrong hit*; at worst a clean miss.
(The one exception — editing a *skill file* so a frame id remaps to a different
skill without changing the test text — is a Bug 2 artifact and closes when Bug
2 is fixed. Until then it degrades to a miss except in the deep case Bug 2
already causes.)

### 4.4 Plumbing (decouple key from index)

`executeStep`'s first arg `stepIndex` stays the display line and continues to
drive logs and `StepResult.index`. A new optional `cacheKey` on
`StepExecutorOptions` carries the frame-qualified key; every cache file
operation uses `opts.cacheKey ?? stepIndex` so callers that don't set it (the
CLI runner) keep today's behaviour exactly.

Cache call sites to route through the key
([step-executor.ts](../../../src/runner/step-executor.ts)):

- step plan: `read` (199), `invalidateStep` (223), `write` (266)
- assertion code: `readAssertion` (1508), `writeAssertion` (1588),
  `invalidateAssertion` (1608) — via `EvaluateAssertionParams.cacheKey`, passed
  at the `evaluateAssertion(...)` call (690)

`StepCache` method/`stepPath`/`assertsPath` signatures widen `stepIndex:
number` → `string | number`; the `step-${id}.json` template handles both.

### 4.5 Discard pre-fix caches

Pre-fix skill-body entries were line-keyed and may be poisoned (a test step on
line 17 could read a skill entry left at `step-17.json`). Bump
`SCHEMA_VERSION` (3 → 4) in [step-cache.ts](../../../src/cache/step-cache.ts);
`StepCache.initialize` already wipes the directory on a schema mismatch.

## 5. Edge cases

| Scenario | Key behaviour |
|---|---|
| Same skill on 2 steps, **different args** | `f1-17` vs `f2-17` — independent; each caches/replays its own actions |
| Same skill on 2 steps, same args | distinct keys, duplicate content (2× disk) — correct, mildly redundant |
| Test step & skill step on the same line number | `12` vs `f1-12` — independent |
| Two different skills, body lines overlap | distinct frames → distinct keys |
| Nested skills (A calls B, B twice) | every invocation a distinct frame → all distinct |
| Re-run, unchanged test+skills | same frame ids → same keys → cache hits |
| No-skills test | `expansionOrigins` null → bare line → unchanged from today |
| CLI runner | no `cacheKey` passed → falls back to ordinal `stepIndex` → unchanged |

## 6. Tests

Vitest, alongside the existing step-cache tests:

- **same skill, two steps, different args** — second invocation is NOT served
  the first's cached plan (assert distinct cache files written; assert the AI
  is invoked for the second on a first run, and each replays its own args on
  re-run).
- **test line == skill line** — both get independent entries.
- **stability** — re-run of an unchanged skill-invoking test hits cache on
  every skill-body step (zero AI calls on run 2).
- **no-skills regression** — keys are bare source lines, identical to today.
- **schema bump** — a v3 cache directory is wiped on first v4 init.

The key-construction itself (`frameId ? `${frameId}-${line}` : line`) is pure
and gets a direct unit test for the inline/skill/empty-frame branches.

## 7. Implementation checklist

- [ ] [step-cache.ts](../../../src/cache/step-cache.ts): widen `stepIndex` to
  `string | number` on `read`/`write`/`invalidateStep`/`readAssertion`/
  `writeAssertion`/`invalidateAssertion`/`stepPath`/`assertsPath`; bump
  `SCHEMA_VERSION` to 4.
- [ ] [step-executor.ts](../../../src/runner/step-executor.ts): add
  `cacheKey?: string | number` to `StepExecutorOptions`; use `opts.cacheKey ??
  stepIndex` at the three step-cache sites; add `cacheKey` to
  `EvaluateAssertionParams`, pass it at the `evaluateAssertion` call, and use
  `p.cacheKey ?? p.stepIndex` at the three assertion sites.
- [ ] [session-manager.ts](../../../src/server/session-manager.ts): compute
  `stepCacheKey` from `expansionOrigins[i].frameId` + source line; pass it as
  `cacheKey` in the `executeStep` opts. Keep `stepIndex`/display identity as the
  source line.
- [ ] Tests per §6.
- [ ] Rebuild `dist/` (server picks up the change on restart). No extension
  version bump — this is server-side `src/`, not bundled into the VSIX.

## 8. Bug 2 — deferred design notes

The bundle hash must change when a skill body changes. The constraint is the
batched-resume contract: a paused-and-resumed run sends a trimmed `steps` batch
but the same `fullSteps`, and both batches must hash identically or the cache
never hits across the pause ([step-cache-server.md](step-cache-server.md) §4).

Candidate fixes, to spec separately:

1. **Hash `effectiveSteps` (post-expansion).** Naturally includes skill bodies,
   so edits invalidate. Must reconstruct the *full* post-expansion list for the
   hash even on a trimmed batch (today the client's `fullSteps` is the
   pre-expansion full list; the server would need to expand the full list, not
   just the batch, to hash it).
2. **Fold skill-file content/mtime into the bundle hash.** Keeps `fullSteps` as
   the step-identity source but mixes in a digest of every skill file the
   expansion touched. Cheaper to reason about against the batch contract.

Either way: invalidation stays whole-bundle (consistent with today), and the
frame-scoped keys from this pass remain correct.

## 9. Open questions

- Should repeated same-args invocations *share* one cache entry instead of
  duplicating? Deduping would need a content-addressed key and loses the
  per-frame replay-isolation that makes different-args correct. Deferred —
  duplication is cheap and correct.
- Is `fN-<line>` the right human-readable form, or should the skill name appear
  (`duckduckgo_search@2-17`)? Frame id is stable and unique; skill name is
  friendlier for eyeballing the `.cache` dir. Deferred to Bug 2 work, which
  touches the same code.

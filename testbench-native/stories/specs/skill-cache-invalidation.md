# Skill-aware cache invalidation (Bug 2)

Fixes **Bug 2** of [issue 016](../../../issues/resolved/016-skill-cache-key-collisions.md):
editing a skill body does not invalidate the cache of tests that use it.
Companion to [skill-cache-key-collision.md](skill-cache-key-collision.md)
(Bug 1, the per-step key collision — already shipped). This spec is Bug 2 only.

## 1. Background

`StepCache` clears a test's whole cache when its `stepsHash` changes
([step-cache.ts:52-68](../../../src/cache/step-cache.ts#L52-L68),
[step-cache.ts:228](../../../src/cache/step-cache.ts#L228)). The server feeds
that hash from:

```ts
const cacheHashSource = request.fullSteps ?? effectiveSteps;   // session-manager.ts:1069
```

The client builds `fullSteps` from the **test document only** —
`extractSteps(this.document.getText())`
([run-controller.ts:969](../../../testbench-native/src/extension/run-controller.ts#L969))
— so it is the *pre-expansion* step list: it contains the literal
`[skill: …]` line, never the expanded skill body. Editing what a skill *does*
leaves `fullSteps` unchanged → `stepsHash` unchanged → the skill's cached
per-step entries replay stale actions. That is the "I changed the skill but
it's still caching" symptom.

The server already re-parses skills from disk every run (`clearSkillCache()`
at [session-manager.ts:524](../../../src/server/session-manager.ts#L524)), so
*execution* sees the edited skill. The bug is solely that the edit never
reaches the *hash*.

## 2. Decision (confirmed)

- **Detect skill changes by hashing the expanded document.** The server
  expands the full document and hashes the post-expansion step list; a changed
  skill body produces different expanded text and therefore a different hash.
  (Chosen over folding skill-file content digests into the hash — equivalent
  correctness, but hashing the expansion reuses the existing expander and is
  unambiguously batch-stable.)
- **Whole-bundle invalidation.** A skill change clears the entire dependent
  test's cache, matching today's `StepCache.initialize` semantics. (Chosen
  over per-skill partial invalidation, which adds a new mechanism and more
  page-state-drift risk for a dev-loop optimisation we don't yet need.)

## 3. Goal / Non-goals

**Goal:** a skill-body edit invalidates every test that (transitively) uses
that skill on its next run, with no manual cache clearing — while preserving
cross-batch hash stability for paused/resumed runs.

**Non-goals:** per-skill partial invalidation; env-aware keys
([issue 012](../../../issues/012-step-cache-not-env-aware.md)); the per-step
key scheme (Bug 1, done); token/prompt-cache concerns.

## 4. Design

### 4.1 Hash the expanded full document

Replace the hash source with the **expanded** full document. Expansion bakes
the skill body — and the interpolated `[skill: …]` args (`applySkillScope` →
`interpolate(s, call.args)`,
[expander.ts:458](../../../src/skills/expander.ts#L458)) — into the step
strings, so any skill-body edit (or arg change) changes the hash. Test-only
edits already changed it (they change `fullSteps`); now skill edits do too.

### 4.2 Batch stability — `steps` vs `fullSteps`

The hash must be identical whether a request submits the whole document or a
*subset* batch, or the cache never hits across the boundary
([step-cache-server.md](step-cache-server.md) §4). Two things produce a subset
batch: a breakpoint pause/resume (steps N..end), **and** an `[input:]` /
`[interactive]` line, which splits the document into multiple step blocks — each
block is its own request with `steps ⊊ fullSteps`, so even a nominal "run the
whole file" can arrive here as several subset requests
([run-controller.ts:778-782](../../../testbench-native/src/extension/run-controller.ts#L778-L782)).

The execution-path expansion at
[session-manager.ts:964-1043](../../../src/server/session-manager.ts#L964-L1043)
expands `request.steps` (the *batch*) into `effectiveSteps` — the right hash
source only when the batch IS the whole document (`steps == fullSteps`). The
**load-bearing invariant:** any request whose `steps ≠ fullSteps` must hash the
expansion of `fullSteps` (not `effectiveSteps`), so the `seq`-based namespacing
(§4.3) is numbered over the identical full array on every batch of one document.
Select per request:

```ts
let cacheHashSource: string[];
if (!request.fullSteps) {
  cacheHashSource = effectiveSteps;                 // legacy caller: unchanged
} else if (!arraysEqual(request.steps, request.fullSteps)) {
  // batch ⊊ fullSteps (resume batch, or a block split by [input:]/[interactive])
  // — effectiveSteps covers only this batch, so expand the FULL doc.
  if (request.skillsDir) {
    try {
      cacheHashSource = (await expandSkills(
        request.fullSteps, request.skillsDir, envDataCtx ?? undefined,
        request.testFilePath, request.sourceLines,
      )).steps;                                      // expand the FULL doc
    } catch (err) {
      logger.warn(`cache hash: full-document expansion failed (${msg}); ` +
        `falling back to raw fullSteps`);
      cacheHashSource = request.fullSteps;           // graceful fallback (§4.4)
    }
  } else {
    cacheHashSource = request.fullSteps;             // no skills: raw full doc
  }
} else {
  // batch == fullSteps: effectiveSteps already IS the expanded full document
  // (or the raw steps when no skillsDir). Reuse it — no second expansion.
  cacheHashSource = effectiveSteps;
}
```

Behaviour by case (✚ = the Bug 2 fix taking effect; = = unchanged):

| Batch vs `fullSteps` | skillsDir | Old hash source | New hash source |
|---|---|---|---|
| equal | yes | `fullSteps` (pre-expansion) | `effectiveSteps` (expanded) ✚ |
| equal | no | `fullSteps` | `effectiveSteps` (== `fullSteps`) = |
| subset | yes | `fullSteps` (pre-expansion) | `expandSkills(fullSteps)` ✚ |
| subset | no | `fullSteps` | `fullSteps` = |
| legacy (no `fullSteps`) | — | `effectiveSteps` | `effectiveSteps` = |

The full-run and trimmed-run hashes for the *same* document agree, because
both hash the expansion of the identical `fullSteps` array (see §4.3).

### 4.3 Deterministic expansion → stable hash

The expanded step strings contain instance-namespaced internal variable names
(`__skill${instanceId}_…`,
[expander.ts:434](../../../src/skills/expander.ts#L434)), where `instanceId`
comes from a per-`expandSkills`-call counter seeded at `seq: 0`
([expander.ts:137](../../../src/skills/expander.ts#L137)). Because every hash
expansion starts from `seq: 0` over the *same full document*, the namespacing
is identical across a full run and any resume batch of that document → identical
expanded text → identical hash. Frame ids (`fN`) live in `origins`/`frames`,
**not** in `.steps`, so they never enter the hash. Expansion is otherwise pure
given (steps, skill files, envCtx), so re-running an unchanged test reproduces
the hash and the cache still hits.

Two consistency requirements make the full-run and subset-batch hashes agree:
(1) both must expand the identical `fullSteps` array — guaranteed by §4.2's
invariant (the `equal` branch reuses `effectiveSteps`, which is the expansion of
`steps == fullSteps`); and (2) both must hash the **pre-`interpolateEnvData`**
expansion. `effectiveSteps` is the `expandSkills` output *before* the separate
env-data pass (the `interpolatedSteps` built for `identifyStepGroups` is never
hashed), so the hash-time `expandSkills(fullSteps)` must likewise be hashed
pre-interpolation. Do **not** "simplify" by hashing the env-interpolated steps
on either path, or the two branches diverge across envs.

### 4.4 Expansion-failure fallback

A trimmed batch can be valid even if a skill referenced *only in the
out-of-batch portion* is currently broken (mid-edit). Expanding the full
document would throw there, even though the batch itself expanded fine for
execution. So wrap the hash expansion in **its own** try/catch (separate from
the execution-path expansion's catch at L1023-1042, which runs earlier and
aborts the whole run) and fall back to hashing the raw `fullSteps` (pre-fix
behaviour) with a warning — the run still executes and caches; Bug 2 simply
isn't fixed for that one request. (Alternative: disable
cache for the request. Rejected — costs a full AI re-run for a transient
edit-in-progress; the broken skill surfaces anyway when the user resumes into
it, via the existing abort at
[session-manager.ts:1023-1042](../../../src/server/session-manager.ts#L1023-L1042).)

### 4.5 No schema bump; one-time self-invalidation

This changes *what* is hashed, not the cache file format, so `SCHEMA_VERSION`
stays at 4. On the first run after deploy, each test's stored `stepsHash`
(computed the old way) won't match the new expanded hash → `StepCache.initialize`
wipes the directory once → it repopulates. That one-time re-run is correct and
desirable (old caches may be stale skill replays). No migration code.

### 4.6 Interaction with Bug 1

Orthogonal: Bug 1 changed the per-step *key* (filename); Bug 2 changes the
bundle *hash* (the whole-cache invalidation trigger). After a skill-body edit
the bundle hash flips, the whole dir wipes, and the frame-scoped keys from Bug
1 repopulate — consistent with whole-bundle invalidation.

### 4.7 Cost

The extra full-document expansion happens **only when the batch is a strict
subset** of the document (resume batches, and blocks split by
`[input:]`/`[interactive]`) and skills are in play; batches equal to `fullSteps`
reuse `effectiveSteps` (zero extra work). Skills are
parse-cached within the request (the execution expansion already parsed them),
so the second expansion is parse + string interpolation over the step list —
negligible against the AI calls the cache saves.

## 5. Edge cases

| Scenario | Behaviour |
|---|---|
| Edit a skill body, re-run | Expanded text differs → hash differs → whole test cache cleared → skill steps re-asked ✓ |
| Edit a nested skill (A calls B, edit B) | B's body is expanded into A's expansion → hash differs ✓ |
| Change a `[skill: query="x"]` arg | Already changed `fullSteps`; expanded text also differs → hash differs ✓ |
| Change runtime param **value** only (`{{x}}` resolved at run) | Expanded text keeps the `{{x}}` placeholder (args ≠ runtime params) → hash stable → cache still hits (consistent with placeholder-based cache) ✓ |
| Pause at breakpoint, resume | Full-run and resume-batch hashes agree (§4.2/§4.3) → cache hits across the pause ✓ |
| No-skills test | `effectiveSteps`/`fullSteps` carry no expansion → hash identical to today = |
| Out-of-batch skill broken mid-edit | Hash expansion throws → fall back to raw `fullSteps` hash + warn; run/cache proceed (§4.4) |
| Skill file edited but server long-lived | `clearSkillCache()` at run-start re-parses from disk → expansion sees the edit → hash reflects it ✓ |
| **Cosmetic** skill edit (comments, blank lines, trailing text after `[skill: …]`, list-item whitespace) | Parser strips these before producing step text → expanded text unchanged → hash unchanged → cache **correctly** still hits (nothing behavioural to invalidate) ✓ |

## 6. Tests

The Bug 1 review flagged that hand-written-key tests can pass even if the
*plumbing* regresses. Bug 2 must therefore test end-to-end that an edit moves
the hash, not just that `computeStepsHash` differs on different arrays.

- **Skill-body edit invalidates** (integration,
  [tests/session-manager.test.ts](../../../tests/session-manager.test.ts) +
  temp skill files): this suite **mocks `executeStep`** (`vi.mock`, ~L50), so
  the observable is NOT "AI-served vs cached" — the mock sits above the cache.
  `StepCache.initialize` runs in the *manager*
  ([session-manager.ts:1071](../../../src/server/session-manager.ts#L1071)), so
  assert on the bundle hash on disk: run a skill-using test with `cacheEnabled`
  + a project root, read `.cache/<test>/meta.json` `stepsHash` (H1); edit the
  skill file on disk; re-run; assert the new `stepsHash` (H2) ≠ H1 (proving the
  edit reached the hash) and that the step files were wiped. Optionally have the
  `executeStep` mock write a sentinel cache file and assert it's gone after the
  edited re-run. Do **not** assert on AI-call counts — they're mocked out.
- **Batch stability** (unit/integration): the hash for a full run equals the
  hash for a trimmed resume batch of the same document+skills (so cache hits
  across a pause). Assert equal `stepsHash`.
- **No-skills regression** (unit): a skill-free test's hash is byte-identical
  to the pre-fix hash (over `fullSteps`).
- **Expansion-failure fallback** (unit): when the full-doc expansion throws,
  the resolver returns raw `fullSteps` and does not propagate.
- **Hash-source selection** (pure unit): extract the §4.2 branch into a small
  pure helper (`chooseCacheHashSource(steps, fullSteps, effectiveSteps,
  hasSkills) → { kind: 'effective' | 'expand-full' | 'raw-full' }`) so the
  decision is unit-tested without the real expander; the integration test
  covers the expansion itself.

## 7. Implementation checklist

- [ ] [session-manager.ts](../../../src/server/session-manager.ts): replace the
  `cacheHashSource` assignment (~L1069) with the §4.2 selection. Add
  `arraysEqual` (no existing util — grep confirms). Extract the *decision* into a
  pure `chooseCacheHashSource(...) → { kind: 'effective' | 'expand-full' |
  'raw-full' }` helper for testability; the caller performs the `expand-full`
  expansion, passing the same `envDataCtx`, `request.testFilePath`, and
  `request.sourceLines` as the execution-path call (L966-976) — the easily-missed
  5th arg `sourceLines` included.
- [ ] Tests per §6 (the skill-edit integration test is the load-bearing one).
- [ ] Update [step-cache-server.md](step-cache-server.md) §2 (drop the Bug 2 ⚠️
  from the bundle-hash row) and §8 (skill-expansion row) once this lands.
- [ ] Close Bug 2 in [issue 016](../../../issues/resolved/016-skill-cache-key-collisions.md).
- [ ] Rebuild `dist/`; the server picks it up on restart. No extension version
  bump (server-side `src/`, not bundled into the VSIX).

## 8. Open questions

- **Fallback vs disable on expansion failure (§4.4):** spec'd as fall-back-to-
  raw-hash. Confirm that's preferred over disabling cache for the request.
- **`arraysEqual` granularity:** length check short-circuits *subset* batches
  (always shorter), but the `equal` case (testbench always sends `fullSteps`,
  equal to `steps` on a single-block full run) requires a full content compare
  on every request. Cheap for typical step counts and negligible vs an AI call,
  but note it's on the hot path.
- Should this pass *also* fold `envName` into the namespace
  ([issue 012](../../../issues/012-step-cache-not-env-aware.md))? Kept separate
  — different failure mode, different fix — but the two could land together if
  desired.

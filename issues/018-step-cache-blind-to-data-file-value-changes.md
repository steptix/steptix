# 018 — Step cache is blind to data-file value changes; edits replay stale actions

**Status:** ✅ resolved 2026-05-23 — fix shipped + regression-tested at both layers
**Area:** [src/server/session-manager.ts:1355-1377](../src/server/session-manager.ts#L1355) (hash source now env/data-interpolated — the fix), [src/server/session-manager.ts:1976](../src/server/session-manager.ts#L1976) (positional per-step key), [src/cache/step-cache.ts:81-104](../src/cache/step-cache.ts#L81) (read re-applies only parameters)
**Related:** [issues/012-step-cache-not-env-aware.md](012-step-cache-not-env-aware.md) — same family (cache not env/data-aware); this is the within-one-env, value-changed manifestation. [issues/011-env-bundle-cached-for-session-lifetime.md](011-env-bundle-cached-for-session-lifetime.md) — the non-cache data path (already mtime-invalidated).
**Repro / regression tests:** [tests/session-manager.test.ts](../tests/session-manager.test.ts) — `"issue 018"` (end-to-end: data edit → hash flips → cache wiped; unreferenced key → cache survives); [tests/step-cache.test.ts](../tests/step-cache.test.ts) — `describe('cache invalidation tracks the resolved hash source (issue 018)')` (the StepCache contract the fix relies on)
**Opened:** 2026-05-23

## Resolution (2026-05-23)

Shipped the "hash the env/data-interpolated steps" fix
([session-manager.ts:1355-1377](../src/server/session-manager.ts#L1355)). After
`cacheHashSource` is chosen (raw-full / expand-full / effective branch), each
line is run through `interpolateEnvData(s, envDataCtx)` before
`StepCache.initialize`. So the steps-hash now reflects the **resolved** data
values: a data-file edit changes the hash exactly like a step-text edit, and
`initialize()` wipes the stale bundle. `{{params}}` are left intact
(`interpolateEnvData` ignores them), so the read-time param path still lets one
cached plan serve many param values — **params ride the cache, data busts it.**
A bad ref is caught and falls back to the raw line (the run fails later at the
real interpolation site with the precise file/line error).

**Server path only.** The CLI runner has no equivalent bug and needs no fix: its
parser interpolates `${data.*}` at parse time
([markdown.ts:179](../src/parser/markdown.ts#L179)), so the steps reaching
`StepCache.initialize` on the CLI path are already resolved. The server defers
interpolation to execution time (per-step, [session-manager.ts:1657](../src/server/session-manager.ts#L1657)),
which is precisely why it fed raw placeholders to the hash — the asymmetry that
created this bug and bounds the fix.

**No `SCHEMA_VERSION` bump.** It isn't needed and would over-clear: the hash now
differs from the pre-fix raw hash for exactly the tests that referenced data (or
`${env.*}`) in their steps, so their poisoned entries self-clear on the first
post-fix run, while no-env / no-data tests keep their still-valid caches.

Regression-tested end-to-end at the session-manager layer (real temp project +
data file + sentinel cache file) **and** at the StepCache seam. Full suite green
(954 tests); the headline guard fails pre-fix (both runs hash
`Search for ${data.query}` identically) and passes post-fix.

## Symptom (user report)

> Stop a test, edit a data `.json` file, save it, run the test again — it
> doesn't pick up the changes from the data file.

Confirmed as a real bug **when step caching is enabled** (opt-in; off by
default — `## Config: cache: on` or `cache.enabled: true` in
`aiui.config.json`). With caching off there is no staleness: named
`dataSources` load fresh every request
([session-manager.ts:1141](../src/server/session-manager.ts#L1141)) and the
default `data/<env>.json` is mtime-invalidated
([session-manager.ts:618](../src/server/session-manager.ts#L618)).

## Mechanism

The step cache keys on things that **do not change** when you edit a data
file's *values*. Three layers, all data-blind:

1. **Invalidation lever is step *text*, not data.** `StepCache.initialize`
   clears the cache only when the steps-hash changes
   ([step-cache.ts:65](../src/cache/step-cache.ts#L65)). The hash source is
   the **raw** step text with `${data.url}` / `${search-engine.query}`
   placeholders *intact* — env/data interpolation runs *after* the hash is
   built ([session-manager.ts:1323-1356](../src/server/session-manager.ts#L1323)
   build the hash; [1373](../src/server/session-manager.ts#L1373)
   interpolates). Editing the data file never touches the step text, so the
   hash is identical → cache is **not** cleared.

2. **Per-step key is positional.** `frameScopedStepKey(frameId, sourceLine)`
   ([session-manager.ts:1976](../src/server/session-manager.ts#L1976)) — frame
   + line number only. No step text, no resolved value. The step didn't move,
   so it's a cache **hit**.

3. **Read re-applies only parameters, never data.**
   `StepCache.read(stepIndex, resolvedParams)`
   ([step-cache.ts:83-104](../src/cache/step-cache.ts#L83)) forward-interpolates
   `resolvedParams` into the cached actions. There is no data context. The
   `${data.*}` value was baked into the AI instruction before the AI saw it
   ([session-manager.ts:1635-1638](../src/server/session-manager.ts#L1635)),
   and write-time reverse-interpolation un-bakes only **parameters**
   ([step-cache.ts:114-115](../src/cache/step-cache.ts#L114)) — the data value
   stays concrete in the stored action.

Net: stop → edit data file → re-run → all three layers say "nothing
changed" → the frozen action replays with the **old** value. Affects both
the built-in `${data.X}` namespace and named `${source.X}` dataSources.

### Why parameters are NOT affected (the telling contrast)

`## Parameters` (`{{username}}`) survive an edit because the cache stores
them as placeholders and re-interpolates at read time
([step-cache.ts:96-97](../src/cache/step-cache.ts#L96), proven by the
existing "parameter interpolation on write/read roundtrip" test). Data is
the only interpolation class that gets frozen. So the same test file can
have a working `{{param}}` and a stale `${data.*}` side by side.

## Corroboration already in the codebase

Partial re-runs **force the cache off** for exactly this reason
([session-manager.ts:1303-1310](../src/server/session-manager.ts#L1303)):

> "a cache HIT would replay the frozen action plan and silently ignore an
> edit meant to change behaviour. Force the cache OFF for any partial
> re-run."

That guard covers `startAt` partial re-runs but not a full stop-and-rerun
after a data-file edit — the same hazard, uncovered.

## Fix sketch (cheapest correct)

Make the steps-hash sensitive to resolved data values, so a data edit busts
the cache exactly like a step edit does:

- Compute `interpolatedSteps` (env/data only — **not** params, so the param
  read-time path is preserved) *before* `StepCache.initialize`, and feed
  those as the `cacheHashSource` instead of the raw steps. `interpolateEnvData`
  already exists and does env/data without params; the interpolated array is
  already computed at [session-manager.ts:1373](../src/server/session-manager.ts#L1373)
  — it just needs to move above the cache-init block (~line 1312) and feed the
  hash.
- Leave the per-step positional key as-is; once the bundle-level hash busts on
  a data change, `initialize` wipes the whole test cache and every positional
  entry is re-derived.

Caveats to handle in the real fix:
- The subset-batch / skill-expansion hash branches
  ([session-manager.ts:1324-1354](../src/server/session-manager.ts#L1324)) must
  interpolate env/data on the *full-document* hash source too, or a subset
  batch's hash won't match a full run's. `expandSkills` already receives
  `envDataCtx`; confirm its returned steps carry interpolated data, or
  interpolate after expansion.
- Don't fold parameters into the hash — that would defeat the read-time param
  interpolation that lets one cached plan serve many param values (the whole
  point of reverse/forward interpolation).

Alternative (bigger lift): treat `${data.*}` like params — preserve the
placeholder into the cached action and re-interpolate data at read time. More
faithful (one cached plan serves many data values) but touches the
write/read/forward/reverse interpolation paths and the instruction-build order.

## Worked examples (how the shipped fix behaves)

`H(...)` = `computeStepsHash(...)`; distinct letters = distinct hashes.
"before" = the pre-fix raw hash source; "after" = what session-manager now
feeds (env/data-interpolated).

### 1 — the reported bug: a `${data.*}` value edited → now busts the cache

Step text (unchanged across both runs): `1. Search for ${search-engine.query}`

| | `search-engine.json` | before (raw) | after (interpolated) | hash | cache |
|---|---|---|---|---|---|
| Run 1 | `{ "query": "laptops" }` | `Search for ${search-engine.query}` | `Search for laptops` | A | write `laptops` |
| Run 2 (edited) | `{ "query": "phones" }` | `Search for ${search-engine.query}` | `Search for phones` | **B** | A≠B → **clear** → AI re-runs with `phones` ✅ |

Before: both runs hash identically (placeholder intact) → cache kept → replays
`laptops`. After: resolved value is in the hash → A≠B → stale entry wiped.

### 2 — data key edited but **not referenced** by any step → cache preserved (precision)

`1. Search for ${search-engine.query}`, file goes
`{query:"laptops",region:"US"}` → `{…,region:"EU"}` (only `region` changed).
After the fix the hash source resolves to `Search for laptops` in **both** runs
(region appears in no step) → same hash → **cache hit.** No needless AI re-run —
better than a blunt "data file changed → wipe everything".

### 3 — a `{{parameter}}` changed → cache still rides (efficiency preserved)

`1. Enter the username {{username}}`

| | param | after (interpolated) | hash | cache |
|---|---|---|---|---|
| Run 1 | `username=alice` | `Enter the username {{username}}` | A | write (stored as `{{username}}`) |
| Run 2 | `username=bob` | `Enter the username {{username}}` | A | **hit** → read-time interp fills `bob` |

`interpolateEnvData` leaves `{{username}}` alone → identical hash → cache hit →
one cached plan serves `bob`. **Data busts the cache, params ride it** — the
asymmetry the tests assert.

### 4 — built-in `${data.*}`, multi-step (whole-test invalidation)

```
1. Navigate to ${data.url}         ← uses data
2. Click Sign in                    ← no data
3. Enter the username {{username}}  ← param
```
Editing `data/dev.json` `url` flips the **document** hash → the *entire* test
cache clears → all three steps re-run (identical to editing any step's text
today). Coarser than strictly necessary, but consistent; the per-step-fingerprint
alternative (re-run only step 1) is noted below if this ever bites.

### 5 — breakpoint split / multi-batch (the consistency requirement)

Full test = 3 steps, run with a breakpoint → `batch 1 = [step 1]`,
`batch 2 = [step 2,3]`, both carrying `fullSteps`. The fix interpolates the
**full-document** hash source, so both batches compute the same hash and batch 2
hits what batch 1 wrote. Interpolating only a batch's slice would make the hashes
diverge and the cache never hit across a pause — hence "apply to whichever branch
produced `cacheHashSource`". (Guarded by the existing "full-run and
resumed-subset-batch hashes match" test.)

### 6 — unknown ref (`${data.tpyo}`) → graceful fallback

`interpolateEnvData` throws → the `try/catch` falls back to the raw line for
hashing; the run then fails at the real interpolation site with the precise
`Unknown data path 'tpyo' … in: "…"` error. The hash change never alters
*failure* behavior.

### At a glance

| Change | hash moves? | cache | AI re-runs? |
|---|---|---|---|
| `${data.*}` / `${source.*}` **value** edited | yes | cleared | yes ✅ (the bug, fixed) |
| data key edited but unreferenced | no | kept | no (precise) |
| `{{param}}` value changed | no | kept (read-time fill) | no (efficient) |
| step **text** edited | yes (already) | cleared | yes |
| `${env.*}` value in a step changed | yes | cleared | yes (free partial help for [012](012-step-cache-not-env-aware.md)) |

## Tests (shipped)

**End-to-end, session-manager layer** —
[tests/session-manager.test.ts](../tests/session-manager.test.ts), `"issue 018"`.
Real temp project (`aiui.config.json` + `.env.dev` + `data/dev.json`),
`cacheEnabled`, `envName: 'dev'`, `executeStep` mocked so the observable is
`meta.json`'s `stepsHash` + a planted sentinel cache file (exactly the pattern
the issue-016 Bug 2 tests use):

- *invalidates when a `${data.*}` value is edited* — edit `data/dev.json`
  `query` (step text unchanged), re-run → `meta1.stepsHash` /
  `meta2.stepsHash` equal `computeStepsHash(['Search for laptops'/'phones'])`
  (pinned to the *resolved* form, so the assertion proves interpolation engaged,
  not merely that *something* moved) **and** the sentinel is wiped (captured
  before the temp-dir cleanup, so the check isn't vacuous).
- *does NOT invalidate when an unreferenced data key changes* — edit `region`
  (no step uses it), force a bundle reload → hash stable, sentinel survives.
  Anchored to the resolved hash so it can't pass vacuously (an earlier version
  passed even with the fix removed, since raw `${data.query}` is trivially
  stable — the anchor closes that hole).

Both guards were verified to **fail with the interpolation block disabled**, so
they genuinely protect the fix. The two tests `fs.utimes`-bump the data file's
mtime to force the project-bundle reload deterministically — see the efficacy
caveat in Follow-ups.

**StepCache seam** —
[tests/step-cache.test.ts](../tests/step-cache.test.ts),
`describe('cache invalidation tracks the resolved hash source (issue 018)')`.
Pins the primitive's contract the fix relies on: raw placeholders hash
identically (why the source must be resolved first); the resolved text
(`laptops` vs `phones`) clears the entry; `{{params}}` stay placeholders so the
cache rides param changes.

Full suite green (63 files / 954 tests). Existing cache guards still pass — in
particular "hashes raw steps for a no-skills test" (no env → `envDataCtx` null →
interpolation skipped → byte-identical to pre-fix) and "full-run and
resumed-subset-batch hashes match" (uniform interpolation across branches).

## Follow-ups (not blocking; this issue is resolved)

- **[012](012-step-cache-not-env-aware.md) (cross-env)** is still open. This fix
  makes the hash sensitive to env/data *values that appear in step text*, which
  helps 012 for free — but 012's same-text/different-DOM case (a cached selector
  that only exists on one env) still needs env-namespacing of the cache.
- **Completeness gap:** the hash sees data referenced *in steps*. A `${data.*}`
  used only outside the hashed step text (e.g. a `## Parameters` value, a config
  `baseUrl` override) isn't covered here. Some of those ride other mechanisms;
  not yet traced. Backstop if it ever bites: fold the referenced data files'
  mtimes into the cache meta.
- **mtime-reload dependency (efficacy caveat):** this fix only re-hashes fresh
  data if the project-bundle actually *reloaded* the edited file, which is gated
  on issue-011's exact-`mtimeMs` check
  ([session-manager.ts:642](../src/server/session-manager.ts#L642)). On a
  filesystem with coarse mtime resolution, a "save and re-run" landing in the
  same tick as the prior bundle load would not reload, and the fix would
  silently re-interpolate stale data — the very bug. Human-paced editing differs
  in mtime so this is low-probability, and it's an issue-011 limitation rather
  than this change, but the two regression tests deliberately `utimes`-bump the
  mtime to avoid depending on it. Closing it for real means tightening 011's
  reload trigger (content hash, or watch events).
- **Granularity:** any referenced-data change wipes the whole test's cache
  (consistent with step-text edits). If big shared `dataSources` files make that
  too coarse, switch to a per-step data fingerprint (mirrors the existing
  `readAssertion` fingerprint) to re-run only the affected steps.

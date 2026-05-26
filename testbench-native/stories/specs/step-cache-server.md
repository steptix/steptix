# Server-Side StepCache Spec

Wires the existing `StepCache` (already used by the CLI runner) into the
API server's step-execution path so that re-running a test skips the AI
call on every step whose AI plan is already cached. Goal: reduce token
spend during iterative test development.

## 1. Goal

Skip the AI call entirely on cache-hit steps. When a step in a test has
previously been executed successfully through this server, the cached
AI plan (selectors, action sequence, reasoning) is replayed against the
current page state without contacting the AI gateway.

**Not in scope** for this spec:
- Reducing per-call input tokens via Anthropic prompt caching.
- Caching beyond a per-test boundary (e.g. cross-test fragment cache).
- DOM-fingerprinting cache keys (see issue 012 Option 2 for the future
  principled fix).

## 2. Cache identity

Cache entries are keyed by three layers:

| Layer | Key | Purpose |
|---|---|---|
| Namespace | sanitised `testFilePath` | All cache for one test lives in one directory |
| Bundle hash | SHA-256 of the **expanded** document (`effectiveSteps`, or `expandSkills(fullSteps)` for a subset batch) | Editing any test step **or skill body** invalidates the whole bundle ([issue 016](../../../issues/resolved/016-skill-cache-key-collisions.md) Bug 2; see [skill-cache-invalidation.md](skill-cache-invalidation.md)). |
| Per-step ID | frame-scoped: bare source line (`17`) for inline test steps, `f<n>-<line>` for skill-body steps | Unique per logical step within a run — a skill step and a test step (or two invocations of one skill) on the same line number no longer collide. See [skill-cache-key-collision.md](skill-cache-key-collision.md). |

```
<project-root>/.cache/
  <sanitised-test-path>/
    meta.json                    # { stepsHash, schemaVersion }
    step-<sourceLine>.json       # { turns: [{ rawResponse, actions, reasoning }] }
    step-<sourceLine>.json
    ...
```

Source line is chosen over ordinal step index because it stays stable
when steps are added/removed in unrelated parts of the file (the bundle
hash already invalidates the whole bundle on any step change, so the
per-step ID just needs to be a stable disambiguator within an unchanged
bundle — line number is more human-meaningful for debugging the cache
than `step-5.json`).

> **Amended (issue 016):** "line number in the test file" assumed every
> step came from the test file. Skill expansion puts skill-body steps —
> carrying their *skill-file* line — into the same flat directory, so two
> files' lines could collide (and two invocations of one skill always
> did). The per-step ID is now frame-scoped (`f<n>-<line>`) for skill-body
> steps; inline test steps keep the bare line. Design:
> [skill-cache-key-collision.md](skill-cache-key-collision.md).

## 3. Project root resolution

The cache lives at `<project-root>/.cache`. **Not** at `<server-CWD>/.cache`,
because testbench-native's embedded server may be launched from
anywhere.

Resolution algorithm, applied per request using `testFilePath`:

1. Start at `dirname(testFilePath)`.
2. Walk up looking for any of: `aiui.config.json`, `package.json` containing
   `"aiui"` config, or the workspace root (passed as a request hint, or
   detected via the server's launch directory).
3. First hit wins — that's the project root.
4. If no marker is found by the filesystem root, **disable cache for this
   request** and log a one-time warning. Better to skip cache than write
   to a phantom `.cache` directory next to the server process.

The resolved project root is computed per-request (cheap — at most ~10
`stat` calls) and not memoised on the session, so a test moved between
projects mid-session would still resolve correctly.

## 4. Request protocol

Two new optional fields on `StepRequest`:

```typescript
interface StepRequest {
  // ... existing fields
  cacheEnabled?: boolean;   // opt-in: caching only when explicitly true
  fullSteps?: string[];     // full post-expansion list for hash stability
}
```

**`cacheEnabled`** — opt-in switch. The server caches only when this is
explicitly `true` **and** a `testFilePath` is present. An absent flag
(`undefined`) or `false` means no cache — every step goes through the AI.
CLI / programmatic callers without a test file path get no cache.

How testbench-native decides the flag (see §10.1): the run sends
`cacheEnabled: true` only when the test's nearest `aiui.config.json`
declares `cache.enabled: true`, or the test's own `## Config: cache: on`
block opts it in. A per-test `## Config: cache: on|off` overrides the
project config in either direction; absent both, the flag is omitted and
the server keeps the cache off.

**`fullSteps`** — required when a batched run trims the step list at a
breakpoint. The hash is computed against `fullSteps ?? effectiveSteps`.
Without this, a paused-and-resumed run would compute different hashes
for batch 1 (`steps 1–4`) and batch 2 (`steps 5–10`) and never hit cache
on subsequent runs.

The client side (testbench-native) computes `fullSteps` from the live
editor buffer:

```typescript
const allSteps = extractSteps(editor.document.getText());
streamSteps({
  steps: allSteps.filter(s => s.line >= startLine).map(s => s.instruction),
  fullSteps: allSteps.map(s => s.instruction),
  sourceLines: allSteps.filter(s => s.line >= startLine).map(s => s.line),
});
```

The editor buffer (not disk) is the source of truth — unsaved edits
must be reflected in the hash so a cache-hit doesn't replay a stale
action plan against the actually-edited step.

## 5. Cache lifecycle

### Read (cache-hit path)

On step execution, after skill expansion and parameter resolution:

1. `StepCache.read(sourceLine, resolvedParameters)` reads
   `step-<line>.json` (if exists).
2. The cached `rawResponse` and `actions` contain `{{param}}`
   placeholders that get forward-interpolated against the current
   `resolvedParameters` at read time. (Existing CLI behaviour; preserved.)
3. The cached actions are applied to the page. If they succeed, emit
   `step:pass` and proceed.
4. If application fails (selector miss, element not actionable), invoke
   `StepCache.invalidateStep(sourceLine)` and fall through to the AI
   path for re-evaluation. This single-step self-heal is the safety net
   for page-state divergence (see §7).

### Write (cache-miss path)

After the AI returns and the actions succeed:

1. `StepCache.write(sourceLine, turns)` persists the response.
2. On step *failure*, no write happens — failed responses are not
   cached. This makes paused-on-error retries automatically Do The Right
   Thing: a failed step is re-asked on retry, not replayed.

### Invalidate

- **Bundle-level**: when `stepsHash` changes (any step edited, any skill
  body changed after the (c) `clearSkillCache` fix landed), the entire
  cache directory is cleared and `meta.json` rewritten on the next
  request. Existing `StepCache.initialize` behaviour.
- **Per-step**: triggered by failed application of a cached plan (the
  self-heal path above) or by `needs_reeval` markers in the cached turn
  data (existing CLI behaviour).

## 6. Server wiring

In `executeStepsInternal`, after `expandSkills` runs:

```typescript
const cacheEnabled = request.cacheEnabled === true && !!request.testFilePath;
// Bug 2 (issue 016): hash the EXPANDED document so skill-body edits invalidate
// — see skill-cache-invalidation.md §4.2 (a full run reuses effectiveSteps; a
// subset batch re-expands fullSteps for a batch-stable hash).
const cacheHashSource = chooseCacheHashSource(request, effectiveSteps);
let stepCache: StepCache | undefined;
if (cacheEnabled) {
  const projectRoot = await resolveProjectRoot(request.testFilePath!);
  if (projectRoot) {
    const cacheDir = path.join(projectRoot, this.config.cache.dir);
    stepCache = await StepCache.initialize(cacheDir, request.testFilePath!, cacheHashSource);
  } else {
    logger.warn(`Cache disabled: no project root found for ${request.testFilePath}`);
  }
}
```

At each `executeStep` call site, pass `stepCache` and `cacheEnabled`,
plus the source-line ID for that step:

```typescript
const stepIdentityId = effectiveSourceLines?.[i] ?? (i + 1);
stepResult = await executeStep(
  stepIdentityId,
  stepsTotal,
  stepInstruction,
  {
    // ... existing fields
    stepCache,
    cacheEnabled,
  },
);
```

The first arg to `executeStep` is `stepIndex` today and is used both
for log lines and for `StepCache.read/write/invalidate` calls. Renaming
isn't required, but the value being passed shifts from "ordinal in this
batch" to "source line in the test file."

## 7. Page-state divergence

The cache assumes the page state at step N's start during a cached run
matches the state during a future replay. This is a **pre-existing risk
inherited from CLI mode**: it's why `needs_reeval` exists. Mid-session
pause-and-edit makes the risk more visible because two batches in one
session can diverge mid-test.

Self-heal mechanism (already in `step-executor.ts`):
- Cached actions applied → page event handler reports failure → cache
  entry for that step invalidated → next turn calls AI → response
  cached, replaces the invalidated entry.
- One AI call to repair per drifted step. Cache repopulates with a
  response that works for the current state.

We accept this for v1. If `needs_reeval` thrashing turns out to be
common in real usage, issue 012 Option 2 (DOM-fingerprint cache keys)
is the principled escalation.

## 8. Interaction with other server features

| Feature | Interaction |
|---|---|
| Breakpoint batch split | Handled by `fullSteps` (§4). Hash is identical across batches; cache hits across batch boundaries. |
| Paused-on-error retry | Failed steps don't cache (§5). Retry hits AI fresh, not the stale failed plan. |
| Skill expansion | Skill-body steps get a frame-scoped cache id (`f<n>-<line>`) so repeated invocations / same-line steps don't collide (Bug 1). Editing a skill body invalidates the bundle — the hash is over the **expanded** document, so a changed body changes the hash (Bug 2). Both fixed under [issue 016](../../../issues/resolved/016-skill-cache-key-collisions.md); see [skill-cache-invalidation.md](skill-cache-invalidation.md). `clearSkillCache` re-parses skills each run so the expansion (and thus the hash) reflects disk edits. |
| `[store as: X]` / `[output: X]` captures | Cached `actions` reference `{{X}}` placeholders; `session.outputs` interpolation happens at read time. Captured values from earlier batches flow into cached steps in later batches. |
| `[tool: ...]` steps | No AI call to skip — tool dispatch is deterministic. Cache lookup is bypassed for these. |
| `[interactive]` / `[input: ...]` | Bypassed. User-prompted steps are not cached. |
| Env / data files | Cache is env-agnostic in v1; see issue 012. |
| Concurrent sessions | File-level write races possible but unlikely; same testFilePath running twice simultaneously is rare. Documented limitation. |

## 9. Acceptance criteria

A second request, with identical `testFilePath`, `fullSteps`,
`sourceLines`, and `resolvedParameters`, **must not invoke the AI** for
any step whose cached entry exists from the first request. Verifiable
by mocking `AiClient.chat` and asserting zero calls on the second run.

Edge-case tests required:

- **Batch boundary**: first request with `steps = [step1, step2]`,
  `fullSteps = [step1, step2, step3]`. Second request with `steps =
  [step3]`, same `fullSteps`. Step 3 still triggers AI (not cached
  yet). Third request with `steps = [step1, step2, step3]` (no
  breakpoint) hits cache on all three.
- **Edit invalidation**: cache populated, then edit step 2, then re-run.
  Step 1 hits cache, step 2 calls AI (different text → different bundle
  hash → entire cache cleared, actually).
- **Skill body edit**: cache populated, edit skill body file on disk,
  re-run. Cache invalidates (the (c) fix makes `clearSkillCache` run
  before expansion, so the post-expansion step list differs).
- **No `testFilePath`**: cache is disabled silently, no errors.
- **No project root**: cache is disabled with a one-time warning per
  unresolvable path.
- **Paused-on-error**: step 2 fails. Cache is NOT populated for step 2.
  User edits and resumes. Retry calls AI (cache miss is correct).
- **Cached action fails on replay**: cached selector no longer matches.
  Cache invalidates that step, AI is called, new plan caches over the
  old.

## 10. Client-side changes (testbench-native)

### 10.1 Request body

The runner-side `streamSteps` call always sends `fullSteps` when the
run is a trimmed batch (breakpoint pause + Continue, runAll with
selection, etc.). For full-document runs (`runLines([])`), `fullSteps`
is equal to the post-extraction `steps` and sending it is redundant
but harmless.

**`cacheEnabled`** is added to the body only when the run opts into
caching. The decision (in `run-controller.ts`):

1. Baseline from the test's nearest `aiui.config.json` —
   `resolveProjectDirs(uri).cacheEnabled` (`cache.enabled === true`). The
   walk-up + nearest-wins matches the server's project-root resolution, so
   "client enabled" and "where the server writes `.cache`" agree.
2. A per-test `## Config: cache: <value>` overrides that baseline in either
   direction (`on`/`true`/`yes`/`enabled` → on; `off`/`false`/`no`/`disabled`
   → off; anything else falls through to the baseline). Parsed by
   `resolveCacheOverride`.

When the result is `true`, the body carries `cacheEnabled: true`; otherwise
the field is omitted entirely (the server then keeps the cache off — §4).
Interactive (`[interactive]` / `[input:]`) sub-requests never send it.

### 10.2 User-visible cache indicators

A run where 8/10 steps load from cache feels noticeably faster, and
a step that suddenly fails after several cached runs needs context
("oh, the cached selector stopped applying — that's why the AI was
asked again"). Three surfaces, each a v1 requirement:

**a) `step:pass` event carries `fromCache: boolean`.**

Protocol addition (`runner-core/src/protocol.ts`):

```typescript
type StepPassEvent = {
  type: 'step:pass';
  line: number;
  fromCache?: boolean;    // true when the step's AI plan came from cache
  frame?: FrameInfo;
};
```

The server sets `fromCache: true` whenever `StepCache.read` hits
(every cached turn used, no AI call made for this step). The client
treats absent / `false` as "AI was called" — backward compatible.

**b) Run log line marker.**

Already precedented in the CLI: `Step ${stepIndex} passed (from cache)`
([step-executor.ts:206](../../../src/runner/step-executor.ts#L206)).
The testbench-native output channel logs:

```
[hh:mm:ss] ✓ Step 3 passed  (cached)
[hh:mm:ss] ✓ Step 4 passed
```

The `(cached)` suffix is the v1 differentiator in the run log.

**c) Gutter glyph: ⚡ for cached pass.**

The active-file-tracker's `LineStatus` type gains a new value:

```typescript
type LineStatus = 'running' | 'pass' | 'pass-cached' | 'fail' | 'skip' | 'stopped';
```

The status painter renders `pass-cached` with a ⚡ glyph instead of
the ✓. The `step:pass` handler in `applyToTracker` writes
`'pass-cached'` when `ev.fromCache` is true, `'pass'` otherwise.

⚡ is consistent with the existing HTML report
([report/generator.ts:638](../../../src/report/generator.ts#L638))
which uses ⚡ to mark cached assertion runs. Reusing the glyph keeps
"cached" meaning the same thing across surfaces.

### 10.3 End-of-run summary

The Test Runner panel shows a one-line summary on `done`:

```
✓ 12 passed (8 cached) · 1.2s
```

When `fromCache` count is 0, the parenthetical is omitted to keep
non-cached runs uncluttered:

```
✓ 12 passed · 4.8s
```

This is the surface that answers "how much did the cache help me
today?" — the most direct ROI signal.

### 10.4 Status bar

No persistent status-bar item in v1. Considered and deferred — the
gutter ⚡ + run-log `(cached)` + end-of-run summary cover the in-the-
moment visibility. A persistent "cache: 47 hits today" item adds
clutter without much per-run value.

### 10.5 Deferred to v2

- "Clear cache for this test" command (`testbench-native.clearStepCache`).
  Useful if a user suspects stale cached actions are masking a bug.
- Hover tooltip on the ⚡ glyph showing the cached turn's timestamp
  and `reasoning` excerpt.
- Live cache hit/miss counter as the run progresses (right now the
  user only learns at end-of-run).
- Cache-hit visibility in batch / Test Explorer mode (currently the
  Test Explorer surfaces pass/fail counts; would need a new
  ⚡-decorated counter).

## 11. Migration & rollout

- Existing CLI users see no change (CLI path was already wired).
- Existing testbench-native users see cache hits on re-runs.
- The `.cache/` directory must be added to `.gitignore` if it isn't
  already (it is — confirmed at repo root).
- Cache schema version bumps invalidate everything; the existing v3
  schema is reused without change.

## 12. Open issues / follow-ups

- [issues/012](../../../issues/012-step-cache-not-env-aware.md) — env-
  agnostic cache key. Fix likely in v2.
- Concurrent-session write races on shared cache (rare). Defer until
  reported.
- "Cache hit rate" telemetry / status bar surface. Defer to v2.

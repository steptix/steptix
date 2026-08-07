# 042 — A `read`/`count` action's `as` capture never reaches the `run_steps` response unless the step also carries an `[output: X]` prefix

**Status:** ✅ **RESOLVED — implemented + tested (2026-08-07).** Fixed in two
rounds: the initial fix, then an independent Opus 5 review caught a
must-fix `__skill*`-namespace leak (and a related stale-value-across-steps
issue) before this was marked resolved — see [Round 2](#round-2--independent-review-opus-5-2026-08-07).
**Area:** [src/runner/step-executor.ts:1259-1275](../../src/runner/step-executor.ts#L1259) (`as` → `resolvedParameters`, the only write site), [src/browser/actions.ts:211-223](../../src/browser/actions.ts#L211) (only `read`/`count` set `capturedValue`/`capturedValues`), [src/server/session-manager.ts:639-677](../../src/server/session-manager.ts#L639) (`parseOutputPrefixes` / `buildEnrichedInstruction`), [src/server/session-manager.ts:2989-2998](../../src/server/session-manager.ts#L2989) (prefix parsed **before** the per-step AI planner ever runs), [src/server/session-manager.ts:3252-3277](../../src/server/session-manager.ts#L3252) (the capture loop — now the fix site too), [src/mcp/run-fold.ts:270-282](../../src/mcp/run-fold.ts#L270) (`captures` map built solely from `'capture'` events), [src/mcp/schemas.ts:408-423](../../src/mcp/schemas.ts#L408) (`runResultOutput.captures`), [src/mcp/tools.ts:569-576](../../src/mcp/tools.ts#L569) (`STEP_SYNTAX` — `[output:]` isn't mentioned), [tests/session-manager.test.ts](../../tests/session-manager.test.ts) (4 new tests)
**Related:** [issues/020-read-action-cannot-slice-a-substring-from-captured-text.md](../020-read-action-cannot-slice-a-substring-from-captured-text.md) (another `read`-action ergonomics gap); [issues/043-captured-variables-never-shown-in-html-report.md](043-captured-variables-never-shown-in-html-report.md) (same captured value, HTML report side — the very next question asked after verifying this fix live)
**Opened:** 2026-08-07
**Resolved:** 2026-08-07

## Summary

`run_steps` returns a `captures: Record<string, string>` field alongside per-step
status. A `read`/`count` action's `as` field (e.g. `"as": "total_available"`)
looks like the obvious way to get a value into that map — and the per-step AI
planner readily picks a sensible `as` name on its own, unprompted. But `as`
alone **never** populates `captures`. The value silently lands only in an
internal template store, invisible to whoever called `run_steps`.

### Repro

Call `run_steps` with a plain-English step:

```
Read the Credits page and identify the dollar amount displayed next to
"TOTAL AVAILABLE". Return only the extracted dollar amount.
```

The per-step planner (reasonably) emits:

```json
{
  "action": "read",
  "selector": "[aria-label=\"Total available credits: $37.77\"]",
  "attribute": "aria-label",
  "pattern": "Total available credits: (\\$[0-9]+(?:\\.[0-9]{2})?)",
  "as": "total_available",
  "description": "Extract the dollar amount next to Total available"
}
```

The read succeeds — `$37.77` is captured. `run_steps`'s response has no
`total_available` anywhere in `captures`.

## Mechanism

Two independent mechanisms both use the word "output," and only one of them
reaches the caller:

1. **The JSON action's `as` field** is handled at
   [step-executor.ts:1259-1275](../../src/runner/step-executor.ts#L1259): a
   `read`/`count` result with `capturedValue(s)` and a truthy `action.as`
   writes into `opts.resolvedParameters[action.as]` — an in-memory
   `Record<string, string>` used for `{{template}}` interpolation in later
   steps. `as` is documented as a "multi-purpose name field"
   ([ai/types.ts:86-91](../../src/ai/types.ts#L86)); only `read`/`count` ever
   populate `capturedValue`/`capturedValues`
   ([actions.ts:211-223](../../src/browser/actions.ts#L211)), so this write site
   is the *only* place a fresh key lands in `resolvedParameters` mid-step.

2. **An `[output: X]` prefix on the step's instruction text** is parsed out
   **before** the per-step planner even runs
   ([session-manager.ts:2989-2998](../../src/server/session-manager.ts#L2989)):
   `parseOutputPrefixes` strips it into `outputVars` and rewrites the
   instruction the planner actually sees, appending `[store as: X]` to cue it
   toward that exact variable name
   ([buildEnrichedInstruction](../../src/server/session-manager.ts#L672)). After
   the step executes, a dedicated loop checks each name in `outputVars`
   against `resolvedParameters` and, for every hit, emits a `'capture'` SSE
   event ([session-manager.ts:3252-3271](../../src/server/session-manager.ts#L3252)).
   [run-fold.ts:270-282](../../src/mcp/run-fold.ts#L270) folds `'capture'` events
   — and *only* `'capture'` events — into the `captures` map returned to the
   MCP caller.

Because the emit loop iterates `outputVars` (mechanism 2) and checks
membership in `resolvedParameters` (written by mechanism 1), a step whose
`as` capture was never *declared* via `[output: X]` satisfies neither side of
that intersection from the caller's perspective — the value exists in
`resolvedParameters`, but nothing ever asked to look for that name, so no
`'capture'` event fires and `captures` stays empty for it.

The value isn't entirely lost: a second, unconditional sweep after every step
([session-manager.ts:3395-3409](../../src/server/session-manager.ts#L3395)) copies
*all* of `resolvedParameters` into `session.outputs` for cross-batch
persistence (so a breakpoint-split run doesn't lose it) — but that sweep does
not `emit()` anything, so it never reaches `captures` either.

**The caller can't fix this by "having the planner add `[output: X]`."** The
planner that emits the JSON action (and picks `as: "total_available"`) only
ever *receives* instruction text — by the time it runs, `parseOutputPrefixes`
has already consumed (or not found) the prefix upstream. Only whoever
authors the `steps` array passed to `run_steps` can add `[output: X]`, and
only before the run starts — and `[output:]` isn't mentioned in `STEP_SYNTAX`
([tools.ts:569-576](../../src/mcp/tools.ts#L569)), so there's no discoverable
signal telling a caller to do so.

## Fix

Auto-surface every `as`-tagged read/count capture, regardless of whether
`[output: X]` was used. After a step executes, collect the `as` names from
*that step's own successful* read/count sub-actions and union them with the
explicit `outputVars` before the existing emit loop:

```ts
const autoOutputVars = stepResult.turns
  .flatMap((t) => t.subActions)
  .filter((sa) => !sa.error && (sa.action.action === 'read' || sa.action.action === 'count'))
  .map((sa) => sa.action.as)
  .filter((name): name is string => !!name && !name.startsWith('__skill'));
const captureVars = new Set([...outputVars, ...autoOutputVars]);
```

Membership in `resolvedParameters` still gates the actual emit — unchanged.
Three filters narrow the candidate set before that gate is even checked (all
added during review — see **Round 2** below for why each is load-bearing):

- **`sa.action.action === 'read' || 'count'`** — the only action kinds that
  ever write `as` into `resolvedParameters`
  ([actions.ts:211-223](../../src/browser/actions.ts#L211)). Excludes
  `openPage`'s tab-label `as` (same field, different namespace/meaning — see
  [ai/types.ts:86-91](../../src/ai/types.ts#L86)) and `extract_value`'s `as`
  (currently a documented no-op sub-action).
- **`!sa.error`** — `resolvedParameters` is never cleared between steps, so
  without this a read that *fails* on a name a prior step already captured
  would re-emit that stale value as if this step had produced it.
- **`!name.startsWith('__skill')`** — skill-internal variables are
  namespaced `__skillN_name` specifically so they never reach session scope
  ([expander.ts](../../src/skills/expander.ts), invariant also enforced at
  [session-manager.ts:1835-1839](../../src/server/session-manager.ts#L1835) and
  documented at [session-manager.ts:2063](../../src/server/session-manager.ts#L2063)).
  A skill's *declared* `## Outputs` are exempt from namespacing and keep
  their caller-facing name, so they're unaffected and still auto-surface.

This makes `[output: X]` optional sugar for *renaming* a capture (or forcing
one from an action type that doesn't naturally set `as`), rather than a
required, undocumented incantation. The `[store as: X]` synthesis, the
cross-batch backstop sweep, and `outputSources` labelling are all unaffected.

Scope note: `[tool: ... out.foo=bar]` bindings do **not** go through
`action.as`/this write site (a separate mechanism in `src/tools/*`), so this
fix does not extend to them.

**Known remaining gap (pre-existing, not introduced by this fix):** steps
inside a conditional branch (`executeBranchedStep`) never reach the capture
loop or the backstop sweep at all — branch results hardcode `outputs: {}`
([session-manager.ts:2762-2858](../../src/server/session-manager.ts#L2762)). A
`read ... as: X` inside an `[if …]` branch is invisible to `captures`
regardless of `[output:]`, same as before this fix.

## Tests

Added to `tests/session-manager.test.ts`, alongside the existing
`[output:]`-capture tests:

- **`emits a capture event for a read/count \`as\` capture with no [output:]
  prefix`** — the core fix; fails without it (empty `outputVars` → empty
  `captureVars` → no emit).
- **`does not double-emit when [output:] and the action \`as\` name agree`** —
  the `Set` union guards against a naive concat double-counting the common
  case where `[output: X]` cues the planner to also set `as: X`.
- **`never auto-surfaces a __skill*-namespaced \`as\` capture`** — the Round-2
  fix; fails without the `__skill` filter.
- **`does not re-emit a stale value when this step's \`as\` action failed`** —
  the Round-2 fix for the same-name-across-steps case; a step's failed read
  reusing an earlier step's `as` name must not re-emit that earlier value.

## Round 2 — independent review (Opus 5, 2026-08-07)

Before marking this resolved, an independent reviewer (general-purpose agent
on Opus 5, no prior context on this change) was asked to try to break the
first-pass fix — which at that point unioned `outputVars` with **every**
`action.as` name found in `stepResult.turns[].subActions[]`, gated only by
`in resolvedParameters`, no action-kind/error/`__skill` filtering.

**Confirmed, must-fix:** that version let `__skill1_*`-namespaced internal
variable names leak into `captures`, `session.outputs`, and — because
`session.outputs` unfiltered seeds the next batch's `resolvedParameters` —
across batch boundaries. This breaks an existing, explicitly-documented
invariant (three separate comments assert `__skill*` never reaches session
scope; see the Fix section above) and reproduces the exact
same-namespace-different-instance collision a prior fix introduced the
`__skillN_` counter to prevent, now reachable across batches instead of just
within one. It also silently defeats the partial-re-run guard at
[session-manager.ts:2733](../../src/server/session-manager.ts#L2733), which
refuses a re-run when `{{__skill…}}` survives interpolation on the assumption
that internals *can't* be seeded from a prior run.

Reviewer's reproduction: a probe test with a mocked `executeStep` returning
`action.as = '__skill1_total'` produced a `capture` event and populated
`outputs`/`outputSources` pre-Round-2-fix; zero of either post-fix.

**Also flagged (same root cause — `resolvedParameters` persists across
steps and was never cleared):** an unfiltered version could re-emit a
*stale* value under an `as` name reused by a *failed* action, misattributing
an earlier step's capture to the step whose action actually failed — because
the capture loop runs before the pass/fail branch. Fixed by the same
action-kind + `!sa.error` narrowing (see Fix section); a fourth test locks
this in.

**Verified by the reviewer and not changed:** types are sound (`tsc --noEmit`
clean), `stepResult.turns` is populated on every path that reaches the
capture loop (tool-step branch explicitly sets `turns: []` — an empty array,
not undefined — cache-replay carries full sub-action objects), the `Set`
union doesn't regress `[output:]`-only behavior, and all pre-existing tests
(274 across 10 SessionManager-touching suites) stayed green throughout.

## Discovered while

Investigating why `run_steps`'s response didn't show a value the AI had just
captured: a step asking to read the "TOTAL AVAILABLE" dollar amount produced
a `read` action with `"as": "total_available"`, but `total_available` was
nowhere in the response. Tracing the capture pipeline surfaced the
`[output:]`-only gate; a first proposed workaround ("have the planner add
`[output: X]`") turned out to be incoherent once the actual order of
operations was checked (see Mechanism) — leading to this fix instead.

## Revisit when

- A caller wants `extract_value` or tool `out.` bindings auto-surfaced the
  same way — would need a similar audit of their (currently separate) write
  paths into `resolvedParameters`/session scope.
- `[output:]` remains worth documenting in `STEP_SYNTAX` regardless of this
  fix, for the rename/force-capture use case that survives it.
- A caller needs `as`-tagged captures from *inside* a conditional branch
  surfaced — would need `executeBranchedStep`'s results wired into the same
  capture loop / backstop sweep (currently skipped entirely, pre-existing).

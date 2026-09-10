# 055 — `aiui compile` drops an entry whose FIRST inlining a return skipped

**Status:** open / correctness — pre-existing in
[#140](https://github.com/pkent/ai-ui-automation/pull/140), not introduced by
the row-compile work.
**Area:** [src/codebehind/compile.ts](../src/codebehind/compile.ts) — the
`skippedInRecording` filter (~line 484) applied to a `selection.order` that
[`selectSteps`](../src/codebehind/compile.ts) has already deduped to the first
inlining per entry key.
**Deliberate counterpart:**
[src/codebehind/live-compile.ts](../src/codebehind/live-compile.ts) — the live
compiler nets its `skippedByReturn` list at `finish`, so it answers this case
correctly either way round.
**Related:** [stories/step-flow-control.md](../stories/step-flow-control.md)
decision 12 ("not attempted" is owed per ENTRY) and
[stories/data-driven-rows.md](../stories/data-driven-rows.md) (the entry-key
dedupe both compilers share).
**Opened:** 2026-09-09

## Summary

One entry serves every inlining of one authored line: a `### Section` called
twice, or a looped body run once per row, binds every copy to the same
`entryKeyOf` (file, section, source, occurrence). Both compilers dedupe on that
key. They disagree about what happens when the inlinings disagree about whether
the line ran.

`selectSteps` keeps the **first** step per key:

```ts
if (!step.key || keys.has(step.key)) continue;
keys.add(step.key);
order.push(step);
```

`compileTest` then drops from that selection every step the recording skipped:

```ts
const skippedInRecording = selection.order.filter(
  (s) => record.steps[s.index]?.status === 'skipped',
);
```

So for a recording where call 1 returned before a body line and call 2 ran it,
the selection holds call 1's step (the first), that step is skipped, and the
line is dropped and reported `notAttempted` — while call 2's full transcript,
which is the evidence a generation needs, was deduped away and is never looked
at.

## Both behaviours, on one recording

    ### Sign in                    (called twice from the main flow)
    1. If … then return
    2. Enter the username
    3. Click Sign in

Condition holds on **call 1**, so call 1 skips lines 2–3 and call 2 runs them.

| | `Enter the username` / `Click Sign in` |
|---|---|
| `aiui compile` (boxed) | dropped from the selection, `notAttempted: [3, 4]`, no entry written, `partial` |
| Run & Compile (live) | generated from call 2, `notAttempted: []`, entries in the proposal |

The live answer is the intended one, and both compilers agree on the forward
order (call 1 runs the body, call 2 returns): the entry is generated from
call 1 and nothing is owed.

Pinned as it stands: `tests/api-server-compile-mode.test.ts`, "a LATER call
compiling what an earlier one skipped clears the debt" (live). The boxed path
has no test for this order — its own tests
(`tests/codebehind-flow-control.test.ts`, "compile — a step the recording
skipped") use a main-flow return, where there is only one inlining and the two
paths cannot differ.

## Why it is not fixed here

The row-compile branch's parity argument is about the forward order and about
`kept`, and it holds there. Fixing this one means changing what `selectSteps`
selects — "the first inlining per key" would become "the first inlining per key
*that has a transcript*" — which is a change to the boxed pipeline's selection
for every caller of it (`--all`, `--steps`, `--only-stale`), not a filter tweak
in one branch. That deserves its own change with its own tests rather than
riding along.

## What a fix looks like

1. In `selectSteps`, prefer a step whose recording status is usable when
   choosing which inlining holds a key — which means `selectSteps` has to see
   the recording, and it currently takes only `steps`, `select` and
   `staleKeys`. Passing the record in is the shape decision.
2. Keep the `skippedInRecording` reporting for the case it was written for: an
   entry NO inlining ran, which is still owed and still named.
3. A test in `tests/codebehind-flow-control.test.ts` in the shape of "compile —
   a step the recording skipped", with a section called twice and the condition
   holding on call 1.

## Revisit when

- Someone reports `aiui compile` writing no entry for a section-body line that
  a Run & Compile of the same test does write, or
- `selectSteps` is touched for any other reason.

# 053 — Run & Compile says nothing about the branch a decision did not take

**Status:** ✅ **RESOLVED — implemented + tested (2026-09-26)**, as decision 12
of [stories/codebehind-loops-and-conditions.md](../../stories/codebehind-loops-and-conditions.md).
See §Resolution at the end; the diagnosis below is kept as written, and its
line numbers are the ones it was diagnosed at.
**Area:** [src/codebehind/live-compile.ts:274](../../src/codebehind/live-compile.ts#L274)
(`generationRefusal`, the `skipped` branch),
[src/codebehind/live-compile.ts:211](../../src/codebehind/live-compile.ts#L211)
(`SKIPPED_BY_RETURN_REFUSAL`, the sentence that is also a filing key),
[src/server/session-manager.ts:4265](../../src/server/session-manager.ts#L4265)
(`emitSkippedStep`, which never offers its rows to the compiler)
**Related:** [stories/control-flow.md](../../stories/control-flow.md) (decision 12
and §"What the build showed"), [stories/step-flow-control.md](../../stories/step-flow-control.md)
(decision 12 there is where the compiler learned to name a return-skipped
step), [stories/codebehind-compile-as-a-run.md](../../stories/codebehind-compile-as-a-run.md)
(why a step that never ran must be *named* as not attempted rather than left
without an entry)
**Opened:** 2026-09-09
**Resolved:** 2026-09-26

## In plain terms

A test can now decide between two sections:

```markdown
2. If the Cash checkbox is ticked, then Pay with cash
3. Otherwise, Pay by card

### Pay with cash
1. Click Pay now
2. Verify the Payment method panel says "Paid in cash"

### Pay by card
1. Tick the Card checkbox
2. Type "4111 1111 1111 1111" into the Card number field
3. Click Pay now
4. Verify the Payment method panel says "Paid by card"
```

On a page where Cash is ticked, `Pay with cash` runs and `Pay by card` is
skipped. That is the feature working.

Now **Run & Compile** that file in TestBench. What you get is correct as far
as it goes: `Pay with cash`'s two steps are recorded and get code-behind
entries; `Pay by card`'s four steps get nothing, because nothing ran and there
is nothing to record. The next time a run takes that branch and you compile,
they get their entries then.

What you are *told* is the problem. The compile summary reads something like

```
◐ Compiled control-flow.md: 6 step(s) as code (unproven — the next run proves them)
```

and stops there. The four steps of `Pay by card` are not in the "as code"
count, not in a "not attempted" count, not anywhere. An author reading that
summary has no way to know that a third of the file is still AI-driven and
will stay so until a run goes the other way. The summary is never wrong; it is
incomplete, and incomplete in the direction that hides work still owed.

The CLI's compile does say it. `npx aiui compile tests/control-flow.md` ends
with a line built by `recordingSkipCause`
([compile.ts:1073](../../src/codebehind/compile.ts#L1073)):

```
4 step(s) not attempted (the run decided against them)
```

and, for a file where a `return` ended a flow instead,

```
4 step(s) not attempted (a return ended the flow before them)
```

So the two compile paths disagree about whether to mention the untaken
branch, and TestBench is the one most people use.

## Mechanism — the compiler has one sentence for "skipped", and uses it as a key

Three facts combine.

**1. The server offers the live compiler executed steps and return-skipped
steps, and nothing else.** `liveCompile.offer` is called at
[session-manager.ts:5559](../../src/server/session-manager.ts#L5559) for a step
that ran, and at [session-manager.ts:5865](../../src/server/session-manager.ts#L5865)
for each row a `return` skipped — the second call exists precisely so that a
Run & Compile of a returning test names what it did not attempt (the comment
above it says so). `emitSkippedStep`
([session-manager.ts:4265](../../src/server/session-manager.ts#L4265)), which
produces every row a *decision* skips — an untaken chain member, its tail, a
`While` body that never ran — makes no such call. Those rows reach the report,
the wire and the gutter, and never reach the compiler.

**2. The compiler's refusal for a skipped step is the return sentence,
unconditionally.** [live-compile.ts:274](../../src/codebehind/live-compile.ts#L274):

```ts
if (input.status === 'skipped') return SKIPPED_BY_RETURN_REFUSAL;
```

where the constant is `'the step did not run — a return ended its flow'`. When
that line was written a `return` was the only thing that could skip a step
inside a compile, so the sentence was always true.

**3. That sentence doubles as the filing key.**
[live-compile.ts:569](../../src/codebehind/live-compile.ts#L569):

```ts
if (refusal === SKIPPED_BY_RETURN_REFUSAL) {
  this.skippedByReturn.push(at + 1);
```

`skippedByReturn` is what the summary's `notAttempted` list is built from
([live-compile.ts:890](../../src/codebehind/live-compile.ts#L890)), and one of
the four things that decide whether a compile is reported as "already
compiled, nothing to do"
([live-compile.ts:896](../../src/codebehind/live-compile.ts#L896)): a compile
that attempted nothing *because a return skipped the rest* is work still
owed, not a no-op.

Put together: the only way to get the untaken branch into the summary today is
to offer it (fact 1), at which point the compiler would file it under the
return sentence (facts 2 and 3) and the per-step line in the compile output
would read *"skipped — the step did not run — a return ended its flow"* for a
step that no return touched. That is why the offer was **not** added in
PR #138: the one-line fix produces a summary that is wrong, which is worse than
one that is silent.

## Why this matters more than a missing count

- **"Already compiled" can be claimed for a file that is not.** The
  nothing-to-do verdict at [live-compile.ts:896](../../src/codebehind/live-compile.ts#L896)
  treats a run that attempted nothing as a no-op unless a stop, an abort or a
  return explains it. Compile the fixture once with Cash ticked, then again
  with Cash still ticked: the second compile attempts nothing (every step that
  ran already has an entry), the untaken branch is not on any list, and the
  verdict is "already compiled" — for a file whose `Pay by card` section has
  never been compiled at all. Filing the branch under the return list would
  fix the verdict and break the sentence; it needs its own cause.
- **The author's next action.** The point of the "not attempted" line is to
  tell the author what to do next. For a return, nothing — the skipped steps
  were meant to be skipped. For a decision, something — run the file the other
  way and compile again, or compile the section on its own. The two need
  different sentences because they ask for different things.
- **Loops are refused, chains are not.** A file with a runtime loop is refused
  by compile up front (decision 12 of the control-flow story), so this is
  specifically the chain case, and chains are the commonest control line.

## What a fix looks like

Three coupled pieces, none large, all in one PR.

1. **Give the refusal the cause.** A decision-skipped `StepResult` already
   knows why it was skipped (`skipReasonFor` in
   [control-runtime.ts](../../src/runner/control-runtime.ts); the wire event
   carries `skipKind: 'not-taken'`). Put that on the result the compiler is
   offered, and have `generationRefusal` answer with a second constant for it
   — the CLI's wording, *"the step did not run — the run decided against this
   branch"* — keeping the return sentence for a return.
2. **File by cause.** A second list beside `skippedByReturn` (or one map keyed
   by cause), so `notAttempted` is the union and the headline can say both
   halves when both happened: *"6 step(s) as code; 4 not attempted (the run
   decided against them)"*. Keep `notAttempted: number[]` as it is so
   TestBench needs no change; a per-cause breakdown, if wanted, is an optional
   addition to the summary shape. Decide explicitly whether a decision skip
   blocks "proven" — it should not, for the same reason a return skip does
   not: a step that did not run is not evidence against the entries that did.
3. **Offer the rows.** In `emitSkippedStep`, the same `liveCompile.offer` the
   return path makes at line 5865, with the same guard it relies on: a step
   that already has a code-behind entry is left exactly as it was — not
   re-generated, not marked stale, not marked unproven — because a branch not
   taken this run says nothing about the code in it.

Then replace the sentence in the control-flow story's §"What the build showed"
that records this gap.

## Tests that would pin it

- `generationRefusal` unit: a skipped result with the decision cause returns
  the decision sentence; with the return cause, the return sentence; the two
  constants differ.
- Seam test through the real HTTP entry (`tests/api-server-compile-mode.test.ts`
  pattern): Run & Compile of the fixture above with Cash ticked → the four
  `Pay by card` steps appear in `notAttempted`, the per-step `generate` events
  for them carry the decision sentence, no generation call is made for them,
  and the two `Pay with cash` steps compile. The same file with Cash unticked →
  the mirror. A file with a `return` → still the return sentence. A file with
  both → both, kept apart.
- Existing-entry case: compile once with Cash ticked, then once with Cash
  unticked; the first compile's entries survive the second untouched and are
  not reported stale.
- The CLI compile's summary and the server's read the same for the same
  fixture.

## Rollout

Server-side only (`src/codebehind`, `src/server`). No `testbench-native`
change unless the summary shape gains a field, so no extension bump; live on
the next `:3100` restart.

## Resolution

Fixed as decision 12 of
[stories/codebehind-loops-and-conditions.md](../../stories/codebehind-loops-and-conditions.md),
in the three pieces §"What a fix looks like" named — and with the loop case
folded in, because that story also lifted the loop refusal the third bullet of
§"Why this matters" leaned on, so a `While` that runs no passes now reaches the
same path as an untaken branch.

1. **The cause travels on the offer, not in prose.** `LiveStepInput.skipped`
   is `'return' | 'decision'` (src/codebehind/live-compile.ts). The return
   path's offer passes `'return'`; `emitSkippedStep` passes `'decision'`.
   `generationRefusal` answers `SKIPPED_BY_DECISION_REFUSAL` — *"the step did
   not run — the run decided against it"* — for a decision and keeps
   `SKIPPED_BY_RETURN_REFUSAL` for a return, with an absent cause still read
   as a return (the only producer there used to be).
2. **Filed by cause.** A decision skip lands in its own list,
   `skippedByDecision`, netted against `writtenKeys` exactly as the return
   list is (a body line one pass skipped and another compiled owes nothing),
   unioned into `notAttempted`, and counted in the "already compiled" verdict:
   a file whose only uncompiled steps sit in an untaken branch is `partial`,
   not `green`. `notAttempted` stays `number[]`, so TestBench needed nothing.
   A decision skip does not block anything else: a step that did not run is
   not evidence against the entries that did.
3. **The rows are offered.** `emitSkippedStep` calls `liveCompile.offer` with
   the row, the snapshot and `skipped: 'decision'`. A step that already has an
   entry — of any kind — is left exactly as it is: not generated, not stale,
   not unproven, not kept, not named. It counts in `totalSteps` and nowhere
   else. A condition line in the untaken branch with no entry is named too,
   unless another visit of it was observed and generated.

Pinned by `tests/codebehind-live-compile.test.ts` ("a skipped row carries its
cause") and, through the real HTTP entry,
`tests/api-server-loops-compile.test.ts` ("steps a decision skipped": a `While`
that runs no passes, an untaken branch beside a return-skipped step with an
existing entry left alone, and a file whose only uncompiled steps are an
untaken branch) and `tests/api-server-control-flow.test.ts` ("compiles a chain,
its model-decided condition included").

Not done here: the CLI compile's summary and the server's reading the same for
the same fixture — the boxed pipeline is Stage C of the same story.

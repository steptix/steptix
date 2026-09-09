# Sections: run a body step, and resume inside one

Two authoring gaps left open when inline sections landed. Both are the same
complaint from the user's chair: **a step inside a `### Section` is a
second-class step.** You can't select it and run it, and when it fails you
can't pick up where it stopped.

```markdown
## Steps

1. Open the shop
2. Sign in            <- calls the section
3. Check out

### Sign in

1. Type the username
2. Press submit       <- select this line and press Run...
3. Dismiss the banner <- ...or fail here and press Continue
```

Today, selecting "2. Press submit" and pressing Run refuses with TB025. And
when "3. Dismiss the banner" fails, Continue re-runs `Sign in` from the top —
logging in again before retrying the step you were looking at.

Companion to [inline-sections-runtime.md](./inline-sections-runtime.md) (the
execution/decoration/debug-parity spec these two gaps were carved out of),
[inline-sections-authoring.md](./inline-sections-authoring.md),
[resume-position-anchor.md](./resume-position-anchor.md) (the anchor this
extends), and [debugging-ux.md](./debugging-ux.md). The cross-package rules it
amends live in
[stories/test-script-sections-contract.md](../../../stories/test-script-sections-contract.md)
— §9 below is the amendment, and it lands **before** any implementation.

## 1. Background — why both are refusals, not bugs

Neither gap is an oversight. Both are load-bearing guards that were correct
for the shape sections shipped in, and both now need replacing rather than
deleting.

### 1.1 Running a body line

`resolveRunLines` ([runner-core/src/step-lines.ts:402](../../../runner-core/src/step-lines.ts#L402))
is main-flow-only by construction: body lines classify as `section-step`, so
the filter never sees them. A selection inside a body therefore resolves to
"every main-flow step at or below this line" — and because bodies are defined
*below* the main flow, that is the empty list.

The empty list is also the literal "run everything" convention, so
[run-controller.ts:1466](../../src/extension/run-controller.ts#L1466) has to
tell the two apart and refuses with TB025 rather than silently running the
whole test against a live session. The refusal is right. What is missing is
the third answer: *run the body steps the user actually selected.*

### 1.2 Resuming inside a body

On `step:fail`, [extension.ts:487-499](../../src/extension/extension.ts#L487)
parks the resume marker at `root.testLine` — the **top-level invocation** line
— for any failure inside a frame. That is exactly right for a skill (the
server cannot re-enter a skill body mid-way from a bare Continue) and exactly
wrong for a section, whose body is visible in the test file and whose steps
are what the author is iterating on.

The server already supports the anchor this needs. `startAt` with exact-line
matching into a test-file section body is implemented and tested
([session-manager.ts:2511](../../../src/server/session-manager.ts#L2511) —
`anchorNeedsExactLine`, and `stepAtAnchor` just below it, which resolves a
line through frame ancestry). The client simply never sends it from Continue:
both resume consumers compute `extractSteps(...).filter(line >= startLine)`
([commands/index.ts:290](../../src/extension/commands/index.ts#L290) and
[:626](../../src/extension/commands/index.ts#L626)), which is main-flow-only
and therefore empty for a body line — landing in `refuseStaleResume`, whose
doc comment already describes this exact hole.

So: **no server work.** Both gaps are runner-core + testbench-native.

## 2. Goals

1. A selection confined to section-body step lines runs those steps, through
   every gesture that runs main-flow steps: Run Selected, "Run This Step" from
   the line-number context menu, and Step Into from idle.
2. A `step:fail` inside a top-level section body parks the resume marker on
   **the failed body line**, and Continue resumes from that step — the rest of
   the body, then the rest of the test after the invocation.
3. Both survive the user editing the file before pressing Continue, to the
   same standard [resume-position-anchor.md](./resume-position-anchor.md) set
   for main-flow resumes.
4. A resume marker we do **not** know how to resume still refuses. The current
   refusal exists because a dropped stream leaves a marker behind; that hazard
   is unchanged and must not be widened by this work.
5. Every existing non-sectioned behaviour, and every existing main-flow
   selection, is byte-identical. In particular `runLines([])` still means the
   main flow and nothing else.

## 3. Non-goals

- **Sections inside skill files.** A `### Name` in a skill `.md` still refuses
  both re-run flows (runtime spec §7, `sectionedSkillRefusal`), because line
  anchors into a skill file fall back to nearest-line matching. Unchanged here
  and still deferred with the ancestor-line redesign.
- **Nested sections.** A section invoked from inside another section or from a
  skill keeps today's behaviour: the resume marker parks on the top-level
  invocation. The gate is the existing `parentId === null` in
  `recordSkillFailure` ([run-controller.ts:541](../../src/extension/run-controller.ts#L541)),
  reused rather than re-derived.
- **Wrapped body steps.** A body list item that wraps onto following lines is
  already truncated to its first physical line by `extractSections`, so the
  `sections` payload of an ordinary Run All already carries the truncation.
  Running one directly is no worse and no better. `findWrappedStepLines` still
  has no production consumer; wiring it belongs to
  [issues/036](../../../issues/036-wrapped-main-flow-steps-truncated-on-the-testbench-path.md),
  not here.
- **Restoring per-step cache hits on a section resume.** §7 explains the cost
  we accept instead.

## 4. Design — running a body step

### 4.1 The selection rule

One new runner-core export decides what a selection means. It answers with a
**scope** as well as a line list, because "these lines" and "these lines, and
they are body lines" are executed differently:

```ts
// runner-core/src/step-lines.ts
export type RunScope = 'main-flow' | 'section-body';

export interface RunSelection {
  scope: RunScope;
  /** 1-based lines to execute, ascending. */
  lines: number[];
}

export function resolveRunSelection(
  text: string,
  requestedLines: number[],
): RunSelection;
```

Resolution order, and the reason each rung sits where it does:

1. `requestedLines` empty → `{ scope: 'main-flow', lines: <every main-flow
   step line> }`, which is what `resolveRunLines` returns today for the empty
   request. "Run everything" is unchanged and still means the main flow.
2. Any requested line classifies `step` → `{ scope: 'main-flow', lines: <those
   step lines> }`. **Body lines in a mixed selection are dropped.** A drag from
   the main flow down through a `### Login` body would otherwise run the body
   twice — once via the invocation it selected, once inline — which is
   [runtime spec §1.1](./inline-sections-runtime.md)'s original bug wearing a
   selection as a disguise. This rung also makes every selection that works
   today keep working identically, Ctrl+A included.
   Dropped from what *executes inline*, that is. Since
   [stories/data-row-progress-and-selection.md](../../../stories/data-row-progress-and-selection.md)
   the run controller reads those body lines before this rung forgets them and
   narrows the **body the call expands to** — same guard, one less thing
   silently discarded. Three details of that narrowing belong here, because
   they are all about which call is being made: the call may be the *tail* of a
   control line (`If the user is signed out, then Log In`), it may be *nested*
   (a called section's body calling another), and it may sit below a
   breakpoint — a breakpoint trims what runs in this batch, not what the run
   selected, so the narrowing is decided over the un-trimmed list and carried
   across the Continue. The narrowing also travels on the section
   **definition**, so a flow that calls one section twice narrows both frames;
   the run says so rather than leaving it to be noticed from the marks.
   And a selected body step brings the rest of its `If … / Otherwise …` chain
   with it: a chain lives on consecutive body lines, and shipping half of one
   would be refused by the expander in a message that blames the file.
3. Else, any requested line classifies `section-step` →
   `{ scope: 'section-body', lines: <those body lines> }`. This is the new
   capability, and it activates only when the selection is *entirely* inside
   bodies — which is the gesture the gap describes.
4. Else, fall back to main-flow steps at or below `min(requestedLines)` —
   today's "clicked a heading, run from here" behaviour, unchanged.
5. Else `{ scope: 'main-flow', lines: [] }`, and the caller raises TB025.

`resolveRunLines` stays exported with its current signature and semantics; it
becomes `resolveRunSelection(...)` narrowed to the `main-flow` scope —
returning `[]` for a `section-body` answer — so the frozen signature keeps its
meaning and no caller outside the run path has to learn about scopes. That
narrowing is byte-identical to today's behaviour, not merely close to it:
sections are defined below the main flow inside the `## Steps` span, so a
body-only selection's rung-4 fallback ("main-flow steps at or below the lowest
selected line") was already, always, the empty list.

`classifySelectedSteps` gains a trailing optional `scope: RunScope =
'main-flow'`. In `section-body` scope it selects from `extractSections`' body
steps instead of `extractSteps`, applies the same `[input:]` / `[interactive]`
classification, and returns them in document order. Trailing and defaulted so
every existing call site compiles unchanged.

Selecting body lines from **two different sections** is allowed and runs them
in document order. There is nothing to disambiguate — see §4.2.

### 4.2 Body steps run detached, at the root frame

A selected body step is sent as an ordinary step: its instruction text, its
own body line in `sourceLines`, no `startAt`, no synthesized invocation.

This is sound because of what a section *is*. From the language story: a
section is a macro, not a function — it shares the scope of the frame that
defines it and declares no parameters or outputs. A body step is not
interpolated at expansion time; its `{{param}}` references resolve at runtime
against the same `resolvedParameters` a main-flow step sees, and any `${...}`
outputs come from `session.outputs`, which lives on the server session and
survives across requests. So running the body line at the root frame gives it
the identical variable environment it would have had at the call site.

The `sections` map is still sent (it is rebuilt from the live buffer on every
request), so a body step that is itself a bare-name call to a sibling section
expands and pushes its frame exactly as it would in a full run. The expander's
existing cycle guard covers a body step that names its own section.

The rejected alternative is anchoring through a call site — send the
invocation line with `startAt`/`endAt` bracketing the body line, the way
"re-run a skill step with its variables" does. It gives a real `section:`
frame in the Call Stack, and it costs more than that is worth:

- it needs a call site, so a section not yet wired into the main flow — the
  most likely thing to be authoring — could not be run at all;
- with the section invoked twice, `endAt`'s documented keep-last rule spans
  **both** invocations for a one-line range, so "run this one step" would run
  it twice;
- `startAt` forces the per-step cache off for the whole request (§7), which
  the detached path does not need.

The visible cost of going detached is that the Call Stack shows no section
frame for such a run, and the Variables panel shows the test scope rather than
a `section:` heading. Both are honest: nothing invoked the section.

### 4.3 What changes in `run-controller.ts`

`runLines` swaps `resolveRunLines` for `resolveRunSelection`, threads the
resulting `scope` into `classifySelectedSteps`, and keeps every other line of
the method as it is. Specifically unchanged:

- the TB025 guard, which still fires on `lines.length > 0 && resolved.length
  === 0` — now meaning "the selection named no step line of *either* kind, and
  no main-flow step sits below it";
- `trimAtBreakpoint`, which operates on the classified list and so honours a
  breakpoint sitting on a selected body line. The server skips test-file
  breakpoints for root-frame steps (runtime spec §6), and a detached body step
  *is* a root-frame step, so there is no double trigger;
- `fullSteps`, which stays main-flow (`extractSteps`) so the cache bundle hash
  keeps its identity across every batch of the document. A detached run is
  therefore a subset batch, which is what it is.

### 4.4 TB025's new wording

The code stays; its `fix` text is now false and must change.

```ts
TB025: () => ({
  diagnosis: 'No runnable step at or below the cursor',
  fix: 'Place the cursor on a numbered step — in the main flow or inside a section body — or use "TestBench: Run All".',
}),
```

## 5. Design — resuming inside a section

### 5.1 A resume point, not a resume line

Today the resume state is a line. A body line is not enough to resume from:
the server needs the **invocation** that body executes under, so it can expand
the section and anchor inside that expansion. So the tracker's marker grows a
companion.

```ts
// active-file-tracker.ts
type ResumeContext = {
  kind: 'section-body';
  /** The invocation this body is running under, or null for a detached run
   *  (§5.2) where nothing invoked the section. */
  callPosition: vscode.Position | null;
};

private breakpointAnchor: { uri: string; position: vscode.Position } | null;  // existing
private resumeContext: ResumeContext | null;                                  // new
```

`setBreakpointStop(uri, line, context?)` is still the one writer: it sets both
or clears both. Everything that already clears the anchor —
`clearBreakpoints`, `clearStatuses`, `reconcile`, `resetAllStateForTests`, run
start — clears the context with it, in the same statement, so the pair cannot
drift apart.

The snapshot keeps exposing a plain `breakpointStop: number | null` derived
from the anchor, so decorations and the webview need no change (the same
property [resume-position-anchor.md §4.1](./resume-position-anchor.md)
preserved). A new `resumeContextFor(uri)` returns `{ kind, callLine }` for the
two Continue consumers.

**The context is the discriminator.** A body-line marker *with* a context is a
pause we know how to resume; a body-line marker *without* one is the stale
marker `refuseStaleResume` exists for — a dropped stream, a restarted server —
and still refuses. That replaces today's heuristic ("the resume list came out
empty, so this must be stale"), which cannot tell the two apart and so refuses
both.

### 5.2 Who sets it

Four producers. Two reach the tracker directly (they run in the event router);
two reach it through the existing `breakpointStop` host message, which widens
by one optional field:

```ts
// runner-core/src/protocol.ts
export interface HostBreakpointStopMsg {
  type: 'breakpointStop';
  line: number | null;
  /** Set only when `line` is a section-body line and we know how to resume
   *  from it. Absent means the marker is a plain main-flow resume point (or,
   *  on a body line, one we cannot resume — see §5.1). */
  resumeContext?: { kind: 'section-body'; callLine: number | null };
}
```

The webview ignores the new field; `applyToTracker` forwards it to
`setBreakpointStop`'s third argument.

- **`step:fail` inside a section frame** ([extension.ts:487](../../src/extension/extension.ts#L487)).
  The needed pair is already captured: `recordSkillFailure` parks
  `SkillFailure { kind: 'section', skillLine: <failed body line>, testLine:
  <invocation line> }`, gated to `parentId === null`. So the branch becomes:
  when the controller's parked failure has `kind === 'section'`, park
  `setBreakpointStop(root.testUri, failure.skillLine, { kind: 'section-body',
  callPosition: failure.testLine - 1 })`. Skill failures keep parking on
  `root.testLine` with no context — unchanged.
- **`step:awaiting` in a section frame** ([extension.ts:443](../../src/extension/extension.ts#L443))
  already paints the arrow on the body line, because `targetUriFor` resolves a
  section frame to the test file. It gains the context, from the same
  `frameRoot` lookup. While the stream is open Continue still goes through
  `sendRunControl`, so this changes nothing in the happy path — it only means
  that if that stream drops, the marker left behind is resumable instead of
  stale.
- **A user Pause inside a section frame** ([run-controller.ts:1745](../../src/extension/run-controller.ts#L1745)).
  The pause path is the odd one out: it does not read a parked failure, it
  reads the live frame stack, and its existing rule is "if we are inside any
  frame, resume at that frame's root invocation line." So it needs its own
  branch rather than reuse of the failure capture.

  The branch fires when the top frame is a **top-level section frame defined
  by the test file** (`kind === 'section'`, `parentId === null`, `uri` is the
  test file) *and* `lastStepStartLine` — the line of the most recent
  `step:start`, which is where execution actually was — is a body step line in
  the live buffer. It then resumes at that body line with the frame root's
  `testLine` as the call line.

  Both halves of that condition are load-bearing. `parentId === null` keeps
  nested sections on today's path (§3), and re-checking `lastStepStartLine`
  against the buffer catches the window where the frame has been pushed but
  its first step has not started — there `lastStepStartLine` still points at a
  main-flow line, and anchoring a "body" resume to it would resume the wrong
  step entirely. Either half failing falls back to today's `root.testLine`
  with no context, which is exactly the pre-existing behaviour.

- **A detached body run that trims at a breakpoint** (§4.3). Its context has
  `callPosition: null`: nothing invoked the section, so Continue re-runs the
  remaining body steps of that section detached.

### 5.3 What Continue sends

`continueRun` ([commands/index.ts:270](../../src/extension/commands/index.ts#L270))
gains one branch ahead of its existing main-flow one. When
`resumeContextFor(uri)` is a `section-body` context with a `callLine`:

```ts
const resumeLines = extractSteps(text)
  .map((s) => s.line)
  .filter((line) => line >= callLine);       // the invocation, then the rest

controller.runLines(resumeLines, {
  breakpoints,
  skipBreakpointAtStart: true,
  isContinuation: true,
  rerun: { startAt: { uri: testFilePath, line: bodyLine } },
});
```

The server expands the invocation into the whole body, then the main-flow
steps after it, and `startAt` in exact mode anchors at the failed body step —
so execution is "retry the failed step, finish the body, carry on with the
test." Which is what Continue means everywhere else.

Sending the invocation line **and everything after it** (rather than the
invocation alone) is what makes this a resume rather than a section re-run,
and it also disambiguates a section invoked twice: the first exact match in
the expansion is inside *this* invocation, because the expansion starts at it.

When `callLine` is null (detached), Continue re-runs the enclosing section's
remaining body steps at or after `bodyLine`, in `section-body` scope. No
`rerun`, no anchor — the same shape as the run that produced the pause.

`dispatchStep` ([commands/index.ts:626](../../src/extension/commands/index.ts#L626))
takes the identical branch, with its `stepMode` threaded through. It is the
second consumer the resume-position-anchor spec had to name explicitly, and it
is the one that gets missed.

**One `rerun` per run, not per block.** `runStepBlock` currently receives
`options.rerun` on every block it sends, which is invisible today because
every re-run flow sends exactly one step. A Continue whose tail contains an
`[input:]` or `[interactive]` step splits into several blocks, and re-sending
`startAt` on block 2 would make the server look for the body line inside an
expansion that no longer contains it and refuse with "Re-run anchor not
found". So `runLines` consumes `rerun` on the first block it dispatches and
drops it for the rest.

### 5.4 Surviving an edit

`maintainAnchor` ([active-file-tracker.ts:426](../../src/extension/active-file-tracker.ts#L426))
runs `shiftAnchorForChanges` over the anchor. It now runs it over the call
position too, in the same pass, against the same original coordinates — which
is the whole reason that function takes all of an event's changes at once.

The two positions snap against **different** line sets, because they are
different kinds of step:

- the call position snaps among main-flow step lines (`extractSteps`);
- the body anchor snaps among the body lines **of the section that contains
  it**, from `extractSections`. Snapping among all body lines would let a
  deleted last-step-of-a-section resume point slide into the *next* section's
  body — a different flow entirely, run silently.

If either snap finds no survivor, the whole resume point clears: a body line
with no invocation, or an invocation whose body step is gone, is not something
to guess about. The user gets the existing refusal message and Run All.

### 5.5 What deliberately does not change

- Skill failures and skill pauses: still anchored on the test-file `[skill:
  …]` line, still re-running the whole skill on Continue. The server cannot
  re-enter a skill body from a bare Continue, and the sectioned-skill anchor
  hazard is still open (§3).
- The `step:awaiting` fast path while the stream is open.
- `performStop`'s skill-debug gate, which already consumes only `kind ===
  'skill'` failures.
- `sectionedSkillRefusal`, unchanged in both call sites.

## 6. Edge cases

| Situation | Behaviour |
|---|---|
| Select one body line, Run | That step runs, detached, at the root frame; ✓/✗ paints on the body line |
| Select body lines from two sections | Both run, in document order, detached |
| Selection spans main flow **and** a body | Main-flow steps only — today's behaviour exactly (§4.1 rung 2) |
| Cursor (no highlight) on a body line, Run Selected | Runs everything — `selectionLines` returns `[]` for an empty selection, which has always meant Run All |
| "Run This Step" on a body line | That one body step, detached |
| Body step is a bare call to a sibling section | Expands and pushes a frame, as at any call site |
| Body step's section is never invoked anywhere | Runs anyway — detached execution needs no call site |
| Breakpoint on a selected body line | Client-side trim, "paused at start", nothing sent — same as a main-flow line |
| Body-step failure, then Continue | Retries that step, finishes the body, continues the test after the invocation |
| Pause while a body step is running, then Continue | Re-runs that body step, finishes the body, continues the test |
| Pause after the section frame is pushed but before its first step starts | Falls back to the invocation line, no context — today's behaviour |
| Body-step failure inside a **nested** section | Marker parks on the top-level invocation; Continue re-runs it (unchanged) |
| Body-step failure inside a **skill's** section | Unchanged; skill-anchored flows still refuse |
| Section invoked twice, failure in the second | Resume anchors inside the second — the sent range starts at that invocation |
| Edit above the resume point, then Continue | Both positions shift; the same step resumes |
| Delete the failed body step, then Continue | Anchor snaps to the next body step *of the same section* |
| Delete the whole section body, then Continue | Resume point clears; refusal message, Run All |
| Delete the invocation, then Continue | Resume point clears (no call position survives) |
| Body-line marker with no context (dropped stream) | Refuses, exactly as today |
| Continue with a main-flow marker | Untouched path, byte-identical |

## 7. Costs we are accepting

**A section resume runs with the per-step cache off.** `startAt` sets
`isPartialRerun` on the server, which force-disables the cache for the whole
request ([session-manager.ts:2204](../../../src/server/session-manager.ts#L2204)).
That rule exists because a partial re-run may carry edited variables, and a
cache hit would replay a frozen plan and ignore them. A Continue carries no
edits, so the disable is stricter than necessary — but the alternative is a
new "anchored but not edited" mode on a public field, for a run that is
already the slow path by definition (something just failed). Revisit only if
resume latency becomes a complaint.

**A detached body run gets no section frame.** No Call Stack row, no
`section:` heading in Variables. Nothing invoked the section, so inventing a
frame would be a lie about what ran. §4.2 has the alternative and why it costs
more.

**Detached body steps cache under a root-frame key.** Per-step keys are
`${frameId}-${line}`, so a detached run of body line 17 writes `-17` while a
full run writes `f2-17`. They never collide, and they never share — a detached
run cannot hit an entry a full run wrote, or vice versa. That is a miss, not a
correctness problem, and it is the same shape as
[issues/037](../../../issues/037-per-step-cache-key-shifts-between-full-and-subset-batches.md).

## 8. Testing

### runner-core (`node --test`)

`resolveRunSelection` against the `fixtures/sections/` classification fixture:

- empty request → `main-flow`, `[]`
- main-flow lines only → `main-flow`, those lines
- body lines only → `section-body`, those lines
- **mixed selection → `main-flow`, body lines dropped** (the rung-2 guard; a
  test that fails loudly if the order is ever flipped)
- body lines from two sections → both, document order
- a line naming nothing, above the last main-flow step → the at-or-below
  fallback
- a line naming nothing, below every main-flow step → `[]`
- `resolveRunLines` output unchanged on every one of the above

`classifySelectedSteps(text, lines, 'section-body')` classifies `[input:]` and
`[interactive]` markers on body lines.

### testbench-native unit (`tests/anchor-shift.test.js`)

The shift math already lives in a vscode-free module; extend it:

- insert above → both positions shift
- delete the failed body step → body anchor snaps to the next body step
- delete the last body step of that section → resume point clears (it must
  **not** snap into the next section's body)
- delete the invocation line → resume point clears
- edit the failed body line's wording in place → both positions unmoved

### testbench-native integration (`suite/sections.test.cjs`)

Three existing tests assert the refusals this spec replaces and must be
rewritten, not deleted — each keeps a sibling that pins the hazard it was
guarding:

| Existing test | Becomes |
|---|---|
| "refuses to run from a cursor parked on a body line" | "runs the selected body step detached" — asserts one request, `steps` = the body instruction, `sourceLines` = the body line, no `startAt`. Plus a new sibling: a **mixed** selection still sends main-flow steps only. |
| "Continue refuses a stale pause marker parked on a body line" | Split in two: with a context → resumes (asserts `startAt`, and that `steps[0]` is the invocation); without a context (set directly, as a dropped stream would leave it) → still refuses and clears. |
| "Step from a stale body-line marker refuses too" | The same split, through `stepOver`. |

New cases:

- a body-step failure parks the marker on the **body** line, not the
  invocation line;
- Continue after it sends `startAt = { testFile, bodyLine }` and a `steps`
  list beginning at the invocation and running to the end of the main flow;
- a section invoked twice, failing in the second: the sent range starts at the
  second invocation;
- a nested section failure still parks on the top-level invocation;
- a Continue whose tail contains an `[input:]` step sends `startAt` on the
  first block only;
- **Pause** during a body step parks the marker on that body line with a
  context, and Continue resumes from it;
- Pause with the section frame pushed but no body `step:start` yet parks on
  the invocation line with no context (the pre-existing fallback).

### Live (`live/sections.test.cjs`)

One end-to-end: run a single body step against a live session and assert it
paints ✓ on the body line; then fail a body step and Continue, asserting the
steps before the failure do not re-execute.

## 9. Contract amendment

Applied to
[stories/test-script-sections-contract.md](../../../stories/test-script-sections-contract.md)
**before** any code lands, per that document's own rule.

**§4 Frozen signatures** — add:

```ts
// runner-core/src/step-lines.ts
// What a user's line selection means. `scope` is part of the answer because
// body lines and main-flow lines execute differently (see
// testbench-native/stories/specs/sections-run-and-resume.md §4.2).
// Resolution order is fixed: main-flow matches win over body matches, so a
// selection spanning both runs the main flow only and never double-runs a
// body.
export type RunScope = 'main-flow' | 'section-body';
export function resolveRunSelection(
  text: string,
  requestedLines: number[],
): { scope: RunScope; lines: number[] };
```

**§5 Consumer split** — the "main flow only" bullet is amended. Replace:

> - **main flow only** — `extractSteps`, `resolveRunLines`,
>   `classifySelectedSteps`, `nearestStepAtOrBelow|Above`. These are
>   runner-core's API.

with:

> - **main flow only** — `extractSteps`, `resolveRunLines`,
>   `nearestStepAtOrBelow|Above`. These are runner-core's API. `resolveRunLines`
>   keeps this contract precisely so `runLines([])` cannot grow a body step.
> - **main flow, or body — the caller says which** — `resolveRunSelection`
>   (new) and `classifySelectedSteps`, whose trailing `scope` argument defaults
>   to `'main-flow'` so every existing call site keeps the old contract.
>   `resolveRunSelection` is the only function permitted to choose the scope,
>   and it chooses `'section-body'` only for a selection that names body lines
>   and no main-flow line.

**§7 Consumption checklist** — add under **Shapes**:

> - [ ] a selection spanning main flow and a body resolves to `'main-flow'`
>       (never runs a body inline alongside its own invocation)
> - [ ] `startAt` into a test-file body line is accompanied by a `steps` list
>       that **begins at that body's invocation** — an anchor sent with a
>       narrower range can match a different invocation of the same section

## 10. Implementation checklist

- [x] Contract amendment (§9) applied before any implementation.
- [x] `runner-core/src/step-lines.ts`: `RunScope`, `resolveRunSelection`,
      `resolveRunLines` re-expressed on top of it, `classifySelectedSteps`
      scope arg. Export from `index.ts`.
- [x] `runner-core` tests for all of §8's `resolveRunSelection` rows.
- [x] `errors.ts`: TB025 `fix` text (§4.4).
- [x] `run-controller.ts`: `resolveRunSelection` in `runLines`; scope threaded
      to `classifySelectedSteps`; `rerun` consumed by the first block only.
- [x] `active-file-tracker.ts`: `resumeContext`, the `setBreakpointStop`
      third argument, `resumeContextFor`, dual-position shift in
      `maintainAnchor`, clears in every existing clear path.
- [x] `step-lines.ts` (native): body-line snap helper for `maintainAnchor`.
- [x] `protocol.ts`: `HostBreakpointStopMsg.resumeContext`.
- [x] `run-controller.ts`: the user-Pause branch (§5.2) and the detached-run
      breakpoint trim, both posting `resumeContext`.
- [x] `extension.ts`: park the context on `step:fail` (section kind) and
      `step:awaiting` (section frame); forward `msg.resumeContext`.
- [x] `commands/index.ts`: the section-resume branch in **both** `continueRun`
      and `dispatchStep`; `refuseStaleResume` re-gated on "no context".
- [x] Unit + integration + live tests (§8), including the three rewritten
      refusal tests.
- [x] Bump the patch version in `testbench-native/package.json` — this touches
      bundled extension code and `runner-core` both.
- [x] Update [inline-sections-runtime.md](./inline-sections-runtime.md) §2's
      non-goal list and §6, which currently say body lines are never in the
      runnable list.

## 11. Open questions (deferred)

- Should a detached body run show a synthetic `section:` label in the
  Variables panel, given no frame exists? v1 shows the test scope, unlabelled.
- Should Continue tell the user it moved the resume point when a snap
  happened? The same question
  [resume-position-anchor.md §8](./resume-position-anchor.md) left open for
  main-flow resumes; answer both together or neither.

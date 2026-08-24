# Compile as you go

Builds on [codebehind-compile.md](codebehind-compile.md), which shipped the
compile pipeline, and [codebehind-compile-as-a-run.md](codebehind-compile-as-a-run.md),
which made a compile look and behave like a run. This story changes *when*
the pieces happen: recording and generation ride the run the author was doing
anyway, and the Replay rounds go away — the author's own next run is the
replay. Nothing about the `.steps.ts` format, the binding rules, the
generation prompts, the secret-leak guard, or the diff → Apply flow changes.

## What we're building

Two things, one idea: stop running the test extra times on the compiler's
behalf.

**Run & Compile** — a run mode, next to Run. The test runs once, exactly as a
run: same session, same browser window, same gutter marks; breakpoints, Stop
and Pause all work. As each step finishes, its transcript is turned into a
code-behind entry in the background while the browser moves on to the next
step. When the run ends, the usual diff opens with every entry the run
produced. There is no separate Record. There are no Replay rounds. The
entries are unproven, and that is fine: the next ordinary Run proves each one
(`</>` in about a second) or flags it ⚠ stale — the loop that already handles
entries that rot.

**Compile This Step** — reworked from "a full compile with S = {k}" into the
surgical version: right-click a step in the gutter and *that step runs now*,
in the document's live session, from whatever page the session is sitting on.
That fresh one-step run is the recording — any recording the step already had
on disk is discarded, never reused. One generation call, and the diff opens
for the one entry. If the clicked step is a `### Section` or `[skill:]` call,
the whole body it expands to runs and compiles, in order — section entries
into the test's own `.steps.ts` under their section scope, skill entries into
the skill's file, exactly where a whole-test compile would put them.

Example. The author has `tests/checkout.md`, nine steps, none compiled yet.
They press **Run & Compile**:

```
Run & Compile checkout.md
  ✓ step on line 12  4.1s
             step 1 entry generated
  ✓ step on line 13  2.3s
             step 2 entry generated
  ✓ step on line 14  2.8s
             step 3 entry generated
  ✓ step on line 15  3.0s
  ✗ step on line 16 — "Add to cart" button not found
             step 4 entry generated
  Review     revised checkout.steps.ts

◐ Compiled checkout.md: 4 step(s) as code (unproven — the next run proves
  them). Step 5 failed under AI; steps 6–9 not attempted.
```

The diff opens for steps 1–4; they Apply, fix the button label on step 5, and
press **Run & Compile** again. Steps 1–4 run as their entries — `</>` lands,
they are now proven, nothing regenerates them — and 5–9 run under AI and
generate. Second diff, Apply, done. The test ran exactly twice, and both were
runs the author wanted to watch anyway. Compare today's cost for the same
outcome: two full Records, plus two-to-eight Replay passes.

Example, the surgical one. A later run flags step 7 ⚠ — the entry broke when
the promo-code field moved. The author runs to a breakpoint on step 7 (or
just watched the run heal it under AI, leaving the browser sitting on
`/cart`), rewords the step, right-clicks it → **Compile This Step**:

```
Compile step 7 of checkout.md
  Record     running step 7 in this session (page: /cart)
             ✓ step on line 18  3.9s
  Generate   entry for step 7

◐ Compiled step 7 of checkout.md: 1 step as code (unproven).
```

Seconds, one AI step, one generation call, a one-entry diff. The browser is
now sitting *after* step 7, so compiling step 8 next is a right-click away —
which is also what a multi-step selection does: each selected step, in order,
run-and-compile.

## Context — where the box still is

[codebehind-compile-as-a-run.md](codebehind-compile-as-a-run.md) named the
goal — "most of the time there is no Record at all: the run you just did *is*
the recording" — and shipped the plumbing for it: `compileTest` accepts a
pre-recorded run (`options.recorded`), and the recording lives on disk beside
the test. But nothing supplies that option. Ordinary runs do not capture step
context (`captureStepContext` is set only by the compile's own Record — the
DOM-either-side capture is heavy, so it was never turned on for plain runs),
so there is never a recording to reuse, and every compile still opens with a
full AI run of the test. Then Replay spends one to four more browser passes
proving entries the author is going to re-run tomorrow anyway.

Compile This Step is the same box with a smaller label. It is a full compile
with S = {k}: the whole test records first — under AI with code-behind off
when step k already has an entry, the most expensive possible path — then the
whole test replays. And it refuses outright on any step below a `### Section`
or `[skill:]` call, because the pipeline needs an *expanded* step number and
the authored line no longer tells it one.

Meanwhile proof-by-next-run is already in the product's vocabulary. A partial
compile proposes unproven entries; the summary says which they are; the next
run proves each (`</>`) or flags it (⚠ stale, sidecar and report); the
default selection picks the flagged ones up. Replay's whole job is to move
that proof a few minutes earlier, and it pays browser passes for it. This
story stops paying.

## Design

### Run & Compile

A new TestBench command, `testbench-native.runAndCompile`, beside Run in the
panel and the command palette. It is a run first: it goes through the same
run machinery, appears in `GET /sessions` as a run, paints the gutter,
honours breakpoints, Pause and Stop. The step request carries one new flag,
`compile: 'run'`, and that flag means three things server-side:

- **Capture is on.** The run records — `captureStepContext` — and writes the
  recording beside the test when it ends, as a compile's Record does today.
  The write-on-run-end mechanism already exists (`session-manager.ts` writes
  the recording whenever a request captured context); this turns it on.
- **Entries still serve their steps.** A step with a working entry runs as
  code, exactly as in a plain run, and is *not* regenerated — it needs no
  transcript because its code already is the answer. Steps with no entry, or
  whose entry throws and heals under AI, run under AI and produce the
  transcript generation needs. This is the compile's default selection
  ("no entry, or flagged stale") falling out of run behaviour for free.
- **A trailing generator follows the run.** When step k finishes under AI,
  its generation call is queued; the browser does not wait — step k+1
  executes while k generates. The queue is serialized, one generation at a
  time in step order, because entry k reads the candidate file as it stands
  and may reuse a helper entry k−1 introduced — the same reason Generate is
  sequential today. The run never blocks on the queue; at run end the queue
  drains, the Review pass runs over each touched candidate file (unchanged
  prompt, `authoring` profile), and the proposed files go back on the wire.

A generation failure does not stop the run, unlike today's Generate phase
where an error fails the whole compile. Here the step stays AI, a note says
why, and the run continues — a run must not fail over its own bookkeeping.
The declined cases are unchanged (bracket-marker steps, framework actions,
no page actions, unresolvable env refs): declined steps become `ai: true`
entries with the reason, as today.

Stop and failure compose the way "write what passed" already composes: a run
stopped or failed at step k proposes the entries for what finished before it,
and the summary names what was not attempted. Cache is the project's setting,
as a Record in the caller's session is today — a cache-served step's
transcript is still a transcript.

### Compile This Step

The command keeps its id (`testbench-native.compileStepCodeBehind`) and its
gutter spot, and stops being a whole-test compile. Right-click resolves the
clicked line to the authored step; the extension needs a session for the
document — the active one, or it opens one, as the first Run does — and
sends *just the resolved steps* through the ordinary step route with
`compile: 'steps'`, which also disables code-behind for the request — so a
step with a broken entry runs under AI and produces a fresh transcript
rather than being served (or failed) by the code under repair.

Resolving the clicked line:

- **A plain step** resolves to itself: one step, one entry, into the test's
  sibling `.steps.ts`.
- **A `### Section` call** resolves to the section's body: every step the
  call expands to, in order. Their entries carry the section scope and land
  in the test's own file, exactly where a whole-test compile binds them.
- **A `[skill:]` call** resolves the same way, and the entries land in the
  skill's `.steps.ts`, keyed by the skill's authored step text — again where
  a whole-test compile puts them.
- **A multi-line selection** resolves each selected step in order and
  compiles them sequentially — the session advances between steps, so a
  selection is just this flow k times.

The old refusal ("cannot number a step below a skill or section call") goes
away entirely. It existed because the pipeline needed expanded step
*numbers*; this flow binds by what the runtime binds by — the step's authored
text, plus section scope — and the parse's expansion mapping (authored line →
expanded steps and their frames) answers the call-line cases without any
number arithmetic.

The contract on page state is the author's, and it is Run Step Here's
contract verbatim: the step records against wherever the session's browser
is. Run to here, or pause, then compile the step. Invoked cold on a
mid-test step with the browser somewhere else, the step fails or records
the wrong page — visibly, in the window the author is watching, with the
step's own error. That failure proposes nothing for the failed step.

No Review pass on this path. Review is a whole-file consistency edit, and a
one-entry diff that arrives reflowed end to end buries the change the author
asked for. The entry is spliced in (`spliceEntry` — replace the step's
existing entry or append) and the file goes out otherwise untouched.

### The recording: fresh always wins, splice on the small path

If the step already has a recording, discard it. Compile This Step never
generates from what is on disk; the step runs now and the new transcript
replaces the old one. No "reuse the recording from Tuesday?" prompt, no
staleness heuristics.

Mechanically the recording dir (`.aiui-codebehind-cache/<name>.recording/`,
one JSON per step plus DOM files) is today "replaced wholesale by the next
one". A Run & Compile run keeps that rule — it is a full run, its recording
supersedes the old one entirely. A single-step compile cannot replace
wholesale without deleting every other step's recording, so it splices:
overwrite step k's JSON, its before/after DOM files and screenshot, leave
the siblings, and stamp the step with its own `recordedAt`. The spliced
step is matched by the entry's own identity — authored text plus section
scope, the same key the binding uses — never by index: a single-step
request only knows the steps it was sent, not where they sit in the test.
The manifest gains the per-step timestamp so the author can see step 3's
recording is from Tuesday and step 7's from just now. Generation only ever reads the
step's own files, so a mixed-provenance dir changes nothing downstream;
`readRecording` stays tolerant of it.

### Proof, not Replay

Replay, Repair and the confirming round are not part of either path. An
entry is born unproven, and the summary and diff say so. The next run is
the proof: pass as code → `</>`, proven, the sidecar clears; throw → heal
under AI, ⚠ stale with the error, and the default compile selection —
and Compile This Step — pick it up. This is not a new safety model; it is
the rot loop the runtime already runs, doing its job one run earlier.

What is genuinely given up: Apply used to hand over replay-proven code, and
now hands over plausible code one run away from proof. The bet is that the
author was going to run again anyway — and that four browser passes per
compile was the wrong price for moving `</>` a few minutes earlier.

### The model

Generation and Review use the *session's* AiClient — the same client that
drove the run — not a compile-built one. That is the argument
`compile-runner.ts` already makes ("a compile that called a different model
than the run it is compiling would be generating code for a recording it
could not have made") followed one step further: today a session's
`runSettings.model` override applies to Record and Replay but not to
Generate/Repair/Review, which are built from the server base. With
generation riding the session, the override covers everything, and the
asymmetry goes away.

### On the wire

`POST /sessions/:id/steps` gains `compile: 'run' | 'steps'` — two values
because the server behaves differently per mode (Review and a wholesale
recording on `'run'`; no Review, a spliced recording and code-behind
disabled on `'steps'`), and a bare boolean would leave it guessing which
the client meant. The run stream gains two frame types, shaped like the
compile stream's so TestBench's folding code carries over:

- `compile:step` — an entry was generated, declined, or skipped for a step,
  with the step's line for the gutter.
- `compile:result` — terminal, after the queue drains (and Review, on the
  Run & Compile path): proposed content by absolute `.steps.ts` path, plus
  the summary (compiled / declined / unproven / not attempted). The server
  still never writes under the project — proposals ride the wire and
  TestBench applies them through the diff, as today.

The per-test-file compile lock still applies (one compile per file at a
time, `POST /codebehind/compile`'s rule), now covering a Run & Compile and a
single-step compile of the same file too.

`POST /codebehind/compile` — the boxed pipeline, Replay included — stays,
unchanged, as the CLI's `aiui compile` path: headless callers have no diff
to click and no session they are watching, and "record, replay until green,
write" is still the right shape there. TestBench's whole-test **Compile
Code-behind** command and the panel's Compile button become Run & Compile;
the box is no longer reachable from the extension.

## Non-goals

- **Generating from the live DOM before the step executes** — the true
  "author the code first, then run it" variant. Still deferred, as it was in
  compile-as-a-run.
- **Parallel generation.** The trailing queue is serialized on purpose;
  entry chaining is worth more than the seconds.
- **CLI `aiui run --compile`.** Parity is cheap later; the CLI keeps its
  boxed compile for now.
- **Retiring the last-run sidecar or the ⚠/`</>` marks.** They are
  load-bearing here.
- **Changing capture cost for plain runs.** `captureStepContext` stays off
  for ordinary Runs; only a compile-mode request turns it on.

## Acceptance

- Run & Compile on a nine-step test with no entries: one browser pass, no
  Replay; the diff proposes nine entries; the summary marks all unproven.
- The run fails at step 5: the diff proposes 1–4, the summary names 5 as the
  failure and 6–9 as not attempted.
- Steps with working entries run as code (`</>`), are not regenerated, and
  do not appear in the diff.
- A generation error on step 3 does not stop the run; step 3 stays AI with
  the reason; the other entries are proposed.
- The next ordinary Run after Apply proves entries (`</>`) or flags them
  (⚠ stale); a following Run & Compile regenerates only the flagged ones.
- Compile This Step on a plain step, session parked on the right page: only
  that step runs; a one-entry diff opens; no Review reflow of the rest of
  the file.
- Compile This Step on a `### Section` call compiles the section's body, in
  order, into the test's file under the section scope; on a `[skill:]` call,
  into the skill's file.
- A step below a section or skill call compiles without the old refusal.
- A multi-line selection compiles each selected step in order in the live
  session.
- The step's prior recording is discarded: after the compile, its JSON and
  DOM files in the recording dir are from the fresh run, the siblings are
  untouched, and the manifest shows per-step timestamps.
- No session open: Compile This Step opens one, as Run does.
- A session `runSettings.model` override applies to the generation calls,
  not just the run.
- Secrets: the recording redaction and the inlined-value guard behave as
  today on both paths.

## What was built

Everything above, in one pass. Where the build deviated, and why:

- **The status is `partial`, not `green`, whenever anything compiled.**
  `green` means "the whole test replays as code", and nothing on this path
  proves that. Every entry is born unproven, so a Run & Compile that produced
  entries reports `partial` — which is also what puts ◐ and "the next run
  proves them" in front of the author. `green` is reserved for the one case
  it still describes honestly: nothing needed compiling.
- **`compile:step` never paints the gutter.** The story says the frame carries
  the step's line "for the gutter", which the boxed compile used to paint ▶
  while the model worked. Here the step has already finished and painted ✓ by
  the time its entry is generated, and repainting ▶ would undo that. The line
  still rides the frame — the run log uses it — but TestBench folds these
  frames into the log only.
- **A Stop skips generations that have not started; the in-flight one
  finishes.** The story says the queue drains at run end and says nothing
  about Stop. Draining a full queue after a Stop would keep the author waiting
  on the thing they just cancelled; discarding the in-flight call would throw
  away a model call already paid for. Entries generated before the stop are
  proposed, and the ones skipped are named in `notAttempted`.
- **A single-step compile of a test with no `.steps.ts` proposes a file with
  one entry**, which is the "one-entry diff" the story asks for. Against an
  existing file it proposes the whole file with that entry spliced — the diff
  shows one changed entry, as the story intends, but the wire carries whole
  files because that is what `compile:result` has always carried.
- **The recording's splice identity needed a new field.** `RecordedStep` gains
  `source` (the authored text) and `section` beside the existing
  `instruction`, which is the *expanded* line the runner executed. Matching on
  `instruction` would have failed for any step carrying a `{{param}}`. It also
  gains `recordedAt`, as the story says. All three are optional and
  `readRecording` is unchanged, so a recording written before this reads back
  and splices — falling back to `instruction` for the match.
- **`RunController.compileCodeBehind` was deleted rather than left unreached.**
  The story says the box "is no longer reachable from the extension"; a
  method nothing calls is worse than that, so the client method, its
  `ApiClientLike` declaration and the integration tests that drove it are
  gone. `POST /codebehind/compile` is untouched and is still `aiui compile`.
- **The old `testbench-native.compileCodeBehind` command id stays**, pointed
  at Run & Compile, so the panel button and any keybinding keep working — but
  it is hidden from the palette, where two entries for one flow would only
  confuse.
- **`compile` requires `?stream=1`.** The proposal only exists as a
  `compile:result` frame, and the non-streaming route answers with a
  `StepResponse` that has nowhere to put it. Rather than run the test and
  spend a model call per step on something the caller cannot receive, the
  route refuses with a 400 before anything executes.

Two things the build found that the story had not settled:

- **A compile-mode run needs two code-behind registries.** `'steps'` disables
  execution so a broken entry re-records under AI — but generation still needs
  the binding (target file, section scope, occurrence) for every step. The
  execution registry is empty in that mode, so a second one is built for
  generation alone, silently and against the author's real files.
- **`inScope` in the whole-test prompt has to be decided before the run.** It
  marks which steps the compile means to write, and the prompt has to read the
  same for step 1 as for step 9 — but what step 9 will need is not knowable
  when step 1 is generated. It is decided statically from the registry: a step
  with no entry, and every sent step in `'steps'` mode.

### What the review round changed

A review pass over the first build found eight things. Six were real and are
fixed; two were real and turned out to have a companion the reviewer had not
seen. What that changed in the design:

- **A split run keeps ONE compiler.** The biggest of them. A logical run
  reaches the server as several requests whenever an `[input:]` or
  `[interactive]` step splits it, or a breakpoint ends one batch and leaves
  Continue to send the rest. Each block was getting its own compiler: its own
  candidate, read from a `.steps.ts` nobody had applied yet; its own step
  numbering from 1; and its own wholesale recording write that deleted the
  block before it. The author silently got a diff for the tail of their test.
  The compiler is now retained on the session (`ManagedSession.liveCompile`)
  and every block after the first says so on the wire
  (`StepRequest.compileContinues`). Each block still finishes — drains,
  reviews what it changed, and emits `compile:result` — but the result it
  emits is the accumulated one, so the last block's answer is the fullest and
  a run that dies half way still proposes what it got. Continue inherits the
  compile mode of the run it is continuing, and a Run & Compile that parks at
  a breakpoint holds its diff until Continue finishes rather than interrupting
  the debugging session the breakpoint exists for. A fresh compile discards
  whatever the last one abandoned; so does closing the session.
- **Section-body lines are refused.** Running one on its own runs it
  *detached*, at the root frame, so the entry would be written with no section
  scope — where the runtime, reaching that step through the section's frame,
  never looks, and where a top-level step of the same text would match it
  instead. Compile This Step now points at the call line, which compiles the
  body as a unit. (The acceptance row about "a step below a section or skill
  call" is about document position, and still works.)
- **A repeated step is refused too.** `occurrence` is counted within the
  request, so a lone second "Press Enter" is occurrence 0 to the server and
  its entry would land in the FIRST occurrence's slot — replacing code
  generated from a different step. Measured, not assumed: the same step list
  gives occurrences `[0, 0, 1]` whole and `0` alone. Run & Compile sends the
  whole test and numbers them correctly, so that is what the refusal points
  at. The recording's splice identity gained `occurrence` for the same reason,
  which is what makes a section body that says the same thing twice splice
  correctly.
- **The generation queue is disposable.** `finish` was the only exit, and a
  run that threw between "the compiler exists" and "the compiler is finished"
  left the queue spending model calls with nobody to receive them. There is a
  `dispose` now — skip what has not started, let the in-flight call settle,
  propose nothing — wired to the run's `catch`, to session close, and to a
  fresh compile superseding an abandoned one.
- Four smaller ones: the proposal is no longer wiped by a second Run & Compile
  that the in-progress guard turns away (the reset moved behind the guard, and
  a token decides which call may claim the result); a stop with nothing
  generated no longer logs "every step already has code-behind", which is the
  opposite of what happened; `summary.candidatePath` is populated, so the
  notification's **Open candidate** has something to open; and the review's
  leak guard now sees every parameter the run resolved rather than the last
  eligible step's snapshot.

And one the fix round's own test found, which no reviewer had: a retained
compiler's `emit` still pointed at the SSE stream of the block that created
it, so block 2's `compile:step` frames were written to a response that had
already closed. The summary was right and not one frame arrived. `beginBlock`
now takes the block's stream along with its plan and signal.

Verified by running: root 2881 (vitest, 145 files) including a new HTTP seam
suite (`api-server-compile-mode.test.ts`) and a new unit suite
(`codebehind-live-compile.test.ts`); runner-core 441; testbench-native unit
225 and integration 200. Live through the extension against
`fixtures/test-app`: Run & Compile on `compile-codebehind.md` runs the test
once, generates both entries behind the run, leaves the recording and the
candidate on disk before anything is applied, paints plain ✓ (not `</>` — the
entries are unproven), and the next ordinary Run serves both steps as code;
and Compile This Step on step 2 re-runs that step in the live session, offers
a one-entry diff, and splices the recording — step 2 stamped fresh, step 1
byte-for-byte what it was.

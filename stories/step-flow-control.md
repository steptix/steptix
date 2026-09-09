# Leaving a flow early: `If … then return` / `… then stop`

## In plain terms

A test runs its steps top to bottom and the only way to end early is to
fail. There is no way to say *"if we are already signed in, skip the rest of
this section"* or *"if the page shows Dashboard, we are done"*. Authors work
around it with conditional steps on every line that might not apply, or by
writing a tool.

This story adds one step form that ends the flow it is in, as a pass:

```markdown
3. If the page title contains "Dashboard" then return
```

The step's condition is judged by the model against the live page, the way
an `If …` step is today. When it holds, the framework ends the **innermost
flow the step is in**: the rest of a `### Section` body, the rest of a skill
body, or the rest of the test when the step is in the main flow. The steps
it leaves behind are marked *skipped*, not passed, and the run carries on
after the flow that ended. When the condition does not hold, nothing happens
and the next step runs.

`return` and `stop` mean the same thing, and either may be written bare or
with one of six tails — `here`, `running the steps`, `running the rest of
the steps`, `running the remaining steps`, `running the below steps`,
`running the following steps`. So `stop`, `stop here` and `stop running the
remaining steps` are one instruction written three ways.

There is also an **unconditional** form: a step whose whole text is the tail,
with no `If`/`When` in front of it. `Return`, `Stop here` and `Stop running
the remaining steps` are all of them, and all cost no model call at all. What
makes a step unconditional is the absence of a condition, not the shortness
of the line.

### What it looks like in practice

**You write**, in a section:

```markdown
### Sign in
1. If the page title contains "Dashboard" then return
2. Reject non-essential cookies in the cookie banner
3. Enter the username {{username}}
4. Enter the password {{password}}
5. Click the Sign in button
```

**You get:** the first time `Sign in` is called, the title is *Sign In*, the
condition fails, and steps 2 to 5 run. The second time, the title is
*Dashboard*, step 1 returns, steps 2 to 5 are marked skipped with the reason
*Not run: step 7 returned from "Sign in" — If the page title contains
"Dashboard" then return*, and the main flow continues at the step after the
call. The call line shows ✓ both times.

The `step 7` is the **expanded** index — what the report rows and the run log
are numbered by, so those two read together. It is not what the editor is
numbered by, and there is no step 7 on screen when the section you are looking
at has five lines. So the returning step's authored text rides along, clipped
at 80 characters: that half is findable anywhere.

**You write**, in the main flow:

```markdown
4. If the page title contains "Dashboard" then stop running the remaining steps
5. Click "Sign out"
```

**You get:** when the title is Dashboard the run ends there as **passed**.
Step 5 is skipped, the `after` hooks run, and the report says 4 passed, 1
skipped, with the reason on the skipped row. The step count in the header
is honest: nothing that did not run is counted as passed.

**You write:** `Return` as a whole step, inside a looped section.
**You get:** that iteration ends and the next iteration starts. A return
never breaks out of a loop; it leaves the flow it is in, and an iteration is
a flow. (How that rule and the `While` / `Repeat` / `For each` loops of
stories/control-flow.md compose — and which grammar owns
`If <condition>, then return` — is settled in that story's §"Composition with
`If … then return`".)

**You write:** `If the Save button is visible, click it and return`.
**You get:** a compound step. The model clicks Save and then returns; the
steps after it in the same flow are skipped.

**You write:** `Click the details link then return`.
**You get:** an ordinary AI step. Only a line that opens `If` or `When`, or
a line that is nothing but the tail, is flow control; "then return" after an
action reads as *navigate back*, and the framework does not guess.

**You write:** `If the page title contains "Dashboard" then retun`.
**You get:** prose, sent to the model, which will most likely do nothing.
The steps after it run and, if the return was needed, they fail loudly. A
missed return fails the run; a return that fires when it should not would
pass a run that did no work, so the grammar errs towards missing.

**You compile** the section above.
**You get** an entry for step 1 that reads the title and calls
`step.exit()` when it matches:

```ts
{
  source: 'If the page title contains "Dashboard" then return',
  async run({ page, step }) {
    if ((await page.title()).includes('Dashboard')) step.exit();
  },
}
```

On replay it costs no tokens, and it returns exactly as the AI step did.

## Context — what exists, and what is missing

A test is expanded at parse time into one flat list of steps. Each step
carries the id of the **frame** it runs in, and every frame is recorded in a
table ([types.ts](../src/parser/types.ts) `ParsedTest.expansion`,
[expander.ts](../src/skills/expander.ts) `ExpandedFrame`). A `### Section`
call is a frame of kind `section`; each iteration of a looped section is its
own frame, numbered; a `[skill:]` call is a frame of kind `skill`; the main
flow is the root frame, id `''`. The Sessions API server pushes and pops
frames as execution crosses from one step's frame to the next
(`transitionToFrame`, [session-manager.ts](../src/server/session-manager.ts)),
and TestBench paints the call line from those events.

So "the flow this step is in" already has a precise answer, and "the rest of
that flow" is computable from data every runner already holds: from step *i*
in frame *F*, every later step whose frame is *F* or a descendant of *F*,
up to the first step that is not. Nothing new has to be parsed to know where
a section ends. What is missing is a step that asks for it, a result that
carries the answer, and four loops that act on it.

Four things in the codebase shape the design, and each is a trap if
ignored:

- **The conditional grouper.** `isConditionalStep`
  ([step-grouper.ts](../src/runner/step-grouper.ts)) matches any step
  opening `If`, and groups it with the next step as a *continuation*.
  `executeBranchedStep` then runs the matched conditional **and the
  continuation** inside one call. A grouped return step would be followed
  at once by the very step it was meant to skip. `Set` already has the
  exemption this needs; return steps take the same one.
- **The CLI runner infers a timeout from the result count**
  ([test-runner.ts](../src/runner/test-runner.ts), `timedOut`). A main-flow
  return that leaves steps unrun would flip a passing test to failed unless
  every unrun step has a result.
- **The wire has no skipped status.** runner-core's step status is `passed`,
  `failed` or `error` ([protocol.ts](../runner-core/src/protocol.ts)); the
  server maps its internal `skipped` to a `step:pass` with `output:
  'skipped'`, and the MCP fold reads that as "a step needed a human". The
  TestBench tracker has a `skip` status and glyph, but until PR #137 nothing
  on the wire set it, and now only data-table row lines do.
- **A clean `frame:pop` paints ✓ on the call line.** If the steps a return
  skips went through the frame transitions, a nested call inside the
  returned body would push, pop clean, and show ✓ for work that never ran.

## Decisions

1. **One meaning for both verbs.** `return` and `stop` both leave the
   innermost flow. A verb that stops the *whole test* from inside a section
   is not offered: it reads too close to a failing stop, and the case it
   serves is rare. If it is needed it is a second verb, not a second meaning
   for this one.

2. **The line claims the form; the model judges the condition.** A step is
   flow control iff `parseFlowControlStep` (below) accepts it. That decision
   is textual and runs before anything else, on the authored line, in every
   runner. The condition is then judged by the model, which answers with a
   new `return` action when it holds and `noop` when it does not. The
   executor honours a `return` action **only** on a step whose text claims
   the form; on any other step the action is rejected, the step fails, and the
   model is told why on its next **attempt** (the refusal is retryable, so it
   rides in as prior-failure context; with `execution.retries: 0` there is no
   next attempt and the step just fails). That guard is why the grammar exists: without it a
   model could end a test early from any line, and the report would be green
   for work not done, which is the failure direction this codebase treats as
   the worst.

3. **The unconditional form costs nothing.** A step whose whole text is the
   tail — `Return`, `Stop`, `Stop here`, `Stop running the remaining steps`,
   any accepted tail with no `If`/`When` in front of it — is dispatched by the
   loop, like `Set`, with no model call, no page snapshot and no cache entry.
   Its result is a passed step with the explanation *returned from "Login"* or
   *ended the run*. The runners tell the two forms apart by the absence of a
   parsed `body`, never by the length of the line.

4. **Skipped steps get results.** Every step a return leaves behind is
   reported `status: 'skipped'` with `aiExplanation` of the form
   `Not run: step N returned from "Sign in" — <the returning step's authored
   line>` (or `Not run: step N ended the run — <the line>`), the line clipped
   to 80 characters with `…`. Both halves are there because they answer
   different readers: `step N` is the expanded index the report and the run log
   number by, and the text is what a reader with only the editor can find. It
   is the AUTHORED line, never the interpolated one, so a resolved
   `{{password}}` or skill argument cannot ride out on a log line, a wire event
   or a report cell. The one exception is a looped section body on the SERVER,
   whose authored text the wire shape does not carry (`matchInput` falls back to
   the interpolated step when `rawSteps` is absent), so that one reason quotes
   the line with the row values already in it. Skipped
   steps run no hooks, spend no tokens, take no screenshot, and are not added
   to the model's conversation history; the returning step's history line
   says it returned, so a later step knows why the gap is there. The
   returning step itself runs its `afterEach` hooks as any passed step does.
   Run status is unchanged by a return.

5. **The grammar.** Applied to the instruction after a `[no-hooks]` strip,
   trimmed, with one trailing `.` removed, case-insensitively:

   ```
   tail   := (return | stop) [ here | running the (rest of the | remaining | below | following)? steps ]
   joiner := "," [then | and]  |  then  |  and
   line   := tail                              -- unconditional
           | (if | when) <body> <joiner> tail  -- conditional, body non-empty
   ```

   `<body>` is everything between the head and the joiner; it may hold a
   comma and an action (`If the Save button is visible, click it and
   return`). It is kept for the report and diagnostics only; the model
   reads the whole line. There is **no parse-error family** for near misses:
   unlike `Set {{x}} to`, no prefix of this form is a claim, and a line that
   does not complete the tail is prose. The story accepts that a typo in the
   verb loses the return, because the loss fails loudly downstream.

6. **A settle gate before the judgement.** A conditional flow-control step
   waits for page stability before its first model turn, with the same
   budget `executeBranchedStep` uses (up to 10 s, 1 s quiet). A title read a
   millisecond after the click that changes it is the stale answer that
   would make the return miss.

7. **Grouping exemption.** A flow-control step is never a conditional and
   never a continuation. Conditionals immediately before one form no group
   and run as ordinary steps, the rule `Set` established and for the same
   reason: the group's jump would otherwise skip the step itself.

8. **Hooks may not return.** A flow-control step in `## Hooks` is a parse
   error naming the line; one in `defaultHooks` is a config error at load.
   The CLI's hook loop refuses one anyway, with *flow control is not allowed
   in hooks*, because there is a third way such a line arrives that neither
   check sees: a `[skill: …]` named as a default hook, whose body is read at
   run time. (The Sessions API has no hooks — `StepRequest` carries none and
   the server runs no hook loop — so nothing arrives that way.) There is no
   flow to leave from inside a hook, and inventing one would mean deciding
   whether it skips the rest of the hook scope, the step, or the run.

9. **The wire gains `step:skip`.** `{ type: 'step:skip'; line; frame?;
   reason }`, one per skipped step line, and one per skipped nested call
   line (a section or skill call inside the returned body, addressed by its
   frame's `invocationLine` in its parent's file). Skipped steps do **not**
   go through `transitionToFrame`: no frame is pushed for them, so no nested
   call pops clean. The returned frame itself pops when the next executed
   step's transition pops it, or at end of run, and its call line paints ✓
   as it should: the section ran and returned. The Sessions API `results[]`
   carries skipped steps with `status: 'skipped'`, an additive widening of
   the `passed | failed | error` union in runner-core, the server response
   type and SPEC-SESSIONS-API; every consumer that switches on the status is
   found by the compiler. `stepsCompleted` does not count the steps a return
   skips — it counts steps that EXECUTED. (The chain and loop skips that
   arrived with `stories/control-flow.md` DO count it, for the progress-bar
   reason set out there under "What `stepsCompleted` counts"; the two producers
   differ on that number, and on `session.totalStepsExecuted` — the session
   counter the MCP `list_sessions` tool reports — which the chain skips
   increment and a return's do not, for the same reason.) The
   MCP fold maps `step:skip` to its existing `skipped` status **without** the
   "needs a human" warning. That warning was tied to `output: 'skipped'` on a
   `step:pass` while that event had exactly one producer; `stories/control-flow.md`
   added a second, so the event now carries `skipKind`
   (`'unattended' | 'not-taken'`, absent ⇒ `'unattended'`) and the warning is
   tied to that instead. Three causes arrive as `skipped`, so the fold records
   WHICH on the row (`skipCause: 'returned' | 'not-taken' | 'unattended'`) and
   the one-line summary words them apart — `2 passed, 1 skipped (a step
   returned early), 1 skipped (need a human) of 4` — rather than naming one
   cause over all of them. The MCP client's own
   event whitelist (`KNOWN_EVENTS`, api-client.ts) must list `step:skip`: an
   unlisted type is dropped into `dropped[]`, which becomes a run warning, and
   the fold's branch is then unreachable from the real transport.

10. **Step-mode after a jump.** The pause decision after the returning step
    uses the first step that will actually run next, not `i + 1`; otherwise
    the yellow arrow lands on a skipped line.

11. **Code-behind.** `CodeBehindStepApi` gains `step.exit()`, the code form
    of `return` / `stop`. It throws a sentinel, so nothing after it in the
    entry runs, and `runCodeBehindEntry` reports it as a **passed** outcome
    with `flowControl: { kind: 'return' }`; `runCodeBehindStep` must not
    read it as broken code, or every compiled return would heal under AI and
    discard its entry. `step.exit()` from an entry bound to a step whose text
    does not claim the form is a non-retryable failure that names the rule:
    the markdown is what a reader sees, and it has to say what the code does.
    The generator prompt lists `step.exit()` and adds one rule: a
    flow-control step evaluates its condition and calls `step.exit()` when it
    holds, does nothing otherwise, and needs no post-condition; the review
    pass honours the same exception. Unconditional forms are ineligible for
    compile (they already run without a model), as `Set` is.

12. **Compile treats a skipped step as no evidence.** A step skipped by a
    return on the recording run has no transcript and is reported *not
    attempted: not run on the recording run (step N returned)*; it does not
    end the usable prefix, so steps after the returned flow that did run are
    still compiled. On a proving replay a skipped step is neither proven nor
    failed; the compile is `partial` and says which steps the replay never
    reached and why.

13. **Loops.** In a run-level data table (rows under `## Steps`) a main-flow
    return ends that row's run and the next row starts. In a looped section
    a return ends the current iteration and the next iteration starts.
    There is no "break out of the loop" in this story.

14. **Skills.** A return inside a skill body ends that invocation. `##
    Outputs` written before the return reach the caller; the rest stay
    unset, and a later `{{alias}}` fails the way an unset variable always
    has.

15. **The report.** Skipped rows use the existing `skipped` badge with the
    reason in the explanation cell; the header counts passed, failed and
    skipped separately. A run that returned from the main flow reads as a
    pass with N skipped, never as a timeout.

## Design

### Parser — `src/parser/flow-control-step.ts` (new)

```ts
export interface ParsedFlowControlStep {
  verb: 'return' | 'stop';
  /** The text between the `If`/`When` head and the joiner; absent for the
   *  unconditional form. Diagnostics and the report only. */
  body?: string;
}
export function parseFlowControlStep(instruction: string): ParsedFlowControlStep | null;
```

Import-free, like `set-step.ts`, so the TestBench mirror suite can load it
under Node's type stripping. A frozen table of accepted and refused lines
lives beside it in `tests/`, and the same table pins any client mirror.

`parseTestContent` refuses a flow-control line in `## Hooks` with an error
naming the line; `loadConfig` (or wherever `defaultHooks` is read) refuses
one there.

### Shared runner helper — `src/runner/flow-control.ts` (new)

```ts
/** Last expanded index (inclusive) of the frame step `i` runs in: `i`'s
 *  frame or any descendant of it. `steps.length - 1` for the root. */
export function frameExitIndex(origins, frames, i): number;
/** Name for the reason strings: the section or skill name, or null for the root. */
export function frameLabel(origins, frames, i): string | null;
/** A skipped StepResult for step `j`, naming step `i` as the cause. */
export function skippedByReturn(j, instruction, i, label): StepResult;
```

Runners without an expansion (the raw `parseTestContent` path, errands)
treat every step as root: a return ends the list.

### The action

`ActionType` gains `'return'`; `VALID_ACTION_TYPES` in
[action-parser.ts](../src/ai/action-parser.ts) accepts it; `executeAction`
treats it as a no-op like `noop`. The executor's turn loop, on a `return`
action: if `opts.flowControlClaim` is set (the loop passes
`parseFlowControlStep(authored)`), the step ends passed with
`flowControl: { kind: 'return' }` on the `StepResult`; otherwise the sub-action
fails with *this step does not say to return*, the turn ends, and the step
throws a retryable `StepFailureError`. What the model sees next is the STEP
retry: `withRetry` re-prompts it with the refusal as prior-failure context, so
it learns the rule on attempt 2 rather than mid-turn. Under
`execution.retries: 0` there is no attempt 2 and the step simply fails — which
is the right direction, because a step that tried to end the run from a line
that never asked to is not a step to carry on from.
The system prompt gains a rule beside the `noop`
rule: *when the step says to return or stop and its condition holds, return
`{ "action": "return" }`; when it does not hold, `noop`. Never return on a
step that does not say to.*

### The four loops

Each loop, on a step result carrying `flowControl`, computes
`frameExitIndex`, pushes or emits a skipped result for every index after the
step up to it, and continues from the index after. The unconditional form
is dispatched before the model, beside the `Set` branch.

- **CLI** ([test-runner.ts](../src/runner/test-runner.ts)) — the count-based
  `timedOut` becomes an explicit flag set where the timeout `break` is. Hook
  scopes fail on a flow-control hook (decision 8). `recordLastRun` and the
  recording see the skipped results; the code-behind sidecar ignores them.
- **Sessions API** ([session-manager.ts](../src/server/session-manager.ts))
  — `step:skip` per skipped line and per skipped nested call line, no
  `transitionToFrame` for them; `results[]` entries with `status: 'skipped'`;
  the step-mode pause uses the post-jump next index; breakpoints on skipped
  lines never pause; `endIndex` bounds the jump.
- **Electron Runner UI** ([runner-adapter.ts](../src/ui/main/runner-adapter.ts))
  — reads `parsedTest.expansion`, which `parseTestFile` already gives it;
  IPC step status gains `'skipped'`.
- **MCP errands** ([errand-runner.ts](../src/server/errand-runner.ts)) — flat
  list; a return ends the errand, remaining steps `step:skip`.

### runner-core and TestBench

`StepSkipEvent` joins `RunEvent` and `isRunEvent`; `StepStatus` widens.
The extension paints `skip` on `step:skip` lines (and nested call lines),
logs `skipped — <reason>`, and leaves the call line to the pop. Patch bump
in `testbench-native/package.json`.

### Code-behind

`types.ts`: `exit(): never` on `CodeBehindStepApi`. `execute.ts`:
`CodeBehindExitSignal`, caught before the generic catch; `CodeBehindOutcome`
gains `flowControl`. `step-executor.ts` `runCodeBehindStep`: pass it
through; `brokenCode` excludes it. `generate.ts` / `prompts.ts`: the API
line and the rule; `refuseReason` unchanged (a recorded `return` or `noop`
is an action). `compile.ts`: `leadingPassed` steps over `skipped`; selection
marks recording-skipped steps not attempted with the reason; the replay
outcome reports unreached steps.

### Docs

Handbook: new §3.6 *Leaving a flow early* with the examples above; §3.5's
"no branching" line and the closing table updated. SPEC-SESSIONS-API: the
event and the widened status. CHANGELOG.

## Tests

- **Grammar table** — accepted forms (both verbs, every tail, `if`/`when`,
  comma and `then`/`and` joiners, compound body, trailing period,
  `[no-hooks]` prefix, casing) and refused near misses (`then return to the
  dashboard`, `Click save then return`, verb typo, empty body, `Return the
  book`).
- **Grouper, combined** — `If prompted for MFA, enter the code` followed by
  `If the title is Dashboard then return` followed by `Wait for the
  dashboard`: no group, all three run as themselves. The test must include
  the return step *between* real conditionals, not alone.
- **Frame exit** — root, section, nested section in section, skill in
  section, looped iteration (only the iteration ends), return on the last
  step of a frame (nothing skipped), return with `endIndex` inside the frame.
- **CLI loop** — skipped results, reasons, hooks (afterEach on the returning
  step, none on skipped), `after` hooks run, status passed, no timeout
  inference, `stopAfterStep` still respected.
- **Sessions API through api-server** — POST a real request: `step:skip`
  events with the right lines and frames, no `frame:push` for a skipped
  nested call, a clean pop for the returned frame, `results[]` statuses,
  `stepsCompleted`, step-mode `step:awaiting` after a jump, a breakpoint on
  a skipped line not pausing, the `return` action rejected on an ordinary
  step, the hook refusal.
- **Errand and Electron loops** — return ends the list; statuses.
- **run-fold** — `step:skip` folds to `skipped` with no human-needed warning.
- **Code-behind** — `step.exit()` passes with `flowControl`; not healed; the
  claim guard; generator prompt carries the rule; compile prefix and
  selection with a skipped recording; a proving replay that returns.
- **TestBench** — fast suite with `FakeApiClient`: `step:skip` paints skip,
  nested call line paints skip, call line paints ✓ on pop. Live suite:
  the fixture below against the fixture app, then a compile of it and a
  replay that returns as code.

### The live fixture — `templates/init/tests/flow-control-live.md`

```markdown
## Steps
1. Navigate to the baseUrl
2. Sign in
3. Sign in
4. If the page title contains "Dashboard" then stop running the remaining steps
5. Click "Sign out"

### Sign in
1. If the page title contains "Dashboard" then return
2. Reject non-essential cookies in the cookie banner
3. Enter the username {{username}}
4. Enter the password {{password}}
5. Click the Sign in button
```

The first call runs the body; the second returns at its first line; step 4
ends the run. After the run the tracker shows body lines 2 to 5 as `skip`
(the second call's paint), main-flow line 5 as `skip`, the call lines and
line 4 as `pass`, and `done` as `passed`.

## Not in this story

- Breaking out of a loop, or returning from an outer flow by name.
- A verb that ends the whole test from inside a section.
- A parse-error family or TestBench near-miss diagnostic for lines that
  almost claim the form.
- Judging the condition without a model (a predicate mode on `assert`).
  The model already judges page conditions in the branched path; reusing
  that judgement is the smaller change, and a code-behind entry is the
  zero-token path.

## Open questions

- Whether `when` belongs in the head. It is accepted here for symmetry with
  the grouper's `When prompted`; if it proves to collide with prose in
  practice, dropping it is a one-line change to the grammar table.

## What the build showed

**Built 2026-09-09**, three implementation rounds and three review rounds,
on top of PR #137. The live fixture above ran three times through TestBench
against the fixture app, once after each fix round, and behaved identically
each time: the first `Sign in` call judged the title *Sign In* and ran the
body, the second returned at body line 1 and painted lines 2 to 5 `skip`,
step 4 ended the run with step 5 `skip`, and `done` was `passed`. Compile
wrote `if ((await page.title()).includes('Dashboard')) step.exit();` for both
flow-control steps, and the replay ran every executed step as code in about
a second with the same skip pattern. The generated entry is exactly the one
predicted under "You compile" above.

### What the reviews found, and what it says about the design

Every blocker was a **delivery gap**, not a logic error: the decision was
right and the runtime did it, and then one seam between the runtime and a
reader threw it away. Four of them, in three rounds:

- **The step cache would replay a cached `return`.** Run 1 lands on
  Dashboard and caches the `return` turn; run 2 does not, the cache hit
  dispatches `return` with no model call and no page read, and the report is
  green for steps nobody ran. Now the cache is off, for reads and writes and
  for the assertion cache too, at one seam (`cacheEnabledFor` in the
  executor) whenever the step claims the form.
- **The Sessions API report never set `skippedSteps`**, so the header of the
  report every TestBench run produces showed 13 total, 8 passed, 0 failed
  and nothing else. The test named for it asserted the rows and passed.
- **Compile-as-you-go never offered the skipped steps** to the live
  compiler, so its `skipped` branch was dead and the compile summary said
  nothing about them. The unit test fed the branch a hand-built input
  production never produced.
- **The MCP client's event whitelist dropped `step:skip`** before the fold
  saw it, so the MCP fold's new case and the one-liner wording were
  unreachable on the real path, and each skipped step became an
  "unrecognised event" warning. The tests injected events through a fake
  client that bypassed the whitelist.

The pattern is the repo's standing lesson, stated once more because it
recurred four times in one feature: a test that constructs the input the
seam is supposed to produce proves the consumer, not the seam. Every one of
these is now pinned through the real entry (the api-server POST, the real
`createApiClient` over a local socket, the real compile route), and each fix
was negative-verified by reverting it and watching the new test fail.

Two more findings changed contracts rather than code paths. The reason
string named the **expanded** step index, which matches the report rows and
the server run log but not the editor, where the hover on line 30 said "step
7 returned" and no step 7 was on screen; the returning step's authored text
now rides along, clipped at 80 characters. And the server and Electron loops
built that text from the **interpolated** step, so a skill argument's literal
value could reach the wire and the report; they use the authored line now.
The one case that cannot is a looped section body on the server, whose
authored form never travels on the wire.

### Still open

- A looped section body on the Sessions API path has no authored text on the
  wire, so its skip reason stays interpolated (documented in the SPEC).
- The boxed `/codebehind/compile` route reports section-body events on the
  invocation line rather than the body line. Pre-existing for every event on
  that route, pinned as a fact in its test, not changed here.
- No first-party client sends `## Hooks` to the Sessions API, so the runtime
  hook backstop is exercised only by a `[skill:]` used as a default hook.

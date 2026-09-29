# Failing on purpose, and failing without stopping

## In plain terms

Today a step fails when the model or the code-behind cannot do what the line
says, and every failure stops the run. There is no way to say any of these
three things:

- *if the value is wrong, fail, and say this in the report* — the failure
  message is whatever the framework produces, never the author's words;
- *check this, and if the check fails, use my message* — a `Verify` that goes
  red says what the model compared, not what the author meant;
- *try this, and carry on if it does not work* — a step that may legitimately
  fail (dismiss a banner that is sometimes there, check something that is
  informational) has to be written as a conditional, or it takes the run down
  with it.

This story adds three step forms. The first two put the author's words on a
failure; the third lets a failure pass through.

**You write:**

```markdown
3. If {{a}} is "peanuts" then fail the test with error "The variable value was peanuts. Expected apples"
```

**You get:** the model judges the condition, the way it judges an
`If … then return` today. When it holds, the step fails, the run stops as it
does on any failure, and the error on the row, in the run log, in the Steptix
hover and in the MCP summary is *The variable value was peanuts. Expected
apples*. When it does not hold, nothing happens and the next step runs. The
failure is not retried: the author asked for it, and a retry would hand the
model "this failed, try something else", which is the one nudge that could
turn a deliberate failure into a false pass.

**You write:**

```markdown
4. Verify the title contains "Account details" otherwise fail the test with message "Page did not contain account details"
```

**You get:** an ordinary `Verify` step. The model never sees the tail — it is
handed `Verify the title contains "Account details"` and nothing more, does the
check, and the normal retry policy applies. If the step fails after its
attempts, the error becomes *Page did not contain account details*; what the
model actually compared stays in the row's explanation and the run log. If the
step passes, the tail did nothing.

**You write:**

```markdown
5. Dismiss the promo banner otherwise continue
6. Verify the footer shows the build number otherwise continue with warning "Footer build number missing"
```

**You get:** the step runs as itself, with its usual retries. If it fails, the
row says so — amber, not red, with the error or the warning in the hover — and
the run carries on with the next step. The run's status is not affected by it:
a run whose only failures were tolerated passes. Nothing that did not do its
work is painted green; the row is a failure that the author chose not to stop
on, and the report header counts it separately: *7 passed, 1 tolerated*.

**You write**, at the end of a decision (stories/control-flow.md):

```markdown
5. If the balance is shown, then Check the balance
6. Otherwise fail the test with error "No balance was shown"
```

**You get:** `Otherwise` is the chain's else, as today; its tail is the
unconditional `Fail the test with error "…"`, which costs no model call —
like `Return` and `Set`, it is dispatched by the loop. The same line works on
its own inside a section body.

**You compile** step 3 and step 4 above. **You get** entries that read the
value and fail in the author's words, so the replay costs no tokens and fails
exactly as the AI step did:

```ts
{
  source: 'If {{a}} is "peanuts" then fail the test with error "The variable value was peanuts. Expected apples"',
  async run({ step }) {
    if (step.getVar('a') === 'peanuts') step.fail('The variable value was peanuts. Expected apples');
  },
}
{
  source: 'Verify the title contains "Account details" otherwise fail the test with message "Page did not contain account details"',
  async run({ page, step }) {
    step.expect((await page.title()).includes('Account details'), 'Page did not contain account details');
  },
}
```

**You write:** `Click Save otherwise fail`. **You get:** the click, and on
failure the framework's own error — a message-less tail is legal and changes
nothing. It is accepted so that `otherwise fail` and `otherwise fail the test
with message "…"` are one grammar, not two.

**You write:** `Verify the total then fail the test`. **You get:** prose. Only
a line that opens `If`/`When`, or is nothing but the tail, is the first form,
and only a line with `otherwise` (or `or else`, `if it fails`) between a body
and an outcome is the second. A near miss is prose sent to the model, which is
the direction the return grammar chose and for the same reason: a missing
fail is loud (the wrong value goes on to break something), a fail that fires
when it should not is a red run for nothing, and neither is silent.

## Context — what exists, and what is missing

`If … then return` / `… then stop` (stories/step-flow-control.md) built almost
everything the first form needs. `parseFlowControlStep`
([flow-control-step.ts](../src/parser/flow-control-step.ts)) is the one textual
claim every runner makes on the AUTHORED line; the executor honours the
model's `return` action only on a claiming step; the claim switches the step
cache off, turns the settle gate on, exempts the step from the conditional
grouper, wins rung 0 over the control-line grammar, and refuses an `Otherwise`
directly under it. The unconditional form is dispatched by the four run loops
with no model call. runner-core carries a hand copy of the regex for its
section-index and dangling-member checks, pinned by
`tests/control-line-parity.test.ts`.

A failed step already stops every loop: the CLI sets `bail`
([test-runner.ts](../src/runner/test-runner.ts)), the Sessions API and the
errand runner `break` after emitting `step:fail`
([session-manager.ts](../src/server/session-manager.ts),
[errand-runner.ts](../src/server/errand-runner.ts)), and the Electron adapter
does the same. The executor's failure is a `StepFailureError` with a
`retryable` flag ([step-executor.ts](../src/runner/step-executor.ts)); a
non-retryable one ends after the first attempt, and `attemptsMade` is
reported honestly for it. A hook step that fails aborts the run.

Three facts shape the design, and each would be a trap if ignored:

- **The wire has one failure shape.** `step:fail { line, error, screenshot?,
  frame?, fromCodeBehind?, codeBehindStale? }`
  ([protocol.ts](../runner-core/src/protocol.ts)), and `StepStatus` is
  `passed | failed | error | skipped`. Widening the status union again would
  be found by the compiler everywhere, which is safe, and would also touch
  every switch in the report, the MCP fold, Steptix and the IPC types, which
  is a lot of churn for one flag's worth of meaning.
- **There is a precedent for "failed, but not counted".** A step the user
  stopped on carries `status: 'failed'` with `interrupted: true`
  ([report/types.ts](../src/report/types.ts)); the CLI and the server both
  count `failedSteps` as `status === 'failed' && !interrupted`, and the report
  paints it amber with its own badge. That is the exact shape a tolerated
  failure needs, and it is already honoured in the two places that compute a
  run's status.
- **The model reads the authored line.** `executeStepAttempt` hands the model
  `authored` (the line as written, tokens intact) on turn 1 and both `authored`
  and the substituted `instruction` on continuation turns
  (`buildStepMessage`, `buildContinuationMessage`). The report's instruction
  line, the console line, the run log and the cache key are all built from
  `instruction`. Hiding a tail from the model therefore means stripping it
  from what goes into the two prompt builders and nowhere else.

What is missing is a verb that fails, a tail that renames or tolerates a
failure, one seam that applies them, and a flag on the wire so a client can
tell a tolerated failure from a real one.

## Decisions

1. **`fail` is a third verb of the flow-control grammar.** Same parser, same
   split — the line claims the form, the model judges the condition, the
   executor honours a `fail` action only on a claiming step. Everything the
   claim already buys arrives for free: no grouping, rung 0 over the
   control-line grammar, cache off, settle gate on, `Otherwise` under it
   refused. `ParsedFlowControlStep` becomes a union: `{ verb: 'return' |
   'stop'; body? }` stays as it is; `{ verb: 'fail'; body?; message? }` joins
   it. Every consumer that reads `verb` today is found by the compiler.

2. **A deliberate failure is not retried, and not diagnosed.** The model's
   `fail` action on a claiming step throws a non-retryable `StepFailureError`
   carrying the authored message. `withRetry` ends after the first attempt
   and reports it so. The result carries `deliberate: true`, and the CLI's
   `ai.diagnoseFailures` pass skips a run whose failing step is deliberate —
   the author has already written the root cause, and an AI paragraph
   guessing at it would sit above their sentence in the report.

3. **The message is the author's, interpolated, and masked once.** The loops
   interpolate the whole line before the executor sees it, so `{{a}}` in a
   message resolves like `{{a}}` anywhere else. The executor passes the
   message through `redact(message, secretsNow())` when it composes the error
   — once, at the seam — so a `{{password}}` an author put in a message reaches
   the wire, the report and the log masked. When the tail has no message the
   error is `Failed by the step: <the model's account of why the condition
   held>`; the unconditional form with no message reads `Failed by the step,
   as written`.

4. **The `otherwise` tail is a property of an ordinary step, not flow
   control.** It is parsed by a sibling import-free module,
   `parseFailureTail`, into `{ body, outcome: 'fail' | 'continue', message?,
   warning? }`. The body is what runs. The model never sees the tail of the
   step it is being asked to do: the executor strips it from both prompt texts
   and from nothing else, so the report's instruction line, the console line
   and the run log all show the line the author wrote. Earlier steps are the
   exception, and deliberately so — `formatStepHistoryEntry` writes the
   authored line into `## Prior Steps` whole, so a model doing step 5 sees
   step 3's tail beside the `[flow]` line saying what became of it, which is a
   record of what happened rather than an instruction about what to do. Not shown to the model on purpose — a model told
   "otherwise continue" would reason that the step is optional and answer
   `noop`, and a model told "otherwise fail with message" would judge the
   check itself and answer `fail`, which puts a decision the framework should
   make into a place that drifts.

5. **`otherwise fail … with message "M"` renames the final failure.** The
   body runs with the normal retry policy. If it fails after its attempts,
   the executor sets `error: M` and writes the underlying failure into the
   explanation: `Failed as the step says. What failed: <original error>`. The
   log line at failure time prints the original before the swap, so nothing
   is lost for a reader with the run log. On the wire `step:fail.error` is M;
   the MCP summary, the Steptix hover and the report's failure block lead
   with M.

6. **`otherwise continue` tolerates the final failure.** The step's status
   stays `failed` — it did not do what it said — with `tolerated: true`
   beside it, the `interrupted` shape. Then, in every loop:
   - no `bail`, no `break`, no `overallStatus = 'failed'`, no `errorInfo`;
     the next step runs, in the same frame, with the frame still open;
   - `failedSteps` excludes it (the same `!interrupted` filter, widened),
     `passedSteps` excludes it, `stepsCompleted` and
     `session.totalStepsExecuted` count it (it executed);
   - the report header gains `toleratedSteps`, shown when non-zero like
     `skippedSteps` is, and the row paints amber with the badge `TOLERATED`
     and a block titled *✗ Step failed — the run continued*;
   - the conversation history gets the ordinary failed entry and one more
     line, `[flow] step N failed and the run continued (otherwise continue)`,
     so a later step is not left guessing what the red entry above it meant;
   - the CLI's failure REPL is not entered — the author said continue —
     and `afterEach` hooks run as they do for any completed step;
   - a `warning` message, when given, is the row's explanation AND a field of
     its own — `StepFailEvent.warning`, `StepResultResponse.warning`,
     `StepResult.warning`, the Electron IPC step update, the MCP row. The
     explanation alone was not enough and the gap was silent: it does not
     travel on `step:fail`, so the sentence the author wrote reached no client
     at all. With the field it leads — the Steptix hover's first line, the
     run log's `⚠ step N failed — continuing: <warning> (<what failed>)`, the
     panel's amber line, the MCP row and the tally's content lines — and the
     error stays the framework's, underneath it, on every one of them.
   A loop body (`While`, `Repeat`, `For each`, a looped section) keeps
   looping: `loops.abandon` is for a failure that ends the pass, and this one
   did not. A data-table row whose only failures are tolerated passes.

7. **Hooks.** `fail` is allowed in hooks in both forms: a hook can already
   fail the run, so the verb adds a message, not a power. `return` / `stop`
   stay refused where they are refused today; the three refusal sites check
   the verb rather than the parse. An `otherwise continue` on a hook step
   composes the obvious way — a tolerated hook step does not fail the hook
   scope, so it does not abort the run.

8. **Contradictions are refused, not resolved.** A line whose body is itself a
   flow-control claim under an `otherwise` tail — `If x then return otherwise
   continue`, `If x then fail otherwise continue` — is refused by the parse-
   time validator that refuses malformed control lines, naming the line: *a
   step cannot both end the flow and tolerate its own failure*. On the raw
   Sessions API path, where no validator runs, the executor refuses the same
   line non-retryably with the same sentence.

9. **The wire gains two booleans and a string, not an event.**
   `StepFailEvent` gains `deliberate?: boolean`, `tolerated?: boolean` and
   `warning?: string`, all additive; a client that does not know them paints ✗
   as it does today, which is the safe direction for all three.
   `StepResultResponse.status` stays `'failed'` for a tolerated step;
   `results[]` rows carry `tolerated: true` — and `warning` beside it — so an
   API reader can tell. `done.status` is what the server computed, which
   already excludes tolerated failures by decision 6. SPEC-SESSIONS-API
   documents the fields and the rule.

10. **Code-behind.** `CodeBehindStepApi` gains `fail(message: string): never`.
    It throws the same class a failed `step.expect` throws, so the runner's
    existing rule applies unchanged — a real failure, not broken code, never
    healed under AI — with the explanation worded for it. No claim guard, and
    the reason is the mirror of `step.exit()`'s: the unsafe direction for an
    exit is passing work that did not happen, and there is no unsafe
    direction for failing. The generator prompt gains three rules: a
    `fail`-claiming step evaluates its condition and calls `step.fail(<the
    authored message>)` when it holds, needs no post-condition, and writes
    `{{name}}` inside the message as `step.getVar('name')`; a step with an
    `otherwise fail … with message` tail uses the author's message as its
    `step.expect` message; a step with an `otherwise continue` tail compiles
    as its body and the tail is the runner's business. The review pass
    honours the same three. The unconditional `Fail …` is ineligible, as
    `Return` is.

11. **Compile treats a tolerated failure as no evidence.** On the recording
    run it has no successful transcript, so it is reported *not attempted:
    failed on the recording run and was tolerated*; like a skipped step it
    does not end the usable prefix. Compile-as-you-go declines it with the
    same reason. On a proving replay a tolerated failure is neither proven
    nor failed; the compile is `partial` and names it.

12. **Scope: leaf steps.** Both tails apply to prose steps, which includes a
    step bound to a code-behind entry. A `### Section` call line, a `[skill:]`
    call, a `[tool:]` step and a `Set` step do not take a tail in this story:
    the first two would need "skip the rest of the frame on failure", which is
    the return machinery with a failure attached and is a story of its own;
    the last two have grammars of their own that the tail would have to be
    threaded through.

    "Out of scope" is not one mechanism, and saying it was one sentence is
    what the third review round caught — the story claimed the parser answers
    null for all four, and it answers null for two:

    - **`[tool: …]` and `[skill: …]`.** `parseFailureTail` answers null (the
      body holds a `[tool` / `[skill` token), and the parse-time validator
      refuses the line by name — *a [tool:] step does not take an "otherwise"
      tail*, naming whichever directive it found. Without the refusal the line
      parses, runs the call and drops the tail without a word: the loops
      dispatch the tool branch off the raw line, and `parseInvocation` hands
      the skill expander the tail as `trailing` text nothing reads.
    - **`Set`.** `parseFailureTail` DOES return a tail here — the body is a
      whole `Set` line and nothing in the tail grammar knows about `Set` — and
      it does not matter, because `parseSetStep` answers null for the same line
      and `setStepError` refuses the file first — as a malformed `Set`, with a
      message naming what is wrong with the line. WHICH of its sentences the
      author gets depends on the tail they wrote, so neither of them is "the
      `Set` refusal for a tail". On the raw Sessions API path, which runs no
      validator, the line is not a `Set` at all — it is handed to the model as
      prose with the tail applied, exactly as any other malformed `Set` is.
      That is the existing rule for a malformed `Set`, not a new one this
      story adds.
    - **A `### Section` call.** Nothing refuses it, and nothing needs to: a
      section is matched by the EXACT text of the calling line
      (`matchText`), and `Sign in otherwise continue` is not `Sign in`. So the
      line stops being a section call altogether and becomes an ordinary prose
      step carrying a tail, handed to a model. The tail is honoured — over the
      prose, not over the section — and the section is never entered. The
      author's way out is to write the tail on a step INSIDE the section.

## The grammar

Applied to the instruction after a `[no-hooks]` strip, trimmed, one trailing
`.` removed, case-insensitively. Both expressions are `$`-anchored with a lazy
body, for the reason the return grammar gives: the engine settles on the last
joiner that still leaves a complete tail, so a compound body with a comma in
it works and a tail followed by more prose stays prose.

```
quoted     := "…" | '…'                                 -- no nested quote of the same kind
fail-noun  := [the | this] (test | run)
fail-msg   := with [the] [error | message | reason] quoted
fail-tail  := fail [the | this] [test | run] [fail-msg]
rich-tail  := fail (fail-noun [fail-msg] | [fail-noun] fail-msg)   -- noun and/or message

joiner     := "," [then | and]  |  then  |  and
line       := (return | stop) tail-as-today                     -- unchanged
           | (if | when) <body> <joiner> (return | stop) …     -- unchanged
           | fail-tail                                         -- unconditional
           | (if | when) <body> <joiner> fail-tail             -- conditional, body non-empty
           | (if | when) <body> <space> rich-tail              -- conditional, `fail` only
```

The bare-space joiner is accepted for `fail`, not for the other two verbs, and
only in front of a tail that carries a noun (`fail the test`) or a message
(`fail with error "…"`) or both. `If {{a}} is "peanuts" fail the test with
error "…"` is how the request was written and how people write it; a
`fail the test …` tail is long and distinctive enough that a space in front of
it is not a claim a body would make by accident, whereas `If the page shows
Save return` is.

A BARE `fail` needs a real joiner — `If x, fail`, `If x then fail`, `If x and
fail` — exactly as `return` and `stop` do, and that half of the rule is what
keeps the joiner off ordinary prose. Without it `When I submit with bad data,
the save should fail` was a claim whose "condition" was `I submit with bad
data, the save should`: a BDD-style expectation became a flow-control step, so
the model was asked to answer `fail` when the condition held and the run went
red precisely when the author's expectation was MET. `If the upload does not
fail` and `If the login attempts fail` are the same sentence, and the refused
table carries all three.

```
otherwise := [,] (otherwise | or else | if (it | that | this) fails) [,]
outcome   := fail-tail
           | (continue | carry on | keep going) [with [a] (warning | message) quoted]
           | warn [with] quoted
line      := <body> otherwise outcome                          -- body non-empty
```

`warn "…"` is `continue with warning "…"`. The body may not itself parse as
a flow-control claim (decision 8). Both tables are frozen in `tests/`, accepted
and refused forms alike, and the runner-core mirror of `FLOW_CONTROL_RE` grows
the `fail` verb with the parity corpus extended to match; the `otherwise`
grammar needs no mirror, because runner-core classifies lines and a tail does
not change what kind of line a step is.

## Design

### Parser

`src/parser/flow-control-step.ts` — the union type, the `fail` alternative in
`FLOW_CONTROL_RE`, the quoted-message capture, and `flowControlInHookError`
narrowed to `return` / `stop`. `src/parser/failure-tail.ts` (new, import-free)
— `parseFailureTail(instruction)` and `stripFailureTail(instruction)`.
`src/parser/markdown.ts` and `src/config/loader.ts` — the hook refusal reads
the verb; the `## Steps` validator refuses the contradiction of decision 8.
`runner-core/src/control-line.ts` — the mirror regex.

### Executor — `src/runner/step-executor.ts`

`StepExecutorOptions.flowControlClaim` already carries the claim; the
`fail` verb rides in it. A new `failureTail?: ParsedFailureTail | undefined`
is computed by the loops from the authored line and cleared at every site
that clears `flowControlClaim` today, for the same reason.

- The `fail` action: beside the `return` branch. Claimed → `throw new
  StepFailureError(message, …, retryable: false)` with a marker the outer
  catch reads to word the explanation and set `deliberate: true`. Unclaimed →
  `FAIL_NOT_CLAIMED`, retryable, the shape of `RETURN_NOT_CLAIMED`.
- The prompt texts: `promptAuthored = stripFailureTail(authored)` and
  `promptInstruction = stripFailureTail(instruction)`, computed once before
  `buildStepValues`, and used in `buildStepMessage`, `buildContinuationMessage`
  and the retry context. Nothing else changes text.
- The outer catch (all attempts failed): with a `fail` outcome and a message,
  `error = redact(M)` and the explanation names the original; with a
  `continue` outcome, `tolerated: true` and the warning as explanation. The
  code-behind path (`runCodeBehindStep`) returns through the same helper, so a
  replay failure gets the same treatment.
- `cacheEnabledFor` is unchanged: a `fail` claim is a claim. An `otherwise`
  step caches normally — the body is an ordinary step and the tail is applied
  after the cache has said its piece.

### The four loops

Each loop already has an unconditional-flow-control dispatch beside `Set`;
the `fail` verb takes it, producing a failed result with the message (and a
failure screenshot where the loop has the page). Each loop's failed-step
branch gains one condition: a `tolerated` result does not stop the run, is
logged as `failed — continuing`, and emits `step:fail` with `tolerated: true`;
a `deliberate` one emits `deliberate: true`. `failedSteps` filters widen from
`!interrupted` to `!interrupted && !tolerated`. The CLI additionally skips the
failure REPL and the diagnosis pass for the two cases named in decisions 2
and 6.

- **CLI** ([test-runner.ts](../src/runner/test-runner.ts)) — plus the hook
  loop's refusal narrowed to `return` / `stop`, and `runHookScope` treating a
  tolerated hook result as not failed.
- **Sessions API** ([session-manager.ts](../src/server/session-manager.ts)) —
  plus `results[]` rows carrying `tolerated`, and the row/loop bookkeeping
  (`loops.abandon` not called for a tolerated failure).
- **Electron Runner UI** ([runner-adapter.ts](../src/ui/main/runner-adapter.ts))
  — IPC step update carries `tolerated`; the panel paints amber.
- **MCP errands** ([errand-runner.ts](../src/server/errand-runner.ts)) — flat
  list, same seam.

### runner-core, Steptix, MCP

`StepFailEvent` gains the two booleans. The extension paints a `tolerated`
fail with a new `fail-tolerated` status — an amber ✗, its own SVG, a hover
that opens *This step failed and the run continued past it* — and every
client-side count that reads `step:fail` (`sawFail`, the `N/M passed` summary
line) exempts it; a `deliberate` fail logs `✗ step N failed as written: M`.
The MCP fold records `tolerated` on the row, does not set `sawFailure` for
it, and words the summary *7 passed, 1 failed (tolerated)*; `KNOWN_EVENTS`
needs nothing, because no event is new. Patch bump in
`steptix-vscode/package.json`.

### Report

`TestReport` gains `toleratedSteps`; the header shows it when non-zero. A
tolerated row: amber badge, the failure block retitled. A deliberate row: the
block titled *✗ Failed by the step* with the message. `merge-rows` sums the
new count as it sums the others.

### Code-behind

`types.ts`: `fail(message): never`. `execute.ts`: `step.fail` throws
`CodeBehindExpectationError` tagged `deliberate`; `runCodeBehindStep` words
the explanation for it. `prompts.ts` / `generate.ts` / `review.ts`: the three
rules of decision 10, and the `## The step, exactly as authored` block keeps
the whole line, tail included, because the generator needs the message.
`compile.ts` / `live-compile.ts`: the unconditional `Fail` ineligible;
`leadingPassed` steps over a tolerated failure; selection marks it not
attempted with the reason; the replay outcome reports it.

### Docs

Handbook: a new §3.8 *Failing in your own words, and failing without
stopping* with the examples above; §3.3's assertion section points at the
message tail; §3.7's "what does not exist" drops the sentence this story
makes false and keeps the one about breaking out of a loop. SPEC-SESSIONS-API:
the two fields. CHANGELOG.

## Tests

- **Grammar tables** — `fail` accepted with every optional word present and
  absent, both quote styles, the bare-space joiner, comma and `then`/`and`
  joiners, a compound body, a `{{placeholder}}` in the message, the
  `[no-hooks]` prefix; refused: `fail the tests`, a message with no closing
  quote, `Verify the total then fail the test`, `Fail loudly`, the two
  existing verbs with a bare-space joiner (unchanged behaviour, now pinned),
  and a BARE `fail` behind one — `If x fail`, `When I submit with bad data,
  the save should fail`, `If the upload does not fail`, `If the login attempts
  fail` — which the grouper table pins from its own side as conditionals again.
  The `otherwise` table: every head and outcome form, a body with a comma, a
  quoted `"otherwise"` inside the body, a message-less `otherwise fail`;
  refused: `Otherwise continue` at line start (a chain member, not a tail),
  a flow-control body, a `[tool:]` body (decision 12, refused by name at parse
  time and null from the parser), an empty body, `otherwise` followed by prose.
- **Parity** — the runner-core corpus gains the `fail` lines.
- **Executor** — `fail` claimed: non-retryable, one attempt, the message,
  `deliberate`, a secret in the message masked; `fail` unclaimed: refused,
  retried with the refusal as context; the settle gate fires for a `fail`
  body; the prompt text lacks the tail on turn 1 AND on a continuation turn
  while the result's `instruction` keeps it; message swap on final failure
  with the original in the explanation; `tolerated` on final failure with the
  warning; a passing body with a tail is an ordinary pass.
- **Grouper, combined** — a tail step between two real conditionals: no
  group.
- **Loops through their real entries** — the api-server POST: `step:fail`
  with `tolerated: true`, the next step's `step:start`, `done` passed,
  `results[]` statuses, `stepsCompleted`; a deliberate fail: `done` failed
  with the message and no later step started; the unconditional `Fail` with
  no AI call; a tolerated failure inside a looped section keeps looping;
  inside a `While` body no `abandon`; a hook `fail`; a tolerated hook step
  not aborting. The CLI loop: no REPL, no diagnosis, `failedSteps` and
  `overallStatus`. Errand and Electron loops: statuses.
- **Report** — header counts, the two badges, `merge-rows` summing.
- **run-fold** — `tolerated` on the row, run status passed, the summary
  wording; `deliberate` error verbatim.
- **Steptix** — fast suite with `FakeApiClient`: amber paint, hover text,
  summary line, `done` not red for a tolerated fail.
- **Code-behind** — `step.fail` not healed, explanation wording; generator
  prompt carries the three rules; the compile prefix steps over a tolerated
  recording; a replay whose entry fails with the author's message.
- **Live** — the fixture below against the fixture app, then a compile of it
  and a replay that fails as code with the same message.

### The live fixture — `templates/init/tests/failure-outcomes-live.md`

```markdown
## Steps
1. Navigate to the baseUrl
2. Reject non-essential cookies in the cookie banner
3. Enter the username {{username}}
4. Enter the password {{password}}
5. Click the Sign in button
6. Verify the page title contains "Dashboard" otherwise fail the test with message "Sign in did not reach the dashboard"
7. Verify the page title contains "Peanuts" otherwise continue with warning "No peanuts on the dashboard"
8. Set {{a}} to "peanuts"
9. If {{a}} is "peanuts" then fail the test with error "The variable value was peanuts. Expected apples"
10. Click "Sign out"
```

Step 6 passes and its tail does nothing. Step 7 fails, paints amber, and the
run continues. Step 9 fails the run with the authored message; step 10 never
starts. `done` is `failed`, its error is the message from step 9, the report
header reads 7 passed, 1 failed, 1 tolerated. The compile writes
`step.expect(…, 'Sign in did not reach the dashboard')` for step 6 and
`if (step.getVar('a') === 'peanuts') step.fail('…')` for step 9, and the
replay fails at step 9 with the same message and no model call.

## Not in this story

- A tail on a section or skill call line — "if anything in this call fails,
  skip the rest of it and continue". That is the return machinery with a
  failure attached, and it decides what the skipped body lines say.
- A run-level *continue on failure* mode that records every failure and
  reports the run as failed at the end. It is the complement of decision 6
  (report everything, versus tolerate one thing) and is a `## Config` key or
  a CLI flag, not a step form.
- A `fail` that ends only the innermost flow rather than the run.
- Tails on `[tool:]` and `Set` steps.

## Open questions

- **Who reads the message.** The design assumes the report reader, the
  Steptix hover, the CI log and an MCP agent's run summary all want the
  author's sentence first and the framework's diagnostic second. If the CI
  consumer is a parser that keys on the framework's wording, decision 5
  should append rather than replace.
- **How wide the grammar should be.** The tables above accept more phrasings
  than the two examples that prompted them (`or else`, `if it fails`, `carry
  on`, `warn`). Each extra head is a line in the frozen table and a chance of
  colliding with prose; pruning is a one-line change per form.
- **The word for a tolerated failure.** `tolerated` is used throughout for
  the flag, the badge and the count. *failed, continued* reads more plainly
  in a header but is two words for one state.
- **Whether `otherwise continue` should wait for the retries.** As designed
  the body keeps `execution.retries`, so a step the author expects to fail
  costs its attempts before it is tolerated. A `retries: 0` on the tail is a
  later refinement if that proves expensive in practice.

## What the build showed

**Built 2026-09-11**, by parallel agents working the parser/executor, the
compiler and the run loops/clients at the same time. The live fixture above ran
once through Steptix against the fixture app and produced exactly the
statuses this story predicted: steps 1-6 and 8 passed, step 7 `fail-tolerated`,
step 9 `fail` carrying the author's message, step 10 never started, and the
report header read *7 passed, 1 failed, 1 tolerated*. The two sibling live
suites still pass. The compile wrote the predicted
`step.expect(…, 'Sign in did not reach the dashboard')` for step 6.

What recording a *deliberate* failure took is its own story, and the compile
found something the design had not said out loud — see
[What the compile showed](#what-the-compile-showed) below.

### What the review found, and what it says about the design

Nine findings, and the three that mattered were each a **seam** rather than a
logic error — the same shape the flow-control story's four blockers had. The
message interpolation blocker sat between "the claim is read off the AUTHORED
line", which is what makes the claim the author's, and "the message resolves
like the rest of the line", which is what decision 3 promises: both halves were
implemented and neither knew about the other, so a `{{name}}` in a `fail`
message stayed literal. The `[store as:]` leak was an enrichment appended after
a `$`-anchored grammar had already matched, so the modifier travelled into the
message the grammar had finished parsing. And the warning was a field that
lived only in the explanation: `aiExplanation` does not travel on `step:fail`,
so the sentence decision 6 exists to let an author write reached no hover, no
MCP row and no panel — the runtime did exactly what the decision said and the
last seam threw it away. The rest were local: the step-mode pause decision
sitting inside the `passed` branch (so F10 onto a tolerated step ran two steps
for one keypress), an unredacted `deliberateFailError` in the Electron loop
where the other three loops mask, a compiled deliberate failure worded as a
code-behind defect because `step.fail()` throws the class `step.expect` throws,
a SPEC sentence crediting the executor for a refusal the server's own loop
makes, and an undocumented repaint limitation.

### What the third round found

Three findings, and the first is the same seam as round one's blocker, read off
the sibling grammar. `applyFailureTail` used `tail.message` verbatim, and every
loop parses the tail off the AUTHORED line — so `otherwise continue with warning
"Missing {{name}}"` reached the row, the hover, the MCP tally and the log with
the braces still in it, and `otherwise fail … with message "Expected {{name}}"`
did the same to the error. The `fail` verb's own site three hundred lines up had
already been fixed by re-reading the grammar off the interpolated instruction,
with the authored message as its fallback; the tail seam was written before that
fix and nobody carried it across. It does now, through the same shape and with
the same reachable fallback — a value carrying the `"` that ends the message
makes the re-parse miss, and the author's words with the placeholder in them are
better than none. Which says something about the pattern rather than about
either site: "the claim is the author's, the message is the reader's" is a rule
that has to be applied at every place a claim carries a string, and two
grammars means two places that each look complete on their own.

The second was decision 12's `[skill:]` twin. Round two fixed `[tool: …]
otherwise continue` — parsed a tail, ran the tool, dropped the tail in silence —
and `[skill: …] otherwise continue` is the identical defect one directive over:
`parseInvocation` returns `trailing: " otherwise continue"` and nothing reads
it. The fix is one predicate and one refusal that names whichever directive it
found, rather than a second copy of the first: the skill half was missing for
exactly as long as the two halves would have been separate.

The third is the repair call sites in `src/codebehind/` — fixed in parallel
with this round by the agent that owns those files.

## Known limitations

- **An amber ✗ does not survive a data-row boundary.** Each row clears the
  file's statuses and the run's amber-line memory together — `clearStatusesFor`
  must clear both, or the NEXT run would refuse to paint a green ✓ on a line
  this one tolerated — and what puts a failure back at the end of the loop is
  the row summary, which carries only `fail`. So a step tolerated on row 1 has
  no amber mark left once row 2 paints it, and a run whose rows all tolerated
  the same step ends with that line wearing whatever the last row gave it.
  Fixing it means a `tolerated` flag on the row-summary message and a third
  status for the summary to apply. Until then the run log is where a tolerated
  failure on an earlier row is still visible, and the report — which counts
  rows, not marks — is unaffected.

- **The whole-file review pass is a no-op on a test that quotes one of its own
  values** ([issue 056](../issues/056-whole-file-review-is-a-no-op-when-a-test-quotes-its-own-value.md)).
  `compile.ts` guards the review with every parameter value in play, and the
  review has no single authored line to read, so it gets none of the per-step
  `authorQuotedLiterals` exemption. `Set {{a}} to "peanuts"` puts `a=peanuts` in
  the run's parameters and step 9's entry must contain `'peanuts'`, so every
  revision the reviewer returns is rejected — *the revision inlines a — the
  generated file stands* — on every compile of the fixture this story added. Not
  a false pass: the PRE-review file stands, and it was generated and replayed
  under the guard that does have the exemption. What is lost is the tidy-up, and
  the fix is the union of `authorQuotedLiterals` over every bound step's source
  at both review sites (`compile.ts`, `live-compile.ts`).

- **`[tool:] otherwise …` is still silently dropped on the paths the validator
  does not see** ([issue 057](../issues/057-tool-call-under-a-tail-is-still-silently-dropped-off-the-validated-path.md)).
  Decision 12's refusal is a `## Steps` refusal. A hook line does not get it
  (`extractHooks` checks the flow-control claim and nothing else, and the CLI
  hook loop excludes a `toolCall` from the tail), nor does a `[skill: …]` body
  read at run time, nor the raw Sessions API (`session-manager.ts` dispatches the
  tool off `originalStep`; only the contradiction is refused), nor MCP
  `run_steps` through that same loop. Each of those loops already reads the
  authored line before it dispatches anything, and already refuses the
  contradiction there, so it could refuse this as cheaply — one
  `failureTailDirective` call beside the one it makes.

### What the compile showed

The live compile of the fixture found the one thing the design had not said
out loud: a deliberate failure on the RECORDING run is evidence, not a defect.
`steptix compile failure-outcomes-live.md --all` recorded step 9, the model
answered `fail`, the run ended — and the compiler called it *Record stopped at
step 9*, dropped it and everything after it, and told the author *Step 9 failed
under AI … Fix that step, run, and compile again for the rest*, over a step
that had done exactly what its line says. Four seams had to agree that the run
ending as written is a complete run: `usablePrefix` now ends the prefix AFTER a
deliberate failure rather than before it, so the step is in the selection and
compiles; the record phase says *ended at step 9 as its text says — <the
author's message>; compiling 7 step(s) up to it (step 10 not attempted)* and
each unreached step gets its own line, *not attempted: the run ended at step 9
as its text says (If {{a}} is "peanuts" then fail …)*, with no `stoppedAt` in
the summary at all, which is what keeps the CLI's *fix that step* advice off a
step with nothing wrong with it; `failureOf` ignores a deliberate failure the
recording also made, so the proving replay reports *9/9 replayed as code — the
run ended at step 9 as its text says*, marks the entry PROVEN, and spends no
repair round burying the author's sentence under an `ai: true` write-off; and
the status is `partial` when steps were left unattempted, `green` when the
ending step was the last one. Two smaller things were load-bearing and neither
was visible from the design: `actionsOf` dropped the recorded `fail`
sub-action, because it carries an `error` and the filter reads an error as "the
action did not happen" — for this action the error IS the product, so the step
reached generation with an empty transcript and `refuseReason` answered *the
recorded run performed no page actions for this step*, which is the exact
opposite of what happened; and the prompt opened *A natural-language test step
just passed under AI control* above a transcript showing a `fail`, which invites
the model to decline. Both are read off the transcript now, never off the claim,
because the same claimed line answers `noop` on a run where the condition does
not hold and that run really did pass. `generationRefusal` takes the deliberate
failure on the live path for the same reason the boxed one does, while an entry
that already fails the run in the author's words is still *the step ran as
code*. The recording on disk stays honest — a deliberate failure makes it a
`failed` recording, flag and all — and nothing refuses a compile over that.

And then it had to be fixed a second time, because there are two compilers
reading one recording and only one of them had been told. `steptix compile` reads
it off the file; a Steptix Run & Compile reads it off the run it is riding,
and the server's live path picked the step to caption the compile with by
asking for the first failure that was neither interrupted nor tolerated —
`deliberate` was not in the filter. So the same fixture that made the boxed
compiler say *ended at step 9 as its text says* made the live one hand
`stoppedAt: { step: 9 }` to `finish`, and the two client surfaces that word
themselves off that field said *Step 9 failed under AI … Fix it, run, and
compile again for the rest* and *stopped at step 9* over the identical step.
The split is made once now, in the loop, into an `endedAsWritten` that travels
beside `stoppedAt` and never with it, and the sentence itself — `the run ended
at step N as its text says` — moved to where both compilers import it rather
than being spelled twice. Two things pinned it, and neither was the unit test
that existed: the hand-built `finish({ stoppedAt … })` in
`codebehind-live-compile.test.ts` asserted the defect as if it were the
contract, which is how a compiler and a loop agreed on the wrong field in a
suite that was green; and `partialNotes` printed `notAttempted` only inside its
`stoppedAt` branch, so the naive fix — drop the field — would have taken the
list of unrun steps away with it and, with nothing attempted, called a compile
`green` over steps that have no entry at all. The renderers are pinned through
the real entries now (an api-server Run & Compile POST, the extension's fold
with `FakeApiClient`), and the two log-line-and-notification functions moved
into a vscode-free core, because sitting either side of a `vscode` import is
why nothing pinned them before.

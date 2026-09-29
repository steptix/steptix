# Compile loops, and compile the conditions that drive them

**Status:** built, 2026-09-26. The runtime (condition entries decide guards),
Run & Compile / Compile This Step (generation, the live compiler, the
recording) — see §"What the live half decided" — and the boxed `steptix compile`
and `POST /codebehind/compile` — see §"What the boxed half decided". The
Steptix live pass (`steptix-vscode/tests/integration/live/compile-loops.test.cjs`)
passed first time, 2/2: Run & Compile of `control-flow.md` and
`control-flow-otherwise.md`, apply, replay — every `If` / `Else if` /
`While` / `Repeat` decided by its condition entry, no condition-judge call in
the replay's report, every loop still exactly three passes. Review rounds 1,
2 and 3's fixes are recorded where they changed a decision: "The guard", "The
run loops", decision 11, and both "decided" sections below.

## In plain terms

A test can loop (`While`, `Repeat … until`, `For each`) and decide (`If`,
`Else if`, `Otherwise`) since [control-flow.md](control-flow.md). Code-behind
cannot follow it there. Today:

- **Compiling a file that loops is refused outright.** `steptix compile` refuses
  the whole file; Run & Compile in Steptix refuses whenever the steps it
  would compile touch a loop. The advice is to compile around the loop or
  remove it. Decision 12 of the control-flow story named the missing piece —
  "recording pass 1 and replaying the rest, the way rows record row 1, is its
  own story". This is that story.
- **Every condition asks the model, every time.** A compiled test still pays a
  model call for each `If` chain it reaches and one per pass of a `While` —
  a three-pass `While` is four calls on a run that is otherwise pure code. A
  project with `ai.allowInRuns: false` cannot run such a test at all: the first
  condition that has to look at the page fails. (A condition that only compares
  values — `If {{plan}} is "pro"` — is already decided without a model, and
  stays that way.)

After this story, both halves compile:

- **The steps inside a loop get code-behind** — one entry per authored line,
  generated from the first pass that ran it, and replayed on every pass. What
  changes from pass to pass (a `For each` item, `{{order.id}}`) is read with
  `step.getVar`, never written into the code.
- **A condition gets code-behind too.** `If`, `Else if`, `While` and
  `Repeat … until` lines get an entry whose `condition` function answers
  true or false. A compiled test with loops and decisions then makes no model
  call to decide anything; the only model calls left are the steps the
  compiler kept as AI, as in any compiled file.

### What it looks like in practice

**You write** the fixture that already exists
([templates/init/tests/control-flow.md](../templates/init/tests/control-flow.md)):

```markdown
2. If the Cash checkbox is ticked, then Pay with cash
3. Otherwise, Pay by card
5. While the Next button is enabled, Go to the next page
7. Repeat Click Load more until the Load more button is gone, up to 10 times
11. Read the name of every account in the Your accounts panel [store as: accounts]
12. For each {{account}} in {{accounts}}, Check the account
```

**You click** Run & Compile in Steptix.
**You get:** the run behaves exactly as an ordinary run — the model decides
each condition and performs each step — and the proposal that comes back has
an entry for every step that ran, including the loop bodies, plus these:

```ts
{
  source: 'If the Cash checkbox is ticked, then Pay with cash',
  async condition({ page }) {
    return await page.getByLabel('Cash').isChecked();
  },
},
{
  source: 'While the Next button is enabled, Go to the next page',
  async condition({ page }) {
    const next = page.getByRole('button', { name: 'Next' });
    return (await next.count()) > 0 && (await next.isEnabled());
  },
},
{
  source: 'Repeat Click Load more until the Load more button is gone, up to 10 times',
  async condition({ page }) {
    return (await page.getByRole('button', { name: 'Load more' }).count()) === 0;
  },
},
```

**You click** Run again.
**You get:** every one of those lines paints the code mark (`</>`), the
`While` still runs three passes and the `Repeat` three, the `For each` still
binds Everyday, Savings and Travel in turn — and the run makes no model call
for any of it. The report's guard rows say *decided by code-behind* where
they used to carry the model's reasoning.

**You write** `For each {{account}} in {{accounts}}, Check the account` and
the section body is `Type "{{account}}" into the Search box`.
**You get:** one entry for the body line, generated from the first pass
(Everyday). It reads `step.getVar('account')`, so on the second pass it
types Savings. The prompt told the model the line repeats and that
`{{account}}` changes on every pass.

**You write** the same loop with the fixture's actual body, `Verify the Your
accounts panel has a row for "{{account}}" showing a balance in dollars`.
**You get:** that line is kept as AI (`ai: true`, with the reason as a
comment), and asks the model once per pass. This is the rows story's
placeholder rule, unchanged: a `{{value}}` that appears only in what a step
CHECKS or clicks — never in what it types — is declined, because code
generated from one pass's check would hard-code that pass's answer
([data-driven-rows.md](data-driven-rows.md) §"Code-behind", and its "Open for
review" note on `Click the {{plan}} tab`). Measured on the live run: every
other line of the fixture compiled, and this was the one AI line left.

**You write** an `Otherwise` or a `For each`.
**You get:** nothing to compile on that line, as before. `Otherwise` has no
condition; `For each` reads its list from a variable and never asked a model.
Their tails compile like any other steps.

**You click** Run on a compiled file after the page changed, and the `While`
entry's locator no longer matches anything, so the code throws.
**You get:** the same thing a broken step entry gives you. The model decides
that condition for the rest of the run, the line paints ⚠, the hover shows
what the code threw, and the next compile repairs it.

**You click** Run on a compiled file whose `While` entry is wrong in a way
that does not throw — it returns `true` forever.
**You get:** the loop reaches its cap, and because code (not the model)
decided every pass, the model is asked once whether the condition really
still holds. It says no: the loop ends there, as the model says, and the line
paints ⚠ with *"the code said this still held at pass 25; the page says it
does not"*. (A run with no model available fails at the cap as it does
today, and says the decision was the code's.)

**You run** `npx steptix compile tests/control-flow.md`.
**You get:** the boxed compile records, generates, replays and repairs as it
does for any file. The replay also checks the compiled conditions against the
recording: if the recording's `While` ran three passes and the replay's code
says to run a fourth, that condition's entry fails the replay and is repaired
from the page the model saw on that visit. A `For each` that ran a different
number of passes from the recording's is a warning naming the step that
captured its list — never a failure, because a list may really have changed
between the two runs.

## Decisions

1. **Loop bodies compile, one entry per authored line, from the first pass
   that passed; every pass replays it.** The rule rows already follow
   ("records row 1"), for the same reason: entries are keyed by authored text
   and the key is the same on every pass. The live compiler already does this
   (`takenKeys`). The boxed compiler does not — it keeps the last row per
   expanded index, so it generated from the final pass: the page where the
   `While` had just gone false, and the last `For each` item. It changes to
   the first usable pass. What that pass captured is shown to generation as
   the result to reproduce, and refused if written in — added after a live
   run read a `For each`'s list as nine values where the recording read three
   (see "What the live half decided").

2. **What changes per pass is read, never inlined.** A step inside a loop
   body is generated with a line in the prompt naming the loop and the values
   that change on every pass, and the parameter values shown are the evidence
   pass's own (`StepResult.loop.values`) — not the run's final map, which holds
   the last pass's item.

3. **A looped step is proven only when every pass ran as code.** The boxed
   replay reads every row for an index, not the last. The first pass that
   failed is the one repaired, with that pass's values. A pass that a `return`
   skipped is not evidence against the ones that ran.

4. **A condition compiles to a `condition` entry.**

   ```ts
   condition?: (ctx: CodeBehindContext) => boolean | Promise<boolean>;
   ```

   It returns whether the condition **as written** holds on the page now —
   the same question the model is asked. For `Repeat X until C` that is
   whether C holds (the loop stops when it does). It binds by the whole
   authored line, as every entry does, so editing the tail unbinds it. An
   entry has `run` or `condition`, never both. Lines that get one: `If`,
   `Else if`, `While`, `Repeat … until`. Lines that do not: `Otherwise` (no
   condition), `For each` (a list, never a model call), and the flow-control
   `If … then return|stop|fail` form, which is a STEP whose entry already
   compiles to `if (…) step.exit()`.

5. **At a guard: values, then code, then the model.** A condition decided from
   its own values stays first — it is exact and free. Then code. Then the
   model. For a chain, code decides only when every member being asked can be
   answered without the model — by its values or by its entry. Otherwise the
   whole chain goes to the model, exactly as today. This is the literal rule's
   own "all or nothing" (control-runtime.ts `decideLocally`), for its reason:
   the model is asked one question about the whole chain, first-holds-wins, and
   answering half of it elsewhere is two decisions where the author wrote one.
   Code members are evaluated in order and the first that holds wins; members
   after it are not run.

6. **The page settles before the code reads it** — the same gate the model
   gets (up to 10 s for the page to go quiet for 1 s). A condition is a
   question about the page once it has finished moving; code cannot know when
   that is, and a `While` asked straight after `Click Next` would otherwise
   read page 1's button.

7. **What a condition entry's outcome means.**
   - `true` / `false` — the answer.
   - Anything else returned — broken code (*"returned undefined; a condition
     must return true or false"*).
   - It throws — broken code. The entry is discarded for the rest of the run,
     the model decides that guard (the whole chain), and the guard row carries
     `codeBehindStale` naming the member whose code threw. Under a strict
     replay the guard fails instead; on a keyless or policy-off run it fails
     with the same advice a broken step gets.
   - `step.expect` / `step.fail` — a real failure of the guard, never healed.
   - `step.exit()` — refused, as on any line that does not claim a return.

8. **A coded loop that reaches its cap asks the model once.** The one wrong
   answer a run can catch by itself: code that keeps saying "carry on". If the
   model agrees the condition still holds, the cap failure stands as today (and
   says the passes were decided by code). If it disagrees, the loop ends as the
   model says and the guard is flagged stale with both answers. Keyless and
   strict runs cannot ask, and fail at the cap. The opposite wrong answer —
   stopping too early — does not show up at run time. It shows up in the
   replay (decision 11), or as the next step failing.

9. **The evidence is the page the model decided on.** The condition judge
   already takes a DOM snapshot for each decision; on a compiling run it is
   kept on the guard's result, with the verdict. Per condition, generation is
   shown at most two visits: the first where the condition held and the first
   where it did not — a `While` generated from "enabled on page 1" and
   "disabled on page 4" writes a better check than one generated from either.
   A chain member AFTER the one that held was never asked; it is generated
   from the page with its verdict marked *not asked*, so a chain can still be
   compiled whole (decision 5 needs every member).

10. **Only a condition the model decided is generated.** One decided from its
    values needs no entry — it is free already — and its line is not in the
    compile's scope. A condition on the computer surface stays AI: there is no
    DOM, and a screen read is not portable (SPEC-use-computer.md §9, the same
    rule its steps follow).

11. **The boxed replay checks the conditions against the recording.** Each
    guard's decisions, visit by visit, are compared with the recording's:
    same member selected, same held / did not hold. The first visit where they
    differ fails that condition's entry, and the repair is shown that visit's
    page and both answers. This is the only place a compile can catch a
    condition that answers wrongly without throwing. Run & Compile has no
    replay; the next run proves the entry, as it proves every entry.

    **…and every loop's pass count** (review round 2, revised in round 3). A
    `For each` decides nothing, so a list captured with six items where the
    recording had three runs six passes with every condition answering as
    recorded — measured on a real-model `steptix compile` of `control-flow.md`,
    which said "22/22 passed" and wrote the file without a word. After each
    replay, every runtime loop entry is compared with the recording's: a `For
    each` by its list's length, a `While` / `Repeat` by the passes it made
    before its own decision ended it. Every difference is a WARNING — in
    `summary.warnings`, a `note` event, and the CLI's `Warning:` lines — and
    never a failure, a repair or a write-off. A `For each` whose list an entry
    of this compile captured (and ran as code) names that entry: *step 2
    ("For each …") ran 6 passes on the replay and 3 passes on the recording —
    check the entry for step 1 ("Read …"), which captured the list:
    {{accounts}} was […] on the recording and […] on the replay*. A writer the
    compile does not own — a tool, an AI step, a kept entry — is named as not
    this compile's. Equal counts over different values, and a `While` /
    `Repeat` whose count differs with no condition to blame, are warnings too.

    Round 2 failed the owned case instead: the entry was not proven, its
    repair was shown the recording's list, and after three failing rounds it
    was written off `ai: true` with that list in its comment. Review round 3
    measured what that does to a CORRECT entry: a test that creates a record
    and then loops over every record sees one more on each run, and a loop
    that consumes its list (`mark every unread message read`) reads `[]` on
    the replay — three failing rounds, two repairs, and a right capture
    written off. A count cannot tell a selector that matches too much from a
    list that changed, so it says which step to look at and leaves the answer
    to the author. What stops the wrong selector getting written at all is
    generation being shown the recorded value (see "What the live half
    decided").

12. **Steps a decision skipped are named as not attempted** (closes
    [issue 053](../issues/resolved/053-run-and-compile-does-not-list-an-untaken-branch.md)).
    A `While` that ran no passes, and an untaken branch, leave steps nothing
    recorded. Run & Compile now names them, with their own sentence — *"the
    step did not run — the run decided against it"* — beside the return one.
    A file whose only uncompiled steps are an untaken branch is no longer
    reported "already compiled". An existing entry in such a step is left
    exactly as it is.

13. **Summaries count expanded steps and entries, never passes.** A body step
    whose entry ran cleanly on three passes is one kept step, not three.
    `kept` and `keptAi` count distinct expanded steps per entry; a table row
    loop (unrolled at expansion, one index per iteration) is unchanged.

14. **The recording holds one row per expanded step: the evidence pass.** On
    disk, `step-NN.json` is the first usable pass, not the last; the manifest
    counts expanded steps; a guard row records its decision. Compile This
    Step's splice takes the same row, instead of appending one slot per pass.

15. **Steptix paints a guard's code mark and ⚠ from the guard's own
    events**, which now carry `fromCodeBehind` / `codeBehindStale`. The ✓ a
    section tail's `frame:pop` paints on its call line no longer paints over a
    code mark or ⚠ the guard put there in the same run. A guard and a
    plain-instruction tail share one line (`Repeat Click Load more until …`),
    so the gutter shows whichever finished last — for an `If`, the tail's; for
    a `Repeat`, the guard's. The panel and the report show both.

16. **The Electron runner is unchanged.** It runs no code-behind for any step
    today, so its conditions keep asking the model.

## Design

### The entry, loading and running it

- `src/codebehind/types.ts` — `StepCodeEntry.condition`. The `defineSteps`
  docs gain a condition example.
- `src/codebehind/loader.ts` — an entry is kept when it has `run`,
  `condition` or `ai: true`. Both `run` and `condition` → warned and dropped
  (it cannot mean both). Loading does not know which lines are guards; a
  mismatch is caught where the entry is used:
  - a `condition` entry bound to an ordinary step → warn once, the step runs
    under AI, nothing is flagged stale (the entry is not broken, it is in the
    wrong place);
  - a `run` entry bound to a guard → the same, and the model decides.
- `src/codebehind/execute.ts` — `runCodeBehindCondition` beside
  `runCodeBehindEntry`: same context, same step API, returns
  `{ status, value?, error?, expectationFailed, nonRetryable…, logs }`.
  `entrySourceText` reads `condition` too. `makeStepApi.getVar` maps a DOTTED
  name through its root's skill rename, so `getVar('order.id')` works for a
  `For each` inside a skill body (today it answers `undefined` there; the
  scoped key is `__skillN_order.id`). Review round 1 fixed its precedence to
  the flat name's — full-name rename, inputs, renamed root, bare, env — so an
  outer `For each {{order}}` in the live map no longer answers the dotted read
  while the flat one answers the inner item; generation's `stepParameters`
  resolves `{{order.id}}` in a skill body through the same rule
  (`dottedThroughRename`, parser/parameters.ts), so the prompt names it and the
  leak guard holds its value.
- `src/runner/step-executor.ts` — the context-building half of
  `runCodeBehindStep` (tabs, browsers, active session) is shared with a new
  exported `runConditionCode(binding, opts)`. `evaluateConditions` returns
  `evidence: { dom, url }` for the poll that decided: the snapshot the model
  was shown (already masked for the model), and nothing on the computer
  surface.

### The guard — `src/runner/control-runtime.ts`

`evaluateGuard` takes an optional `codeBehind`:

```ts
codeBehind?: {
  bindingFor(index: number): CodeBehindBinding | undefined;
  strict?: boolean;       // compile replay: never heal
  keyless?: boolean;      // no model to heal with
  keylessReason?: …;
  captureEvidence?: boolean; // a compiling run: keep the judge's snapshot
}
```

Order per decisions 5–8: `decideLocally` (unchanged) → the code path → the
judge. The code path runs each asked member in order (literal answer if the
member is literal, else its entry), stopping at the first that holds, and
settles the page right before the FIRST entry runs — not before a literal
member that holds ahead of every entry. A throw discards that binding's entry
and falls through to the judge for the whole chain. The cap check runs before
the planner is consulted, so the planner's state is only ever advanced once.

Settled in review (round 1):

- **`decidedBy: 'code'` means an entry ran.** `If {{plan}} is "pro"` holding
  ahead of an `Else if` with an entry is decided by values — `decidedBy:
  'values'`, no code mark, the values' own reasoning, and no page settle.
- **A judge that throws at the cap check is not the code's failure.** The cap
  failure stands as on a keyless run, with the judge's reason in the note
  (*"…and the model could not be asked to check it (…)"*); an abort still
  rethrows.
- **`step.fail()` in a condition is deliberate**, carried from the condition
  outcome through `GuardEvaluation` / `guardResult` to the row and the guard's
  `step:fail`, as the step path carries it.
- **A Stop during a condition entry is a stop.** An entry that fails while the
  run's signal is aborted (the Stop closed its page) rethrows `AbortError`: no
  stale flag, no failure, on keyed and keyless runs alike.

`GuardEvaluation` and `guardResult` gain the step fields a code-behind step
already has — `fromCodeBehind`, `codeBehind: { file, code, logs }`,
`codeBehindStale`, `codeBehindHealSkipped` — and one new structured field on
`StepResult`:

```ts
guard?: {
  decidedBy: 'model' | 'values' | 'code';
  /** A chain: the absolute index of the member that held, or null for none. */
  selected?: number | null;
  /** A loop condition: whether it held, as written. */
  holds?: boolean;
  /** Only on a compiling run, only when the model decided. */
  evidence?: {
    dom: string;
    url: string;
    /** Each member asked on this visit: true, false, or absent = not asked. */
    members: Array<{ index: number; holds?: boolean }>;
  };
};
```

The verdict was prose until now (`aiExplanation`), which is why the replay
could not compare it.

### The run loops

- **Server** (`session-manager.ts`) and **CLI** (`test-runner.ts`) pass
  `codeBehind` to `evaluateGuard` with the batch's registry — the same
  registry, strict flag and keyless flag the steps get; none when code-behind
  is off for the batch (`compile: 'steps'`, `codeBehindOff`). The server's
  guard `step:pass` / `step:fail` carry `fromCodeBehind` / `codeBehindStale`.
  Both sidecar writers record the guard row; a stale MEMBER that is not the
  row's own line gets its own stale row, keyed to that member's binding, so
  `--only-stale` and the repair find the right entry. So does a skipped row's
  OWN line: a chain with no `Otherwise` whose head's entry threw and where
  nothing held has its head as both the skipped row and the broken member, and
  the server's writer (which writes nothing for a skipped row) lost it — both
  writers now write the same stale row for it.
- **Electron** — unchanged (decision 16).
- The server's one-shot F11 flag is consumed at the top of every iteration,
  guards included; stepping into a condition entry is not wired (non-goal).
  An F9 breakpoint inside a `condition` function works as in any entry.

### Live compile — `src/codebehind/live-compile.ts`, `session-manager.ts`

- The loop refusal goes (`firstLoopInRange`, `loopCompileRefusal`).
- The plan marks a guard line with a compilable condition as a step — not
  `dispatched`, in scope by the usual rule (no entry, or stale). `Otherwise`
  and `For each` stay `dispatched`.
- New `offerGuard(input)`: the guard row's members, the evidence, the
  stale member if any, and a parameter snapshot. It accumulates per member
  key — a guard visited 25 times offers 25 times — keeping the first held
  and first not-held observation (decision 9). A member decided by code,
  cleanly, is kept; one decided by values is not offered.
- The accumulated conditions are queued in `runStepsEnded`, when every visit
  of the block has been seen, through the same serialized queue, `takenKeys`
  and `writtenKeys` as step entries. They count in `compiled`, `total` and
  the progress frames like any entry.
- `emitSkippedStep` offers decision-skipped rows with their cause
  (decision 12, issue 053's three pieces).
- `kept` / `keptAi` count distinct expanded indices per key (decision 13).
- `generationRefusal` still refuses a control line offered through `offer`:
  a `run` entry generated for an `If` line would replace a decision with
  code that acts.

### Boxed compile — `src/codebehind/compile.ts`, `compile-runner.ts`

- The loop refusal goes (`firstLoopGuard`).
- `CompileRunOutcome` keeps every row per index (`passes`), beside `steps`
  = the evidence row per index (first usable pass; decision 1).
- `describeSteps` makes a guard member with a model-decided-able condition a
  compile step of kind `condition`; `selectSteps` selects it by the same
  rule. Generation reads the observations off the Record's guard rows.
- `markRound` and `failureOf` read every pass; the first failure in
  execution order is the one blamed and repaired, with its own pass values.
  A failed guard row is blamed on its condition entry when code decided it,
  and never as "recompile it with `--steps N`" for a line that has none.
- The condition check (decision 11) runs after each replay.
- The POST `/codebehind/compile` route sends `test.steps` — already
  expanded, guard lines included — to a server that re-expands whenever a
  step parses as a control line. That route has never been exercised with a
  control line; it is tested here before loops are allowed through it, and
  fixed if the tail is expanded twice.

### Generation — `src/codebehind/generate.ts`, `src/ai/prompts.ts`

`generateConditionEntry` beside `generateStepEntry`, with its own prompt
(`buildConditionCodePrompt`). What the model is told:

- the whole authored line, the condition part on its own, and what the
  answer does (an `If` runs its tail when true; a `While` continues while
  true; a `Repeat … until` stops once true);
- each observation: URL, the DOM the model decided on, and *held* / *did not
  hold* / *not asked — an earlier condition held*;
- the parameters the condition references, as `step.getVar` names;
- the candidate file, so selectors and helpers stay consistent.

The rules: write `async condition({ page, step })` and return a boolean; read
only — no click, fill, press, check, select, upload, navigation, keyboard or
mouse; answer about the page now — no `waitFor`, no waiting for the state to
arrive, because the framework has already waited for the page to settle; an
element that is absent is an answer, so check `count()` before a call that
waits for its element (`isEnabled`, `isChecked`, `textContent`); resolve to one
element; read values with `step.getVar`, never inline them.

Static checks, one re-ask shared between them as for steps: the entry has
`condition` and no `run`; no action or wait call; the existing leak guard.
`undeclaredContextComplaint` learns the `condition({ … })` destructure.

The step prompt gains the loop line for a looped step (decision 2).

The review pass is told condition entries exist: keep them conditions, keep
them read-only, never turn one into a `run`.

### Steptix — `steptix-vscode/`

- `frame:pop` repaints the call line with the guard's own mark when the
  guard painted `pass-code-behind` or `pass-stale` on it earlier in this run.
- The compile result line no longer reads "✓ Nothing to compile" for a
  refused compile (`compile-summary-core.ts`: honour `status`).
- Nothing else: the guard's events carry the fields every surface already
  reads; Repair on a ⚠ guard line reaches `compile: 'steps'`, which the
  server now accepts for a guard. One addition from review round 1: a skipped
  `step:pass` that carries `codeBehindStale` (a chain member whose condition
  code threw on the visit that took another member) paints ⚠ rather than ◌,
  hovering with both facts — see "What the live half decided".
- Patch bump.

## Tests

- **Runtime:** a hand-written `condition` entry decides a `While`, a
  `Repeat … until` and a chain on the CLI and through the real HTTP entry; the
  model is not called; the guard row carries `fromCodeBehind` and
  `guard.decidedBy: 'code'`. A chain with one member uncompiled goes to the
  model whole. A throw heals and flags the right member stale; strict fails;
  keyless fails with the advice; a non-boolean is broken code; `step.expect`
  fails the guard. The cap net: a condition that always returns `true` asks
  the model once at the cap and ends the loop where the model says. A
  `condition` entry on an ordinary step and a `run` entry on a guard both
  warn and fall back without a stale flag. Dotted `getVar` inside a skill.
- **Live compile, through the real HTTP entry** (`api-server-*-compile`
  pattern): a `While` whose body runs three passes generates ONE entry per
  body line, from pass 1, with pass 1's values; a `For each` body's prompt
  names the per-pass value; the guard gets a condition entry generated from
  one held and one not-held observation; `kept` counts a clean three-pass
  step once; a `While` that runs no passes names its body in `notAttempted`
  with the decision sentence; the untaken branch likewise (issue 053's own
  list); an existing entry in an untaken branch is untouched; Compile This
  Step on a guard line generates its condition and nothing else.
- **Boxed compile:** a loop compiles green; the entry is generated from the
  first pass; a replay whose condition answers differently from the recording
  fails that entry and repairs it; a failed replay pass blames the right
  pass; a `For each` that runs a different number of passes warns, naming the
  step that captured its list, and fails nothing; the `/codebehind/compile`
  route with a chain and with a loop.
- **The fixture:** Steptix live — Run & Compile
  `templates/init/tests/control-flow.md`, apply, Run: every guard line that
  has a condition paints the code mark, loop counts unchanged, no
  `condition-judge` interaction in the report. `control-flow-otherwise.md`
  the same for its `Else if`.

## Non-goals

- Compiling the Electron runner's conditions (it runs no code-behind).
- Stepping into a condition entry with F11 from the guard line.
- Merging a chain's members into one entry. One line, one entry.
- Evidence beyond the first held / first not-held visit.
- Verifying a Run & Compile's conditions before the next run.
- Compiling the watch form (`If a banner appears, dismiss it`, no `then`).

## What the live half decided

Where building Run & Compile and Compile This Step had to choose something the
sections above leave open.

- **Compile This Step on a guard line compiles the condition, and runs the
  body.** A selection ending on a guard's own line is the guard: its tail is
  invoked FROM that line, so the end anchor resolves past the guard into the
  tail, and the control-structure snap then runs to the end of what the guard
  opens. The run keeps both — a decision needs its consequence, and a
  `Repeat`'s condition is not asked until its body has run once, so without
  the body there would be nothing to generate from — but the compile's slice
  ends at the guard (`selectedEndIndex`). The body runs under AI and is not
  generated, named or counted. The same holds for a plain-instruction tail
  that shares the guard's line: Repair on a ⚠ guard reaches this path, and
  it is the condition that broke.
- **A selection inside a loop body runs more passes than it selected.** A run
  starting in a body counts that partial pass as pass 1 and returns to the
  guard; the guard is visited and its later passes run. None of it is outside
  what compiles: the guard and anything past the selection are out of the
  slice (the live compiler's `outside` set, `'steps'` mode only).
- **Observations wait for the block, not the run.** A condition is queued in
  `runStepsEnded` — once per request. A run split by a breakpoint inside a
  `While` generates the condition from what the first block saw; the second
  block's visits of the same key are the same entry arriving again, as a
  step's are.
- **A member with a working condition entry that the model decided anyway is
  left alone.** In a chain where one member has no entry, the whole chain goes
  to the model (decision 5), so the member WITH an entry did not run. It is
  neither kept (its code did not run) nor regenerated (nothing says it is
  wrong); its sibling is generated, and the next run decides the chain by
  code.
- **The loop line names the innermost loop only.** A step in a `While` inside
  a `For each` is told about the `While`; the `For each` item is still read
  with `getVar` because it is a reference in the step's own text, shown in the
  parameter block with pass 1's value.
- **An existing entry in an untaken branch counts in `totalSteps` and nowhere
  else** — not `kept` (its code did not run), not `keptAi`, not `unproven`,
  never `notAttempted`.
- **A condition judged on the computer surface is not offered** — as a
  computer-mode step is not, on this path. `generateConditionEntry` still
  declines one with no DOM, for a caller that asks anyway.
- **The ⚠ goes on the line whose entry broke** (review round 1). When a chain
  member's condition entry throws and the model then takes ANOTHER member, the
  broken member is one of that visit's skips, so its `codeBehindStale` rides its
  own `step:pass output:'skipped'` (the server threads a per-index stale map
  beside `skipReasons` into `emitSkippedStep`, consumed on emit); the member
  that held carries no stale flag. When the broken member IS the guard row's
  line — a loop's guard, or a head where nothing held — it rides the row's own
  event as before. Steptix paints a skipped pass carrying `codeBehindStale`
  ⚠, not ◌ (`passMarkFor`, guard-mark-core.ts), with a hover that says both
  facts — the skip reason, then what the condition's code threw — and so
  offers "Repair this step" on that line. The detail carries the reason as
  `StepFailureDetail.notTaken` (runner-core), which is also what keeps the two
  run tallies (the `## Steps` heading and the panel header) counting that line
  as skipped and stale rather than passed. The report row is unchanged: it
  still carries the flag and `guard.staleMember`, which is what the sidecar
  writers and the compilers key on.
- **Every surface says both facts of a skipped ⚠** (review round 2). Round 1
  painted and hovered it; the text surfaces still printed a plain ◌ skip, and
  the `## Steps` heading read *"2/3 passed (1 stale), 1 skipped"* — a
  parenthesis that breaks down the PASSES claiming the one line that did not
  run. One rule now, on every surface: a parenthesis breaks down the count it
  follows, so the heading and the run log's tally say *"2/3 passed, 1 skipped
  (1 stale)"* / *"✓ 2 passed, 1 skipped (1 stale)"* (`staleSkipped` beside
  `stale`, which counts stale passes only), and the run log's heal lines count
  it (*"1 condition(s) whose code-behind failed were decided by the model
  instead."*, then the Repair line). The per-line text — run log, Test
  Explorer's output, the compile log, the panel's log — leads with ⚠ and
  mirrors the hover: the skip reason, then *"; condition code-behind failed:
  <what it threw>"* (`step-skip-core.ts`, the panel's mirror pinned by the
  parity test). The panel header's flat `⚠ 1 stale  ◌ 1 skipped` already said
  both and is unchanged. A skipped pass WITHOUT `codeBehindStale` renders
  byte-identically on every surface.
- **A condition entry never breaks a hard rule** (review round 1). A hard rule
  is what `conditionEntryComplaint` checks — a `run`, no `condition`, or a call
  that acts, navigates, types or points, waits, touches a tab or browser, or
  writes a variable. After its one re-ask, `generateConditionEntry` returns an
  error naming the rule when neither answer is clean — it no longer falls back
  to the first answer, or returns a second that still breaks one with a
  warning. A soft complaint (an undeclared context property) keeps the step
  path's fallback: re-asked once, then the answer stands.
- **The complaint reads the receiver, not the word** (review round 1). Since a
  hard violation is now fatal, a false positive costs a compiled condition.
  `run` / `condition` are read off the entry object's own keys (so
  `helpers.run(page)` and `x ? run : y` are not definitions). Page actions —
  `click`, `fill`, `check`, `clear`, `close` and the rest — are refused only on
  a Playwright receiver: rooted at or passing through `page` / `frame` /
  `context` / `browser`, a `locator(…)` / `getBy…(…)` / `frameLocator(…)` /
  `$(…)` chain, or a name bound from one (a fixpoint over `const x = …` and
  `for (const x of …)`); a freshly constructed object (`new Array(3).fill(0)`)
  never is, and a receiver nothing identifies is let through. The keyboard,
  navigation, waits, any `tabs.` / `browsers.` call on any receiver (a local
  named `tabs` excepted) and any `setVar` on any receiver stay refused
  outright. A page function (`evaluate`, `evaluateAll`, `evaluateHandle`,
  `$eval`, `$$eval` — function or string) is refused when it clicks, submits,
  dispatches, focuses, inserts or removes DOM, writes an attribute, moves
  history or location, or assigns any property. Pinned by a corpus of good and
  bad entries in codebehind-condition-generation.test.ts.
- **The heuristic's rules, as review round 2 narrowed and closed them.** Round
  1's version, read against real entries, both refused reads and let actions
  through; since a hard complaint is fatal, each false positive was a failed
  compile. The rules now:
  - *Tabs and browsers:* only the calls that change which page the run is on
    are refused, on any receiver, a local alias included — `tabs.open` /
    `openedBy` / `switchTo` / `close`, `browsers.open` / `switchTo` / `close`.
    The reads — `tabs.list()`, `tabs.active()`, `browsers.list()`,
    `browsers.activeLabel()` — answer a question about the run and pass
    (`If a second tab is open, …`). The "local named `tabs`" exemption is gone
    with the blanket rule it existed for.
  - *Receivers:* a Playwright receiver is also one reached through `?.`
    (`el?.check()`, `page.getByRole('button')?.click()`), a name assigned
    after its declaration (`let b; b = page.locator(…)`) or declared with a
    type (`const b: Locator = …`), an element of an
    array literal (`[page.locator('a')]`), or `tabs.active()`. A name bound
    from a value READ — `await locator.count()`, `allTextContents()`,
    `title()`, a comparison — is data, so `Array(n).fill(false)` passes. The
    page's context-changing calls (`setContent`, `route`, `clearCookies`,
    `newPage`, `setViewportSize`, …) join the refused actions, on a
    Playwright receiver only.
  - *Page functions:* a page function passed by NAME is resolved to the
    function the entry defines under it (`const act = () => …;
    page.evaluate(act)`, a `function act() {…}`, a name bound to another
    name) and judged like an inline one. An assignment is refused only when
    it writes page state — a DOM state property (`checked`, `value`,
    `selected`, `disabled`, `textContent`, `innerHTML`, `className`, `hidden`,
    `src`, `href`, `title`, `cookie`, `on…`, and the rest of that list),
    `style.*`, `dataset.*`, the bracket form of any of them, or the location —
    and never when its receiver is a local the page function built itself
    (`const r = {}`, `[]`, `new Map()`, a literal). Destructuring
    (`const [next] = …`), `acc[k] = …` and `out[0] = …` change nothing and
    pass. Storage writes, `document.write`, and `style.setProperty` are
    refused calls.

  Review round 3 found four more places the rules above said the wrong thing,
  each measured with the reviewer's corpus against the round-2 build:
  - *A value that is one of several* (G5). `n > 1 ? rows.nth(1) :
    rows.first()`, `n > 0 && page.locator('tr').first()` and `a ||
    page.getByRole('row')` were read as data because a comparison sits at
    their top level, so a `.click()` on the result passed. A conditional's
    branches and a `&&` / `||` / `??` chain's operands are now judged one by
    one — a receiver when any of them is — before the top level is read for a
    comparison; the condition of a `?:` is never the value. A TypeScript type
    argument (`page.evaluateHandle<HTMLElement>(…)`, `page.$<HTMLInputElement>(…)`)
    is not a `<` comparison: a `<…>` right after a name, spelled only with
    type characters and followed by `(`, is skipped (`typeArgumentsEnd`).
  - *A page function's local built from the page* (G6). `const boxes =
    [...document.querySelectorAll('input')]` is an array literal, so
    `boxes[0].checked = true` counted as a write to a local and passed. A
    local whose initialiser yields DOM nodes — a query (`querySelector…`,
    `getElementById`, `getElementsBy…`, `closest`, `elementFromPoint`), a
    node's neighbours (`children`, `parentElement`, …) or a document
    collection (`document.body`, `forms`, `elements`, `options`, `rows`, …) —
    is the page: a DOM-property write through it is refused. `rows.sort()` on
    the same array is a JavaScript call and still passes; `document.title` in
    an initialiser is a string and does not make it the page.
  - *A local named `location`* (G7). The location rule matched `location =`
    anywhere, so `const location = document.querySelector('.loc')
    .textContent; return location === 'Sydney'` was refused as a navigation —
    fatal since round 1. A write or a move (`assign` / `replace` / `reload`)
    of a BARE `location` is refused only when the page function declares no
    local of that name, and a declaration is never a write; once one exists,
    `location.replace(/\s/g, '')` is that string's method. `window.location`,
    `document.location` (and `self.` / `globalThis.` / `top.` / `parent.`) are
    the page's whatever the function declared.
  - *Tabs and browsers through an alias* (G8). The bullet above claimed "a
    local alias included", and only a local NAMED `tabs` was: `const t =
    tabs; await t.switchTo(…)` and `{ tabs: tb }` then `tb.close()` passed.
    The rule now follows the entry's aliases (`contextAliases`, to a
    fixpoint): a destructure that renames the property (`{ tabs: tb }` in the
    parameter or `const { tabs: tb } = ctx`), a local bound or assigned to it
    or to a member ending in it (`const t = tabs`, `let b; b = ctx.browsers`),
    and an alias of an alias. A method destructured off it (`const { close }
    = tabs; close()`) is not followed — the one shape the claim does not
    cover.
- **The review pass keeps a condition a condition** (review round 1). Every
  entry that was a `condition` entry before the review must still define
  `condition` after it and pass `conditionEntryComplaint`; a revision that
  breaks one is rejected the way the review already rejects its other
  violations — the whole revision of that file, with *"rejected: the revision
  turns the condition entry for … into something that is not one"* (or
  *"breaks the condition entry for …: <complaint>"*), and the generated file
  stands. Review round 2 narrowed it to what the REVIEWER did: an entry whose
  code the revision left as it was (whitespace aside) is not judged, so a
  hand-written condition the stricter check dislikes no longer blocks every
  review of its file; an entry the revision rewrote, or turned into or out of
  a condition, is.
- **Repairs are told about the loop, on both paths** (review round 2). The
  boxed `repairStep` and healed-pass repair, and the live `askForRepair`, now
  hand `buildRepairPrompt` the same loop block the step prompt carries
  (`loopContextFor`): the line repeats, and `{{account}}` changes every pass.
  A repair told neither wrote the failing pass's item into the code.
- **The live prompts mask with the run's mask set too** (review round 2). The
  generation, condition and repair prompts both compilers build pass
  `runSecrets` over their snapshot to the parameter block, beside the marked
  map, so a secret inside a value no key names as secret (`auth: "Bearer
  <the key>"`) is masked there as the run's own step prompts mask it.
- **…with the step's frame inputs, and the loop mark read under the name the
  map holds** (review round 3, both paths). Two gaps in that set:
  - *Frame inputs* (G3). The run's `secretsNow` merges every frame's inputs;
    the compilers' set was the parameter map's alone, and a skill's arguments
    exist under no name there. `[skill: api token="uk_live_1234"
    header="Bearer uk_live_1234"]` with a body `Type {{header}} …` showed the
    generation prompt `"Bearer uk_live_1234"`. Both compilers now build every
    prompt's set with `compilePromptSecrets` (generate.ts): `runSecrets` over
    the snapshot, plus the binding's `scope.inputs` resolved as the step's own
    references resolve them and judged by their names (with the snapshot's
    loop marks inherited, as `secretsNow` does for its merge). The boxed
    compile's own words — its warnings, and every replay error it repeats
    (the `✗` line, the summary, the repair prompt, a write-off comment in a
    committed file) — are masked with every binding's inputs, since the CLI
    run's error text never was.
  - *A dotted name in a skill body* (G2). The fold (and the live map) mark
    the SCOPED key a pass bound, `__skill1_row.keyword`; the parameter block
    asked about the AUTHORED `row.keyword`, which nothing marks, so the author
    rule masked `AU` (`keyword` holds `key`). `stepParameters` now carries the
    key it resolved the value from (`bound`, set only for a dotted name read
    through its root's rename), and `formatParameterBlock` asks the marks
    about that.
- **"The step did not run" is said once per entry, and never after
  "generated"** (review round 1). A body line generated on pass 1 and decided
  against on pass 2 owes nothing, and its skip no longer logs the refusal after
  its own "generated" line; a line skipped on every pass says it once.
- **Generation is shown what the recording captured, and may not write it
  in** (after the live pass). A real-model Run & Compile of `control-flow.md`
  compiled step 11, `Read the name of every account in the Your accounts
  panel [store as: accounts]`, to a locator over each row's spans — the
  outer one, the name and the masked number — so the entry stored nine values
  where the recording's read (`#account-list > li[data-testid="account-row"] >
  span > span:first-child`) stored three, and the replay's `For each` ran nine
  passes without a word. Two of three live runs wrote a correct entry. The
  prompt had named `accounts` and never its value, so the model had nothing to
  check its selector against, and Run & Compile has no replay to catch it
  (decision 11's pass-count check is the boxed compile's, and since review
  round 3 it only warns). Now:
  - Every step prompt and every repair prompt, on both paths, shows each
    capture's recorded value beside its `step.setVar` — a list with its item
    count, JSON as the run stored it — masked exactly as the parameter block
    masks a value (by the capture's name, by record shape, by the run's mask
    set), clipped only after masking. One rule under them: produce exactly
    that value from that page, the same number of items and the same text;
    narrow a selector that would match anything else, preferring the recorded
    read's; never write the value in, even in a comment.
  - Where the value comes from: the evidence row's `outputs`, read through the
    frame's rename (`recordedCapturesOf`) — for a live repair and a healed
    boxed pass, the pass that healed under AI; for a boxed replay repair, the
    RECORDING's row for the pass that failed (`recordedCapturesAt`), never
    what the broken entry stored. (The repair prompt's separate "What the
    recording captured" block, which round 2's pass-count failure filled, went
    with that failure in review round 3.)
  - The leak guard holds each recorded value, and each string item of a JSON
    list, matched as a whole token (`containsAsToken`: `100` is not in `1000`)
    with the usual three-character floor — never `***`, `(empty)`, `true`,
    `false` or `null`, and never a value the step's own line says, quoted (the
    `authorQuotedLiterals` exemption) or as a whole word (`Read the label of
    the Submit button` may find the button by `Submit`). An answer it refuses
    is asked again ONCE, with the reason and its own code, every recorded
    value masked out (`askWithCaptureRetry`); a second refusal is the
    ordinary leak error. Generation's re-ask is shared with its static
    backstops. A parameter leak is refused as before, with no re-ask.
  - The review pass is unchanged: its guard is the whole run's map across the
    whole file, where an item word in another step's entry (`Click the
    Savings tab`) is legitimate.

  What this cannot do is make a model's selector right. The Steptix live
  test therefore keeps the `While` and `Repeat` pass counts strict and only
  warns — naming step 11's entry — when the `For each` does not run three.
- **Known limit: `kept` counts per block.** A run split by a block boundary
  inside a loop body (a breakpoint continuation) can count one body line once
  per block — reported by review, not reproduced through a real client, and
  left as it is.

## What the boxed half decided

Where building `steptix compile` and `POST /codebehind/compile` had to choose
something the sections above leave open, or departed from them.

- **The outcome keeps rows in execution order too, not only per index.**
  `CompileRunOutcome` has `passes` (every row per index) as designed, and
  `rows` (every row, in the order the run made them). Decision 11 needs the
  second: a chain's rows sit on whichever member held, so per-index lists
  cannot say which visit came first. Both are optional — an outcome built by
  hand still means one row per index — and both producers build all three
  fields through one `outcomeRows`, whose evidence row is `evidenceRows`'
  choice, the row the recording on disk keeps.
- **A Record's prefix is judged over every pass.** A body step that passed on
  pass 1 and failed on pass 2 is where the recording broke, as a one-pass
  failure is; pass 1's good transcript does not carry it into the prefix. A
  step skipped on every pass has no evidence; skipped on one and run on
  another, it has.
- **A pass's values are folded forward from the start** (`passSnapshots`,
  revised in review round 1). The Record's final map holds the last pass's item
  AND the last pass's captures. The map as of each row is rebuilt in execution
  order from the compile's starting parameters: each row's loop marker binds its
  pass (clearing the last pass's dotted keys first, as the runtime does), the
  row is snapshotted, then its captured `outputs` are bound for the rows after
  it. So a `[store as: total]` inside the body reaches pass 1's `Type
  {{total}}` as pass 1's total — overlaying the markers on the final map gave
  it pass 3's, and an entry hard-coding pass 1's `$10.00` passed the leak
  guard. The final map fills only names the fold never saw (a skill-internal
  capture, which `outputs` never carries), and never a name whose root the
  fold has bound. One snapshot for the step prompt, the condition prompt and a
  repair — a repair folds over the failing replay's rows, so a body step of a
  `While` inside a `For each` is told the OUTER pass's item too (the innermost
  marker alone, over the final map, told it the last one). A chain's guard row
  carries no marker, so it reads the bindings of the pass the run was last seen
  in — exact on pass 1, and a pass behind if the chain is the first step of a
  later `For each` pass; likewise an outer item reaches the fold only through a
  row that carries the outer marker (a step directly in the outer body). A
  table-row `### Section` gets its own row's values the same way; it used to
  get the last row's.
- **The fold masks what the run masked, and sees every write it can** (review
  round 2). Starting from the RAW parameters undid a mask round 1 did not know
  it relied on: the prompts were built from the CLI's redacted
  `report.parameters` and masked by name only, so a data file's `user.apikey:
  uk_live_1234` heading (§7.6) reached the model as `"uk_live_1234"`. Every
  boxed prompt — generation, the condition prompt, a repair, a healed-pass
  repair — now gets the fold's own snapshot as `parameterMap` (the fold marks
  each pass's dotted bindings as `applyPassBindings` does, so `row.keyword`
  keeps the record rule and a heading gets the author rule) and the run's mask
  set as of that snapshot (`runSecrets`), so a secret inside a value no key
  names (`auth: "Bearer uk_live_1234"` → `"Bearer ***"`) is masked too — what
  the live path's prompts now get as well. The leak guard holds the real
  values. The fold binds a `[tool:]` step's `toolStep.outputs` beside
  `outputs` (a `Set`, a `[use ai]` answer and a code-behind `setVar` already
  ride `outputs`). A starting name whose FINAL value differs though no row
  wrote it — an `[input:]` answer, a hook's capture, neither on any row the
  compile reads — takes the final value from the first row on, as every
  snapshot did before the fold; a final value that is only the start value
  masked (the CLI's `***`) is not a write.

  Review round 3 (G4) found the case that last clause missed. The CLI's final
  map is redacted with the END-of-run mask set; "masked" was tested by
  redacting the start value with the START map's set. So `cb:
  https://app.test/cb?t=abcd1234`, with a later `[store as: api_token]`
  capturing `abcd1234`, came back as `…?t=***`, differed from the start
  value however it was redacted, and was taken for a write: the snapshots and
  the leak guard held `…?t=***`, and an entry hard-coding the real URL passed
  (the fold's predecessor refused it). The secret's real value is in no map
  the compile holds — the CLI redacted the capture too — so no mask set can
  be rebuilt to compare with. The rule is read off the two strings instead
  (`maskedSpans`): a final value that is the start value with some spans
  replaced by the mask, and nothing else changed, is the start value masked —
  never a write, whatever set masked it. (The start value is still also
  redacted with the start and final maps' sets, for the server's raw final
  map and for a record re-stringified by `maskRecordSecrets`.) The snapshots
  keep the REAL start value, so the leak guard holds it; the spans it hid
  (three characters or more — a span is inferred from where the mask sits)
  are `recovered`, and join every prompt's mask set, so the prompt still
  shows `…?t=***` as the run's own did. A final value that differs in any
  other way is a write, as before.
- **Decision 11 checks every loop's passes, not only its decisions** (review
  round 2; every finding a warning since round 3). `loopEntries` reads each
  runtime loop entry off a run's rows — a
  `For each` by its list-reading row, whose pass-1 marker carries the list's
  length; a `While` / `Repeat` counted off its guard rows' decisions (a
  `While` row that holds begins a pass, a `Repeat` row that does not; the
  first answer the other way ends the entry), not its markers. After each
  replay `compareLoopPasses` pairs them with the recording's, entry by entry
  per loop, for the entries that start before `compareDecisions`' new
  `divergedAt` (past it the runs are on different paths), and a `While` /
  `Repeat` only when both runs ended it on its own decision. The first count
  difference ends the comparison. What it finds — every one a warning:
  - A `For each` whose count differs, whose list the replay's rows show was
    last written — `outputs` or `toolStep.outputs`, execution order — by an
    entry of this compile that ran as code: *"step 12 ("For each …") ran 9
    passes on the replay and 3 passes on the recording — check the entry for
    step 11 ("Read …"), which captured the list: {{accounts}} was […] on the
    recording and […] on the replay (a list that changed between the two runs
    does this too, and then the entry is right)"*. The entry is proven as
    any entry is — it ran cleanly on every pass — and proposed as code.
    Round 2 failed it here, positioned it at the loop's entry row, repaired
    it with the recording's value in a *"What the recording captured"* block,
    and wrote it off `ai: true` after `maxRounds`; round 3 removed that path,
    the block and `PassCountFailure` (see decision 11 for why). What guards
    the wrong selector instead is generation and every repair being shown,
    and guarded against, the step's recorded captures (see "What the live
    half decided", *Generation is shown what the recording captured*).
  - A `For each` whose writer is not this compile's (a tool, an AI step, a
    kept entry, or nothing in the replay): *"step 12 (…) ran 6 passes on the
    replay and 3 passes on the recording: {{accounts}} came from step 11
    (…), which is not an entry this compile wrote"*.
  - Equal counts over a different list — naming both values (a list may
    differ between runs).
  - A `While` / `Repeat` whose count differs with no condition mismatch on it
    (the replay's model decided it) — both counts.
  Values are masked as a prompt masks them, with every binding's frame
  inputs (G3). Warnings are the LAST replay round's: `summary.warnings`, a
  `note` event each (the CLI's `[warn]` line, the server's `output` frame),
  and the CLI's summary prints them as `Warning:` lines. They never change
  the status.
- **The evidence pass is the first with a transcript** (`evidenceRows` /
  `isEvidencePass`, review round 1). It passed (or failed as its text says)
  AND it ran under AI — a clean code run has no turns, and is no evidence —
  or its entry threw first and it healed (`codeBehindStale`). A body entry
  that ran as code on pass 1 and healed on pass 2 joins the compile as stale;
  generating from pass 1 said *"the recorded run performed no page actions"*
  and wrote `ai: true` over a working entry, with a green replay under AI. The
  healed pass is now the evidence, and a healed evidence pass goes through the
  repair prompt, as the live compiler repairs from the healed pass: the entry
  as it stands in the file, the error it threw, and the page before the step on
  that pass (plain generation when the entry's text cannot be found). No pass
  with a transcript: the first that passed, else the first row. The recording
  on disk keeps the same row.
- **Known limit: the leak guard's 3-character minimum.** A resolved value
  shorter than three characters is not guarded (pre-existing). Loops make it
  more common — a pass index, a one-digit quantity, a two-letter code per item
  — so an entry that hard-codes such a value per pass is not caught at
  generation; the next pass's replay is what shows it.
- **A condition no model-decided visit asked is not attempted.** Its reason
  says so, with the cause its own skipped row states — *the condition was
  never asked on the recording run (no condition in this decision held)*. A
  condition asked only on the computer surface has visits but no page; it is
  handed to `generateConditionEntry`, which declines it `ai: true` with
  `CONDITION_WITHOUT_DOM` (decision 10).
- **The first failure in execution order is the one blamed**, among the failed
  rows and the first mismatch (decision 11). A mismatch wins a tie with a
  failure on the same row: a `While` whose code says "carry on" where the
  recording stopped is what then breaches the cap.
- **The comparison stops at the first difference, whoever made it.** Past one,
  the two runs are on different paths. It is a mismatch — the entry's fault —
  only when the replay's CODE decided that visit and the member that differs
  is a condition line; a difference the model or the values made ends the
  comparison and blames nothing. A different number of visits with every
  compared answer equal blames nothing either: fewer means the replay ended
  earlier (a step's failure says why), more means an enclosing `For each`'s
  list changed — which the pass-count check (review round 2, above) now
  reports at the loop itself, as a warning. The blamed member of a chain is the first whose
  answers differ, first-holds-wins.
- **The runtime says which member's code failed.** `StepResult.guard` gained
  `failedMember`: a strict replay's thrown condition and a `step.expect` in one
  failed the guard with no member named, and the row belongs to the member the
  visit was asked from, so a chain's failing entry was otherwise not
  recoverable. `staleMember` keeps its meaning (the model healed).
- **What proves a condition entry:** its code decided at least one replay
  visit cleanly and it was not the mismatched member. A chain member its
  winner kept from ever running proves nothing and is proposed unproven, as a
  step no round reached is; the next run proves it. An `ai: true` condition is
  proven by a visit that did not fail, as a declined step is by passing under
  AI.
- **A failure the compile does not own is worded for what happened**, not as
  *existing entry for step N fails; recompile it with `--steps N`*, which is
  kept for a line that has an entry (with *answers differently from the
  recording* for a mismatch). A guard no entry decided that failed says the
  run's error, and — at a cap breached with its body running as code on every
  pass — *its body (step 3) ran as code on every pass and never ended the
  loop — check that the body moves the page on*. A step with no entry, an
  `ai: true` one, and one a compile never writes (`[tool:]`, `Set`) each say
  which. The rounds stop there, as for an author's entry.
- **Known limit: a body that does not move the page on is blamed on the
  condition.** A code-decided visit leaves no page, so when a body entry fails
  to advance and a correct condition therefore says "carry on" where the
  recording stopped, the mismatch names the condition. The repair is shown
  both answers and the recorded page; if it cannot help, the condition is
  written off `ai: true`, and the confirming round's model-decided loop then
  reaches its cap with the body note above.
- **A stale flag is keyed by the member it names.** `collectStaleKeys` and the
  Record's own flags read `guard.staleMember` before the row's index, so a
  chain whose `If` threw and whose `Else if` held regenerates the `If`.
- **`hasEntry` is kind-aware** (`hasEntryOfKind`), as on the live path: an
  entry of the other kind on a line is owed one of its own.
- **`POST /codebehind/compile` expands once.** The route sends `test.steps` —
  already expanded, each guard line followed by its tail — and the session
  manager expanded again whenever a step parsed as a control line. Measured
  before the fix through the real route: a chain file's Record failed with
  *Skill expansion failed: … "Otherwise, Pay by card" has no decision to be
  the alternative of* (the `Otherwise` now followed a tail step, not its
  `If`), and a `While` file's Record ran `Click Next` a fourth time in the
  slot where `Read the reference` belongs — the tail expanded twice, every
  later row one index late against `outcomeRows(…, test.steps.length)` and the
  registry, which binds through the compiler's expansion. The compiler now
  sends its control records in `internal.codeBehind.expansion.controls`, and
  the server does not re-expand a pre-expanded batch: it seeds its guards from
  them, clipped to the batch as the origins already were.
- **The skip-cause sentences were not unified.** The boxed per-step line names
  the decision — *not run on the recording run (the loop ran no passes)* — and
  its list clause says *the run decided against them*; the live line is *the
  step did not run — the run decided against it*. They state the same cause;
  the boxed one says which decision, which the live offer does not carry, and
  both are pinned by tests on their own surfaces.
- **A condition that cannot be generated read-only does not fail the
  compile.** `conditionEntryComplaint` is a textual heuristic over generated
  code with known false positives (a `reduce` accumulator or an
  `Object.fromEntries` local written inside `page.evaluate`), and since review
  round 1 a condition answer that breaks a hard rule twice is an error. A step's
  generation error still ends the compile; a condition's no longer does. The
  line gets no entry this time — the model keeps deciding it — it leaves the
  selection so no replay round expects code from it, the compile ends `partial`
  and says so in `summary.warnings`, and nothing is written for it, so the next
  compile tries again (an `ai: true` write-off would stop that). A condition
  REPAIR that produces nothing usable writes that entry off, as a step that
  fails every round is written off, and the rounds carry on.

## Rollout

Server (build + restart `:3100`), `runner-core` unchanged unless a protocol
comment moves, `steptix-vscode` patch bump and install.

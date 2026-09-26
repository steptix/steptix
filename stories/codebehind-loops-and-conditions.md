# Compile loops, and compile the conditions that drive them

**Status:** spec, 2026-09-26. The runtime (condition entries decide guards)
and Run & Compile / Compile This Step (generation, the live compiler, the
recording) are built — see §"What the live half decided". The boxed
`aiui compile` half (§"Boxed compile") is not: it still refuses a file that
loops.

## In plain terms

A test can loop (`While`, `Repeat … until`, `For each`) and decide (`If`,
`Else if`, `Otherwise`) since [control-flow.md](control-flow.md). Code-behind
cannot follow it there. Today:

- **Compiling a file that loops is refused outright.** `aiui compile` refuses
  the whole file; Run & Compile in TestBench refuses whenever the steps it
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
  true or false. A compiled test with loops and decisions then runs with no
  model call at all.

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

**You click** Run & Compile in TestBench.
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
the section body is `Click the account named "{{account}}"`.
**You get:** one entry for the body line, generated from the first pass
(Everyday). It reads `step.getVar('account')`, so on the second pass it
clicks Savings. The prompt told the model the line repeats and that
`{{account}}` changes on every pass.

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

**You run** `npx aiui compile tests/control-flow.md`.
**You get:** the boxed compile records, generates, replays and repairs as it
does for any file. The replay also checks the compiled conditions against the
recording: if the recording's `While` ran three passes and the replay's code
says to run a fourth, that condition's entry fails the replay and is repaired
from the page the model saw on that visit.

## Decisions

1. **Loop bodies compile, one entry per authored line, from the first pass
   that passed; every pass replays it.** The rule rows already follow
   ("records row 1"), for the same reason: entries are keyed by authored text
   and the key is the same on every pass. The live compiler already does this
   (`takenKeys`). The boxed compiler does not — it keeps the last row per
   expanded index, so it generated from the final pass: the page where the
   `While` had just gone false, and the last `For each` item. It changes to
   the first usable pass.

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

15. **TestBench paints a guard's code mark and ⚠ from the guard's own
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
  scoped key is `__skillN_order.id`).
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
judge. The code path settles the page, then runs each asked member in order
(literal answer if the member is literal, else its entry), stopping at the
first that holds. A throw discards that binding's entry and falls through to
the judge for the whole chain. The cap check runs before the planner is
consulted, so the planner's state is only ever advanced once.

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
  `--only-stale` and the repair find the right entry.
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

### TestBench — `testbench-native/`

- `frame:pop` repaints the call line with the guard's own mark when the
  guard painted `pass-code-behind` or `pass-stale` on it earlier in this run.
- The compile result line no longer reads "✓ Nothing to compile" for a
  refused compile (`compile-summary-core.ts`: honour `status`).
- Nothing else: the guard's events carry the fields every surface already
  reads; Repair on a ⚠ guard line reaches `compile: 'steps'`, which the
  server now accepts for a guard.
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
  pass; the `/codebehind/compile` route with a chain and with a loop.
- **The fixture:** TestBench live — Run & Compile
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

## Rollout

Server (build + restart `:3100`), `runner-core` unchanged unless a protocol
comment moves, `testbench-native` patch bump and install.

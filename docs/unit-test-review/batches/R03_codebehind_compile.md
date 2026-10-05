# R03_codebehind_compile

## Summary
- Files: 10 · tests (approx): ~560 cases incl. it.each rows (~330 it/it.each blocks) · High ~470 · Medium ~75 · Low 9 findings (~15 cases) · Defects 5 · Flakiness risks: high 0, medium 3 (one is systemic across 7 files)
- This is a strong batch. Almost every test drives real compile logic: `compileTest` with a scripted runner over real `.steps.ts` files (esbuild + Prettier really run), `LiveCompiler` with a fake AI that reads the prompt it's sent, or pure functions (complaint checkers, the placeholder rule, refusal reasons) tested through big tables. The fake AI stubs are not L1. What gets asserted is the pipeline's decisions: selection, rounds, `ai: true` write-off, partial/green, masking in the prompts it builds, and the kept/notAttempted arithmetic. Many tests are regressions tied to a review finding, with a "measured before the fix" note. Most exact-text asserts are on warnings that stories/codebehind-loops-and-conditions.md quotes, so they are contract, not L4.
- The low-value findings are small and local. There are a handful of duplicates (one whole test, a few table rows, two one-liners), two tests named for a mechanism they never reach (live-compile :369, flow-control :215), two over-precise pins (a hard-wrapped prompt line, a source pin on local variable names), and one stub-echo.
- The defects share one theme: fixtures that can't tell the right implementation from a plausible wrong one. The recording `status` is the echoed input in 3 tests. The splice fixture's input status always equals the expected one. One negative check waits a single macrotask, and one `toBeLessThan(3)` passes at 0, 1 or 2.
- The main flakiness issue is systemic. Seven files keep scratch files in a fixed in-repo `tests/.tmp-*` directory. They clean it only in `afterAll`, never before the run, and that directory isn't gitignored. An interrupted run, or an `afterAll` that hits EBUSY (which has happened: commit f83c11b), leaves files behind. The next run then reads the previous run's `.steps.ts` and sidecar as input and fails deterministically. Separately, the many single-quote `source: '…'` asserts depend on no Prettier config existing in any directory above the checkout.

## Flakiness risks

### SYSTEMIC — fixed in-repo scratch dir never cleaned before the run (7 files)
`tests/codebehind-compile.test.ts:37`, `tests/codebehind-compile-loops.test.ts:34`, `tests/codebehind-failure-outcomes.test.ts:49`, `tests/codebehind-flow-control.test.ts:54`, `tests/codebehind-placeholder-rule.test.ts:52`, `tests/codebehind-live-compile.test.ts:36`, `tests/codebehind-generate.test.ts:41`. Applies to every test in the first five files.
- Mechanism: `const tmpBase = path.join(repoRoot, 'tests', '.tmp-codebehind-compile');` with `beforeEach(() => { dir = path.join(tmpBase, \`t${counter++}\`); await fs.mkdir(dir, { recursive: true }); })`. The directory is removed only in `afterAll(() => fs.rm(tmpBase, …))` and never before the run. `counter` restarts at 0 on each run, so a run reuses exactly the same `tN` dirs. `git check-ignore` says `tests/.tmp-*` is not ignored. If the previous run was killed (Ctrl-C, worker timeout, `--bail`), or its `afterAll` rm failed, `tN/booking.steps.ts`, `tN/signin.steps.ts` and `tN/.steptix-codebehind-cache/*.last-run.json` from that run survive. These are exactly the inputs a compile reads. For example, `codebehind-compile.test.ts:213` expects `generatedSteps === [1, 2]`. With last run's green `booking.steps.ts` still in `t0` it takes the "every step already has code" path (`:565`), and the test fails deterministically until someone deletes the directory. The same applies to the non-dry-run tests in compile-loops (:341 writes `statements.steps.ts`), failure-outcomes, flow-control and placeholder-rule (:707 writes `signin.steps.ts`). The risk is low in live-compile (LiveCompiler never writes the `.steps.ts`) and none in generate (nothing is written into `dir`). A second variant: two `npm test` runs in the same checkout at once (CLI plus a test explorer) share these dirs, and one run's `afterAll` deletes the other's files mid-test.
- Risk: medium
- Fix: also `fs.rm(tmpBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })` in a `beforeAll`, as `tests/compile-runner-loops.test.ts:273` and `tests/api-server-loops-compile.test.ts:340` already do. Better still, make the base unique per run: `tmpBase = await fs.mkdtemp(path.join(repoRoot, 'tests', '.tmp-codebehind-compile-'))`. It stays inside the repo, so `steptix/codebehind` still resolves. Also add `tests/.tmp-*/` to `.gitignore`.
- Evidence: commit f83c11b ("Retry removing in-repo temp dirs that Windows briefly locks") says the `afterAll` rm hit EBUSY in full runs, naming codebehind-failure-outcomes among others. Retries make that rarer, not impossible, and a killed run skips `afterAll` entirely.

### SYSTEMIC — written-file asserts depend on there being no Prettier config above the checkout (env-dependent)
For example `tests/codebehind-compile.test.ts:253` ("records, generates, reviews, replays green, and writes"), `:247`, `:352`, `:984`; `tests/codebehind-compile-loops.test.ts:375`, `:1635`; `tests/codebehind-failure-outcomes.test.ts:517`; `tests/codebehind-flow-control.test.ts:714`; `tests/codebehind-live-compile.test.ts:312`, `:1269`, `:1405`. In total about 30 `toContain("source: '…'")` asserts.
- Mechanism: `formatCodeBehindSource` (src/codebehind/writer.ts:141-146) spreads `prettierResolveConfig(file)` over its defaults (`singleQuote: true, printWidth: 100, trailingComma: 'all'`). Prettier 3.9.6 searches for a config from the file's directory up to the filesystem root. `getPrettierConfigSearchStopDirectory()` is undefined, and `package.json` counts only with a top-level `prettier` key, which the repo's doesn't have. The repo has no `.prettierrc`, so a `.prettierrc` in any ancestor is applied (a home dir above `~/steptix-linux` in WSL, a macOS checkout under `~`, a CI workspace parent). `singleQuote: false` there turns every `source: '…'` into `source: "…"`, and `:253`'s exact 6-line block fails. This is deterministic on the affected machine rather than intermittent. It matters because the suite must pass on three OSes and on other people's machines.
- Risk: medium
- Fix: write a `.prettierrc` (`{"singleQuote":true,"printWidth":100,"trailingComma":"all"}`) into each `tmpBase` in `beforeAll`, or commit a repo-root `.prettierrc` that pins the same three options so the search stops inside the repo.
- Evidence: checked node_modules/prettier/index.mjs (`searchPrettierConfig` → `FileSearcher` with no stop directory) and the ancestors of this checkout. None has a config today, so it passes here.

### `tests/compile-runner-flow-control.test.ts:342` — afterAll (both tests) and `tests/codebehind-condition-generation.test.ts:811` — `review()` helper (6 tests at :816-:872)
- Mechanism: `await fs.rm(projectRoot, { recursive: true, force: true });` and `await fs.rm(dir, { recursive: true, force: true });` are recursive removes with no `maxRetries`, run over freshly written files. The compile route's Record writes a recording beside the test. `reviewCandidate` → `validateCodeBehindSource` writes and bundles `<dir>/.steptix-codebehind-cache/validate-<uuid>.ts` (src/codebehind/writer.ts:169-179), and that file's own cleanup swallows errors. A Windows indexer or AV scanner holding one of those files makes the rm throw EBUSY/EPERM, which fails the hook or the test.
- Risk: medium (needs a scanner lock, and `%TEMP%` is "usually spared" per f83c11b, but it's the same failure that commit fixed elsewhere)
- Fix: add `maxRetries: 10, retryDelay: 100` to both removes, matching the other 28 suites.
- Evidence: the same EBUSY mechanism is documented in commit f83c11b. These two removes were not part of that sweep.

### Already guarded (not flagged)
- `compile-runner-flow-control.test.ts:328` and `compile-runner-loops.test.ts:270` listen on port 0 and close the server in `afterAll`. compile-runner-loops cleans its in-repo dir in `beforeAll` too (:273), with a 60 s per-case budget for the full pipeline.
- `codebehind-compile.test.ts:907` sorts the `readdir` output, and `:1390` sorts `Object.keys`.
- No `process.env` or cwd mutation, fake timers, `Date.now` comparisons, `Math.random` or real browsers anywhere in the batch.
- `codebehind-live-compile.test.ts:2098` (`setTimeout(r, 0)`) can only pass falsely, never fail falsely; it is listed under defects.
- `codebehind-live-compile.test.ts:775/:791/:809` leave the generation queue running after the test returns. It touches only in-memory state, so it is hygiene rather than a flake: add `await compiler.dispose()`.

## Per-file verdicts
| File | Tests | Verdict (High/Medium/Mixed/Low) | One-line note |
|---|---|---|---|
| tests/codebehind-compile.test.ts | 39 | High | `compileTest` with a scripted AI and runner over real `.steps.ts` files. Asserts the pipeline's decisions (selection, rounds, write-off, partial, review guards, $VAR/data-row parameters). One test (:602) is a subset of the loops file. |
| tests/codebehind-compile-loops.test.ts | 31 | High | Loop/condition compile regressions, each tied to a review finding (F/G/R ids, "measured before the fix"). Warning strings are quoted in the story, so the exact-text asserts are contract. |
| tests/codebehind-condition-generation.test.ts | ~190 cases (26 blocks) | High | Big pure-function tables (conditionEntryComplaint corpus, compilableCondition, isLiteralCondition) plus prompt/review/generateConditionEntry. Has 4 duplicated rows, 1 misnamed row and 1 whitespace-pinned assert. |
| tests/codebehind-failure-outcomes.test.ts | 44 | High | step.fail(), tolerated vs deliberate across refusal, compile, prompts and the recording. The recording-status asserts echo their input, and one class-hierarchy test is redundant. |
| tests/codebehind-flow-control.test.ts | 31 | High | step.exit() through the real executeStep and a real `.steps.ts` load, plus compile handling of return-skipped rows. One trivial or misnamed class test and one duplicate one-liner. |
| tests/codebehind-generate.test.ts | ~100 | High | Parsers, the leak guard, refusal/complaint checkers, the generateStepEntry re-ask/backstop. Only this file tests parseStepCode, findInlinedParameterValue and aiEntryFor. Has 1 stub-echo and 1 brittle source pin. |
| tests/codebehind-live-compile.test.ts | 83 | High | LiveCompiler eligibility, queue, progress arithmetic, iteration and occurrence repair routing, offerGuard. One test doesn't reach the mechanism it names (:369), plus two loose asserts. |
| tests/codebehind-placeholder-rule.test.ts | 36 | High | The exact reference rule and its carve-outs, dotted and prototype-key names, and the compile summary's compliance count. Nothing low. |
| tests/compile-runner-flow-control.test.ts | 2 | High | The real HTTP compile route with the compile core faked at compileTest. Pins that the pre-expanded route still frames section and skill returns. Not over-mocked: the session manager and run loop are real. |
| tests/compile-runner-loops.test.ts | 2 | High | The real HTTP route and the real compile pipeline. Pins "expands once" for a chain and a While. Overlaps the core-level loops tests only at a different level (route vs `compileTest`). |

## Low-value tests

### `tests/codebehind-compile.test.ts:602` — "compiles a test that loops — the refusal is gone (stories/codebehind-loops-and-conditions.md)"
- Category: L3
- Evidence: it builds a WHILE record/replay over `While the Next button is enabled, Click Next` and asserts `status 'green'`, `requests.map(r => r.purpose)` = `['record','replay']`, `generatedSteps = [1,2,3]`, and that the written file contains the While source and `'async condition({ page })'`. `tests/codebehind-compile-loops.test.ts:341` drives the same fixture shape and asserts all of this (`['record','replay']`, `source: '${WHILE_LINE}'`, `'async condition({ page })'`, `compiled: 4`). It also asserts pass-1 selection, the observation pick and the step counts.
- Recommendation: delete (keep `codebehind-compile-loops.test.ts:341`).
- Confidence: high

### `tests/codebehind-condition-generation.test.ts:42, :43, :56, :88` — duplicate rows of "conditionEntryComplaint accepts/refuses"
- Category: L3
- Evidence: `:42` `return await page.getByLabel('Cash').isChecked();` ≡ `:465`. `:43` `return (await page.getByRole('button', { name: 'Load more' }).count()) === 0;` ≡ `:466`. `:56` `condition: async ({ page }) => (await page.locator('#x').count()) > 0` ≈ `:478` ('the arrow form'). `:88` `await tabs.switchTo('page:2');\n return true;` with `'{ page, tabs }'` ≡ `:514` ('a bare tabs.switchTo'). Each pair has the same body, the same params and the same assertion. Only the wrapper's whitespace and source text differ, and conditionEntryComplaint doesn't read either.
- Recommendation: delete the first-table copies (`:42`, `:43`, `:56`, `:88`) and keep the corpus at `:457`.
- Confidence: high

### `tests/codebehind-condition-generation.test.ts:348` — "says condition entries exist: keep them conditions, read-only, boolean — never a run, never a new one" (one assertion)
- Category: L4
- Evidence: `expect(prompt).toContain('Never\n   turn one into a \`run\` entry');` pins the hard line wrap and 3-space continuation indent of src/codebehind/review.ts:101-102 (`…before it asks. Never\n' + '   turn one into a \`run\` entry, …`). Re-flowing that paragraph breaks the test with no change in behaviour. The test's other assertions check rule presence properly.
- Recommendation: rewrite this one assertion as `toMatch(/Never\s+turn one into a `run` entry/)`.
- Confidence: high

### `tests/codebehind-failure-outcomes.test.ts:235` — "throws a CodeBehindExpectationError, so every existing reading of one still holds"
- Category: L3
- Evidence: it asserts `new CodeBehindDeliberateFailure(...)` is an instance of `CodeBehindExpectationError` and of `Error`, that `.name` is `'CodeBehindDeliberateFailure'`, and that `isNonRetryable(err)` is false. Production has one reading of the subclass relation, `expectationFailed: err instanceof CodeBehindExpectationError` (src/codebehind/execute.ts:314). `:133` (`expect(outcome.expectationFailed).toBe(true)` after `step.fail`) already proves it, and `:160` (`expect(outcome.nonRetryable).toBeUndefined()`) proves the isNonRetryable half. The "author's own instanceof" in the comment can't happen: src/codebehind/index.ts exports only `defineSteps` and types.
- Recommendation: delete.
- Confidence: high

### `tests/codebehind-flow-control.test.ts:215` — "exports the signal as a class, so a catch-all in author code can re-throw it"
- Category: L5 (and a misleading name)
- Evidence: the test is `expect(new CodeBehindExitSignal()).toBeInstanceOf(Error); expect(new CodeBehindExitSignal().name).toBe('CodeBehindExitSignal');`, which checks a constructor and a constant. The claim in its name isn't tested and isn't true: author code imports from `steptix/codebehind`, which (src/codebehind/index.ts) exports only `defineSteps` and types, not this class. The behaviour that matters (exit is a pass, nothing runs after it, the claim guard) is covered at `:103-213`.
- Recommendation: delete, or (if author re-throw is meant to be supported) rewrite to run an entry that wraps `step.exit()` in `try { … } catch (e) { if (e.name === 'CodeBehindExitSignal') throw e; }` and assert `flowControl: { kind: 'return' }`.
- Confidence: high

### `tests/codebehind-flow-control.test.ts:1050` — "refuses a skipped step with its own reason, not "did not pass""
- Category: L3
- Evidence: `generationRefusal({ binding, text: 'Confirm the booking', status: 'skipped' })` → `SKIPPED_BY_RETURN_REFUSAL`. `tests/codebehind-live-compile.test.ts:1947` asserts the same call shape and result (`generationRefusal({ binding: b, text, status: 'skipped' })).toBe(SKIPPED_BY_RETURN_REFUSAL)`, "Absent is a return"), next to the explicit `'return'` and `'decision'` cases. The extra `toContain('a return ended its flow')` is a check on a constant's content.
- Recommendation: delete (keep `codebehind-live-compile.test.ts:1937`).
- Confidence: high

### `tests/codebehind-generate.test.ts:841` — "returns the entry the model produced"
- Category: L1 (partial)
- Evidence: the stub returns an entry containing `step.getVar('username')` and no `octocat` (:843-851). The test then asserts `expect(result.kind === 'entry' && result.code).toContain("step.getVar('username')")` and `.not.toContain('octocat')`, which reads the stub's own text back. Only `kind === 'entry'` and `calls.length === 1` exercise the unit (validation doesn't false-positive on a clean entry), and dozens of compile tests in this batch cover that happy path anyway.
- Recommendation: rewrite. Drop the two content echoes and keep it as a two-line smoke test, or delete it.
- Confidence: high

### `tests/codebehind-generate.test.ts:1361` — "is handed a marked snapshot by both compilers"
- Category: L4 (brittle in one half, loose in the other)
- Evidence: `expect(boxed).toContain('parameterMap: passValues'); expect(boxed.match(/parameterMap: values/g)).toHaveLength(3);` pins local variable names and an exact count in src/codebehind/compile.ts (:850, :940, :2949, :3059). Renaming `values`, or adding a correct fifth site, breaks the test. The boxed behaviour is already proven end-to-end: codebehind-compile-loops.test.ts:1173 ("never shows the key to generation, the condition, or a repair"), :1222 (healed-pass repair), :1329 (G3). The live half, `expect(live).toContain('parameterMap: input.resolvedParameters')`, matches two sites (live-compile.ts:1576 and :1650), so dropping one still passes, and the third site (:1393 `parameterMap: first.parameters`) isn't checked at all.
- Recommendation: delete the boxed half (behaviour tests cover it). For the live half, either count occurrences the way codebehind-live-compile.test.ts:1819 does for session-manager.ts, or add a LiveCompiler-level test where a dotted author heading must be masked through repair and condition generation.
- Confidence: medium

### `tests/codebehind-live-compile.test.ts:369` — "a link that throws does not poison the rest of the queue"
- Category: L3 (also a defect: the test doesn't reach the mechanism it names)
- Evidence: the fake throws inside `aiClient.complete` (`if (/source:\s*"Add to cart"/.test(prompt)) throw new Error('boom')`). `askForEntry` catches that and returns `{ kind: 'error', message }` (src/codebehind/generate.ts:866-875: `try { const completion = await aiClient.complete(…) … } catch (err) { return { kind: 'error', … } }`). So the queue link's `.catch` at src/codebehind/live-compile.ts:1155-1169, the "poison" guard the test describes, is never reached. The path is identical to `:342` ("a generation error does not stop anything"): same three steps, same throw on "Add to cart", same applied-error branch (live-compile.ts:1741). `:342` asserts a superset (`compiled 2`, the error summary, the note text, no entry for step 2, an entry for step 3).
- Recommendation: rewrite so that something outside `askForEntry` throws for step 2, for example an `emit` callback that throws on step 2's `generating…` frame, or a binding whose `file` makes `candidate.apply` throw. Assert that step 3 is still generated and that the `'Code-behind generation failed for step 2'` note comes from the link catch.
- Confidence: high

## Test defects

### `tests/codebehind-condition-generation.test.ts:51` — "conditionEntryComplaint accepts an arrow-form condition"
- Category: Defect (misnamed row)
- Evidence: the row's body is `'    return true;'`, wrapped by `entry()` at :34-35 as `async condition(${params}) {\n${body}\n  }`. That's a method-form condition, not an arrow. The arrow/property form is actually tested at `:56` and `:478`.
- Recommendation: rename it to 'a constant condition', or delete it (it adds little).
- Confidence: high

### `tests/codebehind-failure-outcomes.test.ts:1034` — "the recording of a tolerated failure round-trips the flag and does not make the run failed"; `:1052` — "is a FAILED recording — honest — and still carries the step as compilable"; `tests/codebehind-flow-control.test.ts:1070` — "round-trips the status and the reason, and does not make the run failed"
- Category: Defect (part of each test is tautological, L1)
- Evidence: each calls `writeRecording(md, { …, status: 'passed' | 'failed' })` and asserts `recording!.manifest.status` equals that same value. writeRecording copies the input (src/codebehind/recording.ts:281 `status: input.status`; the source comment at :623-625 confirms "The wholesale path above takes `input.status`"). So "does not make the run failed" and "is a FAILED recording" can't fail through the unit. The step-level asserts (`tolerated`, `deliberate`, `error`, `skipReason`, `actions`) are real round-trips.
- Recommendation: drop the status claim from the names and the `manifest.status` asserts, or move the status rule to where it's computed (the run loop, or `spliceRecording`; see below).
- Confidence: high

### `tests/codebehind-failure-outcomes.test.ts:1092` — "a spliced recording" it.each (3 rows)
- Category: Defect (the fixture can't tell the rule under test from a plausible regression)
- Evidence: the describe comment says "A splice recomputes the status from rows of mixed provenance". `spliceRecording` does that (recording.ts:631 `status: all.some((s) => s.status === 'failed' && s.tolerated !== true) ? 'failed' : 'passed'`). But every row passes a `spliceStatus` equal to `expected` (`'passed'→'passed'`, `'failed'→'failed'`, `'failed'→'failed'`). A regression back to `status: input.status` would pass all three. The rows do catch a recompute that mishandles `tolerated` or `deliberate`.
- Recommendation: give the tolerated row `spliceStatus: 'failed'` (still expect `'passed'`), and add a row where an existing failed step is replaced by a passing splice.
- Confidence: high

### `tests/codebehind-live-compile.test.ts:578` — "dispose abandons the queue without proposing anything"
- Category: Defect (loose assert)
- Evidence: `expect(calls).toBeLessThan(3);`. `offer()` is synchronous (live-compile.ts:1026) and `dispose()` sets `disposed = true` before the first queued link runs (:875-877), so `calls` is always 0. The assert also passes at 1 or 2, meaning "dispose stopped only the last generation" would go unnoticed.
- Recommendation: `expect(calls).toBe(0)`. Separately, if the "in-flight call finishes" case matters, abort from inside the first `generate` the way `:447` does and assert `toBe(1)`.
- Confidence: high

### `tests/codebehind-live-compile.test.ts:2086` — "generates nothing at offer time, then one condition from the first held and first not-held visit" (first half)
- Category: Defect (negative check that can pass vacuously)
- Evidence: `await new Promise((r) => setTimeout(r, 0)); expect(prompts).toEqual([]);` (:2098). If a regression queued generation inside `offerGuard`, the queued link might still be awaiting async work (a sidecar read, Prettier) after a single macrotask, so the empty-prompts check would pass anyway. It can't fail falsely, only pass falsely. The second half of the test (one generation, visits 1 and 4) is solid.
- Recommendation: assert on a synchronous signal instead, for example no `compile:progress` and no `compile:step` events before `runStepsEnded()`, then a run-end forecast with `total: 1`.
- Confidence: medium

## Duplication clusters
- Boxed compile of a `While`: `codebehind-compile.test.ts:602` ⊂ `codebehind-compile-loops.test.ts:341` (core); `compile-runner-loops.test.ts:388` (boxed HTTP route); `api-server-loops-compile.test.ts:448` (live Sessions route). Drop `:602`. Keep the other three, which run at different levels and routes.
- conditionEntryComplaint rows: `codebehind-condition-generation.test.ts:42/:43/:56/:88` ≡ `:465/:466/:478/:514`. Drop the first-table copies.
- Generation error in the live queue: `codebehind-live-compile.test.ts:342` ⊇ `:369`. Rewrite `:369` to reach the link catch (see above).
- Skipped step → `SKIPPED_BY_RETURN_REFUSAL`: `codebehind-flow-control.test.ts:1050` ⊂ `codebehind-live-compile.test.ts:1937/:1947`. Drop `:1050`.
- step.fail subclass relation: `codebehind-failure-outcomes.test.ts:235` is covered by `:122/:133` and `:149/:160`. Drop `:235`.
- Kept on purpose, not duplicates: the author-quoted-literal exemption at three sites (`codebehind-generate.test.ts:1088` generation, `codebehind-failure-outcomes.test.ts:947` boxed repair, `codebehind-live-compile.test.ts:1692` live repair); tolerated and deliberate handling in the boxed compiler (`codebehind-failure-outcomes.test.ts:495-776`) and the live compiler (`codebehind-live-compile.test.ts:1521-1774`); the return-on-compile-route tests (`compile-runner-flow-control.test.ts`) next to the Sessions-route ones in `api-server-compile-mode.test.ts:1332`.

## Cost concerns
- None significant. `compile-runner-loops.test.ts` runs the full Record → Generate → Review (Prettier) → Replay (esbuild) over HTTP with a 60 s per-case budget. It pins a route-level "expands once" bug that no core-level test can see, so the cost is justified. The roughly 150 `compileTest` and `LiveCompiler` cases each do real esbuild validation and Prettier formatting, on purpose ("the part that must not be faked").

## Working notes (per file)
### codebehind-compile.test.ts
- All 39 tests are High or Medium. The fake AI stubs return entries, but every asserted outcome passes through compileTest's logic: selection, rounds, the `ai: true` write-off, partial status, the unproven list, sidecar clearing, review rejection.
- :253's exact multi-line formatting pins Prettier output. It's the seam check that compile really runs formatCodeBehindSource (the pure-function test is codebehind-writer.test.ts:405). Medium, and environment-dependent (see Flakiness).
- :1449 and :1466 (last-run sidecar round-trip, corrupt file reads as null) are simple but real tests of readLastRun's guard. Medium.
- :678 (chain where the If held, plus Otherwise) overlaps loops :655 but covers the held-If branch and checks the written file never contains Otherwise. Keep.

### codebehind-compile-loops.test.ts
- All High. The fake AI echoes the source each prompt names, but the asserted outcomes are prompt contents that compile builds (pass selection, masking, per-pass values) and pipeline decisions. Not L1.
- The exact warning strings (:768, :1603, :1679, :1766, :1788, :1816) are quoted in stories/codebehind-loops-and-conditions.md, so they're contract.

### codebehind-condition-generation.test.ts
- The prompt-rule tests (:269, :286, :348) are Medium/High (rule presence).
- generateConditionEntry and the hard-rule fallbacks (:367-452, :630-688) are High.
- reviewCandidate over a condition entry (:771-873) is High, including "judges only what the reviewer changed" (F5).

### codebehind-failure-outcomes.test.ts
- step.fail() through runCodeBehindEntry and executeStep is High (real entry execution; masking at :192).
- generationRefusal (:250-332) is High. Sub-asserts on constant contents (:274, :286, :298) sit inside behaviour tests and aren't flagged separately.
- Prompt tables (:791, :827, :868) are Medium/High (presence and absence). :863 pins checklist numbering ('9. …', absent '10. '). That's borderline, but it's how "no extra item" gets detected. Keep.

### codebehind-flow-control.test.ts
- The exit-execution and runCodeBehindStep seam tests (:103-437) are High.
- The :779/:840 pair covers both sides of the headline's return clause. High.
- notRunOnRecordingReason (:875, :892) is High.
- The :1092 splice-with-skip test is real: it catches a recompute that counts skipped rows as failed.

### codebehind-generate.test.ts
- :342 and :375 pin `'9. **End with a post-condition, and make it wait.**'` (rule number plus heading), so adding a prompt rule breaks them. The intent is "measurement mode inserts no rule". Borderline L4; noted, not flagged.

### codebehind-live-compile.test.ts
- :1819 is a source pin over session-manager.ts (exactly 4 snapshot sites, 4 offer calls, no spread). It's the house idiom, and its history ("left the whole suite green") shows the failure is silent. Keep (High).

### codebehind-placeholder-rule.test.ts
- All High: the exact rule, the value-match fallback with its warning, the scope carve-out, pre-change recordings, dotted and prototype-key names, and compile-summary counts. Each `generate()` result goes through accountPlaceholders before any stub text is used, so none of it is L1.

### compile-runner-flow-control.test.ts / compile-runner-loops.test.ts
- Both are High. HTTP on port 0 with the server closed in `afterAll`; state reset in `beforeEach`. compile-runner-flow-control fakes `compileTest` but runs the real session manager, which is the subject. The `[9, 9]` line pin at :407 is explicitly "a fact about this route", not the thing under test.

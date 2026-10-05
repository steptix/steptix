# R11_control_flow

## Summary
- Files: 16 · tests (approx): 446 declarations (about 580 cases once the `for`/`it.each` tables in flow-control-parse, flow-control-hooks, flow-control-grouper and flow-control-executor expand) · High ~395 · Medium ~40 · Low 10 · Defects 1 · Flake risks 2 (both medium, no high)
- This is a strong batch. Almost every test is a real behaviour, an edge case or a named regression (review 1–6 findings, the 0-based branched index, the `Object.assign` row leak, `planForStart` dropping `properties`, secret masking in the judge, the watch poller and IPC). The levels are deliberately layered: grammar (control-line, flow-control-parse, literal-condition), pure planner, expander ranges, executor seam, then each of the run loops (CLI `runTest`, Electron `UIRunnerAdapter`). Cross-loop repeats are intentional, because each loop wires the shared helpers itself.
- The low-value tests are all small exact repeats inside one level: identical calls with identical expectations (planner :860 vs :94, grouper :109 vs :120), regex-refusal tests whose input the exact-wording test re-runs (expander, three pairs), table rows restated as a separate `it` (flow-control-parse), and one bare-`Return` CLI test that flow-control-runner already pins. There is one partial dead subject: runner-core's `claimedControlForm` / `isControlLineClaim` have no production caller, but the parity suite pins them.
- Flakiness is low. The two timing-heavy paths, the condition judge's 30 s re-ask budget and the watch-group poller, run under vitest fake timers or are configured so no real sleep happens. Every run-loop test mocks `evaluateConditions` / `executeStep`, so none of them drives the settle/poll logic in real time. The two residual risks are filesystem/cwd ones.

## Flakiness risks

### `tests/flow-control-runner.test.ts:138` — whole file (every `runTest` case writes here)
- Mechanism: a fixed temp base inside the repository, `const tmpBase = path.join(repoRoot, 'tests', '.tmp-flow-control-runner');`, with per-test subdirectories named by a counter that restarts on every run (`dir = path.join(tmpBase, \`t${counter++}\`)`, :222). Each run therefore reuses `t0…tN` from any earlier run whose teardown failed, and two `npm test` runs in one checkout write the same files at once (a `--watch` session beside a full run, or two agents sharing a checkout). The Windows search indexer and antivirus scan in-repo files and leave `%TEMP%` mostly alone.
- Risk: medium. The teardown half is already guarded: `afterAll` uses `fs.rm(..., { maxRetries: 10, retryDelay: 100 })`. That guard was added by commit 5e61f46 ("Retry removing in-repo temp dirs that Windows briefly locks"), which names flow-control-runner as one of the suites seen failing with EBUSY. What remains is the shared, reused path.
- Fix: `dir = await fs.mkdtemp(path.join(tmpBase, 'run-'))` in `beforeEach`. That keeps the in-repo location the other `.tmp-*` suites need, though this file compiles no code-behind and so could use `fs.mkdtemp(path.join(os.tmpdir(), 'flow-control-runner-'))` instead, which also takes it out of the indexer's path.
- Evidence: commit 5e61f46 message ("Seen in codebehind-alignment, codebehind-failure-outcomes and flow-control-runner during full runs").

### `tests/parser-control-flow.test.ts:541` — "the control-flow examples in docs/ parse" (all three tests, :556, :564, :575)
- Mechanism: `await fs.readFile(path.join(process.cwd(), rel), 'utf8')` resolves `docs/…` against the process working directory rather than the test file. Run from anywhere but the repo root (an IDE runner rooted at a parent folder, `vitest --root`, or a sibling test that `chdir`s in the same process), it fails with ENOENT. The CRLF half of this test was already hardened by 25a1829 ("Make two root tests hold on GitHub's Windows runner").
- Risk: medium. `npm test` always runs from the root, so this needs an unusual but realistic invocation.
- Fix: `path.join(path.dirname(fileURLToPath(import.meta.url)), '..', rel)`, the same way flow-control-runner.test.ts:137 and ui-runner-adapter-control-flow.test.ts:1016 locate repo files.
- Evidence: git history (25a1829 fixed the CRLF variant of the same read); reading the code.

### Checked and already guarded (not flagged)
- `tests/condition-judge.test.ts:188-260`: the re-ask and the 30 s budget run under `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync`. `Date.now()` is faked too, and every await in `evaluateConditions` is a mocked promise, so the poll count is deterministic (10 polls). `afterEach` restores real timers.
- `tests/condition-judge.test.ts:318` "is masked in the watch group`s poll message": real timers, but `execution.timeout: 1` gives `maxPolls = ceil(1000/3000) = 1`, and `Date.now() + pollInterval < deadline` is false, so `executeBranchedStep` never sleeps the real 3 s.
- `tests/flow-control-executor.test.ts:431`: real-timer `executeBranchedStep`, but the first poll answers `matched: 'B'`, so it never sleeps. `waitForPageStability` is a recording stub, and `withRetry` gets no `delayMs`.
- `tests/test-runner-control-flow.test.ts`, `tests/ui-runner-adapter-control-flow.test.ts`, `tests/flow-control-runner.test.ts`, `tests/flow-control-ui-adapter.test.ts`: `evaluateConditions` / `executeStep` / `executeBranchedStep` are mocked and resolve immediately, so the judge's 30 s settle/re-ask never runs in real time. The CLI loop's `timeoutDeadline` uses the default `execution.timeout`.
- `tests/flow-control-ui-adapter.test.ts:111-126`, `tests/ui-runner-adapter-control-flow.test.ts:109-134`: `process.chdir(root)` is restored in `afterEach` (vitest 4 `forks` pool, one process per file). `process.env` is restored by the test (flow-control-ui-adapter) or by the adapter's own `restoreProcessEnv`. The temp roots come from `mkdtempSync(os.tmpdir())`.
- mkdtemp + `fs.rm` in `afterEach`: expander-control-flow, flow-control-frames, flow-control-hooks, parser-control-flow, test-runner-control-flow (`os.tmpdir()`, unique per run). They have no `maxRetries`, but they live in `%TEMP%`, which 5e61f46 notes is usually spared the indexer.
- `tests/flow-control-hooks.test.ts:110` `loadConfig` reads the real `%LOCALAPPDATA%\steptix\.env` (`withMachineAiFloor`), read-only and irrelevant to the asserted refusal.

## Per-file verdicts
| File | Tests | Verdict (High/Medium/Mixed/Low) | One-line note |
|---|---|---|---|
| tests/condition-judge.test.ts | 16 | High | The real prompt builder, response parser and re-ask budget under fake timers; only the DOM, screenshot and stability helpers are mocked. Secret masking in the judge and the watch poll is a real regression guard. Prompt asserts (:104-153) pin rules the model relies on (labels, none/waiting, "NOT performing a step"). |
| tests/control-flow-planner.test.ts | 64 | High (2 L3) | Pure planner over hand-written controls arrays. The review-1 exit shapes, re-entry and the `planForStart` properties regression are high value. Two exact in-file repeats. |
| tests/control-line.test.ts | 38 | High | Grammar for the six forms: claim vs complete vs split position vs error. Error substrings are user-facing parse errors, and the claim/parse agreement loop is a good invariant. |
| tests/control-line-parity.test.ts | 16 | High (one partial L7) | Imports runner-core SOURCE, not dist (the comment records a measured false pass against dist). Includes a corpus-coverage self-check. Both `parseControlLine`s and the three message builders are used in production (runner-core step-lines.ts / section-index.ts → steptix-vscode env-data-completion-core.ts, row-selection-core.ts). The exception is runner-core's claim functions, which have no production caller. |
| tests/expander-control-flow.test.ts | 48 | High (1 L3 pattern) | Real parse+expand over inline docs and mkdtemp skills. Covers ranges, frames, scoped For each names, row-baked conditions, dangling/closed/after-flow refusals on the wire path, and the hook-scope warning. Three regex refusal tests re-run the input of the exact-wording test beside them. |
| tests/flow-control-executor.test.ts | 36 | High | Real `executeStep` with page/actions/readline mocked. Covers the claim guard, the REPL not lending the claim, the verb-swap refusal, error composition + masking, the local literal-decision path and the failure screenshot. The prompt-text asserts (:662-690) guard real generator rules (medium). |
| tests/flow-control-frames.test.ts | 14 | High | `frameExitIndex` over REAL expander frames (section, nested section, skill, looped section, unknown frame), plus the reason-string shape (clip at 80, no trailing dash). All helpers have production callers in 4 runners. |
| tests/flow-control-grouper.test.ts | 15 | High (1 L3) | `ranAs` records the TEXT each index ran, which is the actual bug signature. Return/fail/tail lines are tested in every position around a conditional. One test repeats the first table case verbatim. |
| tests/flow-control-hooks.test.ts | 8 (+loops) | High | Hook refusal at parse and at config load, with `fail` explicitly allowed. |
| tests/flow-control-parse.test.ts | 11 (+~127 table cases) | High (2 L3) | Frozen accept/refuse tables are the contract. Two "shape" tests restate table rows with a `hasOwn('body')` check that no consumer distinguishes. |
| tests/flow-control-runner.test.ts | 19 | High | The real `runTest` with the executor mocked: skipped rows + reasons, no model call for skipped/bare steps, hooks around a return, the HTML report, the stopAfterStep bound, the sidecar, dotted refs. Fixed in-repo temp path (flake risk, medium). |
| tests/flow-control-ui-adapter.test.ts | 9 | High | The Electron loop's events for return / tolerated / deliberate failures. Includes the authored-line reason that keeps an interpolated password out of IPC. |
| tests/literal-condition.test.ts | 34 | High | Positive + negative grammar, equality-is-text regression cases, and the `substituteAsLiterals` seam. Two tiny in-file repeats (see clusters). |
| tests/parser-control-flow.test.ts | 41 | High | Parse-time refusals per flow, tail restrictions, bake-over refusals, the docs-fence guard with a non-vacuity check (:556), and the control-named-section warning. `process.cwd()` docs read (flake risk, medium). |
| tests/test-runner-control-flow.test.ts | 52 | High (1 L3, 1 defect) | The CLI loop through the real parser/expander/planner. Chains, loops, caps, nesting, For each binding/masking, abort, hooks, console/report numbering, return composition, `[output:]`. One bare-Return test repeats flow-control-runner. One "control" assertion is not a control. |
| tests/ui-runner-adapter-control-flow.test.ts | 25 | High | Skipped-vs-passed on IPC, the advance() paths, debugger jumps (seed, no reset, re-owe, no double-record), start/complete pairing, masking of step-start/history/steer, and a source-pin on `guardHistoryLines` (verified: the slice ends at the call's `}),`, one call site). |

## Low-value tests

### `tests/control-line-parity.test.ts:215` — "on what claims, and on which form"
- Category: L7 (partial: the runner-core half)
- Evidence: the test compares `coreClaims`/`coreForm` (runner-core `isControlLineClaim`/`claimedControlForm`) with the CLI's. `grep -rln "isControlLineClaim\|claimedControlForm"` over the repo (excluding node_modules/dist) returns only `runner-core/src/control-line.ts`, the `src/` side (`src/parser/markdown.ts`, `src/runner/step-grouper.ts`, `src/skills/expander.ts`) and the two test files. In runner-core the only caller of `claimedControlForm` is its own `isControlLineClaim` (control-line.ts:183), and nothing calls that. `runner-core/src/step-lines.ts`, `runner-core/src/section-index.ts` and `steptix-vscode/src` import only `parseControlLine`, `isFlowControlLine` and the three message builders. The same dead-mirror assertions recur at :393-395, :414-415, :437-438 and :455-456.
- Recommendation: delete runner-core's `claimedControlForm`/`isControlLineClaim` (they are exported from index.ts but unused) together with the `core*` claim assertions, or keep them only if a consumer is planned. The `cliForm`/`cliClaims` use in the corpus self-check (:228) is unaffected.
- Confidence: high

### `tests/control-flow-planner.test.ts:860` — "at the top level the exit is still the next step"
- Category: L3
- Evidence: `planAfterGuard(CHAIN_NO_ELSE, 1, { kind: 'chain', selected: null }, createControlState())` → `toEqual({ skip: [[1, 6]], next: 7, selected: null })`. That is the identical call and identical expectation as `tests/control-flow-planner.test.ts:94` ("\"none\" with no Otherwise skips the whole chain and carries on after it", lines 95-101): same fixture, same verdict, same plan.
- Recommendation: delete. If the "control case" framing inside the exits block is wanted, leave a one-line comment pointing at :94.
- Confidence: high

### `tests/control-flow-planner.test.ts:311` — "the count is known from the start, unlike a While`s"
- Category: L3
- Evidence: `expect(plan.pass?.count).toBe(1)` after entering with `items: ['a']`. The test at :275 already asserts `pass: { iteration: 1, count: 2, bindings: … }` on entry and `count: 2` on pass 2 (lines 285-299). The While tests at :160 pin `pass: { iteration: 1 }` with no count via `toEqual`, so the contrast is covered too.
- Recommendation: delete.
- Confidence: high

### `tests/expander-control-flow.test.ts:711`, `:773`, `:827` — "an Otherwise with an ordinary step above it" / "an Otherwise under an `If … then return`" / "an Else if under an Otherwise"
- Category: L3 (one finding, three instances)
- Evidence: each re-runs the exact input of the "the parser`s wording, character for character" test in its own describe:
  - `:741` reuses `doc('1. If a, then X', '2. Click Save', '3. Otherwise, Y')` from :713.
  - `:793` reuses `doc('1. If the balance is zero, then return', '2. Otherwise, Y')` from :775.
  - `:839` reuses `doc('1. If a, then X', '2. Otherwise, Y', '3. Else if b, then Z')` from :829.

  The exact-wording test asserts `rejects.toThrow(expected)` with the full message from `danglingChainMemberMessage` / `chainAfterFlowControlMessage` / `closedChainMemberMessage`. That message contains every fragment the regex variants check, including `(## Steps)`. The other cases in those describes cover distinct branches and stay: first step of a batch, `[input:]` between, section body, under `stop here`, under a bare `Return`, a second Otherwise, a new If after an Otherwise.
- Recommendation: delete :711, :773 and :827.
- Confidence: high

### `tests/flow-control-grouper.test.ts:109` — "runs all three steps as themselves"
- Category: L3
- Evidence: the body is `const ran = ranAs(steps); for (...) expect(ran.get(i), …).toBe(steps[i]);` over `['If prompted for MFA, enter the code', 'If the title is Dashboard then return', 'Wait for the dashboard']` (:96-100). The first entry of the table at :120 is the same three strings, and the generated test at :135-140 runs the identical loop and assertion. The sibling at :102 ("forms NO group at all") is distinct and stays.
- Recommendation: delete :109, or drop the first row of the :118 table.
- Confidence: high

### `tests/flow-control-parse.test.ts:292` — "reads a LONG tail with no head as unconditional too" (and `:336` "marks the unconditional form the same way the other two verbs do")
- Category: L3
- Evidence: every line in `LONG_UNCONDITIONAL` (:177-182: `Return here`, `Stop running the steps`, `Stop running the remaining steps`, `Return running the following steps`) is already an ACCEPT row (:35, :38, :42, :45) asserting `toEqual({ verb: … })`. That `toEqual` fails on any string `body`, including `''`. The only thing :292 adds is `Object.hasOwn(parsed!, 'body')` being false, i.e. it tells absent apart from `body: undefined`. Every consumer dispatches on `claim.body === undefined` (test-runner.ts:1955, session-manager.ts:5980, errand-runner.ts:740, runner-adapter.ts:1146/1192, step-executor.ts:1084, computer-step.ts:511, live-compile.ts:489, compile.ts:2046), so that distinction is unobservable. :336 is the same for `fail`: `'Fail the test with error "No balance was shown"'` is the class of ACCEPT rows :117-120, and `parseFlowControlStep('If x then fail')!.body` = `'x'` is the class of row :135.
- Recommendation: delete :292 and :336, and keep :283 as the single documented statement of the "absent, not empty" rule (or move LONG_UNCONDITIONAL's comment onto the ACCEPT block).
- Confidence: high

### `tests/test-runner-control-flow.test.ts:1604` — "a bare Return in the main flow still ends the whole run"
- Category: L3
- Evidence: same seam (`runTest` with `executeStep` mocked), same shape (three steps with an unconditional `Return` at step 2), same assertions: `executeStepMock` saw only step 1, the last row is `skipped`, and the status is `passed`. `tests/flow-control-runner.test.ts:303` ("costs no model call at all and still ends the flow") asserts all of that plus the explanation and `flowControl` on the same document shape (`1. Navigate to /` `2. Stop` `3. Click "Sign out"`). It uses `Stop` where :1604 uses `Return`, but both go down the same unconditional dispatch (`flowControlClaim.body === undefined`, test-runner.ts:1955) and differ only in the verb label. In its describe, :1604 serves as a contrast to the loop/chain composition cases, but it adds no branch.
- Recommendation: delete, or keep only as a one-line comment pointing at flow-control-runner.test.ts:303.
- Confidence: medium (the duplicate is clear; whether the author wants the in-describe contrast is a judgement call)

## Test defects

### `tests/test-runner-control-flow.test.ts:860` — "does not warn about the item a For each header is there to bind"
- Category: Defect (a "control" assertion that cannot fail)
- Evidence: the test runs with `accounts: '["Everyday"]'` supplied, then asserts `expect(warnings).not.toContain('Unresolved placeholder: {{accounts}}')` under the comment "The control: the LIST is a genuine reference, and if it were missing it would still be warned about." Because `{{accounts}}` is resolved, that warning cannot occur whatever the code does, so it controls nothing. The first assertion is real: test-runner.ts:1931-1937 calls `interpolate(..., controlLineDefines(rawInstruction))` on every ordinary step, and removing the third argument would fail it. But nothing in the test proves the spy is observing an `interpolate` call on this path. A refactor that stopped interpolating this line would also pass the test.
- Recommendation: rewrite the control as a positive check. Run a second header with the list missing (e.g. `For each {{account}} in {{nolist}}, …`) and assert `warnings` DOES contain `Unresolved placeholder: {{nolist}}`.
- Confidence: medium

## Duplication clusters
- Bare unconditional Return/Stop ending the main flow in the CLI loop: `tests/flow-control-runner.test.ts:303`, `tests/test-runner-control-flow.test.ts:1604` → keep flow-control-runner:303, drop test-runner-control-flow:1604.
- Planner "none, no Otherwise": `tests/control-flow-planner.test.ts:94`, `:860` (identical) and `:1036` (selection 99, a distinct branch, keep) → drop :860.
- Expander refusal wording: `tests/expander-control-flow.test.ts:711`/`:741`, `:773`/`:793`, `:827`/`:839` → keep the exact-wording tests, drop the regex ones.
- Grouper "return between conditional and step": `tests/flow-control-grouper.test.ts:109` and the first table row at `:120` → keep one.
- literal-condition, quoted numbers in orderings: `tests/literal-condition.test.ts:153` and `:214` assert the identical `decide('"10" is at least "9"')`, and `:204` repeats `:147`'s `'"10" is at least 2'` → `numeric: true`. These are trivial line-level repeats inside otherwise distinct tests; drop the repeated lines when next touching the file. They are not counted as Low.
- Not duplication (checked): the parser-level refusals (parser-control-flow.test.ts:74-171) vs the expander-level ones (expander-control-flow.test.ts:710-869) are two different enforcers (`steptix run` vs the wire path), as the files say. The CLI / UI-adapter / Sessions API loop tests of the same rule are the documented "each loop wires it itself" pattern. The parity suite vs runner-core's own step-lines tests are different suites with different jobs.

## Cost concerns
- None significant. No real browser, process, server or network is used. Fake timers cover every real wait. The heaviest files (test-runner-control-flow, ui-runner-adapter-control-flow, flow-control-runner) parse and expand real markdown per test, which is cheap.

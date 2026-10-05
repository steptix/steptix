# R01_api_flow

## Summary
- Files: 10 · tests (approx): 289 (it.each rows counted) · High ~245 · Medium ~35 · Low 5 · Defects 4 · Flakiness risks 6 (0 high, 6 medium)
- These are strong suites. Almost every test drives the real `POST /sessions/:id/steps` entry, with the expander, validators, planner, frame stack, step loop, live compiler, Prettier and recording all real. Each one asserts the exact event lines, frames, reasons, report rows or proposed files, so a regression in the server loop fails it. Most tests are named after an incident and pin a distinct branch. They do not repeat the pure-function tests, which sit at another level.
- The few low-value tests fall into three patterns. Two tests cannot fail for the regression they name:
  - stepmode:1455 never reaches the breakpoint filter it claims to test, because the request triggers no expansion.
  - compile-mode:1048 checks for the lock only after the run has already released it.
- Three tests repeat another seam test's input exactly (one data-rows validation row, one While-compile case, one trivial control). Four tests have names that overclaim or positive assertions that hold trivially.
- Flakiness is mostly well guarded: port 0, mkdtemp, run-control driven by `step:awaiting` events rather than sleeps, runaway counters, `generateReport` awaited before `done`, and `STEPTIX_STATS=off` in vitest.config. The remaining risks:
  - compile sessions are retained and never closed while a shared cache dir is rm'd between tests (the file itself records a measured ENOTEMPTY);
  - one 5 ms sleep is used to separate timestamps;
  - one `vi.waitFor` uses the default 1 s deadline;
  - data-rows uses a fixed absolute fake path, which on Windows writes real files under `C:\tests\` (verified on this machine);
  - loops-compile uses a fixed in-repo temp dir.

## Flakiness risks

### `tests/api-server-compile-mode.test.ts:360-370` (file-wide; beforeEach) — every `compile: 'run'` case
- Mechanism: a `'run'` compile is retained on its session by design (src/server/session-manager.ts:8704-8714 clears only `'steps'`), and no test closes its session except :1297. Meanwhile each `beforeEach` does `await fs.rm(path.join(tmpDir, '.steptix-codebehind-cache'), { recursive: true, force: true })` with no retries. The file records that this exact shape raced. :1292-1296 says: "Left open, it races the next case's `beforeEach` cleanup — measured as ENOTEMPTY plus a cascade of timeouts. Closing the session discards it". That case was fixed with a DELETE, but ~20 other `'run'` compiles (:452, :489, :635, :670, :720, :725, :740, :765, :781, :950/:984, :1000, :1014, :1366-:1456, :1488, :1557) still leave their session and compiler open.
- Risk: medium
- Fix: record every session id `runSteps`/`postTo`/`block` mints, and `DELETE /sessions/:id` for each in `afterEach`. Add `maxRetries: 10, retryDelay: 100` to the two `fs.rm` calls in `beforeEach` (:368-369, and :1112-1114).
- Evidence: the in-file comment at :1292-1296. Confidence medium: reading the code I could not find a write that happens after `done`, but the authors measured one.

### `tests/api-server-compile-mode.test.ts:781` — "compile:\"steps\" splices the recording, leaving the siblings untouched"
- Mechanism: the test separates two runs by time: `await new Promise((r) => setTimeout(r, 5));` then `expect(after!.steps[1]!.recordedAt).not.toBe(before!.steps[1]!.recordedAt)`. Telling "fresh" from "untouched" depends on two `new Date().toISOString()` stamps differing. That fails with a coarse clock (some Windows timer configurations tick at 15.6 ms) or a clock step during the run.
- Risk: medium
- Fix: stop using the clock as the discriminator. Have the `executeStep` mock put a per-call counter in `capturedContext.domBefore`, then assert that step 2's `domBefore` changed and step 1's did not.
- Evidence: reasoning. The test's own comment concedes "the comparison could tie" without the sleep.

### `tests/api-server-rows-compile.test.ts:402-408` — all three cases
- Mechanism: this is the same mechanism as compile-mode. Sessions `rows-section`, `rows-section-exec` and `rows-kept` each retain a `'run'` compiler and are never DELETEd, and `beforeEach` does `fs.rm(path.join(tmpDir, '.steptix-codebehind-cache'), { recursive: true, force: true })` without retries. `CASE_TIMEOUT = 30_000` (:385) and its comment ("a case that trips that default leaves the compile lock held") show the suite already runs close to its budgets.
- Risk: medium
- Fix: `DELETE` each session after its case, and add `maxRetries` to the rm.
- Evidence: same as above.

### `tests/api-server-control-flow.test.ts:2102` — "ends as aborted rather than as a server error"
- Mechanism: `await vi.waitFor(() => expect(generatedReports.length).toBeGreaterThan(0));` polls with vitest's default 1000 ms deadline. Before it passes, the server has to notice the client abort, reject the parked judge, unwind the loop and write the report. All of that shares one event loop with every other worker's startup.
- Risk: medium
- Fix: wait on an event, not a deadline. Have the `generateReport` mock resolve a deferred promise that the test awaits, or at minimum pass `{ timeout: 10_000 }`.
- Evidence: reasoning. No history of failures.

### `tests/api-server-data-rows.test.ts:236, 262, 275, 313, 408, 447, 486, 507` — every test using `testFilePath: '/tests/…md'`
- Mechanism: a fixed absolute fake path. Whole-test batches write the code-behind last-run sidecar (session-manager.ts:8467-8549, `writeLastRun`, which does `fs.mkdir(path.dirname(file), { recursive: true })`). On Windows `/tests/plain.md` resolves to `C:\tests\plain.md`, so every run of this suite creates and rewrites `C:\tests\.steptix-codebehind-cache\{plain,matrix,loop}.last-run.json`. Verified on this machine: those three files exist, last written 2026-10-04 23:04, next to an older `.aiui-codebehind-cache`. On Linux/macOS the same mkdir fails with EACCES and is silently swallowed (last-run.ts:233-235). So the code path behaves differently per OS, and `writeLastRun` carries state between runs by read-modify-write (`carryStaleRuns`).
- Risk: medium. Nothing asserts on the sidecar today, so this is pollution and cross-run state rather than a failing test. Any future assertion would inherit the previous run's `staleRuns`.
- Fix: build `testFilePath` from `fs.mkdtempSync(path.join(os.tmpdir(), 'rows-'))`, as every other file in the batch does. Remove the stray `C:\tests\` directory.
- Evidence: the `ls /c/tests/.steptix-codebehind-cache` output, plus the code path.

### `tests/api-server-loops-compile.test.ts:329` — whole file
- Mechanism: a fixed in-repo scratch dir, `const tmpDir = path.join(repoRoot, 'tests', '.tmp-loops-compile');`, which `beforeAll` rm's and re-creates. Two concurrent runs of the same checkout would delete each other's fixtures mid-compile, for example `npm test` alongside a watcher or a second terminal. Windows EBUSY on removal is already handled (`maxRetries: 10, retryDelay: 100`, added in 5e61f46 "Retry removing in-repo temp dirs that Windows briefly locks").
- Risk: medium
- Fix: keep the dir in-repo, which package self-resolution requires, but make it unique: `await fs.mkdtemp(path.join(repoRoot, 'tests', '.tmp-loops-compile-'))`.
- Evidence: the git history above, and the in-file note that the location is deliberate.

Already well guarded (not flagged): every server listens on port 0; temp dirs come from mkdtemp (except the two above); breakpoint and step-mode tests resume on the `step:awaiting` event, with runaway counters (stepmode:1257, control-flow:2176/2222/2249/2757); report assertions are safe because `generateReport` is awaited before `done` (session-manager.ts:8424 vs :8774); stats recording is off suite-wide (vitest.config.ts `env: { STEPTIX_STATS: 'off' }`); the shared `compile-split` session (compile-mode:936) passes in either order.

## Per-file verdicts
| File | Tests | Verdict (High/Medium/Mixed/Low) | One-line note |
|---|---|---|---|
| tests/api-server-compile-mode.test.ts | ~45 | High | Real live compiler + Prettier + recording behind the HTTP entry; one lock test checks nothing, one Windows-only early-return; retained-compiler and timestamp flake risks. |
| tests/api-server-control-flow.test.ts | ~68 | High | Chains, loops, For-each object rows, masking, guard event pairing, breakpoints per pass, return/loop composition; one While-compile case duplicates loops-compile, one weak positive assertion, one 1 s waitFor. |
| tests/api-server-data-rows.test.ts | ~21 | High | Negative seam (no per-row report) asserted on generateReport's input; one exact duplicate of a sections validation row; writes to `C:\tests\` via a fixed fake path. |
| tests/api-server-flow-control.test.ts | ~26 | High | Every skip surface (wire, results[], report rows, header, sidecar, history) asserted separately; authored-line secret checks; clean. |
| tests/api-server-flow-control-literal.test.ts | 6 | High | The real executor; proves a values-decided return makes no model call or settle; clean. |
| tests/api-server-loops-compile.test.ts | ~11 | High | One entry per body line from pass 1, held/not-held condition evidence, kept-count arithmetic; fixed in-repo temp dir. |
| tests/api-server-rows-compile.test.ts | 3 | High | Looped body compiles once against the authored text; kept-session row 2 adds no generation; retained-compiler flake risk. |
| tests/api-server-sections.test.ts | ~79 | High | Only coverage of `validateSectionEntry`'s branches (src/server/section-entry.ts), anchor resolution and dead-section dedup; one trivial control test, one name overclaim. |
| tests/api-server-stepmode.test.ts | ~27 | High | Frames, scope, skill breakpoints, fail-stops-run, secrets; one testFilePath-breakpoint test is vacuous, and the `over` test cannot tell `over` from `into`. |
| tests/api-server-values-block.test.ts | 3 | High | The only suite with the real executor behind HTTP for the `## Values` block and env-secret masking in the watch-group poll. |

## Low-value tests

### `tests/api-server-stepmode.test.ts:1455` — "breakpointsByUri entries keyed at testFilePath are ignored (client trims those)"
- Category: L2
- Evidence: the request is `{ steps: ['Open the page', 'Verify result'], sourceLines: [1, 2], testFilePath, breakpointsByUri: { [testFilePath]: [1] } }`, with no `skillsDir`, no `sections` and no control lines. With those absent the server never expands (session-manager.ts:4319 `if (request.skillsDir || hasSections(request) || hasControlLines)`). So `expansionOrigins` is undefined, `frameInfoFor(i)` returns undefined (:4931), and the whole breakpoint block is skipped at its `frameForStep?.uri &&` guard (:6434). The `clientAlreadyTrimmed` filter the test claims to cover (:6444-6446) is never reached, so deleting that filter would leave this test green. `tests/api-server-sections.test.ts:649` covers the real branch: it sends `sections`, so the root frame really is `kind: 'test'`.
- Recommendation: delete (sections.test.ts:649 is the working guard), or add `skillsDir` to the request so the expansion runs and the root-frame filter is exercised.
- Confidence: high

### `tests/api-server-compile-mode.test.ts:1048` — "an ordinary run does not take the compile lock"
- Category: L2
- Evidence: `await runSteps(requestBody()); expect(compileLock.isLocked(testFilePath)).toBe(false);` asserts after the run has finished, by which point any lock it took would have been released. The lock is acquired in session-manager.ts:2568-2571 and released at run end. A regression that made every run acquire the lock, and release it, would pass. The test only catches a leaked lock, which the next compile test would catch anyway.
- Recommendation: rewrite so the claim is observable: `const release = compileLock.acquire(testFilePath)!`, then run an ordinary `runSteps(requestBody())` and assert status 200, two `step:pass` and no error frame, then `release()`. That is the contract that matters: an ordinary run is not refused while a compile holds the file.
- Confidence: high

### `tests/api-server-control-flow.test.ts:1951` — "compiles a whole file that loops — the refusal is gone"
- Category: L3
- Evidence: a While whose judge says no on its first visit (no `judgeScript`, so `null`), with `compile: 'run'`, over the same HTTP route. It asserts no refusal, the body in `notAttempted` with `'the step did not run — the run decided against it'`, one condition prompt with "Observation 1 — the condition did NOT hold", and `status 'partial'`. `tests/api-server-loops-compile.test.ts:734` ("a While that runs no passes names its body, with the decision sentence") sends the same shape (`judgeScript = [null]`, `whileBody(md)` with `compile: 'run'`). It asserts `notAttempted [3, 4]`, the same sentence on both body steps, one condition prompt and `partial`, and would fail the same way on a refusal, because `compileResult` expects a `compile:result` frame. The two differ only in body length.
- Recommendation: merge into `tests/api-server-loops-compile.test.ts:734`, moving the "Observation 1 — did NOT hold" prompt assertion there, and delete :1951.
- Confidence: medium

### `tests/api-server-data-rows.test.ts:481` — "rejects rowNumbers that do not match the rows"
- Category: L3
- Evidence: `rows: [{file:'b.png'},{file:'c.png'}], rowNumbers: [2, 4], rowCount: 3` POSTed to `/sessions/:id/steps`, asserting `status 400`. `tests/api-server-sections.test.ts:821-825` sends the identical section shape (`{ rowNumbers: [2, 4], rowCount: 3 }` over two rows) to the same route and also asserts the message (`/rowNumbers must all be <=/`). The comment says it "has to hold at THIS seam too", but both files go through the same `POST /sessions/:id/steps` and `validateSectionEntry` (src/server/section-entry.ts:113-119). This request does not even set `dataRow`, so nothing about the data-row path differs.
- Recommendation: delete. The sections.test.ts:805 table covers it with a stronger assertion.
- Confidence: high

### `tests/api-server-sections.test.ts:446` — "omitting sections entirely still works"
- Category: L3
- Evidence: `postSteps({ steps: ['Just this'], sourceLines: [3], testFilePath })` followed by `expect(executedSteps).toEqual(['Just this'])`. A plain sectionless POST that runs its one step is exercised by nearly every api-server suite (e.g. `tests/api-server-stepmode.test.ts:777`, `tests/api-server-data-rows.test.ts:272`). It is the control for :431 ("an empty sections map behaves exactly as absent"), but :431 already asserts the full expected outcome on its own.
- Recommendation: delete, or fold into :431 as a second request.
- Confidence: medium

## Test defects

### `tests/api-server-stepmode.test.ts:845` — "stepMode=over skips a [skill: ...] body atomically"
- Category: Defect (the name contradicts the behaviour; the assertion is too loose to test `over`)
- Evidence: the test's own comment (:879-891) works out that `over` from depth 0 pauses INSIDE the skill body. The code agrees: `(currentMode === 'over' && nextDepth <= curDepth)` (session-manager.ts:8168). So nothing is skipped "atomically". The only `over`-specific assertion is `expect(awaitingCount).toBeGreaterThan(0)`, which `into` (3 pauses), `over` (2) and `out` (1) all satisfy. The frame push/pop assertions repeat :345, and `passCount 4` / `done passed` hold in every mode. A regression that treated `over` as `into` would pass. The only discriminating `over` test in the batch is `tests/api-server-flow-control.test.ts:966`.
- Recommendation: rename (e.g. "stepMode=over from the root pauses inside the skill, then back at depth 0") and assert the pause lines exactly: `expect(events.filter(e => e.type==='step:awaiting').map(e => e.line)).toEqual([8, 3])`. `into` would give `[7, 8, 3]`.
- Confidence: high

### `tests/api-server-control-flow.test.ts:2742` — "parks the ▶ on the guard the run is going back to, not on the skipped line"
- Category: Defect (the positive assertion holds trivially)
- Evidence: `expect(awaitingLines).toContain(4)`. With `stepMode: 'into'`, the very first pause, after line 3 `Open the statements page`, already names the guard line 4 (`nextI = advanceAfter(0)`, session-manager.ts:8157-8178). That pause happens before any return. So a regression that parked the post-return ▶ on line 5, the step after the loop, would pass. Only `not.toContain(9)` discriminates. Guard dispatch never reaches the pause block (it `continue`s at session-manager.ts:6889), so the expected sequence is just the pause after `Open` and the pause after the `Return`, both on line 4.
- Recommendation: `expect(awaitingLines).toEqual([4, 4])`, or `expect(awaitingLines.at(-1)).toBe(4)`. The sibling :2773 uses `awaitingLines.slice(awaitingLines.indexOf(8))`, but no pause names line 8 (guards do not pause), so `indexOf` is -1 and the expression is effectively `.at(-1)`. It still discriminates, but only by accident; write it as `.at(-1)` too.
- Confidence: high for the main finding. Medium for the exact expected sequence, which comes from reading session-manager.ts, not from a run.

### `tests/api-server-compile-mode.test.ts:1041` — "folds the drive-letter case, so two spellings of one file take one lock"
- Category: Defect (passes with zero assertions on Linux/macOS)
- Evidence: `if (process.platform !== 'win32') return;` reports a pass on two of the three CI platforms without asserting anything. Project policy (CLAUDE.md "Mark a test that is about one platform") is `it.runIf(process.platform === 'win32')`, which reports it as skipped.
- Recommendation: `it.runIf(process.platform === 'win32')(…)`, and optionally a POSIX case asserting that `compileLockKey('/a/B.md') !== compileLockKey('/a/b.md')` on Linux, if that is the intended rule.
- Confidence: high

### `tests/api-server-sections.test.ts:980` — "tags body steps with the outermost section, and skips skill-private ones"
- Category: Defect (the name overclaims)
- Evidence: the fixture is a section calling `[skill: wave]`, and `wave.md` (:214-217) defines no sections of its own. So the "skips skill-private ones" half is never exercised (src/skills/expander.ts:738 "a skill's internal sections never become the tag"; session-manager.ts:1798). The assertions only check that a main-flow step has no tag and that a section→skill step carries both `sourceSection` and `sourceSkill`.
- Recommendation: either drop "and skips skill-private ones" from the name, or add `[skill: protoskill]`, whose `### __proto__` body step ("Skill body ran") should carry no `sourceSection`, and assert that.
- Confidence: high

## Duplication clusters
- Narrowed-row validation `rowNumbers:[2,4], rowCount:3`: `tests/api-server-sections.test.ts:821`, `tests/api-server-data-rows.test.ts:481` → keep sections, drop data-rows.
- Run & Compile of a While that runs no passes: `tests/api-server-loops-compile.test.ts:734`, `tests/api-server-control-flow.test.ts:1951` → keep loops-compile, fold the "Observation 1 — did NOT hold" assertion into it.
- Main-flow test-file breakpoint is not honoured by the server: `tests/api-server-sections.test.ts:649` (exercises `clientAlreadyTrimmed`), `tests/api-server-stepmode.test.ts:1455` (never reaches it) → keep sections, drop or fix stepmode.
- `over` stepping: `tests/api-server-flow-control.test.ts:966` (discriminating), `tests/api-server-stepmode.test.ts:845` (not discriminating) → tighten stepmode as above.
- Not duplicates; noted to save a later reviewer time. Several tests rerun one fixture and assert different surfaces:
  - control-flow `chainBody` with judge `[0]`: :477 events, :522 report rows, :2530 reason/skipKind, :2607 results[];
  - flow-control `nestedBody`: :378, :397, :428, :464, :480, :510;
  - flow-control-literal `reviewBody`: :352-:416.

  Each surface is built separately in session-manager, so keep them.

## Cost concerns
- compile-mode, loops-compile and rows-compile run a real live compile per case (Prettier, esbuild validation, generation, review). loops-compile and rows-compile set `CASE_TIMEOUT = 30_000`, which repeats the suite-wide `testTimeout: 30_000` in vitest.config.ts. The cost is inherent to what they test. The one cheap saving is `tests/api-server-rows-compile.test.ts:519`, which runs a second full Run & Compile with the same request as :462 just to assert `stepCalls` instructions; fold that assertion into :462.
- control-flow:1639 bundles and loads a real `.ts` tool from tmp (`toolsDir`). It is the only way to get a real `setVar` write over HTTP, and it is worth it.

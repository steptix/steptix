# Unit test review — every finding

Generated from the 16 batch reports in [batches/](batches/). One row per finding; a finding can cover several tests (a describe block, or a table written longhand). The batch report named in the last column has the full evidence, quoted lines and reasoning.

Totals: Defect 65 · Low 233 · Flake (medium) 86 · Flake (high) 17 · all 401

Batch `Run` means observed in the CI logs or the local stress runs rather than found by reading; the other batch ids name the report in batches/.

Kinds: **Low L1** tautological / tests the mock · **L2** cannot fail · **L3** duplicate · **L4** change-detector · **L5** trivial subject · **L7** dead subject (no production caller) · **L8** cost out of proportion · **Defect** the test does not check what its name or comment claims · **Flake** a mechanism that can fail on a loaded or different machine.


## Root suite (vitest, tests/)

### `tests/action-parser.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 25 | extracts JSON from surrounding prose | Defect | the input is `'Sure, here is the JSON: {"actions":[],"reasoning":"ok"} — hope that helps.'` and the assertion is `expect(result).toContain('"actions"')`. This passes even if `extractJson` returned its input unchanged (stripped no prose at all); it fails only… | `expect(result).toBe('{"actions":[],"reasoning":"ok"}')`. | high | R10 |
| 96-131, 169-179, 221-236, 285-294, 312-… | "parses a type action with value", "parses a navigate action with url", "parses multiple… | Low L3 | every case has the same shape: build `{actions:[{action: X, <field>: v}]}`, then assert `result.actions[0]?.<field>).toBe(v)`. Each one guards a single `if (typeof obj['f'] === 'string') action.f = obj['f']` line of `parseAction` (src/ai/action-parser.ts:835-… | rewrite as one `it.each` table of (action, field, value) that covers every field `parseAction` copies, including the uncovered ones. Delete the two one-test `find`/`expand` describe blocks, "parses m… | high | R10 |
| 296 | "normalises \"press\" alias to keyboard"; `tests/action-parser.test.ts:462` — "normalises… | Low L3 | all four assert that `parseAIResponse(...).actions[0].action` equals the alias target for a hand-picked list. `tests/unknown-action-type.test.ts:313` ("folding merges no two meanings") already asserts `canonicalActionType(name) === target` for EVERY entry of… | delete; keep unknown-action-type.test.ts:274 (parser seam) and :313 (exhaustive). | high | R10 |

### `tests/ai-client.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 196 | refuses the request rather than building a gateway with no key | Low L3 | `delete (cfg as Partial<AiConfig>).apiKey`, then `rejects.toBeInstanceOf(AiNotConfiguredError)` and `constructorMock` not called. The `'absent'` row of the keyless table at `tests/ai-client.test.ts:349` does the same deletion and asserts the same error class,… | delete, or move its one extra assertion (`constructorMock` still not called after `complete()`) into the table at :349. | high | R09 |
| 303 | lets aibroker/ fall through to the default endpoint, guard or no guard" / "leaves a keyed… | Low L3 | both build `AiClient` with `aibroker/openai/chatgpt-5.5` on the default URL and assert `constructorMock` was called with `{ baseURL: 'https://llm.corp.example/v1' }`. That is the same config and assertion as `tests/ai-client.test.ts:120`. :409 differs only… | merge into :120 and reference it from the two describe blocks as the control. | medium | R09 |
| 703 | forwards a timeout-only AbortSignal when no run signal is passed | Low L3 | it asserts `expect(sawOpts.signal).toBeInstanceOf(AbortSignal); expect(sawOpts.signal.aborted).toBe(false);`. `tests/ai-client.test.ts:561-562` ("calls chat with passed-through messages, maxTokens, responseFormat, composite signal") makes exactly these two as… | delete, or rewrite with fake timers to assert the signal aborts at 120 s (the only thing that would make it distinct). | high | R09 |
| 812 | reports both a model AND key change together | Low L3 | `expect(change).toBe('AI model … → openai/chatgpt-5.5; AI API key changed')`. `tests/ai-client.test.ts:869` covers the `'; '` join and key redaction for all three changes. | delete (keep :869). | medium | R09 |

### `tests/ai-effort.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 169 | does not invalidate the memoized gateway between profiles | Defect | this file's `FakeAIGateway` constructor records nothing (`constructor() { this.chat = chatMock; this.stream = streamMock; }`), and every instance shares `chatMock`. The assertions `chatMock` called twice and `lastChatOptions().effort === 'high'` hold whether… | add a constructor spy (as `tests/ai-client.test.ts:38` does) and assert the constructor ran once. | high | R09 |
| 181 | responseFormat and signal still ride alongside the profile | Low L3 | `client.ts` builds the options for every profile in one literal, `{ ...this.resolveProfile(options?.profile), responseFormat: { type: 'json_object' }, signal: this.buildSignal(signal) }`, so the authoring profile takes no branch that `tests/ai-client.test.ts:… | delete. | medium | R09 |

### `tests/api-response-store.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 43 | retrieves response by step number", "returns undefined for missing step", "clears all res… | Low L7 | `getForStep`, `getAll` and `clear` (src/api/response-store.ts:14,18,46) have no production caller. `grep -rn "getForStep\\|\.getAll()" src runner-core/src steptix-vscode/src flick-vscode/src` returns nothing outside response-store.ts; the four `new ApiRespons… | delete these tests together with the three unused methods. "starts empty"/"stores a response" can stay but should assert via `hasResponses()` only. | high | R02 |

### `tests/api-server-cdp.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 388 | Per-route 401 tests — ("both routes require the api key"), `:855`, `:1120` ("requires the… | Low L3 | auth is one global `app.use` registered at src/server/api-server.ts:523-533, before every route except `/health` (472). Each test sends a keyless request and asserts 401, which tests/api-server.test.ts:305/314 already prove for that middleware; the `expect(la… | replace all six with one test in tests/api-server.test.ts that walks the app's registered routes (`app._router.stack`, or a list exported beside `createApiServer`) and asserts every route except `/he… | medium… | R02 |
| 393 | an authenticated request bumps the idle monitor" / "an authenticated focus bumps the idle… | Flake (medium) | real wall clock on both sides of a real HTTP round trip. `IdleMonitor` defaults to `Date.now` (src/server/idle-monitor.ts:24). After the request, `expect(idleMonitor.idleFor()).toBeLessThan(QUIET_MS)` (250 ms) fails if the tail of the request after the auth m… | inject a fake clock the way tests/api-server.test.ts:952 does (`new IdleMonitor(60, () => clockNow)` passed as `createApiServer`'s third argument) and assert exact values. Better still, delete both (… |  | R02 |
| 393 | an authenticated request bumps the idle monitor" / "an authenticated focus bumps the idle… | Low L3 | the bump is in the global auth middleware (`app.use(...)` → `idleMonitor.bump()`, src/server/api-server.ts:523-532), not in the CDP routes. tests/api-server.test.ts:1035 "does not bump the idle timer, while an authenticated request does" already proves an aut… | delete both. | high | R02 |
| 584 | POST echoes which scope the launch went into | Flake (medium) | posts `projectRoot: userRoot()`, the REAL `userRootDir()` (`%LOCALAPPDATA%\steptix`, `$XDG_CONFIG_HOME/steptix` or `~/.steptix`). The POST route runs `loadConfig(undefined, projectRoot)` on it before launching (api-server.ts:1914-1925), so on a developer mach… | in a `beforeAll`, point `LOCALAPPDATA` (win32) / `XDG_CONFIG_HOME` (POSIX) at an `fs.mkdtempSync(os.tmpdir())` dir and restore in `afterAll`. |  | R02 |
| 638-650 | returns outcome: launched_into_new_profile" / "...existing_profile" / "reused_running_bro… | Low L1 + L3 | each sets `startCdpBrowserMock.mockResolvedValue(ok(outcome))` and asserts `expect(body.outcome).toBe(outcome)`. The route has no per-outcome logic: it copies `outcome: result.outcome, warnings: result.warnings` (src/server/api-server.ts:1951-1952). The four… | replace the five tests with one that asserts the whole 200 body with `toEqual` (outcome, warnings, binary, tabs, scope), the way "closes a tab and echoes what went" (line 859) already does for DELETE. | high | R02 |
| 724 | two concurrent POSTs for the same key produce ONE launch | Flake (high) | the gate is released on a timer, not on an event: `await new Promise((r) => setTimeout(r, 20)); release();` then `expect(startCdpBrowserMock).toHaveBeenCalledTimes(1)`. The route `await loadConfig(undefined, projectRoot)` (src/server/api-server.ts:1914, real… | release only once both requests have joined the slot. The map lookup follows `await loadConfig(...)` with no further `await` (api-server.ts:1914-1936), so a partial `vi.mock('../src/config/loader.js'… |  | R02 |
| 750 | different profiles are NOT serialised against each other | Flake (high) | `await new Promise((r) => setTimeout(r, 20)); expect(started).toBe(2);` — both POSTs must traverse HTTP + `loadConfig` and reach the mock within 20 ms of wall clock. On a loaded box `started` is still 1. | `await vi.waitFor(() => expect(started).toBe(2))` (a serialising implementation would still fail, by the waitFor timeout) before `release()`. |  | R02 |
| 999 | does not serialise closes against DIFFERENT browsers | Flake (high) | the overlap window is a 30 ms sleep inside the mock (`await new Promise((r) => setTimeout(r, 30))`) and the test asserts `expect(maxConcurrent).toBe(2)`. If the second DELETE reaches the mock more than 30 ms after the first (loaded box, same event loop as the… | replace the 30 ms sleep with a shared gate: each mock call increments `inFlight` then awaits a promise; the test does `await vi.waitFor(() => expect(inFlight).toBe(2))` and then releases. The seriali… |  | R02 |
| 1224 | does NOT serialise concurrent focuses | Flake (high) | same as above with three requests: 30 ms sleep window, `expect(maxConcurrent).toBe(3)`. | gate + `vi.waitFor(() => expect(inFlight).toBe(3))`, then release. |  | R02 |
| 1245 | does not close anything, or create a session | Low L2 | the only assertion is `expect(closeCdpTabMock).not.toHaveBeenCalled();` after a focus. The focus route (src/server/api-server.ts:2104-2140) calls `readTabParams`, `cdpRoots`, `focusCdpTab` (mocked) and `statusForCdpFailure` — never `closeCdpTab` — so nothing… | rewrite to assert what the name says, as the peek suite does at line 1341 ("creates no session": compare `GET /sessions` before/after) and line 1317 (`runsInFlight` unchanged), or delete. | high | R02 |

### `tests/api-server-codebehind-debugger.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 528 | Stop while parked for the debugger does not arm the next run | Defect | - The test's own comment says "this one passes with or without the fix". | set a `sawPause` flag in the first loop and assert it is true. Assert `events.find((e) => e.type === 'done')?.status === 'passed'` for the second run. | high | R04 |

### `tests/api-server-codebehind.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 638, :673, :734, :757, :808 | inline spy restore | Defect | `run.mockRestore(); close.mockRestore();` is the last statement of each test, and the file's `afterEach` (:466) only removes the temp dir. A failing assertion leaves `sessionManager.executeSteps`/`closeSession` spied for every later test. | add `vi.restoreAllMocks()` to the `afterEach`. | high | R04 |
| 669 | keeps nothing of a run on the session — there is no last run to reuse | Low L2 / L7 | `expect((sessionManager as unknown as { lastRunDetails?: unknown }).lastRunDetails).toBeUndefined();`. `grep -rn "lastRunDetails" src/ runner-core/src steptix-vscode/src flick-vscode/src` returns nothing. `git log -S lastRunDetails -- src` shows the property… | delete. | high | R04 |
| 985 | "compiles dry even when the request asks for a real write" (partial) | Low L1 | - `expect(events.at(-1)!.data.summary.written).toEqual([]);` reads the mocked core's own `written: []` (mock at :86). | keep the test and delete the two lines. Optionally add the real claim by asserting that `smoke.steps.ts` does not exist on disk afterwards. | high | R04 |

### `tests/api-server-compile-mode.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 360-370 | (file-wide; beforeEach) — every `compile: 'run'` case | Flake (medium) | a `'run'` compile is retained on its session by design (src/server/session-manager.ts:8704-8714 clears only `'steps'`), and no test closes its session except :1297. Meanwhile each `beforeEach` does `await fs.rm(path.join(tmpDir, '.steptix-codebehind-cache'),… | record every session id `runSteps`/`postTo`/`block` mints, and `DELETE /sessions/:id` for each in `afterEach`. Add `maxRetries: 10, retryDelay: 100` to the two `fs.rm` calls in `beforeEach` (:368-369… |  | R01 |
| 781 | compile:\"steps\" splices the recording, leaving the siblings untouched | Flake (medium) | the test separates two runs by time: `await new Promise((r) => setTimeout(r, 5));` then `expect(after!.steps[1]!.recordedAt).not.toBe(before!.steps[1]!.recordedAt)`. Telling "fresh" from "untouched" depends on two `new Date().toISOString()` stamps differing.… | stop using the clock as the discriminator. Have the `executeStep` mock put a per-call counter in `capturedContext.domBefore`, then assert that step 2's `domBefore` changed and step 1's did not. |  | R01 |
| 1041 | folds the drive-letter case, so two spellings of one file take one lock | Defect | `if (process.platform !== 'win32') return;` reports a pass on two of the three CI platforms without asserting anything. Project policy (CLAUDE.md "Mark a test that is about one platform") is `it.runIf(process.platform === 'win32')`, which reports it as skippe… | `it.runIf(process.platform === 'win32')(…)`, and optionally a POSIX case asserting that `compileLockKey('/a/B.md') !== compileLockKey('/a/b.md')` on Linux, if that is the intended rule. | high | R01 |
| 1048 | an ordinary run does not take the compile lock | Low L2 | `await runSteps(requestBody()); expect(compileLock.isLocked(testFilePath)).toBe(false);` asserts after the run has finished, by which point any lock it took would have been released. The lock is acquired in session-manager.ts:2568-2571 and released at run end… | rewrite so the claim is observable: `const release = compileLock.acquire(testFilePath)!`, then run an ordinary `runSteps(requestBody())` and assert status 200, two `step:pass` and no error frame, the… | high | R01 |

### `tests/api-server-content.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 663 | a session that does not exist is still 404, not 409 | Low L3 | `await api('GET', '/sessions/s-never-existed/content'); expect(status).toBe(404);` is the same route, same input class (an id never created) and same assertion as "returns 404 for an unknown session" at tests/api-server-content.test.ts:390 (`api('GET', '/sess… | delete; the 404-vs-409 contrast the name wants is already made by 390 sitting beside 643. | high | R02 |

### `tests/api-server-control-flow.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 1951 | compiles a whole file that loops — the refusal is gone | Low L3 | a While whose judge says no on its first visit (no `judgeScript`, so `null`), with `compile: 'run'`, over the same HTTP route. It asserts no refusal, the body in `notAttempted` with `'the step did not run — the run decided against it'`, one condition prompt w… | merge into `tests/api-server-loops-compile.test.ts:734`, moving the "Observation 1 — did NOT hold" prompt assertion there, and delete :1951. | medium | R01 |
| 2102 | ends as aborted rather than as a server error | Flake (medium) | `await vi.waitFor(() => expect(generatedReports.length).toBeGreaterThan(0));` polls with vitest's default 1000 ms deadline. Before it passes, the server has to notice the client abort, reject the parked judge, unwind the loop and write the report. All of that… | wait on an event, not a deadline. Have the `generateReport` mock resolve a deferred promise that the test awaits, or at minimum pass `{ timeout: 10_000 }`. |  | R01 |
| 2742 | parks the ▶ on the guard the run is going back to, not on the skipped line | Defect | `expect(awaitingLines).toContain(4)`. With `stepMode: 'into'`, the very first pause, after line 3 `Open the statements page`, already names the guard line 4 (`nextI = advanceAfter(0)`, session-manager.ts:8157-8178). That pause happens before any return. So a… | `expect(awaitingLines).toEqual([4, 4])`, or `expect(awaitingLines.at(-1)).toBe(4)`. The sibling :2773 uses `awaitingLines.slice(awaitingLines.indexOf(8))`, but no pause names line 8 (guards do not pa… | high fo… | R01 |

### `tests/api-server-data-rows.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 236, 262, 275, 313, 408, 447, 486, 507 | every test using `testFilePath: '/tests/…md'` | Flake (medium) | a fixed absolute fake path. Whole-test batches write the code-behind last-run sidecar (session-manager.ts:8467-8549, `writeLastRun`, which does `fs.mkdir(path.dirname(file), { recursive: true })`). On Windows `/tests/plain.md` resolves to `C:\tests\plain.md`,… | build `testFilePath` from `fs.mkdtempSync(path.join(os.tmpdir(), 'rows-'))`, as every other file in the batch does. Remove the stray `C:\tests\` directory. |  | R01 |
| 481 | rejects rowNumbers that do not match the rows | Low L3 | `rows: [{file:'b.png'},{file:'c.png'}], rowNumbers: [2, 4], rowCount: 3` POSTed to `/sessions/:id/steps`, asserting `status 400`. `tests/api-server-sections.test.ts:821-825` sends the identical section shape (`{ rowNumbers: [2, 4], rowCount: 3 }` over two row… | delete. The sections.test.ts:805 table covers it with a stronger assertion. | high | R01 |

### `tests/api-server-loops-compile.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 329 | whole file | Flake (medium) | a fixed in-repo scratch dir, `const tmpDir = path.join(repoRoot, 'tests', '.tmp-loops-compile');`, which `beforeAll` rm's and re-creates. Two concurrent runs of the same checkout would delete each other's fixtures mid-compile, for example `npm test` alongside… | keep the dir in-repo, which package self-resolution requires, but make it unique: `await fs.mkdtemp(path.join(repoRoot, 'tests', '.tmp-loops-compile-'))`. |  | R01 |

### `tests/api-server-record-steps.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 593 | a quick burst of actions goes in ONE call | Flake (high) | `restartApp({ draftSettleMs: 500 })`, then two separate Playwright gestures, `await pageOf().click('#email'); await pageOf().check('#cash');`, followed by `expect(ai.requests).toHaveLength(1)`. The settle window starts when the first click reaches the draft e… | hold the first call open with `holdCalls()` (as other tests in this file do) or use `NEVER_SETTLES_MS` and end with Stop. Either way, assert the grouping by what one call contained rather than by bea… |  | R10 |
| 763 | and `tests/record-steps-recorder.test.ts:592` — Back/Forward/Refresh classification | Flake (medium) | classification reads `Page.getNavigationHistory` after each commit, re-reading for up to 2 s while it lags. The tests space the moves with `sleep(250/300)`. The races these depend on were fixed in 285815c/dd41cb3, which leaves a residual risk under heavier lo… | keep as is but rerun under load. If it flakes again, wait for the recorder's own read count to settle (as in the rigged tests) instead of fixed sleeps. |  | R10 |
| 1288 | Pause and Resume from the toolbar: record:paused, nothing recorded and no draft call whil… | Flake (medium) | `restartApp({ draftSettleMs: 700 })`, click `#reports`, `waitForCount('record:action', 1)`, then `page.keyboard.press('Alt+Shift+P')`. The pause must reach the engine before the 700 ms settle window fires, otherwise `expect(ai.requests).toHaveLength(0)` (:130… | raise the window (e.g. 5 s, since `draftThrough(1)` after Resume already polls up to 15 s) or hold the call with `holdCalls()` and assert it was never started. |  | R10 |
| 1817 | the Done bar is gone before the run's first step: the model never sees it | Flake (medium) | `expect(Date.now() - doneAt).toBeLessThan(5_000)` (:1831) across `toolbarShows(...)` (up to 8 s of polling), a POST that starts a run, and `callInFlight()`. If the run is slower than 6 s the bar has removed itself and the check becomes vacuous. If it takes 5–… | make the end-show time configurable (as `typedNavigationWindowMs` is) and set it to minutes in this test, then drop the elapsed-time assertion. |  | R10 |

### `tests/api-server-rows-compile.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 402-408 | all three cases | Flake (medium) | this is the same mechanism as compile-mode. Sessions `rows-section`, `rows-section-exec` and `rows-kept` each retain a `'run'` compiler and are never DELETEd, and `beforeEach` does `fs.rm(path.join(tmpDir, '.steptix-codebehind-cache'), { recursive: true, forc… | `DELETE` each session after its case, and add `maxRetries` to the rm. |  | R01 |

### `tests/api-server-sections.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 446 | omitting sections entirely still works | Low L3 | `postSteps({ steps: ['Just this'], sourceLines: [3], testFilePath })` followed by `expect(executedSteps).toEqual(['Just this'])`. A plain sectionless POST that runs its one step is exercised by nearly every api-server suite (e.g. `tests/api-server-stepmode.te… | delete, or fold into :431 as a second request. | medium | R01 |
| 980 | tags body steps with the outermost section, and skips skill-private ones | Defect | the fixture is a section calling `[skill: wave]`, and `wave.md` (:214-217) defines no sections of its own. So the "skips skill-private ones" half is never exercised (src/skills/expander.ts:738 "a skill's internal sections never become the tag"; session-manage… | either drop "and skips skill-private ones" from the name, or add `[skill: protoskill]`, whose `### __proto__` body step ("Skill body ran") should carry no `sourceSection`, and assert that. | high | R01 |

### `tests/api-server-stepmode.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 845 | stepMode=over skips a [skill: ...] body atomically | Defect | the test's own comment (:879-891) works out that `over` from depth 0 pauses INSIDE the skill body. The code agrees: `(currentMode === 'over' && nextDepth <= curDepth)` (session-manager.ts:8168). So nothing is skipped "atomically". The only `over`-specific ass… | rename (e.g. "stepMode=over from the root pauses inside the skill, then back at depth 0") and assert the pause lines exactly: `expect(events.filter(e => e.type==='step:awaiting').map(e => e.line)).to… | high | R01 |
| 1455 | breakpointsByUri entries keyed at testFilePath are ignored (client trims those) | Low L2 | the request is `{ steps: ['Open the page', 'Verify result'], sourceLines: [1, 2], testFilePath, breakpointsByUri: { [testFilePath]: [1] } }`, with no `skillsDir`, no `sections` and no control lines. With those absent the server never expands (session-manager.… | delete (sections.test.ts:649 is the working guard), or add `skillsDir` to the request so the expansion runs and the root-frame filter is exercised. | high | R01 |

### `tests/api-server-tools.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 309 | without toolsDir, [tool: ...] steps fall through to executeStep (legacy) | Defect | the only assertion is `expect(captures).toHaveLength(0)`. `sseEvents` never checks `res.ok`, so a 4xx/5xx JSON body yields zero events and passes; so does a step that failed outright. Nothing asserts that `executeStep` received the `[tool: echo ...]` line (th… | assert `vi.mocked(executeStep)` was last called with `'[tool: echo value="should-fall-through"]'` and that the `done` event says `passed`. | high | R02 |
| 509 | abort while parked awaiting debugger ack unwinds cleanly without hitting debugger; | Low L2 | the test calls `ac.abort()` on the client's own fetch the moment it sees `tool:awaiting-debugger`; the next `reader.read()` rejects with AbortError, so no later event can ever be pushed to `events`. The tool cannot have run before that event (it is parked wai… | rewrite to observe the server, not the aborted stream: after the abort, wait for `GET /health` `runsInFlight === 0`, then assert `GET /sessions/:id` has no `echoed` output (or have the fixture tool w… | high | R02 |

### `tests/api-server-viewport.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 282 | resolves the explicit form too | Low L3 | same seam and same assertion shape as "resolves a preset and launches with the exact fixedViewport" (line 274) — `config.viewport` → `resolveViewportSpec` → `launchBrowser(...).fixedViewport` — differing only in the input string `'767x1024'`. The parse of exa… | delete. | high | R02 |
| 392 | refuses an out-of-range size, naming it | Low L3 | same branch as "fails the batch with the §1 error and launches NOTHING" (line 381): `resolveViewportSpec` throws → 500 → `expect(launchBrowserMock).not.toHaveBeenCalled()`. The only extra is `toContain('50x50')`, which tests/viewport-config.test.ts:104-119 al… | delete, or fold into 381 as a second `it.each` row if the no-launch claim should be shown for both refusal kinds. | high | R02 |

### `tests/api-server.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 375 | resolves ${data.X} to the data-file value when envName is sent | Defect | asserts only `expect(status).toBe(200); expect(body.status).toBe('passed');`. `executeStep` is mocked to pass whatever instruction it gets, and the sibling test's own comment (line 360) says "If envName were dropped (the bug), the literal would pass through t… | rewrite to assert `vi.mocked(executeStepMock).mock.calls.at(-1)[2] === 'Navigate to https://example.test/'` (the instruction actually reaching the executor). | high | R02 |
| 589 | returns list of active sessions | Flake (medium) | order dependence — `// Ensure at least one session exists (from prior tests)` ... `expect(body.sessions.length).toBeGreaterThan(0)`. Run alone (`-t`, `it.only`) or reordered, the list is empty and the test fails. | POST a step to its own session id first, then assert that id is in the list. |  | R02 |
| 751 | aborts the in-flight run when the client disconnects | Flake (medium) | wall-clock waits stand in for events: `await new Promise((r) => setTimeout(r, 250)); ac.abort();` then `await new Promise((r) => setTimeout(r, 800));` before `expect(callsAfterAbort).toBeLessThan(5)` with a mocked step that sleeps 200 ms. If the server is slo… | gate the mocked step on a promise (as `slowStep()` at line 1060 already does): release step 1, wait for the `step:start` of step 2 on the stream, abort, then await the run's completion (e.g. poll `GE… |  | R02 |
| 897 | accepts env in request body without crashing | Low L3 | asserts only `expect(status).toBe(200); expect(body.status).toBe('passed');`, and its own comment says "here we just confirm the API surface accepts and runs the request". A server that dropped `env` from its allow-list would pass it. tests/api-server-run-set… | delete. Keep its sibling "does not leak env into server process.env" (909), which asserts something real. | high | R02 |

### `tests/arrays-in-tools-integration.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 98 | captures every link via read multiple, then visits each in a tool | Defect | the file header says it exercises "the full chain … read multiple: true → resolvedParameters['links'] = JSON-encoded array → tool", but the storage step is the test's own code: `params['section_links'] = JSON.stringify(readResult.capturedValues);` with the co… | drive the read through the step-executor storage path, or narrow the header/name to "executeAction read-multiple + array decode". | high | R13 |
| 151 | inline `urls=["…","…"]` literal works end-to-end without a captured variable | Low L3 | inline JSON-array literal decode is `tests/tool-array-params.test.ts:73` ("decodes an inline `urls=["a","b"]` literal into a typed string[]"). The extra here is the fixture `visit_each` tool navigating two pages, which `:98` already shows. | delete. | medium | R13 |
| 191 | fails fast with a labelled error when caller passes a non-array string | Low L3 + L8 | `args: { urls: 'not-an-array' }` → `expect(outcome.error).toMatch(/parameter "urls".*expected a string\[\]/)`. Same input class and identical regex as `tests/tool-array-params.test.ts:175` ("reports a labelled error when the value is not a JSON array": `args:… | delete. | high | R13 |

### `tests/assertion-action.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 7, 27, 35, 43 | accepts an assert action with description, condition, expected", "rejects an assert actio… | Low L3 | missing `expected` (dom mode) is asserted three times: here (`toThrow(/expected/i)`), at `tests/action-parser.test.ts:262` (`toThrow(/missing required "expected" field/)`) and at `tests/predicate-assertions.test.ts:64` (same regex). Missing `condition` and mi… | move `:51` and `:68` into action-parser.test.ts's assert block and delete this file. | high | R10 |

### `tests/auth-resolver.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 1-140 | whole file ("parseApiType", "shouldUseBrowserContext", "extractApiTypeFromContext", "reso… | Low L7 | `grep -rnE "resolveAuth\|shouldUseBrowserContext\|parseApiType\|extractApiTypeFromContext\|auth-resolver" src runner-core/src steptix-vscode/src flick-vscode/src` returns only `src/api/auth-resolver.ts` itself. The only other references in the repo are `docs/… | delete the test together with `src/api/auth-resolver.ts`, or wire the resolver in if the feature is still planned. If the file is kept, also fix the `afterEach` (:86) so it removes added env keys. | high | R09 |

### `tests/bedrock-keyless.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 251 | forwards AI_EFFORT with a bedrock model like any other | Low L3 | `expect(chatMock.mock.calls[0]?.[1]).toMatchObject({ effort: 'high' })`. `AiClient.resolveProfile` (src/ai/client.ts:494-505) has no model-dependent branch, so this is the same path as `tests/ai-effort.test.ts:146`, which also asserts the cap. The test's own… | delete (reinstate only if a provider-specific effort branch appears). | medium | R09 |

### `tests/browser-history.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 134 | does not require a url, a selector or a value | Low L1 / L3 | the input is `{ action: 'back', description: 'Go back' }`, and the test asserts `only.url`, `only.selector` and `only.value` are `toBeUndefined()`. Those values are simply absent from its own input. The "not rejected" half is already proved by `tests/browser-… | delete. | medium | R09 |

### `tests/browser-launch-args.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 148 | is not passed to a CDP attach | Low L2 | this file never stubs `globalThis.fetch`, unlike `browser-manager-focus.test.ts:115` and `browser-manager-viewport.test.ts:131`. `launchBrowser(..., { port: 9222 })` calls `preflightCdpPort(9222)` (src/browser/manager.ts:1283), which makes a real request to `… | stub `fetch` like the sibling files, make `connectOverCDP` resolve a fake browser, and assert its call args. Or delete, since the early return makes the property structural. | high | R09 |

### `tests/build-info.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 64-142 | the `scripts/build-info.mjs` block (5 tests) | Flake (medium) | real `git init`/`git commit` in tmp repos that inherit the machine's global git config. `commit.gpgsign=false` and the identity are overridden (line 76), but a global `core.hooksPath` or `init.templateDir` hook (git-secrets, talisman, corporate pre-commit) ru… | add `-c core.hooksPath=<empty tmp dir>` (or `--no-verify` on commit) and `-c init.templateDir=` to the `git()` helper; set `GIT_CONFIG_GLOBAL` to an empty file for full isolation. |  | R06 |

### `tests/cdp-launcher.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 73 | does not mistake Edge for Chrome | Low L3 | `expect(classifyEngine('Edg/151.0.4129.59')).not.toBe('chrome')` is implied by `tests/cdp-launcher.test.ts:54`, which asserts the same input `toBe('edge')`. | delete. | high | R09 |

### `tests/cdp-registry.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 23 | (also `:531`, `:550`, `:1575`, `:1633`) — fixture roots `path.join('C:', 'proj')`, `path.… | Defect | CLAUDE.md, "Unit tests pass on Windows, Linux and macOS": "Never hard-code `C:\…` or `path.join('C:', …)`: on Linux and macOS that is a relative name". It passes today only because the in-memory fs matches exact strings, and `resetProfile`'s `path.relative(re… | `const ROOT = path.resolve(path.sep, 'proj')` and likewise for `USER` and the `outside`/`target` dirs. | medium | R09 |
| 322 | asking for a profile that exists is not an error | Low L3 | the setup is identical to `tests/cdp-registry.test.ts:309` (same fakeFs, profile `admin`, probe). :309 asserts `{ ok: true, outcome: 'launched_into_existing_profile' }`; :322 asserts only `result.ok === true`. | delete. | high | R09 |
| 1136 | warns when an ordinary close leaves a running browser with no tabs | Low L3 | the arrangement is identical to `tests/cdp-registry.test.ts:1277`: `listTabs = stage++ === 0 ? TWO_TABS : []`, `alive = true`, `now = clock += 500`, same target. One test asserts the warning, the other `{ ok: true, remainingTabs: 0, browserExited: false }`: t… | merge into :1277. | high | R09 |

### `tests/cdp-teardown-invariant.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 51 | never closes the context — that is the whole point of CDP teardown | Low L3 | `not.toContain('context.close')` on `fakeSession({ cdp: true })`. `tests/cdp-teardown-invariant.test.ts:57` runs the same fixture and asserts `toEqual(['browser.close'])`, which already excludes it. | delete, or fold its title into :57. | high | R09 |

### `tests/clarification-prompt.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 198 | reader passed into the wrapper is forwarded to runInteractiveRepl so a single readline is… | Defect | asserts only `expect(args.reader).toBeDefined();`. The regression the name describes — the wrapper opening a second readline on stdin — is a substitution, not an omission: if `promptUserWithReplEscape` (src/runner/step-executor.ts:4906-4940) passed a freshly… | keep the reader from `scriptedReader(...)` and assert `expect(args.reader).toBe(reader)`. | high | R13 |

### `tests/cli-lazy-launch.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 215 | tears down cleanly when nothing ever launched | Low L3 | same input as line 205 (`runTest(makeInstance([]), ...)`). It asserts `expect(report).toBeDefined()` (runTest always returns the report, and line 205 already awaited it without a throw) and `expect(closeBrowserMock).not.toHaveBeenCalled()`. Production teardow… | merge into `tests/cli-lazy-launch.test.ts:205` (add the `closeBrowserMock` line there) and delete. | medium | R06 |

### `tests/cli-parameters-env.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 52 | an unset $VAR (in neither base nor overlay) stays unresolved — proves the overlay is what… | Low L3 | no `.env` files and no `resolveEnvBundle` call: `resolveParameters({ token: '$STEPTIX_T2_ONLY_REGRESSION' }, undefined, false)` → `''`. That is tests/parameters.test.ts:92 (`$NONEXISTENT_VAR_XYZ` → `''`) again. It proves nothing about the overlay. | rewrite as the real control. Write the same `.env`/`.env.t2`, call `resolveEnvBundle` with no env selected (or a different one), and expect `$T2_ONLY` → `''`. Otherwise delete. | high | R06 |

### `tests/cli-server-lifecycle.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 43 | (used by 147, 181, 378) — `deadUrl()` | Flake (medium) | `const url = await startStub(() => {}); await stopStub(); return url;` binds an ephemeral port, releases it, and assumes nobody takes it before the probe. Another vitest worker (many in this suite bind port 0) can be handed the freed port, and `status`/`stop`… | make "down" provable. Use a stub whose connection handler `socket.destroy()`s every connection (still classified `down`), or keep the listener and assert the transport failure through it. |  | R06 |

### `tests/codebehind-*.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| (7 files) | fixed in-repo scratch dir never cleaned before the run | Flake (medium) | `const tmpBase = path.join(repoRoot, 'tests', '.tmp-codebehind-compile');` with `beforeEach(() => { dir = path.join(tmpBase, \`t${counter++}\`); await fs.mkdir(dir, { recursive: true }); })`. The directory is removed only in `afterAll(() => fs.rm(tmpBase, …))… | also `fs.rm(tmpBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })` in a `beforeAll`, as `tests/compile-runner-loops.test.ts:273` and `tests/api-server-loops-compile.test.ts:340`… |  | R03 |
| (Prettier) | written-file asserts depend on no Prettier config above the checkout | Flake (medium) | `formatCodeBehindSource` (src/codebehind/writer.ts:141-146) spreads `prettierResolveConfig(file)` over its defaults (`singleQuote: true, printWidth: 100, trailingComma: 'all'`). Prettier 3.9.6 searches for a config from the file's directory up to the filesyst… | write a `.prettierrc` (`{"singleQuote":true,"printWidth":100,"trailingComma":"all"}`) into each `tmpBase` in `beforeAll`, or commit a repo-root `.prettierrc` that pins the same three options so the s… |  | R03 |

### `tests/codebehind-compile.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 602 | compiles a test that loops — the refusal is gone (stories/codebehind-loops-and-conditions… | Low L3 | it builds a WHILE record/replay over `While the Next button is enabled, Click Next` and asserts `status 'green'`, `requests.map(r => r.purpose)` = `['record','replay']`, `generatedSteps = [1,2,3]`, and that the written file contains the While source and `'asy… | delete (keep `codebehind-compile-loops.test.ts:341`). | high | R03 |

### `tests/codebehind-condition-generation.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 42, :43, :56, :88 | duplicate rows of "conditionEntryComplaint accepts/refuses" | Low L3 | `:42` `return await page.getByLabel('Cash').isChecked();` ≡ `:465`. `:43` `return (await page.getByRole('button', { name: 'Load more' }).count()) === 0;` ≡ `:466`. `:56` `condition: async ({ page }) => (await page.locator('#x').count()) > 0` ≈ `:478` ('the ar… | delete the first-table copies (`:42`, `:43`, `:56`, `:88`) and keep the corpus at `:457`. | high | R03 |
| 51 | conditionEntryComplaint accepts an arrow-form condition | Defect | the row's body is `' return true;'`, wrapped by `entry()` at :34-35 as `async condition(${params}) {\n${body}\n }`. That's a method-form condition, not an arrow. The arrow/property form is actually tested at `:56` and `:478`. | rename it to 'a constant condition', or delete it (it adds little). | high | R03 |
| 348 | "says condition entries exist: keep them conditions, read-only, boolean — never a run, ne… | Low L4 | `expect(prompt).toContain('Never\n turn one into a \`run\` entry');` pins the hard line wrap and 3-space continuation indent of src/codebehind/review.ts:101-102 (`…before it asks. Never\n' + ' turn one into a \`run\` entry, …`). Re-flowing that paragraph brea… | rewrite this one assertion as `toMatch(/Never\s+turn one into a `run` entry/)`. | high | R03 |

### `tests/codebehind-conditions.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 322 | leaves a run entry on an ordinary step exactly as before | Low L3 | - The test is `runCodeBehindEntry({ … entry: { source: 'Open the statements page', run: () => {} } … })` followed by `expect(out.status).toBe('passed')`, the plain happy path of `runCodeBehindEntry`. | delete. Or rewrite through `executeStep` with a `forbiddenClient` and assert `fromCodeBehind === true` (the counterpart of :261). | high | R04 |

### `tests/codebehind-failure-outcomes.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 235 | throws a CodeBehindExpectationError, so every existing reading of one still holds | Low L3 | it asserts `new CodeBehindDeliberateFailure(...)` is an instance of `CodeBehindExpectationError` and of `Error`, that `.name` is `'CodeBehindDeliberateFailure'`, and that `isNonRetryable(err)` is false. Production has one reading of the subclass relation, `ex… | delete. | high | R03 |
| 1034 | the recording of a tolerated failure round-trips the flag and does not make the run faile… | Defect | each calls `writeRecording(md, { …, status: 'passed' \| 'failed' })` and asserts `recording!.manifest.status` equals that same value. writeRecording copies the input (src/codebehind/recording.ts:281 `status: input.status`; the source comment at :623-625 confi… | drop the status claim from the names and the `manifest.status` asserts, or move the status rule to where it's computed (the run loop, or `spliceRecording`; see below). | high | R03 |
| 1092 | "a spliced recording" it.each (3 rows) | Defect | the describe comment says "A splice recomputes the status from rows of mixed provenance". `spliceRecording` does that (recording.ts:631 `status: all.some((s) => s.status === 'failed' && s.tolerated !== true) ? 'failed' : 'passed'`). But every row passes a `sp… | give the tolerated row `spliceStatus: 'failed'` (still expect `'passed'`), and add a row where an existing failed step is replaced by a passing splice. | high | R03 |

### `tests/codebehind-flow-control.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 215 | exports the signal as a class, so a catch-all in author code can re-throw it | Low L5 | the test is `expect(new CodeBehindExitSignal()).toBeInstanceOf(Error); expect(new CodeBehindExitSignal().name).toBe('CodeBehindExitSignal');`, which checks a constructor and a constant. The claim in its name isn't tested and isn't true: author code imports fr… | delete, or (if author re-throw is meant to be supported) rewrite to run an entry that wraps `step.exit()` in `try { … } catch (e) { if (e.name === 'CodeBehindExitSignal') throw e; }` and assert `flow… | high | R03 |
| 1050 | refuses a skipped step with its own reason, not "did not pass" | Low L3 | `generationRefusal({ binding, text: 'Confirm the booking', status: 'skipped' })` → `SKIPPED_BY_RETURN_REFUSAL`. `tests/codebehind-live-compile.test.ts:1947` asserts the same call shape and result (`generationRefusal({ binding: b, text, status: 'skipped' })).t… | delete (keep `codebehind-live-compile.test.ts:1937`). | high | R03 |

### `tests/codebehind-generate.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 841 | returns the entry the model produced | Low L1 | the stub returns an entry containing `step.getVar('username')` and no `octocat` (:843-851). The test then asserts `expect(result.kind === 'entry' && result.code).toContain("step.getVar('username')")` and `.not.toContain('octocat')`, which reads the stub's own… | rewrite. Drop the two content echoes and keep it as a two-line smoke test, or delete it. | high | R03 |
| 1361 | is handed a marked snapshot by both compilers | Low L4 | `expect(boxed).toContain('parameterMap: passValues'); expect(boxed.match(/parameterMap: values/g)).toHaveLength(3);` pins local variable names and an exact count in src/codebehind/compile.ts (:850, :940, :2949, :3059). Renaming `values`, or adding a correct f… | delete the boxed half (behaviour tests cover it). For the live half, either count occurrences the way codebehind-live-compile.test.ts:1819 does for session-manager.ts, or add a LiveCompiler-level tes… | medium | R03 |

### `tests/codebehind-live-compile.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 369 | a link that throws does not poison the rest of the queue | Low L3 | the fake throws inside `aiClient.complete` (`if (/source:\s*"Add to cart"/.test(prompt)) throw new Error('boom')`). `askForEntry` catches that and returns `{ kind: 'error', message }` (src/codebehind/generate.ts:866-875: `try { const completion = await aiClie… | rewrite so that something outside `askForEntry` throws for step 2, for example an `emit` callback that throws on step 2's `generating…` frame, or a binding whose `file` makes `candidate.apply` throw.… | high | R03 |
| 578 | dispose abandons the queue without proposing anything | Defect | `expect(calls).toBeLessThan(3);`. `offer()` is synchronous (live-compile.ts:1026) and `dispose()` sets `disposed = true` before the first queued link runs (:875-877), so `calls` is always 0. The assert also passes at 1 or 2, meaning "dispose stopped only the… | `expect(calls).toBe(0)`. Separately, if the "in-flight call finishes" case matters, abort from inside the first `generate` the way `:447` does and assert `toBe(1)`. | high | R03 |
| 2086 | "generates nothing at offer time, then one condition from the first held and first not-he… | Defect | `await new Promise((r) => setTimeout(r, 0)); expect(prompts).toEqual([]);` (:2098). If a regression queued generation inside `offerGuard`, the queued link might still be awaiting async work (a sidecar read, Prettier) after a single macrotask, so the empty-pro… | assert on a synchronous signal instead, for example no `compile:progress` and no `compile:step` events before `runStepsEnded()`, then a run-end forecast with `total: 1`. | medium | R03 |

### `tests/codebehind-recorded-captures.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 42 | fixture `bindingFor` | Defect | `file: path.join('C:', 'nowhere', 'x.steps.ts'),`. CLAUDE.md says: "Never hard-code `C:\…` or `path.join('C:', …)`". The value is inert today (`generateStepEntry` reads only `binding.source`, generate.ts:339-470), so it does not fail on Linux or macOS. It is… | `path.resolve(path.sep, 'nowhere', 'x.steps.ts')`. | high | R04 |

### `tests/codebehind-recording.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 327, :492, :546 | overwrites the matched step, stamps it, and leaves the siblings alone" / "keeps the two o… | Flake (medium) | a wall-clock sleep makes two timestamps differ. | fake only `Date` (`vi.useFakeTimers({ toFake: ['Date'] })` with `vi.setSystemTime(t1)` before the write and `t2` before the splice), or let `spliceRecording`/`writeRecording` take an injectable `now`… |  | R04 |

### `tests/codebehind-skill-params.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 402 | generation sees the AUTHORED text and the username → Alice mapping | Defect | - The test asserts `expect(generation!).toContain('username');` and `expect(generation!).toContain('Alice');`. | assert the mapping line itself: `expect(generation!).toContain('- {{username}} resolved to "Alice" on this run')`. Do the same for :459 and :520. | high | R04 |

### `tests/codebehind-tabs.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 246, :267, :274, :289, :296 | the five "ctx.browsers" tests | Flake (medium) | every test launches 1–2 extra cold Chromium processes inside the test body. | build `session()` on the suite-wide `browser` with `browser.newContext()` for every test that does not exercise `browsers.close`. Keep a dedicated launch only for "closes a browser and drops it from… |  | R04 |

### `tests/codebehind-upload.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 38 | Temp-dir removal without retries — , `codebehind-section-rows.test.ts:43`, `codebehind-sk… | Flake (medium) | `fs.rm(dir, { recursive: true, force: true })` runs with no `maxRetries`. `force` does not ignore EBUSY or EPERM. Most of these dirs hold a freshly written `.steps.ts` plus the `.mjs` esbuild bundle that the loader just imported. This is exactly the file type… | pass `{ recursive: true, force: true, maxRetries: 10, retryDelay: 100 }` everywhere, which makes the batch consistent. |  | R04 |

### `tests/compile-runner-flow-control.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 342 | afterAll (both tests) and `tests/codebehind-condition-generation.test.ts:811` — `review()… | Flake (medium) | `await fs.rm(projectRoot, { recursive: true, force: true });` and `await fs.rm(dir, { recursive: true, force: true });` are recursive removes with no `maxRetries`, run over freshly written files. The compile route's Record writes a recording beside the test.… | add `maxRetries: 10, retryDelay: 100` to both removes, matching the other 28 suites. |  | R03 |

### `tests/computer-conditions.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 418 | a Stop during the 3 s wait after a `waiting` answer ends the judge promptly", "the page s… | Flake (medium) | `setTimeout(() => controller.abort(), 100); const started = Date.now(); … expect(Date.now() - started).toBeLessThan(1500);` — real timer against a wall-clock bound; the computer variant also includes a real `captureView` (jimp) in the measured span. | `vi.useFakeTimers({ toFake: ['setTimeout'] })`, `advanceTimersByTimeAsync(100)`, and assert the promise rejected before advancing the remaining 2.9 s of `CONDITION_JUDGE_POLL_MS`; or abort from insid… |  | R08 |

### `tests/computer-mode-session.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 1088 | with no testFilePath the server own answer still decides | Low L3 | `makeManager(configWith({ enabled: false }))`, `executeSteps(..., { steps: ['[use computer]'] })`, `expect(response.results[0]!.reasoning).toBe(COMPUTER_DISABLED_MESSAGE)` — identical setup and assertion to `tests/computer-mode-session.test.ts:363` ("desktop.… | delete (or rename `:363` to say it is also the no-testFilePath case). | high | R08 |

### `tests/computer-step.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 1086 | ends a wait_window promptly, without spinning on the window list | Flake (medium) | real abort timer + elapsed bound — `setTimeout(() => controller.abort(), 100); const started = Date.now(); … expect(Date.now() - started).toBeLessThan(900);`. The measured span includes a real jimp PNG encode of an 800×600 grab plus the abort timer's own late… | abort from inside the scripted model's response or the adapter's first `windows()` call (deterministic "Stop pressed during the wait"), and assert on `callsOf('windows').length` and the error only; t… |  | R08 |
| 1296 | , `:1385`, `:1413` (and, with more slack, `:1323`) — the D2 wait-budget block: "an endles… | Flake (medium) | the budget is charged in WALL-CLOCK time — `waits.spentMs += Date.now() - subStartTime;` (src/runner/computer-step.ts, after `executeComputerAction`) — and the loop's sleeps are real `setTimeout`s (no `sleep`/`now` seam on `ComputerStepOptions`). The assertio… | give `ComputerStepOptions.computer` the same injectable `sleep`/`now` that `executeComputerAction` already takes (desktop-executor.test.ts drives those with a virtual clock) and run this block on it.… |  | R08 |
| 1619 | the §5.6 condition judge fails the same way: the bridge's message, one call | Low L3 | Same call, same input class, same level as `tests/computer-conditions.test.ts:322` ("keeps the unretryable rethrow when the model rejects the image (§15.4)"): `evaluateConditions([...], <computer opts with FakeDesktopAdapter>)` with a client that throws the b… | merge — add the call count to `computer-conditions.test.ts:322` and delete this one (or the reverse). | high | R08 |
| 1681 | "names the missing toolsDir, and how to supply one" (and the same shape at `tests/compute… | Low L4 | `expect(undispatchedDirectiveError('[tool: open_calculator]', none)).toBe('[tool: open_calculator] was not run: this request carried no tools directory (toolsDir), so no tool is loaded — declare tests.toolsDir in the project\'s steptix.config.json so the clie… | rewrite to assert the fragments the test name promises: starts with `[tool: open_calculator] was not run`, contains `toolsDir` and `tests.toolsDir`, contains the "never handed to the model" sentence. | medium | R08 |

### `tests/config-loader.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 72-101 | the `INTERACTIVE_ON_FAILURE` describe | Defect | `loadConfig()` is called with no path, so it auto-discovers `<cwd>/steptix.config.json`, which is the repo's own tracked config (`resolveConfigPath`, `src/config/loader.ts:59-68`). The tests pass only because that file sets no `execution.interactiveOnFailure`… | pass `await writeConfig({})` from a tmp dir (or a `projectRoot` tmp dir) as the other describes do. | high | R12 |
| 83 | sets execution.interactiveOnFailure=false when INTERACTIVE_ON_FAILURE=false | Low L2 | the default is already `interactiveOnFailure: false` (`src/config/defaults.ts:68`), and the test asserts `expect(config.execution.interactiveOnFailure).toBe(false)`. If the loader ignored `INTERACTIVE_ON_FAILURE=false` entirely (the `parseBoolEnv` branch at `… | rewrite so the base is `true` (a config file with `execution: { interactiveOnFailure: true }`, then env `false` must win), or delete. | high | R12 |
| 89 | accepts 1/yes/on as truthy" and `:97` — "ignores garbage values and falls through to defa… | Low L3 | the truthy/garbage vocabulary belongs to `parseBoolEnv` and is already table-tested at `tests/env-loader.test.ts:71` (`it.each(['true','TRUE','1','yes','Yes','on','ON'])`) and `:79` (`parseBoolEnv('maybe')` → undefined). The loader's only logic is `if (intera… | delete both. Keep `:72` (default) and `:77` (seam). | high | R12 |
| 143 | deep-merges a single domNoiseReduction flag, keeping the other six | Low L3 | the same generic `deepMerge` recursion (`src/config/loader.ts:28`) and the same input class (a partial object one level below `browser`) as `:134` "deep-merges a partial nested object, keeping sibling defaults". Sibling preservation under `browser` is asserte… | delete, or fold the `dnr.collapseRepetitiveDom` assertion into `:134`. | medium | R12 |
| 381 | "no machine values leaves the built-in default model untouched" (also `:388`, `:415`, `:4… | Low L4 | `expect(config.ai.model).toBe('openai/gpt-5.6-luna')` and `toBe('https://llm.corp.example')` pin the current built-in defaults. `git log -- tests/config-loader.test.ts` shows `14944e2 Default model: openai/gpt-5.4-mini -> openai/gpt-5.6-luna` had to edit t… | rewrite to compare against `DEFAULT_CONFIG.ai.model` / `DEFAULT_CONFIG.ai.gatewayUrl` (exported, `src/config/defaults.ts:4`). Keep the tests. | high | R12 |

### `tests/control-flow-planner.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 311 | the count is known from the start, unlike a While`s | Low L3 | `expect(plan.pass?.count).toBe(1)` after entering with `items: ['a']`. The test at :275 already asserts `pass: { iteration: 1, count: 2, bindings: … }` on entry and `count: 2` on pass 2 (lines 285-299). The While tests at :160 pin `pass: { iteration: 1 }` wit… | delete. | high | R11 |
| 860 | at the top level the exit is still the next step | Low L3 | `planAfterGuard(CHAIN_NO_ELSE, 1, { kind: 'chain', selected: null }, createControlState())` → `toEqual({ skip: [[1, 6]], next: 7, selected: null })`. That is the identical call and identical expectation as `tests/control-flow-planner.test.ts:94` ("\"none\" wi… | delete. If the "control case" framing inside the exits block is wanted, leave a one-line comment pointing at :94. | high | R11 |

### `tests/control-line-parity.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 215 | on what claims, and on which form | Low L7 | the test compares `coreClaims`/`coreForm` (runner-core `isControlLineClaim`/`claimedControlForm`) with the CLI's. `grep -rln "isControlLineClaim\\|claimedControlForm"` over the repo (excluding node_modules/dist) returns only `runner-core/src/control-line.ts`,… | delete runner-core's `claimedControlForm`/`isControlLineClaim` (they are exported from index.ts but unused) together with the `core*` claim assertions, or keep them only if a consumer is planned. The… | high | R11 |

### `tests/credential-broker.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 813 | helper `calledTimes`, used by "25. two calls on a signed-out vault share ONE status check… | Flake (medium) | a fixed polling budget, `for (let i = 0; i < 500 && spy.mock.calls.length < n; i++) await new Promise((r) => setTimeout(r, 10)); expect(spy.mock.calls.length).toBeGreaterThanOrEqual(n);`. Between polls, attempt B must run a real `scanForLogin` against the sha… | make it event-driven. Wrap the spy so that its n-th call resolves a deferred, e.g. `vaultUnlocked = vi.fn(() => { if (++calls === 3) reachedGate3.resolve(); return open; })`, and `await reachedGate3.… |  | R09 |

### `tests/credential-bw-process.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 77 | answers \"not found\" for a PID that is not running | Defect | `findBwProcess(0)` and `findBwProcess(-5)` return at `if (!Number.isInteger(spawnedPid) \|\| spawnedPid <= 0) return Promise.resolve(null);` (src/credentials/bw-process.ts:138), before PowerShell is spawned. The gone-process branch the name describes is never… | move it out of the Windows block and rename it ("refuses a PID that cannot exist"). To cover the gone-process branch, add a Windows case using an already-exited child's PID. | high | R09 |
| 82 | finds the one real child of a process this test spawned itself | Flake (high) | a sleep stands in for "the child has started": `await new Promise((r) => setTimeout(r, 1500)); // let node start under it`, then `const pick = await findBwProcess(wrapper.pid!); expect(typeof pick).toBe('number');`. If node.exe has not appeared under cmd.exe… | make the waiter write a ready file (`fs.writeFileSync(ready, String(process.pid))`) and poll for it, then retry `findBwProcess` until it returns a number or a generous deadline passes. Better still,… |  | R09 |

### `tests/credential-real-processes.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 82 | "stops a bw that ignores stdin and outlives its wrapper — by its own PID" (test 41) | Flake (medium) | the gate `lookupWorks()` (:64) uses the same `setTimeout(r, 1500)` start wait. On a slow runner it returns false and `ctx.skip()` fires, so the flake shows up as a silent skip (coverage loss, not a red run). The real run then depends on three things finishing… | replace the sleep in `lookupWorks` with a ready-file handshake. Have the test log why it skipped. Raise the `until` budget, or poll on `process.kill(pid, 0)` up to the test timeout. Clean up `base` i… |  | R09 |
| 152 | 42. its prompts and echo are still what the driver reads" / "43. a canary master password… | Flake (medium) | these drive the user's installed `bw` (`describe.runIf(HAS_BW)`). The asserted event sequence `[{ answered: 'email' }, { answered: 'password' }, { stopped: 'failed' }]` depends on the installed bw version's prompt text, its "Master password is required." refu… | none needed in the code. Record the bw version the assertion was measured against in the failure message (`spawnSync(bw, ['--version'])`) so a red run names the cause. |  | R09 |

### `tests/data-sources-integration.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 140 | resolves a relative dataSources path against the test file directory, not cwd | Low L3 | `:101` already declares `local: ./overrides.json` and asserts `resolveStep(parsed, 3)` is `'Place order 50000 USD'`, which resolves through the same relative path. The comment's premise, "cwd is the project root (tmpRoot)", is false: nothing chdirs, so cwd is… | delete. `:101` already proves that relative paths resolve against the test file's directory. | medium | R12 |

### `tests/define-tool.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 5 | returns the same definition object passed in | Low L5 | `defineTool` is `validateDefinition(def); return def;` (src/tools/define-tool.ts). The test asserts `expect(def.name).toBe('noop')` and `expect(typeof def.run).toBe('function')` — both straight from the literal it passed in; it never checks identity, which is… | rewrite to `const input = {…}; expect(defineTool(input)).toBe(input);` or delete. | high | R13 |
| 16 | preserves parameter and output schema verbatim | Low L1 | since `defineTool` returns its argument unchanged, `expect(def.parameters).toEqual({ a: { type: 'number' }, b: { type: 'number' } })` compares the input with a copy of itself — no logic of the unit sits between setup and assertion. | delete (or merge into the identity check above). | high | R13 |

### `tests/desktop-action-parser.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 420 | , `:426`, `:434`, `:444` — envelope cases "strips a markdown code fence", "takes the FIRS… | Low L3 | `parseComputerActions` calls the page parser's `extractJson` (`src/desktop/action-parser.ts:26,557`), and those exact branches are already unit-tested at `tests/action-parser.test.ts:15` (fence), `:40` (first of two values), `:25` (surrounding prose), `:31` (… | keep one seam case (e.g. `:426`, which is the one that matters for a click) and delete the other three. | medium | R08 |

### `tests/desktop-adapter.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 203 | , `:222`, `:264` — FakeDesktopAdapter "records every call…", "grabs a buffer of exactly w… | Low L1 / L7 | `FakeDesktopAdapter` has no production caller (grep `FakeDesktopAdapter` in `src/` finds only comments in adapter.ts:8 and test-runner.ts:361). `:264` is pure L1 — `grabError: new Error('Failed to capture screen')` → `rejects.toThrow('Failed to capture screen… | delete the three; keep the rest of the fake's block. | medium | R08 |

### `tests/desktop-capture.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 161 | defaults the cap to 1600 (§5.10) | Low L5 | `expect(DEFAULT_MAX_IMAGE_WIDTH).toBe(1600);` — `src/desktop/capture.ts:29` is `export const DEFAULT_MAX_IMAGE_WIDTH = 1600;`. The same 1600 is pinned again for the config default at `tests/desktop-config.test.ts:47-52`. What could actually drift is the two s… | rewrite to `expect(DEFAULT_MAX_IMAGE_WIDTH).toBe(DEFAULT_CONFIG.desktop.maxImageWidth)` (parity), or delete. | high | R08 |
| 246 | viewSourceRect is the whole grab for a full view | Low L3 | `viewSourceRect` is `view.region ?? { x: 0, y: 0, width: view.grab.width, height: view.grab.height }` (capture.ts:61-63). Every full-view `mapToScreen` case (lines 59-115) goes through that default branch and would give wrong coordinates if it regressed; the… | delete. | medium | R08 |

### `tests/desktop-config.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 55 | is OFF by default — a shared project must opt in (§5.1 item 1) | Low L3 | `expect(DEFAULT_CONFIG.desktop.enabled).toBe(false);` is a strict subset of the test directly above (`tests/desktop-config.test.ts:46`, `toEqual({ enabled: false, ... })`), and the loader-level version is at `:65-69` and `:180`. | delete (or fold the "must opt in" rationale into the :46 test's comment). | high | R08 |
| 59 | ships no launchArgs — the launcher's own flags are the whole list | Low L3 | `expect(DEFAULT_CONFIG.browser.launchArgs).toBeUndefined();` — the same fact is asserted end-to-end through the real loader on a freshly `init`-ed project at `tests/desktop-config.test.ts:181` (`expect(config.browser.launchArgs).toBeUndefined()`), which would… | delete. | medium | R08 |

### `tests/desktop-executor.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 112 | halves the point again at density 2 | Low L3 | Same inputs and expected point as `tests/desktop-capture.test.ts:86` ("both together: downscale THEN density": 3440×1440 grab, scale 2, image 1600×670, point (800,335) → (860,360)). The executor's case 'click' only calls `mapToScreen` (executor.ts:103), and t… | delete. | medium | R08 |
| 452 | wait_window looks at most once per poll interval, even when a sleep returns early (A5) | Flake (medium) | real wall clock against a 100 ms deadline — `{ ...harness.context, now: Date.now, sleep: async () => {} }` with `timeoutMs: 100`, asserting `callsOf('windows')).toHaveLength(2)`. executor.ts:276 returns as soon as `now() >= deadline \|\| look >= maxLooks`; if… | keep the clock frozen (`now: () => 0`) — the point of the test is that the look COUNT bounds the loop when `sleep` returns early, which a frozen clock proves deterministically (it also isolates the c… |  | R08 |

### `tests/desktop-lock.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 71 | is idempotent for the same pid AND session, keeping the original `since` | Defect | `const first = acquireComputerLock(...); const again = acquireComputerLock(...); expect(again).toEqual(first);` — the two calls run in the same millisecond, so an implementation that rewrote the record with a fresh `new Date().toISOString()` (lock.ts:120) wou… | pre-write the lock file with an old `since` (e.g. `'2000-01-01T00:00:00.000Z'`) for pid 4242/sess-1, then acquire and assert `since` is unchanged both in the return value and in `readComputerLock`. | high | R08 |

### `tests/desktop-vision-route.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 280 | a timeout proceeds, and aborts the request | Flake (medium) | real 30 ms timer plus an elapsed-time assertion — `const started = Date.now(); … expect(Date.now() - started).toBeLessThan(2_000);` | use `vi.useFakeTimers()` + `advanceTimersByTimeAsync(30)` and assert the promise settled (as `:304` already does for the default), and drop the elapsed check. |  | R08 |

### `tests/dialog-guard.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 287 | survives a cross-origin iframe torn down while its own dialog is open | Flake (medium) | real Chromium + a timing race by design — `await waitUntil(() => dialogsHandled() > 0, 20_000);` then a fixed `await new Promise((r) => setTimeout(r, 3_000));`, then `expect(dialogsHandled()).toBeGreaterThan(0)`. On a loaded box the OOPIF may not raise a dial… | move `capture.stop()` and `context.close()` into `finally`; see also the defect entry — the race this exists for is hit only sometimes, so it is a probabilistic detector as well as a probabilistic fa… |  | R08 |
| 287 | survives a cross-origin iframe torn down while its own dialog is open | Defect | the regression only shows when Playwright's dismiss loses the race (comment at `:327`: "the failing handle is the rare outcome of the race"). The guard against a vacuous pass is `expect(dialogsHandled()).toBeGreaterThan(0)` — it proves a dialog was handled, n… | either assert the race was actually hit (`capture.lines.some(l => l.includes('already gone'))`) and accept it as a slow, opt-in reproduction, or drop it in favour of `:195` + the wiring tests. Costs… | medium | R08 |
| 360 | guards a CDP-attached context | Flake (medium) | port TOCTOU — `const port = await freePort();` (listen on 0, read, CLOSE) then `chromium.launch({ args: [\`--remote-debugging-port=${port}\`] })`. Between the close and Chromium binding, any other parallel worker (many root suites start servers/browsers) can… | launch with `--remote-debugging-port=0` and read the bound port back from `DevToolsActivePort` in the browser's user-data-dir (what the product's own CDP launcher does — see CLAUDE.md "CDP browsers")… |  | R08 |

### `tests/dom-cleaner.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 9-102 | describe "cleanHtmlString" (13 tests) | Low L7 | `src/browser/dom-cleaner.ts:1205-1213` — "Clean a raw HTML string into a simplified representation. Used in unit tests where a real browser is not available." It delegates to a private regex extractor (`extractInteractiveElements`, :1219) that shares no code… | delete the describe block and `cleanHtmlString`/`extractInteractiveElements` from src (if any behaviour is wanted, re-point it at `captureDomSnapshot` in the existing real-browser block — e.g. hidden… | high | R07 |
| 248 | "judges a placeholder by the PASSWORD rule only, on this copy too" (and `:166` "masks a s… | Low L3 | both tests exist to check "the OTHER copy of the rule" (comment at :167-169) / "on this copy too" (:248-250). That premise is gone: `isSecretField` now lives once in `src/browser/scripts/secret-field.js` and is spliced into capture-dom.js, the expand walk (do… | delete :248; delete :166 or fold `credential` into the CASES table in secret-field-parity.test.ts. Keep :287 (data-* sweep) and :353 (row attribute emitted once) — those are expand-walk–specific. | high fo… | R07 |

### `tests/drag-reload-actions.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 30 | are known action types, so the parser does not warn about them (with the control) | Low L3 | the claim is that `reload` and `drag` are in VALID_ACTION_TYPES. `tests/unknown-action-type.test.ts:727` asserts that `Object.keys(ROUTES).sort()` equals `[...VALID_ACTION_TYPES].sort()`, and ROUTES has `reload` and `drag` rows. `:329` asserts `isKnownActionT… | delete. | high | R10 |

### `tests/env-data-loader.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 40 | loads a nested JSON object" and `:130` — "returns the leaf type unchanged (boolean) | Low L3 | `:40` exercises the same parse-and-resolve path as `:54`, which also loads a nested object (`users.admin.password`) and reads a nested leaf. `:130` is the same `lookupDataPath` return path as `:126` (number). Neither reaches a new branch of `src/env/data-load… | delete `:40`; merge `:126`/`:130` into one `it.each`. | medium | R12 |

### `tests/env-loader.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 47 | parses multiple lines correctly | Low L3 | a blank line, `#` comments and plain `KEY=value` lines hit the same branches as `:5` (simple pairs), `:11` (blank lines) and `:16` (comments). No new branch of `parseEnvFile` is reached. | delete (or move its `toHaveLength(3)` into `:11`). | high | R12 |

### `tests/expander-control-flow.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 711 | an Otherwise with an ordinary step above it" / "an Otherwise under an `If … then return`"… | Low L3 | each re-runs the exact input of the "the parser`s wording, character for character" test in its own describe: | delete :711, :773 and :827. | high | R11 |

### `tests/extract-order-ids-integration.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 124 | honours the status filter — failed orders only | Low L7 | the tool only forwards `status` as a query parameter (`if (status) params.set('status', status)`, fixtures/tools/src/extract_order_ids.ts); the filtering is `fixtures/test-app/server.ts:1706-1715`. `expect(JSON.parse(params['order_ids']!)).toEqual(['O-1003',… | delete (or fold one `status` call into `:98` if the example's parameter must be shown working). | medium | R13 |
| 140 | output aliases route results into different variables (no overwrite)" and `:174` — "the e… | Low L3 | `:140` asserts aliased array/number outputs land under new names with the originals untouched — `tests/tool-array-params.test.ts:281` (array alias) and `tests/tool-executor.test.ts:116` (alias; original undefined). `:174` is the produce-array → consume-`strin… | delete both; keep `:98` as the single seam test of the handbook example (docs/test-writing-handbook.md:1857). | medium | R13 |

### `tests/failure-outcomes-runner.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 139 | whole file (`tmpBase = path.join(repoRoot, 'tests', '.tmp-failure-outcomes-runner')`) | Flake (medium) | a FIXED path inside the repo, shared by every run of this file from this checkout; `afterAll` does `fs.rm(tmpBase, { recursive: true, ... })` on the whole directory. Two `npm test` runs in one checkout at once (a watcher plus a CI-style run, or two agents in… | `fs.mkdtemp(path.join(os.tmpdir(), 'failure-outcomes-runner-'))`. The in-repo location exists for suites whose code-behind bundle must resolve the repo's packages (5e61f46's message); this file write… |  | R02 |
| 424 | shows a Tolerated stat on the report and no red banner | Low L3 | `expect(html).toMatch(/badge badge-pass">✓ PASSED</); expect(html).toMatch(/stat-tolerated">1</);` on `renderReport(await runLoop(TOLERATED_DOC, { tolerate: 2 }))`. The loop half (`report.status === 'passed'`, `toleratedSteps === 1`) is asserted by the same f… | delete (or keep as the single loop→render smoke and drop nothing else — it is cheap; low priority). | medium | R02 |

### `tests/flow-control-grouper.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 109 | runs all three steps as themselves | Low L3 | the body is `const ran = ranAs(steps); for (...) expect(ran.get(i), …).toBe(steps[i]);` over `['If prompted for MFA, enter the code', 'If the title is Dashboard then return', 'Wait for the dashboard']` (:96-100). The first entry of the table at :120 is the sa… | delete :109, or drop the first row of the :118 table. | high | R11 |

### `tests/flow-control-parse.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 292 | "reads a LONG tail with no head as unconditional too" (and `:336` "marks the unconditiona… | Low L3 | every line in `LONG_UNCONDITIONAL` (:177-182: `Return here`, `Stop running the steps`, `Stop running the remaining steps`, `Return running the following steps`) is already an ACCEPT row (:35, :38, :42, :45) asserting `toEqual({ verb: … })`. That `toEqual` fai… | delete :292 and :336, and keep :283 as the single documented statement of the "absent, not empty" rule (or move LONG_UNCONDITIONAL's comment onto the ACCEPT block). | high | R11 |

### `tests/flow-control-runner.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 138 | whole file (every `runTest` case writes here) | Flake (medium) | a fixed temp base inside the repository, `const tmpBase = path.join(repoRoot, 'tests', '.tmp-flow-control-runner');`, with per-test subdirectories named by a counter that restarts on every run (`dir = path.join(tmpBase, \`t${counter++}\`)`, :222). Each run th… | `dir = await fs.mkdtemp(path.join(tmpBase, 'run-'))` in `beforeEach`. That keeps the in-repo location the other `.tmp-*` suites need, though this file compiles no code-behind and so could use `fs.mkd… |  | R11 |

### `tests/guard-condition-codebehind.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 430 | settles the page once, right before the first entry runs | Low L3 | - The setup is identical to :302 "stops at the first member that holds; later members are not run": `a = scripted(false)`, `b = scripted(true)`, `c = scripted(true)` on CHAIN members 0, 2 and 4. | delete. Or, if the ordering matters, rewrite to record call order (push `'settle'` from the settle mock and `'a'` from `a.condition`, then assert `['settle', 'a', 'b']`). | high | R04 |
| 573 | does not mark a step.expect failure deliberate | Low L3 | it is the same binding and the same visit as :541 "fails the guard on step.expect, never healed" (`step.expect(false, 'the list never loaded'); return true;`), and it adds a single `expect(ev.deliberate).toBeUndefined();`. | merge that one line into `guard-condition-codebehind.test.ts:541`. | high | R04 |

### `tests/idle-monitor.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 69 | idleFor() is unaffected by the configured window | Low L5/L7 | `new IdleMonitor(null, clock.now); clock.advance(5_000); expect(monitor.idleFor()).toBe(5_000)`. `idleFor()` has no production caller outside `isExpired()` (grep `idleFor` in src/: only src/server/idle-monitor.ts:41 and :52), and `isExpired()` returns before… | delete. | high | R06 |
| 145 | fires on the next tick once the run ends inside the window | Low L3 | `advance(30 * 60_000)` busy, then `state.busy = false; advance(61 * 60_000); expect(state.expired).toBe(1)`. The `advance` helper sets `now += ms` BEFORE `vi.advanceTimersByTime(ms)` (lines 100-103), so every tick of the second advance already sees +61 min. P… | delete, or rename it to "a run shorter than the window also restarts it" and add the `advance(59 min) → 0` check, which makes it a distinct short-run case. | high | R06 |

### `tests/iframe.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 1-6 | file header | Defect | header lists "DOM cleaner iframe rendering in cleanHtmlString (regex path)" as a tested area; the file has no `cleanHtmlString` call and no DOM-cleaner test. | drop that bullet (and see the cleanHtmlString L7 finding). | high | R07 |
| 50 | parses frame alongside other action fields | Low L3 | the parser's whole `frame` logic is one line, `if (typeof obj['frame'] === 'string') action.frame = obj['frame'];` (src/ai/action-parser.ts:926). This test hits the same true branch as `tests/iframe.test.ts:16` ("parses frame selector from action"); the extra… | merge into `tests/iframe.test.ts:16` (or delete). | high | R07 |
| 168 | routes click to page when no frame is set | Defect | `expect(frameLocator.locator).not.toHaveBeenCalled()` — that mock is reachable only via `page.frameLocator('#my-frame')`, and `resolveLocatorRoot` (actions.ts:30-31) returns `page` at once when `frameSelector` is falsy, so nothing could call it. The real asse… |  | high | R07 |

### `tests/interactive-repl.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 120 | /exit works in planned-entry mode too", `:142` — "/continue returns continue decision (fa… | Low L3 | in `runInteractiveRepl` (src/runner/interactive-repl.ts:160-262) `entryReason` only chooses the banner text and the list `marker`; command dispatch (`if (head === '/continue') return { kind: 'continue' }`, `if (head === '/exit' \|\| head === '/quit')`) and `p… | delete `:120`, `:142`, `:165`, `:411`, or table-drive one test over the three entry reasons if the "same in every mode" contract is wanted explicitly. | medium… | R13 |

### `tests/interpolate-env-data.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 108 | mixes env + data refs in one step" and `:202` — "still resolves env/data when extras are… | Low L3 | `:167` "resolves multiple distinct namespaces in one step" already resolves `${env.BASE_URL} \| ${data.users.admin.email} \| ${vip…} \| ${local…}` in one string with extras registered. That covers both an env+data mix and env/data resolution alongside extras. | delete both. | high | R12 |
| 119 | , `:139`, `:144` — the `interpolateEnvDataDeep` describe (3 tests) | Low L7 | `grep -rn "interpolateEnvDataDeep" --include=*.ts --include=*.js .` (excluding node_modules/dist) finds only its definition and its two recursive self-calls (`src/parser/interpolate-env-data.ts:260,265,270`), this test file, and a regex name list in `tests/su… | delete the tests together with the export, or keep them only if a caller is planned. | high | R12 |

### `tests/invocation-array-literals.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 58 | still rejects unquoted scalar values | Low L3 | `parseToolCall('[tool: x bar=baz]')` → `toThrow(/expected '"', '\[', a number, or true\/false after '=' for argument 'bar'/)` is character-for-character `tests/tool-call-parser.test.ts:154` (`'[tool: foo bar=baz]'`, same regex), and `tests/invocation-bare-lit… | delete. | high | R13 |

### `tests/invocation-bare-literals.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 153 | a bare value adjacent to `]` (no whitespace) closes the invocation cleanly | Low L3 | `parseToolCall('[tool: x count=5]')` → `'5'`. Every case in the "bare numeric literals" block already ends with the value against `]` — e.g. `:51` `parseToolCall('[tool: x count=30]')` → `'30'`. | delete. | high | R13 |
| 174 | bare integer → tool receives a real number when type: number is declared" and `:199` — "b… | Low L3 | both hand `executeToolStep` a pre-parsed `args: { count: '30' }` / `{ enabled: 'true' }` — by the time the executor sees them a bare literal is indistinguishable from a quoted one, so this is the string→number/boolean coercion `tests/tool-executor.test.ts:85`… | delete `:174` and `:199`; keep `:223` (negative float) and `:247`. | high | R13 |

### `tests/keyless-replay.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 297 | keeps the machine-has-no-AI copy when no reason is given | Low L3 | it runs `{ keyless: true }` with no `keylessReason` and asserts `results[1]!.error` is `KEYLESS_HEAL_SKIPPED_ERROR`. `tests/keyless-replay.test.ts:216` runs the identical fixture and options and asserts `failed!.error).toBe(KEYLESS_COPY)` and `KEYLESS_HEAL_SK… | delete. | high | R09 |

### `tests/lm-bridge-real-sdk.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 141 | carries an effort profile through without the bridge having to know it | Low L5 | the only assertion is `expect(seen[before]!.body['reasoning_effort']).toBe('medium')`, i.e. what `@pkent/aigateway`/OpenAI SDK put on the wire. No repo code is in the request path; the server is test code. The bridge never reads the field: `steptix-vscode/src… | rewrite to feed the captured body through `translateRequest` and assert it is accepted (that actually tests "drop silently"), or delete. | medium | R09 |

### `tests/mcp-api-client.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 313 | rethrows on our own cancellation rather than calling it a dropped stream | Flake (medium) | `setTimeout(() => controller.abort(), 30);` with `.rejects.toThrow()`, which accepts any error. If the response headers have not arrived within 30 ms, `fetch` itself rejects, and the `if (signal?.aborted) throw err` branch in `consumeRunStream` (src/mcp/api-c… | abort from the `onEvent` callback (the 4th `streamSteps` argument) after the first `step:start`. Also assert the rejection is an AbortError and that no `StreamResult` with `streamDropped: true` was r… |  | R05 |
| 374 | returns last-run info as given | Low L1 | the server handler does `res.end(JSON.stringify({ finalized: false }))`, and the test asserts `await expect(client.getLastRun('s1')).resolves.toEqual({ finalized: false })`. `getLastRun` (src/mcp/api-client.ts:425-432) is `assertOk(res); return (await res.jso… | rewrite to assert the request path (encoded id) and the `x-api-key` header, or delete. | high | R05 |

### `tests/mcp-assemble.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| — | (whole file), `tests/mcp-errands-real-app.test.ts`, `tests/mcp-peek-real-app.test.ts`, `t… | Flake (medium) | these call the real `resolveProject` without redirecting the user root. `withServerDiscovery` always evaluates `readMachineKey()` (src/mcp/project.ts:447-451), and `allowedRoots()` canonicalises the real `%LOCALAPPDATA%\steptix` (project.ts:141-148). The deve… | redirect `LOCALAPPDATA` and `XDG_CONFIG_HOME` into a tmp dir in `beforeEach`/`beforeAll`, exactly as `tests/mcp-project.test.ts:121-132` and `tests/mcp-server-start.test.ts:166-180` already do. |  | R05 |
| 255 | sends a tool `viewport` for a file that declares none | Low L3 | `assemble('simple.md', { config: { viewport: 'tablet' } })` followed by `toEqual({ viewport: 'tablet' })`. This is the same input shape and code path as :290 (`assemble('simple.md', { config: { viewport: '390' } })` followed by `toEqual({ viewport: '390' })`)… | delete. :290 keeps the "server owns validation" claim and the same coverage. | high | R05 |
| 273 | lets a tool `tableStructure` override the file per key" and `:281` — "sends a tool `table… | Low L7 | both pass `assemble(..., { config: { tableStructure: … } })`. Production reaches `assembleTestFile`/`assembleSteps` only from src/mcp/tools.ts:2085 and :2140, with `config: args.config`, and `args.config` is parsed by zod `toolConfig` (src/mcp/schemas.ts:173-… | delete both. Keep :265 (the file-declared whitelist line is real). If a tool-level override is wanted, add it to `toolConfig` first and then test through `run_steps`. | high | R05 |

### `tests/mcp-cdp-seam.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 875 | "maps every output field through as structured content" (close_cdp_tab) | Low L1 | the fake's default `closeCdpTab` returns `title: 'OpenRouter — Docs'`, `remainingTabs: 7`, `browserExited: false`, and so on (lines 136-148). The handler builds `const result = { ...closed, owned: …, scope: …, warnings: … }` (src/mcp/tools.ts:3107-3115). The… | rewrite to assert the derived `owned: true` and `scope: 'project'` backfill, the way the focus twin at :1197 does with `toEqual`, or delete. | high | R05 |

### `tests/mcp-entry-graph.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 76 | writes nothing to stdout that is not protocol | Low L3 / L8 | `const result = await runWithProbe(['mcp']);` is the identical child process :69 already spawns ("loads no browser stack, and exits when stdin closes"). Each spawn is a real `node --import probe dist/index.js` start with a 60 s budget, and :76 only adds `expe… | merge by adding `expect(result.stdout).toBe('')` to :69 and delete :76. That saves one real process start per run with no loss. | high | R05 |

### `tests/mcp-errands-real-app.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 636 | refuses session_id before it touches anything (item 6)"; `:656` — "refuses a name matchin… | Low L3 | - **:636.** The session_id refusal fires in the tool handler before `withProject`, so no HTTP request is made and the real server cannot affect the outcome. `tests/mcp-errands-seam.test.ts:236` already asserts the refusal, `listCalls` empty and `errands` empt… | delete all three. The file's distinct value is the allow-list, the receipt and the lock routing. | medium | R05 |
| 994 | never blocks a run_steps batch on a tab an errand is driving (item 3) | Low L3 | the claim sits entirely on the server side, since sessions take no lock. `tests/api-server-errands.test.ts:2723` makes the same claim with the same park-then-run shape against the route: `parkSteps('errand')`, then `cdpSession('wheel-parallel')` expecting sta… | delete. :911 likewise overlaps api-server-errands:2693 but adds the tool-level `list_sessions` check, so it can stay. | medium | R05 |

### `tests/mcp-no-browser-yet.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 49 | is a different answer from the session-gone one | Low L3 | `expect(err.message).not.toBe(pageContentSessionGone('s-1').content[0]!.text)`. Two different builders produce different strings unless someone aliases one to the other. The test at :38 already pins the specific hazard (`not.toMatch(/no session named/i)`, `no… | delete. The real gap is that no test drives `get_page_content` with a 409 carrying `NO_BROWSER_LAUNCHED_WIRE_MESSAGE` to prove `isNoBrowserYet` (src/mcp/tools.ts:639) routes it. That test would be wo… | medium | R05 |

### `tests/mcp-peek-real-app.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 620/667/737 | , `tests/mcp-errands-real-app.test.ts:575/687/994`, `tests/mcp-peek-real-app.test.ts:1028… | Flake (medium) | - **Report mock.** `expect(generateReportMock).not.toHaveBeenCalled()` runs on a module-level `vi.fn` that is never cleared, while later tests (peek 932/960/990, errands 911/948/994) drive `run_steps` sessions. Those sessions call `generateReport` (src/server… | `vi.mocked(generateReportMock).mockClear()` at the start of each test that asserts it un-called. Close sessions in `finally` or `afterEach`. Restore `TABS` in `finally`. |  | R05 |
| 840 | refuses a name matching nothing…"; `:849` — "refuses a name matching two…"; `:883` — "ref… | Low L3 | the peek counterparts of the finding above. `tests/mcp-peek-seam.test.ts:359` and `:372` compare the same refusals against the same builders (`peekTabNotFound`, `peekTabAmbiguous`). `:223` covers the session_id wrong door, which fires before `withProject` (sr… | delete. | medium | R05 |
| 865 | never makes an iframe, a browser_ui target or a dialog a candidate | Low L3 | the two files use the same mocked `knownProfilesAcross`, which calls `discovery.probePort(CDP_PORT, 1_000, devToolsFetch)` over the same raw target list. The filter they exercise is therefore cdp-discovery's `toPageTabs` via `probePort`, reached through the t… | keep one of the two (errands :799, which also checks the executor saw only the control step) and delete the other. | medium | R05 |

### `tests/mcp-peek-seam.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 324, :330, :336, :342, :423 | matches a bare string against the title", "…against the url as well as the title", "match… | Low L3 | line for line the same cases, over the same `TABS` fixture, as `tests/mcp-errands-seam.test.ts:380, :386, :394, :400` (e.g. `peek(h, { tab: 'activity \|' })` followed by `T-ACT`, against `errand(h, { tab: 'activity \|' })` followed by `T-ACT`). Both tools cal… | replace both sets with one pure table test of `matchTabsByName`; no direct unit test exists today. Keep one wiring test per tool: peek-seam:311 and errands-seam:368 assert the port came from profile… | high | R05 |

### `tests/mcp-project.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 207, :598, :812 | symlink tests ("refuses a symlink inside the root that points outside it", "refuses a .en… | Defect | `if (!trySymlink(…)) return;`, where `trySymlink` swallows every error (lines 110-117). Directory links use a junction on win32, so :207 always runs. :598 and :812 create FILE symlinks (`'file'`), which on Windows need admin rights or Developer Mode. On a mac… | use `ctx.skip()` (or `it.skipIf` computed from a probe at load time) so an unprivileged run reports "skipped" rather than "passed". | medium… | R05 |
| 796 | a project skillsDir/toolsDir pointing into the user root is dropped, not loaded | Low L3 | - The config is `{ tests: { skillsDir: '../../steptix-evil-skills' } }` relative to `parent/proj`, which resolves to `<tmpdir>/steptix-evil-skills`. That is not the user root. | rewrite so the config targets `testUserRoot()` (as :787 does for `tests.dir`) and assert the actual outcome, or delete as a duplicate of :396. | high | R05 |

### `tests/mcp-real-app-seam.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 272-275 | harness comment for `assertServerRecognized` | Defect | the comment says "a bare `createApiServer`, which serves no /health route through this harness — so the identity probe would refuse a server we know is ours". The same file's :385 asserts `server_status` reports `running: true` against that server, and `tests… | correct the comment (the stub exists because nothing calls it, not because `/health` is missing). | medium | R05 |

### `tests/mcp-seam.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 104-115 | fake `streamSteps` with `holdMs` | Defect | `const timer = setTimeout(resolve, script.holdMs); signal?.addEventListener('abort', …)` never checks `signal.aborted`. The real client checks it, and the fake's `abort` event never fires for a signal that is already aborted. See the :1808 flakiness entry. | `if (signal?.aborted) { reject(signal.reason); return; }` before arming the timer. | high | R05 |
| 405 | counts the steps a return skipped, instead of reporting them as a shortfall | Low L3 | the fake-client version of :438, which sends the same four-step return shape over the real `createApiClient` and real SSE, and whose last assertion is the identical `toContain('PASSED — 2 passed, 2 skipped (a step returned early) of 4')`. :438 covers everythi… | delete :405 and keep :438. | medium | R05 |
| 913 | puts the page in the content blocks, not only in structuredContent | Low L3 | `tests/mcp-content-blocks.test.ts:320` (it.each, `get_page_content` row) already asserts that the content blocks contain `JSON.stringify(result.structuredContent)` and that `texts[0]` is a non-JSON summary. `:347` also asserts the page appears exactly once, i… | delete; the content-blocks suite owns this contract for every tool. | medium | R05 |
| 989 | tells the agent a truncated result was truncated | Low L3 | same behaviour and input class as :935, "carries a truncation warning in the content blocks too". Both set `truncated: true` with `returnedChars`/`availableChars` and assert the counts plus "selector" in the content text (:947-948 `toContain('900')`, `toConta… | merge into :935 and delete :989. | high | R05 |
| 1101 | warns that the page may be moving during a run | Low L1 | the only assertion is `expect(res.structuredContent).toMatchObject({ status: 'executing' })`, and `'executing'` comes from the fake (`connect({ pageContent: { status: 'executing' } })`). The handler copies it through: `status: page.status ?? 'active'` (src/mc… | delete. If a warning is intended, implement it and assert on it in the content text. | high | R05 |
| 1808 | aborts the run and leaves the session open | Flake (medium) | `setTimeout(() => controller.abort(), 40);` races the server handler reaching `streamSteps`. The fake attaches its listener only once called (lines 107-114: `signal?.addEventListener('abort', …)`) and never checks `signal.aborted`. If the abort lands first, t… | in the fake, `if (signal?.aborted) return reject(signal.reason)` before waiting. Drive the abort from a `started` deferred the fake resolves, instead of a 40 ms timer. |  | R05 |

### `tests/mcp-server-start.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 604 | reports an abort during the poll as a cancellation, not an auto-start failure | Flake (medium) | the shared single-flight start outlives its cancelled caller and is left to settle by a wall-clock sleep: `async function drain() { await new Promise((resolve) => setTimeout(resolve, 25)); }` (line 159-161), called at line 620 after `h.up = true`. If that sta… | join the shared promise instead of sleeping. After `h.up = true`, run `await ensureServerReadyWith(makeProject(), undefined, h.deps)`; with no signal, that joins the same single-flight promise. Alter… |  | R05 |

### `tests/mcp-url.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 71 | returns a stable key for an unparseable URL instead of throwing | Defect | `expect(canonicalServerKey('not a url')).toBe(canonicalServerKey('not a url'))`. "Stable" is trivially true for any deterministic function, so the only real check is the implicit not-throwing. | `expect(() => canonicalServerKey('not a url')).not.toThrow()`, and assert it differs from a real URL's key so it cannot collide with `127.0.0.1:3100`. | high | R05 |

### `tests/multi-env-integration.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 181 | frontmatter env: pins a test to a specific env when no CLI flag | Defect | the pin decision is coded in the test itself: `// Simulate CLI behaviour: parse first to read frontmatter, then re-parse with that env's bundle`, followed by `resolveEnvBundle({ envName: initial.frontmatter.env!, … })`. The production rule `if (!cliEnvName &&… | rename to "frontmatter `env:` is parsed and a re-parse with that env resolves", or drive the real run.ts selection. | high | R12 |

### `tests/multi-turn.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 283-332 | describe "turn badge tagging semantics" (4 tests) and `:336-377` — describe "cycle detect… | Low L1 + L7 | both blocks define the function under test inside the test file — `/** Mirrors the tagAiResponses helper in step-executor.ts */ function tagAiResponses(...)` and `/** Mirrors the cycle detection condition in step-executor.ts */ function wouldDetectCycle(urlHi… | delete both describe blocks (10 tests). Also drop the stale "Use distinct URLs to avoid cycle detection" comments/URL factories at `:611-614`, `:655-658`, `:693-700`. | high | R13 |
| 584 | single-turn step: no turnNumber on AI responses | Defect | the name promises no `turnNumber`; the assertions are `expect(result.turns.length).toBe(1); expect(result.turns[0]!.turnNumber).toBe(1);` — a turnNumber IS asserted, and `aiInteractions[*].turnNumber` (what "AI responses" refers to) is never checked. The name… | rename to "single-turn step produces exactly one turn"; likewise `:610` "interactions tagged with turn numbers" checks `turns[i].turnNumber` and only `aiInteractions.length >= 1`. | high | R13 |

### `tests/open-page.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 113-129 | CONFIRMED (observed in the coordinator's loaded run 1 of 5): and `tests/upload-action.tes… | Flake (high) | each file copies the same three helpers. (1) `getFreePort()` (open-page :84, upload-action :34) listens on 0, reads the port and CLOSES it (`srv.close(() => resolve(p))`) before the child binds it, which is a TOCTOU race against every other worker. (2) It spa… | one shared helper in `tests/` used by all six files. Spawn the server with `PORT=0`, have `fixtures/test-app/server.ts` print the bound port (`server.address().port`) on stdout, and resolve on that l… |  | R10 |
| 140-146 | describe "openPage execution path — real browser" and its first test's comment | Defect | the describe and its first test say they test "the openPage execution path" and "Mirror exactly what step-executor's openPage handler does", but no test calls the handler; the four steps are re-implemented in the test body (:147-150). See the L8 finding above. | rename to what it tests (PageTracker over real pages) when moving it, or drive the real handler. | high | R10 |
| 140-340 | describe "openPage execution path — real browser" (11 tests) | Low L8 | the block's own comment says it will "Mirror exactly what step-executor's openPage handler does: 1. context.newPage() 2. goto(url) 3. tracker.addPage 4. switchToAsync", and it then performs those four steps INLINE in the test. The handler itself (src/runner/s… | move the five `relabelPage` rule tests and the label-switch cases into popup.test.ts's mock-page `PageTracker` suite, and delete the switch/close duplicates and the server spawn. If a real-browser op… | high | R10 |

### `tests/page-content-capture.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 688 | recognises a failure raised inside the browser script | Flake (medium) | poisons the shared page's global — `await page.evaluate(\`window.getComputedStyle = function () { throw new Error('boom'); }\`)` — and never restores it. `page.setContent` (document.open/write) does not replace the Window object in current Chromium, so every… | run it on its own page (`const p = await browser.newPage(); …; await p.close()`), or save and restore `getComputedStyle` in a `finally`. |  | R07 |
| 900 | keeps a url it salvaged rather than answering with nothing | Low L3 | identical setup to :888 (`flakyPage({ failures: 99 })`, same single default URL) and asserts only `expect(identity.url).not.toBe('')`, while :896 already asserts `expect(identity.url).toBe('https://shop.example/cart')`. The name claims the salvage branch — `u… | delete, or rewrite to exercise the salvage: a page whose `url()` throws on the second attempt only, asserting the first attempt's URL is returned with `stale: true`. | high | R07 |

### `tests/parameters.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 34 | substitutes only word-character keys | Defect | the only assertion is the positive `interpolate('{{foo_bar}} value', { foo_bar: '42' })` → `'42 value'`; nothing checks that a non-word key is NOT substituted — and since the dotted grammar (`PLACEHOLDER_SOURCE` accepts `order.id`), "only word-character keys"… | rename to "substitutes a key containing underscores", or add the negative (`{{order-id}}` stays literal). | high | R13 |

### `tests/parser-control-flow.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 541 | "the control-flow examples in docs/ parse" (all three tests, :556, :564, :575) | Flake (medium) | `await fs.readFile(path.join(process.cwd(), rel), 'utf8')` resolves `docs/…` against the process working directory rather than the test file. Run from anywhere but the repo root (an IDE runner rooted at a parent folder, `vitest --root`, or a sibling test that… | `path.join(path.dirname(fileURLToPath(import.meta.url)), '..', rel)`, the same way flow-control-runner.test.ts:137 and ui-runner-adapter-control-flow.test.ts:1016 locate repo files. |  | R11 |

### `tests/parser-inert-headings.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 110 | leaves a depth-≥4 heading with no items beneath it exactly as it was | Defect | there is an item after the heading (`'2. Check the header'`), and the assertion `toEqual(['Open the dashboard'])` shows it is dropped. The comment says "the item after it is inert too", so the behaviour changed and the name did not. | rename to "a #### heading followed by prose still makes later items inert". | high | R12 |

### `tests/parser-sections.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 69 | a #### heading with text opens an ignored region inside a body | Low L3 | the input `['# T','','## Steps','1. One','','### S','1. A','','#### Note','','2. B']` is byte-for-byte `tests/parser-section-linespans.test.ts:92` apart from `One`/`Call`. Both assert `sections['s'].steps` equals `['A']`, and linespans also checks the raw sca… | delete (keep parser-section-linespans:91 and parser-inert-headings:54/62). | high | R12 |
| 154 | refuses every hashes-only depth in the shared fixture | Low L3 | `classification-hashes.md` has `###` (line 10), `####` (14) and `#######` (18). `parseTestContent` throws on the first, so only `###` is ever checked, and that is already `:145`'s `it.each([['###',3],['####',4],['#######',7]])`. The fixture refusal is also as… | delete, or rename to "refuses the shared hashes-only fixture". | high | R12 |

### `tests/parser.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 93 | , `:100`, `:107`, `:423`, `:431` — `## Config` cdp / cdpTab / viewport / unmask (present… | Low L3 | Config parsing is fully generic. `parseKeyValueList` (`src/parser/markdown.ts:1488-1501`) splits on the first `:` and stores every key, with no key-specific handling, as the comment at `:108` concedes ("The Config scan is generic"). `:86` "parses ## Config se… | replace with one `it.each` over the keys, or delete and keep `:86` + `:192` (colon in value). | high | R12 |

### `tests/placeholder-dotted.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 75 | pins the source string the Steptix copies have to mirror | Low L4 | `expect(PLACEHOLDER_SOURCE).toBe('\\{\\{(\\w+(?:\\.[A-Za-z_][A-Za-z0-9_]*)?)\\}\\}')` (and the two siblings) pins regex source text. The cross-package parity it cites is done elsewhere and does not use this golden: `steptix-vscode/tests/placeholder-grammar-pa… | delete, or keep knowingly as the documented "target that does not move between phases" — but then it is a deliberate change-detector, not a guard. | medium… | R13 |

### `tests/popup.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 59 | parses page field alongside other fields | Low L3 | same true branch of the `page` field copy as `tests/popup.test.ts:42` ("parses switchPage action with page field"); the only extra assertion is `description`, a generic parser field. Same pattern as iframe.test.ts:50. | delete (or merge into :42). | high | R07 |
| 117-147 | "normalises "<alias>" to "closePage"/"switchPage"" (10 generated tests) | Low L3 | the parser looks aliases up FOLDED — `foldActionName = name.trim().toLowerCase().replace(/[_\-\s]/g, '')` (src/ai/action-parser.ts:114) applied to every key of `ACTION_TYPE_ALIASES` (:230-235). So `switchTab`/`switch_tab`, `switchWindow`/`switch_window`, `clo… | shrink each loop to the distinct folded keys (`switchTab`, `switchWindow`, `closeTab`, `closeWindow`) or fold them into the table at unknown-action-type.test.ts:275. | high | R07 |

### `tests/prompt-values-block.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 104 | renders NO block for a step that references nothing, and the prompt is byte-identical to… | Low L4 | `const BEFORE = ['## Test Information', '- Test: Login flow', … 'Scroll position: 0–800 of 1600px (at top)', … '```'].join('\n'); expect(noValues).toBe(BEFORE);` — a whole-prompt snapshot of `buildStepMessage`. The contract it was written for (adding `## Valu… | rewrite to `expect(emptyValues).toBe(noValues); expect(noValues).not.toContain('## Values');` — keeps "empty values = no values" without pinning unrelated sections. | medium | R13 |

### `tests/prompts-read-table.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 118-121, :124-129, :162-168 | three "lives in the cacheable rules block" checks | Low L3 | each does `blocks.find(b => b.text.includes(<needle>))` then `expect(rules.cache).toBe(true)`. Every rule (ROW IDS, SPLIT GRIDS, 13d) is in the one template literal passed to `textBlock(..., true)` at `src/ai/prompts.ts:184`; the only uncached block is API re… | delete :124-129 and the cache lines in :118-121; keep :162 for its ordering checks. | high | R07 |

### `tests/read-multiple.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 173 | caps capture at READ_MULTIPLE_MAX (500) when the selector matches more | Flake (medium) | order dependence on a shared page. The five tests at :92-169 read the DOM set once in `beforeAll` (`await page.setContent(html)`, :85); this test replaces it (`await page.setContent(...#bulk...)`, :175). The file's own comment admits it: "Page-content-replaci… | give the cap test its own page (`const p = await browser.newPage(); … await p.close()`), or move the fixture `setContent` into `beforeEach`. |  | R07 |

### `tests/read-table-structure.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 64-75 | helper `mappingRefusal` | Defect | `try { const result = await mapped(...); throw new Error(\`expected a refusal, got …\`); } catch (err) { return (err as Error).message; }` — the helper's own "expected a refusal" error is caught by its own `catch` and returned as if it were the refusal text.… | use the pattern the same file uses at :479 — `.then(() => { throw new Error('expected a refusal'); }, (e) => e.message)` — so the sentinel escapes. | high | R07 |

### `tests/read-table.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 145 | never includes the checkbox, Total or Actions columns nobody asked for | Low L3 | same fixture and columns as `tests/read-table.test.ts:129`, which already asserts `toEqual([{ _row: '1', id: 'ORD-1001', customer: 'Alice Smith', status: 'Completed' }, …])` and the exact key list `['_row', 'id', 'customer', 'status']`. An exact `toEqual` can… | delete. | high | R07 |
| 456 | reads a "Loading…" row as [] too — waiting is the author's step | Low L3 | the placeholder rule is purely structural — `if (cells.length === 0 \|\| (cells.length === 1 && cells[0].across >= full))` (src/browser/scripts/read-table.js:2530-2533); the text is never consulted. `<td colspan="4">Loading…</td>` in a 4-column table is the s… | delete, or keep one line in :435's comment noting that the text is irrelevant. | high | R07 |
| 627 | and reads the same table as [] when the message spans all seven | Low L3 | headerless table, every data row hidden, width taken from the hidden rows, one rendered cell spanning that full width → placeholder. That is exactly `tests/read-table.test.ts:558` ("reads a FILTERED headerless table, every data row hidden, as []": 3-cell hidd… | delete :627 (or :558) — keep one success case beside :604. | high | R07 |
| 872 | a stepped-over group row is a data row — record 1, or a short row | Low L3 | loads the same `SECTIONED` markup as :828 and asserts the same records `[{_row:'1',name:'Section A'},{_row:'2',name:'Alice'},{_row:'3',name:'Bob'}]` for the same `{ header: 'Name' }` column that `tests/read-table.test.ts:850-860` already asserts (via `readTab… | drop :884-891. | high | R07 |
| 1326 | reads a <div role="grid">, which §7.9 made a table | Low L3 | a minimal `role=grid / row / columnheader / gridcell` read by header name. read-table-aria.test.ts covers the same input class several times with more detail — e.g. `tests/read-table-aria.test.ts:517` (one grid under a wrapper, read by header) and `:667` (min… | delete (read-table-aria.test.ts owns ARIA reads). | medium… | R07 |
| 1520 | hands evaluateAll the compiled script, so esbuild never rewrites its helpers | Defect | `expect(typeof compiled).toBe('function')` — `new Function(...)` always returns a function; and `expect(compiled.toString()).toContain(script.trim())` — a `new Function` body always appears in its own `toString()`. Neither can fail. The real checks are the so… | replace the two lines with `expect(() => new Function(...)).not.toThrow()` so the intent is explicit. | high | R07 |
| 1994 | ignores the footer table, which has neither rows nor a header | Low L3 | `tests/read-table.test.ts:1957` reads the identical `holdingsGrid({ id: 'holdings-grid', owns: true })` (footer table included) through the wrapper and asserts `toEqual(HOLDINGS_RECORDS)` — exactly six records with their values. That already fails if the foot… | delete, or move its one comment onto :1957. | high | R07 |
| 2681 | adopts a TWO-ROW header from the table beside it, and through the wrapper | Defect | `for (const wrapperId of ['beside-two-row', 'wrapper-two-row'])` builds identical markup except the wrapper id, and each iteration runs the same selectors (`#two-row-rows` and `#${wrapperId}`). The name suggests two different paths ("beside it" vs "through th… | drop the outer loop; keep one wrapper id. | high | R07 |
| 3109 | carries neither header refusal in the extractor any more (§7.3b.6) | Low L3 / L4 | reads `read-table.js` source and asserts `not.toContain('and v1 supports exactly one')`, `not.toContain("refusal: 'merged'")` and `toContain('merged headers or cells (rowspan/colspan > 1) are not supported')`. The negatives catch only a verbatim revert, which… | delete. | high | R07 |
| 3500 | sees the hidden spacer row and the empty header row as unrendered | Low L5 | the only assertions are `expect(await page.locator('#RadGrid1_ctl00_Header tbody tr').isVisible()).toBe(false)` and the same for `#RadGrid1_ctl00 thead tr`. No Steptix function is called. The comment's claim — that the extractor treats them as unrendered — is… | delete, or fold the two lines into :3329 as fixture premises. | high | R07 |

### `tests/record-steps-draft-locks.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 97-101 | , `tests/record-steps-edit.test.ts:214-228` — `settled()` / `inFlight()` helpers (every a… | Flake (medium) | `const until = Date.now() + 3_000; while ((h.calls.length < calls \|\| h.engine.callsInFlight > 0) && Date.now() < until) await sleep(3); await sleep(40);`. On deadline the helper returns SILENTLY, and the test then fails on an unrelated-looking draft asserti… | throw on deadline with the call count and in-flight state. Better, give `DraftEngine` an awaitable idle signal for tests, or drive it with `vi.useFakeTimers()`, since the model is synchronous. |  | R10 |
| 354 | without locks, the draft reads exactly as it always did | Low L4 | `expect(text).toContain('## The draft so far: 2 steps\nIndexes count from 0, as replaceFrom does. To only add steps, replaceFrom is 2; the furthest back you may start is 0.\n```json')` pins three sentences, their line breaks and the code fence. The behaviour… | rewrite to assert the absence of the lock text (`not.toContain('LOCKED')`, `not.toContain('"author"')`, `not.toContain('yourStepsGoHere')`) and keep one sentence check. | medium | R10 |

### `tests/record-steps-edit.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 252 | the model's stepActions are kept; an event it left out rides with its action | Defect | after `await settled(h, 1)`, the test sets `h.script.set(2, answer(['Search it'], [[]], 2));` under the comment "(the next call is scripted below; this one covers a1..a4)". No second call happens; the assertions read `inspect()` synchronously and `h.last().id… | delete the dead `script.set` line and comment, and rename to "the model's stepActions are kept" (or assert where a3/a4 went). | medium | R10 |
| 1186 | holds its invariants over 150 seeds | Flake (medium) | the RNG is seeded, but both the test's operations and the model draw from ONE stream, and the model's delays (`setTimeout(resolve, delay)`, 0–4 ms), `settleMs: 2` and `await sleep(Math.floor(r() * 4))` are real timers. Which draw goes to which consumer depend… | run the engine under `vi.useFakeTimers()` and advance time from the test loop, and give the model its own RNG stream, so each seed is one fixed history and a failure is reproducible from its seed num… |  | R10 |

### `tests/record-steps-recorder.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 438 | , `:977`, `:1104`, `:1201`, `:1259`, `:1298`, `:1443` — Add check armed, then clicked | Flake (medium) | `recorder.armPick()` is fire-and-forget (`void this.pushState()`, src/recorder/step-recorder.ts:944). The tests click 0 ms later (:441-442 and :450-451 have no wait) or after `await sleep(100)`. If the page has not received the armed state, the click is recor… | wait for the armed state in the page before clicking, e.g. `await until(() => page.evaluate(...pick-armed probe...), Boolean, 'armed')`. Or give `armPick` an awaitable form for tests. |  | R10 |
| 696 | reads that fall behind the commits are not waited on…" / "an error page is not waited on… | Flake (medium) | `await new Promise((r) => setTimeout(r, 600)); expect(history.reads).toBe(3);` (:703-706) and the same with 800 ms (:720-721). The reads are serialized and each one waits 150 ms before its request. There is more margin than in :725. | as for :725, wait for `reads >= 3`, then a short quiet period, then `toBe(3)`. |  | R10 |
| 725 | reads that fall behind a burst of pushState are not waited on: the Back after it is kept,… | Flake (high) | the rigged CDP session delays every `Page.getNavigationHistory` reply by 150 ms (`slow: { ms: 150, late: 'reply' }`). The recorder runs one read per commit, SERIALIZED in its action chain (`this.enqueue(async () => { … await readHistoryAfter(…) })`, src/recor… | wait for the count rather than sleeping, e.g. `await until(async () => history.reads, (n) => n >= 4, 'the reads', 5_000)`, then sleep briefly and assert `toBe(4)` (to keep the "no extra reads" half). |  | R10 |
| 762 | a read answered after the author's next move started is not taken: a Forward during a ret… | Flake (medium) | the rig answers the re-read after a 1 s `setTimeout` and gives the real history only if a newer navigation started in that second. The test's Forward starts after `waitForURL` + `sleep(300)` + `goForward`, so the scenario needs the Forward to begin within abo… | gate the rigged reply on a promise the test resolves after `goForward()` has started (e.g. on `frameStartedNavigating`), not on a 1 s timer. |  | R10 |
| 815 | a page restored from the back/forward cache is a back, even after a read that lagged | Flake (medium) | launches a second browser with `chromium.launch({ channel: 'chromium', ignoreDefaultArgs: ['--disable-back-forward-cache'] })` and asserts `expect(restores).toContain('BackForwardCacheRestore')`. Chromium decides bfcache eligibility at run time (memory pressu… | separate the environmental precondition from the behaviour. If no `BackForwardCacheRestore` happened, fail with a message naming the precondition (or `ctx.skip` with a counted reason, as the live sui… |  | R10 |

### `tests/record-steps-toolbar.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 232 | in the top layer, in a closed shadow root on <html>, styled; back after a navigation; in… | Flake (medium) | `expect(bar?.status).toMatch(/^REC 00:0\d · 0 actions$/)` (:244) requires the bar to be read less than 10 s after `recorder.start()`. | `/^REC \d\d:\d\d · 0 actions$/`. |  | R10 |
| 446 | the pick outline and label are never in the crop of what was picked | Flake (high) | CONFIRMED on CI (runs 36883335314, 37201465660): `await sleep(300)` (:453) stands in for "the outline has painted", then `expect(await pixelsNear(shot, [0x2e,0x9b,0xff], 20)).toBeGreaterThan(50)` got 0. | poll with the file's own until() for the outline pixels instead of sleeping; keep the toBe(0) crop checks. | high | Run |
| 468 | records nothing while paused — not a click, not typing, not an address or a Back — and th… | Flake (high) | wall-clock bound `expect(after.atMs - beforePause).toBeLessThan(1_000)` (:500). The gap includes the resume click's `settledAt` polling, `until(... 'resumed')`, `await sleep(250)` and a full Playwright `page.click('#go')`. That leaves about 750 ms for real br… | measure the paused span in the test and assert against it, e.g. `const pausedFor = resumedAt - pausedAt; expect(after.atMs - beforePause).toBeLessThan(pausedFor)`. Or inject `now` (StepRecorderOption… |  | R10 |
| 737 | a Pause the recorder refuses is taken back in the page, and so is one it never answers | Flake (medium) | explicit short budget `until(..., 'PAUSED at once', 2_000)` (:751) to catch an optimistic state that the page reverts after `COMMAND_ANSWER_MS = 3000`. | read the optimistic state from a page-side flag set synchronously with the render, so the check does not depend on CDP polling latency. Or make `COMMAND_ANSWER_MS` injectable and lengthen it here. |  | R10 |
| 818 | the bar lets clicks through to the page as soon as it is not recording — bar its Close bu… | Flake (high) | `await page.click('#wide', { timeout: 1_500 })`, a 1.5 s budget for a real Playwright click (actionability, scroll, stability) under load. The short budget is load-bearing: the done bar removes itself after `END_SHOW_MS = 6000` (src/browser/scripts/record-too… | assert the pass-through directly with `page.evaluate(() => document.elementFromPoint(cx, cy)?.id)` returning `'wide'` while the bar is shown, then click with the default timeout. Or make the end-show… |  | R10 |
| 1085 | , `:1323`, `:1375` — positive assertions after a fixed sleep | Flake (medium) | :1096-1100 `recorder.setToolbar({ ...WITH_STEPS, dock: 'tl' }); await sleep(250); … expect(b.host.y).toBeLessThan(40);` and :1106-1109 do the same for the 30-step drawer. :1336-1337 `await sleep(400); expect(commands).toEqual([{ kind: 'delete-step', id: 's1'… | `until(...)` for the positive condition (re-render shown / command arrived), then a short sleep only for the "and nothing more" half. |  | R10 |

### `tests/report-failure-outcomes.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 29 | fixture `filePath: 'c:/proj/tests/outcomes.md'` | Defect | a hard-coded Windows drive path, which CLAUDE.md's cross-platform rules forbid ("Never hard-code `C:\…`"). Harmless today — `renderReport` only echoes `report.filePath` (src/report/generator.ts:141) and no assertion reads it — but it is the pattern the rule e… | `path.resolve(path.sep, 'proj', 'tests', 'outcomes.md')`. | high | R02 |

### `tests/report-tool-step.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 111 | renders boolean and number arg values as-is | Low L2 | `formatToolValue` (src/report/generator.ts:1017-1025) has an explicit `if (typeof v === 'number' \|\| typeof v === 'boolean') return String(v);` branch before the `JSON.stringify(v)` fallback. Delete that branch and `JSON.stringify(true)` / `JSON.stringify(42… | delete (the branch is an optimisation with no observable difference), or, if the as-is contract matters, test a string arg is not JSON-quoted (`args: { s: 'x' }` → no `&quot;x&quot;`). | high | R13 |

### `tests/resolve-env-bundle.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 92 | "resolves $VAR leaves in the data file against the composed map (no global mutation)" (al… | Flake (medium) | the test assumes the ambient environment never defines these names. `expect(process.env['ADMIN_PWD']).toBeUndefined()` at :103, and `expect(process.env['BASE_URL_PURE']).toBeUndefined()` at :49, run without deleting the key first. The afterEach only removes k… | `delete process.env['ADMIN_PWD']` (and `BASE_URL_PURE`) at the top of each test, as `env-data-loader.test.ts:67`/`:79` already do. Or use a name nobody would export, such as `RESOLVE_BUNDLE_TEST_PWD`. |  | R12 |

### `tests/run-loop-contracts.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 533 | "%s gets it from interpolate, which it runs on every line" (×2) | Low L2 | `expect(source(file)).toMatch(/interpolate\(/);` passes if `interpolate(` appears anywhere in session-manager.ts / runner-adapter.ts — tests/substitution-sites.test.ts:137,151 inventories 4 and 5 such calls in those files. The claim, "runs it on EVERY line, c… | delete (substitution-sites.test.ts already fails if those calls disappear), or pin the ordering the comment describes (the interpolate call precedes the `controls[i]` dispatch in the loop body). | medium | R13 |

### `tests/run-settings.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 405 | lists ai among the wire keys, so the route stops refusing it as unknown" and `:409` — "of… | Low L5 / L3 | `expect(RUN_SETTING_KEYS).toContain('ai')` and `expect(AI_MODES).toEqual(['on', 'off', 'default'])` assert constants equal their literals. The behaviour they stand for is exercised end-to-end through the route in tests/api-server-run-settings.test.ts:928-972… | delete. | medium | R13 |

### `tests/scroll-action.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 218-261 | describe "scrollDurationMs" (3 tests) and "easeOutCubic" (3 tests) | Low L7 | `grep -rn "scrollDurationMs\\|easeOutCubic" src runner-core/src steptix-vscode/src flick-vscode/src` finds only the definitions (src/browser/actions.ts:1832, 1843). Their doc comments say the animator "carries its own inline copy" (`args.baseMs + Math.abs(tar… | rewrite against the real animator through the existing `installFakeBrowser` harness. Each fake frame advances 50 ms, so a 0→4600 'bottom' glide must take exactly ceil(1200/50) = 24 frames, and per-fr… | high | R10 |

### `tests/secret-field-parity.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 69 | the recorder withholds exactly the fields the rule calls secret | Flake (medium) | `recorder.stop()` collects the still-open last field through `briefly(callControl(frame, key, 'flush', []), PAGE_CALL_MS /* 2_500 */, [])` (src/recorder/step-recorder.ts:1155, :218). If that page call takes longer than 2.5 s under load, it silently answers `[… | after the loop, move focus out of the last field (e.g. `page.focus('body')`, or press Tab) so every field commits through the binding and does not depend on the bounded flush. Alternatively, `await r… |  | R09 |
| 69 | the recorder withholds exactly the fields the rule calls secret | Flake (high) | ORDER: the test needs the form fields empty at recorder.start(); the snapshot test at :99 fills them (its comment: "Values are already filled by the test above"). Run after it, re-filling the same value records no change, so type-password has no action ("expe… | reset the form (page.setContent, or form.reset()) or use a fresh page at the start of :69. | high | Run |

### `tests/secrets.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 613 | still dedups and still drops empties | Low L3 | `secretValues({ password: 'same' }, ['same', 'other'])).toEqual(['same', 'other'])` and `secretValues({ password: '' }, [''])).toEqual([])` are byte-identical to `tests/secrets.test.ts:47` and `:43`. Neither input contains a character that the JSON-escaping a… | delete, or change the inputs to something escaping does affect (e.g. a value with `"` given twice) so it tests dedup after escaping. | high | R09 |
| 785 | keeps the record floor for a REGISTERED binding, and the name rule for the entry | Low L3 | the fixture is `{ 'row.token': '7' }` with `markLoopBindings(live, ['row', 'row.token'])`, asserting `secrets` is `[]`, `redact('3 rows, total $1,742.70', …)` unchanged, and `redactMap` giving `{ 'row.token': MASK }`. `tests/secrets.test.ts:413` makes the sam… | delete. | high | R09 |

### `tests/section-index-cli-parity.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 118 | the SHAPES table loop (26 generated tests) | Defect | `if (cli === null) { return; }` makes a row the CLI refuses pass with no assertion. The `agree: false` rows are protected because `:129` requires `cliCalls(text)` to be `true` for them. No guard covers the 18 `agree: true` rows, unlike the fuzz test, which co… | assert `expect(cli).not.toBeNull()` for table rows (the table claims "marked's real answer measured"), or add a refused-count guard. | medium | R12 |

### `tests/sections-integration.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 158 | , `:172`, `:186` — the shipped-template block's exact-text and line pins | Low L4 | - `:158` pins the template's exact step wording (`'Navigate to the login page'`, `'Change the display name to "Demo User" and save'`, …). | keep `:150`. Rewrite `:158` to assert the structure: `sourceSkills` all null, the 5-step body appears twice, and `steps.length === 2*body + main`. Drop the line-number pins and `:172`. | medium | R12 |

### `tests/selector-measurement.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 177 | counts a hidden duplicate the DOM snapshot cannot show | Low L3 | the measured assertion is `expect(result.targeting?.matchCount).toBe(2)` for `a[href="transactions.html"]` — exactly what `tests/selector-measurement.test.ts:70` ("records both counts and a verified handle for a hidden duplicate") already asserts (`matchCount… | delete, or fold the premise line into :70. | high | R07 |
| 255 | contributes no targeting when the wait times out | Flake (medium) | wall-clock window around a real 10 s Playwright timeout — `expect(elapsed).toBeGreaterThan(8_000); expect(elapsed).toBeLessThan(16_000);` (:274-275). The upper bound leaves 6 s for the post-timeout failure path (`matchCount` via `count()` etc.) on a loaded bo… | assert the budget, not the clock — wrap the page in a Proxy (as :280-307 already does) that records the `timeout` option passed to the hoisted `waitFor` and to `click`, and assert they share one budg… |  | R07 |

### `tests/selector-role-names.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 304-322 | "waits until it holds: %s" (4 parameterised cases) | Flake (high) | elapsed-time assertion on a real browser under suite load — `const started = Date.now(); … expect(Date.now() - started).toBeLessThan(4_000);` (:311, :321), against a page whose change fires from an in-page `setTimeout(..., 300)` (:293-300) and a wait `timeout… | drop the elapsed check — `result.success === true` already proves the wait resolved on the change, because a wait for the literal selector times out and fails. If the "did not burn its timeout" prope… |  | R07 |

### `tests/selector-targeting-transcript.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 318-329 | "the recording on disk" (2 tests) | Flake (medium) | fixed scratch directory inside the repo — `const tmpBase = path.join(repoRoot, 'tests', '.tmp-selector-targeting');` with subdirs `t${counter++}` that restart at `t0` in every process, and an `afterAll` that `fs.rm`s the whole `tmpBase`. Two vitest processes… | `dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stx-targeting-'))` per test (or per file) and remove only that. |  | R07 |

### `tests/server-crash-guards.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 49 | registers both guards | Low L3 | `expect(proc.registered()).toEqual(expect.arrayContaining(['unhandledRejection', 'uncaughtException']))`. Tests 57 and 77 fire each event through the same fake and assert the logged line. With a guard unregistered, `handlers.get(event)?.(reason)` does nothing… | delete. | high | R06 |

### `tests/server-project-root.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 71 | a file outside the user root never triggers the boundary | Low L3 | the fixture is `elsewhere/steptix.config.json` + `elsewhere/deep/x.md` → `elsewhere`, the same structure as test 1 at line 45 (`proj/steptix.config.json` + `proj/tests/x.md`). The marker is found one level up, before the walk gets near the user root, so a bou… | rewrite so the boundary could misfire. Marker in `%LOCALAPPDATA%` (the tmp), file in a sibling whose name has the user root as a string prefix (`<tmp>/steptix-other/x.md`), expect `<tmp>`. | high | R06 |

### `tests/session-lazy-launch.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 291 | does not navigate to baseUrl at creation | Low L3 | `executeSteps('s-baseurl-create', { steps: [], config: { baseUrl } }); expect(mockPage.goto).not.toHaveBeenCalled()`. The test at line 329 starts with the identical batch and assertion (lines 330-334) before checking the navigation at launch. | delete (fully subsumed by `:329`). | high | R06 |
| 346 | "does not launch when the surface is computer at the first step" (also `:361`) | Defect | `await manager.executeSteps(...).catch(() => { /* the step itself has no computer executor yet */ });`. The comment is stale. Computer mode exists, and with no `desktop.enabled` the step boundary fails the step with `COMPUTER_DISABLED_MESSAGE` and returns nor… | drop the `.catch` and assert the result (`results[0].status === 'failed'`, reasoning naming computer mode), so the test proves the step ran on the computer surface. | high | R06 |

### `tests/session-manager.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 404 | returns proper StepResponse structure | Low L5/L3 | twelve `toHaveProperty` checks on keys of the typed `StepResponse`/result, which TypeScript already enforces on the producing object. The input is the same as line 393. The only real facts checked are `response.error` being null and one result. | merge `expect(response.error).toBeNull()` and `toHaveLength(1)` into line 393 and delete. | medium | R06 |
| 553 | parameters from request override accumulated outputs | Low L2 | the only assertion is inside the mocked executor: `expect(opts.resolvedParameters!['myVar']).toBe('override-value');` (line 576). If it fails, the AssertionError rejects `executeStep`. SessionManager catches that as "Unexpected error during step execution" an… | rewrite. Capture `opts.resolvedParameters.myVar` into a variable inside the mock, then assert it, `response.status === 'passed'` and `response.outputs.myVar` after the call. | high | R06 |
| 1353 | handles steps with no output prefixes | Low L2 | the inner assertion `expect(instruction).toBe('Click the login button')` (line 1356) is swallowed the same way, and the error path pushes `outputs: {}` (session-manager.ts:7475). The only outer assertion, `expect(response.results[0]!.outputs).toEqual({})`, th… | rewrite. Record the instruction in the mock, assert it outside, and assert `response.status === 'passed'`. | high | R06 |
| 1679 | does not let per-session budgets SUM across sessions | Flake (medium) | real wall clock. `briefly` (mocked with a real `setTimeout` race, lines 94-95) waits the production `PAGE_READ_TIMEOUT_MS = 1_500` (src/server/session-manager.ts:1366), then `expect(elapsed).toBeLessThan(3_000)` (line 1696). That leaves only 1.5 s of slack be… | `vi.useFakeTimers()`, start the listing, `await vi.advanceTimersByTimeAsync(1_500)` once, and assert the promise has settled (sequential would need 4.5 s of fake time). Or inject a small budget. |  | R06 |

### `tests/session-project-bundle.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 140 | falls back to defaults when no steptix.config.json is found above the test file" / "falls… | Flake (medium) | environment dependence. A bare `mkdtemp(os.tmpdir())` is assumed to have no `steptix.config.json` in any ancestor up to the drive root, and this file does not redirect `LOCALAPPDATA`, so the user-root boundary does not stop the walk. On Windows the walk from… | point `LOCALAPPDATA`/`XDG_CONFIG_HOME` at the tmp dir and anchor the stray file under that user root, as tests/server-project-root.test.ts:26-30 does. |  | R06 |

### `tests/set-step-parse.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 165 | , `:212`, `:239` — single tests repeated by the four-site table at `:381`/`:391` | Low L3 | `:165` ("refuses a row value that makes the assignment unparseable": row `He said "hi"`, `/makes the step unparseable/`) = table row "expander.ts — looped section row bindings" (`:368`, `\| ${HOSTILE} \|`). `:239` ("refuses a skill argument named after a decl… | keep the single tests (they assert each site's own message) and tighten the table to per-site messages, or drop the singles and keep the table; either way one copy of each. | high | R13 |

### `tests/set-step.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 455 | a target that already holds a value is still a target, not a source | Defect | the docstring says "a reviewer measured that mutating any of the four loops to parse the INTERPOLATED line left all 3698 tests green" and presents this as the pin. But the test runs no loop: it asserts `parseSetStep(authored)` parses (already `:23`) and `pars… | retitle as a demonstration of the hazard and point at run-loop-contracts:250 as the guard, or replace with a test that drives a loop (e.g. `runTest` with a pre-bound target, as test-runner-clarificat… | high | R13 |
| 474 | assigns twice in a row, reading its own previous value | Defect | comment "First pass: the template's own reference is unset, so it fails rather than storing the literal" sits above `runSetStep({ name: 's', template: 'a' }, …)` — a template with no reference, asserted to PASS. The failing first pass the comment describes is… | fix the comment, or add the described case (`template: '{{s}}x'` on an empty scope → `failed`). | high | R13 |

### `tests/skill-call-parser.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| — | longhand duplicates: `:82`, `:128`, `:133`, `:143`, `:148`, `:226`, `:280` | Low L3 | - `:82` "the COLON form still commits and throws" uses exactly the inputs of `:306` (`'[skill: ]'` → name missing) and `:350` (`'[skill: foo bar="x"baz="y"]'`). | delete `:82`, `:128`, `:133`, `:148`, `:226`, `:280`. Rewrite `:143` with a real double space inside the label (e.g. `'Click and verify [skill: foo]'` → `'Click and verify'`) or delete it. | high | R12 |

### `tests/skill-data-sources.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 53 | routes ${envName} in a path string to the matching JSON file | Low L3 | `:91` "skill cache key includes envName…" writes the same files, runs the same two expansions (local, staging) and asserts the same URLs, but without `clearSkillCache()` between them. `:91` passing implies `:53` passes, and `:53` reaches no branch that `:91`… | delete `:53` (or merge its exact `toEqual` into `:91`). | high | R12 |

### `tests/skill-expander-frames.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 118 | omits frame.outputs detail for skills with no declared outputs | Defect | asserts `expect(frame.outputs).toEqual([])`, which means present and empty, not omitted. Section frames, by contrast, do omit it (`tests/skill-expander-sections.test.ts:153`, `toBeUndefined()`), so the name invites confusion. | rename to "records an empty outputs list for a skill with no declared outputs". | high | R12 |

### `tests/skill-expander-sections.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 429 | names both files when a section cycles across a skill boundary | Defect | the test asserts no cycle at all: `expect(parsed.steps).toEqual(['from skill'])`. Its comment says "Two files may define same-named sections without colliding". No error is raised and no file is named. | rename to "same-named sections in a test and a skill do not collide (cycle key is per file)". | high | R12 |

### `tests/skill-expander.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 293 | , `:333`, `:413` — subfolder variants of flat tests | Low L3 | `src/skills/expander.ts` resolves `path.resolve(skillsDir, name + '.md')` the same way for any depth, and `:223` already proves subfolder resolution. | delete all three. | high | R12 |
| 644 | bare `out.<name>` for an undeclared output throws (catches typos) | Low L3 | after `parseSkillCall` desugars `out.resultcount` to the alias map `{resultcount:'resultcount'}`, the expander takes the same undeclared-output branch as `:200` (`out.bogus="x"` → `/no declared output "bogus"/`). The desugaring itself is unit-tested at `tests… | delete. | medium | R12 |
| 671 | throws on missing closing bracket", "throws on an unquoted `key=value` argument | Low L3 | these re-run `parseSkillCall` syntax errors through `expandSkills` and differ only in which error is triggered. The errors are unit-tested at `tests/skill-call-parser.test.ts:294` and `:330`, and `:665` already proves the seam (a SkillCallSyntaxError propagat… | delete both, keep `:665`. | high | R12 |

### `tests/source-skill-attribution.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 24 | , `:32`, `:50`, `:87` — the whole `expandSkills — source-skill attribution` describe | Low L3 | - `:24` (inline steps → `[null, null]`) duplicates `tests/skill-expander.test.ts:29-33`, which has the same assertion `expect(result.sourceSkills).toEqual([null, null])`. | delete the describe. Keep the `parseTestFile` describe (`:108`, `:138`, `:181`), which is the only coverage of `hookToolCalls`/`hookSourceSkills` alignment. | high | R12 |

### `tests/spec-loader.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 5 | , `:30`, `:36`, `:42`, `:48` — the `summarizeSpec` describe (5 tests) | Low L7 | `grep -rn "summarizeSpec" --include=*.ts --include=*.js --include=*.tsx --include=*.cjs --include=*.mjs .` (excluding node_modules/dist) finds only `src/api/spec-loader.ts:150` (the definition) and this test file. `src/cli/commands/specs.ts` imports `download… | delete the tests and the dead export, or wire it into the API prompt if that was the intent. | high | R12 |

### `tests/stats-aggregate.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 665 | step-N, row-R-step-N in a data-row report, and a hook step by scope and place | Low L3/L5 | `reportAnchor` is `export function reportAnchor(at) { return stepAnchor(at); }` (src/stats/aggregate.ts:733-735). The five assertions are the same inputs and outputs as tests/report-step-anchors.test.ts:40-44 (`step-11`, `row-3-step-11`, `hook-beforeEach-2-st… | delete. | high | R06 |

### `tests/stats-api-seam.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 388 | (in "lines numbered as the report numbers them…", line 335) | Flake (medium) | locale. `expect(html).toContain('9,325')` checks a number the report generator formats with `report.tokensUsed.toLocaleString()` and no locale argument (src/report/generator.ts:118). On a machine whose ICU default locale is not English it renders `9.325` (de)… | expect `(9325).toLocaleString()`, or (better) have the generator use the same fixed locale it already uses for the date (`'en-AU'`, generator.ts:111) or `'en-US'` as the stats CLI does (stats.ts:539). |  | R06 |
| 468 | the stopped step's line says interrupted, its attempts are the ones that ran, and the run… | Flake (medium) | polling loop with a fixed deadline. `waitForFinalizedRun` makes 200 tries with a 25 ms sleep each (lines 286-291), ~5 s plus round trips, for the server to see the client's abort (`res.on('close')`), reject the hanging gateway call, write the HTML report and… | poll on a total deadline well inside the 30 s test timeout (e.g. 20 s), or expose a finalised promise/event from the session manager for the test to await. |  | R06 |

### `tests/stats-classify.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 425 | reproduces each headline outcome from what Playwright says today | Flake (high) | six pages opened at once in one Chromium (`Promise.all`, line 426), each click/goto given `timeout: 500` (lines 416, 431, 457). The `blocked` and `ambiguous` verdicts need Playwright to have RESOLVED the element inside those 500 ms: `blocked` needs "locator r… | run the six probes sequentially, and before each click `await p.locator(sel).first().waitFor({ state: 'attached' })` so resolution is done before the budget starts. Raise the click budget to ~2-3 s f… |  | R06 |

### `tests/stats-concurrency.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 72 | interleave only whole lines, and each process keeps its own order | Flake (medium) | wall-clock rendezvous. `const goAt = Date.now() + 2000;` (line 76) assumes four `node --import tsx` children all finish starting (tsx compiling store.ts on the fly) within 2 s. `expect(switches).toBeGreaterThanOrEqual(WORKERS * 10)` (line 96) then requires th… | replace the clock with a barrier. Each child writes `ready` to stdout after its import and waits for a byte on stdin; the parent writes `go` to all four once every child is ready. Keep the switch che… |  | R06 |

### `tests/stats-flush.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 51 | waits for the queue, but never longer than its bound | Flake (medium) | real 150 ms timer measured with `Date.now()`: `await flushRunStats(150); … expect(waited).toBeGreaterThanOrEqual(140)`. Node schedules a timer from libuv's cached loop time, which can lag `Date.now()` by however long the current macrotask has run, so the time… | `vi.useFakeTimers({ toFake: ['setTimeout','clearTimeout'] })`, start `flushRunStats(150)`, `await vi.advanceTimersByTimeAsync(149)` and assert it has not settled, advance 1 ms and assert it has. |  | R06 |
| 68 | bounds `steptix run` at two seconds by default | Low L5/L4 | `expect(STATS_FLUSH_TIMEOUT_MS).toBe(2_000)`, a constant equal to its literal. The value is not documented in SPEC-scoreboard.md or the docs (grep). The behaviour (bounded at the constant) is tested at line 96 relative to the constant. | delete. | high | R06 |
| 96 | a stalled append cannot hold it past the bound | Flake (medium) | real 2 s wait on the production `STATS_FLUSH_TIMEOUT_MS`, asserted as `waited >= 1950 && waited < 4000`, where `waited` also includes parsing and `runTestsUnflushed`. | let `runTests` take the flush bound through its `options` seam (as `runTestFn` already does), or fake `setTimeout` and advance to the bound. Then assert the rejection arrives at the bound, not after… |  | R06 |

### `tests/stats-run-stats.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 347 | a 20-step run: the recorder adds well under 5 ms a step, and no step waits on the disk | Flake (medium) | wall-clock performance assertion: `expect(average).toBeLessThan(5)` over 20 `performance.now()` samples, i.e. a 100 ms total budget. One GC pause or the worker being descheduled for ~100 ms on a contended runner fails it. The result also depends on order: run… | keep the measurement and print it, but assert on the median (or on the minimum of 3 runs) against 5 ms, or assert a loose bound in the unit suite (e.g. 50 ms) and keep the 5 ms acceptance figure in a… |  | R06 |

### `tests/stats-store.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 693 | rides through the loader, so the run can hand it to statsSettings | Low L3 | asserts `loadConfig(off).stats` → `{ enabled: false }` and `loadConfig(plain).stats` → `undefined`, which are the first and last cases of tests/stats-config.test.ts:29-34. The extra step (`statsSettings({ projectEnabled: offConfig.stats?.enabled })`) is the `… | merge the explicit-path call into stats-config.test.ts:29 as one more `expect`, and delete. | medium | R06 |

### `tests/step-grouper.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 9 | If asked to…", "If you see…", "If there is…"; and `:144` — "handles the MFA test case fro… | Low L3 | `isConditionalStep` is `/^(if\s\|when\s(prompted\|asked))/i` (`src/runner/step-grouper.ts:82`). `:5`, `:9`, `:13` and `:17` all match the single `if\s` alternative. `:144` uses the same three-step shape (conditional, continuation, plain step) and the same ass… | keep `:5`, `:21` and `:25` (one per alternative); delete `:9`, `:13`, `:17` and `:144`. | high | R12 |

### `tests/tab-observability.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 104 | does not hang the run on a page whose title never resolves | Flake (medium) | the test asserts elapsed wall time around a real timer: `const started = Date.now(); … await new PageTracker(page).describeActiveTab(); … expect(Date.now() - started).toBeLessThan(3000);`. The bound is the real `TAB_TITLE_TIMEOUT_MS = 500` race in `briefly`,… | use `vi.useFakeTimers()` and `await vi.advanceTimersByTimeAsync(500)`, then assert `title === ''`. A real hang would hit the 30 s test timeout anyway, so the elapsed-time assertion adds no coverage. |  | R09 |
| 203 | the flag is advisory — it is not a status and cannot fail a step | Low L4 | `expect(Object.keys(tab!).sort()).toEqual(['label', 'targetId', 'title', 'unexpected', 'url'])`. This pins the exact key set of a typed diagnostic object, so adding any field to `TabInfo` breaks it. Nothing here checks that a step cannot fail, which is what t… | rewrite to `expect(tab).not.toHaveProperty('status'); expect(tab).not.toHaveProperty('error')`, or delete (TypeScript already fixes the shape). | medium | R09 |
| 278 | keeps two sessions' identically-labelled tabs distinguishable | Low L1 | two folds are fed `targetId: 'SESSION-A-TAB'` and `'SESSION-B-TAB'`, then the test asserts the outputs' `targetId`s differ. Given the pass-through already proved at `tests/tab-observability.test.ts:240`, the difference flows straight from the test's own input… | delete. | high | R09 |
| 388-392 | groups by target id, so one tab used by many steps is one row | Defect | `const rows = html.split('tab-row').length - 1; … expect(rows).toBeGreaterThanOrEqual(0);` can never fail. The test's own comment says the class only appears on the unexpected variant. The meaningful assertion is the `class="tab-id"` count of 2. | delete the `rows` lines. | high | R09 |

### `tests/test-app-documents.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| — | whole file (19 tests) | Low L7 | the file imports nothing from `src/` — only `node:*` and `playwright` — and spawns `fixtures/test-app/server.ts` plus Chromium to test the fixture's own `/api/documents` handler and `documents.html` script. Its header calls it part 1 of stories/file-upload-st… | keep the `/api/documents` block (`:156-254`) as the fixture's contract test (or move it beside the fixture); delete the four card tests `:273-336`, which upload-action.test.ts now covers through prod… | medium… | R13 |
| 259-262 | MEDIUM — beforeEach of "Documents page" (10 tests) | Flake (medium) | `await page.locator('#documents-empty').waitFor();` is meant as "page ready", but `#documents-empty` is static markup (documents.html:538), so it resolves before the page's own initial `refreshDocuments()` returns. That initial GET races the test's upload: if… | wait on the page's first fetch (`page.waitForResponse('**/api/documents')` around the `goto`) or a `data-ready` flag the script sets after its first render. |  | R13 |
| 313 | HIGH — "card 2 — clicking Choose file opens a file chooser that can be answered" (failing… | Flake (high) | after `expect((await statusAfterAction()).state).toBe('success')` the test reads `expect(await rowNames()).toEqual(['logo.png'])` with no wait. In fixtures/test-app/documents.html `upload()` calls `setStatus('success', …)` (`:662`) BEFORE `await refreshDocume… | `await page.locator('tr.doc-row[data-name="logo.png"]').waitFor();` before `rowNames()`. |  | R13 |

### `tests/test-runner-clarification-control.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 227 | MEDIUM — beforeEach of "test-runner runnerControl handling" | Flake (medium) | `Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });` is never restored, so the six later describes in the file run with a forced TTY. Nothing depends on it today (they run headless, which closes the failure-REPL gate) and vit… | save the original descriptor in `beforeAll`, restore it in `afterEach`/`afterAll`. |  | R13 |

### `tests/test-runner-control-flow.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 860 | does not warn about the item a For each header is there to bind | Defect | the test runs with `accounts: '["Everyday"]'` supplied, then asserts `expect(warnings).not.toContain('Unresolved placeholder: {{accounts}}')` under the comment "The control: the LIST is a genuine reference, and if it were missing it would still be warned abou… | rewrite the control as a positive check. Run a second header with the list missing (e.g. `For each {{account}} in {{nolist}}, …`) and assert `warnings` DOES contain `Unresolved placeholder: {{nolist}… | medium | R11 |
| 1604 | a bare Return in the main flow still ends the whole run | Low L3 | same seam (`runTest` with `executeStep` mocked), same shape (three steps with an unconditional `Return` at step 2), same assertions: `executeStepMock` saw only step 1, the last row is `skipped`, and the status is `passed`. `tests/flow-control-runner.test.ts:3… | delete, or keep only as a one-line comment pointing at flow-control-runner.test.ts:303. | medium… | R11 |

### `tests/tool-array-params.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 198 | treats a scalar string param as before (no behaviour change) | Low L3 | `args: { msg: 'hello' }` with `type: 'string'`, asserts `expect(received).toBe('hello')`. Same scalar-string pass-through as `tests/tool-executor.test.ts:29` (`args: { name: 'Ada' }` → `calls` equals `{ args: { name: 'Ada' } }`) and `:56` (placeholder interpo… | delete. | high | R13 |
| 281 | honours output aliases when storing array outputs | Low L3 | alias handling is independent of the value's type — the array is JSON-encoded by `setVar` (covered by `:226`) and the alias is applied on write (covered by `tests/tool-executor.test.ts:116` "applies caller-supplied output aliases" and `tests/tool-finalise.tes… | delete, or keep only if executor ever special-cases array aliasing. | medium | R13 |

### `tests/tool-end-to-end.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 54-88 | HIGH — , `tests/arrays-in-tools-integration.test.ts:56-86`, `tests/extract-order-ids-inte… | Flake (high) | each file carries its own copy of the same three helpers. (a) `async function waitForHttp(url, timeoutMs = 15_000)` polls every 100 ms with a fixed 15 s deadline (`throw new Error(\`Timed out waiting for ${url}\`)` at `:65`/`:66`) after `spawn(process.execPat… | one shared helper (e.g. `tests/helpers/fixture-server.ts`) used by all six-plus files: start the server with `PORT=0`, have `fixtures/test-app/server.ts` print the BOUND port (`server.address().port`… |  | R13 |
| 169 | parses the demo .md test, recognising tool steps in the parallel toolCalls array | Low L3 | asserts `toolStepIndices` and `toolCalls[2]` = `{ name: 'fetch_csrf_token', args: { baseUrl: '{{baseUrl}}' }, outputAliases: {} }` — the same parallel-array + bare-shorthand desugaring `tests/tool-parser-integration.test.ts:31` and `:49` assert through the sa… | delete, or move to tool-parser-integration if the demo file's parse is wanted as a docs-freshness check. Same applies to `:342` ("parses the regex-extract demo .md"), whose quoted-value-with-colons c… | medium | R13 |
| 250-340 | the six "regex_extract: …" tests | Low L8 | `regex_extract` lives only in `fixtures/tools/src/regex_extract.ts` (grep of `src/` for `regex_extract`: no hits; it is referenced from issues/020 as "the interim workaround … shipped as a reusable example tool"). Five of the six assert the fixture's own rege… | move the five semantic cases to a cheap file that loads `fixtures/tools/src` with no browser/server (the shape `tests/save-json-tool.test.ts` already uses for save_json); delete `:295`. | high (c… | R13 |

### `tests/tool-helper.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 25 | throws on tool(fn) when the argument is not a function | Defect | the call is `tool('only-name-no-fn')` — a STRING first argument, so `tool()` takes the `typeof arg1 === 'string'` branch (src/tools/tool-helper.ts) and throws `'tool(name, fn): second argument must be a function'`. The regex `/argument must be a function/` al… | rewrite to `tool(42 as never)` and assert `/tool\(fn\): argument must be a function/`. | high | R13 |

### `tests/tool-not-found-hint.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 171 | handles a Windows-style toolsDir path verbatim | Low L3 | `buildNotFoundMessage` (src/tools/registry.ts:384-397) only interpolates `toolsDir` into `` ` Scanned: ${toolsDir} (${filesScanned} file…)` `` — no path handling at all. The test asserts `expect(msg).toContain('C:\\Projects\\vibe\\ai-ui-automation')` and `toC… | delete (or fold the Windows string into the :24 case if desired). | high | R13 |

### `tests/tool-reload.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 33,43 | MEDIUM — every test in the file (fixed in-repo temp base) | Flake (medium) | `const tmpBase = path.join(repoRoot, 'tests', '.tmp-tool-reload');` and `freshDir()` = `path.join(tmpBase, \`t${counter++}\`)` + `fs.mkdir(dir, { recursive: true })`, never emptied. The counter restarts at 0 each run, so a previous run that aborted (Ctrl-C, w… | `await fs.rm(tmpBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })` in a `beforeAll`, or `freshDir` via `fs.mkdtemp(path.join(tmpBase, 't-'))`. |  | R13 |

### `tests/ui-runner-adapter-env-data.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 323 | a steer resolves against the same environment; ... | Flake (medium) | polling with a wall-clock deadline: `async function waitFor(condition, timeoutMs = 5000) { const deadline = Date.now() + timeoutMs; ... setTimeout(resolve, 5) }`, used as `await waitFor(() => events.some((e) => e.channel === 'runner:paused'))`. Before it paus… | resolve a promise from the emit callback instead of polling, e.g. `const paused = new Promise<void>((r) => { emit = (ch, d) => { events.push(...); if (ch === 'runner:paused') r(); } })`. Or at least… |  | R12 |

### `tests/upload-action.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 101-105 | , `tests/open-page.test.ts:133-137` — afterAll | Defect | `serverProc.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 50)); if (!serverProc.killed) serverProc.kill('SIGKILL');`. `ChildProcess.killed` becomes true as soon as `kill()` delivers the signal, not when the child exits, so the SIGKILL branch can nev… | `await once(serverProc, 'exit')` with a timeout before escalating, inside the shared helper recommended above. | high | R10 |
| 326 | fails a missing file BEFORE evaluating the selector | Flake (medium) | wall-clock assertion `expect(Date.now() - started).toBeLessThan(3_000)` around an `executeAction` call. | delete the elapsed-time assertion. The test already proves the ordering without it (`not.toMatch(/timeout\|not visible/i)` and `matchCount` undefined). |  | R10 |
| 367 | refuses a path that escapes the project"; `tests/upload-action.test.ts:378` — "refuses an… | Low L3 | both are seam tests that differ from `:326` ("fails a missing file BEFORE evaluating the selector") only in which `resolveUploadPaths` refusal propagates out of `executeAction`: `toContain('outside the project folder')` and `toContain('requires "filePath" or… | fold into `:326` as a small table over the three refusals (keeping the `retryable` assertions), or delete. | medium | R10 |

### `tests/upload-paths.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 247 | on POSIX, still fences an absolute path outside the project | Flake (medium) | writes a FIXED path shared by every run on the machine, `const outside = path.join(os.tmpdir(), 'steptix-upload-outside.png')`, and `fs.rm`s it in `finally`. Two suites at once on one box (two worktrees, the CLAUDE.md workflow, or two CI jobs on a shared runn… | create the outside file in its own `fs.mkdtemp(path.join(os.tmpdir(), 'steptix-upload-outside-'))` directory. |  | R10 |

### `tests/use-ai-runner-cli.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 128 | file-level temp dir (all 9 tests) | Flake (medium) | same as above: `const tmpBase = path.join(repoRoot, 'tests', '.tmp-use-ai-runner-cli'); ... dir = path.join(tmpBase, `t${counter++}`)`, and `afterAll` removes the whole base. | `fs.mkdtemp(path.join(repoRoot, 'tests', '.tmp-use-ai-runner-cli-'))` in a `beforeAll`. |  | R12 |

### `tests/use-ai-step-runner.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 188 | exactly the resolved text: one system message, one user message, nothing else from the te… | Flake (medium) | the fixture date is a fixed future year (`const scope = { today: '2031-01-05', ... }`), and the test then asserts `expect(all).not.toContain(String(new Date().getFullYear()))`, where `all` is the JSON of the request and holds the user message `Today is 2031-0… | build the fixture year from the clock so it can never equal it, e.g. `const year = new Date().getFullYear() + 5; const scope = { today: `${year}-01-05`, ... }`, and expect `${year+5}0108`-style value… |  | R12 |

### `tests/use-ai-step.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 33 | file-level temp dir (affects every test in the file that calls `write`) | Flake (medium) | a fixed path inside the repo plus a per-process counter: `const tmpBase = path.join(repoRoot, 'tests', '.tmp-use-ai-step'); ... dir = path.join(tmpBase, `t${counter++}`)`, and `afterAll` does `fs.rm(tmpBase, { recursive: true, ... })`. Two runs of this file f… | `beforeAll(async () => { tmpBase = await fs.mkdtemp(path.join(repoRoot, 'tests', '.tmp-use-ai-step-')); })`. This keeps the in-repo location the code-behind bundle needs and makes each run unique. |  | R12 |

### `tests/use-step-parity.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 236-237 | inside "the corpus reaches every branch on both sides" | Defect | `l.includes(' ')` and `cliClaims('[use computer]')` contain a literal U+00A0 (confirmed with `od -c`: bytes `302 240`), which looks like an ordinary space. An editor or formatter that normalises NBSP to a space would turn `:236` into `l.includes(' ')`, which… | write both as `' '` / `'[use computer]'`. | high | R12 |

### `tests/use-step.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 67 | the closed set is exactly the two surfaces | Low L5 | `expect(USE_SURFACES).toEqual(['computer', 'browser'])` asserts a constant equals its literal. A third surface added by accident would already fail the PROSE/refusal tables (`'[use phone]'` must refuse, `:131`), and the CLI/runner-core agreement is pinned at… | delete. | medium | R12 |
| 589 | [use computer] and click Save — keeps its whole-step refusal | Low L3 | `expect(useStepError('[use computer] and click Save')).toContain('is the whole step')` is a subset of `:146`, which asserts the same line, the same phrase, the fix text and the caret column. | delete. | high | R12 |

### `tests/video-config.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 41 | defaults to 'off' when unspecified | Flake (medium) | environment dependence, not timing — `const config = await loadConfig();` with no path reads `steptix.config.json` from `process.cwd()`, i.e. the repo root's tracked config. The test passes only while that file sets no `browser.video`. | `loadConfig(undefined, <mkdtemp dir>)` as `tests/desktop-config.test.ts:65-69` does. |  | R08 |

### `tests/video-recording.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 55 | , `:101`, `:122` — the three recording cases | Flake (medium) | real Chromium with `recordVideo`; `finalizeMainPageVideo` closes the context (which flushes the .webm through Playwright's ffmpeg) then `fs.rename`s / `fs.rm`s it (manager.ts:1858-1873). On Windows a just-closed .webm can still be held (ffmpeg exit, Defender… | move cleanup to `afterEach` with `fs.rm(..., { maxRetries: 5, retryDelay: 100 })`; consider retrying the rename in `finalizeMainPageVideo` on EBUSY/EPERM (product fix, since the same race hits real r… |  | R08 |

### `tests/wait-timeout.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 39 | the default is below the cap (sanity) | Low L5 | `expect(DEFAULT_WAIT_TIMEOUT_MS).toBeLessThan(MAX_WAIT_TIMEOUT_MS)` compares two literals; no logic of the unit runs. | delete (or fold into the boundary test at `:23` if the relation is wanted). | high | R10 |
| 148-150 | blocks on text that lives only in <script> source / hidden nodes, then matches once it is… | Defect | `expect((globalThis as any).document.body.textContent.includes('Ready now')).toBe(true)` reads the stub the test built two lines earlier. The comment says "a revert to textContent flips this assertion red", but no code under test runs in it, so it cannot flip… | delete the line, or reword the comment to say it documents the fixture and that `:147` is the guard. | high | R10 |

## runner-core

### `runner-core/package.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| on | `npm test` runs `../dist/` with no `pretest` build (affects all 17 runner-core test files) | Defect | scripts are `"build": "tsc"`, `"prepare": "npm run build"`, `"test": "node --test tests/*.test.js"` — no `pretest`. Every runner-core test imports `'../dist/…'` (e.g. api-client.test.js:3, step-lines.test.js:14). After editing runner-core/src, `npm test` in r… | add `"pretest": "npm run build"` to runner-core/package.json. | high | E03 |

### `runner-core/tests/api-client.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 82 | streamSteps: a config block without viewport stays byte-for-byte what it was | Low L1 | `streamSteps` does `body: JSON.stringify(request)` (runner-core/src/api-client.ts:623) with no logic touching `config`. The test sends `config: { baseUrl: 'https://example.test/' }` and asserts `assert.deepEqual(body.config, { baseUrl: 'https://example.test/'… | delete (keep :50 as the single "client does not normalise `config`" contract pin). | high | E03 |
| 386 | compileCodeBehind: yields the inner run events of a Record and a Replay as compile:run | Low L3 | Same `postSse` frame loop as :422 ("compileCodeBehind: yields phases, steps and the final result in order"). The nested fields it asserts (`runs[2].event.fromCodeBehind`, `runs[3].event.error`, `runs[3].event.screenshot`, `events.at(-1).summary.writtenOffAi`)… | merge into :422 (one frame list containing a `compile:run` frame is enough), or delete. | medium | E03 |
| 468 | compileCodeBehind: 401 still throws unauthorized"; `:480` — "compileCodeBehind: aborting… | Low L3 | `streamSteps`, `compileCodeBehind` and `streamRecordSteps` are each a one-line `yield* this.postSse(...)` (api-client.ts:482, :507, :536). The 401 mapping (`postSse` :631), the abort mapping (:626) and the frame→event loop (:680-684) are one code path. :468 r… | delete all three (the route-specific tests :355 and :452 already prove `compileCodeBehind` reaches `postSse` with its own route and 409 mapping). | high | E03 |

### `runner-core/tests/env-file.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 192 | composeEnv: does not mutate its inputs | Low L5 | `composeEnv` is `return { ...base, ...overlay };` (runner-core/src/env-file.ts:282). Object spread cannot mutate its operands; the test asserts `assert.deepEqual(base, { A: '1' })` after calling it — that is a language guarantee. | delete (the :181 overlay-wins case is the one worth keeping — it pins argument order). | high | E03 |

### `runner-core/tests/errors.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| — | catalogue entries with no production emitter (STX002, STX020, STX026, STX030, STX031) | Low L7 | `grep -rn "'STX002'\\|'STX020'\\|'STX026'\\|'STX030'\\|'STX031'" steptix-vscode/src flick-vscode/src src` → no `reportError(...)` call (STX030 appears only in two comments). Every `reportError` call site is in steptix-vscode/src/extension/run-controller.ts (:… | remove the dead codes from the catalogue (owner decision); then drop `STX002`/`STX020` from the :68 path table and `SAMPLE_CONTEXTS`. | high | E03 |
| 51 | every code produces a payload with code + non-empty message + non-empty fix | Low L5 | `reportError` builds `message: \`${code}: ${built.diagnosis}. ${built.fix}\`` and returns `code` as passed (runner-core/src/errors.ts:263-268), so `assert.equal(payload.code, code)` and `payload.message.startsWith(\`${code}:\`)` restate the function's own tem… | rewrite — fold the two non-empty checks into :61 ("every fix sentence ends with a period", which is the documented format rule) and drop the code/prefix round-trip. | high | E03 |
| 171 | actions reference real-looking command ids | Defect | Asserts only `action.label.length > 0` and `action.command.length > 0`. STX020's action `{ label: 'Reopen as Text', command: 'steptix.reopenAsText' }` (errors.ts:188) names a command that is neither in steptix-vscode/package.json nor registered (`grep -rn "re… | rewrite to assert every `action.command` is either a `workbench.*` built-in or a command contributed in steptix-vscode/package.json `contributes.commands` — which today fails on `steptix.reopenAsText… | high | E03 |

### `runner-core/tests/frontmatter.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 20 | parseFrontmatter: disabled false / missing returns no disabled key | Defect | The first assertion is `assert.deepEqual(parseFrontmatter('---\ndisabled: false\n---\n'), { disabled: false })` — a `disabled` key IS returned. Only the "missing" half matches the name. | rename to "disabled: false is kept as false; absent stays absent". | high | E03 |
| 30 | parseFrontmatter: tags as flow list | Low L3 | :35 ("tags normalize to lowercase") parses the same flow list shape including a quoted item (`"Needs-Network"`) and asserts the same output; :30 adds no branch. | merge into :35. | high | E03 |
| 61 | parseFrontmatter: no dataSources key when absent | Low L3 | `assert.deepEqual(parseFrontmatter('---\ntags: [x]\n---\n'), { tags: ['x'] })` — every other `deepEqual` on dataSources-free input (:12, :27, :32, :87, :105) already proves no `dataSources` key appears. | delete. | high | E03 |

### `runner-core/tests/protocol.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 11,43,94,120,125,141,169,181,190,204,22… | all `isHostMsg` / `isRunEvent` / `isCompileEvent` tests (15 tests incl. part of :271/:285) | Low L7 | `grep -rn "isRunEvent\\|isCompileEvent\\|isHostMsg" steptix-vscode/src flick-vscode/src src` (excluding runner-core) → the only hit is the webview's OWN `function isHostMsg(value)` over a local `HOST_MSG_TYPES` set (steptix-vscode/src/webview/steptix-runner.j… | delete these tests together with the dead exports — or, if the guards are meant to stay, replace the hand-kept lists with one parity test: runner-core `isHostMsg` accepts exactly the webview's `HOST_… | high | E03 |
| 54 | isWebviewMsg: accepts every webview variant | Defect | The guard accepts `t === 'rerunFailedRows'` (protocol.ts:1967) and the union has `type: 'rerunFailedRows'` (:1838), but the test's list omits it. runner-view.ts:157 drops whatever this guard rejects, so this is the live filter; a hand-kept list cannot catch a… | add `rerunFailedRows`; better, derive the expected set from the `WebviewToHostMsg` union's `type:` literals in protocol.ts source (source-pin) so a forgotten type fails. | high | E03 |
| 181 | isRunEvent: capture event from an old server (no source) still narrows"; `:271` — "step:p… | Low L1 | `assert.equal(legacyCapture.source ?? 'capture', 'capture')` evaluates `??` on the test's own literal; `assert.equal(asCode.fromCodeBehind, true)`, `assert.equal(stale.codeBehindStale.file, '/p/tests/a.steps.ts')` and `assert.equal(cb.file, '/p/tests/a.steps.… | delete (subsumed by the L7 finding). | high | E03 |

### `runner-core/tests/record-steps.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 74 | streamRecordSteps: a draft's ids and edited, record:edited, and the actions a step delete… | Low L1 / L3 | `streamRecordSteps` is `yield* this.postSse(...)` (api-client.ts:536), and `frameToEvent` returns `JSON.parse(frame.data)` unchanged when it has a string `type` (:906-919). Every assertion — `events[0].ids`, `events[2].actions`, `events[3].tab`, `events[6].th… | delete :74; shrink :178 to nothing (or delete — :236 keeps the one record-specific contract, that the record stream is not filtered). | high | E03 |
| 104 | controlRecordSteps: edit-step, and drop / restore of a step by its id, go as sent | Low L3 | `controlRecordSteps` sends `body: JSON.stringify(body)` (api-client.ts:562) — the `calls` deep-equal reads back the test's inputs, which :305 already proves for six other actions. The `{ ignored: true, reason }` mapping it asserts is the same branch as :341 (… | delete. | high | E03 |
| 132 | isHostMsg: the Recording block message is a host message"; `:136` — "isHostMsg: the Add s… | Low L7 + L3 | Dead subject as above; also both types are already in the list at protocol.test.js:35-37 (`'recording'`, `'recordAddStepResult'`). | delete. | high | E03 |
| 140 | isWebviewMsg: every Recording control the panel posts is accepted | Low L3 | The eight types `['recordSteps', 'recordNewTest', 'recordStop', 'recordCancel', 'recordCheck', 'recordDrop', 'recordPause', 'recordAddStep']` are exactly the eight at protocol.test.js:75-83 in "isWebviewMsg: accepts every webview variant". The only new assert… | delete. | high | E03 |
| 249 | , `:277`, `:285` — 409 / 404 / abort on `streamRecordSteps` | Low L3 | Same `postSse` branches as api-client.test.js:452 (409 conflict with reason), :134 (404 not-found), :176 / :480 (abort). `streamRecordSteps` adds no error handling of its own. | delete (keep :261 — the 400→`server-error`→`apiErrorReason` path is covered nowhere else). | high | E03 |

### `runner-core/tests/regression-corpus.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 1-38 | header claim | Defect | The header says "The filter predicate (`extractSections(text).length === 0`) is logically equivalent to the property being asserted" and "`section-heading` is the only new classification". Since 5629c90 ("Make numbered items under a #### heading inert, everyw… | update the header, and filter the corpus by that property too (exclude a document when `classifyLines` emits any `inert-step`, exactly as sectioned ones are excluded) so the guard keeps meaning "noth… | high | E03 |
| 68-86 | module-level corpus walk (all `unchanged …: <file>` rows) | Flake (medium) | `walk()` recurses `fixtures`, `templates` and `steptix-vscode/tests/integration/fixtures` of the live working tree, skipping only `node_modules`, `dist`, `.git`. `readdirSync` is in a try, but `if (statSync(full).isDirectory())` (:78) is not. In the main chec… | `readdirSync(dir, { withFileTypes: true })` (no per-entry `statSync`), skip any dot-directory (`.steptix`, `.steptix-codebehind-cache`, `.steptix-tool-cache`), and tolerate ENOENT per entry. |  | E03 |
| 197 | "no section kinds appear: <file>" (one per sectionless corpus file) | Low L3 | Row :185 asserts `classifyLines(text)` deep-equals `legacyClassifyLines(text)`, and the legacy classifier (:101-130) can only emit `frontmatter\|blank\|heading\|step\|prose`. So if :185 passes for a file, :197 cannot fail for it; if :185 fails, :197 adds noth… | delete the :197 rows; keep :189 for its `resolveRunLines` assertion (or, per the `resolveRunLines` L7 finding below, retarget it to `resolveRunSelection(text, []).lines`). | high | E03 |

### `runner-core/tests/repl.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 304 | the split decides `keyword` and `sort_key` twice, and differently | Low L3 | All four assertions are exact repeats: `maskIfSecret('keyword','search') → '******'` (:207), `maskIfSecret('payment.keyword','search') → 'search'` (:257), `maskIfSecret('sort_key','abc') → '***'` (:297), `maskIfSecret('payment.sort_key','abc') → 'abc'` (:256). | delete (the "pair is the whole split" point is a comment, not a new check). | high | E03 |

### `runner-core/tests/sections.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 78 | resolveRunLines: an empty result is not the same as an empty request | Low L3 | `assert.deepEqual(resolveRunLines(text, [24]), [])` is :71 verbatim; `assert.notDeepEqual(resolveRunLines(text, []), [])` is implied by :65 (`[13, 17, 18]`). | delete. | high | E03 |
| 84 | classifySelectedSteps: a requested body line selects nothing | Low L3 | `assert.deepEqual(classifySelectedSteps(read('classification.md'), [24]), [])` is the same call on the same fixture as run-selection.test.js:170 (`classifySelectedSteps(text, [24])` → `[]`). | delete (keep run-selection.test.js:170, which sits with the scope-argument tests). | high | E03 |

### `runner-core/tests/sse-parser.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 47 | parses a step:skip frame like any other event type | Low L3 + L1 | `SseParser.push` never inspects the event name beyond storing it (runner-core/src/sse-parser.ts:58-59), so type-agnosticism is already proven by :5 (`event: step:pass`) and :25 (`event: x`). The last four assertions `JSON.parse(frames[0].data)` → `parsed.type… | delete. | high | E03 |

### `runner-core/tests/step-lines.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| (isStepLine) | / `nearestStepAtOrBelow` / `nearestStepAtOrAbove` — `runner-core/tests/step-lines.test.js… | Low L7 | `grep -rn "nearestStepAt" steptix-vscode/src flick-vscode/src src` → nothing. `isStepLine` hits in production are all LOCAL functions (steptix-vscode/src/extension/commands/index.ts:380 `const isStepLine = (line: number)…`, src/ui/renderer/components/Editor.t… | delete the three exports and these tests (keep :296's `extractSteps`/`extractSections` assertions). | high | E03 |
| (resolveRunLines) | tests — `runner-core/tests/step-lines.test.js:242,246,250,255,261,266,274,279`; `run-sele… | Low L7 | `grep -rn "\bresolveRunLines\b" steptix-vscode/src flick-vscode/src src` → one hit, a comment (steptix-vscode/src/extension/commands/index.ts:1171). `resolveRunLines` is a two-line wrapper: `const selection = resolveRunSelection(text, requestedLines); return… | delete the export; rewrite the step-lines.test.js SAMPLE rows (heading-only fallback, blank-line fallback, past-the-end, mixed selection — branches run-selection.test.js does not hit on a sectionless… | high | E03 |
| 266 | resolveRunLines: selection past the last step returns empty (nothing to run) | Defect | `const text = SAMPLE + '\n7. trailing prose without numbered list under Steps';` is built and never used — the assertion is `resolveRunLines(SAMPLE, [99])`. The comment then argues about line 7 of `text` ("the trailing line is still a step at line 7") before… | delete the `text` line and the comment; keep `resolveRunSelection(SAMPLE, [99])` → `[]` (see the `resolveRunLines` L7 finding). | high | E03 |

### `runner-core/tests/test-meta.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 124 | resolveSection: missing $VARs left untouched | Low L3 | `resolveSection` maps `resolveValueFromEnv` over the entries; :111 already proves the mapping and :103 ("missing $VAR returns the literal $VAR") proves the missing-var branch with the same input class. | delete. | medium | E03 |

## flick-vscode

### `flick-vscode/tests/integration/controller.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| — | every other `waitFor` (default 3000 ms) | Flake (medium) | all waits use the 3 s ceiling; besides `historyReplace`, flows that include a real HTTP round trip + several file writes (`sessions` after `newSession`/`adoptCdpTab`, `cdpDiscovery`, `serverSessions`) are exposed to the same loaded-box stalls. | raise the default ceiling (see above); it is a ceiling, not a sleep. |  | E03 |
| 58 | `afterEach` cleanup `fs.rmSync(dir, { recursive: true, force: true })` | Flake (medium) | the store dir holds freshly written PNGs and JSON in `os.tmpdir()`; on Windows a scanner holding one of them makes `rmSync` throw EBUSY/EPERM (`force` only ignores ENOENT), failing the hook and the test. Same scanner mechanism as the confirmed flake, at teard… | `fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })`. |  | E03 |
| 251 | an unreachable server produces an error result entry and an error toast | Defect | The comment says "Port 1 is reserved and refuses connections — a genuine network failure", and the test sets `flick.apiUrl` to `http://127.0.0.1:1`. Port 1 is on the WHATWG fetch "bad port" list, so undici rejects before any socket is opened — measured on thi… | start and stop a `FakeApiServer` and point `flick.apiUrl` at its now-closed port, as :429 already does — a real ECONNREFUSED (1–7 ms on Windows loopback, measured). | high | E03 |
| 359 | "deleting a confirmed session removes its tab, local data, and closes the browser server-… | Flake (high) | The failing await is `await wait(fw, 'historyReplace')` at :363 (before `fw.drain()`), with the default `FakeWebview.waitFor` budget of `timeoutMs = 3000` (tests/fakes/fake-webview.ts:48) polled every 10 ms. The "saw:" list — `init, connection, sessions, hist… |  |  | E03 |

### `flick-vscode/tests/unit/browser-launcher.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 132 | cache: an overridden call does not leak its result to a subsequent uncached call | Low L2 | Both calls pass deps, and `detectInstalled` skips the cache entirely whenever deps are given — `const hasOverrides = deps !== undefined && Object.keys(deps).length > 0; if (!hasOverrides && cachedDetection) return cachedDetection;` … `if (!hasOverrides) cache… | rewrite — make the overridden call, then call `detectInstalled()` with no deps while a spy on the module's default `existsSync`/`which` path can tell recompute from cache-hit (or expose a test-only `… | high | E03 |
| 253 | profile dir is created with recursive: true | Low L3 | The happy-path test already asserts `assert.deepEqual(mkdirCalls[0], { p: '/tmp/.flick/chrome-profile', opts: { recursive: true } })` (:197-200); this repeats it for the edge engine, through the same unconditional `mkdirSync(opts.profileDir, { recursive: true… | delete. | high | E03 |
| 356 | "poll timeout…" (the line `assert.equal(POLL_INTERVAL_MS, 200)`) | Low L5 | Restates `export const POLL_INTERVAL_MS = 200;` (browser-launcher.ts:58); the comment says it is a "sanity check exported constant exists". | drop that line (and the `POLL_INTERVAL_MS` import); keep the rest of the test. | high | E03 |

### `flick-vscode/tests/unit/cdp-discovery.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 85 | ports queried in parallel | Flake (medium) | wall-clock assertion `assert.ok(spread < 20, ...)` on `Date.now()` stamps taken at the first fetch of each port. The three stamps are pushed in one synchronous tick (`ports.map(probePort)` runs to the first `await` inside the fake fetch), so the spread is nor… | measure concurrency, not time — count in-flight fetches (`inFlight++` before the `await sleep`, `inFlight--` after) and assert `maxInFlight === 3`; a sequential implementation gives 1. |  | E03 |
| 194 | empty Browser field → engine \"unknown\" | Low L3 | `Browser: ''` reaches `classifyEngine('')` and falls through every `startsWith` arm to `return 'unknown'` — the same branch as the table row `{ browser: 'SomeOtherBrowser/1.0', expected: 'unknown' }` at :135. The `tabs: []` assertion repeats :112. | merge into the :124 table as `{ browser: '', expected: 'unknown' }` (or, for a new branch, make the row a NON-string `Browser`, which hits the `typeof … === 'string' ? … : ''` fallback at cdp-discove… | medium | E03 |

### `flick-vscode/tests/unit/parse-steps.test.ts`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 37 | quoted content inside a step is preserved | Low L3 | `parseSteps` has no quote handling at all (split, trim, strip `^\s*\d+[.)]\s+` / `^\s*[-*]\s+`; src/shared/parse-steps.ts). A line with quotes takes exactly the path of "plain lines become one step each" (:7). | delete (or replace with a case that does hit a branch, e.g. `'- 1. nested'` or `'10) Step'`). | medium | E03 |

## steptix-vscode

### `steptix-vscode/package.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| on (pretest) | Systemic — steptix-vscode does not build runner-core | Defect | see the last entry under Flakiness risks. `"pretest": "npm run build --prefix .."` builds the root only. `record-steps-core.ts`, `lm-bridge-env.ts`, `server-manager.ts` and `server-url.ts` import `steptix-runner-core`, which resolves to `runner-core/dist`. | `"pretest": "npm run build --prefix .. && npm run build:runner-core"` | high | E01 |
| on (pretest) | Systemic: steptix-vscode runs against an unrebuilt `runner-core/dist` | Flake (medium) | most cores under test import the package specifier `'steptix-runner-core'` (e.g. `step-lines.ts:16`, `data-tables-core.ts:14`, `section-diagnostics-core.ts:13-23`, `env-data-completion-core.ts`, `renumber-core.ts`, `row-selection-core.ts`, `sections.ts`, `ste… | make steptix-vscode's `pretest` also run `npm run build:runner-core` (a `tsc`, already defined at steptix-vscode/package.json:680), e.g. `"pretest": "npm run build --prefix .. && npm run build:runner… |  | E02 |

### `steptix-vscode/tests/anchor-shift.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 28 | insert THREE lines above the anchor shifts by three | Low L3 | same "entirely above" branch (`deltaAbove += addedLines - (endLine - startLine)`, step-lines.ts:109) and same input class as `:18` ("insert above the anchor shifts the derived line down"); multi-line deltas are additionally covered by `:165` ("two separate ab… | delete (or merge into `:18` as a second assertion). | high | E02 |
| 190 | changesTouchAnchor: a whole-line replace ending at column 0 of the anchor line is NOT a t… | Low L7 | `changesTouchAnchor` is exported from `steptix-vscode/src/extension/step-lines.ts:47` and its only other occurrences repo-wide are these two tests (`Grep "shiftAnchorForChanges\|changesTouchAnchor"` excluding node_modules: step-lines.ts:47 definition, anchor-… | delete both tests together with the dead export (or, if kept as API, fold into one parity loop asserting `changesTouchAnchor(c, a) === (shiftAnchorForChanges called its function)` over the existing c… | high | E02 |
| 249 | , `:262`, `:276`, `:287` — section-body block ("a deleted body step snaps to the next ste… | Low L1 / L3 | the section scoping these names claim ("can reach 25 but can never reach 33", "Cleanup's line 33 is NOT a candidate") is implemented by the test's own callback — `(target) => [24, 28].filter((l) => l >= target)` and `() => [24, 25]` — not by the unit; in prod… | keep `:218` and `:232`; delete `:249/:262/:276/:287`, or rewrite them to exercise `sectionBodyLinesAt` / `maintainAnchor` so the section-scoping claim is actually tested. | high | E02 |
| 276 | the call position shifts on an insert above while the body anchor does not | Defect | the name says the body anchor does not shift, but the test asserts it does: `assert.equal(body, 24, 'body step moved down one line too');` (23 → 24). Also listed in the L1/L3 block above. | rename to what it checks, or delete with the block above. | high | E02 |

### `steptix-vscode/tests/compile-progress.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 43 | , `:50`, `:64`, `:69` (and the headline/detail halves of `:55`) + `steptix-vscode/tests/c… | Low L7 | `stripHeadline` and `stripDetail` in `steptix-vscode/src/extension/compile-progress-core.ts:33,41` have no production caller — `grep -rn "stripHeadline\b\\|stripDetail\b"` over `steptix-vscode/src` finds only the definitions; `compile-tail-signals.ts:2-10` im… | point the four compile-progress strip tests at `compile-strip-inline.js` directly and delete `stripHeadline`/`stripDetail` from the core (keep `stripFraction`, which `compile-tail-signals.ts:148` use… | high | E02 |

### `steptix-vscode/tests/data-tables.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 85 | the header and the delimiter are not rows — they never take a status" / "the reserved lin… | Low L3 | `:85` asserts `assert.deepEqual(rowLines, [6, 7, 15])` and then that 4/5/13/14 are absent — both already implied by `:75`'s exact `[['run', null, 4, [6, 7]], ['section', 'Upload each statement', 13, [15]]]`. `:100` asserts the alignment set and row set are di… | delete both (or fold the disjointness check into `:93` as one extra line). | high | E02 |

### `steptix-vscode/tests/env-data-completion.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 425 | an out-alias {{}} cannot express is not offered", "[input:] / [output:] only count anchor… | Low L3 | all four run `captureNamesBefore(CAPTURES, 20\|21)` on the same fixture and assert `includes`/`!includes` of names whose presence/absence `:410` already pins with an exact `assert.deepEqual(... [['sid','as',9], ['username','input',14], ['balance','output',15]… | merge into `:410` (keep the per-rule comments on the expected list); delete the four. | high | E02 |

### `steptix-vscode/tests/failure-outcomes.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 92 | with no warning the hover is byte-identical to what it always was | Low L3 | `assert.equal(toleratedHoverMessage({ error: 'x' }), \`${TOLERATED_HOVER_OPENING}\n\n${fenced('x')}\`)` is the same exact-string assertion, same branch (no warning, no flags), as `:68`: `assert.equal(hover, \`${TOLERATED_HOVER_OPENING}\n\n${fenced(WARNING)}\`… | delete `:92`; in `:68` use a neutral error string so it does not read like a warning case. | high | E02 |
| 225 | a run with no tolerated step renders the byte-identical string it always did | Low L3 | `stepsSummaryText(summaryOf('pass', 'pass'))` → `'2/2 passed'` and `stepsSummaryText(summaryOf('pass', 'skip'))` → `'1/2 passed, 1 skipped'`. The second is byte-for-byte `steps-summary.test.js:89` (same helper, same input, same expected); the first is the all… | delete; steps-summary.test.js owns the no-tolerated wording. | high | E02 |

### `steptix-vscode/tests/guard-marks.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 50 | a guard the model decided pops to a plain ✓ | Low L3 | on a fresh `GuardMarks`, `marks.notePass(DOC, 2, 'pass')` hits the `if (!lines) return;` no-op (guard-mark-core.ts:139-140), so `forFramePop` returns `{ status: 'pass' }` exactly as in `:31` ("a pop on a line nothing marked"). The meaningful version — a plain… | delete. | high | E02 |

### `steptix-vscode/tests/inspector-target.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 151 | stepsFileBreakpoints: empty in, empty out | Low L5 | `stepsFileBreakpoints` is `paths.filter((p) => /\.steps\.ts$/i.test(p))` (inspector-target.ts:130); `assert.deepEqual(stepsFileBreakpoints([]), [])` tests `Array.prototype.filter` on an empty array. | delete. | high | E02 |

### `steptix-vscode/tests/invocation-target-core.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 86 | TOOL_FILE_EXTS matches the registry probe order | Low L5 | `assert.deepEqual([...TOOL_FILE_EXTS], ['.ts', '.mts', '.js', '.mjs']);` compares the export to a literal copy of itself; it cannot detect drift from the registry it names because it never reads it. The claim is also off: the root registry's `TOOL_FILE_EXTS`… | rewrite as a source-pin that reads `src/tools/registry.ts` and compares its extension set to the mirror (order-insensitive), or delete. | high | E02 |
| 150,165,182,212,238,258,510,524,544 | and `sections-preflight.test.js:347,361,375` — temp-tree cleanup | Flake (medium) | `fs.rmSync(root, { recursive: true, force: true })` with Node's default `maxRetries: 0`, run immediately after the files and junctions in the tree were created and read. On Windows (the only OS in the CI matrix today, `.github/workflows/unit-tests.yml:34`), D… | `fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })`, or wrap cleanup in `try { … } catch {}` so cleanup can never fail a test; in sections-preflight move the `rmSync` i… |  | E02 |
| 207 | collectSkillNames survives self-referential directory links (visited-set, not depth) | Flake (medium) | wall-clock assertion on real filesystem I/O: `const started = Date.now(); … assert.ok(Date.now() - started < 2_000, 'a looping walk must terminate fast');`. The walk is `realpathSync.native` + `readdirSync` + `statSync` over a just-created temp tree that incl… | drop the `Date.now()` assertion and give the test `{ timeout: 10_000 }` (node:test option) so a regression fails instead of hanging; keep the deepEqual. |  | E02 |

### `steptix-vscode/tests/lm-bridge-core.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 563 | the qualified id is what .env carries after gateway/ | Low L3 | `qualifiedModelId` is `` return `${model.vendor}/${model.id}`; `` (lm-bridge-core.ts:545-547). The test asserts `qualifiedModelId({ vendor: 'copilot', id: 'gpt-4.1' }) === 'copilot/gpt-4.1'`. `:670` already asserts the same output through its only production… | merge into `steptix-vscode/tests/lm-bridge-core.test.js:670`, i.e. delete it | high | E01 |
| 624 | "neither builder hands out a reference to the usage it was given" (the stream half, lines… | Defect | `const finish = JSON.parse(streamFrames(shape)[1].replace(/^data: /, '')); finish.usage.completion_tokens = 999; assert.equal(shape.usage.completion_tokens, 7);`. `streamFrames` returns strings built with `JSON.stringify` (lm-bridge-core.ts:606, `const sse =… | delete lines 635-637. A string cannot alias, so there is nothing to test, and the name could become "chatCompletionBody does not hand out…". | high | E01 |

### `steptix-vscode/tests/mark-lines.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 274 | (one assertion inside "two touching selections deleted together join a step onto an UNMAR… | Low L7 | `assert.equal(shiftMarkLine(9, changes, () => 0), null);` — `shiftMarkLine` (mark-lines-core.ts:301) is exported but has no caller outside the module or this test (`grep -rn "shiftMarkLine" steptix-vscode/src` → only its definition and a doc comment; the trac… | drop that one assertion (and the dead export). The test itself stays. | high | E02 |

### `steptix-vscode/tests/panel-scope.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 25 | a file's lines are visible only in that file's view | Low L3 | two files, one line each, read back separately. `:33` ("two concurrent compiles never interleave in one view") does the same with five interleaved lines across the same two URIs and asserts both logs exactly — a strict superset. | delete `:25`. | high | E02 |
| 87 | switching away and back finds the strip at its current count | Low L5 | `setStrip` twice on the same URI, then `assert.equal(stripFor(strips, A).done, 6)` — this is `{ ...strips, [uri]: state }` overwriting a key (panel-scope-inline.js:79). Nothing "switches away and back"; no other URI is touched. | delete, or rewrite to actually interleave a B update between the two A updates (which `:93` nearly does already). | medium | E02 |

### `steptix-vscode/tests/placeholder-grammar-parity.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 114 | the runtime constant is still the string both suites pin | Low L3 | `assert.equal(NAME_SOURCE, '\\w+(?:\\.[A-Za-z_][A-Za-z0-9_]*)?'); assert.equal(PLACEHOLDER_SOURCE, '\\{\\{(…)\\}\\}');` duplicates the root golden at `tests/placeholder-dotted.test.ts:76-77`, which already pins what the constant is. The drift this file exists… | delete (or keep only if the owner wants the deliberate friction). | medium | E02 |
| 336 | the acceptance corpus is present and actually dotted" / "no dotted reference in a step of… | Flake (medium) | reads live fixture files under the repo: `readFileSync(resolve(TESTS_DIR, f), 'utf8')` over `templates/init/tests/table-*.md`. `templates/.env` sets `APPEND_RUN_HISTORY_TO_TEST_FILE=true`, and `src/report/history-appender.ts:51` rewrites the test file with a… | make `history-appender.ts` write atomically (write a temp file beside it, then `rename`), which also protects every other reader; and/or read the corpus as committed (`git show HEAD:templates/init/te… |  | E02 |
| 338 | (assertion in "the acceptance corpus is present and actually dotted") | Low L4 | `assert.equal(files.length, 12, 'expected the twelve table-read acceptance tests');` — the test's purpose is non-vacuity (its per-file loop and `:384`'s `checked >= 20` already ensure that). An exact count fails the unit suite the day someone adds a 13th `tab… | change to `assert.ok(files.length >= 12, …)`; keep the rest. | high | E02 |

### `steptix-vscode/tests/record-steps.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 1203 | a fresh block is starting, with no actions, no draft and nothing drafting | Low L5 | `newRecordingState` (src/extension/record-steps-core.ts:5566-5577) returns an object literal that copies three fields from its args. The test `assert.deepEqual(fresh(), { uri: 'file:///t.md', file: 't.md', mode: 'cursor', phase: 'starting', pickArmed: false,… | delete | high | E01 |

### `steptix-vscode/tests/record-steps*.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| — | Systemic — every test in , `lm-bridge-env.test.js`, `server-manager.test.js` and `server-… | Flake (medium) | `steptix-vscode/package.json` has `"pretest": "npm run build --prefix .."`, which builds the root only. The modules under test import `from 'steptix-runner-core'`: record-steps-core.ts:38-44 (`classifyLines`, `parseConfig`), lm-bridge-env.ts:13 (`parseEnv`, `… | change pretest to `npm run build --prefix .. && npm run build:runner-core`, in line with CLAUDE.md's rule "Keep `npm test` building first". |  | E01 |

### `steptix-vscode/tests/repair-step.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 63 | a step with no entry, or a passing one, is not offered Repair | Low L3 | asserts `row.when !== compile[0].when` and `row.when.includes(STALE_LINES_KEY)`. The regression its comment names — widening the clause to `activeFile` alone — already fails `:53` (`assert.match(when, /editorLineNumber\s+in\s+steptix\.staleStepLines/)`). The… | delete. | high | E02 |

### `steptix-vscode/tests/row-selection.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 561 | dataRowLinesOf: every table’s rows, ascending — the gutter menu key | Low L7 | `dataRowLinesOf` (row-selection-core.ts:438) has no caller in `steptix-vscode/src` (grep of every `.ts/.js/.jsx` finds only its definition). The `steptix.dataRowLines` gutter key is built from a different function, `dataRowSignatureLines` (active-file-tracker… | delete the test and `dataRowLinesOf`; if the gutter key needs its own pin, test `dataRowSignatureLines` (it is exported). | high | E02 |

### `steptix-vscode/tests/row-summary.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 314 | the word for a row depends on the table | Low L5 | `rowWord` is `return kind === 'section' ? 'iteration' : 'row';` (row-summary-core.ts:30-32) with no caller outside the module; both outcomes are already asserted through the real sentences — `:54` ("iteration 2 of 3 running") and `:131` ("Iteration 2 failed a… | delete. | high | E02 |

### `steptix-vscode/tests/rows-panel.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 434 | rowKey is what keeps the two lists' selections apart | Low L5 / L3 | `assert.equal(rowKey("run", 3), "run#3")` pins a string template; the keys it produces are already asserted by every selection test (`:181` `["run#1"]`, `:222` `["section:S#3"]`, `:237` `["run#2", "section:S#2"]`), and `:233` is the test that actually proves… | delete. | high | E02 |
| 441 | the row's values text and detail pass through untouched — the host masks and words them | Low L3 | the pass-through assertions (`group.rows[0].values === input`) check that `rowGroups` does not transform rows; the rest restates other tests — `formatRowDuration(7400) → "7.4s"` / `undefined → ""` (`:168`), `buildTableRowsPayload(group, [3]) → { rows: [3] }`… | keep one pass-through assertion (fold it into `:82`), drop the rest. | medium | E02 |

### `steptix-vscode/tests/run-state.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 53 | a mixed legacy file keeps its lines and maps only the retired status | Low L3 | `restoredStatuses` is one loop with two independent per-entry branches (`running` → skip, retired → map; run-state-core.ts:35-41). `:14` covers the mapping, `:21` the drop and the order, `:25` the pass-through. Mixing them in one array adds no branch or inter… | delete. | high | E02 |

### `steptix-vscode/tests/sections-copy-parity.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 168 | extractSections: keeps the [no-hooks] marker on a body step verbatim | Low L3 | the `marker strip:` loop at `:109` already runs the row `"[no-hooks] Login"` from `fixtures/sections/match-table.json` through `extractSections` and asserts `steps[0].instruction === row.stepRawText.trim()` — the same input class and assertion. (Note: none of… | delete `:168`. | high | E02 |
| 254 | the differential harness can actually detect a disagreement | Low L3 | it asserts only `extractSections(text).length === 1` and the redundant `notDeepEqual(..., [])` on the mirror. It never shows the harness detecting a disagreement. The vacuity it guards against (both sides returning `[]`) is already ruled out by the frozen-tab… | delete, or rewrite to feed the differential a deliberately wrong comparator and assert it fails. | high | E02 |
| 287 | extractStepLineIds: the two copies agree with each other | Low L3 | loops over `Object.keys(frozen.files)` = `classification.md`, `classification-edge.md`, `classification-hashes.md` — exactly the keys of `STEP_LINE_IDS`, for which `:278` (webview) and `:282` (host) each assert `deepEqual(..., expected)`. Both equal to the sa… | delete (or keep only if new fixtures will be added to `frozen.files` without `STEP_LINE_IDS` rows). | high | E02 |

### `steptix-vscode/tests/selection-lines.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 71 | the whole-line rule applies to a two-row drag over a table" / "with no runnable set, the… | Low L3 | `:71` `selectionLinesFrom([sel(5, 0, 7, 0)])` → `[6, 7]` is the same branch and input class (multi-line range ending at column 0, no runnable set) as `:33` `sel(2, 0, 5, 0)` → `[3, 4, 5]`; "table" is only a label — the function knows nothing about tables. `:1… | delete `:71`; fold `:120` into `:88` as its contrasting first assertion. | high (`… | E02 |

### `steptix-vscode/tests/server-manager.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 68 | –`:190` — the positive-path `defaultHealthProbe` tests ("probe: our server reads as healt… | Flake (medium) | each test makes a real loopback HTTP round trip to a port-0 stub under a 1000 ms per-probe abort (`await defaultHealthProbe(s.url, 1000)`). If the timer fires first, the result is `kind: 'down'` with `no answer within 1000 ms`, and every one of these assertio… | use a generous timeout such as `10_000` on the paths that are not about the timeout. Keep the 50 ms value only in `:158`, which tests timeouts on purpose. |  | E01 |
| 250 | "start: spawns with the configured command/cwd/log and reports ready" (also `:272` "start… | Flake (medium) | the test injects `sleep: noSleep` but no `now`, so `startServerAndWait` uses `Date.now` (server-manager.ts:696 `const now = args.now ?? Date.now;`). The budget is `readyTimeoutSeconds: 1` (`config()` at :213-218). The test passes only if the loop gets through… | pass `now: () => 0`, as `:306` already does with a fake clock, or use `readyTimeoutSeconds: 60`. Neither test is about the budget. |  | E01 |
| 694 | "log tail: does not include the whole file when it is short" (line 700) | Defect | `assert.equal(readFileSync(logPath, 'utf8').includes('a'), true);` reads back the fixture the test wrote two lines earlier (`writeFileSync(logPath, ['a', …, 'g'].join('\n'))`), so `readLogTail` never runs on that line. The real check is the line before: `asse… | delete line 700. If the intent was "the tail omits the early lines", assert `assert.ok(!tail.includes('a'))`. | high | E01 |
| 713 | describeHealth: the headline names the build | Low L4 | `assert.equal(headline, `Steptix server on ${LOCAL} — v1.0.0-beta.1 (b700473, modified)`)` pins the whole headline sentence. No doc or spec quotes it: grep for `Steptix server on` finds only server-manager.ts:279 and this test. The behaviour the test names, t… | rewrite to `assert.match(headline, /v1\.0\.0-beta\.1 \(b700473, modified\)/)`, with an optional `assert.ok(headline.includes(LOCAL))` | medium | E01 |

### `steptix-vscode/tests/server-url.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 79 | "nothing anywhere is the default serve listens on…" (line 79) | Defect | `assert.equal(DEFAULT_SERVER_URL, 'http://127.0.0.1:3100');` compares the constant with its own literal. The source names the real risk at server-url.ts:26-28: "Nothing links the two copies (the extension bundles separately from the framework), so change both… | rewrite the line as a parity check. Import or read `src/config/defaults.ts`'s `DEFAULT_CONFIG.server` (the root `dist/config/defaults.js` exists after pretest) and assert ``DEFAULT_SERVER_URL === `ht… | high | E01 |

### `steptix-vscode/tests/set-step-mirrors.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 122 | classifyCaptureSource: knows assignment, and still collapses the unknown | Low L3 | every assertion is already in `variables-panel.test.js`: `'assignment'` (`:143`), `'toolOutput'` (`:134`), `'capture'` (`:138`), `undefined` → `'capture'` (`:165`), unknown → `'capture'` (`:170-171`). Same function (`variables-panel.js:98`), same inputs. | delete here (the Set-step file's subject is the name scanners, not the badge). | high | E02 |

### `steptix-vscode/tests/skill-run-targets.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 46 | samePath folds drive-letter case on win32 only | Defect | the body is `assert.equal(samePath(LOGIN, LOGIN), true); if (process.platform === "win32") { …case-folded compare… }`. On Linux and macOS only the identity check runs, so the "only" half of the name — `samePath` does NOT fold case off Windows (skill-run-targe… | split into `test('…win32', { skip: process.platform !== 'win32' }, …)` and a POSIX case asserting the current non-folding behaviour (`samePath('/proj/A.md', '/proj/a.md') === false`) — and note for t… | high | E02 |

### `steptix-vscode/tests/step-lines-inline.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 33 | , `:46`, `:55`, `:59` — the four `filterToStepLines` tests | Low L7 | `filterToStepLines` (step-lines-inline.js:137) has no caller: `grep -rn "filterToStepLines" steptix-vscode/src` returns only its definition; steptix-runner.jsx imports `countStepLineStatuses, extractStepLineIds` from this module (line 15) and nothing else. | delete the four tests and the dead export. | high | E02 |

### `steptix-vscode/tests/step-skip.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 66 | the glyph is the hollow circle the Rows panel and the gutter use | Low L5 | `assert.equal(SKIP_GLYPH, '◌');`. Every exact-string wording test in the same file (`:70`, `:77`, `:109`…) starts with `◌`, and `failure-text-copy-parity.test.js:157` pins the codepoint and the mirror's equality. | delete. | high | E02 |
| 88 | both single-line surfaces carry the same glyph and the same separator | Low L3 | checks prefix `◌ ` and suffix `skipped — ${REASON}` on `skipRunLogLine(9, REASON)` and `skipTestOutputLine(9, '', REASON)`; `:70` and `:77` already assert those two functions' full strings for the same `REASON` (only the line number differs). | delete. | high | E02 |
| 299 | a skip with no broken condition is byte-identical to before | Low L3 | `skipRunLogLine(7, NOT_TAKEN, undefined) === skipRunLogLine(7, NOT_TAKEN)` is JavaScript's own optional-parameter semantics; `skipRunLogLine(7, NOT_TAKEN)` → `'◌ step 7 skipped — another branch…'` is `:129` verbatim; the compile and Test Explorer lines with a… | delete. | high | E02 |

### `steptix-vscode/tests/third-party-notices.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 19 | `after` cleanup (all 9 tests), and the same pattern at `steptix-vscode/tests/server-url.t… | Flake (medium) | the cleanup runs `fs.rmSync(dir, { recursive: true, force: true })` with no `maxRetries` on files written moments earlier. In third-party-notices some of those files were just written by a spawned `node` child (`THIRD-PARTY-NOTICES.txt`). On Windows, antiviru… | `fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })`, or wrap the cleanup in try/catch, because a leftover temp dir is harmless. |  | E01 |

### `steptix-vscode/tests/use-step-editor.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 99 | the `[use …]` message wins over the generic directive list | Low L3 | `errors(doc(…, '1. [use]'))` → one row containing `'names no surface'` is exactly the first row of `:44`'s table (`['[use]', 'names no surface']`, with `assert.equal(rows.length, 1, instruction)`). The rule-order point is real, but `:44` already fails if the… | delete (move its comment onto `:44`'s `[use]` row). | high | E02 |
| 122 | a non-test document gets nothing | Low L3 | `computeSectionDiagnostics('# Notes\n\n1. [use phone]\n')` → `[]` exercises the first line of the function, `if (!isTestFile(text)) return [];` (section-diagnostics-core.ts:45), which `section-diagnostics.test.js:50` ("a non-test file produces no diagnostics"… | delete. | medium | E02 |

### `steptix-vscode/tests/variables-panel.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 175 | and `:188` — capture/toolOutput captureSource annotation | Low L3 | `:224` ("distinguishes parameter, page capture, and tool output in one file") asserts `pageTitle.captureSource === 'capture'` and `resultUrl.captureSource === 'toolOutput'` (via a skill `out.` alias) on the same code path, and adds the parameter case. What `:… | keep `:224`, delete `:175` and `:188`. | medium | E02 |
| 394 | , `:399`, `:407`, `:559` — maskIfSecretInline scope cases and maskIfSecretAuthoredInline… | Low L3 | `record-secret-parity.test.js` runs `maskIfSecretInline(name, 'uk_live_1234', opts)` over `SCOPE_CORPUS` (:377-415, asserted at :417-437): `'user.apikey' {bindings: []}` masked (`:394` here), `'payment.keyword' {bindings: []}` masked (`:396`), `'payment.keywo… | delete the four. | high | E02 |

### `steptix-vscode/tests/viewport-recycle.test.js`

| Where | Test | Kind | Why | Action | Conf. | Batch |
|---|---|---|---|---|---|---|
| 112 | an unresolved $VAR is compared like any other string | Low L3 | `comparisonKey` is `spec.trim().toLowerCase()` (viewport-recycle.ts:37); `'$VIEWPORT'` is not special to it, so `onLiveSession('$VIEWPORT', '$VIEWPORT')` → no recycle is `:57`'s "unchanged" case and `('$VIEWPORT', 'mobile')` → recycle is `:27`'s "changed" cas… | delete (or keep as documentation of the deliberate no-resolution decision — it costs nothing, but it cannot catch a bug `:27`/`:57` would miss). | medium | E02 |

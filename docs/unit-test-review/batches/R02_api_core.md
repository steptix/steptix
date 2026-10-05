# R02_api_core

## Summary
- Files: 16 · tests (approx, table rows expanded): ~540 · High ~470 · Medium ~45 · Low 25 · Defects 3 · Flakiness risks: 4 high (4 tests), 5 medium entries (5 tests + 1 file-wide temp dir)
- Overall quality is high. The Sessions-API suites are deliberately real-HTTP seam tests (the request builder is an allow-list), assert on what reaches the executor/`launchBrowser`/AiClient rather than on stored state, and almost every negative carries a named positive control. api-server-errands, api-server-failure-outcomes, failure-tail-executor and failure-tail-parse are exemplary. The failure-outcomes feature has one suite per level (parse → executor → three run loops → report) and no same-level repetition worth cutting.
- Low value clusters in three places: label-only copies at the HTTP seam (4 CDP launch-outcome pass-throughs that echo the stub, 2 viewport cases that re-run the pure resolver through HTTP, a duplicate 404); a cross-cutting global middleware (auth, idle bump) re-asserted per route; and a few assertions that cannot fail or do not check their claim (tools abort test, "legacy fall-through", "resolves ${data.X}", "does not close anything"). api-response-store tests three methods with no production caller.
- Flakiness is the bigger issue and it is concentrated in tests/api-server-cdp.test.ts: four concurrency tests use a 20–30 ms wall-clock window (`setTimeout(r, 20)` before release; a 30 ms sleep as the overlap window) where the errand and peek suites in the same batch already use promise gates + `vi.waitFor`. Plus two real-clock idle tests, one abort test timed with sleeps, one order-dependent list test, one test reading the real user root's config, and one fixed in-repo temp dir.

## Flakiness risks

### `tests/api-server.test.ts:751` — "aborts the in-flight run when the client disconnects"
- Mechanism: wall-clock waits stand in for events: `await new Promise((r) => setTimeout(r, 250)); ac.abort();` then `await new Promise((r) => setTimeout(r, 800));` before `expect(callsAfterAbort).toBeLessThan(5)` with a mocked step that sleeps 200 ms. If the server is slow to see the disconnect (> ~550 ms on a loaded box) all five steps start and the test fails; on a slow box it can also pass without the abort working. It also installs `vi.mocked(executeStep).mockImplementation(...)` permanently (not `Once`) and never restores it, so every later test in the `API Server` describe and the lifecycle `GET /health` tests run with a 200 ms step, and the aborted run's background loop shares the call counter that line 829/846 ("a Set step ... no executeStep call") diffs.
- Risk: medium
- Fix: gate the mocked step on a promise (as `slowStep()` at line 1060 already does): release step 1, wait for the `step:start` of step 2 on the stream, abort, then await the run's completion (e.g. poll `GET /health` `runsInFlight === 0` or await a promise resolved from the mock when it sees `opts.signal.aborted`). Restore `defaultStepImpl` in a `finally`.
- Evidence: reasoning; the same file's shutdown suite (1060-1087) already uses the on-cue pattern and restores in `afterEach`.

### `tests/api-server.test.ts:589` — "returns list of active sessions"
- Mechanism: order dependence — `// Ensure at least one session exists (from prior tests)` ... `expect(body.sessions.length).toBeGreaterThan(0)`. Run alone (`-t`, `it.only`) or reordered, the list is empty and the test fails.
- Risk: medium
- Fix: POST a step to its own session id first, then assert that id is in the list.
- Evidence: the comment at line 590 states the dependency.

### `tests/api-server-cdp.test.ts:724` — "two concurrent POSTs for the same key produce ONE launch"
- Mechanism: the gate is released on a timer, not on an event: `await new Promise((r) => setTimeout(r, 20)); release();` then `expect(startCdpBrowserMock).toHaveBeenCalledTimes(1)`. The route `await loadConfig(undefined, projectRoot)` (src/server/api-server.ts:1914, real disk I/O) BEFORE it looks up `cdpLaunchesInFlight` (line 1930). Server and client share one event loop, so if the second request has not finished HTTP parsing + `loadConfig` within 20 ms, `release()` lets the first launch settle, the `.finally` deletes the slot, and the second request starts a second launch → `toHaveBeenCalledTimes(1)` fails.
- Risk: high
- Fix: release only once both requests have joined the slot. The map lookup follows `await loadConfig(...)` with no further `await` (api-server.ts:1914-1936), so a partial `vi.mock('../src/config/loader.js')` whose `loadConfig` calls the real one and then increments a counter lets the test `await vi.waitFor(() => expect(loaded).toBe(2))` and then `release()` — two resolutions mean both requests are parked on the same promise.
- Evidence: reasoning from the route; vitest.config.ts:15-19 itself notes that under a full parallel run "a test that takes a second alone can take several".

### `tests/api-server-cdp.test.ts:750` — "different profiles are NOT serialised against each other"
- Mechanism: `await new Promise((r) => setTimeout(r, 20)); expect(started).toBe(2);` — both POSTs must traverse HTTP + `loadConfig` and reach the mock within 20 ms of wall clock. On a loaded box `started` is still 1.
- Risk: high
- Fix: `await vi.waitFor(() => expect(started).toBe(2))` (a serialising implementation would still fail, by the waitFor timeout) before `release()`.
- Evidence: reasoning.

### `tests/api-server-cdp.test.ts:999` — "does not serialise closes against DIFFERENT browsers"
- Mechanism: the overlap window is a 30 ms sleep inside the mock (`await new Promise((r) => setTimeout(r, 30))`) and the test asserts `expect(maxConcurrent).toBe(2)`. If the second DELETE reaches the mock more than 30 ms after the first (loaded box, same event loop as the server), the two never overlap and the test fails although nothing is serialised.
- Risk: high
- Fix: replace the 30 ms sleep with a shared gate: each mock call increments `inFlight` then awaits a promise; the test does `await vi.waitFor(() => expect(inFlight).toBe(2))` and then releases. The serialising tests at 949/971 assert `maxConcurrent === 1`, which a sleep cannot break, so they are fine as written.
- Evidence: reasoning.

### `tests/api-server-cdp.test.ts:1224` — "does NOT serialise concurrent focuses"
- Mechanism: same as above with three requests: 30 ms sleep window, `expect(maxConcurrent).toBe(3)`.
- Risk: high
- Fix: gate + `vi.waitFor(() => expect(inFlight).toBe(3))`, then release.
- Evidence: reasoning.

### `tests/api-server-cdp.test.ts:393` / `:1124` — "an authenticated request bumps the idle monitor" / "an authenticated focus bumps the idle monitor"
- Mechanism: real wall clock on both sides of a real HTTP round trip. `IdleMonitor` defaults to `Date.now` (src/server/idle-monitor.ts:24). After the request, `expect(idleMonitor.idleFor()).toBeLessThan(QUIET_MS)` (250 ms) fails if the tail of the request after the auth middleware's bump — route handler, response, client `await fetch` — takes more than 250 ms, which a fully loaded parallel run can produce (server and client share one event loop). The precondition `toBeGreaterThanOrEqual(QUIET_MS)` compares a `setTimeout` (monotonic loop clock) against `Date.now` (wall clock, adjustable); the listen between monitor creation and the sleep usually absorbs the difference, so that half is the smaller risk.
- Risk: medium
- Fix: inject a fake clock the way tests/api-server.test.ts:952 does (`new IdleMonitor(60, () => clockNow)` passed as `createApiServer`'s third argument) and assert exact values. Better still, delete both (see Low-value: they duplicate tests/api-server.test.ts:1035).
- Evidence: the comment at 400-404 shows the assertion was already loosened once for slow machines.

### `tests/api-server-cdp.test.ts:584` — "POST echoes which scope the launch went into"
- Mechanism: posts `projectRoot: userRoot()`, the REAL `userRootDir()` (`%LOCALAPPDATA%\steptix`, `$XDG_CONFIG_HOME/steptix` or `~/.steptix`). The POST route runs `loadConfig(undefined, projectRoot)` on it before launching (api-server.ts:1914-1925), so on a developer machine whose real user root holds a malformed `steptix.config.json` the route answers 400 `config_invalid` (the behaviour line 700 pins) and `asUser.scope` is undefined. The rest of the user-root sweep block (546-582) only realpaths the real directory, read-only.
- Risk: medium (machine-dependent, not timing)
- Fix: in a `beforeAll`, point `LOCALAPPDATA` (win32) / `XDG_CONFIG_HOME` (POSIX) at an `fs.mkdtempSync(os.tmpdir())` dir and restore in `afterAll`.
- Evidence: reasoning; `userRootDir` at src/env/user-root.ts:38-54 reads `process.env`.

### `tests/failure-outcomes-runner.test.ts:139` — whole file (`tmpBase = path.join(repoRoot, 'tests', '.tmp-failure-outcomes-runner')`)
- Mechanism: a FIXED path inside the repo, shared by every run of this file from this checkout; `afterAll` does `fs.rm(tmpBase, { recursive: true, ... })` on the whole directory. Two `npm test` runs in one checkout at once (a watcher plus a CI-style run, or two agents in the same worktree) write `t0/t0.md`… into the same folder and the first to finish deletes the other's files mid-run. Windows indexer/AV locks on freshly written `.md` files there were already seen (commit 5e61f46, "Retry removing in-repo temp dirs that Windows briefly locks"), which `maxRetries: 10` now absorbs.
- Risk: medium
- Fix: `fs.mkdtemp(path.join(os.tmpdir(), 'failure-outcomes-runner-'))`. The in-repo location exists for suites whose code-behind bundle must resolve the repo's packages (5e61f46's message); this file writes no `.steps.ts`, so it does not need it. If it must stay in-repo, `fs.mkdtemp(path.join(repoRoot, 'tests', '.tmp-failure-outcomes-runner-'))` at least makes it per-run.
- Evidence: git show 5e61f46.

Already guarded, not flagged: every errand concurrency case in tests/api-server-errands.test.ts parks on a promise and releases in `finally` (lines 685, 1210 with `server.once('request')`, 2524, 2557, 2623, 2643, 2723); `serverIdle()` (541) polls `/health` with a 3 s ceiling only after an awaited abort, on mock-only work. tests/api-server.test.ts's lifecycle suite uses an injected clock (952) and gates `slowStep()` (1060). tests/api-server-cdp.test.ts's peek in-flight checks use `vi.waitFor` + gates (1317, 1348). tests/api-server-failure-outcomes.test.ts drives step mode on the `step:awaiting` event (402). `process.stdout.isTTY` in failure-outcomes-runner.test.ts:374 is restored in `finally`. All servers listen on port 0 and all other temp dirs are `mkdtemp(os.tmpdir())`.

## Per-file verdicts
| File | Tests | Verdict (High/Medium/Mixed/Low) | One-line note |
|---|---|---|---|
| tests/api-response-store.test.ts | 12 | Mixed | formatForContext tests are fine; 5 store tests exercise `getForStep`/`getAll`/`clear`, which have no production caller |
| tests/api-server.test.ts | 44 | High | real HTTP seam; strong regression guards (envName parse, lifecycle/idle on an injected clock, 409/503 on cue); one mis-named data test, one superseded env smoke test, one timing-based abort test, one order-dependent list test |
| tests/api-server-cdp.test.ts | ~105 | Mixed (mostly High) | route contracts are well chosen (withholding, single-flight, close queue, peek detach/no-lock, navigate guards); 4 timer-window concurrency tests are flaky, 2 idle-bump tests duplicate api-server.test.ts on a real clock, 5 outcome/warnings pass-through tests echo the stub. Minor: "adds sessionId to every owned tab" (1896) only ever sees `null`, so a hard-coded `sessionId: null` passes — add a `sessionsByTarget` spy case as the navigate suite does at 1825 |
| tests/api-server-content.test.ts | 32 | High | validation, truncation (incl. off-by-one, surrogate pair, pre-clipped snapshot), in-band failure markers and project-vs-server config are all real contracts; one duplicate 404 test |
| tests/api-server-errands.test.ts | ~58 | High | the strongest file in the batch: every concurrency case is held open on a promise gate (never a sleep), every negative has a named control, and the receipt/teardown regressions (wedged browser, live-array skip, macrotask-late tab, prototype-key capture) each pin a bug that happened. No low-value tests found |
| tests/api-server-failure-outcomes.test.ts | ~22 | High | the session-loop level of the failure-outcomes feature over real HTTP (allow-list, SSE, step mode, sections, data rows, scope frame). Overlaps the errand loop's outcome tests (api-server-errands:949-1073) by design — different loop code |
| tests/failure-tail-parse.test.ts | ~95 (table-driven) | High | frozen grammar table, both directions, plus contradiction/directive refusals at parse time; the right home for grammar cases |
| tests/failure-tail-executor.test.ts | ~25 | High | real `executeStep` with only actions/DOM/AI stubbed; the "is the tail doing it, not the wording" control per path is exemplary |
| tests/failure-outcomes-runner.test.ts | ~19 | High | the CLI `runTest` loop level, with real controls (REPL, diagnosis); one render assertion duplicates report-failure-outcomes; in-repo fixed temp dir |
| tests/report-failure-outcomes.test.ts | ~12 (table-driven) | High | presentation-only contracts matched on the rendered element, not the bare class name; merge-rows masking regressions |
| tests/api-server-last-run-sidecar.test.ts | 7 | High | the whole-test-vs-slice gate over real HTTP, with "the batch still ran" controls and a byte-for-byte no-rewrite check; the sidecar write is awaited before the response (session-manager.ts:8549), so no read race |
| tests/api-server-run-settings.test.ts | 53 | High | asserts what reaches the executor/AiClient, not what was stored; retention, isolation, server-config non-mutation (a bug that shipped), keyless/self-auth compositions. Overlaps tests/run-settings.test.ts only at a different level (pure resolver). One per-route 401 test (1212) |
| tests/api-server-session-id-casing.test.ts | 6 | High | incident regression (DELETE no-op on the other drive-letter casing) at the route→manager seam. Gap, not a defect: the behaviour differs by platform but there is no POSIX case asserting a path-shaped id stays case-sensitive there (CLAUDE.md asks for "their own case where the behaviour differs"); "non-path session ids" (295) covers only non-path ids |
| tests/api-server-tools.test.ts | 13 | Mixed (mostly High) | real catalogue + `executeToolStep` + content-hashed hot reload; the 409-leak and catalogue-reload regressions are good. The "legacy fall-through" test does not check the fall-through and the abort test's capture assertion cannot fail. Minor: the comment at 582 says "On the second pause" but `stepCount === 1` is the first (and correct) one |
| tests/api-server-use-ai.test.ts | 8 | High | real executor with edges stubbed; secret-mask regressions (issue 060, looped rows, skill args, shadowed `{{password}}`) and the never-run `.steps.ts` entry with a positive control |
| tests/api-server-viewport.test.ts | 17 | High (two dups) | asserts on what `launchBrowser` and the executor were handed; isolation and no-launch-on-refusal are the right seams. Two tests re-run the pure resolver's cases through HTTP |

## Low-value tests

### `tests/api-response-store.test.ts:43` / `:50` / `:55` / `:63` / `:37` — "retrieves response by step number", "returns undefined for missing step", "clears all responses", "getAll returns a copy (not the internal array)", "stores multiple responses"
- Category: L7 (dead subject)
- Evidence: `getForStep`, `getAll` and `clear` (src/api/response-store.ts:14,18,46) have no production caller. `grep -rn "getForStep\|\.getAll()" src runner-core/src steptix-vscode/src flick-vscode/src` returns nothing outside response-store.ts; the four `new ApiResponseStore()` sites (test-runner.ts:408, errand-runner.ts:648, session-manager.ts:3486, ui/main/runner-adapter.ts:588) only call `.add`, `.hasResponses` and `.formatForContext` (step-executor.ts:2509-2510, 4006-4007, 4236). runner-adapter resets with `this.apiResponseStore = null` (line 1621), not `.clear()`.
- Recommendation: delete these tests together with the three unused methods. "starts empty"/"stores a response" can stay but should assert via `hasResponses()` only.
- Confidence: high

### `tests/api-server-cdp.test.ts:638-650` + `:843` — "returns outcome: launched_into_new_profile" / "...existing_profile" / "reused_running_browser" / "launched_after_reset", "passes warnings through"
- Category: L1 + L3 (four label-only copies of a pass-through)
- Evidence: each sets `startCdpBrowserMock.mockResolvedValue(ok(outcome))` and asserts `expect(body.outcome).toBe(outcome)`. The route has no per-outcome logic: it copies `outcome: result.outcome, warnings: result.warnings` (src/server/api-server.ts:1951-1952). The four cases cannot exercise different branches; they assert the stub's value comes back.
- Recommendation: replace the five tests with one that asserts the whole 200 body with `toEqual` (outcome, warnings, binary, tabs, scope), the way "closes a tab and echoes what went" (line 859) already does for DELETE.
- Confidence: high

### `tests/api-server-cdp.test.ts:393` / `:1124` — "an authenticated request bumps the idle monitor" / "an authenticated focus bumps the idle monitor"
- Category: L3 (+ flaky, see Flakiness risks)
- Evidence: the bump is in the global auth middleware (`app.use(...)` → `idleMonitor.bump()`, src/server/api-server.ts:523-532), not in the CDP routes. tests/api-server.test.ts:1035 "does not bump the idle timer, while an authenticated request does" already proves an authenticated request bumps, deterministically on an injected clock.
- Recommendation: delete both.
- Confidence: high

### `tests/api-server-cdp.test.ts:1245` — "does not close anything, or create a session"
- Category: L2 (and name/claim mismatch)
- Evidence: the only assertion is `expect(closeCdpTabMock).not.toHaveBeenCalled();` after a focus. The focus route (src/server/api-server.ts:2104-2140) calls `readTabParams`, `cdpRoots`, `focusCdpTab` (mocked) and `statusForCdpFailure` — never `closeCdpTab` — so nothing could call it. The "or create a session" half of the name is not asserted at all.
- Recommendation: rewrite to assert what the name says, as the peek suite does at line 1341 ("creates no session": compare `GET /sessions` before/after) and line 1317 (`runsInFlight` unchanged), or delete.
- Confidence: high

### `tests/api-server-content.test.ts:663` — "a session that does not exist is still 404, not 409"
- Category: L3
- Evidence: `await api('GET', '/sessions/s-never-existed/content'); expect(status).toBe(404);` is the same route, same input class (an id never created) and same assertion as "returns 404 for an unknown session" at tests/api-server-content.test.ts:390 (`api('GET', '/sessions/nope/content')` → 404, plus it checks the message).
- Recommendation: delete; the 404-vs-409 contrast the name wants is already made by 390 sitting beside 643.
- Confidence: high

### `tests/failure-outcomes-runner.test.ts:424` — "shows a Tolerated stat on the report and no red banner"
- Category: L3 (spans two levels, each already covered)
- Evidence: `expect(html).toMatch(/badge badge-pass">✓ PASSED</); expect(html).toMatch(/stat-tolerated">1</);` on `renderReport(await runLoop(TOLERATED_DOC, { tolerate: 2 }))`. The loop half (`report.status === 'passed'`, `toleratedSteps === 1`) is asserted by the same file's first test (line 292-302); the render half (`<span class="number stat-tolerated">1</span>` for `toleratedSteps: 1`) is asserted by tests/report-failure-outcomes.test.ts:106, which also checks the absence case. `renderReport` reads only the report object, so nothing in the loop can change the render beyond those two fields.
- Recommendation: delete (or keep as the single loop→render smoke and drop nothing else — it is cheap; low priority).
- Confidence: medium

### `tests/api-server.test.ts:897` — "accepts env in request body without crashing"
- Category: L3 (superseded) / weak smoke
- Evidence: asserts only `expect(status).toBe(200); expect(body.status).toBe('passed');`, and its own comment says "here we just confirm the API surface accepts and runs the request". A server that dropped `env` from its allow-list would pass it. tests/api-server-run-settings.test.ts:568 ("is what syncAuth is called with, and beats AI_MODEL from env") and :671 ("AI_GATEWAY_URL ... reaches the AiClient a new session is built with") send `env` over the same real HTTP route and assert the values reach the AiClient.
- Recommendation: delete. Keep its sibling "does not leak env into server process.env" (909), which asserts something real.
- Confidence: high

### `tests/api-server-tools.test.ts:509` — "abort while parked awaiting debugger ack unwinds cleanly without hitting debugger;"
- Category: L2 (the key assertion cannot fail)
- Evidence: the test calls `ac.abort()` on the client's own fetch the moment it sees `tool:awaiting-debugger`; the next `reader.read()` rejects with AbortError, so no later event can ever be pushed to `events`. The tool cannot have run before that event (it is parked waiting for the ack), so `expect(events.filter((e) => e.type === 'capture')).toHaveLength(0)` holds whatever the server does after the abort — including running the tool and hitting `debugger;`, which is exactly what the name says must not happen. "Unwinds cleanly" is not checked either (no `runsInFlight`, no follow-up batch on the session).
- Recommendation: rewrite to observe the server, not the aborted stream: after the abort, wait for `GET /health` `runsInFlight === 0`, then assert `GET /sessions/:id` has no `echoed` output (or have the fixture tool write a marker file, as tests/api-server-use-ai.test.ts:314 does, and assert it is absent), and run one more batch on the session to show it unwound.
- Confidence: high

### `tests/api-server-viewport.test.ts:282` — "resolves the explicit form too"
- Category: L3
- Evidence: same seam and same assertion shape as "resolves a preset and launches with the exact fixedViewport" (line 274) — `config.viewport` → `resolveViewportSpec` → `launchBrowser(...).fixedViewport` — differing only in the input string `'767x1024'`. The parse of exactly that string is pinned at the pure level in tests/viewport-config.test.ts:57-60 (`expect(resolveViewportSpec('767x1024')).toEqual({ width: 767, height: 1024 })`).
- Recommendation: delete.
- Confidence: high

### `tests/api-server-viewport.test.ts:392` — "refuses an out-of-range size, naming it"
- Category: L3
- Evidence: same branch as "fails the batch with the §1 error and launches NOTHING" (line 381): `resolveViewportSpec` throws → 500 → `expect(launchBrowserMock).not.toHaveBeenCalled()`. The only extra is `toContain('50x50')`, which tests/viewport-config.test.ts:104-119 already pins for the same value ("says WHY a well-formed value was refused", `attemptError('50x50')`).
- Recommendation: delete, or fold into 381 as a second `it.each` row if the no-launch claim should be shown for both refusal kinds.
- Confidence: high

### Per-route 401 tests — `tests/api-server-cdp.test.ts:388` ("both routes require the api key"), `:855`, `:1120` ("requires the api key"), `:1540`, `:1886` ("is behind the api key"), `tests/api-server-run-settings.test.ts:1212` ("requires the api key")
- Category: L3
- Evidence: auth is one global `app.use` registered at src/server/api-server.ts:523-533, before every route except `/health` (472). Each test sends a keyless request and asserts 401, which tests/api-server.test.ts:305/314 already prove for that middleware; the `expect(launchBrowserMock).not.toHaveBeenCalled()` riders (1543, 1888) follow trivially from a 401. The only regression these could catch is a route registered above line 523, and they catch it only for these six routes.
- Recommendation: replace all six with one test in tests/api-server.test.ts that walks the app's registered routes (`app._router.stack`, or a list exported beside `createApiServer`) and asserts every route except `/health` answers 401 without a key — which also covers routes added later.
- Confidence: medium (the per-route form is a deliberate habit here; the replacement is strictly stronger)

## Test defects

### `tests/api-server-tools.test.ts:309` — "without toolsDir, [tool: ...] steps fall through to executeStep (legacy)"
- Category: Defect (claim not checked)
- Evidence: the only assertion is `expect(captures).toHaveLength(0)`. `sseEvents` never checks `res.ok`, so a 4xx/5xx JSON body yields zero events and passes; so does a step that failed outright. Nothing asserts that `executeStep` received the `[tool: echo ...]` line (the fall-through the name and src/server/session-manager.ts:6978-6989 describe) or that the run passed.
- Recommendation: assert `vi.mocked(executeStep)` was last called with `'[tool: echo value="should-fall-through"]'` and that the `done` event says `passed`.
- Confidence: high

### `tests/report-failure-outcomes.test.ts:29` — fixture `filePath: 'c:/proj/tests/outcomes.md'`
- Category: Defect (minor, policy)
- Evidence: a hard-coded Windows drive path, which CLAUDE.md's cross-platform rules forbid ("Never hard-code `C:\…`"). Harmless today — `renderReport` only echoes `report.filePath` (src/report/generator.ts:141) and no assertion reads it — but it is the pattern the rule exists to stop.
- Recommendation: `path.resolve(path.sep, 'proj', 'tests', 'outcomes.md')`.
- Confidence: high

### `tests/api-server.test.ts:375` — "resolves ${data.X} to the data-file value when envName is sent"
- Category: Defect (claim not checked)
- Evidence: asserts only `expect(status).toBe(200); expect(body.status).toBe('passed');`. `executeStep` is mocked to pass whatever instruction it gets, and the sibling test's own comment (line 360) says "If envName were dropped (the bug), the literal would pass through to the mock step and return 200." So this test passes whether or not `${data.url}` was resolved. The same gap applies to the `ok` half of "resolves test-level ${name.X} dataSources" (line 423-431), though its `miss` half carries that test.
- Recommendation: rewrite to assert `vi.mocked(executeStepMock).mock.calls.at(-1)[2] === 'Navigate to https://example.test/'` (the instruction actually reaching the executor).
- Confidence: high

## Duplication clusters

- **Failure outcomes, by level** — one good suite per level, no same-level repeats worth removing:
  parse `tests/failure-tail-parse.test.ts` (grammar table) → executor `tests/failure-tail-executor.test.ts` (real `executeStep`; `runCodeBehindEntry` itself is one level lower in tests/codebehind-failure-outcomes.test.ts:121-235) → CLI loop `tests/failure-outcomes-runner.test.ts` → session loop over HTTP `tests/api-server-failure-outcomes.test.ts` → errand loop over HTTP `tests/api-server-errands.test.ts:949-1073` → report `tests/report-failure-outcomes.test.ts` → client steptix-vscode/tests/failure-outcomes.test.js. The tolerated / deliberate / bare-`Fail` / decision-8 cases recur across the three LOOP suites, but each loop is its own code (`runTest`, session-manager, errand-runner), so they are parallel seam tests, not duplicates. Keep all. Drop only `failure-outcomes-runner.test.ts:424` (render half is report-failure-outcomes:106). Note `failure-outcomes-runner.test.ts:521` is a parser test living in the runner file (it goes through `parseTestFile`); it adds the section-body case that failure-tail-parse.test.ts:308-337 lacks, so move it there rather than delete it. Inside failure-tail-parse, three contradiction lines (REFUSE rows 143-145) and the six directive lines (146-151) assert `parseFailureTail(...) === null` again in 265-271 / 341-363 — harmless table repetition, leave it.
- **Global auth middleware, asserted per route**: `api-server.test.ts:305`, `:314` (keep), `api-server-cdp.test.ts:388`, `:855`, `:1120`, `:1540`, `:1886`, `api-server-run-settings.test.ts:1212` → keep 305/314 plus one route-walking test; drop the six per-route ones.
- **Idle bump on authenticated traffic**: `api-server.test.ts:1035` (injected clock — keep), `api-server-cdp.test.ts:393`, `:1124` (real clock, same middleware) → drop the two cdp ones.
- **`statusForCdpFailure` kind→status mapping**: `api-server-cdp.test.ts:780`, `:791`, `:802`, `:813` (POST, one test per kind), `:908` (DELETE, table of four), `:1189` (focus, same table of four). One shared function (api-server.ts:1940, 2067, 2121) with no direct unit test. Keep the DELETE table (or a direct table test of `statusForCdpFailure`); per route, one case proves the wiring — the POST tests also check `error`/`reason` pass-through, so keep 780/813 and fold 791/802 into the table; the focus table at 1189 can shrink to one case. Low priority.
- **CDP launch pass-through**: `api-server-cdp.test.ts:644` ×4 (for-loop) and `:843` → one `toEqual` on the whole body (see Low-value).
- **404 on unknown session for `/content`**: `api-server-content.test.ts:390` (keep), `:663` (drop).
- **Viewport resolver re-run over HTTP**: `api-server-viewport.test.ts:274` (keep) vs `:282` (drop; pure case at viewport-config.test.ts:57-60); `:381` (keep) vs `:392` (drop; pure case at viewport-config.test.ts:104-119).
- **Env reaching the AiClient**: `api-server.test.ts:897` (drop, smoke only) vs `api-server-run-settings.test.ts:568`, `:671` (keep).
- Checked and NOT duplicates: api-server-run-settings vs tests/run-settings.test.ts (seam vs pure resolver); api-server-cdp peek/navigate vs tests/mcp-cdp-seam.test.ts (route contract vs MCP mapping); api-server-errands vs tests/mcp-errands-*.test.ts (route vs MCP); api-server-use-ai `[use ai]` vs api-server-errands:841 (session loop vs errand loop); api-server-tools debugger ack vs tests/api-server-codebehind-debugger.test.ts (tool vs code-behind pause).

## Cost concerns

Nothing significant. The real costs are small and mostly tied to the flaky tests above: `api-server.test.ts:751` sleeps ~1.05 s; `api-server-cdp.test.ts:393`/`:1124` sleep 250 ms each and boot two extra servers; the 30 ms mock sleeps at cdp 949/971/999/1224 are cheap but are the flake mechanism. `api-server-tools.test.ts` esbuild-bundles a tool per hot-reload batch (needed: the reload is the subject). Every server suite boots one in-process express app on port 0 — appropriate for allow-list seams.

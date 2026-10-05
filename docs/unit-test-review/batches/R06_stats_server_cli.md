# R06_stats_server_cli

## Summary
- Files: 29 · tests (approx): 445 (it.each expanded: ~455) · High ~400 · Medium ~32 · Low 13 · Defects 1 (plus 3 name/claim mismatches folded into Low entries) · Flakiness risks 11 (1 high, 10 medium)
- Overall quality is high. The scoreboard is tested at five levels (classify/recorder/store pure units, run-stats wrapper, aggregate, CLI, and three real-executor seams: CLI runner, Sessions API, Runner UI). I looked for same-level repeats and found almost none: the seam tests each add a mask source, a stop path or a numbering rule that the unit tests can't reach. Two stats tests repeat another file at the same level: `reportAnchor` is a one-line wrapper re-tested with the exact cases of report-step-anchors.test.ts, and a loader check is repeated from stats-config.test.ts. stats-call-sites.test.ts is a real, non-vacuous source pin: a floor of found call sites guards the scan, the regex is checked against real `stats:` keys, and `bodyOf` fails loudly when it finds nothing.
- The low-value tests in the server/CLI files follow two patterns. First, assertions placed inside a mocked `executeStep` in session-manager.test.ts are swallowed: the manager catches the thrown AssertionError and turns it into an `error` result, so two tests can't fail. Second, there are tests whose names claim a case they never exercise (idle-monitor "next tick", server-project-root "outside the user root", cli-parameters-env "proves the overlay").
- Flakiness is concentrated in the stats files that measure real time: a 500 ms Playwright budget across six concurrent pages, a 2 s child-process rendezvous, a perf average, and two timer-bound flush tests. There is also one locale-dependent number in the API seam (`'9,325'` from an unlocalised `toLocaleString()`). Real I/O is otherwise well guarded: port 0 everywhere, mkdtemp roots, `process.env` restored, the user root always redirected, and appends flushed before `rmSync`.

## Flakiness risks

### `tests/stats-classify.test.ts:425` — "reproduces each headline outcome from what Playwright says today"
- Mechanism: six pages opened at once in one Chromium (`Promise.all`, line 426), each click/goto given `timeout: 500` (lines 416, 431, 457). The `blocked` and `ambiguous` verdicts need Playwright to have RESOLVED the element inside those 500 ms: `blocked` needs "locator resolved to … intercepts pointer events" in the call log, and strict mode only throws on resolution. If the first resolution (utility-script injection, CDP round trips) has not happened within 500 ms, the error is a bare "Timeout 500ms exceeded … waiting for locator(...)", which `classifyOutcome` reads as `no-match`, and lines 468/469 fail.
- Risk: high. vitest.config.ts itself notes that "while every worker is starting, a test that takes a second alone can take several", and this runs right after a cold `chromium.launch`.
- Fix: run the six probes sequentially, and before each click `await p.locator(sel).first().waitFor({ state: 'attached' })` so resolution is done before the budget starts. Raise the click budget to ~2-3 s for `#covered` (the blocked case has to spend the whole budget anyway); the strict-mode click fails immediately on resolution, so a larger budget costs nothing there.
- Evidence: reasoning from classify.ts (`RESOLVED`/`WAITED_ON_ELEMENT` decide no-match vs blocked/timeout); single-commit history (62a545c), so not yet seen on CI.

### `tests/stats-concurrency.test.ts:72` — "interleave only whole lines, and each process keeps its own order"
- Mechanism: wall-clock rendezvous. `const goAt = Date.now() + 2000;` (line 76) assumes four `node --import tsx` children all finish starting (tsx compiling store.ts on the fly) within 2 s. `expect(switches).toBeGreaterThanOrEqual(WORKERS * 10)` (line 96) then requires their 300 appends to have overlapped. Children that come up staggered after `goAt` each write their ~100-300 ms burst alone, and the switch count collapses toward 3.
- Risk: medium (needs uneven child start-up on a loaded runner, e.g. antivirus scanning the tsx cache on Windows)
- Fix: replace the clock with a barrier. Each child writes `ready` to stdout after its import and waits for a byte on stdin; the parent writes `go` to all four once every child is ready. Keep the switch check, which is then meaningful.
- Evidence: the test comment ("Measured … ~1190 switches in 1200 lines") is from one quiet machine; no history yet.

### `tests/stats-flush.test.ts:51` — "waits for the queue, but never longer than its bound"
- Mechanism: real 150 ms timer measured with `Date.now()`: `await flushRunStats(150); … expect(waited).toBeGreaterThanOrEqual(140)`. Node schedules a timer from libuv's cached loop time, which can lag `Date.now()` by however long the current macrotask has run, so the timer can fire more than 10 ms "early" by wall clock.
- Risk: medium
- Fix: `vi.useFakeTimers({ toFake: ['setTimeout','clearTimeout'] })`, start `flushRunStats(150)`, `await vi.advanceTimersByTimeAsync(149)` and assert it has not settled, advance 1 ms and assert it has.
- Evidence: reasoning (known Node behaviour; the 10 ms slack is the only margin).

### `tests/stats-flush.test.ts:96` — "a stalled append cannot hold it past the bound"
- Mechanism: real 2 s wait on the production `STATS_FLUSH_TIMEOUT_MS`, asserted as `waited >= 1950 && waited < 4000`, where `waited` also includes parsing and `runTestsUnflushed`.
- Risk: medium (the upper bound is the fragile side under load). It is also 2 s of wall clock in a unit suite.
- Fix: let `runTests` take the flush bound through its `options` seam (as `runTestFn` already does), or fake `setTimeout` and advance to the bound. Then assert the rejection arrives at the bound, not after a real 2 s.
- Evidence: reasoning.

### `tests/stats-run-stats.test.ts:347` — "a 20-step run: the recorder adds well under 5 ms a step, and no step waits on the disk"
- Mechanism: wall-clock performance assertion: `expect(average).toBeLessThan(5)` over 20 `performance.now()` samples, i.e. a 100 ms total budget. One GC pause or the worker being descheduled for ~100 ms on a contended runner fails it. The result also depends on order: run alone (`it.only`), the first call pays the uncached rules fingerprint and `frameworkVersion` (cached by the earlier tests at 144/130).
- Risk: medium
- Fix: keep the measurement and print it, but assert on the median (or on the minimum of 3 runs) against 5 ms, or assert a loose bound in the unit suite (e.g. 50 ms) and keep the 5 ms acceptance figure in a benchmark.
- Evidence: spec acceptance 8 asks for the measurement; reasoning.

### `tests/stats-api-seam.test.ts:388` (in "lines numbered as the report numbers them…", line 335)
- Mechanism: locale. `expect(html).toContain('9,325')` checks a number the report generator formats with `report.tokensUsed.toLocaleString()` and no locale argument (src/report/generator.ts:118). On a machine whose ICU default locale is not English it renders `9.325` (de) or `9 325` (fr) and the test fails. CI (windows-latest, en-US) passes.
- Risk: medium (developer machines)
- Fix: expect `(9325).toLocaleString()`, or (better) have the generator use the same fixed locale it already uses for the date (`'en-AU'`, generator.ts:111) or `'en-US'` as the stats CLI does (stats.ts:539).
- Evidence: src/report/generator.ts:118-120.

### `tests/stats-api-seam.test.ts:468` — "the stopped step's line says interrupted, its attempts are the ones that ran, and the run line counts no failure"
- Mechanism: polling loop with a fixed deadline. `waitForFinalizedRun` makes 200 tries with a 25 ms sleep each (lines 286-291), ~5 s plus round trips, for the server to see the client's abort (`res.on('close')`), reject the hanging gateway call, write the HTML report and finalise.
- Risk: medium (report generation plus abort propagation on a loaded Windows runner; a miss reads as "the run never finalized")
- Fix: poll on a total deadline well inside the 30 s test timeout (e.g. 20 s), or expose a finalised promise/event from the session manager for the test to await.
- Evidence: reasoning.

### `tests/session-manager.test.ts:1679` — "does not let per-session budgets SUM across sessions"
- Mechanism: real wall clock. `briefly` (mocked with a real `setTimeout` race, lines 94-95) waits the production `PAGE_READ_TIMEOUT_MS = 1_500` (src/server/session-manager.ts:1366), then `expect(elapsed).toBeLessThan(3_000)` (line 1696). That leaves only 1.5 s of slack between one budget and the bound.
- Risk: medium
- Fix: `vi.useFakeTimers()`, start the listing, `await vi.advanceTimersByTimeAsync(1_500)` once, and assert the promise has settled (sequential would need 4.5 s of fake time). Or inject a small budget.
- Evidence: comment at 1694 ("Generous bound so this is not a timing-flaky test") — the bound is 2x one budget, not a margin over load. The neighbouring 1656/1670 cost another 1.5 s each.

### `tests/cli-server-lifecycle.test.ts:43` (used by 147, 181, 378) — `deadUrl()`
- Mechanism: `const url = await startStub(() => {}); await stopStub(); return url;` binds an ephemeral port, releases it, and assumes nobody takes it before the probe. Another vitest worker (many in this suite bind port 0) can be handed the freed port, and `status`/`stop` then return 2 instead of 1.
- Risk: medium (Windows allocates ephemeral ports sequentially, so reuse within milliseconds under a parallel suite is plausible though rare)
- Fix: make "down" provable. Use a stub whose connection handler `socket.destroy()`s every connection (still classified `down`), or keep the listener and assert the transport failure through it.
- Evidence: reasoning.

### `tests/session-project-bundle.test.ts:140` and `:307` — "falls back to defaults when no steptix.config.json is found above the test file" / "falls back to the server startup config when there is no project root"
- Mechanism: environment dependence. A bare `mkdtemp(os.tmpdir())` is assumed to have no `steptix.config.json` in any ancestor up to the drive root, and this file does not redirect `LOCALAPPDATA`, so the user-root boundary does not stop the walk. On Windows the walk from `%TEMP%` passes `%LOCALAPPDATA%` and the home directory. A stray config there (the trap stories/mcp-no-project.md describes) or a `TMP` inside a project makes `projectRoot` non-null.
- Risk: medium (developer machines)
- Fix: point `LOCALAPPDATA`/`XDG_CONFIG_HOME` at the tmp dir and anchor the stray file under that user root, as tests/server-project-root.test.ts:26-30 does.
- Evidence: reasoning; the guarded pattern exists in the sibling file.

### `tests/build-info.test.ts:64-142` — the `scripts/build-info.mjs` block (5 tests)
- Mechanism: real `git init`/`git commit` in tmp repos that inherit the machine's global git config. `commit.gpgsign=false` and the identity are overridden (line 76), but a global `core.hooksPath` or `init.templateDir` hook (git-secrets, talisman, corporate pre-commit) runs on `git commit -q -m init` and can fail or prompt.
- Risk: medium (developer and corporate machines; clean CI is fine)
- Fix: add `-c core.hooksPath=<empty tmp dir>` (or `--no-verify` on commit) and `-c init.templateDir=` to the `git()` helper; set `GIT_CONFIG_GLOBAL` to an empty file for full isolation.
- Evidence: reasoning.

### Checked and guarded (no finding)
- idle-monitor.test.ts: fake clock plus `vi.useFakeTimers`, `vi.useRealTimers` in afterEach.
- health-probe-signal.test.ts: port 0, servers closed in afterEach; 20 ms abort vs a 30 s timeout with a 5 s bound; the port-1 case uses a pre-aborted signal, so there is no Windows connect-retry wait.
- cli-server-lifecycle.test.ts: port 0; `LOCALAPPDATA`/`XDG_CONFIG_HOME` redirected and restored; deferred closes target the right stub (comment 50-56 records an earlier race, already fixed); the 503 confirm loop (342) has a 3 s budget for a ~40 ms event, and probes have a 1 s timeout against a local stub.
- build-info / stats-fingerprint `dist/` tests depend on `pretest` having built `dist/` at HEAD. This is by design (CLAUDE.md); plain `npx vitest` on a stale `dist/` fails them.
- stats-store / stats-recorder / stats-run-stats / stats-computer-surface: per-test mkdtemp user root through `UserRootDeps`; `await flushStatsWrites()` before `rmSync` (avoids EBUSY on Windows); fixed dates.
- stats-cli: pinned `now` and `timeZone: 'UTC'`; numbers formatted with an explicit `'en-US'` (stats.ts:539); `process.exitCode` and env restored. The one real-clock test (798) writes its line 60 s before now and is month-boundary safe.
- stats-runner-seam / stats-ui-adapter-seam / stats-api-seam: env saved in beforeAll and restored in afterAll; the stats folder cleared after a flush in beforeEach; `process.chdir` restored in afterEach; API server on port 0; `openInBrowserAfterRun: false`.
- cli-parameters-env / server-project-root / session-project-bundle: `process.env` restored wholesale; mtime-invalidation tests bump mtime 5 s into the future with `utimesSync`.
- logger-stream / server-crash-guards: stream spies restored and the logger stream reset; a fake process target.
- stats-store:563 waits 20 ms for an unhandled rejection. That can only produce a false pass, never a false fail.

## Per-file verdicts
| File | Tests | Verdict (High/Medium/Mixed/Low) | One-line note |
|---|---|---|---|
| tests/build-info.test.ts | 14 | High | Real git repos exercise the stamp script's clean/modified/untracked/foreign-repo/no-repo branches; parse/describe are pure contract tests; the end-to-end `--version` catches pretest/stamp drift. Global git hooks can break it. |
| tests/cli-lazy-launch.test.ts | 8 | High (1 low) | Ordering asserted as a sequence, teardown after a failed goto, failed launch as a step row. "tears down cleanly" repeats line 205. |
| tests/cli-parameters-env.test.ts | 2 | Mixed | Test 1 is a good regression; test 2 never touches the overlay and duplicates parameters.test.ts:92. |
| tests/cli-server-lifecycle.test.ts | 23 | High | Real sockets on port 0 cover ok/down/foreign/legacy/non-JSON, key-leak refusal, 401/409/503, confirm loop. `deadUrl()` port-reuse race. |
| tests/cli-viewport.test.ts | 13 | High | Both seams (launch + executor config), no mutation, project-pin precedence, refusals before launch; CLI half of a CLI/server parity pair. |
| tests/health-probe-signal.test.ts | 4 | Medium-High | Pins the abort-folds-into-down contract server-start.ts relies on. |
| tests/idle-monitor.test.ts | 14 | High (2 low) | Fake clocks; the busy-pins-the-timer regression is valuable. One name claims a "next tick" behaviour the code does not have; `idleFor` with no window has no caller. |
| tests/logger-stream.test.ts | 4 | High | Guards stdout purity for MCP JSON-RPC across every logger method. |
| tests/server-crash-guards.test.ts | 4 | High (1 low) | "registers both guards" is subsumed by the two firing tests. |
| tests/server-project-root.test.ts | 4 | Mixed | Boundary tests 2-3 are high; test 4 is a copy of test 1 and never reaches the boundary it names. |
| tests/session-lazy-launch.test.ts | 17 | High (1 low, 1 defect) | Modelled deferred tracker; launch timing, failed launch as step 1 + retry, readers don't launch. One test swallows errors behind a stale comment; one is subsumed. |
| tests/session-manager.test.ts | 65 | High (3 low) | Real SessionManager logic with a mocked executor. Not L6: slicing, abort→aborted, capture events, outputSources, `__proto__` and last-run finalisation are the manager's own code. Two tests assert inside the mock where failures are swallowed. |
| tests/session-project-bundle.test.ts | 17 | High | Per-project isolation, mtime/absent-file invalidation, in-flight dedupe, cache not poisoned, ambiguousTarget per project both ways. Ancestor-config env dependence. |
| tests/stats-aggregate.test.ts | 42 | High (1 low) | Pure arithmetic on hand-built lines with a fixed clock: windows, filters, joins, ties, exec/hookIndex keys, links. `reportAnchor` block duplicates the anchors test. |
| tests/stats-api-seam.test.ts | 8 | High | Real HTTP route, executor, AI client and report: numbering, tokens, data rows, Stop, card:false, refusal. Locale-dependent `'9,325'`; a ~5 s polling deadline. |
| tests/stats-call-sites.test.ts | 5 (9 with each) | High | Real source pin: scans all of `src/`, floor counts prevent a vacuous pass, exactly-one-recorder and only-three-recorders checks. Minor looseness: any `stats:` text in the args (even a comment) passes. |
| tests/stats-classify.test.ts | 25 | High | Every §5.3/§5.4 row from verbatim Playwright text; the live-page block guards against Playwright rewording. Its 500 ms budgets make it the riskiest test in the batch. |
| tests/stats-cli.test.ts | 35 | High | Whole-output assertions, but the format is quoted in SPEC §1/§9 (contract); pinned clock/zone; every flag refusal; retention ordering. |
| tests/stats-computer-surface.test.ts | 3 | High | Stop/throw/verdict on the computer surface through the real `executeComputerStep` and the fake adapter. |
| tests/stats-concurrency.test.ts | 1 | High (flaky) | Acceptance 6 needs real processes; the 2 s clock rendezvous is the weak point. |
| tests/stats-config.test.ts | 3 (9 with each) | High | finding-5 regression: non-boolean switch refused at load, naming file and key. |
| tests/stats-fingerprint.test.ts | 7 | Medium-High | Cache-per-option-set, context excluded, option sensitivity. The first test re-derives the formula with the same calls (spec-format pin, near-tautological). |
| tests/stats-flush.test.ts | 5 | Mixed | finding-11 regressions (81, 96) are high, but 51/96 are timer-bound and 96 costs 2 s; 68 is a constant-equals-literal. |
| tests/stats-hook-text.test.ts | 3 | High | finding 9 at parse + resolve level (the runner-seam test covers the runner half). |
| tests/stats-recorder.test.ts | 33 | High | StepResult→lines: retries, tokens, masking, no typed values, rows, hooks, card, site/model precedence, outcomes by structure. |
| tests/stats-run-stats.test.ts | 21 | High | Identity, numbering across copies, tally, fail-closed project switch, adHocStats. Perf average is timing-bound. |
| tests/stats-runner-seam.test.ts | 24 | High | Acceptance 1/3/5/7/10/11 through the real CLI runner: hooks, While/If bodies, watch group, rows, stops, discarded calls. |
| tests/stats-store.test.ts | 40 | High (1 low) | Location, size limits, prefix-only reads, chunk boundaries/CRLF/BOM, field checks, retention, never-throw, settings. Loader test repeats stats-config. |
| tests/stats-ui-adapter-seam.test.ts | 1 | High | finding-1 regression: a section row secret masked in stats, report and panel events. |

## Low-value tests

### `tests/cli-lazy-launch.test.ts:215` — "tears down cleanly when nothing ever launched"
- Category: L3
- Evidence: same input as line 205 (`runTest(makeInstance([]), ...)`). It asserts `expect(report).toBeDefined()` (runTest always returns the report, and line 205 already awaited it without a throw) and `expect(closeBrowserMock).not.toHaveBeenCalled()`. Production teardown calls `browserTracker.closeAll()` when `initialSession?.cdp` is falsy (src/runner/test-runner.ts:2937-2942), and the mocked tracker's `closeAll` only calls `closeBrowserMock` when `session !== undefined` (test line 72). So "not called" mostly re-checks the stub's own guard.
- Recommendation: merge into `tests/cli-lazy-launch.test.ts:205` (add the `closeBrowserMock` line there) and delete.
- Confidence: medium

### `tests/cli-parameters-env.test.ts:52` — "an unset $VAR (in neither base nor overlay) stays unresolved — proves the overlay is what makes it resolve"
- Category: L3 (and name/claim mismatch)
- Evidence: no `.env` files and no `resolveEnvBundle` call: `resolveParameters({ token: '$STEPTIX_T2_ONLY_REGRESSION' }, undefined, false)` → `''`. That is tests/parameters.test.ts:92 (`$NONEXISTENT_VAR_XYZ` → `''`) again. It proves nothing about the overlay.
- Recommendation: rewrite as the real control. Write the same `.env`/`.env.t2`, call `resolveEnvBundle` with no env selected (or a different one), and expect `$T2_ONLY` → `''`. Otherwise delete.
- Confidence: high

### `tests/idle-monitor.test.ts:145` — "fires on the next tick once the run ends inside the window"
- Category: L3 (plus name/claim mismatch)
- Evidence: `advance(30 * 60_000)` busy, then `state.busy = false; advance(61 * 60_000); expect(state.expired).toBe(1)`. The `advance` helper sets `now += ms` BEFORE `vi.advanceTimersByTime(ms)` (lines 100-103), so every tick of the second advance already sees +61 min. Production bumps the monitor on every busy tick (`if (isBusy()) { monitor.bump(); return; }`), so a run that ends inside the window gets a full fresh window and does NOT fire on the next tick. The test passes either way. It is the scenario of line 130 ("restarts the full window when a long run finishes") minus that test's 59-min negative check.
- Recommendation: delete, or rename it to "a run shorter than the window also restarts it" and add the `advance(59 min) → 0` check, which makes it a distinct short-run case.
- Confidence: high

### `tests/idle-monitor.test.ts:69` — "idleFor() is unaffected by the configured window"
- Category: L5/L7
- Evidence: `new IdleMonitor(null, clock.now); clock.advance(5_000); expect(monitor.idleFor()).toBe(5_000)`. `idleFor()` has no production caller outside `isExpired()` (grep `idleFor` in src/: only src/server/idle-monitor.ts:41 and :52), and `isExpired()` returns before calling it when the window is null. The subtraction itself is already pinned by line 60.
- Recommendation: delete.
- Confidence: high

### `tests/server-crash-guards.test.ts:49` — "registers both guards"
- Category: L3
- Evidence: `expect(proc.registered()).toEqual(expect.arrayContaining(['unhandledRejection', 'uncaughtException']))`. Tests 57 and 77 fire each event through the same fake and assert the logged line. With a guard unregistered, `handlers.get(event)?.(reason)` does nothing and their `lines.find`/`lines.some` assertions fail.
- Recommendation: delete.
- Confidence: high

### `tests/server-project-root.test.ts:71` — "a file outside the user root never triggers the boundary"
- Category: L3 (and name/claim mismatch)
- Evidence: the fixture is `elsewhere/steptix.config.json` + `elsewhere/deep/x.md` → `elsewhere`, the same structure as test 1 at line 45 (`proj/steptix.config.json` + `proj/tests/x.md`). The marker is found one level up, before the walk gets near the user root, so a boundary that misfired for non-user-root paths would still pass. Examples: a `startsWith(userRoot)` prefix check, or a boundary firing at `%LOCALAPPDATA%` itself.
- Recommendation: rewrite so the boundary could misfire. Marker in `%LOCALAPPDATA%` (the tmp), file in a sibling whose name has the user root as a string prefix (`<tmp>/steptix-other/x.md`), expect `<tmp>`.
- Confidence: high

### `tests/session-lazy-launch.test.ts:291` — "does not navigate to baseUrl at creation"
- Category: L3
- Evidence: `executeSteps('s-baseurl-create', { steps: [], config: { baseUrl } }); expect(mockPage.goto).not.toHaveBeenCalled()`. The test at line 329 starts with the identical batch and assertion (lines 330-334) before checking the navigation at launch.
- Recommendation: delete (fully subsumed by `:329`).
- Confidence: high

### `tests/session-manager.test.ts:553` — "parameters from request override accumulated outputs"
- Category: L2
- Evidence: the only assertion is inside the mocked executor: `expect(opts.resolvedParameters!['myVar']).toBe('override-value');` (line 576). If it fails, the AssertionError rejects `executeStep`. SessionManager catches that as "Unexpected error during step execution" and returns `status: 'error'` (src/server/session-manager.ts:7452-7498; the test at line 1546 shows this). The test never checks the response, so a broken override passes.
- Recommendation: rewrite. Capture `opts.resolvedParameters.myVar` into a variable inside the mock, then assert it, `response.status === 'passed'` and `response.outputs.myVar` after the call.
- Confidence: high

### `tests/session-manager.test.ts:1353` — "handles steps with no output prefixes"
- Category: L2
- Evidence: the inner assertion `expect(instruction).toBe('Click the login button')` (line 1356) is swallowed the same way, and the error path pushes `outputs: {}` (session-manager.ts:7475). The only outer assertion, `expect(response.results[0]!.outputs).toEqual({})`, therefore passes whether or not the instruction was passed through unchanged. (The neighbouring tests at 1303 and 1328 are safe only by accident: their outer `outputs` assertions depend on values set after the inner expect.)
- Recommendation: rewrite. Record the instruction in the mock, assert it outside, and assert `response.status === 'passed'`.
- Confidence: high

### `tests/session-manager.test.ts:404` — "returns proper StepResponse structure"
- Category: L5/L3
- Evidence: twelve `toHaveProperty` checks on keys of the typed `StepResponse`/result, which TypeScript already enforces on the producing object. The input is the same as line 393. The only real facts checked are `response.error` being null and one result.
- Recommendation: merge `expect(response.error).toBeNull()` and `toHaveLength(1)` into line 393 and delete.
- Confidence: medium

### `tests/stats-aggregate.test.ts:665` — "step-N, row-R-step-N in a data-row report, and a hook step by scope and place"
- Category: L3/L5
- Evidence: `reportAnchor` is `export function reportAnchor(at) { return stepAnchor(at); }` (src/stats/aggregate.ts:733-735). The five assertions are the same inputs and outputs as tests/report-step-anchors.test.ts:40-44 (`step-11`, `row-3-step-11`, `hook-beforeEach-2-step-5`, `row-3-hook-before-1-step-0`, `hook-before-step-0`). The link entries in the `--failures` tests (lines 405, 550, 818) already prove aggregate uses the anchor.
- Recommendation: delete.
- Confidence: high

### `tests/stats-flush.test.ts:68` — "bounds `steptix run` at two seconds by default"
- Category: L5/L4
- Evidence: `expect(STATS_FLUSH_TIMEOUT_MS).toBe(2_000)`, a constant equal to its literal. The value is not documented in SPEC-scoreboard.md or the docs (grep). The behaviour (bounded at the constant) is tested at line 96 relative to the constant.
- Recommendation: delete.
- Confidence: high

### `tests/stats-store.test.ts:693` — "rides through the loader, so the run can hand it to statsSettings"
- Category: L3
- Evidence: asserts `loadConfig(off).stats` → `{ enabled: false }` and `loadConfig(plain).stats` → `undefined`, which are the first and last cases of tests/stats-config.test.ts:29-34. The extra step (`statsSettings({ projectEnabled: offConfig.stats?.enabled })`) is the `projectEnabled` path already covered at stats-store.test.ts:639. It differs only in calling `loadConfig(path)` rather than `loadConfig(undefined, dir)`.
- Recommendation: merge the explicit-path call into stats-config.test.ts:29 as one more `expect`, and delete.
- Confidence: medium

## Test defects

### `tests/session-lazy-launch.test.ts:346` — "does not launch when the surface is computer at the first step" (also `:361`)
- Category: Defect (swallowed failure, stale comment)
- Evidence: `await manager.executeSteps(...).catch(() => { /* the step itself has no computer executor yet */ });`. The comment is stale. Computer mode exists, and with no `desktop.enabled` the step boundary fails the step with `COMPUTER_DISABLED_MESSAGE` and returns normally, without throwing (src/server/session-manager.ts ~6515-6545). The `.catch` now only hides an unexpected rejection: a regression that rejects the batch before the step loop still passes, because "no launch" is all that is asserted.
- Recommendation: drop the `.catch` and assert the result (`results[0].status === 'failed'`, reasoning naming computer mode), so the test proves the step ran on the computer surface.
- Confidence: high

(The name/claim mismatches at cli-parameters-env.test.ts:52, idle-monitor.test.ts:145 and server-project-root.test.ts:71 are listed under Low above.)

## Duplication clusters
- No-launch teardown: `tests/cli-lazy-launch.test.ts:205`, `:215` → keep 205 and fold in 215's assert.
- Unresolved `$VAR` → `''`: `tests/parameters.test.ts:92`, `tests/cli-parameters-env.test.ts:52` → keep parameters.test.ts; rewrite 52 as an overlay control.
- Busy run then idle: `tests/idle-monitor.test.ts:130`, `:145` → keep 130.
- Marker one level up: `tests/server-project-root.test.ts:45`, `:71` → keep 45, rewrite 71.
- Guard registration: `tests/server-crash-guards.test.ts:49` is subsumed by `:57`/`:77`.
- baseUrl not visited at creation: `tests/session-lazy-launch.test.ts:291` is subsumed by `:329`.
- Step anchors: `tests/report-step-anchors.test.ts:39`, `tests/stats-aggregate.test.ts:665` → keep the anchors test.
- Loader `stats` section: `tests/stats-config.test.ts:29`, `tests/stats-store.test.ts:693` → keep stats-config.
- Optional tidy, not low: three session-manager tests run the same single `[output: orderId]` fixture for different facets (`:951` capture event, `:1303` rewrite + outputs, `:1451` outputSources); they could share one run.
- Checked and NOT duplicates (different levels, or the CLI/server parity idiom): masking (recorder:319 → run-stats:144 merge of mask sets → runner-seam:706 secret parameter → ui-adapter-seam section row); exec numbering (run-stats:185 → runner-seam:1011 ↔ api-seam:575); off switches (store:624/639 → run-stats:113 → runner-seam:732/745 ↔ api-seam:406); no-call steps (recorder:602/700 → run-stats:206 → runner-seam:920-988 ↔ api-seam:554); retention (store:492-553 pure → cli:692-735 command ordering).

## Cost concerns
- `tests/stats-classify.test.ts:377-474`: a real Chromium launch plus a hanging HTTP server. The purpose (catch Playwright rewording) justifies it, but see the 500 ms flake above.
- `tests/stats-concurrency.test.ts:72`: four `node --import tsx` children plus a fixed 2 s wait. Required by acceptance 6, but the 2 s clock both costs time and causes the flake.
- `tests/stats-flush.test.ts:96`: 2 s of real waiting for a bound that fake timers could check instantly.
- `tests/session-manager.test.ts:1656`, `:1670`, `:1679`: each waits the real 1.5 s `PAGE_READ_TIMEOUT_MS` (~4.5 s serial).
- The seam suites (stats-runner-seam, stats-api-seam, stats-ui-adapter-seam) run the real executor, AI client and report generator. That is the spec's "at the seam" requirement and they are not redundant with the units, so no change is recommended.

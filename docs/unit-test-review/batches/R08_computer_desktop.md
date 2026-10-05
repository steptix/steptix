# R08_computer_desktop

## Summary
- Files: 22 · tests (approx): ~540 declared (~650 cases with `it.each`) · High ~455 · Medium ~70 · Low 15 (in 10 findings) · Defects 2 · Flakiness risks 9 (all medium, ~15 tests; 0 high)
- This batch is strong. The computer-mode suites fake the desktop adapter, but they test the executor's, the loop's and the two runners' DECISIONS against it (mapping, settle, refusals, stall, repeat-net, lock lifecycle, surface state machine). They don't just replay what the fake returns, so L6/L1 is almost absent. The one real L1 is a test of the fake itself (`desktop-adapter.test.ts:264`). The fake is pinned to the measured §14 clipping data, and the libnut emulation is pinned to the installed libnut source. Both stop the fakes drifting from reality.
- Low value is mostly small duplication: density/zoom mapping re-asserted at three levels, the shared `extractJson` re-tested through the computer parser, a duplicated `desktop.enabled:false` case, a duplicated §15.4 judge case, and default-constant tests. One three-sentence error message is pinned byte for byte.
- Platform policy is well handled. Platform-specific behaviour (cmd→win swap, per-OS helpers, load/capture messages) takes a `platform` parameter and is tested for win32/darwin/linux from any host. The one win32-only adapter test is `it.runIf`-gated, and its counterparts sit at `desktop-keys.test.ts:130`. The key table is tested via `it.each` and an enum-drift guard, not longhand.
- Flakiness: nothing touches the real screen or the real `os.tmpdir()/steptix-computer.lock`. Every lock test, runner and server is pointed at a per-test `mkdtemp` lock, and the server uses port 0. The risks are all wall-clock: elapsed-time bounds after a real `setTimeout` abort (computer-step:1086, computer-conditions:418/438, vision-route:280), a real-clock deadline (executor:452), and the computer-step wait-budget block, which charges real elapsed time against 200–300 ms budgets and then asserts exact turn counts. Then real Chromium: video finalize/rename on Windows, a CDP port TOCTOU, and a 20 s race wait.

## Flakiness risks

Checked and well-guarded (not flagged): `desktop-lock` puts every lock file in its own `mkdtempSync` dir and never writes `os.tmpdir()/steptix-computer.lock` (`computerLockPath()` is only computed, `:131`); `desktop-stall`, `desktop-keys`, `desktop-capture` (jimp on synthetic grabs — no real screen) are pure; `desktop-bring-to-front` injects `sleep`; `desktop-executor` uses a virtual clock everywhere but one test; `desktop-nut-keyboard` mocks nut.js wholesale and reads the installed libnut source read-only; `desktop-adapter` mocks `node:child_process`; `video-config`/`desktop-config` use `mkdtemp` and only read tracked files; `desktop-vision-route :304` uses fake timers with a `finally` restore.

### `tests/desktop-executor.test.ts:452` — "wait_window looks at most once per poll interval, even when a sleep returns early (A5)"
- Mechanism: real wall clock against a 100 ms deadline — `{ ...harness.context, now: Date.now, sleep: async () => {} }` with `timeoutMs: 100`, asserting `callsOf('windows')).toHaveLength(2)`. executor.ts:276 returns as soon as `now() >= deadline || look >= maxLooks`; if the worker stalls ≥100 ms between computing the deadline (executor.ts:250) and look 1's check (GC pause, CPU starvation with every worker starting), the loop exits after ONE look and the test fails.
- Risk: medium
- Fix: keep the clock frozen (`now: () => 0`) — the point of the test is that the look COUNT bounds the loop when `sleep` returns early, which a frozen clock proves deterministically (it also isolates the count bound from the deadline bound, which the real clock muddles).
- Evidence: reasoning from executor.ts:250-287; the rest of the file deliberately injects a virtual clock (header lines 13-15).

### `tests/desktop-vision-route.test.ts:280` — "a timeout proceeds, and aborts the request"
- Mechanism: real 30 ms timer plus an elapsed-time assertion — `const started = Date.now(); … expect(Date.now() - started).toBeLessThan(2_000);`
- Risk: medium (needs a >2 s stall of the worker, which commit 518069b measured happening while every worker starts: "a test that takes a second alone can take several")
- Fix: use `vi.useFakeTimers()` + `advanceTimersByTimeAsync(30)` and assert the promise settled (as `:304` already does for the default), and drop the elapsed check.
- Evidence: commit 518069b "Budget tests and hooks for the whole suite running at once".

### `tests/dialog-guard.test.ts:360` — "guards a CDP-attached context"
- Mechanism: port TOCTOU — `const port = await freePort();` (listen on 0, read, CLOSE) then `chromium.launch({ args: [\`--remote-debugging-port=${port}\`] })`. Between the close and Chromium binding, any other parallel worker (many root suites start servers/browsers) can take the port; Chromium then fails to bind or `launchBrowser(BROWSER_CONFIG, { port, tab: 'new' })` attaches to the wrong process.
- Risk: medium
- Fix: launch with `--remote-debugging-port=0` and read the bound port back from `DevToolsActivePort` in the browser's user-data-dir (what the product's own CDP launcher does — see CLAUDE.md "CDP browsers"), or retry the launch on bind failure.
- Evidence: reasoning; the product's own CDP launcher already passes `--remote-debugging-port=0` and reads `DevToolsActivePort` (CLAUDE.md, src/browser/cdp-registry.ts).

### `tests/dialog-guard.test.ts:287` — "survives a cross-origin iframe torn down while its own dialog is open"
- Mechanism: real Chromium + a timing race by design — `await waitUntil(() => dialogsHandled() > 0, 20_000);` then a fixed `await new Promise((r) => setTimeout(r, 3_000));`, then `expect(dialogsHandled()).toBeGreaterThan(0)`. On a loaded box the OOPIF may not raise a dialog within 20 s. Also `capture.stop()` (`:332`) is not in a `finally`, so a throw from `page.goto` leaves a process-global `addLogCallback` attached for the rest of the file.
- Risk: medium
- Fix: move `capture.stop()` and `context.close()` into `finally`; see also the defect entry — the race this exists for is hit only sometimes, so it is a probabilistic detector as well as a probabilistic failure.
- Evidence: commit 518069b raised this file's `afterAll` budget from 20 s to 60 s because Chromium close took ~27 s under load.

### `tests/video-recording.test.ts:55`, `:101`, `:122` — the three recording cases
- Mechanism: real Chromium with `recordVideo`; `finalizeMainPageVideo` closes the context (which flushes the .webm through Playwright's ffmpeg) then `fs.rename`s / `fs.rm`s it (manager.ts:1858-1873). On Windows a just-closed .webm can still be held (ffmpeg exit, Defender scan) → `rename` fails → finalize logs a WARN and returns `undefined` → `expect(saved).toBeDefined()` fails. Each test's own `await fsp.rm(videoDir, …)` is in the test body (not `afterEach`) and would itself throw EBUSY in the same situation. Context close under suite-wide load is the slow step 518069b measured (~27 s), against a 30 s test budget.
- Risk: medium
- Fix: move cleanup to `afterEach` with `fs.rm(..., { maxRetries: 5, retryDelay: 100 })`; consider retrying the rename in `finalizeMainPageVideo` on EBUSY/EPERM (product fix, since the same race hits real runs); give these tests an explicit 60 s budget.
- Evidence: reasoning + commit 518069b.

### `tests/computer-step.test.ts:1296`, `:1385`, `:1413` (and, with more slack, `:1323`) — the D2 wait-budget block: "an endless wait is ended by the wait budget…", "fails the step once wait_window has spent the wait budget, naming it", "counts plain waits against the same budget"
- Mechanism: the budget is charged in WALL-CLOCK time — `waits.spentMs += Date.now() - subStartTime;` (src/runner/computer-step.ts, after `executeComputerAction`) — and the loop's sleeps are real `setTimeout`s (no `sleep`/`now` seam on `ComputerStepOptions`). The assertions assume the timers fire close to on time, with ~100 ms of slack:
  - `:1413` waits 0.2 s, 0.21 s, 0.22 s against `waitBudgetMs: 300` and asserts `expect(sent).toHaveLength(3)`. If the first 200 ms timer lands ≥100 ms late, turn 2 already finds `remaining <= 0`, the step fails on turn 2, and `sent` is 2.
  - `:1385` wait_window 200 ms then 201 ms against 300 ms, asserting `toContain('Timed out')`. If turn 1 overspends by ≥100 ms, turn 2 is refused before it runs and the error is `waitBudgetMessage(budget, spent)` with no `last` — no "Timed out".
  - `:1296` `wait 0.05 s` against `waitBudgetMs: 200`, asserting `expect(sent.length).toBeGreaterThan(3)`; if the first two 50 ms timers each land ~50 ms late (s1 + s2 ≥ 200), turn 3 is refused and `sent.length` is 3.
- Risk: medium (needs a worker stalled ~50–100 ms during a timer — the condition 518069b documents for suite start-up; Windows' default 15.6 ms timer granularity eats part of the slack too)
- Fix: give `ComputerStepOptions.computer` the same injectable `sleep`/`now` that `executeComputerAction` already takes (desktop-executor.test.ts drives those with a virtual clock) and run this block on it. Failing that, stop asserting exact turn counts: assert the error names the wait budget and that the stall rule did not fire, and keep each wait ≤ budget/10.
- Evidence: reasoning from the accounting code; no history of fixes yet (file history is feature commits only).

### `tests/computer-step.test.ts:1086` — "ends a wait_window promptly, without spinning on the window list"
- Mechanism: real abort timer + elapsed bound — `setTimeout(() => controller.abort(), 100); const started = Date.now(); … expect(Date.now() - started).toBeLessThan(900);`. The measured span includes a real jimp PNG encode of an 800×600 grab plus the abort timer's own lateness.
- Risk: medium
- Fix: abort from inside the scripted model's response or the adapter's first `windows()` call (deterministic "Stop pressed during the wait"), and assert on `callsOf('windows').length` and the error only; the `≤ 3` look count already proves no spin.
- Evidence: reasoning; the original defect (millions of `windows()` calls) is fully caught by the look-count assertion, so the elapsed check adds only flake surface.

### `tests/computer-conditions.test.ts:418` and `:438` — "a Stop during the 3 s wait after a `waiting` answer ends the judge promptly", "the page surface gives way too…"
- Mechanism: `setTimeout(() => controller.abort(), 100); const started = Date.now(); … expect(Date.now() - started).toBeLessThan(1500);` — real timer against a wall-clock bound; the computer variant also includes a real `captureView` (jimp) in the measured span.
- Risk: medium
- Fix: `vi.useFakeTimers({ toFake: ['setTimeout'] })`, `advanceTimersByTimeAsync(100)`, and assert the promise rejected before advancing the remaining 2.9 s of `CONDITION_JUDGE_POLL_MS`; or abort from inside the scripted client after its first response and assert only that a single request was made.
- Evidence: reasoning; same budget concern as 518069b.

### `tests/video-config.test.ts:41` — "defaults to 'off' when unspecified"
- Mechanism: environment dependence, not timing — `const config = await loadConfig();` with no path reads `steptix.config.json` from `process.cwd()`, i.e. the repo root's tracked config. The test passes only while that file sets no `browser.video`.
- Risk: medium (a developer enabling video in the root config for a local run turns this red)
- Fix: `loadConfig(undefined, <mkdtemp dir>)` as `tests/desktop-config.test.ts:65-69` does.
- Evidence: src/config/loader.ts:54-59 ("otherwise we look for `steptix.config.json` in the cwd").

## Per-file verdicts
| File | Tests | Verdict (High/Medium/Mixed/Low) | One-line note |
|---|---|---|---|
| video-config.test.ts | 8 | Medium | Loader pass-through + generated-schema shape; schema half is the more valuable. |
| video-mode.test.ts | 8 | High | Pure fn; typo fail-safe and CDP-ignored listing are real contracts. |
| video-recording.test.ts | 4 | High (cost noted) | Real Playwright recording; only way to check rename/delete after close. Header comment says `saveAs` but code now renames. |
| video-report-render.test.ts | 2 | Medium | Present/absent `<video>` block. |
| desktop-stall.test.ts | 10 | High | Both halves of the AND tested separately; raw-ignoring fingerprint. |
| desktop-lock.test.ts | 14 | High | Live/dead/same-pid-other-session/truncated file; one weak sub-claim (see defects). |
| desktop-keys.test.ts | ~60 (it.each) | High | Grammar, aliases, refusals, nut.js enum drift guard, win32 cmd swap tested via platform param. |
| desktop-nut-keyboard.test.ts | ~25 (it.each) | High | libnut emulation pinned to installed libnut source; reproduces measured stuck-key bug; win32 case correctly `runIf`. |
| desktop-capture.test.ts | 18 | High | mapToScreen table incl. the zoom-consistency case; PNG IHDR read back. Two trivial tests. |
| desktop-bring-to-front.test.ts | 20 | High | Policy vs a clipping fake with injected sleep; every fallback branch and boundary. |
| desktop-config.test.ts | ~24 | Mixed→High | Typed-at-load refusals and init-scaffold isolation are high; three default-constant tests overlap each other. |
| desktop-action-parser.test.ts | ~75 (it.each) | High | Refusal table is the core; vocabulary-completeness check; envelope block re-tests the shared `extractJson`. |
| desktop-adapter.test.ts | 33 | Mixed (mostly High) | Load-failure messages per OS, lazy-import source pins, per-OS helper commands. A few tests exercise only the test fake itself. |
| desktop-executor.test.ts | ~38 | High | Virtual clock throughout; mapping, settle rules, focus/wait_window outcomes, Stop. One real-clock test; one seam duplicate. |
| desktop-prompt.test.ts | 29 | Medium | Prompt-rule presence per §5.7; vocabulary-taught check is high. Some long exact sentences pinned. |
| desktop-vision-route.test.ts | ~32 | High | §15.4 decision table vs fake fetch; 400-backstop recogniser. One real-timer elapsed assertion. |
| dialog-guard.test.ts | 11 | High (cost noted) | Fake-based disposition/catch + real-browser race + both launch paths. Real-browser race is probabilistic; CDP test has a port TOCTOU. |
| computer-conditions.test.ts | 14 | High | §5.6 judge from the screen with no DOM, short request, masking, privacy switch, Stop between polls. Two real-clock elapsed checks; one duplicate with computer-step. |
| computer-step.test.ts | ~78 | High | The turn loop end-to-end against the fake adapter: A1–A7/D2 regressions, repeat-net, retry-after-input, §15.4 backstop. Wait-budget block runs on the real clock with thin margins. |
| api-server-computer-run-start.test.ts | 17 | High | Real HTTP entry + real project bundle; runStart surface rules incl. section/skill/control look-through. Mock wall is around the loop, the decisions are real — not L6. Port 0, temp lock. |
| computer-mode-cli.test.ts | 33 | High | CLI half of the mode state machine; lock release on every ending, pauses, rows, skill restore; SkillSurfaceStack unit cases. Parity with the session suite is intentional. |
| computer-mode-session.test.ts | ~66 | High | Session half: preconditions order, lock only while running, pauses release, project-not-server config, tool/skill lock rules. One exact duplicate. Pause resumes are correctly sequenced (emit then park is synchronous). |

## Low-value tests

### `tests/desktop-capture.test.ts:161` — "defaults the cap to 1600 (§5.10)"
- Category: L5 (constant equal to its literal)
- Evidence: `expect(DEFAULT_MAX_IMAGE_WIDTH).toBe(1600);` — `src/desktop/capture.ts:29` is `export const DEFAULT_MAX_IMAGE_WIDTH = 1600;`. The same 1600 is pinned again for the config default at `tests/desktop-config.test.ts:47-52`. What could actually drift is the two separate constants disagreeing (executor.ts:170 and computer-step.ts:711 fall back to `DEFAULT_MAX_IMAGE_WIDTH` when config is absent; config defaults use `DEFAULT_CONFIG.desktop.maxImageWidth`).
- Recommendation: rewrite to `expect(DEFAULT_MAX_IMAGE_WIDTH).toBe(DEFAULT_CONFIG.desktop.maxImageWidth)` (parity), or delete.
- Confidence: high

### `tests/desktop-capture.test.ts:246` — "viewSourceRect is the whole grab for a full view"
- Category: L3 (covered by the mapToScreen table)
- Evidence: `viewSourceRect` is `view.region ?? { x: 0, y: 0, width: view.grab.width, height: view.grab.height }` (capture.ts:61-63). Every full-view `mapToScreen` case (lines 59-115) goes through that default branch and would give wrong coordinates if it regressed; the zoom cases cover the `region` branch. No production caller outside capture.ts (only a re-export in `src/desktop/index.ts:47`).
- Recommendation: delete.
- Confidence: medium

### `tests/desktop-config.test.ts:55` — "is OFF by default — a shared project must opt in (§5.1 item 1)"
- Category: L3
- Evidence: `expect(DEFAULT_CONFIG.desktop.enabled).toBe(false);` is a strict subset of the test directly above (`tests/desktop-config.test.ts:46`, `toEqual({ enabled: false, ... })`), and the loader-level version is at `:65-69` and `:180`.
- Recommendation: delete (or fold the "must opt in" rationale into the :46 test's comment).
- Confidence: high

### `tests/desktop-config.test.ts:59` — "ships no launchArgs — the launcher's own flags are the whole list"
- Category: L3
- Evidence: `expect(DEFAULT_CONFIG.browser.launchArgs).toBeUndefined();` — the same fact is asserted end-to-end through the real loader on a freshly `init`-ed project at `tests/desktop-config.test.ts:181` (`expect(config.browser.launchArgs).toBeUndefined()`), which would fail if the default gained launchArgs.
- Recommendation: delete.
- Confidence: medium

### `tests/desktop-action-parser.test.ts:420`, `:426`, `:434`, `:444` — envelope cases "strips a markdown code fence", "takes the FIRST JSON value…", "ignores prose before the JSON", "throws when the response holds no JSON at all"
- Category: L3 (one finding, four cases)
- Evidence: `parseComputerActions` calls the page parser's `extractJson` (`src/desktop/action-parser.ts:26,557`), and those exact branches are already unit-tested at `tests/action-parser.test.ts:15` (fence), `:40` (first of two values), `:25` (surrounding prose), `:31` (no JSON). The computer-specific envelope logic is the plural-key/bare-array/single-object branching at action-parser.ts:573-589, which `:408`, `:412`, `:416`, `:452` already cover.
- Recommendation: keep one seam case (e.g. `:426`, which is the one that matters for a click) and delete the other three.
- Confidence: medium

### `tests/desktop-adapter.test.ts:203`, `:222`, `:264` — FakeDesktopAdapter "records every call…", "grabs a buffer of exactly width × height × 4 bytes", "can be made to fail a grab"
- Category: L1 / L7 (tests of a test-only fake)
- Evidence: `FakeDesktopAdapter` has no production caller (grep `FakeDesktopAdapter` in `src/` finds only comments in adapter.ts:8 and test-runner.ts:361). `:264` is pure L1 — `grabError: new Error('Failed to capture screen')` → `rejects.toThrow('Failed to capture screen')`, which is `if (this.grabError) throw this.grabError;` (fake-adapter.ts:261). `:203` asserts the recorder records what it was given; every consuming suite's `callsOf(...)` assertions (desktop-executor, bring-to-front, computer-step, …) already fail if it didn't. `:222` is covered by desktop-capture, whose `viewFromGrab` throws `…RGBA needs…` on a wrong-length buffer. Keep the clipping/geometry block (`:270-363`) — it pins the fake to §14's measured data, which the policy tests depend on.
- Recommendation: delete the three; keep the rest of the fake's block.
- Confidence: medium

### `tests/desktop-executor.test.ts:112` — "halves the point again at density 2"
- Category: L3
- Evidence: Same inputs and expected point as `tests/desktop-capture.test.ts:86` ("both together: downscale THEN density": 3440×1440 grab, scale 2, image 1600×670, point (800,335) → (860,360)). The executor's case 'click' only calls `mapToScreen` (executor.ts:103), and the seam that it does so is already proved by `:75`. §13 item 3 asks for "with and without downscale, and after a zoom" — density is not one of those.
- Recommendation: delete.
- Confidence: medium

### `tests/computer-step.test.ts:1619` — "the §5.6 condition judge fails the same way: the bridge's message, one call"
- Category: L3
- Evidence: Same call, same input class, same level as `tests/computer-conditions.test.ts:322` ("keeps the unretryable rethrow when the model rejects the image (§15.4)"): `evaluateConditions([...], <computer opts with FakeDesktopAdapter>)` with a client that throws the bridge's `BadRequestError`, asserting `rejects.toThrow(message)` and `retryable: false`. computer-step's version adds only `expect(calls).toBe(1)`.
- Recommendation: merge — add the call count to `computer-conditions.test.ts:322` and delete this one (or the reverse).
- Confidence: high

### `tests/computer-mode-session.test.ts:1088` — "with no testFilePath the server own answer still decides"
- Category: L3
- Evidence: `makeManager(configWith({ enabled: false }))`, `executeSteps(..., { steps: ['[use computer]'] })`, `expect(response.results[0]!.reasoning).toBe(COMPUTER_DISABLED_MESSAGE)` — identical setup and assertion to `tests/computer-mode-session.test.ts:363` ("desktop.enabled: false refuses it (acceptance 7)"), which also has no `testFilePath` and asserts strictly more (surface stays browser, adapter/lock untouched).
- Recommendation: delete (or rename `:363` to say it is also the no-testFilePath case).
- Confidence: high

### `tests/computer-step.test.ts:1681` — "names the missing toolsDir, and how to supply one" (and the same shape at `tests/computer-mode-cli.test.ts:991`)
- Category: L4
- Evidence: `expect(undispatchedDirectiveError('[tool: open_calculator]', none)).toBe('[tool: open_calculator] was not run: this request carried no tools directory (toolsDir), so no tool is loaded — declare tests.toolsDir in the project\'s steptix.config.json so the client sends one. In computer mode a tool line is never handed to the model, because it would act it out on the real screen.')` — a three-sentence user-facing message pinned byte for byte; it is not quoted in SPEC-use-computer.md (grep for "carried no tools directory" finds nothing). The sibling tests in the same block (`:1690-1740`) and the session suite (`computer-mode-session.test.ts:1244-1249`) already assert the behaviour-carrying fragments with `toMatch`/`toContain`.
- Recommendation: rewrite to assert the fragments the test name promises: starts with `[tool: open_calculator] was not run`, contains `toolsDir` and `tests.toolsDir`, contains the "never handed to the model" sentence.
- Confidence: medium

## Test defects

### `tests/desktop-lock.test.ts:71` — "is idempotent for the same pid AND session, keeping the original `since`"
- Category: Defect (half the claim cannot fail)
- Evidence: `const first = acquireComputerLock(...); const again = acquireComputerLock(...); expect(again).toEqual(first);` — the two calls run in the same millisecond, so an implementation that rewrote the record with a fresh `new Date().toISOString()` (lock.ts:120) would usually produce an identical `since` and still pass. The "same holder is not refused" half is real.
- Recommendation: pre-write the lock file with an old `since` (e.g. `'2000-01-01T00:00:00.000Z'`) for pid 4242/sess-1, then acquire and assert `since` is unchanged both in the return value and in `readComputerLock`.
- Confidence: high

### `tests/dialog-guard.test.ts:287` — "survives a cross-origin iframe torn down while its own dialog is open"
- Category: Defect (probabilistic detector)
- Evidence: the regression only shows when Playwright's dismiss loses the race (comment at `:327`: "the failing handle is the rare outcome of the race"). The guard against a vacuous pass is `expect(dialogsHandled()).toBeGreaterThan(0)` — it proves a dialog was handled, not that a handle ever failed, so with the guard deleted this test can pass on any run where the race is not lost. The deterministic version of the same regression is `:195` ("swallows a rejected dismiss…").
- Recommendation: either assert the race was actually hit (`capture.lines.some(l => l.includes('already gone'))`) and accept it as a slow, opt-in reproduction, or drop it in favour of `:195` + the wiring tests. Costs ≥3 s fixed sleep plus a browser.
- Confidence: medium

## Duplication clusters
- Density-2 click mapping: `tests/desktop-capture.test.ts:86` (pure), `tests/desktop-executor.test.ts:112` (executor just calls `mapToScreen`), `tests/computer-step.test.ts:175` (loop keeps the grab's scale on the view) → keep capture:86 and computer-step:175, drop executor:112.
- Zoom-then-click mapping: `tests/desktop-capture.test.ts:192`, `tests/desktop-executor.test.ts:122`, `tests/computer-step.test.ts:207` → three levels, and §13 item 3 names it; keep all (executor:122 is the most dispensable).
- `image_input_unsupported` from the condition judge: `tests/computer-conditions.test.ts:322`, `tests/computer-step.test.ts:1619` → keep one, with the call count.
- `desktop.enabled: false` with no project file: `tests/computer-mode-session.test.ts:363`, `:1088` → drop :1088.
- `extractJson` envelope branches: `tests/desktop-action-parser.test.ts:420/:426/:434/:444` vs `tests/action-parser.test.ts:15/:40/:25/:31` → keep one seam case.
- The 1600/300/true/false desktop defaults: `tests/desktop-capture.test.ts:161`, `tests/desktop-config.test.ts:46`, `:55`, `:59`, `:87`, `tests/computer-mode-session.test.ts:1119` → keep config:46 (documented defaults) and session:1119 (reach the loop); drop config:55/:59; turn capture:161 into a parity check.
- CLI vs session mode state machine (`computer-mode-cli.test.ts` vs `computer-mode-session.test.ts`): intentional parity across the two real loops — keep both.
- §5.9 lock message: `tests/desktop-lock.test.ts:51` (via acquire) and `:134` (formatter) — different levels, keep.

## Cost concerns
- `tests/dialog-guard.test.ts:287` — real Chromium, up to 20 s `waitUntil` plus a fixed 3 s sleep, for a race that is only sometimes lost (see defect). The deterministic regression is `:195`.
- `tests/video-recording.test.ts` (4 tests) and `tests/dialog-guard.test.ts:346`, `:360` — real Chromium launches; justified (no pure-function substitute for rename-after-close or for "a launched/attached context gets the guard"), but they are the ones that need a browser and fail on WSL.
- `tests/computer-step.test.ts` — roughly 2–3 s of real `setTimeout` across the wait/wait_window tests (250 ms polls, 0.2 s waits). Small; the flake risk above matters more than the time.

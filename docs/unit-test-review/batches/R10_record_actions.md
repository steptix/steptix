# R10_record_actions

## Summary
- Files: 19 · tests (approx): 574 `it` declarations (+79 generated rows: 70 `it.each` in unknown-action-type, 9 in open-page) · High ~460 · Medium ~72 · Low 42 · Defects 5 · Flakes: 2 CONFIRMED (observed), 4 high-risk, 17 medium-risk
- Overall quality is high. The Record Steps suites (draft engine, prompt, recorder, toolbar, HTTP seam) are thorough, assert on real behaviour, and carry their own controls. The root suite and the extension do not test the same units: `runner-core/tests/record-steps.test.js` tests the client's wire (`ApiClient.streamRecordSteps` / `controlRecordSteps`, protocol guards) and `steptix-vscode/tests/record-steps*.test.js` test `steptix-vscode/src/extension/record-steps-core.ts`, so there is no L3 across that boundary. The one shared concept, author-line cleaning, is written twice with different rules and has no parity test (see Duplication clusters). That is a gap, not a duplicate.
- Low value clusters in the action/parser files: field-copy and alias-normalisation cases written out longhand across action-parser, open-page, assertion-action and drag-reload-actions. All of them are subsumed by unknown-action-type's exhaustive fold test or would fit in one table. Scroll's duration and easing tests exercise test-only mirrors that no production code calls. open-page's "openPage execution path" block re-implements the handler inline and spawns a server to test PageTracker bookkeeping.
- Flakiness is the bigger problem. Two files are confirmed failing under load: open-page and upload-action, with a 15 s cold-`tsx` server spawn and a port TOCTOU. The real-browser Record Steps suites have many wall-clock assertions. Some are elapsed-time bounds (`< 1_000`, `< 5_000`, `timeout: 1_500`, `REC 00:0\d`). Others are exact counts read after a fixed sleep: 4 serialized 150 ms history reads checked at 400 ms; two Playwright gestures that must land inside a 500 ms settle window; a pause that must beat a 700 ms settle window. These are the likeliest next failures on a loaded box. The pure suites (parser, wait-timeout, upload-paths, prompt) are deterministic, apart from one fixed temp path.

## Flakiness risks

### CONFIRMED (observed in the coordinator's loaded run 1 of 5): `tests/open-page.test.ts:113-129` and `tests/upload-action.test.ts:82-97` — beforeAll (file-level: 11 + 19 tests lost)
- Mechanism: each file copies the same three helpers. (1) `getFreePort()` (open-page :84, upload-action :34) listens on 0, reads the port and CLOSES it (`srv.close(() => resolve(p))`) before the child binds it, which is a TOCTOU race against every other worker. (2) It spawns `spawn(process.execPath, ['--import', 'tsx', serverPath], …)`, a cold tsx transform of the 1,700-line `fixtures/test-app/server.ts`. (3) It polls `waitForHttp(url, timeoutMs = 15_000)` (open-page :101, upload-action :51) inside a 60 s hook budget. Observed: "Timed out waiting for http://127.0.0.1:<port>/api/csrf-token" (open-page) and ".../api/documents" (upload-action). The child's `exit` is not watched, so a child that died on EADDRINUSE also shows up only as the 15 s timeout. The same helpers are copy-pasted in `tests/arrays-in-tools-integration.test.ts`, `tests/extract-order-ids-integration.test.ts`, `tests/test-app-documents.test.ts` and `tests/tool-end-to-end.test.ts` (another batch).
- Risk: high (observed)
- Fix: one shared helper in `tests/` used by all six files. Spawn the server with `PORT=0`, have `fixtures/test-app/server.ts` print the bound port (`server.address().port`) on stdout, and resolve on that line with the hook's own budget (≥ 45 s). Reject on the child's `exit`/`error`. In afterAll, `await once(child, 'exit')` after SIGTERM, with a timeout before SIGKILL. For open-page specifically, drop the server entirely (see Low-value: nothing in it needs the fixture app; `data:` URLs or `page.route` serve).
- Evidence: coordinator's observed failures; commit 2ef64db raised these files' hook budgets to 60 s but left the inner 15 s poll.

### `tests/record-steps-recorder.test.ts:725` — "reads that fall behind a burst of pushState are not waited on: the Back after it is kept, and nothing stalls"
- Mechanism: the rigged CDP session delays every `Page.getNavigationHistory` reply by 150 ms (`slow: { ms: 150, late: 'reply' }`). The recorder runs one read per commit, SERIALIZED in its action chain (`this.enqueue(async () => { … await readHistoryAfter(…) })`, src/recorder/step-recorder.ts:2026-2030). The third pushState's read therefore cannot start until about 2 × (150 ms + CDP round trip) after the first, yet the test asserts the count after `await new Promise((r) => setTimeout(r, 400)); expect(history.reads).toBe(4);` (:731-732). The margin is about 100 ms minus three CDP round trips and timer lateness.
- Risk: high
- Fix: wait for the count rather than sleeping, e.g. `await until(async () => history.reads, (n) => n >= 4, 'the reads', 5_000)`, then sleep briefly and assert `toBe(4)` (to keep the "no extra reads" half).
- Evidence: commits 285815c / dd41cb3 record these history-read races as observed flakes in "record-steps-recorder, record-steps-toolbar and api-server-record-steps"; this test was added by dd41cb3.

### `tests/api-server-record-steps.test.ts:593` — "a quick burst of actions goes in ONE call"
- Mechanism: `restartApp({ draftSettleMs: 500 })`, then two separate Playwright gestures, `await pageOf().click('#email'); await pageOf().check('#cash');`, followed by `expect(ai.requests).toHaveLength(1)`. The settle window starts when the first click reaches the draft engine, which happens after its crop screenshot (`sendScreenshots: true`). The second click, which also has a crop, must arrive within 500 ms of that. Playwright's actionability checks plus a screenshot under load can exceed that, and the test then sees two calls.
- Risk: high
- Fix: hold the first call open with `holdCalls()` (as other tests in this file do) or use `NEVER_SETTLES_MS` and end with Stop. Either way, assert the grouping by what one call contained rather than by beating a timer. Alternatively raise the window to several seconds and wait with `draftThrough(3)`, which already polls.
- Evidence: reasoning; the file's own comment on `QUICK_SETTLE_MS` ("long enough that one Playwright gesture's actions land in one call") shows the design depends on gesture timing.

### `tests/record-steps-toolbar.test.ts:468` — "records nothing while paused — not a click, not typing, not an address or a Back — and the next action says so"
- Mechanism: wall-clock bound `expect(after.atMs - beforePause).toBeLessThan(1_000)` (:500). The gap includes the resume click's `settledAt` polling, `until(... 'resumed')`, `await sleep(250)` and a full Playwright `page.click('#go')`. That leaves about 750 ms for real browser work.
- Risk: high (the coordinator saw timing failures in other real-browser files on this box)
- Fix: measure the paused span in the test and assert against it, e.g. `const pausedFor = resumedAt - pausedAt; expect(after.atMs - beforePause).toBeLessThan(pausedFor)`. Or inject `now` (StepRecorderOptions has `now?: () => number`, src/recorder/step-recorder.ts:296) and advance it by hand across the pause.
- Evidence: reasoning.

### `tests/record-steps-toolbar.test.ts:818` — "the bar lets clicks through to the page as soon as it is not recording — bar its Close button"
- Mechanism: `await page.click('#wide', { timeout: 1_500 })`, a 1.5 s budget for a real Playwright click (actionability, scroll, stability) under load. The short budget is load-bearing: the done bar removes itself after `END_SHOW_MS = 6000` (src/browser/scripts/record-toolbar.js:38), so a long timeout would let a blocked click succeed once the bar left.
- Risk: high
- Fix: assert the pass-through directly with `page.evaluate(() => document.elementFromPoint(cx, cy)?.id)` returning `'wide'` while the bar is shown, then click with the default timeout. Or make the end-show time a recorder option and set it far above the click budget.
- Evidence: reasoning.

### `tests/api-server-record-steps.test.ts:1288` — "Pause and Resume from the toolbar: record:paused, nothing recorded and no draft call while paused, the waiting action drafted on Resume"
- Mechanism: `restartApp({ draftSettleMs: 700 })`, click `#reports`, `waitForCount('record:action', 1)`, then `page.keyboard.press('Alt+Shift+P')`. The pause must reach the engine before the 700 ms settle window fires, otherwise `expect(ai.requests).toHaveLength(0)` (:1306) fails.
- Risk: medium
- Fix: raise the window (e.g. 5 s, since `draftThrough(1)` after Resume already polls up to 15 s) or hold the call with `holdCalls()` and assert it was never started.
- Evidence: reasoning.

### `tests/api-server-record-steps.test.ts:1817` — "the Done bar is gone before the run's first step: the model never sees it"
- Mechanism: `expect(Date.now() - doneAt).toBeLessThan(5_000)` (:1831) across `toolbarShows(...)` (up to 8 s of polling), a POST that starts a run, and `callInFlight()`. If the run is slower than 6 s the bar has removed itself and the check becomes vacuous. If it takes 5–6 s the test fails.
- Risk: medium
- Fix: make the end-show time configurable (as `typedNavigationWindowMs` is) and set it to minutes in this test, then drop the elapsed-time assertion.
- Evidence: reasoning.

### `tests/api-server-record-steps.test.ts:763` and `tests/record-steps-recorder.test.ts:592` — Back/Forward/Refresh classification
- Mechanism: classification reads `Page.getNavigationHistory` after each commit, re-reading for up to 2 s while it lags. The tests space the moves with `sleep(250/300)`. The races these depend on were fixed in 285815c/dd41cb3, which leaves a residual risk under heavier load.
- Risk: medium
- Fix: keep as is but rerun under load. If it flakes again, wait for the recorder's own read count to settle (as in the rigged tests) instead of fixed sleeps.
- Evidence: commit 285815c: "Seen as flakes in record-steps-recorder, record-steps-toolbar and api-server-record-steps."

### `tests/record-steps-recorder.test.ts:696` and `:713` — "reads that fall behind the commits are not waited on…" / "an error page is not waited on…"
- Mechanism: `await new Promise((r) => setTimeout(r, 600)); expect(history.reads).toBe(3);` (:703-706) and the same with 800 ms (:720-721). The reads are serialized and each one waits 150 ms before its request. There is more margin than in :725.
- Risk: medium
- Fix: as for :725, wait for `reads >= 3`, then a short quiet period, then `toBe(3)`.
- Evidence: reasoning.

### `tests/record-steps-recorder.test.ts:762` — "a read answered after the author's next move started is not taken: a Forward during a retry is a forward"
- Mechanism: the rig answers the re-read after a 1 s `setTimeout` and gives the real history only if a newer navigation started in that second. The test's Forward starts after `waitForURL` + `sleep(300)` + `goForward`, so the scenario needs the Forward to begin within about 700 ms of the retry. Under load the rig can resolve before the Forward starts and the test exercises a different path.
- Risk: medium
- Fix: gate the rigged reply on a promise the test resolves after `goForward()` has started (e.g. on `frameStartedNavigating`), not on a 1 s timer.
- Evidence: reasoning.

### `tests/record-steps-recorder.test.ts:815` — "a page restored from the back/forward cache is a back, even after a read that lagged"
- Mechanism: launches a second browser with `chromium.launch({ channel: 'chromium', ignoreDefaultArgs: ['--disable-back-forward-cache'] })` and asserts `expect(restores).toContain('BackForwardCacheRestore')`. Chromium decides bfcache eligibility at run time (memory pressure, page features). An install without the full `chromium` channel build cannot launch at all.
- Risk: medium
- Fix: separate the environmental precondition from the behaviour. If no `BackForwardCacheRestore` happened, fail with a message naming the precondition (or `ctx.skip` with a counted reason, as the live suite does for occlusion), and confirm CI installs the `chromium` channel.
- Evidence: reasoning.

### `tests/record-steps-recorder.test.ts:438`, `:977`, `:1104`, `:1201`, `:1259`, `:1298`, `:1443` — Add check armed, then clicked
- Mechanism: `recorder.armPick()` is fire-and-forget (`void this.pushState()`, src/recorder/step-recorder.ts:944). The tests click 0 ms later (:441-442 and :450-451 have no wait) or after `await sleep(100)`. If the page has not received the armed state, the click is recorded as an ordinary `click`, and assertions like `toEqual(['type', 'check'])` fail.
- Risk: medium
- Fix: wait for the armed state in the page before clicking, e.g. `await until(() => page.evaluate(...pick-armed probe...), Boolean, 'armed')`. Or give `armPick` an awaitable form for tests.
- Evidence: reasoning (the toolbar suite does wait, with `until(... 'Click what to check')` at record-steps-toolbar.test.ts:360).

### `tests/record-steps-toolbar.test.ts:232` — "in the top layer, in a closed shadow root on <html>, styled; back after a navigation; in a new tab; not in frames"
- Mechanism: `expect(bar?.status).toMatch(/^REC 00:0\d · 0 actions$/)` (:244) requires the bar to be read less than 10 s after `recorder.start()`.
- Risk: medium
- Fix: `/^REC \d\d:\d\d · 0 actions$/`.
- Evidence: reasoning.

### `tests/record-steps-toolbar.test.ts:737` — "a Pause the recorder refuses is taken back in the page, and so is one it never answers"
- Mechanism: explicit short budget `until(..., 'PAUSED at once', 2_000)` (:751) to catch an optimistic state that the page reverts after `COMMAND_ANSWER_MS = 3000`.
- Risk: medium
- Fix: read the optimistic state from a page-side flag set synchronously with the render, so the check does not depend on CDP polling latency. Or make `COMMAND_ANSWER_MS` injectable and lengthen it here.
- Evidence: reasoning.

### `tests/record-steps-toolbar.test.ts:1085`, `:1323`, `:1375` — positive assertions after a fixed sleep
- Mechanism: :1096-1100 `recorder.setToolbar({ ...WITH_STEPS, dock: 'tl' }); await sleep(250); … expect(b.host.y).toBeLessThan(40);` and :1106-1109 do the same for the 30-step drawer. :1336-1337 `await sleep(400); expect(commands).toEqual([{ kind: 'delete-step', id: 's1' }]);` and :1388-1389 `await sleep(400); expect(commands).toEqual([{ kind: 'edit-step', … }]);` each require a page→server round trip to have finished inside the sleep.
- Risk: medium
- Fix: `until(...)` for the positive condition (re-render shown / command arrived), then a short sleep only for the "and nothing more" half.
- Evidence: reasoning; commit 748b978 fixed the same class of race (a push landing between a wait and a click) in `clickToolbar`.

### `tests/record-steps-draft-locks.test.ts:97-101`, `tests/record-steps-edit.test.ts:214-228` — `settled()` / `inFlight()` helpers (every async test in both files)
- Mechanism: `const until = Date.now() + 3_000; while ((h.calls.length < calls || h.engine.callsInFlight > 0) && Date.now() < until) await sleep(3); await sleep(40);`. On deadline the helper returns SILENTLY, and the test then fails on an unrelated-looking draft assertion. `inFlight()` does the same. The engine's work is ~10 ms timers and a scripted model, so 3 s is a large margin.
- Risk: medium
- Fix: throw on deadline with the call count and in-flight state. Better, give `DraftEngine` an awaitable idle signal for tests, or drive it with `vi.useFakeTimers()`, since the model is synchronous.
- Evidence: reasoning.

### `tests/record-steps-edit.test.ts:1186` — "holds its invariants over 150 seeds"
- Mechanism: the RNG is seeded, but both the test's operations and the model draw from ONE stream, and the model's delays (`setTimeout(resolve, delay)`, 0–4 ms), `settleMs: 2` and `await sleep(Math.floor(r() * 4))` are real timers. Which draw goes to which consumer depends on scheduling, so a seed does not reproduce its scenario across machines or loads. A rare interleaving bug would show as an intermittent, unreproducible red.
- Risk: medium
- Fix: run the engine under `vi.useFakeTimers()` and advance time from the test loop, and give the model its own RNG stream, so each seed is one fixed history and a failure is reproducible from its seed number.
- Evidence: the describe at :787 is named "(property run, seed 46)", i.e. seeds have been used as reproduction handles.

### `tests/upload-paths.test.ts:247` — "on POSIX, still fences an absolute path outside the project"
- Mechanism: writes a FIXED path shared by every run on the machine, `const outside = path.join(os.tmpdir(), 'steptix-upload-outside.png')`, and `fs.rm`s it in `finally`. Two suites at once on one box (two worktrees, the CLAUDE.md workflow, or two CI jobs on a shared runner) race. If run B's `finally` removes the file while run A is between `writeFile` and `resolveUploadPaths`, `locate()` (src/browser/upload-paths.ts:148) no longer sees the absolute path, falls back to the test-relative one, and A gets "Upload file not found … nor at …" instead of "outside the project folder".
- Risk: medium (POSIX only; needs concurrent runs)
- Fix: create the outside file in its own `fs.mkdtemp(path.join(os.tmpdir(), 'steptix-upload-outside-'))` directory.
- Evidence: reasoning from src/browser/upload-paths.ts:140-153; every other path in the file is already under the `mkdtemp` root.

### `tests/upload-action.test.ts:326` — "fails a missing file BEFORE evaluating the selector"
- Mechanism: wall-clock assertion `expect(Date.now() - started).toBeLessThan(3_000)` around an `executeAction` call.
- Risk: medium (one stat, but a loaded Windows box with on-access AV scanning can stall)
- Fix: delete the elapsed-time assertion. The test already proves the ordering without it (`not.toMatch(/timeout|not visible/i)` and `matchCount` undefined).
- Evidence: reasoning.

### Already well guarded / no significant risk
- `tests/wait-timeout.test.ts`: no real timers. Waits are mocked page methods, the abort tests use never-settling promises ended by `abort()`, the `document` stub is restored in `finally`, and "duration waits" assert on a mocked `waitForTimeout`.
- `tests/scroll-action.test.ts`: the animator tests race a real `setTimeout` deadline (`duration + 500` ms) against fake rAF frames scheduled with `setTimeout(0)`. About 24 zero-delay ticks must beat a 1.7 s deadline, and if the deadline ever won, the asserted end positions are the ones it snaps to. `vi.unstubAllGlobals()` runs in `afterEach`.
- `tests/action-parser.test.ts`, `assertion-action`, `predicate-assertions`, `navigate-url-resolution`, `record-steps-prompt`: pure. Logger spies are restored in `finally`, and the `mapping` warning latch is reset in `beforeEach`.
- `tests/unknown-action-type.test.ts`, `drag-reload-actions`, `upload-snapshot`: real Chromium, but every page comes from `page.route` or `setContent` (no ports, no network). The browser launches in `beforeAll` (60 s) and closes in `afterAll`. The step-loop `openPage` row never navigates (no `pageTracker` in `runStep`, src/runner/step-executor.ts:2991). Minor: several tests `await page.close()` outside `finally`, which leaks a page only after a failure.
- `tests/api-server-upload.test.ts`: port 0, `mkdtemp` project, logging and stats off, server closed in `afterAll`.
- `tests/api-server-record-steps.test.ts` generally: port 0 for both servers, `mkdtemp` project, per-test Chromium closed in a 60 s `afterEach`, and process-global `addLogCallback` / `setLogLevel` restored in `finally`. Its SSE `waitFor` (15 s) and `until` (8 s) throw with the frames seen. Only the tests listed above have tight timing.

## Per-file verdicts
| File | Tests | Verdict (High/Medium/Mixed/Low) | One-line note |
|---|---|---|---|
| tests/action-parser.test.ts | 66 | Mixed (mostly High) | extractJson, escape repair, readTable validation and mapping-strip are high; a longhand block of "field X survives on action Y" cases plus two alias seam tests are low/duplicate; one loose assertion |
| tests/unknown-action-type.test.ts | 30 (+70 it.each rows) | High | Real step loop + route table proving every VALID_ACTION_TYPES member has a route; retry-prompt text guards behaviour; one alias test overlaps the exhaustive fold test |
| tests/assertion-action.test.ts | 8 | Low | 6 of 8 duplicate action-parser / predicate-assertions assert-parsing tests; only `poll` and `against` parsing are unique |
| tests/predicate-assertions.test.ts | 17 | High | Parser mode exclusivity, code-gen prompt context omission, report rendering of predicate and empty-expected rows; two parser rejections overlap assertion-action |
| tests/navigate-url-resolution.test.ts | 8 | High | Regression for file:// double-joining; real resolution logic behind a minimal goto mock |
| tests/upload-snapshot.test.ts | 5 | High | In-page snapshot carve-out for hidden file inputs needs a real DOM |
| tests/wait-timeout.test.ts | 22 | High | Clamp boundaries, timeout forwarding per wait kind, innerText predicate, abort semantics; one sanity test on two constants, one tautological guard line |
| tests/scroll-action.test.ts | 29 | Mixed (mostly High) | Routing/precedence and the real serialized animator are high; `scrollDurationMs`/`easeOutCubic` tests exercise test-only mirrors no production code calls |
| tests/drag-reload-actions.test.ts | 17 | Mixed (mostly High) | Drag target parsing, retryable=false control, compile/condition backstops and real-browser drag are high; the "known type" and alias tests duplicate unknown-action-type |
| tests/open-page.test.ts | 14 (incl. 9 it.each rows) | Low | Parser block is duplicate; the "execution path" block never runs the openPage handler and spawns the fixture server for PageTracker bookkeeping; CONFIRMED flaky beforeAll |
| tests/upload-action.test.ts | 19 | High (flaky harness) | Real uploader behaviours (hidden input, chooser, decoy, label, iframe) need a browser; two seam tests duplicate the missing-file seam test; CONFIRMED flaky beforeAll |
| tests/upload-paths.test.ts | 31 | High | Resolver fence, rooted-path platform split, sync/async parity; one fixed temp path |
| tests/api-server-upload.test.ts | 7 | High | Wire allow-list seam, session isolation, exactly-one-AI-turn with its retryable control |
| tests/record-steps-prompt.test.ts | 31 | High | Masking in every spelling, reconcileAnswer rules, image-rejection retry, page-script/constant parity pin; rule-list prompt tests are medium |
| tests/record-steps-draft-locks.test.ts | 14 | High | Engine paths a page cannot produce on demand (failed catch-up, pause with a call waiting, restore after change); one whole-format prompt pin; silent-deadline wait helper |
| tests/record-steps-edit.test.ts | 50 | High | Edit/delete/restore races against in-flight calls, mapping inference, property run; one test with a dead script line and an unasserted half-claim |
| tests/api-server-record-steps.test.ts | 62 | High (expensive, some flaky) | End-to-end server half over real HTTP + real Chromium; several wall-clock-sensitive tests; a Chromium launch per test |
| tests/record-steps-recorder.test.ts | 67 | High (some flaky) | Page script + recorder over real Chromium, rigged CDP history races, crop painting by pixel count; pure classifiers well covered |
| tests/record-steps-toolbar.test.ts | 47 | High (some flaky) | Closed-shadow toolbar, isolation from page listeners, CSP, drawer edits; several elapsed-time bounds and positive assertions after fixed sleeps |

## Low-value tests

### `tests/action-parser.test.ts:96-131, 169-179, 221-236, 285-294, 312-340` — "parses a type action with value", "parses a navigate action with url", "parses multiple actions", "parses scroll action with direction and amount", "parses assert action with expected field", "parses keyboard action with key", "parses a find action with value", "parses an expand action with selector" (+ `tests/open-page.test.ts:18`, `:54`; `tests/assertion-action.test.ts:85`, `:98`)
- Category: L3 (longhand table; one finding)
- Evidence: every case has the same shape: build `{actions:[{action: X, <field>: v}]}`, then assert `result.actions[0]?.<field>).toBe(v)`. Each one guards a single `if (typeof obj['f'] === 'string') action.f = obj['f']` line of `parseAction` (src/ai/action-parser.ts:835-925). Two add nothing over the others:
  - `find` with `value` (line 313, `expect(result.actions[0]?.value).toBe('ORD-789')`) hits the same copy line as "parses a type action with value" (line 96).
  - `expand` with `selector` (line 328) hits the same copy line as the first test's `expect(result.actions[0]?.selector).toBe('#sign-in-btn')` (line 74). Both also re-assert `needs_reeval`, already asserted at line 93.

  `find`/`expand` take no type-specific branch in `parseAction`. "parses multiple actions" asserts only `toHaveLength(3)` over a plain `.map`. The same pattern recurs in open-page :18 (the `url` copy line again) and :54 (`as`), and in assertion-action :85/:98 (the length of a two-action list). Meanwhile the copied fields with real loss risk (`question`, `method`, `body`, `path`, `attribute`, `multiple`, `frame`, `page`, `apiMode`, `apiHeaders`) have no case in this file.
- Recommendation: rewrite as one `it.each` table of (action, field, value) that covers every field `parseAction` copies, including the uncovered ones. Delete the two one-test `find`/`expand` describe blocks, "parses multiple actions", and the open-page and assertion-action copies.
- Confidence: high

### `tests/action-parser.test.ts:296` — "normalises \"press\" alias to keyboard"; `tests/action-parser.test.ts:462` — "normalises the aliases a model reaches for"; `tests/drag-reload-actions.test.ts:45` — "normalises the spellings a model reaches for"; `tests/open-page.test.ts:35-52` — it.each "normalises alias \"%s\" to canonical openPage" (9 rows)
- Category: L3 (one finding)
- Evidence: all four assert that `parseAIResponse(...).actions[0].action` equals the alias target for a hand-picked list. `tests/unknown-action-type.test.ts:313` ("folding merges no two meanings") already asserts `canonicalActionType(name) === target` for EVERY entry of `ACTION_TYPE_ALIASES` (src/ai/action-parser.ts:138-219). That map holds `press`, `attach*`, `refresh`, `reloadPage`, `browserRefresh`, `dragTo`, `dragAndDrop`, `drag_and_drop`, `dragDrop` and `open_page`/`openTab`…`new_window`. `tests/unknown-action-type.test.ts:274` proves `parseAIResponse` applies that lookup. In `parseAction` an alias goes through one line (`canonicalActionType(rawActionType) ?? rawActionType`, line 766) with no per-target branch, so these tests add labels, not branches.
- Recommendation: delete; keep unknown-action-type.test.ts:274 (parser seam) and :313 (exhaustive).
- Confidence: high

### `tests/assertion-action.test.ts:7, 27, 35, 43` — "accepts an assert action with description, condition, expected", "rejects an assert action missing condition", "rejects an assert action missing expected", "rejects an assert action missing description"
- Category: L3
- Evidence: missing `expected` (dom mode) is asserted three times: here (`toThrow(/expected/i)`), at `tests/action-parser.test.ts:262` (`toThrow(/missing required "expected" field/)`) and at `tests/predicate-assertions.test.ts:64` (same regex). Missing `condition` and missing `description` throw from checks that run before the mode is read (src/ai/action-parser.ts:1038-1043), so `tests/predicate-assertions.test.ts:89` and `:99` hit the identical branch with a tighter regex. The accept case duplicates `tests/action-parser.test.ts:221`. The only unique tests in this file are `:51` (poll) and `:68` (against); `:85`/`:98` are list-length checks (see the field-table finding).
- Recommendation: move `:51` and `:68` into action-parser.test.ts's assert block and delete this file.
- Confidence: high

### `tests/scroll-action.test.ts:218-261` — describe "scrollDurationMs" (3 tests) and "easeOutCubic" (3 tests)
- Category: L7 (test-only mirror; no production caller)
- Evidence: `grep -rn "scrollDurationMs\|easeOutCubic" src runner-core/src steptix-vscode/src flick-vscode/src` finds only the definitions (src/browser/actions.ts:1832, 1843). Their doc comments say the animator "carries its own inline copy" (`args.baseMs + Math.abs(targetY() - start) / args.pxPerMs`, `(1 - Math.pow(1 - t, 3))`, src/browser/actions.ts:1890-1903). So a change to the cap, the scaling or the curve in the code that actually runs leaves all six tests green. They can only fail if someone edits the unused copy. The constants are shared, so the gap is formula changes, which is exactly what the tests' purpose ("pin the cap and the distance scaling") claims to catch.
- Recommendation: rewrite against the real animator through the existing `installFakeBrowser` harness. Each fake frame advances 50 ms, so a 0→4600 'bottom' glide must take exactly ceil(1200/50) = 24 frames, and per-frame displacement over `scroller.writes` must fall across the back half. Then delete the two exported mirrors and these tests.
- Confidence: high

### `tests/drag-reload-actions.test.ts:30` — "are known action types, so the parser does not warn about them (with the control)"
- Category: L3
- Evidence: the claim is that `reload` and `drag` are in VALID_ACTION_TYPES. `tests/unknown-action-type.test.ts:727` asserts that `Object.keys(ROUTES).sort()` equals `[...VALID_ACTION_TYPES].sort()`, and ROUTES has `reload` and `drag` rows. `:329` asserts `isKnownActionType` for every member. Dropping either type from the set fails both, and `:239` covers the warning on an unknown type. This test predates them (its header cites the mutation check that motivated it).
- Recommendation: delete.
- Confidence: high

### `tests/open-page.test.ts:140-340` — describe "openPage execution path — real browser" (11 tests)
- Category: L8 (cost) + L3; see also Defects
- Evidence: the block's own comment says it will "Mirror exactly what step-executor's openPage handler does: 1. context.newPage() 2. goto(url) 3. tracker.addPage 4. switchToAsync", and it then performs those four steps INLINE in the test. The handler itself (src/runner/step-executor.ts:2985-3038: `markExpected`, `relabelPage` on `as`, `switchToAsync`, `showTab`) is never called, so a regression in it passes here. The handler is exercised through `executeStep` in tests/multi-turn.test.ts:945. What the block really tests is `PageTracker` bookkeeping, and to do it, it spawns the fixture app as a child process (the CONFIRMED flaky beforeAll) and launches Chromium.
  - Switch by URL/title/label and `closePage` (:141, :164, :267, :299, :327) are already covered on mock pages by `tests/popup.test.ts:151-345`.
  - The relabel rules (`/reserved/`, `/auto-generated/`, `/letters, digits/`, `/already taken/`, same-label no-op, :211-265) need only a Page object to key on.
  - Tests :141, :191, :211-265 and :299 navigate to `${baseUrl}/` only to have a page; :164, :267 and :327 already use `data:` URLs.
- Recommendation: move the five `relabelPage` rule tests and the label-switch cases into popup.test.ts's mock-page `PageTracker` suite, and delete the switch/close duplicates and the server spawn. If a real-browser openPage check is wanted, drive the real handler through `executeStep` with a `pageTracker`.
- Confidence: high

### `tests/upload-action.test.ts:367` — "refuses a path that escapes the project"; `tests/upload-action.test.ts:378` — "refuses an upload action carrying no path at all"
- Category: L3
- Evidence: both are seam tests that differ from `:326` ("fails a missing file BEFORE evaluating the selector") only in which `resolveUploadPaths` refusal propagates out of `executeAction`: `toContain('outside the project folder')` and `toContain('requires "filePath" or "filePaths"')`, against `toContain('Upload file not found')`. Each resolver message is already pinned at unit level (tests/upload-paths.test.ts:125, :176), and the executor has no per-message branch.
- Recommendation: fold into `:326` as a small table over the three refusals (keeping the `retryable` assertions), or delete.
- Confidence: medium

### `tests/wait-timeout.test.ts:39` — "the default is below the cap (sanity)"
- Category: L5
- Evidence: `expect(DEFAULT_WAIT_TIMEOUT_MS).toBeLessThan(MAX_WAIT_TIMEOUT_MS)` compares two literals; no logic of the unit runs.
- Recommendation: delete (or fold into the boundary test at `:23` if the relation is wanted).
- Confidence: high

### `tests/record-steps-draft-locks.test.ts:354` — "without locks, the draft reads exactly as it always did"
- Category: L4
- Evidence: `expect(text).toContain('## The draft so far: 2 steps\nIndexes count from 0, as replaceFrom does. To only add steps, replaceFrom is 2; the furthest back you may start is 0.\n```json')` pins three sentences, their line breaks and the code fence. The behaviour that matters, that no lock or author wording appears without locks, is not asserted directly. The replaceFrom sentence is already pinned with live numbers at `tests/record-steps-prompt.test.ts:157`.
- Recommendation: rewrite to assert the absence of the lock text (`not.toContain('LOCKED')`, `not.toContain('"author"')`, `not.toContain('yourStepsGoHere')`) and keep one sentence check.
- Confidence: medium

## Test defects

### `tests/action-parser.test.ts:25` — "extracts JSON from surrounding prose"
- Category: Defect (assertion too loose for the claim)
- Evidence: the input is `'Sure, here is the JSON: {"actions":[],"reasoning":"ok"} — hope that helps.'` and the assertion is `expect(result).toContain('"actions"')`. This passes even if `extractJson` returned its input unchanged (stripped no prose at all); it fails only if `extractJson` throws. Nothing else checks the leading-prose branch (`trimmed.search(/[{[]/)`, src/ai/action-parser.ts:671): lines 40 and 52 cover trailing content only.
- Recommendation: `expect(result).toBe('{"actions":[],"reasoning":"ok"}')`.
- Confidence: high

### `tests/wait-timeout.test.ts:148-150` — "blocks on text that lives only in <script> source / hidden nodes, then matches once it is visible"
- Category: Defect (tautological line with a false comment)
- Evidence: `expect((globalThis as any).document.body.textContent.includes('Ready now')).toBe(true)` reads the stub the test built two lines earlier. The comment says "a revert to textContent flips this assertion red", but no code under test runs in it, so it cannot flip. The test still works, because `:147` (`expect(predicate('Ready now')).toBe(false)`) is the line a revert would turn red.
- Recommendation: delete the line, or reword the comment to say it documents the fixture and that `:147` is the guard.
- Confidence: high

### `tests/open-page.test.ts:140-146` — describe "openPage execution path — real browser" and its first test's comment
- Category: Defect (name/claim does not match what is checked)
- Evidence: the describe and its first test say they test "the openPage execution path" and "Mirror exactly what step-executor's openPage handler does", but no test calls the handler; the four steps are re-implemented in the test body (:147-150). See the L8 finding above.
- Recommendation: rename to what it tests (PageTracker over real pages) when moving it, or drive the real handler.
- Confidence: high

### `tests/upload-action.test.ts:101-105`, `tests/open-page.test.ts:133-137` — afterAll
- Category: Defect (dead fallback)
- Evidence: `serverProc.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 50)); if (!serverProc.killed) serverProc.kill('SIGKILL');`. `ChildProcess.killed` becomes true as soon as `kill()` delivers the signal, not when the child exits, so the SIGKILL branch can never run and the hook never waits for exit. The same code is copied in the four files named in the CONFIRMED flake entry.
- Recommendation: `await once(serverProc, 'exit')` with a timeout before escalating, inside the shared helper recommended above.
- Confidence: high

### `tests/record-steps-edit.test.ts:252` — "the model's stepActions are kept; an event it left out rides with its action"
- Category: Defect (dead setup, half of the claim unasserted)
- Evidence: after `await settled(h, 1)`, the test sets `h.script.set(2, answer(['Search it'], [[]], 2));` under the comment "(the next call is scripted below; this one covers a1..a4)". No second call happens; the assertions read `inspect()` synchronously and `h.last().ids` is `['d1', 'd2']`, so the scripted answer is dead. The assertions check only that d1→`['a1']` and d2→`['a2']`. In this setup no event is left out (a1, the typing, is claimed explicitly by `[1]`), so the second half of the name is not exercised. That case is covered by the next test (`:270`).
- Recommendation: delete the dead `script.set` line and comment, and rename to "the model's stepActions are kept" (or assert where a3/a4 went).
- Confidence: medium

## Duplication clusters
- Alias normalisation through the parser: `tests/action-parser.test.ts:296`, `:462`, `tests/drag-reload-actions.test.ts:45`, `tests/open-page.test.ts:35` (9 rows), `tests/unknown-action-type.test.ts:274`. All are subsumed by `tests/unknown-action-type.test.ts:313` (every alias). Keep :274 and :313; drop the rest.
- Field copy in `parseAction`: `tests/action-parser.test.ts:96, 108, 169, 221, 285, 313, 328`, `tests/open-page.test.ts:18, 54`, `tests/assertion-action.test.ts:7`. Keep one `it.each` table in action-parser.test.ts.
- Assert missing `expected` (dom mode): `tests/action-parser.test.ts:262`, `tests/assertion-action.test.ts:35`, `tests/predicate-assertions.test.ts:64` (+ `:78`, which also checks the predicate nudge). Keep action-parser:262 and predicate-assertions:78.
- Assert missing `condition` / `description`: `tests/assertion-action.test.ts:27/:43`, `tests/predicate-assertions.test.ts:89/:99`. Keep predicate-assertions (tighter regex).
- `reload`/`drag` are valid types: `tests/drag-reload-actions.test.ts:30`, `tests/unknown-action-type.test.ts:329`, `:727`. Keep unknown-action-type.
- PageTracker switch/close bookkeeping: `tests/open-page.test.ts:141, 164, 267, 299, 327` (real browser + spawned server) vs `tests/popup.test.ts:189-340` (mock pages). Keep popup.test.ts and move the relabel rules there.
- Not a duplicate, a parity GAP: author-step line cleaning exists twice. `src/recorder/record-steps-run.ts:98` `authorStepLines` (tested at record-steps-draft-locks.test.ts:137, record-steps-edit.test.ts:1048) strips `^(?:\d+[.)]|[-*+])`. `steptix-vscode/src/extension/record-steps-core.ts:2743` `cleanAuthorLine`/`splitAuthorSteps` strips `^(?:\d{1,9}[.)]|[-*+])` and also collapses inner whitespace. No test runs both over shared cases, so the server and the extension can disagree on what counts as a step (e.g. a 10-digit "number." prefix, or runs of spaces) without anything failing.

## Cost concerns
- `tests/api-server-record-steps.test.ts`: every test that calls `started()` launches its own Chromium through the server's launcher (`launchBrowser` mock, :61-72) and closes it in `afterEach`. Commit 6510125 measured that close at up to ~27 s while the suite starts, which is why the hooks have 60 s budgets. There are about 50 such launches. Some tests launch a browser only to check a refusal string that an engine-level test could cover. For example `:2377` ("a lone number or list marker") checks `editStep('d1', '3.')` → "delete the step instead", which has no `DraftEngine` unit test (record-steps-edit.test.ts:1048 checks only `authorStepLines`). Consider a shared browser per describe, with sessions on fresh contexts, and moving pure refusal checks to the engine suite.
- `tests/open-page.test.ts`: a child-process fixture server plus Chromium for PageTracker bookkeeping that mock pages already cover (see Low-value). The server is the expensive and flaky part, and nothing in the block needs it.
- `tests/upload-action.test.ts`: real Chromium plus the child-process fixture app is justified for the uploader behaviours (hidden input, chooser, decoy, label, iframe). The `upload paths` describe's `beforeEach` re-navigates to `/documents` for tests that, except `:355`, fail before touching the page.
- Minor: `tests/record-steps-toolbar.test.ts:621` leaves a `console.log` of measurements in the CSP test, which writes to every run's output.

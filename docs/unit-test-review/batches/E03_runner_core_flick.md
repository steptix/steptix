# E03_runner_core_flick

## Summary
- Files: 23 (17 runner-core, 6 flick-vscode) · tests (approx): ~470 written + ~290 generated (3 per sectionless corpus file in regression-corpus, 2 per match-table row, 2 per frozen fixture) · High ~360 · Medium ~50 · Low 57 written tests + ~80 generated corpus rows (28 findings) · Defects 7 · Flake risks 5 (1 CONFIRMED observed 1/20, 4 medium)
- Overall the suites are strong: most tests pin real contracts (wire shapes, error mapping, grammar refusals with line numbers, frozen cross-package tables, secret-masking splits) and runner-core is almost entirely pure/in-memory. The low value is concentrated in three patterns: (1) **dead subjects** — runner-core's `isRunEvent`, `isCompileEvent`, `isHostMsg`, `isStepLine`, `nearestStepAtOrAbove/Below` and `resolveRunLines` have no production caller, yet carry ~30 tests (protocol.test.js is 15/19 dead); (2) **post-refactor duplicates of the shared `postSse` path** — 401/404/409/abort/frame-order re-asserted per route in api-client.test.js and record-steps.test.js, plus fields that only round-trip through `JSON.parse`; (3) small in-file restatements (frontmatter, repl, sse-parser, sections vs run-selection).
- Flakiness: runner-core is clean apart from regression-corpus walking the live working tree (it descends into 3,845 Chrome-profile files under `templates/init/.steptix/` in the main checkout, with `statSync` outside its try). flick-vscode's controller suite has a **confirmed** flake: every post-run write goes through `writeJson`'s un-retried `writeFile(tmp)`+`rename`, a failure is swallowed by `track()`, so the test can only see "historyReplace never came" after the 3 s `waitFor` budget. 14 `historyReplace` waits share the exposure.
- Systemic: runner-core's `npm test` has no `pretest` build yet every file imports `../dist/` — locally it silently tests stale code (CI is saved only because `npm ci` runs `prepare`). This breaks the CLAUDE.md rule "Keep `npm test` building first".

## Flakiness risks

### `flick-vscode/tests/integration/controller.test.ts:359` — "deleting a confirmed session removes its tab, local data, and closes the browser server-side" — CONFIRMED (observed 1/20 under load)
- Mechanism: The failing await is `await wait(fw, 'historyReplace')` at :363 (before `fw.drain()`), with the default `FakeWebview.waitFor` budget of `timeoutMs = 3000` (tests/fakes/fake-webview.ts:48) polled every 10 ms. The "saw:" list — `init, connection, sessions, history, historyAppend, historyAppend, busy, busy` — pins exactly where `submitSteps` stopped (flick-vscode/src/extension/controller.ts:568-689): both `historyAppend`s and `busy:true` were posted; the API call **succeeded** (no `toast`, which the catch at :672 posts before `busy:false`); `busy:false` came from the `finally` at :675. What never ran to completion is the tail between `busy:false` and the `historyReplace` post at :688:
  ```
  const finalHistory = await this.store.loadHistory(sessionId);   // :681
  ...
  await this.store.saveHistory(sessionId, finalHistory);           // :685
  await this.persistSessions();                                    // :686
  this.post({ type: 'historyReplace', ... });                      // :688
  ```
  No timer, sleep or fake-server round trip is on that path — only disk I/O: `saveHistory` and `persistSessions` are each `writeJson` = `fs.writeFile(\`${file}.tmp\`)` then `fs.rename(tmp, file)` (src/extension/store.ts:153-157), with **no retry**. (`loadHistory` cannot throw: `readJson` swallows every error and returns `[]`.) If either rename/write rejects, `handleMessage` rejects and `track()` (controller.ts:134-141) converts the rejection to `undefined` — so `historyReplace` is never posted, nothing is logged, and the test can only time out. The run's timing fits that: the test took 3060 ms ≈ the 3000 ms budget + boot, and the very next test took 243 ms, so the machine was not uniformly stalled; a single fs op failed or stalled.
  Most likely cause: on Windows, a rename of a just-written file in `%TEMP%` fails with EPERM/EACCES/EBUSY while an on-access scanner (Defender) still holds the `.tmp` or target — the documented reason `graceful-fs` retries `rename` on win32. A heavy concurrent vitest run widens that window (more files for the scanner, slower scans). The alternative — the same two writes stalling > ~2.9 s — is fixed by the same changes. It is not a logic race inside this test's flow: nothing else writes `history/<id>.json` or `sessions.json` concurrently here (pings do no I/O; `checkStale` is not triggered; the earlier `createSession` read finished long before).
  A latent in-process race exists in the same helper: the tmp name is FIXED (`${file}.tmp`), so two concurrent writers of one file (e.g. `checkStale`→`persistSessions` racing `submitSteps`→`persistSessions` when a tab switch lands mid-run) can rename each other's tmp away → ENOENT, also swallowed.
  Exposure is suite-wide, not specific to this test: 14 `wait(fw, 'historyReplace')` / `waitFor(... 'historyReplace')` calls (:115, :174, :177, :195, :220, :243, :260, :278, :307, :348, :363, :480, :725, :728) sit behind the same two un-retried writes.
- Risk: high (confirmed)
- Fix (production + test, in this order of value):
  1. `store.ts` `writeJson`: unique tmp name (`${file}.${process.pid}.${crypto.randomUUID()}.tmp`), serialize writes per file (a `Map<string, Promise<void>>` chain), and retry `rename` on `EPERM`/`EACCES`/`EBUSY` with short backoff (e.g. 10 tries, 10→100 ms) — real Windows users hit the same failure and get a pending card that never resolves.
  2. `controller.ts` `track()`: stop discarding rejections — record them (output channel + an error toast) and expose them to tests (e.g. `__testTrackedErrors`).
  3. Test: in `afterEach`, assert no tracked errors; make `wait()` race that error list so a failed write fails the test at once with its real errno instead of a blind 3 s timeout; raise `FakeWebview.waitFor`'s default ceiling from 3000 ms to ~15000 ms (it polls every 10 ms, so passing runs pay nothing).
- Evidence: coordinator's 20-run measurement (1 failure, 3060 ms vs 243 ms for the next test); code trace above. History shows this file's earlier flakes were also writes the test could not see (2a92c04 "Fix flick-vscode's flaky suite…": a `saveHistory` outliving its test, and a sampled-not-awaited broadcast) — `track()`/`drain()` fixed teardown but made in-flight failures invisible.

### `runner-core/tests/regression-corpus.test.js:68-86` — module-level corpus walk (all `unchanged …: <file>` rows)
- Mechanism: `walk()` recurses `fixtures`, `templates` and `steptix-vscode/tests/integration/fixtures` of the live working tree, skipping only `node_modules`, `dist`, `.git`. `readdirSync` is in a try, but `if (statSync(full).isDirectory())` (:78) is not. In the main checkout `templates/init/.steptix/cdp-profiles/` holds 3,845 Chrome-profile files (measured; also `templates/.steptix/`, five `.steptix-codebehind-cache` dirs). While a live run or a Steptix session has Chrome open on one of those profiles — or a live compile suite `rmSync`s a cache dir — a file deleted between `readdirSync` and `statSync` throws ENOENT at import time and fails the whole file.
- Risk: medium (needs a concurrent browser/live run in the same checkout — normal on this dev machine; never on CI's clean checkout)
- Fix: `readdirSync(dir, { withFileTypes: true })` (no per-entry `statSync`), skip any dot-directory (`.steptix`, `.steptix-codebehind-cache`, `.steptix-tool-cache`), and tolerate ENOENT per entry.
- Evidence: `find templates/init/.steptix/cdp-profiles -type f | wc -l` → 3845 in `<main-checkout>`.

### `flick-vscode/tests/unit/cdp-discovery.test.ts:85` — "ports queried in parallel"
- Mechanism: wall-clock assertion `assert.ok(spread < 20, ...)` on `Date.now()` stamps taken at the first fetch of each port. The three stamps are pushed in one synchronous tick (`ports.map(probePort)` runs to the first `await` inside the fake fetch), so the spread is normally 0–1 ms — but a GC pause or the process being descheduled for >20 ms mid-tick on a loaded CI box fails it.
- Risk: medium
- Fix: measure concurrency, not time — count in-flight fetches (`inFlight++` before the `await sleep`, `inFlight--` after) and assert `maxInFlight === 3`; a sequential implementation gives 1.
- Evidence: reasoning (probePort, src/extension/cdp-discovery.ts:36-46, has no await before the first fetch).

### `flick-vscode/tests/integration/controller.test.ts:58` — `afterEach` cleanup `fs.rmSync(dir, { recursive: true, force: true })`
- Mechanism: the store dir holds freshly written PNGs and JSON in `os.tmpdir()`; on Windows a scanner holding one of them makes `rmSync` throw EBUSY/EPERM (`force` only ignores ENOENT), failing the hook and the test. Same scanner mechanism as the confirmed flake, at teardown.
- Risk: medium
- Fix: `fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })`.
- Evidence: reasoning; same family as the confirmed flake.

### `flick-vscode/tests/integration/controller.test.ts` — every other `waitFor` (default 3000 ms)
- Mechanism: all waits use the 3 s ceiling; besides `historyReplace`, flows that include a real HTTP round trip + several file writes (`sessions` after `newSession`/`adoptCdpTab`, `cdpDiscovery`, `serverSessions`) are exposed to the same loaded-box stalls.
- Risk: medium
- Fix: raise the default ceiling (see above); it is a ceiling, not a sleep.
- Evidence: the confirmed failure shows 3 s is reachable under a concurrent root vitest run.

Checked and NOT flagged (already guarded): fake API/browser servers listen on port 0 (`listen(0, '127.0.0.1')`); `afterEach` does `dispose()` then `drain()` before deleting the dir (fix from 2a92c04); the `launchBrowserCdp` test awaits the `cdpDiscovery` broadcast rather than sampling; browser-launcher's poll-timeout test fakes `sleep` and restores `Date.now` in `finally`; runner-core env-file/user-root use `mkdtemp` dirs and injected env (never the real `%LOCALAPPDATA%\steptix`); api-client/record-steps use in-memory `fetch` fakes; `delay(100)` (:390) and `delay(50)` (:816) are negative waits that cannot false-fail (they could be `await controller.drain()` to be deterministic and faster). Refused connections in :251/:429/:639 are fast on Windows loopback (measured 1–7 ms), so they do not eat the 3 s budget.

## Per-file verdicts
| File | Tests | Verdict (High/Medium/Mixed/Low) | One-line note |
|---|---|---|---|
| runner-core/tests/api-client.test.js | 32 | Mixed (mostly High) | Wire contract + error mapping + describeFetchError are strong; four post-refactor "still works" tests re-run the shared `postSse` path already covered. |
| runner-core/tests/data-rows.test.js | 23 (6 table-driven) | High | Mirror corpus of the server's table scan; every refusal shape and line number pinned. |
| runner-core/tests/env-file.test.js | 26 | High (one Low) | Walk-up, strict vs server grammar divergence well covered; `composeEnv` non-mutation tests a spread. |
| runner-core/tests/errors.test.js | 15 | Mixed | Context-in-message checks are real contracts (path, STEPTIX_SERVER_URL, setting names); "real-looking command ids" checks only non-empty strings and misses an unregistered command; 5 catalogue codes have no production emitter. |
| runner-core/tests/frontmatter.test.js | 23 | High (2 Low) | Good edge coverage (CRLF, dedent, hyphen names, quoted `#`); two cases are strict subsets of neighbours; one name contradicts its assertion. |
| runner-core/tests/protocol.test.js | 19 | Mixed (mostly Low) | `isRunEvent`, `isCompileEvent` and `isHostMsg` have NO production caller (L7) — 15 of 19 tests; `isSkippedPass` and `isWebviewMsg` are live and worth keeping, but the "every webview variant" list already misses `rerunFailedRows`. |
| runner-core/tests/record-steps.test.js | 22 | Mixed (mostly High) | Route/headers, control answers, 400→`apiErrorReason`, `onOpen` ordering are strong; guard-list and SSE pass-through tests repeat protocol/api-client tests. |
| runner-core/tests/regression-corpus.test.js | 2 + 3×N (N≈80 sectionless corpus files) | Medium | Guards "sectionless real docs classify as the pre-sections classifier did"; the third per-file row is implied by the first; header's "logically equivalent" claim is stale since the `inert-step` branch (5629c90). |
| runner-core/tests/repl.test.js | 66 | High (one Low) | REPL command table and the secret-masking split (flat vs column vs bindings vs unmask) are well-reasoned regression pins; one test repeats four assertions verbatim. |
| runner-core/tests/run-selection.test.js | 21 | High (resolveRunLines rows L7) | The five rungs of `resolveRunSelection` on the frozen fixture are excellent; the `resolveRunLines` rows test a wrapper nothing in production calls. |
| runner-core/tests/section-index.test.js | 31 + 38 generated (20 match-table rows) | High | Frozen match table asserted both directly and end-to-end; call/non-call complement, nameStart columns, control-line tails, rung-2 precedence. |
| runner-core/tests/sections.test.js | 27 + 6 generated (3 frozen fixtures) | Mixed (mostly High) | Frozen classification table + section boundary rules are high value; four consumer-split tests repeat run-selection.test.js, and two cover dead helpers (`isStepLine`, `nearestStepAt*`). |
| runner-core/tests/sse-parser.test.js | 7 | High (one Low) | Small, real edge cases (partial chunks, CRLF, comments); the `step:skip` test re-proves type-agnosticism already shown by test 1 and then JSON-parses its own literal. |
| runner-core/tests/step-lines.test.js | 51 | Mixed | `danglingChainMemberError` and `runStartFor` blocks are high value; 8 `resolveRunLines` tests + `isStepLine`/`nearestStepAt*` test a dead wrapper / dead helpers; one test carries an unused, misleading fixture. |
| runner-core/tests/test-meta.test.js | 20 | High (one Low) | `## Config`/`## Parameters` scan + positions; `resolveSection` missing-var case repeats `resolveValueFromEnv`'s. |
| runner-core/tests/use-step.test.js | 10 | High | `[use …]`/`[use ai]` grammar, refusals with caret shape, §4.2 did-you-mean; parity with `src/` is (correctly) left to the root suite. |
| runner-core/tests/user-root.test.js | 5 | High | Path derivation per platform via injected deps, blank-is-absent, EISDIR throws; fully isolated in `mkdtemp` dirs. |
| flick-vscode/tests/integration/controller.test.ts | 27 | High (CONFIRMED flake) | NOT over-mocked (L6 does not apply): real controller, real HTTP fake server, real on-disk Store; only `vscode` and the webview are faked. Strong seam coverage (first-request config, adopt/dedupe, stale, restart, CDP). One confirmed flake; one misleading "unreachable server" test. |
| flick-vscode/tests/unit/browser-launcher.test.ts | 12 | Mixed (mostly High) | Per-OS detection order and array-form spawn are real contracts; the "cache" test cannot detect what its name claims; one mkdir test repeats the happy path. |
| flick-vscode/tests/unit/cdp-discovery.test.ts | 8 | High (one Low, one flake risk) | Tab filtering, engine table incl. the measured `Edg/` string, per-endpoint error paths; parallelism asserted by wall clock. |
| flick-vscode/tests/unit/output-sections.test.ts | 8 | High | Section order, collapse, delta filter, parameters-not-filtered, older-server fallback, missing-source default. |
| flick-vscode/tests/unit/parse-steps.test.ts | 7 | High (one Low) | Prefix stripping (`1.`, `3)`, `-`), CRLF, blanks; the quoted-content case exercises no branch. |
| flick-vscode/tests/unit/step-status.test.ts | 6 | High | Regression for `skipped` falling through `!== 'passed'` (glyph, auto-expand, batch error, reason chip); all five helpers are used by src/webview/main.ts. |

## Low-value tests

### `runner-core/tests/api-client.test.js:82` — "streamSteps: a config block without viewport stays byte-for-byte what it was"
- Category: L1 (and L3 of :50)
- Evidence: `streamSteps` does `body: JSON.stringify(request)` (runner-core/src/api-client.ts:623) with no logic touching `config`. The test sends `config: { baseUrl: 'https://example.test/' }` and asserts `assert.deepEqual(body.config, { baseUrl: 'https://example.test/' })` / `assert.ok(!('viewport' in body.config))` — the value flows from setup through `JSON.stringify` only. The sibling at :50 already pins verbatim pass-through of the same block (with `viewport`), so this adds no branch.
- Recommendation: delete (keep :50 as the single "client does not normalise `config`" contract pin).
- Confidence: high

### `runner-core/tests/api-client.test.js:468` — "compileCodeBehind: 401 still throws unauthorized"; `:480` — "compileCodeBehind: aborting the signal surfaces as an abort, not a transport fault"; `:496` — "streamSteps still works after the shared SSE refactor"
- Category: L3
- Evidence: `streamSteps`, `compileCodeBehind` and `streamRecordSteps` are each a one-line `yield* this.postSse(...)` (api-client.ts:482, :507, :536). The 401 mapping (`postSse` :631), the abort mapping (:626) and the frame→event loop (:680-684) are one code path. :468 repeats :122 ("streamSteps: 401 throws unauthorized"); :480 repeats :176 ("streamSteps: abort throws aborted"); :496 repeats :106 ("streamSteps: yields ordered events") — its only extra assertion, `events[0].fromCodeBehind === true`, is a field `frameToEvent` passes through untouched from `JSON.parse` (api-client.ts:910-918). These were refactor guards ("still works after the shared SSE refactor"); the refactor is done and the code is shared.
- Recommendation: delete all three (the route-specific tests :355 and :452 already prove `compileCodeBehind` reaches `postSse` with its own route and 409 mapping).
- Confidence: high

### `runner-core/tests/api-client.test.js:386` — "compileCodeBehind: yields the inner run events of a Record and a Replay as compile:run"
- Category: L3 (partly L1)
- Evidence: Same `postSse` frame loop as :422 ("compileCodeBehind: yields phases, steps and the final result in order"). The nested fields it asserts (`runs[2].event.fromCodeBehind`, `runs[3].event.error`, `runs[3].event.screenshot`, `events.at(-1).summary.writtenOffAi`) are parsed JSON returned unchanged by `frameToEvent` — no client logic reads `event`, `phase` or `round`.
- Recommendation: merge into :422 (one frame list containing a `compile:run` frame is enough), or delete.
- Confidence: medium

### `runner-core/tests/env-file.test.js:192` — "composeEnv: does not mutate its inputs"
- Category: L5
- Evidence: `composeEnv` is `return { ...base, ...overlay };` (runner-core/src/env-file.ts:282). Object spread cannot mutate its operands; the test asserts `assert.deepEqual(base, { A: '1' })` after calling it — that is a language guarantee.
- Recommendation: delete (the :181 overlay-wins case is the one worth keeping — it pins argument order).
- Confidence: high

### `runner-core/tests/errors.test.js:51` — "every code produces a payload with code + non-empty message + non-empty fix"
- Category: L5 (mostly)
- Evidence: `reportError` builds `message: \`${code}: ${built.diagnosis}. ${built.fix}\`` and returns `code` as passed (runner-core/src/errors.ts:263-268), so `assert.equal(payload.code, code)` and `payload.message.startsWith(\`${code}:\`)` restate the function's own template; the builders are typed by `ErrorContextMap` so a missing builder is a compile error. Only the two `length > 0` checks can fail, and only if someone writes an empty literal.
- Recommendation: rewrite — fold the two non-empty checks into :61 ("every fix sentence ends with a period", which is the documented format rule) and drop the code/prefix round-trip.
- Confidence: high

### `runner-core/tests/errors.test.js` — catalogue entries with no production emitter (STX002, STX020, STX026, STX030, STX031)
- Category: L7 (partial — these codes ride along in the loops at :51, :61, :171 and in the path list at :68-77)
- Evidence: `grep -rn "'STX002'\|'STX020'\|'STX026'\|'STX030'\|'STX031'" steptix-vscode/src flick-vscode/src src` → no `reportError(...)` call (STX030 appears only in two comments). Every `reportError` call site is in steptix-vscode/src/extension/run-controller.ts (:1538-:5954). STX026's own fix text ("this variant would send the bare section-call step to the AI") describes the removed `testbench-monaco` variant (issue 048). STX020's action `steptix.reopenAsText` is not contributed or registered anywhere.
- Recommendation: remove the dead codes from the catalogue (owner decision); then drop `STX002`/`STX020` from the :68 path table and `SAMPLE_CONTEXTS`.
- Confidence: high

### `runner-core/tests/protocol.test.js:11,43,94,120,125,141,169,181,190,204,228,252,260,271,285` — all `isHostMsg` / `isRunEvent` / `isCompileEvent` tests (15 tests incl. part of :271/:285)
- Category: L7
- Evidence: `grep -rn "isRunEvent\|isCompileEvent\|isHostMsg" steptix-vscode/src flick-vscode/src src` (excluding runner-core) → the only hit is the webview's OWN `function isHostMsg(value)` over a local `HOST_MSG_TYPES` set (steptix-vscode/src/webview/steptix-runner.jsx:84). runner-core's `isHostMsg`, `isRunEvent` and `isCompileEvent` are imported by nothing in production; the source even says so for `isHostMsg` ("nothing in the extension host routes host messages through this guard", protocol.ts:1941-1944). The live narrowers are `isWebviewMsg` (runner-view.ts:157) and `isRecordStepsEvent` (run-controller.ts:5692).
- Recommendation: delete these tests together with the dead exports — or, if the guards are meant to stay, replace the hand-kept lists with one parity test: runner-core `isHostMsg` accepts exactly the webview's `HOST_MSG_TYPES` (that copy is what actually filters messages, and nothing compares the two today).
- Confidence: high

### `runner-core/tests/protocol.test.js:181` — "isRunEvent: capture event from an old server (no source) still narrows"; `:271` — "step:pass carries the code-behind flags through the narrower"; `:285` (second half) — "isRunEvent: accepts both awaiting-debugger variants"
- Category: L1 (on top of L7 above)
- Evidence: `assert.equal(legacyCapture.source ?? 'capture', 'capture')` evaluates `??` on the test's own literal; `assert.equal(asCode.fromCodeBehind, true)`, `assert.equal(stale.codeBehindStale.file, '/p/tests/a.steps.ts')` and `assert.equal(cb.file, '/p/tests/a.steps.ts')` read back fields of objects the test built — `isRunEvent` returns a boolean and does not touch them.
- Recommendation: delete (subsumed by the L7 finding).
- Confidence: high

### `runner-core/tests/record-steps.test.js:132` — "isHostMsg: the Recording block message is a host message"; `:136` — "isHostMsg: the Add step box's answer is a host message"
- Category: L7 + L3
- Evidence: Dead subject as above; also both types are already in the list at protocol.test.js:35-37 (`'recording'`, `'recordAddStepResult'`).
- Recommendation: delete.
- Confidence: high

### `runner-core/tests/record-steps.test.js:140` — "isWebviewMsg: every Recording control the panel posts is accepted"
- Category: L3
- Evidence: The eight types `['recordSteps', 'recordNewTest', 'recordStop', 'recordCancel', 'recordCheck', 'recordDrop', 'recordPause', 'recordAddStep']` are exactly the eight at protocol.test.js:75-83 in "isWebviewMsg: accepts every webview variant". The only new assertion is `isWebviewMsg({ type: 'recordToggle' }) === false`, the same branch as protocol.test.js:91 (`{ type: 'init' }`).
- Recommendation: delete.
- Confidence: high

### `runner-core/tests/record-steps.test.js:74` — "streamRecordSteps: a draft's ids and edited, record:edited, and the actions a step delete dropped all cross the wire"; `:178` — "streamRecordSteps: yields every record frame in order, output and done included"
- Category: L1 / L3
- Evidence: `streamRecordSteps` is `yield* this.postSse(...)` (api-client.ts:536), and `frameToEvent` returns `JSON.parse(frame.data)` unchanged when it has a string `type` (:906-919). Every assertion — `events[0].ids`, `events[2].actions`, `events[3].tab`, `events[6].through`, `events[9].parameters` — reads back a field the test put in the frame. Ordering through `postSse` is already covered by api-client.test.js:106, and "unknown types are not filtered" by record-steps.test.js:236.
- Recommendation: delete :74; shrink :178 to nothing (or delete — :236 keeps the one record-specific contract, that the record stream is not filtered).
- Confidence: high

### `runner-core/tests/record-steps.test.js:104` — "controlRecordSteps: edit-step, and drop / restore of a step by its id, go as sent"
- Category: L3 (+L1 for the bodies)
- Evidence: `controlRecordSteps` sends `body: JSON.stringify(body)` (api-client.ts:562) — the `calls` deep-equal reads back the test's inputs, which :305 already proves for six other actions. The `{ ignored: true, reason }` mapping it asserts is the same branch as :341 (`JSON.stringify({ ok: true, ignored: why })`).
- Recommendation: delete.
- Confidence: high

### `runner-core/tests/record-steps.test.js:249`, `:277`, `:285` — 409 / 404 / abort on `streamRecordSteps`
- Category: L3
- Evidence: Same `postSse` branches as api-client.test.js:452 (409 conflict with reason), :134 (404 not-found), :176 / :480 (abort). `streamRecordSteps` adds no error handling of its own.
- Recommendation: delete (keep :261 — the 400→`server-error`→`apiErrorReason` path is covered nowhere else).
- Confidence: high

### `runner-core/tests/frontmatter.test.js:30` — "parseFrontmatter: tags as flow list"
- Category: L3
- Evidence: :35 ("tags normalize to lowercase") parses the same flow list shape including a quoted item (`"Needs-Network"`) and asserts the same output; :30 adds no branch.
- Recommendation: merge into :35.
- Confidence: high

### `runner-core/tests/frontmatter.test.js:61` — "parseFrontmatter: no dataSources key when absent"
- Category: L3
- Evidence: `assert.deepEqual(parseFrontmatter('---\ntags: [x]\n---\n'), { tags: ['x'] })` — every other `deepEqual` on dataSources-free input (:12, :27, :32, :87, :105) already proves no `dataSources` key appears.
- Recommendation: delete.
- Confidence: high

### `runner-core/tests/regression-corpus.test.js:197` — "no section kinds appear: <file>" (one per sectionless corpus file)
- Category: L3
- Evidence: Row :185 asserts `classifyLines(text)` deep-equals `legacyClassifyLines(text)`, and the legacy classifier (:101-130) can only emit `frontmatter|blank|heading|step|prose`. So if :185 passes for a file, :197 cannot fail for it; if :185 fails, :197 adds nothing. Same reasoning makes the `extractSteps` half of :189 implied by :185 (both sides derive steps from `kind === 'step'` with the same prefix strip); only its `resolveRunLines(text, [])` half adds coverage.
- Recommendation: delete the :197 rows; keep :189 for its `resolveRunLines` assertion (or, per the `resolveRunLines` L7 finding below, retarget it to `resolveRunSelection(text, []).lines`).
- Confidence: high

### `resolveRunLines` tests — `runner-core/tests/step-lines.test.js:242,246,250,255,261,266,274,279`; `run-selection.test.js:137,157`; `sections.test.js:65,71,78`
- Category: L7 (rewrite, not delete — the branches they reach are live)
- Evidence: `grep -rn "\bresolveRunLines\b" steptix-vscode/src flick-vscode/src src` → one hit, a comment (steptix-vscode/src/extension/commands/index.ts:1171). `resolveRunLines` is a two-line wrapper: `const selection = resolveRunSelection(text, requestedLines); return selection.scope === 'main-flow' ? selection.lines : [];` (runner-core/src/step-lines.ts:570-573). Production (run-controller.ts) imports `resolveRunSelection` directly. Its doc comment ("this is what `runLines([])` and the breakpoint trimmer read") is stale.
- Recommendation: delete the export; rewrite the step-lines.test.js SAMPLE rows (heading-only fallback, blank-line fallback, past-the-end, mixed selection — branches run-selection.test.js does not hit on a sectionless doc) as `resolveRunSelection(SAMPLE, x)` assertions; delete run-selection.test.js:137/:157 and sections.test.js:65/:71/:78, whose shapes run-selection.test.js:45-131 already assert on `resolveRunSelection`.
- Confidence: high

### `runner-core/tests/sections.test.js:78` — "resolveRunLines: an empty result is not the same as an empty request"
- Category: L3 (in addition to the L7 above)
- Evidence: `assert.deepEqual(resolveRunLines(text, [24]), [])` is :71 verbatim; `assert.notDeepEqual(resolveRunLines(text, []), [])` is implied by :65 (`[13, 17, 18]`).
- Recommendation: delete.
- Confidence: high

### `runner-core/tests/sections.test.js:84` — "classifySelectedSteps: a requested body line selects nothing"
- Category: L3
- Evidence: `assert.deepEqual(classifySelectedSteps(read('classification.md'), [24]), [])` is the same call on the same fixture as run-selection.test.js:170 (`classifySelectedSteps(text, [24])` → `[]`).
- Recommendation: delete (keep run-selection.test.js:170, which sits with the scope-argument tests).
- Confidence: high

### `isStepLine` / `nearestStepAtOrBelow` / `nearestStepAtOrAbove` — `runner-core/tests/step-lines.test.js:128` ("isStepLine + nearest helpers"), `sections.test.js:96` ("isStepLine: false for a section body line…"), `sections.test.js:102` ("nearestStepAtOrBelow/Above: skip over section bodies"), and the last four assertions of `sections.test.js:296`
- Category: L7
- Evidence: `grep -rn "nearestStepAt" steptix-vscode/src flick-vscode/src src` → nothing. `isStepLine` hits in production are all LOCAL functions (steptix-vscode/src/extension/commands/index.ts:380 `const isStepLine = (line: number)…`, src/ui/renderer/components/Editor.tsx:31, src/stats/store.ts:308); none imports runner-core's.
- Recommendation: delete the three exports and these tests (keep :296's `extractSteps`/`extractSections` assertions).
- Confidence: high

### `runner-core/tests/repl.test.js:304` — "the split decides `keyword` and `sort_key` twice, and differently"
- Category: L3
- Evidence: All four assertions are exact repeats: `maskIfSecret('keyword','search') → '******'` (:207), `maskIfSecret('payment.keyword','search') → 'search'` (:257), `maskIfSecret('sort_key','abc') → '***'` (:297), `maskIfSecret('payment.sort_key','abc') → 'abc'` (:256).
- Recommendation: delete (the "pair is the whole split" point is a comment, not a new check).
- Confidence: high

### `runner-core/tests/sse-parser.test.js:47` — "parses a step:skip frame like any other event type"
- Category: L3 + L1
- Evidence: `SseParser.push` never inspects the event name beyond storing it (runner-core/src/sse-parser.ts:58-59), so type-agnosticism is already proven by :5 (`event: step:pass`) and :25 (`event: x`). The last four assertions `JSON.parse(frames[0].data)` → `parsed.type/line/reason` parse the test's own literal.
- Recommendation: delete.
- Confidence: high

### `runner-core/tests/test-meta.test.js:124` — "resolveSection: missing $VARs left untouched"
- Category: L3
- Evidence: `resolveSection` maps `resolveValueFromEnv` over the entries; :111 already proves the mapping and :103 ("missing $VAR returns the literal $VAR") proves the missing-var branch with the same input class.
- Recommendation: delete.
- Confidence: medium

### `flick-vscode/tests/unit/browser-launcher.test.ts:132` — "cache: an overridden call does not leak its result to a subsequent uncached call"
- Category: L2 (and Defect: name does not match what it checks)
- Evidence: Both calls pass deps, and `detectInstalled` skips the cache entirely whenever deps are given — `const hasOverrides = deps !== undefined && Object.keys(deps).length > 0; if (!hasOverrides && cachedDetection) return cachedDetection;` … `if (!hasOverrides) cachedDetection = result;` (src/extension/browser-launcher.ts:69-85). So the second assertion `assert.equal(overriddenAgain.chrome, null)` holds even if overridden calls DID write the cache (they never read it). No uncached call is ever made, and the closing `clearDetectionCache(); // assert it's empty here too` asserts nothing.
- Recommendation: rewrite — make the overridden call, then call `detectInstalled()` with no deps while a spy on the module's default `existsSync`/`which` path can tell recompute from cache-hit (or expose a test-only `__cachedDetection()` getter and assert it stays `null` after an overridden call). Otherwise delete.
- Confidence: high

### `flick-vscode/tests/unit/browser-launcher.test.ts:253` — "profile dir is created with recursive: true"
- Category: L3
- Evidence: The happy-path test already asserts `assert.deepEqual(mkdirCalls[0], { p: '/tmp/.flick/chrome-profile', opts: { recursive: true } })` (:197-200); this repeats it for the edge engine, through the same unconditional `mkdirSync(opts.profileDir, { recursive: true })` (browser-launcher.ts:203).
- Recommendation: delete.
- Confidence: high

### `flick-vscode/tests/unit/browser-launcher.test.ts:356` — "poll timeout…" (the line `assert.equal(POLL_INTERVAL_MS, 200)`)
- Category: L5 (one assertion inside an otherwise High test)
- Evidence: Restates `export const POLL_INTERVAL_MS = 200;` (browser-launcher.ts:58); the comment says it is a "sanity check exported constant exists".
- Recommendation: drop that line (and the `POLL_INTERVAL_MS` import); keep the rest of the test.
- Confidence: high

### `flick-vscode/tests/unit/cdp-discovery.test.ts:194` — "empty Browser field → engine \"unknown\""
- Category: L3
- Evidence: `Browser: ''` reaches `classifyEngine('')` and falls through every `startsWith` arm to `return 'unknown'` — the same branch as the table row `{ browser: 'SomeOtherBrowser/1.0', expected: 'unknown' }` at :135. The `tabs: []` assertion repeats :112.
- Recommendation: merge into the :124 table as `{ browser: '', expected: 'unknown' }` (or, for a new branch, make the row a NON-string `Browser`, which hits the `typeof … === 'string' ? … : ''` fallback at cdp-discovery.ts:56-59).
- Confidence: medium

### `flick-vscode/tests/unit/parse-steps.test.ts:37` — "quoted content inside a step is preserved"
- Category: L3
- Evidence: `parseSteps` has no quote handling at all (split, trim, strip `^\s*\d+[.)]\s+` / `^\s*[-*]\s+`; src/shared/parse-steps.ts). A line with quotes takes exactly the path of "plain lines become one step each" (:7).
- Recommendation: delete (or replace with a case that does hit a branch, e.g. `'- 1. nested'` or `'10) Step'`).
- Confidence: medium

## Test defects

### `runner-core/tests/errors.test.js:171` — "actions reference real-looking command ids"
- Category: Defect (name overclaims; misses a real bug)
- Evidence: Asserts only `action.label.length > 0` and `action.command.length > 0`. STX020's action `{ label: 'Reopen as Text', command: 'steptix.reopenAsText' }` (errors.ts:188) names a command that is neither in steptix-vscode/package.json nor registered (`grep -rn "reopenAsText" steptix-vscode/src` → nothing), and the test passes.
- Recommendation: rewrite to assert every `action.command` is either a `workbench.*` built-in or a command contributed in steptix-vscode/package.json `contributes.commands` — which today fails on `steptix.reopenAsText` (or delete STX020 per the L7 finding).
- Confidence: high

### `runner-core/tests/protocol.test.js:54` — "isWebviewMsg: accepts every webview variant"
- Category: Defect (claim not met; list has already drifted)
- Evidence: The guard accepts `t === 'rerunFailedRows'` (protocol.ts:1967) and the union has `type: 'rerunFailedRows'` (:1838), but the test's list omits it. runner-view.ts:157 drops whatever this guard rejects, so this is the live filter; a hand-kept list cannot catch a type added to the union and forgotten in the guard.
- Recommendation: add `rerunFailedRows`; better, derive the expected set from the `WebviewToHostMsg` union's `type:` literals in protocol.ts source (source-pin) so a forgotten type fails.
- Confidence: high

### `runner-core/tests/frontmatter.test.js:20` — "parseFrontmatter: disabled false / missing returns no disabled key"
- Category: Defect (name contradicts assertion)
- Evidence: The first assertion is `assert.deepEqual(parseFrontmatter('---\ndisabled: false\n---\n'), { disabled: false })` — a `disabled` key IS returned. Only the "missing" half matches the name.
- Recommendation: rename to "disabled: false is kept as false; absent stays absent".
- Confidence: high

### `runner-core/tests/step-lines.test.js:266` — "resolveRunLines: selection past the last step returns empty (nothing to run)"
- Category: Defect (misleading fixture)
- Evidence: `const text = SAMPLE + '\n7. trailing prose without numbered list under Steps';` is built and never used — the assertion is `resolveRunLines(SAMPLE, [99])`. The comment then argues about line 7 of `text` ("the trailing line is still a step at line 7") before abandoning it. A reader assumes `text` is what is tested.
- Recommendation: delete the `text` line and the comment; keep `resolveRunSelection(SAMPLE, [99])` → `[]` (see the `resolveRunLines` L7 finding).
- Confidence: high

### `runner-core/tests/regression-corpus.test.js:1-38` — header claim
- Category: Defect (stale rationale, affects how failures will be read)
- Evidence: The header says "The filter predicate (`extractSections(text).length === 0`) is logically equivalent to the property being asserted" and "`section-heading` is the only new classification". Since 5629c90 ("Make numbered items under a #### heading inert, everywhere") `classifyLines` has a third new branch, `inert-step` (step-lines.ts:163/:171), reachable in a SECTIONLESS file (`## Steps` … `#### Notes` … `2. x`). Today no sectionless corpus file has `####` under `## Steps` (only fixtures/sections/classification*.md, which are sectioned and filtered out), so the suite is green — but the first such fixture anyone adds will fail every `unchanged classification` row for it, for an intended behaviour.
- Recommendation: update the header, and filter the corpus by that property too (exclude a document when `classifyLines` emits any `inert-step`, exactly as sectioned ones are excluded) so the guard keeps meaning "nothing changed for documents the new grammar does not touch".
- Confidence: high

### `runner-core/package.json` — `npm test` runs `../dist/` with no `pretest` build (affects all 17 runner-core test files)
- Category: Defect (systemic; tests can silently run stale code)
- Evidence: scripts are `"build": "tsc"`, `"prepare": "npm run build"`, `"test": "node --test tests/*.test.js"` — no `pretest`. Every runner-core test imports `'../dist/…'` (e.g. api-client.test.js:3, step-lines.test.js:14). After editing runner-core/src, `npm test` in runner-core tests whatever `dist/` was last built, and passes or fails for the old code. CI is safe only because `npm ci --prefix runner-core` triggers `prepare` (.github/workflows/unit-tests.yml:57). CLAUDE.md: "Keep `npm test` building first (`pretest`). Several suites run `dist/` on purpose, and a stale one tests old code without any warning."
- Recommendation: add `"pretest": "npm run build"` to runner-core/package.json.
- Confidence: high

### `flick-vscode/tests/integration/controller.test.ts:251` — "an unreachable server produces an error result entry and an error toast"
- Category: Defect (the claimed condition is not what is exercised)
- Evidence: The comment says "Port 1 is reserved and refuses connections — a genuine network failure", and the test sets `flick.apiUrl` to `http://127.0.0.1:1`. Port 1 is on the WHATWG fetch "bad port" list, so undici rejects before any socket is opened — measured on this machine: `fetch('http://127.0.0.1:1/sessions')` → `fetch failed | bad port`. The assertions still pass (any fetch rejection takes the same catch), but no network failure is ever produced, and a refactor that special-cased real connection errors (e.g. `cause.code === 'ECONNREFUSED'`) would not be tested here.
- Recommendation: start and stop a `FakeApiServer` and point `flick.apiUrl` at its now-closed port, as :429 already does — a real ECONNREFUSED (1–7 ms on Windows loopback, measured).
- Confidence: high

## Duplication clusters
- `postSse` shared SSE path (one code path behind `streamSteps`, `compileCodeBehind`, `streamRecordSteps`): frame order/pass-through `api-client.test.js:106`, `:386`, `:422`, `:496`, `record-steps.test.js:74`, `:178`; 401 `api-client.test.js:122`, `:468`; 404 `api-client.test.js:134`, `record-steps.test.js:277`; 409 `api-client.test.js:452`, `record-steps.test.js:249`; abort `api-client.test.js:176`, `:480`, `record-steps.test.js:285` → keep api-client :106, :122, :134, :176, :422, :452 and record-steps :149 (route), :236 (unfiltered), :261 (400→reason), :401 (onOpen); drop the rest.
- Guard type lists: `protocol.test.js:54` vs `record-steps.test.js:140` (same eight `record*` types for `isWebviewMsg`); `protocol.test.js:11` vs `record-steps.test.js:132`, `:136` (`isHostMsg`, dead) → keep protocol.test.js:54 (fixed per the defect), drop the record-steps copies.
- Consumer split on `fixtures/sections/classification.md`: `sections.test.js:65`, `:71`, `:78`, `:84` vs `run-selection.test.js:137`, `:157`, `:170` → keep run-selection.test.js (its file's subject), retargeted to `resolveRunSelection`; drop the sections.test.js copies.
- Secret-split restatements in `repl.test.js`: `:304` (all four asserts exact repeats of :207, :257, :297, :256); `:294` overlaps `:174` (`key`, `MACHINE_KEY`) → drop :304.
- Wrapped call-site shapes: `section-index.test.js:201-227` vs root `tests/section-index-cli-parity.test.ts:73-86` (same `doc()` builder, same continuation shapes). Different behaviour (runner-core pins the index's answer; the root suite pins agreement with the CLI parser) → keep both; noted only so neither is "deduplicated" by mistake.
- `browser-launcher.test.ts:155` / `:203` / `:253` (chrome arg shape and recursive mkdir asserted three times) → keep :155 and :203 (edge binary + args), drop :253.

## Cost concerns
- `runner-core/tests/regression-corpus.test.js:84` walks the working tree synchronously at import time; in the main checkout that is ~5,200 files under `templates/`/`fixtures/` including 3,845 Chrome-profile files under `templates/init/.steptix/cdp-profiles/` — `statSync` on each, for a corpus of ~94 `.md` files. Skipping dot-directories (see Flakiness) removes ~75 % of the stat calls. It also generates ~240 near-identical test rows (3 per file), one third of which are implied by another row (see L3 finding).
- `flick-vscode/tests/integration/controller.test.ts:390` and `:816`: fixed `delay(100)` / `delay(50)` used to wait for something NOT to happen; `await controller!.drain()` is deterministic and returns as soon as the handler settles.
- No real browsers, child processes or fixed ports anywhere in the batch; flick's fake servers bind port 0.

# E01_steptix_vscode_a

## Summary
- Files: 11 · tests (approx): 407 · High ~328 · Medium ~76 · Low 3 · Defects 4 (1 systemic) · Flakiness risks 4 (all medium, 0 high)
- This batch is strong. The four record-steps files (189 tests) are almost entirely HIGH: they drive the pure `record-steps-core.ts` exactly as `step-recorder.ts` does, assert whole before/after documents, replay change events logged from a real VS Code host, and back the scenarios with three seeded (mulberry32) property runs that check they did "enough of each op" before they pass. `record-secret-parity` is a model of the house parity idiom. `lm-bridge-core` and `lm-bridge-env` are byte-level contract tests of pure modules. `server-manager` uses injected probe/spawn/sleep/clock fakes, but the polling and triage policy under test is the unit's own logic, so they are not over-mocked (no L6).
- Low value is rare and small: a constructor that returns a literal (record-steps:1203), a one-line template already covered elsewhere (lm-bridge-core:563), and an exact, undocumented headline string (server-manager:713). The defects are weak assertions inside tests that are otherwise good: half of lm-bridge-core:624 cannot fail, server-manager:700 is tautological, and server-url:79 pins a constant to its own literal when the drift that matters is against `src/config/defaults.ts`.
- **Systemic defect:** `npm test` in steptix-vscode can test a stale runner-core. Its `pretest` builds only the repo root (`npm run build --prefix ..`). But `record-steps-core.ts`, `lm-bridge-env.ts`, `server-manager.ts` and `server-url.ts` import `steptix-runner-core`, and that resolves to `runner-core/dist`. If you edit `runner-core/src` and do not rebuild, these suites test old code without any warning. CI escapes this, because `npm ci --prefix runner-core` runs `prepare`. `record-secret-parity.test.js:63-71` documents the same trap and works around it.
- Your questions: `live-shards.test.js` is a sensible unit subject. Every export it tests is called by `runLiveTest.cjs`, and the failure modes are silent: a stale `.steps.ts` copied in, a `toolsDir` that climbs out of the workspace. `third-party-notices.test.js` is a real licence-compliance guard, not a change-detector: it runs the build script's refusal paths on synthetic fixtures and never snapshots the real notices file. There is no L3 overlap with the root suite. The root `tests/record-steps-*.test.ts` test the server's `DraftEngine`, which is a different implementation. `tests/lm-bridge-real-sdk.test.ts` runs the same shapers through the real OpenAI SDK, so it covers them at a different level.

## Flakiness risks

All 407 tests were checked for the addendum mechanisms. Four risks were found, all medium. Everything else is listed afterwards as checked and guarded.

### `steptix-vscode/tests/server-manager.test.js:250` — "start: spawns with the configured command/cwd/log and reports ready" (also `:272` "start: an unknown response keeps polling rather than giving up")
- Mechanism: the test injects `sleep: noSleep` but no `now`, so `startServerAndWait` uses `Date.now` (server-manager.ts:696 `const now = args.now ?? Date.now;`). The budget is `readyTimeoutSeconds: 1` (`config()` at :213-218). The test passes only if the loop gets through three iterations (`probes < 3 ? down/unknown : healthy`) before `while (now() < deadline)` (server-manager.ts:726) expires. A process that is descheduled for more than 1 s between `spawn` and the third probe returns `timeout`. That takes a heavily loaded box, but the budget is still wall-clock.
- Risk: medium (narrow window)
- Fix: pass `now: () => 0`, as `:306` already does with a fake clock, or use `readyTimeoutSeconds: 60`. Neither test is about the budget.
- Evidence: `:306` shows the author knew the clock should be injected for the timeout path. The positive paths were left on the real clock.

### `steptix-vscode/tests/server-manager.test.js:68`–`:190` — the positive-path `defaultHealthProbe` tests ("probe: our server reads as healthy…", ":80 inspector null…", ":93 FOREIGN", ":104 a 404 is UNKNOWN", ":115 non-JSON…", ":178 a trailing slash…")
- Mechanism: each test makes a real loopback HTTP round trip to a port-0 stub under a 1000 ms per-probe abort (`await defaultHealthProbe(s.url, 1000)`). If the timer fires first, the result is `kind: 'down'` with `no answer within 1000 ms`, and every one of these assertions fails. The first `fetch` in the process also pays for undici's lazy initialisation. On a Windows CI runner with three other `node --test` processes and Defender running, more than 1 s is unusual but realistic.
- Risk: medium
- Fix: use a generous timeout such as `10_000` on the paths that are not about the timeout. Keep the 50 ms value only in `:158`, which tests timeouts on purpose.
- Evidence: reasoning only. On this machine a refused loopback connect took 2–14 ms, so the DOWN tests `:136`/`:143` are not at risk from the Windows refused-connection retry.

### `steptix-vscode/tests/third-party-notices.test.js:19` — `after` cleanup (all 9 tests), and the same pattern at `steptix-vscode/tests/server-url.test.js:26` (cleanup in `finally` for all 5 tests) and `steptix-vscode/tests/record-steps.test.js:1107` (`t.after`)
- Mechanism: the cleanup runs `fs.rmSync(dir, { recursive: true, force: true })` with no `maxRetries` on files written moments earlier. In third-party-notices some of those files were just written by a spawned `node` child (`THIRD-PARTY-NOTICES.txt`). On Windows, antivirus or the indexer can briefly hold a handle, and `rmSync` then throws EBUSY, EPERM or ENOTEMPTY. `force` does not suppress those errors. Throwing inside `finally` or an `after` hook fails the test, or the whole file, for a cleanup reason. CI is Windows-only (`.github/workflows/unit-tests.yml`).
- Risk: medium (Windows only)
- Fix: `fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })`, or wrap the cleanup in try/catch, because a leftover temp dir is harmless.
- Evidence: reasoning. These are the antivirus-lock mechanism named in the rubric. No commit in the git history mentions it.

### Systemic — every test in `record-steps*.test.js`, `lm-bridge-env.test.js`, `server-manager.test.js` and `server-url.test.js` (state dependence on a stale `runner-core/dist`)
- Mechanism: `steptix-vscode/package.json` has `"pretest": "npm run build --prefix .."`, which builds the root only. The modules under test import `from 'steptix-runner-core'`: record-steps-core.ts:38-44 (`classifyLines`, `parseConfig`), lm-bridge-env.ts:13 (`parseEnv`, `scanServerEnv`), server-manager.ts:14, server-url.ts:1-5 (`readMachineServerUrl`). That package resolves to `runner-core/dist` (runner-core/package.json `"main": "./dist/index.js"`). Whether the tests pass therefore depends on whether someone rebuilt runner-core since its last source change. The tests can be green against old code, or red after an unrelated change, depending on state outside the run.
- Risk: medium (local runs and WSL clones only; CI's `npm ci --prefix runner-core` runs `prepare`, which builds it)
- Fix: change pretest to `npm run build --prefix .. && npm run build:runner-core`, in line with CLAUDE.md's rule "Keep `npm test` building first".
- Evidence: `record-secret-parity.test.js:63-71` says that deleting a clause from runner-core's source "left it 12/12 green" through the package specifier. It worked around the problem locally by importing `../../runner-core/src/repl.ts`.

### Checked and well-guarded (not flagged)
- `live-shards.test.js:89` — the pull-queue order is gated by a promise, with a 10 s backstop, instead of timers. Commit `53e176d` ("Order runPool's pull-queue test by a gate, not by timers") fixed an earlier timer race. `:69` uses `setTimeout(r, 1)`, but its assertions (each item once, `peak === 2`) do not depend on timer order, and both workers start synchronously.
- `server-manager.test.js` — every stub listens on port 0. `:158` times out against a server that never answers, so it is deterministic. `:306` uses an injected fake clock. `:333` aborts from inside the injected sleep. The `AutoStartGuard` tests inject the clock. `decideServerAction` tests never reach the default runtime discovery, so they never read the real `%LOCALAPPDATA%`. `:136`/`:143` close a stub and then probe its port. Reuse of that port within milliseconds is possible in theory but negligible, so it is not flagged. The temp dirs are never removed (a leak, not a flake).
- `server-url.test.js` — passes `deps.env` instead of mutating `process.env`, and redirects both `LOCALAPPDATA` and `XDG_CONFIG_HOME` to a mkdtemp dir. That is correct on macOS too, because runner-core uses XDG there when it is set.
- `lm-bridge-core.test.js` and `lm-bridge-env.test.js` — pure functions. Port 18790 appears only as a string, and nothing binds a socket.
- `record-steps*.test.js` — pure core, seeded PRNG. `RECORD_SEED`, `RECORD_VERBOSE` and `RECORD_STEPS_SEED` are opt-in debug knobs. Fixtures are built with `'\n'` joins, so CRLF checkouts cannot change them. `record-steps.test.js` imports the root `dist/parser/markdown.js` read-only, and pretest builds it.
- `record-secret-parity.test.js` — reads source text read-only. Its readers tolerate CRLF checkouts, which GitHub's Windows runners default to: `.` stops before `\r` and the `;` comes first, and bodies are normalised with `\s+`.
- `third-party-notices.test.js:152` — skips itself (`t.skip`) when a junction cannot be created, and its `after` hook unlinks the link before the recursive delete.

## Per-file verdicts
| File | Tests | Verdict (High/Medium/Mixed/Low) | One-line note |
|---|---|---|---|
| steptix-vscode/tests/record-steps.test.js | 79 | High | Whole before/after documents through the pure core. Several cases cross-check with the server's own parser (root dist, which pretest builds). `:1143` is a webview mirror parity test. One trivial constructor test (`:1203`). |
| steptix-vscode/tests/record-steps-authored.test.js | 41 | High | Lines the author types during a live recording, driven through a `Session` that mirrors step-recorder.ts and a FakeServer modelled on draft-engine.ts. Two 300-seed property runs, each with floors proving every op ran. Webview parity at `:2087`/`:2120`. |
| steptix-vscode/tests/record-steps-edit.test.js | 52 | High | Reword, delete, restore and undo of recorded lines. Most cases are regressions named after review findings (P1–P12, D1, D3, C1, E). No low-value cases. |
| steptix-vscode/tests/record-steps-live.test.js | 17 | High | The fail-safe rule, replayed with the exact change events a VS Code host logged (offsets 156/170), plus a 400-seed property run that tracks which side owns each character. `:392` `assert.equal(typeof core.removeUnfinishedRecording, 'function')` is a redundant line inside a real test. |
| steptix-vscode/tests/record-secret-parity.test.js | 18 | High | Parity idiom done well. The server's regex literals and function bodies are read from source and compared with the runner-core and webview mirrors, then backed by behavioural corpora and call-site scans with anti-vacuity checks. |
| steptix-vscode/tests/lm-bridge-core.test.js | 75 | High | Byte-level OpenAI-shape contract and error-text tests. Error wording is a contract here, because PR #110 shows it in hovers. One redundant one-liner (`:563`). Half of `:624` cannot fail. |
| steptix-vscode/tests/lm-bridge-env.test.js | 36 | High | `.env` rewriting that keeps other lines intact, masks the token in previews, preserves CRLF and handles the overlay. The comment-text assertions follow wording the stories require (copilot-lm-bridge.md:172-175, env-overlay-awareness.md:50/175), so they are medium, not L4. |
| steptix-vscode/tests/server-manager.test.js | 53 | High | The probe's four outcomes over real loopback HTTP, then the spawn/poll policy, triage, runtime discovery, guard, settings and the manifest's machine-scope security check. Two flakiness risks (budgets of 1 s / 1000 ms). One tautological line and one L4 headline. |
| steptix-vscode/tests/server-url.test.js | 5 | High | The four-link resolution chain with isolated env and user root. `:79` pins `DEFAULT_SERVER_URL` to its literal; parity with `src/config/defaults.ts` would be stronger. |
| steptix-vscode/tests/live-shards.test.js | 22 | High | A sensible subject: tests/integration/liveShards.cjs, whose every tested export is used by runLiveTest.cjs. The workspace-copy, config-rebase and `.env`-pointing cases each match an incident CLAUDE.md describes. scheduleOrder and runPool are medium. |
| steptix-vscode/tests/third-party-notices.test.js | 9 | High | A real licence guard: the build stops on a missing licence, a disallowed licence, or an asset that no source map accounts for, and carries NOTICE files. It also covers the CLI-through-a-junction regression. |

## Low-value tests

### `steptix-vscode/tests/record-steps.test.js:1203` — "a fresh block is starting, with no actions, no draft and nothing drafting"
- Category: L5
- Evidence: `newRecordingState` (src/extension/record-steps-core.ts:5566-5577) returns an object literal that copies three fields from its args. The test `assert.deepEqual(fresh(), { uri: 'file:///t.md', file: 't.md', mode: 'cursor', phase: 'starting', pickArmed: false, actions: [], draft: null, drafting: false })` restates that literal. The one behaviour that matters, the initial `phase: 'starting'`, is already relied on by `:1239` ("an action before record:started still moves the block to recording"). `:1328` compares the state with `fresh()` after ignored frames.
- Recommendation: delete
- Confidence: high

### `steptix-vscode/tests/lm-bridge-core.test.js:563` — "the qualified id is what .env carries after gateway/"
- Category: L3 (and L5)
- Evidence: `qualifiedModelId` is `` return `${model.vendor}/${model.id}`; `` (lm-bridge-core.ts:545-547). The test asserts `qualifiedModelId({ vendor: 'copilot', id: 'gpt-4.1' }) === 'copilot/gpt-4.1'`. `:670` already asserts the same output through its only production caller, `modelsListBody` (`body.data.map((m) => m.id)` → `['copilot/gpt-4.1', 'copilot/claude-sonnet-4']`), and `:703` does too (`id: 'copilot/gpt-5.6-luna'`).
- Recommendation: merge into `steptix-vscode/tests/lm-bridge-core.test.js:670`, i.e. delete it
- Confidence: high

### `steptix-vscode/tests/server-manager.test.js:713` — "describeHealth: the headline names the build"
- Category: L4
- Evidence: `assert.equal(headline, `Steptix server on ${LOCAL} — v1.0.0-beta.1 (b700473, modified)`)` pins the whole headline sentence. No doc or spec quotes it: grep for `Steptix server on` finds only server-manager.ts:279 and this test. The behaviour the test names, that the headline carries the build, comes from `describeServerVersion`, which `:703` already pins in all four forms. Rewording the prefix ("Steptix server on" → "Server at") breaks this test and catches no bug.
- Recommendation: rewrite to `assert.match(headline, /v1\.0\.0-beta\.1 \(b700473, modified\)/)`, with an optional `assert.ok(headline.includes(LOCAL))`
- Confidence: medium

## Test defects

### `steptix-vscode/tests/lm-bridge-core.test.js:624` — "neither builder hands out a reference to the usage it was given" (the stream half, lines 635-637)
- Category: Defect (L2, partial)
- Evidence: `const finish = JSON.parse(streamFrames(shape)[1].replace(/^data: /, '')); finish.usage.completion_tokens = 999; assert.equal(shape.usage.completion_tokens, 7);`. `streamFrames` returns strings built with `JSON.stringify` (lm-bridge-core.ts:606, `const sse = (payload) => `data: ${JSON.stringify(payload)}\n\n``). `JSON.parse` always produces a fresh object, so this half passes even if `streamFrames` aliased `c.usage`. The test's own comment warns against exactly this mistake: "Mutating a second body built from a different object proves nothing". The `chatCompletionBody` half (lines 631-633) is valid.
- Recommendation: delete lines 635-637. A string cannot alias, so there is nothing to test, and the name could become "chatCompletionBody does not hand out…".
- Confidence: high

### `steptix-vscode/tests/server-manager.test.js:694` — "log tail: does not include the whole file when it is short" (line 700)
- Category: Defect (tautological assertion)
- Evidence: `assert.equal(readFileSync(logPath, 'utf8').includes('a'), true);` reads back the fixture the test wrote two lines earlier (`writeFileSync(logPath, ['a', …, 'g'].join('\n'))`), so `readLogTail` never runs on that line. The real check is the line before: `assert.equal(tail, 'c | d | e | f | g')`.
- Recommendation: delete line 700. If the intent was "the tail omits the early lines", assert `assert.ok(!tail.includes('a'))`.
- Confidence: high

### `steptix-vscode/tests/server-url.test.js:79` — "nothing anywhere is the default serve listens on…" (line 79)
- Category: Defect (an assertion that cannot catch the drift it exists for; L5 on that line)
- Evidence: `assert.equal(DEFAULT_SERVER_URL, 'http://127.0.0.1:3100');` compares the constant with its own literal. The source names the real risk at server-url.ts:26-28: "Nothing links the two copies (the extension bundles separately from the framework), so change both together", meaning `src/config/defaults.ts` `server: { host: '127.0.0.1', port: 3100 }`. If the server's default moves to 3200, this line stays green. The rest of the test is good.
- Recommendation: rewrite the line as a parity check. Import or read `src/config/defaults.ts`'s `DEFAULT_CONFIG.server` (the root `dist/config/defaults.js` exists after pretest) and assert ``DEFAULT_SERVER_URL === `http://${host}:${port}` ``.
- Confidence: high

### Systemic — steptix-vscode `pretest` does not build runner-core
- Category: Defect (tests can run stale code)
- Evidence: see the last entry under Flakiness risks. `"pretest": "npm run build --prefix .."` builds the root only. `record-steps-core.ts`, `lm-bridge-env.ts`, `server-manager.ts` and `server-url.ts` import `steptix-runner-core`, which resolves to `runner-core/dist`.
- Recommendation: `"pretest": "npm run build --prefix .. && npm run build:runner-core"`
- Confidence: high

## Duplication clusters
- Qualified model id: `lm-bridge-core.test.js:563`, `:670`, `:688` → keep `:670`/`:688`, drop `:563`.
- `recordingStatusTextInline` parity, panel copy vs core: `record-steps.test.js:1143` (starting, recording and finishing states) and `record-steps-authored.test.js:2120` (paused states and `draftStepMarksInline`) → both add cases, so keep both. You could merge the state lists into one table so the next state gets added in one place.
- Panel masking behaviour, outside this batch but overlapping it: `record-secret-parity.test.js:788` (`MASK_CORPUS`, which already includes the BOM cases) and `:417` (`SCOPE_CORPUS`, bindings/unmask) cover the same cases as `steptix-vscode/tests/variables-panel.test.js:539` (BOM) and `:394-:412` (bindings/unmask), for `maskRecordSecretsInline` and `maskIfSecretInline` alone. Keep the parity corpora. Whoever reviews variables-panel.test.js should treat those panel-only cases as partly redundant.
- No cross-suite L3: the root `tests/record-steps-{draft-locks,edit,prompt,recorder,toolbar}.test.ts` test `src/recorder/*` (DraftEngine, StepRecorder), which is a different implementation from `record-steps-core.ts`. `tests/lm-bridge-real-sdk.test.ts` runs the same `chatCompletionBody`/`streamFrames` through the real `@pkent/aigateway` SDK, so it covers them at a different level.
- Helper duplication, not test duplication: the `Session` class, `lineChange`, `anchorAt`, `FIXTURE` and `prng` are copied, with small differences, across `record-steps-authored.test.js:66`, `record-steps-edit.test.js:72` and `record-steps-live.test.js:110`. The three fake servers (`FakeServer` :469, `IdServer` :1143, `EditServer` edit:188) each hand-model `src/recorder/draft-engine.ts` placement (`mapIndex`/`addStep`). Nothing pins these fakes against the real `DraftEngine`, so a change in the engine's placement rule would not show up here. A small root-side contract test that runs the same (afterStep, revision) cases on the real `DraftEngine` would close that gap.

## Cost concerns
- `record-steps-authored.test.js:912` and `:1287` (300 seeds × 40 ops each) and `record-steps-live.test.js:501` (400 seeds × 40 ops) are CPU-only and deterministic, with a per-character ownership model that splices arrays on every op. They are probably the slowest tests in this suite, but they are justified: they found the bugs that edit:688-1508 pin individually. No action needed.
- `server-manager.test.js:652` writes a 3 MB file to `os.tmpdir()` and never deletes it. `server-manager.test.js` (5 mkdtemp sites, 8 dirs per run) and `live-shards.test.js` (`tmpDir()`, about 12 dirs per run) leak temp dirs on every run. Add cleanup, using the `maxRetries` form from the flakiness fix.
- `third-party-notices.test.js:142/:152/:171` each spawn a real `node` child. Each is justified: they cover the CLI entry point and the junction/realpath regression, which an import cannot reach.

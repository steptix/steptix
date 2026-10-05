# R04_codebehind_misc

## Summary
- Files: 23 · tests (approx): 347 `it` blocks (~362 cases with `it.each`) · High ~300 · Medium ~42 · Low 5 · Defects 4 · Flakiness risks 3 (all medium)
- The batch is strong. Almost every test drives real code: the real parser and expander, the real loader and esbuild bundle, the real `executeStep`, `evaluateGuard` and `runTest`, and real HTTP. Mocks sit only at the browser and model boundary. The fake-AI tests are not L1, because the leak guard, the re-ask and the static backstops run between the stub and the assertion. Most tests guard named incidents ("Measured before the fix…").
- The same behaviour is tested at three levels — guard/unit, CLI runner (`runTest`) and API server — for condition code-behind, healed runs and compile parameters. This is deliberate: the CLI and the server have **separate** sidecar, token and parameter implementations, and several tests pin parity between them. It is not duplication.
- The low-value items are isolated, not systemic:
  - two same-level repeats in `guard-condition-codebehind`;
  - a happy-path repeat in `codebehind-conditions`;
  - one assertion on a property that was removed from `src/` (`lastRunDetails`);
  - a few lines that read the mocked core's own return value.
- The defects are weak assertions where a test claims more than it checks: the skill-param "mapping" in `codebehind-skill-params`, and the Stop-while-parked test in the debugger suite.
- Flakiness: no high risks. Three medium mechanisms:
  - 5 ms sleeps used to make two `new Date()` stamps differ;
  - per-test cold Chromium launches;
  - temp-dir removal without the `maxRetries` the EBUSY fix (f83c11b) gave the in-repo dirs.
- The writer lock test fixed in 272eca0 now waits on a cue and has no remaining timing race. Its only siblings in this batch are the recording sleeps.

## Flakiness risks

Already well guarded (not flagged):
- `codebehind-writer.test.ts:306` "waits out a lock on the file instead of failing the write". The lock is released on cue from `onLocked`, not on a timer (272eca0). The 90 s and 30 s budgets only bound PowerShell's output, and the process is killed in `finally`. The writer retries 20 × 100 ms after an awaited `onLocked` (src/codebehind/writer.ts:206-214). No residual race.
- `api-server-codebehind.test.ts:563/594` (409 lock tests) use an event gate (`holdCompile`: `entered` and `release`), not sleeps. They release in `finally`.
- `api-server-codebehind-debugger.test.ts:350` (run-control mid-run) posts run-control on `step:awaiting`. The server sets `pendingRunControl` synchronously in the same tick as the emit (session-manager.ts:8183-8195), so the POST cannot arrive before the run is parked.
- Every HTTP suite in the batch listens on port 0. Every in-repo `tests/.tmp-*` dir in the batch is used by exactly one test file (checked across `tests/`) and is removed with `maxRetries: 10, retryDelay: 100`.
- `codebehind-tabs` serves its pages through `context.route` (no port) and opens a fresh context per test. `openedBy` arms `waitForEvent` before the trigger. The 500 ms `timeoutMs` (:150) is on the negative path only, so a slow box cannot make it pass wrongly or fail.
- `codebehind-conditions.test.ts:261` uses `globalThis.__conditionRan`. Nothing else in `tests/` or `src/` touches that name, and the test asserts 0.

### `codebehind-recording.test.ts:327, :492, :546` — "overwrites the matched step, stamps it, and leaves the siblings alone" / "keeps the two occurrences apart…" / "a filed splice claims its own file's slot…"
- Mechanism: a wall-clock sleep makes two timestamps differ.
  - `await new Promise((r) => setTimeout(r, 5));` runs between `writeRecording` and `spliceRecording`.
  - The test then asserts `expect(after.steps[1]!.recordedAt).not.toBe(before.steps[1]!.recordedAt);`.
  - `recordedAt` is `new Date().toISOString()` (src/codebehind/recording.ts:260, :583), so the assertion holds only if the two stamps land in different milliseconds.
  - libuv schedules timers off a cached loop time, so the real elapsed time can be shorter than the nominal 5 ms. A backwards wall-clock step (NTP) also breaks the premise.
  - `:599` "a filed splice still matches a recording written before the field existed" sleeps the same way but asserts no timestamp, so that sleep is dead.
- Risk: medium (unlikely on any single run, but it is a timing-based assertion on three tests).
- Fix: fake only `Date` (`vi.useFakeTimers({ toFake: ['Date'] })` with `vi.setSystemTime(t1)` before the write and `t2` before the splice), or let `spliceRecording`/`writeRecording` take an injectable `now`. Delete the sleep at :599.
- Evidence: reading. This is the same family as the writer's "timed lock raced the retry budget" fix (272eca0).

### `codebehind-tabs.test.ts:246, :267, :274, :289, :296` — the five "ctx.browsers" tests
- Mechanism: every test launches 1–2 extra cold Chromium processes inside the test body.
  - The launch is `const own = await chromium.launch({ headless: true });` at :235. It runs once for the initial session and again from the launcher in "opens a browser…" (:246), "switches back…" (:274) and "closes a browser…" (:296).
  - These sit on top of the suite browser and the per-test context that `beforeEach` opens.
  - Two cold launches have to fit inside the 30 s `testTimeout`. vitest.config.ts itself warns that under full-suite load "closing a Chromium can take tens of seconds".
- Risk: medium
- Fix: build `session()` on the suite-wide `browser` with `browser.newContext()` for every test that does not exercise `browsers.close`. Keep a dedicated launch only for "closes a browser and drops it from the list", and give that test an explicit 60 s timeout.
- Evidence: reasoning about launch cost under parallel workers. No failures in `git log` for this file.

### Temp-dir removal without retries — `codebehind-upload.test.ts:38`, `codebehind-section-rows.test.ts:43`, `codebehind-skill-params.test.ts:324` (+ `:331-333` in `beforeEach`), `api-server-codebehind.test.ts:467` (`rmSync`, `afterEach`), `api-server-codebehind-debugger.test.ts:228` and `:491` (inside the test's `finally`), `api-server-condition-codebehind.test.ts:207`, `test-runner-condition-codebehind.test.ts:176`
- Mechanism: `fs.rm(dir, { recursive: true, force: true })` runs with no `maxRetries`. `force` does not ignore EBUSY or EPERM. Most of these dirs hold a freshly written `.steps.ts` plus the `.mjs` esbuild bundle that the loader just imported. This is exactly the file type that f83c11b ("Retry removing in-repo temp dirs that Windows briefly locks") saw the scanner open. That commit fixed only the in-repo `tests/.tmp-*` dirs, on the grounds that "%TEMP% is usually spared". The debugger's `:491` removal sits inside the test body, so a lock there fails the test itself rather than a hook.
- Risk: medium (Windows only, needs a scanner to touch the file, but it is the documented failure mode of this repo).
- Fix: pass `{ recursive: true, force: true, maxRetries: 10, retryDelay: 100 }` everywhere, which makes the batch consistent.
- Evidence: the f83c11b commit message (EBUSY seen in codebehind-alignment, codebehind-failure-outcomes and flow-control-runner during full runs).

Not flagged, but worth knowing:
- `codebehind-tabs.test.ts:122` navigates to `http://127.0.0.1:1/nothing-here`. This is real network outside the routed origin. It relies on the OS refusing port 1 quickly; Windows takes about 2 s of SYN retries against a 30 s budget. `route.abort()` on a routed path would make it hermetic.
- `api-server-codebehind.test.ts` restores its `vi.spyOn(sessionManager, …)` spies inline at the end of each test (:665, :730, :753, :768, :831), not in `afterEach`. A failed assertion leaks the `executeSteps` spy into later tests and turns one failure into a cascade. This is order dependence after a failure, not a flake source. Fix: `vi.restoreAllMocks()` in the existing `afterEach`.

## Per-file verdicts
| File | Tests | Verdict (High/Medium/Mixed/Low) | One-line note |
|---|---|---|---|
| codebehind-compile-cli | 9 | High | `parseStepRange`/`buildSelect` pure tests plus commander exit paths. "is registered with the flags" is Medium: only `--dry-run`/`--max-rounds` are unique to it. |
| codebehind-self-resolve | 3 | High | Incident regression (project without node_modules); covers both directions of the self-resolve plugin. |
| codebehind-compile-parameters | 5 | High | `resolveCompileParameters` precedence, `firstDataRow`, and that the CLI runner starts from the request's map (incident). |
| codebehind-upload | 15 | High | `step.filePath` non-retryable kinds vs ordinary crash; the literal-path backstop, its scoping, and its order relative to the ambiguous-selector check. |
| codebehind-section-rows | 7 | High | Per-iteration `getVar`, frame-chain composition, shadowing, unlooped-section regression. |
| codebehind-alignment | 15 | High | Binding by text, occurrence, section and skill file through the real parse and expansion. |
| codebehind-writer | 19 | High | Brace hazards, splice/append, section stamping, byte-for-byte restore, Windows lock retry, project Prettier config. The exact Prettier-output test (:405) is Medium: it pins Prettier's own output. |
| codebehind-vars | 15 (+it.each) | High | Frame-aware `getVar`/`setVar`, aliases, namespaces, env-data args, prototype-key regression. |
| codebehind-tabs | 19 | High | Real Chromium for tracker/Playwright agreement (justified in the header); see flakiness for ctx.browsers. |
| codebehind-recorded-captures | 21 | High | Prompt shows recorded values masked; leak guard and one re-ask via fake AI with real logic between. Minor C:-path fixture defect. |
| codebehind-conditions | 19 (+it.each) | High | Loader keeps or drops condition entries; non-boolean, exit, expect and fail outcomes; wrong-place entry. One L3 (:322). |
| codebehind-env-data | 31 | High | `${data.*}` grammar, run-time `getVar`, prompt mirroring, leak guard, recording redaction, compile end to end. |
| codebehind-skill-params | 11 | Mixed | Real HTTP compile of skill params. :402's "mapping" assertions are vacuous (defect); :450/:515 rely on their negative halves. |
| codebehind-integration | 12 | High | `executeStep` decision order: zero-AI replay, heal, strict, abort-not-stale, report marks. "never writes a .steps.ts" (:370) is Medium: it guards a removed feature from returning. |
| codebehind-healed-run | 23 | High | Healed token attribution through the real `runTest`, banner, `--fail-on-healed`, consecutive-stale sidecar. |
| codebehind-recording | 26 | High | Recording round-trip, redaction incl. assertions and dotted names, splice identity (section, occurrence, file), evidence pass. See flakiness (sleeps). |
| computer-report-compile | 14 | High | Mode marker, one capture per turn, right switch named, surface stamped, computer step compiled to `ai: true` (reason string is quoted in SPEC-use-computer.md:849, so pinning it is a contract). |
| guard-condition-codebehind | 33 | High | Real `evaluateGuard`: code, values and model ordering, chain wholeness, heal/strict/keyless/abort, cap net, evidence. Two L3s (:430, :573). |
| test-runner-condition-codebehind | 5 | High | CLI-runner seam: registry reaches the guard; sidecar row parity with the server writer. |
| api-server-condition-codebehind | 7 | High | Server seam: guard events carry `fromCodeBehind`/stale on the right member; sidecar parity; `deliberate` on the wire. |
| api-server-healed-run | 6 | High | `done.healed` count/tokens and step:fail code-behind fields (regression for dropped fields). |
| api-server-codebehind | 23 | Mixed | Wire contract, allow-list, 409 lock, env/parameter resolution are High. :669 tests a removed property (L2/L7); :985 has two lines reading the mock's own result. |
| api-server-codebehind-debugger | 9 | High | One-shot flag consumption regressions over real HTTP. :528 (Stop while parked) is a defect: it admits it passes with or without the fix and checks too little. |

## Low-value tests

### `api-server-codebehind.test.ts:669` — "keeps nothing of a run on the session — there is no last run to reuse"
- Category: L2 / L7
- Evidence: `expect((sessionManager as unknown as { lastRunDetails?: unknown }).lastRunDetails).toBeUndefined();`. `grep -rn "lastRunDetails" src/ runner-core/src steptix-vscode/src flick-vscode/src` returns nothing. `git log -S lastRunDetails -- src` shows the property was removed in 900f591 ("Keep the compile's recording beside the test, not on the server"). The test reads a property that no longer exists, so it passes unless someone re-adds a field with that exact name. The real guarantee (Record runs in the caller's session every time) is already covered by :638 "records in that session every time, and leaves it open" and :757.
- Recommendation: delete.
- Confidence: high

### `guard-condition-codebehind.test.ts:430` — "settles the page once, right before the first entry runs"
- Category: L3 (and the name claims more than it checks)
- Evidence:
  - The setup is identical to :302 "stops at the first member that holds; later members are not run": `a = scripted(false)`, `b = scripted(true)`, `c = scripted(true)` on CHAIN members 0, 2 and 4.
  - Its two assertions, `expect(ev.guard).toEqual({ decidedBy: 'code', selected: 2 })` and `expect(settle.calls).toBe(1)`, are both already in :302 (lines 317 and 324).
  - The name says "right before the first entry runs", but nothing checks that the settle happens before the entry.
- Recommendation: delete. Or, if the ordering matters, rewrite to record call order (push `'settle'` from the settle mock and `'a'` from `a.condition`, then assert `['settle', 'a', 'b']`).
- Confidence: high

### `guard-condition-codebehind.test.ts:573` — "does not mark a step.expect failure deliberate"
- Category: L3 (merge)
- Evidence: it is the same binding and the same visit as :541 "fails the guard on step.expect, never healed" (`step.expect(false, 'the list never loaded'); return true;`), and it adds a single `expect(ev.deliberate).toBeUndefined();`.
- Recommendation: merge that one line into `guard-condition-codebehind.test.ts:541`.
- Confidence: high

### `codebehind-conditions.test.ts:322` — "leaves a run entry on an ordinary step exactly as before"
- Category: L3
- Evidence:
  - The test is `runCodeBehindEntry({ … entry: { source: 'Open the statements page', run: () => {} } … })` followed by `expect(out.status).toBe('passed')`, the plain happy path of `runCodeBehindEntry`.
  - That path is already asserted at the same level by `codebehind-vars.test.ts:180` "uses bare names for a top-level step" (`expect(outcome.status).toBe('passed')`) and many others.
  - At the executor level it is asserted by `codebehind-integration.test.ts:151` "runs a fully covered test with zero AI calls".
  - It sits next to an `executeStep` test, but it never goes through `executeStep`, so it does not check that the executor still runs a run entry on an ordinary step.
- Recommendation: delete. Or rewrite through `executeStep` with a `forbiddenClient` and assert `fromCodeBehind === true` (the counterpart of :261).
- Confidence: high

### `api-server-codebehind.test.ts:985` — "compiles dry even when the request asks for a real write" (partial)
- Category: L1 (two of its three assertions)
- Evidence:
  - `expect(events.at(-1)!.data.summary.written).toEqual([]);` reads the mocked core's own `written: []` (mock at :86).
  - `expect(Object.keys(events.at(-1)!.data.files)).toEqual([testFile('smoke.steps.ts')]);` reads the mock's `files` map (:73-75), which :521 already asserts.
  - Only `expect(optionsAt(0).dryRun).toBe(true)` tests the server.
- Recommendation: keep the test and delete the two lines. Optionally add the real claim by asserting that `smoke.steps.ts` does not exist on disk afterwards.
- Confidence: high

## Test defects

### `codebehind-skill-params.test.ts:402` — "generation sees the AUTHORED text and the username → Alice mapping"
- Category: Defect (the assertions cannot fail for the claimed reason)
- Evidence:
  - The test asserts `expect(generation!).toContain('username');` and `expect(generation!).toContain('Alice');`.
  - `'username'` is always present, because `AUTHORED = 'Type {{username}} into the user box'` is asserted on the line above.
  - `'Alice'` is always present, because the mocked executor's transcript types it (`{ action: 'type', selector: '#user', text: 'Alice' }`, :126), and `buildStepCodePrompt` embeds the raw actions as JSON (src/ai/prompts.ts:1869-1871; `generateStepEntry` passes `actions: options.actions` untouched, generate.ts:398).
  - So the parameter block line that maps the name to the value could disappear and this test would still pass.
  - The same vacuous positive `toContain('Alice')` appears at :459 and :520. Those two tests are carried by their negative assertions (`not.toContain('${data.username}"')`).
- Recommendation: assert the mapping line itself: `expect(generation!).toContain('- {{username}} resolved to "Alice" on this run')`. Do the same for :459 and :520.
- Confidence: high

### `api-server-codebehind-debugger.test.ts:528` — "Stop while parked for the debugger does not arm the next run"
- Category: Defect (L2-adjacent)
- Evidence:
  - The test's own comment says "this one passes with or without the fix".
  - It is kept to check "no ack ever sent, session still usable afterwards", but neither half is asserted:
    - The first loop is wrapped in `try { … } catch { /* The abort surfaces… */ }`. If `codebehind:awaiting-debugger` never fired, the loop runs to `done` without aborting and nothing notices, so the Stop-mid-pause gesture may never be exercised.
    - The second run asserts only `events.filter((e) => e.type === 'codebehind:awaiting-debugger')).toHaveLength(0)`, with no `done` status check (every sibling test checks `done?.status === 'passed'`). A second run that ended in `done: error` or with no frames at all would pass.
- Recommendation: set a `sawPause` flag in the first loop and assert it is true. Assert `events.find((e) => e.type === 'done')?.status === 'passed'` for the second run.
- Confidence: high

### `codebehind-recorded-captures.test.ts:42` — fixture `bindingFor`
- Category: Defect (minor, policy)
- Evidence: `file: path.join('C:', 'nowhere', 'x.steps.ts'),`. CLAUDE.md says: "Never hard-code `C:\…` or `path.join('C:', …)`". The value is inert today (`generateStepEntry` reads only `binding.source`, generate.ts:339-470), so it does not fail on Linux or macOS. It is still the exact pattern the policy bans.
- Recommendation: `path.resolve(path.sep, 'nowhere', 'x.steps.ts')`.
- Confidence: high

### `api-server-codebehind.test.ts:638, :673, :734, :757, :808` — inline spy restore
- Category: Defect (minor hygiene, cascade on failure)
- Evidence: `run.mockRestore(); close.mockRestore();` is the last statement of each test, and the file's `afterEach` (:466) only removes the temp dir. A failing assertion leaves `sessionManager.executeSteps`/`closeSession` spied for every later test.
- Recommendation: add `vi.restoreAllMocks()` to the `afterEach`.
- Confidence: high

## Duplication clusters
- Condition code-behind at three levels:
  - Tests: `guard-condition-codebehind.test.ts` (evaluateGuard), `test-runner-condition-codebehind.test.ts` (CLI `runTest`), `api-server-condition-codebehind.test.ts` (HTTP).
  - Shared scenarios: While decided by code, stale row on the broken member, `step.fail` deliberate.
  - Verdict: keep all three. They are different levels, the CLI and server have separate sidecar writers, and :293/:475 pin their parity explicitly.
- Healed runs: `codebehind-healed-run.test.ts:286` (CLI token attribution) and `api-server-healed-run.test.ts:213` (server `done.healed`). Keep both; they are separate implementations.
- Compile parameters from the request map: `codebehind-compile-parameters.test.ts:103` (CLI runner) and `api-server-codebehind.test.ts:808` (server runner). Keep both (parity).
- Same-level repeats to remove:
  - CHAIN false/true/true settle count: `guard-condition-codebehind.test.ts:302` and `:430`. Keep :302, drop :430.
  - `step.expect` failure on a While guard: `guard-condition-codebehind.test.ts:541` and `:573`. Keep :541, merge :573 in.
  - Run entry passes on an ordinary step: `codebehind-conditions.test.ts:322`, `codebehind-vars.test.ts:180` and `codebehind-integration.test.ts:151`. Drop `codebehind-conditions.test.ts:322`.
- The "no parameters" prompt line is asserted at the prompt (`codebehind-env-data.test.ts:359`), `generateStepEntry` (:477) and `compileTest` (:613) levels. These are different levels, so it is acceptable.

## Cost concerns
- `codebehind-tabs.test.ts`: one suite Chromium, plus a new context for every test (including the 7 tests that never use it), plus up to 8 extra cold launches in "ctx.browsers". See flakiness.
- `codebehind-writer.test.ts:306` (win32 only): spawns `powershell.exe` with a 150 s budget. This is justified; nothing cheaper can hold a non-sharing lock from another process.
- `codebehind-skill-params.test.ts`: 11 full compile runs over HTTP (real expander, live compiler, Prettier, esbuild). Two tests (:396 and :444, "the run itself typed the resolved value") only check the expanded instruction, which the next test's run also produces. Merging them into :402 and :450 would save two compile runs.

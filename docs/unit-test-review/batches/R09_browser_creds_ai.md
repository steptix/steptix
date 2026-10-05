# R09_browser_creds_ai

## Summary
- Files: 31 · tests (approx): 650 · High ~540 · Medium ~70 · Low 38 (19 of them one dead-subject file) · Defects 4 · Flake risks: 1 high, 5 medium (covering 8 tests)
- Overall the batch is strong. The AI-client tests stub `@pkent/aigateway` only at the constructor/`chat`/`stream` boundary and assert request shaping, baseURL routing, the keyless/policy/gateway guards, usage mapping and syncAuth invalidation. All of that runs through real `AiClient` logic, so the L1/L6 pattern ("stub returns X, assert X") is essentially absent. The credential and secret tests are the best in the batch: every security gate has a negative case (lookalike domain, honeypot field, new-password form, a hint pointing into a text box, cmd.exe metacharacters, canary values that must reach no command line, env, result or log) and a control beside it.
- Low value here is mostly **repetition**, not emptiness: "control" tests that repeat an existing happy path (ai-client ×4, cdp-registry ×2, secrets ×2, keyless-replay, cdp-teardown, cdp-launcher). Beyond that there is one **dead subject**: `tests/auth-resolver.test.ts` tests `src/api/auth-resolver.ts`, which nothing imports.
- There are three tests whose stated claim is not what they check: `ai-effort:169` cannot see a gateway rebuild, `browser-launch-args:148` makes a real `localhost:9222` probe and its assertion is vacuous, and `credential-bw-process:77` only hits the `pid <= 0` guard.
- Flakiness clusters in the Windows real-process tests, which run on the windows-latest CI runner (`.github/workflows/unit-tests.yml`). The main one is a 1.5 s sleep used as "wait for node to start under cmd.exe". There are also a few fixed-budget waits around real Chromium work.
- Real Chromium (browser-history, credential-broker, secret-field-parity) and port-0 servers are otherwise well guarded: request interception rather than network, port 0, a 60 s `beforeAll`, one browser per file.

## Flakiness risks

### `tests/credential-bw-process.test.ts:82` — "finds the one real child of a process this test spawned itself"
- Mechanism: a sleep stands in for "the child has started": `await new Promise((r) => setTimeout(r, 1500)); // let node start under it`, then `const pick = await findBwProcess(wrapper.pid!); expect(typeof pick).toBe('number');`. If node.exe has not appeared under cmd.exe within 1.5 s (cold start or Defender scanning a fresh process on a 2–4 vCPU windows-latest runner during a parallel run), `pickBwChild` sees no child and returns `'self'`, and the test fails. `findBwProcess` itself is a PowerShell + CIM query with a 10 s budget (`LOOKUP_TIMEOUT_MS`, src/credentials/bw-process.ts:76). Under load that can also run out and resolve `null`. The mkdtemp dir is never removed, and when `pick` is not a number the node child is left running for its 20 s self-exit.
- Risk: high (runs on every Windows CI run; `describe.runIf(process.platform === 'win32')`)
- Fix: make the waiter write a ready file (`fs.writeFileSync(ready, String(process.pid))`) and poll for it, then retry `findBwProcess` until it returns a number or a generous deadline passes. Better still, compare the result against the pid in the ready file. Remove the temp dir in `finally`.
- Evidence: reasoning. The file's history (`9ea3bcf`, `91b4567`) has no timing fixes yet. The same 1.5 s pattern is copied into `credential-real-processes.test.ts:72`.

### `tests/credential-real-processes.test.ts:82` — "stops a bw that ignores stdin and outlives its wrapper — by its own PID" (test 41)
- Mechanism: the gate `lookupWorks()` (:64) uses the same `setTimeout(r, 1500)` start wait. On a slow runner it returns false and `ctx.skip()` fires, so the flake shows up as a silent skip (coverage loss, not a red run). The real run then depends on three things finishing within its budgets under load: `findBwProcess` resolving inside the driver before the first write, `quietMs: 2_000`, and `until(() => !alive(stubPid), 3_000)`. If the lookup times out, the driver returns `failed` instead of `quiet` and `expect(result).toEqual({ kind: 'quiet' })` fails. The temp dirs are never removed.
- Risk: medium
- Fix: replace the sleep in `lookupWorks` with a ready-file handshake. Have the test log why it skipped. Raise the `until` budget, or poll on `process.kill(pid, 0)` up to the test timeout. Clean up `base` in `finally`.
- Evidence: reasoning. It runs on windows-latest CI because the stub needs no installed bw.

### `tests/credential-real-processes.test.ts:152` and `:169` — "42. its prompts and echo are still what the driver reads" / "43. a canary master password reaches no command line and no environment"
- Mechanism: these drive the user's installed `bw` (`describe.runIf(HAS_BW)`). The asserted event sequence `[{ answered: 'email' }, { answered: 'password' }, { stopped: 'failed' }]` depends on the installed bw version's prompt text, its "Master password is required." refusal, and its startup time. A bw upgrade on a developer machine can turn these red with no code change. They are skipped on CI (no bw installed).
- Risk: medium (dev machines only)
- Fix: none needed in the code. Record the bw version the assertion was measured against in the failure message (`spawnSync(bw, ['--version'])`) so a red run names the cause.
- Evidence: the file header says these exist to catch exactly a bw upgrade. That is intended, but it reads as a flake to anyone who has not upgraded on purpose.

### `tests/credential-broker.test.ts:813` — helper `calledTimes`, used by "25. two calls on a signed-out vault share ONE status check…" (:1000), "26. a joiner never runs its own status check…" (:1032), "28. two calls on a LOCKED vault share one unlock dialog" (:1090)
- Mechanism: a fixed polling budget, `for (let i = 0; i < 500 && spy.mock.calls.length < n; i++) await new Promise((r) => setTimeout(r, 10)); expect(spy.mock.calls.length).toBeGreaterThanOrEqual(n);`. Between polls, attempt B must run a real `scanForLogin` against the shared Chromium page before it reaches Gate 3. The file's own header records that this suite and other browser suites starve each other under the parallel run. If Chromium is starved for more than ~5 s, the helper's assertion fails rather than waiting.
- Risk: medium
- Fix: make it event-driven. Wrap the spy so that its n-th call resolves a deferred, e.g. `vaultUnlocked = vi.fn(() => { if (++calls === 3) reachedGate3.resolve(); return open; })`, and `await reachedGate3.promise`. The file-level 30 s test timeout then remains the only deadline.
- Evidence: the comment at :27–35 and :489–497 (the measured starvation of `page-content-capture` when a second browser suite was added).

### `tests/secret-field-parity.test.ts:69` — "the recorder withholds exactly the fields the rule calls secret"
- Mechanism: `recorder.stop()` collects the still-open last field through `briefly(callControl(frame, key, 'flush', []), PAGE_CALL_MS /* 2_500 */, [])` (src/recorder/step-recorder.ts:1155, :218). If that page call takes longer than 2.5 s under load, it silently answers `[]`. The last case (`email`) is then never recorded, and `expect(a, c.id).toBeDefined()` fails.
- Risk: medium
- Fix: after the loop, move focus out of the last field (e.g. `page.focus('body')`, or press Tab) so every field commits through the binding and does not depend on the bounded flush. Alternatively, `await recorder.flushTyping()` before `stop()` and assert on the result.
- Evidence: reasoning from the source. No history yet.

### `tests/tab-observability.test.ts:104` — "does not hang the run on a page whose title never resolves"
- Mechanism: the test asserts elapsed wall time around a real timer: `const started = Date.now(); … await new PageTracker(page).describeActiveTab(); … expect(Date.now() - started).toBeLessThan(3000);`. The bound is the real `TAB_TITLE_TIMEOUT_MS = 500` race in `briefly`, so it fails only if the worker's event loop stalls for more than ~2.5 s. That is unusual, but it happens on a loaded 2-vCPU CI runner.
- Risk: medium
- Fix: use `vi.useFakeTimers()` and `await vi.advanceTimersByTimeAsync(500)`, then assert `title === ''`. A real hang would hit the 30 s test timeout anyway, so the elapsed-time assertion adds no coverage.
- Evidence: reasoning.

Notes (not rated; already guarded or no plausible failure):
- `tests/browser-manager-cdp.test.ts:476`: `vi.useFakeTimers()` … `vi.useRealTimers()` is not in `finally`. If `await pending` threw, fake timers would leak into the next test (`activeTabRef`). Low. Wrap the call in try/finally as `tab-screenshot.test.ts:159` does. The `setTimeout(r, 10)` waits at :440/:473 and in `tab-observability.test.ts:147/171/196` wait on microtask-only fakes, so they are not load-bearing.
- `tests/browser-launch-args.test.ts:148` makes a real `fetch('http://localhost:9222/json/version')` (the file does not stub `fetch`). It passes whether or not something listens there, so it is not a flake, but its result depends on the machine. See Low-value.
- `tests/keyless-diagnosis.test.ts:180` / `tests/keyless-replay.test.ts:47` use fixed in-repo temp dirs (`tests/.tmp-keyless-*`), needed for the `steptix/codebehind` self-import. They are already hardened (`fs.rm(..., { maxRetries: 10, retryDelay: 100 })`, commit `f83c11b` "Retry removing in-repo temp dirs that Windows briefly locks"). Residual risk only if two runs share one checkout at the same time.
- `tests/auth-resolver.test.ts:86`: the `afterEach` env restore does not delete keys the test added (`NOTIFICATIONS_API_KEY`). Contained to the file's own worker, and the file is L7 anyway.
- `tests/credential-broker.test.ts:334` always waits out the 5 s `SUBMIT_CLICK_TIMEOUT_MS` (src/credentials/login-fields.ts:253) before the Enter fallback. Deterministic, but see Cost.
- Well guarded: `browser-history` (route interception on `http://history.test`, no network), `credential-broker`/`credential-route`/`lm-bridge-real-sdk` (servers on port 0, closed in `afterAll`), `credential-bw-login` (fake timers plus a fixed `setImmediate` flush, fake child), `cdp-launcher`/`cdp-registry` (fully injected fs/spawn/probe/clock), `tab-screenshot` (fake timers restored in `finally`), `browser-manager-focus`/`-viewport` (fetch stubbed and restored), `run-log-secrets` (mkdtemp; log level restored in `finally`).

## Per-file verdicts
| File | Tests | Verdict (High/Medium/Mixed/Low) | One-line note |
|---|---|---|---|
| tests/ai-client.test.ts | 48 | High | Request shaping, baseURL routing, keyless/policy/gateway guards and syncAuth invalidation all run through real `AiClient` logic; the SDK stub only records args. Four happy-path "controls" repeat each other. |
| tests/ai-client-usage.test.ts | 5 | High | `usageFromV2` and the stream estimate mapped onto the returned `usage` and a real `TokenTracker`; absent vs zero cache count is a real edge. |
| tests/ai-effort.test.ts | 11 | Mixed | Profile→effort/cap pairing and AI_EFFORT scoping are real. The "memoized gateway" test cannot detect a rebuild (defect); the responseFormat/signal test repeats ai-client. |
| tests/auth-resolver.test.ts | 19 | Low | The whole subject, `src/api/auth-resolver.ts`, has no production caller (L7). |
| tests/bedrock-keyless.test.ts | 16 | High | Compositions (keyless Bedrock × override × policy) through real `aiConfigured`/`resolveRunSettings`/`AiClient`. One smoke test repeats ai-effort. |
| tests/browser-history.test.ts | 28 | High | Mock dispatch, real-Chromium same-document cases (the measured defect), and prompt/source pins with controls. One parser test asserts its own input. |
| tests/browser-launch-args.test.ts | 6 | Mixed | Arg assembly is real and well controlled. The CDP-attach case probes real `localhost:9222`, and its assertion is vacuous when nothing listens there. |
| tests/browser-manager-cdp.test.ts | 37 | High | Real parser/resolver/preflight/PageTracker logic, including the fail-open sweep regression; the wedged-lookup test uses fake timers correctly. |
| tests/browser-manager-focus.test.ts | 12 | High | The only layer that sees `BrowserSession.headed` and the attach-raise; every gate has a control. |
| tests/browser-manager-viewport.test.ts | 11 | High | Context viewport and window size per mode; the CDP refusal and its control. |
| tests/browser-tracker-deferred.test.ts | 14 | High | Single-flight launch, a failed launch not cached, what an unlaunched tracker answers. |
| tests/cdp-launcher.test.ts | 44 | High | Fully dependency-injected (no real Chromium or process): engine classification, tab filter, close/activate status mapping, port-file parsing, the file-then-port wait. One subset test. |
| tests/cdp-registry.test.ts | 87 | High | Every reset/close/focus guard has its own test against an in-memory fs, including measured regressions. Two duplicate pairs; two tests spin 1.5 s of real clock; the fixture root breaks the platform-path rule. |
| tests/cdp-teardown-invariant.test.ts | 9 | High | CDP teardown never closes the context and closes only the tab it opened, through `closeBrowser` and the tracker. Fakes only. One subset test. |
| tests/credential-broker.test.ts | 71 | High | Pure domain rules, gate order, fill, single-flight sign-in and wiring against one real Chromium and a port-0 server. Strong security negatives. Join tests poll with a fixed budget (medium flake). |
| tests/credential-bw-login.test.ts | 32 | High | Scripted fake child and fake timers: prompt/echo parsing, chunk boundaries, re-ask, timing, kill order, launch/env hygiene, a canary. Deterministic. |
| tests/credential-bw-process.test.ts | 10 | Mixed | The pure `pickBwChild`/`parseLookup` tests are high. The Windows real-process test sleeps 1.5 s as a wait (high flake). One test's name says "not running" but it hits the `pid <= 0` guard. |
| tests/credential-dialog-fields.test.ts | 6 | High | Base64 field round-trip, a real PowerShell CP437 check (Windows), and a source pin that every dialog goes through the helper. |
| tests/credential-real-processes.test.ts | 4 | Medium | Real cmd.exe/node/bw covers what the fakes cannot. Timing-sensitive (medium flake), can skip silently, leaks temp dirs. |
| tests/credential-route.test.ts | 5 | High | The route is registered and behind auth, answers with the JSON 404 envelope, and validates hints, over a real port-0 socket. |
| tests/credential-vault.test.ts | 25 | High | Cache refresh against a changing fake bw, origin narrowing, SAFE_ARG, the dead-key race, cmd.exe quoting, the BW_NOINTERACTION split. |
| tests/keyless-diagnosis.test.ts | 17 | High | Real `runTest` with mocked browser/executor/AI: the diagnosis skip notes (keyless vs policy), the keyless flag wiring, the compile bypass, sidecar staleness; a control for each. |
| tests/keyless-replay.test.ts | 8 | Mixed | Real `executeStep` with a real esbuild-compiled `.steps.ts`: green replay with zero AI, the heal skip with the right copy, strict precedence, and the keyed heal control. One test repeats another. |
| tests/lm-bridge-real-sdk.test.ts | 3 | Mixed | The bridge's response shapers parsed by the real OpenAI-based SDK is a true contract test. The effort test asserts only what the SDK sends, which no repo code reads. |
| tests/run-log-secrets.test.ts | 3 | High | Run-log masking reads the list at each write, masks trace payloads before serialisation, and writes no trace blocks in compact mode. |
| tests/secret-field-parity.test.ts | 3 | High | Three readers (snapshot, expand, recorder) and the rule agree field by field on real Chromium. One medium flake (bounded flush). |
| tests/secrets.test.ts | 72 | High | Dense, regression-driven coverage of the mask rules (record floor, whole-word column keys, loop-binding registry, JSON-escaped forms, BOM, shapes). Two exact repeats. |
| tests/secrets-report-surfaces.test.ts | 8 | High | Non-empty mask set vs record rule ordering; tool outputs; the data: image guard; rendered HTML; identity preservation. |
| tests/tab-observability.test.ts | 23 | Mixed | PageTracker target-id caching and unexpected-tab attribution are high. One key-set snapshot (L4), one tautology, one vacuous line, one elapsed-time assertion. |
| tests/tab-screenshot.test.ts | 12 | High | Screencast-before-capture order, cleanup, PNG-header dimensions, the timeout on fake timers, failure vs timeout. |
| tests/tokens.test.ts | 5 | Medium | Per-run rebaseline accounting is real but small; :53 largely covers :39. |

## Low-value tests

### `tests/ai-client.test.ts:703` — "forwards a timeout-only AbortSignal when no run signal is passed"
- Category: L3
- Evidence: it asserts `expect(sawOpts.signal).toBeInstanceOf(AbortSignal); expect(sawOpts.signal.aborted).toBe(false);`. `tests/ai-client.test.ts:561-562` ("calls chat with passed-through messages, maxTokens, responseFormat, composite signal") makes exactly these two assertions with the same config and no run signal. Neither checks the 120 s timeout, so the name over-claims.
- Recommendation: delete, or rewrite with fake timers to assert the signal aborts at 120 s (the only thing that would make it distinct).
- Confidence: high

### `tests/ai-client.test.ts:303` and `:409` — "lets aibroker/ fall through to the default endpoint, guard or no guard" / "leaves a keyed client on exactly today's behaviour"
- Category: L3
- Evidence: both build `AiClient` with `aibroker/openai/chatgpt-5.5` on the default URL and assert `constructorMock` was called with `{ baseURL: 'https://llm.corp.example/v1' }`. That is the same config and assertion as `tests/ai-client.test.ts:120`. :409 differs only in the key (`'k'`), which takes no different branch in `aiConfigured` (`(ai.apiKey ?? '').trim() !== ''`).
- Recommendation: merge into :120 and reference it from the two describe blocks as the control.
- Confidence: medium

### `tests/ai-client.test.ts:196` — "refuses the request rather than building a gateway with no key"
- Category: L3
- Evidence: `delete (cfg as Partial<AiConfig>).apiKey`, then `rejects.toBeInstanceOf(AiNotConfiguredError)` and `constructorMock` not called. The `'absent'` row of the keyless table at `tests/ai-client.test.ts:349` does the same deletion and asserts the same error class, with `chatMock`/`streamMock` not called.
- Recommendation: delete, or move its one extra assertion (`constructorMock` still not called after `complete()`) into the table at :349.
- Confidence: high

### `tests/ai-client.test.ts:812` — "reports both a model AND key change together"
- Category: L3
- Evidence: `expect(change).toBe('AI model … → openai/chatgpt-5.5; AI API key changed')`. `tests/ai-client.test.ts:869` covers the `'; '` join and key redaction for all three changes.
- Recommendation: delete (keep :869).
- Confidence: medium

### `tests/ai-effort.test.ts:181` — "responseFormat and signal still ride alongside the profile"
- Category: L3 (with an L2-grade assertion)
- Evidence: `client.ts` builds the options for every profile in one literal, `{ ...this.resolveProfile(options?.profile), responseFormat: { type: 'json_object' }, signal: this.buildSignal(signal) }`, so the authoring profile takes no branch that `tests/ai-client.test.ts:559-561` does not already assert. `expect(options.signal).toBeDefined()` can only fail if the key is dropped.
- Recommendation: delete.
- Confidence: medium

### `tests/auth-resolver.test.ts:1-140` — whole file ("parseApiType", "shouldUseBrowserContext", "extractApiTypeFromContext", "resolveAuth"; 19 tests)
- Category: L7
- Evidence: `grep -rnE "resolveAuth|shouldUseBrowserContext|parseApiType|extractApiTypeFromContext|auth-resolver" src runner-core/src steptix-vscode/src flick-vscode/src` returns only `src/api/auth-resolver.ts` itself. The only other references in the repo are `docs/specs/SPEC-API.md`, one story, and this test. The module's only commit is `dfa3f0a feat: add API testing extension` (2026-03-27), and `src/api/client.ts` imports only `./types.js`.
- Recommendation: delete the test together with `src/api/auth-resolver.ts`, or wire the resolver in if the feature is still planned. If the file is kept, also fix the `afterEach` (:86) so it removes added env keys.
- Confidence: high

### `tests/bedrock-keyless.test.ts:251` — "forwards AI_EFFORT with a bedrock model like any other"
- Category: L3
- Evidence: `expect(chatMock.mock.calls[0]?.[1]).toMatchObject({ effort: 'high' })`. `AiClient.resolveProfile` (src/ai/client.ts:494-505) has no model-dependent branch, so this is the same path as `tests/ai-effort.test.ts:146`, which also asserts the cap. The test's own comment calls it a "Smoke".
- Recommendation: delete (reinstate only if a provider-specific effort branch appears).
- Confidence: medium

### `tests/browser-history.test.ts:134` — "does not require a url, a selector or a value"
- Category: L1 / L3
- Evidence: the input is `{ action: 'back', description: 'Go back' }`, and the test asserts `only.url`, `only.selector` and `only.value` are `toBeUndefined()`. Those values are simply absent from its own input. The "not rejected" half is already proved by `tests/browser-history.test.ts:100`.
- Recommendation: delete.
- Confidence: medium

### `tests/browser-launch-args.test.ts:148` — "is not passed to a CDP attach"
- Category: L2
- Evidence: this file never stubs `globalThis.fetch`, unlike `browser-manager-focus.test.ts:115` and `browser-manager-viewport.test.ts:131`. `launchBrowser(..., { port: 9222 })` calls `preflightCdpPort(9222)` (src/browser/manager.ts:1283), which makes a real request to `localhost:9222`. With nothing listening (normal CI) it throws before `connectOverCDP` is reached. `connectOverCDP.mock.calls[0]?.[0]` is then `undefined`, and `not.toContain('--disable-print-preview')` runs against `'""'`. "`launch` not called" is structural, because `if (cdp) return connectOverCdpSession(...)` at manager.ts:1437 returns first.
- Recommendation: stub `fetch` like the sibling files, make `connectOverCDP` resolve a fake browser, and assert its call args. Or delete, since the early return makes the property structural.
- Confidence: high

### `tests/cdp-launcher.test.ts:73` — "does not mistake Edge for Chrome"
- Category: L3
- Evidence: `expect(classifyEngine('Edg/151.0.4129.59')).not.toBe('chrome')` is implied by `tests/cdp-launcher.test.ts:54`, which asserts the same input `toBe('edge')`.
- Recommendation: delete.
- Confidence: high

### `tests/cdp-registry.test.ts:322` — "asking for a profile that exists is not an error"
- Category: L3
- Evidence: the setup is identical to `tests/cdp-registry.test.ts:309` (same fakeFs, profile `admin`, probe). :309 asserts `{ ok: true, outcome: 'launched_into_existing_profile' }`; :322 asserts only `result.ok === true`.
- Recommendation: delete.
- Confidence: high

### `tests/cdp-registry.test.ts:1136` — "warns when an ordinary close leaves a running browser with no tabs"
- Category: L3
- Evidence: the arrangement is identical to `tests/cdp-registry.test.ts:1277`: `listTabs = stage++ === 0 ? TWO_TABS : []`, `alive = true`, `now = clock += 500`, same target. One test asserts the warning, the other `{ ok: true, remainingTabs: 0, browserExited: false }`: two halves of one result.
- Recommendation: merge into :1277.
- Confidence: high

### `tests/cdp-teardown-invariant.test.ts:51` — "never closes the context — that is the whole point of CDP teardown"
- Category: L3
- Evidence: `not.toContain('context.close')` on `fakeSession({ cdp: true })`. `tests/cdp-teardown-invariant.test.ts:57` runs the same fixture and asserts `toEqual(['browser.close'])`, which already excludes it.
- Recommendation: delete, or fold its title into :57.
- Confidence: high

### `tests/keyless-replay.test.ts:297` — "keeps the machine-has-no-AI copy when no reason is given"
- Category: L3
- Evidence: it runs `{ keyless: true }` with no `keylessReason` and asserts `results[1]!.error` is `KEYLESS_HEAL_SKIPPED_ERROR`. `tests/keyless-replay.test.ts:216` runs the identical fixture and options and asserts `failed!.error).toBe(KEYLESS_COPY)` and `KEYLESS_HEAL_SKIPPED_ERROR).toBe(KEYLESS_COPY)`. The extra `POLICY_HEAL_SKIPPED_ERROR).not.toBe(KEYLESS_HEAL_SKIPPED_ERROR)` is implied by :262, where the policy copy contains `runSettings.ai: off` and not `this machine`. Each case also pays for an esbuild compile of the `.steps.ts`.
- Recommendation: delete.
- Confidence: high

### `tests/lm-bridge-real-sdk.test.ts:141` — "carries an effort profile through without the bridge having to know it"
- Category: L5
- Evidence: the only assertion is `expect(seen[before]!.body['reasoning_effort']).toBe('medium')`, i.e. what `@pkent/aigateway`/OpenAI SDK put on the wire. No repo code is in the request path; the server is test code. The bridge never reads the field: `steptix-vscode/src/extension/lm-bridge-core.ts:357` says "`reasoning_effort` … is simply never read". So nothing in this repo breaks if the SDK renames or drops it.
- Recommendation: rewrite to feed the captured body through `translateRequest` and assert it is accepted (that actually tests "drop silently"), or delete.
- Confidence: medium

### `tests/secrets.test.ts:613` — "still dedups and still drops empties"
- Category: L3
- Evidence: `secretValues({ password: 'same' }, ['same', 'other'])).toEqual(['same', 'other'])` and `secretValues({ password: '' }, [''])).toEqual([])` are byte-identical to `tests/secrets.test.ts:47` and `:43`. Neither input contains a character that the JSON-escaping added in this describe would change, so no new branch is reached.
- Recommendation: delete, or change the inputs to something escaping does affect (e.g. a value with `"` given twice) so it tests dedup after escaping.
- Confidence: high

### `tests/secrets.test.ts:785` — "keeps the record floor for a REGISTERED binding, and the name rule for the entry"
- Category: L3
- Evidence: the fixture is `{ 'row.token': '7' }` with `markLoopBindings(live, ['row', 'row.token'])`, asserting `secrets` is `[]`, `redact('3 rows, total $1,742.70', …)` unchanged, and `redactMap` giving `{ 'row.token': MASK }`. `tests/secrets.test.ts:413` makes the same three assertions on the same fixture, plus the four-character case.
- Recommendation: delete.
- Confidence: high

### `tests/tab-observability.test.ts:203` — "the flag is advisory — it is not a status and cannot fail a step"
- Category: L4
- Evidence: `expect(Object.keys(tab!).sort()).toEqual(['label', 'targetId', 'title', 'unexpected', 'url'])`. This pins the exact key set of a typed diagnostic object, so adding any field to `TabInfo` breaks it. Nothing here checks that a step cannot fail, which is what the name claims.
- Recommendation: rewrite to `expect(tab).not.toHaveProperty('status'); expect(tab).not.toHaveProperty('error')`, or delete (TypeScript already fixes the shape).
- Confidence: medium

### `tests/tab-observability.test.ts:278` — "keeps two sessions' identically-labelled tabs distinguishable"
- Category: L1
- Evidence: two folds are fed `targetId: 'SESSION-A-TAB'` and `'SESSION-B-TAB'`, then the test asserts the outputs' `targetId`s differ. Given the pass-through already proved at `tests/tab-observability.test.ts:240`, the difference flows straight from the test's own inputs.
- Recommendation: delete.
- Confidence: high

## Test defects

### `tests/ai-effort.test.ts:169` — "does not invalidate the memoized gateway between profiles"
- Category: Defect (claim not checked; L2 for its stated subject)
- Evidence: this file's `FakeAIGateway` constructor records nothing (`constructor() { this.chat = chatMock; this.stream = streamMock; }`), and every instance shares `chatMock`. The assertions `chatMock` called twice and `lastChatOptions().effort === 'high'` hold whether the gateway is memoized or rebuilt per call.
- Recommendation: add a constructor spy (as `tests/ai-client.test.ts:38` does) and assert the constructor ran once.
- Confidence: high

### `tests/credential-bw-process.test.ts:77` — "answers \"not found\" for a PID that is not running"
- Category: Defect (name does not match what is checked; platform gate it does not need)
- Evidence: `findBwProcess(0)` and `findBwProcess(-5)` return at `if (!Number.isInteger(spawnedPid) || spawnedPid <= 0) return Promise.resolve(null);` (src/credentials/bw-process.ts:138), before PowerShell is spawned. The gone-process branch the name describes is never reached. The test sits under `describe.runIf(process.platform === 'win32')`, so Linux and macOS never run this platform-independent guard.
- Recommendation: move it out of the Windows block and rename it ("refuses a PID that cannot exist"). To cover the gone-process branch, add a Windows case using an already-exited child's PID.
- Confidence: high

### `tests/tab-observability.test.ts:388-392` — "groups by target id, so one tab used by many steps is one row"
- Category: Defect (vacuous assertion line)
- Evidence: `const rows = html.split('tab-row').length - 1; … expect(rows).toBeGreaterThanOrEqual(0);` can never fail. The test's own comment says the class only appears on the unexpected variant. The meaningful assertion is the `class="tab-id"` count of 2.
- Recommendation: delete the `rows` lines.
- Confidence: high

### `tests/cdp-registry.test.ts:23` (also `:531`, `:550`, `:1575`, `:1633`) — fixture roots `path.join('C:', 'proj')`, `path.join('C:', 'users', 'x', 'steptix')`
- Category: Defect (fixture breaks the project's platform rule)
- Evidence: CLAUDE.md, "Unit tests pass on Windows, Linux and macOS": "Never hard-code `C:\…` or `path.join('C:', …)`: on Linux and macOS that is a relative name". It passes today only because the in-memory fs matches exact strings, and `resetProfile`'s `path.relative(realRoot, realDir)` (src/browser/cdp-registry.ts:1468) resolves both sides against the same cwd. Any future `path.isAbsolute`/`path.resolve` in the registry would fail on POSIX only, and CI is Windows-only (`.github/workflows/unit-tests.yml:34`).
- Recommendation: `const ROOT = path.resolve(path.sep, 'proj')` and likewise for `USER` and the `outside`/`target` dirs.
- Confidence: medium

## Duplication clusters
- Keyed aibroker/ default-URL happy path: `tests/ai-client.test.ts:120`, `:303`, `:409` → keep :120.
- No-key refusal: `tests/ai-client.test.ts:196`, `:349` (absent row) → keep the table.
- Default call carries json responseFormat + AbortSignal: `tests/ai-client.test.ts:538`, `:703`, `tests/ai-effort.test.ts:181` → keep :538.
- Change-report join: `tests/ai-client.test.ts:812`, `:869` → keep :869.
- AI_EFFORT on the default call: `tests/ai-effort.test.ts:146`, `tests/bedrock-keyless.test.ts:251` → keep ai-effort.
- Existing-profile launch: `tests/cdp-registry.test.ts:309`, `:322` → keep :309.
- Empty browser still running after an ordinary close: `tests/cdp-registry.test.ts:1136`, `:1277` → merge into :1277.
- Keyless heal-skip copy with no reason: `tests/keyless-replay.test.ts:216`, `:297` → keep :216.
- Dedup/empties of `secretValues`: `tests/secrets.test.ts:42`, `:46`, `:613` → keep :42/:46.
- Registered `row.token: '7'`: `tests/secrets.test.ts:413`, `:785` → keep :413.
- No-history failure, mocked vs real: `tests/browser-history.test.ts:84`/`:91` (mock returning `null`) and `:314`/`:323` (real Chromium, which also assert `retryable: false`). These are different levels, so not flagged; with the real block present, the two mocked failure cases add little.
- Run-total rebaseline: `tests/tokens.test.ts:39` and `:53` (the latter covers the former plus a second mark). Small; optional merge.

## Cost concerns
- `tests/cdp-registry.test.ts:846` ("reports browserExited FALSE when the process outlives its last tab") and `:1155` ("refuses an unowned port, and closes it when allowUnowned is passed"). The `liveBrowser` harness (:719) injects `sleep: async () => {}` but no `now`, and in both tests the port stays alive after the last-tab close. So `pollUntil(() => notAlive(...), { sleep, now: Date.now }, EXIT_CONFIRM_BUDGET_MS)` (src/browser/cdp-registry.ts:1072, 1 500 ms) spins a microtask-only loop for 1.5 s of real wall clock each, starving the worker's event loop. The result is deterministic, but it costs ~3 s of hot CPU per run in a parallel suite. Fix: inject `now: () => (clock += 500)`, as :1143/:1243/:1287 do, or default `liveBrowser` to a fake clock.
- `tests/credential-broker.test.ts:334` ("still completes the login when the submit button will not take a click") always spends the full 5 s `SUBMIT_CLICK_TIMEOUT_MS` before Enter. That is the regression it pins and it is worth keeping. If the timeout becomes injectable, pass a short one.
- `tests/cdp-launcher.test.ts:484` and `:503` spin ~300 ms each on the real `Date.now` deadline with a no-op `sleep`. Minor.
- `tests/credential-real-processes.test.ts` and `tests/credential-bw-process.test.ts:82` leave `mkdtemp` directories in `os.tmpdir()` on every Windows run.

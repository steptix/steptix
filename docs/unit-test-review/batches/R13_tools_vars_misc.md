# R13_tools_vars_misc

## Summary
- Files: 43 (the batch named "13 tool-* files"; 11 exist and all 11 were reviewed) · tests (approx, it.each expanded): ~700 · High ~560 · Medium ~90 · Low 50 · Defects 7 · Flakiness risks: 5 high, 3 medium
- Overall the batch is strong: the variable/placeholder/Set-step files (placeholder-dotted, step-executor-placeholders, prompt-values-block, set-step*, substitution-sites, run-loop-contracts, run-settings) are regression-driven, assert spec-quoted wording, and include mutation-checked source pins. Low value clusters in three places: (1) the tool layer, where the same parse/coercion/alias behaviour is re-asserted across tool-call-parser, invocation-*, tool-array-params, tool-executor and two browser-backed integration files; (2) tests whose subject is not product code — multi-turn.test.ts's 10 tests of in-file re-implementations of logic deleted in c9ea589, test-app-documents.test.ts (fixture-only), and fixture-server/fixture-tool semantics riding on Chromium + tsx-server beforeAlls; (3) assertions weaker than their names (tool-helper:25, clarification-prompt:198, report-tool-step:111, set-step:455).
- L3 question for the tool parser: tool-call-parser, tool-parser-integration and tool-end-to-end are at different levels (pure parser / parseTestContent+parseTestFile / real catalogue+executor), so the levels are not duplicates. The duplication is within levels: tool-call-parser mirrors skill-call-parser over the shared `parseInvocation`, and tool-end-to-end's two demo-file parse tests repeat tool-parser-integration.
- test-app-documents tests the fixture app, not product code. It is partly justified (the live suite and upload-action.test.ts depend on the fixture's `/api/documents` contract), but its page block re-proves with bare Playwright what upload-action.test.ts now drives through the product, and it contains the batch's clearest race (`:324`).
- Systemic flake: four files copy-paste the same fixture-server boot (fixed 15 s `waitForHttp` deadline over a cold `node --import tsx` start, port-0-then-close TOCTOU, a SIGKILL fallback that never fires). The coordinator reports the identical helper failing in open-page.test.ts and upload-action.test.ts under load.

## Flakiness risks

### HIGH — `tests/tool-end-to-end.test.ts:54-88`, `tests/arrays-in-tools-integration.test.ts:56-86`, `tests/extract-order-ids-integration.test.ts:57-86`, `tests/test-app-documents.test.ts:57-138` — beforeAll fixture-server boot (every test in the four files)
- Mechanism: each file carries its own copy of the same three helpers. (a) `async function waitForHttp(url, timeoutMs = 15_000)` polls every 100 ms with a fixed 15 s deadline (`throw new Error(\`Timed out waiting for ${url}\`)` at `:65`/`:66`) after `spawn(process.execPath, ['--import', 'tsx', serverPath], …)` — a cold tsx transform of the 1.7k-line `fixtures/test-app/server.ts`, started by four files at once while every vitest worker is booting. (b) `getFreePort()` does `srv.listen(0)` then `srv.close(() => resolve(p))` before the child binds — another process can take the port in between (TOCTOU). (c) afterAll `serverProc.kill('SIGTERM'); …; if (!serverProc.killed) serverProc.kill('SIGKILL');` — `.killed` becomes true as soon as SIGTERM is sent, so the SIGKILL fallback never runs, and exit is never awaited.
- Risk: high — the same mechanism has been observed failing: per the coordinator, in a loaded root-suite stress run `tests/open-page.test.ts` and `tests/upload-action.test.ts` (sibling files with the same copied helper) failed at file level in beforeAll with "Timed out waiting for http://127.0.0.1:<port>/api/csrf-token".
- Fix: one shared helper (e.g. `tests/helpers/fixture-server.ts`) used by all six-plus files: start the server with `PORT=0`, have `fixtures/test-app/server.ts` print the BOUND port (`server.address().port` — today its listen callback prints `PORT`, which would read 0), await that stdout line with a budget equal to the hook's 60 s, and on teardown `kill()` then `await once(child, 'exit')`. That removes the 15 s guess, the TOCTOU and the dead SIGKILL in one place, and ends the copy-paste (four copies in this batch alone).
- Evidence: commit 2ef64db "Budget tests and hooks for the whole suite running at once" raised these files' hook budgets to 60 s after measuring multi-second slowdowns (and a ~27 s Chromium close) during suite start, but left the inner 15 s deadline untouched; coordinator's stress-run failures in two sibling files.

### HIGH — `tests/test-app-documents.test.ts:313` — "card 2 — clicking Choose file opens a file chooser that can be answered" (failing read at `:324`)
- Mechanism: after `expect((await statusAfterAction()).state).toBe('success')` the test reads `expect(await rowNames()).toEqual(['logo.png'])` with no wait. In fixtures/test-app/documents.html `upload()` calls `setStatus('success', …)` (`:662`) BEFORE `await refreshDocuments()` (`:665`, a second GET of `/api/documents`, then render). The status flips while the table still shows the static `#documents-empty` row, so `rowNames()` can return `[]`. Every other card test waits on the row first (`row.waitFor()` at `:282`, `:306`, `:332`, `:367`).
- Risk: high (only two CDP round-trips inside `statusAfterAction` separate the read from a network fetch)
- Fix: `await page.locator('tr.doc-row[data-name="logo.png"]').waitFor();` before `rowNames()`.
- Evidence: reading of documents.html:637-666.

### MEDIUM — `tests/test-app-documents.test.ts:259-262` — beforeEach of "Documents page" (10 tests)
- Mechanism: `await page.locator('#documents-empty').waitFor();` is meant as "page ready", but `#documents-empty` is static markup (documents.html:538), so it resolves before the page's own initial `refreshDocuments()` returns. That initial GET races the test's upload: if its (empty) response renders after the upload's refresh, the table is wiped and a later `row.waitFor()` times out.
- Risk: medium
- Fix: wait on the page's first fetch (`page.waitForResponse('**/api/documents')` around the `goto`) or a `data-ready` flag the script sets after its first render.
- Evidence: reading of documents.html.

### MEDIUM — `tests/tool-reload.test.ts:33,43` — every test in the file (fixed in-repo temp base)
- Mechanism: `const tmpBase = path.join(repoRoot, 'tests', '.tmp-tool-reload');` and `freshDir()` = `path.join(tmpBase, \`t${counter++}\`)` + `fs.mkdir(dir, { recursive: true })`, never emptied. The counter restarts at 0 each run, so a previous run that aborted (Ctrl-C, watch rerun, or the afterAll `fs.rm` giving up on a Windows lock) leaves `tN/` populated: "discovers a file added after the initial scan" (`:214` `expect(cat.indexedCount).toBe(1)`) then sees a leftover `second.ts`, and "picks up a dir that was missing at first scan" (`:279` `toolsDirMissing).toBe(true)`) finds the dir already there. (The in-repo location itself is deliberate — the `steptix/tools` self-import only resolves under the repo root.)
- Risk: medium (needs an aborted prior run; the file's own history shows the cleanup failing on Windows)
- Fix: `await fs.rm(tmpBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })` in a `beforeAll`, or `freshDir` via `fs.mkdtemp(path.join(tmpBase, 't-'))`.
- Evidence: commit 5e61f46 "Retry removing in-repo temp dirs that Windows briefly locks".

### MEDIUM — `tests/test-runner-clarification-control.test.ts:227` — beforeEach of "test-runner runnerControl handling"
- Mechanism: `Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });` is never restored, so the six later describes in the file run with a forced TTY. Nothing depends on it today (they run headless, which closes the failure-REPL gate) and vitest's forks pool keeps it inside this file, but a test that relies on the default would pass alone and fail in-file (or the reverse).
- Risk: medium
- Fix: save the original descriptor in `beforeAll`, restore it in `afterEach`/`afterAll`.
- Evidence: 2ef64db names this file as one that timed out at vitest's 5 s default under load (now covered by the suite's 30 s budget); its heaviest case is `:719`, two `runTest` calls that each try to bundle a `.steps.ts`.

### Checked and already guarded (no action)
- tool-registry.test.ts: `fs.mkdtemp` per test with a unique counter prefix, so ESM import caching never collides.
- tool-reload.test.ts `:290` concurrency case: temp modules are `${hash}-${randomUUID()}.mjs`, and removal errors are swallowed in src/tools/reload.ts.
- interactive-repl.test.ts / clarification-prompt.test.ts: scripted readers throw when exhausted, so a dispatch bug fails fast instead of hanging.
- retry.test.ts: `withRetry`'s `delayMs` defaults to 0 — no real sleeps. multi-turn.test.ts and step-executor-placeholders.test.ts: executeStep runs against stub pages and scripted clients with no timer-based waits on the paths exercised.
- step-executor-placeholders.test.ts `:443`, `:1028`, `:1076`: every `addLogCallback` is removed in `finally`.
- parameters.test.ts: env mutation is confined to `TEST_PARAM_*` and cleared in before/afterEach. placeholder-dotted.test.ts `:232` deletes `STEPTIX_MCP_ROOTS` rather than restoring a prior value (harmless unless the CI environment sets it).
- save-json-tool.test.ts `:106`: writes under the repo's gitignored `reports/` in a directory named after a fresh `mkdtemp` basename, removed in `finally`.
- viewport-config.test.ts `:219`: `loadConfig()` reads the cwd's tracked steptix.config.json and the machine user-root `.env` (AI key only); `fixedViewport` comes from neither. Low risk.

## Per-file verdicts
| File | Tests | Verdict (High/Medium/Mixed/Low) | One-line note |
|---|---|---|---|
| tool-call-parser.test.ts | 24 | Medium | Tool-kind wrapper over shared `parseInvocation`; ~half the grammar cases mirror skill-call-parser.test.ts; one-keyword-specific cases (non-match, `[toolbox]`, slash refs, error class) are the real value |
| tool-parser-integration.test.ts | 5 | High | parseTestContent/parseTestFile seam: parallel `toolCalls` array, parse-time throw, re-derivation after skill expansion |
| tool-ref-parser.test.ts | 3 | High | pure `parseToolRef` split + empty-segment rejection |
| tool-helper.test.ts | 9 | Mixed | runtime guards + frozen spec are real; one test name claims the `tool(fn)` guard but hits the `tool(name, fn)` guard (defect) |
| tool-end-to-end.test.ts | 18 | Mixed | real server + Chromium; fixture-tool semantics (regex_extract) and demo-file parses ride on an expensive beforeAll |
| tool-executor.test.ts | 21 | High | executor contract: coercion, defaults, aliases, unknown param/output, getVar prototype keys, dotted alias vs loop registry |
| tool-registry.test.ts | 18 | High | lazy index, failure isolation, path-qualified refs, file-vs-dir disambiguation |
| tool-finalise.test.ts | 21 | High | rung 1/2/3 finalisation and return-value→output convention executed through executor |
| tool-reload.test.ts | 18 | High | issue-033 hot reload: edits, helpers, errored-load retry, refreshIndex, concurrency, import.meta, sourcemap; fixed in-repo temp base is a flake risk |
| tool-array-params.test.ts | 11 | High (2 low) | array param decode/encode + labelled errors; scalar-string and alias cases duplicate tool-executor |
| tool-not-found-hint.test.ts | 13 | High (1 low) | diagnostic chain catalogue→executor→report; Windows-path case repeats the interpolation test |
| arrays-in-tools-integration.test.ts | 4 | Mixed | real server+Chromium; `:98` is the one useful seam but hand-writes the read→params storage step it claims to cover; `:191` duplicates tool-array-params:175 |
| extract-order-ids-integration.test.ts | 4 | Low/Mixed | product behaviour (array/number setVar, aliases, downstream decode) already unit-tested in tool-array-params; adds a handbook example tool + fixture-server filter at browser+server cost |
| save-json-tool.test.ts | 8 | Medium | example fixture tool (shipped for projects to copy, `a696405`), run cheaply through the real catalogue/executor; no browser |
| define-tool.test.ts | 8 | Mixed | validation guards are real; the two "happy path" tests assert values that flow straight from the input object |
| test-app-documents.test.ts | 19 | Low/Medium | tests only the SecureBank fixture (no `src/` import); partly justified as the fixture contract the live suite and upload-action.test.ts depend on; page block re-proves what upload-action.test.ts drives through the product; one high-risk race at `:324` |
| interactive-repl.test.ts | 25 | High (4 low) | scripted reader, real command dispatch; four tests differ only in an `entryReason` the dispatcher never reads |
| retry.test.ts | 7 | High | abort short-circuit, non-retryable tag, eventual success; no real delays (`delayMs` defaults to 0) |
| retry-context.test.ts | 22 | Medium/High | prompt-section assertions for each diagnosis branch; numbering checks are loose (`toContain('4.')`) |
| multi-turn.test.ts | 49 | Mixed | 10 tests exercise in-test re-implementations of code removed in c9ea589; executeStep §4 bring-to-front block is high value; one test name contradicts its assertion |
| clarification-noninteractive.test.ts | 1 | High | issue-014 regression through real `executeStep` |
| clarification-prompt.test.ts | 16 | High (1 defect) | `/repl` escape wrapper; reader-forwarding test asserts `toBeDefined` where identity is the claim |
| invocation-array-literals.test.ts | 8 | High (1 low) | bracket depth, `]` in strings, out-alias rejection; last case repeats tool-call-parser:154 |
| invocation-bare-literals.test.ts | 21 | High (3 low) | bare number/boolean grammar and near-miss rejections; two bridge cases repeat tool-executor:85; `]`-adjacency case repeats `:51` |
| invocation-mirror-parity.test.ts | 4 | High | isCodeStep vs the runner's parsers over a hostile corpus (NBSP, case, links, declined candidates) |
| parameters.test.ts | 15 | Medium | interpolate + resolveParameters precedence (env, data row); env cleanup scoped to `TEST_PARAM_*`; one misleading name |
| branched-response.test.ts | 8 | Medium/High | parseBranchedResponse: waiting, case-insensitive, missing `matched`, fenced JSON |
| placeholder-dotted.test.ts | ~55 | High (1 low) | grammar corpus through every reader, refusal sentences (spec-quoted), prototype-key hazards, masking; the regex-source golden is a change-detector |
| prompt-values-block.test.ts | 27 | High (1 low) | `## Values` rendering and masking across every prompt builder; one whole-prompt snapshot |
| substitution-sites.test.ts | 4 | High | source-pin call-count inventory over `src/` + shared-sentence parity; scans are derived, not hand-listed |
| step-executor-placeholders.test.ts | ~50 | High | real executeStep with actions mocked: substitution in every field, refusals, secrecy, rebind clearing, live-map threading |
| test-runner-clarification-control.test.ts | 16 | High | runnerControl exit/resume, ad-hoc row ordering, capture surfacing, stopAfterStep, recording, strict code-behind, env/data, secret masking |
| report-captures.test.ts | 10 | High | Captured block presence/absence, escaping, tool-step suppression, readTable structure line |
| report-source-section.test.ts | 5 | High | section chip, coexistence with skill chip, escaping, distinct CSS class |
| report-source-skill.test.ts | 3 | Medium/High | skill chip + tooltip + escaping |
| report-step-anchors.test.ts | 3 | High | anchor format the scoreboard links to; uniqueness across hooks/loops/data rows |
| report-tool-step.test.ts | 8 | Medium (1 low) | renderToolStep sections, empty states, escaping; the "as-is" primitive case cannot distinguish the branch it names |
| run-loop-contracts.test.ts | ~40 | High (1 low) | applyPassBindings semantics + source pins that all three loops use the shared helpers; one pin is too loose to mean anything |
| run-settings.test.ts | 33 | High (1 low) | merge/clear semantics, complete-config resolution, provenance, AI switch both directions; vocabulary constants re-checked |
| set-step-parse.test.ts | 21 | High (3 dup) | parse-time Set refusals at every substitution site; the four-site table repeats three earlier single tests |
| set-step.test.ts | 45 | High (1 defect) | grammar, errors, resolveSetTemplate, shared grammar JSON, grouper, guarded writes; the "authored line" test cannot catch the regression it names |
| step-context-capture.test.ts | 2 | High | stepContext shape and the cost of the extra capture, via real executeStep |
| viewport-config.test.ts | ~30 | High | resolver presets/bounds/refusal messages (spec-quoted), parser interpolation, loader default, committed schema |

## Low-value tests

### `tests/tool-not-found-hint.test.ts:171` — "handles a Windows-style toolsDir path verbatim"
- Category: L3
- Evidence: `buildNotFoundMessage` (src/tools/registry.ts:384-397) only interpolates `toolsDir` into `` `  Scanned: ${toolsDir} (${filesScanned} file…)` `` — no path handling at all. The test asserts `expect(msg).toContain('C:\\Projects\\vibe\\ai-ui-automation')` and `toContain('5 files')`, the same branch and the same assertion shape as `tests/tool-not-found-hint.test.ts:24` ("includes the tools.dir path when diagnostics is set": `toContain('/abs/path/to/tools')`, `toContain('4 files')`). The "platform path quirk" it claims to probe does not exist in the code.
- Recommendation: delete (or fold the Windows string into the :24 case if desired).
- Confidence: high

### `tests/tool-array-params.test.ts:198` — "treats a scalar string param as before (no behaviour change)"
- Category: L3
- Evidence: `args: { msg: 'hello' }` with `type: 'string'`, asserts `expect(received).toBe('hello')`. Same scalar-string pass-through as `tests/tool-executor.test.ts:29` (`args: { name: 'Ada' }` → `calls` equals `{ args: { name: 'Ada' } }`) and `:56` (placeholder interpolation of a string param). No array branch is involved.
- Recommendation: delete.
- Confidence: high

### `tests/tool-array-params.test.ts:281` — "honours output aliases when storing array outputs"
- Category: L3
- Evidence: alias handling is independent of the value's type — the array is JSON-encoded by `setVar` (covered by `:226`) and the alias is applied on write (covered by `tests/tool-executor.test.ts:116` "applies caller-supplied output aliases" and `tests/tool-finalise.test.ts:160`). Asserts `params['product_codes']` / `params['items']).toBeUndefined()` — the same pair `tool-executor.test.ts:140-141` asserts.
- Recommendation: delete, or keep only if executor ever special-cases array aliasing.
- Confidence: medium

### `tests/tool-end-to-end.test.ts:250-340` — the six "regex_extract: …" tests
- Category: L8 (cost) + one L3 (`:295`)
- Evidence: `regex_extract` lives only in `fixtures/tools/src/regex_extract.ts` (grep of `src/` for `regex_extract`: no hits; it is referenced from issues/020 as "the interim workaround … shipped as a reusable example tool"). Five of the six assert the fixture's own regex logic (`match` = first group, whole-match fallback, flags + group index, "matched nothing", "invalid pattern"). The product paths they touch (number coercion of `group: '2'`, alias, thrown error → failed outcome) are already covered by `tool-executor.test.ts:85`, `:116`, `:270`. `:295` "respects out.match output aliasing" additionally duplicates `tool-end-to-end.test.ts:214` in the same file. All six run behind a beforeAll that spawns the fixture server and launches Chromium, though none touch the page.
- Note: fixture tools are shipped as examples projects copy (commit `a696405`: "Shipped as an example tool projects copy, like the others in fixtures/tools/src"), so guarding regex_extract's semantics is legitimate — the problem is where they run, not that they exist.
- Recommendation: move the five semantic cases to a cheap file that loads `fixtures/tools/src` with no browser/server (the shape `tests/save-json-tool.test.ts` already uses for save_json); delete `:295`.
- Confidence: high (cost), high (`:295` duplicate)

### `tests/tool-end-to-end.test.ts:169` — "parses the demo .md test, recognising tool steps in the parallel toolCalls array"
- Category: L3
- Evidence: asserts `toolStepIndices` and `toolCalls[2]` = `{ name: 'fetch_csrf_token', args: { baseUrl: '{{baseUrl}}' }, outputAliases: {} }` — the same parallel-array + bare-shorthand desugaring `tests/tool-parser-integration.test.ts:31` and `:49` assert through the same `parseTestContent`/`parseTestFile`. Only new thing is that `fixtures/tests/tool-demo.md` parses, and it is coupled to that file's step indices. Needs no browser/server but lives in the e2e file.
- Recommendation: delete, or move to tool-parser-integration if the demo file's parse is wanted as a docs-freshness check. Same applies to `:342` ("parses the regex-extract demo .md"), whose quoted-value-with-colons case is already `tests/tool-call-parser.test.ts:76` / `tests/skill-call-parser.test.ts:250`.
- Confidence: medium

### `tests/define-tool.test.ts:5` — "returns the same definition object passed in"
- Category: L5 (and name/claim mismatch)
- Evidence: `defineTool` is `validateDefinition(def); return def;` (src/tools/define-tool.ts). The test asserts `expect(def.name).toBe('noop')` and `expect(typeof def.run).toBe('function')` — both straight from the literal it passed in; it never checks identity, which is what the name claims. No-throw on a valid definition is already implied by every file that calls `defineTool` (tool-executor.test.ts, tool-finalise.test.ts:17).
- Recommendation: rewrite to `const input = {…}; expect(defineTool(input)).toBe(input);` or delete.
- Confidence: high

### `tests/define-tool.test.ts:16` — "preserves parameter and output schema verbatim"
- Category: L1
- Evidence: since `defineTool` returns its argument unchanged, `expect(def.parameters).toEqual({ a: { type: 'number' }, b: { type: 'number' } })` compares the input with a copy of itself — no logic of the unit sits between setup and assertion.
- Recommendation: delete (or merge into the identity check above).
- Confidence: high

### `tests/arrays-in-tools-integration.test.ts:191` — "fails fast with a labelled error when caller passes a non-array string"
- Category: L3 + L8
- Evidence: `args: { urls: 'not-an-array' }` → `expect(outcome.error).toMatch(/parameter "urls".*expected a string\[\]/)`. Same input class and identical regex as `tests/tool-array-params.test.ts:175` ("reports a labelled error when the value is not a JSON array": `args: { urls: 'not-json' }`). Coercion fails before `run`, so the real browser/server in this file play no part.
- Recommendation: delete.
- Confidence: high

### `tests/arrays-in-tools-integration.test.ts:151` — "inline `urls=["…","…"]` literal works end-to-end without a captured variable"
- Category: L3
- Evidence: inline JSON-array literal decode is `tests/tool-array-params.test.ts:73` ("decodes an inline `urls=["a","b"]` literal into a typed string[]"). The extra here is the fixture `visit_each` tool navigating two pages, which `:98` already shows.
- Recommendation: delete.
- Confidence: medium

### `tests/extract-order-ids-integration.test.ts:140` — "output aliases route results into different variables (no overwrite)" and `:174` — "the emitted array piped into a downstream tool decodes back to a typed string[]"
- Category: L3 (+ L8)
- Evidence: `:140` asserts aliased array/number outputs land under new names with the originals untouched — `tests/tool-array-params.test.ts:281` (array alias) and `tests/tool-executor.test.ts:116` (alias; original undefined). `:174` is the produce-array → consume-`string[]` chain of `tests/tool-array-params.test.ts:308` ("chains: tool A produces a list output, tool B consumes it as an array param"); its sink is a hand-built catalogue stub, so only the first half touches the fixture. Both pay for the tsx server + Chromium beforeAll.
- Recommendation: delete both; keep `:98` as the single seam test of the handbook example (docs/test-writing-handbook.md:1857).
- Confidence: medium

### `tests/extract-order-ids-integration.test.ts:124` — "honours the status filter — failed orders only"
- Category: L7 (tests the fixture server)
- Evidence: the tool only forwards `status` as a query parameter (`if (status) params.set('status', status)`, fixtures/tools/src/extract_order_ids.ts); the filtering is `fixtures/test-app/server.ts:1706-1715`. `expect(JSON.parse(params['order_ids']!)).toEqual(['O-1003', 'O-1007'])` asserts the fixture server's seed data and filter, not Steptix code.
- Recommendation: delete (or fold one `status` call into `:98` if the example's parameter must be shown working).
- Confidence: medium

### `tests/multi-turn.test.ts:283-332` — describe "turn badge tagging semantics" (4 tests) and `:336-377` — describe "cycle detection logic" (6 tests)
- Category: L1 + L7
- Evidence: both blocks define the function under test inside the test file — `/** Mirrors the tagAiResponses helper in step-executor.ts */ function tagAiResponses(...)` and `/** Mirrors the cycle detection condition in step-executor.ts */ function wouldDetectCycle(urlHistory, currentUrl) { return urlHistory.length >= 2 && currentUrl === urlHistory[urlHistory.length - 2]; }` — and assert on that local copy. No product code runs. Worse, the code they mirror no longer exists: `git log -S urlHistory -- src/runner/step-executor.ts` and `git log -S tagAiResponses -- src/runner/step-executor.ts` both end at c9ea589 (2026-04-11, "hybrid vision+DOM architecture"), whose diff deletes `const urlHistory: string[] = []` and the `urlHistory[urlHistory.length - 2]` check; `grep -rn "tagAiResponses\|urlHistory" src` finds nothing today. Real turn numbering is covered through `executeStep` at `:610` and `:584`.
- Recommendation: delete both describe blocks (10 tests). Also drop the stale "Use distinct URLs to avoid cycle detection" comments/URL factories at `:611-614`, `:655-658`, `:693-700`.
- Confidence: high

### `tests/interactive-repl.test.ts:120` — "/exit works in planned-entry mode too", `:142` — "/continue returns continue decision (failure entry)", `:165` — "/resume default in planned entry is also currentStepIndex + 1"
- Category: L3
- Evidence: in `runInteractiveRepl` (src/runner/interactive-repl.ts:160-262) `entryReason` only chooses the banner text and the list `marker`; command dispatch (`if (head === '/continue') return { kind: 'continue' }`, `if (head === '/exit' || head === '/quit')`) and `promptResumeMenu`'s `defaultIndex = Math.min(currentStepIndex + 1, testSteps.length)` never read it. Each of these is its sibling (`:101`, `:133`, `:155`) with only the `entryReason` label changed; `:411` ("clarification-entry /resume default index") is a fourth copy of `:155`.
- Recommendation: delete `:120`, `:142`, `:165`, `:411`, or table-drive one test over the three entry reasons if the "same in every mode" contract is wanted explicitly.
- Confidence: medium (cheap tests; they would only matter if dispatch ever became entry-specific)

### `tests/test-app-documents.test.ts` — whole file (19 tests)
- Category: L7 (no product code) + L8
- Evidence: the file imports nothing from `src/` — only `node:*` and `playwright` — and spawns `fixtures/test-app/server.ts` plus Chromium to test the fixture's own `/api/documents` handler and `documents.html` script. Its header calls it part 1 of stories/file-upload-steps.md, "the 'an upload is automatable at all' proof that the framework's upload-step support (part 2) will be measured against". Part 2 now exists and is tested against the same page: `tests/upload-action.test.ts:117` (visible field), `:127` (hidden input), `:148` (picker), `:155` (multi-file) drive the four cards that `test-app-documents.test.ts:273-336` drive with bare Playwright.
- Justification that remains: the live suite depends on fixture behaviour this file pins (templates/init/tests/securebank-upload-rows.md counts rows; the DELETE→204 reset and rejection messages are what `upload-action.test.ts:112` and the templates rely on), and a fixture break would otherwise surface as a confusing product-test failure.
- Recommendation: keep the `/api/documents` block (`:156-254`) as the fixture's contract test (or move it beside the fixture); delete the four card tests `:273-336`, which upload-action.test.ts now covers through product code. The page-only behaviours (`:338-381`: error text, Clear all, reload) are fixture UI and can go too unless a template asserts them.
- Confidence: medium (value judgement on keeping fixture self-tests in the unit suite)

### `tests/invocation-array-literals.test.ts:58` — "still rejects unquoted scalar values"
- Category: L3
- Evidence: `parseToolCall('[tool: x bar=baz]')` → `toThrow(/expected '"', '\[', a number, or true\/false after '=' for argument 'bar'/)` is character-for-character `tests/tool-call-parser.test.ts:154` (`'[tool: foo bar=baz]'`, same regex), and `tests/invocation-bare-literals.test.ts:108` (`mode=loop`) covers the same error path a third time.
- Recommendation: delete.
- Confidence: high

### `tests/invocation-bare-literals.test.ts:153` — "a bare value adjacent to `]` (no whitespace) closes the invocation cleanly"
- Category: L3
- Evidence: `parseToolCall('[tool: x count=5]')` → `'5'`. Every case in the "bare numeric literals" block already ends with the value against `]` — e.g. `:51` `parseToolCall('[tool: x count=30]')` → `'30'`.
- Recommendation: delete.
- Confidence: high

### `tests/invocation-bare-literals.test.ts:174` — "bare integer → tool receives a real number when type: number is declared" and `:199` — "bare boolean → tool receives a real boolean when type: boolean is declared"
- Category: L3
- Evidence: both hand `executeToolStep` a pre-parsed `args: { count: '30' }` / `{ enabled: 'true' }` — by the time the executor sees them a bare literal is indistinguishable from a quoted one, so this is the string→number/boolean coercion `tests/tool-executor.test.ts:85` ("coerces number and boolean parameter values", `args: { count: '42', flag: 'true' }`) already pins. The parse→execute seam is `:247`, which stays.
- Recommendation: delete `:174` and `:199`; keep `:223` (negative float) and `:247`.
- Confidence: high

### `tests/placeholder-dotted.test.ts:75` — "pins the source string the Steptix copies have to mirror"
- Category: L4
- Evidence: `expect(PLACEHOLDER_SOURCE).toBe('\\{\\{(\\w+(?:\\.[A-Za-z_][A-Za-z0-9_]*)?)\\}\\}')` (and the two siblings) pins regex source text. The cross-package parity it cites is done elsewhere and does not use this golden: `steptix-vscode/tests/placeholder-grammar-parity.test.js` reads `src/parser/parameters.ts` itself (`stringLiteral(source, name)`) and compares the extension's copy to that. Behaviour is pinned by the CORPUS test `:114` and the five-reader parity test `:184`. What this golden adds is a failure on behaviour-preserving rewrites of the regex (e.g. `[A-Za-z0-9_]` → `\w`).
- Recommendation: delete, or keep knowingly as the documented "target that does not move between phases" — but then it is a deliberate change-detector, not a guard.
- Confidence: medium (the comment states the intent explicitly)

### `tests/prompt-values-block.test.ts:104` — "renders NO block for a step that references nothing, and the prompt is byte-identical to today's"
- Category: L4
- Evidence: `const BEFORE = ['## Test Information', '- Test: Login flow', … 'Scroll position: 0–800 of 1600px (at top)', … '```'].join('\n'); expect(noValues).toBe(BEFORE);` — a whole-prompt snapshot of `buildStepMessage`. The contract it was written for (adding `## Values` changed nothing for value-less steps) was one-time; frozen, it now breaks on any wording change to Test Information, Prior Steps or the scroll line, none of which is this feature.
- Recommendation: rewrite to `expect(emptyValues).toBe(noValues); expect(noValues).not.toContain('## Values');` — keeps "empty values = no values" without pinning unrelated sections.
- Confidence: medium

### `tests/report-tool-step.test.ts:111` — "renders boolean and number arg values as-is"
- Category: L2 (cannot fail for the behaviour it names)
- Evidence: `formatToolValue` (src/report/generator.ts:1017-1025) has an explicit `if (typeof v === 'number' || typeof v === 'boolean') return String(v);` branch before the `JSON.stringify(v)` fallback. Delete that branch and `JSON.stringify(true)` / `JSON.stringify(42)` produce the identical `'true'` / `'42'`, so `expect(html).toContain('true'); expect(html).toContain('42');` still passes. It fails only if args are not rendered at all, which `:5` already covers.
- Recommendation: delete (the branch is an optimisation with no observable difference), or, if the as-is contract matters, test a string arg is not JSON-quoted (`args: { s: 'x' }` → no `&quot;x&quot;`).
- Confidence: high

### `tests/run-loop-contracts.test.ts:533` — "%s gets it from interpolate, which it runs on every line" (×2)
- Category: L2 (pin too loose to mean its claim)
- Evidence: `expect(source(file)).toMatch(/interpolate\(/);` passes if `interpolate(` appears anywhere in session-manager.ts / runner-adapter.ts — tests/substitution-sites.test.ts:137,151 inventories 4 and 5 such calls in those files. The claim, "runs it on EVERY line, control lines included, before the dispatch", would survive moving the call after the control dispatch or into an unrelated helper.
- Recommendation: delete (substitution-sites.test.ts already fails if those calls disappear), or pin the ordering the comment describes (the interpolate call precedes the `controls[i]` dispatch in the loop body).
- Confidence: medium

### `tests/run-settings.test.ts:405` — "lists ai among the wire keys, so the route stops refusing it as unknown" and `:409` — "offers \"default\", without which going back would be inexpressible"
- Category: L5 / L3
- Evidence: `expect(RUN_SETTING_KEYS).toContain('ai')` and `expect(AI_MODES).toEqual(['on', 'off', 'default'])` assert constants equal their literals. The behaviour they stand for is exercised end-to-end through the route in tests/api-server-run-settings.test.ts:928-972 (`runSettings: { ai: 'off' }`, then `{ ai: 'default' }`), which fails if `api-server.ts:2796` / `:2819` refuse either.
- Recommendation: delete.
- Confidence: medium

### `tests/set-step-parse.test.ts:165`, `:212`, `:239` — single tests repeated by the four-site table at `:381`/`:391`
- Category: L3
- Evidence: `:165` ("refuses a row value that makes the assignment unparseable": row `He said "hi"`, `/makes the step unparseable/`) = table row "expander.ts — looped section row bindings" (`:368`, `| ${HOSTILE} |`). `:239` ("refuses a skill argument named after a declared OUTPUT") = table row "expander.ts — skill arguments (output-name collision)" (`:348`). `:212` ("leaves a HOOK Set uninterpolated…", `${data.greeting}` = `He said "hi"`, expects the token kept) = `:391` ("the HOOK site preserves rather than refuses", `${env.GREETING}` = same value, same expectation).
- Recommendation: keep the single tests (they assert each site's own message) and tighten the table to per-site messages, or drop the singles and keep the table; either way one copy of each.
- Confidence: high

## Test defects

### `tests/set-step.test.ts:455` — "a target that already holds a value is still a target, not a source"
- Category: Defect (cannot catch the regression its docstring names)
- Evidence: the docstring says "a reviewer measured that mutating any of the four loops to parse the INTERPOLATED line left all 3698 tests green" and presents this as the pin. But the test runs no loop: it asserts `parseSetStep(authored)` parses (already `:23`) and `parseSetStep(interpolate(authored, scope))` is null — facts about the parser that stay true when a loop is mutated. The loop-level pin that does exist is `tests/run-loop-contracts.test.ts:255` (`/setStep \|\| useAiStep\s*\?\s*(raw|original)/`).
- Recommendation: retitle as a demonstration of the hazard and point at run-loop-contracts:250 as the guard, or replace with a test that drives a loop (e.g. `runTest` with a pre-bound target, as test-runner-clarification-control.test.ts does).
- Confidence: high

### `tests/set-step.test.ts:474` — "assigns twice in a row, reading its own previous value"
- Category: Defect (comment contradicts code; minor)
- Evidence: comment "First pass: the template's own reference is unset, so it fails rather than storing the literal" sits above `runSetStep({ name: 's', template: 'a' }, …)` — a template with no reference, asserted to PASS. The failing first pass the comment describes is never run.
- Recommendation: fix the comment, or add the described case (`template: '{{s}}x'` on an empty scope → `failed`).
- Confidence: high

### `tests/parameters.test.ts:34` — "substitutes only word-character keys"
- Category: Defect (name claims a restriction the test does not check)
- Evidence: the only assertion is the positive `interpolate('{{foo_bar}} value', { foo_bar: '42' })` → `'42 value'`; nothing checks that a non-word key is NOT substituted — and since the dotted grammar (`PLACEHOLDER_SOURCE` accepts `order.id`), "only word-character keys" is no longer true of `interpolate`. Also `const originalEnv = { ...process.env };` at `:40` is never used.
- Recommendation: rename to "substitutes a key containing underscores", or add the negative (`{{order-id}}` stays literal).
- Confidence: high

### `tests/multi-turn.test.ts:584` — "single-turn step: no turnNumber on AI responses"
- Category: Defect (name contradicts assertion)
- Evidence: the name promises no `turnNumber`; the assertions are `expect(result.turns.length).toBe(1); expect(result.turns[0]!.turnNumber).toBe(1);` — a turnNumber IS asserted, and `aiInteractions[*].turnNumber` (what "AI responses" refers to) is never checked. The name is a leftover of the deleted `tagAiResponses` behaviour (single-turn interactions carried no `turnNumber`).
- Recommendation: rename to "single-turn step produces exactly one turn"; likewise `:610` "interactions tagged with turn numbers" checks `turns[i].turnNumber` and only `aiInteractions.length >= 1`.
- Confidence: high

### `tests/clarification-prompt.test.ts:198` — "reader passed into the wrapper is forwarded to runInteractiveRepl so a single readline is shared"
- Category: Defect (assertion weaker than the claim)
- Evidence: asserts only `expect(args.reader).toBeDefined();`. The regression the name describes — the wrapper opening a second readline on stdin — is a substitution, not an omission: if `promptUserWithReplEscape` (src/runner/step-executor.ts:4906-4940) passed a freshly created reader instead of `ctx.reader`, `args.reader` would still be defined and the test would pass.
- Recommendation: keep the reader from `scriptedReader(...)` and assert `expect(args.reader).toBe(reader)`.
- Confidence: high

### `tests/arrays-in-tools-integration.test.ts:98` — "captures every link via read multiple, then visits each in a tool"
- Category: Defect (claim wider than the check)
- Evidence: the file header says it exercises "the full chain … read multiple: true → resolvedParameters['links'] = JSON-encoded array → tool", but the storage step is the test's own code: `params['section_links'] = JSON.stringify(readResult.capturedValues);` with the comment "Mirror the storage pass that step-executor.ts does". The real storage (`src/runner/step-executor.ts:3558-3562`) could change encoding and this test would still pass.
- Recommendation: drive the read through the step-executor storage path, or narrow the header/name to "executeAction read-multiple + array decode".
- Confidence: high

### `tests/tool-helper.test.ts:25` — "throws on tool(fn) when the argument is not a function"
- Category: Defect
- Evidence: the call is `tool('only-name-no-fn')` — a STRING first argument, so `tool()` takes the `typeof arg1 === 'string'` branch (src/tools/tool-helper.ts) and throws `'tool(name, fn): second argument must be a function'`. The regex `/argument must be a function/` also matches that message, so the test passes while the `tool(fn)` guard (`'tool(fn): argument must be a function'`, reached only for a non-string non-function such as `tool(42)`) is never executed. `:30` already covers the `tool(name, fn)` guard, so `:25` is both mislabelled and a duplicate.
- Recommendation: rewrite to `tool(42 as never)` and assert `/tool\(fn\): argument must be a function/`.
- Confidence: high

## Duplication clusters
- Shared invocation grammar via `parseInvocation`: `tests/tool-call-parser.test.ts:38-130` (label prefix, `key="value"`, `out.x="y"`, bare shorthand, mixed) mirror `tests/skill-call-parser.test.ts:121-290` one-for-one over the same function with only `kind`/`errorClass`/`allowSlashInName` differing. Keep the tool-specific cases (`:4-36` keyword detection, `:96-105` slash refs, `:132-182` error class/hint); the label/happy-path/shorthand blocks could shrink to one representative case each. Not flagged individually: cheap and they would catch a future fork of the grammar.
- Empty path segments: `tests/tool-ref-parser.test.ts:16` (pure) and `tests/tool-registry.test.ts:207` (through `resolve`) — different levels, keep both.
- Output aliasing: `tool-executor.test.ts:116`, `tool-finalise.test.ts:160`, `tool-array-params.test.ts:281`, `tool-end-to-end.test.ts:214`, `:295` → keep executor:116 (declared output), finalise:160 (derived output), e2e:214 (one real-tool seam); drop array-params:281 and e2e:295.

- Unquoted-scalar rejection: `tool-call-parser.test.ts:154`, `invocation-array-literals.test.ts:58`, `invocation-bare-literals.test.ts:108`, `tool-parser-integration.test.ts:60` (through parseTestContent) → keep tool-call-parser:154, bare-literals:108 (different message branch for identifiers) and the parseTestContent seam; drop array-literals:58.
- String→number/boolean coercion in the executor: `tool-executor.test.ts:85`, `invocation-bare-literals.test.ts:174`, `:199`, `tool-end-to-end.test.ts:281` (regex_extract `group: '2'`) → keep tool-executor:85 and bare-literals:247 (parse→execute seam).
- Array decode/encode: `tool-array-params.test.ts:43-308` (unit) vs `arrays-in-tools-integration.test.ts:151`, `:191` and `extract-order-ids-integration.test.ts:140`, `:174` (Chromium + server) → keep the unit file and one seam test per integration file (`arrays-in-tools:98`, `extract-order-ids:98`).
- Commands that ignore `entryReason`: `interactive-repl.test.ts:101`/`:120`, `:133`/`:142`, `:155`/`:165`/`:411` → keep one per command.
- Slash-text answers at the clarification prompt: `clarification-prompt.test.ts:109`, `:115`, `:121` all take the single `trimmed.toLowerCase() === '/repl'` → false branch. Not flagged: `/exit` and `/continue` pin a deliberate "only /repl is recognised here" decision someone could plausibly reverse.
- Set-step hostile values: `set-step-parse.test.ts:165`/`:368`, `:239`/`:348`, `:212`/`:391` (see Low-value).
- Set-step grammar: `set-step.test.ts:30`, `:35`, `:61`, `:69` overlap rows of the shared GRAMMAR_LINES table (`:226-246`) checked by `:253`. Cheap; not flagged, but the table is now the source of truth.
- Viewport refusals naming their value: `viewport-config.test.ts:67`, `:77`, `:85`, `:114` and the loop at `:140` assert the same "message contains the bad value" for overlapping inputs (`390`, `390×844`, `phone`, `50x50`). Cheap; could fold into the loop.
- `retry-context.test.ts:183` and `:200` build the identical `isLoading: true` input and assert different lines of the output (assessment vs instruction); merge into one test.

## Cost concerns
- `tests/tool-end-to-end.test.ts` spawns `fixtures/test-app/server.ts` via tsx and launches Chromium for 18 tests; only 4 (`check_health`, `read_page_title`, `fetch_csrf_token` ×3) need the server and 1 needs the page. The regex_extract, uuid, slugify and demo-parse tests could live in a cheap file.
- `tests/extract-order-ids-integration.test.ts` and `tests/arrays-in-tools-integration.test.ts`: each spawns the tsx fixture server and launches Chromium for 4 tests, of which 2–3 per file re-assert unit-tested executor behaviour (see Low-value). One seam test per file would keep the integration value.
- `tests/test-app-documents.test.ts`: tsx server + Chromium for 19 fixture-only tests; the 9 `/api/documents` tests need only `fetch`, not the browser.


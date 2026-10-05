# R05_mcp

## Summary
- Files: 20 · tests (approx): 535 test functions (~590 cases once the three `it.each` tables expand) · High ~390 · Medium ~120 · Low 25 · Defects 4 (+2 recorded under Low because they are also low value) · Flakiness risks 5 (0 high, 5 medium)
- Quality is high overall. The seam suites use a real MCP client over `InMemoryTransport` and fake only the outside world. Their assertions check the refusals, normalisations and wire shapes the tool layer owns, and most compare error text against the exported builders rather than against phrases. `run-fold`, `registry`, `server-start` (fake clock, fake spawn, deferreds) and `project` (real tmpdirs, user root redirected) are strong pure or near-pure suites.
- Low value comes from three main sources:
  - **Copies of seam refusals in the `-real-app` files.** The session_id wrong door and the zero-match and many-match tab refusals fire in the tool layer before or without any HTTP, so the real server adds nothing to those tests.
  - **The tab-matcher rules written out twice**, once in errands-seam and once in peek-seam. Both go through the shared pure `matchTabsByName`, and that function has no direct unit test.
  - **A few pass-through tests** where the asserted value is the fake's own default.
- One dead path: `mcp-assemble` tests a tool-supplied `config.tableStructure` that neither the zod `toolConfig` nor `assembleTestFile`'s parameter type admits. The suite is not type-checked (`tsconfig` excludes `tests`), so nothing flags it.
- The `-real-app` files earn their keep where they cross the real wire. That covers the env, envName, sections, parameters and sourceLines allow-list, the turn-lock 409 `holder` round trip, `full_page` through four layers, the project dom limit, and `navigate_tab` not closing the tab it opened.

## Flakiness risks

No high risks. Ports are 0 everywhere, and the real-app files park `executeStep` on promises rather than timers. `server-start` drives a fake clock and a `spawned` deferred. `mcp-project` and `mcp-server-start` redirect `LOCALAPPDATA`/`XDG_CONFIG_HOME` into tmp, and every temp dir comes from `mkdtemp`. Vitest's default forks pool isolates `process.env` per file. `git log` on every file in this batch shows no flake, race or timeout fixes, and every timing construct below dates from the file's first commit, unchanged since. The five below are medium: none is likely to turn a run red today, but each relies on timing or order it does not control.

### `tests/mcp-server-start.test.ts:604` — "reports an abort during the poll as a cancellation, not an auto-start failure"
- Mechanism: the shared single-flight start outlives its cancelled caller and is left to settle by a wall-clock sleep: `async function drain() { await new Promise((resolve) => setTimeout(resolve, 25)); }` (line 159-161), called at line 620 after `h.up = true`. If that start has not settled when the next test begins, `beforeEach`'s `resetRegistry()` clears the map. The stale start's `.finally(() => startsInFlight.delete(key))` (src/mcp/registry.ts:134-136) can then delete the next test's in-flight entry, and the start could also `recordStartFailure` into the next test's registry. Either way a later single-flight or backoff test would fail for a reason that has nothing to do with its own code.
- Risk: medium. Today the start settles within one event-loop check phase, well inside 25 ms, but the guarantee comes from a timer.
- Fix: join the shared promise instead of sleeping. After `h.up = true`, run `await ensureServerReadyWith(makeProject(), undefined, h.deps)`; with no signal, that joins the same single-flight promise. Alternatively, have the harness resolve a "settled" deferred from `probe` once `h.up` is seen.
- Evidence: reasoning (registry.ts single-flight cleanup); the construct is unchanged since bfe0e47.

### `tests/mcp-seam.test.ts:1808` — "aborts the run and leaves the session open"
- Mechanism: `setTimeout(() => controller.abort(), 40);` races the server handler reaching `streamSteps`. The fake attaches its listener only once called (lines 107-114: `signal?.addEventListener('abort', …)`) and never checks `signal.aborted`. If the abort lands first, the fake sits out the full `holdMs: 5_000`. On a slow box the server-side abort path is then never exercised, though the test still passes: the client rejects locally, and the "after" call waits up to 5 s for the lock.
- Risk: medium. The test is slow, and its result depends on which path the timer happened to hit.
- Fix: in the fake, `if (signal?.aborted) return reject(signal.reason)` before waiting. Drive the abort from a `started` deferred the fake resolves, instead of a 40 ms timer.
- Evidence: reasoning; unchanged since bfe0e47.

### `tests/mcp-api-client.test.ts:313` — "rethrows on our own cancellation rather than calling it a dropped stream"
- Mechanism: `setTimeout(() => controller.abort(), 30);` with `.rejects.toThrow()`, which accepts any error. If the response headers have not arrived within 30 ms, `fetch` itself rejects, and the `if (signal?.aborted) throw err` branch in `consumeRunStream` (src/mcp/api-client.ts:259) is never reached. A regression in that branch would then go unnoticed on that run.
- Risk: medium. The test never goes red, but under load it does not test what its name says.
- Fix: abort from the `onEvent` callback (the 4th `streamSteps` argument) after the first `step:start`. Also assert the rejection is an AbortError and that no `StreamResult` with `streamDropped: true` was returned.
- Evidence: reasoning.

### `tests/mcp-peek-real-app.test.ts:620/667/737`, `tests/mcp-errands-real-app.test.ts:575/687/994`, `tests/mcp-peek-real-app.test.ts:1028` — order-dependent shared state in the real-app files
- Mechanism:
  - **Report mock.** `expect(generateReportMock).not.toHaveBeenCalled()` runs on a module-level `vi.fn` that is never cleared, while later tests (peek 932/960/990, errands 911/948/994) drive `run_steps` sessions. Those sessions call `generateReport` (src/server/session-manager.ts:2921/3318/8424), so these assertions pass only because the session tests are declared last.
  - **Session counts.** `expect(await listSessionIds()).toEqual([])` (errands 741, 1029; peek 1027) relies on earlier tests closing their sessions. errands :948 and peek :990 close outside `finally`.
  - **Shared fixture.** peek :667 mutates the shared `TABS` fixture (`cart.urlText`) and restores it only at the end of the test.
- Risk: medium. These fail under `--sequence.shuffle`, and a single real failure cascades into unrelated red tests.
- Fix: `vi.mocked(generateReportMock).mockClear()` at the start of each test that asserts it un-called. Close sessions in `finally` or `afterEach`. Restore `TABS` in `finally`.
- Evidence: reasoning (session-manager.ts generateReport call sites).

### `tests/mcp-assemble.test.ts` (whole file), `tests/mcp-errands-real-app.test.ts`, `tests/mcp-peek-real-app.test.ts`, `tests/mcp-real-app-seam.test.ts` — real user root read on every resolve
- Mechanism: these call the real `resolveProject` without redirecting the user root. `withServerDiscovery` always evaluates `readMachineKey()` (src/mcp/project.ts:447-451), and `allowedRoots()` canonicalises the real `%LOCALAPPDATA%\steptix` (project.ts:141-148). The developer machine's real user-root `.env` is therefore read in every test. `readUserRootEnv` rethrows any non-ENOENT error (src/env/user-root.ts:66-74).
- Risk: medium. Machine state leaks into unit tests: an unreadable or odd user root on one machine changes outcomes.
- Fix: redirect `LOCALAPPDATA` and `XDG_CONFIG_HOME` into a tmp dir in `beforeEach`/`beforeAll`, exactly as `tests/mcp-project.test.ts:121-132` and `tests/mcp-server-start.test.ts:166-180` already do.
- Evidence: reasoning. Unlike its siblings, mcp-assemble's `beforeEach` (lines 82-89) only deletes `STEPTIX_SERVER_URL` and `STEPTIX_SERVER_API_KEY`.

Checked and fine:
- `mcp-registry:108` (real 20 ms timer, asserts only `>= 10`) and `mcp-seam:1788` (`holdMs: 60`, asserts `> 0`, and the FIFO order is deterministic): both assert lower bounds that load cannot undercut.
- `mcp-content-blocks` server_status/get_run_settings rows connect for real to `127.0.0.1:1`. Either probe outcome yields a valid result.
- `mcp-entry-graph` runs real child processes with 60 s budgets and exits on stdin close; see Cost.
- The fd that `mcp-server-start` opens for the child log is closed in `finally` (server-start.ts:518-521), so the Windows `rmSync` in `afterEach` will not EBUSY.

## Per-file verdicts
| File | Tests | Verdict (High/Medium/Mixed/Low) | One-line note |
|---|---|---|---|
| tests/mcp-api-client.test.ts | 35 | High | Real-socket transport facts (dropped stream, 404 tab-vs-route split, empty statusText) and SSE framing; one pass-through route test (L1) |
| tests/mcp-assemble.test.ts | 33 | High (3 low) | Real resolver plus real parser goldens on the finished wire body. Tool-supplied `tableStructure` is a dead path (L7); one viewport case duplicates another (L3) |
| tests/mcp-cdp-seam.test.ts | 89 | High | §6 gate, profile and port resolution, version-skew backfills, errand-holder routing. The close "maps every output field" test only echoes the fake (L1) |
| tests/mcp-content-blocks.test.ts | 4 (20 cases) | High | listTools-driven guard that every tool serialises structuredContent into content; table keys pinned to the registration |
| tests/mcp-entry-graph.test.ts | 4 | High | Real dist/ spawns proving `steptix mcp` skips the browser stack and keeps stdout clean. Tests 1 and 2 spawn the identical process (merge) |
| tests/mcp-errands-real-app.test.ts | 12 | Mixed | Allow-list, receipt, lock-holder round trip, `${env.X}` mid-errand failure: high. Three refusals duplicate errands-seam, the page-type filter duplicates peek-real-app, and :994 duplicates api-server-errands |
| tests/mcp-errands-seam.test.ts | 37 | High | Wrong doors, the tab matcher, receipt wording, dropped-stream remedy swap, turn-lock 409 routing |
| tests/mcp-navigate-seam.test.ts | 9 | High | Refuses names/positions before the wire; no port/allow_unowned in the schema |
| tests/mcp-no-browser-yet.test.ts | 5 | High | Wire-sentence parity test (high); message tests medium; one `not.toBe` duplicates the test above it |
| tests/mcp-peek-real-app.test.ts | 12 | Mixed | `full_page` through four layers, project dom limit, navigate_tab keeping its opened tab: high. Three refusals duplicate peek-seam; the page-type filter duplicates errands-real-app |
| tests/mcp-peek-seam.test.ts | 38 | High (5 low) | 404 split, screenshot half, oversize cap, candidate-sharing proof. The five matcher-rule tests copy errands-seam |
| tests/mcp-project.test.ts | 53 | High | Security boundary: roots, `..`, segment boundaries, symlinks, env layering, user scope. :796 duplicates :396 under a wrong name; symlink tests silently pass when symlinks are unavailable |
| tests/mcp-real-app-seam.test.ts | 6 | High | Wire allow-list (envName, parameters, sections, env, sourceLines) through the real server; stale harness comment |
| tests/mcp-registry.test.ts | 13 | High | Deferred-driven ordering; single-flight with caller-owned cancellation; backoff keys |
| tests/mcp-run-fold.test.ts | 62 | High | Pure fold: attribution, not-run vs unknown, skip kinds, tolerated/deliberate, screenshot privacy switch |
| tests/mcp-run-fold-masking.test.ts | 7 | High | Captures masked by name, record shape and later disclosure |
| tests/mcp-schema-dialect.test.ts | 6 (+33 cases) | High | `$schema` omission and draft-07 vs 2020-12 parity; its hardcoded tool list repeats mcp-seam:316 |
| tests/mcp-seam.test.ts | 73 | High (4 low) | isError contract, real-client SSE composition, run settings, progress, first-request config rule. One mislabelled pass-through test and three duplicates |
| tests/mcp-server-start.test.ts | 29 | High | Fully faked spawn/probe/clock decision tree, spawn recipe, backoff, single-flight; one 25 ms drain timer |
| tests/mcp-url.test.ts | 8 | High | Every spelling of loopback gets one key |

## Low-value tests

### `tests/mcp-api-client.test.ts:374` — "returns last-run info as given"
- Category: L1
- Evidence: the server handler does `res.end(JSON.stringify({ finalized: false }))`, and the test asserts `await expect(client.getLastRun('s1')).resolves.toEqual({ finalized: false })`. `getLastRun` (src/mcp/api-client.ts:425-432) is `assertOk(res); return (await res.json()) as LastRunInfo;`, so no logic sits between stub and assertion. The one thing the method decides, the URL `/sessions/<encoded id>/last-run`, is never checked.
- Recommendation: rewrite to assert the request path (encoded id) and the `x-api-key` header, or delete.
- Confidence: high

### `tests/mcp-assemble.test.ts:273` — "lets a tool `tableStructure` override the file per key" and `:281` — "sends a tool `tableStructure` for a file that declares none"
- Category: L7 (dead path)
- Evidence: both pass `assemble(..., { config: { tableStructure: … } })`. Production reaches `assembleTestFile`/`assembleSteps` only from src/mcp/tools.ts:2085 and :2140, with `config: args.config`, and `args.config` is parsed by zod `toolConfig` (src/mcp/schemas.ts:173-189). That schema declares only `baseUrl`, `timeout`, `viewport` and `cdp`, and a `z.object` strips unknown keys. `grep -rn tableStructure src/mcp/` finds only assemble.ts:656-658 (the file-config whitelist) and types.ts (the wire type). The `config` parameter type of `assembleTestFile` (assemble.ts:134-147) has no `tableStructure` either. These tests compile only because `tsconfig.json` excludes `tests/`. No agent can supply a tool `tableStructure`, so the behaviour these names describe does not exist.
- Recommendation: delete both. Keep :265 (the file-declared whitelist line is real). If a tool-level override is wanted, add it to `toolConfig` first and then test through `run_steps`.
- Confidence: high

### `tests/mcp-assemble.test.ts:255` — "sends a tool `viewport` for a file that declares none"
- Category: L3
- Evidence: `assemble('simple.md', { config: { viewport: 'tablet' } })` followed by `toEqual({ viewport: 'tablet' })`. This is the same input shape and code path as :290 (`assemble('simple.md', { config: { viewport: '390' } })` followed by `toEqual({ viewport: '390' })`), with a different value. The per-key merge is the generic `mergeDefined`, and :217 already covers it.
- Recommendation: delete. :290 keeps the "server owns validation" claim and the same coverage.
- Confidence: high

### `tests/mcp-cdp-seam.test.ts:875` — "maps every output field through as structured content" (close_cdp_tab)
- Category: L1
- Evidence: the fake's default `closeCdpTab` returns `title: 'OpenRouter — Docs'`, `remainingTabs: 7`, `browserExited: false`, and so on (lines 136-148). The handler builds `const result = { ...closed, owned: …, scope: …, warnings: … }` (src/mcp/tools.ts:3107-3115). The test's `toMatchObject` lists only the spread-through fields, never the three the handler derives. The same path's success (`isError` falsy) is asserted by :789, and the text by :894 and :939.
- Recommendation: rewrite to assert the derived `owned: true` and `scope: 'project'` backfill, the way the focus twin at :1197 does with `toEqual`, or delete.
- Confidence: high

### `tests/mcp-no-browser-yet.test.ts:49` — "is a different answer from the session-gone one"
- Category: L3
- Evidence: `expect(err.message).not.toBe(pageContentSessionGone('s-1').content[0]!.text)`. Two different builders produce different strings unless someone aliases one to the other. The test at :38 already pins the specific hazard (`not.toMatch(/no session named/i)`, `not.toMatch(/does not exist/i)`).
- Recommendation: delete. The real gap is that no test drives `get_page_content` with a 409 carrying `NO_BROWSER_LAUNCHED_WIRE_MESSAGE` to prove `isNoBrowserYet` (src/mcp/tools.ts:639) routes it. That test would be worth adding instead.
- Confidence: medium

### `tests/mcp-seam.test.ts:1101` — "warns that the page may be moving during a run"
- Category: L1, and a test defect: the name does not match what is checked.
- Evidence: the only assertion is `expect(res.structuredContent).toMatchObject({ status: 'executing' })`, and `'executing'` comes from the fake (`connect({ pageContent: { status: 'executing' } })`). The handler copies it through: `status: page.status ?? 'active'` (src/mcp/tools.ts get_page_content value block). It emits no warning, and the test checks none. The only "warning" is static description prose ("`status` comes back `executing` — the page may move under you").
- Recommendation: delete. If a warning is intended, implement it and assert on it in the content text.
- Confidence: high

### `tests/mcp-seam.test.ts:989` — "tells the agent a truncated result was truncated"
- Category: L3
- Evidence: same behaviour and input class as :935, "carries a truncation warning in the content blocks too". Both set `truncated: true` with `returnedChars`/`availableChars` and assert the counts plus "selector" in the content text (:947-948 `toContain('900')`, `toContain('narrow with a selector')` against :1002-1003 `toContain('20000')`, `toContain('selector')`). :989 adds only `structuredContent toMatchObject({ truncated: true, availableChars })`, which echoes the fake.
- Recommendation: merge into :935 and delete :989.
- Confidence: high

### `tests/mcp-seam.test.ts:913` — "puts the page in the content blocks, not only in structuredContent"
- Category: L3
- Evidence: `tests/mcp-content-blocks.test.ts:320` (it.each, `get_page_content` row) already asserts that the content blocks contain `JSON.stringify(result.structuredContent)` and that `texts[0]` is a non-JSON summary. `:347` also asserts the page appears exactly once, in escaped form. :913's `blocks toContain('You have 3 unpaid invoices.')` and `toContain('chars')` are implied by those.
- Recommendation: delete; the content-blocks suite owns this contract for every tool.
- Confidence: medium

### `tests/mcp-seam.test.ts:405` — "counts the steps a return skipped, instead of reporting them as a shortfall"
- Category: L3
- Evidence: the fake-client version of :438, which sends the same four-step return shape over the real `createApiClient` and real SSE, and whose last assertion is the identical `toContain('PASSED — 2 passed, 2 skipped (a step returned early) of 4')`. :438 covers everything :405 does and also proves the event whitelist.
- Recommendation: delete :405 and keep :438.
- Confidence: medium

### `tests/mcp-peek-seam.test.ts:324, :330, :336, :342, :423` — "matches a bare string against the title", "…against the url as well as the title", "matches case-insensitively", "narrows to titles with title~ and to urls with url~", "never lets a name reach the wire — only an exact target id does"
- Category: L3 (one finding)
- Evidence: line for line the same cases, over the same `TABS` fixture, as `tests/mcp-errands-seam.test.ts:380, :386, :394, :400` (e.g. `peek(h, { tab: 'activity |' })` followed by `T-ACT`, against `errand(h, { tab: 'activity |' })` followed by `T-ACT`). Both tools call the shared pure `matchTabsByName` (src/mcp/cdp.ts:240). peek-seam:392 already proves both tools feed the same candidate list, character for character. :423 (`tab: 'title~Cart'` reaching `T-CART`) is the :342 case again.
- Recommendation: replace both sets with one pure table test of `matchTabsByName`; no direct unit test exists today. Keep one wiring test per tool: peek-seam:311 and errands-seam:368 assert the port came from profile resolution.
- Confidence: high

### `tests/mcp-errands-real-app.test.ts:636` — "refuses session_id before it touches anything (item 6)"; `:656` — "refuses a name matching nothing…"; `:671` — "refuses a name matching two…"
- Category: L3 (one finding)
- Evidence:
  - **:636.** The session_id refusal fires in the tool handler before `withProject`, so no HTTP request is made and the real server cannot affect the outcome. `tests/mcp-errands-seam.test.ts:236` already asserts the refusal, `listCalls` empty and `errands` empty.
  - **:656 and :671.** These refusals come from the tool-side matcher over the listing, and are asserted by errands-seam :417 and :432, the latter including "only the candidates". "Over the real listing" adds nothing new, because every successful real-app test (:544, :575, …) already resolves names against the real listing route.
- Recommendation: delete all three. The file's distinct value is the allow-list, the receipt and the lock routing.
- Confidence: medium

### `tests/mcp-peek-real-app.test.ts:840` — "refuses a name matching nothing…"; `:849` — "refuses a name matching two…"; `:883` — "refuses session_id before it touches anything (item 6)"
- Category: L3 (one finding)
- Evidence: the peek counterparts of the finding above. `tests/mcp-peek-seam.test.ts:359` and `:372` compare the same refusals against the same builders (`peekTabNotFound`, `peekTabAmbiguous`). `:223` covers the session_id wrong door, which fires before `withProject` (src/mcp/tools.ts:3287-3289), so no server is involved.
- Recommendation: delete.
- Confidence: medium

### `tests/mcp-peek-real-app.test.ts:865` (or `tests/mcp-errands-real-app.test.ts:799`) — "never makes an iframe, a browser_ui target or a dialog a candidate"
- Category: L3
- Evidence: the two files use the same mocked `knownProfilesAcross`, which calls `discovery.probePort(CDP_PORT, 1_000, devToolsFetch)` over the same raw target list. The filter they exercise is therefore cdp-discovery's `toPageTabs` via `probePort`, reached through the test's own mock rather than the product's registry sweep. That filter is already pinned by `tests/cdp-launcher.test.ts:145-198` ("toPageTabs — the shared filter", and `expect(probed.tabs).toEqual(toPageTabs(raw))`). peek-seam:392 proves both tools match over one candidate list.
- Recommendation: keep one of the two (errands :799, which also checks the executor saw only the control step) and delete the other.
- Confidence: medium

### `tests/mcp-errands-real-app.test.ts:994` — "never blocks a run_steps batch on a tab an errand is driving (item 3)"
- Category: L3
- Evidence: the claim sits entirely on the server side, since sessions take no lock. `tests/api-server-errands.test.ts:2723` makes the same claim with the same park-then-run shape against the route: `parkSteps('errand')`, then `cdpSession('wheel-parallel')` expecting status 200 and `passed`. The MCP `run_steps` path contributes no errand logic, and :911 and :948 already prove that `run_steps` sessions bind to the tab through the real tools.
- Recommendation: delete. :911 likewise overlaps api-server-errands:2693 but adds the tool-level `list_sessions` check, so it can stay.
- Confidence: medium

### `tests/mcp-project.test.ts:796` — "a project skillsDir/toolsDir pointing into the user root is dropped, not loaded"
- Category: L3, and a test defect: the name and fixture do not match what is checked.
- Evidence:
  - The config is `{ tests: { skillsDir: '../../steptix-evil-skills' } }` relative to `parent/proj`, which resolves to `<tmpdir>/steptix-evil-skills`. That is not the user root.
  - The test then runs `mkdirSync(path.join(parent, 'steptix-evil-skills'))`, a different directory from the one the config names, so "Even if such a directory exists" is never true.
  - It asserts a refusal (`toContain('outside every allowed root')`), not "dropped, not loaded". `resolveProjectDir` calls `confinePath` before any existence check (src/mcp/project.ts:310-318).
  - The result is the same behaviour as :396, "refuses a toolsDir that resolves outside the allowed roots" (`toolsDir: '../../../evil'`).
- Recommendation: rewrite so the config targets `testUserRoot()` (as :787 does for `tests.dir`) and assert the actual outcome, or delete as a duplicate of :396.
- Confidence: high

### `tests/mcp-entry-graph.test.ts:76` — "writes nothing to stdout that is not protocol"
- Category: L3 / L8
- Evidence: `const result = await runWithProbe(['mcp']);` is the identical child process :69 already spawns ("loads no browser stack, and exits when stdin closes"). Each spawn is a real `node --import probe dist/index.js` start with a 60 s budget, and :76 only adds `expect(result.stdout).toBe('')` on an equivalent run.
- Recommendation: merge by adding `expect(result.stdout).toBe('')` to :69 and delete :76. That saves one real process start per run with no loss.
- Confidence: high

## Test defects

### `tests/mcp-project.test.ts:207, :598, :812` — symlink tests ("refuses a symlink inside the root that points outside it", "refuses a .env.<name> symlinked outside the allowed roots", "a base .env symlinked into the user root is refused")
- Category: Defect (silent pass)
- Evidence: `if (!trySymlink(…)) return;`, where `trySymlink` swallows every error (lines 110-117). Directory links use a junction on win32, so :207 always runs. :598 and :812 create FILE symlinks (`'file'`), which on Windows need admin rights or Developer Mode. On a machine without either, both tests return green without asserting anything about the security boundary they are named for.
- Recommendation: use `ctx.skip()` (or `it.skipIf` computed from a probe at load time) so an unprivileged run reports "skipped" rather than "passed".
- Confidence: medium (depends on the machine's symlink privilege)

### `tests/mcp-real-app-seam.test.ts:272-275` — harness comment for `assertServerRecognized`
- Category: Defect (misleading fixture comment)
- Evidence: the comment says "a bare `createApiServer`, which serves no /health route through this harness — so the identity probe would refuse a server we know is ours". The same file's :385 asserts `server_status` reports `running: true` against that server, and `tests/mcp-errands-real-app.test.ts:498-503` states "`createApiServer` registering it unconditionally". The reason given for the stub is stale.
- Recommendation: correct the comment (the stub exists because nothing calls it, not because `/health` is missing).
- Confidence: medium

### `tests/mcp-url.test.ts:71` — "returns a stable key for an unparseable URL instead of throwing"
- Category: Defect (weak assertion)
- Evidence: `expect(canonicalServerKey('not a url')).toBe(canonicalServerKey('not a url'))`. "Stable" is trivially true for any deterministic function, so the only real check is the implicit not-throwing.
- Recommendation: `expect(() => canonicalServerKey('not a url')).not.toThrow()`, and assert it differs from a real URL's key so it cannot collide with `127.0.0.1:3100`.
- Confidence: high

### `tests/mcp-seam.test.ts:104-115` — fake `streamSteps` with `holdMs`
- Category: Defect (fake ignores an already-aborted signal)
- Evidence: `const timer = setTimeout(resolve, script.holdMs); signal?.addEventListener('abort', …)` never checks `signal.aborted`. The real client checks it, and the fake's `abort` event never fires for a signal that is already aborted. See the :1808 flakiness entry.
- Recommendation: `if (signal?.aborted) { reject(signal.reason); return; }` before arming the timer.
- Confidence: high

(The two remaining defects are recorded under Low because they are also low value: `mcp-seam.test.ts:1101`, where the name says "warns" and nothing warns, and `mcp-project.test.ts:796`, where the name says "user root" and "dropped" while the fixture targets neither and the test asserts a refusal.)

## Duplication clusters
- **Tab-matcher rules** (targetId exact, title, url, case, `title~`/`url~`): `tests/mcp-errands-seam.test.ts:368-415` and `tests/mcp-peek-seam.test.ts:311-357, :423`. Replace with one pure table test of `matchTabsByName` and keep one wiring test per tool.
- **Errand refusals, seam vs real-app**: `mcp-errands-seam.test.ts:236, :417, :432` against `mcp-errands-real-app.test.ts:636, :656, :671`. Keep the seam versions.
- **Peek refusals, seam vs real-app**: `mcp-peek-seam.test.ts:223, :359, :372` against `mcp-peek-real-app.test.ts:883, :840, :849`. Keep the seam versions.
- **Page-type filter (iframe, browser_ui, dialog)**: `mcp-errands-real-app.test.ts:799`, `mcp-peek-real-app.test.ts:865`, `cdp-launcher.test.ts:145-198`. Keep cdp-launcher plus one real-app test.
- **Session/errand coexistence**: `mcp-errands-real-app.test.ts:994` against `api-server-errands.test.ts:2723` (drop :994); `mcp-errands-real-app.test.ts:911` against `api-server-errands.test.ts:2693` (partial overlap; keep).
- **Registered tool-name list hardcoded**: `mcp-seam.test.ts:316` (bare names), `mcp-schema-dialect.test.ts:60-78` (identical 17-name list as "guard the guard"), and `mcp-content-blocks.test.ts:310` (keys equal to `listTools()`). Keep seam:316 and content-blocks:310. In schema-dialect, replace the list with `expect(tools.length).toBeGreaterThan(0)` so a new tool is not a three-file edit.
- **Truncation summary in content text**: `mcp-seam.test.ts:935`, `:989`. Keep :935.
- **Return-skip summary line**: `mcp-seam.test.ts:405` (fake client) and `:438` (real client). Keep :438.
- **Page carried in content blocks**: `mcp-seam.test.ts:913` and `mcp-content-blocks.test.ts:320, :347`. Keep content-blocks.
- **Per-key config merge**: `mcp-assemble.test.ts:217` (timeout), `:244` (viewport), `:255` (viewport, tool-only), `:273`/`:281` (tableStructure, dead), `:290` (viewport passthrough). Keep :217, :236, :265, :290 (and :244 at most).
- **Auto-start per tool**: `mcp-cdp-seam.test.ts:303, :378, :1128, :1381` and `mcp-seam.test.ts:1972` (it.each over three tools). All are medium wiring checks; fold the four cdp ones into the it.each table (no deletion needed).
- **Empty and whitespace session_id**: `mcp-errands-seam.test.ts:252/264`, `mcp-peek-seam.test.ts:239/250`. Each whitespace case could be one more row of its "" test; minor.

## Cost concerns
- `tests/mcp-entry-graph.test.ts`: four real `node dist/index.js` spawns, and :69 and :76 start the identical `mcp` process. Merging saves one cold start (about 1 s, more on a loaded runner). The suite is `describe.skipIf(!built)`, so a plain `npx vitest` without a build skips it silently. That is documented, but worth knowing.
- The three real-app files each boot `createApiServer` with real HTTP. That is cheap and justified for the allow-list and lock-routing tests. The duplicated refusal tests (6 tests, plus one filter test) are the part not paying for themselves.

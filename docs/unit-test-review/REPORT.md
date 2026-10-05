# Unit test review — value and flakiness

Reviewed 2026-10-05 against `main` at 5ff18be. Scope: the four unit suites —
root `npm test` (vitest, `tests/`), `runner-core`, `flick-vscode` and
`steptix-vscode`. Integration and live suites are out of scope.

- [FINDINGS.md](FINDINGS.md) — all 401 findings, grouped by suite and file, one row each.
- [batches/](batches/) — the 16 detailed reviews, with quoted evidence for every finding.
- [PROGRESS.md](PROGRESS.md) — what was done about each item, and how it was verified.

> **Status (2026-10-05):** every item below has been acted on in
> [PR #190](https://github.com/pkent/steptix/pull/190). Items not acted on are the ones the
> findings themselves said to keep, cost notes with no cheaper form, and
> merges that would weaken a check; PROGRESS.md lists them.

## Verdict

**Value is high; reliability is not.**

- **9,338 tests** were read in full: root 7,371 · steptix-vscode 1,270 · runner-core 629 · flick-vscode 68.
- **Value.** Roughly 85% are high value, 10% medium and **5% low** — about
  450 tests in 233 findings. **65 more tests are defective**: they do not check
  what their name or comment claims. Worse, **17 tests (§2.2) cannot fail at
  all**.
- **Flakiness is the bigger problem.**
  - **CI:** 7 of the last 20 runs failed, each on at least one flaky root test.
    One cause is fixed (4598ebb); two are still open.
  - **This machine, under load:** every one of the 5 root runs failed —
    including both runs in normal order — across **11 different files**.
  - **Most were predicted:** reviewers had flagged 8 of those 11 files by
    reading alone, before any test ran. The flaky CI crop test was the one that
    reading missed.
- **runner-core and steptix-vscode** were clean over 50 runs each.
  **flick-vscode** failed 2 of 50.

Fix the flakes first. A suite that goes red for no reason trains people to
re-run instead of reading the failure, and that costs more than every
low-value test here put together.

## 1. Flakiness

### 1.1 Evidence

**CI** — GitHub Actions on `windows-latest`, the 20 runs since the workflow
landed on 2026-10-01:

| Test | Failures | Status |
|---|---|---|
| `codebehind-writer` "waits out a moment's lock on the file" (EPERM on rename) | 5 | Fixed in 4598ebb — the lock is now released on cue. Green in every run since. |
| `parser-control-flow` "the control-flow examples in docs/ parse" | 1 | Not a flake: it failed every time on CI's CRLF checkout. Fixed in 25a1829. |
| `record-steps-toolbar.test.ts:446` "the pick outline and label are never in the crop…" | 2 | **Open.** `await sleep(300)` (:453), then `expect(pixelsNear(shot, blue)).toBeGreaterThan(50)` got 0: the outline had not painted yet. |
| `stats-run-stats.test.ts:347` "the recorder adds well under 5 ms a step" | 1 | **Open.** A wall-clock performance assertion; it measured 8.7 ms. |

**Local stress runs.** All five root runs below failed. They ran on this
machine (12 cores) while 16 review agents and repeated node-suite runs kept it
busy — a fair stand-in for a contended CI runner. Runs 3–5 used
`--sequence.shuffle` to expose order dependence.

| Run | Order | Failed | What failed |
|---|---|---|---|
| 1 | file order | 4 | `computer-step.test.ts:1385` (wait budget charged in wall time) · `selector-role-names.test.ts:309` (`waitForSelector` 5 s timeout) · `open-page.test.ts` and `upload-action.test.ts` at `beforeAll` (fixture server not up within 15 s) |
| 2 | file order | 1 | `api-server-record-steps.test.ts:593` "a quick burst of actions goes in ONE call" (two gestures straddled the 500 ms settle window) |
| 3 | shuffle seed 11 | 38 | `page-content-capture.test.ts` ×30 (order: a test overrides `getComputedStyle` to throw and never restores it) · `read-multiple.test.ts` ×2 (order) · `mcp-peek-real-app` ×3 and `mcp-errands-real-app` ×1 (order) · `stats-classify.test.ts:425` (500 ms Playwright budgets) |
| 4 | shuffle seed 2026 | 8 | `mcp-peek-real-app` ×5 and `mcp-errands-real-app` ×1 (order) · `read-multiple.test.ts` ×1 (order) · `secret-field-parity.test.ts:69` (order) |
| 5 | shuffle seed 777 | 22 | `page-content-capture.test.ts` ×17 · `read-multiple.test.ts` ×3 · `mcp-peek-real-app` ×1 · `secret-field-parity.test.ts:69` — all order |

**Node suites** (50 rounds each, run alongside the root runs):

| Suite | Failed runs |
|---|---|
| runner-core | 0 / 50 |
| steptix-vscode | 0 / 50 |
| flick-vscode | **2 / 50** — `tests/integration/controller.test.ts`, a `FakeWebview.waitFor` that timed out at 3 s |

### 1.2 Confirmed flakes — fix these first

| # | Where | Mechanism | Fix |
|---|---|---|---|
| 1 | `tests/record-steps-toolbar.test.ts:446` | A fixed `sleep(300)` stands in for "the outline has painted". | Poll with the file's own `until()` until the outline's pixels appear. Keep the `toBe(0)` checks on the crop. |
| 2 | `tests/stats-run-stats.test.ts:347` | `expect(average).toBeLessThan(5)` over 20 wall-clock samples. One GC pause fails it. | Assert on the median or the minimum of three runs, or loosen the bound to catch regressions only. Keep printing the figure. |
| 3 | The fixture-server boot, copy-pasted into 6 files: `open-page`, `upload-action` (both seen failing), `tool-end-to-end`, `arrays-in-tools-integration`, `extract-order-ids-integration`, `test-app-documents` | `waitForHttp` gives a cold `node --import tsx fixtures/test-app/server.ts` a fixed 15 s. `getFreePort()` closes its port before the child binds it (TOCTOU). The SIGKILL fallback never fires, because `ChildProcess.killed` is already true once SIGTERM is sent. | One shared helper. The server binds `PORT=0` and prints the port it bound. The test waits for that stdout line within the hook's 60 s budget, fails fast if the child exits, and awaits `'exit'` on teardown. |
| 4 | `tests/computer-step.test.ts:1385` (also `:1296`, `:1413`) | The wait budget is charged in real elapsed time against 200–300 ms limits, while the tests assert exact turn counts. | Give `ComputerStepOptions.computer` the injectable `sleep`/`now` that `executeComputerAction` already takes. |
| 5 | `tests/selector-role-names.test.ts:304-322` | `expect(Date.now() - started).toBeLessThan(4_000)` around real Playwright waits. Also a 5 s `waitForSelector` under load. | Drop the elapsed check — `success` already proves the wait ended on the page change — and raise the wait budget. |
| 6 | `tests/api-server-record-steps.test.ts:593` | Two separate Playwright gestures must land inside a 500 ms settle window. | Hold the first call open with `holdCalls()`, as other tests in the file do. |
| 7 | `tests/stats-classify.test.ts:425` | Six pages open at once, each with 500 ms Playwright timeouts. `blocked` and `ambiguous` come back as `timeout` or `no-match` under load. | Run the six probes one after another, and wait for the element to be `attached` before each verdict. |
| 8 | `flick-vscode/tests/integration/controller.test.ts:359` (all 14 `historyReplace` waits) | The last step is `saveHistory`/`persistSessions` through `writeJson` (`src/store.ts:153`): a fixed `${file}.tmp` name, then a `rename` that is never retried. `track()` swallows any failure, so the test can only time out after 3 s. Most likely Defender holding the file. | Product fix: a unique tmp name per write, and retry the rename on EPERM/EBUSY. Have `track()` record errors so tests can fail on them. Raise the `waitFor` ceiling to ~15 s. |

### 1.3 Order dependence — latent, and real

These pass in file order and fail when shuffled, run alone (`-t`, `.only`), or
after someone inserts a test above them:

| Where | Shared state |
|---|---|
| `tests/page-content-capture.test.ts:688` | `window.getComputedStyle = () => { throw new Error('boom') }` on the shared page, never restored. Under shuffle it failed 30 tests. |
| `tests/read-multiple.test.ts:173` | Replaces the DOM of the page the other five tests read. |
| `tests/secret-field-parity.test.ts:69` | Failed in 2 of the 3 shuffled runs. The recorder test needs the form's fields empty at `recorder.start()`. The snapshot test at `:99` fills them, and its comment says so: "Values are already filled by the test above". Run that way round, re-filling with the same value records no change, so `type-password` is missing. Reset the form, or use a fresh page, at the start of `:69`. (Its 2.5 s bounded flush at `stop()` is a separate, medium timing risk.) |
| `tests/mcp-peek-real-app.test.ts`, `tests/mcp-errands-real-app.test.ts` | `generateReportMock` is asserted not-called but never cleared. Session counts rely on earlier tests closing theirs (two close outside `finally`). `:667` mutates the shared `TABS` fixture. |
| `tests/api-server.test.ts:589` | "Ensure at least one session exists (from prior tests)". |
| `tests/test-runner-clarification-control.test.ts:227` | `process.stdout.isTTY` forced true and never restored. |

**Consider a scheduled CI job** that runs the root suite with
`--sequence.shuffle`. That keeps this class from growing back.

### 1.4 High risk, not yet seen failing

| Where | Mechanism |
|---|---|
| `tests/api-server-cdp.test.ts:724, :750, :999, :1224` | Concurrency tests release their gate after a 20 ms timer, or use a 30 ms sleep as the overlap window. The same file already uses the safe pattern elsewhere: a promise gate plus `vi.waitFor`. |
| `tests/credential-bw-process.test.ts:82` | A fixed 1.5 s sleep for "node has started under cmd.exe", then a PowerShell process lookup. This runs on every Windows CI run. `credential-real-processes.test.ts:82` copies the same sleep, so a slow start there turns into a **silent skip** instead of a failure. |
| `tests/record-steps-recorder.test.ts:725` (and `:696`) | Exact history-read counts after a fixed 400 ms sleep, while each read takes 150 ms and they run one after another. |
| `tests/record-steps-toolbar.test.ts:500` and `:818` | `after.atMs - beforePause < 1_000` across a real click and polling. A 1.5 s click budget. |
| `tests/test-app-documents.test.ts:313` | Reads table rows straight after the status turns to success, but the page sets that status before its refresh fetch returns. |
| `tests/use-ai-step-runner.test.ts:188` | **A time bomb.** Fixture date `2031-01-05`, plus `expect(all).not.toContain(String(new Date().getFullYear()))`. It fails on every run from 2031-01-01. Build the year from the clock plus 5. |

### 1.5 Systemic patterns behind the medium risks

Each of these appears in several files. Fixing them as a sweep is cheaper than
fixing them one by one. Every file and line is in [FINDINGS.md](FINDINGS.md).

1. **Wall-clock budgets and fixed sleeps used as waits** — about 30 tests. The
   usual shapes are:
   - `expect(Date.now() - started).toBeLessThan(N)`;
   - `await sleep(N)` followed by an exact count;
   - abort timers of 30–100 ms;
   - `vi.waitFor` left at its 1 s default.

   The fix is the pattern the codebase already uses in its best tests: an
   injected `now`/`sleep`, `vi.useFakeTimers({ toFake: ['Date'] })`, or waiting
   on an event or promise gate instead of a deadline.
2. **Fixed in-repo temp dirs reused across runs.** `tests/.tmp-<name>/t<counter>`,
   with the counter restarting every run and cleanup only in `afterAll`.
   - **Files:** 7 code-behind files, `flow-control-runner`, `use-ai-step`,
     `use-ai-runner-cli`, `tool-reload`, `selector-targeting-transcript`,
     `failure-outcomes-runner` and `api-server-loops-compile`.
   - **Failure mode:** one killed run or one EBUSY in `afterAll` (commit
     5e61f46 shows that happens) leaves stale `.steps.ts` and sidecar files.
     The next run reads them as input. Two runs in one checkout delete each
     other's files.
   - **Fix:** `fs.mkdtemp(path.join(repoRoot, 'tests', '.tmp-<name>-'))`. The
     location stays in-repo, which package self-resolution needs.
3. **`rm` with no `maxRetries` on Windows.** Mostly in `os.tmpdir()` cleanups
   over freshly written files:
   - `codebehind-upload`, `api-server-condition-codebehind`,
     `compile-runner-flow-control`, `video-recording`;
   - in steptix-vscode: `invocation-target-core`, `third-party-notices`,
     `server-url`, `record-steps`;
   - in flick-vscode: `controller.test.ts`.

   `force` does not ignore EBUSY/EPERM. Add `maxRetries: 10, retryDelay: 100`,
   as 28 other suites already do.
4. **Port races.** Some tests listen on port 0, close it, then hand the number
   to a child process: the fixture helper, `dialog-guard.test.ts:360`
   (Chromium `--remote-debugging-port`) and `cli-server-lifecycle.test.ts:43`.
   Let the child bind 0 itself and report the port back.
5. **Leaks from the developer's machine into the result:**
   - **The real user root.** These read `%LOCALAPPDATA%\steptix`:
     `api-server-cdp.test.ts:584`, `mcp-assemble`, both `mcp-*-real-app` files
     and `session-project-bundle.test.ts:140`.
   - **The repo's own `steptix.config.json` through `cwd`:**
     `video-config.test.ts:41` and `config-loader.test.ts:72-101`.
   - **Ambient env vars:** `resolve-env-bundle.test.ts:49/103` assume
     `ADMIN_PWD` is unset.
   - **Locale:** `stats-api-seam.test.ts:388` expects `'9,325'` from an
     unlocalised `toLocaleString()`.
   - **A Prettier config anywhere above the checkout.** About 30 code-behind
     asserts pin Prettier's output, and `formatCodeBehindSource` resolves a
     config upward from the file. The repo has none of its own; committing a
     `.prettierrc` pins it.
   - **The global git config:** hooks and templates in `build-info.test.ts`.
   - **`cwd`-relative `docs/`:** `parser-control-flow.test.ts:541`.
6. **Writes outside the repo.** `tests/api-server-data-rows.test.ts` uses the
   fake path `/tests/*.md`. On Windows that writes real sidecar files to
   `C:\tests\.steptix-codebehind-cache\`. **The folder exists on this machine**,
   with an older `.aiui-codebehind-cache\` beside it, so this has been
   happening since before the rename. Build the path from `mkdtemp`, then delete
   `C:\tests\`.
7. **Stale builds, in breach of CLAUDE.md's "Keep `npm test` building first".**
   CI is safe because `npm ci` runs runner-core's `prepare`. Locally, a change to
   `runner-core/src` is not under test until someone rebuilds it, and nothing
   says so.
   - **`runner-core`** has no `pretest`, yet every test imports `../dist/`.
     Add `"pretest": "npm run build"`.
   - **`steptix-vscode`**'s `pretest` builds the repo root only. 17+ of its
     test files import `steptix-runner-core`, which resolves to
     `runner-core/dist`. Make it
     `npm run build --prefix .. && npm run build:runner-core`.

## 2. Low-value tests

About 450 tests in 233 findings, out of 9,338. The suites are layered on
purpose: grammar → planner → executor → each run loop → API → client. Reviewers
counted the same behaviour checked at different levels as coverage, not
duplication; a test was flagged only when it repeats a sibling **at the same
level**.

| Kind | Findings | What to do |
|---|---|---|
| L3 duplicate | ~150 | Delete or fold into the sibling named in the finding. The biggest clusters: field-copy and alias cases written longhand across `action-parser`, `assertion-action` (6 of its 8 tests), `open-page` and `drag-reload-actions`; `read-table.test.ts` siblings on one fixture; the shared SSE code checked in both `api-client.test.js` and `record-steps.test.js` (~13 tests); real-app MCP copies of seam refusals; `secrets.test.ts` repeats. |
| L7 dead subject | ~35 | Delete together with the dead production code (§2.1). |
| L5 trivial / L4 change-detector | ~25 | Constants checked against their own literal, one-line wrappers, prompt line wraps, exact undocumented headlines. |
| L1 tautological | ~12 | Assert only what a fake returned. |
| L2 cannot fail | ~15 | Rewrite, not delete: they claim coverage nobody has (§2.2). |

### 2.1 Tests of code nothing calls

Grep confirmed that none of these has a production caller in `src/`,
`runner-core/src`, `steptix-vscode/src` or `flick-vscode/src`. Deleting the
tests is the easy half: the production code is dead too. Deleting that is an
owner decision, and some of it may be API kept on purpose.

| Production code | Tests |
|---|---|
| `src/api/auth-resolver.ts` (whole module) | `tests/auth-resolver.test.ts` — the whole file, 19 tests |
| `cleanHtmlString` / `extractInteractiveElements` (`src/browser/dom-cleaner.ts:1205`) | `tests/dom-cleaner.test.ts:9-102` (13) |
| Functions re-implemented **inside the test file**; the production originals were deleted in c9ea589 | `tests/multi-turn.test.ts:283-377` (10) |
| `scrollDurationMs`, `easeOutCubic` — the animator inlines its own copy, so these tests cannot catch a change to it | `tests/scroll-action.test.ts:218-261` (6) |
| `summarizeSpec` | `tests/spec-loader.test.ts:5-59` (5) |
| `ApiResponseStore.getForStep`, `getAll`, `clear` | `tests/api-response-store.test.ts` (5) |
| `interpolateEnvDataDeep` | `tests/interpolate-env-data.test.ts:119-148` (3) |
| `FakeDesktopAdapter` | `tests/desktop-adapter.test.ts:203, :222, :264` |
| A tool-level `config.tableStructure` — the schema and the assembler do not accept it; the test compiles only because `tests/` is not type-checked | `tests/mcp-assemble.test.ts:273, :281` |
| `SessionManager.lastRunDetails` (removed in 6c4abcb) | `tests/api-server-codebehind.test.ts:669` |
| `IdleMonitor.idleFor` outside `isExpired` | `tests/idle-monitor.test.ts:69` |
| runner-core `isHostMsg` / `isRunEvent` / `isCompileEvent` | `runner-core/tests/protocol.test.js` — 15 of its 19 tests; `record-steps.test.js:132, :136` |
| runner-core `resolveRunLines`, `isStepLine`, `nearestStepAtOrBelow` / `nearestStepAtOrAbove` | `runner-core/tests/step-lines.test.js`, `sections.test.js` |
| runner-core `claimedControlForm` / `isControlLineClaim` | `tests/control-line-parity.test.ts:215` |
| Error codes STX002, STX020, STX026, STX030, STX031 (no emitter) | `runner-core/tests/errors.test.js` |
| steptix-vscode `changesTouchAnchor`, `filterToStepLines`, `dataRowLinesOf`, `shiftMarkLine` | `anchor-shift.test.js:190/198`, `step-lines-inline.test.js:33-59`, `row-selection.test.js:561`, `mark-lines.test.js:274` |
| The extension-side `stripHeadline` / `stripDetail` — so `compile-strip-copy-parity.test.js` compares the live webview copy against code nothing calls | `compile-progress.test.js:43-69`. Point the parity check at the copies actually drawn. |
| Fixture-only: no product code imported | `tests/test-app-documents.test.ts`. Keep the `/api/documents` contract block; drop the four card tests, which `upload-action` already covers through the product. Also `extract-order-ids-integration.test.ts:124`. |

### 2.2 Tests that cannot fail

These are worse than missing tests: they say a behaviour is covered when it
isn't. Rewrite each one so it asserts the claim.

| Where | Why it cannot fail |
|---|---|
| `tests/session-manager.test.ts:553`, `:1353` | The assertions sit inside the mocked `executeStep`. SessionManager catches the AssertionError and returns an `error` result, and the test never checks the status. |
| `tests/api-server-stepmode.test.ts:1455` | With no skills, sections or control lines the server never expands, so the filter it names is never reached. |
| `tests/api-server-compile-mode.test.ts:1048` | Checks the lock after the run has already released it. |
| `tests/api-server-tools.test.ts:509` | Checks "no capture" on a stream it aborted itself. |
| `tests/api-server-cdp.test.ts:1245` | The only assertion is `closeCdpTabMock` not called, on a route that never calls it. |
| `tests/browser-launch-args.test.ts:148` | `fetch` is not stubbed, so the `connectOverCDP` it asserts on is `undefined`. |
| `tests/config-loader.test.ts:83` | Sets the flag to `false` and asserts `false`, which is the default. |
| `tests/tab-observability.test.ts:388` | `expect(rows).toBeGreaterThanOrEqual(0)`. |
| `tests/read-table.test.ts:1520` | `typeof new Function(...) === 'function'`. |
| `tests/desktop-lock.test.ts:71` | Both calls run in the same millisecond, so "keeps the original `since`" is untested. |
| `tests/report-tool-step.test.ts:111` | The branch it names makes no observable difference. |
| `tests/run-loop-contracts.test.ts:533` | `interpolate(` anywhere in the file satisfies it. |
| `flick-vscode/tests/unit/browser-launcher.test.ts:132` | Both calls pass `deps`, which bypasses the cache under test. |
| `steptix-vscode/tests/lm-bridge-core.test.js:624` (stream half) | Mutates a `JSON.parse` copy of a string, so nothing can alias. |
| `steptix-vscode/tests/skill-run-targets.test.js:46` | On Linux and macOS it only checks `samePath(x, x)`. |
| `tests/api-server-compile-mode.test.ts:1041` | `return`s early off Windows, so it passes with zero assertions there. Use `it.runIf`, per CLAUDE.md. |

### 2.3 Tests that check less than their name says

The other ~50 defects are good tests whose name, comment or assertion has
drifted apart. A few that matter:

- **`tests/api-server-stepmode.test.ts:845`** — named "over skips a skill body
  atomically", but it pauses inside the body. Its only assertion passes for
  `into`, `over` and `out` alike.
- **`tests/test-runner-control-flow.test.ts:860`** — "the control" assertion can
  never fail.
- **`tests/codebehind-skill-params.test.ts:402`** — both `toContain` checks are
  satisfied by unrelated text. It should assert the mapping line itself; `:459`
  and `:520` have the same weakness.
- **`tests/api-server-codebehind-debugger.test.ts:528`** — says itself that it
  passes with or without the fix.
- **`tests/codebehind-live-compile.test.ts:369`** — the throw is caught before it
  reaches the queue it claims to test. `:578` asserts `< 3` where `0` is the
  claim.
- **`tests/tool-helper.test.ts:25`** — passes a string, so it never reaches the
  `tool(fn)` guard it is named for.
- **`tests/ai-effort.test.ts:169`** — the fake constructor records nothing, so a
  rebuild on every call would still pass.
- **`runner-core/tests/errors.test.js:171`** — "real-looking command ids" only
  checks for non-empty strings. It passes with the unregistered
  `steptix.reopenAsText`.
- **`runner-core/tests/protocol.test.js:54`** — "accepts every webview variant"
  leaves out `rerunFailedRows`.
- **Hard-coded `C:` paths, against CLAUDE.md's cross-platform rule:**
  `tests/cdp-registry.test.ts:23` (and 4 more), `codebehind-recorded-captures:42`
  and `report-failure-outcomes:29`.
- **Misleading names:**
  - `parser-inert-headings:110`, `skill-expander-sections:429`,
    `skill-expander-frames:118`;
  - `anchor-shift.test.js:276` (named "does not move", asserts that it does);
  - `multi-turn:584`.

## 3. What is good, and should stay

Value is the strong side of this suite. The reviewers judged about 85% of it
high value:

- **Parity tests.** Two implementations that cannot import each other are run
  over shared cases: webview vs. extension, CLI vs. server, runner-core vs.
  `src/`. All the parity files compare two copies that both exist and both
  ship, except `compile-strip-copy-parity` (§2.1) and part of
  `control-line-parity`.
- **Source-pin tests.** `stats-call-sites` guards its scan with minimum counts,
  so it cannot pass by scanning nothing. Under load, `runner-core` and
  `steptix-vscode` were clean over 50 runs each.
- **Real-browser tests where the code only runs in a browser:**
  - `read-table.js`'s vendor grid shapes — Kendo, DevExpress, RadGrid, MUI and
    ag-Grid — are distinct and worth their cost;
  - so are DOM capture and selector verification.
- **Fakes at the boundary.** The fakes stand in for the SDK, the desktop and
  the browser. What the tests assert is the unit's own decisions, so there is
  almost no "tests the mock" (L6).
- **Regression tests named after real incidents.** The best-guarded flaky areas
  (the writer lock, the condition judge's 30 s budget, idle-monitor) already
  use fake clocks or on-cue gates. That is the template for the fixes in §1.

## 4. Suggested order of work

1. **The 8 confirmed flakes (§1.2)**, the 2031 time bomb, and the two
   `pretest` scripts (§1.5 item 7). These are small, and they stop the red runs.
2. **The order-dependent files (§1.3)**, and a scheduled shuffled CI run.
3. **The four high-risk files in §1.4**, then the sweeps in §1.5:
   - one shared fixture-server helper;
   - `mkdtemp` for the `tests/.tmp-*` dirs;
   - `maxRetries` on every recursive `rm`;
   - fake clocks in place of `Date.now()` bounds;
   - user-root and env isolation;
   - remove `C:\tests\`.
4. **The 17 cannot-fail tests (§2.2)** — rewrite them so they assert their
   claim.
5. **Dead code (§2.1)** — decide what to remove from production, and delete the
   tests with it.
6. **Duplicates and trivial tests** — prune file by file using
   [FINDINGS.md](FINDINGS.md), and fix the name/assertion mismatches as you
   pass.

Items 1–3 change test code only, apart from four small product changes:
`flick-vscode/src/store.ts` (atomic write with retry), the test-app server
printing its bound port, `ComputerStepOptions` taking `sleep`/`now`, and an
atomic write in `history-appender.ts`, which `placeholder-grammar-parity`
reads from. Each of these also makes the product more robust.

## How this review was done

- **Reading.** 16 reviewers split the suites into topic batches of ~10–13K
  lines, and each read every test in its batch, plus the source under test
  wherever a verdict depended on it. Every finding cites `file:line` and the
  quoted line, and is marked `high` (verified) or `medium` confidence.
- **Shared rubric:**
  - categories L1–L8;
  - house idioms that are not defects — parity tests, source pins, rationale
    comments, regression tests, platform gating;
  - a flakiness checklist covering timing, contention, order, async teardown,
    real resources and nondeterminism.
- **Empirical checks:**
  - CI logs for all 20 runs, plus `git log` for earlier timing fixes;
  - 5 root runs, 3 of them shuffled;
  - 50 runs of each node suite, on a loaded machine.
- **Not done:**
  - mutation testing, so "cannot fail" was proven by reading, not by mutating
    the code;
  - Linux and macOS runs. CI covers Windows only, and the cross-platform
    findings come from reading.

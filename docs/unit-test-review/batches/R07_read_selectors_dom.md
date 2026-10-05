# R07_read_selectors_dom

## Summary
- Files: 19 · tests (approx, with `it.each`/loops expanded): ~538 · High ~430 · Medium ~75 · Low 33 · Defects 5 · Flake risks 5 (1 high, 4 medium)
- The batch is strong. Most tests drive a real Chromium because what they cover (the 2.7k-line page-side `read-table.js`, `capture-dom.js`, selector verification, innerText vs textContent) runs only in a browser, so the real-browser cost is justified almost everywhere. Nearly every test is a named incident or a spec clause pinned by its exact refusal sentence.
- Low value comes in three shapes: (1) one dead subject — 13 `cleanHtmlString` tests on a regex helper that only tests call (dom-cleaner.test.ts:9-102); (2) duplicates inside the big table suites, where a sibling already asserts a strictly stronger `toEqual` on the same fixture or the same structural branch (read-table :145, :456, :627, :1994, :1326, part of :872; selector-measurement :177; page-content-capture :900); (3) tests whose premise outlived a refactor — the expand-walk "other copy of the rule" masking tests (dom-cleaner :166, :248) now that `isSecretField` is one shared script, and source-text negatives for removed sentences (read-table :3109). popup.test.ts's alias rows are mostly made identical by the parser's name folding.
- Flakiness: the one high risk is an elapsed-time assertion in selector-role-names (`< 4_000` around a real wait, ×4 cases). The repo's own commit 518069b measured that a test taking a second alone can take several while workers start, and a Chromium close took ~27 s against ~70 ms later in the same run. The other risks are a 10 s wall-clock window (selector-measurement), two latent order dependences on a shared page (read-multiple's DOM swap, page-content-capture's poisoned `getComputedStyle`), and a fixed in-repo temp dir (selector-targeting-transcript). Well-guarded patterns worth copying are already in the batch: a throw-away page for prototype patching (selector-uniqueness :243), port 0 + mkdtemp (api-server-table-structure), and routed fake origins rather than a listening 8787 (read-page-url, selector-role-names).

## Flakiness risks
(per-risk entries below; files checked and found clean are listed at the end of this section)

Context for every real-Chromium file here: commit 518069b ("Budget tests and hooks for the whole suite running at once", 2026-10-01) measured that "a test that takes a second alone can take several, and closing a Chromium took up to ~27 s" while all workers start, and raised the suite to 30 s/test, 60 s/hook. Any assertion on elapsed wall-clock time inside these files is therefore exposed to a several-fold slowdown that the repo has already observed.

### `tests/selector-role-names.test.ts:304-322` — "waits until it holds: %s" (4 parameterised cases)
- Mechanism: elapsed-time assertion on a real browser under suite load — `const started = Date.now(); … expect(Date.now() - started).toBeLessThan(4_000);` (:311, :321), against a page whose change fires from an in-page `setTimeout(..., 300)` (:293-300) and a wait `timeout: 5_000`.
- Risk: high (four cases; the repo's own measurement is that a 1 s test can take several during worker start-up, and this budget allows ~13× a 300 ms event)
- Fix: drop the elapsed check — `result.success === true` already proves the wait resolved on the change, because a wait for the literal selector times out and fails. If the "did not burn its timeout" property must be kept, raise the action `timeout` to e.g. 20 s and assert `< 15_000`, so the margin scales with the slowdown.
- Evidence: commit 518069b names `selector-role-names`' afterAll among the hooks that timed out under the same load.

### `tests/selector-measurement.test.ts:255` — "contributes no targeting when the wait times out"
- Mechanism: wall-clock window around a real 10 s Playwright timeout — `expect(elapsed).toBeGreaterThan(8_000); expect(elapsed).toBeLessThan(16_000);` (:274-275). The upper bound leaves 6 s for the post-timeout failure path (`matchCount` via `count()` etc.) on a loaded box.
- Risk: medium
- Fix: assert the budget, not the clock — wrap the page in a Proxy (as :280-307 already does) that records the `timeout` option passed to the hoisted `waitFor` and to `click`, and assert they share one budget. Failing that, drop the upper bound or widen it (the property is "not 20 s", so `< 19_000`). A spy-based version also removes ~10 s of wall time (see Cost concerns).
- Evidence: reasoning + 518069b's measured slowdown.

### `tests/selector-targeting-transcript.test.ts:318-329` — "the recording on disk" (2 tests)
- Mechanism: fixed scratch directory inside the repo — `const tmpBase = path.join(repoRoot, 'tests', '.tmp-selector-targeting');` with subdirs `t${counter++}` that restart at `t0` in every process, and an `afterAll` that `fs.rm`s the whole `tmpBase`. Two vitest processes in one checkout (a watch run beside `npm test`, or a re-run while a hung worker is still alive) write the same `t0/checkout.md` recording and one's `afterAll` deletes the other's directory mid-test. Single-run CI is unaffected; the `rm` already carries `maxRetries: 10` for Windows locks.
- Risk: medium
- Fix: `dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stx-targeting-'))` per test (or per file) and remove only that.
- Evidence: reading.

### `tests/read-multiple.test.ts:173` — "caps capture at READ_MULTIPLE_MAX (500) when the selector matches more"
- Mechanism: order dependence on a shared page. The five tests at :92-169 read the DOM set once in `beforeAll` (`await page.setContent(html)`, :85); this test replaces it (`await page.setContent(...#bulk...)`, :175). The file's own comment admits it: "Page-content-replacing tests live at the bottom because Playwright's setContent swaps the DOM and earlier `.s1 …` selectors no longer match." Any reorder (`--sequence.shuffle`, a test added below it, `.concurrent`) turns the earlier five red.
- Risk: medium (default vitest order is file order and shuffle is not configured in vitest.config.ts, so it is latent, not active)
- Fix: give the cap test its own page (`const p = await browser.newPage(); … await p.close()`), or move the fixture `setContent` into `beforeEach`.
- Evidence: reading; the comment at :171-172 documents the coupling.

### `tests/page-content-capture.test.ts:688` — "recognises a failure raised inside the browser script"
- Mechanism: poisons the shared page's global — `await page.evaluate(\`window.getComputedStyle = function () { throw new Error('boom'); }\`)` — and never restores it. `page.setContent` (document.open/write) does not replace the Window object in current Chromium, so every later `captureDomSnapshot`/`captureVisibleText` on that `page` would also see a throwing `getComputedStyle`. Today it is the last test in the file that touches the real `page` (later blocks use pure strings or a fake page), so nothing fails yet; a test added after it, a reorder, or `.concurrent` makes unrelated captures fail with "boom".
- Risk: medium (latent order dependence)
- Fix: run it on its own page (`const p = await browser.newPage(); …; await p.close()`), or save and restore `getComputedStyle` in a `finally`.
- Evidence: reading; the file shares one module-level `page` across all four browser describes (:24-30).

### Clean (checked)
- sanitize-css-selector, prompts-cache, prompts-read-table, prompts-grid-structure: pure functions, no I/O, no clock.
- iframe: fully mocked Page/Locator, no browser, no timers (`waitForTimeout` is a resolved mock).
- popup: NOT a real-browser file — `mockPage` is a plain object; close events are fired synchronously via `_triggerClose`. `PageTracker`'s constructor/addPage start `resolvePageTargetId`/`resolveOpener` on a mock with no `context()`/`opener()`; both are wrapped (`.catch(() => null)`, try/catch at manager.ts:384-389, 407-414) so no unhandled rejection can surface in a later test. `openedAt: Date.now()` is never asserted. Deterministic.
- page-content-capture (other tests): every browser test starts with its own `setContent`; `page.click`/`fill`/`check`/`selectOption` are auto-waiting Playwright calls; no sleeps. `readPageIdentity` tests (:859-907) incur the production retry's real `setTimeout(500)` (page-capture.ts:193) three times but assert no timing, so they cannot flake (1.5 s of cost; `vi.useFakeTimers` would remove it).
- selector-targeting-transcript (executeStep block): mocked page and AI client, no timers asserted, `STEPTIX_STATS=off` from vitest.config.ts keeps the run loop away from the real user root.
- selector-uniqueness: well guarded — the one test that monkey-patches `Document.prototype.querySelectorAll` does it on a throw-away `browser.newPage()` closed in `finally` (:243-259); everything else starts with `setContent`.
- selector-measurement (rest): `beforeEach` re-navigates to the read-only fixture file and re-installs the click-suppressing listener, so `setContent` tests (:198, :409) and the DOM-editing test (:99) cannot leak; `vi.spyOn(logger,'warn')` is restored in `finally`; the 400 ms late-render test has a 10 s click budget and asserts no timing.
- selector-role-names (rest): three separate `chromium.launch` per file (one per describe) triple the launch/close exposure 518069b measured; frames are routed (no socket on 8787) and `loadFrames` waits on both frames' buttons; the never-holding count wait (:324) expects the timeout, so it is deterministic.
- read-table, read-table-aria, read-table-structure: one Chromium per file, every test starts with `load()`/`setContent`, stamping (`data-steptix-row`) and class toggles only touch the current document, and no test asserts time. The 520-row and 500-row cases (read-table :1492-1514) are the slowest; they carry the suite's 30 s budget and are CPU-bound DOM work, not waits. No order dependence found.
- api-server-table-structure: well isolated — `listen(0, '127.0.0.1')`, `mkdtempSync(os.tmpdir())` for both project roots, state reset in `beforeEach`, scripted AI with no timers. Two small hygiene points that do not by themselves flake: `vi.spyOn(logger, 'info')` (:480, :701) is restored at the end of the happy path rather than in `finally`, and `api('DELETE', …)` is not in `finally`, so one failing test leaves a spy and a session behind for the next (the spy calls through, the session ids are unique).
- read-page-url: one Chromium, `page.route('**/*')` fulfils every request (no socket on 8787 is ever opened — the URL is only a label), `page.goto` waits for `load`, which includes the iframe, so the frame test is not racy; all tests read-only.
- read-pattern: one Chromium, DOM set once in `beforeAll`, every test read-only → order-independent.
- dom-cleaner (Chromium block, :113-387): one browser per file in `beforeAll` (60 s), `page.setContent` resets state at the start of every test, inline `onclick` handlers are synchronous, no sleeps; 30 s per-test budget. No order dependence found.

## Per-file verdicts
| File | Tests | Verdict (High/Medium/Mixed/Low) | One-line note |
|---|---|---|---|
| tests/sanitize-css-selector.test.ts | 13 | High | Pure-function table over each regex branch of `sanitizeCssSelector` (actions.ts:1441), incl. the `=`-means-attribute ambiguity. Four `[...]` cases hit one branch (minor, not flagged). |
| tests/prompts-cache.test.ts | 7 | High | Guards the cacheable-prefix contract of `buildSystemPrompt` and that volatile Test Information lives in the user message. |
| tests/prompts-read-table.test.ts | 14 | Medium | Prompt-rule presence/order guards with spec refs (§6.3, §12.25/28). Three "cacheable rules block" checks duplicate one another (see Low). |
| tests/prompts-grid-structure.test.ts | 22 | High | Answer-kind wire vocabulary, §7.10 rules, and a real prompt-injection fence suite (HOSTILE markup) — the fence block is the most valuable part. |
| tests/dom-cleaner.test.ts | 24 | Mixed | 13 `cleanHtmlString` tests exercise a test-only regex helper with no production caller (L7); of the 11 real-Chromium `expandDomSubtree` tests, 9 are HIGH (live value, stale value, textarea, data-* sweep, row attribute once) and 2 masking ones now duplicate secret-field-parity.test.ts since the rule became one shared script. |
| tests/iframe.test.ts | 11 | Medium | Parser `frame` field (4 tests on one `typeof` line, one dup) + mocked `executeAction` frame routing (real `resolveLocatorRoot` logic runs). Header claims cleanHtmlString iframe tests that don't exist. |
| tests/popup.test.ts | 37 (29 `it` lines; two alias loops expand to 10) | Mixed | `PageTracker` tests (22) are real logic — label assignment, close re-indexing, main fallback, refusal to close main: HIGH. Parser block (15) is mostly alias-table rows that the parser's folding makes duplicates (L3). No browser despite the name — fully mocked Page. |
| tests/read-multiple.test.ts | 9 | High | Real-page `multiple` capture: ordered array, textContent branch, empty result, 500 cap with exact boundaries, single-vs-multiple result shape; parser `=== true` strictness edge. |
| tests/read-page-url.test.ts | 7 | High | Incident regression (`@url` stored "" — the stale-dist failure CLAUDE.md describes); covers attribute-wins, absent-stays-empty, frame ownerDocument, and parity of the inlined `evaluateAll` copy. Routed, no real network. |
| tests/read-pattern.test.ts | 16 | High | issue 020 fail-hard policy: group vs whole match, no-match/invalid/empty-capture failures, truncation, per-element drop vs keep-empty in `multiple`. Pattern logic is Node-side (`sliceWithReadPattern`, private) so a browser is needed only to reach it; one shared page, cheap. |
| tests/page-content-capture.test.ts | 53 | High | Real-Chromium `captureVisibleText` (innerText fallback leak, display:contents, selector-miss vs empty), live form state in the snapshot (checked/selected/value), secret masking incl. the pass/pin fences, and pure `domCaptureFailure` classification with a producer/consumer marker check. One weak duplicate in `readPageIdentity`. |
| tests/selector-uniqueness.test.ts | 13 | High | Real-Chromium proof that `strongSelector`/`buildSelector` verify uniqueness (hidden duplicate, duplicate id anchor, unparseable candidate, iframe paths with no whitespace) plus an O(n²) guard that counts `querySelectorAll` calls on a fresh page. Model file for isolation. |
| tests/selector-role-names.test.ts | 35 (`it.each` expanded) | High | issue 062 regression: role= through executeAction, expand, find, frames and waits; prompt rule 3 wording. 13 tests in the first describe call only `page.locator().count()` (Playwright's own semantics, L5 by form) — kept as MEDIUM because the prompt's rule 3 states exactly these facts and a Playwright upgrade that changed them would make the prompt wrong silently. One elapsed-time assertion is a flake risk. |
| tests/selector-measurement.test.ts | 26 | High | Targeting telemetry + `ambiguousTarget` gate per action type (visible vs total, plural exempt), swallowing a measurement failure, and a MIRROR-BEGIN/END textual parity pin with guard-the-guard. One duplicate; one 10-s wall-clock test with a timing window. |
| tests/selector-targeting-transcript.test.ts | 11 | High | Plumbing of `targeting` through `executeStep` (mock page; the gate logic is real), `actionsOf` merge/drop rules, and the key security property — redaction after the merge — asserted on the bytes on disk. `actionsOfFromCandidate).toBe(actionsOf)` (:256) is a re-export identity check (L5 by form) but guards a documented one-copy invariant (candidate.ts:250-257); kept as MEDIUM. |
| tests/read-table.test.ts | 148 | High (with a thin tail) | The page-side extractor (`src/browser/scripts/read-table.js`, 2.7k lines) runs only in a browser, so a real page is the right level. Nearly every test is a named incident or a spec clause with an exact refusal sentence; the Kendo / DevExpress / RadGrid / frozen-grid / banded-header blocks are distinct shapes and high value. ~8 tests are duplicates of a sibling's branch or check the fixture rather than the code (see Low). |
| tests/read-table-aria.test.ts | 32 | High | MUI (role=none filler, aria-colindex, aria-rowindex ≠ _row), ag-Grid pinned fragments (aria-rowindex / row-index / neither), header grids via aria-colspan, arbitration, role token lists. No duplicates found. |
| tests/read-table-structure.test.ts | 39 | High | §7.10 sketch content, masking, size cap, which refusals carry a sketch (all eight `failShape` sites), mapping replay and its fence (cannot read outside the selected element). One fragile helper (see Defects). |
| tests/api-server-table-structure.test.ts | 21 | High | Real API server + real executor, only edges stubbed; pins question count (1 on shape refusal, 0 on author error / strict / project strict), memo reuse/staleness, mapping on the recorded action, secret masking in the question, and sketch-row→mapping arithmetic. Port 0 and mkdtemp — well isolated. |

## Low-value tests

### `tests/dom-cleaner.test.ts:9-102` — describe "cleanHtmlString" (13 tests)
- Category: L7
- Evidence: `src/browser/dom-cleaner.ts:1205-1213` — "Clean a raw HTML string into a simplified representation. Used in unit tests where a real browser is not available." It delegates to a private regex extractor (`extractInteractiveElements`, :1219) that shares no code with the production snapshot path (`captureDomSnapshot` / `expandDomSubtree`, both browser-side). `grep -r cleanHtmlString src runner-core/src steptix-vscode/src flick-vscode/src` → only the definition at dom-cleaner.ts:1209. So "skips display:none", "skips type=hidden", "normalises whitespace" etc. pin a helper nothing ships, while the real hidden-element/whitespace rules live in the browser-evaluated snapshot code. A regression in the real snapshot leaves all 13 green.
- Recommendation: delete the describe block and `cleanHtmlString`/`extractInteractiveElements` from src (if any behaviour is wanted, re-point it at `captureDomSnapshot` in the existing real-browser block — e.g. hidden input omitted, display:none collapsed to a placeholder).
- Confidence: high

### `tests/dom-cleaner.test.ts:248` — "judges a placeholder by the PASSWORD rule only, on this copy too" (and `:166` "masks a secret field`s value the way the snapshot does, `pwd` included")
- Category: L3
- Evidence: both tests exist to check "the OTHER copy of the rule" (comment at :167-169) / "on this copy too" (:248-250). That premise is gone: `isSecretField` now lives once in `src/browser/scripts/secret-field.js` and is spliced into capture-dom.js, the expand walk (dom-cleaner.ts:983-1044) and the recorder via `loadSecretFieldRule()` (dom-cleaner.ts:358). `tests/secret-field-parity.test.ts:99` ("the whole-page snapshot and the expand walk mask exactly those fields") already runs both readers over `pwd`, `placeholder="Password"`, `pin_code`, `passenger1_name`, "Search by keyword" and `shipping_address` — the same cases :248 types in, asserting the same `value="***"` / live-value outcomes on both texts. :166 adds `credential`, which page-content-capture.test.ts:425/:558 cover for the (shared) rule.
- Recommendation: delete :248; delete :166 or fold `credential` into the CASES table in secret-field-parity.test.ts. Keep :287 (data-* sweep) and :353 (row attribute emitted once) — those are expand-walk–specific.
- Confidence: high for :248, medium for :166

### `tests/page-content-capture.test.ts:900` — "keeps a url it salvaged rather than answering with nothing"
- Category: L3 (strictly weaker copy of :888) — also a name/claim defect
- Evidence: identical setup to :888 (`flakyPage({ failures: 99 })`, same single default URL) and asserts only `expect(identity.url).not.toBe('')`, while :896 already asserts `expect(identity.url).toBe('https://shop.example/cart')`. The name claims the salvage branch — `url: second.url || first.url` (src/server/page-capture.ts:198) falling back to `first.url` — but `flakyPage.url()` never throws, so `second.url` is always non-empty and the fallback never runs.
- Recommendation: delete, or rewrite to exercise the salvage: a page whose `url()` throws on the second attempt only, asserting the first attempt's URL is returned with `stale: true`.
- Confidence: high

### `tests/selector-measurement.test.ts:177` — "counts a hidden duplicate the DOM snapshot cannot show"
- Category: L3
- Evidence: the measured assertion is `expect(result.targeting?.matchCount).toBe(2)` for `a[href="transactions.html"]` — exactly what `tests/selector-measurement.test.ts:70` ("records both counts and a verified handle for a hidden duplicate") already asserts (`matchCount` 2, `visibleMatchCount` 1) on the same selector and fixture, plus more. The extra "premise" (`offsetParent === null`) checks the fixture, not the code; the name's claim about the DOM snapshot is never exercised (no `captureDomSnapshot` call).
- Recommendation: delete, or fold the premise line into :70.
- Confidence: high

### `tests/read-table.test.ts:145` — "never includes the checkbox, Total or Actions columns nobody asked for"
- Category: L3
- Evidence: same fixture and columns as `tests/read-table.test.ts:129`, which already asserts `toEqual([{ _row: '1', id: 'ORD-1001', customer: 'Alice Smith', status: 'Completed' }, …])` and the exact key list `['_row', 'id', 'customer', 'status']`. An exact `toEqual` cannot pass with an extra column, so `expect(Object.keys(record)).toHaveLength(4)` / `not.toContain('$125.00')` add nothing.
- Recommendation: delete.
- Confidence: high

### `tests/read-table.test.ts:456` — "reads a "Loading…" row as [] too — waiting is the author's step"
- Category: L3
- Evidence: the placeholder rule is purely structural — `if (cells.length === 0 || (cells.length === 1 && cells[0].across >= full))` (src/browser/scripts/read-table.js:2530-2533); the text is never consulted. `<td colspan="4">Loading…</td>` in a 4-column table is the same input class as `tests/read-table.test.ts:435` (`<td colspan="5">No documents uploaded yet.</td>` in a 5-column table), with the same assertions (`success` true, `[]`).
- Recommendation: delete, or keep one line in :435's comment noting that the text is irrelevant.
- Confidence: high

### `tests/read-table.test.ts:627` — "and reads the same table as [] when the message spans all seven"
- Category: L3
- Evidence: headerless table, every data row hidden, width taken from the hidden rows, one rendered cell spanning that full width → placeholder. That is exactly `tests/read-table.test.ts:558` ("reads a FILTERED headerless table, every data row hidden, as []": 3-cell hidden rows, `colspan="3"` message) with 7 in place of 3; same assertions (`records` `[]`, `placeholdersSkipped` 1). The meaningful sibling is :604 (narrower message → refusal), which stands without it.
- Recommendation: delete :627 (or :558) — keep one success case beside :604.
- Confidence: high

### `tests/read-table.test.ts:872` (first half, :884-891) — "a stepped-over group row is a data row — record 1, or a short row"
- Category: L3 (partial)
- Evidence: loads the same `SECTIONED` markup as :828 and asserts the same records `[{_row:'1',name:'Section A'},{_row:'2',name:'Alice'},{_row:'3',name:'Bob'}]` for the same `{ header: 'Name' }` column that `tests/read-table.test.ts:850-860` already asserts (via `readTableRecords` rather than `executeAction`). The second half (:893-902, two columns → short-row refusal) is new and worth keeping.
- Recommendation: drop :884-891.
- Confidence: high

### `tests/read-table.test.ts:1994` — "ignores the footer table, which has neither rows nor a header"
- Category: L3
- Evidence: `tests/read-table.test.ts:1957` reads the identical `holdingsGrid({ id: 'holdings-grid', owns: true })` (footer table included) through the wrapper and asserts `toEqual(HOLDINGS_RECORDS)` — exactly six records with their values. That already fails if the footer made the wrapper ambiguous (refusal) or became record 7. :1994's `toHaveLength(6)` and "no `$67,961.00`" are strictly weaker.
- Recommendation: delete, or move its one comment onto :1957.
- Confidence: high

### `tests/read-table.test.ts:1326` — "reads a <div role="grid">, which §7.9 made a table"
- Category: L3
- Evidence: a minimal `role=grid / row / columnheader / gridcell` read by header name. read-table-aria.test.ts covers the same input class several times with more detail — e.g. `tests/read-table-aria.test.ts:517` (one grid under a wrapper, read by header) and `:667` (minimal grid read by header). The test's own comment says it was retargeted from a refusal that no longer exists.
- Recommendation: delete (read-table-aria.test.ts owns ARIA reads).
- Confidence: medium (it also documents the history of the "no table with rows" sentence)

### `tests/read-table.test.ts:3109` — "carries neither header refusal in the extractor any more (§7.3b.6)"
- Category: L3 / L4
- Evidence: reads `read-table.js` source and asserts `not.toContain('and v1 supports exactly one')`, `not.toContain("refusal: 'merged'")` and `toContain('merged headers or cells (rowspan/colspan > 1) are not supported')`. The negatives catch only a verbatim revert, which the behavioural tests already catch (`:2681` adopts a two-row header, `:2748` names columns under a band — both fail if the header refusal returns). The positive is asserted behaviourally, as the full sentence, at `:1236`, `:1256`, `:676`.
- Recommendation: delete.
- Confidence: high

### `tests/read-table.test.ts:3500` — "sees the hidden spacer row and the empty header row as unrendered"
- Category: L5 (tests the fixture and Playwright, not Steptix)
- Evidence: the only assertions are `expect(await page.locator('#RadGrid1_ctl00_Header tbody tr').isVisible()).toBe(false)` and the same for `#RadGrid1_ctl00 thead tr`. No Steptix function is called. The comment's claim — that the extractor treats them as unrendered — is what `:3278` (`placeholdersSkipped` 0, header adopted), `:3329` and `:3400` already prove through `readTableRecords`.
- Recommendation: delete, or fold the two lines into :3329 as fixture premises.
- Confidence: high

### `tests/iframe.test.ts:50` — "parses frame alongside other action fields"
- Category: L3
- Evidence: the parser's whole `frame` logic is one line, `if (typeof obj['frame'] === 'string') action.frame = obj['frame'];` (src/ai/action-parser.ts:926). This test hits the same true branch as `tests/iframe.test.ts:16` ("parses frame selector from action"); the extra `selector`/`value` assertions are generic parser fields covered by the parser's own suites.
- Recommendation: merge into `tests/iframe.test.ts:16` (or delete).
- Confidence: high

### `tests/prompts-read-table.test.ts:118-121, :124-129, :162-168` — three "lives in the cacheable rules block" checks
- Category: L3
- Evidence: each does `blocks.find(b => b.text.includes(<needle>))` then `expect(rules.cache).toBe(true)`. Every rule (ROW IDS, SPLIT GRIDS, 13d) is in the one template literal passed to `textBlock(..., true)` at `src/ai/prompts.ts:184`; the only uncached block is API response history (:353). All three locate the same block and re-assert what `tests/prompts-cache.test.ts:24` already asserts for it ("rules+intro"). The 13a < 13d < 14 ordering inside :162 is the only unique part.
- Recommendation: delete :124-129 and the cache lines in :118-121; keep :162 for its ordering checks.
- Confidence: high

### `tests/popup.test.ts:117-147` — "normalises "<alias>" to "closePage"/"switchPage"" (10 generated tests)
- Category: L3 (and L5-leaning: each row restates a row of a constant map)
- Evidence: the parser looks aliases up FOLDED — `foldActionName = name.trim().toLowerCase().replace(/[_\-\s]/g, '')` (src/ai/action-parser.ts:114) applied to every key of `ACTION_TYPE_ALIASES` (:230-235). So `switchTab`/`switch_tab`, `switchWindow`/`switch_window`, `closeTab`/`close_tab`, `closeWindow`/`close_window` are each ONE lookup key, and `switch_page`/`close_page` fold onto the canonical types themselves (no alias row needed). 10 tests → 4 distinct behaviours. Alias normalisation and folding are already covered generically at `tests/unknown-action-type.test.ts:274` (`['switchTab','switchPage']`) and `:284` (`'SWITCH_PAGE'`, `'Switch Tab'`).
- Recommendation: shrink each loop to the distinct folded keys (`switchTab`, `switchWindow`, `closeTab`, `closeWindow`) or fold them into the table at unknown-action-type.test.ts:275.
- Confidence: high

### `tests/popup.test.ts:59` — "parses page field alongside other fields"
- Category: L3
- Evidence: same true branch of the `page` field copy as `tests/popup.test.ts:42` ("parses switchPage action with page field"); the only extra assertion is `description`, a generic parser field. Same pattern as iframe.test.ts:50.
- Recommendation: delete (or merge into :42).
- Confidence: high

## Test defects

### `tests/iframe.test.ts:1-6` — file header
- Category: Defect (claim does not match content, minor)
- Evidence: header lists "DOM cleaner iframe rendering in cleanHtmlString (regex path)" as a tested area; the file has no `cleanHtmlString` call and no DOM-cleaner test.
- Recommendation: drop that bullet (and see the cleanHtmlString L7 finding).
- Confidence: high

### `tests/read-table.test.ts:1520` — "hands evaluateAll the compiled script, so esbuild never rewrites its helpers"
- Category: Defect (two vacuous assertions; the test still has value)
- Evidence: `expect(typeof compiled).toBe('function')` — `new Function(...)` always returns a function; and `expect(compiled.toString()).toContain(script.trim())` — a `new Function` body always appears in its own `toString()`. Neither can fail. The real checks are the source pin on actions.ts (:1531-1532) and the `new Function(...)` call itself, which throws a SyntaxError if the script is not a single expression.
- Recommendation: replace the two lines with `expect(() => new Function(...)).not.toThrow()` so the intent is explicit.
- Confidence: high

### `tests/read-table.test.ts:2681` — "adopts a TWO-ROW header from the table beside it, and through the wrapper"
- Category: Defect (half the loop is a label-only copy)
- Evidence: `for (const wrapperId of ['beside-two-row', 'wrapper-two-row'])` builds identical markup except the wrapper id, and each iteration runs the same selectors (`#two-row-rows` and `#${wrapperId}`). The name suggests two different paths ("beside it" vs "through the wrapper") — those are the inner loop's two selectors, so the outer loop's second pass re-runs everything under another label (left over from the retargeted test).
- Recommendation: drop the outer loop; keep one wrapper id.
- Confidence: high

### `tests/read-table-structure.test.ts:64-75` — helper `mappingRefusal`
- Category: Defect (fragile helper, not currently a false pass)
- Evidence: `try { const result = await mapped(...); throw new Error(\`expected a refusal, got …\`); } catch (err) { return (err as Error).message; }` — the helper's own "expected a refusal" error is caught by its own `catch` and returned as if it were the refusal text. It is safe today only because every caller pins the message (`.toBe(<exact>)`, or `.toContain('outside "#orders" — every item must be inside …')` at :734). A future caller written as `.toContain('readTable')` or `.toMatch(/refus/)` would pass on a read that succeeded.
- Recommendation: use the pattern the same file uses at :479 — `.then(() => { throw new Error('expected a refusal'); }, (e) => e.message)` — so the sentinel escapes.
- Confidence: high

### `tests/iframe.test.ts:168` — "routes click to page when no frame is set"
- Category: Defect (one vacuous assertion; the test itself is fine)
- Evidence: `expect(frameLocator.locator).not.toHaveBeenCalled()` — that mock is reachable only via `page.frameLocator('#my-frame')`, and `resolveLocatorRoot` (actions.ts:30-31) returns `page` at once when `frameSelector` is falsy, so nothing could call it. The real assertion is `pageLocator.click` toHaveBeenCalled.
- Confidence: high

## Duplication clusters
- Placeholder ("message") row in a table whose width it spans — `tests/read-table.test.ts:435`, `:446`, `:456`, `:3345`; headerless/filtered variants `:541`, `:558`, `:627`. Decided by one structural test (read-table.js:2530-2533). Keep :435 (action level), :446 (`placeholdersSkipped`), :501 (`>=` for colspan 99), :541 (width from a lone message row), :558 (width from hidden rows), :604 (narrower message refused), :3345 (RadGrid pager, context-specific). Drop :456 and :627.
- Footer/ambiguity in the Holdings split grid — `tests/read-table.test.ts:1957` (exact records through wrapper, footer present) ⊇ `:1994`. Keep :1957, drop :1994.
- `SECTIONED` group-row table — `tests/read-table.test.ts:850-860` and `:884-891` assert the same records. Keep :828, keep only the refusal half of :872.
- Minimal ARIA grid read by header — `tests/read-table.test.ts:1326`, `tests/read-table-aria.test.ts:517`, `:641`, `:667`. Keep the read-table-aria ones, drop read-table :1326.
- Secret-field masking on the expand walk vs the snapshot — `tests/dom-cleaner.test.ts:166`, `:248`, `tests/secret-field-parity.test.ts:99` (one shared rule now). Keep secret-field-parity :99 and page-content-capture's snapshot cases (:382-666, which cover the fences in depth); drop dom-cleaner :248 (and :166 after moving `credential` into the parity CASES).
- Hidden-duplicate measurement — `tests/selector-measurement.test.ts:70` ⊇ `:177`. Keep :70.
- Parser optional-field copy (`typeof x === 'string'`), present / absent / wrong-type / "alongside other fields" — `tests/iframe.test.ts:16-68`, `tests/popup.test.ts:42-91`, `tests/read-pattern.test.ts:21-58`, `tests/read-multiple.test.ts:17-59`. Each field's line has two branches; "alongside other fields" (iframe :50, popup :59) repeats the true branch. Absent vs wrong-type are both the false branch but cheap and arguably distinct inputs — not flagged.
- Alias rows that folding makes identical — `tests/popup.test.ts:117-147` vs `tests/unknown-action-type.test.ts:274-298`. Shrink popup's loops to the four distinct folded keys.
- Cacheable-rules-block checks — `tests/prompts-read-table.test.ts:118-121`, `:124-129`, `:162-168`, `tests/prompts-cache.test.ts:24`. Keep prompts-cache :24 and the ordering part of :162.
- Reviewed and KEPT (looks repetitive, is not): the one-cell `<th>` header family `tests/read-table.test.ts:905`, `:934`, `:955`, `:998`, `:1026` — each composes a different pair of guards (hidden template row × wider data rows × unscoped/scoped row headers) whose interaction was a measured bug; the Kendo / DevExpress / RadGrid / frozen-grid fixtures (:1957-2733, :3277-3541) are distinct vendor shapes; the label-chain refusals (:2165, :2441, :2459) each pin a different point where the label is settled.

## Cost concerns
- `tests/selector-measurement.test.ts:255` spends a real 10 s Playwright timeout (budget 40 s) to prove the hoisted wait shares the click's budget. The largest single wall-clock cost in this batch, and it is also a timing-window flake risk (above). A Proxy that records the `timeout` options would prove the same in milliseconds.
- Thirteen `chromium.launch` calls across this batch, one per file except `tests/selector-role-names.test.ts`, which launches three (one per describe, :66, :167, :237). Commit 518069b measured a Chromium close at ~27 s under suite start-up contention; every extra launch/close adds to that exposure. Sharing one browser per file in selector-role-names is a two-line change; a per-worker shared browser helper would cover the rest.
- `tests/page-content-capture.test.ts:859-907` (`readPageIdentity`) sleeps the production 500 ms retry three times (1.5 s); `vi.useFakeTimers()` around those three would remove it. Minor.
- Not flagged as L8: read-pattern's pattern logic is Node-side (`sliceWithReadPattern`, actions.ts:2117) but private and reachable only through `executeRead` on a page, and it composes with browser-side href resolution; the shared page keeps the cost small.

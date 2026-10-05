# E02_steptix_vscode_b

## Summary
- Files: 36 · tests (approx, source-level): ~790 (more at runtime: several parity files generate cases in loops) · High ~620 · Medium ~115 · Low 54 (in 34 findings, plus 2 single-assertion findings) · Defects 2 (+4 name/claim mismatches folded into low findings) · Flakiness risks 4 (all medium; 0 high)
- Overall quality is high. Most files test pure `*-core.ts` / webview `lib/*.js` decisions with exact expected strings or line numbers, the parity files genuinely compare two live copies (or derive expectations from the runtime source), and mark-lines, renumber, row-selection, sections-preflight and the env-data pair are exemplary. The low-value tests fall into three patterns: (1) **dead subjects** — exported helpers kept "for testability" that production stopped calling (`changesTouchAnchor`, `filterToStepLines`, `dataRowLinesOf`, `shiftMarkLine`, and the extension-side `stripHeadline`/`stripDetail` that the compile-strip "parity" test treats as an original); (2) **restatements** — a later test re-asserting a subset of an earlier exact `deepEqual` on the same fixture, or the same case repeated across files (step summary/tally wording, classifyCaptureSource, the masking corpora already in record-secret-parity); (3) a few **trivial subjects** (a ternary, a string template, a constant equal to its literal, `filter` on `[]`).
- Flakiness: no timers, sleeps, ports, env or child processes in the batch. The four risks are a 2 s wall-clock assertion on a real junction walk, reads of `templates/init/tests/*.md` that a serial live run rewrites non-atomically, Windows `rmSync` cleanup without retries, and — systemic — `npm test` here never rebuilds `runner-core/dist`, so 17 of the 36 files can test stale runner-core code locally.

## Flakiness risks

Checked per file (running notes; files with no mechanism listed are pure
string/array functions with no timers, I/O, ports, env or global mutation):
- anchor-shift, compile-progress, compile-strip-copy-parity: pure; float
  assertions (`5 / 8`, `25`) are exact IEEE values, deterministic on every OS.
- data-tables `:119` (memo test): module-level cache + scan counter, but it
  reads the counter relatively (`before = dataTableScanCount()`) and uses a
  text no earlier test scanned, and node:test gives each file its own
  process — order-independent and isolated. Well guarded, not flagged.
- env-data-completion, env-data-definition: pure; CRLF handled explicitly in
  fixtures built with `join('\n')` (not read from disk), so checkout line
  endings cannot leak in. `localeCompare` at env-data-completion `:570`
  compares ASCII sortText only — not locale-sensitive in practice.
- failure-hover, failure-outcomes, failure-text-copy-parity, guard-marks,
  inspector-target: pure. guard-marks `:107` sorts `linesOf()` before
  comparing (`.sort((a, b) => a - b)`), so Map iteration order is not
  assumed — guarded.
- invocation-target-core: real filesystem, but done right — every tree is
  `fs.mkdtempSync(path.join(os.tmpdir(), 'tb-skills-'))` and removed in
  `finally`; symlink/junction creation failures `t.skip()` instead of
  failing (Windows without Developer Mode); `:216` already accepts either
  readdir winner (commit 9dbb35d "order-agnostic junction test" fixed exactly
  that); `collectSkillNames` sorts its output, so `:135/:256` do not depend on
  readdir order; `:528` (cache re-read) changes the file SIZE, so the
  mtime+size cache key changes even on a coarse-mtime filesystem. `:186` reads
  a fixed `os.tmpdir()/tb-skills-does-not-exist` path but only expects it to be
  absent — negligible. One real risk below.

### `steptix-vscode/tests/invocation-target-core.test.js:207` — "collectSkillNames survives self-referential directory links (visited-set, not depth)"
- Mechanism: wall-clock assertion on real filesystem I/O: `const started = Date.now(); … assert.ok(Date.now() - started < 2_000, 'a looping walk must terminate fast');`. The walk is `realpathSync.native` + `readdirSync` + `statSync` over a just-created temp tree that includes two junctions; on Windows, Defender scanning freshly created files/links, or a heavily loaded CI runner, is the condition that stretches it.
- Risk: medium (the tree is ~4 directories, so the normal cost is milliseconds; it needs a pathological stall to cross 2 s). The assertion also adds little: if the visited-set regressed, the walk would take minutes and `node --test` has no default per-test timeout, so CI would hang rather than see this assert fail; the `deepEqual(names, ['real/deep/nested', 'real/login'])` beside it already proves the loops were cut.
- Fix: drop the `Date.now()` assertion and give the test `{ timeout: 10_000 }` (node:test option) so a regression fails instead of hanging; keep the deepEqual.
- Evidence: reasoning; no timing-fix commits on this file (`git log --follow` shows review rounds and a rename only).

- mark-lines, panel-scope, renumber, row-selection: pure. mark-lines builds
  its CRLF variants in code (`DOC.replace(/\n/g, '\r\n')`), so the checkout's
  line endings do not matter. repair-step reads `steptix-vscode/package.json`
  — a tracked file nothing writes during a test run; fine.
- placeholder-grammar-parity: reads `src/parser/parameters.ts` (tracked
  source, safe) and every `templates/init/tests/table-*.md` (shared files
  that a live run rewrites — risk below). `readdirSync` order is not relied
  on; CRLF is handled (`split(/\r?\n/)`, and `.` in `/^tags:.*\btable-read\b/m`
  stops before `\r` without breaking the match).

### `steptix-vscode/tests/placeholder-grammar-parity.test.js:336` and `:347` — "the acceptance corpus is present and actually dotted" / "no dotted reference in a step of them is left without a definition"
- Mechanism: reads live fixture files under the repo: `readFileSync(resolve(TESTS_DIR, f), 'utf8')` over `templates/init/tests/table-*.md`. `templates/.env` sets `APPEND_RUN_HISTORY_TO_TEST_FILE=true`, and `src/report/history-appender.ts:51` rewrites the test file with a plain, non-atomic `fs.writeFile` after each run. The `--shards=1` live mode drives the real `templates/` workspace (CLAUDE.md), so a unit run in the same checkout during a serial live run can read a table file between truncate and write: the `tags:` filter then drops it and `assert.equal(files.length, 12)` fails (or `:347` checks a partial file).
- Risk: medium (needs a serial live run in the same checkout, hitting a `table-read` file at that instant; the window is small but real — parallel shards use copies and are not affected).
- Fix: make `history-appender.ts` write atomically (write a temp file beside it, then `rename`), which also protects every other reader; and/or read the corpus as committed (`git show HEAD:templates/init/tests/<f>`) so local run-history edits cannot change it.
- Evidence: reasoning from history-appender.ts:51 and templates/.env; `steptix-vscode/tests/integration/live/table-read.test.cjs` is the live suite that drives those files; no flake commit seen on this file.

- row-summary, rows-panel, run-state, section-diagnostics (reads tracked
  `fixtures/sections/*`, nothing writes them), sections-copy-parity,
  selection-lines, set-step-mirrors (reads tracked
  `fixtures/set-step/grammar-lines.json` and imports root `src/parser/set-step.ts`
  source), skill-run-targets, skipped-pass-consumers (reads `steptix-vscode/src`,
  sorts before comparing, not vacuous), step-lines-inline, step-region,
  step-skip, steps-summary, use-step-editor, variables-panel, viewport-recycle:
  pure or read-only over tracked files. `rowOutcomeLine`/`formatRowDuration`
  format durations from fixed numbers, not clocks.
- viewport-recycle (coordinator asked for a close look): a pure value
  comparison — no timers, no I/O, no module state. Nothing to flake.
- compile-progress (coordinator asked for a close look): pure string/number
  functions; `progressIncrement` is fed explicit fractions, no clock. Nothing
  to flake.
- sections-copy-parity: `registerHooks` (node:module) installs a
  process-global resolve hook and never deregisters it. Safe under the
  default `node --test` process-per-file isolation; it would leak into other
  files only under `--test-isolation=none`, and even then it only rewrites a
  relative `.js` specifier from a `.ts` parent that has a `.ts` twin. Not
  flagged.
- steptix-config-parse `:120` (mtime cache identity) and invocation-target-core
  `:528`: module-level caches keyed by unique `mkdtemp` paths, so no
  cross-test bleed. Guarded.
- No test in the batch uses timers, sleeps, ports, `process.env`,
  `process.cwd()`, `Math.random`, locale/date formatting, child processes or
  watchers (grepped). `git log --follow` on all 36 files shows no commit
  mentioning flake/timeout/race/CI/timing.

### `steptix-vscode/tests/invocation-target-core.test.js:150,165,182,212,238,258,510,524,544` and `sections-preflight.test.js:347,361,375` — temp-tree cleanup
- Mechanism: `fs.rmSync(root, { recursive: true, force: true })` with Node's default `maxRetries: 0`, run immediately after the files and junctions in the tree were created and read. On Windows (the only OS in the CI matrix today, `.github/workflows/unit-tests.yml:34`), Defender or the search indexer briefly holding a just-written file makes `rmSync` throw `EBUSY`/`EPERM`/`ENOTEMPTY`; `force` only suppresses `ENOENT`. Because the call is in `finally` (or, in sections-preflight, after the assertions), a cleanup hiccup fails a test whose assertions all passed.
- Risk: medium (needs an AV/indexer lock in a ~ms window; a known Windows-runner failure shape, more likely on a loaded box).
- Fix: `fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })`, or wrap cleanup in `try { … } catch {}` so cleanup can never fail a test; in sections-preflight move the `rmSync` into `finally`/`t.after`.
- Evidence: reasoning from Node's `rmSync` defaults; no failure recorded in this repo's history.

### Systemic: steptix-vscode `npm test` runs against an unrebuilt `runner-core/dist`
- Mechanism: most cores under test import the package specifier `'steptix-runner-core'` (e.g. `step-lines.ts:16`, `data-tables-core.ts:14`, `section-diagnostics-core.ts:13-23`, `env-data-completion-core.ts`, `renumber-core.ts`, `row-selection-core.ts`, `sections.ts`, `step-region-core.ts`, `invocation-target-core.ts`, `skill-run-targets.ts`; `env-data-completion.test.js:12` imports it directly). That resolves through the `file:` junction to `runner-core/package.json` → `"main": "./dist/index.js"`. `steptix-vscode`'s `pretest` is `npm run build --prefix ..` — it builds the ROOT, not runner-core. So after editing `runner-core/src`, these suites keep testing the previous runner-core build: green on a regression, or red on a fix, depending on when `runner-core` was last built locally. Two files in the suite already document and work around exactly this (`sections-copy-parity.test.js:33-76`, `record-secret-parity.test.js:63-71`: "Measured: … left it 12/12 green").
- Risk: medium (local only — in CI `npm ci --prefix runner-core` runs its `prepare` build first; but it is the "stale dist tests old code without any warning" case CLAUDE.md warns about, and it reaches 17 of the 36 files in this batch: anchor-shift, data-tables, env-data-completion, env-data-definition, failure-outcomes, invocation-target-core, placeholder-grammar-parity, renumber, row-selection, row-summary, section-diagnostics, sections-copy-parity (host half), sections-preflight, set-step-mirrors, skill-run-targets, step-region, use-step-editor).
- Fix: make steptix-vscode's `pretest` also run `npm run build:runner-core` (a `tsc`, already defined at steptix-vscode/package.json:680), e.g. `"pretest": "npm run build --prefix .. && npm run build:runner-core"`.
- Evidence: steptix-vscode/package.json:690-691, runner-core/package.json:7, the two in-suite workaround comments cited above.

## Per-file verdicts
| File | Tests | Verdict (High/Medium/Mixed/Low) | One-line note |
|---|---|---|---|
| anchor-shift.test.js | 22 | Mixed (mostly High) | Shift/snap math well covered incl. the multi-change regression; `changesTouchAnchor` has no production caller; section-body block restates array-form cases and one name contradicts its assertion |
| compile-progress.test.js | 12 | High (one caveat) | Status bar / toast / quick-pick wording is quoted in stories/compile-tail-progress.md; increment-as-delta rule is a real bug class. `stripHeadline`/`stripDetail` cases test an extension-side copy with no production caller (see L7) |
| compile-strip-copy-parity.test.js | 8 (1 loop) | Medium | Live side is the webview mirror; for headline/detail the "original" it is compared to is dead code, so the parity only works as an indirect pin of the webview wording; fraction parity is real (both sides live) |
| data-tables.test.js | 7 | Mixed (mostly High) | Row vs alignment-line split is a real regression pin; two tests restate the first test's exact deepEqual |
| env-data-completion.test.js | 62 | High (4 restatements) | Thorough cursor-context, masking (incl. mask-before-truncate leak), capture-scope and loop-scope coverage; every export has a production caller. Four CAPTURES tests re-assert subsets of `:410`'s exact list |
| env-data-definition.test.js | 64 | High | Hit-testing, JSON locator edge cases (dup keys, escapes, CRLF), .env parity with the server, paramDefinition ordering — all exports live, little overlap |
| failure-hover.test.js | 7 | High | Each hover shape + clip + fence-escape; the only unit pin of these strings |
| failure-outcomes.test.js | 37 | High (one duplicate) | Paint precedence, deliberate/tolerated composition, compile-result lines incl. refusal; `:92` restates `:68`; summary/tally cases overlap steps-summary/step-skip (see clusters) |
| failure-text-copy-parity.test.js | 13 + 3 loops | High | Real mirror: webview `failure-text-inline.js` used by steptix-runner.jsx:27; host side via runner-core + step-skip-core helpers. Cases cover every branch incl. degenerate ones |
| guard-marks.test.js | 16 | High (one duplicate) | Frame-pop mark memory, latest-visit-wins, move/clear, passMarkFor ordering; `:50` restates `:31` |
| inspector-target.test.js | 16 | High (one trivial) | Security (non-loopback refused) and wrong-process bug pins; `:151` empty-in/empty-out is trivial |
| invocation-target-core.test.js | 29 | High (one trivial) | Parity rows vs root parsers, grammar edge rows, real-fs walk incl. junction loops; `TOOL_FILE_EXTS` test is a constant-equals-literal with a wrong claim; one wall-clock assert (see Flakiness) |
| mark-lines.test.js | 45 | High | Exemplary: each case is a recorded VS Code edit shape, asserted on the TEXT each mark lands on (cannot pass on the right number of the wrong line). One assertion (`:274`) uses `shiftMarkLine`, which has no production caller |
| panel-scope.test.js | 10 | Mixed (mostly Medium) | Per-file isolation of webview log/strip (all functions live in steptix-runner.jsx). `:25` is a strict subset of `:33`; `:87` exercises an object-spread overwrite |
| placeholder-grammar-parity.test.js | 15 | High (one duplicate golden) | Strong source-pin: reads the runtime constant out of src/parser/parameters.ts and checks the editor mirror equals it, plus a corpus run against both and a non-vacuity guard over the acceptance files. `:114` re-pins root's golden; `:338` hard-codes a file count |
| renumber.test.js | 34 | High | Every spec row covered as before/after docs; edit shape asserted where it carries the contract; CRLF, fences, inert, safe-integer edge |
| repair-step.test.js | 6 | High (one duplicate) | Manifest `when`-clause pins — the only guard on wiring esbuild never checks; `:63` is subsumed by `:53` |
| row-summary.test.js | 28 | High (one trivial) | Header summary, hovers (values-before-fence fix), note round-trip, worst-of merge; `rowWord` test is a bare ternary |
| rows-panel.test.js | 37 | High (two low) | Selection algebra, payload axes (absent vs empty), per-file state, button labels; `rowKey` template test and the pass-through test restate others |
| run-state.test.js | 6 | High (one restatement) | Legacy-status migration incl. prototype-key trap; `:53` combines `:14` + `:21` with no new branch |
| section-diagnostics.test.js | 23 | High | Every diagnostic row, suppression interplay, near-miss ambiguity, shared frozen fixture for liveness parity with the expander |
| sections-copy-parity.test.js | ~54 (loops) | High (three restatements) | Frozen-table + differential (LF and CRLF) of the webview mirror vs runner-core SOURCE (mutation-tested per its comment), host vs webview `extractStepLineIds`. `:168`, `:254`, `:287` restate other rows |
| sections-preflight.test.js | 27 | High | Payload contract (null vs `{}`, `__proto__`, parallel arrays, narrowing axes, refuse-not-clip) and preflight parity with the CLI |
| row-selection.test.js | 65 | High (one dead subject) | Selection→rows/steps split, chain growth, call detection (tail/nested/loop), refusals, every log line; `dataRowLinesOf` (`:561`) has no production caller and its name claims a role another function plays |
| selection-lines.test.js | 14 | High (two restatements) | Whole-line guard and its runnable-line exception are real bug pins; `:71` and `:120` repeat `:33`/`:22` |
| set-step-mirrors.test.js | 9 | High (one duplicate) | Derives expectations from the runtime's own `parseSetStep` over a shared fixture — the right shape for a mirror test, with a non-vacuity guard. `:122` repeats variables-panel's classifyCaptureSource tests |
| skill-run-targets.test.js | 16 | High (one defect) | Picker exclusions/order/dedupe are the safety substance; `:46` is a win32-only check whose other-platform half asserts only `samePath(x, x)` |
| skipped-pass-consumers.test.js | 6 | High | Source-pin over every `step:pass` consumer, a "no new consumer" scan, and exact skip-path/guard counts; scans real files (not vacuous) and sorts before comparing |
| step-lines-inline.test.js | 12 | Mixed | `countStepLineStatuses` tests are real (row lines excluded, body lines kept, shape pinned); four `filterToStepLines` tests cover a function with no production caller |
| step-region.test.js | 13 | High | Fence handling is the point and every fence edge is covered; function is live (section-providers.ts) |
| step-skip.test.js | 24 | High (three low) | Paint precedence, the reason-strip rules (anchored, colon-optional, no dangling dash), skipped-⚠ wording, heal lines. `:66` constant-equals-literal, `:88` and `:299` restate exact-string tests |
| steps-summary.test.js | 12 | High | Main-flow-only denominator, stale-skip placement; a few wording cases are repeated in failure-outcomes (see clusters) |
| steptix-config-parse.test.js | 11 | Medium | Real resolution and null-safety rules; light on the mtime-cache invalidation half; creates and never removes a temp dir per test (cost) |
| use-step-editor.test.js | 15 | High (two restatements) | Every `[use …]` refusal reaches the editor, completion rows are legal steps, F11 classification; `:99` repeats `:44`'s first row, `:122` repeats section-diagnostics `:50` |
| variables-panel.test.js | 52 | Mixed (mostly High) | collectVariables rows, BOM/non-string/record masking edges are unique and valuable; four masking tests replay record-secret-parity corpora on the same function, and classifyCaptureSource is a table written out longhand |
| viewport-recycle.test.js | 9 | High (one restatement) | Pure decision + spec'd log line; normalisation and set↔unset cases are the substance. Coordinator asked for a close look: no timers, I/O or state — no flake mechanism |

## Low-value tests

### `steptix-vscode/tests/anchor-shift.test.js:190` and `:198` — "changesTouchAnchor: a whole-line replace ending at column 0 of the anchor line is NOT a touch" / "changesTouchAnchor: a replace spanning into the anchor line IS a touch"
- Category: L7
- Evidence: `changesTouchAnchor` is exported from `steptix-vscode/src/extension/step-lines.ts:47` and its only other occurrences repo-wide are these two tests (`Grep "shiftAnchorForChanges|changesTouchAnchor"` excluding node_modules: step-lines.ts:47 definition, anchor-shift.test.js:3/192/200/205, nothing in active-file-tracker.ts or anywhere else). The tracker calls `shiftAnchorForChanges` with a lazy function instead (`active-file-tracker.ts:623-627`), which made the predicate redundant. The column-0 classification it asserts is already covered through the live function by `:104` ("selecting whole lines ABOVE ... shifts the anchor up") and `:118`.
- Recommendation: delete both tests together with the dead export (or, if kept as API, fold into one parity loop asserting `changesTouchAnchor(c, a) === (shiftAnchorForChanges called its function)` over the existing cases).
- Confidence: high

### `steptix-vscode/tests/anchor-shift.test.js:28` — "insert THREE lines above the anchor shifts by three"
- Category: L3
- Evidence: same "entirely above" branch (`deltaAbove += addedLines - (endLine - startLine)`, step-lines.ts:109) and same input class as `:18` ("insert above the anchor shifts the derived line down"); multi-line deltas are additionally covered by `:165` ("two separate above-edits in one event sum their deltas", addedLines 2 + 1).
- Recommendation: delete (or merge into `:18` as a second assertion).
- Confidence: high

### `steptix-vscode/tests/anchor-shift.test.js:249`, `:262`, `:276`, `:287` — section-body block ("a deleted body step snaps to the next step of the SAME section", "deleting the LAST body step of a section clears rather than crossing into the next", "the call position shifts on an insert above while the body anchor does not", "deleting the invocation clears the call position, which clears the resume point")
- Category: L1 / L3 (one finding)
- Evidence: the section scoping these names claim ("can reach 25 but can never reach 33", "Cleanup's line 33 is NOT a candidate") is implemented by the test's own callback — `(target) => [24, 28].filter((l) => l >= target)` and `() => [24, 25]` — not by the unit; in production it lives in `active-file-tracker.ts:622-625` (`sectionBodyLinesAt`), which these tests never reach. With the callback supplied, the unit does exactly what `:55` (snap to next survivor) and `:67` (no survivor → null) already assert with the array form. `:287` (`() => []` → null) is a third copy of the null case. `:276` runs the plain insert-above shift of `:18` twice. The genuinely new function-form contracts are covered by `:218` (not consulted without a touch) and `:232` (receives the 1-based post-edit target).
- Recommendation: keep `:218` and `:232`; delete `:249/:262/:276/:287`, or rewrite them to exercise `sectionBodyLinesAt` / `maintainAnchor` so the section-scoping claim is actually tested.
- Confidence: high

### `steptix-vscode/tests/compile-progress.test.js:43`, `:50`, `:64`, `:69` (and the headline/detail halves of `:55`) + `steptix-vscode/tests/compile-strip-copy-parity.test.js:43` — strip headline/detail wording
- Category: L7 (dead extension-side copy; the tests themselves still pin live wording only indirectly)
- Evidence: `stripHeadline` and `stripDetail` in `steptix-vscode/src/extension/compile-progress-core.ts:33,41` have no production caller — `grep -rn "stripHeadline\b\|stripDetail\b"` over `steptix-vscode/src` finds only the definitions; `compile-tail-signals.ts:2-10` imports `notificationDetail, progressIncrement, quickPickLabel, statusBarText, statusBarTooltip, stripFraction` but not these two. The only live headline/detail is the webview's `stripHeadlineInline`/`stripDetailInline` (`steptix-runner.jsx:210-211`). So the "mirror" has no original in production: compile-progress pins wording on a function nobody renders, and the parity test transfers that pin to the live inline copy. The parity file's own rationale ("the panel saying '5 of 8 entries generated' while the status bar says something else") does not hold — the status bar uses `statusBarText`, which the parity test does not compare.
- Recommendation: point the four compile-progress strip tests at `compile-strip-inline.js` directly and delete `stripHeadline`/`stripDetail` from the core (keep `stripFraction`, which `compile-tail-signals.ts:148` uses, and its parity case). Value of the wording pins themselves is fine — the wording is quoted in stories/compile-tail-progress.md:138.
- Confidence: high

### `steptix-vscode/tests/data-tables.test.js:85` and `:100` — "the header and the delimiter are not rows — they never take a status" / "the reserved lines and the row lines never overlap"
- Category: L3
- Evidence: `:85` asserts `assert.deepEqual(rowLines, [6, 7, 15])` and then that 4/5/13/14 are absent — both already implied by `:75`'s exact `[['run', null, 4, [6, 7]], ['section', 'Upload each statement', 13, [15]]]`. `:100` asserts the alignment set and row set are disjoint on the same `BOTH` fixture, which is implied by `:75` plus `:93` (`assert.deepEqual(alignmentLinesOf(dataTablesOf(BOTH)), [4, 5, 13, 14])`). Neither adds an input or a branch.
- Recommendation: delete both (or fold the disjointness check into `:93` as one extra line).
- Confidence: high

### `steptix-vscode/tests/env-data-completion.test.js:425`, `:433`, `:441`, `:463` — "an out-alias {{}} cannot express is not offered", "[input:] / [output:] only count anchored…", "prose storage names nothing…", "markers outside the executed flow are not captures"
- Category: L3 (one finding)
- Evidence: all four run `captureNamesBefore(CAPTURES, 20|21)` on the same fixture and assert `includes`/`!includes` of names whose presence/absence `:410` already pins with an exact `assert.deepEqual(... [['sid','as',9], ['username','input',14], ['balance','output',15], ['code','as',16], ['order_id','as',17], ['session','out-alias',20]])`. Any regression they would catch makes `:410` fail first. (`:448`'s cursor-13/14 assertions are new and should stay.)
- Recommendation: merge into `:410` (keep the per-rule comments on the expected list); delete the four.
- Confidence: high

### `steptix-vscode/tests/failure-outcomes.test.js:92` — "with no warning the hover is byte-identical to what it always was"
- Category: L3
- Evidence: `assert.equal(toleratedHoverMessage({ error: 'x' }), \`${TOLERATED_HOVER_OPENING}\n\n${fenced('x')}\`)` is the same exact-string assertion, same branch (no warning, no flags), as `:68`: `assert.equal(hover, \`${TOLERATED_HOVER_OPENING}\n\n${fenced(WARNING)}\`)` with `{ error: WARNING }`. (`:68` is also a mildly misleading fixture: it passes the `WARNING` constant as the *error*, not as `warning`.)
- Recommendation: delete `:92`; in `:68` use a neutral error string so it does not read like a warning case.
- Confidence: high

### `steptix-vscode/tests/guard-marks.test.js:50` — "a guard the model decided pops to a plain ✓"
- Category: L3
- Evidence: on a fresh `GuardMarks`, `marks.notePass(DOC, 2, 'pass')` hits the `if (!lines) return;` no-op (guard-mark-core.ts:139-140), so `forFramePop` returns `{ status: 'pass' }` exactly as in `:31` ("a pop on a line nothing marked"). The meaningful version — a plain pass *forgetting* an earlier code mark — is asserted in `:56` (visit 4) and `:70`.
- Recommendation: delete.
- Confidence: high

### `steptix-vscode/tests/inspector-target.test.js:151` — "stepsFileBreakpoints: empty in, empty out"
- Category: L5
- Evidence: `stepsFileBreakpoints` is `paths.filter((p) => /\.steps\.ts$/i.test(p))` (inspector-target.ts:130); `assert.deepEqual(stepsFileBreakpoints([]), [])` tests `Array.prototype.filter` on an empty array.
- Recommendation: delete.
- Confidence: high

### `steptix-vscode/tests/invocation-target-core.test.js:86` — "TOOL_FILE_EXTS matches the registry probe order"
- Category: L5 (constant equal to its literal) + misleading name
- Evidence: `assert.deepEqual([...TOOL_FILE_EXTS], ['.ts', '.mts', '.js', '.mjs']);` compares the export to a literal copy of itself; it cannot detect drift from the registry it names because it never reads it. The claim is also off: the root registry's `TOOL_FILE_EXTS` is `new Set([...])` used for `.has(ext)` membership (src/tools/registry.ts:428,537), so it has no probe order to match.
- Recommendation: rewrite as a source-pin that reads `src/tools/registry.ts` and compares its extension set to the mirror (order-insensitive), or delete.
- Confidence: high

### `steptix-vscode/tests/mark-lines.test.js:274` (one assertion inside "two touching selections deleted together join a step onto an UNMARKED line…")
- Category: L7 (single assertion)
- Evidence: `assert.equal(shiftMarkLine(9, changes, () => 0), null);` — `shiftMarkLine` (mark-lines-core.ts:301) is exported but has no caller outside the module or this test (`grep -rn "shiftMarkLine" steptix-vscode/src` → only its definition and a doc comment; the tracker and extension.ts import `markLineMoves`/`moveLineKeyed`). The next two assertions in the same test check the same case through the live `markLineMoves` path.
- Recommendation: drop that one assertion (and the dead export). The test itself stays.
- Confidence: high

### `steptix-vscode/tests/panel-scope.test.js:25` — "a file's lines are visible only in that file's view"
- Category: L3
- Evidence: two files, one line each, read back separately. `:33` ("two concurrent compiles never interleave in one view") does the same with five interleaved lines across the same two URIs and asserts both logs exactly — a strict superset.
- Recommendation: delete `:25`.
- Confidence: high

### `steptix-vscode/tests/panel-scope.test.js:87` — "switching away and back finds the strip at its current count"
- Category: L5 (+ name does not match)
- Evidence: `setStrip` twice on the same URI, then `assert.equal(stripFor(strips, A).done, 6)` — this is `{ ...strips, [uri]: state }` overwriting a key (panel-scope-inline.js:79). Nothing "switches away and back"; no other URI is touched.
- Recommendation: delete, or rewrite to actually interleave a B update between the two A updates (which `:93` nearly does already).
- Confidence: medium

### `steptix-vscode/tests/placeholder-grammar-parity.test.js:114` — "the runtime constant is still the string both suites pin"
- Category: L3
- Evidence: `assert.equal(NAME_SOURCE, '\\w+(?:\\.[A-Za-z_][A-Za-z0-9_]*)?'); assert.equal(PLACEHOLDER_SOURCE, '\\{\\{(…)\\}\\}');` duplicates the root golden at `tests/placeholder-dotted.test.ts:76-77`, which already pins what the constant is. The drift this file exists for is caught by `:122` (mirror === constant read from source). The comment says the triple entry is deliberate friction; it is a second change-detector on the same literal, not a second check.
- Recommendation: delete (or keep only if the owner wants the deliberate friction).
- Confidence: medium

### `steptix-vscode/tests/placeholder-grammar-parity.test.js:338` (assertion in "the acceptance corpus is present and actually dotted")
- Category: L4 (one assertion)
- Evidence: `assert.equal(files.length, 12, 'expected the twelve table-read acceptance tests');` — the test's purpose is non-vacuity (its per-file loop and `:384`'s `checked >= 20` already ensure that). An exact count fails the unit suite the day someone adds a 13th `table-read` acceptance file, which is not a grammar regression.
- Recommendation: change to `assert.ok(files.length >= 12, …)`; keep the rest.
- Confidence: high

### `steptix-vscode/tests/repair-step.test.js:63` — "a step with no entry, or a passing one, is not offered Repair"
- Category: L3
- Evidence: asserts `row.when !== compile[0].when` and `row.when.includes(STALE_LINES_KEY)`. The regression its comment names — widening the clause to `activeFile` alone — already fails `:53` (`assert.match(when, /editorLineNumber\s+in\s+steptix\.staleStepLines/)`). The not-equal check is weaker than that: any clause differing by one character passes.
- Recommendation: delete.
- Confidence: high

### `steptix-vscode/tests/row-selection.test.js:561` — "dataRowLinesOf: every table’s rows, ascending — the gutter menu key"
- Category: L7 (+ name claims a role the function does not have)
- Evidence: `dataRowLinesOf` (row-selection-core.ts:438) has no caller in `steptix-vscode/src` (grep of every `.ts/.js/.jsx` finds only its definition). The `steptix.dataRowLines` gutter key is built from a different function, `dataRowSignatureLines` (active-file-tracker.ts:1119, defined at :1209 as a projection of `dataTablesOf`). So the test pins a dead duplicate of the live computation; the live one's row lines are covered by data-tables.test.js:75.
- Recommendation: delete the test and `dataRowLinesOf`; if the gutter key needs its own pin, test `dataRowSignatureLines` (it is exported).
- Confidence: high

### `steptix-vscode/tests/row-summary.test.js:314` — "the word for a row depends on the table"
- Category: L5
- Evidence: `rowWord` is `return kind === 'section' ? 'iteration' : 'row';` (row-summary-core.ts:30-32) with no caller outside the module; both outcomes are already asserted through the real sentences — `:54` ("iteration 2 of 3 running") and `:131` ("Iteration 2 failed at step 1 of the section").
- Recommendation: delete.
- Confidence: high

### `steptix-vscode/tests/rows-panel.test.js:434` — "rowKey is what keeps the two lists' selections apart"
- Category: L5 / L3
- Evidence: `assert.equal(rowKey("run", 3), "run#3")` pins a string template; the keys it produces are already asserted by every selection test (`:181` `["run#1"]`, `:222` `["section:S#3"]`, `:237` `["run#2", "section:S#2"]`), and `:233` is the test that actually proves two tables never collide.
- Recommendation: delete.
- Confidence: high

### `steptix-vscode/tests/rows-panel.test.js:441` — "the row's values text and detail pass through untouched — the host masks and words them"
- Category: L3 (mostly)
- Evidence: the pass-through assertions (`group.rows[0].values === input`) check that `rowGroups` does not transform rows; the rest restates other tests — `formatRowDuration(7400) → "7.4s"` / `undefined → ""` (`:168`), `buildTableRowsPayload(group, [3]) → { rows: [3] }` (`:308`).
- Recommendation: keep one pass-through assertion (fold it into `:82`), drop the rest.
- Confidence: medium

### `steptix-vscode/tests/run-state.test.js:53` — "a mixed legacy file keeps its lines and maps only the retired status"
- Category: L3
- Evidence: `restoredStatuses` is one loop with two independent per-entry branches (`running` → skip, retired → map; run-state-core.ts:35-41). `:14` covers the mapping, `:21` the drop and the order, `:25` the pass-through. Mixing them in one array adds no branch or interaction.
- Recommendation: delete.
- Confidence: high

### `steptix-vscode/tests/sections-copy-parity.test.js:168` — "extractSections: keeps the [no-hooks] marker on a body step verbatim"
- Category: L3
- Evidence: the `marker strip:` loop at `:109` already runs the row `"[no-hooks] Login"` from `fixtures/sections/match-table.json` through `extractSections` and asserts `steps[0].instruction === row.stepRawText.trim()` — the same input class and assertion. (Note: none of the three usable marker rows is marker-only, so the loop's `stripped === ""` branch never runs; `:160` is the only cull test and must stay.)
- Recommendation: delete `:168`.
- Confidence: high

### `steptix-vscode/tests/sections-copy-parity.test.js:254` — "the differential harness can actually detect a disagreement"
- Category: L3 (+ name over-claims)
- Evidence: it asserts only `extractSections(text).length === 1` and the redundant `notDeepEqual(..., [])` on the mirror. It never shows the harness detecting a disagreement. The vacuity it guards against (both sides returning `[]`) is already ruled out by the frozen-table tests at `:130`, which pin the mirror to non-empty expected sections.
- Recommendation: delete, or rewrite to feed the differential a deliberately wrong comparator and assert it fails.
- Confidence: high

### `steptix-vscode/tests/sections-copy-parity.test.js:287` — "extractStepLineIds: the two copies agree with each other"
- Category: L3
- Evidence: loops over `Object.keys(frozen.files)` = `classification.md`, `classification-edge.md`, `classification-hashes.md` — exactly the keys of `STEP_LINE_IDS`, for which `:278` (webview) and `:282` (host) each assert `deepEqual(..., expected)`. Both equal to the same array implies equal to each other.
- Recommendation: delete (or keep only if new fixtures will be added to `frozen.files` without `STEP_LINE_IDS` rows).
- Confidence: high

### `steptix-vscode/tests/failure-outcomes.test.js:225` — "a run with no tolerated step renders the byte-identical string it always did"
- Category: L3
- Evidence: `stepsSummaryText(summaryOf('pass', 'pass'))` → `'2/2 passed'` and `stepsSummaryText(summaryOf('pass', 'skip'))` → `'1/2 passed, 1 skipped'`. The second is byte-for-byte `steps-summary.test.js:89` (same helper, same input, same expected); the first is the all-pass class `steps-summary.test.js:122` already pins (`'3/3 passed'`). Same function, same level.
- Recommendation: delete; steps-summary.test.js owns the no-tolerated wording.
- Confidence: high

### `steptix-vscode/tests/selection-lines.test.js:71` and `:120` — "the whole-line rule applies to a two-row drag over a table" / "with no runnable set, the plain rule holds — every existing caller"
- Category: L3
- Evidence: `:71` `selectionLinesFrom([sel(5, 0, 7, 0)])` → `[6, 7]` is the same branch and input class (multi-line range ending at column 0, no runnable set) as `:33` `sel(2, 0, 5, 0)` → `[3, 4, 5]`; "table" is only a label — the function knows nothing about tables. `:120` `sel(4, 0, 5, 0)` → `[5]` is `:22`'s case (`sel(2, 0, 3, 0)` → `[3]`) with different numbers; it reads as the control for `:88`, but `runnable === null` is exactly what `:22` already exercises.
- Recommendation: delete `:71`; fold `:120` into `:88` as its contrasting first assertion.
- Confidence: high (`:71`), medium (`:120`)

### `steptix-vscode/tests/set-step-mirrors.test.js:122` — "classifyCaptureSource: knows assignment, and still collapses the unknown"
- Category: L3
- Evidence: every assertion is already in `variables-panel.test.js`: `'assignment'` (`:143`), `'toolOutput'` (`:134`), `'capture'` (`:138`), `undefined` → `'capture'` (`:165`), unknown → `'capture'` (`:170-171`). Same function (`variables-panel.js:98`), same inputs.
- Recommendation: delete here (the Set-step file's subject is the name scanners, not the badge).
- Confidence: high

### `steptix-vscode/tests/step-lines-inline.test.js:33`, `:46`, `:55`, `:59` — the four `filterToStepLines` tests
- Category: L7
- Evidence: `filterToStepLines` (step-lines-inline.js:137) has no caller: `grep -rn "filterToStepLines" steptix-vscode/src` returns only its definition; steptix-runner.jsx imports `countStepLineStatuses, extractStepLineIds` from this module (line 15) and nothing else.
- Recommendation: delete the four tests and the dead export.
- Confidence: high

### `steptix-vscode/tests/step-skip.test.js:66` — "the glyph is the hollow circle the Rows panel and the gutter use"
- Category: L5 (constant equal to its literal) / L3
- Evidence: `assert.equal(SKIP_GLYPH, '◌');`. Every exact-string wording test in the same file (`:70`, `:77`, `:109`…) starts with `◌`, and `failure-text-copy-parity.test.js:157` pins the codepoint and the mirror's equality.
- Recommendation: delete.
- Confidence: high

### `steptix-vscode/tests/step-skip.test.js:88` — "both single-line surfaces carry the same glyph and the same separator"
- Category: L3
- Evidence: checks prefix `◌ ` and suffix `skipped — ${REASON}` on `skipRunLogLine(9, REASON)` and `skipTestOutputLine(9, '', REASON)`; `:70` and `:77` already assert those two functions' full strings for the same `REASON` (only the line number differs).
- Recommendation: delete.
- Confidence: high

### `steptix-vscode/tests/step-skip.test.js:299` — "a skip with no broken condition is byte-identical to before"
- Category: L3 (+ one L5 assertion)
- Evidence: `skipRunLogLine(7, NOT_TAKEN, undefined) === skipRunLogLine(7, NOT_TAKEN)` is JavaScript's own optional-parameter semantics; `skipRunLogLine(7, NOT_TAKEN)` → `'◌ step 7 skipped — another branch…'` is `:129` verbatim; the compile and Test Explorer lines with a stripped `Skipped:` reason are `:133` and `:141`.
- Recommendation: delete.
- Confidence: high

### `steptix-vscode/tests/use-step-editor.test.js:99` — "the `[use …]` message wins over the generic directive list"
- Category: L3
- Evidence: `errors(doc(…, '1. [use]'))` → one row containing `'names no surface'` is exactly the first row of `:44`'s table (`['[use]', 'names no surface']`, with `assert.equal(rows.length, 1, instruction)`). The rule-order point is real, but `:44` already fails if the generic list wins.
- Recommendation: delete (move its comment onto `:44`'s `[use]` row).
- Confidence: high

### `steptix-vscode/tests/use-step-editor.test.js:122` — "a non-test document gets nothing"
- Category: L3
- Evidence: `computeSectionDiagnostics('# Notes\n\n1. [use phone]\n')` → `[]` exercises the first line of the function, `if (!isTestFile(text)) return [];` (section-diagnostics-core.ts:45), which `section-diagnostics.test.js:50` ("a non-test file produces no diagnostics") already covers. The gate runs before any rule, so the `[use phone]` content adds nothing.
- Recommendation: delete.
- Confidence: medium

### `steptix-vscode/tests/variables-panel.test.js:394`, `:399`, `:407`, `:559` — maskIfSecretInline scope cases and maskIfSecretAuthoredInline corpus
- Category: L3 (same function, same inputs, same level)
- Evidence: `record-secret-parity.test.js` runs `maskIfSecretInline(name, 'uk_live_1234', opts)` over `SCOPE_CORPUS` (:377-415, asserted at :417-437): `'user.apikey' {bindings: []}` masked (`:394` here), `'payment.keyword' {bindings: []}` masked (`:396`), `'payment.keyword'` bound → shown and `'payment.password'` bound → masked and `'user.apikey'` beside a binding → masked (`:399-404`), `'user.apikey'` with no opts / `{}` → shown (`:407-411`). `:559` loops `maskIfSecretAuthoredInline` over `user.apikey, user.apitoken, row.mypassword, login.passkey, api.key` with `'uk_live_1234'` — exactly the first five rows of `AUTHORED_CORPUS` (record-secret-parity.test.js:612-617, asserted against the same function at :641-645); its second loop is the `SCOPE_CORPUS` "older server" rows. The comment at variables-panel.test.js:391 even points there. Unique and worth keeping in this file: `:415` (unmask before the `(empty)` guard), `:424` (non-string values), the record-masking and BOM tests.
- Recommendation: delete the four.
- Confidence: high

### `steptix-vscode/tests/variables-panel.test.js:175` and `:188` — capture/toolOutput captureSource annotation
- Category: L3
- Evidence: `:224` ("distinguishes parameter, page capture, and tool output in one file") asserts `pageTitle.captureSource === 'capture'` and `resultUrl.captureSource === 'toolOutput'` (via a skill `out.` alias) on the same code path, and adds the parameter case. What `:175`/`:188` add beyond that — the value filling in, and an alias row's `source: 'output'` — is already in `:46` and `:101`.
- Recommendation: keep `:224`, delete `:175` and `:188`.
- Confidence: medium

### `steptix-vscode/tests/viewport-recycle.test.js:112` — "an unresolved $VAR is compared like any other string"
- Category: L3
- Evidence: `comparisonKey` is `spec.trim().toLowerCase()` (viewport-recycle.ts:37); `'$VIEWPORT'` is not special to it, so `onLiveSession('$VIEWPORT', '$VIEWPORT')` → no recycle is `:57`'s "unchanged" case and `('$VIEWPORT', 'mobile')` → recycle is `:27`'s "changed" case.
- Recommendation: delete (or keep as documentation of the deliberate no-resolution decision — it costs nothing, but it cannot catch a bug `:27`/`:57` would miss).
- Confidence: medium

## Test defects

### `steptix-vscode/tests/anchor-shift.test.js:276` — "the call position shifts on an insert above while the body anchor does not"
- Category: Defect (name contradicts assertion)
- Evidence: the name says the body anchor does not shift, but the test asserts it does: `assert.equal(body, 24, 'body step moved down one line too');` (23 → 24). Also listed in the L1/L3 block above.
- Recommendation: rename to what it checks, or delete with the block above.
- Confidence: high

### `steptix-vscode/tests/skill-run-targets.test.js:46` — "samePath folds drive-letter case on win32 only"
- Category: Defect (half the claim is unasserted; on Linux/macOS the test is vacuous)
- Evidence: the body is `assert.equal(samePath(LOGIN, LOGIN), true); if (process.platform === "win32") { …case-folded compare… }`. On Linux and macOS only the identity check runs, so the "only" half of the name — `samePath` does NOT fold case off Windows (skill-run-targets.ts:31, `na === nb`) — is never asserted, and the test cannot fail there. CLAUDE.md asks for a platform-marked test plus the other platforms' own case where behaviour differs.
- Recommendation: split into `test('…win32', { skip: process.platform !== 'win32' }, …)` and a POSIX case asserting the current non-folding behaviour (`samePath('/proj/A.md', '/proj/a.md') === false`) — and note for the owner that on macOS's case-insensitive default filesystem that behaviour is itself questionable (product parity), so decide it rather than pin it blindly.
- Confidence: high

Name/claim mismatches folded into the low-value findings above (not counted again): `invocation-target-core.test.js:86` ("registry probe order" — the registry has none), `panel-scope.test.js:87` (no switching happens), `row-selection.test.js:561` ("the gutter menu key" — a different function builds it), `sections-copy-parity.test.js:254` (never demonstrates detecting a disagreement), and the misleading fixture at `failure-outcomes.test.js:68` (`WARNING` passed as the error).

## Duplication clusters
- **`## Steps` summary, plain/skip wording** (`stepsSummaryText`): `steps-summary.test.js:89`, `:122`, `:132`; `failure-outcomes.test.js:225-228` → keep steps-summary's; drop failure-outcomes `:225`.
- **Run-log tally with nothing skipped** (`runLogTallyLine`): `step-skip.test.js:238-241` (`'✓ 12 passed'`), `failure-outcomes.test.js:237` (`'✓ 7 passed'`) → keep step-skip's; drop that one assertion from failure-outcomes `:230`.
- **classifyCaptureSource**: `variables-panel.test.js:133`, `:137`, `:141`, `:164`, `:168` (a table written longhand) and `set-step-mirrors.test.js:122` → merge variables-panel's five into one table test; drop set-step-mirrors `:122`.
- **SKIP_GLYPH**: `step-skip.test.js:66`, `failure-text-copy-parity.test.js:157` → keep the parity one.
- **maskIfSecretInline scope / authored corpora**: `variables-panel.test.js:394`, `:399`, `:407`, `:559` vs `record-secret-parity.test.js:377-437`, `:612-647` → keep the corpora.
- **Non-test document → no diagnostics**: `section-diagnostics.test.js:50`, `use-step-editor.test.js:122` → keep section-diagnostics'.
- **`[use]` refusal wording**: `use-step-editor.test.js:44` (first row), `:99` → keep `:44`.
- **Anchor "no survivor → null"**: `anchor-shift.test.js:67`, `:262`, `:287` → keep `:67` (+ `:232` for the function form).
- **Whole-line selection guard, no runnable set**: `selection-lines.test.js:22`, `:33`, `:71`, `:120` → keep `:22`, `:33`.
- **Data-row lines of a document**: `row-selection.test.js:561` (dead `dataRowLinesOf`) vs `data-tables.test.js:75` (live `dataTablesOf`, which the gutter key projects) → keep data-tables'.
- **Exact-capture-list restatements**: `env-data-completion.test.js:410` vs `:425`, `:433`, `:441`, `:463` → keep `:410`.
- **Tolerated hover, plain**: `failure-outcomes.test.js:68`, `:92` → keep `:68`.
- Acceptable overlap, not flagged: hover clipping in `failure-hover.test.js:64` and `failure-outcomes.test.js:96` (two public functions sharing `fenced()`); flat-name masking via the masker (`variables-panel.test.js:318`) vs via the predicate (`record-secret-parity.test.js:179`) — different levels.

## Cost concerns
- `steptix-config-parse.test.js`: every test calls `tmpDir()` (`fs.mkdtempSync`) and none removes it, so each run leaks ~11 directories into `os.tmpdir()`. Seven of them (`:17-95`) only need a path string for `parseProjectDirs`, which never touches disk — `path.resolve(path.sep, 'proj', 'steptix.config.json')` would do. Only `:97`, `:111`, `:120` need real files; give those a `t.after(() => fs.rmSync(…))`.
- `sections-preflight.test.js:332-375`: temp dirs are removed after the assertions rather than in `finally`, so a failing assertion leaks the directory (no correctness impact).
- No real browsers, servers, ports, child processes or sleeps anywhere in this batch; the real-filesystem tests (invocation-target-core, sections-preflight, steptix-config-parse) are warranted by what they test.

# 017 — testbench-monaco integration tests silently no-op (exit 0, suite never runs)

**Status:** closed won't-fix — subject deleted 2026-08-19
**Area:** [testbench-monaco/tests/integration/runTest.cjs](../../testbench-monaco/tests/integration/runTest.cjs) — VS Code launcher args; [testbench-monaco/tests/integration/suite/activation.test.cjs](../../testbench-monaco/tests/integration/suite/activation.test.cjs) — references nonexistent fixtures
**Related:** [testbench-native/tests/integration/runTest.cjs](../../testbench-native/tests/integration/runTest.cjs) — working reference; [testbench-native/tests/integration/fixtures/](../../testbench-native/tests/integration/fixtures/) — fixtures that monaco needs equivalents of
**Opened:** 2026-05-28

## Summary

`npm run test:integration` in [testbench-monaco/](../../testbench-monaco/) returns **exit 0 in ~20s with no test output**. We trusted the exit code and assumed the tests were passing silently due to the known Windows + `ELECTRON_RUN_AS_NODE` + Mocha stdout-eating quirk.

That assumption is wrong. Diagnostic checkpoint markers added at every line of `suite/index.cjs`'s `run()` function showed **the test entry's `run()` is never called at all**. VS Code launches, exits cleanly, but never bootstraps the test runner module. The tests have likely not actually run since some refactor — nobody noticed because the success signal looked identical to a real pass.

This affects ongoing confidence: anything an "integration test" would have caught in the monaco variant has been uncovered for an unknown period. The native variant is unaffected — its 105-test suite runs and reports correctly.

## Diagnosis trail

1. `npm run test:integration` returned exit 0 with no `--- Test report ---` output.
2. Glob discovery verified independently: `node -e "const {glob}=require('glob'); glob('**/*.test.cjs',{cwd:'suite'}).then(console.log)"` returns `['activation.test.cjs']`. So the file *is* discoverable from the suite's vantage.
3. Tried capturing stdout via bash redirection (`node runTest.cjs > out.log 2>&1`) to rule out PowerShell ErrorRecord wrapping. Same result — only the launch lines, no test output.
4. Ported the JSON-report mechanism from native into monaco's `runTest.cjs` + `suite/index.cjs` (writes `test-report.json` from inside Mocha's `mocha.run()` callback). Report file was not created.
5. Added `fs.appendFileSync` checkpoint markers at the top of `run()`, after `glob()`, after `addFile`, and just before `mocha.run()`. **None fired.** The checkpoint log was never created. Conclusion: `run()` itself is never executed.

## Two contributing gaps vs. the native variant

Both look like artifacts of an incomplete refactor — testbench-native has both, monaco has neither.

### Gap 1 — No workspace folder positional arg

[testbench-monaco/runTest.cjs:15](../../testbench-monaco/tests/integration/runTest.cjs#L15) computes:

```js
const workspacePath = path.resolve(__dirname, 'fixtures');
```

…but the `args` array at line 28 **never references it**:

```js
const args = [
  cliJs,
  '--wait',
  '--extensionDevelopmentPath=' + extensionDevelopmentPath,   // jumps straight here
  '--extensionTestsPath=' + extensionTestsPath,
  '--user-data-dir=' + userDataDir,
  '--extensions-dir=' + extensionsDir,
  '--disable-workspace-trust',
];
```

Compare to [testbench-native/runTest.cjs:31-40](../../testbench-native/tests/integration/runTest.cjs#L31-L40):

```js
const args = [
  cliJs,
  '--wait',
  workspacePath,                                              // <-- positional folder
  '--extensionDevelopmentPath=' + extensionDevelopmentPath,
  ...
];
```

Without a folder, `--wait` + extensionDevelopmentPath may leave Code in a no-folder welcome state where the `extensionTestsPath` bootstrap doesn't fire. (Why exit 0 rather than a hang or error is unclear — VS Code seems to consider "user closed the welcome window" as a clean exit.)

### Gap 2 — The fixtures directory doesn't exist

[testbench-monaco/tests/integration/fixtures/](../../testbench-monaco/tests/integration/fixtures/) is **missing entirely**. Even though [activation.test.cjs:9-11](../../testbench-monaco/tests/integration/suite/activation.test.cjs#L9-L11) references files inside it:

```js
const FIXTURES_DIR = process.env.TESTBENCH_FIXTURES_DIR || path.resolve(__dirname, '..', 'fixtures');
const fixtureUri = (name) => vscode.Uri.file(path.resolve(FIXTURES_DIR, name));
```

…and at least four assertions open `test-with-steps.md` or `plain.md` from it. Native has both files at [testbench-native/tests/integration/fixtures/](../../testbench-native/tests/integration/fixtures/).

So even if Gap 1 were closed, VS Code would fail to open a nonexistent workspace folder.

## Fix sketch

Small change, two parts:

1. **`testbench-monaco/tests/integration/runTest.cjs`** — add `workspacePath` as a positional arg between `--wait` and `--extensionDevelopmentPath=`, mirroring native exactly.
2. **Create `testbench-monaco/tests/integration/fixtures/`** with `test-with-steps.md` and `plain.md`. Copying the native variants' fixtures verbatim should work — the activation tests' assertions only care that `test-with-steps.md` has a `## Steps` heading and `plain.md` doesn't. Worth a quick sanity check that nothing in monaco's editor-claim logic ([editor-provider.ts](../../testbench-monaco/src/extension/editor-provider.ts), [editor-binding.ts](../../testbench-monaco/src/extension/editor-binding.ts)) needs different fixture shape than native.

After both: `npm run test:integration` should write `test-report.json` (the JSON-report mechanism already landed) and the printed `--- Test report ---` section will list the 5 activation tests' pass/fail status. If any of those 5 tests have actually rotted during the silent period (highly possible — they reference `pkent.testbench` and the custom-editor `viewType = 'testbench.editor'`), expect to need follow-up fixes to the tests themselves.

## What was kept from the diagnostic round

The **JSON-report mechanism** was ported into monaco (`runTest.cjs` + `suite/index.cjs`) and **kept** — same shape as native, writes `test-report.json` via `TESTBENCH_TEST_REPORT` env var, runner prints a `--- Test report ---` section after the spawn. This is a strict upgrade independent of this issue: it makes future silent no-ops impossible to miss, because "no report written" now prints `No test report written (Mocha may not have run)` rather than looking like a clean exit-0 pass.

The diagnostic checkpoint markers were reverted.

## Revisit when

- Before relying on testbench-monaco integration tests for any regression confidence. As of this diagnosis they provide **zero** signal.
- The fix is small (one positional arg + two small markdown fixtures), so this is low-effort/high-value.

## Closed — 2026-08-19 (won't fix)

Moot. `testbench-monaco/` was deleted from the repo, so the launcher, the
suite and the five activation tests this issue describes no longer exist.
The diagnosis stands as a record of *why* the variant was carrying zero
integration signal — it is one of the arguments in
[048](048-remove-testbench-monaco.md) for retiring it rather than repairing
it. Every link above into `testbench-monaco/` is now dead by design.

Nothing was ported out. The JSON-report mechanism noted below as "kept" was
copied *into* monaco from testbench-native, which still has the original and
is unaffected.

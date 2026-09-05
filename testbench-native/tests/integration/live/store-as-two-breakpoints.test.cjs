/**
 * Live end-to-end test: captured values survive MORE THAN ONE breakpoint.
 *
 * Its sibling, store-as-survives-breakpoint.test.cjs, proves one hop —
 * capture in batch 1, read it in batch 2. That much is also satisfied by a
 * design that hands the next batch whatever the previous one finished with.
 * The real mechanism is a loop: every step writes its captures into
 * `session.outputs` (session-manager, the post-step sweep) and every batch
 * seeds its parameters from `{ ...session.outputs }` before anything runs.
 *
 * Two breakpoints is the smallest case that can tell those apart. Three
 * batches, and batch 3 consumes a value captured in batch 1 (two boundaries
 * back) alongside one captured in batch 2 (a batch that is neither first nor
 * last). A one-hop handoff passes the sibling test and fails this one.
 *
 * Prereq: the API server on $LIVE_SERVER_URL, and the fixture app on 8787 —
 * runLiveTest.cjs boots the latter.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');

const EXT_ID = 'pkent.testbench-native';

// 1-based lines of the steps in store-as-survives-two-breakpoints.md.
const STEP = {
  navigateFirst: 34,
  captureFirst: 35,
  navigateSecond: 36,
  captureSecond: 37,
  useSecond: 38,
  useFirst: 39,
  verifyHeading: 40,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {
      /* transient */
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

const passed = (status) => status === 'pass' || status === 'pass-cached';

function statuses(hooks) {
  return Object.fromEntries(hooks.tracker.snapshot().statuses);
}

describe('TestBench live — captures survive TWO breakpoint pauses', function () {
  this.timeout(420_000);

  /** @type {import('../../../dist/extension/extension').TestBenchTestHooks} */
  let hooks;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks missing — activation may have failed');

    const serverUrl = process.env.LIVE_SERVER_URL || 'http://localhost:3100';
    try {
      const res = await fetch(`${serverUrl}/sessions/healthcheck/steps`, { method: 'OPTIONS' });
      assert.ok(
        res.status === 204 || res.status === 200,
        `Server at ${serverUrl} not responding (status=${res.status})`,
      );
    } catch (err) {
      throw new Error(
        `Live test requires the API server running at ${serverUrl}. ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  after(async () => {
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }
  });

  it('carries a batch-1 capture across two boundaries, and a batch-2 capture across one', async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — live runner must pass templates/');

    const testFile = path.resolve(
      workspaceRoot,
      'init',
      'tests',
      'store-as-survives-two-breakpoints.md',
    );
    assert.ok(fs.existsSync(testFile), `fixture not found at ${testFile}`);

    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }

    const uri = vscode.Uri.file(testFile);
    // Shown, not just opened: `vscode.open` can return before the editor has
    // focus, so the activeTextEditor wait below raced its budget and failed a
    // full-suite run under load. showTextDocument resolves once it is shown.
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
      preview: false,
    });
    await waitFor(
      'the two-breakpoint fixture becomes the active editor',
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
    );
    await waitFor('tracker recognises the test file', () => hooks.tracker.snapshot().isTestFile);

    // Two breakpoints, on the steps that OPEN batches 2 and 3.
    vscode.debug.addBreakpoints(
      [STEP.navigateSecond, STEP.useSecond].map(
        (line) =>
          new vscode.SourceBreakpoint(
            new vscode.Location(uri, new vscode.Position(line - 1, 0)),
            true,
          ),
      ),
    );

    // Empty selection → runSelected runs the whole file.
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));

    // ===== Batch 1: steps 1-2, capturing first_url =====
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('the run starts', () => hooks.isRunning(), 30_000);
    await waitFor(
      `paused at the first breakpoint (line ${STEP.navigateSecond})`,
      () => hooks.tracker.snapshot().breakpointStop === STEP.navigateSecond,
      240_000,
    );
    await waitFor('idle while paused the first time', () => !hooks.isRunning(), 15_000);

    const afterBatch1 = statuses(hooks);
    assert.ok(
      passed(afterBatch1[STEP.captureFirst]),
      `step 2 must have captured first_url before the first pause, got '${afterBatch1[STEP.captureFirst]}'`,
    );

    // ===== Batch 2: steps 3-4, capturing second_url =====
    void vscode.commands.executeCommand('testbench-native.continueRun');
    await waitFor('running again after the first resume', () => hooks.isRunning(), 15_000);
    await waitFor(
      `paused at the second breakpoint (line ${STEP.useSecond})`,
      () => hooks.tracker.snapshot().breakpointStop === STEP.useSecond,
      240_000,
    );
    await waitFor('idle while paused the second time', () => !hooks.isRunning(), 15_000);

    const afterBatch2 = statuses(hooks);
    assert.ok(
      passed(afterBatch2[STEP.captureSecond]),
      `step 4 must have captured second_url in batch 2, got '${afterBatch2[STEP.captureSecond]}'`,
    );
    // The pass marks from batch 1 must still be standing two batches in —
    // the wiped-pass-marks regression this suite's sibling also guards.
    assert.ok(
      passed(afterBatch2[STEP.captureFirst]),
      `step 2 must still read as passed after the second pause, got '${afterBatch2[STEP.captureFirst]}'`,
    );

    // ===== Batch 3: steps 5-7, consuming both captures =====
    void vscode.commands.executeCommand('testbench-native.continueRun');
    await waitFor('running again after the second resume', () => hooks.isRunning(), 15_000);
    await waitFor('idle once the final batch completes', () => !hooks.isRunning(), 240_000);

    const final = statuses(hooks);
    console.log('[live] final statuses:', final);

    // A capture made in a MIDDLE batch reaches the batch after it.
    assert.ok(
      passed(final[STEP.useSecond]),
      `step 5 must pass — proves {{second_url}}, captured in batch 2, reached batch 3. ` +
        `Got '${final[STEP.useSecond]}'. A literal {{second_url}} fails as an invalid URL.`,
    );

    // A capture made in the FIRST batch survives BOTH boundaries. This is the
    // assertion one breakpoint cannot make.
    assert.ok(
      passed(final[STEP.useFirst]),
      `step 6 must pass — proves {{first_url}}, captured in batch 1, survived TWO ` +
        `batch boundaries. Got '${final[STEP.useFirst]}'.`,
    );

    // And it held the right value. Step 6 navigating somewhere valid is not
    // enough: if first_url had been overwritten by second_url, the navigation
    // would still succeed and land on the wrong page. The heading says which.
    assert.ok(
      passed(final[STEP.verifyHeading]),
      `step 7 must pass — proves {{first_url}} still addressed the FIRST page, not the ` +
        `second. Got '${final[STEP.verifyHeading]}'.`,
    );
  });
});

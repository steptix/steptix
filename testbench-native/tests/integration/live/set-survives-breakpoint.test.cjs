/**
 * Live end-to-end proof of the SERVER half of
 * stories/variable-assignment.md: a `Set {{name}} to "…"` step's value has
 * to reach `session.outputs`, or the next HTTP batch cannot seed
 * `resolvedParameters` from it and the assignment silently does not carry.
 *
 * The sibling `store-as-survives-breakpoint.test.cjs` covers the same seam
 * for `[store as: X]`; this is the assignment's own path, which writes at a
 * different point in the loop (its own branch, above the tool dispatch)
 * and labels its provenance differently (`source: 'assignment'`).
 *
 * The vitest layer cannot reach this: its server tests mock `executeStep`
 * and run a single batch, so neither the real loop nor the batch boundary
 * is exercised. Here the whole stack is real — parser, session manager,
 * SSE wire, extension.
 *
 * It also proves the cost claim. Every step in the fixture is an
 * assignment, so a passing run must spend ZERO tokens; anything that
 * quietly sent one of these to the model would show up as a non-zero
 * total.
 *
 * Prereq: `aiui serve` on $LIVE_SERVER_URL.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');

const EXT_ID = 'pkent.testbench-native';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await predicate()) return; } catch { /* transient */ }
    await sleep(200);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

describe('TestBench live — Set assignments survive a breakpoint pause', function () {
  this.timeout(240_000);

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

  it('carries an assignment across a batch boundary, for no tokens', async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — live runner must pass templates/');

    const testFile = path.resolve(workspaceRoot, 'init', 'tests', 'set-survives.md');
    assert.ok(fs.existsSync(testFile), `set-survives.md not found at ${testFile}`);

    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }

    const uri = vscode.Uri.file(testFile);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
      preview: false,
    });
    await waitFor(
      'set-survives.md becomes active editor',
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
    );
    await waitFor('tracker recognises test file', () => hooks.tracker.snapshot().isTestFile === true);

    // Steps 1 and 2 are lines 25 and 26; step 3 is line 27. Breaking on
    // step 3 splits the run so that `{{decorated}}` — assigned in batch 1 —
    // has to survive into batch 2 through `session.outputs`.
    const STEP_2_LINE = 26;
    const STEP_3_LINE = 27;
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(STEP_3_LINE - 1, 0)),
        true,
      ),
    ]);

    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));

    console.log('[live] Starting run; expect pause at line', STEP_3_LINE);
    void vscode.commands.executeCommand('testbench-native.runSelected');

    await waitFor('isRunning true', () => hooks.isRunning(), 30_000);
    await waitFor(
      `paused at breakpoint on line ${STEP_3_LINE}`,
      () => hooks.tracker.snapshot().breakpointStop === STEP_3_LINE,
      180_000,
    );
    await waitFor('isRunning false while paused', () => !hooks.isRunning(), 15_000);
    console.log('[live] Paused after the first two assignments ✓');

    const pausedStatuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    assert.equal(
      pausedStatuses[STEP_2_LINE],
      'pass',
      `Step 2 (line ${STEP_2_LINE}) should have passed before the pause, got ` +
        `'${pausedStatuses[STEP_2_LINE]}'. A Set step never replays from cache, so ` +
        `'pass-cached' here would mean it took a path it should not have.`,
    );

    console.log('[live] Resuming through breakpoint');
    void vscode.commands.executeCommand('testbench-native.continueRun');

    // NOT `isRunning() === true` first, the way the `[store as:]` sibling
    // does it. That test's second batch is a real AI navigation and stays
    // running for seconds; this one is a single assignment that finishes in
    // about a millisecond — far inside the 200ms poll — so the transient
    // `true` is unobservable and waiting for it times out on a run that
    // actually succeeded. Wait on the TERMINAL condition instead, which
    // cannot be missed.
    await waitFor(
      `step 3 (line ${STEP_3_LINE}) reaches a final status`,
      () => {
        const status = Object.fromEntries(hooks.tracker.snapshot().statuses)[STEP_3_LINE];
        return status === 'pass' || status === 'fail';
      },
      180_000,
    );
    await waitFor('idle after second batch completes', () => !hooks.isRunning(), 30_000);

    const finalStatuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    console.log('[live] Final statuses:', finalStatuses);
    assert.equal(
      finalStatuses[STEP_3_LINE],
      'pass',
      `Step 3 (line ${STEP_3_LINE}) must pass — it can only do so if {{decorated}}, ` +
        `assigned in batch 1, reached session.outputs and was seeded back into ` +
        `batch 2. Got '${finalStatuses[STEP_3_LINE]}'. A failure here means the ` +
        `Set → session.outputs sync regressed; the step's own error names the ` +
        `reference it could not resolve.`,
    );
    assert.equal(
      finalStatuses[STEP_2_LINE],
      'pass',
      'Step 2 must still read as passed after the resume',
    );

    // Clean up, same as the `[store as:]` sibling: this suite shares one
    // server and one VS Code window, so a session left holding a browser and
    // a breakpoint left on line 27 are both other tests' problems.
    await vscode.commands.executeCommand('testbench-native.restartSession');
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }
  });
});

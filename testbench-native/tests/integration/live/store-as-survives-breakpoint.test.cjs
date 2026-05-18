/**
 * Live end-to-end regression test for the user-reported "Cannot navigate
 * to invalid URL" bug. A skill captures a value via `[store as: X]`,
 * the test then references `{{X}}` after a breakpoint pause splits the
 * run into two HTTP batches.
 *
 * Pre-fix (f6b24c1): `[store as: X]` wrote directly to
 * `resolvedParameters` via the step executor, but the session manager
 * never synced those values to `session.outputs`. The second batch
 * (after Continue) seeded `resolvedParameters` from `session.outputs` —
 * which never received the capture — so `{{X}}` stayed literal and
 * Playwright threw "Cannot navigate to invalid URL".
 *
 * The fast integration tests use a FakeApiClient and can't exercise
 * the real expander → step-executor → session-manager loop end-to-end.
 * The vitest layer mocks executeStep so the cache-write hook is also
 * mocked away. This live test wires the whole stack: real expansion,
 * real `[store as: X]` capture, real session.outputs persistence,
 * real {{X}} interpolation in batch 2.
 *
 * Prereq: `npm run dev` (or `aiui serve`) on $LIVE_SERVER_URL.
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

describe('TestBench live — [store as: X] survives a breakpoint pause', function () {
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
      const res = await fetch(`${serverUrl}/sessions/healthcheck/steps`, {
        method: 'OPTIONS',
      });
      assert.ok(
        res.status === 204 || res.status === 200,
        `Server at ${serverUrl} not responding (status=${res.status})`,
      );
    } catch (err) {
      throw new Error(
        `Live test requires the API server running at ${serverUrl}. ` +
          `Start it with \`npm run dev\` or \`aiui serve\`. ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  it('captures a URL in batch 1, resumes through breakpoint, navigates to {{captured}} in batch 2', async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — live runner must pass templates/');

    const testFile = path.resolve(workspaceRoot, 'init', 'tests', 'store-as-survives.md');
    assert.ok(fs.existsSync(testFile), `store-as-survives.md not found at ${testFile}`);

    // Clean state: no leftover breakpoints, no leftover session.
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }

    const uri = vscode.Uri.file(testFile);
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor(
      'store-as-survives.md becomes active editor',
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
    );
    await waitFor(
      'tracker recognises test file',
      () => hooks.tracker.snapshot().isTestFile === true,
    );

    // Put a breakpoint on step 2 of the test file. In store-as-survives.md
    // step 1 is the [skill: capture_url] invocation (1-based line 18),
    // step 2 is "Navigate to {{target_url}}" (1-based line 19). Pausing
    // before step 2 forces the server to split the run into two HTTP
    // batches — exactly the scenario where the pre-fix bug surfaced.
    const STEP_1_LINE = 18; // [skill: capture_url]
    const STEP_2_LINE = 19; // Navigate to {{target_url}}
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(STEP_2_LINE - 1, 0)),
        true,
      ),
    ]);

    // Empty cursor → runSelected runs the whole file.
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(0, 0),
      new vscode.Position(0, 0),
    );

    console.log('[live] Starting run; expect pause at line', STEP_2_LINE);
    void vscode.commands.executeCommand('testbench-native.runSelected');

    // Wait for the run to actually start.
    await waitFor('isRunning true', () => hooks.isRunning(), 30_000);

    // The first batch executes the skill (step 1 — [skill: capture_url])
    // which internally captures target_url. The breakpoint trims the
    // batch BEFORE step 2, so we land in a paused state with step 1 in
    // some pass state.
    await waitFor(
      `paused at breakpoint on line ${STEP_2_LINE}`,
      () => hooks.tracker.snapshot().breakpointStop === STEP_2_LINE,
      180_000,
    );
    await waitFor('isRunning false while paused', () => !hooks.isRunning(), 15_000);
    console.log('[live] Paused at breakpoint after step 1 ✓');

    // Sanity: step 1 should be pass (or pass-cached on a warm-cache run).
    // Either is fine — what matters is that the skill ran to completion
    // and target_url got captured.
    const pausedStatuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    const step1Status = pausedStatuses[STEP_1_LINE];
    assert.ok(
      step1Status === 'pass' || step1Status === 'pass-cached',
      `Step 1 (line ${STEP_1_LINE}) should be passed before resume, got '${step1Status}'`,
    );

    // Continue past the breakpoint — second batch should execute
    // "Navigate to {{target_url}}" with target_url interpolated from
    // session.outputs (the value captured in batch 1).
    console.log('[live] Resuming through breakpoint');
    void vscode.commands.executeCommand('testbench-native.continueRun');

    await waitFor('isRunning back true after resume', () => hooks.isRunning(), 15_000);
    await waitFor(
      'idle after second batch completes',
      () => !hooks.isRunning(),
      180_000,
    );

    // The whole point: step 2 must be 'pass' (or pass-cached). The bug
    // path makes it 'fail' because {{target_url}} stays literal and
    // Playwright throws "Cannot navigate to invalid URL".
    const finalStatuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    console.log('[live] Final statuses:', finalStatuses);
    const step2Status = finalStatuses[STEP_2_LINE];
    assert.ok(
      step2Status === 'pass' || step2Status === 'pass-cached',
      `Step 2 (line ${STEP_2_LINE}) must pass — proves {{target_url}} interpolated from ` +
        `session.outputs across the batch boundary. Got '${step2Status}'. ` +
        `If 'fail', the [store as: X] → session.outputs sync regressed.`,
    );

    // And step 1 must still be pass (not blanked by the resume — that
    // was the OTHER bug from this scope of work, the wiped-pass-marks
    // regression).
    const step1AfterResume = finalStatuses[STEP_1_LINE];
    assert.ok(
      step1AfterResume === 'pass' || step1AfterResume === 'pass-cached',
      `Step 1 status must survive resume — got '${step1AfterResume}'. ` +
        `If undefined, the wiped-pass-marks regression returned.`,
    );

    // Clean up.
    await vscode.commands.executeCommand('testbench-native.restartSession');
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }
  });
});

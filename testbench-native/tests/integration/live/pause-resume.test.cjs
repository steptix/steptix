/**
 * Live end-to-end pause/resume/pause test.
 *
 * Drives securebank.md against the REAL ai-ui-automation Sessions API server
 * (SERVER_URL from templates/.env, expected to be running on
 * http://localhost:3100). A real browser actually opens, real AI calls
 * happen, real network requests fly. Validates the spec promise that the
 * user can pause mid-step, resume, and pause again — through the
 * testbench command surface, not the controller internals.
 *
 * The site under test is fixtures/test-app (SecureBank), booted on :8787 by
 * runLiveTest.cjs. This used to drive github.md against real github.com,
 * which made the test depend on a shared external account: a concurrent run
 * signing out could invalidate this one's session mid-test, GitHub could
 * challenge or rate-limit the login, and it eventually stopped working
 * altogether once the account began 2FA-challenging. None of those failures
 * were TestBench regressions — which is exactly the problem, because they
 * were indistinguishable from ones that would be. The fixture app has
 * static markup, fixed credentials and no rate limit, so a failure here now
 * means something in the pause/resume path actually broke.
 *
 * NOT part of the fast integration suite. Run via:
 *   node tests/integration/runLiveTest.cjs
 *
 * Required env (from templates/.env, picked up via walkup):
 *   SERVER_URL, AIUI_SERVER_API_KEY, AI_API_KEY
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
    try {
      if (await predicate()) return;
    } catch {
      // ignore — predicate transient errors are part of the wait
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

describe('TestBench live pause/resume against real server', function () {
  this.timeout(240_000);

  /** @type {import('../../../dist/extension/extension').TestBenchTestHooks} */
  let hooks;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks missing — activation may have failed');

    // Sanity check: server reachable.
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
        `Live test requires ai-ui-automation server running at ${serverUrl}. ` +
          `Start it with \`npm run dev\` or \`aiui serve\`. ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  it('pauses mid-step, resumes, pauses again', async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder open — runLiveTest.cjs must pass templates/ as workspace');
    const testFile = path.resolve(workspaceRoot, 'init', 'tests', 'securebank.md');
    assert.ok(fs.existsSync(testFile), `securebank.md not found at ${testFile}`);

    const uri = vscode.Uri.file(testFile);
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('securebank.md becomes active editor', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === uri.toString();
    });
    const editor = vscode.window.activeTextEditor;

    // Drop any breakpoints from a prior run.
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }

    // Wait for the testbench-native.activeFile context key to flip true.
    await waitFor(
      'testbench detects test file',
      () => hooks.tracker.snapshot().isTestFile === true,
      10_000,
    );

    // Cursor on step 1 so runSelected runs the whole file from the top,
    // giving us all 9 steps in order. securebank.md line 17 is
    // `1. Navigate to the baseUrl`; Position is 0-based, hence the -1.
    const STEP_1_LINE = 17;
    editor.selection = new vscode.Selection(
      new vscode.Position(STEP_1_LINE - 1, 0),
      new vscode.Position(STEP_1_LINE - 1, 0),
    );

    console.log('[live] tracker before run:', JSON.stringify({
      isTestFile: hooks.tracker.snapshot().isTestFile,
      filePath: hooks.tracker.snapshot().filePath,
      breakpointStop: hooks.tracker.snapshot().breakpointStop,
    }));
    console.log('[live] runningContext before run:', hooks.runningContextValue());
    console.log('[live] Starting run via testbench-native.runSelected');
    void vscode.commands.executeCommand('testbench-native.runSelected');

    // Poll briefly for the running flag, surfacing diagnostics at each interval
    // so we can tell whether runLines started but failed, vs. never started.
    const t0 = Date.now();
    let lastSnap = '';
    while (Date.now() - t0 < 30_000) {
      if (hooks.isRunning()) break;
      const snap = hooks.tracker.snapshot();
      const sig = `running=${hooks.isRunning()} ctx=${hooks.runningContextValue()} bp=${snap.breakpointStop} statuses=${JSON.stringify([...snap.statuses])}`;
      if (sig !== lastSnap) {
        console.log(`[live] poll @${Date.now() - t0}ms: ${sig}`);
        lastSnap = sig;
      }
      await sleep(500);
    }
    if (!hooks.isRunning()) {
      const snap = hooks.tracker.snapshot();
      const ws = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath).join(',');
      throw new Error(
        `timeout waiting for: isRunning becomes true. ` +
          `last state: ${lastSnap}; ` +
          `isTestFile=${snap.isTestFile} filePath=${snap.filePath} ` +
          `activeEditor=${vscode.window.activeTextEditor?.document.uri.fsPath} ` +
          `workspaces=[${ws}] ` +
          `activeControllerResolves=${hooks.activeControllerResolves?.() ?? '(hook missing)'} ` +
          `notifyRunningHistory=${JSON.stringify(hooks.notifyRunningHistory?.() ?? [])} ` +
          `lastRunError=${JSON.stringify(hooks.lastRunError?.() ?? null)}`,
      );
    }

    // ---- Pause #1: after step 1 starts ---------------------------------
    // Wait for any step to start running. Step 1 is "Navigate to the
    // baseUrl" — it may take a few seconds for the browser to open and
    // navigate.
    console.log('[live] Waiting for first step:start event…');
    let firstStepLine = null;
    await waitFor(
      'first step:start arrives',
      () => {
        const snap = hooks.tracker.snapshot();
        for (const [line, status] of snap.statuses) {
          if (status === 'running') {
            firstStepLine = line;
            return true;
          }
        }
        return false;
      },
      90_000,
    );
    console.log(`[live] First step running on line ${firstStepLine}`);

    // Give the step a moment to settle. We don't want to pause so early
    // that we abort before any meaningful work happened, but we don't
    // need to wait for it to finish either — pause is meant to interrupt.
    await sleep(2_000);

    console.log('[live] Pausing #1');
    await vscode.commands.executeCommand('testbench-native.pause');

    await waitFor(
      'breakpointStop set after pause #1',
      () => hooks.tracker.snapshot().breakpointStop != null,
      30_000,
    );
    const pausePoint1 = hooks.tracker.snapshot().breakpointStop;
    await waitFor('isRunning becomes false after pause #1', () => !hooks.isRunning(), 15_000);
    console.log(`[live] Paused #1 at line ${pausePoint1}, isRunning=false ✓`);

    // Snapshot of status marks at the pause point. We'll re-check this
    // after resume to guard the wiped-pass-marks regression (f6b24c1):
    // pre-fix, the resume call cleared every status before the new batch
    // started, so any step that had passed before the pause vanished
    // from the gutter when the user hit Continue.
    const statusesAtPause1 = new Map(hooks.tracker.snapshot().statuses);
    const passedAtPause1 = [...statusesAtPause1.entries()]
      .filter(([, s]) => s === 'pass' || s === 'pass-cached')
      .map(([line]) => line);
    console.log(`[live] At pause #1, passed lines = ${JSON.stringify(passedAtPause1)}`);

    // ---- Resume → run continues ----------------------------------------
    console.log('[live] Resuming');
    void vscode.commands.executeCommand('testbench-native.resume');

    await waitFor('isRunning back to true after resume', () => hooks.isRunning(), 15_000);
    await waitFor(
      'breakpointStop cleared after resume',
      () => hooks.tracker.snapshot().breakpointStop == null,
      15_000,
    );
    console.log('[live] Resumed ✓');

    // Audit assertion (added 2026-05-18): every step that passed before
    // the pause must still show passed immediately after resume kicks
    // off. The wiped-pass-marks regression (fix in f6b24c1) made this
    // assertion necessary — without it the live test would have caught
    // the bug. Resume opens a new SSE stream against the still-alive
    // session; the client must NOT wipe previously-painted statuses as
    // part of that flow.
    const statusesAfterResumeStart = Object.fromEntries(
      hooks.tracker.snapshot().statuses,
    );
    for (const line of passedAtPause1) {
      const s = statusesAfterResumeStart[line];
      assert.ok(
        s === 'pass' || s === 'pass-cached',
        `Line ${line} must keep its passed status across resume — ` +
          `got '${s}'. If undefined, the wiped-pass-marks regression returned.`,
      );
    }

    // ---- Pause #2: wait for a *new* step:start, then pause again -------
    console.log('[live] Waiting for the next step:start (different line)…');
    await waitFor(
      'a different step starts running after resume',
      () => {
        const snap = hooks.tracker.snapshot();
        for (const [line, status] of snap.statuses) {
          if (status === 'running' && line !== pausePoint1) return true;
        }
        return false;
      },
      120_000,
    );

    let secondStepLine = null;
    {
      const snap = hooks.tracker.snapshot();
      for (const [line, status] of snap.statuses) {
        if (status === 'running') secondStepLine = line;
      }
    }
    console.log(`[live] Second step running on line ${secondStepLine}`);

    await sleep(2_000);

    console.log('[live] Pausing #2');
    await vscode.commands.executeCommand('testbench-native.pause');

    await waitFor(
      'breakpointStop set after pause #2',
      () => hooks.tracker.snapshot().breakpointStop != null,
      30_000,
    );
    const pausePoint2 = hooks.tracker.snapshot().breakpointStop;
    await waitFor('isRunning false after pause #2', () => !hooks.isRunning(), 15_000);
    console.log(`[live] Paused #2 at line ${pausePoint2}, isRunning=false ✓`);

    // ---- Final assertions ----------------------------------------------
    assert.notEqual(
      pausePoint2,
      pausePoint1,
      `Pause #2 should be on a different line than Pause #1 (both were ${pausePoint1})`,
    );

    // Stop cleanly so we don't leak a browser session.
    console.log('[live] Cleaning up — testbench-native.stop');
    await vscode.commands.executeCommand('testbench-native.stop');
    await waitFor(
      'breakpointStop cleared after stop',
      () => hooks.tracker.snapshot().breakpointStop == null,
      10_000,
    );
    // Tell the server to release the browser.
    await vscode.commands.executeCommand('testbench-native.restartSession');
  });
});

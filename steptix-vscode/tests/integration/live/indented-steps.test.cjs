/**
 * Live: an indented step runs from VS Code, from the line the author sees it on
 * (steptix/steptix#49).
 *
 * templates/init/tests/indented-steps.md is the example from the issue: steps
 * 1-5 on lines 10-14 are indented by two spaces, steps 6-7 on lines 15-16 are
 * not. Before the fix the editor gave lines 10-14 status cells, but a Run sent
 * only lines 15 and 16 — the running dot appeared on line 15 and the login
 * never happened, so "Transaction History" failed for no visible reason.
 *
 * What only the whole stack can show: the extension's step list (runner-core,
 * bundled), the run's `sourceLines`, the server echoing them on `step:start`,
 * and the tracker painting where they say. Unit tests cover each piece; this
 * covers the wiring between them, against the real server and SecureBank
 * (fixtures/test-app on :8787, booted by runLiveTest.cjs).
 *
 * Required env (from templates/.env, picked up via walkup):
 *   STEPTIX_SERVER_URL, AI_API_KEY
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');

const EXT_ID = 'pkent.steptix-vscode';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {
      // transient — part of the wait
    }
    await sleep(100);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

/** Lines 10-14 are indented, 15-16 are at the margin. */
const STEP_LINES = [10, 11, 12, 13, 14, 15, 16];

describe('Steptix live — indented steps run from the line they are on', function () {
  this.timeout(300_000);

  /** @type {import('../../../dist/extension/extension').SteptixTestHooks} */
  let hooks;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks missing — activation may have failed');

    const serverUrl = process.env.LIVE_STEPTIX_SERVER_URL || 'http://localhost:3100';
    try {
      const res = await fetch(`${serverUrl}/sessions/healthcheck/steps`, { method: 'OPTIONS' });
      assert.ok(
        res.status === 204 || res.status === 200,
        `Server at ${serverUrl} not responding (status=${res.status})`,
      );
    } catch (err) {
      throw new Error(
        `Live test requires Steptix server running at ${serverUrl}. ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  after(async () => {
    await vscode.commands.executeCommand('steptix.restartSession');
  });

  it('runs all seven steps, starting on line 10, and passes', async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — runLiveTest.cjs must pass templates/ as workspace');
    const testFile = path.resolve(workspaceRoot, 'init', 'tests', 'indented-steps.md');
    assert.ok(fs.existsSync(testFile), `indented-steps.md not found at ${testFile}`);

    const uri = vscode.Uri.file(testFile);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
      preview: false,
    });
    await waitFor('indented-steps.md becomes active editor', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === uri.toString();
    });
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }
    await waitFor('steptix detects test file', () => hooks.tracker.snapshot().isTestFile === true, 10_000);
    await vscode.commands.executeCommand('steptix.clearStatuses');

    // Every line that was ever painted `running`, in the order first seen. A
    // step takes seconds (a model call and a browser action), far longer than
    // the poll interval, so none is missed.
    const runningOrder = [];
    let polling = true;
    const poller = (async () => {
      while (polling) {
        for (const [line, status] of hooks.tracker.snapshot().statuses) {
          if (status === 'running' && !runningOrder.includes(line)) runningOrder.push(line);
        }
        await sleep(100);
      }
    })();

    try {
      void vscode.commands.executeCommand('steptix.runAll');
      await waitFor('isRunning becomes true', () => hooks.isRunning(), 30_000);
      await waitFor('run finishes', () => !hooks.isRunning(), 270_000);
    } finally {
      polling = false;
      await poller;
    }

    console.log(`[live] running order: ${runningOrder.join(', ')}`);
    assert.equal(runningOrder[0], 10, `the first step to run was line ${runningOrder[0]}, not line 10`);
    assert.deepEqual(runningOrder, STEP_LINES);

    const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    for (const line of STEP_LINES) {
      assert.match(String(statuses[line]), /^pass/, `line ${line} ended ${statuses[line]}`);
    }
    assert.equal(hooks.lastDoneStatus(), 'passed', `run ended ${hooks.lastDoneStatus()}`);
  });
});

/**
 * Live end-to-end STOP → report test (issue 021).
 *
 * Drives github.md against the REAL ai-ui-automation Sessions API server
 * (SERVER_URL from templates/.env, expected on http://localhost:3100). A real
 * browser opens, real AI calls happen. Validates that after a user STOP:
 *   - the run halts promptly (ties to issue 020's fast-stop),
 *   - the stopped run's report path is recovered (GET /sessions/:id/last-run)
 *     even though the `done` event was dropped when the SSE stream aborted,
 *   - the report on disk marks the run ABORTED and flags the interrupted step,
 *   - the run's token total is recovered (> 0) despite the abrupt stop.
 *
 * IMPORTANT: the live server runs the BUILT dist/, so rebuild (`npm run build`
 * at repo root) and restart the server before running this — otherwise these
 * assertions test stale server code. (vitest server tests run against src and
 * are unaffected.)
 *
 * NOT part of the fast suite. Run via: node tests/integration/runLiveTest.cjs
 * (auto-discovered by the glob — no wiring needed).
 *
 * Required env (from templates/.env, picked up via walkup):
 *   SERVER_URL, SERVER_API_KEY, AI_API_KEY, GITHUB_USERNAME, GITHUB_PASSWORD
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

describe('TestBench live STOP → report recovery against real server', function () {
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
        `Live test requires ai-ui-automation server running at ${serverUrl}. ` +
          `Rebuild dist (\`npm run build\`) and start it (\`npm run dev\` / \`aiui serve\`). ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  it('stops promptly, recovers the aborted report path + tokens, marks the interrupted step', async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — runLiveTest.cjs must pass templates/ as workspace');
    const testFile = path.resolve(workspaceRoot, 'init', 'tests', 'github.md');
    assert.ok(fs.existsSync(testFile), `github.md not found at ${testFile}`);

    const uri = vscode.Uri.file(testFile);
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('github.md becomes active editor', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === uri.toString();
    });

    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }
    await waitFor('testbench detects test file', () => hooks.tracker.snapshot().isTestFile === true, 10_000);

    // Run the whole test from the top.
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(new vscode.Position(15, 0), new vscode.Position(15, 0));
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('isRunning becomes true', () => hooks.isRunning(), 30_000);

    // Let at least one step PASS so the report has content and an interrupted
    // step is recorded for the in-flight one.
    await waitFor(
      'at least one step passes',
      () => [...hooks.tracker.snapshot().statuses.values()].some((s) => s === 'pass' || s === 'pass-cached'),
      120_000,
    );
    // Wait until a subsequent step is actually running, so STOP lands mid-step.
    await waitFor(
      'a step is running',
      () => [...hooks.tracker.snapshot().statuses.values()].some((s) => s === 'running'),
      120_000,
    );
    await sleep(1_500);

    // ---- STOP -----------------------------------------------------------
    const stoppedAt = Date.now();
    await vscode.commands.executeCommand('testbench-native.stop');
    await waitFor('isRunning false after stop', () => !hooks.isRunning(), 15_000);
    const stopLatencyMs = Date.now() - stoppedAt;
    console.log(`[live] stop → idle in ${stopLatencyMs}ms`);
    // Fast-stop (issue 020): halting shouldn't take the old ~120s AI window.
    assert.ok(stopLatencyMs < 30_000, `stop took ${stopLatencyMs}ms — expected prompt halt`);

    // ---- Report recovery (issue 021) — runs in the background after stop --
    await waitFor('lastReportPath recovered after stop', () => hooks.lastReportPath() != null, 20_000);
    const reportPath = hooks.lastReportPath();
    assert.ok(reportPath && fs.existsSync(reportPath), `recovered report path must exist on disk: ${reportPath}`);

    // The report marks the run aborted + the interrupted step.
    const html = fs.readFileSync(reportPath, 'utf8');
    assert.match(html, /badge-aborted/, 'report must render the aborted state');
    assert.match(html, /ABORTED/, 'report banner/badge must read ABORTED');

    // Token totals recovered despite the abrupt stop.
    const tokens = hooks.lastRunTokens();
    assert.ok(tokens, 'token totals must be recovered after stop');
    assert.ok(tokens.total > 0, `recovered run token total must be > 0 (got ${tokens.total})`);

    // ---- Teardown (AFTER all assertions — restartSession DELETEs the
    // session and would 404 a later getLastRun) --------------------------
    await vscode.commands.executeCommand('testbench-native.restartSession');
  });
});

/**
 * Live end-to-end test for the server-side StepCache wiring (0.5.25).
 *
 * Validates the actual user-facing promise of Goal 1: re-running a test
 * skips the AI call on every step whose plan is already cached, and the
 * client paints ⚡ glyphs (status `pass-cached`) instead of plain ✓.
 *
 * Why a live test is the right surface here:
 *   - The vitest layer mocks executeStep, so it can prove the wire
 *     (request fields, fromCache event flag, status mapping) but cannot
 *     exercise the actual StepCache.read/write loop with real AI
 *     responses.
 *   - The fast integration suite uses FakeApiClient and never invokes
 *     a real server, so it can't prove the cache directory actually
 *     gets populated on disk under <project-root>/.cache.
 *   - This test drives the real api-server, real AI gateway, real
 *     browser end-to-end, twice, and asserts the second run's gutter
 *     statuses are all 'pass-cached'.
 *
 * Prereq: `npm run dev` (or `aiui serve`) running on $LIVE_SERVER_URL
 * (default http://localhost:3100), and templates/.env with
 * SERVER_API_KEY + AI_API_KEY present.
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

describe('TestBench live — step cache replay paints ⚡ on second run', function () {
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

  it('first run populates cache, second run replays from cache and paints ⚡', async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — live runner must pass templates/');

    const testFile = path.resolve(workspaceRoot, 'init', 'tests', 'cache-replay.md');
    assert.ok(fs.existsSync(testFile), `cache-replay.md not found at ${testFile}`);

    // Clean slate: nuke any cache state from prior runs of this fixture so
    // we can be sure the first run is the one that populates it. The
    // server resolves projectRoot by walking up from testFilePath looking
    // for aiui.config.ts; templates/init/aiui.config.ts is the marker, so
    // the cache lives at templates/init/.cache/.
    const projectRoot = path.resolve(workspaceRoot, 'init');
    const cacheDir = path.join(projectRoot, '.cache');
    try {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      console.log(`[live] Cleared cache at ${cacheDir}`);
    } catch {
      // No prior cache — that's fine.
    }

    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }

    const uri = vscode.Uri.file(testFile);
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor(
      'cache-replay.md becomes active editor',
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
    );
    await waitFor(
      'tracker recognises test file',
      () => hooks.tracker.snapshot().isTestFile === true,
    );

    // ===== Run 1: cold cache → expect plain pass on every step =====
    console.log('[live] Run 1: cold cache, AI will be called');
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('Run 1: isRunning true', () => hooks.isRunning(), 30_000);
    await waitFor(
      'Run 1: idle (all steps done)',
      () => !hooks.isRunning(),
      180_000,
    );

    const run1Statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    console.log('[live] Run 1 final statuses:', run1Statuses);
    // Step lines in cache-replay.md (1-based): "1. Navigate..." on line 13,
    // "2. Verify..." on line 14. Both should be plain `pass` on the cold
    // run — AI was called, cache populated.
    const STEP_LINES = [13, 14];
    for (const line of STEP_LINES) {
      assert.equal(
        run1Statuses[line],
        'pass',
        `Run 1: line ${line} should be 'pass' (cold-cache run), got '${run1Statuses[line]}'`,
      );
    }

    // Cache should now exist on disk — sanity check the server actually
    // wrote something where we expect it.
    assert.ok(
      fs.existsSync(cacheDir),
      `Cache directory ${cacheDir} should exist after Run 1 populates it`,
    );

    // ===== Run 2: warm cache → expect pass-cached on every step =====
    // Close the session so the second run starts with a fresh browser —
    // matches what the user does in a real "edit and re-run" workflow.
    console.log('[live] Closing session before Run 2');
    await vscode.commands.executeCommand('testbench-native.restartSession');
    // Give the close call a beat to complete server-side.
    await sleep(1_000);

    console.log('[live] Run 2: warm cache, AI should be skipped');
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('Run 2: isRunning true', () => hooks.isRunning(), 30_000);
    await waitFor(
      'Run 2: idle (all steps replayed from cache)',
      () => !hooks.isRunning(),
      180_000,
    );

    const run2Statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    console.log('[live] Run 2 final statuses:', run2Statuses);

    // The whole point: every step on the second run should paint with
    // pass-cached, not plain pass. If any line came back as 'pass' that
    // means the cache miss thrashed and the AI was called again — which
    // either means the cache wasn't actually written or the hash key
    // shifted between runs.
    for (const line of STEP_LINES) {
      assert.equal(
        run2Statuses[line],
        'pass-cached',
        `Run 2: line ${line} should be 'pass-cached' (cache replay), got '${run2Statuses[line]}' — ` +
          `cache may not be populating or hash may be unstable across runs`,
      );
    }

    // Clean up so we don't leave a browser session running.
    await vscode.commands.executeCommand('testbench-native.restartSession');
  });
});

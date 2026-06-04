/**
 * Live end-to-end test for server-side video recording.
 *
 * Validates the user-facing promise of `browser.video`: a run driven through
 * the real api-server (TestBench → POST /sessions/.../steps) records the
 * browser session and SAVES a `.webm` to disk, finalised when the session is
 * closed.
 *
 * Why a live test is the right surface here:
 *   - The vitest api-server tests MOCK resolveVideoMode/finalizeMainPageVideo
 *     to 'off', so they prove the wire but never exercise a real recording.
 *   - tests/video-recording.test.ts drives `finalizeMainPageVideo` against a
 *     real Playwright context, but bypasses the server entirely — it never
 *     proves the server READS `browser.video` from the test's project config
 *     and attaches `recordVideo` at session creation. (That was in fact broken:
 *     the server read video mode from its startup config, not the per-project
 *     bundle — see feedback_thread_new_config_to_server_bundle.)
 *   - This test drives the real api-server + a real browser end-to-end and
 *     asserts a `.webm` actually lands on disk, then deletes it.
 *
 * Isolation: the fixture lives in its own project (templates/video-record/ with
 * `browser.video: "on"`), so ONLY this run records — the other live fixtures
 * under templates/init/ keep video off.
 *
 * Prereq: the api-server running on $LIVE_SERVER_URL (default
 * http://localhost:3100), started from the repo root (so reports.outputDir is
 * <repo-root>/reports), with templates/.env providing SERVER_API_KEY + AI_API_KEY.
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

/** Set of `.webm` filenames currently in `dir` (empty if the dir doesn't exist yet). */
function webmsIn(dir) {
  try {
    return new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.webm')));
  } catch {
    return new Set();
  }
}

describe('TestBench live — server records and saves a .webm when browser.video is on', function () {
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
          `Start it with \`npm run dev\` or \`aiui serve\` from the repo root. ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  it('records a .webm through the server path and finalises it on session close', async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — live runner must pass templates/');

    const testFile = path.resolve(workspaceRoot, 'video-record', 'tests', 'record-video.md');
    assert.ok(fs.existsSync(testFile), `record-video.md not found at ${testFile}`);

    // Videos land beside the server's reports. The server runs from the repo
    // root, whose aiui.config.json has reports.outputDir "./reports"; videoDir
    // is server-global (<reports.outputDir>/videos), co-located with reports so
    // the report's relative <video> link resolves. Repo root = parent of the
    // live-test workspace (templates/).
    const repoRoot = path.resolve(workspaceRoot, '..');
    const videosDir = path.join(repoRoot, 'reports', 'videos');

    // Snapshot existing .webm files so we can identify exactly what THIS run
    // produced (and avoid deleting anyone else's recording on cleanup).
    const before = webmsIn(videosDir);
    console.log(`[live] videos dir ${videosDir} — ${before.size} pre-existing .webm`);

    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }

    const uri = vscode.Uri.file(testFile);
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor(
      'record-video.md becomes active editor',
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
    );
    await waitFor(
      'tracker recognises test file',
      () => hooks.tracker.snapshot().isTestFile === true,
    );

    // ===== Run the fixture =====
    console.log('[live] Running record-video.md (browser.video: "on")');
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('isRunning true', () => hooks.isRunning(), 30_000);
    await waitFor('run idle (all steps done)', () => !hooks.isRunning(), 180_000);

    const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    console.log('[live] Final statuses:', statuses);

    // The .webm is finalised only when the SESSION is closed — not at run end
    // (Tier 1 server limitation, caveat #7 in stories/video-recording.md).
    // restartSession closes the session, which runs finalizeMainPageVideo and
    // writes the file.
    console.log('[live] Closing session to finalise the video');
    await vscode.commands.executeCommand('testbench-native.restartSession');

    // ===== Assert a NEW .webm was created and saved =====
    let newWebms = [];
    await waitFor(
      'a new .webm appears in the videos dir',
      () => {
        newWebms = [...webmsIn(videosDir)].filter((f) => !before.has(f));
        return newWebms.length > 0;
      },
      30_000,
    );

    assert.ok(
      newWebms.length >= 1,
      `Expected a new .webm in ${videosDir} after the run — got none. ` +
        `The server may not be honouring the project's browser.video, or it was ` +
        `started from a cwd whose reports.outputDir isn't <repo-root>/reports.`,
    );
    const savedAbs = path.join(videosDir, newWebms[0]);
    const stat = fs.statSync(savedAbs);
    assert.ok(stat.size > 0, `Recorded .webm is empty (0 bytes): ${savedAbs}`);
    console.log(`[live] Recorded video saved: ${savedAbs} (${stat.size} bytes)`);

    // ===== Cleanup: delete the video(s) this run produced =====
    // Keeps the repo's reports/videos/ from accumulating artifacts across runs.
    for (const f of newWebms) {
      try {
        fs.rmSync(path.join(videosDir, f), { force: true });
        console.log(`[live] Deleted recorded video: ${f}`);
      } catch (err) {
        console.warn(`[live] Failed to delete ${f}: ${String(err)}`);
      }
    }
    const after = webmsIn(videosDir);
    for (const f of newWebms) {
      assert.ok(!after.has(f), `Cleanup failed — ${f} still present in ${videosDir}`);
    }
  });
});

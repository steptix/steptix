/**
 * Live end-to-end test for server-side video recording + per-project output.
 *
 * Validates the full user-facing promise of `browser.video`: a run driven
 * through the real api-server (TestBench → POST /sessions/.../steps)
 *   1. records the browser session,
 *   2. writes the report + `.webm` under the TEST PROJECT's reports.outputDir
 *      (not the server's startup cwd), and
 *   3. links the video in the report (`<video class="session-video">`) once the
 *      session is closed.
 *
 * Why a live test is the right surface here:
 *   - The vitest api-server tests MOCK resolveVideoMode/finalizeMainPageVideo to
 *     'off', so they prove the wire but never exercise a real recording.
 *   - tests/video-recording.test.ts drives `finalizeMainPageVideo` against a
 *     real Playwright context but bypasses the server — it never proves the
 *     server reads `browser.video` AND `reports.outputDir` from the test's
 *     project config. Both were in fact server-global bugs (the server read them
 *     from its startup config) — see feedback_thread_new_config_to_server_bundle.
 *   - This test drives the real api-server + a real browser end-to-end and
 *     asserts the report links a real, non-empty `.webm` in the project's own
 *     reports dir, then deletes the artifacts.
 *
 * Isolation: the fixture is its own project (templates/video-record/ with
 * `browser.video: "on"`), so ONLY this run records and it writes under
 * templates/video-record/reports/ — the other live fixtures keep video off.
 *
 * Prereq: the api-server running on $LIVE_SERVER_URL (default
 * http://localhost:3100), with templates/.env providing AIUI_SERVER_API_KEY +
 * AI_API_KEY. (Report location is now per-project, so the server's cwd no longer
 * matters for where this test's report lands.)
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

/** record-video report filenames currently in `dir` (empty if dir is absent). */
function recordVideoReportsIn(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /record-video.*\.html$/.test(f));
  } catch {
    return [];
  }
}

describe('TestBench live — server records, links, and saves a .webm per project', function () {
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

  it('writes the report+video under the project reports dir and links the video', async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — live runner must pass templates/');

    // The fixture is its own project. The server anchors reports.outputDir to
    // the project root, so the report + video land here — regardless of the
    // server's cwd.
    const projectRoot = path.resolve(workspaceRoot, 'video-record');
    const reportsDir = path.join(projectRoot, 'reports');
    const testFile = path.join(projectRoot, 'tests', 'record-video.md');
    assert.ok(fs.existsSync(testFile), `record-video.md not found at ${testFile}`);

    // Snapshot existing record-video reports so we can pick out THIS run's.
    const reportsBefore = new Set(recordVideoReportsIn(reportsDir));

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
    console.log('[live] Final statuses:', Object.fromEntries(hooks.tracker.snapshot().statuses));

    // The .webm is finalised and the report re-rendered with the <video> link
    // only when the SESSION is closed — not at run end (Tier 1 server
    // limitation, caveat #7 in stories/video-recording.md). restartSession
    // closes it, triggering finalizeMainPageVideo + a report re-render.
    console.log('[live] Closing session to finalise the video + re-render the report');
    await vscode.commands.executeCommand('testbench-native.restartSession');

    // ===== Assert: a NEW report appears, in the PROJECT's reports dir, with a
    // working <video> link. We poll the report content (not just the .webm) so
    // we wait for the re-render to complete — no race with the cleanup below. =====
    let linkedReport = null;
    let videoSrc = null;
    await waitFor(
      `report re-rendered with a <video> link in ${reportsDir}`,
      () => {
        const fresh = recordVideoReportsIn(reportsDir).filter((f) => !reportsBefore.has(f));
        for (const f of fresh) {
          const html = fs.readFileSync(path.join(reportsDir, f), 'utf8');
          const m = html.match(/<video class="session-video" src="([^"]+)"/);
          if (m) { linkedReport = f; videoSrc = m[1]; return true; }
        }
        return false;
      },
      30_000,
    );

    assert.ok(
      linkedReport,
      `No report with a <video> link appeared in ${reportsDir}. The server may ` +
        `not be anchoring reports.outputDir to the test's project, or the video ` +
        `re-render on session close didn't run.`,
    );
    // Link is relative to the report (reportsDir), POSIX-style.
    assert.match(videoSrc, /^videos\/.+\.webm$/, `unexpected video src "${videoSrc}"`);
    console.log(`[live] Report ${linkedReport} links video: ${videoSrc}`);

    // The linked .webm must actually exist on disk and be non-empty.
    const savedAbs = path.resolve(reportsDir, videoSrc);
    const stat = fs.statSync(savedAbs);
    assert.ok(stat.size > 0, `Linked .webm is empty (0 bytes): ${savedAbs}`);
    console.log(`[live] Linked video saved: ${savedAbs} (${stat.size} bytes)`);

    // ===== Cleanup: delete the video this run produced, plus the report that
    // links it (so reports/ doesn't accumulate dangling-link artifacts). =====
    fs.rmSync(savedAbs, { force: true });
    fs.rmSync(path.join(reportsDir, linkedReport), { force: true });
    assert.ok(!fs.existsSync(savedAbs), `Cleanup failed — video still present: ${savedAbs}`);
    console.log('[live] Cleaned up recorded video + its report');
  });
});

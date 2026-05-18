/**
 * Live end-to-end regression test for the user-reported bug where
 * the test file's `[skill: ...]` step row stayed blank (no spinner,
 * no green ✓) even on a clean run when a breakpoint paused execution
 * inside the skill body. Root cause was `expandSkills` dropping the
 * caller's `sourceLines`, so the wire `frame.line` came through as
 * `0` and the extension's paint-on-frame-push guard
 * (`if (ev.frame.line > 0)`) silently no-op'd.
 *
 * What makes this test load-bearing where the in-process tests aren't:
 * the existing mocha integration tests use a `FakeApiClient` that
 * scripts events directly, so they can't catch a bug that lives in
 * what the *real* server emits. The vitest layer catches the wire
 * value but never runs the extension's paint code. This test wires
 * the whole stack:
 *   real api-server (running externally on $LIVE_SERVER_URL)
 *     → real http transport (runner-core's ApiClient)
 *       → real RunController + tracker
 *         → real ActiveFileTracker.statuses[]
 *
 * The test is deliberately short: it sets a breakpoint inside the
 * skill body and only runs as far as `step:awaiting` (the server's
 * breakpoint pause). At that point, the test file's `[skill: ...]`
 * row MUST show `running` — which proves the top-level `frame:push`
 * event arrived with the correct invocation line. We don't bother
 * continuing through skill execution because that would invoke real
 * AI + browser for steps that aren't part of what's under test, and
 * any flakiness there would mask the bug we're guarding against.
 *
 * Prereq: `npm run dev` (or `aiui serve`) running on $LIVE_SERVER_URL
 * (default http://localhost:3100), and templates/.env with
 * SERVER_API_KEY + AI_API_KEY present.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = 'pkent.testbench-native';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await predicate()) return; } catch { /* transient */ }
    await sleep(200);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

describe('TestBench live — [skill:] line gets painted at breakpoint pause', function () {
  this.timeout(120_000);

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

  it('frame:push paints `running` on the test-file [skill:] row at breakpoint pause', async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — live runner must pass templates/');

    const testFile = path.resolve(workspaceRoot, 'init', 'tests', 'skill-line-paint.md');
    const skillFile = path.resolve(workspaceRoot, 'init', 'skills', 'noop_skill.md');

    const testUri = vscode.Uri.file(testFile);
    const skillUri = vscode.Uri.file(skillFile);

    // Clean slate: drop any breakpoints from prior runs.
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }

    // Open the skill file first to drop a breakpoint into it (line 16
    // = "1. Navigate to about:blank", the skill's first step), then
    // switch focus to the test file so runSelected targets it.
    await vscode.commands.executeCommand('vscode.open', skillUri);
    await waitFor(
      'skill file active for breakpoint placement',
      () => vscode.window.activeTextEditor?.document.uri.toString() === skillUri.toString(),
    );
    const SKILL_BP_LINE = 16; // 1-based
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(skillUri, new vscode.Position(SKILL_BP_LINE - 1, 0)),
        true,
      ),
    ]);

    await vscode.commands.executeCommand('vscode.open', testUri);
    await waitFor(
      'test file active',
      () => vscode.window.activeTextEditor?.document.uri.toString() === testUri.toString(),
    );
    await waitFor(
      'tracker recognises test file',
      () => hooks.tracker.snapshot().isTestFile === true,
    );

    // Empty selection → runSelected runs the whole file.
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(0, 0),
      new vscode.Position(0, 0),
    );

    console.log('[live] Starting run; expecting pause at skill body line', SKILL_BP_LINE);
    void vscode.commands.executeCommand('testbench-native.runSelected');

    // Wait for the run to actually start.
    await waitFor('isRunning true', () => hooks.isRunning(), 30_000);

    // The whole point of this test: as soon as the server emits
    // frame:push for the top-level skill invocation, the test file's
    // `[skill: ...]` row (line 14 of skill-line-paint.md, see the
    // fixture's `## Steps` section) MUST show `running`. The bug had
    // it stay blank because `frame.line` was `0`, tripping the
    // `line > 0` guard in extension.ts applyToTracker.
    const SKILL_INVOCATION_LINE = 14;
    await waitFor(
      `test-file line ${SKILL_INVOCATION_LINE} shows running (frame:push painted)`,
      () => {
        const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
        return statuses[SKILL_INVOCATION_LINE] === 'running';
      },
      30_000,
    );
    console.log('[live] ✓ [skill:] row painted running');

    // Sanity: there must not be a stray status on line 0 — that's
    // the visible symptom of the regression we just fixed (the
    // old code did setStatus(uri, 0, 'running') which sat invisibly
    // in the per-URI map without painting on any real step row).
    const allStatuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    assert.equal(
      allStatuses[0],
      undefined,
      'no status should land on line 0 — that means the wire line was missing',
    );

    // Stop without continuing — the breakpoint is inside the skill,
    // and we don't need to drive the real AI/browser to confirm
    // the wire→paint pipeline. testbench-native.stop is the
    // user-facing way to abort cleanly.
    console.log('[live] Cleaning up — testbench-native.stop');
    await vscode.commands.executeCommand('testbench-native.stop');
    await waitFor('isRunning false after stop', () => !hooks.isRunning(), 15_000);

    // Release the server-side session + browser if one launched.
    await vscode.commands.executeCommand('testbench-native.restartSession');

    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }
  });

  it('frame:pop paints `pass` on the test-file [skill:] row on clean exit', async () => {
    // Audit complement (added 2026-05-18) to the running-on-frame:push
    // test above. Same fixture, no breakpoint — let the skill body run
    // to completion and assert the [skill:] aggregate flips through
    // running → pass via the frame:pop event.
    //
    // Failure mode this guards: handleFramePop's `result.failed`
    // check is what gates the pass paint. If failedFrames tracking
    // ever drifts so even a clean exit reads as failed, the [skill:]
    // line would stay running indefinitely or paint fail — both
    // observable here when the test is paint-only-success.
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder');

    const testFile = path.resolve(workspaceRoot, 'init', 'tests', 'skill-line-paint.md');
    const testUri = vscode.Uri.file(testFile);

    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }

    await vscode.commands.executeCommand('vscode.open', testUri);
    await waitFor(
      'test file active',
      () => vscode.window.activeTextEditor?.document.uri.toString() === testUri.toString(),
    );
    await waitFor(
      'tracker recognises test file',
      () => hooks.tracker.snapshot().isTestFile === true,
    );

    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(0, 0),
      new vscode.Position(0, 0),
    );

    console.log('[live] clean-exit: starting run without breakpoint');
    void vscode.commands.executeCommand('testbench-native.runSelected');

    await waitFor('isRunning true', () => hooks.isRunning(), 30_000);

    // Wait for the whole run to complete. The fixture has 2 lines:
    // line 14 = [skill: noop_skill], line 15 = Navigate to about:blank.
    // Both must pass on a clean run.
    const SKILL_INVOCATION_LINE = 14;
    const TRAILING_STEP_LINE = 15;
    await waitFor(
      'run idle',
      () => !hooks.isRunning(),
      180_000,
    );

    const finalStatuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    console.log('[live] clean-exit final statuses:', finalStatuses);

    // The whole point of this test: frame:pop with no failures must
    // paint pass on the [skill:] aggregate row. Cached replay is also
    // acceptable (the cache test runs first; if its writes survive,
    // we'd see pass-cached here too).
    const skillLineStatus = finalStatuses[SKILL_INVOCATION_LINE];
    assert.ok(
      skillLineStatus === 'pass' || skillLineStatus === 'pass-cached',
      `[skill:] line ${SKILL_INVOCATION_LINE} must show pass after clean exit, ` +
        `got '${skillLineStatus}'. If 'running', frame:pop didn't paint. ` +
        `If undefined, the row never got painted at all.`,
    );

    const trailingStatus = finalStatuses[TRAILING_STEP_LINE];
    assert.ok(
      trailingStatus === 'pass' || trailingStatus === 'pass-cached',
      `Trailing step on line ${TRAILING_STEP_LINE} must also be passed; ` +
        `got '${trailingStatus}'.`,
    );

    await vscode.commands.executeCommand('testbench-native.restartSession');
  });
});

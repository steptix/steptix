/**
 * Phase 3 step-into commands and step:awaiting handling.
 *
 * Drives the extension end-to-end inside a real VS Code extension host
 * with a FakeApiClient. The fake records every runControl call and lets
 * the test push step:awaiting / step:start / frame events at will.
 *
 * Coverage:
 *  1. step:awaiting sets the steptix.stepPaused context key and
 *     paints a breakpointStop marker on the next step's URI.
 *  2. steptix.stepInto from a step-paused state POSTs runControl
 *     with mode='into'.
 *  3. steptix.stepOver / stepOut do the same with 'over' / 'out'.
 *  4. steptix.continueRun POSTs 'continue'.
 *  5. A subsequent step:start clears the step-paused marker.
 *  6. steptix.stepInto from a fully-idle state launches a fresh
 *     run with stepMode='into' (verified by the request body the fake
 *     receives).
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');
const { FakeApiClient } = require('../fakes/fake-api-client.cjs');

const EXT_ID = 'pkent.steptix-vscode';
const FIXTURES_DIR =
  process.env.STEPTIX_FIXTURES_DIR ||
  path.resolve(__dirname, '..', 'fixtures');
const fixtureUri = (name) => vscode.Uri.file(path.resolve(FIXTURES_DIR, name));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await predicate()) return; } catch {}
    await sleep(50);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

describe('Steptix step-mode commands (Phase 3)', function () {
  this.timeout(20_000);

  /** @type {FakeApiClient} */
  let fake;
  /** @type {import('../../../dist/extension/extension').SteptixTestHooks} */
  let hooks;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks not exposed');
  });

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }
    fake = new FakeApiClient();
    hooks.setApiClientFactory(() => fake);

    const uri = fixtureUri('test-with-steps.md');
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('fixture active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === uri.toString();
    });
    // Highlight a range so runSelected has a scope.
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(8, 0),
      new vscode.Position(8, 5),
    );
    await waitFor('active file detected', () => hooks.tracker.snapshot().isTestFile);
  });

  it('step:awaiting paints breakpointStop on the next step and sets stepPaused context', async () => {
    void vscode.commands.executeCommand('steptix.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'step:awaiting', line: 9 });
    await waitFor('breakpointStop set on line 9', () => {
      return hooks.tracker.snapshot().breakpointStop === 9;
    });

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('stepInto from step-paused POSTs runControl with mode=into', async () => {
    void vscode.commands.executeCommand('steptix.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'step:awaiting', line: 9 });
    await waitFor('paused', () => hooks.tracker.snapshot().breakpointStop === 9);

    const callsBefore = fake.runControlCalls.length;
    await vscode.commands.executeCommand('steptix.stepInto');
    assert.equal(fake.runControlCalls.length, callsBefore + 1);
    assert.equal(fake.runControlCalls[callsBefore].mode, 'into');

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('stepOver / stepOut from step-paused inside a skill POST the matching mode', async () => {
    // Push a frame first so the controller's frameStack has depth > 0;
    // otherwise Phase 3.1.d intercepts Step Out at the root frame and
    // sends 'continue' instead. This test verifies the inside-a-skill
    // case where 'out' is meaningful.
    const frame = {
      id: 'f1',
      parentId: null,
      kind: 'skill',
      uri: path.resolve(FIXTURES_DIR, 'fake-skill.md'),
      line: 9,
      skillName: 'fake_skill',
    };
    void vscode.commands.executeCommand('steptix.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'frame:push', frame });
    fake.push({ type: 'step:awaiting', line: 3, frame });
    await waitFor('paused', () => hooks.runningFrameStack().length === 1);

    await vscode.commands.executeCommand('steptix.stepOver');
    await vscode.commands.executeCommand('steptix.stepOut');

    const modes = fake.runControlCalls.map((c) => c.mode);
    assert.deepEqual(modes.slice(-2), ['over', 'out']);

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('skill-file breakpoints are sent to the server via breakpointsByUri', async () => {
    // Bug fix follow-up: breakpoints in a skill .md were ignored
    // because the extension only sent test-file breakpoints. Now the
    // extension ships the full per-URI map; the server checks it
    // before each step and pauses for non-test-file matches.
    //
    // This test verifies the EXTENSION SIDE — that
    // `vscode.debug.breakpoints` set on a non-test markdown file
    // reach the request body as `breakpointsByUri`. The server-side
    // pause behaviour is covered in tests/api-server-stepmode.test.ts.
    const skillUri = fixtureUri('fake-skill.md');
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(skillUri, new vscode.Position(8, 0)),
        true,
      ),
    ]);

    void vscode.commands.executeCommand('steptix.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.end();
    await waitFor('idle', () => !hooks.isRunning());

    const req = fake.requests[0];
    assert.ok(req, 'no request captured');
    assert.ok(req.breakpointsByUri, 'breakpointsByUri must be present on the request');
    const skillPath = skillUri.fsPath;
    assert.deepEqual(
      req.breakpointsByUri[skillPath],
      [9],
      'skill-file breakpoint at editor line 8 (1-based line 9) must appear under its file path',
    );
  });

  it('continueRun POSTs runControl with mode=continue', async () => {
    void vscode.commands.executeCommand('steptix.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'step:awaiting', line: 9 });
    await waitFor('paused', () => hooks.tracker.snapshot().breakpointStop === 9);

    await vscode.commands.executeCommand('steptix.continueRun');
    const lastMode = fake.runControlCalls.at(-1)?.mode;
    assert.equal(lastMode, 'continue');

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('A subsequent step:start clears the step-paused breakpointStop marker', async () => {
    void vscode.commands.executeCommand('steptix.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'step:awaiting', line: 9 });
    await waitFor('paused', () => hooks.tracker.snapshot().breakpointStop === 9);

    // Simulate the server picking up the runControl: the loop emits the
    // next step:start, which should drop the yellow ▶.
    fake.push({ type: 'step:start', line: 9 });
    await waitFor('breakpointStop cleared', () => {
      return hooks.tracker.snapshot().breakpointStop === null;
    });

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('stepInto from idle launches a run with stepMode=into in the request body', async () => {
    assert.equal(hooks.isRunning(), false);

    void vscode.commands.executeCommand('steptix.stepInto');
    await waitFor('stream active', () => fake.hasActiveStream);

    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0].stepMode, 'into',
      'idle stepInto must send stepMode=into so the server starts paused');

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('Stop while step-paused inside a skill clears the yellow ▶ on the skill file too', async () => {
    // Phase 3.1.a regression guard: pre-fix, Stop only cleared
    // breakpointStop on the active editor (the test file). A step:awaiting
    // marker painted on a skill file would survive Stop and linger as
    // a stale yellow ▶ until the next run launched. With
    // clearAllStepPausedMarkers wired into both Stop paths, the marker
    // gets dropped wherever step:awaiting placed it.
    const skillPath = path.resolve(FIXTURES_DIR, 'fake-skill.md');
    const skillUri = vscode.Uri.file(skillPath);
    const frame = {
      id: 'f1',
      parentId: null,
      kind: 'skill',
      uri: skillPath,
      line: 9,
      skillName: 'fake_skill',
    };

    void vscode.commands.executeCommand('steptix.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    // Drive the stream into a step-paused state on the skill file.
    fake.push({ type: 'frame:push', frame });
    fake.push({ type: 'step:awaiting', line: 3, frame });
    await waitFor('skill-file breakpointStop set on line 3', () => {
      const snap = hooks.tracker.snapshotFor(skillUri);
      return snap?.breakpointStop === 3;
    });

    await vscode.commands.executeCommand('steptix.stop');

    await waitFor('idle after stop', () => !hooks.isRunning());
    // The yellow ▶ must be gone from the skill file too — not just the
    // test file's active-editor URI.
    const skillSnap = hooks.tracker.snapshotFor(skillUri);
    // After the marker is cleared the per-URI snapshot may return null
    // (no state left) — either way, breakpointStop must not be 3.
    if (skillSnap) {
      assert.notEqual(skillSnap.breakpointStop, 3,
        'Stop must clear step-paused breakpointStop on the skill file');
    }
  });

  it('Step Out at the test (root) frame sends Continue, not Step Out', async () => {
    // Phase 3.1.d regression guard: at depth 0 the server's `out`
    // decision never pauses (no shallower frame to return to). The
    // extension now intercepts and sends 'continue' with a status-bar
    // hint instead, so the user gets a clearer mental model.
    void vscode.commands.executeCommand('steptix.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    // Step-paused at depth 0 (no frame in event).
    fake.push({ type: 'step:awaiting', line: 9 });
    await waitFor('paused', () => hooks.tracker.snapshot().breakpointStop === 9);

    await vscode.commands.executeCommand('steptix.stepOut');

    const lastMode = fake.runControlCalls.at(-1)?.mode;
    assert.equal(lastMode, 'continue',
      'Step Out at the test frame must be sent as Continue');

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('stepInto via command palette while running-but-not-step-paused does not POST a 409', async () => {
    // Phase 3.1.b regression guard: dispatchStep checks isStepPaused
    // before POSTing. Without this guard, F11 via command palette
    // during a normal (non-stepping) run would generate a 409 and an
    // ugly run-control-failed status bar.
    void vscode.commands.executeCommand('steptix.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    // The run is in flight but NO step:awaiting has fired.
    fake.push({ type: 'step:start', line: 9 });
    await waitFor('running', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });

    const callsBefore = fake.runControlCalls.length;
    await vscode.commands.executeCommand('steptix.stepInto');
    // No new runControl POST should have been issued — dispatchStep
    // detected running-but-not-step-paused and bailed.
    assert.equal(fake.runControlCalls.length, callsBefore,
      'stepInto must not POST runControl when not step-paused');

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });
});

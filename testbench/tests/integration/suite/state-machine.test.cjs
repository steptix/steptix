/**
 * Drives the TestBench debug state machine end-to-end inside a real VS Code
 * extension host. Uses a FakeApiClient injected via the extension's
 * __testHooks export so the assertions are deterministic and don't depend
 * on a Sessions API server, AI gateway, or Playwright browser.
 *
 * Each test follows the same shape:
 *   1. Open the fixture .md, wait for it to be the active editor.
 *   2. Trigger a command (testbench.runSelected / pause / stop / resume).
 *   3. Push synthesized events onto the fake stream.
 *   4. Assert tracker state + isRunning() across the transition.
 *
 * Coverage maps to the spec at testbench/stories/specs/debugging-ux.md.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');
const { FakeApiClient } = require('../fakes/fake-api-client.cjs');

const EXT_ID = 'pkent.testbench';
const FIXTURES_DIR =
  process.env.TESTBENCH_FIXTURES_DIR ||
  path.resolve(__dirname, '..', 'fixtures');
const fixtureUri = (name) => vscode.Uri.file(path.resolve(FIXTURES_DIR, name));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {
      // ignore — predicate transient errors are part of the wait
    }
    await sleep(50);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

describe('TestBench debug state machine', function () {
  this.timeout(20_000);

  /** @type {FakeApiClient} */
  let fake;
  /** @type {import('../../../dist/extension/extension').TestBenchTestHooks} */
  let hooks;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks not exposed — did activate() forget to return them?');
  });

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }
    fake = new FakeApiClient();
    hooks.setApiClientFactory(() => fake);

    // Open the fixture and select the first step line. Selecting tells
    // testbench.runSelected which line to run — we always pick line 9
    // ("1. Navigate to https://example.com" in the fixture).
    const uri = fixtureUri('test-with-steps.md');
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('fixture editor active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === uri.toString();
    });
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(8, 0), // 0-based: line 9 is index 8
      new vscode.Position(8, 0),
    );

    // Wait a beat for the activeFile context key to flip true after the
    // editor open (driven by ActiveFileTracker).
    await waitFor('active file detected as test file', () => {
      const snap = hooks.tracker.snapshot();
      return snap.isTestFile === true;
    });
  });

  it('idle → running: runSelected starts a run and reports running', async () => {
    assert.equal(hooks.isRunning(), false, 'should start idle');

    void vscode.commands.executeCommand('testbench.runSelected');

    await waitFor('isRunning becomes true', () => hooks.isRunning());
    await waitFor('fake stream is active', () => fake.hasActiveStream);
    assert.equal(hooks.isRunning(), true);

    // Tear down cleanly so the test doesn't leak a controller.
    fake.end();
    await waitFor('isRunning returns false after stream ends', () => !hooks.isRunning());
  });

  it('running → idle (success): step events drive statuses, done flips running off', async () => {
    void vscode.commands.executeCommand('testbench.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'step:start', line: 9 });
    await waitFor('status running on line 9', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });

    fake.push({ type: 'step:pass', line: 9 });
    await waitFor('status pass on line 9', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'pass';
    });

    fake.end();
    await waitFor('idle after stream ends', () => !hooks.isRunning());
    assert.equal(hooks.tracker.snapshot().breakpointStop, null);
  });

  it('running → idle (stop): testbench.stop aborts immediately, no pause marker', async () => {
    void vscode.commands.executeCommand('testbench.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    await waitFor('status running', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });

    await vscode.commands.executeCommand('testbench.stop');

    await waitFor('idle after stop', () => !hooks.isRunning());
    const snap = hooks.tracker.snapshot();
    assert.equal(
      snap.breakpointStop,
      null,
      'Stop must clear pause indicator (per spec §6)',
    );
  });

  it('running → paused (user pause): testbench.pause marks resume point', async () => {
    void vscode.commands.executeCommand('testbench.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    await waitFor('status running on line 9', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });

    await vscode.commands.executeCommand('testbench.pause');

    await waitFor('breakpointStop is set to executing line', () => {
      return hooks.tracker.snapshot().breakpointStop === 9;
    });
    await waitFor('isRunning becomes false', () => !hooks.isRunning());
  });

  it('paused → running (resume): testbench.resume re-opens the stream from paused line', async () => {
    // Drive into paused state.
    void vscode.commands.executeCommand('testbench.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    await waitFor('running on line 9', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });
    await vscode.commands.executeCommand('testbench.pause');
    await waitFor('paused at 9', () => hooks.tracker.snapshot().breakpointStop === 9);
    await waitFor('idle while paused', () => !hooks.isRunning());

    // Resume — opens a new stream from line 9 with skipBreakpointAtStart.
    // Fire-and-forget: the command body awaits runLines() which awaits the
    // stream, so awaiting the command here would deadlock since this test
    // is the one feeding the stream events.
    void vscode.commands.executeCommand('testbench.resume');
    await waitFor('isRunning back to true', () => hooks.isRunning());
    await waitFor('new fake stream', () => fake.hasActiveStream);
    assert.equal(
      hooks.tracker.snapshot().breakpointStop,
      null,
      'Resume must clear the pause indicator',
    );

    fake.end();
    await waitFor('idle after resume completes', () => !hooks.isRunning());
  });

  it('running → paused (auto): hitting a breakpoint trims the run and reports pause', async () => {
    // Set a breakpoint on a later step (line 10 → "2. Click ...").
    const uri = vscode.window.activeTextEditor.document.uri;
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(9, 0)),
        true,
      ),
    ]);

    // Run from line 9, with the breakpoint on line 10. The runner should
    // execute step 9, then pause before step 10.
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(8, 0),
      new vscode.Position(9, 0),
    );

    void vscode.commands.executeCommand('testbench.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    // Note: the trim happens BEFORE the stream opens — the run-controller
    // calls trimAtBreakpoint on the classified step list. With a breakpoint
    // on line 10, the trimmed list is just line 9. The pause is published
    // before any stream events.
    await waitFor('breakpointStop is line 10', () => {
      return hooks.tracker.snapshot().breakpointStop === 10;
    });

    // Now drive line 9's events through the (single-step) stream.
    fake.push({ type: 'step:start', line: 9 });
    fake.push({ type: 'step:pass', line: 9 });
    fake.end();
    await waitFor('idle after trimmed run', () => !hooks.isRunning());
    // breakpointStop still set — Resume would pick up at 10.
    assert.equal(hooks.tracker.snapshot().breakpointStop, 10);
  });

  it('paused → idle (stop): Stop while paused clears the pause indicator', async () => {
    // Trigger a pause via breakpoint.
    const uri = vscode.window.activeTextEditor.document.uri;
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(8, 0)),
        true,
      ),
    ]);
    void vscode.commands.executeCommand('testbench.runSelected');
    await waitFor('paused at 9', () => hooks.tracker.snapshot().breakpointStop === 9);
    await waitFor('idle while paused', () => !hooks.isRunning());

    await vscode.commands.executeCommand('testbench.stop');
    await waitFor('breakpointStop cleared', () => hooks.tracker.snapshot().breakpointStop === null);
    assert.equal(hooks.isRunning(), false);
  });
});

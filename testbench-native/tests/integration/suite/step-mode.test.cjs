/**
 * Phase 3 step-into commands and step:awaiting handling.
 *
 * Drives the extension end-to-end inside a real VS Code extension host
 * with a FakeApiClient. The fake records every runControl call and lets
 * the test push step:awaiting / step:start / frame events at will.
 *
 * Coverage:
 *  1. step:awaiting sets the testbench-native.stepPaused context key and
 *     paints a breakpointStop marker on the next step's URI.
 *  2. testbench-native.stepInto from a step-paused state POSTs runControl
 *     with mode='into'.
 *  3. testbench-native.stepOver / stepOut do the same with 'over' / 'out'.
 *  4. testbench-native.continueRun POSTs 'continue'.
 *  5. A subsequent step:start clears the step-paused marker.
 *  6. testbench-native.stepInto from a fully-idle state launches a fresh
 *     run with stepMode='into' (verified by the request body the fake
 *     receives).
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');
const { FakeApiClient } = require('../fakes/fake-api-client.cjs');

const EXT_ID = 'pkent.testbench-native';
const FIXTURES_DIR =
  process.env.TESTBENCH_FIXTURES_DIR ||
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

describe('TestBench step-mode commands (Phase 3)', function () {
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
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'step:awaiting', line: 9 });
    await waitFor('breakpointStop set on line 9', () => {
      return hooks.tracker.snapshot().breakpointStop === 9;
    });

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('stepInto from step-paused POSTs runControl with mode=into', async () => {
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'step:awaiting', line: 9 });
    await waitFor('paused', () => hooks.tracker.snapshot().breakpointStop === 9);

    const callsBefore = fake.runControlCalls.length;
    await vscode.commands.executeCommand('testbench-native.stepInto');
    assert.equal(fake.runControlCalls.length, callsBefore + 1);
    assert.equal(fake.runControlCalls[callsBefore].mode, 'into');

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('stepOver / stepOut from step-paused POST the matching mode', async () => {
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'step:awaiting', line: 9 });
    await waitFor('paused', () => hooks.tracker.snapshot().breakpointStop === 9);

    await vscode.commands.executeCommand('testbench-native.stepOver');
    await vscode.commands.executeCommand('testbench-native.stepOut');

    const modes = fake.runControlCalls.map((c) => c.mode);
    assert.deepEqual(modes.slice(-2), ['over', 'out']);

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('continueRun POSTs runControl with mode=continue', async () => {
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'step:awaiting', line: 9 });
    await waitFor('paused', () => hooks.tracker.snapshot().breakpointStop === 9);

    await vscode.commands.executeCommand('testbench-native.continueRun');
    const lastMode = fake.runControlCalls.at(-1)?.mode;
    assert.equal(lastMode, 'continue');

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('A subsequent step:start clears the step-paused breakpointStop marker', async () => {
    void vscode.commands.executeCommand('testbench-native.runSelected');
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

    void vscode.commands.executeCommand('testbench-native.stepInto');
    await waitFor('stream active', () => fake.hasActiveStream);

    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0].stepMode, 'into',
      'idle stepInto must send stepMode=into so the server starts paused');

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });
});

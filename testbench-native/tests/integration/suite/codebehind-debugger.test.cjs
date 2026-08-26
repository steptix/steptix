/**
 * Code-behind step-into dispatch (stories/codebehind-debugging.md §Flow 2).
 *
 * Coverage:
 *  1. F11 while step-paused on a plain (non-tool, non-skill) line sends
 *     runControl with `pauseAtNextCodeBehind: true` — the server decides
 *     whether the step actually has an entry.
 *  2. F11 while step-paused on a `[skill: ...]` line sends NEITHER debugger
 *     flag: it must keep meaning "pause on the skill's first step in the
 *     .md", not "jump into that step's code-behind".
 *
 * The tool-line branch (`pauseAtNextTool`) is pinned by
 * tool-debugger.test.cjs. The attach/ack halves can't run in this harness
 * (`vscode.debug.startDebugging` would really dial an inspector port); the
 * server side of the wire flow is covered by
 * tests/api-server-codebehind-debugger.test.ts.
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

describe('TestBench code-behind step-into dispatch', function () {
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
  });

  async function openFixture(name) {
    const uri = fixtureUri(name);
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('fixture active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === uri.toString();
    });
    await waitFor('active file detected', () => hooks.tracker.snapshot().isTestFile);
    return vscode.window.activeTextEditor;
  }

  it('F11 while step-paused on a plain line sends pauseAtNextCodeBehind=true', async () => {
    const editor = await openFixture('test-with-tool.md');
    editor.selection = new vscode.Selection(
      new vscode.Position(7, 0),
      new vscode.Position(7, 5),
    );

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    // Park the yellow ▶ on line 8 — the plain navigate step.
    fake.push({ type: 'step:awaiting', line: 8 });
    await waitFor('step-paused', () => hooks.isStepPaused());

    await vscode.commands.executeCommand('testbench-native.stepInto');
    await waitFor('runControl recorded', () => fake.runControlCalls.length > 0);

    const call = fake.runControlCalls[0];
    assert.equal(call.mode, 'into');
    assert.deepEqual(call.opts, { pauseAtNextCodeBehind: true });

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('F11 while step-paused on a [skill:] line sends neither debugger flag', async () => {
    const editor = await openFixture('test-shared-a.md');
    editor.selection = new vscode.Selection(
      new vscode.Position(7, 0),
      new vscode.Position(7, 5),
    );

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    // Park on line 8 — `[skill: shared_skill] run the shared skill`.
    fake.push({ type: 'step:awaiting', line: 8 });
    await waitFor('step-paused', () => hooks.isStepPaused());

    await vscode.commands.executeCommand('testbench-native.stepInto');
    await waitFor('runControl recorded', () => fake.runControlCalls.length > 0);

    const call = fake.runControlCalls[0];
    assert.equal(call.mode, 'into');
    assert.ok(
      call.opts === null ||
        (!call.opts.pauseAtNextTool && !call.opts.pauseAtNextCodeBehind),
      `expected no debugger flags on a skill line, got ${JSON.stringify(call.opts)}`,
    );

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });
});

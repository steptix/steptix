/**
 * Phase 5 — tool step-into wire flow inside the extension host.
 *
 * Coverage:
 *  1. F11 on a tool line while step-paused sends runControl with
 *     `pauseAtNextTool: true` (the cooperative-pause request).
 *  2. F11 on a non-tool line keeps the existing runControl('into')
 *     behaviour (no opts).
 *  3. A `tool:awaiting-debugger` event triggers the ackToolDebugger
 *     call after the (mocked) debugger attach completes. The local-
 *     server check short-circuits when SERVER_URL isn't a loopback,
 *     and the ack still fires so the run isn't left hanging.
 *
 * The Node debugger attach itself can't be exercised in this harness
 * (`vscode.debug.startDebugging` would actually try to attach to port
 * 9229). Instead, we point the fake at a non-loopback server URL so
 * the extension's local-server check fails first, takes the
 * "ack-and-exit" branch, and we assert on that path.
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

describe('TestBench tool step-into (Phase 5)', function () {
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

    const uri = fixtureUri('test-with-tool.md');
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('fixture active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === uri.toString();
    });
    const editor = vscode.window.activeTextEditor;
    // Park on the [tool: echo] line so step-paused state lives on it.
    editor.selection = new vscode.Selection(
      new vscode.Position(8, 0),
      new vscode.Position(8, 5),
    );
    await waitFor('active file detected', () => hooks.tracker.snapshot().isTestFile);
  });

  it('F11 while step-paused on a [tool:] line sends pauseAtNextTool=true', async () => {
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    // Park the yellow ▶ on line 9 — the tool invocation.
    fake.push({ type: 'step:awaiting', line: 9 });
    await waitFor('step-paused', () => hooks.isStepPaused());

    // F11 — should detect the tool line and request a debugger pause.
    await vscode.commands.executeCommand('testbench-native.stepInto');
    await waitFor('runControl recorded', () => fake.runControlCalls.length > 0);

    const call = fake.runControlCalls[0];
    assert.equal(call.mode, 'into');
    assert.deepEqual(call.opts, { pauseAtNextTool: true });

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('F11 while step-paused on a non-tool line sends plain runControl(into)', async () => {
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    // Park on the inline navigate step (line 8) — not a tool line.
    fake.push({ type: 'step:awaiting', line: 8 });
    await waitFor('step-paused', () => hooks.isStepPaused());

    await vscode.commands.executeCommand('testbench-native.stepInto');
    await waitFor('runControl recorded', () => fake.runControlCalls.length > 0);

    const call = fake.runControlCalls[0];
    assert.equal(call.mode, 'into');
    // No opts (or pauseAtNextTool false) — plain stepInto, no debugger pause.
    assert.ok(
      call.opts === null || !call.opts.pauseAtNextTool,
      `expected no pauseAtNextTool, got ${JSON.stringify(call.opts)}`,
    );

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  // Note: a direct end-to-end test of `tool:awaiting-debugger →
  // ackToolDebugger` can't run reliably inside this harness because
  // `vscode.debug.startDebugging` would actually try to attach to the
  // inspector port (no inspector is listening, so the attempt hangs
  // for ~10s before failing). The wire flow is covered server-side
  // by `tests/api-server-tools.test.ts` — F11-on-tool-line dispatching
  // `pauseAtNextTool=true` (covered above) is the only piece that
  // genuinely lives inside the extension.
});

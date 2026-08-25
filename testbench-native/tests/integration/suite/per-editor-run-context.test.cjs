/**
 * The run-state context keys describe the ACTIVE EDITOR's document.
 *
 * They used to describe the window: one global `testbench-native.running`,
 * set "trust the caller" by every run command's `notifyRunning(true)` /
 * `.finally(notifyRunning(false))` pair. With one test open that is
 * indistinguishable from per-document. With two it is wrong in both
 * directions, and the user hit both:
 *
 *   - test1 running, test2 also running, Stop test2 -> test2's `.finally`
 *     slams the global key false while test1 is still running. Switch back to
 *     test1 and its Stop and Pause are gone, Run is showing, for the rest of
 *     its run - nothing recomputed on an editor change.
 *   - only test2 running, test1 active -> the global key is true, so test1
 *     offers Stop and Pause for a run it does not own. Stop acts on the
 *     ACTIVE document's controller, so pressing it did nothing at all.
 *
 * `hooks.runningContextValue()` is the only handle on the key: VS Code does
 * not expose context keys for reading, so the registry mirrors what it last
 * pushed.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { FakeApiClient } = require('../fakes/fake-api-client.cjs');

const EXT_ID = 'pkent.testbench-native';
const FIXTURES_DIR =
  process.env.TESTBENCH_FIXTURES_DIR || path.resolve(__dirname, '..', 'fixtures');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {
      /* transient */
    }
    await sleep(50);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

const DOC = (title) =>
  [
    '---',
    'tags: [ctx]',
    '---',
    '',
    `# ${title}`,
    '',
    '## Steps',
    '1. Open the page',
    '2. Check it',
    '',
  ].join('\n');

describe('TestBench run-state context keys follow the active editor', function () {
  this.timeout(30_000);

  let hooks;
  let fake;
  let path1;
  let path2;
  let uri1;
  let uri2;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks not exposed');
  });

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fake = new FakeApiClient();
    hooks.setApiClientFactory(() => fake);
    path1 = path.resolve(FIXTURES_DIR, 'ctx-doc1.md');
    path2 = path.resolve(FIXTURES_DIR, 'ctx-doc2.md');
    fs.writeFileSync(path1, DOC('Doc one'), 'utf-8');
    fs.writeFileSync(path2, DOC('Doc two'), 'utf-8');
    uri1 = vscode.Uri.file(path1);
    uri2 = vscode.Uri.file(path2);
  });

  afterEach(async () => {
    // Leave nothing running: a stream held open would pin the next test's key.
    // `endAll`, not `end` — these tests run TWO documents at once and `end`
    // reaches only the most recent stream.
    fake.endAll();
    await sleep(200);
    fs.rmSync(path1, { force: true });
    fs.rmSync(path2, { force: true });
  });

  /** Open a document and wait until TestBench owns it. */
  async function focus(uri) {
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor(
      `${path.basename(uri.fsPath)} active`,
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
    );
    await waitFor('detected as test file', () => hooks.tracker.snapshot().isTestFile === true);
  }

  /** Start a run in the active document and wait for its stream to open. */
  async function startRun(streamCount) {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream opened', () => fake.streamCallCount === streamCount);
  }

  it('stopping one running test leaves the other test its Stop button', async () => {
    await focus(uri1);
    await startRun(1);
    assert.equal(hooks.runningContextValue(), true, 'doc1 is running and active');

    // Switch to doc2 and run it too. Both are now running.
    await focus(uri2);
    await startRun(2);
    assert.equal(hooks.runningContextValue(), true, 'doc2 is running and active');

    // Stop doc2 - this is the `.finally(notifyRunning(false))` that used to
    // slam the global key false for the whole window.
    await vscode.commands.executeCommand('testbench-native.stop');
    await waitFor('key false on the stopped document', () => hooks.runningContextValue() === false);

    // Back to doc1, which never stopped. This is the broken step: its Stop
    // and Pause were gone for the rest of its run.
    await focus(uri1);
    await waitFor('key recomputed for doc1', () => hooks.runningContextValue() === true);

    // ...and when doc1's own run ends, the key drops.
    fake.endAt(0);
    await waitFor('doc1 finished', () => hooks.runningContextValue() === false, 10_000);
  });

  it('a document that is not running offers no Stop', async () => {
    // Only doc2 runs. Sitting on doc1, the old global key was true and doc1's
    // toolbar showed Stop and Pause for a run it did not own.
    await focus(uri2);
    await startRun(1);
    assert.equal(hooks.runningContextValue(), true);

    await focus(uri1);
    await waitFor('key false on the idle document', () => hooks.runningContextValue() === false);

    // Switching back to the running one turns them on again.
    await focus(uri2);
    await waitFor('key true again on the running document', () => hooks.runningContextValue() === true);

    fake.end();
    await waitFor('idle', () => hooks.runningContextValue() === false);
  });

  it('switching away from and back to one running test tracks the active editor', async () => {
    await focus(uri1);
    await startRun(1);
    assert.equal(hooks.runningContextValue(), true);

    await focus(uri2);
    await waitFor('away then false', () => hooks.runningContextValue() === false);

    await focus(uri1);
    await waitFor('back then true', () => hooks.runningContextValue() === true);

    fake.end();
    await waitFor('idle', () => hooks.runningContextValue() === false);
  });

  it('the leading edge still fires synchronously, before the first run event', async () => {
    // The race the trust-the-caller design existed for: `notifyRunning(true)`
    // runs BEFORE `controller.runLines()` sets `controller.active`, so a pure
    // poll would read "not running" and hide Pause until the first event.
    // Retiring the trailing edge must not retire this.
    await focus(uri1);
    void vscode.commands.executeCommand('testbench-native.runAll');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(
      hooks.runningContextValue(),
      true,
      'the key must be true the moment the run command fires, not after the first stream event',
    );

    await waitFor('stream opened', () => fake.hasActiveStream);
    fake.end();
    await waitFor('idle', () => hooks.runningContextValue() === false);
  });

  it('records what the key was set to, not what a caller asked for', async () => {
    // doc2's exit asks for false while doc1 is still running and active. The
    // history is the thing under test, so it must show what happened to the
    // key rather than what the exiting run requested.
    await focus(uri1);
    await startRun(1);
    await focus(uri2);
    await startRun(2);
    await focus(uri1);
    await waitFor('true for doc1', () => hooks.runningContextValue() === true);

    const before = hooks.notifyRunningHistory().length;
    // End doc2's stream (the second one opened) while doc1 keeps running.
    fake.endAt(1);
    await sleep(400);
    const added = hooks.notifyRunningHistory().slice(before);
    assert.ok(
      added.every((v) => v === true),
      `doc1 is still running, so no false may be recorded; got ${JSON.stringify(added)}`,
    );
    assert.equal(hooks.runningContextValue(), true, 'doc1 is still running');
  });
});

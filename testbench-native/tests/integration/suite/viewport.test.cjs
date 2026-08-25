/**
 * Per-test viewport, client half (stories/per-test-viewport.md §5) — driven
 * through a real VS Code extension host with a FakeApiClient.
 *
 * Two behaviours, and the second is the reason this file exists rather than a
 * unit test:
 *
 *   1. FORWARDING. `## Config: viewport:` reaches the step request's `config`
 *      block as the RAW authored string, beside `baseUrl` (§3). The client
 *      resolves nothing — presets and validation are the server's.
 *
 *   2. RECYCLE-ON-CHANGE. `config` is write-once per session, so an edited
 *      viewport can only take effect if the client CLOSES the live session
 *      first. That ordering (close, then open the next stream) is the whole
 *      contract, and it spans the run controller's session bookkeeping — the
 *      one thing a pure unit test of the decision (tests/viewport-recycle.test.js)
 *      cannot observe. Here it is asserted directly: every closeSession call
 *      records how many streams had been opened when it fired, so a close
 *      "between run 1 and run 2" is a fact, not an inference from ordering.
 *
 * The unchanged-value case is asserted just as hard, because a needless
 * restart is a real cost: the session's browser holds the signed-in state the
 * user is mid-way through.
 *
 * Fixtures are written at runtime (`*.tmp.md`, like the batch suite) and one
 * per test — the RunController registry is keyed by URI and outlives an
 * individual `it`, so sharing a file would leak the previous test's
 * "which viewport did the live session get" into the next one.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { FakeApiClient } = require('../fakes/fake-api-client.cjs');

const EXT_ID = 'pkent.testbench-native';
const FIXTURES_DIR =
  process.env.TESTBENCH_FIXTURES_DIR || path.resolve(__dirname, '..', 'fixtures');
const fixtureUri = (name) => vscode.Uri.file(path.resolve(FIXTURES_DIR, name));

/** A test whose Config carries both keys, so the pair is seen to travel together. */
const fixtureText = (viewport) =>
  [
    '# Viewport fixture',
    '',
    '## Config',
    '- baseUrl: https://example.test/',
    `- viewport: ${viewport}`,
    '',
    '## Steps',
    '1. Navigate to https://example.test/',
    '2. Click the "Get started" button',
    '',
  ].join('\n');

/** One file per test (see the header). All are removed in `after`. */
const FIXTURES = {
  'viewport-forward.tmp.md': fixtureText('mobile'),
  'viewport-changed.tmp.md': fixtureText('mobile'),
  'viewport-unchanged.tmp.md': fixtureText('mobile'),
};

/** 0-based index of the first step line in the fixture above. */
const FIRST_STEP_LINE = 7;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {
      // transient predicate errors are part of the wait
    }
    await sleep(50);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

describe('TestBench per-test viewport', function () {
  this.timeout(30_000);

  /** @type {FakeApiClient} */
  let fake;
  /** @type {import('../../../dist/extension/extension').TestBenchTestHooks} */
  let hooks;
  /**
   * `streamCallCount` at the moment of each closeSession call. A `1` in here
   * is a close that happened after the first run's stream and before the
   * second's — i.e. the recycle.
   */
  let closesAtStream;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks not exposed — did activate() forget to return them?');
    for (const [name, text] of Object.entries(FIXTURES)) {
      fs.writeFileSync(path.resolve(FIXTURES_DIR, name), text);
    }
  });

  after(() => {
    for (const name of Object.keys(FIXTURES)) {
      fs.rmSync(path.resolve(FIXTURES_DIR, name), { force: true });
    }
  });

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fake = new FakeApiClient();
    closesAtStream = [];
    fake.closeSessionImpl = () => {
      closesAtStream.push(fake.streamCallCount);
    };
    hooks.setApiClientFactory(() => fake);
  });

  /** Open a fixture, make it the active editor, and select its first step. */
  async function openFixture(name) {
    const uri = fixtureUri(name);
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('fixture editor active', () => {
      const e = vscode.window.activeTextEditor;
      return e && e.document.uri.toString() === uri.toString();
    });
    await waitFor('active file detected as test file', () => hooks.tracker.snapshot().isTestFile === true);
    selectFirstStep();
    return uri;
  }

  /**
   * A range selection (not a bare cursor) — `runSelected` reads a cursor-only
   * "selection" as a request to run the whole test.
   */
  function selectFirstStep() {
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(FIRST_STEP_LINE, 0),
      new vscode.Position(FIRST_STEP_LINE, 5),
    );
  }

  /** Run the selected step to a clean finish. */
  async function runToCompletion(label) {
    const streamsBefore = fake.streamCallCount;
    selectFirstStep();
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor(`${label}: stream opened`, () => fake.streamCallCount > streamsBefore);
    fake.push({ type: 'step:pass', line: FIRST_STEP_LINE + 1 });
    fake.end();
    await waitFor(`${label}: run finished`, () => !hooks.isRunning());
  }

  /**
   * Rewrite the `- viewport:` line in the OPEN buffer and save, so the next
   * run reads the new value the way a user's edit would. Saved (not left
   * dirty) so the suite's `closeAllEditors` never hits a save prompt.
   */
  async function editViewportTo(uri, value) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const lineIndex = doc
      .getText()
      .split('\n')
      .findIndex((l) => l.startsWith('- viewport:'));
    assert.ok(lineIndex >= 0, 'fixture must have a viewport line to edit');
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, doc.lineAt(lineIndex).range, `- viewport: ${value}`);
    assert.ok(await vscode.workspace.applyEdit(edit), 'edit must apply');
    assert.ok(await doc.save(), 'edited fixture must save');
  }

  it('forwards the raw viewport string in the request config, beside baseUrl', async () => {
    await openFixture('viewport-forward.tmp.md');
    await runToCompletion('first run');

    const req = fake.requests[0];
    assert.ok(req, 'a streamSteps request should have been sent');
    assert.equal(
      req.config?.viewport,
      'mobile',
      'the preset name must travel verbatim — the server owns the resolver',
    );
    assert.equal(req.config?.baseUrl, 'https://example.test/', 'baseUrl must still travel');
  });

  it('a changed viewport closes the live session BEFORE the next run, which re-sends config', async () => {
    const uri = await openFixture('viewport-changed.tmp.md');
    await runToCompletion('first run');
    assert.equal(fake.requests[0]?.config?.viewport, 'mobile');

    await editViewportTo(uri, '768x1024');
    await runToCompletion('second run');

    assert.ok(
      closesAtStream.includes(1),
      `expected a close between the two runs; closes fired at stream counts [${closesAtStream.join(', ')}]`,
    );
    // And because the session is gone, the write-once block rides again — with
    // the new value. Without the recycle this request would carry no `config`
    // at all and the browser would still be 390px wide.
    const second = fake.requests[1];
    assert.ok(second, 'a second request should have been sent');
    assert.equal(second.config?.viewport, '768x1024', 'the fresh session must be told the new size');
    assert.equal(second.config?.baseUrl, 'https://example.test/');
  });

  it('an unchanged viewport reuses the session — no close, no repeated config', async () => {
    await openFixture('viewport-unchanged.tmp.md');
    await runToCompletion('first run');
    await runToCompletion('second run');

    assert.ok(
      !closesAtStream.includes(1),
      `the session must survive an unchanged viewport; closes fired at stream counts [${closesAtStream.join(', ')}]`,
    );
    // Write-once: re-sending `config` to the live session is what the server
    // refuses, so the second request must omit the block entirely.
    assert.equal(
      fake.requests[1]?.config,
      undefined,
      'config must not be re-sent to a session that already has it',
    );
  });
});

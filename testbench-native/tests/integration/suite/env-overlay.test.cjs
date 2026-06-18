/**
 * End-to-end coverage for the selected-env overlay (issue 034).
 *
 * The `## Parameters` `$VAR` resolution happens CLIENT-side, before the run is
 * sent. These tests drive a real run through the extension host with a
 * FakeApiClient and assert the resolved `parameters` that reach `streamSteps`:
 *
 *   1. With env `t2` selected, a var defined ONLY in `.env.t2` resolves (and
 *      the env is forwarded to the server as `envName`).
 *   2. With env `t2` selected but no `.env.t2` present, the run fails TB006 and
 *      never opens a stream.
 *   3. With no env selected, the `.env.t2`-only var falls through literally —
 *      proving the overlay is what makes (1) work.
 *
 * Fixtures: `fixtures/.env` (base — SERVER_URL/SERVER_API_KEY only),
 * `fixtures/.env.t2` (T2_ONLY + SHARED), `fixtures/env-overlay.md` (a test with
 * a `## Parameters` block referencing both).
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
// `.env.*` is gitignored, so (like the batch suite's `.tmp.md` fixtures) we
// write the overlay file at runtime rather than committing it. `.env.ghost`
// is deliberately NEVER created — that's the TB006 case.
const OVERLAY_PATH = path.join(FIXTURES_DIR, '.env.t2');
// A second overlay that overrides SERVER_URL/SERVER_API_KEY away from base —
// exercises option B (the lifecycle client follows the run's server).
const OVERLAY_T2B_PATH = path.join(FIXTURES_DIR, '.env.t2b');
const T2B_SERVER_URL = 'http://127.0.0.1:48484';
const T2B_API_KEY = 't2b-key';
// A nested test whose base `.env` is test-adjacent (deeper than the workspace
// root) — used to prove the overlay is read from the workspace root (where the
// selector enumerates), not from the base `.env`'s directory.
const SUB_DIR = path.join(FIXTURES_DIR, 'sub');
const SUB_BASE_ENV = path.join(SUB_DIR, '.env');
const SUB_MD = path.join(SUB_DIR, 'env-overlay-sub.md');
const SUB_ROOT_OVERLAY = path.join(FIXTURES_DIR, '.env.subenv');

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

/**
 * Set (or clear, with `undefined`) the active env. Writes to Global scope so it
 * lands in the throwaway test user-data dir rather than creating a
 * `fixtures/.vscode/settings.json` artifact in the repo.
 */
async function setActiveEnv(name) {
  await vscode.workspace
    .getConfiguration('testbench-native')
    .update('activeEnv', name, vscode.ConfigurationTarget.Global);
}

describe('TestBench env-file overlay (## Parameters honour the selected env)', function () {
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

    // SHARED is in both base .env and the overlay (overlay wins); T2_ONLY is
    // overlay-only. Base fixtures/.env holds just SERVER_URL/SERVER_API_KEY.
    fs.writeFileSync(OVERLAY_PATH, 'T2_ONLY=from-t2\nSHARED=from-t2-shared\n');
    // t2b additionally retargets the server, so a close/liveness client built
    // for it is distinguishable from one built for base .env.
    fs.writeFileSync(
      OVERLAY_T2B_PATH,
      `SERVER_URL=${T2B_SERVER_URL}\nSERVER_API_KEY=${T2B_API_KEY}\n`,
    );
    // Nested fixture: base `.env` sits in sub/ (walk-up finds it before the
    // root .env), while its overlay .env.subenv sits at the workspace root.
    fs.mkdirSync(SUB_DIR, { recursive: true });
    fs.writeFileSync(
      SUB_BASE_ENV,
      'SERVER_URL=http://127.0.0.1:39917\nSERVER_API_KEY=integration-test-key\n',
    );
    fs.writeFileSync(
      SUB_MD,
      '# Sub env overlay fixture\n\n## Parameters\n- token: $PARAM_FROM_ROOT\n- shared: $SHARED\n\n## Steps\n1. Use the {{token}} value\n2. Second step\n',
    );
    fs.writeFileSync(SUB_ROOT_OVERLAY, 'PARAM_FROM_ROOT=root-overlay\n');
  });

  after(() => {
    fs.rmSync(OVERLAY_PATH, { force: true });
    fs.rmSync(OVERLAY_T2B_PATH, { force: true });
    fs.rmSync(SUB_ROOT_OVERLAY, { force: true });
    fs.rmSync(SUB_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fake = new FakeApiClient();
    // Record the {serverUrl, apiKey} each client is built with so tests can
    // assert WHICH server the run vs. the lifecycle (close) client targeted.
    fake.factoryArgs = [];
    hooks.setApiClientFactory((opts) => {
      fake.factoryArgs.push(opts);
      return fake;
    });

    const uri = fixtureUri('env-overlay.md');
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('fixture editor active', () => {
      const e = vscode.window.activeTextEditor;
      return e && e.document.uri.toString() === uri.toString();
    });
    // Select step 1 (line 8, 0-based index 7) as a real range so runSelected
    // runs the test rather than expanding a cursor-only "selection" to runAll.
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(7, 0),
      new vscode.Position(7, 5),
    );
    await waitFor('active file detected as test file', () => hooks.tracker.snapshot().isTestFile === true);
  });

  afterEach(async () => {
    // Never leak the env selection into the other suites — a stale 'ghost'
    // would make every later run fail with TB006.
    await setActiveEnv(undefined);
  });

  it('resolves a $VAR defined only in .env.<name> when that env is selected', async () => {
    await setActiveEnv('t2');

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    const req = fake.requests[0];
    assert.ok(req, 'a streamSteps request should have been sent');
    assert.equal(
      req.parameters?.token,
      'from-t2',
      '$T2_ONLY (only in .env.t2) must resolve via the overlay',
    );
    assert.equal(
      req.parameters?.shared,
      'from-t2-shared',
      'overlay value must win for $SHARED',
    );
    // The same selected env is forwarded to the server for ${env.X}.
    assert.equal(req.envName, 't2', 'the selected env must be sent to the server too');

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('fails the run with TB006 (and opens no stream) when the selected .env.<name> is missing', async () => {
    await setActiveEnv('ghost'); // no .env.ghost beside the base .env

    void vscode.commands.executeCommand('testbench-native.runSelected');

    await waitFor('TB006 surfaces', () => hooks.lastRunError()?.code === 'TB006');
    assert.equal(fake.hasActiveStream, false, 'no stream may open when the overlay file is missing');
    assert.equal(fake.streamCallCount, 0, 'the run must not reach the server');
  });

  it('with no env selected, a .env.<name>-only $VAR does NOT resolve (overlay is what fixes it)', async () => {
    await setActiveEnv(undefined);

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    const req = fake.requests[0];
    assert.ok(req, 'a streamSteps request should have been sent');
    assert.equal(
      req.parameters?.token,
      '$T2_ONLY',
      'without the overlay, the .env.t2-only var falls through as the literal $VAR',
    );

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('option B — Close Session reuses the server the run used (.env.<name> SERVER_URL override), not the current selector', async () => {
    // Run under t2b, whose overlay retargets SERVER_URL to :48484.
    await setActiveEnv('t2b');

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    // The run client itself was built for the overridden server.
    const runArgs = fake.factoryArgs.at(-1);
    assert.equal(runArgs?.serverUrl, T2B_SERVER_URL, 'run must target the overlay SERVER_URL');
    assert.equal(runArgs?.apiKey, T2B_API_KEY, 'run must use the overlay SERVER_API_KEY');

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());

    // Clear the env selection. Option B must still build the close client for
    // the RUN's server (cached lastRunServerUrl), not re-resolve base .env
    // (:39917) nor re-overlay the now-empty selector. Without option B the
    // close would target base .env and miss the t2b session.
    await setActiveEnv(undefined);
    const before = fake.factoryArgs.length;

    await vscode.commands.executeCommand('testbench-native.restartSession');
    await waitFor('close client built', () => fake.factoryArgs.length > before);

    const closeArgs = fake.factoryArgs.at(-1);
    assert.equal(
      closeArgs?.serverUrl,
      T2B_SERVER_URL,
      'Close Session must reuse the run’s server (option B), not base .env',
    );
    assert.equal(closeArgs?.apiKey, T2B_API_KEY, 'and the run’s API key');
    assert.ok(fake.closeSessionCalls > 0, 'closeSession must have actually fired');
  });

  it('reads the overlay from the workspace root even when base .env is test-adjacent (deeper than root)', async () => {
    // base .env resolves to sub/.env via walk-up; the overlay .env.subenv lives
    // at the workspace root, where the selector enumerated it. The overlay must
    // be read from the root, not next to sub/.env (which has no .env.subenv).
    await setActiveEnv('subenv');

    const uri = vscode.Uri.file(SUB_MD);
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('sub fixture active', () => {
      const e = vscode.window.activeTextEditor;
      return e && e.document.uri.toString() === uri.toString();
    });
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(7, 0),
      new vscode.Position(7, 5),
    );
    await waitFor('sub file is a test file', () => hooks.tracker.snapshot().isTestFile === true);

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    const req = fake.requests[0];
    assert.ok(req, 'a streamSteps request should have been sent');
    assert.equal(
      req.parameters?.token,
      'root-overlay',
      'overlay must be read from the workspace root (where the selector found it), not next to the test-adjacent base .env',
    );

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });
});

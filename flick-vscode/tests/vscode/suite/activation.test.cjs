// Real-VS-Code smoke tests. Loads the actual extension and asserts the
// surfaces (extension API export, command registry, configuration) all
// resolve. Catches activation crashes that bypass the controller-level
// node:test suite — for example a bad import, a missing icon path, or
// a runtime error in extension.ts' top-level code.
const assert = require('node:assert/strict');
const vscode = require('vscode');

const EXT_ID = 'pkent.flick-vscode';
const EXPECTED_COMMANDS = [
  'flick.open',
  'flick.openSidebar',
  'flick.newSession',
  'flick.openSettings',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {
      // ignore transient predicate errors
    }
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${label}`);
}

describe('Flick extension — activation smoke', function () {
  this.timeout(20_000);

  it('extension is present and activates without throwing', async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not found in the test host`);
    if (!ext.isActive) await ext.activate();
    assert.ok(ext.isActive, 'extension failed to activate');
  });

  it('exposes __testHooks with the controller and dispatch fns', async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, 'extension missing');
    if (!ext.isActive) await ext.activate();
    const hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks not exposed by activate()');
    assert.ok(hooks.controller, '__testHooks.controller missing');
    assert.equal(typeof hooks.dispatch, 'function');
    assert.equal(typeof hooks.webviews, 'function');
    assert.equal(typeof hooks.waitFor, 'function');
  });

  it('registers every contributed command', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const cmd of EXPECTED_COMMANDS) {
      assert.ok(all.includes(cmd), `command ${cmd} not registered`);
    }
  });

  it('flick.newSession command creates a session on the controller', async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    if (!ext.isActive) await ext.activate();
    const hooks = ext.exports.__testHooks;
    const before = hooks.controller.__testSessions.length;
    await vscode.commands.executeCommand('flick.newSession');
    await waitFor(
      'session count to grow',
      () => hooks.controller.__testSessions.length === before + 1,
    );
    const last =
      hooks.controller.__testSessions[hooks.controller.__testSessions.length - 1];
    assert.equal(last.used, false, 'fresh sessions start with used:false');
    assert.equal(typeof last.id, 'string');
    assert.ok(last.id.length > 0);
  });

  it('opening the sidebar attaches a webview to the controller', async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    if (!ext.isActive) await ext.activate();
    const hooks = ext.exports.__testHooks;
    // 1.95+ has the secondary side bar variant; VS Code routes the focus
    // command to whichever view is active per the `when` clauses in
    // package.json.
    await vscode.commands.executeCommand('flick.openSidebar');
    await waitFor(
      'at least one webview attached after opening the sidebar',
      () => hooks.webviews().length > 0,
      8_000,
    );
    assert.ok(hooks.webviews().length > 0);
  });

  it('configuration defaults match the package.json contributions', () => {
    const cfg = vscode.workspace.getConfiguration('flick');
    assert.equal(cfg.get('apiUrl'), 'http://127.0.0.1:3100');
    assert.equal(cfg.get('apiKey'), '');
    assert.equal(cfg.get('defaultBaseUrl'), '');
    assert.equal(cfg.get('defaultTimeout'), '');
  });
});

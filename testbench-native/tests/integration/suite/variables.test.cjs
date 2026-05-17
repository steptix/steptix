/**
 * Phase 4 — frame:scope events drive the controller's per-frame scope map
 * and (via the registry bridge) the Variables view.
 *
 * Coverage:
 *   1. frame:scope payload lands on the controller's scope-for-frame
 *      map, exposed via hooks.runningScope().
 *   2. The "current scope" tracks the top frame after frame:push.
 *   3. resetFrameState (called at run start) wipes scopes so a fresh
 *      run never inherits leftover variables.
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

describe('TestBench Variables panel (Phase 4)', function () {
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
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(8, 0),
      new vscode.Position(8, 5),
    );
    await waitFor('active file detected', () => hooks.tracker.snapshot().isTestFile);
  });

  it('frame:scope at the test frame lands on runningScope', async () => {
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({
      type: 'frame:scope',
      frameId: '',
      scope: { username: 'alice', target_url: 'https://example.com' },
    });
    await waitFor('scope updated', () => {
      const scope = hooks.runningScope();
      return scope.username === 'alice' && scope.target_url === 'https://example.com';
    });

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('currentScope tracks the top frame after frame:push', async () => {
    const frame = {
      id: 'f1',
      parentId: null,
      kind: 'skill',
      uri: path.resolve(FIXTURES_DIR, 'fake-skill.md'),
      line: 9,
      skillName: 'fake_skill',
    };
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    // Test-frame scope first.
    fake.push({ type: 'frame:scope', frameId: '', scope: { caller_var: 'outer' } });
    await waitFor('test scope', () => hooks.runningScope().caller_var === 'outer');

    // Descend into skill, push a different scope for it.
    fake.push({ type: 'frame:push', frame });
    fake.push({
      type: 'frame:scope',
      frameId: 'f1',
      scope: { __skill1_internal: 'inside', caller_var: 'outer' },
    });
    await waitFor('skill scope active', () => {
      const scope = hooks.runningScope();
      return scope.__skill1_internal === 'inside';
    });

    // Returning to the test frame: currentScope falls back to test-frame
    // scope (last test-frame scope still in the per-frame map).
    fake.push({ type: 'frame:pop', frameId: 'f1', outputs: {} });
    await waitFor('back to test scope', () => {
      const scope = hooks.runningScope();
      return scope.caller_var === 'outer' && !('__skill1_internal' in scope);
    });

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('skill input parameters arrive in the Variables view at a breakpoint pause', async () => {
    // Phase 5 follow-up — end-to-end proof for the
    // skill-inputs-in-frame-scope fix. Mimics what the server does
    // when a `[skill: parameterized_skill query="OpenAI GPT-5"]`
    // call is paused on the skill's first step via a breakpoint:
    //
    //   1. frame:push for the skill frame
    //   2. frame:scope carrying { query: 'OpenAI GPT-5', ... }
    //   3. step:awaiting (the pause)
    //
    // After that, the Variables view's rendered items must contain
    // `query` mapped to "OpenAI GPT-5". This proves the WHOLE stack
    // (runController.handleFrameScope → scopesByFrame map →
    // currentScope → VariablesTreeProvider.getChildren → rendered
    // TreeItem) carries the input through. Without this test, the
    // wire-level vitest could pass and the user could still see an
    // empty view because the extension dropped or filtered the data.
    const frame = {
      id: 'f1',
      parentId: null,
      kind: 'skill',
      uri: path.resolve(FIXTURES_DIR, 'fake-skill.md'),
      line: 7,
      skillName: 'parameterized_skill',
    };
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'frame:push', frame });
    fake.push({
      type: 'frame:scope',
      frameId: 'f1',
      scope: { query: 'OpenAI GPT-5' },
    });
    fake.push({ type: 'step:awaiting', line: 7, frame });

    await waitFor('skill scope active', () => {
      const scope = hooks.runningScope();
      return scope.query === 'OpenAI GPT-5';
    });

    // The actual user-visible assertion: the Variables view's
    // rendered items show `query = "OpenAI GPT-5"`.
    const items = hooks.variablesViewItems();
    const byName = Object.fromEntries(items.map((i) => [i.name, i.description]));
    assert.equal(
      byName.query,
      'OpenAI GPT-5',
      `expected query to render with caller-supplied value; got items: ${JSON.stringify(items)}`,
    );

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('secret-named entries are masked in the rendered view', async () => {
    // Phase 4.1.c — the integration tests at the runningScope layer
    // (above) verify the controller's state, but not that the VIEW
    // actually applies maskIfSecret. A future refactor that bypassed
    // maskIfSecret in the render path would slip through silently.
    // This test exercises the rendered TreeItem descriptions directly.
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({
      type: 'frame:scope',
      frameId: '',
      scope: {
        username: 'alice',
        token: 'sk-supersecret-12345',
        api_key: 'pk-pretendkey',
      },
    });
    await waitFor('scope arrived', () => hooks.runningScope().username === 'alice');

    const items = hooks.variablesViewItems();
    const byName = Object.fromEntries(items.map((i) => [i.name, i.description]));
    assert.equal(byName.username, 'alice', 'non-secret values render unmasked');
    assert.notEqual(byName.token, 'sk-supersecret-12345',
      'secret-named values must NOT render with their raw value');
    assert.notEqual(byName.api_key, 'pk-pretendkey',
      'secret-named values must NOT render with their raw value');
    // The runner-core maskIfSecret helper renders some replacement
    // form for masked values; the exact format is its concern, but it
    // must not be the raw value.
    assert.ok(byName.token && byName.token.length > 0, 'masked entries still show *something*');

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('test-frame view hides __skillN_ entries from previous skill descents', async () => {
    // Phase 4.1.b — after a skill exits, its internal vars survive in
    // resolvedParameters (the expander never garbage-collects them).
    // The view filters them out when rendering the test (root) frame
    // so the user doesn't see noise like `__skill1_query` lingering
    // after the skill returned.
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({
      type: 'frame:scope',
      frameId: '',
      scope: {
        username: 'alice',
        target_url: 'https://example.com',
        __skill1_query: 'OpenAI GPT-5',
        __skill1_first_result_url: 'https://example.com',
      },
    });
    await waitFor('scope arrived', () =>
      hooks.runningScope().username === 'alice',
    );

    const items = hooks.variablesViewItems();
    const names = items.map((i) => i.name);
    assert.ok(names.includes('username'), 'caller vars must be visible');
    assert.ok(names.includes('target_url'), 'caller vars must be visible');
    assert.ok(
      !names.includes('__skill1_query'),
      '__skillN_ entries must NOT appear in the test-frame view',
    );
    assert.ok(
      !names.includes('__skill1_first_result_url'),
      '__skillN_ entries must NOT appear in the test-frame view',
    );

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('skill-frame view shows __skillN_ entries (they are the skill local)', async () => {
    // Counter-test to 4.1.b — when execution is inside a skill, the
    // namespaced names ARE the user's locals (rewritten for isolation)
    // so the view must NOT filter them.
    const frame = {
      id: 'f1',
      parentId: null,
      kind: 'skill',
      uri: path.resolve(FIXTURES_DIR, 'fake-skill.md'),
      line: 9,
      skillName: 'fake_skill',
    };
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'frame:push', frame });
    fake.push({
      type: 'frame:scope',
      frameId: 'f1',
      scope: {
        __skill1_query: 'OpenAI GPT-5',
        username: 'alice',
      },
    });
    await waitFor('skill scope', () => hooks.runningScope().__skill1_query === 'OpenAI GPT-5');

    const items = hooks.variablesViewItems();
    const names = items.map((i) => i.name);
    assert.ok(names.includes('__skill1_query'),
      '__skillN_ entries must be visible when inside a skill frame');

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('a fresh run wipes scope state from the previous run', async () => {
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream 1 active', () => fake.hasActiveStream);
    fake.push({
      type: 'frame:scope',
      frameId: '',
      scope: { stale: 'value' },
    });
    await waitFor('first scope', () => hooks.runningScope().stale === 'value');
    fake.end();
    await waitFor('idle after run 1', () => !hooks.isRunning());

    // Second run — resetFrameState fires at the top of runLines and
    // wipes the per-frame scope map.
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream 2 active', () => fake.hasActiveStream);
    // Before any frame:scope arrives the new run, the scope must be
    // empty — not leftover 'stale'.
    const scope = hooks.runningScope();
    assert.equal(scope.stale, undefined, 'stale variable from a previous run must not survive resetFrameState');

    fake.end();
    await waitFor('idle after run 2', () => !hooks.isRunning());
  });
});

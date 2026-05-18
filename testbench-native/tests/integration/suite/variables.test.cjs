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

  it('skill input parameter remains visible in the WEBVIEW Variables across MULTIPLE breakpoints inside the skill', async () => {
    // Regression test for the bug the previous (TreeView-only) test
    // missed: the Test Runner sidebar webview has its OWN Variables
    // section that renders from the active editor's parsed
    // `## Parameters` declarations overlaid with a `runtimeVariables`
    // map. Before the fix, that map ignored `frame:scope` events, so
    // when the active editor was the skill `.md` (where
    // `## Parameters` uses `- name: description` syntax) the webview
    // fell back to the description text — making it look like the
    // caller's value wasn't being passed in.
    //
    // The test:
    //   - opens fake-skill.md as the active editor (mirroring the
    //     auto-revealed state when a run pauses inside the skill)
    //   - starts a run on test-with-steps.md (controller's document)
    //   - pushes 3 step:awaiting cycles, each preceded by a
    //     `frame:scope` event carrying { query: "OpenAI GPT-5" }
    //   - at EVERY pause, asserts the WEBVIEW's runtimeVariables
    //     map shows `query = "OpenAI GPT-5"` — not the
    //     "the search term to enter" description text the skill's
    //     `## Parameters` section literally declares.
    //
    // This proves the fix at the data-flow layer the user actually
    // sees: webview → React state → frame:scope handler → rendered
    // Variables panel.

    const skillUri = fixtureUri('fake-skill.md');
    const skillPath = skillUri.fsPath;
    const frame = {
      id: 'f1',
      parentId: null,
      kind: 'skill',
      uri: skillPath,
      line: 8,
      skillName: 'fake_skill',
    };

    // Confirm the precondition: the skill file declares `query`
    // with description-as-value. If a future edit to the fixture
    // changes this, the test stops proving what it claims to prove.
    const fs = require('node:fs');
    const skillText = fs.readFileSync(skillPath, 'utf-8');
    assert.match(
      skillText,
      /- query:\s*the search term to enter/,
      'fixture must declare `- query: the search term to enter` so the description-text fallback is the failure mode',
    );

    // Force the Test Runner sidebar to open so the webview is mounted
    // and our `webviewState` round-trip works. Without this the
    // webview isn't attached at all and posts never flow.
    await vscode.commands.executeCommand('testbench-native.runner.focus');
    await waitFor(
      'webview mounted and posting state (count > 0)',
      () => hooks.webviewStateUpdateCount() > 0,
      8_000,
    );

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    // Auto-reveal: switch active editor to the skill file so the
    // webview snapshot reflects it. The bug only fires when the
    // active file is the skill (because that's what the webview
    // parses for declared parameters).
    await vscode.commands.executeCommand('vscode.open', skillUri);
    await waitFor(
      'skill is active in webview',
      () => hooks.tracker.snapshot().filePath === skillPath,
    );

    // Push the frame:push + initial entry scope (mirrors what the
    // post-fix server emits in real life).
    fake.push({ type: 'frame:push', frame });
    fake.push({
      type: 'frame:scope',
      frameId: 'f1',
      scope: { query: 'OpenAI GPT-5' },
    });

    // Helper — wait until the webview has received the latest scope
    // event AND posted its updated runtimeVariables back. Polls
    // the test hook (postWebviewState fires asynchronously after a
    // React render, so we need to wait for the round trip).
    const waitForWebviewQuery = async (expected, label) => {
      await waitFor(
        `webview runtimeVariables.query === "${expected}" (${label})`,
        () => hooks.webviewRuntimeVariables().query === expected,
        4_000,
      );
    };

    // ── Breakpoint 1: pause before step 1 of the skill body ──
    fake.push({ type: 'step:awaiting', line: 8, frame });
    await waitForWebviewQuery('OpenAI GPT-5', 'pause #1 — before skill step 1');

    // User "Continues" → server proceeds. Mirror what the server
    // emits: step:start, step:pass, frame:scope (still carrying
    // query thanks to the frameInputs overlay in commit 3344a69),
    // then the next pause.
    fake.push({ type: 'step:start', line: 8, frame });
    fake.push({ type: 'step:pass', line: 8, frame });
    fake.push({
      type: 'frame:scope',
      frameId: 'f1',
      // Server's post-step scope: resolvedParameters overlaid with
      // frameInputs[f1]. After step 1 the only addition might be
      // a captured output, but we mimic the "param survived" case
      // explicitly — that's the whole point of the per-step
      // overlay fix in 3344a69.
      scope: { query: 'OpenAI GPT-5' },
    });

    // ── Breakpoint 2: pause before step 2 ──
    fake.push({ type: 'step:awaiting', line: 9, frame });
    await waitForWebviewQuery('OpenAI GPT-5', 'pause #2 — before skill step 2');

    fake.push({ type: 'step:start', line: 9, frame });
    fake.push({ type: 'step:pass', line: 9, frame });
    fake.push({
      type: 'frame:scope',
      frameId: 'f1',
      scope: { query: 'OpenAI GPT-5' },
    });

    // ── Breakpoint 3: pause before step 3 ──
    fake.push({ type: 'step:awaiting', line: 10, frame });
    await waitForWebviewQuery('OpenAI GPT-5', 'pause #3 — before skill step 3');

    // Sanity: NOT the description text at any point. If a future
    // regression dropped frame:scope handling in the webview, this
    // would be `"the search term to enter"`.
    const finalState = hooks.webviewRuntimeVariables();
    assert.notEqual(
      finalState.query,
      'the search term to enter',
      'webview must never show the description text once frame:scope has overridden it',
    );

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('skill input parameter remains visible across Step Over commands at every breakpoint', async () => {
    // Variant of the previous test that exercises the ACTUAL Step
    // Over command at each pause boundary — not just synthetic event
    // pushes that mimic what Continue would produce. Catches a
    // regression where the variable IS preserved across Continue
    // boundaries but NOT across stepOver, or vice versa, or where the
    // stepOver command itself fails to dispatch the right mode.
    //
    // At each step:awaiting: assert query is visible, then call
    // testbench-native.stepOver, then verify the fake recorded a
    // runControl('over') AND query is STILL visible after the next
    // frame:scope arrives.

    const skillUri = fixtureUri('fake-skill.md');
    const skillPath = skillUri.fsPath;
    const frame = {
      id: 'f1',
      parentId: null,
      kind: 'skill',
      uri: skillPath,
      line: 8,
      skillName: 'fake_skill',
    };

    await vscode.commands.executeCommand('testbench-native.runner.focus');
    await waitFor(
      'webview mounted',
      () => hooks.webviewStateUpdateCount() > 0,
      8_000,
    );

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    await vscode.commands.executeCommand('vscode.open', skillUri);
    await waitFor(
      'skill is active',
      () => hooks.tracker.snapshot().filePath === skillPath,
    );

    fake.push({ type: 'frame:push', frame });
    fake.push({
      type: 'frame:scope',
      frameId: 'f1',
      scope: { query: 'OpenAI GPT-5' },
    });

    const waitForQuery = (expected, label) =>
      waitFor(
        `webview runtimeVariables.query === "${expected}" (${label})`,
        () => hooks.webviewRuntimeVariables().query === expected,
        4_000,
      );

    // Pause 1 — assert visible, then Step Over
    fake.push({ type: 'step:awaiting', line: 8, frame });
    await waitForQuery('OpenAI GPT-5', 'pause #1 before stepOver');
    await waitFor(
      'stepPaused context set',
      () => hooks.isStepPaused(),
      4_000,
    );

    const overBefore = fake.runControlCalls.filter((c) => c.mode === 'over').length;
    await vscode.commands.executeCommand('testbench-native.stepOver');
    await waitFor(
      'stepOver dispatched runControl(over)',
      () => fake.runControlCalls.filter((c) => c.mode === 'over').length === overBefore + 1,
      4_000,
    );

    // Server runs step 1 in response to 'over', then re-pauses before step 2.
    // Mirror the exact events the server emits in that sequence.
    fake.push({ type: 'step:start', line: 8, frame });
    fake.push({ type: 'step:pass', line: 8, frame });
    fake.push({
      type: 'frame:scope',
      frameId: 'f1',
      scope: { query: 'OpenAI GPT-5' },
    });
    fake.push({ type: 'step:awaiting', line: 9, frame });

    // Pause 2 — STILL visible after one Step Over.
    await waitForQuery('OpenAI GPT-5', 'pause #2 after first stepOver');

    // Another Step Over.
    const overBefore2 = fake.runControlCalls.filter((c) => c.mode === 'over').length;
    await vscode.commands.executeCommand('testbench-native.stepOver');
    await waitFor(
      'stepOver #2 dispatched',
      () => fake.runControlCalls.filter((c) => c.mode === 'over').length === overBefore2 + 1,
      4_000,
    );

    fake.push({ type: 'step:start', line: 9, frame });
    fake.push({ type: 'step:pass', line: 9, frame });
    fake.push({
      type: 'frame:scope',
      frameId: 'f1',
      scope: { query: 'OpenAI GPT-5' },
    });
    fake.push({ type: 'step:awaiting', line: 10, frame });

    // Pause 3 — STILL visible after two Step Overs.
    await waitForQuery('OpenAI GPT-5', 'pause #3 after two stepOvers');

    // Final sanity — description text never bled through at any pause.
    assert.notEqual(
      hooks.webviewRuntimeVariables().query,
      'the search term to enter',
      'webview must never show the description fallback once frame:scope provided the real value',
    );

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('Step Out from inside skill unwinds to test frame; captured outputs are visible', async () => {
    // Combines several debug-flow contracts in a single end-to-end
    // scenario:
    //
    //   - Step Out command (Shift+F11) targets the running
    //     controller even when active editor is the side-by-side
    //     skill file. (Regression for the dispatchStep wrong-
    //     controller bug.)
    //   - runControl('out') is delivered with no extra opts.
    //   - On frame:pop, the controller's frame stack shrinks back
    //     to the test (root) frame.
    //   - On the subsequent frame:scope (test frame), the
    //     skill's exposed output — aliased into the caller's scope
    //     — is visible in the webview's Variables panel.
    //   - The Call Stack view shows only the test frame after pop.
    //   - The scope-on-test-frame retains the caller-aliased output
    //     even after the skill's scope entry is no longer the top
    //     of the per-frame map.
    //
    // What this protects: a regression that drops the outputs map
    // on frame:pop, or fails to update the test frame's scope
    // after the skill returns, or sends Step Out to the wrong
    // controller, or stops the test entirely instead of unwinding.

    const skillUri = fixtureUri('fake-skill.md');
    const skillPath = skillUri.fsPath;
    const frame = {
      id: 'f1',
      parentId: null,
      kind: 'skill',
      uri: skillPath,
      line: 8,
      skillName: 'fake_skill',
    };

    await vscode.commands.executeCommand('testbench-native.runner.focus');
    await waitFor(
      'webview mounted',
      () => hooks.webviewStateUpdateCount() > 0,
      8_000,
    );

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    // User clicks onto the skill file tab (auto-reveal mimic) —
    // this is the state where the dispatchStep wrong-controller
    // bug used to fire.
    await vscode.commands.executeCommand('vscode.open', skillUri);
    await waitFor(
      'skill is active',
      () => hooks.tracker.snapshot().filePath === skillPath,
    );

    // Server emits the descent + skill scope + pause inside skill.
    fake.push({ type: 'frame:push', frame });
    fake.push({
      type: 'frame:scope',
      frameId: 'f1',
      scope: { query: 'OpenAI GPT-5' },
    });
    fake.push({ type: 'step:awaiting', line: 8, frame });

    await waitFor(
      'paused inside skill — Call Stack shows depth 1',
      () => hooks.runningFrameStack().length === 1,
    );
    await waitFor(
      'query visible in webview before stepOut',
      () => hooks.webviewRuntimeVariables().query === 'OpenAI GPT-5',
    );

    // User presses Shift+F11 (Step Out). Even though the active
    // editor is the skill file (and registry.active() would return
    // its own controller), the unified dispatchStep routes through
    // the running controller and POSTs runControl('out').
    const outBefore = fake.runControlCalls.filter((c) => c.mode === 'out').length;
    await vscode.commands.executeCommand('testbench-native.stepOut');
    await waitFor(
      'stepOut dispatched runControl(out) on the running controller',
      () => fake.runControlCalls.filter((c) => c.mode === 'out').length === outBefore + 1,
      4_000,
    );
    const outCall = fake.runControlCalls.filter((c) => c.mode === 'out').slice(-1)[0];
    assert.equal(
      outCall.opts === null || outCall.opts.pauseAtNextTool === undefined,
      true,
      'Step Out from a skill body must not request a tool-debugger pause',
    );

    // Server unwinds: finishes the skill's remaining steps, emits
    // frame:pop with the outputs map the skill produced, then
    // emits a test-frame frame:scope carrying the aliased value,
    // then pauses at the caller's next step.
    fake.push({ type: 'step:start', line: 9, frame });
    fake.push({ type: 'step:pass', line: 9, frame });
    fake.push({
      type: 'frame:pop',
      frameId: 'f1',
      outputs: { skill_captured: 'returned-from-skill' },
    });
    fake.push({
      type: 'frame:scope',
      frameId: '',
      // Test-frame scope now reflects the value the skill returned
      // through its caller-supplied alias. This is the user-visible
      // "got my output back" moment.
      scope: { skill_captured: 'returned-from-skill' },
    });
    fake.push({ type: 'step:awaiting', line: 2 }); // back at caller line 2

    // Call stack must have shrunk back to the test frame (length 0
    // since the runController's _frameStack only tracks skill frames,
    // not the implicit test root).
    await waitFor(
      'frame stack popped back to root',
      () => hooks.runningFrameStack().length === 0,
    );

    // The webview's runtimeVariables now reflects the caller scope
    // with the skill's exposed output.
    await waitFor(
      'caller scope shows skill_captured',
      () =>
        hooks.webviewRuntimeVariables().skill_captured === 'returned-from-skill',
      4_000,
    );

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

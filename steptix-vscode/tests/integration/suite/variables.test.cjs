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

const EXT_ID = 'pkent.steptix-vscode';
const FIXTURES_DIR =
  process.env.STEPTIX_FIXTURES_DIR ||
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

describe('Steptix Variables panel (Phase 4)', function () {
  this.timeout(20_000);

  /** @type {FakeApiClient} */
  let fake;
  /** @type {import('../../../dist/extension/extension').SteptixTestHooks} */
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
    void vscode.commands.executeCommand('steptix.runSelected');
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
    void vscode.commands.executeCommand('steptix.runSelected');
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
    await vscode.commands.executeCommand('steptix.runner.focus');
    await waitFor(
      'webview mounted and posting state (count > 0)',
      () => hooks.webviewStateUpdateCount() > 0,
      8_000,
    );

    void vscode.commands.executeCommand('steptix.runSelected');
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
    // steptix.stepOver, then verify the fake recorded a
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

    await vscode.commands.executeCommand('steptix.runner.focus');
    await waitFor(
      'webview mounted',
      () => hooks.webviewStateUpdateCount() > 0,
      8_000,
    );

    void vscode.commands.executeCommand('steptix.runSelected');
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
    await vscode.commands.executeCommand('steptix.stepOver');
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
    await vscode.commands.executeCommand('steptix.stepOver');
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

    await vscode.commands.executeCommand('steptix.runner.focus');
    await waitFor(
      'webview mounted',
      () => hooks.webviewStateUpdateCount() > 0,
      8_000,
    );

    void vscode.commands.executeCommand('steptix.runSelected');
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
    await vscode.commands.executeCommand('steptix.stepOut');
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
    void vscode.commands.executeCommand('steptix.runSelected');
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
    void vscode.commands.executeCommand('steptix.runSelected');
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

  describe('copying a variable', () => {
    // The copy commands write the real system clipboard. Put back whatever
    // the person running the suite had on it.
    let savedClipboard;
    before(async () => { savedClipboard = await vscode.env.clipboard.readText(); });
    after(async () => { await vscode.env.clipboard.writeText(savedClipboard); });

    it("a row's menu commands copy its value, unmasked value, name and placeholder", async () => {
      void vscode.commands.executeCommand('steptix.runSelected');
      await waitFor('stream active', () => fake.hasActiveStream);

      fake.push({
        type: 'frame:scope',
        frameId: '',
        scope: { username: 'alice', token: 'variables-copy-test-token' },
      });
      await waitFor('scope arrived', () => hooks.runningScope().username === 'alice');

      const byName = Object.fromEntries(hooks.variablesViewItems().map((i) => [i.name, i]));
      // The contextValue decides which value item the row's menu offers:
      // a masked row says "Copy Unmasked Value", so the menu names what is
      // about to land on the clipboard.
      assert.equal(byName.username.contextValue, 'steptixVariable');
      assert.equal(byName.token.contextValue, 'steptixVariable.masked');
      assert.notEqual(byName.token.description, 'variables-copy-test-token');

      const copied = async (command, node) => {
        await vscode.commands.executeCommand(command, node);
        return vscode.env.clipboard.readText();
      };
      assert.equal(await copied('steptix.copyVariableValue', byName.username.node), 'alice');
      // A tree row cannot animate: the copied row's icon turns into a tick for
      // a moment, then back.
      const iconOf = (name) => hooks.variablesViewItems().find((i) => i.name === name)?.icon;
      assert.equal(iconOf('username'), 'check');
      assert.equal(iconOf('token'), 'symbol-variable');
      await waitFor('the tick goes back to the variable icon', () => iconOf('username') === 'symbol-variable');
      assert.equal(
        await copied('steptix.copyVariableUnmaskedValue', byName.token.node),
        'variables-copy-test-token',
        'the masked row copies its real value, not the stars it shows',
      );
      assert.equal(await copied('steptix.copyVariableName', byName.username.node), 'username');
      assert.equal(
        await copied('steptix.copyVariablePlaceholder', byName.username.node),
        '{{username}}',
      );

      fake.end();
      await waitFor('idle', () => !hooks.isRunning());
    });

    it("the Test Runner panel's copyVariable message copies through the same host path", async () => {
      await hooks.dispatchWebviewMessage({
        type: 'copyVariable',
        kind: 'value',
        name: 'password',
        value: 'variables-copy-test-password',
        masked: true,
      });
      assert.equal(await vscode.env.clipboard.readText(), 'variables-copy-test-password');

      await hooks.dispatchWebviewMessage({ type: 'copyVariable', kind: 'placeholder', name: 'order.id' });
      assert.equal(await vscode.env.clipboard.readText(), '{{order.id}}');

      // Nothing to copy leaves the clipboard alone: a row with no value yet,
      // and a name no placeholder can reference.
      await vscode.env.clipboard.writeText('untouched');
      const mark = hooks.hostMessageCount();
      await hooks.dispatchWebviewMessage({ type: 'copyVariable', kind: 'value', name: 'orderId' });
      await hooks.dispatchWebviewMessage({ type: 'copyVariable', kind: 'placeholder', name: 'order.Order ID' });
      assert.equal(await vscode.env.clipboard.readText(), 'untouched');
      await hooks.dispatchWebviewMessage({ type: 'copyVariable', kind: 'name', name: 'orderId' });

      // The panel shows its "copied" tick from this answer — so a refused copy
      // must say so, and only the one that happened says ok.
      const answers = hooks.hostMessagesSince(mark).filter((m) => m.type === 'variableCopied');
      assert.deepEqual(answers, [
        { type: 'variableCopied', name: 'orderId', kind: 'value', ok: false },
        { type: 'variableCopied', name: 'order.Order ID', kind: 'placeholder', ok: false },
        { type: 'variableCopied', name: 'orderId', kind: 'name', ok: true },
      ]);
    });

    it('Ctrl+C copies the row selected in the Variables view', async () => {
      // The keybinding runs Copy Value with no row; the view's selection
      // stands in. Select the row in the view itself rather than handing the
      // command a node — through `reveal`, which a click is equivalent to and
      // which, unlike the list commands, does not depend on which list last
      // had keyboard focus.
      void vscode.commands.executeCommand('steptix.runSelected');
      await waitFor('stream active', () => fake.hasActiveStream);
      fake.push({
        type: 'frame:scope',
        frameId: '',
        scope: { alpha: 'first-row-value', beta: 'second-row-value' },
      });
      await waitFor('scope arrived', () => hooks.runningScope().beta === 'second-row-value');

      await vscode.env.clipboard.writeText('untouched');
      await vscode.commands.executeCommand('steptix.variables.focus');
      await hooks.selectVariable('beta');
      // The selection reaches the extension host as an event; wait on the
      // clipboard rather than on time.
      await waitFor('the selected row reaches the clipboard', async () => {
        await vscode.commands.executeCommand('steptix.copyVariableValue');
        return (await vscode.env.clipboard.readText()) === 'second-row-value';
      });

      fake.end();
      await waitFor('idle', () => !hooks.isRunning());
    });

    it('paused at a breakpoint, the view still lists the run and copies from it; Close Session empties it', async () => {
      // A breakpoint ends the run's request: nothing is RUNNING while it is
      // parked, which used to leave the view on "No active run" at exactly the
      // moment an author stops to look.
      vscode.debug.addBreakpoints([
        new vscode.SourceBreakpoint(
          new vscode.Location(fixtureUri('test-with-steps.md'), new vscode.Position(9, 0)),
          true,
        ),
      ]);
      vscode.window.activeTextEditor.selection = new vscode.Selection(0, 0, 0, 0);
      void vscode.commands.executeCommand('steptix.runSelected');
      await waitFor('stream active', () => fake.hasActiveStream);
      fake.push({ type: 'step:start', line: 9 });
      fake.push({ type: 'frame:scope', frameId: '', scope: { orderId: 'ORD-1042', token: 'variables-pause-test-token' } });
      fake.push({ type: 'step:pass', line: 9 });
      fake.end();
      await waitFor('paused at line 10', () => hooks.tracker.snapshot().breakpointStop === 10);
      await waitFor('nothing running while paused', () => !hooks.isRunning());

      await waitFor('the view lists the paused run', () =>
        hooks.variablesViewItems().some((i) => i.name === 'orderId'));
      const byName = Object.fromEntries(hooks.variablesViewItems().map((i) => [i.name, i]));
      assert.equal(hooks.variablesDescription(), 'test');
      await vscode.commands.executeCommand('steptix.copyVariableValue', byName.orderId.node);
      assert.equal(await vscode.env.clipboard.readText(), 'ORD-1042');
      await vscode.commands.executeCommand('steptix.copyVariableUnmaskedValue', byName.token.node);
      assert.equal(await vscode.env.clipboard.readText(), 'variables-pause-test-token');

      await vscode.commands.executeCommand('steptix.restartSession');
      await waitFor('Close Session clears the pause', () => hooks.tracker.snapshot().breakpointStop === null);
      await waitFor('and the view with it', () => hooks.variablesViewItems().length === 0);
    });

    it("package.json's menus and keybinding name the rows the view renders", async () => {
      // A `when` clause that names a contextValue no row carries hides its
      // menu item silently. Check every clause against what rows really set.
      void vscode.commands.executeCommand('steptix.runSelected');
      await waitFor('stream active', () => fake.hasActiveStream);
      fake.push({ type: 'frame:scope', frameId: '', scope: { username: 'alice', token: 'variables-copy-test-token' } });
      await waitFor('scope arrived', () => hooks.runningScope().username === 'alice');
      const contextValues = new Set(hooks.variablesViewItems().map((i) => i.contextValue));
      fake.end();
      await waitFor('idle', () => !hooks.isRunning());

      const pkg = vscode.extensions.getExtension(EXT_ID).packageJSON.contributes;
      const itemMenu = pkg.menus['view/item/context'].filter((m) => m.when.includes('steptix.variables'));
      const offered = (contextValue) => itemMenu
        .filter((m) => {
          const exact = /viewItem == (\S+)/.exec(m.when);
          const pattern = /viewItem =~ \/(.+)\//.exec(m.when);
          return exact ? exact[1] === contextValue : pattern ? new RegExp(pattern[1]).test(contextValue) : false;
        })
        .map((m) => `${m.command}${m.group === 'inline' ? ' (inline)' : ''}`)
        .sort();
      assert.deepEqual([...contextValues].sort(), ['steptixVariable', 'steptixVariable.masked']);
      assert.deepEqual(offered('steptixVariable'), [
        'steptix.copyVariableName',
        'steptix.copyVariablePlaceholder',
        'steptix.copyVariableValue',
        'steptix.copyVariableValue (inline)',
      ]);
      assert.deepEqual(offered('steptixVariable.masked'), [
        'steptix.copyVariableName',
        'steptix.copyVariablePlaceholder',
        'steptix.copyVariableUnmaskedValue',
        'steptix.copyVariableUnmaskedValue (inline)',
      ]);
      assert.ok(
        pkg.keybindings.some((k) => k.command === 'steptix.copyVariableValue' && k.key === 'ctrl+c'
          && k.mac === 'cmd+c' && k.when === 'focusedView == steptix.variables && !inputFocus'),
        'Ctrl+C / Cmd+C bound to Copy Value while the Variables view has focus — but not while its '
          + 'find/filter box does, where Ctrl+C must copy the typed text',
      );
      assert.ok(
        pkg.menus['view/title'].some((m) => m.command === 'steptix.exportVariablesCsv'
          && m.when === 'view == steptix.variables'),
        "Export as CSV in the Variables view's title bar",
      );
      // The title-bar button's tooltip is the command title, and the panel's
      // twin says the same (EXPORT_VARIABLES_LABEL in steptix-runner.jsx) with
      // the same VS Code icon.
      const exportCommand = pkg.commands.find((c) => c.command === 'steptix.exportVariablesCsv');
      assert.equal(exportCommand.title, 'Export variables as CSV…');
      assert.equal(exportCommand.icon, '$(download)');
    });
  });

  describe('exporting variables as CSV', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const BOM = '﻿';
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steptix-vars-csv-')); });
    afterEach(() => {
      hooks.setVariablesExportPicker(null);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    });

    /** Answer the save dialog with `name` in this test's directory, and
     *  record what it suggested. */
    const answerSaveDialogWith = (name) => {
      const asked = [];
      hooks.setVariablesExportPicker(async (suggested) => {
        asked.push(suggested);
        return vscode.Uri.file(path.join(dir, name));
      });
      return asked;
    };

    it("the view's title-bar action writes every row, secrets masked as shown", async () => {
      void vscode.commands.executeCommand('steptix.runSelected');
      await waitFor('stream active', () => fake.hasActiveStream);
      const payments = JSON.stringify([{ _row: 1, payee: 'Origin Energy, Ltd', amount: '$140.00' }]);
      fake.push({
        type: 'frame:scope',
        frameId: '',
        scope: { username: 'alice', token: 'variables-export-test-token', payments },
      });
      await waitFor('scope arrived', () => hooks.runningScope().username === 'alice');
      const shown = Object.fromEntries(hooks.variablesViewItems().map((i) => [i.name, i.description]));
      assert.notEqual(shown.token, 'variables-export-test-token');

      const asked = answerSaveDialogWith('out.csv');
      await vscode.commands.executeCommand('steptix.exportVariablesCsv');
      const csv = fs.readFileSync(path.join(dir, 'out.csv'), 'utf8');
      const quoted = `"${payments.replace(/"/g, '""')}"`;
      assert.equal(
        csv,
        `${BOM}name,value\r\npayments,${quoted}\r\ntoken,${shown.token}\r\nusername,alice\r\n`,
      );
      assert.ok(!csv.includes('variables-export-test-token'), 'the secret never reaches the file');
      // The dialog suggests <test>-variables.csv beside the test.
      assert.equal(path.basename(asked[0].fsPath), 'test-with-steps-variables.csv');
      // `Uri.fsPath` lower-cases a Windows drive letter; `path.resolve` does not.
      const folder = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
      assert.equal(folder(path.dirname(asked[0].fsPath)), folder(path.resolve(FIXTURES_DIR)));

      fake.end();
      await waitFor('idle', () => !hooks.isRunning());
    });

    it("the panel's exportVariables message writes its rows, and Cancel writes nothing", async () => {
      answerSaveDialogWith('panel.csv');
      await hooks.dispatchWebviewMessage({
        type: 'exportVariables',
        rows: [
          { name: 'orderId', value: 'ORD-1042' },
          { name: 'password', value: '*******' },
          { name: 'confirmation', value: '' },
        ],
        uri: fixtureUri('test-with-steps.md').toString(),
      });
      assert.equal(
        fs.readFileSync(path.join(dir, 'panel.csv'), 'utf8'),
        `${BOM}name,value\r\norderId,ORD-1042\r\npassword,*******\r\nconfirmation,\r\n`,
      );

      hooks.setVariablesExportPicker(async () => undefined); // Cancel
      await hooks.dispatchWebviewMessage({
        type: 'exportVariables',
        rows: [{ name: 'orderId', value: 'ORD-1042' }],
      });
      assert.deepEqual(fs.readdirSync(dir), ['panel.csv']);

      // Nothing listed: no dialog at all.
      let opened = false;
      hooks.setVariablesExportPicker(async () => { opened = true; return undefined; });
      await hooks.dispatchWebviewMessage({ type: 'exportVariables', rows: [] });
      assert.equal(opened, false);
    });

    it('a CSV that cannot be written is reported, not thrown', async () => {
      // The panel's button has nothing above it to catch a rejection, so a
      // failed write used to vanish — the commonest being a CSV still open in
      // Excel, which Windows locks. A directory stands in for the locked file.
      hooks.setVariablesExportPicker(async () => vscode.Uri.file(dir));
      await assert.doesNotReject(
        hooks.dispatchWebviewMessage({ type: 'exportVariables', rows: [{ name: 'orderId', value: 'ORD-1042' }] }),
      );
      assert.ok(fs.statSync(dir).isDirectory(), 'the target is left as it was');
    });
  });

  it('test-frame view hides __skillN_ entries from previous skill descents', async () => {
    // Phase 4.1.b — after a skill exits, its internal vars survive in
    // resolvedParameters (the expander never garbage-collects them).
    // The view filters them out when rendering the test (root) frame
    // so the user doesn't see noise like `__skill1_query` lingering
    // after the skill returned.
    void vscode.commands.executeCommand('steptix.runSelected');
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
    void vscode.commands.executeCommand('steptix.runSelected');
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
    void vscode.commands.executeCommand('steptix.runSelected');
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
    void vscode.commands.executeCommand('steptix.runSelected');
    await waitFor('stream 2 active', () => fake.hasActiveStream);
    // Before any frame:scope arrives the new run, the scope must be
    // empty — not leftover 'stale'.
    const scope = hooks.runningScope();
    assert.equal(scope.stale, undefined, 'stale variable from a previous run must not survive resetFrameState');

    fake.end();
    await waitFor('idle after run 2', () => !hooks.isRunning());
  });

  it('switching to a different test file clears the webview Variables panel', async () => {
    // Regression test for cross-test variable leak in the WEBVIEW
    // sidebar (the host-side `runningScope()` is already covered by
    // the test above). The webview keeps its own `runtimeVariables`
    // React state, populated by `frame:scope` events. Before the fix
    // that map was never cleared on file switch, so if Test A's run
    // populated it with `query: "OpenAI GPT-5"` and the user then
    // opened Test B, Test B's Variables panel would display Test A's
    // value — even though it has nothing to do with B.
    //
    // The fix: when `snapshot.uri` changes, the webview clears
    // runtimeVariables (mirrors how it already clears webviewSelection).
    await vscode.commands.executeCommand('steptix.runner.focus');
    await waitFor(
      'webview mounted',
      () => hooks.webviewStateUpdateCount() > 0,
      8_000,
    );

    // Run Test A, push a scope event, wait for the webview to receive
    // and rebroadcast it.
    void vscode.commands.executeCommand('steptix.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({
      type: 'frame:scope',
      frameId: '',
      scope: { contaminant: 'from-test-A' },
    });
    await waitFor(
      'webview saw contaminant from Test A',
      () => hooks.webviewRuntimeVariables().contaminant === 'from-test-A',
      4_000,
    );
    fake.end();
    await waitFor('Test A idle', () => !hooks.isRunning());

    // User opens a different test file. The webview must drop the
    // previous file's runtime values — they have no business showing
    // up on this file's Variables panel.
    const otherUri = fixtureUri('test-with-tool.md');
    await vscode.commands.executeCommand('vscode.open', otherUri);
    await waitFor(
      'switched to other test file',
      () => hooks.tracker.snapshot().filePath === otherUri.fsPath,
    );
    await waitFor(
      'webview Variables panel cleared after file switch',
      () => hooks.webviewRuntimeVariables().contaminant === undefined,
      4_000,
    );
  });

  it('starting a second run on the same file clears the webview Variables panel before new scope arrives', async () => {
    // Companion to the file-switch test above. Even if the user stays
    // on the same test file, Run #2 must not inherit Run #1's
    // variables in the webview. The previous host-side test already
    // covers `runningScope()`; this one pins the WEBVIEW state, which
    // is what the user actually sees in the Variables panel.
    //
    // The fix: the `running` message handler clears runtimeVariables
    // on the false→true transition (mirrors resetFrameState).
    await vscode.commands.executeCommand('steptix.runner.focus');
    await waitFor(
      'webview mounted',
      () => hooks.webviewStateUpdateCount() > 0,
      8_000,
    );

    // Run #1 — populate.
    void vscode.commands.executeCommand('steptix.runSelected');
    await waitFor('stream 1 active', () => fake.hasActiveStream);
    fake.push({
      type: 'frame:scope',
      frameId: '',
      scope: { run1_only: 'from-first-run' },
    });
    await waitFor(
      'webview saw run1_only',
      () => hooks.webviewRuntimeVariables().run1_only === 'from-first-run',
      4_000,
    );
    fake.end();
    await waitFor('run 1 idle', () => !hooks.isRunning());

    // Run #2 — same file. The moment `running: true` flips, the
    // webview must drop run #1's variables. Assert BEFORE any
    // frame:scope arrives this run — otherwise the new scope could
    // mask the old one by overwriting the same keys.
    void vscode.commands.executeCommand('steptix.runSelected');
    await waitFor('stream 2 active', () => fake.hasActiveStream);
    // Wait until the webview's runtimeVariables no longer contains
    // `run1_only`. This is the direct user-visible contract — the
    // first thing the host posts on run start is `{ type: 'running',
    // running: true }`, which triggers the webview's reset.
    await waitFor(
      'webview cleared run1_only after run-start',
      () => hooks.webviewRuntimeVariables().run1_only === undefined,
      4_000,
    );

    fake.end();
    await waitFor('run 2 idle', () => !hooks.isRunning());
  });

  it('a For each pass over table records renders its dotted properties', async () => {
    // SPEC-structured-table-reads.md §8.4. A `readTable` row bound as
    // `{{payment}}` arrives as the base JSON plus one binding per property,
    // in the record's own order with `_row` first — the server puts them in
    // `frame:scope` generically, so the panel needs nothing new to show them.
    // What it could do is lose them, by filtering on a name shape or by
    // rendering only names the FILE mentions; this is the test that says it
    // does neither, and that the value shown is the value of the pass the run
    // is on (the second Origin Energy row, not the first).
    void vscode.commands.executeCommand('steptix.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    const PASSWORD = 'hunter2-not-a-real-one';
    // `Amount` capitalised, because an alias is whatever the author wrote and
    // the ordering below has to hold for an upper-case one too.
    const record = {
      _row: '3',
      payee: 'Origin Energy',
      Amount: '$86.10',
      status: 'Paused',
      password: PASSWORD,
    };
    const capture = JSON.stringify([
      { _row: '1', payee: 'Origin Energy', Amount: '$140.00', status: 'Due', password: PASSWORD },
      record,
    ]);
    fake.push({
      type: 'frame:scope',
      frameId: '',
      scope: {
        payments: capture,
        payment: JSON.stringify(record),
        'payment._row': record._row,
        'payment.payee': record.payee,
        'payment.Amount': record.Amount,
        'payment.status': record.status,
        'payment.password': record.password,
      },
    });
    await waitFor('scope arrived', () => hooks.runningScope()['payment.payee'] === 'Origin Energy');

    const items = hooks.variablesViewItems();
    const names = items.map((i) => i.name);
    const byName = Object.fromEntries(items.map((i) => [i.name, i.description]));

    for (const key of ['payment', 'payment._row', 'payment.payee', 'payment.Amount']) {
      assert.ok(names.includes(key), `${key} must be listed`);
    }
    // `_row` leads the record's properties (§7.4). The view orders the whole
    // scope rather than preserving arrival order, and a plain `.sort()` does
    // NOT deliver this: `_` is code unit 95, between the upper-case letters
    // and the lower-case ones, so `payment.Amount` came first. The view sorts
    // with runner-core's `compareVariableNames`, which says so explicitly.
    const properties = names.filter((n) => n.startsWith('payment.'));
    assert.equal(properties[0], 'payment._row', 'the row number leads the properties');

    // The pass's own values, which is the whole point of reading them here
    // rather than off the file: row 3 is $86.10, row 1 is $140.00.
    assert.equal(byName['payment._row'], '3');
    assert.equal(byName['payment.Amount'], '$86.10');
    assert.equal(byName['payment.payee'], 'Origin Energy');
    // Masking reads the property segment, so a secret column is hidden even
    // though the variable it arrived under is called `payment` (§8.4).
    //
    // The EXACT mask string, not `notEqual` against the raw value: a row the
    // view dropped entirely — filtered out by its dotted name, say — has an
    // `undefined` description, which is not equal to the password either and
    // would pass an inequality while showing the user nothing. `maskIfSecret`
    // renders a star per character, capped at eight.
    assert.ok(names.includes('payment.password'), 'the secret column is still listed');
    assert.equal(
      byName['payment.password'],
      '*'.repeat(8),
      'a secret-named property must render as the mask, not as its value and not as nothing',
    );

    // …and the two rows the name rule cannot catch. `payments` is the whole
    // table and `payment` is one record of it, both under names the author
    // chose and neither of which says secret — so they rendered in full,
    // password and all, immediately above a `payment.password` row showing
    // `********`. `frame:scope` carries raw values by design (the wire was
    // left alone when redaction shipped), so this render is the only guard.
    for (const key of ['payment', 'payments']) {
      assert.ok(
        byName[key] !== undefined && byName[key].length > 0,
        `${key} must still be shown, not hidden`,
      );
      assert.ok(
        !byName[key].includes(PASSWORD),
        `${key} rendered its password column: ${byName[key]}`,
      );
    }
    // Masked inside, not masked whole: the readable columns are why the view
    // is worth looking at during a loop.
    assert.ok(byName.payments.includes('Origin Energy'), byName.payments);
    assert.ok(byName.payment.includes('$86.10'), byName.payment);

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it("the event's bindings and unmask decide the rows, not the name shapes", async () => {
    // SPEC-structured-table-reads.md §7.6. A scope holds two kinds of dotted
    // name and nothing about either says which it is: `payment.keyword` is a
    // page's column, bound by a `For each` pass, and `user.apikey` is a data
    // file's own heading, typed by the author. The server tells them apart
    // with a registry keyed on its live map's object identity; `frame:scope`
    // sends a COPY, so the view had to guess, guessed the narrow way for both,
    // and printed `uk_live_1234` beside a report matrix that starred it.
    //
    // `bindings` is that registry as data and `unmask` is the test's
    // `## Config: unmask:` list. This is the whole path from the wire to the
    // rendered description: event → controller → ScopeSource → TreeItem.
    // (The webview panel's copy of the same rule is covered by
    // `tests/variables-panel.test.js` and the call-site scan in
    // `tests/record-secret-parity.test.js`; `webviewRuntimeVariables()` reads
    // back the RAW map, so masking is not assertable through it.)
    void vscode.commands.executeCommand('steptix.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    const APIKEY = 'uk_live_1234';
    fake.push({
      type: 'frame:scope',
      frameId: '',
      scope: {
        'payment.keyword': 'AU',
        'payment.password': 'hunter2-not-a-real-one',
        'user.apikey': APIKEY,
        keyword: 'search',
        password: 'hunter2-not-a-real-one',
      },
      // Only the pass's own names. `user.apikey` is in the scope and not in
      // here, which is the entire distinction being tested.
      bindings: ['payment.keyword', 'payment.password'],
      unmask: ['keyword'],
    });
    await waitFor('scope arrived', () => hooks.runningScope()['user.apikey'] === APIKEY);

    const byName = Object.fromEntries(
      hooks.variablesViewItems().map((i) => [i.name, i.description]),
    );

    // Unregistered: the author's own name end to end, so the FLAT rule reads
    // the whole key and `key` is in it. The measured leak, now closed.
    assert.ok(byName['user.apikey'] !== undefined, 'the row must still be listed');
    assert.equal(
      byName['user.apikey'],
      '*'.repeat(8),
      `an unregistered dotted name must mask, not render ${APIKEY}`,
    );

    // Registered: half the page's word, so the narrow record rule decides the
    // property and `AU` stays readable — which is what the model needs to find
    // the row and what the report prints beside this view.
    assert.equal(byName['payment.keyword'], 'AU');
    // …and the two-segment rule is still a rule: a real credential column is
    // hidden whichever list it is on.
    assert.equal(byName['payment.password'], '*'.repeat(8));

    // The hatch, reaching the client for the first time. A flat `keyword`
    // masks by default (the report masks it too, and the view must not
    // disagree) — `unmask: ['keyword']` is the author saying otherwise.
    assert.equal(byName.keyword, 'search');
    // By the exact name: unmasking `keyword` says nothing about `password`.
    assert.equal(byName.password, '*'.repeat(8));

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('an event carrying neither field renders exactly what it always did', async () => {
    // Absence is not emptiness. An older server sends no `bindings`, which
    // means "nothing known" — and the safe reading of a scope full of real
    // loop bindings is the narrow one. Reading absent as `[]` would mask `AU`
    // out of every row whose column is called `keyword`, against a server that
    // never said the name was the author's.
    void vscode.commands.executeCommand('steptix.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    const APIKEY = 'uk_live_1234';
    fake.push({
      type: 'frame:scope',
      frameId: '',
      scope: { 'payment.keyword': 'AU', 'user.apikey': APIKEY, keyword: 'search' },
    });
    await waitFor('scope arrived', () => hooks.runningScope()['user.apikey'] === APIKEY);

    const byName = Object.fromEntries(
      hooks.variablesViewItems().map((i) => [i.name, i.description]),
    );
    assert.equal(byName['payment.keyword'], 'AU', 'the pre-wire reading of a dotted name');
    assert.equal(byName['user.apikey'], APIKEY, '…including the gap it leaves');
    assert.equal(byName.keyword, '*'.repeat(6), 'and no hatch without an unmask list');

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });
});

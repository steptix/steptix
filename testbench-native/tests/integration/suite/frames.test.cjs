/**
 * Phase 2 — frame stack model + status routing by `frame.uri`.
 *
 * Drives the extension end-to-end inside a real VS Code extension host
 * with a FakeApiClient scripted to emit `frame:push` / `frame:pop` events
 * around a synthesized skill body. Asserts:
 *
 *  1. The RunController's frame stack reflects pushes/pops in order.
 *  2. step:* events with `frame` payload land on `frame.uri` in the
 *     tracker, not on the test file.
 *  3. A top-level frame:push paints `running` on the test file's
 *     `[skill: ...]` line; frame:pop paints `pass` on a clean exit.
 *  4. A step:fail inside a frame propagates `fail` to the test file's
 *     `[skill:]` line via markFrameFailed.
 *
 * The fake skill `.md` doesn't have to exist on disk for the tracker
 * assertions — the extension reads `frame.uri` as an opaque string and
 * stores per-URI state under it. The auto-reveal path's
 * `showTextDocument` is best-effort and its error is swallowed via
 * `void`, so a missing file path doesn't fail the test (it just produces
 * an error in the VS Code dev console we tolerate).
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
    try {
      if (await predicate()) return;
    } catch {
      // ignore — predicate transient errors are part of the wait
    }
    await sleep(50);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

describe('TestBench frame events (Phase 2)', function () {
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
    await waitFor('fixture editor active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === uri.toString();
    });
    // Highlight line 9 so runSelected scopes itself to that step (matches
    // the pattern used by state-machine.test.cjs — cursor-only selections
    // run the whole file).
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(8, 0),
      new vscode.Position(8, 5),
    );
    await waitFor('active file detected as test file', () => {
      const snap = hooks.tracker.snapshot();
      return snap.isTestFile === true;
    });
  });

  it('frame:push grows the controller stack; frame:pop shrinks it', async () => {
    const skillUri = vscode.Uri.file(path.resolve(FIXTURES_DIR, 'fake-skill.md'));

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    assert.deepEqual(hooks.runningFrameStack(), [], 'stack starts empty');

    const frame = {
      id: 'f1',
      parentId: null,
      kind: 'skill',
      uri: skillUri.fsPath,
      line: 9,
      skillName: 'fake_skill',
    };
    fake.push({ type: 'frame:push', frame });
    await waitFor('frame stack has one frame', () => hooks.runningFrameStack().length === 1);
    const stack = hooks.runningFrameStack();
    assert.equal(stack[0].id, 'f1');
    assert.equal(stack[0].skillName, 'fake_skill');

    fake.push({ type: 'frame:pop', frameId: 'f1', outputs: {} });
    await waitFor('frame stack empty after pop', () => hooks.runningFrameStack().length === 0);

    fake.end();
    await waitFor('idle after stream ends', () => !hooks.isRunning());
  });

  it('step events with frame.uri route statuses to that URI', async () => {
    const skillPath = path.resolve(FIXTURES_DIR, 'fake-skill.md');
    const skillUri = vscode.Uri.file(skillPath);
    const frame = {
      id: 'f1',
      parentId: null,
      kind: 'skill',
      uri: skillPath,
      line: 9,
      skillName: 'fake_skill',
    };

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'frame:push', frame });
    fake.push({ type: 'step:start', line: 5, frame });
    await waitFor('skill-file status running on line 5', () => {
      const snap = hooks.tracker.snapshotFor(skillUri);
      if (!snap) return false;
      const statuses = Object.fromEntries(snap.statuses);
      return statuses[5] === 'running';
    });

    fake.push({ type: 'step:pass', line: 5, frame });
    await waitFor('skill-file status pass on line 5', () => {
      const snap = hooks.tracker.snapshotFor(skillUri);
      if (!snap) return false;
      const statuses = Object.fromEntries(snap.statuses);
      return statuses[5] === 'pass';
    });

    // The test file's own snapshot should NOT have a status on line 5 —
    // that's the skill file's line, not the test's. Phase 2's whole point.
    const testSnap = hooks.tracker.snapshot();
    const testStatuses = Object.fromEntries(testSnap.statuses);
    assert.equal(testStatuses[5], undefined, 'test file must not inherit skill-body statuses');

    fake.push({ type: 'frame:pop', frameId: 'f1', outputs: {} });
    fake.end();
    await waitFor('idle after stream ends', () => !hooks.isRunning());
  });

  it('top-level frame:push marks test-file [skill:] line running; pop marks pass', async () => {
    const frame = {
      id: 'f1',
      parentId: null,
      kind: 'skill',
      uri: path.resolve(FIXTURES_DIR, 'fake-skill.md'),
      line: 9, // the [skill: ...] invocation line in the test file
      skillName: 'fake_skill',
    };

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'frame:push', frame });
    await waitFor('test-file line 9 running (aggregate)', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });

    // A successful step inside the skill should NOT change the test file's
    // aggregate to pass — that only happens at frame:pop.
    fake.push({ type: 'step:start', line: 3, frame });
    fake.push({ type: 'step:pass', line: 3, frame });
    await sleep(30); // give the host time to process the events
    let statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    assert.equal(statuses[9], 'running', 'aggregate stays running until frame:pop');

    fake.push({ type: 'frame:pop', frameId: 'f1', outputs: {} });
    await waitFor('test-file line 9 pass (aggregate after pop)', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'pass';
    });

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('step:fail that arrives AFTER frame:pop still propagates fail to the [skill:] line', async () => {
    // Phase 2.1.a regression guard: markFrameFailed walks ancestry via
    // the persistent frameParents map, not the live stack. If the walk
    // depended on the live stack, a fail event reordered after the pop
    // (rare but possible across SSE flush boundaries) would silently
    // drop the fail mark on the test file.
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
    fake.push({ type: 'frame:pop', frameId: 'f1', outputs: {} });
    // Frame is already off the live stack. Now the late fail arrives.
    fake.push({ type: 'step:fail', line: 3, error: 'late', frame });

    await waitFor('test-file line 9 fail (propagated post-pop)', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'fail';
    });

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('Stop during a skill flips running statuses on BOTH the test file and the skill file', async () => {
    // Phase 2.1.d regression guard: markAllRunningStopped walks every
    // tracked URI, not just the active editor's. Pre-fix, the skill
    // file's running step would stay spinning after Stop.
    const skillPath = path.resolve(FIXTURES_DIR, 'fake-skill.md');
    const skillUri = vscode.Uri.file(skillPath);
    const frame = {
      id: 'f1',
      parentId: null,
      kind: 'skill',
      uri: skillPath,
      line: 9,
      skillName: 'fake_skill',
    };

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'frame:push', frame });
    fake.push({ type: 'step:start', line: 5, frame });
    await waitFor('skill-file line 5 running', () => {
      const snap = hooks.tracker.snapshotFor(skillUri);
      const statuses = snap ? Object.fromEntries(snap.statuses) : {};
      return statuses[5] === 'running';
    });
    await waitFor('test-file line 9 running (aggregate)', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });

    await vscode.commands.executeCommand('testbench-native.stop');

    await waitFor('idle after stop', () => !hooks.isRunning());
    // Both files must show stopped on what was running.
    const testStatuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    assert.equal(testStatuses[9], 'stopped', 'test-file aggregate must flip to stopped');
    const skillSnap = hooks.tracker.snapshotFor(skillUri);
    const skillStatuses = skillSnap ? Object.fromEntries(skillSnap.statuses) : {};
    assert.equal(skillStatuses[5], 'stopped', 'skill-body line must flip to stopped');
    // Frame state on the controller should be wiped so the next run
    // starts clean (and the Call Stack view is empty).
    assert.deepEqual(hooks.runningFrameStack(), [], 'frame stack cleared on stop');
  });

  it('step:fail inside a frame propagates fail to the test-file [skill:] line', async () => {
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
    fake.push({ type: 'step:start', line: 3, frame });
    fake.push({ type: 'step:fail', line: 3, error: 'boom', frame });

    await waitFor('test-file line 9 fail (propagated)', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'fail';
    });

    // frame:pop after a failed descent must NOT overwrite the fail with pass.
    fake.push({ type: 'frame:pop', frameId: 'f1', outputs: {} });
    await sleep(30);
    const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    assert.equal(statuses[9], 'fail', 'frame:pop must not clobber a propagated fail');

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('breakpoint pause inside a skill: after Continue, frame:pop still paints [skill:] line pass', async () => {
    // Regression for the user-reported bug: skill-demo.md has step 1
    // as `[skill: duckduckgo_search ...]`; a breakpoint sits inside
    // the skill body. After Continue and clean completion, the test
    // file's step 1 (the [skill:] line) should show the green ✓.
    //
    // Mimics the full server event sequence:
    //   1. frame:push (skill, parentId=null, invocationLine=9)
    //   2. frame:scope on entry (caller's inputs)
    //   3. step:awaiting at skill line 5 (breakpoint pause)
    //   4. user Continue → fake.runControl receives 'continue'
    //   5. step:start + step:pass for the rest of the skill body
    //   6. frame:pop (clean exit)
    //   7. step:start + step:pass for the test's next line (10)
    // After (6), the test file's line 9 must flip from running → pass.
    const skillPath = path.resolve(FIXTURES_DIR, 'fake-skill.md');
    const frame = {
      id: 'f1',
      parentId: null,
      kind: 'skill',
      uri: skillPath,
      line: 9, // [skill: ...] invocation line in the test file
      skillName: 'fake_skill',
    };

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'frame:push', frame });
    fake.push({
      type: 'frame:scope',
      frameId: 'f1',
      scope: { query: 'OpenAI GPT-5' },
    });
    fake.push({ type: 'step:awaiting', line: 5, frame });

    await waitFor('test-file line 9 running (aggregate)', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });

    // User clicks Continue. The unified continueRun command POSTs
    // runControl('continue') because the controller is step-paused.
    const before = fake.runControlCalls.filter((c) => c.mode === 'continue').length;
    await vscode.commands.executeCommand('testbench-native.continueRun');
    await waitFor(
      'continueRun dispatched runControl(continue)',
      () => fake.runControlCalls.filter((c) => c.mode === 'continue').length === before + 1,
      4_000,
    );

    // Server resumes and finishes the skill body cleanly.
    fake.push({ type: 'step:start', line: 5, frame });
    fake.push({ type: 'step:pass', line: 5, frame });
    fake.push({ type: 'step:start', line: 6, frame });
    fake.push({ type: 'step:pass', line: 6, frame });
    fake.push({ type: 'frame:pop', frameId: 'f1', outputs: {} });

    // The whole point of this test: after frame:pop on a clean exit,
    // the test file's [skill:] line aggregate becomes pass.
    await waitFor(
      'test-file line 9 pass (aggregate after pop, post-breakpoint)',
      () => {
        const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
        return statuses[9] === 'pass';
      },
      4_000,
    );

    // Caller's next step runs and passes too — confirms the run
    // didn't bail out before reaching the test's remaining steps.
    fake.push({ type: 'step:start', line: 10 });
    fake.push({ type: 'step:pass', line: 10 });

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());

    // Final assert: line 9's status survived to end-of-run.
    const final = Object.fromEntries(hooks.tracker.snapshot().statuses);
    assert.equal(final[9], 'pass', '[skill:] line must keep pass after run completes');
    assert.equal(final[10], 'pass', 'caller next step must also be pass');
  });
});

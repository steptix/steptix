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

  it('re-run after a successful run clears stale statuses on test file AND skill files', async () => {
    // User-reported regression: "if a step fails in the skill, it
    // doesn't seem to stop the test." Root cause turned out to be
    // stale statuses — a successful prior run left ✓ on every line,
    // and the failing re-run only repainted the lines it actually
    // touched. The trailing test step still showed ✓ from the prior
    // run, so the user reasonably interpreted that as "the test
    // continued past the skill failure."
    //
    // Fix: at run start, clear statuses on the test file and every
    // skill file the previous run descended into. This regression test
    // simulates the exact scenario: prime statuses on both files, kick
    // off a new run, and assert both files are blank again before any
    // new events arrive.
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

    // ── Successful prior run: paint pass on test + skill lines ──
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('first stream active', () => fake.hasActiveStream);
    fake.push({ type: 'frame:push', frame });
    fake.push({ type: 'step:start', line: 5, frame });
    fake.push({ type: 'step:pass', line: 5, frame });
    fake.push({ type: 'frame:pop', frameId: 'f1', outputs: {} });
    await waitFor(
      'test line 9 pass after first run',
      () => Object.fromEntries(hooks.tracker.snapshot().statuses)[9] === 'pass',
    );
    await waitFor(
      'skill line 5 pass after first run',
      () => {
        const snap = hooks.tracker.snapshotFor(skillUri);
        const statuses = snap ? Object.fromEntries(snap.statuses) : {};
        return statuses[5] === 'pass';
      },
    );
    fake.end();
    await waitFor('idle after first run', () => !hooks.isRunning());

    // ── Re-run: at run start, BOTH files' statuses must clear ──
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('second stream active', () => fake.hasActiveStream);

    // The clear happens synchronously inside runLines BEFORE any
    // events flow back. So by the time the stream is active, the
    // statuses must already be gone.
    const testStatusesAfterClear = Object.fromEntries(hooks.tracker.snapshot().statuses);
    assert.equal(
      testStatusesAfterClear[9],
      undefined,
      'test-file [skill:] line must be cleared at run start',
    );
    const skillSnap = hooks.tracker.snapshotFor(skillUri);
    const skillStatusesAfterClear = skillSnap ? Object.fromEntries(skillSnap.statuses) : {};
    assert.equal(
      skillStatusesAfterClear[5],
      undefined,
      'skill-file body line must be cleared at run start',
    );

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

  it('user pause while inside a skill: skill-body spinner flips to stopped + yellow ▶ lands on test-file [skill:] line', async () => {
    // Two latent bugs this test guards:
    //   1. markAllRunningStopped was only invoked on Stop, not Pause. So a
    //      pause while a skill-body step was executing left the blue
    //      spinner running forever on the skill file (and on the test
    //      file's aggregate [skill:] line).
    //   2. The pause path posted breakpointStop using lastStepStartLine
    //      with no URI hint — the line was the skill-body's line but the
    //      receiver wrote it against the controller's test-file URI, so
    //      the yellow ▶ ended up on a random test-file line that often
    //      had nothing to do with anything.
    //
    // The fix: pause flips every `running` → `stopped` across both files,
    // and the resume anchor is the test-file [skill: ...] line (taken from
    // the active frame's frameRoot), not the skill body's own line.
    const skillPath = path.resolve(FIXTURES_DIR, 'fake-skill.md');
    const skillUri = vscode.Uri.file(skillPath);
    const frame = {
      id: 'f1',
      parentId: null,
      kind: 'skill',
      uri: skillPath,
      line: 9, // [skill: ...] line in the test file
      skillName: 'fake_skill',
    };

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    // Enter the skill and start executing a body line.
    fake.push({ type: 'frame:push', frame });
    fake.push({ type: 'step:start', line: 5, frame });
    await waitFor('skill-file line 5 running', () => {
      const snap = hooks.tracker.snapshotFor(skillUri);
      return snap && Object.fromEntries(snap.statuses)[5] === 'running';
    });
    await waitFor('test-file line 9 running (aggregate)', () => {
      return Object.fromEntries(hooks.tracker.snapshot().statuses)[9] === 'running';
    });

    // Pause mid-skill-step.
    await vscode.commands.executeCommand('testbench-native.pause');
    await waitFor('idle after pause', () => !hooks.isRunning());

    // Bug 1: both files' `running` must flip to `stopped`.
    const skillSnap = hooks.tracker.snapshotFor(skillUri);
    const skillStatuses = skillSnap ? Object.fromEntries(skillSnap.statuses) : {};
    assert.equal(
      skillStatuses[5],
      'stopped',
      'skill-body running spinner must flip to stopped on Pause — not stay running forever',
    );
    const testStatuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    assert.equal(
      testStatuses[9],
      'stopped',
      'test-file [skill:] aggregate spinner must also flip to stopped on Pause',
    );

    // Bug 2: yellow ▶ goes on the test file at the [skill:] line (9),
    // NOT on the test file at line 5 (which is the skill-body line — a
    // line that has nothing to do with where the test-file step lives).
    assert.equal(
      hooks.tracker.snapshot().breakpointStop,
      9,
      'breakpointStop must land on the test-file [skill: ...] line, not on the skill-body line number',
    );
    // And it must NOT have leaked onto the skill file at line 5.
    const skillBpStop = skillSnap ? skillSnap.breakpointStop : null;
    assert.equal(
      skillBpStop,
      null,
      'skill-file must not carry a breakpointStop — resume re-runs the whole [skill:] from the test file',
    );
  });

  it('persists run state to .testbench/run-state.json keyed by a workspace-relative path', async () => {
    // The whole point of the file backend (vs workspaceState) is portability:
    // the ticks must travel when the folder is zipped/copied. That only works
    // if the on-disk key is the workspace-RELATIVE path, never an absolute
    // path or a file:// URI (which wouldn't match on another machine).
    const fs = require('node:fs');
    const stateFile = path.resolve(FIXTURES_DIR, '.testbench', 'run-state.json');

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    fake.push({ type: 'step:pass', line: 9 });
    fake.end();
    await waitFor(
      'line 9 pass',
      () => Object.fromEntries(hooks.tracker.snapshot().statuses)[9] === 'pass',
    );

    // Writes are debounced (~400ms). Wait for the file to land with the mark.
    await waitFor('run-state.json written with the pass', () => {
      if (!fs.existsSync(stateFile)) return false;
      try {
        const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        const entry = parsed?.files?.['test-with-steps.md'];
        return entry && Object.fromEntries(entry.statuses)[9] === 'pass';
      } catch {
        return false;
      }
    }, 4_000);

    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const keys = Object.keys(parsed.files);
    assert.ok(
      keys.includes('test-with-steps.md'),
      `expected workspace-relative key 'test-with-steps.md', got: ${keys.join(', ')}`,
    );
    for (const k of keys) {
      assert.ok(
        !k.includes(':') && !k.startsWith('/') && !k.startsWith('file:'),
        `key must be workspace-relative, not absolute/URI: ${k}`,
      );
    }
  });

  it('a different test descending into a shared skill clears the prior test’s stale statuses', async () => {
    // Bug class: skill state is keyed only by the skill file's URI, shared
    // across every test. The run-start clear only wipes skills THIS
    // controller descended into before — so Test B stepping into a skill
    // Test A had fully passed would show B's ✗ on the failing step PLUS A's
    // stale ✓ on the steps B never reaches (a short-circuited failure looks
    // like it "continued"). Now persisted across close/reload, that mix
    // would be durable. Fix: clear the skill URI on first descent each run.
    const skillPath = path.resolve(FIXTURES_DIR, 'shared-skill.md');
    const skillUri = vscode.Uri.file(skillPath);
    const testAUri = fixtureUri('test-shared-a.md');
    const testBUri = fixtureUri('test-shared-b.md');

    const openTest = async (uri) => {
      await vscode.commands.executeCommand('vscode.open', uri);
      await waitFor('editor active ' + uri.fsPath, () => {
        const ed = vscode.window.activeTextEditor;
        return ed && ed.document.uri.toString() === uri.toString();
      });
      await waitFor('detected as test file', () => hooks.tracker.snapshot().isTestFile === true);
    };

    // ── Test A: descend into the shared skill, pass body lines 8 AND 9 ──
    await openTest(testAUri);
    const frameA = {
      id: 'a1', parentId: null, kind: 'skill',
      uri: skillPath, line: 8, skillName: 'shared_skill',
    };
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('A stream active', () => fake.hasActiveStream);
    fake.push({ type: 'frame:push', frame: frameA });
    fake.push({ type: 'step:start', line: 8, frame: frameA });
    fake.push({ type: 'step:pass', line: 8, frame: frameA });
    fake.push({ type: 'step:start', line: 9, frame: frameA });
    fake.push({ type: 'step:pass', line: 9, frame: frameA });
    fake.push({ type: 'frame:pop', frameId: 'a1', outputs: {} });
    await waitFor('shared skill lines 8 & 9 pass after A', () => {
      const snap = hooks.tracker.snapshotFor(skillUri);
      if (!snap) return false;
      const s = Object.fromEntries(snap.statuses);
      return s[8] === 'pass' && s[9] === 'pass';
    });
    fake.end();
    await waitFor('idle after A', () => !hooks.isRunning());

    // ── Test B: a DIFFERENT test file descends into the SAME skill and
    //    fails on body line 8 (short-circuit — line 9 never runs) ──
    await openTest(testBUri);
    const frameB = {
      id: 'b1', parentId: null, kind: 'skill',
      uri: skillPath, line: 8, skillName: 'shared_skill',
    };
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('B stream active', () => fake.hasActiveStream);
    fake.push({ type: 'frame:push', frame: frameB });

    // The descent-clear fires on frame:push, before any step events — so A's
    // stale ✓ on line 9 (which B will never reach) must be gone immediately.
    await waitFor('A’s stale pass on line 9 cleared on B’s descent', () => {
      const snap = hooks.tracker.snapshotFor(skillUri);
      const s = snap ? Object.fromEntries(snap.statuses) : {};
      return s[9] === undefined;
    });

    fake.push({ type: 'step:start', line: 8, frame: frameB });
    fake.push({ type: 'step:fail', line: 8, error: 'boom', frame: frameB });
    await waitFor('shared skill line 8 fail after B', () => {
      const snap = hooks.tracker.snapshotFor(skillUri);
      const s = snap ? Object.fromEntries(snap.statuses) : {};
      return s[8] === 'fail';
    });

    // The crux: the shared skill shows ONLY B's failure — not a misleading
    // mix of B's ✗ on line 8 and A's stale ✓ on line 9.
    const finalSkill = Object.fromEntries(
      (hooks.tracker.snapshotFor(skillUri)?.statuses) ?? [],
    );
    assert.equal(finalSkill[8], 'fail', 'shared skill line 8 must be fail (Test B)');
    assert.equal(
      finalSkill[9],
      undefined,
      'Test A’s stale pass on line 9 must be cleared, not left as a ✓',
    );

    fake.push({ type: 'frame:pop', frameId: 'b1', outputs: {} });
    fake.end();
    await waitFor('idle after B', () => !hooks.isRunning());
  });

  it('second descent into the same skill in ONE run does not re-clear the first descent’s marks', async () => {
    // The descent-clear is once-per-URI-per-run (clearedDescentUris). A test
    // that invokes the same skill twice must not have its first invocation's
    // ✓ wiped when the second invocation pushes the same skill frame.
    const skillPath = path.resolve(FIXTURES_DIR, 'shared-skill.md');
    const skillUri = vscode.Uri.file(skillPath);
    const frame1 = {
      id: 'f1', parentId: null, kind: 'skill',
      uri: skillPath, line: 8, skillName: 'shared_skill',
    };

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    // First invocation: pass skill body line 8, then pop.
    fake.push({ type: 'frame:push', frame: frame1 });
    fake.push({ type: 'step:start', line: 8, frame: frame1 });
    fake.push({ type: 'step:pass', line: 8, frame: frame1 });
    fake.push({ type: 'frame:pop', frameId: 'f1', outputs: {} });
    await waitFor('skill line 8 pass after first invocation', () => {
      const snap = hooks.tracker.snapshotFor(skillUri);
      return snap && Object.fromEntries(snap.statuses)[8] === 'pass';
    });

    // Second invocation of the SAME skill, same run (different frame id).
    // The descent-clear must NOT fire again — line 8's pass must survive.
    fake.push({
      type: 'frame:push',
      frame: { ...frame1, id: 'f2' },
    });
    await sleep(50);
    const snap = hooks.tracker.snapshotFor(skillUri);
    assert.equal(
      snap && Object.fromEntries(snap.statuses)[8],
      'pass',
      'second same-run descent must not re-clear the first invocation’s mark',
    );

    fake.push({ type: 'frame:pop', frameId: 'f2', outputs: {} });
    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('a continuation run (Continue after pause) does NOT clear a re-pushed skill’s marks', async () => {
    // shouldClearDescentStatuses returns false for continuation runs:
    // resetFrameState empties clearedDescentUris at the start of the new
    // (continuation) stream, so without the isContinuation guard a re-pushed
    // skill frame would wipe the pass marks earned before the pause. Drive a
    // genuine continuation via user-pause → continueRun (which re-opens the
    // stream with isContinuation: true).
    const skillPath = path.resolve(FIXTURES_DIR, 'shared-skill.md');
    const skillUri = vscode.Uri.file(skillPath);
    const frame = {
      id: 'f1', parentId: null, kind: 'skill',
      uri: skillPath, line: 8, skillName: 'shared_skill',
    };

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    // Descend and pass skill body line 8.
    fake.push({ type: 'frame:push', frame });
    fake.push({ type: 'step:start', line: 8, frame });
    fake.push({ type: 'step:pass', line: 8, frame });
    await waitFor('skill line 8 pass before pause', () => {
      const snap = hooks.tracker.snapshotFor(skillUri);
      return snap && Object.fromEntries(snap.statuses)[8] === 'pass';
    });

    // User pause → idle + breakpointStop set (a non-step-paused pause, so
    // continueRun takes the stream-reopen path, not the runControl path).
    await vscode.commands.executeCommand('testbench-native.pause');
    await waitFor('idle while paused', () => !hooks.isRunning());

    // Continue — re-opens the stream as a continuation (isContinuation: true).
    void vscode.commands.executeCommand('testbench-native.continueRun');
    await waitFor('isRunning again', () => hooks.isRunning());
    await waitFor('new continuation stream', () => fake.hasActiveStream);

    // The continuation re-pushes the skill frame. The guard must suppress the
    // descent-clear so line 8's pass survives.
    fake.push({ type: 'frame:push', frame });
    await sleep(50);
    const snap = hooks.tracker.snapshotFor(skillUri);
    assert.equal(
      snap && Object.fromEntries(snap.statuses)[8],
      'pass',
      'continuation must preserve the pre-pause pass mark, not clear it on re-descent',
    );

    fake.push({ type: 'frame:pop', frameId: 'f1', outputs: {} });
    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('user pause at top-level (no active frame): running step flips to stopped, breakpointStop lands on the test file', async () => {
    // Companion to the in-skill test above. Even without a frame on the
    // stack the same Bug 1 applied: pause never invoked markRunningStopped,
    // so the spinner on the running test-file step stayed forever. The yellow
    // ▶ was correct (test-file URI matches), so this test only guards the
    // status flip; the existing user-pause test in state-machine.test.cjs
    // covered the breakpointStop placement but not the status of the
    // interrupted step.
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'step:start', line: 9 });
    await waitFor('test-file line 9 running', () => {
      return Object.fromEntries(hooks.tracker.snapshot().statuses)[9] === 'running';
    });

    await vscode.commands.executeCommand('testbench-native.pause');
    await waitFor('idle after pause', () => !hooks.isRunning());

    const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    assert.equal(
      statuses[9],
      'stopped',
      'top-level pause must flip the interrupted step from running to stopped',
    );
    assert.equal(
      hooks.tracker.snapshot().breakpointStop,
      9,
      'top-level pause keeps breakpointStop on the same line the spinner was on',
    );
  });
});

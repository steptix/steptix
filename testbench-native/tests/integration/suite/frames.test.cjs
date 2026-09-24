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

  it('Stop inside a skill parks a debug context; running selected skill steps re-runs that bounded range on the stopped session; Close Session clears it', async () => {
    const skillPath = path.resolve(FIXTURES_DIR, 'fake-skill.md');
    const skillUri = vscode.Uri.file(skillPath);
    const testUri = fixtureUri('test-with-steps.md');
    const frame = {
      id: 'f1',
      parentId: null,
      kind: 'skill',
      uri: skillPath,
      line: 9, // the [skill: ...] line in the test file
      skillName: 'fake_skill',
    };

    // Run the test and drive a failure on a skill-body step (line 12).
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'frame:push', frame });
    fake.push({ type: 'step:start', line: 12, frame });
    fake.push({ type: 'step:fail', line: 12, error: 'boom', frame });
    fake.end();
    await waitFor('skill failure parked', () => hooks.skillFailureParked());

    // The debug context is set ONLY on an explicit Stop, not on the failure.
    assert.equal(hooks.skillDebugActive(), false, 'no debug context before Stop');

    // Stop captures the context (the browser/session stays alive).
    await vscode.commands.executeCommand('testbench-native.stop');
    await waitFor('debug context parked after Stop', () => hooks.skillDebugActive());
    const ctx = hooks.skillDebugContext();
    assert.equal(ctx.testUri, testUri.toString(), 'context points at the owning test');
    assert.equal(ctx.skillUri, skillPath, 'context points at the skill file');
    assert.equal(ctx.skillName, 'fake_skill', 'context carries the skill name');
    assert.equal(ctx.testLine, 9, 'context carries the [skill:] invocation line');

    // Open the skill file and select steps 2–3 (lines 12–13), then run them
    // on the stopped session.
    await vscode.commands.executeCommand('vscode.open', skillUri);
    await waitFor('skill editor active', () => {
      const e = vscode.window.activeTextEditor;
      return e && e.document.uri.toString() === skillUri.toString();
    });
    vscode.window.activeTextEditor.selection = new vscode.Selection(
      new vscode.Position(11, 0), // line 12
      new vscode.Position(12, 5), // line 13
    );

    const before = fake.requests.length;
    await vscode.commands.executeCommand('testbench-native.runSkillStepsOnStoppedSession');
    await waitFor('a bounded re-run request was issued', () => fake.requests.length > before);

    const req = fake.requests[fake.requests.length - 1];
    assert.ok(req.startAt, 'request carries startAt (partial re-run)');
    assert.equal(req.startAt.uri, skillPath, 'startAt.uri is the skill file');
    assert.equal(req.startAt.line, 12, 'startAt is the first selected step');
    assert.ok(req.endAt, 'request carries endAt (bounded slice — not run-to-end)');
    assert.equal(req.endAt.line, 13, 'endAt is the last selected step');
    assert.ok(
      fake.isSessionAliveCalls.length >= 1,
      'a liveness pre-flight ran before the re-run',
    );

    // Finish the re-run stream so the controller goes idle.
    fake.end();
    await waitFor('idle after re-run', () => !hooks.isRunning());

    // Close Session clears the debug context (the page is gone). Close Session
    // acts on the active *test* file, so switch back to it first — the skill
    // file was active for the re-run.
    await vscode.commands.executeCommand('vscode.open', testUri);
    await waitFor('test editor active + detected as test file', () => {
      const e = vscode.window.activeTextEditor;
      return (
        e &&
        e.document.uri.toString() === testUri.toString() &&
        hooks.tracker.snapshot().isTestFile === true
      );
    });
    await vscode.commands.executeCommand('testbench-native.restartSession');
    await waitFor('context cleared on Close Session', () => !hooks.skillDebugActive());
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

  // ── Resume position-anchor: second consumer (dispatchStep / Step Into) ──
  //
  // continueRun and dispatchStep share the identical `breakpointStop` filter,
  // so the anchor fix must hold for BOTH. This covers Step Into resuming from
  // a breakpoint pause after a step is inserted above the pause line; the
  // shifted step is the one that re-runs, not the inserted ghost.
  it('Step Into after inserting a step ABOVE the pause line relaunches the original step (no ghost)', async () => {
    const uri = vscode.window.activeTextEditor.document.uri;
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(9, 0)), // line 10
        true,
      ),
    ]);

    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('first stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 8 });
    fake.push({ type: 'step:pass', line: 8 });
    fake.push({ type: 'step:start', line: 9 });
    fake.push({ type: 'step:pass', line: 9 });
    fake.end();
    await waitFor('paused at line 10', () => hooks.tracker.snapshot().breakpointStop === 10);
    await waitFor('idle while paused', () => !hooks.isRunning());

    // Insert a step on line 9 (above the pause line). Original step 3 → 11.
    const editor = vscode.window.activeTextEditor;
    const inserted = await editor.edit((b) => {
      b.insert(new vscode.Position(8, 0), '2.5. Inserted ghost step\n');
    });
    assert.ok(inserted, 'editor.edit (insert) should apply');
    await waitFor('anchor shifted to line 11 after insert above', () => {
      return hooks.tracker.snapshot().breakpointStop === 11;
    });

    const requestsBefore = fake.requests.length;
    // dispatchStep with mode 'into' is the second consumer of breakpointStop.
    void vscode.commands.executeCommand('testbench-native.stepInto');
    await waitFor('Step Into relaunch stream opens', () => fake.requests.length > requestsBefore);
    const stepRequest = fake.requests[requestsBefore];
    assert.ok(stepRequest, 'Step Into from a breakpoint pause must open a new stream');
    assert.deepEqual(
      stepRequest.sourceLines,
      [11],
      `Step Into must relaunch the original step (now line 11), not the inserted ghost. Got ${JSON.stringify(stepRequest.sourceLines)}.`,
    );

    fake.end();
    await waitFor('idle after Step Into', () => !hooks.isRunning());
    try {
      await vscode.commands.executeCommand('workbench.action.revertActiveEditor');
    } catch {
      // best-effort — beforeEach closeAllEditors is the backstop
    }
  });

  // ── Re-run a skill step with its variables ───────────────────────────────
  it('a top-level skill step failure offers a seeded re-run from the failed step on the live session', async () => {
    const skillUri = vscode.Uri.file(path.resolve(FIXTURES_DIR, 'fake-skill.md'));
    const frame = {
      id: 'f1', parentId: null, kind: 'skill',
      uri: skillUri.fsPath, line: 9, skillName: 'fake_skill',
    };

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    // Descend into a top-level skill, capture a scope (incl. a __skill* internal
    // that must never be seeded), then fail a body step.
    fake.push({ type: 'frame:push', frame });
    fake.push({
      type: 'frame:scope',
      frameId: 'f1',
      scope: { query: 'cats', first_result_url: 'http://x', __skill1_tmp: 'internal' },
    });
    fake.push({ type: 'step:start', line: 8, frame });
    fake.push({ type: 'step:fail', line: 8, error: 'boom', frame });
    fake.end();
    await waitFor('idle after the failed skill run', () => !hooks.isRunning());

    // The re-run stream (index 1) ends immediately — we assert on the request
    // the extension sends, not on a scripted result.
    fake.streamScripts[1] = (f) => f.end();

    // Fire the Variables-panel "Re-run from failed step" with one edit. The
    // test file stays active (skill reveal uses preserveFocus), so its URI is
    // the controller key the host routes by.
    const testUri = vscode.window.activeTextEditor.document.uri.toString();
    void hooks.dispatchWebviewMessage({
      type: 'rerunSkillStep',
      testUri,
      edits: { first_result_url: 'http://edited' },
    });
    await waitFor('re-run request sent', () => fake.requests.length >= 2);

    const req = fake.requests[1];
    assert.ok(req.startAt, 'partial re-run must carry a startAt anchor');
    assert.equal(req.startAt.uri, skillUri.fsPath, 'startAt targets the skill file');
    assert.equal(req.startAt.line, 8, 'startAt targets the failed step line');
    assert.ok(req.seedScope, 'must carry seedScope');
    assert.equal(req.seedScope.query, 'cats', 'seeds the captured value');
    assert.equal(req.seedScope.first_result_url, 'http://edited', 'applies the user edit');
    assert.ok(!('__skill1_tmp' in req.seedScope), '__skill* internals are never seeded');
    assert.ok(fake.isSessionAliveCalls.length >= 1, 'must probe session liveness first');

    await waitFor('idle after re-run', () => !hooks.isRunning());
  });

  it('refuses the skill re-run when the session is no longer alive', async () => {
    const skillUri = vscode.Uri.file(path.resolve(FIXTURES_DIR, 'fake-skill.md'));
    const frame = {
      id: 'f1', parentId: null, kind: 'skill',
      uri: skillUri.fsPath, line: 9, skillName: 'fake_skill',
    };

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'frame:push', frame });
    fake.push({ type: 'frame:scope', frameId: 'f1', scope: { query: 'cats' } });
    fake.push({ type: 'step:start', line: 8, frame });
    fake.push({ type: 'step:fail', line: 8, error: 'boom', frame });
    fake.end();
    await waitFor('idle after the failed skill run', () => !hooks.isRunning());

    // The server has dropped the session — the pre-flight must refuse, and the
    // parked failure must survive (panel stays).
    fake.sessionAlive = false;
    const testUri = vscode.window.activeTextEditor.document.uri.toString();
    void hooks.dispatchWebviewMessage({ type: 'rerunSkillStep', testUri, edits: {} });
    await waitFor('liveness probed', () => fake.isSessionAliveCalls.length >= 1);
    await sleep(150);

    assert.equal(fake.requests.length, 1, 'a dead session must not open a re-run stream');
    assert.ok(
      hooks.skillFailureParked(),
      'a refused re-run must NOT wipe the parked failure (panel stays)',
    );
    await waitFor('still idle', () => !hooks.isRunning());
  });
});

/**
 * Section tables paint from the frames (stories/data-row-progress-and-selection.md
 * §Section tables).
 *
 * The section-level loop is the SERVER's — the expander stamps every looped
 * body's frame with `iteration` and `iterationCount`, and the session manager
 * copies both onto the wire frame. So the only thing that knows which row of a
 * section's table is running is the frame, and these tests drive exactly that:
 * a `frame:push` carrying `iteration: n` bands row n, the matching `frame:pop`
 * resolves it, and a failed iteration — which ends the run, part B's rule —
 * leaves every later row as never-reached.
 */
describe('TestBench section-table painting', function () {
  this.timeout(20_000);

  /** @type {FakeApiClient} */
  let fake;
  let hooks;

  const fs = require('node:fs');
  const FIXTURE = 'section-rows.tmp.md';

  // Line 9 is the section table's header; 11, 12 and 13 are its three rows;
  // 15 is the body's one step; 5 is the step whose text names the section.
  const HEADER_LINE = 9;
  const ROW_LINES = [11, 12, 13];
  const BODY_STEP_LINE = 15;
  const CALL_LINE = 5;
  const SECTION = 'Upload each statement';

  const CONTENT = [
    '# Section rows',            // 1
    '',                          // 2
    '## Steps',                  // 3
    '1. Sign in',                // 4
    '2. Upload each statement',    // 5
    '3. Check the count',        // 6
    '',                          // 7
    '### Upload each statement', // 8
    '| file |',                  // 9
    '|------|',                  // 10
    '| a.pdf |',                 // 11
    '| b.pdf |',                 // 12
    '| c.pdf |',                 // 13
    '',                          // 14
    '1. Upload {{file}}',        // 15
    '',                          // 16
  ].join('\n');

  const uriOf = () => fixtureUri(FIXTURE);

  before(async () => {
    fs.writeFileSync(path.resolve(FIXTURES_DIR, FIXTURE), CONTENT);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks not exposed');
  });

  after(() => {
    try { fs.unlinkSync(path.resolve(FIXTURES_DIR, FIXTURE)); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }
    fake = new FakeApiClient();
    hooks.setApiClientFactory(() => fake);

    const uri = uriOf();
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('fixture editor active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === uri.toString();
    });
    await waitFor('detected as test file', () => hooks.tracker.snapshot().isTestFile === true);
  });

  /** A looped section body's frame, as the server stamps it. */
  const iterationFrame = (n) => ({
    id: `s${n}`,
    parentId: null,
    kind: 'section',
    uri: uriOf().fsPath,
    line: CALL_LINE,
    skillName: SECTION,
    iteration: n,
    iterationCount: 3,
  });

  /** The status on each section-table row line, in table order. */
  const rowStatuses = () => {
    const snap = hooks.tracker.snapshotFor(uriOf());
    const byLine = new Map(snap ? snap.statuses : []);
    return ROW_LINES.map((line) => byLine.get(line) ?? null);
  };

  const sectionTable = () =>
    hooks.rowTablesForTests(uriOf()).find((t) => t.section === SECTION);

  it('sees the section table, and only its data rows', async () => {
    const table = sectionTable();
    assert.ok(table, 'the section table must be discovered');
    assert.equal(table.headerLine, HEADER_LINE);
    // Not the header, not the delimiter — a status cell on either would read
    // as "the table passed", which is not a thing.
    assert.deepEqual(table.rowLines, ROW_LINES);
  });

  it('a frame push with an iteration bands that row; the pop resolves it', async () => {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'frame:push', frame: iterationFrame(1) });
    await waitFor('iteration 1 running', () => rowStatuses()[0] === 'running');
    assert.deepEqual(rowStatuses(), ['running', null, null]);
    assert.equal(sectionTable().summary, '3 rows · iteration 1 of 3 running');

    fake.push({ type: 'frame:pop', frameId: 's1', outputs: {} });
    await waitFor('iteration 1 passed', () => rowStatuses()[0] === 'pass');

    fake.push({ type: 'frame:push', frame: iterationFrame(2) });
    await waitFor('iteration 2 running', () => rowStatuses()[1] === 'running');
    assert.equal(sectionTable().summary, '3 rows · iteration 2 of 3 running · 1 passed');

    fake.push({ type: 'frame:pop', frameId: 's2', outputs: {} });
    fake.push({ type: 'frame:push', frame: iterationFrame(3) });
    fake.push({ type: 'frame:pop', frameId: 's3', outputs: {} });
    await waitFor('all three iterations passed', () =>
      rowStatuses().every((s) => s === 'pass'));

    fake.end();
    await waitFor('idle after stream ends', () => !hooks.isRunning());
    assert.equal(sectionTable().summary, '3 rows · 3 passed');
  });

  it('a failed iteration marks its row and leaves the later rows never-reached', async () => {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'frame:push', frame: iterationFrame(1) });
    fake.push({ type: 'frame:pop', frameId: 's1', outputs: {} });
    await waitFor('iteration 1 passed', () => rowStatuses()[0] === 'pass');

    const frame = iterationFrame(2);
    fake.push({ type: 'frame:push', frame });
    fake.push({
      type: 'step:fail',
      line: BODY_STEP_LINE,
      error: 'no file chooser appeared',
      frame,
    });
    fake.push({ type: 'frame:pop', frameId: 's2', outputs: {} });
    await waitFor('iteration 2 failed', () => rowStatuses()[1] === 'fail');

    // A failed iteration ends the run, so row 3 is a row the loop planned and
    // never reached — not an unrun row with no result.
    assert.deepEqual(rowStatuses(), ['pass', 'fail', 'skip']);

    const failures = new Map(hooks.tracker.snapshotFor(uriOf()).failures);
    // A section's steps are counted within the section: "step 1 of the
    // section", not "step 15" — and not "body step 1", which was jargon.
    assert.match(
      failures.get(ROW_LINES[1]).error,
      /^Iteration 2 failed at step 1 of the section — "Upload \{\{file\}\}"/,
    );
    assert.match(failures.get(ROW_LINES[1]).error, /no file chooser appeared/);
    assert.equal(
      failures.get(ROW_LINES[2]).error,
      'Iteration 3 not run (iteration 2 failed)',
    );

    fake.end();
    await waitFor('idle after stream ends', () => !hooks.isRunning());
    assert.equal(sectionTable().summary, '3 rows · 1 passed · 1 failed · 1 not run');
  });

  it('a server too old to honour rowNumbers cannot paint the wrong row', async () => {
    // `rowNumbers`/`rowCount` are new optional fields on a section payload,
    // and a pre-upgrade Sessions API server drops what it does not know: it
    // receives one row, numbers it `iteration 1 of 1`, and the extension would
    // paint row 1 of a run narrowed to row 2 — a green mark on the wrong line,
    // `(1/1)` in the report, and no error anywhere.
    //
    // The client shipped the rows, so it knows what the k-th of them is
    // called; the frame does not get to overrule that. The mismatch is still
    // said out loud, because the REPORT is written by the old server and only
    // a restart fixes it.
    const mark = hooks.hostMessageCount();
    void hooks.dispatchWebviewMessage({
      type: 'runRows',
      sectionRows: { [SECTION]: [2] },
    });
    await waitFor('stream active', () => fake.hasActiveStream);

    // Exactly what an old server sends: iteration 1 of 1, for row 2.
    fake.push({
      type: 'frame:push',
      frame: { ...iterationFrame(1), iterationCount: 1 },
    });
    await waitFor('a row is banded', () => rowStatuses().some((s) => s === 'running'));
    assert.deepEqual(
      rowStatuses(),
      [null, 'running', null],
      'the row the author chose, not the one the server numbered',
    );

    fake.push({ type: 'frame:pop', frameId: 's1', outputs: {} });
    await waitFor('row 2 passed', () => rowStatuses()[1] === 'pass');
    assert.deepEqual(rowStatuses(), [null, 'pass', null]);

    const warnings = hooks
      .hostMessagesSince(mark)
      .filter((m) => m.type === 'runEvent' && m.event.type === 'output')
      .map((m) => m.event.msg)
      .filter((msg) => msg.includes('the server numbered this iteration'));
    assert.deepEqual(warnings, [
      `${SECTION} — the server numbered this iteration 1 of 1; restart or update ` +
        'the Sessions API server for correct row numbering in the report',
    ], 'said once, and only once — the fact is about the server, not the row');

    fake.end();
    await waitFor('idle after stream ends', () => !hooks.isRunning());
  });

  it('says nothing when the server DOES honour rowNumbers', async () => {
    const mark = hooks.hostMessageCount();
    void hooks.dispatchWebviewMessage({
      type: 'runRows',
      sectionRows: { [SECTION]: [2] },
    });
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'frame:push', frame: iterationFrame(2) });
    await waitFor('row 2 running', () => rowStatuses()[1] === 'running');
    fake.push({ type: 'frame:pop', frameId: 's2', outputs: {} });
    await waitFor('row 2 passed', () => rowStatuses()[1] === 'pass');

    const warnings = hooks
      .hostMessagesSince(mark)
      .filter((m) => m.type === 'runEvent' && m.event.type === 'output')
      .map((m) => m.event.msg)
      .filter((msg) => msg.includes('the server numbered this iteration'));
    assert.deepEqual(warnings, [], 'a current server is not warned about');

    fake.end();
    await waitFor('idle after stream ends', () => !hooks.isRunning());
  });
});

/**
 * The three ways a row's mark can be written by something that is NOT a step
 * of this test file (stories/data-row-progress-and-selection.md §Hovers,
 * §"Across run rows", §"Painting follows the frames").
 *
 * All three are the same mistake in different clothes: a frame belongs to a
 * FILE, and reading the test document at that frame's line numbers — or
 * matching that frame's section name against this document's tables — puts a
 * mark, or a quoted step, where it does not belong.
 */
describe('TestBench row marks from other files and other run rows', function () {
  this.timeout(20_000);

  /** @type {FakeApiClient} */
  let fake;
  let hooks;

  const fs = require('node:fs');
  const SKILL_FIXTURE = 'rows-skill.tmp.md';
  const BOTH_FIXTURE = 'rows-and-section.tmp.md';

  // rows-skill.tmp.md — a run table whose step calls a skill.
  // Line 7 header, 9/10 the rows, 12/13 the steps.
  const SKILL_CONTENT = [
    '# Rows into a skill',                 // 1
    '',                                    // 2
    '## Config',                           // 3
    '- baseUrl: http://localhost:8787/',   // 4
    '',                                    // 5
    '## Steps',                            // 6
    '| email |',                           // 7
    '|-------|',                           // 8
    '| a@b.c |',                           // 9
    '| d@e.f |',                           // 10
    '',                                    // 11
    '1. [skill: sign in] as {{email}}',    // 12
    '2. Check the dashboard',              // 13
    '',                                    // 14
  ].join('\n');

  // rows-and-section.tmp.md — BOTH tables, which is the only shape in which a
  // section row is repainted by a later run row.
  // Line 7 header, 9/10 the run rows, 12/13 the steps, 15 the section heading,
  // 16 header, 18/19 the section rows, 20 the body step.
  const BOTH_CONTENT = [
    '# Both tables',                       // 1
    '',                                    // 2
    '## Config',                           // 3
    '- baseUrl: http://localhost:8787/',   // 4
    '',                                    // 5
    '## Steps',                            // 6
    '| email |',                           // 7
    '|-------|',                           // 8
    '| a@b.c |',                           // 9
    '| d@e.f |',                           // 10
    '',                                    // 11
    '1. Sign in as {{email}}',             // 12
    '2. Upload each statement',            // 13
    '',                                    // 14
    '### Upload each statement',           // 15
    '| file  |',                           // 16
    '|-------|',                           // 17
    '| a.pdf |',                           // 18
    '| b.pdf |',                           // 19
    '1. Upload {{file}}',                  // 20
    '',                                    // 21
  ].join('\n');

  before(async () => {
    fs.writeFileSync(path.resolve(FIXTURES_DIR, SKILL_FIXTURE), SKILL_CONTENT);
    fs.writeFileSync(path.resolve(FIXTURES_DIR, BOTH_FIXTURE), BOTH_CONTENT);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks not exposed');
  });

  after(() => {
    for (const name of [SKILL_FIXTURE, BOTH_FIXTURE]) {
      try { fs.unlinkSync(path.resolve(FIXTURES_DIR, name)); } catch { /* ignore */ }
    }
  });

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }
    fake = new FakeApiClient();
    hooks.setApiClientFactory(() => fake);
  });

  async function open(name) {
    const uri = fixtureUri(name);
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('fixture editor active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === uri.toString();
    });
    await waitFor('detected as test file', () => hooks.tracker.snapshot().isTestFile === true);
    return uri;
  }

  const statusesOf = (uri, lines) => {
    const snap = hooks.tracker.snapshotFor(uri);
    const byLine = new Map(snap ? snap.statuses : []);
    return lines.map((line) => byLine.get(line) ?? null);
  };
  const failureAt = (uri, line) =>
    new Map(hooks.tracker.snapshotFor(uri).failures).get(line);

  it('a row that dies inside a skill names the SKILL, not a step of the test', async () => {
    // `mainFlowOrdinal` and `stepTextAt` read the TEST document at the
    // failure's line, so a skill-body failure on line 12 was reported as
    // `Row 1 failed at step 1 — "[skill: sign in] as {{email}}"`: the call
    // rather than the step that failed, with an ordinal that means nothing in
    // the skill.
    const uri = await open(SKILL_FIXTURE);
    const skillPath = path.resolve(FIXTURES_DIR, 'sign-in.tmp.md');
    const frame = {
      id: 'f1',
      parentId: null,
      kind: 'skill',
      uri: skillPath,
      line: 12,
      skillName: 'sign in',
    };
    fake.streamScripts = [
      (f) => {
        f.push({ type: 'frame:push', frame });
        f.push({ type: 'step:fail', line: 12, error: 'no sign-in button', frame });
        f.push({ type: 'frame:pop', frameId: 'f1', outputs: {} });
        f.end();
      },
      (f) => f.end(),
    ];
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('two requests', () => fake.requests.length >= 2);
    await waitFor('run finished', () => hooks.isRunning() === false);

    assert.deepEqual(statusesOf(uri, [9, 10]), ['fail', 'pass']);
    const hover = failureAt(uri, 9).error;
    assert.match(hover, /^Row 1 failed in sign-in\.tmp\.md/);
    assert.match(hover, /no sign-in button/);
    assert.doesNotMatch(hover, /failed at step/, 'the test file has no say about a skill line');
    assert.doesNotMatch(hover, /\{\{email\}\}/, 'and its step text must not be quoted');
  });

  it('a looped section in ANOTHER file does not paint this file’s table', async () => {
    // A section name is unique within a file and not across files. Without the
    // URI guard, a skill with its own `### Upload each statement` painted the
    // TEST's table of that name, for iterations of a table nobody can see.
    const uri = await open(BOTH_FIXTURE);
    fake.streamScripts = [() => { /* leave row 1 running */ }];
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({
      type: 'frame:push',
      frame: {
        id: 'x1',
        parentId: null,
        kind: 'section',
        uri: path.resolve(FIXTURES_DIR, 'some-skill.tmp.md'),
        line: 13,
        skillName: 'Upload each statement',
        iteration: 1,
        iterationCount: 2,
      },
    });
    // The frame reaches the controller through the same router as any other,
    // so give it long enough to have painted if it were going to.
    await sleep(300);
    assert.deepEqual(
      statusesOf(uri, [18, 19]),
      [null, null],
      'a section of another file cannot mark this table',
    );

    await vscode.commands.executeCommand('testbench-native.stop');
    await waitFor('idle', () => hooks.isRunning() === false);
  });

  it('a section row that failed on run row 1 stays failed after a clean run row 2', async () => {
    // The section table is looped once per RUN row, and each iteration starts
    // by setting its row `running` — which clears the detail and the hover. So
    // run row 2 erased run row 1's failure and the row ended green: the "green
    // after red" that §"Across run rows" forbids.
    const uri = await open(BOTH_FIXTURE);
    const iterationFrame = (id) => ({
      id,
      parentId: null,
      kind: 'section',
      uri: uri.fsPath,
      line: 13,
      skillName: 'Upload each statement',
      iteration: 1,
      iterationCount: 2,
    });
    fake.streamScripts = [
      (f) => {
        const frame = iterationFrame('a1');
        f.push({ type: 'frame:push', frame });
        f.push({ type: 'step:fail', line: 20, error: 'no file chooser appeared', frame });
        f.push({ type: 'frame:pop', frameId: 'a1', outputs: {} });
        f.end();
      },
      (f) => {
        const frame = iterationFrame('b1');
        f.push({ type: 'frame:push', frame });
        f.push({ type: 'frame:pop', frameId: 'b1', outputs: {} });
        f.end();
      },
    ];
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('two requests', () => fake.requests.length >= 2);
    await waitFor('run finished', () => hooks.isRunning() === false);

    assert.equal(
      statusesOf(uri, [18])[0],
      'fail',
      'run row 2 repainted this row; the worst of the two is what stays',
    );
    const hover = failureAt(uri, 18).error;
    assert.match(hover, /^Iteration 1 failed at step 1 of the section/);
    assert.match(hover, /no file chooser appeared/);
    // …and it says which run row it is about, since the reader cannot see
    // that from the table any more.
    assert.match(hover, /On run row 1\.$/);
  });
});

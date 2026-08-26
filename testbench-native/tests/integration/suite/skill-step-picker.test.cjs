/**
 * The skill-file session picker
 * (stories/specs/run-and-compile-a-skill-step.md).
 *
 * In a SKILL file, Run Step Here / Compile This Step open a picker of the
 * sessions the step could run in; a test-session pick routes the test's own
 * `[skill:]` call line through THAT test's controller as a bounded
 * `startAt`/`endAt` slice — plus `compile: 'steps'` for a compile pick.
 *
 * The decisive assertions are the decoupling ones: an injected pick must
 * carry NO inherited compile mode and NO `compileContinues`, even when the
 * picked controller's last fresh run was Run & Compile. Before the fix, the
 * inherited mode silently spent a generation the caller never saw and — in
 * `'run'` mode — replaced the test's whole recording dir with a one-step
 * recording; the stamped `compileContinues` re-opened a RETAINED compiler
 * from a previously completed compile instead of superseding it.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');
const { FakeApiClient } = require('../fakes/fake-api-client.cjs');

const EXT_ID = 'pkent.testbench-native';
const FIXTURES_DIR =
  process.env.TESTBENCH_FIXTURES_DIR || path.resolve(__dirname, '..', 'fixtures');
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

describe('skill-file session picker', function () {
  this.timeout(20_000);

  /** @type {FakeApiClient} */
  let fake;
  let hooks;

  const skillPath = path.resolve(FIXTURES_DIR, 'fake-skill.md');
  const skillUri = vscode.Uri.file(skillPath);
  /** A top-level skill frame anchored at the test's `[skill:]` line (9). */
  const frame = {
    id: 'f1',
    parentId: null,
    kind: 'skill',
    uri: skillPath,
    line: 9,
    skillName: 'fake_skill',
  };

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
    hooks.setSkillSessionPicker(null);

    const uri = fixtureUri('test-with-steps.md');
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('fixture editor active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === uri.toString();
    });
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(8, 0),
      new vscode.Position(8, 5),
    );
    await waitFor('active file detected as test file', () => {
      return hooks.tracker.snapshot().isTestFile === true;
    });
  });

  afterEach(() => {
    hooks.setSkillSessionPicker(null);
  });

  /** Run the test, fail a skill-body step, end the stream — parks the
   *  paused-on-error anchors without a Stop. `compile` runs it as
   *  Run & Compile, which is what arms the inheritance hazard. */
  async function parkPausedFailure({ compile = false } = {}) {
    void vscode.commands.executeCommand(
      compile ? 'testbench-native.runAndCompile' : 'testbench-native.runSelected',
    );
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'frame:push', frame });
    fake.push({ type: 'step:start', line: 12, frame });
    fake.push({ type: 'step:fail', line: 12, error: 'boom', frame });
    if (compile) {
      // A terminal result keeps presentCompile off its "older server?"
      // warning path; empty files mean no diff editors to clean up.
      fake.push({
        type: 'compile:result',
        status: 'partial',
        files: {},
        summary: {
          test: fixtureUri('test-with-steps.md').fsPath,
          totalSteps: 1,
          compiled: 0,
          kept: 0,
          keptAi: 0,
          rounds: 0,
          tokensUsed: 0,
          written: [],
          unproven: [],
          writtenOffAi: [],
          notAttempted: [],
          recordingDir: '',
          stoppedAt: { step: 1, error: 'boom' },
        },
      });
    }
    fake.end();
    await waitFor('skill failure parked', () => hooks.skillFailureParked());
    await waitFor('idle', () => !hooks.isRunning());
  }

  async function openSkillEditor() {
    await vscode.commands.executeCommand('vscode.open', skillUri);
    // The TRACKER's view of the active editor is what the commands read —
    // wait for it, not just for VS Code's own activeTextEditor.
    await waitFor('skill editor active + tracked', () => {
      const e = vscode.window.activeTextEditor;
      return (
        e &&
        e.document.uri.toString() === skillUri.toString() &&
        hooks.tracker.snapshot().isTestFile === true
      );
    });
  }

  it('a ⏸ run pick routes a one-step slice through the picked test session', async () => {
    await parkPausedFailure();
    await openSkillEditor();

    let offered;
    hooks.setSkillSessionPicker((targets) => {
      offered = targets;
      return targets.find((t) => t.kind === 'paused');
    });

    const before = fake.requests.length;
    void vscode.commands.executeCommand('testbench-native.runStepHere', { lineNumber: 12 });
    await waitFor('slice request issued', () => fake.requests.length > before);

    // Rows in presentation order: the anchored test first, standalone last —
    // and the pick was never made silently (the hook stands in for the
    // QuickPick the user would see).
    assert.equal(offered[0].kind, 'paused', 'anchored test sorts first');
    assert.equal(offered[offered.length - 1].kind, 'standalone', 'standalone is always last');
    assert.equal(offered[0].callLine, 9, 'the row carries the [skill:] call line');

    assert.ok(fake.isSessionAliveCalls.length >= 1, 'liveness pre-flight ran before the run');
    const req = fake.requests[fake.requests.length - 1];
    // Case-folded: `uri.fsPath` lower-cases the drive letter, `path.resolve`
    // does not, and the server's anchor matching folds the case anyway.
    assert.equal(
      req.startAt.uri.toLowerCase(),
      skillPath.toLowerCase(),
      'startAt anchors into the skill file',
    );
    assert.equal(req.startAt.line, 12, 'startAt is the clicked step');
    assert.equal(req.endAt.line, 12, 'endAt equals startAt — a true single-step slice');
    assert.equal(req.compile, undefined, 'a run pick carries no compile mode');
    assert.equal(req.compileContinues, undefined, 'and never compileContinues');
    const sid = fake.streamSessionIds[fake.streamSessionIds.length - 1];
    assert.ok(
      sid.toLowerCase().includes('test-with-steps'),
      `the slice runs in the TEST's session, not the skill's (got: ${sid})`,
    );

    // A passing pick CONSUMES the paused anchors — the test demotes to a
    // plain open-session row next time, and the panel affordance is
    // withdrawn rather than left offering an action that can only refuse.
    fake.push({ type: 'step:start', line: 12, frame });
    fake.push({ type: 'step:pass', line: 12, frame });
    fake.end();
    await waitFor('idle after slice', () => !hooks.isRunning());
    assert.equal(hooks.skillFailureParked(), false, 'a passing pick consumed the paused anchor');
  });

  it('an injected pick never inherits the compile of a previous Run & Compile', async () => {
    await parkPausedFailure({ compile: true });
    const armed = fake.requests[0];
    assert.equal(armed.compile, 'run', 'precondition: the previous fresh run was Run & Compile');

    await openSkillEditor();
    hooks.setSkillSessionPicker((targets) => targets.find((t) => t.kind === 'paused'));

    const before = fake.requests.length;
    void vscode.commands.executeCommand('testbench-native.runStepHere', { lineNumber: 12 });
    await waitFor('slice request issued', () => fake.requests.length > before);

    const req = fake.requests[fake.requests.length - 1];
    // The latent bug this pins down: `isContinuation` used to inherit
    // `compileModeOfRun` and stamp `compileContinues` — a silent generation
    // spend, and (mode 'run') a wholesale recording write replacing the
    // test's recording dir with a one-step recording.
    assert.equal(req.compile, undefined, 'no inherited compile mode on an injected run');
    assert.equal(req.compileContinues, undefined, 'no compileContinues on an injected first block');

    fake.push({ type: 'step:start', line: 12, frame });
    fake.push({ type: 'step:pass', line: 12, frame });
    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('a ⏸ compile pick rides compile:"steps" on the slice, superseding — not continuing — the old compiler', async () => {
    await parkPausedFailure({ compile: true });
    await openSkillEditor();
    hooks.setSkillSessionPicker((targets) => targets.find((t) => t.kind === 'paused'));

    const before = fake.requests.length;
    void vscode.commands.executeCommand('testbench-native.compileStepCodeBehind', {
      lineNumber: 12,
    });
    await waitFor('compile slice request issued', () => fake.requests.length > before);

    const req = fake.requests[fake.requests.length - 1];
    assert.equal(req.compile, 'steps', 'the compile rides the slice');
    assert.equal(
      req.compileContinues,
      undefined,
      'first block of an injected compile supersedes any retained compiler',
    );
    assert.equal(req.compileScope, undefined, 'no compileScope — the real skill frame binds');
    assert.equal(req.startAt.line, 12);
    assert.equal(req.endAt.line, 12);
    const sid = fake.streamSessionIds[fake.streamSessionIds.length - 1];
    assert.ok(sid.toLowerCase().includes('test-with-steps'), 'compiles in the TEST session');

    fake.push({ type: 'step:start', line: 12, frame });
    fake.push({ type: 'step:pass', line: 12, frame });
    fake.push({
      type: 'compile:result',
      status: 'partial',
      files: {},
      summary: {
        test: fixtureUri('test-with-steps.md').fsPath,
        totalSteps: 1,
        compiled: 1,
        kept: 0,
        keptAi: 0,
        rounds: 0,
        tokensUsed: 5,
        written: [],
        unproven: [2],
        writtenOffAi: [],
        notAttempted: [],
        recordingDir: '',
      },
    });
    fake.end();
    await waitFor('idle after compile slice', () => !hooks.isRunning());
    assert.equal(hooks.lastCompileError(), null, 'the compile pick completed cleanly');
  });

  it('the standalone row keeps today\'s behaviour: a plain run in the skill\'s own session', async () => {
    await openSkillEditor();
    hooks.setSkillSessionPicker((targets) => targets.find((t) => t.kind === 'standalone'));

    const before = fake.requests.length;
    void vscode.commands.executeCommand('testbench-native.runStepHere', { lineNumber: 12 });
    await waitFor('standalone request issued', () => fake.requests.length > before);

    const req = fake.requests[fake.requests.length - 1];
    assert.equal(req.startAt, undefined, 'standalone is a plain run, not a slice');
    assert.equal(req.compile, undefined);
    const sid = fake.streamSessionIds[fake.streamSessionIds.length - 1];
    assert.ok(
      sid.toLowerCase().includes('fake-skill'),
      `standalone runs in the skill file's own session (got: ${sid})`,
    );
    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('a cancelled picker runs nothing', async () => {
    await parkPausedFailure();
    await openSkillEditor();
    hooks.setSkillSessionPicker(() => undefined);

    const before = fake.requests.length;
    void vscode.commands.executeCommand('testbench-native.runStepHere', { lineNumber: 12 });
    await sleep(400);
    assert.equal(fake.requests.length, before, 'no request without a pick');
    assert.equal(hooks.skillFailureParked(), true, 'the anchor is untouched');
  });
});

/**
 * Inline sections, end to end inside a real VS Code extension host.
 *
 * The fixture (`fixtures/sections.md`) has TWO sections and calls one of
 * them TWICE — the shape that breaks naive implementations, since one body
 * line then maps to several executed steps:
 *
 *      9. Open the shop
 *     10. Sign in            -> calls the section
 *     11. Add an item        -> calls the other section
 *     12. Sign in            -> again
 *     13. Check out
 *     ### Sign in       (15)
 *     17. Type the username
 *     18. Press submit
 *     ### Add an item   (20)
 *     22. Click the first product
 *     23. Click add to cart
 *
 * What these tests can and cannot prove: the harness uses `FakeApiClient`,
 * so the server is not involved. They assert what the CLIENT sends and how
 * it reacts to events — which is exactly the half a unit test can't reach
 * (commands, tracker state, decorations) and exactly the half the live suite
 * doesn't cover. The client<->server contract itself is guarded by the live
 * scenario, not by anything here.
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

/** Frame for a `### Sign in` invocation from main-flow line `line`. */
const signInFrame = (id, line, testPath) => ({
  id,
  parentId: null,
  kind: 'section',
  uri: testPath,
  line,
  skillName: 'Sign in',
});

describe('TestBench inline sections', function () {
  this.timeout(20_000);

  /** @type {FakeApiClient} */
  let fake;
  let hooks;
  let testPath;
  let testUri;

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

    testUri = fixtureUri('sections.md');
    testPath = testUri.fsPath;
    await vscode.commands.executeCommand('vscode.open', testUri);
    await waitFor('fixture editor active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === testUri.toString();
    });
    await waitFor('detected as test file', () => hooks.tracker.snapshot().isTestFile === true);
  });

  // -------------------------------------------------------------------------
  // The request payload
  // -------------------------------------------------------------------------

  it('Run All sends every section definition, and only main-flow steps', async () => {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    const request = fake.requests[0];
    assert.ok(request, 'no request captured');

    // Main flow only. If body lines leaked in here, the section would run
    // inline AND again at its call site — the double execution this whole
    // feature exists to prevent.
    assert.deepEqual(request.sourceLines, [9, 10, 11, 12, 13]);
    assert.deepEqual(request.steps, [
      'Open the shop',
      'Sign in',
      'Add an item',
      'Sign in',
      'Check out',
    ]);

    // The definitions the server cannot read for itself.
    assert.deepEqual(Object.keys(request.sections).sort(), ['add an item', 'sign in']);
    assert.deepEqual(request.sections['sign in'], {
      name: 'Sign in',
      headingLine: 15,
      steps: ['Type the username', 'Press submit'],
      stepLines: [17, 18],
    });
    assert.deepEqual(request.sections['add an item'], {
      name: 'Add an item',
      headingLine: 20,
      steps: ['Click the first product', 'Click add to cart'],
      stepLines: [22, 23],
    });

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('a breakpoint continuation re-sends the sections map', async () => {
    // The server holds no cross-batch document state, so a continuation that
    // omitted these would expand differently from the batch before it: its
    // section calls would reach the server with no definitions to expand.
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(new vscode.Location(testUri, new vscode.Position(11, 0))),
    ]);
    await waitFor('breakpoint registered', () => vscode.debug.breakpoints.length === 1);

    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);
    assert.ok(fake.requests[0].sections, 'first batch carried no sections');
    fake.end();
    await waitFor('first batch idle', () => !hooks.isRunning());

    void vscode.commands.executeCommand('testbench-native.continueRun');
    await waitFor('second stream active', () => fake.requests.length === 2);

    const continuation = fake.requests[1];
    assert.ok(continuation.sections, 'continuation dropped the sections map');
    assert.deepEqual(
      Object.keys(continuation.sections).sort(),
      ['add an item', 'sign in'],
      'continuation sent a different set of definitions',
    );

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('omits sections entirely for a file that defines none', async () => {
    // `{}` is truthy, and the server's gates read the field directly — an
    // empty map would move every sectionless run onto the expansion path.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const plain = fixtureUri('test-with-steps.md');
    await vscode.commands.executeCommand('vscode.open', plain);
    await waitFor('plain fixture active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === plain.toString();
    });

    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    assert.equal(
      Object.prototype.hasOwnProperty.call(fake.requests[0], 'sections'),
      false,
      'sectionless run must not carry the field at all',
    );

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  // -------------------------------------------------------------------------
  // Statuses on body lines
  // -------------------------------------------------------------------------

  it('paints body-line statuses in the test file, and aggregates onto the call line', async () => {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    const frame = signInFrame('f1', 10, testPath);
    fake.push({ type: 'step:pass', line: 9 });
    fake.push({ type: 'frame:push', frame });

    // The invocation line goes running on push — the aggregate treatment a
    // `[skill:]` line already gets, which sections inherit for free.
    await waitFor('call line running', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[10] === 'running';
    });

    fake.push({ type: 'step:start', line: 17, frame });
    fake.push({ type: 'step:pass', line: 17, frame });
    await waitFor('body line 17 passed', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[17] === 'pass';
    });

    fake.push({ type: 'step:pass', line: 18, frame });
    fake.push({ type: 'frame:pop', frameId: 'f1', outputs: {} });
    await waitFor('call line passed on pop', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[10] === 'pass';
    });

    // Body statuses land on the TEST file — sections beat skills here: the
    // whole run paints in one editor, no second file to open.
    const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    assert.equal(statuses[17], 'pass');
    assert.equal(statuses[18], 'pass');

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('a body-step failure marks the call line failed too', async () => {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    const frame = signInFrame('f1', 10, testPath);
    fake.push({ type: 'frame:push', frame });
    fake.push({ type: 'step:fail', line: 18, error: 'element not found', frame });

    await waitFor('body line failed', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[18] === 'fail';
    });
    await waitFor('call line failed', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[10] === 'fail';
    });

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  // -------------------------------------------------------------------------
  // Breakpoints and stepping inside a body
  // -------------------------------------------------------------------------

  it('pauses on a body line and resumes from it', async () => {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    const frame = signInFrame('f1', 10, testPath);
    fake.push({ type: 'frame:push', frame });
    // A body-line breakpoint pauses SERVER-side: the client cannot trim at
    // it, because body lines never appear in the runnable main-flow list.
    fake.push({ type: 'step:awaiting', line: 18, frame });

    await waitFor('paused arrow on the body line', () => {
      const snap = hooks.tracker.snapshot();
      return snap.breakpointStop === 18;
    });

    // Resume drives the server via run-control, not a new request — the
    // stream is still open.
    void vscode.commands.executeCommand('testbench-native.stepInto');
    await waitFor('run-control dispatched', () => fake.runControlCalls.length === 1);
    assert.equal(fake.runControlCalls[0].mode, 'into');

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('steps through a section frame with over and out', async () => {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    const frame = signInFrame('f1', 10, testPath);
    fake.push({ type: 'frame:push', frame });
    fake.push({ type: 'step:awaiting', line: 17, frame });
    await waitFor('paused in body', () => hooks.tracker.snapshot().breakpointStop === 17);

    void vscode.commands.executeCommand('testbench-native.stepOver');
    await waitFor('over dispatched', () => fake.runControlCalls.length === 1);
    assert.equal(fake.runControlCalls[0].mode, 'over');

    fake.push({ type: 'step:awaiting', line: 18, frame });
    await waitFor('paused on next body line', () => hooks.tracker.snapshot().breakpointStop === 18);

    void vscode.commands.executeCommand('testbench-native.stepOut');
    await waitFor('out dispatched', () => fake.runControlCalls.length === 2);
    assert.equal(fake.runControlCalls[1].mode, 'out');

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('a section frame appears in the call stack under its own name', async () => {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'frame:push', frame: signInFrame('f1', 10, testPath) });
    await waitFor('one frame on the stack', () => hooks.runningFrameStack().length === 1);

    const [top] = hooks.runningFrameStack();
    assert.equal(top.kind, 'section');
    assert.equal(top.skillName, 'Sign in');
    assert.equal(top.uri, testPath, 'a test-file section frame is defined by the test file');

    fake.push({ type: 'frame:pop', frameId: 'f1', outputs: {} });
    await waitFor('stack empty', () => hooks.runningFrameStack().length === 0);

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('a section invoked twice pushes two distinct frames', async () => {
    // Lines 10 and 12 both call `Sign in`. Their frames must be distinct, or
    // the second pop would close the first frame and statuses would land on
    // the wrong invocation line.
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'frame:push', frame: signInFrame('f1', 10, testPath) });
    await waitFor('first frame', () => hooks.runningFrameStack().length === 1);
    fake.push({ type: 'step:pass', line: 17, frame: signInFrame('f1', 10, testPath) });
    fake.push({ type: 'frame:pop', frameId: 'f1', outputs: {} });
    await waitFor('first pop', () => hooks.runningFrameStack().length === 0);

    fake.push({ type: 'frame:push', frame: signInFrame('f2', 12, testPath) });
    await waitFor('second frame', () => hooks.runningFrameStack().length === 1);
    assert.equal(hooks.runningFrameStack()[0].id, 'f2');
    fake.push({ type: 'frame:pop', frameId: 'f2', outputs: {} });
    await waitFor('second pop', () => hooks.runningFrameStack().length === 0);

    // Both call lines carry their own ✓.
    const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    assert.equal(statuses[10], 'pass');
    assert.equal(statuses[12], 'pass');

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('an amber ✗ from the first call stays on its step when the body is edited during a pause', async () => {
    // The registry remembers which lines a tolerated failure painted this run,
    // so a later trip through the step that passes cannot repaint it green
    // (`toleratedLines`, extension.ts). The memory is keyed by line and has to
    // move with the text the way the marks do: edited during a pause, it
    // pointed at whatever slid into the old line, and the Continue painted the
    // amber ✗ and its hover on a step that never failed while the step that did
    // went green.
    const statuses = () => Object.fromEntries(hooks.tracker.snapshot().statuses);
    const failures = () => Object.fromEntries(hooks.tracker.snapshot().failures);
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(new vscode.Location(testUri, new vscode.Position(11, 0))),
    ]);
    await waitFor('breakpoint registered', () => vscode.debug.breakpoints.length === 1);

    // First call: "Type the username" (17) fails and is tolerated; the run
    // parks at the breakpoint on the second call (12).
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);
    const first = signInFrame('f1', 10, testPath);
    fake.push({ type: 'step:start', line: 9 });
    fake.push({ type: 'step:pass', line: 9 });
    fake.push({ type: 'frame:push', frame: first });
    fake.push({ type: 'step:start', line: 17, frame: first });
    fake.push({ type: 'step:fail', line: 17, frame: first, error: 'no username box', tolerated: true });
    fake.push({ type: 'step:start', line: 18, frame: first });
    fake.push({ type: 'step:pass', line: 18, frame: first });
    fake.push({ type: 'frame:pop', frameId: 'f1', outputs: {} });
    fake.push({ type: 'step:start', line: 11 });
    fake.push({ type: 'step:pass', line: 11 });
    fake.end();
    await waitFor('parked at the second call', () => hooks.tracker.snapshot().breakpointStop === 12);
    await waitFor('idle while parked', () => !hooks.isRunning());

    const editor = vscode.window.activeTextEditor;
    try {
      // A new first body step: the tolerated step is on 18 now.
      assert.ok(await editor.edit((b) => b.insert(new vscode.Position(16, 0), '1. Wait for the form\n')));
      await waitFor('the amber ✗ moved with its step', () => statuses()[18] === 'fail-tolerated');

      // Second call, expanded from the edited text: every body step passes.
      void vscode.commands.executeCommand('testbench-native.continueRun');
      await waitFor('resume stream active', () => fake.hasActiveStream);
      const second = signInFrame('f2', 12, testPath);
      fake.push({ type: 'frame:push', frame: second });
      for (const line of [17, 18, 19]) {
        fake.push({ type: 'step:start', line, frame: second });
        fake.push({ type: 'step:pass', line, frame: second });
      }
      fake.push({ type: 'frame:pop', frameId: 'f2', outputs: {} });
      fake.push({ type: 'done', status: 'passed' });
      fake.end();
      await waitFor('idle after the resume', () => !hooks.isRunning());

      // The step that failed on the first call keeps its amber ✗ and hover;
      // the inserted step passed, and borrows neither.
      const body = (line) => ({ status: statuses()[line], hover: failures()[line]?.error });
      assert.deepEqual(
        { 17: body(17), 18: body(18) },
        {
          17: { status: 'pass', hover: undefined },
          18: { status: 'fail-tolerated', hover: 'no username box' },
        },
      );
    } finally {
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  });

  // -------------------------------------------------------------------------
  // Refusals
  // -------------------------------------------------------------------------

  it('runs a selected body step detached, at the root frame', async () => {
    // 0-based 16 == 1-based 17, the first step of `### Sign in`. It is sent
    // as an ordinary step carrying its own body line — no invocation, no
    // `startAt`. Sound because a section shares its caller's scope rather
    // than owning one, so the step sees the same variables either way.
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(16, 0),
      new vscode.Position(16, 8),
    );

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    const request = fake.requests[0];
    assert.deepEqual(request.steps, ['Type the username']);
    assert.deepEqual(request.sourceLines, [17]);
    assert.equal(request.startAt, undefined, 'a detached body run must not anchor');
    // The definitions still ride along: a body step that names a sibling
    // section has to expand server-side exactly as it would at a call site.
    assert.ok(request.sections, 'the sections map must still be sent');

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('a selection spanning the main flow and a body runs the main flow only', async () => {
    // Lines 10-18 cover the `Sign in` call AND the body it expands into.
    // Running both would execute the body twice — once inline, once at the
    // call site. Main-flow matches win; the body lines are dropped.
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(9, 0),
      new vscode.Position(17, 8),
    );

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    assert.deepEqual(fake.requests[0].sourceLines, [10, 11, 12, 13]);

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('"Run This Step" on a body line runs that one step', async () => {
    void vscode.commands.executeCommand('testbench-native.runStepHere', { lineNumber: 23 });
    await waitFor('stream active', () => fake.hasActiveStream);

    assert.deepEqual(fake.requests[0].steps, ['Click add to cart']);
    assert.deepEqual(fake.requests[0].sourceLines, [23]);

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('still refuses a selection that names no step of either kind', async () => {
    // Line 15 (0-based 14) is the `### Sign in` heading. It names no step,
    // and no main-flow step sits below it — bodies trail the main flow. The
    // empty resolution is indistinguishable from "no lines requested"
    // downstream, so the guard has to catch it or "run from my cursor" runs
    // the WHOLE test against a live session.
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(14, 0),
      new vscode.Position(14, 3),
    );

    await vscode.commands.executeCommand('testbench-native.runSelected');
    await sleep(300);

    assert.equal(fake.requests.length, 0, 'a non-step line must not start a run');
    assert.equal(hooks.isRunning(), false);
  });

  it('refuses a file whose sections the CLI would reject', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const bad = fixtureUri('sections-duplicate.md');
    await vscode.commands.executeCommand('vscode.open', bad);
    await waitFor('bad fixture active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === bad.toString();
    });

    await vscode.commands.executeCommand('testbench-native.runAll');
    await sleep(300);

    // The wire format cannot represent a duplicate name at all, so running
    // this would execute a different definition than the CLI does.
    assert.equal(fake.requests.length, 0, 'a duplicate-name file must not reach the server');
    assert.equal(hooks.isRunning(), false);
  });
});

/**
 * Debug-parity behaviours from the section-frame work.
 *
 * These were added because a review showed every one of them survived
 * mutation: the whole "debug parity" commit could be reverted line by line
 * with both suites still green. Each test below kills a specific mutation.
 */
describe('TestBench inline sections — debug parity', function () {
  this.timeout(20_000);

  /** @type {FakeApiClient} */
  let fake;
  let hooks;
  let testPath;
  let testUri;

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
    testUri = fixtureUri('sections.md');
    testPath = testUri.fsPath;
    await vscode.commands.executeCommand('vscode.open', testUri);
    await waitFor('fixture active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === testUri.toString();
    });
    await waitFor('detected as test file', () => hooks.tracker.snapshot().isTestFile === true);
  });

  it('Stop after a SECTION failure does not arm the skill-debug context', async () => {
    // "Debug a skill after Stop" opens `skillUri` and runs its body against
    // the stopped session. For a section that URI is the TEST file, so the
    // flow would offer to debug "the skill" by reopening the file the user is
    // already looking at.
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    const frame = signInFrame('f1', 10, testPath);
    fake.push({ type: 'frame:push', frame });
    fake.push({ type: 'step:fail', line: 18, error: 'nope', frame });
    await waitFor('failure recorded', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[18] === 'fail';
    });

    await vscode.commands.executeCommand('testbench-native.stop');
    await waitFor('stopped', () => !hooks.isRunning());

    assert.equal(
      hooks.skillDebugActive(),
      false,
      'a section failure must not arm the skill-file debug-after-Stop flow',
    );
  });

  it('a body-step failure parks the marker on the BODY line, not the call line', async () => {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    const frame = signInFrame('f1', 10, testPath);
    fake.push({ type: 'frame:push', frame });
    fake.push({ type: 'step:fail', line: 18, error: 'nope', frame });

    await waitFor('marker on the failed body line', () => {
      return hooks.tracker.snapshot().breakpointStop === 18;
    });
    assert.deepEqual(hooks.tracker.resumeContextFor(testUri), {
      kind: 'section-body',
      callLine: 10,
    });

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('Continue after a body-step failure resumes THAT step, then the rest of the test', async () => {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    const frame = signInFrame('f1', 10, testPath);
    fake.push({ type: 'frame:push', frame });
    fake.push({ type: 'step:fail', line: 18, error: 'nope', frame });
    await waitFor('marker parked', () => hooks.tracker.snapshot().breakpointStop === 18);
    fake.end();
    await waitFor('idle', () => !hooks.isRunning());

    void vscode.commands.executeCommand('testbench-native.continueRun');
    await waitFor('resume started', () => fake.requests.length === 2);

    const resume = fake.requests[1];
    // The invocation AND everything after it: the server expands the call
    // into the whole body, anchors at the failed step, and runs on into the
    // rest of the test. Sending the invocation alone would stop at the end of
    // the section instead of continuing the run.
    assert.deepEqual(resume.sourceLines, [10, 11, 12, 13]);
    assert.deepEqual(resume.startAt, { uri: testPath, line: 18 });

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('a failure in the SECOND invocation anchors inside that one', async () => {
    // Lines 10 and 12 both call `Sign in`. The sent range starts at the
    // failing call, so the server's first exact match for line 18 can only
    // be the second invocation's — the steps of the first stay passed.
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    const second = signInFrame('f2', 12, testPath);
    fake.push({ type: 'frame:push', frame: second });
    fake.push({ type: 'step:fail', line: 18, error: 'nope', frame: second });
    await waitFor('marker parked', () => hooks.tracker.snapshot().breakpointStop === 18);
    fake.end();
    await waitFor('idle', () => !hooks.isRunning());

    void vscode.commands.executeCommand('testbench-native.continueRun');
    await waitFor('resume started', () => fake.requests.length === 2);

    assert.deepEqual(fake.requests[1].sourceLines, [12, 13]);
    assert.deepEqual(fake.requests[1].startAt, { uri: testPath, line: 18 });

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('a NESTED section failure still parks on the top-level invocation', async () => {
    // v1 gate: only `parentId === null` frames are line-anchorable. A nested
    // body keeps the invocation-line resume it has always had.
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    const outer = signInFrame('f1', 10, testPath);
    const inner = { ...signInFrame('f2', 17, testPath), parentId: 'f1', skillName: 'Add an item' };
    fake.push({ type: 'frame:push', frame: outer });
    fake.push({ type: 'frame:push', frame: inner });
    fake.push({ type: 'step:fail', line: 22, error: 'nope', frame: inner });

    await waitFor('marker on the top-level call line', () => {
      return hooks.tracker.snapshot().breakpointStop === 10;
    });
    assert.equal(hooks.tracker.resumeContextFor(testUri), null);

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('Pause inside a section body resumes that body step', async () => {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    const frame = signInFrame('f1', 10, testPath);
    fake.push({ type: 'frame:push', frame });
    fake.push({ type: 'step:start', line: 17, frame });
    await waitFor('body step running', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[17] === 'running';
    });

    await vscode.commands.executeCommand('testbench-native.pause');
    await waitFor('paused on the body line', () => {
      return hooks.tracker.snapshot().breakpointStop === 17 && !hooks.isRunning();
    });
    assert.deepEqual(hooks.tracker.resumeContextFor(testUri), {
      kind: 'section-body',
      callLine: 10,
    });

    void vscode.commands.executeCommand('testbench-native.continueRun');
    await waitFor('resume started', () => fake.requests.length === 2);
    assert.deepEqual(fake.requests[1].startAt, { uri: testPath, line: 17 });

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('Pause before the body’s first step falls back to the invocation line', async () => {
    // The frame is pushed before its first `step:start`. In that window the
    // last step:start was still a MAIN-FLOW line, so calling it a body line
    // would resume a completely different step. Fall back, no context.
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'step:start', line: 9 });
    fake.push({ type: 'frame:push', frame: signInFrame('f1', 10, testPath) });
    await waitFor('frame pushed', () => hooks.runningFrameStack().length === 1);

    await vscode.commands.executeCommand('testbench-native.pause');
    await waitFor('paused on the call line', () => {
      return hooks.tracker.snapshot().breakpointStop === 10 && !hooks.isRunning();
    });
    assert.equal(hooks.tracker.resumeContextFor(testUri), null);
  });

  it('Continue still refuses a body-line marker with NO resume context', async () => {
    // Nothing clears a marker except Stop, a new run, or the next
    // `step:start`, so a dropped stream or a restarted server leaves one
    // behind. The context's ABSENCE is what marks it unresumable — without
    // that discriminator this would compute an empty resume list, and
    // `runLines([])` is the literal "run everything" convention.
    hooks.tracker.setBreakpointStop(testUri, 18);
    await waitFor('marker parked on the body line', () => {
      return hooks.tracker.snapshot().breakpointStop === 18;
    });

    await vscode.commands.executeCommand('testbench-native.continueRun');
    await sleep(400);

    assert.equal(fake.requests.length, 0, 'a contextless body marker must not start a run');
    assert.equal(hooks.isRunning(), false);
    assert.equal(
      hooks.tracker.snapshot().breakpointStop,
      null,
      'the stale marker should be cleared, not left painted',
    );
  });

  it('Step from a contextless body-line marker refuses too', async () => {
    hooks.tracker.setBreakpointStop(testUri, 17);
    await waitFor('marker parked', () => hooks.tracker.snapshot().breakpointStop === 17);

    await vscode.commands.executeCommand('testbench-native.stepOver');
    await sleep(400);

    assert.equal(fake.requests.length, 0, 'a body-line marker must not start a stepping run');
    assert.equal(hooks.isRunning(), false);
  });

  it('Step from a body-line marker WITH a context resumes, carrying the mode', async () => {
    hooks.tracker.setBreakpointStop(testUri, 18, { kind: 'section-body', callLine: 10 });
    await waitFor('marker parked', () => hooks.tracker.snapshot().breakpointStop === 18);

    void vscode.commands.executeCommand('testbench-native.stepOver');
    await waitFor('resume started', () => fake.requests.length === 1);

    assert.deepEqual(fake.requests[0].startAt, { uri: testPath, line: 18 });
    assert.equal(fake.requests[0].stepMode, 'over');

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('a resume whose tail prompts sends startAt on the FIRST block only', async () => {
    // `sections-input-tail.md`: main flow 9 (`Sign in`), 10 (`[interactive]`),
    // 11; `### Sign in` body on 15 and 16. An interactive step splits the run
    // into two requests, and `startAt` names a line inside the FIRST one's
    // expansion. Re-sending it on the second — whose expansion no longer
    // contains that line — makes the server refuse with "Re-run anchor not
    // found". Invisible before section resumes: every earlier re-run flow
    // sent exactly one step, so there was never a second block.
    //
    // `[interactive]` rather than `[input:]` because the two prompt through
    // different surfaces: `[input:]` opens VS Code's native InputBox, which
    // the harness cannot answer, while `[interactive]` uses the webview
    // composer that `dispatchWebviewMessage` drives. Both split the run the
    // same way, which is the only property under test here.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const uri = fixtureUri('sections-input-tail.md');
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('fixture active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === uri.toString();
    });
    await waitFor('detected as test file', () => hooks.tracker.snapshot().isTestFile === true);

    hooks.tracker.setBreakpointStop(uri, 16, { kind: 'section-body', callLine: 9 });
    await waitFor('marker parked', () => hooks.tracker.snapshot().breakpointStop === 16);

    void vscode.commands.executeCommand('testbench-native.continueRun');
    await waitFor('first block sent', () => fake.requests.length === 1);
    assert.deepEqual(fake.requests[0].sourceLines, [9]);
    assert.deepEqual(fake.requests[0].startAt, { uri: uri.fsPath, line: 16 });

    fake.end();
    // The `[interactive]` step blocks on the composer. There is no hook for
    // "the prompt is open", and answering early is a silent no-op, so keep
    // sending `/continue` (leave interactive mode, run the next step) until
    // the run moves on.
    await waitFor('second block sent', async () => {
      if (fake.requests.length === 2) return true;
      await hooks.dispatchWebviewMessage({ type: 'promptResponse', text: '/continue' });
      return fake.requests.length === 2;
    });
    assert.deepEqual(fake.requests[1].sourceLines, [11]);
    assert.equal(
      fake.requests[1].startAt,
      undefined,
      'the anchor must not ride along on a later block',
    );

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('Continue still resumes normally from a MAIN-FLOW marker', async () => {
    // The guard must not swallow the legitimate case it sits next to.
    hooks.tracker.setBreakpointStop(testUri, 11);
    await waitFor('marker parked on a main-flow line', () => {
      return hooks.tracker.snapshot().breakpointStop === 11;
    });

    void vscode.commands.executeCommand('testbench-native.continueRun');
    await waitFor('resume started', () => fake.requests.length === 1);

    // Resumes from line 11 to the end — main-flow lines only.
    assert.deepEqual(fake.requests[0].sourceLines, [11, 12, 13]);

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('a section pause labels the Variables panel "section:", not "skill:"', async () => {
    // The panel keyed its description on `skillName` being present, and a
    // section frame carries `skillName` (it holds the section name), so every
    // paused section read "skill: <section name>".
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'frame:push', frame: signInFrame('f1', 10, testPath) });
    await waitFor('frame pushed', () => hooks.runningFrameStack().length === 1);

    assert.equal(hooks.variablesDescription(), 'section: Sign in');

    fake.push({ type: 'frame:pop', frameId: 'f1', outputs: {} });
    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('editing a section heading invalidates persisted statuses', async () => {
    // Statuses are pinned to line numbers, and a heading decides which body a
    // line belongs to. Rename a section and the same line means something
    // else — the persisted ✓ from the old structure must not be restored.
    const original = (await vscode.workspace.openTextDocument(testUri)).getText();
    const before = hooks.stepSignatureForText(original);
    const after = hooks.stepSignatureForText(original.replace('### Sign in', '### Log in'));

    assert.notEqual(before, after, 'renaming a section must change the signature');
  });
});

/**
 * The two surfaces the debug-parity commit changed that the suite above
 * still doesn't reach: the pass summary's denominator and the frame reveal.
 */
describe('TestBench inline sections — editor surfaces', function () {
  this.timeout(20_000);

  let hooks;
  let fake;
  let testUri;
  let testPath;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks not exposed');
  });

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fake = new FakeApiClient();
    hooks.setApiClientFactory(() => fake);
    testUri = fixtureUri('sections.md');
    testPath = testUri.fsPath;
    await vscode.commands.executeCommand('vscode.open', testUri);
    await waitFor('fixture active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === testUri.toString();
    });
    await waitFor('detected as test file', () => hooks.tracker.snapshot().isTestFile === true);
  });

  it('the pass summary counts main-flow steps, not body lines', async () => {
    // M must be the author's step count. A body line can be visited zero
    // times (never invoked) or many (invoked repeatedly), so counting them
    // makes M meaningless and lets N exceed it.
    const empty = hooks.stepsSummaryForTests(testUri);
    assert.equal(
      empty.total,
      5,
      `expected the 5 main-flow steps; body lines must not inflate M (got ${empty.total})`,
    );
    assert.equal(empty.passed, 0, 'nothing has passed before a run');

    // N counts main-flow passes AND body-line passes are excluded — a body
    // step passing must not bump the numerator, or an invoked-twice section
    // could push N past M. Drive real statuses onto both a main-flow line and
    // a body line, then assert only the main-flow one counts.
    hooks.tracker.setStatus(testUri, 9, 'pass'); // main-flow "Open the shop"
    hooks.tracker.setStatus(testUri, 17, 'pass'); // body "Type the username"

    const after = hooks.stepsSummaryForTests(testUri);
    assert.equal(after.total, 5, 'M is unchanged by a body-line status');
    assert.equal(after.passed, 1, 'N counts the main-flow pass only, not the body-line pass');
  });

  it('a root-frame failure does not park a re-runnable skill/section failure', async () => {
    // A `step:fail` on the top-level test frame (kind 'test', parentId null)
    // reaches recordSkillFailure. The root is not a re-runnable unit — there
    // is no enclosing invocation to re-enter — so it must not arm the Stop
    // debug flow, which would otherwise offer to "re-run the skill" with the
    // test file as its target.
    //
    // Two guards enforce this — the kind gate and the `!root` lookup (the
    // root id `''` is never in frameRoot). This asserts the BEHAVIOUR, and
    // deliberately can't isolate which guard wins, because today either one
    // alone suffices; the kind gate is defence-in-depth against a future
    // change to how frameRoot is populated.
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    const rootFrame = { id: '', parentId: null, kind: 'test', uri: testPath, line: 9 };
    fake.push({ type: 'step:fail', line: 9, error: 'nope', frame: rootFrame });
    await waitFor('root failure painted', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'fail';
    });

    await vscode.commands.executeCommand('testbench-native.stop');
    await waitFor('stopped', () => !hooks.isRunning());
    assert.equal(hooks.skillDebugActive(), false, 'a root-frame failure is not re-runnable');
  });

  it('a section frame reveals in place, not in a column beside', async () => {
    // A section body lives in the file already on screen. The skill
    // behaviour — open the defining file BESIDE — would split the editor to
    // show a second copy of the same document and steal the user's column.
    const columnsBefore = vscode.window.visibleTextEditors.length;

    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    const frame = signInFrame('f1', 10, testPath);
    fake.push({ type: 'frame:push', frame });
    fake.push({ type: 'step:start', line: 17, frame });
    await waitFor('body step started', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[17] === 'running';
    });
    await sleep(400);

    assert.equal(
      vscode.window.visibleTextEditors.length,
      columnsBefore,
      'revealing a section frame must not open a second editor',
    );

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });
});

/**
 * Nothing under a `####` heading may run, and the editor must say so
 * (stories/test-script-sections-contract.md §5 rule 4a).
 *
 * The old grammar called such a heading "inert prose" and then absorbed the
 * numbered items beneath it — into the main flow when no section was open,
 * into whichever body was when one was — and ran them, silently. These assert
 * the three surfaces an author touches: the gutter, the commands, and the
 * Problems panel.
 */
describe('TestBench inline sections — inert deep headings', function () {
  this.timeout(20_000);

  let hooks;
  let fake;
  let uri;
  const FIXTURE = [
    '---', 'type: test', '---', '',
    '# Inert', '',
    '## Steps',
    '1. Open the dashboard',
    '2. Sign in',
    '',
    '### Sign in',
    '1. Type the username',
    '',
    '#### Cleanup',
    '1. Sign out',
    '2. Close the browser',
    '',
  ].join('\n');
  let filePath;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks not exposed');
  });

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fake = new FakeApiClient();
    hooks.setApiClientFactory(() => fake);
    filePath = path.resolve(FIXTURES_DIR, 'inert-deep.md');
    fs.writeFileSync(filePath, FIXTURE, 'utf-8');
    uri = vscode.Uri.file(filePath);
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('fixture active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === uri.toString();
    });
    await waitFor('detected as test file', () => hooks.tracker.snapshot().isTestFile === true);
  });

  afterEach(() => {
    fs.rmSync(filePath, { force: true });
  });

  it('Run This Step on an inert line refuses and sends nothing', async () => {
    // Line 15 is `1. Sign out`, under `#### Cleanup` on line 14.
    await vscode.commands.executeCommand('testbench-native.runStepHere', { lineNumber: 15 });
    await sleep(300);
    assert.equal(fake.requests.length, 0, 'nothing may reach the server');
    assert.equal(hooks.isRunning(), false);
  });

  it('Compile This Step on an inert line refuses, naming the heading', async () => {
    await vscode.commands.executeCommand('testbench-native.compileStepCodeBehind', {
      lineNumber: 15,
    });
    await waitFor('refused', () => hooks.lastCompileError() !== null, 5_000);
    assert.match(hooks.lastCompileError(), /never runs/);
    assert.match(hooks.lastCompileError(), /Cleanup/);
    assert.equal(fake.requests.length, 0);
  });

  it('a breakpoint cannot be set on an inert line', async () => {
    const before = vscode.debug.breakpoints.length;
    await vscode.commands.executeCommand('testbench-native.toggleBreakpoint', { lineNumber: 15 });
    await sleep(300);
    assert.equal(vscode.debug.breakpoints.length, before, 'no breakpoint may be created');
  });

  it('a run of the whole test never sends the inert items', async () => {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);
    const request = fake.requests[0];
    assert.deepEqual(request.steps, ['Open the dashboard', 'Sign in']);
    // …and the section body the call expands to carries only its own step.
    const section = Object.values(request.sections ?? {})[0];
    assert.deepEqual(section.steps, ['Type the username']);
    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('warns on each inert item in the Problems panel', async () => {
    await waitFor(
      'diagnostics published',
      () => vscode.languages.getDiagnostics(uri).some((d) => /never runs/.test(d.message)),
      8_000,
    );
    const rows = vscode.languages
      .getDiagnostics(uri)
      .filter((d) => /never runs/.test(d.message));
    assert.equal(rows.length, 2, 'one per numbered item under the heading');
    assert.equal(rows[0].severity, vscode.DiagnosticSeverity.Warning);
    assert.match(rows[0].message, /Cleanup/);
  });
});

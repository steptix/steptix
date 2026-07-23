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
    // omitted these would expand differently from the batch before it — and
    // hash differently, wiping the cache at every Continue.
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

  // -------------------------------------------------------------------------
  // Refusals
  // -------------------------------------------------------------------------

  it('refuses to run from a cursor parked on a body line', async () => {
    // `resolveRunLines` finds no main-flow step at or below a body line, and
    // returns `[]` — the same value that means "run everything". Without the
    // guard this silently ran the WHOLE test against the live session.
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(16, 0),
      new vscode.Position(16, 8),
    );

    await vscode.commands.executeCommand('testbench-native.runSelected');
    await sleep(300);

    assert.equal(fake.requests.length, 0, 'a body-line cursor must not start a run');
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

  it('Continue refuses a stale pause marker parked on a body line', async () => {
    // Nothing clears a marker except Stop, a new run, or the next
    // `step:start`, so a dropped stream leaves one behind. Resuming from a
    // body line computes an EMPTY resume list, and `runLines([])` is the
    // literal "run everything" convention — it would silently re-run the
    // whole test against a live session.
    hooks.tracker.setBreakpointStop(testUri, 18);
    await waitFor('marker parked on the body line', () => {
      return hooks.tracker.snapshot().breakpointStop === 18;
    });

    await vscode.commands.executeCommand('testbench-native.continueRun');
    await sleep(400);

    assert.equal(fake.requests.length, 0, 'a body-line marker must not start a run');
    assert.equal(hooks.isRunning(), false);
    assert.equal(
      hooks.tracker.snapshot().breakpointStop,
      null,
      'the stale marker should be cleared, not left painted',
    );
  });

  it('Step from a stale body-line marker refuses too', async () => {
    hooks.tracker.setBreakpointStop(testUri, 17);
    await waitFor('marker parked', () => hooks.tracker.snapshot().breakpointStop === 17);

    await vscode.commands.executeCommand('testbench-native.stepOver');
    await sleep(400);

    assert.equal(fake.requests.length, 0, 'a body-line marker must not start a stepping run');
    assert.equal(hooks.isRunning(), false);
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

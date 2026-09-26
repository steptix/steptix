/**
 * A guard's code mark survives its section tail's `frame:pop`
 * (stories/codebehind-loops-and-conditions.md, decision 15).
 *
 * Driven end to end inside a real VS Code extension host with a
 * `FakeApiClient` scripted to emit the stream the Sessions API sends for a
 * guard whose tail is a section: the guard's own `step:pass` on its line —
 * carrying `fromCodeBehind` / `codeBehindStale` once its condition ran as
 * code-behind — then the tail's `frame:push` with `line` equal to the guard's
 * line, the body, and the clean `frame:pop`. That pop used to paint the call
 * line a plain ✓ unconditionally, erasing the guard's `</>` or ⚠ and the ⚠'s
 * hover with it. The rule is pinned in `tests/guard-marks.test.js`; what only
 * this layer can prove is that the router records the pass and consults the
 * mark on the pop, with the tracker as the witness.
 *
 * The fixture is `fixtures/guard-marks.md` (see its own header). Line numbers
 * below are that file's and must be kept in step with it.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');
const { FakeApiClient } = require('../fakes/fake-api-client.cjs');

const EXT_ID = 'pkent.testbench-native';
const FIXTURES_DIR =
  process.env.TESTBENCH_FIXTURES_DIR || path.resolve(__dirname, '..', 'fixtures');
const fixtureUri = (name) => vscode.Uri.file(path.resolve(FIXTURES_DIR, name));

// --- fixtures/guard-marks.md ---------------------------------------------
const OPEN = 17; //   1. Open the payments page
const IF_CASH = 18; //   2. If the Cash checkbox is ticked, then Pay with cash
const OTHERWISE = 19; //   3. Otherwise, Pay by card
const WHILE_NEXT = 20; //   4. While the Next button is enabled, Go to the next page
const GOODBYE = 21; //   5. Say goodbye
const CASH_BODY = 25; //      Pay with cash → 1. Click Pay now
const CARD_BODY = 29; //      Pay by card → 1. Click Pay by card
const NEXT_BODY = 33; //      Go to the next page → 1. Click the Next button

const STALE = {
  file: path.resolve(FIXTURES_DIR, 'guard-marks.steps.ts'),
  error: "locator.isChecked: Timeout 5000ms exceeded waiting for getByLabel('Cash')",
};
const NOT_TAKEN = 'Skipped: another branch of this decision was taken';

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

describe('TestBench guard marks — a section tail\'s frame:pop keeps the guard\'s </> / ⚠', function () {
  this.timeout(20_000);

  /** @type {FakeApiClient} */
  let fake;
  let hooks;
  let testPath;
  let testUri;

  /** The tail frame of a guard line: a top-level section frame on the guard's
   *  own line — the collision this suite is about. `id` differs per pass, as
   *  the server clones a loop tail's frames per pass. */
  const tailFrame = (id, line, skillName) => ({
    id,
    parentId: null,
    kind: 'section',
    uri: testPath,
    line,
    skillName,
  });

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

    testUri = fixtureUri('guard-marks.md');
    testPath = testUri.fsPath;

    await vscode.commands.executeCommand('vscode.open', testUri);
    await waitFor('fixture editor active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === testUri.toString();
    });
    await waitFor('detected as test file', () => hooks.tracker.snapshot().isTestFile === true);
  });

  /**
   * One `If … then <section>` visit: the guard decides and passes with
   * `guardFields`, the tail's frame is pushed on the guard's line, its one body
   * step passes, and the frame pops clean. The `Otherwise` line is the untaken
   * half, as the server paints it.
   */
  function scriptIfVisit(guardFields) {
    const frame = tailFrame('cash', IF_CASH, 'Pay with cash');
    fake.push({ type: 'step:start', line: OPEN });
    fake.push({ type: 'step:pass', line: OPEN });
    fake.push({ type: 'step:start', line: IF_CASH });
    fake.push({ type: 'step:pass', line: IF_CASH, output: 'decided', ...guardFields });
    fake.push({ type: 'step:pass', line: OTHERWISE, output: 'skipped', reason: NOT_TAKEN, skipKind: 'not-taken' });
    fake.push({ type: 'frame:push', frame });
    fake.push({ type: 'step:start', line: CASH_BODY, frame });
    fake.push({ type: 'step:pass', line: CASH_BODY, frame });
    fake.push({ type: 'frame:pop', frameId: frame.id, outputs: {} });
  }

  async function finish(status = 'passed') {
    fake.push({ type: 'done', status });
    fake.end();
    await waitFor('run finished', () => !hooks.isRunning(), 10_000);
    return {
      statuses: Object.fromEntries(hooks.tracker.snapshot().statuses),
      failures: Object.fromEntries(hooks.tracker.snapshot().failures),
    };
  }

  it('an If decided by code keeps </> after its section tail pops', async () => {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    scriptIfVisit({ fromCodeBehind: true });
    const { statuses } = await finish();

    assert.equal(
      statuses[IF_CASH],
      'pass-code-behind',
      'the pop must not flatten the guard\'s </> to a plain ✓',
    );
    // Everything around it is exactly what it was.
    assert.equal(statuses[OPEN], 'pass');
    assert.equal(statuses[CASH_BODY], 'pass');
    assert.equal(statuses[OTHERWISE], 'skip');
  });

  it('an If whose condition code threw keeps ⚠ — and its hover — after the pop', async () => {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    scriptIfVisit({ codeBehindStale: STALE });
    const { statuses, failures } = await finish();

    assert.equal(statuses[IF_CASH], 'pass-stale');
    // The tail's frame:push painted ▶ over the ⚠ and dropped its detail; the
    // pop has to put back what the condition's code threw, or the ⚠ has no
    // hover to say what to recompile.
    assert.equal(failures[IF_CASH]?.codeBehindStale?.error, STALE.error);
    assert.equal(failures[IF_CASH]?.codeBehindStale?.file, STALE.file);
    assert.equal(failures[IF_CASH]?.error, undefined, 'the guard passed — no step error');
  });

  it('puts ⚠ on the skipped If whose condition code threw — not on the Otherwise the model took', async () => {
    // What the server sends when the If's condition entry throws and the model,
    // deciding the whole chain, takes the Otherwise: the ⚠ rides the If's own
    // skipped event, and the Otherwise's pass is clean. Before the fix the If
    // painted ◌ with no hover (a skip outranked the stale flag), and the ⚠ —
    // and so "Repair this step" — landed on the Otherwise, whose line has no
    // entry to repair.
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    const frame = tailFrame('card', OTHERWISE, 'Pay by card');
    fake.push({ type: 'step:start', line: OPEN });
    fake.push({ type: 'step:pass', line: OPEN });
    fake.push({ type: 'step:start', line: IF_CASH });
    fake.push({
      type: 'step:pass',
      line: IF_CASH,
      output: 'skipped',
      reason: NOT_TAKEN,
      skipKind: 'not-taken',
      codeBehindStale: STALE,
    });
    fake.push({ type: 'step:pass', line: OTHERWISE, output: 'the model saw none hold' });
    fake.push({ type: 'frame:push', frame });
    fake.push({ type: 'step:start', line: CARD_BODY, frame });
    fake.push({ type: 'step:pass', line: CARD_BODY, frame });
    fake.push({ type: 'frame:pop', frameId: frame.id, outputs: {} });
    await waitFor('the If is published as a stale line', () =>
      hooks.tracker.lastStaleLinesContextValue.includes(IF_CASH),
    );
    // Repair is offered on the If — its entry is the broken one — and nowhere else.
    assert.deepEqual(hooks.tracker.lastStaleLinesContextValue, [IF_CASH]);
    const { statuses, failures } = await finish();

    assert.equal(statuses[IF_CASH], 'pass-stale');
    assert.equal(statuses[OTHERWISE], 'pass', 'the member that held did nothing wrong');
    assert.equal(failures[OTHERWISE], undefined);
    const detail = failures[IF_CASH];
    assert.equal(detail?.codeBehindStale?.error, STALE.error);
    assert.equal(detail?.notTaken, NOT_TAKEN);
    // The hover the decoration renders from that detail says both facts.
    const hover = hooks.staleHoverMessage(detail);
    assert.ok(hover.startsWith(NOT_TAKEN), hover);
    assert.match(hover, /This line was not taken/);
    assert.match(hover, /locator\.isChecked: Timeout 5000ms exceeded/);
    assert.match(hover, /Repair this step/);
  });

  it('an If the model decided still pops to a plain ✓', async () => {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    scriptIfVisit({});
    const { statuses, failures } = await finish();

    assert.equal(statuses[IF_CASH], 'pass');
    assert.equal(failures[IF_CASH], undefined);
  });

  it('a While shows its LATEST visit\'s mark after each pass\'s pop', async () => {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    // Visit 1: the condition code threw and the model healed it (⚠); pass 1 of
    // the body runs.
    const pass1 = tailFrame('next-1', WHILE_NEXT, 'Go to the next page');
    fake.push({ type: 'step:start', line: WHILE_NEXT });
    fake.push({ type: 'step:pass', line: WHILE_NEXT, output: 'decided', codeBehindStale: STALE });
    fake.push({ type: 'frame:push', frame: pass1 });
    fake.push({ type: 'step:start', line: NEXT_BODY, frame: pass1 });
    fake.push({ type: 'step:pass', line: NEXT_BODY, frame: pass1 });
    fake.push({ type: 'frame:pop', frameId: pass1.id, outputs: {} });
    // Body ✓ with the While line at ⚠ can only be after the pop: from the push
    // until the pop the While line is ▶.
    await waitFor('pass 1 popped to ⚠', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[NEXT_BODY] === 'pass' && statuses[WHILE_NEXT] === 'pass-stale';
    });
    assert.equal(
      Object.fromEntries(hooks.tracker.snapshot().failures)[WHILE_NEXT]?.codeBehindStale?.error,
      STALE.error,
    );

    // Visit 2: code decided cleanly this time (</>); pass 2 of the body runs.
    // The stream ends on the pop, so the final mark is the pop's own write.
    const pass2 = tailFrame('next-2', WHILE_NEXT, 'Go to the next page');
    fake.push({ type: 'step:start', line: WHILE_NEXT });
    fake.push({ type: 'step:pass', line: WHILE_NEXT, output: 'decided', fromCodeBehind: true });
    fake.push({ type: 'frame:push', frame: pass2 });
    fake.push({ type: 'step:start', line: NEXT_BODY, frame: pass2 });
    fake.push({ type: 'step:pass', line: NEXT_BODY, frame: pass2 });
    fake.push({ type: 'frame:pop', frameId: pass2.id, outputs: {} });
    const { statuses, failures } = await finish();

    assert.equal(statuses[WHILE_NEXT], 'pass-code-behind', 'the later visit\'s </> replaces the ⚠');
    assert.equal(failures[WHILE_NEXT], undefined, 'and the ⚠\'s hover goes with the ⚠');
  });

  it('a failed descent still leaves ✗ on the guard line — the pop paints nothing', async () => {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    const frame = tailFrame('cash', IF_CASH, 'Pay with cash');
    fake.push({ type: 'step:start', line: IF_CASH });
    fake.push({ type: 'step:pass', line: IF_CASH, output: 'decided', fromCodeBehind: true });
    fake.push({ type: 'frame:push', frame });
    fake.push({ type: 'step:start', line: CASH_BODY, frame });
    fake.push({ type: 'step:fail', line: CASH_BODY, frame, error: 'no Pay now button' });
    fake.push({ type: 'frame:pop', frameId: frame.id, outputs: {} });
    const { statuses } = await finish('failed');

    assert.equal(statuses[CASH_BODY], 'fail');
    assert.equal(statuses[IF_CASH], 'fail', 'a remembered </> must not paint over the propagated ✗');
  });

  it('a new run starts with no remembered marks', async () => {
    // Run 1 leaves </> on the If line.
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);
    scriptIfVisit({ fromCodeBehind: true });
    const first = await finish();
    assert.equal(first.statuses[IF_CASH], 'pass-code-behind');

    // Run 2 — same controller, same client — pops a frame on the same line with
    // no guard pass before it. A mark carried over from run 1 would paint </>
    // for a decision run 2 never made.
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('second stream active', () => fake.hasActiveStream);
    const frame = tailFrame('cash-2', IF_CASH, 'Pay with cash');
    fake.push({ type: 'frame:push', frame });
    fake.push({ type: 'step:pass', line: CASH_BODY, frame });
    fake.push({ type: 'frame:pop', frameId: frame.id, outputs: {} });
    fake.push({ type: 'step:pass', line: GOODBYE });
    const second = await finish();

    assert.equal(second.statuses[IF_CASH], 'pass', 'run 1\'s </> must not survive into run 2');
  });
});

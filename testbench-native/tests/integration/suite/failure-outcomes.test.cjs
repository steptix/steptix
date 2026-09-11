/**
 * The two failure OUTCOMES, driven end to end in a real VS Code extension host
 * (stories/step-failure-outcomes.md, decisions 2, 6 and 9).
 *
 * A `FakeApiClient` scripted with the exact stream the Sessions API sends for an
 * `otherwise continue` tail and for the `fail` verb. Only this layer can prove
 * what the extension makes of two booleans riding an event it has always painted
 * red: amber (never green, because the step did not do its work; never red,
 * because the run is not red for it), the run carrying ON, a later pass not
 * repainting it, a real ✗ never downgraded, and a deliberate failure as an
 * ordinary red ✗ that only SAYS so differently.
 *
 * The fixture is `fixtures/flow-control.md`, reused for its main-flow lines —
 * nothing here descends into a section. The line numbers are that file's and
 * must be kept in step with it.
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

// --- fixtures/flow-control.md, main flow --------------------------------
const STEP_1 = 19; // 1. Open the shop
const STEP_2 = 20; // 2. Sign in
const STEP_3 = 21; // 3. Check out
const STEP_4 = 22; // 4. Say goodbye

/** The author's own sentence on a deliberate failure. */
const PEANUTS = 'The variable value was peanuts. Expected apples';

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

/** The extension's output channel, when the harness is teeing it to a file.
 *  VS Code exposes no way to read an OutputChannel back. */
function readLiveLog() {
  const file = process.env.TESTBENCH_LIVE_LOG;
  if (!file || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf-8');
}

describe('TestBench failure outcomes — tolerated and deliberate', function () {
  this.timeout(20_000);

  /** @type {FakeApiClient} */
  let fake;
  let hooks;
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

    testUri = fixtureUri('flow-control.md');
    await vscode.commands.executeCommand('vscode.open', testUri);
    await waitFor('fixture editor active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === testUri.toString();
    });
    await waitFor('detected as test file', () => hooks.tracker.snapshot().isTestFile === true);
  });

  // ── The one scaffold every test below shares ───────────────────────────

  /** Run the whole file and wait until the fake is streaming. */
  async function startRun() {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);
  }

  /** Close the stream with the server's own verdict, and let the client settle. */
  async function endRun(status) {
    fake.push({ type: 'done', status });
    fake.end();
    await waitFor('run finished', () => !hooks.isRunning(), 10_000);
  }

  const statuses = () => Object.fromEntries(hooks.tracker.snapshot().statuses);
  const failures = () => Object.fromEntries(hooks.tracker.snapshot().failures);

  /** A step that ran and passed. */
  function passStep(line) {
    fake.push({ type: 'step:start', line });
    fake.push({ type: 'step:pass', line });
  }

  /** A `step:fail` as the wire sends it — an ordinary event plus a boolean or two,
   *  which is what makes this so easy to get wrong. */
  function failStep(line, over) {
    fake.push({ type: 'step:start', line });
    fake.push({ type: 'step:fail', line, ...over });
  }

  const painted = (line, status) =>
    waitFor(`line ${line} painted ${status}`, () => statuses()[line] === status);

  /** What this test added to the output channel, or null when it is not teed. */
  function logSince(offset) {
    const log = readLiveLog();
    return log === null ? null : log.slice(offset);
  }

  const logMark = () => readLiveLog()?.length ?? 0;

  it('paints an amber ✗, runs on, and ends the run green', async () => {
    const mark = logMark();
    await startRun();

    passStep(STEP_1);
    failStep(STEP_2, { error: 'No peanuts on the dashboard', tolerated: true });
    // …and the run goes ON. The next step is the observable proof of it.
    passStep(STEP_3);
    await endRun('passed');

    assert.equal(statuses()[STEP_1], 'pass');
    assert.equal(
      statuses()[STEP_2],
      'fail-tolerated',
      'a tolerated failure is its own status — not `fail`, and never a pass',
    );
    assert.equal(statuses()[STEP_3], 'pass', 'the step after it paints normally');
    // The hover's text is pinned to the line, so the amber ✗ can say what failed
    // without the reader going back to the run log.
    assert.equal(failures()[STEP_2]?.error, 'No peanuts on the dashboard');
    // `done.status` already excludes a tolerated failure, so the client must
    // agree with it rather than deriving its own red from the `step:fail`.
    assert.equal(hooks.lastDoneStatus(), 'passed');

    const log = logSince(mark);
    if (log !== null) {
      assert.match(
        log,
        /⚠ step 20 failed — continuing: No peanuts on the dashboard/,
        `the run log must say the run continued; got:\n${log}`,
      );
      // Without the tally clause the log reads `✓ 2 passed` for a three-step run
      // and nothing anywhere says where the third step went.
      assert.match(log, /✓ 2 passed, 1 tolerated/);
    }
  });

  it('pins the author’s warning to the line and leads the run log with it', async () => {
    // Decision 9: the warning used to reach no client at all — it lived in the
    // report row's explanation, which does not travel on `step:fail`.
    const mark = logMark();
    await startRun();

    failStep(STEP_2, {
      error: 'the title did not contain "Peanuts"',
      tolerated: true,
      warning: 'No peanuts on the dashboard',
    });
    await endRun('passed');

    assert.equal(
      failures()[STEP_2]?.warning,
      'No peanuts on the dashboard',
      'the hover is built from this detail — without the field it has no warning to lead with',
    );
    // And the framework's account keeps its place beside it.
    assert.equal(failures()[STEP_2]?.error, 'the title did not contain "Peanuts"');

    const log = logSince(mark);
    if (log !== null) {
      assert.match(
        log,
        /⚠ step 20 failed — continuing: No peanuts on the dashboard \(the title did not contain "Peanuts"\)/,
        `the warning must lead the run log line; got:\n${log}`,
      );
    }
  });

  it('does not let a later pass on the same line repaint it green', async () => {
    // A loop body, or a section called twice — the NORMAL shape for a tolerated
    // failure, since the run carrying on is the whole point of the tail.
    await startRun();

    failStep(STEP_2, { error: 'the banner was not there', tolerated: true });
    await painted(STEP_2, 'fail-tolerated');

    passStep(STEP_2);
    await endRun('passed');

    assert.equal(
      statuses()[STEP_2],
      'fail-tolerated',
      'the second pass must not erase the evidence that the first trip failed',
    );
    assert.equal(
      failures()[STEP_2]?.error,
      'the banner was not there',
      'and the error must survive with it',
    );
  });

  it('never downgrades a real ✗ to amber', async () => {
    // The other direction, and the one that matters more: a failure is the one
    // status a run must not lose. Same reachability — one source line, two trips.
    await startRun();

    failStep(STEP_4, { error: 'no sign-out link' });
    await painted(STEP_4, 'fail');

    fake.push({ type: 'step:fail', line: STEP_4, error: 'still no sign-out link', tolerated: true });
    await endRun('failed');

    assert.equal(statuses()[STEP_4], 'fail', 'a tolerated failure must not quieten a real one');
    assert.equal(failures()[STEP_4]?.error, 'no sign-out link');
  });

  it('paints a deliberate failure red, and says the message is the author’s', async () => {
    const mark = logMark();
    await startRun();

    passStep(STEP_1);
    failStep(STEP_2, { error: PEANUTS, deliberate: true });
    await endRun('failed');

    assert.equal(
      statuses()[STEP_2],
      'fail',
      'the author asked for this failure and the run STOPPED — it is an ordinary ✗',
    );
    assert.equal(
      failures()[STEP_2]?.error,
      PEANUTS,
      'and the hover leads with the author’s sentence, not the framework’s',
    );
    assert.equal(hooks.lastDoneStatus(), 'failed');

    const log = logSince(mark);
    if (log !== null) {
      assert.match(
        log,
        /✗ step 20 failed as written: The variable value was peanuts\. Expected apples/,
        `the run log must say the failure was asked for; got:\n${log}`,
      );
    }
  });

  it('does not read a COMPILED deliberate failure as broken code', async () => {
    // Decision 2: `step.fail()` throws what a failed `step.expect` throws, so a
    // replayed deliberate failure arrives `fromCodeBehind` — and the ordinary
    // wording framed the author's own sentence as an entry defect.
    const mark = logMark();
    await startRun();

    failStep(STEP_2, { error: PEANUTS, deliberate: true, fromCodeBehind: true });
    await endRun('failed');

    assert.equal(
      failures()[STEP_2]?.deliberate,
      true,
      'the hover wording is chosen off this flag — without it, the entry gets blamed',
    );

    const log = logSince(mark);
    if (log !== null) {
      assert.match(
        log,
        /✗ step 20 failed as written: The variable value was peanuts\. Expected apples/,
        `got:\n${log}`,
      );
      assert.doesNotMatch(
        log,
        /in its code-behind/,
        `the author's sentence must not be presented as an entry defect; got:\n${log}`,
      );
    }
  });

  it('carries BOTH flags when a step.fail() sits under an otherwise continue tail', async () => {
    // The combination the runtime really produces: a hand-written `step.fail()`
    // in the entry of a step whose line carries `otherwise continue`. The
    // tolerated branch of the server's step loop is a SECOND copy of the emit,
    // and it had not been told about `deliberate`.
    await startRun();

    failStep(STEP_2, {
      error: 'The cart was empty and this page needs it filled',
      tolerated: true,
      deliberate: true,
      fromCodeBehind: true,
    });
    passStep(STEP_3);
    await endRun('passed');

    assert.equal(statuses()[STEP_2], 'fail-tolerated', 'still amber — the tail still tolerated it');
    assert.equal(
      failures()[STEP_2]?.deliberate,
      true,
      'the amber hover picks its wording off this flag, exactly as the red one does',
    );
    assert.equal(failures()[STEP_2]?.tolerated, undefined, 'the detail pins the error, not the state');
    assert.equal(hooks.lastDoneStatus(), 'passed');
  });
});

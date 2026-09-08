/**
 * `step:skip` on the client — what the gutter, the run log and the panel make
 * of a step an `If … then return` left behind
 * (stories/step-flow-control.md, decision 9).
 *
 * Driven end to end inside a real VS Code extension host with a
 * `FakeApiClient` scripted to emit the exact stream the Sessions API sends for
 * a return inside a section body. The server half is proved by
 * `tests/api-server-flow-control.test.ts`; what only this layer can prove is
 * that the extension routes the events to the right file and line, and that
 * three things it would be easy to get wrong do not happen:
 *
 *  1. the RETURNED frame's own call line still paints ✓ — the ✓ comes from the
 *     clean `frame:pop`, and nothing about a skip may interfere with it;
 *  2. a nested call line inside the returned body paints ◌ even though no
 *     `frame:push` was ever sent for it (which is the point: had it pushed and
 *     popped, its call line would show ✓ for work that never ran);
 *  3. a `step:skip` never downgrades a ✗ already on the line.
 *
 * The fixture is `fixtures/flow-control.md` (see its own header). Line numbers
 * below are that file's and must be kept in step with it.
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

// --- fixtures/flow-control.md -------------------------------------------
const MAIN_OPEN = 19; //  1. Open the shop
const CALL_SIGN_IN = 20; //  2. Sign in            → the section call
const MAIN_CHECKOUT = 21; //  3. Check out
const MAIN_LAST = 22; //  4. Say goodbye         → skipped by the main-flow stop
const BODY_1 = 26; //  1. Look at the page    → the returning step
const BODY_2 = 27; //  2. Type the username   → skipped
const BODY_3 = 28; //  3. Press submit        → skipped
const BODY_CALL = 29; //  4. Accept cookies      → skipped NESTED CALL line
const NESTED_BODY = 33; //  1. Click the accept button → skipped, frame never pushed

const RETURN_REASON = 'Not run: step 2 returned from "Sign in"';
const STOP_REASON = 'Not run: step 6 ended the run';

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

describe('TestBench flow control — step:skip', function () {
  this.timeout(20_000);

  /** @type {FakeApiClient} */
  let fake;
  let hooks;
  let testPath;
  let testUri;
  /** The `### Sign in` invocation on line 20. */
  let signIn;
  /** `### Accept cookies`, called from INSIDE the Sign in body. Never pushed
   *  on the wire — a skipped call pushes no frame — but the events for its
   *  body line still name it, which is the shape a client has to tolerate. */
  let acceptCookies;

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
    testPath = testUri.fsPath;
    signIn = {
      id: 'f1',
      parentId: null,
      kind: 'section',
      uri: testPath,
      line: CALL_SIGN_IN,
      skillName: 'Sign in',
    };
    acceptCookies = {
      id: 'f2',
      parentId: 'f1',
      kind: 'section',
      uri: testPath,
      line: BODY_CALL,
      skillName: 'Accept cookies',
    };

    await vscode.commands.executeCommand('vscode.open', testUri);
    await waitFor('fixture editor active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === testUri.toString();
    });
    await waitFor('detected as test file', () => hooks.tracker.snapshot().isTestFile === true);
  });

  it('paints ◌ on the skipped body, the nested call line and the last main step — and ✓ on the section call', async () => {
    const logBefore = readLiveLog()?.length ?? 0;

    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    // ── The main flow reaches the section call ───────────────────────────
    fake.push({ type: 'step:start', line: MAIN_OPEN });
    fake.push({ type: 'step:pass', line: MAIN_OPEN });

    // ── Inside `Sign in`: body step 1 returns ────────────────────────────
    fake.push({ type: 'frame:push', frame: signIn });
    fake.push({ type: 'step:start', line: BODY_1, frame: signIn });
    // The returning step is an ordinary pass on the wire — the flow control
    // is in what does NOT follow it.
    fake.push({ type: 'step:pass', line: BODY_1, frame: signIn });

    // Everything left in that flow, in the order the server emits it: the
    // body's own remaining lines, then the nested CALL line (addressed in the
    // PARENT frame, because that is the file and frame the line is written
    // in), then the nested body line itself.
    fake.push({ type: 'step:skip', line: BODY_2, frame: signIn, reason: RETURN_REASON });
    fake.push({ type: 'step:skip', line: BODY_3, frame: signIn, reason: RETURN_REASON });
    fake.push({ type: 'step:skip', line: BODY_CALL, frame: signIn, reason: RETURN_REASON });
    fake.push({ type: 'step:skip', line: NESTED_BODY, frame: acceptCookies, reason: RETURN_REASON });

    // The returned frame pops CLEANLY — the section ran and returned, which
    // is a pass. No frame:pop for `Accept cookies`: it was never pushed.
    fake.push({ type: 'frame:pop', frameId: 'f1', outputs: {} });

    // ── Back in the main flow, which then stops ──────────────────────────
    fake.push({ type: 'step:start', line: MAIN_CHECKOUT });
    fake.push({ type: 'step:pass', line: MAIN_CHECKOUT });
    fake.push({ type: 'step:skip', line: MAIN_LAST, reason: STOP_REASON });
    fake.push({ type: 'done', status: 'passed' });
    fake.end();

    await waitFor('run finished', () => !hooks.isRunning(), 10_000);

    const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);

    assert.equal(statuses[MAIN_OPEN], 'pass');
    assert.equal(statuses[BODY_1], 'pass', 'the returning step passed');
    assert.equal(statuses[BODY_2], 'skip');
    assert.equal(statuses[BODY_3], 'skip');
    assert.equal(
      statuses[BODY_CALL],
      'skip',
      'the nested call line must wear ◌ — no frame was pushed for it, so nothing else would ever mark it',
    );
    assert.equal(statuses[NESTED_BODY], 'skip', 'a line in a frame the client never saw pushed still paints');
    // THE one that a naive implementation gets wrong in the other direction:
    // the section itself ran and returned, so its call line is a pass, and it
    // gets that from the clean pop rather than from anything skip-related.
    assert.equal(
      statuses[CALL_SIGN_IN],
      'pass',
      'the returned frame pops clean, so its call line is ✓ — the skips are on the body, never on the call',
    );
    assert.equal(statuses[MAIN_CHECKOUT], 'pass');
    assert.equal(statuses[MAIN_LAST], 'skip');

    // A return does not change the run's verdict (decision 4).
    assert.equal(hooks.lastDoneStatus(), 'passed');

    // And the reason survives to the two places a reader looks for it: the
    // line's hover detail and the run log.
    const failures = Object.fromEntries(hooks.tracker.snapshot().failures);
    assert.equal(failures[BODY_2]?.error, RETURN_REASON, 'the hover must say why the line is blank');
    assert.equal(failures[MAIN_LAST]?.error, STOP_REASON);

    const log = readLiveLog();
    if (log !== null) {
      const thisRun = log.slice(logBefore);
      assert.match(
        thisRun,
        /◌ step 27 skipped — Not run: step 2 returned from "Sign in"/,
        `the run log must carry the skip and its reason; got:\n${thisRun}`,
      );
      assert.match(thisRun, /◌ step 22 skipped — Not run: step 6 ended the run/);
    }
  });

  it('a step:skip never downgrades a ✗ already on the line', async () => {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'step:start', line: BODY_2 });
    fake.push({ type: 'step:fail', line: BODY_2, error: 'no username field' });
    await waitFor('the failure painted', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[BODY_2] === 'fail';
    });

    // A late skip for the same line — reachable when a return and a failure
    // race across an SSE flush boundary, and the direction that must never
    // win. Statuses are cleared at run start, so a ✗ here is THIS run's.
    fake.push({ type: 'step:skip', line: BODY_2, reason: RETURN_REASON });
    fake.push({ type: 'done', status: 'failed' });
    fake.end();
    await waitFor('run finished', () => !hooks.isRunning(), 10_000);

    const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    assert.equal(
      statuses[BODY_2],
      'fail',
      'a skip must not quieten a failure the same run reported',
    );
    const failures = Object.fromEntries(hooks.tracker.snapshot().failures);
    assert.equal(
      failures[BODY_2]?.error,
      'no username field',
      'and the failure text must survive with it — the skip must not replace the detail either',
    );
  });

  it('routes a skipped SKILL-body line to the skill file, not the test file', async () => {
    // The other half of the routing rule. A section body line lives in the
    // test file (asserted above); a skill body line lives in the skill's own
    // `.md`, and `step:skip` has to honour `frame.uri` exactly as `step:pass`
    // does or the ◌ lands on whatever sits at that line number in the test.
    const skillPath = path.resolve(FIXTURES_DIR, 'fake-skill.md');
    const skillUri = vscode.Uri.file(skillPath);
    const skillFrame = {
      id: 'f9',
      parentId: null,
      kind: 'skill',
      uri: skillPath,
      line: CALL_SIGN_IN,
      skillName: 'fake_skill',
    };

    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'frame:push', frame: skillFrame });
    fake.push({ type: 'step:pass', line: 3, frame: skillFrame });
    fake.push({ type: 'step:skip', line: 4, frame: skillFrame, reason: RETURN_REASON });
    await waitFor('skill-file line 4 shows skip', () => {
      const snap = hooks.tracker.snapshotFor(skillUri);
      if (!snap) return false;
      return Object.fromEntries(snap.statuses)[4] === 'skip';
    });

    const testStatuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    assert.equal(
      testStatuses[4],
      undefined,
      'the test file must not inherit a skill-body skip',
    );

    fake.push({ type: 'frame:pop', frameId: 'f9', outputs: {} });
    fake.push({ type: 'done', status: 'passed' });
    fake.end();
    await waitFor('run finished', () => !hooks.isRunning(), 10_000);
  });
});

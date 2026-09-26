/**
 * Drives the TestBench debug state machine end-to-end inside a real VS Code
 * extension host. Uses a FakeApiClient injected via the extension's
 * __testHooks export so the assertions are deterministic and don't depend
 * on a Sessions API server, AI gateway, or Playwright browser.
 *
 * Each test follows the same shape:
 *   1. Open the fixture .md, wait for it to be the active editor.
 *   2. Trigger a command (testbench-native.runSelected / pause / stop / resume).
 *   3. Push synthesized events onto the fake stream.
 *   4. Assert tracker state + isRunning() across the transition.
 *
 * Coverage maps to the spec at testbench/stories/specs/debugging-ux.md.
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

describe('TestBench debug state machine', function () {
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

    // Open the fixture and highlight line 9 with a real range selection.
    // testbench-native.runSelected treats cursor-only "selections" as a request to
    // run the whole test (the bug fix this suite documents), so tests that
    // want to scope a run to a single step must use a range. Line 9 is
    // "2. Click the 'Get started' button" in the fixture; selecting columns
    // 0..5 keeps the highlight inside the line.
    const uri = fixtureUri('test-with-steps.md');
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('fixture editor active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === uri.toString();
    });
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(8, 0), // 0-based: line 9 is index 8
      new vscode.Position(8, 5),
    );

    // Wait a beat for the activeFile context key to flip true after the
    // editor open (driven by ActiveFileTracker).
    await waitFor('active file detected as test file', () => {
      const snap = hooks.tracker.snapshot();
      return snap.isTestFile === true;
    });
  });

  it('idle → running: runSelected starts a run and reports running', async () => {
    assert.equal(hooks.isRunning(), false, 'should start idle');

    void vscode.commands.executeCommand('testbench-native.runSelected');

    await waitFor('isRunning becomes true', () => hooks.isRunning());
    await waitFor('fake stream is active', () => fake.hasActiveStream);
    assert.equal(hooks.isRunning(), true);

    // Tear down cleanly so the test doesn't leak a controller.
    fake.end();
    await waitFor('isRunning returns false after stream ends', () => !hooks.isRunning());
  });

  it('running → idle (success): step events drive statuses, done flips running off', async () => {
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'step:start', line: 9 });
    await waitFor('status running on line 9', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });

    fake.push({ type: 'step:pass', line: 9 });
    await waitFor('status pass on line 9', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'pass';
    });

    fake.end();
    await waitFor('idle after stream ends', () => !hooks.isRunning());
    assert.equal(hooks.tracker.snapshot().breakpointStop, null);
  });

  it('done event with reportPath updates lastReportPath on the controller', async () => {
    // Open Last Report wiring: server emits the absolute HTML report
    // path via DoneEvent.reportPath. The controller captures it so the
    // `testbench-native.openLastReport` command (and its sidebar button)
    // can resolve the path on click.
    assert.equal(hooks.lastReportPath(), null, 'precondition: no report yet');

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'step:start', line: 9 });
    fake.push({ type: 'step:pass', line: 9 });
    fake.push({ type: 'done', status: 'passed', reportPath: '/tmp/run-1.html' });
    fake.end();

    await waitFor('idle', () => !hooks.isRunning());
    assert.equal(
      hooks.lastReportPath(),
      '/tmp/run-1.html',
      'controller must capture reportPath from the done event',
    );
  });

  it('done event without reportPath leaves the previous lastReportPath intact', async () => {
    // Lifecycle rule (spec §5.2): a `done` event without reportPath does
    // NOT clear a previously-captured path. Older servers that never
    // emit the field, or runs that produced zero step results, must
    // not silently invalidate an existing button state.
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    fake.push({ type: 'step:pass', line: 9 });
    fake.push({ type: 'done', status: 'passed', reportPath: '/tmp/old.html' });
    fake.end();
    await waitFor('first run idle', () => !hooks.isRunning());
    assert.equal(hooks.lastReportPath(), '/tmp/old.html');

    // Second run: done without a path. Old path must survive.
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('second stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    fake.push({ type: 'step:pass', line: 9 });
    fake.push({ type: 'done', status: 'passed' });
    fake.end();
    await waitFor('second run idle', () => !hooks.isRunning());

    assert.equal(
      hooks.lastReportPath(),
      '/tmp/old.html',
      'lastReportPath must not be cleared by a done event lacking reportPath',
    );
  });

  it('running → idle (stop): testbench-native.stop aborts immediately, no pause marker, in-flight step marked stopped', async () => {
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    await waitFor('status running', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });

    await vscode.commands.executeCommand('testbench-native.stop');

    await waitFor('idle after stop', () => !hooks.isRunning());
    const snap = hooks.tracker.snapshot();
    assert.equal(
      snap.breakpointStop,
      null,
      'Stop must clear pause indicator (per spec §6)',
    );
    // The in-flight `running` step gets reclassified to `stopped` so the user
    // sees a grey square (not a permanent blue dot or stale running spinner).
    // markRunningStopped is wired into both stop handlers — this test covers
    // the testbench-native.stop command path.
    const statuses = Object.fromEntries(snap.statuses);
    assert.equal(
      statuses[9],
      'stopped',
      'Stop must flip in-flight running steps to stopped status',
    );
  });

  it('stop recovers the report path + token totals via getLastRun (issue 021)', async () => {
    // The stopped run's `done` (with reportPath/tokens) is dropped when the SSE
    // stream is aborted; the controller must re-fetch them via getLastRun so
    // "Open Last Report" works and tokens are surfaced.
    assert.equal(hooks.lastReportPath(), null, 'precondition: no report yet');

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    await waitFor('status running', () => Object.fromEntries(hooks.tracker.snapshot().statuses)[9] === 'running');

    await vscode.commands.executeCommand('testbench-native.stop');
    await waitFor('idle after stop', () => !hooks.isRunning());

    // The poll runs in the background after stop; wait for it to land.
    await waitFor('report path recovered', () => hooks.lastReportPath() === '/tmp/stopped-report.html');
    assert.ok(fake.getLastRunCalls.length >= 1, 'controller must poll getLastRun on stop');
    assert.deepEqual(hooks.lastRunTokens(), { total: 42, input: 30, output: 12 });
  });

  it('stop poll tolerates the finalize race — keeps polling until finalized (issue 021)', async () => {
    // The server writes the report AFTER it sees our disconnect, so the first
    // poll(s) can return finalized:false. The controller must keep polling.
    fake.lastRunSequence = [
      { finalized: false },
      { finalized: false },
      { finalized: true, tokens: { total: 7, input: 4, output: 3 }, reportPath: '/tmp/late.html' },
    ];

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    await waitFor('status running', () => Object.fromEntries(hooks.tracker.snapshot().statuses)[9] === 'running');

    await vscode.commands.executeCommand('testbench-native.stop');
    await waitFor('idle after stop', () => !hooks.isRunning());

    await waitFor('late report path recovered', () => hooks.lastReportPath() === '/tmp/late.html', 8_000);
    assert.ok(fake.getLastRunCalls.length >= 3, 'must poll past the not-finalized responses');
  });

  it('pause does NOT poll getLastRun (issue 021 — recovery is stop-only)', async () => {
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    await waitFor('status running', () => Object.fromEntries(hooks.tracker.snapshot().statuses)[9] === 'running');

    await vscode.commands.executeCommand('testbench-native.pause');
    await waitFor('paused (idle)', () => !hooks.isRunning());
    // Give any erroneous background poll a chance to fire before asserting none did.
    await sleep(300);
    assert.equal(fake.getLastRunCalls.length, 0, 'pause must not trigger the stop-only report recovery');
  });

  it('running → idle (Close Session): restartSession stops the in-flight run AND closes the session', async () => {
    // Close Session must also stop the test — otherwise the in-flight step's
    // spinner / yellow ▶ stay painted after the session is gone, and a later
    // Continue would spin up a fresh session against stale UI state.
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    await waitFor('status running', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });

    const closeCallsBefore = fake.closeSessionCalls;
    await vscode.commands.executeCommand('testbench-native.restartSession');

    await waitFor('idle after Close Session', () => !hooks.isRunning());
    const snap = hooks.tracker.snapshot();
    assert.equal(
      snap.breakpointStop,
      null,
      'Close Session must clear any pause indicator',
    );
    const statuses = Object.fromEntries(snap.statuses);
    assert.equal(
      statuses[9],
      'stopped',
      'Close Session must flip the in-flight running step to stopped (parity with Stop)',
    );
    assert.ok(
      fake.closeSessionCalls > closeCallsBefore,
      'Close Session must still close the server session',
    );
  });

  it('paused → idle (Close Session): restartSession clears the yellow ▶ on a paused run', async () => {
    // A breakpoint-paused run isn't actively streaming (controller.active is
    // null), so closeSession's own abort is a no-op. The explicit stop in the
    // command is what clears the parked yellow ▶ — guard that it does.
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(fixtureUri('test-with-steps.md'), new vscode.Position(9, 0)),
        true,
      ),
    ]);
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    fake.push({ type: 'step:pass', line: 9 });
    fake.end();
    await waitFor('paused at line 10', () => hooks.tracker.snapshot().breakpointStop === 10);
    await waitFor('idle while paused', () => !hooks.isRunning());

    await vscode.commands.executeCommand('testbench-native.restartSession');
    await waitFor('yellow arrow cleared by Close Session', () => {
      return hooks.tracker.snapshot().breakpointStop === null;
    });
    assert.equal(hooks.isRunning(), false);
  });

  it('runStart: a started run sends it on its first block; a Continue does not (SPEC-use-computer §4.5)', async () => {
    // The server resets the session's surface only on a batch that says it
    // starts a run. A run that failed inside `[use computer]` leaves the
    // reused session on the computer surface, so a started run that forgot to
    // say so would hand its first step to the real mouse — and a Continue
    // that DID say so would drop a paused desktop excursion back onto the page.
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(fixtureUri('test-with-steps.md'), new vscode.Position(9, 0)),
        true,
      ),
    ]);
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));

    // Run (the whole test): the first block starts at step 1 — index 0.
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    assert.deepEqual(fake.requests[0].runStart, { stepIndex: 0 });
    fake.push({ type: 'step:start', line: 8 });
    fake.push({ type: 'step:pass', line: 8 });
    fake.push({ type: 'step:start', line: 9 });
    fake.push({ type: 'step:pass', line: 9 });
    fake.end();
    await waitFor('paused at line 10', () => hooks.tracker.snapshot().breakpointStop === 10);
    await waitFor('idle while paused', () => !hooks.isRunning());

    // Continue: the same run, so no runStart — the surface it paused on stays.
    void vscode.commands.executeCommand('testbench-native.continueRun');
    await waitFor('continuation requested', () => fake.requests.length > 1);
    assert.deepEqual(fake.requests[1].sourceLines, [10]);
    assert.equal(fake.requests[1].runStart, undefined, 'a Continue must not reset the surface');
    fake.end();
    await waitFor('idle after continue', () => !hooks.isRunning());
    vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);

    // Run Step Here on step 2 (line 9): a started run, starting at index 1.
    editor.selection = new vscode.Selection(new vscode.Position(8, 0), new vscode.Position(8, 5));
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('third run requested', () => fake.requests.length > 2);
    assert.deepEqual(fake.requests[2].sourceLines, [9]);
    assert.deepEqual(fake.requests[2].runStart, { stepIndex: 1 });
    fake.end();
    await waitFor('idle after the mid-file run', () => !hooks.isRunning());
  });

  // A started run that parks before ANY batch reaches the server still owes
  // the server its `runStart`. The Continue is `isResume`, which never sends
  // one — so before this, the whole run executed on whatever surface the LAST
  // run left, and after a failure inside `[use computer]` that is the real
  // mouse. The first batch the run does send carries it, from that batch's own
  // first step, and only that one.
  describe('runStart owed by a run that paused before sending anything (SPEC-use-computer §4.5)', () => {
    /** Write a throwaway fixture, open it, and wait until TestBench owns it. */
    async function openTempFixture(name, body) {
      const fs = require('node:fs');
      const file = path.resolve(FIXTURES_DIR, name);
      fs.writeFileSync(file, body, 'utf-8');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      const uri = vscode.Uri.file(file);
      await vscode.commands.executeCommand('vscode.open', uri);
      await waitFor('temp fixture active', () => {
        const e = vscode.window.activeTextEditor;
        return e && e.document.uri.toString() === uri.toString();
      });
      await waitFor('temp fixture detected as a test', () => hooks.tracker.snapshot().isTestFile === true);
      const editor = vscode.window.activeTextEditor;
      // Cursor only: runSelected reads that as "run the whole test".
      editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
      return { file, uri };
    }

    afterEach(async () => {
      // Releases a run a failed assertion left parked or prompting, so what it
      // still owes cannot leak into the next test's run of the same file.
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await vscode.commands.executeCommand('testbench-native.stop');
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      const fs = require('node:fs');
      for (const name of ['run-start-input.tmp.md', 'run-start-interactive.tmp.md']) {
        fs.rmSync(path.resolve(FIXTURES_DIR, name), { force: true });
      }
    });

    it('a breakpoint on step 1: the Continue carries it (stepIndex 0), and the Continue after that does not', async () => {
      const uri = fixtureUri('test-with-steps.md');
      vscode.debug.addBreakpoints([
        new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(7, 0)), true), // step 1
        new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(9, 0)), true), // step 3
      ]);
      const editor = vscode.window.activeTextEditor;
      editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));

      void vscode.commands.executeCommand('testbench-native.runSelected');
      await waitFor('parked on step 1', () => hooks.tracker.snapshot().breakpointStop === 8);
      await waitFor('idle while parked', () => !hooks.isRunning());
      assert.equal(fake.requests.length, 0, 'precondition: the run parked having sent nothing');

      // Continue: the first batch of the run the user started.
      void vscode.commands.executeCommand('testbench-native.continueRun');
      await waitFor('first block sent', () => fake.requests.length === 1);
      assert.deepEqual(fake.requests[0].sourceLines, [8, 9]);
      assert.deepEqual(
        fake.requests[0].runStart,
        { stepIndex: 0 },
        'the run starts on the surface its file says, not the one the last run left',
      );
      fake.push({ type: 'step:start', line: 8 });
      fake.push({ type: 'step:pass', line: 8 });
      fake.push({ type: 'step:start', line: 9 });
      fake.push({ type: 'step:pass', line: 9 });
      fake.end();
      await waitFor('parked on step 3', () => hooks.tracker.snapshot().breakpointStop === 10);
      await waitFor('idle while parked again', () => !hooks.isRunning());

      // A second Continue of the same run: it already said it began.
      void vscode.commands.executeCommand('testbench-native.continueRun');
      await waitFor('second block sent', () => fake.requests.length === 2);
      assert.deepEqual(fake.requests[1].sourceLines, [10]);
      assert.equal(fake.requests[1].runStart, undefined, 'never twice in one run');
      fake.end();
      await waitFor('idle after the run ends', () => !hooks.isRunning());
    });

    it('an [input:] then a breakpoint: the Continue carries it, from its own first step', async () => {
      const { uri } = await openTempFixture(
        'run-start-input.tmp.md',
        [
          '---',
          'type: test',
          '---',
          '',
          '# runStart after an input',
          '',
          '## Steps',
          '1. [input: who] Who is signing in?',
          '2. Navigate to https://example.com',
          '3. Click the "Get started" button',
          '',
        ].join('\n'),
      );
      vscode.debug.addBreakpoints([
        new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(8, 0)), true), // step 2
      ]);

      void vscode.commands.executeCommand('testbench-native.runSelected');
      // `[input:]` prompts through VS Code's own InputBox. Accepting it empty
      // answers `''`, which is an answer (a cancel would end the run). There
      // is no hook for "the box is open", and accepting early is a no-op, so
      // keep accepting until the run parks on the breakpoint behind it.
      await waitFor(
        'input answered and the run parked on step 2',
        async () => {
          if (hooks.tracker.snapshot().breakpointStop === 9) return true;
          await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
          return hooks.tracker.snapshot().breakpointStop === 9;
        },
        10_000,
      );
      await waitFor('idle while parked', () => !hooks.isRunning());
      assert.equal(fake.requests.length, 0, 'precondition: an [input:] sends nothing to the server');

      void vscode.commands.executeCommand('testbench-native.continueRun');
      await waitFor('first block sent', () => fake.requests.length === 1);
      assert.deepEqual(fake.requests[0].sourceLines, [9, 10]);
      assert.deepEqual(fake.requests[0].runStart, { stepIndex: 1 });
      fake.end();
      await waitFor('idle after the run ends', () => !hooks.isRunning());
    });

    it('[interactive] first: the first REPL turn carries it; a run left without a turn hands it to the next block', async () => {
      await openTempFixture(
        'run-start-interactive.tmp.md',
        [
          '---',
          'type: test',
          '---',
          '',
          '# runStart from an interactive start',
          '',
          '## Steps',
          '1. [interactive] Look around first',
          '2. Navigate to https://example.com',
          '',
        ].join('\n'),
      );

      // Run 1: type a step at the REPL, then /continue.
      void vscode.commands.executeCommand('testbench-native.runSelected');
      // The composer has no "prompt is open" hook, and answering early is a
      // silent no-op, so keep answering until the turn goes out.
      await waitFor(
        'the REPL turn is sent',
        async () => {
          if (fake.requests.length >= 1) return true;
          await hooks.dispatchWebviewMessage({ type: 'promptResponse', text: 'Scroll to the footer' });
          return fake.requests.length >= 1;
        },
        10_000,
      );
      const turn = fake.requests[0];
      assert.deepEqual(turn.steps, ['Scroll to the footer']);
      assert.deepEqual(turn.runStart, { stepIndex: 0 }, 'the REPL turn is the batch that starts the run');
      // `stepIndex` is a position in `fullSteps`; without the list the server
      // starts on `browser` whatever the index says.
      assert.deepEqual(turn.fullSteps, ['[interactive] Look around first', 'Navigate to https://example.com']);
      fake.end();
      await waitFor(
        'the block after the REPL is sent',
        async () => {
          if (fake.requests.length >= 2) return true;
          await hooks.dispatchWebviewMessage({ type: 'promptResponse', text: '/continue' });
          return fake.requests.length >= 2;
        },
        10_000,
      );
      assert.deepEqual(fake.requests[1].sourceLines, [9]);
      assert.equal(fake.requests[1].runStart, undefined, 'spent by the REPL turn — never twice');
      fake.end();
      await waitFor('run 1 idle', () => !hooks.isRunning());

      // Run 2: leave the REPL without typing anything. Nothing went out, so
      // the block after it is the batch that starts the run.
      void vscode.commands.executeCommand('testbench-native.runSelected');
      await waitFor(
        'run 2: the block after the REPL is sent',
        async () => {
          if (fake.requests.length >= 3) return true;
          await hooks.dispatchWebviewMessage({ type: 'promptResponse', text: '/continue' });
          return fake.requests.length >= 3;
        },
        10_000,
      );
      assert.deepEqual(fake.requests[2].sourceLines, [9]);
      assert.deepEqual(fake.requests[2].runStart, { stepIndex: 1 });
      fake.end();
      await waitFor('run 2 idle', () => !hooks.isRunning());
    });
  });

  it('running → idle (webview stop): webview-driven stop also marks in-flight step stopped', async () => {
    // Guards the two-handler regression class: testbench-native.stop and the
    // webview-message `{ type: 'stop' }` handler are separate code paths.
    // Both must call tracker.markRunningStopped — if a future contributor
    // wires it into only one handler, the user will see inconsistent UX
    // depending on whether they clicked the title-bar Stop or the webview
    // toolbar Stop. (See feedback memory: VS Code commands & message types
    // are often registered in two places; fix both.)
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    await waitFor('status running', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });

    await hooks.dispatchWebviewMessage({ type: 'stop' });

    await waitFor('idle after webview stop', () => !hooks.isRunning());
    const snap = hooks.tracker.snapshot();
    assert.equal(snap.breakpointStop, null, 'webview stop must clear pause indicator');
    const statuses = Object.fromEntries(snap.statuses);
    assert.equal(
      statuses[9],
      'stopped',
      'webview stop must flip running step to stopped (parity with testbench-native.stop)',
    );
  });

  it('stop while paused (with already-passed step): stop preserves pass status, does not flip to stopped', async () => {
    // markRunningStopped must ONLY flip rows that are currently `running` —
    // not pass/fail/skip. If a step finished successfully before pause and
    // the user then hit Stop, that pass should stay a pass, not become a
    // stopped square.
    const uri = vscode.window.activeTextEditor.document.uri;
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(9, 0)), // line 10
        true,
      ),
    ]);
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(8, 0),
      // Ends PAST column 0 of line 10 so that line is part of the selection.
      // A selection ending AT column 0 of a later line stops before it
      // (stories/data-row-progress-and-selection.md, decision 10) — that
      // position is the line break a whole-line gesture swallowed, not a
      // line the user chose. This test wants both steps.
      new vscode.Position(9, 10),
    );

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    fake.push({ type: 'step:pass', line: 9 });
    fake.end();
    await waitFor('paused at 10 after step 9 passes', () => hooks.tracker.snapshot().breakpointStop === 10);
    await waitFor('idle while paused', () => !hooks.isRunning());

    // Step 9 should be `pass` at this point — no `running` rows to flip.
    const beforeStop = Object.fromEntries(hooks.tracker.snapshot().statuses);
    assert.equal(beforeStop[9], 'pass', 'precondition: step 9 should be pass');

    await vscode.commands.executeCommand('testbench-native.stop');
    await waitFor('breakpointStop cleared', () => hooks.tracker.snapshot().breakpointStop === null);
    const afterStop = Object.fromEntries(hooks.tracker.snapshot().statuses);
    assert.equal(
      afterStop[9],
      'pass',
      'Stop must NOT downgrade a passed step to stopped — only running rows flip',
    );
  });

  it('Step Into from a breakpoint pause preserves earlier steps\' pass marks', async () => {
    // Regression: Step Into / Over / Out resuming from a breakpoint pause
    // must be a continuation (like Continue). Without isContinuation, the
    // relaunch clears all statuses and the ✓ earned by steps before the
    // breakpoint vanishes the moment the user Steps Into the next step.
    const uri = vscode.window.activeTextEditor.document.uri;
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(9, 0)), // line 10
        true,
      ),
    ]);
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(8, 0),
      // Ends PAST column 0 of line 10 so that line is part of the selection.
      // A selection ending AT column 0 of a later line stops before it
      // (stories/data-row-progress-and-selection.md, decision 10) — that
      // position is the line break a whole-line gesture swallowed, not a
      // line the user chose. This test wants both steps.
      new vscode.Position(9, 10),
    );

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    fake.push({ type: 'step:pass', line: 9 });
    fake.end();
    await waitFor('paused at 10 after step 9 passes', () => hooks.tracker.snapshot().breakpointStop === 10);
    await waitFor('idle while paused', () => !hooks.isRunning());
    assert.equal(
      Object.fromEntries(hooks.tracker.snapshot().statuses)[9],
      'pass',
      'precondition: step 9 passed before the breakpoint',
    );

    // Step Into → relaunches from the breakpoint line. The earlier pass
    // mark must survive the relaunch.
    void vscode.commands.executeCommand('testbench-native.stepInto');
    await waitFor('new stream after Step Into', () => fake.hasActiveStream);
    assert.equal(
      Object.fromEntries(hooks.tracker.snapshot().statuses)[9],
      'pass',
      'Step Into from a breakpoint pause must NOT clear earlier pass marks',
    );
  });

  it('webview Resume from a breakpoint pause preserves earlier pass marks', async () => {
    // The sidebar ▶ Resume button posts {type:'resume'}, which now
    // delegates to the continueRun command. Guards that the delegation
    // carries isContinuation (earlier hand-rolled webview Resume cleared
    // statuses; the command path never did).
    const uri = vscode.window.activeTextEditor.document.uri;
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(9, 0)), // line 10
        true,
      ),
    ]);
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(8, 0),
      // Ends PAST column 0 of line 10 so that line is part of the selection.
      // A selection ending AT column 0 of a later line stops before it
      // (stories/data-row-progress-and-selection.md, decision 10) — that
      // position is the line break a whole-line gesture swallowed, not a
      // line the user chose. This test wants both steps.
      new vscode.Position(9, 10),
    );

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    fake.push({ type: 'step:pass', line: 9 });
    fake.end();
    await waitFor('paused at 10', () => hooks.tracker.snapshot().breakpointStop === 10);
    await waitFor('idle while paused', () => !hooks.isRunning());
    assert.equal(
      Object.fromEntries(hooks.tracker.snapshot().statuses)[9],
      'pass',
      'precondition: step 9 passed before the breakpoint',
    );

    // Fire-and-forget: the resume delegates to continueRun, whose body awaits
    // runLines() → the SSE stream. Awaiting here would deadlock, since this
    // test is the one that must feed and end that stream (see the
    // `testbench-native.resume` test below for the same rule).
    void hooks.dispatchWebviewMessage({ type: 'resume' });
    await waitFor('new stream after webview Resume', () => fake.hasActiveStream);
    assert.equal(
      Object.fromEntries(hooks.tracker.snapshot().statuses)[9],
      'pass',
      'webview Resume must preserve earlier pass marks (delegates to continueRun)',
    );

    fake.end();
    await waitFor('idle after resume completes', () => !hooks.isRunning());
  });

  it('webview Close Session stops the in-flight run and closes the session', async () => {
    // The sidebar Close Session button posts {type:'restartSession'}, which
    // now delegates to the restartSession command — so it gets the same
    // stop-the-run cleanup as the editor-title command (parity).
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    await waitFor('status running', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });

    const closeBefore = fake.closeSessionCalls;
    await hooks.dispatchWebviewMessage({ type: 'restartSession' });
    await waitFor('idle after webview Close Session', () => !hooks.isRunning());
    const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    assert.equal(
      statuses[9],
      'stopped',
      'webview Close Session must flip the in-flight running step to stopped',
    );
    assert.ok(
      fake.closeSessionCalls > closeBefore,
      'webview Close Session must still close the server session',
    );
  });

  it('running → paused (user pause): testbench-native.pause marks resume point', async () => {
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    await waitFor('status running on line 9', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });

    await vscode.commands.executeCommand('testbench-native.pause');

    await waitFor('breakpointStop is set to executing line', () => {
      return hooks.tracker.snapshot().breakpointStop === 9;
    });
    await waitFor('isRunning becomes false', () => !hooks.isRunning());
  });

  it('continueRun from idle is a safe no-op (no stream opened, no exception)', async () => {
    // Phase 5 follow-up: when there's no run to continue (idle state),
    // the unified continueRun falls through to a status-bar message
    // rather than crashing or opening a stream. Easy to break if a
    // future change drops one of the guard conditions.
    assert.equal(hooks.isRunning(), false, 'precondition: must be idle');
    await vscode.commands.executeCommand('testbench-native.continueRun');
    // Give any spurious async work a chance to surface.
    await sleep(100);
    assert.equal(hooks.isRunning(), false, 'continueRun from idle must not start a run');
    assert.equal(fake.hasActiveStream, false, 'continueRun from idle must not open a stream');
    assert.equal(fake.runControlCalls.length, 0, 'continueRun from idle must not POST run-control');
  });

  it('resetAllStateForTests clears the resume anchor (no phantom pause leaks into the next test)', async () => {
    // Regression guard for the leak that hid behind test ordering: the resume
    // anchor is tracker-level (not per-URI), so wiping `states` alone left it
    // behind. A stale anchor surfaced via breakpointStopFor() as a phantom
    // pause in the following test, which then hung opening a stream. This
    // asserts the reset clears the anchor directly, independent of test order.
    const uri = fixtureUri('test-with-steps.md');
    hooks.tracker.setBreakpointStop(uri, 9);
    assert.equal(hooks.tracker.breakpointStopFor(uri), 9, 'precondition: anchor set at line 9');

    hooks.tracker.resetAllStateForTests();
    assert.equal(
      hooks.tracker.breakpointStopFor(uri),
      null,
      'resetAllStateForTests must drop the tracker-level resume anchor',
    );
  });

  it('the `paused` context key is per-file: a stop parked on one test does not light up Continue on another', async () => {
    // Regression for the leaking Continue button. A failure (or pause) parks a
    // breakpointStop on the test that stopped — exactly the call below, which
    // is what the step:fail / pause paths make. The Continue/Resume button is
    // gated on the `testbench-native.paused` context key, which used to be a
    // single global flag: once one test parked a stop, the button followed the
    // user onto every OTHER test they opened. It must instead reflect only the
    // active file's own resume point. (VS Code doesn't expose context keys to
    // extensions, so we read the tracker's mirror of the last pushed value.)
    const uriA = fixtureUri('test-with-steps.md'); // active from beforeEach
    const uriB = fixtureUri('test-shared-a.md'); // a different test file

    hooks.tracker.setBreakpointStop(uriA, 9);
    await waitFor(
      'paused key true on the test that stopped',
      () => hooks.tracker.lastPausedContextValue === true,
    );

    // Switch to a different test — the button must not come along.
    await vscode.commands.executeCommand('vscode.open', uriB);
    await waitFor('editor B is active', () => {
      const e = vscode.window.activeTextEditor;
      return e && e.document.uri.toString() === uriB.toString();
    });
    await waitFor(
      'paused key clears on the unrelated test',
      () => hooks.tracker.lastPausedContextValue === false,
    );
    // The resume point itself is untouched — only the active-file-scoped key
    // changed. Switching back must restore it.
    assert.equal(
      hooks.tracker.breakpointStopFor(uriA),
      9,
      'switching editors must not discard the parked resume point',
    );

    await vscode.commands.executeCommand('vscode.open', uriA);
    await waitFor('editor A is active again', () => {
      const e = vscode.window.activeTextEditor;
      return e && e.document.uri.toString() === uriA.toString();
    });
    await waitFor(
      'paused key returns on the test that still has a parked stop',
      () => hooks.tracker.lastPausedContextValue === true,
    );
  });

  it('paused → running (continueRun handles breakpoint state too): the unified Continue command re-opens the stream', async () => {
    // Phase 5 follow-up: testbench-native.continueRun was originally a
    // step-paused-only command (POST run-control). It's now unified so
    // it ALSO handles breakpoint-pause (the old resume path). The
    // existing `testbench-native.resume` test below still passes via
    // the back-compat alias; THIS test asserts that calling continueRun
    // directly from a breakpoint-pause state also re-opens the stream.
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    await waitFor('running on line 9', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });
    await vscode.commands.executeCommand('testbench-native.pause');
    await waitFor('paused at 9', () => hooks.tracker.snapshot().breakpointStop === 9);
    await waitFor('idle while paused', () => !hooks.isRunning());

    void vscode.commands.executeCommand('testbench-native.continueRun');
    await waitFor('isRunning back to true', () => hooks.isRunning());
    await waitFor('new fake stream', () => fake.hasActiveStream);
    assert.equal(
      hooks.tracker.snapshot().breakpointStop,
      null,
      'continueRun from breakpoint-pause must clear the pause indicator',
    );

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('paused → running (resume): testbench-native.resume re-opens the stream from paused line', async () => {
    // Drive into paused state.
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    await waitFor('running on line 9', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });
    await vscode.commands.executeCommand('testbench-native.pause');
    await waitFor('paused at 9', () => hooks.tracker.snapshot().breakpointStop === 9);
    await waitFor('idle while paused', () => !hooks.isRunning());

    // Resume — opens a new stream from line 9 with skipBreakpointAtStart.
    // Fire-and-forget: the command body awaits runLines() which awaits the
    // stream, so awaiting the command here would deadlock since this test
    // is the one feeding the stream events.
    void vscode.commands.executeCommand('testbench-native.resume');
    await waitFor('isRunning back to true', () => hooks.isRunning());
    await waitFor('new fake stream', () => fake.hasActiveStream);
    assert.equal(
      hooks.tracker.snapshot().breakpointStop,
      null,
      'Resume must clear the pause indicator',
    );

    fake.end();
    await waitFor('idle after resume completes', () => !hooks.isRunning());
  });

  it('running → paused (auto): hitting a breakpoint trims the run and reports pause AFTER prior steps finish', async () => {
    // Set a breakpoint on a later step (line 10 → "3. Verify ...").
    const uri = vscode.window.activeTextEditor.document.uri;
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(9, 0)),
        true,
      ),
    ]);

    // Run from line 9, with the breakpoint on line 10. The runner should
    // execute step 9, then pause before step 10.
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(8, 0),
      // Ends PAST column 0 of line 10 so that line is part of the selection.
      // A selection ending AT column 0 of a later line stops before it
      // (stories/data-row-progress-and-selection.md, decision 10) — that
      // position is the line break a whole-line gesture swallowed, not a
      // line the user chose. This test wants both steps.
      new vscode.Position(9, 10),
    );

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    // Spec promise: the yellow ▶ should NOT appear before the preceding
    // steps actually finish. trimAtBreakpoint computes pausedAt synchronously
    // when the run kicks off, but the controller must defer publishing
    // breakpointStop until execution genuinely reaches that point.
    assert.equal(
      hooks.tracker.snapshot().breakpointStop,
      null,
      'breakpointStop must NOT be set while line 9 is still running',
    );

    fake.push({ type: 'step:start', line: 9 });
    await waitFor('status running on line 9', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });
    assert.equal(
      hooks.tracker.snapshot().breakpointStop,
      null,
      'breakpointStop still must not be set mid-step',
    );

    fake.push({ type: 'step:pass', line: 9 });
    fake.end();

    // Only after step 9 passes and the stream drains should the pause
    // indicator land on line 10 — and the runner should be idle.
    await waitFor('breakpointStop becomes line 10 after step 9 completes', () => {
      return hooks.tracker.snapshot().breakpointStop === 10;
    });
    await waitFor('idle after trimmed run', () => !hooks.isRunning());
  });

  it('running → paused (early pause): Pause before any step:start still marks a resume point', async () => {
    // This guards the bug where pausing immediately after Run — before
    // the server emits the first step:start event — would leave the
    // controller without a resume point. Without the classified[0]
    // fallback, paused state never gets set and the Resume button
    // doesn't render.
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    // No step:start pushed — pause immediately.
    await vscode.commands.executeCommand('testbench-native.pause');

    await waitFor('breakpointStop falls back to first selected step', () => {
      return hooks.tracker.snapshot().breakpointStop === 9;
    });
    await waitFor('isRunning becomes false', () => !hooks.isRunning());
  });

  it('paused → idle (stop): Stop while paused clears the pause indicator', async () => {
    // Trigger a pause via breakpoint.
    const uri = vscode.window.activeTextEditor.document.uri;
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(8, 0)),
        true,
      ),
    ]);
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('paused at 9', () => hooks.tracker.snapshot().breakpointStop === 9);
    await waitFor('idle while paused', () => !hooks.isRunning());

    await vscode.commands.executeCommand('testbench-native.stop');
    await waitFor('breakpointStop cleared', () => hooks.tracker.snapshot().breakpointStop === null);
    assert.equal(hooks.isRunning(), false);
  });

  it('breakpoint on first selected step (explicit range): pauses immediately, no stream opens', async () => {
    // Audit gap: existing trim-pause test puts the breakpoint on the *second*
    // selected step, so the trimmed run still has one item and the stream
    // opens. The empty-trim branch (`classified.length === 0` in
    // run-controller.runLines) is its own code path — pause indicator goes up
    // and `done(aborted)` fires without ever creating a fake stream.
    //
    // The empty-trim branch is reached when the user explicitly highlights
    // a single step that also has a breakpoint on it. Cursor-only on a
    // breakpoint line now expands to runAll (see the cursor-parked test
    // above), so this scenario requires a real range selection.
    const uri = vscode.window.activeTextEditor.document.uri;
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(8, 0)), // line 9, the only selected step
        true,
      ),
    ]);

    // Explicit range selection covering line 9 only — start at column 0,
    // end at column 5 (still on line 9). hasRange becomes true so
    // runSelected uses the highlighted line, not the runAll fallback.
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(8, 0),
      new vscode.Position(8, 5),
    );

    void vscode.commands.executeCommand('testbench-native.runSelected');

    await waitFor('paused at line 9', () => hooks.tracker.snapshot().breakpointStop === 9);
    await waitFor('idle (no stream needed)', () => !hooks.isRunning());
    assert.equal(
      fake.hasActiveStream,
      false,
      'Empty-trim branch must short-circuit before opening a stream',
    );
  });

  it('paused (early) → running (resume): resume from a fallback-derived pause point opens a stream', async () => {
    // Audit gap: existing resume test pauses *after* a step:start arrived,
    // so the resume line is the real lastStepStartLine. With early-pause the
    // breakpointStop is sourced from classified[0]?.line — same dispatcher
    // path, but verifying it round-trips through resume too.
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    // Pause before any step:start — fallback path sets breakpointStop = 9.
    await vscode.commands.executeCommand('testbench-native.pause');
    await waitFor('paused at 9 via fallback', () => hooks.tracker.snapshot().breakpointStop === 9);
    await waitFor('idle while paused', () => !hooks.isRunning());

    void vscode.commands.executeCommand('testbench-native.resume');
    await waitFor('isRunning back to true', () => hooks.isRunning());
    await waitFor('new fake stream', () => fake.hasActiveStream);
    assert.equal(
      hooks.tracker.snapshot().breakpointStop,
      null,
      'Resume must clear pause indicator regardless of where it came from',
    );

    fake.push({ type: 'step:start', line: 9 });
    fake.push({ type: 'step:pass', line: 9 });
    fake.end();
    await waitFor('idle after resume completes', () => !hooks.isRunning());
  });

  it('resume sends ALL steps from the pause point onward, not just the paused step', async () => {
    // Audit gap: existing resume test asserts a stream re-opens, but doesn't
    // check *which* steps it carries. With runLines([startLine]) and a
    // step-line startLine, resolveRunLines collapses to a single-step run —
    // so resume only re-executes the paused step then ends, instead of
    // continuing forward. The user's spec promise is "Resume continues
    // from the pause point" (analogous to F5 in a debugger), which means
    // resume must carry steps from startLine through end-of-document.
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'step:start', line: 9 });
    await waitFor('running on line 9', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });
    await vscode.commands.executeCommand('testbench-native.pause');
    await waitFor('paused at 9', () => hooks.tracker.snapshot().breakpointStop === 9);
    await waitFor('idle while paused', () => !hooks.isRunning());

    const requestsBeforeResume = fake.requests.length;

    void vscode.commands.executeCommand('testbench-native.resume');
    await waitFor('new fake stream after resume', () => fake.hasActiveStream);

    // The fixture (test-with-steps.md) has steps on lines 8, 9, 10
    // (1-based). Pause is on line 9, so resume must carry lines 9 and 10
    // — not just line 9.
    const resumeRequest = fake.requests[requestsBeforeResume];
    assert.ok(resumeRequest, 'Resume should have triggered a new streamSteps call');
    assert.deepEqual(
      resumeRequest.sourceLines,
      [9, 10],
      `Resume must carry every step from the pause point through end-of-document, not just the paused step. Got ${JSON.stringify(resumeRequest.sourceLines)}.`,
    );

    fake.end();
    await waitFor('idle after resume', () => !hooks.isRunning());
  });

  it('Run after a pause clears the stale yellow arrow before the stream opens', async () => {
    // Bug guard: the clear of stale breakpointStop used to live AFTER env-
    // file resolution inside runLines. On Windows that's 50-200ms of file
    // I/O, during which the previous pause's yellow ▶ stayed pinned to the
    // breakpoint line. To the user that read as "the arrow jumped straight
    // to the breakpoint as soon as I clicked Run."
    //
    // The contract: by the time the stream opens, the stale arrow MUST be
    // gone. The new run owns the indicator from then on.
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('first stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    await waitFor('running on 9', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });
    await vscode.commands.executeCommand('testbench-native.pause');
    await waitFor('paused at 9', () => hooks.tracker.snapshot().breakpointStop === 9);
    await waitFor('idle while paused', () => !hooks.isRunning());
    assert.equal(hooks.tracker.snapshot().breakpointStop, 9, 'precondition: arrow at line 9');

    // Click Run again (NOT Resume — Run starts fresh and should drop the
    // stale arrow before any visible delay).
    void vscode.commands.executeCommand('testbench-native.runSelected');

    // By the time the new stream opens, the stale breakpointStop must be
    // cleared. If the clear were still buried after env resolution, we'd
    // observe `breakpointStop === 9` here on slower hosts.
    await waitFor('new stream active for the second run', () => fake.hasActiveStream);
    assert.equal(
      hooks.tracker.snapshot().breakpointStop,
      null,
      'Stale yellow arrow must clear before the new run opens its stream',
    );

    fake.end();
    await waitFor('idle after second run', () => !hooks.isRunning());
  });

  it('Resume flips testbench-native.running to true synchronously, before any new step events arrive', async () => {
    // Bug guard: the editor title-bar Pause/Stop icons are gated on the
    // `testbench-native.running` context key. The original implementation polled
    // anyRunning() inside notifyRunning(true) — but that hook fires
    // synchronously BEFORE controller.runLines() sets controller.active,
    // so the poll read false and the context key got pinned at false until
    // a run event drove a refresh. To the user this looked like "Pause
    // disappeared the moment I clicked Resume" until the first step:start
    // arrived seconds later.
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    await waitFor('running on 9', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });
    await vscode.commands.executeCommand('testbench-native.pause');
    await waitFor('paused at 9', () => hooks.tracker.snapshot().breakpointStop === 9);
    await waitFor('idle while paused', () => !hooks.isRunning());
    assert.equal(
      hooks.runningContextValue(),
      false,
      'context key must be false while paused',
    );

    // Click Resume. We deliberately do NOT push step:start yet — the test
    // is about state in the gap between the resume command firing and the
    // first run event arriving. Use `await` here because resume is async
    // and we want it to drain notifyRunning(true) before we poll.
    void vscode.commands.executeCommand('testbench-native.resume');

    // Two microtask ticks is enough — extension.ts case 'resume' calls
    // notifyRunning(true) synchronously before the first await.
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(
      hooks.runningContextValue(),
      true,
      'Resume must flip testbench-native.running=true synchronously, not after the first stream event',
    );

    // Sanity: the context key stays true even if no events arrive for a
    // moment.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      hooks.runningContextValue(),
      true,
      'context key must stay true while waiting for stream events',
    );

    fake.end();
    await waitFor('idle after fake.end', () => !hooks.isRunning());
    assert.equal(
      hooks.runningContextValue(),
      false,
      'context key must drop to false after the run finishes',
    );
  });

  it('resume from breakpoint-trim pause skips the breakpoint on the resume line', async () => {
    // Audit gap: existing resume test resumes from a user-pause line that
    // has no breakpoint on it. After a breakpoint-trim pause the resume
    // line *is* the breakpoint line — skipBreakpointAtStart must let it
    // through, otherwise resume would re-pause on the same line forever.
    const uri = vscode.window.activeTextEditor.document.uri;
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(8, 0)), // line 9
        true,
      ),
    ]);

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('paused at line 9 via trim', () => hooks.tracker.snapshot().breakpointStop === 9);
    await waitFor('idle while paused', () => !hooks.isRunning());

    // Resume — must skip the breakpoint on line 9 and actually open a stream.
    void vscode.commands.executeCommand('testbench-native.resume');
    await waitFor('stream opens after resume past breakpoint', () => fake.hasActiveStream);
    assert.equal(
      hooks.tracker.snapshot().breakpointStop,
      null,
      'Resume must clear pause even though line 9 still has a breakpoint',
    );

    fake.push({ type: 'step:start', line: 9 });
    fake.push({ type: 'step:pass', line: 9 });
    fake.end();
    await waitFor('idle after resume completes', () => !hooks.isRunning());
  });

  it('Run with cursor parked on a breakpoint line: runs every preceding step from the top instead of silently pausing without executing anything', async () => {
    // User-reported bug: with a breakpoint on step 3, run the test, hit the
    // breakpoint, reload the VS Code window, hit Run again. After reload
    // VS Code restores the cursor to where it was last (the breakpoint
    // line), so F5 / Play (both bound to testbench-native.runSelected) runs with
    // selectionLines === [breakpoint line]. trimAtBreakpoint then returns
    // runnable=[] with pausedAt=breakpoint line, the empty-trim branch
    // posts breakpointStop and calls it done — yellow ▶ lands on step 3
    // immediately, steps 1 and 2 never execute.
    //
    // Cursor-only "selection" isn't really a selection. The user's intent
    // is "run the test", not "run only this one step that happens to have
    // a breakpoint." Run-from-cursor for a single step is what
    // testbench-native.runStepHere is for (gutter right-click); runSelected with
    // a cursor should expand to runAll semantics.
    const uri = vscode.window.activeTextEditor.document.uri;
    // Breakpoint on step 3 (line 10).
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(9, 0)),
        true,
      ),
    ]);
    // Park the cursor on the breakpoint line (no range selection) — what
    // VS Code restores after a reload mid-pause.
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(9, 0),
      new vscode.Position(9, 0),
    );

    void vscode.commands.executeCommand('testbench-native.runSelected');

    // The fix: a stream actually opens for the preceding steps (lines 8
    // and 9). Without it, the empty-trim branch fires and no stream ever
    // exists.
    await waitFor('stream opens for preceding steps', () => fake.hasActiveStream);

    fake.push({ type: 'step:start', line: 8 });
    await waitFor('step 1 actually runs', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[8] === 'running';
    });
    fake.push({ type: 'step:pass', line: 8 });
    fake.push({ type: 'step:start', line: 9 });
    fake.push({ type: 'step:pass', line: 9 });
    fake.end();

    // Only after steps 1 and 2 actually executed should the breakpoint
    // pause indicator appear on step 3.
    await waitFor('arrow lands on step 3 after preceding steps complete', () => {
      return hooks.tracker.snapshot().breakpointStop === 10;
    });
    await waitFor('idle after run pauses on step 3', () => !hooks.isRunning());

    const finalStatuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    assert.equal(finalStatuses[8], 'pass', 'step 1 must show as passed');
    assert.equal(finalStatuses[9], 'pass', 'step 2 must show as passed');
  });

  it('First run after activation closes any stale server session before opening the stream', async () => {
    // Bug: after a VS Code reload mid-pause, the server still holds the
    // previous session keyed on this file's path. The new run sends only
    // the steps before the breakpoint (e.g. [step1, step2]) — the server,
    // confused by its leftover paused-at-step-3 state, short-circuits with
    // an instant `done` event and no step:start events. The runner reads
    // status=passed and posts the breakpointStop on the breakpoint line.
    // From the user's perspective: yellow ▶ jumps to step 3, no preceding
    // pass ticks ever appeared, and the test "didn't run anything."
    //
    // The fix: every controller's first runLines call closes the session
    // before doing anything else. Each VS Code reload creates fresh
    // controllers (registry is reset on activate), so this gives the
    // server a clean slate exactly when needed. Subsequent runs reuse the
    // session — closing every time would defeat the perf win of session
    // reuse and would cost a real browser relaunch on each run.
    assert.equal(fake.closeSessionCalls, 0, 'precondition: nothing closed yet');

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('first stream active', () => fake.hasActiveStream);

    assert.equal(
      fake.closeSessionCalls,
      1,
      'closeSession must be called exactly once before the first stream opens',
    );

    fake.end();
    await waitFor('idle after first run', () => !hooks.isRunning());

    // Subsequent runs in the same activation must NOT close — session
    // reuse is intentional once the controller has confirmed a clean
    // start.
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('second stream active', () => fake.hasActiveStream);
    assert.equal(
      fake.closeSessionCalls,
      1,
      'closeSession must NOT fire for runs after the first one',
    );

    fake.end();
    await waitFor('idle after second run', () => !hooks.isRunning());
  });

  it('First-run close failure must not block the run', async () => {
    // Defensive: if the server is down or the .env is missing or the
    // session never existed (404), closeSession can throw — but the
    // user's intent is to RUN, so a cleanup failure must not propagate.
    // The try/catch around closeSession swallows; the run that follows
    // surfaces the real error itself if the underlying problem persists.
    fake.closeSessionImpl = async () => {
      throw new Error('simulated closeSession failure');
    };

    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream still opens despite close failure', () => fake.hasActiveStream);

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('Run with cursor parked on a breakpoint line (webview path): same fix applies to the webview Run button', async () => {
    // The fix lives in selectionLines (active-file-tracker.ts), so the
    // tracker's snapshot.selectedLines also reports [] for cursor-only.
    // The webview's handleRun posts `{ type: 'run', lines: selectedLines }`
    // — with [] the extension's case 'run' handler runs all, same as the
    // command path. Without this rule the webview Run button would still
    // hit the empty-trim branch even after the runSelected fix.
    const uri = vscode.window.activeTextEditor.document.uri;
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(9, 0)), // line 10
        true,
      ),
    ]);
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(9, 0),
      new vscode.Position(9, 0),
    );
    // Wait for the tracker to flush the new selection through onChange so
    // snapshot.selectedLines is up to date.
    await waitFor('snapshot reflects cursor-only selection as []', () => {
      return hooks.tracker.snapshot().selectedLines.length === 0;
    });

    // Simulate exactly what the webview does in handleRun: read
    // selectedLines from the snapshot and post a `run` message.
    const lines = hooks.tracker.snapshot().selectedLines;
    void hooks.dispatchWebviewMessage({ type: 'run', lines });

    await waitFor('stream opens for preceding steps via webview Run', () => fake.hasActiveStream);

    fake.push({ type: 'step:start', line: 8 });
    fake.push({ type: 'step:pass', line: 8 });
    fake.push({ type: 'step:start', line: 9 });
    fake.push({ type: 'step:pass', line: 9 });
    fake.end();

    await waitFor('arrow lands on step 3 after preceding steps complete', () => {
      return hooks.tracker.snapshot().breakpointStop === 10;
    });
    await waitFor('idle after webview Run pauses on step 3', () => !hooks.isRunning());

    const finalStatuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    assert.equal(finalStatuses[8], 'pass', 'step 1 must show as passed');
    assert.equal(finalStatuses[9], 'pass', 'step 2 must show as passed');
  });

  it('Stop is a hard reset (not a hidden pause): next Run re-executes every step from the beginning, hits the surviving breakpoint freshly', async () => {
    // User scenario: set a breakpoint on step 3, run the test, hit the
    // breakpoint, hit Stop, then run again.
    //
    // The contract being verified is that Stop is a HARD RESET of run state,
    // not a paused-state masquerading as Stop. After Stop the next Run is a
    // genuine from-scratch execution: every step re-runs, no continuation,
    // no resumption from where the previous run paused. The yellow ▶ that
    // ends up on step 3 at the end is a *fresh* breakpoint hit, not a
    // leftover from before.
    //
    // Promises being verified:
    //   1. After Stop, the yellow arrow disappears (breakpointStop === null).
    //   2. The breakpoint itself survives Stop — Stop resets RUN state, not
    //      DEBUG state.
    //   3. The new run starts with no stale arrow.
    //   4. The new run does NOT light up the arrow on step 3 prematurely —
    //      it must wait for steps 1 and 2 to actually finish (proving they
    //      genuinely re-executed, not skipped on the assumption "we already
    //      passed those last time").
    //   5. Once steps 1 and 2 pass freshly, the breakpoint trips again and
    //      the arrow lands on step 3.
    const uri = vscode.window.activeTextEditor.document.uri;
    // Breakpoint on step 3 (line 10 in the fixture).
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(9, 0)),
        true,
      ),
    ]);

    // ---------- First run: hit the breakpoint ----------
    // testbench-native.runAll runs every step in the document — equivalent to the
    // user clicking "Run All" with no selection narrowing.
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('first stream active', () => fake.hasActiveStream);

    // Steps 1 and 2 (lines 8, 9) execute, then the run pauses before step 3.
    fake.push({ type: 'step:start', line: 8 });
    fake.push({ type: 'step:pass', line: 8 });
    fake.push({ type: 'step:start', line: 9 });
    fake.push({ type: 'step:pass', line: 9 });
    fake.end();

    await waitFor('first run pauses on step 3 (line 10)', () => {
      return hooks.tracker.snapshot().breakpointStop === 10;
    });
    await waitFor('idle after first run hits breakpoint', () => !hooks.isRunning());

    // ---------- Stop ----------
    await vscode.commands.executeCommand('testbench-native.stop');
    await waitFor('arrow cleared after stop', () => {
      return hooks.tracker.snapshot().breakpointStop === null;
    });
    // Breakpoint must survive Stop — only pause indicator is cleared.
    assert.ok(
      vscode.debug.breakpoints.some(
        (bp) =>
          bp instanceof vscode.SourceBreakpoint &&
          bp.location.uri.toString() === uri.toString() &&
          bp.location.range.start.line === 9,
      ),
      'Stop must NOT remove the user\'s breakpoint',
    );

    // ---------- Second run from the beginning ----------
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('second stream active', () => fake.hasActiveStream);

    // While the run is in flight before steps 1 and 2 complete, the arrow
    // must NOT have jumped straight back to step 3. The clear-stale post at
    // the top of runLines guarantees no leftover from the first run, and
    // breakpointStop for the new pause is only published after status===passed.
    assert.equal(
      hooks.tracker.snapshot().breakpointStop,
      null,
      'Arrow must not appear on the breakpoint line before preceding steps run',
    );

    fake.push({ type: 'step:start', line: 8 });
    await waitFor('running on line 8 in second run', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[8] === 'running';
    });
    assert.equal(
      hooks.tracker.snapshot().breakpointStop,
      null,
      'Arrow still must not appear while step 1 is executing',
    );

    fake.push({ type: 'step:pass', line: 8 });
    fake.push({ type: 'step:start', line: 9 });
    fake.push({ type: 'step:pass', line: 9 });
    fake.end();

    // Pushing step:start + step:pass for lines 8 and 9 in this run is the
    // load-bearing assertion that the run started fresh — those events only
    // arrive if step 1 and step 2 actually re-executed. If Stop secretly
    // preserved progress and the next Run had behaved like Resume, the
    // server would have skipped them and we'd have timed out.
    //
    // Now the breakpoint trips again on step 3 — fresh hit, same line as
    // the first run because the breakpoint is unchanged.
    await waitFor('arrow lands on step 3 after fresh run hits the breakpoint', () => {
      return hooks.tracker.snapshot().breakpointStop === 10;
    });
    await waitFor('idle after second run hits the breakpoint', () => !hooks.isRunning());
  });

  it('paused-on-error: step:fail parks a breakpointStop so the user can edit and Continue to retry the failed step', async () => {
    // Prototype for fix-and-resume on failure. Without this, a step:fail
    // ends the run via done(failed); the user has no recourse but to fix
    // the markdown and click Run from scratch (paying for browser nav
    // and any preceding steps again).
    //
    // With it: step:fail still propagates fail icon + done(failed), but
    // we ALSO park breakpointStop on the failed line. The existing Continue
    // command re-opens the stream from that line against the still-alive
    // server session, so an edited step text gets retried in-place.
    //
    // The session/browser survives a step:fail on the server side
    // (overallStatus = 'failed' just breaks the step loop; the browser
    // stays open), which is what makes this safe.
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'step:start', line: 9 });
    await waitFor('line 9 running', () => {
      return Object.fromEntries(hooks.tracker.snapshot().statuses)[9] === 'running';
    });

    // Failure on line 9.
    fake.push({
      type: 'step:fail',
      line: 9,
      error: 'page.goto: net::ERR_NAME_NOT_RESOLVED',
    });
    fake.end();
    await waitFor('idle after failure', () => !hooks.isRunning());

    // The failure icon is in place (existing behaviour) AND the
    // breakpointStop is parked on the failed line so Continue is enabled.
    const snap = hooks.tracker.snapshot();
    const statuses = Object.fromEntries(snap.statuses);
    assert.equal(statuses[9], 'fail', 'precondition: failed step shows fail icon');
    assert.equal(
      snap.breakpointStop,
      9,
      'paused-on-error: breakpointStop parks on the failed line so Continue is enabled',
    );

    // Continue re-opens the stream from the failed line — same path as
    // breakpoint-paused continueRun. Track the new request's sourceLines
    // to prove it carries the failed step (and only steps from there onward).
    const requestsBefore = fake.requests.length;
    void vscode.commands.executeCommand('testbench-native.continueRun');
    await waitFor('retry stream opens', () => fake.hasActiveStream);

    const retryRequest = fake.requests[requestsBefore];
    assert.ok(retryRequest, 'Continue from paused-on-error must trigger a new streamSteps call');
    assert.ok(
      retryRequest.sourceLines.includes(9),
      `Retry must include the failed step's line in sourceLines. Got ${JSON.stringify(retryRequest.sourceLines)}.`,
    );

    fake.end();
    await waitFor('idle after retry', () => !hooks.isRunning());
  });

  it('resume from breakpoint preserves pass marks from the first batch', async () => {
    // Regression: continueRun called runLines() which unconditionally called
    // clearStatusesForUris() — the same wipe a fresh re-run performs. After
    // pausing at a breakpoint and hitting Continue, every step that had passed
    // in the first batch was blanked out, making it look like those steps
    // never ran.
    //
    // The contract: statuses from the first batch (steps that ran before the
    // breakpoint) must survive the Continue and remain visible while the
    // second batch executes. Only a deliberate Stop → Run is a hard reset.
    const uri = vscode.window.activeTextEditor.document.uri;
    // Breakpoint on step 3 (line 10). Steps 1 (line 8) and 2 (line 9) run
    // in the first batch; step 3 runs after the user hits Continue.
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(9, 0)), // line 10
        true,
      ),
    ]);

    // ---------- First batch: steps 1 and 2 pass, breakpoint pauses before 3 ----------
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('first stream active', () => fake.hasActiveStream);

    fake.push({ type: 'step:start', line: 8 });
    fake.push({ type: 'step:pass', line: 8 });
    fake.push({ type: 'step:start', line: 9 });
    fake.push({ type: 'step:pass', line: 9 });
    fake.end();

    await waitFor('paused at line 10 after first batch', () => {
      return hooks.tracker.snapshot().breakpointStop === 10;
    });
    await waitFor('idle while paused', () => !hooks.isRunning());

    const afterFirstBatch = Object.fromEntries(hooks.tracker.snapshot().statuses);
    assert.equal(afterFirstBatch[8], 'pass', 'precondition: step 1 passed in first batch');
    assert.equal(afterFirstBatch[9], 'pass', 'precondition: step 2 passed in first batch');

    // ---------- Continue: second batch runs step 3 ----------
    void vscode.commands.executeCommand('testbench-native.continueRun');
    await waitFor('second stream active after Continue', () => fake.hasActiveStream);

    // First-batch pass marks must NOT be wiped at the moment the stream opens.
    const duringResume = Object.fromEntries(hooks.tracker.snapshot().statuses);
    assert.equal(
      duringResume[8],
      'pass',
      'step 1 pass must survive the Continue — not blanked by clearStatusesForUris',
    );
    assert.equal(
      duringResume[9],
      'pass',
      'step 2 pass must survive the Continue — not blanked by clearStatusesForUris',
    );

    fake.push({ type: 'step:start', line: 10 });
    fake.push({ type: 'step:pass', line: 10 });
    fake.end();

    await waitFor('idle after second batch', () => !hooks.isRunning());

    const afterResume = Object.fromEntries(hooks.tracker.snapshot().statuses);
    assert.equal(afterResume[8], 'pass', 'step 1 still pass after resume completes');
    assert.equal(afterResume[9], 'pass', 'step 2 still pass after resume completes');
    assert.equal(afterResume[10], 'pass', 'step 3 (the resumed step) also passed');
  });

  // ---------------------------------------------------------------------------
  // Resume position-anchor (spec stories/specs/resume-position-anchor.md §6).
  //
  // These cases EDIT the test document between pause and Continue. Before the
  // anchor change `breakpointStop` was a raw line and went stale on edit; now
  // it's derived from a position that shifts with the text. Edits are made
  // in-memory via editor.edit (no save) and reverted at the end of each case so
  // the shared fixture's on-disk content is never mutated.
  // ---------------------------------------------------------------------------

  /** Insert `text` (which should end in \n) at the start of 1-based `line`. */
  async function insertLine(editor, line, text) {
    const ok = await editor.edit((b) => {
      b.insert(new vscode.Position(line - 1, 0), text);
    });
    assert.ok(ok, 'editor.edit (insert) should apply');
  }

  /** Delete the whole of 1-based `line` (including its trailing newline). */
  async function deleteLine(editor, line) {
    const ok = await editor.edit((b) => {
      b.delete(
        new vscode.Range(new vscode.Position(line - 1, 0), new vscode.Position(line, 0)),
      );
    });
    assert.ok(ok, 'editor.edit (delete) should apply');
  }

  /** Replace whole 1-based lines `from`..`to` (inclusive) with `text`. Mirrors
   *  selecting those lines in the gutter and pasting: the range ends at column
   *  0 of the line after `to`, exactly as VS Code reports a whole-line
   *  selection. `text` should end in \n to keep the line structure intact. */
  async function replaceLines(editor, from, to, text) {
    const ok = await editor.edit((b) => {
      b.replace(
        new vscode.Range(new vscode.Position(from - 1, 0), new vscode.Position(to, 0)),
        text,
      );
    });
    assert.ok(ok, 'editor.edit (replace) should apply');
  }

  /** Revert any unsaved edits so the next case starts from the on-disk fixture
   *  text — closeAllEditors alone can leave a dirty buffer / save prompt. */
  async function revertActiveEditor() {
    try {
      await vscode.commands.executeCommand('workbench.action.revertActiveEditor');
    } catch {
      // best-effort — the beforeEach closeAllEditors is the backstop
    }
  }

  it('resume after inserting a step ABOVE the pause line resumes the original step (no ghost step runs)', async () => {
    // Steps are on lines 8, 9, 10. Breakpoint on step 3 (line 10): steps 1
    // and 2 run, the run pauses at line 10. The user then inserts a NEW step
    // above the pause line; old step 3 slides down to line 11. With a raw
    // line number, Continue's `line >= 10` filter would pick up the inserted
    // line 10 (a ghost step) AND the shifted-down original. The anchor shifts
    // to 11, so Continue resumes ONLY the original step at its new line.
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

    // Insert a new step on line 9 (above the pause line). Old steps 9 and 10
    // shift down by one → original step 3 is now line 11.
    const editor = vscode.window.activeTextEditor;
    await insertLine(editor, 9, '2.5. Inserted ghost step\n');

    // Derived breakpointStop must track the shift to line 11.
    await waitFor('anchor shifted to line 11 after insert above', () => {
      return hooks.tracker.snapshot().breakpointStop === 11;
    });

    const requestsBefore = fake.requests.length;
    void vscode.commands.executeCommand('testbench-native.continueRun');
    await waitFor('resume stream opens', () => fake.hasActiveStream);

    const resumeRequest = fake.requests[requestsBefore];
    assert.ok(resumeRequest, 'Continue should have opened a new stream');
    assert.deepEqual(
      resumeRequest.sourceLines,
      [11],
      `Resume must carry only the original step (now line 11), not the inserted ghost. Got ${JSON.stringify(resumeRequest.sourceLines)}.`,
    );

    fake.end();
    await waitFor('idle after resume', () => !hooks.isRunning());
    await revertActiveEditor();
  });

  it('resume after DELETING the pause-line step snaps forward to the next surviving step', async () => {
    // Breakpoint on step 2 (line 9): step 1 runs, pause at line 9. The user
    // then deletes the pause-line step. Old step 3 (line 10) slides up into
    // line 9. With a raw line number, Continue's `line >= 9` filter would run
    // the slid-up step as if it were the paused one. The anchor snaps to the
    // next surviving step at/after the deleted position — which after the
    // delete is line 9 (the slid-up original step 3).
    const uri = vscode.window.activeTextEditor.document.uri;
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(8, 0)), // line 9
        true,
      ),
    ]);

    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('first stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 8 });
    fake.push({ type: 'step:pass', line: 8 });
    fake.end();
    await waitFor('paused at line 9', () => hooks.tracker.snapshot().breakpointStop === 9);
    await waitFor('idle while paused', () => !hooks.isRunning());

    // Delete the pause-line step (line 9). Old step 3 (line 10) moves to 9.
    const editor = vscode.window.activeTextEditor;
    await deleteLine(editor, 9);

    // The anchor snaps forward to the next surviving step at/after the
    // deleted position — line 9, now holding the original step 3.
    await waitFor('anchor snaps to next surviving step (line 9)', () => {
      return hooks.tracker.snapshot().breakpointStop === 9;
    });

    const requestsBefore = fake.requests.length;
    void vscode.commands.executeCommand('testbench-native.continueRun');
    await waitFor('resume stream opens', () => fake.hasActiveStream);
    const resumeRequest = fake.requests[requestsBefore];
    assert.ok(resumeRequest, 'Continue should have opened a new stream');
    assert.deepEqual(
      resumeRequest.sourceLines,
      [9],
      `Resume must snap to the surviving step at line 9. Got ${JSON.stringify(resumeRequest.sourceLines)}.`,
    );

    fake.end();
    await waitFor('idle after resume', () => !hooks.isRunning());
    await revertActiveEditor();
  });

  it('paused-on-error: inserting a step above the failed line resumes the original failed step (no ghost step)', async () => {
    // step:fail on line 9 parks breakpointStop on line 9. The user inserts a
    // new step above it (intending to fix something) and hits Continue. The
    // anchor shifts to line 10 so the retry targets the ORIGINAL failed step
    // at its new line, never the inserted one.
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    await waitFor('line 9 running', () => {
      return Object.fromEntries(hooks.tracker.snapshot().statuses)[9] === 'running';
    });
    fake.push({ type: 'step:fail', line: 9, error: 'boom' });
    fake.end();
    await waitFor('paused-on-error at line 9', () => hooks.tracker.snapshot().breakpointStop === 9);
    await waitFor('idle after failure', () => !hooks.isRunning());

    // Insert a step on line 8 (above the failed line 9). Failed step → line 10.
    const editor = vscode.window.activeTextEditor;
    await insertLine(editor, 8, '0.5. Inserted before the failed step\n');
    await waitFor('anchor shifted to line 10 after insert above', () => {
      return hooks.tracker.snapshot().breakpointStop === 10;
    });

    const requestsBefore = fake.requests.length;
    void vscode.commands.executeCommand('testbench-native.continueRun');
    await waitFor('retry stream opens', () => fake.hasActiveStream);
    const retryRequest = fake.requests[requestsBefore];
    assert.ok(retryRequest, 'Continue from paused-on-error must open a new stream');
    assert.ok(
      retryRequest.sourceLines.includes(10),
      `Retry must target the shifted failed step (line 10). Got ${JSON.stringify(retryRequest.sourceLines)}.`,
    );
    assert.ok(
      !retryRequest.sourceLines.includes(8),
      `Retry must NOT execute the inserted ghost step (line 8). Got ${JSON.stringify(retryRequest.sourceLines)}.`,
    );

    fake.end();
    await waitFor('idle after retry', () => !hooks.isRunning());
    await revertActiveEditor();
  });

  it('resume after selecting whole lines ABOVE the pause and pasting one line shifts to the original step (no snap)', async () => {
    // The "select multiple lines, paste one line" case. Breakpoint on step 3
    // (line 10): steps 1 and 2 run, pause at line 10. The user selects whole
    // lines 8–9 (steps 1 and 2) and pastes a single merged step. VS Code
    // reports that as a replace whose range ends at column 0 of line 10 — so it
    // does NOT touch the paused step's content; the anchor must shift UP to the
    // step's new line (9), not snap forward. Net lines removed: 2 → 1.
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

    // Select whole lines 8–9 and replace with ONE step line. Old step 3 (line
    // 10) slides up to line 9; its content is untouched by the edit.
    const editor = vscode.window.activeTextEditor;
    await replaceLines(editor, 8, 9, '1. Merged setup step\n');

    await waitFor('anchor shifts up to line 9 (not a snap)', () => {
      return hooks.tracker.snapshot().breakpointStop === 9;
    });

    const requestsBefore = fake.requests.length;
    void vscode.commands.executeCommand('testbench-native.continueRun');
    await waitFor('resume stream opens', () => fake.hasActiveStream);
    const resumeRequest = fake.requests[requestsBefore];
    assert.ok(resumeRequest, 'Continue should have opened a new stream');
    assert.deepEqual(
      resumeRequest.sourceLines,
      [9],
      `Resume must carry only the original step at its new line 9, not re-run the merged step. Got ${JSON.stringify(resumeRequest.sourceLines)}.`,
    );

    fake.end();
    await waitFor('idle after resume', () => !hooks.isRunning());
    await revertActiveEditor();
  });

  // ---------------------------------------------------------------------------
  // Run marks follow the text (mark-lines-core.ts). The ✓ / ✗ and the failure
  // text behind them are keyed by line, and the editor repaints from those
  // keys on every keystroke — before this, an insert above step 2 left step
  // 2's ✓ on the inserted line and step 3's ✗ on step 2.
  // ---------------------------------------------------------------------------

  /** The active file's marks as plain objects, for deepEqual. */
  const marks = () => {
    const snap = hooks.tracker.snapshot();
    return {
      statuses: Object.fromEntries(snap.statuses),
      failures: Object.fromEntries(snap.failures.map(([line, f]) => [line, f.error])),
    };
  };

  /** Wait for the marks to settle on `expected`; on timeout, fail with the
   *  marks as they actually are rather than just the label. */
  async function expectMarks(label, expected) {
    try {
      await waitFor(label, () => JSON.stringify(marks()) === JSON.stringify(expected));
    } catch {
      assert.deepEqual(marks(), expected, `${label} — got ${JSON.stringify(marks())}`);
    }
  }

  /** Pass steps 1 and 2 (lines 8, 9), fail step 3 (line 10) with "boom". */
  async function runPassPassFail() {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 8 });
    fake.push({ type: 'step:pass', line: 8 });
    fake.push({ type: 'step:start', line: 9 });
    fake.push({ type: 'step:pass', line: 9 });
    fake.push({ type: 'step:start', line: 10 });
    fake.push({ type: 'step:fail', line: 10, error: 'boom' });
    fake.end();
    await waitFor('idle after the run', () => !hooks.isRunning());
    assert.deepEqual(marks(), {
      statuses: { 8: 'pass', 9: 'pass', 10: 'fail' },
      failures: { 10: 'boom' },
    });
  }

  it('marks move down with a line inserted above them, and the failure text goes with its ✗', async () => {
    await runPassPassFail();
    try {
      await insertLine(vscode.window.activeTextEditor, 9, '1.5. Inserted step\n');
      await expectMarks('marks below the insert moved down one', {
        statuses: { 8: 'pass', 10: 'pass', 11: 'fail' },
        failures: { 11: 'boom' },
      });
    } finally {
      await revertActiveEditor();
    }
  });

  it('deleting a marked step removes its mark and moves the ones below up, without handing it on', async () => {
    await runPassPassFail();
    try {
      // Step 2 (line 9) deleted whole. Step 3 slides up into line 9 and keeps
      // its OWN ✗ — the resume arrow snaps forward on this edit, a result
      // must not, or step 3 would read as passed.
      await deleteLine(vscode.window.activeTextEditor, 9);
      await expectMarks('step 2 mark gone, step 3 moved up', {
        statuses: { 8: 'pass', 9: 'fail' },
        failures: { 9: 'boom' },
      });
    } finally {
      await revertActiveEditor();
    }
  });

  it('editing a step in place keeps every mark where it is', async () => {
    await runPassPassFail();
    try {
      const editor = vscode.window.activeTextEditor;
      // Retype step 3's ordinal from column 0 (what Renumber Steps does), and
      // add a word in the middle of step 2.
      assert.ok(
        await editor.edit((b) => {
          b.replace(new vscode.Range(9, 0, 9, 1), '4');
          b.insert(new vscode.Position(8, 9), 'big ');
        }),
      );
      await sleep(100);
      assert.deepEqual(marks(), {
        statuses: { 8: 'pass', 9: 'pass', 10: 'fail' },
        failures: { 10: 'boom' },
      });
    } finally {
      await revertActiveEditor();
    }
  });

  it('the run state saved after an edit carries the moved lines, not the old ones', async () => {
    // persist() stamps the signature from the live text, so it vouches for
    // whatever line numbers it is handed. Unmoved, the saved state said step
    // 3's ✗ was on line 10 — the inserted line — and a reopen restored it
    // there.
    const runState = path.join(FIXTURES_DIR, '.testbench', 'run-state.json');
    const saved = () => {
      try {
        return JSON.parse(require('node:fs').readFileSync(runState, 'utf8')).files['test-with-steps.md'];
      } catch {
        return undefined;
      }
    };
    await runPassPassFail();
    try {
      await insertLine(vscode.window.activeTextEditor, 8, '0. Inserted first\n');
      const savedStatuses = () => [...(saved()?.statuses ?? [])].sort((a, b) => a[0] - b[0]);
      const expected = [[9, 'pass'], [10, 'pass'], [11, 'fail']];
      try {
        await waitFor(
          'saved statuses on the moved lines',
          () => JSON.stringify(savedStatuses()) === JSON.stringify(expected),
        );
      } catch {
        assert.deepEqual(savedStatuses(), expected, `saved statuses on the moved lines — got ${JSON.stringify(savedStatuses())}`);
      }
      assert.equal(
        saved().signature,
        hooks.tracker.stepSignatureForTests(vscode.window.activeTextEditor.document.getText()),
        'stamped against the edited text',
      );
    } finally {
      await revertActiveEditor();
    }
  });
});

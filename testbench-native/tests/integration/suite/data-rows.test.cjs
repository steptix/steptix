/**
 * The editor's data-row loop (stories/data-driven-rows.md, part A).
 *
 * A table under `## Steps` makes Run execute the steps once per row, each in a
 * fresh browser, with the whole run producing one report. Everything here is
 * asserted on what reached the client — the requests, the closes, the finalise
 * — rather than on the log, because the log would read the same if the loop
 * sent one batch five times against the same session.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const vscode = require('vscode');
const { FakeApiClient } = require('../fakes/fake-api-client.cjs');

/** The server's own `sections` entry validator, loaded from the repo's built
 *  `dist/` in the selection suite's `before`. See `assertSectionsValid`. */
let validateSectionEntry;

const EXT_ID = 'pkent.testbench-native';
const FIXTURES_DIR =
  process.env.TESTBENCH_FIXTURES_DIR || path.resolve(__dirname, '..', 'fixtures');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await predicate()) return; } catch { /* retry */ }
    await sleep(50);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

// line 1: '# Rows'            line 6: '| a@b.c | pw1 |'
// line 3: '## Steps'          line 7: '| d@e.f | pw2 |'
// line 4: '| email | password |'   line 9: '1. Enter {{email}}'
// line 5: '|---|---|'             line 10: '2. Enter {{password}}'
const ROWS_FIXTURE = [
  '# Rows',
  '',
  '## Config',
  '- baseUrl: http://localhost:8787/',
  '',
  '## Steps',
  '| email | password |',
  '|-------|----------|',
  '| a@b.c | pw1 |',
  '| d@e.f | pw2 |',
  '',
  '1. Enter {{email}}',
  '2. Enter {{password}}',
  '',
].join('\n');

const PLAIN_FIXTURE = ['# Plain', '', '## Steps', '1. Do a thing', ''].join('\n');

const BAD_TABLE_FIXTURE = [
  '# Bad rows',
  '',
  '## Steps',
  '| email | password |',
  '|-------|----------|',
  '| only-one-cell |',
  '',
  '1. Enter {{email}}',
  '',
].join('\n');

// Two rows, and step 2 asks the author for a value. Cancelling that prompt
// used to end only THAT row's steps: the row went ✓, the loop moved on and
// asked again — one prompt per row to say "not this run".
// Line 7: header, 9/10: the rows, 12: step 1, 13: the `[input:]` step.
const INPUT_FIXTURE = [
  '# Rows with a prompt',
  '',
  '## Config',
  '- baseUrl: http://localhost:8787/',
  '',
  '## Steps',
  '| email | password |',
  '|-------|----------|',
  '| a@b.c | pw1 |',
  '| d@e.f | pw2 |',
  '',
  '1. Enter {{email}}',
  '2. [input: code] Enter the code you were sent',
  '',
].join('\n');

const FIXTURES = {
  'data-rows.tmp.md': ROWS_FIXTURE,
  'data-rows-plain.tmp.md': PLAIN_FIXTURE,
  'data-rows-bad.tmp.md': BAD_TABLE_FIXTURE,
  'data-rows-input.tmp.md': INPUT_FIXTURE,
};

const fixtureUri = (name) => vscode.Uri.file(path.resolve(FIXTURES_DIR, name));

describe('TestBench data-row loop', function () {
  this.timeout(40_000);

  /** @type {FakeApiClient} */
  let fake;
  let hooks;

  before(async () => {
    for (const [name, content] of Object.entries(FIXTURES)) {
      fs.writeFileSync(path.resolve(FIXTURES_DIR, name), content);
    }
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks not exposed');
    await hooks.discoveryReady();
    await hooks.discoveryRefresh();
  });

  after(() => {
    for (const name of Object.keys(FIXTURES)) {
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

  /** Open a fixture and wait for the extension to recognise it. */
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

  /** Run every row to completion by ending each stream as it opens. */
  async function runAllRows(expectedRequests) {
    fake.streamScripts = Array.from({ length: expectedRequests }, () => (f) => f.end());
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor(
      `${expectedRequests} request(s)`,
      () => fake.requests.length >= expectedRequests,
    );
    await waitFor('run finished', () => hooks.isRunning() === false);
  }

  it('sends one batch per row, each carrying its own row number and values', async () => {
    await open('data-rows.tmp.md');
    await runAllRows(2);

    assert.equal(fake.requests.length, 2, 'expected one batch per row');
    assert.deepEqual(
      fake.requests.map((r) => [r.dataRow, r.dataRowCount]),
      [[1, 2], [2, 2]],
    );
    assert.deepEqual(fake.requests[0].dataRowValues, { email: 'a@b.c', password: 'pw1' });
    assert.deepEqual(fake.requests[1].dataRowValues, { email: 'd@e.f', password: 'pw2' });
    // The row is merged into `parameters` too, which is what the steps read.
    assert.equal(fake.requests[1].parameters.email, 'd@e.f');
  });

  it('closes the session before every row so each starts in a fresh browser', async () => {
    // The whole reason a run row is its own browser: row 1 may have signed in.
    //
    // Counted against the PLAIN fixture rather than asserted as an absolute,
    // because an interactive run already closes any stale session once before
    // it starts. The closes this feature adds are the difference — and there
    // is now ONE PER ROW, not one between rows: the first row of a row run
    // reused whatever session was already open, so it started on the page the
    // previous run left with that browser's localStorage.
    await open('data-rows-plain.tmp.md');
    await runAllRows(1);
    const baseline = fake.closeSessionIds.length;

    fake = new FakeApiClient();
    hooks.setApiClientFactory(() => fake);
    await open('data-rows.tmp.md');
    await runAllRows(2);

    assert.equal(
      fake.closeSessionIds.length,
      baseline + 2,
      `two rows must add one close each over an unlooped run (baseline ${baseline}, got ${fake.closeSessionIds.length})`,
    );
  });

  it('re-sends config on every row', async () => {
    // `includeConfig` is `!configSentForSession`, reset only in the run's
    // finally. Without `forgetSentConfig` at the row boundary, row 2's session
    // would launch with no baseUrl and its first step would fail.
    await open('data-rows.tmp.md');
    await runAllRows(2);
    assert.ok(fake.requests[0].config, 'row 1 must carry config');
    assert.ok(fake.requests[1].config, 'row 2 must carry config too');
  });

  it('keeps one session id across the rows', async () => {
    // There is deliberately no `::row-n` id: Continue after a pause, the
    // keep-alive and every out-of-band session op post to the stable id.
    await open('data-rows.tmp.md');
    await runAllRows(2);
    assert.equal(fake.streamSessionIds[0], fake.streamSessionIds[1]);
  });

  it('never lets a row batch enable the step cache', async () => {
    await open('data-rows.tmp.md');
    await runAllRows(2);
    for (const [index, request] of fake.requests.entries()) {
      assert.ok(!request.cacheEnabled, `row ${index + 1} must not enable the cache`);
    }
  });

  it('finalises the run once, and that is where the report path comes from', async () => {
    await open('data-rows.tmp.md');
    await runAllRows(2);

    assert.equal(fake.finalizeRowReportCalls.length, 1, 'expected exactly one finalise');
    assert.deepEqual(fake.finalizeRowReportCalls[0].notRun, [], 'every row ran');
    // A row batch's `done` carries no reportPath, so the finalise is the only
    // thing that can answer "Open Report".
    assert.ok(
      hooks.lastReportPath === undefined || typeof hooks.lastReportPath === 'function',
      'no assumption about the hook shape',
    );
  });

  it('reports the rows it never reached when the run is stopped', async () => {
    await open('data-rows.tmp.md');
    // Row 1 opens its stream and stays open; Stop aborts it before row 2.
    fake.streamScripts = [() => { /* leave row 1 running */ }];
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('row 1 streaming', () => fake.hasActiveStream);
    await vscode.commands.executeCommand('testbench-native.stop');
    await waitFor('run finished', () => hooks.isRunning() === false);

    assert.equal(fake.requests.length, 1, 'row 2 must not have been sent');
    assert.equal(fake.finalizeRowReportCalls.length, 1, 'a stopped run still gets its report');
    assert.deepEqual(
      fake.finalizeRowReportCalls[0].notRun.map((r) => [r.row, r.reason]),
      [[2, 'stopped']],
      'the row that never ran must still get a line in the matrix',
    );
  });

  it('leaves a test with no table completely alone', async () => {
    // The regression guard: the loop must be invisible to every ordinary test.
    await open('data-rows-plain.tmp.md');
    await runAllRows(1);

    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0].dataRow, undefined);
    assert.equal(fake.requests[0].dataRowCount, undefined);
    assert.equal(fake.finalizeRowReportCalls.length, 0, 'nothing to finalise');
  });

  it('runs once, unlooped, when the table is malformed', async () => {
    // The parse error is a fact about the table; refusing to run the steps
    // because of it would be the worse trade. The author sees the error and
    // the unresolved placeholder in the step text.
    await open('data-rows-bad.tmp.md');
    await runAllRows(1);

    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0].dataRow, undefined);
    assert.equal(fake.finalizeRowReportCalls.length, 0);
  });
});

/**
 * The table as the control surface (stories/data-row-progress-and-selection.md).
 *
 * The rows of the table carry their own status marks, in the same cell the
 * steps use, and the header line carries a summary of them. Asserted through
 * the tracker and the `rowTablesForTests` hook — which calls the REAL scan and
 * the REAL summary function the decoration pass uses, because a rendered
 * decoration's text cannot be read back from the extension host.
 */
describe('TestBench data-row painting', function () {
  this.timeout(40_000);

  /** @type {FakeApiClient} */
  let fake;
  let hooks;

  // Lines of `ROWS_FIXTURE`: 7 is the table header, 9 and 10 the two data
  // rows, 12 and 13 the two steps.
  const HEADER_LINE = 7;
  const ROW_LINES = [9, 10];
  const STEP_LINE = 12;

  before(async () => {
    for (const [name, content] of Object.entries(FIXTURES)) {
      fs.writeFileSync(path.resolve(FIXTURES_DIR, name), content);
    }
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks not exposed');
    await hooks.discoveryReady();
  });

  after(() => {
    for (const name of Object.keys(FIXTURES)) {
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

  /** Run every row to completion by ending each stream as it opens. */
  async function runAllRows(expectedRequests) {
    fake.streamScripts = Array.from({ length: expectedRequests }, () => (f) => f.end());
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor(
      `${expectedRequests} request(s)`,
      () => fake.requests.length >= expectedRequests,
    );
    await waitFor('run finished', () => hooks.isRunning() === false);
  }

  /** The status on each data-row line, in table order. */
  const rowStatuses = (uri) => {
    const snap = hooks.tracker.snapshotFor(uri);
    const byLine = new Map(snap ? snap.statuses : []);
    return ROW_LINES.map((line) => byLine.get(line) ?? null);
  };

  /** The one table's header summary — the after-text on the header line. */
  const summary = (uri) => {
    const tables = hooks.rowTablesForTests(uri);
    return tables.length === 1 ? tables[0].summary : `expected one table, got ${tables.length}`;
  };

  /** The most recent `rows` message the host posted since `mark`, or null. */
  const lastRowsMsg = (mark) => {
    const msgs = hooks.hostMessagesSince(mark).filter((m) => m.type === 'rows');
    return msgs.length > 0 ? msgs[msgs.length - 1] : null;
  };

  it('paints each row in turn and leaves the pass/fail marks with the header summary', async () => {
    const uri = await open('data-rows.tmp.md');
    // Row 1's stream stays open until we have seen it banded; row 2's fails.
    fake.streamScripts = [
      () => { /* leave row 1 running */ },
      (f) => {
        f.push({ type: 'step:start', line: STEP_LINE });
        f.push({ type: 'step:fail', line: STEP_LINE, error: 'no such element' });
        f.end();
      },
    ];
    void vscode.commands.executeCommand('testbench-native.runAll');

    await waitFor('row 1 running', () => rowStatuses(uri)[0] === 'running');
    assert.deepEqual(rowStatuses(uri), ['running', null], 'only the running row is marked');
    assert.equal(summary(uri), '2 rows · row 1 of 2 running');

    fake.endAt(0);
    await waitFor('run finished', () => hooks.isRunning() === false);

    // Row 2's boundary clears the whole file's statuses so its steps repaint
    // from blank. Row 1's pass has to survive that, which is the whole reason
    // the matrix is re-posted rather than painted event by event.
    assert.deepEqual(rowStatuses(uri), ['pass', 'fail']);
    assert.equal(summary(uri), '2 rows · 1 passed · 1 failed');
  });

  it('the failed row names the step it died at, quotes it, and shows its values', async () => {
    const uri = await open('data-rows.tmp.md');
    fake.streamScripts = [
      (f) => { f.end(); },
      (f) => {
        f.push({ type: 'step:fail', line: STEP_LINE, error: 'no such element' });
        f.end();
      },
    ];
    void vscode.commands.executeCommand('testbench-native.runAll');
    // Wait for both batches before the idle check: `isRunning` is false in
    // the moment between the command being dispatched and the run starting,
    // so a bare idle wait returns before anything has happened.
    await waitFor('two requests', () => fake.requests.length >= 2);
    await waitFor('run finished', () => hooks.isRunning() === false);

    const snap = hooks.tracker.snapshotFor(uri);
    const failure = new Map(snap.failures).get(ROW_LINES[1]);
    assert.ok(failure, 'the failed row must carry its reason');
    // The row says which step; the step's own hover (rowSummary) says which rows.
    assert.match(failure.error, /^Row 2 failed at step 1 — "Enter \{\{email\}\}"/);
    assert.match(failure.error, /no such element/);
    // …and the row's values, masked the way the Output banner masks them.
    assert.match(failure.error, /email=d@e\.f, password=\*{3}/);
    // A passed row carries no hover, exactly as a passed step carries none.
    assert.equal(new Map(snap.failures).get(ROW_LINES[0]), undefined);
  });

  it('Stop marks the row it interrupted and skips the rest, with the reason', async () => {
    const uri = await open('data-rows.tmp.md');
    fake.streamScripts = [() => { /* leave row 1 running */ }];
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('row 1 running', () => rowStatuses(uri)[0] === 'running');
    await vscode.commands.executeCommand('testbench-native.stop');
    await waitFor('run finished', () => hooks.isRunning() === false);

    assert.deepEqual(rowStatuses(uri), ['stopped', 'skip']);
    assert.equal(summary(uri), '2 rows · 1 stopped · 1 not run');
    const snap = hooks.tracker.snapshotFor(uri);
    assert.equal(new Map(snap.failures).get(ROW_LINES[1]).error, 'Row 2 not run (stopped)');
    // The ■ is the one mark with no other explanation anywhere — the row has
    // no failure, no skip reason and no duration worth reading — so it says
    // what happened to it.
    assert.equal(
      new Map(snap.failures).get(ROW_LINES[0]).error,
      'Row 1 stopped — the run was stopped while this row was running',
    );
  });

  it('the Output’s row lines and its summary account for a Stop', async () => {
    // The interrupted row is in neither outcome list: it never finished its
    // steps (so not in `rowOutcomes`) and its batch was sent (so not in
    // `notRun`). It used to get no line at all while the summary counted it,
    // so the parts summed to one less than the count.
    const uri = await open('data-rows.tmp.md');
    const mark = hooks.hostMessageCount();
    fake.streamScripts = [() => { /* leave row 1 running */ }];
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('row 1 running', () => rowStatuses(uri)[0] === 'running');
    await vscode.commands.executeCommand('testbench-native.stop');
    await waitFor('run finished', () => hooks.isRunning() === false);

    const lines = hooks
      .hostMessagesSince(mark)
      .filter((m) => m.type === 'runEvent' && m.event.type === 'output')
      .map((m) => m.event.msg);
    assert.ok(
      lines.some((l) => /^ {2}Row 1: stopped \(\d+\.\ds\)$/.test(l)),
      `the interrupted row needs a line. Got ${JSON.stringify(lines)}`,
    );
    assert.ok(
      lines.includes('  Row 2: not run (stopped)'),
      `expected the never-reached row. Got ${JSON.stringify(lines)}`,
    );
    assert.ok(
      lines.includes('Rows: 2 — 0 passed, 0 failed, 1 stopped, 1 not run'),
      `the parts must sum to the planned count. Got ${JSON.stringify(lines)}`,
    );
  });

  // ── A pause ends the loop, and says so ──────────────────────────────────
  //
  // The bug these pin: `parkedAtPause` is assigned AFTER the row loop (a
  // breakpoint trim) or in the catch (a Pause), so the guard that read it at
  // the TOP of each iteration could never fire. A breakpoint on step 2 handed
  // the loop step 1, and the loop ran that one step for every row, closed the
  // browser between them and painted the whole matrix ✓ — a green
  // `2 rows · 2 passed` with the pause arrow sitting on step 2.

  /** Run with a breakpoint on step 2, and stop when the run parks. */
  async function runToBreakpoint(uri) {
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(STEP_LINE, 0)), // step 2
        true,
      ),
    ]);
    fake.streamScripts = [(f) => f.end()];
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('one request', () => fake.requests.length >= 1);
    await waitFor('parked at the breakpoint', () =>
      hooks.tracker.snapshotFor(uri).breakpointStop === STEP_LINE + 1);
    await waitFor('idle while parked', () => hooks.isRunning() === false);
  }

  it('a breakpoint ends the loop after the row it parked in', async () => {
    const uri = await open('data-rows.tmp.md');
    const mark = hooks.hostMessageCount();
    await runToBreakpoint(uri);

    assert.equal(fake.requests.length, 1, 'exactly one batch: the loop stopped at row 1');
    // Row 1 keeps the band — that is where the run IS, with half its steps
    // run and a Continue away from the rest. It must not be ✓.
    assert.deepEqual(rowStatuses(uri), ['running', 'skip']);
    assert.equal(summary(uri), '2 rows · row 1 of 2 running · 1 not run');
    const failures = new Map(hooks.tracker.snapshotFor(uri).failures);
    assert.equal(
      failures.get(ROW_LINES[1]).error,
      'Row 2 not run (paused) — right-click the line number and pick Run This Row ' +
        'to run it on its own',
    );

    const lines = hooks
      .hostMessagesSince(mark)
      .filter((m) => m.type === 'runEvent' && m.event.type === 'output')
      .map((m) => m.event.msg);
    assert.ok(
      lines.some((l) => /^ {2}Row 1: paused/.test(l)),
      `the parked row needs a line of its own. Got ${JSON.stringify(lines)}`,
    );
    assert.ok(
      lines.includes('  Row 2: not run (paused)'),
      `Got ${JSON.stringify(lines)}`,
    );
    assert.ok(
      lines.includes('Rows: 2 — 0 passed, 0 failed, 1 paused, 1 not run'),
      `the parts must sum to the planned count. Got ${JSON.stringify(lines)}`,
    );
    // The report is still written, and it knows which rows never ran.
    assert.equal(fake.finalizeRowReportCalls.length, 1);
    assert.deepEqual(
      fake.finalizeRowReportCalls[0].notRun.map((r) => [r.row, r.reason]),
      [[2, 'paused']],
    );
  });

  it('Continue settles the row the pause parked in', async () => {
    const uri = await open('data-rows.tmp.md');
    await runToBreakpoint(uri);
    assert.deepEqual(rowStatuses(uri), ['running', 'skip']);

    fake.streamScripts = [undefined, (f) => f.end()];
    void vscode.commands.executeCommand('testbench-native.continueRun');
    await waitFor('a second request', () => fake.requests.length >= 2);
    await waitFor('idle after the continue', () => hooks.isRunning() === false);

    assert.deepEqual(
      rowStatuses(uri),
      ['pass', 'skip'],
      'the Continue is what decides the parked row; row 2 is still not run',
    );
  });

  it('a Stop while parked closes the row out ■, not ✓', async () => {
    const uri = await open('data-rows.tmp.md');
    await runToBreakpoint(uri);

    await vscode.commands.executeCommand('testbench-native.stop');
    await waitFor('row 1 stopped', () => rowStatuses(uri)[0] === 'stopped');
    assert.deepEqual(rowStatuses(uri), ['stopped', 'skip']);
    const failures = new Map(hooks.tracker.snapshotFor(uri).failures);
    assert.equal(
      failures.get(ROW_LINES[0]).error,
      'Row 1 stopped — the run was stopped while this row was running',
    );
  });

  it('a cancelled [input:] prompt ends the loop instead of asking again', async () => {
    // The break left `anyFailed` false, so the row was painted ✓ and the loop
    // moved on — one prompt per row to say "not this run", and a green matrix
    // for steps that never ran.
    const uri = await open('data-rows-input.tmp.md');
    fake.streamScripts = [(f) => f.end(), (f) => f.end()];
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('row 1’s first step is sent', () => fake.requests.length >= 1);

    // An `[input:]` prompt is VS Code's own InputBox, so Escape is what
    // cancels it. Issued on every poll: the box opens once the step batch's
    // stream ends, and closing a quick-open that is not there is a no-op.
    await waitFor('the run ends when the prompt is dismissed', async () => {
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      return hooks.isRunning() === false;
    });

    // Had the loop carried on, row 2 would have sent its own first batch and
    // then asked for the code all over again.
    assert.equal(fake.requests.length, 1, 'row 2 must not be started');
    const rowStatusesHere = () => {
      const byLine = new Map(hooks.tracker.snapshotFor(uri).statuses);
      return [9, 10].map((line) => byLine.get(line) ?? null);
    };
    assert.deepEqual(rowStatusesHere(), ['stopped', 'skip']);
    const failures = new Map(hooks.tracker.snapshotFor(uri).failures);
    assert.equal(
      failures.get(9).error,
      'Row 1 stopped — the prompt was cancelled',
    );
    // To the rows it never reached this IS a Stop — the author said "not this
    // run" — so they read as one.
    assert.equal(failures.get(10).error, 'Row 2 not run (stopped)');
  });

  it('shows the Rows section before anything has run, and again after a reload', async () => {
    // The matrix used to be posted only from inside a run, so opening a
    // data-driven test showed an empty Rows section — and a window reload
    // emptied it again even though the ✓/✗ marks were still on the rows.
    await open('data-rows-plain.tmp.md');
    const mark = hooks.hostMessageCount();
    const uri = await open('data-rows.tmp.md');
    await waitFor('a matrix for a file nobody has run', () => lastRowsMsg(mark) !== null);

    const opened = lastRowsMsg(mark);
    assert.equal(opened.uri, uri.toString());
    assert.equal(opened.tables.length, 1);
    assert.equal(opened.tables[0].headerLine, HEADER_LINE);
    assert.deepEqual(
      opened.tables[0].rows.map((r) => [r.row, r.line, r.values, r.status]),
      [
        [1, ROW_LINES[0], 'email=a@b.c, password=***', 'pending'],
        [2, ROW_LINES[1], 'email=d@e.f, password=***', 'pending'],
      ],
    );
  });

  it('derives the matrix from the marks the tracker persisted, hover and all', async () => {
    const uri = await open('data-rows.tmp.md');
    // A run that leaves row 2 red, then a switch away and back — which is the
    // observable half of a reload: the tracker's marks are what survives, and
    // the panel has to be told about them again.
    fake.streamScripts = [
      (f) => f.end(),
      (f) => {
        f.push({ type: 'step:fail', line: STEP_LINE, error: 'no such element' });
        f.end();
      },
    ];
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('two requests', () => fake.requests.length >= 2);
    await waitFor('run finished', () => hooks.isRunning() === false);
    assert.deepEqual(rowStatuses(uri), ['pass', 'fail']);

    await open('data-rows-plain.tmp.md');
    const mark = hooks.hostMessageCount();
    await open('data-rows.tmp.md');
    await waitFor('the matrix comes back', () => lastRowsMsg(mark) !== null);

    const msg = lastRowsMsg(mark);
    assert.deepEqual(
      msg.tables[0].rows.map((r) => [r.row, r.status, r.detail]),
      [
        [1, 'passed', undefined],
        [2, 'failed', 'failed at step 1'],
      ],
      'the note is read back out of the persisted hover',
    );
  });

  it('the panel’s ↻ Re-run failed asks by TABLE, and the host resolves the rows', async () => {
    // The panel's own numbers can be a run old. Naming the table and letting
    // the host re-read the file is what keeps the button and the palette
    // command from ever picking different rows.
    const uri = await open('data-rows.tmp.md');
    fake.streamScripts = [
      (f) => f.end(),
      (f) => {
        f.push({ type: 'step:fail', line: STEP_LINE, error: 'boom' });
        f.end();
      },
    ];
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('two requests', () => fake.requests.length >= 2);
    await waitFor('run finished', () => hooks.isRunning() === false);
    assert.deepEqual(rowStatuses(uri), ['pass', 'fail']);

    fake.streamScripts = [undefined, undefined, (f) => f.end()];
    void hooks.dispatchWebviewMessage({ type: 'rerunFailedRows', table: 'run' });
    await waitFor('a third request', () => fake.requests.length >= 3);
    await waitFor('run finished', () => hooks.isRunning() === false);

    assert.equal(fake.requests.length, 3, 'only the failing row re-runs');
    assert.deepEqual([fake.requests[2].dataRow, fake.requests[2].dataRowCount], [2, 2]);
  });

  it('posts the matrix to the panel, with the editor line and masked values', async () => {
    const uri = await open('data-rows.tmp.md');
    const mark = hooks.hostMessageCount();
    await runAllRows(2);

    const msg = lastRowsMsg(mark);
    assert.ok(msg, 'expected a `rows` message');
    assert.equal(msg.uri, uri.toString());
    assert.equal(msg.tables.length, 1);
    assert.equal(msg.tables[0].table, 'run');
    assert.equal(msg.tables[0].headerLine, HEADER_LINE);
    assert.deepEqual(
      msg.tables[0].rows.map((r) => [r.row, r.line, r.values, r.status]),
      [
        [1, ROW_LINES[0], 'email=a@b.c, password=***', 'passed'],
        [2, ROW_LINES[1], 'email=d@e.f, password=***', 'passed'],
      ],
    );
    for (const row of msg.tables[0].rows) {
      assert.equal(typeof row.durationMs, 'number', 'a finished row reports its duration');
    }
  });

  it('leaves a test with no table with no summaries and an EMPTY matrix', async () => {
    const uri = await open('data-rows-plain.tmp.md');
    const mark = hooks.hostMessageCount();
    await runAllRows(1);
    assert.deepEqual(hooks.rowTablesForTests(uri), [], 'no tables, no summaries');
    // An empty list is a message, not silence: it is what a file has to say
    // when its table is gone, and the panel's Rows section only disappears
    // because it was told. The next test is that case for real.
    const msg = lastRowsMsg(mark);
    assert.ok(msg, 'the file still says what its rows are');
    assert.deepEqual(msg.tables, []);
  });

  it('a run of a file whose table was deleted tells the panel the rows are gone', async () => {
    const uri = await open('data-rows.tmp.md');
    await runAllRows(2);

    // Delete the four table lines (header, delimiter, both rows).
    const edit = new vscode.WorkspaceEdit();
    edit.delete(
      uri,
      new vscode.Range(new vscode.Position(HEADER_LINE - 1, 0), new vscode.Position(ROW_LINES[1], 0)),
    );
    assert.ok(await vscode.workspace.applyEdit(edit), 'the edit must apply');

    try {
      const mark = hooks.hostMessageCount();
      fake.streamScripts = [undefined, undefined, (f) => f.end()];
      void vscode.commands.executeCommand('testbench-native.runAll');
      await waitFor('a third request', () => fake.requests.length >= 3);
      await waitFor('run finished', () => hooks.isRunning() === false);

      const msg = lastRowsMsg(mark);
      assert.ok(msg, 'the panel has to be told, or it keeps showing rows that are gone');
      assert.deepEqual(msg.tables, []);
    } finally {
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  });

  it('paints nothing for a malformed table — the run is unlooped, so there are no rows', async () => {
    const uri = await open('data-rows-bad.tmp.md');
    await runAllRows(1);
    assert.deepEqual(hooks.rowTablesForTests(uri), []);
  });
});

// ---------------------------------------------------------------------------
// Running the rows you chose
// (stories/data-row-progress-and-selection.md §Running rows)
// ---------------------------------------------------------------------------

// line 7: header, 8: delimiter, 9/10/11: the three rows,
// line 13/14/15: the three steps.
const THREE_ROWS_FIXTURE = [
  '# Rows three',
  '',
  '## Config',
  '- baseUrl: http://localhost:8787/',
  '',
  '## Steps',
  '| email | password |',
  '|-------|----------|',
  '| a@b.c | pw1 |',
  '| d@e.f | pw2 |',
  '| g@h.i | pw3 |',
  '',
  '1. Enter {{email}}',
  '2. Enter {{password}}',
  '3. Submit',
  '',
].join('\n');

// line 7/8/9: the three steps; line 11 the `### Upload each statement`
// heading, 12 header, 13 delimiter, 14/15/16 the rows, 17/18 the body.
const SECTION_ROWS_FIXTURE = [
  '# Section rows',
  '',
  '## Config',
  '- baseUrl: http://localhost:8787/',
  '',
  '## Steps',
  '1. Sign in',
  '2. Upload each statement',
  '3. Count them',
  '',
  '### Upload each statement',
  '| file  |',
  '|-------|',
  '| a.png |',
  '| b.png |',
  '| c.png |',
  '1. Upload {{file}}',
  '2. Check it landed',
  '',
].join('\n');

// A section table whose one row is short a cell. Nothing used to say so:
// `buildSectionsPayload`, `dataTablesOf` and `scanTables` each swallow the
// throw for a good local reason, and the section then ran once with `{{file}}`
// unresolved — which reads as a model failure two steps later.
const BAD_SECTION_FIXTURE = [
  '# Section bad',
  '',
  '## Config',
  '- baseUrl: http://localhost:8787/',
  '',
  '## Steps',
  '1. Sign in',
  '2. Upload each statement',
  '',
  '### Upload each statement',
  '| file  | kind |',
  '|-------|------|',
  '| a.png |',
  '1. Upload {{file}}',
  '',
].join('\n');

// The reported gesture's file: three main-flow steps, the third of which
// calls a section whose table has two rows and whose body has two steps. Both
// section axes are narrowable, and independently.
//
// line 7/8/9: the main flow; 11 the `### Log In` heading, 12 header, 13
// delimiter, 14/15 the rows, 16/17 the body steps.
const SECTION_BODY_FIXTURE = [
  '# Section body',
  '',
  '## Config',
  '- baseUrl: http://localhost:8787/',
  '',
  '## Steps',
  '1. Navigate to the baseUrl',
  '2. Reject non-essential cookies in the cookie banner',
  '3. Log In',
  '',
  '### Log In',
  '| email                 | password    |',
  '|-----------------------|-------------|',
  '| demo@securebank.com   | password123 |',
  '| nobody@securebank.com | wrongpass   |',
  '1. Enter the email {{email}}',
  '2. Enter the password {{password}}',
  '',
].join('\n');

// A section body carrying a DECISION, for the one narrowing that cannot be
// taken literally: an `Otherwise` shipped without its `If` is a body the
// server's own parser refuses, in a message that blames the file.
//
// line 7/8: the main flow; 10 the heading; 11-14 the body, 11+12 one chain.
const CHAIN_BODY_FIXTURE = [
  '# Chain body',
  '',
  '## Config',
  '- baseUrl: http://localhost:8787/',
  '',
  '## Steps',
  '1. Navigate to the baseUrl',
  '2. Log In',
  '',
  '### Log In',
  '1. If a banner is shown, then Dismiss the banner',
  '2. Otherwise, Click Sign in',
  '3. Type the password',
  '4. Submit the form',
  '',
].join('\n');

// A RUN table (so the flow loops) plus a section whose body can be narrowed —
// the shape a stale narrowing has to end rather than repeat. The refusal is a
// fact about the file, so row 2 would read the same edited buffer, refuse the
// same way and print the same line.
//
// THREE rows, not two: with two, the row that refuses is also the last, and a
// loop that failed to end would look identical. The third row is the one that
// says whether the loop stopped or ground on.
//
// line 7 header, 8 delimiter, 9/10/11 the rows; 13/14 the main flow; 16 the
// `### Log In` heading, 17/18 its body.
const ROWS_AND_BODY_FIXTURE = [
  '# Rows and a body',
  '',
  '## Config',
  '- baseUrl: http://localhost:8787/',
  '',
  '## Steps',
  '| email                 | password    |',
  '|-----------------------|-------------|',
  '| demo@securebank.com   | password123 |',
  '| nobody@securebank.com | wrongpass   |',
  '| third@securebank.com  | pw3         |',
  '',
  '1. Navigate to the baseUrl',
  '2. Log In',
  '',
  '### Log In',
  '1. Enter the email {{email}}',
  '2. Enter the password {{password}}',
  '',
].join('\n');

const SELECTION_FIXTURES = {
  'data-rows-3.tmp.md': THREE_ROWS_FIXTURE,
  'data-rows-section.tmp.md': SECTION_ROWS_FIXTURE,
  'data-rows-bad-section.tmp.md': BAD_SECTION_FIXTURE,
  'data-rows-body.tmp.md': SECTION_BODY_FIXTURE,
  'data-rows-chain.tmp.md': CHAIN_BODY_FIXTURE,
  'data-rows-body-loop.tmp.md': ROWS_AND_BODY_FIXTURE,
  // Its own copy: the two suites above delete their fixtures in `after`.
  'data-rows-none.tmp.md': PLAIN_FIXTURE,
};

/**
 * Running the rows you chose.
 *
 * The selection narrows every axis it names, and an axis with nothing in it
 * means all of that axis — so the assertions are about WHICH batches went out
 * and what each carried: a filtered plan keeps every number (`dataRow` is the
 * table position, `dataRowCount` the table's count), a run that named steps
 * does NOT restart the browser between rows, and a row nobody selected keeps
 * the mark it already had.
 */
describe('TestBench data-row selection', function () {
  this.timeout(40_000);

  /** @type {FakeApiClient} */
  let fake;
  let hooks;

  const HEADER_LINE = 7;
  const ROW_LINES = [9, 10, 11];
  const STEP_LINES = [13, 14, 15];

  before(async () => {
    for (const [name, content] of Object.entries(SELECTION_FIXTURES)) {
      fs.writeFileSync(path.resolve(FIXTURES_DIR, name), content);
    }
    const validatorPath = path.resolve(
      __dirname, '..', '..', '..', '..', 'dist', 'server', 'section-entry.js',
    );
    if (!fs.existsSync(validatorPath)) {
      throw new Error(
        `the server's section validator is not built at ${validatorPath} — ` +
          'run `npm run build` at the repo root first',
      );
    }
    ({ validateSectionEntry } = await import(url.pathToFileURL(validatorPath).href));
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks not exposed');
    await hooks.discoveryReady();
    await hooks.discoveryRefresh();
  });

  after(() => {
    for (const name of Object.keys(SELECTION_FIXTURES)) {
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

  /**
   * Queue scripts for the NEXT streams this fake opens.
   *
   * `streamScripts` is indexed by the fake's cumulative stream count, so a
   * test that runs twice has to pad past the first run's streams — assigning a
   * fresh array would leave the second run's streams unscripted and hanging.
   */
  function queueScripts(...scripts) {
    fake.streamScripts = [
      ...Array.from({ length: fake.streamCallCount }, () => undefined),
      ...scripts,
    ];
  }

  /** Dispatch a `runRows` message and wait for `expected` more batches. */
  async function runRows(msg, expected) {
    const before = fake.requests.length;
    queueScripts(...Array.from({ length: expected }, () => (f) => f.end()));
    void hooks.dispatchWebviewMessage({ type: 'runRows', ...msg });
    if (expected > 0) {
      await waitFor(
        `${expected} more request(s)`,
        () => fake.requests.length >= before + expected,
      );
    }
    await waitFor('run finished', () => hooks.isRunning() === false);
  }

  /** The status on each data-row line, in table order. */
  const rowStatuses = (uri) => {
    const snap = hooks.tracker.snapshotFor(uri);
    const byLine = new Map(snap ? snap.statuses : []);
    return ROW_LINES.map((line) => byLine.get(line) ?? null);
  };

  /** Every `output` run event the host posted since `mark`. */
  const outputSince = (mark) =>
    hooks
      .hostMessagesSince(mark)
      .filter((m) => m.type === 'runEvent' && m.event.type === 'output')
      .map((m) => m.event.msg);

  it('runs one chosen row, keeping its table number and the table count', async () => {
    const uri = await open('data-rows-3.tmp.md');
    await runRows({ rows: [3] }, 1);

    assert.equal(fake.requests.length, 1, 'one row, one batch');
    assert.deepEqual(
      [fake.requests[0].dataRow, fake.requests[0].dataRowCount],
      [3, 3],
      'the plan is filtered, never renumbered',
    );
    assert.deepEqual(fake.requests[0].dataRowValues, { email: 'g@h.i', password: 'pw3' });
    assert.deepEqual(rowStatuses(uri), [null, null, 'pass'], 'only the chosen row is painted');
  });

  it('runs two chosen rows in table order, each in a fresh browser', async () => {
    await open('data-rows-3.tmp.md');
    // A one-row run first, purely to absorb the interactive pre-close: the
    // closes this feature is about are the ones the row loop makes, so the
    // assertion is a difference, not an absolute.
    await runRows({ rows: [2] }, 1);
    const baseline = fake.closeSessionIds.length;

    await runRows({ rows: [3, 1] }, 2);
    assert.deepEqual(
      fake.requests.slice(1).map((r) => r.dataRow),
      [1, 3],
      'table order, whatever order the numbers arrived in',
    );
    assert.equal(
      fake.closeSessionIds.length,
      baseline + 2,
      'one close per row: row 1 must not inherit the browser row 2 left open, and row 3 must not inherit row 1s',
    );
  });

  it('closes a session a previous run left open BEFORE the first row', async () => {
    // The defect this pins. The recycle used to live at the boundary BETWEEN
    // rows, so the first planned row — row 1 of a Run All, the single row of
    // Run This Row — reused whatever interactive session was already open. Live
    // evidence: after a green five-row run of `securebank-matrix.md`, Run This
    // Row on row 4 navigated fine and failed step 2, "Reject non-essential
    // cookies in the cookie banner" — the previous row's browser had already
    // made that choice and remembered it, so there was no banner.
    await open('data-rows-3.tmp.md');
    // A whole-file run, which leaves its session open: it belongs to the last
    // row that ran (§What does not change).
    await runRows({ all: 'run' }, 3);
    const baseline = fake.closeSessionIds.length;
    const batchesAtClose = [];
    fake.closeSessionImpl = () => batchesAtClose.push(fake.requests.length);
    const before = fake.requests.length;

    await runRows({ rows: [3] }, 1);

    assert.equal(fake.requests.length, before + 1, 'one row, one batch');
    assert.equal(
      fake.closeSessionIds.length,
      baseline + 1,
      'the one planned row still gets its one close',
    );
    assert.deepEqual(
      batchesAtClose,
      [before],
      'the close must land BEFORE the row batch, or the row runs in the old browser',
    );
  });

  it('…and a step selection of rows closes nothing, the first row included', async () => {
    // The other half of decision 4: a selection of SOME steps runs where the
    // session is, so the pre-first-row recycle must not fire there either —
    // that would put the first selected row on a blank page.
    await open('data-rows-3.tmp.md');
    await runRows({ all: 'run' }, 3);
    const closes = [];
    fake.closeSessionImpl = (sessionId) => closes.push(sessionId);

    await runRows({ rows: [1, 2], lines: [STEP_LINES[1]] }, 2);

    assert.deepEqual(closes, [], 'a step selection runs on the session it is on');
  });

  it('leaves the rows nobody selected exactly as they were', async () => {
    // Decision 6. The run's opening clear wipes the whole file's statuses and
    // the matrix is what puts them back — so an unselected row survives only
    // because the matrix was seeded from what the gutter already showed.
    const uri = await open('data-rows-3.tmp.md');
    fake.streamScripts = [
      (f) => f.end(),
      (f) => {
        f.push({ type: 'step:fail', line: STEP_LINES[0], error: 'no such element' });
        f.end();
      },
      (f) => f.end(),
    ];
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('three requests', () => fake.requests.length >= 3);
    await waitFor('run finished', () => hooks.isRunning() === false);
    assert.deepEqual(rowStatuses(uri), ['pass', 'fail', 'pass']);

    await runRows({ rows: [1] }, 1);
    assert.deepEqual(
      rowStatuses(uri),
      ['pass', 'fail', 'pass'],
      'rows 2 and 3 keep their marks — they were not skipped, they were not in the run',
    );
    // …and the failed row keeps its hover, the only place the reason survives
    // once the run log has scrolled.
    const snap = hooks.tracker.snapshotFor(uri);
    assert.match(new Map(snap.failures).get(ROW_LINES[1]).error, /^Row 2 failed at step 1/);
  });

  it('a step selection with rows runs on the session it is on, once per row', async () => {
    // Decision 4: a fresh browser per row belongs to the WHOLE-FILE run.
    await open('data-rows-3.tmp.md');
    await runRows({ rows: [2] }, 1);
    const baseline = fake.closeSessionIds.length;
    const mark = hooks.hostMessageCount();

    await runRows({ rows: [1, 2], lines: [STEP_LINES[1], STEP_LINES[2]] }, 2);

    const sent = fake.requests.slice(1);
    assert.deepEqual(sent.map((r) => r.dataRow), [1, 2]);
    for (const request of sent) {
      assert.deepEqual(
        request.sourceLines,
        [STEP_LINES[1], STEP_LINES[2]],
        'only the selected steps run, on every row',
      );
    }
    assert.equal(
      fake.closeSessionIds.length,
      baseline,
      'no browser restart between rows: the steps run where the session is',
    );
    const banners = outputSince(mark).filter((m) => m.startsWith('Row '));
    assert.deepEqual(banners, [
      'Row 1 of 3 (steps 2–3) — email=a@b.c, password=***',
      'Row 2 of 3 (steps 2–3) — email=d@e.f, password=***',
    ]);
  });

  it('a selection that covers every step is a whole-file run — fresh browser per row', async () => {
    // Ctrl+A then F5, and shift-clicking the first step and the last in the
    // panel, both arrive as a step selection naming every step there is.
    // Reading that as "some steps" put five rows in one browser and started
    // rows 2..n on the page row 1 signed into. A selection that covers
    // everything means everything, which is what it already means for steps.
    await open('data-rows-3.tmp.md');
    await runRows({ rows: [2] }, 1);
    const baseline = fake.closeSessionIds.length;

    await runRows({ rows: [1, 2], lines: STEP_LINES }, 2);
    assert.equal(
      fake.closeSessionIds.length,
      baseline + 2,
      'every step selected: both rows must start in a fresh browser',
    );
  });

  it('a drag from ## Steps to the first step is a whole-file run too', async () => {
    // The most ordinary gesture there is, and the one the raw-lines test could
    // not see: the selection's lines are the heading, the table and a blank —
    // not one step among them — while the resolver's fallback correctly reads
    // it as the whole flow. Asking the RAW lines whether they cover every step
    // answered no, so five rows ran in one browser and rows 2..n started on
    // the page row 1 had signed into.
    await open('data-rows-3.tmp.md');
    await runRows({ rows: [2] }, 1);
    const baseline = fake.closeSessionIds.length;

    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(5, 0), // the `## Steps` heading, line 6
      new vscode.Position(STEP_LINES[0] - 1, 0), // stops AT the start of step 1
    );
    queueScripts((f) => f.end(), (f) => f.end(), (f) => f.end());
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('three more requests', () => fake.requests.length >= 4);
    await waitFor('run finished', () => hooks.isRunning() === false);

    assert.deepEqual(fake.requests.slice(1).map((r) => r.dataRow), [1, 2, 3]);
    assert.equal(
      fake.closeSessionIds.length,
      baseline + 3,
      'every row must start in a fresh browser, the first one included',
    );
  });

  it('▷ Run all rows resolves the rows from the file, not from the panel', async () => {
    // The panel's numbers came from a `rows` message that may be a run old, so
    // the button names the TABLE and the host reads the file as it is.
    await open('data-rows-3.tmp.md');
    await runRows({ all: 'run' }, 3);
    assert.deepEqual(fake.requests.map((r) => r.dataRow), [1, 2, 3]);
    assert.deepEqual(fake.requests.map((r) => r.dataRowCount), [3, 3, 3]);
  });

  it('…and for a section table it runs every iteration of that one', async () => {
    await open('data-rows-section.tmp.md');
    await runRows({ all: { section: 'Upload each statement' } }, 1);
    const entry = fake.requests[0].sections['upload each statement'];
    assert.deepEqual(entry.rowNumbers, [1, 2, 3]);
    assert.equal(entry.rowCount, 3);
    assert.equal(fake.requests[0].dataRow, undefined, 'narrowing a section is not a row loop');
  });

  it('▷ Run all rows on a file with no table runs nothing at all', async () => {
    // Not "every row of a table that is not there", which an empty `rows` list
    // would have meant: an axis with nothing in it means ALL of that axis, so
    // sending one would have run the whole file.
    await open('data-rows-none.tmp.md');
    void hooks.dispatchWebviewMessage({ type: 'runRows', all: 'run' });
    await sleep(300);
    assert.equal(fake.requests.length, 0);
  });

  it('…and a proper subset of the steps still runs where the session is', async () => {
    await open('data-rows-3.tmp.md');
    await runRows({ rows: [2] }, 1);
    const baseline = fake.closeSessionIds.length;

    await runRows({ rows: [1, 2], lines: STEP_LINES.slice(0, 2) }, 2);
    assert.equal(
      fake.closeSessionIds.length,
      baseline,
      'one step short of the whole flow is a step selection, and those run in place',
    );
  });

  it('says out loud that a step selection runs once per row', async () => {
    // The silent case: no rows ticked, one step selected, five runs.
    await open('data-rows-3.tmp.md');
    const mark = hooks.hostMessageCount();
    await runRows({ lines: [STEP_LINES[1]] }, 3);
    assert.ok(
      outputSince(mark).includes(
        'Running 1 selected step for each of 3 rows — select rows in the table to narrow it',
      ),
      `expected the multiplier to be announced. Got ${JSON.stringify(outputSince(mark))}`,
    );
  });

  it('prints a line per row and the CLI rows summary', async () => {
    await open('data-rows-3.tmp.md');
    const mark = hooks.hostMessageCount();
    fake.streamScripts = [
      (f) => f.end(),
      (f) => {
        f.push({ type: 'step:fail', line: STEP_LINES[0], error: 'boom' });
        f.end();
      },
    ];
    void hooks.dispatchWebviewMessage({ type: 'runRows', rows: [1, 2] });
    await waitFor('two requests', () => fake.requests.length >= 2);
    await waitFor('run finished', () => hooks.isRunning() === false);

    const lines = outputSince(mark);
    assert.ok(
      lines.some((l) => /^ {2}Row 1: passed \(\d+\.\ds\)$/.test(l)),
      `expected a per-row line with a duration. Got ${JSON.stringify(lines)}`,
    );
    assert.ok(
      lines.some((l) => /^ {2}Row 2: failed at step 1 \(\d+\.\ds\)$/.test(l)),
      `the failed row names the step it died at. Got ${JSON.stringify(lines)}`,
    );
    // The count is what this run PLANNED — an unselected row was never in it.
    assert.ok(
      lines.includes('Rows: 2 — 1 passed, 1 failed'),
      `expected the rows summary. Got ${JSON.stringify(lines)}`,
    );
  });

  it('Run This Row on a table line runs that row alone', async () => {
    const uri = await open('data-rows-3.tmp.md');
    fake.streamScripts = [(f) => f.end()];
    await vscode.commands.executeCommand('testbench-native.runRow', { lineNumber: ROW_LINES[1] });
    await waitFor('one request', () => fake.requests.length >= 1);
    await waitFor('run finished', () => hooks.isRunning() === false);

    assert.equal(fake.requests.length, 1);
    assert.deepEqual([fake.requests[0].dataRow, fake.requests[0].dataRowCount], [2, 3]);
    assert.deepEqual(rowStatuses(uri), [null, 'pass', null]);
  });

  it('offers Run This Row on the data-row lines and on no others', async () => {
    // The gutter item's `when` is `editorLineNumber in <this array>` — the
    // only per-line `when` VS Code has, and its evaluation is not observable
    // from the extension host, so the array is what a test can pin.
    await open('data-rows-3.tmp.md');
    await waitFor(
      'the key is published',
      () => hooks.tracker.lastDataRowLinesContextValue.length > 0,
    );
    assert.deepEqual(hooks.tracker.lastDataRowLinesContextValue, ROW_LINES);

    // The section fixture's rows too — and, on a file with no table, nothing.
    await open('data-rows-section.tmp.md');
    await waitFor(
      'the section rows',
      () => hooks.tracker.lastDataRowLinesContextValue.length === 3,
    );
    assert.deepEqual(hooks.tracker.lastDataRowLinesContextValue, [14, 15, 16]);

    await open('data-rows-none.tmp.md');
    await waitFor(
      'no rows to run',
      () => hooks.tracker.lastDataRowLinesContextValue.length === 0,
    );
  });

  it('Run This Row refuses a line that is not a data row, and sends nothing', async () => {
    await open('data-rows-3.tmp.md');
    await vscode.commands.executeCommand('testbench-native.runRow', { lineNumber: HEADER_LINE });
    await sleep(200);
    assert.equal(fake.requests.length, 0, 'the header is not a row');
  });

  it('refuses a row number the table does not have, before anything is sent', async () => {
    await open('data-rows-3.tmp.md');
    void hooks.dispatchWebviewMessage({ type: 'runRows', rows: [9] });
    await sleep(300);
    assert.equal(fake.requests.length, 0, 'row 9 of a three-row table runs nothing');
  });

  it('Re-run Failed Rows re-runs exactly the rows the last run left red', async () => {
    const uri = await open('data-rows-3.tmp.md');
    fake.streamScripts = [
      (f) => f.end(),
      (f) => {
        f.push({ type: 'step:fail', line: STEP_LINES[0], error: 'boom' });
        f.end();
      },
      (f) => f.end(),
    ];
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('three requests', () => fake.requests.length >= 3);
    await waitFor('run finished', () => hooks.isRunning() === false);
    assert.deepEqual(rowStatuses(uri), ['pass', 'fail', 'pass']);

    queueScripts((f) => f.end());
    await vscode.commands.executeCommand('testbench-native.rerunFailedRows');
    await waitFor('a fourth request', () => fake.requests.length >= 4);
    await waitFor('run finished', () => hooks.isRunning() === false);

    assert.equal(fake.requests.length, 4, 'only the failing row re-runs');
    assert.deepEqual([fake.requests[3].dataRow, fake.requests[3].dataRowCount], [2, 3]);
    assert.deepEqual(rowStatuses(uri), ['pass', 'pass', 'pass'], 'and it can go green');
  });

  it('a selection of table rows plus Run runs those rows, whole', async () => {
    // The gesture the spec leads with: drag over rows 1-2, F5. No step lines
    // in the selection, so every step runs — an axis with nothing selected
    // means all of that axis.
    await open('data-rows-3.tmp.md');
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(ROW_LINES[0] - 1, 0),
      new vscode.Position(ROW_LINES[1] - 1, 5),
    );
    queueScripts((f) => f.end(), (f) => f.end());
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('two requests', () => fake.requests.length >= 2);
    await waitFor('run finished', () => hooks.isRunning() === false);

    assert.deepEqual(fake.requests.map((r) => r.dataRow), [1, 2]);
    assert.deepEqual(fake.requests[0].sourceLines, STEP_LINES, 'every step, for each row');
  });

  it('a whole-line selection of one row does not swallow the row below it', async () => {
    // Decision 10. Triple-click, Ctrl+L and Shift+Down all end at column 0 of
    // the NEXT line — the line break the gesture swallowed, not a line the
    // author chose. Without the guard this would run rows 2 and 3.
    await open('data-rows-3.tmp.md');
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(ROW_LINES[1] - 1, 0),
      new vscode.Position(ROW_LINES[2] - 1, 0),
    );
    queueScripts((f) => f.end());
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('one request', () => fake.requests.length >= 1);
    await waitFor('run finished', () => hooks.isRunning() === false);

    assert.equal(fake.requests.length, 1, 'one row, not two');
    assert.equal(fake.requests[0].dataRow, 2);
  });

  it('a selection of nothing but the table header runs every row', async () => {
    // You cannot select a table and get nothing (§Running rows).
    await open('data-rows-3.tmp.md');
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(HEADER_LINE - 1, 0),
      new vscode.Position(HEADER_LINE - 1, 6),
    );
    queueScripts((f) => f.end(), (f) => f.end(), (f) => f.end());
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('three requests', () => fake.requests.length >= 3);
    await waitFor('run finished', () => hooks.isRunning() === false);

    assert.deepEqual(fake.requests.map((r) => r.dataRow), [1, 2, 3]);
  });

  it('ships a narrowed section loop with its table numbering, and says so', async () => {
    await open('data-rows-section.tmp.md');
    const mark = hooks.hostMessageCount();
    await runRows({ sectionRows: { 'Upload each statement': [2] } }, 1);

    const entry = fake.requests[0].sections['upload each statement'];
    assert.deepEqual(entry.rows, [{ file: 'b.png' }], 'only the chosen row travels');
    assert.deepEqual(entry.rowNumbers, [2], 'with its position in the AUTHORED table');
    assert.equal(entry.rowCount, 3, 'and the table count, so the badge still reads (2/3)');
    // No `dataRow`: narrowing a section does not make the RUN a row loop.
    assert.equal(fake.requests[0].dataRow, undefined);
    assert.ok(
      outputSince(mark).includes(
        'Upload each statement — running rows 2 of 3; ' +
          'steps after this call will see only those rows',
      ),
      `expected the narrowing to be logged. Got ${JSON.stringify(outputSince(mark))}`,
    );
  });

  it('ignores a section narrowing whose call is not among the selected steps', async () => {
    // Logged, not refused: an axis nobody selected means all of it, and a
    // selection that stops short of the call has already said what it wants.
    await open('data-rows-section.tmp.md');
    const mark = hooks.hostMessageCount();
    await runRows({ sectionRows: { 'Upload each statement': [2] }, lines: [7] }, 1);

    const entry = fake.requests[0].sections['upload each statement'];
    assert.equal(entry.rows.length, 3, 'the section ships whole');
    assert.equal(entry.rowNumbers, undefined);
    assert.equal(entry.rowCount, undefined);
    assert.ok(
      outputSince(mark).includes(
        'Upload each statement — rows 2 ignored: ' +
          'the step that calls this section is not in your selection',
      ),
      `expected the drop to be logged. Got ${JSON.stringify(outputSince(mark))}`,
    );
  });

  it('says so when a SECTION table cannot be read, instead of running it unresolved', async () => {
    await open('data-rows-bad-section.tmp.md');
    const mark = hooks.hostMessageCount();
    queueScripts((f) => f.end());
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('one request', () => fake.requests.length >= 1);
    await waitFor('run finished', () => hooks.isRunning() === false);

    const reported = outputSince(mark).filter((l) =>
      l.startsWith('Section data table not read: '),
    );
    assert.equal(reported.length, 1, `expected one report. Got ${JSON.stringify(outputSince(mark))}`);
    assert.match(reported[0], /Upload each statement/, 'it names the table that failed');
    // The run still goes ahead — the parse error is a fact about the table,
    // and refusing to run the steps would be the worse trade.
    assert.equal(fake.requests.length, 1);
  });

  // -------------------------------------------------------------------------
  // The BODY axis: a selection narrows a section's steps as well as its rows
  // -------------------------------------------------------------------------

  /** Ranges over `data-rows-body.tmp.md`, by 1-based line, ending mid-line so
   *  the whole-line guard (decision 10) has nothing to trim. */
  const range = (line, endLine = line) =>
    new vscode.Selection(
      new vscode.Position(line - 1, 0),
      new vscode.Position(endLine - 1, 5),
    );

  /**
   * Every `sections` entry of `request`, through the SERVER's own validator.
   *
   * The fast suite records what the client shipped; on its own it cannot tell
   * a payload the server accepts from one it answers with a 400, and a
   * hand-written mirror of §3.2's table here would be the drift this contract
   * exists to prevent. `src/server/section-entry.ts` is that table, pure and
   * in its own module so this can import the real thing.
   *
   * Loaded from the repo's built `dist/`, so `npm run build` at the repo root
   * is a prerequisite of this suite — which the verify loop already runs, and
   * which the message below says out loud if it has not.
   */
  const assertSectionsValid = (request, note = '') => {
    for (const [key, entry] of Object.entries(request.sections ?? {})) {
      const invalid = validateSectionEntry(key, entry);
      assert.equal(
        invalid,
        null,
        `the server would refuse this payload${note ? ` (${note})` : ''}: ${invalid}`,
      );
    }
  };

  /** Set `selections`, run `runSelected`, and wait for one batch. */
  async function runSelection(selections, script = (f) => f.end()) {
    const editor = vscode.window.activeTextEditor;
    editor.selections = selections;
    const before = fake.requests.length;
    queueScripts(script);
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('one more request', () => fake.requests.length >= before + 1);
    await waitFor('run finished', () => hooks.isRunning() === false);
  }

  it('narrows a section BODY and its rows from one selection', async () => {
    // The reported bug: three main-flow steps, ONE body step, one table row.
    // `resolveRunSelection` drops the body line from what executes inline —
    // rung 2's double-run guard, unchanged — and the run now reads it before
    // it is forgotten, to narrow the body the call expands to.
    const uri = await open('data-rows-body.tmp.md');
    const mark = hooks.hostMessageCount();
    await runSelection([range(7, 9), range(17), range(15)]);

    const request = fake.requests[0];
    assertSectionsValid(request, 'both axes narrowed');
    assert.deepEqual(request.sourceLines, [7, 8, 9], 'only main-flow lines execute inline');
    const entry = request.sections['log in'];
    assert.deepEqual(entry.runSteps, [1], 'body step 2, 0-based');
    assert.deepEqual(
      entry.steps,
      ['Enter the email {{email}}', 'Enter the password {{password}}'],
      'the body travels whole — runSteps indexes into it',
    );
    assert.deepEqual(entry.stepLines, [16, 17]);
    assert.deepEqual(entry.rowNumbers, [2], 'the row axis narrows too, independently');
    assert.equal(entry.rowCount, 2);
    assert.deepEqual(entry.rows, [
      { email: 'nobody@securebank.com', password: 'wrongpass' },
    ]);

    const output = outputSince(mark);
    assert.ok(
      output.includes('Log In — running body steps 2 of 2'),
      `expected the body narrowing to be logged. Got ${JSON.stringify(output)}`,
    );
    assert.ok(
      output.includes(
        'Log In — running rows 2 of 2; steps after this call will see only those rows',
      ),
      `expected the row narrowing to be logged too. Got ${JSON.stringify(output)}`,
    );
    assert.ok(uri, 'the fixture opened');
  });

  it('ignores a body narrowing whose call is not among the selected steps', async () => {
    // Steps 1-2 and a body step: the call never runs, so there is nothing to
    // narrow. Logged rather than refused, exactly as the row equivalent is.
    await open('data-rows-body.tmp.md');
    const mark = hooks.hostMessageCount();
    await runSelection([range(7, 8), range(17)]);

    const entry = fake.requests[0].sections['log in'];
    assert.equal(entry.runSteps, undefined, 'the body ships whole');
    assert.deepEqual(fake.requests[0].sourceLines, [7, 8]);
    assert.ok(
      outputSince(mark).includes(
        'Log In — body steps 2 ignored: ' +
          'the step that calls this section is not in your selection',
      ),
      `expected the drop to be logged. Got ${JSON.stringify(outputSince(mark))}`,
    );
  });

  it('leaves a body-ONLY selection running detached, as it always has', async () => {
    // Rung 3: no main-flow step in the selection, so the body line runs at the
    // root frame with no invocation. Narrowing a call that is not being made
    // would be a different feature, and a regression in this one.
    await open('data-rows-body.tmp.md');
    const mark = hooks.hostMessageCount();
    await runSelection([range(17)]);

    const request = fake.requests[0];
    assert.deepEqual(request.sourceLines, [17], 'the body step itself is the run');
    assert.deepEqual(request.steps, ['Enter the password {{password}}']);
    assert.equal(request.sections['log in'].runSteps, undefined);
    assert.deepEqual(
      outputSince(mark).filter((l) => l.startsWith('Log In — ')),
      [],
      'nothing was narrowed, so nothing is announced',
    );
  });

  it('says so when the server runs the whole body anyway, exactly once', async () => {
    // A Sessions API older than `runSteps` drops the field and runs the body
    // whole. Nothing on the wire admits that, so it is detected from the
    // outside: a step event for a body line this run did not select. Said
    // once, and nothing is painted differently — the step really did run.
    //
    // TWO triggering events for the SAME unselected line, which is what makes
    // the once-per-run flag load-bearing: with one event, deleting the flag
    // left the suite green. A whole body running produces a start and a pass
    // for every step of it, so this is also the shape the real case has.
    const uri = await open('data-rows-body.tmp.md');
    const frame = { id: 'f1', kind: 'section', uri: uri.fsPath, skillName: 'Log In' };
    const mark = hooks.hostMessageCount();
    await runSelection([range(7, 9), range(17)], (f) => {
      // Line 16 is body step 1 — the one the selection left out.
      f.push({ type: 'step:start', line: 16, frame });
      f.push({ type: 'step:pass', line: 16, frame });
      f.push({ type: 'step:start', line: 17, frame });
      f.end();
    });

    const warned = outputSince(mark).filter((l) =>
      l.includes('the server ran the whole section body'),
    );
    assert.deepEqual(warned, [
      'Log In — the server ran the whole section body; restart or update the ' +
        'Sessions API server so a selection can narrow it',
    ]);
  });

  it('a detached body run cannot trip the old-server warning', async () => {
    // The detector reads a MISSING `frame.uri` as the test file, which is safe
    // only because of the pair of invariants beside it: a frameless event is a
    // top-level step, whose line is never a body line, and a detached body run
    // — the one thing that DOES execute body lines at the root frame —
    // narrows nothing, so the map it would be looked up in is empty.
    //
    // Driven through the detached RESUME, where `sectionResumePlan` runs with
    // `callLine == null`, so both the first batch and its continuation are
    // covered.
    const uri = await open('data-rows-body.tmp.md');
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(16, 0)), true),
    ]);
    const mark = hooks.hostMessageCount();
    // Both body lines, nothing from the main flow: rung 3, a detached run.
    await runSelection([range(16, 17)], (f) => {
      f.push({ type: 'step:start', line: 16 });
      f.push({ type: 'step:pass', line: 16 });
      f.end();
    });
    assert.deepEqual(fake.requests[0].sourceLines, [16], 'the batch stops at the breakpoint');
    assert.equal(fake.requests[0].sections['log in'].runSteps, undefined);

    queueScripts((f) => {
      f.push({ type: 'step:start', line: 17 });
      f.push({ type: 'step:pass', line: 17 });
      f.end();
    });
    void vscode.commands.executeCommand('testbench-native.continueRun');
    await waitFor('a second request', () => fake.requests.length >= 2);
    await waitFor('idle after the continue', () => hooks.isRunning() === false);

    assert.deepEqual(fake.requests[1].sourceLines, [17], 'the rest of the body, detached');
    assert.equal(fake.requests[1].sections['log in'].runSteps, undefined);
    assert.deepEqual(
      outputSince(mark).filter((l) => l.includes('the server ran the whole section body')),
      [],
      'nothing was narrowed, so there is nothing to warn about',
    );
  });

  it('a skipped placeholder is not evidence of execution, whatever line it names', async () => {
    // The wire has no third verdict, so a step the run decided against arrives
    // as a PASS carrying `output: 'skipped'` (stories/control-flow.md). The
    // warning is about a body step that RAN, and a skip is the opposite claim.
    //
    // No current server can produce this event for an unselected body line —
    // it never expands that line, and every skipped-pass producer is indexed
    // by expansion position — so this pins a rule rather than a sighting:
    // defensive insurance, worth one condition.
    //
    // Asserted as a PAIR, in one test: the same line, the same event type,
    // once with the sentinel and once without. The negative alone would pass
    // just as happily if `step:pass` had been dropped as a trigger outright.
    const uri = await open('data-rows-body.tmp.md');
    const frame = { id: 'f1', kind: 'section', uri: uri.fsPath, skillName: 'Log In' };
    const saidIt = (lines) => lines.filter((l) => l.includes('the server ran the whole section body'));

    const quiet = hooks.hostMessageCount();
    await runSelection([range(7, 9), range(17)], (f) => {
      // Line 16 is body step 1 — the one the selection left out.
      f.push({ type: 'step:pass', line: 16, output: 'skipped', frame });
      f.push({ type: 'step:pass', line: 17, frame });
      f.end();
    });
    assert.deepEqual(saidIt(outputSince(quiet)), [], 'a skipped placeholder ran nothing');

    const loud = hooks.hostMessageCount();
    await runSelection([range(7, 9), range(17)], (f) => {
      // The same line and the same event type, minus the sentinel: this one
      // really did run, and that is what the warning is about.
      f.push({ type: 'step:pass', line: 16, frame });
      f.end();
    });
    assert.deepEqual(saidIt(outputSince(loud)), [
      'Log In — the server ran the whole section body; restart or update the ' +
        'Sessions API server so a selection can narrow it',
    ]);
  });

  it('keeps an If/Otherwise chain whole, and says which step it added', async () => {
    // Half a decision is not a smaller decision: `runSteps: [1, 2]` here is a
    // body the server's expander refuses — `"Otherwise, Click Sign in" has no
    // decision to be the alternative of` — naming a file that is perfectly
    // well formed, and which the client's own pre-flight has just passed.
    await open('data-rows-chain.tmp.md');
    const mark = hooks.hostMessageCount();
    await runSelection([range(7, 8), range(12), range(13)]);

    assertSectionsValid(fake.requests[0], 'a chain kept whole');
    const entry = fake.requests[0].sections['log in'];
    assert.deepEqual(entry.runSteps, [0, 1, 2], 'the If comes with its Otherwise');
    const output = outputSince(mark);
    assert.ok(
      output.includes('Log In — body step 1 kept with 2, 3: an Otherwise needs its If'),
      `the addition must not be silent. Got ${JSON.stringify(output)}`,
    );
    assert.ok(
      output.includes('Log In — running body steps 1–3 of 4'),
      `and the narrowing line says what actually runs. Got ${JSON.stringify(output)}`,
    );
  });

  it('narrows a body whose call sits below the breakpoint, and keeps it on Continue', async () => {
    // Two bugs in one shape. The narrowing was decided off the BREAKPOINT-
    // trimmed step list, so a breakpoint above the call made `Log In` look
    // uncalled and the narrowing was reported ignored. And the Continue
    // rebuilds `lines` from the pause point — main-flow lines only — so
    // recomputing from them would answer "nothing was narrowed" and run the
    // whole body, painting marks the selection excluded.
    // The ROW axis rides along, and for the same reason: a Continue's lines
    // hold no row lines either, so before this it ran every row of the section
    // for the rest of the flow. Asserted here rather than in a test of its
    // own, because it is the same inheritance and the same pause.
    const uri = await open('data-rows-body.tmp.md');
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(7, 0)), true),
    ]);
    const mark = hooks.hostMessageCount();
    await runSelection([range(7, 9), range(15), range(17)]);

    assert.deepEqual(fake.requests[0].sourceLines, [7], 'the batch stops at the breakpoint');
    assertSectionsValid(fake.requests[0], 'narrowed, below a breakpoint');
    assert.deepEqual(
      fake.requests[0].sections['log in'].runSteps,
      [1],
      'the call below the breakpoint still runs on Continue, so it is still narrowed',
    );
    assert.deepEqual(fake.requests[0].sections['log in'].rowNumbers, [2]);
    assert.equal(fake.requests[0].sections['log in'].rowCount, 2);
    const first = outputSince(mark);
    assert.ok(
      first.includes('Log In — running body steps 2 of 2'),
      `Got ${JSON.stringify(first)}`,
    );
    assert.deepEqual(
      first.filter((l) => l.includes('ignored')),
      [],
      'nothing was ignored — the call is in the selection, just not in this batch',
    );

    const resumeMark = hooks.hostMessageCount();
    queueScripts((f) => f.end());
    void vscode.commands.executeCommand('testbench-native.continueRun');
    await waitFor('a second request', () => fake.requests.length >= 2);
    await waitFor('idle after the continue', () => hooks.isRunning() === false);

    assertSectionsValid(fake.requests[1], 'the continuation');
    assert.deepEqual(
      fake.requests[1].sections['log in'].runSteps,
      [1],
      'the continuation carries the narrowing it inherited',
    );
    assert.deepEqual(
      fake.requests[1].sections['log in'].rowNumbers,
      [2],
      'and the row narrowing, which its own lines could never re-derive',
    );
    assert.equal(fake.requests[1].sections['log in'].rowCount, 2);
    const resumed = outputSince(resumeMark);
    assert.ok(
      resumed.includes('Log In — the narrowing still applies: body steps 2 of 2'),
      `Got ${JSON.stringify(resumed)}`,
    );
    assert.ok(
      resumed.includes('Log In — the narrowing still applies: rows 2 of 2'),
      `the row half must say so too. Got ${JSON.stringify(resumed)}`,
    );
  });

  it('says nothing about the server when it honours runSteps', async () => {
    await open('data-rows-body.tmp.md');
    const mark = hooks.hostMessageCount();
    await runSelection([range(7, 9), range(17)], (f) => {
      f.push({ type: 'step:start', line: 17, frame: { id: 'f1', kind: 'section', uri: fixtureUri('data-rows-body.tmp.md').fsPath, skillName: 'Log In' } });
      f.end();
    });

    assert.deepEqual(
      outputSince(mark).filter((l) => l.includes('the server ran the whole section body')),
      [],
    );
  });

  // -------------------------------------------------------------------------
  // A narrowing that no longer describes the file
  // -------------------------------------------------------------------------

  /** Replace the whole active document, in the buffer only. */
  async function rewrite(uri, lines) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      uri,
      new vscode.Range(new vscode.Position(0, 0), doc.lineAt(doc.lineCount - 1).range.end),
      lines.join('\n'),
    );
    assert.ok(await vscode.workspace.applyEdit(edit), 'the edit must apply');
  }

  /** Every `done` status posted since `mark`. */
  const doneStatusesSince = (mark) =>
    hooks
      .hostMessagesSince(mark)
      .filter((m) => m.type === 'runEvent' && m.event.type === 'done')
      .map((m) => m.event.status);

  /** `data-rows-body-loop.tmp.md` as authored, for the edits below to vary. */
  const LOOP_LINES = ROWS_AND_BODY_FIXTURE.split('\n');

  /**
   * Run the two-row fixture with its body narrowed, edit the buffer to
   * `mutated` from inside row 1's stream, and let the loop reach row 2 — the
   * two-block shape in which a mid-run edit re-points `runSteps` at whatever
   * now sits in those positions.
   *
   * The row loop rather than a breakpoint, because a Continue is not reachable
   * after an edit at all: changing a step's text changes the run signature, the
   * tracker drops the pause marker, and Continue has nothing to continue. A
   * data-driven run is where a second block genuinely meets an edited buffer.
   */
  async function driftDuringLoop(mutated) {
    const uri = await open('data-rows-body-loop.tmp.md');
    const mark = hooks.hostMessageCount();
    queueScripts(
      async (f) => {
        await rewrite(uri, mutated);
        f.end();
      },
      (f) => f.end(),
    );
    const editor = vscode.window.activeTextEditor;
    editor.selections = [range(13, 14), range(18)];
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('one request', () => fake.requests.length >= 1);
    await waitFor('run finished', () => hooks.isRunning() === false);
    assert.deepEqual(
      fake.requests[0].sections['log in'].runSteps,
      [1],
      'row 1 went out narrowed, before the edit landed',
    );
    return {
      uri,
      stopped: outputSince(mark).filter((l) => l.startsWith('Run stopped: ')),
      statuses: doneStatusesSince(mark),
      requests: fake.requests.length,
    };
  }

  it('refuses the next block when a narrowed body step was edited', async () => {
    try {
      const edited = [...LOOP_LINES];
      edited[16] = '1. Enter the username {{email}}'; // body step 1, line 17
      const { stopped, statuses, requests } = await driftDuringLoop(edited);
      assert.deepEqual(stopped, [
        'Run stopped: body step 1 of "Log In" has been edited since this run ' +
          'narrowed it, so the body steps it selected no longer name the same ' +
          'steps. Re-run to pick again.',
      ]);
      assert.equal(requests, 1, 'nothing was sent — the refusal is before the request');
      assert.deepEqual(statuses, ['failed']);
    } finally {
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  });

  it('refuses when the narrowed section is gone from the file', async () => {
    try {
      // Everything above the `### Log In` heading on line 16, and nothing after.
      const { stopped, statuses, requests } = await driftDuringLoop(LOOP_LINES.slice(0, 15));
      assert.deepEqual(stopped, [
        'Run stopped: the section "Log In" is gone from the file, and this run ' +
          'had narrowed its body. Re-run to pick again.',
      ]);
      assert.equal(requests, 1);
      assert.deepEqual(statuses, ['failed']);
    } finally {
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  });

  it('refuses when a step was ADDED to the narrowed body', async () => {
    try {
      const grown = [...LOOP_LINES];
      grown.splice(18, 0, '3. Click Sign in');
      const { stopped, statuses, requests } = await driftDuringLoop(grown);
      assert.deepEqual(stopped, [
        'Run stopped: the body of "Log In" now has 3 steps where it had 2 when ' +
          'this run narrowed it, so the body steps it selected no longer name ' +
          'the same steps. Re-run to pick again.',
      ]);
      assert.equal(requests, 1);
      assert.deepEqual(statuses, ['failed']);
    } finally {
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  });

  it('a stale narrowing ends the ROW loop instead of refusing once per row', async () => {
    // The refusal is a fact about the FILE: the next row re-reads the same
    // edited buffer and refuses identically. Without ending the loop, a
    // two-row table said it twice and a ten-row one ten times, every row ✗,
    // and the run never reached a verdict the author could act on.
    try {
      const edited = [...LOOP_LINES];
      edited[16] = '1. Enter the username {{email}}';
      const { uri, stopped } = await driftDuringLoop(edited);
      assert.equal(stopped.length, 1, 'said once, not once per row');
      // Row 1 finished before the edit landed; row 2 is the one the refusal cut
      // off; row 3 is the one that proves the LOOP ended rather than grinding
      // on — without that, it too was attempted and closed out ■. Each says
      // why in its own words rather than claiming a Stop nobody pressed.
      const snap = hooks.tracker.snapshotFor(uri);
      const byLine = new Map(snap.statuses);
      assert.deepEqual(
        [byLine.get(9), byLine.get(10), byLine.get(11)],
        ['pass', 'stopped', 'skip'],
      );
      const failures = new Map(snap.failures);
      assert.equal(
        failures.get(10).error,
        'Row 2 stopped — a narrowed section was edited while the run was going',
      );
      assert.equal(
        failures.get(11).error,
        'Row 3 not run (a narrowed section was edited)',
      );
    } finally {
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  });

  it('Run & Compile never carries a narrowing — it runs the whole file', async () => {
    // The spec's claim, pinned. A compile does NOT reach the server through
    // `POST /codebehind/compile` (TestBench compiles through the ordinary step
    // route, so `runSteps` would ride a compile-mode run happily). What makes
    // a narrowed Run & Compile unreachable is this: the command passes no
    // lines at all, so there is no selection to narrow from.
    await open('data-rows-body.tmp.md');
    const editor = vscode.window.activeTextEditor;
    editor.selections = [range(7, 9), range(17)];
    const mark = hooks.hostMessageCount();
    queueScripts((f) => f.end());
    void vscode.commands.executeCommand('testbench-native.runAndCompile');
    await waitFor('one request', () => fake.requests.length >= 1);
    await waitFor('run finished', () => hooks.isRunning() === false);

    const request = fake.requests[0];
    assert.equal(request.compile, 'run');
    assert.deepEqual(request.sourceLines, [7, 8, 9], 'the whole flow, not the selection');
    assert.equal(request.sections['log in'].runSteps, undefined, 'and no narrowing');
    assert.deepEqual(
      outputSince(mark).filter((l) => l.startsWith('Log In — running body')),
      [],
      'nothing was narrowed, so nothing is announced',
    );
  });

  it('an unnarrowed run still ships every section row and neither new field', async () => {
    // The regression guard: the wire is byte-identical for a run nobody
    // narrowed, which is every run that existed before this feature.
    await open('data-rows-section.tmp.md');
    fake.streamScripts = [(f) => f.end()];
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('one request', () => fake.requests.length >= 1);
    await waitFor('run finished', () => hooks.isRunning() === false);

    const entry = fake.requests[0].sections['upload each statement'];
    assert.equal(entry.rows.length, 3);
    assert.equal(entry.rowNumbers, undefined);
    assert.equal(entry.rowCount, undefined);
    assert.equal(entry.runSteps, undefined, 'and the body ships whole');
  });
});

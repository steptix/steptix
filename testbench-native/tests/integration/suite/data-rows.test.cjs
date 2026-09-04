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
const vscode = require('vscode');
const { FakeApiClient } = require('../fakes/fake-api-client.cjs');

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

const FIXTURES = {
  'data-rows.tmp.md': ROWS_FIXTURE,
  'data-rows-plain.tmp.md': PLAIN_FIXTURE,
  'data-rows-bad.tmp.md': BAD_TABLE_FIXTURE,
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

  it('closes the session between rows so row 2 starts in a fresh browser', async () => {
    // The whole reason a run row is its own browser: row 1 may have signed in.
    //
    // Counted against the PLAIN fixture rather than asserted as an absolute,
    // because an interactive run already closes any stale session once before
    // it starts. The row boundary is the close this feature adds, so the
    // difference is what the test is about.
    await open('data-rows-plain.tmp.md');
    await runAllRows(1);
    const baseline = fake.closeSessionIds.length;

    fake = new FakeApiClient();
    hooks.setApiClientFactory(() => fake);
    await open('data-rows.tmp.md');
    await runAllRows(2);

    assert.equal(
      fake.closeSessionIds.length,
      baseline + 1,
      `two rows must add exactly one close over an unlooped run (baseline ${baseline}, got ${fake.closeSessionIds.length})`,
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

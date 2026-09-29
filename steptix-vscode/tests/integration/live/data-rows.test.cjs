/**
 * Live end-to-end test for data rows as the control surface
 * (stories/data-row-progress-and-selection.md).
 *
 * Everything below is asserted against the REAL Sessions API server, a real
 * browser and real AI turns. The fast integration suite already pins the
 * client's half with a FakeApiClient — which batches went out, what each
 * carried, which line got which mark — so what only a live run can add is the
 * other half:
 *
 *  - the server actually accumulates a five-row loop into ONE report whose
 *    matrix bands read `Row 1 of 5` … `Row 5 of 5`;
 *  - `rowNumbers`/`rowCount` survive api-server's per-field allow-list, so a
 *    narrowed section iteration is stamped `2 of 3` rather than `1 of 1`, and
 *    the report's section chip reads `(2/3)`;
 *  - a step selection with rows really does run on the session it is on — no
 *    browser relaunch, proved against the server's own session listing;
 *  - narrowing a section really does change what the steps after the call
 *    see, so the count assertion fails, visibly, as the story promises.
 *
 * The scenarios are ORDERED and depend on each other: scenario 2 asserts the
 * rows it did not select keep the ✓ scenario 1 left, and scenario 3 runs on
 * the session scenario 2 left open. Mocha runs `it`s in declaration order.
 *
 * Prereq: the API server running at $LIVE_SERVER_URL (the parallel runner
 * starts one per shard and points the shard's templates/.env at it), and the
 * fixture app on :8787 (runLiveTest.cjs boots it).
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');

const EXT_ID = 'pkent.steptix-vscode';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Say what was observed, into the shard's own log as well as stdout.
 *
 * The parallel runner discards a passing launch's stdout, so a `console.log`
 * alone means the strings this suite checked — the banner it matched, the
 * header summary it read, the report bands it found — exist only while the
 * run is failing. They are the evidence a reader wants most when it PASSES:
 * "what did the feature actually print?". `STEPTIX_LIVE_LOG` is the file the
 * extension's own OutputChannel is teed to, and it survives the run.
 */
function say(line) {
  console.log(`[live] ${line}`);
  const file = process.env.STEPTIX_LIVE_LOG;
  if (!file) return;
  try {
    fs.appendFileSync(file, `[live] ${line}\n`);
  } catch {
    /* best effort */
  }
}

async function waitFor(label, predicate, timeoutMs = 60_000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch (err) {
      last = err;
    }
    await sleep(200);
  }
  throw new Error(
    `timeout waiting for: ${label}${last ? ` (last error: ${last.message})` : ''}`,
  );
}

// ---------------------------------------------------------------------------
// Reading the panel's Output section.
//
// A run's Output lines reach the panel as host→webview messages, and the
// extension host retains only the last 2000 of them. A five-row run with
// `consoleLogLevel: debug` posts a lot more than that, so a tap that drains
// the buffer while the run is going is the only way to hold the whole log —
// reading it once at the end would silently lose the front of it.
// ---------------------------------------------------------------------------
function startOutputTap(hooks) {
  let mark = hooks.hostMessageCount();
  /** @type {string[]} */
  const output = [];
  /** @type {any[]} */
  const rowsMsgs = [];
  const drain = () => {
    const msgs = hooks.hostMessagesSince(mark);
    mark += msgs.length;
    for (const m of msgs) {
      if (m.type === 'runEvent' && m.event?.type === 'output') output.push(m.event.msg);
      else if (m.type === 'rows') rowsMsgs.push(m);
    }
  };
  const timer = setInterval(drain, 250);
  return {
    output,
    rowsMsgs,
    drain,
    stop() {
      clearInterval(timer);
      drain();
    },
  };
}

/** The status on each of `lines`, in order, or null where the line has none. */
function statusesOn(hooks, uri, lines) {
  const snap = hooks.tracker.snapshotFor(uri);
  const byLine = new Map(snap ? snap.statuses : []);
  return lines.map((l) => byLine.get(l) ?? null);
}

/** The one table's header summary — the after-text the decoration renders. */
function tableSummary(hooks, uri, index = 0) {
  const tables = hooks.rowTablesForTests(uri);
  return tables[index] ? tables[index].summary : `(no table ${index})`;
}

/** Every .html in the workspace's reports dir. */
function reportsIn(workspaceRoot) {
  const dir = path.resolve(workspaceRoot, 'init', 'reports');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
}

/** `STEPTIX_SERVER_API_KEY` from the (shard's) workspace .env. */
function apiKeyFrom(workspaceRoot) {
  const envPath = path.resolve(workspaceRoot, '.env');
  const text = fs.readFileSync(envPath, 'utf8');
  const m = /^\s*STEPTIX_SERVER_API_KEY\s*=\s*(.+)$/m.exec(text);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

/** The server's own view of its live sessions. */
async function listSessions(serverUrl, apiKey) {
  const res = await fetch(`${serverUrl}/sessions`, { headers: { 'x-api-key': apiKey } });
  assert.equal(res.status, 200, `GET /sessions returned ${res.status}`);
  const body = await res.json();
  return body.sessions ?? [];
}

async function openTestFile(hooks, workspaceRoot, name) {
  const file = path.resolve(workspaceRoot, 'init', 'tests', name);
  assert.ok(fs.existsSync(file), `${name} not found at ${file}`);
  const uri = vscode.Uri.file(file);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
    preview: false,
  });
  await waitFor(
    `${name} becomes the active editor`,
    () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
  );
  await waitFor(
    'steptix detects the test file',
    () => hooks.tracker.snapshot().isTestFile === true,
    15_000,
  );
  if (vscode.debug.breakpoints.length > 0) {
    vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
  }
  return uri;
}

const serverUrl = () => process.env.LIVE_SERVER_URL || 'http://localhost:3100';

async function activate() {
  const ext = vscode.extensions.getExtension(EXT_ID);
  assert.ok(ext, `${EXT_ID} not loaded`);
  if (!ext.isActive) await ext.activate();
  const hooks = ext.exports?.__testHooks;
  assert.ok(hooks, '__testHooks missing — activation may have failed');
  const res = await fetch(`${serverUrl()}/sessions/healthcheck/steps`, { method: 'OPTIONS' });
  assert.ok(
    res.status === 204 || res.status === 200,
    `Server at ${serverUrl()} not responding (status=${res.status})`,
  );
  return hooks;
}

// ===========================================================================
// The run-level table: securebank-matrix.md
// ===========================================================================
//
// Lines of templates/init/tests/securebank-matrix.md:
//   32 table header, 33 delimiter, 34-38 the five data rows
//   40-45 the six steps (41 = step 2, the cookie banner)
const MATRIX_HEADER = 32;
const MATRIX_ROWS = [34, 35, 36, 37, 38];
const MATRIX_STEPS = [40, 41, 42, 43, 44, 45];

describe('Steptix live — a run-level data table', function () {
  this.timeout(600_000);

  let hooks;
  let workspaceRoot;
  let uri;

  before(async function () {
    this.timeout(60_000);
    hooks = await activate();
    workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — the live runner must pass templates/');
    uri = await openTestFile(hooks, workspaceRoot, 'securebank-matrix.md');
    await vscode.commands.executeCommand('steptix.clearStatuses');
  });

  // -----------------------------------------------------------------------
  // 1. The whole matrix.
  // -----------------------------------------------------------------------
  it('runs all five rows, banding each in turn, and writes ONE report with a five-row matrix', async function () {
    // Five browsers, thirty AI-driven steps, no code-behind.
    this.timeout(900_000);

    const before = new Set(reportsIn(workspaceRoot));
    const tap = startOutputTap(hooks);

    say('Run All on securebank-matrix.md — 5 rows × 6 steps');
    void vscode.commands.executeCommand('steptix.runAll');
    await waitFor('run started', () => hooks.isRunning(), 60_000);

    // THE progress assertion. Positive evidence only: wait until a row after
    // the first is banded `running` AND every row before it is already `pass`.
    // Polling for a bare `running` would race the row boundary, which clears
    // the file's statuses before the matrix is re-posted.
    let bandedAt = null;
    await waitFor(
      'a later row is running with every earlier row passed',
      () => {
        const marks = statusesOn(hooks, uri, MATRIX_ROWS);
        const i = marks.indexOf('running');
        if (i < 1) return false;
        if (!marks.slice(0, i).every((s) => s === 'pass')) return false;
        bandedAt = i + 1;
        return true;
      },
      600_000,
    );
    say(`observed row ${bandedAt} running with rows 1..${bandedAt - 1} passed`);
    say(`header while looping: ${tableSummary(hooks, uri)}`);

    await waitFor('run finished', () => hooks.isRunning() === false, 900_000);
    tap.stop();

    const marks = statusesOn(hooks, uri, MATRIX_ROWS);
    const summary = tableSummary(hooks, uri);
    say(`row marks: ${JSON.stringify(marks)}`);
    say(`header summary: ${summary}`);
    // `Rows:` as well as `Row `: the end-of-run summary is the line every
    // assertion below quotes on failure, and a diagnostic that drops it makes
    // "the summary was missing" and "the summary said something else" look the
    // same.
    const rowLines = tap.output.filter((l) => /^\s*Rows?[: ]/.test(l));
    say(`row output lines:\n${rowLines.join('\n')}`);

    assert.deepEqual(
      marks,
      ['pass', 'pass', 'pass', 'pass', 'pass'],
      `every row of the matrix should pass. Output rows:\n${rowLines.join('\n')}`,
    );
    assert.equal(summary, '5 rows · 5 passed');
    // …rendered on the table's header line, and on the five row lines.
    const table = hooks.rowTablesForTests(uri)[0];
    assert.equal(table.section, null, 'the table under `## Steps` has no section name');
    assert.equal(table.headerLine, MATRIX_HEADER);
    assert.deepEqual(table.rowLines, MATRIX_ROWS);

    // The Output banner: the row, its position, and the values with the
    // password masked.
    const banner3 = tap.output.find((l) => l.startsWith('Row 3 of 5 —'));
    assert.ok(banner3, `expected a Row 3 banner. Got:\n${rowLines.join('\n')}`);
    // `maskIfSecret` stars a secret-named value to at most eight characters,
    // so the count is not the point — that the plaintext never appears is.
    assert.match(
      banner3,
      /^Row 3 of 5 — email=nobody@securebank\.com, password=\*+, outcome=/,
      `row 3's banner must name the row's values with the password masked: ${banner3}`,
    );
    assert.ok(
      !banner3.includes('password123'),
      `the banner must never carry the plaintext password: ${banner3}`,
    );

    // One line per row, then the rows line the CLI prints.
    for (const n of [1, 2, 3, 4, 5]) {
      assert.ok(
        tap.output.some((l) => new RegExp(`^ {2}Row ${n}: passed \\(\\d+\\.\\ds\\)$`).test(l)),
        `expected "  Row ${n}: passed (…s)". Got:\n${rowLines.join('\n')}`,
      );
    }
    assert.ok(
      tap.output.includes('Rows: 5 — 5 passed, 0 failed'),
      `expected the rows summary line. Got:\n${rowLines.join('\n')}`,
    );

    // Exactly ONE report for the whole loop (no -rowN files), and its matrix
    // bands name every row by its table position.
    const written = reportsIn(workspaceRoot).filter((f) => !before.has(f));
    assert.equal(
      written.length,
      1,
      `a five-row run must write exactly one report; got ${JSON.stringify(written)}`,
    );
    const reportPath = hooks.lastReportPath();
    assert.ok(reportPath && fs.existsSync(reportPath), `report path must exist: ${reportPath}`);
    assert.equal(
      path.basename(reportPath),
      written[0],
      'the recovered report path must be the file the run wrote',
    );
    const html = fs.readFileSync(reportPath, 'utf8');
    for (const n of [1, 2, 3, 4, 5]) {
      assert.match(
        html,
        new RegExp(`<span class="loop-band-lead">Row ${n} of 5</span>`),
        `the report's matrix must band row ${n}`,
      );
    }
    // …and the rows table itself, one line per row.
    assert.match(html, /<div class="rows-matrix">/);
    // Report: <path> is in the Output too, which is how an author finds it.
    assert.ok(
      tap.output.some((l) => l === `Report: ${reportPath}`),
      'the Output must name the report it wrote',
    );
  });

  // -----------------------------------------------------------------------
  // 2. One row.
  // -----------------------------------------------------------------------
  it('Run This Row on row 4 runs that row alone and leaves the other four marks alone', async function () {
    this.timeout(420_000);

    // Rows 1-3 and 5 carry scenario 1's ✓ and must still carry it afterwards:
    // an unselected row is untouched, never skipped (decision 6).
    assert.deepEqual(
      statusesOn(hooks, uri, MATRIX_ROWS),
      ['pass', 'pass', 'pass', 'pass', 'pass'],
      'scenario 1 must have left five green rows',
    );

    const before = new Set(reportsIn(workspaceRoot));
    const tap = startOutputTap(hooks);

    say('Run This Row on the 4th data row (line 37)');
    void vscode.commands.executeCommand('steptix.runRow', {
      lineNumber: MATRIX_ROWS[3],
    });
    await waitFor('run started', () => hooks.isRunning(), 60_000);
    await waitFor('run finished', () => hooks.isRunning() === false, 400_000);
    tap.stop();

    const marks = statusesOn(hooks, uri, MATRIX_ROWS);
    say(`row marks after the one-row run: ${JSON.stringify(marks)}`);
    say(`header summary: ${tableSummary(hooks, uri)}`);
    assert.deepEqual(
      marks,
      ['pass', 'pass', 'pass', 'pass', 'pass'],
      'row 4 re-ran green and the other four kept the marks they had',
    );

    const banner = tap.output.find((l) => l.startsWith('Row 4 of 5'));
    assert.ok(banner, `expected a Row 4 banner. Got:\n${tap.output.join('\n')}`);
    // Row 4's password cell is empty, which `maskIfSecret` renders `(empty)`.
    assert.match(
      banner,
      /^Row 4 of 5 — email=demo@securebank\.com, password=\(empty\), outcome=/,
      `row 4 keeps its TABLE number in a one-row run: ${banner}`,
    );
    assert.ok(
      tap.output.includes('Rows: 1 — 1 passed, 0 failed'),
      `a one-row run plans one row. Got:\n${tap.output.filter((l) => l.startsWith('Rows:')).join('\n')}`,
    );

    // The report's matrix has ONE band, and it is row 4 of 5.
    const written = reportsIn(workspaceRoot).filter((f) => !before.has(f));
    assert.equal(written.length, 1, `expected one new report, got ${JSON.stringify(written)}`);
    const html = fs.readFileSync(hooks.lastReportPath(), 'utf8');
    const bands = [...html.matchAll(/<span class="loop-band-lead">(Row \d+ of \d+)<\/span>/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(bands, ['Row 4 of 5'], 'the one-row report bands exactly one row');
  });

  // -----------------------------------------------------------------------
  // 3. Rows 1-2 with step 2 — on the session the browser is already on.
  // -----------------------------------------------------------------------
  it('rows 1-2 with step 2 selected runs the step twice, on the session it is on', async function () {
    this.timeout(420_000);

    const apiKey = apiKeyFrom(workspaceRoot);
    const sessionsBefore = await listSessions(serverUrl(), apiKey);
    say(`sessions before: ${JSON.stringify(
        sessionsBefore.map((s) => [s.sessionId, s.totalStepsExecuted, s.tab?.targetId]),
      )}`,
    );
    assert.equal(
      sessionsBefore.length,
      1,
      'scenario 2 must have left exactly one live session for this file',
    );
    const beforeSession = sessionsBefore[0];

    const editor = vscode.window.activeTextEditor;
    // Rows 1-2, then step 2. Both highlights end mid-line, which is what the
    // Alt+click / Shift+End gesture produces; a bare cursor is ignored on
    // purpose, and a highlight ending at column 0 of the next line would be
    // the whole-line gesture the selection guard trims.
    editor.selections = [
      new vscode.Selection(
        new vscode.Position(MATRIX_ROWS[0] - 1, 0),
        new vscode.Position(MATRIX_ROWS[1] - 1, 5),
      ),
      new vscode.Selection(
        new vscode.Position(MATRIX_STEPS[1] - 1, 0),
        new vscode.Position(MATRIX_STEPS[1] - 1, 10),
      ),
    ];

    const tap = startOutputTap(hooks);
    say('runSelected with rows 1-2 + step 2 highlighted');
    void vscode.commands.executeCommand('steptix.runSelected');
    await waitFor('run started', () => hooks.isRunning(), 60_000);
    await waitFor('run finished', () => hooks.isRunning() === false, 400_000);
    tap.stop();

    const banners = tap.output.filter((l) => /^Row \d+ of 5/.test(l));
    say(`banners: ${JSON.stringify(banners)}`);
    assert.ok(
      banners.some((l) =>
        /^Row 1 of 5 \(step 2\) — email=demo@securebank\.com, password=\*+, outcome=/.test(l),
      ),
      `expected row 1's step-2 banner. Got ${JSON.stringify(banners)}`,
    );
    assert.ok(
      banners.some((l) =>
        /^Row 2 of 5 \(step 2\) — email=demo@securebank\.com, password=\*+, outcome=/.test(l),
      ),
      `expected row 2's step-2 banner. Got ${JSON.stringify(banners)}`,
    );

    // Step 2's line ran and reached a terminal mark. Which one is the AI's
    // business — the cookie banner is remembered in localStorage, so on a
    // session that has already dismissed it there may be nothing to click.
    const stepMark = statusesOn(hooks, uri, [MATRIX_STEPS[1]])[0];
    say(`step 2 mark: ${stepMark}`);
    assert.ok(
      stepMark === 'pass' || stepMark === 'fail',
      `step 2 must have run and ended; got ${stepMark}`,
    );

    // THE no-relaunch assertion. A fresh browser per row belongs to the
    // whole-file run (decision 4); a selection of steps runs where the
    // session is. A relaunch would have closed this session and started a new
    // one under the same id, resetting its step counter and its tab.
    const sessionsAfter = await listSessions(serverUrl(), apiKey);
    say(`sessions after: ${JSON.stringify(
        sessionsAfter.map((s) => [s.sessionId, s.totalStepsExecuted, s.tab?.targetId]),
      )}`,
    );
    assert.equal(sessionsAfter.length, 1, 'still exactly one session');
    const afterSession = sessionsAfter[0];
    assert.equal(afterSession.sessionId, beforeSession.sessionId, 'same session id');
    assert.ok(
      afterSession.totalStepsExecuted > beforeSession.totalStepsExecuted,
      `the session's step counter must have GROWN (${beforeSession.totalStepsExecuted} → ` +
        `${afterSession.totalStepsExecuted}); a reset means the browser was relaunched`,
    );
    if (beforeSession.tab?.targetId && afterSession.tab?.targetId) {
      assert.equal(
        afterSession.tab.targetId,
        beforeSession.tab.targetId,
        'the run stayed on the same tab — no browser restart between the two rows',
      );
    }
  });

  after(async () => {
    try {
      await vscode.commands.executeCommand('steptix.stop');
      await vscode.commands.executeCommand('steptix.restartSession');
    } catch {
      /* teardown is best-effort */
    }
  });
});

// ===========================================================================
// The section-level table: securebank-upload-rows.md
// ===========================================================================
//
// Lines of templates/init/tests/securebank-upload-rows.md:
//   29-34 the six main-flow steps (32 = `4. Upload each statement`)
//   36 `### Upload each statement`, 37 header, 38 delimiter, 39-41 the rows
//   42-43 the two body steps
const UPLOAD_STEPS = [29, 30, 31, 32, 33, 34];
const SECTION_ROWS = [39, 40, 41];

describe('Steptix live — a section-level data table', function () {
  this.timeout(600_000);

  let hooks;
  let workspaceRoot;
  let uri;

  before(async function () {
    this.timeout(60_000);
    hooks = await activate();
    workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — the live runner must pass templates/');
    uri = await openTestFile(hooks, workspaceRoot, 'securebank-upload-rows.md');
    await vscode.commands.executeCommand('steptix.clearStatuses');
  });

  // -----------------------------------------------------------------------
  // 4. The whole flow: three iterations, painted as they run.
  // -----------------------------------------------------------------------
  it('paints the section table row by row as the server loops it, and passes', async function () {
    this.timeout(600_000);

    const tap = startOutputTap(hooks);
    say('Run All on securebank-upload-rows.md — 3 iterations');
    void vscode.commands.executeCommand('steptix.runAll');
    await waitFor('run started', () => hooks.isRunning(), 60_000);

    // The header summary, mid-loop. `iteration`, not `row` — a section table
    // counts iterations. Positive evidence, as in scenario 1.
    let sawLooping = null;
    await waitFor(
      'the section header reads "iteration N of 3 running"',
      () => {
        const summary = tableSummary(hooks, uri);
        if (!/iteration \d of 3 running/.test(summary)) return false;
        sawLooping = summary;
        return true;
      },
      420_000,
    );
    say(`section header while looping: ${sawLooping}`);

    await waitFor('run finished', () => hooks.isRunning() === false, 540_000);
    tap.stop();

    const marks = statusesOn(hooks, uri, SECTION_ROWS);
    const stepMarks = statusesOn(hooks, uri, UPLOAD_STEPS);
    say(`section row marks: ${JSON.stringify(marks)}`);
    say(`step marks: ${JSON.stringify(stepMarks)}`);
    say(`section header summary: ${tableSummary(hooks, uri)}`);

    assert.deepEqual(marks, ['pass', 'pass', 'pass'], 'all three iterations pass');
    assert.equal(tableSummary(hooks, uri), '3 rows · 3 passed');
    // Step 6 counts the rows the loop left behind: three files, three rows.
    assert.ok(
      stepMarks[5] === 'pass',
      `step 6 must pass on a full loop; got ${stepMarks[5]}`,
    );

    // The report bands every iteration by its table position, and the section
    // chip on each body step carries the same numbering.
    const reportPath = hooks.lastReportPath();
    assert.ok(reportPath && fs.existsSync(reportPath), `report must exist: ${reportPath}`);
    const html = fs.readFileSync(reportPath, 'utf8');
    for (const n of [1, 2, 3]) {
      assert.match(
        html,
        new RegExp(
          `<span class="loop-band-lead">Upload each statement — iteration ${n} of 3</span>`,
        ),
        `the report must band iteration ${n} of 3`,
      );
    }
    assert.match(html, /Upload each statement \(2\/3\)/, 'the section chip keeps the numbering');
  });

  // -----------------------------------------------------------------------
  // 5. One iteration — and the honest downstream failure.
  // -----------------------------------------------------------------------
  it('Run This Row on the section table narrows the loop, keeps the numbering, and lets step 6 fail', async function () {
    this.timeout(600_000);

    assert.deepEqual(
      statusesOn(hooks, uri, SECTION_ROWS),
      ['pass', 'pass', 'pass'],
      'scenario 4 must have left three green iterations',
    );

    const tap = startOutputTap(hooks);
    say('Run This Row on the section table\'s 2nd row (statement.pdf, line 40)');
    void vscode.commands.executeCommand('steptix.runRow', {
      lineNumber: SECTION_ROWS[1],
    });
    await waitFor('run started', () => hooks.isRunning(), 60_000);
    await waitFor('run finished', () => hooks.isRunning() === false, 540_000);
    tap.stop();

    const marks = statusesOn(hooks, uri, SECTION_ROWS);
    const stepMarks = statusesOn(hooks, uri, UPLOAD_STEPS);
    say(`section row marks: ${JSON.stringify(marks)}`);
    say(`step marks: ${JSON.stringify(stepMarks)}`);

    // The narrowing is said out loud at the call — and the line goes on to say
    // what it costs the steps after it, so `startsWith` rather than an exact
    // match on the first half.
    assert.ok(
      tap.output.some((l) =>
        l.startsWith('Upload each statement — running rows 2 of 3'),
      ),
      `expected the narrowing log line. Got:\n${tap.output
        .filter((l) => l.includes('Upload each statement'))
        .join('\n')}`,
    );

    // Row 2 ran; rows 1 and 3 are untouched — not skipped, they were never in
    // this run's plan.
    assert.deepEqual(marks, ['pass', 'pass', 'pass'], 'rows 1 and 3 keep their prior marks');

    // THE downstream assertion: one file uploaded, so `{{document_count}}`
    // is 1 and step 6 fails. Narrowing a section changes what the steps after
    // the call see, and the test says so rather than pretending otherwise.
    assert.equal(stepMarks[5], 'fail', `step 6 must fail on a narrowed loop; got ${stepMarks[5]}`);

    // The report keeps the AUTHORED table's numbering: the iteration is 2 of
    // 3, not 1 of 1, and the section chip reads (2/3). Without `rowNumbers`
    // and `rowCount` surviving the wire, both would read 1 of 1.
    const reportPath = hooks.lastReportPath();
    assert.ok(reportPath && fs.existsSync(reportPath), `report must exist: ${reportPath}`);
    const html = fs.readFileSync(reportPath, 'utf8');
    const bands = [
      ...html.matchAll(/<span class="loop-band-lead">([^<]*iteration[^<]*)<\/span>/g),
    ].map((m) => m[1]);
    say(`report bands: ${JSON.stringify(bands)}`);
    assert.deepEqual(
      bands,
      ['Upload each statement — iteration 2 of 3'],
      'one iteration, numbered by its position in the authored table',
    );
    assert.match(html, /Upload each statement \(2\/3\)/, 'the section chip reads (2/3)');
    assert.ok(
      !/Upload each statement \(1\/1\)/.test(html),
      'a narrowed loop must never renumber itself 1 of 1',
    );
  });

  after(async () => {
    try {
      await vscode.commands.executeCommand('steptix.stop');
      await vscode.commands.executeCommand('steptix.restartSession');
    } catch {
      /* teardown is best-effort */
    }
  });
});

// ===========================================================================
// Narrowing a section's BODY: securebank-login-rows.md
// ===========================================================================
//
// Lines of templates/init/tests/securebank-login-rows.md:
//   34-36 the three main-flow steps (36 = `3. Log In`, the call)
//   38 `### Log In`, 39 header, 40 delimiter, 41-42 the rows
//   43-44 the two body steps
const LOGIN_STEPS = [34, 35, 36];
const LOGIN_ROWS = [41, 42];
const LOGIN_BODY = [43, 44];

/**
 * The reported gesture, end to end: three main-flow steps, ONE body step, one
 * table row, one F5.
 *
 * The fast suite already pins what the client sends — `runSteps: [1]` beside
 * `rowNumbers: [2]`, and the two Output lines. What only a live run can add is
 * that the field survives api-server's per-field allow-list and actually
 * narrows the expansion: three steps execute, not four, and the body step the
 * selection left out never runs at all.
 */
describe('Steptix live — a selection narrows a section\'s body', function () {
  this.timeout(300_000);

  let hooks;
  let workspaceRoot;
  let uri;

  before(async function () {
    this.timeout(60_000);
    hooks = await activate();
    workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — the live runner must pass templates/');
    uri = await openTestFile(hooks, workspaceRoot, 'securebank-login-rows.md');
    await vscode.commands.executeCommand('steptix.clearStatuses');
  });

  it('runs the flow once, for row 2, entering only the password', async function () {
    this.timeout(300_000);

    const apiKey = apiKeyFrom(workspaceRoot);
    const tap = startOutputTap(hooks);
    const editor = vscode.window.activeTextEditor;
    // Three ranges, the gesture the story describes: drag the main flow,
    // Alt+click body step 2, Alt+click the table's second row. Each ends
    // mid-line so the whole-line guard (decision 10) has nothing to trim.
    editor.selections = [
      new vscode.Selection(
        new vscode.Position(LOGIN_STEPS[0] - 1, 0),
        new vscode.Position(LOGIN_STEPS[2] - 1, 5),
      ),
      new vscode.Selection(
        new vscode.Position(LOGIN_BODY[1] - 1, 0),
        new vscode.Position(LOGIN_BODY[1] - 1, 5),
      ),
      new vscode.Selection(
        new vscode.Position(LOGIN_ROWS[1] - 1, 0),
        new vscode.Position(LOGIN_ROWS[1] - 1, 5),
      ),
    ];

    say('Run Selected on securebank-login-rows.md — steps 1-3, body step 2, row 2');
    void vscode.commands.executeCommand('steptix.runSelected');
    await waitFor('run started', () => hooks.isRunning(), 60_000);
    await waitFor('run finished', () => hooks.isRunning() === false, 240_000);
    tap.stop();

    const stepMarks = statusesOn(hooks, uri, LOGIN_STEPS);
    const bodyMarks = statusesOn(hooks, uri, LOGIN_BODY);
    const rowMarks = statusesOn(hooks, uri, LOGIN_ROWS);
    say(`main-flow marks: ${JSON.stringify(stepMarks)}`);
    say(`body marks: ${JSON.stringify(bodyMarks)}`);
    say(`section row marks: ${JSON.stringify(rowMarks)}`);
    say(
      `Log In lines:\n${tap.output.filter((l) => l.startsWith('Log In —')).join('\n')}`,
    );

    // The three main-flow steps ran, the call among them. `pass-code-behind`
    // and `pass-stale` are how a step passed, not whether — the live suite
    // shares one workspace with everything else in it.
    for (const [i, mark] of stepMarks.entries()) {
      assert.ok(
        typeof mark === 'string' && mark.startsWith('pass'),
        `main-flow step ${i + 1} (line ${LOGIN_STEPS[i]}) must pass; got ${mark}`,
      );
    }

    // THE assertion. Body step 1 was not selected, so it has no mark at all —
    // it did not run. Body step 2 did.
    assert.equal(
      bodyMarks[0],
      null,
      `body step 1 (line ${LOGIN_BODY[0]}) must not run — it was not in the selection`,
    );
    assert.ok(
      typeof bodyMarks[1] === 'string' && bodyMarks[1].startsWith('pass'),
      `body step 2 (line ${LOGIN_BODY[1]}) must pass; got ${bodyMarks[1]}`,
    );
    // And no server complaint about a whole body having run anyway.
    assert.deepEqual(
      tap.output.filter((l) => l.includes('the server ran the whole section body')),
      [],
      'the server honoured runSteps, so nothing should warn about it',
    );

    // The row axis narrowed independently: row 2 ran, row 1 was never in the
    // plan and keeps the nothing it had.
    assert.equal(rowMarks[0], null, 'row 1 was not selected, so it is untouched');
    assert.equal(rowMarks[1], 'pass', 'row 2 is the iteration that ran');

    // Both narrowings said out loud, in the same voice.
    assert.ok(
      tap.output.includes('Log In — running body steps 2 of 2'),
      `expected the body narrowing line. Got:\n${tap.output
        .filter((l) => l.startsWith('Log In —'))
        .join('\n')}`,
    );
    assert.ok(
      tap.output.some((l) => l.startsWith('Log In — running rows 2 of 2')),
      `expected the row narrowing line. Got:\n${tap.output
        .filter((l) => l.startsWith('Log In —'))
        .join('\n')}`,
    );

    // The server's own count, which is the half no client-side assertion can
    // reach: THREE steps executed, not four. A section call is REPLACED by its
    // body rather than run alongside it, so the expansion is `Navigate`,
    // `Reject`, and the one body step the selection kept. Without `runSteps`
    // reaching the expander it would be four, and body step 1 would have a
    // mark above.
    // Case-insensitive: GET /sessions reports the Map's internal key, which
    // session-manager.ts's sessionKey() lower-cases whole on win32 for any
    // drive-letter/UNC path (so two spellings of one file are one session).
    // uri.fsPath keeps whatever case VS Code opened the file with, so an
    // exact === here is comparing a normalised key against an unnormalised
    // one and can miss a real match on Windows.
    const sessions = await listSessions(serverUrl(), apiKey);
    say(`sessions at lookup (${serverUrl()}): ${JSON.stringify(sessions.map((s) => [s.sessionId, s.totalStepsExecuted]))}`);
    const mine = sessions.find(
      (s) => s.sessionId.toLowerCase() === uri.fsPath.toLowerCase(),
    );
    say(`session: ${JSON.stringify(mine && [mine.sessionId, mine.totalStepsExecuted])}`);
    assert.ok(mine, `no server session for ${uri.fsPath}`);
    assert.equal(
      mine.totalStepsExecuted,
      3,
      'two main-flow steps plus the one body step the selection kept',
    );
  });

  after(async () => {
    try {
      await vscode.commands.executeCommand('steptix.stop');
      await vscode.commands.executeCommand('steptix.restartSession');
    } catch {
      /* teardown is best-effort */
    }
  });
});

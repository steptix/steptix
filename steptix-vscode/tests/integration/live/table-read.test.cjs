/**
 * Live end-to-end test for structured table reads
 * (docs/specs/SPEC-structured-table-reads.md §12, acceptance criterion 2).
 *
 * The unit layer pins the halves that can be pinned in isolation: the action
 * parser validates a `readTable`, a Playwright suite extracts records from the
 * fixture pages, and the planner binds an object item. What only a live run can
 * say is whether a record survives the whole chain and comes back as the row it
 * came from:
 *
 *   real editor -> real RunController -> real ApiClient -> real api-server
 *     -> real model choosing readTable against a real page -> real extractor
 *       -> records in the variable map -> real For each planner
 *         -> dotted bindings in the step the model is then given
 *           -> frame + step events -> the Variables scope and the HTML report
 *
 * The fixture is chosen to make one specific wrong answer detectable.
 * `scheduled-payments.html` has **no header row** (so the columns are read by
 * position) and lists Origin Energy twice — row 1 at $140.00, row 3 at $86.10.
 * A run that finds "the row for Origin Energy" by name opens the same details
 * page twice and still goes green; the baseline recorded in the spec did
 * exactly that. So the claims here are:
 *
 *  - five passes, one per captured record, and a `readTable` that says it
 *    captured five rows and three columns;
 *  - the Variables scope carries the record's properties, `_row` first, in the
 *    order the columns were asked for — that is the surface an author watches;
 *  - the `If … then return` pass really ends at its first step, with the rest
 *    of its body painted as a not-taken skip rather than left blank;
 *  - and the two Origin Energy passes open DIFFERENT details pages, each
 *    verifying its own amount. That is the assertion the fixture exists for.
 *
 * Prereq: the API server on $LIVE_SERVER_URL (the parallel runner starts one
 * per shard and points that shard's templates/.env at it) and the fixture app
 * on :8787 (runLiveTest.cjs boots it).
 *
 * Run just this file:
 *   cd steptix-vscode
 *   npm run test:live -- --shards=2 --files=table-read.test.cjs
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');

const EXT_ID = 'pkent.steptix-vscode';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Say what was observed, into the shard's own log as well as stdout — the
 * parallel runner discards a passing launch's stdout, so a `console.log` alone
 * means the evidence exists only while the run is failing. (Borrowed verbatim
 * from control-flow.test.cjs, for the same reason.)
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

/** Every mark that means "this step ran and passed", however it passed. */
const PASSED = new Set(['pass', 'pass-code-behind', 'pass-stale']);
const passed = (status) => PASSED.has(status);

const serverUrl = () => process.env.LIVE_SERVER_URL || 'http://localhost:3100';

async function activate() {
  const ext = vscode.extensions.getExtension(EXT_ID);
  assert.ok(ext, `${EXT_ID} not loaded`);
  if (!ext.isActive) await ext.activate();
  const hooks = ext.exports?.__testHooks;
  assert.ok(hooks, '__testHooks missing — activation may have failed');
  try {
    const res = await fetch(`${serverUrl()}/sessions/healthcheck/steps`, { method: 'OPTIONS' });
    assert.ok(
      res.status === 204 || res.status === 200,
      `Server at ${serverUrl()} not responding (status=${res.status})`,
    );
  } catch (err) {
    throw new Error(
      `Live test requires the API server running at ${serverUrl()}. ` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return hooks;
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
  return { file, uri };
}

/** The status on each of `lines`, in order, or null where the line has none. */
function statusesOn(hooks, uri, lines) {
  const snap = hooks.tracker.snapshotFor(uri);
  const byLine = new Map(snap ? snap.statuses : []);
  return lines.map((l) => byLine.get(l) ?? null);
}

/** Every .html in the workspace's reports dir. */
function reportsIn(workspaceRoot) {
  const dir = path.resolve(workspaceRoot, 'init', 'reports');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
}

// ---------------------------------------------------------------------------
// Reading the fixture's own line numbers, so a reworded step fails by name
// rather than drifting onto its neighbour. (control-flow.test.cjs's
// `resolveFixture`, unchanged.)
// ---------------------------------------------------------------------------
function resolveFixture(testFile, expectedSteps, expectedSections) {
  const lines = fs.readFileSync(testFile, 'utf8').split(/\r?\n/);

  const stepsHeading = lines.findIndex((l) => /^##\s+Steps\s*$/.test(l));
  assert.ok(stepsHeading >= 0, `${path.basename(testFile)} has no "## Steps" heading`);

  const main = [];
  const sections = {};
  let current = null;

  for (let i = stepsHeading + 1; i < lines.length; i++) {
    const heading = /^###\s+(.+?)\s*$/.exec(lines[i]);
    if (heading) {
      current = { name: heading[1], heading: i + 1, body: [] };
      sections[current.name] = { heading: current.heading, body: current.body };
      continue;
    }
    if (/^##\s+/.test(lines[i])) break;
    const numbered = /^(\d+)\.\s+(.*)$/.exec(lines[i]);
    if (!numbered) continue;
    if (current) current.body.push({ line: i + 1, text: numbered[2].trim() });
    else main.push({ line: i + 1, n: Number(numbered[1]), text: numbered[2].trim() });
  }

  assert.equal(
    main.length,
    expectedSteps.length,
    `${path.basename(testFile)} must have exactly ${expectedSteps.length} main-flow steps, ` +
      `found ${main.length} — if a step was added or removed, update this test deliberately`,
  );

  const step = {};
  const text = {};
  expectedSteps.forEach(([key, fragment], i) => {
    const found = main[i];
    assert.equal(found.n, i + 1, `step ${i + 1} is numbered ${found.n} in the fixture`);
    assert.ok(
      found.text.includes(fragment),
      `step ${i + 1} (line ${found.line}) should contain '${fragment}', reads: '${found.text}'`,
    );
    step[key] = found.line;
    text[key] = found.text;
  });

  for (const [name, bodyCount] of Object.entries(expectedSections)) {
    const section = sections[name];
    assert.ok(section, `${path.basename(testFile)} must define a "### ${name}" section`);
    assert.equal(
      section.body.length,
      bodyCount,
      `"### ${name}" must have exactly ${bodyCount} body step(s), found ${section.body.length}`,
    );
  }

  return {
    step,
    text,
    sections,
    bodyLines: (name) => sections[name].body.map((b) => b.line),
    bodyTexts: (name) => sections[name].body.map((b) => b.text),
  };
}

// ---------------------------------------------------------------------------
// Reading the report — the only surface that survives the run with one row per
// EXECUTION. A per-line status cannot say which of five passes did what.
// ---------------------------------------------------------------------------
function decodeHtml(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Every rendered step row: number label, the SUBSTITUTED instruction, its
 *  section chip (`Review the payment (3/5)`) and its status word. */
function reportSteps(html) {
  const out = [];
  const re =
    /<span class="step-number">([^<]*)<\/span>\s*<span class="step-instruction">([^<]*)<\/span>([\s\S]*?)<span class="step-chevron">/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const badges = [...m[3].matchAll(/<span class="badge ([a-z][\w -]*?)"[^>]*>([^<]*)<\/span>/g)].map(
      (b) => ({ classes: b[1].trim().split(/\s+/), text: decodeHtml(b[2]) }),
    );
    const statusBadge = badges[badges.length - 1];
    const sectionBadge = badges.find((b) => b.classes.includes('badge-section'));
    out.push({
      number: decodeHtml(m[1]),
      instruction: decodeHtml(m[2]),
      status: statusBadge ? statusBadge.text.replace(/[^A-Z]/g, '') : '(no status badge)',
      section: sectionBadge ? sectionBadge.text.replace(/\s*\(\d+\/\S*\)\s*$/, '') : null,
      sectionChip: sectionBadge ? sectionBadge.text : null,
    });
  }
  return out;
}

/** Every loop band, as `{ lead, label, index, count, values }`. */
function reportBands(html) {
  const out = [];
  const re =
    /<span class="loop-band-lead">([^<]*)<\/span>\s*(?:<span class="loop-band-values">([^<]*)<\/span>)?/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const lead = decodeHtml(m[1]);
    const parsed = /^(.*) — iteration (\d+) of (\S+)$/.exec(lead);
    const values = {};
    if (m[2]) {
      for (const pair of decodeHtml(m[2]).split(', ')) {
        const eq = pair.indexOf('=');
        if (eq > 0) values[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
    }
    out.push({
      lead,
      label: parsed ? parsed[1] : null,
      index: parsed ? Number(parsed[2]) : null,
      count: parsed ? parsed[3] : null,
      values,
    });
  }
  return out;
}

/**
 * The report's rows for one section, grouped by the pass its chip names:
 * `Review the payment (3/5)` -> pass 3. Rows keep their document order inside
 * a pass, which is the body's own order.
 */
function rowsByPass(steps, sectionName) {
  const byPass = new Map();
  for (const row of steps) {
    if (row.section !== sectionName) continue;
    const hit = /\((\d+)\/(\S+?)\)\s*$/.exec(row.sectionChip ?? '');
    if (!hit) continue;
    const index = Number(hit[1]);
    if (!byPass.has(index)) byPass.set(index, []);
    byPass.get(index).push(row);
  }
  return byPass;
}

// ---------------------------------------------------------------------------
// Watching the run while it runs: the panel's Output lines (bounded, and gone
// by the end) and the Variables scope of the frame currently executing.
// ---------------------------------------------------------------------------
function startRunTap(hooks) {
  let mark = hooks.hostMessageCount();
  /** @type {string[]} */
  const output = [];
  /**
   * One entry per distinct `{{payment._row}}` the scope ever held, in the
   * order it held them: `{ row, keys, values }`. `keys` is the record's
   * property bindings IN SCOPE ORDER, which is what the Variables view lists.
   */
  const passes = [];

  const drain = () => {
    const msgs = hooks.hostMessagesSince(mark);
    mark += msgs.length;
    for (const m of msgs) {
      if (m.type === 'runEvent' && m.event?.type === 'output') output.push(m.event.msg);
    }
    try {
      const scope = hooks.runningScope() ?? {};
      const row = scope['payment._row'];
      if (row !== undefined && passes[passes.length - 1]?.row !== row) {
        passes.push({
          row,
          keys: Object.keys(scope).filter((k) => k.startsWith('payment.')),
          values: Object.fromEntries(
            Object.entries(scope).filter(([k]) => k === 'payment' || k.startsWith('payment.')),
          ),
        });
      }
    } catch {
      /* no run in flight */
    }
  };

  const timer = setInterval(drain, 250);
  return {
    output,
    passes,
    drain,
    stop() {
      clearInterval(timer);
      drain();
    },
  };
}

// The fixture's main-flow steps, each pinned to a fragment of its own text.
const PAYMENT_STEPS = [
  ['navigate', 'scheduled-payments.html'],
  ['readTable', 'store as: payments'],
  ['forEach', 'For each {{payment}} in {{payments}}'],
  ['verifyFive', '5 payments'],
];
const PAYMENT_SECTIONS = { 'Review the payment': 5 };
const SECTION = 'Review the payment';

/** The fixture page's five rows, which every expectation below is read from.
 *  Origin Energy twice, at different amounts, is the whole point. */
const ROWS = [
  { row: 1, payee: 'Origin Energy', amount: '$140.00', status: 'Scheduled' },
  { row: 2, payee: 'Netflix Australia', amount: '$22.99', status: 'Scheduled' },
  { row: 3, payee: 'Origin Energy', amount: '$86.10', status: 'Paused' },
  { row: 4, payee: 'Sydney Water', amount: '$210.45', status: 'Overdue' },
  { row: 5, payee: 'Woolworths', amount: '$87.40', status: 'Scheduled' },
];
/** The pass the body's `If … then return` ends early. */
const RETURNING_PASS = 4;
/** The `readTable` summary line, §7.6, for this read: 5 rows, 3 columns.
 *  Unanchored, so a log prefix cannot turn a real line into a missing one;
 *  the numbers and the destination are what is being pinned. */
const SUMMARY_LINE = /readTable captured 5 rows × 3 columns as "\{\{payments\}\}"/;

// ===========================================================================
// table-payments-review.md — five records, five passes, two Origin Energys
// ===========================================================================
describe('Steptix live — table read: one pass per row, each on its own row', function () {
  this.timeout(900_000);

  let hooks;
  let workspaceRoot;
  let uri;
  let fixture;

  before(async function () {
    this.timeout(60_000);
    hooks = await activate();
    workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — the live runner must pass templates/');
    const opened = await openTestFile(hooks, workspaceRoot, 'table-payments-review.md');
    uri = opened.uri;
    fixture = resolveFixture(opened.file, PAYMENT_STEPS, PAYMENT_SECTIONS);
    await vscode.commands.executeCommand('steptix.clearStatuses');
    hooks.clearRunError?.();
  });

  after(async () => {
    try {
      await vscode.commands.executeCommand('steptix.stop');
      await vscode.commands.executeCommand('steptix.restartSession');
    } catch {
      /* teardown is best-effort */
    }
  });

  it('reads five records and drives five passes, each verifying its own row', async function () {
    // Four main steps plus five passes of up to five body steps, every one of
    // them a model call against a real page. Budgeted like control-flow.md.
    this.timeout(900_000);

    const before = new Set(reportsIn(workspaceRoot));
    const tap = startRunTap(hooks);

    // `stop()` in a finally: a `waitFor` that times out throws, and an
    // interval nobody cleared goes on polling `runningScope()` for the rest
    // of the mocha process — through every later file's run, which is both
    // noise and a hold on the extension host.
    try {
      say('Run All on table-payments-review.md — readTable, then For each over the records');
      void vscode.commands.executeCommand('steptix.runAll');
      await waitFor('run started', () => hooks.isRunning(), 60_000);
      await waitFor('run finished', () => hooks.isRunning() === false, 880_000);
    } finally {
      tap.stop();
    }

    // -------------------------------------------------------------------
    // 1. The run passed, and every main-flow line painted.
    // -------------------------------------------------------------------
    const done = hooks.lastDoneStatus();
    say(`done status: ${done}`);
    say(`run error: ${JSON.stringify(hooks.lastRunError?.() ?? null)}`);
    const mainLines = Object.values(fixture.step);
    assert.equal(
      done,
      'passed',
      `table-payments-review.md must pass end to end; got '${done}'. ` +
        `Statuses: ${JSON.stringify(statusesOn(hooks, uri, mainLines))}`,
    );
    const mainMarks = statusesOn(hooks, uri, mainLines);
    say(
      `main-flow marks: ${JSON.stringify(
        Object.fromEntries(Object.keys(fixture.step).map((k, i) => [k, mainMarks[i]])),
      )}`,
    );
    Object.keys(fixture.step).forEach((key, i) => {
      assert.ok(
        passed(mainMarks[i]),
        `step "${key}" (line ${fixture.step[key]}) must pass; got '${mainMarks[i]}'. ` +
          `Instruction: ${fixture.text[key]}`,
      );
    });

    // -------------------------------------------------------------------
    // 2. The read itself: one readTable, five rows, three columns.
    //
    // §7.6 logs a summary rather than the data, so this line is the only
    // place a run says how much it captured — and a run that fell back to a
    // flat plural read would not write it at all.
    // -------------------------------------------------------------------
    const summary = tap.output.find((l) => SUMMARY_LINE.test(l));
    say(`readTable lines: ${JSON.stringify(tap.output.filter((l) => /readTable|row record/.test(l)))}`);
    assert.ok(
      summary,
      `expected a line matching ${SUMMARY_LINE} — the read must capture five rows and ` +
        `three columns as {{payments}}. Output lines mentioning a capture:\n` +
        tap.output.filter((l) => /captur|record|Stored/i.test(l)).join('\n'),
    );

    // -------------------------------------------------------------------
    // 3. The report: five passes of the body, banded 1..5.
    // -------------------------------------------------------------------
    const written = reportsIn(workspaceRoot).filter((f) => !before.has(f));
    assert.equal(
      written.length,
      1,
      `the run must write exactly one report; got ${JSON.stringify(written)}`,
    );
    const reportPath = hooks.lastReportPath();
    assert.ok(reportPath && fs.existsSync(reportPath), `report must exist: ${reportPath}`);
    const html = fs.readFileSync(reportPath, 'utf8');
    const steps = reportSteps(html);
    const bands = reportBands(html);
    say(`report: ${reportPath}`);
    say(
      `report step rows (${steps.length}):\n${steps
        .map((s) => `  ${s.number} [${s.status}]${s.sectionChip ? ` <${s.sectionChip}>` : ''} ${s.instruction}`)
        .join('\n')}`,
    );
    say(`report bands:\n${bands.map((b) => `  ${b.lead}${Object.keys(b.values).length ? ` {${JSON.stringify(b.values)}}` : ''}`).join('\n')}`);

    const passRows = rowsByPass(steps, SECTION);
    const passIndices = [...passRows.keys()].sort((a, b) => a - b);
    say(`passes in the report: ${JSON.stringify(passIndices)}`);
    assert.deepEqual(
      passIndices,
      [1, 2, 3, 4, 5],
      `the loop must run once per captured record (5); got ${JSON.stringify(passIndices)}`,
    );

    const paymentBands = bands.filter((b) => b.label === SECTION);
    const bandIndices = [...new Set(paymentBands.map((b) => b.index))].sort((a, b) => a - b);
    const bandCounts = [...new Set(paymentBands.map((b) => b.count))];
    say(`bands for "${SECTION}": indices ${JSON.stringify(bandIndices)}, counts ${JSON.stringify(bandCounts)}`);
    assert.deepEqual(
      bandIndices,
      [1, 2, 3, 4, 5],
      `the report must band all five passes; got ${JSON.stringify(bandIndices)}`,
    );
    assert.deepEqual(
      bandCounts,
      ['5'],
      `a For each knows its count from the start, so every band must read "of 5"; ` +
        `got ${JSON.stringify(bandCounts)}`,
    );

    // -------------------------------------------------------------------
    // 4. The Variables scope: the record's properties, `_row` first, in the
    //    order the read asked for its columns.
    //
    // Sampled from the running scope — the surface the Variables view
    // renders — and corroborated by the loop bands' own binding list, which
    // survives in the report. Either is evidence; both are printed so a
    // failure says which surface had them.
    // -------------------------------------------------------------------
    const EXPECTED_KEYS = [
      'payment._row',
      'payment.payee',
      'payment.amount',
      'payment.status',
    ];
    const scopeOrders = tap.passes.map((p) => p.keys);
    // One entry per pass, in pass order — keyed by the band's own index so a
    // repeated band cannot lengthen the list and change what is compared.
    const bandOrders = bandIndices.map((index) =>
      Object.keys(paymentBands.find((b) => b.index === index)?.values ?? {}).filter((k) =>
        k.startsWith('payment.'),
      ),
    );
    say(`scope passes sampled: ${JSON.stringify(tap.passes.map((p) => ({ row: p.row, keys: p.keys })))}`);
    say(`band binding keys: ${JSON.stringify(bandOrders)}`);

    // The two surfaces are asserted SEPARATELY, and neither may stand in for
    // the other. Taking `scope || bands` let the report's own bands satisfy a
    // check about the live scope, and every per-pass assertion below iterates
    // `tap.passes` — so a `frame:scope` that carried no dotted binding at all
    // sampled nothing, looped zero times, and passed.
    assert.deepEqual(
      bandOrders,
      [EXPECTED_KEYS, EXPECTED_KEYS, EXPECTED_KEYS, EXPECTED_KEYS, EXPECTED_KEYS],
      `every loop band must record the record's property bindings with _row first and the ` +
        `columns in the order the read named them; got ${JSON.stringify(bandOrders)}`,
    );

    // The live scope, which is what the Variables view renders. Sampling is a
    // 250 ms poll, so this asks for the four passes that RUN a body step —
    // each of them several model calls against a real page, seconds long. The
    // returning pass is exempt by construction: its `If … then return` is
    // decided from the values with no model call (§8.3a), so the whole pass
    // can open and close inside one poll interval. It is still asserted on
    // below if it was caught.
    const sampledRows = tap.passes.map((p) => Number(p.row));
    const mustSample = ROWS.map((r) => r.row).filter((r) => r !== RETURNING_PASS);
    assert.deepEqual(
      sampledRows.filter((r) => r !== RETURNING_PASS),
      mustSample,
      `the Variables scope must show every pass that runs a body step ` +
        `(${JSON.stringify(mustSample)}); sampled ${JSON.stringify(sampledRows)}. ` +
        `An empty list means frame:scope carried no "payment._row" at all.`,
    );
    for (const keys of scopeOrders) {
      assert.deepEqual(
        keys,
        EXPECTED_KEYS,
        `every pass must bind the record's properties with _row first and the columns ` +
          `in the order the read named them; got ${JSON.stringify(keys)}`,
      );
    }
    // The rows arrive in DOM order, and a poll can miss a pass but never
    // reorder one — so what was sampled must be an ascending subsequence.
    say(`rows seen in the Variables scope: ${JSON.stringify(sampledRows)}`);
    for (let i = 1; i < sampledRows.length; i++) {
      assert.ok(
        sampledRows[i] > sampledRows[i - 1],
        `the Variables scope showed rows ${JSON.stringify(sampledRows)} — out of order`,
      );
    }
    // And the values it showed belong to the row it said it was on.
    for (const seen of tap.passes) {
      const expected = ROWS[Number(seen.row) - 1];
      assert.ok(expected, `the scope claimed row ${seen.row}, which the fixture does not have`);
      assert.equal(
        seen.values['payment.payee'],
        expected.payee,
        `row ${seen.row} must bind payee ${expected.payee}; got ${seen.values['payment.payee']}`,
      );
      assert.equal(
        seen.values['payment.amount'],
        expected.amount,
        `row ${seen.row} must bind amount ${expected.amount}; got ${seen.values['payment.amount']}`,
      );
    }

    // -------------------------------------------------------------------
    // 5. The returning pass ends at its first step, and the rest of its body
    //    paints as a not-taken skip.
    //
    // A blank row and a skipped row look identical to anything that counts
    // events, which is why this asserts the WORD.
    // -------------------------------------------------------------------
    const bodyCount = fixture.bodyTexts(SECTION).length;
    const returning = passRows.get(RETURNING_PASS);
    say(
      `pass ${RETURNING_PASS} rows: ${JSON.stringify(
        returning.map((r) => [r.status, r.instruction]),
      )}`,
    );
    assert.equal(
      returning.length,
      bodyCount,
      `the report must carry all ${bodyCount} rows of the returning pass, skips included; ` +
        `got ${returning.length}`,
    );
    assert.equal(
      returning[0].status,
      'PASSED',
      `the "If … then return" step of pass ${RETURNING_PASS} (${ROWS[RETURNING_PASS - 1].status}) ` +
        `must pass — it is the step that decides; got ${returning[0].status}`,
    );
    for (const row of returning.slice(1)) {
      assert.equal(
        row.status,
        'SKIPPED',
        `everything after the return in pass ${RETURNING_PASS} must read SKIPPED: ` +
          `"${row.instruction}" is ${row.status}`,
      );
    }

    // -------------------------------------------------------------------
    // 6. THE assertion this fixture exists for: every other pass reaches its
    //    details-page verify, and the two Origin Energy passes verify
    //    DIFFERENT amounts. A run that opened row 1 twice passes everything
    //    above and fails here.
    // -------------------------------------------------------------------
    const authoredVerify = fixture.bodyTexts(SECTION).find((t) => t.includes('{{payment.amount}}'));
    assert.ok(
      authoredVerify,
      `the body must verify {{payment.amount}} on the details page; body reads: ` +
        JSON.stringify(fixture.bodyTexts(SECTION)),
    );
    // The row is located by the authored text's fixed prefix, because the
    // report prints the SUBSTITUTED instruction — which is exactly what makes
    // the amount readable off it.
    const verifyPrefix = authoredVerify.slice(0, authoredVerify.indexOf('{{'));

    /** @type {Record<number, string>} */
    const verified = {};
    for (const expected of ROWS) {
      if (expected.row === RETURNING_PASS) continue;
      const rows = passRows.get(expected.row);
      const verify = rows.find((r) => r.instruction.startsWith(verifyPrefix));
      assert.ok(
        verify,
        `pass ${expected.row} must reach the details-page verify. Its rows: ` +
          JSON.stringify(rows.map((r) => [r.status, r.instruction])),
      );
      assert.equal(
        verify.status,
        'PASSED',
        `pass ${expected.row}'s details-page verify must pass; got ${verify.status} ` +
          `on "${verify.instruction}"`,
      );
      assert.ok(
        verify.instruction.includes(expected.payee) && verify.instruction.includes(expected.amount),
        `pass ${expected.row} must verify ${expected.payee} at ${expected.amount}; the step ` +
          `the model was given reads "${verify.instruction}"`,
      );
      verified[expected.row] = verify.instruction;
    }
    say(`details verifies: ${JSON.stringify(verified, null, 1)}`);

    // Said again, on its own, because it is the finding the baseline made:
    // both Origin Energy passes ran, and they were not the same page.
    const origin = ROWS.filter((r) => r.payee === 'Origin Energy').map((r) => r.row);
    assert.equal(origin.length, 2, 'the fixture must still list Origin Energy twice');
    assert.notEqual(
      verified[origin[0]],
      verified[origin[1]],
      `the two Origin Energy passes verified the same thing — the loop opened one row ` +
        `twice. Row ${origin[0]}: "${verified[origin[0]]}"; row ${origin[1]}: ` +
        `"${verified[origin[1]]}"`,
    );
    assert.ok(
      verified[origin[0]].includes(ROWS[origin[0] - 1].amount) &&
        verified[origin[1]].includes(ROWS[origin[1] - 1].amount),
      `each Origin Energy pass must carry its own amount ` +
        `(${ROWS[origin[0] - 1].amount} then ${ROWS[origin[1] - 1].amount}); got ` +
        `${JSON.stringify([verified[origin[0]], verified[origin[1]]])}`,
    );
  });
});

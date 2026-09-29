/**
 * Live end-to-end test for control flow — decisions and loops
 * (stories/control-flow.md).
 *
 * The vitest layer already pins the halves that can be pinned in isolation:
 * `control-line.ts` parses the six forms, the expander emits control records
 * with the right index ranges, and `control-flow.ts` is a pure planner with
 * its own unit suite. None of that touches a page. What only a live run can
 * say is whether the *decision* and the *re-entry* survive the whole chain:
 *
 *   real editor -> real RunController -> real ApiClient -> real api-server
 *     -> real judge call against a real page -> real planner
 *       -> real frame + step events -> real ActiveFileTracker statuses
 *         -> the HTML report an author actually reads
 *
 * Three claims live here and nowhere else:
 *
 *  - a chain really does run exactly one member, and the other member's guard
 *    AND its whole section paint SKIPPED rather than staying blank (a blank
 *    line and a skipped line look the same to every in-process test that
 *    only counts events);
 *  - a loop really does re-enter by jumping back — the same body line runs
 *    three times, three loop bands reach the report, and the unknown
 *    `iterationCount` of a `While` is back-filled to 3 by the time the report
 *    is rendered;
 *  - `For each` really binds its item to what a read captured off the page,
 *    in order, and the bound value reaches the step the model performs.
 *
 * The fixture page (fixtures/test-app/control-flow.html) is built so every
 * count is deterministic: Cash is ticked on load, Next disables on page 4,
 * Load more removes itself on its third click, three accounts are listed. A
 * failure here is a regression, not a flaky page — see
 * templates/init/tests/control-flow.md for the reasoning in full.
 *
 * Prereq: the API server on $LIVE_SERVER_URL (the parallel runner starts one
 * per shard and points that shard's templates/.env at it) and the fixture app
 * on :8787 (runLiveTest.cjs boots it).
 *
 * Run just this file:
 *   cd steptix-vscode
 *   npm run test:live -- --files=control-flow.test.cjs
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
 * alone means the evidence — which lines painted what, which bands the report
 * carried, what `{{account}}` was bound to — exists only while the run is
 * failing. `STEPTIX_LIVE_LOG` is the file the extension's OutputChannel is
 * teed to, and it survives the run. (Borrowed verbatim from
 * data-rows.test.cjs, for the same reason.)
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
  // Shown, not just opened: `vscode.open` can return before the editor has
  // focus, so the activeTextEditor wait below raced its budget under load.
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
// Reading the fixture's own line numbers.
//
// Hardcoding them is what makes a test like this rot into a silent no-op: one
// line of prose above `## Steps` shifts every constant onto a DIFFERENT step
// that also passes, and the run goes green with the branch assertions — the
// whole point of the file — never evaluated. So the lines are derived, and
// each one is pinned to a fragment of its own text: a step that is reworded
// fails here by name rather than drifting onto its neighbour.
// (The convention is store-as-two-breakpoints.test.cjs's `resolveSteps`.)
// ---------------------------------------------------------------------------
function resolveFixture(testFile, expectedSteps, expectedSections) {
  const lines = fs.readFileSync(testFile, 'utf8').split(/\r?\n/);

  const stepsHeading = lines.findIndex((l) => /^##\s+Steps\s*$/.test(l));
  assert.ok(stepsHeading >= 0, `${path.basename(testFile)} has no "## Steps" heading`);

  /** @type {Array<{ line: number; n: number; text: string }>} */
  const main = [];
  /** @type {Record<string, { heading: number; body: Array<{ line: number; text: string }> }>} */
  const sections = {};
  let current = null; // null while still in the main flow

  for (let i = stepsHeading + 1; i < lines.length; i++) {
    const heading = /^###\s+(.+?)\s*$/.exec(lines[i]);
    if (heading) {
      current = { name: heading[1], heading: i + 1, body: [] };
      sections[current.name] = { heading: current.heading, body: current.body };
      continue;
    }
    if (/^##\s+/.test(lines[i])) {
      // A later `## ` heading (an appended run-history block, say) ends the
      // steps region.
      break;
    }
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

  /** @type {Record<string, number>} */
  const step = {};
  /** @type {Record<string, string>} */
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
    /** The body lines of a section, in order. */
    bodyLines: (name) => sections[name].body.map((b) => b.line),
    /** The body texts of a section, in order (as authored). */
    bodyTexts: (name) => sections[name].body.map((b) => b.text),
  };
}

// ---------------------------------------------------------------------------
// Reading the report.
//
// The report is the surface data-rows.test.cjs already asserts loop bands on,
// and it is the only one that survives the run: statuses are per-line and
// therefore lossy when a line runs three times, and the panel's Output buffer
// is bounded. So the pass COUNTS are read from the report's step rows, which
// carry one row per execution.
// ---------------------------------------------------------------------------
function decodeHtml(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Every rendered step row: its number label, the instruction as the report
 * prints it (SUBSTITUTED — session-manager stamps the interpolated text, per
 * stories/placeholder-preserving-actions.md decision 9), its section chip and
 * its status word.
 *
 * The status badge is the LAST badge in a step header, immediately before the
 * chevron, which is what makes this parse stable against new badges appearing
 * to its left.
 */
function reportSteps(html) {
  const out = [];
  const re =
    /<span class="step-number">([^<]*)<\/span>\s*<span class="step-instruction">([^<]*)<\/span>([\s\S]*?)<span class="step-chevron">/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    // `[^>]*` after the class list, because most badges carry a `title`, and
    // a class LIST because some carry two classes (`badge-tab
    // badge-tab-unexpected`). Both would otherwise silently match nothing,
    // which reads as "the step had no section chip" rather than as a parse
    // bug.
    const badges = [...m[3].matchAll(/<span class="badge ([a-z][\w -]*?)"[^>]*>([^<]*)<\/span>/g)].map(
      (b) => ({ classes: b[1].trim().split(/\s+/), text: decodeHtml(b[2]) }),
    );
    // The status badge is the last one in the header, immediately before the
    // chevron — that is what keeps this stable when a new badge appears.
    const statusBadge = badges[badges.length - 1];
    const sectionBadge = badges.find((b) => b.classes.includes('badge-section'));
    out.push({
      number: decodeHtml(m[1]),
      instruction: decodeHtml(m[2]),
      // `✓ PASSED` / `— SKIPPED` / `✗ FAILED` -> the word.
      status: statusBadge ? statusBadge.text.replace(/[^A-Z]/g, '') : '(no status badge)',
      // `Check the account (2/3)` -> `Check the account`; the suffix is the
      // iteration numbering, kept separately below.
      section: sectionBadge ? sectionBadge.text.replace(/\s*\(\d+\/\S*\)\s*$/, '') : null,
      sectionChip: sectionBadge ? sectionBadge.text : null,
    });
  }
  return out;
}

/**
 * Every loop band, as `{ lead, label, index, count, values }`.
 *
 * `renderLoopBand` writes `<label> — iteration <n> of <m>` for a
 * `kind: 'iteration'` marker, which is what a control-flow loop emits; the
 * label is the section's name for a section tail and the tail's own text
 * otherwise (`loopLabel`, src/skills/expander.ts).
 */
function reportBands(html) {
  const out = [];
  const re =
    /<span class="loop-band-lead">([^<]*)<\/span>\s*(?:<span class="loop-band-values">([^<]*)<\/span>)?/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const lead = decodeHtml(m[1]);
    const parsed = /^(.*) — iteration (\d+) of (\S+)$/.exec(lead);
    /** @type {Record<string, string>} */
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

// ---------------------------------------------------------------------------
// Watching the run while it runs.
//
// Two things are only true DURING the run and gone by the end of it: the
// panel's Output lines (the host retains the last 2000 messages, and a debug
// run posts far more), and the frame stack, whose `iteration` /
// `iterationCount` are what Steptix's own labels render. Both are sampled on
// one timer.
// ---------------------------------------------------------------------------
function startRunTap(hooks) {
  let mark = hooks.hostMessageCount();
  /** @type {string[]} */
  const output = [];
  /** @type {Map<string, { label: string; iteration: number; count: number | undefined }>} */
  const frames = new Map();
  /** @type {string[]} */
  const scopeAccounts = [];

  const drain = () => {
    const msgs = hooks.hostMessagesSince(mark);
    mark += msgs.length;
    for (const m of msgs) {
      if (m.type === 'runEvent' && m.event?.type === 'output') output.push(m.event.msg);
    }
    // The live `(3/?)` claim: a loop pass clones the tail's frames and stamps
    // `iteration`, and `iterationCount` is UNKNOWN while a While or Repeat is
    // still running (stories/control-flow.md, "Painting, frames and the
    // report"). Sampling is the only way to see either — both are gone once
    // the frame pops.
    try {
      for (const f of hooks.runningFrameStack()) {
        if (f.iteration === undefined) continue;
        const key = `${f.skillName ?? f.kind}#${f.iteration}/${f.iterationCount ?? '?'}`;
        if (!frames.has(key)) {
          frames.set(key, {
            label: f.skillName ?? f.kind,
            iteration: f.iteration,
            count: f.iterationCount,
          });
        }
      }
    } catch {
      /* no run in flight */
    }
    // `For each` binds its item into the pass's scope, which is what the
    // Variables view renders. Recorded in order of first appearance.
    try {
      const value = (hooks.runningScope() ?? {})['account'];
      if (value !== undefined && scopeAccounts[scopeAccounts.length - 1] !== value) {
        scopeAccounts.push(value);
      }
    } catch {
      /* no run in flight */
    }
  };

  const timer = setInterval(drain, 250);
  return {
    output,
    frames,
    scopeAccounts,
    drain,
    stop() {
      clearInterval(timer);
      drain();
    },
  };
}

// The fixture's main-flow steps, each pinned to a fragment of its own text.
const CONTROL_FLOW_STEPS = [
  ['navigate', 'control-flow.html'],
  ['ifCash', 'If the Cash checkbox is ticked, then Pay with cash'],
  ['otherwise', 'Otherwise, Pay by card'],
  ['verifyCash', 'Paid in cash'],
  ['whileNext', 'While the Next button is enabled'],
  ['verifyPage4', 'Page 4 of 4'],
  ['repeatLoadMore', 'Repeat Click Load more until'],
  ['verifyAlerts', 'All alerts loaded'],
  ['countAlerts', 'store as: alert_count'],
  ['assertEight', 'equals 8'],
  ['readAccounts', 'store as: accounts'],
  ['forEachAccount', 'For each {{account}} in {{accounts}}'],
  ['verifyThree', 'exactly 3 accounts'],
];
const CONTROL_FLOW_SECTIONS = {
  'Pay with cash': 2,
  'Pay by card': 4,
  'Go to the next page': 1,
  'Check the account': 1,
};

// ===========================================================================
// control-flow.md — the If is taken, and all three loops run three passes
// ===========================================================================
describe('Steptix live — control flow: one branch taken, three loops', function () {
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
    const opened = await openTestFile(hooks, workspaceRoot, 'control-flow.md');
    uri = opened.uri;
    fixture = resolveFixture(opened.file, CONTROL_FLOW_STEPS, CONTROL_FLOW_SECTIONS);
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

  it('takes the If, skips the Otherwise and its whole section, and loops three times each', async function () {
    // 13 main steps, one two-step section, nine loop-body passes and a judge
    // call per chain and per loop evaluation. Comparable to the five-row
    // matrix run, which is budgeted the same.
    this.timeout(900_000);

    const before = new Set(reportsIn(workspaceRoot));
    const tap = startRunTap(hooks);

    say('Run All on control-flow.md — one chain, While, Repeat, For each');
    void vscode.commands.executeCommand('steptix.runAll');
    await waitFor('run started', () => hooks.isRunning(), 60_000);
    await waitFor('run finished', () => hooks.isRunning() === false, 880_000);
    tap.stop();

    // -------------------------------------------------------------------
    // 1. The run passed.
    // -------------------------------------------------------------------
    const done = hooks.lastDoneStatus();
    say(`done status: ${done}`);
    say(`run error: ${JSON.stringify(hooks.lastRunError?.() ?? null)}`);
    assert.equal(
      done,
      'passed',
      `control-flow.md must pass end to end; got '${done}'. ` +
        `Statuses: ${JSON.stringify(statusesOn(hooks, uri, Object.values(fixture.step)))}`,
    );

    // -------------------------------------------------------------------
    // 2. The chain: the taken guard paints, the untaken one and its whole
    //    section paint skipped.
    //
    // A skipped line and a line that never ran look identical to anything
    // that only counts events, which is why this asserts the WORD 'skip'
    // rather than "not passed".
    // -------------------------------------------------------------------
    const payByCardBody = fixture.bodyLines('Pay by card');
    const payWithCashBody = fixture.bodyLines('Pay with cash');
    const chainLines = [
      fixture.step.ifCash,
      fixture.step.otherwise,
      ...payWithCashBody,
      ...payByCardBody,
    ];
    const chainMarks = statusesOn(hooks, uri, chainLines);
    say(`chain lines ${JSON.stringify(chainLines)} -> ${JSON.stringify(chainMarks)}`);

    assert.ok(
      passed(chainMarks[0]),
      `the taken guard (line ${fixture.step.ifCash}) must paint passed; got '${chainMarks[0]}'`,
    );
    // TODO(run): if this reads `null` rather than 'skip', the runtime is not
    // emitting a result for a skipped step at all — decide there whether the
    // fix is server-side (emit skipped results, per decision 13) or whether
    // this suite should assert "not passed" instead. A blank line is NOT the
    // behaviour the story promises: the author has to be able to read which
    // way the decision went off the editor.
    assert.equal(
      chainMarks[1],
      'skip',
      `the untaken guard (line ${fixture.step.otherwise}, "Otherwise, Pay by card") ` +
        `must paint skipped; got '${chainMarks[1]}'`,
    );
    for (const [i, line] of payWithCashBody.entries()) {
      const mark = chainMarks[2 + i];
      assert.ok(
        passed(mark),
        `"Pay with cash" body line ${line} must paint passed; got '${mark}'`,
      );
    }
    for (const [i, line] of payByCardBody.entries()) {
      const mark = chainMarks[2 + payWithCashBody.length + i];
      assert.equal(
        mark,
        'skip',
        `"Pay by card" body line ${line} must paint skipped — the section was never ` +
          `entered; got '${mark}'`,
      );
    }

    // -------------------------------------------------------------------
    // 3. Every other authored line passed, including the three guards.
    //
    // A loop that exits on its own condition PASSES its guard line (it
    // decided); only a cap breach fails it. Note the Repeat guard shares its
    // line with its plain-instruction tail — the expander gives a tail the
    // guard's origin — so line `repeatLoadMore` carries both the guard's
    // marks and the tail's.
    // -------------------------------------------------------------------
    const ordinary = [
      'navigate',
      'verifyCash',
      'whileNext',
      'verifyPage4',
      'repeatLoadMore',
      'verifyAlerts',
      'countAlerts',
      'assertEight',
      'readAccounts',
      'forEachAccount',
      'verifyThree',
    ];
    const ordinaryMarks = statusesOn(hooks, uri, ordinary.map((k) => fixture.step[k]));
    say(`main-flow marks: ${JSON.stringify(Object.fromEntries(ordinary.map((k, i) => [k, ordinaryMarks[i]])))}`);
    ordinary.forEach((key, i) => {
      assert.ok(
        passed(ordinaryMarks[i]),
        `step "${key}" (line ${fixture.step[key]}) must pass; got '${ordinaryMarks[i]}'. ` +
          `Instruction: ${fixture.text[key]}`,
      );
    });
    // Step 10 is the arithmetic evidence the Repeat really looped: two alerts
    // on load plus two per click, three times.
    assert.ok(
      passed(ordinaryMarks[ordinary.indexOf('assertEight')]),
      'step 10 asserts 8 alerts — it is what makes "the Repeat ran three times" a fact ' +
        'about the page rather than about the runner',
    );
    // And the loop bodies themselves painted, on their own body lines.
    const nextPageLine = fixture.bodyLines('Go to the next page')[0];
    const checkAccountLine = fixture.bodyLines('Check the account')[0];
    const bodyMarks = statusesOn(hooks, uri, [nextPageLine, checkAccountLine]);
    say(`loop body lines [${nextPageLine}, ${checkAccountLine}] -> ${JSON.stringify(bodyMarks)}`);
    assert.ok(
      passed(bodyMarks[0]),
      `"Go to the next page" body line ${nextPageLine} must paint passed after its last ` +
        `pass; got '${bodyMarks[0]}'`,
    );
    assert.ok(
      passed(bodyMarks[1]),
      `"Check the account" body line ${checkAccountLine} must paint passed after its last ` +
        `pass; got '${bodyMarks[1]}'`,
    );

    // -------------------------------------------------------------------
    // 4. The report — one row per execution, which is what makes the pass
    //    counts observable at all. A per-line status cannot say "three".
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
    say(`report step rows (${steps.length}):\n${steps
      .map((s) => `  ${s.number} [${s.status}]${s.sectionChip ? ` <${s.sectionChip}>` : ''} ${s.instruction}`)
      .join('\n')}`);
    say(`report bands:\n${bands.map((b) => `  ${b.lead}${Object.keys(b.values).length ? ` {${JSON.stringify(b.values)}}` : ''}`).join('\n')}`);

    // 4a. The untaken tail's rows are all there, and all skipped (decision
    //     13: "Reports show every row of an untaken tail as skipped").
    const payByCardRows = steps.filter((s) => s.section === 'Pay by card');
    assert.equal(
      payByCardRows.length,
      payByCardBody.length,
      `the report must carry all ${payByCardBody.length} rows of the untaken "Pay by card" ` +
        `section; got ${payByCardRows.length}`,
    );
    for (const row of payByCardRows) {
      assert.equal(
        row.status,
        'SKIPPED',
        `an untaken tail's row must read SKIPPED: ${row.number} "${row.instruction}" is ${row.status}`,
      );
    }
    // …and so is the guard that was not selected.
    const otherwiseRow = steps.find((s) => s.instruction === fixture.text.otherwise);
    assert.ok(otherwiseRow, `the report must carry a row for "${fixture.text.otherwise}"`);
    assert.equal(
      otherwiseRow.status,
      'SKIPPED',
      `the untaken guard's row must read SKIPPED; got ${otherwiseRow.status}`,
    );
    // The taken section's rows passed, which is the other half of "exactly
    // one member ran".
    const payWithCashRows = steps.filter((s) => s.section === 'Pay with cash');
    assert.equal(payWithCashRows.length, payWithCashBody.length, 'the taken section ran in full');
    for (const row of payWithCashRows) {
      assert.equal(
        row.status,
        'PASSED',
        `the taken section's row "${row.instruction}" must read PASSED; got ${row.status}`,
      );
    }

    // 4b. THE loop assertion: three executions of each loop body.
    //
    // Counted on the body's own instruction rather than on bands, because a
    // band is one presentation of the marker while a row is the execution
    // itself. The `While` tail is a section, so its rows carry the section
    // chip; the `Repeat` tail is a plain instruction, so its rows read
    // exactly the tail text — and the guard row, which CONTAINS that text,
    // is excluded by the equality.
    const nextPageText = fixture.bodyTexts('Go to the next page')[0];
    const whilePasses = steps.filter((s) => s.instruction === nextPageText);
    say(`"${nextPageText}" ran ${whilePasses.length} time(s)`);
    assert.equal(
      whilePasses.length,
      3,
      `the While body must run exactly 3 times (Next disables on page 4 of 4); ` +
        `got ${whilePasses.length}`,
    );

    // The Repeat's tail, taken from the guard line itself: `Repeat <tail>
    // until <condition>, up to N times`.
    const repeatTail = /^Repeat\s+(.*?)\s+until\s/i.exec(fixture.text.repeatLoadMore)?.[1];
    assert.ok(repeatTail, `could not read the Repeat tail from: ${fixture.text.repeatLoadMore}`);
    const repeatPasses = steps.filter((s) => s.instruction === repeatTail);
    say(`"${repeatTail}" ran ${repeatPasses.length} time(s)`);
    assert.equal(
      repeatPasses.length,
      3,
      `the Repeat tail must run exactly 3 times (Load more removes itself on its third ` +
        `click); got ${repeatPasses.length}`,
    );

    const forEachRows = steps.filter((s) => s.section === 'Check the account');
    say(`"Check the account" ran ${forEachRows.length} time(s)`);

    // The guards' own rows. Reported, not asserted: the story says a loop's
    // guard "gets one result per evaluation, each carrying the pass's loop
    // marker, so the cost of the decisions is visible in the report", which
    // for this fixture means the While guard is evaluated FOUR times (true on
    // pages 1-3, false on page 4) while the body ran three.
    // TODO(run): if the counts below read 4 / 3 / 1, that is the story's
    // shape and worth asserting outright. If a guard has a single row, the
    // decisions' cost is invisible in the report and that is a finding.
    for (const key of ['whileNext', 'repeatLoadMore', 'forEachAccount']) {
      const guardRows = steps.filter((s) => s.instruction === fixture.text[key]);
      say(
        `guard "${fixture.text[key]}" has ${guardRows.length} report row(s): ` +
          `${JSON.stringify(guardRows.map((r) => r.status))}`,
      );
    }
    assert.equal(
      forEachRows.length,
      3,
      `the For each body must run once per captured account (3); got ${forEachRows.length}`,
    );

    // 4c. The bands, and the back-fill. `iterationCount` is unknown while a
    //     While or Repeat runs; the server back-fills `count` on every marker
    //     when the loop ends, so the RENDERED report must read "of 3" and
    //     never "of ?" or "of undefined".
    //
    // TODO(run): the labels below are what `loopLabel` (src/skills/expander.ts)
    // produces today — the section's name for a section tail, the tail's own
    // text otherwise. If the runtime labels a plain-instruction tail
    // differently, fix the expectation here rather than loosening it: the
    // label is what an author reads in the report and in the frame.
    const byLabel = new Map();
    for (const band of bands) {
      if (!band.label) continue;
      if (!byLabel.has(band.label)) byLabel.set(band.label, []);
      byLabel.get(band.label).push(band);
    }
    for (const label of ['Go to the next page', repeatTail, 'Check the account']) {
      const group = byLabel.get(label) ?? [];
      const indices = [...new Set(group.map((b) => b.index))].sort((a, b) => a - b);
      const counts = [...new Set(group.map((b) => b.count))];
      say(`bands for "${label}": indices ${JSON.stringify(indices)}, counts ${JSON.stringify(counts)}`);
      assert.deepEqual(
        indices,
        [1, 2, 3],
        `the report must band passes 1, 2 and 3 of "${label}"; got ${JSON.stringify(indices)}. ` +
          `All bands: ${JSON.stringify(bands.map((b) => b.lead))}`,
      );
      assert.deepEqual(
        counts,
        ['3'],
        `every band of "${label}" must read "of 3" once the loop has ended — an unknown ` +
          `count is back-filled when the loop ends; got ${JSON.stringify(counts)}`,
      );
    }

    // -------------------------------------------------------------------
    // 5. `For each` bound {{account}} to what the read captured, in order.
    //
    // Read off the step rows: the server stamps the SUBSTITUTED instruction,
    // so the body step that says `... a row for "{{account}}" ...` when
    // authored reads `... a row for "Everyday" ...` when run. That is the
    // strongest available evidence, because it is the text the model was
    // actually given.
    //
    // TODO(run): if the rows still carry the literal `{{account}}` (a
    // placeholder-preserving choice for loop bodies), switch the primary
    // assertion to the band values — which the planner already supplies as
    // `bindings` — and keep this as the corroboration. Both are printed
    // above, so the failure message says which surface had the values.
    // -------------------------------------------------------------------
    const authoredCheck = fixture.bodyTexts('Check the account')[0];
    const [prefix, suffix] = authoredCheck.split('{{account}}');
    assert.ok(
      suffix !== undefined,
      `"Check the account" must interpolate {{account}}; reads: ${authoredCheck}`,
    );
    const boundFromRows = forEachRows
      .filter((s) => s.instruction.startsWith(prefix) && s.instruction.endsWith(suffix))
      .map((s) => s.instruction.slice(prefix.length, s.instruction.length - suffix.length));
    const boundFromBands = (byLabel.get('Check the account') ?? [])
      .sort((a, b) => a.index - b.index)
      .map((b) => b.values['account'])
      .filter((v) => v !== undefined);
    say(`bindings from step rows: ${JSON.stringify(boundFromRows)}`);
    say(`bindings from loop bands: ${JSON.stringify(boundFromBands)}`);
    say(`bindings seen in the Variables scope while running: ${JSON.stringify(tap.scopeAccounts)}`);

    const bound = boundFromRows.length === 3 ? boundFromRows : boundFromBands;
    assert.deepEqual(
      bound,
      ['Everyday', 'Savings', 'Travel'],
      `{{account}} must bind to the three account names read off the page, in order. ` +
        `Rows: ${JSON.stringify(boundFromRows)}; bands: ${JSON.stringify(boundFromBands)}; ` +
        `scope: ${JSON.stringify(tap.scopeAccounts)}`,
    );
    // The Variables view is the surface an author watches mid-run, and it is
    // fed by frame:scope rather than by the report. Anything it showed must
    // be one of the three, in order — a subsequence, because a poll can miss
    // a pass, never reorder one.
    if (tap.scopeAccounts.length > 0) {
      const order = ['Everyday', 'Savings', 'Travel'];
      let at = -1;
      for (const seen of tap.scopeAccounts) {
        const next = order.indexOf(seen, at + 1);
        assert.ok(
          next > at,
          `the Variables scope showed ${JSON.stringify(tap.scopeAccounts)} — out of order ` +
            `against ${JSON.stringify(order)}`,
        );
        at = next;
      }
    }

    // -------------------------------------------------------------------
    // 6. The live frame labels: a pass really is a fresh frame stamped with
    //    its iteration, which is what Steptix's `Name (3/?)` renders from.
    //    Sampled, so it is evidence of re-entry rather than an exact count —
    //    the exact counts are asserted from the report above.
    // -------------------------------------------------------------------
    const sampled = [...tap.frames.values()];
    say(`loop frames sampled while running: ${JSON.stringify([...tap.frames.keys()])}`);
    // TODO(run): this asserts only that SOME pass after the first was
    // observed live. If the runtime stamps `iteration` on a loop pass's
    // frames (stories/control-flow.md says it does, reusing rows part B),
    // tighten this to the full set {1,2,3} per label. If it does not stamp
    // it at all, that is a finding about the frame model, not about this
    // test — say so rather than deleting the assertion.
    assert.ok(
      sampled.some((f) => f.iteration >= 2),
      `no loop frame with iteration >= 2 was ever observed live. Sampled: ` +
        `${JSON.stringify([...tap.frames.keys()])}`,
    );
    // TODO(run): the story says `iterationCount` is ABSENT while a While or
    // Repeat is running and back-filled only in the report — so at least one
    // sampled While/Repeat frame should have carried no count. Asserting it
    // would race the sampler (a 250 ms poll can miss a two-second pass), so
    // it is reported rather than asserted. If the sampled keys below all show
    // a number, either the count is being invented early or the sampler only
    // caught the For each; check which before believing the story is wrong.
    say(
      `frames without a known count: ${JSON.stringify(
        sampled.filter((f) => f.count === undefined).map((f) => `${f.label}#${f.iteration}`),
      )}`,
    );

    // Output is diagnostics, not an assertion surface here: `logger.step` does
    // not go through the log callback, so the per-step lines never reach the
    // panel, and whether a loop announces its passes the way a data row's
    // banner does is the runtime's choice.
    // TODO(run): if the runtime emits a per-pass banner (the `Row N of M`
    // equivalent), add the assertion here — data-rows.test.cjs is the shape.
    const loopish = tap.output.filter((l) => /iteration|pass \d|loop/i.test(l));
    say(`output lines mentioning a loop (${loopish.length}):\n${loopish.slice(0, 40).join('\n')}`);
  });
});

// ===========================================================================
// control-flow.md — a breakpoint inside the While tail fires on every pass
// ===========================================================================
//
// "A breakpoint on a body line fires on every pass" is a one-sentence promise
// in the story and the only one of its claims that a completed run cannot
// show: the marks a finished loop leaves are the same whether it paused three
// times or none. The scenario is deliberately short — two pauses is the
// smallest number that can tell "pauses once, at the first pass" apart from
// "pauses on every pass" — and it stops rather than running the file out.
describe('Steptix live — control flow: a breakpoint inside a loop body', function () {
  this.timeout(600_000);

  let hooks;
  let workspaceRoot;
  let uri;
  let fixture;

  before(async function () {
    this.timeout(60_000);
    hooks = await activate();
    workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — the live runner must pass templates/');
    const opened = await openTestFile(hooks, workspaceRoot, 'control-flow.md');
    uri = opened.uri;
    fixture = resolveFixture(opened.file, CONTROL_FLOW_STEPS, CONTROL_FLOW_SECTIONS);
    await vscode.commands.executeCommand('steptix.clearStatuses');
  });

  after(async () => {
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }
    // In `after()`, not at the end of the `it`, so it runs when an assertion
    // throws too — that is the case that matters. The workspace config is
    // headed, so a session left parked at a breakpoint is a real Chrome
    // window competing for the foreground with cdp-tab-focus.
    try {
      await vscode.commands.executeCommand('steptix.stop');
    } catch {
      /* nothing running */
    }
    try {
      await vscode.commands.executeCommand('steptix.restartSession');
    } catch {
      /* no session to close */
    }
  });

  it('pauses on the body line again after Continue — once per pass, not once per loop', async function () {
    this.timeout(600_000);

    const bodyLine = fixture.bodyLines('Go to the next page')[0];
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(bodyLine - 1, 0)),
        true,
      ),
    ]);

    say(`breakpoint on the While tail's body line ${bodyLine} ("${fixture.bodyTexts('Go to the next page')[0]}")`);
    void vscode.commands.executeCommand('steptix.runAll');
    await waitFor('run started', () => hooks.isRunning(), 60_000);

    // Pause 1. Everything before it — navigate, the chain decision, the two
    // steps of Pay with cash, the verify, the While guard — has to run first,
    // so the budget is most of a short run.
    await waitFor(
      `paused at the body line ${bodyLine} on the first pass`,
      () => hooks.tracker.snapshot().breakpointStop === bodyLine,
      420_000,
    );
    // NOT `!hooks.isRunning()`. This breakpoint sits on a SECTION-BODY line
    // ("Go to the next page" is the While tail), which is invisible to the
    // client's own `trimAtBreakpoint` — only a root-frame test-file line is
    // the client's responsibility (session-manager.ts, the "Server-side
    // breakpoint check" comment). A section-body pause is the SERVER holding
    // the HTTP connection open on `pendingRunControl`, so `isRunning()` (===
    // `this.active !== null`, i.e. "is there an open request") stays TRUE
    // the whole time it is parked — commands/index.ts's `continueRun` says so
    // explicitly: "The controller's `isRunning` is still true in this state
    // (SSE stream is open, just blocked on a Promise)." Measured: the first
    // live run timed out here after 30s with the breakpoint correctly hit
    // (event step:awaiting line=65 in the run log) — `isRunning()` never
    // went false because it was never supposed to. `isStepPaused()` is the
    // hook that actually flips for this pause kind (set in the same
    // `step:awaiting` handler that sets `breakpointStop`, extension.ts).
    await waitFor('parked (step-paused) the first time', () => hooks.isStepPaused(), 30_000);
    say(`pause 1 at line ${hooks.tracker.snapshot().breakpointStop}`);

    // Continue. The pass completes, the guard is re-evaluated (the page is on
    // 2 of 4, so Next is still enabled), and the body runs again — which must
    // hit the same breakpoint.
    //
    // TODO(run): the story documents that a run RESUMED inside a loop body
    // restarts the pass number at 1, "because the count lived in the batch
    // that was paused". That is about the label, not about whether the pause
    // happens; if the second pause never arrives, the question to ask is
    // whether the resume re-entered the loop at all, not whether the
    // breakpoint painted.
    void vscode.commands.executeCommand('steptix.continueRun');
    await waitFor('running again after Continue', () => hooks.isRunning(), 30_000);
    await waitFor(
      'the parked marker clears on resume',
      () => hooks.tracker.snapshot().breakpointStop == null,
      30_000,
    );
    await waitFor(
      `paused at the body line ${bodyLine} a SECOND time`,
      () => hooks.tracker.snapshot().breakpointStop === bodyLine,
      420_000,
    );
    // Same fix as pause 1, same reason: a section-body pause never clears
    // `isRunning()`.
    await waitFor('parked (step-paused) the second time', () => hooks.isStepPaused(), 30_000);
    say(`pause 2 at line ${hooks.tracker.snapshot().breakpointStop}`);

    // The assertion is the two waits above completing: a breakpoint on a loop
    // body fired on more than one pass. Stated once more as a value so the
    // failure message is about the claim rather than about a timeout.
    assert.equal(
      hooks.tracker.snapshot().breakpointStop,
      bodyLine,
      'the second pause must be on the same body line — one breakpoint, two passes',
    );

    // Stop here rather than running the file out: the remaining steps are
    // real AI turns on behaviour two other scenarios already cover.
    await vscode.commands.executeCommand('steptix.stop');
    await waitFor('stopped', () => !hooks.isRunning(), 30_000);
  });
});

// ===========================================================================
// control-flow-otherwise.md — the same chain, falling through to Otherwise
// ===========================================================================
//
// The companion fixture unticks Cash first, so the same three-member chain
// ends on its last member. Read beside the scenario above, it is what proves
// the decision is a decision: the two sections swap which one paints skipped,
// with nothing else about the files changed.
const OTHERWISE_STEPS = [
  ['navigate', 'control-flow.html'],
  ['untickCash', 'Untick the Cash checkbox'],
  ['ifCash', 'If the Cash checkbox is ticked, then Pay with cash'],
  ['elseIfPayNow', 'Else if the Pay now button is enabled, then Click Pay now'],
  ['otherwise', 'Otherwise, Pay by card'],
  ['verifyCard', 'Paid by card'],
];
const OTHERWISE_SECTIONS = {
  'Pay with cash': 2,
  'Pay by card': 4,
};

describe('Steptix live — control flow: the branch nobody took', function () {
  this.timeout(600_000);

  let hooks;
  let workspaceRoot;
  let uri;
  let fixture;

  before(async function () {
    this.timeout(60_000);
    hooks = await activate();
    workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — the live runner must pass templates/');
    const opened = await openTestFile(hooks, workspaceRoot, 'control-flow-otherwise.md');
    uri = opened.uri;
    fixture = resolveFixture(opened.file, OTHERWISE_STEPS, OTHERWISE_SECTIONS);
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

  it('falls through to Otherwise: both earlier members skip, Pay by card runs', async function () {
    this.timeout(540_000);

    const before = new Set(reportsIn(workspaceRoot));
    const tap = startRunTap(hooks);

    say('Run All on control-flow-otherwise.md — the chain falls through to its last member');
    void vscode.commands.executeCommand('steptix.runAll');
    await waitFor('run started', () => hooks.isRunning(), 60_000);
    await waitFor('run finished', () => hooks.isRunning() === false, 500_000);
    tap.stop();

    const done = hooks.lastDoneStatus();
    say(`done status: ${done}`);
    assert.equal(done, 'passed', `control-flow-otherwise.md must pass end to end; got '${done}'`);

    const payWithCashBody = fixture.bodyLines('Pay with cash');
    const payByCardBody = fixture.bodyLines('Pay by card');
    const lines = [
      fixture.step.navigate,
      fixture.step.untickCash,
      fixture.step.ifCash,
      fixture.step.elseIfPayNow,
      fixture.step.otherwise,
      fixture.step.verifyCard,
      ...payWithCashBody,
      ...payByCardBody,
    ];
    const marks = statusesOn(hooks, uri, lines);
    say(`lines ${JSON.stringify(lines)} -> ${JSON.stringify(marks)}`);

    assert.ok(passed(marks[0]), `step 1 must pass; got '${marks[0]}'`);
    assert.ok(passed(marks[1]), `step 2 (Untick Cash) must pass; got '${marks[1]}'`);
    // THE assertion, and the mirror image of the other fixture's: the `If`
    // is false because step 2 unticked Cash, and the `Else if` is false
    // because the page disables Pay now while neither method is chosen.
    assert.equal(
      marks[2],
      'skip',
      `the If (line ${fixture.step.ifCash}) must paint skipped — Cash was unticked; got '${marks[2]}'`,
    );
    assert.equal(
      marks[3],
      'skip',
      `the Else if (line ${fixture.step.elseIfPayNow}) must paint skipped — Pay now is ` +
        `disabled with neither method chosen; got '${marks[3]}'. ` +
        `Note its tail is a plain instruction, which the expander gives the guard's own line, ` +
        `so a stray pass here would mean the tail ran.`,
    );
    assert.ok(
      passed(marks[4]),
      `the Otherwise (line ${fixture.step.otherwise}) is the taken member and must paint ` +
        `passed; got '${marks[4]}'`,
    );
    assert.ok(passed(marks[5]), `the closing verify must pass; got '${marks[5]}'`);

    for (const [i, line] of payWithCashBody.entries()) {
      const mark = marks[6 + i];
      assert.equal(
        mark,
        'skip',
        `"Pay with cash" body line ${line} must paint skipped in this file; got '${mark}'`,
      );
    }
    for (const [i, line] of payByCardBody.entries()) {
      const mark = marks[6 + payWithCashBody.length + i];
      assert.ok(
        passed(mark),
        `"Pay by card" body line ${line} must paint passed in this file — it is the taken ` +
          `tail; got '${mark}'`,
      );
    }

    // The report says the same, and says it about the OTHER section than the
    // first fixture's report did. Two files, one chain, the skip swaps over.
    const written = reportsIn(workspaceRoot).filter((f) => !before.has(f));
    assert.equal(written.length, 1, `expected one new report, got ${JSON.stringify(written)}`);
    const reportPath = hooks.lastReportPath();
    assert.ok(reportPath && fs.existsSync(reportPath), `report must exist: ${reportPath}`);
    const steps = reportSteps(fs.readFileSync(reportPath, 'utf8'));
    say(`report step rows (${steps.length}):\n${steps
      .map((s) => `  ${s.number} [${s.status}]${s.sectionChip ? ` <${s.sectionChip}>` : ''} ${s.instruction}`)
      .join('\n')}`);

    const cashRows = steps.filter((s) => s.section === 'Pay with cash');
    assert.equal(
      cashRows.length,
      payWithCashBody.length,
      `the report must carry all ${payWithCashBody.length} rows of the untaken ` +
        `"Pay with cash" section; got ${cashRows.length}`,
    );
    for (const row of cashRows) {
      assert.equal(row.status, 'SKIPPED', `"${row.instruction}" must read SKIPPED`);
    }
    const cardRows = steps.filter((s) => s.section === 'Pay by card');
    assert.equal(cardRows.length, payByCardBody.length, 'the taken section ran in full');
    for (const row of cardRows) {
      assert.equal(row.status, 'PASSED', `"${row.instruction}" must read PASSED`);
    }
    // Both earlier guards are rows of their own, and both are skipped.
    for (const key of ['ifCash', 'elseIfPayNow']) {
      const row = steps.find((s) => s.instruction === fixture.text[key]);
      assert.ok(row, `the report must carry a row for "${fixture.text[key]}"`);
      assert.equal(
        row.status,
        'SKIPPED',
        `the untaken guard "${fixture.text[key]}" must read SKIPPED; got ${row.status}`,
      );
    }
  });
});

/**
 * Live end-to-end test for the three failure outcomes
 * (stories/step-failure-outcomes.md, decisions 4, 5 and 6): one real AI run of
 * the ten-step fixture, in which step 6's `otherwise fail … with message` tail
 * PASSES (the model never sees it), step 7's `otherwise continue with warning`
 * fails AMBER and the run goes on, and step 9's `fail the test with error` ends
 * the run in the author's words. A feature that tolerated everything, or
 * nothing, passes some of that and fails the rest. Target: `fixtures/test-app`
 * on :8787, whose page title is a literal in the repo.
 *
 * Run it alone with:
 *   cd steptix-vscode
 *   npm run test:live -- --files=failure-outcomes.test.cjs
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = 'pkent.steptix-vscode';
const TEST_APP_PORT = 8787;

// templates/init/tests/failure-outcomes-live.md. Line numbers are hardcoded —
// the tracker and the run log key on LINE, not step number — and PINNED to the
// file by `pinFixture` below, which is the only reason hardcoding is safe here.
const STEPS = [
  { n: 1, line: 23, text: '1. Navigate to the baseUrl' },
  { n: 2, line: 24, text: '2. Reject non-essential cookies in the cookie banner' },
  { n: 3, line: 25, text: '3. Enter the username {{username}}' },
  { n: 4, line: 26, text: '4. Enter the password {{password}}' },
  { n: 5, line: 27, text: '5. Click the Sign in button' },
  {
    n: 6,
    line: 28,
    text:
      '6. Verify the page title contains "Dashboard" otherwise fail the test ' +
      'with message "Sign in did not reach the dashboard"',
  },
  {
    n: 7,
    line: 29,
    text:
      '7. Verify the page title contains "Peanuts" otherwise continue with ' +
      'warning "No peanuts on the dashboard"',
  },
  { n: 8, line: 30, text: '8. Set {{a}} to "peanuts"' },
  {
    n: 9,
    line: 31,
    text:
      '9. If {{a}} is "peanuts" then fail the test with error "The variable ' +
      'value was peanuts. Expected apples"',
  },
  { n: 10, line: 32, text: '10. Click "Sign out"' },
];

/** The line a 1-based step number sits on. */
const lineOf = (n) => STEPS[n - 1].line;

/** The author's sentence on step 9 — the error the run must end with. */
const DELIBERATE_ERROR = 'The variable value was peanuts. Expected apples';
/** The warning on step 7: it leads the run log's `⚠ … — continuing:` line and the
 *  report row's explanation, with the framework's error after it (decision 6). */
const TOLERATED_WARNING = 'No peanuts on the dashboard';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Say what was observed, into the shard's own log as well as stdout — the parallel
 *  runner discards a passing launch's stdout, so only the tee survives the run.
 *  (Borrowed verbatim from flow-control.test.cjs / control-flow.test.cjs.) */
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

/** Any flavour of pass: a compiled entry paints `</>` and a stale one ⚠, and
 *  which one a run produces is not what this suite is about.
 *  (flow-control.test.cjs's `isPass`, spelled as control-flow.test.cjs's set.) */
const PASSED = new Set(['pass', 'pass-code-behind', 'pass-stale']);
const passed = (status) => PASSED.has(status);

async function up(url) {
  try {
    const res = await fetch(url);
    return res.status > 0;
  } catch {
    return false;
  }
}

/** The extension's output channel, teed to a file by the live runner. */
function readLiveLog() {
  const file = process.env.STEPTIX_LIVE_LOG;
  if (!file || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf-8');
}

function decodeHtml(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** The report header's summary bar, as `{ Steps, Passed, Failed, Tolerated, … }`.
 *  `Skipped` and `Tolerated` are `{{#if}}`-guarded, so an ABSENT key is itself the
 *  answer: the count was zero or the server never set it (src/report/template.ts). */
function reportStats(html) {
  /** @type {Record<string, number>} */
  const out = {};
  const re = /<span class="number[^"]*">(\d+)<\/span>\s*<span class="label">([^<]+)<\/span>/g;
  let m;
  while ((m = re.exec(html)) !== null) out[m[2].trim()] = Number(m[1]);
  return out;
}

/** Every rendered step row: number label, instruction as the report prints it, and
 *  status WORD. The status badge is the LAST badge before the chevron, which keeps
 *  the parse stable as badges are added (control-flow.test.cjs), and the instruction
 *  is the SUBSTITUTED text — so rows are matched below on fragments that survive
 *  substitution, never on a `{{placeholder}}`. */
function reportSteps(html) {
  const out = [];
  const re =
    /<span class="step-number">([^<]*)<\/span>\s*<span class="step-instruction">([^<]*)<\/span>([\s\S]*?)<span class="step-chevron">/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const badges = [
      ...m[3].matchAll(/<span class="badge ([a-z][\w -]*?)"[^>]*>([^<]*)<\/span>/g),
    ].map((b) => ({ classes: b[1].trim().split(/\s+/), text: decodeHtml(b[2]) }));
    const statusBadge = badges[badges.length - 1];
    out.push({
      number: decodeHtml(m[1]),
      instruction: decodeHtml(m[2]),
      // `✓ PASSED` / `✗ TOLERATED` / `✗ FAILED` -> the word.
      status: statusBadge ? statusBadge.text.replace(/[^A-Z]/g, '') : '(no status badge)',
    });
  }
  return out;
}

/** Pin the constants above to the fixture on disk. Exact equality, not a fragment
 *  match: a reworded step fails HERE, by name, rather than drifting onto its
 *  neighbour and quietly passing. */
function pinFixture(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const s of STEPS) {
    assert.equal(
      lines[s.line - 1],
      s.text,
      `failure-outcomes-live.md line ${s.line} should be step ${s.n} — ` +
        `expected "${s.text}", found "${lines[s.line - 1]}". The line numbers in ` +
        `this test are what the tracker and the run log are keyed by; if the ` +
        `fixture moved, move them deliberately.`,
    );
  }
}

describe('Steptix live — failure outcomes: a tail that does nothing, one that tolerates, one that fails', function () {
  // One AI run of ten steps: step 7 spends its retries failing on purpose, the two
  // model-judged conditions are a turn each, and steps 8-9 need no model call.
  this.timeout(900_000);

  /** @type {import('../../../dist/extension/extension').SteptixTestHooks} */
  let hooks;
  /** @type {import('node:child_process').ChildProcess | null} */
  let testApp = null;
  let startedApp = false;
  let workspaceRoot;
  let testFile;
  let uri;

  before(async function () {
    this.timeout(120_000);

    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks missing — activation may have failed');

    const serverUrl = process.env.LIVE_STEPTIX_SERVER_URL || 'http://localhost:3100';
    try {
      const res = await fetch(`${serverUrl}/sessions/healthcheck/steps`, { method: 'OPTIONS' });
      assert.ok(
        res.status === 204 || res.status === 200,
        `Server at ${serverUrl} not responding (status=${res.status})`,
      );
    } catch (err) {
      throw new Error(
        `Live test requires the API server running at ${serverUrl}. ` +
          `Start it with \`node dist/index.js serve -p <port>\`. ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // The target site. `runLiveTest.cjs` boots it for every shard, so this is
    // normally an adoption; nothing already serving :8787 is killed either way.
    const appUrl = `http://localhost:${TEST_APP_PORT}/`;
    if (!(await up(appUrl))) {
      const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
      testApp = cp.spawn('npx tsx fixtures/test-app/server.ts', [], {
        cwd: repoRoot,
        env: { ...process.env, PORT: String(TEST_APP_PORT) },
        stdio: ['ignore', 'ignore', 'inherit'],
        shell: true,
      });
      startedApp = true;
      await waitFor('fixtures/test-app listening', () => up(appUrl), 60_000);
      say(`started fixtures/test-app on ${appUrl}`);
    } else {
      say(`reusing the fixtures/test-app already on ${appUrl}`);
    }

    workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — the live runner must pass templates/');
    testFile = path.resolve(workspaceRoot, 'init', 'tests', 'failure-outcomes-live.md');
    assert.ok(fs.existsSync(testFile), `failure-outcomes-live.md not found at ${testFile}`);
    pinFixture(testFile);
  });

  after(async () => {
    try {
      await vscode.commands.executeCommand('steptix.stop');
      await vscode.commands.executeCommand('steptix.restartSession');
    } catch {
      /* teardown is best-effort */
    }
    if (startedApp && testApp) {
      try {
        cp.execSync(`taskkill /pid ${testApp.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        testApp.kill();
      }
    }
  });

  it('passes the renamed check, tolerates the failed one, and fails the run in the author’s words', async function () {
    this.timeout(900_000);

    // Shown, not just opened: `vscode.open` can return before the editor has focus,
    // and the activeTextEditor wait then races its budget under load.
    uri = vscode.Uri.file(testFile);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
      preview: false,
    });
    await waitFor(
      'failure-outcomes-live.md becomes the active editor',
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      15_000,
    );
    await waitFor(
      'tracker recognises the test file',
      () => hooks.tracker.snapshot().isTestFile === true,
      15_000,
    );
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }
    // Step 10 having NO status is a claim below, so nothing from an earlier paint
    // may be left on line 32 to be mistaken for one.
    await vscode.commands.executeCommand('steptix.clearStatuses');
    hooks.clearRunError?.();

    // A fresh browser: step 5 clicks Sign in, and a dashboard left over from another
    // test in this shard would leave nothing to click.
    await vscode.commands.executeCommand('steptix.restartSession');
    await sleep(1_000);

    const logBefore = readLiveLog()?.length ?? 0;

    say('running failure-outcomes-live.md');
    void vscode.commands.executeCommand('steptix.runAll');
    await waitFor('run started', () => hooks.isRunning(), 60_000);
    await waitFor('run finished', () => hooks.isRunning() === false, 880_000);

    const snapshot = hooks.tracker.snapshotFor(uri) ?? hooks.tracker.snapshot();
    const statuses = Object.fromEntries(snapshot.statuses);
    const failures = Object.fromEntries(snapshot.failures);

    // Every observed status, by name, so a PASSING run also leaves the evidence.
    for (const s of STEPS) {
      say(
        `step ${s.n} (line ${s.line}) -> ${statuses[s.line] ?? '(no status)'}` +
          (failures[s.line] ? `  error: ${JSON.stringify(failures[s.line].error)}` : ''),
      );
    }
    say(`done status: ${hooks.lastDoneStatus()}`);
    say(`run error: ${JSON.stringify(hooks.lastRunError?.() ?? null)}`);

    // ── Steps 1-6 and 8 ran and passed ───────────────────────────────────
    //
    // A green step 6 is the only live proof the tail was invisible to the model AND
    // did nothing on a pass (decisions 4 and 5). Step 8 is a `Set` dispatched with
    // no model call, asserted through the pass SET anyway because the claim is that
    // it ran AFTER the tolerated failure, not how it was served.
    for (const n of [1, 2, 3, 4, 5, 6, 8]) {
      const line = lineOf(n);
      assert.ok(
        passed(statuses[line]),
        `step ${n} (line ${line}) must pass; got "${statuses[line]}". ` +
          (n === 6
            ? `Step 6's tail renames a failure that must not happen — a red here ` +
              `with "Sign in did not reach the dashboard" on it means the model ` +
              `was shown the tail and answered \`fail\` (decision 4).`
            : n === 8
              ? `Step 8 runs only if the run CONTINUED past the tolerated failure ` +
                `on step 7 — a blank here is the tail failing to tolerate.`
              : `Statuses: ${JSON.stringify(statuses)}`),
      );
    }

    // ── THE assertion: step 7 is amber, and the run went on ──────────────
    //
    // Decision 6: `fail-tolerated` is its own status — never green (the step did not
    // do what it said) and never `fail` (the run is not red for it).
    assert.equal(
      statuses[lineOf(7)],
      'fail-tolerated',
      `step 7 (line ${lineOf(7)}) verifies the page title contains "Peanuts" against ` +
        `a page titled "SecureBank — Dashboard", so it MUST fail — and its ` +
        `\`otherwise continue\` tail must make that failure amber, not red. Got ` +
        `"${statuses[lineOf(7)]}".`,
    );

    // ── Step 9 fails the run, in the author's words ──────────────────────
    //
    // An ordinary red ✗ — what `deliberate` buys is the log line, not a colour.
    assert.equal(
      statuses[lineOf(9)],
      'fail',
      `step 9 (line ${lineOf(9)}) says to fail, so it is an ordinary ✗ — not amber. ` +
        `Got "${statuses[lineOf(9)]}".`,
    );
    assert.equal(
      failures[lineOf(9)]?.error,
      DELIBERATE_ERROR,
      `the hover on step 9 must lead with the AUTHOR's sentence, verbatim and ` +
        `with {{a}} resolved by the loop before the executor saw it. Got ` +
        `${JSON.stringify(failures[lineOf(9)])}.`,
    );

    // ── Step 10 never started ────────────────────────────────────────────
    //
    // Blank, not ◌: a failure ends the run where it stands, it does not
    // skip-with-reason the way step-flow-control's `return` does.
    assert.equal(
      statuses[lineOf(10)],
      undefined,
      `step 10 (line ${lineOf(10)}) must carry NO status — the run ended at step 9. ` +
        `Got "${statuses[lineOf(10)]}"; 'skip' would mean a failure is being ` +
        `reported as a skipped flow, and any pass means the run did not stop.`,
    );

    // ── The run is FAILED, and for step 9's reason ───────────────────────
    //
    // The compensating pair to the amber above. `done.status` is the server's
    // computed verdict; the client agrees with it rather than deriving its own.
    assert.equal(
      hooks.lastDoneStatus(),
      'failed',
      `the run must end failed — step 9 asked for it. A 'passed' here means the ` +
        `deliberate failure was swallowed along with the tolerated one.`,
    );

    // ── The run log says which kind of failure each one was ──────────────
    const log = readLiveLog();
    if (log !== null) {
      const thisRun = log.slice(logBefore);

      // The tolerated line. `— continuing:` is the point of the wording
      // (failure-outcome-core.ts): without it a reader who has just seen a failure
      // must scroll on to discover the run did not stop. The author's WARNING leads
      // it and the framework's error follows in brackets — decision 6's new field.
      assert.match(
        thisRun,
        new RegExp(
          `⚠ step ${lineOf(7)} failed — continuing: ` +
            `${TOLERATED_WARNING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(\\S`,
        ),
        `the run log's tolerated line must lead with the author's warning and ` +
          `keep the framework's error after it; got:\n${thisRun}`,
      );
      assert.ok(
        !new RegExp(`✗ step ${lineOf(7)} failed:`).test(thisRun),
        `step 7 must NOT also log the ordinary red line — that is what the log ` +
          `says when the \`tolerated\` boolean never arrived.`,
      );

      // The deliberate line. `as written` is the difference: the text after the
      // colon is the author's own sentence, not a framework diagnostic.
      assert.match(
        thisRun,
        new RegExp(
          `✗ step ${lineOf(9)} failed as written: ` +
            DELIBERATE_ERROR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        ),
        `the run log must say step 9's failure was asked for, and quote the ` +
          `author verbatim; got:\n${thisRun}`,
      );

      // The closing tally counts the tolerated failure apart from the passes; the
      // parenthesis is optional because a compiled entry would add `(7 code-behind)`.
      assert.match(
        thisRun,
        /✓ 7 passed[^\n]*, 1 tolerated/,
        `the run log's tally must count the tolerated failure apart from both ` +
          `neighbours; got:\n${thisRun}`,
      );
    }

    // ── The report: 7 passed, 1 failed, 1 tolerated ──────────────────────
    //
    // The one surface that survives the run, and the warning's durable copy.
    const reportPath = hooks.lastReportPath();
    assert.ok(
      reportPath && fs.existsSync(reportPath),
      `the run must write a report; got ${JSON.stringify(reportPath)}`,
    );
    const html = fs.readFileSync(reportPath, 'utf8');
    const stats = reportStats(html);
    const rows = reportSteps(html);
    say(`report: ${reportPath}`);
    say(`report header: ${JSON.stringify(stats)}`);
    say(
      `report step rows (${rows.length}):\n` +
        rows.map((r) => `  ${r.number} [${r.status}] ${r.instruction}`).join('\n'),
    );

    assert.equal(
      stats.Passed,
      7,
      `the header must count 7 passes — steps 1-6 and 8. Got ${stats.Passed}. ` +
        `An 8 here means the tolerated failure was folded into the passes, ` +
        `which paints a green count over work that did not happen.`,
    );
    assert.equal(
      stats.Failed,
      1,
      `the header must count exactly ONE failure — step 9. Got ${stats.Failed}. ` +
        `A 2 means the server's failedSteps filter did not widen to exclude a ` +
        `tolerated failure (decision 6).`,
    );
    assert.equal(
      stats.Tolerated,
      1,
      `the header must show 1 Tolerated. Got ${stats.Tolerated}; \`undefined\` ` +
        `means \`toleratedSteps\` never reached the report — the tile is ` +
        `{{#if}}-guarded, so an unset count renders as nothing at all rather ` +
        `than as a wrong number.`,
    );

    // And the two rows say it in their own words, matched on tail fragments that
    // survive the placeholder substitution the report's instruction line carries.
    const toleratedRow = rows.find((r) => r.instruction.includes('otherwise continue with warning'));
    assert.ok(toleratedRow, `the report must carry a row for step 7; rows: ${JSON.stringify(rows)}`);
    assert.equal(
      toleratedRow.status,
      'TOLERATED',
      `step 7's row must wear the amber TOLERATED badge, not FAILED and never ` +
        `PASSED. Got "${toleratedRow.status}".`,
    );

    const deliberateRow = rows.find((r) => r.instruction.includes('then fail the test with error'));
    assert.ok(deliberateRow, `the report must carry a row for step 9; rows: ${JSON.stringify(rows)}`);
    assert.equal(
      deliberateRow.status,
      'FAILED',
      `step 9's row is an ordinary failure. Got "${deliberateRow.status}".`,
    );

    // The blocks under those rows. `✗ Step failed — the run continued` stops a
    // reader wondering why a report with a ✗ in it is not red, and the warning is
    // the row's explanation.
    const text = decodeHtml(html);
    assert.ok(
      text.includes('✗ Step failed — the run continued'),
      `the report must title step 7's block for what happened to the RUN`,
    );
    assert.ok(
      text.includes(`${TOLERATED_WARNING}. The run continued past this step (otherwise continue).`),
      `the author's warning must be step 7's explanation — the durable copy of ` +
        `what \`step:fail.warning\` carries live (decision 6).`,
    );
    assert.ok(
      text.includes('✗ Failed by the step'),
      `step 9's block must be titled for a deliberate failure — "Step Failed" ` +
        `over the author's own sentence invites a hunt for a root cause they ` +
        `already wrote.`,
    );
    assert.ok(
      text.includes(DELIBERATE_ERROR),
      `and it must carry the author's message verbatim`,
    );
  });
});

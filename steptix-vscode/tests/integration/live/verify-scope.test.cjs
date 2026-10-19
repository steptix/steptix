/**
 * Live end-to-end coverage for WHERE a check reads, and WHAT it reads there.
 *
 * A check reads the part of the page its step names, and only what a person
 * sees there: not another row, not the page's script code, not hidden text
 * (docs/specs/SPEC-verify-checks.md, section 7). The five fixtures drive
 * `fixtures/test-app/card-orders.html`:
 *
 *   - verify-scope.md checks order 5127's status, a sentence whose order
 *     number sits in an element of its own, text typed into a box, a
 *     dropdown's chosen option, SVG text, and the chosen option on the whole
 *     page. Every step must pass.
 *   - verify-scope-order-status.md expects order 5126's status to say
 *     "Shipped". That row says "Pending"; two other rows say "Shipped". It
 *     MUST fail.
 *   - verify-scope-print-label.md expects the page to say "Label printed",
 *     words only a script inside the page's form holds. It MUST fail.
 *   - verify-scope-draft-message.md expects the draft status to say "Draft
 *     saved", words only that element, styled display: none, holds. It MUST
 *     fail.
 *   - verify-scope-courier.md expects the page to say "Collect in branch", a
 *     dropdown option nobody chose. It MUST fail.
 *
 * The must-fail fixtures also guard the retry (steptix/steptix#97): a failed
 * check is retried by running the same check again, its code and all, so the
 * text it expects must stay as the step writes it in every check the report
 * shows. New code is written for a re-check only when the old code found
 * nothing, broke, was written for a value read again since, or would change
 * the page (src/ai/check-retry.ts), and then carries the re-check's note.
 *
 * Prereq: Sessions API server running on $LIVE_STEPTIX_SERVER_URL (default
 * :3100), and fixtures/test-app on :8787 (runLiveTest.cjs boots it).
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');

const EXT_ID = 'pkent.steptix-vscode';
/** The re-check's note to its code AI, when it writes new code (`recheckNote`,
 *  src/ai/check-retry.ts). */
const RECHECK_NOTE = 'Write the code for this check again';
/** How the report labels the turn that runs a failed check again
 *  (`recheckResponse`, src/ai/check-retry.ts). */
const RECHECK_TURN = 'Checking again: ';
const TEST_APP_URL = 'http://127.0.0.1:8787';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every status the gutter treats as green: a run may replay a compiled
 *  entry (</>), and that is still a pass. */
const PASS_STATUSES = new Set(['pass', 'pass-code-behind', 'pass-stale']);

async function waitFor(label, predicate, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await predicate()) return; } catch { /* transient */ }
    await sleep(200);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

/** Line numbers of the `N. ` step lines in a fixture, 1-based, so an edit to
 *  the prose above the steps cannot leave this suite asserting about blank
 *  lines. */
function stepLines(file) {
  const out = [];
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((text, i) => {
    if (/^\d+\.\s+\S/.test(text)) out.push(i + 1);
  });
  return out;
}

function fixture(workspaceRoot, name) {
  const file = path.resolve(workspaceRoot, 'init', 'tests', name);
  assert.ok(fs.existsSync(file), `${name} not found at ${file}`);
  return file;
}

/** Open a fixture, run every step in it, and return the final line→status
 *  map with the report the run wrote. */
async function runWholeFile(hooks, file, { timeoutMs }) {
  const uri = vscode.Uri.file(file);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
  await waitFor(
    `${path.basename(file)} becomes active editor`,
    () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
  );
  await waitFor('tracker recognises test file', () => hooks.tracker.snapshot().isTestFile === true);

  const reportBefore = hooks.lastReportPath();
  void vscode.commands.executeCommand('steptix.runAll');
  await waitFor('run starts', () => hooks.isRunning(), 60_000);
  await waitFor('run finishes', () => !hooks.isRunning(), timeoutMs);

  const reportPath = hooks.lastReportPath();
  assert.ok(reportPath && reportPath !== reportBefore && fs.existsSync(reportPath), `the run must write a report: ${reportPath}`);
  return {
    statuses: Object.fromEntries(hooks.tracker.snapshot().statuses),
    html: fs.readFileSync(reportPath, 'utf8'),
    reportPath,
  };
}

/**
 * Every check's expected value, as the requests for its code in the report
 * show it — one per code request, a re-check's included when it wrote new
 * code. (A failed step's
 * report has no assertion rows; its checks are in these requests and in its
 * failure messages.)
 */
function expectedValues(html) {
  return [...html.matchAll(/## Assertion\n- Description: [^\n]*\n- Condition: [^\n]*\n- Expected: ([^\n]*)\n/g)].map((m) => m[1]);
}

describe('Steptix live — a check reads where its step says, as a person sees it', function () {
  this.timeout(900_000);

  /** @type {import('../../../dist/extension/extension').SteptixTestHooks} */
  let hooks;
  /** @type {string} */
  let workspaceRoot;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks missing — activation may have failed');

    workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — live runner must pass templates/');

    const serverUrl = process.env.LIVE_STEPTIX_SERVER_URL || 'http://localhost:3100';
    try {
      const res = await fetch(`${serverUrl}/sessions/healthcheck/steps`, { method: 'OPTIONS' });
      assert.ok(res.status === 204 || res.status === 200, `Server at ${serverUrl} not responding (status=${res.status})`);
    } catch (err) {
      throw new Error(
        `Live test requires the API server running at ${serverUrl}. ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // "The fixture app is down" or "it is a build without this page" should
    // report as itself, not as failed checks.
    try {
      const res = await fetch(`${TEST_APP_URL}/card-orders.html`);
      assert.equal(res.status, 200, `fixture app returned ${res.status} for /card-orders.html`);
      const html = await res.text();
      assert.ok(
        html.includes('<td>5126</td>') && html.includes('Label printed') && html.includes('>Draft saved<')
          && html.includes('>Collect in branch<'),
        '/card-orders.html served without its orders, script, hidden message or courier options — stale fixture app?',
      );
    } catch (err) {
      throw new Error(
        `Live check-scope tests need fixtures/test-app on ${TEST_APP_URL} (runLiveTest.cjs normally boots it). ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  afterEach(async () => {
    // A fresh browser per fixture, so none can pass on another's page.
    await vscode.commands.executeCommand('steptix.restartSession');
    await sleep(1_000);
  });

  it('passes checks of a row, a sentence, a typed value, a chosen option and SVG text', async () => {
    const file = fixture(workspaceRoot, 'verify-scope.md');
    const lines = stepLines(file);
    assert.equal(lines.length, 8, `expected 8 steps in verify-scope.md, found ${lines.length}`);

    const { statuses, html } = await runWholeFile(hooks, file, { timeoutMs: 300_000 });
    console.log('[live] verify-scope statuses:', statuses);
    // A pass on a re-check is still a pass, but it means a first check failed
    // and the page or a new selector then answered: worth seeing in the log.
    // Counted by the re-check's turn, and new code by the note it carries.
    console.log('[live] verify-scope re-checks:', html.split(RECHECK_TURN).length - 1,
      'with new code:', html.split(RECHECK_NOTE).length - 1);

    const bad = lines.filter((l) => !PASS_STATUSES.has(statuses[l]));
    assert.equal(
      bad.length, 0,
      `these step lines did not pass: ${bad.map((l) => `${l}=${statuses[l]}`).join(', ')}. ` +
        "Order 5127's row says \"Shipped\"; the delivery notice's paragraph holds the whole sentence; the box " +
        'holds what step 4 typed, in its value; the dropdown\'s chosen option is "Priority courier", on the ' +
        'page as in the dropdown; and the chart draws "Cards sent this week" as SVG text. Each is shown where ' +
        'its step says.',
    );
  });

  /**
   * Run a two-step fixture whose step 2 must fail, and check its retry asked
   * the same question: the re-check's turn is in the report, and every check
   * expected the text as the step writes it.
   */
  async function mustFail(name, expected, why) {
    const file = fixture(workspaceRoot, name);
    const lines = stepLines(file);
    assert.equal(lines.length, 2, `${name} should have exactly 2 steps`);
    const [navLine, verifyLine] = lines;

    const { statuses, html } = await runWholeFile(hooks, file, { timeoutMs: 300_000 });
    console.log(`[live] ${name} statuses:`, statuses);
    // What each check read, for whoever reads the log of a run that went
    // wrong: the failure lines name the text each check's code read.
    console.log(`[live] ${name} failures:`, [...new Set(html.match(/Assertion failed:[^<\n]*/g) ?? [])]);

    assert.ok(
      PASS_STATUSES.has(statuses[navLine]),
      `navigate (line ${navLine}) should pass, got '${statuses[navLine]}' — the fixture never reached the page, ` +
        'so the red below proves nothing',
    );
    assert.equal(statuses[verifyLine], 'fail', `line ${verifyLine} MUST fail: ${why}; got '${statuses[verifyLine]}'.`);
    assert.ok(
      html.includes(RECHECK_TURN),
      `the failed check was retried by running it again: the report has no "${RECHECK_TURN.trim()}" turn`,
    );
    // The re-check runs the first check's code again, asking for none, unless
    // it needs new code (found nothing, say, or broke): then its new code
    // carries the note.
    console.log(`[live] ${name} re-check wrote new code:`, html.includes(RECHECK_NOTE));
    const values = expectedValues(html);
    assert.ok(values.length >= 1, `the report shows no request for the check's code`);
    assert.deepEqual(
      [...new Set(values)], [expected],
      `every check must expect "${expected}" as the step writes it; the report shows ${JSON.stringify(values)}`,
    );
  }

  it("fails a status the step's row does not show, though other rows show it", async () => {
    await mustFail(
      'verify-scope-order-status.md',
      'Shipped',
      'order 5126\'s row says "Pending". Orders 5127 and 5128 say "Shipped", but the step asks about order 5126',
    );
  });

  it("fails words that only the page's script code holds", async () => {
    await mustFail(
      'verify-scope-print-label.md',
      'Label printed',
      'the page shows no "Label printed": the words are in a script inside its form, which shows them only ' +
        'after a click this test does not make',
    );
  });

  it('fails words that only hidden text holds', async () => {
    await mustFail(
      'verify-scope-draft-message.md',
      'Draft saved',
      'the page shows no "Draft saved": the words are in the draft status, an element styled display: none',
    );
  });

  it('fails a dropdown option nobody chose', async () => {
    await mustFail(
      'verify-scope-courier.md',
      'Collect in branch',
      'the courier dropdown shows its chosen option, "Priority courier"; "Collect in branch" is an option ' +
        'nobody chose, so the page does not show it',
    );
  });
});

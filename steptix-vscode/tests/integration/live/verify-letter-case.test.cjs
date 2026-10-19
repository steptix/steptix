/**
 * Live end-to-end coverage for LETTER CASE in checks.
 *
 * A check compares text in the letter case the step writes it, unless the
 * step says to ignore case — and the step's words, not the model's habits,
 * decide which. The three fixtures drive `fixtures/test-app/letter-case.html`,
 * which shows the status "Payment received" (small r) and the reference
 * "AB-1042" as their markup writes them, and the delivery method in capitals
 * where its markup writes "Express courier" (CSS text-transform):
 *
 *   - verify-letter-case.md checks the status exactly as shown, then in
 *     capitals "ignoring letter case", then the reference in small letters
 *     "in any letter case", then the delivery method in the capitals shown
 *     and as its markup writes it, saying nothing about case. Every step must
 *     pass.
 *   - verify-letter-case-strict.md checks "Payment Received" (capital R) and
 *     says nothing about case. It MUST fail.
 *   - verify-letter-case-transform-strict.md checks the delivery method as
 *     "Express Courier" — neither the case shown nor its markup's — and says
 *     nothing about case. It MUST fail: text CSS shows in another case
 *     matches in those two, not in any.
 *
 * The strict fixtures also guard the retry (steptix/steptix#97): a failed
 * check is retried by running the same check again, its code and all, so the
 * text it expects must stay as the step writes it in every check the report
 * shows. Before that, a retry could pass a check like these by expecting the
 * page's own casing instead (steptix/steptix#66).
 *
 * Prereq: Sessions API server running on $LIVE_STEPTIX_SERVER_URL (default
 * :3100), and fixtures/test-app on :8787 (runLiveTest.cjs boots it).
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');

const EXT_ID = 'pkent.steptix-vscode';
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

describe('Steptix live — letter case in checks', function () {
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
      const res = await fetch(`${TEST_APP_URL}/letter-case.html`);
      assert.equal(res.status, 200, `fixture app returned ${res.status} for /letter-case.html`);
      const html = await res.text();
      assert.ok(
        html.includes('>Payment received<') && html.includes('>Express courier<'),
        '/letter-case.html served without its status or delivery text — stale fixture app?',
      );
    } catch (err) {
      throw new Error(
        `Live letter-case tests need fixtures/test-app on ${TEST_APP_URL} (runLiveTest.cjs normally boots it). ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  afterEach(async () => {
    // A fresh browser per fixture, so neither can pass on the other's page.
    await vscode.commands.executeCommand('steptix.restartSession');
    await sleep(1_000);
  });

  it('passes the case written exactly, and any case when the step says to ignore it', async () => {
    const file = fixture(workspaceRoot, 'verify-letter-case.md');
    const lines = stepLines(file);
    assert.equal(lines.length, 6, `expected 6 steps in verify-letter-case.md, found ${lines.length}`);

    const { statuses, html } = await runWholeFile(hooks, file, { timeoutMs: 300_000 });
    console.log('[live] verify-letter-case statuses:', statuses);
    // A pass on a re-check is still a pass, but it means a first check failed
    // and the page or a new selector then answered: worth seeing in the log.
    // Counted by the re-check's turn.
    console.log('[live] verify-letter-case re-checks:', html.split(RECHECK_TURN).length - 1);

    const bad = lines.filter((l) => !PASS_STATUSES.has(statuses[l]));
    assert.equal(
      bad.length, 0,
      `these step lines did not pass: ${bad.map((l) => `${l}=${statuses[l]}`).join(', ')}. ` +
        'Step 2 matches the page exactly; steps 3 and 4 say to ignore letter case, so their capitals and ' +
        'small letters must not matter; steps 5 and 6 write the capitals the page shows (CSS text-transform) ' +
        'and the case its markup has, and both count as written.',
    );
  });

  it('fails a capital the page does not have, when the step says nothing about case', async () => {
    const file = fixture(workspaceRoot, 'verify-letter-case-strict.md');
    const lines = stepLines(file);
    assert.equal(lines.length, 2, 'verify-letter-case-strict.md should have exactly 2 steps');
    const [navLine, verifyLine] = lines;

    const { statuses, html } = await runWholeFile(hooks, file, { timeoutMs: 300_000 });
    console.log('[live] verify-letter-case-strict statuses:', statuses);

    assert.ok(
      PASS_STATUSES.has(statuses[navLine]),
      `navigate (line ${navLine}) should pass, got '${statuses[navLine]}' — the fixture never reached the page, ` +
        'so the red below proves nothing',
    );
    assert.equal(
      statuses[verifyLine], 'fail',
      `line ${verifyLine} expects "Payment Received" where the page shows "Payment received", and says nothing ` +
        `about letter case, so it MUST fail; got '${statuses[verifyLine]}'.`,
    );
    // The retry asked the same question: it ran the check again — the report
    // shows its turn, which runs the first check's code again unless it needs
    // new code (found nothing, say, or broke) — and no check in the report
    // expected the page's own casing, or anything else.
    assert.ok(
      html.includes(RECHECK_TURN),
      `the failed check was retried by running it again: the report has no "${RECHECK_TURN.trim()}" turn`,
    );
    const expected = expectedValues(html);
    assert.ok(expected.length >= 1, 'the report shows no request for the check\'s code');
    assert.deepEqual(
      [...new Set(expected)], ['Payment Received'],
      `every check must expect "Payment Received" as the step writes it; the report shows ${JSON.stringify(expected)}`,
    );
  });

  it('fails a third case of text CSS shows in capitals, when the step says nothing about case', async () => {
    const file = fixture(workspaceRoot, 'verify-letter-case-transform-strict.md');
    const lines = stepLines(file);
    assert.equal(lines.length, 2, 'verify-letter-case-transform-strict.md should have exactly 2 steps');
    const [navLine, verifyLine] = lines;

    const { statuses, html } = await runWholeFile(hooks, file, { timeoutMs: 300_000 });
    console.log('[live] verify-letter-case-transform-strict statuses:', statuses);

    assert.ok(
      PASS_STATUSES.has(statuses[navLine]),
      `navigate (line ${navLine}) should pass, got '${statuses[navLine]}' — the fixture never reached the page, ` +
        'so the red below proves nothing',
    );
    assert.equal(
      statuses[verifyLine], 'fail',
      `line ${verifyLine} expects "Express Courier" where the page shows "EXPRESS COURIER" and its markup says ` +
        '"Express courier", and says nothing about letter case, so it MUST fail: CSS text-transform makes the ' +
        `case shown count as written, not every case; got '${statuses[verifyLine]}'.`,
    );
    // As for the status: the retry ran the same check again, and no check in
    // the report expected either case the page has, or anything else.
    assert.ok(
      html.includes(RECHECK_TURN),
      `the failed check was retried by running it again: the report has no "${RECHECK_TURN.trim()}" turn`,
    );
    const expected = expectedValues(html);
    assert.ok(expected.length >= 1, 'the report shows no request for the check\'s code');
    assert.deepEqual(
      [...new Set(expected)], ['Express Courier'],
      `every check must expect "Express Courier" as the step writes it; the report shows ${JSON.stringify(expected)}`,
    );
  });
});

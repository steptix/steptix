/**
 * Live end-to-end coverage for TYPING (steptix/steptix#90).
 *
 * A `type` puts in the characters its step names and presses no key the step
 * did not ask for. It used to press End after every fill, so that a
 * keyup-driven filter would react, and End is the spinbutton key for "set to
 * the maximum": a date typed into three segments went in as 31/12/9999 while
 * every step passed, because no step read the field back. The unit suite pins
 * the runtime on the same page (tests/typing-keys.test.ts); what only a real
 * model can show is the half the step's WORDS decide:
 *
 *   - securebank-schedule-transfer.md asks for the payee filter's text "one
 *     character at a time". The model must mark that type `sequential`, the
 *     filter must react, and the date segments must keep what was typed. Its
 *     last step reads the whole transfer back off the confirmation, so a key
 *     that changed a segment fails there instead of passing unseen.
 *   - securebank-transfer-plain-filter.md types the same text WITHOUT asking.
 *     The model must not mark it on its own because the page looks live
 *     (action prompt rule 10), so the filter stays unfiltered and the check
 *     after it MUST fail. A green run there is the bug.
 *
 * Both read the run's report as well as the gutter: the "typed key by key"
 * row is the runtime saying which way a field was typed, so it tells the two
 * ways of passing step 3 apart.
 *
 * Prereq: Sessions API server running on $LIVE_STEPTIX_SERVER_URL (default
 * :3100), and fixtures/test-app on :8787 (runLiveTest.cjs boots it).
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');

const { EXT_ID } = require('../extension-id.cjs');
const TEST_APP_URL = 'http://127.0.0.1:8787';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every status the gutter treats as green: a run may replay a compiled
 *  entry (</>), and that is still a pass. */
const PASS_STATUSES = new Set(['pass', 'pass-code-behind', 'pass-stale']);

/** The report row a key-by-key type writes (src/report/generator.ts). */
const TYPED_KEY_BY_KEY = '<div class="sub-action-detail">typed key by key</div>';

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

/** How many times `needle` occurs in `text`. */
const occurrences = (text, needle) => text.split(needle).length - 1;

describe('Steptix live — typing presses only what the step asks for', function () {
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
    // report as itself, not as ten failed steps.
    try {
      const res = await fetch(`${TEST_APP_URL}/schedule-transfer`);
      assert.equal(res.status, 200, `fixture app returned ${res.status} for /schedule-transfer`);
      const html = await res.text();
      assert.ok(html.includes('id="transfer-day"'), '/schedule-transfer served but #transfer-day is missing — stale fixture app?');
    } catch (err) {
      throw new Error(
        `Live typing tests need fixtures/test-app on ${TEST_APP_URL} (runLiveTest.cjs normally boots it). ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  afterEach(async () => {
    // A fresh browser per fixture, so neither can pass on the other's page.
    await vscode.commands.executeCommand('steptix.restartSession');
    await sleep(1_000);
  });

  it('types every value the steps name, and the confirmation reads them back', async () => {
    const file = fixture(workspaceRoot, 'securebank-schedule-transfer.md');
    const lines = stepLines(file);
    assert.equal(lines.length, 10, `expected 10 steps in securebank-schedule-transfer.md, found ${lines.length}`);

    const { statuses, html } = await runWholeFile(hooks, file, { timeoutMs: 600_000 });
    console.log('[live] securebank-schedule-transfer statuses:', statuses);

    const bad = lines.filter((l) => !PASS_STATUSES.has(statuses[l]));
    assert.equal(
      bad.length, 0,
      `these step lines did not pass: ${bad.map((l) => `${l}=${statuses[l]}`).join(', ')}. ` +
        `A red last step that read 31/12/9999 means a key changed the date segments after they were typed.`,
    );
    // Step 2 asked for key by key. At least once rather than exactly once: a
    // model may type it again in a second turn, which is still right. That a
    // step which does not ask gets no flag is what the companion pins.
    assert.ok(
      occurrences(html, TYPED_KEY_BY_KEY) >= 1,
      'step 2 asks for its text one character at a time, so the model must mark its type `sequential`',
    );
  });

  it('a plain type into a keyup-only filter leaves it unfiltered, so its check must fail', async () => {
    const file = fixture(workspaceRoot, 'securebank-transfer-plain-filter.md');
    const lines = stepLines(file);
    assert.equal(lines.length, 3, 'securebank-transfer-plain-filter.md should have exactly 3 steps');
    const [navLine, typeLine, verifyLine] = lines;

    const { statuses, html } = await runWholeFile(hooks, file, { timeoutMs: 300_000 });
    console.log('[live] securebank-transfer-plain-filter statuses:', statuses);

    for (const line of [navLine, typeLine]) {
      assert.ok(
        PASS_STATUSES.has(statuses[line]),
        `line ${line} should pass, got '${statuses[line]}' — the run never typed into the filter, so the red below proves nothing`,
      );
    }
    assert.equal(
      occurrences(html, TYPED_KEY_BY_KEY), 0,
      'the plain type was typed key by key: the model marked it `sequential` although the step never asked',
    );
    assert.equal(
      statuses[verifyLine], 'fail',
      `line ${verifyLine} checks a filter that reacts only to keys after a plain type, and MUST fail; ` +
        `got '${statuses[verifyLine]}'. A pass means a key reached the filter that the step never asked for, ` +
        'or a retry checked something easier than "no other payee" (steptix/steptix#97).',
    );
  });
});

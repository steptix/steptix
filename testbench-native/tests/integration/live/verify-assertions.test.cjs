/**
 * Live end-to-end coverage for VERIFY steps.
 *
 * Before this suite the live tier had almost no verification coverage. Two
 * steps existed — `cache-replay.md`'s "Verify the page URL is exactly
 * about:blank" and `sections-live.md`'s DOM-free "Confirm the browser is
 * showing a page" — and neither suite asserted anything about the
 * verification itself: cache-replay asserts the ⚡ cache glyph, sections
 * asserts section expansion. Nothing read a real value off a real page, and
 * nothing proved a verify could go red.
 *
 * Why the red case is the load-bearing half
 * -----------------------------------------
 * The model both writes the assertion code and grades the result, so a file
 * of passing verifies cannot distinguish "verification works" from
 * "verification is a no-op that returns true". The two must-fail fixtures are
 * what close that gap, and they are deliberately near misses rather than
 * absurd values:
 *
 *   - verify-near-miss.md      expects $148,320.51 against a rendered
 *                              $148,320.50. One cent. An assertion that
 *                              merely finds a dollar figure passes this;
 *                              one that compares the numbers does not.
 *   - verify-false-negation.md asserts the Cash & Savings card is NOT
 *                              $24,582.90 when it is exactly that. Paired
 *                              with verify-assertions.md step 4 (NOT $60.00,
 *                              which passes) it pins the direction of the
 *                              negation — dropping the "NOT" satisfies
 *                              exactly one of the two.
 *
 * On retries and self-healing
 * ---------------------------
 * A failed assertion throws StepFailureError, which the step-level withRetry
 * catches, so with the default execution.retries: 1 each must-fail step is
 * attempted twice before settling red. That is expected and does not weaken
 * the test — the page value genuinely differs, so both attempts fail. Two
 * framework behaviours keep the retry from being a "try until green" loop,
 * and this suite is what would notice if either regressed:
 *
 *   - evaluateAssertion regenerates assertion code only when the code THROWS,
 *     never on a structured `pass: false` (src/runner/step-executor.ts — the
 *     `break; // success — got a structured result (pass or fail)`).
 *   - assertion failures never reach `collectedFailures`, which is what feeds
 *     the retry prompt's prior-failure context. The second attempt is not
 *     told what the assertion expected or what it got, so it cannot aim at
 *     the expectation.
 *
 * Prereq: Sessions API server running on $LIVE_SERVER_URL (default :3100),
 * and fixtures/test-app on :8787 (runLiveTest.cjs boots it).
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');

const EXT_ID = 'pkent.testbench-native';
const TEST_APP_URL = 'http://127.0.0.1:8787';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every status the gutter treats as green. A run may legitimately replay
 *  from cache (⚡) or from a compiled entry (</>), so pinning to plain 'pass'
 *  would make this suite fail for a reason that has nothing to do with
 *  verification. */
const PASS_STATUSES = new Set(['pass', 'pass-cached', 'pass-code-behind', 'pass-stale']);

async function waitFor(label, predicate, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await predicate()) return; } catch { /* transient */ }
    await sleep(200);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

/**
 * Line numbers of the `N. ` step lines in a fixture, 1-based.
 *
 * Derived rather than hardcoded: these fixtures are prose-heavy (the
 * rationale for each shape lives in comments between the steps), so any edit
 * to the commentary shifts every line below it. A hardcoded table would then
 * assert about blank lines and quietly pass.
 */
function stepLines(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const out = [];
  lines.forEach((text, i) => {
    if (/^\d+\.\s+\S/.test(text)) out.push(i + 1);
  });
  return out;
}

function fixture(workspaceRoot, name) {
  const file = path.resolve(workspaceRoot, 'init', 'tests', name);
  assert.ok(fs.existsSync(file), `${name} not found at ${file}`);
  return file;
}

/** Open a fixture and run every step in it to completion. Returns the final
 *  line→status map. */
async function runWholeFile(hooks, file, { timeoutMs }) {
  const uri = vscode.Uri.file(file);
  await vscode.commands.executeCommand('vscode.open', uri);
  await waitFor(
    `${path.basename(file)} becomes active editor`,
    () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
  );
  await waitFor(
    'tracker recognises test file',
    () => hooks.tracker.snapshot().isTestFile === true,
  );

  void vscode.commands.executeCommand('testbench-native.runAll');
  await waitFor('run starts', () => hooks.isRunning(), 60_000);
  await waitFor('run finishes', () => !hooks.isRunning(), timeoutMs);

  return Object.fromEntries(hooks.tracker.snapshot().statuses);
}

describe('TestBench live — verify steps', function () {
  this.timeout(900_000);

  /** @type {import('../../../dist/extension/extension').TestBenchTestHooks} */
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

    const serverUrl = process.env.LIVE_SERVER_URL || 'http://localhost:3100';
    try {
      const res = await fetch(`${serverUrl}/sessions/healthcheck/steps`, { method: 'OPTIONS' });
      assert.ok(
        res.status === 204 || res.status === 200,
        `Server at ${serverUrl} not responding (status=${res.status})`,
      );
    } catch (err) {
      throw new Error(
        `Live test requires the API server running at ${serverUrl}. ` +
          `Start it with \`npm run dev\` or \`aiui serve\`. ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Every fixture here points at the portfolio page. Probing it separately
    // means "the fixture app is down" reports as itself rather than as 18
    // assertion failures about missing elements.
    try {
      const res = await fetch(`${TEST_APP_URL}/assertions`);
      assert.equal(res.status, 200, `fixture app returned ${res.status} for /assertions`);
      const html = await res.text();
      assert.ok(
        html.includes('id="portfolio-total"'),
        '/assertions served but #portfolio-total is missing — stale fixture app?',
      );
    } catch (err) {
      throw new Error(
        `Live verify tests need fixtures/test-app on ${TEST_APP_URL} ` +
          `(runLiveTest.cjs normally boots it). ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  afterEach(async () => {
    // Fresh browser per fixture — each one navigates from scratch and a
    // leftover session would let a later fixture pass on the previous
    // fixture's page.
    await vscode.commands.executeCommand('testbench-native.restartSession');
    await sleep(1_000);
  });

  it('passes every verification shape on the portfolio page', async () => {
    const file = fixture(workspaceRoot, 'verify-assertions.md');
    const lines = stepLines(file);
    assert.equal(
      lines.length, 18,
      `expected 18 steps in verify-assertions.md, found ${lines.length} — ` +
        `fixture edited without updating this assertion`,
    );

    const statuses = await runWholeFile(hooks, file, { timeoutMs: 600_000 });
    console.log('[live] verify-assertions statuses:', statuses);

    const bad = lines.filter((l) => !PASS_STATUSES.has(statuses[l]));
    assert.equal(
      bad.length, 0,
      `these step lines did not pass: ${bad.map((l) => `${l}=${statuses[l]}`).join(', ')}`,
    );
  });

  it('fails a verify whose expected value is one cent off', async () => {
    const file = fixture(workspaceRoot, 'verify-near-miss.md');
    const lines = stepLines(file);
    assert.equal(lines.length, 2, 'verify-near-miss.md should have exactly 2 steps');
    const [navLine, verifyLine] = lines;

    const statuses = await runWholeFile(hooks, file, { timeoutMs: 300_000 });
    console.log('[live] verify-near-miss statuses:', statuses);

    assert.ok(
      PASS_STATUSES.has(statuses[navLine]),
      `navigate (line ${navLine}) should pass, got '${statuses[navLine]}' — ` +
        `the fixture never reached the page, so the red below proves nothing`,
    );
    assert.equal(
      statuses[verifyLine], 'fail',
      `line ${verifyLine} asserts $148,320.51 against a rendered $148,320.50 and MUST fail; ` +
        `got '${statuses[verifyLine]}'. A pass here means the assertion is not comparing ` +
        `the values — either it matched any dollar figure, or it returned true without looking.`,
    );
  });

  it('fails a negation asserted against the value that is actually shown', async () => {
    const file = fixture(workspaceRoot, 'verify-false-negation.md');
    const lines = stepLines(file);
    assert.equal(lines.length, 2, 'verify-false-negation.md should have exactly 2 steps');
    const [navLine, verifyLine] = lines;

    const statuses = await runWholeFile(hooks, file, { timeoutMs: 300_000 });
    console.log('[live] verify-false-negation statuses:', statuses);

    assert.ok(
      PASS_STATUSES.has(statuses[navLine]),
      `navigate (line ${navLine}) should pass, got '${statuses[navLine]}'`,
    );
    assert.equal(
      statuses[verifyLine], 'fail',
      `line ${verifyLine} asserts the Cash & Savings card is NOT $24,582.90 when it is ` +
        `exactly that, so it MUST fail; got '${statuses[verifyLine]}'. Paired with ` +
        `verify-assertions.md step 4 (NOT $60.00, passes), a pass here means the ` +
        `negation was dropped rather than evaluated.`,
    );
  });
});

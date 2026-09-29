/**
 * Live end-to-end test for `If … then return` / `… then stop`
 * (stories/step-flow-control.md).
 *
 * The whole feature against a real server, a real model and a real browser.
 * Everything below this layer stops short of the thing that matters:
 *
 *  - the vitest suite POSTs a request it builds itself, so it proves the
 *    server's loop but never that a model asked it to return;
 *  - the fast mocha suite scripts `step:skip` through `FakeApiClient`, so it
 *    proves the painting but nothing about when the events are sent.
 *
 * Only a real run proves the two ends meet: that the model answers a
 * flow-control line with the new `return` action when its condition holds and
 * `noop` when it does not, that the server then skips exactly the rest of that
 * flow, and that the marks land where an author is looking.
 *
 * The fixture calls one section TWICE on purpose. The first call must run its
 * body (the condition is false — the page is the sign-in page) and the second
 * must return at its first line (the condition is true — it is now the
 * dashboard). A feature that always returned, or never did, passes half of
 * that and fails the other half.
 *
 * Local by construction: the target is `fixtures/test-app`, which the live
 * runner already boots on :8787 — no external account, no rate limit, nothing
 * another run could sign out from under this one.
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = 'pkent.steptix-vscode';
const TEST_APP_PORT = 8787;

// --- templates/init/tests/flow-control-live.md ---------------------------
const MAIN_NAVIGATE = 22; // 1. Navigate to the baseUrl
const CALL_FIRST = 23; // 2. Sign in            → runs the body
const CALL_SECOND = 24; // 3. Sign in            → returns at body line 1
const MAIN_STOP = 25; // 4. If the page title contains "Dashboard" then stop …
const MAIN_SIGN_OUT = 26; // 5. Click "Sign out"     → never runs
const BODY_RETURN = 29; // 1. If the page title contains "Dashboard" then return
const BODY_COOKIES = 30; // 2. Reject non-essential cookies in the cookie banner
const BODY_USERNAME = 31; // 3. Enter the username {{username}}
const BODY_PASSWORD = 32; // 4. Enter the password {{password}}
const BODY_SUBMIT = 33; // 5. Click the Sign in button
/** The body lines the SECOND call leaves behind. */
const BODY_SKIPPED = [BODY_COOKIES, BODY_USERNAME, BODY_PASSWORD, BODY_SUBMIT];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Say what was observed, into the shard's own log as well as stdout — the
 * parallel runner discards a passing launch's stdout, and these statuses are
 * the evidence a reader wants most when the test PASSES.
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
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {
      /* transient */
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

/**
 * Any flavour of pass. A step served by a compiled entry paints `</>` and one
 * whose entry threw paints ⚠; both ARE passes, and which one a given run
 * produces is not what these assertions are about. The two places the exact flavour matters say so themselves.
 */
const isPass = (status) => typeof status === 'string' && status.startsWith('pass');

async function up(url) {
  try {
    const res = await fetch(url);
    return res.status > 0;
  } catch {
    return false;
  }
}

/**
 * The body of the `defineSteps` entry whose `source:` line contains `needle`,
 * or null.
 *
 * Split on `source:` rather than parsed, because the point is to check WHICH
 * entry holds a call: a whole-file `assert.match` would pass on an entry bound
 * to a different step, which is precisely the mistake the story makes
 * non-retryable. The first line of each block is the source literal.
 */
function entryFor(content, needle) {
  const blocks = content.split(/\n\s*source:/).slice(1);
  return blocks.find((b) => (b.split('\n')[0] ?? '').includes(needle)) ?? null;
}

/** The extension's output channel, teed to a file by the live runner. */
function readLiveLog() {
  const file = process.env.STEPTIX_LIVE_LOG;
  if (!file || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf-8');
}

describe('Steptix live — a step that leaves its flow early', function () {
  // Two full AI runs plus a compile; ~8 model turns each.
  this.timeout(1_200_000);

  /** @type {import('../../../dist/extension/extension').SteptixTestHooks} */
  let hooks;
  /** @type {import('node:child_process').ChildProcess | null} */
  let testApp = null;
  let startedApp = false;
  let testFile;
  let stepsFile;
  let cacheDir;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks missing — activation may have failed');

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
          `Start it with \`node dist/index.js serve -p <port>\`. ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // The target site. `runLiveTest.cjs` boots it for every shard, so this is
    // normally an adoption — the spawn is here for a hand-run of this file
    // alone. Either way nothing already serving :8787 is killed: a developer
    // running the fixture app themselves keeps their session.
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

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — the live runner must pass templates/');
    testFile = path.resolve(workspaceRoot, 'init', 'tests', 'flow-control-live.md');
    assert.ok(fs.existsSync(testFile), `flow-control-live.md not found at ${testFile}`);
    stepsFile = testFile.replace(/\.md$/, '.steps.ts');
    cacheDir = path.join(path.dirname(testFile), '.steptix-codebehind-cache');
  });

  after(async () => {
    // The compiled file is this test's output, not a fixture: leaving it would
    // make the AI half of the next run replay code instead of asking a model.
    fs.rmSync(stepsFile, { force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
    if (startedApp && testApp) {
      try {
        cp.execSync(`taskkill /pid ${testApp.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        testApp.kill();
      }
    }
  });

  /** Open the fixture and wait until Steptix owns it. */
  async function focusTestFile() {
    const uri = vscode.Uri.file(testFile);
    // Shown, not just opened: `vscode.open` can return before the editor has
    // focus, and the activeTextEditor wait then races its budget under load.
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
      preview: false,
    });
    await waitFor(
      'flow-control-live.md becomes the active editor',
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      15_000,
    );
    await waitFor('tracker recognises the test file', () => hooks.tracker.snapshot().isTestFile);
    return uri;
  }

  it('the second call returns, the main flow stops, and only the unrun lines wear ◌', async () => {
    fs.rmSync(stepsFile, { force: true });
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }

    await focusTestFile();
    // A fresh browser: the first call's condition MUST be false, and a
    // dashboard left over from another test in this shard would make it true
    // and quietly turn this into a test of nothing.
    await vscode.commands.executeCommand('steptix.restartSession');
    await sleep(1_000);
    const logBefore = readLiveLog()?.length ?? 0;

    say('running flow-control-live.md');
    void vscode.commands.executeCommand('steptix.runAll');
    await waitFor('run started', () => hooks.isRunning(), 60_000);
    await waitFor('run finished', () => !hooks.isRunning(), 900_000);

    const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    say(`statuses: ${JSON.stringify(statuses)}`);

    // ── The first call ran its body ──────────────────────────────────────
    // Proved by the returning line being a pass rather than blank, and by the
    // call lines below: a body that never ran would leave everything blank.
    assert.ok(isPass(statuses[MAIN_NAVIGATE]), `step 1 must have run; got "${statuses[MAIN_NAVIGATE]}"`);
    assert.ok(
      isPass(statuses[BODY_RETURN]),
      `the flow-control body line must PASS both times — a false condition is a ` +
        `noop, a true one is a return, and neither is a failure. Got "${statuses[BODY_RETURN]}".`,
    );

    // ── THE assertion: the second call skipped the rest of the body ──────
    // These four lines PASSED on the first call. They wear ◌ because the
    // second call repainted them, which is the whole feature: a step that did
    // not run this time must not keep last time's ✓.
    for (const line of BODY_SKIPPED) {
      assert.equal(
        statuses[line],
        'skip',
        `body line ${line} should be ◌ from the second call's return, got ` +
          `"${statuses[line]}". A "pass" here means the second call ran the ` +
          `body anyway; blank means nobody repainted it.`,
      );
    }

    // ── The call lines are ✓, from the clean pop ─────────────────────────
    // The section ran and returned. Marking a returned call line ◌ would be
    // the opposite error to the one above, and just as wrong.
    assert.equal(statuses[CALL_FIRST], 'pass', 'the first call ran its body');
    assert.equal(
      statuses[CALL_SECOND],
      'pass',
      `the returning call line must still be ✓ — the section ran and returned. ` +
        `Got "${statuses[CALL_SECOND]}".`,
    );

    // ── The main flow stopped ────────────────────────────────────────────
    assert.ok(
      isPass(statuses[MAIN_STOP]),
      `the stopping step itself passes; got "${statuses[MAIN_STOP]}"`,
    );
    assert.equal(
      statuses[MAIN_SIGN_OUT],
      'skip',
      `the step after the stop must be ◌, not blank and never ✓. Got "${statuses[MAIN_SIGN_OUT]}".`,
    );

    // ── And the run is a PASS ────────────────────────────────────────────
    // The failure direction this whole story guards is a green report for work
    // that did not happen; the compensating rule is that a return does not
    // fail a run either (decision 4).
    assert.equal(
      hooks.lastDoneStatus(),
      'passed',
      'a run that returned from the main flow is a pass, not a timeout or a failure',
    );

    // The reason reaches the surfaces a reader has: the line's hover detail
    // and the run log. Both come from the server's one formatter, so matching
    // the sentence here pins the wire too.
    const failures = Object.fromEntries(hooks.tracker.snapshot().failures);
    assert.match(
      failures[BODY_COOKIES]?.error ?? '',
      /^Not run: step \d+ returned from "Sign in" — If the page title contains "Dashboard" then return$/,
      `the skipped body line's hover must name the step that returned; got ` +
        `${JSON.stringify(failures[BODY_COOKIES])}`,
    );
    assert.match(
      failures[MAIN_SIGN_OUT]?.error ?? '',
      /^Not run: step \d+ ended the run — If the page title contains "Dashboard" then stop running the remaining steps$/,
      `the skipped main-flow line's hover must say the run ended; got ` +
        `${JSON.stringify(failures[MAIN_SIGN_OUT])}`,
    );

    const log = readLiveLog();
    if (log !== null) {
      const thisRun = log.slice(logBefore);
      assert.match(
        thisRun,
        /◌ step 30 skipped — Not run: step \d+ returned from "Sign in"/,
        'the run log must carry the skipped body line and its reason',
      );
      assert.match(
        thisRun,
        /◌ step 26 skipped — Not run: step \d+ ended the run/,
        'the run log must carry the skipped main-flow line and its reason',
      );
    }
  });

  it('compiles the return to step.exit() and returns as code on replay', async () => {
    fs.rmSync(stepsFile, { force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });

    const uri = await focusTestFile();
    await vscode.commands.executeCommand('steptix.restartSession');
    await sleep(1_000);

    // ===== Run & Compile =====
    say('compiling flow-control-live.md');
    void vscode.commands.executeCommand('steptix.runAndCompile');
    await waitFor(
      'the compile proposes files for THIS test',
      // Not merely "a proposal exists": one slot serves the whole extension
      // host, so a proposal an earlier test left behind answers instantly.
      () => hooks.pendingCodeBehind()?.testFilePath.toLowerCase() === testFile.toLowerCase(),
      900_000,
    );

    const proposal = hooks.pendingCodeBehind();
    const [proposedPath, content] = Object.entries(proposal.files)[0];
    assert.equal(
      path.basename(proposedPath),
      'flow-control-live.steps.ts',
      'the proposal must name the sibling .steps.ts',
    );
    // THE code assertion. `step.exit()` is the code form of the authored
    // `return`, and it has to be in the entry bound to the RETURN step — a
    // file that merely contains the call somewhere would also be satisfied by
    // an entry that exits on the wrong line, which is the failure decision 11
    // makes non-retryable (the markdown has to say what the code does).
    const returnEntry = entryFor(content, 'then return');
    assert.ok(
      returnEntry,
      `no entry was generated for the flow-control step. Got:\n${content}`,
    );
    assert.match(
      returnEntry,
      /step\.exit\(/,
      `the entry for \`If the page title contains "Dashboard" then return\` must ` +
        `call step.exit(); an entry that does anything else silently drops the ` +
        `return on replay. Got:\n${returnEntry}`,
    );
    say(`proposed .steps.ts:\n${content}`);

    // ===== Apply =====
    await vscode.commands.executeCommand('steptix.applyCodeBehind');
    await waitFor('Apply writes the .steps.ts', () => fs.existsSync(stepsFile), 15_000);
    assert.equal(fs.readFileSync(stepsFile, 'utf-8'), content, 'Apply must write it verbatim');
    await waitFor(
      'focus returns to the test file after Apply',
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      15_000,
    );

    // ===== The next run is the proof =====
    await vscode.commands.executeCommand('steptix.restartSession');
    await sleep(1_000);
    say('replaying flow-control-live.md against the applied entries');
    void vscode.commands.executeCommand('steptix.runAll');
    await waitFor('the proving run starts', () => hooks.isRunning(), 60_000);
    await waitFor('the proving run finishes', () => !hooks.isRunning(), 900_000);

    const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    say(`replay statuses: ${JSON.stringify(statuses)}`);

    // The returning line ran its ENTRY, not a model turn. `</>` when the code
    // worked, ⚠ when it threw and the AI covered — the designed outcome for an
    // entry that does not survive its proving run. A plain "pass" is the bug
    // this guards: the step ran under AI without its entry ever being
    // consulted, which is also how a compiled `step.exit()` would go missing.
    assert.ok(
      statuses[BODY_RETURN] === 'pass-code-behind' || statuses[BODY_RETURN] === 'pass-stale',
      `the returning body line should have run its entry (</> or ⚠), got ` +
        `"${statuses[BODY_RETURN]}". A plain "pass" means the entry did not bind.`,
    );

    // And it still returned. Whether the return came from `step.exit()` or
    // from a heal under AI, the rest of that flow must not have run.
    for (const line of BODY_SKIPPED) {
      assert.equal(
        statuses[line],
        'skip',
        `body line ${line} should be ◌ on the replay too, got "${statuses[line]}"`,
      );
    }
    assert.equal(statuses[MAIN_SIGN_OUT], 'skip', 'the main-flow stop still holds on a replay');

    // Deliberately NOT asserted green. The replay never reaches the second
    // call's body lines, so they are neither proven nor failed and the compile
    // is `partial` by design (decision 12) — demanding a green compile here
    // would be demanding the feature not work.

    await vscode.commands.executeCommand('steptix.restartSession');
  });
});

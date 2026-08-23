/**
 * Live end-to-end test for Compile Code-behind
 * (stories/codebehind-compile.md).
 *
 * The whole loop with real tokens and a real browser: press Compile, the
 * server records the test under AI, generates an entry per step, reviews the
 * file, replays it as pure code, and streams the phases back; the extension
 * opens a diff; Apply writes the `.steps.ts`; and the run that follows serves
 * every step from that file — which is what ⚙ in the gutter means.
 *
 * That last assertion is the one that cannot be faked at any lower layer. The
 * integration suite proves the extension paints ⚙ when told to; only a live
 * run proves the code the compiler wrote actually executes and that the server
 * says so.
 *
 * Local by construction: the target is `fixtures/test-app`, started here and
 * killed afterwards, so nothing about this test depends on an external site or
 * an account someone else's run might be signing out of.
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = 'pkent.testbench-native';
const TEST_APP_PORT = 8787;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function up(url) {
  try {
    const res = await fetch(url);
    return res.status > 0;
  } catch {
    return false;
  }
}

describe('TestBench live — compile code-behind, apply, replay as code', function () {
  this.timeout(600_000); // record + generate + review + replay + a final run

  /** @type {import('../../../dist/extension/extension').TestBenchTestHooks} */
  let hooks;
  /** @type {import('node:child_process').ChildProcess | null} */
  let testApp = null;
  let testFile;
  let stepsFile;
  /** True when this run started the fixture app and must stop it. */
  let startedApp = false;

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

    // The target site. Left alone if something is already serving it — a
    // developer running the fixture app themselves should not have it killed
    // out from under them mid-session.
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
      console.log(`[live] started fixtures/test-app on ${appUrl}`);
    } else {
      console.log(`[live] reusing the fixtures/test-app already on ${appUrl}`);
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — the live runner must pass templates/');
    testFile = path.resolve(workspaceRoot, 'init', 'tests', 'compile-codebehind.md');
    assert.ok(fs.existsSync(testFile), `compile-codebehind.md not found at ${testFile}`);
    stepsFile = testFile.replace(/\.md$/, '.steps.ts');
  });

  after(async () => {
    // The compiled file is this test's output, not a fixture: leaving it would
    // make the next run's Select say "nothing to compile" and prove nothing.
    fs.rmSync(stepsFile, { force: true });
    fs.rmSync(path.join(path.dirname(testFile), '.aiui-codebehind-cache'), {
      recursive: true,
      force: true,
    });
    if (startedApp && testApp) {
      try {
        cp.execSync(`taskkill /pid ${testApp.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        testApp.kill();
      }
    }
  });

  it('compiles to green, applies the diff, and the next run serves every step as code', async () => {
    fs.rmSync(stepsFile, { force: true });
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }

    const uri = vscode.Uri.file(testFile);
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor(
      'compile-codebehind.md becomes the active editor',
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
    );
    await waitFor('tracker recognises the test file', () => hooks.tracker.snapshot().isTestFile);

    // ===== Compile =====
    void vscode.commands.executeCommand('testbench-native.compileCodeBehind');
    await waitFor('the compile proposes files', () => hooks.pendingCodeBehind() !== null, 480_000);

    const proposal = hooks.pendingCodeBehind();
    const proposed = Object.entries(proposal.files);
    assert.equal(proposed.length, 1, `expected one proposed file, got ${proposed.length}`);
    const [proposedPath, content] = proposed[0];
    assert.equal(
      path.basename(proposedPath),
      'compile-codebehind.steps.ts',
      'the proposal must name the sibling .steps.ts',
    );
    assert.match(content, /defineSteps\(\[/, 'the proposed file must be a code-behind file');
    assert.match(content, /source: "Navigate to the baseUrl"/, 'step 1 must have an entry');
    // Nothing on disk yet — the diff is the whole point.
    assert.equal(fs.existsSync(stepsFile), false, 'a compile must not write the file itself');

    // ===== Apply =====
    await vscode.commands.executeCommand('testbench-native.applyCodeBehind');
    await waitFor('Apply writes the .steps.ts', () => fs.existsSync(stepsFile), 15_000);
    assert.equal(fs.readFileSync(stepsFile, 'utf-8'), content, 'Apply must write it verbatim');
    assert.equal(hooks.pendingCodeBehind(), null, 'Apply must consume the proposal');
    // Apply is invoked from the diff, which is not a test file. Focus has to
    // come back or the author's next act — Run, to see the ⚙ marks — silently
    // does nothing, which is exactly how this test first failed.
    await waitFor(
      'focus returns to the test file after Apply',
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      15_000,
    );

    // ===== Replay =====
    // A fresh session so the run starts from a blank page, not wherever the
    // compile's own runs left one.
    await vscode.commands.executeCommand('testbench-native.restartSession');
    await sleep(1_000);
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('the replay run starts', () => hooks.isRunning(), 60_000);
    await waitFor('the replay run finishes', () => !hooks.isRunning(), 240_000);

    const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    const STEP_LINES = [16, 17];
    for (const line of STEP_LINES) {
      assert.equal(
        statuses[line],
        'pass-code-behind',
        `line ${line} should have run as code (⚙), got "${statuses[line]}". ` +
          `A "pass" means the entry did not bind; a "pass-stale" means it threw and the AI covered.`,
      );
    }

    await vscode.commands.executeCommand('testbench-native.restartSession');
  });

  it('compiles from the run the author just did — no Record — and paints ⚙ as it replays', async () => {
    // stories/codebehind-compile-as-a-run.md: an ordinary run captures the
    // DOM either side of its steps, so it IS the recording. Press Run, then
    // Compile: the server says it is compiling from the session's last run,
    // never records, and the Replay round's events paint ⚙ in the gutter —
    // before anything is applied.
    fs.rmSync(stepsFile, { force: true });
    const uri = vscode.Uri.file(testFile);
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor(
      'compile-codebehind.md becomes the active editor',
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
    );
    await waitFor('tracker recognises the test file', () => hooks.tracker.snapshot().isTestFile);

    // ===== Run, under AI (no entries on disk), with context captured =====
    await vscode.commands.executeCommand('testbench-native.restartSession');
    await sleep(1_000);
    const logBefore = readLiveLog()?.length ?? 0;
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('the AI run starts', () => hooks.isRunning(), 60_000);
    await waitFor('the AI run finishes', () => !hooks.isRunning(), 240_000);
    const afterRun = Object.fromEntries(hooks.tracker.snapshot().statuses);
    for (const line of [16, 17]) {
      assert.equal(afterRun[line], 'pass', `the AI run should pass line ${line} plainly, got "${afterRun[line]}"`);
    }

    // ===== Compile, from that run =====
    void vscode.commands.executeCommand('testbench-native.compileCodeBehind');
    await waitFor('the compile proposes files', () => hooks.pendingCodeBehind() !== null, 480_000);

    const proposal = hooks.pendingCodeBehind();
    const content = Object.values(proposal.files)[0];
    assert.match(content, /source: "Navigate to the baseUrl"/, 'step 1 must have an entry');
    assert.equal(fs.existsSync(stepsFile), false, 'a compile must not write the file itself');

    // The Replay round ran as code and said so, step by step, on the stream;
    // the gutter shows it without a run of our own. The snapshot is the
    // ACTIVE editor's, and the proposal just opened a diff — so look at the
    // test file again first.
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor(
      'the test file is active again',
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      15_000,
    );
    const afterCompile = Object.fromEntries(hooks.tracker.snapshot().statuses);
    for (const line of [16, 17]) {
      assert.equal(
        afterCompile[line],
        'pass-code-behind',
        `line ${line} should show ⚙ from the compile's replay, got "${afterCompile[line]}"`,
      );
    }

    const log = readLiveLog();
    if (log !== null) {
      const thisRun = log.slice(logBefore);
      assert.match(thisRun, /Compiling from session .* last run/, 'the compile must reuse the run');
      assert.doesNotMatch(thisRun, /Recording in session/, 'the compile must not record');
      assert.doesNotMatch(thisRun, /Record\s+running \d+ step/, 'no Record phase');
    }

    await vscode.commands.executeCommand('testbench-native.discardCodeBehind');
    await vscode.commands.executeCommand('testbench-native.restartSession');
  });
});

/** The extension's output channel, when the harness is teeing it to a file. */
function readLiveLog() {
  const file = process.env.TESTBENCH_LIVE_LOG;
  if (!file || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf-8');
}

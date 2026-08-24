/**
 * Live end-to-end test for Run & Compile and Compile This Step
 * (stories/compile-as-you-go.md).
 *
 * The whole loop with real tokens and a real browser: press Run & Compile, the
 * test runs ONCE — no Record, no Replay rounds — an entry is generated behind
 * each step as it finishes, the Review pass revises the file, the proposal
 * streams back on the run's own stream, the extension opens a diff, Apply
 * writes the `.steps.ts`, and the run that follows serves every step from that
 * file. That last part is what `</>` in the gutter means, and it is the
 * assertion that cannot be faked at any lower layer: the integration suite
 * proves the extension paints `</>` when told to; only a live run proves the
 * code the model wrote actually executes and that the server says so.
 *
 * The second test is the surgical path: one step re-runs in the live session,
 * from wherever the browser is, and splices its own recording back into the
 * one already on disk without touching its siblings.
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
/** The two step lines in `compile-codebehind.md`. */
const STEP_LINES = [16, 17];

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

describe('TestBench live — run & compile, apply, replay as code', function () {
  this.timeout(600_000);

  /** @type {import('../../../dist/extension/extension').TestBenchTestHooks} */
  let hooks;
  /** @type {import('node:child_process').ChildProcess | null} */
  let testApp = null;
  let testFile;
  let stepsFile;
  let cacheDir;
  let recordingDir;
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
    cacheDir = path.join(path.dirname(testFile), '.aiui-codebehind-cache');
    recordingDir = path.join(cacheDir, 'compile-codebehind.recording');
  });

  after(async () => {
    // The compiled file is this test's output, not a fixture: leaving it would
    // make the next run compile nothing and prove nothing.
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

  /** Open the fixture and wait until TestBench owns it. */
  async function focusTestFile() {
    const uri = vscode.Uri.file(testFile);
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor(
      'compile-codebehind.md becomes the active editor',
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      15_000,
    );
    await waitFor('tracker recognises the test file', () => hooks.tracker.snapshot().isTestFile);
    return uri;
  }

  it('runs once, compiles as it goes, and the next run proves every entry as code', async () => {
    fs.rmSync(stepsFile, { force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }

    const uri = await focusTestFile();
    await vscode.commands.executeCommand('testbench-native.restartSession');
    await sleep(1_000);
    const logBefore = readLiveLog()?.length ?? 0;

    // ===== Run & Compile =====
    void vscode.commands.executeCommand('testbench-native.runAndCompile');
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
    assert.match(content, /source: ['"]Navigate to the baseUrl['"]/, 'step 1 must have an entry');
    // Nothing on disk yet — the diff is the whole point.
    assert.equal(fs.existsSync(stepsFile), false, 'a compile must not write the file itself');

    // ONE browser pass. The gutter shows what the run did — plain ✓, under AI —
    // because the entries are born unproven: there is no Replay to prove them
    // and no </> to paint yet.
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor(
      'the test file is active again',
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      15_000,
    );
    const afterCompile = Object.fromEntries(hooks.tracker.snapshot().statuses);
    for (const line of STEP_LINES) {
      assert.equal(
        afterCompile[line],
        'pass',
        `line ${line} ran under AI in the compile's own run, so it should read a plain ✓, got "${afterCompile[line]}"`,
      );
    }

    const log = readLiveLog();
    if (log !== null) {
      const thisRun = log.slice(logBefore);
      assert.match(thisRun, /step 1 generated/, 'the trailing queue must report each entry');
      assert.match(thisRun, /step 2 generated/);
      assert.match(thisRun, /Compiled compile-codebehind\.md: 2 step\(s\) as code \(unproven/);
      // The box is gone: no Record phase, no Replay rounds.
      assert.doesNotMatch(thisRun, /Replay \d/, 'a compile-as-you-go run must not replay');
      assert.doesNotMatch(thisRun, /Record\s{2,}running/, 'a compile-as-you-go run must not record separately');
    }

    // The recording, beside the test: the run that just happened IS the
    // recording, written when it ended, with the candidate next to it — all
    // of it there before anything is applied.
    const recorded = fs.readdirSync(recordingDir).sort();
    for (const name of [
      'recording.json',
      'step-01.json', 'step-01.before.html', 'step-01.after.html',
      'step-02.json', 'step-02.before.html', 'step-02.after.html',
    ]) {
      assert.ok(recorded.includes(name), `${name} should be in the recording, got ${recorded.join(', ')}`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(recordingDir, 'recording.json'), 'utf-8'));
    assert.equal(manifest.status, 'passed');
    assert.equal(manifest.steps, 2);
    assert.equal(manifest.source, 'server');
    const step1 = readStep(1);
    assert.ok(step1.actions.length > 0, 'step 1 must carry its transcript');
    assert.equal(step1.source, 'Navigate to the baseUrl', 'the authored text is the splice identity');
    assert.ok(step1.recordedAt, 'every recorded step is stamped');
    const candidate = fs.readFileSync(path.join(cacheDir, 'compile-codebehind.steps.ts.candidate'), 'utf-8');
    assert.equal(candidate, content, 'the candidate on disk must be the proposal the diff shows');

    // ===== Apply =====
    await vscode.commands.executeCommand('testbench-native.applyCodeBehind');
    await waitFor('Apply writes the .steps.ts', () => fs.existsSync(stepsFile), 15_000);
    assert.equal(fs.readFileSync(stepsFile, 'utf-8'), content, 'Apply must write it verbatim');
    assert.equal(hooks.pendingCodeBehind(), null, 'Apply must consume the proposal');
    // Apply is invoked from the diff, which is not a test file. Focus has to
    // come back or the author's next act — Run, to see the </> marks — silently
    // does nothing, which is exactly how this test first failed.
    await waitFor(
      'focus returns to the test file after Apply',
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      15_000,
    );

    // ===== The next run is the proof =====
    await vscode.commands.executeCommand('testbench-native.restartSession');
    await sleep(1_000);
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('the proving run starts', () => hooks.isRunning(), 60_000);
    await waitFor('the proving run finishes', () => !hooks.isRunning(), 240_000);

    const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    for (const line of STEP_LINES) {
      assert.equal(
        statuses[line],
        'pass-code-behind',
        `line ${line} should have run as code (</>), got "${statuses[line]}". ` +
          `A "pass" means the entry did not bind; a "pass-stale" means it threw and the AI covered.`,
      );
    }

    await vscode.commands.executeCommand('testbench-native.restartSession');
  });

  it('Compile This Step re-runs one step in the live session and splices its recording', async () => {
    fs.rmSync(stepsFile, { force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
    await focusTestFile();
    await vscode.commands.executeCommand('testbench-native.restartSession');
    await sleep(1_000);

    // Seed: a Run & Compile leaves a two-step recording on disk and the
    // browser parked after step 2 — which is where Compile This Step wants it.
    void vscode.commands.executeCommand('testbench-native.runAndCompile');
    await waitFor('the seeding compile proposes files', () => hooks.pendingCodeBehind() !== null, 480_000);
    await vscode.commands.executeCommand('testbench-native.discardCodeBehind');
    const seeded = { one: readStep(1), two: readStep(2) };
    assert.ok(seeded.one.recordedAt && seeded.two.recordedAt);

    const uri = await focusTestFile();

    // ===== Compile This Step, on step 2 only =====
    void vscode.commands.executeCommand('testbench-native.compileStepCodeBehind', {
      lineNumber: STEP_LINES[1],
    });
    await waitFor('the single-step compile proposes a file', () => hooks.pendingCodeBehind() !== null, 300_000);

    const proposal = hooks.pendingCodeBehind();
    const content = Object.values(proposal.files)[0];
    // One entry, for the clicked step. No Review reflow of anything else —
    // there is nothing else in the file.
    assert.match(content, /source: ['"]Enter "demo@example\.com" in the email field['"]/);
    assert.doesNotMatch(
      content,
      /source: ['"]Navigate to the baseUrl['"]/,
      'a single-step compile must propose only the step it was asked for',
    );
    assert.equal(fs.existsSync(stepsFile), false, 'still nothing applied');

    // The recording spliced: step 2 is from just now, step 1 is untouched.
    const after = { one: readStep(1), two: readStep(2) };
    assert.equal(after.one.recordedAt, seeded.one.recordedAt, 'step 1 must keep its recording');
    assert.notEqual(after.two.recordedAt, seeded.two.recordedAt, 'step 2 must be re-recorded');
    assert.equal(after.two.source, 'Enter "demo@example.com" in the email field');
    assert.equal(after.two.index, 2, 'the spliced step keeps its slot, matched by text not by index');
    assert.equal(after.one.source, 'Navigate to the baseUrl');
    assert.equal(
      JSON.stringify(after.one),
      JSON.stringify(seeded.one),
      'the sibling step is byte-for-byte the recording it was',
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(recordingDir, 'recording.json'), 'utf-8'));
    assert.equal(manifest.steps, 2, 'the splice must not drop the sibling');

    // Only the clicked step ran: the gutter shows step 2 moving and step 1
    // untouched from the seeding run.
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor(
      'the test file is active again',
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      15_000,
    );
    const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    assert.equal(statuses[STEP_LINES[1]], 'pass', `step 2 should have run, got "${statuses[STEP_LINES[1]]}"`);

    await vscode.commands.executeCommand('testbench-native.discardCodeBehind');
    await vscode.commands.executeCommand('testbench-native.restartSession');
  });

  /** One step's recording, as JSON. */
  function readStep(index) {
    const file = path.join(recordingDir, `step-0${index}.json`);
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  }
});

/** The extension's output channel, when the harness is teeing it to a file. */
function readLiveLog() {
  const file = process.env.TESTBENCH_LIVE_LOG;
  if (!file || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf-8');
}

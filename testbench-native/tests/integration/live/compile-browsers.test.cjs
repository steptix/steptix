/**
 * Live end-to-end test for compiling browser steps
 * (stories/codebehind-framework-actions.md) — the sibling of
 * `compile-tabs.test.cjs`, one level up.
 *
 * `openBrowser` / `switchBrowser` / `closeBrowser` were on the same refusal
 * list the tab actions were, for the same reason: an entry could launch a
 * second Playwright browser but had no way to tell the runner which browser
 * the NEXT step belongs to. `ctx.browsers` drives the run's own
 * `BrowserTracker`, and step 4 of the fixture is what proves it — asserting
 * that the default browser is still on its own page after a compiled switch
 * back.
 *
 * Local by construction: `fixtures/test-app`, started here and killed
 * afterwards. It does launch a second real browser, briefly.
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = 'pkent.testbench-native';
const TEST_APP_PORT = 8787;
/** The five step lines in `compile-browsers.md`. */
const STEP_LINES = [26, 27, 28, 29, 30];
/** The three that used to be refused: open, switch back, close. */
const BROWSER_STEP_LINES = [27, 29, 30];
/** Their authored text — the identity an entry binds on. */
const BROWSER_STEP_SOURCES = [
  'Open a second browser as worker',
  'Switch back to the default browser and confirm the heading "Window & Tab Test" is shown',
  'Close the worker browser',
];

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

describe('TestBench live — browser steps compile to code', function () {
  this.timeout(600_000);

  /** @type {import('../../../dist/extension/extension').TestBenchTestHooks} */
  let hooks;
  /** @type {import('node:child_process').ChildProcess | null} */
  let testApp = null;
  let testFile;
  let stepsFile;
  let cacheDir;
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
    testFile = path.resolve(workspaceRoot, 'init', 'tests', 'compile-browsers.md');
    assert.ok(fs.existsSync(testFile), `compile-browsers.md not found at ${testFile}`);
    stepsFile = testFile.replace(/\.md$/, '.steps.ts');
    cacheDir = path.join(path.dirname(testFile), '.aiui-codebehind-cache');
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

  it('compiles open / switch / close to ctx.browsers and replays them as code', async () => {
    fs.rmSync(stepsFile, { force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }

    const uri = vscode.Uri.file(testFile);
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor(
      'compile-browsers.md becomes the active editor',
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      15_000,
    );
    await waitFor('tracker recognises the test file', () => hooks.tracker.snapshot().isTestFile);
    await vscode.commands.executeCommand('testbench-native.restartSession');
    await sleep(1_000);

    // ===== Run & Compile =====
    void vscode.commands.executeCommand('testbench-native.runAndCompile');
    await waitFor('the compile proposes files', () => hooks.pendingCodeBehind() !== null, 480_000);

    const proposal = hooks.pendingCodeBehind();
    const proposed = Object.entries(proposal.files);
    assert.equal(proposed.length, 1, `expected one proposed file, got ${proposed.length}`);
    const [proposedPath, content] = proposed[0];
    assert.equal(path.basename(proposedPath), 'compile-browsers.steps.ts');

    // The exact, deterministic guard. Before this story every one of the three
    // browser steps came back as `{ ai: true }` with "changes runner state
    // rather than the page"; an `ai: true` anywhere in this file is that
    // refusal reinstated.
    assert.doesNotMatch(
      content,
      /ai:\s*true/,
      `no step in this test should be kept as AI. Proposal:\n${content}`,
    );
    assert.match(content, /browsers\s*\./, 'the browser steps must be written against ctx.browsers');

    // Most of the three, not all three — whether a given generation lands is
    // model variance. Same reasoning (and the same observed flake) as
    // compile-tabs.test.cjs.
    const present = BROWSER_STEP_SOURCES.filter((s) => content.includes(s));
    assert.ok(
      present.length >= 2,
      `at least two of the three browser steps must have an entry; got ${present.length} ` +
        `(missing: ${BROWSER_STEP_SOURCES.filter((s) => !present.includes(s)).join(' | ')}). ` +
        `Proposal:\n${content}`,
    );

    // A freshly-opened browser is on about:blank, so its entry must not wait
    // for page content — the post-condition carve-out. Asserted on the shape
    // the model is told to use rather than on the absence of a waitFor, which
    // would be too blunt: step 3 and step 4 legitimately wait for headings.
    if (content.includes(BROWSER_STEP_SOURCES[0])) {
      assert.match(
        content,
        /browsers\.(list|activeLabel)\(\)/,
        'the open-a-browser step should assert over browsers.list()/activeLabel(), not page content',
      );
    }
    assert.equal(fs.existsSync(stepsFile), false, 'a compile must not write the file itself');

    // ===== Apply =====
    await vscode.commands.executeCommand('testbench-native.applyCodeBehind');
    await waitFor('Apply writes the .steps.ts', () => fs.existsSync(stepsFile), 15_000);
    assert.equal(fs.readFileSync(stepsFile, 'utf-8'), content, 'Apply must write it verbatim');
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
    const compiledLines = BROWSER_STEP_LINES.filter(
      (line, i) => content.includes(BROWSER_STEP_SOURCES[i]),
    );
    for (const line of compiledLines) {
      assert.ok(
        statuses[line] === 'pass-code-behind' || statuses[line] === 'pass-stale',
        `line ${line} should have run its entry (</> or ⚠), got "${statuses[line]}". ` +
          `A plain "pass" means the entry did not bind at all.`,
      );
    }
    assert.ok(
      BROWSER_STEP_LINES.some((line) => statuses[line] === 'pass-code-behind'),
      `at least one browser step must prove as code (</>); got ${JSON.stringify(
        BROWSER_STEP_LINES.map((line) => statuses[line]),
      )} — all-stale means no generated browser entry ever works, which is not variance.`,
    );
    // Step 4 is the one that cannot pass by accident: it asserts the DEFAULT
    // browser's own heading after a compiled switch back. An entry that opened
    // a second Playwright browser without moving the run's tracker leaves the
    // run in the worker, where that heading does not exist.
    assert.ok(
      statuses[STEP_LINES[3]] !== 'fail',
      'step 4 asserts the default browser after switching back — a failure here means ' +
        'the compiled switch never reached the run',
    );

    await vscode.commands.executeCommand('testbench-native.restartSession');
  });
});

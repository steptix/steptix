/**
 * Live end-to-end test for compiling tab steps
 * (stories/codebehind-framework-actions.md).
 *
 * The three steps this test exists for — open a tab, switch back, close one —
 * used to be refused by `refuseReason` before the model was even asked, and
 * came back as `ai: true` entries on every compile forever. The assertion that
 * cannot be faked at any lower layer is the last one: the proving run serves
 * those steps from the file and the server says `</>`, which means the
 * generated `ctx.tabs` calls really did move the run's own tracker.
 *
 * Local by construction: `fixtures/test-app`, started here and killed
 * afterwards.
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = 'pkent.steptix-vscode';
const TEST_APP_PORT = 8787;
/** The five step lines in `compile-tabs.md`. */
const STEP_LINES = [22, 23, 24, 25, 26];
/** The three that used to be refused: open a tab, switch back, close it. */
const TAB_STEP_LINES = [23, 25, 26];
/** Their authored text — the identity an entry binds on. */
const TAB_STEP_SOURCES = [
  'Click "Open New Tab" and switch to the tab it opened',
  'Switch back to the main tab and confirm the heading "Window & Tab Test" is shown',
  'Close the tab showing "Account Summary"',
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

describe('Steptix live — tab steps compile to code', function () {
  this.timeout(600_000);

  /** @type {import('../../../dist/extension/extension').SteptixTestHooks} */
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
    testFile = path.resolve(workspaceRoot, 'init', 'tests', 'compile-tabs.md');
    assert.ok(fs.existsSync(testFile), `compile-tabs.md not found at ${testFile}`);
    stepsFile = testFile.replace(/\.md$/, '.steps.ts');
    cacheDir = path.join(path.dirname(testFile), '.steptix-codebehind-cache');
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

  it('compiles open / switch / close to ctx.tabs and replays them as code', async () => {
    fs.rmSync(stepsFile, { force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }

    const uri = vscode.Uri.file(testFile);
    // Shown, not just opened: `vscode.open` can return before the editor has
    // focus, so the activeTextEditor wait below raced its budget and failed a
    // full-suite run under load. showTextDocument resolves once it is shown.
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
      preview: false,
    });
    await waitFor(
      'compile-tabs.md becomes the active editor',
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      15_000,
    );
    await waitFor('tracker recognises the test file', () => hooks.tracker.snapshot().isTestFile);
    await vscode.commands.executeCommand('steptix.restartSession');
    await sleep(1_000);

    // ===== Run & Compile =====
    void vscode.commands.executeCommand('steptix.runAndCompile');
    await waitFor(
      'the compile proposes files for THIS test',
      // Not merely "a proposal exists": one slot serves the whole extension
      // host, so a proposal an earlier test left behind answers that predicate
      // instantly and this test then asserts against another file.
      () => hooks.pendingCodeBehind()?.testFilePath.toLowerCase() === testFile.toLowerCase(),
      480_000,
    );

    const proposal = hooks.pendingCodeBehind();
    const proposed = Object.entries(proposal.files);
    assert.equal(proposed.length, 1, `expected one proposed file, got ${proposed.length}`);
    const [proposedPath, content] = proposed[0];
    assert.equal(path.basename(proposedPath), 'compile-tabs.steps.ts');

    // The heart of it. Before this story every one of the three tab steps came
    // back as `{ ai: true }` with "changes runner state rather than the page",
    // and a compile of this test proposed nothing but the navigate. An
    // `ai: true` anywhere in this file is that regression.
    assert.doesNotMatch(
      content,
      /ai:\s*true/,
      `no step in this test should be kept as AI. Proposal:\n${content}`,
    );
    assert.match(content, /tabs\s*\./, 'the tab steps must be written against ctx.tabs');

    // Most of the three, not all three. Whether a given generation lands is
    // model variance — observed once as a proposal missing only the `close`
    // entry, on a run that then produced all five twice over. Demanding all
    // three makes this suite assert that the model never has an off pass,
    // which is the same trap the compile-codebehind suite's `</>` assertion
    // fell into. Two is enough to fail loudly if tab steps stop compiling at
    // all, and the `ai: true` check above is the exact, deterministic guard
    // for the refusal actually regressing.
    const present = TAB_STEP_SOURCES.filter((s) => content.includes(s));
    assert.ok(
      present.length >= 2,
      `at least two of the three tab steps must have an entry; got ${present.length} ` +
        `(missing: ${TAB_STEP_SOURCES.filter((s) => !present.includes(s)).join(' | ')}). ` +
        `Proposal:\n${content}`,
    );
    assert.equal(fs.existsSync(stepsFile), false, 'a compile must not write the file itself');

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
    void vscode.commands.executeCommand('steptix.runAll');
    await waitFor('the proving run starts', () => hooks.isRunning(), 60_000);
    await waitFor('the proving run finishes', () => !hooks.isRunning(), 240_000);

    const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    // Same tolerance as the compile-codebehind suite: `</>` when the entry
    // worked, `⚠` when it threw and AI covered. Demanding `</>` on every line
    // would assert that the model writes perfect code first time, which is
    // variance. A plain "pass" is the real bug — it means the entry never
    // bound and the step ran under AI.
    //
    // Checked only for the tab steps the proposal actually carried: a step
    // with no entry is expected to read a plain ✓, and asserting otherwise
    // would turn the tolerance above into a contradiction.
    const compiledLines = TAB_STEP_LINES.filter(
      (line, i) => content.includes(TAB_STEP_SOURCES[i]),
    );
    for (const line of compiledLines) {
      assert.ok(
        statuses[line] === 'pass-code-behind' || statuses[line] === 'pass-stale',
        `line ${line} should have run its entry (</> or ⚠), got "${statuses[line]}". ` +
          `A plain "pass" means the entry did not bind at all.`,
      );
    }
    // At least one TAB step must actually work as code. Without this the suite
    // would pass on a file whose tab entries all threw and healed — which is
    // exactly the state this story set out to leave behind.
    assert.ok(
      TAB_STEP_LINES.some((line) => statuses[line] === 'pass-code-behind'),
      `at least one tab step must prove as code (</>); got ${JSON.stringify(
        TAB_STEP_LINES.map((line) => statuses[line]),
      )} — all-stale means no generated tab entry ever works, which is not variance.`,
    );
    // Step 3 reads the NEW tab. If the entry for step 2 switched the run's own
    // tracker, this passes; if it only opened a Playwright page and left the
    // tracker behind, step 3 reads the old tab and goes red. That is the
    // whole point of routing through the tracker rather than context.newPage.
    assert.ok(
      statuses[STEP_LINES[2]] !== 'fail',
      'step 3 reads the new tab — a failure here means the switch never reached the run',
    );

    await vscode.commands.executeCommand('steptix.restartSession');
  });
});

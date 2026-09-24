/**
 * Live end-to-end test for compile-to-code through a SUBFOLDER skill
 * (stories/skills-in-subfolders.md).
 *
 * The fixture test's step 2 is `[skill: flows/enter_email ...]` — a
 * path-qualified reference to a skill in a subfolder of skillsDir. Run &
 * Compile must propose TWO files: the test's sibling `.steps.ts` and the
 * skill's own `skills/flows/enter_email.steps.ts` — the compiled entry and
 * its cache land beside the skill file *in its subfolder*, exactly as they
 * do for a flat skill beside skillsDir's root. The proving run then has to
 * serve both entries from code, which is the part no unit test can fake:
 * binding resolution, the candidate/cache paths and the esbuild temp-module
 * loader all derive from the skill file's real (nested) path.
 *
 * Local by construction: the target is `fixtures/test-app`, started here and
 * killed afterwards.
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = 'pkent.testbench-native';
const TEST_APP_PORT = 8787;
/** `1. Navigate to the baseUrl` in compile-skill-subfolder.md. */
const TEST_STEP_LINE = 16;
/** `2. [skill: flows/enter_email ...]` in compile-skill-subfolder.md. */
const SKILL_INVOCATION_LINE = 17;
/** `1. Enter "{{email}}" in the email field` in skills/flows/enter_email.md. */
const SKILL_STEP_LINE = 17;

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

/**
 * Whether two paths name the same file. `path.resolve` normalises separators
 * but not case, and Windows hands back whatever drive-letter casing the source
 * used — a proposal keyed `c:\…` against a fixture resolved as `C:\…` would
 * compare unequal on a case-insensitive filesystem where they are one file.
 */
function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

describe('TestBench live — compile to code through a subfolder skill', function () {
  this.timeout(600_000);

  /** @type {import('../../../dist/extension/extension').TestBenchTestHooks} */
  let hooks;
  /** @type {import('node:child_process').ChildProcess | null} */
  let testApp = null;
  let testFile;
  let testStepsFile;
  let testCacheDir;
  let skillFile;
  let skillStepsFile;
  let skillCacheDir;
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
    testFile = path.resolve(workspaceRoot, 'init', 'tests', 'compile-skill-subfolder.md');
    assert.ok(fs.existsSync(testFile), `compile-skill-subfolder.md not found at ${testFile}`);
    testStepsFile = testFile.replace(/\.md$/, '.steps.ts');
    testCacheDir = path.join(path.dirname(testFile), '.aiui-codebehind-cache');
    skillFile = path.resolve(workspaceRoot, 'init', 'skills', 'flows', 'enter_email.md');
    assert.ok(fs.existsSync(skillFile), `enter_email.md not found at ${skillFile}`);
    skillStepsFile = skillFile.replace(/\.md$/, '.steps.ts');
    skillCacheDir = path.join(path.dirname(skillFile), '.aiui-codebehind-cache');
  });

  after(async () => {
    // The compiled files are this test's output, not fixtures. Each rm is
    // guarded individually: before() assigns these across several asserts, so
    // ANY prefix of them may be undefined when it threw (server probe, missing
    // fixture...) — `force` forgives a missing file, not an undefined path,
    // and an ERR_INVALID_ARG_TYPE out of after() would bury the real failure.
    if (testStepsFile) fs.rmSync(testStepsFile, { force: true });
    if (skillStepsFile) fs.rmSync(skillStepsFile, { force: true });
    if (testCacheDir) fs.rmSync(testCacheDir, { recursive: true, force: true });
    if (skillCacheDir) fs.rmSync(skillCacheDir, { recursive: true, force: true });
    if (startedApp && testApp) {
      try {
        cp.execSync(`taskkill /pid ${testApp.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        testApp.kill();
      }
    }
  });

  /** Open `file` and wait until it is the active editor. */
  async function focusFile(file) {
    const uri = vscode.Uri.file(file);
    // Shown, not just opened: `vscode.open` can return before the editor has
    // focus, so the activeTextEditor wait below raced its budget and failed a
    // full-suite run under load. showTextDocument resolves once it is shown.
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
      preview: false,
    });
    await waitFor(
      `${path.basename(file)} becomes the active editor`,
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      15_000,
    );
    return uri;
  }

  it('compiles the skill entry into the subfolder and the proving run serves it as code', async () => {
    fs.rmSync(testStepsFile, { force: true });
    fs.rmSync(skillStepsFile, { force: true });
    fs.rmSync(testCacheDir, { recursive: true, force: true });
    fs.rmSync(skillCacheDir, { recursive: true, force: true });
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }

    const uri = await focusFile(testFile);
    await waitFor('tracker recognises the test file', () => hooks.tracker.snapshot().isTestFile);
    await vscode.commands.executeCommand('testbench-native.restartSession');
    await sleep(1_000);

    // ===== Run & Compile =====
    void vscode.commands.executeCommand('testbench-native.runAndCompile');
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
    assert.equal(
      proposed.length,
      2,
      `a test with one own step and one subfolder-skill step must propose two files, got ` +
        `${proposed.length}: ${Object.keys(proposal.files).join(', ')}`,
    );

    const testProposal = proposed.find(([p]) => samePath(p, testStepsFile));
    const skillProposal = proposed.find(([p]) => samePath(p, skillStepsFile));
    assert.ok(
      testProposal,
      `one proposed file must be the test's sibling ${testStepsFile}, got ${Object.keys(proposal.files).join(', ')}`,
    );
    assert.ok(
      skillProposal,
      `one proposed file must be the skill's OWN steps file in its subfolder, ` +
        `${skillStepsFile}, got ${Object.keys(proposal.files).join(', ')}`,
    );
    assert.match(testProposal[1], /defineSteps\(\[/);
    assert.match(skillProposal[1], /defineSteps\(\[/);
    assert.match(
      testProposal[1],
      /source: ['"]Navigate to the baseUrl['"]/,
      "the test's own step compiles into the test's file",
    );
    assert.match(
      skillProposal[1],
      /in the email field/,
      "the skill-body step's entry must land in the skill's file",
    );
    assert.doesNotMatch(
      testProposal[1],
      /in the email field/,
      "the skill-body entry must NOT also land in the test's file",
    );
    // Nothing on disk yet — the diff is the whole point.
    assert.equal(fs.existsSync(testStepsFile), false, 'a compile must not write the test file itself');
    assert.equal(fs.existsSync(skillStepsFile), false, 'a compile must not write the skill file itself');

    // The subfolder claim, made before Apply: the compile's own recording of
    // the skill's proposal sits in the cache dir beside the SKILL, in its
    // subfolder — not in the test's, and not at skillsDir's root. Every cache
    // path derives from the binding's file, so this is where a wrong (flat)
    // derivation would show up first.
    const skillCandidate = path.join(skillCacheDir, 'enter_email.steps.ts.candidate');
    assert.ok(
      fs.existsSync(skillCandidate),
      `the skill's candidate must be recorded beside the skill file, at ${skillCandidate}`,
    );
    assert.equal(
      fs.readFileSync(skillCandidate, 'utf-8'),
      skillProposal[1],
      'the recorded candidate must be the proposal verbatim',
    );

    // ===== Apply =====
    await vscode.commands.executeCommand('testbench-native.applyCodeBehind');
    await waitFor(
      'Apply writes both .steps.ts files',
      () => fs.existsSync(testStepsFile) && fs.existsSync(skillStepsFile),
      15_000,
    );
    assert.equal(fs.readFileSync(testStepsFile, 'utf-8'), testProposal[1], 'Apply must write the test file verbatim');
    assert.equal(fs.readFileSync(skillStepsFile, 'utf-8'), skillProposal[1], 'Apply must write the skill file verbatim');
    assert.equal(hooks.pendingCodeBehind(), null, 'Apply must consume the proposal');
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

    // Bound as code (</>) or healed stale (⚠) — same tolerance as the flat
    // compile test: a plain "pass" means the entry was never consulted.
    const testStatuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    assert.ok(
      testStatuses[TEST_STEP_LINE] === 'pass-code-behind' || testStatuses[TEST_STEP_LINE] === 'pass-stale',
      `test step line ${TEST_STEP_LINE} should have run its entry (</> or ⚠), got "${testStatuses[TEST_STEP_LINE]}"`,
    );
    const aggregate = testStatuses[SKILL_INVOCATION_LINE];
    assert.ok(
      aggregate === 'pass' || aggregate === 'pass-code-behind' || aggregate === 'pass-stale',
      `the [skill:] aggregate row (line ${SKILL_INVOCATION_LINE}) must show a passing state, got "${aggregate}"`,
    );

    // The subfolder proof: the SKILL file's own step line carries the
    // code-behind outcome — its entry was found beside the skill, imported
    // from the subfolder, and executed.
    await focusFile(skillFile);
    // The tracker re-keys its statuses to the newly active editor; the active
    // editor changing is not the same event as that swap landing. Wait for the
    // skill's own line to carry a status before reading, like the sibling
    // suite's settled-state waits.
    await waitFor(
      `the tracker reports a status for skill line ${SKILL_STEP_LINE}`,
      () => hooks.tracker.snapshot().statuses.some(([line]) => line === SKILL_STEP_LINE),
      15_000,
    );
    const skillStatuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    assert.ok(
      skillStatuses[SKILL_STEP_LINE] === 'pass-code-behind' || skillStatuses[SKILL_STEP_LINE] === 'pass-stale',
      `skill body line ${SKILL_STEP_LINE} should have run its entry (</> or ⚠), got "${skillStatuses[SKILL_STEP_LINE]}"`,
    );
    assert.ok(
      testStatuses[TEST_STEP_LINE] === 'pass-code-behind' || skillStatuses[SKILL_STEP_LINE] === 'pass-code-behind',
      `at least one entry must prove as code (</>); got test="${testStatuses[TEST_STEP_LINE]}", ` +
        `skill="${skillStatuses[SKILL_STEP_LINE]}" — all-stale means no generated entry ever works.`,
    );

    await vscode.commands.executeCommand('testbench-native.restartSession');
  });
});

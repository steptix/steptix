/**
 * Live Run & Compile for the MFA countdown wait
 * (docs/specs/SPEC-aria-ref-snapshots.md §9.2).
 *
 * The verification field appears 15s after load while the status line ticks
 * every second. Local snapshot diffing should absorb that tick in a handful
 * of actions, and the compiled wait must keep a timeout of at least 30s with
 * no snapshot ref (`aria-ref=`, `getByRef`, `eN`) left in the `.steps.ts`.
 *
 * The suite opts this workspace into `browser.snapshotMode: "aria"` for its
 * own run and puts the file back afterwards. A server process that was itself
 * started with `STEPTIX_SNAPSHOT_MODE` forces that value over the file
 * (`withEnvDefaults`), so leave that variable unset when running this file.
 *
 * Local by construction: `fixtures/test-app` on port 8787.
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const { EXT_ID } = require('../extension-id.cjs');
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

/** 1-based line numbers of the numbered steps, read before a run appends history. */
function stepLineNumbers(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\d+\.\s/.test(lines[i])) out.push(i + 1);
  }
  return out;
}

function assertNoEphemeralRefs(content, label) {
  assert.doesNotMatch(content, /aria-ref=/, `${label} must not contain aria-ref=`);
  assert.doesNotMatch(content, /data-steptix-ref/, `${label} must not contain data-steptix-ref`);
  assert.doesNotMatch(content, /\.getByRef\s*\(/, `${label} must not call getByRef`);
  assert.doesNotMatch(
    content,
    /['"](?:f\d+)?e\d+['"]/,
    `${label} must not quote a snapshot ref`,
  );
  assert.doesNotMatch(content, /['"]s\d+['"]/, `${label} must not quote a supplementary ref`);
}

/**
 * Point the workspace the shard is driving at aria snapshots. Returns a
 * restore function. The server reads this file per request, so a server that
 * booted on the `dom` default still honours it.
 */
function enableAriaSnapshots(workspaceRoot) {
  const configPath = path.join(workspaceRoot, 'init', 'steptix.config.json');
  const original = fs.readFileSync(configPath, 'utf8');
  const json = JSON.parse(original);
  json.browser = { ...(json.browser ?? {}), snapshotMode: 'aria' };
  fs.writeFileSync(configPath, `${JSON.stringify(json, null, 2)}\n`);
  return () => fs.writeFileSync(configPath, original);
}

describe('Steptix live — aria snapshot MFA countdown wait', function () {
  this.timeout(900_000);

  /** @type {import('../../../dist/extension/extension').SteptixTestHooks} */
  let hooks;
  /** @type {import('node:child_process').ChildProcess | null} */
  let testApp = null;
  let startedApp = false;
  let restoreConfig = () => {};
  let testFile;
  let stepsFile;
  let cacheDir;
  let recordingDir;
  let stepLines;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks missing — activation may have failed');

    const serverUrl = process.env.LIVE_STEPTIX_SERVER_URL || 'http://localhost:3100';
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
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — the live runner must pass templates/');
    restoreConfig = enableAriaSnapshots(workspaceRoot);
    testFile = path.resolve(workspaceRoot, 'init', 'tests', 'aria-mfa-wait.md');
    assert.ok(fs.existsSync(testFile), `aria-mfa-wait.md not found at ${testFile}`);
    stepsFile = testFile.replace(/\.md$/, '.steps.ts');
    cacheDir = path.join(path.dirname(testFile), '.steptix-codebehind-cache');
    recordingDir = path.join(cacheDir, 'aria-mfa-wait.recording');
    stepLines = stepLineNumbers(testFile);
    assert.equal(stepLines.length, 4, `expected 4 steps, got ${stepLines.length}`);
  });

  after(async () => {
    try {
      restoreConfig();
    } catch {
      /* the config restore is best-effort; the assertion already ran */
    }
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

  async function focusTestFile() {
    const uri = vscode.Uri.file(testFile);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
      preview: false,
    });
    await waitFor(
      'aria-mfa-wait.md becomes the active editor',
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      15_000,
    );
    await waitFor('tracker recognises the test file', () => hooks.tracker.snapshot().isTestFile);
    return uri;
  }

  it('waits out the ticking countdown in a few actions and compiles a durable wait', async () => {
    fs.rmSync(stepsFile, { force: true });
    fs.rmSync(path.join(cacheDir, 'aria-mfa-wait.recording'), { recursive: true, force: true });
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }

    const uri = await focusTestFile();
    await vscode.commands.executeCommand('steptix.restartSession');
    await sleep(1_000);

    void vscode.commands.executeCommand('steptix.runAndCompile');
    await waitFor(
      'the compile proposes files for the MFA wait',
      () => hooks.pendingCodeBehind()?.testFilePath.toLowerCase() === testFile.toLowerCase(),
      720_000,
    );

    const proposal = hooks.pendingCodeBehind();
    const proposed = Object.entries(proposal.files);
    assert.equal(proposed.length, 1, `expected one proposed file, got ${proposed.length}`);
    const [proposedPath, content] = proposed[0];
    assert.equal(path.basename(proposedPath), 'aria-mfa-wait.steps.ts');
    assert.match(content, /defineSteps\(\[/);
    assertNoEphemeralRefs(content, 'aria-mfa-wait.steps.ts');
    const timeouts = [...content.matchAll(/timeout:\s*(\d+)/g)].map((m) => Number(m[1]));
    assert.ok(
      timeouts.some((n) => n >= 30_000),
      `the compiled wait must keep a timeout of at least 30000ms, got ${JSON.stringify(timeouts)}\n${content}`,
    );

    const waitStepPath = path.join(recordingDir, 'step-02.json');
    assert.ok(fs.existsSync(waitStepPath), 'step 2 recording should be on disk before Apply');
    const waitStep = JSON.parse(fs.readFileSync(waitStepPath, 'utf8'));
    assert.equal(waitStep.status, 'passed', `the countdown wait should pass, got ${waitStep.status}`);
    assert.ok(
      waitStep.actions.length <= 4,
      `the ticking countdown should stay a local poll, not a turn per second; ` +
        `step 2 took ${waitStep.actions.length} actions`,
    );
    assert.ok(
      waitStep.durationMs >= 8_000,
      `the code field appears 15s after load; step 2 finished in ${waitStep.durationMs}ms`,
    );
    assert.ok(
      waitStep.actions.some((a) => a && (a.ref || a.waitType === 'change' || a.action === 'wait')),
      `step 2 should have waited by ref, got ${JSON.stringify(waitStep.actions.map((a) => a.action))}`,
    );

    await vscode.commands.executeCommand('steptix.applyCodeBehind');
    await waitFor('Apply writes aria-mfa-wait.steps.ts', () => fs.existsSync(stepsFile), 15_000);
    assertNoEphemeralRefs(fs.readFileSync(stepsFile, 'utf8'), 'applied aria-mfa-wait.steps.ts');
    await waitFor(
      'focus returns to the MFA test after Apply',
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      15_000,
    );

    await vscode.commands.executeCommand('steptix.restartSession');
    await sleep(1_000);
    void vscode.commands.executeCommand('steptix.runAll');
    await waitFor('the proving run starts', () => hooks.isRunning(), 60_000);
    await waitFor('the proving run finishes', () => !hooks.isRunning(), 300_000);

    const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    for (const line of stepLines) {
      assert.ok(
        statuses[line] === 'pass-code-behind' || statuses[line] === 'pass-stale',
        `line ${line} should have run its entry (</> or ⚠), got "${statuses[line]}"`,
      );
    }
    assert.ok(
      stepLines.some((line) => statuses[line] === 'pass-code-behind'),
      `at least one MFA step must prove as code (</>); got ${JSON.stringify(stepLines.map((line) => statuses[line]))}`,
    );

    await vscode.commands.executeCommand('steptix.restartSession');
  });
});

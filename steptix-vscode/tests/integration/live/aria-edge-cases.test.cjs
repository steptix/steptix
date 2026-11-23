/**
 * Live Run & Compile for the aria-snapshot edge fixtures
 * (docs/specs/SPEC-aria-ref-snapshots.md §9.2):
 *
 *   - aria-edge-cases.html — overlay on <html>, shadow roots, styled
 *     checkbox, progress-bar chain, drag, transient status, covered field.
 *     The recording must not contain the vault passphrase.
 *   - documents.html — Choose file over a hidden <input type="file">.
 *   - nested-iframes.html — a chat field two frames down, compiled to a
 *     frame locator.
 *
 * Each file is compiled, applied, and proved. Snapshot refs must not survive
 * into the `.steps.ts`. The suite opts the workspace into
 * `browser.snapshotMode: "aria"` and restores it. Leave
 * `STEPTIX_SNAPSHOT_MODE` unset: a server started with it forces that value
 * over the file.
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const { EXT_ID } = require('../extension-id.cjs');
const TEST_APP_PORT = 8787;
const VAULT_PASSPHRASE = 'aria-edge-cases-fixture-password';

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
  assert.doesNotMatch(content, /['"](?:f\d+)?e\d+['"]/, `${label} must not quote a snapshot ref`);
  assert.doesNotMatch(content, /['"]s\d+['"]/, `${label} must not quote a supplementary ref`);
}

function enableAriaSnapshots(workspaceRoot) {
  const configPath = path.join(workspaceRoot, 'init', 'steptix.config.json');
  const original = fs.readFileSync(configPath, 'utf8');
  const json = JSON.parse(original);
  json.browser = { ...(json.browser ?? {}), snapshotMode: 'aria' };
  fs.writeFileSync(configPath, `${JSON.stringify(json, null, 2)}\n`);
  return () => fs.writeFileSync(configPath, original);
}

/** Every text file in the recording, so a masked password cannot hide in one of them. */
function recordingText(dir) {
  if (!fs.existsSync(dir)) return '';
  const chunks = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;
    chunks.push(fs.readFileSync(full, 'utf8'));
  }
  return chunks.join('\n');
}

describe('Steptix live — aria snapshot edge cases', function () {
  this.timeout(1_200_000);

  /** @type {import('../../../dist/extension/extension').SteptixTestHooks} */
  let hooks;
  /** @type {import('node:child_process').ChildProcess | null} */
  let testApp = null;
  let startedApp = false;
  let restoreConfig = () => {};
  let testsDir;
  let cacheDir;

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
    testsDir = path.resolve(workspaceRoot, 'init', 'tests');
    cacheDir = path.join(testsDir, '.steptix-codebehind-cache');
  });

  after(async () => {
    try {
      restoreConfig();
    } catch {
      /* best-effort */
    }
    for (const name of ['aria-edge-cases', 'aria-hidden-file', 'aria-nested-frames']) {
      fs.rmSync(path.join(testsDir, `${name}.steps.ts`), { force: true });
      fs.rmSync(path.join(cacheDir, `${name}.recording`), { recursive: true, force: true });
      fs.rmSync(path.join(cacheDir, `${name}.steps.ts.candidate`), { force: true });
    }
    if (startedApp && testApp) {
      try {
        cp.execSync(`taskkill /pid ${testApp.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        testApp.kill();
      }
    }
  });

  /**
   * Run & Compile one fixture, assert the proposal, Apply, and prove the
   * next run bound the entries. `check` sees the proposal text.
   */
  async function compileAndProve(baseName, check) {
    const testFile = path.join(testsDir, `${baseName}.md`);
    const stepsFile = testFile.replace(/\.md$/, '.steps.ts');
    const recordingDir = path.join(cacheDir, `${baseName}.recording`);
    assert.ok(fs.existsSync(testFile), `${baseName}.md not found at ${testFile}`);
    const lines = stepLineNumbers(testFile);
    assert.ok(lines.length > 0, `${baseName}.md has no steps`);

    fs.rmSync(stepsFile, { force: true });
    fs.rmSync(recordingDir, { recursive: true, force: true });
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }

    const uri = vscode.Uri.file(testFile);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
      preview: false,
    });
    await waitFor(
      `${baseName}.md becomes the active editor`,
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      15_000,
    );
    await waitFor('tracker recognises the test file', () => hooks.tracker.snapshot().isTestFile);

    await vscode.commands.executeCommand('steptix.restartSession');
    await sleep(1_000);

    void vscode.commands.executeCommand('steptix.runAndCompile');
    await waitFor(
      `the compile proposes files for ${baseName}`,
      () => hooks.pendingCodeBehind()?.testFilePath.toLowerCase() === testFile.toLowerCase(),
      900_000,
    );

    const proposal = hooks.pendingCodeBehind();
    const proposed = Object.entries(proposal.files);
    assert.equal(proposed.length, 1, `expected one proposed file, got ${proposed.length}`);
    const [proposedPath, content] = proposed[0];
    assert.equal(path.basename(proposedPath), `${baseName}.steps.ts`);
    assert.match(content, /defineSteps\(\[/);
    assertNoEphemeralRefs(content, `${baseName}.steps.ts`);
    assert.doesNotMatch(
      content,
      new RegExp(VAULT_PASSPHRASE),
      `${baseName}.steps.ts must not contain the vault passphrase`,
    );
    if (check) check({ content, recordingDir });

    await vscode.commands.executeCommand('steptix.applyCodeBehind');
    await waitFor(`Apply writes ${baseName}.steps.ts`, () => fs.existsSync(stepsFile), 15_000);
    assertNoEphemeralRefs(fs.readFileSync(stepsFile, 'utf8'), `applied ${baseName}.steps.ts`);
    await waitFor(
      `focus returns to ${baseName}.md after Apply`,
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      15_000,
    );

    await vscode.commands.executeCommand('steptix.restartSession');
    await sleep(1_000);
    void vscode.commands.executeCommand('steptix.runAll');
    await waitFor('the proving run starts', () => hooks.isRunning(), 60_000);
    await waitFor('the proving run finishes', () => !hooks.isRunning(), 300_000);

    const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    for (const line of lines) {
      assert.ok(
        statuses[line] === 'pass-code-behind' || statuses[line] === 'pass-stale',
        `${baseName} line ${line} should have run its entry (</> or ⚠), got "${statuses[line]}"`,
      );
    }
    assert.ok(
      lines.some((line) => statuses[line] === 'pass-code-behind'),
      `at least one ${baseName} step must prove as code (</>); got ${JSON.stringify(
        lines.map((line) => statuses[line]),
      )}`,
    );

    await vscode.commands.executeCommand('steptix.restartSession');
  }

  it('compiles the edge-case page and keeps the vault passphrase out of the recording', async () => {
    await compileAndProve('aria-edge-cases', ({ recordingDir }) => {
      const text = recordingText(recordingDir);
      assert.ok(text.length > 0, 'the edge-case recording should be on disk');
      assert.ok(
        !text.includes(VAULT_PASSPHRASE),
        'the recording must mask the vault passphrase',
      );
    });
  });

  it('compiles an upload through the hidden file input', async () => {
    await compileAndProve('aria-hidden-file');
  });

  it('compiles a nested-frame action to a frame locator', async () => {
    await compileAndProve('aria-nested-frames', ({ content }) => {
      assert.match(
        content,
        /frameLocator\s*\(/,
        `a frame-scoped ref must compile to frameLocator, got:\n${content}`,
      );
    });
  });
});

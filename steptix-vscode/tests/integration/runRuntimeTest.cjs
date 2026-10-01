// Launches VS Code for the installed-runtime end-to-end test,
// tests/integration/runtime/installed-runtime.test.cjs.
//
// Not a runner of its own: scripts/verify-runtime.mjs calls it once it has
// installed the installer under test, and supplies the environment that test
// needs (see the test's header). It reuses the live suite's mocha entry and
// its JSON report — STEPTIX_LIVE_FILES names files relative to live/, and the
// test sits beside that directory so `npm run test:live` never discovers it.
const path = require('node:path');
const cp = require('node:child_process');
const fs = require('node:fs');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');

/** Pinned with runTest.cjs and runLiveTest.cjs. */
const VERSION = '1.95.0';

/** Long enough for a cold server start, Chrome and the run; short enough that a
 *  hung window fails the installer build rather than holding it forever. */
const LAUNCH_TIMEOUT_MS = 10 * 60_000;

/**
 * Run the installed-runtime test in a fresh VS Code.
 *
 * `env` is the whole environment, not an overlay: the test depends on what is
 * ABSENT from it (STEPTIX_NODE, an API key), so the caller builds it.
 * `userDataDir` and `extensionsDir` must be new directories — a VS Code
 * sharing a user-data-dir forwards its arguments to the running instance and
 * exits (see runLiveTest.cjs launchVSCode).
 *
 * Resolves to `{ status, output, report }`. `report` is null when VS Code
 * wrote none, which the caller must treat as a failure: VS Code can exit 0
 * without ever running the test entry.
 */
async function runInstalledRuntimeTest({
  workspacePath, userDataDir, extensionsDir, reportPath, logPath, env,
}) {
  // The cache the other runners use. Its default is relative to the working
  // directory, and this is called from the repo root.
  const codeExe = await downloadAndUnzipVSCode({
    version: VERSION,
    cachePath: path.resolve(__dirname, '..', '..', '.vscode-test'),
  });
  const cliJs = path.join(path.dirname(codeExe), 'resources', 'app', 'out', 'cli.js');
  fs.rmSync(reportPath, { force: true });
  fs.rmSync(logPath, { force: true });

  const args = [
    cliJs,
    '--wait',
    workspacePath,
    '--extensionDevelopmentPath=' + path.resolve(__dirname, '..', '..'),
    '--extensionTestsPath=' + path.resolve(__dirname, 'live', 'index.cjs'),
    '--user-data-dir=' + userDataDir,
    '--extensions-dir=' + extensionsDir,
    '--disable-workspace-trust',
  ];

  const status = await new Promise((resolve) => {
    const chunks = [];
    const proc = cp.spawn(codeExe, args, {
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
        ELECTRON_ENABLE_LOGGING: '1',
        STEPTIX_TEST_REPORT: reportPath,
        STEPTIX_LIVE_LOG: logPath,
        STEPTIX_LIVE_FILES: '../runtime/installed-runtime.test.cjs',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (b) => chunks.push(b));
    proc.stderr.on('data', (b) => chunks.push(b));
    const timer = setTimeout(() => {
      chunks.push(Buffer.from(`\n[runRuntimeTest] VS Code still running after ${LAUNCH_TIMEOUT_MS / 1000}s — killed\n`));
      cp.spawnSync('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }, LAUNCH_TIMEOUT_MS);
    proc.on('error', (err) => {
      clearTimeout(timer);
      chunks.push(Buffer.from(`spawn failed: ${err.message}\n`));
      resolve({ code: -1, output: Buffer.concat(chunks).toString('utf8') });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output: Buffer.concat(chunks).toString('utf8') });
    });
  });

  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch {
    /* null: no report is the caller's failure to name */
  }
  return { status: status.code, output: status.output, report };
}

module.exports = { runInstalledRuntimeTest };

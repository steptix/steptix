// Live integration runner. Like runTest.cjs, but:
//  - workspace = ../../templates so .env walk-up from
//    init/tests/securebank.md reaches templates/.env
//  - test entry = tests/integration/live/index.cjs
//  - much longer timeouts; the run actually opens a real browser
//  - boots fixtures/test-app on :8787, the site the browser-driving live
//    suites point at (see startTestApp below)
//
// Prereq: ai-ui-automation Sessions API server is running locally
// (e.g. `npm run dev` from the repo root, listening on
// http://localhost:3100 with the AIUI_SERVER_API_KEY from templates/.env).
const path = require('node:path');
const cp = require('node:child_process');
const fs = require('node:fs');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');

const VERSION = '1.95.0';

// The fixture app's port is baked into each fixture's `## Config` baseUrl
// (and into every tests/integration/*.md in the repo root), so it is pinned
// rather than allocated. That is also why we adopt an already-listening
// server instead of failing on EADDRINUSE: a developer with the app already
// running — or a concurrent live run in another worktree — is serving the
// same static fixture, and two runs sharing it is harmless. It holds no
// per-run state that one run could corrupt for another.
const TEST_APP_PORT = 8787;
const TEST_APP_URL = `http://127.0.0.1:${TEST_APP_PORT}`;

async function isTestAppUp() {
  try {
    const res = await fetch(`${TEST_APP_URL}/api/csrf-token`);
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Start fixtures/test-app unless something is already serving it.
 *
 * Returns a stop() that kills only a server WE spawned — adopting someone
 * else's and then killing it would break the session they were using.
 */
async function startTestApp(repoRoot) {
  if (await isTestAppUp()) {
    console.log(`  test app:  already running at ${TEST_APP_URL} (adopted)`);
    return () => {};
  }

  const serverPath = path.join(repoRoot, 'fixtures', 'test-app', 'server.ts');
  if (!fs.existsSync(serverPath)) {
    throw new Error(`fixture test app not found at ${serverPath}`);
  }

  const proc = cp.spawn(process.execPath, ['--import', 'tsx', serverPath], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(TEST_APP_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr?.on('data', (b) => process.stderr.write(`[test-app] ${b}`));

  // A spawned child and its stdio pipes each hold a ref on our event loop.
  // Without these unrefs the runner never exits after a PASSING run: the
  // suite finishes, the report is written, and then node sits forever with
  // nothing to do but a live child handle — which also means the
  // process.on('exit') cleanup below never fires, so the app leaks too.
  // Only bites when we spawned the app; an adopted one has no child handle,
  // which is why this hid behind whichever suite ran second.
  proc.unref();
  proc.stderr?.unref();

  // Surface an immediate spawn failure (missing tsx, syntax error) as itself
  // rather than as an opaque 30s readiness timeout.
  let exited = null;
  proc.on('exit', (code, signal) => { exited = { code, signal }; });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `test app exited before becoming ready (code=${exited.code} signal=${exited.signal})`,
      );
    }
    if (await isTestAppUp()) {
      console.log(`  test app:  started at ${TEST_APP_URL} (pid ${proc.pid})`);
      return () => {
        if (proc.killed || exited) return;
        proc.kill('SIGTERM');
      };
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  proc.kill('SIGKILL');
  throw new Error(`test app did not become ready at ${TEST_APP_URL} within 30s`);
}

/** Set once the fixture app is up; invoked on every exit path. */
let stopTestApp = () => {};
process.on('exit', () => stopTestApp());

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
    const extensionTestsPath = path.resolve(__dirname, 'live', 'index.cjs');
    // Workspace = repo's templates/ directory. The fixtures the live suites
    // drive sit in templates/init/tests/, .env sits in templates/. With this
    // workspace the env walkup terminates at templates/ and finds the .env.
    const workspacePath = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'templates',
    );
    const repoRoot = path.resolve(__dirname, '..', '..', '..');

    if (!fs.existsSync(path.join(workspacePath, '.env'))) {
      console.error(
        `templates/.env not found at ${workspacePath}. The live test ` +
          `requires SERVER_URL, AIUI_SERVER_API_KEY, AI_API_KEY in that file.`,
      );
      process.exit(2);
    }

    // Before VS Code, so a fixture-app failure reports as itself rather than
    // as nine browser steps timing out against a dead port.
    stopTestApp = await startTestApp(repoRoot);

    const codeExe = await downloadAndUnzipVSCode(VERSION);
    const installRoot = path.dirname(codeExe);
    const userDataDir = path.join(installRoot, '..', 'user-data-live');
    const extensionsDir = path.join(installRoot, '..', 'extensions-live');

    const cliJs = path.join(installRoot, 'resources', 'app', 'out', 'cli.js');

    const args = [
      cliJs,
      '--wait',
      workspacePath,
      '--extensionDevelopmentPath=' + extensionDevelopmentPath,
      '--extensionTestsPath=' + extensionTestsPath,
      '--user-data-dir=' + userDataDir,
      '--extensions-dir=' + extensionsDir,
      '--disable-workspace-trust',
    ];

    console.log('Launching live test:', codeExe);
    console.log('  workspace:', workspacePath);
    console.log('  test suite:', extensionTestsPath);

    const reportPath = path.resolve(__dirname, 'live-test-report.json');
    const liveLogPath = path.resolve(__dirname, 'live-test-output.log');
    try { fs.rmSync(reportPath, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(liveLogPath, { force: true }); } catch { /* ignore */ }

    const result = cp.spawnSync(codeExe, args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        TESTBENCH_FIXTURES_DIR: workspacePath,
        TESTBENCH_TEST_REPORT: reportPath,
        TESTBENCH_LIVE_LOG: liveLogPath,
        ELECTRON_ENABLE_LOGGING: '1',
        LIVE_SERVER_URL: process.env.LIVE_SERVER_URL || 'http://localhost:3100',
      },
    });

    // VS Code has exited, so nothing needs the fixture app any more. Stop it
    // here rather than leaving it to the exit hook: this path is the common
    // one, and an explicit call keeps teardown deterministic instead of
    // depending on how node happens to drain its handles.
    stopTestApp();
    stopTestApp = () => {};

    // Same reasoning as the counted-skips note below, one level up: the report
    // is the only evidence the suite ran. VS Code can exit 0 without ever
    // invoking the test entry, so a missing report is a failure, not a note.
    let report;
    try {
      report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    } catch (err) {
      console.error('No live test report written:', err.message);
      console.error(
        `VS Code exited with code ${result.status}, but no suite results were ` +
          'recorded. Failing: this run proved nothing.',
      );
      process.exit(1);
    }

    console.log('\n--- Live test report ---');
    for (const r of report.results) {
      const tag = r.state === 'pass' ? '✓' : r.state === 'fail' ? '✗' : 'o';
      console.log(`  ${tag} ${r.suite} > ${r.title}`);
      if (r.state === 'fail' && r.err) console.log(r.err);
    }
    const skipped = report.results.filter((r) => r.state === 'pending').length;
    console.log(
      `\n${report.results.length} tests, ${report.failures} failures` +
        // Counted out loud: a skipped scenario is one nobody checked, and a
        // silent one reads as a scenario that passed.
        (skipped > 0 ? `, ${skipped} skipped` : ''),
    );

    if (report.results.length === 0) {
      console.error('Live test report contains zero tests — nothing was verified.');
      process.exit(1);
    }
    if (report.failures > 0) {
      console.error(`${report.failures} live test(s) failed.`);
      process.exit(1);
    }

    if (result.status !== 0) {
      console.error('live integration test failed with exit code', result.status);
      try {
        const liveLog = fs.readFileSync(liveLogPath, 'utf8');
        console.error('\n--- TestBench OutputChannel log ---');
        console.error(liveLog || '(empty)');
      } catch (err) {
        console.error('No live OutputChannel log captured:', err.message);
      }
      process.exit(result.status ?? 1);
    }
  } catch (err) {
    console.error('Failed to run live test', err);
    process.exit(1);
  }
}

main();

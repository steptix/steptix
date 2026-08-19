// Live integration runner. Like runTest.cjs, but:
//  - workspace = ../../templates so .env walk-up from
//    init/tests/github.md reaches templates/.env
//  - test entry = tests/integration/live/index.cjs
//  - much longer timeouts; the run actually opens a real browser
//
// Prereq: ai-ui-automation Sessions API server is running locally
// (e.g. `npm run dev` from the repo root, listening on
// http://localhost:3100 with the AIUI_SERVER_API_KEY from templates/.env).
const path = require('node:path');
const cp = require('node:child_process');
const fs = require('node:fs');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');

const VERSION = '1.95.0';

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
    const extensionTestsPath = path.resolve(__dirname, 'live', 'index.cjs');
    // Workspace = repo's templates/ directory. github.md sits in
    // templates/init/tests/, .env sits in templates/. With this workspace
    // the env walkup terminates at templates/ and finds the .env.
    const workspacePath = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'templates',
    );

    if (!fs.existsSync(path.join(workspacePath, '.env'))) {
      console.error(
        `templates/.env not found at ${workspacePath}. The live test ` +
          `requires SERVER_URL, AIUI_SERVER_API_KEY, AI_API_KEY, ` +
          `GITHUB_USERNAME, GITHUB_PASSWORD in that file.`,
      );
      process.exit(2);
    }

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

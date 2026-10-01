// Bootstrap script: download VS Code via @vscode/test-electron, then invoke
// it through the bin/code.cmd wrapper so CLI flags actually work on Windows.
// The default test-electron runner spawns Code.exe directly, which silently
// rejects every flag on Windows.
const path = require('node:path');
const cp = require('node:child_process');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');

const VERSION = '1.95.0';

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
    const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.cjs');
    const workspacePath = path.resolve(__dirname, 'fixtures');

    const codeExe = await downloadAndUnzipVSCode(VERSION);
    const installRoot = path.dirname(codeExe);
    const userDataDir = path.join(installRoot, '..', 'user-data');
    const extensionsDir = path.join(installRoot, '..', 'extensions');

    // Resolve the Electron CLI bootstrap script that ships inside VS Code's
    // app bundle. Spawning Code.exe with this script (via ELECTRON_RUN_AS_NODE)
    // is how Microsoft's own test-cli does it on Windows — Code.exe behaves
    // as a Node binary and the script is what wires up extension testing.
    const cliJs = path.join(installRoot, 'resources', 'app', 'out', 'cli.js');

    // Pass the fixtures dir as a folder arg so VS Code opens it as the
    // workspace. Without it, RunController.runLines() can't resolve
    // workspaceFolderFor(uri) and silently no-ops.
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

    require('./userSettings.cjs').pinUserSettings(userDataDir);

    console.log('Launching:', codeExe);
    console.log('  args:', args.join(' '));

    const reportPath = path.resolve(__dirname, 'test-report.json');
    try { require('node:fs').rmSync(reportPath, { force: true }); } catch { /* ignore */ }

    // Tee the extension's output channel to a file, the same way the live
    // runner does. VS Code exposes no way to read an OutputChannel back, so
    // without this the run log — the only place several messages exist at
    // all — is unassertable, and tests that reach for it silently no-op.
    //
    // Beside this script, not in the OS temp dir: the extension truncates the
    // file at its first getOutputChannel() and appends from there, so one
    // machine-global path means two fast suites — the two-worktree workflow
    // CLAUDE.md documents — wipe and interleave each other's log, and the
    // assertions that read it fail or, worse, pass on the other run's lines.
    // Removed before launch so a killed run's log can never be read as this
    // one's.
    const outputLogPath = path.resolve(__dirname, 'fast-suite-output.log');
    try { require('node:fs').rmSync(outputLogPath, { force: true }); } catch { /* ignore */ }

    const result = cp.spawnSync(codeExe, args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        STEPTIX_FIXTURES_DIR: workspacePath,
        STEPTIX_TEST_REPORT: reportPath,
        STEPTIX_LIVE_LOG: outputLogPath,
        ELECTRON_ENABLE_LOGGING: '1',
      },
    });

    // Print whatever the JSON reporter captured. ELECTRON_RUN_AS_NODE +
    // Mocha's spec reporter don't surface to stdout reliably on Windows;
    // the report file is the source of truth.
    // The report is also the only evidence the suite ran at all: VS Code can
    // exit 0 without ever invoking the extension test entry (a missing `mocha`
    // dependency does exactly that). So a missing report must FAIL — a run
    // that proved nothing must never look like a run where everything passed.
    let report;
    try {
      report = JSON.parse(require('node:fs').readFileSync(reportPath, 'utf8'));
    } catch (err) {
      console.error('No test report written (Mocha may not have run):', err.message);
      console.error(
        `VS Code exited with code ${result.status}, but no suite results were ` +
          'recorded. Failing: this run proved nothing.',
      );
      process.exit(1);
    }

    console.log('\n--- Test report ---');
    for (const r of report.results) {
      const tag = r.state === 'pass' ? '✓' : r.state === 'fail' ? '✗' : 'o';
      console.log(`  ${tag} ${r.suite} > ${r.title}`);
      if (r.state === 'fail' && r.err) console.log(r.err);
    }
    console.log(`\n${report.results.length} tests, ${report.failures} failures`);

    if (report.results.length === 0) {
      console.error('Test report contains zero tests — nothing was verified.');
      process.exit(1);
    }
    if (report.failures > 0) {
      console.error(`${report.failures} test(s) failed.`);
      process.exit(1);
    }
    if (result.status !== 0) {
      console.error('integration tests failed with exit code', result.status);
      process.exit(result.status ?? 1);
    }
  } catch (err) {
    console.error('Failed to run tests', err);
    process.exit(1);
  }
}

main();

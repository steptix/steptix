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

    const args = [
      cliJs,
      '--wait',
      '--extensionDevelopmentPath=' + extensionDevelopmentPath,
      '--extensionTestsPath=' + extensionTestsPath,
      '--user-data-dir=' + userDataDir,
      '--extensions-dir=' + extensionsDir,
      '--disable-workspace-trust',
    ];

    console.log('Launching:', codeExe);
    console.log('  args:', args.join(' '));

    const reportPath = path.resolve(__dirname, 'test-report.json');
    try { require('node:fs').rmSync(reportPath, { force: true }); } catch { /* ignore */ }

    const result = cp.spawnSync(codeExe, args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        TESTBENCH_FIXTURES_DIR: workspacePath,
        TESTBENCH_TEST_REPORT: reportPath,
        ELECTRON_ENABLE_LOGGING: '1',
      },
    });

    // Print whatever the JSON reporter captured. ELECTRON_RUN_AS_NODE +
    // Mocha's spec reporter don't surface to stdout reliably on Windows;
    // the report file is the source of truth.
    try {
      const report = JSON.parse(require('node:fs').readFileSync(reportPath, 'utf8'));
      console.log('\n--- Test report ---');
      for (const r of report.results) {
        const tag = r.state === 'pass' ? '✓' : r.state === 'fail' ? '✗' : 'o';
        console.log(`  ${tag} ${r.suite} > ${r.title}`);
        if (r.state === 'fail' && r.err) console.log(r.err);
      }
      console.log(`\n${report.results.length} tests, ${report.failures} failures`);
    } catch (err) {
      console.error('No test report written (Mocha may not have run):', err.message);
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

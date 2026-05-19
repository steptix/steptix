// Bootstrap for the @vscode/test-electron suite. Downloads a real VS Code,
// launches it via the bin/code.cmd wrapper (Code.exe rejects the flags
// directly on Windows), and runs Mocha inside the Extension Development Host.
//
// Mirrors testbench-native/tests/integration/runTest.cjs so both extensions
// share the same conventions for paths, env vars and report capture.
const path = require('node:path');
const cp = require('node:child_process');
const fs = require('node:fs');
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

    // Use VS Code's own cli.js script with ELECTRON_RUN_AS_NODE=1 — the
    // documented Windows-friendly invocation. Spawning Code.exe directly
    // drops CLI flags silently.
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

    console.log('Launching:', codeExe);
    console.log('  args:', args.join(' '));

    const reportPath = path.resolve(__dirname, 'test-report.json');
    try {
      fs.rmSync(reportPath, { force: true });
    } catch {
      /* ignore */
    }

    const result = cp.spawnSync(codeExe, args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        FLICK_TEST_REPORT: reportPath,
        ELECTRON_ENABLE_LOGGING: '1',
      },
    });

    // Mocha output isn't captured cleanly through ELECTRON_RUN_AS_NODE +
    // stdio:'inherit' on Windows; the JSON report file is the source of truth.
    try {
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
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

// Mocha entry for the LIVE integration suite. Discovered by
// @vscode/test-electron when runLiveTest.cjs launches VS Code.
//
// Unlike tests/integration/suite/, this entry runs against the real
// ai-ui-automation Sessions API server (assumed running at the
// SERVER_URL in templates/.env). The single test exercises the
// pause / resume / pause sequence end-to-end including a real browser.
const path = require('node:path');
const fs = require('node:fs');
const Mocha = require('mocha');
const { glob } = require('glob');

async function run() {
  const mocha = new Mocha({
    ui: 'bdd',
    color: false,
    timeout: 240_000, // 4 min — browser launch + multiple AI-driven steps
  });

  // Optional scope: TESTBENCH_LIVE_GREP restricts the run to suites/tests
  // whose title matches (Mocha --grep). Useful for running one live test
  // (e.g. just the wait-timeout scenarios) without the others that need
  // GitHub creds. Unset → run all live tests.
  if (process.env.TESTBENCH_LIVE_GREP) {
    mocha.grep(process.env.TESTBENCH_LIVE_GREP);
  }

  const testsRoot = __dirname;
  const files = await glob('**/*.test.cjs', { cwd: testsRoot });
  for (const f of files) mocha.addFile(path.resolve(testsRoot, f));

  const reportPath = process.env.TESTBENCH_TEST_REPORT;
  /** @type {Array<{ suite: string; title: string; state: string; err?: string }>} */
  const results = [];

  return new Promise((resolve, reject) => {
    try {
      const runner = mocha.run((failures) => {
        if (reportPath) {
          try {
            fs.writeFileSync(
              reportPath,
              JSON.stringify({ failures, results }, null, 2),
            );
          } catch {
            /* best-effort */
          }
        }
        if (failures > 0) reject(new Error(`${failures} tests failed`));
        else resolve();
      });

      runner.on('pass', (test) => {
        results.push({
          suite: test.parent?.fullTitle?.() ?? '',
          title: test.title,
          state: 'pass',
        });
      });
      runner.on('fail', (test, err) => {
        results.push({
          suite: test.parent?.fullTitle?.() ?? '',
          title: test.title,
          state: 'fail',
          err: err?.stack || err?.message || String(err),
        });
      });
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { run };

// Mocha test entry — discovered by @vscode/test-electron.
const path = require('node:path');
const fs = require('node:fs');
const Mocha = require('mocha');
const { glob } = require('glob');

async function run() {
  const mocha = new Mocha({
    ui: 'bdd',
    color: false,
    timeout: 30_000,
  });

  const testsRoot = __dirname;
  const files = await glob('**/*.test.cjs', { cwd: testsRoot });
  for (const f of files) mocha.addFile(path.resolve(testsRoot, f));

  // Mocha's spec-reporter output isn't captured through ELECTRON_RUN_AS_NODE +
  // stdio:'inherit' on Windows, so a silent exit-0 is ambiguous (passed vs.
  // discovered zero). Dump a structured summary the runner script can read.
  // Path is set by runTest.cjs via env var.
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
      runner.on('pending', (test) => {
        results.push({
          suite: test.parent?.fullTitle?.() ?? '',
          title: test.title,
          state: 'pending',
        });
      });
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { run };

// Mocha test entry — discovered by @vscode/test-electron.
const path = require('node:path');
const fs = require('node:fs');
const Mocha = require('mocha');
const { glob } = require('glob');
const vscode = require('vscode');

const EXT_ID = 'pkent.steptix-vscode';

async function run() {
  const mocha = new Mocha({
    ui: 'bdd',
    color: false,
    timeout: 30_000,
  });

  const testsRoot = __dirname;
  const files = await glob('**/*.test.cjs', { cwd: testsRoot });
  for (const f of files) mocha.addFile(path.resolve(testsRoot, f));

  // Optional scoping for local iteration: `STEPTIX_GREP="..."` runs only the
  // tests whose title matches. Unset in CI, so the full suite runs.
  if (process.env.STEPTIX_GREP) mocha.grep(process.env.STEPTIX_GREP);

  // Run statuses now persist to a `.steptix/run-state.json` file in the
  // workspace folder, and the suite reuses one workspace folder across cases,
  // so without this the file would leak statuses across test cases (and across
  // separate runs). Wipe it before every test so each starts from the clean
  // slate it was written against.
  mocha.suite.beforeEach('reset persisted run state', function () {
    const ext = vscode.extensions.getExtension(EXT_ID);
    if (ext && ext.isActive && ext.exports?.__testHooks?.resetRunState) {
      ext.exports.__testHooks.resetRunState();
    }
  });

  // Mocha output isn't captured cleanly through ELECTRON_RUN_AS_NODE +
  // stdio:'inherit' on Windows, so dump a structured summary the runner
  // script can read. The path is set by runTest.cjs via env var.
  const reportPath = process.env.STEPTIX_TEST_REPORT;
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

// Mocha entry for the LIVE flick-vscode suite. Discovered by
// @vscode/test-electron when runLiveTest.cjs launches VS Code.
//
// Unlike tests/vscode/, this runs against a REAL ai-ui-automation Sessions
// API server (URL in FLICK_LIVE_API_URL, key in FLICK_LIVE_API_KEY) and a
// real test-app (URL in FLICK_LIVE_TEST_APP_URL). A real browser opens,
// real AI calls are made.
const path = require('node:path');
const fs = require('node:fs');
const Mocha = require('mocha');
const { glob } = require('glob');

async function run() {
  const mocha = new Mocha({
    ui: 'bdd',
    color: false,
    timeout: 240_000, // 4 min — browser launch + AI-driven step
  });

  const testsRoot = __dirname;
  const files = await glob('**/*.test.cjs', { cwd: testsRoot });
  for (const f of files) mocha.addFile(path.resolve(testsRoot, f));

  const reportPath = process.env.FLICK_TEST_REPORT;
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

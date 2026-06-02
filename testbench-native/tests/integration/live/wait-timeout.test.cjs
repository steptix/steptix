/**
 * Live end-to-end WAIT timeout-hint + abort-aware-wait test (issue 022).
 *
 * Drives generated fixtures against the REAL ai-ui-automation Sessions API
 * server (SERVER_URL from templates/.env, expected on http://localhost:3100) —
 * real browser, real AI calls. A small local HTTP server provides a page whose
 * "Ready now" element appears only after ~12s, so a wait that beats the old 10s
 * default can be proven to succeed.
 *
 * Covers (issue 022):
 *   1. STOP cancels a long in-flight wait promptly (abort-aware waits) — the
 *      run halts in seconds, not the ~120s the wait would otherwise run.
 *   2. The AI's timeout hint extends a conditional wait — a "wait up to 30s"
 *      for a never-appearing thing fails at ~30s, not the 10s default.
 *   3. Default preserved — a wait with no "up to N" wording fails at ~10s.
 *   4. Slow success — "wait up to 30s" for an element that appears at ~12s
 *      PASSES (the 10s default would have failed it).
 *
 * IMPORTANT: the live server runs the BUILT dist/, so rebuild (`npm run build`
 * at repo root) and restart the server before running, or these assertions test
 * stale server code.
 *
 * Timing note: scenarios 2–4 depend on the model emitting (or omitting) the
 * `timeout` hint from the step wording, so they're inherently a little
 * timing-sensitive; thresholds carry generous margins. Scenario 1 is robust (a
 * "wait 2 minutes" duration sleep is long regardless of the hint logic).
 *
 * NOT part of the fast suite. Run via: node tests/integration/runLiveTest.cjs
 * (auto-discovered by the glob).
 *
 * Required env (from templates/.env, via walk-up): SERVER_URL, SERVER_API_KEY,
 * AI_API_KEY.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const vscode = require('vscode');

const EXT_ID = 'pkent.testbench-native';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {
      // ignore — predicate transient errors are part of the wait
    }
    await sleep(150);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

/** Page whose #delayed / "Ready now" element appears only after ~12s. */
const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Wait Fixture</title></head>
<body><h1>Wait fixture</h1><button id="go">Go</button>
<script>
  setTimeout(function () {
    var d = document.createElement('div');
    d.id = 'delayed';
    d.textContent = 'Ready now';
    document.body.appendChild(d);
  }, 12000);
</script>
</body></html>`;

describe('TestBench live wait timeout-hint + abort-aware waits (issue 022)', function () {
  this.timeout(300_000);

  /** @type {import('../../../dist/extension/extension').TestBenchTestHooks} */
  let hooks;
  /** @type {http.Server} */
  let fixtureServer;
  let fixtureUrl;
  let testsDir;
  /** Generated fixture files to delete in after(). */
  const generated = [];

  /**
   * Write a fixture test file. Two steps: navigate to the local fixture, then
   * the wait under test. Returns the file URI + the 1-based source line of the
   * wait step (for status-transition timing).
   */
  function writeFixture(name, waitInstruction) {
    const lines = [
      `# ${name}`,
      '',
      '## Steps',
      '',
      `1. Navigate to ${fixtureUrl}`,
      `2. ${waitInstruction}`,
      '',
    ];
    const content = lines.join('\n');
    const file = path.join(testsDir, `${name}.gen.md`);
    fs.writeFileSync(file, content, 'utf8');
    generated.push(file);
    const waitLine = lines.findIndex((l) => l.startsWith('2. ')) + 1; // 1-based
    return { uri: vscode.Uri.file(file), waitLine };
  }

  /** Open + run a fixture from the top, returning once running. */
  async function startRun(uri) {
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('fixture is active editor', () => {
      const ed = vscode.window.activeTextEditor;
      return ed && ed.document.uri.toString() === uri.toString();
    });
    await waitFor('detected as test file', () => hooks.tracker.snapshot().isTestFile === true, 10_000);
    const ed = vscode.window.activeTextEditor;
    ed.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('isRunning', () => hooks.isRunning(), 30_000);
  }

  const statusOf = (line) => Object.fromEntries(hooks.tracker.snapshot().statuses)[line];
  const SETTLED = new Set(['pass', 'pass-cached', 'fail', 'stopped']);

  /** Run to natural completion, timing the wait step from running→settled. */
  async function timeWaitStep(uri, waitLine) {
    await startRun(uri);
    await waitFor('wait step starts', () => statusOf(waitLine) === 'running', 120_000);
    const t0 = Date.now();
    await waitFor('wait step settles', () => SETTLED.has(statusOf(waitLine)) || !hooks.isRunning(), 180_000);
    const waitMs = Date.now() - t0;
    await waitFor('run idle', () => !hooks.isRunning(), 30_000);
    return { waitMs, status: statusOf(waitLine) };
  }

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks missing — activation may have failed');

    const serverUrl = process.env.LIVE_SERVER_URL || 'http://localhost:3100';
    try {
      const res = await fetch(`${serverUrl}/sessions/healthcheck/steps`, { method: 'OPTIONS' });
      assert.ok(res.status === 204 || res.status === 200, `Server at ${serverUrl} not responding (status=${res.status})`);
    } catch (err) {
      throw new Error(
        `Live test requires the ai-ui-automation server running at ${serverUrl}. ` +
          `Rebuild dist (\`npm run build\`) and start it (\`npm run dev\` / \`aiui serve\`). ` +
          `Original: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Local fixture server (real port). Reachable from the aiui server's browser
    // since both are on localhost.
    fixtureServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
    fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/`;
    console.log('[live] wait fixture served at', fixtureUrl);

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — runLiveTest.cjs must pass templates/ as workspace');
    testsDir = path.resolve(workspaceRoot, 'init', 'tests');
    assert.ok(fs.existsSync(testsDir), `tests dir not found: ${testsDir}`);
  });

  after(async () => {
    for (const f of generated) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
    if (fixtureServer) await new Promise((r) => fixtureServer.close(r));
    // Release the browser session so we don't leak it across runs.
    try { await vscode.commands.executeCommand('testbench-native.restartSession'); } catch { /* ignore */ }
  });

  beforeEach(() => {
    if (vscode.debug.breakpoints.length > 0) vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    hooks.resetRunState?.();
  });

  // ── Scenario 1 — STOP cancels a long in-flight wait promptly ──────────
  it('stops a long (2-minute) in-flight wait near-instantly instead of running it out', async () => {
    const { uri, waitLine } = writeFixture('wait-abort', 'Wait for 2 minutes');
    await startRun(uri);

    // Wait until the 2-minute wait is actually in flight, then let it settle in.
    await waitFor('2-min wait in flight', () => statusOf(waitLine) === 'running', 120_000);
    await sleep(2_000);

    const t0 = Date.now();
    await vscode.commands.executeCommand('testbench-native.stop');
    await waitFor('run idle after stop', () => !hooks.isRunning(), 30_000);
    const stopLatencyMs = Date.now() - t0;
    console.log(`[live] stop → idle in ${stopLatencyMs}ms (wait was 120s)`);

    // The whole point of abort-aware waits: stop must NOT wait out the ~120s.
    assert.ok(stopLatencyMs < 20_000, `stop took ${stopLatencyMs}ms — expected the in-flight wait to be cancelled promptly`);

    // Bonus (ties to issue 021): the stopped run's report is recovered + marked aborted.
    await waitFor('report recovered', () => hooks.lastReportPath() != null, 20_000).catch(() => undefined);
    const reportPath = hooks.lastReportPath();
    if (reportPath && fs.existsSync(reportPath)) {
      assert.match(fs.readFileSync(reportPath, 'utf8'), /ABORTED/, 'recovered report should mark the run aborted');
    }
  });

  // ── Scenario 2 — the timeout hint extends a conditional wait ──────────
  it('honours an AI timeout hint: "wait up to 30s" for a never-appearing thing fails at ~30s, not 10s', async () => {
    const { uri, waitLine } = writeFixture(
      'wait-hint',
      "Wait up to 30 seconds for the text 'NeverShowsUpOnThisPage' to appear",
    );
    const { waitMs, status } = await timeWaitStep(uri, waitLine);
    console.log(`[live] hinted wait ran ${waitMs}ms, status=${status}`);

    assert.equal(status, 'fail', 'the never-appearing condition must fail the step');
    assert.ok(waitMs > 22_000, `wait ran only ${waitMs}ms — the 30s timeout hint was not honoured (default 10s?)`);
    assert.ok(waitMs < 70_000, `wait ran ${waitMs}ms — unexpectedly long (cap/regression?)`);
  });

  // ── Scenario 3 — default preserved (no hint → ~10s) ───────────────────
  it('preserves the 10s default when the step gives no "up to N" wording', async () => {
    const { uri, waitLine } = writeFixture(
      'wait-default',
      "Wait for an element matching the CSS selector #never-appears-default to become visible",
    );
    const { waitMs, status } = await timeWaitStep(uri, waitLine);
    console.log(`[live] default wait ran ${waitMs}ms, status=${status}`);

    assert.equal(status, 'fail', 'the never-appearing selector must fail the step');
    assert.ok(waitMs < 22_000, `wait ran ${waitMs}ms — expected ~10s default (was the hint set without "up to N"?)`);
  });

  // ── Scenario 4 — slow success past the 10s default ────────────────────
  it('lets a hinted wait SUCCEED on an element that appears at ~12s (the 10s default would fail)', async () => {
    const { uri, waitLine } = writeFixture(
      'wait-slow-success',
      "Wait up to 30 seconds for the text 'Ready now' to appear",
    );
    const { waitMs, status } = await timeWaitStep(uri, waitLine);
    console.log(`[live] slow-success wait ran ${waitMs}ms, status=${status}`);

    assert.ok(status === 'pass' || status === 'pass-cached', `expected the wait to succeed once the element appears (got ${status})`);
    assert.ok(waitMs > 10_000, `wait resolved in ${waitMs}ms — element appears at ~12s, so a pass under 10s is suspicious`);
    assert.ok(waitMs < 30_000, `wait took ${waitMs}ms — longer than expected`);
  });
});

/**
 * Live end-to-end test for the interaction highlight
 * (docs/specs/SPEC-interaction-highlight.md §10.2).
 *
 * The fixture (templates/highlight/tests/highlight-securebank.md) signs in to
 * the fixture app, reads the balance and counts the recent transactions, in a
 * project of its own whose steptix.config.json turns on `browser.highlight`,
 * per-action screenshots and `ai.sendScreenshots`. What only a live run can
 * say, through Steptix and the real server:
 *
 *  - the project's `browser.highlight` reaches the server's executor at all —
 *    the server spreads its OWN startup config and re-sources named keys only
 *    (src/config/run-settings.ts), so this is the check that the re-sourcing
 *    holds end to end;
 *  - every sub-action that types, clicks, reads or counts is marked in the
 *    report with the ring it asked for (`data-highlighted`, §11): `act` for
 *    typing and clicking, `read` for reading and counting, and nothing on the
 *    navigation, which touches no element;
 *  - each of those sub-actions has its own screenshot;
 *  - nothing the model was sent mentions `steptix-highlight`: not the DOM
 *    snapshot in its requests (capture-dom.js skips the ring's host), and the
 *    report's sub-action DOM snapshots neither.
 *
 * Pixels are deliberately not asserted: where the ring's fade is when a live
 * screenshot is taken is not deterministic (§4.2). The unit tests
 * (tests/highlight.test.ts, tests/highlight-paths.test.ts) cover pixels,
 * hiding from the model included.
 *
 * Why its own project: `browser.highlight` is a project setting, and turning it
 * on in templates/init/ would put rings in every other live test's report.
 * Like templates/video-record/, the project sits under templates/, so a
 * sharded run copies it into each shard's workspace with the rest; its config
 * has no path that climbs out, so `rebaseConfigPaths` has nothing to rewrite.
 *
 * Prereq: the API server on $LIVE_STEPTIX_SERVER_URL (the parallel runner starts
 * one per shard and points that shard's templates/.env at it) and the fixture
 * app on :8787 (runLiveTest.cjs boots it; this file starts it if nothing is
 * there).
 *
 * Run it alone with:
 *   cd steptix-vscode
 *   npm run test:live -- --files=highlight.test.cjs --shards=1
 *
 * If your shell drops the bare `--` (the PowerShell tool does), build and call
 * the runner directly: `npm run build`, then
 * `node tests/integration/runLiveTest.cjs --files=highlight.test.cjs --shards=1`.
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = 'pkent.steptix-vscode';
const TEST_APP_PORT = 8787;
const PROJECT = 'highlight';
const FIXTURE = 'highlight-securebank.md';
/** The host element's tag (HIGHLIGHT_TAG, src/browser/highlight.ts). */
const HIGHLIGHT_TAG = 'steptix-highlight';

/** The ring each kind of sub-action asks for. Kinds not listed must ask for none. */
const EXPECTED_RING = {
  click: 'act',
  type: 'act',
  select: 'act',
  hover: 'act',
  read: 'read',
  count: 'read',
};
/** Sub-actions that touch no element, and so never ask for a ring. */
const NO_RING = new Set(['navigate', 'back', 'forward', 'reload', 'wait', 'scroll', 'assert', 'noop', 'find', 'expand']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Say what was observed, into the shard's own log as well as stdout — the
 *  parallel runner discards a passing launch's stdout, so only the tee
 *  survives the run. (As in use-ai.test.cjs.) */
function say(line) {
  console.log(`[live] ${line}`);
  const file = process.env.STEPTIX_LIVE_LOG;
  if (!file) return;
  try {
    fs.appendFileSync(file, `[live] ${line}\n`);
  } catch {
    /* best effort */
  }
}

async function waitFor(label, predicate, timeoutMs = 60_000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch (err) {
      last = err;
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for: ${label}${last ? ` (last error: ${last.message})` : ''}`);
}

async function up(url) {
  try {
    const res = await fetch(url);
    return res.status > 0;
  } catch {
    return false;
  }
}

/** The text of an HTML-escaped report fragment, as the model was sent it. */
function unescapeHtml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Every sub-action in the report, in order: its action badge, the ring it
 * asked for (`data-highlighted`, absent when none), and whether it carries its
 * own "After action" screenshot. Read from the markup renderSubAction writes
 * (src/report/generator.ts): each `<div class="sub-action"…>` opens a row,
 * and the row runs to the next one.
 */
function subActionsIn(html) {
  const opens = [...html.matchAll(/<div class="sub-action"(?: data-highlighted="(act|read)")?>/g)];
  return opens.map((m, i) => {
    const end = i + 1 < opens.length ? opens[i + 1].index : html.length;
    const row = html.slice(m.index, end);
    const badge = /<span class="action-badge">([^<]*)<\/span>/.exec(row);
    return {
      action: badge ? unescapeHtml(badge[1]) : '(no badge)',
      highlighted: m[1] ?? null,
      screenshot: row.includes('alt="Sub-action screenshot"'),
    };
  });
}

/** Every message the report says a model was sent, unescaped. */
function aiRequestsIn(html) {
  return [...html.matchAll(/<pre class="ai-request-content">([\s\S]*?)<\/pre>/g)].map((m) => unescapeHtml(m[1]));
}

describe('Steptix live — the interaction highlight', function () {
  this.timeout(300_000);

  /** @type {import('../../../dist/extension/extension').SteptixTestHooks} */
  let hooks;
  /** @type {cp.ChildProcess | undefined} */
  let testApp;
  let startedApp = false;
  let projectRoot;
  let testFile;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks missing — activation may have failed');

    const serverUrl = process.env.LIVE_STEPTIX_SERVER_URL || 'http://localhost:3100';
    try {
      const res = await fetch(`${serverUrl}/sessions/healthcheck/steps`, { method: 'OPTIONS' });
      assert.ok(
        res.status === 204 || res.status === 200,
        `Server at ${serverUrl} not responding (status=${res.status})`,
      );
    } catch (err) {
      throw new Error(
        `Live test requires the API server running at ${serverUrl}. ` +
          `Start it with \`node dist/index.js serve -p <port>\`. ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // The target site. `runLiveTest.cjs` boots it for every shard, so this is
    // normally an adoption; nothing already serving :8787 is killed either way.
    const appUrl = `http://localhost:${TEST_APP_PORT}/`;
    if (!(await up(appUrl))) {
      const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
      testApp = cp.spawn('npx tsx fixtures/test-app/server.ts', [], {
        cwd: repoRoot,
        env: { ...process.env, PORT: String(TEST_APP_PORT) },
        stdio: ['ignore', 'ignore', 'inherit'],
        shell: true,
      });
      startedApp = true;
      await waitFor('fixtures/test-app listening', () => up(appUrl), 60_000);
      say(`started fixtures/test-app on ${appUrl}`);
    } else {
      say(`reusing the fixtures/test-app already on ${appUrl}`);
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — the live runner must pass templates/');
    projectRoot = path.resolve(workspaceRoot, PROJECT);
    testFile = path.join(projectRoot, 'tests', FIXTURE);
    assert.ok(fs.existsSync(testFile), `${FIXTURE} not found at ${testFile}`);
    const config = JSON.parse(fs.readFileSync(path.join(projectRoot, 'steptix.config.json'), 'utf8'));
    assert.equal(config?.browser?.highlight, true, 'the fixture project must turn browser.highlight on');
  });

  after(async () => {
    try {
      await vscode.commands.executeCommand('steptix.stop');
      await vscode.commands.executeCommand('steptix.restartSession');
    } catch {
      /* teardown is best-effort */
    }
    if (startedApp && testApp) {
      try {
        if (process.platform === 'win32') cp.execSync(`taskkill /pid ${testApp.pid} /T /F`, { stdio: 'ignore' });
        else testApp.kill();
      } catch {
        testApp.kill();
      }
    }
  });

  it('marks every touched element in the report, and keeps the ring out of what the model reads', async () => {
    const uri = vscode.Uri.file(testFile);
    // Shown, not just opened: `vscode.open` can return before the editor has
    // focus, and `clearStatuses` acts on the ACTIVE editor.
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
    await waitFor(
      `${FIXTURE} becomes the active editor`,
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      15_000,
    );
    await waitFor('tracker recognises the test file', () => hooks.tracker.snapshot().isTestFile === true, 15_000);
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }
    await vscode.commands.executeCommand('steptix.clearStatuses');
    hooks.clearRunError?.();
    // A fresh session and browser: the rings and the cookie banner start clean.
    await vscode.commands.executeCommand('steptix.restartSession');
    await sleep(1_000);

    say(`Run All on ${PROJECT}/tests/${FIXTURE}`);
    void vscode.commands.executeCommand('steptix.runAll');
    await waitFor('run started', () => hooks.isRunning(), 60_000);
    await waitFor('run finished', () => hooks.isRunning() === false, 280_000);

    const done = hooks.lastDoneStatus();
    const runError = hooks.lastRunError?.() ?? null;
    const reportPath = hooks.lastReportPath();
    say(`done status: ${done}; run error: ${JSON.stringify(runError)}; report: ${reportPath}`);
    assert.equal(done, 'passed', `the run did not pass (run error: ${JSON.stringify(runError)})`);
    assert.ok(reportPath && fs.existsSync(reportPath), `no report at ${reportPath}`);
    assert.ok(
      path.resolve(reportPath).startsWith(path.resolve(projectRoot)),
      `the report ${reportPath} is not under the fixture project ${projectRoot}, so the server ran ` +
        `this test with some other project's config`,
    );

    const html = fs.readFileSync(reportPath, 'utf8');
    const subs = subActionsIn(html);
    for (const s of subs) say(`sub-action ${s.action}: highlighted=${s.highlighted} screenshot=${s.screenshot}`);
    assert.ok(subs.length > 0, 'the report has no sub-actions');

    // §11: each element-touching sub-action asked for its colour, and nothing
    // that touches no element asked for one.
    for (const s of subs) {
      const expected = EXPECTED_RING[s.action];
      if (expected !== undefined) {
        assert.equal(s.highlighted, expected, `a ${s.action} sub-action asked for ${s.highlighted}, not ${expected}`);
      } else if (NO_RING.has(s.action)) {
        assert.equal(s.highlighted, null, `a ${s.action} sub-action asked for a ring, but touches no element`);
      }
    }
    // The fixture's own steps guarantee both kinds: the typing and the Sign In
    // click (act), the balance read and the transaction count (read).
    const kinds = new Set(subs.map((s) => s.highlighted));
    assert.ok(kinds.has('act'), 'no sub-action asked for an act ring');
    assert.ok(kinds.has('read'), 'no sub-action asked for a read ring');
    const typed = subs.filter((s) => s.action === 'type');
    assert.ok(typed.length >= 2, `expected the email and password to be typed, saw ${typed.length} type sub-actions`);

    // Per-action screenshots: every ringed sub-action has its own.
    for (const s of subs.filter((x) => x.highlighted !== null)) {
      assert.ok(s.screenshot, `the ${s.action} sub-action has no screenshot of its own`);
    }

    // What the model read: the requests' DOM snapshots never carry the ring's
    // host. And no sub-action DOM snapshot or anything else in the report does.
    const requests = aiRequestsIn(html);
    assert.ok(requests.length > 0, 'the report shows no AI request — ai-request-content blocks missing');
    for (const [i, content] of requests.entries()) {
      assert.ok(!content.includes(HIGHLIGHT_TAG), `AI request ${i + 1} mentions ${HIGHLIGHT_TAG}`);
    }
    assert.ok(!html.includes(HIGHLIGHT_TAG), `the report mentions ${HIGHLIGHT_TAG} somewhere`);

    // The report is this run's evidence and nobody else's: leave nothing behind.
    fs.rmSync(reportPath, { force: true });
  });
});

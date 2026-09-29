/**
 * Live end-to-end coverage for the tab a `[tool: ...]` step runs in.
 *
 * A tool is handed `page` / `context` / `browser` from the run's ACTIVE
 * pointers at the moment its step starts — `pageTracker.getActive()` in
 * src/server/session-manager.ts, and the same shape in
 * src/runner/test-runner.ts. Nothing else picks a tab for it: the `[tool:]`
 * grammar carries data only, and `ToolContext` (src/tools/types.ts) exposes
 * no tracker, unlike code-behind's `ctx.tabs`. So the switch step in front of
 * a tool step is the entire mechanism, and it had no test.
 *
 * Why it needed a live one
 * -----------------------
 * The coverage was split either side of this seam and nothing joined it:
 *
 *   - tests/tool-end-to-end.test.ts drives real chromium and the real fixture
 *     tools, but hands `executeToolStep` a `page` variable and never
 *     constructs a PageTracker.
 *   - tests/api-server-tools.test.ts does pass a tracker, but it is
 *     `{ getActive: vi.fn(() => mockPage) }` — one page, always the same one.
 *   - tests/popup.test.ts and the compile-tabs live suite cover switching
 *     itself, with no tool in sight.
 *
 * Change both call sites to pass the session's MAIN page instead of its
 * ACTIVE one and every one of those stays green, while every tool step in
 * every test that had switched tabs starts reading the wrong page — and
 * passing, because a tool that reads the wrong page rarely throws.
 *
 * What actually asserts it
 * ------------------------
 * The fixture asserts itself, deterministically and with no model involved:
 * `regex_extract` fails its step when the pattern matches nothing, and the
 * two page titles do not overlap at the anchor (`… — New Tab` against
 * `… — New Window & Tab Test`). Step 9 goes red if the tool read the tab it
 * was not switched to; step 12 goes red if it never came back. This suite
 * runs the file and reads the gutter.
 *
 * Prereq: Sessions API server on $LIVE_SERVER_URL (default :3100) and
 * fixtures/test-app on :8787 (runLiveTest.cjs boots it).
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');

const EXT_ID = 'pkent.steptix-vscode';
const TEST_APP_URL = 'http://127.0.0.1:8787';

/** The tool pairs either side of the switch, as 1-based step numbers. */
const TAB_TOOL_STEP = 8;
const TAB_ASSERT_STEP = 9;
const MAIN_TOOL_STEP = 11;
const MAIN_ASSERT_STEP = 12;

/** Every status the gutter treats as green. A tool step reports a plain
 *  `pass`, but the AI steps around it may legitimately run from a compiled
 *  entry (</>), so pinning to 'pass' would fail this suite for a reason
 *  unrelated to which tab anything ran in. */
const PASS_STATUSES = new Set(['pass', 'pass-code-behind', 'pass-stale']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await predicate()) return; } catch { /* transient */ }
    await sleep(200);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

/**
 * Line numbers of the `N. ` step lines, 1-based. Derived rather than
 * hardcoded: the fixture explains itself in prose above the steps, so any
 * edit to that commentary shifts every line below it and a hardcoded table
 * would quietly assert about blank lines.
 */
function stepLines(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const out = [];
  lines.forEach((text, i) => {
    if (/^\d+\.\s+\S/.test(text)) out.push(i + 1);
  });
  return out;
}

describe('Steptix live — a tool step runs in the switched-to tab', function () {
  this.timeout(900_000);

  /** @type {import('../../../dist/extension/extension').SteptixTestHooks} */
  let hooks;
  /** @type {string} */
  let workspaceRoot;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks missing — activation may have failed');

    workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — live runner must pass templates/');

    const serverUrl = process.env.LIVE_SERVER_URL || 'http://localhost:3100';
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

    // The fixture's assertion is two page titles that must not overlap. Probe
    // both here so "the fixture app changed a <title>" reports as itself
    // rather than as an inexplicable red on step 9.
    const titleProbes = [
      [`${TEST_APP_URL}/new-window`, '<title>SecureBank — New Window & Tab Test</title>'],
      [`${TEST_APP_URL}/new-window/tab`, '<title>SecureBank — New Tab</title>'],
    ];
    for (const [url, needle] of titleProbes) {
      let html;
      try {
        const res = await fetch(url);
        assert.equal(res.status, 200, `fixture app returned ${res.status} for ${url}`);
        html = await res.text();
      } catch (err) {
        throw new Error(
          `Live tab tests need fixtures/test-app on ${TEST_APP_URL} ` +
            `(runLiveTest.cjs normally boots it). ` +
            `Original error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      assert.ok(
        html.includes(needle),
        `${url} no longer serves ${needle} — tool-tab-switch.md asserts on that title, ` +
          `so the fixture's regex_extract patterns must move with the page.`,
      );
    }
  });

  afterEach(async () => {
    // Fresh browser: this fixture leaves a second tab open and an
    // authenticated session behind, either of which would let a later suite
    // pass on state it did not create.
    await vscode.commands.executeCommand('steptix.restartSession');
    await sleep(1_000);
  });

  it('reads the new tab after the switch, and the main tab after switching back', async () => {
    const file = path.resolve(workspaceRoot, 'init', 'tests', 'tool-tab-switch.md');
    assert.ok(fs.existsSync(file), `tool-tab-switch.md not found at ${file}`);

    const lines = stepLines(file);
    assert.equal(
      lines.length,
      12,
      `expected 12 steps in tool-tab-switch.md, found ${lines.length} — ` +
        `fixture edited without updating this suite's step numbers`,
    );

    const uri = vscode.Uri.file(file);
    // Shown, not just opened: `vscode.open` can return before the editor has
    // focus, and the activeTextEditor wait below then races its budget under
    // a loaded full-suite run.
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
      preview: false,
    });
    await waitFor(
      'tool-tab-switch.md becomes the active editor',
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      15_000,
    );
    await waitFor(
      'tracker recognises the test file',
      () => hooks.tracker.snapshot().isTestFile === true,
    );

    void vscode.commands.executeCommand('steptix.runAll');
    await waitFor('the run starts', () => hooks.isRunning(), 60_000);
    await waitFor('the run finishes', () => !hooks.isRunning(), 600_000);

    const snapshot = hooks.tracker.snapshot();
    const statuses = Object.fromEntries(snapshot.statuses);
    // A red step's message is a StepFailureDetail pinned to its line
    // (`setStatus(uri, line, 'fail', stepFailureDetail(ev))`), not an
    // ErrorPayload — `errors` holds the STXxxx framework banners instead, and
    // reading it here would report "(none)" on exactly the failure this suite
    // exists to explain.
    const failures = Object.fromEntries(snapshot.failures ?? []);
    console.log('[live] tool-tab-switch statuses:', statuses);

    const at = (step) => lines[step - 1];
    const detail = (step) => failures[at(step)]?.error ?? '(no failure text recorded)';

    // The two that carry the meaning, named individually so a failure says
    // which direction broke rather than "some step went red".
    assert.ok(
      PASS_STATUSES.has(statuses[at(TAB_ASSERT_STEP)]),
      `step ${TAB_ASSERT_STEP} (line ${at(TAB_ASSERT_STEP)}) is ` +
        `"${statuses[at(TAB_ASSERT_STEP)]}". It matches /New Tab$/ against the title step ` +
        `${TAB_TOOL_STEP} captured, so red here means that tool did NOT run in the tab step 7 ` +
        `switched to. The message names the title it actually read: ${detail(TAB_ASSERT_STEP)}`,
    );
    assert.ok(
      PASS_STATUSES.has(statuses[at(MAIN_ASSERT_STEP)]),
      `step ${MAIN_ASSERT_STEP} (line ${at(MAIN_ASSERT_STEP)}) is ` +
        `"${statuses[at(MAIN_ASSERT_STEP)]}". It matches /Window & Tab Test$/ against the title ` +
        `step ${MAIN_TOOL_STEP} captured, so red here means the switch back to the main tab never ` +
        `reached the tool: ${detail(MAIN_ASSERT_STEP)}`,
    );

    // Everything else green too — a red sign-in step would otherwise leave the
    // two assertions above passing on a page nobody signed into.
    const bad = lines.filter((l) => !PASS_STATUSES.has(statuses[l]));
    assert.equal(
      bad.length,
      0,
      `steps at lines ${bad.join(', ')} did not pass: ` +
        JSON.stringify(bad.map((l) => [l, statuses[l], failures[l]?.error])),
    );
  });
});

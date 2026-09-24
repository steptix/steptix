/**
 * Live end-to-end test for the browser's back and forward buttons
 * (docs/specs/SPEC-browser-history.md §11, criterion 9).
 *
 * The unit layer pins what can be pinned in isolation: the parser accepts both
 * actions and their aliases, and a Playwright suite drives `executeHistory`
 * over a real page, including the same-document cases. The CLI acceptance file
 * proves the whole chain under `aiui run`. What neither says is whether the
 * actions survive the OTHER run loop — the one TestBench drives:
 *
 *   real editor -> real RunController -> real ApiClient -> real api-server
 *     -> real model choosing `back` against a real page
 *       -> real executor moving the tab -> step events -> the line marks
 *
 * That gap is why this file exists. The spec listed it as a test and the first
 * cut of the feature shipped without it; review said so, and this closes it.
 *
 * Two claims, and the second is the one that earns the run:
 *
 *  - the model answers "Go back" with a `back` ACTION, never a keypress. That
 *    is the whole defect (§2): before these actions existed, a step asking for
 *    the browser's back button got `keypress`, which goes to the focused
 *    element inside the page rather than to the browser, so the press
 *    succeeded, the step PASSED, and the page never moved;
 *  - and it works over a SAME-DOCUMENT entry. The fixture's Settings link is
 *    `href="#settings"`, so going back over it produces no HTTP response —
 *    which the first cut of the executor read as "there is no history" and
 *    failed on, while the tab had in fact moved. A test that only moves
 *    between whole pages stays green through that bug; steps 8-14 of the
 *    fixture do not.
 *
 * Prereq: the API server on $LIVE_SERVER_URL (the parallel runner starts one
 * per shard and points that shard's templates/.env at it) and the fixture app
 * on :8787 (runLiveTest.cjs boots it).
 *
 * Run just this file:
 *   cd testbench-native
 *   npm run test:live -- --shards=1 --files=browser-history.test.cjs
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');

const EXT_ID = 'pkent.testbench-native';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Say what was observed, into the shard's own log as well as stdout — the
 *  parallel runner discards a passing launch's stdout. (As table-read.test.cjs.) */
function say(line) {
  console.log(`[live] ${line}`);
  const file = process.env.TESTBENCH_LIVE_LOG;
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

const PASSED = new Set(['pass', 'pass-code-behind', 'pass-stale']);
const passed = (status) => PASSED.has(status);

const serverUrl = () => process.env.LIVE_SERVER_URL || 'http://localhost:3100';

async function activate() {
  const ext = vscode.extensions.getExtension(EXT_ID);
  assert.ok(ext, `${EXT_ID} not loaded`);
  if (!ext.isActive) await ext.activate();
  const hooks = ext.exports?.__testHooks;
  assert.ok(hooks, '__testHooks missing — activation may have failed');
  try {
    const res = await fetch(`${serverUrl()}/sessions/healthcheck/steps`, { method: 'OPTIONS' });
    assert.ok(
      res.status === 204 || res.status === 200,
      `Server at ${serverUrl()} not responding (status=${res.status})`,
    );
  } catch (err) {
    throw new Error(
      `Live test requires the API server running at ${serverUrl()}. ` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return hooks;
}

async function openTestFile(hooks, workspaceRoot, name) {
  const file = path.resolve(workspaceRoot, 'init', 'tests', name);
  assert.ok(fs.existsSync(file), `${name} not found at ${file}`);
  const uri = vscode.Uri.file(file);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
    preview: false,
  });
  await waitFor(
    `${name} becomes the active editor`,
    () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
  );
  await waitFor(
    'testbench detects the test file',
    () => hooks.tracker.snapshot().isTestFile === true,
    15_000,
  );
  if (vscode.debug.breakpoints.length > 0) {
    vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
  }
  return { file, uri };
}

/** The status on each of `lines`, in order, or null where the line has none. */
function statusesOn(hooks, uri, lines) {
  const snap = hooks.tracker.snapshotFor(uri);
  const byLine = new Map(snap ? snap.statuses : []);
  return lines.map((l) => byLine.get(l) ?? null);
}

/** Collect the run's output lines, which is where the sub-action trace lands. */
function startRunTap(hooks) {
  let mark = hooks.hostMessageCount();
  /** @type {string[]} */
  const output = [];
  const drain = () => {
    const msgs = hooks.hostMessagesSince(mark);
    mark += msgs.length;
    for (const m of msgs) {
      if (m.type === 'runEvent' && m.event?.type === 'output') output.push(m.event.msg);
    }
  };
  const timer = setInterval(drain, 150);
  return {
    output,
    stop() {
      clearInterval(timer);
      drain();
    },
  };
}

/**
 * The fixture's step lines, read off the file rather than hard-coded, so a
 * reworded step fails by name instead of drifting onto its neighbour.
 * Returns the 1-based line of each numbered step in `## Steps`.
 */
function stepLines(testFile, expectedCount) {
  const lines = fs.readFileSync(testFile, 'utf8').split(/\r?\n/);
  const heading = lines.findIndex((l) => /^##\s+Steps\s*$/.test(l));
  assert.ok(heading >= 0, `${path.basename(testFile)} has no "## Steps" heading`);
  const found = [];
  for (let i = heading + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;
    const numbered = /^(\d+)\.\s+(.*)$/.exec(lines[i]);
    if (numbered) found.push({ line: i + 1, n: Number(numbered[1]), text: numbered[2].trim() });
  }
  assert.equal(
    found.length,
    expectedCount,
    `${path.basename(testFile)} should have ${expectedCount} steps; found ${found.length}. ` +
      `If the fixture changed on purpose, update this test.`,
  );
  return found;
}

/** A sub-action trace line for `action.<name>`, e.g. `action.back`. */
const actionLine = (name) => new RegExp(`action\\.${name}\\b`);

describe('TestBench live — the browser back and forward buttons', function () {
  this.timeout(900_000);

  let hooks;
  let workspaceRoot;
  let uri;
  let steps;

  before(async function () {
    this.timeout(60_000);
    hooks = await activate();
    workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — the live runner must pass templates/');
    const opened = await openTestFile(hooks, workspaceRoot, 'browser-history.md');
    uri = opened.uri;
    steps = stepLines(opened.file, 14);
    await vscode.commands.executeCommand('testbench-native.clearStatuses');
    hooks.clearRunError?.();
  });

  after(async () => {
    try {
      await vscode.commands.executeCommand('testbench-native.stop');
      await vscode.commands.executeCommand('testbench-native.restartSession');
    } catch {
      /* teardown is best-effort */
    }
  });

  it('moves the tab with back and forward, over whole pages and over a hash entry', async function () {
    // Fourteen steps, every one a model call against a real page.
    this.timeout(900_000);

    const tap = startRunTap(hooks);
    try {
      say('Run All on browser-history.md — back and forward, cross-document then same-document');
      void vscode.commands.executeCommand('testbench-native.runAll');
      await waitFor('run started', () => hooks.isRunning(), 60_000);
      await waitFor('run finished', () => hooks.isRunning() === false, 880_000);
    } finally {
      tap.stop();
    }

    // -------------------------------------------------------------------
    // 1. The run passed, and every line painted.
    // -------------------------------------------------------------------
    const done = hooks.lastDoneStatus();
    say(`done status: ${done}`);
    say(`run error: ${JSON.stringify(hooks.lastRunError?.() ?? null)}`);
    const lines = steps.map((s) => s.line);
    const marks = statusesOn(hooks, uri, lines);
    assert.equal(
      done,
      'passed',
      `browser-history.md must pass end to end; got '${done}'. Statuses: ${JSON.stringify(marks)}`,
    );
    steps.forEach((s, i) => {
      assert.ok(
        passed(marks[i]),
        `step ${s.n} (line ${s.line}) must pass; got '${marks[i]}'. Instruction: ${s.text}`,
      );
    });

    // -------------------------------------------------------------------
    // 2. The actions the run actually took.
    //
    // The fixture asks to go back twice and forward twice. Each must be a
    // history action — and NOT a keypress, which is the defect §2 measured:
    // a key event goes to the focused element inside the page, so the press
    // succeeds, the step passes, and the tab never moves.
    // -------------------------------------------------------------------
    const backs = tap.output.filter((l) => actionLine('back').test(l));
    const forwards = tap.output.filter((l) => actionLine('forward').test(l));
    const keypresses = tap.output.filter((l) => actionLine('keypress').test(l));
    say(`back lines: ${JSON.stringify(backs)}`);
    say(`forward lines: ${JSON.stringify(forwards)}`);
    say(`keypress lines: ${JSON.stringify(keypresses)}`);

    assert.ok(
      backs.length >= 2,
      `expected at least two 'back' actions (steps 4 and 9); saw ${backs.length}. ` +
        `Output lines naming an action:\n${tap.output.filter((l) => /action\./.test(l)).join('\n')}`,
    );
    assert.ok(
      forwards.length >= 2,
      `expected at least two 'forward' actions (steps 6 and 11); saw ${forwards.length}.`,
    );
    assert.equal(
      keypresses.length,
      0,
      `a keypress cannot reach the browser — it goes to the focused element inside the page, ` +
        `so it does nothing and the step passes anyway (§2). Saw: ${JSON.stringify(keypresses)}`,
    );

    // -------------------------------------------------------------------
    // 3. No history action failed.
    //
    // §4.3's failure is what a same-document regression looks like from here:
    // the tab moves and the step still fails, saying there is no previous
    // page. Steps 9 and 11 go back and forward over a `#settings` entry, so
    // this assertion is the one that would have caught the blocker review
    // found — the CLI acceptance file's first seven steps did not.
    // -------------------------------------------------------------------
    const historyFailures = tap.output.filter((l) => /no (previous page|page ahead)/.test(l));
    assert.deepEqual(
      historyFailures,
      [],
      `no history move should have reported an empty history — steps 9 and 11 cross a ` +
        `same-document (#settings) entry, which returns no HTTP response and must still count ` +
        `as a move (§4.3). Saw: ${JSON.stringify(historyFailures)}`,
    );

    say(
      `PASS — ${backs.length} back, ${forwards.length} forward, 0 keypress, 0 empty-history failures`,
    );
  });
});

/**
 * Live end-to-end test for computer mode — `[use computer]` / `[use browser]`
 * (docs/specs/SPEC-use-computer.md §13.3).
 *
 * GATED OUT OF THE DEFAULT RUN. It skips itself unless
 * `STEPTIX_LIVE_COMPUTER=1` is set, because the default live run is four
 * parallel shards and a computer-mode step drives the ONE real mouse on the
 * box. Two shards moving the same pointer do not produce two flaky runs; they
 * produce one run clicking where the other run's dialog used to be. The
 * framework's own lock (spec §5.9) refuses the second session, which would
 * turn the whole parallel suite red for a reason that has nothing to do with
 * the code under test. So the gate is here, in the suite, and the default run
 * stays parallel.
 *
 * Run it on its own, one shard, from a NORMAL terminal:
 *
 *   cd <worktree>
 *   node dist/index.js serve -p 3109 --idle-timeout 60
 *
 *   cd <worktree>/steptix-vscode
 *   $env:STEPTIX_LIVE_COMPUTER = '1'
 *   npm run test:live -- --shards=1 --files=computer-use.test.cjs --server=http://localhost:3109
 *
 * The server has to be started from a normal terminal or from VS Code, not by
 * a sandboxed tool runner: a process spawned by one can enumerate windows and
 * get a screen DC but cannot blit from it, so `screen.grab()` fails with
 * BitBlt error 6 and every computer-mode step is blind (measured — spec §5.1
 * item 4). `--server=<url>` also has to match the `SERVER_URL` in
 * `templates/.env`, because the serial path is the one mode where the
 * extension and these assertions read the server's address from two
 * independent places (CLAUDE.md, "Live integration tests in a worktree").
 *
 * And the machine has to look right while it runs: a visible, unlocked
 * desktop, and NOBODY TOUCHING THE MOUSE. A stray click moves focus and the
 * next screenshot is no longer of what the model was answering about.
 *
 * What only this run can say. The unit layer pins the parser, the mode state
 * machine, the image→screen mapping and the executor against a fake adapter;
 * none of them touches a screen. What is unproven until here is the whole
 * chain, through the client Steptix actually is:
 *
 *   real editor -> real RunController -> real ApiClient -> real api-server
 *     -> real surface switch -> real screen grab -> real model returning
 *       coordinates -> real nut.js click -> step events -> the line marks
 *
 * and, specifically, that `[use computer]` reaches a dialog browser mode
 * cannot see. Steps 5-8 of the fixture click a button on Chromium's PDF
 * toolbar — which is not in the DOM — and then Cancel in the print dialog it
 * opens, which is not in the tab at all. In browser mode those steps get a
 * DOM snapshot with neither in it; they can only pass on the computer
 * surface. Step 10 runs after `[use browser]` and proves the tab was still
 * there.
 *
 * Prereqs: the API server on $LIVE_SERVER_URL, and the fixture app on :8787
 * (runLiveTest.cjs boots it) serving `/statement.pdf`. The `before` hook
 * checks that last one by name — the fixture app is SHARED across worktrees
 * (first run in wins the port, later runs adopt it), so an app started from a
 * checkout that predates `statement.pdf` would otherwise fail this as "the
 * model could not find a Print button".
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');

const EXT_ID = 'pkent.steptix-vscode';
const TEST_APP_URL = 'http://localhost:8787';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Say what was observed, into the shard's own log as well as stdout — the
 *  parallel runner discards a passing launch's stdout. */
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

/**
 * The fixture app must be serving the PDF this test is about.
 *
 * Checked by name rather than assumed: `runLiveTest.cjs` ADOPTS whatever is
 * already listening on 8787, which may be an app another worktree started
 * from a checkout without `fixtures/test-app/statement.pdf`. The adoption is
 * deliberate and right — the pages are static markup — but it means "the app
 * is up" and "the app has this file" are different questions.
 */
async function assertFixturePdfIsServed() {
  let res;
  try {
    res = await fetch(`${TEST_APP_URL}/statement.pdf`);
  } catch (err) {
    throw new Error(
      `fixture app at ${TEST_APP_URL} is not answering: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  assert.equal(
    res.status,
    200,
    `${TEST_APP_URL}/statement.pdf returned ${res.status}. If the app on 8787 was ` +
      `adopted from another checkout, it may predate the route — stop that one, ` +
      `or run this test on a box where 8787 is free.`,
  );
  const type = res.headers.get('content-type') ?? '';
  assert.ok(
    type.startsWith('application/pdf'),
    `/statement.pdf must be served as application/pdf so Chromium opens its viewer; got '${type}'`,
  );
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.ok(
    bytes.subarray(0, 5).toString('latin1') === '%PDF-',
    `/statement.pdf does not start with %PDF- (${bytes.length} bytes) — a utf-8 ` +
      `read of a binary file produces exactly this`,
  );
  say(`fixture PDF: ${bytes.length} bytes, ${type}`);
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
    'steptix detects the test file',
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

/**
 * The fixture's step lines, read off the file rather than hard-coded, so a
 * reworded prose header moves nothing and a reworded STEP fails by name
 * instead of drifting onto its neighbour.
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

describe('Steptix live — computer mode opens and cancels the print dialog', function () {
  this.timeout(900_000);

  // ── The gate ────────────────────────────────────────────────────────────
  // Registered as a PENDING test rather than skipped silently: live/index.cjs
  // records `pending` rows in the report and the runner prints an `o` for
  // them, so "nobody checked this" reads differently from "this passed".
  if (process.env.STEPTIX_LIVE_COMPUTER !== '1') {
    const why =
      'computer-mode live test SKIPPED — set STEPTIX_LIVE_COMPUTER=1 to run it. ' +
      'It drives the real mouse, so it cannot share a box with the parallel shards; ' +
      'run it alone with --shards=1 --files=computer-use.test.cjs (see this file\'s header).';
    console.log(`[live] ${why}`);
    it.skip('drives pdf-dialog-cancel.md across the browser/computer surface boundary', () => {});
    return;
  }

  let hooks;
  let workspaceRoot;
  let uri;
  let steps;

  before(async function () {
    this.timeout(120_000);
    hooks = await activate();
    await assertFixturePdfIsServed();
    workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — the live runner must pass templates/');
    const opened = await openTestFile(hooks, workspaceRoot, 'pdf-dialog-cancel.md');
    uri = opened.uri;
    steps = stepLines(opened.file, 10);
    await vscode.commands.executeCommand('steptix.clearStatuses');
    hooks.clearRunError?.();
  });

  after(async () => {
    try {
      await vscode.commands.executeCommand('steptix.stop');
      // Closes the session for the BROWSER it holds, not for the lock or the
      // surface. Neither needs it any more: the server releases the computer
      // lock at the end of every run, a stopped one included (spec §5.9), and
      // the next run of this file resets the surface itself through the
      // `runStart` its first block carries (§4.5). What a kept session still
      // holds is the Chromium this fixture opened the PDF in — headed, per the
      // workspace config — which would otherwise stay on screen for whatever
      // runs next.
      await vscode.commands.executeCommand('steptix.restartSession');
    } catch {
      /* teardown is best-effort */
    }
  });

  it('drives pdf-dialog-cancel.md across the browser/computer surface boundary', async function () {
    this.timeout(900_000);

    say('Run All on pdf-dialog-cancel.md — DO NOT TOUCH THE MOUSE OR KEYBOARD');
    void vscode.commands.executeCommand('steptix.runAll');
    await waitFor('run started', () => hooks.isRunning(), 60_000);
    await waitFor('run finished', () => hooks.isRunning() === false, 880_000);

    const done = hooks.lastDoneStatus();
    const lines = steps.map((s) => s.line);
    const marks = statusesOn(hooks, uri, lines);
    say(`done status: ${done}`);
    say(`run error: ${JSON.stringify(hooks.lastRunError?.() ?? null)}`);
    steps.forEach((s, i) => say(`  step ${s.n} (line ${s.line}) ${marks[i]} — ${s.text}`));

    // ── 1. The run passed. ────────────────────────────────────────────────
    assert.equal(
      done,
      'passed',
      `pdf-dialog-cancel.md must pass end to end; got '${done}'. Statuses: ${JSON.stringify(marks)}. ` +
        `A refusal at step 3 is usually a precondition rather than a bug: ` +
        `desktop.enabled false in templates/init/steptix.config.json, nut.js failing to ` +
        `load, the computer lock held by another session, or a server that cannot read ` +
        `the screen (spec §5.1).`,
    );

    // ── 2. Both directives are in the results. ────────────────────────────
    // They are not steps that do work — the report renders them as mode
    // markers (spec §10.1) — but they must still be accounted for on their
    // own lines. A directive that left its line blank would be
    // indistinguishable, in the editor and in the report, from a step the
    // run never reached.
    const directives = steps.filter((s) => /^\[use\s*:?\s*(computer|browser)\]$/i.test(s.text));
    assert.equal(
      directives.length,
      2,
      `pdf-dialog-cancel.md must carry both directives; found ${JSON.stringify(
        directives.map((d) => d.text),
      )}`,
    );
    for (const d of directives) {
      const mark = marks[steps.indexOf(d)];
      assert.ok(
        mark !== null && mark !== undefined,
        `'${d.text}' (line ${d.line}) has no status — the surface switch left its line blank`,
      );
      assert.ok(
        mark !== 'fail' && mark !== 'fail-tolerated',
        `'${d.text}' (line ${d.line}) failed with '${mark}'`,
      );
      say(`directive ${d.text} (line ${d.line}) -> ${mark}`);
    }

    // ── 3. Every step passed, including the four that only computer mode
    //       can perform. ──────────────────────────────────────────────────
    // Steps 5-8 are the point of the file: the PDF toolbar's Print button is
    // not in the DOM, and the dialog it opens is not in the tab. In browser
    // mode the model gets a snapshot with neither in it, so a pass on these
    // four is the evidence that `[use computer]` really switched surface —
    // and a pass on step 10, after `[use browser]`, is the evidence it
    // switched back onto the same tab.
    steps.forEach((s, i) => {
      assert.ok(
        passed(marks[i]) || /^\[use\s*:?\s*(computer|browser)\]$/i.test(s.text),
        `step ${s.n} (line ${s.line}) must pass; got '${marks[i]}'. Instruction: ${s.text}`,
      );
    });
  });
});

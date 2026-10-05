/**
 * Live end-to-end test: a desktop-only computer-mode test, driven through
 * Steptix, with the machine lock measured from outside the server —
 * `templates/init/tests/calc-one-plus-one.md`
 * (docs/specs/SPEC-use-computer.md §4.5, §5.9, §13.3).
 *
 * GATED OUT OF THE DEFAULT RUN, for the same reason as computer-use.test.cjs:
 * it skips itself unless `STEPTIX_LIVE_COMPUTER=1` is set, because it drives
 * the ONE real mouse and keyboard on the box and the default live run is four
 * parallel shards. The framework's lock (spec §5.9) would refuse a second
 * computer-mode session and turn the parallel suite red for a reason unrelated
 * to the code under test.
 *
 * Run it on its own, one shard, against a server YOU started:
 *
 *   cd <worktree>
 *   node dist/index.js serve -p <n> --idle-timeout 60        # from YOUR terminal
 *
 *   cd <worktree>\steptix-vscode
 *   $env:STEPTIX_LIVE_COMPUTER = '1'
 *   npm run test:live -- --shards=1 --files=computer-calc.test.cjs --server=http://localhost:<n>
 *
 * The server has to be started from a normal terminal or from VS Code, not by
 * a sandboxed tool runner: a process spawned by one cannot blit from the
 * screen DC, so `screen.grab()` fails with BitBlt error 6 and every
 * computer-mode step is blind (spec §5.1 item 4). `--server=<url>` has to match
 * the `STEPTIX_SERVER_URL` in `templates/.env`, because the serial path is the one mode
 * where the extension and these assertions read the server's address from two
 * independent places (CLAUDE.md, "Live integration tests in a worktree").
 *
 * The fixture tool has to load. Step 2 is `[tool: open_calculator]`
 * (fixtures/tools/src/open_calculator.ts), found through
 * `templates/init/steptix.config.json`'s `toolsDir: ../../fixtures/tools/src`.
 * That needs `fixtures/tools/node_modules` (init-worktree.ps1 seeds it) and
 * the worktree's `dist/` built. A server that cannot load the tools logs one
 * `no tools registered` WARN at startup and carries on, and step 2 then fails.
 *
 * HANDS OFF while it runs — two full runs, roughly three to five minutes: a
 * visible, unlocked desktop, and NOBODY TOUCHING THE MOUSE OR KEYBOARD. Step 5
 * types into whichever window is in front; a stray click during the breakpoint
 * pause moves focus and the keystrokes go somewhere else. Close any Calculator
 * window before starting. If a run fails partway, Calculator may be left open:
 * this test closes nothing and kills nothing, so close it by hand before the
 * next attempt, or step 3 is satisfied by the old window and step 5 types into
 * whatever that one shows.
 *
 * What only this run can say:
 *
 *  - THE WHOLE CHAIN FOR A DESKTOP-ONLY TEST, through the client Steptix
 *    actually is: real editor -> RunController -> ApiClient -> api-server ->
 *    computer surface -> real screen grab -> model -> nut.js -> the real
 *    Calculator -> step events -> the line marks. The fixture had passed 9/9
 *    through the Sessions API and through MCP, never through Steptix.
 *
 *  - THE LOCK IS RELEASED AT A PAUSE AND AT RUN END, measured from outside the
 *    server. This test reads `steptix-computer.lock` itself, while the real
 *    server holds or does not hold it. The unit layer pins the release against
 *    a fake lock path inside one process; only here is it the real file, the
 *    real server pid and a real Steptix breakpoint.
 *
 *    What "paused" means here, precisely: a breakpoint on a test-file line is
 *    a batch the client CUTS. Steptix sends steps 1-4, parks at step 5 and
 *    shows the yellow arrow; the server's batch simply ended. So the release
 *    measured at the pause is the step loop's `finally` — §5.9's "a batch the
 *    client cut at a breakpoint" — not the `releaseLockForPause` path that a
 *    skill or section breakpoint takes. Continue then sends steps 5-9 as a new
 *    batch with no `runStart`, which keeps the session on the computer surface
 *    and must take the lock again at step 5.
 *
 *    Positive control: every run phase also watches the file WHILE it
 *    executes and requires having seen it held by the server's pid. Without
 *    that, "absent" would pass just as well if this process and the server
 *    disagreed about `os.tmpdir()` and were looking at two different files.
 *
 *  - A RE-RUN IN A KEPT SESSION. Steptix reuses one server session per test
 *    file (its id is the file's path), so the second Run All lands on the
 *    session run 1 left on the computer surface. Its first block carries
 *    `runStart` (§4.5), step 1's `[use computer]` takes the lock again, the run
 *    passes 9/9 and gives the lock back. The session's `totalStepsExecuted`
 *    growing across the run is what says it was kept rather than recreated,
 *    and `GET /sessions/:id` reports its `surface`.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const vscode = require('vscode');

const EXT_ID = 'pkent.steptix-vscode';
const FIXTURE = 'calc-one-plus-one.md';

/**
 * Where the server keeps the lock: `computerLockPath()` in src/desktop/lock.ts,
 * `path.join(os.tmpdir(), 'steptix-computer.lock')`. Recomputed here rather than
 * imported — the extension host cannot load the framework's dist, and the
 * positive control below is what checks the two agree.
 */
const LOCK_PATH = path.join(os.tmpdir(), 'steptix-computer.lock');

/** One run of the fixture: several model calls on full-screen screenshots. */
const RUN_BUDGET_MS = 360_000;

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

const serverUrl = () => process.env.LIVE_STEPTIX_SERVER_URL || 'http://localhost:3100';

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

/** The server's own pid, from `/health` (pre-auth). The lock records the pid
 *  of the process that took it, so this is what "held by the server" means. */
async function fetchServerPid() {
  const res = await fetch(`${serverUrl()}/health`);
  assert.ok(res.ok, `GET ${serverUrl()}/health returned ${res.status}`);
  const body = await res.json();
  assert.ok(
    Number.isInteger(body.pid) && body.pid > 0,
    `/health carries no usable pid: ${JSON.stringify(body.pid)}`,
  );
  return body.pid;
}

/** `STEPTIX_SERVER_API_KEY` from the workspace .env — the file the extension's
 *  own walk-up ends at, and the one runLiveTest.cjs requires to carry it. */
function apiKeyFrom(workspaceRoot) {
  const envPath = path.resolve(workspaceRoot, '.env');
  const text = fs.readFileSync(envPath, 'utf8');
  const m = /^\s*STEPTIX_SERVER_API_KEY\s*=\s*(.+)$/m.exec(text);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

/**
 * `GET /sessions/:id` for Steptix's session on this file, or null on 404.
 *
 * The id is the file's fsPath: an interactive run uses
 * `this.document.uri.fsPath` as its session id (run-controller.ts, where
 * `sessionId` is chosen — batch runs append `::run-N`, interactive ones do
 * not), and the server lower-cases a drive-letter path on win32 when keying
 * its map (`sessionKey`), so the spelling VS Code opened the file with finds
 * it either way.
 */
async function getSessionState(uri, apiKey) {
  const res = await fetch(`${serverUrl()}/sessions/${encodeURIComponent(uri.fsPath)}`, {
    headers: { 'x-api-key': apiKey },
  });
  if (res.status === 404) return null;
  assert.equal(res.status, 200, `GET /sessions/:id returned ${res.status}`);
  return res.json();
}

/** Every session id the server has, for a failure message that needs one. */
async function listSessionIds(apiKey) {
  try {
    const res = await fetch(`${serverUrl()}/sessions`, { headers: { 'x-api-key': apiKey } });
    const body = await res.json();
    return (body.sessions ?? []).map((s) => s.sessionId);
  } catch (err) {
    return [`(GET /sessions failed: ${err instanceof Error ? err.message : String(err)})`];
  }
}

/**
 * The lock file as it stands right now.
 *
 *   { state: 'absent' }                     no file — nobody holds it
 *   { state: 'held', record, raw }          a readable { pid, sessionId, since }
 *   { state: 'unreadable', raw | error }    present but not a record
 *
 * 'unreadable' is expected, rarely, from the sampler — it can read between the
 * server's create and its write — and never at a quiet moment.
 */
function readLock() {
  let raw;
  try {
    raw = fs.readFileSync(LOCK_PATH, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: 'absent' };
    return { state: 'unreadable', error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const record = JSON.parse(raw);
    if (record && typeof record.pid === 'number' && typeof record.sessionId === 'string') {
      return { state: 'held', record, raw };
    }
  } catch {
    /* falls through */
  }
  return { state: 'unreadable', raw };
}

function describeLock(lock) {
  if (lock.state === 'absent') return 'absent (no file)';
  if (lock.state === 'held') return `held: ${JSON.stringify(lock.record)}`;
  return `unreadable: ${lock.error ?? JSON.stringify(lock.raw)}`;
}

/** Absent, or held by some other pid — anything but the server holding it. */
function assertLockNotHeldByServer(lock, serverPid, when) {
  assert.ok(
    lock.state === 'absent' || (lock.state === 'held' && lock.record.pid !== serverPid),
    `${when}, the computer lock must not be held by the server (pid ${serverPid}); ` +
      `${LOCK_PATH} is ${describeLock(lock)}. §5.9: the lock is released at the end ` +
      `of every run — including a batch the client cut at a breakpoint — and is ` +
      `never held across a pause or the idle time between runs.`,
  );
}

/**
 * Sample the lock file every 100 ms until stopped, and remember whether the
 * server was ever seen holding it. The positive control: the "not held"
 * assertions only mean something if this process can see the file the server
 * writes — and a run that never took the lock at all would be its own finding.
 */
function watchLock(serverPid) {
  const seen = { samples: 0, serverHolds: 0, serverRecord: null, others: new Map() };
  const timer = setInterval(() => {
    const lock = readLock();
    seen.samples += 1;
    if (lock.state !== 'held') return;
    if (lock.record.pid === serverPid) {
      seen.serverHolds += 1;
      seen.serverRecord ??= lock.record;
    } else {
      seen.others.set(`${lock.record.pid}/${lock.record.sessionId}`, lock.record);
    }
  }, 100);
  return {
    seen,
    stop() {
      clearInterval(timer);
      return seen;
    },
  };
}

function describeWatch(seen) {
  const others = [...seen.others.values()].map((r) => JSON.stringify(r));
  return (
    `${seen.serverHolds}/${seen.samples} samples held by the server` +
    (seen.serverRecord ? ` (first: ${JSON.stringify(seen.serverRecord)})` : '') +
    (others.length ? `; other holders seen: ${others.join(', ')}` : '')
  );
}

function assertServerHeldLockDuring(seen, serverPid, phase, why) {
  assert.ok(
    seen.serverHolds > 0,
    `during ${phase}, the lock was never seen held by the server (pid ${serverPid}) ` +
      `in ${seen.samples} samples of ${LOCK_PATH}. ${why} Either that did not happen, ` +
      `or this extension host and the server resolve os.tmpdir() differently and are ` +
      `looking at two different files — in which case every "not held" assertion in ` +
      `this file would pass vacuously.` +
      (seen.others.size
        ? ` Held by someone else meanwhile: ${[...seen.others.values()]
            .map((r) => JSON.stringify(r))
            .join(', ')}.`
        : ''),
  );
}

/**
 * Wait for a run started by a command to come to rest — finished, failed, or
 * parked at a breakpoint.
 *
 * Keyed on the TERMINAL condition, a `done` event with nothing running, rather
 * than on seeing `isRunning()` go true first: a batch refused at its first
 * step (a lock held by another session, say) can start and end inside one
 * 200 ms poll. The caller clears `lastDoneStatus` (via `clearRunError`) before
 * issuing the command, so a `done` from an earlier run cannot satisfy it.
 */
async function runToRest(hooks, label, budgetMs = RUN_BUDGET_MS) {
  await waitFor(
    `${label}: the run starts`,
    () => hooks.isRunning() || hooks.lastDoneStatus() !== null,
    60_000,
  );
  await waitFor(
    `${label}: the run comes to rest`,
    () => hooks.lastDoneStatus() !== null && !hooks.isRunning(),
    budgetMs,
  );
}

async function openTestFile(hooks, workspaceRoot, name) {
  const file = path.resolve(workspaceRoot, 'init', 'tests', name);
  assert.ok(fs.existsSync(file), `${name} not found at ${file}`);
  const uri = vscode.Uri.file(file);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
  await waitFor(
    `${name} becomes the active editor`,
    () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
  );
  await waitFor(
    'steptix detects the test file',
    () => hooks.tracker.snapshot().isTestFile === true,
    15_000,
  );
  removeAllBreakpoints();
  return { file, uri, doc };
}

function removeAllBreakpoints() {
  if (vscode.debug.breakpoints.length > 0) {
    vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
  }
}

/** The status on each of `lines`, in order, or null where the line has none. */
function statusesOn(hooks, uri, lines) {
  const snap = hooks.tracker.snapshotFor(uri);
  const byLine = new Map(snap ? snap.statuses : []);
  return lines.map((l) => byLine.get(l) ?? null);
}

/** Every failure the editor holds for this file, one line each — the text a
 *  hover would show, so an assertion names WHY rather than only which step. */
function failuresOn(hooks, uri) {
  const snap = hooks.tracker.snapshotFor(uri);
  if (!snap) return '(none)';
  const out = [];
  for (const [line, detail] of snap.failures ?? []) {
    out.push(`line ${line}: ${detail.error ?? detail.codeBehindStale?.error ?? JSON.stringify(detail)}`);
  }
  for (const [line, payload] of snap.errors ?? []) {
    out.push(`line ${line} [${payload.code}]: ${payload.message}`);
  }
  return out.length ? out.join(' | ') : '(none)';
}

/**
 * The fixture's step lines, read off the file rather than hard-coded, and each
 * pinned to a fragment of its own text — so a reworded prose header moves
 * nothing, and a reworded or reordered STEP fails by name instead of the
 * breakpoint drifting onto its neighbour.
 */
function stepLines(testFile) {
  const expected = [
    '[use computer]',
    '[tool: open_calculator]',
    'Wait until a window titled "Calculator" is open',
    'Focus the window',
    'Type "1+1"',
    'Click the "=" button',
    'shows 2',
    'Focus the window',
    'Alt+F4',
  ];
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
    expected.length,
    `${path.basename(testFile)} should have ${expected.length} steps; found ${found.length}. ` +
      `If the fixture changed on purpose, update this test.`,
  );
  expected.forEach((fragment, i) => {
    assert.ok(
      found[i].text.includes(fragment),
      `step ${i + 1} (line ${found[i].line}) should contain '${fragment}'; reads '${found[i].text}'`,
    );
  });
  return found;
}

function logMarks(steps, marks) {
  steps.forEach((s, i) => say(`  step ${s.n} (line ${s.line}) ${marks[i]} — ${s.text}`));
}

describe('Steptix live — computer mode drives Calculator, and the lock follows the run', function () {
  this.timeout(1_800_000);

  // ── The gate ────────────────────────────────────────────────────────────
  // Registered as a PENDING test rather than skipped silently: live/index.cjs
  // records `pending` rows in the report and the runner prints an `o` for
  // them, so "nobody checked this" reads differently from "this passed".
  if (process.env.STEPTIX_LIVE_COMPUTER !== '1') {
    const why =
      'computer-mode live test SKIPPED — set STEPTIX_LIVE_COMPUTER=1 to run it. ' +
      'It drives the real mouse and keyboard, so it cannot share a box with the parallel ' +
      "shards; run it alone with --shards=1 --files=computer-calc.test.cjs (see this file's header).";
    console.log(`[live] ${why}`);
    it.skip('pauses at a breakpoint with the lock released, and Continue finishes 9/9', () => {});
    it.skip('a second Run All in the kept session passes 9/9 and takes the lock again', () => {});
    return;
  }

  let hooks;
  let workspaceRoot;
  let uri;
  let doc;
  let steps;
  let serverPid;
  let apiKey;

  before(async function () {
    this.timeout(120_000);
    hooks = await activate();
    workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — the live runner must pass templates/');
    apiKey = apiKeyFrom(workspaceRoot);
    assert.ok(apiKey, `no STEPTIX_SERVER_API_KEY in ${path.resolve(workspaceRoot, '.env')}`);
    serverPid = await fetchServerPid();
    say(`server ${serverUrl()} is pid ${serverPid}`);
    say(`lock file: ${LOCK_PATH} — before anything runs: ${describeLock(readLock())}`);

    const opened = await openTestFile(hooks, workspaceRoot, FIXTURE);
    uri = opened.uri;
    doc = opened.doc;
    steps = stepLines(opened.file);
    await vscode.commands.executeCommand('steptix.clearStatuses');
    hooks.clearRunError();
  });

  after(async () => {
    // Best effort, and nothing is killed: a run left going is stopped through
    // Steptix's own Stop, and a Calculator a failed run left open stays open
    // (the header says so).
    try {
      await vscode.commands.executeCommand('steptix.stop');
    } catch {
      /* nothing running */
    }
    try {
      removeAllBreakpoints();
    } catch {
      /* best effort */
    }
    // If keystrokes ever landed in the editor instead of Calculator, put the
    // fixture back. The harness never saves it, so this discards only what
    // the stray typing did.
    try {
      if (doc?.isDirty) {
        await vscode.window.showTextDocument(doc, { preview: false });
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
    } catch {
      /* best effort */
    }
  });

  // -------------------------------------------------------------------------
  // 1. Breakpoint on step 5: the pause gives the lock back, Continue finishes.
  // -------------------------------------------------------------------------
  it('pauses at a breakpoint with the lock released, and Continue finishes 9/9', async function () {
    this.timeout(900_000);
    const lines = steps.map((s) => s.line);
    const step5 = steps[4];

    removeAllBreakpoints();
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(step5.line - 1, 0)),
        true,
      ),
    ]);
    await waitFor(
      `Steptix sees the breakpoint on line ${step5.line}`,
      () => hooks.tracker.breakpoints(uri).has(step5.line),
      10_000,
    );

    // ── Batch 1: steps 1-4, then park at step 5. ───────────────────────────
    hooks.clearRunError();
    say(`Run All with a breakpoint on step 5 (line ${step5.line}) — DO NOT TOUCH THE MOUSE OR KEYBOARD`);
    const batch1 = watchLock(serverPid);
    void vscode.commands.executeCommand('steptix.runAll');
    try {
      await runToRest(hooks, 'batch 1 (steps 1-4)');
    } finally {
      batch1.stop();
    }

    // Read first, before anything else can happen: the lock as it stands the
    // moment Steptix is parked. The server's step-loop `finally` releases it
    // before the batch's `done` goes out, and Steptix posts the pause arrow
    // only after that stream has ended — so this read is already after the
    // release, with no settle time needed. Logged before any assertion, so
    // the observation survives an earlier failure.
    const lockAtPause = readLock();
    const pausedAt = hooks.tracker.snapshotFor(uri)?.breakpointStop ?? null;
    const pausedMarks = statusesOn(hooks, uri, lines);
    say(`batch 1 at rest: done=${hooks.lastDoneStatus()} pausedAt=${pausedAt} ` +
      `parked=${hooks.isParkedAtPause(uri)} running=${hooks.isRunning()}`);
    say(`batch 1 run error: ${JSON.stringify(hooks.lastRunError() ?? null)}`);
    logMarks(steps, pausedMarks);
    say(`batch 1 lock watch: ${describeWatch(batch1.seen)}`);
    say(`lock while paused at step 5 (${LOCK_PATH}): ${describeLock(lockAtPause)}`);
    if (lockAtPause.state === 'held') say(`  raw: ${lockAtPause.raw.trim()}`);
    try {
      const atPause = await getSessionState(uri, apiKey);
      say(`session while paused: surface=${atPause?.surface} totalStepsExecuted=${atPause?.totalStepsExecuted} ` +
        `(§4.5: the surface outlives a pause, the lock does not — expect 'computer')`);
    } catch (err) {
      say(`session while paused: GET /sessions/:id failed — ${err instanceof Error ? err.message : String(err)}`);
    }

    assert.equal(
      pausedAt,
      step5.line,
      `the run must park at the breakpoint on step 5 (line ${step5.line}); it came to rest ` +
        `with done='${hooks.lastDoneStatus()}' and the pause arrow on ${pausedAt}. ` +
        `Steptix shows no arrow when a step before the breakpoint failed. ` +
        `Marks: ${JSON.stringify(pausedMarks)}. Failures: ${failuresOn(hooks, uri)}. ` +
        `A failure at step 1 is usually a precondition: desktop.enabled false, nut.js not ` +
        `loading, a server that cannot read the screen (§5.1), or the lock held by another ` +
        `session. One at step 2 means open_calculator did not load (see the header).`,
    );
    assert.ok(hooks.isParkedAtPause(uri), 'the controller must report itself parked at the pause');
    for (let i = 0; i < 4; i++) {
      assert.ok(
        passed(pausedMarks[i]),
        `step ${steps[i].n} (line ${steps[i].line}) must have passed before the pause; got ` +
          `'${pausedMarks[i]}'. Failures: ${failuresOn(hooks, uri)}`,
      );
    }
    for (let i = 4; i < steps.length; i++) {
      assert.ok(
        !passed(pausedMarks[i]) && pausedMarks[i] !== 'fail',
        `step ${steps[i].n} (line ${steps[i].line}) must not have run before the pause; ` +
          `got '${pausedMarks[i]}'`,
      );
    }

    // The positive control for this phase: `[use computer]` takes the lock
    // (§5.1 item 3), so steps 1-4 ran holding it.
    assertServerHeldLockDuring(
      batch1.seen,
      serverPid,
      'batch 1 (steps 1-4)',
      'Step 1, [use computer], takes it (§5.1 item 3) and it is held until the batch ends.',
    );

    // ── The measurement: while parked, the server does not hold it. ────────
    assertLockNotHeldByServer(lockAtPause, serverPid, 'While Steptix is parked at the step 5 breakpoint');

    // ── Batch 2: Continue runs steps 5-9 and takes the lock again. ─────────
    hooks.clearRunError();
    say('Continue — steps 5-9: type 1+1, click =, read the display, close Calculator');
    const batch2 = watchLock(serverPid);
    void vscode.commands.executeCommand('steptix.continueRun');
    try {
      await runToRest(hooks, 'batch 2 (steps 5-9, after Continue)');
    } finally {
      batch2.stop();
    }

    const finalMarks = statusesOn(hooks, uri, lines);
    const done = hooks.lastDoneStatus();
    const summary = hooks.stepsSummaryForTests(uri);
    const lockAfter = readLock();
    say(`batch 2 at rest: done=${done} pausedAt=${hooks.tracker.snapshotFor(uri)?.breakpointStop ?? null} ` +
      `summary=${summary.passed}/${summary.total}`);
    say(`batch 2 run error: ${JSON.stringify(hooks.lastRunError() ?? null)}`);
    logMarks(steps, finalMarks);
    say(`batch 2 lock watch: ${describeWatch(batch2.seen)}`);
    say(`lock after the run: ${describeLock(lockAfter)}`);

    assert.equal(
      done,
      'passed',
      `the continued run must pass; got '${done}'. Marks: ${JSON.stringify(finalMarks)}. ` +
        `Failures: ${failuresOn(hooks, uri)}. A step 5 that fails with "computer mode is in ` +
        `use" means another session took the lock during the pause (§5.9).`,
    );
    steps.forEach((s, i) => {
      assert.ok(
        passed(finalMarks[i]),
        `step ${s.n} (line ${s.line}) must read as passed after Continue; got '${finalMarks[i]}'. ` +
          `Instruction: ${s.text}. A blank on steps 1-4 is the wiped-pass-marks regression.`,
      );
    });

    // Re-taken at step 5 — the first step after the resume that reads or
    // drives the screen (§4.5, §5.9). Also this phase's positive control.
    assertServerHeldLockDuring(
      batch2.seen,
      serverPid,
      'batch 2 (steps 5-9, after Continue)',
      'Step 5 is the first screen step after the resume, and must take the lock again (§5.9).',
    );
    assertLockNotHeldByServer(lockAfter, serverPid, 'After the continued run finished');

    assert.equal(
      doc.isDirty,
      false,
      `${FIXTURE} is dirty — keystrokes meant for Calculator landed in the editor, so ` +
        `something brought VS Code to the front between step 4 and step 5.`,
    );

    removeAllBreakpoints();
  });

  // -------------------------------------------------------------------------
  // 2. Run All again, same session, no breakpoint.
  // -------------------------------------------------------------------------
  it('a second Run All in the kept session passes 9/9 and takes the lock again', async function () {
    this.timeout(900_000);
    const lines = steps.map((s) => s.line);

    // Settle whatever scenario 1 left if it failed partway: a run still going,
    // a breakpoint, a pause arrow. A fresh Run All clears a stale pause itself.
    removeAllBreakpoints();
    if (hooks.isRunning()) {
      say('a run is still going from scenario 1 — stopping it through Steptix');
      await vscode.commands.executeCommand('steptix.stop');
      await waitFor('the leftover run stops', () => !hooks.isRunning(), 60_000);
    }

    const before = await getSessionState(uri, apiKey);
    say(`session before run 2: ${before
      ? `surface=${before.surface} totalStepsExecuted=${before.totalStepsExecuted}`
      : `none (server has: ${JSON.stringify(await listSessionIds(apiKey))})`}`);
    say(`lock before run 2: ${describeLock(readLock())}`);
    assert.ok(
      before,
      `scenario 1 must have left Steptix's session for ${uri.fsPath} open on the server; ` +
        `GET /sessions/:id found none. Sessions: ${JSON.stringify(await listSessionIds(apiKey))}`,
    );

    await vscode.commands.executeCommand('steptix.clearStatuses');
    hooks.clearRunError();
    say('Run All again, no breakpoint — DO NOT TOUCH THE MOUSE OR KEYBOARD');
    const run2 = watchLock(serverPid);
    void vscode.commands.executeCommand('steptix.runAll');
    try {
      await runToRest(hooks, 'run 2 (steps 1-9)');
    } finally {
      run2.stop();
    }

    const marks = statusesOn(hooks, uri, lines);
    const done = hooks.lastDoneStatus();
    const summary = hooks.stepsSummaryForTests(uri);
    const lockAfter = readLock();
    const after = await getSessionState(uri, apiKey);
    say(`run 2 at rest: done=${done} summary=${summary.passed}/${summary.total}`);
    say(`run 2 run error: ${JSON.stringify(hooks.lastRunError() ?? null)}`);
    logMarks(steps, marks);
    say(`run 2 lock watch: ${describeWatch(run2.seen)}`);
    say(`lock after run 2: ${describeLock(lockAfter)}`);
    say(`session after run 2: ${after
      ? `surface=${after.surface} totalStepsExecuted=${after.totalStepsExecuted}`
      : 'none'} (the run ends on the computer surface with no [use browser], so §4.5 predicts 'computer')`);

    assert.equal(
      done,
      'passed',
      `the second run must pass; got '${done}'. Marks: ${JSON.stringify(marks)}. ` +
        `Failures: ${failuresOn(hooks, uri)}`,
    );
    steps.forEach((s, i) => {
      assert.ok(
        passed(marks[i]),
        `step ${s.n} (line ${s.line}) must pass on the second run; got '${marks[i]}'. Instruction: ${s.text}`,
      );
    });

    // Taken again: run 1 gave it back at its end, and step 1's
    // [use computer] takes it for this run. Also this phase's positive control.
    assertServerHeldLockDuring(
      run2.seen,
      serverPid,
      'run 2',
      'Run 1 released it at its end, so step 1 ([use computer]) must take it again.',
    );
    assertLockNotHeldByServer(lockAfter, serverPid, 'After the second run finished');

    // Kept, not recreated: the same session id, and its step counter grew.
    // A session closed and re-opened under the same id would restart the
    // counter and end at this run's own count.
    assert.ok(after, `the session for ${uri.fsPath} is gone after run 2`);
    assert.ok(
      after.totalStepsExecuted > before.totalStepsExecuted,
      `totalStepsExecuted must have grown across run 2 (${before.totalStepsExecuted} -> ` +
        `${after.totalStepsExecuted}); a reset means the session was recreated, not kept`,
    );
    assert.ok(
      'surface' in after,
      `GET /sessions/:id must report 'surface' (§4.5); keys were ${JSON.stringify(Object.keys(after))}`,
    );
    assert.ok(
      after.surface === 'browser' || after.surface === 'computer',
      `GET /sessions/:id surface must be 'browser' or 'computer'; got ${JSON.stringify(after.surface)}`,
    );

    assert.equal(
      doc.isDirty,
      false,
      `${FIXTURE} is dirty — keystrokes meant for Calculator landed in the editor.`,
    );
  });
});

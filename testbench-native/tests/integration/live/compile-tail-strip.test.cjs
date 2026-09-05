/**
 * Live test for the compile tail's status strip
 * (stories/compile-tail-progress.md §The panel strip).
 *
 * The scripted suite already pins what the host DOES with a compile's frames
 * — `tests/integration/suite/codebehind.test.cjs` §"the compile tail" covers
 * the strip going up, tracking, coming down, and the version-skew form. What
 * it cannot cover is the premise those scripts encode: that a REAL server
 * emits `compile:progress` in the shape and the ORDER the client assumes.
 *
 * That gap is not hypothetical. The first review round of this feature found
 * the strip going up mid-run, because generation trails the browser — a real
 * server's `generating…` frames arrive while later steps are still running,
 * and the client was treating any compile frame as "the tail has begun". The
 * scripted test that should have caught it could not: it fed the frames in a
 * tidy order the real server does not produce. This test asserts the same
 * property against the frames the server actually sends.
 *
 * So the assertions here are deliberately RELATIONAL rather than literal —
 * the counts belong to a live run, not to a script. What is checked is the
 * ordering (no strip before the last step passed), the arithmetic (`done`
 * never goes backwards and never exceeds `total`), the phases (generation
 * gives way to Review), and the teardown (the strip is taken down, and the
 * workbench aggregator is left holding nothing).
 *
 * Local by construction: the target is `fixtures/test-app`, started here and
 * killed afterwards, so nothing depends on an external site.
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = 'pkent.testbench-native';
const TEST_APP_PORT = 8787;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {
      /* transient */
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

async function up(url) {
  try {
    const res = await fetch(url);
    return res.status > 0;
  } catch {
    return false;
  }
}

describe('TestBench live — the compile tail strip', function () {
  this.timeout(600_000);

  /** @type {import('../../../dist/extension/extension').TestBenchTestHooks} */
  let hooks;
  /** @type {import('node:child_process').ChildProcess | null} */
  let testApp = null;
  let testFile;
  let stepsFile;
  let cacheDir;
  /** True when this run started the fixture app and must stop it. */
  let startedApp = false;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks missing — activation may have failed');

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

    // Left alone if something is already serving it — the sibling live specs
    // share this fixture app and whichever runs first owns it.
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
      console.log(`[live] started fixtures/test-app on ${appUrl}`);
    } else {
      console.log(`[live] reusing the fixtures/test-app already on ${appUrl}`);
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — the live runner must pass templates/');
    testFile = path.resolve(workspaceRoot, 'init', 'tests', 'compile-codebehind.md');
    assert.ok(fs.existsSync(testFile), `compile-codebehind.md not found at ${testFile}`);
    stepsFile = testFile.replace(/\.md$/, '.steps.ts');
    cacheDir = path.join(path.dirname(testFile), '.aiui-codebehind-cache');
  });

  after(async () => {
    // This test's output, not a fixture. Left behind, the next run would serve
    // both steps as code, compile nothing, and raise no strip to assert on.
    fs.rmSync(stepsFile, { force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
    if (startedApp && testApp) {
      try {
        cp.execSync(`taskkill /pid ${testApp.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        testApp.kill();
      }
    }
  });

  it('raises the strip only once the run’s steps are done, tracks it, and takes it down', async () => {
    // A compiled file would make every step run as code, so nothing would be
    // generated and there would be no tail at all.
    fs.rmSync(stepsFile, { force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }

    const uri = vscode.Uri.file(testFile);
    // Shown, not just opened: `vscode.open` can return before the editor has
    // focus, so the activeTextEditor wait below raced its budget and failed a
    // full-suite run under load. showTextDocument resolves once it is shown.
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
      preview: false,
    });
    await waitFor(
      'compile-codebehind.md becomes the active editor',
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      15_000,
    );
    await waitFor('tracker recognises the test file', () => hooks.tracker.snapshot().isTestFile);
    await vscode.commands.executeCommand('testbench-native.restartSession');
    await sleep(1_000);

    // Everything asserted below is measured from here.
    const mark = hooks.hostMessageCount();

    void vscode.commands.executeCommand('testbench-native.runAndCompile');
    await waitFor(
      'the compile proposes files for THIS test',
      // Not merely "a proposal exists": one slot serves the whole extension
      // host, so a proposal an earlier test left behind answers that predicate
      // instantly and this test then asserts against another file.
      () => hooks.pendingCodeBehind()?.testFilePath.toLowerCase() === testFile.toLowerCase(),
      480_000,
    );
    await waitFor('idle', () => !hooks.isRunning(), 60_000);

    const msgs = hooks.hostMessagesSince(mark);
    const strips = msgs.filter((m) => m.type === 'compileProgress');
    assert.ok(strips.length > 0, 'the real server produced no strip messages at all');

    // ===== It went up, naming this file =====
    const states = strips.map((m) => m.state);
    const first = states.find((s) => s !== null);
    assert.ok(first, 'the strip never went up for a compile that produced a proposal');
    assert.equal(first.file, 'compile-codebehind.md');

    // ===== It did NOT go up while the run was still painting steps =====
    // The regression the scripted suite could not see: generation trails the
    // browser, so compile frames genuinely arrive mid-run. Only the ordering
    // a real server produces proves the client waits for the run to end.
    const lastStepPass = msgs.reduce(
      (acc, m, i) => (m.type === 'runEvent' && m.event?.type === 'step:pass' ? i : acc),
      -1,
    );
    assert.ok(lastStepPass >= 0, 'no step:pass reached the panel — the run did not report steps');
    const firstStrip = msgs.findIndex((m) => m.type === 'compileProgress' && m.state !== null);
    assert.ok(
      firstStrip > lastStepPass,
      `the strip went up at message ${firstStrip}, before the last step passed at ${lastStepPass}`,
    );
    // …and the guard above is only worth having if compile frames REALLY do
    // arrive mid-run, so assert the precondition rather than trusting it. If
    // the queue ever stopped trailing the browser — generation moved behind a
    // barrier at run end, say — the ordering assertion would start passing for
    // free, and this is the line that fails to say so.
    const compileFramesDuringRun = msgs
      .slice(0, lastStepPass)
      .filter((m) => m.type === 'compileEvent' || m.type === 'compileProgress').length;
    assert.ok(
      compileFramesDuringRun > 0,
      'no compile frame arrived before the run ended, so the ordering assertion above ' +
        'proved nothing — generation is no longer trailing the browser, or this fixture ' +
        'is too short to overlap',
    );

    // ===== The arithmetic the strip and the status bar are drawn from =====
    // Relational, because the counts belong to this run rather than a script.
    const counted = states.filter((s) => s && s.done !== null && s.total !== null);
    assert.ok(counted.length > 0, 'a current server must send counts, not only the indeterminate form');
    let previousDone = -1;
    for (const s of counted) {
      assert.ok(s.done >= previousDone, `done went backwards: ${previousDone} → ${s.done}`);
      assert.ok(s.done <= s.total, `done ${s.done} exceeded total ${s.total}`);
      previousDone = s.done;
    }
    const last = counted[counted.length - 1];
    assert.equal(last.done, last.total, 'the tail ended with entries still outstanding');
    // Both steps of this fixture are eligible, so the queue is the whole test.
    assert.equal(last.total, 2, 'expected both steps of compile-codebehind.md to be enqueued');

    // ===== Generation gave way to Review =====
    assert.ok(
      counted.some((s) => s.phase === 'generate'),
      'no generation phase reached the strip',
    );
    assert.ok(
      states.some((s) => s && s.phase === 'review'),
      'Review never reached the strip — the longest call in the tail stayed silent',
    );

    // ===== And it came down =====
    assert.equal(
      states[states.length - 1],
      null,
      'the strip outlived the compile — the panel would sit spinning after the diff opened',
    );
    assert.deepEqual(hooks.compileTails(), [], 'the status bar aggregator was left holding a finished tail');

    // ===== Every message was stamped for this file =====
    // Without the stamp the panel's Output section is one shared pane, which
    // is what makes two concurrent compiles interleave.
    for (const m of strips) {
      assert.equal(m.uri, uri.toString(), `a compileProgress message carried ${m.uri}`);
    }
  });
});

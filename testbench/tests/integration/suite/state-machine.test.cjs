/**
 * Drives the TestBench debug state machine end-to-end inside a real VS Code
 * extension host. Uses a FakeApiClient injected via the extension's
 * __testHooks export so the assertions are deterministic and don't depend
 * on a Sessions API server, AI gateway, or Playwright browser.
 *
 * Each test follows the same shape:
 *   1. Open the fixture .md, wait for it to be the active editor.
 *   2. Trigger a command (testbench.runSelected / pause / stop / resume).
 *   3. Push synthesized events onto the fake stream.
 *   4. Assert tracker state + isRunning() across the transition.
 *
 * Coverage maps to the spec at testbench/stories/specs/debugging-ux.md.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');
const { FakeApiClient } = require('../fakes/fake-api-client.cjs');

const EXT_ID = 'pkent.testbench';
const FIXTURES_DIR =
  process.env.TESTBENCH_FIXTURES_DIR ||
  path.resolve(__dirname, '..', 'fixtures');
const fixtureUri = (name) => vscode.Uri.file(path.resolve(FIXTURES_DIR, name));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {
      // ignore — predicate transient errors are part of the wait
    }
    await sleep(50);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

describe('TestBench debug state machine', function () {
  this.timeout(20_000);

  /** @type {FakeApiClient} */
  let fake;
  /** @type {import('../../../dist/extension/extension').TestBenchTestHooks} */
  let hooks;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks not exposed — did activate() forget to return them?');
  });

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }
    fake = new FakeApiClient();
    hooks.setApiClientFactory(() => fake);

    // Open the fixture and select the first step line. Selecting tells
    // testbench.runSelected which line to run — we always pick line 9
    // ("1. Navigate to https://example.com" in the fixture).
    const uri = fixtureUri('test-with-steps.md');
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('fixture editor active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === uri.toString();
    });
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(8, 0), // 0-based: line 9 is index 8
      new vscode.Position(8, 0),
    );

    // Wait a beat for the activeFile context key to flip true after the
    // editor open (driven by ActiveFileTracker).
    await waitFor('active file detected as test file', () => {
      const snap = hooks.tracker.snapshot();
      return snap.isTestFile === true;
    });
  });

  it('idle → running: runSelected starts a run and reports running', async () => {
    assert.equal(hooks.isRunning(), false, 'should start idle');

    void vscode.commands.executeCommand('testbench.runSelected');

    await waitFor('isRunning becomes true', () => hooks.isRunning());
    await waitFor('fake stream is active', () => fake.hasActiveStream);
    assert.equal(hooks.isRunning(), true);

    // Tear down cleanly so the test doesn't leak a controller.
    fake.end();
    await waitFor('isRunning returns false after stream ends', () => !hooks.isRunning());
  });

  it('running → idle (success): step events drive statuses, done flips running off', async () => {
    void vscode.commands.executeCommand('testbench.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'step:start', line: 9 });
    await waitFor('status running on line 9', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });

    fake.push({ type: 'step:pass', line: 9 });
    await waitFor('status pass on line 9', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'pass';
    });

    fake.end();
    await waitFor('idle after stream ends', () => !hooks.isRunning());
    assert.equal(hooks.tracker.snapshot().breakpointStop, null);
  });

  it('running → idle (stop): testbench.stop aborts immediately, no pause marker', async () => {
    void vscode.commands.executeCommand('testbench.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    await waitFor('status running', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });

    await vscode.commands.executeCommand('testbench.stop');

    await waitFor('idle after stop', () => !hooks.isRunning());
    const snap = hooks.tracker.snapshot();
    assert.equal(
      snap.breakpointStop,
      null,
      'Stop must clear pause indicator (per spec §6)',
    );
  });

  it('running → paused (user pause): testbench.pause marks resume point', async () => {
    void vscode.commands.executeCommand('testbench.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    await waitFor('status running on line 9', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });

    await vscode.commands.executeCommand('testbench.pause');

    await waitFor('breakpointStop is set to executing line', () => {
      return hooks.tracker.snapshot().breakpointStop === 9;
    });
    await waitFor('isRunning becomes false', () => !hooks.isRunning());
  });

  it('paused → running (resume): testbench.resume re-opens the stream from paused line', async () => {
    // Drive into paused state.
    void vscode.commands.executeCommand('testbench.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    await waitFor('running on line 9', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });
    await vscode.commands.executeCommand('testbench.pause');
    await waitFor('paused at 9', () => hooks.tracker.snapshot().breakpointStop === 9);
    await waitFor('idle while paused', () => !hooks.isRunning());

    // Resume — opens a new stream from line 9 with skipBreakpointAtStart.
    // Fire-and-forget: the command body awaits runLines() which awaits the
    // stream, so awaiting the command here would deadlock since this test
    // is the one feeding the stream events.
    void vscode.commands.executeCommand('testbench.resume');
    await waitFor('isRunning back to true', () => hooks.isRunning());
    await waitFor('new fake stream', () => fake.hasActiveStream);
    assert.equal(
      hooks.tracker.snapshot().breakpointStop,
      null,
      'Resume must clear the pause indicator',
    );

    fake.end();
    await waitFor('idle after resume completes', () => !hooks.isRunning());
  });

  it('running → paused (auto): hitting a breakpoint trims the run and reports pause AFTER prior steps finish', async () => {
    // Set a breakpoint on a later step (line 10 → "3. Verify ...").
    const uri = vscode.window.activeTextEditor.document.uri;
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(9, 0)),
        true,
      ),
    ]);

    // Run from line 9, with the breakpoint on line 10. The runner should
    // execute step 9, then pause before step 10.
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(
      new vscode.Position(8, 0),
      new vscode.Position(9, 0),
    );

    void vscode.commands.executeCommand('testbench.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    // Spec promise: the yellow ▶ should NOT appear before the preceding
    // steps actually finish. trimAtBreakpoint computes pausedAt synchronously
    // when the run kicks off, but the controller must defer publishing
    // breakpointStop until execution genuinely reaches that point.
    assert.equal(
      hooks.tracker.snapshot().breakpointStop,
      null,
      'breakpointStop must NOT be set while line 9 is still running',
    );

    fake.push({ type: 'step:start', line: 9 });
    await waitFor('status running on line 9', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });
    assert.equal(
      hooks.tracker.snapshot().breakpointStop,
      null,
      'breakpointStop still must not be set mid-step',
    );

    fake.push({ type: 'step:pass', line: 9 });
    fake.end();

    // Only after step 9 passes and the stream drains should the pause
    // indicator land on line 10 — and the runner should be idle.
    await waitFor('breakpointStop becomes line 10 after step 9 completes', () => {
      return hooks.tracker.snapshot().breakpointStop === 10;
    });
    await waitFor('idle after trimmed run', () => !hooks.isRunning());
  });

  it('running → paused (early pause): Pause before any step:start still marks a resume point', async () => {
    // This guards the bug where pausing immediately after Run — before
    // the server emits the first step:start event — would leave the
    // controller without a resume point. Without the classified[0]
    // fallback, paused state never gets set and the Resume button
    // doesn't render.
    void vscode.commands.executeCommand('testbench.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    // No step:start pushed — pause immediately.
    await vscode.commands.executeCommand('testbench.pause');

    await waitFor('breakpointStop falls back to first selected step', () => {
      return hooks.tracker.snapshot().breakpointStop === 9;
    });
    await waitFor('isRunning becomes false', () => !hooks.isRunning());
  });

  it('paused → idle (stop): Stop while paused clears the pause indicator', async () => {
    // Trigger a pause via breakpoint.
    const uri = vscode.window.activeTextEditor.document.uri;
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(8, 0)),
        true,
      ),
    ]);
    void vscode.commands.executeCommand('testbench.runSelected');
    await waitFor('paused at 9', () => hooks.tracker.snapshot().breakpointStop === 9);
    await waitFor('idle while paused', () => !hooks.isRunning());

    await vscode.commands.executeCommand('testbench.stop');
    await waitFor('breakpointStop cleared', () => hooks.tracker.snapshot().breakpointStop === null);
    assert.equal(hooks.isRunning(), false);
  });

  it('breakpoint on first selected step: pauses immediately, no stream opens', async () => {
    // Audit gap: existing trim-pause test puts the breakpoint on the *second*
    // selected step, so the trimmed run still has one item and the stream
    // opens. The empty-trim branch (`classified.length === 0` in
    // run-controller.runLines) is its own code path — pause indicator goes up
    // and `done(aborted)` fires without ever creating a fake stream.
    const uri = vscode.window.activeTextEditor.document.uri;
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(8, 0)), // line 9, the only selected step
        true,
      ),
    ]);

    void vscode.commands.executeCommand('testbench.runSelected');

    await waitFor('paused at line 9', () => hooks.tracker.snapshot().breakpointStop === 9);
    await waitFor('idle (no stream needed)', () => !hooks.isRunning());
    assert.equal(
      fake.hasActiveStream,
      false,
      'Empty-trim branch must short-circuit before opening a stream',
    );
  });

  it('paused (early) → running (resume): resume from a fallback-derived pause point opens a stream', async () => {
    // Audit gap: existing resume test pauses *after* a step:start arrived,
    // so the resume line is the real lastStepStartLine. With early-pause the
    // breakpointStop is sourced from classified[0]?.line — same dispatcher
    // path, but verifying it round-trips through resume too.
    void vscode.commands.executeCommand('testbench.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    // Pause before any step:start — fallback path sets breakpointStop = 9.
    await vscode.commands.executeCommand('testbench.pause');
    await waitFor('paused at 9 via fallback', () => hooks.tracker.snapshot().breakpointStop === 9);
    await waitFor('idle while paused', () => !hooks.isRunning());

    void vscode.commands.executeCommand('testbench.resume');
    await waitFor('isRunning back to true', () => hooks.isRunning());
    await waitFor('new fake stream', () => fake.hasActiveStream);
    assert.equal(
      hooks.tracker.snapshot().breakpointStop,
      null,
      'Resume must clear pause indicator regardless of where it came from',
    );

    fake.push({ type: 'step:start', line: 9 });
    fake.push({ type: 'step:pass', line: 9 });
    fake.end();
    await waitFor('idle after resume completes', () => !hooks.isRunning());
  });

  it('resume sends ALL steps from the pause point onward, not just the paused step', async () => {
    // Audit gap: existing resume test asserts a stream re-opens, but doesn't
    // check *which* steps it carries. With runLines([startLine]) and a
    // step-line startLine, resolveRunLines collapses to a single-step run —
    // so resume only re-executes the paused step then ends, instead of
    // continuing forward. The user's spec promise is "Resume continues
    // from the pause point" (analogous to F5 in a debugger), which means
    // resume must carry steps from startLine through end-of-document.
    void vscode.commands.executeCommand('testbench.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'step:start', line: 9 });
    await waitFor('running on line 9', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });
    await vscode.commands.executeCommand('testbench.pause');
    await waitFor('paused at 9', () => hooks.tracker.snapshot().breakpointStop === 9);
    await waitFor('idle while paused', () => !hooks.isRunning());

    const requestsBeforeResume = fake.requests.length;

    void vscode.commands.executeCommand('testbench.resume');
    await waitFor('new fake stream after resume', () => fake.hasActiveStream);

    // The fixture (test-with-steps.md) has steps on lines 8, 9, 10
    // (1-based). Pause is on line 9, so resume must carry lines 9 and 10
    // — not just line 9.
    const resumeRequest = fake.requests[requestsBeforeResume];
    assert.ok(resumeRequest, 'Resume should have triggered a new streamSteps call');
    assert.deepEqual(
      resumeRequest.sourceLines,
      [9, 10],
      `Resume must carry every step from the pause point through end-of-document, not just the paused step. Got ${JSON.stringify(resumeRequest.sourceLines)}.`,
    );

    fake.end();
    await waitFor('idle after resume', () => !hooks.isRunning());
  });

  it('Run after a pause clears the stale yellow arrow before the stream opens', async () => {
    // Bug guard: the clear of stale breakpointStop used to live AFTER env-
    // file resolution inside runLines. On Windows that's 50-200ms of file
    // I/O, during which the previous pause's yellow ▶ stayed pinned to the
    // breakpoint line. To the user that read as "the arrow jumped straight
    // to the breakpoint as soon as I clicked Run."
    //
    // The contract: by the time the stream opens, the stale arrow MUST be
    // gone. The new run owns the indicator from then on.
    void vscode.commands.executeCommand('testbench.runSelected');
    await waitFor('first stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    await waitFor('running on 9', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });
    await vscode.commands.executeCommand('testbench.pause');
    await waitFor('paused at 9', () => hooks.tracker.snapshot().breakpointStop === 9);
    await waitFor('idle while paused', () => !hooks.isRunning());
    assert.equal(hooks.tracker.snapshot().breakpointStop, 9, 'precondition: arrow at line 9');

    // Click Run again (NOT Resume — Run starts fresh and should drop the
    // stale arrow before any visible delay).
    void vscode.commands.executeCommand('testbench.runSelected');

    // By the time the new stream opens, the stale breakpointStop must be
    // cleared. If the clear were still buried after env resolution, we'd
    // observe `breakpointStop === 9` here on slower hosts.
    await waitFor('new stream active for the second run', () => fake.hasActiveStream);
    assert.equal(
      hooks.tracker.snapshot().breakpointStop,
      null,
      'Stale yellow arrow must clear before the new run opens its stream',
    );

    fake.end();
    await waitFor('idle after second run', () => !hooks.isRunning());
  });

  it('Resume flips testbench.running to true synchronously, before any new step events arrive', async () => {
    // Bug guard: the editor title-bar Pause/Stop icons are gated on the
    // `testbench.running` context key. The original implementation polled
    // anyRunning() inside notifyRunning(true) — but that hook fires
    // synchronously BEFORE controller.runLines() sets controller.active,
    // so the poll read false and the context key got pinned at false until
    // a run event drove a refresh. To the user this looked like "Pause
    // disappeared the moment I clicked Resume" until the first step:start
    // arrived seconds later.
    void vscode.commands.executeCommand('testbench.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 9 });
    await waitFor('running on 9', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[9] === 'running';
    });
    await vscode.commands.executeCommand('testbench.pause');
    await waitFor('paused at 9', () => hooks.tracker.snapshot().breakpointStop === 9);
    await waitFor('idle while paused', () => !hooks.isRunning());
    assert.equal(
      hooks.runningContextValue(),
      false,
      'context key must be false while paused',
    );

    // Click Resume. We deliberately do NOT push step:start yet — the test
    // is about state in the gap between the resume command firing and the
    // first run event arriving. Use `await` here because resume is async
    // and we want it to drain notifyRunning(true) before we poll.
    void vscode.commands.executeCommand('testbench.resume');

    // Two microtask ticks is enough — extension.ts case 'resume' calls
    // notifyRunning(true) synchronously before the first await.
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(
      hooks.runningContextValue(),
      true,
      'Resume must flip testbench.running=true synchronously, not after the first stream event',
    );

    // Sanity: the context key stays true even if no events arrive for a
    // moment.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      hooks.runningContextValue(),
      true,
      'context key must stay true while waiting for stream events',
    );

    fake.end();
    await waitFor('idle after fake.end', () => !hooks.isRunning());
    assert.equal(
      hooks.runningContextValue(),
      false,
      'context key must drop to false after the run finishes',
    );
  });

  it('resume from breakpoint-trim pause skips the breakpoint on the resume line', async () => {
    // Audit gap: existing resume test resumes from a user-pause line that
    // has no breakpoint on it. After a breakpoint-trim pause the resume
    // line *is* the breakpoint line — skipBreakpointAtStart must let it
    // through, otherwise resume would re-pause on the same line forever.
    const uri = vscode.window.activeTextEditor.document.uri;
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(8, 0)), // line 9
        true,
      ),
    ]);

    void vscode.commands.executeCommand('testbench.runSelected');
    await waitFor('paused at line 9 via trim', () => hooks.tracker.snapshot().breakpointStop === 9);
    await waitFor('idle while paused', () => !hooks.isRunning());

    // Resume — must skip the breakpoint on line 9 and actually open a stream.
    void vscode.commands.executeCommand('testbench.resume');
    await waitFor('stream opens after resume past breakpoint', () => fake.hasActiveStream);
    assert.equal(
      hooks.tracker.snapshot().breakpointStop,
      null,
      'Resume must clear pause even though line 9 still has a breakpoint',
    );

    fake.push({ type: 'step:start', line: 9 });
    fake.push({ type: 'step:pass', line: 9 });
    fake.end();
    await waitFor('idle after resume completes', () => !hooks.isRunning());
  });
});

/**
 * Pre-run server check + auto-start, inside a real VS Code extension host
 * (story server-lifecycle §5).
 *
 * The health probe and the spawn are injected via `__testHooks.setServerHooks`
 * for the same reason the ApiClient is: a raw `fetch` in the run path would
 * bypass the fake and hit a real socket, and a real spawn would leave a server
 * process behind.
 *
 * What's asserted here is the DECISION TREE — which branch a given probe
 * result takes, and critically what each branch does NOT do (spawn on a
 * foreign port, refuse a legacy server, report STX028 for a user Stop). The
 * classification of probe results themselves is unit-tested in
 * tests/server-manager.test.js.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');
const { FakeApiClient } = require('../fakes/fake-api-client.cjs');

const EXT_ID = 'pkent.steptix-vscode';
const FIXTURES_DIR =
  process.env.STEPTIX_FIXTURES_DIR || path.resolve(__dirname, '..', 'fixtures');
const fixtureUri = (name) => vscode.Uri.file(path.resolve(FIXTURES_DIR, name));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {
      /* transient predicate errors are part of the wait */
    }
    await sleep(50);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

const HEALTHY = (over = {}) => ({
  kind: 'healthy',
  health: { service: 'steptix', version: '9.9.9', inspector: null, ...over },
});

describe('Steptix server lifecycle (pre-run check + auto-start)', function () {
  this.timeout(30_000);

  /** @type {FakeApiClient} */
  let fake;
  /** @type {import('../../../dist/extension/extension').SteptixTestHooks} */
  let hooks;
  /** Every spawn the run path attempted. */
  let spawns;
  /**
   * What the probe currently answers. Deliberately a single mutable value
   * rather than a call-ordinal script: the status bar polls through the SAME
   * injected probe, so anything counting calls would be perturbed by a
   * background refresh landing mid-test.
   */
  let probeResult;
  /** When set, a spawn flips `probeResult` to healthy — the server coming up. */
  let spawnBringsServerUp;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks not exposed');
  });

  /** Set the machine-scoped auto-start settings (Global target — the test
   *  instance has its own user-data-dir, so this touches nothing real). */
  async function setAutoStart({ command, cwd, readyTimeoutSeconds }) {
    const cfg = vscode.workspace.getConfiguration('steptix');
    await cfg.update('serverAutoStart.command', command, vscode.ConfigurationTarget.Global);
    await cfg.update('serverAutoStart.cwd', cwd, vscode.ConfigurationTarget.Global);
    await cfg.update(
      'serverAutoStart.readyTimeoutSeconds',
      readyTimeoutSeconds,
      vscode.ConfigurationTarget.Global,
    );
  }

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }
    spawns = [];
    probeResult = HEALTHY();
    spawnBringsServerUp = false;
    fake = new FakeApiClient();
    // lastRunError is registry-wide and sticky — without this, "no error was
    // reported" assertions read the PREVIOUS test's STX027/STX028.
    hooks.clearRunError();

    hooks.setApiClientFactory(() => fake);
    hooks.setServerHooks({
      healthProbe: async () => probeResult,
      spawnServer: (args) => {
        spawns.push(args);
        if (spawnBringsServerUp) probeResult = HEALTHY();
      },
      // Real cadence is 5 minutes; shrink it so the PING is observable, not
      // just the timer's existence.
      keepAliveIntervalMs: 60,
    });
    await setAutoStart({ command: '', cwd: '', readyTimeoutSeconds: 20 });

    const uri = fixtureUri('test-with-steps.md');
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('fixture active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === uri.toString();
    });
    await waitFor('active file detected', () => hooks.tracker.snapshot().isTestFile);
  });

  // Reset after EVERY test, not just at suite end. These are Global settings
  // and every other suite in the host inherits them, so a test that fails or
  // times out mid-way must not leave `serverAutoStart.command` set — that
  // makes every later suite's runs try to spawn a server and time out too.
  // (Consolidating this into a single `after` hook looks like a saving and is
  // not: it only holds when every test in this suite completes normally.)
  afterEach(async () => {
    await setAutoStart({ command: '', cwd: '', readyTimeoutSeconds: 20 });
    // The probe and cadence are registry-wide too, and this suite does not run
    // last. Leaving a closure that answers `foreign` (or a 60ms keep-alive)
    // behind would break every later suite with no clue pointing back here.
    hooks.setServerHooks({
      healthProbe: async () => HEALTHY(),
      keepAliveIntervalMs: 5 * 60_000,
    });
  });

  // -------------------------------------------------------------------------
  // §5.2–5.5 — the probe branches
  // -------------------------------------------------------------------------

  it('healthy server: the run proceeds and nothing is spawned', async () => {
    probeResult = HEALTHY({ inspector: 'ws://127.0.0.1:53012/abc' });

    void vscode.commands.executeCommand('steptix.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    assert.deepEqual(spawns, [], 'a healthy server must never be spawned over');
    // The inspector URL is stored run-scoped for tool step-into (§7.1).
    assert.equal(hooks.inspectorUrl(), 'ws://127.0.0.1:53012/abc');

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('foreign service: STX027, no spawn, no session created', async () => {
    probeResult = { kind: 'foreign', service: 'grafana' };
    // Configured — so the ONLY thing stopping a spawn is the foreign identity.
    await setAutoStart({ command: 'node server.js', cwd: FIXTURES_DIR, readyTimeoutSeconds: 1 });

    await vscode.commands.executeCommand('steptix.runAll');
    await waitFor('STX027 reported', () => hooks.lastRunError()?.code === 'STX027');

    assert.deepEqual(spawns, [], 'must never spawn on top of a foreign process');
    assert.equal(fake.streamCallCount, 0, 'no session should be created');
    assert.match(hooks.lastRunError().diagnosis, /grafana/);
    assert.equal(hooks.isRunning(), false);
  });

  it('unidentifiable server (404): the run proceeds on the legacy path', async () => {
    // This is what a Steptix server predating /health looks like. Refusing it
    // would break every older server; spawning over it would double-bind.
    probeResult = { kind: 'unknown', detail: 'HTTP 404' };
    await setAutoStart({ command: 'node server.js', cwd: FIXTURES_DIR, readyTimeoutSeconds: 1 });

    void vscode.commands.executeCommand('steptix.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    assert.deepEqual(spawns, [], 'never spawn against a reachable port');
    assert.equal(hooks.lastRunError(), null, 'never refuse a legacy server');
    // No health data ⇒ tool step-into falls back to the settings (§7.4).
    assert.equal(hooks.inspectorUrl(), undefined);

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('down + auto-start unconfigured: the run proceeds to the existing STX010 path', async () => {
    probeResult = { kind: 'down', detail: 'ECONNREFUSED' };

    void vscode.commands.executeCommand('steptix.runAll');
    // Nothing was configured, so we must not spawn — the run goes ahead and
    // the real connect failure surfaces through the client as before.
    await waitFor('stream attempted', () => fake.hasActiveStream || !hooks.isRunning());
    assert.deepEqual(spawns, []);
    assert.notEqual(hooks.lastRunError()?.code, 'STX028');

    if (fake.hasActiveStream) fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  // -------------------------------------------------------------------------
  // §5.6 — auto-start
  // -------------------------------------------------------------------------

  it('down + configured: spawns, waits for health, then runs', async () => {
    probeResult = { kind: 'down', detail: 'ECONNREFUSED' };
    spawnBringsServerUp = true; // the spawn is what makes it healthy
    await setAutoStart({ command: 'node dist/index.js serve', cwd: FIXTURES_DIR, readyTimeoutSeconds: 10 });

    void vscode.commands.executeCommand('steptix.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    assert.equal(spawns.length, 1, 'exactly one spawn');
    assert.equal(spawns[0].command, 'node dist/index.js serve');
    assert.equal(spawns[0].cwd, FIXTURES_DIR);
    assert.match(spawns[0].logPath, /server\.log$/);
    assert.equal(hooks.lastRunError(), null);

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('never healthy: STX028 within readyTimeoutSeconds', async () => {
    probeResult = { kind: 'down', detail: 'ECONNREFUSED' };
    await setAutoStart({ command: 'node dist/index.js serve', cwd: FIXTURES_DIR, readyTimeoutSeconds: 1 });

    const started = Date.now();
    await vscode.commands.executeCommand('steptix.runAll');
    await waitFor('STX028 reported', () => hooks.lastRunError()?.code === 'STX028');

    assert.equal(spawns.length, 1);
    assert.equal(fake.streamCallCount, 0, 'the run must not reach the server');
    assert.ok(Date.now() - started < 15_000, 'gave up around the configured budget');
  });

  it('a failed start is not retried by the next run — no per-test spawn storm', async () => {
    // A Test Explorer batch re-runs the whole pre-run phase per test. With a
    // broken command that would mean one detached shell and one full
    // readyTimeoutSeconds stall PER TEST, so a 40-test batch spawns 40 shells
    // and stalls for minutes before reporting 40 identical STX028s.
    probeResult = { kind: 'down', detail: 'ECONNREFUSED' };
    await setAutoStart({ command: 'node dist/index.js serve', cwd: FIXTURES_DIR, readyTimeoutSeconds: 1 });

    await vscode.commands.executeCommand('steptix.runAll');
    await waitFor('first STX028', () => hooks.lastRunError()?.code === 'STX028');
    assert.equal(spawns.length, 1);

    hooks.clearRunError();
    await vscode.commands.executeCommand('steptix.runAll');
    await waitFor('second STX028', () => hooks.lastRunError()?.code === 'STX028');

    assert.equal(spawns.length, 1, 'the second run must not spawn again');
    assert.match(
      hooks.lastRunError().diagnosis,
      /did not retry/,
      'and it should say why, rather than repeating the original failure',
    );
  });

  it('cwd blank while command is set: STX028, and NOTHING is spawned', async () => {
    // The security-relevant branch: the command is cwd-relative, so a blank
    // cwd must never fall back to the open workspace folder.
    probeResult = { kind: 'down', detail: 'ECONNREFUSED' };
    await setAutoStart({ command: 'node dist/index.js serve', cwd: '', readyTimeoutSeconds: 5 });

    await vscode.commands.executeCommand('steptix.runAll');
    await waitFor('STX028 reported', () => hooks.lastRunError()?.code === 'STX028');

    assert.deepEqual(spawns, [], 'must not spawn without an explicit cwd');
    assert.match(hooks.lastRunError().diagnosis, /cwd/);

    // A refusal never spawned anything, so it must NOT arm the retry backoff:
    // once the user fixes cwd the next run has to actually try, and until
    // then the message must keep naming the real problem rather than
    // "a previous attempt failed".
    hooks.clearRunError();
    await vscode.commands.executeCommand('steptix.runAll');
    await waitFor('second STX028', () => hooks.lastRunError()?.code === 'STX028');
    assert.match(hooks.lastRunError().diagnosis, /cwd/, 'still the actionable diagnosis');
  });

  // -------------------------------------------------------------------------
  // §3 — breakpoint-pause keep-alive
  // -------------------------------------------------------------------------

  it('a run paused at a breakpoint pings the session, and stops on resume', async () => {
    // A breakpoint pause is client-side: the batch is truncated, the server
    // finishes it, and the session sits with NO run in flight — invisible to
    // the server's idle accounting. Without the keep-alive the idle shutdown
    // would close the browser out from under a user who is just thinking.
    //
    // The interval itself is 5 minutes, so what is asserted here is the
    // lifecycle (armed while paused, released on resume) rather than a tick.
    const editor = vscode.window.activeTextEditor;
    const bpLine = 9; // "2. Click the 'Get started' button"
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(editor.document.uri, new vscode.Position(bpLine - 1, 0)),
        true,
      ),
    ]);

    void vscode.commands.executeCommand('steptix.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 8 });
    fake.push({ type: 'step:pass', line: 8 });
    fake.end();
    // Wait for the PAUSE specifically — "not running" alone would also be
    // true of a run that never paused, which would make this vacuous.
    await waitFor('paused at the breakpoint', () => hooks.tracker.snapshot().breakpointStop === bpLine);
    await waitFor('idle while paused', () => !hooks.isRunning());

    assert.equal(hooks.keepAliveActive(), true, 'keep-alive armed while paused');

    // The timer existing is not the point — the authenticated PING is. An
    // empty interval body would still "arm" while the idle shutdown reaped
    // the session the user is paused in.
    const pingsBefore = fake.isSessionAliveCalls.length;
    await waitFor('keep-alive ping observed', () => fake.isSessionAliveCalls.length > pingsBefore);
    const ping = fake.isSessionAliveCalls[fake.isSessionAliveCalls.length - 1];
    assert.equal(
      ping.sessionId,
      editor.document.uri.fsPath,
      'the ping must target the paused session, or it pins nothing',
    );

    // Resume supersedes the pause — the timer must not outlive it. Clear the
    // breakpoint first, or the next run simply pauses at it again and
    // legitimately re-arms, which would make the final assertion meaningless.
    vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    void vscode.commands.executeCommand('steptix.runAll');
    await waitFor('resumed', () => fake.streamCallCount >= 2);
    assert.equal(hooks.keepAliveActive(), false, 'keep-alive released on resume');

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
    assert.equal(hooks.keepAliveActive(), false, 'a completed run holds no keep-alive');
  });

  it('Stop releases a paused run keep-alive', async () => {
    const editor = vscode.window.activeTextEditor;
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(editor.document.uri, new vscode.Position(8, 0)),
        true,
      ),
    ]);

    void vscode.commands.executeCommand('steptix.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 8 });
    fake.push({ type: 'step:pass', line: 8 });
    fake.end();
    await waitFor('paused at the breakpoint', () => hooks.tracker.snapshot().breakpointStop === 9);
    await waitFor('idle while paused', () => !hooks.isRunning());
    assert.equal(hooks.keepAliveActive(), true);

    await vscode.commands.executeCommand('steptix.stop');
    assert.equal(hooks.keepAliveActive(), false, 'a leaked timer would pin the server forever');

    // ...and it really stops pinging, not just reports stopped.
    const after = fake.isSessionAliveCalls.length;
    await sleep(250); // several keep-alive intervals at the injected cadence
    assert.equal(fake.isSessionAliveCalls.length, after, 'no pings after Stop');
  });

  // -------------------------------------------------------------------------
  // §7 — inspector discovery, the branch that used to fail silently
  // -------------------------------------------------------------------------

  it('inspector: null acks the tool pause instead of attaching to some other process', async () => {
    // The original bug: with no inspector on the server, the extension
    // attached to whatever held the settings port, acked, and the user's
    // breakpoint never hit. Now `null` means "do not attach" — the run
    // continues without a debugger rather than with the wrong one.
    probeResult = HEALTHY({ inspector: null });

    void vscode.commands.executeCommand('steptix.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);
    assert.equal(hooks.inspectorUrl(), null, 'null must survive as null, not undefined');

    fake.push({ type: 'tool:awaiting-debugger', toolName: 'echo', line: 8 });
    await waitFor('tool pause acked', () => fake.ackToolDebuggerCalls.length > 0);

    // No debug session was started — the attach was skipped, not attempted.
    assert.equal(vscode.debug.activeDebugSession, undefined);

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  // -------------------------------------------------------------------------
  // §5.7 — two-window race
  // -------------------------------------------------------------------------

  it('two-window race: the loser\'s dead child still resolves once the winner answers', async () => {
    // Both windows see "down" and spawn; the loser's child dies on
    // EADDRINUSE. Poll-until-healthy is what makes that self-resolving — the
    // loser's poll goes green against the WINNER's server, so no locking is
    // needed and the run proceeds normally.
    probeResult = { kind: 'down', detail: 'ECONNREFUSED' };
    await setAutoStart({ command: 'node dist/index.js serve', cwd: FIXTURES_DIR, readyTimeoutSeconds: 10 });

    void vscode.commands.executeCommand('steptix.runAll');
    await waitFor('spawn attempted', () => spawns.length === 1);

    // Our child never comes up; the other window's server does.
    probeResult = HEALTHY();

    await waitFor('stream active', () => fake.hasActiveStream);
    assert.equal(spawns.length, 1, 'no retry storm — one spawn, then poll');
    assert.equal(hooks.lastRunError(), null, 'a lost race is not a run failure');

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('Stop during the health poll: the run is aborted, not a STX028', async () => {
    probeResult = { kind: 'down', detail: 'ECONNREFUSED' };
    await setAutoStart({ command: 'node dist/index.js serve', cwd: FIXTURES_DIR, readyTimeoutSeconds: 30 });

    void vscode.commands.executeCommand('steptix.runAll');
    // Wait until the poll is genuinely under way (the spawn has happened).
    await waitFor('spawn attempted', () => spawns.length === 1);

    await vscode.commands.executeCommand('steptix.stop');
    await waitFor('idle', () => !hooks.isRunning());

    assert.notEqual(
      hooks.lastRunError()?.code,
      'STX028',
      'a user Stop is not an auto-start failure',
    );
    // §5 states the outcome as a STATUS, which no error-code assertion can
    // prove — a regression reporting STX010 would satisfy the check above.
    assert.equal(hooks.lastDoneStatus(), 'aborted');
    assert.equal(fake.streamCallCount, 0);
  });
});

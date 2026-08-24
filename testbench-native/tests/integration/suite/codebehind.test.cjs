/**
 * Compiling code-behind, inside the extension host
 * (stories/compile-as-you-go.md).
 *
 * Since that story a compile IS a run: the extension sends `compile: 'run'`
 * (Run & Compile) or `compile: 'steps'` (Compile This Step) on the ordinary
 * step request, and the proposal comes back on the run's own stream as
 * `compile:step` frames and one terminal `compile:result`. There is no Record
 * phase and no Replay rounds, and `POST /codebehind/compile` is no longer
 * reachable from the extension at all.
 *
 * Three halves, and they fail in different ways:
 *
 *   - the request — does pressing Run & Compile (or Compile This Step) reach
 *     the client with `compile` set and the right steps? A field the wire
 *     drops is invisible until a real server ignores it.
 *   - the proposal — does `compile:result` end with a diff the author can
 *     apply? The diff editors themselves are not readable from here, so the
 *     assertion is on what they were opened WITH (`pendingCodeBehind`) plus,
 *     for Apply, the bytes on disk afterwards.
 *   - the gutter — do `fromCodeBehind` / `codeBehindStale` on a step:pass
 *     reach the tracker as </> / ⚠ rather than a plain ✓? That mapping lives in
 *     one `switch` on the event, and a wrong branch there is invisible until
 *     someone looks at a real run.
 *
 * The fixture is written per test rather than shared: Apply writes a real
 * `.steps.ts` into the workspace, and a leftover would make the next run's
 * "nothing to compile" indistinguishable from a broken compile.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { FakeApiClient } = require('../fakes/fake-api-client.cjs');
const { ApiClientError } = require('ai-ui-automation-runner-core');

const EXT_ID = 'pkent.testbench-native';
const FIXTURES_DIR =
  process.env.TESTBENCH_FIXTURES_DIR || path.resolve(__dirname, '..', 'fixtures');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {
      /* transient */
    }
    await sleep(50);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

const TEST_MD = `---
tags: [codebehind]
---

# Compile Me

## Steps
1. Navigate to https://example.com
2. Click the "Get started" button
`;

/**
 * A test whose steps sit BELOW a `### Section` call — the shape the old
 * Compile This Step refused outright, because it had to number steps in the
 * expanded test and a call above the line broke the correspondence. This flow
 * sends steps, not numbers, so it has nothing to refuse.
 *
 * Line 8 is the section call, line 9 the step below it, line 12 a body step.
 */
const SECTIONED_MD = `---
tags: [codebehind]
---

# Sectioned

## Steps
1. Sign in
2. Click the "Get started" button

### Sign in
1. Type the username
2. Press Enter
`;

describe('TestBench code-behind compile', function () {
  this.timeout(30_000);

  /** @type {FakeApiClient} */
  let fake;
  /** @type {import('../../../dist/extension/extension').TestBenchTestHooks} */
  let hooks;
  let mdPath;
  let stepsPath;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks not exposed');
  });

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fake = new FakeApiClient();
    hooks.setApiClientFactory(() => fake);

    mdPath = path.resolve(FIXTURES_DIR, 'compile-me.md');
    stepsPath = path.resolve(FIXTURES_DIR, 'compile-me.steps.ts');
    fs.writeFileSync(mdPath, TEST_MD, 'utf-8');
    fs.rmSync(stepsPath, { force: true });

    await openFixture(mdPath);
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('testbench-native.discardCodeBehind');
    fs.rmSync(mdPath, { force: true });
    fs.rmSync(stepsPath, { force: true });
  });

  /** Open a markdown fixture and wait until TestBench owns it. */
  async function openFixture(file) {
    const uri = vscode.Uri.file(file);
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor(
      'fixture active',
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
    );
    await waitFor('active file detected', () => hooks.tracker.snapshot().isTestFile);
  }

  it('Run & Compile sends compile:"run" with the test path and the editor steps', async () => {
    void vscode.commands.executeCommand('testbench-native.runAndCompile');
    await waitFor('run requested', () => fake.requests.length > 0);

    const request = fake.requests[0];
    // The one field the whole feature rides on. `StepRequest` is built from an
    // explicit allow-list server-side, so a wire that drops this compiles
    // cleanly and silently runs without compiling.
    assert.equal(request.compile, 'run');
    assert.equal(samePath(request.testFilePath, mdPath), true, request.testFilePath);
    assert.deepEqual(request.steps, [
      'Navigate to https://example.com',
      'Click the "Get started" button',
    ]);
    // The server turns capture on for a compile-mode run; the client does not
    // have to remember two flags.
    assert.equal(request.captureStepContext, undefined);

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('an ordinary run neither compiles nor asks the server to capture', async () => {
    // stories/codebehind-recording-on-disk.md: capturing is the compile's job.
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);
    assert.equal(fake.requests[0].captureStepContext, undefined);
    assert.equal(fake.requests[0].compile, undefined);
    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('a Run & Compile opens a diff of the proposed file without writing it', async () => {
    const proposed = 'export default defineSteps([{ source: "Navigate", async run() {} }]);\n';
    fake.streamScripts = [runAndCompileScript(() => stepsPath, proposed)];

    void vscode.commands.executeCommand('testbench-native.runAndCompile');
    await waitFor('proposal pending', () => hooks.pendingCodeBehind() !== null);

    const pending = hooks.pendingCodeBehind();
    assert.equal(samePath(pending.testFilePath, mdPath), true, pending.testFilePath);
    assert.deepEqual(Object.keys(pending.files), [stepsPath]);
    assert.equal(pending.files[stepsPath], proposed);
    // The whole point of the diff: nothing is on disk yet.
    assert.equal(fs.existsSync(stepsPath), false, 'compile must not write the file itself');
  });

  it('Apply writes the proposed file and clears the proposal', async () => {
    const proposed = 'export default defineSteps([{ source: "Navigate", async run() {} }]);\n';
    fake.streamScripts = [runAndCompileScript(() => stepsPath, proposed)];

    void vscode.commands.executeCommand('testbench-native.runAndCompile');
    await waitFor('proposal pending', () => hooks.pendingCodeBehind() !== null);

    await vscode.commands.executeCommand('testbench-native.applyCodeBehind');
    await waitFor('file written', () => fs.existsSync(stepsPath));

    assert.equal(fs.readFileSync(stepsPath, 'utf-8'), proposed);
    assert.equal(hooks.pendingCodeBehind(), null, 'Apply must consume the proposal');
  });

  it('Discard drops the proposal and leaves the file alone', async () => {
    fake.streamScripts = [runAndCompileScript(() => stepsPath, 'export default defineSteps([]);\n')];

    void vscode.commands.executeCommand('testbench-native.runAndCompile');
    await waitFor('proposal pending', () => hooks.pendingCodeBehind() !== null);

    await vscode.commands.executeCommand('testbench-native.discardCodeBehind');
    assert.equal(hooks.pendingCodeBehind(), null);
    assert.equal(fs.existsSync(stepsPath), false);
  });

  it('a run that fails at step 2 still proposes step 1', async () => {
    // Stop and failure compose the way "write what passed" already composes
    // (stories/compile-as-you-go.md §Run & Compile): the entries for what
    // finished are proposed, and the summary names what was not attempted.
    const proposed = 'export default defineSteps([{ source: "Navigate", async run() {} }]);\n';
    fake.streamScripts = [
      (f) => {
        f.push({ type: 'step:start', line: 8 });
        f.push({ type: 'step:pass', line: 8 });
        f.push({ type: 'compile:step', phase: 'generate', step: 1, line: 8, message: 'generated' });
        f.push({ type: 'step:start', line: 9 });
        f.push({ type: 'step:fail', line: 9, error: 'no such button' });
        f.push({
          type: 'compile:result',
          status: 'partial',
          files: { [stepsPath]: proposed },
          summary: summaryFor({
            compiled: 1,
            unproven: [1],
            stoppedAt: { step: 2, error: 'no such button' },
            notAttempted: [],
          }),
        });
        f.push({ type: 'done', status: 'failed' });
        f.end();
      },
    ];

    void vscode.commands.executeCommand('testbench-native.runAndCompile');
    await waitFor('proposal pending', () => hooks.pendingCodeBehind() !== null);
    assert.equal(hooks.pendingCodeBehind().files[stepsPath], proposed);
    assert.equal(fs.existsSync(stepsPath), false, 'compile must not write the file itself');
  });

  it('a compile that proposes nothing leaves no proposal to apply', async () => {
    fake.streamScripts = [
      (f) => {
        f.push({ type: 'step:start', line: 8 });
        f.push({ type: 'step:pass', line: 8, fromCodeBehind: true });
        f.push({
          type: 'compile:result',
          status: 'green',
          files: {},
          summary: summaryFor({ compiled: 0, kept: 2 }),
        });
        f.push({ type: 'done', status: 'passed' });
        f.end();
      },
    ];

    void vscode.commands.executeCommand('testbench-native.runAndCompile');
    await waitFor('run finished', () => !hooks.isRunning() && fake.requests.length > 0);
    await sleep(300);
    assert.equal(hooks.pendingCodeBehind(), null);
    assert.equal(fs.existsSync(stepsPath), false);
  });

  it('Compile This Step runs exactly that step, with code-behind execution off', async () => {
    // Line 9 in the fixture is the second step.
    void vscode.commands.executeCommand('testbench-native.compileStepCodeBehind', {
      lineNumber: 9,
    });
    await waitFor('run requested', () => fake.requests.length > 0);

    const request = fake.requests[0];
    // `'steps'`, not `'run'` — which is what disables code-behind execution
    // server-side so a broken entry re-records under AI instead of being
    // served by the code under repair.
    assert.equal(request.compile, 'steps');
    assert.deepEqual(request.sourceLines, [9]);
    assert.deepEqual(request.steps, ['Click the "Get started" button']);

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('Compile This Step compiles every step in a multi-line selection, in order', async () => {
    const editor = vscode.window.activeTextEditor;
    // Lines 8 and 9 of the document are steps 1 and 2 (0-based 7 and 8).
    editor.selection = new vscode.Selection(
      new vscode.Position(7, 0),
      new vscode.Position(8, 10),
    );
    void vscode.commands.executeCommand('testbench-native.compileStepCodeBehind', {
      lineNumber: 8,
    });
    await waitFor('run requested', () => fake.requests.length > 0);

    const request = fake.requests[0];
    assert.equal(request.compile, 'steps');
    assert.deepEqual(request.sourceLines, [8, 9]);

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('a line that is not a step is refused rather than compiling the rest of the file', async () => {
    // Line 5 is the `# Compile Me` heading. An unqualified line resolves to
    // "every step at or below it", which on a stray right-click would run and
    // compile the tail of the test.
    void vscode.commands.executeCommand('testbench-native.compileStepCodeBehind', {
      lineNumber: 5,
    });
    await sleep(300);
    assert.equal(fake.requests.length, 0);
  });

  describe('a test with a section call above the step', () => {
    let sectionedMd;

    beforeEach(async () => {
      sectionedMd = path.resolve(FIXTURES_DIR, 'compile-sectioned.md');
      fs.writeFileSync(sectionedMd, SECTIONED_MD, 'utf-8');
      await openFixture(sectionedMd);
    });

    afterEach(() => {
      fs.rmSync(sectionedMd, { force: true });
      fs.rmSync(path.resolve(FIXTURES_DIR, 'compile-sectioned.steps.ts'), { force: true });
    });

    it('compiles a step BELOW the call — the old "cannot number a step" refusal is gone', async () => {
      // Line 9 is `2. Click the "Get started" button`, sitting under the
      // `Sign in` section call on line 8. This used to refuse outright.
      void vscode.commands.executeCommand('testbench-native.compileStepCodeBehind', {
        lineNumber: 9,
      });
      await waitFor('run requested', () => fake.requests.length > 0);

      const request = fake.requests[0];
      assert.equal(request.compile, 'steps');
      assert.deepEqual(request.steps, ['Click the "Get started" button']);

      fake.end();
      await waitFor('idle', () => !hooks.isRunning());
    });

    it('compiles the section call itself, sending the body for the server to expand', async () => {
      void vscode.commands.executeCommand('testbench-native.compileStepCodeBehind', {
        lineNumber: 8,
      });
      await waitFor('run requested', () => fake.requests.length > 0);

      const request = fake.requests[0];
      assert.equal(request.compile, 'steps');
      assert.deepEqual(request.steps, ['Sign in']);
      // The call goes out as the call, with the sections map a run sends —
      // the server expands it and binds each body step to its own entry.
      assert.ok(request.sections, 'the sections map must ride along');
      assert.deepEqual(
        Object.values(request.sections)[0].steps,
        ['Type the username', 'Press Enter'],
      );

      fake.end();
      await waitFor('idle', () => !hooks.isRunning());
    });
  });

  it('the compile lines reach the run log', async () => {
    fake.streamScripts = [runAndCompileScript(() => stepsPath, 'export default defineSteps([]);\n')];
    void vscode.commands.executeCommand('testbench-native.runAndCompile');
    await waitFor('proposal pending', () => hooks.pendingCodeBehind() !== null);

    const log = readLiveLog();
    if (log === null) return; // TESTBENCH_LIVE_LOG not set — nothing to read.
    assert.match(log, /step 1 generated/);
    assert.match(log, /Review\s+revised compile-me\.steps\.ts/);
    assert.match(log, /Compiled compile-me\.md: 2 step\(s\) as code \(unproven/);
  });

  it('paints </> for a step that passed as code and ⚠ for a stale one', async () => {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'step:pass', line: 8, fromCodeBehind: true });
    fake.push({
      type: 'step:pass',
      line: 9,
      codeBehindStale: { file: '/x/compile-me.steps.ts', error: 'locator timeout' },
    });
    await waitFor('both marks painted', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[8] === 'pass-code-behind' && statuses[9] === 'pass-stale';
    });

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('a stale entry outranks the cache flag — the mark asks for a recompile', async () => {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({
      type: 'step:pass',
      line: 8,
      fromCache: true,
      fromCodeBehind: true,
      codeBehindStale: { file: '/x/compile-me.steps.ts', error: 'boom' },
    });
    await waitFor('stale wins', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[8] === 'pass-stale';
    });

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('an ordinary pass is still a plain ✓', async () => {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({ type: 'step:pass', line: 8 });
    await waitFor('plain pass', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[8] === 'pass';
    });

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('a compile:step never repaints a step the run has already marked', async () => {
    // By the time an entry is generated its step has painted ✓. Painting ▶ on
    // it from the compile frame would undo that — which is why the run
    // controller logs these frames and does not fold them into the gutter.
    fake.streamScripts = [
      (f) => {
        f.push({ type: 'step:start', line: 8 });
        f.push({ type: 'step:pass', line: 8 });
        f.push({ type: 'compile:step', phase: 'generate', step: 1, line: 8, message: 'generated' });
      },
    ];
    void vscode.commands.executeCommand('testbench-native.runAndCompile');
    await waitFor('pass painted', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[8] === 'pass';
    });
    await sleep(200);
    const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    assert.equal(statuses[8], 'pass', 'the generate frame must not repaint the step');

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('the panel\'s Compile button and the old command both reach Run & Compile', async () => {
    // Never awaited: the command now awaits the whole run, and the run only
    // ends when this test calls `fake.end()`.
    void hooks.dispatchWebviewMessage({ type: 'compile' });
    await waitFor('run requested', () => fake.requests.length > 0);
    assert.equal(fake.requests[0].compile, 'run');
    fake.end();
    await waitFor('idle', () => !hooks.isRunning());

    void vscode.commands.executeCommand('testbench-native.compileCodeBehind');
    await waitFor('second run requested', () => fake.requests.length > 1);
    assert.equal(fake.requests[1].compile, 'run');
    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  // ── Reaching the server (issue: "compile failed: fetch failed") ──────────
  //
  // A compile gets to the server the way a Run does — because it IS a run now:
  // probe SERVER_URL first, auto-start it when that is configured, refuse a
  // port that belongs to something else, and when the request still cannot get
  // through, say which URL was tried and why it did not answer, in the
  // catalogue's words with the fix attached, rather than echoing the client's
  // bare "fetch failed".
  describe('reaching the server', () => {
    const HEALTHY = () => ({
      kind: 'healthy',
      health: { service: 'ai-ui-automation', version: '9.9.9', inspector: null },
    });
    /** What the probe answers; a single mutable value, as in the lifecycle suite. */
    let probeResult;
    /** Every spawn attempted. */
    let spawns;

    async function setAutoStart({ command, cwd }) {
      const cfg = vscode.workspace.getConfiguration('testbench-native');
      await cfg.update('serverAutoStart.command', command, vscode.ConfigurationTarget.Global);
      await cfg.update('serverAutoStart.cwd', cwd, vscode.ConfigurationTarget.Global);
    }

    beforeEach(() => {
      spawns = [];
      probeResult = { kind: 'down', detail: 'fetch failed: connect ECONNREFUSED 127.0.0.1:39917' };
      hooks.setServerHooks({
        healthProbe: async () => probeResult,
        spawnServer: (args) => {
          spawns.push(args);
          probeResult = HEALTHY();
        },
      });
    });

    // Global settings outlive this suite; a command left set would make every
    // later run in the host try to spawn a server.
    afterEach(async () => {
      await setAutoStart({ command: '', cwd: '' });
    });

    it('a server that does not answer is reported as TB010 naming the URL and the refusal, not "fetch failed"', async () => {
      fake.streamThrows = new ApiClientError(
        'connect-failed',
        'fetch failed: connect ECONNREFUSED 127.0.0.1:39917',
      );
      void vscode.commands.executeCommand('testbench-native.runAndCompile');
      await waitFor('compile reported', () => hooks.lastCompileError() !== null);

      const error = hooks.lastCompileError();
      assert.match(error, /^TB010: /);
      assert.match(error, /http:\/\/127\.0\.0\.1:39917/, 'names the URL it tried');
      assert.match(error, /connect ECONNREFUSED 127\.0\.0\.1:39917/, 'carries the transport cause');
      assert.match(error, /serverAutoStart/, 'points at the setting that would have started it');
    });

    it('a server that rejects the key is TB011, with the .env the key chain started from', async () => {
      probeResult = HEALTHY();
      fake.streamThrows = new ApiClientError('unauthorized', 'Unauthorized', { status: 401 });
      void vscode.commands.executeCommand('testbench-native.runAndCompile');
      await waitFor('compile reported', () => hooks.lastCompileError() !== null);

      const error = hooks.lastCompileError();
      assert.match(error, /^TB011: /);
      assert.match(error, /AIUI_SERVER_API_KEY/);
      assert.match(error, /\.env/);
    });

    it('a down server is auto-started before the request goes out, as it is for a Run', async () => {
      await setAutoStart({ command: 'node dist/index.js serve', cwd: FIXTURES_DIR });
      void vscode.commands.executeCommand('testbench-native.runAndCompile');
      await waitFor('run requested', () => fake.requests.length > 0);

      assert.equal(spawns.length, 1, 'one spawn, before the request');
      assert.equal(hooks.lastCompileError(), null);

      fake.end();
      await waitFor('idle', () => !hooks.isRunning());
    });

    it('a port held by something else refuses the compile (TB027) before any request is sent', async () => {
      probeResult = { kind: 'foreign', service: 'grafana' };
      void vscode.commands.executeCommand('testbench-native.runAndCompile');
      await waitFor('compile reported', () => hooks.lastCompileError() !== null);

      assert.match(hooks.lastCompileError(), /^TB027: /);
      assert.match(hooks.lastCompileError(), /grafana/);
      assert.equal(fake.requests.length, 0, 'nothing was sent to a server that is not ours');
    });

    it('a compile while a run of the test is in progress is refused without touching the server', async () => {
      // The panel greys the button out during a run; the palette and gutter
      // commands do not, and a compile-mode run would queue behind the one in
      // flight in the same session.
      probeResult = HEALTHY();
      void vscode.commands.executeCommand('testbench-native.runAll');
      await waitFor('stream active', () => fake.hasActiveStream);

      void vscode.commands.executeCommand('testbench-native.runAndCompile');
      await waitFor('compile refused', () => hooks.lastCompileError() !== null);
      assert.match(hooks.lastCompileError(), /run of this test is in progress/);
      assert.equal(fake.requests.length, 1, 'only the run in flight reached the server');

      fake.end();
      await waitFor('idle', () => !hooks.isRunning());
    });
  });
});

/**
 * A Run & Compile of the two-step fixture: both steps pass under AI, both
 * generate, Review revises the file, and the result proposes `content`.
 *
 * `compile:result` arrives BEFORE `done`, as the server sends it — the queue
 * drains and Review runs at run end, and only then does the run finish.
 */
function runAndCompileScript(file, content) {
  return (f) => {
    f.push({ type: 'step:start', line: 8 });
    f.push({ type: 'step:pass', line: 8 });
    f.push({ type: 'compile:step', phase: 'generate', step: 1, line: 8, message: 'generated' });
    f.push({ type: 'step:start', line: 9 });
    f.push({ type: 'step:pass', line: 9 });
    f.push({ type: 'compile:step', phase: 'generate', step: 2, line: 9, message: 'generated' });
    f.push({
      type: 'compile:step',
      phase: 'review',
      step: 0,
      message: 'revised compile-me.steps.ts',
    });
    f.push({
      type: 'compile:result',
      status: 'partial',
      files: { [file()]: content },
      summary: summaryFor({ compiled: 2, unproven: [1, 2] }),
    });
    f.push({ type: 'done', status: 'passed' });
    f.end();
  };
}

/** A compile summary for the two-step fixture, with the fields a live compile
 *  always sets: no rounds, and every new entry unproven. */
function summaryFor(overrides = {}) {
  return {
    test: path.resolve(FIXTURES_DIR, 'compile-me.md'),
    totalSteps: 2,
    compiled: 0,
    kept: 0,
    keptAi: 0,
    rounds: 0,
    tokensUsed: 12_345,
    written: [],
    unproven: [],
    writtenOffAi: [],
    notAttempted: [],
    recordingDir: path.resolve(FIXTURES_DIR, '.aiui-codebehind-cache', 'compile-me.recording'),
    ...overrides,
  };
}

/**
 * Path comparison that tolerates the drive-letter case VS Code chooses.
 *
 * `uri.fsPath` lower-cases the drive letter on Windows, so the path the
 * extension sends is a different STRING from the one this test wrote the file
 * at, for the same file. Anything keyed on the path has to fold that — the
 * server's compile lock does too.
 */
function samePath(a, b) {
  const fold = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return fold(a) === fold(b);
}

/** The extension's output channel, when the harness is teeing it to a file.
 *  VS Code exposes no way to read an OutputChannel back. */
function readLiveLog() {
  const file = process.env.TESTBENCH_LIVE_LOG;
  if (!file || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf-8');
}

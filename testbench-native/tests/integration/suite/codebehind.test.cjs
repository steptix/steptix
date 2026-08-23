/**
 * Compiling code-behind, inside the extension host
 * (stories/codebehind-compile.md §What the author sees).
 *
 * Two halves, and they fail in different ways:
 *
 *   - the compile command — does pressing Compile reach the client with the
 *     right request, log the phases, and end with a diff the author can apply?
 *     The diff editors themselves are not readable from here, so the assertion
 *     is on what they were opened WITH (`pendingCodeBehind`) plus, for Apply,
 *     the bytes on disk afterwards.
 *   - the gutter — do `fromCodeBehind` / `codeBehindStale` on a step:pass
 *     reach the tracker as ⚙ / ⚠ rather than a plain ✓? That mapping lives in
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

const EXT_ID = 'pkent.testbench-native';
const FIXTURES_DIR =
  process.env.TESTBENCH_FIXTURES_DIR || path.resolve(__dirname, '..', 'fixtures');
const fixtureUri = (name) => vscode.Uri.file(path.resolve(FIXTURES_DIR, name));
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

    const uri = vscode.Uri.file(mdPath);
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor(
      'fixture active',
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
    );
    await waitFor('active file detected', () => hooks.tracker.snapshot().isTestFile);
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('testbench-native.discardCodeBehind');
    fs.rmSync(mdPath, { force: true });
    fs.rmSync(stepsPath, { force: true });
  });

  it('Compile Code-behind sends the test path and the editor steps to the server', async () => {
    void vscode.commands.executeCommand('testbench-native.compileCodeBehind');
    await waitFor('compile requested', () => fake.compileRequests.length > 0);

    const request = fake.compileRequests[0];
    assert.equal(samePath(request.testFilePath, mdPath), true, request.testFilePath);
    assert.deepEqual(request.steps, [
      'Navigate to https://example.com',
      'Click the "Get started" button',
    ]);
    // No selection means "steps with no entry, or flagged stale" — the server
    // decides. Sending an empty select would mean something else.
    assert.equal(request.select, undefined);
    // Always this document's session: the server compiles from its last run
    // when it can, and records in it when it cannot
    // (stories/codebehind-compile-as-a-run.md §Record is a run).
    assert.equal(typeof request.sessionId, 'string');
    assert.ok(request.sessionId.length > 0, 'sessionId must name the document\'s session');
  });

  it('an ordinary run does not ask the server to capture; the compile names the run\'s session', async () => {
    // stories/codebehind-recording-on-disk.md: capturing is the compile's
    // job. A Run sends no `captureStepContext`; the compile's own Record, in
    // this document's session, is the recording.
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);
    assert.equal(fake.requests[0].captureStepContext, undefined);
    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
    void vscode.commands.executeCommand('testbench-native.compileCodeBehind');
    await waitFor('compile requested', () => fake.compileRequests.length > 0);
    assert.equal(fake.compileRequests[0].sessionId, fake.streamSessionIds[0]);
  });

  it('a green compile opens a diff of the proposed file without writing it', async () => {
    const proposed = 'export default defineSteps([{ source: "Navigate", async run() {} }]);\n';
    fake.compileEvents = greenCompile(() => stepsPath, proposed);

    void vscode.commands.executeCommand('testbench-native.compileCodeBehind');
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
    fake.compileEvents = greenCompile(() => stepsPath, proposed);

    void vscode.commands.executeCommand('testbench-native.compileCodeBehind');
    await waitFor('proposal pending', () => hooks.pendingCodeBehind() !== null);

    await vscode.commands.executeCommand('testbench-native.applyCodeBehind');
    await waitFor('file written', () => fs.existsSync(stepsPath));

    assert.equal(fs.readFileSync(stepsPath, 'utf-8'), proposed);
    assert.equal(hooks.pendingCodeBehind(), null, 'Apply must consume the proposal');
  });

  it('Discard drops the proposal and leaves the file alone', async () => {
    fake.compileEvents = greenCompile(() => stepsPath, 'export default defineSteps([]);\n');

    void vscode.commands.executeCommand('testbench-native.compileCodeBehind');
    await waitFor('proposal pending', () => hooks.pendingCodeBehind() !== null);

    await vscode.commands.executeCommand('testbench-native.discardCodeBehind');
    assert.equal(hooks.pendingCodeBehind(), null);
    assert.equal(fs.existsSync(stepsPath), false);
  });

  it('a partial compile opens the diff like a green one', async () => {
    // What passed is proposed (stories/codebehind-compile-as-a-run.md §Write
    // what passed): a prefix compile's files reach the diff, and the summary
    // carries what the notification says about the rest.
    const proposed = 'export default defineSteps([{ source: "Navigate", async run() {} }]);\n';
    fake.compileEvents = [
      { type: 'compile:phase', phase: 'select', message: '2 step(s) to generate, 0 kept, 0 already AI' },
      { type: 'compile:phase', phase: 'record', message: 'stopped at step 2 — no such button; compiling 1 step(s) before it' },
      { type: 'compile:step', phase: 'generate', step: 1, line: 8, message: 'generated' },
      { type: 'compile:phase', phase: 'replay', round: 1, message: '1/1 passed as code' },
      { type: 'compile:done', status: 'partial', message: 'Compiled Compile Me: 1 step(s) as code — stopped at step 2.' },
      {
        type: 'compile:result',
        status: 'partial',
        get files() {
          return { [stepsPath]: proposed };
        },
        summary: {
          test: 'compile-me.md', totalSteps: 2, compiled: 1, kept: 0, keptAi: 0, rounds: 1,
          tokensUsed: 4_000, written: [], unproven: [], writtenOffAi: [],
          stoppedAt: { step: 2, error: 'no such button' }, notAttempted: [2],
          recordingDir: '/x/.aiui-codebehind-cache/compile-me.recording',
        },
      },
    ];

    void vscode.commands.executeCommand('testbench-native.compileCodeBehind');
    await waitFor('proposal pending', () => hooks.pendingCodeBehind() !== null);
    const pending = hooks.pendingCodeBehind();
    assert.equal(pending.files[stepsPath], proposed);
    assert.equal(fs.existsSync(stepsPath), false, 'compile must not write the file itself');
  });

  it('a red compile leaves no proposal to apply', async () => {
    fake.compileEvents = [
      { type: 'compile:phase', phase: 'select', message: '2 step(s) to generate' },
      { type: 'compile:phase', phase: 'replay', round: 1, message: '✗ step 2 — locator timeout' },
      { type: 'compile:done', status: 'failed', message: 'Replay never went green' },
      {
        type: 'compile:result',
        status: 'failed',
        files: {},
        summary: {
          test: '/x/compile-me.md',
          totalSteps: 2,
          compiled: 0,
          kept: 0,
          keptAi: 0,
          rounds: 3,
          tokensUsed: 900,
          written: [],
          unproven: [],
          writtenOffAi: [],
          notAttempted: [],
          recordingDir: '/x/.aiui-codebehind-cache/compile-me.recording',
          error: 'locator timeout',
          candidatePath: '/x/.aiui-codebehind-cache/compile-me.steps.ts.candidate',
        },
      },
    ];

    void vscode.commands.executeCommand('testbench-native.compileCodeBehind');
    await waitFor('compile ran', () => fake.compileRequests.length > 0);
    await sleep(300);
    assert.equal(hooks.pendingCodeBehind(), null);
    assert.equal(fs.existsSync(stepsPath), false);
  });

  it('Compile This Step selects exactly that step', async () => {
    // Line 9 in the fixture is the second step.
    void vscode.commands.executeCommand('testbench-native.compileStepCodeBehind', {
      lineNumber: 9,
    });
    await waitFor('compile requested', () => fake.compileRequests.length > 0);
    assert.deepEqual(fake.compileRequests[0].select, { steps: [2] });
  });

  it('the compile phases reach the run log', async () => {
    fake.compileEvents = greenCompile(() => stepsPath, 'export default defineSteps([]);\n');
    void vscode.commands.executeCommand('testbench-native.compileCodeBehind');
    await waitFor('proposal pending', () => hooks.pendingCodeBehind() !== null);

    const log = readLiveLog();
    if (log === null) return; // TESTBENCH_LIVE_LOG not set — nothing to read.
    assert.match(log, /Select\s+2 step\(s\) to generate/);
    assert.match(log, /step 1 generated/);
    assert.match(log, /Replay 1\s+2\/2 passed as code/);
  });

  it('paints ⚙ for a step that passed as code and ⚠ for a stale one', async () => {
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

  it('the webview compile message reaches the same command', async () => {
    await hooks.dispatchWebviewMessage({ type: 'compile' });
    await waitFor('compile requested', () => fake.compileRequests.length > 0);
    assert.equal(typeof fake.compileRequests[0].sessionId, 'string');
  });

  it('paints the compile\'s runs in the gutter — ▶ then ⚙ / ✗ — and resets between rounds', async () => {
    // stories/codebehind-compile-as-a-run.md §Every run is on the stream: the
    // Record and each Replay round paint as a run would, and a new round
    // starts from a clean gutter so round 1's ✗ does not outlive round 2.
    const proposed = 'export default defineSteps([]);\n';
    const run = (phase, round, event) => ({ type: 'compile:run', phase, ...(round && { round }), event });
    fake.compileEvents = [
      { type: 'compile:phase', phase: 'record', message: 'running 2 step(s)' },
      run('record', undefined, { type: 'step:start', line: 8 }),
      run('record', undefined, { type: 'step:pass', line: 8 }),
      run('record', undefined, { type: 'step:start', line: 9 }),
      run('record', undefined, { type: 'step:pass', line: 9, fromCache: true }),
      run('record', undefined, { type: 'done', status: 'passed' }),
      { type: 'compile:step', phase: 'generate', step: 1, line: 8, message: 'generated' },
      { type: 'compile:phase', phase: 'replay', round: 1, message: 'running 2 step(s) as code' },
      run('replay', 1, { type: 'step:start', line: 8 }),
      run('replay', 1, { type: 'step:pass', line: 8, fromCodeBehind: true }),
      run('replay', 1, { type: 'step:start', line: 9 }),
      run('replay', 1, { type: 'step:fail', line: 9, error: 'locator timeout' }),
      run('replay', 1, { type: 'done', status: 'failed' }),
      { type: 'compile:step', phase: 'repair', step: 2, line: 9, message: 'regenerating from the failure' },
      { type: 'compile:phase', phase: 'replay', round: 2, message: 'running 2 step(s) as code' },
      run('replay', 2, { type: 'step:start', line: 8 }),
      run('replay', 2, { type: 'step:pass', line: 8, fromCodeBehind: true }),
      run('replay', 2, { type: 'step:start', line: 9 }),
      // Round 2 stops here on purpose: line 9 must read ▶ (this round), not
      // ✗ (last round), which is what the reset between rounds buys.
    ];
    // The stream ends without a result, so the compile reports "no result" —
    // fine for a test about the gutter.
    void vscode.commands.executeCommand('testbench-native.compileCodeBehind');
    await waitFor('compile ran', () => fake.compileRequests.length > 0);
    await waitFor('round 2 painted', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[8] === 'pass-code-behind' && statuses[9] === 'running';
    });
    void proposed;
  });

  it('a compile\'s replay failure does not park a breakpoint stop', async () => {
    // A Replay's session is the compile's own and is closed after the round —
    // there is nothing to Continue into, so the ✗ stays a mark and no more.
    const run = (phase, round, event) => ({ type: 'compile:run', phase, ...(round && { round }), event });
    fake.compileEvents = [
      { type: 'compile:phase', phase: 'replay', round: 1, message: 'running 2 step(s) as code' },
      run('replay', 1, { type: 'step:start', line: 8 }),
      run('replay', 1, { type: 'step:fail', line: 8, error: 'locator timeout' }),
      run('replay', 1, { type: 'done', status: 'failed' }),
    ];
    void vscode.commands.executeCommand('testbench-native.compileCodeBehind');
    await waitFor('fail painted', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[8] === 'fail';
    });
    assert.equal(hooks.tracker.snapshot().breakpointStop, null);
  });
});

/** A green compile of the two-step fixture, proposing `content` for `file`. */
function greenCompile(file, content) {
  return [
    { type: 'compile:phase', phase: 'select', message: '2 step(s) to generate, 0 kept, 0 already AI' },
    { type: 'compile:phase', phase: 'record', message: 'running 2 step(s) under AI' },
    { type: 'compile:phase', phase: 'generate', message: '2 step(s)' },
    { type: 'compile:step', phase: 'generate', step: 1, message: 'generated' },
    { type: 'compile:step', phase: 'generate', step: 2, message: 'generated' },
    { type: 'compile:phase', phase: 'review', message: 'revised compile-me.steps.ts' },
    { type: 'compile:phase', phase: 'replay', round: 1, message: '2/2 passed as code' },
    { type: 'compile:done', status: 'green', message: 'Compiled Compile Me: 2 step(s) as code' },
    {
      type: 'compile:result',
      status: 'green',
      get files() {
        return { [file()]: content };
      },
      summary: {
        test: 'compile-me.md',
        totalSteps: 2,
        compiled: 2,
        kept: 0,
        keptAi: 0,
        rounds: 1,
        tokensUsed: 12_345,
        written: [],
        unproven: [],
        writtenOffAi: [],
        notAttempted: [],
        recordingDir: '/x/.aiui-codebehind-cache/compile-me.recording',
      },
    },
  ];
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

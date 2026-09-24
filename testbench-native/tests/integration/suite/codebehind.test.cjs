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

/**
 * A test an interactive step splits into two step-blocks — so one logical run
 * reaches the server as two POSTs. Lines 8, 9 and 10.
 *
 * `[interactive]` rather than `[input:]` because the two prompt through
 * different surfaces: `[input:]` opens VS Code's native InputBox, which the
 * harness cannot answer, while `[interactive]` uses the webview composer that
 * `dispatchWebviewMessage` drives. Both split the run the same way, which is
 * the only property under test here.
 */
const SPLIT_MD = `---
tags: [codebehind]
---

# Split Me

## Steps
1. Navigate to https://example.com
2. [interactive] Poke around before the next step
3. Click the "Get started" button
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
    return vscode.window.activeTextEditor;
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

  describe('a run that reaches the server as several requests', () => {
    // Every block after the first must say so, or the server gives each block
    // its own compiler — its own candidate read from the unapplied file, its
    // own numbering from 1, and its own wholesale recording write that deletes
    // the block before it.
    it('marks the second block of a split run as a continuation', async () => {
      const splitMd = path.resolve(FIXTURES_DIR, 'compile-split.md');
      fs.writeFileSync(splitMd, SPLIT_MD, 'utf-8');
      try {
        await openFixture(splitMd);
        void vscode.commands.executeCommand('testbench-native.runAndCompile');
        await waitFor('first block requested', () => fake.requests.length > 0);
        assert.equal(fake.requests[0].compile, 'run');
        assert.equal(fake.requests[0].compileContinues, undefined, 'the first block starts the compile');
        assert.deepEqual(fake.requests[0].steps, ['Navigate to https://example.com']);
        fake.end();

        // The interactive step blocks on the composer. There is no hook for
        // "the prompt is open", and answering early is a silent no-op, so keep
        // sending `/continue` until the run moves on.
        await waitFor(
          'second block requested',
          async () => {
            if (fake.requests.length > 1) return true;
            await hooks.dispatchWebviewMessage({ type: 'promptResponse', text: '/continue' });
            return fake.requests.length > 1;
          },
          20_000,
        );
        assert.equal(fake.requests[1].compile, 'run');
        assert.equal(fake.requests[1].compileContinues, true, 'the second block continues it');
        assert.deepEqual(fake.requests[1].steps, ['Click the "Get started" button']);
        fake.end();
        await waitFor('idle', () => !hooks.isRunning(), 10_000);
      } finally {
        fs.rmSync(splitMd, { force: true });
      }
    });

    it('Continue after a breakpoint keeps compiling, as a continuation', async () => {
      // The author who pressed Run & Compile did not stop wanting a compile
      // when they hit a breakpoint. Continue used to send a plain Run, so the
      // rest of the test was never compiled.
      const uri = vscode.Uri.file(mdPath);
      vscode.debug.addBreakpoints([
        new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(8, 0))),
      ]);
      try {
        void vscode.commands.executeCommand('testbench-native.runAndCompile');
        await waitFor('first block requested', () => fake.requests.length > 0);
        assert.equal(fake.requests[0].compile, 'run');
        assert.equal(fake.requests[0].compileContinues, undefined);
        // Trimmed at the breakpoint: only the step above it.
        assert.deepEqual(fake.requests[0].sourceLines, [8]);
        fake.end();
        await waitFor('paused', () => hooks.tracker.snapshot().breakpointStop !== null, 10_000);
        // Paused mid-compile: no diff yet, the proposal is about to grow.
        assert.equal(hooks.pendingCodeBehind(), null);

        void vscode.commands.executeCommand('testbench-native.continueRun');
        await waitFor('continuation requested', () => fake.requests.length > 1, 10_000);
        assert.equal(fake.requests[1].compile, 'run', 'Continue must carry the compile');
        assert.equal(fake.requests[1].compileContinues, true);
        fake.end();
        await waitFor('idle', () => !hooks.isRunning(), 10_000);
      } finally {
        vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
      }
    });

    it('a plain Run after a Run & Compile carries no compile flag', async () => {
      void vscode.commands.executeCommand('testbench-native.runAndCompile');
      await waitFor('compile requested', () => fake.requests.length > 0);
      fake.end();
      await waitFor('idle', () => !hooks.isRunning());

      void vscode.commands.executeCommand('testbench-native.runAll');
      await waitFor('run requested', () => fake.requests.length > 1);
      assert.equal(fake.requests[1].compile, undefined);
      fake.end();
      await waitFor('idle', () => !hooks.isRunning());
    });
  });

  /**
   * A data-driven Run & Compile (stories/data-driven-rows.md, decision 11).
   *
   * Every row runs; only the first row's batches carry `compile`. An entry is
   * keyed by (file, section, authored step text, occurrence) and its code reads
   * the row through `step.getVar`, so one entry serves every row — and a
   * second row asking for one is not a continuation of the first: the loop
   * closes the session between rows, which makes the server discard the
   * retained compiler. Before this, three rows meant three separate full
   * compiles of the same two steps, three proposals, and a recording on disk of
   * the LAST row while the log said "compile records row 1".
   *
   * Asserted on the requests the client sent, because that is the only place
   * the difference exists: the log reads the same either way.
   */
  describe('a data-driven Run & Compile', () => {
    const ROWS_MD = `---
tags: [codebehind]
---

# Compile Rows

## Steps
| email |
|-------|
| a@b.c |
| d@e.f |
| g@h.i |

1. Enter {{email}}
2. Submit the form
`;

    /**
     * The same table, with a step that splits each row's run into two blocks.
     *
     * The composition the row gate must not break: within row 1 the second
     * block still continues the compiler the first block opened, exactly as an
     * unlooped split run does. Testing the gate alone would pass with
     * `compileContinues` dropped from row 1's later blocks too — the run's
     * second half would then silently compile into its own candidate.
     *
     * `[interactive]` rather than `[input:]` for the reason `SPLIT_MD` gives:
     * the harness can answer the webview composer, not the native InputBox.
     * Two rows rather than three — four blocks is enough to show the shape and
     * halves the prompts the test has to answer.
     */
    const ROWS_SPLIT_MD = `---
tags: [codebehind]
---

# Compile Rows Split

## Steps
| email |
|-------|
| a@b.c |
| d@e.f |

1. Enter {{email}}
2. [interactive] Look around before submitting
3. Submit the form
`;

    /**
     * A data-driven file whose steps live in a `### Section` body, so a
     * Compile This Step on one of them carries a `compileScope` — the field
     * whose row gate has no other way to be reached.
     *
     * Line 18 is the body's first step, line 19 its second.
     */
    const ROWS_SECTION_MD = `---
tags: [codebehind]
---

# Compile Rows Step

## Steps
| email |
|-------|
| a@b.c |
| d@e.f |
| g@h.i |

1. Sign in
2. Submit the form

### Sign in
1. Enter {{email}}
2. Press Enter
`;

    let rowsPath;

    afterEach(() => {
      if (rowsPath) fs.rmSync(rowsPath, { force: true });
      rowsPath = undefined;
    });

    async function openRows(name, md) {
      rowsPath = path.resolve(FIXTURES_DIR, name);
      fs.writeFileSync(rowsPath, md, 'utf-8');
      await openFixture(rowsPath);
    }

    it('puts compile on the first row only; later rows run plain', async () => {
      await openRows('compile-rows.tmp.md', ROWS_MD);
      fake.streamScripts = Array.from({ length: 3 }, () => (f) => f.end());

      void vscode.commands.executeCommand('testbench-native.runAndCompile');
      await waitFor('three row batches', () => fake.requests.length >= 3, 20_000);
      await waitFor('idle', () => !hooks.isRunning(), 10_000);

      assert.equal(fake.requests.length, 3, 'one batch per row');
      // Every row still runs, still knows which row it is, and still carries
      // its values — the loop is untouched.
      assert.deepEqual(
        fake.requests.map((r) => [r.dataRow, r.dataRowCount]),
        [[1, 3], [2, 3], [3, 3]],
      );
      assert.deepEqual(fake.requests[2].dataRowValues, { email: 'g@h.i' });

      assert.equal(fake.requests[0].compile, 'run', 'row 1 opens the compile');
      assert.equal(fake.requests[0].compileContinues, undefined, 'and starts it');
      assert.equal(
        fake.requests[0].withinCompileRun,
        undefined,
        'the row that DOES compile never says it does not',
      );
      for (const index of [1, 2]) {
        assert.equal(
          fake.requests[index].compile,
          undefined,
          `row ${index + 1} must not ask for a compile of its own`,
        );
        assert.equal(
          fake.requests[index].compileContinues,
          undefined,
          `row ${index + 1} has no compiler to continue — the session was closed`,
        );
        // …and still says which run it belongs to, and of what KIND. The
        // server decides two things per batch from the mode: the AI switch's
        // carve-out (without it, a row with no compile field is refused AI on
        // an `ai.allowInRuns: false` project — row 1 with a diff, rows 2..N
        // red, for one gesture) and whether code-behind executes. `'run'` here,
        // so these rows still run their entries as code, exactly as row 1 does.
        assert.equal(
          fake.requests[index].withinCompileRun,
          'run',
          `row ${index + 1} must still be part of the Run & Compile`,
        );
      }
    });

    it('still continues the compile across a split INSIDE the first row', async () => {
      await openRows('compile-rows-split.tmp.md', ROWS_SPLIT_MD);
      fake.streamScripts = Array.from({ length: 4 }, () => (f) => f.end());

      void vscode.commands.executeCommand('testbench-native.runAndCompile');
      // The interactive step blocks on the composer, and there is no hook for
      // "the prompt is open" — so keep answering until the run moves on, as
      // the split-run test does.
      await waitFor(
        'four blocks (two rows, split in two)',
        async () => {
          if (fake.requests.length >= 4) return true;
          await hooks.dispatchWebviewMessage({ type: 'promptResponse', text: '/continue' });
          return fake.requests.length >= 4;
        },
        30_000,
      );
      await waitFor('idle', () => !hooks.isRunning(), 15_000);

      assert.deepEqual(
        fake.requests.map((r) => [r.dataRow, r.compile, r.compileContinues, r.withinCompileRun]),
        [
          [1, 'run', undefined, undefined],
          [1, 'run', true, undefined],
          [2, undefined, undefined, 'run'],
          [2, undefined, undefined, 'run'],
        ],
      );
    });

    /**
     * Compile This Step in a data-driven file — the only shape that reaches
     * the `rowCompile && options.compileScope` gate, since `compileScope` is
     * set only for a `### Section` body step and a whole-test Run & Compile
     * never carries one.
     *
     * The row loop is not the whole-file one here: a step selection does not
     * restart the browser between rows (`freshBrowserPerRow` is false), so the
     * session is KEPT — and the old N compiles came from the server clearing
     * `session.liveCompile` after every `'steps'` compile rather than from the
     * client closing the session.
     */
    it('puts compile:"steps" and its scope on the first row only', async () => {
      await openRows('compile-rows-step.tmp.md', ROWS_SECTION_MD);
      fake.streamScripts = Array.from({ length: 3 }, () => (f) => f.end());

      // Line 18 is the first body step of `### Sign in`.
      void vscode.commands.executeCommand('testbench-native.compileStepCodeBehind', {
        lineNumber: 18,
      });
      await waitFor('three row batches', () => fake.requests.length >= 3, 20_000);
      await waitFor('idle', () => !hooks.isRunning(), 10_000);

      assert.equal(fake.requests.length, 3, 'the selected step still runs once per row');
      assert.deepEqual(
        fake.requests.map((r) => [
          r.dataRow,
          r.compile,
          r.compileScope?.section,
          r.withinCompileRun,
        ]),
        [
          [1, 'steps', 'Sign in', undefined],
          [2, undefined, undefined, 'steps'],
          [3, undefined, undefined, 'steps'],
        ],
      );
      // `'steps'`, not `'run'`: the mode is what tells the server to keep
      // code-behind execution OFF for these rows too. With a bare `true` they
      // built the execution registry and ran the entry row 1 is repairing — it
      // threw, healed under AI, and painted ⚠ on that very step.
      // The scope travels with the compile and never without it: a batch that
      // compiles nothing has nothing to scope, and the server refuses a
      // `compileScope` on anything but a `'steps'` compile.
      assert.deepEqual(
        fake.requests.map((r) => r.steps),
        [['Enter {{email}}'], ['Enter {{email}}'], ['Enter {{email}}']],
      );
    });
  });

  it('a second compile while one is running does not wipe the first\'s proposal', async () => {
    // The reset used to happen before the `isRunning` guard, so the call that
    // got turned away cleared the proposal of the run that turned it away.
    const proposed = 'export default defineSteps([{ source: "Navigate", async run() {} }]);\n';
    fake.streamScripts = [
      (f) => {
        f.push({ type: 'step:start', line: 8 });
        f.push({ type: 'step:pass', line: 8 });
        f.push({
          type: 'compile:result',
          status: 'partial',
          files: { [stepsPath]: proposed },
          summary: summaryFor({ compiled: 1, unproven: [1] }),
        });
        // Deliberately left open: the second command lands while this run is
        // still in flight, exactly as a double-click would.
      },
    ];
    void vscode.commands.executeCommand('testbench-native.runAndCompile');
    await waitFor('result folded', () => fake.requests.length > 0);
    await sleep(300);

    await vscode.commands.executeCommand('testbench-native.runAndCompile');
    assert.match(hooks.lastCompileError() ?? '', /run of this test is in progress/);
    assert.equal(fake.requests.length, 1, 'the second call must not reach the server');

    fake.push({ type: 'done', status: 'passed' });
    fake.end();
    await waitFor('proposal survives', () => hooks.pendingCodeBehind() !== null, 10_000);
    assert.equal(hooks.pendingCodeBehind().files[stepsPath], proposed);
  });

  it('compiles a section body step, attributing it to its section', async () => {
    // The user hit this live: the review round refused it outright. The step
    // runs detached at the root frame, as Run Step Here runs it; only the
    // entry's BINDING moves under the section.
    const sectionedMd = path.resolve(FIXTURES_DIR, 'compile-body.md');
    fs.writeFileSync(sectionedMd, SECTIONED_MD, 'utf-8');
    try {
      await openFixture(sectionedMd);
      // Line 12 is `1. Type the username` inside the `Sign in` body.
      void vscode.commands.executeCommand('testbench-native.compileStepCodeBehind', {
        lineNumber: 12,
      });
      await waitFor('run requested', () => fake.requests.length > 0);

      const request = fake.requests[0];
      assert.equal(request.compile, 'steps');
      assert.deepEqual(request.steps, ['Type the username']);
      assert.deepEqual(request.sourceLines, [12]);
      assert.deepEqual(request.compileScope, { section: 'Sign in' });

      fake.end();
      await waitFor('idle', () => !hooks.isRunning());
    } finally {
      fs.rmSync(sectionedMd, { force: true });
    }
  });

  it('compiles a whole section body in order, under one scope', async () => {
    const sectionedMd = path.resolve(FIXTURES_DIR, 'compile-body-all.md');
    fs.writeFileSync(sectionedMd, SECTIONED_MD, 'utf-8');
    try {
      const editor = await openFixture(sectionedMd);
      editor.selection = new vscode.Selection(
        new vscode.Position(11, 0),
        new vscode.Position(12, 12),
      );
      void vscode.commands.executeCommand('testbench-native.compileStepCodeBehind', {
        lineNumber: 12,
      });
      await waitFor('run requested', () => fake.requests.length > 0);

      const request = fake.requests[0];
      assert.deepEqual(request.sourceLines, [12, 13]);
      assert.deepEqual(request.compileScope, { section: 'Sign in' });

      fake.end();
      await waitFor('idle', () => !hooks.isRunning());
    } finally {
      fs.rmSync(sectionedMd, { force: true });
    }
  });

  it('refuses a selection that spans a section body and the main flow', async () => {
    // Each entry binds to one scope; guessing one would put half of them where
    // nothing looks for them.
    const sectionedMd = path.resolve(FIXTURES_DIR, 'compile-body-mixed.md');
    fs.writeFileSync(sectionedMd, SECTIONED_MD, 'utf-8');
    try {
      const editor = await openFixture(sectionedMd);
      // Line 9 is a main-flow step, line 12 is inside the `Sign in` body.
      editor.selection = new vscode.Selection(
        new vscode.Position(8, 0),
        new vscode.Position(11, 12),
      );
      void vscode.commands.executeCommand('testbench-native.compileStepCodeBehind', {
        lineNumber: 12,
      });
      await waitFor('refused', () => hooks.lastCompileError() !== null, 5_000);
      assert.match(hooks.lastCompileError(), /spans .* and .*/);
      assert.match(hooks.lastCompileError(), /Sign in/);
      assert.match(hooks.lastCompileError(), /main flow/);
      assert.equal(fake.requests.length, 0);
    } finally {
      fs.rmSync(sectionedMd, { force: true });
    }
  });

  it('refuses a body step whose text repeats within its own section', async () => {
    // Occurrence is counted within the request, so sending one of two
    // identical body steps numbers it 0 and the entry lands on the first.
    const repeatBody = path.resolve(FIXTURES_DIR, 'compile-body-repeat.md');
    fs.writeFileSync(
      repeatBody,
      [
        '---', 'tags: [codebehind]', '---', '',
        '# Repeat Body', '',
        '## Steps',
        '1. Sign in',
        '',
        '### Sign in',
        '1. Press Enter',
        '2. Type the code',
        '3. Press Enter',
        '',
      ].join('\n'),
      'utf-8',
    );
    try {
      await openFixture(repeatBody);
      // Line 13 is the second `Press Enter` in the body.
      void vscode.commands.executeCommand('testbench-native.compileStepCodeBehind', {
        lineNumber: 13,
      });
      await waitFor('refused', () => hooks.lastCompileError() !== null, 5_000);
      assert.match(hooks.lastCompileError(), /appears more than once/);
      assert.match(hooks.lastCompileError(), /"Sign in"/);
      assert.equal(fake.requests.length, 0);

      // …and the body step that does NOT repeat compiles.
      void vscode.commands.executeCommand('testbench-native.compileStepCodeBehind', {
        lineNumber: 12,
      });
      await waitFor('run requested', () => fake.requests.length > 0);
      assert.deepEqual(fake.requests[0].steps, ['Type the code']);
      assert.deepEqual(fake.requests[0].compileScope, { section: 'Sign in' });
      fake.end();
      await waitFor('idle', () => !hooks.isRunning());
    } finally {
      fs.rmSync(repeatBody, { force: true });
    }
  });

  it('refuses a step whose text repeats, where a single-step compile cannot tell which', async () => {
    // Occurrence is counted WITHIN the request, so a lone second "Press Enter"
    // is occurrence 0 to the server and its entry would replace the first
    // one's — code generated from a different step.
    const repeatMd = path.resolve(FIXTURES_DIR, 'compile-repeat.md');
    fs.writeFileSync(
      repeatMd,
      ['---', 'tags: [codebehind]', '---', '', '# Repeat', '', '## Steps', '1. Press Enter', '2. Type the code', '3. Press Enter', ''].join('\n'),
      'utf-8',
    );
    try {
      await openFixture(repeatMd);
      void vscode.commands.executeCommand('testbench-native.compileStepCodeBehind', {
        lineNumber: 10,
      });
      await waitFor('refused', () => hooks.lastCompileError() !== null, 5_000);
      assert.match(hooks.lastCompileError(), /appears more than once/);
      assert.match(hooks.lastCompileError(), /Run & Compile/);
      assert.equal(fake.requests.length, 0);

      // …and the step that does NOT repeat still compiles.
      void vscode.commands.executeCommand('testbench-native.compileStepCodeBehind', {
        lineNumber: 9,
      });
      await waitFor('run requested', () => fake.requests.length > 0);
      assert.deepEqual(fake.requests[0].steps, ['Type the code']);
      fake.end();
      await waitFor('idle', () => !hooks.isRunning());
    } finally {
      fs.rmSync(repeatMd, { force: true });
    }
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

  it('a run its own text ended is logged as ended, not as a step to fix', async () => {
    // stories/step-failure-outcomes.md §"What the compile showed": a summary
    // carrying `endedAsWritten` and NO `stoppedAt`, where the live compiler used to
    // put the fact in the field whose every reader says "failed under AI — fix it".
    // Sliced from `logBefore` because the negative assertions below would
    // otherwise read an earlier test's lines out of the shared channel.
    const logBefore = readLiveLog()?.length ?? 0;
    const error = 'The variable value was peanuts. Expected apples';
    fake.streamScripts = [
      (f) => {
        f.push({ type: 'step:start', line: 8 });
        f.push({ type: 'step:pass', line: 8 });
        f.push({ type: 'compile:step', phase: 'generate', step: 1, line: 8, message: 'generated' });
        f.push({ type: 'step:start', line: 9 });
        f.push({ type: 'step:fail', line: 9, error, deliberate: true });
        f.push({
          type: 'compile:result',
          status: 'partial',
          files: { [stepsPath]: 'export default defineSteps([]);\n' },
          summary: summaryFor({
            compiled: 2,
            unproven: [1, 2],
            endedAsWritten: {
              step: 2,
              error,
              line: 'If {{a}} is "peanuts" then fail the test with error "…"',
            },
          }),
        });
        f.push({ type: 'done', status: 'failed' });
        f.end();
      },
    ];

    void vscode.commands.executeCommand('testbench-native.runAndCompile');
    await waitFor('proposal pending', () => hooks.pendingCodeBehind() !== null);

    const log = readLiveLog();
    if (log === null) return; // TESTBENCH_LIVE_LOG not set — nothing to read.
    const thisRun = log.slice(logBefore);
    assert.match(
      thisRun,
      /ended at step 2 as its text says — The variable value was peanuts\. Expected apples/,
      `the compile line must say the run ENDED; got:\n${thisRun}`,
    );
    // The two phrases that sent an author to repair a working step.
    assert.doesNotMatch(thisRun, /failed under AI/);
    assert.doesNotMatch(thisRun, /stopped at step/);
    // And the step itself is logged as written, not as a malfunction.
    assert.match(thisRun, /✗ step 9 failed as written: The variable value was peanuts/);
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

  it('a stale entry outranks the code-behind flag — the mark asks for a recompile', async () => {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({
      type: 'step:pass',
      line: 8,
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

  // ── Failure text pinned to the line (the ✗/⚠ hovers + panel rows) ────────
  //
  // The marks used to be all the editor knew — the error itself lived only in
  // the scrolling run log, and for a heal whose AI attempt also failed the
  // code-behind crash reached the client not at all. The tracker now pins a
  // StepFailureDetail per line; these cover the event→tracker mapping.
  it('pins the failure text to the line — ✗ and ⚠ both carry their error', async () => {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    // Line 8: the step's own code-behind failed (step.expect / strict).
    fake.push({
      type: 'step:fail',
      line: 8,
      error: 'the confirmation banner never appeared',
      fromCodeBehind: true,
    });
    // Line 9: entry threw, healed under AI.
    fake.push({
      type: 'step:pass',
      line: 9,
      codeBehindStale: { file: '/x/compile-me.steps.ts', error: 'locator timeout' },
    });
    await waitFor('details pinned', () => {
      const failures = Object.fromEntries(hooks.tracker.snapshot().failures);
      return (
        failures[8]?.error === 'the confirmation banner never appeared' &&
        failures[9]?.codeBehindStale?.error === 'locator timeout'
      );
    });

    const failures = Object.fromEntries(hooks.tracker.snapshot().failures);
    assert.equal(failures[8].fromCodeBehind, true);
    assert.equal(failures[9].codeBehindStale.file, '/x/compile-me.steps.ts');
    // The ⚠'s detail carries no step error — the step passed.
    assert.equal(failures[9].error, undefined);

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('a ✗ after a failed heal carries BOTH errors', async () => {
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);

    fake.push({
      type: 'step:fail',
      line: 8,
      error: 'AI could not find the button either',
      codeBehindStale: { file: '/x/compile-me.steps.ts', error: 'boom' },
    });
    await waitFor('detail pinned', () => {
      const failures = Object.fromEntries(hooks.tracker.snapshot().failures);
      return failures[8]?.codeBehindStale?.error === 'boom';
    });
    const failures = Object.fromEntries(hooks.tracker.snapshot().failures);
    assert.equal(failures[8].error, 'AI could not find the button either');

    fake.end();
    await waitFor('idle', () => !hooks.isRunning());
  });

  it('a retry that passes clears the pinned failure with the ✗', async () => {
    // Fail then pass on the SAME line in the SAME stream — the paused-on-error
    // edit-and-Continue shape. Not two runs: run-start clears everything
    // anyway, and what's under test is the per-line replacement, so a green
    // mark can never sit on top of last attempt's failure text.
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('stream active', () => fake.hasActiveStream);
    fake.push({ type: 'step:fail', line: 8, error: 'no such button' });
    await waitFor('detail pinned', () => {
      const failures = Object.fromEntries(hooks.tracker.snapshot().failures);
      return failures[8]?.error === 'no such button';
    });

    fake.push({ type: 'step:pass', line: 8 });
    await waitFor('pass painted', () => {
      const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
      return statuses[8] === 'pass';
    });
    const failures = Object.fromEntries(hooks.tracker.snapshot().failures);
    assert.equal(failures[8], undefined, 'the failure text must not survive a green retry');

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

  // ── Repair this step (stories/codebehind-selector-ambiguity.md) ─────────
  //
  // Repairing a ⚠ has always worked: `mode: 'steps'` is the mode where the
  // server's `priorFailure` reads the last-run sidecar and routes generation
  // through the repair prompt. What was missing is that nothing about the ⚠
  // says a command called "Compile This Step" is the fix. So Repair is that
  // command under a second name, on the ⚠ — and the tests below are about
  // exactly that: same request, right lines, no session gate.
  describe('Repair this step', () => {
    beforeEach(() => {
      // Collapse the selection first. The suite reopens one fixture file for
      // every case and VS Code restores the editor's last selection with it,
      // so the multi-line selection an earlier case left behind would widen
      // these one-step compiles to two — `compileStepOnActive` reads the
      // selection whenever the caller doesn't hand it a range. A gutter
      // right-click has no highlighted range, which is the state under test.
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const home = new vscode.Position(0, 0);
      editor.selection = new vscode.Selection(home, home);
    });

    it('is registered as a command', async () => {
      const commands = await vscode.commands.getCommands(true);
      assert.equal(
        commands.includes('testbench-native.repairStep'),
        true,
        'testbench-native.repairStep is not registered',
      );
    });

    it('sends byte-for-byte the request Compile This Step sends', async () => {
      // The claim the whole slice rests on. Two ids, one body — but a body
      // that got forked later would still pass a test that only asserted
      // `compile === 'steps'`, so this compares the WHOLE request rather than
      // the field anyone would remember to check.
      void vscode.commands.executeCommand('testbench-native.compileStepCodeBehind', {
        lineNumber: 9,
      });
      await waitFor('compile requested', () => fake.requests.length > 0);
      fake.end();
      await waitFor('idle', () => !hooks.isRunning());

      void vscode.commands.executeCommand('testbench-native.repairStep', { lineNumber: 9 });
      await waitFor('repair requested', () => fake.requests.length > 1);
      fake.end();
      await waitFor('idle', () => !hooks.isRunning());

      // `config` rides the FIRST request of a session only (`includeConfig`),
      // so it is on the compile and not on the repair for reasons that have
      // nothing to do with which command was pressed. Everything else must
      // match.
      const withoutConfig = (r) => {
        const { config, ...rest } = r;
        return rest;
      };
      assert.deepEqual(withoutConfig(fake.requests[1]), withoutConfig(fake.requests[0]));
      assert.equal(fake.requests[1].compile, 'steps');
      assert.deepEqual(fake.requests[1].sourceLines, [9]);
      assert.deepEqual(fake.requests[1].steps, ['Click the "Get started" button']);
    });

    it('the ⚠ hover names the action and states its precondition', async () => {
      // The mark on its own reads as "something is wrong here" and stops. It
      // has to say what the fix is called, and — because there is deliberately
      // no gate — what invoking it will DO, so an author whose session is
      // parked elsewhere can tell before pressing.
      const hover = hooks.staleHoverMessage();
      assert.match(hover, /Repair this step/);
      assert.match(hover, /re-runs this step in the current session/);

      // And the variant an author actually sees: once the run pins the crash
      // to the line, the hover leads with it and names the entry's file — but
      // must not lose the action line while doing so. The hook takes the same
      // detail the decoration passes, so this is the rendered string, not a
      // second copy of it.
      const withDetail = hooks.staleHoverMessage({
        codeBehindStale: {
          file: '/x/compile-me.steps.ts',
          error: 'locator resolved to 2 elements',
        },
      });
      assert.match(withDetail, /locator resolved to 2 elements/);
      assert.match(withDetail, /compile-me\.steps\.ts/);
      assert.match(withDetail, /Repair this step/);
      assert.match(withDetail, /re-runs this step in the current session/);
    });

    it('is offered on the ⚠ line and on no other', async () => {
      // The gutter item's `when` is `editorLineNumber in
      // testbench-native.staleStepLines`, so this array IS the visibility
      // rule. Line 8 passes as code (`</>`), line 9 heals under AI (⚠).
      void vscode.commands.executeCommand('testbench-native.runAll');
      await waitFor('stream active', () => fake.hasActiveStream);

      fake.push({ type: 'step:pass', line: 8, fromCodeBehind: true });
      fake.push({
        type: 'step:pass',
        line: 9,
        codeBehindStale: { file: '/x/compile-me.steps.ts', error: 'locator timeout' },
      });
      await waitFor(
        'stale line published',
        () => hooks.tracker.lastStaleLinesContextValue.length > 0,
      );
      assert.deepEqual(
        hooks.tracker.lastStaleLinesContextValue,
        [9],
        'a `</>` step must not be offered a repair, and neither must a plain one',
      );

      fake.end();
      await waitFor('idle', () => !hooks.isRunning());
    });

    it('stops being offered once the entry passes as code again', async () => {
      void vscode.commands.executeCommand('testbench-native.runAll');
      await waitFor('stream active', () => fake.hasActiveStream);
      fake.push({
        type: 'step:pass',
        line: 9,
        codeBehindStale: { file: '/x/compile-me.steps.ts', error: 'boom' },
      });
      await waitFor('⚠ offered', () => hooks.tracker.lastStaleLinesContextValue.length === 1);
      fake.end();
      await waitFor('idle', () => !hooks.isRunning());

      // The repaired entry proves itself on the next run: `</>`, no ⚠, and
      // the offer goes away on its own rather than lingering as a to-do.
      void vscode.commands.executeCommand('testbench-native.runAll');
      await waitFor('second stream active', () => fake.hasActiveStream);
      fake.push({ type: 'step:pass', line: 9, fromCodeBehind: true });
      await waitFor(
        'offer withdrawn',
        () => hooks.tracker.lastStaleLinesContextValue.length === 0,
      );

      fake.end();
      await waitFor('idle', () => !hooks.isRunning());
    });

    it('runs from wherever the session is parked — no page-state gate', async () => {
      // The spec's "Repair after the run finished": the browser is at the end
      // state, not the step's starting page. The framework cannot tell (and
      // does not try) — it runs the step and lets a wrong page fail it the
      // ordinary way. What must NOT happen is a refusal here.
      void vscode.commands.executeCommand('testbench-native.runAll');
      await waitFor('stream active', () => fake.hasActiveStream);
      fake.push({ type: 'step:pass', line: 8 });
      fake.push({ type: 'step:pass', line: 9 });
      fake.push({ type: 'done', status: 'passed' });
      fake.end();
      await waitFor('run finished', () => !hooks.isRunning());

      const before = fake.requests.length;
      void vscode.commands.executeCommand('testbench-native.repairStep', { lineNumber: 9 });
      await waitFor('repair requested', () => fake.requests.length > before);

      assert.equal(fake.requests[before].compile, 'steps');
      assert.deepEqual(fake.requests[before].sourceLines, [9]);
      // No refusal was recorded. Every gate this flow DOES have (a run in
      // flight, an inert line, a scope it cannot bind) writes one, so a
      // page-state gate sneaking in later would show up right here.
      assert.equal(hooks.lastCompileError(), null);

      fake.end();
      await waitFor('idle', () => !hooks.isRunning());
    });

    it('refuses nothing when the step has never been marked stale', async () => {
      // The command itself carries no ⚠ precondition — the MENU decides where
      // it appears, and invoking it anywhere else (palette, keybinding) is
      // just Compile This Step, which is a sound thing to do to any step.
      void vscode.commands.executeCommand('testbench-native.repairStep', { lineNumber: 8 });
      await waitFor('repair requested', () => fake.requests.length > 0);

      assert.equal(fake.requests[0].compile, 'steps');
      assert.deepEqual(fake.requests[0].sourceLines, [8]);
      assert.equal(hooks.lastCompileError(), null);
      assert.deepEqual(hooks.tracker.lastStaleLinesContextValue, []);

      fake.end();
      await waitFor('idle', () => !hooks.isRunning());
    });
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

  /**
   * The compile tail's signals (stories/compile-tail-progress.md).
   *
   * Everything asserted here is what the extension host DOES with the server's
   * frames: which file each panel message is stamped for, when the strip goes
   * up and comes down, and what the workbench-level aggregator is holding. The
   * webview's own rendering is pinned separately (tests/panel-scope.test.js);
   * its state is not readable from the extension host.
   */
  describe('the compile tail', () => {
    /**
     * Messages the panel was told about SINCE this test started. The view
     * accumulates across the file, so every assertion is made against a mark
     * taken before the command under test.
     */
    let mark = 0;
    /**
     * Every toast this test raised. A real notification cannot be read back
     * from the extension host and would sit on screen for the length of the
     * suite, so the reporter is swapped for every test in this block rather
     * than inside the one that asserts on it.
     */
    let toasts = [];
    beforeEach(() => {
      mark = hooks.hostMessageCount();
      toasts = [];
      hooks.setCompileProgressReporter((options, task) => {
        const toast = {
          title: options.title,
          cancellable: options.cancellable,
          details: [],
          done: false,
        };
        toasts.push(toast);
        const progress = { report: (v) => toast.details.push(v) };
        return Promise.resolve(task(progress, { isCancellationRequested: false })).then(() => {
          toast.done = true;
        });
      });
    });
    const posted = (type) => hooks.hostMessagesSince(mark).filter((m) => m.type === type);
    const strips = () => posted('compileProgress');

    /** A tail that runs to a result, with the frames a current server sends. */
    function tailScript(file, content) {
      return (f) => {
        f.push({ type: 'step:start', line: 8 });
        f.push({ type: 'step:pass', line: 8 });
        f.push({ type: 'step:start', line: 9 });
        f.push({ type: 'step:pass', line: 9 });
        // The run's steps are done; everything after this is tail.
        f.push({ type: 'output', msg: 'Run finished — 2 entries still to generate, then a review pass', kind: 'info' });
        f.push({
          type: 'compile:progress',
          done: 0,
          total: 2,
          phase: 'generate',
          reviewPending: true,
          runEnded: true,
        });
        f.push({ type: 'compile:step', phase: 'generate', step: 1, line: 8, message: 'generating…' });
        f.push({
          type: 'compile:progress',
          done: 0,
          total: 2,
          phase: 'generate',
          step: 1,
          line: 8,
          reviewPending: true,
        });
        f.push({ type: 'compile:step', phase: 'generate', step: 1, line: 8, message: 'generated' });
        f.push({ type: 'compile:progress', done: 1, total: 2, phase: 'generate', reviewPending: true });
        f.push({ type: 'compile:step', phase: 'review', step: 0, message: 'reviewing compile-me.steps.ts…' });
        f.push({ type: 'compile:progress', done: 2, total: 2, phase: 'review' });
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

    it('raises the strip at run end, tracks it, and takes it down on the result', async () => {
      fake.streamScripts = [tailScript(() => stepsPath, 'export default defineSteps([]);\n')];

      void vscode.commands.executeCommand('testbench-native.runAndCompile');
      await waitFor('proposal pending', () => hooks.pendingCodeBehind() !== null);
      await waitFor('idle', () => !hooks.isRunning());

      const states = strips().map((m) => m.state);
      // First up at run end, with the counts the forecast carried…
      const first = states.find((s) => s !== null);
      assert.ok(first, 'the strip never went up');
      assert.equal(first.file, 'compile-me.md');
      assert.equal(first.total, 2);
      // …tracked through generation and Review…
      assert.ok(
        states.some((s) => s && s.phase === 'review'),
        'Review never reached the strip',
      );
      // …and down on the result, which is the last thing the strip is told.
      assert.equal(states[states.length - 1], null, 'the strip outlived the compile');
      // Nothing left aggregating in the status bar either.
      assert.deepEqual(hooks.compileTails(), []);
    });

    it('stays down while the run is still executing steps', async () => {
      // Generation trails the browser, so a current server's `generating…`
      // frames arrive WHILE later steps are still running. Treating one as
      // "the tail has begun" put the strip up mid-run, on top of the steps
      // that were already reporting their own progress.
      fake.streamScripts = [
        (f) => {
          f.push({ type: 'step:start', line: 8 });
          f.push({ type: 'step:pass', line: 8 });
          // Step 1's entry is generated while step 2 runs — progress frame
          // first, prose second, as the server orders them.
          f.push({ type: 'compile:progress', done: 0, total: 2, phase: 'generate', step: 1, line: 8, reviewPending: true });
          f.push({ type: 'compile:step', phase: 'generate', step: 1, line: 8, message: 'generating…' });
          f.push({ type: 'step:start', line: 9 });
          f.push({ type: 'compile:progress', done: 1, total: 2, phase: 'generate', reviewPending: true });
          f.push({ type: 'compile:step', phase: 'generate', step: 1, line: 8, message: 'generated' });
          f.push({ type: 'step:pass', line: 9 });
        },
      ];

      void vscode.commands.executeCommand('testbench-native.runAndCompile');
      await waitFor('run requested', () => fake.requests.length > 0);
      await waitFor('both steps reported', () => posted('compileEvent').length >= 2);

      assert.deepEqual(
        strips().map((m) => m.state).filter(Boolean),
        [],
        'the strip went up while the run was still painting steps',
      );
      assert.deepEqual(hooks.compileTails(), []);

      fake.end();
      await waitFor('idle', () => !hooks.isRunning());
    });

    it('stamps every panel message with the file it belongs to', async () => {
      fake.streamScripts = [tailScript(() => stepsPath, 'export default defineSteps([]);\n')];
      const uri = vscode.Uri.file(mdPath).toString();

      void vscode.commands.executeCommand('testbench-native.runAndCompile');
      await waitFor('run requested', () => fake.requests.length > 0);
      await waitFor('idle', () => !hooks.isRunning());

      // Without the stamp the panel's Output section is one shared pane and
      // two concurrent compiles interleave in it.
      for (const type of ['runEvent', 'compileEvent', 'compileProgress']) {
        const msgs = posted(type);
        assert.ok(msgs.length > 0, `no ${type} messages were posted`);
        for (const m of msgs) assert.equal(m.uri, uri, `${type} carried ${m.uri}`);
      }
    });

    it('forwards the compile log lines to the panel, not only to the channel', async () => {
      fake.streamScripts = [tailScript(() => stepsPath, 'export default defineSteps([]);\n')];

      void vscode.commands.executeCommand('testbench-native.runAndCompile');
      await waitFor('run requested', () => fake.requests.length > 0);
      await waitFor('idle', () => !hooks.isRunning());

      const lines = posted('compileEvent').map((m) => m.line);
      // Starts and completions both — the pair is the point: the gap between
      // them is the model call the author is waiting on.
      assert.ok(lines.some((l) => /generating…/.test(l)), lines.join('\n'));
      assert.ok(lines.some((l) => /step 1 generated/.test(l)), lines.join('\n'));
      assert.ok(lines.some((l) => /reviewing compile-me\.steps\.ts…/.test(l)), lines.join('\n'));
      // …and the result line the panel already had.
      assert.ok(lines.some((l) => /Compiled compile-me\.md/.test(l)), lines.join('\n'));
      // The structured event is never a log line — a client that read the
      // counts out of prose is the mirror it exists to avoid.
      assert.equal(lines.some((l) => /compile:progress/.test(l)), false);
    });

    it('degrades to an indeterminate strip against a server that sends no counts', async () => {
      // Version skew, new client / old server: `compile:progress` never
      // arrives, so the first compile frame is the only cue the tail began.
      fake.streamScripts = [
        (f) => {
          f.push({ type: 'step:start', line: 8 });
          f.push({ type: 'step:pass', line: 8 });
          f.push({ type: 'compile:step', phase: 'generate', step: 1, line: 8, message: 'generated' });
          f.push({
            type: 'compile:result',
            status: 'partial',
            files: { [stepsPath]: 'export default defineSteps([]);\n' },
            summary: summaryFor({ compiled: 1, unproven: [1] }),
          });
          f.push({ type: 'done', status: 'passed' });
          f.end();
        },
      ];

      void vscode.commands.executeCommand('testbench-native.runAndCompile');
      await waitFor('run requested', () => fake.requests.length > 0);
      await waitFor('idle', () => !hooks.isRunning());

      const states = strips().map((m) => m.state);
      const up = states.find((s) => s !== null);
      assert.ok(up, 'no strip at all is the silence this story removed');
      // No counts, and a strip that says so rather than inventing a position.
      assert.equal(up.done, null);
      assert.equal(up.total, null);
      assert.equal(up.file, 'compile-me.md');
      assert.equal(states[states.length - 1], null);
    });

    it('takes the strip down when the stream ends without a result', async () => {
      // A dropped connection, or a server that never sends one. A spinner that
      // outlives its compile is worse than no spinner.
      fake.streamScripts = [
        (f) => {
          f.push({ type: 'step:start', line: 8 });
          f.push({ type: 'step:pass', line: 8 });
          f.push({ type: 'compile:progress', done: 0, total: 1, phase: 'generate', runEnded: true });
          f.push({ type: 'done', status: 'passed' });
          f.end();
        },
      ];

      void vscode.commands.executeCommand('testbench-native.runAndCompile');
      await waitFor('run requested', () => fake.requests.length > 0);
      await waitFor('idle', () => !hooks.isRunning());

      const states = strips().map((m) => m.state);
      assert.ok(states.some((s) => s !== null), 'the strip never went up');
      assert.equal(states[states.length - 1], null, 'the strip outlived the run');
      assert.deepEqual(hooks.compileTails(), []);
    });

it('raises one toast per compile, names the file, and resolves it on the result', async () => {
      fake.streamScripts = [tailScript(() => stepsPath, 'export default defineSteps([]);\n')];

      void vscode.commands.executeCommand('testbench-native.runAndCompile');
      await waitFor('run requested', () => fake.requests.length > 0);
      await waitFor('idle', () => !hooks.isRunning());
      await waitFor('toast resolved', () => toasts.length > 0 && toasts[0].done);

      assert.equal(toasts.length, 1, 'one toast per compile');
      assert.equal(toasts[0].title, 'Compiling code-behind for compile-me.md');
      // Stop in the panel already aborts the tail; a Cancel link on a toast is
      // a destructive control in a place people click reflexively.
      assert.equal(toasts[0].cancellable, false);
      // It tracks the counts rather than sitting at 0 until it disappears.
      const messages = toasts[0].details.map((d) => d.message).filter(Boolean);
      assert.ok(
        messages.some((m) => /entries generated/.test(m)),
        JSON.stringify(messages),
      );
    });

    it('aggregates two files compiling at once, and clears as each finishes', async () => {
      // Reachable today: the compile lock is per test file, so two DIFFERENT
      // files compile concurrently while a second compile of the same one is
      // refused with a 409.
      const otherMd = path.resolve(FIXTURES_DIR, 'compile-me-too.md');
      const otherSteps = path.resolve(FIXTURES_DIR, 'compile-me-too.steps.ts');
      fs.writeFileSync(otherMd, TEST_MD, 'utf-8');
      // Neither stream is ended by its script: both tails stay up until this
      // test finishes them, which is the state the status bar has to describe.
      const openTail = (steps) => (f) => {
        f.push({ type: 'step:start', line: 8 });
        f.push({ type: 'step:pass', line: 8 });
        f.push({ type: 'compile:progress', done: 0, total: 2, phase: 'generate', reviewPending: true, runEnded: true });
        void steps;
      };
      fake.streamScripts = [openTail(stepsPath), openTail(otherSteps)];

      try {
        void vscode.commands.executeCommand('testbench-native.runAndCompile');
        await waitFor('first run requested', () => fake.requests.length > 0);
        await waitFor('first tail up', () => hooks.compileTails().length === 1);

        await openFixture(otherMd);
        void vscode.commands.executeCommand('testbench-native.runAndCompile');
        await waitFor('second run requested', () => fake.requests.length > 1);
        await waitFor('both tails up', () => hooks.compileTails().length === 2);

        const files = hooks.compileTails().map((t) => t.file).sort();
        assert.deepEqual(files, ['compile-me-too.md', 'compile-me.md']);
      } finally {
        // Stop both runs; each tail resolves with its (empty) result.
        await vscode.commands.executeCommand('testbench-native.stop');
        await openFixture(mdPath);
        await vscode.commands.executeCommand('testbench-native.stop');
        await waitFor('tails cleared', () => hooks.compileTails().length === 0, 10_000);
        fs.rmSync(otherMd, { force: true });
        fs.rmSync(otherSteps, { force: true });
      }
    });

    it('an ordinary run raises no strip — its steps are their own progress', async () => {
      fake.streamScripts = [
        (f) => {
          f.push({ type: 'step:start', line: 8 });
          f.push({ type: 'step:pass', line: 8 });
          f.push({ type: 'done', status: 'passed' });
          f.end();
        },
      ];

      void vscode.commands.executeCommand('testbench-native.runAll');
      await waitFor('run requested', () => fake.requests.length > 0);
      await waitFor('idle', () => !hooks.isRunning());

      assert.deepEqual(strips().map((m) => m.state).filter(Boolean), []);
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

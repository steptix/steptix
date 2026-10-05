/**
 * Integration tests for the test-runner's `runnerControl` handling.
 *
 * Specifically: when `executeStep` returns a StepResult with `runnerControl`
 * set (because the user took control inside the AI clarification REPL), the
 * outer loop must:
 *
 *  1. NOT re-enter the failure-handoff REPL even when the step is `failed`
 *     (re-entry guard — the user already chose to abort).
 *  2. Jump the loop on `kind: 'resume'`.
 *  3. Bail immediately on `kind: 'exit'`.
 *  4. Append `adHocResults` to the report after the parent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Config } from '../src/config/types.js';
import type { ParsedTest, TestInstance } from '../src/parser/types.js';
import type { StepResult, TestReport } from '../src/report/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

// ─── Mock the full dependency surface that runTest pulls in ────────────────

const launchBrowserMock = vi.fn();
const closeBrowserMock = vi.fn();
vi.mock('../src/browser/manager.js', () => ({
  launchBrowser: (...args: unknown[]) => launchBrowserMock(...args),
  closeBrowser: (...args: unknown[]) => closeBrowserMock(...args),
  // Video recording: 'off' so the runner takes no recording path. The runner
  // now routes teardown through finalizeMainPageVideo, so the mock must still
  // invoke `closeContext` — that's what fires closeBrowserMock (via the tracker
  // stub's closeAll, or closeBrowser for CDP), preserving the prior teardown
  // the tests assert on.
  resolveVideoMode: () => 'off',
  finalizeMainPageVideo: async (args: { closeContext: () => Promise<void> }) => {
    await args.closeContext();
    return undefined;
  },
  // Minimal BrowserTracker stub: tracks the initial session, returns it
  // as active, and closeAll is a no-op (the test relies on closeBrowserMock
  // being called for non-CDP teardown — but the multi-browser branch uses
  // tracker.closeAll, so we delegate). The two paths converge by having
  // closeAll call closeBrowserMock for the initial session.
  // The 'no browser yet' sentinel (SPEC-use-computer.md §4.6). A mock of
  // this module must export it: api-server and session-manager both do
  // `instanceof` against it, and `instanceof undefined` throws.
  NoBrowserLaunchedError: class NoBrowserLaunchedError extends Error {
    constructor(message = 'no browser has been launched in this session') {
      super(message);
      this.name = 'NoBrowserLaunchedError';
    }
  },
  NO_BROWSER_LAUNCHED_MESSAGE: 'no browser has been launched in this session',
  BrowserTracker: class BrowserTrackerStub {
    private session: unknown;
    private launch: (() => Promise<unknown>) | undefined;
    constructor(initial: unknown) { this.session = initial; }
    getActive() {
      if (this.session === undefined) {
        throw new Error('no browser has been launched in this session');
      }
      return this.session;
    }
    getActivePage() { return (this.getActive() as { page: unknown }).page; }
    has() { return false; }
    add() {}
    switchTo() { return this.session; }
    async close() {}
    async closeAll() { if (this.session !== undefined) closeBrowserMock(this.session); }
    list() { return []; }
    get count() { return this.session === undefined ? 0 : 1; }
    // ── Lazy launch (SPEC-use-computer.md §4.6) ──
    // Modelled rather than stubbed: the deferred tracker starts EMPTY, so a
    // runner that forgot to call ensureLaunched() fails here instead of
    // quietly getting a browser it never asked for.
    hasActive() { return this.session !== undefined; }
    static deferred(launch: () => Promise<unknown>) {
      const tracker = new BrowserTrackerStub(undefined);
      tracker.launch = launch;
      return tracker;
    }
    async ensureLaunched() {
      if (this.session === undefined) this.session = await this.launch!();
      return this.session;
    }
  },
}));

const executeStepMock = vi.fn();
const executeBranchedStepMock = vi.fn();
vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: (...args: unknown[]) => executeStepMock(...args),
  executeBranchedStep: (...args: unknown[]) => executeBranchedStepMock(...args),
}));

const runInteractiveReplMock = vi.fn();
vi.mock('../src/runner/interactive-repl.js', () => ({
  runInteractiveRepl: (...args: unknown[]) => runInteractiveReplMock(...args),
}));

const resolveHooksMock = vi.fn();
vi.mock('../src/runner/hooks.js', () => ({
  resolveHooks: (...args: unknown[]) => resolveHooksMock(...args),
}));

const diagnoseFailureMock = vi.fn();
vi.mock('../src/ai/diagnose.js', () => ({
  diagnoseFailure: (...args: unknown[]) => diagnoseFailureMock(...args),
}));

vi.mock('../src/ai/client.js', () => ({
  AiClient: class { setAiPolicy = vi.fn(); syncAuth = vi.fn(() => null); },
}));

vi.mock('../src/utils/run-log.js', () => ({
  openRunLogFile: () => null,
  attachRunLogBridges: () => () => {},
}));

// Spread the real module so the pure helpers stay real — the runner now counts
// healed steps through `countStepOrigins` when it assembles the report, and a
// factory that lists only the stubbed names would leave it undefined.
vi.mock('../src/report/generator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/report/generator.js')>()),
  generateReport: vi.fn().mockResolvedValue(''),
  getPrimaryModel: () => undefined,
  // Used by the runner's teardown to name the session video; a stub base name
  // is fine since video is mocked 'off' (no .webm is actually produced here).
  buildReportBaseName: (report: { testName: string }) => report.testName,
}));

vi.mock('../src/report/history-appender.js', () => ({
  appendRunHistory: vi.fn().mockResolvedValue(undefined),
}));

// Now import runTest AFTER all mocks are declared (they're hoisted, but this
// keeps the order obvious to the reader).
import { runTest } from '../src/runner/test-runner.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makePage(): { url: () => string; goto: ReturnType<typeof vi.fn> } {
  return {
    url: () => 'https://example.com/page',
    goto: vi.fn().mockResolvedValue(undefined),
  };
}

function makeSession(): { page: ReturnType<typeof makePage>; pageTracker?: undefined } {
  return { page: makePage() };
}

function makeTest(steps: string[]): ParsedTest {
  return {
    filePath: '/tmp/fake-test.md',
    title: 'fake test',
    frontmatter: { tags: [] },
    config: {},
    parameters: {},
    steps,
    stepLines: steps.map((_, i) => i + 1),
    skipHooks: steps.map(() => false),
    toolCalls: steps.map(() => null),
    sourceSkills: steps.map(() => null),
    sourceSections: steps.map(() => null),
    sections: {},
    rawSteps: [...steps],
    hooks: { before: [], beforeEach: [], afterEach: [], after: [] },
    hookToolCalls: { before: [], beforeEach: [], afterEach: [], after: [] },
    hookSourceSkills: { before: [], beforeEach: [], afterEach: [], after: [] },
  };
}

function makeInstance(steps: string[]): TestInstance {
  return {
    test: makeTest(steps),
    resolvedParameters: {},
  };
}

function makeConfig(overrides: Partial<Config['execution']> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    execution: { ...DEFAULT_CONFIG.execution, ...overrides },
    browser: { ...DEFAULT_CONFIG.browser, headed: false },
  };
}

function passingResult(index: number, instruction: string): StepResult {
  return {
    index,
    instruction,
    status: 'passed',
    turns: [],
    durationMs: 1,
    retried: false,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('test-runner runnerControl handling', () => {
  /** process.stdout's own `isTTY` as it was before this block forced it —
   *  undefined when the stream had none (a piped worker's usual state). */
  let savedIsTTY: PropertyDescriptor | undefined;

  afterEach(() => {
    // Put it back, so the describes below run with the TTY state the worker
    // really has rather than this block's forced `true`.
    if (savedIsTTY) Object.defineProperty(process.stdout, 'isTTY', savedIsTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  });

  beforeEach(() => {
    // Reset only the executeStep / runInteractiveRepl mocks — clearing
    // queued mockResolvedValueOnce responses between tests so they don't
    // leak. The persistent mocks (browser, hooks, etc.) are
    // re-established below.
    executeStepMock.mockReset();
    executeBranchedStepMock.mockReset();
    runInteractiveReplMock.mockReset();
    launchBrowserMock.mockReset();
    closeBrowserMock.mockReset();
    resolveHooksMock.mockReset();
    diagnoseFailureMock.mockReset();

    launchBrowserMock.mockResolvedValue(makeSession());
    closeBrowserMock.mockResolvedValue(undefined);
    resolveHooksMock.mockResolvedValue({
      before: [],
      beforeEach: [],
      afterEach: [],
      after: [],
      hasAny: false,
    });
    diagnoseFailureMock.mockResolvedValue(null);

    // Default: stdout.isTTY treated as true so the failure-REPL path COULD
    // engage if the guard didn't fire. We force this for the re-entry test.
    savedIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  });

  it('runnerControl.exit short-circuits to bail and does NOT enter the failure-handoff REPL', async () => {
    // Step 1: clarification REPL exit. status: failed, runnerControl: exit.
    executeStepMock.mockResolvedValueOnce({
      index: 1,
      instruction: 'step one',
      status: 'failed',
      turns: [],
      durationMs: 5,
      retried: false,
      error: 'user exited from clarification REPL',
      aiExplanation: 'User exited the AI clarification REPL',
      runnerControl: { kind: 'exit' as const },
    });
    // Step 2 should NEVER be called because the loop bailed.
    executeStepMock.mockResolvedValueOnce(passingResult(2, 'step two'));

    const config = makeConfig({
      // Crucially, gate is ON — this is exactly the scenario where the bug
      // would manifest if the guard wasn't in place.
      interactiveOnFailure: true,
    });
    // Force headed so the gate's only remaining check is the guard.
    config.browser = { ...config.browser, headed: true };

    const report = await runTest(makeInstance(['step one', 'step two']), config, '');

    // The failure-handoff REPL must not have been called.
    expect(runInteractiveReplMock).not.toHaveBeenCalled();
    // The second step must not have been executed.
    expect(executeStepMock).toHaveBeenCalledTimes(1);
    // Report status reflects the failed step.
    expect(report.status).toBe('failed');
    // humanIntervened was set because runnerControl came back.
    expect(report.humanIntervened).toBe(true);
  });

  it('runnerControl.resume jumps the loop to fromStepIndex', async () => {
    // Step 1: clarification REPL resume → fromStepIndex 3.
    executeStepMock.mockResolvedValueOnce({
      index: 1,
      instruction: 'step one',
      status: 'passed',
      turns: [],
      durationMs: 5,
      retried: false,
      interactiveResumed: true,
      aiExplanation: 'User resumed from the AI clarification REPL at step 3',
      runnerControl: { kind: 'resume' as const, fromStepIndex: 3 },
    });
    // Step 3 (the jump target) succeeds.
    executeStepMock.mockResolvedValueOnce(passingResult(3, 'step three'));

    const config = makeConfig();
    const report = await runTest(
      makeInstance(['step one', 'step two', 'step three']),
      config,
      '',
    );

    // executeStep called twice: once for step 1, once for step 3.
    // Step 2 was skipped because of the resume.
    expect(executeStepMock).toHaveBeenCalledTimes(2);
    const firstCallStepIndex = executeStepMock.mock.calls[0]![0];
    const secondCallStepIndex = executeStepMock.mock.calls[1]![0];
    expect(firstCallStepIndex).toBe(1);
    expect(secondCallStepIndex).toBe(3);
    expect(runInteractiveReplMock).not.toHaveBeenCalled();
    expect(report.humanIntervened).toBe(true);
  });

  it('runnerControl.exit with adHocResults appends the ad-hoc rows after the parent step in the report', async () => {
    const adHoc: StepResult = {
      index: 99,
      instruction: 'click Save',
      status: 'passed',
      turns: [],
      durationMs: 1,
      retried: false,
      interactiveAdHoc: true,
    };
    executeStepMock.mockResolvedValueOnce({
      index: 1,
      instruction: 'step one',
      status: 'failed',
      turns: [],
      durationMs: 5,
      retried: false,
      error: 'user exited from clarification REPL',
      runnerControl: { kind: 'exit' as const, adHocResults: [adHoc] },
    });

    const report = await runTest(makeInstance(['step one']), makeConfig(), '');

    // Two rows: the parent (failed) + the adHoc (passed).
    expect(report.steps).toHaveLength(2);
    expect(report.steps[0]!.instruction).toBe('step one');
    expect(report.steps[1]!.instruction).toBe('click Save');
    expect(report.steps[1]!.interactiveAdHoc).toBe(true);
  });

  it('runnerControl.resume with adHocResults appends them between the parent and the jump target', async () => {
    const adHoc: StepResult = {
      index: 88,
      instruction: 'check banner',
      status: 'passed',
      turns: [],
      durationMs: 1,
      retried: false,
      interactiveAdHoc: true,
    };
    executeStepMock.mockResolvedValueOnce({
      index: 1,
      instruction: 'step one',
      status: 'passed',
      turns: [],
      durationMs: 5,
      retried: false,
      interactiveResumed: true,
      runnerControl: { kind: 'resume' as const, fromStepIndex: 2, adHocResults: [adHoc] },
    });
    executeStepMock.mockResolvedValueOnce(passingResult(2, 'step two'));

    const report = await runTest(makeInstance(['step one', 'step two']), makeConfig(), '');

    // Three rows: parent + adHoc + jumped-to step.
    expect(report.steps).toHaveLength(3);
    expect(report.steps[0]!.instruction).toBe('step one');
    expect(report.steps[1]!.instruction).toBe('check banner');
    expect(report.steps[2]!.instruction).toBe('step two');
  });
});

// ─── Captured `as` values reach the CLI-generated report (issues 042/043) ──
//
// The server path (session-manager.ts) already auto-surfaces a read/count
// action's `as` capture into both the MCP response and the HTML report.
// This mirrors that fix for `steptix run`, whose step loop is otherwise
// unrelated to session-manager.ts (shares only the `executeStep` executor).

describe('test-runner — captured `as` values reach the report', () => {
  beforeEach(() => {
    executeStepMock.mockReset();
    executeBranchedStepMock.mockReset();
    runInteractiveReplMock.mockReset();
    launchBrowserMock.mockReset();
    closeBrowserMock.mockReset();
    resolveHooksMock.mockReset();
    diagnoseFailureMock.mockReset();

    launchBrowserMock.mockResolvedValue(makeSession());
    closeBrowserMock.mockResolvedValue(undefined);
    resolveHooksMock.mockResolvedValue({
      before: [], beforeEach: [], afterEach: [], after: [], hasAny: false,
    });
    diagnoseFailureMock.mockResolvedValue(null);
  });

  it('threads a captured `as` value (no [output:] prefix) into report.steps[i].outputs', async () => {
    executeStepMock.mockImplementationOnce(async (_idx, _total, _instruction, opts) => {
      opts.resolvedParameters['total_available'] = '37.76';
      return {
        index: 1,
        instruction: 'Extract the total available in $ amount',
        status: 'passed',
        turns: [{
          turnNumber: 1,
          attemptNumber: 1,
          timestamp: new Date().toISOString(),
          aiInteractions: [],
          subActions: [{
            index: 1,
            action: { action: 'read', selector: '#total', as: 'total_available', description: 'Extract the total available' },
            durationMs: 10,
          }],
        }],
        durationMs: 50,
        retried: false,
      };
    });

    const report = await runTest(makeInstance(['Extract the total available in $ amount']), makeConfig(), '');

    expect(report.steps[0]!.outputs).toEqual({ total_available: '37.76' });
  });

  it('omits outputs entirely when nothing was captured', async () => {
    executeStepMock.mockResolvedValueOnce(passingResult(1, 'Click the login button'));

    const report = await runTest(makeInstance(['Click the login button']), makeConfig(), '');

    expect(report.steps[0]!.outputs).toBeUndefined();
  });

  it('never surfaces a __skill*-namespaced `as` capture', async () => {
    executeStepMock.mockImplementationOnce(async (_idx, _total, _instruction, opts) => {
      opts.resolvedParameters['__skill1_total'] = '37.76';
      return {
        index: 1,
        instruction: 'Read the total',
        status: 'passed',
        turns: [{
          turnNumber: 1,
          attemptNumber: 1,
          timestamp: new Date().toISOString(),
          aiInteractions: [],
          subActions: [{
            index: 1,
            action: { action: 'read', selector: '#total', as: '__skill1_total', description: 'internal skill capture' },
            durationMs: 10,
          }],
        }],
        durationMs: 50,
        retried: false,
      };
    });

    const report = await runTest(makeInstance(['Read the total']), makeConfig(), '');

    expect(report.steps[0]!.outputs).toBeUndefined();
  });

  it('does not surface a stale value when this step\'s `as` action failed', async () => {
    executeStepMock.mockImplementationOnce(async (_idx, _total, _instruction, opts) => {
      opts.resolvedParameters['orderId'] = 'ORD-1';
      return {
        index: 1,
        instruction: 'Get the order ID',
        status: 'passed',
        turns: [{
          turnNumber: 1,
          attemptNumber: 1,
          timestamp: new Date().toISOString(),
          aiInteractions: [],
          subActions: [{
            index: 1,
            action: { action: 'read', selector: '#order', as: 'orderId', description: 'Get the order ID' },
            durationMs: 10,
          }],
        }],
        durationMs: 50,
        retried: false,
      };
    });
    // Step 2 reuses the same `as` name but its action fails — resolvedParameters
    // still holds step 1's value (never cleared), but step 2 must not re-surface it.
    executeStepMock.mockResolvedValueOnce({
      index: 2,
      instruction: 'Get the order ID again',
      status: 'passed',
      turns: [{
        turnNumber: 1,
        attemptNumber: 1,
        timestamp: new Date().toISOString(),
        aiInteractions: [],
        subActions: [{
          index: 1,
          action: { action: 'read', selector: '#order-2', as: 'orderId', description: 'Get the order ID again' },
          durationMs: 10,
          error: 'read pattern matched nothing',
        }],
      }],
      durationMs: 50,
      retried: false,
    });

    const report = await runTest(
      makeInstance(['Get the order ID', 'Get the order ID again']),
      makeConfig(),
      '',
    );

    expect(report.steps[0]!.outputs).toEqual({ orderId: 'ORD-1' });
    expect(report.steps[1]!.outputs).toBeUndefined();
  });

  it('still surfaces an explicit [output: X] capture', async () => {
    executeStepMock.mockImplementationOnce(async (_idx, _total, instruction, opts) => {
      // parseOutputStep rewrites `[output: orderId] ...` to `... [store as: orderId]`.
      expect(instruction).toContain('[store as: orderId]');
      opts.resolvedParameters['orderId'] = 'ORD-9';
      return {
        index: 1,
        instruction,
        status: 'passed',
        turns: [{
          turnNumber: 1,
          attemptNumber: 1,
          timestamp: new Date().toISOString(),
          aiInteractions: [],
          subActions: [{
            index: 1,
            action: { action: 'read', selector: '#order', as: 'orderId', description: 'Get the order ID' },
            durationMs: 10,
          }],
        }],
        durationMs: 50,
        retried: false,
      };
    });

    const report = await runTest(makeInstance(['[output: orderId] Get the order ID']), makeConfig(), '');

    expect(report.steps[0]!.outputs).toEqual({ orderId: 'ORD-9' });
  });

  it('does not surface an `as` value from a non-read/count action (e.g. openPage tab label)', async () => {
    // openPage reuses the same `as` field for a tab label, never writes
    // resolvedParameters for it — but if this ever changed, or if the kind
    // filter regressed, a colliding name should still not surface.
    executeStepMock.mockImplementationOnce(async (_idx, _total, _instruction, opts) => {
      opts.resolvedParameters['reportTab'] = 'some tab label';
      return {
        index: 1,
        instruction: 'Open the report in a new tab',
        status: 'passed',
        turns: [{
          turnNumber: 1,
          attemptNumber: 1,
          timestamp: new Date().toISOString(),
          aiInteractions: [],
          subActions: [{
            index: 1,
            action: { action: 'openPage', url: 'https://example.com/report', as: 'reportTab', description: 'Open report tab' },
            durationMs: 10,
          }],
        }],
        durationMs: 50,
        retried: false,
      };
    });

    const report = await runTest(makeInstance(['Open the report in a new tab']), makeConfig(), '');

    expect(report.steps[0]!.outputs).toBeUndefined();
  });

  it('threads a capture into the parent row when a planned [interactive] step resumes (review finding)', async () => {
    // The [interactive] + resume branch pushes directly and `continue`s,
    // bypassing the common tail — a distinct code path from the other
    // capture tests above, which all exercise the common tail.
    runInteractiveReplMock.mockImplementationOnce(async (opts) => {
      opts.executorOptions.resolvedParameters['debugValue'] = '42';
      opts.adHocResults.push({
        index: 1,
        instruction: 'read the debug value',
        status: 'passed',
        turns: [{
          turnNumber: 1,
          attemptNumber: 1,
          timestamp: new Date().toISOString(),
          aiInteractions: [],
          subActions: [{
            index: 1,
            action: { action: 'read', selector: '#debug', as: 'debugValue', description: 'read the debug value' },
            durationMs: 10,
          }],
        }],
        durationMs: 20,
        retried: false,
      });
      return { kind: 'resume', fromStepIndex: 2 };
    });
    executeStepMock.mockResolvedValueOnce(passingResult(2, 'step two'));

    const report = await runTest(
      makeInstance(['[interactive] debug this', 'step two']),
      makeConfig(),
      '',
    );

    // Parent row (the "Interactive mode: ..." banner) aggregates the
    // child's capture — this is the row the bug dropped `outputs` from.
    expect(report.steps[0]!.outputs).toEqual({ debugValue: '42' });
    // The child row itself also carries its own capture (per-entry
    // attribution, not just the parent aggregate).
    expect(report.steps[1]!.outputs).toEqual({ debugValue: '42' });
  });
});

describe('test-runner — stopAfterStep runs a prefix as a passed run', () => {
  beforeEach(() => {
    executeStepMock.mockReset();
    executeBranchedStepMock.mockReset();
    runInteractiveReplMock.mockReset();
    launchBrowserMock.mockReset();
    closeBrowserMock.mockReset();
    resolveHooksMock.mockReset();
    diagnoseFailureMock.mockReset();

    launchBrowserMock.mockResolvedValue(makeSession());
    closeBrowserMock.mockResolvedValue(undefined);
    resolveHooksMock.mockResolvedValue({
      before: [], beforeEach: [], afterEach: [], after: [], hasAny: false,
    });
    diagnoseFailureMock.mockResolvedValue(null);
  });

  it('executes the first N steps only, and does not read the short run as a timeout', async () => {
    // A prefix compile's replay (stories/codebehind-compile-as-a-run.md) runs
    // the steps it compiled and not the ones the recording never reached.
    // Without the knob the runner would read "fewer results than steps" as a
    // timeout and fail the run.
    executeStepMock.mockImplementation(async (index: number, _total: number, instruction: string) =>
      passingResult(index, instruction),
    );

    const report = await runTest(
      makeInstance(['step one', 'step two', 'step three']),
      makeConfig(),
      '',
      { stopAfterStep: 2 },
    );

    expect(executeStepMock).toHaveBeenCalledTimes(2);
    expect(report.status).toBe('passed');
    expect(report.steps.map((s) => s.index)).toEqual([1, 2]);
    // The report still describes the whole test, so a caller indexing by
    // expanded step sees the third slot empty rather than shifted.
    expect(report.totalSteps).toBe(3);
  });
});

describe('test-runner — the recording', () => {
  beforeEach(() => {
    executeStepMock.mockReset();
    executeBranchedStepMock.mockReset();
    runInteractiveReplMock.mockReset();
    launchBrowserMock.mockReset();
    closeBrowserMock.mockReset();
    resolveHooksMock.mockReset();
    diagnoseFailureMock.mockReset();

    launchBrowserMock.mockResolvedValue(makeSession());
    closeBrowserMock.mockResolvedValue(undefined);
    resolveHooksMock.mockResolvedValue({
      before: [], beforeEach: [], afterEach: [], after: [], hasAny: false,
    });
    diagnoseFailureMock.mockResolvedValue(null);
  });

  it('writes the recording beside the test when captureStepContext is on, and nothing otherwise', async () => {
    // stories/codebehind-recording-on-disk.md: the run that was asked to
    // capture — a compile's Record — leaves its recording beside the test.
    const os = await import('node:os');
    const fsp = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const { recordingDirFor } = await import('../src/codebehind/recording.js');
    const dir = await fsp.mkdtemp(pathMod.join(os.tmpdir(), 'steptix-recording-'));
    const testPath = pathMod.join(dir, 'fake-test.md');
    const instance = makeInstance(['step one', 'step two']);
    instance.test = { ...instance.test, filePath: testPath };
    executeStepMock.mockImplementation(async (index: number, _total: number, instruction: string) => ({
      ...passingResult(index, instruction),
      stepContext: { domBefore: `<before ${index}>`, domAfter: `<after ${index}>`, urlBefore: 'u', urlAfter: 'u' },
    }));

    await runTest(instance, makeConfig(), '');
    await expect(fsp.access(recordingDirFor(testPath))).rejects.toThrow();

    await runTest(instance, makeConfig(), '', { captureStepContext: true });
    const files = (await fsp.readdir(recordingDirFor(testPath))).sort();
    expect(files).toEqual([
      'recording.json', 'step-01.after.html', 'step-01.before.html', 'step-01.json',
      'step-02.after.html', 'step-02.before.html', 'step-02.json',
    ]);
    const manifest = JSON.parse(await fsp.readFile(pathMod.join(recordingDirFor(testPath), 'recording.json'), 'utf-8'));
    expect(manifest).toMatchObject({ status: 'passed', steps: 2, source: 'cli' });
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe('test-runner — a strict run whose code-behind did not load', () => {
  beforeEach(() => {
    executeStepMock.mockReset();
    executeBranchedStepMock.mockReset();
    runInteractiveReplMock.mockReset();
    launchBrowserMock.mockReset();
    closeBrowserMock.mockReset();
    resolveHooksMock.mockReset();
    diagnoseFailureMock.mockReset();

    launchBrowserMock.mockResolvedValue(makeSession());
    closeBrowserMock.mockResolvedValue(undefined);
    resolveHooksMock.mockResolvedValue({
      before: [], beforeEach: [], afterEach: [], after: [], hasAny: false,
    });
    diagnoseFailureMock.mockResolvedValue(null);
  });

  it('fails before the first step and says which file, instead of passing under AI', async () => {
    // A compile's replay asks "does this code work on its own"; a file that
    // never loaded has no code to run. Caught live: a project without
    // node_modules replayed "4/4 as code" under AI and the compile went green.
    const os = await import('node:os');
    const fsp = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const { parseTestFile } = await import('../src/parser/markdown.js');
    const dir = await fsp.mkdtemp(pathMod.join(os.tmpdir(), 'steptix-strict-'));
    const md = pathMod.join(dir, 'booking.md');
    await fsp.writeFile(md, ['# Booking', '', '## Steps', '1. step one', '2. step two'].join('\n'));
    const stepsFile = pathMod.join(dir, 'booking.steps.ts');
    await fsp.writeFile(stepsFile, `import { defineSteps } from 'steptix/codebehind';
export default defineSteps([{ source: 'step one', async run() { const x = ; } }]);
`);
    const parsed = await parseTestFile(md);
    executeStepMock.mockImplementation(async (index: number, _total: number, instruction: string) =>
      passingResult(index, instruction),
    );

    // Not strict: the file is a warning, the steps run under AI, the run passes.
    const lenient = await runTest({ test: parsed, resolvedParameters: {} }, makeConfig(), '');
    expect(lenient.status).toBe('passed');
    expect(executeStepMock).toHaveBeenCalledTimes(2);

    executeStepMock.mockClear();
    const strict = await runTest({ test: parsed, resolvedParameters: {} }, makeConfig(), '', {
      codeBehindStrict: true,
    });
    expect(strict.status).toBe('failed');
    expect(strict.error).toContain('could not be loaded');
    expect(strict.error).toContain('booking.steps.ts');
    expect(executeStepMock).not.toHaveBeenCalled();
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe('test-runner — the env/data context reaches the step', () => {
  beforeEach(() => {
    executeStepMock.mockReset();
    executeBranchedStepMock.mockReset();
    runInteractiveReplMock.mockReset();
    launchBrowserMock.mockReset();
    closeBrowserMock.mockReset();
    resolveHooksMock.mockReset();
    diagnoseFailureMock.mockReset();

    launchBrowserMock.mockResolvedValue(makeSession());
    closeBrowserMock.mockResolvedValue(undefined);
    resolveHooksMock.mockResolvedValue({
      before: [], beforeEach: [], afterEach: [], after: [], hasAny: false,
    });
    diagnoseFailureMock.mockResolvedValue(null);
  });

  it('passes the parsed test\'s context to every step, and nothing when the parse had none', async () => {
    // `step.getVar('data.url')` in a code-behind entry reads this
    // (stories/codebehind-env-data.md). The CLI run and the compile's own
    // runs both come through here, so this is the one place to lose it.
    const os = await import('node:os');
    const fsp = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const { parseTestFile } = await import('../src/parser/markdown.js');
    const dir = await fsp.mkdtemp(pathMod.join(os.tmpdir(), 'steptix-envdata-'));
    const md = pathMod.join(dir, 'login.md');
    await fsp.writeFile(md, ['# Login', '', '## Steps', '1. Navigate to ${data.url}', '2. Click Sign in'].join('\n'));
    executeStepMock.mockImplementation(async (index: number, _total: number, instruction: string) =>
      passingResult(index, instruction),
    );

    const withEnv = await parseTestFile(md, {
      envData: { env: { GITHUB_USERNAME: 'octocat' }, data: { url: 'https://uat.example/' }, envName: 'uat' },
    });
    const report = await runTest({ test: withEnv, resolvedParameters: {} }, makeConfig(), '');
    expect(report.status).toBe('passed');
    expect(executeStepMock).toHaveBeenCalledTimes(2);
    for (const call of executeStepMock.mock.calls) {
      const opts = call[3];
      expect(opts.envData).toBe(withEnv.envData);
      expect(opts.envData.data.url).toBe('https://uat.example/');
    }
    // The step text the executor runs is the interpolated one, as before.
    expect(executeStepMock.mock.calls[0]![2]).toBe('Navigate to https://uat.example/');

    executeStepMock.mockClear();
    const withoutEnv = await parseTestFile(md);
    await runTest({ test: withoutEnv, resolvedParameters: {} }, makeConfig(), '');
    for (const call of executeStepMock.mock.calls) {
      expect(call[3].envData).toBeUndefined();
    }
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe('test-runner — secrets stay out of what the run writes (stories/secret-redaction.md)', () => {
  beforeEach(() => {
    executeStepMock.mockReset();
    executeBranchedStepMock.mockReset();
    runInteractiveReplMock.mockReset();
    launchBrowserMock.mockReset();
    closeBrowserMock.mockReset();
    resolveHooksMock.mockReset();
    diagnoseFailureMock.mockReset();

    launchBrowserMock.mockResolvedValue(makeSession());
    closeBrowserMock.mockResolvedValue(undefined);
    resolveHooksMock.mockResolvedValue({
      before: [], beforeEach: [], afterEach: [], after: [], hasAny: false,
    });
    diagnoseFailureMock.mockResolvedValue(null);
  });

  it('masks the password on the console step line and throughout the returned report, while the step runs with the real value', async () => {
    const { logger } = await import('../src/utils/logger.js');
    const stepLine = vi.spyOn(logger, 'step').mockImplementation(() => {});
    executeStepMock.mockImplementation(async (index: number, _total: number, instruction: string) => ({
      index,
      instruction,
      status: 'passed',
      durationMs: 1,
      retried: false,
      turns: [{
        turnNumber: 1,
        attemptNumber: 1,
        timestamp: 't',
        aiInteractions: [{
          purpose: 'step',
          requestMessages: [{ role: 'user', content: `## Current Step\n${instruction}` }],
          response: '{"actions":[{"type":"type","selector":"#p","value":"hunter2!x"}]}',
        }],
        subActions: [
          { index: 0, action: { type: 'type', selector: '#p', value: 'hunter2!x' }, durationMs: 1 },
          { index: 1, action: { type: 'press', key: 'Enter' }, durationMs: 1 },
        ],
      }],
      screenshotBase64: 'AAAAhunter2!xAAAA',
      aiExplanation: `Did: ${instruction}`,
    }));

    try {
      const instance: TestInstance = {
        test: makeTest(['Enter the username {{username}}', 'Enter the password {{password}}']),
        resolvedParameters: { username: 'octocat', password: 'hunter2!x' },
      };
      const report = await runTest(instance, makeConfig(), '');

      // The executor got the resolved text.
      expect(executeStepMock.mock.calls.map((c) => c[2])).toEqual([
        'Enter the username octocat',
        'Enter the password hunter2!x',
      ]);
      // The console line did not print the secret; the username is not one.
      expect(stepLine.mock.calls.map((c) => c[2])).toEqual([
        'Enter the username octocat',
        'Enter the password ***',
      ]);
      // The report — what `steptix run` renders, summarises and appends to the
      // test file — carries it nowhere but the screenshot bytes.
      expect(report.status).toBe('passed');
      expect(report.parameters).toEqual({ username: 'octocat', password: '***' });
      const step = report.steps[1]!;
      expect(step.instruction).toBe('Enter the password ***');
      expect(step.aiExplanation).toBe('Did: Enter the password ***');
      const turn = step.turns[0]!;
      expect(turn.aiInteractions[0]!.requestMessages![0]!.content).toBe('## Current Step\nEnter the password ***');
      expect(turn.aiInteractions[0]!.response).toBe('{"actions":[{"type":"type","selector":"#p","value":"***"}]}');
      expect(turn.subActions[0]!.action).toEqual({ type: 'type', selector: '#p', value: '***' });
      expect(turn.subActions[1]!.action).toEqual({ type: 'press', key: 'Enter' });
      expect(step.screenshotBase64).toBe('AAAAhunter2!xAAAA');
      const text = JSON.stringify({ ...report, steps: report.steps.map((s) => ({ ...s, screenshotBase64: '' })) });
      expect(text).not.toContain('hunter2!x');
    } finally {
      stepLine.mockRestore();
    }
  });

  it('masks the failure diagnosis too — it reads the live page, where the typed value can still sit', async () => {
    const { logger } = await import('../src/utils/logger.js');
    const stepLine = vi.spyOn(logger, 'step').mockImplementation(() => {});
    executeStepMock.mockImplementation(async (index: number, _total: number, instruction: string) => ({
      index, instruction, status: 'failed', durationMs: 1, retried: false, turns: [],
      error: 'Could not submit after typing hunter2!x',
    }));
    diagnoseFailureMock.mockResolvedValue({
      faultCategory: 'app',
      confidence: 'high',
      rootCause: 'The form rejected hunter2!x as too short',
      suggestedFix: 'Use a longer password than hunter2!x',
    });
    const config = makeConfig();
    // `apiKey` as well as the flag: a run with no key skips the diagnosis pass
    // outright (stories/keyless-replay-and-gateway-env.md §Part B), and
    // `DEFAULT_CONFIG` carries none — so without this there is no diagnosis
    // left to mask.
    config.ai = { ...config.ai, diagnoseFailures: true, apiKey: 'test-key' };

    try {
      const report = await runTest(
        { test: makeTest(['Enter the password {{password}}']), resolvedParameters: { password: 'hunter2!x' } },
        config,
        '',
      );
      expect(report.status).toBe('failed');
      expect(report.steps[0]!.error).toBe('Could not submit after typing ***');
      expect(report.diagnosis?.rootCause).toBe('The form rejected *** as too short');
      expect(report.diagnosis?.suggestedFix).toBe('Use a longer password than ***');
      expect(JSON.stringify(report)).not.toContain('hunter2!x');
    } finally {
      stepLine.mockRestore();
    }
  });
});

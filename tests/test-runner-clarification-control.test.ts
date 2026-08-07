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
  BrowserTracker: class {
    private session: unknown;
    constructor(initial: unknown) { this.session = initial; }
    getActive() { return this.session; }
    getActivePage() { return (this.session as { page: unknown }).page; }
    has() { return false; }
    add() {}
    switchTo() { return this.session; }
    async close() {}
    async closeAll() { closeBrowserMock(this.session); }
    list() { return []; }
    get count() { return 1; }
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

const stepCacheInitMock = vi.fn();
// Spread the real module so the pure path helpers (envCacheSegment,
// cacheDirName) the runner now imports stay real; only StepCache.initialize
// is replaced with the spy this suite asserts on.
vi.mock('../src/cache/step-cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/cache/step-cache.js')>()),
  StepCache: {
    initialize: (...args: unknown[]) => stepCacheInitMock(...args),
  },
}));

const diagnoseFailureMock = vi.fn();
vi.mock('../src/ai/diagnose.js', () => ({
  diagnoseFailure: (...args: unknown[]) => diagnoseFailureMock(...args),
}));

vi.mock('../src/ai/client.js', () => ({
  AiClient: class { syncAuth = vi.fn(() => null); },
}));

vi.mock('../src/utils/run-log.js', () => ({
  openRunLogFile: () => null,
  attachRunLogBridges: () => () => {},
}));

vi.mock('../src/report/generator.js', () => ({
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
  beforeEach(() => {
    // Reset only the executeStep / runInteractiveRepl mocks — clearing
    // queued mockResolvedValueOnce responses between tests so they don't
    // leak. The persistent mocks (browser, hooks, cache, etc.) are
    // re-established below.
    executeStepMock.mockReset();
    executeBranchedStepMock.mockReset();
    runInteractiveReplMock.mockReset();
    launchBrowserMock.mockReset();
    closeBrowserMock.mockReset();
    resolveHooksMock.mockReset();
    stepCacheInitMock.mockReset();
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
    stepCacheInitMock.mockResolvedValue({
      read: () => null,
      write: vi.fn(),
      readAssertion: () => null,
      invalidateStep: vi.fn(),
    });
    diagnoseFailureMock.mockResolvedValue(null);

    // Default: stdout.isTTY treated as true so the failure-REPL path COULD
    // engage if the guard didn't fire. We force this for the re-entry test.
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
// This mirrors that fix for `aiui run`, whose step loop is otherwise
// unrelated to session-manager.ts (shares only the `executeStep` executor).

describe('test-runner — captured `as` values reach the report', () => {
  beforeEach(() => {
    executeStepMock.mockReset();
    executeBranchedStepMock.mockReset();
    runInteractiveReplMock.mockReset();
    launchBrowserMock.mockReset();
    closeBrowserMock.mockReset();
    resolveHooksMock.mockReset();
    stepCacheInitMock.mockReset();
    diagnoseFailureMock.mockReset();

    launchBrowserMock.mockResolvedValue(makeSession());
    closeBrowserMock.mockResolvedValue(undefined);
    resolveHooksMock.mockResolvedValue({
      before: [], beforeEach: [], afterEach: [], after: [], hasAny: false,
    });
    stepCacheInitMock.mockResolvedValue({
      read: () => null, write: vi.fn(), readAssertion: () => null, invalidateStep: vi.fn(),
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

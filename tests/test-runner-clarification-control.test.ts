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
vi.mock('../src/cache/step-cache.js', () => ({
  StepCache: {
    initialize: (...args: unknown[]) => stepCacheInitMock(...args),
  },
  fingerprintAssertion: () => 'fp',
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

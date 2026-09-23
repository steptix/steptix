/**
 * The CLI runner's half of SPEC-use-computer.md §4.6: the browser opens at the
 * first step that runs while the surface is `browser`, not at the top of
 * `runTest`.
 *
 * The rule is invisible in the output of a normal run — the same browser opens,
 * a few milliseconds later — so it has to be asserted on the CALL, not on the
 * result. `launchBrowser` is mocked and counted, and the executor is made to
 * report when it ran relative to it.
 *
 * Mock surface copied from cli-viewport.test.ts, which copied it from
 * test-runner-clarification-control.test.ts: the dependency wall `runTest`
 * needs to run with no browser and no AI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../src/config/types.js';
import type { ParsedTest, TestConfig, TestInstance } from '../src/parser/types.js';
import type { StepResult } from '../src/report/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

const launchBrowserMock = vi.fn();
const closeBrowserMock = vi.fn();
/** Every tracker the runner built, so a test can ask whether it ever launched. */
const trackers: any[] = [];

vi.mock('../src/browser/manager.js', () => ({
  launchBrowser: (...args: unknown[]) => launchBrowserMock(...args),
  closeBrowser: (...args: unknown[]) => closeBrowserMock(...args),
  resolveVideoMode: () => 'off',
  finalizeMainPageVideo: async (args: { closeContext: () => Promise<void> }) => {
    await args.closeContext();
    return undefined;
  },
  NoBrowserLaunchedError: class NoBrowserLaunchedError extends Error {
    constructor(message = 'no browser has been launched in this session') {
      super(message);
      this.name = 'NoBrowserLaunchedError';
    }
  },
  NO_BROWSER_LAUNCHED_MESSAGE: 'no browser has been launched in this session',
  // Modelled, not stubbed. A tracker that hands back a browser regardless is a
  // tracker that would let the runner skip `ensureLaunched()` entirely with
  // every assertion here still green.
  BrowserTracker: class BrowserTrackerStub {
    session: unknown;
    launch: (() => Promise<unknown>) | undefined;
    constructor(initial: unknown) {
      this.session = initial;
      trackers.push(this);
    }
    static deferred(launch: () => Promise<unknown>) {
      const tracker = new BrowserTrackerStub(undefined);
      tracker.launch = launch;
      return tracker;
    }
    async ensureLaunched() {
      if (this.session === undefined) this.session = await this.launch!();
      return this.session;
    }
    hasActive() { return this.session !== undefined; }
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
  },
}));

const executeStepMock = vi.fn();
vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: (...args: unknown[]) => executeStepMock(...args),
  executeBranchedStep: vi.fn(),
}));

const resolveHooksMock = vi.fn();
vi.mock('../src/runner/hooks.js', () => ({
  resolveHooks: (...args: unknown[]) => resolveHooksMock(...args),
}));

vi.mock('../src/cache/step-cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/cache/step-cache.js')>()),
  StepCache: {
    initialize: async () => ({
      read: () => null,
      write: vi.fn(),
      readAssertion: () => null,
      invalidateStep: vi.fn(),
    }),
  },
}));

vi.mock('../src/ai/diagnose.js', () => ({
  diagnoseFailure: vi.fn(async () => null),
}));

vi.mock('../src/ai/client.js', () => ({
  AiClient: class { setAiPolicy = vi.fn(); syncAuth = vi.fn(() => null); },
}));

vi.mock('../src/utils/run-log.js', () => ({
  openRunLogFile: () => null,
  attachRunLogBridges: () => () => {},
}));

vi.mock('../src/report/generator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/report/generator.js')>()),
  generateReport: vi.fn().mockResolvedValue(''),
  getPrimaryModel: () => undefined,
  buildReportBaseName: (report: { testName: string }) => report.testName,
}));

vi.mock('../src/report/history-appender.js', () => ({
  appendRunHistory: vi.fn().mockResolvedValue(undefined),
}));

import { runTest } from '../src/runner/test-runner.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSession(): { page: { url: () => string; goto: ReturnType<typeof vi.fn> } } {
  return {
    page: { url: () => 'https://example.com/page', goto: vi.fn().mockResolvedValue(undefined) },
  };
}

function makeInstance(steps: string[], config: TestConfig = {}): TestInstance {
  const test: ParsedTest = {
    filePath: '/tmp/lazy-launch-test.md',
    title: 'lazy launch test',
    frontmatter: { tags: [] },
    config,
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
  return { test, resolvedParameters: {} };
}

function makeConfig(): Config {
  return {
    ...DEFAULT_CONFIG,
    browser: { ...DEFAULT_CONFIG.browser, headed: false },
    execution: { ...DEFAULT_CONFIG.execution, interactiveOnFailure: false },
    ai: { ...DEFAULT_CONFIG.ai, diagnoseFailures: false },
    logging: { ...DEFAULT_CONFIG.logging, consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
  };
}

function passingResult(instruction: string): StepResult {
  return { index: 1, instruction, status: 'passed', turns: [], durationMs: 1, retried: false };
}

beforeEach(() => {
  launchBrowserMock.mockReset();
  closeBrowserMock.mockReset();
  executeStepMock.mockReset();
  resolveHooksMock.mockReset();
  trackers.length = 0;

  launchBrowserMock.mockResolvedValue(makeSession());
  closeBrowserMock.mockResolvedValue(undefined);
  executeStepMock.mockImplementation(async (_i: number, _n: number, instruction: string) =>
    passingResult(instruction),
  );
  resolveHooksMock.mockResolvedValue({
    before: [], beforeEach: [], afterEach: [], after: [], hasAny: false,
  });
});

describe('runTest launches the browser at the first step, not at startup', () => {
  it('launches exactly once for a multi-step test', async () => {
    await runTest(makeInstance(['open the app', 'click the button']), makeConfig(), '');

    expect(launchBrowserMock).toHaveBeenCalledTimes(1);
  });

  // The ordering assertion: the launch must already have happened when the
  // first step runs, and must NOT have happened before `runTest` reaches the
  // loop. Recorded as a sequence rather than two counts, because two counts
  // taken at the end cannot tell the two orders apart.
  it('launches before the first step and after everything else', async () => {
    const order: string[] = [];
    launchBrowserMock.mockImplementation(async () => {
      order.push('launch');
      return makeSession();
    });
    executeStepMock.mockImplementation(async (_i: number, _n: number, instruction: string) => {
      order.push(`step:${instruction}`);
      return passingResult(instruction);
    });

    await runTest(makeInstance(['first', 'second']), makeConfig(), '');

    expect(order).toEqual(['launch', 'step:first', 'step:second']);
  });

  it('launches nothing for a test with no steps at all', async () => {
    await runTest(makeInstance([]), makeConfig(), '');

    expect(launchBrowserMock).not.toHaveBeenCalled();
    expect(trackers[0].hasActive()).toBe(false);
  });

  // Teardown has to survive the no-browser case: `closeAll()` over an
  // unlaunched tracker is a no-op, and `finalizeMainPageVideo` is handed
  // `undefined` for its page.
  it('tears down cleanly when nothing ever launched', async () => {
    const report = await runTest(makeInstance([]), makeConfig(), '');

    expect(report).toBeDefined();
    expect(closeBrowserMock).not.toHaveBeenCalled();
  });
});

describe('base URL navigation moved to the launch', () => {
  it('navigates once, from inside the launch', async () => {
    const session = makeSession();
    launchBrowserMock.mockResolvedValue(session);

    await runTest(
      makeInstance(['click'], { baseUrl: 'https://example.test/start' }),
      makeConfig(),
      '',
    );

    expect(session.page.goto).toHaveBeenCalledTimes(1);
    expect(session.page.goto.mock.calls[0]![0]).toBe('https://example.test/start');
  });

  it('does not navigate when no step ever runs', async () => {
    const session = makeSession();
    launchBrowserMock.mockResolvedValue(session);

    await runTest(makeInstance([], { baseUrl: 'https://example.test/start' }), makeConfig(), '');

    expect(session.page.goto).not.toHaveBeenCalled();
  });

  // The teardown that used to wrap the navigation moved with it. Without it a
  // bad baseUrl leaves a browser window open with nothing tracking it.
  it('closes the browser it just opened when the navigation fails', async () => {
    const session = makeSession();
    session.page.goto.mockRejectedValue(new Error('net::ERR_NAME_NOT_RESOLVED'));
    launchBrowserMock.mockResolvedValue(session);

    const report = await runTest(makeInstance(['click'], { baseUrl: 'https://nope.invalid' }), makeConfig(), '');

    expect(closeBrowserMock).toHaveBeenCalledWith(session);
    expect(report.steps[0]!.status).toBe('failed');
    expect(report.steps[0]!.error).toContain('ERR_NAME_NOT_RESOLVED');
  });
});

describe('a failed launch is the first step failing', () => {
  it('records a failed step row rather than throwing out of runTest', async () => {
    launchBrowserMock.mockRejectedValue(new Error('chrome is not installed'));

    const report = await runTest(makeInstance(['click', 'type']), makeConfig(), '');

    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]!.status).toBe('failed');
    expect(report.steps[0]!.error).toContain('chrome is not installed');
    expect(executeStepMock).not.toHaveBeenCalled();
  });
});

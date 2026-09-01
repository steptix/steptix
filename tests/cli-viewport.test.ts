/**
 * The CLI runner's half of stories/per-test-viewport.md (§6/§10).
 *
 * Two seams, and both have to be asserted or the feature is half-wired:
 *
 *  1. `launchBrowser` gets the resolved size — the run's own browser.
 *  2. The `config` the STEP EXECUTOR is handed carries it too. That is what
 *     makes §2's "every browser the test opens inherits it" free: the mid-test
 *     `openBrowser` action relaunches from `config.browser`, so a secondary
 *     browser in a `viewport: mobile` test is mobile only if the executor's
 *     config is the amended one. Assert only seam 1 and that inheritance can
 *     break with every test still green.
 *
 * Mock surface copied from test-runner-clarification-control.test.ts — the same
 * dependency wall `runTest` needs to run with no browser and no AI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../src/config/types.js';
import type { ParsedTest, TestConfig, TestInstance } from '../src/parser/types.js';
import type { StepResult } from '../src/report/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

const launchBrowserMock = vi.fn();
const closeBrowserMock = vi.fn();
vi.mock('../src/browser/manager.js', () => ({
  launchBrowser: (...args: unknown[]) => launchBrowserMock(...args),
  closeBrowser: (...args: unknown[]) => closeBrowserMock(...args),
  resolveVideoMode: () => 'off',
  finalizeMainPageVideo: async (args: { closeContext: () => Promise<void> }) => {
    await args.closeContext();
    return undefined;
  },
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

// Spread the real module so the pure helpers stay real — the runner now counts
// healed steps through `countStepOrigins` when it assembles the report, and a
// factory that lists only the three stubbed names would leave it undefined.
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

const MOBILE = { width: 390, height: 844 };

function makeSession(): { page: { url: () => string; goto: ReturnType<typeof vi.fn> } } {
  return {
    page: { url: () => 'https://example.com/page', goto: vi.fn().mockResolvedValue(undefined) },
  };
}

function makeInstance(config: TestConfig): TestInstance {
  const steps = ['open the app'];
  const test: ParsedTest = {
    filePath: '/tmp/viewport-test.md',
    title: 'viewport test',
    frontmatter: { tags: [] },
    config,
    parameters: {},
    steps,
    stepLines: [1],
    skipHooks: [false],
    toolCalls: [null],
    sourceSkills: [null],
    sourceSections: [null],
    sections: {},
    rawSteps: [...steps],
    hooks: { before: [], beforeEach: [], afterEach: [], after: [] },
    hookToolCalls: { before: [], beforeEach: [], afterEach: [], after: [] },
    hookSourceSkills: { before: [], beforeEach: [], afterEach: [], after: [] },
  };
  return { test, resolvedParameters: {} };
}

/**
 * A config with NO `fixedViewport` — the "unchanged behaviour" assertions below
 * are only worth anything against a bare one (§10's minimum-scenario rule).
 */
function makeConfig(): Config {
  return {
    ...DEFAULT_CONFIG,
    browser: { ...DEFAULT_CONFIG.browser, headed: false },
    execution: { ...DEFAULT_CONFIG.execution, interactiveOnFailure: false },
    logging: { ...DEFAULT_CONFIG.logging, consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
  };
}

function passingResult(instruction: string): StepResult {
  return { index: 1, instruction, status: 'passed', turns: [], durationMs: 1, retried: false };
}

/** The `BrowserConfig` handed to `launchBrowser`. */
function launchedBrowserConfig(): Config['browser'] {
  expect(launchBrowserMock, 'launchBrowser was never called').toHaveBeenCalled();
  return launchBrowserMock.mock.calls[0]![0] as Config['browser'];
}

/** The whole `Config` the step executor was handed on its first call. */
function executorConfig(): Config {
  expect(executeStepMock, 'executeStep was never called').toHaveBeenCalled();
  return (executeStepMock.mock.calls[0]![3] as { config: Config }).config;
}

beforeEach(() => {
  launchBrowserMock.mockReset();
  closeBrowserMock.mockReset();
  executeStepMock.mockReset();
  resolveHooksMock.mockReset();

  launchBrowserMock.mockResolvedValue(makeSession());
  closeBrowserMock.mockResolvedValue(undefined);
  executeStepMock.mockResolvedValue(passingResult('open the app'));
  resolveHooksMock.mockResolvedValue({
    before: [], beforeEach: [], afterEach: [], after: [], hasAny: false,
  });
});

// ---------------------------------------------------------------------------
// §6 — the resolved size reaches both seams
// ---------------------------------------------------------------------------

describe('runTest honours ## Config: viewport', () => {
  it('launches with the resolved fixedViewport', async () => {
    await runTest(makeInstance({ viewport: 'mobile' }), makeConfig(), '');
    expect(launchedBrowserConfig().fixedViewport).toEqual(MOBILE);
  });

  it('resolves the explicit form too', async () => {
    await runTest(makeInstance({ viewport: '767X1024' }), makeConfig(), '');
    expect(launchedBrowserConfig().fixedViewport).toEqual({ width: 767, height: 1024 });
  });

  it('hands the SAME size to the executor, so openBrowser inherits it (§2)', async () => {
    await runTest(makeInstance({ viewport: 'mobile' }), makeConfig(), '');
    expect(executorConfig().browser.fixedViewport).toEqual(MOBILE);
  });

  it('names the source on the launch, for the §4 log line', async () => {
    await runTest(makeInstance({ viewport: 'mobile' }), makeConfig(), '');
    const overrides = launchBrowserMock.mock.calls[0]![2] as { viewportSource?: string };
    expect(overrides.viewportSource).toBe('mobile, from test config');
  });

  it("does not mutate the caller's config — the next test in the run is not mobile", async () => {
    // `runTest` is called once per data row with the SAME config object the
    // caller holds. Writing through would leak one row's viewport into every
    // row and test after it.
    const config = makeConfig();
    await runTest(makeInstance({ viewport: 'mobile' }), config, '');
    expect(config.browser.fixedViewport).toBeUndefined();
  });

  it('leaves the rest of the browser config alone', async () => {
    const config = makeConfig();
    await runTest(makeInstance({ viewport: 'mobile' }), config, '');

    const launched = launchedBrowserConfig();
    expect(launched.viewport).toEqual(config.browser.viewport);
    expect(launched.windowSize).toEqual(config.browser.windowSize);
    expect(launched.headed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// No key — byte-for-byte today's behaviour
// ---------------------------------------------------------------------------

describe('a test with no viewport key', () => {
  it('launches with no fixedViewport and no source label', async () => {
    await runTest(makeInstance({}), makeConfig(), '');

    expect(launchedBrowserConfig().fixedViewport).toBeUndefined();
    const overrides = launchBrowserMock.mock.calls[0]![2] as { viewportSource?: string };
    expect(overrides.viewportSource).toBeUndefined();
  });

  it('still carries a PROJECT-wide pin through, and names it as the project\'s (§8)', async () => {
    // `browser.fixedViewport` in aiui.config.json means every test in the
    // project. A test that says nothing must not clear it — the precedence is
    // test-over-project, not test-or-nothing.
    const config = makeConfig();
    config.browser = { ...config.browser, fixedViewport: { width: 360, height: 640 } };

    await runTest(makeInstance({}), config, '');

    expect(launchedBrowserConfig().fixedViewport).toEqual({ width: 360, height: 640 });
    const overrides = launchBrowserMock.mock.calls[0]![2] as { viewportSource?: string };
    expect(overrides.viewportSource).toBe('from project config');
  });

  it('lets the test override a project-wide pin (§1 precedence)', async () => {
    const config = makeConfig();
    config.browser = { ...config.browser, fixedViewport: { width: 360, height: 640 } };

    await runTest(makeInstance({ viewport: 'mobile' }), config, '');

    expect(launchedBrowserConfig().fixedViewport).toEqual(MOBILE);
  });
});

// ---------------------------------------------------------------------------
// Refusals — before the browser (§6)
// ---------------------------------------------------------------------------

describe('refusals happen before anything launches', () => {
  it('an unparseable value throws the §1 error and launches nothing', async () => {
    await expect(runTest(makeInstance({ viewport: '390' }), makeConfig(), '')).rejects.toThrow(
      "Invalid '## Config: viewport: 390'",
    );
    expect(launchBrowserMock).not.toHaveBeenCalled();
  });

  it('an out-of-range size is refused, naming it', async () => {
    await expect(runTest(makeInstance({ viewport: '50x50' }), makeConfig(), '')).rejects.toThrow(
      /50x50/,
    );
    expect(launchBrowserMock).not.toHaveBeenCalled();
  });

  it('viewport + cdp in one file is refused, naming both keys', async () => {
    const err = await runTest(makeInstance({ viewport: 'mobile', cdp: '9222' }), makeConfig(), '')
      .then(() => null, (e: unknown) => e as Error);

    expect(err?.message).toContain("'## Config: viewport: mobile'");
    expect(err?.message).toContain("'## Config: cdp: 9222'");
    expect(launchBrowserMock).not.toHaveBeenCalled();
  });

  it('cdp alone still attaches — the refusal is about the pairing', async () => {
    await runTest(makeInstance({ cdp: '9222' }), makeConfig(), '');
    expect(launchBrowserMock.mock.calls[0]![1]).toEqual({ port: 9222 });
  });
});

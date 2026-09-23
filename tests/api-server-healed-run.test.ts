/**
 * The run-complete payload names the steps that healed under AI
 * (stories/codebehind-selector-ambiguity.md §"A healed run stops reporting as
 * a clean pass").
 *
 * TestBench's closing summary line — "8 passed, 1 healed under AI (4.1k
 * tokens)" — is fed by the `done` event, so this covers the server half: the
 * count and the token cost ride the event when something healed, and nothing
 * new appears on a clean run. Display is the extension's business.
 *
 * Driven through `SessionManager.executeSteps` with an event collector rather
 * than over HTTP: `done` is emitted by the run, and the route only forwards
 * it. The browser, AI and step executor are mocked the same way the sibling
 * api-server suites mock them.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';

// ── Mocks (mirror api-server-stepmode.test.ts) ──────────────────────────────

const mockPage = {
  url: vi.fn(() => 'https://example.com'),
  title: vi.fn(async () => 'Example Page'),
  goto: vi.fn(async () => null),
};
const mockBrowserSession = {
  browser: { isConnected: vi.fn(() => true) },
  context: {},
  page: mockPage,
  pageTracker: { getActive: vi.fn(() => mockPage as never) },
};

vi.mock('../src/browser/manager.js', () => {
  class BrowserTracker {
    getActive: ReturnType<typeof vi.fn>;
    closeAll: ReturnType<typeof vi.fn>;
    hasActive: ReturnType<typeof vi.fn>;
    ensureLaunched: ReturnType<typeof vi.fn>;
    constructor(initialSession: typeof mockBrowserSession) {
      this.getActive = vi.fn(() => initialSession);
      this.closeAll = vi.fn(async () => {});
      this.hasActive = vi.fn(() => true);
      this.ensureLaunched = vi.fn(async () => initialSession);
    }
    /**
     * Lazy twin of the real static (SPEC-use-computer.md §4.6). Modelled, not
     * stubbed: nothing launches until ensureLaunched(), and it launches at
     * most once — so these suites exercise the same launch-at-first-step rule
     * the session manager now follows instead of hiding it behind a mock that
     * always has a browser.
     */
    static deferred(launch: () => Promise<any>): BrowserTracker {
      const tracker = new BrowserTracker(undefined as any);
      let launched: any;
      tracker.hasActive = vi.fn(() => launched !== undefined);
      tracker.getActive = vi.fn(() => {
        if (!launched) throw new Error('no browser has been launched in this session');
        return launched;
      });
      tracker.ensureLaunched = vi.fn(async () => {
        if (!launched) launched = await launch();
        return launched;
      });
      return tracker;
    }
  }
  return {
    launchBrowser: vi.fn(async () => ({ ...mockBrowserSession })),
    PageTracker: vi.fn(),
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
    BrowserTracker,
    briefly: async (p: Promise<unknown>, ms: number, fallback: unknown) =>
      Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]),
    resolveVideoMode: vi.fn(() => 'off'),
    finalizeMainPageVideo: vi.fn(async (args: { closeContext: () => Promise<void> }) => {
      await args.closeContext();
      return undefined;
    }),
  };
});

const executeStepMock = vi.fn();
vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: (...args: unknown[]) => executeStepMock(...args),
  executeBranchedStep: vi.fn(async () => []),
}));

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: vi.fn(async () => ({ files: [], combined: '' })),
}));

vi.mock('../src/ai/client.js', () => ({
  AiClient: class { chat = vi.fn(async () => '{}'); setAiPolicy = vi.fn(); syncAuth = vi.fn(() => null); },
}));

/**
 * A tracker whose running total the fake `executeStep` can move, so the token
 * attribution the server does — sample the run total either side of a step —
 * is actually exercised rather than reading 0 both times.
 */
let spentTokens = 0;
vi.mock('../src/utils/tokens.js', () => ({
  TokenTracker: class {
    addUsage = vi.fn();
    resetStep = vi.fn();
    markRunStart = vi.fn();
    checkStepBudget = vi.fn();
    get total() { return spentTokens; }
    get inputTotal() { return spentTokens; }
    get outputTotal() { return 0; }
    get runTotal() { return spentTokens; }
    get runInputTotal() { return spentTokens; }
    get runOutputTotal() { return 0; }
    getSummary() { return `Total: ${spentTokens}`; }
  },
}));

vi.mock('../src/api/response-store.js', () => ({
  ApiResponseStore: class { store = vi.fn(); getHistory = vi.fn(() => []); },
}));

vi.mock('../src/report/generator.js', () => ({
  generateReport: vi.fn(async () => '/tmp/fake-report.html'),
  getPrimaryModel: vi.fn(() => 'mock-model'),
  buildReportBaseName: vi.fn((report: { testName: string }) => report.testName),
}));

vi.mock('../src/browser/screenshot.js', () => ({
  captureScreenshot: vi.fn(async () => ({ base64: 'fakeBase64' })),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn(),
    step: vi.fn(), debug: vi.fn(), trace: vi.fn(),
  },
  addLogCallback: vi.fn(() => () => {}),
  addTraceCallback: vi.fn(() => () => {}),
  isVerbose: vi.fn(() => false),
  shouldEmit: vi.fn(() => true),
  setLogLevel: vi.fn(),
  getLogLevel: vi.fn(() => 'info'),
}));

import { createApiServer } from '../src/server/api-server.js';

const cfg: Config = {
  ai: { gatewayUrl: 'https://ai.test', model: 't', maxInputTokens: 1000, streamResponses: false, sendScreenshots: false },
  browser: { headed: false, viewport: { width: 1280, height: 720 }, windowSize: { width: 1280, height: 720 }, slowMo: 0, browser: 'chromium', fullPageScreenshots: true },
  tests: { dir: './tests', contextDir: './context', pattern: '**/*.md' },
  execution: { timeout: 30000, retries: 1, screenshotOnFailure: true, promptOnAmbiguity: false, maxTurns: 5 },
  reports: { outputDir: './reports', includeScreenshots: false, includeDomSnapshots: false, includeAiReasoning: false, embedScreenshots: false },
  api: { specsDir: './specs', requestTimeout: 30000, redactSensitive: true },
  server: { host: '127.0.0.1', port: 0, apiKey: 'sk-healed-test' },
  cache: { enabled: false, dir: '.cache' },
  logging: { consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
};

let sessionManager: import('../src/server/session-manager.js').SessionManager;

beforeAll(() => {
  sessionManager = createApiServer(cfg).sessionManager;
});

afterAll(async () => {
  await sessionManager.closeAll?.();
});

beforeEach(() => {
  executeStepMock.mockReset();
  spentTokens = 0;
});

function passed(index: number, instruction: string): StepResult {
  return {
    index, instruction, status: 'passed', turns: [], durationMs: 1,
    retried: false, aiExplanation: 'ok',
  };
}

function healed(index: number, instruction: string): StepResult {
  return {
    ...passed(index, instruction),
    codeBehindStale: {
      file: '/p/tests/checkout.steps.ts',
      source: instruction,
      error: 'locator resolved to 2 elements',
    },
  };
}

/** Run some steps and hand back every event the run emitted. */
async function run(steps: string[]): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  await sessionManager.executeSteps(
    `healed-${Math.random().toString(36).slice(2)}`,
    { steps, sourceLines: steps.map((_, i) => i + 1) },
    (e) => events.push(e as unknown as Record<string, unknown>),
  );
  return events;
}

describe('the run-complete payload', () => {
  it('carries the healed count and what those steps cost', async () => {
    executeStepMock.mockImplementationOnce(async () => passed(1, 'step one'));
    executeStepMock.mockImplementationOnce(async () => {
      spentTokens += 4100;
      return healed(2, 'step two');
    });
    // A plain AI step after it — its tokens are the run's, not the healing's.
    executeStepMock.mockImplementationOnce(async () => {
      spentTokens += 2000;
      return passed(3, 'step three');
    });

    const events = await run(['step one', 'step two', 'step three']);
    const done = events.at(-1)!;

    expect(done).toMatchObject({
      type: 'done',
      // A healed run still passed — the count is what says otherwise.
      status: 'passed',
      healed: { steps: 1, tokens: 4100 },
    });
  });

  it('says nothing new on a clean run', async () => {
    executeStepMock.mockImplementation(async (index: number, _total: number, instr: string) =>
      passed(index, instr),
    );

    const events = await run(['step one', 'step two']);
    const done = events.at(-1)!;

    expect(done).toMatchObject({ type: 'done', status: 'passed' });
    expect(done).not.toHaveProperty('healed');
  });

  it('still marks the healed step as passed on the wire', async () => {
    executeStepMock.mockImplementationOnce(async () => healed(1, 'step one'));

    const events = await run(['step one']);

    const pass = events.find((e) => e.type === 'step:pass')!;
    expect(pass).toMatchObject({
      type: 'step:pass',
      codeBehindStale: { file: '/p/tests/checkout.steps.ts' },
    });
  });
});

// ── Failures keep their code-behind story on the wire ───────────────────────
//
// The step:fail event used to carry only the (final) error string, so a
// TestBench user could not see what the code-behind died of: a broken entry
// whose AI fallback also failed lost the crash entirely, and a failed
// `step.expect` was indistinguishable from an AI-run failure.
describe('the step:fail payload', () => {
  function failedAfterHeal(index: number, instruction: string): StepResult {
    return {
      index, instruction, status: 'failed', turns: [], durationMs: 1,
      retried: true, error: 'AI could not find the button either',
      codeBehindStale: {
        file: '/p/tests/checkout.steps.ts',
        source: instruction,
        error: 'locator resolved to 2 elements',
      },
    };
  }

  it('carries the code-behind crash when the heal failed too', async () => {
    executeStepMock.mockImplementationOnce(async () => failedAfterHeal(1, 'step one'));

    const events = await run(['step one']);

    const fail = events.find((e) => e.type === 'step:fail')!;
    expect(fail).toMatchObject({
      type: 'step:fail',
      error: 'AI could not find the button either',
      codeBehindStale: {
        file: '/p/tests/checkout.steps.ts',
        error: 'locator resolved to 2 elements',
      },
    });
  });

  it('says when the failure came from the step\'s own code-behind', async () => {
    executeStepMock.mockImplementationOnce(async (): Promise<StepResult> => ({
      index: 1, instruction: 'step one', status: 'failed', turns: [],
      durationMs: 1, retried: false,
      error: 'the confirmation banner never appeared',
      fromCodeBehind: true,
    }));

    const events = await run(['step one']);

    const fail = events.find((e) => e.type === 'step:fail')!;
    expect(fail).toMatchObject({
      type: 'step:fail',
      fromCodeBehind: true,
      error: 'the confirmation banner never appeared',
    });
  });

  it('does not count a heal that then failed in the healed summary', async () => {
    executeStepMock.mockImplementationOnce(async () => {
      spentTokens += 900;
      return failedAfterHeal(1, 'step one');
    });

    const events = await run(['step one']);

    const done = events.at(-1)!;
    expect(done).toMatchObject({ type: 'done', status: 'failed' });
    expect(done).not.toHaveProperty('healed');
  });
});

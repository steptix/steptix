/**
 * The browser launches at the first browser-surface STEP, not at session
 * creation — SPEC-use-computer.md §4.6, acceptance item 2.
 *
 * `launchBrowser` is mocked and counted, because the whole claim is about WHEN
 * it is called: once, at step 1, and never for a session that runs no step on
 * the page. The `surface` field is set directly on the session here — this
 * file is about the launch rule, not about how `[use computer]` switches it
 * on.
 *
 * Driving `SessionManager` in process rather than over HTTP: the HTTP layer
 * refuses an empty step list, and "created but nothing has run yet" is exactly
 * the state under test. The one status-code assertion this leaves out —
 * `GET /sessions/:id/content` answering 409 — is in
 * api-server-content.test.ts, where the server harness already exists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';

// ---------------------------------------------------------------------------
// Mocks — the manager.js shape session-manager.test.ts uses, with the deferred
// tracker MODELLED rather than stubbed: a mock that always has a browser would
// make every assertion in this file vacuous.
// ---------------------------------------------------------------------------

const mockPage = {
  url: vi.fn(() => 'https://example.com'),
  title: vi.fn(async () => 'Example'),
  goto: vi.fn(async () => null),
  video: vi.fn(() => null),
};

const mockPageTracker = {
  getActive: vi.fn(() => mockPage as any),
  activeTabRef: vi.fn(async () => null),
};

const mockBrowserSession = {
  browser: { isConnected: vi.fn(() => true) },
  context: {},
  page: mockPage,
  pageTracker: mockPageTracker,
};

/** Every call to the mocked `launchBrowser`, so tests can count and steer it. */
const launchBrowserMock = vi.fn(async (..._args: unknown[]) => ({ ...mockBrowserSession }));
const closeBrowserMock = vi.fn(async (_s: unknown) => {});

vi.mock('../src/browser/manager.js', () => {
  class BrowserTracker {
    sessions: { label: string; session: any }[] = [];
    launch: (() => Promise<any>) | undefined;
    launched = false;
    constructor(initialSession: any, label = 'default') {
      if (initialSession !== undefined) {
        this.sessions.push({ label, session: initialSession });
        this.launched = true;
      }
    }
    static deferred(launch: () => Promise<any>): BrowserTracker {
      const tracker = new BrowserTracker(undefined);
      tracker.launch = launch;
      return tracker;
    }
    async ensureLaunched(): Promise<any> {
      if (this.launched) return this.getActive();
      const session = await this.launch!();
      this.sessions.push({ label: 'default', session });
      this.launched = true;
      return session;
    }
    hasActive(): boolean {
      return this.sessions.length > 0;
    }
    isLaunched(): boolean {
      return this.launched;
    }
    getActive(): any {
      const entry = this.sessions[this.sessions.length - 1];
      if (!entry) throw new NoBrowserLaunchedError();
      return entry.session;
    }
    getActivePage(): any {
      return this.getActive().pageTracker.getActive();
    }
    getActiveLabel(): string {
      return 'default';
    }
    all(): any[] {
      return this.sessions.map((s) => s.session);
    }
    list(): any[] {
      return [];
    }
    add(label: string, session: any): void {
      this.sessions.push({ label, session });
    }
    async close(): Promise<void> {
      this.sessions.length = 0;
    }
    closeAll = vi.fn(async () => {
      this.sessions.length = 0;
    });
    get count(): number {
      return this.sessions.length;
    }
  }
  class NoBrowserLaunchedError extends Error {
    constructor(message = 'no browser has been launched in this session') {
      super(message);
      this.name = 'NoBrowserLaunchedError';
    }
  }
  return {
    launchBrowser: (...args: unknown[]) => launchBrowserMock(...args),
    closeBrowser: (...args: unknown[]) => closeBrowserMock(...(args as [unknown])),
    PageTracker: vi.fn(),
    BrowserTracker,
    NoBrowserLaunchedError,
    NO_BROWSER_LAUNCHED_MESSAGE: 'no browser has been launched in this session',
    briefly: async (p: Promise<unknown>, ms: number, fallback: unknown) =>
      Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]),
    resolveVideoMode: vi.fn(() => 'off'),
    finalizeMainPageVideo: vi.fn(async (args: { closeContext: () => Promise<void> }) => {
      await args.closeContext();
      return undefined;
    }),
  };
});

vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: vi.fn(async (): Promise<StepResult> => ({
    index: 1,
    instruction: 'mock step',
    status: 'passed',
    turns: [],
    durationMs: 10,
    retried: false,
    aiExplanation: 'ok',
  })),
  executeBranchedStep: vi.fn(async (): Promise<StepResult[]> => []),
}));

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: vi.fn(async () => ({ files: [], combined: '' })),
}));

vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    config: any;
    chat = vi.fn(async () => '{}');
    setAiPolicy = vi.fn();
    syncAuth = vi.fn(() => null);
    constructor(config: any) {
      this.config = config;
    }
  },
}));

vi.mock('../src/utils/tokens.js', () => ({
  TokenTracker: class {
    resetStep = vi.fn();
    markRunStart = vi.fn();
    get total() { return 0; }
    get inputTotal() { return 0; }
    get outputTotal() { return 0; }
    get runTotal() { return 0; }
    get runInputTotal() { return 0; }
    get runOutputTotal() { return 0; }
  },
}));

vi.mock('../src/api/response-store.js', () => ({
  ApiResponseStore: class {
    store = vi.fn();
    getHistory = vi.fn(() => []);
  },
}));

vi.mock('../src/report/generator.js', () => ({
  generateReport: vi.fn(async () => '/tmp/fake-report.html'),
  getPrimaryModel: vi.fn(() => 'mock-model'),
  buildReportBaseName: vi.fn((report: { testName: string }) => report.testName),
  videoBaseNameFor: vi.fn(() => 'video'),
  countStepOrigins: vi.fn(() => ({})),
}));

vi.mock('../src/browser/screenshot.js', () => ({
  captureScreenshot: vi.fn(async () => ({ base64: 'fake' })),
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

import { SessionManager } from '../src/server/session-manager.js';
import { NoBrowserLaunchedError } from '../src/browser/manager.js';
import { COMPUTER_DISABLED_MESSAGE } from '../src/runner/computer-step.js';

const testConfig: Config = {
  ai: {
    gatewayUrl: 'https://ai.test',
    model: 'test-model',
    maxInputTokens: 1000,
    streamResponses: false,
    sendScreenshots: false,
  },
  browser: {
    headed: false,
    viewport: { width: 1280, height: 720 },
    windowSize: { width: 1280, height: 720 },
    slowMo: 0,
    browser: 'chromium',
    fullPageScreenshots: true,
  },
  tests: { dir: './tests', contextDir: './context', pattern: '**/*.md' },
  execution: {
    timeout: 30_000,
    retries: 1,
    screenshotOnFailure: false,
    promptOnAmbiguity: false,
    maxTurns: 5,
  },
  reports: {
    outputDir: './reports',
    includeScreenshots: false,
    includeDomSnapshots: false,
    includeAiReasoning: true,
    embedScreenshots: false,
  },
  api: { specsDir: './specs', requestTimeout: 30_000, redactSensitive: true },
  server: { host: '127.0.0.1', port: 3100, apiKey: 'test-api-key' },
  logging: { consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
} as unknown as Config;

/** The live `ManagedSession`, for the two things only it can say. */
function managedSession(manager: SessionManager, id: string): any {
  return (manager as unknown as { sessions: Map<string, unknown> }).sessions.get(id);
}

let manager: SessionManager;

beforeEach(() => {
  vi.clearAllMocks();
  launchBrowserMock.mockImplementation(async () => ({ ...mockBrowserSession }));
  mockPage.goto.mockClear();
  manager = new SessionManager(testConfig);
});

describe('session creation launches nothing', () => {
  it('creates the session without calling launchBrowser', async () => {
    await manager.executeSteps('s-create', { steps: [] });

    expect(launchBrowserMock).not.toHaveBeenCalled();
    const session = managedSession(manager, 's-create');
    expect(session).toBeDefined();
    expect(session.browserSession).toBeUndefined();
    expect(session.mainPage).toBeUndefined();
    expect(session.browserTracker.hasActive()).toBe(false);
  });

  it('still starts on the browser surface', async () => {
    await manager.executeSteps('s-surface', { steps: [] });

    expect(managedSession(manager, 's-surface').surface).toBe('browser');
  });

  // §4.6: the viewport/cdp conflict still fires at CREATION, before anything
  // is deferred — the whole point of resolving those at creation is that a bad
  // value fails the batch with no browser side effects.
  it('still refuses a viewport + cdp conflict at creation', async () => {
    await expect(
      manager.executeSteps('s-conflict', {
        steps: ['click'],
        config: { viewport: 'mobile', cdp: { port: 9222 } },
      }),
    ).rejects.toThrow(/viewport/i);

    expect(launchBrowserMock).not.toHaveBeenCalled();
  });
});

describe('the first browser-surface step launches exactly one browser', () => {
  it('launches at step 1 and reuses it for the next batch', async () => {
    await manager.executeSteps('s-step', { steps: ['click the button'] });
    expect(launchBrowserMock).toHaveBeenCalledTimes(1);

    await manager.executeSteps('s-step', { steps: ['click again', 'and again'] });
    expect(launchBrowserMock).toHaveBeenCalledTimes(1);
  });

  it('launches on the step after a creation batch that ran none', async () => {
    await manager.executeSteps('s-later', { steps: [] });
    expect(launchBrowserMock).not.toHaveBeenCalled();

    await manager.executeSteps('s-later', { steps: ['click'] });
    expect(launchBrowserMock).toHaveBeenCalledTimes(1);
  });

  it('fills browserSession and mainPage from the launch', async () => {
    await manager.executeSteps('s-fill', { steps: ['click'] });

    const session = managedSession(manager, 's-fill');
    expect(session.browserSession).toBeDefined();
    expect(session.mainPage).toBe(mockPage);
  });

  // The navigation moved WITH the launch (§4.6), which is the half that is
  // easy to lose: a baseUrl silently never visited looks like a test that
  // started on the wrong page.
  it('navigates to baseUrl at launch time, not at creation', async () => {
    await manager.executeSteps('s-baseurl', {
      steps: [],
      config: { baseUrl: 'https://example.test/app' },
    });
    expect(mockPage.goto).not.toHaveBeenCalled();

    await manager.executeSteps('s-baseurl', { steps: ['click'] });

    expect(mockPage.goto).toHaveBeenCalledTimes(1);
    expect(mockPage.goto.mock.calls[0]![0]).toBe('https://example.test/app');
  });
});

describe('a computer-surface session launches no browser', () => {
  // `surface` is set directly rather than through `[use computer]`: the launch
  // rule is testable without the directive. This config has no
  // `desktop.enabled`, so the step boundary refuses the computer step with
  // §5.1's message and returns that as the step's failure — which is what
  // shows the step was reached ON the computer surface. A batch that threw
  // before the step loop would launch nothing either, so "no launch" alone
  // could not tell the two apart.
  it('does not launch when the surface is computer at the first step', async () => {
    await manager.executeSteps('s-computer', { steps: [] });
    managedSession(manager, 's-computer').surface = 'computer';

    const response = await manager.executeSteps('s-computer', {
      steps: ['click Save in the dialog'],
    });

    expect(response.results).toHaveLength(1);
    expect(response.results[0]!.status).toBe('failed');
    expect(response.results[0]!.reasoning).toBe(COMPUTER_DISABLED_MESSAGE);
    expect(launchBrowserMock).not.toHaveBeenCalled();
    expect(managedSession(manager, 's-computer').browserSession).toBeUndefined();
  });

  it('launches once the surface goes back to browser', async () => {
    await manager.executeSteps('s-back', { steps: [] });
    const session = managedSession(manager, 's-back');
    session.surface = 'computer';
    const refused = await manager.executeSteps('s-back', { steps: ['press Ctrl+S'] });
    expect(refused.results[0]!.reasoning).toBe(COMPUTER_DISABLED_MESSAGE);
    expect(launchBrowserMock).not.toHaveBeenCalled();

    session.surface = 'browser';
    await manager.executeSteps('s-back', { steps: ['click the heading'] });

    expect(launchBrowserMock).toHaveBeenCalledTimes(1);
  });
});

describe('a failed launch is step 1 failing, not a thrown batch', () => {
  it('reports the launch error as the first step result', async () => {
    launchBrowserMock.mockRejectedValueOnce(
      new Error('Chromium distribution "chrome" is not found'),
    );

    const response = await manager.executeSteps('s-fail', { steps: ['click', 'type'] });

    expect(response.status).toBe('failed');
    expect(response.results).toHaveLength(1);
    expect(response.results[0]!.status).toBe('failed');
    expect(response.results[0]!.step).toBe('click');
    expect(response.results[0]!.reasoning).toContain('is not found');
  });

  it('leaves the session usable — the next batch retries the launch', async () => {
    launchBrowserMock.mockRejectedValueOnce(new Error('transient launch failure'));

    await manager.executeSteps('s-retry', { steps: ['click'] });
    expect(launchBrowserMock).toHaveBeenCalledTimes(1);

    const second = await manager.executeSteps('s-retry', { steps: ['click'] });

    expect(launchBrowserMock).toHaveBeenCalledTimes(2);
    expect(second.status).toBe('passed');
  });
});

describe('out-of-band readers do not launch a browser', () => {
  it('getPageContent answers the no-browser error', async () => {
    await manager.executeSteps('s-read', { steps: [] });

    await expect(
      manager.getPageContent('s-read', { format: 'text' } as never),
    ).rejects.toThrow(NoBrowserLaunchedError);
    expect(launchBrowserMock).not.toHaveBeenCalled();
  });

  it('activePageFor answers the no-browser error, not null', async () => {
    await manager.executeSteps('s-login', { steps: [] });

    expect(() => manager.activePageFor('s-login')).toThrow(
      'no browser has been launched in this session',
    );
    // A session that does not exist is still the other answer.
    expect(manager.activePageFor('s-nope')).toBeNull();
    expect(launchBrowserMock).not.toHaveBeenCalled();
  });

  it('getSession and the listings report the session with empty page fields', async () => {
    await manager.executeSteps('s-list', { steps: [] });

    const state = await manager.getSession('s-list');
    expect(state).not.toBeNull();
    expect(state!.currentUrl).toBe('');
    expect(state!.pageTitle).toBe('');

    expect(manager.getActiveSessions().some((s) => s.sessionId === 's-list')).toBe(true);
    const listed = await manager.getActiveSessionsWithTitles();
    expect(listed.find((s) => s.sessionId === 's-list')!.currentUrl).toBe('');
    expect(launchBrowserMock).not.toHaveBeenCalled();
  });
});

describe('closing an unlaunched session', () => {
  it('does not throw and removes the session', async () => {
    await manager.executeSteps('s-close', { steps: [] });

    await expect(manager.closeSession('s-close')).resolves.toBeUndefined();

    expect(managedSession(manager, 's-close')).toBeUndefined();
    expect(launchBrowserMock).not.toHaveBeenCalled();
  });

  it('closeAll tolerates one that never launched', async () => {
    await manager.executeSteps('s-a', { steps: [] });
    await manager.executeSteps('s-b', { steps: ['click'] });

    await expect(manager.closeAll()).resolves.toBeUndefined();
  });
});

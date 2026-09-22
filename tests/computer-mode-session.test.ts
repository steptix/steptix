/**
 * The mode state machine in the Sessions API loop — SPEC-use-computer.md
 * §4.4, §4.5, §5.1, §5.9, and acceptance items 2, 6 and 7.
 *
 * `launchBrowser` is mocked and COUNTED, because half of what is under test is
 * a call that must not happen: a session whose first step is `[use computer]`
 * opens no browser. The desktop seams are injected — `FakeDesktopAdapter` and
 * a lock file in this test's own temp directory — so nothing here can load
 * nut.js or touch the machine's real `aiui-computer.lock`.
 *
 * The mock wall is `session-lazy-launch.test.ts`'s, with two changes it names:
 * the step-executor and computer-step modules are spread from the REAL ones
 * rather than stubbed whole, because the state machine under test lives in the
 * second and imports half of the first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';

// ---------------------------------------------------------------------------
// Mocks
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
    hasActive(): boolean { return this.sessions.length > 0; }
    isLaunched(): boolean { return this.launched; }
    getActive(): any {
      const entry = this.sessions[this.sessions.length - 1];
      if (!entry) throw new NoBrowserLaunchedError();
      return entry.session;
    }
    getActivePage(): any { return this.getActive().pageTracker.getActive(); }
    getActiveLabel(): string { return 'default'; }
    all(): any[] { return this.sessions.map((s) => s.session); }
    list(): any[] { return []; }
    add(label: string, session: any): void { this.sessions.push({ label, session }); }
    async close(): Promise<void> { this.sessions.length = 0; }
    closeAll = vi.fn(async () => { this.sessions.length = 0; });
    get count(): number { return this.sessions.length; }
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

// Spread from the real module: `computer-step.ts` imports seven values from
// this one, and a stub that defines two would fail at import rather than at
// assertion time.
const executeStepMock = vi.fn(
  async (_i: number, _n: number, instruction: string): Promise<StepResult> => ({
    index: 1,
    instruction,
    status: 'passed',
    turns: [],
    durationMs: 10,
    retried: false,
    aiExplanation: 'ok',
  }),
);
vi.mock('../src/runner/step-executor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runner/step-executor.js')>()),
  executeStep: (...args: unknown[]) => (executeStepMock as any)(...args),
  executeBranchedStep: vi.fn(async (): Promise<StepResult[]> => []),
}));

/** The computer-mode turn loop is proven in `computer-step.test.ts`; here it
 *  only has to report which surface it ran on and not call a model. */
const executeComputerStepMock = vi.fn(
  async (index: number, _n: number, instruction: string): Promise<StepResult> => ({
    index,
    instruction,
    status: 'passed',
    surface: 'computer',
    turns: [],
    durationMs: 5,
    retried: false,
    aiExplanation: 'computer step ok',
  }),
);
vi.mock('../src/runner/computer-step.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runner/computer-step.js')>()),
  executeComputerStep: (...args: unknown[]) => (executeComputerStepMock as any)(...args),
}));

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: vi.fn(async () => ({ files: [], combined: '' })),
}));

vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    config: any;
    chat = vi.fn(async () => '{}');
    complete = vi.fn(async () => ({ text: '{}', model: 'fake' }));
    setAiPolicy = vi.fn();
    syncAuth = vi.fn(() => null);
    constructor(config: any) { this.config = config; }
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

import { SessionManager, type RunEvent } from '../src/server/session-manager.js';
import { FakeDesktopAdapter } from '../src/desktop/fake-adapter.js';
import { readComputerLock } from '../src/desktop/lock.js';
import { COMPUTER_DISABLED_MESSAGE } from '../src/runner/computer-step.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseConfig = {
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
  cache: { enabled: false, dir: '.cache' },
  logging: { consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
  desktop: { enabled: true, maxImageWidth: 400, settleMs: 0, reportScreenshots: true },
} as unknown as Config;

function configWith(desktop: Partial<Config['desktop']>): Config {
  return {
    ...baseConfig,
    desktop: { ...baseConfig.desktop, ...desktop },
  } as Config;
}

/** The live `ManagedSession` — the only place `surface` can be read. */
function managed(manager: SessionManager, id: string): any {
  return (manager as unknown as { sessions: Map<string, unknown> }).sessions.get(id);
}

let lockDir: string;
let lockPath: string;
let adapter: FakeDesktopAdapter;
let loadDesktopAdapter: ReturnType<typeof vi.fn>;
let probeComputerCapture: ReturnType<typeof vi.fn>;

function makeManager(config: Config = baseConfig): SessionManager {
  return new SessionManager(config, undefined, {
    loadDesktopAdapter: loadDesktopAdapter as never,
    probeComputerCapture: probeComputerCapture as never,
    computerLock: { lockPath },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  launchBrowserMock.mockImplementation(async () => ({ ...mockBrowserSession }));
  lockDir = mkdtempSync(path.join(os.tmpdir(), 'aiui-computer-test-'));
  lockPath = path.join(lockDir, 'aiui-computer.lock');
  adapter = new FakeDesktopAdapter({ width: 200, height: 150 });
  loadDesktopAdapter = vi.fn(async () => adapter);
  probeComputerCapture = vi.fn(async () => {});
});

afterEach(() => {
  rmSync(lockDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// §5.1 — entering
// ---------------------------------------------------------------------------

describe('[use computer] as step 1 (acceptance 2)', () => {
  it('launches no browser, flips the surface and takes the lock', async () => {
    const manager = makeManager();

    const response = await manager.executeSteps('s-enter', {
      steps: ['[use computer]', 'Click Save in the dialog'],
    });

    expect(launchBrowserMock).not.toHaveBeenCalled();
    expect(response.status).toBe('passed');
    expect(managed(manager, 's-enter').surface).toBe('computer');
    expect(existsSync(lockPath)).toBe(true);
    expect(readComputerLock({ lockPath })!.sessionId).toBe('s-enter');
    // The step after it ran on the computer surface, not through executeStep.
    expect(executeComputerStepMock).toHaveBeenCalledTimes(1);
    expect(executeStepMock).not.toHaveBeenCalled();
  });

  it('records a mode row: passed, no turns, no screenshot', async () => {
    const manager = makeManager();
    const events: RunEvent[] = [];

    await manager.executeSteps('s-row', { steps: ['[use computer]'] }, (e) => events.push(e));

    const pass = events.find((e) => e.type === 'step:pass') as Extract<RunEvent, { type: 'step:pass' }>;
    expect(pass).toBeDefined();
    expect(pass.stepKind).toBe('mode');
    expect(pass.surface).toBe('computer');
    expect(pass.output).toBe('→ computer');
    expect(pass.screenshot).toBeUndefined();
  });

  it('runs §5.1 in order: opt-in, adapter, lock, probe', async () => {
    const manager = makeManager();
    await manager.executeSteps('s-order', { steps: ['[use computer]'] });

    expect(loadDesktopAdapter).toHaveBeenCalledTimes(1);
    expect(probeComputerCapture).toHaveBeenCalledWith(adapter);
  });
});

describe('the four preconditions each fail the step with their own message', () => {
  it('desktop.enabled: false refuses it (acceptance 7)', async () => {
    const manager = makeManager(configWith({ enabled: false }));

    const response = await manager.executeSteps('s-off', {
      steps: ['[use computer]', 'Click Save'],
    });

    expect(response.status).toBe('failed');
    expect(response.results[0]!.reasoning).toBe(COMPUTER_DISABLED_MESSAGE);
    expect(managed(manager, 's-off').surface).toBe('browser');
    // Neither the adapter nor the lock was touched: the opt-in is first.
    expect(loadDesktopAdapter).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(false);
    expect(launchBrowserMock).not.toHaveBeenCalled();
  });

  it('a failed adapter load fails the step with the loader message', async () => {
    loadDesktopAdapter.mockRejectedValue(
      new Error('Cannot load @nut-tree-fork/nut-js on win32: no prebuilt binary'),
    );
    const manager = makeManager();

    const response = await manager.executeSteps('s-noload', { steps: ['[use computer]'] });

    expect(response.status).toBe('failed');
    expect(response.results[0]!.reasoning).toContain('@nut-tree-fork/nut-js');
    expect(managed(manager, 's-noload').surface).toBe('browser');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('a failed capture probe fails the step and gives the lock back', async () => {
    probeComputerCapture.mockRejectedValue(
      new Error('screen capture failed (BitBlt error 6); the server process cannot read the screen.'),
    );
    const manager = makeManager();

    const response = await manager.executeSteps('s-noprobe', { steps: ['[use computer]'] });

    expect(response.status).toBe('failed');
    expect(response.results[0]!.reasoning).toContain('BitBlt error 6');
    expect(managed(manager, 's-noprobe').surface).toBe('browser');
    // Taken at step 3 of §5.1 and handed back when step 4 said no — otherwise
    // one bad machine locks computer mode out for every other session.
    expect(existsSync(lockPath)).toBe(false);
  });

  it('a lock held by a live holder refuses the second session (§5.9)', async () => {
    const first = makeManager();
    await first.executeSteps('s-holder', { steps: ['[use computer]'] });
    expect(existsSync(lockPath)).toBe(true);

    const second = makeManager();
    const response = await second.executeSteps('s-second', { steps: ['[use computer]'] });

    expect(response.status).toBe('failed');
    expect(response.results[0]!.reasoning).toContain('computer mode is in use by session s-holder');
    expect(managed(second, 's-second').surface).toBe('browser');
  });
});

// ---------------------------------------------------------------------------
// §4.5 — the rest of the state machine
// ---------------------------------------------------------------------------

describe('[use browser] goes back (acceptance 2)', () => {
  it('releases the lock and lets the NEXT step launch', async () => {
    const manager = makeManager();

    await manager.executeSteps('s-back', {
      steps: ['[use computer]', 'Click in the dialog', '[use browser]', 'Click the heading'],
    });

    expect(existsSync(lockPath)).toBe(false);
    expect(managed(manager, 's-back').surface).toBe('browser');
    expect(launchBrowserMock).toHaveBeenCalledTimes(1);
    expect(executeComputerStepMock).toHaveBeenCalledTimes(1);
    expect(executeStepMock).toHaveBeenCalledTimes(1);
  });
});

describe('re-entering the surface you are on is a no-op (§4.5)', () => {
  it('passes, keeps the lock, and does not load a second adapter', async () => {
    const manager = makeManager();

    const response = await manager.executeSteps('s-reenter', {
      steps: ['[use computer]', '[use computer]', 'Click'],
    });

    expect(response.status).toBe('passed');
    expect(loadDesktopAdapter).toHaveBeenCalledTimes(1);
    expect(probeComputerCapture).toHaveBeenCalledTimes(1);
    expect(readComputerLock({ lockPath })!.sessionId).toBe('s-reenter');
  });

  it('[use browser] on the browser surface is a no-op too', async () => {
    const manager = makeManager();

    const response = await manager.executeSteps('s-reenter-b', { steps: ['[use browser]'] });

    expect(response.status).toBe('passed');
    expect(managed(manager, 's-reenter-b').surface).toBe('browser');
    expect(launchBrowserMock).not.toHaveBeenCalled();
  });
});

describe('the surface survives a batch boundary (§4.5)', () => {
  it('a second batch of the same session is still on the computer', async () => {
    const manager = makeManager();

    await manager.executeSteps('s-batch', { steps: ['[use computer]'] });
    await manager.executeSteps('s-batch', { steps: ['Click the dialog'] });

    expect(launchBrowserMock).not.toHaveBeenCalled();
    expect(executeComputerStepMock).toHaveBeenCalledTimes(1);
    expect(managed(manager, 's-batch').surface).toBe('computer');
  });
});

describe('a computer-mode `read` reaches the session outputs (§5.4)', () => {
  it('survives into the next batch, like a page capture does', async () => {
    executeComputerStepMock.mockImplementation(
      async (index: number, _n: number, instruction: string, opts: any): Promise<StepResult> => {
        // What the real loop does with a `read`: bind it into the live map and
        // record the sub-action shape `autoCapturedNames` finds.
        opts.resolvedParameters.file_name = 'statement.pdf';
        return {
          index,
          instruction,
          status: 'passed',
          surface: 'computer',
          turns: [
            {
              turnNumber: 1,
              attemptNumber: 1,
              timestamp: new Date().toISOString(),
              aiInteractions: [],
              subActions: [
                {
                  index: 1,
                  action: { action: 'read', as: 'file_name', description: 'Read the field' } as never,
                  durationMs: 1,
                },
              ],
            },
          ],
          durationMs: 5,
          retried: false,
        };
      },
    );
    const manager = makeManager();

    const first = await manager.executeSteps('s-read', {
      steps: ['[use computer]', 'Read the File name field'],
    });
    expect(first.outputs.file_name).toBe('statement.pdf');

    // The next batch seeds from the session's outputs, so the value is still
    // there without the client re-sending it.
    const second = await manager.executeSteps('s-read', { steps: ['Click Save'] });
    expect(second.outputs.file_name).toBe('statement.pdf');
  });
});

describe('closeSession resets the surface and releases the lock (acceptance 6)', () => {
  it('removes the lock file and the session', async () => {
    const manager = makeManager();
    await manager.executeSteps('s-close', { steps: ['[use computer]'] });
    expect(existsSync(lockPath)).toBe(true);

    await manager.closeSession('s-close');

    expect(existsSync(lockPath)).toBe(false);
    expect(managed(manager, 's-close')).toBeUndefined();
  });

  it('does not release a lock this session never took', async () => {
    const holder = makeManager();
    await holder.executeSteps('s-owner', { steps: ['[use computer]'] });

    const other = makeManager();
    await other.executeSteps('s-other', { steps: ['Click something'] });
    await other.closeSession('s-other');

    expect(readComputerLock({ lockPath })!.sessionId).toBe('s-owner');
  });
});

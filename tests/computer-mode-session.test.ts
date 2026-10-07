/**
 * The mode state machine in the Sessions API loop — SPEC-use-computer.md
 * §4.4, §4.5, §5.1, §5.9, and acceptance items 2, 6 and 7.
 *
 * `launchBrowser` is mocked and COUNTED, because half of what is under test is
 * a call that must not happen: a session whose first step is `[use computer]`
 * opens no browser. The desktop seams are injected — `FakeDesktopAdapter` and
 * a lock file in this test's own temp directory — so nothing here can load
 * nut.js or touch the machine's real `steptix-computer.lock`.
 *
 * The mock wall is `session-lazy-launch.test.ts`'s, with two changes it names:
 * the step-executor and computer-step modules are spread from the REAL ones
 * rather than stubbed whole, because the state machine under test lives in the
 * second and imports half of the first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
/** The §5.6 condition judge, which on the computer surface captures the
 *  screen. Proven in `computer-conditions.test.ts`; here it only has to say
 *  what it saw of the lock when it was asked. */
async function judgeHolds(_conditions: string[], _opts: unknown) {
  return { selected: 0 as number | null, reasoning: 'the dialog is open', aiInteractions: [] };
}
const evaluateConditionsMock = vi.fn(judgeHolds);
vi.mock('../src/runner/step-executor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runner/step-executor.js')>()),
  executeStep: (...args: unknown[]) => (executeStepMock as any)(...args),
  executeBranchedStep: vi.fn(async (): Promise<StepResult[]> => []),
  evaluateConditions: (...args: unknown[]) => (evaluateConditionsMock as any)(...args),
}));

/** The computer-mode turn loop is proven in `computer-step.test.ts`; here it
 *  only has to report which surface it ran on and not call a model. */
async function passComputerStep(index: number, _n: number, instruction: string): Promise<StepResult> {
  return {
    index,
    instruction,
    status: 'passed',
    surface: 'computer',
    turns: [],
    durationMs: 5,
    retried: false,
    aiExplanation: 'computer step ok',
  };
}
const executeComputerStepMock = vi.fn(passComputerStep);
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
import {
  acquireComputerLock,
  computerLockInUseMessage,
  readComputerLock,
} from '../src/desktop/lock.js';
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

/**
 * Record who held the lock each time a computer step ran.
 *
 * The lock is held only while a run executes (§5.9), so after `executeSteps`
 * resolves there is nothing left to read — "the run held it" has to be asked
 * DURING the run, from inside the step.
 */
function recordLockHolders(): Array<string | undefined> {
  const holders: Array<string | undefined> = [];
  executeComputerStepMock.mockImplementation(async (index, n, instruction) => {
    holders.push(readComputerLock({ lockPath })?.sessionId);
    return passComputerStep(index, n, instruction);
  });
  return holders;
}

beforeEach(() => {
  vi.clearAllMocks();
  launchBrowserMock.mockImplementation(async () => ({ ...mockBrowserSession }));
  // `clearAllMocks` keeps implementations, and a test below installs its own.
  executeComputerStepMock.mockImplementation(passComputerStep);
  evaluateConditionsMock.mockImplementation(judgeHolds);
  lockDir = mkdtempSync(path.join(os.tmpdir(), 'steptix-computer-test-'));
  lockPath = path.join(lockDir, 'steptix-computer.lock');
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
  it('launches no browser, flips the surface and holds the lock for the run', async () => {
    const holders = recordLockHolders();
    const manager = makeManager();

    const response = await manager.executeSteps('s-enter', {
      steps: ['[use computer]', 'Click Save in the dialog'],
    });

    expect(launchBrowserMock).not.toHaveBeenCalled();
    expect(response.status).toBe('passed');
    expect(managed(manager, 's-enter').surface).toBe('computer');
    // Held while the step ran, and given back when the batch ended (§5.9).
    expect(holders).toEqual(['s-enter']);
    expect(existsSync(lockPath)).toBe(false);
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
    // No testFilePath, so this is also the case where the server's own config
    // is the only answer there is.
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

  it('a lock held by another live session refuses the step (§5.9) — even one in this process', async () => {
    // Another session of THIS server holds it: the same pid, a different
    // session. The check is on the session as well as the pid, so it refuses.
    acquireComputerLock('s-holder', { lockPath });

    const second = makeManager();
    const response = await second.executeSteps('s-second', { steps: ['[use computer]'] });

    expect(response.status).toBe('failed');
    expect(response.results[0]!.reasoning).toBe(
      computerLockInUseMessage({ pid: process.pid, sessionId: 's-holder', since: '' }),
    );
    expect(managed(second, 's-second').surface).toBe('browser');
    // …and its batch end did not release the holder's lock on the way out.
    expect(readComputerLock({ lockPath })!.sessionId).toBe('s-holder');
  });
});

// ---------------------------------------------------------------------------
// §5.1 item 1b / §15.4 — the model must be able to see the screen
// ---------------------------------------------------------------------------

describe('§5.1 item 1b — the vision route (§15.4)', () => {
  /** A config with a key, so the run is not keyless and the check is asked. */
  function keyed(desktop: Partial<Config['desktop']> = {}): Config {
    return {
      ...configWith(desktop),
      ai: { ...baseConfig.ai, apiKey: 'server-key' },
    } as Config;
  }

  function managerWith(config: Config, checkVisionRoute: ReturnType<typeof vi.fn>): SessionManager {
    return new SessionManager(config, undefined, {
      loadDesktopAdapter: loadDesktopAdapter as never,
      probeComputerCapture: probeComputerCapture as never,
      computerLock: { lockPath },
      checkVisionRoute: checkVisionRoute as never,
    });
  }

  const REFUSAL =
    'Computer mode needs the model to see the screen, but the Steptix Copilot bridge drops ' +
    'images on this VS Code (it has no image support for language models). Update VS Code, or ' +
    'run computer-mode steps with a model that is not routed through the bridge.';

  it('runs after the opt-in and before the adapter loads', async () => {
    const order: string[] = [];
    const check = vi.fn(async () => {
      order.push('vision');
      return { ok: true };
    });
    loadDesktopAdapter.mockImplementation(async () => {
      order.push('adapter');
      return adapter;
    });
    probeComputerCapture.mockImplementation(async () => {
      order.push('probe');
    });
    const manager = managerWith(keyed(), check);

    const response = await manager.executeSteps('s-vision-order', { steps: ['[use computer]'] });

    expect(response.status).toBe('passed');
    expect(order).toEqual(['vision', 'adapter', 'probe']);
  });

  it('is not asked when the project has not opted in — the opt-in is first', async () => {
    const check = vi.fn(async () => ({ ok: true }));
    const manager = managerWith(keyed({ enabled: false }), check);

    const response = await manager.executeSteps('s-vision-off', { steps: ['[use computer]'] });

    expect(response.results[0]!.reasoning).toBe(COMPUTER_DISABLED_MESSAGE);
    expect(check).not.toHaveBeenCalled();
  });

  it('a refusal fails the step with its message: surface stays browser, no adapter, no lock', async () => {
    const check = vi.fn(async () => ({ ok: false, error: REFUSAL }));
    const manager = managerWith(keyed(), check);
    const events: RunEvent[] = [];

    const response = await manager.executeSteps(
      's-vision-refused',
      { steps: ['[use computer]', 'Click Save'] },
      (e) => events.push(e),
    );

    expect(response.status).toBe('failed');
    expect(response.results[0]!.reasoning).toBe(REFUSAL);
    const fail = events.find((e) => e.type === 'step:fail') as Extract<RunEvent, { type: 'step:fail' }>;
    expect(fail.error).toBe(REFUSAL);
    expect(managed(manager, 's-vision-refused').surface).toBe('browser');
    expect(loadDesktopAdapter).not.toHaveBeenCalled();
    expect(probeComputerCapture).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(false);
    expect(executeComputerStepMock).not.toHaveBeenCalled();
  });

  it('checks the EFFECTIVE route: run-settings model, and the .env gateway and key over the server\'s', async () => {
    const check = vi.fn(async () => ({ ok: true }));
    const manager = managerWith(keyed(), check);

    await manager.executeSteps('s-vision-effective', {
      steps: ['[use computer]'],
      // The project's .env routes through the bridge; the server's startup
      // config does not — `runConfig.ai` would have reported the server's.
      env: {
        AI_MODEL: 'gateway/copilot/from-dotenv',
        AI_GATEWAY_URL: 'http://127.0.0.1:4891',
        AI_API_KEY: 'bridge-key',
      },
      // …and the agent overrode the model for this session.
      runSettings: { model: 'gateway/copilot/from-run-settings' },
    });

    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith({
      model: 'gateway/copilot/from-run-settings',
      gatewayUrl: 'http://127.0.0.1:4891',
      apiKey: 'bridge-key',
    });
  });

  it('without a run-settings override, the .env model is the one checked', async () => {
    const check = vi.fn(async () => ({ ok: true }));
    const manager = managerWith(keyed(), check);

    await manager.executeSteps('s-vision-dotenv', {
      steps: ['[use computer]'],
      env: { AI_MODEL: 'gateway/copilot/from-dotenv', AI_GATEWAY_URL: 'http://127.0.0.1:4891' },
    });

    expect(check).toHaveBeenCalledWith({
      model: 'gateway/copilot/from-dotenv',
      gatewayUrl: 'http://127.0.0.1:4891',
      apiKey: 'server-key',
    });
  });

  it('a keyless run is not asked — the first computer turn reports the missing model', async () => {
    const check = vi.fn(async () => ({ ok: false, error: 'must not be asked' }));
    // `baseConfig` carries no key.
    const manager = managerWith(baseConfig, check);

    const response = await manager.executeSteps('s-vision-keyless', { steps: ['[use computer]'] });

    expect(response.status).toBe('passed');
    expect(check).not.toHaveBeenCalled();
    expect(managed(manager, 's-vision-keyless').surface).toBe('computer');
  });

  it('re-entering the surface does not ask again', async () => {
    const check = vi.fn(async () => ({ ok: true }));
    const manager = managerWith(keyed(), check);

    await manager.executeSteps('s-vision-reenter', { steps: ['[use computer]', '[use computer]'] });

    expect(check).toHaveBeenCalledTimes(1);
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
    const holders = recordLockHolders();
    const manager = makeManager();

    const response = await manager.executeSteps('s-reenter', {
      steps: ['[use computer]', '[use computer]', 'Click'],
    });

    expect(response.status).toBe('passed');
    expect(loadDesktopAdapter).toHaveBeenCalledTimes(1);
    expect(probeComputerCapture).toHaveBeenCalledTimes(1);
    expect(holders).toEqual(['s-reenter']);
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

// ---------------------------------------------------------------------------
// §5.9 — the lock is held only while a run executes
//
// Measured defect: an MCP `run_test_file` of a test that ended in computer
// mode passed, and afterwards `steptix-computer.lock` was still held by that
// session — MCP keeps a session open between calls — so every other
// computer-mode session on the machine would have been refused until
// something closed it. The surface outlives a batch; the lock must not.
// ---------------------------------------------------------------------------

describe('the lock is held only while a run executes (§5.9)', () => {
  /** Every model call the session could make, on the mocked client. */
  function modelCalls(manager: SessionManager, id: string): number {
    const ai = managed(manager, id).aiClient;
    return ai.complete.mock.calls.length + ai.chat.mock.calls.length;
  }

  it('run end: a batch that ends on the computer surface leaves no lock, and the surface and adapter stay', async () => {
    const manager = makeManager();

    const response = await manager.executeSteps('s-end', {
      steps: ['[use computer]', 'Click Save'],
    });

    expect(response.status).toBe('passed');
    expect(existsSync(lockPath)).toBe(false);
    const session = managed(manager, 's-end');
    expect(session.surface).toBe('computer');
    expect(session.computerAdapter).toBe(adapter);
    expect(session.computerLockHeld).toBe(false);
  });

  it('next batch: the session\'s first computer step takes the lock again and passes', async () => {
    const holders = recordLockHolders();
    const manager = makeManager();

    await manager.executeSteps('s-next', { steps: ['[use computer]', 'Click Save'] });
    expect(existsSync(lockPath)).toBe(false);

    const second = await manager.executeSteps('s-next', { steps: ['Click the dialog'] });

    expect(second.status).toBe('passed');
    // Held during both batches' computer steps, and between them by nobody.
    expect(holders).toEqual(['s-next', 's-next']);
    expect(existsSync(lockPath)).toBe(false);
    // The surface carried over: no second adapter load, no second probe.
    expect(loadDesktopAdapter).toHaveBeenCalledTimes(1);
    expect(probeComputerCapture).toHaveBeenCalledTimes(1);
  });

  it('between batches: another session takes the lock, and the first session\'s next computer step fails with §5.9 and asks no model', async () => {
    const manager = makeManager();
    await manager.executeSteps('s-first', { steps: ['[use computer]', 'Click A'] });
    expect(existsSync(lockPath)).toBe(false);

    // `s-second` enters computer mode and, WHILE ITS STEP RUNS — holding the
    // lock — `s-first`'s next batch arrives. Two sessions of one server: the
    // same pid, so only the session check can refuse.
    const firstEvents: RunEvent[] = [];
    let firstBatch2: Awaited<ReturnType<SessionManager['executeSteps']>> | undefined;
    executeComputerStepMock.mockImplementation(async (index, n, instruction) => {
      if (instruction === 'Click in the second session') {
        firstBatch2 = await manager.executeSteps(
          's-first',
          { steps: ['Click B', 'Click C'] },
          (e) => firstEvents.push(e),
        );
      }
      return passComputerStep(index, n, instruction);
    });

    const second = await manager.executeSteps('s-second', {
      steps: ['[use computer]', 'Click in the second session'],
    });

    expect(second.status).toBe('passed');
    const message = computerLockInUseMessage({
      pid: process.pid,
      sessionId: 's-second',
      since: '',
    });
    expect(firstBatch2!.status).toBe('failed');
    expect(firstBatch2!.error!.message).toBe(message);
    expect(firstBatch2!.results).toHaveLength(1);
    expect(firstBatch2!.results[0]!.reasoning).toBe(message);
    const fail = firstEvents.find((e) => e.type === 'step:fail') as Extract<RunEvent, { type: 'step:fail' }>;
    expect(fail.error).toBe(message);
    expect(fail.surface).toBe('computer');
    // Nothing was captured or asked for the refused step, nor for the one
    // after it.
    const ran = executeComputerStepMock.mock.calls.map((call) => call[2]);
    expect(ran).toEqual(['Click A', 'Click in the second session']);
    expect(modelCalls(manager, 's-first')).toBe(0);
    // Still on the computer surface — only the lock was refused.
    expect(managed(manager, 's-first').surface).toBe('computer');
    // The second session gave it back at its own batch end, and the first
    // never held it to release.
    expect(existsSync(lockPath)).toBe(false);
  });

  it('re-entry: [use computer] in a later batch takes the lock when it is not held', async () => {
    const manager = makeManager();
    await manager.executeSteps('s-reentry', { steps: ['[use computer]'] });
    expect(existsSync(lockPath)).toBe(false);

    let holderAtModeRow: string | undefined;
    const response = await manager.executeSteps('s-reentry', { steps: ['[use computer]'] }, (e) => {
      if (e.type === 'step:pass' && e.stepKind === 'mode') {
        holderAtModeRow = readComputerLock({ lockPath })?.sessionId;
      }
    });

    expect(response.status).toBe('passed');
    expect(holderAtModeRow).toBe('s-reentry');
    // Still a re-entry: no second adapter, no second probe.
    expect(loadDesktopAdapter).toHaveBeenCalledTimes(1);
    expect(probeComputerCapture).toHaveBeenCalledTimes(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('re-entry refused: another session holds the lock, so the [use computer] row fails with §5.9', async () => {
    const manager = makeManager();
    await manager.executeSteps('s-reentry-busy', { steps: ['[use computer]'] });
    acquireComputerLock('s-busy', { lockPath });

    const response = await manager.executeSteps('s-reentry-busy', {
      steps: ['[use computer]', 'Click Save'],
    });

    expect(response.status).toBe('failed');
    expect(response.results[0]!.reasoning).toBe(
      computerLockInUseMessage({ pid: process.pid, sessionId: 's-busy', since: '' }),
    );
    expect(executeComputerStepMock).not.toHaveBeenCalled();
    expect(managed(manager, 's-reentry-busy').surface).toBe('computer');
    expect(readComputerLock({ lockPath })!.sessionId).toBe('s-busy');
  });

  it('other endings: a batch that fails, an aborted batch and a throwing step all release', async () => {
    const manager = makeManager();

    // A failed computer step ends the batch.
    executeComputerStepMock.mockImplementationOnce(async (index, _n, instruction) => ({
      index,
      instruction,
      status: 'failed',
      surface: 'computer',
      turns: [],
      durationMs: 5,
      retried: false,
      error: 'the Save button was not found',
    }));
    const failed = await manager.executeSteps('s-endings', {
      steps: ['[use computer]', 'Click Save', 'Click Close'],
    });
    expect(failed.status).toBe('failed');
    expect(existsSync(lockPath)).toBe(false);

    // A stop lands while a computer step runs; the loop halts at the next
    // step boundary.
    const controller = new AbortController();
    let heldWhenStopped: string | undefined;
    executeComputerStepMock.mockImplementationOnce(async (index, n, instruction) => {
      heldWhenStopped = readComputerLock({ lockPath })?.sessionId;
      controller.abort();
      return passComputerStep(index, n, instruction);
    });
    const aborted = await manager.executeSteps(
      's-endings',
      { steps: ['Click Save', 'Click Close'] },
      undefined,
      controller.signal,
    );
    expect(aborted.status).toBe('aborted');
    expect(heldWhenStopped).toBe('s-endings');
    expect(existsSync(lockPath)).toBe(false);

    // A step that throws out of the executor.
    executeComputerStepMock.mockImplementationOnce(async () => {
      throw new Error('nut.js exploded');
    });
    const errored = await manager.executeSteps('s-endings', { steps: ['Click Save'] });
    expect(errored.status).toBe('error');
    expect(existsSync(lockPath)).toBe(false);

    expect(managed(manager, 's-endings').surface).toBe('computer');
    expect(executeComputerStepMock).toHaveBeenCalledTimes(3);
  });

  it('condition judge: a computer-surface `If … then` as the first step of a batch takes the lock before it is asked', async () => {
    const manager = makeManager();
    await manager.executeSteps('s-judge', { steps: ['[use computer]'] });
    expect(existsSync(lockPath)).toBe(false);

    let holderWhenJudged: string | undefined;
    let judgedOnComputer = false;
    evaluateConditionsMock.mockImplementation(async (conditions, opts) => {
      holderWhenJudged = readComputerLock({ lockPath })?.sessionId;
      judgedOnComputer = (opts as { computer?: unknown }).computer !== undefined;
      return judgeHolds(conditions, opts);
    });

    const response = await manager.executeSteps('s-judge', {
      steps: ['If the Save dialog is open, then Click Save'],
    });

    expect(response.status).toBe('passed');
    expect(evaluateConditionsMock).toHaveBeenCalledTimes(1);
    expect(judgedOnComputer).toBe(true);
    expect(holderWhenJudged).toBe('s-judge');
    // The tail ran on the computer surface, under the lock the guard took.
    expect(executeComputerStepMock).toHaveBeenCalledTimes(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('condition judge refused: with the lock held elsewhere the guard fails with §5.9 and the judge is never asked', async () => {
    const manager = makeManager();
    await manager.executeSteps('s-judge-busy', { steps: ['[use computer]'] });
    acquireComputerLock('s-busy', { lockPath });

    const response = await manager.executeSteps('s-judge-busy', {
      steps: ['If the Save dialog is open, then Click Save'],
    });

    expect(response.status).toBe('failed');
    expect(response.error!.message).toBe(
      computerLockInUseMessage({ pid: process.pid, sessionId: 's-busy', since: '' }),
    );
    expect(evaluateConditionsMock).not.toHaveBeenCalled();
    expect(executeComputerStepMock).not.toHaveBeenCalled();
    expect(readComputerLock({ lockPath })!.sessionId).toBe('s-busy');
  });

  it('a step that touches no screen takes no lock: `Set` runs while another session holds it', async () => {
    const manager = makeManager();
    await manager.executeSteps('s-set', { steps: ['[use computer]'] });
    acquireComputerLock('s-busy', { lockPath });

    const response = await manager.executeSteps('s-set', {
      steps: ['Set {{file_name}} to "statement.pdf"'],
    });

    expect(response.status).toBe('passed');
    expect(response.outputs.file_name).toBe('statement.pdf');
    expect(managed(manager, 's-set').computerLockHeld).toBeFalsy();
    expect(readComputerLock({ lockPath })!.sessionId).toBe('s-busy');
  });

  it('release is safe: [use browser] releases at the step, and the page step after it runs unlocked', async () => {
    const holders = recordLockHolders();
    let lockWhenPageStepRan: boolean | undefined;
    executeStepMock.mockImplementationOnce(async (_i, _n, instruction) => {
      lockWhenPageStepRan = existsSync(lockPath);
      return { index: 1, instruction, status: 'passed', turns: [], durationMs: 1, retried: false };
    });
    const manager = makeManager();

    await manager.executeSteps('s-back-lock', {
      steps: ['[use computer]', 'Click in the dialog', '[use browser]', 'Click the heading'],
    });

    expect(holders).toEqual(['s-back-lock']);
    expect(lockWhenPageStepRan).toBe(false);
    expect(managed(manager, 's-back-lock').surface).toBe('browser');
    expect(managed(manager, 's-back-lock').computerLockHeld).toBe(false);
  });

  it('release is safe: [use browser] in a later batch does not touch a lock another session took meanwhile', async () => {
    const manager = makeManager();
    await manager.executeSteps('s-back-idle', { steps: ['[use computer]'] });
    acquireComputerLock('s-busy', { lockPath });

    const response = await manager.executeSteps('s-back-idle', { steps: ['[use browser]'] });

    expect(response.status).toBe('passed');
    expect(managed(manager, 's-back-idle').surface).toBe('browser');
    expect(readComputerLock({ lockPath })!.sessionId).toBe('s-busy');
  });

  it('release is safe: closing a session idle on the computer surface does not touch a lock another session took meanwhile', async () => {
    const manager = makeManager();
    await manager.executeSteps('s-close-busy', { steps: ['[use computer]'] });
    acquireComputerLock('s-busy', { lockPath });

    await manager.closeSession('s-close-busy');

    expect(managed(manager, 's-close-busy')).toBeUndefined();
    expect(readComputerLock({ lockPath })!.sessionId).toBe('s-busy');
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
  it('releases a lock the session holds — a close that lands mid-run', async () => {
    const manager = makeManager();
    let heldBeforeClose: string | undefined;
    let lockFileAfterClose: boolean | undefined;
    executeComputerStepMock.mockImplementation(async (index, n, instruction) => {
      heldBeforeClose = readComputerLock({ lockPath })?.sessionId;
      await manager.closeSession('s-close');
      lockFileAfterClose = existsSync(lockPath);
      return passComputerStep(index, n, instruction);
    });

    await manager.executeSteps('s-close', { steps: ['[use computer]', 'Click'] });

    expect(heldBeforeClose).toBe('s-close');
    expect(lockFileAfterClose).toBe(false);
    expect(managed(manager, 's-close')).toBeUndefined();
  });

  it('removes a session idling on the computer surface, with no lock left behind', async () => {
    const manager = makeManager();
    await manager.executeSteps('s-close-idle', { steps: ['[use computer]'] });

    await manager.closeSession('s-close-idle');

    expect(existsSync(lockPath)).toBe(false);
    expect(managed(manager, 's-close-idle')).toBeUndefined();
  });

  it('does not release a lock this session never took', async () => {
    acquireComputerLock('s-owner', { lockPath });

    const other = makeManager();
    await other.executeSteps('s-other', { steps: ['Click something'] });
    await other.closeSession('s-other');

    expect(readComputerLock({ lockPath })!.sessionId).toBe('s-owner');
  });
});

// ---------------------------------------------------------------------------
// The PROJECT decides, not the server (§5.1 item 1, §5.10)
//
// Measured defect: a server started from a checkout whose `steptix.config.json`
// has no `desktop` key refused `[use computer]` for a test file whose project
// config said `"desktop": {"enabled": true}` — the server read its own startup
// config, because `resolveRunSettings` rebuilds `runConfig` by spreading it.
// These tests drive the real `resolveProjectBundle` against a project written
// to disk, which is the only way to prove the value travelled.
// ---------------------------------------------------------------------------

let projectDir: string;

/**
 * A project on disk: `steptix.config.json` with the given sections, and a test
 * file under it for `testFilePath` to point at. The file's content is never
 * read for the steps (those come from the request), but it exists so the
 * code-behind lookup sees a real path.
 */
function writeProject(config: Record<string, unknown>): string {
  const root = mkdtempSync(path.join(projectDir, 'proj-'));
  writeFileSync(path.join(root, 'steptix.config.json'), JSON.stringify(config));
  mkdirSync(path.join(root, 'tests'), { recursive: true });
  const testFile = path.join(root, 'tests', 'print.md');
  writeFileSync(testFile, '# Print\n\n1. [use computer]\n');
  return testFile;
}

/** The `computer` context the step loop was handed — §5.10's three values. */
function computerContextOf(call = 0): any {
  return (executeComputerStepMock.mock.calls[call] as unknown as any[])[3].computer;
}

/** The browser config `launchBrowser` was called with. */
function launchConfig(call = 0): any {
  return (launchBrowserMock.mock.calls[call] as unknown[])[0];
}

beforeEach(() => {
  projectDir = mkdtempSync(path.join(os.tmpdir(), 'steptix-computer-project-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('desktop.enabled comes from the test file project, not the server', () => {
  it('a project that opted in is allowed by a server that did not', async () => {
    const holders = recordLockHolders();
    // The server's own config is the shipped default: desktop off.
    const manager = makeManager(configWith({ enabled: false }));
    const testFilePath = writeProject({ desktop: { enabled: true } });

    const response = await manager.executeSteps('s-project-on', {
      steps: ['[use computer]', 'Click Print in the dialog'],
      testFilePath,
    });

    expect(response.results[0]!.reasoning).not.toBe(COMPUTER_DISABLED_MESSAGE);
    expect(response.status).toBe('passed');
    expect(managed(manager, 's-project-on').surface).toBe('computer');
    // Past precondition 1: the adapter loaded and the lock was taken.
    expect(loadDesktopAdapter).toHaveBeenCalledTimes(1);
    expect(holders).toEqual(['s-project-on']);
  });

  it('a project that did NOT opt in is refused by a server that did', async () => {
    const manager = makeManager(configWith({ enabled: true }));
    const testFilePath = writeProject({ desktop: { enabled: false } });

    const response = await manager.executeSteps('s-project-off', {
      steps: ['[use computer]', 'Click Print'],
      testFilePath,
    });

    expect(response.status).toBe('failed');
    expect(response.results[0]!.reasoning).toBe(COMPUTER_DISABLED_MESSAGE);
    expect(managed(manager, 's-project-off').surface).toBe('browser');
    expect(loadDesktopAdapter).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(false);
  });

  // With no testFilePath the server's own answer decides: refused when it is
  // off ("desktop.enabled: false refuses it" above sends no testFilePath), and
  // allowed when it is on, as every run in this file without a project is.
});

describe('the §5.10 values reach the step loop from the project', () => {
  it('settleMs, maxImageWidth and reportScreenshots are the project values', async () => {
    // Every one of these differs from `baseConfig.desktop` above, so a value
    // that came off the server's config fails the assertion.
    const manager = makeManager();
    const testFilePath = writeProject({
      desktop: { enabled: true, settleMs: 42, maxImageWidth: 640, reportScreenshots: false },
    });

    await manager.executeSteps('s-ctx', {
      steps: ['[use computer]', 'Click Print in the dialog'],
      testFilePath,
    });

    expect(computerContextOf()).toMatchObject({
      settleMs: 42,
      maxImageWidth: 640,
      reportScreenshots: false,
    });
  });

  it('falls back to the project config defaults for keys it left out', async () => {
    const manager = makeManager();
    const testFilePath = writeProject({ desktop: { enabled: true } });

    await manager.executeSteps('s-ctx-default', {
      steps: ['[use computer]', 'Click Print'],
      testFilePath,
    });

    // The loaded project config's defaults (config/defaults.ts), not the
    // server's 400/0 above.
    expect(computerContextOf()).toMatchObject({
      settleMs: 300,
      maxImageWidth: 1600,
      reportScreenshots: true,
    });
  });

  it('with no testFilePath they are the server values, as before', async () => {
    const manager = makeManager();

    await manager.executeSteps('s-ctx-server', { steps: ['[use computer]', 'Click'] });

    expect(computerContextOf()).toMatchObject({
      settleMs: 0,
      maxImageWidth: 400,
      reportScreenshots: true,
    });
  });
});

describe('browser.launchArgs reaches the launch from the project (§5.10)', () => {
  it('the project args are passed to launchBrowser at step 1', async () => {
    const manager = makeManager();
    const testFilePath = writeProject({
      browser: { launchArgs: ['--disable-print-preview'] },
    });

    await manager.executeSteps('s-args', { steps: ['Click Print'], testFilePath });

    expect(launchBrowserMock).toHaveBeenCalledTimes(1);
    expect(launchConfig().launchArgs).toEqual(['--disable-print-preview']);
  });

  it('a project that names none keeps the server ones', async () => {
    const manager = makeManager({
      ...baseConfig,
      browser: { ...baseConfig.browser, launchArgs: ['--server-only'] },
    } as Config);
    const testFilePath = writeProject({ desktop: { enabled: true } });

    await manager.executeSteps('s-args-server', { steps: ['Click Print'], testFilePath });

    expect(launchConfig().launchArgs).toEqual(['--server-only']);
  });

  it('with no testFilePath the server ones are used, as before', async () => {
    const manager = makeManager({
      ...baseConfig,
      browser: { ...baseConfig.browser, launchArgs: ['--server-only'] },
    } as Config);

    await manager.executeSteps('s-args-nofile', { steps: ['Click Print'] });

    expect(launchConfig().launchArgs).toEqual(['--server-only']);
  });

  it('the launch still happens only at the first browser-surface step', async () => {
    const manager = makeManager();
    const testFilePath = writeProject({
      desktop: { enabled: true },
      browser: { launchArgs: ['--disable-print-preview'] },
    });

    await manager.executeSteps('s-args-late', {
      steps: ['[use computer]', 'Click Print in the dialog', '[use browser]', 'Click the heading'],
      testFilePath,
    });

    expect(launchBrowserMock).toHaveBeenCalledTimes(1);
    expect(launchConfig().launchArgs).toEqual(['--disable-print-preview']);
  });
});

// SPEC-web-survey-fixes.md §2.23: the survey's project set `blockAds`, and the
// server path launched with the server's `browser` section, so no run of it
// ever blocked an ad.
describe('browser.blockAds reaches the launch from the project', () => {
  it('the project setting is passed to launchBrowser', async () => {
    const manager = makeManager();
    const testFilePath = writeProject({ browser: { blockAds: true } });

    await manager.executeSteps('s-ads', { steps: ['Click Print'], testFilePath });

    expect(launchConfig().blockAds).toBe(true);
  });

  it('a project that says nothing keeps the server setting', async () => {
    const manager = makeManager({
      ...baseConfig,
      browser: { ...baseConfig.browser, blockAds: true },
    } as Config);
    const testFilePath = writeProject({ desktop: { enabled: true } });

    await manager.executeSteps('s-ads-server', { steps: ['Click Print'], testFilePath });

    expect(launchConfig().blockAds).toBe(true);
  });

  it('a project can turn it off where the server has it on', async () => {
    const manager = makeManager({
      ...baseConfig,
      browser: { ...baseConfig.browser, blockAds: true },
    } as Config);
    const testFilePath = writeProject({ browser: { blockAds: false } });

    await manager.executeSteps('s-ads-off', { steps: ['Click Print'], testFilePath });

    expect(launchConfig().blockAds).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §5.4 — a bracket directive nobody dispatched never reaches the model
// ---------------------------------------------------------------------------

describe('an undispatched [tool:] / [skill:] line fails on the computer surface (§5.4)', () => {
  /** Measured live: this exact step, with no `toolsDir`, was acted out by the
   *  model — Win+R, `calc`, Enter — on the real desktop. */
  const NO_TOOLS_MESSAGE =
    '[tool: open_calculator] was not run: this request carried no tools directory (toolsDir), ' +
    'so no tool is loaded';

  /** Every model call the session could make, on the mocked client. */
  function modelCalls(manager: SessionManager, id: string): number {
    const ai = managed(manager, id).aiClient;
    return ai.complete.mock.calls.length + ai.chat.mock.calls.length;
  }

  let toolsDir: string;
  beforeEach(() => {
    toolsDir = mkdtempSync(path.join(os.tmpdir(), 'steptix-computer-tools-'));
    // A catalogue with something in it, and nothing named `open_calculator`.
    writeFileSync(
      path.join(toolsDir, 'echo.ts'),
      "export default { name: 'echo', description: 'echo', parameters: {}, run() {} };\n",
    );
  });
  afterEach(() => {
    rmSync(toolsDir, { recursive: true, force: true });
  });

  it.each([
    ['[tool: open_calculator]'],
    ['Open the calculator [tool: open_calculator]'],
  ])('%s with no toolsDir: fails with the message, and nothing is asked of the model', async (step) => {
    const manager = makeManager();

    const response = await manager.executeSteps('s-tool-none', {
      steps: ['[use computer]', step, 'Click the equals button'],
    });

    expect(response.status).toBe('failed');
    expect(response.error!.message).toContain(NO_TOOLS_MESSAGE);
    expect(response.error!.message).toContain(
      'In computer mode a tool line is never handed to the model, because it would act it out on the real screen.',
    );
    expect(response.results[1]!.status).toBe('failed');
    expect(response.results[1]!.reasoning).toContain(NO_TOOLS_MESSAGE);
    // The step after it never ran either: the refusal stops the batch.
    expect(response.results).toHaveLength(2);
    expect(executeComputerStepMock).not.toHaveBeenCalled();
    expect(executeStepMock).not.toHaveBeenCalled();
    expect(modelCalls(manager, 's-tool-none')).toBe(0);
    expect(launchBrowserMock).not.toHaveBeenCalled();
  });

  it('an unknown tool name with a catalogue loaded fails with the catalogue\'s message, not the model', async () => {
    const manager = makeManager();

    const response = await manager.executeSteps('s-tool-unknown', {
      steps: ['[use computer]', '[tool: open_calculator]'],
      toolsDir,
    });

    expect(response.status).toBe('failed');
    expect(response.error!.message).toContain('Tool "open_calculator" not found in catalogue.');
    expect(executeComputerStepMock).not.toHaveBeenCalled();
    expect(modelCalls(manager, 's-tool-unknown')).toBe(0);
  });

  it('a raw [skill:] line with no skillsDir fails the same way', async () => {
    const manager = makeManager();

    const response = await manager.executeSteps('s-skill-raw', {
      steps: ['[use computer]', '[skill: open-calculator]'],
    });

    expect(response.status).toBe('failed');
    expect(response.error!.message).toContain(
      '[skill: open-calculator] was not run: this request carried no skills directory (skillsDir)',
    );
    expect(response.error!.message).toContain(
      'In computer mode a skill line is never handed to the model',
    );
    expect(executeComputerStepMock).not.toHaveBeenCalled();
    expect(modelCalls(manager, 's-skill-raw')).toBe(0);
  });

  it('a whole-step bracket that names no directive is refused too (§4.2)', async () => {
    const manager = makeManager();

    const response = await manager.executeSteps('s-bracket', {
      steps: ['[use computer]', '[calculator]'],
    });

    expect(response.status).toBe('failed');
    expect(response.error!.message).toContain('`[calculator]` is not one');
    expect(executeComputerStepMock).not.toHaveBeenCalled();
  });

  it('prose that merely mentions brackets still goes to the computer surface', async () => {
    const manager = makeManager();

    const response = await manager.executeSteps('s-prose', {
      steps: ['[use computer]', 'Verify the [optional] banner is gone'],
    });

    expect(response.status).toBe('passed');
    expect(executeComputerStepMock).toHaveBeenCalledTimes(1);
  });

  it('the page surface is unchanged: with no toolsDir the line still goes to the model as prose', async () => {
    const manager = makeManager();

    const response = await manager.executeSteps('s-tool-page', {
      steps: ['[tool: open_calculator]'],
    });

    expect(response.status).toBe('passed');
    expect(executeStepMock).toHaveBeenCalledTimes(1);
    expect(executeStepMock.mock.calls[0]![2]).toBe('[tool: open_calculator]');
    expect(executeComputerStepMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §5.9 — a run that pauses for a person gives the lock back
//
// The user's decision: a run waiting for a person must not hold the
// machine-wide mouse lock. Every pause inside a batch releases immediately
// before it announces itself, and nothing is taken back on resume except by
// the step boundary, at the next step that reads or drives the screen.
// ---------------------------------------------------------------------------

describe('a pause inside a batch gives the lock back (§5.9)', () => {
  /** Every model call the session could make, on the mocked client. */
  function modelCalls(manager: SessionManager, id: string): number {
    const ai = managed(manager, id).aiClient;
    return ai.complete.mock.calls.length + ai.chat.mock.calls.length;
  }

  /** The lock as a paused run left it, read when the pause was announced. */
  interface PauseSnapshot {
    event: RunEvent['type'];
    line: number;
    lockFile: boolean;
    holder: string | undefined;
    held: boolean | undefined;
  }

  /**
   * An event listener that records the lock at every pause announcement and
   * then resumes the run. The resume goes out on the next turn of the event
   * loop, because the run parks on its promise only after the event has been
   * emitted. `beforeResume` runs in between — another session taking the
   * lock while this one waits.
   */
  function resumeEveryPause(
    manager: SessionManager,
    sessionId: string,
    snapshots: PauseSnapshot[],
    opts: { mode?: 'continue' | 'into'; beforeResume?: () => void } = {},
  ): (e: RunEvent) => void {
    return (e) => {
      if (
        e.type !== 'step:awaiting' &&
        e.type !== 'tool:awaiting-debugger' &&
        e.type !== 'codebehind:awaiting-debugger'
      ) {
        return;
      }
      snapshots.push({
        event: e.type,
        line: e.line,
        lockFile: existsSync(lockPath),
        holder: readComputerLock({ lockPath })?.sessionId,
        held: managed(manager, sessionId).computerLockHeld,
      });
      setImmediate(() => {
        opts.beforeResume?.();
        if (e.type === 'step:awaiting') manager.submitRunControl(sessionId, opts.mode ?? 'continue');
        else manager.submitDebuggerAck(sessionId);
      });
    };
  }

  /**
   * A batch whose third step calls a section, with a breakpoint on a body
   * line. A section body lives in the test file but only exists after
   * expansion, so the client cannot trim at it and the SERVER pauses there —
   * the same server-side pause a skill-file breakpoint takes.
   *
   *     3. <main[0]>        10. Click Save    <- breakpoint
   *     4. <main[1]>        11. Click Close
   *     5. Save it
   */
  function sectionBatch(
    testFilePath: string,
    main: string[] = ['[use computer]', 'Click A', 'Save it'],
  ): Parameters<SessionManager['executeSteps']>[1] {
    return {
      steps: main,
      sourceLines: main.map((_, i) => i + 3),
      testFilePath,
      sections: {
        'save it': {
          name: 'Save it',
          headingLine: 9,
          steps: ['Click Save', 'Click Close'],
          stepLines: [10, 11],
        },
      },
      breakpointsByUri: { [testFilePath]: [10] },
    };
  }

  it('breakpoint: the lock file is absent while the run is parked, and the step it resumes on takes it back and passes', async () => {
    const holders = recordLockHolders();
    const manager = makeManager();
    const testFilePath = writeProject({ desktop: { enabled: true } });
    const snapshots: PauseSnapshot[] = [];

    const response = await manager.executeSteps(
      's-bp',
      sectionBatch(testFilePath),
      resumeEveryPause(manager, 's-bp', snapshots),
    );

    expect(response.status).toBe('passed');
    // Parked at line 10 with nothing held — `Click A` had held it a step ago.
    expect(snapshots).toEqual([
      { event: 'step:awaiting', line: 10, lockFile: false, holder: undefined, held: false },
    ]);
    // Held for every computer step: before the pause, the resumed step, and
    // the one after it.
    expect(holders).toEqual(['s-bp', 's-bp', 's-bp']);
    expect(executeComputerStepMock.mock.calls.map((call) => call[2])).toEqual([
      'Click A',
      'Click Save',
      'Click Close',
    ]);
    // Still on the surface, same adapter — the pause touched only the lock.
    expect(managed(manager, 's-bp').surface).toBe('computer');
    expect(loadDesktopAdapter).toHaveBeenCalledTimes(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('breakpoint: another session takes the lock during the pause, and the resumed step fails with §5.9 naming it, asking nothing of the model', async () => {
    const manager = makeManager();
    const testFilePath = writeProject({ desktop: { enabled: true } });
    const snapshots: PauseSnapshot[] = [];
    const events: RunEvent[] = [];
    const pauses = resumeEveryPause(manager, 's-bp-stolen', snapshots, {
      beforeResume: () => acquireComputerLock('s-other', { lockPath }),
    });

    const response = await manager.executeSteps('s-bp-stolen', sectionBatch(testFilePath), (e) => {
      events.push(e);
      pauses(e);
    });

    const message = computerLockInUseMessage({ pid: process.pid, sessionId: 's-other', since: '' });
    expect(snapshots).toHaveLength(1);
    expect(response.status).toBe('failed');
    expect(response.error!.message).toBe(message);
    const fail = events.find((e) => e.type === 'step:fail') as Extract<RunEvent, { type: 'step:fail' }>;
    expect(fail.line).toBe(10);
    expect(fail.error).toBe(message);
    expect(fail.surface).toBe('computer');
    // `Click A` ran before the pause; nothing ran after it — not the refused
    // step, and not the one behind it.
    expect(executeComputerStepMock.mock.calls.map((call) => call[2])).toEqual(['Click A']);
    expect(modelCalls(manager, 's-bp-stolen')).toBe(0);
    // The other session's lock is still its own.
    expect(readComputerLock({ lockPath })!.sessionId).toBe('s-other');
    expect(managed(manager, 's-bp-stolen').surface).toBe('computer');
  });

  it('breakpoint off the computer surface: paused with no lock held, nothing is touched and nothing throws', async () => {
    // Another session holds the lock the whole time; a page-surface pause must
    // not so much as read it.
    acquireComputerLock('s-other', { lockPath });
    const manager = makeManager();
    const testFilePath = writeProject({ desktop: { enabled: true } });
    const snapshots: PauseSnapshot[] = [];

    const response = await manager.executeSteps(
      's-bp-page',
      sectionBatch(testFilePath, ['Open the shop', 'Click A', 'Save it']),
      resumeEveryPause(manager, 's-bp-page', snapshots),
    );

    expect(response.status).toBe('passed');
    expect(snapshots).toEqual([
      { event: 'step:awaiting', line: 10, lockFile: true, holder: 's-other', held: undefined },
    ]);
    expect(executeStepMock.mock.calls.map((call) => call[2])).toEqual([
      'Open the shop',
      'Click A',
      'Click Save',
      'Click Close',
    ]);
    expect(executeComputerStepMock).not.toHaveBeenCalled();
    expect(readComputerLock({ lockPath })!.sessionId).toBe('s-other');
  });

  it('step mode: each after-step pause releases, a `Set` between takes nothing, and the next computer step takes it back', async () => {
    const holders = recordLockHolders();
    const manager = makeManager();
    const snapshots: PauseSnapshot[] = [];

    const response = await manager.executeSteps(
      's-step',
      {
        steps: ['[use computer]', 'Click A', 'Set {{file}} to "a.pdf"', 'Click B'],
        stepMode: 'into',
      },
      resumeEveryPause(manager, 's-step', snapshots, { mode: 'into' }),
    );

    expect(response.status).toBe('passed');
    // Paused before the `Set` (after `Click A`, which held the lock) and
    // before `Click B` (after the `Set`, which took none): free both times.
    expect(snapshots.map(({ lockFile, held }) => ({ lockFile, held }))).toEqual([
      { lockFile: false, held: false },
      { lockFile: false, held: false },
    ]);
    expect(holders).toEqual(['s-step', 's-step']);
    expect(existsSync(lockPath)).toBe(false);
  });

  describe('the tool debugger', () => {
    let toolsDir: string;
    beforeEach(() => {
      toolsDir = mkdtempSync(path.join(os.tmpdir(), 'steptix-computer-tool-debugger-'));
      // A tool that REGISTERS — `defineTool`, by absolute path — because this
      // one has to run, not merely sit in the catalogue.
      const toolsIndex = path.resolve(__dirname, '..', 'src', 'tools', 'index.ts').replace(/\\/g, '/');
      writeFileSync(
        path.join(toolsDir, 'echo.ts'),
        `import { defineTool } from '${toolsIndex}';\n` +
          "export default defineTool({ name: 'echo', description: 'echo', parameters: {}, outputs: {}, async run() {} });\n",
      );
    });
    afterEach(() => {
      rmSync(toolsDir, { recursive: true, force: true });
    });

    it('waiting for the debugger to attach releases, and the computer step after the tool takes it back', async () => {
      const holders: Array<string | undefined> = [];
      const manager = makeManager();
      executeComputerStepMock.mockImplementation(async (index, n, instruction) => {
        holders.push(readComputerLock({ lockPath })?.sessionId);
        // F11 onto the next line, delivered while this step runs — the
        // one-shot flag is read at the top of the NEXT iteration.
        if (instruction === 'Click A') manager.setPauseAtNextTool('s-tool', true);
        return passComputerStep(index, n, instruction);
      });
      const snapshots: PauseSnapshot[] = [];

      const response = await manager.executeSteps(
        's-tool',
        { steps: ['[use computer]', 'Click A', '[tool: echo]', 'Click B'], toolsDir },
        resumeEveryPause(manager, 's-tool', snapshots),
      );

      expect(response.error?.message).toBeUndefined();
      expect(response.status).toBe('passed');
      expect(snapshots).toEqual([
        { event: 'tool:awaiting-debugger', line: 3, lockFile: false, holder: undefined, held: false },
      ]);
      expect(holders).toEqual(['s-tool', 's-tool']);
      expect(existsSync(lockPath)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// §5.1 item 1 — the opt-in is read at every step that would touch the screen,
// not only at the first `[use computer]`
//
// Review finding: a session already on the computer surface kept driving the
// mouse after its project's owner set `desktop.enabled: false`. The project
// config is re-read every batch; three places skipped it — `[use computer]`
// re-entry, the step-boundary lock re-take, and a `runStart` that kept the
// computer surface.
// ---------------------------------------------------------------------------

describe('switching desktop.enabled off stops a session already on the computer surface', () => {
  /** Rewrite a project's config in place and move its mtime on, so the
   *  mtime-cached bundle re-reads it on the next batch. */
  function setDesktopEnabled(testFilePath: string, enabled: boolean): void {
    const configPath = path.join(path.dirname(path.dirname(testFilePath)), 'steptix.config.json');
    writeFileSync(configPath, JSON.stringify({ desktop: { enabled } }));
    const later = new Date(Date.now() + (enabled ? 10_000 : 5_000));
    utimesSync(configPath, later, later);
  }

  /** A session left on the computer surface by a passing batch, and then the
   *  owner switches computer mode off. */
  async function onComputerThenDisabled(manager: SessionManager, id: string): Promise<string> {
    const testFilePath = writeProject({ desktop: { enabled: true } });
    const first = await manager.executeSteps(id, {
      steps: ['[use computer]', 'Click A'],
      testFilePath,
    });
    expect(first.status).toBe('passed');
    expect(managed(manager, id).surface).toBe('computer');
    setDesktopEnabled(testFilePath, false);
    executeComputerStepMock.mockClear();
    return testFilePath;
  }

  function expectDroppedToBrowser(manager: SessionManager, id: string): void {
    const session = managed(manager, id);
    expect(session.surface).toBe('browser');
    expect(session.computerAdapter).toBeUndefined();
    expect(session.computerLockHeld).toBeFalsy();
    expect(existsSync(lockPath)).toBe(false);
  }

  it('a Continue: the next computer step fails with the disabled message, and the session drops to the browser', async () => {
    const manager = makeManager();
    const testFilePath = await onComputerThenDisabled(manager, 's-off-continue');
    const events: RunEvent[] = [];

    const response = await manager.executeSteps(
      's-off-continue',
      { steps: ['Click B', 'Click C'], testFilePath },
      (e) => events.push(e),
    );

    expect(response.status).toBe('failed');
    expect(response.error!.message).toBe(COMPUTER_DISABLED_MESSAGE);
    expect(response.results).toHaveLength(1);
    const fail = events.find((e) => e.type === 'step:fail') as Extract<RunEvent, { type: 'step:fail' }>;
    expect(fail.error).toBe(COMPUTER_DISABLED_MESSAGE);
    expect(executeComputerStepMock).not.toHaveBeenCalled();
    expect(launchBrowserMock).not.toHaveBeenCalled();
    expectDroppedToBrowser(manager, 's-off-continue');
  });

  it('[use computer] re-entry fails with the disabled message rather than taking the lock', async () => {
    const manager = makeManager();
    const testFilePath = await onComputerThenDisabled(manager, 's-off-reentry');

    const response = await manager.executeSteps('s-off-reentry', {
      steps: ['[use computer]', 'Click B'],
      testFilePath,
    });

    expect(response.status).toBe('failed');
    expect(response.results[0]!.reasoning).toBe(COMPUTER_DISABLED_MESSAGE);
    expect(executeComputerStepMock).not.toHaveBeenCalled();
    expectDroppedToBrowser(manager, 's-off-reentry');
  });

  it('a runStart below [use computer] does not keep the surface past the first computer step', async () => {
    const manager = makeManager();
    const testFilePath = await onComputerThenDisabled(manager, 's-off-runstart');

    const response = await manager.executeSteps('s-off-runstart', {
      steps: ['Click B'],
      fullSteps: ['[use computer]', 'Click A', 'Click B'],
      runStart: { stepIndex: 2 },
      testFilePath,
    });

    expect(response.status).toBe('failed');
    expect(response.error!.message).toBe(COMPUTER_DISABLED_MESSAGE);
    expect(executeComputerStepMock).not.toHaveBeenCalled();
    expect(launchBrowserMock).not.toHaveBeenCalled();
    expectDroppedToBrowser(manager, 's-off-runstart');
  });

  it('a condition judge on the computer surface is refused the same way, before it is asked', async () => {
    const manager = makeManager();
    const testFilePath = await onComputerThenDisabled(manager, 's-off-judge');

    const response = await manager.executeSteps('s-off-judge', {
      steps: ['If the Save dialog is open, then Click Save'],
      testFilePath,
    });

    expect(response.status).toBe('failed');
    expect(response.error!.message).toBe(COMPUTER_DISABLED_MESSAGE);
    expect(evaluateConditionsMock).not.toHaveBeenCalled();
    expectDroppedToBrowser(manager, 's-off-judge');
  });

  it('switched back on, the session enters again through [use computer]', async () => {
    const manager = makeManager();
    const testFilePath = await onComputerThenDisabled(manager, 's-off-on');
    await manager.executeSteps('s-off-on', { steps: ['Click B'], testFilePath });
    setDesktopEnabled(testFilePath, true);

    const response = await manager.executeSteps('s-off-on', {
      steps: ['[use computer]', 'Click C'],
      testFilePath,
    });

    expect(response.status).toBe('passed');
    expect(executeComputerStepMock.mock.calls.map((c) => c[2])).toEqual(['Click C']);
    // A fresh entry: the adapter was dropped, so it loaded again.
    expect(loadDesktopAdapter).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// §5.9 — a `[tool:]` line on the computer surface takes the lock
//
// Review finding: tools like the fixture `open_calculator` launch GUI
// programs. After a pause (or in a later batch) a `[tool:]` line ran without
// the lock and could take the front window from another session's
// computer-mode run.
// ---------------------------------------------------------------------------

describe('a [tool:] line on the computer surface takes the lock (§5.9)', () => {
  let toolsDir: string;
  /** What the tool saw of the lock file when it ran; absent if it never ran. */
  let markerPath: string;
  beforeEach(() => {
    toolsDir = mkdtempSync(path.join(os.tmpdir(), 'steptix-computer-tool-lock-'));
    markerPath = path.join(toolsDir, 'ran.txt');
    const toolsIndex = path.resolve(__dirname, '..', 'src', 'tools', 'index.ts').replace(/\\/g, '/');
    writeFileSync(
      path.join(toolsDir, 'launch.ts'),
      `import { defineTool } from '${toolsIndex}';\n` +
        "import { existsSync, readFileSync, writeFileSync } from 'node:fs';\n" +
        "export default defineTool({ name: 'launch', description: 'launch', parameters: {}, outputs: {},\n" +
        '  async run() {\n' +
        `    const lock = ${JSON.stringify(lockPath)};\n` +
        `    writeFileSync(${JSON.stringify(markerPath)}, ` +
        "existsSync(lock) ? JSON.parse(readFileSync(lock, 'utf8')).sessionId : 'none');\n" +
        '  } });\n',
    );
  });
  afterEach(() => {
    rmSync(toolsDir, { recursive: true, force: true });
  });

  it('the lock is held while the tool runs, in a batch after the one that entered computer mode', async () => {
    const manager = makeManager();
    await manager.executeSteps('s-tool-held', { steps: ['[use computer]'] });
    expect(existsSync(lockPath)).toBe(false);

    const response = await manager.executeSteps('s-tool-held', { steps: ['[tool: launch]'], toolsDir });

    expect(response.error?.message).toBeUndefined();
    expect(response.status).toBe('passed');
    expect(readFileSync(markerPath, 'utf8')).toBe('s-tool-held');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('another session holds the lock: the tool step fails with §5.9 and the tool never runs', async () => {
    const manager = makeManager();
    await manager.executeSteps('s-tool-busy', { steps: ['[use computer]'] });
    acquireComputerLock('s-busy', { lockPath });

    const response = await manager.executeSteps('s-tool-busy', { steps: ['[tool: launch]'], toolsDir });

    expect(response.status).toBe('failed');
    expect(response.error!.message).toBe(
      computerLockInUseMessage({ pid: process.pid, sessionId: 's-busy', since: '' }),
    );
    expect(existsSync(markerPath)).toBe(false);
    expect(readComputerLock({ lockPath })!.sessionId).toBe('s-busy');
  });

  it('after a tool-debugger pause the tool runs under the lock again', async () => {
    const manager = makeManager();
    let lockAtAttach: boolean | undefined;
    executeComputerStepMock.mockImplementation(async (index, n, instruction) => {
      if (instruction === 'Click A') manager.setPauseAtNextTool('s-tool-debug', true);
      return passComputerStep(index, n, instruction);
    });

    const response = await manager.executeSteps(
      's-tool-debug',
      { steps: ['[use computer]', 'Click A', '[tool: launch]'], toolsDir },
      (e) => {
        if (e.type !== 'tool:awaiting-debugger') return;
        lockAtAttach = existsSync(lockPath);
        setImmediate(() => manager.submitDebuggerAck('s-tool-debug'));
      },
    );

    expect(response.error?.message).toBeUndefined();
    expect(response.status).toBe('passed');
    expect(lockAtAttach).toBe(false);
    expect(readFileSync(markerPath, 'utf8')).toBe('s-tool-debug');
  });

  it('the browser surface is unchanged: a tool runs while another session holds the lock', async () => {
    acquireComputerLock('s-busy', { lockPath });
    const manager = makeManager();

    const response = await manager.executeSteps('s-tool-page', { steps: ['[tool: launch]'], toolsDir });

    expect(response.status).toBe('passed');
    expect(readFileSync(markerPath, 'utf8')).toBe('s-busy');
  });
});

// ---------------------------------------------------------------------------
// §4.5 — a skill call restores the caller's surface on return, `computer`
// included
//
// Review finding: restoring a computer-surface caller was a no-op. A caller in
// computer mode whose skill ran `[use browser]` came back on the browser, and
// its next desktop step went to the page.
// ---------------------------------------------------------------------------

describe('a skill that leaves computer mode hands the caller back its computer surface (§4.5)', () => {
  let skillsDir: string;
  beforeEach(() => {
    skillsDir = mkdtempSync(path.join(os.tmpdir(), 'steptix-computer-skills-'));
    writeFileSync(
      path.join(skillsDir, 'check-page.md'),
      ['---', 'type: skill', '---', '# check-page', '', '## Steps', '1. [use browser]', '2. Click the heading', ''].join('\n'),
    );
  });
  afterEach(() => {
    rmSync(skillsDir, { recursive: true, force: true });
  });

  const STEPS = ['[use computer]', '[skill: check-page]', 'Click Save in the dialog'];

  it('re-enters computer mode through [use computer]: the next caller step runs on the computer, under the lock', async () => {
    const holders = recordLockHolders();
    const manager = makeManager();
    const testFilePath = writeProject({ desktop: { enabled: true } });

    const response = await manager.executeSteps('s-skill-back', { steps: STEPS, skillsDir, testFilePath });

    expect(response.error?.message).toBeUndefined();
    expect(response.status).toBe('passed');
    // The skill body ran on the page…
    expect(executeStepMock.mock.calls.map((c) => c[2])).toEqual(['Click the heading']);
    // …and the caller's next step on the computer, holding the lock.
    expect(executeComputerStepMock.mock.calls.map((c) => c[2])).toEqual(['Click Save in the dialog']);
    expect(holders).toEqual(['s-skill-back']);
    // A full entry — the skill's [use browser] dropped the adapter — so §5.1's
    // preconditions ran again.
    expect(loadDesktopAdapter).toHaveBeenCalledTimes(2);
    expect(probeComputerCapture).toHaveBeenCalledTimes(2);
    expect(managed(manager, 's-skill-back').surface).toBe('computer');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('when the re-entry fails, the step it was restoring for fails with the enter error and nothing runs on it', async () => {
    const manager = makeManager();
    const testFilePath = writeProject({ desktop: { enabled: true } });
    // Another session takes the lock while the skill is on the browser.
    executeStepMock.mockImplementationOnce(async (_i, _n, instruction) => {
      acquireComputerLock('s-other', { lockPath });
      return { index: 1, instruction, status: 'passed', turns: [], durationMs: 1, retried: false };
    });
    const events: RunEvent[] = [];

    const response = await manager.executeSteps(
      's-skill-busy',
      { steps: STEPS, skillsDir, testFilePath },
      (e) => events.push(e),
    );

    const inUse = computerLockInUseMessage({ pid: process.pid, sessionId: 's-other', since: '' });
    expect(response.status).toBe('failed');
    expect(response.error!.message).toContain(inUse);
    expect(response.error!.message).toContain('returned from a skill');
    const fail = events.find((e) => e.type === 'step:fail') as Extract<RunEvent, { type: 'step:fail' }>;
    expect(fail.error).toContain(inUse);
    // The caller's step went nowhere: not to the computer, not to the page.
    expect(executeComputerStepMock).not.toHaveBeenCalled();
    expect(executeStepMock.mock.calls.map((c) => c[2])).toEqual(['Click the heading']);
    expect(readComputerLock({ lockPath })!.sessionId).toBe('s-other');
  });
});

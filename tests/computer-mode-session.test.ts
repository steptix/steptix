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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    'Computer mode needs the model to see the screen, but the TestBench Copilot bridge drops ' +
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

// ---------------------------------------------------------------------------
// The PROJECT decides, not the server (§5.1 item 1, §5.10)
//
// Measured defect: a server started from a checkout whose `aiui.config.json`
// has no `desktop` key refused `[use computer]` for a test file whose project
// config said `"desktop": {"enabled": true}` — the server read its own startup
// config, because `resolveRunSettings` rebuilds `runConfig` by spreading it.
// These tests drive the real `resolveProjectBundle` against a project written
// to disk, which is the only way to prove the value travelled.
// ---------------------------------------------------------------------------

let projectDir: string;

/**
 * A project on disk: `aiui.config.json` with the given sections, and a test
 * file under it for `testFilePath` to point at. The file's content is never
 * read for the steps (those come from the request), but it exists so the
 * code-behind lookup sees a real path.
 */
function writeProject(config: Record<string, unknown>): string {
  const root = mkdtempSync(path.join(projectDir, 'proj-'));
  writeFileSync(path.join(root, 'aiui.config.json'), JSON.stringify(config));
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
  projectDir = mkdtempSync(path.join(os.tmpdir(), 'aiui-computer-project-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('desktop.enabled comes from the test file project, not the server', () => {
  it('a project that opted in is allowed by a server that did not', async () => {
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
    expect(readComputerLock({ lockPath })!.sessionId).toBe('s-project-on');
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

  it('with no testFilePath the server own answer still decides', async () => {
    const manager = makeManager(configWith({ enabled: false }));

    const response = await manager.executeSteps('s-no-file', { steps: ['[use computer]'] });

    expect(response.status).toBe('failed');
    expect(response.results[0]!.reasoning).toBe(COMPUTER_DISABLED_MESSAGE);
  });
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
    toolsDir = mkdtempSync(path.join(os.tmpdir(), 'aiui-computer-tools-'));
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

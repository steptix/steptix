/**
 * `config.viewport` on the wire (stories/per-test-viewport.md §3/§4/§10).
 *
 * Driven over real HTTP through the real app, per the house rule for a
 * server-delivered feature: the route builds its `StepRequest` from an explicit
 * field list, so widening the types alone compiles cleanly and can still drop
 * the value before it ever reaches the session manager.
 *
 * Every assertion is on **what `launchBrowser` was handed** rather than on what
 * was stored. A raw spec could be retained on the session perfectly and never
 * applied — the launch used to take the server's startup browser config
 * wholesale, with only `video` per-project — and a test that read the stored
 * slice would pass with the feature doing nothing.
 *
 * The two silent-in-production cases get their own tests: an invalid value must
 * fail with NO browser launched (a leaked window per bad edit is how a machine
 * ends up with forty Chromes), and a concurrent session without the key on the
 * same server must be untouched.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Express } from 'express';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';

// ---------------------------------------------------------------------------
// Mocks — mirrors api-server-run-settings.test.ts so no real browser or AI is
// involved. `launchBrowser` is the one that matters here: it is the seam this
// whole story lands on.
// ---------------------------------------------------------------------------

const mockPage = {
  url: vi.fn(() => 'https://example.com'),
  title: vi.fn(async () => 'Example'),
  goto: vi.fn(async () => null),
};

const mockPageTracker = { getActive: vi.fn(() => mockPage as never) };

const mockBrowserSession = {
  browser: { isConnected: vi.fn(() => true) },
  context: {},
  page: mockPage,
  pageTracker: mockPageTracker,
};

const launchBrowserMock = vi.fn(async () => ({ ...mockBrowserSession }));

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
    launchBrowser: (...args: unknown[]) => launchBrowserMock(...(args as [])),
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
}));

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: vi.fn(async () => ({ files: [], combined: '' })),
}));

vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    config = { model: 'mock-model' };
    chat = vi.fn(async () => '{}');
    setAiPolicy = vi.fn();
    syncAuth = vi.fn(() => null);
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
  buildReportBaseName: vi.fn((r: { testName: string }) => r.testName),
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

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { createApiServer } from '../src/server/api-server.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { executeStep } from '../src/runner/step-executor.js';
import { listenFetchable } from './listen-fetchable.cjs';

const stepMock = vi.mocked(executeStep);

const API_KEY = 'viewport-key';

/**
 * The server's own config, chosen so a per-test viewport is OBSERVABLE.
 *
 * `viewport`/`windowSize` are deliberately NOT 390×844 and `fixedViewport` is
 * deliberately absent: against a server already pinned to phone size, every
 * assertion below would pass with the feature unimplemented (§10's
 * minimum-scenario rule).
 */
const testConfig: Config = {
  ...DEFAULT_CONFIG,
  ai: { ...DEFAULT_CONFIG.ai, model: 'server/base-model', apiKey: 'server-ai-key' },
  browser: {
    ...DEFAULT_CONFIG.browser,
    headed: false,
    viewport: { width: 1280, height: 720 },
    windowSize: { width: 1600, height: 1000 },
  },
  server: { ...DEFAULT_CONFIG.server, host: '127.0.0.1', port: 0, apiKey: API_KEY },
  logging: { ...DEFAULT_CONFIG.logging, consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
};

let server: Server;
let baseUrl: string;

async function listenOnRandomPort(app: Express): Promise<{ server: Server; baseUrl: string }> {
  const started = createServer(app);
  await listenFetchable(started, '127.0.0.1');
  const addr = started.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { server: started, baseUrl: `http://127.0.0.1:${port}` };
}

/** POST a one-step batch to `sessionId`. Returns status + parsed body. */
async function run(
  sessionId: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/sessions/${sessionId}/steps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ steps: ['do a thing'], sourceLines: [1], ...body }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The `BrowserConfig` `launchBrowser` was handed on the Nth (0-based) launch. */
function launchedBrowserConfig(call = 0): Config['browser'] {
  const args = launchBrowserMock.mock.calls[call];
  expect(args, `no launchBrowser call #${call}`).toBeDefined();
  return (args as unknown as [Config['browser']])[0];
}

let unique = 0;
/** The whole `Config` the step executor was handed on its first call. The
 *  mid-test `openBrowser` action relaunches from `config.browser`, so this is
 *  what decides whether a test's SECOND browser matches its first (§2). */
function executorConfig(call = 0): Config {
  const args = stepMock.mock.calls[call];
  expect(args, `no executeStep call #${call}`).toBeDefined();
  return (args![3] as unknown as { config: Config }).config;
}

/** A session id nothing else in this file has used — sessions are keyed by id
 *  and survive across tests, so a reused one would skip the launch entirely. */
function sessionId(label: string): string {
  return `vp-${label}-${++unique}`;
}

beforeAll(async () => {
  const { app } = createApiServer(testConfig);
  ({ server, baseUrl } = await listenOnRandomPort(app));
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

beforeEach(() => {
  launchBrowserMock.mockClear();
  stepMock.mockClear();
});

// ---------------------------------------------------------------------------
// The happy path (§3 → §4)
// ---------------------------------------------------------------------------

describe('config.viewport reaching the launch', () => {
  it('resolves a preset and launches with the exact fixedViewport', async () => {
    const { status } = await run(sessionId('preset'), { config: { viewport: 'mobile' } });
    expect(status).toBe(200);

    expect(launchBrowserMock).toHaveBeenCalledTimes(1);
    expect(launchedBrowserConfig().fixedViewport).toEqual({ width: 390, height: 844 });
  });
  // Every spelling the resolver accepts reaches the launch by this one seam;
  // which spellings it accepts (the explicit `767x1024` among them) is
  // tests/viewport-config.test.ts's to pin.

  it('leaves every other browser setting exactly as the server has it', async () => {
    // The merge must be complete, or a per-test viewport quietly blanks the
    // settings nobody asked to change — the same risk the run-settings story
    // names, at a different seam.
    await run(sessionId('complete'), { config: { viewport: 'mobile' } });

    const launched = launchedBrowserConfig();
    expect(launched.viewport).toEqual(testConfig.browser.viewport);
    expect(launched.windowSize).toEqual(testConfig.browser.windowSize);
    expect(launched.headed).toBe(testConfig.browser.headed);
    expect(launched.browser).toBe(testConfig.browser.browser);
    expect(launched.domNoiseReduction).toEqual(testConfig.browser.domNoiseReduction);
  });

  it("never mutates the server's own config", async () => {
    // §4: concurrent sessions without the key are untouched, and this is the
    // mechanism — a fresh object per launch, not a write-through.
    await run(sessionId('isolation'), { config: { viewport: 'tablet' } });
    expect(testConfig.browser.fixedViewport).toBeUndefined();
  });

  it('names the size and its source on the launch, for the §4 log line', async () => {
    await run(sessionId('log'), { config: { viewport: 'mobile' } });

    const overrides = launchBrowserMock.mock.calls[0]![2] as { viewportSource?: string };
    expect(overrides.viewportSource).toBe('mobile, from test config');
  });

  it("hands the size to the EXECUTOR too, so the test's second browser matches", async () => {
    // §2's inheritance clause, and the one place it can silently break on the
    // server path: the executor's `config` is rebuilt from the SERVER's startup
    // config on every batch, so the launch can be perfectly mobile while a
    // mid-test `openBrowser` comes up at desktop size.
    await run(sessionId('inherit'), { config: { viewport: 'mobile' } });
    expect(executorConfig().browser.fixedViewport).toEqual({ width: 390, height: 844 });
  });

  it('keeps handing it over on LATER batches of the same session', async () => {
    // A reused session sends no `config` (write-once), so a second batch has
    // only the retained raw spec to work from. Without the retention this is
    // where the size would quietly disappear mid-run.
    const id = sessionId('inherit-later');
    await run(id, { config: { viewport: 'mobile' } });
    stepMock.mockClear();
    await run(id);

    expect(executorConfig().browser.fixedViewport).toEqual({ width: 390, height: 844 });
  });
});

// ---------------------------------------------------------------------------
// A session that says nothing (§4, and the "concurrent sibling" clause)
// ---------------------------------------------------------------------------

describe('a session without the key', () => {
  it('launches with the startup config and no fixedViewport at all', async () => {
    const { status } = await run(sessionId('none'));
    expect(status).toBe(200);

    const launched = launchedBrowserConfig();
    expect(launched.fixedViewport).toBeUndefined();
    expect(launched.viewport).toEqual({ width: 1280, height: 720 });
    // Not merely absent-valued — the key must not be present at all, or a
    // `'fixedViewport' in config` check downstream reads it as "asked for".
    expect('fixedViewport' in launched).toBe(false);
  });

  it('is unaffected by a sibling session that DID ask for one', async () => {
    // The story's third verification rule, at the seam that can prove it: one
    // server, two sessions, one size each.
    await run(sessionId('sibling-mobile'), { config: { viewport: 'mobile' } });
    await run(sessionId('sibling-plain'));

    expect(launchedBrowserConfig(0).fixedViewport).toEqual({ width: 390, height: 844 });
    expect(launchedBrowserConfig(1).fixedViewport).toBeUndefined();
  });

  it('gets no viewportSource, so the log line stays exactly as it was', async () => {
    await run(sessionId('nolog'));
    const overrides = launchBrowserMock.mock.calls[0]![2] as { viewportSource?: string };
    expect(overrides.viewportSource).toBeUndefined();
  });

  it('hands the executor a config with no fixedViewport either', async () => {
    await run(sessionId('noexec'));
    expect(executorConfig().browser.fixedViewport).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Refusals — before any browser exists (§3)
// ---------------------------------------------------------------------------

describe('an invalid value', () => {
  // Both refusal kinds, malformed and out of range, take the same throw out of
  // the resolver; the no-launch half is shown for each. What each message
  // says is tests/viewport-config.test.ts's to pin.
  it.each([
    ['malformed', '390'],
    ['out of range', '50x50'],
  ])('fails the batch with the §1 error and launches NOTHING (%s)', async (_kind, viewport) => {
    const { status, body } = await run(sessionId('bad'), { config: { viewport } });

    expect(status).toBe(500);
    expect(String(body['error'])).toContain(`Invalid '## Config: viewport: ${viewport}'`);
    expect(String(body['error'])).toContain('mobile | tablet | desktop');
    // The half that only this test can see: validation runs BEFORE the launch,
    // so a rejected edit leaves no window behind.
    expect(launchBrowserMock).not.toHaveBeenCalled();
  });

  it('treats a blank value as absent rather than as an error', async () => {
    // A half-written `- viewport:` line should not be worse than no line.
    const { status } = await run(sessionId('blank'), { config: { viewport: '   ' } });
    expect(status).toBe(200);
    expect(launchedBrowserConfig().fixedViewport).toBeUndefined();
  });
});

describe('viewport + cdp in one file', () => {
  it('is refused, naming both keys, with nothing attached to', async () => {
    const { status, body } = await run(sessionId('cdp'), {
      config: { viewport: 'mobile', cdp: { port: 9222 } },
    });

    expect(status).toBe(500);
    const error = String(body['error']);
    expect(error).toContain("'## Config: viewport: mobile'");
    expect(error).toContain("'## Config: cdp: 9222'");
    expect(launchBrowserMock).not.toHaveBeenCalled();
  });

  it('still attaches when only cdp is asked for', async () => {
    // The control: the refusal is about the pairing, not about CDP.
    const { status } = await run(sessionId('cdp-only'), { config: { cdp: { port: 9222 } } });
    expect(status).toBe(200);
    expect(launchBrowserMock.mock.calls[0]![1]).toEqual({ port: 9222 });
  });
});

// ---------------------------------------------------------------------------
// Write-once, unchanged by this story (§3)
// ---------------------------------------------------------------------------

describe('write-once semantics are untouched', () => {
  it('a second batch carrying config is still refused, viewport or not', async () => {
    const id = sessionId('writeonce');
    expect((await run(id, { config: { viewport: 'mobile' } })).status).toBe(200);

    const second = await run(id, { config: { viewport: 'tablet' } });
    expect(second.status).toBe(400);
    expect(String(second.body['error'])).toContain('first request');
    // And the live session's browser was not relaunched behind the refusal.
    expect(launchBrowserMock).toHaveBeenCalledTimes(1);
  });
});

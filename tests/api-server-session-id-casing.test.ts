/**
 * Session ids that are Windows paths must not split on drive-letter casing.
 *
 * Steptix's session ids ARE file paths (`uri.fsPath`, which lower-cases the
 * drive letter; batch runs append `::run-N`), while a CLI, MCP or test-harness
 * caller spells the same file with an uppercase drive. Observed 2026-08-25: a
 * live-test cleanup's `DELETE /sessions/:id` no-oped on the other spelling and
 * left browsers behind. The fix normalises the session map's KEY the way
 * `compileLockKey` normalises file paths — win32 only, and only for ids that
 * look like Windows paths, so `compile:<uuid>` and arbitrary names stay
 * case-sensitive.
 *
 * Seam test through the real api-server + session manager (browser, executor
 * and AI mocked) — the bug lives in the route→manager lookup, and a unit test
 * of a key helper would not prove the routes use it.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Express } from 'express';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';

// ---------------------------------------------------------------------------
// Mocks — mirrors api-server-content.test.ts so no real browser or AI runs
// ---------------------------------------------------------------------------

const mockPage = {
  url: vi.fn(() => 'https://example.com/dashboard'),
  title: vi.fn(async () => 'Dashboard'),
  goto: vi.fn(async () => null),
};

const mockPageTracker = { getActive: vi.fn(() => mockPage as any) };

const mockBrowserSession = {
  browser: { isConnected: vi.fn(() => true) },
  context: {},
  page: mockPage,
  pageTracker: mockPageTracker,
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

const API_KEY = 'session-casing-key';

const testConfig: Config = {
  ...DEFAULT_CONFIG,
  browser: { ...DEFAULT_CONFIG.browser, headed: false },
  server: { ...DEFAULT_CONFIG.server, host: '127.0.0.1', port: 0, apiKey: API_KEY },
  logging: { ...DEFAULT_CONFIG.logging, consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
};

let server: Server;
let baseUrl: string;

async function listenOnRandomPort(app: Express): Promise<{ server: Server; baseUrl: string }> {
  const started = createServer(app);
  await new Promise<void>((resolve) => { started.listen(0, '127.0.0.1', () => resolve()); });
  const addr = started.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { server: started, baseUrl: `http://127.0.0.1:${port}` };
}

beforeAll(async () => {
  const { app } = createApiServer(testConfig);
  ({ server, baseUrl } = await listenOnRandomPort(app));
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${baseUrl}${p}`, opts);
  return { status: res.status, body: await res.json() };
}

/** Create a session by running one (mocked) step through it. */
async function createSession(id: string): Promise<void> {
  const { status } = await api('POST', `/sessions/${encodeURIComponent(id)}/steps`, {
    steps: ['do a thing'],
  });
  expect(status).toBe(200);
}

const get = (id: string) => api('GET', `/sessions/${encodeURIComponent(id)}`);
const del = (id: string) => api('DELETE', `/sessions/${encodeURIComponent(id)}`);

/** Session ids currently open, from the list route. */
async function openIds(): Promise<string[]> {
  const { status, body } = await api('GET', '/sessions');
  expect(status).toBe(200);
  return (body.sessions as Array<{ sessionId: string }>).map((s) => s.sessionId);
}

// The casing rule is win32-only, like `compileLockKey`: on POSIX two casings
// of a path are genuinely different files, so these cases would rightly fail.
describe.runIf(process.platform === 'win32')('path-shaped session ids on win32', () => {
  it('DELETE with the other drive-letter casing closes the session', async () => {
    const lower = 'c:\\fake\\aitests\\checkout.md';
    const upper = 'C:\\fake\\aitests\\checkout.md';
    await createSession(lower);

    // The other spelling finds it…
    expect((await get(upper)).status).toBe(200);

    // …and closing by the other spelling actually closes it. (The DELETE
    // response is 200 either way — the proof is that the session is GONE.)
    expect((await del(upper)).status).toBe(200);
    expect((await get(lower)).status).toBe(404);
    expect((await get(upper)).status).toBe(404);
    expect(await openIds()).not.toContain(lower);
  });

  it('two spellings of one file are one session, not two', async () => {
    const upper = 'C:\\fake\\aitests\\orders.md';
    const lower = 'c:\\fake\\aitests\\orders.md';
    await createSession(upper);
    await createSession(lower);

    const matching = (await openIds()).filter((id) => id.toLowerCase() === lower);
    expect(matching).toHaveLength(1);

    await del(lower);
    expect((await get(upper)).status).toBe(404);
  });

  it('the ::run-N batch suffix rides the same rule', async () => {
    const lower = 'c:\\fake\\aitests\\batch.md::run-3';
    const upper = 'C:\\fake\\aitests\\batch.md::run-3';
    await createSession(lower);
    expect((await del(upper)).status).toBe(200);
    expect((await get(lower)).status).toBe(404);
  });

  it('a UNC-path id normalises too', async () => {
    const one = '\\\\build-server\\tests\\smoke.md';
    const other = '\\\\BUILD-SERVER\\tests\\smoke.md';
    await createSession(one);
    expect((await get(other)).status).toBe(200);
    await del(other);
    expect((await get(one)).status).toBe(404);
  });

  it('last-run info follows the normalised key', async () => {
    const lower = 'c:\\fake\\aitests\\lastrun.md';
    const upper = 'C:\\fake\\aitests\\lastrun.md';
    await createSession(lower);

    const { status, body } = await api('GET', `/sessions/${encodeURIComponent(upper)}/last-run`);
    expect(status).toBe(200);
    expect(body.finalized).toBe(true);

    await del(lower);
  });
});

describe('non-path session ids', () => {
  it('stay case-sensitive on every platform', async () => {
    await createSession('MySession');
    expect((await get('mysession')).status).toBe(404);
    expect((await get('MySession')).status).toBe(200);
    await del('MySession');
    expect((await get('MySession')).status).toBe(404);
  });
});

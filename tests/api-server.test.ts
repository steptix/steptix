import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';

// ---------------------------------------------------------------------------
// Mocks — same dependencies as session-manager tests so no real browser launches
// ---------------------------------------------------------------------------

const mockPage = {
  url: vi.fn(() => 'https://example.com'),
  title: vi.fn(async () => 'Example Page'),
  goto: vi.fn(async () => null),
};

const mockPageTracker = {
  getActive: vi.fn(() => mockPage as any),
};

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
    constructor(initialSession: typeof mockBrowserSession) {
      this.getActive = vi.fn(() => initialSession);
      this.closeAll = vi.fn(async () => {});
    }
  }
  return {
    launchBrowser: vi.fn(async () => ({ ...mockBrowserSession })),
    PageTracker: vi.fn(),
    BrowserTracker,
  };
});

vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: vi.fn(async (): Promise<StepResult> => ({
    index: 1,
    instruction: 'mock step',
    status: 'passed',
    turns: [{ turnNumber: 1, attemptNumber: 1, timestamp: new Date().toISOString(), aiInteractions: [], subActions: [{ index: 1, action: { action: 'click', description: 'click' }, durationMs: 10 }] }],
    durationMs: 100,
    retried: false,
    aiExplanation: 'Did the thing',
  })),
}));

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: vi.fn(async () => ({ files: [], combined: '' })),
}));

vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    chat = vi.fn(async () => '{}');
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
}));

vi.mock('../src/browser/screenshot.js', () => ({
  captureScreenshot: vi.fn(async () => ({ base64: 'fakeBase64' })),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
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

// ---------------------------------------------------------------------------
// Config fixture
// ---------------------------------------------------------------------------

const API_KEY = 'test-api-key-123';

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
  tests: {
    dir: './tests',
    contextDir: './context',
    pattern: '**/*.md',
  },
  execution: {
    timeout: 30_000,
    retries: 1,
    screenshotOnFailure: true,
    promptOnAmbiguity: false,
    maxTurns: 5,
  },
  reports: {
    outputDir: './reports',
    includeScreenshots: true,
    includeDomSnapshots: true,
    includeAiReasoning: true,
    embedScreenshots: true,
  },
  api: {
    specsDir: './specs',
    requestTimeout: 30_000,
    redactSensitive: true,
  },
  server: {
    host: '127.0.0.1',
    port: 0, // Will be overridden by random port
    apiKey: API_KEY,
  },
  cache: {
    enabled: false,
    dir: '.cache',
  },
  logging: {
    consoleLogLevel: 'silent',
    serverFileLogLevel: 'off',
  },
};

// ---------------------------------------------------------------------------
// Helper — start/stop server on a random port
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;

async function startTestServer(): Promise<void> {
  const { app } = createApiServer(testConfig);
  server = createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
}

async function stopTestServer(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/** Helper to make requests with common headers */
async function api(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const opts: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      ...headers,
    },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, opts);
  const json = await res.json();
  return { status: res.status, body: json };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('API Server', () => {
  beforeAll(async () => {
    await startTestServer();
  });

  afterAll(async () => {
    await stopTestServer();
  });

  describe('authentication', () => {
    it('returns 401 when no x-api-key header', async () => {
      const res = await fetch(`${baseUrl}/sessions`, {
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toContain('Unauthorized');
    });

    it('returns 401 when wrong x-api-key', async () => {
      const res = await fetch(`${baseUrl}/sessions`, {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'wrong-key',
        },
      });
      expect(res.status).toBe(401);
    });

    it('returns 200 when correct x-api-key', async () => {
      const { status } = await api('GET', '/sessions');
      expect(status).toBe(200);
    });
  });

  describe('POST /sessions/:id/steps', () => {
    it('creates session and returns results', async () => {
      const { status, body } = await api('POST', '/sessions/test-session/steps', {
        steps: ['Click the login button'],
      });

      expect(status).toBe(200);
      expect(body.sessionId).toBe('test-session');
      expect(body.status).toBe('passed');
      expect(body.stepsCompleted).toBe(1);
      expect(body.stepsTotal).toBe(1);
      expect(body.results).toHaveLength(1);
      expect(body.error).toBeNull();
    });

    // Regression: the server must PARSE `envName` off the request body and run
    // server-side `${env.X}` / `${data.X}` interpolation. This crosses the full
    // HTTP → api-server body-parse → session-manager seam (the earlier unit
    // tests called the resolver directly and never exercised the body parse,
    // which is exactly where envName was being dropped).
    it('parses envName + interpolates ${data.X} server-side (would 500 on a missing path)', async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'aiui-apienv-'));
      try {
        writeFileSync(path.join(root, 'aiui.config.json'), JSON.stringify({ tests: { dataDir: 'data' } }));
        writeFileSync(path.join(root, '.env.uat'), 'X=1\n');
        mkdirSync(path.join(root, 'data'), { recursive: true });
        writeFileSync(path.join(root, 'data', 'uat.json'), JSON.stringify({ url: 'https://example.test/' }));

        // Reference a key that does NOT exist. With envName parsed, interpolation
        // throws "Unknown data path" → 500. If envName were dropped (the bug),
        // the literal would pass through to the mock step and return 200.
        const { status, body } = await api('POST', '/sessions/env-regression/steps', {
          steps: ['Go to ${data.does_not_exist}'],
          sourceLines: [1],
          envName: 'uat',
          testFilePath: path.join(root, 'tests', 't.md'),
        });

        expect(status).toBe(500);
        expect(String(body.error)).toMatch(/does_not_exist/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('resolves ${data.X} to the data-file value when envName is sent', async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'aiui-apienv2-'));
      try {
        writeFileSync(path.join(root, 'aiui.config.json'), JSON.stringify({ tests: { dataDir: 'data' } }));
        writeFileSync(path.join(root, '.env.uat'), 'X=1\n');
        mkdirSync(path.join(root, 'data'), { recursive: true });
        writeFileSync(path.join(root, 'data', 'uat.json'), JSON.stringify({ url: 'https://example.test/' }));

        const { status, body } = await api('POST', '/sessions/env-ok/steps', {
          steps: ['Navigate to ${data.url}'],
          sourceLines: [1],
          envName: 'uat',
          testFilePath: path.join(root, 'tests', 't.md'),
        });

        expect(status).toBe(200);
        expect(body.status).toBe('passed');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('returns outputSources alongside outputs, tagging parameters', async () => {
      const { status, body } = await api('POST', '/sessions/sources-1/steps', {
        steps: ['Click the login button'],
        parameters: { user: 'bob' },
      });

      expect(status).toBe(200);
      expect(body).toHaveProperty('outputs');
      expect(body).toHaveProperty('outputSources');
      expect(body.outputs).toMatchObject({ user: 'bob' });
      expect(body.outputSources).toMatchObject({ user: 'parameter' });
    });

    // Regression: a test's own frontmatter dataSources (sent by the client)
    // must resolve `${<name>.X}` on the SERVER path, not just the CLI parse
    // path. Resolved relative to testFilePath's dir; needs an active env (same
    // as the CLI — the `${...}` pass only runs when an env is selected).
    it('resolves test-level ${name.X} dataSources sent on the request', async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'aiui-ds-'));
      try {
        writeFileSync(path.join(root, 'aiui.config.json'), JSON.stringify({ tests: { dataDir: 'data' } }));
        writeFileSync(path.join(root, '.env.local'), 'X=1\n');
        mkdirSync(path.join(root, 'shared'), { recursive: true });
        writeFileSync(path.join(root, 'shared', 'catalog.json'), JSON.stringify({ site: { url: 'https://cat.test/' } }));

        // Valid path → step passes (200).
        const ok = await api('POST', '/sessions/ds-ok/steps', {
          steps: ['Go to ${catalog.site.url}'],
          sourceLines: [1],
          envName: 'local',
          testFilePath: path.join(root, 'tests', 't.md'),
          dataSources: { catalog: '../shared/catalog.json' },
        });
        expect(ok.status).toBe(200);
        expect(ok.body.status).toBe('passed');

        // Missing key → interpolation throws (500), proving the namespace was
        // registered server-side (a dropped dataSources map would pass through).
        const miss = await api('POST', '/sessions/ds-miss/steps', {
          steps: ['Go to ${catalog.nope}'],
          sourceLines: [1],
          envName: 'local',
          testFilePath: path.join(root, 'tests', 't.md'),
          dataSources: { catalog: '../shared/catalog.json' },
        });
        expect(miss.status).toBe(500);
        expect(String(miss.body.error)).toMatch(/nope/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('rejects a reserved dataSource name (env/data) loudly instead of shadowing', async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'aiui-ds-res-'));
      try {
        writeFileSync(path.join(root, 'aiui.config.json'), JSON.stringify({ tests: { dataDir: 'data' } }));
        writeFileSync(path.join(root, '.env.local'), 'X=1\n');
        mkdirSync(path.join(root, 'shared'), { recursive: true });
        writeFileSync(path.join(root, 'shared', 'catalog.json'), JSON.stringify({ x: 1 }));

        const res = await api('POST', '/sessions/ds-reserved/steps', {
          steps: ['Go to ${data.x}'],
          sourceLines: [1],
          envName: 'local',
          testFilePath: path.join(root, 'tests', 't.md'),
          dataSources: { data: '../shared/catalog.json' },
        });
        expect(res.status).toBe(500);
        expect(String(res.body.error)).toMatch(/reserved name/i);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('returns 400 when steps array is empty', async () => {
      const { status, body } = await api('POST', '/sessions/empty-steps/steps', {
        steps: [],
      });

      expect(status).toBe(400);
      expect(body.error).toContain('steps');
    });

    it('returns 400 when steps is not an array', async () => {
      const { status, body } = await api('POST', '/sessions/bad-steps/steps', {
        steps: 'not an array',
      });

      expect(status).toBe(400);
      expect(body.error).toContain('steps');
    });

    it('returns 400 when steps contains non-strings', async () => {
      const { status, body } = await api('POST', '/sessions/mixed-steps/steps', {
        steps: ['valid', 123],
      });

      expect(status).toBe(400);
      expect(body.error).toContain('strings');
    });

    it('returns 400 when session ID exceeds 1024 chars', async () => {
      // Limit was raised to 1024 to accommodate absolute file paths used as
      // session IDs by the VS Code extension (Windows paths can be long).
      const longId = 'x'.repeat(1025);
      const { status, body } = await api('POST', `/sessions/${longId}/steps`, {
        steps: ['Click button'],
      });

      expect(status).toBe(400);
      expect(body.error).toContain('1024');
    });

    it('returns 400 when config sent on non-first request', async () => {
      // First request with config
      await api('POST', '/sessions/config-test/steps', {
        steps: ['Step 1'],
        config: { baseUrl: 'https://example.com' },
      });

      // Second request with config should fail
      const { status, body } = await api('POST', '/sessions/config-test/steps', {
        steps: ['Step 2'],
        config: { baseUrl: 'https://other.com' },
      });

      expect(status).toBe(400);
      expect(body.error).toContain('Config can only be provided on the first request');
    });

    it('returns 400 when steps field is missing', async () => {
      const { status, body } = await api('POST', '/sessions/no-steps/steps', {
        parameters: { foo: 'bar' },
      });

      expect(status).toBe(400);
      expect(body.error).toContain('steps');
    });
  });

  describe('GET /sessions/:id', () => {
    it('returns session state for an active session', async () => {
      // Create a session first
      await api('POST', '/sessions/get-test/steps', {
        steps: ['Click something'],
      });

      const { status, body } = await api('GET', '/sessions/get-test');

      expect(status).toBe(200);
      expect(body.sessionId).toBe('get-test');
      expect(body.status).toBe('active');
      expect(body.totalStepsExecuted).toBeGreaterThanOrEqual(1);
      expect(body).toHaveProperty('outputs');
      expect(body).toHaveProperty('screenshot');
      expect(body).toHaveProperty('currentUrl');
    });

    it('returns 404 for nonexistent session', async () => {
      const { status, body } = await api('GET', '/sessions/nonexistent');

      expect(status).toBe(404);
      expect(body.error).toContain('not found');
    });
  });

  describe('GET /sessions', () => {
    it('returns list of active sessions', async () => {
      // Ensure at least one session exists (from prior tests)
      const { status, body } = await api('GET', '/sessions');

      expect(status).toBe(200);
      expect(body).toHaveProperty('sessions');
      expect(Array.isArray(body.sessions)).toBe(true);
      // There should be sessions from the tests above
      expect(body.sessions.length).toBeGreaterThan(0);

      const session = body.sessions[0];
      expect(session).toHaveProperty('sessionId');
      expect(session).toHaveProperty('status');
      expect(session).toHaveProperty('totalStepsExecuted');
    });
  });

  describe('URL-encoded session IDs', () => {
    it('session IDs with spaces work via URL encoding', async () => {
      const { status, body } = await api(
        'POST',
        `/sessions/${encodeURIComponent('my session')}/steps`,
        { steps: ['Click button'] },
      );

      expect(status).toBe(200);
      expect(body.sessionId).toBe('my session');
    });
  });

  describe('SSE streaming (?stream=1)', () => {
    /** Read SSE frames from a streaming response into an array of {event, data}. */
    async function readSseStream(
      res: Response,
    ): Promise<Array<{ event: string; data: any }>> {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const events: Array<{ event: string; data: any }> = [];
      let currentEvent = 'message';
      let currentData: string[] = [];

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (line === '') {
            if (currentData.length > 0 || currentEvent !== 'message') {
              try {
                events.push({ event: currentEvent, data: JSON.parse(currentData.join('\n')) });
              } catch {
                events.push({ event: currentEvent, data: currentData.join('\n') });
              }
            }
            currentEvent = 'message';
            currentData = [];
            continue;
          }
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = (colon < 0 ? '' : line.slice(colon + 1)).replace(/^ /, '');
          if (field === 'event') currentEvent = value;
          else if (field === 'data') currentData.push(value);
        }
      }
      return events;
    }

    it('emits step:start, step:pass, done frames in order', { timeout: 30_000 }, async () => {
      const res = await fetch(`${baseUrl}/sessions/stream-1/steps?stream=1`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ steps: ['Click', 'Wait'], sourceLines: [10, 20] }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const events = await readSseStream(res);
      const types = events.map((e) => e.event);

      // First step: start + pass
      expect(types).toContain('step:start');
      expect(types).toContain('step:pass');
      expect(types[types.length - 1]).toBe('done');

      // Source lines round-trip
      const startEvents = events.filter((e) => e.event === 'step:start');
      expect(startEvents.length).toBe(2);
      expect(startEvents[0]!.data.line).toBe(10);
      expect(startEvents[1]!.data.line).toBe(20);

      const doneEvent = events[events.length - 1]!;
      expect(doneEvent.data.status).toBe('passed');
    });

    it('done event carries reportPath when a report was written', { timeout: 30_000 }, async () => {
      // Open Last Report wiring: the server captures generateReport's
      // returned absolute path and threads it into the final `done` event
      // so the client can offer a one-click "Open Report" surface.
      // generateReport is mocked at the module top to return a fixed
      // sentinel path; this test proves it lands on the wire.
      const res = await fetch(`${baseUrl}/sessions/report-1/steps?stream=1`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ steps: ['Click'], sourceLines: [10] }),
      });

      expect(res.status).toBe(200);
      const events = await readSseStream(res);
      const doneEvent = events[events.length - 1]!;
      expect(doneEvent.event).toBe('done');
      expect(doneEvent.data.reportPath).toBe('/tmp/fake-report.html');
    });

    it('done event omits reportPath when report generation throws', { timeout: 30_000 }, async () => {
      // If generateReport throws (disk full, permissions, malformed
      // template), the server logs the failure and the `done` event
      // simply omits reportPath. The client's "Open Report" button
      // stays in its previous state — no error propagation back through
      // the SSE stream.
      const { generateReport } = await import('../src/report/generator.js');
      const mockGen = vi.mocked(generateReport);
      const original = mockGen.getMockImplementation();
      mockGen.mockRejectedValueOnce(new Error('disk full'));

      try {
        const res = await fetch(`${baseUrl}/sessions/report-fail-1/steps?stream=1`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({ steps: ['Click'], sourceLines: [10] }),
        });
        expect(res.status).toBe(200);
        const events = await readSseStream(res);
        const doneEvent = events[events.length - 1]!;
        expect(doneEvent.event).toBe('done');
        expect(doneEvent.data.status).toBe('passed');
        expect(doneEvent.data.reportPath).toBeUndefined();
      } finally {
        mockGen.mockReset();
        if (original) mockGen.mockImplementation(original);
      }
    });

    it('aborts the in-flight run when the client disconnects', { timeout: 30_000 }, async () => {
      const { executeStep } = await import('../src/runner/step-executor.js');
      vi.mocked(executeStep).mockClear();
      // Slow each mocked step so we can disconnect after the first one.
      vi.mocked(executeStep).mockImplementation(async (idx) => {
        await new Promise((r) => setTimeout(r, 200));
        return {
          index: idx,
          instruction: `step ${idx}`,
          status: 'passed',
          turns: [],
          durationMs: 200,
          retried: false,
        };
      });

      const ac = new AbortController();
      const reqPromise = fetch(`${baseUrl}/sessions/abort-1/steps?stream=1`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ steps: ['s1', 's2', 's3', 's4', 's5'] }),
        signal: ac.signal,
      });

      // Wait long enough for step 1 to start (and probably finish), then
      // abort the fetch to simulate the user clicking Stop.
      await new Promise((r) => setTimeout(r, 250));
      ac.abort();

      // The fetch should reject (it was aborted).
      await reqPromise.catch(() => {});

      // Give the server a moment to notice the disconnect and unwind.
      await new Promise((r) => setTimeout(r, 800));

      const callsAfterAbort = vi.mocked(executeStep).mock.calls.length;
      // We requested 5 steps. If the server propagates abort, fewer than 5
      // executeStep calls should have fired before the loop tore down.
      expect(callsAfterAbort).toBeLessThan(5);
    });

    it('capture events stream with source="capture" for [output:] extractions', { timeout: 30_000 }, async () => {
      // Verify the capture source rides the SSE wire (not just the manager's
      // internal emit). Override executeStep for this one run so the mocked
      // step "extracts" the [output:] var into resolvedParameters.
      const { executeStep } = await import('../src/runner/step-executor.js');
      vi.mocked(executeStep).mockImplementationOnce(async (_idx, _total, instruction, opts) => {
        if (opts.resolvedParameters) opts.resolvedParameters['orderId'] = 'ORD-42';
        return { index: 1, instruction, status: 'passed', turns: [], durationMs: 10, retried: false };
      });

      const res = await fetch(`${baseUrl}/sessions/capture-src/steps?stream=1`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ steps: ['[output: orderId] Get the order ID'], sourceLines: [10] }),
      });

      const events = await readSseStream(res);
      const captures = events.filter((e) => e.event === 'capture');
      expect(captures).toHaveLength(1);
      expect(captures[0]!.data).toMatchObject({ name: 'orderId', value: 'ORD-42', source: 'capture' });
    });

    it('falls back to step index when sourceLines omitted', { timeout: 30_000 }, async () => {
      const res = await fetch(`${baseUrl}/sessions/stream-2/steps?stream=1`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ steps: ['Only'] }),
      });

      const events = await readSseStream(res);
      const start = events.find((e) => e.event === 'step:start');
      expect(start!.data.line).toBe(1);
    });
  });

  describe('per-request env injection', () => {
    it('accepts env in request body without crashing', async () => {
      // Full assertion that env reaches the AiClient lives in session-manager unit
      // tests; here we just confirm the API surface accepts and runs the request.
      const { status, body } = await api('POST', '/sessions/env-1/steps', {
        steps: ['Click'],
        env: { AI_API_KEY: 'overridden-key', AI_MODEL: 'overridden-model' },
      });

      expect(status).toBe(200);
      expect(body.status).toBe('passed');
    });

    it('does not leak env into server process.env', async () => {
      const before = process.env['AI_API_KEY'];
      await api('POST', '/sessions/env-2/steps', {
        steps: ['Click'],
        env: { AI_API_KEY: 'should-not-leak' },
      });
      expect(process.env['AI_API_KEY']).toBe(before);
    });
  });
});

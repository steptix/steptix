import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
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

vi.mock('../src/browser/manager.js', () => ({
  launchBrowser: vi.fn(async () => ({ ...mockBrowserSession })),
  closeBrowser: vi.fn(async () => {}),
  PageTracker: vi.fn(),
}));

vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: vi.fn(async (): Promise<StepResult> => ({
    index: 1,
    instruction: 'mock step',
    status: 'passed',
    subActions: [{ index: 1, action: { action: 'click', description: 'click' }, durationMs: 10 }],
    durationMs: 100,
    retried: false,
    aiExplanation: 'Did the thing',
  })),
}));

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: vi.fn(async () => ({ files: [], combined: '' })),
}));

vi.mock('../src/ai/client.js', () => ({
  AiClient: vi.fn(() => ({
    chat: vi.fn(async () => '{}'),
  })),
}));

vi.mock('../src/utils/tokens.js', () => ({
  TokenTracker: vi.fn(() => ({
    resetStep: vi.fn(),
    totalTokens: 0,
  })),
}));

vi.mock('../src/api/response-store.js', () => ({
  ApiResponseStore: vi.fn(() => ({
    store: vi.fn(),
    getHistory: vi.fn(() => []),
  })),
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
  },
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
    dismissObstacles: true,
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

    it('returns 400 when session ID exceeds 128 chars', async () => {
      const longId = 'x'.repeat(129);
      const { status, body } = await api('POST', `/sessions/${longId}/steps`, {
        steps: ['Click button'],
      });

      expect(status).toBe(400);
      expect(body.error).toContain('128');
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
});

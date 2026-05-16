/**
 * End-to-end test for the step-into wire protocol over HTTP:
 *
 *  - `POST /sessions/:id/steps` with `skillsDir` + `testFilePath`
 *    triggers server-side skill expansion and emits frame:push / frame:pop
 *    events around the skill body. (Catches the Phase 1 wiring gap where
 *    the api-server's field validator was dropping these.)
 *  - `stepMode: 'into'` on the request body pauses the run after every
 *    step, emitting `step:awaiting` events the client can resume from.
 *  - `POST /sessions/:id/run-control { mode }` resolves the paused run
 *    and the SSE stream continues with the next step.
 *  - `runControl` returns 409 when no run is paused.
 *
 * The browser / AI / step-executor are mocked the same way `api-server.test.ts`
 * mocks them; the skill expander and the api-server's request handling
 * are exercised for real.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';

// ── Mocks (mirror api-server.test.ts) ────────────────────────────────

const mockPage = {
  url: vi.fn(() => 'https://example.com'),
  title: vi.fn(async () => 'Example Page'),
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
    turns: [],
    durationMs: 5,
    retried: false,
    aiExplanation: 'ok',
  })),
  executeBranchedStep: vi.fn(async () => []),
}));

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: vi.fn(async () => ({ files: [], combined: '' })),
}));

vi.mock('../src/ai/client.js', () => ({
  AiClient: class { chat = vi.fn(async () => '{}'); },
}));

vi.mock('../src/utils/tokens.js', () => ({
  TokenTracker: class { resetStep = vi.fn(); totalTokens = 0; },
}));

vi.mock('../src/api/response-store.js', () => ({
  ApiResponseStore: class { store = vi.fn(); getHistory = vi.fn(() => []); },
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

const API_KEY = 'sk-stepmode-test';
const cfg: Config = {
  ai: { gatewayUrl: 'https://ai.test', model: 't', maxInputTokens: 1000, streamResponses: false, sendScreenshots: false },
  browser: { headed: false, viewport: { width: 1280, height: 720 }, windowSize: { width: 1280, height: 720 }, slowMo: 0, browser: 'chromium', fullPageScreenshots: true },
  tests: { dir: './tests', contextDir: './context', pattern: '**/*.md' },
  execution: { timeout: 30000, retries: 1, screenshotOnFailure: true, promptOnAmbiguity: false, maxTurns: 5 },
  reports: { outputDir: './reports', includeScreenshots: false, includeDomSnapshots: false, includeAiReasoning: false, embedScreenshots: false },
  api: { specsDir: './specs', requestTimeout: 30000, redactSensitive: true },
  server: { host: '127.0.0.1', port: 0, apiKey: API_KEY },
  cache: { enabled: false, dir: '.cache' },
  logging: { consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
};

let server: Server;
let baseUrl: string;
let skillsDir: string;
let testFilePath: string;

beforeAll(async () => {
  const { app } = createApiServer(cfg);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  // Fixture skill + test file in a temp dir.
  skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stepmode-skills-'));
  await fs.writeFile(
    path.join(skillsDir, 'demo_skill.md'),
    `---
type: skill
---
# demo_skill

## Steps
1. First skill step
2. Second skill step
`,
  );
  testFilePath = path.join(skillsDir, 'fake-test.md');
});

afterAll(async () => {
  await new Promise<void>((r, e) => server.close((err) => err ? e(err) : r()));
  await fs.rm(skillsDir, { recursive: true, force: true });
});

/** Open an SSE stream and yield parsed events as they arrive. */
async function* sseEvents(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<{ type: string; [k: string]: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    ...(signal && { signal }),
  });
  if (!res.body) throw new Error('no response body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      const data = dataLine.slice(6);
      try {
        yield JSON.parse(data);
      } catch {
        // ignore non-JSON (keep-alive comments etc.)
      }
    }
  }
}

async function runControl(sessionId: string, mode: string): Promise<number> {
  const res = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/run-control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ mode }),
  });
  return res.status;
}

describe('api-server step-into protocol', () => {
  it('skillsDir triggers expansion and emits frame:push/frame:pop around the skill body', async () => {
    const sessionId = 'frame-events-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];
    for await (const ev of sseEvents(url, {
      steps: ['Open the page', '[skill: demo_skill]', 'Verify result'],
      sourceLines: [1, 2, 3],
      skillsDir,
      testFilePath,
    })) {
      events.push(ev);
      if (ev.type === 'done') break;
    }

    const types = events.map((e) => e.type);
    // Frame events must surround the skill body.
    const pushIdx = types.indexOf('frame:push');
    const popIdx = types.indexOf('frame:pop');
    expect(pushIdx).toBeGreaterThan(-1);
    expect(popIdx).toBeGreaterThan(pushIdx);

    // Step events inside the skill body must carry the frame payload.
    const insideFrame = events.filter(
      (e, i) => i > pushIdx && i < popIdx && e.type === 'step:start',
    );
    expect(insideFrame.length).toBeGreaterThan(0);
    for (const ev of insideFrame) {
      expect(ev.frame).toBeDefined();
      expect(ev.frame.skillName).toBe('demo_skill');
    }
  });

  it('stepMode=into pauses after every step and emits step:awaiting', async () => {
    const sessionId = 'stepmode-into-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];

    // Drive the SSE stream in parallel with run-control POSTs. Each
    // step:awaiting → POST 'into' → next step:pass → next step:awaiting.
    const consume = (async () => {
      for await (const ev of sseEvents(url, {
        steps: ['Step one', 'Step two', 'Step three'],
        sourceLines: [1, 2, 3],
        stepMode: 'into',
      })) {
        events.push(ev);
        if (ev.type === 'step:awaiting') {
          // Resume by sending another 'into' until done.
          await runControl(sessionId, 'into');
        }
        if (ev.type === 'done') break;
      }
    })();

    await consume;

    const awaitingCount = events.filter((e) => e.type === 'step:awaiting').length;
    const passCount = events.filter((e) => e.type === 'step:pass').length;
    // 3 steps → 3 step:pass, 2 pauses between them (no pause after the last).
    expect(passCount).toBe(3);
    expect(awaitingCount).toBe(2);
  });

  it('run-control returns 409 when no run is paused', async () => {
    const status = await runControl('no-such-session-' + Date.now(), 'into');
    expect(status).toBe(409);
  });

  it('run-control rejects unknown modes with 400', async () => {
    const res = await fetch(`${baseUrl}/sessions/whatever/run-control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ mode: 'bogus' }),
    });
    expect(res.status).toBe(400);
  });

  it('stepMode=continue runs straight through without pausing', async () => {
    const sessionId = 'stepmode-continue-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];
    for await (const ev of sseEvents(url, {
      steps: ['Step one', 'Step two'],
      sourceLines: [1, 2],
      stepMode: 'continue',
    })) {
      events.push(ev);
      if (ev.type === 'done') break;
    }
    const awaitingCount = events.filter((e) => e.type === 'step:awaiting').length;
    expect(awaitingCount).toBe(0);
  });
});

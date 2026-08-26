/**
 * End-to-end test for code-behind step-into over the real HTTP route
 * (stories/codebehind-debugging.md §Flow 2).
 *
 * The wire contract under test:
 *
 *   - `pauseAtNextCodeBehind: true` on the steps body makes the server emit
 *     `codebehind:awaiting-debugger` before a step that has a bound entry,
 *     park until `POST /sessions/:id/tool-debugger-ack` (the ack route is
 *     shared with tool step-into), then proceed;
 *   - the flag is consumed at the NEXT executed step even when that step has
 *     no entry — F11 must never ambush a later step;
 *   - run-control can arm the flag mid-run, and a run-control 409 must not
 *     leave it armed (same delivery guard as `pauseAtNextTool`).
 *
 * The browser / AI / step-executor are mocked the same way as
 * api-server-tools.test.ts — the pause point lives in the session manager's
 * step loop BEFORE `executeStep`, so the mock does not blunt the test. The
 * code-behind loader (esbuild bundle + entry matching) is exercised for real
 * against a fixture `.steps.ts`.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';

// ── Mocks (mirror api-server-tools.test.ts) ──────────────────────────

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
  AiClient: class { chat = vi.fn(async () => '{}'); syncAuth = vi.fn(() => null); },
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

const API_KEY = 'sk-codebehind-debug-test';
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
/** Directory holding the fixture test + its sibling `.steps.ts`. */
let projectDir: string;
/** Absolute path of the fixture test file (the `.md` itself never exists —
 *  only its path matters, as the anchor the sibling `.steps.ts` derives from). */
let testFilePath: string;
/** The canonical code-behind path events must name. */
let stepsFilePath: string;

const BOUND_STEP = 'Do the bound thing';
const UNBOUND_STEP = 'Do the unbound thing';

beforeAll(async () => {
  const { app } = createApiServer(cfg);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  // Fixture: a code-behind file with ONE bound entry, imported the way the
  // tool fixtures import defineTool — by absolute path into src, which
  // esbuild bundles inline (no node_modules needed in the tmpdir).
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codebehind-debug-'));
  testFilePath = path.join(projectDir, 'debugme.md');
  stepsFilePath = path.join(projectDir, 'debugme.steps.ts');
  const defineStepsImport = path
    .resolve(__dirname, '..', 'src', 'codebehind', 'index.ts')
    .replace(/\\/g, '/');
  await fs.writeFile(
    stepsFilePath,
    `
import { defineSteps } from '${defineStepsImport}';

export default defineSteps([
  {
    source: ${JSON.stringify(BOUND_STEP)},
    async run({ step }) {
      step.setVar('bound', 'ran');
    },
  },
]);
`,
  );
});

afterAll(async () => {
  await new Promise<void>((r, e) => server.close((err) => err ? e(err) : r()));
  await fs.rm(projectDir, { recursive: true, force: true });
});

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
        // ignore
      }
    }
  }
}

function ack(sessionId: string): Promise<Response> {
  return fetch(
    `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/tool-debugger-ack`,
    { method: 'POST', headers: { 'x-api-key': API_KEY } },
  );
}

describe('api-server code-behind step-into', () => {
  it('pauseAtNextCodeBehind emits codebehind:awaiting-debugger for a bound step and parks until ack', async () => {
    const sessionId = 'cb-debug-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];

    for await (const ev of sseEvents(url, {
      steps: [BOUND_STEP],
      sourceLines: [7],
      testFilePath,
      pauseAtNextCodeBehind: true,
    })) {
      events.push(ev);
      if (ev.type === 'codebehind:awaiting-debugger') {
        const ackRes = await ack(sessionId);
        expect(ackRes.status).toBe(200);
      }
      if (ev.type === 'done') break;
    }

    const awaiting = events.filter((e) => e.type === 'codebehind:awaiting-debugger');
    expect(awaiting).toHaveLength(1);
    // The event names the CANONICAL `.steps.ts` — where the user's editor
    // and breakpoints live — and the step's own source line.
    expect(awaiting[0].file).toBe(stepsFilePath);
    expect(awaiting[0].line).toBe(7);

    expect(events.find((e) => e.type === 'done')?.status).toBe('passed');
  });

  it('the flag is consumed at the next step even when that step has no entry', async () => {
    // Steps: [unbound, bound]. F11 semantics are "descend into THIS step":
    // the flag dies at the unbound step, silently, and the bound step that
    // follows runs without a pause. A lingering flag here is the ambush bug
    // the run-control delivery guard exists to prevent, one layer down.
    const sessionId = 'cb-debug-consume-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];

    for await (const ev of sseEvents(url, {
      steps: [UNBOUND_STEP, BOUND_STEP],
      sourceLines: [1, 2],
      testFilePath,
      pauseAtNextCodeBehind: true,
    })) {
      events.push(ev);
      // No ack on purpose: if an awaiting event fired anyway, the run
      // would hang here and the test would time out — which IS the signal.
      if (ev.type === 'done') break;
    }

    expect(events.filter((e) => e.type === 'codebehind:awaiting-debugger')).toHaveLength(0);
    expect(events.find((e) => e.type === 'done')?.status).toBe('passed');
  });

  it('without testFilePath there is no registry and the flag is inert', async () => {
    const sessionId = 'cb-debug-noreg-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];

    for await (const ev of sseEvents(url, {
      steps: [BOUND_STEP],
      sourceLines: [1],
      pauseAtNextCodeBehind: true,
    })) {
      events.push(ev);
      if (ev.type === 'done') break;
    }

    expect(events.filter((e) => e.type === 'codebehind:awaiting-debugger')).toHaveLength(0);
    expect(events.find((e) => e.type === 'done')?.status).toBe('passed');
  });

  it('run-control arms the flag mid-run for the immediately next step', async () => {
    // stepMode 'into' pauses AFTER each executed step, with `step:awaiting`
    // pointing at the next one (see StepAwaitingEvent). For [unbound, bound]
    // the single pause sits between them — arm the flag there, and the
    // resumed loop emits the awaiting-debugger event for exactly the bound
    // step. Mirrors the pauseAtNextTool mid-run test.
    const sessionId = 'cb-debug-midrun-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];

    for await (const ev of sseEvents(url, {
      steps: [UNBOUND_STEP, BOUND_STEP],
      sourceLines: [1, 2],
      testFilePath,
      stepMode: 'into',
    })) {
      events.push(ev);
      if (ev.type === 'step:awaiting') {
        await fetch(
          `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/run-control`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
            body: JSON.stringify({ mode: 'continue', pauseAtNextCodeBehind: true }),
          },
        );
      }
      if (ev.type === 'codebehind:awaiting-debugger') {
        await ack(sessionId);
      }
      if (ev.type === 'done') break;
    }

    const awaiting = events.filter((e) => e.type === 'codebehind:awaiting-debugger');
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0].line).toBe(2);
    expect(events.find((e) => e.type === 'done')?.status).toBe('passed');
  });

  it('run-control 409 does NOT leave pauseAtNextCodeBehind armed for the next batch', async () => {
    const sessionId = 'cb-debug-noleak-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;

    // Speculative run-control on a fresh session (no paused run) — 409, and
    // the api-server must not set the session flag on this path.
    const stuckRes = await fetch(
      `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/run-control`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ mode: 'continue', pauseAtNextCodeBehind: true }),
      },
    );
    expect(stuckRes.status).toBe(409);

    // A real run with a BOUND step and no flag: if the flag had leaked, the
    // server would park awaiting an ack nobody sends and the test would
    // time out.
    const events: any[] = [];
    for await (const ev of sseEvents(url, {
      steps: [BOUND_STEP],
      sourceLines: [1],
      testFilePath,
    })) {
      events.push(ev);
      if (ev.type === 'done') break;
    }
    expect(events.filter((e) => e.type === 'codebehind:awaiting-debugger')).toHaveLength(0);
    expect(events.find((e) => e.type === 'done')?.status).toBe('passed');
  });
});

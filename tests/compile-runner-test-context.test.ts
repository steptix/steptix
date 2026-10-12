/**
 * A test's own `## Context` on the **compile** route (issue #36;
 * `POST /codebehind/compile`, docs/specs/SPEC-web-survey-fixes.md §2.46).
 *
 * The recording run is a run like any other, so every step's prompt has to
 * carry what the author wrote under `## Context` — the frame, the selectors,
 * the ad to close first. The route parses the test from disk and its runner
 * builds the session's step request itself, so `testContext` has to be put
 * there from the parsed file: no client sends it on this route.
 *
 * Driven through the real `node:http` entry for the reason
 * compile-runner-flow-control.test.ts gives, with the compile core faked at
 * `compileTest`. The core's own prompts are covered in
 * compile-test-context.test.ts.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';
import type {
  CompileOptions,
  CompileResult,
} from '../src/codebehind/compile.js';

// ── The compile core, faked at the one function the server calls ─────

/** The `contextContent` each faked compile was handed. */
const compiles = vi.hoisted(() => ({ contexts: [] as string[] }));

vi.mock('../src/codebehind/compile.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/codebehind/compile.js')>()),
  compileTest: vi.fn(async (options: CompileOptions): Promise<CompileResult> => {
    compiles.contexts.push(options.contextContent);
    await options.runner!({
      purpose: 'record',
      parameters: {},
      strict: false,
      captureContext: false,
      disableCodeBehind: true,
    });
    return {
      status: 'green',
      files: {},
      summary: {
        test: options.test.filePath,
        totalSteps: options.test.steps.length,
        compiled: 0,
        kept: 0,
        keptAi: 0,
        rounds: 1,
        tokensUsed: 0,
        written: [],
        unproven: [],
        writtenOffAi: [],
        notAttempted: [],
        recordingDir: '/x/.steptix-codebehind-cache/x.recording',
      },
    };
  }),
}));

// ── Mocks (mirror api-server-flow-control.test.ts) ───────────────────

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

/** The context every executed step's prompt was built with. */
const stepContexts: string[] = [];

vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: vi.fn(async (
    _stepIndex: number,
    _totalSteps: number,
    instruction: string,
    opts?: { contextContent?: string },
  ): Promise<StepResult> => {
    stepContexts.push(opts?.contextContent ?? '<none>');
    return {
      index: 1,
      instruction,
      status: 'passed',
      turns: [],
      durationMs: 1,
      retried: false,
      aiExplanation: 'ok',
    };
  }),
  executeBranchedStep: vi.fn(async () => []),
}));

const PROJECT_CONTEXT = '### Context: app.md\n\nThe app is an inventory tool.';

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: vi.fn(async () => ({
    files: [],
    combined: '### Context: app.md\n\nThe app is an inventory tool.',
  })),
}));

vi.mock('../src/ai/client.js', () => ({
  AiClient: class { chat = vi.fn(async () => '{}'); setAiPolicy = vi.fn(); syncAuth = vi.fn(() => null); },
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
    info: vi.fn(), error: vi.fn(), warn: vi.fn(),
    success: vi.fn(), step: vi.fn(), debug: vi.fn(), trace: vi.fn(),
  },
  addLogCallback: vi.fn(() => () => {}),
  addTraceCallback: vi.fn(() => () => {}),
  isVerbose: vi.fn(() => false),
  shouldEmit: vi.fn(() => false),
  setLogLevel: vi.fn(),
  getLogLevel: vi.fn(() => 'info'),
}));

import { createApiServer } from '../src/server/api-server.js';
import { listenFetchable } from './listen-fetchable.cjs';

const API_KEY = 'compile-test-context-api-key';
const cfg: Config = {
  ai: { gatewayUrl: 'https://ai.test', model: 't', maxInputTokens: 1000, streamResponses: false, sendScreenshots: false },
  browser: { headed: false, viewport: { width: 1280, height: 720 }, windowSize: { width: 1280, height: 720 }, slowMo: 0, browser: 'chromium', fullPageScreenshots: true },
  tests: { dir: './tests', contextDir: './context', pattern: '**/*.md' },
  execution: { timeout: 30000, retries: 1, screenshotOnFailure: true, promptOnAmbiguity: false, maxTurns: 5 },
  reports: { outputDir: './reports', includeScreenshots: false, includeDomSnapshots: false, includeAiReasoning: false, embedScreenshots: false },
  api: { specsDir: './specs', requestTimeout: 30000, redactSensitive: true },
  server: { host: '127.0.0.1', port: 0, apiKey: API_KEY },
  logging: { consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
};

// Invented names: the framework's tests teach a pattern, not a site's answer.
const CONTEXT_LINE = 'The grid is inside the iframe `#host`. Row ids start at zero, so "row 3" is `#grid_row_2`.';

const WITH_CONTEXT_MD = [
  '# Edit a row',
  '',
  '## Context',
  `- ${CONTEXT_LINE}`,
  '- A full-screen ad may open with the page. Close it with its Close button first.',
  '',
  '## Steps',
  '1. Open the grid',
  '2. Change row 3\'s name to "Ada"',
  '',
].join('\n');

const WITHOUT_CONTEXT_MD = [
  '# Edit a row',
  '',
  '## Steps',
  '1. Open the grid',
  '2. Change row 3\'s name to "Ada"',
  '',
].join('\n');

let server: Server;
let baseUrl: string;
let projectRoot: string;

beforeAll(async () => {
  const { app } = createApiServer(cfg);
  server = createServer(app);
  await listenFetchable(server, '127.0.0.1');
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) baseUrl = `http://127.0.0.1:${addr.port}`;

  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'compile-test-context-'));
  await fs.writeFile(path.join(projectRoot, 'steptix.config.json'), JSON.stringify({}));
  await fs.writeFile(path.join(projectRoot, 'with-context.md'), WITH_CONTEXT_MD);
  await fs.writeFile(path.join(projectRoot, 'without-context.md'), WITHOUT_CONTEXT_MD);
});

afterAll(async () => {
  await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
  await fs.rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

beforeEach(() => {
  stepContexts.length = 0;
  compiles.contexts.length = 0;
});

/** POST the compile and collect every SSE frame. */
async function compile(testFilePath: string): Promise<any[]> {
  const res = await fetch(`${baseUrl}/codebehind/compile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ testFilePath }),
  });
  if (!res.body) throw new Error('no response body');
  const events: any[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      try {
        events.push(JSON.parse(dataLine.slice(6)));
      } catch {
        /* keep-alives */
      }
    }
  }
  return events;
}

describe('the compile route and a test with ## Context', () => {
  it("records every step with the test's context after the project's", async () => {
    const events = await compile(path.join(projectRoot, 'with-context.md'));
    expect(events.find((e) => e.type === 'error')).toBeUndefined();

    expect(stepContexts).toHaveLength(2);
    for (const context of stepContexts) {
      expect(context).toContain(CONTEXT_LINE);
      expect(context).toContain('Close it with its Close button first.');
      expect(context).toContain("### Context: this test (from the test file's ## Context");
      expect(context.indexOf(PROJECT_CONTEXT)).toBe(0);
      // Once: the session composes it from the request, and nothing upstream
      // may have composed it already.
      expect(context.split(CONTEXT_LINE)).toHaveLength(2);
    }
  });

  it("hands the compile core the project's context, which adds the test's itself", async () => {
    await compile(path.join(projectRoot, 'with-context.md'));
    expect(compiles.contexts).toEqual([PROJECT_CONTEXT]);
  });
});

describe('the compile route and a test without ## Context', () => {
  it("records with the project's context alone, as before", async () => {
    const events = await compile(path.join(projectRoot, 'without-context.md'));
    expect(events.find((e) => e.type === 'error')).toBeUndefined();

    expect(stepContexts).toEqual([PROJECT_CONTEXT, PROJECT_CONTEXT]);
  });
});

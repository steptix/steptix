/**
 * Which runs over HTTP write the code-behind last-run sidecar
 * (stories/codebehind-compile.md §The runtime stops generating).
 *
 * The sidecar's two readers — `collectStaleKeys` behind `--only-stale`
 * (src/codebehind/compile.ts) and `LiveCompiler.priorFailure`
 * (src/codebehind/live-compile.ts) — read it as a description of the WHOLE
 * test. So the session manager writes it only for a batch that is the whole
 * test: one whose `steps` equal its `fullSteps`, or that sent no `fullSteps` at
 * all. A subset batch — a breakpoint continuation, an `[input:]` split — sends
 * `steps` ≠ `fullSteps`, and written, its sidecar would cover only its slice,
 * numbered from 1 as if the slice were the test.
 *
 * That decision is one private element-wise comparison (`arraysEqual`,
 * session-manager.ts), and nothing else pins it: it had unit coverage only
 * while the step cache shared it.
 *
 * **Every test here POSTs through the real `node:http` entry**, for the reason
 * `api-server-sections.test.ts` states at its top: `api-server.ts` builds
 * `StepRequest` from an explicit per-field allow-list, and `fullSteps` is on it.
 * A test that handed the session manager a `StepRequest` directly would pass
 * against a server that dropped the field — and a dropped `fullSteps` reads as
 * a whole-test batch, which is exactly the Continue that writes a slice.
 *
 * The browser / AI / step-executor are mocked as in `api-server-sections.test.ts`;
 * the request validation, the session manager's step loop and the sidecar
 * writer run for real.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';

// ── Mocks (mirror api-server-sections.test.ts) ───────────────────────

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
    /** Lazy twin of the real static (SPEC-use-computer.md §4.6). */
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

/** The instruction text of every step the runner actually executed — so a
 *  test that expects NO sidecar can show the batch still ran, rather than
 *  passing because the request never got as far as the step loop. */
const executedSteps: string[] = [];

vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: vi.fn(async (
    _stepIndex: number,
    _totalSteps: number,
    instruction: string,
  ): Promise<StepResult> => {
    executedSteps.push(instruction);
    return {
      index: 1,
      instruction,
      status: 'passed',
      turns: [],
      durationMs: 5,
      retried: false,
      aiExplanation: 'ok',
    };
  }),
  executeBranchedStep: vi.fn(async () => []),
}));

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: vi.fn(async () => ({ files: [], combined: '' })),
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
import { lastRunPathFor, readLastRun } from '../src/codebehind/last-run.js';

const API_KEY = 'sk-last-run-sidecar-test';
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

let server: Server;
let baseUrl: string;
let tmpDir: string;

beforeAll(async () => {
  const { app } = createApiServer(cfg);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) baseUrl = `http://127.0.0.1:${addr.port}`;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'last-run-sidecar-http-'));
});

afterAll(async () => {
  await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  executedSteps.length = 0;
});

// ── Helpers ──────────────────────────────────────────────────────────

let sessionSeq = 0;
const nextSession = (): string => `sidecar-${++sessionSeq}-${Date.now()}`;

/** A test file of its own per test, so one test's sidecar can never be what
 *  another test reads (or fails to find). */
let fileSeq = 0;
async function newTestFile(): Promise<string> {
  const file = path.join(tmpDir, `checkout-${++fileSeq}.md`);
  await fs.writeFile(file, '# placeholder — the server never reads this\n');
  return file;
}

async function postSteps(body: unknown, sessionId = nextSession()): Promise<any> {
  const res = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** The test's three steps, on lines 3–5 of its file. */
const FULL = ['Open the shop', 'Sign in', 'Check out'];
const LINES = [3, 4, 5];

/** A batch of `FULL[from, to)`, shaped as TestBench sends one. `null` sends no
 *  `fullSteps` at all — not `undefined`, which a caller passing it explicitly
 *  would find silently replaced by the default. */
const batch = (
  testFilePath: string,
  from: number,
  to: number,
  fullSteps: string[] | null = FULL,
) => ({
  steps: FULL.slice(from, to),
  sourceLines: LINES.slice(from, to),
  testFilePath,
  ...(fullSteps !== null && { fullSteps }),
});

// ─────────────────────────────────────────────────────────────────────
describe('a batch that is the whole test writes the sidecar', () => {
  it('when it sends no fullSteps at all', async () => {
    // The shape every caller but TestBench sends, and TestBench's own before
    // it learned to split. No `fullSteps` means nothing says this is a slice.
    const testFilePath = await newTestFile();
    const body = await postSteps(batch(testFilePath, 0, 3, null));
    expect(body.status).toBe('passed');

    const sidecar = await readLastRun(testFilePath);
    expect(sidecar).not.toBeNull();
    expect(sidecar!.test).toBe(path.resolve(testFilePath));
    expect(sidecar!.steps.map((s) => [s.index, s.source, s.status])).toEqual([
      [1, 'Open the shop', 'passed'],
      [2, 'Sign in', 'passed'],
      [3, 'Check out', 'passed'],
    ]);
  });

  it('when its fullSteps is the batch itself', async () => {
    // What TestBench sends for an unbroken Run: `steps` and `fullSteps` both
    // the whole document. Two separate arrays on the wire, so this is the
    // element-wise comparison answering "equal" — a check that any `fullSteps`
    // means a slice would write nothing here, and no ordinary TestBench run
    // would ever leave a sidecar.
    const testFilePath = await newTestFile();
    const body = await postSteps(batch(testFilePath, 0, 3, [...FULL]));
    expect(body.status).toBe('passed');

    const sidecar = await readLastRun(testFilePath);
    expect(sidecar).not.toBeNull();
    expect(sidecar!.steps.map((s) => [s.index, s.source])).toEqual([
      [1, 'Open the shop'],
      [2, 'Sign in'],
      [3, 'Check out'],
    ]);
  });
});

describe('a subset batch writes no sidecar', () => {
  it('a breakpoint continuation — the tail of the test — writes none', async () => {
    // Continue after a breakpoint on line 4: the client sends the steps from
    // there on, and the whole document beside them. Written, this batch's
    // sidecar would say the test is two steps long, with `Sign in` as step 1.
    const testFilePath = await newTestFile();
    const body = await postSteps(batch(testFilePath, 1, 3));

    // The batch ran — every step of it — so the absence below is the gate's
    // doing, not a request that never reached the step loop.
    expect(body.status).toBe('passed');
    expect(executedSteps).toEqual(['Sign in', 'Check out']);
    expect(await readLastRun(testFilePath)).toBeNull();
  });

  it('the head of a split run writes none either', async () => {
    // The batch BEFORE the pause is a subset too, and it is the harder one to
    // tell apart: its steps are a prefix of `fullSteps`, so it starts where the
    // document starts, and anything that judged a batch by its first step would
    // take it for the whole test.
    const testFilePath = await newTestFile();
    const body = await postSteps(batch(testFilePath, 0, 2));

    expect(body.status).toBe('passed');
    expect(executedSteps).toEqual(['Open the shop', 'Sign in']);
    expect(await readLastRun(testFilePath)).toBeNull();
  });

  it('a run split in two leaves the last whole run`s sidecar exactly as it was', async () => {
    // The failure this gate exists for, end to end: yesterday's full run wrote
    // the sidecar, today's run pauses at a breakpoint and continues. Neither
    // half may overwrite it — `--only-stale` and a Compile This Step would
    // otherwise read a one- or two-step test.
    const testFilePath = await newTestFile();
    await postSteps(batch(testFilePath, 0, 3, null));
    const before = await fs.readFile(lastRunPathFor(testFilePath), 'utf-8');
    expect(JSON.parse(before).steps).toHaveLength(3);

    const sessionId = nextSession();
    expect((await postSteps(batch(testFilePath, 0, 2), sessionId)).status).toBe('passed');
    expect((await postSteps(batch(testFilePath, 2, 3), sessionId)).status).toBe('passed');

    // Byte for byte: a rewrite would at least move `ranAt`, even with the
    // same rows.
    expect(await fs.readFile(lastRunPathFor(testFilePath), 'utf-8')).toBe(before);
  });

  it.each([
    ['a step reworded', ['Open the shop', 'Sign in', 'Pay now']],
    ['two steps swapped', ['Open the shop', 'Check out', 'Sign in']],
  ])('same length but different content (%s) is a subset too', async (_label, steps) => {
    // The comparison is element-wise, not a length check and not a set
    // comparison: a batch as long as the document that is not the document is
    // not a description of it. A length check writes both of these; a
    // membership check writes the swapped one.
    const testFilePath = await newTestFile();
    const body = await postSteps({
      steps,
      sourceLines: LINES,
      testFilePath,
      fullSteps: FULL,
    });

    expect(body.status).toBe('passed');
    expect(executedSteps).toEqual(steps);
    expect(await readLastRun(testFilePath)).toBeNull();
  });
});

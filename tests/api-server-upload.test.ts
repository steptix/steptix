/**
 * Upload paths on the wire (stories/upload-action.md §3).
 *
 * This file exists to catch a field that is resolved perfectly and then
 * dropped on the way to the thing that uses it. `api-server.ts` builds its
 * `StepRequest` from an explicit per-field allow-list, so widening a type
 * compiles cleanly and still loses the value at runtime — this seam has
 * already lost `envName` exactly that way. `resolveUploadPaths` has unit tests
 * of its own and they would all stay green through it, because the bug is not
 * in the resolver: it is in whether the resolver is ever handed a base
 * directory at all.
 *
 * So every assertion here is on **what the step executor RECEIVED**, driven
 * over real HTTP through the real app. The two cases that fail silently in
 * production get tests of their own: a request carrying a `testFilePath` must
 * resolve against that file's folder, and a request without one must resolve
 * against nothing — falling back to the server's working directory would make
 * an upload step pass on the developer's machine and fail everywhere else.
 *
 * The last block lets the real executor run, because "no retries on a missing
 * file" is a claim about a whole run rather than about a return value: the
 * resolver can tag the failure non-retryable and the runner can still burn an
 * AI turn re-planning it. It carries its own control — an ordinary retryable
 * failure on the same route, costing two turns — so that "one AI call" is a
 * measurement rather than an artefact of a harness that never retries.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Express } from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';
import type { UploadPathContext } from '../src/browser/upload-paths.js';

// ---------------------------------------------------------------------------
// Mocks — mirrors api-server-run-settings.test.ts so no real browser or AI is
// involved. `executeAction` is deliberately NOT mocked: upload path resolution
// lives inside it, and that is the far end of the wire this file measures.
// ---------------------------------------------------------------------------

/** Enough `Page` for the executor's bookkeeping. `on`/`off` are not optional:
 *  the real `PageActivityTracker` attaches request listeners every turn. */
const mockPage = {
  url: vi.fn(() => 'https://example.com'),
  title: vi.fn(async () => 'Example'),
  goto: vi.fn(async () => null),
  on: vi.fn(() => {}),
  off: vi.fn(() => {}),
  context: vi.fn(() => ({ browser: () => ({}) })),
  /**
   * There is no DOM here, so one benign answer serves both in-page probes the
   * executor runs: the scroll position on every turn, and the page diagnosis
   * on a retry. Answering rather than throwing is what lets a step reach a
   * SECOND attempt — the retry control below is worthless without it, since a
   * throw in the diagnosis would end the attempt before any AI call.
   */
  evaluate: vi.fn(async () => ({
    readyState: 'complete',
    loadingIndicators: [],
    errorMessages: [],
    hasModal: false,
    scrollTop: 0,
    clientHeight: 800,
    scrollHeight: 800,
  })),
  waitForLoadState: vi.fn(async () => {}),
};

const mockPageTracker = { getActive: vi.fn(() => mockPage as never) };

const mockBrowserSession = {
  browser: { isConnected: vi.fn(() => true) },
  context: {},
  page: mockPage,
  pageTracker: mockPageTracker,
};

vi.mock('../src/browser/manager.js', () => {
  /**
   * Fuller than the sibling files' tracker, and it has to be: those stub the
   * step executor out entirely, whereas the last block here runs the real one,
   * which asks the tracker how many browsers there are before every AI call.
   * A tracker missing `count` reports `undefined <= 1` as false and then dies
   * in `list()` — a failure that looks nothing like the one under test.
   */
  class BrowserTracker {
    count = 1;
    getActive: ReturnType<typeof vi.fn>;
    getActivePage: ReturnType<typeof vi.fn>;
    closeAll: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    all: ReturnType<typeof vi.fn>;
    constructor(initialSession: typeof mockBrowserSession) {
      this.getActive = vi.fn(() => initialSession);
      this.getActivePage = vi.fn(() => initialSession.page);
      this.closeAll = vi.fn(async () => {});
      this.list = vi.fn(() => []);
      this.all = vi.fn(() => [initialSession]);
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

/**
 * A handle on the REAL `executeStep`, kept so the last block can let a step
 * run all the way into `executeAction` while the rest of the file keeps the
 * cheap stub. `vi.hoisted` because the factory below is lifted above the
 * module body and would otherwise read this in its temporal dead zone.
 */
const real = vi.hoisted(() => ({
  executeStep: null as
    | null
    | (typeof import('../src/runner/step-executor.js'))['executeStep'],
}));

vi.mock('../src/runner/step-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runner/step-executor.js')>();
  real.executeStep = actual.executeStep;
  return {
    ...actual,
    // Signature: (stepIndex, totalSteps, instruction, opts) — the options
    // object this whole file is about is the fourth POSITIONAL argument.
    executeStep: vi.fn(async (
      index: number,
      _total: number,
      instruction: string,
      _opts: unknown,
    ): Promise<StepResult> => ({
      index,
      instruction,
      status: 'passed',
      turns: [],
      durationMs: 10,
      retried: false,
      aiExplanation: 'ok',
    })),
  };
});

/** The DOM snapshot is pure AI input and there is no DOM here. Spread from the
 *  original so `PageCaptureError` and friends — which `api-server.ts` imports
 *  — survive the mock. */
vi.mock('../src/browser/dom-cleaner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/dom-cleaner.js')>();
  return {
    ...actual,
    captureDomSnapshot: vi.fn(async () => '<html><body>stub</body></html>'),
  };
});

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: vi.fn(async () => ({ files: [], combined: '' })),
}));

/** Every `complete` the run made. The count is the assertion that matters: a
 *  missing file must cost exactly one AI turn, never two. */
const aiCalls: unknown[][] = [];
/** What the scripted model answers with. Read at call time, so a test can set
 *  it long after the mock factory ran. */
let aiResponse = JSON.stringify({
  reasoning: 'nothing to do',
  actions: [{ action: 'noop', description: 'nothing' }],
});

vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    config = { model: 'mock-model' };
    chat = vi.fn(async () => '{}');
    setAiPolicy = vi.fn();
    syncAuth = vi.fn(() => null);
    complete = vi.fn(async (messages: unknown[]) => {
      aiCalls.push(messages);
      return { text: aiResponse, model: 'mock-model' };
    });
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
    hasResponses = vi.fn(() => false);
    formatForContext = vi.fn(() => '');
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

// The logger is deliberately left real. The session manager sets its level
// from `logging.consoleLogLevel` below, so the run is silent anyway, and
// `traceOp` — which the executor wraps every AI call in — comes from the same
// module and would have to be re-implemented in a stub.

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { createApiServer } from '../src/server/api-server.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { executeStep } from '../src/runner/step-executor.js';
import { setLogLevel } from '../src/utils/logger.js';

const stepMock = vi.mocked(executeStep);

const API_KEY = 'upload-key';

const testConfig: Config = {
  ...DEFAULT_CONFIG,
  ai: {
    ...DEFAULT_CONFIG.ai,
    model: 'server/base-model',
    apiKey: 'server-ai-key',
    sendScreenshots: false,
  },
  browser: {
    ...DEFAULT_CONFIG.browser,
    headed: false,
    captureScreenshotsPerAction: false,
  },
  server: { ...DEFAULT_CONFIG.server, host: '127.0.0.1', port: 0, apiKey: API_KEY },
  logging: { ...DEFAULT_CONFIG.logging, consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
};

let server: Server;
let baseUrl: string;
/** A real project on disk: `aiui.config.json` at the top, a `tests/` folder
 *  under it. The project root is not something a request can state — the
 *  server walks up to it — so it has to exist to be found. */
let projectRoot: string;
let testFilePath: string;

async function listenOnRandomPort(app: Express): Promise<{ server: Server; baseUrl: string }> {
  const started = createServer(app);
  await new Promise<void>((resolve) => { started.listen(0, '127.0.0.1', () => resolve()); });
  const addr = started.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { server: started, baseUrl: `http://127.0.0.1:${port}` };
}

/** POST a one-step batch. Sessions are keyed by id and outlive a test, so
 *  every caller passes an id nothing else has used. */
async function run(
  sessionId: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const res = await fetch(`${baseUrl}/sessions/${sessionId}/steps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({
      steps: ['Upload the receipt'],
      sourceLines: [1],
      ...body,
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/** The whole options object the executor was handed on the Nth (0-based) call. */
function optsAt(call = 0): Record<string, unknown> {
  const args = stepMock.mock.calls[call];
  expect(args, `no executeStep call #${call}`).toBeDefined();
  return args![3] as unknown as Record<string, unknown>;
}

/** What an `upload` step's paths would resolve against on that call. */
function uploadPathsAt(call = 0): UploadPathContext | undefined {
  return optsAt(call)['uploadPaths'] as UploadPathContext | undefined;
}

/** An AI plan that attaches one file. */
function uploadPlan(filePath: string): string {
  return JSON.stringify({
    reasoning: 'Attach the receipt to the form',
    actions: [
      {
        action: 'upload',
        selector: 'input[type=file]',
        filePath,
        description: 'Upload the receipt',
      },
    ],
  });
}

beforeAll(async () => {
  setLogLevel('silent');
  projectRoot = mkdtempSync(path.join(tmpdir(), 'aiui-upload-'));
  mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
  writeFileSync(path.join(projectRoot, 'aiui.config.json'), JSON.stringify({}));
  testFilePath = path.join(projectRoot, 'tests', 'expenses.md');
  writeFileSync(testFilePath, '# Expenses\n\n## Steps\n\n1. Upload the receipt\n');

  const { app } = createApiServer(testConfig);
  ({ server, baseUrl } = await listenOnRandomPort(app));
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  rmSync(projectRoot, { recursive: true, force: true });
});

beforeEach(() => {
  stepMock.mockClear();
  aiCalls.length = 0;
});

// ---------------------------------------------------------------------------
// A request that names its test file
// ---------------------------------------------------------------------------

describe('a batch carrying testFilePath', () => {
  it("hands the executor the test file's folder and the project root", async () => {
    await run('up-basedir', { testFilePath });

    expect(uploadPathsAt()).toEqual({
      // Not the project root, and not the server's cwd. This is the whole
      // portability promise: move the .md with its attachments/ folder and the
      // same step still finds the same file.
      baseDir: path.dirname(testFilePath),
      // Found by walking up to the aiui.config.json rather than sent by the
      // client — it is what fences a stray `..` out of somebody's home folder.
      projectRoot,
    });
  });

  it('keeps handing it over on a LATER batch of the same session', async () => {
    // The case an implementation that retained the value on the session would
    // get wrong: the base directory belongs to the REQUEST, so it has to be
    // rebuilt every batch rather than captured when the session was made.
    const id = 'up-basedir-later';
    await run(id, { testFilePath });
    stepMock.mockClear();

    const second = path.join(projectRoot, 'tests', 'nested', 'other.md');
    mkdirSync(path.dirname(second), { recursive: true });
    writeFileSync(second, '# Other\n');
    await run(id, { testFilePath: second });

    expect(uploadPathsAt()?.baseDir).toBe(path.dirname(second));
    expect(uploadPathsAt()?.projectRoot).toBe(projectRoot);
  });

  it("does not leak one session's base directory into another's", async () => {
    // One server serves TestBench and every agent at once. A base directory
    // that leaked would resolve a relative upload path against somebody else's
    // test folder, which is a wrong file rather than a missing one.
    await run('up-iso-a', { testFilePath });
    await run('up-iso-b');

    expect(uploadPathsAt(0)?.baseDir).toBe(path.dirname(testFilePath));
    expect(uploadPathsAt(1)?.baseDir).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A request that names no test file
// ---------------------------------------------------------------------------

describe('a batch with no testFilePath', () => {
  it("leaves baseDir absent rather than falling back to the server's cwd", async () => {
    // Flick never sends a test file, and `testFilePath` is optional on the
    // Sessions API. Defaulting to `process.cwd()` here would be the worst kind
    // of bug: the developer's own machine, where the server happens to run
    // from the repo, is the one place it would appear to work.
    await run('up-no-testfile');

    const uploadPaths = uploadPathsAt();
    expect(uploadPaths).toBeDefined();
    expect(uploadPaths?.baseDir).toBeUndefined();
    // Absent, not present-and-undefined: `resolveUploadPaths` decides on
    // `ctx.baseDir === undefined`, so a key set to '' or to the string
    // 'undefined' would sail past that check and resolve against nothing.
    expect('baseDir' in (uploadPaths as object)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The whole way through — the real executor, the real `executeAction`
//
// Everything above proves the context arrives. None of it proves the context
// is USED, or that failing to resolve costs one AI turn rather than two. These
// let the step run for real, with only the model, the DOM snapshot and the
// screenshots stubbed.
// ---------------------------------------------------------------------------

describe('a step whose file is not there', () => {
  it('fails with the missing-file message and spends exactly one AI turn', async () => {
    aiResponse = uploadPlan('attachments/receipt.png');
    stepMock.mockImplementationOnce(real.executeStep!);

    const { status, body } = await run('up-missing', { testFilePath });

    expect(status).toBe(200);
    expect(body['status']).toBe('failed');
    expect(body['results'][0].status).toBe('failed');
    // The batch-level `error` is where the step's text ends up; the per-step
    // row carries no message of its own.
    const message = String(body['error']?.message);
    expect(message).toContain('Upload file not found');
    // The message names the path it actually tried, so a wrong base directory
    // shows up in the failure rather than being a mystery.
    expect(message).toContain(path.join(projectRoot, 'tests', 'attachments', 'receipt.png'));

    // THE assertion. Retries are on — this is not passing because the run had
    // none to spend — and no amount of re-planning makes a file appear, so a
    // second turn would be money burnt on a certainty.
    expect(aiCalls).toHaveLength(1);
    expect(
      (optsAt()['config'] as Config).execution.retries,
      'retries must be non-zero or the assertion above proves nothing',
    ).toBeGreaterThan(0);
  });

  it('DOES spend a second turn on an ordinary failure, which is the control', async () => {
    // Without this the test above proves nothing: a harness where the runner
    // simply never gets as far as a second attempt would satisfy it just as
    // well as a working non-retryable tag. A model that answers with rubbish
    // is the plainest retryable failure there is, and it costs a turn each
    // time — exactly what a missing file must not do.
    aiResponse = 'sorry, I could not do that';
    stepMock.mockImplementationOnce(real.executeStep!);

    const { body } = await run('up-retryable-control', { testFilePath });

    expect(body['status']).toBe('failed');
    expect(aiCalls).toHaveLength(2);
  });

  it('says there is no test file to resolve against when the request had none', async () => {
    // The consequence of the absent `baseDir`, stated at the far end. Without
    // this, the block above is only a claim about the shape of an object.
    aiResponse = uploadPlan('attachments/receipt.png');
    stepMock.mockImplementationOnce(real.executeStep!);

    const { body } = await run('up-missing-no-testfile');

    const message = String(body['error']?.message);
    expect(message).toContain('no test file to resolve it against');
    expect(message).not.toContain(process.cwd());
    expect(aiCalls).toHaveLength(1);
  });
});

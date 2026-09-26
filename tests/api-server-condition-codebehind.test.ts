/**
 * A condition decided by code-behind, over HTTP
 * (stories/codebehind-loops-and-conditions.md, "The run loops").
 *
 * **Every test here POSTs through the real `node:http` entry**, for the reason
 * `api-server-control-flow.test.ts` gives: the step route builds its request
 * from a per-field allow-list, and the guard's code-behind rides on what the
 * SERVER derives — the registry it builds from the test file beside the
 * request's `testFilePath`, the guard it expands from `steps` + `sections`.
 * Nothing new travels on the wire; the claim is that a `.steps.ts` sitting
 * beside the test is found and used for the guard, and that the guard's
 * events carry what the gutter needs.
 *
 * The browser, the model and the report writer are mocked. The condition
 * entries are REAL: a `.steps.ts` on disk, bundled by the real loader and run
 * by the real `runConditionCode` against a mock page whose `nextEnabled()` the
 * entry reads. Only the settle gate is stubbed (it would poll a real DOM).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';

// ── Mocks (mirror api-server-control-flow.test.ts) ──────────────────────────

const pageState = vi.hoisted(() => ({ nextEnabled: [] as boolean[], calls: 0 }));

const mockPage = {
  url: vi.fn(() => 'https://example.com/statements'),
  title: vi.fn(async () => 'Statements'),
  goto: vi.fn(async () => null),
  /** What the test's condition entry reads — one scripted answer per call. */
  nextEnabled: () => {
    pageState.calls++;
    return pageState.nextEnabled.length > 0 ? pageState.nextEnabled.shift()! : false;
  },
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

const judge = vi.hoisted(() => ({ calls: [] as string[][], script: [] as Array<number | null> }));
const executed = vi.hoisted(() => ({ steps: [] as string[] }));

vi.mock('../src/runner/step-executor.js', async (importOriginal) => ({
  // The real module underneath — `runConditionCode` is what runs the entry.
  ...(await importOriginal<typeof import('../src/runner/step-executor.js')>()),
  executeStep: vi.fn(async (_i: number, _t: number, instruction: string): Promise<StepResult> => {
    executed.steps.push(instruction);
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
  evaluateConditions: vi.fn(async (conditions: string[]) => {
    judge.calls.push([...conditions]);
    const selected = judge.script.length > 0 ? judge.script.shift()! : null;
    return {
      selected,
      reasoning: selected === null ? 'the model saw none hold' : `the model saw ${selected} hold`,
      aiInteractions: [],
    };
  }),
  // It would poll a real DOM for quiet; the mock page has none.
  settleBeforeConditions: vi.fn(async () => {}),
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
const generatedReports = vi.hoisted(() => [] as any[]);
vi.mock('../src/report/generator.js', () => ({
  generateReport: vi.fn(async (report: unknown) => {
    generatedReports.push(report);
    return '/tmp/fake-report.html';
  }),
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
  shouldEmit: vi.fn(() => true),
  setLogLevel: vi.fn(),
  getLogLevel: vi.fn(() => 'info'),
}));

import { createApiServer } from '../src/server/api-server.js';
import { readLastRun } from '../src/codebehind/last-run.js';

const API_KEY = 'sk-condition-codebehind-test';
const cfg: Config = {
  // A key, so the run is NOT keyless: a broken condition entry heals under the
  // (mocked) model rather than failing with the keyless advice.
  ai: { gatewayUrl: 'https://ai.test', model: 't', apiKey: 'sk-model', maxInputTokens: 1000, streamResponses: false, sendScreenshots: false },
  browser: { headed: false, viewport: { width: 1280, height: 720 }, windowSize: { width: 1280, height: 720 }, slowMo: 0, browser: 'chromium', fullPageScreenshots: true },
  tests: { dir: './tests', contextDir: './context', pattern: '**/*.md' },
  execution: { timeout: 30000, retries: 1, screenshotOnFailure: true, promptOnAmbiguity: false, maxTurns: 5, maxLoopIterations: 25 },
  reports: { outputDir: './reports', includeScreenshots: false, includeDomSnapshots: false, includeAiReasoning: false, embedScreenshots: false },
  api: { specsDir: './specs', requestTimeout: 30000, redactSensitive: true },
  server: { host: '127.0.0.1', port: 0, apiKey: API_KEY },
  logging: { consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
} as Config;

let server: Server;
let baseUrl: string;
let tmpDir: string;

beforeAll(async () => {
  const { app } = createApiServer(cfg);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) baseUrl = `http://127.0.0.1:${addr.port}`;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'condition-codebehind-http-'));
});

afterAll(async () => {
  await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  judge.calls.length = 0;
  judge.script = [];
  executed.steps.length = 0;
  pageState.nextEnabled = [];
  pageState.calls = 0;
  generatedReports.length = 0;
});

// ── Helpers ─────────────────────────────────────────────────────────────────

let seq = 0;

async function collect(body: unknown): Promise<Array<{ type: string; [k: string]: any }>> {
  const res = await fetch(`${baseUrl}/sessions/cond-${++seq}/steps?stream=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, Accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const out: Array<{ type: string; [k: string]: any }> = [];
  for (const chunk of text.split('\n\n')) {
    const line = chunk.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    try { out.push(JSON.parse(line.slice(6))); } catch { /* keep-alive */ }
  }
  return out;
}

async function post(body: unknown): Promise<any> {
  const res = await fetch(`${baseUrl}/sessions/cond-${++seq}/steps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(body),
  });
  return res.json();
}

const WHILE_LINE = 'While the Next button is enabled, Go to the next page';

/** A test file and its `.steps.ts`, fresh per test so sidecars cannot mix. */
async function project(name: string, entries: string): Promise<string> {
  const testFilePath = path.join(tmpDir, `${name}.md`);
  await fs.writeFile(testFilePath, '# placeholder — the server never reads this\n');
  await fs.writeFile(path.join(tmpDir, `${name}.steps.ts`), `export default [\n${entries}\n];\n`);
  return testFilePath;
}

/**
 *     3. Open the statements page
 *     4. While the Next button is enabled, Go to the next page
 *     5. Verify the last page is shown
 *     ### Go to the next page   (heading 7)
 *     8. Click Next
 */
const whileBody = (testFilePath: string) => ({
  steps: ['Open the statements page', WHILE_LINE, 'Verify the last page is shown'],
  sourceLines: [3, 4, 5],
  testFilePath,
  sections: {
    'go to the next page': {
      name: 'Go to the next page',
      headingLine: 7,
      steps: ['Click Next'],
      stepLines: [8],
    },
  },
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('a While with a condition entry, over HTTP', () => {
  it('runs its passes with no judge call, and the guard events carry fromCodeBehind', async () => {
    const testFilePath = await project(
      'statements',
      `  {
    source: ${JSON.stringify(WHILE_LINE)},
    async condition({ page }) { return page.nextEnabled(); },
  },`,
    );
    pageState.nextEnabled = [true, true, false];

    const events = await collect(whileBody(testFilePath));

    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
    expect(judge.calls).toEqual([]);
    expect(pageState.calls).toBe(3);
    expect(executed.steps).toEqual([
      'Open the statements page',
      'Click Next',
      'Click Next',
      'Verify the last page is shown',
    ]);

    const guardPasses = events.filter((e) => e.type === 'step:pass' && e.line === 4);
    expect(guardPasses).toHaveLength(3);
    for (const e of guardPasses) {
      expect(e.fromCodeBehind).toBe(true);
      expect(e.codeBehindStale).toBeUndefined();
      expect(e.output).toMatch(/^Decided by code-behind: "the Next button is enabled" → (true|false)$/);
    }

    // The report's guard rows say who decided, structurally.
    const rows = (generatedReports.at(-1)?.steps ?? []).filter(
      (s: StepResult) => s.instruction === WHILE_LINE,
    );
    expect(rows.map((r: StepResult) => r.guard)).toEqual([
      { decidedBy: 'code', holds: true },
      { decidedBy: 'code', holds: true },
      { decidedBy: 'code', holds: false },
    ]);
    expect(rows.every((r: StepResult) => r.fromCodeBehind === true)).toBe(true);

    // The sidecar records the guard as code, not stale.
    const sidecar = await readLastRun(testFilePath);
    const guardRows = sidecar?.steps.filter((s) => s.source === WHILE_LINE) ?? [];
    expect(guardRows.length).toBeGreaterThan(0);
    expect(guardRows.every((s) => s.fromCodeBehind && !s.stale)).toBe(true);
  });

  it('puts the code reasoning on the response body\'s results', async () => {
    const testFilePath = await project(
      'statements-results',
      `  {
    source: ${JSON.stringify(WHILE_LINE)},
    async condition({ page }) { return page.nextEnabled(); },
  },`,
    );
    pageState.nextEnabled = [false];
    const body = await post(whileBody(testFilePath));
    const guard = body.results.find((r: { step: string }) => r.step === WHILE_LINE);
    expect(guard.reasoning).toBe('Decided by code-behind: "the Next button is enabled" → false');
    expect(judge.calls).toEqual([]);
  });

  it('heals a throwing condition under the model, and step:pass carries codeBehindStale', async () => {
    const testFilePath = await project(
      'statements-broken',
      `  {
    source: ${JSON.stringify(WHILE_LINE)},
    async condition() { throw new Error('Next resolved to 2 elements'); },
  },`,
    );
    judge.script = [0, null];

    const events = await collect(whileBody(testFilePath));

    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
    // Once per visit: the entry was discarded after the first throw, so the
    // second visit went straight to the model.
    expect(judge.calls).toEqual([['the Next button is enabled'], ['the Next button is enabled']]);
    const guardPasses = events.filter((e) => e.type === 'step:pass' && e.line === 4);
    expect(guardPasses[0]!.codeBehindStale).toEqual({
      file: path.join(tmpDir, 'statements-broken.steps.ts'),
      error: 'Next resolved to 2 elements',
    });
    expect(guardPasses[0]!.fromCodeBehind).toBeUndefined();
    expect(guardPasses[1]!.codeBehindStale).toBeUndefined();

    const sidecar = await readLastRun(testFilePath);
    const stale = sidecar?.steps.filter((s) => s.stale) ?? [];
    expect(stale).toEqual([
      expect.objectContaining({ source: WHILE_LINE, error: 'Next resolved to 2 elements' }),
    ]);
  });
});

describe('a chain whose broken member is not the one that held', () => {
  /**
   *     3. Open the payments page
   *     4. If the Cash checkbox is ticked, then Pay with cash
   *     5. Else if the Card checkbox is ticked, then Pay by card
   *     6. Verify the order confirmation is shown
   */
  const IF_LINE = 'If the Cash checkbox is ticked, then Pay with cash';
  const ELSE_IF_LINE = 'Else if the Card checkbox is ticked, then Pay by card';
  const chainBody = (testFilePath: string) => ({
    steps: ['Open the payments page', IF_LINE, ELSE_IF_LINE, 'Verify the order confirmation is shown'],
    sourceLines: [3, 4, 5, 6],
    testFilePath,
    sections: {
      'pay with cash': { name: 'Pay with cash', headingLine: 8, steps: ['Click Pay now'], stepLines: [9] },
      'pay by card': { name: 'Pay by card', headingLine: 11, steps: ['Enter the card details'], stepLines: [12] },
    },
  });

  it('keys the stale sidecar row to the member whose code threw', async () => {
    const testFilePath = await project(
      'payments',
      `  {
    source: ${JSON.stringify(IF_LINE)},
    async condition() { throw new Error('Cash checkbox went away'); },
  },
  {
    source: ${JSON.stringify(ELSE_IF_LINE)},
    async condition() { return true; },
  },`,
    );
    // The model is asked about the WHOLE chain and picks the Else if.
    judge.script = [1];

    const events = await collect(chainBody(testFilePath));

    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
    expect(judge.calls).toEqual([['the Cash checkbox is ticked', 'the Card checkbox is ticked']]);
    expect(executed.steps).toContain('Enter the card details');
    // The event names the Else if's line (the row) and the If's entry (stale).
    const pass = events.find((e) => e.type === 'step:pass' && e.line === 5);
    expect(pass?.codeBehindStale).toEqual({
      file: path.join(tmpDir, 'payments.steps.ts'),
      error: 'Cash checkbox went away',
    });

    const sidecar = await readLastRun(testFilePath);
    const bySource = new Map(sidecar!.steps.map((s) => [s.source, s]));
    expect(bySource.get(IF_LINE)).toMatchObject({ stale: true, error: 'Cash checkbox went away' });
    // The row that HELD is not stale: its own entry did nothing wrong.
    expect(bySource.get(ELSE_IF_LINE)).toMatchObject({ stale: false });
  });
});

/**
 * Data rows on the wire (stories/data-driven-rows.md, part A §"Sessions API").
 *
 * Driven over real HTTP through the real app, per the house rule for a
 * server-delivered feature: the steps route builds its `StepRequest` from an
 * explicit field list, so widening the types alone compiles cleanly and can
 * still drop the value before it reaches the session manager. That is how
 * `envName` was once lost while its own resolver's unit tests stayed green.
 *
 * The behaviour under test is a *negative* one — a batch carrying `dataRow`
 * writes NO report — so every assertion is on `generateReport`, the seam the
 * whole decision lands on. Asserting on the response body would pass with the
 * feature unimplemented, since a per-row report path is also "a path".
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Express } from 'express';
import type { Config } from '../src/config/types.js';
import type { StepResult, TestReport } from '../src/report/types.js';

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

// The seam. Note `generateReport` is NOT mocked away to a constant here — the
// tests read back the report object it was handed, which is what proves the
// merge produced loop markers and a matrix rather than merely writing a file.
const generateReportMock = vi.fn(async (report: TestReport) => `/tmp/${report.testName}.html`);
vi.mock('../src/report/generator.js', async () => {
  const actual = await vi.importActual<typeof import('../src/report/generator.js')>(
    '../src/report/generator.js',
  );
  return {
    generateReport: (...args: unknown[]) =>
      generateReportMock(...(args as [TestReport, string])),
    getPrimaryModel: vi.fn(() => 'mock-model'),
    buildReportBaseName: actual.buildReportBaseName,
    videoBaseNameFor: actual.videoBaseNameFor,
    countStepOrigins: actual.countStepOrigins,
  };
});

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
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

const API_KEY = 'rows-key';

const testConfig: Config = {
  ...DEFAULT_CONFIG,
  ai: { ...DEFAULT_CONFIG.ai, model: 'server/base-model', apiKey: 'server-ai-key' },
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

async function postSteps(
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

async function postReport(
  sessionId: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/sessions/${sessionId}/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The report handed to `generateReport` on its Nth (0-based) call. */
function renderedReport(call = 0): TestReport {
  const args = generateReportMock.mock.calls[call];
  expect(args, `no generateReport call #${call}`).toBeDefined();
  return args![0] as TestReport;
}

let unique = 0;
function sessionId(label: string): string {
  return `rows-${label}-${++unique}`;
}

/** Run three rows against one session id, closing between them as the client does. */
async function runThreeRows(id: string): Promise<void> {
  for (const [index, email] of ['a@b.c', 'd@e.f', 'g@h.i'].entries()) {
    await postSteps(id, {
      testFilePath: '/tests/matrix.md',
      dataRow: index + 1,
      dataRowCount: 3,
      dataRowValues: { email },
      parameters: { email, shared: 'yes' },
    });
  }
}

beforeAll(async () => {
  const { app } = createApiServer(testConfig);
  ({ server, baseUrl } = await listenOnRandomPort(app));
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

beforeEach(() => {
  generateReportMock.mockClear();
});

describe('a batch carrying dataRow', () => {
  it('writes no report of its own', async () => {
    const id = sessionId('accumulate');
    const { status } = await postSteps(id, {
      testFilePath: '/tests/matrix.md',
      dataRow: 1,
      dataRowCount: 3,
      dataRowValues: { email: 'a@b.c' },
    });

    expect(status).toBe(200);
    expect(generateReportMock).not.toHaveBeenCalled();
  });

  it('still writes one when the batch has no dataRow', async () => {
    // The regression guard: the accumulator must not swallow every report.
    const id = sessionId('plain');
    await postSteps(id, { testFilePath: '/tests/plain.md' });
    expect(generateReportMock).toHaveBeenCalledTimes(1);
  });
});

describe('POST /sessions/:id/report', () => {
  it('renders the accumulated rows as one report', async () => {
    const id = sessionId('finalise');
    await runThreeRows(id);
    expect(generateReportMock).not.toHaveBeenCalled();

    const { status, body } = await postReport(id);
    expect(status).toBe(200);
    expect(body['reportPath']).toBeTruthy();
    expect(generateReportMock).toHaveBeenCalledTimes(1);

    const report = renderedReport();
    expect(report.steps).toHaveLength(3);
    expect(report.steps.map((s) => s.loop?.index)).toEqual([1, 2, 3]);
    expect(report.steps[0]!.loop).toMatchObject({
      kind: 'row',
      count: 3,
      values: { email: 'a@b.c' },
    });
    expect(report.rows?.map((r) => r.index)).toEqual([1, 2, 3]);
  });

  it('keeps the parameters every row shared and drops the ones that varied', async () => {
    const id = sessionId('params');
    await runThreeRows(id);
    await postReport(id);

    const report = renderedReport();
    expect(report.parameters).toEqual({ shared: 'yes' });
  });

  it('lists rows the client never reached', async () => {
    const id = sessionId('notrun');
    await postSteps(id, {
      testFilePath: '/tests/matrix.md',
      dataRow: 1,
      dataRowCount: 3,
      dataRowValues: { email: 'a@b.c' },
    });

    await postReport(id, {
      notRun: [
        { row: 2, values: { email: 'd@e.f' }, reason: 'stopped' },
        { row: 3, values: { email: 'g@h.i' }, reason: 'stopped' },
      ],
    });

    const rows = renderedReport().rows!;
    expect(rows.map((r) => [r.index, r.status])).toEqual([
      [1, 'passed'],
      [2, 'skipped'],
      [3, 'skipped'],
    ]);
    expect(rows[1]!.notRunReason).toBe('stopped');
  });

  it('is a 404, not a 500, when nothing is accumulated', async () => {
    // What a double-post after a crash looks like; it must be harmless.
    const id = sessionId('empty');
    const { status } = await postReport(id);
    expect(status).toBe(404);
  });

  it('does not render twice for one run', async () => {
    const id = sessionId('once');
    await runThreeRows(id);
    await postReport(id);
    const second = await postReport(id);

    expect(second.status).toBe(404);
    expect(generateReportMock).toHaveBeenCalledTimes(1);
  });

  it('records the path for a stopped client to recover', async () => {
    // The stop path is the one that must still produce a report: the client
    // closed its SSE stream and polls last-run for the path instead.
    const id = sessionId('lastrun');
    await runThreeRows(id);
    const { body } = await postReport(id);

    const res = await fetch(`${baseUrl}/sessions/${id}/last-run`, {
      headers: { 'x-api-key': API_KEY },
    });
    const lastRun = (await res.json()) as { finalized: boolean; reportPath?: string };
    expect(lastRun.finalized).toBe(true);
    expect(lastRun.reportPath).toBe(body['reportPath']);
  });

  it('starts fresh on row 1 so a re-run does not inherit the last one', async () => {
    const id = sessionId('rerun');
    await runThreeRows(id);
    await runThreeRows(id); // a second run of the same file, same session id
    await postReport(id);

    expect(renderedReport().steps).toHaveLength(3);
  });
});

describe('validation at the wire', () => {
  it.each([
    ['dataRow without dataRowCount', { dataRow: 1 }],
    ['a zero dataRow', { dataRow: 0, dataRowCount: 3 }],
    ['a dataRow past the count', { dataRow: 4, dataRowCount: 3 }],
    ['a non-integer dataRow', { dataRow: 1.5, dataRowCount: 3 }],
    ['dataRowCount alone', { dataRowCount: 3 }],
    ['dataRowValues that is not an object', { dataRow: 1, dataRowCount: 1, dataRowValues: 'x' }],
    [
      'dataRowValues holding a non-string',
      { dataRow: 1, dataRowCount: 1, dataRowValues: { a: 2 } },
    ],
  ])('rejects %s', async (_label, fields) => {
    const { status } = await postSteps(sessionId('bad'), fields);
    expect(status).toBe(400);
    expect(generateReportMock).not.toHaveBeenCalled();
  });

  it('rejects a notRun entry with no row number', async () => {
    const { status } = await postReport(sessionId('badnotrun'), { notRun: [{ reason: 'x' }] });
    expect(status).toBe(400);
  });
});

describe('section rows on the wire', () => {
  it('expands a looped section once per row and marks each step', async () => {
    // The seam that matters: the section entry is rebuilt field by field on
    // the way in, so `rows` travels only because it is named there.
    const id = sessionId('section-rows');
    const { status } = await postSteps(id, {
      testFilePath: '/tests/loop.md',
      steps: ['Upload each file'],
      sourceLines: [3],
      sections: {
        'upload each file': {
          name: 'Upload each file',
          headingLine: 5,
          steps: ['Upload {{file}}'],
          stepLines: [9],
          rows: [{ file: 'a.png' }, { file: 'b.png' }],
        },
      },
      dataRow: 1,
      dataRowCount: 1,
      dataRowValues: {},
    });
    expect(status).toBe(200);

    await postReport(id);
    const report = renderedReport();
    // One authored body step, two rows: two executed steps.
    expect(report.steps).toHaveLength(2);
    expect(report.steps.map((s) => s.loop?.index)).toEqual([1, 2]);
    expect(report.steps[0]!.loop).toMatchObject({
      kind: 'iteration',
      label: 'Upload each file',
      count: 2,
      values: { file: 'a.png' },
    });
  });

  it('rejects a malformed rows field', async () => {
    const { status } = await postSteps(sessionId('bad-rows'), {
      testFilePath: '/tests/loop.md',
      steps: ['Upload each file'],
      sourceLines: [3],
      sections: {
        'upload each file': {
          name: 'Upload each file',
          headingLine: 5,
          steps: ['Upload {{file}}'],
          stepLines: [9],
          rows: 'not-an-array',
        },
      },
    });
    expect(status).toBe(400);
  });
});

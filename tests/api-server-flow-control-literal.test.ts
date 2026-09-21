/**
 * `If {{payment.status}} is "Overdue", then return` over the real Sessions API
 * run loop, with the REAL executor
 * (docs/specs/SPEC-structured-table-reads.md §8.3a).
 *
 * Every other `api-server-flow-control*.test.ts` mocks `executeStep`, which is
 * exactly the piece that decides a flow-control condition — so none of them
 * can tell a line answered from this run's values from one the model judged.
 * Here the executor is real and only its edges are stubbed: no browser, no
 * network, a scripted AI client that records what it was sent. The harness is
 * `api-server-values-block.test.ts`', for the same reason.
 *
 * The steps below are `templates/init/tests/table-payments-review.md`, shortened:
 * a `For each` over rows read from a table, and a section whose first line is
 * the spec's headline example. It is the shape the acceptance runs measured a
 * `settle` wait and an `ai.complete` on, per pass, per row, to compare two
 * strings that were both already in hand.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Express } from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config/types.js';
import type { AIAction, ChatMessage } from '../src/ai/types.js';

const ai = vi.hoisted(() => ({ requests: [] as ChatMessage[][], responses: [] as string[] }));
const acted = vi.hoisted(() => ({ received: [] as AIAction[] }));
/** How many times the page was asked to settle. The flow-control judgement
 *  pays that gate before it asks anything; a decision made from the values
 *  pays neither. */
const settles = vi.hoisted(() => ({ count: 0 }));

const mockPage = {
  url: () => 'https://app.test/scheduled-payments.html',
  title: async () => 'Scheduled payments',
  goto: async () => null,
  on: () => {},
  off: () => {},
  context: () => ({ browser: () => ({}) }),
  evaluate: async () => { throw new Error('no DOM in this test'); },
  screenshot: async () => { throw new Error('no screenshot in this test'); },
  waitForLoadState: async () => {},
};

const mockBrowserSession = {
  browser: { isConnected: () => true },
  context: {},
  page: mockPage,
  pageTracker: { getActive: () => mockPage, count: 1 },
};

vi.mock('../src/browser/manager.js', () => {
  class BrowserTracker {
    getActive = () => mockBrowserSession;
    getActivePage = () => mockPage;
    closeAll = async () => {};
    all = () => [];
    count = 1;
    list = () => [];
  }
  return {
    launchBrowser: async () => ({ ...mockBrowserSession }),
    PageTracker: class {},
    BrowserTracker,
    briefly: async (p: Promise<unknown>, ms: number, fallback: unknown) =>
      Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]),
    resolveVideoMode: () => 'off',
    finalizeMainPageVideo: async (args: { closeContext: () => Promise<void> }) => {
      await args.closeContext();
      return undefined;
    },
  };
});

vi.mock('../src/browser/actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/actions.js')>();
  return {
    ...actual,
    executeAction: vi.fn(async (_page: unknown, action: AIAction) => {
      acted.received.push(action);
      return { success: true };
    }),
  };
});

vi.mock('../src/browser/dom-cleaner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/dom-cleaner.js')>();
  return { ...actual, captureDomSnapshot: async () => '<html><body>rows</body></html>' };
});

vi.mock('../src/browser/page-state.js', () => ({
  diagnosePageState: async () => ({
    isLoading: false, loadingIndicators: [], hasErrorOverlay: false,
    errorMessages: [], hasModal: false, documentLoading: false,
  }),
  waitForPageStability: async () => { settles.count++; },
  waitForPostActionSettle: async () => {},
  capturePageSignal: async () => ({ url: 'https://app.test/', domLength: 1 }),
  PageActivityTracker: class {
    isIdle(): boolean { return true; }
    dispose(): void {}
  },
}));

vi.mock('../src/browser/screenshot.js', () => ({ captureScreenshot: async () => null }));
vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: async () => ({ files: [], combined: '' }),
}));

vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    setAiPolicy(): void {}
    syncAuth(): null { return null; }
    async complete(messages: ChatMessage[]): Promise<{ text: string; model: string }> {
      ai.requests.push(messages);
      const text = ai.responses[ai.requests.length - 1] ?? ai.responses[ai.responses.length - 1]!;
      return { text, model: 'stub' };
    }
  },
}));

vi.mock('../src/report/generator.js', () => ({
  generateReport: async () => '/tmp/fake-report.html',
  getPrimaryModel: () => 'stub',
  buildReportBaseName: (report: { testName: string }) => report.testName,
  videoBaseNameFor: () => 'v',
  countStepOrigins: () => ({}),
}));

import { createApiServer } from '../src/server/api-server.js';

const API_KEY = 'flow-control-literal-key';

let projectRoot: string;
let testFilePath: string;
let server: Server;
let baseUrl: string;

function testConfig(): Config {
  return {
    ai: {
      gatewayUrl: 'https://ai.test', model: 'test-model', maxInputTokens: 1000,
      streamResponses: false, sendScreenshots: false,
    },
    browser: {
      headed: false, viewport: { width: 1280, height: 720 },
      windowSize: { width: 1280, height: 720 }, slowMo: 0, browser: 'chromium',
      fullPageScreenshots: false, captureScreenshotsPerAction: false,
    },
    tests: { dir: './tests', contextDir: './context', pattern: '**/*.md' },
    execution: {
      timeout: 30_000, retries: 0, screenshotOnFailure: false,
      promptOnAmbiguity: false, maxTurns: 2, maxLoopIterations: 25,
    },
    reports: {
      outputDir: path.join(projectRoot, 'reports'), includeScreenshots: false,
      includeDomSnapshots: false, includeAiReasoning: true, embedScreenshots: false,
    },
    api: { specsDir: './specs', requestTimeout: 30_000, redactSensitive: true },
    server: { host: '127.0.0.1', port: 0, apiKey: API_KEY },
    cache: { enabled: false, dir: '.cache' },
    logging: { consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
  } as unknown as Config;
}

async function listenOnRandomPort(app: Express): Promise<{ server: Server; baseUrl: string }> {
  const started = createServer(app);
  await new Promise<void>((resolve) => { started.listen(0, '127.0.0.1', () => resolve()); });
  const addr = started.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { server: started, baseUrl: `http://127.0.0.1:${port}` };
}

let sessionSeq = 0;
const nextSession = (): string => `fcl-${++sessionSeq}`;

async function collect(body: unknown): Promise<Array<{ type: string; [k: string]: any }>> {
  const res = await fetch(
    `${baseUrl}/sessions/${encodeURIComponent(nextSession())}/steps?stream=1`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, Accept: 'text/event-stream' },
      body: JSON.stringify(body),
    },
  );
  if (!res.body) throw new Error('no response body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const out: Array<{ type: string; [k: string]: any }> = [];
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
        out.push(JSON.parse(dataLine.slice(6)) as { type: string; [k: string]: any });
      } catch {
        /* keep-alives */
      }
    }
  }
  return out;
}

/** The plain (non-SSE) POST, for the `results` array a client reads off the
 *  response. It is the one place each executed step's SUBSTITUTED text is
 *  carried back verbatim. */
async function post(body: unknown): Promise<any> {
  const res = await fetch(`${baseUrl}/sessions/${encodeURIComponent(nextSession())}/steps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** One `noop` plan, which answers every step the model IS asked about. */
const NOOP = JSON.stringify({
  actions: [{ action: 'noop', description: 'nothing to do' }],
  reasoning: 'ok',
  needs_reeval: false,
});

beforeAll(async () => {
  projectRoot = mkdtempSync(path.join(tmpdir(), 'aiui-fc-literal-'));
  mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
  writeFileSync(path.join(projectRoot, 'aiui.config.json'), JSON.stringify({}));
  testFilePath = path.join(projectRoot, 'tests', 'table-payments-review.md');
  writeFileSync(testFilePath, '# Review\n\n## Steps\n1. placeholder\n');
  const { app } = createApiServer(testConfig());
  ({ server, baseUrl } = await listenOnRandomPort(app));
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  rmSync(projectRoot, { recursive: true, force: true });
});

beforeEach(() => {
  ai.requests = [];
  ai.responses = [NOOP];
  acted.received = [];
  settles.count = 0;
});

/**
 * Three rows, one of them Overdue — `templates/init/tests/table-payments-review.md`
 * cut to the shape that matters. Expanded, the run is six steps:
 *
 * ```
 * 0  Navigate to scheduled-payments.html
 * 1  For each {{payment}} in {{payments}}, Review the payment   ← guard, body 2..4
 * 2    If {{payment.status}} is "Overdue", then return
 * 3    Click View in row {{payment._row}} …
 * 4    Verify the Payment details page shows "{{payment.payee}}"
 * 5  Verify the Scheduled payments table still shows 3 payments
 * ```
 */
const RETURN_LINE = 'If {{payment.status}} is "Overdue", then return';
const ROWS =
  '[{"_row":"1","payee":"Origin Energy","status":"Scheduled"},' +
  '{"_row":"2","payee":"Sydney Water","status":"Overdue"},' +
  '{"_row":"3","payee":"Origin Energy","status":"Paused"}]';

const reviewBody = (firstSectionStep = RETURN_LINE) => ({
  steps: [
    'Navigate to scheduled-payments.html',
    'For each {{payment}} in {{payments}}, Review the payment',
    'Verify the Scheduled payments table still shows 3 payments',
  ],
  sourceLines: [3, 4, 5],
  testFilePath,
  parameters: { payments: ROWS },
  sections: {
    'review the payment': {
      name: 'Review the payment',
      headingLine: 7,
      steps: [
        firstSectionStep,
        'Click View in row {{payment._row}} of the Scheduled payments table',
        'Verify the Payment details page shows "{{payment.payee}}"',
      ],
      stepLines: [8, 9, 10],
    },
  },
});

/**
 * The `## Current Step` of every prompt, one per `ai.complete`.
 *
 * The SECTION rather than the whole message, because the prompt also carries
 * `## Prior Steps` — a line that returned is quoted back to later steps, so a
 * search over the whole prompt finds `then return` in runs where no model was
 * ever asked about one.
 */
function askedAbout(): string[] {
  return ai.requests.map((messages) => section(promptText(messages), '## Current Step'));
}

/** The `## Values` block of every prompt, alongside {@link askedAbout} — the
 *  step text stays AUTHORED on this path, so the row a pass is bound to is
 *  only visible here. */
function valuesShown(): string[] {
  return ai.requests.map((messages) => section(promptText(messages), '## Values'));
}

function promptText(messages: ChatMessage[]): string {
  const content = messages[messages.length - 1]?.content;
  return typeof content === 'string' ? content : JSON.stringify(content);
}

function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start === -1) return '';
  const rest = text.slice(start + heading.length);
  const end = rest.indexOf('\n##');
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

describe('a flow-control condition the row already answers', () => {
  it('returns on the Overdue row without asking the model anything', async () => {
    const events = await collect(reviewBody());

    // The point of the test: the returning line was never shown to a model,
    // on any of the three passes.
    expect(askedAbout().filter((text) => text.includes('then return'))).toEqual([]);
    // …and paid no settle gate either. Three passes' worth of page
    // stabilisation, for a comparison of two strings already in hand.
    expect(settles.count).toBe(0);

    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
  });

  it('records the runtime"s own sentence where the model"s would have gone', async () => {
    const events = await collect(reviewBody());

    // The returning pass is row 2, Sydney Water. The run loop prefixes the
    // executor's bare detail with the flow's name, exactly as it does the
    // model's — so a reader cannot tell which judged it except by the words.
    const returned = events.filter(
      (e) => e.type === 'step:pass' && String(e.output ?? '').startsWith('Returned from'),
    );
    expect(returned.map((e) => e.output)).toEqual([
      'Returned from "Review the payment": decided from the values: "Overdue" is "Overdue" → true',
    ]);
  });

  it('skips the rest of that pass, in the shape a judged return skips it', async () => {
    const events = await collect(reviewBody());
    const skips = events.filter((e) => e.type === 'step:skip');

    // Steps 4 and 5 of the expanded run — `Click View` and `Verify …` — for
    // the Overdue pass only. The reason quotes the AUTHORED line, never the
    // substituted one.
    expect(skips.map((e) => e.reason)).toEqual([
      `Not run: step 3 returned from "Review the payment" — ${RETURN_LINE}`,
      `Not run: step 3 returned from "Review the payment" — ${RETURN_LINE}`,
    ]);
    expect(skips.map((e) => e.line)).toEqual([9, 10]);
  });

  it('runs the other two passes in full', async () => {
    const body = await post(reviewBody());
    // Rows 1 and 3 took the body; row 2 did not. Each pass names its own
    // `_row`, which is the whole point of the fixture — the row the pass is
    // bound to, not the row a model picked off the page.
    // The step text stays AUTHORED all the way to the wire (placeholders are
    // preserved and substituted at act time), so the row each pass ran on is
    // read off the `## Values` block the model was shown.
    const asked = askedAbout();
    const rows = valuesShown().filter((_v, i) => asked[i]!.startsWith('Click View in row '));
    expect(rows).toEqual([
      '- {{payment._row}} resolved to "1" on this run',
      '- {{payment._row}} resolved to "3" on this run',
    ]);
    // The returning pass's own rows, in the shape a judged return leaves.
    expect(
      (body.results as Array<{ step: string; status: string }>)
        .filter((r) => r.status === 'skipped')
        .map((r) => r.step),
    ).toEqual([
      'Click View in row {{payment._row}} of the Scheduled payments table',
      'Verify the Payment details page shows "{{payment.payee}}"',
    ]);
  });

  it('still asks once per pass when the condition is about the page', async () => {
    // The control. `If the Overdue badge is shown, then return` has no
    // reference in the authored line, so it is never a candidate — three
    // passes, three judgements, three settle gates, exactly as before.
    const events = await collect(reviewBody('If the Overdue badge is shown, then return'));
    expect(askedAbout().filter((t) => t.includes('then return'))).toHaveLength(3);
    expect(settles.count).toBe(3);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
  });

  it('fails the run in the author"s own words on the third verb', async () => {
    const events = await collect(
      reviewBody('If {{payment.status}} is "Overdue", then fail the test with error "Pay it first"'),
    );

    const failure = events.find((e) => e.type === 'step:fail');
    expect(failure!.error).toBe('Pay it first');
    // The first pass (Scheduled) ran its body; the second failed the run.
    expect(askedAbout().filter((t) => t.includes('then fail the test'))).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'failed' });
  });
});

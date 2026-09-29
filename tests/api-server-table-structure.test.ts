/**
 * The structure question, through the real Sessions API entry
 * (docs/specs/SPEC-structured-table-reads.md §7.10, §12 item 30 —
 * the orchestration half).
 *
 * The EXTRACTOR half of item 30 — what a sketch contains, which refusals
 * carry one, what the validation refuses — is `tests/read-table-structure.test.ts`
 * against a real page. This file is about the other half, and it is a
 * different question: who calls the model, how many times, what is recorded,
 * and what the run remembers of the answer for a later step. None of that is
 * visible from inside the extractor, and none of it is exercised by a suite that mocks
 * `executeStep` — which is every other `api-server-*.test.ts` — so the
 * executor here is REAL and only its edges are stubbed: no browser, no
 * network, a scripted AI client that counts what it was asked.
 *
 * The fake extractor answers whatever the test tells it to. That is not a
 * weaker proof than a real page would be: what is being proved is that ONE
 * question is asked for a shape refusal and NONE for anything else, that the
 * validated mapping reaches the recorded action and the run's structure memo,
 * and that a later step in the same run applies it before anything else is
 * tried.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Express } from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config/types.js';
import type { AIAction, ChatMessage } from '../src/ai/types.js';

// ── The scripted model ──────────────────────────────────────────────────────

const ai = vi.hoisted(() => ({
  /** Action-plan answers, one per turn, in order. */
  plans: [] as string[],
  /** Structure answers, one per question, in order. */
  structures: [] as string[],
  planCalls: 0,
  structureCalls: 0,
  /** Every message array the client was handed, flattened to text. */
  sent: [] as string[],
}));

/** The question's system prompt opens with this; nothing else does. */
const STRUCTURE_MARKER = 'You are reading the STRUCTURE of one region';

// ── The fake extractor ──────────────────────────────────────────────────────

const extractor = vi.hoisted(() => ({
  /** Every `readTable` action that reached the page, in order. */
  reads: [] as AIAction[],
  /** What one read does. Set per test. Returning records is a successful
   *  read; throwing is a refusal, and a thrown object carrying `.sketch` is
   *  the SHAPE refusal §7.10 may ask about. */
  handle: null as null | ((action: AIAction) => Array<Record<string, string>>),
  /**
   * Let the refusal escape `executeAction` as a THROW instead of being turned
   * into a failed result.
   *
   * The real `executeAction` catches, and copies the sketch onto the result
   * it returns — which is what every test here exercises by default. The
   * orchestration accepts either carrier on purpose (the extractor owns that
   * choice), and one test flips this so the other half is not dead code the
   * day the extractor changes its mind.
   */
  throwRaw: false,
  /** Every non-readTable action, so a test can see the loop still works. */
  other: [] as AIAction[],
  /** `options.structureSource` as each read was given it — `memo`, `model`
   *  or undefined. The summary line's parenthetical is built from it (§7.6),
   *  and only the CALLER knows which of the two a mapping came from. */
  sources: [] as Array<string | undefined>,
  /** What `expandDomSubtree` answers for the region with no candidates. Set
   *  per test; a test about masking puts a secret in it. */
  subtree:
    '<div id="account-cards"><div class="account-card"><h3 class="card-title">Everyday</h3></div></div>',
}));

const mockPage = {
  url: () => 'https://app.test/odd-tables',
  title: async () => 'Odd tables',
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
    getActive: () => unknown = () => mockBrowserSession;
    getActivePage = () => mockPage;
    closeAll = async () => {};
    all = () => [];
    count = 1;
    list = () => [];
    hasActive = () => true;
    ensureLaunched: () => Promise<unknown> = async () => mockBrowserSession;
    /**
     * Lazy twin of the real static (SPEC-use-computer.md §4.6), modelled as
     * the other api-server suites model it: nothing launches until
     * ensureLaunched(), and it launches at most once.
     */
    static deferred(launch: () => Promise<unknown>): BrowserTracker {
      const tracker = new BrowserTracker();
      let launched: unknown;
      tracker.hasActive = () => launched !== undefined;
      tracker.getActive = () => {
        if (!launched) throw new Error('no browser has been launched in this session');
        return launched;
      };
      tracker.ensureLaunched = async () => {
        if (!launched) launched = await launch();
        return launched;
      };
      return tracker;
    }
  }
  return {
    launchBrowser: async () => ({ ...mockBrowserSession }),
    PageTracker: class {},
    BrowserTracker,
    // api-server and session-manager do `instanceof` against this, and
    // `instanceof undefined` throws, so a mock of this module must export it.
    NoBrowserLaunchedError: class NoBrowserLaunchedError extends Error {
      constructor(message = 'no browser has been launched in this session') {
        super(message);
        this.name = 'NoBrowserLaunchedError';
      }
    },
    NO_BROWSER_LAUNCHED_MESSAGE: 'no browser has been launched in this session',
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
    executeAction: vi.fn(async (
      _page: unknown,
      action: AIAction,
      _baseUrl?: string,
      _signal?: unknown,
      options?: { structureSource?: string },
    ) => {
      if (action.action !== 'readTable') {
        extractor.other.push(action);
        return { success: true };
      }
      extractor.reads.push(action);
      extractor.sources.push(options?.structureSource);
      try {
        return { success: true, capturedRecords: extractor.handle!(action) };
      } catch (err) {
        if (extractor.throwRaw) throw err;
        // What the REAL `executeAction` does with a refusal: catch it, and
        // copy the sketch onto the failed result when there is one
        // (src/browser/actions.ts, the `TableShapeError` arm of its catch).
        const sketch = (err as { sketch?: unknown }).sketch;
        return {
          success: false,
          error: (err as Error).message,
          ...(action.selector !== undefined && { failedSelector: action.selector }),
          ...(sketch !== undefined && { sketch }),
        };
      }
    }),
  };
});

vi.mock('../src/browser/dom-cleaner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/dom-cleaner.js')>();
  return {
    ...actual,
    captureDomSnapshot: async () => '<html><body>odd tables</body></html>',
    expandDomSubtree: async () => extractor.subtree,
  };
});

vi.mock('../src/browser/page-state.js', () => ({
  diagnosePageState: async () => ({
    isLoading: false, loadingIndicators: [], hasErrorOverlay: false,
    errorMessages: [], hasModal: false, documentLoading: false,
  }),
  waitForPageStability: async () => {},
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
      const text = messages
        .map((m) => (typeof m.content === 'string'
          ? m.content
          : m.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n')))
        .join('\n');
      ai.sent.push(text);
      if (text.includes(STRUCTURE_MARKER)) {
        const answer = ai.structures[ai.structureCalls] ?? ai.structures.at(-1);
        ai.structureCalls += 1;
        if (answer === undefined) throw new Error('no structure answer scripted');
        return { text: answer, model: 'stub' };
      }
      const plan = ai.plans[ai.planCalls] ?? ai.plans.at(-1);
      ai.planCalls += 1;
      if (plan === undefined) throw new Error('no action plan scripted');
      return { text: plan, model: 'stub' };
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
import { logger } from '../src/utils/logger.js';

const API_KEY = 'table-structure-key';

let projectRoot: string;
let strictProjectRoot: string;
let server: Server;
let baseUrl: string;
let fileCounter = 0;

function testConfig(): Config {
  return {
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
      fullPageScreenshots: false,
      captureScreenshotsPerAction: false,
    },
    tests: { dir: './tests', contextDir: './context', pattern: '**/*.md' },
    execution: {
      timeout: 30_000, retries: 0, screenshotOnFailure: false,
      promptOnAmbiguity: false, maxTurns: 2,
    },
    reports: {
      outputDir: path.join(projectRoot, 'reports'),
      includeScreenshots: false, includeDomSnapshots: false,
      includeAiReasoning: true, embedScreenshots: false,
    },
    api: { specsDir: './specs', requestTimeout: 30_000, redactSensitive: true },
    server: { host: '127.0.0.1', port: 0, apiKey: API_KEY },
    logging: { consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
    tables: { structure: 'ask' },
  } as unknown as Config;
}

async function listenOnRandomPort(app: Express): Promise<{ server: Server; baseUrl: string }> {
  const started = createServer(app);
  await new Promise<void>((resolve) => { started.listen(0, '127.0.0.1', () => resolve()); });
  const addr = started.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { server: started, baseUrl: `http://127.0.0.1:${port}` };
}

async function api(
  method: string,
  route: string,
  body?: unknown,
  root = baseUrl,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${root}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    throw new Error(`${method} ${route} returned non-JSON ${res.status}: ${text.slice(0, 400)}`);
  }
}

/** A fresh test file per test, so nothing keyed on the file carries from one
 *  test to the next. */
function newTestFile(root = projectRoot): string {
  fileCounter += 1;
  const file = path.join(root, 'tests', `odd-${fileCounter}.md`);
  writeFileSync(file, `# Odd ${fileCounter}\n\n## Steps\n1. Read the table\n`);
  return file;
}

beforeAll(async () => {
  projectRoot = mkdtempSync(path.join(tmpdir(), 'steptix-table-structure-'));
  mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
  writeFileSync(path.join(projectRoot, 'steptix.config.json'), JSON.stringify({}));

  // A second project whose steptix.config.json turns the question off for
  // everything under it — the `tables.structure` half of the switch.
  strictProjectRoot = mkdtempSync(path.join(tmpdir(), 'steptix-table-strict-'));
  mkdirSync(path.join(strictProjectRoot, 'tests'), { recursive: true });
  writeFileSync(
    path.join(strictProjectRoot, 'steptix.config.json'),
    JSON.stringify({ tables: { structure: 'strict' } }),
  );

  const { app } = createApiServer(testConfig());
  ({ server, baseUrl } = await listenOnRandomPort(app));
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(strictProjectRoot, { recursive: true, force: true });
});

beforeEach(() => {
  ai.plans = [];
  ai.structures = [];
  ai.planCalls = 0;
  ai.structureCalls = 0;
  ai.sent = [];
  extractor.reads = [];
  extractor.other = [];
  extractor.sources = [];
  extractor.handle = null;
  extractor.throwRaw = false;
  extractor.subtree =
    '<div id="account-cards"><div class="account-card"><h3 class="card-title">Everyday</h3></div></div>';
});

// ── Fixtures: the §5.9 shapes, as the extractor would report them ───────────

/** The `<td>`-headed payees table: one candidate, headings in body row 1. */
const TD_SKETCH = {
  region: { selector: '#legacy-payees', tag: 'table', id: 'legacy-payees', label: 'Payees' },
  candidates: [
    {
      id: 'T1',
      selector: '#legacy-payees',
      kind: 'table',
      label: 'Payees',
      headerRowCount: 0,
      dataRowCount: 3,
      rows: [
        { id: 'T1.r1', section: 'tbody', cells: 3, tags: ['td', 'td', 'td'], spans: [], rendered: true, text: ['Payee', 'Reference', 'Amount'] },
        { id: 'T1.r2', section: 'tbody', cells: 3, tags: ['td', 'td', 'td'], spans: [], rendered: true, text: ['Origin Energy', 'INV-2291', '$140.00'] },
        { id: 'T1.r3', section: 'tbody', cells: 3, tags: ['td', 'td', 'td'], spans: [], rendered: true, text: ['Telstra', 'TEL-88134', '$89.99'] },
      ],
    },
  ],
};

/** The card list: a region with nothing to summarise. */
const CARD_SKETCH = {
  region: { selector: '#account-cards', tag: 'div', id: 'account-cards' },
  candidates: [] as unknown[],
};

const TD_REFUSAL = 'readTable found no header row in the table matched by "#legacy-payees"';
const CARD_REFUSAL = 'readTable found no table with rows under "#account-cards"';

/** The mapping a `{"rows":"T1","header":{"table":"T1","row":1}}` answer makes. */
const TD_MAPPING = {
  kind: 'table',
  rows: '#legacy-payees',
  header: { selector: '#legacy-payees', bodyRow: 1 },
};

const PAYEE_RECORDS = [
  { _row: '1', payee: 'Origin Energy', amount: '$140.00' },
  { _row: '2', payee: 'Telstra', amount: '$89.99' },
];

function shapeRefusal(message: string, sketch: unknown): Error {
  const err = new Error(message) as Error & { sketch: unknown };
  err.sketch = sketch;
  return err;
}

/** The action plan a "read the payees table" step produces. */
function readTablePlan(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    actions: [
      {
        action: 'readTable',
        selector: '#legacy-payees',
        columns: [
          { header: 'Payee', key: 'payee' },
          { header: 'Amount', key: 'amount' },
        ],
        as: 'payees',
        description: 'Read the payees table',
        ...patch,
      },
    ],
    reasoning: 'read it',
    needs_reeval: false,
  });
}

const STEP = 'Read the Payee column as payee and the Amount column as amount from every row in the legacy payees table [store as: payees]';
/** The same region, the same columns, a LATER step — what `table-odd-shapes.md`
 *  step 10 does, and what asked the model a second time before the memo. */
const STEP_AGAIN = 'Read the Payee column as payee and the Amount column as amount from every row in the legacy payees table [store as: payees_again]';
/** The same region, DIFFERENT columns — a different structure to answer. */
const STEP_OTHER_COLUMNS = 'Read the Payee column as payee and the Reference column as reference from every row in the legacy payees table [store as: refs]';

/** One batch holding `STEP` alone — one run, so nothing is remembered from a
 *  previous call. */
async function run(
  sessionId: string,
  testFilePath: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: any }> {
  return api('POST', `/sessions/${sessionId}/steps`, {
    steps: [STEP],
    testFilePath,
    ...extra,
  });
}

/** Several steps in ONE batch — one run, and therefore one structure memo. */
async function runAll(
  sessionId: string,
  testFilePath: string,
  steps: string[],
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: any }> {
  return api('POST', `/sessions/${sessionId}/steps`, { steps, testFilePath, ...extra });
}

/** The action the server reports for step 1 — the RECORDED copy. */
function recordedAction(body: any): any {
  return body.results[0].actions[0];
}

describe('the structure question through the real Sessions API entry', () => {
  it('asks exactly once on a shape refusal and reads the §5.9 td-headed table', async () => {
    const info = vi.spyOn(logger, 'info');
    ai.plans = [readTablePlan()];
    ai.structures = [JSON.stringify({ kind: 'table', rows: 'T1', header: { table: 'T1', row: 1 } })];
    extractor.handle = (action) => {
      if (!action.mapping) throw shapeRefusal(TD_REFUSAL, TD_SKETCH);
      return PAYEE_RECORDS;
    };

    const res = await run('ts-table', newTestFile());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('passed');

    // ONE question, and one action plan. Not two of either.
    expect(ai.structureCalls).toBe(1);
    expect(ai.planCalls).toBe(1);

    // Two reads: the bare one that refused, then the mapped one that worked.
    expect(extractor.reads).toHaveLength(2);
    expect(extractor.reads[0]!.mapping).toBeUndefined();
    expect(extractor.reads[1]!.mapping).toEqual(TD_MAPPING);

    // The question carried the sketch, the refusal and the author's columns.
    const asked = ai.sent.find((t) => t.includes(STRUCTURE_MARKER))!;
    expect(asked).toContain('"T1.r1"');
    expect(asked).toContain('Origin Energy');
    expect(asked).toContain(TD_REFUSAL);
    expect(asked).toContain('"Payee" → "payee"');

    // And the log says a question was asked, which is what an author reading
    // a run log checks when a read suddenly costs a model call.
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('readTable: structure asked of the model'))).toBe(true);
    info.mockRestore();

    await api('DELETE', `/sessions/ts-table`);
  });

  it('puts the validated mapping on the RECORDED action, not on the model\'s own', async () => {
    ai.plans = [readTablePlan()];
    ai.structures = [JSON.stringify({ kind: 'table', rows: 'T1', header: { table: 'T1', row: 1 } })];
    extractor.handle = (action) => {
      if (!action.mapping) throw shapeRefusal(TD_REFUSAL, TD_SKETCH);
      return PAYEE_RECORDS;
    };

    const res = await run('ts-record', newTestFile());
    expect(res.body.status).toBe('passed');
    expect(recordedAction(res.body).mapping).toEqual(TD_MAPPING);
    // The rest of the action is the model's, unchanged.
    expect(recordedAction(res.body).selector).toBe('#legacy-payees');
    expect(recordedAction(res.body).as).toBe('payees');

    await api('DELETE', `/sessions/ts-record`);
  });

  it('reads a card list from a collection answer, showing the region markup', async () => {
    ai.plans = [readTablePlan({ selector: '#account-cards' })];
    ai.structures = [
      JSON.stringify({
        kind: 'collection',
        item: '.account-card',
        fields: { payee: '.card-title', amount: '.field-amount .value' },
      }),
    ];
    extractor.handle = (action) => {
      if (!action.mapping) throw shapeRefusal(CARD_REFUSAL, CARD_SKETCH);
      return PAYEE_RECORDS;
    };

    const res = await run('ts-collection', newTestFile());
    expect(res.body.status).toBe('passed');
    expect(ai.structureCalls).toBe(1);
    // Passed through as the model wrote it — a collection's selectors are the
    // answer itself, not ids to look up.
    expect(extractor.reads[1]!.mapping).toEqual({
      kind: 'collection',
      item: '.account-card',
      fields: { payee: '.card-title', amount: '.field-amount .value' },
    });
    // With no candidates there is nothing to summarise, so the question
    // carried the region's own markup instead.
    const asked = ai.sent.find((t) => t.includes(STRUCTURE_MARKER))!;
    // Inside the sketch JSON, as a string field: the markup's own quotes come
    // through escaped, which is what stops page text ending the data block
    // (§7.10, and tests/prompts-grid-structure.test.ts).
    expect(asked).toContain('"regionMarkup"');
    expect(asked).toContain('class=\\"account-card\\"');
    expect(asked).toContain('only answers available are "collection" and "none"');

    await api('DELETE', `/sessions/ts-collection`);
  });

  it('sends no region markup, rather than expand\'s error text, when the region cannot be expanded', async () => {
    // expandDomSubtree answers a failure IN BAND, as "[expand] …" text. Passed
    // on, that text stood in for the region's markup and the step spent its
    // one structure question on it (issue 062 review).
    extractor.subtree = '[expand] Error: SyntaxError: bad selector';
    ai.plans = [readTablePlan({ selector: '#account-cards' })];
    ai.structures = [
      JSON.stringify({
        kind: 'collection',
        item: '.account-card',
        fields: { payee: '.card-title', amount: '.field-amount .value' },
      }),
    ];
    extractor.handle = (action) => {
      if (!action.mapping) throw shapeRefusal(CARD_REFUSAL, CARD_SKETCH);
      return PAYEE_RECORDS;
    };

    await run('ts-expand-miss', newTestFile());
    const asked = ai.sent.find((t) => t.includes(STRUCTURE_MARKER))!;
    expect(asked).not.toContain('[expand]');
    expect(asked).toMatch(/\\?"regionMarkup\\?":\s*\\?"\\?"/);

    await api('DELETE', `/sessions/ts-expand-miss`);
  });

  it('fails with the original refusal and the reason when the model answers none', async () => {
    ai.plans = [readTablePlan({ selector: '#site-nav' })];
    ai.structures = [
      JSON.stringify({ kind: 'none', reason: 'the element is a navigation menu, not a list of records' }),
    ];
    extractor.handle = () => { throw shapeRefusal(CARD_REFUSAL, CARD_SKETCH); };

    const res = await run('ts-none', newTestFile());
    expect(res.body.results[0].status).toBe('failed');
    // The step's own message, not the JSON envelope: the refusal quotes a
    // selector, and a stringified body escapes those quotes.
    const message: string = res.body.error.message;
    expect(message).toContain(CARD_REFUSAL);
    expect(message).toContain('the element is a navigation menu, not a list of records');
    // One question, and no second read: `none` is an answer, not a retry.
    expect(ai.structureCalls).toBe(1);
    expect(extractor.reads).toHaveLength(1);

    await api('DELETE', `/sessions/ts-none`);
  });

  it('asks nothing under `## Config: tableStructure: strict`', async () => {
    ai.plans = [readTablePlan()];
    ai.structures = [JSON.stringify({ kind: 'table', rows: 'T1', header: { table: 'T1', row: 1 } })];
    extractor.handle = (action) => {
      if (!action.mapping) throw shapeRefusal(TD_REFUSAL, TD_SKETCH);
      return PAYEE_RECORDS;
    };

    const res = await run('ts-strict', newTestFile(), { config: { tableStructure: 'strict' } });
    expect(res.body.results[0].status).toBe('failed');
    expect(res.body.error.message).toContain(TD_REFUSAL);
    expect(ai.structureCalls).toBe(0);
    expect(extractor.reads).toHaveLength(1);

    await api('DELETE', `/sessions/ts-strict`);
  });

  it('asks nothing under a project whose steptix.config.json sets tables.structure: strict', async () => {
    // The per-PROJECT half. `runConfig` is spread from the SERVER's startup
    // config, which says `ask`, so this only passes if the value is
    // re-sourced from the bundle resolved at the test file's own root.
    ai.plans = [readTablePlan()];
    ai.structures = [JSON.stringify({ kind: 'table', rows: 'T1', header: { table: 'T1', row: 1 } })];
    extractor.handle = (action) => {
      if (!action.mapping) throw shapeRefusal(TD_REFUSAL, TD_SKETCH);
      return PAYEE_RECORDS;
    };

    const res = await run('ts-strict-project', newTestFile(strictProjectRoot));
    expect(res.body.results[0].status).toBe('failed');
    expect(ai.structureCalls).toBe(0);

    await api('DELETE', `/sessions/ts-strict-project`);
  });

  it('never asks about an author\'s own mistake', async () => {
    // A header typo is a refusal with no sketch on it, and §7.10 is explicit
    // that it stays the refusal it is. Asking here would spend a model call
    // to be told what the message already says, and — worse — could come back
    // with a mapping that reads some other column under the name.
    ai.plans = [readTablePlan({ columns: [{ header: 'Payes', key: 'payee' }] })];
    ai.structures = [JSON.stringify({ kind: 'table', rows: 'T1' })];
    extractor.handle = () => {
      throw new Error('readTable found no column headed "Payes" — available headers: Payee, Reference, Amount');
    };

    const res = await run('ts-typo', newTestFile());
    expect(res.body.results[0].status).toBe('failed');
    expect(res.body.error.message).toContain('available headers: Payee, Reference, Amount');
    expect(ai.structureCalls).toBe(0);
    expect(extractor.reads).toHaveLength(1);

    await api('DELETE', `/sessions/ts-typo`);
  });

  it('recognises a shape refusal that is THROWN rather than returned', async () => {
    // The orchestration decides "may I ask the model" by whether a sketch
    // came with the refusal, not by where it was carried. Everything else in
    // this file uses the carrier the real `executeAction` uses; this one
    // proves the other arm, so a change of mind in the extractor is a
    // failing test rather than a feature that silently stops asking.
    extractor.throwRaw = true;
    ai.plans = [readTablePlan()];
    ai.structures = [JSON.stringify({ kind: 'table', rows: 'T1', header: { table: 'T1', row: 1 } })];
    extractor.handle = (action) => {
      if (!action.mapping) throw shapeRefusal(TD_REFUSAL, TD_SKETCH);
      return PAYEE_RECORDS;
    };

    const res = await run('ts-thrown', newTestFile());
    expect(res.body.status).toBe('passed');
    expect(ai.structureCalls).toBe(1);
    expect(extractor.reads[1]!.mapping).toEqual(TD_MAPPING);

    await api('DELETE', `/sessions/ts-thrown`);
  });


  it('asks ONCE for a structure two steps in the same run read', async () => {
    // Before the memo, step 2 and step 10 reading the same table were two
    // questions. Measured on `table-odd-shapes.md`: four shapes, five reads,
    // five questions.
    const info = vi.spyOn(logger, 'info');
    ai.plans = [readTablePlan(), readTablePlan({ as: 'payees_again' })];
    ai.structures = [JSON.stringify({ kind: 'table', rows: 'T1', header: { table: 'T1', row: 1 } })];
    extractor.handle = (action) => {
      if (!action.mapping) throw shapeRefusal(TD_REFUSAL, TD_SKETCH);
      return PAYEE_RECORDS;
    };

    const res = await runAll('ts-memo', newTestFile(), [STEP, STEP_AGAIN]);
    expect(res.body.status).toBe('passed');
    expect(ai.planCalls).toBe(2);
    expect(ai.structureCalls).toBe(1);

    // Step 2 applied the remembered mapping — and said where it came from.
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain('readTable: structure reused from step 1');
    expect(lines.filter((l) => l.includes('structure asked of the model'))).toHaveLength(1);
    info.mockRestore();

    // …and the extractor was told which, for the §7.6 summary line: it cannot
    // tell a fresh answer from a remembered one (they are the same object by
    // then), so without the word a memo reuse would log "structure from the
    // model" and a reader counting model calls in the log would count wrong.
    // Step 2's unmapped first read is here too; the memo attempt succeeded.
    expect(extractor.sources).toEqual([undefined, 'model', undefined, 'memo']);

    // Reused, not assumed: it went through the extractor like any mapping, and
    // it is on step 2's recorded action, so what the run records for that step
    // is the mapping that actually read the table.
    expect(extractor.reads.at(-1)!.mapping).toEqual(TD_MAPPING);
    expect(res.body.results[1].actions[0].mapping).toEqual(TD_MAPPING);

    await api('DELETE', `/sessions/ts-memo`);
  });

  it('asks again for the same region read with DIFFERENT columns', async () => {
    // The memo key is the region AND the columns, because a mapping is only
    // valid for the request it was validated against: a collection's `fields`
    // has one selector per requested key, so reusing an answer across a
    // different column set would read a column nothing chose a selector for.
    ai.plans = [
      readTablePlan(),
      readTablePlan({
        as: 'refs',
        columns: [{ header: 'Payee', key: 'payee' }, { header: 'Reference', key: 'reference' }],
      }),
    ];
    ai.structures = [JSON.stringify({ kind: 'table', rows: 'T1', header: { table: 'T1', row: 1 } })];
    extractor.handle = (action) => {
      if (!action.mapping) throw shapeRefusal(TD_REFUSAL, TD_SKETCH);
      return PAYEE_RECORDS;
    };

    const res = await runAll('ts-memo-columns', newTestFile(), [STEP, STEP_OTHER_COLUMNS]);
    expect(res.body.status).toBe('passed');
    expect(ai.structureCalls).toBe(2);

    await api('DELETE', `/sessions/ts-memo-columns`);
  });

  it('asks again when a remembered structure no longer validates', async () => {
    const LATER_MAPPING = {
      kind: 'table',
      rows: '#legacy-payees',
      header: { selector: '#legacy-payees', bodyRow: 2 },
    };
    ai.plans = [readTablePlan(), readTablePlan({ as: 'payees_again' })];
    ai.structures = [
      JSON.stringify({ kind: 'table', rows: 'T1', header: { table: 'T1', row: 1 } }),
      JSON.stringify({ kind: 'table', rows: 'T1', header: { table: 'T1', row: 2 } }),
    ];
    // The page moves on between the two steps: what step 1 was told stops
    // fitting, so the memo's entry has to be tried, refused and replaced.
    let moved = false;
    extractor.handle = (action) => {
      const key = JSON.stringify(action.mapping ?? null);
      if (!moved) {
        if (key === JSON.stringify(TD_MAPPING)) { moved = true; return PAYEE_RECORDS; }
        throw shapeRefusal(TD_REFUSAL, TD_SKETCH);
      }
      if (key === JSON.stringify(LATER_MAPPING)) return PAYEE_RECORDS;
      throw shapeRefusal(TD_REFUSAL, TD_SKETCH);
    };

    const res = await runAll('ts-memo-stale', newTestFile(), [STEP, STEP_AGAIN]);
    expect(res.body.status).toBe('passed');
    // Two questions, not one and not three: the stale entry bought a free
    // attempt, and the answer replaced it.
    expect(ai.structureCalls).toBe(2);
    expect(res.body.results[1].actions[0].mapping).toEqual(LATER_MAPPING);

    await api('DELETE', `/sessions/ts-memo-stale`);
  });

  it('fails with BOTH answers when a remembered structure and the new answer both miss', async () => {
    // A second failure names both attempts: the mapping an earlier step of
    // this run was told, which has stopped fitting, and what the model said
    // when it was asked again. Either one alone describes a page the reader
    // is no longer looking at.
    ai.plans = [readTablePlan(), readTablePlan({ as: 'payees_again' })];
    ai.structures = [
      JSON.stringify({ kind: 'table', rows: 'T1', header: { table: 'T1', row: 1 } }),
      JSON.stringify({ kind: 'table', rows: 'T1', header: { table: 'T1', row: 2 } }),
    ];
    // Step 1 reads with the model's first answer; after that the page has
    // moved past anything either answer describes.
    let moved = false;
    extractor.handle = (action) => {
      if (!moved && JSON.stringify(action.mapping ?? null) === JSON.stringify(TD_MAPPING)) {
        moved = true;
        return PAYEE_RECORDS;
      }
      throw shapeRefusal(TD_REFUSAL, TD_SKETCH);
    };

    const res = await runAll('ts-both', newTestFile(), [STEP, STEP_AGAIN]);
    expect(res.body.results[0].status).toBe('passed');
    expect(res.body.results[1].status).toBe('failed');
    const message: string = res.body.error.message;
    // The remembered mapping that stopped fitting...
    expect(message).toContain('The remembered structure mapping was rows in #legacy-payees');
    // ...and the answer that did not fit either.
    expect(message).toContain('"row":2');
    // Exactly one further question, not a loop.
    expect(ai.structureCalls).toBe(2);
    // Step 2 tried the memo before it asked, and asked once.
    expect(extractor.sources).toEqual([undefined, 'model', undefined, 'memo', 'model']);

    await api('DELETE', `/sessions/ts-both`);
  });

  it('strips a mapping the model emitted before the read ever sees it', async () => {
    // The parser drops it, so the read below runs UNMAPPED and refuses — which
    // is the observable difference between "stripped" and "trusted". A mapping
    // that was copied through would have made the first read succeed with a
    // structure nothing had validated.
    ai.plans = [
      readTablePlan({
        mapping: { kind: 'table', rows: '#invented', header: { selector: '#invented' } },
      }),
    ];
    ai.structures = [JSON.stringify({ kind: 'table', rows: 'T1', header: { table: 'T1', row: 1 } })];
    extractor.handle = (action) => {
      if (!action.mapping) throw shapeRefusal(TD_REFUSAL, TD_SKETCH);
      return PAYEE_RECORDS;
    };

    const res = await run('ts-stripped', newTestFile());
    expect(res.body.status).toBe('passed');
    expect(extractor.reads[0]!.mapping).toBeUndefined();
    // And what the read finally used is the runtime's, not the model's.
    expect(extractor.reads[1]!.mapping).toEqual(TD_MAPPING);
    expect(recordedAction(res.body).mapping).toEqual(TD_MAPPING);

    await api('DELETE', `/sessions/ts-stripped`);
  });
});

// ── §7.6: nothing the run calls a secret may reach the question ─────────────

describe('the structure question and the run\'s secrets', () => {
  it('masks a secret in the region markup before it reaches the model', async () => {
    // The sketch's own cell text is masked in the page, where it is built.
    // This is the OTHER half of the question's payload: a region with no
    // candidates carries the cleaned markup instead, `expandDomSubtree`
    // knows nothing about the run's secrets, and the markup reached the
    // model, the recorded AiInteraction and the report verbatim.
    extractor.subtree =
      '<div id="account-cards"><div class="account-card">'
      + '<span class="label">Account</span><span class="value">hunter2-SECRET</span>'
      + '</div></div>';
    ai.plans = [readTablePlan({ selector: '#account-cards-hunter2-SECRET' })];
    ai.structures = [JSON.stringify({ kind: 'none', reason: 'not a list of records' })];
    extractor.handle = () => { throw shapeRefusal(CARD_REFUSAL, CARD_SKETCH); };

    const res = await run('ts-secret', newTestFile(), {
      parameters: { password: 'hunter2-SECRET' },
    });
    expect(res.body.status).toBe('failed');

    const asked = ai.sent.find((t) => t.includes(STRUCTURE_MARKER))!;
    expect(asked).not.toContain('hunter2-SECRET');
    expect(asked).toContain('***');
    // And the `Selector:` line with it — a selector is page-derived as often
    // as a cell is, and it is printed as itself rather than inside the
    // sketch JSON.
    expect(asked).toContain('Selector: #account-cards-***');

    await api('DELETE', `/sessions/ts-secret`);
  });
});

// ── §7.10: translating "row N of T1" into a mapping ─────────────────────────
//
// The sketch's `section` word is the whole of this arithmetic. These sketches
// are shaped exactly as the extractor builds them (see
// tests/read-table-structure.test.ts for the same shapes against a real page).

/** An ARIA grid whose header row names nothing and whose FIRST DATA ROW holds
 *  the headings — the probe's shape, and the one that used to read `Alice`
 *  and `$1` as the column names. */
const ARIA_SKETCH = {
  region: { selector: '#fees', tag: 'div', id: 'fees', label: 'Fees' },
  candidates: [
    {
      id: 'T1',
      selector: '#fees',
      kind: 'grid',
      label: 'Fees',
      headerRowCount: 1,
      dataRowCount: 3,
      rows: [
        { id: 'T1.r1', section: 'header', cells: 2, tags: 'columnheader×2', spans: '', rendered: true, text: ['', ''] },
        { id: 'T1.r2', section: 'row', cells: 2, tags: 'gridcell×2', spans: '', rendered: true, text: ['Payee', 'Amount'] },
        { id: 'T1.r3', section: 'row', cells: 2, tags: 'gridcell×2', spans: '', rendered: true, text: ['Origin Energy', '$140.00'] },
        { id: 'T1.r4', section: 'row', cells: 2, tags: 'gridcell×2', spans: '', rendered: true, text: ['Telstra', '$89.99'] },
      ],
    },
  ],
};

/** A table with a `<tfoot>` of totals under the rows. */
const TFOOT_SKETCH = {
  region: { selector: '#legacy-payees', tag: 'table', id: 'legacy-payees', label: 'Payees' },
  candidates: [
    {
      id: 'T1',
      selector: '#legacy-payees',
      kind: 'table',
      label: 'Payees',
      headerRowCount: 0,
      dataRowCount: 3,
      rows: [
        { id: 'T1.r1', section: 'tbody', cells: 2, tags: 'td×2', spans: '', rendered: true, text: ['Payee', 'Amount'] },
        { id: 'T1.r2', section: 'tbody', cells: 2, tags: 'td×2', spans: '', rendered: true, text: ['Origin Energy', '$140.00'] },
        { id: 'T1.r3', section: 'tbody', cells: 2, tags: 'td×2', spans: '', rendered: true, text: ['Telstra', '$89.99'] },
        { id: 'T1.r4', section: 'tfoot', cells: 2, tags: 'td×2', spans: '', rendered: true, text: ['Total', '$229.99'] },
      ],
    },
  ],
};

/** Two candidates: a header-only table and the rows beside it (§5.9.2). */
const PAIRED_SKETCH = {
  region: { selector: '#payees-rows', tag: 'table', id: 'payees-rows', label: 'Payees' },
  candidates: [
    {
      id: 'T1',
      selector: '#payees-head',
      kind: 'table',
      label: '',
      headerRowCount: 1,
      dataRowCount: 0,
      rows: [
        { id: 'T1.r1', section: 'thead', cells: 2, tags: 'th×2', spans: '', rendered: true, text: ['Payee', 'Amount'] },
      ],
    },
    {
      id: 'T2',
      selector: '#payees-rows',
      kind: 'table',
      label: 'Payees',
      headerRowCount: 0,
      dataRowCount: 2,
      rows: [
        { id: 'T2.r1', section: 'tbody', cells: 2, tags: 'td×2', spans: '', rendered: true, text: ['Origin Energy', '$140.00'] },
        { id: 'T2.r2', section: 'tbody', cells: 2, tags: 'td×2', spans: '', rendered: true, text: ['Telstra', '$89.99'] },
      ],
    },
  ],
};

describe('turning a structure answer into a mapping (§7.10)', () => {
  /** Run one question with a scripted sketch and answer, and hand back what
   *  reached the page and what the step said. */
  async function ask(
    sessionId: string,
    sketch: unknown,
    answer: unknown,
    selector = '#legacy-payees',
  ) {
    ai.plans = [readTablePlan({ selector })];
    ai.structures = [JSON.stringify(answer)];
    extractor.handle = (action) => {
      if (!action.mapping) throw shapeRefusal(TD_REFUSAL, sketch);
      return PAYEE_RECORDS;
    };
    const res = await run(sessionId, newTestFile());
    await api('DELETE', `/sessions/${sessionId}`);
    return res;
  }

  it('counts an ARIA "row 2" among the DATA rows, skipping the header row', async () => {
    // The grid's blank `columnheader` row is a HEADER row, so it is not in the
    // body list at all: "row 2" is body row 1. Counted as a body row — which
    // is what every ARIA row said before the sketch told them apart — this
    // answered `bodyRow: 2` and read the first real record as the headings.
    const res = await ask(
      'ts-aria-row', ARIA_SKETCH,
      { kind: 'table', rows: 'T1', header: { table: 'T1', row: 2 } }, '#fees',
    );
    expect(res.body.status).toBe('passed');
    expect(extractor.reads[1]!.mapping).toEqual({
      kind: 'table',
      rows: '#fees',
      header: { selector: '#fees', bodyRow: 1 },
    });
  });

  it('refuses a <tfoot> row as the header, and reads nothing with it', async () => {
    // A footer is excluded from the body (§7.4), so its number is not in the
    // body list — counting it landed on the LAST DATA ROW, which the read
    // then spliced out as if it were the header. A wrong header is visible in
    // the records; a table one row short is not.
    const res = await ask(
      'ts-tfoot', TFOOT_SKETCH,
      { kind: 'table', rows: 'T1', header: { table: 'T1', row: 4 } },
    );
    expect(res.body.status).toBe('failed');
    expect(res.body.error.message as string).toContain('a footer row cannot be the header');
    // ONE read: the unmapped one that refused. Nothing was read with a
    // mapping built from the footer.
    expect(extractor.reads).toHaveLength(1);
  });

  it('accepts a "header" with no "row" when that candidate has a header of its own', async () => {
    // §5.9.2: the names are in the OTHER table's `<thead>`, so there is no row
    // number to give. The answer is legal without one and the mapping carries
    // no `bodyRow` — the extractor finds the header grid of the element it is
    // handed.
    const res = await ask(
      'ts-no-row', PAIRED_SKETCH,
      { kind: 'table', rows: 'T2', header: { table: 'T1' } }, '#payees-rows',
    );
    expect(res.body.status).toBe('passed');
    expect(extractor.reads[1]!.mapping).toEqual({
      kind: 'table',
      rows: '#payees-rows',
      header: { selector: '#payees-head' },
    });
  });

  it('refuses a "header" with no "row" when that candidate has no header row', async () => {
    const res = await ask(
      'ts-no-row-none', TD_SKETCH,
      { kind: 'table', rows: 'T1', header: { table: 'T1' } },
    );
    expect(res.body.status).toBe('failed');
    expect(res.body.error.message as string).toContain(
      '"header.row" is missing and T1 has no header row of its own',
    );
    expect(extractor.reads).toHaveLength(1);
  });

  it('refuses a candidate id the sketch does not list', async () => {
    // The model naming a table that is not there is the one answer that can
    // never be validated against the page, because there is no selector to
    // resolve: `candidates.find` returns undefined and a selector built from
    // it would reach Playwright as `undefined`.
    const res = await ask(
      'ts-t9', TD_SKETCH, { kind: 'table', rows: 'T9' },
    );
    expect(res.body.status).toBe('failed');
    expect(res.body.error.message as string).toContain(
      '"rows": "T9" is not one of the candidates in the sketch (T1)',
    );
    expect(extractor.reads).toHaveLength(1);
  });

  it('refuses a header.row past the end of the candidate', async () => {
    const res = await ask(
      'ts-past-end', TD_SKETCH,
      { kind: 'table', rows: 'T1', header: { table: 'T1', row: 9 } },
    );
    expect(res.body.status).toBe('failed');
    expect(res.body.error.message as string).toContain(
      '"header.row": 9 is past the end of T1, which has 3 rows in the sketch',
    );
    expect(extractor.reads).toHaveLength(1);
  });
});

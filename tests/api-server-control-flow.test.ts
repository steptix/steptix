/**
 * Control flow over HTTP (stories/control-flow.md §Runtime).
 *
 * **Every test here POSTs through the real `node:http` entry**, for the reason
 * `api-server-sections.test.ts` states: `api-server.ts` builds its
 * `StepRequest` from a per-field allow-list, so a field added to the TYPE
 * compiles cleanly and is dropped at runtime. Nothing new travels for this
 * feature — a control line is `kind: 'step'` on the wire and the server derives
 * the guards from its own expansion — which is exactly the claim this seam
 * checks.
 *
 * The browser, the model and the report writer are mocked; the expander, the
 * planner, the bounded-run slicing and the event stream run for real.
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

/** Instruction text of every step the runner actually executed. */
const executedSteps: string[] = [];
/** `[instruction, cacheEnabled]` at the seam where the cache is consulted. */
const cacheFlags: [string, boolean][] = [];
/** The `## Prior Steps` lines each executed step was handed. */
const historyPerStep: string[][] = [];
/** Verdicts the judge will hand back, in order. `null` is "none held". */
let judgeScript: Array<number | null> = [];
/** Conditions the judge was asked about, per call. */
const judgeCalls: string[][] = [];
/** What `executeBranchedStep` hands back — a watch group's rows, when a test
 *  wants one. Rows carry the group's own **0-based** step indices. */
let branchedRows: (group: any) => StepResult[] = () => [];
/** Set when a test wants the judge to park until the run is aborted. */
let judgeParksUntilAbort = false;
/** Resolves when the judge has been entered — the abort test's cue. */
let judgeEntered: (() => void) | undefined;

vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: vi.fn(async (
    _stepIndex: number,
    _totalSteps: number,
    instruction: string,
    opts?: { cacheEnabled?: boolean; conversationHistory?: string[] },
  ): Promise<StepResult> => {
    executedSteps.push(instruction);
    cacheFlags.push([instruction, opts?.cacheEnabled === true]);
    historyPerStep.push([...(opts?.conversationHistory ?? [])]);
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
  executeBranchedStep: vi.fn(async (group: unknown) => branchedRows(group)),
  evaluateConditions: vi.fn(async (conditions: string[], opts: { signal?: AbortSignal }) => {
    judgeCalls.push([...conditions]);
    if (judgeParksUntilAbort) {
      judgeEntered?.();
      await new Promise<void>((_resolve, reject) => {
        opts.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Run aborted by client', 'AbortError')),
          { once: true },
        );
      });
    }
    const selected = judgeScript.length > 0 ? judgeScript.shift()! : null;
    return {
      selected,
      reasoning: selected === null ? 'nothing held' : `condition ${selected} held`,
      aiInteractions: [],
    };
  }),
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

/** The report each run produced, so the loop markers can be asserted. */
const generatedReports: any[] = [];
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

const API_KEY = 'sk-control-flow-test';
const cfg: Config = {
  ai: { gatewayUrl: 'https://ai.test', model: 't', maxInputTokens: 1000, streamResponses: false, sendScreenshots: false },
  browser: { headed: false, viewport: { width: 1280, height: 720 }, windowSize: { width: 1280, height: 720 }, slowMo: 0, browser: 'chromium', fullPageScreenshots: true },
  tests: { dir: './tests', contextDir: './context', pattern: '**/*.md' },
  execution: { timeout: 30000, retries: 1, screenshotOnFailure: true, promptOnAmbiguity: false, maxTurns: 5, maxLoopIterations: 25 },
  reports: { outputDir: './reports', includeScreenshots: false, includeDomSnapshots: false, includeAiReasoning: false, embedScreenshots: false },
  api: { specsDir: './specs', requestTimeout: 30000, redactSensitive: true },
  server: { host: '127.0.0.1', port: 0, apiKey: API_KEY },
  cache: { enabled: false, dir: '.cache' },
  logging: { consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
};

let server: Server;
let baseUrl: string;
let tmpDir: string;
let testFilePath: string;

beforeAll(async () => {
  const { app } = createApiServer(cfg);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) baseUrl = `http://127.0.0.1:${addr.port}`;

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'control-flow-http-'));
  testFilePath = path.join(tmpDir, 'payments.md');
  await fs.writeFile(testFilePath, '# placeholder — the server never reads this\n');
});

afterAll(async () => {
  await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  executedSteps.length = 0;
  cacheFlags.length = 0;
  historyPerStep.length = 0;
  judgeCalls.length = 0;
  generatedReports.length = 0;
  judgeScript = [];
  branchedRows = () => [];
  judgeParksUntilAbort = false;
  judgeEntered = undefined;
});

// ── Helpers ──────────────────────────────────────────────────────────

let sessionSeq = 0;
const nextSession = (): string => `cf-${++sessionSeq}`;

async function* sseEvents(body: unknown, signal?: AbortSignal, sessionId = nextSession()) {
  const res = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    ...(signal && { signal }),
  });
  if (!res.body) throw new Error('no response body');
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
        yield JSON.parse(dataLine.slice(6)) as { type: string; [k: string]: any };
      } catch {
        /* keep-alives */
      }
    }
  }
}

/** The plain (non-SSE) POST, for the `results` array clients read off the
 *  response rather than off the stream. */
async function post(body: unknown, sessionId = nextSession()): Promise<any> {
  const res = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function collect(body: unknown): Promise<Array<{ type: string; [k: string]: any }>> {
  const out: Array<{ type: string; [k: string]: any }> = [];
  for await (const ev of sseEvents(body)) {
    out.push(ev);
    if (ev.type === 'done') break;
  }
  return out;
}

/**
 * A three-way chain sent the way a client sends one.
 *
 *     3. Open the payments page
 *     4. If the Cash checkbox is ticked, then Pay with cash
 *     5. Otherwise, Pay by card
 *     6. Verify the order confirmation is shown
 *     ### Pay with cash   (heading 8)
 *     9.  Click Pay now
 *     10. Verify the receipt says Paid in cash
 *     ### Pay by card     (heading 12)
 *     13. Enter the card details
 *     14. Submit the card form
 */
const chainBody = (extra: Record<string, unknown> = {}) => ({
  steps: [
    'Open the payments page',
    'If the Cash checkbox is ticked, then Pay with cash',
    'Otherwise, Pay by card',
    'Verify the order confirmation is shown',
  ],
  sourceLines: [3, 4, 5, 6],
  testFilePath,
  sections: {
    'pay with cash': {
      name: 'Pay with cash',
      headingLine: 8,
      steps: ['Click Pay now', 'Verify the receipt says Paid in cash'],
      stepLines: [9, 10],
    },
    'pay by card': {
      name: 'Pay by card',
      headingLine: 12,
      steps: ['Enter the card details', 'Submit the card form'],
      stepLines: [13, 14],
    },
  },
  ...extra,
});

/**
 * A `While` whose tail is a section, so each pass has a frame to clone.
 *
 *     3. Open the statements page
 *     4. While the Next button is enabled, Go to the next page
 *     5. Verify the last page is shown
 *     ### Go to the next page   (heading 7)
 *     8. Click Next
 */
const whileBody = (extra: Record<string, unknown> = {}) => ({
  steps: [
    'Open the statements page',
    'While the Next button is enabled, Go to the next page',
    'Verify the last page is shown',
  ],
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
  ...extra,
});

// ── Chains ───────────────────────────────────────────────────────────

describe('a chain reaches the server as ordinary steps and decides there', () => {
  it('runs the taken tail and reports the other as skipped, on its own lines', async () => {
    judgeScript = [0];
    const events = await collect(chainBody());

    expect(executedSteps).toEqual([
      'Open the payments page',
      'Click Pay now',
      'Verify the receipt says Paid in cash',
      'Verify the order confirmation is shown',
    ]);
    // The judge was asked once, about the chain's one real condition — the
    // `Otherwise` carries none.
    expect(judgeCalls).toEqual([['the Cash checkbox is ticked']]);

    // The untaken half is `step:pass` with output 'skipped', on the untaken
    // guard's line and its body's lines.
    const skipped = events
      .filter((e) => e.type === 'step:pass' && e.output === 'skipped')
      .map((e) => e.line);
    expect(skipped).toEqual([5, 13, 14]);

    // …and the guard that WAS taken passed on its own line.
    const passedLines = events
      .filter((e) => e.type === 'step:pass' && e.output !== 'skipped')
      .map((e) => e.line);
    expect(passedLines).toEqual([3, 4, 9, 10, 6]);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
  });

  it('takes the Otherwise and skips the If, in file order', async () => {
    judgeScript = [null];
    const events = await collect(chainBody());

    expect(executedSteps).toEqual([
      'Open the payments page',
      'Enter the card details',
      'Submit the card form',
      'Verify the order confirmation is shown',
    ]);
    const skipped = events
      .filter((e) => e.type === 'step:pass' && e.output === 'skipped')
      .map((e) => e.line);
    expect(skipped).toEqual([4, 9, 10]);
  });

  it('records the skipped rows in the report with a skipped status', async () => {
    judgeScript = [0];
    await collect(chainBody());
    const steps: StepResult[] = generatedReports.at(-1)!.steps;
    expect(steps.map((s) => [s.instruction, s.status])).toEqual([
      ['Open the payments page', 'passed'],
      ['If the Cash checkbox is ticked, then Pay with cash', 'passed'],
      ['Click Pay now', 'passed'],
      ['Verify the receipt says Paid in cash', 'passed'],
      ['Otherwise, Pay by card', 'skipped'],
      ['Enter the card details', 'skipped'],
      ['Submit the card form', 'skipped'],
      ['Verify the order confirmation is shown', 'passed'],
    ]);
    // The untaken tail's rows keep their section badge.
    expect(steps[5]!.sourceSection).toBe('Pay by card');
  });

  it('fails the guard, and the run, when the judge could not decide', async () => {
    const { evaluateConditions } = await import('../src/runner/step-executor.js');
    vi.mocked(evaluateConditions).mockRejectedValueOnce(
      new Error('could not decide: the page did not settle within 30s while judging "x"'),
    );
    const events = await collect(chainBody());

    const failure = events.find((e) => e.type === 'step:fail');
    expect(failure).toMatchObject({ line: 4 });
    expect(failure!.error).toContain('could not decide: the page did not settle');
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'failed' });
  });
});

/**
 * The same chain with an `Else if` between the two, so the member that HOLDS
 * is not the one the judge was asked from.
 *
 *     3. Open the payments page
 *     4. If the Cash checkbox is ticked, then Pay with cash
 *     5. Else if the Card checkbox is ticked, then Pay by card
 *     6. Otherwise, Verify the Pay now button is disabled
 *     7. Verify the order confirmation is shown
 */
const elseIfBody = (extra: Record<string, unknown> = {}) => ({
  steps: [
    'Open the payments page',
    'If the Cash checkbox is ticked, then Pay with cash',
    'Else if the Card checkbox is ticked, then Pay by card',
    'Otherwise, Verify the Pay now button is disabled',
    'Verify the order confirmation is shown',
  ],
  sourceLines: [3, 4, 5, 6, 7],
  testFilePath,
  sections: {
    'pay with cash': {
      name: 'Pay with cash',
      headingLine: 9,
      steps: ['Click Pay now'],
      stepLines: [10],
    },
    'pay by card': {
      name: 'Pay by card',
      headingLine: 12,
      steps: ['Enter the card details'],
      stepLines: [13],
    },
  },
  ...extra,
});

/**
 * An outer `While` whose section body ends in an inner `While`, so a pass of
 * the inner loop runs inside a pass of the outer one.
 *
 *     3. Open
 *     4. While outer holds, Outer body
 *     5. Done
 *     ### Outer body   (heading 7)
 *     8.  Click Refresh
 *     9.  While inner holds, Inner body
 *     ### Inner body   (heading 11)
 *     12. Click Dismiss
 */
const nestedBody = (extra: Record<string, unknown> = {}) => ({
  steps: ['Open', 'While outer holds, Outer body', 'Done'],
  sourceLines: [3, 4, 5],
  testFilePath,
  sections: {
    'outer body': {
      name: 'Outer body',
      headingLine: 7,
      steps: ['Click Refresh', 'While inner holds, Inner body'],
      stepLines: [8, 9],
    },
    'inner body': {
      name: 'Inner body',
      headingLine: 11,
      steps: ['Click Dismiss'],
      stepLines: [12],
    },
  },
  ...extra,
});

describe('what the chain tells later steps', () => {
  it('the history says the Else if held, not the If the judge was asked from', async () => {
    // Index 1 of the request's condition list is the `Else if`.
    judgeScript = [1];
    await collect(elseIfBody());

    expect(executedSteps).toEqual([
      'Open the payments page',
      'Enter the card details',
      'Verify the order confirmation is shown',
    ]);
    const history = historyPerStep.at(-1)!;
    expect(history).toContain(
      'If the Cash checkbox is ticked, then Pay with cash → did not hold',
    );
    expect(history).toContain(
      'Else if the Card checkbox is ticked, then Pay by card → held',
    );
    expect(history.join('\n')).not.toContain(
      'If the Cash checkbox is ticked, then Pay with cash → held',
    );
  });
});

// ── Loops ────────────────────────────────────────────────────────────

describe('a loop clones its tail frames per pass', () => {
  it('pushes a fresh frame with iteration and no iterationCount mid-loop', async () => {
    judgeScript = [0, 0, 0, null];
    const events = await collect(whileBody());

    const pushes = events.filter((e) => e.type === 'frame:push').map((e) => e.frame);
    expect(pushes).toHaveLength(3);
    expect(pushes.map((f) => f.iteration)).toEqual([1, 2, 3]);
    // Unknown while the loop runs — the story's `(3/?)`.
    for (const frame of pushes) expect(frame.iterationCount).toBeUndefined();
    // Fresh ids, so a client that keys on frame id sees three separate frames.
    expect(new Set(pushes.map((f) => f.id)).size).toBe(3);
    // …all naming the same section, at the same file and line.
    for (const frame of pushes) {
      expect(frame.skillName).toBe('Go to the next page');
      expect(frame.kind).toBe('section');
    }
    // One pop per pass: the guard's own frame is the test root.
    expect(events.filter((e) => e.type === 'frame:pop')).toHaveLength(3);
  });

  it('back-fills the count on every marker once the loop ends', async () => {
    judgeScript = [0, 0, 0, null];
    await collect(whileBody());

    const steps: StepResult[] = generatedReports.at(-1)!.steps;
    const body = steps.filter((s) => s.instruction === 'Click Next');
    expect(body).toHaveLength(3);
    expect(body.map((s) => s.loop)).toEqual([
      { kind: 'iteration', label: 'Go to the next page', index: 1, count: 3, values: {} },
      { kind: 'iteration', label: 'Go to the next page', index: 2, count: 3, values: {} },
      { kind: 'iteration', label: 'Go to the next page', index: 3, count: 3, values: {} },
    ]);
    // One guard row per evaluation — four, the last being the one that ended it.
    const guards = steps.filter((s) => s.instruction.startsWith('While '));
    expect(guards).toHaveLength(4);
    expect(guards.every((s) => s.status === 'passed')).toBe(true);
  });

  it('turns the step cache off inside the loop body', async () => {
    judgeScript = [0, null];
    await collect(whileBody({ cacheEnabled: true }));
    const flags = new Map(cacheFlags);
    expect(flags.get('Click Next')).toBe(false);
  });

  it('gives a nested loop its OWN frame per pass, stamped with its iteration', async () => {
    // outer holds; inner holds, holds, stops; outer stops.
    judgeScript = [0, 0, 0, null, null];
    const events = await collect(nestedBody());

    expect(executedSteps).toEqual(['Open', 'Click Refresh', 'Click Dismiss', 'Click Dismiss', 'Done']);

    const pushes = events.filter((e) => e.type === 'frame:push').map((e) => e.frame);
    // One for the outer pass, one per inner pass.
    expect(pushes.map((f) => f.skillName)).toEqual(['Outer body', 'Inner body', 'Inner body']);
    // The two inner passes are DIFFERENT frames — they used to share the one
    // the outer pass had cloned, because the walk asked "is there an alias
    // anywhere on the stack" instead of "has THIS pass cloned it".
    const inner = pushes.filter((f) => f.skillName === 'Inner body');
    expect(new Set(inner.map((f) => f.id)).size).toBe(2);
    // …and each carries its own iteration, with no count while it runs.
    expect(inner.map((f) => f.iteration)).toEqual([1, 2]);
    for (const frame of inner) expect(frame.iterationCount).toBeUndefined();
    // Every push is matched by a pop.
    expect(events.filter((e) => e.type === 'frame:pop')).toHaveLength(pushes.length);
  });

  it('fails the loop at its cap, naming the cap and its source', async () => {
    judgeScript = [0, 0, 0, 0, 0, 0];
    const events = await collect(
      whileBody({
        steps: [
          'Open the statements page',
          'While the Next button is enabled, Go to the next page, up to 2 times',
          'Verify the last page is shown',
        ],
      }),
    );

    const failure = events.find((e) => e.type === 'step:fail');
    expect(failure!.error).toContain('cap of 2 passes');
    expect(failure!.error).toContain("this line's `, up to N times`");
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'failed' });
  });
});

describe('For each', () => {
  const forEachBody = (parameters: Record<string, string>) => ({
    steps: [
      'Open the accounts page',
      'For each {{account}} in {{accounts}}, Check the account',
      'Sign out',
    ],
    sourceLines: [3, 4, 5],
    testFilePath,
    parameters,
    sections: {
      'check the account': {
        name: 'Check the account',
        headingLine: 7,
        steps: ['Click the account row'],
        stepLines: [8],
      },
    },
  });

  it('binds the item into scope for the pass, and knows its count from the start', async () => {
    const events = await collect(forEachBody({ accounts: '["Everyday","Savings"]' }));

    expect(executedSteps).toEqual([
      'Open the accounts page',
      'Click the account row',
      'Click the account row',
      'Sign out',
    ]);
    // No model call decided anything — the list is the bound.
    expect(judgeCalls).toHaveLength(0);

    const pushes = events.filter((e) => e.type === 'frame:push').map((e) => e.frame);
    expect(pushes.map((f) => [f.iteration, f.iterationCount])).toEqual([[1, 2], [2, 2]]);

    // The bound item reaches the Variables view through the frame's scope…
    const scopes = events.filter((e) => e.type === 'frame:scope').map((e) => e.scope);
    expect(scopes.some((s) => s.account === 'Everyday')).toBe(true);
    expect(scopes.some((s) => s.account === 'Savings')).toBe(true);
    // …and the marker carries it for the report's band.
    const steps: StepResult[] = generatedReports.at(-1)!.steps;
    const body = steps.filter((s) => s.instruction === 'Click the account row');
    expect(body.map((s) => s.loop!.values)).toEqual([
      { account: 'Everyday' },
      { account: 'Savings' },
    ]);
  });

  it('fails the line when the variable is not a JSON array', async () => {
    const events = await collect(forEachBody({ accounts: 'Savings, Everyday' }));
    const failure = events.find((e) => e.type === 'step:fail');
    expect(failure).toMatchObject({ line: 4 });
    expect(failure!.error).toContain('`{{accounts}}` holds `Savings, Everyday`, not a list');
    expect(executedSteps).toEqual(['Open the accounts page']);
  });
});

// ── The guard's own events pair ──────────────────────────────────────

/**
 * Every `step:start` a guard's line opens is closed by a `step:pass` or a
 * `step:fail` on that same line — the paint rule TestBench relies on.
 *
 * `ActiveFileTracker` paints `running` on `step:start` and clears it only on
 * the next event for that line, so an unpaired start is a line left painted
 * `running` for the rest of the run. The live run found exactly that: the
 * `For each` guard opened four times and closed once, and the line was still
 * spinning after `done` (stories/control-flow.md §"What the live run found").
 */
describe("a guard's opening and closing events pair", () => {
  const forGuardLine = (
    events: Array<{ type: string; [k: string]: any }>,
    line: number,
  ) => {
    const own = events.filter((e) => e.line === line && e.type.startsWith('step:'));
    return {
      starts: own.filter((e) => e.type === 'step:start').length,
      closes: own.filter((e) => e.type === 'step:pass' || e.type === 'step:fail').length,
      lastIsClose: own.at(-1)?.type !== 'step:start',
      types: own.map((e) => e.type),
    };
  };

  /**
   * A `Repeat` whose tail is a SECTION, so the guard's line 4 is the guard's
   * alone. A plain-instruction tail shares the guard's source line, which
   * still balances (the tail opens and closes its own pair there) but stops
   * the count from saying anything about the guard by itself.
   *
   *     3. Open the alerts page
   *     4. Repeat Load more alerts until every alert is shown
   *     5. Verify the alert count
   *     ### Load more alerts   (heading 7)
   *     8. Click Load more
   */
  const repeatBody = (extra: Record<string, unknown> = {}) => ({
    steps: [
      'Open the alerts page',
      'Repeat Load more alerts until every alert is shown',
      'Verify the alert count',
    ],
    sourceLines: [3, 4, 5],
    testFilePath,
    sections: {
      'load more alerts': {
        name: 'Load more alerts',
        headingLine: 7,
        steps: ['Click Load more'],
        stepLines: [8],
      },
    },
    ...extra,
  });

  const forEachBody = (accounts: string) => ({
    steps: [
      'Open the accounts page',
      'For each {{account}} in {{accounts}}, Check the account',
      'Sign out',
    ],
    sourceLines: [3, 4, 5],
    testFilePath,
    parameters: { accounts },
    sections: {
      'check the account': {
        name: 'Check the account',
        headingLine: 7,
        steps: ['Click the account row'],
        stepLines: [8],
      },
    },
  });

  it('opens the For each guard once for three items, and closes it', async () => {
    const events = await collect(forEachBody('["Everyday","Savings","Travel"]'));

    // Four visits: the one that read the list, two that advanced the cursor,
    // and the one that found it exhausted. Only the first asks anybody.
    expect(executedSteps).toEqual([
      'Open the accounts page',
      'Click the account row',
      'Click the account row',
      'Click the account row',
      'Sign out',
    ]);
    expect(judgeCalls).toHaveLength(0);

    const guard = forGuardLine(events, 4);
    expect(guard.types).toEqual(['step:start', 'step:pass']);
    expect(guard.starts).toBe(guard.closes);
    expect(guard.lastIsClose).toBe(true);
    // The report is unchanged by the fix: one row, from the one visit that
    // read the list.
    const steps: StepResult[] = generatedReports.at(-1)!.steps;
    expect(steps.filter((s) => s.instruction.startsWith('For each '))).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
  });

  it("opens the Repeat guard for its asking visits only, not its first pass", async () => {
    // `null` = the until-condition did not hold, so the loop carries on; `0` =
    // it held, so the loop ends. Two passes, two evaluations.
    judgeScript = [null, 0];
    const events = await collect(repeatBody());

    expect(executedSteps).toEqual([
      'Open the alerts page',
      'Click Load more',
      'Click Load more',
      'Verify the alert count',
    ]);

    const guard = forGuardLine(events, 4);
    // Three visits, two of which asked: the first pass of a `Repeat` runs its
    // body before there is anything to decide, and records nothing.
    expect(guard.types).toEqual(['step:start', 'step:pass', 'step:start', 'step:pass']);
    expect(guard.starts).toBe(guard.closes);
    expect(guard.lastIsClose).toBe(true);
    const steps: StepResult[] = generatedReports.at(-1)!.steps;
    expect(steps.filter((s) => s.instruction.startsWith('Repeat '))).toHaveLength(2);
  });

  it('still opens a While guard on every visit, because every visit asks', async () => {
    // The control: the rule is "no start without a close", not "fewer starts".
    // A `While` evaluates every time, so all four visits open AND close.
    judgeScript = [0, 0, 0, null];
    const events = await collect(whileBody());

    const guard = forGuardLine(events, 4);
    expect(guard.starts).toBe(4);
    expect(guard.closes).toBe(4);
    expect(guard.lastIsClose).toBe(true);
  });

  it('closes the chain head that a lower member won, and the member that won', async () => {
    // The other shape a guard's line can take: the judge is asked from the
    // `If`, the `Else if` holds. The head's start is closed by the skip flush,
    // the winner's line carries the pass.
    judgeScript = [1];
    const events = await collect(elseIfBody());

    const head = forGuardLine(events, 4);
    expect(head.starts).toBe(1);
    expect(head.closes).toBe(1);
    expect(head.lastIsClose).toBe(true);
    expect(events.filter((e) => e.line === 5 && e.type === 'step:pass')).toHaveLength(1);
  });
});

// ── Watch groups beside control flow ─────────────────────────────────

describe('a watch group after a chain', () => {
  it('releases the untaken half before the group speaks', async () => {
    // 3. Open · 4. If … · 5. Otherwise … · 6. watch · 7. Click Continue ·
    // 8. Sign out — with the chain's tails expanded in place, the watch group
    // covers the `If a cookie banner…` line and its continuation.
    judgeScript = [0];
    branchedRows = (group) => [
      {
        index: group.conditionalSteps[0].index,
        instruction: 'If a cookie banner appears, click Reject all',
        status: 'skipped',
        turns: [],
        durationMs: 1,
        retried: false,
      },
      {
        index: group.continuationStep.index,
        instruction: 'Click Continue',
        status: 'passed',
        turns: [],
        durationMs: 1,
        retried: false,
      },
    ];
    const body = await post(
      chainBody({
        steps: [
          'Open the page',
          'If the Cash checkbox is ticked, then Pay with cash',
          'Otherwise, Pay by card',
          'If a cookie banner appears, click Reject all',
          'Click Continue',
          'Sign out',
        ],
        sourceLines: [3, 4, 5, 6, 7, 8],
      }),
    );

    // The MCP-facing array is the one surface the branched path writes to, so
    // it is where the ordering shows: the untaken `Otherwise` and its body sit
    // above the group's rows, not below the whole run.
    expect(body.results.map((r: { step: string }) => r.step)).toEqual([
      'Open the page',
      'If the Cash checkbox is ticked, then Pay with cash',
      'Click Pay now',
      'Verify the receipt says Paid in cash',
      'Otherwise, Pay by card',
      'Enter the card details',
      'Submit the card form',
      'If a cookie banner appears, click Reject all',
      'Click Continue',
      'Sign out',
    ]);
  });
});

// ── Bounded runs ─────────────────────────────────────────────────────

describe('a run that starts or ends mid-structure', () => {
  it('startAt inside a tail treats that guard as taken and skips the siblings', async () => {
    const events = await collect(
      chainBody({ startAt: { uri: testFilePath, line: 9 }, fullSteps: undefined }),
    );

    // No decision was asked for — the author clicked a line inside `Pay with
    // cash`, which IS the decision (stories/control-flow.md §"Runs that start
    // or end mid-structure").
    expect(judgeCalls).toHaveLength(0);
    expect(executedSteps).toEqual([
      'Click Pay now',
      'Verify the receipt says Paid in cash',
      'Verify the order confirmation is shown',
    ]);
    const skipped = events
      .filter((e) => e.type === 'step:pass' && e.output === 'skipped')
      .map((e) => e.line);
    expect(skipped).toEqual([5, 13, 14]);
  });

  it('endAt on a guard line runs the decision AND what it selects', async () => {
    judgeScript = [0];
    const events = await collect(chainBody({ endAt: { uri: testFilePath, line: 4 } }));

    // A guard evaluated with its body sliced away would be a decision with no
    // consequence, so the whole tail runs — and nothing after the chain does:
    // `Verify the order confirmation is shown` is past the end bound.
    expect(executedSteps).toEqual([
      'Open the payments page',
      'Click Pay now',
      'Verify the receipt says Paid in cash',
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
  });
});

// ── Compile ──────────────────────────────────────────────────────────

describe('compiling a file with control flow', () => {
  /** The refusal's own text, or undefined when the compile was allowed. */
  const refusalIn = (events: Array<{ type: string; [k: string]: any }>): string | undefined =>
    events.find((e) => e.type === 'output' && e.kind === 'error')?.msg as string | undefined;

  it('refuses a whole-file compile of a file that loops, before anything runs', async () => {
    const events = await collect(whileBody({ compile: 'run' }));

    const message = refusalIn(events)!;
    expect(message).toContain('While the Next button is enabled, Go to the next page');
    expect(message).toContain('a number of times the page decides');
    // The advice names things the author can actually do. The first version
    // said "compile the section the loop runs, on its own" while refusing on
    // the whole FILE, so that compile was refused by the same check.
    expect(message).toContain('Compile This Step on a step OUTSIDE the loop');
    expect(message).toContain('the body of the section the loop runs');
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'error' });
    expect(executedSteps).toEqual([]);
  });

  it('lets a bounded compile of a step OUTSIDE every loop proceed', async () => {
    // Line 3 is `Open the statements page`; the only loop is on line 4.
    judgeScript = [null];
    const events = await collect(
      whileBody({
        compile: 'steps',
        startAt: { uri: testFilePath, line: 3 },
        endAt: { uri: testFilePath, line: 3 },
      }),
    );

    expect(refusalIn(events)).toBeUndefined();
    expect(executedSteps).toEqual(['Open the statements page']);
  });

  it('refuses a bounded compile that lands ON the loop guard', async () => {
    const events = await collect(
      whileBody({
        compile: 'steps',
        startAt: { uri: testFilePath, line: 4 },
        endAt: { uri: testFilePath, line: 4 },
      }),
    );

    expect(refusalIn(events)).toContain('a number of times the page decides');
    expect(executedSteps).toEqual([]);
  });

  it('lets a compile of the looped SECTION proceed — it arrives detached', async () => {
    // TestBench runs a selection made entirely of section-body lines detached,
    // at the root frame, so the guard is not in the batch at all: the section
    // runs once and one entry per line is exactly right. This is the compile
    // the refusal's advice names, so it has to work.
    const events = await collect({
      steps: ['Click Next'],
      sourceLines: [8],
      testFilePath,
      compile: 'steps',
      compileScope: { section: 'Go to the next page' },
    });

    expect(refusalIn(events)).toBeUndefined();
    expect(executedSteps).toEqual(['Click Next']);
  });

  it('refuses a bounded compile that lands INSIDE the loop body', async () => {
    // Line 8 is `Click Next`, the section body the `While` runs — reached as a
    // body step of the loop, so the same slot problem applies.
    const events = await collect(
      whileBody({
        compile: 'steps',
        startAt: { uri: testFilePath, line: 8 },
        endAt: { uri: testFilePath, line: 8 },
      }),
    );

    expect(refusalIn(events)).toContain('a number of times the page decides');
    expect(executedSteps).toEqual([]);
  });

  it('lets a chain compile, with the guards out of scope', async () => {
    judgeScript = [0];
    const events = await collect(chainBody({ compile: 'run' }));
    // The run itself is untouched by the compile riding it.
    expect(executedSteps).toEqual([
      'Open the payments page',
      'Click Pay now',
      'Verify the receipt says Paid in cash',
      'Verify the order confirmation is shown',
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(events.some((e) => e.type === 'output' && e.kind === 'error')).toBe(false);
  });
});

// ── Aborts ───────────────────────────────────────────────────────────

describe('stopping the run mid-decision', () => {
  it('ends as aborted rather than as a server error', async () => {
    judgeParksUntilAbort = true;
    const controller = new AbortController();
    const entered = new Promise<void>((resolve) => {
      judgeEntered = resolve;
    });

    let clientAborted = false;
    const consume = (async () => {
      try {
        for await (const _ev of sseEvents(chainBody(), controller.signal)) {
          /* drain */
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') clientAborted = true;
        else throw err;
      }
    })();

    await entered;
    controller.abort();
    await consume;
    expect(clientAborted).toBe(true);

    // The report is written on the way out, and says the run was stopped —
    // the guard's AbortError did not escape as "Server error" (issues/020).
    await vi.waitFor(() => expect(generatedReports.length).toBeGreaterThan(0));
    expect(generatedReports.at(-1)!.aborted).toBe(true);
    // The tail never ran.
    expect(executedSteps).not.toContain('Click Pay now');
  });
});

// ── Breakpoints inside a loop body ───────────────────────────────────

/** Resume a paused run, the way the client's Continue does. */
async function runControl(sessionId: string, mode: string): Promise<number> {
  const res = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/run-control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ mode }),
  });
  return res.status;
}

/**
 * "A breakpoint on a body line fires on every pass" — stories/control-flow.md
 * §"Painting, frames and the report".
 *
 * `consumedBreakpoints` is keyed by flat step index, and a loop body re-runs
 * the SAME index on every pass under a new frame id. Declared per run and
 * never cleared, it disarmed the author's breakpoint after pass 1: measured
 * live at three passes, one `step:awaiting`, two passes running straight
 * through with nothing said (scratchpad/liverun-2.md §2).
 */
describe('a breakpoint on a loop body line', () => {
  it('pauses on every pass, not just the first', async () => {
    judgeScript = [0, 0, 0];
    const sessionId = nextSession();
    const events: Array<{ type: string; [k: string]: any }> = [];
    let awaiting = 0;

    for await (const ev of sseEvents(
      // Line 8 is `Click Next`, the section body of the `While` — a section
      // frame, so the client's own `trimAtBreakpoint` cannot see it and the
      // server is the only thing that can honour it.
      whileBody({ breakpointsByUri: { [testFilePath]: [8] } }),
      undefined,
      sessionId,
    )) {
      events.push(ev);
      if (ev.type === 'step:awaiting') {
        awaiting++;
        // A runaway would otherwise hang the suite rather than fail it.
        if (awaiting > 6) throw new Error('the server kept pausing on one line');
        expect(await runControl(sessionId, 'continue')).toBe(200);
      }
      if (ev.type === 'done') break;
    }

    expect(awaiting).toBe(3);
    // ...and the run really did make three passes, so the count above is
    // "once per pass" rather than "three pauses in one pass".
    expect(executedSteps.filter((s) => s === 'Click Next')).toHaveLength(3);

    // The resume never double-triggers: between two pauses on the same line
    // there is always the `step:start` that ran it. Without that, "three
    // pauses" could be the old bug's opposite.
    const shape = events
      .filter(
        (e) =>
          (e.type === 'step:awaiting' || e.type === 'step:start') && e.line === 8,
      )
      .map((e) => e.type);
    expect(shape).toEqual([
      'step:awaiting', 'step:start',
      'step:awaiting', 'step:start',
      'step:awaiting', 'step:start',
    ]);
  });

  it('re-arms the guard too, so the decision itself can be stopped at each pass', async () => {
    // The inner `While` of the nested fixture: a guard line that lives in a
    // SECTION body, which is the only kind the server honours — a main-flow
    // guard is the client's to trim, and `clientAlreadyTrimmed` says so.
    //
    // outer holds once; inner holds, holds, stops.
    judgeScript = [0, 0, 0, null, null];
    const sessionId = nextSession();
    let awaiting = 0;
    const lines: number[] = [];

    for await (const ev of sseEvents(
      nestedBody({ breakpointsByUri: { [testFilePath]: [9] } }),
      undefined,
      sessionId,
    )) {
      if (ev.type === 'step:awaiting') {
        awaiting++;
        lines.push(ev.line as number);
        if (awaiting > 8) throw new Error('the server kept pausing on one line');
        expect(await runControl(sessionId, 'continue')).toBe(200);
      }
      if (ev.type === 'done') break;
    }

    // Three visits that evaluate — the two that start a pass and the one that
    // ends the loop — and a pause before each decision. Without re-arming the
    // guard's own index there was exactly one.
    expect(lines).toEqual([9, 9, 9]);
    expect(executedSteps).toEqual(['Open', 'Click Refresh', 'Click Dismiss', 'Click Dismiss', 'Done']);
  });

  it('still pauses exactly once on a line the run passes once', async () => {
    // The reason `consumedBreakpoints` exists, unchanged: only a loop's own
    // range is re-armed, and only where a pass is starting.
    judgeScript = [0];
    const sessionId = nextSession();
    let awaiting = 0;

    for await (const ev of sseEvents(
      chainBody({ breakpointsByUri: { [testFilePath]: [9] } }),
      undefined,
      sessionId,
    )) {
      if (ev.type === 'step:awaiting') {
        awaiting++;
        if (awaiting > 4) throw new Error('the server kept pausing on one line');
        expect(await runControl(sessionId, 'continue')).toBe(200);
      }
      if (ev.type === 'done') break;
    }

    expect(awaiting).toBe(1);
  });
});

// ── Where the two features meet ──────────────────────────────────────

/**
 * `If … then return` (stories/step-flow-control.md) inside a structure this
 * story built (stories/control-flow.md §"Composition with `If … then
 * return`").
 *
 * The two features answer the same question — "which later steps does this
 * step leave behind" — from opposite ends, and each is right about its own
 * half. `frameExitIndex` knows about FRAMES and nothing about control records,
 * so from inside a loop body it hands back the last index of the TEST;
 * `returnExit` clamps that to the innermost control body and says whether the
 * planner gets the last word on where to resume. Both halves are checked here
 * rather than in a unit test of the helper, because what the helper returns
 * only matters through the run loop that consumes it.
 *
 * The server path specifically, because it is the only one with per-pass frame
 * CLONES: `origins[i].frameId` is always an original id and the clones live in
 * the wire `FrameInfo` table, so the frame walk never meets one. That is a
 * claim, and a loop that runs twice is what tests it.
 */
describe('a return inside a loop body ends the PASS, not the run', () => {
  /**
   * A `While` whose section body returns on its first step.
   *
   *     3. Open the statements page
   *     4. While the Next button is enabled, Go to the next page
   *     5. Verify the last page is shown
   *     ### Go to the next page   (heading 7)
   *     8. Return
   *     9. Click Next
   */
  const returnInLoopBody = (extra: Record<string, unknown> = {}) => ({
    steps: [
      'Open the statements page',
      'While the Next button is enabled, Go to the next page',
      'Verify the last page is shown',
    ],
    sourceLines: [3, 4, 5],
    testFilePath,
    sections: {
      'go to the next page': {
        name: 'Go to the next page',
        headingLine: 7,
        steps: ['Return', 'Click Next'],
        stepLines: [8, 9],
      },
    },
    ...extra,
  });

  it('re-evaluates the guard after the return, and stops when it says no', async () => {
    // Holds, holds, then does not. Each pass runs the body's first step (the
    // unconditional `Return`, which needs no model at all) and returns, which
    // must end THAT PASS and send the run back to the guard — not end the run
    // and not skip to step 5.
    judgeScript = [0, 0, null];
    const events = await collect(returnInLoopBody());

    // Two passes' worth of decisions plus the one that ended the loop.
    expect(judgeCalls).toEqual([
      ['the Next button is enabled'],
      ['the Next button is enabled'],
      ['the Next button is enabled'],
    ]);
    // `Return` is dispatched, so the only steps a model saw are the ones
    // outside the loop. `Click Next` never ran: the return skipped it, twice.
    expect(executedSteps).toEqual(['Open the statements page', 'Verify the last page is shown']);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
  });

  it('skips only the rest of the BODY, never the step after the loop', async () => {
    judgeScript = [0, null];
    const events = await collect(returnInLoopBody());
    const skipped = events.filter((e) => e.type === 'step:skip').map((e) => e.line);
    // Line 9 is the body's second step. Line 5 — `Verify the last page is
    // shown` — is outside the loop and must never appear here: it is the step
    // the run continues at, and an unclamped `frameExitIndex` would have
    // reported it skipped and ended the run.
    expect(skipped).toEqual([9]);
    expect(executedSteps).toContain('Verify the last page is shown');
  });

  it('the returning pass still gets its own frame, so two passes are two frames', async () => {
    judgeScript = [0, 0, null];
    const events = await collect(returnInLoopBody());
    const pushed = events
      .filter((e) => e.type === 'frame:push')
      .map((e) => e.frame?.id as string);
    // One frame per pass, and they are DIFFERENT — the per-pass clones. If the
    // return had ended the run there would be one; if the clone table and the
    // frame walk disagreed there would be one id twice.
    expect(pushed.length).toBe(2);
    expect(new Set(pushed).size).toBe(2);
  });

  it('a bare Return in the MAIN flow still ends the whole run', async () => {
    // The other side of the clamp. Nothing encloses this step, so the planner
    // is not consulted — and it must not be, or a test whose last expanded
    // step closes a loop body would jump back into the loop it just skipped.
    judgeScript = [];
    const events = await collect({
      steps: ['Open the statements page', 'Return', 'Verify the last page is shown'],
      sourceLines: [3, 4, 5],
      testFilePath,
    });
    expect(executedSteps).toEqual(['Open the statements page']);
    const skipped = events.filter((e) => e.type === 'step:skip').map((e) => e.line);
    expect(skipped).toEqual([5]);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
  });
});

describe('a return inside a chain tail ends the tail, not the chain', () => {
  /**
   * The `chainBody` shape, with the taken tail returning on its first step.
   *
   *     ### Pay with cash   (heading 8)
   *     9.  Return
   *     10. Verify the receipt says Paid in cash
   */
  const returnInChainTail = () => ({
    ...chainBody(),
    sections: {
      'pay with cash': {
        name: 'Pay with cash',
        headingLine: 8,
        steps: ['Return', 'Verify the receipt says Paid in cash'],
        stepLines: [9, 10],
      },
      'pay by card': {
        name: 'Pay by card',
        headingLine: 12,
        steps: ['Enter the card details', 'Submit the card form'],
        stepLines: [13, 14],
      },
    },
  });

  it('continues after the chain, with the siblings still skipped exactly once', async () => {
    judgeScript = [0];
    const events = await collect(returnInChainTail());

    expect(executedSteps).toEqual([
      'Open the payments page',
      'Verify the order confirmation is shown',
    ]);

    // The return's own skips: the rest of the taken tail, and nothing else.
    const returnSkipped = events.filter((e) => e.type === 'step:skip').map((e) => e.line);
    expect(returnSkipped).toEqual([10]);

    // The chain's own skips: the untaken `Otherwise` and its body. Reported
    // by the DECISION, on the older convention, and reported once — a return
    // whose range was not clamped would have re-reported all three.
    const chainSkipped = events
      .filter((e) => e.type === 'step:pass' && e.output === 'skipped')
      .map((e) => e.line);
    expect(chainSkipped).toEqual([5, 13, 14]);

    // No line is announced skipped twice, whichever event carried it.
    const all = [...returnSkipped, ...chainSkipped];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('a main-flow return walks past a guard without evaluating it', () => {
  it('the skipped guard costs no model call and its tail never runs', async () => {
    // The third interaction the composition has to get right: a `return` whose
    // skipped range covers one of this story's guards. The guard is reported
    // skipped like any other line — and crucially never VISITED, so the judge
    // is not asked a question about a decision the run has already walked past.
    const events = await collect({
      steps: [
        'Open the payments page',
        'Return',
        'If the Cash checkbox is ticked, then Pay with cash',
        'Verify the order confirmation is shown',
      ],
      sourceLines: [3, 4, 5, 6],
      testFilePath,
      sections: {
        'pay with cash': {
          name: 'Pay with cash',
          headingLine: 8,
          steps: ['Click Pay now'],
          stepLines: [9],
        },
      },
    });

    expect(judgeCalls).toEqual([]);
    expect(executedSteps).toEqual(['Open the payments page']);
    const skipped = events.filter((e) => e.type === 'step:skip').map((e) => e.line);
    // The guard's line, its tail's line, and the step after the chain.
    expect(skipped).toEqual([5, 9, 6]);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
  });
});

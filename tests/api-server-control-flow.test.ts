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

/** Instruction text of every step the runner actually executed. */
const executedSteps: string[] = [];
/** The `## Prior Steps` lines each executed step was handed. */
const historyPerStep: string[][] = [];
/** Verdicts the judge will hand back, in order. `null` is "none held". */
let judgeScript: Array<number | null> = [];
/** Conditions the judge was asked about, per call. */
const judgeCalls: string[][] = [];
/** What `executeBranchedStep` hands back — a watch group's rows, when a test
 *  wants one. Rows carry the group's own **0-based** step indices. */
let branchedRows: (group: any) => StepResult[] = () => [];
/**
 * Which executed step, if any, answers with `flowControl` — a CONDITIONAL
 * `… then return`, which the model decides rather than the parser. Called once
 * per `executeStep`, so a test can return on the Nth visit to the same line.
 */
let flowControlFor: (instruction: string) => StepResult['flowControl'] = () => undefined;
/** Set when a test wants the judge to park until the run is aborted. */
let judgeParksUntilAbort = false;
/** Resolves when the judge has been entered — the abort test's cue. */
let judgeEntered: (() => void) | undefined;

vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: vi.fn(async (
    _stepIndex: number,
    _totalSteps: number,
    instruction: string,
    opts?: { conversationHistory?: string[] },
  ): Promise<StepResult> => {
    executedSteps.push(instruction);
    historyPerStep.push([...(opts?.conversationHistory ?? [])]);
    const flowControl = flowControlFor(instruction);
    return {
      index: 1,
      instruction,
      status: 'passed',
      turns: [],
      durationMs: 5,
      retried: false,
      aiExplanation: 'ok',
      ...(flowControl && { flowControl }),
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
      // The page the judge decided on — what a compiling run keeps on the
      // guard row and generates a `condition` entry from
      // (stories/codebehind-loops-and-conditions.md, decision 9). Numbered per
      // call, so a prompt can be traced to the visit it came from.
      evidence: {
        dom: `<html><body><button id="next">Next</button><!-- judge call ${judgeCalls.length} --></body></html>`,
        url: 'https://example.com/statements',
      },
    };
  }),
}));

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: vi.fn(async () => ({ files: [], combined: '' })),
}));
/** Every generation / review prompt the compile riding a run asked. */
const compilePrompts: string[] = [];
vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    chat = vi.fn(async () => '{}');
    setAiPolicy = vi.fn();
    syncAuth = vi.fn(() => null);
    /** The compile's model: a review echoes the file, a condition prompt gets
     *  a read-only `condition`, anything else a `run`. */
    complete = vi.fn(async (messages: Array<{ role: string; content: string }>) => {
      const last = messages[messages.length - 1]?.content ?? '';
      compilePrompts.push(last);
      if (/Review a generated Playwright code-behind file/.test(last)) {
        const fenced = /## The file, as generated\s*```ts\n([\s\S]*?)```/.exec(last);
        return { text: JSON.stringify({ file: fenced?.[1] ?? 'export default defineSteps([]);\n' }) };
      }
      const quoted = /\n\s*source:\s*("(?:[^"\\]|\\.)*")/.exec(last);
      const source = quoted?.[1] ? (JSON.parse(quoted[1]) as string) : 'step';
      const entry = /async condition\(\{ page, step \}\)/.test(last)
        ? `{ source: ${JSON.stringify(source)}, async condition({ page }) { return (await page.locator('#next').count()) > 0; } }`
        : `{ source: ${JSON.stringify(source)}, async run({ page }) { await page.click('#go'); } }`;
      return { text: JSON.stringify({ entry }) };
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
// The mocked logger above, imported so a test can read what the run said.
import { logger } from '../src/utils/logger.js';

/** Every `logger.warn` line this run produced. */
const warnings = (): string[] =>
  (logger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));

const API_KEY = 'sk-control-flow-test';
const cfg: Config = {
  ai: { gatewayUrl: 'https://ai.test', model: 't', maxInputTokens: 1000, streamResponses: false, sendScreenshots: false },
  browser: { headed: false, viewport: { width: 1280, height: 720 }, windowSize: { width: 1280, height: 720 }, slowMo: 0, browser: 'chromium', fullPageScreenshots: true },
  tests: { dir: './tests', contextDir: './context', pattern: '**/*.md' },
  execution: { timeout: 30000, retries: 1, screenshotOnFailure: true, promptOnAmbiguity: false, maxTurns: 5, maxLoopIterations: 25 },
  reports: { outputDir: './reports', includeScreenshots: false, includeDomSnapshots: false, includeAiReasoning: false, embedScreenshots: false },
  api: { specsDir: './specs', requestTimeout: 30000, redactSensitive: true },
  server: { host: '127.0.0.1', port: 0, apiKey: API_KEY },
  logging: { consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
};

let server: Server;
let baseUrl: string;
let tmpDir: string;
let testFilePath: string;
let toolsDir: string;

beforeAll(async () => {
  const { app } = createApiServer(cfg);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) baseUrl = `http://127.0.0.1:${addr.port}`;

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'control-flow-http-'));
  testFilePath = path.join(tmpDir, 'payments.md');
  await fs.writeFile(testFilePath, '# placeholder — the server never reads this\n');

  // A tool whose output lands on a loop's item name. The server dispatches
  // `[tool: …]` itself (session-manager, not the mocked step executor), so
  // this is a REAL write into the live variable map over HTTP.
  toolsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'control-flow-tools-'));
  await fs.writeFile(
    path.join(toolsDir, 'note-order.ts'),
    `
import { defineTool } from '${path.resolve(__dirname, '..', 'src', 'tools', 'index.ts').replace(/\\/g, '/')}';

export default defineTool({
  name: 'note-order',
  description: 'Store an order reference under {{order}}',
  parameters: { value: { type: 'string' } },
  outputs: { order: { type: 'string' } },
  async run(args, ctx) {
    ctx.step.setVar('order', args.value);
  },
});
`,
  );
});

afterAll(async () => {
  await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(toolsDir, { recursive: true, force: true });
});

beforeEach(() => {
  executedSteps.length = 0;
  historyPerStep.length = 0;
  judgeCalls.length = 0;
  generatedReports.length = 0;
  compilePrompts.length = 0;
  judgeScript = [];
  branchedRows = () => [];
  flowControlFor = () => undefined;
  judgeParksUntilAbort = false;
  judgeEntered = undefined;
  (logger.warn as unknown as { mockClear: () => void }).mockClear();
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
 * A chain with NO `Otherwise` — `If X, then Y` and nothing else, which is the
 * commonest conditional anyone writes and the one shape whose GUARD row is
 * recorded skipped when the condition does not hold (`guardRows`,
 * src/runner/control-runtime.ts: "a chain where nothing held and there is no
 * `Otherwise` has no passed member at all").
 *
 *     3. Open the payments page
 *     4. If the Cash checkbox is ticked, then Pay with cash
 *     5. Verify the order confirmation is shown
 *     ### Pay with cash   (heading 7)
 *     8. Click Pay now
 *     9. Verify the receipt says Paid in cash
 */
const noOtherwiseBody = (extra: Record<string, unknown> = {}) => ({
  steps: [
    'Open the payments page',
    'If the Cash checkbox is ticked, then Pay with cash',
    'Verify the order confirmation is shown',
  ],
  sourceLines: [3, 4, 5],
  testFilePath,
  sections: {
    'pay with cash': {
      name: 'Pay with cash',
      headingLine: 7,
      steps: ['Click Pay now', 'Verify the receipt says Paid in cash'],
      stepLines: [8, 9],
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

/**
 * A list of OBJECTS, over the same wire
 * (docs/specs/SPEC-structured-table-reads.md §8, §12 item 19).
 *
 * `readTable` is what produces such a list in a real run, and it is seeded
 * here as a `parameters` entry instead — not because it is missing, but
 * because the planner's contract is with the JSON in the variable map and not
 * with the action that wrote it. A tool returning an array, a `readTable` and
 * a pre-populated parameter are the same input. The server's job here is to carry the dotted keys the
 * planner produced all the way to the step text and the `frame:scope` payload
 * without knowing anything about them, which is §1.1's last bullet: one
 * binding shape, applied generically by every run loop.
 */
describe('For each over object rows', () => {
  const ORDERS =
    '[{"_row":"1","id":"A","status":"x"},{"_row":"2","id":"B","status":"y"}]';

  const ordersBody = (orders: string = ORDERS) => ({
    steps: [
      'Open the orders page',
      'For each {{order}} in {{orders}}, Check the order',
      'Sign out',
    ],
    sourceLines: [3, 4, 5],
    testFilePath,
    parameters: { orders },
    sections: {
      'check the order': {
        name: 'Check the order',
        headingLine: 7,
        steps: ['Verify the row for "{{order.id}}" shows "{{order.status}}"'],
        stepLines: [8],
      },
    },
  });

  it('substitutes the row properties into the body step the model is handed', async () => {
    await collect(ordersBody());

    // One pass per object, each body instruction carrying THAT row's values —
    // not the JSON text, and not a literal `{{order.id}}`.
    expect(executedSteps).toEqual([
      'Open the orders page',
      'Verify the row for "A" shows "x"',
      'Verify the row for "B" shows "y"',
      'Sign out',
    ]);
    expect(judgeCalls).toHaveLength(0);
  });

  it('carries the dotted bindings in frame:scope and in the loop marker', async () => {
    const events = await collect(ordersBody());

    const scopes = events.filter((e) => e.type === 'frame:scope').map((e) => e.scope);
    // The base binding keeps its old meaning — the row's compact JSON — and
    // every direct property is beside it, `_row` included (§8.2).
    expect(
      scopes.some(
        (s) =>
          s['order'] === '{"_row":"1","id":"A","status":"x"}' &&
          s['order._row'] === '1' &&
          s['order.id'] === 'A' &&
          s['order.status'] === 'x',
      ),
    ).toBe(true);
    expect(
      scopes.some((s) => s['order.id'] === 'B' && s['order.status'] === 'y'),
    ).toBe(true);

    // …and the report's band shows the same thing, which is what the
    // Variables panel renders for the pass (§8.4).
    const steps: StepResult[] = generatedReports.at(-1)!.steps;
    const body = steps.filter((s) => s.instruction.startsWith('Verify the row for'));
    expect(body.map((s) => s.loop!.values)).toEqual([
      {
        order: '{"_row":"1","id":"A","status":"x"}',
        'order._row': '1',
        'order.id': 'A',
        'order.status': 'x',
      },
      {
        order: '{"_row":"2","id":"B","status":"y"}',
        'order._row': '2',
        'order.id': 'B',
        'order.status': 'y',
      },
    ]);
  });

  /**
   * WHOSE those dotted names are, said on the wire
   * (docs/specs/SPEC-structured-table-reads.md §7.6, §8.4).
   *
   * The scope alone cannot answer it. `order.id` (a page's column, bound by
   * this pass) and `user.apikey` (a data file's own heading, typed by the
   * author) are the same shape to a reader, and the server tells them apart
   * with a registry keyed on the live map's object identity — which a copy
   * sent over HTTP arrives without. So Steptix read every dotted entry as a
   * binding, took the narrow record rule to it, and printed `uk_live_1234` in
   * the Variables view beside a report that starred it.
   *
   * `bindings` is that registry as data. Present on every `frame:scope`,
   * EMPTY LIST INCLUDED: absent has to keep meaning "an older server said
   * nothing", or a real loop's `row.keyword` would be masked on a server that
   * never claimed it was the author's word.
   */
  it('says on frame:scope which dotted names the pass bound — and unsays them', async () => {
    const events = await collect({
      ...ordersBody(),
      steps: [
        'Open the orders page',
        'For each {{order}} in {{orders}}, Check the order',
        // §8.2: the last pass's bindings survive the loop. This is what takes
        // them back out — `bindVariable` clears the root's dotted keys and
        // `unmarkLoopBindings` drops the marks with them, so a later entry of
        // the same name is nobody's binding.
        'Set {{order}} to "none"',
        'Sign out',
      ],
      sourceLines: [3, 4, 5, 6],
      // A dotted name the author typed, in the same map the whole time. It is
      // never a binding, so it must never appear in the list — this is the
      // entry the client was getting wrong.
      parameters: { orders: ORDERS, 'user.apikey': 'uk_live_1234' },
    });

    const scopes = events.filter((e) => e.type === 'frame:scope');
    expect(scopes.length).toBeGreaterThan(0);
    // Every one carries the field, so a client can tell "nothing bound" from
    // "nothing said".
    for (const s of scopes) expect(Array.isArray(s.bindings)).toBe(true);

    // Before the loop: the scope already holds `user.apikey`, and nothing is
    // a binding.
    expect(scopes[0]!.scope['user.apikey']).toBe('uk_live_1234');
    expect(scopes[0]!.bindings).toEqual([]);

    // Inside a pass: exactly that pass's dotted names, sorted, and not the
    // author's heading sitting beside them.
    const during = scopes.filter((s) => s.scope['order.id'] !== undefined);
    expect(during.length).toBeGreaterThan(0);
    for (const s of during) {
      expect(s.bindings).toEqual(['order._row', 'order.id', 'order.status']);
      expect(s.scope['user.apikey']).toBe('uk_live_1234');
    }

    // After the `Set`: the properties are gone from the scope and the list is
    // empty again — the mark and the entry go together.
    const last = scopes.at(-1)!;
    expect(last.scope['order']).toBe('none');
    expect(last.scope['order.id']).toBeUndefined();
    expect(last.bindings).toEqual([]);
  });

  /**
   * The other half the client could not see: `## Config: unmask:`.
   *
   * It is parsed from the request the client itself sent, and was then read
   * only by the prompt's `## Values` block — so after an author unmasked
   * `keyword`, the model saw the value and every Steptix surface went on
   * starring it. Now it rides each `frame:scope`, and the client exempts a
   * named entry from all three rules exactly as `formatParameterBlock` does.
   */
  it('carries the run’s unmask names on every scope frame, and omits the field without them', async () => {
    const declared = await collect({
      ...ordersBody(),
      // Spacing and order as an author would write them; the server trims and
      // the client matches by exact name.
      config: { unmask: 'keyword,  order.status ' },
    });
    const declaredScopes = declared.filter((e) => e.type === 'frame:scope');
    expect(declaredScopes.length).toBeGreaterThan(0);
    for (const s of declaredScopes) expect(s.unmask).toEqual(['keyword', 'order.status']);

    // A run that declares none sends no field at all, which is byte for byte
    // what it sent before this existed — and is also what an older server
    // sends, so the client cannot tell them apart and does not need to.
    const plain = (await collect(ordersBody())).filter((e) => e.type === 'frame:scope');
    expect(plain.length).toBeGreaterThan(0);
    for (const s of plain) expect('unmask' in s).toBe(false);
  });

  /**
   * §4.6's own example header, whose tail names a property of the item it is
   * about to bind.
   *
   * This loop interpolates EVERY step before the control dispatch, so the
   * header is resolved on the visit that has not begun a pass yet — and
   * `controlLineDefines` exempted the item `{{order}}` and nothing else, so
   * `{{order.id}}` was warned about as `Unresolved placeholder` on every entry
   * to every correct table loop. The same noise the round-1 fix removed, one
   * dot further along, and on the line the spec prints as the recommended
   * form.
   */
  it('does not warn about a property of the item the header is about to bind', async () => {
    await collect({
      steps: [
        'Open the orders page',
        'For each {{order}} in {{orders}}, Click the row whose Order ID is "{{order.id}}"',
        'Sign out',
      ],
      sourceLines: [3, 4, 5],
      testFilePath,
      parameters: { orders: ORDERS },
    });

    expect(warnings().filter((w) => w.includes('Unresolved placeholder'))).toEqual([]);
    // The loop really ran, so the silence is about a working line rather than
    // about a line that never got here.
    expect(executedSteps).toEqual([
      'Open the orders page',
      'Click the row whose Order ID is "A"',
      'Click the row whose Order ID is "B"',
      'Sign out',
    ]);
  });

  it('still warns about a dotted name no loop binds, on an ordinary step', async () => {
    // The control: only the item's OWN root is exempt, and only on the line
    // that defines it.
    await collect({
      steps: [
        'Open the orders page',
        'Verify the row for "{{other.id}}" is shown',
      ],
      sourceLines: [3, 4],
      testFilePath,
      parameters: { orders: ORDERS },
    });

    expect(warnings()).toContain('Unresolved placeholder: {{other.id}}');
  });

  it('refuses a property the row does not have, before the model is asked', async () => {
    const events = await collect({
      ...ordersBody(),
      sections: {
        'check the order': {
          name: 'Check the order',
          headingLine: 7,
          steps: ['Verify the row shows "{{order.statuz}}"'],
          stepLines: [8],
        },
      },
    });

    const failure = events.find((e) => e.type === 'step:fail');
    expect(failure!.error).toBe(
      '{{order.statuz}} has no value in For each item 1; available properties are _row, id, status',
    );
    // The body step never ran, so nothing was sent to the model with six
    // literal braces in it.
    expect(executedSteps).toEqual(['Open the orders page']);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'failed' });
  });

  /**
   * …and the refusal is MASKED on the way out, on all three of the server's
   * exits: the run log, the report row and the `step:fail` wire payload a
   * client renders.
   *
   * The sentence is written from the run's own values — the properties the
   * row holds, the keys the loop dropped — and a key can carry one:
   * `hunter2 header`, where `hunter2` is what `{{password}}` holds. Round 2
   * masked `evaluateGuard`'s `cannot be referenced as a placeholder` line for
   * exactly this and left the louder sentence beside it in the clear. The
   * server's masker is `secretsNow`, which counts a section row's frame
   * inputs as well as the parameter map, which is why it is handed in rather
   * than derived.
   */
  /**
   * The server takes its mask set from a COPY of the map (frame inputs
   * merged in), and the loop-binding registry is by object identity, so the
   * copy must inherit the marks (§7.6). Without `inheritLoopBindings` every
   * `order.<column>` in the copy takes the author rule, `keyword` contains
   * `key`, its value joins the mask set, and the refusal's own property list
   * arrives on the wire as `id, ***`. The data file's `user.apikey` heading
   * takes the author rule either way and is masked in the report.
   */
  it('reads a pass binding by the record rule on the wire, and a data-file heading by the author rule', async () => {
    (logger.error as unknown as { mockClear: () => void }).mockClear();
    const events = await collect({
      steps: [
        'Open the orders page',
        'For each {{order}} in {{orders}}, Check the order',
        'Sign out',
      ],
      sourceLines: [3, 4, 5],
      testFilePath,
      parameters: { 'user.apikey': 'uk_live_1234', orders: '[{"id":"A","keyword":"keyword"}]' },
      sections: {
        'check the order': {
          name: 'Check the order',
          headingLine: 7,
          steps: ['Verify the row shows "{{order.nope}}"'],
          stepLines: [8],
        },
      },
    });

    const expected =
      '{{order.nope}} has no value in For each item 1; available properties are id, keyword';
    expect(events.find((e) => e.type === 'step:fail')!.error).toBe(expected);
    const logged = (logger.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (c) => String(c[0]),
    );
    expect(logged.some((l) => l.endsWith(expected))).toBe(true);

    const report = generatedReports.at(-1)!;
    expect(report.parameters['order.keyword']).toBe('keyword');
    expect(report.parameters['user.apikey']).toBe('***');
    const everywhere = JSON.stringify({
      report,
      events: events.filter((e) => e.type !== 'frame:scope'),
      logged,
    });
    expect(everywhere).not.toContain('uk_live_1234');
  });

  it('masks a secret value the refusal would otherwise put on the wire', async () => {
    (logger.error as unknown as { mockClear: () => void }).mockClear();
    const events = await collect({
      steps: [
        'Open the orders page',
        'For each {{order}} in {{orders}}, Check the order',
        'Sign out',
      ],
      sourceLines: [3, 4, 5],
      testFilePath,
      parameters: { password: 'hunter2', orders: '[{"id":"A","hunter2 header":"t"}]' },
      sections: {
        'check the order': {
          name: 'Check the order',
          headingLine: 7,
          steps: ['Verify the row shows "{{order.contenttype}}"'],
          stepLines: [8],
        },
      },
    });

    const expected =
      '{{order.contenttype}} has no value in For each item 1; available properties are id ' +
      '(*** header cannot be spelled as a placeholder)';

    // 1. The wire.
    expect(events.find((e) => e.type === 'step:fail')!.error).toBe(expected);
    // 2. The run log.
    const logged = (logger.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (c) => String(c[0]),
    );
    expect(logged.some((l) => l.endsWith(expected))).toBe(true);
    // 3. The report row.
    const failedRow = generatedReports
      .at(-1)!
      .steps.find((s: { status: string }) => s.status === 'failed');
    expect(failedRow.error).toBe(expected);
    expect(failedRow.aiExplanation).toBe(expected);

    // The raw value reaches none of the three. Scoped to the refusal's own
    // seams on purpose: `frame:scope` carries the parameter map itself, which
    // is a different payload with its own rules and is not what this refusal
    // decides.
    const everywhere = JSON.stringify({
      fail: events.filter((e) => e.type === 'step:fail'),
      logged,
      failedRow,
    });
    expect(everywhere).not.toContain('hunter2');
  });

  /**
   * A condition whose operands are all literals after substitution is decided
   * by the runtime, not by the page judge
   * (src/parser/literal-condition.ts).
   *
   * Measured on an acceptance run of `templates/init/tests/table-statements.md`:
   * `If "{{line.debit}}" is empty` substituted to `"" is empty`, and the judge
   * answered *"none held — the visible statement row being evaluated has debit
   * −$65.00"*. It read a different row than the pass was bound to and took the
   * `Otherwise`. The same line was right 5/5 in `table-payments-reference.md`,
   * so it is a ~1-in-15 flake — in a place that should never have been a model
   * call, because the answer was entirely in the sentence.
   */
  it('decides an all-literal chain itself, with no judge call', async () => {
    const events = await collect({
      steps: [
        'Open the statements page',
        'For each {{line}} in {{lines}}, Check the line',
        'Sign out',
      ],
      sourceLines: [3, 4, 5],
      testFilePath,
      parameters: {
        lines: '[{"debit":"","credit":"$65.00"},{"debit":"-$65.00","credit":""}]',
      },
      sections: {
        'check the line': {
          name: 'Check the line',
          headingLine: 7,
          steps: [
            'If "{{line.debit}}" is empty, then Verify the credit',
            'Otherwise, Verify the debit',
          ],
          stepLines: [8, 9],
        },
        'verify the credit': {
          name: 'Verify the credit',
          headingLine: 11,
          steps: ['Verify the credit column shows "{{line.credit}}"'],
          stepLines: [12],
        },
        'verify the debit': {
          name: 'Verify the debit',
          headingLine: 14,
          steps: ['Verify the debit column shows "{{line.debit}}"'],
          stepLines: [15],
        },
      },
    });

    // The point of the test.
    expect(judgeCalls).toHaveLength(0);
    // Pass 1's debit is blank so the `If` holds; pass 2's is not, so the
    // `Otherwise` does — each pass on its own row's values.
    expect(executedSteps).toEqual([
      'Open the statements page',
      'Verify the credit column shows "$65.00"',
      'Verify the debit column shows "-$65.00"',
      'Sign out',
    ]);

    // The guard still reports exactly as a judged one does — same rows, same
    // statuses, same lines — with the runtime's sentence where the model's
    // was. Pass 1 passes the `If`; pass 2 takes the `Otherwise`, so that is
    // the row carrying the chain's reasoning and the `If` is skipped.
    const steps: StepResult[] = generatedReports.at(-1)!.steps;
    const guards = steps.filter(
      (s) => s.instruction.startsWith('If "') || s.instruction.startsWith('Otherwise,'),
    );
    expect(guards.filter((s) => s.status === 'passed').map((s) => s.aiExplanation)).toEqual([
      'decided from the values: "" is empty → true',
      'decided from the values: none held — "-$65.00" is empty → false',
    ]);
    // The untaken branch is reported exactly as a judged chain reports one.
    expect(guards.filter((s) => s.status === 'skipped').map((s) => s.aiExplanation)).toEqual([
      'Skipped: another branch of this decision was taken',
      'Skipped: another branch of this decision was taken',
    ]);
    // Nothing was asked, so no guard row carries a turn to render.
    expect(guards.every((s) => s.turns.length === 0)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
  });

  /**
   * A guard's OWN condition gets the same refusal a body step's text does
   * (docs/specs/SPEC-structured-table-reads.md §8.3).
   *
   * It has to live in `evaluateGuard` rather than in each loop's step path:
   * this loop resolves every step before the control dispatch and so caught
   * the guard line incidentally, while the CLI and the Electron adapter
   * dispatch the guard first and sent `If "{{order.missing}}" is empty` to the
   * judge with the braces intact. One refusal, in the module all three share,
   * with the same sentence and the same failed-guard row.
   */
  it('refuses a guard whose condition names a property the row lacks', async () => {
    const events = await collect({
      steps: [
        'Open the statements page',
        'For each {{line}} in {{lines}}, Check the line',
      ],
      sourceLines: [3, 4],
      testFilePath,
      parameters: { lines: '[{"debit":"","credit":"$65.00"}]' },
      sections: {
        'check the line': {
          name: 'Check the line',
          headingLine: 6,
          // The typo is the whole test: `dbit` for `debit`.
          steps: ['If "{{line.dbit}}" is empty, then Note it', 'Otherwise, Note it'],
          stepLines: [7, 8],
        },
        'note it': { name: 'Note it', headingLine: 10, steps: ['Click Note'], stepLines: [11] },
      },
    });

    const failure = events.find((e) => e.type === 'step:fail');
    expect(failure!.error).toBe(
      '{{line.dbit}} has no value in For each item 1; available properties are debit, credit',
    );
    // Not the judge's to answer, and not the literal pre-check's either — the
    // refusal comes first, so neither is reached.
    expect(judgeCalls).toHaveLength(0);
    expect(executedSteps).toEqual(['Open the statements page']);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'failed' });
  });

  it('still asks the judge once when a member needs the page', async () => {
    judgeScript = [0];
    await collect({
      steps: [
        'Open the statements page',
        'For each {{line}} in {{lines}}, Check the line',
      ],
      sourceLines: [3, 4],
      testFilePath,
      parameters: { lines: '[{"debit":""}]' },
      sections: {
        'check the line': {
          name: 'Check the line',
          headingLine: 6,
          steps: [
            // Literal…
            'If "{{line.debit}}" is empty, then Note it',
            // …but this one is about the page, so the WHOLE chain goes to the
            // judge. Deciding half of it here and asking about the rest would
            // be two decisions where the author wrote one, and the judge would
            // be answering about a shorter list than the planner is holding
            // indices for.
            'Else if the Refunded badge is shown, then Note it',
            'Otherwise, Note it',
          ],
          stepLines: [7, 8, 9],
        },
        'note it': {
          name: 'Note it',
          headingLine: 11,
          steps: ['Click Note'],
          stepLines: [12],
        },
      },
    });

    expect(judgeCalls).toEqual([
      ['"{{line.debit}}" is empty', 'the Refunded badge is shown'],
    ]);
  });

  /**
   * The feature's OWN examples, which the grammar was rejecting.
   *
   * `If {{payment.status}} is "Paused"` substituted to `Overdue is "Paused"`
   * under plain substitution — a bare word on the left, which `VALUE` refuses
   * on purpose (`the Cash checkbox is ticked` has to keep going to the page).
   * So the acceptance tests' guards went on costing a judge call per pass and
   * kept exactly the wrong-answer risk this whole path exists to remove.
   * Substituting each reference as a QUOTED literal gives
   * `"Overdue" is "Paused"`, which is decided here.
   */
  it('decides an unquoted reference by quoting it, not by asking', async () => {
    const events = await collect({
      steps: [
        'Open the payments page',
        'For each {{payment}} in {{payments}}, Check the payment',
        'Sign out',
      ],
      sourceLines: [3, 4, 5],
      testFilePath,
      parameters: {
        payments: '[{"status":"Overdue"},{"status":"Paused"}]',
      },
      sections: {
        'check the payment': {
          name: 'Check the payment',
          headingLine: 7,
          steps: [
            'If {{payment.status}} is "Paused", then Resume it',
            'Otherwise, Chase it',
          ],
          stepLines: [8, 9],
        },
        'resume it': { name: 'Resume it', headingLine: 11, steps: ['Click Resume'], stepLines: [12] },
        'chase it': { name: 'Chase it', headingLine: 14, steps: ['Click Chase'], stepLines: [15] },
      },
    });

    expect(judgeCalls).toHaveLength(0);
    expect(executedSteps).toEqual(['Open the payments page', 'Click Chase', 'Click Resume', 'Sign out']);

    // The reasoning shows the QUOTED form it decided from — both sides
    // delimited, which is what makes a value unable to read as syntax.
    const steps: StepResult[] = generatedReports.at(-1)!.steps;
    const guards = steps.filter(
      (s) => s.instruction.startsWith('If {{') || s.instruction.startsWith('Otherwise,'),
    );
    expect(guards.filter((s) => s.status === 'passed').map((s) => s.aiExplanation)).toEqual([
      'decided from the values: none held — "Overdue" is "Paused" → false',
      'decided from the values: "Paused" is "Paused" → true',
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
  });

  /**
   * A condition whose AUTHORED text made no reference is a sentence about the
   * PAGE that happens to be spelled with quotes.
   *
   * `If "Welcome back" is empty` parses perfectly and answers `false` from its
   * own characters, with no page look at all; `Repeat … until "Load more" is
   * empty` answers `false` on every pass and runs the loop to its cap. The
   * grammar cannot tell those from a substituted value — only the presence of
   * a `{{…}}` or `${…}` in what the author wrote can.
   */
  it('sends an all-literal AUTHORED condition to the judge, as before', async () => {
    judgeScript = [0];
    await collect({
      steps: [
        'Open the page',
        'If "Welcome back" is empty, then Sign in again',
        'Verify the dashboard is shown',
      ],
      sourceLines: [3, 4, 5],
      testFilePath,
      sections: {
        'sign in again': {
          name: 'Sign in again',
          headingLine: 7,
          steps: ['Click Sign in'],
          stepLines: [8],
        },
      },
    });

    expect(judgeCalls).toEqual([['"Welcome back" is empty']]);
  });

  it('does not run a Repeat to its cap on a literal it could not have answered', async () => {
    // `until "Load more" is empty` is about the page. Answered locally it is
    // false forever, so the loop would spend its whole cap and then fail the
    // line. The judge ends it on the second pass.
    judgeScript = [null, 0];
    const events = await collect({
      steps: [
        'Open the results page',
        'Repeat Load more until "Load more" is empty',
        'Sign out',
      ],
      sourceLines: [3, 4, 5],
      testFilePath,
      sections: {
        'load more': { name: 'Load more', headingLine: 7, steps: ['Click Load more'], stepLines: [8] },
      },
    });

    expect(executedSteps).toEqual([
      'Open the results page',
      'Click Load more',
      'Click Load more',
      'Sign out',
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
  });

  /**
   * A locally decided condition's reasoning is built from the SUBSTITUTED
   * text, which the judge's never was — so it is the one string in this path
   * that can carry a secret, and it goes out on `step:pass` as `output` as
   * well as into the run log.
   */
  it('masks a secret value out of the sentence it decided from', async () => {
    const events = await collect({
      steps: [
        'Open the orders page',
        'For each {{order}} in {{orders}}, Check the order',
        'Sign out',
      ],
      sourceLines: [3, 4, 5],
      testFilePath,
      parameters: { orders: '[{"token":"s3cr3t-abc123"}]' },
      sections: {
        'check the order': {
          name: 'Check the order',
          headingLine: 7,
          steps: ['If "{{order.token}}" is empty, then Reissue it', 'Otherwise, Ship it'],
          stepLines: [8, 9],
        },
        'reissue it': { name: 'Reissue it', headingLine: 11, steps: ['Click Reissue'], stepLines: [12] },
        'ship it': { name: 'Ship it', headingLine: 14, steps: ['Click Ship'], stepLines: [15] },
      },
    });

    expect(judgeCalls).toHaveLength(0);
    const passes = events.filter((e) => e.type === 'step:pass');
    const sentences = passes.map((e) => String(e.output ?? ''));
    expect(sentences).toContain('decided from the values: none held — "***" is empty → false');
    expect(sentences.some((s) => s.includes('s3cr3t-abc123'))).toBe(false);

    const steps: StepResult[] = generatedReports.at(-1)!.steps;
    expect(
      steps.some((s) => (s.aiExplanation ?? '').includes('s3cr3t-abc123')),
    ).toBe(false);
  });

  /**
   * The report's loop band, masked by the BINDING rule and not the author's
   * (docs/specs/SPEC-structured-table-reads.md §7.6 — the round-2 defect).
   *
   * A band is a COPY (`values: { ...pass.bindings }`) and the binding registry
   * is keyed on object identity, so the copy arrives carrying none of the
   * marks unless the site that makes it says so. Without that,
   * `redactReport` decides every `payment.<column>` by the author rule —
   * `isSecretName` is `/password|secret|token|key/i`, so `keyword` matches —
   * and the report starred a column the model has to FIND in the DOM.
   *
   * WHICH site makes the copy is worth stating, because the two are easy to
   * confuse and only one of them is on this path. A `For each` is a RUNTIME
   * loop, so `loops.markerFor(i)` answers before the frame walk is reached
   * and the band is the one `ControlRuntime.beginPass` minted, marked there
   * (src/runner/control-runtime.ts). `loopMarkerFor`'s own
   * `inheritLoopBindings` (src/server/session-manager.ts) is the frame-walk
   * twin, reached only when no runtime pass covers the step; measured, every
   * shape the api-server suites produce for it today is a section-`rows` loop
   * whose cells are FLAT names, and a flat name never consults the registry.
   * So that line stays pinned by the grep in tests/secrets.test.ts, and this
   * is the behavioural pin for the site a `For each` actually uses.
   *
   * One row, three columns, and the two rules disagree about two of them.
   */
  it('masks the report band by the binding rule — `password` starred, `keyword` not', async () => {
    await collect({
      steps: [
        'Open the payments page',
        'For each {{payment}} in {{payments}}, Check the payment',
      ],
      sourceLines: [3, 4],
      testFilePath,
      parameters: { payments: '[{"payee":"Acme","password":"abc","keyword":"AU"}]' },
      sections: {
        'check the payment': {
          name: 'Check the payment',
          headingLine: 6,
          steps: ['Verify the payee is "{{payment.payee}}"'],
          stepLines: [7],
        },
      },
    });

    const steps: StepResult[] = generatedReports.at(-1)!.steps;
    const band = steps.find((s) => s.instruction.startsWith('Verify the payee'))!.loop!.values;

    // The narrow record rule, which is the one a bound column gets: a real
    // credential name still goes, an innocent one that merely CONTAINS `key`
    // survives.
    expect(band['payment.password']).toBe('***');
    expect(band['payment.keyword']).toBe('AU');
    expect(band['payment.payee']).toBe('Acme');
    // The root binding is the row's compact JSON, masked inside by shape
    // (review 5, finding 2) — same verdict per column, one level down.
    expect(band['payment']).toBe('{"payee":"Acme","password":"***","keyword":"AU"}');
  });

  /**
   * A row that omits a property must not inherit the previous row's value
   * (§8.2, §8.3). All three run loops wrote a pass's bindings with
   * `Object.assign`, which cannot delete — so pass 2's `{{row.note}}`
   * substituted pass 1's note, and the refusal below could not fire because
   * the key was still there.
   */
  it('refuses the pass whose row lacks the property, rather than reusing the last one', async () => {
    const events = await collect({
      steps: [
        'Open the orders page',
        'For each {{row}} in {{rows}}, Check the row',
        'Sign out',
      ],
      sourceLines: [3, 4, 5],
      testFilePath,
      parameters: { rows: '[{"_row":"1","id":"A","note":"first"},{"_row":"2","id":"B"}]' },
      sections: {
        'check the row': {
          name: 'Check the row',
          headingLine: 7,
          steps: ['Verify the note says "{{row.note}}"'],
          stepLines: [8],
        },
      },
    });

    const failure = events.find((e) => e.type === 'step:fail');
    expect(failure!.error).toBe(
      '{{row.note}} has no value in For each item 2; available properties are _row, id',
    );
    expect(executedSteps).toEqual([
      'Open the orders page',
      'Verify the note says "first"',
    ]);
  });

  it('decides an all-literal While condition per evaluation', async () => {
    await collect({
      steps: [
        'Open the statements page',
        'While "{{line.debit}}" is not empty, Click Next',
        'Sign out',
      ],
      sourceLines: [3, 4, 5],
      testFilePath,
      // Never bound by a loop, so the condition is false on its first
      // evaluation and the body never runs — with no model call either way.
      parameters: { line: '{"debit":""}', 'line.debit': '' },
    });

    expect(judgeCalls).toHaveLength(0);
    expect(executedSteps).toEqual(['Open the statements page', 'Sign out']);
  });

  /**
   * A key no placeholder can spell is dropped, and the loop runs.
   *
   * It failed the whole guard until review 2 — which is a regression for every
   * existing `For each` over a tool's or an API's array of objects, where
   * `content-type` is ordinary and no step asks for a dotted binding at all
   * (§2 keeps existing `For each` behaviour). `__proto__` is the sharp end of
   * the same rule: it must not become a binding, and it must not stop a run.
   */
  it('drops a key no placeholder can spell, and loops over the rest', async () => {
    const events = await collect(
      ordersBody(
        '[{"_row":"1","id":"A","status":"x","__proto__":"boom"},' +
          '{"_row":"2","id":"B","status":"y","content-type":"t"}]',
      ),
    );

    expect(events.find((e) => e.type === 'step:fail')).toBeUndefined();
    expect(executedSteps).toEqual([
      'Open the orders page',
      'Verify the row for "A" shows "x"',
      'Verify the row for "B" shows "y"',
      'Sign out',
    ]);
    // Neither key became a binding — the scope holds the spellable ones only.
    const scopes = events.filter((e) => e.type === 'frame:scope').map((e) => e.scope);
    const keys = scopes.flatMap((s) => Object.keys(s as Record<string, unknown>));
    expect(keys).not.toContain('order.__proto__');
    expect(keys).not.toContain('order.content-type');
    expect(keys).toContain('order.status');
  });

  /**
   * A write that REBINDS the loop's root erases its dotted keys
   * (docs/specs/SPEC-structured-table-reads.md §8.2).
   *
   * `applyPassBindings` and `runSetStep` honoured that; every other write into
   * the live map was a plain `resolvedParameters[name] = value`. So a capture
   * or a tool output landing on `order` left `order.id` holding the LAST
   * PASS's id, and a later `{{order.id}}` substituted it silently — §8.3's
   * refusal cannot fire on a key that is still there.
   *
   * A `[tool: …]` step is that write on THIS entry: the server dispatches it
   * itself, outside the (mocked) step executor, so the value really travels
   * from `ctx.step.setVar` into the map the next step's text is checked
   * against.
   */
  it('refuses a stale {{order.id}} after a tool rebinds {{order}}', async () => {
    const events = await collect({
      steps: [
        'For each {{order}} in {{orders}}, Check the order',
        '[tool: note-order value="ORD-9"]',
        'Verify the summary shows {{order.id}}',
      ],
      sourceLines: [3, 4, 5],
      testFilePath,
      toolsDir,
      parameters: { orders: ORDERS },
      sections: {
        'check the order': {
          name: 'Check the order',
          headingLine: 7,
          steps: ['Verify the row for "{{order.id}}"'],
          stepLines: [8],
        },
      },
    });

    // The tool really ran and really rebound the name.
    expect(
      events.filter((e) => e.type === 'capture').map((e) => [e.name, e.value]),
    ).toContainEqual(['order', 'ORD-9']);

    const fail = events.find((e) => e.type === 'step:fail');
    expect(fail?.error).toBe(
      '{{order.id}} has no value in For each item 2; {{order}} holds no properties — it is not an object',
    );
    // …and the last pass's `B` never reached the model as this step's value.
    expect(executedSteps).toEqual([
      'Verify the row for "A"',
      'Verify the row for "B"',
    ]);
  });
});

// ── The guard's own events pair ──────────────────────────────────────

/**
 * Every `step:start` a guard's line opens is closed by a `step:pass` or a
 * `step:fail` on that same line — the paint rule Steptix relies on.
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
    // And the watch group's own unmatched row keeps its status. The branched
    // path narrowed `'skipped'` to `'passed'` on its way into `results[]` — a
    // narrowing that predates the union gaining `'skipped'` and greened a row
    // for a branch the group did not match, which is the same false green a
    // chain's untaken half used to get.
    expect(
      body.results.map((r: { step: string; status: string }) => [r.step, r.status]),
    ).toContainEqual(['If a cookie banner appears, click Reject all', 'skipped']);
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

  /** The run's `compile:result` frame. */
  const compileResultIn = (events: Array<{ type: string; [k: string]: any }>): any => {
    const found = events.find((e) => e.type === 'compile:result');
    expect(found, 'the run emitted no compile:result frame').toBeDefined();
    return found;
  };
  /** The one proposed `.steps.ts`, as text. */
  const proposalIn = (events: Array<{ type: string; [k: string]: any }>): string =>
    Object.values(compileResultIn(events).files as Record<string, string>).join('\n');
  const WHILE_LINE = 'While the Next button is enabled, Go to the next page';

  it('compiles a whole file that loops — the refusal is gone', async () => {
    // stories/codebehind-loops-and-conditions.md: the server used to refuse
    // any compile whose slice touched a loop, before anything ran. Nothing is
    // refused now; the `While` decides "no" on its first visit, so the loop
    // runs no passes, and the run goes straight on.
    const events = await collect(whileBody({ compile: 'run' }));

    expect(refusalIn(events)).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
    expect(executedSteps).toEqual(['Open the statements page', 'Verify the last page is shown']);

    const result = compileResultIn(events);
    // The guard's condition is generated from the one visit — it did not hold.
    expect(proposalIn(events)).toContain('async condition(');
    const conditionPrompt = compilePrompts.find((p) => /async condition\(\{ page, step \}\)/.test(p))!;
    expect(conditionPrompt).toContain('### Observation 1 — the condition did NOT hold');
    // The body never ran: named not attempted with the DECISION sentence
    // (decision 12), not the return one.
    const bodyNumber = 3;
    expect(result.summary.notAttempted).toContain(bodyNumber);
    const bodyFrame = events.find(
      (e) => e.type === 'compile:step' && e.step === bodyNumber && /did not run/.test(e.message),
    );
    expect(bodyFrame?.message).toBe('the step did not run — the run decided against it');
    expect(result.status).toBe('partial');
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

  it('compiles the condition of a selected loop guard, and nothing in its body', async () => {
    // Compile This Step on the `While` line. The run goes to the end of what
    // the guard opens (the control-structure snap — a decision needs its
    // consequence), so the body runs its passes under AI; the compile writes
    // the CONDITION and nothing else.
    judgeScript = [0, 0, null];
    const events = await collect(
      whileBody({
        compile: 'steps',
        startAt: { uri: testFilePath, line: 4 },
        endAt: { uri: testFilePath, line: 4 },
      }),
    );

    expect(refusalIn(events)).toBeUndefined();
    expect(executedSteps).toEqual(['Click Next', 'Click Next']);
    const result = compileResultIn(events);
    const file = proposalIn(events);
    expect(file).toContain(`source: '${WHILE_LINE}'`);
    expect(file).toContain('async condition(');
    expect(file).not.toContain('Click Next');
    expect(result.summary).toMatchObject({ totalSteps: 1, compiled: 1, notAttempted: [] });
    // One generation, shown the first held AND the first not-held page.
    const prompts = compilePrompts.filter((p) => !/Review a generated/.test(p));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('### Observation 1 — the condition HELD');
    expect(prompts[0]).toContain('<!-- judge call 1 -->');
    expect(prompts[0]).toContain('### Observation 2 — the condition did NOT hold');
    expect(prompts[0]).toContain('<!-- judge call 3 -->');
  });

  it('lets a compile of the looped SECTION proceed — it arrives detached', async () => {
    // Steptix runs a selection made entirely of section-body lines detached,
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

  it('compiles a selected loop-body step once, however many passes it runs', async () => {
    // Line 8 is `Click Next`, the section body the `While` runs. A run that
    // starts inside the body counts that partial pass as pass 1, returns to
    // the guard, and runs on — the guard is visited, but it was not selected,
    // so its condition is not generated; the body line is ONE entry.
    judgeScript = [0, null];
    const events = await collect(
      whileBody({
        compile: 'steps',
        startAt: { uri: testFilePath, line: 8 },
        endAt: { uri: testFilePath, line: 8 },
      }),
    );

    expect(refusalIn(events)).toBeUndefined();
    expect(executedSteps).toEqual(['Click Next', 'Click Next']);
    const result = compileResultIn(events);
    const file = proposalIn(events);
    // The mocked step performed no page actions, so its one entry is an
    // `ai: true` decline — one slot, not one per pass.
    expect(file.match(/source: 'Click Next'/g)).toHaveLength(1);
    expect(file).not.toContain(WHILE_LINE);
    expect(result.summary).toMatchObject({ totalSteps: 1, keptAi: 1, notAttempted: [] });
  });

  it('compiles a chain, its model-decided condition included', async () => {
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

    // The `If` line is a compile step now: its condition is generated from
    // the page the model decided on. The `Otherwise` has no condition and
    // stays dispatched — no entry, not in the denominator.
    const file = proposalIn(events);
    expect(file).toContain("source: 'If the Cash checkbox is ticked, then Pay with cash'");
    expect(file).toMatch(/async condition\(/);
    expect(file).not.toContain('Otherwise, Pay by card');
    const result = compileResultIn(events);
    // Eight expanded steps, the `Otherwise` dispatched.
    expect(result.summary.totalSteps).toBe(7);
    // The untaken branch's two steps — issue 053 — named, with the decision
    // sentence on their frames.
    const untaken = events
      .filter((e) => e.type === 'compile:step' && e.message === 'the step did not run — the run decided against it')
      .map((e) => e.line);
    expect(untaken).toEqual([13, 14]);
    expect(result.summary.notAttempted).toHaveLength(2);
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

  /**
   * A ONE-LINE loop body, on the server.
   *
   *     3. Open the statements page
   *     4. While the banner is shown, If the retry count is 3 then return
   *     5. Verify the banner is gone
   *
   * `stories/control-flow.md` says this shape was "measured on the server and
   * on the CLI", and until now only the CLI had a test
   * (`tests/test-runner-control-flow.test.ts`). It is a claim that has already
   * been got wrong once — the story documented the opposite as a limitation —
   * so it is pinned on the runner the extension and the MCP tools actually
   * drive, not only on the one the CLI does.
   */
  const oneLineLoopBody = (tail: string) => ({
    steps: ['Open the statements page', `While the banner is shown, ${tail}`, 'Verify the banner is gone'],
    sourceLines: [3, 4, 5],
    testFilePath,
  });

  it('a conditional return written as the whole loop body ends the PASS', async () => {
    // The tail is a plain instruction, so it has no frame of its own — the
    // reasoning that made the story call this the shape that cannot compose.
    // `returnExit` clamps to a control RECORD, and the expander gives a
    // one-step tail one (`bodyStart === bodyEnd === i`).
    judgeScript = [0, 0, null];
    let visits = 0;
    flowControlFor = (instruction) =>
      instruction.startsWith('If the retry count is 3') && ++visits === 2
        ? { kind: 'return', verb: 'return' }
        : undefined;
    const events = await collect(oneLineLoopBody('If the retry count is 3 then return'));

    // Three guard visits: the return ended a pass, not the run.
    expect(judgeCalls).toEqual([
      ['the banner is shown'],
      ['the banner is shown'],
      ['the banner is shown'],
    ]);
    expect(executedSteps).toEqual([
      'Open the statements page',
      'If the retry count is 3 then return',
      'If the retry count is 3 then return',
      'Verify the banner is gone',
    ]);
    // Nothing is reported skipped by either producer: the pass's body is the
    // returning line itself, and the step after the loop ran.
    expect(events.filter((e) => e.type === 'step:skip')).toEqual([]);
    expect(events.filter((e) => e.type === 'step:pass' && e.output === 'skipped')).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
  });

  it('an UNCONDITIONAL return as the whole loop body behaves the same', async () => {
    // `While x, Return` — dispatched by the parser, so no model call for the
    // tail at all and every judge answer belongs to the guard.
    judgeScript = [0, 0, null];
    const events = await collect(oneLineLoopBody('Return'));
    expect(judgeCalls).toHaveLength(3);
    expect(executedSteps).toEqual(['Open the statements page', 'Verify the banner is gone']);
    expect(events.filter((e) => e.type === 'step:skip')).toEqual([]);
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

// ── One accounting, one vocabulary, for both skip producers ──────────
//
// The merge left each surface reporting whichever parent had written it, so
// the two producers of a skipped step agreed on the glyph and the sentence and
// disagreed on every number and every cause derived from them. These pin the
// server's half of the reconciliation.

describe('what a decision-skipped step says about itself', () => {
  it('carries a reason and a skipKind on the wire, so a client can say WHY', async () => {
    judgeScript = [0];
    const events = await collect(chainBody());
    const skipped = events.filter((e) => e.type === 'step:pass' && e.output === 'skipped');
    expect(skipped.map((e) => e.line)).toEqual([5, 13, 14]);
    for (const ev of skipped) {
      // The same sentence the report row carries. Without it the gutter's ◌
      // had no hover at all, while an identical-looking ◌ from the OTHER
      // producer hovered with its reason.
      expect(ev.reason).toBe('Skipped: another branch of this decision was taken');
      // Machine-readable, and what stops the MCP fold telling an agent that an
      // untaken `Otherwise` "needs a human".
      expect(ev.skipKind).toBe('not-taken');
    }
  });

  it('carries both fields on the GUARD row too, when nothing in the chain held', async () => {
    // The fourth producer of `step:pass` + `output: 'skipped'`, and the one a
    // grep for the bare literal missed: it hides behind a ternary in the
    // guard's own emit. Every chain fixture above has an `Otherwise`, so the
    // guard is always `passed` there and no test met this row — while
    // `If the cookie banner is shown, dismiss it` is the commonest conditional
    // anyone writes, and it ended an MCP run saying steps "need a human".
    judgeScript = [null];
    const events = await collect(noOtherwiseBody());
    const skipped = events.filter((e) => e.type === 'step:pass' && e.output === 'skipped');
    expect(skipped.map((e) => [e.line, e.reason, e.skipKind])).toEqual([
      // The guard's own line first — the decision the run made — then the tail
      // it did not take.
      [4, 'Skipped: no condition in this decision held', 'not-taken'],
      [8, 'Skipped: no condition in this decision held', 'not-taken'],
      [9, 'Skipped: no condition in this decision held', 'not-taken'],
    ]);
    // Nothing on this page wanted a person, and nothing but the step after the
    // chain ran.
    expect(executedSteps).toEqual([
      'Open the payments page',
      'Verify the order confirmation is shown',
    ]);
  });

  it('reports the unheld guard skipped in results[], not passed', async () => {
    // The other half of the same row. The response body used to say `passed`
    // for the guard while the report row for the SAME guard said `skipped`,
    // under a comment claiming `'skipped'` had no wire value here — which it
    // has had since decision 9 widened the union.
    judgeScript = [null];
    const body = await post(noOtherwiseBody());
    expect(
      (body.results as { step: string; status: string }[]).map((r) => [r.step, r.status]),
    ).toEqual([
      ['Open the payments page', 'passed'],
      ['If the Cash checkbox is ticked, then Pay with cash', 'skipped'],
      ['Click Pay now', 'skipped'],
      ['Verify the receipt says Paid in cash', 'skipped'],
      ['Verify the order confirmation is shown', 'passed'],
    ]);
    // And the report row agrees with it, which is the whole point.
    const steps: StepResult[] = generatedReports.at(-1)!.steps;
    expect(steps.map((s) => [s.instruction, s.status])).toEqual([
      ['Open the payments page', 'passed'],
      ['If the Cash checkbox is ticked, then Pay with cash', 'skipped'],
      ['Click Pay now', 'skipped'],
      ['Verify the receipt says Paid in cash', 'skipped'],
      ['Verify the order confirmation is shown', 'passed'],
    ]);
  });

  it('says the loop ran no passes when that is what happened', async () => {
    judgeScript = [null];
    const events = await collect(whileBody());
    const skipped = events.filter((e) => e.type === 'step:pass' && e.output === 'skipped');
    expect(skipped.map((e) => [e.line, e.reason, e.skipKind])).toEqual([
      [8, 'Skipped: the loop ran no passes', 'not-taken'],
    ]);
  });

  it('reports it skipped in results[], the same word the report row uses', async () => {
    // The `StepResultResponse` docstring three hundred lines above
    // `emitSkippedStep` argues this in so many words — "`'skipped'` is
    // additive … Reporting it `passed` would be a green row for work that
    // never happened" — and the file used to hold both the rule and its
    // violation: a return's skips were `'skipped'` and a decision's `'passed'`,
    // for the same situation.
    judgeScript = [0];
    const body = await post(chainBody());
    expect(
      (body.results as { step: string; status: string }[]).map((r) => [r.step, r.status]),
    ).toEqual([
      ['Open the payments page', 'passed'],
      ['If the Cash checkbox is ticked, then Pay with cash', 'passed'],
      ['Click Pay now', 'passed'],
      ['Verify the receipt says Paid in cash', 'passed'],
      ['Otherwise, Pay by card', 'skipped'],
      ['Enter the card details', 'skipped'],
      ['Submit the card form', 'skipped'],
      ['Verify the order confirmation is shown', 'passed'],
    ]);
  });

  it('an [input:] skip still means "unattended", which is the compatible default', async () => {
    // The OTHER producer of this event, and the one the field's absence has to
    // keep meaning. `[input:]` in a SECTION body is the reachable shape — the
    // client splits the batch before a main-flow one.
    const events = await collect({
      steps: ['Open the payments page', 'Sign in'],
      sourceLines: [3, 4],
      testFilePath,
      sections: {
        'sign in': {
          name: 'Sign in',
          headingLine: 6,
          steps: ['[input: password] Type the password'],
          stepLines: [7],
        },
      },
    });
    const skipped = events.filter((e) => e.type === 'step:pass' && e.output === 'skipped');
    expect(skipped.map((e) => [e.line, e.skipKind])).toEqual([[7, 'unattended']]);
    expect(skipped[0]!.reason).toContain('[input] and [interactive] steps are not supported');
  });
});

describe('the loop band survives the rows a return produced', () => {
  /**
   * A `While` whose body section returns in the MIDDLE, so each pass leaves a
   * skipped row behind inside the band.
   *
   *     3. Open the statements page
   *     4. While the Next button is enabled, Go to the next page
   *     5. Verify the last page is shown
   *     ### Go to the next page   (heading 7)
   *     8. Click Next
   *     9. Return
   *     10. Record the page
   */
  const returnMidBody = () => ({
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
        steps: ['Click Next', 'Return', 'Record the page'],
        stepLines: [8, 9, 10],
      },
    },
  });

  it('stamps the iteration on a skipped-by-return row, as it does on a passed one', async () => {
    judgeScript = [0, 0, null];
    await collect(returnMidBody());
    const steps: StepResult[] = generatedReports.at(-1)!.steps;
    const rows = steps
      .filter((s) => s.instruction === 'Record the page')
      .map((s) => [s.status, s.loop?.index]);
    // Two passes, two skipped rows, and each inside ITS OWN pass's band. The
    // marker came from the ORIGINAL frame id, where `iteration` never lives —
    // `iteration` is written onto the per-pass CLONE — so both rows had no
    // band at all and sat outside the iteration their pass drew, next to a
    // `Click Next` row that had one.
    expect(rows).toEqual([
      ['skipped', 1],
      ['skipped', 2],
    ]);
    // And the executed row beside it agrees, which is the point: one band per
    // pass, containing everything that pass touched.
    const clicks = steps
      .filter((s) => s.instruction === 'Click Next')
      .map((s) => [s.status, s.loop?.index]);
    expect(clicks).toEqual([
      ['passed', 1],
      ['passed', 2],
    ]);
  });
});

describe('step mode after a return that ended a PASS', () => {
  /**
   * The `whileBody` shape with a body that returns before its last step.
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

  it('parks the ▶ on the guard the run is going back to, not on the skipped line', async () => {
    // Decision 10 says the pause decision uses the step that will ACTUALLY run
    // next. That was written when a return always resumed at `exit + 1`; a
    // return inside a loop body resumes at the GUARD, backwards, and `exit + 1`
    // then named line 9 — the body line this very return had just declared
    // skipped, which is the exact failure the rule exists to prevent.
    judgeScript = [0, null];
    const sessionId = nextSession();
    const events: Array<{ type: string; [k: string]: any }> = [];
    let awaiting = 0;

    for await (const ev of sseEvents(returnInLoopBody({ stepMode: 'into' }), undefined, sessionId)) {
      events.push(ev);
      if (ev.type === 'step:awaiting') {
        awaiting++;
        if (awaiting > 8) throw new Error('the server kept pausing');
        expect(await runControl(sessionId, 'into')).toBe(200);
      }
      if (ev.type === 'done') break;
    }

    const awaitingLines = events.filter((e) => e.type === 'step:awaiting').map((e) => e.line);
    // Line 4 is the guard: the run goes back to it after the pass ends, so
    // that is where the ▶ belongs.
    expect(awaitingLines).toContain(4);
    // Line 9 is the body's second step. This run reported it skipped and is
    // never going to run it.
    expect(awaitingLines).not.toContain(9);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
  });

  it('an ordinary step that closes a loop body parks on the guard too', async () => {
    // The half that is ours rather than main's, and the same mismatch: without
    // the planner the pause decision read `i + 1` for every step, so the last
    // line of a loop body named the step AFTER the loop while the run went
    // back to the guard.
    judgeScript = [0, null];
    const sessionId = nextSession();
    const events: Array<{ type: string; [k: string]: any }> = [];
    let awaiting = 0;

    for await (const ev of sseEvents(whileBody({ stepMode: 'into' }), undefined, sessionId)) {
      events.push(ev);
      if (ev.type === 'step:awaiting') {
        awaiting++;
        if (awaiting > 8) throw new Error('the server kept pausing');
        expect(await runControl(sessionId, 'into')).toBe(200);
      }
      if (ev.type === 'done') break;
    }

    const awaitingLines = events.filter((e) => e.type === 'step:awaiting').map((e) => e.line);
    // After line 8 (`Click Next`, the whole body) the run re-evaluates line 4.
    expect(awaitingLines.slice(awaitingLines.indexOf(8))).toContain(4);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
  });
});

/**
 * An `[output:]` step whose variable is a name off `Object.prototype`, over
 * the wire.
 *
 * The session loop asked `varName in resolvedParameters` when deciding what
 * the step captured, and `in` walks the prototype chain: `[output: constructor]`
 * therefore "captured" the `Object` FUNCTION out of a map that binds nothing
 * of the sort. It travelled into `session.outputs`, into the step's `outputs`
 * and onto the wire as a `capture` event — all three typed `string`, and the
 * Variables panel a client renders from that event then showed a variable the
 * run never had.
 *
 * **Through the HTTP entry, and not against `session-manager.ts` directly**,
 * for this file's own reason: what a client sees is the event, and the event
 * is built from the map two layers down.
 */
describe('an [output:] step naming a prototype key (server)', () => {
  const outputBody = (extra: Record<string, unknown> = {}) => ({
    steps: ['[output: constructor] Read the order id'],
    sourceLines: [3],
    testFilePath,
    ...extra,
  });

  it('emits no capture event, and no outputs, for a value nothing captured', async () => {
    const events = await collect(outputBody());
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
    // Not "a capture event with a missing value" — no capture event at all.
    expect(events.filter((e) => e.type === 'capture')).toEqual([]);

    const body = await post(outputBody());
    expect(body.results[0].outputs ?? {}).toEqual({});
    expect(JSON.stringify(body)).not.toContain('native code');
  });

  it('still captures the name when the run really binds it', async () => {
    // A `constructor` the caller handed in — a capture from an earlier run of
    // the same session is the realistic source, and it is an OWN property of
    // the map either way.
    const events = await collect(outputBody({ parameters: { constructor: 'ORD-1001' } }));
    expect(events.filter((e) => e.type === 'capture')).toMatchObject([
      { type: 'capture', name: 'constructor', value: 'ORD-1001', source: 'capture' },
    ]);

    const body = await post(outputBody({ parameters: { constructor: 'ORD-1001' } }));
    expect(body.results[0].outputs).toMatchObject({ constructor: 'ORD-1001' });
  });
});

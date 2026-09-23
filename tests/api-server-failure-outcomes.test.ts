/**
 * The two failure outcomes over HTTP (stories/step-failure-outcomes.md §Tests).
 * Every test POSTs through the real `node:http` entry: `api-server.ts` builds
 * `StepRequest` from a per-field allow-list, so handing one straight to the
 * session manager passes against a server that drops the field. Executor, AI and
 * browser are mocked — a result is HANDED to the loop, and the executor's own
 * half is pinned in `failure-tail-executor.test.ts` — while the expander,
 * validation, frame stack and step loop are real. Steps posted here pass no
 * parse-time validator, so this is also the one path decision 8 can reach.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';
import type { ParsedFlowControlStep } from '../src/parser/flow-control-step.js';
import type { ParsedFailureTail } from '../src/parser/failure-tail.js';

// ── Mocks (mirror api-server-flow-control.test.ts) ───────────────────

const mockPage = {
  url: vi.fn(() => 'https://example.com'),
  title: vi.fn(async () => 'Example Page'),
  goto: vi.fn(async () => null),
};
const mockBrowserSession = {
  browser: { isConnected: vi.fn(() => true) },
  context: {},
  page: mockPage,
  pageTracker: { getActive: vi.fn(() => mockPage as any) },
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

type StepOpts = {
  flowControlClaim?: ParsedFlowControlStep;
  failureTail?: ParsedFailureTail;
  conversationHistory?: string[];
};
type Outcome = 'tolerated' | 'tolerated-warned' | 'tolerated-deliberate' | 'deliberate' | 'failed';

/** Instruction text → the outcome the mocked executor produces for it. */
const outcomes = new Map<string, Outcome>();
/** `[instruction, opts]` for every step that reached the executor. */
const seen: Array<{ instruction: string; opts: StepOpts }> = [];

/** What each outcome looks like coming back from the executor. `-warned` is a
 *  separate entry so the absent `warning` stays pinned beside the present one;
 *  `tolerated-deliberate` is the real shape of a hand-written `step.fail()`
 *  under `otherwise continue` — `fromCodeBehind` too, since it throws the class
 *  a failed `step.expect` throws (decisions 2 and 6). */
const outcomeResults: Record<Outcome, Partial<StepResult>> = {
  tolerated: {
    status: 'failed', error: 'the build number was not there', tolerated: true,
    aiExplanation: 'The run continued past this step (otherwise continue). What failed: the build number was not there',
  },
  'tolerated-warned': {
    status: 'failed', error: 'the build number was not there', tolerated: true,
    warning: 'Footer build number missing',
    aiExplanation: 'Footer build number missing. The run continued past this step (otherwise continue). What failed: the build number was not there',
  },
  'tolerated-deliberate': {
    status: 'failed', error: 'The cart was empty and this page needs it filled',
    tolerated: true, deliberate: true, fromCodeBehind: true,
    aiExplanation: "This step's code-behind called `step.fail(...)`: a deliberate failure. The run continued past this step (otherwise continue).",
  },
  deliberate: {
    status: 'failed', error: 'The variable value was peanuts. Expected apples', deliberate: true,
    aiExplanation: "The step's condition held and the step says to fail the test.",
  },
  failed: { status: 'failed', error: 'something broke' },
};

vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: vi.fn(async (
    stepIndex: number,
    _totalSteps: number,
    instruction: string,
    opts?: StepOpts,
  ): Promise<StepResult> => {
    seen.push({ instruction, opts: opts ?? {} });
    const outcome = outcomes.get(instruction);
    return {
      index: stepIndex, instruction, turns: [], durationMs: 5, retried: false,
      ...(outcome ? outcomeResults[outcome] : { status: 'passed', aiExplanation: 'ok' }),
    } as StepResult;
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
    total = 0; inputTotal = 0; outputTotal = 0;
    runTotal = 0; runInputTotal = 0; runOutputTotal = 0;
  },
}));

vi.mock('../src/api/response-store.js', () => ({
  ApiResponseStore: class { store = vi.fn(); getHistory = vi.fn(() => []); },
}));

/** The report the run produced — where the counts have to land, since the
 *  HTTP response's `results[]` is a different, lossier list. */
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
  addLogCallback: vi.fn(() => () => {}), addTraceCallback: vi.fn(() => () => {}),
  isVerbose: vi.fn(() => false), shouldEmit: vi.fn(() => false),
  setLogLevel: vi.fn(), getLogLevel: vi.fn(() => 'info'),
}));

import { createApiServer } from '../src/server/api-server.js';
import { executeStep } from '../src/runner/step-executor.js';
import { captureScreenshot } from '../src/browser/screenshot.js';

const API_KEY = 'sk-failure-outcomes-test';
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
let tmpDir: string;
let testFilePath: string;

beforeAll(async () => {
  const { app } = createApiServer(cfg);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) baseUrl = `http://127.0.0.1:${addr.port}`;

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'failure-outcomes-http-'));
  testFilePath = path.join(tmpDir, 'outcomes.md');
  await fs.writeFile(testFilePath, '# placeholder — the server never reads this\n');
});

afterAll(async () => {
  await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  outcomes.clear();
  seen.length = 0;
  generatedReports.length = 0;
  (executeStep as unknown as { mockClear: () => void }).mockClear();
  (captureScreenshot as unknown as { mockClear: () => void }).mockClear();
});

// ── Helpers ──────────────────────────────────────────────────────────

let sessionSeq = 0;
const headers = () => ({ 'Content-Type': 'application/json', 'x-api-key': API_KEY });
const sessionUrl = (id: string, tail: string) =>
  `${baseUrl}/sessions/${encodeURIComponent(id)}/${tail}`;

async function* sseEvents(body: unknown, sessionId: string) {
  const res = await fetch(sessionUrl(sessionId, 'steps?stream=1'), {
    method: 'POST',
    headers: { ...headers(), Accept: 'text/event-stream' },
    body: JSON.stringify(body),
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

/** Resume a run parked on `step:awaiting`. */
const runControl = (sessionId: string, mode: string) =>
  fetch(sessionUrl(sessionId, 'run-control'), {
    method: 'POST', headers: headers(), body: JSON.stringify({ mode }),
  });

type RunOpts = {
  /** Steps to post; the source lines and test file path are filled in. */
  steps?: string[];
  /** A hand-built body instead, for shapes `steps` cannot express (sections). */
  body?: Record<string, unknown>;
  /** Extra top-level request fields (`stepMode`, `dataRow`, …). */
  extra?: Record<string, unknown>;
  /** Programme the mocked executor: `on` produces `outcome` (default tolerated). */
  on?: string;
  outcome?: Outcome;
  /** Take the SSE transport, collecting events instead of reading a JSON body. */
  stream?: boolean;
  /** Called per event while the stream is open — where an F10 resume goes. */
  onEvent?: (ev: any, sessionId: string) => unknown;
};

/** One run through the real HTTP entry: the only set-up a test here needs. */
async function run(o: RunOpts) {
  if (o.on) outcomes.set(o.on, o.outcome ?? 'tolerated');
  const payload = o.body ??
    { steps: o.steps!, sourceLines: o.steps!.map((_, i) => i + 3), testFilePath, ...o.extra };
  const sessionId = `outcomes-${++sessionSeq}-${Date.now()}`;
  const events: any[] = [];
  let body: any;
  if (o.stream) {
    for await (const ev of sseEvents(payload, sessionId)) {
      events.push(ev);
      await o.onEvent?.(ev, sessionId);
      if (ev.type === 'done') break;
    }
  } else {
    const res = await fetch(sessionUrl(sessionId, 'steps'), {
      method: 'POST', headers: headers(), body: JSON.stringify(payload),
    });
    body = await res.json();
  }
  return {
    sessionId, events, body,
    types: events.map((e) => e.type),
    /** The first `step:fail` — the event every outcome here is judged by. */
    fail: events.find((e) => e.type === 'step:fail'),
    /** The last event, which is `done` on every run that reached its end. */
    done: events.at(-1),
    rows: (body?.results ?? []) as any[],
    report: generatedReports.at(-1),
  };
}

/** Events of one type from `from` on (`from` = the index of the failure). */
const eventsOfKind = (events: any[], type: string, from = 0) =>
  events.slice(from).filter((e) => e.type === type);

const TOLERATED_STEP = 'Verify the footer shows the build number otherwise continue';
const FAIL_STEP =
  'If {{a}} is "peanuts" then fail the test with error "The variable value was peanuts. Expected apples"';

// ─────────────────────────────────────────────────────────────────────
describe('a tolerated failure', () => {
  const steps = ['Navigate to /', TOLERATED_STEP, 'Click "Sign out"'];

  it('emits step:fail with the flag and then STARTS the next step', async () => {
    const r = await run({ steps, on: TOLERATED_STEP, stream: true });
    const failAt = r.types.indexOf('step:fail');

    expect(failAt).toBeGreaterThan(-1);
    expect(r.events[failAt]).toMatchObject({ type: 'step:fail', line: 4, error: 'the build number was not there', tolerated: true });
    // The claim of the whole feature: a `step:start` AFTER the failure.
    expect(eventsOfKind(r.events, 'step:start', failAt)).toHaveLength(1);
    // The scope snapshot the other two outcomes emit is emitted here too.
    expect(eventsOfKind(r.events, 'frame:scope', failAt)).not.toHaveLength(0);
    expect(r.done).toMatchObject({ type: 'done', status: 'passed' });
  });

  it('carries the row as `failed` + `tolerated`, and counts it as executed', async () => {
    const r = await run({ steps, on: TOLERATED_STEP });

    expect(r.body.status).toBe('passed');
    expect(r.rows.map((x) => x.status)).toEqual(['passed', 'failed', 'passed']);
    // `status` stays `'failed'`: the flag alone tells the two apart (decision 9).
    expect(r.rows[1].tolerated).toBe(true);
    expect(r.rows[0].tolerated).toBeUndefined();
    expect(r.rows[2].tolerated).toBeUndefined();
    // It executed, so it counts (decision 6), and nothing stopped.
    expect(r.body.stepsCompleted).toBe(3);
    expect(r.body.stepsTotal).toBe(3);
    expect(r.body.error).toBeNull();
  });

  it('counts it on the report as tolerated, not as failed and not as passed', async () => {
    const { report } = await run({ steps, on: TOLERATED_STEP });

    expect(report.status).toBe('passed');
    expect(report.passedSteps).toBe(2);
    expect(report.failedSteps).toBe(0);
    expect(report.toleratedSteps).toBe(1);
  });

  it('carries the author`s warning on the event and on the row', async () => {
    // Decision 6: a field of its own, because `aiExplanation` — where it used to
    // live — never travels on `step:fail`. `error` stays the framework's account.
    const s = await run({ steps, on: TOLERATED_STEP, outcome: 'tolerated-warned', stream: true });
    expect(s.fail).toMatchObject({ tolerated: true, warning: 'Footer build number missing', error: 'the build number was not there' });

    const p = await run({ steps, on: TOLERATED_STEP, outcome: 'tolerated-warned' });
    expect(p.rows[1].warning).toBe('Footer build number missing');
    expect(p.rows[1].tolerated).toBe(true);
  });

  it('omits `warning` when the author wrote none', async () => {
    const s = await run({ steps, on: TOLERATED_STEP, stream: true });
    expect(s.fail.warning).toBeUndefined();

    const p = await run({ steps, on: TOLERATED_STEP });
    expect(p.rows[1].warning).toBeUndefined();
    expect(p.rows[0].warning).toBeUndefined();
  });

  it('pauses in step mode, like any other outcome the run continues past', async () => {
    // The pause used to sit INSIDE the `passed` branch, so one F10 onto a
    // tolerated step ran that step AND the next one.
    const order: string[] = [];
    const r = await run({
      steps, on: TOLERATED_STEP, stream: true, extra: { stepMode: 'into' },
      onEvent: async (ev, id) => {
        if (['step:start', 'step:fail', 'step:awaiting'].includes(ev.type)) order.push(`${ev.type}@${ev.line}`);
        if (ev.type === 'step:awaiting') await runControl(id, 'into');
      },
    });

    // Three steps → two pauses, the middle one AFTER the failure and BEFORE the
    // next start: `step:fail` then `step:start` back to back was the bug.
    expect(order).toEqual([
      'step:start@3', 'step:awaiting@4', 'step:start@4',
      'step:fail@4', 'step:awaiting@5', 'step:start@5',
    ]);
    expect(r.done).toMatchObject({ type: 'done', status: 'passed' });
  });

  it('hands the executor the tail for that step and no other', async () => {
    await run({ steps, on: TOLERATED_STEP });

    expect(seen.map((s) => s.opts.failureTail)).toEqual([
      undefined,
      { body: 'Verify the footer shows the build number', outcome: 'continue' },
      undefined,
    ]);
    // A tail is not a claim, and must never arrive as one.
    expect(seen[1]!.opts.flowControlClaim).toBeUndefined();
  });

  it('reads the tail through a `[no-hooks]` prefix', async () => {
    // `originalStep` still carries the marker where the loop parses it; the
    // parser normalises it away, exactly as `parseFlowControlStep` does.
    const marked = `[no-hooks] ${TOLERATED_STEP}`;
    const r = await run({ steps: ['Navigate to /', marked, 'Click "Sign out"'], on: marked });

    expect(seen[1]!.opts.failureTail).toEqual({ body: 'Verify the footer shows the build number', outcome: 'continue' });
    expect(r.body.status).toBe('passed');
    expect(r.rows[1].tolerated).toBe(true);
  });

  it('posts the RESOLVED tail message on the instruction, with the authored one on the tail', async () => {
    // Decision 3 at the loop's half of the seam: the tail is parsed off the
    // AUTHORED line, so its `message` keeps the braces and only the dispatched
    // instruction holds the resolved text. Both halves, because that is the pair
    // the executor needs (`resolvedTailMessage`).
    const line = 'Verify the footer shows the build number otherwise continue with warning "Missing build number for {{release}}"';
    const resolved = 'Verify the footer shows the build number otherwise continue with warning "Missing build number for 4.2.1"';
    const r = await run({
      steps: ['Set {{release}} to "4.2.1"', line, 'Click "Sign out"'],
      on: resolved, outcome: 'tolerated-warned',
    });

    const call = seen.find((s) => s.instruction.startsWith('Verify the footer'))!;
    expect(call.instruction).toBe(resolved);
    expect(call.opts.failureTail).toEqual({
      body: 'Verify the footer shows the build number',
      outcome: 'continue',
      message: 'Missing build number for {{release}}',
    });
    // …and the run carried on past it, so this really is the tolerated path.
    expect(r.body.status).toBe('passed');
  });

  it('leaves the history line for the next step to read', async () => {
    await run({ steps, on: TOLERATED_STEP });

    expect(seen[2]!.opts.conversationHistory ?? []).toContain(
      '[flow] step 2 failed and the run continued (otherwise continue)',
    );
  });

  it('keeps a looped section looping — the pass was not abandoned', async () => {
    const r = await run({
      on: 'Check the build number otherwise continue',
      body: {
        steps: ['Check each release'], sourceLines: [3], testFilePath,
        sections: {
          'check each release': {
            name: 'Check each release', headingLine: 5,
            steps: ['Open release {{tag}}', 'Check the build number otherwise continue'],
            stepLines: [9, 10], rows: [{ tag: 'v1' }, { tag: 'v2' }],
          },
        },
      },
    });

    // Two iterations of two steps. Without the tail the first iteration's
    // failure would have ended the run at row 1.
    expect(r.rows.map((x) => x.status)).toEqual(['passed', 'failed', 'passed', 'failed']);
    expect(r.rows[1].tolerated).toBe(true);
    expect(r.rows[3].tolerated).toBe(true);
    expect(r.body.status).toBe('passed');
    expect(r.body.stepsCompleted).toBe(4);
  });

  it('passes a data row whose only failure was tolerated', async () => {
    // A row batch writes NO report of its own — it joins the accumulator, and the
    // finalise POST produces one (data-driven-rows.md decision 12), so the row's
    // verdict is read off its response and the merged one off the finalise.
    const r = await run({
      steps, on: TOLERATED_STEP,
      extra: { dataRow: 1, dataRowCount: 1, dataRowValues: { email: 'a@b.c' } },
    });
    expect(r.body.status).toBe('passed');
    expect(generatedReports).toHaveLength(0);

    const res = await fetch(sessionUrl(r.sessionId, 'report'), {
      method: 'POST', headers: headers(), body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);

    // `mergeRowReports` keys `anyFailed` off each row's own `status` — the one
    // this loop computed — so the row passes and the merged count says how many
    // failures it tolerated (decision 6).
    const merged = generatedReports.at(-1)!;
    expect(merged.status).toBe('passed');
    expect(merged.failedSteps).toBe(0);
    expect(merged.toleratedSteps).toBe(1);
    expect(merged.rows?.[0]?.status).toBe('passed');
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('a deliberate failure', () => {
  const steps = ['Navigate to /', FAIL_STEP, 'Click "Sign out"'];

  it('ends the run with the author`s message, and no step starts after it', async () => {
    const r = await run({ steps, on: FAIL_STEP, outcome: 'deliberate', stream: true });
    const failAt = r.types.indexOf('step:fail');

    expect(r.events[failAt]).toMatchObject({ type: 'step:fail', error: 'The variable value was peanuts. Expected apples', deliberate: true });
    expect(r.events[failAt].tolerated).toBeUndefined();
    expect(eventsOfKind(r.events, 'step:start', failAt)).toHaveLength(0);
    expect(r.done).toMatchObject({ type: 'done', status: 'failed' });
  });

  it('reports the message on the response, and the row as a plain failure', async () => {
    const r = await run({ steps, on: FAIL_STEP, outcome: 'deliberate' });

    expect(r.body.status).toBe('failed');
    // The author's sentence, verbatim. (`error.step` is the raw loop index this
    // path has always reported — 0-based, unlike the refusal paths — and is not
    // this story's to change.)
    expect(r.body.error.message).toBe('The variable value was peanuts. Expected apples');
    expect(r.rows.map((x) => x.status)).toEqual(['passed', 'failed']);
    expect(r.rows[1].tolerated).toBeUndefined();
    expect(r.report.failedSteps).toBe(1);
    expect(r.report.toleratedSteps).toBeUndefined();
  });

  it('hands the executor the claim — which is what lets a `fail` action through', async () => {
    await run({ steps, on: FAIL_STEP, outcome: 'deliberate' });

    expect(seen[1]!.opts.flowControlClaim).toEqual({
      verb: 'fail', body: '{{a}} is "peanuts"',
      message: 'The variable value was peanuts. Expected apples',
    });
    expect(seen[1]!.opts.failureTail).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('the unconditional `Fail …`', () => {
  const bare = 'Fail the test with error "No balance was shown"';

  it('costs no model call and fails the run in the author`s words', async () => {
    const r = await run({ steps: ['Navigate to /', bare, 'Click "Sign out"'], stream: true });

    // One executor call: step 1. The `Fail` line never reached it (decision 3).
    expect(seen.map((s) => s.instruction)).toEqual(['Navigate to /']);
    expect(r.fail).toMatchObject({ type: 'step:fail', line: 4, error: 'No balance was shown', deliberate: true });
    expect(r.done).toMatchObject({ type: 'done', status: 'failed' });
  });

  it('never produces a `flowControl` record — that record means a PASS', async () => {
    const { report } = await run({ steps: ['Navigate to /', bare] });

    const row = report.steps.find((s: any) => s.status === 'failed');
    expect(row.flowControl).toBeUndefined();
    expect(row.deliberate).toBe(true);
    expect(row.aiExplanation).toBe('Failed by the step, as written — no model call.');
    expect(row.turns).toEqual([]);
  });

  it('takes a failure screenshot, as any other failed step does', async () => {
    const r = await run({ steps: ['Navigate to /', bare], stream: true });

    expect(captureScreenshot).toHaveBeenCalled();
    expect(r.fail.screenshot).toContain('fakeBase64');
  });

  // Decision 3: the message is the author's, resolved like any other step text.
  it.each([
    ['falls back to the framework`s wording when no message was written', 'Fail the test', 'Failed by the step, as written'],
    ['resolves `{{…}}` in the message, like any other step text', 'Fail the test with error "It was {{who}}"', 'It was peanuts'],
  ])('%s', async (_label, line, message) => {
    const r = await run({ steps: ['Set {{who}} to "peanuts"', line] });
    expect(r.body.error.message).toBe(message);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('the contradiction of decision 8', () => {
  // Refused by the loop, in one sentence that names the line back, with nothing
  // after it judged. The Sessions API is where this can actually arrive: steps
  // posted here pass no parse-time validator, so the backstop is all there is.
  it.each([
    ['is refused by the loop, with the one sentence and no model call', ['Navigate to /'], 'If the page is ready then return otherwise continue', ['Click "Sign out"']],
    ['refuses the `fail` shape of it too', [], 'If x then fail the test with error "m" otherwise continue', []],
  ])('%s', async (_label, before, line, after) => {
    const r = await run({ steps: [...before, line, ...after] });

    expect(r.body.status).toBe('failed');
    expect(r.body.error.message).toContain('a step cannot both end the flow and tolerate its own failure');
    expect(r.body.error.message).toContain(line);
    expect(seen.map((s) => s.instruction)).toEqual(before);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('a failure that is BOTH deliberate and tolerated', () => {
  // `step.fail('…')` by hand under `otherwise continue` (decisions 2 and 6): two
  // flags on one event, and the loop's tolerated branch — a second copy of the
  // emit — had to be told about `deliberate` separately, and was not. Row 2 is
  // the narrowness check: an ordinary tolerated failure must not acquire it.
  const BOTH_STEP = 'Fill the cart from the fixture otherwise continue';

  it.each([
    {
      label: 'emits step:fail carrying both flags, and the run carries on',
      step: BOTH_STEP, outcome: 'tolerated-deliberate' as const,
      expected: { line: 4, error: 'The cart was empty and this page needs it filled', tolerated: true, deliberate: true, fromCodeBehind: true },
    },
    {
      label: 'leaves an ordinary tolerated failure without the flag',
      step: TOLERATED_STEP, outcome: 'tolerated' as const,
      expected: { line: 4, error: 'the build number was not there', tolerated: true },
      noDeliberate: true,
    },
  ])('$label', async ({ step, outcome, expected, noDeliberate }) => {
    const r = await run({ steps: ['Navigate to /', step, 'Click "Sign out"'], on: step, outcome, stream: true });

    expect(r.fail).toMatchObject(expected);
    if (noDeliberate) expect(r.fail.deliberate).toBeUndefined();
    // Still tolerated in every other respect: the next step runs, and the run
    // is not red for it.
    expect(r.done).toMatchObject({ type: 'done', status: 'passed' });
  });
});

// ─────────────────────────────────────────────────────────────────────
/**
 * The scope frame emitted BESIDE a failure
 * (docs/specs/SPEC-structured-table-reads.md §7.6, §8.4).
 *
 * `frame:scope` is emitted from three places in the step loop — after a pass,
 * after a tolerated failure, and after a plain one — and each builds its own
 * payload with its own `...scopeMasking()`. Only the first was under test:
 * `api-server-control-flow.test.ts` runs no failing step, so deleting the
 * spread from either of the other two left every api-server suite green while
 * the client lost the one field that tells `order.id` (this pass bound it)
 * from `user.apikey` (the author typed it) — and the Variables panel falls
 * back to the two-segment rule, printing a bound secret or starring a bound
 * `keyword`.
 *
 * A failure is where that matters most, because it is the scope the user is
 * actually reading. So both sites get a run of their own, over a loop, so the
 * list is non-empty and a dropped field cannot pass as "nothing bound".
 */
describe('the scope frame beside a failure says whose the dotted names are', () => {
  const ORDERS = '[{"id":"A","status":"x"}]';

  /** One pass of a `For each`, whose single body step is `bodyStep`. */
  const loopBody = (bodyStep: string) => ({
    steps: ['Open the orders page', 'For each {{order}} in {{orders}}, Check the order'],
    sourceLines: [3, 4],
    testFilePath,
    parameters: { orders: ORDERS },
    sections: {
      'check the order': {
        name: 'Check the order',
        headingLine: 6,
        steps: [bodyStep],
        stepLines: [7],
      },
    },
  });

  it.each([
    {
      label: 'after a TOLERATED failure — the run carries on past it',
      authored: 'Verify the row for "{{order.id}}" otherwise continue',
      resolved: 'Verify the row for "A" otherwise continue',
      outcome: 'tolerated' as const,
      status: 'passed',
    },
    {
      label: 'after a PLAIN failure — the run stops on it',
      authored: 'Verify the row for "{{order.id}}"',
      resolved: 'Verify the row for "A"',
      outcome: 'failed' as const,
      status: 'failed',
    },
  ])('$label', async ({ authored, resolved, outcome, status }) => {
    const r = await run({
      body: loopBody(authored),
      on: resolved,
      outcome,
      stream: true,
    });

    expect(r.fail).toBeDefined();
    const failAt = r.types.indexOf('step:fail');
    const beside = r.events.slice(failAt).find((e) => e.type === 'frame:scope');

    // The field is unconditional — `[]` included — so the client can tell
    // "nothing bound" from "nothing said". Absent is what an older server
    // sends, and is the state a dropped spread puts this one back into.
    expect(beside).toBeDefined();
    expect(Array.isArray(beside!.bindings)).toBe(true);
    // …and it is this pass's dotted names, not an empty list that would have
    // passed the `isArray` check by accident.
    expect(beside!.bindings).toEqual(['order.id', 'order.status']);
    expect(beside!.scope['order.id']).toBe('A');

    // The last one too: on the plain failure the loop `break`s here, so this
    // IS the scope the user is left looking at.
    const scopes = r.events.filter((e) => e.type === 'frame:scope');
    expect(Array.isArray(scopes.at(-1)!.bindings)).toBe(true);

    expect(r.done).toMatchObject({ type: 'done', status });
  });
});

/**
 * `POST /codebehind/compile` — the server wrapped around the compile core
 * (stories/codebehind-compile.md §Server).
 *
 * Everything here is driven over real HTTP through the real app, because every
 * claim this endpoint makes is about a seam that a unit test cannot see. The
 * request builder is an explicit allow-list (`parseCompileRequest`), so
 * widening `CompileRequest` alone compiles cleanly and drops the field at
 * runtime — which is how `envName` was lost once on the sibling route. The 409
 * has to be answered *before* `flushHeaders`, so it only exists as a status
 * code on the wire. And the result is the last SSE frame rather than a response
 * body, so "did the files come back?" is a question about the stream.
 *
 * The compile core itself is mocked. What is under test is the server around
 * it — which project it resolves, which options it hands over, what it puts on
 * the wire — and the core has its own suite (codebehind-compile.test.ts) for
 * the pipeline's decisions. Mocking it is also what keeps this file off the AI
 * and off a browser: Record and Replay are driven by a `runner` the core calls,
 * so a core that never runs never launches anything. The browser and step
 * mocks below THROW rather than fake, so a path that did reach a real run fails
 * loudly instead of quietly passing on a stub.
 *
 * The project is real, though: a temp directory with its own
 * `aiui.config.json`, `.env.staging` and markdown, parsed by the real parser
 * from disk. That is the only way `envName` and the project bundle can be
 * observed reaching the core at all.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Express } from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';
import type { CompileOptions, CompileResult } from '../src/codebehind/compile.js';

// ---------------------------------------------------------------------------
// The compile core, faked at the one function the server calls
// ---------------------------------------------------------------------------

/**
 * What the fake core saw, and a hook to hold it open.
 *
 * `vi.hoisted` because the mock factory below is lifted above every import and
 * cannot close over an ordinary module-level binding.
 */
const core = vi.hoisted(() => ({
  /** Every `compileTest` options object, in order. */
  calls: [] as CompileOptions[],
  /**
   * Awaited inside the fake core between its progress events and its result.
   * The lock tests park one compile here so a second request lands while the
   * first is genuinely still running — which is the only state the 409 has.
   */
  hold: null as null | ((options: CompileOptions) => Promise<void> | void),
}));

vi.mock('../src/codebehind/compile.js', async (importOriginal) => ({
  // The real module underneath: the server also imports `firstDataRow` from
  // it, and a mock that drops it turns every compile into an error frame.
  ...(await importOriginal<typeof import('../src/codebehind/compile.js')>()),
  compileTest: vi.fn(async (options: CompileOptions): Promise<CompileResult> => {
    core.calls.push(options);
    options.onEvent?.({ kind: 'phase', phase: 'record', message: 'Recording the test' });
    options.onEvent?.({ kind: 'step', phase: 'generate', step: 1, line: 11, message: 'Step 1: generated' });
    options.onEvent?.({ kind: 'phase', phase: 'replay', round: 2, message: 'Replay round 2' });
    await core.hold?.(options);
    options.onEvent?.({ kind: 'done', status: 'green', message: 'Compiled 1 step' });
    return {
      status: 'green',
      files: {
        [options.test.filePath.replace(/\.md$/, '.steps.ts')]: 'export default { entries: [] };',
      },
      summary: {
        test: options.test.filePath,
        // Read off the test the server parsed, so a summary that came back
        // whole is also evidence the file reached the core.
        totalSteps: options.test.steps.length,
        compiled: 1,
        kept: 2,
        keptAi: 0,
        rounds: 2,
        tokensUsed: 4242,
        written: [],
        unproven: [],
        writtenOffAi: [],
        notAttempted: [],
        recordingDir: '/x/.aiui-codebehind-cache/smoke.recording',
      },
    };
  }),
}));

// ---------------------------------------------------------------------------
// Mocks — mirrors the sibling api-server suites, so no real browser or AI
// ---------------------------------------------------------------------------

vi.mock('../src/browser/manager.js', () => ({
  // A guard, not a fake. No test here should reach a run at all; if one does,
  // this says so instead of letting a stub browser make it look fine.
  launchBrowser: vi.fn(async () => {
    throw new Error('a compile test tried to launch a browser');
  }),
  closeBrowser: vi.fn(async () => {}),
  PageTracker: vi.fn(),
  BrowserTracker: vi.fn(),
  briefly: async (p: Promise<unknown>, ms: number, fallback: unknown) =>
    Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]),
  resolveVideoMode: vi.fn(() => 'off'),
  finalizeMainPageVideo: vi.fn(async () => undefined),
}));

vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: vi.fn(async () => {
    throw new Error('a compile test tried to execute a step');
  }),
  executeBranchedStep: vi.fn(async () => {
    throw new Error('a compile test tried to execute a branched step');
  }),
}));

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: vi.fn(async () => ({ files: [], combined: 'CONTEXT FROM THE PROJECT' })),
}));

vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    config: { model: string; apiKey?: string | undefined };
    constructor(config: { model: string; apiKey?: string | undefined }) {
      this.config = config;
    }
    chat = vi.fn(async () => '{}');
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

vi.mock('../src/report/generator.js', () => ({
  generateReport: vi.fn(async () => '/tmp/fake-report.html'),
  getPrimaryModel: vi.fn(() => 'mock-model'),
  buildReportBaseName: vi.fn((r: { testName: string }) => r.testName),
}));

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

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { createApiServer } from '../src/server/api-server.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { compileTest } from '../src/codebehind/compile.js';
import type { SessionManager } from '../src/server/session-manager.js';

const compileTestMock = vi.mocked(compileTest);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const API_KEY = 'compile-api-key';
/** Differs from the project's, so `config` arriving at the core with the
 *  project's value can only have come through the project bundle. */
const SERVER_MAX_TURNS = 15;
const PROJECT_MAX_TURNS = 7;

const testConfig: Config = {
  ...DEFAULT_CONFIG,
  ai: { ...DEFAULT_CONFIG.ai, model: 'server/base-model', apiKey: 'server-ai-key' },
  browser: { ...DEFAULT_CONFIG.browser, headed: false },
  execution: { ...DEFAULT_CONFIG.execution, maxTurns: SERVER_MAX_TURNS },
  server: { ...DEFAULT_CONFIG.server, host: '127.0.0.1', port: 0, apiKey: API_KEY },
  logging: { ...DEFAULT_CONFIG.logging, consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
};

/**
 * The test on disk. Three steps, and a parameter that only resolves when an
 * env is named — `${env.X}` is left as written when no env bundle is in play,
 * so the same file reads differently with and without `envName` and the
 * difference is visible in the options the core receives.
 */
const SMOKE_MD = [
  '---',
  'tags: [compile-fixture]',
  '---',
  '',
  '# Smoke',
  '',
  '## Parameters',
  '- stage: ${env.COMPILE_FIXTURE_STAGE}',
  '',
  '## Steps',
  '1. Open the dashboard',
  '2. Search for the order',
  '3. Check the total',
  '',
].join('\n');

/** A second test in the same project, for the "different file" half of the lock. */
const OTHER_MD = [
  '# Other',
  '',
  '## Steps',
  '1. Open the settings page',
  '2. Save the form',
  '',
].join('\n');

let server: Server;
let baseUrl: string;
let sessionManager: SessionManager;
let projectRoot: string;

function testFile(name: string): string {
  return path.join(projectRoot, 'tests', name);
}

async function listenOnRandomPort(app: Express): Promise<{ server: Server; baseUrl: string }> {
  const started = createServer(app);
  await new Promise<void>((resolve) => { started.listen(0, '127.0.0.1', () => resolve()); });
  const addr = started.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { server: started, baseUrl: `http://127.0.0.1:${port}` };
}

/** POST the compile route. Always streaming — the endpoint has no other mode. */
async function postCompile(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/codebehind/compile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  });
}

/** Read SSE frames into {event, data} pairs. */
async function readSse(res: Response): Promise<{ event: string; data: any }[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events: { event: string; data: any }[] = [];
  let currentEvent = 'message';
  let currentData: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line === '') {
        if (currentData.length > 0) {
          try {
            events.push({ event: currentEvent, data: JSON.parse(currentData.join('\n')) });
          } catch {
            events.push({ event: currentEvent, data: currentData.join('\n') });
          }
        }
        currentEvent = 'message';
        currentData = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = (colon < 0 ? '' : line.slice(colon + 1)).replace(/^ /, '');
      if (field === 'event') currentEvent = value;
      else if (field === 'data') currentData.push(value);
    }
  }
  return events;
}

/** Run a compile to completion and hand back its frames. */
async function compileStream(body: Record<string, unknown>): Promise<{ event: string; data: any }[]> {
  const res = await postCompile(body);
  // Read the body only when there is no stream to read: consuming it to build
  // a nicer message would lock the stream on the success path.
  if (res.status !== 200) expect(res.status, await describeRefusal(res)).toBe(200);
  return readSse(res);
}

/** A refused compile, which is JSON rather than a stream. */
async function refusal(body: unknown): Promise<{ status: number; error: string }> {
  const res = await postCompile(body);
  const parsed = (await res.json()) as { error?: unknown };
  return { status: res.status, error: String(parsed.error) };
}

/** Only reached when a compile that should have streamed did not. */
async function describeRefusal(res: Response): Promise<string> {
  try {
    return JSON.stringify(await res.json());
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** The options the Nth (0-based) compile handed the core. */
function optionsAt(call: number): CompileOptions {
  const options = core.calls[call];
  expect(options, `no compileTest call #${call}`).toBeDefined();
  return options!;
}

/** Every `output` frame in a stream, which is where the compiler explains itself. */
function outputs(events: { event: string; data: any }[]): { kind: string; msg: string }[] {
  return events.filter((e) => e.event === 'output').map((e) => ({ kind: e.data.kind, msg: e.data.msg }));
}

/**
 * Hold the next compile of `file` open until `release` is called.
 *
 * Parked inside the core rather than before it, so the file is already in the
 * compiler's in-flight set and a second request sees a compile that is really
 * running. Compiles of any other file run straight through.
 */
function holdCompile(file: string): { entered: Promise<void>; release: () => void } {
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  core.hold = async (options) => {
    if (options.test.filePath !== file) return;
    markEntered();
    await gate;
  };
  return { entered, release };
}

/** A step result from a run that captured page context — compile's Record input. */
function stepWithContext(index: number): StepResult {
  return {
    index,
    instruction: `step ${index}`,
    status: 'passed',
    turns: [],
    durationMs: 1,
    retried: false,
    stepContext: {
      domBefore: '<html><body><h1>Orders</h1></body></html>',
      urlBefore: 'https://shop.test/orders',
    },
  };
}

/**
 * Stand in for the session machinery: play a scripted run into the listener
 * and hand the core the step records. `executeSteps` is the one seam the
 * compile runner drives, and the browser mock above throws, so a test that
 * wants a run to happen has to fake it here.
 */
function fakeRun(
  steps: StepResult[],
  status: 'passed' | 'failed' = 'passed',
): MockInstance {
  return vi.spyOn(sessionManager, 'executeSteps').mockImplementation(
    async (sessionId, request, onEvent, _signal, internal) => {
      for (const step of steps) {
        const line = request.sourceLines?.[step.index - 1] ?? step.index;
        onEvent?.({ type: 'step:start', line });
        onEvent?.(
          step.status === 'passed'
            ? { type: 'step:pass', line, ...(step.fromCodeBehind && { fromCodeBehind: true }) }
            : { type: 'step:fail', line, error: step.error ?? 'failed' },
        );
      }
      onEvent?.({ type: 'done', status });
      internal?.onRunDetails?.({ steps, parameters: {}, tokens: 7 });
      return {
        sessionId,
        status,
        stepsCompleted: steps.length,
        stepsTotal: request.steps.length,
        results: [],
        outputs: {},
        outputSources: {},
      };
    },
  );
}

beforeAll(async () => {
  const created = createApiServer(testConfig);
  sessionManager = created.sessionManager;
  ({ server, baseUrl } = await listenOnRandomPort(created.app));
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

beforeEach(() => {
  // A fresh project per test, so the bundle resolver's per-root cache never
  // carries one test's config or `.env` into the next.
  projectRoot = mkdtempSync(path.join(tmpdir(), 'aiui-compile-'));
  mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
  writeFileSync(
    path.join(projectRoot, 'aiui.config.json'),
    JSON.stringify({ execution: { maxTurns: PROJECT_MAX_TURNS } }),
  );
  writeFileSync(path.join(projectRoot, '.env'), 'COMPILE_FIXTURE_USER=alice\n');
  writeFileSync(
    path.join(projectRoot, '.env.staging'),
    'COMPILE_FIXTURE_STAGE=staging\nCOMPILE_FIXTURE_USER=staging-alice\n',
  );
  writeFileSync(testFile('smoke.md'), SMOKE_MD);
  writeFileSync(testFile('other.md'), OTHER_MD);

  core.calls.length = 0;
  core.hold = null;
  compileTestMock.mockClear();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('the compile stream', () => {
  it('streams the phases in order and ends with the proposed files and the summary', async () => {
    const all = await compileStream({ testFilePath: testFile('smoke.md') });
    // The server's own narration (where the recording goes) rides `output`
    // frames ahead of the core's phases; the order under test is the core's.
    const events = all.filter((e) => e.event !== 'output');

    expect(events.map((e) => e.event)).toEqual([
      'compile:phase',
      'compile:step',
      'compile:phase',
      'compile:done',
      'compile:result',
    ]);
    // The frame name and the `type` inside it have to agree: clients switch on
    // `type` after subscribing by event name, so a mismatch is a message no
    // reader can route.
    for (const event of events) expect(event.data.type).toBe(event.event);

    expect(events[0]!.data).toEqual({
      type: 'compile:phase',
      phase: 'record',
      message: 'Recording the test',
    });
    // `line` rides along for the gutter's ▶ — and, like `round`, is spread
    // conditionally on the way to the wire.
    expect(events[1]!.data).toEqual({
      type: 'compile:step',
      phase: 'generate',
      step: 1,
      line: 11,
      message: 'Step 1: generated',
    });
    // `round` is spread conditionally on the way to the wire, which is exactly
    // the shape that loses a field silently.
    expect(events[2]!.data).toEqual({
      type: 'compile:phase',
      phase: 'replay',
      round: 2,
      message: 'Replay round 2',
    });
    expect(events[3]!.data).toEqual({
      type: 'compile:done',
      status: 'green',
      message: 'Compiled 1 step',
    });

    const result = events[4]!.data;
    expect(result.status).toBe('green');
    // The files ride the stream instead of being written, so this frame is the
    // only place TestBench can get them from.
    expect(result.files).toEqual({
      [testFile('smoke.steps.ts')]: 'export default { entries: [] };',
    });
    expect(result.summary).toEqual({
      test: testFile('smoke.md'),
      totalSteps: 3,
      compiled: 1,
      kept: 2,
      keptAi: 0,
      rounds: 2,
      tokensUsed: 4242,
      written: [],
      unproven: [],
      writtenOffAi: [],
      notAttempted: [],
      recordingDir: '/x/.aiui-codebehind-cache/smoke.recording',
    });
  });

  it('parses the file from disk and says so when the editor sent a different step count', async () => {
    // The buffer-vs-disk guard, and the proof that `steps` survives the
    // allow-list: the warning can only be worded from what the editor sent.
    const events = await compileStream({
      testFilePath: testFile('smoke.md'),
      steps: ['Open the dashboard'],
    });

    const warnings = outputs(events).filter((o) => o.kind === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.msg).toContain('sent 1 step(s)');
    expect(warnings[0]!.msg).toContain('smoke.md has 3 on disk');

    // And the compile ran on the file, not on the buffer.
    expect(optionsAt(0).test.steps).toEqual([
      'Open the dashboard',
      'Search for the order',
      'Check the total',
    ]);
  });
});

describe('one compile per test file', () => {
  it('409s a second compile of the same file while the first is still running', async () => {
    const gate = holdCompile(testFile('smoke.md'));
    const first = await postCompile({ testFilePath: testFile('smoke.md') });
    expect(first.status).toBe(200);

    try {
      await gate.entered;

      const second = await refusal({ testFilePath: testFile('smoke.md') });
      // A status code, not a frame: the answer has to be decided before the
      // first byte of the stream, because after `flushHeaders` every outcome
      // is a 200.
      expect(second.status).toBe(409);
      expect(second.error).toContain('smoke.md');
      expect(second.error).toContain('already running');
      // The refusal really did refuse — the core was entered once, not twice.
      expect(compileTestMock).toHaveBeenCalledTimes(1);
    } finally {
      // A parked compile outlives a failed assertion and would hold the file
      // — and the socket — for every test after it.
      gate.release();
    }

    const events = await readSse(first);
    expect(events.at(-1)!.event).toBe('compile:result');

    // And the lock is released with the compile, so the same file compiles again.
    const again = await compileStream({ testFilePath: testFile('smoke.md') });
    expect(again.at(-1)!.data.status).toBe('green');
  });

  it('lets a compile of a DIFFERENT file run at the same time', async () => {
    // The lock is per test file, not a server-wide one: two authors compiling
    // two tests is the ordinary case, and a global lock would make one of them
    // wait for minutes of somebody else's work.
    const gate = holdCompile(testFile('smoke.md'));
    const held = await postCompile({ testFilePath: testFile('smoke.md') });
    expect(held.status).toBe(200);

    try {
      await gate.entered;

      const other = await compileStream({ testFilePath: testFile('other.md') });
      expect(other.map((e) => e.event)).toContain('compile:result');
      expect(other.at(-1)!.data.summary.test).toBe(testFile('other.md'));
      expect(other.at(-1)!.data.summary.totalSteps).toBe(2);
    } finally {
      gate.release();
    }

    const events = await readSse(held);
    expect(events.at(-1)!.data.summary.test).toBe(testFile('smoke.md'));
  });
});

describe('recording in the caller\'s session', () => {
  /** A green mocked core that drives one Record through the runner. */
  const recordOnce = (): void => {
    compileTestMock.mockImplementationOnce(async (options) => {
      core.calls.push(options);
      const outcome = await options.runner!({ purpose: 'record', parameters: {}, strict: false, captureContext: true });
      expect(outcome.status).toBe('passed');
      options.onEvent?.({ kind: 'done', status: 'green', message: 'Compiled' });
      return {
        status: 'green',
        files: {},
        summary: {
          test: options.test.filePath, totalSteps: 3, compiled: 0, kept: 3, keptAi: 0, rounds: 0,
          tokensUsed: 0, written: [], unproven: [], writtenOffAi: [], notAttempted: [],
          recordingDir: '/x/.aiui-codebehind-cache/smoke.recording',
        },
      };
    });
  };

  it('records in that session every time, and leaves it open', async () => {
    // stories/codebehind-recording-on-disk.md: no run is reused. The Record
    // happens IN the caller's session — the browser they watch — with the
    // capture on, and the session is not closed afterwards.
    const run = fakeRun([stepWithContext(1), stepWithContext(2), stepWithContext(3)]);
    const close = vi.spyOn(sessionManager, 'closeSession');
    recordOnce();

    const events = await compileStream({
      testFilePath: testFile('smoke.md'),
      sessionId: 'editor-session',
    });

    expect(optionsAt(0).recorded).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
    const [sessionId, request, , , internal] = run.mock.calls[0]!;
    expect(sessionId).toBe('editor-session');
    expect(request.captureStepContext).toBe(true);
    expect(request.cacheEnabled).toBe(testConfig.cache.enabled);
    expect(request.config).toBeDefined();
    expect(internal?.codeBehind?.disabled).toBeUndefined();
    expect(internal?.codeBehind?.strict).toBe(false);
    expect(close).not.toHaveBeenCalledWith('editor-session');
    // The stream says where the recording goes, before anything runs.
    expect(outputs(events).map((o) => o.msg)).toContainEqual(
      expect.stringMatching(/^Recording to .*smoke\.recording$/),
    );
    expect(outputs(events)).toContainEqual({ kind: 'info', msg: 'Recording in session editor-session (opening it).' });
    run.mockRestore();
    close.mockRestore();
  });

  it('keeps nothing of a run on the session — there is no last run to reuse', () => {
    expect((sessionManager as unknown as { lastRunDetails?: unknown }).lastRunDetails).toBeUndefined();
  });

  it('streams every event of a Record and a Replay inside compile:run, with the round', async () => {
    const run = fakeRun([
      { ...stepWithContext(1), fromCodeBehind: true },
      { ...stepWithContext(2), status: 'failed', error: 'locator timeout' },
    ], 'failed');
    const close = vi.spyOn(sessionManager, 'closeSession').mockResolvedValue(undefined);
    compileTestMock.mockImplementationOnce(async (options) => {
      core.calls.push(options);
      await options.runner!({ purpose: 'record', parameters: {}, strict: false, captureContext: true });
      await options.runner!({
        purpose: 'replay', parameters: {}, round: 2, strict: true, captureContext: false, throughStep: 2,
      });
      options.onEvent?.({ kind: 'done', status: 'partial', message: 'Compiled some' });
      return {
        status: 'partial',
        files: {},
        summary: {
          test: options.test.filePath, totalSteps: 3, compiled: 1, kept: 0, keptAi: 1, rounds: 2,
          tokensUsed: 0, written: [], unproven: [], writtenOffAi: [2], notAttempted: [],
          recordingDir: '/x/.aiui-codebehind-cache/smoke.recording',
        },
      };
    });

    const events = await compileStream({
      testFilePath: testFile('smoke.md'),
      sessionId: 'editor-session',
    });

    const runs = events.filter((e) => e.event === 'compile:run').map((e) => e.data);
    expect(runs.map((r) => [r.phase, r.round, r.event.type])).toEqual([
      ['record', undefined, 'step:start'],
      ['record', undefined, 'step:pass'],
      ['record', undefined, 'step:start'],
      ['record', undefined, 'step:fail'],
      ['record', undefined, 'done'],
      ['replay', 2, 'step:start'],
      ['replay', 2, 'step:pass'],
      ['replay', 2, 'step:start'],
      ['replay', 2, 'step:fail'],
      ['replay', 2, 'done'],
    ]);
    expect(runs[1]!.event).toEqual({ type: 'step:pass', line: 11, fromCodeBehind: true });
    expect(runs[3]!.event).toEqual({ type: 'step:fail', line: 12, error: 'locator timeout' });
    // The replay ran the prefix it was asked for, in a session of its own that
    // was closed after; the Record's session — the caller's — was not.
    const replay = run.mock.calls[1]!;
    expect(replay[0]).toMatch(/^compile:/);
    expect(replay[1].steps).toHaveLength(2);
    expect(replay[1].sourceLines).toEqual([11, 12]);
    expect(replay[1].cacheEnabled).toBe(false);
    expect(replay[1].captureStepContext).toBe(false);
    expect(replay[4]?.codeBehind?.strict).toBe(true);
    expect(close).toHaveBeenCalledWith(replay[0]);
    expect(close).not.toHaveBeenCalledWith('editor-session');
    expect(events.at(-1)!.data.status).toBe('partial');
    expect(events.at(-1)!.data.summary.writtenOffAi).toEqual([2]);
    expect(events.at(-1)!.data.summary.recordingDir).toBe('/x/.aiui-codebehind-cache/smoke.recording');
    run.mockRestore();
    close.mockRestore();
  });

  it('refuses to record in a session with a run in flight', async () => {
    const status = vi.spyOn(sessionManager, 'sessionStatus').mockReturnValue('executing');
    const run = vi.spyOn(sessionManager, 'executeSteps');
    compileTestMock.mockImplementationOnce(async (options) => {
      core.calls.push(options);
      return options.runner!({ purpose: 'record', parameters: {}, strict: false, captureContext: true }).then(
        () => { throw new Error('the runner should have refused'); },
      );
    });

    const events = await compileStream({
      testFilePath: testFile('smoke.md'),
      sessionId: 'busy-session',
    });

    expect(run).not.toHaveBeenCalled();
    const error = outputs(events).find((o) => o.kind === 'error');
    expect(error?.msg).toContain('busy-session is busy');
    expect(events.at(-1)!.data.status).toBe('failed');
    status.mockRestore();
    run.mockRestore();
  });

  it('records in a session of its own when no session is named', async () => {
    const run = fakeRun([stepWithContext(1), stepWithContext(2), stepWithContext(3)]);
    const close = vi.spyOn(sessionManager, 'closeSession').mockResolvedValue(undefined);
    recordOnce();

    await compileStream({ testFilePath: testFile('smoke.md') });

    const [sessionId, request] = run.mock.calls[0]!;
    expect(sessionId).toMatch(/^compile:/);
    expect(request.cacheEnabled).toBe(false);
    expect(request.captureStepContext).toBe(true);
    expect(close).toHaveBeenCalledWith(sessionId);
    run.mockRestore();
    close.mockRestore();
  });
});

describe('the parameters a compile\'s runs start from', () => {
  // Caught live (stories/codebehind-compile-as-a-run.md §What was built): a
  // test declaring `- username: $GITHUB_USERNAME` ran green from TestBench and
  // compiled with the literal typed into the field. TestBench resolves `$VAR`
  // on the client; the compile builds its own runs on the server, so the
  // server has to hand the core the env a Run would have resolved against.

  it('hands the core the project\'s base .env when no env is named', async () => {
    await compileStream({ testFilePath: testFile('smoke.md') });
    const env = optionsAt(0).env!;
    expect(env.COMPILE_FIXTURE_USER).toBe('alice');
    // The process baseline is underneath it, as in the bundle's composition.
    expect(env.PATH ?? env.Path).toBeDefined();
  });

  it('takes the nearest .env above the test file, as TestBench does, not only the root one', async () => {
    // TestBench walks up from the test file and stops at the first `.env`; a
    // server that read only `<projectRoot>/.env` would resolve a different
    // value than the Run the author just watched.
    writeFileSync(path.join(projectRoot, 'tests', '.env'), 'COMPILE_FIXTURE_USER=nearer-alice\n');
    const events = await compileStream({ testFilePath: testFile('smoke.md') });
    expect(optionsAt(0).env!.COMPILE_FIXTURE_USER).toBe('nearer-alice');
    // And it says so, since that file is not beside the project's config.
    expect(outputs(events).map((o) => o.msg)).toContainEqual(
      expect.stringMatching(/^\$VAR parameters resolve from .*tests[\\/]\.env \(not beside/),
    );
  });

  it('hands the core the named env\'s composed map, which overrides the base .env', async () => {
    await compileStream({ testFilePath: testFile('smoke.md'), envName: 'staging' });
    const env = optionsAt(0).env!;
    expect(env.COMPILE_FIXTURE_USER).toBe('staging-alice');
    expect(env.COMPILE_FIXTURE_STAGE).toBe('staging');
  });

  it('starts each run from the map the core resolved, not the parsed test\'s raw values', async () => {
    const run = fakeRun([stepWithContext(1), stepWithContext(2), stepWithContext(3)]);
    const close = vi.spyOn(sessionManager, 'closeSession').mockResolvedValue(undefined);
    compileTestMock.mockImplementationOnce(async (options) => {
      core.calls.push(options);
      await options.runner!({
        purpose: 'record', parameters: { username: 'alice', stage: 'x' }, strict: false, captureContext: true,
      });
      options.onEvent?.({ kind: 'done', status: 'green', message: 'Compiled' });
      return {
        status: 'green', files: {},
        summary: {
          test: options.test.filePath, totalSteps: 3, compiled: 0, kept: 3, keptAi: 0, rounds: 0,
          tokensUsed: 0, written: [], unproven: [], writtenOffAi: [], notAttempted: [],
          recordingDir: '/x/.aiui-codebehind-cache/smoke.recording',
        },
      };
    });

    await compileStream({ testFilePath: testFile('smoke.md') });

    const [, request] = run.mock.calls[0]!;
    expect(request.parameters).toEqual({ username: 'alice', stage: 'x' });
    run.mockRestore();
    close.mockRestore();
  });

  it('carries a note from the core as an output frame', async () => {
    compileTestMock.mockImplementationOnce(async (options) => {
      core.calls.push(options);
      options.onEvent?.({
        kind: 'note', level: 'warn',
        message: 'parameter "username" is $GITHUB_USERNAME and nothing in the environment defines it',
      });
      options.onEvent?.({ kind: 'done', status: 'green', message: 'Compiled' });
      return {
        status: 'green', files: {},
        summary: {
          test: options.test.filePath, totalSteps: 3, compiled: 0, kept: 3, keptAi: 0, rounds: 0,
          tokensUsed: 0, written: [], unproven: [], writtenOffAi: [], notAttempted: [],
          recordingDir: '/x/.aiui-codebehind-cache/smoke.recording',
        },
      };
    });

    const events = await compileStream({ testFilePath: testFile('smoke.md') });
    expect(outputs(events)).toContainEqual({
      kind: 'warn',
      msg: 'parameter "username" is $GITHUB_USERNAME and nothing in the environment defines it',
    });
  });

  it('hands the core the first row of a data-driven test, and says which', async () => {
    writeFileSync(
      path.join(projectRoot, 'tests', 'rows.json'),
      JSON.stringify([{ username: 'row-one' }, { username: 'row-two' }, { username: 'row-three' }]),
    );
    writeFileSync(
      testFile('rows.md'),
      ['---', 'dataFile: tests/rows.json', '---', '', '# Rows', '', '## Parameters', '- username: {{username}}', '', '## Steps', '1. Log in', ''].join('\n'),
    );

    const events = await compileStream({ testFilePath: testFile('rows.md') });

    expect(optionsAt(0).dataRow).toEqual({ username: 'row-one' });
    expect(outputs(events)).toContainEqual({
      kind: 'info',
      msg: 'Data file tests/rows.json: compiling with row 1 of 3.',
    });
  });
});

describe('the request allow-list', () => {
  it('carries select, maxRounds and the named env through to the core', async () => {
    // The control first: with no env named there is no bundle, so the
    // parameter arrives at the core exactly as it was written.
    await compileStream({ testFilePath: testFile('smoke.md') });
    expect(optionsAt(0).test.parameters.stage).toBe('${env.COMPILE_FIXTURE_STAGE}');
    expect(optionsAt(0).select).toBeUndefined();
    expect(optionsAt(0).maxRounds).toBeUndefined();

    await compileStream({
      testFilePath: testFile('smoke.md'),
      envName: 'staging',
      select: { steps: [1, 3] },
      maxRounds: 5,
    });

    const options = optionsAt(1);
    expect(options.select).toEqual({ steps: [1, 3] });
    expect(options.maxRounds).toBe(5);
    // `envName` never reaches the core as a field — it picks the env bundle,
    // which the parser then interpolates into the test. This value is the only
    // evidence on the far side that the name survived the trip.
    expect(options.test.parameters.stage).toBe('staging');
    // And the config the core compiles against is the project's, resolved from
    // the test file's own root, not the server's startup config.
    expect(options.config.execution.maxTurns).toBe(PROJECT_MAX_TURNS);
    expect(testConfig.execution.maxTurns).toBe(SERVER_MAX_TURNS);
  });

  it('carries each select mode through as the caller sent it', async () => {
    await compileStream({ testFilePath: testFile('smoke.md'), select: { onlyStale: true } });
    expect(optionsAt(0).select).toEqual({ onlyStale: true });

    await compileStream({ testFilePath: testFile('smoke.md'), select: { all: true } });
    expect(optionsAt(1).select).toEqual({ all: true });
  });

  it('ignores a field it does not know about rather than refusing', async () => {
    // The allow-list drops what it does not recognise, which is what makes a
    // newer client safe against an older server.
    const events = await compileStream({
      testFilePath: testFile('smoke.md'),
      thereIsNoSuchOption: 'nonsense',
    });

    expect(events.at(-1)!.data.status).toBe('green');
    expect(Object.keys(optionsAt(0))).not.toContain('thereIsNoSuchOption');
  });

  it('400s a missing or relative testFilePath', async () => {
    const missing = await refusal({ select: { all: true } });
    expect(missing.status).toBe(400);
    expect(missing.error).toContain('testFilePath');

    // The server resolves the project by walking up from this path, so a
    // relative one would resolve against the SERVER's cwd — a different
    // project, silently.
    const relative = await refusal({ testFilePath: 'tests/smoke.md' });
    expect(relative.status).toBe(400);
    expect(relative.error).toContain('absolute');

    expect(compileTestMock).not.toHaveBeenCalled();
  });

  it('400s a select.steps entry that is not a 1-based step number', async () => {
    // Step 0 is a typo with a plausible reading, and compiling step 1 instead
    // would be worse than saying no.
    const zero = await refusal({ testFilePath: testFile('smoke.md'), select: { steps: [0] } });
    expect(zero.status).toBe(400);
    expect(zero.error).toContain('1-based');

    const fractional = await refusal({
      testFilePath: testFile('smoke.md'),
      select: { steps: [1.5] },
    });
    expect(fractional.status).toBe(400);

    expect(compileTestMock).not.toHaveBeenCalled();
  });

  it('400s onlyStale and all together, and a maxRounds of zero', async () => {
    const both = await refusal({
      testFilePath: testFile('smoke.md'),
      select: { onlyStale: true, all: true },
    });
    expect(both.status).toBe(400);
    expect(both.error).toContain('pick one');

    // Zero rounds means "replay nothing", which cannot confirm anything.
    const rounds = await refusal({ testFilePath: testFile('smoke.md'), maxRounds: 0 });
    expect(rounds.status).toBe(400);
    expect(rounds.error).toContain('positive integer');

    expect(compileTestMock).not.toHaveBeenCalled();
  });

  it('400s a body that is not an object', async () => {
    const list = await refusal([{ testFilePath: testFile('smoke.md') }]);
    expect(list.status).toBe(400);
    expect(list.error).toContain('must be an object');
    expect(compileTestMock).not.toHaveBeenCalled();
  });
});

describe('the server never writes the real .steps.ts', () => {
  it('compiles dry even when the request asks for a real write', async () => {
    // `dryRun` is accepted and echoed by the parser, and then overridden. The
    // files come back on the stream and TestBench applies them through a diff,
    // so the write is undoable and shows up in Source Control — a server-side
    // write would be neither.
    const events = await compileStream({ testFilePath: testFile('smoke.md'), dryRun: false });

    expect(optionsAt(0).dryRun).toBe(true);
    expect(events.at(-1)!.data.summary.written).toEqual([]);
    expect(Object.keys(events.at(-1)!.data.files)).toEqual([testFile('smoke.steps.ts')]);
  });
});

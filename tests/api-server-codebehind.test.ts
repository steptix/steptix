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

vi.mock('../src/codebehind/compile.js', () => ({
  compileTest: vi.fn(async (options: CompileOptions): Promise<CompileResult> => {
    core.calls.push(options);
    options.onEvent?.({ kind: 'phase', phase: 'record', message: 'Recording the test' });
    options.onEvent?.({ kind: 'step', phase: 'generate', step: 1, message: 'Step 1: generated' });
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
import type { RunDetails, SessionManager } from '../src/server/session-manager.js';

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
/** Restored per test — the compiler reads it through the manager the app owns. */
let detailsSpy: MockInstance | undefined;

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

/** The same, from an ordinary run: no DOM either side, which is the common case. */
function stepWithoutContext(index: number): StepResult {
  return {
    index,
    instruction: `step ${index}`,
    status: 'passed',
    turns: [],
    durationMs: 1,
    retried: false,
  };
}

function runDetails(
  status: 'passed' | 'failed',
  steps: StepResult[],
): RunDetails & { status: 'passed' | 'failed' } {
  return { status, steps, parameters: { stage: 'staging' }, tokens: 1234 };
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
  writeFileSync(path.join(projectRoot, '.env.staging'), 'COMPILE_FIXTURE_STAGE=staging\n');
  writeFileSync(testFile('smoke.md'), SMOKE_MD);
  writeFileSync(testFile('other.md'), OTHER_MD);

  core.calls.length = 0;
  core.hold = null;
  compileTestMock.mockClear();
});

afterEach(() => {
  detailsSpy?.mockRestore();
  detailsSpy = undefined;
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('the compile stream', () => {
  it('streams the phases in order and ends with the proposed files and the summary', async () => {
    const events = await compileStream({ testFilePath: testFile('smoke.md') });

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
    expect(events[1]!.data).toEqual({
      type: 'compile:step',
      phase: 'generate',
      step: 1,
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

describe('compiling from an open session\'s last run', () => {
  it('hands the core that run\'s step results instead of recording a fresh one', async () => {
    const details = runDetails('passed', [stepWithContext(1)]);
    detailsSpy = vi.spyOn(sessionManager, 'lastRunDetails').mockReturnValue(details);
    const executeSteps = vi.spyOn(sessionManager, 'executeSteps');

    const events = await compileStream({
      testFilePath: testFile('smoke.md'),
      fromSessionId: 'session-with-a-green-run',
    });

    const recorded = optionsAt(0).recorded;
    expect(recorded).toBeDefined();
    expect(recorded!.status).toBe('passed');
    // One slot per expanded step, sparse where that run has nothing — the
    // core indexes into this by step number, so a compacted array would bind
    // step 1's DOM to step 2.
    expect(recorded!.steps).toHaveLength(3);
    expect(recorded!.steps[0]).toBe(details.steps[0]);
    expect(recorded!.steps[1]).toBeUndefined();
    expect(recorded!.resolvedParameters).toEqual({ stage: 'staging' });
    expect(recorded!.tokensUsed).toBe(1234);

    // The whole point of reusing a run: nothing is re-run. The core would be
    // the one to ask for a Record, and it was handed a `recorded` outcome
    // instead; the server itself drove no session either.
    expect(executeSteps).not.toHaveBeenCalled();
    expect(outputs(events)).toEqual([
      {
        kind: 'info',
        msg: 'Compiling from session session-with-a-green-run (1 step(s) with page context).',
      },
    ]);
    executeSteps.mockRestore();
  });

  it('records instead, and says why, when the session is not there', async () => {
    // No spy: an id nobody opened is exactly what the manager answers `null`
    // for, and that is the case a client hits after a Close Session.
    const events = await compileStream({
      testFilePath: testFile('smoke.md'),
      fromSessionId: 'no-such-session',
    });

    expect(optionsAt(0).recorded).toBeUndefined();
    expect(outputs(events)).toEqual([
      {
        kind: 'warn',
        msg: 'Cannot compile from session no-such-session: it is closed, gone, or has not run. Recording instead.',
      },
    ]);
  });

  it('records instead when that run failed', async () => {
    detailsSpy = vi
      .spyOn(sessionManager, 'lastRunDetails')
      .mockReturnValue(runDetails('failed', [stepWithContext(1)]));

    const events = await compileStream({
      testFilePath: testFile('smoke.md'),
      fromSessionId: 'session-that-failed',
    });

    // A red run's steps describe a journey that did not work. Compiling from
    // them would generate code for a page the test never reached.
    expect(optionsAt(0).recorded).toBeUndefined();
    expect(outputs(events)).toEqual([
      {
        kind: 'warn',
        msg: 'Cannot compile from session session-that-failed: that run did not pass. Recording instead.',
      },
    ]);
  });

  it('records instead when the run carried no page context', async () => {
    // The common case, and the reason the fallback has to be loud: an ordinary
    // run captures no DOM, so most green sessions cannot answer — and a silent
    // fallback is a whole extra AI run of the test that nobody asked for.
    detailsSpy = vi
      .spyOn(sessionManager, 'lastRunDetails')
      .mockReturnValue(runDetails('passed', [stepWithoutContext(1), stepWithoutContext(2)]));

    const events = await compileStream({
      testFilePath: testFile('smoke.md'),
      fromSessionId: 'session-without-dom',
    });

    expect(optionsAt(0).recorded).toBeUndefined();
    expect(outputs(events)).toEqual([
      {
        kind: 'warn',
        msg: 'Cannot compile from session session-without-dom: its step results carry no DOM snapshots. Recording instead.',
      },
    ]);
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

/**
 * A return inside a section or a skill, on the **compile** route
 * (stories/step-flow-control.md; `POST /codebehind/compile`).
 *
 * This route is the one run path that hands the server steps it has ALREADY
 * expanded: `sessionRunner` (src/server/compile-runner.ts) sends `test.steps`
 * with no `skillsDir` and no `sections`, deliberately, because re-expanding
 * server-side would be a second answer to "which `.steps.ts` does step 7 bind
 * into". The expansion rides along out-of-band instead, in
 * `internal.codeBehind.expansion`, where until recently only the code-behind
 * registry read it.
 *
 * Everything flow control needs is in that same table, and reading it from
 * anywhere else is not an option: with `expansionOrigins` left null every step
 * reads as the ROOT frame, so a `### Section` body that returned skipped the
 * rest of the TEST, reported it as *ended the run*, and quoted the interpolated
 * line — which for a skill body is the line with the argument values in it.
 *
 * Driven through the real `node:http` entry for the reason
 * `api-server-flow-control.test.ts` gives: the route builds its request from an
 * explicit allow-list (`parseCompileRequest`), so a test that calls the
 * compiler directly passes against a server that drops a field on the floor.
 * The compile CORE is faked at `compileTest` — what is under test is the run it
 * asks for, not the generate/review/replay pipeline — and the fake calls the
 * `runner` the server handed it, which is the whole path this file exercises.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';
import type { ParsedFlowControlStep } from '../src/parser/flow-control-step.js';
import type {
  CompileOptions,
  CompileResult,
  CompileRunOutcome,
} from '../src/codebehind/compile.js';

// ── The compile core, faked at the one function the server calls ─────

/** What the faked core's single Record run came back with. */
const runs = vi.hoisted(() => ({ outcomes: [] as CompileRunOutcome[] }));

vi.mock('../src/codebehind/compile.js', async (importOriginal) => ({
  // The real module underneath: the server also imports `firstDataRow` from
  // it, and a mock that drops it turns every compile into an error frame.
  ...(await importOriginal<typeof import('../src/codebehind/compile.js')>()),
  compileTest: vi.fn(async (options: CompileOptions): Promise<CompileResult> => {
    // One Record, exactly as the pipeline's first phase asks for it. The
    // parameter map is the one a Run resolves before it starts, which is what
    // makes the interpolated-vs-authored question below have two answers.
    const outcome = await options.runner({
      purpose: 'record',
      parameters: { password: 'hunter2' },
      strict: false,
      captureContext: false,
      disableCodeBehind: true,
    });
    runs.outcomes.push(outcome);
    return {
      status: 'green',
      files: {},
      summary: {
        test: options.test.filePath,
        totalSteps: options.test.steps.length,
        compiled: 0,
        kept: 0,
        keptAi: 0,
        rounds: 1,
        tokensUsed: 0,
        written: [],
        unproven: [],
        writtenOffAi: [],
        notAttempted: [],
        recordingDir: '/x/.aiui-codebehind-cache/x.recording',
      },
    };
  }),
}));

// ── Mocks (mirror api-server-flow-control.test.ts) ───────────────────

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

/** Every instruction the executor was handed, in order — the INTERPOLATED
 *  text, which is what tells a leaked reason from an authored one. */
const executed: string[] = [];
/** Which occurrence of a claimed step returns. The section is called twice with
 *  identical text, so "the second call returns" is a count, not a match. */
let returnOnOccurrence = 0;
let claimedSeen = 0;

vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: vi.fn(async (
    _stepIndex: number,
    _totalSteps: number,
    instruction: string,
    opts?: { flowControlClaim?: ParsedFlowControlStep },
  ): Promise<StepResult> => {
    executed.push(instruction);
    const returning =
      opts?.flowControlClaim !== undefined && ++claimedSeen === returnOnOccurrence;
    return {
      index: 1,
      instruction,
      status: 'passed',
      turns: [],
      durationMs: 1,
      retried: false,
      aiExplanation: returning ? 'the password is remembered' : 'ok',
      ...(returning && {
        flowControl: { kind: 'return' as const, verb: opts!.flowControlClaim!.verb },
      }),
    };
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

vi.mock('../src/report/generator.js', () => ({
  generateReport: vi.fn(async () => '/tmp/fake-report.html'),
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
  shouldEmit: vi.fn(() => false),
  setLogLevel: vi.fn(),
  getLogLevel: vi.fn(() => 'info'),
}));

import { createApiServer } from '../src/server/api-server.js';

const API_KEY = 'sk-compile-flow-control';
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

/**
 * A section called twice, with a main-flow step AFTER the second call.
 *
 *   1. Open the shop            <- root
 *   2. Sign in                  <- root, calls the section
 *   3. Sign in                  <- root, calls it again
 *   4. Click "Sign out"         <- root: must still RUN
 *   ### Sign in
 *     If {{password}} is already remembered then return
 *     Type the password {{password}}
 *     Press submit
 *
 * Expanded: 0 open, 1-3 first call, 4-6 second call, 7 sign out. The return at
 * 4 ends the section — 5 and 6 are skipped, 7 runs. Read as the root frame it
 * would take 7 with it.
 */
const SECTION_MD = [
  '# Booking',
  '',
  '## Parameters',
  '- password: hunter2',
  '',
  '## Steps',
  '1. Open the shop',
  '2. Sign in',
  '3. Sign in',
  '4. Click "Sign out"',
  '',
  '### Sign in',
  '1. If {{password}} is already remembered then return',
  '2. Type the password {{password}}',
  '3. Press submit',
  '',
].join('\n');

/**
 * The same shape through a SKILL, whose body the expander interpolates.
 *
 * `test.steps` holds `If hunter2 is already remembered then return`; only
 * `test.expansion.rawSteps` still holds `{{password}}`. Both travel in the
 * out-of-band expansion, and the reason must be built from the second — it is
 * written to a run log, a report cell and a wire event.
 */
const SKILL_MD = [
  '# Booking',
  '',
  '## Steps',
  '1. Open the shop',
  '2. [skill: login password="hunter2"]',
  '3. Click "Sign out"',
  '',
].join('\n');

const LOGIN_SKILL = [
  '---',
  'type: skill',
  '---',
  '# login',
  '',
  '## Parameters',
  '- password: the account password',
  '',
  '## Steps',
  '1. If {{password}} is already remembered then return',
  '2. Type the password {{password}}',
  '3. Press submit',
  '',
].join('\n');

let server: Server;
let baseUrl: string;
let projectRoot: string;

beforeAll(async () => {
  const { app } = createApiServer(cfg);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) baseUrl = `http://127.0.0.1:${addr.port}`;

  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'compile-flow-control-'));
  await fs.writeFile(path.join(projectRoot, 'aiui.config.json'), JSON.stringify({}));
  await fs.mkdir(path.join(projectRoot, 'skills'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'skills', 'login.md'), LOGIN_SKILL);
  await fs.writeFile(path.join(projectRoot, 'section.md'), SECTION_MD);
  await fs.writeFile(path.join(projectRoot, 'skill.md'), SKILL_MD);
});

afterAll(async () => {
  await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
  await fs.rm(projectRoot, { recursive: true, force: true });
});

beforeEach(() => {
  executed.length = 0;
  runs.outcomes.length = 0;
  claimedSeen = 0;
  returnOnOccurrence = 0;
});

/** POST the compile and collect every SSE frame. */
async function compile(testFilePath: string): Promise<any[]> {
  const res = await fetch(`${baseUrl}/codebehind/compile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ testFilePath }),
  });
  if (!res.body) throw new Error('no response body');
  const events: any[] = [];
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
        events.push(JSON.parse(dataLine.slice(6)));
      } catch {
        /* keep-alives */
      }
    }
  }
  return events;
}

/** The run's own events, unwrapped from `compile:run`. */
const runEvents = (events: any[]): any[] =>
  events.filter((e) => e.type === 'compile:run').map((e) => e.event);

describe('a section body that returns, on the compile route', () => {
  it('skips the rest of the SECTION, not the rest of the test', async () => {
    // The section's first body step, on its second call.
    returnOnOccurrence = 2;
    const events = await compile(path.join(projectRoot, 'section.md'));

    const skips = runEvents(events).filter((e) => e.type === 'step:skip');
    // Two: the section body's steps 2 and 3. Three would be the bug — the
    // main-flow `Click "Sign out"` taken along with them.
    expect(skips).toHaveLength(2);
    // Both name the invocation line (`3. Sign in`, line 9) rather than the body
    // line, because this route's `sourceLines` are `ParsedTest.stepLines`,
    // which the parser deliberately re-points at the call line after expansion
    // (markdown.ts: "the only file the user has open"). Pinned as a fact about
    // this route, not as the thing under test.
    expect(skips.map((s) => s.line)).toEqual([9, 9]);

    // The main-flow step after the call still ran. This is the whole finding:
    // with no origins every step reads as the root frame, `frameExitIndex`
    // answers "the last step", and step 4 was reported skipped without ever
    // being offered to the executor.
    expect(executed).toContain('Click "Sign out"');
    expect(executed.filter((s) => s === 'Press submit')).toHaveLength(1);

    // …and it is named as a section return, not as the end of the run.
    for (const skip of skips) {
      expect(skip.reason).toContain('returned from "Sign in"');
      expect(skip.reason).not.toContain('ended the run');
    }
  });

  it('carries the skipped steps back to the compile as `skipped`', async () => {
    returnOnOccurrence = 2;
    await compile(path.join(projectRoot, 'section.md'));

    const outcome = runs.outcomes[0]!;
    expect(outcome.status).toBe('passed');
    // Expanded indices: 4 returned, 5 and 6 skipped, 7 ran.
    expect(outcome.steps[4]?.status).toBe('passed');
    expect(outcome.steps[4]?.flowControl).toEqual({ kind: 'return', verb: 'return' });
    expect(outcome.steps[5]?.status).toBe('skipped');
    expect(outcome.steps[6]?.status).toBe('skipped');
    expect(outcome.steps[7]?.status).toBe('passed');
  });
});

describe('a skill body that returns, on the compile route', () => {
  it('quotes the AUTHORED line, so a resolved argument cannot ride out on it', async () => {
    returnOnOccurrence = 1;
    const events = await compile(path.join(projectRoot, 'skill.md'));

    // What the executor was handed proves the two texts really do differ here
    // — otherwise the assertion below would hold for the wrong reason.
    expect(executed).toContain('If hunter2 is already remembered then return');

    const skips = runEvents(events).filter((e) => e.type === 'step:skip');
    expect(skips.length).toBeGreaterThan(0);
    for (const skip of skips) {
      expect(skip.reason).toContain('If {{password}} is already remembered then return');
      expect(skip.reason).not.toContain('hunter2');
      expect(skip.reason).toContain('returned from "login"');
    }
    expect(executed).toContain('Click "Sign out"');
  });
});

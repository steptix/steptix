/**
 * `If … then return` / `… then stop` over HTTP (stories/step-flow-control.md).
 *
 * **Every test here POSTs through the real `node:http` entry**, for the reason
 * `api-server-sections.test.ts` states at its top: `api-server.ts` builds
 * `StepRequest` from an explicit per-field allow-list, so a test that hands a
 * `StepRequest` straight to the session manager passes against a server that
 * drops the field on the floor. This seam has already lost one field that way.
 *
 * The browser / AI / step-executor are mocked; the expander, the request
 * validation, the frame stack and the session manager's step loop run for real
 * — the step loop being the thing under test.
 *
 * The executor's own half of the contract — a `return` action refused with
 * `RETURN_NOT_CLAIMED` on a step whose text does not claim the form, the settle
 * gate, the model's words riding out on `aiExplanation` — is pinned in
 * `flow-control-executor.test.ts` against the real executor. What is testable
 * HERE is the server's half: which steps get a `flowControlClaim` at all.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';
import type { ParsedFlowControlStep } from '../src/parser/flow-control-step.js';

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

/**
 * Instruction text → the model says the condition holds.
 *
 * Keyed on the INTERPOLATED text the executor is handed, which for these
 * fixtures is the authored text. Set per test.
 */
const conditionHolds = new Set<string>();
/** `[instruction, claim]` for every step that reached the executor. The claim
 *  is the server's whole contribution to the return guard: it decides which
 *  steps may end a flow, and `executeStep` refuses the action on the rest. */
const claims: [string, ParsedFlowControlStep | undefined][] = [];
/** `## Prior Steps` as each executed step was handed it — where the `[flow]`
 *  line has to land, or the model reads a section that started and stopped
 *  with nothing saying it ended on purpose. */
const histories: string[][] = [];

vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: vi.fn(async (
    _stepIndex: number,
    _totalSteps: number,
    instruction: string,
    opts?: { flowControlClaim?: ParsedFlowControlStep; conversationHistory?: string[] },
  ): Promise<StepResult> => {
    claims.push([instruction, opts?.flowControlClaim]);
    histories.push([...(opts?.conversationHistory ?? [])]);
    const returning = opts?.flowControlClaim && conditionHolds.has(instruction);
    return {
      index: 1,
      instruction,
      status: 'passed',
      turns: [],
      durationMs: 5,
      retried: false,
      // What the real executor produces on a return: the model's BARE detail,
      // with no idea which flow it was in. Naming the flow is the loop's job.
      aiExplanation: returning ? 'the title is Dashboard' : 'ok',
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

/** The report the run produced — where the skipped ROWS have to land, since
 *  the HTTP response's `results[]` is a different, lossier list. */
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
  shouldEmit: vi.fn(() => false),
  setLogLevel: vi.fn(),
  getLogLevel: vi.fn(() => 'info'),
}));

import { createApiServer } from '../src/server/api-server.js';
import { readLastRun } from '../src/codebehind/last-run.js';
import { executeStep } from '../src/runner/step-executor.js';
import { listenFetchable } from './listen-fetchable.cjs';

const API_KEY = 'sk-flow-control-test';
const cfg: Config = {
  ai: { gatewayUrl: 'https://ai.test', model: 't', maxInputTokens: 1000, streamResponses: false, sendScreenshots: false },
  browser: { headed: false, viewport: { width: 1280, height: 720 }, windowSize: { width: 1280, height: 720 }, slowMo: 0, browser: 'chromium', fullPageScreenshots: true },
  tests: { dir: './tests', contextDir: './context', pattern: '**/*.md' },
  execution: { timeout: 30000, retries: 1, screenshotOnFailure: true, promptOnAmbiguity: false, maxTurns: 5 },
  reports: { outputDir: './reports', includeScreenshots: false, includeDomSnapshots: false, includeAiReasoning: false, embedScreenshots: false },
  api: { specsDir: './specs', requestTimeout: 30000, redactSensitive: true },
  server: { host: '127.0.0.1', port: 0, apiKey: API_KEY },
  logging: { consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
};

let server: Server;
let baseUrl: string;
let tmpDir: string;
let skillsDir: string;
let testFilePath: string;

beforeAll(async () => {
  const { app } = createApiServer(cfg);
  server = createServer(app);
  await listenFetchable(server, '127.0.0.1');
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) baseUrl = `http://127.0.0.1:${addr.port}`;

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-control-http-'));
  testFilePath = path.join(tmpDir, 'flow.md');
  await fs.writeFile(testFilePath, '# placeholder — the server never reads this\n');

  // A skill whose FIRST body step is the flow-control line and whose argument
  // is a secret. The expander interpolates `{{password}}` into the step text,
  // so this fixture is what tells the authored reason apart from the
  // interpolated one — nothing with a plain body can.
  skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-control-skills-'));
  await fs.writeFile(
    path.join(skillsDir, 'login.md'),
    `---
type: skill
---
# login

## Parameters
- password: the account password

## Steps
1. If {{password}} is already remembered then return
2. Type the password {{password}}
3. Press submit
`,
  );
});

afterAll(async () => {
  await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(skillsDir, { recursive: true, force: true });
});

beforeEach(() => {
  conditionHolds.clear();
  claims.length = 0;
  histories.length = 0;
  generatedReports.length = 0;
  (executeStep as unknown as { mockClear: () => void }).mockClear();
});

// ── Helpers ──────────────────────────────────────────────────────────

let sessionSeq = 0;
const nextSession = (): string => `flow-${++sessionSeq}-${Date.now()}`;

async function postSteps(body: unknown, sessionId = nextSession()): Promise<any> {
  const res = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function* sseEvents(body: unknown, sessionId = nextSession()) {
  const res = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, Accept: 'text/event-stream' },
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

async function collect(body: unknown, sessionId = nextSession()): Promise<any[]> {
  const events: any[] = [];
  for await (const ev of sseEvents(body, sessionId)) {
    events.push(ev);
    if (ev.type === 'done') break;
  }
  return events;
}

async function runControl(sessionId: string, mode: string): Promise<number> {
  const res = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/run-control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ mode }),
  });
  return res.status;
}

const RETURN_STEP = 'If the page title contains "Dashboard" then return';
const STOP_STEP = 'If the page title contains "Dashboard" then stop running the remaining steps';

/**
 * A section that calls a section, and a main-flow `stop` after the call.
 *
 *      3. Open the shop                  <- main
 *      4. Sign in                        <- main, calls the section
 *      5. If … then stop                 <- main
 *      6. Click Sign out                 <- main
 *      ### Sign in                       (heading, line 8)
 *      9.  If … then return
 *     10.  Type creds                    <- body, calls the nested section
 *     11.  Press submit
 *      ### Type creds                    (heading, line 13)
 *     14.  Type the username
 *     15.  Type the password
 *
 * Expanded, that is seven steps:
 *   0 Open the shop (root, 3)   1 If…return (Sign in, 9)
 *   2 Type the username (Type creds, 14)   3 Type the password (Type creds, 15)
 *   4 Press submit (Sign in, 11)   5 If…stop (root, 5)   6 Click Sign out (root, 6)
 */
const nestedBody = (extra: Record<string, unknown> = {}) => ({
  steps: ['Open the shop', 'Sign in', STOP_STEP, 'Click Sign out'],
  sourceLines: [3, 4, 5, 6],
  testFilePath,
  sections: {
    'sign in': {
      name: 'Sign in',
      headingLine: 8,
      steps: [RETURN_STEP, 'Type creds', 'Press submit'],
      stepLines: [9, 10, 11],
    },
    'type creds': {
      name: 'Type creds',
      headingLine: 13,
      steps: ['Type the username', 'Type the password'],
      stepLines: [14, 15],
    },
  },
  ...extra,
});

// ─────────────────────────────────────────────────────────────────────
describe('a return inside a section body', () => {
  it('skips the rest of the body — the right lines, in the right frames', async () => {
    conditionHolds.add(RETURN_STEP);
    conditionHolds.add(STOP_STEP);
    const events = await collect(nestedBody());

    const skips = events.filter((e) => e.type === 'step:skip');
    // Line 10 is the NESTED CALL, reported in the frame it is written in
    // (`Sign in`, whose file is the test file) — not in `Type creds`, whose
    // body it introduces. Then the two body lines, then the body line after
    // the nested call. Order is document order within the returned flow.
    expect(skips.map((e) => e.line)).toEqual([10, 14, 15, 11, 6]);

    const [call, username, password, submit] = skips;
    expect(call.frame).toMatchObject({ kind: 'section', skillName: 'Sign in', uri: testFilePath });
    expect(username.frame).toMatchObject({ kind: 'section', skillName: 'Type creds' });
    expect(password.frame).toMatchObject({ kind: 'section', skillName: 'Type creds' });
    expect(submit.frame).toMatchObject({ kind: 'section', skillName: 'Sign in' });
  });

  it('names the flow in every reason, and says which step ended it', async () => {
    conditionHolds.add(RETURN_STEP);
    conditionHolds.add(STOP_STEP);
    const events = await collect(nestedBody());

    // One formatter for the wire and the report (src/runner/flow-control.ts):
    // step 2 of the expansion is 1-based step 2, and the flow is the section.
    for (const skip of events.filter((e) => e.type === 'step:skip' && e.line !== 6)) {
      expect(skip.reason).toBe(`Not run: step 2 returned from "Sign in" — ${RETURN_STEP}`);
    }
    // The main-flow return has no section to name.
    const mainSkip = events.find((e) => e.type === 'step:skip' && e.line === 6);
    expect(mainSkip.reason).toBe(`Not run: step 6 ended the run — ${STOP_STEP}`);
  });

  it('pushes no frame for the nested call it skipped, and pops the returned frame clean', async () => {
    conditionHolds.add(RETURN_STEP);
    const events = await collect(nestedBody());

    const pushed = events.filter((e) => e.type === 'frame:push').map((e) => e.frame.skillName);
    // `Sign in` ran (its first step did). `Type creds` never did — and if it
    // had been pushed it would also have popped cleanly, painting ✓ on line 10
    // for work that never happened. That is the whole reason skipped steps do
    // not go through `transitionToFrame`.
    expect(pushed).toEqual(['Sign in']);
    expect(events.filter((e) => e.type === 'frame:pop')).toHaveLength(1);
    // Nothing failed: the section ran and returned, so its call line paints ✓.
    expect(events.some((e) => e.type === 'step:fail')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
  });

  it('carries the skipped steps in results[] and counts only what executed', async () => {
    conditionHolds.add(RETURN_STEP);
    conditionHolds.add(STOP_STEP);
    const body = await postSteps(nestedBody());

    expect(body.status).toBe('passed');
    expect(body.stepsTotal).toBe(7);
    // Open the shop, the return, the stop. Five of the seven never ran.
    expect(body.stepsCompleted).toBe(3);
    expect(body.results.map((r: any) => r.status)).toEqual([
      'passed',   // Open the shop
      'passed',   // If … then return
      'skipped',  // Type the username
      'skipped',  // Type the password
      'skipped',  // Press submit
      'passed',   // If … then stop
      'skipped',  // Click Sign out
    ]);
    expect(body.results[2]).toMatchObject({
      step: 'Type the username',
      reasoning: `Not run: step 2 returned from "Sign in" — ${RETURN_STEP}`,
      screenshot: '',
      outputs: {},
    });
  });

  it('names the flow on the returning step itself, keeping the model`s own words', async () => {
    conditionHolds.add(RETURN_STEP);
    const body = await postSteps(nestedBody());
    // The executor returns the bare detail; the loop is what knows the flow.
    expect(body.results[1]).toMatchObject({
      status: 'passed',
      reasoning: 'Returned from "Sign in": the title is Dashboard',
    });
  });

  it('puts the skipped rows in the report, so the header can count them', async () => {
    conditionHolds.add(RETURN_STEP);
    await postSteps(nestedBody());

    const rows = generatedReports.at(-1).steps as any[];
    const skipped = rows.filter((r) => r.status === 'skipped');
    expect(skipped.map((r) => r.instruction)).toEqual([
      'Type the username',
      'Type the password',
      'Press submit',
    ]);
    // The section badge survives the skip: the report groups by it.
    expect(skipped[0].sourceSection).toBe('Sign in');
    expect(skipped[0].aiExplanation).toBe(`Not run: step 2 returned from "Sign in" — ${RETURN_STEP}`);
  });

  it('counts them in the report HEADER, not only in the rows', async () => {
    conditionHolds.add(RETURN_STEP);
    await postSteps(nestedBody());

    const report = generatedReports.at(-1);
    const rows = report.steps as any[];
    const skippedRows = rows.filter((r) => r.status === 'skipped').length;
    // The rows alone are not enough. `generateReport` reads
    // `report.skippedSteps ?? 0` and the template hides the tile at 0, so a
    // server that never set the field produced a header saying "4 passed" of
    // seven steps with no word about the other three — the count silently
    // dropped rather than rendered wrong. The CLI and the Electron runner have
    // always set it; this is the server catching up
    // (stories/step-flow-control.md, decision 15).
    expect(skippedRows).toBe(3);
    expect(report.skippedSteps).toBe(skippedRows);
    expect(report.passedSteps).toBe(4);
    expect(report.failedSteps).toBe(0);
    expect(report.totalSteps).toBe(7);
  });

  it('omits the field entirely on a run that skipped nothing', async () => {
    // Not `0`: a run that never returns must write the report it always did,
    // which is the same rule the CLI writer follows.
    await postSteps(nestedBody());
    const report = generatedReports.at(-1);
    expect(report.steps.some((r: any) => r.status === 'skipped')).toBe(false);
    expect('skippedSteps' in report).toBe(false);
  });

  it('keeps the skipped steps out of the code-behind last-run sidecar', async () => {
    // The sidecar answers "which entries does the next compile need to
    // regenerate", and a step that never ran is no evidence either way
    // (decision 12). The CLI writer has always left them out; the server wrote
    // every result it had, so a skipped step landed there as
    // `fromCodeBehind: false, stale: false` — "ran under AI and was fine" —
    // about a step nothing executed, and `--only-stale` would then skip a
    // broken entry on the strength of it.
    conditionHolds.add(RETURN_STEP);
    conditionHolds.add(STOP_STEP);
    await postSteps(nestedBody());

    const sidecar = await readLastRun(testFilePath);
    expect(sidecar).not.toBeNull();
    // Executed steps only, and every one of them: `Open the shop`, the return,
    // and the stop.
    expect(sidecar!.steps.map((s) => s.index)).toEqual([1, 2, 6]);
    expect(sidecar!.steps.map((s) => s.status)).toEqual(['passed', 'passed', 'passed']);
  });

  it('pops the returned frame at end of run when nothing follows the call', async () => {
    conditionHolds.add(RETURN_STEP);
    const events = await collect({
      steps: ['Open the shop', 'Sign in'],
      sourceLines: [1, 2],
      testFilePath,
      sections: {
        'sign in': {
          name: 'Sign in',
          headingLine: 4,
          steps: [RETURN_STEP, 'Press submit'],
          stepLines: [5, 6],
        },
      },
    });
    // Nothing executes after the section, so the pop comes from the end-of-run
    // `transitionToFrame('')` rather than from the next step's transition. It
    // still has to arrive, and still has to be clean, or the client's call
    // stack never unwinds and line 2 never resolves to a glyph.
    expect(events.filter((e) => e.type === 'frame:push')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'frame:pop')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step:skip').map((e) => e.line)).toEqual([6]);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
  });

  it('skips nothing when the return is the last step of its frame', async () => {
    conditionHolds.add(RETURN_STEP);
    const body = await postSteps({
      steps: ['Open the shop', 'Sign in', 'Check out'],
      sourceLines: [1, 2, 3],
      testFilePath,
      sections: {
        'sign in': { name: 'Sign in', headingLine: 5, steps: ['Type creds', RETURN_STEP], stepLines: [6, 7] },
      },
    });
    // `frameExitIndex` answers `i` itself here, so the skip loop runs zero
    // times and the caller needs no special case. The main flow carries on.
    expect(body.results.map((r: any) => r.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
    expect(body.stepsCompleted).toBe(4);
  });

  it('tells the model the flow ended, so the step after the call is not reading a gap', async () => {
    conditionHolds.add(RETURN_STEP);
    await postSteps(nestedBody());

    // The last executed step is the main-flow one after the section call.
    const priorSteps = histories.at(-1)!;
    expect(priorSteps.some((line) => line.startsWith('[flow] '))).toBe(true);
    expect(priorSteps.find((line) => line.startsWith('[flow] '))).toContain(
      'Returned from "Sign in": the title is Dashboard — the rest of that flow was skipped',
    );
    // And the skipped steps left no trace of their own: a history entry for a
    // step that never ran would be the model's evidence that it did.
    expect(priorSteps.some((line) => line.includes('Type the username'))).toBe(false);
  });
});

describe('a return in the main flow', () => {
  it('ends the run as a pass, with the rest skipped', async () => {
    conditionHolds.add(STOP_STEP);
    const events = await collect({
      steps: ['Open the shop', STOP_STEP, 'Click Sign out', 'Check the receipt'],
      sourceLines: [1, 2, 3, 4],
      testFilePath,
    });

    expect(events.filter((e) => e.type === 'step:skip').map((e) => e.line)).toEqual([3, 4]);
    // A return is not a failure — that is the entire point of the feature.
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
    expect(events.some((e) => e.type === 'step:fail')).toBe(false);
    // No `step:start` for a skipped step: it was never started, and a client
    // pairing starts with terminals must not be left with an open row.
    expect(events.filter((e) => e.type === 'step:start')).toHaveLength(2);
  });

  it('reports it as passed with N skipped, never as a truncated run', async () => {
    conditionHolds.add(STOP_STEP);
    const body = await postSteps({
      steps: ['Open the shop', STOP_STEP, 'Click Sign out'],
      sourceLines: [1, 2, 3],
      testFilePath,
    });
    expect(body).toMatchObject({ status: 'passed', stepsCompleted: 2, stepsTotal: 3 });
    expect(body.error).toBeNull();
    expect(body.results.map((r: any) => r.status)).toEqual(['passed', 'passed', 'skipped']);
  });
});

describe('loops', () => {
  it('ends the ITERATION, not the loop — the next row still starts', async () => {
    // stories/step-flow-control.md, decision 13. Each iteration of a looped
    // section is its own frame, and a frame is a flow, so `frameExitIndex`
    // stops at the end of the current row rather than running to the end of
    // the table. There is no "break out of the loop" in this story, and this
    // is what makes that true without anything having to say so.
    conditionHolds.add(RETURN_STEP);
    const body = await postSteps({
      steps: ['Open the shop', 'Upload each file', 'Done'],
      sourceLines: [1, 2, 3],
      testFilePath,
      sections: {
        'upload each file': {
          name: 'Upload each file',
          headingLine: 5,
          steps: [RETURN_STEP, 'Upload {{file}}'],
          stepLines: [6, 7],
          rows: [{ file: 'a.png' }, { file: 'b.png' }],
        },
      },
    });

    expect(body.status).toBe('passed');
    expect(body.results.map((r: any) => [r.step, r.status])).toEqual([
      ['Open the shop', 'passed'],
      [RETURN_STEP, 'passed'],
      ['Upload a.png', 'skipped'],
      // Row 2 STARTS: the return left row 1, not the table.
      [RETURN_STEP, 'passed'],
      ['Upload b.png', 'skipped'],
      ['Done', 'passed'],
    ]);
    expect(body.stepsCompleted).toBe(4);
  });

  it('announces a looped nested call ONCE, not once per row', async () => {
    // The call line is an address in a file, and a three-row table is three
    // frames sharing one. Keyed by frame id this would announce the same line
    // skipped three times over.
    conditionHolds.add(RETURN_STEP);
    const events = await collect({
      steps: ['Open the shop', 'Sign in', 'Done'],
      sourceLines: [1, 2, 3],
      testFilePath,
      sections: {
        'sign in': {
          name: 'Sign in',
          headingLine: 5,
          steps: [RETURN_STEP, 'Upload each file', 'Press submit'],
          stepLines: [6, 7, 8],
        },
        'upload each file': {
          name: 'Upload each file',
          headingLine: 10,
          steps: ['Upload {{file}}'],
          stepLines: [11],
          rows: [{ file: 'a.png' }, { file: 'b.png' }],
        },
      },
    });

    // Line 7 is the call, announced once. Line 11 is the body step, announced
    // once per row because each row IS a step that would have run. Line 8 is
    // the rest of the outer body.
    expect(events.filter((e) => e.type === 'step:skip').map((e) => e.line)).toEqual([7, 11, 11, 8]);
    // The call line is reported in the frame it is WRITTEN in — `Sign in` —
    // not in the loop it introduces.
    const call = events.find((e) => e.type === 'step:skip')!;
    expect(call.frame).toMatchObject({ skillName: 'Sign in', uri: testFilePath });
    expect(events.filter((e) => e.type === 'frame:push').map((e) => e.frame.skillName)).toEqual([
      'Sign in',
    ]);
  });

  it('announces a call INSIDE a looped body once, not once per iteration', async () => {
    // The case the test above does not reach. There the call line's parent was
    // a single frame; here it is the iteration frame, and a two-row table has
    // two of those. Keyed by parent frame ID the same `[skill: …]` line —
    // line 7, one line in one file — is announced skipped once per row: the
    // gutter repaints over itself, but the run log and Test Explorer print it
    // twice. Keyed by the parent frame's URI plus the line, which is the
    // address the client actually paints, it is announced once.
    conditionHolds.add(STOP_STEP);
    const events = await collect({
      steps: [STOP_STEP, 'Upload each file', 'Done'],
      sourceLines: [1, 2, 3],
      testFilePath,
      skillsDir,
      sections: {
        'upload each file': {
          name: 'Upload each file',
          headingLine: 6,
          steps: ['[skill: login password="hunter2"]', 'Upload {{file}}'],
          stepLines: [7, 8],
          rows: [{ file: 'a.png' }, { file: 'b.png' }],
        },
      },
    });

    // Line 2 is the section call, line 7 the skill call inside its body — each
    // once. Lines 10/11/12 are the skill's own body steps (in login.md) and
    // line 8 the row step; those repeat per row, because each repetition IS a
    // step that would have run.
    expect(events.filter((e) => e.type === 'step:skip').map((e) => e.line)).toEqual([
      2, 7, 10, 11, 12, 8,
      /* row 2 — no second 7 */ 10, 11, 12, 8,
      3,
    ]);
  });
});

describe('a return inside a skill body', () => {
  const RAW_RETURN = 'If {{password}} is already remembered then return';
  const RESOLVED_RETURN = 'If hunter2 is already remembered then return';

  const skillBody = () => ({
    steps: ['Open the shop', '[skill: login password="hunter2"]', 'Done'],
    sourceLines: [1, 2, 3],
    testFilePath,
    skillsDir,
  });

  it('quotes the AUTHORED line in every reason, never the resolved argument', async () => {
    // The reason string is written to a wire event, a run log, an HTML report
    // cell and a Steptix hover. The expander has already put the call's
    // arguments into the step text by the time the loop sees it, so a reason
    // built from `effectiveSteps[i]` publishes the password in all four places.
    // `expansionRawSteps` is the match side, which the expander never
    // interpolates (decision 4).
    conditionHolds.add(RESOLVED_RETURN);
    const events = await collect(skillBody());
    const body = await postSteps(skillBody());

    const expected = `Not run: step 2 returned from "login" — ${RAW_RETURN}`;

    const skips = events.filter((e) => e.type === 'step:skip');
    // The two body steps after the return, addressed in login.md.
    expect(skips.map((e) => e.line)).toEqual([11, 12]);
    for (const skip of skips) expect(skip.reason).toBe(expected);

    // The HTTP response's own list, which is a different surface.
    const reasons = body.results
      .filter((r: any) => r.status === 'skipped')
      .map((r: any) => r.reasoning);
    expect(reasons).toEqual([expected, expected]);

    // And the report rows, which is a third.
    const rows = generatedReports.at(-1).steps as any[];
    expect(rows.filter((r) => r.status === 'skipped').map((r) => r.aiExplanation)).toEqual([
      expected,
      expected,
    ]);

    // The whole point, stated as the thing that must never be true: no surface
    // carries the value. Checked over the raw JSON so a field added later is
    // covered without this test being updated.
    for (const surface of [JSON.stringify(skips), JSON.stringify(reasons)]) {
      expect(surface).not.toContain('hunter2');
    }
  });

  it('ends the skill invocation and carries on after the call', async () => {
    // The other half of the same run: naming the authored line must not have
    // changed WHICH steps are skipped or where the run resumes.
    conditionHolds.add(RESOLVED_RETURN);
    const body = await postSteps(skillBody());

    expect(body.status).toBe('passed');
    expect(body.results.map((r: any) => [r.step, r.status])).toEqual([
      ['Open the shop', 'passed'],
      [RESOLVED_RETURN, 'passed'],
      ['Type the password hunter2', 'skipped'],
      ['Press submit', 'skipped'],
      ['Done', 'passed'],
    ]);
  });
});

/**
 * A return inside a LOOPED SECTION body, where the row column is a secret.
 *
 * The sibling of the skill-argument test above, and until recently the one
 * shape that answered differently. The reason string is built from the match
 * side (`expansionRawSteps`), and a looped body's match side used to be the
 * row-INTERPOLATED text: the wire carries no `rawSteps` (contract §3.2), the
 * server interpolates each row into `steps` before recursing, and `matchInput`
 * fell back to that. So a body line reading `If {{password}} is already
 * remembered then return` published the row's password on all four surfaces —
 * wire event, run log, report cell, Steptix hover — and the flow-control
 * story carved it out as a documented leak.
 *
 * The expander now pins a looped body's match side to the section's own
 * authored lines, which closed the carve-out as a side effect of fixing what it
 * was there for: a divergent match side bound one code-behind entry per row.
 * That fix has a test (tests/data-rows-sections.test.ts, the expander half) and
 * this composition did not — and the composition is the only thing that can see
 * a reason string. It belongs here rather than beside the rows tests for the
 * same reason the skill-argument test does: the surfaces are the server's, and
 * this harness is the one that has all three of them.
 */
describe('a return inside a looped section body', () => {
  const RAW_RETURN = 'If {{password}} is already remembered then return';

  /**
   *      1. Open the shop                     <- main
   *      2. Sign in each account              <- main, calls the looped section
   *      3. Done                              <- main
   *      ### Sign in each account              (heading, line 6; two rows)
   *      7.  If {{password}} … then return
   *      8.  Type the username {{user}}
   *      9.  Press submit
   *
   * Expanded, eight steps: 1 main, the body twice, 1 main. Both rows return at
   * their first body line, so lines 8 and 9 are skipped in each iteration —
   * which is what puts TWO different row secrets behind one authored reason.
   */
  const loopedBody = () => ({
    steps: ['Open the shop', 'Sign in each account', 'Done'],
    sourceLines: [1, 2, 3],
    testFilePath,
    sections: {
      'sign in each account': {
        name: 'Sign in each account',
        headingLine: 6,
        steps: [RAW_RETURN, 'Type the username {{user}}', 'Press submit'],
        stepLines: [7, 8, 9],
        rows: [
          { user: 'ada', password: 'hunter2' },
          { user: 'bob', password: 'letmein' },
        ],
      },
    },
  });

  it('quotes the AUTHORED body line in every reason, never the row value', async () => {
    // Keyed on the interpolated text, which is what the executor is handed —
    // one entry per row, because each row's return line reads differently.
    conditionHolds.add('If hunter2 is already remembered then return');
    conditionHolds.add('If letmein is already remembered then return');
    const events = await collect(loopedBody());
    const body = await postSteps(loopedBody());

    // The run half: each iteration returns at its own first body line, so the
    // two lines after it are skipped and the next row still starts.
    const skips = events.filter((e) => e.type === 'step:skip');
    expect(skips.map((e) => e.line)).toEqual([8, 9, /* row 2 */ 8, 9]);

    // Row 1's return is expanded step 2, row 2's is step 5 — so the two reasons
    // differ in that number and in nothing else. The quoted line is the
    // section's own authored text, placeholder intact, for both rows.
    const expected = [
      `Not run: step 2 returned from "Sign in each account" — ${RAW_RETURN}`,
      `Not run: step 5 returned from "Sign in each account" — ${RAW_RETURN}`,
    ];
    expect(skips.map((e) => e.reason)).toEqual([expected[0], expected[0], expected[1], expected[1]]);

    // The HTTP response's own list, which is a different surface.
    const reasons = body.results
      .filter((r: any) => r.status === 'skipped')
      .map((r: any) => r.reasoning);
    expect(reasons).toEqual([expected[0], expected[0], expected[1], expected[1]]);

    // And the report rows, which is a third.
    const rows = generatedReports.at(-1).steps as any[];
    expect(rows.filter((r) => r.status === 'skipped').map((r) => r.aiExplanation)).toEqual([
      expected[0],
      expected[0],
      expected[1],
      expected[1],
    ]);

    // The thing that must never be true, over the raw JSON so a field added
    // later is covered without this test being updated. Both rows' values: the
    // interpolated reading leaked whichever row the iteration was on, so
    // checking one would pass against a version that leaked the other.
    for (const surface of [JSON.stringify(skips), JSON.stringify(reasons)]) {
      expect(surface).not.toContain('hunter2');
      expect(surface).not.toContain('letmein');
    }
  });
});

describe('the claim the server hands the executor', () => {
  it('is set on a step that claims the form, and absent on every other step', async () => {
    await postSteps({
      steps: ['Open the shop', RETURN_STEP, 'Click "Sign out" then return to the dashboard'],
      sourceLines: [1, 2, 3],
      testFilePath,
    });

    expect(claims.map(([text, claim]) => [text, claim ?? null])).toEqual([
      ['Open the shop', null],
      [RETURN_STEP, { verb: 'return', body: 'the page title contains "Dashboard"' }],
      // A near miss: `then return to the dashboard` reads as "navigate back",
      // and the framework does not guess. Without a claim, the executor
      // refuses a `return` action with RETURN_NOT_CLAIMED.
      ['Click "Sign out" then return to the dashboard', null],
    ]);
  });

  it('costs no AI call at all for the unconditional form', async () => {
    const body = await postSteps({
      steps: ['Open the shop', 'Return', 'Click Sign out'],
      sourceLines: [1, 2, 3],
      testFilePath,
    });

    // `Return` never reaches the executor: no model call, no page snapshot —
    // dispatched by the loop the way `Set` is (decision 3).
    expect(claims.map(([text]) => text)).toEqual(['Open the shop']);
    expect(executeStep).toHaveBeenCalledTimes(1);
    expect(body.results.map((r: any) => r.status)).toEqual(['passed', 'passed', 'skipped']);
    // No model turn means no model detail to append — the bare phrase.
    expect(body.results[1].reasoning).toBe('Ended the run');
  });

  it('dispatches the unconditional form inside a section too, naming that flow', async () => {
    const body = await postSteps({
      steps: ['Open the shop', 'Sign in', 'Check out'],
      sourceLines: [1, 2, 3],
      testFilePath,
      sections: {
        'sign in': { name: 'Sign in', headingLine: 5, steps: ['Stop', 'Press submit'], stepLines: [6, 7] },
      },
    });
    expect(body.results.map((r: any) => r.status)).toEqual(['passed', 'passed', 'skipped', 'passed']);
    expect(body.results[1].reasoning).toBe('Returned from "Sign in"');
    // The main flow carries on after the section that ended.
    expect(body.results[3].step).toBe('Check out');
  });
});

describe('bounds and pauses', () => {
  it('clamps the jump to endIndex — a bounded re-run reports no step it was never going to reach', async () => {
    const events = await collect({
      steps: ['Open the shop', 'Return', 'Third step', 'Fourth step'],
      sourceLines: [1, 2, 3, 4],
      testFilePath,
      endAt: { uri: testFilePath, line: 3 },
    });
    // Only step 3 is inside the batch. Step 4 was never going to run in this
    // request, so calling it "skipped by the return" would be a claim about a
    // step the run had no opinion on.
    expect(events.filter((e) => e.type === 'step:skip').map((e) => e.line)).toEqual([3]);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
  });

  it('step-mode `over` after a return pauses on the POST-JUMP step, never a skipped line', async () => {
    conditionHolds.add(RETURN_STEP);
    conditionHolds.add(STOP_STEP);
    const sessionId = nextSession();
    const events: any[] = [];
    for await (const ev of sseEvents(nestedBody({ stepMode: 'over' }), sessionId)) {
      events.push(ev);
      if (ev.type === 'step:awaiting') await runControl(sessionId, 'over');
      if (ev.type === 'done') break;
    }

    const awaitingLines = events.filter((e) => e.type === 'step:awaiting').map((e) => e.line);
    // The step that will ACTUALLY run next after the section returns is the
    // main-flow step on line 5 (decision 10). Reading `i + 1` instead would
    // consult line 14 — a step this run has already declared skipped — and at
    // `over` that comparison (depth 2 vs 1) does not pause at all, so the
    // yellow ▶ would simply vanish for the rest of the section.
    expect(awaitingLines).toContain(5);
    for (const skippedLine of [10, 11, 14, 15, 6]) {
      expect(awaitingLines).not.toContain(skippedLine);
    }
  });

  it('a breakpoint on a skipped line does not pause — it was never started', async () => {
    conditionHolds.add(RETURN_STEP);
    const events = await collect(
      // Line 14 is a section-body line in the test file, which the client's own
      // `trimAtBreakpoint` cannot see — so the SERVER is what would pause on it
      // if that step ran. It does not run.
      nestedBody({ breakpointsByUri: { [testFilePath]: [14] } }),
    );
    expect(events.filter((e) => e.type === 'step:awaiting')).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
  });
});

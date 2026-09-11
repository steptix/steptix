/**
 * Compiling as the run goes, over HTTP (stories/compile-as-you-go.md).
 *
 * **Every test here POSTs through the real `node:http` entry**, for the reason
 * the sections suite states: `api-server.ts` builds `StepRequest` from an
 * explicit per-field allow-list, so adding `compile` to the TYPE compiles
 * cleanly and drops the field at runtime. A test that handed the session
 * manager a `StepRequest` directly would pass against exactly that bug — the
 * one that lost `envName` once.
 *
 * The browser and the step executor are mocked; the session manager, the
 * code-behind registry, the generation prompt/parse, the writer, Prettier and
 * the recording all run for real. The AI client is a fake that answers a
 * generation prompt with an entry and a review prompt with the file unchanged,
 * so the seam under test is "does a compile-mode run produce frames, files and
 * a recording", not "is the model any good".
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
  url: vi.fn(() => 'https://example.com/dashboard'),
  title: vi.fn(async () => 'Dashboard'),
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

/** Every `executeStep` call's options, so the code-behind binding the run
 *  handed the executor (or did not) is observable. */
const stepCalls: { instruction: string; opts: Record<string, unknown> }[] = [];

/**
 * Which OCCURRENCE of a flow-control step returns: instruction → 1-based call
 * number (stories/step-flow-control.md). A section called twice is the shape
 * the story and the live fixture are both written around — the body runs on
 * the first call and returns at its first line on the second — and the only
 * way to say that to a mock is by counting the calls.
 *
 * Only ever consulted for a step the SERVER decided claims the form: the
 * `flowControlClaim` option is the server's own half of the contract, so a
 * mock that returned without one would be testing nothing.
 */
const returnsOnCall = new Map<string, number>();
const claimsSeen = new Map<string, number>();

/** Instruction → the message a `fail`-claiming step ends the run with
 *  (decisions 1–3). The executor answers `status: 'failed'` + `deliberate` and a
 *  `fail` sub-action: the status is the whole trap, since the step WORKED and a
 *  compiler reading `failed` as "the run broke here" drops it. */
const deliberateFailures = new Map<string, string>();

/** The DOM either side the mock reports when capture was asked for — what
 *  generation reads. Shared by the pass and deliberate-failure shapes. */
const capturedContext = {
  domBefore: '<html><body><button id="go">Go</button></body></html>',
  urlBefore: 'https://example.com/',
  domAfter: '<html><body><h1>Dashboard</h1></body></html>',
  urlAfter: 'https://example.com/dashboard',
};

vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: vi.fn(async (
    stepIndex: number,
    _totalSteps: number,
    instruction: string,
    opts: Record<string, unknown>,
  ): Promise<StepResult> => {
    stepCalls.push({ instruction, opts });
    const claim = opts['flowControlClaim'] as { verb: 'return' | 'stop' | 'fail' } | undefined;
    const deliberateMessage = deliberateFailures.get(instruction);
    if (deliberateMessage !== undefined) {
      return {
        index: stepIndex, instruction, status: 'failed', deliberate: true,
        error: deliberateMessage,
        aiExplanation: "The step's condition held and the step says to fail the test.",
        // The `fail` sub-action's `error` IS the product — the transcript the
        // compiler generates from.
        turns: [{
          turnNumber: 1, attemptNumber: 1, timestamp: new Date().toISOString(), aiInteractions: [],
          subActions: [{
            index: 1,
            action: { action: 'fail', description: 'the cart shows no items' },
            error: deliberateMessage,
            durationMs: 2,
          }],
        }],
        durationMs: 5, retried: false, pageUrl: 'https://example.com/dashboard',
        ...(opts['captureStepContext'] === true && { stepContext: capturedContext }),
      } as StepResult;
    }
    let flowControl: { kind: 'return'; verb: 'return' | 'stop' } | undefined;
    if (claim) {
      const nth = (claimsSeen.get(instruction) ?? 0) + 1;
      claimsSeen.set(instruction, nth);
      // `fail` claims the same option and never answers `return`; its outcome
      // is the map above.
      if (returnsOnCall.get(instruction) === nth && claim.verb !== 'fail') {
        flowControl = { kind: 'return', verb: claim.verb };
      }
    }
    return {
      index: stepIndex,
      instruction,
      status: 'passed',
      ...(flowControl && { flowControl }),
      turns: [
        {
          turnNumber: 1,
          attemptNumber: 1,
          timestamp: new Date().toISOString(),
          aiInteractions: [],
          subActions: [
            {
              index: 1,
              // What the model answers on a flow-control step: `return` when
              // the condition holds, `noop` when it does not. Neither carries
              // a selector or a value, which is the whole reason the
              // placeholder accounting had to be exempted for these steps.
              action: claim
                ? { action: flowControl ? 'return' : 'noop' }
                : { action: 'click', selector: '#go' },
              durationMs: 3,
            },
          ],
        },
      ],
      durationMs: 5,
      retried: false,
      aiExplanation: 'ok',
      pageUrl: 'https://example.com/dashboard',
      // What `captureStepContext` retains, and what generation reads.
      ...(opts['captureStepContext'] === true && { stepContext: capturedContext }),
    } as StepResult;
  }),
  executeBranchedStep: vi.fn(async () => []),
}));

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: vi.fn(async () => ({ files: [], combined: 'PROJECT CONTEXT' })),
}));

/**
 * Every prompt the fake model was asked, with the model the client asking was
 * pointed at. The model is what proves generation ran through the SESSION's
 * own client — a compile-built one would never have seen `syncAuth`.
 */
const aiPrompts: string[] = [];
const aiCalls: { model: string; prompt: string }[] = [];

vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    model = 'base';
    chat = vi.fn(async () => '{}');
    setAiPolicy = vi.fn();
    syncAuth = vi.fn(function (this: { model: string }, model: string) {
      this.model = model;
      return null;
    });
    complete = vi.fn(async function (
      this: { model: string },
      messages: { role: string; content: string }[],
    ) {
      const last = messages[messages.length - 1]?.content ?? '';
      aiPrompts.push(last);
      aiCalls.push({ model: this.model, prompt: last });
      // The review pass gets the file back unchanged, which it reports as
      // "no changes" and leaves the generated file standing.
      if (/Review a generated Playwright code-behind file/.test(last)) {
        return { text: JSON.stringify({ file: fileUnderReview(last) }) };
      }
      // Generation: the JSON envelope the real prompt asks for.
      const source = stepTextIn(last);
      return {
        text: JSON.stringify({
          entry: `{ source: ${JSON.stringify(source)}, async run(ctx) { await ctx.page.click('#go'); } }`,
        }),
      };
    });
  },
}));

/** The candidate file the review prompt embedded, echoed back verbatim. */
function fileUnderReview(prompt: string): string {
  const fenced = /## The file, as generated\s*```ts\n([\s\S]*?)```/.exec(prompt);
  return fenced?.[1] ?? 'export default defineSteps([]);\n';
}

/**
 * The step the generation prompt is about.
 *
 * Read from the shape the prompt spells out — `source: "…"` in the required
 * entry literal — because that is exactly what a real model reads it from,
 * and an entry whose `source` does not match the step binds to nothing.
 */
function stepTextIn(prompt: string): string {
  const quoted = /\n\s*source:\s*("(?:[^"\\]|\\.)*")/.exec(prompt);
  return quoted?.[1] ? (JSON.parse(quoted[1]) as string) : 'step';
}

vi.mock('../src/utils/tokens.js', () => ({
  TokenTracker: class {
    resetStep = vi.fn();
    markRunStart = vi.fn();
    get total() { return 0; }
    get inputTotal() { return 0; }
    get outputTotal() { return 0; }
    get runTotal() { return 77; }
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
// The mocked one above — this is how the carve-out's log line is read back.
import { logger } from '../src/utils/logger.js';
import { SKIPPED_BY_RETURN_REFUSAL } from '../src/codebehind/live-compile.js';
import { readRecording, recordingDirFor } from '../src/codebehind/recording.js';
import { compileLock, compileLockKey } from '../src/server/compile-lock.js';

const API_KEY = 'sk-compile-mode';
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

const STEPS = ['Open the dashboard', 'Search for the order'];

let server: Server;
let baseUrl: string;
let tmpDir: string;
let testFilePath: string;
let stepsFilePath: string;
let sessionSeq = 0;

beforeAll(async () => {
  const { app } = createApiServer(cfg);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) baseUrl = `http://127.0.0.1:${addr.port}`;

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compile-mode-'));
  testFilePath = path.join(tmpDir, 'checkout.md');
  stepsFilePath = path.join(tmpDir, 'checkout.steps.ts');
  await fs.writeFile(
    testFilePath,
    ['# Checkout', '', '## Steps', ...STEPS.map((s, i) => `${i + 1}. ${s}`), ''].join('\n'),
  );
});

afterAll(async () => {
  await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  stepCalls.length = 0;
  aiPrompts.length = 0;
  aiCalls.length = 0;
  returnsOnCall.clear();
  claimsSeen.clear();
  deliberateFailures.clear();
  (logger.info as unknown as { mockClear: () => void }).mockClear();
  await fs.rm(stepsFilePath, { force: true });
  await fs.rm(path.join(tmpDir, '.aiui-codebehind-cache'), { recursive: true, force: true });
});

/** A fresh session per run: the server creates it on first POST. */
function nextSession(): string {
  sessionSeq += 1;
  return `compile-mode-${sessionSeq}`;
}

/** POST the step route as a stream and fold the frames. */
async function runSteps(body: Record<string, unknown>): Promise<{
  status: number;
  frames: { type: string; [k: string]: any }[];
}> {
  const res = await fetch(`${baseUrl}/sessions/${nextSession()}/steps?stream=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, Accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) {
    const parsed = (await res.json()) as { error?: unknown };
    return { status: res.status, frames: [{ type: 'refused', error: String(parsed.error) }] };
  }
  return { status: res.status, frames: await readSse(res) };
}

async function readSse(res: Response): Promise<{ type: string; [k: string]: any }[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const frames: { type: string; [k: string]: any }[] = [];
  let data: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line === '') {
        if (data.length > 0) {
          try { frames.push(JSON.parse(data.join('\n'))); } catch { /* keep-alive */ }
        }
        data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = (colon < 0 ? '' : line.slice(colon + 1)).replace(/^ /, '');
      if (field === 'data') data.push(value);
    }
  }
  return frames;
}

/** The base request a compile-mode run sends. */
function requestBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    steps: STEPS,
    sourceLines: [4, 5],
    testFilePath,
    ...extra,
  };
}

describe('compile on a session that forbids AI', () => {
  /** POST to a NAMED session, so two requests share one — `runSteps` above
   *  deliberately takes a fresh session each time. */
  async function postTo(
    sessionId: string,
    body: Record<string, unknown>,
  ): Promise<{ type: string; [k: string]: any }[]> {
    const res = await fetch(`${baseUrl}/sessions/${sessionId}/steps?stream=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, Accept: 'text/event-stream' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return readSse(res);
  }

  it('still compiles — the switch does not gate a request FOR AI', async () => {
    // Verification item (7) of stories/run-settings.md: a run with `ai: "off"`
    // makes zero AI calls, and Compile This Step on that same session still
    // compiles. The key rides in on the request `.env`, the way the extension
    // ships a project's — this file's server config deliberately has none, and
    // without one the run would be keyless for that reason instead.
    const session = 'compile-ai-off';
    const env = { AI_API_KEY: 'from-dot-env' };

    const plain = await postTo(session, { steps: STEPS, sourceLines: [4, 5], env, runSettings: { ai: 'off' } });
    expect(plain.filter((f) => f.type === 'step:pass')).toHaveLength(2);
    expect(plain.at(-1)!.effectiveSettings.ai).toBe('off');
    expect(plain.at(-1)!.effectiveSettings.aiOffReason).toBe('policy');

    // Same session, retained `ai: off`, and the compile runs anyway.
    const frames = await postTo(session, {
      ...requestBody({ compile: 'run' }),
      env,
    });
    const result = frames.find((f) => f.type === 'compile:result');
    // Same shape every other compile in this file produces — an entry per step,
    // unproven because nothing replays here. What matters is that the switch
    // did not turn it into zero.
    expect(result?.summary.compiled).toBe(2);
    expect(Object.keys(result?.files ?? {})).toEqual([stepsFilePath]);
    expect(result!.files[stepsFilePath]).toContain("source: 'Open the dashboard'");
    expect(result!.files[stepsFilePath]).toContain("source: 'Search for the order'");
    // The generation calls really happened — the assertions above would pass on
    // a proposal that came from somewhere else.
    expect(aiPrompts.length).toBeGreaterThan(0);

    // …and the compile did not consume the session's setting: an ordinary run
    // after it is off again.
    const after = await postTo(session, { steps: STEPS, sourceLines: [4, 5], env });
    expect(after.at(-1)!.effectiveSettings.ai).toBe('off');
  });

  it('carves out the rest of a Run & Compile, and compiles nothing extra', async () => {
    // Rows 2..N of a data-driven Run & Compile (stories/data-driven-rows.md,
    // decision 11). One entry serves every row, so only row 1 carries
    // `compile` — and the AI switch is resolved per BATCH, so on a project with
    // AI off in runs the author's one gesture used to come back as row 1 with a
    // diff and rows 2..N failing "this run forbids AI", for a policy that
    // explicitly carves out the thing they asked for.
    //
    // POSTed through the real entry because `StepRequest` is an explicit
    // per-field allow-list: the bypass computation could be right and the field
    // never reach it. That is how `envName` was lost.
    const session = 'within-compile-run';
    const env = { AI_API_KEY: 'from-dot-env' };

    const row1 = await postTo(session, { ...requestBody({ compile: 'run' }), env, runSettings: { ai: 'off' } });
    expect(row1.at(-1)!.effectiveSettings.ai).toBe('on');
    const promptsAfterRow1 = aiPrompts.length;
    const carveOutLines = (): string[] =>
      (logger.info as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .map((c) => String(c[0]))
        .filter((line) => /withinCompileRun/.test(line));
    // Row 1's own carve-out is the `compile` field's, which announces itself
    // with a proposal — no line, and none wanted.
    expect(carveOutLines()).toEqual([]);

    const row2 = await postTo(session, {
      steps: STEPS,
      sourceLines: [4, 5],
      testFilePath,
      env,
      withinCompileRun: 'run',
    });
    // The carve-out: this batch is not gated, though it asked for no compile.
    expect(row2.at(-1)!.effectiveSettings.ai).toBe('on');
    // And it says so in the log, once, naming the test and the mode. This batch
    // opens no compiler and returns no proposal, so on a project that set
    // `ai.allowInRuns: false` the line is the only place its AI calls are
    // accounted for (stories/run-settings.md §9).
    const afterRow2 = carveOutLines();
    expect(afterRow2).toHaveLength(1);
    expect(afterRow2[0]).toContain('withinCompileRun: run');
    expect(afterRow2[0]).toContain('checkout.md');
    expect(afterRow2[0]).toMatch(/AI allowed for this batch/);
    expect(row2.filter((f) => f.type === 'step:pass')).toHaveLength(2);
    // And that is ALL it does. No compiler was opened, so no proposal came
    // back and no model call was made for an entry.
    expect(row2.find((f) => f.type === 'compile:result')).toBeUndefined();
    expect(aiPrompts.length).toBe(promptsAfterRow1);

    // The session's retained `off` is untouched — a plain batch after it is
    // gated again, which is what makes this per-request rather than a setting.
    const plain = await postTo(session, { steps: STEPS, sourceLines: [4, 5], env });
    expect(plain.at(-1)!.effectiveSettings.ai).toBe('off');
    expect(plain.at(-1)!.effectiveSettings.aiOffReason).toBe('policy');
    // No second line: an ordinary run carries no carve-out, so it claims none.
    expect(carveOutLines()).toHaveLength(1);
  });

  it('runs rows 2..N of a Compile This Step under AI, entry and all', async () => {
    // `withinCompileRun` carries the MODE, and `'steps'` is the mode that
    // disables code-behind EXECUTION so a broken entry re-records under AI.
    // Rows 2..N have to run the same way: the entry on disk is the one row 1 is
    // repairing, the proposal is not applied until the loop ends, and a row
    // that ran it would throw, heal under AI, and paint ⚠ on the very step
    // whose repair is in flight. A boolean field bought the AI carve-out and
    // silently left execution on.
    await fs.writeFile(
      stepsFilePath,
      [
        "import { defineSteps } from 'ai-ui-automation/codebehind';",
        'export default defineSteps([',
        "  { source: 'Open the dashboard', async run() {} },",
        ']);',
        '',
      ].join('\n'),
    );
    const env = { AI_API_KEY: 'from-dot-env' };

    // `'run'` is the other mode, and it must NOT disable execution: a Run &
    // Compile serves a working entry as code on every row.
    await runSteps({ ...requestBody(), env, withinCompileRun: 'run' });
    expect(
      (stepCalls[0]!.opts['codeBehind'] as { entry?: unknown } | undefined)?.entry,
      'a row of a Run & Compile still runs its entry as code',
    ).toBeDefined();

    stepCalls.length = 0;
    await runSteps({ ...requestBody(), env, withinCompileRun: 'steps' });
    expect(
      stepCalls[0]!.opts['codeBehind'],
      'a row of a Compile This Step must run under AI, like the row that compiles',
    ).toBeUndefined();

    await fs.rm(stepsFilePath, { force: true });
  });

  it('refuses "withinCompileRun" alongside a compile, and refuses a bad one', async () => {
    // The pair is not composable — one says "open a compiler", the other says
    // "this batch does not" — and a client sending both has lost track of which
    // row it is on. Refused rather than ranked, for the reason `compile` itself
    // refuses an unknown value: a client that asked for one thing and quietly
    // got another has no way to notice.
    const both = await runSteps(requestBody({ compile: 'run', withinCompileRun: 'run' }));
    expect(both.status).toBe(400);
    expect(both.frames[0]!.error).toMatch(/does NOT compile/);

    // A boolean is what this field used to be, and it is exactly the value that
    // must not be guessed at: `true` cannot say which mode the run is.
    const legacy = await runSteps(requestBody({ withinCompileRun: true }));
    expect(legacy.status).toBe(400);
    expect(legacy.frames[0]!.error).toMatch(/must be "run" or "steps"/);

    // The same demand `compile` makes. This field lifts `ai.allowInRuns: false`
    // for the batch with no stream requirement and no proposal to show for it,
    // so the test file it names is the whole of what ties it to a compile.
    const rootless = await runSteps({ steps: STEPS, sourceLines: [4, 5], withinCompileRun: 'run' });
    expect(rootless.status).toBe(400);
    expect(rootless.frames[0]!.error).toMatch(/requires "testFilePath"/);
  });
});

describe('POST /sessions/:id/steps with compile', () => {
  it('rejects a value that is neither "run" nor "steps"', async () => {
    const result = await runSteps(requestBody({ compile: 'yes' }));
    expect(result.status).toBe(400);
    expect(result.frames[0]!.error).toMatch(/"compile" must be "run" or "steps"/);
  });

  it('refuses a compile with no testFilePath — an entry has nowhere to be written', async () => {
    const result = await runSteps({ steps: STEPS, compile: 'run' });
    expect(result.status).toBe(400);
    expect(result.frames[0]!.error).toMatch(/requires "testFilePath"/);
  });

  it('refuses a compile on the non-streaming route, where the proposal has nowhere to go', async () => {
    const res = await fetch(`${baseUrl}/sessions/${nextSession()}/steps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify(requestBody({ compile: 'run' })),
    });
    expect(res.status).toBe(400);
    expect(String(((await res.json()) as { error?: unknown }).error)).toMatch(/requires \?stream=1/);
    // …and no tokens were spent discovering that.
    expect(stepCalls).toHaveLength(0);
  });

  it('compile:"run" generates an entry per step and proposes the file on the run stream', async () => {
    const { frames } = await runSteps(requestBody({ compile: 'run' }));

    // The run is still a run: the step frames are the ordinary ones.
    expect(frames.filter((f) => f.type === 'step:pass')).toHaveLength(2);
    expect(frames[frames.length - 1]!.type).toBe('done');

    const steps = frames.filter((f) => f.type === 'compile:step' && f.phase === 'generate');
    // Start frame then completion frame, per step
    // (stories/compile-tail-progress.md §The server speaks at starts).
    expect(steps.map((f) => [f.step, f.line, f.message])).toEqual([
      [1, 4, 'generating…'],
      [1, 4, 'generated'],
      [2, 5, 'generating…'],
      [2, 5, 'generated'],
    ]);

    // Terminal, and BEFORE `done` so a client folding the stream has the
    // proposal by the time the run is over.
    const resultAt = frames.findIndex((f) => f.type === 'compile:result');
    expect(resultAt).toBeGreaterThan(-1);
    expect(resultAt).toBeLessThan(frames.length - 1);

    const result = frames[resultAt]!;
    // Every entry this path writes is unproven — there is no Replay — so a
    // pass that produced entries is `partial`, never `green`.
    expect(result.status).toBe('partial');
    expect(result.summary.compiled).toBe(2);
    expect(result.summary.rounds).toBe(0);
    expect(result.summary.unproven).toEqual([1, 2]);
    expect(Object.keys(result.files)).toEqual([stepsFilePath]);
    expect(result.files[stepsFilePath]).toContain("source: 'Open the dashboard'");
    expect(result.files[stepsFilePath]).toContain("source: 'Search for the order'");
  });

it('puts the tail on the wire: a forecast at run end, then counts and a Review start', async () => {
    const { frames } = await runSteps(requestBody({ compile: 'run' }));

    // The forecast lands the moment the last step ends, which is exactly the
    // point the panel would otherwise go quiet (stories/compile-tail-progress.md).
    const forecast = frames.filter(
      (f) => f.type === 'output' && /Run finished — /.test(String(f.msg)),
    );
    expect(forecast.map((f) => f.msg)).toEqual([
      'Run finished — 2 entries still to generate, then a review pass',
    ]);

    // …before any entry is written, which is what makes it a forecast rather
    // than a report.
    const forecastAt = frames.findIndex(
      (f) => f.type === 'output' && /Run finished — /.test(String(f.msg)),
    );
    const firstWritten = frames.findIndex(
      (f) => f.type === 'compile:step' && f.message === 'generated',
    );
    expect(forecastAt).toBeLessThan(firstWritten);

    // The structured half. Exactly one frame is marked `runEnded`, and its
    // total is final.
    const progress = frames.filter((f) => f.type === 'compile:progress');
    const ended = progress.filter((f) => f.runEnded === true);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ done: 0, total: 2, phase: 'generate', reviewPending: true });
    // …and the last one agrees with the summary the run ends with.
    const result = frames.find((f) => f.type === 'compile:result')!;
    expect(progress[progress.length - 1]!.done).toBe(result.summary.compiled);

    // Review announces itself BEFORE its model call — the longest single call
    // the compile makes, and the one that used to say nothing until it was done.
    // Order, not just presence: the structured frame LEADS its prose. A client
    // tells a current server from an older one by whether any progress frame
    // has arrived, and generation starts mid-run — prose first would read as
    // an older server and put the tail UI up while the steps are still going.
    const firstStart = frames.findIndex(
      (f) => f.type === 'compile:step' && f.message === 'generating…',
    );
    const firstProgress = frames.findIndex((f) => f.type === 'compile:progress');
    expect(firstProgress).toBeGreaterThan(-1);
    expect(firstProgress).toBeLessThan(firstStart);

    const review = frames.filter((f) => f.type === 'compile:step' && f.phase === 'review');
    expect(String(review[0]!.message)).toMatch(/^reviewing .*\.steps\.ts…$/);
    expect(progress.some((f) => f.phase === 'review')).toBe(true);
  });

  it('proposes only — the server never writes the .steps.ts itself', async () => {
    await runSteps(requestBody({ compile: 'run' }));
    await expect(fs.access(stepsFilePath)).rejects.toThrow();
  });

  it('turns capture on without being asked, and writes the recording beside the test', async () => {
    await runSteps(requestBody({ compile: 'run' }));

    // The client sent no `captureStepContext`; the server set it, because
    // generation needs the DOM either side of the step.
    expect(stepCalls.every((c) => c.opts['captureStepContext'] === true)).toBe(true);

    const recording = await readRecording(testFilePath);
    expect(recording).not.toBeNull();
    expect(recording!.manifest.steps).toBe(2);
    expect(recording!.steps[0]!.source).toBe('Open the dashboard');
    expect(recording!.steps[0]!.recordedAt).toBeTruthy();
    expect(recording!.steps[0]!.domBefore).toContain('<button id="go">');
  });

  it('runs Review on the "run" path and not on the "steps" path', async () => {
    const forRun = await runSteps(requestBody({ compile: 'run' }));
    expect(forRun.frames.some((f) => f.type === 'compile:step' && f.phase === 'review')).toBe(true);
    expect(aiPrompts.some((p) => /Review a generated Playwright code-behind file/.test(p))).toBe(true);

    aiPrompts.length = 0;
    const forSteps = await runSteps(requestBody({ steps: [STEPS[1]!], sourceLines: [5], compile: 'steps' }));
    expect(forSteps.frames.some((f) => f.type === 'compile:step' && f.phase === 'review')).toBe(false);
    expect(aiPrompts.some((p) => /Review a generated Playwright code-behind file/.test(p))).toBe(false);
  });

  it('compile:"steps" runs the step with code-behind execution disabled', async () => {
    // A real entry on disk, so the difference between the two modes is
    // whether the executor is handed a binding to run.
    await fs.writeFile(
      stepsFilePath,
      [
        "import { defineSteps } from 'ai-ui-automation/codebehind';",
        'export default defineSteps([',
        "  { source: 'Open the dashboard', async run() {} },",
        ']);',
        '',
      ].join('\n'),
    );

    await runSteps(requestBody({ compile: 'run' }));
    const underRun = stepCalls[0]!.opts['codeBehind'] as { entry?: unknown } | undefined;
    expect(underRun?.entry, 'a Run & Compile serves a working entry as code').toBeDefined();

    stepCalls.length = 0;
    await runSteps(requestBody({ steps: [STEPS[0]!], sourceLines: [4], compile: 'steps' }));
    expect(
      stepCalls[0]!.opts['codeBehind'],
      'Compile This Step must run under AI, so the broken entry re-records',
    ).toBeUndefined();

    // …and the binding is still resolved for generation, which is the whole
    // reason the two registries are separate.
    await fs.rm(stepsFilePath, { force: true });
  });

  it('compile:"steps" splices the recording, leaving the siblings untouched', async () => {
    await runSteps(requestBody({ compile: 'run' }));
    const before = await readRecording(testFilePath);
    expect(before!.steps).toHaveLength(2);

    // The clock has one-millisecond resolution and the two runs are fast;
    // without this the "fresh vs untouched" comparison could tie.
    await new Promise((r) => setTimeout(r, 5));

    await runSteps(requestBody({ steps: [STEPS[1]!], sourceLines: [5], compile: 'steps' }));
    const after = await readRecording(testFilePath);

    expect(after!.steps).toHaveLength(2);
    // Matched by authored text + section scope, never by index: the request
    // sent one step and it landed in step 2's slot, not step 1's.
    expect(after!.steps[0]!.source).toBe('Open the dashboard');
    expect(after!.steps[1]!.source).toBe('Search for the order');
    expect(after!.steps[0]!.recordedAt).toBe(before!.steps[0]!.recordedAt);
    expect(after!.steps[1]!.recordedAt).not.toBe(before!.steps[1]!.recordedAt);
  });

  it('a single-step compile proposes exactly one entry', async () => {
    const { frames } = await runSteps(
      requestBody({ steps: [STEPS[1]!], sourceLines: [5], compile: 'steps' }),
    );
    const result = frames.find((f) => f.type === 'compile:result')!;
    expect(result.summary.compiled).toBe(1);
    const proposed = result.files[stepsFilePath] as string;
    expect(proposed).toContain("source: 'Search for the order'");
    expect(proposed).not.toContain("source: 'Open the dashboard'");
  });

describe('recompiling a step whose entry broke', () => {
    // Repair parity. In `'run'` the failure arrives in band: the entry threw
    // during that very run. In `'steps'` it cannot — code-behind execution is
    // disabled for the request, which is what makes the step re-record under
    // AI, so the entry never runs and never throws. The last-run sidecar on
    // disk is where the ⚠ the author is looking at came from, and the only
    // record of what broke.
    const BROKEN = [
      "import { defineSteps } from 'ai-ui-automation/codebehind';",
      'export default defineSteps([',
      "  { source: 'Open the dashboard', async run(ctx) { await ctx.page.click('a[href=\"/x\"]'); } },",
      ']);',
      '',
    ].join('\n');

    beforeEach(async () => {
      await fs.writeFile(stepsFilePath, BROKEN, 'utf-8');
      await fs.mkdir(path.join(tmpDir, '.aiui-codebehind-cache'), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, '.aiui-codebehind-cache', 'checkout.last-run.json'),
        JSON.stringify({
          test: testFilePath,
          ranAt: new Date().toISOString(),
          steps: [
            {
              index: 1,
              source: 'Open the dashboard',
              status: 'passed',
              fromCodeBehind: false,
              stale: true,
              error: 'strict mode violation: locator resolved to 2 elements',
            },
          ],
        }),
        'utf-8',
      );
    });

    afterEach(async () => {
      await fs.rm(stepsFilePath, { force: true });
    });

    it('repairs from the sidecar in "steps" mode, where nothing throws in band', async () => {
      await runSteps(requestBody({ steps: [STEPS[0]!], sourceLines: [4], compile: 'steps' }));

      const asked = aiPrompts.filter((p) => !/Review a generated/.test(p));
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain('A generated code-behind entry was replayed and it failed');
      // The error the sidecar recorded, and the code that produced it.
      expect(asked[0]).toContain('strict mode violation: locator resolved to 2 elements');
      expect(asked[0]).toContain("ctx.page.click('a[href=\"/x\"]')");
    });

    it('leaves a step the sidecar does NOT flag on the plain prompt', async () => {
      // Step 2 has no row in the sidecar at all.
      await runSteps(requestBody({ steps: [STEPS[1]!], sourceLines: [5], compile: 'steps' }));
      const asked = aiPrompts.filter((p) => !/Review a generated/.test(p));
      expect(asked[0]).not.toContain('A generated code-behind entry was replayed');
      expect(asked[0]).toContain('## The whole test');
    });
  });

  describe('a single-step compile of a section body', () => {
    // The step runs detached at the root frame, as Run Step Here runs it, but
    // its ENTRY has to bind under the section — that is where the runtime,
    // which reaches the step through the section, looks for it. The user hit
    // this live: our review round had refused it outright.
    it('binds the entry under the section scope the client attributed', async () => {
      const { frames } = await runSteps(
        requestBody({
          steps: ['Type the username'],
          sourceLines: [12],
          compile: 'steps',
          compileScope: { section: 'Sign in' },
        }),
      );
      const result = frames.find((f) => f.type === 'compile:result')!;
      const proposed = result.files[stepsFilePath] as string;
      expect(proposed).toContain("source: 'Type the username'");
      // The scope stamp is the whole point — without it the entry binds
      // top-level and the runtime never matches it.
      expect(proposed).toContain("section: 'Sign in'");
      expect(result.summary.compiled).toBe(1);
    });

    it('records the step under the section, so a later splice finds its slot', async () => {
      await runSteps(
        requestBody({
          steps: ['Type the username'],
          sourceLines: [12],
          compile: 'steps',
          compileScope: { section: 'Sign in' },
        }),
      );
      const recording = await readRecording(testFilePath);
      expect(recording!.steps[0]!.section).toBe('Sign in');
      expect(recording!.steps[0]!.source).toBe('Type the username');
      expect(recording!.steps[0]!.occurrence).toBe(0);
    });

    it('refuses a scope on anything but a single-step compile', async () => {
      const onRun = await runSteps(requestBody({ compile: 'run', compileScope: { section: 'X' } }));
      expect(onRun.status).toBe(400);
      expect(onRun.frames[0]!.error).toMatch(/only valid with "compile": "steps"/);

      const bare = await runSteps(requestBody({ compileScope: { section: 'X' } }));
      expect(bare.status).toBe(400);
    });

    it('refuses a malformed scope rather than compiling to the top level', async () => {
      for (const bad of [{}, { section: '' }, { section: 42 }, [], null]) {
        const res = await runSteps(requestBody({ steps: ['x'], sourceLines: [4], compile: 'steps', compileScope: bad }));
        expect(res.status, JSON.stringify(bad)).toBe(400);
      }
    });
  });

  describe('a run split across several requests', () => {
    // An `[input:]` or `[interactive]` step, or a breakpoint, ends one batch
    // and leaves the client to send the rest. Each block used to get its own
    // compiler: its own candidate read from the (unapplied) file, its own step
    // numbering from 1, and its own wholesale recording write that deleted the
    // previous block's. The author got a diff for the tail of their test only.
    const SPLIT_SESSION = 'compile-split';

    async function block(
      body: Record<string, unknown>,
    ): Promise<{ type: string; [k: string]: any }[]> {
      const res = await fetch(`${baseUrl}/sessions/${SPLIT_SESSION}/steps?stream=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, Accept: 'text/event-stream' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      return readSse(res);
    }

    it('keeps one candidate, one numbering and one recording across the blocks', async () => {
      await block({ steps: [STEPS[0]!], sourceLines: [4], testFilePath, compile: 'run' });
      const second = await block({
        steps: [STEPS[1]!],
        sourceLines: [5],
        testFilePath,
        compile: 'run',
        compileContinues: true,
      });

      const generated = second.filter(
        (f) => f.type === 'compile:step' && f.message === 'generated',
      );
      // Step TWO of the run, on line 5 — not step one all over again.
      expect(generated.map((f) => [f.step, f.line])).toEqual([[2, 5]]);

      const result = second.find((f) => f.type === 'compile:result')!;
      // One file carrying BOTH entries: block 2 continued block 1's candidate
      // instead of re-reading a file nobody has applied yet.
      expect(result.files[stepsFilePath]).toContain("source: 'Open the dashboard'");
      expect(result.files[stepsFilePath]).toContain("source: 'Search for the order'");
      expect(result.summary.compiled).toBe(2);
      expect(result.summary.totalSteps).toBe(2);
      expect(result.summary.unproven).toEqual([1, 2]);

      // …and the recording holds both steps, not just the last block's.
      const recording = await readRecording(testFilePath);
      expect(recording!.steps.map((s) => s.source)).toEqual([
        'Open the dashboard',
        'Search for the order',
      ]);
      expect(recording!.manifest.steps).toBe(2);
    });

    it('a fresh compile supersedes one the previous run abandoned', async () => {
      await block({ steps: [STEPS[0]!], sourceLines: [4], testFilePath, compile: 'run' });
      // No `compileContinues`: a new logical run. The abandoned compiler must
      // be discarded, not continued, or its entries would ride along and its
      // step numbers would keep climbing.
      const fresh = await block({ steps: [STEPS[0]!], sourceLines: [4], testFilePath, compile: 'run' });
      const generated = fresh.filter(
        (f) => f.type === 'compile:step' && f.message === 'generated',
      );
      expect(generated.map((f) => f.step)).toEqual([1]);
      const result = fresh.find((f) => f.type === 'compile:result')!;
      expect(result.summary.totalSteps).toBe(1);
      expect(result.summary.compiled).toBe(1);
    });
  });

  it('generates on the session\'s own client, so a runSettings model override covers it too', async () => {
    // The asymmetry this fixes (stories/compile-as-you-go.md §The model): a
    // session's model override applied to the run and not to generation,
    // because the boxed compile built its own client from the server base.
    await runSteps(requestBody({ compile: 'run', runSettings: { model: 'override/model' } }));

    const generation = aiCalls.filter((c) => !/Review a generated/.test(c.prompt));
    const review = aiCalls.filter((c) => /Review a generated/.test(c.prompt));
    expect(generation.length).toBeGreaterThan(0);
    expect(review.length).toBeGreaterThan(0);
    expect(generation.every((c) => c.model === 'override/model')).toBe(true);
    expect(review.every((c) => c.model === 'override/model')).toBe(true);
  });

  it('refuses a second compile of the same file with a 409, before the stream opens', async () => {
    // The lock is shared with `POST /codebehind/compile`
    // (stories/compile-as-you-go.md §On the wire): both propose a whole
    // `.steps.ts`, and the second Apply would silently discard the first's
    // entries. Held here rather than raced, because the 409 only exists as a
    // status code — once `flushHeaders` has run the answer is a 200.
    const release = compileLock.acquire(testFilePath)!;
    expect(release).toBeTruthy();
    try {
      const refused = await runSteps(requestBody({ compile: 'run' }));
      expect(refused.status).toBe(409);
      expect(refused.frames[0]!.error).toMatch(/already running/);

      // Per file, not global: another test compiles while this one is held.
      const other = path.join(tmpDir, 'other.md');
      await fs.writeFile(other, '# Other\n\n## Steps\n1. Open the settings page\n');
      const allowed = await runSteps({ steps: ['Open the settings page'], testFilePath: other, compile: 'run' });
      expect(allowed.status).toBe(200);
      expect(allowed.frames.some((f) => f.type === 'compile:result')).toBe(true);
    } finally {
      release();
    }
    // And released: the same file compiles again immediately after.
    const again = await runSteps(requestBody({ compile: 'run' }));
    expect(again.status).toBe(200);
  });

  it('folds the drive-letter case, so two spellings of one file take one lock', () => {
    // TestBench's paths come from `uri.fsPath`, which lower-cases the drive;
    // a CLI or MCP caller's usually does not.
    if (process.platform !== 'win32') return;
    expect(compileLockKey('C:\\Projects\\a\\b.md')).toBe(compileLockKey('c:\\Projects\\a\\b.md'));
  });

  it('an ordinary run does not take the compile lock', async () => {
    await runSteps(requestBody());
    expect(compileLock.isLocked(testFilePath)).toBe(false);
  });

  it('an ordinary run captures nothing and emits no compile frames', async () => {
    const { frames } = await runSteps(requestBody());
    expect(stepCalls.every((c) => c.opts['captureStepContext'] === undefined)).toBe(true);
    expect(frames.some((f) => f.type.startsWith('compile:'))).toBe(false);
    expect(await readRecording(testFilePath)).toBeNull();
    expect(recordingDirFor(testFilePath)).toContain('.aiui-codebehind-cache');
  });

  describe('compile:"steps" riding a startAt/endAt slice — a skill-file single-step compile', () => {
    // stories/specs/run-and-compile-a-skill-step.md: the picker's compile pick
    // sends the test's `[skill:]` call line with a slice bounding execution to
    // the clicked skill step. `compile` + `startAt` was a combination nothing
    // could send before that feature, so every seam here is new: the sliced
    // plan, the bounded summary, the skill-frame binding, and the refusals'
    // terminal `compile:result`.
    let callerPath: string;
    let capturePath: string;
    let captureCallerPath: string;
    let repeatedPath: string;
    let repeatedCallerPath: string;
    let skillsDir: string;
    let skillPath: string;
    let skillStepsPath: string;

    beforeAll(async () => {
      skillsDir = path.join(tmpDir, 'skills');
      await fs.mkdir(skillsDir, { recursive: true });

      callerPath = path.join(tmpDir, 'caller.md');
      await fs.writeFile(callerPath, '# Caller\n\n## Steps\n1. [skill: login]\n');
      skillPath = path.join(skillsDir, 'login.md');
      skillStepsPath = path.join(skillsDir, 'login.steps.ts');
      await fs.writeFile(
        skillPath,
        '# login\n\n## Steps\n1. Fill the username box\n2. Press the go button\n3. Open the profile menu\n',
      );

      // A skill whose second step consumes the first step's in-skill capture —
      // the expander renames those `__skillN_…`, which is what the partial
      // re-run guard keys on.
      captureCallerPath = path.join(tmpDir, 'caller-capture.md');
      await fs.writeFile(captureCallerPath, '# Caller\n\n## Steps\n1. [skill: capture]\n');
      capturePath = path.join(skillsDir, 'capture.md');
      await fs.writeFile(
        capturePath,
        '# capture\n\n## Steps\n1. Capture the order id [store as: oid]\n2. Open order {{oid}}\n',
      );

      // A skill that says the same thing twice — the occurrence hazard.
      repeatedCallerPath = path.join(tmpDir, 'caller-repeated.md');
      await fs.writeFile(repeatedCallerPath, '# Caller\n\n## Steps\n1. [skill: repeated]\n');
      repeatedPath = path.join(skillsDir, 'repeated.md');
      await fs.writeFile(
        repeatedPath,
        '# repeated\n\n## Steps\n1. Press the go button\n2. Press the go button\n',
      );
    });

    beforeEach(async () => {
      await fs.rm(path.join(skillsDir, 'login.steps.ts'), { force: true });
      await fs.rm(path.join(skillsDir, 'repeated.steps.ts'), { force: true });
      await fs.rm(path.join(skillsDir, '.aiui-codebehind-cache'), { recursive: true, force: true });
    });

    function sliceBody(line: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        steps: ['[skill: login]'],
        sourceLines: [4],
        testFilePath: callerPath,
        skillsDir,
        compile: 'steps',
        startAt: { uri: skillPath, line },
        endAt: { uri: skillPath, line },
        ...extra,
      };
    }

    it('runs only the sliced step and binds its entry into the SKILL\'s .steps.ts', async () => {
      const { frames } = await runSteps(sliceBody(5));

      // Execution: exactly the clicked step, under AI (code-behind off).
      expect(stepCalls.map((c) => c.instruction)).toEqual(['Press the go button']);
      expect(stepCalls[0]!.opts['codeBehind']).toBeUndefined();

      // Generation: the step's own expanded number and skill-file line.
      const generated = frames.filter((f) => f.type === 'compile:step' && f.phase === 'generate');
      expect(generated.map((f) => [f.step, f.line, f.message])).toEqual([
        [2, 5, 'generating…'],
        [2, 5, 'generated'],
      ]);

      // The entry lands where a whole-test compile binds it: the skill's own
      // file, from the run's real skill frame — no compileScope involved.
      const result = frames.find((f) => f.type === 'compile:result')!;
      expect(result.status).toBe('partial');
      expect(Object.keys(result.files)).toEqual([skillStepsPath]);
      expect(result.files[skillStepsPath]).toContain("source: 'Press the go button'");
      expect(result.files[skillStepsPath]).not.toContain('Fill the username box');
      expect(result.summary.unproven).toEqual([2]);
    });

    it('reports the slice honestly: 1 of 1, nothing "not attempted"', async () => {
      const { frames } = await runSteps(sliceBody(5));
      const result = frames.find((f) => f.type === 'compile:result')!;
      // The plan spans the whole expansion (occurrence counting needs it);
      // the summary must not: a clean single-step compile is not a partial
      // sweep of a six-step skill.
      expect(result.summary.totalSteps).toBe(1);
      expect(result.summary.compiled).toBe(1);
      expect(result.summary.notAttempted).toEqual([]);
      expect(result.summary.stoppedAt).toBeUndefined();
    });

    it('splices the recording under the CALLER, stamped with the skill\'s target file', async () => {
      await runSteps(sliceBody(5));
      const recording = await readRecording(callerPath);
      const recorded = recording!.steps.filter(Boolean);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.source).toBe('Press the go button');
      // The discriminator that keeps this splice off an identically-worded
      // test-frame step's slot.
      expect(recorded[0]!.file).toBe(skillStepsPath);
    });

    it('a startAt that matches nothing terminates the compile with the refusal, not silence', async () => {
      const { frames } = await runSteps(sliceBody(999));
      expect(stepCalls).toHaveLength(0);

      // Without this frame the client's no-outcome branch answers "is the
      // server on a build that supports Run & Compile?" — a misdiagnosis
      // stacked on a perfectly good refusal.
      const result = frames.find((f) => f.type === 'compile:result')!;
      expect(result.status).toBe('failed');
      expect(result.summary.error).toMatch(/Re-run anchor not found/);
      expect(frames[frames.length - 1]!.type).toBe('done');

      // The compile is over: nothing left open on the session, no lock held.
      expect(compileLock.isLocked(callerPath)).toBe(false);
    });

    it('a step needing a skipped step\'s in-skill capture refuses with usable advice', async () => {
      const { frames } = await runSteps({
        steps: ['[skill: capture]'],
        sourceLines: [4],
        testFilePath: captureCallerPath,
        skillsDir,
        compile: 'steps',
        startAt: { uri: capturePath, line: 5 },
        endAt: { uri: capturePath, line: 5 },
      });
      const result = frames.find((f) => f.type === 'compile:result')!;
      expect(result.status).toBe('failed');
      // Not "Use Continue" — that button only exists on the paused-test
      // surface, and this refusal now reaches the skill-file gutter too.
      expect(result.summary.error).toMatch(/Start the run from the step that produces it/);
      expect(compileLock.isLocked(captureCallerPath)).toBe(false);
    });

    it('refuses to compile ONE occurrence of a repeated step — the entry would land on the wrong one', async () => {
      const { frames } = await runSteps({
        steps: ['[skill: repeated]'],
        sourceLines: [4],
        testFilePath: repeatedCallerPath,
        skillsDir,
        compile: 'steps',
        startAt: { uri: repeatedPath, line: 5 },
        endAt: { uri: repeatedPath, line: 5 },
      });
      // Before anything runs or spends a token: `spliceEntry` would APPEND the
      // occurrence-1 entry into an empty file, where it reads as occurrence 0
      // and serves the FIRST step.
      expect(stepCalls).toHaveLength(0);
      const result = frames.find((f) => f.type === 'compile:result')!;
      expect(result.status).toBe('failed');
      expect(result.summary.error).toMatch(/appears more than once/);
    });

    it('compiles a repeated step when every occurrence is inside the slice, in order', async () => {
      const { frames } = await runSteps({
        steps: ['[skill: repeated]'],
        sourceLines: [4],
        testFilePath: repeatedCallerPath,
        skillsDir,
        compile: 'steps',
        startAt: { uri: repeatedPath, line: 4 },
        endAt: { uri: repeatedPath, line: 5 },
      });
      const result = frames.find((f) => f.type === 'compile:result')!;
      expect(result.status).toBe('partial');
      expect(result.summary.compiled).toBe(2);
      expect(result.summary.totalSteps).toBe(2);
      const proposed = result.files[path.join(skillsDir, 'repeated.steps.ts')] as string;
      expect((proposed.match(/source: 'Press the go button'/g) ?? []).length).toBe(2);
    });

    it('does not refuse a Run & Compile CONTINUATION that carries a slice', async () => {
      // The occurrence guard belongs to the single-step path. A `'run'`-mode
      // continuation also carries `startAt` — a Continue that resumes inside a
      // section body sends `rerun` — and there the earlier occurrence's entry
      // lives in the RETAINED compiler's candidate, not on disk, so the guard's
      // "no entry yet" test would see it missing and kill the user's whole run
      // over a compile bookkeeping rule.
      const session = `compile-run-slice-${Date.now()}`;
      const post = async (body: Record<string, unknown>) => {
        const res = await fetch(`${baseUrl}/sessions/${session}/steps?stream=1`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            Accept: 'text/event-stream',
          },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(200);
        return readSse(res);
      };

      await post({
        steps: ['[skill: repeated]'],
        sourceLines: [4],
        testFilePath: repeatedCallerPath,
        skillsDir,
        compile: 'run',
      });
      const second = await post({
        steps: ['[skill: repeated]'],
        sourceLines: [4],
        testFilePath: repeatedCallerPath,
        skillsDir,
        compile: 'run',
        compileContinues: true,
        startAt: { uri: repeatedPath, line: 5 },
        endAt: { uri: repeatedPath, line: 5 },
      });

      const result = second.find((f) => f.type === 'compile:result')!;
      expect(result.summary.error ?? '').not.toMatch(/appears more than once/);
      expect(second.find((f) => f.type === 'done')!.status).not.toBe('error');

      // A `'run'` compile is RETAINED on the session by design (that is what
      // carries a split run across blocks), and its candidate keeps writing
      // under the shared cache dir. Left open, it races the next case's
      // `beforeEach` cleanup — measured as ENOTEMPTY plus a cascade of
      // timeouts. Closing the session discards it.
      await fetch(`${baseUrl}/sessions/${session}`, {
        method: 'DELETE',
        headers: { 'x-api-key': API_KEY },
      });
    });

    it('a plain slice with no compile stays a plain slice — no compile frames, no refusal result', async () => {
      const { frames } = await runSteps({
        steps: ['[skill: login]'],
        sourceLines: [4],
        testFilePath: callerPath,
        skillsDir,
        startAt: { uri: skillPath, line: 5 },
        endAt: { uri: skillPath, line: 5 },
      });
      expect(stepCalls.map((c) => c.instruction)).toEqual(['Press the go button']);
      expect(frames.some((f) => f.type.startsWith('compile:'))).toBe(false);
    });
  });
});

/**
 * A compile of a run that RETURNED (stories/step-flow-control.md, decision 12).
 *
 * **Through the real HTTP entry, and deliberately not against `LiveCompiler`
 * directly.** The compiler has had the skipped-step branch since the feature
 * landed — `generationRefusal` answers `SKIPPED_BY_RETURN_REFUSAL` for
 * `status: 'skipped'`, and `finish` folds `skippedByReturn` into
 * `notAttempted` — and a unit test that handed it a hand-built skipped
 * `StepResult` passed all along. Nothing produced one: the server's skip loop
 * built the results, pushed them to the report, and never offered them, so the
 * whole branch was unreachable in production. A Run & Compile of a test that
 * returns wrote entries for the steps that ran and said nothing whatever about
 * the rest. Only the composition can see that, which is why it is here.
 */
describe('compile a run whose section returns', () => {
  const RETURN_STEP = 'If the page title contains "Dashboard" then return';

  /**
   * The live fixture's shape, one section shorter.
   *
   *   4. Open the dashboard        <- main
   *   5. Sign in                   <- main, calls the section
   *   6. Sign in                   <- main, calls it again
   *   7. Search for the order      <- main
   *   ### Sign in                  (heading, line 10)
   *   11. If … then return
   *   12. Enter the username
   *   13. Click Sign in
   *
   * Expanded, eight steps: 1 main, then the body three times over two calls,
   * then the last main step. With the condition holding on the SECOND call,
   * steps 6 and 7 never run.
   */
  const returningBody = (extra: Record<string, unknown> = {}) => ({
    steps: ['Open the dashboard', 'Sign in', 'Sign in', 'Search for the order'],
    sourceLines: [4, 5, 6, 7],
    testFilePath,
    sections: {
      'sign in': {
        name: 'Sign in',
        headingLine: 10,
        steps: [RETURN_STEP, 'Enter the username', 'Click Sign in'],
        stepLines: [11, 12, 13],
      },
    },
    ...extra,
  });

  it('names the steps it never saw, and still compiles everything it did', async () => {
    returnsOnCall.set(RETURN_STEP, 2);
    const { frames } = await runSteps(returningBody({ compile: 'run' }));

    // The run half first: the second call returned at its first body line, so
    // the two body lines after it are skipped and nothing else is.
    expect(frames.filter((f) => f.type === 'step:skip').map((f) => f.line)).toEqual([12, 13]);

    const result = frames.find((f) => f.type === 'compile:result')!;
    // Empty, and that is the composition with the entry-key dedupe
    // (stories/data-driven-rows.md, live-compile.ts `takenKeys`). Steps 6 and 7
    // are the SECOND call's body — the same two authored lines the FIRST call
    // already ran and compiled, binding to the same two entries. So they are in
    // the proposal below, and naming them not-attempted would tell the author
    // two steps have no entry while handing them the entry. `notAttempted` is
    // owed per ENTRY, not per inlining of one.
    expect(result.summary.notAttempted).toEqual([]);
    // The per-step reason is still on the stream, because it is a statement
    // about the RUN — these two lines did not execute — which is true either
    // way and is the only place the author can see WHICH lines the return left
    // behind.
    const declined = frames.filter(
      (f) => f.type === 'compile:step' && f.message === SKIPPED_BY_RETURN_REFUSAL,
    );
    expect(declined.map((f) => [f.step, f.line])).toEqual([[6, 12], [7, 13]]);

    // And the other half of decision 12: a return is not the end of the
    // recording. The returning step compiles (the conditional form is exactly
    // what this story adds to the compiler), and so does the main-flow step
    // AFTER the flow that ended.
    //
    // FIVE entries, not one per expanded step: the two main-flow steps plus the
    // body's three authored lines, generated from the first call and deduped on
    // the second. The section is called twice, and `entryKeyOf`'s occurrence
    // restarts per frame instance, so both calls' lines share one key each.
    expect(result.summary.compiled).toBe(5);
    const proposed = result.files[stepsFilePath] as string;
    expect(proposed).toContain(`source: 'If the page title contains "Dashboard" then return'`);
    expect(proposed).toContain("source: 'Search for the order'");
    expect(proposed).toContain("section: 'Sign in'");
    // Unproven, never green: the entries exist and nothing replayed them.
    expect(result.status).toBe('partial');
  });

  it('says so even when the return left NOTHING to compile in the body', async () => {
    // The first call returns, so the body's other two lines never run at all
    // and no entry is written for either. Without the offer this compile
    // reported `notAttempted: []` — a proposal missing two of the author's
    // steps with nothing anywhere saying why.
    returnsOnCall.set(RETURN_STEP, 1);
    const { frames } = await runSteps(
      returningBody({ compile: 'run', steps: ['Open the dashboard', 'Sign in'], sourceLines: [4, 5] }),
    );

    const result = frames.find((f) => f.type === 'compile:result')!;
    expect(result.summary.notAttempted).toEqual([3, 4]);
    const proposed = result.files[stepsFilePath] as string;
    expect(proposed).not.toContain("source: 'Enter the username'");
    expect(proposed).not.toContain("source: 'Click Sign in'");
    // The steps that DID run are still there, return step included.
    expect(proposed).toContain("source: 'Open the dashboard'");
    expect(proposed).toContain(`source: 'If the page title contains "Dashboard" then return'`);
  });

  it('a LATER call compiling what an earlier one skipped clears the debt', async () => {
    // The other order, and the one that decides where the two answers meet.
    // The FIRST call returns, so steps 3 and 4 are recorded as skipped before
    // anything has generated their entries; the SECOND call runs the same two
    // lines and generates them. An offer-time check could not see that — the
    // key is taken after the skip is recorded — so `finish` is where the debt is
    // netted off, exactly as the `kept` getter nets a key that ended up
    // generated.
    returnsOnCall.set(RETURN_STEP, 1);
    const { frames } = await runSteps(returningBody({ compile: 'run' }));

    // The run half: it was the first call's body that got skipped.
    expect(frames.filter((f) => f.type === 'step:skip').map((f) => f.line)).toEqual([12, 13]);
    const declined = frames.filter(
      (f) => f.type === 'compile:step' && f.message === SKIPPED_BY_RETURN_REFUSAL,
    );
    expect(declined.map((f) => f.step)).toEqual([3, 4]);

    const result = frames.find((f) => f.type === 'compile:result')!;
    // Nothing owed: both lines are in the proposal, written from call 2.
    expect(result.summary.notAttempted).toEqual([]);
    const proposed = result.files[stepsFilePath] as string;
    expect(proposed).toContain("source: 'Enter the username'");
    expect(proposed).toContain("source: 'Click Sign in'");
  });

  it('leaves a run that returned nowhere alone — no notAttempted, byte for byte as before', async () => {
    // The narrowness check: the same test, same shape, condition never holds.
    // Every step runs, every step compiles, and the summary says nothing about
    // skips, so nothing this change added can leak into an ordinary compile.
    const { frames } = await runSteps(returningBody({ compile: 'run' }));

    expect(frames.some((f) => f.type === 'step:skip')).toBe(false);
    const result = frames.find((f) => f.type === 'compile:result')!;
    expect(result.summary.notAttempted).toEqual([]);
    // Eight steps ran; five ENTRIES came out, because the section is called
    // twice and one entry serves both calls — the same count the boxed
    // pipeline's `selectSteps` reaches, and the same number the test above
    // reports for the returning variant. `totalSteps` is what counts expanded
    // steps.
    expect(result.summary.compiled).toBe(5);
    expect(result.summary.totalSteps).toBe(8);
  });
});

/**
 * The `fail` verb through a Run & Compile (stories/step-failure-outcomes.md
 * §"What the compile showed"). Taught twice — the boxed pipeline reads the
 * recording on disk, this one the run it rides — because a deliberate failure
 * arriving in `stoppedAt` made a Run & Compile answer "Step 9 failed under AI …
 * Fix it, run, and compile again" over a step that did what its line says.
 */
describe('compile a run a step\'s own text ended', () => {
  const FAIL_STEP = 'If the cart is empty then fail the test with error "Nothing to check out"';
  const MESSAGE = 'Nothing to check out';

  // Row 1 ends the run mid-list, row 2 on its last step. Every field below is
  // asserted for both rows; only the table's values differ.
  it.each([
    ['reports where the run ENDED, never where it stopped, and compiles the ending step',
      ['Open the dashboard', FAIL_STEP, 'Search for the order'],
      { step: 2, error: MESSAGE, line: FAIL_STEP }, [3],
      `the run ended at step 2 as its text says (${FAIL_STEP})`],
    ['leaves nothing unattempted when the ending step is the last one',
      ['Open the dashboard', FAIL_STEP], undefined, [], undefined],
  ] as const)('%s', async (_label, steps, endedAsWritten, notAttempted, error) => {
    deliberateFailures.set(FAIL_STEP, MESSAGE);
    const { frames } = await runSteps(requestBody({
      steps: [...steps], sourceLines: steps.map((_, i) => 4 + i), compile: 'run',
    }));

    // The run half first, so the compile half is read off a real run: step 2
    // failed as written, flag and all, and nothing after it started.
    expect(
      frames.filter((f) => f.type === 'step:fail').map((f) => [f.line, f.deliberate, f.error]),
    ).toEqual([[5, true, MESSAGE]]);
    expect(frames.filter((f) => f.type === 'step:start')).toHaveLength(2);

    const result = frames.find((f) => f.type === 'compile:result')!;
    // The whole finding: the field meaning "the run broke here" is empty, and
    // "the run ended here" carries the step, the message and the authored line —
    // but only while steps remain after the ending one, which is the BOXED
    // compiler's rule, the field being the answer to "why has step N no entry".
    // This path used to set it on every ending, so a summary carried the field
    // and an `error` `aiui compile` never wrote — and a `green` carrying an
    // `error` is what made `compileResultLine` say "◐ Compiled nothing…".
    expect(result.summary.stoppedAt).toBeUndefined();
    expect(result.summary.endedAsWritten).toEqual(endedAsWritten);
    expect(result.summary.notAttempted).toEqual(notAttempted);
    // The reason line a client with no headline of its own reads, in the boxed
    // compiler's words.
    expect(result.summary.error).toEqual(error);
    // The ending step is IN the proposal — it did its work, so there is a
    // transcript — and any step past it is named, not silently missing.
    expect(result.summary.compiled).toBe(2);
    expect(result.files[stepsFilePath]).toContain(FAIL_STEP);
    // `partial` either way, and not because of the ending: every entry this path
    // writes is unproven, so a pass that produced entries is never green.
    expect(result.status).toBe('partial');
  });

  describe('with the ending step already opted out as `ai: true`', () => {
    // Nothing to generate for it, so `attempted` is 0 and the "nothing to do"
    // arithmetic is under test — where dropping `stoppedAt` could turn a partial
    // into a green.
    const optedOut = [
      "import { defineSteps } from 'ai-ui-automation/codebehind';",
      'export default defineSteps([',
      `  { source: ${JSON.stringify(FAIL_STEP)}, ai: true },`,
      ']);',
      '',
    ].join('\n');

    beforeEach(async () => {
      await fs.writeFile(stepsFilePath, optedOut, 'utf-8');
      deliberateFailures.set(FAIL_STEP, MESSAGE);
    });
    afterEach(async () => {
      await fs.rm(stepsFilePath, { force: true });
    });

    // Row 1 is green and clean with it: no gap after the ending step, so the
    // field does not travel and nothing contradicts the status the way a `green`
    // carrying an `error` did. Row 2 is the trap the review named — with
    // `stoppedAt` gone and nothing attempted, a compile whose FIRST step ends
    // the run would answer `green` ("already compiled") over two steps that have
    // no entry and no transcript.
    it.each([
      ['is green when the ending step was the last one — nothing is owed',
        [FAIL_STEP], undefined, [], undefined, 'green'],
      ['is NOT green when steps after it never ran, though nothing was attempted',
        [FAIL_STEP, 'Open the dashboard', 'Search for the order'],
        { step: 1, error: MESSAGE, line: FAIL_STEP }, [2, 3],
        `the run ended at step 1 as its text says (${FAIL_STEP})`, 'partial'],
    ] as const)('%s', async (_label, steps, endedAsWritten, notAttempted, error, status) => {
      const { frames } = await runSteps(requestBody({
        steps: [...steps], sourceLines: steps.map((_, i) => 4 + i), compile: 'run',
      }));

      const result = frames.find((f) => f.type === 'compile:result')!;
      expect(result.summary.stoppedAt).toBeUndefined();
      expect(result.summary.endedAsWritten).toEqual(endedAsWritten);
      expect(result.summary.notAttempted).toEqual(notAttempted);
      expect(result.summary.error).toEqual(error);
      expect(result.summary.compiled).toBe(0);
      expect(result.status).toBe(status);
    });
  });
});

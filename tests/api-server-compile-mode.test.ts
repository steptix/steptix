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

vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: vi.fn(async (
    stepIndex: number,
    _totalSteps: number,
    instruction: string,
    opts: Record<string, unknown>,
  ): Promise<StepResult> => {
    stepCalls.push({ instruction, opts });
    return {
      index: stepIndex,
      instruction,
      status: 'passed',
      turns: [
        {
          turnNumber: 1,
          attemptNumber: 1,
          timestamp: new Date().toISOString(),
          aiInteractions: [],
          subActions: [
            {
              index: 1,
              action: { action: 'click', selector: '#go' },
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
      ...(opts['captureStepContext'] === true && {
        stepContext: {
          domBefore: '<html><body><button id="go">Go</button></body></html>',
          urlBefore: 'https://example.com/',
          domAfter: '<html><body><h1>Dashboard</h1></body></html>',
          urlAfter: 'https://example.com/dashboard',
        },
      }),
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
    expect(steps.map((f) => [f.step, f.line, f.message])).toEqual([
      [1, 4, 'generated'],
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

      const generated = second.filter((f) => f.type === 'compile:step' && f.phase === 'generate');
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
      const generated = fresh.filter((f) => f.type === 'compile:step' && f.phase === 'generate');
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
});

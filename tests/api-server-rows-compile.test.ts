/**
 * Rows × compile, over HTTP (stories/data-driven-rows.md, decision 11).
 *
 * A data-driven Run & Compile generates code-behind for ONE row and reuses it
 * for every row. It can, because an entry is keyed by (file, section, authored
 * step text, occurrence) and occurrence restarts per frame instance — so every
 * iteration of a looped `### Section` body, and every row of a `## Steps`
 * table, binds to the same entry. This suite is the server's half of that:
 * a looped section in ONE batch, and a kept session sending row 2 with
 * `compileContinues`.
 *
 * **Every test POSTs through the real `node:http` entry**, for the reason the
 * sections and compile-mode suites state: `api-server.ts` builds `StepRequest`
 * from an explicit per-field allow-list, so a `sections`/`compile`/`dataRow`
 * field can typecheck and still be dropped before the session manager sees it.
 * That is how `envName` was once lost while its own resolver's tests stayed
 * green.
 *
 * The browser and the step executor are mocked; the session manager, the
 * expander, the code-behind registry, the generation prompt/parse, the writer,
 * Prettier and the recording all run for real. The AI client is a fake that
 * answers a generation prompt with an entry and a review prompt with the file
 * unchanged — so what is under test is "how many entries does a three-row run
 * ask for, and what are they bound to", never "is the model any good".
 *
 * The third shape a client can send — DELETE the session between rows, which
 * is what Steptix does — cannot be fixed here: closing the session discards
 * the retained compiler, so the server sees three unrelated compiles and is
 * right to. That one is the client's to get right, and
 * steptix-vscode's integration suite covers it (`codebehind-rows`).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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
import { readRecording } from '../src/codebehind/recording.js';

const API_KEY = 'sk-rows-compile';
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
/** The main flow of the looped-section fixture: one plain step, then a call
 *  of a section whose heading carries a three-row table. */
const LOOP_STEPS = ['Open the dashboard', 'Upload each file'];
/** The main flow of the matrix fixture — run once per row of the `## Steps`
 *  table, which is how a data-driven run reaches the server: one batch per
 *  row, the same steps every time. */
const MATRIX_STEPS = ['Open the dashboard', 'Search for the order'];
const FILES = ['a.png', 'b.png', 'c.png'];
const EMAILS = ['a@example.test', 'b@example.test', 'c@example.test'];

/**
 * The `sections` field as a client builds it (contract §3.2): no `rawSteps` —
 * the wire has none — and `steps` carrying the AUTHORED body line,
 * `Upload {{file}}`, placeholder and all.
 */
const LOOP_SECTIONS = {
  'upload each file': {
    name: 'Upload each file',
    headingLine: 7,
    steps: ['Upload {{file}}'],
    stepLines: [13],
    rows: FILES.map((file) => ({ file })),
  },
};

let server: Server;
let baseUrl: string;
let tmpDir: string;

/**
 * A test file per CASE, not per shape.
 *
 * The compile lock is keyed by test file and held for the length of a compile,
 * and a case that times out mid-compile never releases it — so with a shared
 * fixture the NEXT case's POST comes back 409 and reports a failure that has
 * nothing to do with what it tests. One file each makes that impossible: a
 * timeout can fail its own case and no other.
 *
 * Everything else hangs off the path too — the `.steps.ts`, the recording dir,
 * the last-run sidecar — so separate files also keep one case's proposal out
 * of another's assertions.
 */
interface Fixture {
  md: string;
  steps: string;
}
const fixtures = new Map<string, Fixture>();

function fixture(name: string): Fixture {
  const existing = fixtures.get(name);
  if (existing) return existing;
  const made = { md: path.join(tmpDir, `${name}.md`), steps: path.join(tmpDir, `${name}.steps.ts`) };
  fixtures.set(name, made);
  return made;
}

/** Written out in full even though the server parses neither: the steps, the
 *  sections and the rows all ride the wire. A fixture that doesn't say what it
 *  is cannot be read when it fails, and the line numbers below are the ones
 *  the requests claim. */
async function writeLoopFixture(name: string): Promise<Fixture> {
  const f = fixture(name);
  await fs.writeFile(
    f.md,
    [
      '# Loop',
      '',
      '## Steps',
      '1. Open the dashboard',
      '2. Upload each file',
      '',
      '### Upload each file',
      '| file |',
      '|-------|',
      ...FILES.map((file) => `| ${file} |`),
      '1. Upload {{file}}',
      '',
    ].join('\n'),
  );
  return f;
}

async function writeMatrixFixture(name: string): Promise<Fixture> {
  const f = fixture(name);
  await fs.writeFile(
    f.md,
    [
      '# Matrix',
      '',
      '## Steps',
      '| email |',
      '|-------|',
      ...EMAILS.map((e) => `| ${e} |`),
      '',
      ...MATRIX_STEPS.map((s, i) => `${i + 1}. ${s}`),
      '',
    ].join('\n'),
  );
  return f;
}

/**
 * A compile records, generates and reviews through a fake model, over HTTP,
 * with Prettier in the middle — comfortably more than vitest's 5 s default on
 * a loaded box, and a case that trips that default leaves the compile lock
 * held. Sized for the slow machine rather than the fast one.
 */
const CASE_TIMEOUT = 30_000;

beforeAll(async () => {
  const { app } = createApiServer(cfg);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) baseUrl = `http://127.0.0.1:${addr.port}`;

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rows-compile-'));
});

afterAll(async () => {
  await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

beforeEach(async () => {
  stepCalls.length = 0;
  aiPrompts.length = 0;
  aiCalls.length = 0;
  for (const f of fixtures.values()) await fs.rm(f.steps, { force: true });
  await fs.rm(path.join(tmpDir, '.steptix-codebehind-cache'), {
    recursive: true, force: true, maxRetries: 10, retryDelay: 100,
  });
});

/**
 * Every session a case posted to, closed when the case ends.
 *
 * A `'run'` compile is RETAINED on its session by design — it is what the
 * kept-session case below continues — and its candidate keeps writing under
 * the shared cache dir. Left open, it races the next case's `beforeEach`
 * cleanup (compile-mode measured that as ENOTEMPTY plus a cascade of
 * timeouts). Closing the session discards the compiler and waits out any
 * generation still in flight.
 */
const openedSessions = new Set<string>();

afterEach(async () => {
  const ids = [...openedSessions];
  openedSessions.clear();
  await Promise.all(ids.map(async (id) => {
    const res = await fetch(`${baseUrl}/sessions/${id}`, {
      method: 'DELETE',
      headers: { 'x-api-key': API_KEY },
    });
    // 404: the session was never made, because the test failed before it was.
    // That test has already said why; anything else is this cleanup's own failure.
    expect([200, 404], `closing session ${id} answered ${res.status}`).toContain(res.status);
  }));
});

/**
 * POST one block of steps at a NAMED session, and fold the frames.
 *
 * Named rather than minted per call, because a row loop's second batch has to
 * reach the session the first one opened — that is what `compileContinues`
 * continues, and a fresh session id would quietly test something else.
 */
async function post(
  sessionId: string,
  body: Record<string, unknown>,
): Promise<{ type: string; [k: string]: any }[]> {
  openedSessions.add(sessionId);
  const res = await fetch(`${baseUrl}/sessions/${sessionId}/steps?stream=1`, {
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
}

const isReview = (prompt: string): boolean => /Review a generated/.test(prompt);
/** Model calls that asked for an ENTRY — the number this feature is about. */
const generations = (): number => aiCalls.filter((c) => !isReview(c.prompt)).length;
const reviews = (): number => aiCalls.filter((c) => isReview(c.prompt)).length;

/**
 * The `source` of every entry in a proposed `.steps.ts`, in file order.
 *
 * Read out of the emitted code rather than counted, because "how many entries"
 * and "which steps are they bound to" are the same question here: three rows
 * that each generated would produce three entries whose sources are the
 * interpolated row text, and only reading them says so.
 */
function sourcesIn(file: string): string[] {
  return [...file.matchAll(/\bsource:\s*(['"])((?:[^\\]|\\.)*?)\1/g)].map((m) => m[2]!);
}

function compileResult(frames: { type: string; [k: string]: any }[]): {
  status: string;
  files: Record<string, string>;
  summary: Record<string, any>;
} {
  const found = frames.find((f) => f.type === 'compile:result');
  expect(found, 'the run emitted no compile:result frame').toBeDefined();
  return found as never;
}

describe('a looped section compiles its body once', () => {
  it('generates ONE entry for a three-row body, bound to the authored text each row ran', async () => {
    const { md: loopFilePath, steps: loopStepsPath } = await writeLoopFixture('loop-entries');
    const frames = await post('rows-section', {
      steps: LOOP_STEPS,
      sourceLines: [4, 5],
      testFilePath: loopFilePath,
      sections: LOOP_SECTIONS,
      compile: 'run',
    });

    // Step 1, and the body ONCE. Four expanded steps ran; three of them are
    // the same entry arriving again. Before the dedupe this was 4.
    expect(generations()).toBe(2);
    expect(reviews()).toBe(1);

    const result = compileResult(frames);
    expect(Object.keys(result.files)).toEqual([loopStepsPath]);
    const file = result.files[loopStepsPath]!;
    // `Upload {{file}}`, not `Upload a.png`: the match side of a looped body is
    // the AUTHORED text on the server exactly as on the CLI parser path
    // (expander.ts, `bodyCtx.rawSteps`). With the interpolated text there, this
    // file held FOUR entries — one per row — and none of them would ever match
    // a later run, whose rows are different.
    expect(sourcesIn(file)).toEqual(['Open the dashboard', 'Upload {{file}}']);
    // The body's entry is scoped to its section; the main-flow step is not.
    expect(file).toContain("section: 'Upload each file'");

    // The other half of the same change, and the one that keeps it honest: the
    // authored text is the BINDING, not the instruction. Each iteration still
    // executes `Upload a.png` — a run that sent `Upload {{file}}` to the
    // browser would be a regression the assertion above cannot see.
    expect(stepCalls.map((c) => c.instruction)).toEqual([
      'Open the dashboard',
      ...FILES.map((f) => `Upload ${f}`),
    ]);

    // The recording is the run's, so it has all four steps — and all three
    // iterations carry the same identity, which is what lets a later
    // single-step compile splice by identity rather than by position.
    const recording = await readRecording(loopFilePath);
    expect(recording?.steps.map((s) => s.source)).toEqual([
      'Open the dashboard',
      'Upload {{file}}',
      'Upload {{file}}',
      'Upload {{file}}',
    ]);
    expect(recording?.steps.map((s) => s.section)).toEqual([
      undefined,
      'Upload each file',
      'Upload each file',
      'Upload each file',
    ]);

    // The boxed pipeline's arithmetic for a body called more than once
    // (compile.ts: `totalSteps: test.steps.length`, `compiled:
    // selection.order.length`): `totalSteps` counts every expanded step,
    // `compiled` counts entries. The repeats are counted nowhere else either —
    // not `kept`, which means "ran as code", and not `keptAi`.
    expect(result.summary.totalSteps).toBe(4);
    expect(result.summary.compiled).toBe(2);
    expect(result.summary.kept).toBe(0);
    expect(result.summary.keptAi).toBe(0);
    expect(result.summary.unproven).toEqual([1, 2]);
    expect(result.summary.notAttempted).toEqual([]);
  }, CASE_TIMEOUT);
});

describe('a kept session compiles row 1 only', () => {
  it('adds no generation for row 2 when the client keeps the compiler open', async () => {
    const { md: matrixFilePath, steps: matrixStepsPath } = await writeMatrixFixture('matrix-kept');
    const sessionId = 'rows-kept';
    const matrixBody = (row: number): Record<string, unknown> => ({
      steps: MATRIX_STEPS,
      sourceLines: [10, 11],
      testFilePath: matrixFilePath,
      compile: 'run',
      ...(row > 1 && { compileContinues: true }),
      dataRow: row,
      dataRowCount: EMAILS.length,
      dataRowValues: { email: EMAILS[row - 1] },
      parameters: { email: EMAILS[row - 1] },
    });

    await post(sessionId, matrixBody(1));
    expect(generations()).toBe(2);
    const afterRow1 = aiCalls.length;

    // No DELETE between the two: the compiler is retained on the session, so
    // row 2's steps are offered to the SAME compiler and every one of them is
    // an entry it has already written.
    const frames = await post(sessionId, matrixBody(2));
    expect(aiCalls.length - afterRow1).toBe(0);

    const result = compileResult(frames);
    const file = result.files[matrixStepsPath]!;
    expect(sourcesIn(file)).toEqual(MATRIX_STEPS);
    // The claim, and the only one this case makes about the counts: row 2
    // added no entry.
    expect(result.summary.compiled).toBe(2);
    expect(result.summary.unproven).toEqual([1, 2]);
    expect(result.summary.keptAi).toBe(0);
    // `totalSteps` is 4 — every step the compiler was handed, across both
    // blocks — and that is NOT boxed-pipeline parity, unlike the looped-section
    // case above. The boxed compile counts `test.steps.length`, and for a
    // `## Steps` table the rows live in `ParsedTest.dataRows` rather than in
    // `steps`, so it would say 2. The server cannot close that gap: a row-2
    // block and the second half of an `[input:]`-split run arrive in the same
    // shape, and one of them genuinely adds steps. Left as the honest count of
    // what was executed — and unreachable in practice now, since Steptix
    // sends `compile` on the first row only (rows story, decision 11).
    expect(result.summary.totalSteps).toBe(4);
  }, CASE_TIMEOUT);
});

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

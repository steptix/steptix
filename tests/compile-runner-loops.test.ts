/**
 * The boxed compile of a file with a chain and a file with a `While`, through
 * the real `POST /codebehind/compile` route
 * (stories/codebehind-loops-and-conditions.md, "Boxed compile").
 *
 * This route is the one run path that hands the server steps it has ALREADY
 * expanded: `sessionRunner` (src/server/compile-runner.ts) sends `test.steps` —
 * a guard line, then its tail — with the compiler's own expansion riding along
 * out of band. The server used to re-expand whenever a step parsed as a control
 * line, which is every guard line: a chain's `Otherwise` then followed a tail
 * step rather than its `If` and the expansion refused the file, and a `While`'s
 * tail was expanded a second time, so every row after it landed one index late
 * against `outcomeRows(…, test.steps.length)` and the registry.
 *
 * The whole compile core runs for real — Record, Generate, Review, Replay —
 * through the session manager, the expander, the planner, `evaluateGuard` and
 * the real `runConditionCode` over the candidate `.steps.ts`. The browser,
 * `executeStep` and the condition JUDGE are mocked; the AI client answers a
 * generation prompt with an entry (a `condition` for a condition prompt) and a
 * review with the file unchanged. The fixtures live under `tests/` so a
 * candidate importing `steptix/codebehind` resolves.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

const pageState = vi.hoisted(() => ({ answers: [] as boolean[], answered: 0 }));

const mockPage = {
  url: vi.fn(() => 'https://example.com/start'),
  title: vi.fn(async () => 'Start'),
  goto: vi.fn(async () => null),
  /** What a generated condition entry reads — one scripted answer a call. */
  answer: () => {
    pageState.answered++;
    return pageState.answers.length > 0 ? pageState.answers.shift()! : false;
  },
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

const run = vi.hoisted(() => ({
  /** Every instruction the executor was handed, per compile run, in order. */
  executed: [] as string[],
  /** Per-instruction call count, so each pass's page is told apart. */
  perInstruction: new Map<string, number>(),
  /** The judge's scripted verdicts, in order. `null` is "none held". */
  judgeScript: [] as Array<number | null>,
  judgeCalls: 0,
}));

vi.mock('../src/runner/step-executor.js', async (importOriginal) => ({
  // The real module underneath: `runConditionCode` runs a condition entry.
  ...(await importOriginal<typeof import('../src/runner/step-executor.js')>()),
  executeStep: vi.fn(async (
    stepIndex: number,
    _total: number,
    instruction: string,
    opts: { codeBehind?: { entry?: { run?: unknown } }; captureStepContext?: boolean },
  ): Promise<StepResult> => {
    run.executed.push(instruction);
    const n = (run.perInstruction.get(instruction) ?? 0) + 1;
    run.perInstruction.set(instruction, n);
    // A step whose binding carries a `run` entry "ran as code".
    if (typeof opts.codeBehind?.entry?.run === 'function') {
      return {
        index: stepIndex,
        instruction,
        status: 'passed',
        turns: [],
        durationMs: 1,
        retried: false,
        fromCodeBehind: true,
      } as StepResult;
    }
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
          subActions: [{ index: 1, action: { action: 'click', selector: '#go' }, durationMs: 1 }],
        },
      ],
      durationMs: 5,
      retried: false,
      aiExplanation: 'ok',
      ...(opts.captureStepContext === true && {
        stepContext: {
          domBefore: `<html><body><p>${instruction} — visit ${n}</p><button id="go">Go</button></body></html>`,
          urlBefore: `https://example.com/page-${n}`,
          domAfter: `<html><body><p>after ${instruction} — visit ${n}</p></body></html>`,
          urlAfter: `https://example.com/page-${n + 1}`,
        },
      }),
    } as StepResult;
  }),
  executeBranchedStep: vi.fn(async () => []),
  evaluateConditions: vi.fn(async () => {
    run.judgeCalls++;
    const selected = run.judgeScript.length > 0 ? run.judgeScript.shift()! : null;
    return {
      selected,
      reasoning: selected === null ? 'nothing held' : `condition ${selected} held`,
      aiInteractions: [],
      evidence: {
        dom: `<html><body><button id="next">Next</button><!-- judge call ${run.judgeCalls} --></body></html>`,
        url: `https://example.com/judged-${run.judgeCalls}`,
      },
    };
  }),
  // It would poll a real DOM for quiet; the mock page has none.
  settleBeforeConditions: vi.fn(async () => {}),
}));

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: vi.fn(async () => ({ files: [], combined: '' })),
}));

const ai = vi.hoisted(() => ({ prompts: [] as string[] }));
vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    chat = vi.fn(async () => '{}');
    setAiPolicy = vi.fn();
    syncAuth = vi.fn(() => null);
    complete = vi.fn(async (messages: Array<{ role: string; content: string }>) => {
      const last = messages[messages.length - 1]?.content ?? '';
      ai.prompts.push(last);
      if (/Review a generated Playwright code-behind file/.test(last)) {
        const fenced = /## The file, as generated\s*```ts\n([\s\S]*?)```/.exec(last);
        return { text: JSON.stringify({ file: fenced?.[1] ?? 'export default defineSteps([]);\n' }) };
      }
      // The LAST `source:` line — the required shape near the prompt's end. An
      // earlier one can be an entry of the candidate file the prompt embeds.
      const quoted = [...last.matchAll(/\n\s*source:\s*("(?:[^"\\]|\\.)*")/g)].at(-1);
      const source = quoted?.[1] ? (JSON.parse(quoted[1]) as string) : 'step';
      const entry = /async condition\(\{ page, step \}\)/.test(last)
        ? `{ source: ${JSON.stringify(source)}, async condition({ page }) { return page.answer(); } }`
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
import { listenFetchable } from './listen-fetchable.cjs';

const API_KEY = 'sk-compile-loops';
const cfg: Config = {
  ai: { gatewayUrl: 'https://ai.test', model: 't', apiKey: 'sk-model', maxInputTokens: 1000, streamResponses: false, sendScreenshots: false },
  browser: { headed: false, viewport: { width: 1280, height: 720 }, windowSize: { width: 1280, height: 720 }, slowMo: 0, browser: 'chromium', fullPageScreenshots: true },
  tests: { dir: './tests', contextDir: './context', pattern: '**/*.md' },
  execution: { timeout: 30000, retries: 1, screenshotOnFailure: true, promptOnAmbiguity: false, maxTurns: 5, maxLoopIterations: 25 },
  reports: { outputDir: './reports', includeScreenshots: false, includeDomSnapshots: false, includeAiReasoning: false, embedScreenshots: false },
  api: { specsDir: './specs', requestTimeout: 30000, redactSensitive: true },
  server: { host: '127.0.0.1', port: 0, apiKey: API_KEY },
  logging: { consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
} as Config;

/** A compile records, generates, reviews through Prettier and replays. */
const CASE_TIMEOUT = 60_000;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'tests', '.tmp-compile-runner-loops');

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const { app } = createApiServer(cfg);
  server = createServer(app);
  await listenFetchable(server, '127.0.0.1');
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) baseUrl = `http://127.0.0.1:${addr.port}`;
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await fs.mkdir(tmpDir, { recursive: true });
  // A project of its own, so the route resolves THIS directory rather than
  // the repository's config.
  await fs.writeFile(path.join(tmpDir, 'steptix.config.json'), JSON.stringify({}));
});

afterAll(async () => {
  await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

beforeEach(() => {
  run.executed.length = 0;
  run.perInstruction.clear();
  run.judgeScript = [];
  run.judgeCalls = 0;
  ai.prompts.length = 0;
  pageState.answers = [];
  pageState.answered = 0;
});

type Frame = { type: string; [k: string]: any };

/** POST the compile and collect every SSE frame. */
async function compile(testFilePath: string): Promise<Frame[]> {
  const res = await fetch(`${baseUrl}/codebehind/compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, Accept: 'text/event-stream' },
    body: JSON.stringify({ testFilePath }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  const out: Frame[] = [];
  for (const chunk of text.split('\n\n')) {
    const line = chunk.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    try { out.push(JSON.parse(line.slice(6))); } catch { /* keep-alive */ }
  }
  return out;
}

async function fixture(name: string, lines: string[]): Promise<{ md: string; steps: string }> {
  const md = path.join(tmpDir, `${name}.md`);
  await fs.writeFile(md, [`# ${name}`, '', '## Steps', ...lines.map((l, i) => `${i + 1}. ${l}`), ''].join('\n'));
  const steps = path.join(tmpDir, `${name}.steps.ts`);
  await fs.rm(steps, { force: true });
  return { md, steps };
}

function result(frames: Frame[]): { status: string; files: Record<string, string>; summary: Record<string, any> } {
  const found = frames.find((f) => f.type === 'compile:result');
  expect(found, `no compile:result frame; frames: ${JSON.stringify(frames.map((f) => f.type))}`).toBeDefined();
  return found as never;
}

/** The Record's own run events, unwrapped from `compile:run`. */
const recordEvents = (frames: Frame[]): Frame[] =>
  frames.filter((f) => f.type === 'compile:run' && f.phase === 'record').map((f) => f.event);

/** The `source` of every entry in a proposed file, in file order. */
function sourcesIn(file: string): string[] {
  return [...file.matchAll(/\bsource:\s*(['"])((?:[^\\]|\\.)*?)\1/g)].map((m) => m[2]!);
}

const IF_LINE = 'If the Cash checkbox is ticked, then Pay with cash';
const WHILE_LINE = 'While the Next button is enabled, Click Next';

describe('POST /codebehind/compile — a file with a chain', () => {
  it('expands once: the Record runs the taken tail once, and the If gets a condition entry', async () => {
    // Expanded: 1 Open · 2 If · 3 Pay with cash · 4 Otherwise · 5 Pay by card · 6 Read.
    const { md, steps } = await fixture('chain', [
      'Open the booking page',
      IF_LINE,
      'Otherwise, Pay by card',
      'Read the reference',
    ]);
    // Record: the If holds. Replay: its condition entry says the same.
    run.judgeScript = [0];
    pageState.answers = [true];

    const frames = await compile(md);

    // The route expanded the file ONCE. Re-expanded, the `Otherwise` follows a
    // tail step instead of its `If`, and the expander refuses the whole file.
    // (Measured before the fix: the Record's stream carried `Skill expansion
    // failed: chain.md:6 — "Otherwise, Pay by card" has no decision to be the
    // alternative of`, and the compile answered `Record stopped at step 1`.)
    expect(
      recordEvents(frames).some((e) => e.type === 'output' && /has no decision to be the alternative of/.test(e.msg)),
    ).toBe(false);
    const recorded = recordEvents(frames).filter((e) => e.type === 'step:pass' || e.type === 'step:skip');
    expect(recorded.length).toBeGreaterThan(0);
    // The Record ran the taken tail once and the untaken one not at all.
    expect(run.executed.slice(0, 3)).toEqual(['Open the booking page', 'Pay with cash', 'Read the reference']);

    const out = result(frames);
    // Partial, not green: `Pay by card` never ran on the recording.
    expect(out.status).toBe('partial');
    expect(out.summary).toMatchObject({ totalSteps: 6, compiled: 4, notAttempted: [5] });
    const file = out.files[steps]!;
    expect(sourcesIn(file)).toEqual([
      'Open the booking page',
      IF_LINE,
      'Pay with cash',
      'Read the reference',
    ]);
    expect(file).toContain('async condition({ page })');
    // The replay decided the If by that code, and matched the recording.
    expect(pageState.answered).toBe(1);
    expect(out.summary.unproven).toEqual([]);
  }, CASE_TIMEOUT);
});

describe('POST /codebehind/compile — a file with a While', () => {
  it('expands once: every pass lands on its own index, and the replay proves the loop', async () => {
    // Expanded: 1 Open · 2 While · 3 Click Next · 4 Read.
    const { md, steps } = await fixture('while', [
      'Open the statements page',
      WHILE_LINE,
      'Read the reference',
    ]);
    // Record: three passes. Replay: the condition entry answers the same.
    run.judgeScript = [0, 0, 0, null];
    pageState.answers = [true, true, true, false];

    const frames = await compile(md);

    // The Record ran the body three times and `Read the reference` once — and
    // `Click Next` never a fourth time, which is the tail expanded twice.
    const recordRun = run.executed.slice(0, 5);
    expect(recordRun).toEqual([
      'Open the statements page',
      'Click Next', 'Click Next', 'Click Next',
      'Read the reference',
    ]);

    const out = result(frames);
    expect(out.status).toBe('green');
    // Counted as expanded steps and entries, never passes (decision 13).
    expect(out.summary).toMatchObject({
      totalSteps: 4,
      compiled: 4,
      kept: 0,
      keptAi: 0,
      notAttempted: [],
      unproven: [],
      writtenOffAi: [],
    });
    const file = out.files[steps]!;
    expect(sourcesIn(file)).toEqual([
      'Open the statements page',
      WHILE_LINE,
      'Click Next',
      'Read the reference',
    ]);
    // `Read the reference` was generated from ITS OWN transcript, not from a
    // `Click Next` row that landed on its index.
    const readPrompt = ai.prompts.find((p) => p.includes('  source: "Read the reference",'))!;
    expect(readPrompt).toContain('Read the reference — visit 1');
    expect(readPrompt).not.toContain('<p>Click Next');
    // `Click Next` from pass 1.
    const clickPrompt = ai.prompts.find((p) => p.includes('  source: "Click Next",'))!;
    expect(clickPrompt).toContain('Click Next — visit 1');
    // The replay's condition code answered all four visits.
    expect(pageState.answered).toBe(4);
  }, CASE_TIMEOUT);
});

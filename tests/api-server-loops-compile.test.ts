/**
 * Run & Compile through loops and conditions, over HTTP
 * (stories/codebehind-loops-and-conditions.md, "Live compile" — Stage B).
 *
 * **Every test POSTs through the real `node:http` entry**, for the reason the
 * rows-compile and control-flow suites state: `api-server.ts` builds its
 * `StepRequest` from a per-field allow-list, and everything this story adds
 * rides on what the SERVER derives — the guards from `steps` + `sections`, the
 * compile plan from its own expansion, the guard's evidence from its own
 * evaluation. The claim is that a Run & Compile of a file that loops compiles
 * it: one entry per body line from pass 1, a `condition` entry per
 * model-decided condition, and a summary that counts steps rather than passes.
 *
 * The browser, `executeStep` and the condition JUDGE are mocked; the session
 * manager, the expander, the planner, `evaluateGuard`, the real
 * `runConditionCode` (for a condition entry on disk), the registry, the
 * generation prompts and parse, Prettier and the recording run for real. The
 * AI client is a fake that answers a generation prompt with an entry — a
 * `condition` for a condition prompt, a `run` otherwise — and a review prompt
 * with the file unchanged.
 *
 * The fixtures live under `tests/` rather than the OS temp dir, so a
 * `.steps.ts` importing `steptix/codebehind` resolves through the
 * package's own name — the same walk-up the loader does for an author's file.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

const pageState = vi.hoisted(() => ({ nextEnabled: [] as boolean[] }));

const mockPage = {
  url: vi.fn(() => 'https://example.com/statements'),
  title: vi.fn(async () => 'Statements'),
  goto: vi.fn(async () => null),
  /** What a hand-written condition entry reads — one scripted answer a call. */
  nextEnabled: () => (pageState.nextEnabled.length > 0 ? pageState.nextEnabled.shift()! : false),
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
  /** Instruction of every step the executor was handed, in order. */
  executed: [] as string[],
  /** Per-instruction call count, so each pass's DOM is told apart. */
  perInstruction: new Map<string, number>(),
  /** The judge's scripted verdicts, in order. `null` is "none held". */
  judgeScript: [] as Array<number | null>,
  judgeCalls: 0,
  /** What a `[store as: <name>]` step's read captures, by name: the executor
   *  binds it into the run's map and records the read that wrote it, as a
   *  real read does. */
  captures: new Map<string, string>(),
}));

vi.mock('../src/runner/step-executor.js', async (importOriginal) => ({
  // The real module underneath: `runConditionCode` runs a condition entry.
  ...(await importOriginal<typeof import('../src/runner/step-executor.js')>()),
  executeStep: vi.fn(async (
    stepIndex: number,
    _total: number,
    instruction: string,
    opts: {
      codeBehind?: { entry?: { run?: unknown } };
      captureStepContext?: boolean;
      resolvedParameters?: Record<string, string>;
    },
  ): Promise<StepResult> => {
    run.executed.push(instruction);
    const n = (run.perInstruction.get(instruction) ?? 0) + 1;
    run.perInstruction.set(instruction, n);
    const storeAs = /\[store as: (\w+)\]/.exec(instruction)?.[1];
    const captured = storeAs !== undefined ? run.captures.get(storeAs) : undefined;
    if (storeAs !== undefined && captured !== undefined && opts.resolvedParameters) {
      opts.resolvedParameters[storeAs] = captured;
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
                action: {
                  action: 'read',
                  selector: '#account-list > li[data-testid="account-row"] > span > span:first-child',
                  multiple: true,
                  as: storeAs,
                },
                durationMs: 1,
              },
            ],
          },
        ],
        durationMs: 5,
        retried: false,
        aiExplanation: 'read',
        ...(opts.captureStepContext === true && {
          stepContext: {
            domBefore: '<ul id="account-list"><li data-testid="account-row"><span><span>Everyday</span><span>•••• 1111</span></span></li></ul>',
            urlBefore: 'https://example.com/accounts',
          },
        }),
      } as StepResult;
    }
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

const ai = vi.hoisted(() => ({
  prompts: [] as string[],
  /** Scripted entry bodies per step source, answered in turn before the
   *  default: `async run({ page, step }) { <body> }`. */
  scripted: new Map<string, string[]>(),
}));
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
      const scripted = ai.scripted.get(source)?.shift();
      if (scripted !== undefined) {
        return {
          text: JSON.stringify({ entry: `{ source: ${JSON.stringify(source)}, async run({ page, step }) { ${scripted} } }` }),
        };
      }
      const entry = isConditionPrompt(last)
        ? `{ source: ${JSON.stringify(source)}, async condition({ page }) { const next = page.getByRole('button', { name: 'Next' }); return (await next.count()) > 0 && (await next.isEnabled()); } }`
        : `{ source: ${JSON.stringify(source)}, async run({ page }) { await page.click('#go'); } }`;
      return { text: JSON.stringify({ entry }) };
    });
  },
}));
function isConditionPrompt(prompt: string): boolean {
  return /async condition\(\{ page, step \}\)/.test(prompt);
}

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
  shouldEmit: vi.fn(() => true),
  setLogLevel: vi.fn(),
  getLogLevel: vi.fn(() => 'info'),
}));

import { createApiServer } from '../src/server/api-server.js';
import { readRecording } from '../src/codebehind/recording.js';
import { buildCodeBehindRegistry } from '../src/codebehind/loader.js';
import { isConditionCode } from '../src/codebehind/execute.js';
import { validateCodeBehindSource } from '../src/codebehind/writer.js';

const API_KEY = 'sk-loops-compile';
const cfg: Config = {
  // A key, so a broken condition entry heals under the (mocked) model.
  ai: { gatewayUrl: 'https://ai.test', model: 't', apiKey: 'sk-model', maxInputTokens: 1000, streamResponses: false, sendScreenshots: false },
  browser: { headed: false, viewport: { width: 1280, height: 720 }, windowSize: { width: 1280, height: 720 }, slowMo: 0, browser: 'chromium', fullPageScreenshots: true },
  tests: { dir: './tests', contextDir: './context', pattern: '**/*.md' },
  execution: { timeout: 30000, retries: 1, screenshotOnFailure: true, promptOnAmbiguity: false, maxTurns: 5, maxLoopIterations: 25 },
  reports: { outputDir: './reports', includeScreenshots: false, includeDomSnapshots: false, includeAiReasoning: false, embedScreenshots: false },
  api: { specsDir: './specs', requestTimeout: 30000, redactSensitive: true },
  server: { host: '127.0.0.1', port: 0, apiKey: API_KEY },
  logging: { consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
} as Config;

/** A compile records, generates and reviews through Prettier: sized for a
 *  loaded box, since a case that times out mid-compile keeps its lock. */
const CASE_TIMEOUT = 30_000;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'tests', '.tmp-loops-compile');

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const { app } = createApiServer(cfg);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) baseUrl = `http://127.0.0.1:${addr.port}`;
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
});

afterAll(async () => {
  await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  run.executed.length = 0;
  run.perInstruction.clear();
  run.judgeScript = [];
  run.judgeCalls = 0;
  run.captures.clear();
  ai.prompts.length = 0;
  ai.scripted.clear();
  pageState.nextEnabled = [];
});

// ── Helpers ──────────────────────────────────────────────────────────────────

let seq = 0;

type Frame = { type: string; [k: string]: any };

async function collect(body: unknown): Promise<Frame[]> {
  const res = await fetch(`${baseUrl}/sessions/loops-${++seq}/steps?stream=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, Accept: 'text/event-stream' },
    body: JSON.stringify(body),
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

/** A test file per case (the compile lock and every sidecar hang off it),
 *  with an optional `.steps.ts` beside it. */
async function project(name: string, entries?: string): Promise<{ md: string; steps: string }> {
  const md = path.join(tmpDir, `${name}.md`);
  const steps = path.join(tmpDir, `${name}.steps.ts`);
  await fs.writeFile(md, '# placeholder — the server never reads this\n');
  await fs.rm(steps, { force: true });
  if (entries !== undefined) {
    await fs.writeFile(
      steps,
      `import { defineSteps } from 'steptix/codebehind';\n\nexport default defineSteps([\n${entries}\n]);\n`,
    );
  }
  return { md, steps };
}

function compileResult(frames: Frame[]): { status: string; files: Record<string, string>; summary: Record<string, any> } {
  const found = frames.find((f) => f.type === 'compile:result');
  expect(found, 'the run emitted no compile:result frame').toBeDefined();
  return found as never;
}

const generationPrompts = (): string[] => ai.prompts.filter((p) => !/Review a generated/.test(p));
const conditionPrompts = (): string[] => generationPrompts().filter(isConditionPrompt);
const stepPrompts = (): string[] => generationPrompts().filter((p) => !isConditionPrompt(p));
/** The generation prompt whose required `source` is exactly `line`. */
const promptFor = (line: string): string[] =>
  generationPrompts().filter((p) => p.includes(`  source: ${JSON.stringify(line)},`));

/** The `source` of every entry in a proposed file, in file order. */
function sourcesIn(file: string): string[] {
  return [...file.matchAll(/\bsource:\s*(['"])((?:[^\\]|\\.)*?)\1/g)].map((m) => m[2]!);
}

const WHILE_LINE = 'While the Next button is enabled, Go to the next page';

/**
 *     3. Open the statements page
 *     4. While the Next button is enabled, Go to the next page
 *     5. Verify the last page is shown
 *     ### Go to the next page   (heading 7)
 *     8. Click Next
 *     9. Check the page heading
 *
 * Expanded: 1 Open · 2 While · 3 Click Next · 4 Check the page heading · 5 Verify.
 */
const whileBody = (md: string, extra: Record<string, unknown> = {}) => ({
  steps: ['Open the statements page', WHILE_LINE, 'Verify the last page is shown'],
  sourceLines: [3, 4, 5],
  testFilePath: md,
  sections: {
    'go to the next page': {
      name: 'Go to the next page',
      headingLine: 7,
      steps: ['Click Next', 'Check the page heading'],
      stepLines: [8, 9],
    },
  },
  compile: 'run',
  ...extra,
});

// ── A While that runs three passes ───────────────────────────────────────────

describe('a While whose body runs three passes, in one Run & Compile', () => {
  it('generates ONE entry per body line, from pass 1, and a condition from a held and a not-held page', async () => {
    const { md, steps } = await project('while-three');
    run.judgeScript = [0, 0, 0, null];

    const frames = await collect(whileBody(md));

    expect(frames.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
    expect(run.executed).toEqual([
      'Open the statements page',
      'Click Next', 'Check the page heading',
      'Click Next', 'Check the page heading',
      'Click Next', 'Check the page heading',
      'Verify the last page is shown',
    ]);

    // One generation per authored line — four step lines and the guard — not
    // one per pass.
    expect(stepPrompts()).toHaveLength(4);
    expect(conditionPrompts()).toHaveLength(1);

    // Each body line was generated from PASS 1: its page, its URL.
    const clickNext = promptFor('Click Next');
    expect(clickNext).toHaveLength(1);
    expect(clickNext[0]).toContain('Click Next — visit 1');
    expect(clickNext[0]).not.toContain('Click Next — visit 2');
    expect(clickNext[0]).toContain('https://example.com/page-1');
    // …and was told it repeats (decision 2): the loop line, one entry for
    // every pass, and — a While binds nothing — that the page changes.
    expect(clickNext[0]).toContain('## This step runs inside a loop');
    expect(clickNext[0]).toContain(`It is in the body of \`${WHILE_LINE}\``);
    expect(clickNext[0]).toContain('the page changes from pass to pass');
    // A step outside the loop is told nothing of the kind.
    expect(promptFor('Open the statements page')[0]).not.toContain('runs inside a loop');

    // The condition: shown the FIRST held page and the FIRST not-held one
    // (decision 9) — judge calls 1 and 4 — and nothing in between.
    const condition = conditionPrompts()[0]!;
    expect(condition).toContain(`  source: ${JSON.stringify(WHILE_LINE)},`);
    expect(condition).toContain('## The condition\nthe Next button is enabled');
    expect(condition).toContain('This is a `While` loop');
    expect(condition).toContain('### Observation 1 — the condition HELD');
    expect(condition).toContain('<!-- judge call 1 -->');
    expect(condition).toContain('### Observation 2 — the condition did NOT hold');
    expect(condition).toContain('<!-- judge call 4 -->');
    expect(condition).not.toContain('<!-- judge call 2 -->');
    expect(condition).not.toContain('### Observation 3');

    const result = compileResult(frames);
    const file = result.files[steps]!;
    expect(sourcesIn(file)).toEqual([
      'Open the statements page',
      'Click Next',
      'Check the page heading',
      'Verify the last page is shown',
      WHILE_LINE,
    ]);
    // Counted as entries and expanded steps, never passes (decision 13).
    expect(result.summary).toMatchObject({
      totalSteps: 5,
      compiled: 5,
      kept: 0,
      keptAi: 0,
      notAttempted: [],
      unproven: [1, 2, 3, 4, 5],
    });

    // The proposal is a file that LOADS: esbuild accepts it, and the loader
    // keeps the guard's entry as a condition.
    expect(await validateCodeBehindSource(steps, file)).toBeNull();
    await fs.writeFile(steps, file);
    const registry = await buildCodeBehindRegistry(
      { steps: [WHILE_LINE], rawSteps: [WHILE_LINE], origins: [{ inputIndex: 0, frameId: '' }], frames: {} },
      { testFilePath: md, onWarn: () => {} },
    );
    expect(isConditionCode(registry.bindingFor(0)?.entry)).toBe(true);
  }, CASE_TIMEOUT);

  it('records ONE row per expanded step — pass 1 — and the guard row its decision', async () => {
    const { md } = await project('while-recording');
    run.judgeScript = [0, 0, 0, null];
    await collect(whileBody(md));

    const recording = await readRecording(md);
    expect(recording?.manifest.steps).toBe(5);
    const byIndex = (i: number) => recording!.steps[i - 1]!;
    // Pass 1's evidence, not the last pass's.
    expect(byIndex(3).urlBefore).toBe('https://example.com/page-1');
    expect(byIndex(4).urlBefore).toBe('https://example.com/page-1');
    // The guard row's decision, and never the page it was decided on.
    expect(byIndex(2).guard).toEqual({ decidedBy: 'model', holds: true });
    const raw = await fs.readFile(
      path.join(tmpDir, '.steptix-codebehind-cache', 'while-recording.recording', 'step-02.json'),
      'utf-8',
    );
    expect(raw).not.toContain('judge call');
    expect(raw).not.toContain('evidence');
  }, CASE_TIMEOUT);
});

// ── For each ─────────────────────────────────────────────────────────────────

describe('a For each body step', () => {
  const FOR_EACH = 'For each {{account}} in {{accounts}}, Check the account';
  const BODY = 'Click the account named "{{account}}"';

  it('is told the loop line and the per-pass value, and shown pass 1\'s', async () => {
    const { md, steps } = await project('for-each');
    const frames = await collect({
      steps: ['Open the accounts page', FOR_EACH],
      sourceLines: [3, 4],
      testFilePath: md,
      parameters: { accounts: JSON.stringify(['Everyday', 'Savings', 'Travel']) },
      sections: {
        'check the account': {
          name: 'Check the account',
          headingLine: 6,
          steps: [BODY],
          stepLines: [7],
        },
      },
      compile: 'run',
    });

    expect(frames.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
    expect(run.executed).toEqual([
      'Open the accounts page',
      'Click the account named "Everyday"',
      'Click the account named "Savings"',
      'Click the account named "Travel"',
    ]);
    const body = promptFor(BODY);
    expect(body).toHaveLength(1);
    expect(body[0]).toContain('## This step runs inside a loop');
    expect(body[0]).toContain(`It is in the body of \`${FOR_EACH}\``);
    expect(body[0]).toContain("- `{{account}}` — `step.getVar('account')`");
    // The parameters shown are the evidence pass's — pass 1, Everyday.
    expect(body[0]).toContain('- {{account}} resolved to "Everyday" on this run');
    expect(body[0]).not.toContain('"Savings" on this run');
    expect(body[0]).not.toContain('"Travel" on this run');

    // `For each` reads a list and never asks a model: no condition to
    // compile, no entry, not in the denominator.
    expect(conditionPrompts()).toEqual([]);
    const result = compileResult(frames);
    expect(sourcesIn(result.files[steps]!)).toEqual(['Open the accounts page', BODY]);
    expect(result.summary.totalSteps).toBe(2);
  }, CASE_TIMEOUT);
});

// ── What the recording captured ──────────────────────────────────────────────

describe('the step that reads a For each\'s list', () => {
  const READ = 'Read the name of every account in the Your accounts panel [store as: accounts]';
  const FOR_EACH = 'For each {{account}} in {{accounts}}, Check the account';
  const BODY = 'Click the account named "{{account}}"';
  const RECORDED = '["Everyday","Savings","Travel"]';
  const CLEAN =
    "const names = page.locator('#account-list > li[data-testid=\"account-row\"] > span > span:first-child'); " +
    "await names.first().waitFor(); step.setVar('accounts', JSON.stringify(await names.allTextContents()));";

  // Measured on a real-model Run & Compile of control-flow.md: the prompt named
  // `accounts` and never its value, and the entry matched each row's three
  // spans — nine values where the recording read three, so the replay's
  // `For each` ran nine passes and nothing said so.
  it('is shown what the recording captured, and an entry that writes it in is refused for the clean re-ask', async () => {
    const { md, steps } = await project('recorded-capture');
    run.captures.set('accounts', RECORDED);
    ai.scripted.set(READ, [`step.setVar('accounts', '${RECORDED}');`, CLEAN]);

    const frames = await collect({
      steps: ['Open the accounts page', READ, FOR_EACH],
      sourceLines: [3, 4, 5],
      testFilePath: md,
      sections: {
        'check the account': { name: 'Check the account', headingLine: 7, steps: [BODY], stepLines: [8] },
      },
      compile: 'run',
    });

    expect(frames.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
    // The list the run captured drove the loop, as a real read would.
    expect(run.executed).toEqual([
      'Open the accounts page',
      READ,
      'Click the account named "Everyday"',
      'Click the account named "Savings"',
      'Click the account named "Travel"',
    ]);

    const asked = promptFor(READ);
    expect(asked).toHaveLength(2);
    // The value beside the name it is stored under, with the rule.
    expect(asked[0]).toContain(
      `- \`step.setVar('accounts', ...)\` — the recording captured a list of 3 items: ${RECORDED}`,
    );
    expect(asked[0]).toContain('**Match what the recording captured.**');
    // The first answer stored the recording's answer as a constant: refused,
    // and re-asked with the reason and its own answer, the value masked out.
    expect(asked[1]).toContain('## Your previous answer was refused');
    expect(asked[1]).toContain('The entry writes the value the recording captured into {{accounts}}');
    expect(asked[1]).toContain("step.setVar('accounts', '***')");

    const result = compileResult(frames);
    const file = result.files[steps]!;
    expect(file).toContain('allTextContents');
    for (const name of ['Everyday', 'Savings', 'Travel']) expect(file).not.toContain(name);
    // A refusal the re-ask recovered from is not a generation error.
    expect(result.summary.error).toBeUndefined();
  }, CASE_TIMEOUT);
});

// ── kept counts steps, not passes (decision 13) ──────────────────────────────

describe('what a clean looped entry counts as', () => {
  it('a body step whose entry ran cleanly on three passes is ONE kept step', async () => {
    const { md, steps } = await project(
      'kept-while',
      [
        `  {`,
        `    source: ${JSON.stringify(WHILE_LINE)},`,
        `    async condition({ page }) { return page.nextEnabled(); },`,
        `  },`,
        `  {`,
        `    section: 'Go to the next page',`,
        `    source: 'Click Next',`,
        `    async run({ page }) { await page.goto('https://example.com/next'); },`,
        `  },`,
      ].join('\n'),
    );
    // The condition entry decides three passes and then stops — no judge.
    pageState.nextEnabled = [true, true, true, false];

    const frames = await collect(whileBody(md));

    expect(frames.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
    expect(run.judgeCalls).toBe(0);
    const result = compileResult(frames);
    // `Click Next` ran as code three times at one expanded index; the `While`
    // was decided by code four times at one. Two kept steps.
    expect(result.summary.kept).toBe(2);
    // The rest were generated: Open, Check the page heading, Verify.
    expect(result.summary.compiled).toBe(3);
    expect(conditionPrompts()).toEqual([]);
    expect(sourcesIn(result.files[steps]!)).toEqual([
      WHILE_LINE,
      'Click Next',
      'Open the statements page',
      'Check the page heading',
      'Verify the last page is shown',
    ]);
  }, CASE_TIMEOUT);

  it('a table-row section loop still counts every row — each row is its own step', async () => {
    const { md } = await project(
      'kept-rows',
      [
        `  {`,
        `    section: 'Upload each file',`,
        `    source: 'Upload {{file}}',`,
        `    async run({ page }) { await page.goto('https://example.com/upload'); },`,
        `  },`,
      ].join('\n'),
    );
    const frames = await collect({
      steps: ['Upload each file'],
      sourceLines: [4],
      testFilePath: md,
      sections: {
        'upload each file': {
          name: 'Upload each file',
          headingLine: 7,
          steps: ['Upload {{file}}'],
          stepLines: [11],
          rows: ['a.png', 'b.png', 'c.png'].map((file) => ({ file })),
        },
      },
      compile: 'run',
    });
    // Unrolled at expansion: three indices, three kept steps.
    expect(compileResult(frames).summary.kept).toBe(3);
  }, CASE_TIMEOUT);
});

// ── Steps the run decided against (decision 12; issue 053) ──────────────────

describe('steps a decision skipped', () => {
  it('a While that runs no passes names its body, with the decision sentence', async () => {
    const { md } = await project('while-none');
    run.judgeScript = [null];
    const frames = await collect(whileBody(md));

    const result = compileResult(frames);
    expect(result.summary.notAttempted).toEqual([3, 4]);
    const said = frames
      .filter((f) => f.type === 'compile:step' && [3, 4].includes(f.step))
      .map((f) => f.message);
    expect(said).toEqual([
      'the step did not run — the run decided against it',
      'the step did not run — the run decided against it',
    ]);
    // …and the guard, asked once, is generated from that one visit.
    expect(conditionPrompts()).toHaveLength(1);
    expect(result.status).toBe('partial');
  }, CASE_TIMEOUT);

  /**
   *     3. If the Cash checkbox is ticked, then Pay with cash
   *     4. Otherwise, Pay by card
   *     5. Verify the order confirmation is shown
   *     ### Pay with cash   (heading 7)
   *     8. Return
   *     9. Click Pay now
   *     ### Pay by card     (heading 11)
   *     12. Enter the card details
   *     13. Submit the card form
   *
   * Expanded: 1 If · 2 Return · 3 Click Pay now · 4 Otherwise · 5 Enter · 6 Submit · 7 Verify.
   */
  const IF_LINE = 'If the Cash checkbox is ticked, then Pay with cash';
  const chainWithReturn = (md: string) => ({
    steps: [IF_LINE, 'Otherwise, Pay by card', 'Verify the order confirmation is shown'],
    sourceLines: [3, 4, 5],
    testFilePath: md,
    sections: {
      'pay with cash': { name: 'Pay with cash', headingLine: 7, steps: ['Return', 'Click Pay now'], stepLines: [8, 9] },
      'pay by card': {
        name: 'Pay by card',
        headingLine: 11,
        steps: ['Enter the card details', 'Submit the card form'],
        stepLines: [12, 13],
      },
    },
    compile: 'run',
  });

  it('names an untaken branch and a return-skipped step apart, and leaves an existing entry alone', async () => {
    const existing = [
      `  {`,
      `    section: 'Pay by card',`,
      `    source: 'Enter the card details',`,
      `    async run({ page }) { await page.goto('https://example.com/card'); },`,
      `  },`,
    ].join('\n');
    const { md, steps } = await project('chain-skips', existing);
    run.judgeScript = [0];

    const frames = await collect(chainWithReturn(md));

    expect(frames.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
    expect(run.executed).toEqual(['Verify the order confirmation is shown']);
    const result = compileResult(frames);
    // Step 3 (`Click Pay now`) a return skipped; step 6 (`Submit the card
    // form`) the decision skipped. Step 5 (`Enter the card details`) has an
    // entry: untouched and NOT named.
    expect(result.summary.notAttempted).toEqual([3, 6]);
    const sentence = (step: number) =>
      frames.find((f) => f.type === 'compile:step' && f.step === step && /did not run/.test(f.message))?.message;
    expect(sentence(3)).toBe('the step did not run — a return ended its flow');
    expect(sentence(6)).toBe('the step did not run — the run decided against it');
    expect(sentence(5)).toBeUndefined();
    // The existing entry is left exactly as it is, and counted nowhere.
    const file = result.files[steps]!;
    expect(file).toContain("await page.goto('https://example.com/card')");
    expect(file.match(/source: 'Enter the card details'/g)).toHaveLength(1);
    expect(result.summary.kept).toBe(0);
    expect(result.summary.keptAi).toBe(0);
    // The `If` got its condition; the `Otherwise` has none to get.
    expect(sourcesIn(file)).toContain(IF_LINE);
    expect(sourcesIn(file)).not.toContain('Otherwise, Pay by card');
  }, CASE_TIMEOUT);

  it('a file whose only uncompiled steps are an untaken branch is not "already compiled"', async () => {
    // Everything that RAN has an entry; only the untaken branch has none. The
    // compile used to come back green, "nothing to compile".
    const everythingThatRuns = [
      `  { source: ${JSON.stringify(IF_LINE)}, async condition() { return true; } },`,
      `  { section: 'Pay with cash', source: 'Click Pay now', async run({ page }) { await page.goto('https://example.com/x'); } },`,
      `  { source: 'Verify the order confirmation is shown', async run({ page }) { await page.goto('https://example.com/y'); } },`,
    ].join('\n');
    const { md } = await project('chain-green', everythingThatRuns);
    const frames = await collect({
      ...chainWithReturn(md),
      sections: {
        'pay with cash': { name: 'Pay with cash', headingLine: 7, steps: ['Click Pay now'], stepLines: [9] },
        'pay by card': {
          name: 'Pay by card',
          headingLine: 11,
          steps: ['Enter the card details', 'Submit the card form'],
          stepLines: [12, 13],
        },
      },
    });
    const result = compileResult(frames);
    expect(generationPrompts()).toEqual([]);
    // 1 If · 2 Click Pay now · 3 Otherwise · 4 Enter · 5 Submit · 6 Verify.
    expect(result.summary.notAttempted).toEqual([4, 5]);
    // The `If` decided by its code, and the two steps that ran as code.
    expect(result.summary.kept).toBe(3);
    expect(result.summary.compiled).toBe(0);
    expect(result.status).toBe('partial');
  }, CASE_TIMEOUT);
});

// ── A condition entry that broke ─────────────────────────────────────────────

describe('a stale condition entry', () => {
  it('is repaired through the repair variant: shown its code and what it threw', async () => {
    const { md, steps } = await project(
      'while-stale',
      [
        `  {`,
        `    source: ${JSON.stringify(WHILE_LINE)},`,
        `    async condition() { throw new Error('Next resolved to 2 elements'); },`,
        `  },`,
      ].join('\n'),
    );
    // The entry throws on visit 1 and is discarded; the model decides every
    // visit from then on: held, then not.
    run.judgeScript = [0, null];

    const frames = await collect(whileBody(md));

    expect(frames.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
    const repair = conditionPrompts();
    expect(repair).toHaveLength(1);
    expect(repair[0]).toContain('## The entry as it stands — it broke');
    expect(repair[0]).toContain("throw new Error('Next resolved to 2 elements')");
    expect(repair[0]).toContain('## What went wrong\nNext resolved to 2 elements');
    expect(repair[0]).toContain('### Observation 1 — the condition HELD');
    expect(repair[0]).toContain('### Observation 2 — the condition did NOT hold');

    // The broken entry is REPLACED in place, not appended beside.
    const file = compileResult(frames).files[steps]!;
    expect(file.match(new RegExp(`source: '${WHILE_LINE}'`, 'g'))).toHaveLength(1);
    expect(file).not.toContain('Next resolved to 2 elements');
    expect(file).toContain("getByRole('button', { name: 'Next' })");
  }, CASE_TIMEOUT);
});

// ── Compile This Step on a guard line ────────────────────────────────────────

describe('Compile This Step on a condition line', () => {
  it('generates the If line\'s condition and nothing in its branch', async () => {
    const { md, steps } = await project('chain-steps');
    run.judgeScript = [0];
    const frames = await collect({
      steps: ['Open the payments page', 'If the Cash checkbox is ticked, then Pay with cash', 'Verify it'],
      sourceLines: [3, 4, 5],
      testFilePath: md,
      sections: {
        'pay with cash': { name: 'Pay with cash', headingLine: 7, steps: ['Click Pay now'], stepLines: [8] },
      },
      compile: 'steps',
      startAt: { uri: md, line: 4 },
      endAt: { uri: md, line: 4 },
    });

    // The branch runs — a decision needs its consequence — under AI…
    expect(run.executed).toEqual(['Click Pay now']);
    // …and only the condition is compiled.
    expect(stepPrompts()).toEqual([]);
    expect(conditionPrompts()).toHaveLength(1);
    const result = compileResult(frames);
    expect(sourcesIn(result.files[steps]!)).toEqual(['If the Cash checkbox is ticked, then Pay with cash']);
    expect(result.summary).toMatchObject({ totalSteps: 1, compiled: 1, notAttempted: [] });
  }, CASE_TIMEOUT);
});

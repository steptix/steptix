/**
 * The CLI run loop and the two failure outcomes (stories/step-failure-outcomes.md
 * §Tests), with the executor MOCKED on purpose: every claim here is about the
 * LOOP — the results it pushes, whether it bails, the hooks it still runs, the
 * history it writes, the counts on the report. The executor's own half is pinned
 * against the real executor in `failure-tail-executor.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config/types.js';
import type { ParsedTest, TestInstance } from '../src/parser/types.js';
import type { StepResult, TestReport } from '../src/report/types.js';
import type { ResolvedHooks } from '../src/runner/hooks.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

// ─── Harness ────────────────────────────────────────────────────────────────

const launchBrowserMock = vi.fn();
const closeBrowserMock = vi.fn();
vi.mock('../src/browser/manager.js', () => ({
  launchBrowser: (...args: unknown[]) => launchBrowserMock(...args),
  closeBrowser: (...args: unknown[]) => closeBrowserMock(...args),
  resolveVideoMode: () => 'off',
  finalizeMainPageVideo: async (args: { closeContext: () => Promise<void> }) => {
    await args.closeContext();
    return undefined;
  },
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
  BrowserTracker: class BrowserTrackerStub {
    private session: unknown;
    private launch: (() => Promise<unknown>) | undefined;
    constructor(initial: unknown) { this.session = initial; }
    getActive() {
      if (this.session === undefined) {
        throw new Error('no browser has been launched in this session');
      }
      return this.session;
    }
    getActivePage() { return (this.getActive() as { page: unknown }).page; }
    has() { return false; }
    add() {}
    switchTo() { return this.session; }
    async close() {}
    async closeAll() { if (this.session !== undefined) closeBrowserMock(this.session); }
    list() { return []; }
    get count() { return this.session === undefined ? 0 : 1; }
    // ── Lazy launch (SPEC-use-computer.md §4.6) ──
    // Modelled rather than stubbed: the deferred tracker starts EMPTY, so a
    // runner that forgot to call ensureLaunched() fails here instead of
    // quietly getting a browser it never asked for.
    hasActive() { return this.session !== undefined; }
    static deferred(launch: () => Promise<unknown>) {
      const tracker = new BrowserTrackerStub(undefined);
      tracker.launch = launch;
      return tracker;
    }
    async ensureLaunched() {
      if (this.session === undefined) this.session = await this.launch!();
      return this.session;
    }
  },
}));

/** Every `executeStep` call the run made, in order — hooks included. */
const executeStepCalls: Array<{ index: number; instruction: string; opts: Record<string, unknown> }> = [];
const executeStepMock = vi.fn();
vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: (...args: unknown[]) => {
    executeStepCalls.push({
      index: args[0] as number,
      instruction: args[2] as string,
      opts: args[3] as Record<string, unknown>,
    });
    return executeStepMock(...args);
  },
  executeBranchedStep: vi.fn(async () => []),
}));

/** The failure REPL. Never entered on a tolerated failure (decision 6), and
 *  entered on an ordinary one — the control that makes that claim mean something. */
const replMock = vi.fn(async () => ({ kind: 'exit' as const }));
vi.mock('../src/runner/interactive-repl.js', () => ({
  runInteractiveRepl: (...args: unknown[]) => replMock(...(args as [])),
}));

const captureScreenshotMock = vi.fn(async () => ({ base64: 'shot' }));
vi.mock('../src/browser/screenshot.js', () => ({
  captureScreenshot: (...args: unknown[]) => captureScreenshotMock(...(args as [])),
}));

let hooksStub: ResolvedHooks = hooks();
vi.mock('../src/runner/hooks.js', () => ({
  resolveHooks: vi.fn(async () => hooksStub),
}));

const diagnoseMock = vi.fn(async () => null);
vi.mock('../src/ai/diagnose.js', () => ({ diagnoseFailure: (...a: unknown[]) => diagnoseMock(...(a as [])) }));
vi.mock('../src/ai/client.js', () => ({
  AiClient: class { setAiPolicy = vi.fn(); syncAuth = vi.fn(() => null); },
}));
vi.mock('../src/utils/run-log.js', () => ({
  openRunLogFile: () => null,
  attachRunLogBridges: () => () => {},
}));

const generatedReports: TestReport[] = [];
vi.mock('../src/report/generator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/report/generator.js')>()),
  generateReport: vi.fn(async (report: TestReport) => {
    generatedReports.push(report);
    return '';
  }),
  getPrimaryModel: () => undefined,
  buildReportBaseName: (report: { testName: string }) => report.testName,
}));

vi.mock('../src/report/history-appender.js', () => ({
  appendRunHistory: vi.fn(async () => undefined),
}));

import { runTest } from '../src/runner/test-runner.js';
import { parseTestFile } from '../src/parser/markdown.js';
import { renderReport } from '../src/report/generator.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(repoRoot, 'tests', '.tmp-failure-outcomes-runner');

const TOLERATED_STEP = 'Verify the footer shows the build number otherwise continue';
const FAIL_STEP =
  'If {{a}} is "peanuts" then fail the test with error "The variable value was peanuts. Expected apples"';

/** A test file whose `## Steps` are these lines, numbered. */
const stepsDoc = (...lines: string[]): string =>
  `# t\n\n## Steps\n${lines.map((line, i) => `${i + 1}. ${line}`).join('\n')}\n`;

/** The shape most cases drive: the line under test, and a step after it whose
 *  status says whether the run carried on. */
const docWith = (line: string): string => stepsDoc('Navigate to /', line, 'Click "Sign out"');

const TOLERATED_DOC = docWith(TOLERATED_STEP);
const FAIL_DOC = docWith(FAIL_STEP);
const BARE_DOC = docWith('Fail the test with error "No balance was shown"');
/** Nothing under test in the steps — the hook cases put the line in a hook. */
const PLAIN_DOC = stepsDoc('Navigate to /', 'Click "Sign out"');

type Scope = 'before' | 'beforeEach' | 'afterEach' | 'after';

/** A hook set, with the `toolCalls` / `sourceSkills` slots the loop indexes by
 *  position: one null per line, since these are all prose hooks. */
function hooks(over: Partial<Record<Scope, string[]>> = {}): ResolvedHooks {
  const scopes: Record<Scope, string[]> = { before: [], beforeEach: [], afterEach: [], after: [], ...over };
  const slots = () =>
    Object.fromEntries(Object.entries(scopes).map(([scope, lines]) => [scope, lines.map(() => null)]));
  return {
    ...scopes,
    hasAny: Object.values(scopes).some((lines) => lines.length > 0),
    toolCalls: slots() as ResolvedHooks['toolCalls'],
    sourceSkills: slots() as ResolvedHooks['sourceSkills'],
  };
}

/** `ai.apiKey` is load-bearing: keyless, the diagnosis pass takes a placeholder
 *  branch that never calls `diagnoseFailure` at all, so "skipped for a deliberate
 *  failure" would pass against a loop that had done nothing of the sort. */
function makeConfig(over: Partial<Config['execution']> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    ai: { ...DEFAULT_CONFIG.ai, apiKey: 'test-key' },
    browser: { ...DEFAULT_CONFIG.browser, headed: false },
    execution: { ...DEFAULT_CONFIG.execution, ...over },
  };
}

async function instanceOf(markdown: string): Promise<TestInstance> {
  const filePath = path.join(dir, `t${file++}.md`);
  await fs.writeFile(filePath, markdown);
  const test: ParsedTest = await parseTestFile(filePath);
  return { test, resolvedParameters: {} };
}

const stub = (index: number, instruction: string) => ({ index, instruction, turns: [], retried: false });

const passed = (index: number, instruction: string): StepResult =>
  ({ ...stub(index, instruction), status: 'passed', durationMs: 1 });

/** What the executor returns for a step whose `otherwise continue` tail was
 *  applied: still `failed`, with the flag beside it (decision 6). */
const tolerated = (index: number, instruction: string, error = 'no build number in the footer'): StepResult => ({
  ...stub(index, instruction),
  status: 'failed',
  durationMs: 2,
  error,
  tolerated: true,
  aiExplanation: `The run continued past this step (otherwise continue). What failed: ${error}`,
});

/** What the executor returns for a `fail`-claiming step whose condition held. */
const deliberate = (index: number, instruction: string, message: string): StepResult => ({
  ...stub(index, instruction),
  status: 'failed',
  durationMs: 2,
  error: message,
  deliberate: true,
  aiExplanation: "The step's condition held and the step says to fail the test.",
});

type LoopOpts = {
  /** The step the mocked executor answers with a tolerated failure. */
  tolerate?: number;
  /** …with an ordinary framework failure: the control the other two need. */
  fail?: number;
  /** …with a deliberate `fail` carrying the author's message. */
  deliberate?: [index: number, message: string];
  /** Keyed by instruction instead, for a hook line that shares a step's index. */
  byLine?: Record<string, (index: number, instruction: string) => StepResult>;
  config?: Config;
  over?: Partial<Config['execution']>;
};

/** One run of the real `runTest` over `md`, with the mocked executor answering as
 *  `opts` says and passing every other step. */
async function runLoop(md: string, opts: LoopOpts = {}): Promise<TestReport> {
  const answers: Record<number, (instruction: string) => StepResult> = {};
  if (opts.tolerate !== undefined) answers[opts.tolerate] = (s) => tolerated(opts.tolerate!, s);
  if (opts.fail !== undefined) {
    answers[opts.fail] = (s) => ({ ...passed(opts.fail!, s), status: 'failed', error: 'boom' });
  }
  if (opts.deliberate) {
    const [index, message] = opts.deliberate;
    answers[index] = (s) => deliberate(index, s, message);
  }
  executeStepMock.mockImplementation(
    async (index: number, _total: number, instruction: string) => {
      const byLine = opts.byLine?.[instruction];
      if (byLine) return byLine(index, instruction);
      const answer = answers[index];
      return answer ? answer(instruction) : passed(index, instruction);
    },
  );
  return runTest(await instanceOf(md), opts.config ?? makeConfig(opts.over));
}

/** `index → status` for the real steps of the run (hooks excluded). */
function statuses(report: TestReport): Array<[number, string]> {
  return report.steps
    .filter((s) => !s.hookScope)
    .map((s) => [s.index, s.status] as [number, string]);
}

let dir: string;
let counter = 0;
let file = 0;

beforeEach(async () => {
  executeStepMock.mockReset();
  executeStepCalls.length = 0;
  launchBrowserMock.mockReset();
  closeBrowserMock.mockReset();
  replMock.mockClear();
  diagnoseMock.mockClear();
  captureScreenshotMock.mockClear();
  generatedReports.length = 0;
  hooksStub = hooks();
  launchBrowserMock.mockResolvedValue({
    page: { url: () => 'https://app.test/', goto: vi.fn(async () => undefined) },
  });
  closeBrowserMock.mockResolvedValue(undefined);
  dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpBase, { recursive: true, force: true });
});

// ─── `otherwise continue` ───────────────────────────────────────────────────

describe('a tolerated failure mid-run', () => {
  it('runs the next step, passes the run, and counts the failure separately', async () => {
    const report = await runLoop(TOLERATED_DOC, { tolerate: 2 });

    // The row is a FAILURE — nothing paints it green; what changes is only what
    // the run does about it.
    expect(statuses(report)).toEqual([[1, 'passed'], [2, 'failed'], [3, 'passed']]);
    expect(report.status).toBe('passed');
    expect(report.failedSteps).toBe(0);
    expect(report.toleratedSteps).toBe(1);
    // And it is not counted as a pass either: 3 steps, 2 passed, 1 tolerated.
    expect(report.passedSteps).toBe(2);
    // Step 3 really ran, which is the whole claim.
    expect(executeStepCalls.map((c) => c.index)).toEqual([1, 2, 3]);
  });

  it('omits toleratedSteps entirely on a run that tolerated nothing', async () => {
    const report = await runLoop(TOLERATED_DOC);
    expect(report.status).toBe('passed');
    expect(report.toleratedSteps).toBeUndefined();
  });

  it('hands the executor the tail — for this step and no other', async () => {
    await runLoop(TOLERATED_DOC, { tolerate: 2 });

    expect(executeStepCalls[0]!.opts['failureTail']).toBeUndefined();
    expect(executeStepCalls[1]!.opts['failureTail']).toEqual({
      body: 'Verify the footer shows the build number',
      outcome: 'continue',
    });
    expect(executeStepCalls[2]!.opts['failureTail']).toBeUndefined();
    // Never as a claim: a claim would let the model end the flow from this line.
    expect(executeStepCalls[1]!.opts['flowControlClaim']).toBeUndefined();
  });

  it('hands the executor the RESOLVED tail message on the line, and the authored one on the tail', async () => {
    // Decision 3 at the loop's half of the seam: the tail is parsed off the
    // AUTHORED line, so its `message` keeps the braces and only the instruction
    // carries the resolved one — the pair `resolvedTailMessage` needs.
    const line =
      'Verify the footer shows the build number otherwise continue with warning ' +
      '"Missing build number for {{release}}"';
    await runLoop(stepsDoc('Navigate to /', 'Set {{release}} to "4.2.1"', line), { tolerate: 3 });

    // A `Set` step is dispatched by the loop itself and never reaches the executor.
    const call = executeStepCalls.find((c) => c.index === 3)!;
    expect(call.instruction).toBe(
      'Verify the footer shows the build number otherwise continue with warning ' +
        '"Missing build number for 4.2.1"',
    );
    expect(call.opts['failureTail']).toEqual({
      body: 'Verify the footer shows the build number',
      outcome: 'continue',
      message: 'Missing build number for {{release}}',
    });
  });

  it('leaves a history line saying the run carried on, so a later step is not left guessing', async () => {
    await runLoop(TOLERATED_DOC, { tolerate: 2 });

    // Read off the options the NEXT step was handed: the history is built for the
    // model, and this is where it lands.
    const history = executeStepCalls[2]!.opts['conversationHistory'] as string[];
    expect(history).toContain('[flow] step 2 failed and the run continued (otherwise continue)');
    // The ordinary failed entry is there too: the line explains it, not replaces it.
    expect(history.some((l) => l.includes('Step 2') && /fail/i.test(l))).toBe(true);
  });

  it('runs afterEach for the tolerated step, as for any completed step', async () => {
    hooksStub = hooks({ beforeEach: ['dismiss any banner'], afterEach: ['snapshot the page'] });
    // Keyed by line, because a hook row shares the step's index.
    const report = await runLoop(TOLERATED_DOC, {
      byLine: { [TOLERATED_STEP]: (i, s) => tolerated(i, s) },
    });

    expect(report.steps.filter((s) => s.hookScope).map((s) => `${s.hookScope}@${s.index}`)).toEqual([
      'beforeEach@1', 'afterEach@1',
      'beforeEach@2', 'afterEach@2',
      'beforeEach@3', 'afterEach@3',
    ]);
    expect(report.status).toBe('passed');
  });

  it('does NOT enter the failure REPL — and an ordinary failure still does', async () => {
    // The REPL needs a headed, TTY run with `interactiveOnFailure`. Both halves
    // run under the same conditions, so the contrast is the assertion.
    const isTty = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      const config: Config = {
        ...makeConfig({ interactiveOnFailure: true }),
        browser: { ...DEFAULT_CONFIG.browser, headed: true },
      };

      await runLoop(TOLERATED_DOC, { tolerate: 2, config });
      expect(replMock).not.toHaveBeenCalled();

      // The control: the same step failing WITHOUT a tolerated flag.
      executeStepCalls.length = 0;
      await runLoop(TOLERATED_DOC, { fail: 2, config });
      expect(replMock).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: isTty, configurable: true });
    }
  });

  it('keeps a looped section looping — a tolerated failure did not end the pass', async () => {
    // Iteration 1's middle step is tolerated; everything else passes.
    const report = await runLoop(`${stepsDoc('Check each')}
### Check each

| term |
| --- |
| shoes |
| hats |

1. Search for {{term}}
2. Verify the result count is shown otherwise continue
3. Open the first result
`, { tolerate: 2 });

    expect(statuses(report)).toEqual([
      [1, 'passed'],   // Search for shoes
      [2, 'failed'],   // tolerated
      [3, 'passed'],   // Open the first result — the pass was NOT abandoned
      [4, 'passed'],   // Search for hats
      [5, 'passed'],
      [6, 'passed'],
    ]);
    expect(report.status).toBe('passed');
    expect(report.toleratedSteps).toBe(1);
  });

  it('shows a Tolerated stat on the report and no red banner', async () => {
    const html = renderReport(await runLoop(TOLERATED_DOC, { tolerate: 2 }));
    expect(html).toMatch(/badge badge-pass">✓ PASSED</);
    expect(html).toMatch(/stat-tolerated">1</);
  });
});

// ─── The deliberate `fail` ──────────────────────────────────────────────────

describe('a conditional `fail` whose condition held', () => {
  const MESSAGE = 'The variable value was peanuts. Expected apples';

  it('fails the run with the author`s message and stops there', async () => {
    const report = await runLoop(FAIL_DOC, { deliberate: [2, MESSAGE] });

    expect(report.status).toBe('failed');
    expect(report.failedSteps).toBe(1);
    expect(report.toleratedSteps).toBeUndefined();
    expect(statuses(report)).toEqual([[1, 'passed'], [2, 'failed']]);
    expect(report.steps[1]!.error).toBe(MESSAGE);
    expect(report.steps[1]!.deliberate).toBe(true);
    // Step 3 never started.
    expect(executeStepCalls.map((c) => c.index)).toEqual([1, 2]);
  });

  it('hands the executor the claim, which is what lets a `fail` action through', async () => {
    await runLoop(FAIL_DOC, { deliberate: [2, 'nope'] });

    expect(executeStepCalls[1]!.opts['flowControlClaim']).toEqual({
      verb: 'fail',
      body: '{{a}} is "peanuts"',
      message: MESSAGE,
    });
    // A claim and a tail are never both read off one line.
    expect(executeStepCalls[1]!.opts['failureTail']).toBeUndefined();
  });

  it('skips the diagnosis pass — and an ordinary failure still gets one', async () => {
    await runLoop(FAIL_DOC, { deliberate: [2, MESSAGE] });
    expect(diagnoseMock).not.toHaveBeenCalled();

    // The control. Same run, same config, a failure the framework produced.
    await runLoop(FAIL_DOC, { fail: 2 });
    expect(diagnoseMock).toHaveBeenCalledTimes(1);
  });
});

// ─── The unconditional `Fail` ───────────────────────────────────────────────

describe('a bare `Fail the test with error "…"` step', () => {
  it('costs no model call at all and fails the run in the author`s words', async () => {
    const report = await runLoop(BARE_DOC);

    // Step 2 never reached the executor (decision 3).
    expect(executeStepCalls.map((c) => c.index)).toEqual([1]);
    expect(statuses(report)).toEqual([[1, 'passed'], [2, 'failed']]);
    expect(report.status).toBe('failed');
    expect(report.steps[1]!.error).toBe('No balance was shown');
    expect(report.steps[1]!.deliberate).toBe(true);
    expect(report.steps[1]!.aiExplanation).toBe('Failed by the step, as written — no model call.');
    expect(report.steps[1]!.turns).toEqual([]);
    // No `flowControl` record: that record means the step ended the flow as a PASS
    // (decision 1).
    expect(report.steps[1]!.flowControl).toBeUndefined();
  });

  it.each([
    {
      label: 'falls back to the framework`s wording when no message was written',
      md: stepsDoc('Navigate to /', 'Fail the test'),
      error: 'Failed by the step, as written',
    },
    {
      label: 'resolves `{{…}}` in the message, like any other step text (decision 3)',
      md: stepsDoc('Set {{who}} to "peanuts"', 'Fail the test with error "It was {{who}}"'),
      error: 'It was peanuts',
    },
  ])('$label', async ({ md, error }) => {
    const report = await runLoop(md);
    expect(report.steps[1]!.error).toBe(error);
  });

  it('takes a failure screenshot when the config asks, and none when it does not', async () => {
    const withShot = await runLoop(BARE_DOC, { over: { screenshotOnFailure: true } });
    expect(captureScreenshotMock).toHaveBeenCalledTimes(1);
    expect(withShot.steps[1]!.screenshotBase64).toBe('shot');

    captureScreenshotMock.mockClear();
    const withoutShot = await runLoop(BARE_DOC, { over: { screenshotOnFailure: false } });
    expect(captureScreenshotMock).not.toHaveBeenCalled();
    expect(withoutShot.steps[1]!.screenshotBase64).toBeUndefined();
  });
});

// ─── The contradiction backstop (decision 8) ────────────────────────────────

describe('a line that both ends the flow and tolerates its own failure', () => {
  it('never reaches the run: the parse refuses the file first, with that sentence', async () => {
    // `validateControlFlow` runs over `## Steps` AND every `### Section` body, so
    // no file delivers one of these to the loop; the loop's backstop stays for the
    // validator-less paths, and `api-server-failure-outcomes.test.ts` pins it
    // firing there in this same sentence — decision 8's actual requirement.
    const line = 'If the page is ready then return otherwise continue';
    await expect(
      instanceOf(`${stepsDoc('Navigate to /', 'Check it', 'Click "Sign out"')}
### Check it
1. ${line}
`),
    ).rejects.toThrow('a step cannot both end the flow and tolerate its own failure');
    // The line is named back, so the author can find it.
    await expect(instanceOf(stepsDoc(line))).rejects.toThrow(line);
  });
});

// ─── Hooks (decision 7) ─────────────────────────────────────────────────────

/** A `before` hook the loop must refuse or abort on, and what the row says. */
const ABORTING_HOOKS: Array<{
  label: string;
  line: string;
  contains?: string;
  error?: string;
  deliberate?: true;
}> = [
  {
    label: 'still refuses a `return` hook — the verb is what is refused, not the parse',
    line: 'If we are already signed in then return',
    contains: 'flow control is not allowed in hooks',
  },
  {
    label: 'dispatches an UNCONDITIONAL `Fail …` hook with no model call, and aborts the run',
    line: 'Fail the test with error "the environment is not ready"',
    error: 'the environment is not ready',
    deliberate: true,
  },
];

describe('hooks and the two outcomes', () => {
  it.each(ABORTING_HOOKS)('$label', async (row) => {
    hooksStub = hooks({ before: [row.line] });
    const report = await runLoop(PLAIN_DOC);

    expect(report.status).toBe('failed');
    const hook = report.steps.find((s) => s.hookScope === 'before')!;
    expect(hook.status).toBe('failed');
    if (row.contains !== undefined) expect(hook.error).toContain(row.contains);
    if (row.error !== undefined) expect(hook.error).toBe(row.error);
    if (row.deliberate) expect(hook.deliberate).toBe(true);
    expect(executeStepCalls).toHaveLength(0);
  });

  it('accepts a CONDITIONAL `fail` hook and hands it the claim', async () => {
    // A hook can already fail the run: the verb adds a message, not a power (7).
    const line = 'If the balance is zero then fail the test with error "no balance"';
    hooksStub = hooks({ before: [line] });
    const report = await runLoop(PLAIN_DOC);

    expect(report.status).toBe('passed');
    const hookCall = executeStepCalls.find((c) => c.instruction === line)!;
    expect(hookCall).toBeDefined();
    expect(hookCall.opts['flowControlClaim']).toEqual({
      verb: 'fail',
      body: 'the balance is zero',
      message: 'no balance',
    });
  });

  it('does not abort the run for a TOLERATED hook step', async () => {
    const line = 'Dismiss the survey prompt otherwise continue';
    hooksStub = hooks({ before: [line, 'sign in'] });
    const report = await runLoop(PLAIN_DOC, {
      byLine: { [line]: (i, s) => tolerated(i, s, 'no survey prompt') },
    });

    // The hook row says `failed`, but the SCOPE did not fail — so the hook after
    // it ran, and the test ran at all.
    const hookRows = report.steps.filter((s) => s.hookScope === 'before');
    expect(hookRows.map((s) => s.status)).toEqual(['failed', 'passed']);
    expect(report.status).toBe('passed');
    expect(statuses(report)).toEqual([[1, 'passed'], [2, 'passed']]);
    // And it carries a tail like any prose step.
    expect(executeStepCalls[0]!.opts['failureTail']).toEqual({
      body: 'Dismiss the survey prompt',
      outcome: 'continue',
    });
  });
});

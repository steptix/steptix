/**
 * Control flow through the real CLI runner (stories/control-flow.md §Runtime).
 *
 * The test files are PARSED for real — `parseTestFile` is what produces the
 * `controls` array the run loop reads, and a hand-built one would be a test of
 * this suite's idea of the expander rather than of the expander. Only the
 * browser, the model and the report writer are mocked, exactly as
 * `test-runner-clarification-control.test.ts` mocks them.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Config } from '../src/config/types.js';
import type { ParsedTest, TestInstance } from '../src/parser/types.js';
import type { StepResult } from '../src/report/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

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
  BrowserTracker: class {
    private session: unknown;
    constructor(initial: unknown) { this.session = initial; }
    getActive() { return this.session; }
    getActivePage() { return (this.session as { page: unknown }).page; }
    has() { return false; }
    add() {}
    switchTo() { return this.session; }
    async close() {}
    async closeAll() { closeBrowserMock(this.session); }
    list() { return []; }
    get count() { return 1; }
  },
}));

const executeStepMock = vi.fn();
const evaluateConditionsMock = vi.fn();
const executeBranchedStepMock = vi.fn();
vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: (...args: unknown[]) => executeStepMock(...args),
  executeBranchedStep: (...args: unknown[]) => executeBranchedStepMock(...args),
  evaluateConditions: (...args: unknown[]) => evaluateConditionsMock(...args),
}));

vi.mock('../src/runner/interactive-repl.js', () => ({
  runInteractiveRepl: vi.fn(),
}));

const resolveHooksMock = vi.fn();
vi.mock('../src/runner/hooks.js', () => ({
  resolveHooks: (...args: unknown[]) => resolveHooksMock(...args),
}));

vi.mock('../src/cache/step-cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/cache/step-cache.js')>()),
  StepCache: {
    initialize: vi.fn(async () => ({
      read: () => null,
      write: vi.fn(),
      readAssertion: () => null,
      invalidateStep: vi.fn(),
    })),
  },
}));

vi.mock('../src/ai/diagnose.js', () => ({ diagnoseFailure: vi.fn(async () => null) }));
vi.mock('../src/ai/client.js', () => ({
  AiClient: class { setAiPolicy = vi.fn(); syncAuth = vi.fn(() => null); },
}));
vi.mock('../src/utils/run-log.js', () => ({
  openRunLogFile: () => null,
  attachRunLogBridges: () => () => {},
}));
vi.mock('../src/report/generator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/report/generator.js')>()),
  generateReport: vi.fn().mockResolvedValue(''),
  getPrimaryModel: () => undefined,
  buildReportBaseName: (report: { testName: string }) => report.testName,
}));
vi.mock('../src/report/history-appender.js', () => ({
  appendRunHistory: vi.fn().mockResolvedValue(undefined),
}));

import { runTest } from '../src/runner/test-runner.js';
import { parseTestFile } from '../src/parser/markdown.js';
// Not mocked: the console lines below are asserted by spying on the real
// logger object, which is what `test-runner.ts` calls through.
import { logger } from '../src/utils/logger.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpDir: string | undefined;

async function parse(markdown: string, name = 'control.md'): Promise<ParsedTest> {
  tmpDir ??= await fs.mkdtemp(path.join(os.tmpdir(), 'control-flow-cli-'));
  const file = path.join(tmpDir, name);
  await fs.writeFile(file, markdown, 'utf-8');
  return parseTestFile(file, {});
}

async function instance(
  markdown: string,
  parameters: Record<string, string> = {},
  name?: string,
): Promise<TestInstance> {
  const test = await parse(markdown, name);
  return { test, resolvedParameters: parameters };
}

function makeConfig(overrides: Partial<Config['execution']> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    execution: { ...DEFAULT_CONFIG.execution, ...overrides },
    browser: { ...DEFAULT_CONFIG.browser, headed: false },
  };
}

/** `[instruction, status]` for every row, in report order. */
function rows(steps: StepResult[]): Array<[string, string]> {
  return steps.map((s) => [s.instruction, s.status]);
}

/** The judge answers, in order. `null` is "none held". */
function judgeAnswers(...selected: Array<number | null>): void {
  for (const s of selected) {
    evaluateConditionsMock.mockResolvedValueOnce({
      selected: s,
      reasoning: s === null ? 'nothing held' : `condition ${s} held`,
      aiInteractions: [],
    });
  }
}

const CHAIN = [
  '# Chain',
  '',
  '## Steps',
  '1. Open the payments page',
  '2. If the Cash checkbox is ticked, then Pay with cash',
  '3. Otherwise, Pay by card',
  '4. Verify the order confirmation is shown',
  '',
  '### Pay with cash',
  '1. Click Pay now',
  '2. Verify the receipt says Paid in cash',
  '',
  '### Pay by card',
  '1. Enter the card details',
  '2. Submit the card form',
  '',
].join('\n');

const WHILE = [
  '# While',
  '',
  '## Steps',
  '1. Open the statements page',
  '2. While the Next button is enabled, Go to the next page',
  '3. Verify the last page is shown',
  '',
  '### Go to the next page',
  '1. Click Next',
  '',
].join('\n');

/** The conversation history the LAST executed step was handed. */
function historyOfLastStep(): string[] {
  const last = executeStepMock.mock.calls[executeStepMock.mock.calls.length - 1]!;
  return (last[3] as { conversationHistory: string[] }).conversationHistory;
}

beforeEach(() => {
  executeStepMock.mockReset();
  evaluateConditionsMock.mockReset();
  executeBranchedStepMock.mockReset();
  executeBranchedStepMock.mockImplementation(async () => []);
  launchBrowserMock.mockReset();
  closeBrowserMock.mockReset();
  resolveHooksMock.mockReset();

  launchBrowserMock.mockResolvedValue({
    page: { url: () => 'https://example.com', goto: vi.fn().mockResolvedValue(undefined) },
  });
  closeBrowserMock.mockResolvedValue(undefined);
  resolveHooksMock.mockResolvedValue({
    before: [], beforeEach: [], afterEach: [], after: [], hasAny: false,
    toolCalls: { before: [], beforeEach: [], afterEach: [], after: [] },
    sourceSkills: { before: [], beforeEach: [], afterEach: [], after: [] },
  });
  // Every ordinary step passes, echoing what it was asked to do.
  executeStepMock.mockImplementation(async (index: number, _total: number, instruction: string) => ({
    index,
    instruction,
    status: 'passed',
    turns: [],
    durationMs: 1,
    retried: false,
  }));
});

afterAll(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── Chains ─────────────────────────────────────────────────────────────────

describe('a chain decides', () => {
  it('takes the If and skips the Otherwise, in file order', async () => {
    judgeAnswers(0);
    const report = await runTest(await instance(CHAIN), makeConfig(), '');

    expect(rows(report.steps)).toEqual([
      ['Open the payments page', 'passed'],
      ['If the Cash checkbox is ticked, then Pay with cash', 'passed'],
      ['Click Pay now', 'passed'],
      ['Verify the receipt says Paid in cash', 'passed'],
      ['Otherwise, Pay by card', 'skipped'],
      ['Enter the card details', 'skipped'],
      ['Submit the card form', 'skipped'],
      ['Verify the order confirmation is shown', 'passed'],
    ]);
    // The judge was asked ONCE, about the chain's one condition.
    expect(evaluateConditionsMock).toHaveBeenCalledTimes(1);
    expect(evaluateConditionsMock.mock.calls[0]![0]).toEqual(['the Cash checkbox is ticked']);
    // The untaken branch never reached the executor.
    const executed = executeStepMock.mock.calls.map((c) => c[2]);
    expect(executed).not.toContain('Enter the card details');
  });

  it('takes the Otherwise when nothing held', async () => {
    judgeAnswers(null);
    const report = await runTest(await instance(CHAIN), makeConfig(), '');

    expect(rows(report.steps)).toEqual([
      ['Open the payments page', 'passed'],
      ['If the Cash checkbox is ticked, then Pay with cash', 'skipped'],
      ['Click Pay now', 'skipped'],
      ['Verify the receipt says Paid in cash', 'skipped'],
      ['Otherwise, Pay by card', 'passed'],
      ['Enter the card details', 'passed'],
      ['Submit the card form', 'passed'],
      ['Verify the order confirmation is shown', 'passed'],
    ]);
  });

  it('carries the model reasoning on the guard row', async () => {
    evaluateConditionsMock.mockResolvedValueOnce({
      selected: 0,
      reasoning: 'The Cash checkbox is checked and Card is not',
      aiInteractions: [
        { purpose: 'condition-judge', response: '{"matched":"A"}', timestamp: 'now' },
      ],
    });
    const report = await runTest(await instance(CHAIN), makeConfig(), '');
    const guard = report.steps[1]!;
    expect(guard.aiExplanation).toBe('The Cash checkbox is checked and Card is not');
    // The judge's turn rides the guard row, so its cost is in the report.
    expect(guard.turns).toHaveLength(1);
    expect(guard.turns[0]!.aiInteractions).toHaveLength(1);
    expect(guard.turns[0]!.subActions).toHaveLength(0);
  });

  it('skips the whole chain when nothing holds and there is no Otherwise', async () => {
    const md = [
      '# No otherwise',
      '',
      '## Steps',
      '1. Open the page',
      '2. If a cookie banner appears, then Dismiss the banner',
      '3. Carry on',
      '',
      '### Dismiss the banner',
      '1. Click Reject all',
      '',
    ].join('\n');
    judgeAnswers(null);
    const report = await runTest(await instance(md, {}, 'no-otherwise.md'), makeConfig(), '');

    expect(rows(report.steps)).toEqual([
      ['Open the page', 'passed'],
      ['If a cookie banner appears, then Dismiss the banner', 'skipped'],
      ['Click Reject all', 'skipped'],
      ['Carry on', 'passed'],
    ]);
    // The one decision the run made still left its reasoning somewhere.
    expect(report.steps[1]!.aiExplanation).toBe('nothing held');
  });

  it('fails the guard when the judge could not decide', async () => {
    evaluateConditionsMock.mockRejectedValueOnce(
      new Error('could not decide: the page did not settle within 30s while judging "x"'),
    );
    const report = await runTest(await instance(CHAIN), makeConfig(), '');

    expect(report.status).toBe('failed');
    const guard = report.steps[1]!;
    expect(guard.status).toBe('failed');
    expect(guard.error).toContain('could not decide: the page did not settle');
    // Nothing after the guard ran.
    expect(report.steps).toHaveLength(2);
  });
});

// ─── Conversation history ───────────────────────────────────────────────────

const ELSEIF_CHAIN = [
  '# Else if',
  '',
  '## Steps',
  '1. Open the payments page',
  '2. If the Cash checkbox is ticked, then Pay with cash',
  '3. Else if the Card checkbox is ticked, then Pay by card',
  '4. Otherwise, Verify the Pay now button is disabled',
  '5. Verify the order confirmation is shown',
  '',
  '### Pay with cash',
  '1. Click Pay now',
  '',
  '### Pay by card',
  '1. Enter the card details',
  '',
].join('\n');

describe('what the chain tells later steps', () => {
  it('records the SELECTED member as held, and the ones it beat as not', async () => {
    // The judge answers about the request's condition LIST — index 1 is the
    // `Else if`, whose absolute index is 3.
    judgeAnswers(1);
    const report = await runTest(await instance(ELSEIF_CHAIN, {}, 'elseif.md'), makeConfig(), '');

    expect(rows(report.steps)).toEqual([
      ['Open the payments page', 'passed'],
      ['If the Cash checkbox is ticked, then Pay with cash', 'skipped'],
      ['Click Pay now', 'skipped'],
      ['Else if the Card checkbox is ticked, then Pay by card', 'passed'],
      ['Enter the card details', 'passed'],
      ['Otherwise, Verify the Pay now button is disabled', 'skipped'],
      ['Verify the Pay now button is disabled', 'skipped'],
      ['Verify the order confirmation is shown', 'passed'],
    ]);

    // `## Prior Steps` is what every later step reads as evidence, and the run
    // branched here: the line that held is the `Else if`, not the head of the
    // chain the judge was asked from.
    const history = historyOfLastStep();
    expect(history).toContain(
      'If the Cash checkbox is ticked, then Pay with cash → did not hold',
    );
    expect(history).toContain(
      'Else if the Card checkbox is ticked, then Pay by card → held',
    );
    expect(history.join('\n')).not.toContain(
      'If the Cash checkbox is ticked, then Pay with cash → held',
    );
    // The `Otherwise` was never asked about — first-holds-wins stopped above
    // it — so nothing claims it did not hold.
    expect(history.some((l) => l.startsWith('Otherwise,'))).toBe(false);
  });

  it('says every member did not hold when nothing did and there is no Otherwise', async () => {
    const md = [
      '# No otherwise',
      '',
      '## Steps',
      '1. Open the page',
      '2. If the Cash checkbox is ticked, then Pay with cash',
      '3. Else if the Card checkbox is ticked, then Pay by card',
      '4. Carry on',
      '',
      '### Pay with cash',
      '1. Click Pay now',
      '',
      '### Pay by card',
      '1. Enter the card details',
      '',
    ].join('\n');
    judgeAnswers(null);
    await runTest(await instance(md, {}, 'elseif-none.md'), makeConfig(), '');

    const history = historyOfLastStep();
    expect(history).toContain(
      'If the Cash checkbox is ticked, then Pay with cash → did not hold',
    );
    expect(history).toContain(
      'Else if the Card checkbox is ticked, then Pay by card → did not hold',
    );
  });

  it('a loop still writes one line per evaluation', async () => {
    judgeAnswers(0, null);
    await runTest(await instance(WHILE, {}, 'while-history.md'), makeConfig(), '');

    const history = historyOfLastStep();
    const guardLines = history.filter((l) => l.startsWith('While '));
    expect(guardLines).toEqual([
      'While the Next button is enabled, Go to the next page → held',
      'While the Next button is enabled, Go to the next page → ended',
    ]);
  });
});

// ─── Watch groups beside control flow ───────────────────────────────────────

describe('a watch group inside control flow', () => {
  /** What `executeBranchedStep` really returns: rows carrying the group's own
   *  **0-based** step indices, matched row first. Pinned here because the loop
   *  marker and the source-section tag are both stamped on that reading. */
  const branchedRowsFor = (skipText: string, contText: string) => async (group: {
    conditionalSteps: { index: number }[];
    continuationStep: { index: number };
  }) => [
    {
      index: group.conditionalSteps[0]!.index,
      instruction: skipText,
      status: 'skipped' as const,
      turns: [],
      durationMs: 1,
      retried: false,
    },
    {
      index: group.continuationStep.index,
      instruction: contText,
      status: 'passed' as const,
      turns: [],
      durationMs: 1,
      retried: false,
    },
  ];

  it('keeps the report in file order when a chain is skipped just above it', async () => {
    const md = [
      '# Watch after a chain',
      '',
      '## Steps',
      '1. Open the page',
      '2. If the Cash checkbox is ticked, then Pay with cash',
      '3. Otherwise, Pay by card',
      '4. If a cookie banner appears, click Reject all',
      '5. Click Continue',
      '',
      '### Pay with cash',
      '1. Click Pay now',
      '',
      '### Pay by card',
      '1. Enter the card details',
      '',
    ].join('\n');
    judgeAnswers(0);
    executeBranchedStepMock.mockImplementation(
      branchedRowsFor('If a cookie banner appears, click Reject all', 'Click Continue'),
    );
    const report = await runTest(await instance(md, {}, 'watch-after-chain.md'), makeConfig(), '');

    // The untaken `Otherwise` and its body are released BEFORE the group's own
    // rows — without the flush they sank to the bottom of the report, below
    // the two steps that ran after them.
    expect(rows(report.steps)).toEqual([
      ['Open the page', 'passed'],
      ['If the Cash checkbox is ticked, then Pay with cash', 'passed'],
      ['Click Pay now', 'passed'],
      ['Otherwise, Pay by card', 'skipped'],
      ['Enter the card details', 'skipped'],
      ['If a cookie banner appears, click Reject all', 'skipped'],
      ['Click Continue', 'passed'],
    ]);
  });

  it('stamps the running pass on the branched rows, and tags their section', async () => {
    const md = [
      '# Watch in a loop',
      '',
      '## Steps',
      '1. Open the page',
      '2. While the Next button is enabled, Go to the next page',
      '3. Verify the last page',
      '',
      '### Go to the next page',
      '1. If a cookie banner appears, click Reject all',
      '2. Click Next',
      '',
    ].join('\n');
    judgeAnswers(0, 0, null);
    executeBranchedStepMock.mockImplementation(
      branchedRowsFor('If a cookie banner appears, click Reject all', 'Click Next'),
    );
    const report = await runTest(await instance(md, {}, 'watch-in-loop.md'), makeConfig(), '');

    const banded = report.steps.map((s) => [
      s.instruction,
      s.loop ? `${s.loop.index}/${s.loop.count ?? '?'}` : null,
    ]);
    expect(banded).toEqual([
      ['Open the page', null],
      ['While the Next button is enabled, Go to the next page', '1/2'],
      ['If a cookie banner appears, click Reject all', '1/2'],
      ['Click Next', '1/2'],
      ['While the Next button is enabled, Go to the next page', '2/2'],
      ['If a cookie banner appears, click Reject all', '2/2'],
      ['Click Next', '2/2'],
      // The evaluation that ENDED the loop belongs to no pass.
      ['While the Next button is enabled, Go to the next page', null],
      ['Verify the last page', null],
    ]);
    // The same 0-based reading tags the section — the neighbouring lookup used
    // `result.index - 1` and read the previous step's section instead.
    const branched = report.steps.filter((s) => s.instruction === 'Click Next');
    expect(branched.every((s) => s.sourceSection === 'Go to the next page')).toBe(true);
  });
});

// ─── Loops ──────────────────────────────────────────────────────────────────

describe('a loop decides again', () => {
  it('runs While three times and back-fills the count when it ends', async () => {
    judgeAnswers(0, 0, 0, null);
    const report = await runTest(await instance(WHILE, {}, 'while.md'), makeConfig(), '');

    expect(rows(report.steps)).toEqual([
      ['Open the statements page', 'passed'],
      ['While the Next button is enabled, Go to the next page', 'passed'],
      ['Click Next', 'passed'],
      ['While the Next button is enabled, Go to the next page', 'passed'],
      ['Click Next', 'passed'],
      ['While the Next button is enabled, Go to the next page', 'passed'],
      ['Click Next', 'passed'],
      ['While the Next button is enabled, Go to the next page', 'passed'],
      ['Verify the last page is shown', 'passed'],
    ]);
    // One guard row per EVALUATION — four, because the fourth is what ended it.
    expect(evaluateConditionsMock).toHaveBeenCalledTimes(4);
    // The body's markers were handed out without a count and back-filled to 3.
    const bodyMarkers = report.steps.filter((s) => s.instruction === 'Click Next').map((s) => s.loop);
    expect(bodyMarkers).toEqual([
      { kind: 'iteration', label: 'Go to the next page', index: 1, count: 3, values: {} },
      { kind: 'iteration', label: 'Go to the next page', index: 2, count: 3, values: {} },
      { kind: 'iteration', label: 'Go to the next page', index: 3, count: 3, values: {} },
    ]);
  });

  it('skips the body of a While whose condition was false from the start', async () => {
    judgeAnswers(null);
    const report = await runTest(await instance(WHILE, {}, 'while-none.md'), makeConfig(), '');

    expect(rows(report.steps)).toEqual([
      ['Open the statements page', 'passed'],
      // The guard DECIDED, so it passed — a loop that runs no passes is not a
      // failure (stories/control-flow.md §"A loop is a decision made again").
      ['While the Next button is enabled, Go to the next page', 'passed'],
      ['Click Next', 'skipped'],
      ['Verify the last page is shown', 'passed'],
    ]);
  });

  it('runs Repeat … until at least once and stops when the condition holds', async () => {
    const md = [
      '# Repeat',
      '',
      '## Steps',
      '1. Open the alerts page',
      '2. Repeat Click Load more until the Load more button is gone',
      '3. Verify every alert is listed',
      '',
    ].join('\n');
    // Pass 1 runs before anything is asked; then false, false, true.
    judgeAnswers(null, null, 0);
    const report = await runTest(await instance(md, {}, 'repeat.md'), makeConfig(), '');

    expect(rows(report.steps)).toEqual([
      ['Open the alerts page', 'passed'],
      // No guard row for the first visit: it asked nobody.
      ['Click Load more', 'passed'],
      ['Repeat Click Load more until the Load more button is gone', 'passed'],
      ['Click Load more', 'passed'],
      ['Repeat Click Load more until the Load more button is gone', 'passed'],
      ['Click Load more', 'passed'],
      ['Repeat Click Load more until the Load more button is gone', 'passed'],
      ['Verify every alert is listed', 'passed'],
    ]);
    expect(evaluateConditionsMock).toHaveBeenCalledTimes(3);
  });

  it('fails the loop line at its cap, naming the cap and where it came from', async () => {
    const md = [
      '# Cap',
      '',
      '## Steps',
      '1. Open the alerts page',
      '2. Repeat Click Load more until the Load more button is gone, up to 2 times',
      '3. Verify every alert is listed',
      '',
    ].join('\n');
    judgeAnswers(null, null, null, null, null);
    const report = await runTest(await instance(md, {}, 'cap.md'), makeConfig(), '');

    expect(report.status).toBe('failed');
    const failed = report.steps.find((s) => s.status === 'failed')!;
    expect(failed.instruction).toContain('Repeat Click Load more until');
    expect(failed.error).toContain('cap of 2 passes');
    expect(failed.error).toContain("this line's `, up to N times`");
    expect(failed.error).toContain('was still not true');
  });

  it('names execution.maxLoopIterations when the cap came from config', async () => {
    const md = [
      '# Config cap',
      '',
      '## Steps',
      '1. Open the statements page',
      '2. While the Next button is enabled, Click Next',
      '',
    ].join('\n');
    judgeAnswers(0, 0, 0, 0, 0, 0);
    const report = await runTest(
      await instance(md, {}, 'config-cap.md'),
      makeConfig({ maxLoopIterations: 3 }),
      '',
    );

    const failed = report.steps.find((s) => s.status === 'failed')!;
    expect(failed.error).toContain('cap of 3 passes (execution.maxLoopIterations)');
    expect(failed.error).toContain('was still true');
  });
});

// ─── Nesting ────────────────────────────────────────────────────────────────

describe('a structure that ends in a loop', () => {
  it('re-enters the OUTER loop when both close on the same step', async () => {
    // The inner `While` is the last step of the outer's body, so both loops
    // end at the same index. The outer's re-entry lives one hop further out
    // than `planAfterStep` can see from a body step (`exitFrom`).
    const md = [
      '# Nested loops',
      '',
      '## Steps',
      '1. Open the archive',
      '2. While a year remains, Process the year',
      '3. Verify the archive is empty',
      '',
      '### Process the year',
      '1. Open the year',
      '2. While a month remains, Click the next month',
      '',
    ].join('\n');
    // outer true, inner true, inner false, outer true, inner false, outer false
    judgeAnswers(0, 0, null, 0, null, null);
    const report = await runTest(await instance(md, {}, 'nested-loops.md'), makeConfig(), '');

    expect(report.status).toBe('passed');
    // Two outer passes: the run did NOT fall out of the outer loop when the
    // inner one ended.
    const outerBody = report.steps.filter((s) => s.instruction === 'Open the year');
    expect(outerBody).toHaveLength(2);
    expect(outerBody.map((s) => s.loop!.index)).toEqual([1, 2]);
    expect(report.steps.at(-1)!.instruction).toBe('Verify the archive is empty');
  });

  it('leaves the chain, not the next member, when a branch body ends in a loop', async () => {
    const md = [
      '# Loop in a branch',
      '',
      '## Steps',
      '1. Open the page',
      '2. If the list is long, then Page through it',
      '3. Otherwise, Read the only page',
      '4. Sign out',
      '',
      '### Page through it',
      '1. While the Next button is enabled, Click Next',
      '',
    ].join('\n');
    // The chain takes the If; then the inner While runs twice and stops.
    judgeAnswers(0, 0, 0, null);
    const report = await runTest(await instance(md, {}, 'loop-in-branch.md'), makeConfig(), '');

    expect(rows(report.steps)).toEqual([
      ['Open the page', 'passed'],
      ['If the list is long, then Page through it', 'passed'],
      ['While the Next button is enabled, Click Next', 'passed'],
      ['Click Next', 'passed'],
      ['While the Next button is enabled, Click Next', 'passed'],
      ['Click Next', 'passed'],
      ['While the Next button is enabled, Click Next', 'passed'],
      // The `Otherwise` was decided against and is NOT re-evaluated when the
      // loop inside the taken branch ends.
      ['Otherwise, Read the only page', 'skipped'],
      ['Read the only page', 'skipped'],
      ['Sign out', 'passed'],
    ]);
    // Four judge calls: one for the chain, three for the loop.
    expect(evaluateConditionsMock).toHaveBeenCalledTimes(4);
  });
});

// ─── For each ───────────────────────────────────────────────────────────────

const FOR_EACH = [
  '# For each',
  '',
  '## Steps',
  '1. Open the accounts page',
  '2. For each {{account}} in {{accounts}}, Check the account',
  '3. Sign out',
  '',
  '### Check the account',
  '1. Click the account row',
  '2. Verify the balance is shown',
  '',
].join('\n');

describe('For each binds the list', () => {
  it('runs the body once per element, with the item bound for the pass', async () => {
    const inst = await instance(
      FOR_EACH,
      { accounts: '["Everyday","Savings"]' },
      'for-each.md',
    );
    const report = await runTest(inst, makeConfig(), '');

    expect(rows(report.steps)).toEqual([
      ['Open the accounts page', 'passed'],
      ['For each {{account}} in {{accounts}}, Check the account', 'passed'],
      ['Click the account row', 'passed'],
      ['Verify the balance is shown', 'passed'],
      ['Click the account row', 'passed'],
      ['Verify the balance is shown', 'passed'],
      ['Sign out', 'passed'],
    ]);
    // The list is the bound: no model call decided anything.
    expect(evaluateConditionsMock).not.toHaveBeenCalled();
    // The count is known from the start, so no `?` ever shows.
    expect(report.steps[2]!.loop).toEqual({
      kind: 'iteration',
      label: 'Check the account',
      index: 1,
      count: 2,
      values: { account: 'Everyday' },
    });
    expect(report.steps[4]!.loop!.values).toEqual({ account: 'Savings' });
  });

  it('fails the line when the variable is not a JSON array', async () => {
    const inst = await instance(
      FOR_EACH,
      { accounts: 'Savings, Everyday' },
      'for-each-bad.md',
    );
    const report = await runTest(inst, makeConfig(), '');

    expect(report.status).toBe('failed');
    const failed = report.steps.find((s) => s.status === 'failed')!;
    expect(failed.error).toContain('`{{accounts}}` holds `Savings, Everyday`, not a list');
    expect(failed.error).toContain('capture it with a read of every matching element');
  });

  it('skips the body over an empty list, and the guard still passes', async () => {
    const inst = await instance(FOR_EACH, { accounts: '[]' }, 'for-each-empty.md');
    const report = await runTest(inst, makeConfig(), '');

    expect(rows(report.steps)).toEqual([
      ['Open the accounts page', 'passed'],
      ['For each {{account}} in {{accounts}}, Check the account', 'passed'],
      ['Click the account row', 'skipped'],
      ['Verify the balance is shown', 'skipped'],
      ['Sign out', 'passed'],
    ]);
  });
});

// ─── Aborts ─────────────────────────────────────────────────────────────────

describe('stopping the run mid-decision', () => {
  it('ends the run and still writes a report, rather than rejecting out of runTest', async () => {
    // `evaluateGuard` rethrows an abort by design (issues/020). Until the
    // guard block caught one, it left `runTest` with no report and the browser
    // open — this is the CLI's only abort path, so it is the only place that
    // can be asserted.
    const controller = new AbortController();
    evaluateConditionsMock.mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('Run aborted by client', 'AbortError');
    });

    const report = await runTest(await instance(CHAIN, {}, 'chain-abort.md'), makeConfig(), '', undefined, {
      signal: controller.signal,
    });

    expect(report.aborted).toBe(true);
    const last = report.steps.at(-1)!;
    expect(last.instruction).toBe('If the Cash checkbox is ticked, then Pay with cash');
    expect(last.interrupted).toBe(true);
    expect(last.aiExplanation).toBe('Stopped by user (run aborted).');
    // Nothing after the guard ran.
    expect(executeStepMock.mock.calls.map((c) => c[2])).toEqual(['Open the payments page']);
  });

  it('does not count the interrupted row as a failure, as the server does not', async () => {
    // The row the catch pushes is `status: 'failed', interrupted: true` — a
    // step that was stopped, not one that went wrong. The server's summary
    // filters `s.status === 'failed' && !s.interrupted`; the CLI's did not, so
    // the same stop produced two different reports: `failed / failedSteps: 1`
    // here against `passed`-with-`aborted` / `failedSteps: 0` there (review 3,
    // finding 11).
    const controller = new AbortController();
    evaluateConditionsMock.mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('Run aborted by client', 'AbortError');
    });

    const report = await runTest(
      await instance(CHAIN, {}, 'chain-abort-count.md'),
      makeConfig(),
      '',
      undefined,
      { signal: controller.signal },
    );

    expect(report.failedSteps).toBe(0);
    expect(report.status).toBe('passed');
    expect(report.aborted).toBe(true);
    // The row itself is untouched — the report still says what was stopped.
    expect(report.steps.at(-1)).toMatchObject({ status: 'failed', interrupted: true });
  });
});

// ─── Hooks ──────────────────────────────────────────────────────────────────

describe('hooks and the step cache', () => {
  it('does not wrap a guard or a skipped step in beforeEach / afterEach', async () => {
    resolveHooksMock.mockResolvedValue({
      before: [], beforeEach: ['Dismiss any banner'], afterEach: ['Check for errors'], after: [],
      hasAny: true,
      toolCalls: { before: [], beforeEach: [null], afterEach: [null], after: [] },
      sourceSkills: { before: [], beforeEach: [null], afterEach: [null], after: [] },
    });
    judgeAnswers(0);
    const report = await runTest(await instance(CHAIN, {}, 'chain-hooks.md'), makeConfig(), '');

    // Four steps ran (Open, Click Pay now, Verify the receipt, Verify the
    // order confirmation), so four hook pairs and no more: nothing wrapped the
    // guard, the untaken guard, or the three skipped rows.
    const hookRuns = report.steps.filter((s) => s.hookScope !== undefined);
    expect(hookRuns.filter((s) => s.hookScope === 'beforeEach')).toHaveLength(4);
    expect(hookRuns.filter((s) => s.hookScope === 'afterEach')).toHaveLength(4);
  });

  it('turns the step cache off inside a loop body and leaves it on outside', async () => {
    judgeAnswers(0, null);
    const config = makeConfig();
    config.cache = { ...config.cache, enabled: true };
    await runTest(await instance(WHILE, {}, 'while-cache.md'), config, '');

    const byInstruction = new Map<string, boolean>();
    for (const call of executeStepMock.mock.calls) {
      byInstruction.set(call[2] as string, (call[3] as { cacheEnabled?: boolean }).cacheEnabled === true);
    }
    expect(byInstruction.get('Open the statements page')).toBe(true);
    // Inside the loop body: one plan per line cannot serve three passes
    // (stories/control-flow.md, decision 12).
    expect(byInstruction.get('Click Next')).toBe(false);
  });
});

// ─── What the console announces ─────────────────────────────────────────────

/**
 * The CLI's half of the pairing rule the event-emitting loops follow.
 *
 * The console has no persistent paint to get stuck — that was the server's
 * `step:start` and TestBench's `running` gutter — but it has the same shape of
 * claim: `logger.step` prints a `Step N/M:` header, and a guard that asks
 * nobody records no row and reports nothing afterwards. So the invariant here
 * is that the console announces exactly the guard visits the REPORT keeps.
 */
describe('the console announces the guard visits that are recorded', () => {
  const FOREACH = [
    '# For each',
    '',
    '## Steps',
    '1. Open the accounts page',
    '2. For each {{account}} in {{accounts}}, Check the account',
    '3. Sign out',
    '',
    '### Check the account',
    '1. Click the account row',
    '',
  ].join('\n');

  const REPEAT = [
    '# Repeat',
    '',
    '## Steps',
    '1. Open the alerts page',
    '2. Repeat Load more alerts until every alert is shown',
    '3. Verify the alert count',
    '',
    '### Load more alerts',
    '1. Click Load more',
    '',
  ].join('\n');

  /** `logger.step` headers whose instruction starts with `prefix`. */
  function headersFor(step: ReturnType<typeof vi.spyOn>, prefix: string): number {
    return (step.mock.calls as unknown[][]).filter((c) => String(c[2]).startsWith(prefix)).length;
  }

  it('prints one For each header for three items, matching its one row', async () => {
    const step = vi.spyOn(logger, 'step').mockImplementation(() => {});
    try {
      const report = await runTest(
        await instance(FOREACH, { accounts: '["Everyday","Savings","Travel"]' }, 'foreach-log.md'),
        makeConfig(),
        '',
      );
      // Three passes ran…
      expect(report.steps.filter((s) => s.instruction === 'Click the account row')).toHaveLength(3);
      // …off ONE recorded guard visit, and one header. The other three visits
      // advance the cursor and ask nobody; announcing them printed a step
      // number that never reported.
      expect(report.steps.filter((s) => s.instruction.startsWith('For each '))).toHaveLength(1);
      expect(headersFor(step, 'For each ')).toBe(1);
    } finally {
      step.mockRestore();
    }
  });

  it("prints no header for a Repeat's first pass, which asks nobody", async () => {
    const step = vi.spyOn(logger, 'step').mockImplementation(() => {});
    try {
      // `null` = the until-condition did not hold (carry on); `0` = it held.
      judgeAnswers(null, 0);
      const report = await runTest(
        await instance(REPEAT, {}, 'repeat-log.md'),
        makeConfig(),
        '',
      );
      expect(report.steps.filter((s) => s.instruction === 'Click Load more')).toHaveLength(2);
      expect(report.steps.filter((s) => s.instruction.startsWith('Repeat '))).toHaveLength(2);
      expect(headersFor(step, 'Repeat ')).toBe(2);
    } finally {
      step.mockRestore();
    }
  });

  it('still prints a While header on every visit, because every visit asks', async () => {
    // The control: the rule is "no header without a row", not "fewer headers".
    const step = vi.spyOn(logger, 'step').mockImplementation(() => {});
    try {
      judgeAnswers(0, 0, 0, null);
      const report = await runTest(await instance(WHILE, {}, 'while-log.md'), makeConfig(), '');
      expect(report.steps.filter((s) => s.instruction.startsWith('While '))).toHaveLength(4);
      expect(headersFor(step, 'While ')).toBe(4);
    } finally {
      step.mockRestore();
    }
  });

  it('numbers a watch group\u2019s console lines from 1, like every other line', async () => {
    // `executeBranchedStep` hands back the group's own **0-based** indices,
    // and the three console lines plus the history entry used to print them
    // raw — so "Step 2 passed" meant the third step, in the one block of the
    // run where that was true.
    const md = [
      '# Watch numbering',
      '',
      '## Steps',
      '1. Open the page',
      '2. If a cookie banner appears, click Reject all',
      '3. Click Continue',
      '4. Sign out',
      '',
    ].join('\n');
    executeBranchedStepMock.mockImplementation(async (group: {
      conditionalSteps: { index: number }[];
      continuationStep: { index: number };
    }) => [
      {
        index: group.conditionalSteps[0]!.index,
        instruction: 'If a cookie banner appears, click Reject all',
        status: 'skipped' as const,
        turns: [],
        durationMs: 1,
        retried: false,
      },
      {
        index: group.continuationStep.index,
        instruction: 'Click Continue',
        status: 'passed' as const,
        turns: [],
        durationMs: 1,
        retried: false,
      },
    ]);
    const success = vi.spyOn(logger, 'success').mockImplementation(() => {});
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    try {
      const report = await runTest(
        await instance(md, {}, 'watch-numbering.md'),
        makeConfig(),
        '',
      );

      const said = (spy: ReturnType<typeof vi.spyOn>) =>
        (spy.mock.calls as unknown[][]).map((c) => String(c[0]));
      // The continuation is step 3 of 4, not step 2.
      expect(said(success)).toContain('Step 3 passed');
      expect(said(success)).not.toContain('Step 2 passed');
      expect(said(info)).toContain('Step 2 skipped (conditional not matched)');
      expect(said(info)).not.toContain('Step 1 skipped (conditional not matched)');
      // …and the same number reaches the model, whose `## Prior Steps` would
      // otherwise disagree with the report about which step was which.
      expect(historyOfLastStep()).toContain(
        'Step 3: [\u2713 PASSED] Click Continue (now at: https://example.com)',
      );
      // \u2026and the REPORT's own `index`, which the HTML renders verbatim. The
      // group's rows kept `executeBranchedStep`'s 0-based indices, so this
      // four-step file rendered `Step 1, Step 1, Step 2, Step 4` \u2014 a number
      // repeated, a number missing, and the report disagreeing with the
      // console lines above about which step is which (review 3, finding 6).
      expect(report.steps.map((s) => [s.index, s.instruction])).toEqual([
        [1, 'Open the page'],
        [2, 'If a cookie banner appears, click Reject all'],
        [3, 'Click Continue'],
        [4, 'Sign out'],
      ]);
    } finally {
      success.mockRestore();
      info.mockRestore();
    }
  });
});

/**
 * A condition decided by code-behind, through the real CLI runner
 * (stories/codebehind-loops-and-conditions.md, "The run loops").
 *
 * The same harness as `test-runner-control-flow.test.ts` — the test file is
 * parsed for real, and only the browser, the model and the report writer are
 * mocked — with one difference that is the point: the step executor is the
 * REAL module except for `executeStep` and the judge, so the runner's own
 * registry, built from a real `.steps.ts` beside the test, reaches the guard
 * and `runConditionCode` runs its entry against the mock page.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const pageState = vi.hoisted(() => ({ nextEnabled: [] as boolean[], calls: 0 }));
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
      if (this.session === undefined) throw new Error('no browser has been launched in this session');
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

const executeStepMock = vi.fn();
const evaluateConditionsMock = vi.fn();
vi.mock('../src/runner/step-executor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runner/step-executor.js')>()),
  executeStep: (...args: unknown[]) => executeStepMock(...args),
  executeBranchedStep: vi.fn(async () => []),
  evaluateConditions: (...args: unknown[]) => evaluateConditionsMock(...args),
  settleBeforeConditions: vi.fn(async () => {}),
}));

vi.mock('../src/runner/interactive-repl.js', () => ({ runInteractiveRepl: vi.fn() }));
vi.mock('../src/runner/hooks.js', () => ({
  resolveHooks: vi.fn(async () => ({
    before: [], beforeEach: [], afterEach: [], after: [], hasAny: false,
    toolCalls: { before: [], beforeEach: [], afterEach: [], after: [] },
    sourceSkills: { before: [], beforeEach: [], afterEach: [], after: [] },
  })),
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
import { readLastRun } from '../src/codebehind/last-run.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpDir: string | undefined;

async function project(name: string, markdown: string, entries: string): Promise<string> {
  tmpDir ??= await fs.mkdtemp(path.join(os.tmpdir(), 'condition-codebehind-cli-'));
  const file = path.join(tmpDir, `${name}.md`);
  await fs.writeFile(file, markdown, 'utf-8');
  await fs.writeFile(path.join(tmpDir, `${name}.steps.ts`), `export default [\n${entries}\n];\n`, 'utf-8');
  return file;
}

/** A keyed run: a broken condition entry heals under the (mocked) model. */
function makeConfig(): Config {
  return {
    ...DEFAULT_CONFIG,
    ai: { ...DEFAULT_CONFIG.ai, apiKey: 'sk-test' },
    browser: { ...DEFAULT_CONFIG.browser, headed: false },
  };
}

const WHILE_LINE = 'While the Next button is enabled, Go to the next page';
const WHILE_MD = [
  '# While',
  '',
  '## Steps',
  '1. Open the statements page',
  `2. ${WHILE_LINE}`,
  '3. Verify the last page is shown',
  '',
  '### Go to the next page',
  '1. Click Next',
  '',
].join('\n');

beforeEach(() => {
  executeStepMock.mockReset();
  evaluateConditionsMock.mockReset();
  launchBrowserMock.mockReset();
  closeBrowserMock.mockReset();
  pageState.nextEnabled = [];
  pageState.calls = 0;

  launchBrowserMock.mockResolvedValue({
    page: {
      url: () => 'https://example.com/statements',
      goto: vi.fn().mockResolvedValue(undefined),
      nextEnabled: () => {
        pageState.calls++;
        return pageState.nextEnabled.length > 0 ? pageState.nextEnabled.shift()! : false;
      },
    },
    context: {},
    browser: {},
  });
  closeBrowserMock.mockResolvedValue(undefined);
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('the CLI runner and a condition entry', () => {
  it('decides a While by its entry: no judge call, and the guard rows say so', async () => {
    const file = await project(
      'while',
      WHILE_MD,
      `  {
    source: ${JSON.stringify(WHILE_LINE)},
    async condition({ page }) { return page.nextEnabled(); },
  },`,
    );
    pageState.nextEnabled = [true, true, false];

    const report = await runTest({ test: await parseTestFile(file, {}), resolvedParameters: {} }, makeConfig(), '');

    expect(report.status).toBe('passed');
    expect(evaluateConditionsMock).not.toHaveBeenCalled();
    expect(pageState.calls).toBe(3);
    const guards = report.steps.filter((s: StepResult) => s.instruction === WHILE_LINE);
    expect(guards.map((g) => g.guard)).toEqual([
      { decidedBy: 'code', holds: true },
      { decidedBy: 'code', holds: true },
      { decidedBy: 'code', holds: false },
    ]);
    expect(guards.every((g) => g.fromCodeBehind === true)).toBe(true);
    expect(guards[0]!.aiExplanation).toBe('Decided by code-behind: "the Next button is enabled" → true');
    expect(guards[0]!.codeBehind?.file).toBe(file.replace(/\.md$/, '.steps.ts'));
    // Two passes of the body, as the code said.
    expect(executeStepMock.mock.calls.map((c) => c[2])).toEqual([
      'Open the statements page',
      'Click Next',
      'Click Next',
      'Verify the last page is shown',
    ]);

    const sidecar = await readLastRun(file);
    const rows = sidecar?.steps.filter((s) => s.source === WHILE_LINE) ?? [];
    expect(rows).toHaveLength(3);
    expect(rows.every((s) => s.fromCodeBehind && !s.stale)).toBe(true);
  });

  it('writes the stale row for the MEMBER whose code threw, not the member that held', async () => {
    const IF_LINE = 'If the Cash checkbox is ticked, then Pay with cash';
    const ELSE_IF_LINE = 'Else if the Card checkbox is ticked, then Pay by card';
    const md = [
      '# Chain',
      '',
      '## Steps',
      '1. Open the payments page',
      `2. ${IF_LINE}`,
      `3. ${ELSE_IF_LINE}`,
      '4. Verify the order confirmation is shown',
      '',
      '### Pay with cash',
      '1. Click Pay now',
      '',
      '### Pay by card',
      '1. Enter the card details',
      '',
    ].join('\n');
    const file = await project(
      'chain',
      md,
      `  {
    source: ${JSON.stringify(IF_LINE)},
    async condition() { throw new Error('Cash checkbox went away'); },
  },
  {
    source: ${JSON.stringify(ELSE_IF_LINE)},
    async condition() { return true; },
  },`,
    );
    evaluateConditionsMock.mockResolvedValueOnce({
      selected: 1,
      reasoning: 'the Card checkbox is ticked',
      aiInteractions: [],
    });

    const report = await runTest({ test: await parseTestFile(file, {}), resolvedParameters: {} }, makeConfig(), '');

    expect(report.status).toBe('passed');
    expect(evaluateConditionsMock).toHaveBeenCalledTimes(1);
    expect(evaluateConditionsMock.mock.calls[0]![0]).toEqual([
      'the Cash checkbox is ticked',
      'the Card checkbox is ticked',
    ]);
    const held = report.steps.find((s: StepResult) => s.instruction === ELSE_IF_LINE && s.status === 'passed')!;
    expect(held.codeBehindStale).toMatchObject({ source: IF_LINE, error: 'Cash checkbox went away' });
    expect(held.guard?.staleMember).toBe(1);

    const sidecar = await readLastRun(file);
    const bySource = (source: string) => sidecar!.steps.filter((s) => s.source === source);
    expect(bySource(IF_LINE).filter((s) => s.stale)).toEqual([
      expect.objectContaining({ stale: true, error: 'Cash checkbox went away', index: 2 }),
    ]);
    expect(bySource(ELSE_IF_LINE).every((s) => !s.stale)).toBe(true);
  });

  /** A chain with no `Otherwise`: `If … then Pay with cash`, then a step. */
  const IF_ONLY_LINE = 'If the Cash checkbox is ticked, then Pay with cash';
  const IF_ONLY_MD = [
    '# Chain',
    '',
    '## Steps',
    '1. Open the payments page',
    `2. ${IF_ONLY_LINE}`,
    '3. Verify the order confirmation is shown',
    '',
    '### Pay with cash',
    '1. Click Pay now',
    '',
  ].join('\n');

  it('writes the stale row for a skipped head whose own code threw — the row the server writes', async () => {
    const file = await project(
      'if-only',
      IF_ONLY_MD,
      `  {
    source: ${JSON.stringify(IF_ONLY_LINE)},
    async condition() { throw new Error('Cash checkbox went away'); },
  },`,
    );
    evaluateConditionsMock.mockResolvedValueOnce({ selected: null, reasoning: 'none', aiInteractions: [] });

    const report = await runTest({ test: await parseTestFile(file, {}), resolvedParameters: {} }, makeConfig(), '');

    expect(report.status).toBe('passed');
    const head = report.steps.find((s: StepResult) => s.instruction === IF_ONLY_LINE)!;
    expect(head).toMatchObject({ status: 'skipped', guard: { decidedBy: 'model', selected: null, staleMember: 1 } });
    // The exact row api-server-condition-codebehind.test.ts pins for the
    // server's writer on the same chain: both writers or neither.
    const sidecar = await readLastRun(file);
    expect(sidecar?.steps.find((s) => s.source === IF_ONLY_LINE)).toEqual({
      index: 2,
      source: IF_ONLY_LINE,
      file: file.replace(/\.md$/, '.steps.ts'),
      occurrence: 0,
      status: 'skipped',
      fromCodeBehind: false,
      stale: true,
      error: 'Cash checkbox went away',
      staleRuns: 1,
    });
  });

  it('carries deliberate on a guard row a condition entry failed with step.fail()', async () => {
    const file = await project(
      'if-deliberate',
      IF_ONLY_MD,
      `  {
    source: ${JSON.stringify(IF_ONLY_LINE)},
    async condition({ step }) { step.fail('No payment method on this account'); return true; },
  },`,
    );

    const report = await runTest({ test: await parseTestFile(file, {}), resolvedParameters: {} }, makeConfig(), '');

    expect(report.status).toBe('failed');
    expect(evaluateConditionsMock).not.toHaveBeenCalled();
    const head = report.steps.find((s: StepResult) => s.instruction === IF_ONLY_LINE)!;
    // Measured before the fix: `deliberate` was dropped between the condition
    // outcome and the row, as on the server's `step:fail`.
    expect(head).toMatchObject({
      status: 'failed',
      error: 'No payment method on this account',
      deliberate: true,
      fromCodeBehind: true,
    });
  });

  it('asks the judge, with no code, when the run bypasses code-behind', async () => {
    const file = await project(
      'bypass',
      WHILE_MD,
      `  {
    source: ${JSON.stringify(WHILE_LINE)},
    async condition({ page }) { return page.nextEnabled(); },
  },`,
    );
    evaluateConditionsMock.mockResolvedValue({ selected: null, reasoning: 'no', aiInteractions: [] });
    const report = await runTest(
      { test: await parseTestFile(file, {}), resolvedParameters: {} },
      makeConfig(),
      '',
      // A compile's Record: code-behind off, but capturing.
      { codeBehindDisabled: true, captureStepContext: true } as never,
    );
    expect(pageState.calls).toBe(0);
    expect(evaluateConditionsMock).toHaveBeenCalledTimes(1);
    const guard = report.steps.find((s: StepResult) => s.instruction === WHILE_LINE)!;
    expect(guard.guard?.decidedBy).toBe('model');
    expect(guard.fromCodeBehind).toBeUndefined();
  });
});

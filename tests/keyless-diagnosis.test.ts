/**
 * The runner half of keyless mode
 * (stories/keyless-replay-and-gateway-env.md §Part B): where the "this run has
 * no AI" answer comes FROM, and what a failed keyless run puts in the
 * report's diagnosis slot.
 *
 * Two things are proven here that a unit test of either piece could not:
 *
 *  1. the post-failure diagnosis pass is skipped BEFORE calling AI, and says
 *     so in the slot the analysis would have filled — so the report states an
 *     intention rather than surfacing a caught auth error;
 *  2. the flag reaches the executor, which is the wiring the heal skip in
 *     `keyless-replay.test.ts` depends on and cannot see for itself.
 *
 * Driven through the real `runTest` with the browser, executor and AI mocked
 * out — the harness shape `codebehind-healed-run.test.ts` uses.
 *
 * Minimum scenario: every config here is built from `DEFAULT_CONFIG` in
 * memory. `runTest` never calls `loadConfig`, so neither a machine-wide
 * `%LOCALAPPDATA%\aiui\.env` nor a real `AI_API_KEY` in the process env can
 * reach it and quietly un-keyless the run — asserted below rather than
 * assumed, because that leak is exactly what would condition the bug out of
 * the test path.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config/types.js';
import type { ParsedTest, TestInstance } from '../src/parser/types.js';
import type { StepResult } from '../src/report/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { aiConfigured } from '../src/config/loader.js';

/** The story's copy, restated rather than imported — a silent edit to the
 *  constant must fail here, not agree with itself. */
const SKIP_NOTE = 'Diagnosis skipped: AI is not configured.';

// ─── Runner harness ─────────────────────────────────────────────────────────

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

/** Records the options each step was executed with — that is where `keyless`
 *  has to arrive for the heal skip to ever fire. */
const executeStepMock = vi.fn();
const stepOptions: Array<Record<string, unknown>> = [];
vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: (...args: unknown[]) => {
    stepOptions.push(args[3] as Record<string, unknown>);
    return executeStepMock(...args);
  },
  executeBranchedStep: vi.fn(),
}));

vi.mock('../src/runner/hooks.js', () => ({
  resolveHooks: vi.fn(async () => ({
    before: [], beforeEach: [], afterEach: [], after: [], hasAny: false,
  })),
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

const diagnoseFailureMock = vi.fn();
vi.mock('../src/ai/diagnose.js', () => ({
  diagnoseFailure: (...args: unknown[]) => diagnoseFailureMock(...args),
}));
vi.mock('../src/ai/client.js', () => ({ AiClient: class { syncAuth = vi.fn(() => null); } }));
vi.mock('../src/utils/run-log.js', () => ({
  openRunLogFile: () => null,
  attachRunLogBridges: () => () => {},
}));

vi.mock('../src/utils/tokens.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/tokens.js')>()),
  TokenTracker: class {
    addUsage(): void {}
    resetStep(): void {}
    markRunStart(): void {}
    checkStepBudget(): void {}
    get total(): number { return 0; }
    get inputTotal(): number { return 0; }
    get outputTotal(): number { return 0; }
    get runTotal(): number { return 0; }
    get runInputTotal(): number { return 0; }
    get runOutputTotal(): number { return 0; }
    getSummary(): string { return 'Total: 0'; }
  },
}));

// The real generator is kept: the point of putting the note in the diagnosis
// slot is that the existing rendering shows it with no change, and only a real
// `renderReport` can say whether that is true.
vi.mock('../src/report/generator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/report/generator.js')>()),
  generateReport: vi.fn(async () => ''),
  getPrimaryModel: () => undefined,
  buildReportBaseName: (report: { testName: string }) => report.testName,
}));

vi.mock('../src/report/history-appender.js', () => ({
  appendRunHistory: vi.fn(async () => undefined),
}));

import { runTest } from '../src/runner/test-runner.js';
import { renderReport } from '../src/report/generator.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(repoRoot, 'tests', '.tmp-keyless-diagnosis');

function makeInstance(steps: string[], filePath: string): TestInstance {
  const test: ParsedTest = {
    filePath,
    title: 'transfers',
    frontmatter: { tags: [] },
    config: {},
    parameters: {},
    steps,
    stepLines: steps.map((_, i) => i + 1),
    skipHooks: steps.map(() => false),
    toolCalls: steps.map(() => null),
    sourceSkills: steps.map(() => null),
    sourceSections: steps.map(() => null),
    sections: {},
    rawSteps: [...steps],
    hooks: { before: [], beforeEach: [], afterEach: [], after: [] },
    hookToolCalls: { before: [], beforeEach: [], afterEach: [], after: [] },
    hookSourceSkills: { before: [], beforeEach: [], afterEach: [], after: [] },
  };
  return { test, resolvedParameters: {} };
}

/** `apiKey: undefined` is the whole point — `DEFAULT_CONFIG` carries none, and
 *  nothing in `runTest` reads the environment to fill it. */
function keylessConfig(): Config {
  return {
    ...DEFAULT_CONFIG,
    ai: { ...DEFAULT_CONFIG.ai, diagnoseFailures: true },
    browser: { ...DEFAULT_CONFIG.browser, headed: false },
  };
}

function keyedConfig(): Config {
  const config = keylessConfig();
  return { ...config, ai: { ...config.ai, apiKey: 'sk-present' } };
}

function passed(index: number, instruction: string): StepResult {
  return { index, instruction, status: 'passed', turns: [], durationMs: 1, retried: false };
}

function failed(index: number, instruction: string, error: string): StepResult {
  return { index, instruction, status: 'failed', turns: [], durationMs: 1, retried: false, error };
}

let dir: string;
let counter = 0;

beforeEach(async () => {
  executeStepMock.mockReset();
  diagnoseFailureMock.mockReset();
  launchBrowserMock.mockReset();
  closeBrowserMock.mockReset();
  stepOptions.length = 0;
  launchBrowserMock.mockResolvedValue({
    page: { url: () => 'https://bank.test/', goto: vi.fn(async () => undefined) },
  });
  closeBrowserMock.mockResolvedValue(undefined);
  dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpBase, { recursive: true, force: true });
});

// ─── The diagnosis gate ─────────────────────────────────────────────────────

describe('the post-failure diagnosis pass on a keyless run', () => {
  it('is skipped, and the report says so where the analysis would have been', async () => {
    // The trap this guards: a real key in the process env or the machine-wide
    // .env would make this run keyed and the test would pass by never
    // exercising the branch.
    const config = keylessConfig();
    expect(aiConfigured(config.ai)).toBe(false);

    executeStepMock.mockImplementationOnce(async () => passed(1, 'Sign in'));
    executeStepMock.mockImplementationOnce(async () =>
      failed(2, 'Click the "Transfers" tab', 'replay failed and was not healed'),
    );

    const report = await runTest(
      makeInstance(['Sign in', 'Click the "Transfers" tab'], path.join(dir, 'transfers.md')),
      config,
      '',
    );

    expect(report.status).toBe('failed');
    // Proactive: no request was built, so there is no auth error to report.
    expect(diagnoseFailureMock).not.toHaveBeenCalled();
    expect(report.diagnosis?.rootCause).toBe(SKIP_NOTE);
    // `diagnoseFailures` is still on — keyless is a runtime condition, not a
    // setting the user had to know to turn off.
    expect(config.ai.diagnoseFailures).toBe(true);

    // And the existing report rendering shows it, unchanged.
    expect(renderReport(report)).toContain(SKIP_NOTE);
    // Nothing in the report reads as a broken API key.
    expect(JSON.stringify(report)).not.toMatch(/invalid_api_key/i);
  });

  it('claims nothing it did not determine', async () => {
    // The slot is a placeholder, not an analysis: no invented root cause, no
    // evidence, no confident category.
    executeStepMock.mockImplementationOnce(async () => failed(1, 'Sign in', 'boom'));

    const report = await runTest(
      makeInstance(['Sign in'], path.join(dir, 'transfers.md')),
      keylessConfig(),
      '',
    );

    expect(report.diagnosis).toEqual({
      rootCause: SKIP_NOTE,
      faultCategory: 'unknown',
      evidence: [],
      suggestedFix: '',
      confidence: 'low',
    });
  });

  it('leaves a passing keyless run with no diagnosis slot at all', async () => {
    executeStepMock.mockImplementation(async (index: number) => passed(index, 'Sign in'));

    const report = await runTest(
      makeInstance(['Sign in', 'Read the balance'], path.join(dir, 'green.md')),
      keylessConfig(),
      '',
    );

    expect(report.status).toBe('passed');
    expect(report.diagnosis).toBeUndefined();
    expect(diagnoseFailureMock).not.toHaveBeenCalled();
  });

  it('still diagnoses a failed run on a machine that HAS a key', async () => {
    // The control. Without it a gate that skipped unconditionally would pass
    // every case above while silently ending diagnosis for everyone.
    const config = keyedConfig();
    expect(aiConfigured(config.ai)).toBe(true);

    diagnoseFailureMock.mockResolvedValue({
      rootCause: 'The Transfers tab was renamed',
      faultCategory: 'application',
      evidence: ['no element matched #transfers-tab'],
      suggestedFix: 'Update the selector',
      confidence: 'high',
    });
    executeStepMock.mockImplementationOnce(async () => failed(1, 'Sign in', 'boom'));

    const report = await runTest(
      makeInstance(['Sign in'], path.join(dir, 'keyed.md')),
      config,
      '',
    );

    expect(diagnoseFailureMock).toHaveBeenCalledTimes(1);
    expect(report.diagnosis?.rootCause).toBe('The Transfers tab was renamed');
    expect(report.diagnosis?.rootCause).not.toBe(SKIP_NOTE);
  });
});

// ─── The flag the executor acts on ──────────────────────────────────────────

describe('the keyless flag the runner hands each step', () => {
  it('is set on every step when the run has no key', async () => {
    executeStepMock.mockImplementation(async (index: number) => passed(index, 'step'));

    await runTest(
      makeInstance(['Sign in', 'Read the balance'], path.join(dir, 'flagged.md')),
      keylessConfig(),
      '',
    );

    expect(stepOptions).toHaveLength(2);
    expect(stepOptions.every((o) => o['keyless'] === true)).toBe(true);
  });

  it('is absent on a keyed run — the options are what they always were', async () => {
    executeStepMock.mockImplementation(async (index: number) => passed(index, 'step'));

    await runTest(
      makeInstance(['Sign in'], path.join(dir, 'unflagged.md')),
      keyedConfig(),
      '',
    );

    expect(stepOptions).toHaveLength(1);
    // Absent, not `false`: `exactOptionalPropertyTypes` refuses an explicit
    // undefined, and "no key set" is how every caller that predates this
    // feature behaves.
    expect('keyless' in stepOptions[0]!).toBe(false);
  });

  it('does not turn a whitespace-only key into a usable one', async () => {
    // `AI_API_KEY=` with a stray space is the same "no key" the author meant;
    // letting it through would only move the failure to the gateway.
    const config = keylessConfig();
    config.ai = { ...config.ai, apiKey: '   ' };
    executeStepMock.mockImplementation(async (index: number) => passed(index, 'step'));

    await runTest(
      makeInstance(['Sign in'], path.join(dir, 'blank-key.md')),
      config,
      '',
    );

    expect(stepOptions[0]!['keyless']).toBe(true);
  });
});

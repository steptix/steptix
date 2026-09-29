/**
 * A healed run stops reporting as a clean pass
 * (stories/codebehind-selector-ambiguity.md).
 *
 * A code-behind entry throws, the step re-runs under AI and passes, and the
 * run has always gone green with nothing at the run level to say so. Four
 * things now say so, and they are what this file covers:
 *
 *  1. `TestReport.healedSteps` — set by the runner, `status` still 'passed';
 *  2. the report's amber "PASSED — 4 steps healed, 18.2k tokens" banner, in
 *     the shape `aborted` already established;
 *  3. `steptix run --fail-on-healed` — a non-zero exit, and only under the flag;
 *  4. the sidecar's consecutive-stale count, which is what lets the ⚠ read
 *     "healed under AI (3 runs in a row)" with no threshold to tune.
 *
 * The runner half runs through the real `runTest` with the browser, executor
 * and AI mocked out — the same harness shape
 * `test-runner-clarification-control.test.ts` uses — because the point is
 * where the loop attributes tokens and what it puts on the report, neither of
 * which a unit test of the counting helper would reach.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import type { Config } from '../src/config/types.js';
import type { ParsedTest, TestInstance } from '../src/parser/types.js';
import type { StepResult, TestReport, RunSummary } from '../src/report/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import {
  renderReport,
  healedBannerText,
  formatTokenCount,
} from '../src/report/generator.js';
import { registerRunCommand, countHealedSteps, exitCodeFor } from '../src/cli/commands/run.js';
import {
  writeLastRun,
  readLastRun,
  clearStale,
  lastRunPathFor,
  type LastRunStep,
} from '../src/codebehind/last-run.js';

// ─── Runner harness ─────────────────────────────────────────────────────────
//
// Mocks declared before the `runTest` import (they hoist anyway; the order
// keeps it readable).

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

const executeStepMock = vi.fn();
vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: (...args: unknown[]) => executeStepMock(...args),
  executeBranchedStep: vi.fn(),
}));

vi.mock('../src/runner/hooks.js', () => ({
  resolveHooks: vi.fn(async () => ({
    before: [], beforeEach: [], afterEach: [], after: [], hasAny: false,
  })),
}));

vi.mock('../src/ai/diagnose.js', () => ({ diagnoseFailure: vi.fn(async () => null) }));
vi.mock('../src/ai/client.js', () => ({ AiClient: class { setAiPolicy = vi.fn(); syncAuth = vi.fn(() => null); } }));
vi.mock('../src/utils/run-log.js', () => ({
  openRunLogFile: () => null,
  attachRunLogBridges: () => () => {},
}));

/**
 * The runner reads its token totals off a `TokenTracker` it builds itself and
 * hands to the (mocked) AI client, so a test has no way to spend tokens
 * through the real one. This stub exposes the running total as a module-level
 * variable the fake `executeStep` can bump — which is exactly the shape the
 * runner attributes from: a run-wide total sampled either side of a step.
 */
let spentTokens = 0;
vi.mock('../src/utils/tokens.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/tokens.js')>()),
  TokenTracker: class {
    addUsage(): void {}
    resetStep(): void {}
    markRunStart(): void {}
    checkStepBudget(): void {}
    get total(): number { return spentTokens; }
    get inputTotal(): number { return spentTokens; }
    get outputTotal(): number { return 0; }
    get runTotal(): number { return spentTokens; }
    get runInputTotal(): number { return spentTokens; }
    get runOutputTotal(): number { return 0; }
    getSummary(): string { return `Total: ${spentTokens}`; }
  },
}));

// Keep the real generator (the runner counts healed steps through
// `countStepOrigins`); only the disk write and the video base name are stubbed.
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

// ─── Fixtures ───────────────────────────────────────────────────────────────

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(repoRoot, 'tests', '.tmp-healed-run');

function makeTest(steps: string[], filePath: string): ParsedTest {
  return {
    filePath,
    title: 'healed test',
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
}

function makeInstance(steps: string[], filePath: string): TestInstance {
  return { test: makeTest(steps, filePath), resolvedParameters: {} };
}

function makeConfig(): Config {
  return {
    ...DEFAULT_CONFIG,
    browser: { ...DEFAULT_CONFIG.browser, headed: false },
  };
}

function passed(index: number, instruction: string): StepResult {
  return { index, instruction, status: 'passed', turns: [], durationMs: 1, retried: false };
}

function healedStep(index: number, instruction: string): StepResult {
  return {
    ...passed(index, instruction),
    codeBehindStale: {
      file: '/p/tests/checkout.steps.ts',
      source: instruction,
      error: 'locator("a[href=\\"/login\\"]") resolved to 2 elements',
    },
  };
}

/** A minimal report shell — the fields the banner reads, nothing else. */
function reportOf(overrides: Partial<TestReport> = {}): TestReport {
  return {
    testName: 'checkout',
    filePath: '/p/tests/checkout.md',
    tags: [],
    status: 'passed',
    steps: [],
    totalSteps: 0,
    passedSteps: 0,
    failedSteps: 0,
    totalSubActions: 0,
    durationMs: 1000,
    tokensUsed: 0,
    inputTokens: 0,
    outputTokens: 0,
    date: new Date('2026-08-27T02:00:00Z').toISOString(),
    ...overrides,
  };
}

/** The run's own status badge, out of the report header's Status cell. */
function runStatusBadge(html: string): { cls: string; text: string } | null {
  const m = html.match(
    /Status<\/span>\s*<span class="meta-value">\s*<span class="badge ([a-z-]+)">([^<]*)<\/span>/,
  );
  return m ? { cls: m[1]!, text: m[2]! } : null;
}

function summaryOf(reports: TestReport[], failedTests = 0): RunSummary {
  return {
    totalTests: reports.length,
    passedTests: reports.length - failedTests,
    failedTests,
    totalDurationMs: 1,
    totalTokensUsed: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    reports,
  };
}

let dir: string;
let counter = 0;

beforeEach(async () => {
  executeStepMock.mockReset();
  launchBrowserMock.mockReset();
  closeBrowserMock.mockReset();
  generatedReports.length = 0;
  spentTokens = 0;
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

// ─── 1. The runner ──────────────────────────────────────────────────────────

describe('a run that healed a broken entry', () => {
  it('sets healedSteps with the tokens those steps cost, and stays status "passed"', async () => {
    // Step 1 replays as code: no AI, no tokens. Step 2's entry throws and the
    // step heals under AI, spending 4,100 tokens. Step 3 is a plain AI step,
    // 900 tokens — which must NOT be billed to the healing.
    executeStepMock.mockImplementationOnce(async () => passed(1, 'step one'));
    executeStepMock.mockImplementationOnce(async () => {
      spentTokens += 4100;
      return healedStep(2, 'step two');
    });
    executeStepMock.mockImplementationOnce(async () => {
      spentTokens += 900;
      return passed(3, 'step three');
    });

    const report = await runTest(
      makeInstance(['step one', 'step two', 'step three'], path.join(dir, 'checkout.md')),
      makeConfig(),
    );

    expect(report.status).toBe('passed');
    expect(report.failedSteps).toBe(0);
    expect(report.healedSteps).toBe(1);
    expect(report.healedTokens).toBe(4100);
    // The step keeps its own 'passed' status too — `leadingPassed` in
    // codebehind/compile.ts breaks on anything else and would truncate the
    // usable prefix of a recording.
    expect(report.steps[1]!.status).toBe('passed');
    expect(report.steps[1]!.codeBehindStale).toBeDefined();
  });

  it('omits healedSteps entirely when nothing healed', async () => {
    executeStepMock.mockImplementation(async (index: number) => passed(index, 'step'));

    const report = await runTest(
      makeInstance(['step one', 'step two'], path.join(dir, 'clean.md')),
      makeConfig(),
    );

    expect(report.status).toBe('passed');
    expect(report.healedSteps).toBeUndefined();
    expect(report.healedTokens).toBeUndefined();
    expect(countHealedSteps(summaryOf([report]))).toBe(0);
  });

  it('counts every healed step, and bills each one only its own turn', async () => {
    executeStepMock.mockImplementationOnce(async () => {
      spentTokens += 5000;
      return healedStep(1, 'step one');
    });
    executeStepMock.mockImplementationOnce(async () => {
      spentTokens += 13_234;
      return healedStep(2, 'step two');
    });

    const report = await runTest(
      makeInstance(['step one', 'step two'], path.join(dir, 'both.md')),
      makeConfig(),
    );

    expect(report.healedSteps).toBe(2);
    expect(report.healedTokens).toBe(18_234);
  });
});

// ─── 2. The report banner ───────────────────────────────────────────────────

describe('the healed banner', () => {
  it('renders the count and the tokens in the amber shape `aborted` established', () => {
    const html = renderReport(
      reportOf({
        healedSteps: 4,
        healedTokens: 18_234,
        steps: [healedStep(1, 'click the login link')],
      }),
    );

    // The RUN's badge, read out of the header's Status cell — the step rows
    // carry their own (green) badges, and those are correct: the steps did
    // pass. It is the run-level signal that changes.
    expect(runStatusBadge(html)).toEqual({
      cls: 'badge-aborted',
      text: '⚠ PASSED — 4 steps healed, 18.2k tokens',
    });
  });

  it('names the count alone when no tokens were attributed', () => {
    // Absent means "not attributed", never zero — the banner must not invent
    // a number.
    const badge = runStatusBadge(renderReport(reportOf({ healedSteps: 1 })));
    expect(badge).toEqual({ cls: 'badge-aborted', text: '⚠ PASSED — 1 step healed' });
  });

  it('falls back to counting the steps when the producer set no healedSteps', () => {
    // A report assembled by a path that predates the field still shows the
    // banner; only the token figure is missing.
    const badge = runStatusBadge(
      renderReport(reportOf({ steps: [passed(1, 'a'), healedStep(2, 'b')] })),
    );
    expect(badge).toEqual({ cls: 'badge-aborted', text: '⚠ PASSED — 1 step healed' });
  });

  it('leaves a clean pass alone', () => {
    const html = renderReport(reportOf({ steps: [passed(1, 'a')] }));
    expect(runStatusBadge(html)).toEqual({ cls: 'badge-pass', text: '✓ PASSED' });
    expect(html).not.toContain('healed');
  });

  it('does not dress a failed run as a healed pass', () => {
    const html = renderReport(
      reportOf({ status: 'failed', healedSteps: 2, healedTokens: 4100, failedSteps: 1 }),
    );
    expect(runStatusBadge(html)).toEqual({ cls: 'badge-fail', text: '✗ FAILED' });
    expect(html).not.toContain('steps healed');
  });

  it('lets ABORTED win — a stopped run is not a healed pass', () => {
    const html = renderReport(reportOf({ aborted: true, healedSteps: 2, healedTokens: 4100 }));
    expect(runStatusBadge(html)).toEqual({ cls: 'badge-aborted', text: '■ ABORTED' });
    expect(html).not.toContain('steps healed');
  });

  it('formats the token figure for reading, not for accounting', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(912)).toBe('912');
    expect(formatTokenCount(4100)).toBe('4.1k');
    expect(formatTokenCount(18_234)).toBe('18.2k');
    expect(formatTokenCount(1000)).toBe('1k');
    expect(formatTokenCount(250_000)).toBe('250k');
  });

  it('says "1 step" and "2 steps"', () => {
    expect(healedBannerText(1)).toBe('PASSED — 1 step healed');
    expect(healedBannerText(2, 4100)).toBe('PASSED — 2 steps healed, 4.1k tokens');
  });
});

// ─── 3. --fail-on-healed ────────────────────────────────────────────────────

describe('steptix run --fail-on-healed', () => {
  it('is a declared boolean flag, off by default', () => {
    const program = new Command();
    registerRunCommand(program);
    const run = program.commands.find((c) => c.name() === 'run')!;
    const opt = run.options.find((o) => o.long === '--fail-on-healed');
    expect(opt).toBeDefined();
    expect(opt!.defaultValue).toBe(false);
    // Commander's camel-case mapping is what `RunOptions.failOnHealed` relies on.
    expect(opt!.attributeName()).toBe('failOnHealed');
  });

  it('turns a healed run into a non-zero exit — and only under the flag', () => {
    const healedRun = summaryOf([reportOf({ healedSteps: 2, healedTokens: 4100 })]);
    expect(exitCodeFor(healedRun, false)).toBe(0);
    expect(exitCodeFor(healedRun, true)).toBe(1);
  });

  it('leaves a clean run at 0 with the flag set', () => {
    const clean = summaryOf([reportOf({ steps: [passed(1, 'a')] })]);
    expect(exitCodeFor(clean, true)).toBe(0);
    expect(exitCodeFor(clean, false)).toBe(0);
  });

  it('still exits 1 for a real failure, flag or no flag', () => {
    const failed = summaryOf([reportOf({ status: 'failed', failedSteps: 1 })], 1);
    expect(exitCodeFor(failed, false)).toBe(1);
    expect(exitCodeFor(failed, true)).toBe(1);
  });

  it('gates on the steps when a report carries no healedSteps field', () => {
    const legacy = summaryOf([reportOf({ steps: [healedStep(1, 'a')] })]);
    expect(countHealedSteps(legacy)).toBe(1);
    expect(exitCodeFor(legacy, true)).toBe(1);
  });
});

// ─── 4. The sidecar's consecutive-stale count ───────────────────────────────

describe('the last-run sidecar consecutive-stale count', () => {
  function row(overrides: Partial<LastRunStep> = {}): LastRunStep {
    return {
      index: 1,
      source: 'click the login link',
      file: '/p/tests/checkout.steps.ts',
      status: 'passed',
      fromCodeBehind: false,
      stale: true,
      error: 'resolved to 2 elements',
      ...overrides,
    };
  }

  it('counts up while the step keeps healing, then resets when it passes as code', async () => {
    const md = path.join(dir, 'streak.md');

    await writeLastRun(md, [row()]);
    expect((await readLastRun(md))!.steps[0]!.staleRuns).toBe(1);

    await writeLastRun(md, [row()]);
    expect((await readLastRun(md))!.steps[0]!.staleRuns).toBe(2);

    await writeLastRun(md, [row()]);
    expect((await readLastRun(md))!.steps[0]!.staleRuns).toBe(3);

    // The entry was repaired: the step ran as code, so the streak is over.
    await writeLastRun(md, [row({ fromCodeBehind: true, stale: false, error: undefined })]);
    expect((await readLastRun(md))!.steps[0]!.staleRuns).toBeUndefined();

    // And it starts again from 1 if it breaks later.
    await writeLastRun(md, [row()]);
    expect((await readLastRun(md))!.steps[0]!.staleRuns).toBe(1);
  });

  it('reads back a sidecar written before the field existed', async () => {
    const md = path.join(dir, 'legacy.md');
    const file = lastRunPathFor(md);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Exactly what the previous version wrote: a stale row, no `staleRuns`.
    await fs.writeFile(
      file,
      `${JSON.stringify(
        {
          test: path.resolve(md),
          ranAt: new Date().toISOString(),
          steps: [
            {
              index: 1,
              source: 'click the login link',
              file: '/p/tests/checkout.steps.ts',
              status: 'passed',
              fromCodeBehind: false,
              stale: true,
              error: 'resolved to 2 elements',
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );

    const before = await readLastRun(md);
    expect(before!.steps[0]!.stale).toBe(true);
    expect(before!.steps[0]!.staleRuns).toBeUndefined();

    // That old row recorded one run's healing, so this run is the second.
    await writeLastRun(md, [row()]);
    expect((await readLastRun(md))!.steps[0]!.staleRuns).toBe(2);
  });

  it('keeps two identically-worded steps on independent streaks', async () => {
    const md = path.join(dir, 'twins.md');
    const a = row({ index: 1 });
    const b = row({ index: 2 });

    await writeLastRun(md, [a, b]);
    await writeLastRun(md, [a, { ...b, stale: false, fromCodeBehind: true, error: undefined }]);
    await writeLastRun(md, [a, b]);

    const steps = (await readLastRun(md))!.steps;
    expect(steps[0]!.staleRuns).toBe(3);
    expect(steps[1]!.staleRuns).toBe(1);
  });

  it('does not confuse a skill-body step with a test step of the same wording', async () => {
    const md = path.join(dir, 'scoped.md');
    const inTest = row({ index: 1, file: '/p/tests/checkout.steps.ts' });
    const inSkill = row({ index: 2, file: '/p/tests/skills/login.steps.ts' });

    await writeLastRun(md, [inTest, inSkill]);
    await writeLastRun(md, [inTest, { ...inSkill, stale: false, error: undefined }]);
    await writeLastRun(md, [inTest, inSkill]);

    const steps = (await readLastRun(md))!.steps;
    expect(steps[0]!.staleRuns).toBe(3);
    expect(steps[1]!.staleRuns).toBe(1);
  });

  it('is cleared by a green compile, so a repaired step stops reading "N runs in a row"', async () => {
    const md = path.join(dir, 'compiled.md');
    await writeLastRun(md, [row()]);
    await writeLastRun(md, [row()]);
    expect((await readLastRun(md))!.steps[0]!.staleRuns).toBe(2);

    await clearStale(md, [1]);

    const after = (await readLastRun(md))!.steps[0]!;
    expect(after.stale).toBe(false);
    expect(after.staleRuns).toBeUndefined();
    expect(after.error).toBeUndefined();
  });

  it('never throws over a corrupt sidecar — it just loses the streak', async () => {
    const md = path.join(dir, 'corrupt.md');
    const file = lastRunPathFor(md);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{ not json at all', 'utf-8');

    await expect(writeLastRun(md, [row()])).resolves.toBeUndefined();
    expect((await readLastRun(md))!.steps[0]!.staleRuns).toBe(1);
  });

  it('survives a sidecar whose rows are not rows', async () => {
    const md = path.join(dir, 'junk-rows.md');
    const file = lastRunPathFor(md);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({ test: md, ranAt: 'x', steps: [null, 7, 'nope', {}] }),
      'utf-8',
    );

    await expect(writeLastRun(md, [row()])).resolves.toBeUndefined();
    expect((await readLastRun(md))!.steps[0]!.staleRuns).toBe(1);
  });
});

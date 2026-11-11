import { describe, expect, it } from 'vitest';
import { renderRunJson } from '../src/report/reporters/json.js';
import type { RunJson } from '../src/report/reporters/json.js';
import type { RunState, RunTestEntry } from '../src/report/reporters/types.js';
import type { StepResult, TestReport } from '../src/report/types.js';

// Fixtures. Every name, step and value is invented.

function step(index: number, instruction: string, extra: Partial<StepResult> = {}): StepResult {
  return { index, instruction, status: 'passed', turns: [], durationMs: 1000, retried: false, ...extra };
}

function report(steps: StepResult[], extra: Partial<TestReport> = {}): TestReport {
  return {
    testName: 'Place an order',
    filePath: 'unused',
    tags: [],
    status: steps.some((s) => s.status === 'failed' && !s.tolerated && !s.interrupted) ? 'failed' : 'passed',
    steps,
    totalSteps: steps.length,
    passedSteps: steps.filter((s) => s.status === 'passed').length,
    failedSteps: steps.filter((s) => s.status === 'failed' && !s.tolerated && !s.interrupted).length,
    totalSubActions: 0,
    durationMs: 38090,
    tokensUsed: 1200,
    inputTokens: 1000,
    outputTokens: 200,
    date: '2026-01-02T03:04:05.000Z',
    ...extra,
  };
}

function done(title: string, r: TestReport, tags: string[] = []): RunTestEntry {
  return { title, file: 'tests/order.md', tags, state: 'done', report: r, reportFile: 'order.html' };
}

function notRun(title: string): RunTestEntry {
  return { title, file: 'tests/later.md', tags: [], state: 'notRun' };
}

function state(tests: RunTestEntry[], extra: Partial<RunState> = {}): RunState {
  return {
    suiteName: 'shop-tests',
    startedAt: '2026-01-02T03:04:05.000Z',
    durationMs: 83412,
    finished: true,
    bailed: false,
    failOnHealed: false,
    exitCode: 0,
    steptix: { version: '0.0.0-test', commit: 'abc1234' },
    tests,
    ...extra,
  };
}

function render(s: RunState): RunJson {
  const text = renderRunJson(s);
  expect(text.endsWith('}\n')).toBe(true);
  expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  return JSON.parse(text) as RunJson;
}

describe('renderRunJson', () => {
  it('writes the documented shape for a passing test', () => {
    const json = render(
      state([
        done('Place an order', report([step(1, 'Open the shop'), step(2, 'Add #item', { fromCodeBehind: true })]), [
          'smoke',
        ]),
      ]),
    );
    expect(json).toEqual({
      schemaVersion: 1,
      steptix: { version: '0.0.0-test', commit: 'abc1234' },
      startedAt: '2026-01-02T03:04:05.000Z',
      finished: true,
      durationMs: 83412,
      exitCode: 0,
      totals: {
        tests: 1,
        passed: 1,
        failed: 0,
        stopped: 0,
        notRun: 0,
        tokens: 1200,
        inputTokens: 1000,
        outputTokens: 200,
        healedSteps: 0,
      },
      tests: [
        {
          title: 'Place an order',
          file: 'tests/order.md',
          tags: ['smoke'],
          status: 'passed',
          durationMs: 38090,
          tokens: 1200,
          report: 'order.html',
          steps: [
            { step: 1, text: 'Open the shop', status: 'passed', durationMs: 1000, source: 'ai' },
            { step: 2, text: 'Add #item', status: 'passed', durationMs: 1000, source: 'code' },
          ],
        },
      ],
    });
  });

  it('writes exitCode null until the run has ended', () => {
    const { exitCode, ...rest } = state([notRun('Later')], { finished: false });
    void exitCode;
    const json = render(rest);
    expect(json.exitCode).toBeNull();
    expect(json.finished).toBe(false);
    expect(json.tests[0]).toEqual({
      title: 'Later',
      file: 'tests/later.md',
      tags: [],
      status: 'notRun',
      durationMs: 0,
      tokens: 0,
      steps: [],
    });
    expect(json.totals).toMatchObject({ tests: 1, passed: 0, notRun: 1 });
  });

  it('names the failing step and the diagnosis', () => {
    const r = report(
      [
        step(1, 'Open the shop'),
        step(2, 'Verify the total is "42.00"', { status: 'failed', error: 'Expected "42.00".' }),
        step(3, 'Pay', { status: 'skipped' }),
      ],
      {
        skippedSteps: 1,
        diagnosis: {
          rootCause: 'The total was not updated.',
          faultCategory: 'application',
          evidence: ['unused'],
          suggestedFix: 'Fix the basket.',
          confidence: 'medium',
        },
      },
    );
    const t = render(state([done('Place an order', r)], { exitCode: 1 })).tests[0]!;
    expect(t.status).toBe('failed');
    expect(t.failure).toEqual({
      step: 2,
      text: 'Verify the total is "42.00"',
      error: 'Expected "42.00".',
      reportAnchor: 'step-2',
    });
    expect(t.diagnosis).toEqual({
      rootCause: 'The total was not updated.',
      faultCategory: 'application',
      suggestedFix: 'Fix the basket.',
      confidence: 'medium',
    });
    expect(t.skippedSteps).toBe(1);
    expect(t.steps.map((s) => s.status)).toEqual(['passed', 'failed', 'skipped']);
  });

  it('gives a test that failed before any step failure.error alone', () => {
    const r = report([], { status: 'failed', error: 'The code-behind file could not be loaded.' });
    const t = render(state([done('Place an order', r)])).tests[0]!;
    expect(t.status).toBe('failed');
    expect(t.failure).toEqual({ error: 'The code-behind file could not be loaded.' });
  });

  it('marks a stopped test stopped, and its step', () => {
    const r = report([step(1, 'Wait for the order', { status: 'failed', interrupted: true })], { aborted: true });
    const json = render(state([done('Place an order', r)]));
    expect(json.tests[0]!.status).toBe('stopped');
    expect(json.tests[0]!.steps[0]).toMatchObject({ status: 'failed', stopped: true });
    expect(json.totals).toMatchObject({ stopped: 1, failed: 0 });
  });

  it('passes a tolerated failure and marks the step', () => {
    const r = report(
      [step(1, 'Close the banner', { status: 'failed', tolerated: true }), step(2, 'Open the shop')],
      { toleratedSteps: 1 },
    );
    const t = render(state([done('Place an order', r)])).tests[0]!;
    expect(t.status).toBe('passed');
    expect(t.failure).toBeUndefined();
    expect(t.toleratedSteps).toBe(1);
    expect(t.steps[0]).toEqual({
      step: 1,
      text: 'Close the banner',
      status: 'failed',
      durationMs: 1000,
      source: 'ai',
      tolerated: true,
    });
    expect(t.steps[1]).not.toHaveProperty('tolerated');
  });

  it('writes a data-driven test with its rows and the failing row', () => {
    const r = report(
      [
        step(1, 'Choose the plan', { dataRow: 1 }),
        step(1, 'Choose the plan', { dataRow: 2 }),
        step(6, 'Verify the order total is "42.00"', { dataRow: 2, status: 'failed', error: 'Expected 42.' }),
      ],
      {
        rows: [
          { index: 1, values: { plan: 'basic' }, status: 'passed', durationMs: 18220, tokensUsed: 0, videoRelPath: 'videos/r1.webm' },
          { index: 2, values: { plan: 'pro' }, status: 'failed', durationMs: 19870, tokensUsed: 1200 },
          { index: 3, values: { plan: 'team' }, status: 'skipped', notRunReason: 'stopped', durationMs: 0, tokensUsed: 0 },
        ],
      },
    );
    const t = render(state([done('Checkout', r)], { bailed: true, exitCode: 1 })).tests[0]!;
    expect(t.status).toBe('failed');
    expect(t.rows).toEqual([
      { row: 1, status: 'passed', durationMs: 18220, tokens: 0, values: { plan: 'basic' }, video: 'videos/r1.webm' },
      { row: 2, status: 'failed', durationMs: 19870, tokens: 1200, values: { plan: 'pro' } },
      { row: 3, status: 'notRun', durationMs: 0, tokens: 0, values: { plan: 'team' } },
    ]);
    expect(t.failure).toEqual({
      row: 2,
      step: 6,
      text: 'Verify the order total is "42.00"',
      error: 'Expected 42.',
      reportAnchor: 'row-2-step-6',
    });
    expect(t.steps.map((s) => s.row)).toEqual([1, 2, 2]);
  });

  it('counts healed steps as a pass and marks them, with or without --fail-on-healed', () => {
    const r = report(
      [step(1, 'Add #item', { codeBehindStale: { file: 'unused', source: 'Add #item', error: 'Gone.' } })],
      { healedSteps: 1 },
    );
    // What the exit code makes of it is the command's to decide; see
    // tests/reporters-run.test.ts.
    for (const failOnHealed of [false, true]) {
      const json = render(state([done('Place an order', r)], { failOnHealed }));
      expect(json.tests[0]!.status).toBe('passed');
      expect(json.tests[0]!.healedSteps).toBe(1);
      expect(json.tests[0]!.steps[0]!.healed).toBe(true);
      expect(json.totals.healedSteps).toBe(1);
    }
  });

  it('points failure.reportAnchor at the loop pass that failed', () => {
    const pass = (index: number, extra: Partial<StepResult> = {}): StepResult =>
      step(3, 'Check #item', { loop: { kind: 'iteration', label: 'Each item', index, count: 3, values: {} }, ...extra });
    const r = report([pass(1), pass(2), pass(3, { status: 'failed', error: 'Not there.' })]);
    const t = render(state([done('Place an order', r)])).tests[0]!;
    expect(t.failure).toEqual({ step: 3, text: 'Check #item', error: 'Not there.', reportAnchor: 'step-3-3' });
  });

  it('points failure.reportAnchor at the pass that failed within its row, in a data-driven test', () => {
    const pass = (row: number, index: number, extra: Partial<StepResult> = {}): StepResult =>
      step(3, 'Check #item', {
        dataRow: row,
        loop: { kind: 'iteration', label: 'Each item', index, count: 2, values: {} },
        ...extra,
      });
    const r = report([pass(1, 1), pass(1, 2), pass(2, 1), pass(2, 2, { status: 'failed', error: 'Not there.' })], {
      rows: [
        { index: 1, values: {}, status: 'passed', durationMs: 1, tokensUsed: 0 },
        { index: 2, values: {}, status: 'failed', durationMs: 1, tokensUsed: 0 },
      ],
    });
    const t = render(state([done('Place an order', r)])).tests[0]!;
    expect(t.failure).toMatchObject({ row: 2, step: 3, reportAnchor: 'row-2-step-3-2' });
  });

  it('names the hook scope of a failing hook line', () => {
    const r = report([
      step(0, 'Sign in', { hookScope: 'before', hookIndex: 1, status: 'failed', error: 'No form.' }),
      step(1, 'Open the shop', { status: 'skipped' }),
    ]);
    const t = render(state([done('Place an order', r)])).tests[0]!;
    expect(t.failure).toEqual({
      hook: 'before',
      step: 0,
      text: 'Sign in',
      error: 'No form.',
      reportAnchor: 'hook-before-1-step-0',
    });
    expect(t.steps[0]).toMatchObject({ hook: 'before', status: 'failed' });
  });

  it('counts a data-driven test\'s healed steps over every row', () => {
    const stale = { file: 'unused', source: 'Add #item', error: 'Gone.' };
    const r = report(
      [step(1, 'Add #item', { dataRow: 1, codeBehindStale: stale }), step(1, 'Add #item', { dataRow: 2, codeBehindStale: stale })],
      {
        // What a merged report carries: the first row's own figure.
        healedSteps: 1,
        rows: [
          { index: 1, values: {}, status: 'passed', durationMs: 1, tokensUsed: 0 },
          { index: 2, values: {}, status: 'passed', durationMs: 1, tokensUsed: 0 },
        ],
      },
    );
    expect(render(state([done('Place an order', r)])).tests[0]!.healedSteps).toBe(2);
  });

  it('does not call a step that healed nothing healed', () => {
    const r = report([
      step(1, 'Add #item', {
        status: 'failed',
        codeBehindStale: { file: 'unused', source: 'Add #item', error: 'Gone.' },
      }),
    ]);
    const t = render(state([done('Place an order', r)])).tests[0]!;
    expect(t.steps[0]).not.toHaveProperty('healed');
    expect(t.healedSteps).toBeUndefined();
  });

  it('writes a parse error as notRun and a run error as failed, each with its message', () => {
    const json = render(
      state([
        { title: 'tests/broken.md', file: 'tests/broken.md', tags: [], state: 'parseError', message: 'Unknown skill "Ada".' },
        { title: 'Place an order', file: 'tests/order.md', tags: [], state: 'runError', message: '\u001b[31mData file not found\u001b[0m' },
        notRun('Later'),
      ]),
    );
    expect(json.tests.map((t) => [t.status, t.failure])).toEqual([
      ['notRun', { error: 'Unknown skill "Ada".' }],
      ['failed', { error: 'Data file not found' }],
      ['notRun', undefined],
    ]);
    expect(json.totals).toMatchObject({ tests: 3, failed: 1, notRun: 2 });
  });

  it('keeps text intact but strips colour codes, and leaves masked values masked', () => {
    const odd = 'a <b> & "c" \u0001 \u001b[31mred\u001b[0m ***';
    const clean = 'a <b> & "c" \u0001 red ***';
    const r = report([step(1, odd, { status: 'failed', error: odd, dataRow: 1 })], {
      rows: [{ index: 1, values: { password: '***', note: odd }, status: 'failed', durationMs: 1, tokensUsed: 0 }],
    });
    const t = render(state([done('Sign in', r)])).tests[0]!;
    expect(t.steps[0]!.text).toBe(clean);
    expect(t.failure).toMatchObject({ text: clean, error: clean });
    expect(t.rows![0]!.values).toEqual({ password: '***', note: clean });
  });

  it('sums tokens over the tests that ran', () => {
    const a = report([step(1, 'One')], { tokensUsed: 10, inputTokens: 7, outputTokens: 3 });
    const b = report([step(1, 'Two')], { tokensUsed: 5, inputTokens: 4, outputTokens: 1 });
    const json = render(state([done('A', a), done('B', b), notRun('C')]));
    expect(json.totals).toMatchObject({ tokens: 15, inputTokens: 11, outputTokens: 4, passed: 2, notRun: 1 });
  });
});

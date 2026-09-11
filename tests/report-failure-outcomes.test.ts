/**
 * How the report renders the two failure outcomes (decisions 2 and 6).
 *
 * Both ride `status: 'failed'`, so everything that distinguishes them is
 * presentational — and presentation is what no other suite can see. A tolerated
 * step in the red badge reports a GREEN run as having a red step in it; a
 * deliberate one titled "Step Failed" sends the reader hunting for a root cause
 * the author wrote one line above.
 */
import { describe, it, expect } from 'vitest';
import { renderReport } from '../src/report/generator.js';
import { mergeRowReports } from '../src/report/merge-rows.js';
import type { StepResult, TestReport } from '../src/report/types.js';

function step(overrides: Partial<StepResult> & { index: number }): StepResult {
  return {
    instruction: `step ${overrides.index}`,
    status: 'passed',
    turns: [],
    durationMs: 10,
    retried: false,
    ...overrides,
  };
}

function report(overrides: Partial<TestReport> = {}): TestReport {
  return {
    testName: 'Failure outcomes',
    filePath: 'c:/proj/tests/outcomes.md',
    tags: [],
    status: 'passed',
    steps: [],
    totalSteps: 0,
    passedSteps: 0,
    failedSteps: 0,
    totalSubActions: 0,
    durationMs: 100,
    tokensUsed: 0,
    inputTokens: 0,
    outputTokens: 0,
    date: '2026-09-11T00:00:00.000Z',
    ...overrides,
  };
}

/** One report rendered, its header counts and steps as given. */
const render = (overrides: Partial<TestReport>) => renderReport(report(overrides));

const TOLERATED = render({
  status: 'passed',
  totalSteps: 3,
  passedSteps: 2,
  failedSteps: 0,
  toleratedSteps: 1,
  steps: [
    step({ index: 1 }),
    step({
      index: 2,
      instruction: 'Verify the footer shows the build number otherwise continue',
      status: 'failed',
      tolerated: true,
      error: 'No build number in the footer',
      aiExplanation: 'Footer build number missing',
    }),
    step({ index: 3 }),
  ],
});

const DELIBERATE = render({
  status: 'failed',
  totalSteps: 2,
  passedSteps: 1,
  failedSteps: 1,
  steps: [
    step({ index: 1 }),
    step({
      index: 2,
      instruction: 'If {{a}} is "peanuts" then fail the test with error "…"',
      status: 'failed',
      deliberate: true,
      error: 'The variable value was peanuts. Expected apples',
    }),
  ],
});

const ORDINARY = render({ totalSteps: 1, passedSteps: 1, steps: [step({ index: 1 })] });

/**
 * Render → the fragments it must contain, then the ones it must not.
 *
 * Matched on the rendered ELEMENT rather than the bare class name: every class
 * in the stylesheet is in the document whatever the run did, so
 * `toContain('badge-fail')` would pass on a page that never uses it. The
 * tolerated step is `status: 'failed'`, so the naive render gives it the red
 * badge; its title says what happened to the RUN; its explanation is where an
 * `otherwise continue with warning` tail's sentence lands; it auto-expands
 * because a green report is the one nobody scrolls. And with nothing tolerated
 * the page is what it was before the feature.
 */
const RENDERED: Array<[string, string, string[], string[]]> = [
  ['tolerated: the amber TOLERATED badge, not the red FAILED one', TOLERATED,
    ['<span class="badge badge-tolerated">✗ TOLERATED</span>'], ['class="badge badge-fail"']],
  ['tolerated: titled for the run, and keeps the error', TOLERATED,
    ['✗ Step failed — the run continued', 'No build number in the footer',
      'Footer build number missing'], ['✗ Step Failed']],
  ['tolerated: counted in the header, beside Skipped', TOLERATED,
    ['<span class="number stat-tolerated">1</span>', '<span class="label">Tolerated</span>'], []],
  ['tolerated: auto-expanded', TOLERATED,
    ["querySelector('.step .badge-fail, .step .badge-aborted, .step .badge-tolerated')"], []],
  ['deliberate: an ordinary red failure', DELIBERATE,
    ['<span class="badge badge-fail">✗ FAILED</span>'], ['class="badge badge-tolerated"']],
  ['deliberate: titled for the step that asked, leading with the message', DELIBERATE,
    ['✗ Failed by the step', 'The variable value was peanuts. Expected apples'],
    ['✗ Step Failed']],
  ['ordinary: no Tolerated stat at all', ORDINARY, [],
    ['class="number stat-tolerated"', '<span class="label">Tolerated</span>']],
];

describe('report — the two failure outcomes', () => {
  it.each(RENDERED)('%s', (_label, html, present, absent) => {
    for (const fragment of present) expect(html).toContain(fragment);
    for (const fragment of absent) expect(html).not.toContain(fragment);
  });
});

describe('merge-rows — toleratedSteps', () => {
  const row = (index: number, tolerated: number, status: TestReport['status']) => ({
    report: report({
      status,
      totalSteps: 3,
      passedSteps: 3 - tolerated,
      failedSteps: 0,
      ...(tolerated > 0 && { toleratedSteps: tolerated }),
      steps: [step({ index: 1 })],
    }),
    dataRowIndex: index,
    dataRowCount: 2,
    dataRowValues: { user: `u${index}` },
  });

  it('sums the count across rows like every other total', () => {
    const merged = mergeRowReports([row(0, 1, 'passed'), row(1, 2, 'passed')]);
    expect(merged.toleratedSteps).toBe(3);
  });

  it('does not let a tolerated failure flip the merged run to failed', () => {
    // `anyFailed` reads each row's own `status`, which the run loop computed
    // with the tolerated failures already excluded (decision 6); merging is the
    // one place that could re-derive it and get it wrong.
    const merged = mergeRowReports([row(0, 1, 'passed'), row(1, 1, 'passed')]);
    expect(merged.status).toBe('passed');
    expect(merged.failedSteps).toBe(0);
  });

  it('omits the key entirely when no row tolerated anything', () => {
    // Byte-identical to a merge from before this feature — `skippedSteps`' rule.
    const merged = mergeRowReports([row(0, 0, 'passed'), row(1, 0, 'passed')]);
    expect(merged).not.toHaveProperty('toleratedSteps');
  });
});

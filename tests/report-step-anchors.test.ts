/**
 * The step card anchors a scoreboard line links to
 * (docs/specs/SPEC-scoreboard.md §8.3; src/report/anchors.ts): built from the
 * fields a line records, unique within a report, and found in a data-row report
 * whatever band a step sits in.
 */
import { describe, it, expect } from 'vitest';
import { renderReport } from '../src/report/generator.js';
import { mergeRowReports } from '../src/report/merge-rows.js';
import { stepAnchor } from '../src/report/anchors.js';
import type { StepResult, TestReport } from '../src/report/types.js';

function step(over: Partial<StepResult> & { index: number }): StepResult {
  return { instruction: `step ${over.index}`, status: 'passed', turns: [], durationMs: 5, retried: false, ...over };
}

function report(steps: StepResult[]): TestReport {
  return {
    testName: 'anchors',
    filePath: '/t/anchors.md',
    tags: [],
    status: 'passed',
    steps,
    totalSteps: steps.length,
    passedSteps: steps.length,
    failedSteps: 0,
    totalSubActions: 0,
    durationMs: 10,
    tokensUsed: 0,
    inputTokens: 0,
    outputTokens: 0,
    date: '2026-09-29T00:00:00.000Z',
  };
}

const ids = (html: string): string[] => [...html.matchAll(/<div class="(?:step[^"]*|interactive-banner)" id="([^"]+)"/g)].map((m) => m[1]!);

describe('stepAnchor', () => {
  it('is the format the scoreboard\'s reader builds from a line', () => {
    expect(stepAnchor({ step: 11 })).toBe('step-11');
    expect(stepAnchor({ step: 11, row: 3 })).toBe('row-3-step-11');
    expect(stepAnchor({ step: 0, hook: 'before' })).toBe('hook-before-step-0');
    expect(stepAnchor({ step: 5, hook: 'beforeEach', hookIndex: 2 })).toBe('hook-beforeEach-2-step-5');
    expect(stepAnchor({ step: 0, row: 3, hook: 'before', hookIndex: 1 })).toBe('row-3-hook-before-1-step-0');
    // A place in a scope means nothing without the scope.
    expect(stepAnchor({ step: 5, hookIndex: 2 })).toBe('step-5');
  });
});

describe('the report\'s step cards', () => {
  it('carry the line\'s anchor, and stay unique when a loop body or a hook repeats', () => {
    const html = renderReport(
      report([
        step({ index: 0, hookScope: 'before', hookIndex: 1 }),
        step({ index: 0, hookScope: 'before', hookIndex: 2 }),
        step({ index: 1 }),
        step({ index: 2, loop: { kind: 'iteration', label: 'Each order', index: 1, count: 2, values: {} } }),
        step({ index: 2, loop: { kind: 'iteration', label: 'Each order', index: 2, count: 2, values: {} } }),
        step({ index: 3, stepKind: 'mode', surface: 'computer' }),
      ]),
    );
    expect(ids(html)).toEqual([
      'hook-before-1-step-0',
      'hook-before-2-step-0',
      'step-1',
      'step-2',
      'step-2-2',
      'step-3',
    ]);
  });

  it('in a data-row report, every step names its row — a step banded by an inner loop too', () => {
    const row = (dataRowIndex: number, steps: StepResult[]) => ({
      report: report(steps),
      dataRowIndex,
      dataRowCount: 2,
      dataRowValues: { customer: dataRowIndex === 0 ? 'Alice' : 'Bob' },
    });
    const inner = (index: number): StepResult =>
      step({ index, loop: { kind: 'iteration', label: 'Each order', index: 1, count: 1, values: {} } });
    const merged = mergeRowReports([row(0, [inner(1), step({ index: 2 })]), row(1, [inner(1), step({ index: 2 })])]);

    // The band still reads the inner loop; the row rides beside it.
    expect(merged.steps.map((s) => [s.dataRow, s.loop?.kind])).toEqual([
      [1, 'iteration'],
      [1, 'row'],
      [2, 'iteration'],
      [2, 'row'],
    ]);
    expect(ids(renderReport(merged))).toEqual(['row-1-step-1', 'row-1-step-2', 'row-2-step-1', 'row-2-step-2']);
  });
});

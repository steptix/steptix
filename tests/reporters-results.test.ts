import { describe, expect, it } from 'vitest';
import {
  countSteps,
  firstFailingStep,
  stepAnchorOf,
  stripAnsi,
  videoPathFor,
} from '../src/report/reporters/results.js';
import type { StepResult } from '../src/report/types.js';

function step(index: number, extra: Partial<StepResult> = {}): StepResult {
  return { index, instruction: `Step ${index}`, status: 'passed', turns: [], durationMs: 1, retried: false, ...extra };
}

describe('reporter result helpers', () => {
  it('strips colour and hyperlink codes and nothing else', () => {
    expect(stripAnsi('\u001b[1;31mError:\u001b[0m bad')).toBe('Error: bad');
    expect(stripAnsi('\u001b]8;;https://example.invalid\u0007link\u001b]8;;\u0007')).toBe('link');
    expect(stripAnsi('[31m stays when there is no ESC')).toBe('[31m stays when there is no ESC');
  });

  it('places a video beside its report', () => {
    expect(videoPathFor('order.html', 'videos/a.webm')).toBe('videos/a.webm');
    expect(videoPathFor('sub/order.html', 'videos/a.webm')).toBe('sub/videos/a.webm');
    expect(videoPathFor(undefined, 'videos/a.webm')).toBe('videos/a.webm');
  });

  it('finds the first failure that is not tolerated', () => {
    const steps = [step(1, { status: 'failed', tolerated: true }), step(2), step(3, { status: 'failed' })];
    expect(firstFailingStep(steps)?.index).toBe(3);
    expect(firstFailingStep([step(1)])).toBeUndefined();
  });

  it('builds the anchor the HTML report uses, from dataRow or a run row marker', () => {
    const alone = (s: StepResult): string => stepAnchorOf({ steps: [s] }, s);
    expect(alone(step(6))).toBe('step-6');
    expect(alone(step(6, { dataRow: 2 }))).toBe('row-2-step-6');
    expect(alone(step(6, { loop: { kind: 'row', index: 3, values: {} } }))).toBe('row-3-step-6');
    expect(alone(step(0, { hookScope: 'before', hookIndex: 1 }))).toBe('hook-before-1-step-0');
  });

  it('gives a step that ran more than once the id of its own pass', () => {
    const pass = (index: number, extra: Partial<StepResult> = {}): StepResult =>
      step(3, { loop: { kind: 'iteration', label: 'Each item', index, count: 3, values: {} }, ...extra });
    const steps = [pass(1), pass(2), pass(3, { status: 'failed' })];
    expect(steps.map((s) => stepAnchorOf({ steps }, s))).toEqual(['step-3', 'step-3-2', 'step-3-3']);
  });

  it('counts the steps that ran, from code, and those healed, tolerated and skipped', () => {
    const counts = countSteps([
      step(0, { hookScope: 'before' }),
      step(1, { fromCodeBehind: true }),
      step(2, { codeBehindStale: { file: 'f', source: 's', error: 'e' } }),
      step(3, { status: 'failed', tolerated: true }),
      step(4, { status: 'skipped' }),
    ]);
    expect(counts).toEqual({ steps: 3, stepsFromCode: 1, healed: 1, tolerated: 1, skipped: 1 });
  });
});

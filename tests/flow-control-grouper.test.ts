/**
 * A flow-control step is never a conditional and never a continuation
 * (stories/step-flow-control.md, decision 7 and §Tests "Grouper, combined").
 *
 * The trap this file guards is specific. `isConditionalStep` matches anything
 * opening `If`, and `executeBranchedStep` runs the matched conditional AND the
 * continuation inside one call — so a grouped `If … then return` would be
 * followed at once by the very step it exists to skip. `Set` established the
 * exemption; the story requires this to be tested with the return step
 * BETWEEN real conditionals, not alone, because a return step on its own never
 * meets the grouper at all.
 */
import { describe, it, expect } from 'vitest';
import { isConditionalStep, identifyStepGroups } from '../src/runner/step-grouper.js';

/**
 * Replay the arithmetic both run loops use (`i = group.continuationStep.index`
 * then `i++`) and record WHAT text ran at each index.
 *
 * Asserting that an index was "reached" is not enough — a synthetic
 * continuation reaches the index while running a placeholder string in place
 * of the author's step, which is the bug itself. This records the text.
 */
function ranAs(steps: string[]): Map<number, string> {
  const groups = identifyStepGroups(steps);
  const out = new Map<number, string>();
  for (let i = 0; i < steps.length; i++) {
    const g = groups.get(i);
    if (g && i === g.conditionalSteps[0]!.index) {
      for (const c of g.conditionalSteps) out.set(c.index, c.instruction);
      out.set(g.continuationStep.index, g.continuationStep.instruction);
      i = g.continuationStep.index;
      continue;
    }
    if (g) continue;
    out.set(i, steps[i]!);
  }
  return out;
}

describe('isConditionalStep', () => {
  it('says no to a flow-control step even though it opens "If"', () => {
    expect(isConditionalStep('If the title is Dashboard then return')).toBe(false);
    expect(isConditionalStep('When the dashboard is shown then stop')).toBe(false);
    expect(isConditionalStep('Return')).toBe(false);
    expect(isConditionalStep('Stop running the remaining steps')).toBe(false);
  });

  it('still says yes to an ordinary conditional', () => {
    expect(isConditionalStep('If prompted for MFA, enter the code')).toBe(true);
    expect(isConditionalStep('When prompted, click Not now')).toBe(true);
    // Near misses stay ordinary conditionals: the return was never claimed.
    expect(isConditionalStep('If the page shows X then return to the dashboard')).toBe(true);
    expect(isConditionalStep('If the title is Dashboard then retun')).toBe(true);
  });
});

describe('the combination the story names', () => {
  const steps = [
    'If prompted for MFA, enter the code',
    'If the title is Dashboard then return',
    'Wait for the dashboard',
  ];

  it('forms NO group at all', () => {
    // Not "a group with a synthetic continuation" — that was tried for `Set`
    // and was worse than the bug, because the synthetic index IS the
    // exempted step's, so the jump skips it entirely.
    expect(identifyStepGroups(steps).size).toBe(0);
  });

  it('runs all three steps as themselves', () => {
    const ran = ranAs(steps);
    for (let i = 0; i < steps.length; i++) {
      expect(ran.get(i), `index ${i}`).toBe(steps[i]);
    }
  });
});

describe('a return step in every position around a conditional', () => {
  const cases: string[][] = [
    // Between a conditional and an ordinary step — the story's case.
    ['If prompted for MFA, enter the code', 'If the title is Dashboard then return', 'Wait for the dashboard'],
    // Directly after a run of two conditionals.
    ['If prompted, do it', 'If asked again, do it', 'Stop', 'Click Save'],
    // Between a conditional and a later conditional.
    ['If prompted, do it', 'If we are done then return', 'If asked, do it', 'Click Save'],
    // Alone at the end, after a conditional that would otherwise take a
    // SYNTHETIC continuation at exactly the return's index.
    ['Click A', 'If prompted, do it', 'Return'],
    // First step of the test.
    ['If we are already signed in then stop', 'If prompted, do it', 'Click Save'],
    // Two returns back to back.
    ['If prompted, do it', 'If a then return', 'If b then stop', 'Click Save'],
  ];

  for (const steps of cases) {
    it(`every step runs as itself: ${JSON.stringify(steps)}`, () => {
      const ran = ranAs(steps);
      for (let i = 0; i < steps.length; i++) {
        expect(ran.get(i), `index ${i}`).toBe(steps[i]);
      }
    });
  }
});

describe('grouping is otherwise unchanged', () => {
  it('still pairs an ordinary conditional with its continuation', () => {
    const groups = identifyStepGroups(['If prompted for MFA, enter the code', 'Click Save']);
    expect(groups.get(0)!.continuationStep.instruction).toBe('Click Save');
    expect(groups.get(1)).toBeDefined();
  });

  it('still gives a trailing conditional its synthetic continuation', () => {
    const groups = identifyStepGroups(['Navigate to settings', 'If you see a banner, dismiss it']);
    expect(groups.get(1)!.continuationStep.instruction).toContain('no continuation');
  });

  it('groups a near-miss line, because it is not flow control', () => {
    // `then return to the dashboard` reads as navigate-back and stays an
    // ordinary conditional — so it DOES take a continuation, and must.
    const groups = identifyStepGroups([
      'If the page shows the old layout then return to the dashboard',
      'Click Save',
    ]);
    expect(groups.get(0)!.continuationStep.instruction).toBe('Click Save');
  });
});

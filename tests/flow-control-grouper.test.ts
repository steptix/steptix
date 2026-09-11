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

/** Every index ran the author's own text — no group swallowed or synthesised one. */
function expectRunsAsAuthored(steps: string[], label = ''): void {
  const ran = ranAs(steps);
  for (let i = 0; i < steps.length; i++) {
    expect(ran.get(i), `${label} index ${i}`).toBe(steps[i]);
  }
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
  });

  it('says yes again to prose that merely ENDS in the word `fail`', () => {
    // A bare trailing `fail` is not a claim (decision 1): these are watches.
    expect(isConditionalStep('If the login attempts fail')).toBe(true);
    expect(isConditionalStep('If the upload does not fail')).toBe(true);
    expect(isConditionalStep('If the balance is zero fail')).toBe(true);
    // …while a line that DOES claim keeps the exemption: it is the tail, not the word.
    expect(isConditionalStep('If the balance is zero fail the test')).toBe(false);
    expect(isConditionalStep('If {{a}} is "peanuts" fail with error "boom"')).toBe(false);
  });

  it('says no to a near miss, because ` then ` makes it a CONTROL line', () => {
    // These two rows used to assert `true`, and the change is the composition
    // with stories/control-flow.md rather than a regression in either feature.
    //
    // `then return to the dashboard` is still not flow control — the grammar
    // is `$`-anchored, and the trailing words leave it unmatched — so it falls
    // through to the OTHER grammar, where ` then ` is the opt-in that turns an
    // `If` into a decision the framework dispatches. The line is a chain whose
    // tail is the prose "return to the dashboard", which is what an author
    // means by it; what it is not, either way, is a watch. A typo (`retun`) is
    // the same story: no return was claimed, but the `then` was.
    //
    // The direction of the change is the safe one. A watch polls for the
    // condition and performs the whole line as prose; a chain judges the
    // condition once and dispatches the tail. Nothing green is claimed for
    // work not done in either reading.
    expect(isConditionalStep('If the page shows X then return to the dashboard')).toBe(false);
    expect(isConditionalStep('If the title is Dashboard then retun')).toBe(false);
    // Without the ` then ` it is a watch again, and always was.
    expect(isConditionalStep('If the page shows X, go back to the dashboard')).toBe(true);
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

  it('forms no group for a near-miss line: it is a control line, not a watch', () => {
    // `then return to the dashboard` reads as navigate-back and is NOT flow
    // control — but the ` then ` makes it a control line, and a control line
    // is excluded from grouping for the same reason a flow-control step is:
    // `executeBranchedStep` would perform the whole line as the model's
    // fallback and the framework would never dispatch the tail
    // (stories/control-flow.md §Grouper).
    const groups = identifyStepGroups([
      'If the page shows the old layout then return to the dashboard',
      'Click Save',
    ]);
    expect(groups.size).toBe(0);
  });

  it('still groups the same line written as a watch', () => {
    // The comma-and-no-`then` form, which is what a watch has always been.
    const groups = identifyStepGroups([
      'If the page shows the old layout, go back to the dashboard',
      'Click Save',
    ]);
    expect(groups.get(0)!.continuationStep.instruction).toBe('Click Save');
  });
});

// The `… otherwise …` tail takes the same exemption
// (stories/step-failure-outcomes.md, decision 4).
describe('a step carrying a failure tail', () => {
  // `If …` would be collected; the plain form would be swallowed as a CONTINUATION.
  it.each([
    ['If … otherwise continue', 'If the promo banner is shown, dismiss it otherwise continue', false],
    ['If … otherwise fail with message', 'If prompted for MFA, enter the code otherwise fail the test with message "no MFA prompt"', false],
    ['plain step … otherwise continue', 'Dismiss the promo banner otherwise continue', false],
    // The exemption is the tail's doing and nothing else's: same line, no tail.
    ['the same If line WITHOUT the tail', 'If the promo banner is shown, dismiss it', true],
  ])('is never a conditional, however it opens: %s', (_label, line, expected) => {
    expect(isConditionalStep(line as string)).toBe(expected);
  });

  it('forms no group when it sits BETWEEN two real conditionals', () => {
    // In the continuation slot the jump `i = group.continuationStep.index` would
    // run the tail step through `executeBranchedStep` as prose, tail included.
    const steps = [
      'If prompted for MFA, enter the code',
      'Verify the footer shows the build number otherwise continue',
      'If asked to remember this device, click Not now',
      'Click Save',
    ];
    // The conditional AFTER it still pairs with `Click Save`: ordinary grouping
    // does not stop.
    const groups = identifyStepGroups(steps);
    expect(groups.get(0)).toBeUndefined();
    expect(groups.get(1)).toBeUndefined();
    expect(groups.get(2)!.continuationStep.instruction).toBe('Click Save');
    expectRunsAsAuthored(steps);
  });

  it('runs as itself in every position around a conditional', () => {
    const cases: Array<[string, string[]]> = [
      ['continuation slot, after two conditionals',
        ['If prompted, do it', 'If asked again, do it', 'Dismiss the banner otherwise continue', 'Click Save']],
      ['continuation slot, message-ful `otherwise fail`',
        ['If prompted, do it', 'Verify the title otherwise fail the test with message "no title"', 'Click Save']],
      ['first step of the test',
        ['Dismiss the cookie bar otherwise continue', 'If prompted, do it', 'Click Save']],
      // Last step: a trailing conditional would otherwise take a SYNTHETIC
      // continuation at exactly this index.
      ['last step',
        ['Click A', 'If prompted, do it', 'Check the footer otherwise continue']],
      ['two tails back to back',
        ['If prompted, do it', 'Dismiss A otherwise continue', 'Dismiss B or else continue', 'Click Save']],
    ];
    for (const [label, steps] of cases) expectRunsAsAuthored(steps, label);
  });

  it('does not exempt a line whose `otherwise` is only prose', () => {
    // The tail grammar is `$`-anchored, so this line is the watch it always was.
    const groups = identifyStepGroups([
      'If the banner is shown, dismiss it otherwise continue to the next page',
      'Click Save',
    ]);
    expect(groups.get(0)!.continuationStep.instruction).toBe('Click Save');
  });
});

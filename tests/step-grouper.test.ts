import { describe, it, expect } from 'vitest';
import { isConditionalStep, identifyStepGroups } from '../src/runner/step-grouper.js';

describe('isConditionalStep', () => {
  it('matches "If prompted for..."', () => {
    expect(isConditionalStep('If prompted for MFA, enter the code')).toBe(true);
  });

  it('matches "When prompted..."', () => {
    expect(isConditionalStep('When prompted for a password, enter it')).toBe(true);
  });

  it('matches "When asked..."', () => {
    expect(isConditionalStep('When asked to confirm, click Yes')).toBe(true);
  });

  it('does NOT match "Wait for the dashboard"', () => {
    expect(isConditionalStep('Wait for the dashboard to load')).toBe(false);
  });

  it('does NOT match "Click the login button"', () => {
    expect(isConditionalStep('Click the login button')).toBe(false);
  });

  it('does NOT match "When the page loads" (not a conditional intent)', () => {
    // "When" only matches "When prompted" / "When asked"
    expect(isConditionalStep('When the page loads, check the title')).toBe(false);
  });

  it('strips [prefix] markers before testing', () => {
    expect(isConditionalStep('[output: mfa] If prompted for MFA, enter code')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isConditionalStep('IF PROMPTED FOR MFA, enter code')).toBe(true);
  });
});

describe('identifyStepGroups', () => {
  it('returns empty map for steps with no conditionals', () => {
    const steps = [
      'Navigate to the login page',
      'Enter credentials',
      'Click Sign In',
    ];
    const groups = identifyStepGroups(steps);
    expect(groups.size).toBe(0);
  });

  it('groups a single conditional with the next non-conditional step', () => {
    const steps = [
      'If prompted for MFA, enter the code',
      'Wait for the dashboard to load',
      'Verify the welcome message',
    ];
    const groups = identifyStepGroups(steps);

    // Steps 0 and 1 should be in the group
    expect(groups.has(0)).toBe(true);
    expect(groups.has(1)).toBe(true);
    expect(groups.has(2)).toBe(false);

    const group = groups.get(0)!;
    expect(group.conditionalSteps).toHaveLength(1);
    expect(group.conditionalSteps[0]!.index).toBe(0);
    expect(group.continuationStep.index).toBe(1);

    // Both entries point to the same group instance
    expect(groups.get(1)).toBe(group);
  });

  it('groups multiple consecutive conditionals with one continuation', () => {
    const steps = [
      'If prompted for MFA, enter the code',
      'If a security question appears, answer it',
      'Wait for the dashboard to load',
    ];
    const groups = identifyStepGroups(steps);

    expect(groups.has(0)).toBe(true);
    expect(groups.has(1)).toBe(true);
    expect(groups.has(2)).toBe(true);

    const group = groups.get(0)!;
    expect(group.conditionalSteps).toHaveLength(2);
    expect(group.conditionalSteps[0]!.index).toBe(0);
    expect(group.conditionalSteps[1]!.index).toBe(1);
    expect(group.continuationStep.index).toBe(2);
  });

  it('handles conditional at the very end (synthetic continuation)', () => {
    const steps = [
      'Navigate to settings',
      'If you see a banner, dismiss it',
    ];
    const groups = identifyStepGroups(steps);

    expect(groups.has(0)).toBe(false);
    expect(groups.has(1)).toBe(true);

    const group = groups.get(1)!;
    expect(group.conditionalSteps).toHaveLength(1);
    expect(group.continuationStep.instruction).toContain('no continuation');
    expect(group.continuationStep.index).toBe(2); // synthetic index past end
  });

  it('handles two separate conditional groups', () => {
    const steps = [
      'If prompted for MFA, enter code',
      'Wait for dashboard',
      'If asked to review, click Skip',
      'Verify the home page',
    ];
    const groups = identifyStepGroups(steps);

    // First group: steps 0, 1
    const group1 = groups.get(0)!;
    expect(group1.conditionalSteps).toHaveLength(1);
    expect(group1.conditionalSteps[0]!.index).toBe(0);
    expect(group1.continuationStep.index).toBe(1);

    // Second group: steps 2, 3
    const group2 = groups.get(2)!;
    expect(group2.conditionalSteps).toHaveLength(1);
    expect(group2.conditionalSteps[0]!.index).toBe(2);
    expect(group2.continuationStep.index).toBe(3);

    // They should be different group instances
    expect(group1).not.toBe(group2);
  });
});

/**
 * Control lines and the watch grouper (stories/control-flow.md §Grouper).
 *
 * The two constructs share an opening word and mean opposite things: a watch
 * `If` waits for a state to APPEAR and lets the model perform the line, a
 * control `If … then` is a decision the framework makes once and dispatches
 * itself. Letting one become the other is not a cosmetic mix-up — both loops
 * advance past a group with `i = group.continuationStep.index`, so a control
 * line swallowed as a continuation takes its whole tail out of the run with
 * it. Exactly the `Set` precedent above, and the same fix: form no group.
 */
describe('control lines are neither watches nor continuations', () => {
  it('an If with `then` is not a watch', () => {
    expect(isConditionalStep('If the Cash checkbox is ticked, then Pay with cash')).toBe(false);
    // …while the watch form is untouched.
    expect(isConditionalStep('If a Remember this device prompt appears, click Not now')).toBe(true);
  });

  it('the other five forms are not watches either', () => {
    for (const line of [
      'Else if the Card checkbox is ticked, then Pay by card',
      'Otherwise, Pay by card',
      'While the Next button is enabled, Go to the next page',
      'Repeat Click Load more until the Load more button is gone',
      'For each {{account}} in {{accounts}}, Check the account',
    ]) {
      expect(isConditionalStep(line), line).toBe(false);
    }
  });

  it('a claim that does not complete is still not a watch', () => {
    // It is a parse error everywhere it can be validated; where it cannot be,
    // it must at least not be polled for and performed as prose.
    expect(isConditionalStep('While the Next button is enabled')).toBe(false);
  });

  it('a control line after a watch forms NO group, so nothing is skipped', () => {
    const steps = [
      'If prompted for MFA, enter the code',
      'If the Cash checkbox is ticked, then Pay with cash',
      'Click Pay now',
    ];
    const groups = identifyStepGroups(steps);
    expect(groups.size).toBe(0);
  });

  it('a loop after a watch forms no group either', () => {
    const steps = [
      'If you see a cookie banner, dismiss it',
      'While the Next button is enabled, Go to the next page',
    ];
    expect(identifyStepGroups(steps).size).toBe(0);
  });

  it('a watch group after a control line still forms', () => {
    const steps = [
      'Otherwise, Pay by card',
      'If prompted for MFA, enter the code',
      'Wait for the dashboard',
    ];
    const groups = identifyStepGroups(steps);
    expect(groups.has(0)).toBe(false);
    expect(groups.get(1)?.continuationStep.index).toBe(2);
  });
});

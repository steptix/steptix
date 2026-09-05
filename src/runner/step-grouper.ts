/**
 * Step grouping for conditional lookahead.
 *
 * Detects conditional steps ("If prompted for MFA...", "If you see...") and
 * groups them with the next non-conditional step (the continuation / default
 * path). This allows the executor to present all possible outcomes to the AI
 * simultaneously rather than evaluating them sequentially.
 */
import { parseSetStep } from '../parser/set-step.js';

/** A single step reference within a group */
export interface GroupedStep {
  index: number;
  instruction: string;
}

/** A group of conditional steps + their continuation (default path) step */
export interface StepGroup {
  /** The conditional steps (e.g. "If prompted for MFA, enter code") */
  conditionalSteps: GroupedStep[];
  /** The follow-through step (e.g. "Wait for dashboard to load") */
  continuationStep: GroupedStep;
}

/**
 * Test whether a step instruction is conditional.
 *
 * Matches patterns like:
 * - "If prompted for..."
 * - "If asked to..."
 * - "If ... appears..."
 * - "If there is a..."
 * - "If you see..."
 * - "When prompted..."
 * - "When asked..."
 *
 * The regex is anchored to the start of the instruction (after stripping
 * any leading [prefix] markers like [output: x]).
 */
export function isConditionalStep(instruction: string): boolean {
  // Strip leading [prefix] markers
  const stripped = instruction.replace(/^\[.*?\]\s*/gi, '').trim();
  return /^(if\s|when\s(prompted|asked))/i.test(stripped);
}

/**
 * Scan a list of step instructions and identify conditional groups.
 *
 * Returns a Map keyed by step index → StepGroup. Every step that belongs to
 * a group has an entry pointing to the *same* StepGroup instance. Steps not
 * in any group are absent from the map.
 *
 * Grouping rules:
 * - Consecutive conditional steps are collected into one group.
 * - The first non-conditional step after a run of conditionals becomes the
 *   continuation step (the "else" / default path).
 * - A conditional at the very end of the step list (no continuation) gets a
 *   synthetic continuation that is a no-op.
 */
export function identifyStepGroups(steps: string[]): Map<number, StepGroup> {
  const map = new Map<number, StepGroup>();

  let i = 0;
  while (i < steps.length) {
    if (!isConditionalStep(steps[i]!)) {
      i++;
      continue;
    }

    // Collect consecutive conditional steps
    const conditionals: GroupedStep[] = [];
    while (i < steps.length && isConditionalStep(steps[i]!)) {
      conditionals.push({ index: i, instruction: steps[i]! });
      i++;
    }

    // An assignment cannot be a continuation, and the conditionals before it
    // therefore form NO GROUP AT ALL.
    //
    // A continuation is handed to `executeBranchedStep` for the MODEL to
    // perform if the conditional did not apply. `Set {{x}} to "…"` has no
    // model half, so swallowing it means the variable is never assigned and
    // the step costs a turn anyway — both halves of what this step form
    // exists to avoid (stories/variable-assignment.md).
    //
    // The obvious fix — a synthetic "no continuation" like the end-of-list
    // case — is WRONG, and shipping it was worse than the bug. Both loops
    // advance with `i = group.continuationStep.index` and then `i++`
    // (test-runner.ts, session-manager.ts), so a synthetic index of
    // `lastConditional + 1` — which is the assignment's own index — jumps
    // straight past it: the step vanished from the run, a model turn was
    // spent performing the placeholder string, and its result was filed under
    // the assignment's index. Declining to register the index did nothing,
    // because the skip is the jump, not the map.
    //
    // So: emit no group. The conditionals run as ordinary AI steps, which is
    // what they were before grouping existed, and the assignment runs as
    // itself. Nothing jumps, so nothing can be skipped.
    if (i < steps.length && parseSetStep(steps[i]!)) continue;

    let continuation: GroupedStep;
    if (i < steps.length) {
      continuation = { index: i, instruction: steps[i]! };
      i++; // consume the continuation step
    } else {
      // Conditional at end of test — synthetic no-op continuation
      continuation = {
        index: conditionals[conditionals.length - 1]!.index + 1,
        instruction: '(no continuation — all outcomes are conditional)',
      };
    }

    const group: StepGroup = {
      conditionalSteps: conditionals,
      continuationStep: continuation,
    };

    // Register every step in the group
    for (const cs of conditionals) {
      map.set(cs.index, group);
    }
    map.set(continuation.index, group);
  }

  return map;
}

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

    // The next non-conditional step is the continuation — unless it is an
    // assignment, which cannot be one.
    //
    // A continuation is handed to `executeBranchedStep` for the MODEL to
    // perform if the conditional did not apply. `Set {{x}} to "…"` has no
    // model half: swallowing it means the variable is silently never
    // assigned AND the step costs a turn, which is both halves of what this
    // step form exists to avoid (stories/variable-assignment.md). Found by
    // review, not by a test — the story claimed "no model call" for all four
    // loops without one.
    //
    // Treated as "no continuation", the same shape a conditional at the end
    // of the list already produces, so the assignment runs as an ordinary
    // step immediately after the group.
    let continuation: GroupedStep;
    /** False when the continuation is synthetic — nothing real to register. */
    let continuationIsRealStep = true;
    if (i < steps.length && !parseSetStep(steps[i]!)) {
      continuation = { index: i, instruction: steps[i]! };
      i++; // consume the continuation step
    } else if (i < steps.length) {
      // The assignment keeps its own index and must NOT be registered in the
      // map: both loops `continue` past any index that belongs to a group and
      // is not its first conditional, so registering it here would skip the
      // step outright — a worse bug than the swallow this guards against.
      continuation = {
        index: conditionals[conditionals.length - 1]!.index + 1,
        instruction: '(no continuation — the next step is an assignment)',
      };
      continuationIsRealStep = false;
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
    // Only a REAL continuation is registered. The end-of-list synthetic one
    // is past the last index so registering it was harmless; the assignment
    // case's synthetic index is a real step, and registering that would make
    // both loops skip it.
    if (continuationIsRealStep) map.set(continuation.index, group);
  }

  return map;
}

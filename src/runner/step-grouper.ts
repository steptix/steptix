/**
 * Step grouping for conditional lookahead.
 *
 * Detects conditional steps ("If prompted for MFA...", "If you see...") and
 * groups them with the next non-conditional step (the continuation / default
 * path). This allows the executor to present all possible outcomes to the AI
 * simultaneously rather than evaluating them sequentially.
 */
import { parseSetStep } from '../parser/set-step.js';
import { parseFlowControlStep } from '../parser/flow-control-step.js';
import { isControlLineClaim } from '../parser/control-line.js';

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
 *
 * A CONTROL line is never a watch, however it opens. `If a Remember this
 * device prompt appears, click Not now` is a watch and stays one; `If the Cash
 * checkbox is ticked, then Pay with cash` is a decision the framework makes
 * once, and grouping it here would hand it to `executeBranchedStep` — which
 * would poll for it to "appear" and then perform the whole line, tail
 * included, as prose. `then` is the opt-in, so the claim is the exclusion
 * (stories/control-flow.md §Grouper).
 */
export function isConditionalStep(instruction: string): boolean {
  // Strip leading [prefix] markers
  const stripped = instruction.replace(/^\[.*?\]\s*/gi, '').trim();
  // A flow-control step is never a conditional, even though it opens `If`
  // (stories/step-flow-control.md, decision 7). Grouping one would hand it to
  // `executeBranchedStep`, which runs the matched conditional AND the
  // continuation in a single call — so the very step the return exists to
  // skip would run immediately after it.
  //
  // Asked FIRST, before the control-line claim, because the two grammars
  // overlap on `If <condition>, then return`: flow control owns that line
  // everywhere it is asked (stories/control-flow.md §"Composition with
  // `If … then return`"). Both answers are `false` here, so the order is
  // documentation rather than behaviour — but it is the order every other
  // caller uses, and a reader who finds the two the other way round somewhere
  // else should treat that as the bug.
  if (parseFlowControlStep(stripped)) return false;
  if (isControlLineClaim(stripped)) return false;
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
    //
    // A flow-control step takes the SAME exemption, for the same reason
    // (stories/step-flow-control.md, decision 7). `isConditionalStep` already
    // refuses to collect one as a conditional; this is the other half —
    // swallowing it as the CONTINUATION would jump `i` past it, so the step
    // that was meant to end the flow would never run and the steps it was
    // meant to skip would all run instead. A green report for work that did
    // not happen is the one failure direction this codebase treats as worst,
    // and this is the shape that produces it.
    //
    // A CONTROL line is excluded on exactly the same terms, and it is the
    // same bug wearing a third keyword: `executeBranchedStep` would perform
    // `If the Cash checkbox is ticked, then Pay with cash` as the model's
    // fallback action, so the decision would never be made, the section would
    // never dispatch — and both loops advance past a group with
    // `i = group.continuationStep.index`, so the guard AND its whole tail
    // would vanish from the run. No synthetic continuation for any of the
    // three: the fix is to form no group, so nothing jumps.
    if (i < steps.length && parseSetStep(steps[i]!)) continue;
    if (i < steps.length && parseFlowControlStep(steps[i]!)) continue;
    if (i < steps.length && isControlLineClaim(steps[i]!.replace(/^\[.*?\]\s*/gi, ''))) {
      continue;
    }

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

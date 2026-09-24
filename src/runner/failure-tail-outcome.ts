import type { StepResult } from '../report/types.js';
import type { ParsedFailureTail } from '../parser/failure-tail.js';

/**
 * What an `otherwise …` tail does to a step that has finally failed
 * (stories/step-failure-outcomes.md, decisions 5 and 6), with the message
 * already resolved and masked by the caller.
 *
 * Lifted out of `applyFailureTail` (step-executor.ts) so that a step which
 * never reaches the executor — a `[use ai]` step (stories/use-ai-step.md,
 * decision 10) — renames and tolerates its failure in exactly the executor's
 * words, without importing the executor (and Playwright with it) into a
 * module that has no page. `applyFailureTail` is now this plus the
 * executor's own way of finding the message; a second copy of the rule is how
 * the two would start disagreeing about what "otherwise continue" means.
 *
 * What it does NOT touch, and why: a PASSED step (the tail describes a
 * failure; there isn't one), an INTERRUPTED one (the user ended the run), the
 * ERROR of a `continue` tail (it stays the framework's, so the row still says
 * what went wrong), and a message-less `otherwise fail` (legal, changes
 * nothing).
 */
export function applyTailOutcome(
  result: StepResult,
  tail: ParsedFailureTail | null | undefined,
  /** The tail's message, `{{…}}` resolved and secrets masked — the caller's
   *  job, because each caller resolves against a different map. */
  message: string | undefined,
): StepResult {
  if (!tail) return result;
  if (result.status !== 'failed' || result.interrupted) return result;

  const original = result.error ?? 'the step failed';

  if (tail.outcome === 'fail') {
    if (!message) return result;
    return {
      ...result,
      error: message,
      aiExplanation: `Failed as the step says. What failed: ${original}`,
    };
  }

  const warning = message ? message : undefined;
  return {
    ...result,
    tolerated: true,
    // Structural as well as folded into the explanation, for the reason the
    // docblock on `StepResult.warning` gives: the explanation does not travel on
    // the `step:fail` wire event and the warning has to — it is the first line of
    // the TestBench hover and the MCP row's reason.
    ...(warning !== undefined && { warning }),
    aiExplanation: warning
      ? `${warning}. The run continued past this step (otherwise continue). What failed: ${original}`
      : `The run continued past this step (otherwise continue). What failed: ${original}`,
  };
}

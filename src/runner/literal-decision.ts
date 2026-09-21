/**
 * One condition, decided from its own text — or null, meaning "ask the page"
 * (docs/specs/SPEC-structured-table-reads.md §8.3a).
 *
 * ## Why this is a module rather than a function in one caller
 *
 * There are TWO places a condition written by an author is judged, and until
 * this existed only one of them could decide anything locally:
 *
 *  - a control line's condition — an `If` chain, a `While`, a `Repeat … until`
 *    — visited by `evaluateGuard` (control-runtime.ts);
 *  - a FLOW-CONTROL line's condition — `If {{payment.status}} is "Overdue",
 *    then return`, `… then stop`, `… then fail the test with error "…"` —
 *    claimed at rung 0 of `parseControlLine` and therefore never a guard at
 *    all. It is judged inside the step, by the step's own model turn
 *    (step-executor.ts).
 *
 * The second is the spec's headline example: §8.3a opens with exactly that
 * line, and `templates/init/tests/table-payments-review.md` and
 * `-approve.md` are built on it. Leaving it on the model path meant the
 * feature's own acceptance tests paid a `settle` wait and an `ai.complete` on
 * every pass of every row — and kept the wrong-answer risk the whole local
 * path exists to remove, in the place most likely to meet it.
 *
 * So the rule lives here, once, and both callers import it. A rule that lives
 * in one of two judges is a rule the other one gets wrong.
 *
 * ## The rule, in full
 *
 * 1. The AUTHORED condition must make at least one `{{…}}` or `${…}`
 *    reference. `If "Welcome back" is empty` parses perfectly and answers
 *    `false` from its own characters with no page look at all — but it is a
 *    sentence ABOUT THE PAGE that happens to be spelled with quotes, and the
 *    grammar cannot tell the two apart. Only the author can, by having written
 *    a reference.
 * 2. Every reference is substituted as a QUOTED literal, because the grammar
 *    reads values and not bare words ({@link substituteAsLiterals}).
 * 3. A value that cannot be spelled as a literal — one holding a `"` — is not
 *    guessed at: the condition goes to the judge, exactly as before.
 * 4. The result must parse under {@link parseLiteralCondition}, which is
 *    deliberately small (src/parser/literal-condition.ts).
 * 5. The reasoning carries VALUES, so it is redacted before it is returned.
 *    Neither judge path ever had that problem: both were handed the
 *    unsubstituted text.
 */

import { parseLiteralCondition } from '../parser/literal-condition.js';
import { substituteAsLiterals, type PlaceholderValues } from './placeholder-substitution.js';

/** A condition this module answered. */
export interface LocalDecision {
  /** The substituted, quoted text it was decided from — ALREADY REDACTED, so
   *  a caller can put it straight into a log line, a report row or a wire
   *  event. */
  text: string;
  holds: boolean;
  /** The sentence that stands in for the model's reasoning. */
  reasoning: string;
}

/**
 * Decide `condition` from this run's values, or return null to ask the page.
 *
 * Null is the safe answer and the common one: it means "today's behaviour,
 * exactly". Every reason to return null is a reason the text does not contain
 * the answer.
 *
 * `redactText` is the caller's masker — each run loop and the executor build
 * their own, and the server's counts frame inputs as well as the parameter
 * map, so it is passed in rather than derived here.
 */
export function decideConditionLocally(
  condition: string,
  values: PlaceholderValues,
  redactText: (text: string) => string,
): LocalDecision | null {
  const { text, references, unspellable } = substituteAsLiterals(condition, values);
  if (references === 0) return null;
  if (unspellable) return null;
  const literal = parseLiteralCondition(text);
  if (!literal) return null;
  const masked = redactText(text);
  return { text: masked, holds: literal.holds, reasoning: localReasoning(masked, literal.holds) };
}

/**
 * The sentence a locally decided condition carries in place of the model's.
 *
 * One place, so a guard row, a returning step's explanation, the run log and
 * the tests cannot drift over its wording. The text is expected to be masked
 * already — {@link decideConditionLocally} is the only caller that should be
 * building one from scratch.
 */
export function localReasoning(condition: string, holds: boolean): string {
  return `decided from the values: ${condition} → ${holds}`;
}

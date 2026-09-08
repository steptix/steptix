/**
 * `If … then return` / `… then stop` — the one step form that ends the flow it
 * is in as a PASS (stories/step-flow-control.md).
 *
 * The line claims the form; the model judges the condition. That split is the
 * whole safety argument (story decision 2): this parser is textual, runs
 * before anything else on the AUTHORED line, and is the same answer in every
 * runner. The executor honours a `return` action only on a step this function
 * accepted — without that guard a model could end a test early from any line
 * and the report would be green for work not done.
 *
 * Import-free, like `set-step.ts` beside it, so a client mirror suite can load
 * it under Node's type stripping.
 *
 * There is deliberately **no parse-error family** here, and that is the one
 * way this differs from `Set {{x}} to`. No prefix of this form is a claim —
 * `If the page shows a banner` is ordinary prose right up until the tail
 * completes — so a line that does not complete the tail is prose, not a
 * diagnostic. `If … then retun` therefore loses its return, and the story
 * accepts that: a missed return fails loudly downstream (the steps it should
 * have skipped run and fail), whereas a return that fired when it should not
 * would pass a run that did no work. The grammar errs towards missing.
 */

export interface ParsedFlowControlStep {
  /** Both verbs mean the same thing — leave the innermost flow (decision 1).
   *  Kept so a report and a code-behind generator can echo what was written. */
  verb: 'return' | 'stop';
  /**
   * The text between the `If`/`When` head and the joiner; absent for the
   * unconditional form. Diagnostics and the report only — the model reads the
   * whole line, and the presence/absence of this field is what tells a runner
   * whether the step needs a model turn at all.
   */
  body?: string;
}

/**
 * The whole grammar, in one anchored expression (story decision 5):
 *
 * ```
 * tail   := (return | stop) [ here | running the (rest of the | remaining | below | following)? steps ]
 * joiner := "," [then | and]  |  then  |  and
 * line   := tail                              -- unconditional
 *         | (if | when) <body> <joiner> tail  -- conditional, body non-empty
 * ```
 *
 * `<body>` is lazy and the expression is anchored at both ends, so the engine
 * settles on the LAST joiner that still leaves a complete tail behind it. That
 * is what makes a compound body work: in `If the Save button is visible, click
 * it and return` the comma is tried first, `click it and return` fails as a
 * tail, and the match backtracks to the `and` — body `the Save button is
 * visible, click it`, tail `return`.
 *
 * The `$` anchor is equally load-bearing in the other direction: `then return
 * to the dashboard` leaves `to the dashboard` unmatched, so it stays prose and
 * reads as "navigate back", which is what an author means by it.
 */
const FLOW_CONTROL_RE =
  /^(?:(?:if|when)\s+(.+?)(?:\s*,\s*(?:then\s+|and\s+)?|\s+then\s+|\s+and\s+))?(return|stop)(?:\s+here|\s+running\s+the(?:\s+(?:rest\s+of\s+the|remaining|below|following))?\s+steps)?$/i;

/** The `[no-hooks]` prefix, matching `NO_HOOKS_MARKER` in section-match.ts.
 *  Duplicated rather than imported to keep this module import-free — the same
 *  trade `set-step.ts` makes, and for the same mirror-suite reason. */
const NO_HOOKS_PREFIX = /^\[no-hooks\]\s*/i;

/**
 * The instruction as the grammar sees it: trimmed, marker removed, one
 * trailing `.` dropped.
 *
 * Exactly ONE full stop, not `/\.+$/`: `Return...` is an author trailing off,
 * not an instruction, and an ellipsis that quietly became a return would be
 * the silent direction this feature refuses to fail in.
 */
function normalise(instruction: string): string {
  return instruction
    .trim()
    .replace(NO_HOOKS_PREFIX, '')
    .trim()
    .replace(/\.$/, '')
    .trim();
}

/**
 * `{ verb, body? }` when the line is a flow-control step, or null when it is
 * ordinary prose.
 *
 * Matched against the step as AUTHORED, before `{{…}}` interpolation — a
 * conditional body may hold placeholders, and the claim must be the same
 * answer on every run and in every runner regardless of what they hold.
 */
export function parseFlowControlStep(instruction: string): ParsedFlowControlStep | null {
  const match = FLOW_CONTROL_RE.exec(normalise(instruction));
  if (!match) return null;
  const verb = match[2]!.toLowerCase() as 'return' | 'stop';
  const body = match[1]?.trim();
  // A body that is present but empty cannot happen under the grammar (`.+?`),
  // but a caller reads `body === undefined` to mean "unconditional", so an
  // empty string must never reach it as a claim of conditionality.
  return body ? { verb, body } : { verb };
}

/**
 * Hooks may not return (story decision 8).
 *
 * There is no flow to leave from inside a hook, and inventing one would mean
 * deciding whether it ends the hook scope, the step it wraps, or the run —
 * three defensible answers, which is the signature of a rule nobody should
 * have to guess. So it is refused in all three places a hook line can arrive:
 * `## Hooks` at parse, project `defaultHooks` at config load, and — the one
 * neither of those sees — a `[skill: …]` used as a default hook, whose body is
 * read by the CLI's hook loop at run time.
 *
 * One sentence for all three, so the reader who meets it in a run log and the
 * one who meets it in a parse error are reading the same rule.
 */
export const FLOW_CONTROL_IN_HOOK = 'flow control is not allowed in hooks';

/**
 * The refusal, naming the line. `where` is appended verbatim (e.g.
 * ` in tests/foo.md`), the way `setStepError`'s is.
 */
export function flowControlInHookError(instruction: string, where = ''): string {
  return (
    `${FLOW_CONTROL_IN_HOOK}: "${instruction.trim()}"${where}. A hook runs ` +
    `around a step rather than inside a flow, so there is nothing for it to ` +
    `return from. Move the line into \`## Steps\`, or into the section or ` +
    `skill body it should end.`
  );
}

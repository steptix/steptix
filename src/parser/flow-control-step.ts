/**
 * `If … then return` / `… then stop` — the one step form that ends the flow it
 * is in as a PASS (stories/step-flow-control.md) — and `If … then fail`, the
 * third verb, which ends the RUN with the author's own message
 * (stories/step-failure-outcomes.md, decision 1).
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

/**
 * What the line claimed — a union rather than one shape with an optional
 * `message`, because the two halves do opposite things: `return` / `stop` end
 * the flow as a PASS, `fail` ends the run as a FAILURE
 * (stories/step-failure-outcomes.md, decision 1). The compiler then finds every
 * site that switches on `verb`, so none can quietly paint green over a failure
 * the author asked for.
 */
export type ParsedFlowControlStep =
  | {
      /** Both verbs mean the same thing — leave the innermost flow
       *  (stories/step-flow-control.md, decision 1). Kept so a report and a
       *  code-behind generator can echo what was written. */
      verb: 'return' | 'stop';
      /**
       * The text between the `If`/`When` head and the joiner; absent for the
       * unconditional form. Diagnostics and the report only — the model reads
       * the whole line, and the presence/absence of this field is what tells a
       * runner whether the step needs a model turn at all.
       */
      body?: string;
    }
  | {
      /** Fail the run deliberately, in the author's words
       *  (stories/step-failure-outcomes.md, decision 1). */
      verb: 'fail';
      /** As above: absent for the unconditional `Fail the test with …`, which
       *  the run loops dispatch with no model call at all. */
      body?: string;
      /** The text inside the quotes of `with error "…"`, verbatim and
       *  un-interpolated. Absent when no `with … "…"` part was written, which is
       *  legal: a message-less `fail` is the same grammar with the framework
       *  wording the error (decision 3). */
      message?: string;
    };

/**
 * True for the two verbs that LEAVE a flow — the ones hooks refuse
 * (stories/step-failure-outcomes.md, decision 7). `fail` is allowed in a hook
 * because a hook can already fail the run: the verb adds a message, not a
 * power. The three refusal sites share this one predicate so they cannot drift
 * apart.
 */
export function isReturnClaim(
  claim: ParsedFlowControlStep,
): claim is { verb: 'return' | 'stop'; body?: string } {
  return claim.verb !== 'fail';
}

/**
 * The return/stop half of the grammar, in one anchored expression
 * (stories/step-flow-control.md, decision 5). UNCHANGED by
 * stories/step-failure-outcomes.md — the `fail` verb is {@link FAIL_RE} below,
 * and this table stays exactly as it was frozen:
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

/**
 * The `fail` tail, as a regex SOURCE fragment
 * (stories/step-failure-outcomes.md §"The grammar"):
 *
 * ```
 * quoted    := "…" | '…'                    -- no nested quote of the same kind
 * fail-tail := fail [the | this] [test | run]
 *              [with [the] [error | message | reason] quoted]
 * ```
 *
 * Exported, and a string rather than a `RegExp`, because `failure-tail.ts`
 * needs the SAME tail as the outcome of an `otherwise`: `Click Save otherwise
 * fail the test with message "…"` and `If x then fail the test with message
 * "…"` are one grammar written twice, and a second copy would drift silently.
 *
 * It contributes exactly TWO capture groups, in this order: the double-quoted
 * message and the single-quoted one — a consumer splicing it into a larger
 * expression has to count them.
 *
 * The quote bodies are `[^"]*` / `[^']*`: a message may hold the OTHER quote
 * (`with error "can't find it"`), never its own, and an unterminated quote
 * leaves the whole `with …` part unmatched, so the `$` anchor turns `fail the
 * test with error "x` into prose rather than a truncated message.
 *
 * Three named fragments because the bare-space joiner's rule is stated in terms
 * of them — it wants a tail with the NOUN or the MESSAGE (see {@link FAIL_RE}).
 */
const FAIL_TAIL_ARTICLE = '(?:\\s+(?:the|this))?';
const FAIL_TAIL_NOUN = '(?:\\s+(?:test|run))?';
const FAIL_TAIL_MESSAGE =
  '(?:\\s+with(?:\\s+the)?(?:\\s+(?:error|message|reason))?\\s+(?:"([^"]*)"|\'([^\']*)\'))?';

export const FAIL_TAIL_SOURCE = 'fail' + FAIL_TAIL_ARTICLE + FAIL_TAIL_NOUN + FAIL_TAIL_MESSAGE;

/**
 * The `fail` tail carrying NEITHER the noun nor the message — a bare `fail`, or
 * `fail the` / `fail this` with nothing behind it. The one shape the bare-space
 * joiner may not have in front of it; see {@link FAIL_RE}.
 *
 * Tested against the whole normalised line, which is exact because the
 * expression it complements is `$`-anchored: a tail with the noun ends in
 * `test` / `run`, one with a message ends in a quote, and only these two end in
 * the verb or its article. The leading `\s` is the joiner the guard is about, so
 * it can never match an unconditional `Fail`, which keeps the grammar it had.
 */
const PLAIN_FAIL_TAIL_RE = new RegExp(`\\sfail${FAIL_TAIL_ARTICLE}$`, 'i');

/**
 * The conditional `fail` line, in the same anchored/lazy shape as
 * {@link FLOW_CONTROL_RE} above and with ONE difference: a bare space is a
 * joiner here.
 *
 * `If {{a}} is "peanuts" fail the test with error "…"` is how people write it,
 * and a `fail …` tail is distinctive enough that a space in front of it is not a
 * claim a body makes by accident, whereas `If the page shows Save return` is —
 * so `return` / `stop` keep the explicit joiners they always had.
 *
 * That is a property of the TAIL, not the verb: the bare space is a joiner only
 * in front of a tail carrying a NOUN (`fail the test`) or a MESSAGE (`fail with
 * error "…"`). Measured trap without the rule — `When I submit with bad data,
 * the save should fail` parsed as a conditional claim whose "condition" was `I
 * submit with bad data, the save should`, so a BDD-style expectation became a
 * claim and the run went red precisely when it was MET.
 *
 * Enforced after the match rather than inside the expression, and soundly: for
 * the guard to fire the line must END in the bare tail, so any real joiner would
 * have to sit inside the verb — there is never a longer-body match with a real
 * joiner for the refusal to throw away.
 *
 * Alternation order is load-bearing as above: `then` and `and` are tried before
 * the bare space, so `If the Save button is visible, click it and fail` keeps
 * `and` as the joiner rather than swallowing it into the body.
 *
 * Groups: 1 = body, 2 = the joiner itself (read by the rule above), 3 =
 * double-quoted message, 4 = single-quoted message.
 */
const FAIL_RE = new RegExp(
  '^(?:(?:if|when)\\s+(.+?)' +
    '(\\s*,\\s*(?:then\\s+|and\\s+)?|\\s+then\\s+|\\s+and\\s+|\\s+)' +
    ')?' +
    FAIL_TAIL_SOURCE +
    '$',
  'i',
);

/** True when the joiner a match used was bare whitespace — the one that has to
 *  earn its tail. Every other alternative of {@link FAIL_RE}'s joiner group
 *  contains a comma, `then` or `and`. */
function isBareSpaceJoiner(joiner: string | undefined): boolean {
  return joiner !== undefined && /^\s+$/.test(joiner);
}

/**
 * A body that ENDS in the head of an `otherwise` tail — the second hole the
 * bare-space joiner opens, and the one that costs a whole feature.
 *
 * `If the banner is visible, dismiss it, otherwise fail the test with message
 * "No banner"` is a step with a tail (failure-tail.ts), but the expression above
 * reads it as a CONDITIONAL FAIL whose condition is `…dismiss it, otherwise` —
 * so the line claims the form, wins rung 0, is exempted from grouping, and the
 * body never runs at all. The same shape hides decision 8's contradiction, so
 * the raw Sessions API path — whose only refusal is the executor reading this
 * parse — would silently get one of the two halves.
 *
 * Refused rather than resolved, in the same direction as the joiner-only bodies
 * below: a `fail` that fires when it should not is a red run for nothing. The
 * trailing comma is allowed for because the tail grammar punctuates its head on
 * both sides.
 */
const TAIL_HEAD_AT_BODY_END_RE =
  /\b(?:otherwise|or\s+else|if\s+(?:it|that|this)\s+fails)\s*,?$/i;

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
  const normalised = normalise(instruction);

  const match = FLOW_CONTROL_RE.exec(normalised);
  if (match) {
    const verb = match[2]!.toLowerCase() as 'return' | 'stop';
    const body = match[1]?.trim();
    // A body that is present but empty cannot happen under the grammar (`.+?`),
    // but a caller reads `body === undefined` to mean "unconditional", so an
    // empty string must never reach it as a claim of conditionality.
    return body ? { verb, body } : { verb };
  }

  // `fail` is a second expression rather than a third alternative inside the
  // first, because its joiner set differs (the bare space) and its tail carries
  // a message. The verbs are disjoint, so the two can never both match and the
  // frozen table above stays untouched.
  const failMatch = FAIL_RE.exec(normalised);
  if (!failMatch) return null;
  const body = failMatch[1]?.trim();
  // The head matched and left no usable condition — `If then fail`, `If  fail`;
  // the bare-space joiner lets the joiner WORD itself be read as the body, where
  // `If then return` simply finds no joiner and stays prose. Refused rather than
  // read as UNCONDITIONAL, which is the shape an empty body would take: an
  // unconditional `fail` ends the run with no model call, so a missing condition
  // would become a certainty rather than a question.
  if (failMatch[1] !== undefined && (body === '' || /^(?:then|and)$/i.test(body!))) return null;
  // …and the body that ends where an `otherwise` tail's head begins, the same
  // hole from the other end — see {@link TAIL_HEAD_AT_BODY_END_RE}.
  if (body && TAIL_HEAD_AT_BODY_END_RE.test(body)) return null;
  // …and a bare space in front of a tail that is nothing but the verb: `the save
  // should fail` is prose, not a claim — see {@link FAIL_RE}.
  if (isBareSpaceJoiner(failMatch[2]) && PLAIN_FAIL_TAIL_RE.test(normalised)) return null;
  // `??` not `||`: an absent `with …` part must not arrive as `''` and be
  // mistaken for a message that was written.
  const message = failMatch[3] ?? failMatch[4];
  return {
    verb: 'fail',
    ...(body ? { body } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

/**
 * Hooks may not return (stories/step-flow-control.md, decision 8), though
 * since stories/step-failure-outcomes.md decision 7 they MAY fail — the three
 * refusal sites gate on {@link isReturnClaim}, not on the parse.
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

/**
 * The client-side mirror of the six control-flow step forms
 * (stories/control-flow.md §Syntax; the original is
 * `src/parser/control-line.ts`).
 *
 * runner-core cannot import `src/` — it is bundled into the extensions and the
 * CLI is not a dependency — so the regexes below are a hand copy, kept honest
 * by `tests/control-line-parity.test.ts`, which feeds one corpus to both
 * implementations and compares every field. Adding a form, or moving a split,
 * means editing both files; the parity test is what says so out loud.
 *
 * What the client needs this for is narrower than what the CLI needs: the
 * TAIL of a control line is a section call site (contract §2.4's new clause),
 * so `section-index.ts` needs the tail's text AND the column it starts at, to
 * underline the section name rather than the keyword. Hence `tailStart` on the
 * result — the original exports the same offset from `parseControlLineAt` so
 * the two can be compared.
 *
 * Deliberately NOT mirrored: `controlLineError`. Diagnostics for a claimed-
 * but-incomplete line are the CLI parser's job; the client's job is to know
 * what resolves, and an unparseable control line resolves to nothing, which
 * is what `parseControlLine` returning null already says.
 */

export type ControlLine =
  | { kind: 'if' | 'elseif'; condition: string; tail: string }
  | { kind: 'else'; tail: string }
  | { kind: 'while'; condition: string; tail: string; cap?: number }
  | { kind: 'repeat'; condition: string; tail: string; cap?: number }
  | { kind: 'foreach'; item: string; list: string; tail: string };

export type ControlKind = ControlLine['kind'];

/** A parsed control line plus the 0-based offset of its tail within the
 *  normalised (trimmed, `[no-hooks]`-stripped) instruction. */
export type ControlLineHit = ControlLine & { tailStart: number };

/** Matches `NO_HOOKS_MARKER` in section-match.ts — duplicated to keep this
 *  module import-free, exactly as the original does. */
const NO_HOOKS_PREFIX = /^\[no-hooks\]\s*/i;

function normalise(instruction: string): string {
  return instruction.trim().replace(NO_HOOKS_PREFIX, '').trim();
}

/**
 * The flow-control grammar's whole-line shape — a hand copy of
 * `FLOW_CONTROL_RE` in `src/parser/flow-control-step.ts`, which runner-core
 * cannot import any more than it can import the module this file mirrors.
 *
 * `If the page title contains "Dashboard" then return` is claimed by both
 * grammars, and flow control wins it (stories/control-flow.md §"Composition
 * with `If … then return`"). The CLI parser decides that by calling
 * `parseFlowControlStep`; here it is a second copy, and
 * `tests/control-line-parity.test.ts` is what keeps the two agreeing — the
 * corpus carries `If X, then return`, `then stop here`, `then stop running the
 * remaining steps`, `then Return` and the near miss `then return to the
 * dashboard`, which the `$` anchor leaves as an ordinary chain. The third
 * verb, `fail`, is {@link FAIL_RE} below.
 *
 * Only the *whole-line* claim matters to this file, so the captures are
 * dropped: what a caller here needs to know is that the line is not a control
 * line, never what verb it used.
 */
const FLOW_CONTROL_RE =
  /^(?:(?:if|when)\s+(?:.+?)(?:\s*,\s*(?:then\s+|and\s+)?|\s+then\s+|\s+and\s+))?(?:return|stop)(?:\s+here|\s+running\s+the(?:\s+(?:rest\s+of\s+the|remaining|below|following))?\s+steps)?$/i;

/**
 * The grammar's third verb — a hand copy of `FAIL_RE` in
 * `src/parser/flow-control-step.ts` (stories/step-failure-outcomes.md,
 * decision 1), separate here because it is separate there: its joiner set has one
 * more member, and that is why it cannot fold into the expression above. A bare
 * SPACE joins a body to a `fail` tail carrying a noun or a message (`If {{a}} is
 * "peanuts" fail the test with error "…"`) and never joins one to a `return`, so
 * `If x fail the test` is flow control and `If x return here` is an ordinary
 * chain — `tests/control-line-parity.test.ts` carries both.
 *
 * The message capture is dropped, as above. The BODY and the JOINER are kept,
 * because the original refuses an empty or joiner-only body and a bare-space
 * joiner in front of a bare `fail`, and this copy has to refuse the same lines.
 *
 * Groups: 1 = body, 2 = joiner.
 */
const FAIL_RE =
  /^(?:(?:if|when)\s+(.+?)(\s*,\s*(?:then\s+|and\s+)?|\s+then\s+|\s+and\s+|\s+))?fail(?:\s+(?:the|this))?(?:\s+(?:test|run))?(?:\s+with(?:\s+the)?(?:\s+(?:error|message|reason))?\s+(?:"(?:[^"]*)"|'(?:[^']*)'))?$/i;

/** A `fail` body that is nothing but a joiner word — the hole the bare-space
 *  joiner opens, refused identically in `parseFlowControlStep`. */
const JOINER_ONLY_BODY_RE = /^(?:then|and)$/i;

/** A joiner that is nothing but whitespace — every other alternative of
 *  {@link FAIL_RE}'s joiner group carries a comma, `then` or `and`. */
const BARE_SPACE_JOINER_RE = /^\s+$/;

/** A line whose `fail` tail carries NEITHER the noun (`the test` / `the run`) nor
 *  a message — the hole that claimed ordinary prose: `When I submit with bad
 *  data, the save should fail` is an expectation, not a step that ends the run.
 *  Refused identically in `parseFlowControlStep`, where the reasoning is written
 *  out. */
const PLAIN_FAIL_TAIL_RE = /\sfail(?:\s+(?:the|this))?$/i;

/** A `fail` body that ends where an `otherwise` tail's head begins — `If the
 *  banner is visible, dismiss it, otherwise fail the test with message "…"` is a
 *  step with a failure tail, not a conditional `fail`. Refused identically in
 *  `parseFlowControlStep`, where the reasoning is written out. */
const TAIL_HEAD_AT_BODY_END_RE =
  /\b(?:otherwise|or\s+else|if\s+(?:it|that|this)\s+fails)\s*,?$/i;

/** True when the flow-control grammar claims the whole line. The trailing
 *  full stop comes off here, matching `normalise` in `flow-control-step.ts`;
 *  exactly one, so `Return...` stays prose. */
export function isFlowControlLine(instruction: string): boolean {
  const s = normalise(instruction).replace(/\.$/, '').trim();
  if (FLOW_CONTROL_RE.test(s)) return true;
  const fail = FAIL_RE.exec(s);
  if (!fail) return false;
  // `If then fail` matched and left no condition, so the original answers null and
  // this has to as well — otherwise the editor stops underlining a diagnostic the
  // CLI still throws.
  const body = fail[1]?.trim();
  if (fail[1] !== undefined && (body === '' || JOINER_ONLY_BODY_RE.test(body!))) return false;
  if (body && TAIL_HEAD_AT_BODY_END_RE.test(body)) return false;
  if (fail[2] !== undefined && BARE_SPACE_JOINER_RE.test(fail[2]) && PLAIN_FAIL_TAIL_RE.test(s)) {
    return false;
  }
  return true;
}

/** `Else if` / `Otherwise if`, with NO comma between the two words — the comma
 *  is what makes `Otherwise, if the banner appears, dismiss it` an `Otherwise`
 *  whose tail is a watch step. */
const ELSE_IF_HEAD_RE = /^(?:else|otherwise)\s+if\b/i;
/** `Else` / `Otherwise` at line start: a claim on its own. */
const ELSE_HEAD_RE = /^(?:else|otherwise)\b/i;
/** `If` at line start — NOT a claim without a later ` then ` (the watch form
 *  opens the same way). */
const IF_HEAD_RE = /^if\b/i;
/** `While` at line start: a claim on its own. */
const WHILE_HEAD_RE = /^while\b/i;
/** `Repeat` at line start — NOT a claim without a later ` until `. */
const REPEAT_HEAD_RE = /^repeat\b/i;
/** `For each {{` — the braces claim. */
const FOREACH_CLAIM_RE = /^for\s+each\s+\{\{/i;

/** The first ` then `, comma optional, ends an `If` / `Else if` condition. */
const THEN_SPLIT_RE = /,?\s+then\s+/i;
/** The first ` until ` ends a `Repeat` tail. */
const UNTIL_SPLIT_RE = /\s+until\s+/i;
/** `, up to N times` at the end of a `While` / `Repeat` line. `\d+`, so a cap
 *  of 0 is matched and REFUSED rather than left on the tail. */
const CAP_RE = /,\s*up\s+to\s+(\d+)\s+times\s*$/i;
/** The complete `For each` shape. */
const FOREACH_RE =
  /^for\s+each\s+\{\{([A-Za-z_]\w*)\}\}\s+in\s+\{\{([A-Za-z_]\w*)\}\}\s*,\s*(\S.*)$/i;

/** Which of the six forms this line claimed, or null. */
export function claimedControlForm(instruction: string): ControlKind | null {
  const s = normalise(instruction);

  // Rung 0: flow control wins the overlap — see `isFlowControlLine`.
  if (isFlowControlLine(s)) return null;

  if (ELSE_IF_HEAD_RE.test(s)) return 'elseif';
  if (ELSE_HEAD_RE.test(s)) return 'else';

  const ifHead = IF_HEAD_RE.exec(s);
  if (ifHead) return THEN_SPLIT_RE.test(s.slice(ifHead[0].length)) ? 'if' : null;

  if (WHILE_HEAD_RE.test(s)) return 'while';

  const repeatHead = REPEAT_HEAD_RE.exec(s);
  if (repeatHead) {
    const rest = s.slice(repeatHead[0].length).replace(CAP_RE, '');
    return UNTIL_SPLIT_RE.test(rest) ? 'repeat' : null;
  }

  if (FOREACH_CLAIM_RE.test(s)) return 'foreach';
  return null;
}

/** True when the line opens one of the six forms, complete or not. */
export function isControlLineClaim(instruction: string): boolean {
  return claimedControlForm(instruction) !== null;
}

/** The parsed control line, or null when the line is not one (including a
 *  line that claimed a form and failed to complete it). */
export function parseControlLine(instruction: string): ControlLineHit | null {
  const s = normalise(instruction);

  // Rung 0: flow control wins the overlap — see `isFlowControlLine`. So a
  // `then return` tail is not a section call site, and `section-index.ts` will
  // not underline `return` as a near miss.
  if (isFlowControlLine(s)) return null;

  const elseIfHead = ELSE_IF_HEAD_RE.exec(s);
  if (elseIfHead) return conditionThenTail(s, elseIfHead[0].length, 'elseif');

  const elseHead = ELSE_HEAD_RE.exec(s);
  if (elseHead) {
    const rest = s.slice(elseHead[0].length);
    const m = /^\s*,?\s*/.exec(rest)!;
    const tailStart = elseHead[0].length + m[0].length;
    const tail = s.slice(tailStart).trim();
    if (tail === '') return null;
    return { kind: 'else', tail, tailStart };
  }

  const ifHead = IF_HEAD_RE.exec(s);
  if (ifHead) return conditionThenTail(s, ifHead[0].length, 'if');

  const whileHead = WHILE_HEAD_RE.exec(s);
  if (whileHead) {
    const { body, cap } = stripCap(s.slice(whileHead[0].length));
    if (cap === 'invalid') return null;
    const comma = body.indexOf(',');
    if (comma < 0) return null;
    const condition = body.slice(0, comma).trim();
    const tailOffset = firstNonSpace(body, comma + 1);
    const tail = body.slice(comma + 1).trim();
    if (condition === '' || tail === '') return null;
    return {
      kind: 'while',
      condition,
      tail,
      ...(cap !== undefined && { cap }),
      tailStart: whileHead[0].length + tailOffset,
    };
  }

  const repeatHead = REPEAT_HEAD_RE.exec(s);
  if (repeatHead) {
    const { body, cap } = stripCap(s.slice(repeatHead[0].length));
    if (cap === 'invalid') return null;
    const m = UNTIL_SPLIT_RE.exec(body);
    if (!m) return null;
    const tailOffset = firstNonSpace(body, 0);
    const tail = body.slice(0, m.index).trim();
    const condition = body.slice(m.index + m[0].length).trim();
    if (tail === '' || condition === '') return null;
    return {
      kind: 'repeat',
      condition,
      tail,
      ...(cap !== undefined && { cap }),
      tailStart: repeatHead[0].length + tailOffset,
    };
  }

  if (FOREACH_CLAIM_RE.test(s)) {
    if (CAP_RE.test(s)) return null;
    const m = FOREACH_RE.exec(s);
    if (!m) return null;
    const tail = m[3]!.trim();
    if (tail === '') return null;
    return {
      kind: 'foreach',
      item: m[1]!,
      list: m[2]!,
      tail,
      tailStart: s.length - m[3]!.length,
    };
  }

  return null;
}

function conditionThenTail(
  s: string,
  headLength: number,
  kind: 'if' | 'elseif',
): ControlLineHit | null {
  // Not trimmed before the search, so `If then do x` finds its ` then ` at
  // offset 0 and reports an empty condition (null here) rather than falling
  // through to prose.
  const rest = s.slice(headLength);
  const m = THEN_SPLIT_RE.exec(rest);
  if (!m) return null;
  const condition = rest.slice(0, m.index).trim();
  const tailStart = headLength + m.index + m[0].length;
  const tail = s.slice(tailStart).trim();
  if (condition === '' || tail === '') return null;
  return { kind, condition, tail, tailStart };
}

function stripCap(rest: string): { body: string; cap?: number | 'invalid' } {
  const m = CAP_RE.exec(rest);
  if (!m) return { body: rest };
  const cap = Number(m[1]);
  if (!Number.isSafeInteger(cap) || cap < 1) return { body: rest, cap: 'invalid' };
  return { body: rest.slice(0, m.index), cap };
}

function firstNonSpace(s: string, from: number): number {
  let i = from;
  while (i < s.length && /\s/.test(s[i]!)) i++;
  return i;
}

/**
 * The one wording for a dangling chain member — the mirror of
 * `danglingChainMemberMessage` in `src/parser/control-line.ts`.
 *
 * Deliberately mirrored where `controlLineError` deliberately is not. A
 * diagnostic for a claimed-but-incomplete line is the CLI's job because only
 * the CLI refuses the file; a DANGLING member is refused three times over —
 * by the CLI parser, by the expander on the wire path, and by the client's own
 * pre-flight, which is the only one that sees the batch about to be cut. Three
 * refusals blaming the same line in three different sentences is how an author
 * learns to distrust all three, so this text is pinned to the original by
 * `tests/control-line-parity.test.ts`.
 */
export function danglingChainMemberMessage(args: {
  line: string;
  word: string;
  flow: string;
  where?: string;
}): string {
  const prefix = args.where ? `${args.where} — ` : '';
  return (
    `${prefix}"${args.line}" has no decision to be the alternative of. An ` +
    `\`${args.word}\` line must follow an \`If … then …\` or another ` +
    `\`Else if\` on the previous step line of the same flow (${args.flow}); ` +
    `a blank line or prose between them is fine, another numbered step is not.`
  );
}

/**
 * The one wording for a chain member written BELOW its `Otherwise` — the
 * mirror of `closedChainMemberMessage` in `src/parser/control-line.ts`, and
 * the other half of the dangling rule.
 *
 * Mirrored for the same reason the sentence above it is: this half used to be
 * refused by the CLI parser alone, so a file Steptix and the Sessions API
 * ran happily was rejected by `steptix run`. Pinned to the original by
 * `tests/control-line-parity.test.ts`.
 */
export function closedChainMemberMessage(args: { line: string; where?: string }): string {
  const prefix = args.where ? `${args.where} — ` : '';
  return (
    `${prefix}"${args.line}" follows an \`Otherwise\`, which ends a chain. ` +
    `A decision has at most one \`Else\` / \`Otherwise\`, and it comes ` +
    `last; put any further alternative in an \`Else if\` above it.`
  );
}

/**
 * The one wording for an `Else if` / `Otherwise` written under a FLOW-CONTROL
 * step — the mirror of `chainAfterFlowControlMessage` in
 * `src/parser/control-line.ts`, mirrored for the reason the two sentences
 * above it are, and pinned by `tests/control-line-parity.test.ts`.
 */
export function chainAfterFlowControlMessage(args: {
  line: string;
  word: string;
  previous: string;
  where?: string;
}): string {
  const prefix = args.where ? `${args.where} — ` : '';
  return (
    `${prefix}"${args.line}" follows "${args.previous.trim()}", which ends ` +
    `the flow rather than choosing a branch, so there is no decision for an ` +
    `\`${args.word}\` to be the alternative of. The steps after a ` +
    `\`then return\` / \`then stop\` already run only when the return did ` +
    `NOT fire — write the alternative as the next step, with no ` +
    `\`${args.word}\` in front of it.`
  );
}

/** The word a chain member is named by in a diagnostic. */
export function chainMemberWord(kind: 'elseif' | 'else'): string {
  return kind === 'elseif' ? 'Else if' : 'Otherwise';
}

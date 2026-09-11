/**
 * `… otherwise fail with message "…"` / `… otherwise continue` — the tail that
 * renames a step's failure or lets it through
 * (stories/step-failure-outcomes.md, decision 4).
 *
 * A tail is a property of an ORDINARY step, not a flow-control form: nothing
 * here claims a step, so nothing here changes whether a model turn happens,
 * whether the step caches, or whether the grouper may fold the line in.
 *
 * The model never sees the tail of the step it is being asked to do —
 * {@link stripFailureTail} is what the executor hands the two prompt builders
 * and NOTHING else, so a model told "otherwise continue" cannot answer `noop`
 * and one told "otherwise fail with message" cannot judge the check itself.
 * EARLIER steps keep their tail in `## Prior Steps` (`formatStepHistoryEntry`,
 * src/ai/prompts.ts), because history is a record.
 *
 * Both imports are the trade `control-line.ts` makes: a grammar this module
 * must AGREE with is imported, not copied.
 */
import { FAIL_TAIL_SOURCE, parseFlowControlStep } from './flow-control-step.js';
import {
  INVOCATION_KINDS,
  invocationTokenPattern,
  type InvocationKind,
} from './invocation-parser.js';

export interface ParsedFailureTail {
  /** The step text with the tail removed — what actually runs; non-empty by
   *  construction. A trailing run of `[…]` markers rides in the body even
   *  though it sits BEHIND the tail — see {@link TRAILING_MARKERS_RE}. */
  body: string;
  /** `fail` renames the final failure in the author's words (decision 5);
   *  `continue` tolerates it and the run carries on (decision 6). */
  outcome: 'fail' | 'continue';
  /** `fail`: the authored error, which REPLACES the framework's. `continue`:
   *  the authored warning, which becomes the row's explanation while the error
   *  stays the framework's. Absent when none was written — a message-less
   *  `otherwise fail` and a bare `otherwise continue` are both legal. */
  message?: string;
}

/** Leading whitespace and the `[no-hooks]` prefix (mirrors `NO_HOOKS_MARKER`,
 *  section-match.ts). Always matches, so the LENGTH of what it removed is the
 *  offset the body starts at in the original. */
const LEAD_RE = /^\s*(?:\[no-hooks\]\s*)?/i;

/**
 * The instruction as the grammar sees it: trimmed, `[no-hooks]` removed, one
 * trailing `.` dropped — the normalisation `flow-control-step.ts` also applies.
 * `offset` is where `text` begins in the ORIGINAL, so a position inside `text`
 * plus `offset` is the same position in the instruction, which is how
 * {@link stripFailureTail} cuts at the tail rather than searching for the body.
 * `[output: x]`, `[as: x]` and every other inline marker ride in the body.
 */
function normalise(instruction: string): { text: string; offset: number } {
  const lead = LEAD_RE.exec(instruction)![0];
  return {
    text: instruction.slice(lead.length).trim().replace(/\.$/, '').trim(),
    offset: lead.length,
  };
}

/** `"…"` or `'…'`, no nested quote of the same kind; two capture groups, the
 *  same shape {@link FAIL_TAIL_SOURCE} uses. */
const QUOTED = '(?:"([^"]*)"|\'([^\']*)\')';

/**
 * The whole tail grammar, in one anchored expression
 * (stories/step-failure-outcomes.md §"The grammar"):
 *
 * ```
 * head    := [,] (otherwise | or else | if (it | that | this) fails) [,]
 * outcome := fail-tail
 *          | (continue | carry on | keep going) [with [a] (warning | message) quoted]
 *          | warn [with] quoted
 * line    := <body> head outcome        -- body non-empty
 * ```
 *
 * `<body>` is lazy and both ends anchored, so a tail with prose after it is not
 * a tail and the engine settles on the LAST head that still leaves a complete
 * outcome (`Verify the text says "otherwise" otherwise continue` keeps the
 * quoted occurrence). `Otherwise continue` at LINE START is refused by the same
 * `.+?` — with no body there is nothing for a tail to be a property of, and
 * that line belongs to the chain grammar.
 *
 * Groups, in order: 1 body; 2 the whole `fail` tail (the marker that says the
 * outcome is `fail` at all), 3/4 its message; 5 the `continue` verb, 6/7 its
 * warning; 8 the `warn` verb, 9/10 its warning.
 */
const FAILURE_TAIL_RE = new RegExp(
  '^(.+?)' +
    '(?:\\s*,\\s*|\\s+)' +
    '(?:otherwise|or\\s+else|if\\s+(?:it|that|this)\\s+fails)' +
    '(?:\\s*,\\s*|\\s+)' +
    '(?:' +
    `(${FAIL_TAIL_SOURCE})` +
    '|' +
    `(continue|carry\\s+on|keep\\s+going)(?:\\s+with(?:\\s+a)?\\s+(?:warning|message)\\s+${QUOTED})?` +
    '|' +
    // `warn "…"` is `continue with warning "…"` spelled short, so the quote is
    // REQUIRED where it is optional above: a bare `warn` is `otherwise continue`.
    `(warn)(?:\\s+with)?\\s+${QUOTED}` +
    ')$',
  'i',
);

/**
 * A trailing run of `[…]` markers, with the whitespace in front of each.
 *
 * Measured trap: the runners APPEND to a step before the executor sees it
 * (`buildEnrichedInstruction`, src/server/run-helpers.ts turns an `[output:
 * total]` step into `Read the total [store as: total]`), so the `$` anchor no
 * longer reached the tail — turn ≥ 2 quoted the tail back at a model that
 * answered `noop`, and `{{total}}` was never captured. Only consulted when the
 * whole line did not match, so a `[…]` inside a body or message is safe.
 */
const TRAILING_MARKERS_RE = /(?:\s*\[[^\]]*\])+$/;

/** One match: the tail as a caller reads it, the body WITHOUT its trailing
 *  markers (what decision 8 asks the flow-control grammar about), and the
 *  instruction with the tail cut out. */
interface FailureTailMatch {
  parsed: ParsedFailureTail;
  core: string;
  stripped: string;
}

/** The grammar, run once: every export below is a reading of this, because
 *  {@link parseFailureTail} and {@link stripFailureTail} must agree about where
 *  the tail STARTS as well as about whether there is one. */
function matchFailureTail(instruction: string): FailureTailMatch | null {
  const { text, offset } = normalise(instruction);

  // Whole line first, then the line with trailing markers held back, so nothing
  // about a line that ends in its tail changes.
  let match = FAILURE_TAIL_RE.exec(text);
  let markers = '';
  if (!match) {
    const trailing = TRAILING_MARKERS_RE.exec(text);
    if (!trailing) return null;
    markers = trailing[0];
    match = FAILURE_TAIL_RE.exec(text.slice(0, text.length - markers.length));
    if (!match) return null;
  }

  const core = match[1]!.trim();
  // Unreachable under `.+?` plus a separator, but an empty `body` would be a
  // step with no text.
  if (core === '') return null;

  const outcome: 'fail' | 'continue' = match[2] !== undefined ? 'fail' : 'continue';
  // `??` not `||`: `with warning ""` wrote an empty message, and only an ABSENT
  // `with …` part means none was written.
  const message = match[3] ?? match[4] ?? match[6] ?? match[7] ?? match[9] ?? match[10];
  // Where the body ends in the ORIGINAL: the lazy `.+?` stops where the
  // separator before the head begins, and `offset` restores the removed front.
  const bodyEnd = offset + match[1]!.replace(/\s+$/, '').length;

  return {
    parsed: { body: core + markers, outcome, ...(message !== undefined ? { message } : {}) },
    core,
    stripped: instruction.slice(0, bodyEnd) + markers,
  };
}

/** The two directives decision 12 puts out of the tail's scope — the invocation
 *  kinds themselves, so a third cannot be added to the scanner and forgotten. */
export type FailureTailDirective = InvocationKind;

/**
 * The `[tool` / `[skill` token, BUILT FROM the rule `parseInvocation` is built
 * from (`invocationTokenPattern`, src/parser/invocation-parser.ts); one pattern
 * per kind, because the refusal has to name the directive it found.
 *
 * Measured trap: the copy this replaced carried an `/i` and the scanner is
 * case-SENSITIVE, so the refusal claimed `[SKILL: x]`, a line the server runs
 * happily as prose.
 *
 * Matched anywhere in the body, because `parseToolCall` and the skill expander
 * both read the text in front of the token as a LABEL — and the TOKEN rather
 * than the parse, because a body this module declines while the validator
 * allows is a tail that evaporates in silence.
 */
const DIRECTIVE_TOKENS: ReadonlyArray<readonly [FailureTailDirective, RegExp]> =
  INVOCATION_KINDS.map((kind) => [kind, invocationTokenPattern([kind])] as const);

/**
 * Decision 12: a `[tool: …]` or `[skill: …]` step does not take a tail — and
 * which one it was, because the refusal names it. Answering null leaves the
 * loops exactly as they were, dispatching the call off the raw line; before
 * this, such a line parsed a tail nobody read and gave the author no
 * diagnostic. `src/parser/markdown.ts` refuses these by name at parse time,
 * which is the half an author actually sees. The EARLIEST token wins, matching
 * the order `parseInvocation` scans in.
 */
function directiveInBody(core: string): FailureTailDirective | null {
  let found: FailureTailDirective | null = null;
  let at = core.length;
  for (const [kind, token] of DIRECTIVE_TOKENS) {
    const index = core.search(token);
    if (index !== -1 && index < at) {
      at = index;
      found = kind;
    }
  }
  return found;
}

/** The match, unless decision 8 refuses it: `If x then return otherwise
 *  continue` is a contradiction, not a tail. Refused HERE as well as at the
 *  validator so the raw Sessions API path, which runs no validator, cannot
 *  silently get one of the two halves. Asked of the CORE body; a
 *  `[tool: …]`/`[skill: …]` body is refused beside it. */
function claimedTail(instruction: string): FailureTailMatch | null {
  const match = matchFailureTail(instruction);
  if (!match) return null;
  if (directiveInBody(match.core) !== null) return null;
  return parseFlowControlStep(match.core) === null ? match : null;
}

/**
 * `{ body, outcome, message? }` when the line carries a tail, or null — no
 * tail, decision 8's contradiction, or a `[tool: …]`/`[skill: …]` body that
 * decision 12 puts out of scope. {@link isFailureTailContradiction} and
 * {@link failureTailDirective} tell the three apart, because one is prose and
 * the other two are refused by name. Matched against the step as AUTHORED,
 * before `{{…}}` interpolation: a message may hold placeholders, and the loops
 * interpolate before the executor sees the line (decision 3).
 */
export function parseFailureTail(instruction: string): ParsedFailureTail | null {
  return claimedTail(instruction)?.parsed ?? null;
}

/**
 * The instruction with the tail removed and everything before it preserved
 * VERBATIM — leading `[no-hooks]`, `[output: x]` and `[as: x]` markers
 * included; unchanged when no tail parses. What the executor hands the model
 * (decision 4), markers and all, because an `[output: x]` lost on the way to
 * the prompt would change what the step captures.
 *
 * The cut is made at the tail's own position, not by searching for the body:
 * a body that also occurs inside a LEADING marker gets cut at the marker, and a
 * body carrying TRAILING markers is not a contiguous substring at all, so the
 * search misses and the model is handed the tail it must not see.
 */
export function stripFailureTail(instruction: string): string {
  return claimedTail(instruction)?.stripped ?? instruction;
}

/** Decision 8: a body that is itself a flow-control claim under a tail is a
 *  contradiction — `If x then return otherwise continue` asks to both end the
 *  flow and to tolerate its own failure. True exactly for that shape; a line
 *  with no tail is false here, which is what lets the validator tell "refuse by
 *  name" from "send to the model". */
export function isFailureTailContradiction(instruction: string): boolean {
  const match = matchFailureTail(instruction);
  return match !== null && parseFlowControlStep(match.core) !== null;
}

/** The one sentence for the contradiction, wherever it is met — the parse-time
 *  validator over `## Steps`, and the executor's own refusal on the raw
 *  Sessions API path. One wording for both, for the reason the dangling-chain
 *  message gives: two refusals about one line must state one rule. */
export const FAILURE_TAIL_CONTRADICTION =
  'a step cannot both end the flow and tolerate its own failure';

/** The refusal, naming the line. `where` is appended verbatim (e.g.
 *  ` in tests/foo.md at line 7`), the `setStepError` convention. */
export function failureTailContradictionError(instruction: string, where = ''): string {
  return (
    `${FAILURE_TAIL_CONTRADICTION}: "${instruction.trim()}"${where}. The body ` +
    `of the tail is itself a \`return\` / \`stop\` / \`fail\` step, so the ` +
    `line asks for two endings at once. Write the flow-control step on its ` +
    `own line, or drop the tail from it.`
  );
}

/** Decision 12: a `[tool: …]`/`[skill: …]` line carrying a tail is refused by
 *  name rather than run with the tail ignored, and the answer says WHICH
 *  directive it found. Non-null exactly for that shape;
 *  {@link parseFailureTail} answers null for the same line, so the loops behave
 *  exactly as before while this turns "did nothing, silently" into an error. */
export function failureTailDirective(instruction: string): FailureTailDirective | null {
  const match = matchFailureTail(instruction);
  return match === null ? null : directiveInBody(match.core);
}

/** The one sentence for a directive step under a tail, with the directive as
 *  its only variable, so an author who meets it once has met both. */
export function directiveFailureTail(kind: FailureTailDirective): string {
  return `a [${kind}:] step does not take an "otherwise" tail`;
}

/**
 * The refusal, naming the line; `where` is appended verbatim.
 *
 * Only the WAY OUT differs between the two: a skill has steps inside it and one
 * of them is the natural home for the tail, a tool call has no body of its own.
 * Measured trap the last review round corrected — advising "wrap the call in a
 * section and put the tail on the calling step" produced prose with a tail on
 * it and a tool that never ran, because a section is matched by the EXACT text
 * of the calling line (`matchText`, src/parser/section-match.ts).
 */
export function directiveFailureTailError(
  instruction: string,
  kind: FailureTailDirective,
  where = '',
): string {
  const wayOut =
    kind === 'skill'
      ? `Put the tail on a step inside the skill, or drop the tail.`
      : `The tail cannot be applied to a tool call: write the check as a step ` +
        `after the call, or make the tool tolerate the failure itself, or drop ` +
        `the tail.`;
  return (
    `${directiveFailureTail(kind)}: "${instruction.trim()}"${where}. A ${kind} ` +
    `call has a grammar of its own and the tail is not threaded through it, so ` +
    `the tail would be read and then ignored. ${wayOut}`
  );
}

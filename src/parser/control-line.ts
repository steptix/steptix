/**
 * The six control-flow step forms — `If … then`, `Else if … then`,
 * `Else` / `Otherwise`, `While`, `Repeat … until`, `For each {{x}} in {{list}}`
 * (stories/control-flow.md).
 *
 * Two entry points, and the split is `set-step.ts`'s:
 *
 *  - {@link parseControlLine} is what every RUNTIME (and the expander) asks.
 *    It answers "is this a control line, and what does it say" and nothing
 *    else. Like `parseSetStep` it is matched against the step as AUTHORED —
 *    for the expander that means `matchInput`, the same match side section
 *    resolution reads, so a body line interpolated with a caller's argument
 *    cannot start or stop being a control line.
 *  - {@link controlLineError} is what a PARSE-TIME validator asks. A line that
 *    opens one of the six forms has CLAIMED it the way `[skill:` claims one,
 *    so a claim that does not complete is an error naming the line rather than
 *    prose handed to a model. It runs where `setStepError` runs — the
 *    `## Steps` main flow and every `### Section` body of a test or skill,
 *    plus MCP-supplied steps — and NOT over `## Hooks` entries, project
 *    `defaultHooks`, or steps posted straight to the Sessions API.
 *
 * **Resolution order.** This module is purely lexical: it looks at one string
 * and says what the grammar makes of it. It is NOT the whole decision. A
 * caller resolves a step in this order (decision 3 of the story):
 *
 *   1. bracket directives — `[skill:`, `[tool:`, `[input:`, `[interactive]`;
 *   2. the bare-name section match (a step that IS a section name is a call
 *      before it is anything else, so a section named `While waiting` still
 *      resolves as a call);
 *   3. control forms — this module;
 *   4. `Set {{x}} to "…"`;
 *   5. prose.
 *
 * Nothing here enforces rungs 1 and 2. Rung 1 needs no enforcing — a bracket
 * directive opens with `[`, which none of the six openings can match — but
 * rung 2 does, and the expander is where it happens.
 *
 * Both entry points take the instruction (the text after the `N. ` ordinal)
 * and strip a leading `[no-hooks]` marker themselves, for the reason
 * `set-step.ts` gives: runner-core deliberately keeps the marker when it puts
 * a step on the wire, so the server and the errand runner would otherwise see
 * `[no-hooks] If …, then …` and hand it to a model as prose.
 *
 * **Flow control wins the overlap.** `If the page title contains "Dashboard"
 * then return` is claimed by BOTH grammars — it is an `If … then <tail>` here,
 * and a conditional `return` in `flow-control-step.ts`. Since
 * stories/step-failure-outcomes.md that grammar has a third verb, so
 * `If the balance is zero then fail the test with error "…"` joins the overlap and
 * goes the same way — nothing below changed to make it, because rung 0 asks
 * `parseFlowControlStep` rather than carrying a list of verbs. It is flow
 * control, in
 * every reader, and this module is where that is decided: rung 0 of the
 * resolution order, ahead of everything above. The alternative — resolving it
 * per caller — is a rule that has to be right in eight places and reads
 * differently in each, and the failure mode is the worst one available: the
 * line would dispatch as a chain, its `return` action would be refused for
 * want of a `flowControlClaim`, and the steps the author expected to be
 * skipped would all run and pass.
 *
 * Only a line the flow-control grammar matches WHOLE is taken: its expression
 * is `$`-anchored, so `If x, then return to the dashboard` stays a chain whose
 * tail is prose, which is what an author means by it. And the guard is on the
 * head only — `Otherwise, return` and `While x, return` are still control
 * lines whose BODY is a bare return, which is a sentence with an obvious
 * meaning and no ambiguity in it.
 *
 * The one import, and why it is worth breaking the rule below: the check has
 * to be the same answer as the executor's, and a second copy of that grammar
 * in this file could drift from `flow-control-step.ts` silently. Both modules
 * are themselves import-free, so nothing else follows.
 *
 * Otherwise kept import-free on purpose. `runner-core/src/control-line.ts` is
 * a mirror of the regexes below (runner-core cannot import `src/`), pinned by
 * `tests/control-line-parity.test.ts` — including this guard, which the mirror
 * has to duplicate the shape of — and a mirror is cheapest to keep honest when
 * the original depends on almost nothing.
 */
import { parseFlowControlStep } from './flow-control-step.js';

export type ControlLine =
  | { kind: 'if' | 'elseif'; condition: string; tail: string }
  | { kind: 'else'; tail: string }
  | { kind: 'while'; condition: string; tail: string; cap?: number }
  | { kind: 'repeat'; condition: string; tail: string; cap?: number }
  | { kind: 'foreach'; item: string; list: string; tail: string };

/** The form a line has claimed, whether or not it completes it. */
export type ControlKind = ControlLine['kind'];

/** The three forms that make up a chain (§"A chain is a decision"). */
export type ChainKind = 'if' | 'elseif' | 'else';

/** True for the three chain kinds — the ones an `Else if` / `Otherwise` may
 *  follow, and the ones a chain record is built for. */
export function isChainKind(kind: ControlKind): kind is ChainKind {
  return kind === 'if' || kind === 'elseif' || kind === 'else';
}

/** True for the three loop kinds. */
export function isLoopKind(kind: ControlKind): kind is 'while' | 'repeat' | 'foreach' {
  return kind === 'while' || kind === 'repeat' || kind === 'foreach';
}

/** The `[no-hooks]` prefix, matching `NO_HOOKS_MARKER` in section-match.ts.
 *  Duplicated rather than imported to keep this module import-free — see the
 *  file docstring. */
const NO_HOOKS_PREFIX = /^\[no-hooks\]\s*/i;

/** The instruction as the grammar sees it: trimmed, marker removed. */
function normalise(instruction: string): string {
  return instruction.trim().replace(NO_HOOKS_PREFIX, '').trim();
}

/**
 * True when the flow-control grammar claims the WHOLE line — the one case
 * this module declines outright (see the file docstring).
 *
 * `parseFlowControlStep` normalises the line itself (including the trailing
 * full stop, which `normalise` above deliberately keeps), so it is handed the
 * already-normalised text and does the rest.
 */
export function isFlowControlLine(instruction: string): boolean {
  return parseFlowControlStep(instruction) !== null;
}

// ---------------------------------------------------------------------------
// The openings. Each one is a CLAIM (see the table in the story's §"What
// claims, and what stays prose"): a line that matches it is a control line or
// a parse error, never prose.
// ---------------------------------------------------------------------------

/**
 * `Else if` / `Otherwise if`, with no comma between the two words.
 *
 * The comma is the disambiguator, and it is load-bearing. `Otherwise, if the
 * banner appears, dismiss it` is an `Otherwise` whose tail is a WATCH step,
 * which is a sentence an author will write; `Else if the card box is ticked,
 * then Pay by card` is an else-if. Accepting `Otherwise,` here as an else-if
 * head would turn the first line into "an `Else if` missing its `then`" — a
 * refusal of a legal line. Declining it here costs nothing, because the
 * `Else` head below catches the same line and the tail rule then judges it.
 */
const ELSE_IF_HEAD_RE = /^(?:else|otherwise)\s+if\b/i;

/** `Else` / `Otherwise` at line start. Neither word opens a page instruction,
 *  so the bare word claims on its own — `\b` keeps `Otherwiseraise` prose. */
const ELSE_HEAD_RE = /^(?:else|otherwise)\b/i;

/** `If` at line start. NOT a claim on its own — the existing watch form
 *  (`If a Remember this device prompt appears, click Not now`) opens the same
 *  way and must keep meaning that. {@link THEN_SPLIT_RE} is the opt-in. */
const IF_HEAD_RE = /^if\b/i;

/** `While` at line start. A whole claim by itself: `While` is a new keyword
 *  with its programming meaning, so a prose opener ("While on the dashboard,
 *  click Settings") becomes a loop that fails loudly at the cap rather than a
 *  silent misread. */
const WHILE_HEAD_RE = /^while\b/i;

/** `Repeat` at line start. NOT a claim on its own — `Repeat the search` is a
 *  plausible prose step; {@link UNTIL_SPLIT_RE} is what makes it a loop. */
const REPEAT_HEAD_RE = /^repeat\b/i;

/** `For each {{` — the braces claim. `For each product in the list, verify
 *  its price` has none, so it is prose and stays prose. */
const FOREACH_CLAIM_RE = /^for\s+each\s+\{\{/i;

// ---------------------------------------------------------------------------
// The splits. One rule per keyword — the rules an author trips over.
// ---------------------------------------------------------------------------

/**
 * The FIRST ` then `, with or without a comma before it, ends an `If` /
 * `Else if` condition.
 *
 * Whitespace on BOTH sides is required, and that is the claim as well as the
 * split: `If x, then` (nothing after) and `If x,then y` (no space before)
 * are prose, which is what they were before this feature existed. The cost is
 * stated in the story and accepted: a condition containing the word "then"
 * must be reworded, because `If the modal appears, dismiss it and then
 * continue` splits at that "then" rather than reading as a watch.
 */
const THEN_SPLIT_RE = /,?\s+then\s+/i;

/** The FIRST ` until ` ends a `Repeat` tail. A tail containing the word
 *  "until" must go in a section. Same whitespace rule as `then`. */
const UNTIL_SPLIT_RE = /\s+until\s+/i;

/**
 * `, up to N times` at the END of a `While` or `Repeat` line, removed before
 * the rest is parsed.
 *
 * `\d+` rather than `[1-9]\d*` on purpose. A cap of 0 is not a cap — a loop
 * with one runs zero times — and matching it here turns it into a NAMED
 * refusal, where a narrower regex would leave `, up to 0 times` as the tail's
 * last five words and run it as part of the step.
 */
const CAP_RE = /,\s*up\s+to\s+(\d+)\s+times\s*$/i;

/** The complete `For each` shape. Fixed: the comma after the second `}}` is
 *  the split, and `For each` takes no cap — the list is its bound. */
const FOREACH_RE =
  /^for\s+each\s+\{\{([A-Za-z_]\w*)\}\}\s+in\s+\{\{([A-Za-z_]\w*)\}\}\s*,\s*(\S.*)$/i;

/**
 * Deliberately wider than {@link FOREACH_RE} — any brace contents, an
 * optional list, an optional comma — so a near miss gets the error that names
 * it rather than a generic "one fixed shape" (the courtesy `setStepError`
 * pays a spacing slip).
 *
 * The brace captures are UNTRIMMED on purpose: `{{ item }}` and `{{item}}`
 * must be distinguishable here, because the spacing IS the fault being
 * reported and `interpolate` would never have replaced the spaced form either.
 */
const FOREACH_LOOSE_RE =
  /^for\s+each\s+\{\{([^}]*)\}\}(?:\s+in\s+\{\{([^}]*)\}\})?\s*(,?)\s*(.*)$/i;

/** A legal placeholder name, for the loose-parse diagnostics. */
const IDENT_RE = /^[A-Za-z_]\w*$/;

/**
 * The one wording for a dangling chain member, used in all three places that
 * refuse one (stories/control-flow.md §"Runs that start or end mid-structure").
 *
 * The rule is a single sentence — *an `Else if` / `Otherwise` whose previous
 * step line in the same flow is not a chain member is dangling* — and it is
 * checked three times because each check sees a different document:
 *
 *  1. `validateControlFlow` (markdown.ts), on a file the CLI parses;
 *  2. the EXPANDER, which is the wire path's only parser — TestBench never
 *     calls `parseTestContent`, and an `Otherwise` that opened a chain of its
 *     own there would run its tail unconditionally;
 *  3. runner-core's pre-flight (`danglingChainMemberError`), which refuses the
 *     file in the editor before a batch is ever cut — the case that matters
 *     being an `[input:]` between two members, which splits one decision
 *     across two requests.
 *
 * Three refusals blaming the same line in three different sentences is how an
 * author learns to distrust all three, so the text lives here and runner-core
 * mirrors it under a parity assertion (`tests/control-line-parity.test.ts`).
 *
 * `where` is a location prefix (`tests/t.md:6`, `Line 6`), appended with an
 * em dash when present. `flow` names the list the chain lives in — `## Steps`
 * or `### Section name` — because "the same flow" is the part of the rule that
 * surprises people.
 */
export function danglingChainMemberMessage(args: {
  line: string;
  /** `'Else if'` or `'Otherwise'` — whichever the author wrote. */
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
 * The one wording for a chain member written BELOW the `Otherwise` that closed
 * the chain — the other half of the same rule, and refused in the same three
 * places for the same reason.
 *
 * `Otherwise` is the last member by definition ("A chain is a decision":
 * `Otherwise` at most once, and last). A second one, or an `Else if` under
 * one, is not merely untidy: at run time `fallbackOf` picks the FIRST
 * condition-less member, so a second `Otherwise`'s tail is unreachable code
 * that is always skipped, and an `Else if` below one is still evaluated. An
 * author cannot learn either of those from watching the run.
 *
 * Takes no `word` or `flow`: the line quotes itself, and "which flow" is not
 * the part that surprises anyone here — the `Otherwise` is right above it.
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
 * step — `If the balance is zero then return` and an `Otherwise` beneath it
 * (stories/control-flow.md §"Composition with `If … then return`").
 *
 * Its own sentence rather than the dangling one above, because "has no
 * decision to be the alternative of" is true but useless here: the author is
 * looking straight at a line that starts `If`, and being told there is no
 * decision above it reads as a parser bug. What they need to know is that this
 * shape does not need an `Otherwise` at all — a return either fires or it does
 * not, and the steps below it already run only in the second case. So the
 * refusal names the line above, says why it is not a decision, and gives the
 * one-line fix.
 *
 * Refused in the same three places the dangling rule is refused in — the CLI
 * parser, the expander (the wire path's only parser) and runner-core's
 * pre-flight — and mirrored in `runner-core/src/control-line.ts` under the
 * same parity assertion, for the same reason: three refusals blaming one line
 * in three different sentences is how an author learns to distrust all three.
 */
export function chainAfterFlowControlMessage(args: {
  line: string;
  /** `'Else if'` or `'Otherwise'` — whichever the author wrote. */
  word: string;
  /** The flow-control line on the previous step line. */
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
export function chainMemberWord(kind: ChainKind): string {
  return kind === 'elseif' ? 'Else if' : 'Otherwise';
}

/** Which of the six forms this line claimed, or null when it claimed none.
 *  Exported for diagnostics that want to say what the author reached for. */
export function claimedControlForm(instruction: string): ControlKind | null {
  const s = normalise(instruction);

  // Rung 0: a line the flow-control grammar claims whole is flow control and
  // nothing else — see the file docstring. `parseControlLine` asks the same
  // question at its own head, rather than deferring to this one, because the
  // two entry points are independent by design and a reader of either should
  // find the rule in it.
  if (isFlowControlLine(s)) return null;

  if (ELSE_IF_HEAD_RE.test(s)) return 'elseif';
  if (ELSE_HEAD_RE.test(s)) return 'else';

  const ifHead = IF_HEAD_RE.exec(s);
  if (ifHead) return THEN_SPLIT_RE.test(s.slice(ifHead[0].length)) ? 'if' : null;

  if (WHILE_HEAD_RE.test(s)) return 'while';

  const repeatHead = REPEAT_HEAD_RE.exec(s);
  if (repeatHead) {
    // The cap comes off first, or `Repeat X, up to 3 times` would be judged on
    // text the parser never sees.
    const rest = s.slice(repeatHead[0].length).replace(CAP_RE, '');
    return UNTIL_SPLIT_RE.test(rest) ? 'repeat' : null;
  }

  if (FOREACH_CLAIM_RE.test(s)) return 'foreach';
  return null;
}

/** True when the line opens one of the six forms — whether or not it
 *  completes. What the grouper excludes on, and what a tail is refused on. */
export function isControlLineClaim(instruction: string): boolean {
  return claimedControlForm(instruction) !== null;
}

/**
 * `{ kind, … }`, or null when the line is not a control line at all.
 *
 * A line that CLAIMS a form and does not complete it also answers null here —
 * {@link controlLineError} is what turns that into a diagnostic, exactly as
 * `parseSetStep` and `setStepError` divide the same job.
 */
export function parseControlLine(instruction: string): ControlLine | null {
  const hit = parseControlLineAt(instruction);
  if (!hit) return null;
  const { tailStart: _tailStart, ...line } = hit;
  return line;
}

/**
 * The variable names a control line DEFINES rather than reads — today, a
 * `For each` header's item, and nothing else.
 *
 * `For each {{payment}} in {{payments}}` reads `{{payments}}` and WRITES
 * `{{payment}}`, one element per pass. Every other placeholder machinery in
 * this repo already knows that distinction — a `[store as: x]` and a `Set`
 * target are definitions too — but the run loops interpolate the raw header
 * line like any other step, so `interpolate` warned
 * `Unresolved placeholder: {{payment}}` on every pass-zero visit to every
 * correct table loop. Seen in a live TestBench run, where it is noise that
 * looks like a diagnosis.
 *
 * A set rather than a string, because the answer is "which names", and the
 * next form that defines one (a `For each … with index {{n}}`, say) should
 * extend this rather than grow a second accessor.
 *
 * Every run loop that interpolates step text passes it — the CLI got it last,
 * having shipped without it — and `tests/run-loop-contracts.test.ts` pins that
 * they all do. A rule that lives in two loops out of three is the recurring
 * defect in this area, not a hypothetical one.
 */
export function controlLineDefines(instruction: string): ReadonlySet<string> | undefined {
  const line = parseControlLine(instruction);
  return line?.kind === 'foreach' ? new Set([line.item]) : undefined;
}

/**
 * {@link parseControlLine} plus `tailStart` — the 0-based offset of the tail
 * within the normalised (trimmed, `[no-hooks]`-stripped) instruction.
 *
 * Exported because a *column* is what an editor needs: the runner-core mirror
 * underlines the section name in a resolved tail rather than the keyword, and
 * the two implementations agree on the offset as well as the text.
 */
export function parseControlLineAt(
  instruction: string,
): (ControlLine & { tailStart: number }) | null {
  const s = normalise(instruction);

  // Rung 0 — see the file docstring. `If x, then return` is flow control, so
  // it is not a chain head, its `then` is not a split, and no tail of it is a
  // section call site.
  if (isFlowControlLine(s)) return null;

  // `Else if` / `Otherwise if` before the bare `Else`, or the longer form can
  // never be reached.
  const elseIfHead = ELSE_IF_HEAD_RE.exec(s);
  if (elseIfHead) return conditionThenTail(s, elseIfHead[0].length, 'elseif');

  const elseHead = ELSE_HEAD_RE.exec(s);
  if (elseHead) {
    // `('Else' | 'Otherwise') ','? WS Tail` — the comma is optional because
    // `Otherwise, Pay by card` and `Else Pay by card` both read.
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
    // The FIRST comma ends the condition; the tail may contain more.
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
    // A cap on a `For each` is refused rather than swallowed into the tail.
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

/** The `If` / `Else if` body: `Condition ','? WS 'then' WS Tail`. */
function conditionThenTail(
  s: string,
  headLength: number,
  kind: 'if' | 'elseif',
): (ControlLine & { tailStart: number }) | null {
  // NOT trimmed before the search: `If then do x` must find its ` then ` at
  // offset 0 of the remainder and report an EMPTY CONDITION, rather than
  // failing to match and falling through to prose.
  const rest = s.slice(headLength);
  const m = THEN_SPLIT_RE.exec(rest);
  if (!m) return null;
  const condition = rest.slice(0, m.index).trim();
  const tailStart = headLength + m.index + m[0].length;
  const tail = s.slice(tailStart).trim();
  if (condition === '' || tail === '') return null;
  return { kind, condition, tail, tailStart };
}

/**
 * Take `, up to N times` off the end.
 *
 * `'invalid'` rather than a thrown error or a silent drop: a cap of zero (or
 * a number too large to be one) has claimed the suffix, so leaving it on the
 * tail would run "up to 0 times" as part of the step, and dropping it would
 * run an unbounded loop the author thought they had bounded.
 */
function stripCap(rest: string): { body: string; cap?: number | 'invalid' } {
  const m = CAP_RE.exec(rest);
  if (!m) return { body: rest };
  const cap = Number(m[1]);
  if (!Number.isSafeInteger(cap) || cap < 1) return { body: rest, cap: 'invalid' };
  return { body: rest.slice(0, m.index), cap };
}

/** Offset of the first non-space character at or after `from`. */
function firstNonSpace(s: string, from: number): number {
  let i = from;
  while (i < s.length && /\s/.test(s[i]!)) i++;
  return i;
}

/**
 * The parse error for a line that claims a form and does not complete it, or
 * null when the line either parses or never claimed.
 *
 * `where` is appended verbatim (e.g. ` in tests/foo.md at line 7`) so one
 * message serves the markdown parser, the MCP assembler and anything else
 * that validates ahead of a run — the `setStepError` convention.
 */
export function controlLineError(instruction: string, where = ''): string | null {
  const s = normalise(instruction);
  const claimed = claimedControlForm(s);
  if (claimed === null) return null;
  if (parseControlLine(s) !== null) return null;

  const lead = `Cannot parse the step "${s}"${where}`;

  // A bad cap is diagnosed first for `While` / `Repeat`: it is the one fault
  // that makes the REST of the line unreadable, so reporting a missing comma
  // on `While x, up to 0 times` would send the author looking in the wrong
  // place.
  if (claimed === 'while' || claimed === 'repeat') {
    const capError = capMessage(s, lead);
    if (capError) return capError;
  }

  switch (claimed) {
    case 'if':
    case 'elseif': {
      const word = claimed === 'if' ? 'If' : 'Else if';
      const head = claimed === 'if' ? IF_HEAD_RE.exec(s)! : ELSE_IF_HEAD_RE.exec(s)!;
      const rest = s.slice(head[0].length);
      const m = THEN_SPLIT_RE.exec(rest);
      if (!m) {
        // Reachable for `Else if` only: the `If` claim IS the ` then `.
        return (
          `${lead}. An \`${word}\` line names the step to run after \`then\`: ` +
          `write \`${word} <condition>, then <step>\`. Without \`then\` this ` +
          `line is not a decision, and \`Else if\` opens no page instruction.`
        );
      }
      if (rest.slice(0, m.index).trim() === '') {
        return (
          `${lead}. An \`${word}\` line needs a condition before \`then\` — ` +
          `write \`${word} <condition>, then <step>\`. The condition is a ` +
          `sentence the model answers yes or no to, written the way a ` +
          `\`Verify\` step is written.`
        );
      }
      return (
        `${lead}. An \`${word}\` line needs one step after \`then\` — ` +
        `write \`${word} <condition>, then <step>\`.`
      );
    }

    case 'else': {
      const word = /^otherwise/i.test(s) ? 'Otherwise' : 'Else';
      return (
        `${lead}. \`${word}\` must name one step to run — a section name, a ` +
        `\`[skill: …]\`, a \`[tool: …]\`, a \`Set {{x}} to "…"\`, or a page ` +
        `instruction. Write \`${word}, <step>\`; for a body of more than one ` +
        `step, name a \`### Section\`.`
      );
    }

    case 'while': {
      const { body } = stripCap(s.slice(WHILE_HEAD_RE.exec(s)![0].length));
      const comma = body.indexOf(',');
      if (comma < 0) {
        return (
          `${lead}. A \`While\` line separates its condition from the step it ` +
          `repeats with a comma — write \`While <condition>, <step>\`. The ` +
          `FIRST comma is the split, so a condition containing one must be ` +
          `reworded.`
        );
      }
      if (body.slice(0, comma).trim() === '') {
        return (
          `${lead}. A \`While\` line needs a condition before the comma — ` +
          `write \`While <condition>, <step>\`.`
        );
      }
      return (
        `${lead}. A \`While\` line needs the step to repeat after the comma — ` +
        `write \`While <condition>, <step>\`. For a body of more than one ` +
        `step, name a \`### Section\`.`
      );
    }

    case 'repeat': {
      const { body } = stripCap(s.slice(REPEAT_HEAD_RE.exec(s)![0].length));
      const m = UNTIL_SPLIT_RE.exec(body)!;
      if (body.slice(0, m.index).trim() === '') {
        return (
          `${lead}. A \`Repeat\` line names the step to repeat BEFORE ` +
          `\`until\` — write \`Repeat <step> until <condition>\`.`
        );
      }
      return (
        `${lead}. A \`Repeat\` line needs an exit condition after \`until\` — ` +
        `write \`Repeat <step> until <condition>\`.`
      );
    }

    case 'foreach':
      return foreachMessage(s, lead);
  }
}

/** The cap suffix's own diagnostic, or null when the cap is fine or absent. */
function capMessage(s: string, lead: string): string | null {
  const m = CAP_RE.exec(s);
  if (!m) return null;
  const cap = Number(m[1]);
  if (Number.isSafeInteger(cap) && cap >= 1) return null;
  return (
    `${lead}. \`up to ${m[1]} times\` is not a cap — a loop runs at least ` +
    `once, so the number must be 1 or more. Drop the suffix to use ` +
    `\`execution.maxLoopIterations\` instead.`
  );
}

/** Name the near miss on a `For each` line, the way `setStepError` names a
 *  spacing slip inside a `Set` target's braces. */
function foreachMessage(s: string, lead: string): string {
  const shape =
    'A `For each` line has one fixed shape: ' +
    '`For each {{item}} in {{list}}, <step>`.';

  if (CAP_RE.test(s)) {
    return (
      `${lead}. \`For each\` takes no \`, up to N times\` cap — the list is ` +
      `its bound. Remove the suffix, or use \`While\` / \`Repeat … until\` ` +
      `for a loop that needs one.`
    );
  }

  const loose = FOREACH_LOOSE_RE.exec(s);
  if (!loose) {
    return (
      `${lead}. ${shape} \`{{list}}\` must hold a JSON array — what a plural ` +
      `read stores, or an array-typed tool output.`
    );
  }

  const [, item = '', list, comma, tail = ''] = loose;
  if (list === undefined) {
    return (
      `${lead}. ${shape} The list is missing — write ` +
      `\`For each {{${IDENT_RE.test(item) ? item : 'item'}}} in {{list}}, <step>\`.`
    );
  }
  for (const [name, label] of [
    [item, 'item'],
    [list, 'list'],
  ] as const) {
    if (IDENT_RE.test(name)) continue;
    // A spacing slip inside the braces: the line looks right, and no
    // interpolation would ever have replaced the placeholder either — the
    // same near miss `setStepError` names on a `Set` target.
    if (name.trim() !== name && IDENT_RE.test(name.trim())) {
      return (
        `${lead}. A placeholder carries no spaces inside its braces — write ` +
        `\`{{${name.trim()}}}\` for the ${label}. ${shape}`
      );
    }
    return (
      `${lead}. "${name}" is not a placeholder name — the ${label} must be a ` +
      `letter or underscore followed by letters, digits or underscores. ${shape}`
    );
  }
  if (comma !== ',') {
    return (
      `${lead}. ${shape} The comma after \`{{${list}}}\` is the split between ` +
      `the list and the step to run for each of its items.`
    );
  }
  return (
    `${lead}. ${shape} The step to run for each item is missing after the ` +
    `comma.` + (tail === '' ? '' : ` Read as: "${tail}".`)
  );
}

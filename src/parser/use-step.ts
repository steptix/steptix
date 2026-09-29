/**
 * `[use computer]` / `[use browser]` — the two whole-step directives that
 * switch the surface a test drives (docs/specs/SPEC-use-computer.md §4.1) —
 * and `[use ai] <step>`, the family's one PER-STEP member
 * (stories/use-ai-step.md): the step's text goes to the model on its own and
 * the value it answers with is stored as a variable. `ai` is not a surface,
 * so it has no mode form; {@link parseUseStep} keeps answering null for it
 * and {@link parseUseAiStep} is its own entry point.
 *
 * Two entry points per form, and the split is `set-step.ts`'s:
 *
 *  - {@link parseUseStep} and {@link parseUseAiStep} are what every RUNTIME
 *    asks. They answer "is this a surface switch, and which surface" and "is
 *    this a `[use ai]` step, and what does it say", so a loop can branch on
 *    them cheaply. Like `parseSetStep` they are matched against the step as
 *    AUTHORED, before `{{…}}` interpolation — a directive assembled out of a
 *    substituted value is not one an author wrote, and what a run does must
 *    be readable from the file.
 *  - {@link useStepError} is what a PARSE-TIME validator asks. A line opening
 *    `[use` has CLAIMED the form the way `[skill:` claims one, so a claim that
 *    does not complete is an error naming the line rather than prose handed to
 *    a model — the §4.2 failure this directive's bracket spelling exists to
 *    make impossible. It runs where `setStepError` runs: the `## Steps` main
 *    flow and every `### Section` body of a test or skill, plus MCP-supplied
 *    steps, and NOT over `## Hooks` entries, project `defaultHooks`, or steps
 *    posted straight to the Sessions API. (§4.4 refuses a SURFACE SWITCH in a
 *    hook outright — that is the hook loader's rule, not this module's, and it
 *    asks `parseUseStep`, so a `[use ai]` hook line is not caught by it.) The
 *    `[use ai]` runner asks it too, so the refusals reach the paths no
 *    validator guards.
 *
 * Both take the instruction — the text after the `N. ` ordinal — and strip a
 * leading `[no-hooks]` marker themselves, for the reason `set-step.ts` gives:
 * `runner-core`'s `extractSteps` deliberately keeps the marker when it puts a
 * step on the wire, so the Sessions API and the errand runner would otherwise
 * see `[no-hooks] [use computer]` and hand it to a model as prose.
 *
 * **Why the tokenizer is not imported.** `src/parser/invocation-parser.ts`
 * reads the same `[<kind> <name>]` shape and this module deliberately keeps
 * its grammar identical to it — the separator class is `[ \t:]`, the colon is
 * optional, case is tolerated — but it does not call it. Two reasons, in
 * order: this file is mirrored in `runner-core/src/use-step.ts`, which cannot
 * import `src/`; and it is loaded DIRECTLY as `.ts` by steptix-vscode's
 * mirror suite under Node's type stripping, where a `./x.js` specifier does
 * not resolve to `x.ts`. Import-free is the price of both, the same price
 * `set-step.ts` and `control-line.ts` pay. What keeps the grammars from
 * drifting is `tests/use-step-parity.test.ts`, not an import.
 *
 * **What the claim costs.** `[use` plus a separator is a claim, so
 * `[use the bathroom] before the test` is an error rather than prose. That is
 * deliberate and is the whole point of §4.2: a bracket step nobody parses
 * reaches a model, which answers it with a silent `noop`. An author who meant
 * prose writes it without the brackets.
 */

/** The two surfaces, and the closed set the grammar admits. */
export type Surface = 'computer' | 'browser';

export interface ParsedUseStep {
  /** The surface the run switches to. */
  surface: Surface;
}

/** The surfaces in the order every message lists them. */
export const USE_SURFACES: readonly Surface[] = ['computer', 'browser'];

/** The `[no-hooks]` prefix, matching `NO_HOOKS_MARKER` in section-match.ts.
 *  Duplicated rather than imported to keep this module import-free — see the
 *  file docstring. */
const NO_HOOKS_PREFIX = /^\[no-hooks\]\s*/i;

/**
 * THE claim: `[use` at the START of the step, followed by `:`, inline
 * whitespace, or the closing `]`.
 *
 * The separator class is `[ \t:]` and NOT `\s`, exactly as
 * `invocationTokenPattern` argues: a newline or a non-breaking space would
 * claim a token the parser then refuses to name. `]` is in the class on top of
 * those two so that the bare `[use]` — no target at all — is a claim rather
 * than an unknown bracket, and gets the message that names the two surfaces
 * instead of a generic "not a directive".
 *
 * Case-INSENSITIVE, unlike the invocation tokenizer. The invocation grammar is
 * case-sensitive because `[SKILL: x]` is prose to the runner and a mirror that
 * claimed it would refuse a step the server runs happily; here the runner
 * itself reads the directive case-insensitively (§4.1), so the claim must too.
 *
 * Anchored at the start, which is what makes §4.2's other half true: a bracket
 * INSIDE a longer step is prose, so `Verify the [use of cookies] banner` is
 * untouched.
 */
const CLAIM_RE = /^\[use(?=[ \t:\]])/i;

/**
 * The complete form. `Sep := WS? ':' WS? | WS` as the invocation tokenizer
 * spells it, the name from the closed set, optional space before the `]`, and
 * `$` — which is what makes trailing text an error rather than a second step.
 */
const USE_STEP_RE = /^\[use(?:[ \t]*:[ \t]*|[ \t]+)(computer|browser)[ \t]*\]$/i;

/** The instruction as the grammar sees it: trimmed, marker removed. */
function normalise(instruction: string): string {
  return instruction.trim().replace(NO_HOOKS_PREFIX, '').trim();
}

/** True when the line opens `[use` — whether or not it completes. */
export function isUseStepClaim(instruction: string): boolean {
  return CLAIM_RE.test(normalise(instruction));
}

/** `{ surface }`, or null when the line is not a surface switch at all.
 *  A line that CLAIMS the form and does not complete it also answers null
 *  here — {@link useStepError} is what turns that into a diagnostic. So does
 *  a `[use ai] …` step, which switches nothing: no existing caller of this
 *  function changes meaning because the family grew. */
export function parseUseStep(instruction: string): ParsedUseStep | null {
  const match = USE_STEP_RE.exec(normalise(instruction));
  if (!match) return null;
  return { surface: match[1]!.toLowerCase() as Surface };
}

// ---------------------------------------------------------------------------
// `[use ai] <step>` (stories/use-ai-step.md)
// ---------------------------------------------------------------------------

/** A `[use ai] <step>` line, as every runtime reads it. */
export interface ParsedUseAiStep {
  /**
   * The step after `[use ai]`, trimmed, with the bracket name markers —
   * `[store as: x]`, `[as: x]`, `[output: x]` — removed: they are
   * instructions to the framework, not to the model. The prose
   * `store as {{x}}` stays, because it is part of the author's sentence.
   * Empty only on a line {@link useStepError} refuses.
   */
  text: string;
  /**
   * The distinct names the step pins, bracket markers and prose alike, in
   * source order. One on a line that validates; none means the model names
   * the value and the runner checks that name against the step's words; two
   * or more is a line {@link useStepError} refuses, and the runner refuses it
   * too on the paths that never parse a file.
   */
  explicitNames: string[];
  /**
   * The names the step DEFINES in prose (`store as {{x}}` / `save as {{x}}`).
   * They stay in {@link text}, and they are definitions rather than
   * references, so filling the step's placeholders must leave them alone —
   * the `inlineStoreAsNames` rule (src/runner/placeholder-substitution.ts).
   */
  defines: string[];
}

/**
 * The `[use ai]` token: the claim's separator class, the name `ai`, optional
 * space, `]`. As a SOURCE, because it is used anchored (the step form) and
 * unanchored (the misplaced-token refusal), and a `/g` or `/y` RegExp object
 * carries state between the two.
 */
const USE_AI_TOKEN_SOURCE = '\\[use(?:[ \\t]*:[ \\t]*|[ \\t]+)ai[ \\t]*\\]';
const USE_AI_PREFIX_RE = new RegExp(`^${USE_AI_TOKEN_SOURCE}`, 'i');
const USE_AI_ANYWHERE_RE = new RegExp(USE_AI_TOKEN_SOURCE, 'i');

/**
 * The bracket name markers, with the whitespace in front of each so removing
 * one leaves no double space behind. A comma list (`[store as: a, b]`, the
 * shape `buildEnrichedInstruction` writes) is read as several names — which a
 * `[use ai]` step then refuses, since it produces one value.
 */
const NAME_MARKER_SOURCE =
  '[ \\t]*\\[(?:store[ \\t]+as|as|output)[ \\t]*:[ \\t]*(\\w+(?:[ \\t]*,[ \\t]*\\w+)*)[ \\t]*\\]';

/** The prose form, copied from `inlineStoreAsNames` so both read one grammar.
 *  Duplicated rather than imported to keep this module import-free. */
const PROSE_NAME_SOURCE = '\\b(?:store|save)\\s+(?:it\\s+)?as\\s+\\{\\{\\s*(\\w+)\\s*\\}\\}';

/** A control line's opening word — enough to say "that is a control line's
 *  tail" rather than "move it to the start", without importing the grammar. */
const CONTROL_HEAD_RE = /^(?:if|else[ \t]+if|otherwise|while|repeat|for[ \t]+each)\b/i;

/** One explicit name, where it sits in the text it was read from, and
 *  whether it was the prose form. */
interface NameAt {
  name: string;
  at: number;
  prose: boolean;
}

/** Every explicit name in `rest`, in source order. */
function namesIn(rest: string): NameAt[] {
  const found: NameAt[] = [];
  for (const m of rest.matchAll(new RegExp(NAME_MARKER_SOURCE, 'gi'))) {
    // Past the leading whitespace the source captures, so the caret lands on
    // the `[` rather than in front of it.
    const at = m.index! + (m[0].length - m[0].trimStart().length);
    for (const name of m[1]!.split(',')) found.push({ name: name.trim(), at, prose: false });
  }
  for (const m of rest.matchAll(new RegExp(PROSE_NAME_SOURCE, 'gi'))) {
    found.push({ name: m[1]!, at: m.index!, prose: true });
  }
  return found.sort((a, b) => a.at - b.at);
}

function distinct(names: readonly string[]): string[] {
  return [...new Set(names)];
}

/**
 * `{ text, explicitNames, defines }` when the step opens `[use ai]`, or null
 * when it does not.
 *
 * Deliberately NOT a validator: a line with no step after the token, or with
 * two names, still answers here, so that the runner can refuse it by name on
 * the paths that never parse a file (Sessions API POSTs, errands, hook
 * lines) instead of handing it to a page model as prose. The refusal itself
 * is {@link useStepError}'s, and the runner asks it.
 */
export function parseUseAiStep(instruction: string): ParsedUseAiStep | null {
  const source = normalise(instruction);
  const prefix = USE_AI_PREFIX_RE.exec(source);
  if (!prefix) return null;
  const rest = source.slice(prefix[0].length);
  const names = namesIn(rest);
  return {
    text: rest.replace(new RegExp(NAME_MARKER_SOURCE, 'gi'), '').trim(),
    explicitNames: distinct(names.map((n) => n.name)),
    defines: distinct(names.filter((n) => n.prose).map((n) => n.name)),
  };
}

/**
 * The refusal for a `[use ai]` line whose token is well-formed and whose step
 * is not: nothing to ask, or more than one name. Null when the step is fine.
 */
function useAiStepShapeError(source: string, lead: string): string | null {
  const prefix = USE_AI_PREFIX_RE.exec(source)!;
  const rest = source.slice(prefix[0].length);
  const text = rest.replace(new RegExp(NAME_MARKER_SOURCE, 'gi'), '').trim();
  if (text === '') {
    return withCaret(
      `${lead}. \`[use ai]\` needs a step after it: what should the model produce? ` +
        'Write it after the `]` — `[use ai] Create a customer name [store as: name]`.',
      source,
      prefix[0].length,
    );
  }
  const names = namesIn(rest);
  const unique = distinct(names.map((n) => n.name));
  if (unique.length > 1) {
    // The caret goes on the first mention of the SECOND name — the point
    // where the line stopped naming one value.
    const second = names.find((n) => n.name === unique[1])!;
    return withCaret(
      `${lead}. A \`[use ai]\` step produces one value, and this one names ` +
        `${unique.length}: ${unique.map((n) => `\`${n}\``).join(', ')}. Keep one name.`,
      source,
      prefix[0].length + second.at,
    );
  }
  return null;
}

/**
 * The refusal for a `[use ai]` token that does not open the step.
 *
 * Refused rather than left as prose: the bracket is unambiguous intent, and
 * left alone it would reach the page model as part of a sentence — the
 * failure the family's bracket spelling exists to prevent (§4.2). A control
 * line's tail gets its own sentence, because the fix is different: a tail is
 * one ordinary step, and a `[use ai]` step is not one in this story.
 */
function misplacedUseAiError(source: string, lead: string): string | null {
  const token = USE_AI_ANYWHERE_RE.exec(source);
  if (!token) return null;
  if (CONTROL_HEAD_RE.test(source)) {
    return withCaret(
      `${lead}. A \`[use ai]\` step cannot be the step a control line runs. ` +
        'Put it in a `### Section` and name that section as the step to run instead.',
      source,
      token.index,
    );
  }
  const without = (source.slice(0, token.index) + ' ' + source.slice(token.index + token[0].length))
    .replace(/[ \t]+/g, ' ')
    .trim();
  return withCaret(
    `${lead}. Put \`[use ai]\` at the start of the step — it says the whole step is ` +
      `a question for the model: \`[use ai] ${without}\`.`,
    source,
    token.index,
  );
}

/** Skip spaces and tabs — the tokenizer's `skipInlineSpace`, in one line. */
function skipInlineSpace(source: string, from: number): number {
  let i = from;
  while (i < source.length && (source[i] === ' ' || source[i] === '\t')) i++;
  return i;
}

/**
 * A reason plus the source line and a caret under the offending column — the
 * shape `formatMessage` in invocation-parser.ts produces, so a `[use …]`
 * refusal and a `[skill: …]` refusal read as one diagnostic style.
 *
 * The caret is measured against the NORMALISED line, which is also what is
 * printed, so the two can never be out of step by the width of a stripped
 * `[no-hooks]` marker.
 */
function withCaret(reason: string, source: string, column: number): string {
  return `${reason}\n  ${source}\n  ${' '.repeat(Math.max(0, column))}^`;
}

/** The sentence that describes the family as it is, written once: two
 *  surfaces switched as whole steps, and one per-step form that switches
 *  nothing. */
const THE_FAMILY =
  '`[use computer]` (the operating system\'s screen) and `[use browser]` (the ' +
  'page) switch the surface as whole steps, and `[use ai] <step>` asks the ' +
  'model for a value';

/**
 * The parse error for a line that claims the form and does not complete it,
 * or for a `[use ai]` token anywhere but the start of the step — or null when
 * the line parses, or never mentions the family at all.
 *
 * `where` is appended verbatim (e.g. ` in tests/foo.md at line 7`) so one
 * message serves the markdown parser, the MCP assembler and anything else
 * that validates ahead of a run — the `setStepError` convention.
 *
 * The four surface refusals are §4.1's, in the order a reader meets them
 * scanning the line left to right: no target, unknown target, arguments,
 * trailing text. `[use ai]` adds three of its own (stories/use-ai-step.md
 * §Design): nothing after the token, more than one name, and the token
 * somewhere other than the start — with a control line's tail named apart.
 */
export function useStepError(instruction: string, where = ''): string | null {
  const source = normalise(instruction);
  const lead = `Cannot parse the step "${source}"${where}`;
  if (!CLAIM_RE.test(source)) return misplacedUseAiError(source, lead);
  if (parseUseStep(source) !== null) return null;
  if (USE_AI_PREFIX_RE.test(source)) return useAiStepShapeError(source, lead);

  // Past `[use`, then `Sep := WS? ':' WS? | WS`.
  let i = skipInlineSpace(source, '[use'.length);
  if (source[i] === ':') i = skipInlineSpace(source, i + 1);

  // The target, read up to whitespace or the closing bracket. Deliberately
  // wider than `(computer|browser)`: the error has to be able to QUOTE what
  // the author wrote, and `[use pho ne]` should blame `pho`, not the shape.
  const nameStart = i;
  while (i < source.length && source[i] !== ' ' && source[i] !== '\t' && source[i] !== ']') i++;
  const name = source.slice(nameStart, i);

  if (name === '') {
    return withCaret(`${lead}. \`[use]\` names no surface — ${THE_FAMILY}.`, source, nameStart);
  }
  const isAi = name.toLowerCase() === 'ai';
  if (!isAi && !USE_SURFACES.includes(name.toLowerCase() as Surface)) {
    return withCaret(
      `${lead}. \`${name}\` is not a surface this framework drives — ${THE_FAMILY}.`,
      source,
      nameStart,
    );
  }

  const afterName = skipInlineSpace(source, i);
  if (afterName >= source.length) {
    return withCaret(
      `${lead}. The directive is not closed — expected \`]\` after \`${name}\`.`,
      source,
      afterName,
    );
  }
  if (source[afterName] !== ']') {
    const argument = source.slice(afterName).split(/[\s\]]/)[0];
    return withCaret(
      isAi
        ? `${lead}. \`[use ai]\` takes no arguments — the step goes after the \`]\`, ` +
            `so remove \`${argument}\`.`
        : `${lead}. \`[use ${name}]\` takes no arguments — the surface is the whole ` +
            `directive, so remove \`${argument}\`.`,
      source,
      afterName,
    );
  }

  // Past the `]`. Anything left is §4.1's fourth refusal: the directive is the
  // whole step, and trailing text is an error rather than a second step.
  const rest = source.slice(afterName + 1);
  const trailing = rest.trimStart();
  if (trailing !== '') {
    return withCaret(
      `${lead}. \`[use ${name}]\` is the whole step, so nothing may follow it — ` +
        `move \`${trailing}\` into its own numbered step.`,
      source,
      afterName + 1 + (rest.length - trailing.length),
    );
  }

  // Unreachable: a claim with a legal target, a closing bracket and no
  // trailing text is exactly what `USE_STEP_RE` matches — and a closed
  // `[use ai]` token was answered above, by `useAiStepShapeError`. Kept as a
  // backstop rather than a `throw`, because a silent `null` here would put the
  // line back in front of a model, which is the one outcome this file exists
  // to prevent.
  return withCaret(`${lead}. ${THE_FAMILY[0]!.toUpperCase()}${THE_FAMILY.slice(1)}.`, source, 0);
}

/**
 * `[use computer]` / `[use browser]` — the two whole-step directives that
 * switch the surface a test drives (docs/specs/SPEC-use-computer.md §4.1).
 *
 * Two entry points, and the split is `set-step.ts`'s:
 *
 *  - {@link parseUseStep} is what every RUNTIME asks. It answers "is this a
 *    surface switch, and which surface" and nothing else, so a loop can branch
 *    on it cheaply. Like `parseSetStep` it is matched against the step as
 *    AUTHORED, before `{{…}}` interpolation — a directive assembled out of a
 *    substituted value is not one an author wrote, and the surface a run
 *    drives must be readable from the file.
 *  - {@link useStepError} is what a PARSE-TIME validator asks. A line opening
 *    `[use` has CLAIMED the form the way `[skill:` claims one, so a claim that
 *    does not complete is an error naming the line rather than prose handed to
 *    a model — the §4.2 failure this directive's bracket spelling exists to
 *    make impossible. It runs where `setStepError` runs: the `## Steps` main
 *    flow and every `### Section` body of a test or skill, plus MCP-supplied
 *    steps, and NOT over `## Hooks` entries, project `defaultHooks`, or steps
 *    posted straight to the Sessions API. (§4.4 refuses `[use …]` in a hook
 *    outright — that is the hook loader's rule, not this module's.)
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
 * import `src/`; and it is loaded DIRECTLY as `.ts` by testbench-native's
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
 *  here — {@link useStepError} is what turns that into a diagnostic. */
export function parseUseStep(instruction: string): ParsedUseStep | null {
  const match = USE_STEP_RE.exec(normalise(instruction));
  if (!match) return null;
  return { surface: match[1]!.toLowerCase() as Surface };
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

/** The sentence that names the closed set, written once. */
const THE_TWO =
  'the two surfaces are `computer` (the operating system\'s screen) and ' +
  '`browser` (the page), so write `[use computer]` or `[use browser]`';

/**
 * The parse error for a line that claims the form and does not complete it,
 * or null when the line either parses or never claimed.
 *
 * `where` is appended verbatim (e.g. ` in tests/foo.md at line 7`) so one
 * message serves the markdown parser, the MCP assembler and anything else
 * that validates ahead of a run — the `setStepError` convention.
 *
 * The four refusals are §4.1's, in the order a reader meets them scanning the
 * line left to right: no target, unknown target, arguments, trailing text.
 */
export function useStepError(instruction: string, where = ''): string | null {
  const source = normalise(instruction);
  if (!CLAIM_RE.test(source)) return null;
  if (parseUseStep(source) !== null) return null;

  const lead = `Cannot parse the step "${source}"${where}`;

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
    return withCaret(`${lead}. \`[use]\` names no surface — ${THE_TWO}.`, source, nameStart);
  }
  if (!USE_SURFACES.includes(name.toLowerCase() as Surface)) {
    return withCaret(
      `${lead}. \`${name}\` is not a surface this framework drives — ${THE_TWO}.`,
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
      `${lead}. \`[use ${name}]\` takes no arguments — the surface is the whole ` +
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
  // trailing text is exactly what `USE_STEP_RE` matches. Kept as a backstop
  // rather than a `throw`, because a silent `null` here would put the line
  // back in front of a model, which is the one outcome this file exists to
  // prevent.
  return withCaret(`${lead}. ${THE_TWO[0]!.toUpperCase()}${THE_TWO.slice(1)}.`, source, 0);
}

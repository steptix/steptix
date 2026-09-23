/**
 * The client-side mirror of `[use computer]` / `[use browser]`
 * (docs/specs/SPEC-use-computer.md §4.1; the original is
 * `src/parser/use-step.ts`).
 *
 * runner-core cannot import `src/` — it is bundled into the extensions and the
 * CLI is not a dependency — so the grammar below is a hand copy, kept honest
 * by `tests/use-step-parity.test.ts`, which feeds one corpus to both
 * implementations and compares every answer including the diagnostic text.
 * Changing a separator class, a surface name or a refusal wording means
 * editing both files; the parity test is what says so out loud.
 *
 * What the client needs this for is §10.3: paint the line as a directive, show
 * the §4.1 refusals as squiggles before a run, offer the two spellings in the
 * bracket completion beside `[skill:`, and classify the line as non-steppable
 * for F11.
 *
 * `useStepError` IS mirrored here, and that is the one place this file departs
 * from `control-line.ts`'s mirror, which deliberately leaves `controlLineError`
 * behind. The reason for that omission was that the client's job is to know
 * what RESOLVES, and an unparseable control line resolves to nothing. §10.3
 * asks for something different: the editor must underline `[use phone]` before
 * a run, with the message the CLI would give, or the author meets the refusal
 * for the first time from a server that has already opened a browser.
 *
 * Import-free, exactly as the original is, so the mirror is cheapest to keep
 * honest and so testbench-native's suite can load either side directly under
 * Node's type stripping.
 */

/** The two surfaces, and the closed set the grammar admits. */
export type Surface = 'computer' | 'browser';

export interface ParsedUseStep {
  /** The surface the run switches to. */
  surface: Surface;
}

/** The surfaces in the order every message lists them. */
export const USE_SURFACES: readonly Surface[] = ['computer', 'browser'];

/** Matches `NO_HOOKS_MARKER` in section-match.ts — duplicated to keep this
 *  module import-free, exactly as the original does. */
const NO_HOOKS_PREFIX = /^\[no-hooks\]\s*/i;

/**
 * THE claim: `[use` at the START of the step, followed by `:`, inline
 * whitespace, or the closing `]`.
 *
 * The separator class is `[ \t:]` and not `\s`, for the reason
 * `invocationTokenPattern` gives; `]` joins them so the bare `[use]` is a
 * claim and gets the message naming the two surfaces rather than the generic
 * unknown-bracket list. Case-INSENSITIVE, because the runner reads the
 * directive that way (§4.1).
 */
const CLAIM_RE = /^\[use(?=[ \t:\]])/i;

/** The complete form: `Sep := WS? ':' WS? | WS`, a name from the closed set,
 *  optional space, and `$` — which makes trailing text an error. */
const USE_STEP_RE = /^\[use(?:[ \t]*:[ \t]*|[ \t]+)(computer|browser)[ \t]*\]$/i;

function normalise(instruction: string): string {
  return instruction.trim().replace(NO_HOOKS_PREFIX, '').trim();
}

/** True when the line opens `[use` — whether or not it completes. */
export function isUseStepClaim(instruction: string): boolean {
  return CLAIM_RE.test(normalise(instruction));
}

/** `{ surface }`, or null when the line is not a surface switch at all. */
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

/** A reason plus the source line and a caret under the offending column —
 *  `formatMessage`'s shape in src/parser/invocation-parser.ts. */
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
 * `where` is appended verbatim, the `setStepError` convention. The four
 * refusals are §4.1's, in the order a reader meets them scanning the line left
 * to right: no target, unknown target, arguments, trailing text.
 */
export function useStepError(instruction: string, where = ''): string | null {
  const source = normalise(instruction);
  if (!CLAIM_RE.test(source)) return null;
  if (parseUseStep(source) !== null) return null;

  const lead = `Cannot parse the step "${source}"${where}`;

  let i = skipInlineSpace(source, '[use'.length);
  if (source[i] === ':') i = skipInlineSpace(source, i + 1);

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

  return withCaret(`${lead}. ${THE_TWO[0]!.toUpperCase()}${THE_TWO.slice(1)}.`, source, 0);
}

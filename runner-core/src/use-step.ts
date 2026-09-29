/**
 * The client-side mirror of `[use computer]` / `[use browser]`
 * (docs/specs/SPEC-use-computer.md §4.1) and of `[use ai] <step>`
 * (stories/use-ai-step.md); the original is `src/parser/use-step.ts`.
 *
 * runner-core cannot import `src/` — it is bundled into the extensions and the
 * CLI is not a dependency — so the grammar below is a hand copy, kept honest
 * by `tests/use-step-parity.test.ts`, which feeds one corpus to both
 * implementations and compares every answer including the diagnostic text.
 * Changing a separator class, a surface name or a refusal wording means
 * editing both files; the parity test is what says so out loud.
 *
 * What the client needs this for is §10.3: paint the line as a directive, show
 * the §4.1 refusals as squiggles before a run, offer the spellings in the
 * bracket completion beside `[skill:`, and classify the line as non-steppable
 * for F11 — which a `[use ai]` step is too, since it never has code-behind.
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
 * honest and so steptix-vscode's suite can load either side directly under
 * Node's type stripping. Every decision below is argued in the original's
 * comments and not repeated here.
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
 * claim and gets the message naming the family rather than the generic
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

/** `{ surface }`, or null when the line is not a surface switch at all — a
 *  `[use ai] …` step included, which switches nothing. */
export function parseUseStep(instruction: string): ParsedUseStep | null {
  const match = USE_STEP_RE.exec(normalise(instruction));
  if (!match) return null;
  return { surface: match[1]!.toLowerCase() as Surface };
}

// ---------------------------------------------------------------------------
// `[use ai] <step>` (stories/use-ai-step.md)
// ---------------------------------------------------------------------------

/** A `[use ai] <step>` line — the original's shape, field for field. */
export interface ParsedUseAiStep {
  /** The step after `[use ai]`, bracket name markers removed. */
  text: string;
  /** The distinct names the step pins, bracket markers and prose alike. */
  explicitNames: string[];
  /** The prose names (`store as {{x}}`), which are definitions. */
  defines: string[];
}

const USE_AI_TOKEN_SOURCE = '\\[use(?:[ \\t]*:[ \\t]*|[ \\t]+)ai[ \\t]*\\]';
const USE_AI_PREFIX_RE = new RegExp(`^${USE_AI_TOKEN_SOURCE}`, 'i');
const USE_AI_ANYWHERE_RE = new RegExp(USE_AI_TOKEN_SOURCE, 'i');

const NAME_MARKER_SOURCE =
  '[ \\t]*\\[(?:store[ \\t]+as|as|output)[ \\t]*:[ \\t]*(\\w+(?:[ \\t]*,[ \\t]*\\w+)*)[ \\t]*\\]';

const PROSE_NAME_SOURCE = '\\b(?:store|save)\\s+(?:it\\s+)?as\\s+\\{\\{\\s*(\\w+)\\s*\\}\\}';

const CONTROL_HEAD_RE = /^(?:if|else[ \t]+if|otherwise|while|repeat|for[ \t]+each)\b/i;

interface NameAt {
  name: string;
  at: number;
  prose: boolean;
}

function namesIn(rest: string): NameAt[] {
  const found: NameAt[] = [];
  for (const m of rest.matchAll(new RegExp(NAME_MARKER_SOURCE, 'gi'))) {
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

/** `{ text, explicitNames, defines }` when the step opens `[use ai]`, or null
 *  when it does not. Not a validator — see the original. */
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

/** A reason plus the source line and a caret under the offending column —
 *  `formatMessage`'s shape in src/parser/invocation-parser.ts. */
function withCaret(reason: string, source: string, column: number): string {
  return `${reason}\n  ${source}\n  ${' '.repeat(Math.max(0, column))}^`;
}

/** The sentence that describes the family, written once. */
const THE_FAMILY =
  '`[use computer]` (the operating system\'s screen) and `[use browser]` (the ' +
  'page) switch the surface as whole steps, and `[use ai] <step>` asks the ' +
  'model for a value';

/**
 * The parse error for a line that claims the form and does not complete it,
 * or for a `[use ai]` token anywhere but the start of the step — or null when
 * the line parses, or never mentions the family at all.
 *
 * `where` is appended verbatim, the `setStepError` convention.
 */
export function useStepError(instruction: string, where = ''): string | null {
  const source = normalise(instruction);
  const lead = `Cannot parse the step "${source}"${where}`;
  if (!CLAIM_RE.test(source)) return misplacedUseAiError(source, lead);
  if (parseUseStep(source) !== null) return null;
  if (USE_AI_PREFIX_RE.test(source)) return useAiStepShapeError(source, lead);

  let i = skipInlineSpace(source, '[use'.length);
  if (source[i] === ':') i = skipInlineSpace(source, i + 1);

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

  return withCaret(`${lead}. ${THE_FAMILY[0]!.toUpperCase()}${THE_FAMILY.slice(1)}.`, source, 0);
}

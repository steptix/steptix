/**
 * The client-side mirror of §4.2 — **a step whose ENTIRE text is a single
 * bracket token that matches no directive is a parse error**
 * (docs/specs/SPEC-use-computer.md; the original is
 * `src/parser/whole-step-bracket.ts`).
 *
 * runner-core cannot import `src/`, so the rule below is a hand copy, pinned
 * by `tests/use-step-parity.test.ts` — which compares the message text as well
 * as the verdict, because the editor and the CLI refuse the same line and an
 * author who reads two different sentences about it learns to distrust both.
 *
 * What the client needs it for is §10.3: the editor squiggles `[computer]`
 * while it is being typed, rather than letting the author discover at run time
 * that a bracket step nobody parses is answered with a silent `noop` and
 * reported as passed.
 *
 * Every decision — what counts as one token, which directives count as known,
 * why known-ness is case-insensitive, why the inline markers are on the list —
 * is argued in the original's docstring and not repeated here, so there is one
 * place to read it and one place to change it.
 */

/** One bracket token and nothing else. */
const WHOLE_STEP_BRACKET_RE = /^\[[^\]]*\]$/;

/** Matches `NO_HOOKS_MARKER` in section-match.ts — duplicated to keep this
 *  module import-free, exactly as the original does. */
const NO_HOOKS_PREFIX = /^\[no-hooks\]\s*/i;

/** The tokens that ARE directives. `use` admits `]` so the bare `[use]` falls
 *  to `useStepError`, which names the family; `skill` / `tool` / `input`
 *  do not, so a bare `[skill]` is told what the form is. */
const KNOWN_DIRECTIVE_RES: readonly RegExp[] = [
  /^\[(?:skill|tool|input)(?=[ \t:])/i,
  /^\[use(?=[ \t:\]])/i,
  /^\[interactive[ \t]*\]$/i,
  /^\[(?:output|as|store[ \t]+as)[ \t]*:/i,
];

/** The directives as an author writes them, for the message and the
 *  did-you-mean. Concrete spellings, because "did you mean `[use …]`" is not
 *  something anyone can type. */
export const KNOWN_WHOLE_STEP_DIRECTIVES: readonly string[] = [
  '[use computer]',
  '[use browser]',
  '[interactive]',
  '[skill: name]',
  '[tool: name]',
  '[input: name]',
];

/** How close a known directive must be before the message offers it. */
export const DID_YOU_MEAN_MAX_DISTANCE = 6;

function normalise(instruction: string): string {
  return instruction.trim().replace(NO_HOOKS_PREFIX, '').trim();
}

/** True when the whole step is one bracket token — whether or not it names a
 *  directive. What a caller asks when it wants to know the rule APPLIES. */
export function isWholeStepBracket(instruction: string): boolean {
  return WHOLE_STEP_BRACKET_RE.test(normalise(instruction));
}

/** True when the whole step is one bracket token naming a known directive. */
export function isKnownWholeStepDirective(instruction: string): boolean {
  const source = normalise(instruction);
  if (!WHOLE_STEP_BRACKET_RE.test(source)) return false;
  return KNOWN_DIRECTIVE_RES.some((re) => re.test(source));
}

/** The nearest known directive to `token`, or null when nothing is near
 *  enough. Ties go to the earlier candidate. */
export function closestDirective(token: string): string | null {
  const needle = normalise(token).toLowerCase();
  let best: string | null = null;
  let bestDistance = DID_YOU_MEAN_MAX_DISTANCE + 1;
  for (const candidate of KNOWN_WHOLE_STEP_DIRECTIVES) {
    const distance = editDistance(needle, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return bestDistance <= DID_YOU_MEAN_MAX_DISTANCE ? best : null;
}

/** The directive list as one phrase, written once. `[use ai] <step>` is a
 *  form rather than a whole-step token, so it is listed here and is not a
 *  did-you-mean candidate — see the original. */
const DIRECTIVE_LIST =
  '`[skill: name]`, `[tool: name]`, `[input: name]`, `[interactive]`, ' +
  '`[use computer]`, `[use browser]` and `[use ai] <step>`';

/**
 * The parse error for a whole-step bracket token that is no directive, or
 * null when the step either names one or is not a whole-step bracket at all.
 */
export function unknownWholeStepBracketError(
  instruction: string,
  where = '',
): string | null {
  const source = normalise(instruction);
  if (!WHOLE_STEP_BRACKET_RE.test(source)) return null;
  if (KNOWN_DIRECTIVE_RES.some((re) => re.test(source))) return null;

  const suggestion = closestDirective(source);
  return (
    `Cannot parse the step "${source}"${where}. A step that is nothing but a ` +
    `bracket token is read as a directive, and \`${source}\` is not one. The ` +
    `directives are ${DIRECTIVE_LIST}.` +
    (suggestion === null ? '' : ` Did you mean \`${suggestion}\`?`) +
    ` If it was meant as an instruction for the model, write it without the ` +
    `brackets — a bracket step nobody parses is answered with a silent no-op ` +
    `and reported as passed.`
  );
}

/** Levenshtein distance, capped one past {@link DID_YOU_MEAN_MAX_DISTANCE}.
 *  A copy of the original's, cap included — see its docstring for why the
 *  three copies in the tree are not shared. */
function editDistance(a: string, b: string): number {
  const cap = DID_YOU_MEAN_MAX_DISTANCE + 1;
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > DID_YOU_MEAN_MAX_DISTANCE) return cap;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0]!;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > DID_YOU_MEAN_MAX_DISTANCE) return cap;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/**
 * §4.2 of docs/specs/SPEC-use-computer.md: **a step whose ENTIRE text is a
 * single bracket token that matches no directive is a parse error.**
 *
 * This is the rule that earns `[use computer]` its bracket spelling. Before
 * it, a made-up directive — `[computer]`, `[dekstop]`, `[computer-use]` —
 * parsed as prose and was handed to a model, which answered it with a silent
 * `noop` and a green step. The step never ran, the report said it did, and
 * nothing anywhere named the typo.
 *
 * The rule is narrow on purpose, and the narrowness is the whole design:
 *
 *  - Only a step that is NOTHING BUT one bracket token is judged. A bracket
 *    inside a longer step stays prose, so `[skillful]` and `Verify the
 *    [optional] banner` are exactly as they were.
 *  - Only the FIRST `]` closing at the very end counts as "one token", so a
 *    step carrying two brackets, or a JSON array argument, is not judged
 *    either — those are longer steps by construction.
 *
 * **What counts as known.** The five step directives §4.2 lists —
 * `[skill …]`, `[tool …]`, `[input …]`, `[interactive]`, `[use …]` — plus the
 * INLINE markers `[output: x]`, `[as: x]` and `[store as: x]`, which are legal
 * anywhere in a step and therefore legal alone in one. Leaving those three out
 * would turn a degenerate-but-legal line into a new parse error on files that
 * run today, which is a bigger cost than the rule's benefit on lines nobody
 * writes. (`[no-hooks]` needs no entry: {@link normalise} strips it, and a
 * step that was only the marker is left empty rather than bracketed.)
 *
 * Known-ness is tested case-INSENSITIVELY, which is wider than the runner in
 * one place: `[SKILL: login]` is prose to `parseInvocation` (case-sensitive,
 * deliberately) yet counts as known here. That is the conservative direction.
 * This rule's job is to catch INVENTED directives, and "did you mean
 * `[skill: name]`?" is a poor way to tell an author their only mistake was a
 * shift key — while flagging it would make §4.2 a behaviour change for files
 * that merely shout.
 *
 * Import-free for the reason `use-step.ts` gives: `runner-core` mirrors it and
 * cannot import `src/`, and steptix-vscode's mirror suite loads it directly
 * as `.ts` under Node's type stripping. That is why the `[use` claim below is
 * a copy of `CLAIM_RE` rather than an import of it;
 * `tests/use-step-parity.test.ts` is what keeps the copies honest.
 */

/** One bracket token and nothing else: `[`, no further `]`, then `]` at the
 *  very end of the (trimmed, marker-stripped) step. */
const WHOLE_STEP_BRACKET_RE = /^\[[^\]]*\]$/;

/** The `[no-hooks]` prefix, matching `NO_HOOKS_MARKER` in section-match.ts. */
const NO_HOOKS_PREFIX = /^\[no-hooks\]\s*/i;

/**
 * The tokens that ARE directives.
 *
 * `skill` / `tool` / `input` demand a `[ \t:]` separator, matching
 * `invocationTokenPattern`'s class — so a bare `[skill]` or `[input]` is an
 * unknown bracket and gets told what the form is, which is the right answer
 * for a line that names no skill.
 *
 * `use` admits `]` as well, so the bare `[use]` is NOT reported here: it is a
 * `[use` claim, and `useStepError` owns it with a message that names the
 * family. Every caller asks `useStepError` first for that reason — and the
 * same holds for a bare `[use ai]`, which is told it needs a step after it.
 */
const KNOWN_DIRECTIVE_RES: readonly RegExp[] = [
  /^\[(?:skill|tool|input)(?=[ \t:])/i,
  /^\[use(?=[ \t:\]])/i,
  /^\[interactive[ \t]*\]$/i,
  /^\[(?:output|as|store[ \t]+as)[ \t]*:/i,
];

/** The directives as an author writes them, for the message and for the
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

/** How close a known directive must be before the message offers it.
 *
 *  Six, measured rather than picked: `[computer]` → `[use computer]` is four
 *  edits and is the case §4.2's own text promises to catch, `[computer-use]`
 *  → `[use computer]` is six, and the nearest thing to `[dekstop]` is well
 *  past both — which is the answer that should stay silent, because an
 *  invented word nobody can map is better served by the list alone than by a
 *  confident wrong guess. */
export const DID_YOU_MEAN_MAX_DISTANCE = 6;

/** The instruction as the rule sees it: trimmed, marker removed. */
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

/**
 * The nearest known directive to `token`, or null when nothing is near enough.
 *
 * Ties go to the earlier candidate, which is why
 * {@link KNOWN_WHOLE_STEP_DIRECTIVES} leads with the two surfaces: they are
 * the new spelling, and the new spelling is what an author is most likely to
 * have reached for and missed.
 */
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

/** The directive list as one phrase, written once. `[use ai] <step>` is on it
 *  as a form rather than a token — it is never a whole step on its own, so it
 *  is not a did-you-mean candidate ({@link KNOWN_WHOLE_STEP_DIRECTIVES}), but
 *  an author told "the directives are…" should be told all of them. */
const DIRECTIVE_LIST =
  '`[skill: name]`, `[tool: name]`, `[input: name]`, `[interactive]`, ' +
  '`[use computer]`, `[use browser]` and `[use ai] <step>`';

/**
 * The parse error for a whole-step bracket token that is no directive, or
 * null when the step either names one or is not a whole-step bracket at all.
 *
 * `where` is appended verbatim (e.g. ` in tests/foo.md at line 7`), the
 * `setStepError` convention.
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

/**
 * Levenshtein distance, capped one past {@link DID_YOU_MEAN_MAX_DISTANCE}.
 *
 * A third copy of this algorithm in the tree, and deliberately so: the other
 * two are `section-diagnostics-core.ts`'s (capped at 2, for section near
 * misses) and its runner-core sibling. Sharing one would mean importing it,
 * and this module is import-free for the reasons its docstring gives. The
 * cost of a copy is low — the function is a fixed algorithm with a test — and
 * the cap is the only thing that differs.
 */
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

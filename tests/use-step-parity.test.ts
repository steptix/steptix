import { describe, it, expect } from 'vitest';
import {
  isUseStepClaim as cliClaims,
  parseUseAiStep as cliParseAi,
  parseUseStep as cliParse,
  useStepError as cliError,
  USE_SURFACES as cliSurfaces,
} from '../src/parser/use-step.js';
import {
  closestDirective as cliClosest,
  isKnownWholeStepDirective as cliKnown,
  isWholeStepBracket as cliBracket,
  unknownWholeStepBracketError as cliBracketError,
  KNOWN_WHOLE_STEP_DIRECTIVES as cliDirectives,
  DID_YOU_MEAN_MAX_DISTANCE as cliDistance,
} from '../src/parser/whole-step-bracket.js';
import {
  isUseStepClaim as coreClaims,
  parseUseAiStep as coreParseAi,
  parseUseStep as coreParse,
  useStepError as coreError,
  USE_SURFACES as coreSurfaces,
  // runner-core's SOURCE, not its `dist/`. Nothing in this repo's `npm test`
  // path builds runner-core, so importing the compiled copy would ask this
  // corpus about whatever the mirror used to be — the trap
  // `tests/control-line-parity.test.ts` measured and documented. Vitest
  // transforms the `.ts` on the way in.
} from '../runner-core/src/use-step.ts';
import {
  closestDirective as coreClosest,
  isKnownWholeStepDirective as coreKnown,
  isWholeStepBracket as coreBracket,
  unknownWholeStepBracketError as coreBracketError,
  KNOWN_WHOLE_STEP_DIRECTIVES as coreDirectives,
  DID_YOU_MEAN_MAX_DISTANCE as coreDistance,
} from '../runner-core/src/whole-step-bracket.ts';

/**
 * The CLI's `[use …]` grammar and runner-core's mirror of it, fed one corpus
 * and compared answer for answer — including the refusal TEXT, which is where
 * this pair differs from the control-line one.
 *
 * runner-core cannot import `src/`, so the grammar is implemented twice. What
 * makes drift here expensive is that the two answers are used for different
 * halves of the same promise: the CLI's decides what RUNS, the mirror's
 * decides what the editor UNDERLINES, what the bracket completion offers, and
 * whether F11 arms a code-behind flag on a line that can never have an entry.
 *
 * The messages are compared, not just the verdicts, because both sides refuse
 * the SAME line — the editor while typing, the parser at run time — and an
 * author who reads two different sentences about one line learns to distrust
 * both. `control-line.ts`'s mirror deliberately omits `controlLineError` for a
 * reason that does not hold here (§10.3 asks for the squiggle), so the wording
 * had to cross the boundary and therefore has to be pinned.
 *
 * There is a project memory about exactly this shape: a regex copying a parser
 * grammar merges cleanly and breaks silently, so the pair is the only thing
 * that says a rebase went wrong.
 */

const CORPUS = [
  // ── the forms, plainly ───────────────────────────────────────────────
  '[use computer]',
  '[use browser]',
  '[use: browser]',
  '[use:computer]',
  '[use : browser]',

  // ── casing, whitespace and the marker ────────────────────────────────
  '[USE COMPUTER]',
  '[Use Browser]',
  '[uSe: CoMpUtEr]',
  '   [use computer]   ',
  '[use  computer]',
  '[use computer ]',
  '[use\tcomputer]',
  '[use\t:\tbrowser]',
  // A NON-BREAKING space, which `\s` matches and `[ \t]` does not. This is the
  // one line that distinguishes the separator class either side could widen
  // by accident — `invocationTokenPattern` argues the same point for
  // `[skill<NBSP>login]`, and nothing else in the corpus would say.
  '[use\u00a0computer]',
  '[no-hooks] [use computer]',
  '[NO-HOOKS][use browser]',
  '[no-hooks] [use phone]',

  // ── the four §4.1 refusals, each carrying a caret column ─────────────
  '[use]',
  '[use ]',
  '[use:]',
  '[use phone]',
  '[use Phone]',
  '[use computer timeout=30]',
  '[use browser retries=2 out.x="y"]',
  '[use computer] and click Save',
  '[use browser].',
  '[use computer',
  '[use browser',
  // A second `]`, which is trailing text rather than a second directive.
  '[use computer]]',
  // A target that is not a lexable identifier at all — the error has to be
  // able to QUOTE it, which is why the name class is wider than the grammar.
  '[use comp uter]',
  '[use ":"]',

  // ── near misses on the token itself, which must stay prose ───────────
  '[used]',
  '[user guide]',
  '[useful]',
  '[use-computer]',
  '[uses: computer]',

  // ── prose, which must stay prose in both ─────────────────────────────
  'Click the Save button',
  'Verify the [use of cookies] banner is shown',
  'Read the terms on [use browser] and confirm',
  '[skill: login]',
  '[tool: echo value="hi"]',
  '[input: pin] Enter your PIN',
  '[interactive]',
  'Set {{x}} to "y"',
  'If a dialog is open, then [use computer]',
  '',
  '   ',

  // ── `[use ai] <step>` (stories/use-ai-step.md) ───────────────────────
  // The accepted forms: case, colon, whitespace, the marker, and each
  // explicit-name spelling — the fields are compared, not just the verdict.
  '[use ai] Create a name starting with "AUTO" and store it in random_name',
  '[USE AI] Write a line',
  '[use: ai] Write a line',
  '[use:ai]Write a line',
  '[use\tai ]  Write a line  ',
  '[no-hooks] [use ai] Write a line',
  '[NO-HOOKS][Use Ai] Write a line [store as: x]',
  '[use ai] Today is {{today}}. Give the date 3 days later as yyyymmdd [store as: days_from_now]',
  '[use ai] Pick a colour [as: colour]',
  '[use ai] [output: colour] Pick a colour',
  '[use ai] Pick a colour and store it as {{colour}}',
  '[use ai] Pick a colour, save as {{colour}} [store as: colour]',
  // Its refusals: nothing after it, arguments, more than one name, not at
  // the start, a control line's tail, unclosed.
  '[use ai]',
  '[use ai]   ',
  '[use ai] [store as: x]',
  '[use ai timeout=30] Write a line',
  '[use ai',
  '[use ai] Pick a colour [store as: a] [as: b]',
  '[use ai] Pick two colours [store as: a, b]',
  '[use ai] Pick a colour and store it as {{a}} [output: b]',
  'Write a random paragraph about Australia [use ai] [store as: text]',
  'If the name is empty, then [use ai] Make up a name [store as: name]',
  'Otherwise, [use: ai] Write a line',
  // Near misses that stay prose.
  'Verify the [use of ai] banner',
  '[user ai] x',
  '[use aim] x',
];

describe('src/parser/use-step.ts and runner-core/src/use-step.ts agree', () => {
  it('on what claims, and on what parses', () => {
    for (const line of CORPUS) {
      expect(coreClaims(line), line).toBe(cliClaims(line));
      expect(coreParse(line), line).toEqual(cliParse(line));
      // `[use ai]`, field for field: the text the model would read, the names
      // the step pins, and the names it defines in prose.
      expect(coreParseAi(line), line).toEqual(cliParseAi(line));
    }
  });

  it('on the refusal, character for character, with and without a location', () => {
    for (const line of CORPUS) {
      expect(coreError(line), line).toBe(cliError(line));
      expect(coreError(line, ' in tests/t.md at line 7'), line).toBe(
        cliError(line, ' in tests/t.md at line 7'),
      );
    }
  });

  it('on the closed set', () => {
    expect(coreSurfaces).toEqual(cliSurfaces);
  });

  it('the corpus reaches every branch on both sides, not just every label', () => {
    // Labels appearing says nothing about which side of each rule was
    // exercised: a branch added to one implementation and not the other is
    // only caught if some line reaches it.
    const missing: string[] = [];
    if (!CORPUS.some((l) => cliParse(l)?.surface === 'computer')) missing.push('no computer');
    if (!CORPUS.some((l) => cliParse(l)?.surface === 'browser')) missing.push('no browser');
    if (!CORPUS.some((l) => !cliClaims(l))) missing.push('no prose');
    if (!CORPUS.some((l) => cliClaims(l) && cliParse(l) !== null)) missing.push('no claim+parse');
    if (!CORPUS.some((l) => cliClaims(l) && cliParse(l) === null)) missing.push('no claim+fail');
    // Each of the four §4.1 refusals, by the phrase that identifies it.
    for (const phrase of [
      'names no surface',
      'is not a surface',
      'takes no arguments',
      'is the whole step',
      'not closed',
    ]) {
      if (!CORPUS.some((l) => cliError(l)?.includes(phrase))) missing.push(`no "${phrase}"`);
    }
    // …and the `[no-hooks]` strip, which both sides duplicate.
    if (!CORPUS.some((l) => /^\[no-hooks\]/i.test(l) && cliParse(l) !== null)) {
      missing.push('no marker+parse');
    }
    if (!CORPUS.some((l) => /^\[no-hooks\]/i.test(l) && cliError(l) !== null)) {
      missing.push('no marker+refuse');
    }
    // …and non-space whitespace at the separator, the one class that is `[ \t]`
    // rather than `\s` and would read identically if a copy widened it.
    if (!CORPUS.some((l) => l.includes('\t') && cliParse(l) !== null)) missing.push('no tab');
    // `[use ai]`: a parse with and without each kind of name, and every one of
    // its refusals by the phrase that identifies it.
    if (!CORPUS.some((l) => cliParseAi(l) !== null && cliError(l) === null)) missing.push('no ai parse');
    if (!CORPUS.some((l) => cliParseAi(l) !== null && cliParseAi(l)!.explicitNames.length === 0)) {
      missing.push('no unnamed ai');
    }
    if (!CORPUS.some((l) => (cliParseAi(l)?.defines.length ?? 0) > 0)) missing.push('no prose name');
    if (!CORPUS.some((l) => /\[(?:as|output):/.test(l) && cliParseAi(l)?.explicitNames.length === 1)) {
      missing.push('no bracket name');
    }
    for (const phrase of [
      'needs a step after it',
      '`[use ai]` takes no arguments',
      'produces one value',
      'Put `[use ai]` at the start of the step',
      'cannot be the step a control line runs',
    ]) {
      if (!CORPUS.some((l) => cliError(l)?.includes(phrase))) missing.push(`no "${phrase}"`);
    }
    // …and the NBSP line, which must be prose on BOTH sides. If a copy widens
    // the class to `\s` this row starts claiming, which is the drift the line
    // is in the corpus for.
    if (!CORPUS.some((l) => l.includes('\u00a0'))) missing.push('no nbsp');
    expect(cliClaims('[use\u00a0computer]')).toBe(false);
    expect(missing).toEqual([]);
  });
});

describe('src/parser/whole-step-bracket.ts and its runner-core mirror agree', () => {
  // The §4.2 corpus is its own, because the rule judges a different shape:
  // whole-step brackets, known and invented, plus the lines it must leave
  // alone.
  const BRACKETS = [
    ...CORPUS,
    '[computer]',
    '[dekstop]',
    '[computer-use]',
    '[desktop mode]',
    '[use the computer]',
    '[skill]',
    '[tool]',
    '[input]',
    '[interactve]',
    '[INTERACTIVE]',
    '[skil: login]',
    '[output: total]',
    '[store as: total]',
    '[as: total]',
    '[no-hooks]',
    '[a] [b]',
    '[tool: fetch arr=["a","b"]]',
    '[skillful] navigation is expected',
    'Verify the [optional] banner',
    '[]',
    '[ ]',
  ];

  it('on the shape, on what is known, and on the suggestion', () => {
    for (const line of BRACKETS) {
      expect(coreBracket(line), line).toBe(cliBracket(line));
      expect(coreKnown(line), line).toBe(cliKnown(line));
      expect(coreClosest(line), line).toBe(cliClosest(line));
    }
  });

  it('on the refusal, character for character', () => {
    for (const line of BRACKETS) {
      expect(coreBracketError(line), line).toBe(cliBracketError(line));
      expect(coreBracketError(line, ' in tests/t.md at line 7'), line).toBe(
        cliBracketError(line, ' in tests/t.md at line 7'),
      );
    }
  });

  it('on the candidate list and the distance threshold', () => {
    // The list is what the message prints AND what the did-you-mean searches,
    // so a mirror that reordered it would suggest a different directive on a
    // tie. It also feeds the extension's bracket completion.
    expect(coreDirectives).toEqual(cliDirectives);
    expect(coreDistance).toBe(cliDistance);
  });

  it('the corpus reaches every branch', () => {
    const missing: string[] = [];
    if (!BRACKETS.some((l) => !cliBracket(l))) missing.push('no non-bracket line');
    if (!BRACKETS.some((l) => cliBracket(l) && cliKnown(l))) missing.push('no known bracket');
    if (!BRACKETS.some((l) => cliBracket(l) && !cliKnown(l))) missing.push('no unknown bracket');
    if (!BRACKETS.some((l) => cliBracketError(l)?.includes('Did you mean'))) {
      missing.push('no suggestion');
    }
    if (!BRACKETS.some((l) => cliBracketError(l) !== null && !cliBracketError(l)!.includes('Did you mean'))) {
      missing.push('no silent refusal');
    }
    expect(missing).toEqual([]);
  });
});

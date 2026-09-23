import { describe, it, expect } from 'vitest';
import {
  isUseStepClaim,
  parseUseStep,
  USE_SURFACES,
  useStepError,
} from '../src/parser/use-step.js';
import {
  closestDirective,
  isKnownWholeStepDirective,
  isWholeStepBracket,
  unknownWholeStepBracketError,
} from '../src/parser/whole-step-bracket.js';
import { parseTestContent } from '../src/parser/markdown.js';
import { identifyStepGroups } from '../src/runner/step-grouper.js';
import { generationRefusal } from '../src/codebehind/live-compile.js';
import { refuseReason, SURFACE_SWITCH_NOT_COMPILED } from '../src/codebehind/generate.js';
import { validateSectionName } from '../src/parser/section-match.js';

/**
 * `[use computer]` / `[use browser]` at the grammar level, and §4.2's new
 * whole-step bracket rule beside it (docs/specs/SPEC-use-computer.md §4.1–4.4).
 *
 * Three questions, kept apart the way `control-line.test.ts` keeps them apart,
 * because they have different answers: does the line CLAIM the form, does it
 * COMPLETE it, and — for a line that claims and fails — does the refusal point
 * at the word the author has to fix. A line that never claimed is prose, and
 * that bucket is what §4.2's other half protects: a bracket INSIDE a longer
 * step is untouched.
 */

// ---------------------------------------------------------------------------
// §4.1 — the accept table
// ---------------------------------------------------------------------------

describe('§4.1 the forms that parse', () => {
  const ACCEPTED: [string, 'computer' | 'browser'][] = [
    ['[use computer]', 'computer'],
    ['[use browser]', 'browser'],
    // The colon is optional, and may carry space on either side.
    ['[use: browser]', 'browser'],
    ['[use:computer]', 'computer'],
    ['[use : browser]', 'browser'],
    // Case-insensitive on both halves of the token.
    ['[USE COMPUTER]', 'computer'],
    ['[Use Browser]', 'browser'],
    ['[uSe: CoMpUtEr]', 'computer'],
    // Whitespace-tolerant: around the step, inside the token, before the `]`.
    ['   [use computer]   ', 'computer'],
    ['[use  computer]', 'computer'],
    ['[use computer ]', 'computer'],
    ['[use\tcomputer]', 'computer'],
    // The `[no-hooks]` marker, which the parser strips itself — runner-core
    // deliberately keeps it on the wire, so the Sessions API and the errand
    // runner would otherwise see it and hand the line to a model as prose.
    ['[no-hooks] [use computer]', 'computer'],
    ['[NO-HOOKS][use browser]', 'browser'],
  ];

  it.each(ACCEPTED)('%s → %s', (line, surface) => {
    expect(parseUseStep(line)).toEqual({ surface });
    expect(isUseStepClaim(line)).toBe(true);
    expect(useStepError(line)).toBeNull();
  });

  it('the closed set is exactly the two surfaces', () => {
    expect(USE_SURFACES).toEqual(['computer', 'browser']);
  });
});

describe('§4.1 what is not a surface switch at all', () => {
  // Every one of these must answer null from BOTH entry points: not a switch,
  // and not an error either. A false claim here is a parse error on a file
  // that runs today.
  const PROSE = [
    'Click the Save button',
    // The claim is anchored at the start of the step, which is what keeps a
    // bracket INSIDE a longer step prose (§4.2's other half).
    'Verify the [use of cookies] banner is shown',
    'Read the terms on [use browser] and confirm',
    // `[use` with no separator is not the token, the same rule `[skillful]`
    // gets from `invocationTokenPattern`.
    '[used]',
    '[user guide]',
    '[useful]',
    '[use-computer]',
    // Other directives.
    '[skill: login]',
    '[tool: echo value="hi"]',
    '[input: pin] Enter your PIN',
    '[interactive]',
    'Set {{x}} to "y"',
    '',
    '   ',
  ];

  it.each(PROSE)('%s', (line) => {
    expect(parseUseStep(line)).toBeNull();
    expect(isUseStepClaim(line)).toBe(false);
    expect(useStepError(line)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §4.1 — the four refusals
// ---------------------------------------------------------------------------

describe('§4.1 the four refusals, each with a caret at the offending word', () => {
  /** The caret line of a `formatMessage`-shaped diagnostic, and the column it
   *  points at — read back rather than eyeballed, because an off-by-one caret
   *  is invisible in an expected-string comparison. */
  function caretColumn(message: string): number {
    const [, source, caret] = message.split('\n');
    expect(source).toMatch(/^ {2}/);
    expect(caret).toMatch(/^ *\^$/);
    return caret!.length - 1 - 2; // strip the two-space indent
  }

  it('[use] — no target, and the message names the two', () => {
    const message = useStepError('[use]', ' in tests/t.md at line 3')!;
    expect(message).not.toBeNull();
    expect(message).toContain('Cannot parse the step "[use]" in tests/t.md at line 3');
    expect(message).toContain('names no surface');
    expect(message).toContain('`[use computer]`');
    expect(message).toContain('`[use browser]`');
    // The caret sits where the name should have been: on the `]`.
    expect(caretColumn(message)).toBe('[use'.length);
  });

  it('[use phone] — unknown target, quoted back, message lists the two', () => {
    const message = useStepError('[use phone]')!;
    expect(message).toContain('`phone` is not a surface');
    expect(message).toContain('`[use computer]`');
    expect(message).toContain('`[use browser]`');
    expect(caretColumn(message)).toBe('[use '.length);
  });

  it('[use computer timeout=30] — arguments are not accepted', () => {
    const message = useStepError('[use computer timeout=30]')!;
    expect(message).toContain('takes no arguments');
    expect(message).toContain('remove `timeout=30`');
    expect(caretColumn(message)).toBe('[use computer '.length);
  });

  it('[use computer] and click Save — the directive is the whole step', () => {
    const message = useStepError('[use computer] and click Save')!;
    expect(message).toContain('is the whole step');
    expect(message).toContain('move `and click Save` into its own numbered step');
    expect(caretColumn(message)).toBe('[use computer] '.length);
  });

  it('an unclosed directive is named as unclosed, not as an argument', () => {
    const message = useStepError('[use computer')!;
    expect(message).toContain('not closed');
    expect(message).toContain("expected `]`");
  });

  it('every refusal claims, and none of them parses', () => {
    for (const line of [
      '[use]',
      '[use phone]',
      '[use computer timeout=30]',
      '[use computer] and click Save',
      '[use computer',
      '[use:]',
      '[no-hooks] [use phone]',
    ]) {
      expect(isUseStepClaim(line), line).toBe(true);
      expect(parseUseStep(line), line).toBeNull();
      expect(useStepError(line), line).not.toBeNull();
    }
  });

  it('the caret is measured against the line as PRINTED, marker stripped', () => {
    // The printed source is the normalised line, so a stripped `[no-hooks]`
    // cannot shift the caret off the word it blames.
    const message = useStepError('[no-hooks] [use phone]')!;
    const [reason, source] = message.split('\n');
    expect(reason).toContain('"[use phone]"');
    expect(source).toBe('  [use phone]');
  });
});

// ---------------------------------------------------------------------------
// §4.2 — unknown whole-step brackets
// ---------------------------------------------------------------------------

describe('§4.2 a whole-step bracket that names no directive is an error', () => {
  const REFUSED = ['[computer]', '[dekstop]', '[computer-use]', '[desktop mode]', '[skill]'];

  it.each(REFUSED)('%s is refused', (line) => {
    expect(isWholeStepBracket(line)).toBe(true);
    expect(isKnownWholeStepDirective(line)).toBe(false);
    const message = unknownWholeStepBracketError(line, ' in tests/t.md at line 3')!;
    expect(message).toContain(`Cannot parse the step "${line}" in tests/t.md at line 3`);
    expect(message).toContain('`[skill: name]`');
    expect(message).toContain('`[interactive]`');
    expect(message).toContain('`[use computer]`');
  });

  it('offers the closest known directive by edit distance', () => {
    expect(closestDirective('[computer]')).toBe('[use computer]');
    expect(unknownWholeStepBracketError('[computer]')).toContain(
      'Did you mean `[use computer]`?',
    );
    expect(closestDirective('[interactve]')).toBe('[interactive]');
    expect(closestDirective('[skil: login]')).toBe('[skill: name]');
  });

  it('stays silent rather than guessing when nothing is near', () => {
    expect(closestDirective('[dekstop]')).toBeNull();
    expect(unknownWholeStepBracketError('[dekstop]')).not.toContain('Did you mean');
    // …and still lists the directives, which is the part that always helps.
    expect(unknownWholeStepBracketError('[dekstop]')).toContain('`[use browser]`');
  });

  it('a bracket INSIDE a longer step is untouched — the rule judges whole steps only', () => {
    for (const line of [
      '[skillful] navigation is expected',
      'Verify the [optional] banner',
      'Check that [computer] appears in the glossary',
      // Two tokens is not one token.
      '[a] [b]',
      // …and a token that does not close at the end of the step.
      '[tool: fetch arr=["a","b"]]',
    ]) {
      expect(isWholeStepBracket(line), line).toBe(false);
      expect(unknownWholeStepBracketError(line), line).toBeNull();
    }
  });

  it('the known directives pass, case included', () => {
    for (const line of [
      '[skill: login]',
      '[skill login]',
      '[tool: echo]',
      '[input: pin]',
      '[interactive]',
      '[INTERACTIVE]',
      '[use computer]',
      '[use browser]',
      // The `[use` claim is known here too, so `useStepError` owns it and the
      // author gets the message naming the two surfaces rather than the list.
      '[use]',
      '[use phone]',
      // Inline markers, legal anywhere in a step and therefore alone in one.
      '[output: total]',
      '[store as: total]',
      '[as: total]',
      // `[no-hooks]` alone normalises to the empty string, not to a bracket.
      '[no-hooks]',
    ]) {
      expect(unknownWholeStepBracketError(line), line).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// §4.4 — where it is recognised, through the real parser
// ---------------------------------------------------------------------------

const doc = (...steps: string[]) =>
  ['# T', '', '## Steps', ...steps.map((s, i) => `${i + 1}. ${s}`), ''].join('\n');

describe('§4.4 the markdown parser refuses a malformed switch', () => {
  it('in the `## Steps` main flow', () => {
    expect(() => parseTestContent(doc('Click Save', '[use phone]'), 'tests/t.md')).toThrow(
      /`phone` is not a surface/,
    );
  });

  it('in a `### Section` body', () => {
    const text = [
      '# T',
      '',
      '## Steps',
      '1. Desktop excursion',
      '',
      '### Desktop excursion',
      '1. [use computer timeout=30]',
      '2. Click Save',
      '',
    ].join('\n');
    expect(() => parseTestContent(text, 'tests/t.md')).toThrow(/takes no arguments/);
  });

  it('and refuses §4.2\'s unknown bracket in both', () => {
    expect(() => parseTestContent(doc('[computer]'), 'tests/t.md')).toThrow(
      /Did you mean `\[use computer\]`\?/,
    );
  });

  it('a well-formed switch parses, and stays a step', () => {
    const parsed = parseTestContent(doc('Navigate to statement.pdf', '[use computer]', '[use browser]'));
    expect(parsed.steps).toEqual([
      'Navigate to statement.pdf',
      '[use computer]',
      '[use browser]',
    ]);
  });

  it('the `[use …]` message wins over the generic bracket list', () => {
    // Both rules see `[use]`. Reported by §4.2 the author would be handed a
    // list of six directives; reported by §4.1 they are told the two surfaces.
    let message = '';
    try {
      parseTestContent(doc('[use]'), 'tests/t.md');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('names no surface');
    expect(message).not.toContain('is not one. The directives are');
  });
});

// ---------------------------------------------------------------------------
// §4.3 — resolution order and tail composition
// ---------------------------------------------------------------------------

describe('§4.3 resolution order', () => {
  it('a section cannot shadow the directive, because it cannot be named one', () => {
    // Rung 1 beats rung 2 by construction rather than by a check: §2.5 already
    // refuses a section name beginning with `[`, so `### [use computer]` is a
    // parse error and there is no name for the bare-name match to find. This
    // is the test that says so out loud — without it, "a section cannot shadow
    // it" is an unverified claim about an interaction between two files.
    expect(() => validateSectionName('[use computer]', 'tests/t.md', 5)).toThrow(
      /may not begin with "\["/,
    );
    const text = [
      '# T',
      '',
      '## Steps',
      '1. [use computer]',
      '',
      '### [use computer]',
      '1. Click Save',
      '',
    ].join('\n');
    expect(() => parseTestContent(text, 'tests/t.md')).toThrow(/may not begin with "\["/);
  });

  it('is a legal control-line TAIL, unlike `[input:]` and `[interactive]`', () => {
    const parsed = parseTestContent(
      doc('If a window titled "Save As" is open, then [use computer]', 'Click Save'),
      'tests/t.md',
    );
    expect(parsed.steps[0]).toBe('If a window titled "Save As" is open, then [use computer]');
  });

  it('…and a MALFORMED switch in a tail is still refused', () => {
    // The step-level check cannot see it — the whole step is `If …, then
    // [use phone]`, which never opens `[use` — so the tail is validated where
    // the tail is resolved.
    expect(() =>
      parseTestContent(doc('If a dialog is open, then [use phone]'), 'tests/t.md'),
    ).toThrow(/`phone` is not a surface/);
  });

  it('`[input:]` and `[interactive]` are still refused as tails', () => {
    expect(() =>
      parseTestContent(doc('If a dialog is open, then [interactive]'), 'tests/t.md'),
    ).toThrow(/hands the run back to a human/);
  });
});

// ---------------------------------------------------------------------------
// The grouper
// ---------------------------------------------------------------------------

describe('the step grouper leaves a surface switch alone', () => {
  it('never swallows one as a conditional group\'s continuation', () => {
    // Swallowed, both run loops would advance with
    // `i = group.continuationStep.index` and jump straight past the switch —
    // so every step after it would run on the surface the author had just
    // left. Forming NO group is the fix, the same one `Set` and flow control
    // take.
    const groups = identifyStepGroups([
      'If prompted for MFA, enter the code',
      '[use computer]',
      'Click the Save button',
    ]);
    expect(groups.size).toBe(0);
  });

  it('…including through the `[no-hooks]` marker', () => {
    const groups = identifyStepGroups([
      'If prompted for MFA, enter the code',
      '[no-hooks] [use browser]',
    ]);
    expect(groups.size).toBe(0);
  });

  it('a switch is never itself collected as a conditional', () => {
    const groups = identifyStepGroups(['[use computer]', 'Click Save']);
    expect(groups.size).toBe(0);
  });

  it('an ordinary continuation still groups — the guard has teeth, not a veto', () => {
    const groups = identifyStepGroups([
      'If prompted for MFA, enter the code',
      'Wait for the dashboard',
    ]);
    expect(groups.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// §9 — code-behind classification
// ---------------------------------------------------------------------------

describe('§9 a surface switch is never compiled', () => {
  const binding = { source: '[use computer]' } as never;

  it('generationRefusal (live compile) names it a surface switch', () => {
    expect(
      generationRefusal({ binding, text: '[use computer]', status: 'passed' }),
    ).toBe(SURFACE_SWITCH_NOT_COMPILED);
    expect(
      generationRefusal({ binding, text: '[no-hooks] [use browser]', status: 'passed' }),
    ).toBe(SURFACE_SWITCH_NOT_COMPILED);
    expect(SURFACE_SWITCH_NOT_COMPILED).toContain('surface switch');
  });

  it('refuseReason (generation) answers before the bracket-marker rule', () => {
    // `[use …]` would otherwise be claimed by `BRACKET_TOKEN_STEP`'s sibling
    // wording about captures and prompts, which says nothing true here.
    expect(refuseReason('[use computer]', [])).toBe(SURFACE_SWITCH_NOT_COMPILED);
    expect(refuseReason('[use browser]', [])).toBe(SURFACE_SWITCH_NOT_COMPILED);
  });

  it('an ordinary step is still compilable — the rule has teeth, not a veto', () => {
    expect(
      generationRefusal({
        binding,
        text: 'Click the Save button',
        status: 'passed',
      }),
    ).toBeUndefined();
  });
});

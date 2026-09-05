/**
 * The `Set {{name}} to "template"` grammar and its value resolution
 * (stories/variable-assignment.md).
 *
 * The fixture table at the bottom is the parity table the story asks for: the
 * runtime's reading of every authored line, in one place, so the two TestBench
 * mirrors can be checked against the same rows rather than against a
 * description of them.
 */
import { describe, it, expect } from 'vitest';
import { parseSetStep, setStepError, isSetStepClaim } from '../src/parser/set-step.js';
import { resolveSetTemplate } from '../src/runner/placeholder-substitution.js';
import type { EnvDataContext } from '../src/parser/interpolate-env-data.js';

const envData: EnvDataContext = {
  env: { BASE_URL: 'https://example.com' },
  data: { run: { date: '2026-09-05' } },
};

describe('parseSetStep', () => {
  it('reads the target and the template', () => {
    expect(parseSetStep('Set {{reference}} to "Ref: {{account_number}}"')).toEqual({
      name: 'reference',
      template: 'Ref: {{account_number}}',
    });
  });

  it('is case-insensitive on the keywords and not on the name', () => {
    expect(parseSetStep('SET {{Ref}} TO "x"')).toEqual({ name: 'Ref', template: 'x' });
    expect(parseSetStep('set {{ref}} to "x"')).toEqual({ name: 'ref', template: 'x' });
  });

  it('reads the template to the LAST quote, so an inner quote is literal', () => {
    expect(parseSetStep('Set {{q}} to "say "hi""')).toEqual({
      name: 'q',
      template: 'say "hi"',
    });
  });

  it('accepts an empty template — that clears a variable', () => {
    expect(parseSetStep('Set {{x}} to ""')).toEqual({ name: 'x', template: '' });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseSetStep('  Set {{x}} to "a"  ')).toEqual({ name: 'x', template: 'a' });
  });

  it('is null for anything that is not the form', () => {
    for (const line of [
      'Click the Set button',
      'Set the filter to Recent',
      'Set {{field}} using the dropdown', // no `to` — never claims
      'Navigate to the baseUrl',
      '[tool: print_all items="{{x}}"]',
      'Reset {{x}} to "a"', // `Reset`, not `Set`
    ]) {
      expect(parseSetStep(line), line).toBeNull();
    }
  });
});

describe('setStepError', () => {
  it('says nothing about a line that never claimed the form', () => {
    expect(setStepError('Set the filter to Recent')).toBeNull();
    expect(setStepError('Set {{field}} using the dropdown')).toBeNull();
  });

  it('says nothing about a line that parses', () => {
    expect(setStepError('Set {{x}} to "a"')).toBeNull();
  });

  it('refuses an unquoted value, and says why quoting is the rule', () => {
    const err = setStepError('Set {{reference}} to Ref: 1234');
    expect(err).toContain('must be a double-quoted string');
    expect(err).toContain('Set {{reference}} to Ref: 1234');
  });

  it('refuses trailing text after the closing quote', () => {
    const err = setStepError('Set {{x}} to "a" [store as: y]');
    expect(err).toContain('Nothing may follow the closing quote');
  });

  it('refuses an unclosed quote', () => {
    expect(setStepError('Set {{x}} to "abc')).toContain('never closes it');
  });

  it('names a spacing slip inside the braces rather than falling back to prose', () => {
    const err = setStepError('Set {{ x }} to "a"');
    expect(err).toContain('no spaces inside its braces');
    expect(err).toContain('{{x}}');
  });

  it('appends the caller\'s location verbatim', () => {
    expect(setStepError('Set {{x}} to nope', ' in tests/a.md at line 7')).toContain(
      'in tests/a.md at line 7',
    );
  });

  it('claims are recognised whether or not they complete', () => {
    expect(isSetStepClaim('Set {{x}} to "a"')).toBe(true);
    expect(isSetStepClaim('Set {{x}} to nope')).toBe(true);
    expect(isSetStepClaim('Set {{ x }} to "a"')).toBe(true);
    expect(isSetStepClaim('Set the filter to Recent')).toBe(false);
  });
});

describe('resolveSetTemplate', () => {
  it('substitutes from the scope as it stands', () => {
    const out = resolveSetTemplate('ref', 'Ref: {{acct}}', {
      parameters: { acct: '1234 5678' },
    });
    expect(out).toEqual({ value: 'Ref: 1234 5678' });
  });

  it('copies one variable into another when the whole template is one reference', () => {
    const out = resolveSetTemplate('b', '{{a}}', { parameters: { a: 'value' } });
    expect(out).toEqual({ value: 'value' });
  });

  it('resolves both syntaxes in the one pass', () => {
    const out = resolveSetTemplate('note', 'On ${data.run.date}: {{balance}}', {
      parameters: { balance: '$1,234.56' },
      envData,
    });
    expect(out).toEqual({ value: 'On 2026-09-05: $1,234.56' });
  });

  it('stores an empty template as the empty string', () => {
    expect(resolveSetTemplate('x', '', { parameters: {} })).toEqual({ value: '' });
  });

  it('never re-scans a value it just inserted', () => {
    // `a` holds text that LOOKS like a placeholder. A two-pass resolver would
    // substitute it again; the single pass inserts it verbatim.
    const out = resolveSetTemplate('b', '{{a}}', {
      parameters: { a: '{{secret}}', secret: 'leaked' },
    });
    expect(out).toEqual({ value: '{{secret}}' });
  });

  it('fails on a reference the scope does not hold, naming it', () => {
    const out = resolveSetTemplate('ref', 'Ref: {{acount_number}}', {
      parameters: { unrelated: 'x' },
    });
    expect(out).toHaveProperty('error');
    expect((out as { error: string }).error).toContain('{{acount_number}}');
    expect((out as { error: string }).error).toContain(
      'not a parameter or captured variable of this run',
    );
  });

  it('offers a near match on a case slip', () => {
    const out = resolveSetTemplate('ref', '{{Account}}', { parameters: { account: 'x' } });
    expect((out as { error: string }).error).toContain('did you mean `{{account}}`');
  });

  it('says "not yet" for a name a later step captures', () => {
    const out = resolveSetTemplate('ref', '{{balance}}', { parameters: {} }, new Set(['balance']));
    expect((out as { error: string }).error).toContain('has no value yet');
  });

  it('fails on a ${...} the environment cannot answer', () => {
    const out = resolveSetTemplate('x', '${data.missing.key}', { parameters: {}, envData });
    expect((out as { error: string }).error).toContain('${data.missing.key}');
    expect((out as { error: string }).error).toContain('cannot resolve');
  });

  it('leaves ${...} alone when the run has no environment at all', () => {
    // Matching `checkOneString`: with no env bundle nothing resolved these in
    // any other step's text either, so this step must not be the only one to
    // refuse.
    expect(resolveSetTemplate('x', 'see ${data.x}', { parameters: {} })).toEqual({
      value: 'see ${data.x}',
    });
  });

  it('refuses a spacing slip inside the template braces', () => {
    const out = resolveSetTemplate('x', '{{ acct }}', { parameters: { acct: '1' } });
    expect((out as { error: string }).error).toContain('no spaces inside its braces');
  });
});

/**
 * One table, three readers. The runtime's answer for each authored line; the
 * TestBench completion scanner and the webview Variables panel are checked
 * against the same rows in their own suites (they see only the target name).
 */
export const SET_STEP_FIXTURES: Array<{
  line: string;
  parsed: { name: string; template: string } | null;
  claims: boolean;
}> = [
  { line: 'Set {{a}} to "b"', parsed: { name: 'a', template: 'b' }, claims: true },
  { line: 'set {{a}} to "{{b}} and {{c}}"', parsed: { name: 'a', template: '{{b}} and {{c}}' }, claims: true },
  { line: 'SET {{a_1}} to ""', parsed: { name: 'a_1', template: '' }, claims: true },
  { line: 'Set {{a}} to "say "hi""', parsed: { name: 'a', template: 'say "hi"' }, claims: true },
  { line: 'Set {{a}} to unquoted', parsed: null, claims: true },
  { line: 'Set {{ a }} to "b"', parsed: null, claims: true },
  { line: 'Set {{a}} to "b" trailing', parsed: null, claims: true },
  { line: 'Set the filter to Recent', parsed: null, claims: false },
  { line: 'Set {{a}} using the dropdown', parsed: null, claims: false },
  { line: 'Click Save', parsed: null, claims: false },
];

describe('fixture table', () => {
  it.each(SET_STEP_FIXTURES)('reads $line', ({ line, parsed, claims }) => {
    expect(parseSetStep(line)).toEqual(parsed);
    expect(isSetStepClaim(line)).toBe(claims);
    // Every claim that does not parse must produce a diagnostic, and nothing
    // else may. That equivalence is what stops a new grammar case from
    // silently becoming prose.
    expect(setStepError(line) !== null).toBe(claims && parsed === null);
  });
});

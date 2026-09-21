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
import { readFileSync } from 'node:fs';
import { interpolate } from '../src/parser/parameters.js';
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

  it('refuses a value containing a quote, rather than guessing where it ends', () => {
    // This used to PARSE, greedy to the last quote on the line, so that
    // `say "hi"` could be stored with no escape syntax. The same rule
    // swallowed the line in the next test into a garbage value that passed
    // green, which is the trade that lost.
    expect(parseSetStep('Set {{q}} to "say "hi""')).toBeNull();
  });

  it('refuses prose that follows a quoted value and happens to end in a quote', () => {
    // The regression the greedy grammar hid: this parsed as
    // template `shoes" and search for "shoes`, performed no search, and
    // passed. Found by review, not by a test.
    const line = 'Set {{query}} to "shoes" and search for "shoes"';
    expect(parseSetStep(line)).toBeNull();
    expect(setStepError(line)).toContain('may not contain a double quote');
  });

  it('accepts a template that wraps onto a second line', () => {
    // `[^"]` matches a newline, so a soft-wrapped list item — which reaches
    // the parser with the break embedded — is a value, not a parse error.
    expect(parseSetStep('Set {{s}} to "one\ntwo"')).toEqual({
      name: 's',
      template: 'one\ntwo',
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
    expect(err).toContain('must end at the closing quote');
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
 * One list, three readers — and now actually one list.
 *
 * The authored lines live in `fixtures/set-step/grammar-lines.json`. THIS
 * file pins what the runtime does with each of them; the mirrors' suite
 * (testbench-native/tests/set-step-mirrors.test.js) pins that the editor
 * scanners agree, by calling `parseSetStep` rather than imitating it.
 *
 * The previous version of this was a table here and a hand-copied table
 * there, "kept in step by hand" — which is exactly how the `[no-hooks]` gap
 * came to sit in both mirrors at once, and by the time anyone counted, the
 * two had drifted to 11 rows and 12. A row added to the JSON is now checked
 * in all three places or fails here for want of an expectation.
 */
const GRAMMAR_LINES: string[] = JSON.parse(
  readFileSync(
    new URL('../fixtures/set-step/grammar-lines.json', import.meta.url),
    'utf8',
  ),
).lines;

/** The runtime's expected reading of every line in the shared list. */
const EXPECTED: Record<string, { name: string; template: string } | null> = {
  'Set {{a}} to "b"': { name: 'a', template: 'b' },
  'set {{a}} to "{{b}} and {{c}}"': { name: 'a', template: '{{b}} and {{c}}' },
  'SET {{a_1}} to ""': { name: 'a_1', template: '' },
  'Set {{a}} to "  padded  "': { name: 'a', template: '  padded  ' },
  'Set {{a}} to "say "hi""': null,
  'Set {{a}} to "x" and click "Save"': null,
  'Set {{a}} to unquoted': null,
  'Set {{ a }} to "b"': null,
  'Set {{a}} to "b" trailing': null,
  'Set {{a}} to "b': null,
  'Set the filter to Recent': null,
  'Set {{a}} using the dropdown': null,
  'Click Save': null,
  // The parser strips the marker ITSELF. It has to: runner-core keeps it on
  // the wire deliberately, so the Sessions API and the errand runner receive
  // it verbatim and were sending such lines to the model as prose.
  '[no-hooks] Set {{a}} to "b"': { name: 'a', template: 'b' },
  'Set {{to}} to "b"': { name: 'to', template: 'b' },
  'Set {{o}} to "b"': { name: 'o', template: 'b' },
};

describe('shared grammar list', () => {
  it('has an expectation for every line, and no stale ones', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...GRAMMAR_LINES].sort());
  });

  it.each(GRAMMAR_LINES)('reads %s', (line) => {
    const parsed = EXPECTED[line]!;
    expect(parseSetStep(line)).toEqual(parsed ?? null);
    // Every claim that does not parse must produce a diagnostic, and nothing
    // else may. That equivalence is what stops a new grammar case from
    // silently becoming prose.
    const claims = isSetStepClaim(line);
    expect(setStepError(line) !== null).toBe(claims && parsed === null);
  });
});

describe('a Set step is never swallowed by a conditional group', () => {
  it('does not become a conditional continuation', async () => {
    // A continuation is handed to the MODEL to perform if the conditional did
    // not apply. A Set has no model half, so being chosen as one meant the
    // variable was silently never assigned AND the step cost a turn — both
    // halves of what this step form exists to avoid. Found by review; the
    // story claimed "no model call" for all four loops without a test.
    const { identifyStepGroups } = await import('../src/runner/step-grouper.js');
    const steps = ['If prompted for MFA, enter the code', 'Set {{done}} to "yes"', 'Click Save'];
    const groups = identifyStepGroups(steps);
    // NO group at all. The first version of this fix kept the group and gave
    // it a synthetic continuation, which was WORSE than the bug: both loops
    // advance with `i = group.continuationStep.index` then `i++`, and that
    // synthetic index IS the assignment's, so the step vanished from the run
    // while a model turn was spent on the placeholder string.
    expect(groups.size).toBe(0);
  });

  it('every step still runs AS ITSELF — replaying the loops own arithmetic', async () => {
    // Checking that an index is "reached" is not enough, and the first
    // version of this test proved it: run against round one's grouper it
    // PASSED, because it counted `continuationStep.index` as reached — and
    // under that grouper the thing that ran at the assignment's index was a
    // synthetic placeholder string, not the assignment. The test could not
    // tell "the step ran" from "the step was swallowed", which IS the bug.
    //
    // So this asserts WHAT ran at each index, not merely that the index was
    // touched. Confirmed to fail against `git show 59dd058`'s grouper.
    const { identifyStepGroups } = await import('../src/runner/step-grouper.js');
    for (const steps of [
      ['If prompted for MFA, enter the code', 'Set {{a}} to "1"', 'Click Save'],
      ['If prompted, do it', 'If asked again, do it', 'Set {{a}} to "1"', 'Click Save'],
      ['If prompted, do it', 'Set {{a}} to "1"', 'If asked, do it', 'Click Save'],
      ['Click A', 'If prompted, do it', 'Set {{a}} to "1"'],
      ['Set {{a}} to "1"', 'If prompted, do it', 'Click Save'],
    ]) {
      const groups = identifyStepGroups(steps);
      /** index -> the instruction text actually executed at that index. */
      const ranAs = new Map<number, string>();
      for (let i = 0; i < steps.length; i++) {
        const g = groups.get(i);
        if (g && i === g.conditionalSteps[0]!.index) {
          for (const c of g.conditionalSteps) ranAs.set(c.index, c.instruction);
          // What executeBranchedStep performs for the default path — which
          // under round one was the placeholder, at the assignment's index.
          ranAs.set(g.continuationStep.index, g.continuationStep.instruction);
          i = g.continuationStep.index;
          continue;
        }
        if (g) continue;
        ranAs.set(i, steps[i]!);
      }
      const where = JSON.stringify(steps);
      for (let i = 0; i < steps.length; i++) {
        // Every index runs, AND runs the text the author wrote there.
        expect(ranAs.get(i), `index ${i} of ${where}`).toBe(steps[i]);
      }
    }
  });

  it('still pairs a conditional with an ordinary continuation', () => {
    // The guard must not change grouping for anything else.
    return import('../src/runner/step-grouper.js').then(({ identifyStepGroups }) => {
      const groups = identifyStepGroups([
        'If prompted for MFA, enter the code',
        'Click Save',
      ]);
      expect(groups.get(1)).toBeDefined();
      expect(groups.get(0)!.continuationStep.instruction).toBe('Click Save');
    });
  });
});

describe('a Set target that needs a guarded write', () => {
  it('stores __proto__ as an own property rather than silently dropping it', async () => {
    // Plain assignment hits the prototype setter, which ignores a string: the
    // step reported PASSED with the value in its outputs while the scope held
    // nothing, so a later `{{__proto__}}` failed as undefined.
    const { runSetStep } = await import('../src/runner/set-step-runner.js');
    const scope: Record<string, string> = {};
    const out = runSetStep({ name: '__proto__', template: 'hello' }, 'x', 1, scope);
    expect(out.result.status).toBe('passed');
    expect(Object.keys(scope)).toEqual(['__proto__']);
    expect(scope['__proto__']).toBe('hello');
  });

  it('does not report a skill-internal name', async () => {
    // `computeStepCaptures` and `autoCapturedNames` both drop `__skill*`;
    // writing outputs directly bypassed both, surfacing `__skill1_scratch` in
    // the report, the HTTP outputs map and the Variables panel.
    const { runSetStep } = await import('../src/runner/set-step-runner.js');
    const scope: Record<string, string> = {};
    const out = runSetStep({ name: '__skill1_scratch', template: 'v' }, 'x', 1, scope);
    expect(out.result.status).toBe('passed');
    expect(scope['__skill1_scratch']).toBe('v'); // the assignment still happens
    expect(out.result.outputs).toBeUndefined(); // its reporting does not
    expect(out.assigned).toBeUndefined();
  });
});

/**
 * A `Set` over a name a `For each` bound erases that name's dotted keys
 * (docs/specs/SPEC-structured-table-reads.md §8.2, §8.3).
 *
 * A `Set` writes the FLAT name only, so after a `For each {{order}} …` the map
 * still held `order.id` from the last pass. `{{order.id}}` went on
 * substituting that row's id into steps run AFTER the author had overwritten
 * `{{order}}` — silently, with the right-looking value — and the §8.3 refusal,
 * asked about a root that now holds a plain string, answered by listing
 * "available properties" of a value nothing binds any more.
 *
 * The rule is `applyPassBindings`' own, and the two share one helper
 * (`clearDottedKeys`, control-runtime.ts): a rebind of a root erases that
 * root's properties, whoever does the rebinding.
 */
describe('a Set over a name a loop bound', () => {
  it('clears the loop pass"s dotted keys for that root', async () => {
    const { runSetStep } = await import('../src/runner/set-step-runner.js');
    const { dottedReferenceError } = await import('../src/runner/placeholder-substitution.js');

    // What a `For each {{order}} in {{orders}}` leaves behind on its last pass.
    const scope: Record<string, string> = {
      email: 'a@b.c',
      order: '{"id":"ORD-1001","status":"Completed"}',
      'order.id': 'ORD-1001',
      'order.status': 'Completed',
    };

    const out = runSetStep(
      { name: 'order', template: 'none' },
      'Set {{order}} to "none"',
      9,
      scope,
    );

    expect(out.result.status).toBe('passed');
    expect(scope).toEqual({ email: 'a@b.c', order: 'none' });
    // …so a later `{{order.id}}` is refused rather than answering with the
    // last row's id.
    expect(dottedReferenceError('Verify {{order.id}} is shown', scope)).toBe(
      '{{order.id}} has no value; {{order}} holds no properties — it is not an object',
    );
  });

  it('leaves every other root"s properties, and every flat name, alone', async () => {
    const { runSetStep } = await import('../src/runner/set-step-runner.js');
    const scope: Record<string, string> = {
      'line.debit': '10',
      line: '{"debit":"10"}',
      total: '10',
    };
    runSetStep({ name: 'note', template: 'x' }, 'Set {{note}} to "x"', 1, scope);
    expect(scope).toEqual({
      'line.debit': '10',
      line: '{"debit":"10"}',
      total: '10',
      note: 'x',
    });
  });

  it('clears nothing when the assignment failed', async () => {
    const { runSetStep } = await import('../src/runner/set-step-runner.js');
    const scope: Record<string, string> = {
      order: '{"id":"A"}',
      'order.id': 'A',
    };
    // The template references a name nothing binds, so the step fails and
    // writes nothing — including the erase.
    const out = runSetStep(
      { name: 'order', template: '{{nope}}' },
      'Set {{order}} to "{{nope}}"',
      1,
      scope,
    );
    expect(out.result.status).toBe('failed');
    expect(scope).toEqual({ order: '{"id":"A"}', 'order.id': 'A' });
  });
});

describe('recognised on the AUTHORED line, not the interpolated one', () => {
  /**
   * The single load-bearing decision of this feature, and it was pinned
   * nowhere: a reviewer measured that mutating any of the four loops to parse
   * the INTERPOLATED line left all 3698 tests green.
   *
   * The reason no existing test caught it is that every one of them assigns a
   * target that does not yet hold a value — and on that first pass the two
   * readings agree. The bug only appears on the SECOND assignment to a name,
   * which is a re-run, a second batch, or a looped section.
   */
  it('a target that already holds a value is still a target, not a source', () => {
    const authored = 'Set {{greeting}} to "Hello, {{who}}"';
    const scope = { who: 'world', greeting: 'Hello, world' };

    // What every loop actually does.
    expect(parseSetStep(authored)).toEqual({
      name: 'greeting',
      template: 'Hello, {{who}}',
    });

    // What it would do if it parsed the interpolated line instead: the target
    // is replaced by its own value, the line stops being an assignment, and
    // the step degrades to prose — costing a model turn and assigning
    // nothing.
    const interpolated = interpolate(authored, scope);
    expect(interpolated).toBe('Set Hello, world to "Hello, world"');
    expect(parseSetStep(interpolated)).toBeNull();
  });

  it('assigns twice in a row, reading its own previous value', async () => {
    const { runSetStep } = await import('../src/runner/set-step-runner.js');
    const scope: Record<string, string> = {};
    const step = { name: 's', template: '{{s}}x' };

    // First pass: the template's own reference is unset, so it fails rather
    // than storing the literal.
    expect(runSetStep({ name: 's', template: 'a' }, '', 1, scope).result.status).toBe('passed');
    // Second and third: each reads what the previous one wrote.
    runSetStep(step, '', 2, scope);
    runSetStep(step, '', 3, scope);
    expect(scope['s']).toBe('axx');
  });
});

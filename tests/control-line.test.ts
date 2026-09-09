import { describe, it, expect } from 'vitest';
import {
  claimedControlForm,
  controlLineError,
  isControlLineClaim,
  parseControlLine,
  parseControlLineAt,
} from '../src/parser/control-line.js';

/**
 * The six control-flow forms, at the grammar level
 * (stories/control-flow.md §Syntax).
 *
 * Three questions, kept apart on purpose because they have different answers:
 * does the line CLAIM a form, does it COMPLETE the one it claimed, and — for
 * the ones that do — where exactly did the split fall. A line that claims and
 * does not complete is a parse error naming it; a line that never claimed is
 * prose, and the watch form (`If <cond>, <action>` with no `then`) has to stay
 * in that second bucket or this feature would change the meaning of files
 * written before it.
 */

describe('the six forms parse', () => {
  it('If … then', () => {
    expect(parseControlLine('If the Cash checkbox is ticked, then Pay with cash')).toEqual({
      kind: 'if',
      condition: 'the Cash checkbox is ticked',
      tail: 'Pay with cash',
    });
  });

  it('If … then with no comma before then', () => {
    expect(parseControlLine('If {{plan}} is "pro" then [skill: enable_pro_features]')).toEqual({
      kind: 'if',
      condition: '{{plan}} is "pro"',
      tail: '[skill: enable_pro_features]',
    });
  });

  it('Else if and Otherwise if', () => {
    for (const word of ['Else if', 'Otherwise if']) {
      expect(parseControlLine(`${word} the Card checkbox is ticked, then Pay by card`)).toEqual({
        kind: 'elseif',
        condition: 'the Card checkbox is ticked',
        tail: 'Pay by card',
      });
    }
  });

  it('Else and Otherwise, with or without the comma', () => {
    for (const line of ['Otherwise, Pay by card', 'Else, Pay by card', 'Else Pay by card']) {
      expect(parseControlLine(line)).toEqual({ kind: 'else', tail: 'Pay by card' });
    }
  });

  it('While', () => {
    expect(parseControlLine('While the Next button is enabled, Go to the next page')).toEqual({
      kind: 'while',
      condition: 'the Next button is enabled',
      tail: 'Go to the next page',
    });
  });

  it('Repeat … until', () => {
    expect(parseControlLine('Repeat Click Load more until the Load more button is gone')).toEqual({
      kind: 'repeat',
      condition: 'the Load more button is gone',
      tail: 'Click Load more',
    });
  });

  it('For each {{x}} in {{list}}', () => {
    expect(parseControlLine('For each {{account}} in {{accounts}}, Check the account')).toEqual({
      kind: 'foreach',
      item: 'account',
      list: 'accounts',
      tail: 'Check the account',
    });
  });

  it('keywords are case-insensitive', () => {
    expect(parseControlLine('IF x, THEN Y')?.kind).toBe('if');
    expect(parseControlLine('ELSE IF x, THEN Y')?.kind).toBe('elseif');
    expect(parseControlLine('OTHERWISE, Y')?.kind).toBe('else');
    expect(parseControlLine('WHILE x, Y')?.kind).toBe('while');
    expect(parseControlLine('REPEAT Y UNTIL x')?.kind).toBe('repeat');
    expect(parseControlLine('FOR EACH {{a}} IN {{b}}, Y')?.kind).toBe('foreach');
  });

  it('strips a leading [no-hooks], as parseSetStep does', () => {
    expect(parseControlLine('[no-hooks] If x, then Login')).toEqual({
      kind: 'if',
      condition: 'x',
      tail: 'Login',
    });
    // …and case-insensitively, matching NO_HOOKS_MARKER.
    expect(parseControlLine('[NO-HOOKS] While x, Login')?.kind).toBe('while');
  });
});

describe('what stays prose', () => {
  it('the watch form — an If with no then', () => {
    expect(parseControlLine('If a Remember this device prompt appears, click Not now')).toBeNull();
    expect(isControlLineClaim('If a Remember this device prompt appears, click Not now')).toBe(
      false,
    );
  });

  it('an If whose only "then" has nothing after it', () => {
    // ` then ` needs whitespace on BOTH sides, so this is the watch form with
    // an odd last word rather than a decision missing its tail.
    expect(parseControlLine('If x, then')).toBeNull();
    expect(isControlLineClaim('If x, then')).toBe(false);
  });

  it('Repeat with no until', () => {
    expect(parseControlLine('Repeat the search')).toBeNull();
    expect(isControlLineClaim('Repeat the search')).toBe(false);
  });

  it('For each with no braces', () => {
    expect(parseControlLine('For each product in the list, verify its price')).toBeNull();
    expect(isControlLineClaim('For each product in the list, verify its price')).toBe(false);
  });

  it('a word that merely starts with a keyword', () => {
    for (const line of ['Ifs are hard', 'Otherwiseraise the limit', 'Whiletext', 'Repeatedly click']) {
      expect(isControlLineClaim(line)).toBe(false);
    }
  });

  it('ordinary instructions', () => {
    for (const line of [
      'Click the Login button',
      'Verify the order confirmation is shown',
      'Set {{x}} to "y"',
      '[skill: login]',
      '[tool: fetch_orders]',
      '[input: pin] Enter your PIN',
      '[interactive]',
    ]) {
      expect(parseControlLine(line)).toBeNull();
      expect(controlLineError(line)).toBeNull();
    }
  });
});

describe('where the split falls', () => {
  it('If splits at the FIRST then', () => {
    expect(parseControlLine('If a then b, then c then d')).toEqual({
      kind: 'if',
      condition: 'a',
      tail: 'b, then c then d',
    });
  });

  it('While splits at the FIRST comma; the tail may contain more', () => {
    expect(parseControlLine('While a, do b, and then c')).toEqual({
      kind: 'while',
      condition: 'a',
      tail: 'do b, and then c',
    });
  });

  it('Repeat splits at the FIRST until', () => {
    expect(parseControlLine('Repeat a until b until c')).toEqual({
      kind: 'repeat',
      tail: 'a',
      condition: 'b until c',
    });
  });

  it('For each splits at the comma after the second }}', () => {
    expect(parseControlLine('For each {{a}} in {{b}}, do c, and d')).toEqual({
      kind: 'foreach',
      item: 'a',
      list: 'b',
      tail: 'do c, and d',
    });
  });

  it('the cap comes off the end before anything else is read', () => {
    expect(parseControlLine('While a, do b, up to 20 times')).toEqual({
      kind: 'while',
      condition: 'a',
      tail: 'do b',
      cap: 20,
    });
    expect(parseControlLine('Repeat do b until a, up to 3 times')).toEqual({
      kind: 'repeat',
      condition: 'a',
      tail: 'do b',
      cap: 3,
    });
  });

  it('a cap-shaped suffix that is not at the end stays in the tail', () => {
    expect(parseControlLine('While a, do b, up to 3 times a day')?.tail).toBe(
      'do b, up to 3 times a day',
    );
  });

  it('reports the tail offset so an editor can underline the tail alone', () => {
    const hit = parseControlLineAt('If the box is ticked, then Pay with cash')!;
    expect(hit.tailStart).toBe('If the box is ticked, then '.length);
    expect('If the box is ticked, then Pay with cash'.slice(hit.tailStart)).toBe('Pay with cash');

    const loop = parseControlLineAt('Repeat Click Load more until it is gone')!;
    expect('Repeat Click Load more until it is gone'.slice(loop.tailStart)).toBe(
      'Click Load more until it is gone',
    );
    expect(loop.tail).toBe('Click Load more');

    const each = parseControlLineAt('For each {{a}} in {{b}}, Check the account')!;
    expect('For each {{a}} in {{b}}, Check the account'.slice(each.tailStart)).toBe(
      'Check the account',
    );
  });

  it('the offset is measured after the [no-hooks] strip, like the text is', () => {
    const hit = parseControlLineAt('[no-hooks] While a, Login')!;
    expect('While a, Login'.slice(hit.tailStart)).toBe('Login');
  });
});

describe('a claim that does not complete is an error naming the line', () => {
  it('Else if with no then', () => {
    const err = controlLineError('Else if the card box is ticked');
    expect(err).toContain('Cannot parse the step "Else if the card box is ticked"');
    expect(err).toContain('after `then`');
  });

  it('If with no condition', () => {
    expect(controlLineError('If then Pay by card')).toContain('needs a condition before `then`');
  });

  it('Otherwise with no step to run', () => {
    expect(controlLineError('Otherwise')).toContain('must name one step to run');
    expect(controlLineError('Otherwise,')).toContain('must name one step to run');
    // The message uses the word the author wrote.
    expect(controlLineError('Else')).toContain('`Else` must name one step');
  });

  it('While with no comma', () => {
    const err = controlLineError('While the Next button is enabled');
    expect(err).toContain('separates its condition from the step it repeats with a comma');
    expect(err).toContain('FIRST comma');
  });

  it('While with an empty condition or an empty tail', () => {
    expect(controlLineError('While , do b')).toContain('needs a condition before the comma');
    expect(controlLineError('While a,')).toContain('needs the step to repeat after the comma');
  });

  it('Repeat with nothing to repeat', () => {
    expect(controlLineError('Repeat until the Load more button is gone')).toContain(
      'names the step to repeat BEFORE `until`',
    );
  });

  it('a cap of zero is refused, not swallowed into the tail', () => {
    const err = controlLineError('While a, do b, up to 0 times');
    expect(err).toContain('`up to 0 times` is not a cap');
    expect(err).toContain('execution.maxLoopIterations');
    // …and it does not parse with the suffix hidden in the tail.
    expect(parseControlLine('While a, do b, up to 0 times')).toBeNull();
  });

  it('For each with spaces inside the braces', () => {
    const err = controlLineError('For each {{ account }} in {{accounts}}, Check it');
    expect(err).toContain('no spaces inside its braces');
    expect(err).toContain('{{account}}');
  });

  it('For each with a name that is not a placeholder name', () => {
    expect(controlLineError('For each {{2nd}} in {{accounts}}, Check it')).toContain(
      'is not a placeholder name',
    );
  });

  it('For each with no list', () => {
    expect(controlLineError('For each {{account}}, Check it')).toContain('The list is missing');
  });

  it('For each with no comma', () => {
    expect(controlLineError('For each {{a}} in {{b}} Check it')).toContain(
      'The comma after `{{b}}`',
    );
  });

  it('For each with a cap', () => {
    const err = controlLineError('For each {{a}} in {{b}}, Check it, up to 3 times');
    expect(err).toContain('takes no `, up to N times` cap');
  });

  it('appends `where` verbatim, as setStepError does', () => {
    expect(controlLineError('Otherwise', ' in tests/a.md at line 7')).toContain(
      'Cannot parse the step "Otherwise" in tests/a.md at line 7',
    );
  });

  it('says nothing about a line that parses, or one that never claimed', () => {
    expect(controlLineError('If a, then b')).toBeNull();
    expect(controlLineError('If a prompt appears, dismiss it')).toBeNull();
  });
});

describe('claim and parse agree', () => {
  const LINES = [
    'If a, then b',
    'If a prompt appears, dismiss it',
    'If then b',
    'Else if a, then b',
    'Else if a',
    'Otherwise, b',
    'Otherwise',
    'While a, b',
    'While a',
    'While a, b, up to 0 times',
    'Repeat b until a',
    'Repeat b',
    'Repeat until a',
    'For each {{a}} in {{b}}, c',
    'For each {{a}} in {{b}} c',
    'For each product in the list, verify it',
    'Click Login',
    '[skill: login]',
  ];

  it('an error is produced exactly when a line claims and does not parse', () => {
    for (const line of LINES) {
      const claims = isControlLineClaim(line);
      const parsed = parseControlLine(line);
      expect(controlLineError(line) !== null, line).toBe(claims && parsed === null);
      // A parsed line has always claimed; the reverse is what the error covers.
      if (parsed !== null) expect(claims, line).toBe(true);
      if (claims) expect(claimedControlForm(line), line).not.toBeNull();
    }
  });
});

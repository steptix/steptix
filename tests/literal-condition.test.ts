/**
 * The literal-condition grammar (src/parser/literal-condition.ts).
 *
 * Two halves, and the second is the important one. The positive half says the
 * eighteen forms are read correctly; the NEGATIVE half says everything else is
 * refused, and that is what keeps the feature safe — a condition this module
 * wrongly claims is not decided slowly and wrongly, it is decided instantly
 * and wrongly, on every run, with a confident sentence in the report.
 *
 * The motivating run is in the module's own header: `"" is empty` went to the
 * page judge, which answered from a different table row.
 */
import { describe, it, expect } from 'vitest';
import { parseLiteralCondition } from '../src/parser/literal-condition.js';
import { substituteAsLiterals } from '../src/runner/placeholder-substitution.js';

/** The answer, or `null` for "not literal — ask the page". */
const decide = (text: string): boolean | null => parseLiteralCondition(text)?.holds ?? null;

describe('the emptiness forms', () => {
  it('reads all four, both ways', () => {
    expect(decide('"" is empty')).toBe(true);
    expect(decide('"" is blank')).toBe(true);
    expect(decide('"" is not empty')).toBe(false);
    expect(decide('"" is not blank')).toBe(false);

    expect(decide('"INV-2291" is empty')).toBe(false);
    expect(decide('"INV-2291" is blank')).toBe(false);
    expect(decide('"INV-2291" is not empty')).toBe(true);
    expect(decide('"INV-2291" is not blank')).toBe(true);
  });

  it('does not trim inside the quotes: a space is a value', () => {
    // It used to trim, which made the cell holding a space and the cell
    // holding nothing report as the same cell — and `"" is " "` true, which
    // is two different values called equal.
    expect(decide('"   " is empty')).toBe(false);
    expect(decide('"   " is not empty')).toBe(true);
    expect(decide('" " is empty')).toBe(false);
    expect(decide('"" is " "')).toBe(false);
    expect(decide('" " is ""')).toBe(false);
    expect(decide('" " is " "')).toBe(true);
    // `is blank` is a spelling of `is empty`, not a second rule: both mean
    // "no characters at all".
    expect(decide('" " is blank')).toBe(false);
  });

  it('is the shape the acceptance run got wrong', () => {
    // `If "{{line.debit}}" is empty` on the pass whose debit cell was blank.
    const parsed = parseLiteralCondition('"" is empty');
    expect(parsed).toEqual({ left: '', operator: 'is empty', numeric: false, holds: true });
  });

  it('a number is never empty', () => {
    expect(decide('0 is empty')).toBe(false);
    expect(decide('0 is not empty')).toBe(true);
  });
});

describe('the equality forms', () => {
  it('reads the two positives and the three negatives', () => {
    expect(decide('"Paused" is "Paused"')).toBe(true);
    expect(decide('"Paused" equals "Paused"')).toBe(true);
    expect(decide('"Paused" is not "Paused"')).toBe(false);
    expect(decide('"Paused" does not equal "Paused"')).toBe(false);
    expect(decide('"Paused" is different from "Paused"')).toBe(false);

    expect(decide('"Paused" is "Scheduled"')).toBe(false);
    expect(decide('"Paused" equals "Scheduled"')).toBe(false);
    expect(decide('"Paused" is not "Scheduled"')).toBe(true);
    expect(decide('"Paused" does not equal "Scheduled"')).toBe(true);
    expect(decide('"Paused" is different from "Scheduled"')).toBe(true);
  });

  it('compares exactly — case and inner spacing are not smoothed over', () => {
    expect(decide('"Paused" is "paused"')).toBe(false);
    expect(decide('"a b" is "a  b"')).toBe(false);
  });

  it('does NOT trim inside the quotes', () => {
    // The old rule was "exact after trimming", which also made `" " is empty`
    // true. Whitespace an author typed inside quotes is part of the value; a
    // cell arrives from a table read already trimmed, so nothing that came
    // off a page needs this.
    expect(decide('"  Completed  " is "Completed"')).toBe(false);
    expect(decide('"  Completed  " is "  Completed  "')).toBe(true);
    // Whitespace OUTSIDE the operands is still just spacing in the sentence.
    expect(decide('  "Completed"   is   "Completed"  ')).toBe(true);
  });

  it('holds for two empty strings', () => {
    expect(decide('"" is ""')).toBe(true);
    expect(decide('"" is not ""')).toBe(false);
    expect(decide('"" is "x"')).toBe(false);
  });

  it('does not read a quoted `not` as the negative operator', () => {
    // `is not` needs the bare word; `"not"` is an operand.
    expect(parseLiteralCondition('"not" is "not"')).toMatchObject({
      left: 'not',
      operator: 'is',
      right: 'not',
      holds: true,
    });
  });
});

describe('the substring forms', () => {
  it('reads contains, does not contain, starts with and ends with', () => {
    expect(decide('"ORD-1001" contains "1001"')).toBe(true);
    expect(decide('"ORD-1001" contains "2002"')).toBe(false);
    expect(decide('"ORD-1001" does not contain "2002"')).toBe(true);
    expect(decide('"ORD-1001" does not contain "1001"')).toBe(false);
    expect(decide('"ORD-1001" starts with "ORD"')).toBe(true);
    expect(decide('"ORD-1001" starts with "1001"')).toBe(false);
    expect(decide('"ORD-1001" ends with "1001"')).toBe(true);
    expect(decide('"ORD-1001" ends with "ORD"')).toBe(false);
  });

  it('every string contains the empty string, and no empty string contains one', () => {
    expect(decide('"x" contains ""')).toBe(true);
    expect(decide('"" contains "x"')).toBe(false);
    expect(decide('"" contains ""')).toBe(true);
  });
});

describe('the ordering forms', () => {
  it('reads all five, numerically', () => {
    expect(decide('5 is at least 5')).toBe(true);
    expect(decide('4 is at least 5')).toBe(false);
    expect(decide('5 is at most 5')).toBe(true);
    expect(decide('6 is at most 5')).toBe(false);
    expect(decide('6 is more than 5')).toBe(true);
    expect(decide('5 is more than 5')).toBe(false);
    expect(decide('6 is greater than 5')).toBe(true);
    expect(decide('4 is less than 5')).toBe(true);
    expect(decide('5 is less than 5')).toBe(false);
  });

  it('handles signs and decimals', () => {
    expect(decide('-65.00 is less than 0')).toBe(true);
    expect(decide('+3 is at least 3')).toBe(true);
    expect(decide('2.50 is more than 2.5')).toBe(false);
  });

  it('a quoted number is still a number', () => {
    expect(parseLiteralCondition('"10" is at least 2')).toMatchObject({
      numeric: true,
      holds: true,
    });
  });

  it('refuses an ordering it cannot do numerically, rather than answering false', () => {
    // A currency normaliser is phase 2 (§7.7). Until then this is the judge's,
    // which at least has the page and the `## Values` block.
    expect(parseLiteralCondition('"$140.00" is at least 100')).toBeNull();
    expect(parseLiteralCondition('"Paused" is more than 3')).toBeNull();
    expect(parseLiteralCondition('"" is at least 0')).toBeNull();
  });
});

/**
 * Equality is TEXT. Only the five orderings are numbers.
 *
 * The equality family used to coerce when both sides read as plain numbers,
 * which looked like a kindness and was a defect: a table read yields exactly
 * the strings that coercion destroys. `"0012" is "12"` said TRUE about two
 * different order numbers, and so did `"1.0" is "1"` for two different
 * quantities, `"+5" is "5"` and `"-0" is "0"`. Zero-padded ids, money strings
 * and version numbers are the normal contents of a cell.
 */
describe('equality compares characters, never numbers', () => {
  it('does not make unequal strings equal', () => {
    expect(parseLiteralCondition('"0012" is "12"')).toMatchObject({
      numeric: false,
      holds: false,
    });
    expect(decide('"0012" is not "12"')).toBe(true);
    expect(decide('"1.0" is "1"')).toBe(false);
    expect(decide('"+5" is "5"')).toBe(false);
    expect(decide('"-0" is "0"')).toBe(false);
    expect(decide('2.50 equals 2.5')).toBe(false);
    expect(decide('"007" is 7')).toBe(false);
    expect(decide('"1e3" is "1000"')).toBe(false);
    // Every spelling of the negative agrees with its positive.
    expect(decide('"1.0" does not equal "1"')).toBe(true);
    expect(decide('"1.0" is different from "1"')).toBe(true);
  });

  it('still holds when the characters really are the same', () => {
    // Not because either side was parsed — the four characters match.
    expect(parseLiteralCondition('"42" is 42')).toMatchObject({
      numeric: false,
      holds: true,
    });
    expect(decide('"$7" is "7"')).toBe(false);
    expect(decide('"" is 0')).toBe(false);
  });

  it('reports `numeric` for the orderings and nothing else', () => {
    expect(parseLiteralCondition('4 is less than 5')).toMatchObject({ numeric: true });
    expect(parseLiteralCondition('1001 contains 100')).toMatchObject({
      numeric: false,
      holds: true,
    });
    expect(decide('100 contains 1001')).toBe(false);
    expect(parseLiteralCondition('5 is 5')).toMatchObject({ numeric: false, holds: true });
  });

  it('leaves the orderings numeric, so 10 still sorts above 9', () => {
    // As text it would sort the other way, which is why `numeric` exists
    // rather than the comparison just calling `Number()`.
    expect(decide('"10" is at least "9"')).toBe(true);
    expect(decide('"0012" is more than 11')).toBe(true);
    expect(decide('"1.0" is at most 1')).toBe(true);
  });
});

describe('keywords and whitespace', () => {
  it('is case-insensitive and tolerant of runs of space', () => {
    expect(decide('"" IS EMPTY')).toBe(true);
    expect(decide('"a" Is  Not  "b"')).toBe(true);
    expect(decide('"ORD" STARTS   WITH "O"')).toBe(true);
    expect(decide('  "a" is "a"  ')).toBe(true);
  });

  it('normalises the operator it reports', () => {
    expect(parseLiteralCondition('"a" Does  Not  Contain "b"')?.operator).toBe('does not contain');
    expect(parseLiteralCondition('"" IS NOT BLANK')?.operator).toBe('is not blank');
    expect(parseLiteralCondition('5 is  at   least 2')?.operator).toBe('is at least');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The half that matters: what must still go to the page
// ───────────────────────────────────────────────────────────────────────────

describe('anything that is not all literals goes to the judge', () => {
  it('prose about the page', () => {
    expect(parseLiteralCondition('the Cash checkbox is ticked')).toBeNull();
    expect(parseLiteralCondition('the Next button is enabled')).toBeNull();
    expect(parseLiteralCondition('the page title contains "Dashboard"')).toBeNull();
    expect(parseLiteralCondition('every alert is shown')).toBeNull();
  });

  it('an unquoted word that is not a number, on either side', () => {
    expect(parseLiteralCondition('Paused is "Paused"')).toBeNull();
    expect(parseLiteralCondition('"Paused" is Paused')).toBeNull();
    expect(parseLiteralCondition('status is empty')).toBeNull();
  });

  it('a placeholder that has not been substituted yet', () => {
    // The order matters: the runtime substitutes FIRST and parses the result.
    // Reaching here with braces intact means the run could not answer the
    // reference, and inventing an answer would be worse than asking.
    expect(parseLiteralCondition('{{x}} is "a"')).toBeNull();
    expect(parseLiteralCondition('"{{order.missing}}" is empty')).toBeNull();
    expect(parseLiteralCondition('"${data.plan}" is "pro"')).toBeNull();
  });

  it('a compound condition — one line, two questions', () => {
    expect(parseLiteralCondition('"a" is "a" and "b" is "b"')).toBeNull();
    expect(parseLiteralCondition('"a" is "a" or "b" is "b"')).toBeNull();
    expect(parseLiteralCondition('"a" is "a", and the page is loaded')).toBeNull();
  });

  it('trailing or leading prose around a literal comparison', () => {
    expect(parseLiteralCondition('"a" is "a" on the receipt')).toBeNull();
    expect(parseLiteralCondition('after signing in, "a" is "a"')).toBeNull();
  });

  it('an operator this grammar does not have', () => {
    expect(parseLiteralCondition('"a" matches "a"')).toBeNull();
    expect(parseLiteralCondition('"a" is like "a"')).toBeNull();
    expect(parseLiteralCondition('"3" is between 1 and 5')).toBeNull();
  });

  it('a value with an embedded quote, which is not one operand', () => {
    expect(parseLiteralCondition('"a"b" is "c"')).toBeNull();
  });

  it('an empty or operator-only line', () => {
    expect(parseLiteralCondition('')).toBeNull();
    expect(parseLiteralCondition('is empty')).toBeNull();
    expect(parseLiteralCondition('"a" is')).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The text the runtime actually parses
// ───────────────────────────────────────────────────────────────────────────

/**
 * `substituteAsLiterals` is the other half of the decision: this grammar reads
 * VALUES, so a reference has to arrive as one.
 *
 * Plain substitution gave `Overdue is "Paused"` for the feature's own
 * `If {{payment.status}} is "Paused"` — a bare word, which the grammar refuses
 * on purpose — so every acceptance guard went on paying for a judge call.
 * Quoting the value gives `"Overdue" is "Paused"`, and the reasoning shows
 * that form.
 */
describe('references are substituted as literals, not as bare text', () => {
  const values = {
    parameters: {
      'payment.status': 'Overdue',
      'line.debit': '',
      'line.credit': '-$65.00',
      'order.title': 'The 12" Monitor',
    },
    envData: { env: { PLAN: 'pro' }, data: {} } as never,
  };
  const sub = (text: string) => substituteAsLiterals(text, values);

  it('quotes a reference the author left bare', () => {
    expect(sub('{{payment.status}} is "Paused"').text).toBe('"Overdue" is "Paused"');
    expect(decide(sub('{{payment.status}} is "Paused"').text)).toBe(false);
    expect(decide(sub('{{payment.status}} is not "Scheduled"').text)).toBe(true);
  });

  it('leaves a reference the author already quoted alone', () => {
    // `""" is empty` would be the alternative, which parses as nothing.
    expect(sub('"{{line.debit}}" is empty').text).toBe('"" is empty');
    expect(decide(sub('"{{line.debit}}" is empty').text)).toBe(true);
    expect(sub('"{{line.credit}}" is not empty').text).toBe('"-$65.00" is not empty');
    expect(decide(sub('"{{line.credit}}" is not empty').text)).toBe(true);
  });

  it('resolves a ${…} reference the same way', () => {
    expect(sub('${env.PLAN} is "pro"').text).toBe('"pro" is "pro"');
    expect(decide(sub('${env.PLAN} is "pro"').text)).toBe(true);
    expect(sub('"${env.PLAN}" is empty').text).toBe('"pro" is empty');
    // Unanswerable, so it stays as written and the grammar refuses it — the
    // judge at least gets a page and a `## Values` block.
    expect(sub('${data.missing} is "x"').text).toBe('${data.missing} is "x"');
    expect(parseLiteralCondition(sub('${data.missing} is "x"').text)).toBeNull();
  });

  it('reports a value it cannot spell, rather than quoting it anyway', () => {
    // The grammar has no escape for a quote, so a value holding one cannot be
    // written as a literal. Reported, and the caller asks the judge.
    const quoted = sub('{{order.title}} contains "Monitor"');
    expect(quoted.unspellable).toBe(true);
    // Belt to that braces: the text it would have produced does not parse
    // either, so a value can never be read as syntax.
    expect(parseLiteralCondition(quoted.text)).toBeNull();
  });

  it('counts the references the AUTHORED text made', () => {
    // Zero is the signal that a condition is not about this run's values at
    // all: `If "Welcome back" is empty` is a sentence about the page.
    expect(sub('"Welcome back" is empty').references).toBe(0);
    expect(sub('{{payment.status}} is "Paused"').references).toBe(1);
    expect(sub('"{{line.debit}}" is "{{line.credit}}"').references).toBe(2);
    // Counted even when nothing answers it — the author still wrote one.
    expect(sub('{{nobody}} is "x"').references).toBe(1);
    expect(sub('${data.missing} is "x"').references).toBe(1);
  });
});

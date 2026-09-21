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

  it('treats whitespace-only as empty, because "exact after trimming" cuts both ways', () => {
    expect(decide('"   " is empty')).toBe(true);
    expect(decide('"   " is not empty')).toBe(false);
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

  it('trims each operand before comparing', () => {
    expect(decide('"  Completed  " is "Completed"')).toBe(true);
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
    // …and would have sorted the other way as text, which is why `numeric`
    // exists rather than the comparison just calling `Number()`.
    expect(decide('"10" is at least "9"')).toBe(true);
  });

  it('refuses an ordering it cannot do numerically, rather than answering false', () => {
    // A currency normaliser is phase 2 (§7.7). Until then this is the judge's,
    // which at least has the page and the `## Values` block.
    expect(parseLiteralCondition('"$140.00" is at least 100')).toBeNull();
    expect(parseLiteralCondition('"Paused" is more than 3')).toBeNull();
    expect(parseLiteralCondition('"" is at least 0')).toBeNull();
  });
});

describe('numeric versus string comparison', () => {
  it('compares numerically when BOTH sides read as plain numbers', () => {
    expect(parseLiteralCondition('"42" is 42')).toMatchObject({ numeric: true, holds: true });
    expect(parseLiteralCondition('"007" is 7')).toMatchObject({ numeric: true, holds: true });
    expect(parseLiteralCondition('2.50 equals 2.5')).toMatchObject({ numeric: true, holds: true });
  });

  it('compares as text the moment one side is not a plain number', () => {
    expect(parseLiteralCondition('"007" is "7"')).toMatchObject({ numeric: true, holds: true });
    expect(parseLiteralCondition('"$7" is "7"')).toMatchObject({ numeric: false, holds: false });
    // The empty-string trap: `Number('')` is 0, so a `Number()`-based test
    // would make this hold.
    expect(parseLiteralCondition('"" is 0')).toMatchObject({ numeric: false, holds: false });
  });

  it('substring forms are always textual, even between numbers', () => {
    expect(parseLiteralCondition('1001 contains 100')).toMatchObject({
      numeric: true,
      holds: true,
    });
    expect(decide('100 contains 1001')).toBe(false);
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

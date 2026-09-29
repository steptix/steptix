/**
 * A control-line condition whose operands are all literals once the
 * placeholders are substituted — and which therefore has an answer in the text
 * (stories/control-flow.md §Runtime; docs/specs/SPEC-structured-table-reads.md
 * §8.3a, which is the rule this file implements — §8.2 is the BINDINGS such a
 * condition reads).
 *
 * ## Why this exists
 *
 * `If "{{line.debit}}" is empty, then …` substitutes to `"" is empty`. That is
 * not a question about the page: both sides are in hand, and the only thing a
 * model call can add is a chance to be wrong. It took one — on an acceptance
 * run of `templates/init/tests/table-statements.md` the judge answered *"none
 * held — the visible statement row being evaluated has debit −$65.00, so
 * {{line.debit}} is not empty"*: it went to the DOM for a fact that was
 * entirely in the sentence, read a different row than the pass was bound to,
 * and sent the loop down the `Otherwise`. The same line was judged correctly
 * five times out of five in `table-payments-reference.md`, which is what makes
 * it the worst kind of bug — a one-in-fifteen flake in a place that should
 * never have been a model call.
 *
 * So the rule is not "help the judge", it is "do not ask". A condition this
 * module recognises is decided here; anything else falls through untouched.
 *
 * ## The grammar, and why it is this small
 *
 * A value is a double-quoted string or a bare number, and nothing else. The
 * point of that restriction is the NEGATIVE case: `the Cash checkbox is
 * ticked` must keep going to the judge, and so must `"{{x}}" is "a"` before
 * substitution, and so must anything with an unquoted word that is not a
 * number. An over-eager grammar here does not produce a wrong answer slowly,
 * it produces a wrong answer instantly and for every run.
 *
 * ```text
 * <v> is empty | is blank | is not empty | is not blank
 * <v> is <v> | equals | is not | does not equal | is different from
 * <v> contains <v> | does not contain | starts with | ends with
 * <v> is at least <n> | at most | more than | less than | greater than
 * ```
 *
 * Keywords are case-insensitive and tolerate any run of whitespace inside a
 * multi-word operator.
 *
 * ## Text is text; only an ordering is a number
 *
 * The equality, substring and emptiness families compare the operands' TEXT,
 * character for character. Only the five orderings are numeric, and only when
 * both operands are plain numbers — otherwise the line goes to the judge
 * rather than being sorted by character code (`"$140.00" is at least 100` does
 * not parse at all; a currency normaliser is phase 2, §7.7, and guessing one
 * here would be the over-eager mistake above).
 *
 * Equality used to coerce too, which read as a kindness — `"42" is 42` — and
 * was a defect. A table read yields exactly the strings numeric coercion
 * destroys: `"0012" is "12"` answered TRUE for two different order numbers,
 * and so did `"1.0" is "1"`, `"+5" is "5"` and `"-0" is "0"`. Zero-padded ids,
 * money strings and version numbers are the normal contents of a cell, so the
 * rule is now the boring one: `is` means the same characters.
 *
 * `"42" is 42` still holds, because the two operands' text is the same four
 * characters once the quotes are off — not because either was parsed.
 *
 * Nothing is trimmed INSIDE quotes: `" " is empty` is false and `"" is " "` is
 * false, because an author who typed the space meant it and a cell that holds
 * one is not the cell that holds nothing. A bare number carries no whitespace
 * to begin with (the grammar matches the digits and nothing else).
 *
 * Deliberately a SIBLING of `set-step.ts` and `flow-control-step.ts` rather
 * than a private helper of the runtime: these are author-facing forms, a
 * handbook has to list them, and a Steptix hover should one day be able to
 * say "this line is decided without a model call" from the same parse.
 */

/** Every comparison this grammar recognises, normalised to lower case with
 *  single spaces — the key a hover or a handbook table would print. */
export type LiteralComparison =
  | 'is empty'
  | 'is blank'
  | 'is not empty'
  | 'is not blank'
  | 'is'
  | 'equals'
  | 'is not'
  | 'does not equal'
  | 'is different from'
  | 'contains'
  | 'does not contain'
  | 'starts with'
  | 'ends with'
  | 'is at least'
  | 'is at most'
  | 'is more than'
  | 'is less than'
  | 'is greater than';

/** One recognised condition: what it compares, how, and the answer. */
export interface LiteralCondition {
  /** The left operand's VALUE — a quoted string's content exactly as written,
   *  or the number as written. */
  left: string;
  operator: LiteralComparison;
  /** The right operand's value. Absent for the four emptiness forms, which
   *  take one operand. */
  right?: string;
  /** True when this comparison was done on NUMBERS — which is the five
   *  orderings and nothing else. Every other family compares text, so a
   *  condition between two plain numbers still reports `false` here. */
  numeric: boolean;
  /** What the condition evaluates to. */
  holds: boolean;
}

/** A double-quoted string or a bare number, and nothing else. */
const VALUE = '"[^"\\n]*"|[-+]?\\d+(?:\\.\\d+)?';

/** A whole operand that reads as a plain number. `Number('')` is 0 and
 *  `Number(' ')` is 0, so this is a regex test rather than a parse — an empty
 *  operand must never compare numerically with `0`. */
const PLAIN_NUMBER = /^[-+]?\d+(?:\.\d+)?$/;

/**
 * The four forms in attempt order, most specific first.
 *
 * Order is belt-and-braces rather than load-bearing: every pattern is anchored
 * and every operand must be a value, so `"a" is not "b"` cannot be read as
 * `is` with a right operand of `not "b"` — `not "b"` is not a value. It is
 * written most-specific-first anyway, because the next person to add an
 * operator will assume that is the rule and they should be right.
 */
const FORMS: ReadonlyArray<{ re: RegExp; kind: 'unary' | 'binary' }> = [
  // `<v> is [not] empty|blank`
  { re: new RegExp(`^(${VALUE})\\s+(is\\s+not|is)\\s+(empty|blank)$`, 'i'), kind: 'unary' },
  // `<v> is at least|at most|more than|less than|greater than <n>`.
  // The `is` is INSIDE the capture: the operator this reports is the key
  // `ORDERINGS` and `compare` switch on, and a group that captured only
  // `at least` reported an operator neither of them knows — so the
  // non-numeric refusal below never fired and `"$140.00" is at least 100`
  // answered `false` on its own authority.
  {
    re: new RegExp(
      `^(${VALUE})\\s+(is\\s+at\\s+least|is\\s+at\\s+most|is\\s+more\\s+than|is\\s+less\\s+than|is\\s+greater\\s+than)\\s+(${VALUE})$`,
      'i',
    ),
    kind: 'binary',
  },
  // The negatives, before the positives they contain.
  {
    re: new RegExp(
      `^(${VALUE})\\s+(is\\s+not|does\\s+not\\s+equal|is\\s+different\\s+from|does\\s+not\\s+contain)\\s+(${VALUE})$`,
      'i',
    ),
    kind: 'binary',
  },
  {
    re: new RegExp(
      `^(${VALUE})\\s+(is|equals|contains|starts\\s+with|ends\\s+with)\\s+(${VALUE})$`,
      'i',
    ),
    kind: 'binary',
  },
];

/**
 * Decide a condition from its own text, or return null to send it to the page.
 *
 * Null is the safe answer and the common one: null means "today's behaviour,
 * exactly". Every reason to return null is a reason the text does not contain
 * the answer.
 */
export function parseLiteralCondition(text: string): LiteralCondition | null {
  const source = text.trim();
  // An unresolved reference is not a literal. `substituteText` leaves what it
  // cannot answer exactly as written, so `"{{order.missing}}" is empty` would
  // otherwise parse as a non-empty quoted string and answer FALSE with
  // complete confidence. The judge at least gets a `## Values` block and a
  // page; this module would be inventing an answer.
  if (source.includes('{{') || source.includes('${')) return null;

  for (const { re, kind } of FORMS) {
    const m = re.exec(source);
    if (!m) continue;
    const operator = normaliseOperator(kind === 'unary' ? `${m[2]!} ${m[3]!}` : m[2]!);
    const left = operandValue(m[1]!);
    if (kind === 'unary') {
      const empty = left === '';
      return {
        left,
        operator,
        numeric: false,
        holds: operator === 'is empty' || operator === 'is blank' ? empty : !empty,
      };
    }
    const right = operandValue(m[3]!);
    // The orderings are the ONLY numeric family, and the one place a
    // non-numeric operand means "I cannot answer". Comparing `"$140.00"` with
    // `100` as text would sort by character and be wrong quietly, and
    // answering `false` would be a silent wrong turn — so the line goes to the
    // judge, which at least has the page and the values block. A currency/date
    // normaliser is phase 2 (§7.7).
    //
    // Everything else is text: see the header on why `is` no longer coerces.
    const numeric =
      ORDERINGS.has(operator) && PLAIN_NUMBER.test(left) && PLAIN_NUMBER.test(right);
    if (ORDERINGS.has(operator) && !numeric) return null;
    return { left, operator, right, numeric, holds: compare(left, right, operator, numeric) };
  }
  return null;
}

/** The five comparisons that only mean anything between two numbers. */
const ORDERINGS: ReadonlySet<LiteralComparison> = new Set([
  'is at least',
  'is at most',
  'is more than',
  'is less than',
  'is greater than',
]);

/** Lower case, single spaces — `Is  Not` and `is not` are one operator. */
function normaliseOperator(raw: string): LiteralComparison {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ') as LiteralComparison;
}

/**
 * A quoted string's content, or a number as written.
 *
 * NOT trimmed inside the quotes. Trimming there made `" " is empty` true and
 * `"" is " "` true — two different values reported as one — and it is the
 * quoted form a substituted `{{cell}}` arrives in, so the cell holding a
 * single space became the cell holding nothing. A bare number is trimmed only
 * because saying so costs a call: the grammar's `[-+]?\d+(\.\d+)?` captures
 * the digits and no surrounding space.
 */
function operandValue(token: string): string {
  return token.startsWith('"') ? token.slice(1, -1) : token.trim();
}

function compare(
  left: string,
  right: string,
  operator: LiteralComparison,
  numeric: boolean,
): boolean {
  switch (operator) {
    // Text, character for character. `numeric` is false for every operator in
    // this half — see the header — and is not consulted here at all.
    case 'is':
    case 'equals':
      return left === right;
    case 'is not':
    case 'does not equal':
    case 'is different from':
      return left !== right;
    // `contains ""` is trivially true, and deliberately left that way: it is
    // what `String.prototype.includes` means, an author who writes it has
    // written a tautology in any language, and a special case here would be a
    // rule nothing else in the grammar has.
    case 'contains':
      return left.includes(right);
    case 'does not contain':
      return !left.includes(right);
    case 'starts with':
      return left.startsWith(right);
    case 'ends with':
      return left.endsWith(right);
    // `numeric` is guaranteed true here — `parseLiteralCondition` refuses an
    // ordering over anything else — and is re-tested only so this function
    // cannot be made unsafe by a future caller.
    case 'is at least':
      return numeric && Number(left) >= Number(right);
    case 'is at most':
      return numeric && Number(left) <= Number(right);
    case 'is more than':
    case 'is greater than':
      return numeric && Number(left) > Number(right);
    case 'is less than':
      return numeric && Number(left) < Number(right);
    default:
      return false;
  }
}


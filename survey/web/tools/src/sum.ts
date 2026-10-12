import { defineTool } from 'steptix/tools';

// Numbers are read in one locale only: US/UK English (en-US).
//
//   decimal separator    "."  "$1.200" is 1.2, one dollar twenty, never 1200
//   thousands separator  ","  groups of three: "1,200" is 1200, "12,345.67"
//   sign                 an optional leading "+" or "-": "-5", "-$5"
//   currency             at most one currency symbol, before or after: "$5",
//                        "5 €"; every value carries the same symbol, or none
//
// Anything else is refused, naming the value, rather than half-read:
// decimal commas ("1,5", "0,500", "1.234,56"), space or apostrophe grouping
// ("1 234", "1'234"), accounting negatives ("(5)"), "$-5", two symbols
// ("$5€"), currency codes ("USD 5", "US$5"), and words or units ("12 items").
//
// The sum is digits with a "." decimal point, no grouping and no symbol,
// with as many decimal places as the most precise value: "1.5" + "2.25"
// is "3.75", "$1.200" + "$2" is "3.200".
const NUMBER = /^([+-]?)\s*(\p{Sc})?\s*([1-9]\d{0,2}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(\p{Sc})?$/u;

interface Parsed { units: bigint; decimals: number; currency: string }

function parse(raw: string): Parsed | null {
  const m = NUMBER.exec(raw.trim());
  if (!m) return null;
  const [, sign, before, whole, fraction = '', after] = m;
  if (before && after) return null;
  const digits = BigInt(whole!.replace(/,/g, '') + fraction);
  return {
    units: sign === '-' ? -digits : digits,
    decimals: fraction.length,
    currency: before ?? after ?? '',
  };
}

export default defineTool({
  name: 'sum',
  description:
    'Add up a list of numbers read off a page, exactly. en-US form only: "." is the decimal ' +
    'point and "," groups thousands, so "$1.200" is 1.2. All values in one currency.',
  parameters: {
    values: { type: 'string[]', description: 'The numbers, as a JSON array of strings' },
  },
  outputs: {
    sum: { type: 'string' },
  },
  run({ values }, { step, log }) {
    const parsed = values.map((raw) => ({ raw, n: parse(raw) }));
    const bad = parsed.filter((p) => p.n === null).map((p) => JSON.stringify(p.raw));
    step.expect(
      bad.length === 0,
      `sum: not a number in en-US form ("." decimal point, "," thousands): ${bad.join(', ')}`,
    );

    // Only like with like: every value in one currency, or none marked with
    // any. A bare number beside "$5" is not known to be dollars.
    const currencies = [...new Set(parsed.map((p) => p.n!.currency))];
    step.expect(
      currencies.length <= 1,
      `sum: values in more than one currency (${currencies.map((c) => c || 'none').join(', ')}): ` +
        values.map((v) => JSON.stringify(v)).join(', '),
    );

    // Add in whole units of the finest decimal place, so 0.1 + 0.2 is 0.3.
    const decimals = Math.max(0, ...parsed.map((p) => p.n!.decimals));
    let total = 0n;
    for (const { n } of parsed) total += n!.units * 10n ** BigInt(decimals - n!.decimals);

    const negative = total < 0n;
    const digits = (negative ? -total : total).toString().padStart(decimals + 1, '0');
    const text = decimals === 0
      ? digits
      : `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
    const result = negative ? `-${text}` : text;

    log.info(`sum of ${values.length} value(s): ${result}`);
    step.setVar('sum', result);
  },
});

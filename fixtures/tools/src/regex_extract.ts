import { defineTool } from 'steptix/tools';

/**
 * Pull a substring out of a larger string with a regular expression.
 *
 * The motivating case: a `read` action captures an element's WHOLE text — e.g.
 * `"Account number: 1234 1234 1234 OIN:12345678"` — but the test only wants the
 * account number. `read` has no way to slice, so pipe its captured value through
 * this tool:
 *
 *   1. Capture the account number line as {{acct_raw}}
 *   2. [tool: regex_extract text="{{acct_raw}}"
 *        pattern="Account number: ([0-9]{4} [0-9]{4} [0-9]{4})"
 *        out.match="account_number"]
 *
 * After step 2, `{{account_number}}` is `"1234 1234 1234"`.
 *
 * Semantics:
 *   - Stores the first capture group. When the pattern declares no group, the
 *     whole match is stored instead (so a bare "match this" pattern still works).
 *   - FAILS HARD (the step errors) when the pattern is invalid or matches
 *     nothing — rather than silently storing "" or the whole input. A wrong
 *     pattern then surfaces at THIS step instead of poisoning a later one. This
 *     mirrors the policy proposed for a future native `read` `pattern` field
 *     (see issues/020).
 *
 * Pure string transform — ignores `page`/`context`, so it works the same on a
 * value read from the DOM, returned by another tool, or written as a literal.
 */

const truncate = (s: string, max = 80): string =>
  s.length > max ? `${s.slice(0, max)}…` : s;

export default defineTool({
  name: 'regex_extract',
  description:
    'Extract a substring from text using a JS regular expression. Stores the first capture group (or the whole match when the pattern has no group). Fails if the pattern is invalid or matches nothing.',
  parameters: {
    text: {
      type: 'string',
      description:
        'Source text to search — usually a {{variable}} captured by an earlier read step or tool.',
    },
    pattern: {
      type: 'string',
      description:
        'A JavaScript regular expression. Put a capture group around the part you want; with no group the whole match is returned.',
    },
    flags: {
      type: 'string',
      default: '',
      description: 'Optional JS regex flags, e.g. "i" (ignore case), "s" (dotAll), "m" (multiline).',
    },
    group: {
      type: 'number',
      default: 1,
      description:
        'Capture-group index to return. Defaults to 1; falls back to the whole match when the pattern declares no groups.',
    },
  },
  outputs: {
    match: { type: 'string', description: 'The extracted substring.' },
  },
  run({ text, pattern, flags, group }, { step, log }) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, flags);
    } catch (err) {
      // Invalid pattern is an authoring error — fail hard, with the engine's reason.
      step.expect(false, `regex_extract: invalid pattern /${pattern}/${flags} — ${(err as Error).message}`);
      return; // unreachable: step.expect threw. Keeps `re` definitely-assigned for TS.
    }

    const m = re.exec(text);
    if (m === null) {
      step.expect(
        false,
        `regex_extract: pattern /${pattern}/${flags} matched nothing in ${JSON.stringify(truncate(text))}`,
      );
      return; // unreachable
    }

    // First capture group by default; fall back to the whole match (index 0)
    // when the requested group did not participate (e.g. a group-less pattern).
    const value = m[group] ?? m[0];
    log.info(`regex_extract: ${JSON.stringify(truncate(text))} =~ /${pattern}/${flags} → ${JSON.stringify(value)}`);
    step.setVar('match', value);
  },
});

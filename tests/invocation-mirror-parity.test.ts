/**
 * The in-package mirrors of the invocation token rule must agree with the
 * tokenizer — checked against each other, not against hand-copied rows.
 *
 * This test did not exist, and that is why they drifted. The errand /
 * project-less scan was a look-alike regex carrying an `/i` the
 * case-sensitive scanner does not have (so `Verify the button reads
 * [Tool Settings]` was refused by `run_errand` as a "code step" while the
 * runner ran it as prose), and code-behind's never-generate rule used `\s`
 * plus a `^` anchor (so a non-breaking space opened a call the scanner calls
 * prose, and every LABELLED call escaped the rule entirely).
 *
 * Both now CALL the parser — `isCodeStep` — rather than imitating it, which
 * is what makes the assertion below true by construction: for every line,
 * "the scan claims it" iff "the runner treats it as a call". A regex could no
 * longer stay honest anyway, since the grammar declines markdown links and
 * unparseable colon-less tokens, and those decisions live inside the parser.
 */
import { describe, it, expect } from 'vitest';
import { isCodeStep } from '../src/mcp/assemble.js';
import { parseSkillCall } from '../src/skills/skill-call-parser.js';
import { parseToolCall } from '../src/tools/tool-call-parser.js';

/** Non-breaking space — U+00A0, the one a paste from a rendered page leaves
 *  behind. Bound to a name because a literal one inline is invisible: the row
 *  would read as a duplicate of the ordinary-space row right above it. */
const NBSP = ' ';

/** What the RUNNER does with the line: is it dispatched/expanded as a call? */
function runnerTreatsAsCall(line: string): boolean {
  for (const parse of [parseSkillCall, parseToolCall]) {
    try {
      if (parse(line)) return true;
    } catch {
      // Committed to a call and found it malformed — still "a call" for the
      // purpose of the scans, which exist to keep such lines out of contexts
      // that cannot run them.
      return true;
    }
  }
  return false;
}

const LINES = [
  // Real calls, both spellings, labelled and bare.
  '[skill: login]',
  '[skill login]',
  '[skill:login]',
  '[skill : login]',
  '[skill\tlogin]',
  '[tool: seed_cart items=2]',
  '[tool seed_cart items=2]',
  'Log in as admin [skill login role="admin"]',
  'Seed the cart [tool: seed_cart items=2]',
  '[skill: auth/login username password]',
  // Prose that must NOT be claimed by anything.
  '[skills]',
  '[skillful]',
  '[skill]',
  '[toolbox]',
  'Verify the button reads [Tool Settings]',
  'Confirm the [Skill Level] badge shows Expert',
  'The nav shows [TOOL BAR] in caps',
  '[SKILL: login]',
  '[TOOL: x]',
  '[ skill: login]',
  `[skill${NBSP}login]`,
  'Click the [skill guide](https://example.com) link',
  'Read the [tool reference](./ref.md) page',
  'Open the cart and check out',
  'Set the ratio to 3:1',
  // A DECLINED candidate must not swallow a real call later on the line.
  // Scanning only the first match made all three of these prose — so the
  // runner skipped a live call, and `isCodeStep` said "no invocation here"
  // for a step carrying one, which is the property run_errand relies on.
  'See the [skill guide](./g.md) and then [skill: login]',
  'Check the [skill level: expert] badge then [skill: login]',
  'Verify the [tool "bar"] icon, then [tool: seed_cart items=2]',
];

describe('invocation token mirrors agree with the tokenizer', () => {
  it('isCodeStep claims a line iff the runner treats it as a call', () => {
    for (const line of LINES) {
      expect(isCodeStep(line), `isCodeStep on ${JSON.stringify(line)}`).toBe(
        runnerTreatsAsCall(line),
      );
    }
  });

  it('is case-sensitive, matching the scanner', () => {
    // `[SKILL: x]` is prose to the runner. A mirror that claimed it made
    // `run_errand` refuse a step the server would have run.
    expect(isCodeStep('[SKILL: login]')).toBe(false);
    expect(runnerTreatsAsCall('[SKILL: login]')).toBe(false);
  });

  it('is unanchored, so a labelled call is still a call', () => {
    expect(isCodeStep('Seed the cart [tool: seed_cart]')).toBe(true);
    expect(isCodeStep('Log in as admin [skill login]')).toBe(true);
  });

  it("uses the scanner's separator class, not `\\s`", () => {
    // `skipInlineSpace` consumes only a space or a tab, so a non-breaking
    // space never opens a call — on either side of the mirror.
    expect(isCodeStep(`[skill${NBSP}login]`)).toBe(false);
    expect(runnerTreatsAsCall(`[skill${NBSP}login]`)).toBe(false);
  });
});

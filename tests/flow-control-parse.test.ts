/**
 * The frozen grammar table for `If … then return` / `… then stop`
 * (stories/step-flow-control.md §Tests, "Grammar table") and for the third
 * verb, `If … then fail …` (stories/step-failure-outcomes.md §Tests).
 *
 * This file is the contract, not a sample of it. Every runner decides whether
 * a step is flow control by calling `parseFlowControlStep` on the authored
 * line, and the executor honours a `return` action ONLY on a step this
 * function accepted — so widening the table widens what a model is allowed to
 * end a run from, and narrowing it silently turns someone's return into prose.
 * Both directions are listed here so a change to the regex has to change a
 * line here too.
 */
import { describe, it, expect } from 'vitest';
import {
  isReturnClaim,
  parseFlowControlStep,
  type ParsedFlowControlStep,
} from '../src/parser/flow-control-step.js';

/** Accepted line → what it must parse to. */
const ACCEPT: Array<[string, ParsedFlowControlStep]> = [
  // ── The unconditional form: the whole step is the tail ──────────────────
  //
  // Every verb against every tail, and deliberately exhaustive rather than
  // representative. The docs describe this form as "a step whose whole text is
  // the tail" and then list the tails; a table that sampled them would let the
  // two drift, and it is the LONG unconditional lines (`Stop running the
  // remaining steps` with no `If` in front of it) that a reader is most likely
  // to think must be conditional.
  //
  // The unconditional form is the ABSENCE of a condition, not a short line.
  // Both docs and story used to describe it as "a step that is just `Return` or
  // `Stop`", which reads as a length rule; the loops actually dispatch on
  // `body === undefined`, and so does compile ineligibility. `toEqual` with no
  // `body` fails on any string body, the empty one included, so every row
  // below pins that for its tail, the long ones too.
  ['Return', { verb: 'return' }],
  ['Stop', { verb: 'stop' }],
  ['return', { verb: 'return' }],
  ['STOP', { verb: 'stop' }],
  ['Return here', { verb: 'return' }],
  ['Stop here', { verb: 'stop' }],
  ['Return running the steps', { verb: 'return' }],
  ['Stop running the steps', { verb: 'stop' }],
  ['Return running the rest of the steps', { verb: 'return' }],
  ['Stop running the rest of the steps', { verb: 'stop' }],
  ['Return running the remaining steps', { verb: 'return' }],
  ['Stop running the remaining steps', { verb: 'stop' }],
  ['Return running the below steps', { verb: 'return' }],
  ['Stop running the below steps', { verb: 'stop' }],
  ['Return running the following steps', { verb: 'return' }],
  ['Stop running the following steps', { verb: 'stop' }],
  // One trailing full stop is dropped; the rest of the normalisation too.
  ['Return.', { verb: 'return' }],
  ['  Stop here.  ', { verb: 'stop' }],
  ['[no-hooks] Return', { verb: 'return' }],
  ['[NO-HOOKS] Stop running the remaining steps', { verb: 'stop' }],

  // ── The conditional form: head, body, joiner, tail ──────────────────────
  [
    'If the page title contains "Dashboard" then return',
    { verb: 'return', body: 'the page title contains "Dashboard"' },
  ],
  [
    'When the page title contains "Dashboard" then return',
    { verb: 'return', body: 'the page title contains "Dashboard"' },
  ],
  [
    'if the dashboard is shown then stop',
    { verb: 'stop', body: 'the dashboard is shown' },
  ],
  [
    'If the page title contains "Dashboard" then stop running the remaining steps',
    { verb: 'stop', body: 'the page title contains "Dashboard"' },
  ],
  // Joiners: bare comma, comma + then, comma + and, then, and.
  ['If we are signed in, return', { verb: 'return', body: 'we are signed in' }],
  ['If we are signed in, then return', { verb: 'return', body: 'we are signed in' }],
  ['If we are signed in, and stop', { verb: 'stop', body: 'we are signed in' }],
  ['If we are signed in and return', { verb: 'return', body: 'we are signed in' }],
  ['When prompted to continue then stop here', { verb: 'stop', body: 'prompted to continue' }],
  // The compound body: a comma AND an action inside the body. The `and`
  // wins because it is the last joiner that leaves a complete tail.
  [
    'If the Save button is visible, click it and return',
    { verb: 'return', body: 'the Save button is visible, click it' },
  ],
  [
    'If the Save button is visible, click it, then stop running the rest of the steps',
    { verb: 'stop', body: 'the Save button is visible, click it' },
  ],
  // The tails the conditional form is least often written with — including the
  // no-adjective `running the steps`, which reads like a near miss and is not.
  [
    'If we are done then stop running the steps',
    { verb: 'stop', body: 'we are done' },
  ],
  [
    'If we are done then return running the below steps',
    { verb: 'return', body: 'we are done' },
  ],
  [
    'When we are done, then stop running the following steps',
    { verb: 'stop', body: 'we are done' },
  ],
  ['[no-hooks] If we are done then stop.', { verb: 'stop', body: 'we are done' }],
  ['IF WE ARE DONE THEN RETURN', { verb: 'return', body: 'WE ARE DONE' }],

  // ── The third verb: `fail` (stories/step-failure-outcomes.md) ───────────
  //
  // The tail's four optional pieces — `the`/`this`, `test`/`run`, `with the`,
  // and the `error`/`message`/`reason` noun — are listed present AND absent
  // rather than sampled, or the prose and the grammar would drift.
  ['Fail', { verb: 'fail' }],
  ['fail', { verb: 'fail' }],
  ['FAIL', { verb: 'fail' }],
  ['Fail the test', { verb: 'fail' }],
  ['Fail this test', { verb: 'fail' }],
  ['Fail the run', { verb: 'fail' }],
  ['Fail this run', { verb: 'fail' }],
  ['Fail with "boom"', { verb: 'fail', message: 'boom' }],
  ['Fail with the message "boom"', { verb: 'fail', message: 'boom' }],
  ['Fail the test with error "boom"', { verb: 'fail', message: 'boom' }],
  ['Fail the test with message "boom"', { verb: 'fail', message: 'boom' }],
  ['Fail the test with reason "boom"', { verb: 'fail', message: 'boom' }],
  ['Fail the run with the error "boom"', { verb: 'fail', message: 'boom' }],
  // Both quote styles: a message may hold the OTHER quote, never its own.
  ["Fail the test with error 'boom'", { verb: 'fail', message: 'boom' }],
  ['Fail the test with error "the page did not say Don\'t panic"',
    { verb: 'fail', message: "the page did not say Don't panic" }],
  ['Fail the test with error \'the title was not "Dashboard"\'',
    { verb: 'fail', message: 'the title was not "Dashboard"' }],
  // One trailing full stop comes off the LINE; one inside the message stays.
  ['Fail the test.', { verb: 'fail' }],
  ['Fail the test with error "Sign in did not reach the dashboard."',
    { verb: 'fail', message: 'Sign in did not reach the dashboard.' }],
  ['[no-hooks] Fail the test with message "boom"', { verb: 'fail', message: 'boom' }],
  ['  Fail the test with message "boom".  ', { verb: 'fail', message: 'boom' }],

  // The conditional form, one row per joiner.
  ['If the balance is zero then fail', { verb: 'fail', body: 'the balance is zero' }],
  ['When the balance is zero then fail', { verb: 'fail', body: 'the balance is zero' }],
  ['If the balance is zero, fail', { verb: 'fail', body: 'the balance is zero' }],
  ['If the balance is zero, then fail', { verb: 'fail', body: 'the balance is zero' }],
  ['If the balance is zero, and fail', { verb: 'fail', body: 'the balance is zero' }],
  ['If the balance is zero and fail', { verb: 'fail', body: 'the balance is zero' }],
  // The bare-whitespace joiner, `fail`-only (see the refused table) — and this
  // is the line the feature was asked for.
  ['If {{a}} is "peanuts" fail the test with error "The variable value was peanuts. Expected apples"',
    { verb: 'fail', body: '{{a}} is "peanuts"',
      message: 'The variable value was peanuts. Expected apples' }],
  // …and its exact reach, one row per way a tail earns it: the NOUN, the
  // MESSAGE, or both. A tail with neither is in the refused table.
  ['If the balance is zero fail the test', { verb: 'fail', body: 'the balance is zero' }],
  ['If the balance is zero fail this run', { verb: 'fail', body: 'the balance is zero' }],
  ['If the balance is zero fail with error "No balance"',
    { verb: 'fail', body: 'the balance is zero', message: 'No balance' }],
  ['When the balance is zero fail the run with the message "No balance"',
    { verb: 'fail', body: 'the balance is zero', message: 'No balance' }],
  // A `{{placeholder}}` in the MESSAGE: the loops interpolate before the
  // executor sees the line, so it is captured un-substituted here.
  ['If {{total}} is wrong then fail the test with error "Expected 10, got {{total}}"',
    { verb: 'fail', body: '{{total}} is wrong', message: 'Expected 10, got {{total}}' }],
  // The compound body: an explicit joiner beats the bare space, so the trailing
  // `and` is the joiner and not the last word of the body.
  ['If the Save button is visible, click it and fail',
    { verb: 'fail', body: 'the Save button is visible, click it' }],
  ['If the Save button is visible, click it, then fail the test with message "Save was still there"',
    { verb: 'fail', body: 'the Save button is visible, click it',
      message: 'Save was still there' }],
  ['[no-hooks] If we are done then fail.', { verb: 'fail', body: 'we are done' }],
  ['IF WE ARE DONE THEN FAIL', { verb: 'fail', body: 'WE ARE DONE' }],
];

/** Refused line → why it stays prose. */
const REFUSE: Array<[string, string]> = [
  [
    'If the page shows X then return to the dashboard',
    'the tail must end the line — "return to the dashboard" is navigate-back prose',
  ],
  [
    'Click save then return',
    'only a line that opens If/When, or is nothing but the tail, is flow control',
  ],
  ['Navigate back and stop the recording', 'same: no head, and the tail does not end the line'],
  ['If the page title contains "Dashboard" then retun', 'verb typo — no claim, so prose'],
  ['If the page title contains "Dashboard" then returns', 'verb must be exact'],
  ['If then return', 'the body is empty'],
  ['When then stop', 'the body is empty'],
  ['Return the book', 'the tail does not end the line'],
  ['Stop the video', 'the tail does not end the line'],
  ['Stop running the tests', '"tests" is not "steps"'],
  ['Stop running steps', 'the grammar spells `running the … steps`'],
  ['If we are done', 'no joiner and no tail'],
  ['If prompted for MFA, enter the code', 'an ordinary conditional — must stay one'],
  ['Verify the dashboard is shown', 'not a claim at all'],
  ['Iffy behaviour then return', 'the head is a whole word'],
  ['Set {{done}} to "yes"', 'a different step form entirely'],
  ['', 'the empty line'],
  ['Return.....', 'only ONE trailing full stop is dropped — an ellipsis is prose'],

  // ── `fail` (stories/step-failure-outcomes.md) ───────────────────────────
  ['Fail loudly', 'the tail must end the line'],
  ['Fail the tests with error "x"', '"tests" is not "test" — the grammar is exact'],
  ['Fail the tests', 'same, without a message'],
  ['Failed to load', 'the verb is a whole word, and the tail must end the line'],
  ['Fail the test with error "x',
    'the message has no closing quote, so the whole `with …` part is unmatched and the line is prose'],
  ["Fail the test with error 'x\"", 'the closing quote must be the same kind as the opening one'],
  ['Fail the test with error x', 'the message must be quoted'],
  ['Fail the test because the balance was wrong', '`because` is not `with`'],
  ['Verify the total then fail the test',
    'only a line that opens If/When, or is nothing but the tail, is flow control'],
  ['Click Save and fail over to the backup', 'no head, and the tail does not end the line'],
  ['If then fail',
    'the body is only the joiner word — the condition was never written, and the ' +
      'bare-space joiner is the one thing that could have read `then` as a condition'],
  ['If and fail the test with error "x"', 'the same, with the other joiner word'],
  ['If  fail', 'a head with nothing between it and the tail is not UNCONDITIONAL either'],
  ['If the upload fails', 'the tail must be the verb, not a word ending in it'],

  // A bare `fail` behind the bare-space joiner claimed ordinary prose in the
  // worst direction: a BDD-style expectation became a flow-control step whose
  // "condition" was the front half of the sentence, so the run went red
  // precisely when the expectation was MET.
  ['When I submit with bad data, the save should fail',
    'the reviewer`s line: an expectation about the page, not an instruction to ' +
      'end the run — read as a claim its condition was "I submit with bad data, the save should"'],
  ['When the customer submits the checkout form with an expired card, the payment should fail',
    'the same sentence at length — nothing about the shape gets less prose-like as it grows'],
  ['If the upload does not fail', 'the condition is ABOUT failing; the line asks for nothing'],
  ['If the login attempts fail', 'the shortest form of the same sentence'],
  ['If the balance is zero fail', 'a bare `fail` needs a real joiner, exactly as `return` does'],
  ['If the balance is zero fail the', 'the article alone is not the noun — `the test` is'],
  // …while the explicit joiners still take a bare `fail` (the accepted table
  // has them), which makes the rule about the JOINER, not about the verb.

  // The other hole the bare space opens: a body ending in an `otherwise` tail's
  // head. Read as a claim the body never runs, the step is exempted from
  // grouping and a model judges a half-sentence — these are steps with a
  // failure tail, and `failure-tail-parse.test.ts` has them from that side.
  ['If the banner is visible, dismiss it, otherwise fail the test with message "No banner"',
    'the body ends in the head of an `otherwise` tail — this is a tail, not a claim'],
  ['If x then fail the test with error "M" otherwise fail',
    'the same shape hiding decision 8`s contradiction: claimed, the executor ' +
      'would never ask whether the line contradicts itself'],
  ['If the banner is visible, dismiss it, or else fail the test',
    'the same, for the second spelling of the head'],
  ['If the upload works, check the total, if it fails fail the test',
    'and the third — `if it fails` is a head wherever it ends a body'],

  ['If we are signed in return', 'no bare-space joiner for `return` — unchanged behaviour, pinned'],
  ['If we are signed in stop', 'no bare-space joiner for `stop` — unchanged behaviour, pinned'],
  ['If we are signed in return here', 'the same, with the longer tail'],
];

describe('parseFlowControlStep — the accepted table', () => {
  for (const [line, expected] of ACCEPT) {
    it(`accepts ${JSON.stringify(line)}`, () => {
      expect(parseFlowControlStep(line)).toEqual(expected);
    });
  }
});

describe('parseFlowControlStep — the refused table', () => {
  for (const [line, why] of REFUSE) {
    it(`refuses ${JSON.stringify(line)} — ${why}`, () => {
      expect(parseFlowControlStep(line)).toBeNull();
    });
  }
});

describe('the shape a runner branches on', () => {
  it('marks the unconditional form by the ABSENCE of a body, not an empty one', () => {
    const parsed = parseFlowControlStep('Return');
    expect(parsed).not.toBeNull();
    // The loops dispatch on `body === undefined` to decide "no model call".
    // An empty-string body would send `Return` to the AI.
    expect(Object.hasOwn(parsed!, 'body')).toBe(false);
    expect(parsed!.body).toBeUndefined();
  });

  it('keeps the body verbatim, placeholders included', () => {
    // The claim is read off the AUTHORED line, before interpolation, so a
    // body may still hold `{{…}}`. It is diagnostics only; the model reads
    // the whole line.
    expect(parseFlowControlStep('If {{state}} is "done" then return')).toEqual({
      verb: 'return',
      body: '{{state}} is "done"',
    });
  });

  it('normalises the verb to lower case whatever was written', () => {
    expect(parseFlowControlStep('STOP HERE')?.verb).toBe('stop');
    expect(parseFlowControlStep('If x then RETURN')?.verb).toBe('return');
    expect(parseFlowControlStep('FAIL THE TEST')?.verb).toBe('fail');
  });
});

describe('the `fail` verb (stories/step-failure-outcomes.md, decision 1)', () => {
  it('reports an absent message as ABSENT, not as an empty string', () => {
    // The seam that composes the error branches on this: with no message it
    // reads `Failed by the step, as written` (decision 3).
    const parsed = parseFlowControlStep('Fail the test');
    expect(parsed).toEqual({ verb: 'fail' });
    expect(Object.hasOwn(parsed!, 'message')).toBe(false);
  });

  it('keeps an empty message as WRITTEN, which a consumer reads as none', () => {
    // `with error ""` is degenerate rather than illegal — the field is present,
    // and a falsy message is worded like an absent one, so the check above is
    // not a rule that empties get dropped.
    expect(parseFlowControlStep('Fail the test with error ""')).toEqual({
      verb: 'fail',
      message: '',
    });
  });
});

describe('isReturnClaim — the hook gate (decision 7)', () => {
  it('is true for the two verbs that leave a flow and false for `fail`', () => {
    for (const line of ['Return', 'Stop here', 'If x then return', 'If x, then stop']) {
      expect(isReturnClaim(parseFlowControlStep(line)!), line).toBe(true);
    }
    for (const line of ['Fail', 'Fail the test with error "x"', 'If x then fail']) {
      expect(isReturnClaim(parseFlowControlStep(line)!), line).toBe(false);
    }
  });

  it('narrows the union, so a caller can read the message after the check', () => {
    // Not style: the three refusal sites gate on it, and a predicate that did
    // not narrow would leave each of them casting.
    const claim = parseFlowControlStep('Fail the test with error "x"')!;
    expect(isReturnClaim(claim)).toBe(false);
    if (!isReturnClaim(claim)) expect(claim.message).toBe('x');
  });
});

/**
 * The frozen grammar table for `If … then return` / `… then stop`
 * (stories/step-flow-control.md §Tests, "Grammar table").
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
];

/**
 * The unconditional form is the ABSENCE of a condition, not a short line.
 *
 * Both docs and story used to describe it as "a step that is just `Return` or
 * `Stop`", which reads as a length rule; the loops actually dispatch on
 * `body === undefined`, and so does compile ineligibility. These are the long
 * lines that rule has to keep answering "unconditional" for.
 */
const LONG_UNCONDITIONAL = [
  'Return here',
  'Stop running the steps',
  'Stop running the remaining steps',
  'Return running the following steps',
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

  it('reads a LONG tail with no head as unconditional too', () => {
    for (const line of LONG_UNCONDITIONAL) {
      const parsed = parseFlowControlStep(line);
      expect(parsed, line).not.toBeNull();
      expect(Object.hasOwn(parsed!, 'body'), line).toBe(false);
    }
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
  });
});

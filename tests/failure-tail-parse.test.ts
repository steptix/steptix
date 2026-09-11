/**
 * The frozen grammar table for the `otherwise` tail
 * (stories/step-failure-outcomes.md §Tests, "The `otherwise` table").
 *
 * The tail decides what the MODEL is shown (the body, never the tail) and what
 * happens once the body has finally failed (decisions 4-6), so both directions
 * are listed: widening the table widens what stops being prose, narrowing it
 * turns someone's `otherwise continue` into a step that takes the run down.
 */
import { describe, it, expect } from 'vitest';
import {
  FAILURE_TAIL_CONTRADICTION,
  directiveFailureTail,
  directiveFailureTailError,
  failureTailContradictionError,
  failureTailDirective,
  isFailureTailContradiction,
  parseFailureTail,
  stripFailureTail,
  type ParsedFailureTail,
} from '../src/parser/failure-tail.js';
import { parseFlowControlStep } from '../src/parser/flow-control-step.js';
import { parseTestContent } from '../src/parser/markdown.js';

/** A `## Steps` document whose numbered steps are the lines given. */
const md = (...steps: string[]) =>
  `# t\n\n## Steps\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`;

/** A `### Section` body, to append to an `md(...)` document. */
const section = (name: string, ...steps: string[]) =>
  `\n### ${name}\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`;

/** Every `expected` must appear in the error `parseTestContent` throws. */
function expectRefusal(content: string, ...expected: string[]): void {
  for (const e of expected) expect(() => parseTestContent(content, '/t/c.md')).toThrow(e);
}

/** Accepted line → what it must parse to. */
const ACCEPT: Array<[string, ParsedFailureTail]> = [
  // Every spelling of the head, "and if that did not work".
  ['Click Save otherwise fail', { body: 'Click Save', outcome: 'fail' }],
  ['Click Save, otherwise fail', { body: 'Click Save', outcome: 'fail' }],
  ['Click Save otherwise, fail', { body: 'Click Save', outcome: 'fail' }],
  ['Click Save, otherwise, fail', { body: 'Click Save', outcome: 'fail' }],
  ['Click Save or else fail', { body: 'Click Save', outcome: 'fail' }],
  ['Click Save, or else, continue', { body: 'Click Save', outcome: 'continue' }],
  ['Click Save if it fails continue', { body: 'Click Save', outcome: 'continue' }],
  ['Click Save, if it fails, continue', { body: 'Click Save', outcome: 'continue' }],
  ['Click Save, if that fails, continue', { body: 'Click Save', outcome: 'continue' }],
  ['Click Save, if this fails, continue', { body: 'Click Save', outcome: 'continue' }],
  ['CLICK SAVE OTHERWISE CONTINUE', { body: 'CLICK SAVE', outcome: 'continue' }],

  // Outcome 1: `fail` (decision 5) — the last row is the message-less form,
  // legal so that it and `with message "…"` are ONE grammar.
  ['Verify the title contains "Account details" otherwise fail the test with message "Page did not contain account details"',
    { body: 'Verify the title contains "Account details"', outcome: 'fail',
      message: 'Page did not contain account details' }],
  ['Verify the balance otherwise fail the run with the error "No balance"',
    { body: 'Verify the balance', outcome: 'fail', message: 'No balance' }],
  ["Verify the balance otherwise fail with reason 'No balance'",
    { body: 'Verify the balance', outcome: 'fail', message: 'No balance' }],
  ['Verify the balance otherwise fail the test', { body: 'Verify the balance', outcome: 'fail' }],

  // Outcome 2: `continue`, with and without a warning (decision 6).
  ['Dismiss the promo banner otherwise continue',
    { body: 'Dismiss the promo banner', outcome: 'continue' }],
  ['Dismiss the promo banner otherwise carry on',
    { body: 'Dismiss the promo banner', outcome: 'continue' }],
  ['Dismiss the promo banner otherwise keep going',
    { body: 'Dismiss the promo banner', outcome: 'continue' }],
  ['Verify the footer shows the build number otherwise continue with warning "Footer build number missing"',
    { body: 'Verify the footer shows the build number', outcome: 'continue',
      message: 'Footer build number missing' }],
  ['Verify the footer otherwise continue with a warning "missing"',
    { body: 'Verify the footer', outcome: 'continue', message: 'missing' }],
  ['Verify the footer otherwise continue with message "missing"',
    { body: 'Verify the footer', outcome: 'continue', message: 'missing' }],
  ["Verify the footer otherwise keep going with a message 'missing'",
    { body: 'Verify the footer', outcome: 'continue', message: 'missing' }],

  // Outcome 3: `warn "…"`, the short spelling of the one above.
  ['Dismiss the promo banner otherwise warn "no banner"',
    { body: 'Dismiss the promo banner', outcome: 'continue', message: 'no banner' }],
  ['Dismiss the promo banner otherwise warn with "no banner"',
    { body: 'Dismiss the promo banner', outcome: 'continue', message: 'no banner' }],
  ["Dismiss the promo banner, if it fails, warn 'no banner'",
    { body: 'Dismiss the promo banner', outcome: 'continue', message: 'no banner' }],

  // Where the split falls: the anchor settles on the LAST head that still
  // leaves a complete outcome, so a comma in the body is safe.
  ['Enter the code, click Verify, otherwise continue',
    { body: 'Enter the code, click Verify', outcome: 'continue' }],
  // A conditional body: the dangerous reading is a conditional FAIL whose
  // condition ends in `otherwise`, which `parseFlowControlStep` refuses.
  ['If the banner is visible, dismiss it, otherwise fail the test with message "No banner"',
    { body: 'If the banner is visible, dismiss it', outcome: 'fail', message: 'No banner' }],
  // A quoted `"otherwise"` in the body: the first split leaves no outcome.
  ['Verify the text says "otherwise" otherwise continue',
    { body: 'Verify the text says "otherwise"', outcome: 'continue' }],
  // Markers ride in the body (the FRAMEWORK runs them), bar `[no-hooks]`.
  ['[output: balance] Read the balance otherwise continue',
    { body: '[output: balance] Read the balance', outcome: 'continue' }],
  ['[no-hooks] Click Save otherwise continue', { body: 'Click Save', outcome: 'continue' }],
  ['  Click Save otherwise continue.  ', { body: 'Click Save', outcome: 'continue' }],
  // A TRAILING marker is the run loop's, not the author's: the grammar is
  // `$`-anchored, so without this the tail dies on every capturing step.
  ['Read the total otherwise continue [store as: total]',
    { body: 'Read the total [store as: total]', outcome: 'continue' }],
  ['Verify the total otherwise fail the test with message "no total" [store as: total]',
    { body: 'Verify the total [store as: total]', outcome: 'fail', message: 'no total' }],
  // More than one, and markers at BOTH ends of the line.
  ['[as: admin] Read the total otherwise continue [store as: total] [as: admin]',
    { body: '[as: admin] Read the total [store as: total] [as: admin]', outcome: 'continue' }],
];

/** Refused line → why it stays what it was. */
const REFUSE: Array<[string, string]> = [
  ['Click Save', 'no tail at all — an ordinary step'],
  ['Verify the total then fail the test', 'no head: `then` does not open a tail'],
  ['Otherwise continue',
    'the body is empty — at line start this is a chain `Otherwise` whose tail is `continue`'],
  ['Otherwise fail the test with error "No balance was shown"',
    'the same: a chain `Otherwise` whose tail is the unconditional `Fail …`'],
  ['otherwise, continue', 'the body is empty however the head is punctuated'],
  ['Click Save otherwise', 'a head with no outcome'],
  ['Click Save otherwise retry', '`retry` is not an outcome — the line stays prose'],
  ['Click Save otherwise continue to the next page',
    'the outcome must END the line, or a tail with prose after it would eat the prose'],
  ['Click Save otherwise warn', '`warn` says nothing without its message'],
  ['Click Save otherwise continue with warning',
    'the warning noun without a quoted message leaves the line unmatched'],
  ['Click Save otherwise fail the tests', '`tests` is not `test`, in either grammar'],
  ['Click Save otherwise fail with error "x', 'the message has no closing quote'],
  ['Click Save otherwise continue to the next page [store as: x]',
    'the markers are held back and the outcome still does not end what is left — ' +
      'holding them back widens where the tail may sit, not what may follow it'],
  ['Click Save otherwise continue [store as: x] then Save again',
    'a `[…]` block only rides in the body when it ENDS the line'],
  ['Click Save if it failed continue', 'the head is `if it fails`, present tense'],
  ['Click Save if we fail continue', '`we` is not one of `it` / `that` / `this`'],
  // Decisions 8 and 12 are refused HERE as well as at the validator, because
  // the raw Sessions API path runs no validator.
  ['If x then return otherwise continue', 'a contradiction (decision 8), not a tail'],
  ['If x then fail otherwise continue', 'the same, with the third verb'],
  ['Return otherwise continue', 'an unconditional claim under a tail is the same contradiction'],
  ['[tool: fetch_orders] otherwise continue', 'decision 12 — a `[tool:]` step takes no tail'],
  ['[tool: fetch_orders] otherwise fail the test with message "no orders"',
    'the same for the other outcome'],
  ['Upload the invoice [tool: upload_invoice] otherwise continue',
    'the label form is as much a tool call as the bare bracket is'],
  ['[tool fetch_orders] otherwise continue', 'the token`s colon is optional, so the rule is too'],
  ['', 'the empty line'],
];

describe('parseFailureTail — the accepted table', () => {
  for (const [line, expected] of ACCEPT) {
    it(`accepts ${JSON.stringify(line)}`, () => {
      expect(parseFailureTail(line)).toEqual(expected);
    });
  }
});

describe('parseFailureTail — the refused table', () => {
  for (const [line, why] of REFUSE) {
    it(`refuses ${JSON.stringify(line)} — ${why}`, () => {
      expect(parseFailureTail(line)).toBeNull();
    });
  }
});

describe('the shape the executor branches on', () => {
  it('reports an absent message as ABSENT, not as an empty string', () => {
    // A message-less `otherwise fail` keeps the framework's error and a bare
    // `otherwise continue` has no warning for the row; both decide on absence.
    const failed = parseFailureTail('Click Save otherwise fail')!;
    expect(Object.hasOwn(failed, 'message')).toBe(false);
    const tolerated = parseFailureTail('Click Save otherwise continue')!;
    expect(Object.hasOwn(tolerated, 'message')).toBe(false);
  });

  it('wins a body that ends in `otherwise` back off the flow-control grammar', () => {
    // Read as flow control the body never runs and a model judges a
    // half-sentence; read here it is the step the author wrote.
    const line =
      'If the banner is visible, dismiss it, otherwise fail the test with message "No banner"';
    expect(parseFlowControlStep(line)).toBeNull();
    expect(parseFailureTail(line)?.body).toBe('If the banner is visible, dismiss it');
    expect(stripFailureTail(line)).toBe('If the banner is visible, dismiss it');
  });

  it('reads `warn "…"` as `continue with warning "…"`, not as its own outcome', () => {
    // One flag, two spellings: a third outcome value would be a third branch in
    // every loop for a difference that is only wording.
    expect(parseFailureTail('Click Save otherwise warn "m"')).toEqual(
      parseFailureTail('Click Save otherwise continue with warning "m"'),
    );
  });

  it('keeps the body verbatim, placeholders and quotes included', () => {
    // Read off the AUTHORED line, before `{{…}}` interpolation, so both the
    // body and the message may still hold placeholders.
    expect(
      parseFailureTail('Verify the total is {{total}} otherwise fail with message "want {{total}}"'),
    ).toEqual({
      body: 'Verify the total is {{total}}',
      outcome: 'fail',
      message: 'want {{total}}',
    });
  });
});

/**
 * Line → what the prompt is handed (decision 4): the tail gone, every marker at
 * either end kept verbatim, one trailing full stop off, and a line with no tail
 * returned unchanged.
 */
const STRIP: Array<[string, string]> = [
  // The tail goes and nothing else does.
  ['Click Save otherwise fail', 'Click Save'],
  ['Verify the title contains "Account details" otherwise fail the test with message "Page did not contain account details"',
    'Verify the title contains "Account details"'],
  // Leading markers stay: a lost `[output: x]` would change what is captured.
  ['[no-hooks] Click Save otherwise continue', '[no-hooks] Click Save'],
  ['[output: x] Read the balance otherwise continue', '[output: x] Read the balance'],
  ['[as: admin] Click Save otherwise fail with message "m"', '[as: admin] Click Save'],
  // Cut at the TAIL: the body also occurs inside the marker in front of it, so
  // a cut located by search would lose everything the author wrote.
  ['[as: total] total otherwise continue', '[as: total] total'],
  ['[output: save] Click Save otherwise fail', '[output: save] Click Save'],
  // The run loop's trailing marker survives on the far side of the tail — this
  // is what an `[output: total]` step hands the model — then both ends at once.
  ['Read the total otherwise continue [store as: total]', 'Read the total [store as: total]'],
  ['Verify the total otherwise fail the test with message "no total" [store as: total]',
    'Verify the total [store as: total]'],
  ['[no-hooks] Read the total otherwise continue [store as: total]',
    '[no-hooks] Read the total [store as: total]'],
  // No tail parses → the input, unchanged.
  ['Click Save', 'Click Save'],
  ['Otherwise continue', 'Otherwise continue'],
  ['If x then return otherwise continue', 'If x then return otherwise continue'],
  ['[no-hooks] Click Save.', '[no-hooks] Click Save.'],
  ['', ''],
  // A full stop after the tail comes off; one inside the body stays.
  ['Click Save otherwise continue.', 'Click Save'],
  ['Click Save. Then wait otherwise continue', 'Click Save. Then wait'],
];

describe('stripFailureTail — what the model is handed', () => {
  it.each(STRIP)('%j → %j', (line, expected) => {
    expect(stripFailureTail(line)).toBe(expected);
  });
});

describe('the contradiction of decision 8', () => {
  const CONTRADICTIONS = [
    'If x then return otherwise continue',
    'If x then stop otherwise continue',
    'If x then fail otherwise continue',
    'If x then fail the test with error "m" otherwise continue',
    'If x, then return, otherwise fail the test with message "m"',
    'Return otherwise continue',
    'Stop here or else continue',
  ];

  it('is true exactly for a flow-control body under a tail', () => {
    for (const line of CONTRADICTIONS) {
      expect(isFailureTailContradiction(line), line).toBe(true);
      // …and the tail parser refuses it, so no caller gets half the meaning.
      expect(parseFailureTail(line), line).toBeNull();
    }
  });

  it('sees the contradiction even when the body ends in the tail`s own head', () => {
    // This used to be a plain `fail` CLAIM — the bare-space joiner let
    // `otherwise` end the condition — so the question was never asked.
    const line = 'If x then fail the test with error "M" otherwise fail';
    expect(parseFlowControlStep(line)).toBeNull();
    expect(isFailureTailContradiction(line)).toBe(true);
    expect(parseFailureTail(line)).toBeNull();
  });

  it('is false for a line with no tail, and for an ordinary tail', () => {
    for (const line of [
      'If x then return',
      'Return',
      'Click Save',
      'Click Save otherwise continue',
      'Verify the return value otherwise continue',
      'Otherwise continue',
    ]) {
      expect(isFailureTailContradiction(line), line).toBe(false);
    }
  });

  it('names the line and says what to do instead', () => {
    const message = failureTailContradictionError(
      'If x then return otherwise continue',
      ' in tests/t.md at line 7',
    );
    expect(message).toContain(FAILURE_TAIL_CONTRADICTION);
    expect(message).toContain('"If x then return otherwise continue"');
    expect(message).toContain(' in tests/t.md at line 7');
    // The teaching half: the fix, not a restatement of the rule.
    expect(message).toContain('own line');
  });
});

describe('the `## Steps` validator refuses a contradiction at parse time', () => {
  const withStep = (step: string) => md('Navigate to /', step, 'Click Save');

  it('throws, naming the line and the file', () => {
    expectRefusal(
      withStep('If the balance is zero then return otherwise continue'),
      FAILURE_TAIL_CONTRADICTION,
      '/t/c.md',
    );
  });

  it('refuses the `fail` verb under a tail too', () => {
    expectRefusal(
      withStep('If the balance is zero then fail the test with error "m" otherwise continue'),
      FAILURE_TAIL_CONTRADICTION,
    );
  });

  it('leaves an ordinary tail, and an ordinary flow-control step, alone', () => {
    // The refusal is about the CONTRADICTION; both halves are the feature
    // everywhere else, and a validator that over-reached would delete them.
    const steps = [
      'Dismiss the promo banner otherwise continue',
      'Verify the title contains "Dashboard" otherwise fail the test with message "no dashboard"',
      'If the balance is zero then return',
      'Fail the test with error "unreachable"',
    ];
    expect(parseTestContent(md(...steps), '/t/ok.md').steps).toEqual(steps);
  });
});

describe('a `[tool:]` or `[skill:]` step under a tail (decision 12)', () => {
  it('names the directive it found, for a tool body and a skill body alike', () => {
    for (const [line, kind] of [
      ['[tool: fetch_orders] otherwise continue', 'tool'],
      ['[tool: fetch_orders] otherwise fail the test with message "no orders"', 'tool'],
      ['Upload the invoice [tool: upload_invoice] otherwise continue', 'tool'],
      ['[tool fetch_orders] otherwise continue', 'tool'],
      // The skill twin drops its tail as silently — `parseInvocation` hands the
      // expander ` otherwise continue` as `trailing` text nothing reads — and
      // the LABELLED form, where a body stops looking like a bare bracket.
      ['[skill: sign_in] otherwise continue', 'skill'],
      ['[skill: sign_in] otherwise fail the test with message "no session"', 'skill'],
      ['Do it [skill: sign_in] otherwise fail the test with error "m"', 'skill'],
      ['[skill sign_in] otherwise continue', 'skill'],
      // The accepted OVER-REACH: a colon-less candidate `parseInvocation` would
      // decline as English is refused here too, since the alternative is a tail
      // the validator lets through and this module declines — silence.
      ['Verify the [skill level: expert] badge otherwise continue', 'skill'],
    ] as const) {
      expect(failureTailDirective(line), line).toBe(kind);
      // …and the parser declines what the validator refuses, so the loops see
      // the line they always saw.
      expect(parseFailureTail(line), line).toBeNull();
      expect(stripFailureTail(line), line).toBe(line);
    }
  });

  it('is null for a directive step with no tail, and for a tail with no directive', () => {
    for (const line of [
      '[tool: fetch_orders]',
      'Upload the invoice [tool: upload_invoice]',
      '[skill: sign_in]',
      'Sign in first [skill: sign_in]',
      'Dismiss the promo banner otherwise continue',
      'Verify the total otherwise fail with message "m"',
      // The word, not the token: a step may talk about tools and skills.
      'Check the tool list otherwise continue',
      'Open the [tools] menu otherwise continue',
      'Check the skills list otherwise continue',
      'Open the [skills] menu otherwise continue',
      // The CASE, which the copy this check used to be got wrong: the rule is
      // built from `invocationTokenPattern` and is case-SENSITIVE, so
      // `[SKILL: x]` is prose to the runner too.
      '[SKILL: sign_in] otherwise continue',
      '[Tool: fetch_orders] otherwise continue',
    ]) {
      expect(failureTailDirective(line), line).toBeNull();
    }
    // …and the upper-case line really is a TAIL, not just un-refused, while its
    // lower-case twin is refused; a directive-less line keeps its tail too.
    expect(parseFailureTail('[SKILL: sign_in] otherwise continue')).toEqual({
      body: '[SKILL: sign_in]',
      outcome: 'continue',
    });
    expect(parseFailureTail('[skill: sign_in] otherwise continue')).toBeNull();
    expect(parseFailureTail('Check the tool list otherwise continue')).toEqual({
      body: 'Check the tool list',
      outcome: 'continue',
    });
    expect(parseFailureTail('Open the [skills] menu otherwise continue')).toEqual({
      body: 'Open the [skills] menu',
      outcome: 'continue',
    });
  });

  it('names the line and says what to do instead, differently for each directive', () => {
    const toolMessage = directiveFailureTailError(
      '[tool: fetch_orders] otherwise continue',
      'tool',
      ' in tests/t.md at line 7',
    );
    expect(toolMessage).toContain(directiveFailureTail('tool'));
    expect(toolMessage).toContain('"[tool: fetch_orders] otherwise continue"');
    expect(toolMessage).toContain(' in tests/t.md at line 7');
    // The teaching half: a tool call has no body and no wrapper that works (a
    // section is matched by the EXACT calling line), so — a step after it.
    expect(toolMessage).toContain('a step after the call');
    expect(toolMessage).not.toMatch(/section/i);

    const skillMessage = directiveFailureTailError(
      '[skill: sign_in] otherwise continue',
      'skill',
      ' in tests/t.md at line 3',
    );
    expect(skillMessage).toContain(directiveFailureTail('skill'));
    expect(skillMessage).toContain('[skill:]');
    expect(skillMessage).toContain('"[skill: sign_in] otherwise continue"');
    // A skill already HAS steps, so the way out differs — still not a wrapper.
    expect(skillMessage).toContain('a step inside the skill');
    expect(skillMessage).not.toMatch(/section/i);
  });

  it('is refused at parse time, in `## Steps` and in a section body alike', () => {
    const tool = directiveFailureTail('tool');
    const skill = directiveFailureTail('skill');
    expectRefusal(md('Navigate to /', '[tool: fetch_orders] otherwise continue'), tool, '/t/c.md');
    expectRefusal(
      md('Load the orders') + section('Load the orders', '[tool: fetch_orders] otherwise continue'),
      tool,
    );
    expectRefusal(md('Navigate to /', '[skill: sign_in] otherwise continue'), skill, '/t/c.md');
    expectRefusal(md('Sign in [skill: sign_in] otherwise fail the test with error "no session"'), skill);
    expectRefusal(
      md('Sign in') + section('Sign in', '[skill: sign_in] otherwise continue'),
      skill,
    );
  });

  it('leaves an ordinary tool or skill step alone', () => {
    const steps = [
      '[tool: fetch_orders]',
      '[skill: sign_in]',
      'Dismiss the promo banner otherwise continue',
    ];
    expect(parseTestContent(md(...steps), '/t/ok.md').steps).toEqual(steps);
  });
});

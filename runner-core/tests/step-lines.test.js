import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  classifyLines,
  classifySelectedSteps,
  extractSteps,
  danglingChainMemberError,
  isStepLine,
  isTestFile,
  nearestStepAtOrAbove,
  nearestStepAtOrBelow,
  resolveRunLines,
} from '../dist/step-lines.js';

test('isTestFile: detects ## Steps', () => {
  assert.equal(isTestFile('## Steps'), true);
});

test('isTestFile: case-insensitive, ###+ allowed', () => {
  assert.equal(isTestFile('### steps'), true);
  assert.equal(isTestFile('#### STEPS'), true);
});

test('isTestFile: rejects when no Steps heading', () => {
  assert.equal(isTestFile('# Title\n\nSome prose.'), false);
});

test('isTestFile: rejects # Steps (level 1)', () => {
  assert.equal(isTestFile('# Steps'), false);
});

test('classifyLines: marks numbered items under ## Steps as steps', () => {
  const text = ['## Steps', '1. First', '2. Second', '3. Third'].join('\n');
  const lines = classifyLines(text);
  assert.equal(lines[0].kind, 'heading');
  assert.equal(lines[1].kind, 'step');
  assert.equal(lines[2].kind, 'step');
  assert.equal(lines[3].kind, 'step');
});

test('classifyLines: numbered items outside Steps section are prose', () => {
  const text = ['# Title', '1. Not a step', '## Steps', '1. Yes a step'].join('\n');
  const lines = classifyLines(text);
  assert.equal(lines[1].kind, 'prose');
  assert.equal(lines[3].kind, 'step');
});

test('classifyLines: indented numbered items are not steps', () => {
  const text = ['## Steps', '1. Outer', '  1. Sub', '2. Outer two'].join('\n');
  const lines = classifyLines(text);
  assert.equal(lines[1].kind, 'step');
  assert.equal(lines[2].kind, 'prose');
  assert.equal(lines[3].kind, 'step');
});

test('classifyLines: Steps section ends at next same-or-shallower heading', () => {
  const text = [
    '## Steps',
    '1. In section',
    '## Notes',
    '1. Not in section',
  ].join('\n');
  const lines = classifyLines(text);
  assert.equal(lines[1].kind, 'step');
  assert.equal(lines[3].kind, 'prose');
});

test('classifyLines: deeper headings inside Steps do not end the section', () => {
  const text = [
    '## Steps',
    '1. Outer',
    '### Subsection',
    '2. Still in steps',
  ].join('\n');
  const lines = classifyLines(text);
  assert.equal(lines[1].kind, 'step');
  // Still inside the Steps span — the `###` does not close it. What changed
  // with inline sections is the ATTRIBUTION: line 4 now belongs to the
  // `### Subsection` body rather than to the main flow, so it runs when
  // something invokes that section rather than inline.
  //
  // This is the one deliberate behaviour change of the sections line model,
  // and it is scoped to files that put a `###` inside `## Steps`. A sweep of
  // every Markdown file in the repo found no test fixture or template
  // affected — only the sections fixtures themselves and some design docs
  // under stories/, which were never runnable. See the regression corpus
  // suite for the standing guard.
  assert.equal(lines[2].kind, 'section-heading');
  assert.equal(lines[3].kind, 'section-step');
});

test('classifyLines: a deeper heading still does not end the Steps span', () => {
  // The original intent of the test above, stated so it survives independent
  // of how body lines are attributed: everything after the `###` is still
  // inside Steps, and a following `##` is what actually closes it.
  const text = ['## Steps', '1. Outer', '### Subsection', '2. Body', '## Notes', '1. Not a step'].join(
    '\n',
  );
  const lines = classifyLines(text);
  assert.equal(lines[3].kind, 'section-step');
  assert.equal(lines[4].kind, 'heading');
  assert.equal(lines[5].kind, 'prose');
});

test('classifyLines: handles YAML frontmatter', () => {
  const text = [
    '---',
    'title: foo',
    '---',
    '## Steps',
    '1. Hi',
  ].join('\n');
  const lines = classifyLines(text);
  assert.equal(lines[0].kind, 'frontmatter');
  assert.equal(lines[2].kind, 'frontmatter');
  assert.equal(lines[3].kind, 'heading');
  assert.equal(lines[4].kind, 'step');
});

test('classifyLines: 1) style is not a step (documented limitation)', () => {
  const text = ['## Steps', '1) Not a step', '1. Yes a step'].join('\n');
  const lines = classifyLines(text);
  assert.equal(lines[1].kind, 'prose');
  assert.equal(lines[2].kind, 'step');
});

test('isStepLine + nearest helpers', () => {
  const text = ['# T', '## Steps', '1. one', '2. two', '', '3. three'].join('\n');
  assert.equal(isStepLine(text, 3), true);
  assert.equal(isStepLine(text, 5), false);
  assert.equal(nearestStepAtOrBelow(text, 5), 6);
  assert.equal(nearestStepAtOrBelow(text, 7), null);
  assert.equal(nearestStepAtOrAbove(text, 5), 4);
  assert.equal(nearestStepAtOrAbove(text, 1), null);
});

test('extractSteps: returns instructions with line numbers', () => {
  const text = ['## Steps', '1. Click button', '2. Wait for page'].join('\n');
  const steps = extractSteps(text);
  assert.deepEqual(steps, [
    { line: 2, instruction: 'Click button' },
    { line: 3, instruction: 'Wait for page' },
  ]);
});

// ---------------------------------------------------------------------------
// classifySelectedSteps — recognises [input:] / [interactive] markers
// ---------------------------------------------------------------------------

test('classifySelectedSteps: empty requestedLines runs every step', () => {
  const text = ['## Steps', '1. one', '2. two'].join('\n');
  const got = classifySelectedSteps(text, []);
  assert.deepEqual(got, [
    { kind: 'step', line: 2, instruction: 'one' },
    { kind: 'step', line: 3, instruction: 'two' },
  ]);
});

test('classifySelectedSteps: filters by requestedLines and preserves order', () => {
  const text = ['## Steps', '1. one', '2. two', '3. three'].join('\n');
  const got = classifySelectedSteps(text, [4, 2]); // out-of-order input
  assert.deepEqual(got, [
    { kind: 'step', line: 2, instruction: 'one' },
    { kind: 'step', line: 4, instruction: 'three' },
  ]);
});

test('classifySelectedSteps: tags [input: var] with prompt text', () => {
  const text = ['## Steps', '1. [input: username] Enter your username'].join('\n');
  const got = classifySelectedSteps(text, []);
  assert.deepEqual(got, [
    { kind: 'input', line: 2, varName: 'username', prompt: 'Enter your username' },
  ]);
});

test('classifySelectedSteps: [input: var] without prompt text uses default', () => {
  const text = ['## Steps', '1. [input: code]'].join('\n');
  const got = classifySelectedSteps(text, []);
  assert.equal(got[0].kind, 'input');
  assert.equal(got[0].varName, 'code');
  assert.equal(got[0].prompt, 'Enter value for {{code}}');
});

test('classifySelectedSteps: [interactive] tags with hint', () => {
  const text = ['## Steps', '1. [interactive] explore the page'].join('\n');
  const got = classifySelectedSteps(text, []);
  assert.deepEqual(got, [
    { kind: 'interactive', line: 2, hint: 'explore the page' },
  ]);
});

test('classifySelectedSteps: [interactive] without hint uses default', () => {
  const text = ['## Steps', '1. [interactive]'].join('\n');
  const got = classifySelectedSteps(text, []);
  assert.equal(got[0].kind, 'interactive');
  assert.match(got[0].hint, /done.*continue/i);
});

test('classifySelectedSteps: [input:] is case-insensitive', () => {
  const text = ['## Steps', '1. [INPUT: token] paste here', '2. [Interactive] poke'].join('\n');
  const got = classifySelectedSteps(text, []);
  assert.equal(got[0].kind, 'input');
  assert.equal(got[0].varName, 'token');
  assert.equal(got[1].kind, 'interactive');
});

test('classifySelectedSteps: mixes step / input / interactive in order', () => {
  const text = [
    '## Steps',
    '1. open homepage',
    '2. [input: user] username?',
    '3. login as {{user}}',
    '4. [interactive] verify the dashboard',
    '5. logout',
  ].join('\n');
  const got = classifySelectedSteps(text, []);
  assert.equal(got.length, 5);
  assert.equal(got[0].kind, 'step');
  assert.equal(got[1].kind, 'input');
  assert.equal(got[2].kind, 'step');
  assert.equal(got[3].kind, 'interactive');
  assert.equal(got[4].kind, 'step');
});

// ---------------------------------------------------------------------------
// resolveRunLines — translates a user line selection into the actual step
// lines to run. Falls back to "all steps at or below first selected line"
// when the selection itself contains no step lines (e.g. user clicked the
// "## Steps" heading or a blank line).
// ---------------------------------------------------------------------------

const SAMPLE = [
  '# Title',          // 1
  '## Steps',         // 2
  '1. step a',        // 3
  '2. step b',        // 4
  '',                 // 5
  '3. step c',        // 6
].join('\n');

test('resolveRunLines: empty selection returns every step line', () => {
  assert.deepEqual(resolveRunLines(SAMPLE, []), [3, 4, 6]);
});

test('resolveRunLines: selection that is already a step line passes through', () => {
  assert.deepEqual(resolveRunLines(SAMPLE, [4]), [4]);
});

test('resolveRunLines: keeps step lines, drops non-step lines from a mixed selection', () => {
  // User selected the heading + first two steps; only the steps survive.
  assert.deepEqual(resolveRunLines(SAMPLE, [2, 3, 4]), [3, 4]);
});

test('resolveRunLines: heading-only selection falls back to all steps at or below', () => {
  // Cursor on "## Steps" (line 2) — selection has no step lines, so we run
  // every step at or below line 2: lines 3, 4, 6.
  assert.deepEqual(resolveRunLines(SAMPLE, [2]), [3, 4, 6]);
});

test('resolveRunLines: blank-line-only selection falls back to next step downward', () => {
  // Cursor on the blank line 5 — fallback returns step lines >= 5: just line 6.
  assert.deepEqual(resolveRunLines(SAMPLE, [5]), [6]);
});

test('resolveRunLines: selection past the last step returns empty (nothing to run)', () => {
  const text = SAMPLE + '\n7. trailing prose without numbered list under Steps';
  // Last line is 7 but the "## Steps" section ends at line 6 in this layout
  // (no further headings, so the section runs to EOF — but the trailing
  // line is still a step at line 7). Pick a line guaranteed past EOF:
  assert.deepEqual(resolveRunLines(SAMPLE, [99]), []);
});

test('resolveRunLines: mixed selection with one valid step keeps just that step', () => {
  // Lines 1, 5, 6 — only 6 is a step.
  assert.deepEqual(resolveRunLines(SAMPLE, [1, 5, 6]), [6]);
});

test('resolveRunLines: selection above Steps falls back to all steps', () => {
  // Cursor on line 1 (# Title). No step lines selected → fall back to steps
  // at or below line 1, which means every step.
  assert.deepEqual(resolveRunLines(SAMPLE, [1]), [3, 4, 6]);
});

test('classifySelectedSteps: ignores [input:]-shaped text outside Steps section', () => {
  const text = [
    '# Notes',
    '1. [input: foo] not a step',
    '## Steps',
    '1. real step',
  ].join('\n');
  const got = classifySelectedSteps(text, []);
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'step');
  assert.equal(got[0].instruction, 'real step');
});

// ---------------------------------------------------------------------------
// A dangling chain member — the batch splitter's refusal
// ---------------------------------------------------------------------------
/**
 * A dangling `Else if` / `Otherwise` — one whose previous step line in the
 * same flow is not a chain member — refused with the CLI parser's own wording
 * (stories/control-flow.md §"Runs that start or end mid-structure").
 *
 * The case that motivates the client-side check is an `[input: …]` between two
 * members: that step ends a batch, so the halves of ONE decision land in
 * different requests and the second arrives with no memory of the `If` it is
 * the alternative of. The rule is stated on the CHAIN rather than on the
 * `[input:]` because an `[input:]` line IS a numbered step — it breaks the
 * chain before it can sit inside one — so a check phrased the other way blames
 * a line the CLI parser never blames, and the two tools disagree about the
 * same file.
 */

const inputChain = (middle) =>
  [
    '# T',
    '',
    '## Steps',
    '',
    '1. If the Cash checkbox is ticked, then Pay with cash',
    `2. ${middle}`,
    '3. Otherwise, Pay by card',
  ].join('\n');

test('danglingChainMemberError: an [input:] between chain members leaves the Otherwise dangling', () => {
  const problem = danglingChainMemberError(inputChain('[input: pin] Enter your PIN'));
  assert.match(problem ?? '', /^Line 7 — /);
  assert.match(problem ?? '', /"Otherwise, Pay by card" has no decision to be the alternative of/);
  assert.match(problem ?? '', /must follow an `If … then …` or another `Else if`/);
  assert.match(problem ?? '', /\(## Steps\)/);
});

test('danglingChainMemberError: [interactive] does it too', () => {
  assert.match(
    danglingChainMemberError(inputChain('[interactive]')) ?? '',
    /has no decision to be the alternative of/,
  );
});

test('danglingChainMemberError: an ORDINARY step between them is the same fault', () => {
  // The rule is about the chain, not about the prompt: any numbered step
  // between two members breaks the chain, and the CLI parser refuses the file
  // with this same sentence.
  assert.match(
    danglingChainMemberError(inputChain('Click Save')) ?? '',
    /"Otherwise, Pay by card" has no decision to be the alternative of/,
  );
});

test('danglingChainMemberError: a well-formed chain is accepted', () => {
  const text = [
    '# T',
    '',
    '## Steps',
    '',
    '1. If a, then X',
    '2. Else if b, then Y',
    '3. Otherwise, Z',
    '4. Click Save',
  ].join('\n');
  assert.equal(danglingChainMemberError(text), null);
});

test('danglingChainMemberError: an [input:] outside a chain is fine', () => {
  const text = [
    '# T',
    '',
    '## Steps',
    '',
    '1. [input: pin] Enter your PIN',
    '2. If a, then X',
    '3. Otherwise, Y',
    '4. [input: code] Enter the code',
  ].join('\n');
  assert.equal(danglingChainMemberError(text), null);
});

test('danglingChainMemberError: inside a tail`s section body an [input:] is allowed', () => {
  const text = [
    '# T',
    '',
    '## Steps',
    '',
    '1. If a, then Pay by card',
    '2. Otherwise, Pay with cash',
    '',
    '### Pay by card',
    '',
    '1. Enter the card number',
    '2. [input: cvv] Enter the CVV',
    '3. Click Pay now',
    '',
    '### Pay with cash',
    '',
    '1. Click Pay now',
  ].join('\n');
  assert.equal(danglingChainMemberError(text), null);
});

test('danglingChainMemberError: a chain inside a section body is checked too', () => {
  const text = [
    '# T',
    '',
    '## Steps',
    '',
    '1. Pay',
    '',
    '### Pay',
    '',
    '1. If a, then X',
    '2. [input: pin] Enter your PIN',
    '3. Else if b, then Y',
  ].join('\n');
  const problem = danglingChainMemberError(text);
  assert.match(problem ?? '', /"Else if b, then Y" has no decision/);
  // …and it names the body it is in, not `## Steps`.
  assert.match(problem ?? '', /\(### Pay\)/);
});

test('danglingChainMemberError: a chain does not run across a section boundary', () => {
  const text = [
    '# T',
    '',
    '## Steps',
    '',
    '1. If a, then X',
    '',
    '### Helper',
    '',
    '1. Otherwise, Y',
  ].join('\n');
  assert.match(danglingChainMemberError(text) ?? '', /\(### Helper\)/);
});

test('danglingChainMemberError: a step naming a section is a CALL, not a chain member', () => {
  // Resolution order (decision 3): a section unwisely named `Otherwise, …` is
  // called by a step spelling it out, and a call is not a dangling member.
  const text = [
    '# T',
    '',
    '## Steps',
    '',
    '1. Otherwise, Pay by card',
    '',
    '### Otherwise, Pay by card',
    '',
    '1. Click B',
  ].join('\n');
  assert.equal(danglingChainMemberError(text), null);
});

test('danglingChainMemberError: a document with no control flow is never refused', () => {
  const text = ['# T', '', '## Steps', '', '1. Click A', '2. [input: pin] PIN', '3. Click B'].join(
    '\n',
  );
  assert.equal(danglingChainMemberError(text), null);
});

test('danglingChainMemberError: an `Else if` BELOW the `Otherwise` is refused', () => {
  // The other half of the rule. `Otherwise` ends a chain, so a member under
  // one is never the branch the decision picks — at run time the planner takes
  // the FIRST condition-less member, so a second `Otherwise` is unreachable
  // and an `Else if` below one is still evaluated. Refused by the CLI parser
  // since stage 1; refused here so a file TestBench runs is a file the CLI
  // runs.
  const text = [
    '# T',
    '',
    '## Steps',
    '',
    '1. If a, then Sec1',
    '2. Otherwise, Sec2',
    '3. Else if b, then Sec3',
  ].join('\n');
  const problem = danglingChainMemberError(text);
  assert.match(problem ?? '', /^Line 7 — "Else if b, then Sec3" follows an `Otherwise`/);
  assert.match(problem ?? '', /at most one `Else` \/ `Otherwise`, and it comes last/);
});

test('danglingChainMemberError: a SECOND `Otherwise` is refused the same way', () => {
  const text = [
    '# T',
    '',
    '## Steps',
    '',
    '1. If a, then Sec1',
    '2. Otherwise, Sec2',
    '3. Otherwise, Sec3',
  ].join('\n');
  assert.match(
    danglingChainMemberError(text) ?? '',
    /"Otherwise, Sec3" follows an `Otherwise`, which ends a chain/,
  );
});

test('danglingChainMemberError: a NEW `If` after an `Otherwise` opens a fresh chain', () => {
  // The control for the two above: closing one chain must not poison the next.
  const text = [
    '# T',
    '',
    '## Steps',
    '',
    '1. If a, then Sec1',
    '2. Otherwise, Sec2',
    '3. If b, then Sec3',
    '4. Otherwise, Sec4',
  ].join('\n');
  assert.equal(danglingChainMemberError(text), null);
});

test('danglingChainMemberError: an ordinary step between them reopens nothing', () => {
  // A closed chain followed by a plain step and then an `Otherwise` is the
  // DANGLING fault, not the closed one — the previous step line is not a chain
  // member at all, so the author reads the sentence that names that.
  const text = [
    '# T',
    '',
    '## Steps',
    '',
    '1. If a, then Sec1',
    '2. Otherwise, Sec2',
    '3. Click Save',
    '4. Otherwise, Sec3',
  ].join('\n');
  assert.match(
    danglingChainMemberError(text) ?? '',
    /"Otherwise, Sec3" has no decision to be the alternative of/,
  );
});

/**
 * Which numbered lines are steps — Markdown's rule (steptix/steptix#49).
 *
 * Every expectation here was measured against `marked`, the parser the CLI
 * takes its steps from, by running the CLI's `parseTestContent` on the same
 * `## Steps` body. The root suite repeats the measurement live
 * (tests/step-line-span-parity.test.ts), so a `marked` upgrade that changes
 * an answer fails there rather than leaving these rows quietly wrong.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  classifyLines,
  createStepLineReader,
  extractStepLineIds,
  extractSteps,
  findStepsHeadingLine,
  stepOrdinal,
} from '../dist/step-lines.js';

/** 1-based lines of `body` (lines under a `## Steps` on line 1) read as steps. */
function stepLinesOf(body) {
  return extractSteps(['## Steps', ...body].join('\n')).map((s) => s.line);
}

const CASES = [
  // [name, body lines, expected step lines (1-based, the heading is line 1)]
  ['the issue: two spaces in, then the margin', ['  1. A', '  2. B', '3. C', '4. D'], [2, 3, 4, 5]],
  ['one space in', [' 1. A', ' 2. B'], [2, 3]],
  ['three spaces in, at the start', ['   1. A', '   2. B', '3. C'], [2, 3, 4]],
  ['three spaces under `1. ` is nested', ['1. A', '   1. a1', '   2. a2', '2. B'], [2, 5]],
  ['two spaces under `1. ` is a sibling', ['1. A', '  1. a1', '  2. a2', '2. B'], [2, 3, 4, 5]],
  ['three spaces under `10. ` is a sibling', ['10. A', '   11. B', '12. C'], [2, 3, 4]],
  ['three spaces under `1.  ` (two spaces after the dot) is a sibling', ['1.  A', '   2. B', '3. C'], [2, 3, 4]],
  ['deeper item, then back out', ['  1. A', '     1. sub', '  2. B'], [2, 4]],
  ['nested after a blank line', ['1. A', '', '   2. B', '3. C'], [2, 5]],
  ['a tab at the top level is indented code', ['\t1. A', '\t2. B'], []],
  ['a tab under an item is nested', ['1. A', '\t2. B', '3. C'], [2, 4]],
  ['four spaces at the top level is indented code', ['    1. A', '    2. B'], []],
  ['prose after a blank closes the list', ['1. A', '', 'Prose here.', '', '   1. B', '   2. C'], [2, 6, 7]],
  ['prose directly below continues the item', ['1. A', 'lazy', '  2. B'], [2, 4]],
  ['prose before an indented list', ['Intro', '  1. A', '  2. B'], [3, 4]],
  ['a bullet opens an item the next line can nest in', ['- X', '  1. A', '  2. B'], []],
  ['a thematic break closes the list', ['1. A', '', '***', '   1. B'], [2, 5]],
  // A fence cannot be a lazy continuation, so it ends the item even with no
  // blank line above it (code review of #49).
  ['a fence directly under a step closes the list', ['1. A', '```', 'x', '```', '   2. B'], [2, 6]],
  ['a fence inside an item keeps it open', ['1. A', '   ```', '   x', '   ```', '   2. B', '2. C'], [2, 7]],
  // Inside a fence a numbered line keeps the old answer: column 0 only. The
  // column-0 case is the known divergence the CLI's sectioned check refuses.
  ['numbered lines inside a fence', ['```', '1. col0', '  2. indented', '```'], [3]],
];

for (const [name, body, expected] of CASES) {
  test(`step lines: ${name}`, () => {
    assert.deepEqual(stepLinesOf(body), expected);
  });
}

test('a column-0 numbered line is a step whatever came before it', () => {
  // The legacy rule's whole answer, kept: Markdown's rule only ever ADDS
  // indented items, so a file with no indented numbered lines classifies
  // exactly as it did.
  const body = ['1. A', '   1. nested', '     - deeper', '\t\tcode-ish', '2. B', '- bullet', '3. C'];
  assert.deepEqual(stepLinesOf(body), [2, 6, 8]);
});

test('a section body follows the same rule, and its heading closes the list', () => {
  const text = ['## Steps', '1. Call', '   1. nested', '', '### Call', '   1. Body', '   2. Body too'].join('\n');
  const kinds = classifyLines(text).map((l) => l.kind);
  assert.deepEqual(kinds, ['heading', 'step', 'prose', 'blank', 'section-heading', 'section-step', 'section-step']);
});

test('the reader needs every line in order: it is the line above that decides', () => {
  const read = createStepLineReader();
  assert.deepEqual(
    ['1. A', '   1. nested', '', 'Prose.', '', '   1. top-level'].map((line) => read(line)),
    [true, false, false, false, false, true],
  );
});

test('an indented step strips to the same instruction as one at the margin', () => {
  assert.deepEqual(extractSteps(['## Steps', '  1. Click Save', '2. Click Save'].join('\n')), [
    { line: 2, instruction: 'Click Save' },
    { line: 3, instruction: 'Click Save' },
  ]);
});

test('extractStepLineIds: main flow and bodies, indented or not, never inert or nested', () => {
  const text = [
    '## Steps', //           1
    '  1. Call', //          2
    '     1. nested', //     3
    '', //                   4
    '### Call', //           5
    '  1. Body', //          6
    '', //                   7
    '#### Notes', //         8
    '  1. inert', //         9
  ].join('\n');
  assert.deepEqual(extractStepLineIds(text), [2, 6]);
});

test('extractStepLineIds: frontmatter is skipped', () => {
  const text = ['---', '## Steps', '---', '', '## Steps', '1. One'].join('\n');
  assert.deepEqual(extractStepLineIds(text), [6]);
});

test('findStepsHeadingLine: the heading of the span the steps come from', () => {
  assert.equal(findStepsHeadingLine(['# T', '', '## Steps', '1. A'].join('\n')), 3);
  // A `## Steps` line inside frontmatter is YAML, not the heading.
  assert.equal(findStepsHeadingLine(['---', '## Steps', '---', '', '## Steps', '1. A'].join('\n')), 5);
  assert.equal(findStepsHeadingLine(['# T', 'No steps here.'].join('\n')), null);
});

test('stepOrdinal: where the digits are, indented or not', () => {
  assert.deepEqual(stepOrdinal('1. A'), { start: 0, length: 1, value: '1' });
  assert.deepEqual(stepOrdinal('   12. A'), { start: 3, length: 2, value: '12' });
  assert.deepEqual(stepOrdinal('007. A'), { start: 0, length: 3, value: '007' });
  assert.equal(stepOrdinal('    1. code'), null);
  assert.equal(stepOrdinal('\t1. tab'), null);
  assert.equal(stepOrdinal('- bullet'), null);
  assert.equal(stepOrdinal('1) paren'), null);
});

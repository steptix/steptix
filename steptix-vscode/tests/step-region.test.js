/**
 * `inStepRegion` / `isInsideFence` — where completion may offer section names.
 *
 * These were extracted from the completion provider (which imports `vscode`)
 * so their edge cases are testable under `node --test`. The interesting ones
 * are all about fences, because `classifyLines` does not track them: a
 * numbered line inside a fence within the Steps span classifies as a step and
 * would otherwise look like a live completion position.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { inStepRegion, isInsideFence } from '../src/extension/step-region-core.ts';

const doc = (...lines) => lines.join('\n');
/** 0-based index of the first line equal to `needle`. */
const lineOf = (text, needle) => text.split('\n').indexOf(needle);

// ---------------------------------------------------------------------------
// The live positions completion must offer
// ---------------------------------------------------------------------------

test('a step being typed (no content yet) is a live position', () => {
  // `4. ` reads as prose mid-keystroke, so the region is inferred from the
  // step above it, not from its own kind.
  const text = doc('## Steps', '1. One', '2. Two', '3. Three', '4. ');
  assert.equal(inStepRegion(text, 4), true);
});

test('the first step right after ## Steps is live, blank line between or not', () => {
  assert.equal(inStepRegion(doc('## Steps', '1. '), 1), true);
  assert.equal(inStepRegion(doc('## Steps', '', '1. '), 2), true);
});

test('a section BODY step is live — sections can call sibling sections', () => {
  const text = doc('## Steps', '1. Login', '', '### Login', '1. Type', '2. ');
  assert.equal(inStepRegion(text, 5), true);
});

test('a step right after a ### heading with no blank is live', () => {
  const text = doc('## Steps', '1. Login', '', '### Login', '1. ');
  assert.equal(inStepRegion(text, 4), true);
});

// ---------------------------------------------------------------------------
// The dead positions it must NOT offer
// ---------------------------------------------------------------------------

test('a numbered line under ## Parameters is not a step region', () => {
  const text = doc('## Parameters', '1. ', '', '## Steps', '1. Real');
  assert.equal(inStepRegion(text, 1), false);
});

test('before any ## Steps heading is not a step region', () => {
  assert.equal(inStepRegion(doc('# Title', '1. '), 1), false);
  assert.equal(inStepRegion(doc('1. '), 0), false);
});

// ---------------------------------------------------------------------------
// Fences — the whole reason this is separate
// ---------------------------------------------------------------------------

test('every line of a multi-line fence is excluded, not just the first', () => {
  const text = doc(
    '## Steps', '1. Login', '',
    '```text', '1. first fence line', '2. second fence line', '3. third', '```',
  );
  assert.equal(inStepRegion(text, lineOf(text, '1. first fence line')), false);
  assert.equal(inStepRegion(text, lineOf(text, '2. second fence line')), false);
  assert.equal(inStepRegion(text, lineOf(text, '3. third')), false);
});

test('a fence inside a section body is excluded too', () => {
  const text = doc(
    '## Steps', '1. Login', '',
    '### Login', '1. Type', '',
    '```', '1. example', '2. more', '```',
  );
  assert.equal(inStepRegion(text, lineOf(text, '2. more')), false);
});

test('a real step AFTER a closed fence is live again', () => {
  const text = doc(
    '## Steps', '1. Login', '',
    '```', 'x', '```', '',
    '2. ',
  );
  assert.equal(inStepRegion(text, lineOf(text, '2. ')), true);
});

test('~~~ fences are recognised', () => {
  const text = doc('## Steps', '1. Login', '', '~~~', '1. inside', '~~~');
  assert.equal(inStepRegion(text, lineOf(text, '1. inside')), false);
});

test('isInsideFence toggles on each delimiter', () => {
  const text = doc('a', '```', 'b', '```', 'c');
  assert.equal(isInsideFence(text, 0), false); // before
  assert.equal(isInsideFence(text, 2), true); // between
  assert.equal(isInsideFence(text, 4), false); // after close
});

test('an unclosed fence marks the rest of the file inside (documented naive behaviour)', () => {
  const text = doc('## Steps', '1. Login', '', '```', '1. never closed');
  assert.equal(isInsideFence(text, lineOf(text, '1. never closed')), true);
  assert.equal(inStepRegion(text, lineOf(text, '1. never closed')), false);
});

test('frontmatter --- does not toggle a fence', () => {
  const text = doc('---', 'type: test', '---', '', '## Steps', '1. ');
  assert.equal(isInsideFence(text, 5), false);
  assert.equal(inStepRegion(text, 5), true);
});

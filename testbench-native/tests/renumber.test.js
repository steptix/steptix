/**
 * `computeRenumberEdits` / `renumberText` — the Renumber Steps numbering walk.
 *
 * The command itself needs a VS Code host; the numbering DECISION is pure and
 * lives here, so every row of stories/specs/step-renumbering.md §5 and every
 * case in §6 is covered under `node --test`.
 *
 * Most cases read as before/after documents via `renumberText`, because that
 * is how the spec states them. `computeRenumberEdits` is asserted directly
 * wherever the edit SHAPE carries the contract: the digit run's length (a
 * shortening or lengthening rewrite), and the zero-edit result the command
 * turns into "already numbered" without calling the editor at all.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { computeRenumberEdits, renumberText } from '../src/extension/renumber-core.ts';

const doc = (...lines) => lines.join('\n');
/** 1-based line number of the first line equal to `needle`. */
const lineOf = (text, needle) => text.split('\n').indexOf(needle) + 1;

// ---------------------------------------------------------------------------
// Renumber-all — the spec's worked example
// ---------------------------------------------------------------------------

test('renumber-all fixes the main flow and restarts each section body at 1', () => {
  const before = doc(
    '## Steps',
    '1. Open the site',
    '2. Login',
    "2. Check the dashboard shows today's date",
    '3. Sign out',
    '',
    '### Login',
    '1. Go to the login page',
    '1. Type "{{username}}"',
    '2. Click Sign in',
  );
  const after = doc(
    '## Steps',
    '1. Open the site',
    '2. Login',
    "3. Check the dashboard shows today's date",
    '4. Sign out',
    '',
    '### Login',
    '1. Go to the login page',
    '2. Type "{{username}}"',
    '3. Click Sign in',
  );
  assert.equal(renumberText(before, []), after);
});

test('a second run makes no edit at all — the command is idempotent', () => {
  const once = renumberText(
    doc('## Steps', '1. One', '2. Two', '2. Three'),
    [],
  );
  assert.deepEqual(computeRenumberEdits(once, []), []);
});

test('every character after the digit run survives, spacing included', () => {
  const before = doc('## Steps', '5.    Open   the   site  ');
  assert.equal(renumberText(before, []), doc('## Steps', '1.    Open   the   site  '));
});

test('two sections each restart at 1, independently of the main flow', () => {
  const before = doc(
    '## Steps',
    '3. Login',
    '9. Do checkout',
    '',
    '### Login',
    '4. Type the username',
    '4. Press submit',
    '',
    '### Do checkout',
    '7. Click pay',
  );
  const after = doc(
    '## Steps',
    '1. Login',
    '2. Do checkout',
    '',
    '### Login',
    '1. Type the username',
    '2. Press submit',
    '',
    '### Do checkout',
    '1. Click pay',
  );
  assert.equal(renumberText(before, []), after);
});

test('a hashes-only ### restarts the body too', () => {
  // `###` with no name is a section-heading (contract §5 rule 3). The file
  // would be refused at run time; renumbering does not care, and must not
  // silently number its body onto the end of the main flow.
  const before = doc('## Steps', '1. One', '5. Two', '', '###', '7. body one', '9. body two');
  const after = doc('## Steps', '1. One', '2. Two', '', '###', '1. body one', '2. body two');
  assert.equal(renumberText(before, []), after);
});

// ---------------------------------------------------------------------------
// Numbered items that are not steps
// ---------------------------------------------------------------------------

test('inert items under a #### heading keep their ordinals', () => {
  const before = doc(
    '## Steps',
    '1. Open the site',
    '5. Sign out',
    '',
    '#### Notes',
    '3. not a step',
    '7. also not a step',
  );
  const after = doc(
    '## Steps',
    '1. Open the site',
    '2. Sign out',
    '',
    '#### Notes',
    '3. not a step',
    '7. also not a step',
  );
  assert.equal(renumberText(before, []), after);
});

test('an inert item contributes nothing to the counter', () => {
  // The grammar puts a `section-heading` between every inert region and the
  // next renumberable line — a `####` region is closed by nothing else — so
  // this cannot be shown by a step BELOW an inert one. It is shown instead by
  // deleting the inert items: the ordinals the surviving steps get must not
  // move.
  const withInert = doc(
    '## Steps',
    '4. Open the site',
    '',
    '#### Notes',
    '1. not a step',
    '2. not a step either',
    '',
    '### Login',
    '6. Type the username',
    '8. Press submit',
  );
  const withoutInert = doc(
    '## Steps',
    '4. Open the site',
    '',
    '#### Notes',
    '',
    '### Login',
    '6. Type the username',
    '8. Press submit',
  );
  const ordinals = (text) => computeRenumberEdits(text, []).map((e) => e.ordinal);
  assert.deepEqual(ordinals(withInert), [1, 1, 2]);
  assert.deepEqual(ordinals(withInert), ordinals(withoutInert));
});

test('an inert-only selection renumbers the document — nothing selected was a step', () => {
  const before = doc('## Steps', '1. Open the site', '5. Sign out', '', '#### Notes', '3. inert');
  const after = doc('## Steps', '1. Open the site', '2. Sign out', '', '#### Notes', '3. inert');
  assert.equal(renumberText(before, [lineOf(before, '3. inert')]), after);
});

test('an indented numbered item is prose and stays put', () => {
  const before = doc('## Steps', '1. Open the site', '   1. a nested item', '5. Sign out');
  const after = doc('## Steps', '1. Open the site', '   1. a nested item', '2. Sign out');
  assert.equal(renumberText(before, []), after);
});

test('a numbered list outside the ## Steps span is prose and stays put', () => {
  const before = doc(
    '## Steps',
    '1. Open the site',
    '3. Sign out',
    '',
    '## Notes',
    '1. first note',
    '1. second note',
  );
  const after = doc(
    '## Steps',
    '1. Open the site',
    '2. Sign out',
    '',
    '## Notes',
    '1. first note',
    '1. second note',
  );
  assert.equal(renumberText(before, []), after);
});

test("a wrapped step's continuation lines are untouched", () => {
  // Only the first physical line carries an ordinal; the rest classify as
  // prose, so wrapping needs no special handling here.
  const before = doc(
    '## Steps',
    '1. Type the username',
    '   into the tenant field, then press Enter',
    '4. Press submit',
    'and wait for the dashboard',
    '9. Sign out',
  );
  const after = doc(
    '## Steps',
    '1. Type the username',
    '   into the tenant field, then press Enter',
    '2. Press submit',
    'and wait for the dashboard',
    '3. Sign out',
  );
  assert.equal(renumberText(before, []), after);
});

// ---------------------------------------------------------------------------
// Fenced code blocks — literal text wearing a step's shape
// ---------------------------------------------------------------------------

test('fenced numbered lines are untouched and feed nothing to the counter', () => {
  // classifyLines calls the fenced `1.`/`9.` steps (its documented fence
  // blindness); the walk must not — they are example text, and letting them
  // advance the counter would shift the real steps below the fence.
  const before = doc(
    '## Steps',
    '1. real one',
    '```',
    '1. fenced item',
    '9. fenced item',
    '```',
    '5. real two',
  );
  const after = doc(
    '## Steps',
    '1. real one',
    '```',
    '1. fenced item',
    '9. fenced item',
    '```',
    '2. real two',
  );
  assert.equal(renumberText(before, []), after);
});

test('a fenced ### does not restart the numbering', () => {
  const before = doc('## Steps', '1. a', '```', '### Fenced', '```', '5. b');
  const after = doc('## Steps', '1. a', '```', '### Fenced', '```', '2. b');
  assert.equal(renumberText(before, []), after);
});

test('a document whose numbered lines are ALL fenced yields zero edits', () => {
  // The shape of a spec/docs file: a fenced worked example containing its own
  // `## Steps` and deliberately wrong ordinals. Renumber must leave it be.
  const text = doc(
    '# Some spec',
    '',
    '```markdown',
    '## Steps',
    '1. Open the site',
    '2. Login',
    '2. Check the dashboard',
    '```',
  );
  assert.deepEqual(computeRenumberEdits(text, []), []);
});

test('a selection covering only fenced lines falls back to renumber-all', () => {
  const before = doc('## Steps', '1. real', '5. real two', '```', '7. fenced', '```');
  const after = doc('## Steps', '1. real', '2. real two', '```', '7. fenced', '```');
  assert.equal(renumberText(before, [lineOf(before, '7. fenced')]), after);
});

// ---------------------------------------------------------------------------
// Selection mode
// ---------------------------------------------------------------------------

test('a tail selection continues from the step above it', () => {
  const before = doc('## Steps', '1. A', '2. B', '3. C', '1. D', '2. E');
  const after = doc('## Steps', '1. A', '2. B', '3. C', '4. D', '5. E');
  assert.equal(renumberText(before, [5, 6]), after);
});

test('selecting the last two steps of the worked example leaves the body alone', () => {
  const before = doc(
    '## Steps',
    '1. Open the site',
    '2. Login',
    "2. Check the dashboard shows today's date",
    '3. Sign out',
    '',
    '### Login',
    '1. Go to the login page',
    '1. Type "{{username}}"',
    '2. Click Sign in',
  );
  const after = doc(
    '## Steps',
    '1. Open the site',
    '2. Login',
    "3. Check the dashboard shows today's date",
    '4. Sign out',
    '',
    '### Login',
    '1. Go to the login page',
    '1. Type "{{username}}"',
    '2. Click Sign in',
  );
  assert.equal(renumberText(before, [4, 5]), after);
});

test('a selection at the start of a scope gets 1', () => {
  const before = doc('## Steps', '4. A', '9. B');
  assert.equal(renumberText(before, [2]), doc('## Steps', '1. A', '9. B'));
});

test('the first step of a BODY gets 1 even with the main flow unselected', () => {
  const before = doc('## Steps', '1. Open', '2. Login', '', '### Login', '5. Go', '6. Type');
  const after = doc('## Steps', '1. Open', '2. Login', '', '### Login', '1. Go', '6. Type');
  assert.equal(renumberText(before, [6]), after);
});

test('a selection spanning the main flow and a body renumbers each in its own scope', () => {
  const before = doc('## Steps', '1. Open', '5. Login', '', '### Login', '3. Go', '7. Type');
  const after = doc('## Steps', '1. Open', '2. Login', '', '### Login', '1. Go', '2. Type');
  assert.equal(renumberText(before, [3, 6, 7]), after);
});

test('a partial selection may leave the file non-sequential — unselected steps never move', () => {
  const before = doc('## Steps', '1. A', '2. B', '2. C', '3. D');
  // Renumbering the duplicate `2.` alone makes it 3, colliding with the
  // unselected `3.` below. That is the contract; renumber-all is the cleanup.
  const after = doc('## Steps', '1. A', '2. B', '3. C', '3. D');
  assert.equal(renumberText(before, [4]), after);
});

test('a selection of prose, headings and blanks falls back to renumber-all', () => {
  const before = doc('## Steps', '1. One', '3. Two', '', 'some prose');
  const after = doc('## Steps', '1. One', '2. Two', '', 'some prose');
  assert.equal(renumberText(before, [1, 4, 5]), after);
});

test('the step lines in a mixed selection are the targets; the prose contributes nothing', () => {
  const before = doc('## Steps', '1. A', '2. B', '', '9. C');
  const after = doc('## Steps', '1. A', '2. B', '', '3. C');
  assert.equal(renumberText(before, [4, 5]), after);
});

test('disjoint selections are honoured as a set, not as a range', () => {
  // What multi-cursor produces: `selectionLines` unions every range, and the
  // lines between two of them must stay unselected.
  const before = doc('## Steps', '9. A', '9. B', '9. C');
  const after = doc('## Steps', '1. A', '9. B', '10. C');
  assert.equal(renumberText(before, [2, 4]), after);
});

// ---------------------------------------------------------------------------
// Ordinal shapes
// ---------------------------------------------------------------------------

test('a multi-digit ordinal shortens, and the edit reports the digits it replaces', () => {
  const before = doc('## Steps', '12. a', '12. b', '12. c');
  assert.deepEqual(computeRenumberEdits(before, []), [
    { line: 2, digits: 2, ordinal: 1 },
    { line: 3, digits: 2, ordinal: 2 },
    { line: 4, digits: 2, ordinal: 3 },
  ]);
  assert.equal(renumberText(before, []), doc('## Steps', '1. a', '2. b', '3. c'));
});

test('an ordinal lengthens past 9 without disturbing the rest of the line', () => {
  const before = doc(
    '## Steps',
    '1. a', '2. b', '3. c', '4. d', '5. e', '6. f', '7. g', '8. h', '9. i',
    '9. j',
  );
  assert.deepEqual(computeRenumberEdits(before, []), [{ line: 11, digits: 1, ordinal: 10 }]);
  assert.equal(renumberText(before, []).split('\n')[10], '10. j');
});

test('a leading-zero ordinal is replaced wholesale with the decimal ordinal', () => {
  const before = doc('## Steps', '007. a', '02. b');
  assert.deepEqual(computeRenumberEdits(before, []), [
    { line: 2, digits: 3, ordinal: 1 },
    { line: 3, digits: 2, ordinal: 2 },
  ]);
  assert.equal(renumberText(before, []), doc('## Steps', '1. a', '2. b'));
});

test('an unselected leading-zero ordinal feeds the counter as a decimal number', () => {
  const before = doc('## Steps', '007. a', '1. b');
  assert.equal(renumberText(before, [3]), doc('## Steps', '007. a', '8. b'));
});

test('an unselected ordinal beyond safe-integer range does not seed the counter', () => {
  // Number("1000000000000000000000") is 1e21; +1 later would String() to
  // "1e+21", turning the target below into a non-step. The huge line keeps
  // its text and the counter keeps the last exact value instead.
  const before = doc('## Steps', '1. a', '1000000000000000000000. big', '1. c');
  const after = doc('## Steps', '1. a', '1000000000000000000000. big', '2. c');
  assert.equal(renumberText(before, [lineOf(before, '1. c')]), after);
});

// ---------------------------------------------------------------------------
// Nothing to do
// ---------------------------------------------------------------------------

test('correct numbering yields no edits, selection or not', () => {
  const text = doc('## Steps', '1. One', '2. Two', '', '### Login', '1. Go', '2. Type');
  assert.deepEqual(computeRenumberEdits(text, []), []);
  assert.deepEqual(computeRenumberEdits(text, [2, 3]), []);
  assert.equal(renumberText(text, []), text);
});

test('a ## Steps heading with no steps under it yields no edits', () => {
  const text = doc('# Title', '## Steps', '', 'Nothing here yet.');
  assert.deepEqual(computeRenumberEdits(text, []), []);
});

test('a file with no ## Steps heading yields no edits', () => {
  const text = doc('# Notes', '1. buy milk', '2. buy bread');
  assert.deepEqual(computeRenumberEdits(text, []), []);
});

// ---------------------------------------------------------------------------
// Line endings and frontmatter
// ---------------------------------------------------------------------------

test('CRLF line endings survive, and the edits address the same lines', () => {
  const before = ['## Steps', '1. One', '5. Two', '', '### Login', '3. Go'].join('\r\n');
  assert.deepEqual(computeRenumberEdits(before, []), [
    { line: 3, digits: 1, ordinal: 2 },
    { line: 6, digits: 1, ordinal: 1 },
  ]);
  const after = ['## Steps', '1. One', '2. Two', '', '### Login', '1. Go'].join('\r\n');
  assert.equal(renumberText(before, []), after);
});

test('frontmatter is skipped, and its lines do not shift the numbering', () => {
  const before = doc('---', 'type: test', '---', '', '## Steps', '4. One', '4. Two');
  const after = doc('---', 'type: test', '---', '', '## Steps', '1. One', '2. Two');
  assert.equal(renumberText(before, []), after);
});

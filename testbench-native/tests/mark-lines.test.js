import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  shiftMarkLine,
  markLineMoves,
  moveLineKeyed,
} from '../src/extension/mark-lines-core.ts';

/**
 * Run marks follow their line's text (mark-lines-core.ts). Each case is the
 * change VS Code actually reports for an editor action, 0-based, against the
 * text BEFORE the edit. Marks are 1-based, as the tracker stores them.
 *
 * The document shape is the integration fixture's: steps on 1-based lines
 * 8, 9, 10 (0-based 7, 8, 9), so a mark on 9 is step 2.
 */

const MARKS = [8, 9, 10];
const LEN = 20; // any non-zero line length

/** Where every mark in MARKS goes: 1-based line, or null when removed. */
function after(changes) {
  const moves = markLineMoves(MARKS, changes) ?? new Map();
  return MARKS.map((l) => (moves.has(l) ? moves.get(l) : l));
}

const change = (startLine, startCharacter, endLine, endCharacter, addedLines) => ({
  startLine,
  startCharacter,
  endLine,
  endCharacter,
  addedLines,
});

// ---- adding lines -------------------------------------------------------------

test('Enter at the end of a step moves only the steps below it', () => {
  // Cursor at the end of step 1 (0-based 7), Enter: an insertion of "\n" there.
  assert.deepEqual(after([change(7, LEN, 7, LEN, 1)]), [8, 10, 11]);
});

test('Enter at column 0 of a step pushes that step (and its mark) down', () => {
  // The step's text moves to the next line, so its ✓ goes with it rather than
  // staying on the blank line Enter left behind.
  assert.deepEqual(after([change(8, 0, 8, 0, 1)]), [8, 10, 11]);
});

test('a line inserted above every step moves every mark', () => {
  assert.deepEqual(after([change(2, 0, 2, 0, 1)]), [9, 10, 11]);
});

test('pasting several lines above a step moves it by all of them', () => {
  assert.deepEqual(after([change(8, 0, 8, 0, 3)]), [8, 12, 13]);
});

test('lines added below every step move nothing', () => {
  assert.equal(markLineMoves(MARKS, [change(12, 0, 12, 0, 4)]), null);
});

// ---- deleting lines -----------------------------------------------------------

test('Ctrl+Shift+K on a step removes its mark and moves the ones below up', () => {
  // A whole-line delete: (8,0) to (9,0), nothing inserted.
  assert.deepEqual(after([change(8, 0, 9, 0, 0)]), [8, null, 9]);
});

test('a deleted step does NOT hand its mark to the step that slides up', () => {
  // The resume arrow snaps forward on this edit; a result must not. What slid
  // into line 9 is step 3, and it keeps step 3's own mark.
  const moves = markLineMoves([9, 10], [change(8, 0, 9, 0, 0)]);
  assert.deepEqual([...moves], [[9, null], [10, 9]]);
});

test('Ctrl+Shift+K on the LAST line of the document removes that step', () => {
  // With no line after it, VS Code deletes from the end of the line above.
  assert.deepEqual(after([change(8, LEN, 9, LEN, 0)]), [8, 9, null]);
});

test('Backspace at column 0 joins the step onto the line above and removes its mark', () => {
  // The line above keeps its start, and its mark; this line's text now carries
  // on after it.
  assert.deepEqual(after([change(7, LEN, 8, 0, 0)]), [8, null, 9]);
});

test('Delete at the end of the line above is the same join', () => {
  assert.deepEqual(after([change(8, LEN, 9, 0, 0)]), [8, 9, null]);
});

test('deleting a blank line between steps moves the steps below up', () => {
  // Steps on 8 and 10, a blank line on 9 (0-based 8) deleted whole.
  const moves = markLineMoves([8, 10], [change(8, 0, 9, 0, 0)]);
  assert.deepEqual([...moves], [[10, 9]]);
});

test('deleting from the middle of one step to the middle of the next keeps the first, removes the second', () => {
  assert.deepEqual(after([change(7, 5, 8, 5, 0)]), [8, null, 9]);
});

test('selecting two whole steps and pasting one line removes both marks, moves the rest up', () => {
  // The anchor suite's "select lines, paste one" edit: (7,0) to (9,0).
  assert.deepEqual(after([change(7, 0, 9, 0, 1)]), [null, null, 9]);
});

test('replacing the whole document removes every mark', () => {
  assert.deepEqual(after([change(0, 0, 30, 0, 12)]), [null, null, null]);
});

// ---- editing in place ---------------------------------------------------------

test('typing inside a step keeps every mark where it is', () => {
  assert.equal(markLineMoves(MARKS, [change(8, 6, 8, 6, 0)]), null);
});

test('retyping a step from column 0 keeps its mark (an in-place edit)', () => {
  assert.equal(markLineMoves(MARKS, [change(8, 0, 8, LEN, 0)]), null);
});

test('Renumber Steps rewriting the ordinals keeps every mark', () => {
  // One event, one change per step, each from column 0 over the digits.
  const renumber = [change(7, 0, 7, 1, 0), change(8, 0, 8, 1, 0), change(9, 0, 9, 2, 0)];
  assert.equal(markLineMoves(MARKS, renumber), null);
});

test('splitting a step with Enter in the middle keeps the mark on the first half', () => {
  assert.deepEqual(after([change(8, 6, 8, 6, 1)]), [8, 9, 11]);
});

test('a line break rewritten as two line breaks moves the next step down one', () => {
  // A replacement of the break itself, as some formatters report it — not a
  // join, because a line break is put back.
  assert.deepEqual(after([change(8, LEN, 9, 0, 2)]), [8, 9, 11]);
});

// ---- one event, several changes -----------------------------------------------

test('changes of one event are measured against the text before it, in any order', () => {
  const above = change(2, 0, 2, 0, 1);
  const deleteStep2 = change(8, 0, 9, 0, 0);
  assert.deepEqual(after([above, deleteStep2]), [9, null, 10]);
  assert.deepEqual(after([deleteStep2, above]), [9, null, 10]);
});

test('multi-cursor typing on every step moves nothing', () => {
  const typing = [change(7, 4, 7, 4, 0), change(8, 4, 8, 4, 0), change(9, 4, 9, 4, 0)];
  assert.equal(markLineMoves(MARKS, typing), null);
});

test('two adjacent changes that together join a step onto the line above: the earlier line keeps it', () => {
  // Delete from the middle of step 1 to its end, AND delete step 2 whole.
  // Step 3's text now continues step 1's line — neither change alone is a
  // join, so the collision rule is what removes step 3's mark.
  const changes = [change(7, 5, 8, 0, 0), change(8, 0, 9, 0, 0)];
  assert.equal(shiftMarkLine(9, changes), 7, 'on its own, step 3 lands on step 1');
  assert.deepEqual(after(changes), [8, null, null]);
});

// ---- applying the moves -------------------------------------------------------

test('moveLineKeyed moves, removes and leaves alone, in place', () => {
  const statuses = new Map([
    [8, 'pass'],
    [9, 'fail'],
    [10, 'pass'],
    [3, 'pass'],
  ]);
  const same = statuses;
  moveLineKeyed(statuses, new Map([[9, null], [10, 9]]));
  assert.equal(statuses, same, 'the same Map — callers hold references to it');
  assert.deepEqual(
    [...statuses].sort((a, b) => a[0] - b[0]),
    [
      [3, 'pass'],
      [8, 'pass'],
      [9, 'pass'],
    ],
  );
});

test('one set of moves for every store keeps a ✗ and its hover on the same step', () => {
  // The failure store has nothing on step 1's line, so deciding the moves per
  // store would find no collision there and put step 3's failure text on
  // step 1 — under step 1's ✓. The union is what keeps the stores in step.
  const statuses = new Map([[8, 'pass'], [10, 'fail']]);
  const failures = new Map([[10, { error: 'boom' }]]);
  const changes = [change(7, 5, 8, 0, 0), change(8, 0, 9, 0, 0)];
  const moves = markLineMoves([...statuses.keys(), ...failures.keys()], changes);
  moveLineKeyed(statuses, moves);
  moveLineKeyed(failures, moves);
  assert.deepEqual([...statuses], [[8, 'pass']]);
  assert.deepEqual([...failures], [], 'the failure went with its step, not onto step 1');
});

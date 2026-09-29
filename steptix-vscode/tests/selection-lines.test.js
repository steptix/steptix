/**
 * `selectionLines` — which lines a selection actually names.
 *
 * The rules live in selection-lines-core.ts (pure, no VS Code) so this suite
 * can pin them. Both feed `runSelected` and `snapshot.selectedLines`, and the
 * whole-line rule is a prerequisite of
 * stories/data-row-progress-and-selection.md: triple-click is the natural way
 * to pick a table row, and before this guard it picked the row below it too.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { selectionLinesFrom } from '../src/extension/selection-lines-core.ts';

/** A range selection, in VS Code's 0-based line/character coordinates. */
const sel = (sl, sc, el, ec) => ({
  isEmpty: sl === el && sc === ec,
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

test('a selection ending at column 0 of the next line stops at its start line', () => {
  // Triple-click, Ctrl+L, Shift+Down from column 0: all three swallow the
  // trailing line break and land at (next line, 0). That position is the
  // break, not a line the user chose.
  assert.deepEqual(selectionLinesFrom([sel(2, 0, 3, 0)]), [3]);
});

test('a selection ending past column 0 keeps its end line', () => {
  assert.deepEqual(selectionLinesFrom([sel(2, 0, 3, 4)]), [3, 4]);
});

test('a selection ending at column 0 of a line two below still drops only that line', () => {
  // Three triple-clicked lines (Shift+Down ×3) — the guard takes one line
  // off the end, never the whole tail.
  assert.deepEqual(selectionLinesFrom([sel(2, 0, 5, 0)]), [3, 4, 5]);
});

test('a bare cursor yields nothing — it means "I am parked here"', () => {
  assert.deepEqual(selectionLinesFrom([sel(1, 0, 1, 0)]), []);
  assert.deepEqual(selectionLinesFrom([sel(4, 7, 4, 7)]), []);
});

test('a single-line range always yields that line, whatever the columns', () => {
  // The guard is gated on the end line being LATER than the start, so it can
  // never empty a selection out.
  assert.deepEqual(selectionLinesFrom([sel(2, 0, 2, 9)]), [3]);
  assert.deepEqual(selectionLinesFrom([sel(2, 3, 2, 4)]), [3]);
});

test('two selections merge, sorted and de-duplicated', () => {
  // Alt+click gives several cursors; Shift+End gives each one a range. The
  // order they arrive in is the order they were made, not document order.
  assert.deepEqual(
    selectionLinesFrom([sel(9, 0, 9, 5), sel(1, 0, 2, 0), sel(1, 2, 1, 6)]),
    [2, 10],
  );
});

test('an empty selection among ranges is ignored, not counted', () => {
  assert.deepEqual(
    selectionLinesFrom([sel(3, 0, 3, 0), sel(5, 0, 6, 0), sel(8, 1, 8, 2)]),
    [6, 9],
  );
});

test('no selections at all is no lines', () => {
  assert.deepEqual(selectionLinesFrom([]), []);
});

test('the whole-line rule applies to a two-row drag over a table', () => {
  // Dragging rows 2 and 3 of a table from the left margin ends at (row 4, 0).
  // Before the guard this ran row 4 as well — the row the user stopped short
  // of, which in a matrix is a whole extra browser and a whole extra sign-in.
  assert.deepEqual(selectionLinesFrom([sel(5, 0, 7, 0)]), [6, 7]);
});

// ── The exception: narrowing a selection must not widen a run ──────────────
//
// `resolveRunSelection`'s last fallback is "every main-flow step at or below
// the lowest selected line" — it is what makes "drag over `## Steps`, then
// Run" run the file. So a selection the guard has emptied of runnable lines
// does not run nothing; it runs everything from there down. A drag that
// stopped at the START of step 6 used to run step 6 and now ran 6, 7, 8…
// The guard keeps the line it would drop when that line is the only runnable
// thing the gesture named.

test('a drag from prose that stops at the start of a step keeps that step', () => {
  // Lines 5 (prose) → (6, 0), with line 6 a step: `[5, 6]` before, and the
  // resolver reads that as "step 6". Without the exception the selection is
  // `[5]`, which names no step, and the fallback runs step 6 and every step
  // after it.
  const steps = [6, 7, 8];
  assert.deepEqual(selectionLinesFrom([sel(4, 0, 5, 0)], steps), [5, 6]);
});

test('…and a triple-clicked step still drops the step below it', () => {
  // The same shape, and the exception must NOT fire: line 2 is a step, so the
  // selection already names something runnable and line 3 is the line break
  // the gesture swallowed.
  assert.deepEqual(selectionLinesFrom([sel(1, 0, 2, 0)], [2, 3, 4]), [2]);
});

test('a data row counts as runnable, both ways', () => {
  // Triple-click on row 2 of a table (lines 6..8 are its rows): the guard
  // drops row 3 as before, because row 2 is itself runnable.
  assert.deepEqual(selectionLinesFrom([sel(6, 0, 7, 0)], [6, 7, 8]), [7]);
  // A drag from the table's header (line 5, not runnable) that stops at the
  // start of the first row keeps that row.
  assert.deepEqual(selectionLinesFrom([sel(4, 0, 5, 0)], [6, 7, 8]), [5, 6]);
});

test('the dropped line has to be runnable itself — a blank is still dropped', () => {
  // Drag from the `## Steps` heading (line 3) down to the blank line 9: the
  // guard drops 9 as always. Nothing kept it, and nothing should: the
  // resolver's fallback is the RIGHT answer for that gesture.
  assert.deepEqual(selectionLinesFrom([sel(2, 0, 8, 0)], [10, 11]), [3, 4, 5, 6, 7, 8]);
});

test('with no runnable set, the plain rule holds — every existing caller', () => {
  assert.deepEqual(selectionLinesFrom([sel(4, 0, 5, 0)]), [5]);
});

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { shiftAnchorForChanges, changesTouchAnchor } from '../src/extension/step-lines.ts';

/**
 * Unit coverage for the resume position-anchor shift math (spec
 * stories/specs/resume-position-anchor.md §4.2 / §6). The function is pure and
 * `vscode`-free; the tracker wires it to a real document-change event's
 * changes. The anchor line is 0-based; a change carries 0-based `startLine`,
 * `endLine`, and `endCharacter`; `stepLines` are 1-based (matching
 * `extractSteps(...).map(s => s.line)`).
 */

// A 3-step document with steps on 1-based lines 8, 9, 10 (the integration
// fixture's shape). 0-based anchor line 9 == 1-based line 10 == step 3.
const STEPS = [8, 9, 10];

test('insert above the anchor shifts the derived line down by the lines added', () => {
  // Insert one line at the start of 0-based line 8 (above anchor 9).
  const next = shiftAnchorForChanges(
    9,
    [{ startLine: 8, endLine: 8, endCharacter: 0, addedLines: 1 }],
    [8, 9, 10, 11],
  );
  assert.equal(next, 10, 'anchor 0-based 9 → 10 (1-based 10 → 11)');
});

test('insert THREE lines above the anchor shifts by three', () => {
  const next = shiftAnchorForChanges(
    9,
    [{ startLine: 5, endLine: 5, endCharacter: 0, addedLines: 3 }],
    [11, 12, 13],
  );
  assert.equal(next, 12);
});

test('insert below the anchor leaves the derived line unchanged', () => {
  const next = shiftAnchorForChanges(
    9,
    [{ startLine: 10, endLine: 10, endCharacter: 0, addedLines: 1 }],
    STEPS,
  );
  assert.equal(next, 9);
});

test('delete below the anchor leaves the derived line unchanged', () => {
  const next = shiftAnchorForChanges(
    9,
    [{ startLine: 11, endLine: 12, endCharacter: 0, addedLines: 0 }],
    STEPS,
  );
  assert.equal(next, 9);
});

test('deleting the resume step snaps the anchor to the next surviving step', () => {
  // Delete the whole anchor line (0-based 9): range [(9,0),(10,0)] ends at
  // column 0 of line 10, so effectiveEndLine is 9 — it touches the anchor.
  // Post-edit the step below slid up to 1-based line 10; snap to first >= 10.
  const next = shiftAnchorForChanges(
    9,
    [{ startLine: 9, endLine: 10, endCharacter: 0, addedLines: 0 }],
    [8, 9, 10],
  );
  assert.equal(next, 9, 'snaps to 0-based 9 (1-based 10) — the slid-up survivor');
});

test('deleting the last step at/after the anchor clears it (null)', () => {
  const next = shiftAnchorForChanges(
    9,
    [{ startLine: 9, endLine: 10, endCharacter: 0, addedLines: 0 }],
    [8, 9],
  );
  assert.equal(next, null, 'no surviving step → clear the anchor');
});

test('editing text on the resume line (within the line) keeps the derived line', () => {
  // A wording edit replaces a span inside the anchor line: range [(9,3),(9,8)],
  // endCharacter 8 (nonzero) → it touches the line's content. The line still
  // carries a step, so snap-forward returns the same line.
  const next = shiftAnchorForChanges(
    9,
    [{ startLine: 9, endLine: 9, endCharacter: 8, addedLines: 0 }],
    [8, 9, 10],
  );
  assert.equal(next, 9, 'wording edit on the resume line does not move the anchor');
});

test('inserting at the START of the resume line shifts the anchor down (original step preserved)', () => {
  // Insert "newstep\n" at column 0 of the anchor line: range [(9,0),(9,0)],
  // endCharacter 0 → it does NOT touch the line's content, it pushes it down.
  // The original resume step moves to 0-based line 10; Continue resumes it, not
  // the inserted line. (Previously this snapped; shifting is the no-ghost
  // behaviour, consistent with an insert one line higher.)
  const next = shiftAnchorForChanges(
    9,
    [{ startLine: 9, endLine: 9, endCharacter: 0, addedLines: 1 }],
    [8, 10, 11],
  );
  assert.equal(next, 10, 'anchor shifts to the original step’s new line');
});

// ---- multi-line replace (select N lines, paste 1 line) -------------------------

test('selecting whole lines ABOVE the anchor and pasting one line shifts the anchor up (no snap)', () => {
  // Select whole 1-based lines 8–9 and replace with one line: range
  // [(7,0),(9,0)] ends at column 0 of line 10 → effectiveEndLine 8, entirely
  // above the anchor at 9. Net delta = added(1) - removed(2) = -1. The anchor's
  // own step is untouched, so it shifts up rather than snapping. stepLines are
  // irrelevant here (no touch) — pass [] to prove they are not consulted.
  const next = shiftAnchorForChanges(
    9,
    [{ startLine: 7, endLine: 9, endCharacter: 0, addedLines: 1 }],
    [],
  );
  assert.equal(next, 8, 'anchor 0-based 9 → 8 (1-based 10 → 9); resume the original step');
});

test('selecting lines that SPAN the anchor and pasting one line snaps forward to a survivor', () => {
  // Select whole 1-based lines 9–10 (includes the anchor step at line 10) and
  // replace with one line: range [(8,0),(10,0)] → effectiveEndLine 9 == anchor,
  // a touch. The resume step was replaced; snap to the first surviving step
  // at/after the selection start. Post-edit steps land at [8, 9].
  const next = shiftAnchorForChanges(
    9,
    [{ startLine: 8, endLine: 10, endCharacter: 0, addedLines: 1 }],
    [8, 9],
  );
  assert.equal(next, 8, 'snaps to the surviving step at 1-based 9');
});

// ---- multi-change events (the regression the per-change fold double-counted) ----

test('a multi-change event with an above-edit AND a touch-edit does not double-count the above shift', () => {
  // One event, two non-overlapping changes against the ORIGINAL document:
  //   B (above): insert 1 line at 0-based line 2  → shifts everything below +1
  //   A (touch): delete the anchor's own line (0-based 9)
  // A 4th step originally at 0-based 14 survives. Post-edit step lines (1-based)
  // land at [9, 10, 15]; the deleted resume step's successor is the one now at
  // 1-based 15. The anchor must snap there → 0-based 14.
  const next = shiftAnchorForChanges(
    9,
    [
      { startLine: 9, endLine: 10, endCharacter: 0, addedLines: 0 }, // A: delete anchor line
      { startLine: 2, endLine: 2, endCharacter: 0, addedLines: 1 }, // B: insert above
    ],
    [9, 10, 15],
  );
  // The buggy per-change fold returned 0-based 10 (1-based 11 — not even a step
  // line) because it snapped A in pre-shift coords then re-applied B's +1.
  assert.equal(next, 14, 'snaps to the surviving successor (1-based 15), B counted once');
});

test('multi-change ordering does not matter (changes classified against the original anchor)', () => {
  const next = shiftAnchorForChanges(
    9,
    [
      { startLine: 2, endLine: 2, endCharacter: 0, addedLines: 1 }, // B: insert above
      { startLine: 9, endLine: 10, endCharacter: 0, addedLines: 0 }, // A: delete anchor line
    ],
    [9, 10, 15],
  );
  assert.equal(next, 14);
});

test('two separate above-edits in one event sum their deltas', () => {
  const next = shiftAnchorForChanges(
    9,
    [
      { startLine: 6, endLine: 6, endCharacter: 0, addedLines: 2 },
      { startLine: 3, endLine: 3, endCharacter: 0, addedLines: 1 },
    ],
    [11, 12, 13],
  );
  assert.equal(next, 12);
});

test('a delete spanning from above through the anchor snaps to the surviving step below', () => {
  // Delete 0-based lines 5..12 — removes the anchor (line 9) and the steps
  // around it; a step further down survives and slid up to 1-based line 9.
  const next = shiftAnchorForChanges(
    9,
    [{ startLine: 5, endLine: 12, endCharacter: 0, addedLines: 0 }],
    [9],
  );
  assert.equal(next, 8, 'resumes at the survivor (1-based 9), not null');
});

// ---- changesTouchAnchor predicate (must agree with the function) ---------------

test('changesTouchAnchor: a whole-line replace ending at column 0 of the anchor line is NOT a touch', () => {
  assert.equal(
    changesTouchAnchor([{ startLine: 7, endLine: 9, endCharacter: 0, addedLines: 1 }], 9),
    false,
    'range ending at column 0 of the anchor line stops before its content',
  );
});

test('changesTouchAnchor: a replace spanning into the anchor line IS a touch', () => {
  assert.equal(
    changesTouchAnchor([{ startLine: 8, endLine: 10, endCharacter: 0, addedLines: 1 }], 9),
    true,
  );
  // And a within-line edit on the anchor line.
  assert.equal(
    changesTouchAnchor([{ startLine: 9, endLine: 9, endCharacter: 8, addedLines: 0 }], 9),
    true,
  );
});

// ---- section-body resume: lazy, target-dependent snap candidates ---------------
//
// A body anchor snaps among the body lines of ITS OWN section, and the
// invocation it runs under shifts in the same event. Both are expressed by
// passing a FUNCTION for `stepLines` — called only when a change actually
// touches the line being shifted, and given the post-edit target so it can
// answer per-section. See stories/specs/sections-run-and-resume.md §5.4.

test('function candidates are not consulted when nothing touches the anchor', () => {
  let calls = 0;
  const next = shiftAnchorForChanges(
    9,
    [{ startLine: 3, endLine: 3, endCharacter: 0, addedLines: 1 }],
    () => {
      calls++;
      return [];
    },
  );
  assert.equal(next, 10, 'plain shift, no snap');
  assert.equal(calls, 0, 'a pure shift must not re-parse the document');
});

test('function candidates receive the post-edit target line, 1-based', () => {
  const seen = [];
  shiftAnchorForChanges(
    9,
    [
      { startLine: 3, endLine: 3, endCharacter: 0, addedLines: 2 }, // above: +2
      { startLine: 9, endLine: 9, endCharacter: 4, addedLines: 0 }, // touches
    ],
    (target) => {
      seen.push(target);
      return [12];
    },
  );
  // touchStart 9 + deltaAbove 2 → 0-based 11 → 1-based 12.
  assert.deepEqual(seen, [12]);
});

test('a deleted body step snaps to the next step of the SAME section', () => {
  // `### Login` body on 1-based 24, 25, 29; `### Cleanup` body on 33.
  // Delete the anchor line (0-based 23 == 1-based 24). The candidates the
  // tracker supplies are Login's post-edit body only, so the snap can reach
  // 25 but can never reach 33.
  const next = shiftAnchorForChanges(
    23,
    [{ startLine: 23, endLine: 24, endCharacter: 0, addedLines: 0 }],
    (target) => [24, 28].filter((l) => l >= target),
  );
  assert.equal(next, 23, 'snapped to the next Login body step (1-based 24)');
});

test('deleting the LAST body step of a section clears rather than crossing into the next', () => {
  // Anchor on Login's last body step (0-based 28 == 1-based 29), deleted.
  // Login has no surviving step at or after it; Cleanup's line 33 is NOT a
  // candidate, because the tracker scopes candidates to the anchor's own
  // section. Clearing is the correct answer — resuming into a different
  // section's body would silently run a different flow.
  const next = shiftAnchorForChanges(
    28,
    [{ startLine: 28, endLine: 29, endCharacter: 0, addedLines: 0 }],
    () => [24, 25],
  );
  assert.equal(next, null);
});

test('the call position shifts on an insert above while the body anchor does not', () => {
  // Insert one line above the invocation (0-based 16 == 1-based 17) but below
  // nothing else relevant. Run the same change set through both positions the
  // way maintainAnchor does.
  const changes = [{ startLine: 12, endLine: 12, endCharacter: 0, addedLines: 1 }];
  const call = shiftAnchorForChanges(16, changes, () => [14, 18, 19]);
  const body = shiftAnchorForChanges(23, changes, () => [25, 26, 30]);
  assert.equal(call, 17, 'invocation moved down one line');
  assert.equal(body, 24, 'body step moved down one line too');
});

test('deleting the invocation clears the call position, which clears the resume point', () => {
  // maintainAnchor treats either half returning null as "the whole resume
  // point is gone" — a body line with no invocation is not resumable.
  const call = shiftAnchorForChanges(
    16,
    [{ startLine: 16, endLine: 17, endCharacter: 0, addedLines: 0 }],
    () => [],
  );
  assert.equal(call, null);
});

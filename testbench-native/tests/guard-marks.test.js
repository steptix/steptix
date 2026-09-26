/**
 * What a clean `frame:pop` paints on a call line that is also a guard
 * (stories/codebehind-loops-and-conditions.md, decision 15).
 *
 * The rule lives in guard-mark-core.ts (pure, no VS Code) so this suite can pin
 * it; `tests/integration/suite/guard-marks.test.cjs` drives the same events
 * through the real extension host and proves the router consults it.
 *
 * The shape under test: a guard's own `step:pass` paints `</>` / ⚠ on its line;
 * its section tail's frame is pushed and popped on that same line; the pop used
 * to paint a plain ✓ unconditionally, erasing the mark and the ⚠'s hover.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { GuardMarks, isGuardCodeMark, passMarkFor } from '../src/extension/guard-mark-core.ts';
import { staleHoverMessage } from '../src/extension/failure-hover-core.ts';

const DOC = 'file:///c%3A/p/tests/control-flow.md';
const OTHER = 'file:///c%3A/p/tests/other.md';
const STALE = { codeBehindStale: { file: 'C:/p/tests/control-flow.steps.ts', error: 'locator timeout' } };

test('only the code mark and the stale mark are guard code marks', () => {
  assert.equal(isGuardCodeMark('pass-code-behind'), true);
  assert.equal(isGuardCodeMark('pass-stale'), true);
  for (const status of ['pass', 'skip', 'fail', 'fail-tolerated', 'running', 'stopped', undefined]) {
    assert.equal(isGuardCodeMark(status), false, String(status));
  }
});

test('a pop on a line nothing marked paints the plain ✓ it always did', () => {
  const marks = new GuardMarks();
  assert.deepEqual(marks.forFramePop(DOC, 2), { status: 'pass' });
});

test('a guard decided by code keeps </> through its tail\'s pop', () => {
  const marks = new GuardMarks();
  marks.notePass(DOC, 2, 'pass-code-behind');
  assert.deepEqual(marks.forFramePop(DOC, 2), { status: 'pass-code-behind' });
});

test('a stale guard keeps ⚠ AND its hover detail through the pop', () => {
  // The detail is the only place that says what the condition's code threw;
  // the tail's `frame:push` painted ▶ and dropped it, so the pop must put it back.
  const marks = new GuardMarks();
  marks.notePass(DOC, 5, 'pass-stale', STALE);
  assert.deepEqual(marks.forFramePop(DOC, 5), { status: 'pass-stale', detail: STALE });
});

test('a guard the model decided pops to a plain ✓', () => {
  const marks = new GuardMarks();
  marks.notePass(DOC, 2, 'pass');
  assert.deepEqual(marks.forFramePop(DOC, 2), { status: 'pass' });
});

test('the latest pass on the line wins — a loop\'s later visit updates the mark', () => {
  const marks = new GuardMarks();
  // Visit 1: code decided. Visit 2: the code threw and the model healed it.
  marks.notePass(DOC, 5, 'pass-code-behind');
  marks.notePass(DOC, 5, 'pass-stale', STALE);
  assert.deepEqual(marks.forFramePop(DOC, 5), { status: 'pass-stale', detail: STALE });
  // Visit 3: code again — and the ⚠'s detail goes with the ⚠.
  marks.notePass(DOC, 5, 'pass-code-behind');
  assert.deepEqual(marks.forFramePop(DOC, 5), { status: 'pass-code-behind' });
  // Visit 4: the model decided (plain pass) — the pop goes back to ✓.
  marks.notePass(DOC, 5, 'pass');
  assert.deepEqual(marks.forFramePop(DOC, 5), { status: 'pass' });
});

test('a pass that left ◌ or an amber ✗ on the line forgets the code mark', () => {
  const marks = new GuardMarks();
  marks.notePass(DOC, 2, 'pass-code-behind');
  marks.notePass(DOC, 2, 'skip', { error: 'another branch of this decision was taken' });
  assert.deepEqual(marks.forFramePop(DOC, 2), { status: 'pass' });

  marks.notePass(DOC, 3, 'pass-stale', STALE);
  marks.notePass(DOC, 3, 'fail-tolerated');
  assert.deepEqual(marks.forFramePop(DOC, 3), { status: 'pass' });
});

test('reading a mark does not consume it — every pop that lands on the line sees it', () => {
  // A `While` whose body calls a section: the inner frame's pop paints the ROOT
  // call line (the `While` line) too, before the body frame's own pop does.
  const marks = new GuardMarks();
  marks.notePass(DOC, 5, 'pass-code-behind');
  assert.equal(marks.forFramePop(DOC, 5).status, 'pass-code-behind');
  assert.equal(marks.forFramePop(DOC, 5).status, 'pass-code-behind');
});

test('marks are per document and per line', () => {
  const marks = new GuardMarks();
  marks.notePass(DOC, 2, 'pass-code-behind');
  assert.equal(marks.forFramePop(DOC, 3).status, 'pass', 'another line of the same file');
  assert.equal(marks.forFramePop(OTHER, 2).status, 'pass', 'the same line of another file');
  // Forgetting a line of a document with no marks at all is a no-op, not a throw.
  marks.notePass(OTHER, 9, 'pass');
  assert.equal(marks.forFramePop(OTHER, 9).status, 'pass');
});

test('a new run clears the document — the next run starts with no marks', () => {
  const marks = new GuardMarks();
  marks.notePass(DOC, 2, 'pass-code-behind');
  marks.notePass(DOC, 5, 'pass-stale', STALE);
  marks.notePass(OTHER, 2, 'pass-code-behind');
  marks.clear(DOC);
  assert.deepEqual(marks.forFramePop(DOC, 2), { status: 'pass' });
  assert.deepEqual(marks.forFramePop(DOC, 5), { status: 'pass' });
  // Only that document: another file's run is not this one's to clear.
  assert.equal(marks.forFramePop(OTHER, 2).status, 'pass-code-behind');
});

// ── What a `step:pass` paints (passMarkFor) ─────────────────────────────────
//
// A chain member whose CONDITION entry threw on the visit that then took
// another member carries its ⚠ on its own skipped event. Before this rule the
// server put it on the member that HELD, and a skip outranked the stale flag,
// so the broken line painted ◌ with no hover and "Repair this step" was
// offered on a line whose entry did nothing wrong.

const NOT_TAKEN = 'Skipped: another branch of this decision was taken';

test('a skipped pass carrying codeBehindStale paints ⚠, with both facts in its detail', () => {
  const mark = passMarkFor({ reason: NOT_TAKEN, ...STALE }, true);
  assert.equal(mark.status, 'pass-stale');
  assert.deepEqual(mark.detail, { codeBehindStale: STALE.codeBehindStale, notTaken: NOT_TAKEN });
});

test('a skipped ⚠ with no reason still says it was not taken', () => {
  assert.deepEqual(passMarkFor({ ...STALE }, true).detail, {
    codeBehindStale: STALE.codeBehindStale,
    notTaken: 'Skipped',
  });
});

test('a plain skip stays ◌ with its reason; a code-decided skip is still ◌', () => {
  assert.deepEqual(passMarkFor({ reason: NOT_TAKEN }, true), {
    status: 'skip',
    detail: { error: NOT_TAKEN },
  });
  assert.deepEqual(passMarkFor({}, true), { status: 'skip' });
  assert.equal(passMarkFor({ reason: NOT_TAKEN, fromCodeBehind: true }, true).status, 'skip');
});

test('a pass that ran keeps its order: ⚠, then </>, then ✓ — no notTaken on a line that ran', () => {
  assert.deepEqual(passMarkFor({ ...STALE }, false), {
    status: 'pass-stale',
    detail: { codeBehindStale: STALE.codeBehindStale },
  });
  assert.deepEqual(passMarkFor({ fromCodeBehind: true }, false), { status: 'pass-code-behind' });
  assert.deepEqual(passMarkFor({}, false), { status: 'pass' });
});

test('the skipped ⚠ hovers with the skip reason, what the condition threw, and the Repair line', () => {
  const hover = staleHoverMessage({ codeBehindStale: STALE.codeBehindStale, notTaken: NOT_TAKEN });
  assert.ok(hover.startsWith(NOT_TAKEN), hover);
  assert.match(hover, /This line was not taken, and its condition's compiled code-behind threw/);
  assert.match(hover, /locator timeout/);
  assert.match(hover, /control-flow\.steps\.ts/);
  assert.match(hover, /Repair this step/);
  // A ⚠ on a line that RAN keeps its own wording.
  assert.match(staleHoverMessage({ codeBehindStale: STALE.codeBehindStale }), /^This step passed under AI/);
});

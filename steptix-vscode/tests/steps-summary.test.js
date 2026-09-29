/**
 * The `## Steps` heading summary — "11/12 passed (7 code-behind), 1 skipped"
 * (stories/step-flow-control.md, decision 15).
 *
 * The wording lives in steps-summary-core.ts (pure, no VS Code) for the same
 * reason failure-hover-core.ts, row-summary-core.ts and step-skip-core.ts do:
 * an after-text decoration cannot be read back out of the extension host once
 * it is rendered, so if this suite does not pin the string, nothing does.
 *
 * The case that brought the file into being: a run that returned counted its
 * skipped steps in the DENOMINATOR and nowhere else, so `4/5 passed` was the
 * whole story — indistinguishable from a step that failed to paint at all.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  countMainFlowStatuses,
  stepsSummaryText,
} from '../src/extension/steps-summary-core.ts';

/** Lines 1..n as the main flow, and a status per line. */
const summaryOf = (...statuses) =>
  countMainFlowStatuses(
    statuses.map((s, i) => [i + 1, s]),
    statuses.map((_, i) => i + 1),
  );

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

test('a skipped step counts in the total but not as a pass', () => {
  const counts = summaryOf('pass', 'pass', 'pass', 'pass', 'skip');
  assert.equal(counts.passed, 4);
  assert.equal(counts.skipped, 1);
  assert.equal(counts.total, 5);
});

test('every flavour of pass is a pass, and none of them is a skip', () => {
  const counts = summaryOf('pass', 'pass', 'pass-code-behind', 'pass-stale');
  assert.equal(counts.passed, 4);
  assert.equal(counts.passedCodeBehind, 1);
  assert.equal(counts.stale, 1);
  assert.equal(counts.skipped, 0);
});

test('a ⚠ on a chain member that was NOT taken counts as skipped and stale, never passed', () => {
  // A chain member whose condition's code threw on the visit that took
  // another member paints ⚠ so Repair is offered on its line — but the line
  // did not run (stories/codebehind-loops-and-conditions.md).
  const counts = countMainFlowStatuses(
    [
      [1, 'pass'],
      [2, 'pass-stale'],
      [3, 'pass'],
    ],
    [1, 2, 3],
    new Set([2]),
  );
  assert.equal(counts.passed, 2);
  assert.equal(counts.skipped, 1);
  // Stale, and counted where it is: among the skips, not the passes.
  assert.equal(counts.stale, 0);
  assert.equal(counts.staleSkipped, 1);
  assert.equal(counts.total, 3);
  // Review round 2 (F8). Measured before the fix: "2/3 passed (1 stale), 1
  // skipped" — a parenthesis that breaks down the PASSES claiming the one
  // line that did not run.
  assert.equal(stepsSummaryText(counts), '2/3 passed, 1 skipped (1 stale)');
});

test('a stale pass and a stale skip are each said beside their own count', () => {
  const counts = countMainFlowStatuses(
    [
      [1, 'pass-stale'],
      [2, 'pass-stale'],
      [3, 'skip'],
      [4, 'pass-code-behind'],
    ],
    [1, 2, 3, 4],
    new Set([2]),
  );
  assert.equal(stepsSummaryText(counts), '2/4 passed (1 code-behind, 1 stale), 2 skipped (1 stale)');
});

test('a run with no stale skip renders exactly as before', () => {
  assert.equal(stepsSummaryText(summaryOf('pass', 'pass-stale', 'skip')), '2/3 passed (1 stale), 1 skipped');
  assert.equal(stepsSummaryText(summaryOf('pass', 'skip')), '1/2 passed, 1 skipped');
});

test('a fail is neither a pass nor a skip', () => {
  const counts = summaryOf('pass', 'fail', 'skip');
  assert.equal(counts.passed, 1);
  assert.equal(counts.skipped, 1);
  assert.equal(counts.total, 3);
});

test("body lines are not counted — the denominator is the author's own steps", () => {
  // A section body line can run zero times or many, so counting it makes the
  // denominator meaningless and lets the numerator exceed it. Line 40 here is
  // a body line: it has a status and is not in the main flow.
  const counts = countMainFlowStatuses(
    [
      [1, 'pass'],
      [2, 'skip'],
      [40, 'skip'],
    ],
    [1, 2],
  );
  assert.equal(counts.total, 2);
  assert.equal(counts.skipped, 1);
});

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

test('a run that skipped nothing reads exactly as it always did', () => {
  // Byte-identical for every run this feature never touches — the one thing
  // the change must not do is reword the ordinary case.
  assert.equal(stepsSummaryText(summaryOf('pass', 'pass', 'pass')), '3/3 passed');
});

test('a run that skipped nothing keeps its breakdown parenthesis, unchanged', () => {
  const counts = summaryOf('pass', 'pass-code-behind', 'pass-stale', 'pass');
  assert.equal(stepsSummaryText(counts), '4/4 passed (1 code-behind, 1 stale)');
});

test('a return says how many steps it left behind', () => {
  assert.equal(
    stepsSummaryText(summaryOf('pass', 'pass', 'pass', 'pass', 'skip')),
    '4/5 passed, 1 skipped',
  );
});

test('the skip clause sits outside the parenthesis, which breaks down the PASSES', () => {
  const counts = summaryOf('pass', 'pass-code-behind', 'skip', 'skip');
  assert.equal(stepsSummaryText(counts), '2/4 passed (1 code-behind), 2 skipped');
});

test('a run that skipped everything still names its denominator', () => {
  assert.equal(stepsSummaryText(summaryOf('skip', 'skip')), '0/2 passed, 2 skipped');
});

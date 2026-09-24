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

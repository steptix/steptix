/**
 * How the chat panel renders a step's status
 * (stories/step-flow-control.md, decision 9).
 *
 * `skipped` reached this client the day `If … then return` shipped — a Flick
 * user types a flow-control step like anyone else and the server answers with
 * `status: 'skipped'` for every step the return left behind. Flick's own
 * `StepStatus` union did not have it, so those rows fell through the
 * webview's `!== 'passed'` branches: ⚠ in the glyph column, auto-expanded
 * bodies, and the batch's error message attached to lines that never failed.
 * A run that did exactly what its author asked reported as a wall of errors.
 *
 * The DOM is not what went wrong; the three decisions were. They live in a
 * module of their own so `node --test` can hold them, the split
 * `output-sections.ts` is on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoExpandsOnFirstRender,
  showsBatchError,
  skipReason,
  statusGlyph,
  statusLabel,
} from '../../src/webview/step-status';

test('a skipped step wears the neutral ◌, not the error ⚠', () => {
  assert.equal(statusGlyph('skipped'), '◌');
  // The same glyph TestBench paints. Two clients showing one run must not
  // disagree about the mark for a line neither of them ran.
  assert.equal(statusGlyph('passed'), '✓');
  assert.equal(statusGlyph('failed'), '✗');
  assert.equal(statusGlyph('error'), '⚠');
});

test('the glyph label names the status', () => {
  assert.equal(statusLabel('skipped'), 'Skipped');
  assert.equal(statusLabel('passed'), 'Passed');
});

test('a skipped row does not open itself, while failed and error still do', () => {
  // The regression in one line: `status !== 'passed'` auto-expanded every
  // skipped row, so one return that skipped eight steps opened eight bodies
  // holding no actions, no screenshot and no error.
  assert.equal(autoExpandsOnFirstRender('skipped'), false);
  assert.equal(autoExpandsOnFirstRender('passed'), false);
  assert.equal(autoExpandsOnFirstRender('failed'), true);
  assert.equal(autoExpandsOnFirstRender('error'), true);
});

test('the batch error belongs to the step that failed, never to a skipped one', () => {
  assert.equal(showsBatchError('skipped'), false);
  assert.equal(showsBatchError('passed'), false);
  assert.equal(showsBatchError('failed'), true);
  assert.equal(showsBatchError('error'), true);
});

test('the reason is shown on the collapsed skipped row, and only there', () => {
  const reason =
    'Not run: step 2 returned from "Sign in" — If the page title contains "Dashboard" then return';
  assert.equal(skipReason('skipped', reason), reason);
  // Not on a passed row: `reasoning` there is the model's account of what it
  // did, which already has a home in the expanded body.
  assert.equal(skipReason('passed', reason), null);
  assert.equal(skipReason('failed', reason), null);
});

test('a skipped row with no reason shows nothing rather than an empty chip', () => {
  assert.equal(skipReason('skipped', ''), null);
  assert.equal(skipReason('skipped', '   '), null);
});

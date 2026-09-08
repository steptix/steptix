/**
 * What a `step:skip` says, and where it may say it
 * (stories/step-flow-control.md, decision 9).
 *
 * The wording lives in step-skip-core.ts (pure, no VS Code) for the same
 * reason failure-hover-core.ts and row-summary-core.ts do: a run-log line and
 * a decoration's rendered text cannot be read back from the extension host, so
 * if this suite does not pin them, nothing does.
 *
 * `skipPaintsOver` is here for a different reason — it is the one piece of
 * PRECEDENCE in the skip path, and the case it protects (a ✗ already on the
 * line) is the one a scripted integration test is least likely to reach by
 * accident.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  SKIP_GLYPH,
  skipPaintsOver,
  skipRunLogLine,
  skipTestOutputLine,
} from '../src/extension/step-skip-core.ts';

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

test('a skip paints over a blank line', () => {
  assert.equal(skipPaintsOver(undefined), true);
});

test('a skip paints over every flavour of pass', () => {
  // The second call of a twice-called section is exactly this: the body lines
  // passed on the first call, and the second call did not run them.
  for (const status of ['pass', 'pass-cached', 'pass-code-behind', 'pass-stale']) {
    assert.equal(skipPaintsOver(status), true, `${status} should be overwritten`);
  }
});

test('a skip paints over running and stopped', () => {
  assert.equal(skipPaintsOver('running'), true);
  assert.equal(skipPaintsOver('stopped'), true);
});

test('a skip never paints over a fail', () => {
  // THE rule. Statuses are cleared at run start, so a ✗ under an incoming
  // skip belongs to this run — downgrading it would turn a red run quiet.
  assert.equal(skipPaintsOver('fail'), false);
});

test('a second skip on the same line is idempotent', () => {
  assert.equal(skipPaintsOver('skip'), true);
});

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

const REASON = 'Not run: step 3 returned from "Sign in"';

test('the glyph is the hollow circle the Rows panel and the gutter use', () => {
  assert.equal(SKIP_GLYPH, '◌');
});

test('the run log names the line and repeats the server reason verbatim', () => {
  assert.equal(
    skipRunLogLine(31, REASON),
    '◌ step 31 skipped — Not run: step 3 returned from "Sign in"',
  );
});

test('Test Explorer names the line and, when it is elsewhere, the file', () => {
  assert.equal(
    skipTestOutputLine(31, '', REASON),
    '◌ step on line 31 skipped — Not run: step 3 returned from "Sign in"',
  );
  assert.equal(
    skipTestOutputLine(4, ' of login.md', 'Not run: step 7 ended the run'),
    '◌ step on line 4 of login.md skipped — Not run: step 7 ended the run',
  );
});

test('both single-line surfaces carry the same glyph and the same separator', () => {
  // They are read side by side in a report of one run; drift between them is
  // the thing this module exists to prevent.
  const a = skipRunLogLine(9, REASON);
  const b = skipTestOutputLine(9, '', REASON);
  assert.ok(a.startsWith(`${SKIP_GLYPH} `) && b.startsWith(`${SKIP_GLYPH} `));
  assert.ok(a.endsWith(`skipped — ${REASON}`));
  assert.ok(b.endsWith(`skipped — ${REASON}`));
});

test('a reason with no text still reads as a sentence, not a dangling dash', () => {
  // Defensive, and now literally what the title says. Two ways to arrive with
  // no reason: an older or hand-rolled server sending an empty string, and the
  // OTHER producer of a skipped step — `step:pass` carrying
  // `output: 'skipped'`, whose event shape has no reason field at all
  // (stories/control-flow.md). Both print the same sentence, and neither
  // trails an em dash with nothing after it.
  //
  // This row used to assert the dangling dash it is named after, which is the
  // shape of a test written from the implementation rather than from the
  // sentence the reader gets.
  assert.equal(skipRunLogLine(12, ''), '◌ step 12 skipped');
  assert.equal(skipRunLogLine(12, '   '), '◌ step 12 skipped');
  assert.equal(skipRunLogLine(12), '◌ step 12 skipped');
  assert.equal(skipTestOutputLine(9, ' of login.md'), '◌ step on line 9 of login.md skipped');
});

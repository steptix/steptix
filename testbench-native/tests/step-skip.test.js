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
  skipCompileLogLine,
  skipPaintsOver,
  skipPanelLine,
  skipRunLogLine,
  skipTestOutputLine,
} from '../src/extension/step-skip-core.ts';
import { runLogTallyLine } from '../src/extension/steps-summary-core.ts';

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

// ---------------------------------------------------------------------------
// The reason the OTHER producer now sends
// ---------------------------------------------------------------------------
//
// `step:pass` + `output: 'skipped'` grew a `reason` (runner-core's
// `StepPassEvent`), so the untaken half of a decision explains itself the way
// a `return`'s skips always did. The two producers' reasons are worded for
// different places, though: `skippedByReturnReason` writes "Not run: step 3
// returned from …", while `skipReasonFor` writes "Skipped: another branch of
// this decision was taken" — a standalone sentence, because what holds it is a
// REPORT CELL with no glyph beside it. Pasted into this line it stutters.

test('a report-cell reason does not repeat the word this line already says', () => {
  assert.equal(
    skipRunLogLine(7, 'Skipped: another branch of this decision was taken'),
    '◌ step 7 skipped — another branch of this decision was taken',
  );
  assert.equal(
    skipCompileLogLine(7, 'Skipped: the loop ran no passes'),
    '◌ step on line 7 skipped — the loop ran no passes',
  );
  assert.equal(
    skipPanelLine(7, 'Skipped: the list was empty'),
    '◌ Step on line 7 skipped — the list was empty',
  );
  assert.equal(
    skipTestOutputLine(7, ' of login.md', 'Skipped: no condition in this decision held'),
    '◌ step on line 7 of login.md skipped — no condition in this decision held',
  );
});

test('the strip is case- and space-tolerant, and only ever at the start', () => {
  assert.equal(skipRunLogLine(7, 'skipped:   the list was empty'), '◌ step 7 skipped — the list was empty');
  assert.equal(skipRunLogLine(7, 'SKIPPED: the list was empty'), '◌ step 7 skipped — the list was empty');
  // A reason that only MENTIONS the word keeps it: the strip is anchored.
  assert.equal(
    skipRunLogLine(7, 'The loop was skipped: it ran no passes'),
    '◌ step 7 skipped — The loop was skipped: it ran no passes',
  );
  // A return's reason leads with its own label and is untouched.
  assert.equal(
    skipRunLogLine(7, 'Not run: step 3 returned from "Sign in"'),
    '◌ step 7 skipped — Not run: step 3 returned from "Sign in"',
  );
});

test('a reason that is nothing but the prefix leaves no dangling dash', () => {
  // The composition, not just the shape: the strip runs BEFORE the emptiness
  // check, so a server sending the bare label cannot produce `skipped — `.
  assert.equal(skipRunLogLine(7, 'Skipped:'), '◌ step 7 skipped');
  assert.equal(skipRunLogLine(7, 'Skipped:   '), '◌ step 7 skipped');
});

// ---------------------------------------------------------------------------
// The run log's closing tally
// ---------------------------------------------------------------------------
//
// `run-controller.ts` counted a skipped step as a PASS here — `✓ 12 passed`
// for a run whose panel header, three inches away, said `✓ 9 passed  ◌ 3
// skipped` — because both parents' rules survived verbatim in adjacent
// branches of one `if` and contradicted each other in their own comments. One
// rule now: skipped is skipped, on every surface.

test('the run log tally counts a skipped step as skipped, not as a pass', () => {
  assert.equal(
    runLogTallyLine({ passed: 9, skipped: 3, cached: 0, codeBehind: 0, stale: 0 }),
    '✓ 9 passed, 3 skipped',
  );
});

test('a run that skipped nothing renders the string it always did', () => {
  assert.equal(
    runLogTallyLine({ passed: 12, skipped: 0, cached: 0, codeBehind: 0, stale: 0 }),
    '✓ 12 passed',
  );
  assert.equal(
    runLogTallyLine({ passed: 12, skipped: 0, cached: 2, codeBehind: 7, stale: 1 }),
    '✓ 12 passed (7 code-behind, 1 stale, 2 cached)',
  );
});

test('the parenthesis breaks down the PASSES; the skip clause sits after it', () => {
  // A skip is not a kind of pass, so it never joins the breakdown — the same
  // rule `stepsSummaryText` follows for the `## Steps` heading.
  assert.equal(
    runLogTallyLine({ passed: 9, skipped: 3, cached: 0, codeBehind: 4, stale: 0 }),
    '✓ 9 passed (4 code-behind), 3 skipped',
  );
});

test('a run that ONLY skipped still says so', () => {
  // Reachable: an unconditional `Return` as step 1, or a chain whose taken
  // branch is empty. The caller guards on `passed > 0 || skipped > 0`, so this
  // line is what such a run prints.
  assert.equal(
    runLogTallyLine({ passed: 0, skipped: 5, cached: 0, codeBehind: 0, stale: 0 }),
    '✓ 0 passed, 5 skipped',
  );
});

/**
 * What a data table says about itself — the header summary and the hovers on
 * a failed or skipped row (stories/data-row-progress-and-selection.md).
 *
 * The wording lives in row-summary-core.ts (pure, no VS Code) for the same
 * reason failure-hover-core.ts does: a decoration's rendered text cannot be
 * read back from the extension host, so if this suite does not pin the
 * strings, nothing does.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  lineStatusFromRowStatus,
  rowDetailFromHover,
  rowFailureDetail,
  rowFailureError,
  rowHeaderSummary,
  rowLastRunDetail,
  rowSkipDetail,
  rowSkipHover,
  rowStatusFromLineStatus,
  rowStoppedHover,
  rowWord,
  withRunRowsNote,
  worseRowStatus,
} from '../src/extension/row-summary-core.ts';

// ---------------------------------------------------------------------------
// The header summary
// ---------------------------------------------------------------------------

test('while looping: the running row, then what has finished', () => {
  assert.equal(
    rowHeaderSummary(['pass', 'pass', 'running', undefined, undefined]),
    '5 rows · row 3 of 5 running · 2 passed',
  );
});

test('when done: passes and failures, no running clause', () => {
  assert.equal(
    rowHeaderSummary(['pass', 'pass', 'fail', 'pass', 'pass']),
    '5 rows · 4 passed · 1 failed',
  );
});

test('after a Stop: the stopped row and the ones never reached', () => {
  assert.equal(
    rowHeaderSummary(['pass', 'pass', 'stopped', 'skip', 'skip']),
    '5 rows · 2 passed · 1 stopped · 2 not run',
  );
});

test('a section table counts iterations, not rows', () => {
  assert.equal(
    rowHeaderSummary(['pass', 'running', undefined], 'section'),
    '3 rows · iteration 2 of 3 running · 1 passed',
  );
});

test('before any run: just the count', () => {
  assert.equal(rowHeaderSummary([undefined, undefined]), '2 rows');
});

test('one row is a row, not "1 rows"', () => {
  assert.equal(rowHeaderSummary([undefined]), '1 row');
});

test('a pass origin still counts as a pass', () => {
  // A row should never wear `pass-cached` / `pass-code-behind` / `pass-stale`
  // — they are step facts. Counting them anyway means a caller reading
  // straight off the tracker can never produce a summary that hides a pass.
  assert.equal(
    rowHeaderSummary(['pass-cached', 'pass-code-behind', 'pass-stale']),
    '3 rows · 3 passed',
  );
});

test('the running clause names the FIRST running row', () => {
  // Two rows never run at once. If a repaint ever leaves two banded, the
  // summary must still name one row rather than render "row 2, 3 of 4".
  assert.equal(
    rowHeaderSummary(['pass', 'running', 'running', undefined]),
    '4 rows · row 2 of 4 running · 1 passed',
  );
});

// ---------------------------------------------------------------------------
// Hovers
// ---------------------------------------------------------------------------

test('a failed run row leads with the row and its values, and fences only the error', () => {
  // The order is the fix for a hover that used to go through
  // `failHoverMessage`: that renderer opens with "This step failed:" — a row
  // is not a step — then fences EVERYTHING it is given and clips the fence at
  // 1000 characters, so a long Playwright log pushed the row heading into a
  // code block and cut the values, the one thing the hover exists to name,
  // off the end.
  const hover = rowFailureError({
    kind: 'run',
    row: 3,
    stepOrdinal: 6,
    stepText: 'Verify the "Invalid email or password" banner is shown',
    error: 'locator.click: Timeout 30000ms exceeded',
    values: 'email=nobody@securebank.com, password=***, outcome=the banner',
  });
  assert.equal(
    hover,
    'Row 3 failed at step 6 — "Verify the "Invalid email or password" banner is shown"\n\n' +
      '`email=nobody@securebank.com, password=***, outcome=the banner`\n\n' +
      '```\nlocator.click: Timeout 30000ms exceeded\n```',
  );
});

test('a long error is clipped inside the fence, and the values survive it', () => {
  const hover = rowFailureError({
    kind: 'run',
    row: 1,
    stepOrdinal: 2,
    error: 'x'.repeat(4000),
    values: 'email=a@b.c',
  });
  assert.ok(
    hover.startsWith('Row 1 failed at step 2\n\n`email=a@b.c`\n\n```'),
    'the row and its values come before the fence, so clipping cannot reach them',
  );
  assert.ok(hover.includes('…'), 'the error itself is clipped');
  assert.ok(hover.length < 1200, `still a hover, got ${hover.length} chars`);
});

test('a failed section iteration counts the section’s own steps', () => {
  assert.equal(
    rowFailureError({
      kind: 'section',
      row: 2,
      stepOrdinal: 1,
      stepText: 'Upload file {{file}} as the statement',
      error: 'no file chooser appeared',
    }),
    'Iteration 2 failed at step 1 of the section — "Upload file {{file}} as the statement"\n\n' +
      '```\nno file chooser appeared\n```',
  );
});

test('an unresolvable step ordinal degrades to "failed", never to "step null"', () => {
  const hover = rowFailureError({ kind: 'run', row: 1, stepOrdinal: null, error: 'boom' });
  assert.equal(hover, 'Row 1 failed\n\n```\nboom\n```');
  assert.equal(rowFailureDetail('run', null), 'failed');
});

test('the panel note is the short form of the same fact', () => {
  assert.equal(rowFailureDetail('run', 6), 'failed at step 6');
  // "body step" was jargon: nothing else in TestBench calls a section's steps
  // its body, so a reader who has only seen `### Section` has to guess.
  assert.equal(rowFailureDetail('section', 1), 'failed at step 1 of the section');
});

test('the row the run was cut off in says which kind of ending it was', () => {
  // The ■ is the one mark with no other explanation anywhere — no failure, no
  // skip reason — so it carries its own, and "stopped" is not a synonym for
  // "the run died": telling an author their row was stopped sends them
  // looking for a Stop nobody pressed.
  assert.equal(
    rowStoppedHover('run', 3),
    'Row 3 stopped — the run was stopped while this row was running',
  );
  assert.equal(
    rowStoppedHover('run', 3, { kind: 'ended' }),
    'Row 3 stopped — the run ended while this row was running',
  );
  assert.equal(
    rowStoppedHover('section', 2, { kind: 'stopped' }),
    'Iteration 2 stopped — the run was stopped while this row was running',
  );
});

test('a run that ended on an error did not "stop" the rows it never reached', () => {
  assert.equal(rowSkipDetail({ kind: 'ended' }), 'not run (run ended early)');
  assert.equal(rowSkipHover('run', 4, { kind: 'ended' }), 'Row 4 not run (run ended early)');
});

test('a cancelled prompt stops the rows after it, and says so on the row itself', () => {
  // To the rows it never reached this IS a Stop — the author said "not this
  // run" — so they read the same. The row it happened in gets the real reason,
  // because "the run was stopped" would send them looking for a Stop nobody
  // pressed.
  assert.equal(rowSkipDetail({ kind: 'prompt-cancelled' }), 'not run (stopped)');
  assert.equal(
    rowStoppedHover('run', 2, { kind: 'prompt-cancelled' }),
    'Row 2 stopped — the prompt was cancelled',
  );
});

test('a failure in another FILE names the file, and quotes nothing', () => {
  // `mainFlowOrdinal` and `stepTextAt` read the TEST document at the failure's
  // line, so a skill-body failure on line 12 was reported as "step 2" and
  // quoted as whatever the test's line 12 says — a step this row may never
  // have run.
  assert.equal(rowFailureDetail('run', 2, 'login.md'), 'failed in login.md');
  const hover = rowFailureError({
    kind: 'run',
    row: 3,
    stepOrdinal: null,
    sourceName: 'login.md',
    error: 'locator.click: Timeout 30000ms exceeded',
    values: 'email=a@b.c, password=***',
  });
  assert.match(hover, /^Row 3 failed in login\.md\n/);
  assert.match(hover, /email=a@b\.c/);
  assert.match(hover, /Timeout 30000ms exceeded/);
  assert.equal(rowDetailFromHover(hover), 'failed in login.md');
  // Even handed a step text, it does not quote one: the text came from the
  // wrong file.
  assert.match(
    rowFailureError({
      kind: 'section',
      row: 2,
      stepOrdinal: 1,
      stepText: 'a step of the TEST file',
      sourceName: 'upload.md',
      error: 'boom',
    }),
    /^Iteration 2 failed in upload\.md\n/,
  );
});

test('a row repainted by several run rows says which ones', () => {
  // A section table inside a data-driven run is looped once per run row, so
  // the mark that survives belongs to a run row the reader can no longer see.
  const hover = rowFailureError({ kind: 'section', row: 2, stepOrdinal: 1, error: 'boom' });
  assert.equal(withRunRowsNote(hover, [3, 1]), `${hover}\n\nOn run rows 1, 3.`);
  assert.equal(withRunRowsNote(hover, [2]), `${hover}\n\nOn run row 2.`);
  // Outside a data-driven run there are no run rows to name, and a row with no
  // hover gains nothing to hang the note on.
  assert.equal(withRunRowsNote(hover, []), hover);
  assert.equal(withRunRowsNote(undefined, [1, 2]), undefined);
  // The note goes on the end, so the first line — the one `rowDetailFromHover`
  // reads — is untouched.
  assert.equal(rowDetailFromHover(withRunRowsNote(hover, [1, 2])), 'failed at step 1 of the section');
});

// ---------------------------------------------------------------------------
// Reading the note back out of the hover
// ---------------------------------------------------------------------------

test('the note is recoverable from every hover this module writes', () => {
  const cases = [
    [rowFailureError({ kind: 'run', row: 3, stepOrdinal: 6, stepText: 'Verify it', error: 'boom', values: 'a=b' }), 'failed at step 6'],
    [rowFailureError({ kind: 'section', row: 2, stepOrdinal: 1, error: 'boom' }), 'failed at step 1 of the section'],
    [rowFailureError({ kind: 'run', row: 1, stepOrdinal: null, error: 'boom' }), 'failed'],
    [rowSkipHover('run', 5, { kind: 'stopped' }), 'not run (stopped)'],
    [rowSkipHover('run', 5, { kind: 'paused' }), 'not run (paused)'],
    [rowSkipHover('section', 3, { kind: 'iteration-failed', iteration: 2 }), 'not run (iteration 2 failed)'],
    [rowStoppedHover('run', 3), 'stopped'],
  ];
  for (const [hover, note] of cases) {
    assert.equal(rowDetailFromHover(hover), note, hover.split('\n')[0]);
  }
});

test('text that is not one of ours yields no note', () => {
  assert.equal(rowDetailFromHover(undefined), undefined);
  assert.equal(rowDetailFromHover(''), undefined);
  assert.equal(rowDetailFromHover('This step failed:\n\n```\nboom\n```'), undefined);
});

test('the pick’s detail prefers the hover’s note, and falls back to the status', () => {
  assert.equal(rowLastRunDetail(undefined), undefined, 'a row nobody ran says nothing');
  assert.equal(rowLastRunDetail('pass'), 'last run: passed');
  assert.equal(
    rowLastRunDetail('skip', rowSkipHover('run', 5, { kind: 'stopped' })),
    'last run: not run (stopped)',
  );
  // A `skip` with no hover — state written by an older build — still reads as
  // English rather than as the tracker's own word.
  assert.equal(rowLastRunDetail('skip'), 'last run: not run');
  assert.equal(
    rowLastRunDetail('fail', rowFailureError({ kind: 'run', row: 2, stepOrdinal: 6, error: 'boom' })),
    'last run: failed at step 6',
  );
});

test('a stopped row says so; a paused one says how to run it on its own', () => {
  assert.equal(rowSkipHover('run', 5, { kind: 'stopped' }), 'Row 5 not run (stopped)');
  assert.equal(
    rowSkipHover('run', 5, { kind: 'paused' }),
    'Row 5 not run (paused) — right-click the line number and pick Run This Row ' +
      'to run it on its own',
  );
});

test('a section row skipped by a failed iteration names the iteration that failed', () => {
  assert.equal(
    rowSkipHover('section', 3, { kind: 'iteration-failed', iteration: 2 }),
    'Iteration 3 not run (iteration 2 failed)',
  );
  assert.equal(
    rowSkipDetail({ kind: 'iteration-failed', iteration: 2 }),
    'not run (iteration 2 failed)',
  );
});

test('the panel note and the hover use the same words', () => {
  // Decision 8: the panel, the gutter and the report describe a row the same
  // way. The hover is the note with the row named in front of it.
  for (const reason of [
    { kind: 'stopped' },
    { kind: 'iteration-failed', iteration: 4 },
  ]) {
    assert.ok(rowSkipHover('run', 2, reason).startsWith(`Row 2 ${rowSkipDetail(reason)}`));
  }
});

test('the word for a row depends on the table', () => {
  assert.equal(rowWord('run'), 'row');
  assert.equal(rowWord('section'), 'iteration');
});

// ---------------------------------------------------------------------------
// Status mapping and the worst-of merge
// ---------------------------------------------------------------------------

test('an unmarked row is pending, and pending paints nothing', () => {
  assert.equal(rowStatusFromLineStatus(undefined), 'pending');
  assert.equal(lineStatusFromRowStatus('pending'), null);
});

test('the two mappings round-trip every status a row can wear', () => {
  for (const [line, row] of [
    ['running', 'running'],
    ['pass', 'passed'],
    ['fail', 'failed'],
    ['stopped', 'stopped'],
    ['skip', 'skipped'],
  ]) {
    assert.equal(rowStatusFromLineStatus(line), row);
    assert.equal(lineStatusFromRowStatus(row), line);
  }
});

test('a failure survives a later pass — a green row after a red one is a lie', () => {
  // The rule that keeps a section table honest across the run rows that
  // repaint it: five run rows loop the same three iterations, and the last
  // clean one must not erase iteration 2's ✗ from run row 1.
  assert.equal(worseRowStatus('failed', 'passed'), 'failed');
  assert.equal(worseRowStatus('passed', 'failed'), 'failed');
  assert.equal(worseRowStatus('pending', 'passed'), 'passed');
  assert.equal(worseRowStatus('passed', 'stopped'), 'stopped');
  assert.equal(worseRowStatus('stopped', 'failed'), 'failed');
  assert.equal(worseRowStatus('passed', 'passed'), 'passed');
});

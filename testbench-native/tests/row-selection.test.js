/**
 * Turning a gesture into "these rows, these steps"
 * (stories/data-row-progress-and-selection.md §Running rows).
 *
 * The split feeds three entry points — a selection + F5, the gutter's *Run
 * This Row* and the panel's `runRows` — so it is the one place they can
 * disagree about what the user meant. The wording of the two log lines and the
 * `Rows:` summary is here for the same reason `row-summary-core` is: the
 * Output channel cannot be read back from the extension host.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  allRowsOfTable,
  buildRowPickEntries,
  buildRowsMessage,
  dataRowLinesOf,
  failedRowsFrom,
  rowAtLine,
  rowOutcomeLine,
  rowSelectionRefusal,
  rowValuesText,
  rowsSummaryLine,
  sectionRowsIgnoredLogLine,
  sectionRowsLogLine,
  splitRowSelection,
  stepRangeText,
  stepsPerRowLogLine,
} from '../src/extension/row-selection-core.ts';

const doc = (...lines) => lines.join('\n');

//  1 # Matrix
//  2
//  3 ## Steps
//  4 | email | password |
//  5 |-------|----------|
//  6 | a@b.c | pw1      |
//  7 | d@e.f | pw2      |
//  8 | g@h.i | pw3      |
//  9
// 10 1. Enter {{email}}
// 11 2. Enter {{password}}
// 12 3. Upload each statement
// 13
// 14 ### Upload each statement
// 15 | file  |
// 16 |-------|
// 17 | a.png |
// 18 | b.png |
// 19 1. Upload {{file}}
const BOTH = doc(
  '# Matrix',
  '',
  '## Steps',
  '| email | password |',
  '|-------|----------|',
  '| a@b.c | pw1      |',
  '| d@e.f | pw2      |',
  '| g@h.i | pw3      |',
  '',
  '1. Enter {{email}}',
  '2. Enter {{password}}',
  '3. Upload each statement',
  '',
  '### Upload each statement',
  '| file  |',
  '|-------|',
  '| a.png |',
  '| b.png |',
  '1. Upload {{file}}',
);

const PLAIN = doc('# Plain', '', '## Steps', '1. Do a thing', '2. Do another');

// ---------------------------------------------------------------------------
// splitRowSelection
// ---------------------------------------------------------------------------

test('▷ Run all rows resolves against the document, not the panel’s numbers', () => {
  // The button names the TABLE, and this is what the host turns that into.
  // The panel's own list came from a `rows` message that may predate an edit,
  // so a row added since would be the one row "run all rows" left out.
  assert.deepEqual(allRowsOfTable(BOTH, null), [1, 2, 3]);
  assert.deepEqual(allRowsOfTable(BOTH, 'Upload each statement'), [1, 2]);
  // No such table — the caller reports it rather than sending an empty list,
  // which is not a narrowing and would run the whole file.
  assert.deepEqual(allRowsOfTable(PLAIN, null), []);
  assert.deepEqual(allRowsOfTable(BOTH, 'No such section'), []);
});

test('split: rows only — no step lines, so every step runs for those rows', () => {
  assert.deepEqual(splitRowSelection(BOTH, [6, 7]), { lines: [], rows: [1, 2] });
});

test('split: section rows only, keyed by the name as authored', () => {
  assert.deepEqual(splitRowSelection(BOTH, [18]), {
    lines: [],
    sectionRows: { 'Upload each statement': [2] },
  });
});

test('split: steps only leaves both row axes alone', () => {
  // An axis with nothing selected means all of that axis (decision 3), which
  // on the wire is an ABSENT key, never an empty list.
  assert.deepEqual(splitRowSelection(BOTH, [10, 11]), { lines: [10, 11] });
});

test('split: rows and steps together narrow both axes', () => {
  assert.deepEqual(splitRowSelection(BOTH, [6, 7, 11]), {
    lines: [11],
    rows: [1, 2],
  });
});

test('split: the header alone is no rows selected, so all rows', () => {
  // You cannot select a table and get nothing. The header and the delimiter
  // are not rows, and they are not steps either — they must not survive into
  // `lines`, where `resolveRunSelection` would take them for a run selection.
  assert.deepEqual(splitRowSelection(BOTH, [4]), { lines: [] });
  assert.deepEqual(splitRowSelection(BOTH, [5]), { lines: [] });
  assert.deepEqual(splitRowSelection(BOTH, [4, 5]), { lines: [] });
});

test('split: the whole file means everything, on every axis', () => {
  const all = Array.from({ length: 19 }, (_, i) => i + 1);
  const split = splitRowSelection(BOTH, all);
  assert.deepEqual(split.rows, [1, 2, 3]);
  assert.deepEqual(split.sectionRows, { 'Upload each statement': [1, 2] });
  // Every non-table line, table headers and delimiters dropped.
  assert.ok(split.lines.includes(10));
  assert.ok(!split.lines.includes(4));
  assert.ok(!split.lines.includes(6));
});

test('split: a file with no table is passed through untouched', () => {
  assert.deepEqual(splitRowSelection(PLAIN, [4, 5]), { lines: [4, 5] });
});

test('split: an empty selection stays empty — that is "run everything"', () => {
  assert.deepEqual(splitRowSelection(BOTH, []), { lines: [] });
});

// ---------------------------------------------------------------------------
// rowAtLine / dataRowLinesOf
// ---------------------------------------------------------------------------

test('rowAtLine: names the table and the position, not the line', () => {
  assert.deepEqual(rowAtLine(BOTH, 7), { table: 'run', section: null, row: 2 });
  assert.deepEqual(rowAtLine(BOTH, 17), {
    table: { section: 'Upload each statement' },
    section: 'Upload each statement',
    row: 1,
  });
});

test('rowAtLine: a header, a delimiter and a step are not rows', () => {
  for (const line of [4, 5, 10, 15, 16, 19]) {
    assert.equal(rowAtLine(BOTH, line), null, `line ${line}`);
  }
});

test('dataRowLinesOf: every table’s rows, ascending — the gutter menu key', () => {
  assert.deepEqual(dataRowLinesOf(BOTH), [6, 7, 8, 17, 18]);
  assert.deepEqual(dataRowLinesOf(PLAIN), []);
});

// ---------------------------------------------------------------------------
// rowSelectionRefusal
// ---------------------------------------------------------------------------

test('refusal: rows on a file with no run table', () => {
  const refusal = rowSelectionRefusal(PLAIN, { rows: [1] });
  assert.match(refusal, /no data table under "## Steps"/);
});

test('refusal: a row number past the end of the table names the count', () => {
  const refusal = rowSelectionRefusal(BOTH, { rows: [1, 9] });
  assert.match(refusal, /row 9 is not in the table under "## Steps"/);
  assert.match(refusal, /it has 3 rows/);
});

test('refusal: several bad rows are named in the plural', () => {
  // A drag that overshoots names them all at once, and "row 6, 7 is not in
  // the table" reads as if written for one.
  const refusal = rowSelectionRefusal(BOTH, { rows: [6, 7] });
  assert.match(refusal, /rows 6, 7 are not in the table under "## Steps"/);
});

test('refusal: an unknown section name', () => {
  const refusal = rowSelectionRefusal(BOTH, { sectionRows: { Nope: [1] } });
  assert.match(refusal, /no section "Nope" with a data table/);
});

test('refusal: a section row past the end', () => {
  const refusal = rowSelectionRefusal(BOTH, {
    sectionRows: { 'Upload each statement': [5] },
  });
  assert.match(refusal, /row 5 is not in the table under "### Upload each statement"/);
  assert.match(refusal, /it has 2 rows/);
});

test('refusal: a valid selection is not refused', () => {
  assert.equal(
    rowSelectionRefusal(BOTH, {
      rows: [1, 3],
      sectionRows: { 'Upload each statement': [2] },
    }),
    null,
  );
  assert.equal(rowSelectionRefusal(BOTH, {}), null);
});

// ---------------------------------------------------------------------------
// buildRowPickEntries
// ---------------------------------------------------------------------------

test('pick: a separator per table, then a row per row, with masked values', () => {
  const entries = buildRowPickEntries(BOTH, () => undefined);
  // A section table counts ITERATIONS — the word the gutter, the hovers and
  // the report's badge already use. Two lists of "Row 2" in one pick are two
  // things a reader has to tell apart from their position alone.
  assert.deepEqual(
    entries.map((e) => (e.kind === 'separator' ? `--${e.label}` : e.label)),
    [
      '--Rows',
      'Row 1',
      'Row 2',
      'Row 3',
      '--Rows · Upload each statement',
      'Iteration 1',
      'Iteration 2',
    ],
  );
  // The password column is masked, exactly as the Output banner masks it.
  assert.equal(entries[1].description, 'email=a@b.c, password=***');
  assert.equal(entries[1].table, 'run');
  assert.equal(entries[1].line, 6);
  assert.deepEqual(entries[5].table, { section: 'Upload each statement' });
});

test('pick: the detail says what the row did last time, in the panel’s words', () => {
  const entries = buildRowPickEntries(BOTH, (line) =>
    line === 7
      ? { status: 'skip', hover: 'Row 2 not run (stopped)' }
      : line === 6
        ? { status: 'pass' }
        : undefined,
  );
  const rows = entries.filter((e) => e.kind === 'row');
  assert.equal(rows[0].detail, 'last run: passed');
  // Not the tracker's raw word (`skipped`), which no other surface uses.
  assert.equal(rows[1].detail, 'last run: not run (stopped)');
  assert.equal(rows[2].detail, undefined, 'a row nobody has run says nothing');
});

test('pick: a file with no table yields nothing to pick', () => {
  assert.deepEqual(buildRowPickEntries(PLAIN, () => undefined), []);
});

// ---------------------------------------------------------------------------
// the strings
// ---------------------------------------------------------------------------

test('banner: a contiguous step selection reads as a range', () => {
  assert.equal(stepRangeText([3, 4, 5, 6]), 'steps 3–6');
});

test('banner: a non-contiguous one is listed', () => {
  assert.equal(stepRangeText([5, 2]), 'steps 2, 5');
});

test('banner: one step is singular, and no steps is no parenthesis at all', () => {
  assert.equal(stepRangeText([3]), 'step 3');
  assert.equal(stepRangeText([]), null);
});

test('rows summary: the CLI’s wording, and the optional parts only when there is any', () => {
  assert.equal(
    rowsSummaryLine({ planned: 5, passed: 4, failed: 1, notRun: 0 }),
    'Rows: 5 — 4 passed, 1 failed',
  );
  assert.equal(
    rowsSummaryLine({ planned: 5, passed: 2, failed: 1, notRun: 2 }),
    'Rows: 5 — 2 passed, 1 failed, 2 not run',
  );
  // A subset run counts what it PLANNED — an unselected row was never in it.
  assert.equal(
    rowsSummaryLine({ planned: 2, passed: 2, failed: 0, notRun: 0 }),
    'Rows: 2 — 2 passed, 0 failed',
  );
});

test('rows summary: after a Stop, the parts sum to the planned count', () => {
  // Without the `stopped` part this read `Rows: 5 — 2 passed, 0 failed, 2 not
  // run`, which sums to 4, while the gutter and the panel both said row 3 was
  // stopped. Arithmetic the reader has to notice is a bug in the sentence.
  const line = rowsSummaryLine({ planned: 5, passed: 2, failed: 0, stopped: 1, notRun: 2 });
  assert.equal(line, 'Rows: 5 — 2 passed, 0 failed, 1 stopped, 2 not run');
  const parts = [...line.matchAll(/(\d+) (?:passed|failed|stopped|not run)/g)];
  assert.equal(
    parts.reduce((n, m) => n + Number(m[1]), 0),
    5,
  );
});

test('rows summary: a pause leaves a row that is neither run nor not-run', () => {
  // The parked row's steps are half-executed and a Continue will finish them.
  // Counting it as a pass claimed the test passed with the arrow on step 4;
  // counting it as "not run" claimed its batch never went out. It gets its own
  // part, and the parts still sum to the planned count.
  const line = rowsSummaryLine({ planned: 5, passed: 0, failed: 0, paused: 1, notRun: 4 });
  assert.equal(line, 'Rows: 5 — 0 passed, 0 failed, 1 paused, 4 not run');
  const parts = [...line.matchAll(/(\d+) (?:passed|failed|stopped|paused|not run)/g)];
  assert.equal(
    parts.reduce((n, m) => n + Number(m[1]), 0),
    5,
  );
});

test('rows summary: a row line carries its detail and its duration', () => {
  assert.equal(
    rowOutcomeLine({ row: 1, failed: false, durationMs: 8234 }),
    '  Row 1: passed (8.2s)',
  );
  assert.equal(
    rowOutcomeLine({ row: 3, failed: true, detail: 'failed at step 6', durationMs: 7351 }),
    '  Row 3: failed at step 6 (7.4s)',
  );
  // No duration and no detail — a row that died before the matrix knew.
  assert.equal(rowOutcomeLine({ row: 2, failed: true }), '  Row 2: failed');
  // The row a Stop cut off: it never finished, so it is not judged.
  assert.equal(
    rowOutcomeLine({ row: 3, failed: false, stopped: true, durationMs: 7351 }),
    '  Row 3: stopped (7.4s)',
  );
  // …and the one a pause parked in, which is not judged either.
  assert.equal(
    rowOutcomeLine({ row: 1, failed: false, paused: true, durationMs: 2100 }),
    '  Row 1: paused (2.1s)',
  );
});

test('a step selection over every row says so before the first batch', () => {
  assert.equal(
    stepsPerRowLogLine(1, 5),
    'Running 1 selected step for each of 5 rows — select rows in the table to narrow it',
  );
  assert.equal(
    stepsPerRowLogLine(3, 1),
    'Running 3 selected steps for each of 1 row — select rows in the table to narrow it',
  );
});

test('narrowed section: the line says which rows, of how many, and what it costs', () => {
  // The second half is the point: narrowing changes what the steps AFTER the
  // call find, and the failure three steps later has to read as a consequence.
  assert.equal(
    sectionRowsLogLine('Upload each statement', [2], 3),
    'Upload each statement — running rows 2 of 3; ' +
      'steps after this call will see only those rows',
  );
  assert.equal(
    sectionRowsLogLine('Upload each statement', [2, 3], 3),
    'Upload each statement — running rows 2, 3 of 3; ' +
      'steps after this call will see only those rows',
  );
});

test('narrowed section: a call outside the selected steps is logged, not refused', () => {
  // Named in the reader's terms — which rows were dropped, and what they would
  // have to change — rather than in the code's ("call not in the selected
  // steps").
  assert.equal(
    sectionRowsIgnoredLogLine('Upload each statement', [2, 3]),
    'Upload each statement — rows 2, 3 ignored: ' +
      'the step that calls this section is not in your selection',
  );
});

test('values text: the same masking every surface shows', () => {
  assert.equal(rowValuesText({ email: 'a@b.c', password: 'pw' }), 'email=a@b.c, password=**');
});

// ---------------------------------------------------------------------------
// The matrix a file has before anybody runs it
// ---------------------------------------------------------------------------

test('rows message: every table, every row, pending until something runs', () => {
  const msg = buildRowsMessage('file:///m.md', BOTH, () => undefined);
  assert.equal(msg.type, 'rows');
  assert.equal(msg.uri, 'file:///m.md');
  assert.deepEqual(
    msg.tables.map((t) => [t.table, t.headerLine, t.rows.map((r) => [r.row, r.line, r.status])]),
    [
      ['run', 4, [[1, 6, 'pending'], [2, 7, 'pending'], [3, 8, 'pending']]],
      [{ section: 'Upload each statement' }, 15, [[1, 17, 'pending'], [2, 18, 'pending']]],
    ],
  );
  assert.equal(msg.tables[0].rows[0].values, 'email=a@b.c, password=***');
});

test('rows message: a reload’s persisted marks come back with their notes', () => {
  // The marks persist and the message that described them did not, which is
  // why the panel's Rows section used to empty itself on a window reload.
  const msg = buildRowsMessage('file:///m.md', BOTH, (line) =>
    line === 7 ? { status: 'fail', hover: 'Row 2 failed at step 6 — "Enter it"' } : undefined,
  );
  const row = msg.tables[0].rows[1];
  assert.equal(row.status, 'failed');
  assert.equal(row.detail, 'failed at step 6', 'the note is read back out of the hover');
  assert.equal(row.hover, 'Row 2 failed at step 6 — "Enter it"');
  assert.equal(row.durationMs, undefined, 'nothing persists a duration');
});

test('rows message: a file with no table has no matrix at all', () => {
  assert.equal(buildRowsMessage('file:///p.md', PLAIN, () => undefined), null);
});

// ---------------------------------------------------------------------------
// Which rows are red
// ---------------------------------------------------------------------------

test('failed rows: read off the gutter, per table, ascending', () => {
  const failed = failedRowsFrom(BOTH, (line) =>
    line === 6 || line === 8 ? 'fail' : line === 18 ? 'fail' : line === 7 ? 'pass' : undefined,
  );
  assert.deepEqual(failed, {
    rows: [1, 3],
    sectionRows: { 'Upload each statement': [2] },
  });
});

test('failed rows: nothing red is null, so nothing offers a re-run', () => {
  assert.equal(failedRowsFrom(BOTH, () => 'pass'), null);
  assert.equal(failedRowsFrom(BOTH, () => undefined), null);
  assert.equal(failedRowsFrom(PLAIN, () => 'fail'), null, 'no table, no rows');
});

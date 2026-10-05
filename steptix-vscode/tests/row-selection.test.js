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
  bodyStepsText,
  buildRowPickEntries,
  calledSectionNames,
  chainMembersKeptLogLine,
  buildRowsMessage,
  failedRowsFrom,
  oldServerBodyStepsWarning,
  rowAtLine,
  rowOutcomeLine,
  rowSelectionRefusal,
  rowValuesText,
  rowsSummaryLine,
  sectionRowsIgnoredLogLine,
  sectionRowsLogLine,
  sectionRowsResumedLogLine,
  sectionStepsIgnoredLogLine,
  sectionStepsLogLine,
  sectionStepsResumedLogLine,
  splitBodySteps,
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
// splitBodySteps — the sibling axis: which BODY STEPS of a section run
// ---------------------------------------------------------------------------

//  1 # Login
//  2
//  3 ## Steps
//  4 1. Navigate to the baseUrl
//  5 2. Reject non-essential cookies in the cookie banner
//  6 3. Log In
//  7
//  8 ### Log In
//  9 | email | password |
// 10 |-------|----------|
// 11 | demo  | pw1      |
// 12 | nobody| pw2      |
// 13 1. Enter the email {{email}}
// 14 2. Enter the password {{password}}
const LOGIN = doc(
  '# Login',
  '',
  '## Steps',
  '1. Navigate to the baseUrl',
  '2. Reject non-essential cookies in the cookie banner',
  '3. Log In',
  '',
  '### Log In',
  '| email | password |',
  '|-------|----------|',
  '| demo  | pw1      |',
  '| nobody| pw2      |',
  '1. Enter the email {{email}}',
  '2. Enter the password {{password}}',
);

/** The main flow of LOGIN, as `classifySelectedSteps` would hand it over. */
const MAIN_FLOW = [
  'Navigate to the baseUrl',
  'Reject non-essential cookies in the cookie banner',
  'Log In',
];

test('body split: the reported gesture — three steps, one body step, one row', () => {
  // Lines 4-6 are the main flow, 14 is body step 2. The row (line 12) is
  // `splitRowSelection`'s business and never reaches here.
  const { narrowed, ignored } = splitBodySteps(LOGIN, [4, 5, 6, 12, 14], MAIN_FLOW);
  assert.deepEqual(ignored, []);
  assert.deepEqual(narrowed, [
    {
      section: 'Log In',
      indices: [1],
      ordinals: [2],
      total: 2,
      addedForChain: [],
      everyCall: false,
    },
  ]);
});

test('body split: the call has to be among the steps that will run', () => {
  // A drag that stopped a line short of `3. Log In`. Ignored and said out
  // loud, not refused: the body will not be entered at all, so there is
  // nothing for the narrowing to narrow.
  const { narrowed, ignored } = splitBodySteps(LOGIN, [4, 5, 14], MAIN_FLOW.slice(0, 2));
  assert.deepEqual(narrowed, []);
  assert.deepEqual(ignored, [
    {
      section: 'Log In',
      indices: [1],
      ordinals: [2],
      total: 2,
      addedForChain: [],
      everyCall: false,
    },
  ]);
});

test('body split: the call is matched by matchText, so case does not matter', () => {
  // The same rule the server expands by. A step written `LOG IN` and the
  // heading `### Log In` are one call, and the two must not disagree.
  const { narrowed } = splitBodySteps(LOGIN, [6, 14], ['LOG IN']);
  assert.deepEqual(narrowed.map((p) => p.section), ['Log In']);
});

test('body split: selecting the WHOLE body is not a narrowing', () => {
  // Which is what a drag over the file looks like. Shipping `runSteps` for it
  // would put a line in the log saying the run was narrowed to everything.
  assert.deepEqual(splitBodySteps(LOGIN, [4, 5, 6, 13, 14], MAIN_FLOW), {
    narrowed: [],
    ignored: [],
  });
});

test('body split: no body lines, or none at all, narrows nothing', () => {
  assert.deepEqual(splitBodySteps(LOGIN, [4, 5, 6], MAIN_FLOW), {
    narrowed: [],
    ignored: [],
  });
  assert.deepEqual(splitBodySteps(LOGIN, [], MAIN_FLOW), { narrowed: [], ignored: [] });
  assert.deepEqual(splitBodySteps(PLAIN, [4], ['Do a thing']), {
    narrowed: [],
    ignored: [],
  });
});

test('body split: two sections are two independent answers', () => {
  //  7 ### Alpha   8 1. a1   9 2. a2  |  11 ### Beta  12 1. b1  13 2. b2
  const two = doc(
    '# Two',
    '',
    '## Steps',
    '1. Alpha',
    '2. Beta',
    '',
    '### Alpha',
    '1. a1',
    '2. a2',
    '',
    '### Beta',
    '1. b1',
    '2. b2',
  );
  const { narrowed, ignored } = splitBodySteps(two, [4, 8, 12], ['Alpha']);
  // Alpha's call runs, Beta's does not — so one narrows and one is dropped.
  assert.deepEqual(narrowed, [
    {
      section: 'Alpha',
      indices: [0],
      ordinals: [1],
      total: 2,
      addedForChain: [],
      everyCall: false,
    },
  ]);
  assert.deepEqual(ignored, [
    {
      section: 'Beta',
      indices: [0],
      ordinals: [1],
      total: 2,
      addedForChain: [],
      everyCall: false,
    },
  ]);
});

// ---------------------------------------------------------------------------
// Which sections a run actually ENTERS — the three calls the naive test misses
// ---------------------------------------------------------------------------

test('body split: a call in a control line TAIL is still a call', () => {
  // `If the user is signed out, then Log In` — the whole line is not the
  // section's name, the tail is, and the server resolves the tail as a call.
  // Reading only the whole line told the author their narrowing was ignored
  // while the server honoured it.
  const { narrowed, ignored } = splitBodySteps(LOGIN, [6, 14], [
    'If the user is signed out, then Log In',
  ]);
  assert.deepEqual(ignored, []);
  assert.deepEqual(narrowed.map((p) => [p.section, p.indices]), [['Log In', [1]]]);
});

test('body split: a NESTED call is reached through the section that makes it', () => {
  //  4 1. Outer | 6 ### Outer  7 1. Inner | 9 ### Inner  10 1. i1  11 2. i2
  const nested = doc(
    '# Nested',
    '',
    '## Steps',
    '1. Outer',
    '',
    '### Outer',
    '1. Inner',
    '',
    '### Inner',
    '1. i1',
    '2. i2',
  );
  // Only `Outer` is a main-flow step, but `Inner`'s frame is entered all the
  // same — so narrowing its body is something this run can honour.
  const { narrowed, ignored } = splitBodySteps(nested, [4, 11], ['Outer']);
  assert.deepEqual(ignored, []);
  assert.deepEqual(narrowed.map((p) => [p.section, p.indices]), [['Inner', [1]]]);
});

test('body split: one section called twice says so, once', () => {
  //  4 1. Log In  5 2. Something else  6 3. Log In
  const twice = doc(
    '# Twice',
    '',
    '## Steps',
    '1. Log In',
    '2. Something else',
    '3. Log In',
    '',
    '### Log In',
    '1. Enter the email',
    '2. Enter the password',
  );
  // `runSteps` rides the section DEFINITION, so the narrowing cannot be
  // aimed at one of the two calls. `everyCall` is what lets the log say so.
  const { narrowed } = splitBodySteps(twice, [4, 5, 6, 10], [
    'Log In',
    'Something else',
    'Log In',
  ]);
  assert.deepEqual(narrowed.map((p) => [p.section, p.indices, p.everyCall]), [
    ['Log In', [1], true],
  ]);
});

test('body split: a call in a loop guard’s TAIL is never "exactly once"', () => {
  //  4 1. While the banner is shown, Log In
  const looped = doc(
    '# Looped',
    '',
    '## Steps',
    '1. While the banner is shown, Log In',
    '',
    '### Log In',
    '1. Enter the email',
    '2. Enter the password',
  );
  // ONE call site, and the old counter therefore dropped the qualifier — but
  // the section is entered once per turn of the loop, so the narrowing hits
  // every one of them. A count cannot be honest here; "every call" can.
  const { narrowed } = splitBodySteps(looped, [4, 8], [
    'While the banner is shown, Log In',
  ]);
  assert.deepEqual(narrowed.map((p) => [p.section, p.everyCall]), [['Log In', true]]);
});

test('body split: a NESTED call is never "exactly once" either', () => {
  //  4 1. Outer | 6 ### Outer  7 1. Inner  8 2. o2 | 10 ### Inner  11 1. i1  12 2. i2
  const nested = doc(
    '# Nested',
    '',
    '## Steps',
    '1. Outer',
    '',
    '### Outer',
    '1. Inner',
    '2. o2',
    '',
    '### Inner',
    '1. i1',
    '2. i2',
  );
  // `Outer` may itself loop over a table, or gain a second caller tomorrow;
  // the frame count of a call made from inside a body is not a property of
  // this text. `Outer` itself, called plainly once, keeps the plain wording.
  const { narrowed } = splitBodySteps(nested, [4, 7, 12], ['Outer']);
  assert.deepEqual(
    narrowed.map((p) => [p.section, p.everyCall]).sort(),
    [['Inner', true], ['Outer', false]].sort(),
  );
});

test('called sections: the whole line wins, and the tail is not also counted', () => {
  // Two sections, one named like a control line. `While waiting, click Next`
  // resolves as a section call in its own right — the expander tries the whole
  // line FIRST — so the tail is never read, and `click Next` is never entered.
  // Counting both marked `click Next` called: its narrowing was reported as
  // applied, `runSteps` shipped for it, and the old-server warning was armed
  // for body lines that cannot fire.
  const twoSections = doc(
    '# Ambiguous',
    '',
    '## Steps',
    '1. While waiting, click Next',
    '',
    '### While waiting, click Next',
    '1. w1',
    '2. w2',
    '',
    '### click Next',
    '1. c1',
    '2. c2',
  );
  const called = calledSectionNames(twoSections, ['While waiting, click Next']);
  assert.deepEqual([...called.keys()], ['while waiting, click next']);
  // …and the body narrowing follows: the section that never runs is `ignored`.
  const { narrowed, ignored } = splitBodySteps(twoSections, [4, 8, 12], [
    'While waiting, click Next',
  ]);
  assert.deepEqual(narrowed.map((p) => p.section), ['While waiting, click Next']);
  assert.deepEqual(ignored.map((p) => p.section), ['click Next']);
});

test('called sections: a tail IS read when the whole line is not a section', () => {
  // The guard that keeps the fix above from being a regression: with no
  // `### While waiting, click Next` to claim the line, the tail is the call.
  const tailOnly = doc(
    '# Tail',
    '',
    '## Steps',
    '1. While waiting, click Next',
    '',
    '### click Next',
    '1. c1',
    '2. c2',
  );
  const called = calledSectionNames(tailOnly, ['While waiting, click Next']);
  assert.deepEqual([...called.keys()], ['click next']);
  assert.equal(called.get('click next').onceFromMainFlow, false);
});

// ---------------------------------------------------------------------------
// A chain is one decision: half of it is not a smaller version of it
// ---------------------------------------------------------------------------

//  4 1. Log In | 6 ### Log In  7 If …  8 Otherwise …  9 Type …  10 Submit
const CHAIN = doc(
  '# Chain',
  '',
  '## Steps',
  '1. Log In',
  '',
  '### Log In',
  '1. If a banner is shown, then Dismiss the banner',
  '2. Otherwise, Click Sign in',
  '3. Type the password',
  '4. Submit the form',
);

test('body split: an Otherwise brings its If with it', () => {
  // Selecting lines 8 and 9 alone would ship `runSteps: [1, 2]`, and the
  // server's expander refuses that body — `"Otherwise, Click Sign in" has no
  // decision to be the alternative of` — blaming a file that is fine.
  const { narrowed } = splitBodySteps(CHAIN, [4, 8, 9], ['Log In']);
  assert.deepEqual(narrowed, [
    {
      section: 'Log In',
      indices: [0, 1, 2],
      ordinals: [1, 2, 3],
      total: 4,
      addedForChain: [1],
      everyCall: false,
      chainLink: { member: 'Otherwise', needs: 'If' },
    },
  ]);
});

test('body split: growing a chain can stop the selection being a narrowing', () => {
  // Steps 2 and 3 of three, plus the `If` step 2 needs, is the whole body —
  // and a narrowing to everything is not one.
  const twoMember = doc(
    '# Chain',
    '',
    '## Steps',
    '1. Log In',
    '',
    '### Log In',
    '1. If a banner is shown, then Dismiss the banner',
    '2. Otherwise, Click Sign in',
  );
  assert.deepEqual(splitBodySteps(twoMember, [4, 8], ['Log In']), {
    narrowed: [],
    ignored: [],
  });
});

test('body split: an If selected without its Otherwise stays as picked', () => {
  // The rule is one-directional: a decision with no alternative is a legal
  // chain of one, so nothing is added and step 2 really does not run.
  const { narrowed } = splitBodySteps(CHAIN, [4, 7], ['Log In']);
  assert.deepEqual(narrowed.map((p) => [p.indices, p.addedForChain]), [[[0], []]]);
});

test('body split: a whole chain of three unwinds in one pass', () => {
  //  7 If … 8 Else if … 9 Otherwise … 10 Type
  const long = doc(
    '# Chain',
    '',
    '## Steps',
    '1. Log In',
    '',
    '### Log In',
    '1. If a banner is shown, then Dismiss the banner',
    '2. Else if a dialog is shown, then Close the dialog',
    '3. Otherwise, Click Sign in',
    '4. Type the password',
  );
  const { narrowed } = splitBodySteps(long, [4, 9], ['Log In']);
  assert.deepEqual(narrowed.map((p) => [p.indices, p.addedForChain]), [
    [[0, 1, 2], [1, 2]],
  ]);
});

// ---------------------------------------------------------------------------
// rowAtLine
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

test('narrowed body: the line says which body steps, of how many', () => {
  // The sibling of the rows line, in the same voice. Always plural — this
  // names positions in a list, and "step 2 of 2" reads as a progress counter.
  assert.equal(sectionStepsLogLine('Log In', [2], 2), 'Log In — running body steps 2 of 2');
  assert.equal(sectionStepsLogLine('Log In', [1, 3], 3), 'Log In — running body steps 1, 3 of 3');
  assert.equal(sectionStepsLogLine('Log In', [2, 3], 4), 'Log In — running body steps 2–3 of 4');
});

test('narrowed body: a contiguous run is a range, a gapped one is a list', () => {
  // An Alt+click pick of body steps 1 and 3 must not read as if 2 ran too.
  assert.equal(bodyStepsText([2]), 'steps 2');
  assert.equal(bodyStepsText([1, 2, 3]), 'steps 1–3');
  assert.equal(bodyStepsText([3, 1]), 'steps 1, 3');
  assert.equal(bodyStepsText([2, 2, 3]), 'steps 2–3');
});

test('narrowed body: a call outside the selected steps is logged, not refused', () => {
  assert.equal(
    sectionStepsIgnoredLogLine('Log In', [2]),
    'Log In — body steps 2 ignored: ' +
      'the step that calls this section is not in your selection',
  );
});

test('narrowed body: a section reached more than once says the narrowing hits every call', () => {
  // The wire cannot express "this call only" — `runSteps` rides the section
  // definition — so the line says what it actually does. Deliberately NOT a
  // number: the count that used to be here counted call SITES, and a section
  // called from a loop guard's tail or from a looped parent has one site and
  // any number of frames.
  assert.equal(
    sectionStepsLogLine('Log In', [2], 2, true),
    'Log In — running body steps 2 of 2 (applies to every call of this section)',
  );
  // Called exactly once, from a plain main-flow step: no parenthesis.
  assert.equal(sectionStepsLogLine('Log In', [2], 2, false), 'Log In — running body steps 2 of 2');
});

test('narrowed body: a chain kept whole quotes the pair the author wrote', () => {
  assert.equal(
    chainMembersKeptLogLine('Log In', [1], [2], { member: 'Otherwise', needs: 'If' }),
    'Log In — body step 1 kept with 2: an Otherwise needs its If',
  );
  // An `Else if` selected without its `If` is a different sentence, and the
  // fixed wording described a line the author had not written.
  assert.equal(
    chainMembersKeptLogLine('Log In', [1], [2], { member: 'Else if', needs: 'If' }),
    'Log In — body step 1 kept with 2: an Else if needs its If',
  );
  // …and a three-member chain: the link the selection actually broke.
  assert.equal(
    chainMembersKeptLogLine('Log In', [1, 2], [3], { member: 'Otherwise', needs: 'Else if' }),
    'Log In — body steps 1, 2 kept with 3: an Otherwise needs its Else if',
  );
});

test('narrowed body: the chain link is read off the file, member by member', () => {
  //  4 1. Log In | 6 ### Log In | 7 1. If … | 8 2. Else if … | 9 3. Otherwise …
  const chain = doc(
    '# Chain',
    '',
    '## Steps',
    '1. Log In',
    '',
    '### Log In',
    '1. If a banner is shown, then Dismiss it',
    '2. Else if a dialog is shown, then Close it',
    '3. Otherwise, Click Sign in',
    '4. Submit the form',
  );
  // Selecting only the `Otherwise` grows twice; the link the author can see is
  // the one their own selection broke.
  const { narrowed } = splitBodySteps(chain, [4, 9], ['Log In']);
  assert.deepEqual(narrowed[0].addedForChain, [1, 2]);
  assert.deepEqual(narrowed[0].chainLink, { member: 'Otherwise', needs: 'Else if' });
  // Selecting the `Else if` grows once, and says so in its own words.
  const elseIf = splitBodySteps(chain, [4, 8], ['Log In']).narrowed[0];
  assert.deepEqual(elseIf.addedForChain, [1]);
  assert.deepEqual(elseIf.chainLink, { member: 'Else if', needs: 'If' });
  // Nothing added, nothing to explain.
  assert.equal(splitBodySteps(chain, [4, 7], ['Log In']).narrowed[0].chainLink, undefined);
});

test('narrowed body: a continuation says the narrowing still applies', () => {
  // A Continue is its own run with its own log, and it rebuilds its lines from
  // the pause point — so without this the narrowing is invisible after a
  // breakpoint and reads as one that expired there.
  assert.equal(
    sectionStepsResumedLogLine('Log In', [2], 2),
    'Log In — the narrowing still applies: body steps 2 of 2',
  );
  // Including the qualifier: the continuation is where the second call of a
  // twice-called section usually happens, so this is the copy that most needs
  // to carry it.
  assert.equal(
    sectionStepsResumedLogLine('Log In', [2], 2, true),
    'Log In — the narrowing still applies: body steps 2 of 2 ' +
      '(applies to every call of this section)',
  );
});

test('narrowed section: a continuation says the ROW narrowing still applies too', () => {
  // A Continue inherits the row narrowing as well, and for the same reason.
  assert.equal(
    sectionRowsResumedLogLine('Upload each statement', [2], 3),
    'Upload each statement — the narrowing still applies: rows 2 of 3',
  );
  assert.equal(
    sectionRowsResumedLogLine('Upload each statement', [2, 3], 3),
    'Upload each statement — the narrowing still applies: rows 2, 3 of 3',
  );
});

test('narrowed body: a server that ignored runSteps is named once', () => {
  assert.equal(
    oldServerBodyStepsWarning('Log In'),
    'Log In — the server ran the whole section body; restart or update the ' +
      'Sessions API server so a selection can narrow it',
  );
});

test('values text: the same masking every surface shows', () => {
  assert.equal(rowValuesText({ email: 'a@b.c', password: 'pw' }), 'email=a@b.c, password=**');
});

// A data file's headings are words a person typed, dots included, so the whole
// key takes the AUTHOR rule — the same `redactAuthoredMap` the report's matrix
// gives these cells. Splitting `user.apikey` at the dot and asking the narrow
// record rule about `apikey` answered no, so this text (the Run Rows pick, the
// gutter hover, the Output banner) printed `uk_live_1234` beside a report cell
// reading `***`. The pre-feature client starred it.
test('values text: a dotted COLUMN is still the author’s word, whole', () => {
  for (const column of ['user.apikey', 'user.apitoken', 'row.mypassword', 'login.passkey', 'api.key']) {
    assert.equal(
      rowValuesText({ [column]: 'uk_live_1234' }),
      `${column}=********`,
      column,
    );
  }
});

test('values text: an ordinary dotted column still reads', () => {
  // The author rule is a substring rule, not a rule that masks every dot.
  assert.equal(rowValuesText({ 'user.email': 'a@b.c' }), 'user.email=a@b.c');
  assert.equal(rowValuesText({ 'payment.payee': 'Alinta' }), 'payment.payee=Alinta');
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

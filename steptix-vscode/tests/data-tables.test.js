/**
 * Which lines of a data table the decoration pass touches
 * (stories/data-row-progress-and-selection.md §"Which lines").
 *
 * Two different questions, and getting them confused is what broke the
 * alignment of every data-driven file: which lines take a STATUS (the data
 * rows, and only those — a ✓ on a header would read as "the table passed"),
 * and which lines RESERVE the status cell (those, plus the header and the
 * `|---|` delimiter). The cell is a 1.2em `before` attachment, so a line that
 * has one is indented relative to a line that has not, and giving it to the
 * rows alone pushed every row right while the header stayed put.
 *
 * A decoration's geometry cannot be read back from the extension host, so if
 * this suite does not pin the two sets, nothing does.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  alignmentLinesOf,
  dataTableScanCount,
  dataTablesOf,
} from '../src/extension/data-tables-core.ts';

const doc = (...lines) => lines.join('\n');

//  1 # Matrix
//  2
//  3 ## Steps
//  4 | email | password |
//  5 |-------|----------|
//  6 | a@b.c | pw1      |
//  7 | d@e.f | pw2      |
//  8
//  9 1. Enter {{email}}
// 10 2. Upload each statement
// 11
// 12 ### Upload each statement
// 13 | file  |
// 14 |-------|
// 15 | a.png |
// 16 1. Upload {{file}}
const BOTH = doc(
  '# Matrix',
  '',
  '## Steps',
  '| email | password |',
  '|-------|----------|',
  '| a@b.c | pw1      |',
  '| d@e.f | pw2      |',
  '',
  '1. Enter {{email}}',
  '2. Upload each statement',
  '',
  '### Upload each statement',
  '| file  |',
  '|-------|',
  '| a.png |',
  '1. Upload {{file}}',
);

const PLAIN = doc('# Plain', '', '## Steps', '1. Do a thing');

const HALF_WRITTEN = doc(
  '# Bad',
  '',
  '## Steps',
  '| email | password |',
  '|-------|----------|',
  '| only-one-cell |',
  '',
  '1. Enter {{email}}',
);

test('every table is found: the run table first, then each section’s', () => {
  // Exact row lines: each header and its delimiter (4/5, 13/14) are not rows,
  // so they never take a status.
  assert.deepEqual(
    dataTablesOf(BOTH).map((t) => [t.kind, t.section, t.headerLine, t.rowLines]),
    [
      ['run', null, 4, [6, 7]],
      ['section', 'Upload each statement', 13, [15]],
    ],
  );
});

test('the header and delimiter DO reserve the same invisible cell, or the pipes stop lining up', () => {
  // The bug this pins: rows get a 1.2em `before` and the header does not, so
  // every data row is indented relative to its own header, in every
  // data-driven file, run or not.
  assert.deepEqual(alignmentLinesOf(dataTablesOf(BOTH)), [4, 5, 13, 14]);
});

test('a file with no table reserves nothing and paints nothing', () => {
  assert.deepEqual(dataTablesOf(PLAIN), []);
  assert.deepEqual(alignmentLinesOf(dataTablesOf(PLAIN)), []);
});

test('a half-written table yields nothing rather than throwing', () => {
  // The run reports the parse error; a decoration pass that threw would take
  // the step marks down with it.
  assert.deepEqual(dataTablesOf(HALF_WRITTEN), []);
});

test('the same text is scanned once, however many callers ask', () => {
  // Every tracker emit — one per caret move — asks for these lines for the
  // decorations, for the run-state signature and (since the selection guard
  // needs to know which lines are runnable) for the selection too. Each ask
  // was two full parses of the file.
  const text = BOTH + '\n'; // a text this suite has not scanned yet
  const before = dataTableScanCount();
  const first = dataTablesOf(text);
  assert.equal(dataTableScanCount(), before + 1, 'the first ask scans');
  assert.equal(dataTablesOf(text), first, 'the second gets the same answer back');
  assert.equal(dataTableScanCount(), before + 1, '…without scanning again');

  // Edit the file and it misses, which is the whole safety of keying on the
  // text: there is no version to forget to bump.
  dataTablesOf(text + '\n1. And another step');
  assert.equal(dataTableScanCount(), before + 2);
});

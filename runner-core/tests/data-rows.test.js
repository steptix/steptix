import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parseDataRows,
  parseSectionDataRows,
  scanSectionDataTables,
  splitTableRow,
} from '../dist/data-rows.js';

/**
 * The client-side read of a data table (stories/data-driven-rows.md, part A).
 *
 * On the TestBench path this is the ONLY side that reads the table — the
 * server is handed already-extracted `steps` and never sees the file — so
 * these shapes have to be refused here as well as in `src/parser/data-rows.ts`.
 * The corpus below is deliberately the same set of cases as the server suite's
 * (`tests/parser.test.ts`, "data rows under ## Steps"); if one side stops
 * agreeing, one of the two files fails.
 */

const table = (body) => `# Matrix\n\n## Steps\n${body}\n1. Go\n2. Stop\n`;

test('reads a table above the steps', () => {
  const scan = parseDataRows(
    table('| email | password |\n|-------|----------|\n| a@b.c | pw1 |\n| | pw2 |\n\n'),
  );
  assert.deepEqual(scan.rows, [
    { email: 'a@b.c', password: 'pw1' },
    { email: '', password: 'pw2' },
  ]);
  assert.deepEqual(scan.columns, ['email', 'password']);
  assert.equal(scan.headerLine, 4);
  assert.deepEqual(scan.rowLines, [6, 7]);
});

test('returns null when the file has no table', () => {
  assert.equal(parseDataRows('# T\n\n## Steps\nProse is fine alone.\n\n1. Go\n'), null);
});

test('returns null when there is no Steps heading at all', () => {
  assert.equal(parseDataRows('# T\n\nJust prose.\n'), null);
});

test('ignores a pipe inside frontmatter', () => {
  const md = '---\ntags: [a]\ndesc: "a | b"\n---\n\n# T\n\n## Steps\n1. Go\n';
  assert.equal(parseDataRows(md), null);
});

test('is not recognised under a depth-3 Steps heading', () => {
  // Sections are gated the same way: under `### Steps` a `###` closes the span.
  const md = '# T\n\n### Steps\n| a |\n|---|\n| 1 |\n\n1. Go\n';
  assert.equal(parseDataRows(md), null);
});

test('allows blank lines and HTML comments before the table', () => {
  const scan = parseDataRows(table('\n<!-- why these rows -->\n| a |\n|---|\n| 1 |\n\n'));
  assert.deepEqual(scan.rows, [{ a: '1' }]);
});

test('honours an escaped pipe, and backticks do not protect one', () => {
  const scan = parseDataRows(table('| a | b |\n|---|---|\n| x \\| y | z |\n\n'));
  assert.deepEqual(scan.rows, [{ a: 'x | y', b: 'z' }]);
  assert.deepEqual(splitTableRow('| `x|y` | z |'), ['`x', 'y`', 'z']);
});

for (const [label, body, pattern] of [
  ['a ragged row', '| a | b |\n|---|---|\n| 1 |\n\n', /Ragged row/],
  ['a non-identifier column', '| first name |\n|---|\n| x |\n\n', /Invalid column name/],
  ['a duplicate column', '| a | a |\n|---|---|\n| 1 | 2 |\n\n', /Duplicate column/],
  ['a header with no rows', '| a |\n|---|\n\n', /has no rows/],
  ['a placeholder cell', '| a |\n|---|\n| {{x}} |\n\n', /\{\{placeholder\}\}/],
  ['a second table', '| a |\n|---|\n| 1 |\n\n| b |\n|---|\n| 2 |\n\n', /Second table/],
]) {
  test(`refuses ${label}`, () => {
    assert.throws(() => parseDataRows(table(body)), pattern);
  });
}

test('refuses a table after the first step', () => {
  // Markdown folds it into the step above, so there is no table token at all —
  // the raw scan is the only side that can refuse it.
  assert.throws(
    () => parseDataRows('# T\n\n## Steps\n1. Go\n\n| a |\n|---|\n| 1 |\n'),
    /comes after a step/,
  );
});

test('refuses prose between the heading and the table', () => {
  assert.throws(
    () => parseDataRows('# T\n\n## Steps\nWords.\n\n| a |\n|---|\n| 1 |\n\n1. Go\n'),
    /comes after prose/,
  );
});

test('refuses an indented table, which markdown reads as a code block', () => {
  assert.throws(
    () => parseDataRows('# T\n\n## Steps\n    | a |\n    |---|\n    | 1 |\n\n1. Go\n'),
    /indented/,
  );
});

test('reports the buffer name in errors so a diagnostic can point at it', () => {
  assert.throws(() => parseDataRows(table('| a | b |\n|---|---|\n| 1 |\n\n'), 'matrix.md'), /matrix\.md:6/);
});

/**
 * `scanSectionDataTables` — the full scan per section, which TestBench needs
 * to PAINT a section table (headerLine for the summary, rowLines for the
 * marks). `parseSectionDataRows` is a projection of it, so every case here
 * also asserts the two agree; a second, drifting scan is exactly what the
 * projection exists to prevent.
 */

const sectioned = [
  '# Upload',
  '',
  '## Steps',
  '',
  '1. Sign in',
  '2. [section: Upload each statement]',
  '3. Check the count',
  '',
  '### Upload each statement',
  '| file | label |',
  '|------|-------|',
  '| a.pdf | Jan |',
  '| b.pdf | Feb |',
  '',
  '1. Upload {{file}}',
  '',
  '### No table here',
  '',
  '1. Do a thing',
  '',
].join('\n');

test('scanSectionDataTables: keys by section name and reports header + row lines', () => {
  const scans = scanSectionDataTables(sectioned);
  assert.deepEqual([...scans.keys()], ['Upload each statement']);
  const scan = scans.get('Upload each statement');
  assert.equal(scan.headerLine, 10);
  assert.deepEqual(scan.rowLines, [12, 13]);
  assert.deepEqual(scan.columns, ['file', 'label']);
  assert.deepEqual(scan.rows, [
    { file: 'a.pdf', label: 'Jan' },
    { file: 'b.pdf', label: 'Feb' },
  ]);
});

test('parseSectionDataRows is exactly the rows of scanSectionDataTables', () => {
  const rows = parseSectionDataRows(sectioned);
  const scans = scanSectionDataTables(sectioned);
  assert.deepEqual([...rows.keys()], [...scans.keys()]);
  for (const [name, values] of rows) {
    assert.deepEqual(values, scans.get(name).rows);
  }
});

test('scanSectionDataTables: a section with no table is absent, not empty', () => {
  const scans = scanSectionDataTables(sectioned);
  assert.equal(scans.has('No table here'), false);
});

test('scanSectionDataTables: sees every section that has one', () => {
  const two = [
    '# T',
    '',
    '## Steps',
    '1. [section: One]',
    '2. [section: Two]',
    '',
    '### One',
    '| a |',
    '|---|',
    '| 1 |',
    '',
    '1. Go',
    '',
    '### Two',
    '| b |',
    '|---|',
    '| 2 |',
    '| 3 |',
    '',
    '1. Go',
    '',
  ].join('\n');
  const scans = scanSectionDataTables(two);
  assert.deepEqual([...scans.keys()], ['One', 'Two']);
  assert.deepEqual(scans.get('One').rowLines, [10]);
  assert.deepEqual(scans.get('Two').rowLines, [17, 18]);
});

test('scanSectionDataTables: the run table under ## Steps is not a section table', () => {
  // Both scans read the same file; only their spans differ. A run table
  // leaking into the section map would loop the wrong body.
  const md = [
    '# T',
    '',
    '## Steps',
    '| email |',
    '|-------|',
    '| a@b.c |',
    '',
    '1. Go',
    '',
    '### Body',
    '',
    '1. Inner',
    '',
  ].join('\n');
  assert.equal(scanSectionDataTables(md).size, 0);
  assert.deepEqual(parseDataRows(md).rowLines, [6]);
});

test('scanSectionDataTables: refuses a malformed section table the same way', () => {
  const md = [
    '# T', '', '## Steps', '1. [section: S]', '',
    '### S', '| a | b |', '|---|---|', '| 1 |', '', '1. Go', '',
  ].join('\n');
  assert.throws(() => scanSectionDataTables(md, 'up.md'), /Ragged row/);
  assert.throws(() => parseSectionDataRows(md, 'up.md'), /up\.md:9/);
});

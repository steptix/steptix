import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseDataRows, splitTableRow } from '../dist/data-rows.js';

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

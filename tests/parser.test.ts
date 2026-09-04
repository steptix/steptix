import { describe, it, expect } from 'vitest';
import { parseTestContent } from '../src/parser/markdown.js';

describe('parseTestContent', () => {
  it('extracts H1 title', () => {
    const md = `# My Test\n\n## Steps\n- Do something\n`;
    const result = parseTestContent(md);
    expect(result.title).toBe('My Test');
  });

  it('falls back to filename when no H1', () => {
    const md = `## Steps\n- Click button\n`;
    const result = parseTestContent(md, '/tests/my-test.md');
    expect(result.title).toBe('my-test');
  });

  it('parses frontmatter tags', () => {
    const md = `---\ntags: [smoke, regression]\n---\n\n# Test\n\n## Steps\n- Step 1\n`;
    const result = parseTestContent(md);
    expect(result.frontmatter.tags).toEqual(['smoke', 'regression']);
  });

  it('parses frontmatter timeout', () => {
    const md = `---\ntimeout: 2m\ntags: []\n---\n\n# Test\n\n## Steps\n- Step 1\n`;
    const result = parseTestContent(md);
    expect(result.frontmatter.timeout).toBe('2m');
  });

  it('parses frontmatter dataFile', () => {
    const md = `---\ntags: []\ndataFile: ./data/users.json\n---\n\n# Test\n\n## Steps\n- Login\n`;
    const result = parseTestContent(md);
    expect(result.frontmatter.dataFile).toBe('./data/users.json');
  });

  it('parses frontmatter dataSources map', () => {
    const md = `---
tags: []
dataSources:
  vip: ~/shared/vip-users.json
  local: ./extras.json
---

# Test

## Steps
- Login
`;
    const result = parseTestContent(md);
    expect(result.frontmatter.dataSources).toEqual({
      vip: '~/shared/vip-users.json',
      local: './extras.json',
    });
  });

  it('omits dataSources when not declared (backwards compatible)', () => {
    const md = `---\ntags: []\n---\n\n# Test\n\n## Steps\n- Login\n`;
    const result = parseTestContent(md);
    expect(result.frontmatter.dataSources).toBeUndefined();
  });

  it('rejects reserved name "env" in dataSources', () => {
    const md = `---\ntags: []\ndataSources:\n  env: ./x.json\n---\n\n# Test\n\n## Steps\n- A\n`;
    expect(() => parseTestContent(md)).toThrow(/reserved name "env"/);
  });

  it('rejects reserved name "data" in dataSources', () => {
    const md = `---\ntags: []\ndataSources:\n  data: ./x.json\n---\n\n# Test\n\n## Steps\n- A\n`;
    expect(() => parseTestContent(md)).toThrow(/reserved name "data"/);
  });

  it('rejects invalid dataSources name (starts with digit)', () => {
    const md = `---\ntags: []\ndataSources:\n  "1bad": ./x.json\n---\n\n# Test\n\n## Steps\n- A\n`;
    expect(() => parseTestContent(md)).toThrow(/name "1bad" is invalid/);
  });

  it('rejects non-string dataSources value', () => {
    const md = `---\ntags: []\ndataSources:\n  vip: 42\n---\n\n# Test\n\n## Steps\n- A\n`;
    expect(() => parseTestContent(md)).toThrow(/dataSources\.vip.*non-empty file-path string/);
  });

  it('parses ## Config section key-value pairs', () => {
    const md = `# Test\n\n## Config\n- baseUrl: http://localhost:3000\n- timeout: 30s\n\n## Steps\n- Visit home\n`;
    const result = parseTestContent(md);
    expect(result.config.baseUrl).toBe('http://localhost:3000');
    expect(result.config.timeout).toBe('30s');
  });

  it('parses ## Config section cdp port shorthand', () => {
    const md = `# Test\n\n## Config\n- baseUrl: http://localhost:3000\n- cdp: 9222\n\n## Steps\n- Visit home\n`;
    const result = parseTestContent(md);
    expect(result.config.cdp).toBe('9222');
    expect(result.config.cdpTab).toBeUndefined();
  });

  it('parses ## Config section cdpTab variants', () => {
    const md = `# Test\n\n## Config\n- cdp: 9222\n- cdpTab: url~example.com\n\n## Steps\n- Visit home\n`;
    const result = parseTestContent(md);
    expect(result.config.cdp).toBe('9222');
    expect(result.config.cdpTab).toBe('url~example.com');
  });

  it('parses ## Config section viewport onto TestConfig', () => {
    // The Config scan is generic, so this is one assertion rather than a suite:
    // what it pins is that `viewport` reaches `TestConfig` as the RAW string
    // (stories/per-test-viewport.md §3) — the parser resolves nothing, and a
    // future "helpful" normalisation here would put a second validator in the
    // pipeline.
    const md = `# Test\n\n## Config\n- viewport: mobile\n\n## Steps\n- Visit home\n`;
    const result = parseTestContent(md);
    expect(result.config.viewport).toBe('mobile');
  });

  it('parses ## Parameters section', () => {
    const md = `# Test\n\n## Parameters\n- email: user@example.com\n- password: $TEST_PASS\n\n## Steps\n- Login\n`;
    const result = parseTestContent(md);
    expect(result.parameters['email']).toBe('user@example.com');
    expect(result.parameters['password']).toBe('$TEST_PASS');
  });

  it('parses ## Steps as ordered list', () => {
    const md = `# Test\n\n## Steps\n1. Click Login button\n2. Enter credentials\n3. Assert dashboard visible\n`;
    const result = parseTestContent(md);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0]).toBe('Click Login button');
    expect(result.steps[1]).toBe('Enter credentials');
    expect(result.steps[2]).toBe('Assert dashboard visible');
  });

  it('parses ## Steps as unordered list', () => {
    const md = `# Test\n\n## Steps\n- Click button\n- Check result\n`;
    const result = parseTestContent(md);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]).toBe('Click button');
  });

  it('returns empty steps array when no ## Steps section', () => {
    const md = `# Test\n\nSome text here\n`;
    const result = parseTestContent(md);
    expect(result.steps).toEqual([]);
  });

  it('returns empty tags array when no frontmatter', () => {
    const md = `# Test\n\n## Steps\n- Do thing\n`;
    const result = parseTestContent(md);
    expect(result.frontmatter.tags).toEqual([]);
  });

  it('parses all sections together', () => {
    const md = `---
tags: [smoke]
timeout: 60s
---

# Full Test

## Config
- baseUrl: https://example.com

## Parameters
- username: admin
- password: $ADMIN_PASS

## Steps
1. Go to login page
2. Enter credentials
3. Submit form
4. Assert user is logged in
`;
    const result = parseTestContent(md, '/tests/full.md');
    expect(result.title).toBe('Full Test');
    expect(result.frontmatter.tags).toEqual(['smoke']);
    expect(result.frontmatter.timeout).toBe('60s');
    expect(result.config.baseUrl).toBe('https://example.com');
    expect(result.parameters['username']).toBe('admin');
    expect(result.parameters['password']).toBe('$ADMIN_PASS');
    expect(result.steps).toHaveLength(4);
    expect(result.filePath).toBe('/tests/full.md');
  });

  it('ignores unrecognised level-2 headings', () => {
    const md = `# Test\n\n## Notes\n- This is a note\n\n## Steps\n- Real step\n`;
    const result = parseTestContent(md);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toBe('Real step');
  });

  it('handles colon in parameter value', () => {
    const md = `# Test\n\n## Parameters\n- url: http://localhost:8080/path\n\n## Steps\n- Go\n`;
    const result = parseTestContent(md);
    expect(result.parameters['url']).toBe('http://localhost:8080/path');
  });
});

/**
 * A GFM table directly under `## Steps` makes the run loop, one iteration per
 * row (stories/data-driven-rows.md, part A). Every malformed shape below is a
 * parse error rather than a silent reading, because the failure mode they
 * share is a test that quietly runs a different number of times than the
 * author wrote.
 */
describe('data rows under ## Steps', () => {
  const table = (body: string) => `# Matrix\n\n## Steps\n${body}\n1. Go\n2. Stop\n`;

  it('reads a table above the steps into dataRows', () => {
    const md = table(
      '| email | password | outcome |\n' +
        '|-------|----------|---------|\n' +
        '| a@b.c | pw1      | dash    |\n' +
        '|       | pw2      | banner  |\n\n',
    );
    const result = parseTestContent(md);
    expect(result.dataRows).toEqual([
      { email: 'a@b.c', password: 'pw1', outcome: 'dash' },
      { email: '', password: 'pw2', outcome: 'banner' },
    ]);
    // The table is not a step, and does not disturb the step/line zip.
    expect(result.steps).toEqual(['Go', 'Stop']);
  });

  it('leaves dataRows absent — not empty — when there is no table', () => {
    const result = parseTestContent('# T\n\n## Steps\nProse is fine alone.\n\n1. Go\n');
    expect(result.dataRows).toBeUndefined();
  });

  it('allows blank lines and HTML comments before the table', () => {
    const md = table('\n<!-- why these rows -->\n| a |\n|---|\n| 1 |\n\n');
    expect(parseTestContent(md).dataRows).toEqual([{ a: '1' }]);
  });

  it('honours an escaped pipe in a cell', () => {
    const md = table(String.raw`| a | b |` + '\n|---|---|\n' + String.raw`| x \| y | z |` + '\n\n');
    expect(parseTestContent(md).dataRows).toEqual([{ a: 'x | y', b: 'z' }]);
  });

  it('does not let backticks protect a pipe — that row is ragged', () => {
    // Measured against the repo's marked: `` `a|b` `` splits into two cells.
    // The scanner matching marked is the point; a cell the two disagree about
    // would validate here and run with different values.
    const md = table('| a | b |\n|---|---|\n| `x|y` | z |\n\n');
    expect(() => parseTestContent(md)).toThrow(/Ragged row.*3 cell\(s\) against 2/s);
  });

  it('refuses a ragged row, naming its line', () => {
    const md = table('| a | b |\n|---|---|\n| 1 |\n\n');
    expect(() => parseTestContent(md)).toThrow(/Ragged row.*:6.*1 cell\(s\) against 2/s);
  });

  it('refuses a column name that is not an identifier', () => {
    expect(() => parseTestContent(table('| first name |\n|---|\n| x |\n\n'))).toThrow(
      /Invalid column name "first name"/,
    );
  });

  it('refuses a duplicate column', () => {
    expect(() => parseTestContent(table('| a | a |\n|---|---|\n| 1 | 2 |\n\n'))).toThrow(
      /Duplicate column "a"/,
    );
  });

  it('refuses a header with no rows rather than looping zero times', () => {
    expect(() => parseTestContent(table('| a |\n|---|\n\n'))).toThrow(/has no rows/);
  });

  it('refuses a cell holding a placeholder', () => {
    expect(() => parseTestContent(table('| a |\n|---|\n| {{x}} |\n\n'))).toThrow(
      /holds a \{\{placeholder\}\}/,
    );
  });

  it('refuses a second table', () => {
    const md = table('| a |\n|---|\n| 1 |\n\n| b |\n|---|\n| 2 |\n\n');
    expect(() => parseTestContent(md)).toThrow(/Second table/);
  });

  it('refuses a table after the first step', () => {
    // marked folds this into the step above it, so there is no table token at
    // all — the raw scan is the only side that can refuse it.
    const md = '# T\n\n## Steps\n1. Go\n\n| a |\n|---|\n| 1 |\n';
    expect(() => parseTestContent(md)).toThrow(/comes after a step/);
  });

  it('refuses prose between the heading and the table', () => {
    const md = '# T\n\n## Steps\nSome words.\n\n| a |\n|---|\n| 1 |\n\n1. Go\n';
    expect(() => parseTestContent(md)).toThrow(/comes after prose at line 4/);
  });

  it('refuses an indented table, which markdown reads as a code block', () => {
    const md = '# T\n\n## Steps\n    | a |\n    |---|\n    | 1 |\n\n1. Go\n';
    expect(() => parseTestContent(md)).toThrow(/indented/);
  });

  it('refuses a table in a skill file', () => {
    const md = '---\ntype: skill\n---\n\n# S\n\n## Steps\n| a |\n|---|\n| 1 |\n\n1. Go\n';
    expect(() => parseTestContent(md)).toThrow(/skill's own `## Steps`/);
  });

  it('refuses a table alongside dataFile', () => {
    const md = '---\ndataFile: users.csv\n---\n\n# T\n\n## Steps\n| a |\n|---|\n| 1 |\n\n1. Go\n';
    expect(() => parseTestContent(md)).toThrow(/both a data table.*dataFile: users\.csv/s);
  });

  it('ignores the run-history block the runner appends after the steps', () => {
    // `appendRunHistory` writes an HTML marker and a `## Latest runs` heading
    // at the end of the file. A file whose last section is `## Steps` must
    // still parse after the runner has written to it.
    const md =
      table('| a |\n|---|\n| 1 |\n\n') +
      '\n<!-- latest-runs:start -->\n## Latest runs\n- passed\n<!-- latest-runs:end -->\n';
    expect(parseTestContent(md).dataRows).toEqual([{ a: '1' }]);
  });
});

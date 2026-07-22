import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseTestContent, scanStepSpans } from '../src/parser/markdown.js';
import { matchText } from '../src/parser/section-match.js';

/**
 * Parser-side coverage for inline sections: capture, boundaries, and the
 * name-validation list. See stories/test-script-sections.md and the frozen
 * cross-package contract in stories/test-script-sections-contract.md.
 *
 * The classification fixtures are shared with runner-core and the extension
 * copy-parity tests, so anything asserted from them here is asserted against
 * the same bytes everywhere else.
 */

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'sections',
);
const readFixture = (name: string): string =>
  readFileSync(path.join(FIXTURES, name), 'utf-8');
const frozen = JSON.parse(readFixture('classification.json')) as {
  files: Record<
    string,
    {
      expectedSections: { name: string; headingLine: number; steps: { line: number; instruction: string }[] }[];
      expectedMainFlow?: { line: number; instruction: string }[];
    }
  >;
};

describe('section capture', () => {
  it('reproduces the frozen main flow and sections for the shared fixture', () => {
    const parsed = parseTestContent(readFixture('classification.md'), 'classification.md');
    const expected = frozen.files['classification.md']!;

    expect(parsed.steps).toEqual(expected.expectedMainFlow!.map((s) => s.instruction));
    expect(parsed.stepLines).toEqual(expected.expectedMainFlow!.map((s) => s.line));

    const actual = Object.values(parsed.sections).map((s) => ({
      name: s.name,
      headingLine: s.headingLine,
      steps: s.steps.map((instruction, i) => ({ line: s.stepLines[i]!, instruction })),
    }));
    expect(actual).toEqual(expected.expectedSections);
  });

  it('keys sections by matchText, preserving the authored casing on `name`', () => {
    const parsed = parseTestContent(
      ['# T', '', '## Steps', '1. LOGIN', '', '### Login As Admin', '1. Do it'].join('\n'),
    );
    expect(Object.keys(parsed.sections)).toEqual(['login as admin']);
    expect(parsed.sections['login as admin']!.name).toBe('Login As Admin');
    expect(matchText('Login As Admin')).toBe('login as admin');
  });

  it('ends the main flow at the first ### and does not resume after a section', () => {
    const parsed = parseTestContent(
      ['# T', '', '## Steps', '1. One', '', '### S', '1. Body', '', '2. Still body'].join('\n'),
    );
    expect(parsed.steps).toEqual(['One']);
    expect(parsed.sections['s']!.steps).toEqual(['Body', 'Still body']);
  });

  it('treats a #### heading with text as inert prose inside a body', () => {
    const parsed = parseTestContent(
      ['# T', '', '## Steps', '1. One', '', '### S', '1. A', '', '#### Note', '', '2. B'].join('\n'),
    );
    // The depth-4 heading does not close the body — B still belongs to S.
    expect(parsed.sections['s']!.steps).toEqual(['A', 'B']);
    expect(Object.keys(parsed.sections)).toEqual(['s']);
  });

  it('captures the raw match side separately from the executed text', () => {
    const parsed = parseTestContent(
      ['# T', '', '## Steps', '1. **Bold call**', '', '### S', '1. Body'].join('\n'),
    );
    // marked resolves inline formatting for execution; the raw scan does not,
    // and the raw form is what section matching compares against.
    expect(parsed.rawSteps).toEqual(['**Bold call**']);
  });

  it('leaves a ### heading outside ## Steps a no-op', () => {
    const parsed = parseTestContent(
      ['# T', '', '## Steps', '1. One', '', '## Notes', '', '### Not a section', '', '1. Prose item'].join('\n'),
    );
    expect(parsed.sections).toEqual({});
    expect(parsed.steps).toEqual(['One']);
  });

  it('recognises sections only under a depth-2 Steps heading', () => {
    // `### Steps` closes its own span at the first `###`, so no section can be
    // defined — matching the CLI token walk, which dispatches on depth 1-2.
    const parsed = parseTestContent(
      ['# T', '', '### Steps', '1. One', '', '### S', '1. Body'].join('\n'),
    );
    expect(parsed.sections).toEqual({});
  });

  it('parses a file with no ### exactly as before (no sections, lenient lines)', () => {
    const parsed = parseTestContent(
      ['# T', '', '## Steps', '1. One', '2. Two'].join('\n'),
    );
    expect(parsed.sections).toEqual({});
    expect(parsed.steps).toEqual(['One', 'Two']);
    expect(parsed.stepLines).toEqual([4, 5]);
  });
});

describe('section name validation', () => {
  const withName = (name: string): string =>
    ['# T', '', '## Steps', '1. Call', '', `### ${name}`, '1. Body'].join('\n');

  it.each(['Steps', 'steps', 'CONFIG', 'Parameters', 'Outputs', 'Hooks'])(
    'refuses the reserved name %s',
    (name) => {
      expect(() => parseTestContent(withName(name))).toThrow(/reserved section keyword/i);
    },
  );

  it('refuses a name beginning with [', () => {
    expect(() => parseTestContent(withName('[skill: x]'))).toThrow(/may not begin with/i);
  });

  it('refuses a name containing {{', () => {
    expect(() => parseTestContent(withName('Login {{user}}'))).toThrow(/may not contain/i);
  });

  it('refuses a duplicate name, case-insensitively', () => {
    const md = [
      '# T', '', '## Steps', '1. Call', '',
      '### Login', '1. A', '',
      '### LOGIN', '1. B',
    ].join('\n');
    expect(() => parseTestContent(md)).toThrow(/Duplicate section "LOGIN".*already defined at line 6/is);
  });

  it.each([
    ['###', 3],
    ['####', 4],
    ['#######', 7],
  ])('refuses the hashes-only heading %s as an empty name', (hashes) => {
    const md = ['# T', '', '## Steps', '1. Call', '', hashes, '1. Body'].join('\n');
    expect(() => parseTestContent(md)).toThrow(/empty name/i);
  });

  it('refuses every hashes-only depth in the shared fixture', () => {
    expect(() =>
      parseTestContent(readFixture('classification-hashes.md'), 'classification-hashes.md'),
    ).toThrow(/empty name/i);
  });

  it('names the file and line in the refusal', () => {
    expect(() => parseTestContent(withName('Steps'), '/tests/my-test.md')).toThrow(
      /\/tests\/my-test\.md:6/,
    );
  });
});

describe('scanStepSpans — the raw pass in isolation', () => {
  it('labels main-flow and body entries with their section index', () => {
    const md = [
      '# T', '', '## Steps', '1. One', '2. Two', '',
      '### A', '1. A1', '',
      '### B', '1. B1',
    ].join('\n');
    const scan = scanStepSpans(md, 't.md');
    expect(scan.heads).toEqual([
      { name: 'A', headingLine: 7 },
      { name: 'B', headingLine: 10 },
    ]);
    expect(scan.entries.map((e) => [e.line, e.sectionIndex, e.raw])).toEqual([
      [4, null, 'One'],
      [5, null, 'Two'],
      [8, 0, 'A1'],
      [11, 1, 'B1'],
    ]);
  });

  it('preserves the [no-hooks] marker in the raw text (matchText strips it)', () => {
    const scan = scanStepSpans(
      ['# T', '', '## Steps', '1. [no-hooks] Login'].join('\n'),
      't.md',
    );
    expect(scan.entries[0]!.raw).toBe('[no-hooks] Login');
    expect(matchText(scan.entries[0]!.raw)).toBe('login');
  });

  it('returns nothing when there is no Steps heading', () => {
    expect(scanStepSpans('# T\n\nJust prose.\n', 't.md')).toEqual({ entries: [], heads: [] });
  });
});

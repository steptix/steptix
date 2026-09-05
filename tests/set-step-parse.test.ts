/**
 * What a `Set {{name}} to "…"` step is refused for at PARSE time — before a
 * browser is launched (stories/variable-assignment.md §Locked).
 *
 * Two families:
 *
 *  - the grammar: a line that claimed the form and did not complete it;
 *  - the bake-over: a target whose name belongs to something expansion writes
 *    into the step TEXT rather than keeping as a variable, so the runner would
 *    never see the name at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseTestContent, parseTestFile } from '../src/parser/markdown.js';

describe('grammar, at parse time', () => {
  it('refuses an unquoted value and names the file and line', () => {
    const md = `# T\n\n## Steps\n1. Click Save\n2. Set {{ref}} to Ref: 1234\n`;
    expect(() => parseTestContent(md, '/tests/a.md')).toThrow(/double-quoted string/);
    expect(() => parseTestContent(md, '/tests/a.md')).toThrow(/a\.md at line 5/);
  });

  it('refuses trailing text after the closing quote', () => {
    const md = `# T\n\n## Steps\n1. Set {{a}} to "x" and click Save\n`;
    expect(() => parseTestContent(md)).toThrow(/Nothing may follow the closing quote/);
  });

  it('accepts the complete form, and keeps the line authored', () => {
    const md = `# T\n\n## Steps\n1. Set {{ref}} to "Ref: {{acct}}"\n`;
    const parsed = parseTestContent(md);
    expect(parsed.steps).toEqual(['Set {{ref}} to "Ref: {{acct}}"']);
  });

  it('leaves prose that merely starts with Set alone', () => {
    const md = `# T\n\n## Steps\n1. Set the filter to Recent\n2. Set {{a}} using the dropdown\n`;
    expect(() => parseTestContent(md)).not.toThrow();
  });
});

describe('bake-over refusals', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'set-step-'));
    mkdirSync(path.join(dir, 'skills'), { recursive: true });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const writeSkill = (name: string, body: string): void => {
    writeFileSync(path.join(dir, 'skills', `${name}.md`), body);
  };

  it("refuses a Set onto a skill's own parameter", async () => {
    writeSkill(
      'login',
      `---\ntype: skill\n---\n\n# login\n\n## Parameters\n- username: who\n\n## Steps\n1. Set {{username}} to "someone else"\n`,
    );
    const file = path.join(dir, 'test1.md');
    writeFileSync(file, `# T\n\n## Steps\n1. [skill: login username="a"]\n`);
    await expect(parseTestFile(file, { skillsDir: path.join(dir, 'skills') })).rejects.toThrow(
      /it is a parameter of this skill/,
    );
  });

  it("allows a Set onto a skill's declared output", async () => {
    writeSkill(
      'capture',
      `---\ntype: skill\n---\n\n# capture\n\n## Parameters\n- src: input\n\n## Outputs\n- label\n\n## Steps\n1. Set {{label}} to "from {{src}}"\n`,
    );
    const file = path.join(dir, 'test2.md');
    writeFileSync(file, `# T\n\n## Steps\n1. [skill: capture src="x" out.label="tag"]\n`);
    const parsed = await parseTestFile(file, { skillsDir: path.join(dir, 'skills') });
    // The output alias renames the target the same way it renames a
    // `[store as:]`, because a Set target IS a `{{X}}` placeholder.
    expect(parsed.steps[0]).toBe('Set {{tag}} to "from x"');
  });

  it('allows a Set onto an internal name inside a skill, namespaced', async () => {
    writeSkill(
      'internal',
      `---\ntype: skill\n---\n\n# internal\n\n## Steps\n1. Set {{scratch}} to "value"\n2. Type "{{scratch}}" into the box\n`,
    );
    const file = path.join(dir, 'test3.md');
    writeFileSync(file, `# T\n\n## Steps\n1. [skill: internal]\n`);
    const parsed = await parseTestFile(file, { skillsDir: path.join(dir, 'skills') });
    expect(parsed.steps[0]).toMatch(/^Set \{\{__skill\d+_scratch\}\} to "value"$/);
    // Namespaced consistently on both sides, or the write and the read would
    // be different variables.
    expect(parsed.steps[1]).toMatch(/^Type "\{\{__skill\d+_scratch\}\}"/);
  });

  it("refuses a Set onto a looped section's row column", () => {
    const md = [
      '# T',
      '',
      '## Steps',
      '1. Sign in',
      '',
      '### Sign in',
      '',
      '| user | pass |',
      '| --- | --- |',
      '| a | b |',
      '',
      '1. Set {{user}} to "someone else"',
      '',
    ].join('\n');
    expect(() => parseTestContent(md)).toThrow(/it is a column of the table/);
  });

  it("allows a Set onto a run-level row column — those are runtime variables", () => {
    const md = [
      '# T',
      '',
      '## Steps',
      '',
      '| user | pass |',
      '| --- | --- |',
      '| a | b |',
      '',
      '1. Set {{user}} to "someone else"',
      '',
    ].join('\n');
    expect(() => parseTestContent(md)).not.toThrow();
  });
});

describe('bake-over refusals that only expansion can see', () => {
  // The parse-time guard in markdown.ts checks the step's OWN section's
  // columns. Review found two cases it structurally cannot reach, and both
  // were worse than "degrades to prose": each passed GREEN on wrong data.
  const parse = (md: string): Promise<unknown> => {
    const file = path.join(dir, `expand-${Math.random().toString(36).slice(2)}.md`);
    writeFileSync(file, md);
    return parseTestFile(file, { skillsDir: path.join(dir, 'skills') });
  };

  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'set-expand-'));
    mkdirSync(path.join(dir, 'skills'), { recursive: true });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses a target that an ENCLOSING looped section's row bakes over", async () => {
    // The inner body inherits the outer table's bindings (`rowBindings` is
    // merged), so `{{tag}}` was baked to the outer row value: the assignment
    // silently vanished AND the next step read `a` instead of `assigned-1`,
    // passing green on the wrong data.
    await expect(
      parse(
        [
          '# T', '', '## Steps', '1. Outer', '',
          '### Outer', '', '| tag |', '| --- |', '| a |', '| b |', '',
          '1. Inner', '',
          '### Inner', '', '| n |', '| --- |', '| 1 |', '',
          '1. Set {{tag}} to "assigned-{{n}}"',
          '2. Type {{tag}} into the box', '',
        ].join('\n'),
      ),
    ).rejects.toThrow(/Cannot assign to \{\{tag\}\}.*enclosing it/s);
  });

  it('refuses a row value that makes the assignment unparseable', async () => {
    // A `"` in the row value breaks the `[^"]*` grammar once baked in, so
    // that ROW's assignment was skipped while the variable still held the
    // PREVIOUS row's value — the row then ran on stale data.
    await expect(
      parse(
        [
          '# T', '', '## Steps', '1. Greet', '',
          '### Greet', '', '| who |', '| --- |', '| Alice |', '| He said "hi" |', '',
          '1. Set {{msg}} to "Hello {{who}}"', '',
        ].join('\n'),
      ),
    ).rejects.toThrow(/makes the step unparseable/);
  });

  it('still expands a looped section whose Set target is not a column', async () => {
    // The guard must not refuse the legitimate shape.
    const parsed = (await parse(
      [
        '# T', '', '## Steps', '1. Greet', '',
        '### Greet', '', '| who |', '| --- |', '| Alice |', '| Bob |', '',
        '1. Set {{greeting}} to "Hello {{who}}"', '',
      ].join('\n'),
    )) as { steps: string[] };
    expect(parsed.steps).toEqual([
      'Set {{greeting}} to "Hello Alice"',
      'Set {{greeting}} to "Hello Bob"',
    ]);
  });
});

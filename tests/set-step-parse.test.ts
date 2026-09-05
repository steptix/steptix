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

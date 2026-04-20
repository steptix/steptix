import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expandSkills, clearSkillCache } from '../src/skills/expander.js';
import { parseTestFile } from '../src/parser/markdown.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-test-'));
  clearSkillCache();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeSkill(name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(tmpDir, `${name}.md`), content);
}

describe('expandSkills', () => {
  it('returns steps unchanged when no skill references are present', async () => {
    const steps = ['Click login', 'Type username'];
    const result = await expandSkills(steps, tmpDir);
    expect(result).toEqual(steps);
  });

  it('inlines a skill body and interpolates parameters', async () => {
    await writeSkill(
      'search',
      `---
type: skill
---
# search
## Parameters
- query: the term
## Steps
1. Navigate to https://example.com
2. Type "{{query}}" into the search box
`,
    );

    const result = await expandSkills(
      ['[skill: search query="GPT-5"]', 'Verify results loaded'],
      tmpDir,
    );

    expect(result).toEqual([
      'Navigate to https://example.com',
      'Type "GPT-5" into the search box',
      'Verify results loaded',
    ]);
  });

  it('strips trailing comment text after the skill bracket', async () => {
    await writeSkill(
      'noop',
      `---
type: skill
---
# noop
## Steps
1. Do nothing
`,
    );

    const result = await expandSkills(
      ['[skill: noop] human-readable comment that should be ignored'],
      tmpDir,
    );

    expect(result).toEqual(['Do nothing']);
  });

  it('namespaces internal capture names so they cannot collide with the caller', async () => {
    await writeSkill(
      'capture',
      `---
type: skill
---
# capture
## Steps
1. Read the value [store as: temp]
2. Type {{temp}} into the field
`,
    );

    const result = await expandSkills(['[skill: capture]'], tmpDir);

    expect(result[0]).toBe('Read the value [store as: __skill1_temp]');
    expect(result[1]).toBe('Type {{__skill1_temp}} into the field');
  });

  it('declared outputs leak under their declared name when no alias is given', async () => {
    await writeSkill(
      'count',
      `---
type: skill
---
# count
## Outputs
- result_count
## Steps
1. Count rows [store as: result_count]
`,
    );

    const result = await expandSkills(
      ['[skill: count]', 'The page shows {{result_count}} items'],
      tmpDir,
    );

    expect(result[0]).toBe('Count rows [store as: result_count]');
    expect(result[1]).toBe('The page shows {{result_count}} items');
  });

  it('renames outputs when caller provides out.<name>="alias"', async () => {
    await writeSkill(
      'count',
      `---
type: skill
---
# count
## Outputs
- result_count
## Steps
1. Count rows [store as: result_count]
`,
    );

    const result = await expandSkills(
      ['[skill: count out.result_count="my_count"]', 'Total: {{my_count}}'],
      tmpDir,
    );

    expect(result[0]).toBe('Count rows [store as: my_count]');
    expect(result[1]).toBe('Total: {{my_count}}');
  });

  it('throws when a required parameter is missing', async () => {
    await writeSkill(
      'search',
      `---
type: skill
---
# search
## Parameters
- query: required
## Steps
1. Search for {{query}}
`,
    );

    await expect(expandSkills(['[skill: search]'], tmpDir)).rejects.toThrow(
      /requires parameter "query"/,
    );
  });

  it('throws when caller aliases an undeclared output', async () => {
    await writeSkill(
      'noop',
      `---
type: skill
---
# noop
## Steps
1. Do nothing
`,
    );

    await expect(
      expandSkills(['[skill: noop out.bogus="x"]'], tmpDir),
    ).rejects.toThrow(/no declared output "bogus"/);
  });

  it('throws when the skill file does not exist', async () => {
    await expect(
      expandSkills(['[skill: missing_skill]'], tmpDir),
    ).rejects.toThrow(/Skill "missing_skill" not found/);
  });

  it('detects direct cycles', async () => {
    await writeSkill(
      'a',
      `---
type: skill
---
# a
## Steps
1. [skill: a]
`,
    );

    await expect(expandSkills(['[skill: a]'], tmpDir)).rejects.toThrow(
      /Skill cycle detected/,
    );
  });

  it('detects indirect cycles', async () => {
    await writeSkill(
      'a',
      `---
type: skill
---
# a
## Steps
1. [skill: b]
`,
    );
    await writeSkill(
      'b',
      `---
type: skill
---
# b
## Steps
1. [skill: a]
`,
    );

    await expect(expandSkills(['[skill: a]'], tmpDir)).rejects.toThrow(
      /Skill cycle detected: a -> b -> a/,
    );
  });

  it('expands nested skills recursively', async () => {
    await writeSkill(
      'inner',
      `---
type: skill
---
# inner
## Parameters
- text: input
## Steps
1. Type "{{text}}"
`,
    );
    await writeSkill(
      'outer',
      `---
type: skill
---
# outer
## Parameters
- name: input
## Steps
1. Click start
2. [skill: inner text="hello {{name}}"]
3. Click finish
`,
    );

    const result = await expandSkills(['[skill: outer name="world"]'], tmpDir);

    expect(result).toEqual([
      'Click start',
      'Type "hello world"',
      'Click finish',
    ]);
  });

  it('two invocations of the same skill get distinct internal namespaces', async () => {
    await writeSkill(
      'cap',
      `---
type: skill
---
# cap
## Steps
1. Read [store as: x]
`,
    );

    const result = await expandSkills(
      ['[skill: cap]', '[skill: cap]'],
      tmpDir,
    );

    expect(result[0]).toBe('Read [store as: __skill1_x]');
    expect(result[1]).toBe('Read [store as: __skill2_x]');
  });
});

describe('parseTestFile with skillsDir', () => {
  it('expands skills inline when skillsDir is provided', async () => {
    await writeSkill(
      'login',
      `---
type: skill
---
# login
## Parameters
- user: username
## Steps
1. Type "{{user}}" into the username field
2. Click submit
`,
    );

    const testPath = path.join(tmpDir, 'mytest.md');
    await fs.writeFile(
      testPath,
      `# My test\n\n## Steps\n1. [skill: login user="alice"]\n2. Verify dashboard\n`,
    );

    const parsed = await parseTestFile(testPath, { skillsDir: tmpDir });

    expect(parsed.steps).toEqual([
      'Type "alice" into the username field',
      'Click submit',
      'Verify dashboard',
    ]);
  });

  it('leaves skill references intact when no skillsDir is provided', async () => {
    const testPath = path.join(tmpDir, 'mytest.md');
    await fs.writeFile(
      testPath,
      `# My test\n\n## Steps\n1. [skill: login user="alice"]\n`,
    );

    const parsed = await parseTestFile(testPath);
    expect(parsed.steps).toEqual(['[skill: login user="alice"]']);
  });
});

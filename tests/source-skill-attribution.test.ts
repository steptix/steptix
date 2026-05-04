import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expandSkills, clearSkillCache } from '../src/skills/expander.js';
import { parseTestFile } from '../src/parser/markdown.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'src-skill-'));
  clearSkillCache();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeSkill(name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(tmpDir, `${name}.md`), content);
}

describe('expandSkills — source-skill attribution', () => {
  it('tags inline (non-skill) steps with null', async () => {
    const result = await expandSkills(
      ['Click the login button', 'Type "alice"'],
      tmpDir,
    );
    expect(result.sourceSkills).toEqual([null, null]);
  });

  it('tags every step inside a skill with that skill name', async () => {
    await writeSkill(
      'login',
      `---
type: skill
---
# login
## Steps
1. Type the username
2. Type the password
3. Click submit
`,
    );
    const result = await expandSkills(['[skill: login]'], tmpDir);
    expect(result.steps).toHaveLength(3);
    expect(result.sourceSkills).toEqual(['login', 'login', 'login']);
  });

  it('attributes nested-skill steps to the OUTERMOST skill the test invoked', async () => {
    await writeSkill(
      'inner',
      `---
type: skill
---
# inner
## Steps
1. inner step a
2. inner step b
`,
    );
    await writeSkill(
      'outer',
      `---
type: skill
---
# outer
## Steps
1. outer step 1
2. [skill: inner]
3. outer step 3
`,
    );
    const result = await expandSkills(['[skill: outer]'], tmpDir);
    expect(result.steps).toEqual([
      'outer step 1',
      'inner step a',
      'inner step b',
      'outer step 3',
    ]);
    // All four steps came from `outer` because that's what the test author
    // invoked from the test scope — the `inner` invocation is an internal
    // implementation detail of `outer`.
    expect(result.sourceSkills).toEqual(['outer', 'outer', 'outer', 'outer']);
  });

  it('mixes inline and skill steps with the right per-step attribution', async () => {
    await writeSkill(
      'noop',
      `---
type: skill
---
# noop
## Steps
1. inside noop
`,
    );
    const result = await expandSkills(
      ['inline 1', '[skill: noop]', 'inline 2'],
      tmpDir,
    );
    expect(result.steps).toEqual(['inline 1', 'inside noop', 'inline 2']);
    expect(result.sourceSkills).toEqual([null, 'noop', null]);
  });
});

describe('parseTestFile — sourceSkills + hookToolCalls + hookSourceSkills', () => {
  it('populates sourceSkills parallel array on ParsedTest', async () => {
    const skillsDir = path.join(tmpDir, 'skills');
    await fs.mkdir(skillsDir);
    await fs.writeFile(
      path.join(skillsDir, 'login.md'),
      `---
type: skill
---
# login
## Steps
1. Type creds
2. Click submit
`,
    );
    const testPath = path.join(tmpDir, 't.md');
    await fs.writeFile(
      testPath,
      `# T\n## Steps\n1. Navigate /\n2. [skill: login]\n3. Verify dashboard\n`,
    );

    const parsed = await parseTestFile(testPath, { skillsDir });
    expect(parsed.steps).toEqual([
      'Navigate /',
      'Type creds',
      'Click submit',
      'Verify dashboard',
    ]);
    expect(parsed.sourceSkills).toEqual([null, 'login', 'login', null]);
  });

  it('populates hookToolCalls + hookSourceSkills for a hook calling a skill that contains a tool', async () => {
    const skillsDir = path.join(tmpDir, 'skills');
    await fs.mkdir(skillsDir);
    await fs.writeFile(
      path.join(skillsDir, 'setup.md'),
      `---
type: skill
---
# setup
## Steps
1. Navigate to base URL
2. [tool: seed_test_data]
`,
    );
    const testPath = path.join(tmpDir, 't.md');
    await fs.writeFile(
      testPath,
      `# T
## Hooks
- before: [skill: setup]

## Steps
1. Click something
`,
    );

    const parsed = await parseTestFile(testPath, { skillsDir });
    expect(parsed.hooks.before).toEqual([
      'Navigate to base URL',
      '[tool: seed_test_data]',
    ]);
    // Step 0 of the before hook is natural-language → null toolCall;
    // step 1 is a tool invocation → parsed ToolCall.
    expect(parsed.hookToolCalls.before[0]).toBeNull();
    expect(parsed.hookToolCalls.before[1]).toEqual({
      name: 'seed_test_data',
      args: {},
      outputAliases: {},
    });
    // Both steps came from the `setup` skill.
    expect(parsed.hookSourceSkills.before).toEqual(['setup', 'setup']);
  });

  it('keeps hookToolCalls aligned to instructions when a hook is authored inline', async () => {
    const testPath = path.join(tmpDir, 't.md');
    await fs.writeFile(
      testPath,
      `# T
## Hooks
- beforeEach: Dismiss any banner that is visible
- beforeEach: [tool: clear_local_storage]

## Steps
1. Click something
`,
    );

    const parsed = await parseTestFile(testPath, { skillsDir: tmpDir });
    expect(parsed.hooks.beforeEach).toEqual([
      'Dismiss any banner that is visible',
      '[tool: clear_local_storage]',
    ]);
    expect(parsed.hookToolCalls.beforeEach[0]).toBeNull();
    expect(parsed.hookToolCalls.beforeEach[1]).toEqual({
      name: 'clear_local_storage',
      args: {},
      outputAliases: {},
    });
    expect(parsed.hookSourceSkills.beforeEach).toEqual([null, null]);
  });
});

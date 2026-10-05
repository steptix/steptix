import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { clearSkillCache } from '../src/skills/expander.js';
import { parseTestFile } from '../src/parser/markdown.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'src-skill-'));
  clearSkillCache();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
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

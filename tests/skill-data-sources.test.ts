import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expandSkills, clearSkillCache } from '../src/skills/expander.js';
import { parseSkillFile } from '../src/parser/markdown.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-data-sources-'));
  clearSkillCache();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeFile(relPath: string, content: string): Promise<void> {
  const abs = path.join(tmpDir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

describe('skill-level dataSources', () => {
  it('resolves ${<source>.X} inside skill steps from the skill-private JSON file', async () => {
    await writeFile(
      'data/local-endpoints.json',
      JSON.stringify({ api: { url: 'http://localhost:8787' } }),
    );
    await writeFile(
      'skills/open.md',
      `---
type: skill
dataSources:
  endpoints: ../data/local-endpoints.json
---
# open
## Steps
1. Navigate to \${endpoints.api.url}/dashboard
`,
    );

    const result = await expandSkills(
      ['[skill: open]'],
      path.join(tmpDir, 'skills'),
      { env: {}, envName: 'local' },
    );

    expect(result.steps).toEqual(['Navigate to http://localhost:8787/dashboard']);
  });

  it('routes ${envName} in a path string to the matching JSON file, and the skill cache key includes envName', async () => {
    await writeFile(
      'data/local-endpoints.json',
      JSON.stringify({ api: { url: 'http://localhost:8787' } }),
    );
    await writeFile(
      'data/staging-endpoints.json',
      JSON.stringify({ api: { url: 'https://stg.example' } }),
    );
    await writeFile(
      'skills/open.md',
      `---
type: skill
dataSources:
  endpoints: ../data/\${envName}-endpoints.json
---
# open
## Steps
1. Navigate to \${endpoints.api.url}/
`,
    );

    // Note: NO clearSkillCache between calls — verifying envName is part of the key.
    const localRes = await expandSkills(
      ['[skill: open]'],
      path.join(tmpDir, 'skills'),
      { env: {}, envName: 'local' },
    );
    const stagingRes = await expandSkills(
      ['[skill: open]'],
      path.join(tmpDir, 'skills'),
      { env: {}, envName: 'staging' },
    );

    expect(localRes.steps).toEqual(['Navigate to http://localhost:8787/']);
    expect(stagingRes.steps).toEqual(['Navigate to https://stg.example/']);
  });

  it('rejects ${data.X} inside a dataSources path string', async () => {
    await writeFile(
      'skills/open.md',
      `---
type: skill
dataSources:
  endpoints: ../data/\${data.users.admin.email}-endpoints.json
---
# open
## Steps
1. Navigate to /
`,
    );

    await expect(
      parseSkillFile(path.join(tmpDir, 'skills', 'open.md'), {
        env: {},
        envName: 'local',
      }),
    ).rejects.toThrow(/dataSources path/);
  });

  it('errors when ${envName} is referenced but no env was selected', async () => {
    await writeFile(
      'skills/open.md',
      `---
type: skill
dataSources:
  endpoints: ../data/\${envName}.json
---
# open
## Steps
1. Navigate to /
`,
    );

    await expect(
      parseSkillFile(path.join(tmpDir, 'skills', 'open.md'), {
        env: {},
      }),
    ).rejects.toThrow(/no environment selected/);
  });

  it('skill ${data.X} is private — passes through to caller-level interpolation, not resolved by skill', async () => {
    // The skill body references ${data.users.X} but the skill itself does
    // NOT have `data` in its interpolation context. The expander returns the
    // skill body with `${data.users.X}` left literal, ready for the test-level
    // interpolation pass to handle.
    await writeFile(
      'skills/greet.md',
      `---
type: skill
---
# greet
## Steps
1. Greet \${data.users.admin.email}
`,
    );

    const result = await expandSkills(
      ['[skill: greet]'],
      path.join(tmpDir, 'skills'),
      { env: {}, envName: 'local' },
    );
    expect(result.steps).toEqual(['Greet ${data.users.admin.email}']);
  });

  it('hard-errors when a declared dataSources file does not exist', async () => {
    await writeFile(
      'skills/open.md',
      `---
type: skill
dataSources:
  endpoints: ../data/nonexistent.json
---
# open
## Steps
1. Navigate to /
`,
    );

    await expect(
      parseSkillFile(path.join(tmpDir, 'skills', 'open.md'), {
        env: {},
        envName: 'local',
      }),
    ).rejects.toThrow(/Data source file not found/);
  });

  it('expander wraps a load failure with both the skill file and the calling test', async () => {
    await writeFile(
      'skills/open.md',
      `---
type: skill
dataSources:
  endpoints: ../data/nonexistent.json
---
# open
## Steps
1. Navigate to /
`,
    );

    await expect(
      expandSkills(
        ['[skill: open]'],
        path.join(tmpDir, 'skills'),
        { env: {}, envName: 'local' },
        '/abs/path/to/my-test.md',
      ),
    ).rejects.toThrow(/Skill "open" failed to load[\s\S]+nonexistent\.json[\s\S]+Invoked from \/abs\/path\/to\/my-test\.md/);
  });
});

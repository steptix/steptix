import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expandMacros, clearMacroCache } from '../src/macros/expander.js';
import { parseMacroFile } from '../src/parser/markdown.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'macro-data-sources-'));
  clearMacroCache();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeFile(relPath: string, content: string): Promise<void> {
  const abs = path.join(tmpDir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

describe('macro-level dataSources', () => {
  it('resolves ${<source>.X} inside macro steps from the macro-private JSON file', async () => {
    await writeFile(
      'data/local-endpoints.json',
      JSON.stringify({ api: { url: 'http://localhost:8787' } }),
    );
    await writeFile(
      'macros/open.md',
      `---
type: macro
dataSources:
  endpoints: ../data/local-endpoints.json
---
# open
## Steps
1. Navigate to \${endpoints.api.url}/dashboard
`,
    );

    const result = await expandMacros(
      ['[macro: open]'],
      path.join(tmpDir, 'macros'),
      { env: {}, envName: 'local' },
    );

    expect(result.steps).toEqual(['Navigate to http://localhost:8787/dashboard']);
  });

  it('routes ${envName} in a path string to the matching JSON file, and the macro cache key includes envName', async () => {
    await writeFile(
      'data/local-endpoints.json',
      JSON.stringify({ api: { url: 'http://localhost:8787' } }),
    );
    await writeFile(
      'data/staging-endpoints.json',
      JSON.stringify({ api: { url: 'https://stg.example' } }),
    );
    await writeFile(
      'macros/open.md',
      `---
type: macro
dataSources:
  endpoints: ../data/\${envName}-endpoints.json
---
# open
## Steps
1. Navigate to \${endpoints.api.url}/
`,
    );

    // Note: NO clearMacroCache between calls — verifying envName is part of the key.
    const localRes = await expandMacros(
      ['[macro: open]'],
      path.join(tmpDir, 'macros'),
      { env: {}, envName: 'local' },
    );
    const stagingRes = await expandMacros(
      ['[macro: open]'],
      path.join(tmpDir, 'macros'),
      { env: {}, envName: 'staging' },
    );

    expect(localRes.steps).toEqual(['Navigate to http://localhost:8787/']);
    expect(stagingRes.steps).toEqual(['Navigate to https://stg.example/']);
  });

  it('rejects ${data.X} inside a dataSources path string', async () => {
    await writeFile(
      'macros/open.md',
      `---
type: macro
dataSources:
  endpoints: ../data/\${data.users.admin.email}-endpoints.json
---
# open
## Steps
1. Navigate to /
`,
    );

    await expect(
      parseMacroFile(path.join(tmpDir, 'macros', 'open.md'), {
        env: {},
        envName: 'local',
      }),
    ).rejects.toThrow(/dataSources path/);
  });

  it('errors when ${envName} is referenced but no env was selected', async () => {
    await writeFile(
      'macros/open.md',
      `---
type: macro
dataSources:
  endpoints: ../data/\${envName}.json
---
# open
## Steps
1. Navigate to /
`,
    );

    await expect(
      parseMacroFile(path.join(tmpDir, 'macros', 'open.md'), {
        env: {},
      }),
    ).rejects.toThrow(/no environment selected/);
  });

  it('macro ${data.X} is private — passes through to caller-level interpolation, not resolved by macro', async () => {
    // The macro body references ${data.users.X} but the macro itself does
    // NOT have `data` in its interpolation context. The expander returns the
    // macro body with `${data.users.X}` left literal, ready for the test-level
    // interpolation pass to handle.
    await writeFile(
      'macros/greet.md',
      `---
type: macro
---
# greet
## Steps
1. Greet \${data.users.admin.email}
`,
    );

    const result = await expandMacros(
      ['[macro: greet]'],
      path.join(tmpDir, 'macros'),
      { env: {}, envName: 'local' },
    );
    expect(result.steps).toEqual(['Greet ${data.users.admin.email}']);
  });

  it('hard-errors when a declared dataSources file does not exist', async () => {
    await writeFile(
      'macros/open.md',
      `---
type: macro
dataSources:
  endpoints: ../data/nonexistent.json
---
# open
## Steps
1. Navigate to /
`,
    );

    await expect(
      parseMacroFile(path.join(tmpDir, 'macros', 'open.md'), {
        env: {},
        envName: 'local',
      }),
    ).rejects.toThrow(/Data source file not found/);
  });

  it('expander wraps a load failure with both the macro file and the calling test', async () => {
    await writeFile(
      'macros/open.md',
      `---
type: macro
dataSources:
  endpoints: ../data/nonexistent.json
---
# open
## Steps
1. Navigate to /
`,
    );

    await expect(
      expandMacros(
        ['[macro: open]'],
        path.join(tmpDir, 'macros'),
        { env: {}, envName: 'local' },
        '/abs/path/to/my-test.md',
      ),
    ).rejects.toThrow(/Macro "open" failed to load[\s\S]+nonexistent\.json[\s\S]+Invoked from \/abs\/path\/to\/my-test\.md/);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { clearMacroCache } from '../src/macros/expander.js';
import { parseTestFile } from '../src/parser/markdown.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'src-macro-'));
  clearMacroCache();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('parseTestFile — sourceMacros + hookToolCalls + hookSourceMacros', () => {
  it('populates sourceMacros parallel array on ParsedTest', async () => {
    const macrosDir = path.join(tmpDir, 'macros');
    await fs.mkdir(macrosDir);
    await fs.writeFile(
      path.join(macrosDir, 'login.md'),
      `---
type: macro
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
      `# T\n## Steps\n1. Navigate /\n2. [macro: login]\n3. Verify dashboard\n`,
    );

    const parsed = await parseTestFile(testPath, { macrosDir });
    expect(parsed.steps).toEqual([
      'Navigate /',
      'Type creds',
      'Click submit',
      'Verify dashboard',
    ]);
    expect(parsed.sourceMacros).toEqual([null, 'login', 'login', null]);
  });

  it('populates hookToolCalls + hookSourceMacros for a hook calling a macro that contains a tool', async () => {
    const macrosDir = path.join(tmpDir, 'macros');
    await fs.mkdir(macrosDir);
    await fs.writeFile(
      path.join(macrosDir, 'setup.md'),
      `---
type: macro
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
- before: [macro: setup]

## Steps
1. Click something
`,
    );

    const parsed = await parseTestFile(testPath, { macrosDir });
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
    // Both steps came from the `setup` macro.
    expect(parsed.hookSourceMacros.before).toEqual(['setup', 'setup']);
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

    const parsed = await parseTestFile(testPath, { macrosDir: tmpDir });
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
    expect(parsed.hookSourceMacros.beforeEach).toEqual([null, null]);
  });
});

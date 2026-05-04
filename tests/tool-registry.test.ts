import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadToolCatalogue, ToolCatalogue } from '../src/tools/registry.js';

let tmpDir: string;
let counter = 0;

beforeEach(async () => {
  // Use a unique counter so dynamic imports never cache-hit a previous test's
  // file written to the same path.
  counter += 1;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `tool-reg-${counter}-`));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeTool(filename: string, code: string): Promise<void> {
  await fs.writeFile(path.join(tmpDir, `${filename}.js`), code, 'utf-8');
}

/**
 * Build a JS file that default-exports a raw tool definition. Avoids importing
 * `defineTool` from the test harness so the registry test stays decoupled
 * from the helper's implementation — `isToolDefinition` duck-types anyway.
 */
function jsTool(name: string): string {
  return `
export default {
  name: '${name}',
  parameters: {},
  outputs: {},
  run: () => undefined,
};
`;
}

describe('loadToolCatalogue', () => {
  it('returns an empty catalogue when the directory does not exist', async () => {
    const catalogue = await loadToolCatalogue(path.join(tmpDir, 'no-such-dir'));
    expect(catalogue).toBeInstanceOf(ToolCatalogue);
    expect(catalogue.size).toBe(0);
  });

  it('returns an empty catalogue when the directory has no tool files', async () => {
    const catalogue = await loadToolCatalogue(tmpDir);
    expect(catalogue.size).toBe(0);
  });

  it('loads a single tool from a .js file', async () => {
    await writeTool('greet', jsTool('greet'));
    const catalogue = await loadToolCatalogue(tmpDir);
    expect(catalogue.size).toBe(1);
    expect(catalogue.has('greet')).toBe(true);
    expect(catalogue.get('greet')?.definition.name).toBe('greet');
  });

  it('loads multiple tools and exposes them by registered name', async () => {
    await writeTool('alpha', jsTool('alpha'));
    await writeTool('beta', jsTool('beta'));
    const catalogue = await loadToolCatalogue(tmpDir);
    expect(catalogue.names().sort()).toEqual(['alpha', 'beta']);
  });

  it('throws on duplicate tool name', async () => {
    await writeTool('a1', jsTool('shared_name'));
    await writeTool('a2', jsTool('shared_name'));
    await expect(loadToolCatalogue(tmpDir)).rejects.toThrow(/Duplicate tool name/);
  });

  it('skips files whose default export is not a tool', async () => {
    await writeTool('not_a_tool', `export default { not: 'a tool' };`);
    await writeTool('valid', jsTool('valid_tool'));
    const catalogue = await loadToolCatalogue(tmpDir);
    expect(catalogue.size).toBe(1);
    expect(catalogue.has('valid_tool')).toBe(true);
  });

  it('ignores files that match .test.* / .d.ts and node_modules dirs', async () => {
    await writeTool('mytool', jsTool('mytool'));
    await fs.writeFile(path.join(tmpDir, 'should_skip.test.js'), 'export default {};');
    await fs.writeFile(path.join(tmpDir, 'types.d.ts'), 'export {};');
    await fs.mkdir(path.join(tmpDir, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'node_modules', 'pkg.js'), 'export default {};');
    const catalogue = await loadToolCatalogue(tmpDir);
    expect(catalogue.size).toBe(1);
  });
});

describe('loadToolCatalogue — rung 1 / 2 ergonomics', () => {
  it('loads a bare-function default export, name from filename', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'uuid.js'),
      `export default () => 'fixed-uuid-value';\n`,
    );
    const catalogue = await loadToolCatalogue(tmpDir);
    expect(catalogue.size).toBe(1);
    expect(catalogue.has('uuid')).toBe(true);
    const def = catalogue.require('uuid').definition;
    expect(def.outputs).toEqual({ uuid: { type: 'string' } });
  });

  it('loads multiple tools from named exports of a single file', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'multi.js'),
      `export const alpha = () => 'a';\nexport const beta = () => 'b';\n`,
    );
    const catalogue = await loadToolCatalogue(tmpDir);
    expect(catalogue.names().sort()).toEqual(['alpha', 'beta']);
  });

  it('mixes bare-function default and named exports in one file', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'mixed.js'),
      `
export default () => 'm';
export const helper = () => 'h';
`,
    );
    const catalogue = await loadToolCatalogue(tmpDir);
    expect(catalogue.names().sort()).toEqual(['helper', 'mixed']);
  });

  it('skips named exports that are not tools (objects, types, etc.)', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'mixed2.js'),
      `
export default () => 'x';
export const NOT_A_TOOL = { config: true };
export const description = 'just a string';
`,
    );
    const catalogue = await loadToolCatalogue(tmpDir);
    expect(catalogue.names()).toEqual(['mixed2']);
  });

  it('rejects a file whose filename has illegal characters', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'bad name.js'),
      `export default () => 'x';\n`,
    );
    await expect(loadToolCatalogue(tmpDir)).rejects.toThrow(
      /filename "bad name"/,
    );
  });

  it('explicit name on the default export wins over filename, with a warn', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'unrelated.js'),
      `
export default {
  name: 'preferred',
  parameters: {},
  outputs: {},
  run: () => undefined,
};
`,
    );
    const catalogue = await loadToolCatalogue(tmpDir);
    expect(catalogue.names()).toEqual(['preferred']);
  });
});

describe('ToolCatalogue.require', () => {
  it('returns the registered tool', async () => {
    await writeTool('mine', jsTool('mine'));
    const catalogue = await loadToolCatalogue(tmpDir);
    expect(catalogue.require('mine').definition.name).toBe('mine');
  });

  it('throws with available names listed when the tool is unknown', async () => {
    await writeTool('alpha', jsTool('alpha'));
    const catalogue = await loadToolCatalogue(tmpDir);
    expect(() => catalogue.require('nope')).toThrow(/not found[\s\S]*alpha/);
  });
});

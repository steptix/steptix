import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { defaultToolsDir, loadToolCatalogue, ToolCatalogue } from '../src/tools/registry.js';
import { logger } from '../src/utils/logger.js';

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

describe('loadToolCatalogue — lazy indexing', () => {
  it('returns an empty catalogue when the directory does not exist', async () => {
    const catalogue = await loadToolCatalogue(path.join(tmpDir, 'no-such-dir'));
    expect(catalogue).toBeInstanceOf(ToolCatalogue);
    expect(catalogue.size).toBe(0);
    expect(catalogue.indexedCount).toBe(0);
    expect(catalogue.diagnostics?.toolsDirMissing).toBe(true);
  });

  describe('a missing directory', () => {
    /** The `tools.dir ... does not exist` lines logged at each level during `fn`. */
    async function missingDirLines(fn: () => Promise<unknown>): Promise<{ warn: string[]; debug: string[] }> {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
      try {
        await fn();
        const pick = (spy: typeof warn) =>
          spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('does not exist'));
        return { warn: pick(warn), debug: pick(debug) };
      } finally {
        warn.mockRestore();
        debug.mockRestore();
      }
    }

    it('stays at debug when it is the default tools/src — the project just has no tools yet', async () => {
      // What `steptix init` leaves behind: the scaffold names ./tools/src but
      // does not create it, so every first run would otherwise open on a WARN.
      const dir = defaultToolsDir(tmpDir);
      const lines = await missingDirLines(() => loadToolCatalogue(dir, { defaultDir: dir }));
      expect(lines.warn).toEqual([]);
      expect(lines.debug).toHaveLength(1);
    });

    it('still records the default as missing, so a [tool: ...] step that runs names the directory', async () => {
      const dir = defaultToolsDir(tmpDir);
      const catalogue = await loadToolCatalogue(dir, { defaultDir: dir });
      expect(catalogue.diagnostics?.toolsDirMissing).toBe(true);
      expect(catalogue.buildNotFoundMessage('login')).toContain(`tools.dir does not exist: ${dir}`);
    });

    it('warns when the project pointed toolsDir somewhere else', async () => {
      const lines = await missingDirLines(() =>
        loadToolCatalogue(path.join(tmpDir, 'my-tools'), { defaultDir: defaultToolsDir(tmpDir) }),
      );
      expect(lines.warn).toHaveLength(1);
      expect(lines.warn[0]).toContain('tests.toolsDir');
    });

    it('warns when the caller does not say what the default is', async () => {
      const lines = await missingDirLines(() => loadToolCatalogue(defaultToolsDir(tmpDir)));
      expect(lines.warn).toHaveLength(1);
    });

    it('defaultToolsDir is tools/src under the project root', () => {
      expect(defaultToolsDir(tmpDir)).toBe(path.join(tmpDir, 'tools', 'src'));
    });
  });

  it('returns an empty catalogue when the directory has no tool files', async () => {
    const catalogue = await loadToolCatalogue(tmpDir);
    expect(catalogue.size).toBe(0);
    expect(catalogue.indexedCount).toBe(0);
  });

  it('indexes files without importing them — size stays 0 until resolve', async () => {
    await writeTool('greet', jsTool('greet'));
    const catalogue = await loadToolCatalogue(tmpDir);
    // Indexed, but nothing imported yet.
    expect(catalogue.indexedCount).toBe(1);
    expect(catalogue.size).toBe(0);
    expect(catalogue.has('greet')).toBe(false);
    // Resolving imports exactly that file.
    const tool = await catalogue.resolve('greet');
    expect(tool.definition.name).toBe('greet');
    expect(catalogue.size).toBe(1);
  });

  it('does NOT throw at load time for a file that throws on import', async () => {
    await writeTool('boom', `throw new Error('top-level kaboom');`);
    await writeTool('fine', jsTool('fine'));
    // The broken file must not abort indexing.
    const catalogue = await loadToolCatalogue(tmpDir);
    expect(catalogue.indexedCount).toBe(2);
    // The healthy sibling resolves fine despite the broken file's presence.
    expect((await catalogue.resolve('fine')).definition.name).toBe('fine');
    // The broken file fails only when referenced.
    await expect(catalogue.resolve('boom')).rejects.toThrow(/could not be loaded[\s\S]*kaboom/);
  });

  it('ignores files that match .test.* / .d.ts and node_modules dirs', async () => {
    await writeTool('mytool', jsTool('mytool'));
    await fs.writeFile(path.join(tmpDir, 'should_skip.test.js'), 'export default {};');
    await fs.writeFile(path.join(tmpDir, 'types.d.ts'), 'export {};');
    await fs.mkdir(path.join(tmpDir, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'node_modules', 'pkg.js'), 'export default {};');
    const catalogue = await loadToolCatalogue(tmpDir);
    expect(catalogue.indexedCount).toBe(1);
  });
});

describe('ToolCatalogue.resolve — sugar (single-segment) refs', () => {
  it('resolves a tool whose name matches its filename', async () => {
    await writeTool('greet', jsTool('greet'));
    const catalogue = await loadToolCatalogue(tmpDir);
    expect((await catalogue.resolve('greet')).definition.name).toBe('greet');
  });

  it('resolves a bare-function default export, name from filename', async () => {
    await fs.writeFile(path.join(tmpDir, 'uuid.js'), `export default () => 'fixed-uuid-value';\n`);
    const catalogue = await loadToolCatalogue(tmpDir);
    const def = (await catalogue.resolve('uuid')).definition;
    expect(def.name).toBe('uuid');
    expect(def.outputs).toEqual({ uuid: { type: 'string' } });
  });

  it('explicit name on the default export wins over filename', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'unrelated.js'),
      `export default { name: 'preferred', parameters: {}, outputs: {}, run: () => undefined };`,
    );
    const catalogue = await loadToolCatalogue(tmpDir);
    // Sugar ref uses the filename → tool is actually named 'preferred', so the
    // bare ref points at a tool the file doesn't expose under that name.
    await expect(catalogue.resolve('unrelated')).rejects.toThrow(
      /not found in[\s\S]*registers: \[preferred\]/,
    );
    // The hint's example must keep the file portion of a sugar ref, suggesting
    // `unrelated/preferred` — not the bare (invalid) `preferred`.
    await expect(catalogue.resolve('unrelated')).rejects.toThrow(/e\.g\. "unrelated\/preferred"/);
    // Path-qualified ref reaches it: file `unrelated`, tool `preferred`.
    expect((await catalogue.resolve('unrelated/preferred')).definition.name).toBe('preferred');
  });

  it('skips files whose default export is not a tool', async () => {
    await writeTool('not_a_tool', `export default { not: 'a tool' };`);
    await writeTool('valid', jsTool('valid'));
    const catalogue = await loadToolCatalogue(tmpDir);
    expect((await catalogue.resolve('valid')).definition.name).toBe('valid');
    await expect(catalogue.resolve('not_a_tool')).rejects.toThrow(/not found in/);
  });
});

describe('ToolCatalogue.resolve — path-qualified (multi-tool) refs', () => {
  it('resolves named exports of a multi-tool file via file/tool', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'multi.js'),
      `export const alpha = () => 'a';\nexport const beta = () => 'b';\n`,
    );
    const catalogue = await loadToolCatalogue(tmpDir);
    expect((await catalogue.resolve('multi/alpha')).definition.name).toBe('alpha');
    expect((await catalogue.resolve('multi/beta')).definition.name).toBe('beta');
    // The bare/sugar form can't pick one out of a multi-tool file.
    await expect(catalogue.resolve('multi')).rejects.toThrow(/not found in/);
  });

  it('resolves a tool in a subdirectory file (dir/file/tool)', async () => {
    await fs.mkdir(path.join(tmpDir, 'auth'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'auth', 'login.js'), `export default () => 'ok';\n`);
    const catalogue = await loadToolCatalogue(tmpDir);
    // file `auth/login`, tool `login`.
    expect((await catalogue.resolve('auth/login/login')).definition.name).toBe('login');
  });

  it('disambiguates a file vs a sibling directory of the same name', async () => {
    // auth.js exposes `login`; auth/login.js is a separate single-tool file.
    await fs.writeFile(
      path.join(tmpDir, 'auth.js'),
      `export const login = () => 'from-auth-file';\n`,
    );
    await fs.mkdir(path.join(tmpDir, 'auth'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'auth', 'login.js'),
      `export default () => 'from-auth-dir';\n`,
    );
    const catalogue = await loadToolCatalogue(tmpDir);
    // `auth/login`       → file auth.js, tool login
    const fromFile = await catalogue.resolve('auth/login');
    expect(fromFile.filePath.replace(/\\/g, '/')).toMatch(/\/auth\.js$/);
    // `auth/login/login` → file auth/login.js, tool login
    const fromDir = await catalogue.resolve('auth/login/login');
    expect(fromDir.filePath.replace(/\\/g, '/')).toMatch(/\/auth\/login\.js$/);
  });
});

describe('ToolCatalogue.resolve — failure isolation', () => {
  it('a within-file duplicate name breaks only that file', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'dup.js'),
      `export const a = { name: 'same', parameters: {}, outputs: {}, run: () => undefined };
       export const b = { name: 'same', parameters: {}, outputs: {}, run: () => undefined };`,
    );
    await writeTool('ok', jsTool('ok'));
    const catalogue = await loadToolCatalogue(tmpDir);
    // The healthy file is unaffected.
    expect((await catalogue.resolve('ok')).definition.name).toBe('ok');
    // The duplicate trips on import → that file is broken.
    await expect(catalogue.resolve('dup/same')).rejects.toThrow(/could not be loaded[\s\S]*Duplicate/);
  });

  it('a missing/unresolvable import fails only the referencing tool', async () => {
    await writeTool('needs_pkg', `import 'totally-not-a-real-package';\nexport default () => 'x';`);
    await writeTool('healthy', jsTool('healthy'));
    const catalogue = await loadToolCatalogue(tmpDir);
    expect((await catalogue.resolve('healthy')).definition.name).toBe('healthy');
    await expect(catalogue.resolve('needs_pkg')).rejects.toThrow(/could not be loaded/);
  });

  it('rejects a file whose filename is not a legal tool name', async () => {
    await fs.writeFile(path.join(tmpDir, 'bad name.js'), `export default () => 'x';\n`);
    const catalogue = await loadToolCatalogue(tmpDir);
    await expect(catalogue.resolve('bad name')).rejects.toThrow(/filename "bad name"/);
  });
});

describe('ToolCatalogue.resolve — malformed refs', () => {
  it('rejects empty path segments', async () => {
    const catalogue = await loadToolCatalogue(tmpDir);
    await expect(catalogue.resolve('auth//login')).rejects.toThrow(/empty path segment/);
    await expect(catalogue.resolve('/login')).rejects.toThrow(/empty path segment/);
    await expect(catalogue.resolve('auth/')).rejects.toThrow(/empty path segment/);
  });

  it('reports a clear not-found for a ref with no matching file or tool', async () => {
    await writeTool('alpha', jsTool('alpha'));
    const catalogue = await loadToolCatalogue(tmpDir);
    await expect(catalogue.resolve('nope')).rejects.toThrow(/not found/);
  });
});

describe('ToolCatalogue.require — direct registration (sync, unchanged)', () => {
  it('returns a directly-registered tool', () => {
    const cat = new ToolCatalogue();
    cat.register({
      definition: { name: 'mine', parameters: {}, outputs: {}, run: () => undefined },
      filePath: '/x/mine.ts',
    });
    expect(cat.require('mine').definition.name).toBe('mine');
  });

  it('throws with available names listed when the tool is unknown', () => {
    const cat = new ToolCatalogue();
    cat.register({
      definition: { name: 'alpha', parameters: {}, outputs: {}, run: () => undefined },
      filePath: '/x/alpha.ts',
    });
    expect(() => cat.require('nope')).toThrow(/not found[\s\S]*alpha/);
  });
});

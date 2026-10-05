import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page, BrowserContext, Browser } from 'playwright';
import { loadToolCatalogue, ToolCatalogue } from '../src/tools/registry.js';
import { executeToolStep } from '../src/tools/executor.js';
import {
  signatureOf,
  resolveToolCacheDir,
  bundleToolModule,
  bundleAndImport,
  TOOL_CACHE_DIRNAME,
} from '../src/tools/reload.js';

/**
 * Tests for tool hot-reload on the long-lived server (issue 033).
 *
 * Part 1 (edited files): an edited tool file — or an edited helper it imports —
 * is re-imported with fresh code on the next `resolve`, without a restart,
 * defeating tsx's path-keyed transpile cache and Node's ESM cache.
 * Part 2 (added/removed files): `refreshIndex` re-walks the dir so a file added
 * mid-session is discovered and a deleted one disappears — import-free.
 *
 * Tool files use the realistic shape (`defineTool` + the bare
 * `steptix/tools` self-import), so these also guard that a bundled
 * temp module still resolves the framework package. That self-reference only
 * resolves from *under the repo root*, so temp tool dirs live below `tests/`
 * (not `os.tmpdir()`), exactly as a real user's tool would resolve from under
 * their own project. Requires a built `dist/` (same as the e2e tool suite).
 */

const repoRoot = path.resolve(__dirname, '..');
/** This run's own base, from `mkdtemp`: a fixed name would hand a run the
 *  `tN/` dirs an aborted earlier run left behind — a stray `second.ts` that
 *  "discovers a file added after the initial scan" then counts — and two runs
 *  in one checkout would delete each other's files. */
let tmpBase: string;

// Reload tests use pure string tools that never touch the browser, so these
// dummies are enough to satisfy executeToolStep's signature.
const noPage = {} as unknown as Page;
const noContext = {} as unknown as BrowserContext;
const noBrowser = {} as unknown as Browser;

let counter = 0;
/** A fresh, empty tool dir under the repo (so the self-import resolves). */
async function freshDir(): Promise<string> {
  const dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** A realistic single-tool file whose `marker` output is `value`. */
function markerTool(value: string): string {
  return `import { defineTool } from 'steptix/tools';
export default defineTool({
  name: 'marker',
  parameters: {},
  outputs: { marker: { type: 'string' } },
  async run(_args, { step }) { step.setVar('marker', ${JSON.stringify(value)}); },
});
`;
}

async function write(dir: string, rel: string, contents: string): Promise<void> {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents, 'utf-8');
}

/** Resolve + run a tool through the same seam the runner uses; report the outcome. */
async function run(
  cat: ToolCatalogue,
  ref = 'marker',
): Promise<{ status: string; marker: string | undefined; error: string | undefined }> {
  const resolvedParameters: Record<string, string> = {};
  const outcome = await executeToolStep(
    { name: ref, args: {}, outputAliases: {} },
    { page: noPage, context: noContext, browser: noBrowser, resolvedParameters, catalogue: cat },
  );
  return { status: outcome.status, marker: resolvedParameters['marker'], error: outcome.error };
}

beforeAll(async () => {
  tmpBase = await fs.mkdtemp(path.join(repoRoot, 'tests', '.tmp-tool-reload-'));
});

afterAll(async () => {
  if (tmpBase) await fs.rm(tmpBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('tool reload — edited files (issue 033 Part 1)', () => {
  it('runs fresh code after an edit, on the same catalogue, with no restart', async () => {
    const dir = await freshDir();
    await write(dir, 'marker.ts', markerTool('V1'));
    const cat = await loadToolCatalogue(dir, { reload: true });

    const first = await run(cat);
    expect(first.status).toBe('passed');
    expect(first.marker).toBe('V1');
    // The reported path stays the original .ts, never the bundled temp module.
    expect((await cat.resolve('marker')).filePath).toBe(path.join(dir, 'marker.ts'));

    await write(dir, 'marker.ts', markerTool('V2'));
    const second = await run(cat);
    expect(second.status).toBe('passed');
    expect(second.marker).toBe('V2');
  });

  it('does NOT re-import an unchanged file (steady-state cache hit)', async () => {
    const dir = await freshDir();
    await write(dir, 'marker.ts', markerTool('STABLE'));
    const cat = await loadToolCatalogue(dir, { reload: true });

    const a = await cat.resolve('marker');
    const b = await cat.resolve('marker');
    // A reload would mint a new RegisteredTool via finaliseModule; identity
    // proves the unchanged file was served from cache.
    expect(b).toBe(a);
  });

  it('edit-to-broken: a healthy tool edited to throw on import fails as a fresh failed step', async () => {
    const dir = await freshDir();
    await write(dir, 'marker.ts', markerTool('OK'));
    const cat = await loadToolCatalogue(dir, { reload: true });
    expect((await run(cat)).status).toBe('passed');

    await write(dir, 'marker.ts', `throw new Error('broken on import');\n`);
    const broken = await run(cat);
    expect(broken.status).toBe('failed');
    expect(broken.error).toMatch(/broken on import/);
  });

  it('edit-to-fix: a tool that failed to import recovers after an edit, no restart', async () => {
    const dir = await freshDir();
    await write(dir, 'marker.ts', `throw new Error('broken on import');\n`);
    const cat = await loadToolCatalogue(dir, { reload: true });
    expect((await run(cat)).status).toBe('failed');

    await write(dir, 'marker.ts', markerTool('FIXED'));
    const fixed = await run(cat);
    expect(fixed.status).toBe('passed');
    expect(fixed.marker).toBe('FIXED');
  });

  it('recovers when a deleted helper is recreated, even though the entry is untouched', async () => {
    // A bundle failure has no metafile, so the error-state load can't know the
    // helper set. Errored loads must therefore always retry — otherwise a tool
    // that *was working* stays broken after the helper is fixed/recreated until
    // the entry file changes (the stale-edit class this issue targets).
    const dir = await freshDir();
    await write(dir, 'helper.ts', `export const value = 'H1';\n`);
    await write(
      dir,
      'marker.ts',
      `import { defineTool } from 'steptix/tools';
import { value } from './helper.js';
export default defineTool({
  name: 'marker', parameters: {}, outputs: { marker: { type: 'string' } },
  async run(_args, { step }) { step.setVar('marker', value); },
});
`,
    );
    const cat = await loadToolCatalogue(dir, { reload: true });
    expect((await run(cat)).marker).toBe('H1');

    // Delete the helper → the tool fails to bundle.
    await fs.rm(path.join(dir, 'helper.ts'));
    expect((await run(cat)).status).toBe('failed');

    // Recreate the helper with NEW content; marker.ts (the entry) is untouched.
    await write(dir, 'helper.ts', `export const value = 'H2';\n`);
    const recovered = await run(cat);
    expect(recovered.status).toBe('passed');
    expect(recovered.marker).toBe('H2');
  });

  it('picks up an edit to a bundled relative helper (signature covers bundle inputs)', async () => {
    const dir = await freshDir();
    await write(dir, 'helper.ts', `export const value = 'HELPER_V1';\n`);
    await write(
      dir,
      'marker.ts',
      `import { defineTool } from 'steptix/tools';
import { value } from './helper.js';
export default defineTool({
  name: 'marker',
  parameters: {},
  outputs: { marker: { type: 'string' } },
  async run(_args, { step }) { step.setVar('marker', value); },
});
`,
    );
    const cat = await loadToolCatalogue(dir, { reload: true });
    expect((await run(cat)).marker).toBe('HELPER_V1');

    // Edit ONLY the helper — the entry file's mtime/content is untouched.
    await write(dir, 'helper.ts', `export const value = 'HELPER_V2';\n`);
    expect((await run(cat)).marker).toBe('HELPER_V2');
  });
});

describe('tool reload — direct-import (CLI) path stays load-once', () => {
  it('a non-reload catalogue imports once and does not re-import on edit', async () => {
    const dir = await freshDir();
    await write(dir, 'marker.ts', markerTool('V1'));
    const cat = await loadToolCatalogue(dir); // no { reload: true }

    const a = await cat.resolve('marker');
    await write(dir, 'marker.ts', markerTool('V2'));
    const b = await cat.resolve('marker');
    // Load-once: same object, edit not observed (correct for the one-shot CLI).
    expect(b).toBe(a);
  });
});

describe('refreshIndex — added / removed files (issue 033 Part 2)', () => {
  it('discovers a file added after the initial scan', async () => {
    const dir = await freshDir();
    await write(dir, 'marker.ts', markerTool('FIRST'));
    const cat = await loadToolCatalogue(dir, { reload: true });
    expect(cat.indexedCount).toBe(1);

    await write(dir, 'second.ts', markerTool('SECOND').replace("name: 'marker'", "name: 'second'"));
    await cat.refreshIndex();
    expect(cat.indexedCount).toBe(2);

    const out = await run(cat, 'second');
    expect(out.status).toBe('passed');
    expect(out.marker).toBe('SECOND');
  });

  it('drops a deleted file (clean not-found), and a recreate re-imports fresh', async () => {
    const dir = await freshDir();
    await write(dir, 'marker.ts', markerTool('V1'));
    const cat = await loadToolCatalogue(dir, { reload: true });
    expect((await run(cat)).marker).toBe('V1');

    await fs.rm(path.join(dir, 'marker.ts'));
    await cat.refreshIndex();
    expect(cat.indexedCount).toBe(0);
    await expect(cat.resolve('marker')).rejects.toThrow(/not found in catalogue/);

    // Recreate with new behaviour → re-imported fresh (no stale hit).
    await write(dir, 'marker.ts', markerTool('V2'));
    await cat.refreshIndex();
    expect((await run(cat)).marker).toBe('V2');
  });

  it('is import-free: re-walk updates the index without importing any file', async () => {
    const dir = await freshDir();
    await write(dir, 'marker.ts', markerTool('V1'));
    const cat = await loadToolCatalogue(dir, { reload: true });
    await write(dir, 'second.ts', markerTool('S').replace("name: 'marker'", "name: 'second'"));

    await cat.refreshIndex();
    expect(cat.indexedCount).toBe(2);
    // Nothing imported yet — `size` counts loaded tools, which stays 0 until a
    // resolve. This protects the lazy invariant.
    expect(cat.size).toBe(0);
  });

  it('no-ops on a directly-constructed catalogue (no scanned dir)', async () => {
    const cat = new ToolCatalogue();
    await expect(cat.refreshIndex()).resolves.toBeUndefined();
    expect(cat.indexedCount).toBe(0);
  });

  it('degrades to "missing" when the dir is deleted mid-session', async () => {
    const dir = await freshDir();
    await write(dir, 'marker.ts', markerTool('V1'));
    const cat = await loadToolCatalogue(dir, { reload: true });
    await cat.resolve('marker'); // load something so byFile is non-empty
    expect(cat.indexedCount).toBe(1);

    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await cat.refreshIndex();
    expect(cat.indexedCount).toBe(0);
    expect(cat.diagnostics?.toolsDirMissing).toBe(true);
    // The not-found hint now reflects reality ("does not exist").
    expect(cat.buildNotFoundMessage('marker')).toMatch(/does not exist/);
  });

  it('picks up a dir that was missing at first scan once it is created', async () => {
    const dir = path.join(tmpBase, `t${counter++}`); // not created yet
    const cat = await loadToolCatalogue(dir, { reload: true });
    expect(cat.diagnostics?.toolsDirMissing).toBe(true);

    await write(dir, 'marker.ts', markerTool('LATE'));
    await cat.refreshIndex();
    expect(cat.diagnostics?.toolsDirMissing).toBe(false);
    expect(cat.indexedCount).toBe(1);
    expect((await run(cat)).marker).toBe('LATE');
  });
});

describe('reload concurrency + import.meta (issue 033 round-2)', () => {
  it('concurrent bundleAndImport of the same file/cacheDir all succeed (no temp-file race)', async () => {
    // Two sessions sharing one toolsDir can bundle the same content into the
    // same .steptix-tool-cache concurrently. A content-hash-only temp name would
    // collide and one finisher's delete would strand the others' import().
    const dir = await freshDir();
    await write(dir, 'race.ts', markerTool('RACE'));
    const toolFile = path.join(dir, 'race.ts');
    const cacheDir = resolveToolCacheDir(dir);

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => bundleAndImport(toolFile, cacheDir)),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    for (const r of results) {
      expect(r.status === 'fulfilled' && (r.value.module.default as { name?: string })?.name).toBe(
        'marker',
      );
    }
  });

  it('import.meta.url resolves to the original .ts, not the temp module in the cache dir', async () => {
    // A tool resolving a sibling resource via import.meta.url must see its real
    // location (CLI parity), not the bundled temp .mjs under .steptix-tool-cache.
    const dir = await freshDir();
    await write(
      dir,
      'meta.ts',
      `import { defineTool } from 'steptix/tools';
export default defineTool({
  name: 'meta', parameters: {}, outputs: { marker: { type: 'string' } },
  async run(_args, { step }) { step.setVar('marker', import.meta.url); },
});
`,
    );
    const cat = await loadToolCatalogue(dir, { reload: true });
    const out = await run(cat, 'meta');
    expect(out.status).toBe('passed');
    expect(out.marker).toMatch(/meta\.ts$/);
    expect(out.marker).not.toContain(TOOL_CACHE_DIRNAME);
  });
});

describe('reload helpers', () => {
  it('resolveToolCacheDir is a dot-dir inside the tools dir', () => {
    const cacheDir = resolveToolCacheDir('/some/tools');
    expect(path.basename(cacheDir)).toBe(TOOL_CACHE_DIRNAME);
    expect(cacheDir).toBe(path.join(path.resolve('/some/tools'), TOOL_CACHE_DIRNAME));
  });

  it('step-into: bundle sources resolve (from the cache dir) to the original .ts, not a bogus path', async () => {
    // Guards the step-into regression: esbuild must emit sourcemap `sources`
    // relative to where the temp .mjs lives (cacheDir), because a debugger
    // resolves them against the .mjs's own dir. Anchored at process.cwd()
    // instead, they'd resolve to a nonexistent nested path and breakpoints in
    // the user's .ts wouldn't bind.
    const dir = await freshDir();
    await write(dir, 'helper.ts', `export const value = 'H';\n`);
    await write(
      dir,
      'mark.ts',
      `import { defineTool } from 'steptix/tools';
import { value } from './helper.js';
export default defineTool({
  name: 'mark', parameters: {}, outputs: { mark: { type: 'string' } },
  async run(_args, { step }) { step.setVar('mark', value); },
});
`,
    );
    const cacheDir = resolveToolCacheDir(dir);
    const { contents } = await bundleToolModule(path.join(dir, 'mark.ts'), cacheDir);

    const text = Buffer.from(contents).toString('utf8');
    const m = text.match(/sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)/);
    expect(m).toBeTruthy();
    const map = JSON.parse(Buffer.from(m![1]!, 'base64').toString('utf8')) as { sources: string[] };

    // A debugger resolves `sources` against the .mjs's own directory (cacheDir).
    const resolved = map.sources.map((s) => path.normalize(path.resolve(cacheDir, s)));
    expect(resolved).toContain(path.normalize(path.join(dir, 'mark.ts')));
    expect(resolved).toContain(path.normalize(path.join(dir, 'helper.ts')));
    // The cwd-relative bug produced sources that nested the cache-dir segments
    // back into the path — assert that can't happen.
    for (const r of resolved) {
      expect(r.includes(TOOL_CACHE_DIRNAME)).toBe(false);
    }
  });

  it('signatureOf is stable for unchanged content and moves when content changes', async () => {
    const dir = await freshDir();
    const a = path.join(dir, 'a.ts');
    const b = path.join(dir, 'b.ts');
    await fs.writeFile(a, 'export const x = 1;');
    await fs.writeFile(b, 'export const y = 2;');

    const sig1 = await signatureOf([a, b]);
    expect(await signatureOf([a, b])).toBe(sig1); // re-read, same content → equal
    expect(await signatureOf([b, a])).toBe(sig1); // order-independent

    await fs.writeFile(b, 'export const y = 3;'); // content change
    expect(await signatureOf([a, b])).not.toBe(sig1);

    await fs.rm(b); // deleting a still-listed input registers as a change
    expect(await signatureOf([a, b])).not.toBe(sig1);
  });
});

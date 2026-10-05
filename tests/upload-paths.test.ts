/**
 * Where a file named in a step actually lives — stories/upload-action.md §3.
 *
 * The rule under test: a path in a step is relative to the TEST FILE's folder,
 * fenced to the project root, and every failure is non-retryable because no
 * amount of re-planning by the model makes a missing file appear.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  normaliseUploadPath,
  resolveUploadPaths,
  resolveUploadPathSync,
  uploadPathsOf,
  isNonRetryable,
} from '../src/browser/upload-paths.js';

const BS = String.fromCharCode(92);

let root: string;
let testDir: string;
let ctx: { baseDir: string; projectRoot: string };

beforeAll(async () => {
  // A miniature project: <root>/steptix.config.json, <root>/tests/attachments/logo.png
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'steptix-upload-paths-'));
  testDir = path.join(root, 'tests');
  await fs.mkdir(path.join(testDir, 'attachments'), { recursive: true });
  await fs.mkdir(path.join(testDir, '..cache'), { recursive: true });
  await fs.writeFile(path.join(root, 'steptix.config.json'), '{}');
  await fs.writeFile(path.join(testDir, 'attachments', 'logo.png'), 'png-bytes');
  await fs.writeFile(path.join(testDir, '..cache', 'kept.png'), 'png-bytes');
  await fs.writeFile(path.join(root, 'shared.png'), 'png-bytes');
  ctx = { baseDir: testDir, projectRoot: root };
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const err = (r: unknown): string => (r as { error?: string }).error ?? '';
const abs = (r: unknown): string[] => (r as { absolute?: string[] }).absolute ?? [];

describe('normaliseUploadPath', () => {
  it('folds a Windows-style step path into a forward-slashed one', () => {
    expect(normaliseUploadPath(`${BS}attachments${BS}logo.png`)).toBe('/attachments/logo.png');
    expect(normaliseUploadPath(`attachments${BS}logo.png`)).toBe('attachments/logo.png');
  });

  // The leading separator is kept so a POSIX absolute path survives to the
  // resolver; it still reads test-relative first (see "a rooted path" below).
  it('keeps one leading separator and collapses repeats', () => {
    expect(normaliseUploadPath('/attachments/logo.png')).toBe('/attachments/logo.png');
    expect(normaliseUploadPath('/a//b.png')).toBe('/a/b.png');
    expect(normaliseUploadPath('a//b.png')).toBe('a/b.png');
  });

  it('leaves drive-letter, UNC and file:// paths absolute', () => {
    expect(normaliseUploadPath(`C:${BS}x${BS}y.png`)).toBe('C:/x/y.png');
    expect(normaliseUploadPath('//srv/share/a.png')).toBe('//srv/share/a.png');
    expect(normaliseUploadPath('file:///C:/x.png')).toBe('file:///C:/x.png');
  });

  it('leaves any scheme://url alone — a URL is not a path', () => {
    // This function also widens the code-behind leak guard over EVERY guarded
    // value, not only paths, so collapsing the `//` in an environment URL
    // would corrupt it.
    expect(normaliseUploadPath('https://uat.example/')).toBe('https://uat.example/');
    expect(normaliseUploadPath('http://localhost:8787/a')).toBe('http://localhost:8787/a');
  });

  it('trims, and leaves ordinary characters alone', () => {
    expect(normaliseUploadPath('  spaced name.png  ')).toBe('spaced name.png');
    expect(normaliseUploadPath('a/b#1?2.png')).toBe('a/b#1?2.png');
  });
});

describe('uploadPathsOf', () => {
  it('reads either field as one shape, preferring the plural', () => {
    expect(uploadPathsOf({ filePath: 'a.png' })).toEqual(['a.png']);
    expect(uploadPathsOf({ filePaths: ['a.png', 'b.png'] })).toEqual(['a.png', 'b.png']);
    expect(uploadPathsOf({ filePath: 'a.png', filePaths: ['b.png'] })).toEqual(['b.png']);
    expect(uploadPathsOf({})).toEqual([]);
    expect(uploadPathsOf({ filePath: '', filePaths: [] })).toEqual([]);
  });
});

describe('resolveUploadPaths', () => {
  it('resolves against the test file folder, not the process cwd', async () => {
    const result = await resolveUploadPaths(['attachments/logo.png'], ctx);
    expect(result.ok).toBe(true);
    expect(abs(result)).toEqual([path.join(testDir, 'attachments', 'logo.png')]);
  });

  it('accepts the backslash spelling a Windows author writes', async () => {
    const result = await resolveUploadPaths([`${BS}attachments${BS}logo.png`], ctx);
    expect(abs(result)).toEqual([path.join(testDir, 'attachments', 'logo.png')]);
  });

  it('keeps the order it was given', async () => {
    const result = await resolveUploadPaths(
      ['attachments/logo.png', '../shared.png'],
      ctx,
    );
    expect(abs(result)).toEqual([
      path.join(testDir, 'attachments', 'logo.png'),
      path.join(root, 'shared.png'),
    ]);
  });

  it('allows `..` that stays inside the project', async () => {
    const result = await resolveUploadPaths(['../shared.png'], ctx);
    expect(result.ok).toBe(true);
  });

  it('allows a folder whose name merely starts with dots', async () => {
    // The fence must test for a `..` SEGMENT, not a `..` prefix — otherwise a
    // real directory called `..cache` inside the project is refused.
    const result = await resolveUploadPaths(['..cache/kept.png'], ctx);
    expect(result.ok, err(result)).toBe(true);
  });

  it('refuses a path that escapes the project root', async () => {
    const result = await resolveUploadPaths(['../../../../outside.png'], ctx);
    expect(result.ok).toBe(false);
    expect(err(result)).toContain('outside the project folder');
    expect(err(result)).toContain(root);
    expect((result as { retryable?: unknown }).retryable).toBe(false);
  });

  it('fences at the base folder when the project has no config file', async () => {
    const noProject = { baseDir: testDir, projectRoot: null };
    expect((await resolveUploadPaths(['attachments/logo.png'], noProject)).ok).toBe(true);
    const out = await resolveUploadPaths(['../shared.png'], noProject);
    expect(out.ok).toBe(false);
    expect(err(out)).toContain('outside the project folder');
  });

  it('names the absolute path AND the folder it came from when the file is missing', async () => {
    const result = await resolveUploadPaths(['attachments/nope.png'], ctx);
    expect(result.ok).toBe(false);
    expect(err(result)).toContain(`Upload file not found: ${path.join(testDir, 'attachments', 'nope.png')}`);
    expect(err(result)).toContain('attachments/nope.png');
    expect(err(result)).toContain(testDir);
    expect(err(result)).toContain('correct the step');
  });

  it('refuses a folder', async () => {
    const result = await resolveUploadPaths(['attachments'], ctx);
    expect(err(result)).toContain('is a folder, not a file');
  });

  it('refuses a relative path when the run has no test file', async () => {
    const result = await resolveUploadPaths(['a.png'], {});
    expect(err(result)).toContain('no test file to resolve it against');
    expect((result as { retryable?: unknown }).retryable).toBe(false);
  });

  it('accepts an absolute path with no test file, and still fences when it can', async () => {
    const inside = path.join(testDir, 'attachments', 'logo.png');
    expect((await resolveUploadPaths([inside], {})).ok).toBe(true);
    const fenced = await resolveUploadPaths([inside], { projectRoot: path.join(root, 'elsewhere') });
    expect(fenced.ok).toBe(false);
  });

  it('refuses a file URL carrying a fragment or query', async () => {
    // Node drops both silently, so the URL would name a different file.
    const frag = await resolveUploadPaths(['file:///C:/x.png#1'], ctx);
    expect(err(frag)).toContain('would name a different file');
    const query = await resolveUploadPaths(['file:///C:/x.png?v=2'], ctx);
    expect(err(query)).toContain('would name a different file');
  });

  it('refuses an empty path list with an actionable message', async () => {
    const result = await resolveUploadPaths([], ctx);
    expect(err(result)).toContain('requires "filePath" or "filePaths"');
  });

  it('leaves a MALFORMED action retryable, unlike a missing file', async () => {
    // A model that put the path in the wrong field can fix that next turn —
    // which is exactly what a retry is for. Only facts about the world (a
    // missing file, a fence breach) are worth ending the step on.
    const result = await resolveUploadPaths([], ctx);
    expect(result.ok).toBe(false);
    expect((result as { retryable?: unknown }).retryable).toBeUndefined();

    const missing = await resolveUploadPaths(['attachments/nope.png'], ctx);
    expect((missing as { retryable?: unknown }).retryable).toBe(false);
  });

  it('reports the FIRST failure when several paths are given', async () => {
    const result = await resolveUploadPaths(['attachments/nope.png', 'attachments/alsonope.png'], ctx);
    expect(err(result)).toContain('nope.png');
    expect(err(result)).not.toContain('alsonope.png');
  });

  it.runIf(process.platform === 'win32')(
    'compares the fence case-insensitively on Windows',
    async () => {
      const shouted = { baseDir: testDir, projectRoot: root.toUpperCase() };
      const result = await resolveUploadPaths(['attachments/logo.png'], shouted);
      expect(result.ok, err(result)).toBe(true);
    },
  );
});

// A rooted path is the one ambiguous shape: the test-relative spelling a
// Windows author writes, and — on Linux and macOS — how an absolute path is
// written. Test-relative wins on every platform; only POSIX falls back.
describe('a rooted path', () => {
  const posix = path.sep === '/';

  it('finds the file beside the test, on every platform', async () => {
    const result = await resolveUploadPaths(['/attachments/logo.png'], ctx);
    expect(abs(result)).toEqual([path.join(testDir, 'attachments', 'logo.png')]);
    expect(resolveUploadPathSync('/attachments/logo.png', ctx)).toBe(path.join(testDir, 'attachments', 'logo.png'));
  });

  it.runIf(posix)('on POSIX, falls back to the absolute path when nothing is beside the test', async () => {
    const shared = path.join(root, 'shared.png');
    const result = await resolveUploadPaths([shared], ctx);
    expect(result.ok, err(result)).toBe(true);
    expect(abs(result)).toEqual([shared]);
    expect(resolveUploadPathSync(shared, ctx)).toBe(shared);
  });

  it.runIf(posix)('on POSIX, prefers the file beside the test when both exist', async () => {
    const shared = path.join(root, 'shared.png');
    const beside = path.join(testDir, shared);
    await fs.mkdir(path.dirname(beside), { recursive: true });
    await fs.writeFile(beside, 'png-bytes');
    try {
      expect(abs(await resolveUploadPaths([shared], ctx))).toEqual([beside]);
    } finally {
      await fs.rm(path.join(testDir, shared.split('/')[1]!), { recursive: true, force: true });
    }
  });

  it.runIf(posix)('on POSIX, names both places when neither has the file', async () => {
    const result = await resolveUploadPaths(['/attachments/nope.png'], ctx);
    expect(err(result)).toContain(`Upload file not found: ${path.join(testDir, 'attachments', 'nope.png')}`);
    expect(err(result)).toContain('nor at /attachments/nope.png');
  });

  it.runIf(posix)('on POSIX, still fences an absolute path outside the project', async () => {
    // A folder of this run's own: a fixed name in the shared temp folder is
    // one another run on the machine can delete mid-test.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steptix-upload-outside-'));
    const outside = path.join(dir, 'outside.png');
    await fs.writeFile(outside, 'png-bytes');
    try {
      const result = await resolveUploadPaths([outside], ctx);
      expect(err(result)).toContain('outside the project folder');
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it.runIf(!posix)('on Windows, is test-relative only', async () => {
    const result = await resolveUploadPaths(['/attachments/nope.png'], ctx);
    expect(err(result)).toContain(`Upload file not found: ${path.join(testDir, 'attachments', 'nope.png')}`);
    expect(err(result)).not.toContain('nor at');
  });
});

describe('resolveUploadPathSync (the code-behind half)', () => {
  it('agrees with the async form', async () => {
    const sync = resolveUploadPathSync(`${BS}attachments${BS}logo.png`, ctx);
    expect([sync]).toEqual(abs(await resolveUploadPaths(['attachments/logo.png'], ctx)));
  });

  it('throws the same message, tagged non-retryable', () => {
    let thrown: unknown;
    try {
      resolveUploadPathSync('attachments/nope.png', ctx);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).message).toContain('Upload file not found');
    // Load-bearing: this is what stops the runner healing a code-behind entry
    // whose only fault is that the file is missing.
    expect(isNonRetryable(thrown)).toBe(true);
  });

  it('throws for a relative path with no base folder', () => {
    expect(() => resolveUploadPathSync('a.png', {})).toThrow(/no test file to resolve it against/);
  });
});

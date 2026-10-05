/**
 * The "Latest runs" section a run writes at the bottom of its test file
 * (src/report/history-appender.ts). Every runner suite mocks the appender, so
 * this is the one place its own behaviour is pinned: what the file holds
 * afterwards, and that the rewrite leaves nothing beside it — it writes a temp
 * file and renames it over the test, so a reader never sees half a file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendRunHistory } from '../src/report/history-appender.js';

let dir: string;
let testFile: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steptix-history-'));
  testFile = path.join(dir, 'login.md');
  await fs.writeFile(testFile, '# Login\n\n## Steps\n1. Open the page\n', 'utf-8');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const report = (n: number): string => path.join(dir, 'reports', `run-${n}.html`);

describe('appendRunHistory', () => {
  it('adds the section below the steps, leaving the test itself as it was', async () => {
    await appendRunHistory(testFile, report(1), 'passed', '2026-10-05T01:02:03.000Z', 'model-x');
    const text = await fs.readFile(testFile, 'utf-8');

    expect(text.startsWith('# Login\n\n## Steps\n1. Open the page\n\n<!-- latest-runs:start -->\n## Latest runs\n')).toBe(true);
    expect(text).toContain('- [2026-10-05 01:02:03Z — passed — model-x](file://');
    expect(text).toContain('run-1.html)');
    expect(text.endsWith('<!-- latest-runs:end -->\n')).toBe(true);
  });

  it('rewrites the one section on the next run, newest first, and keeps ten', async () => {
    for (let n = 1; n <= 12; n++) {
      await appendRunHistory(testFile, report(n), n % 2 ? 'passed' : 'failed', `2026-10-05T01:00:${String(n).padStart(2, '0')}.000Z`);
    }
    const text = await fs.readFile(testFile, 'utf-8');

    expect(text.match(/<!-- latest-runs:start -->/g)).toHaveLength(1);
    const entries = text.split('\n').filter((l) => l.startsWith('- ['));
    expect(entries).toHaveLength(10);
    expect(entries[0]).toContain('run-12.html');
    expect(entries[9]).toContain('run-3.html');
    expect(text).not.toContain('run-2.html');
  });

  it('leaves nothing beside the test file', async () => {
    await appendRunHistory(testFile, report(1), 'passed', '2026-10-05T01:02:03.000Z');
    await appendRunHistory(testFile, report(2), 'passed', '2026-10-05T01:02:04.000Z');
    expect(await fs.readdir(dir)).toEqual(['login.md']);
  });

  // Root writes through a read-only mode, so there is nothing to refuse there.
  it.skipIf(process.getuid?.() === 0)('refuses a read-only test file and leaves it as it was', async () => {
    const before = await fs.readFile(testFile, 'utf-8');
    // 0o444 is the read-only attribute on Windows, a read-only mode elsewhere.
    await fs.chmod(testFile, 0o444);
    try {
      const err = await appendRunHistory(testFile, report(1), 'passed', '2026-10-05T01:02:03.000Z').then(
        () => null,
        (e: NodeJS.ErrnoException) => e,
      );
      expect(err?.code).toMatch(/^(EACCES|EPERM)$/);
      expect(await fs.readFile(testFile, 'utf-8')).toBe(before);
      expect((await fs.stat(testFile)).mode & 0o222).toBe(0);
      expect(await fs.readdir(dir)).toEqual(['login.md']);
    } finally {
      await fs.chmod(testFile, 0o644);
    }
  });

  it('updates a symlinked test file at its target and leaves the link a link', async (ctx) => {
    const realDir = path.join(dir, 'real');
    await fs.mkdir(realDir);
    const target = path.join(realDir, 'login.md');
    await fs.rename(testFile, target);
    try {
      await fs.symlink(target, testFile, 'file');
    } catch {
      // File symlinks need admin or Developer Mode on Windows.
      ctx.skip('cannot create a file symlink here');
    }

    await appendRunHistory(testFile, report(1), 'passed', '2026-10-05T01:02:03.000Z');

    expect((await fs.lstat(testFile)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(target, 'utf-8')).toContain('run-1.html)');
    expect((await fs.readdir(dir)).sort()).toEqual(['login.md', 'real']);
    expect(await fs.readdir(realDir)).toEqual(['login.md']);
  });

  it.runIf(path.sep === '/')('keeps the test file\'s mode', async () => {
    await fs.chmod(testFile, 0o640);
    await appendRunHistory(testFile, report(1), 'passed', '2026-10-05T01:02:03.000Z');
    expect((await fs.stat(testFile)).mode & 0o777).toBe(0o640);
  });

  it('does nothing to a test file it cannot read', async () => {
    const missing = path.join(dir, 'gone.md');
    await appendRunHistory(missing, report(1), 'passed', '2026-10-05T01:02:03.000Z');
    expect(await fs.readdir(dir)).toEqual(['login.md']);
  });
});

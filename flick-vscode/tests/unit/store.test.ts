// Unit coverage for Store's JSON saves: two saves of one file land in the
// order they were made, and a failed save cleans up after itself without
// holding up the next. The filesystem calls a save makes are injected, so a
// test can hold one save part-way; everything else is a real temp directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Store } from '../../src/extension/store';
import type { SessionMeta } from '../../src/shared/protocol';

function session(id: string): SessionMeta {
  return { id, name: id, order: 0, stale: false, used: false };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flick-store-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function tempFilesIn(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'));
}

test('two saves of one file land in the order they were made', async () => {
  await withTempDir(async (dir) => {
    const written: string[] = [];
    let renames = 0;
    let releaseFirstRename!: () => void;
    const firstRenameReleased = new Promise<void>((resolve) => (releaseFirstRename = resolve));
    let signalFirstRename!: () => void;
    const firstRenameReached = new Promise<void>((resolve) => (signalFirstRename = resolve));

    const store = new Store(dir, {
      writeFile: async (file, text) => {
        written.push(text);
        await fs.writeFile(file, text, 'utf8');
      },
      rename: async (from, to) => {
        // Hold the older save at its rename, as a Windows retry would.
        if (++renames === 1) {
          signalFirstRename();
          await firstRenameReleased;
        }
        await fs.rename(from, to);
      },
    });

    try {
      const older = store.saveSessions([session('older')]);
      const newer = store.saveSessions([session('newer')]);
      await firstRenameReached;
      assert.equal(written.length, 1, 'the newer save must wait for the older one to finish');

      releaseFirstRename();
      await Promise.all([older, newer]);
      assert.deepEqual(
        (await store.loadSessions()).map((s) => s.id),
        ['newer'],
      );
      assert.deepEqual(await tempFilesIn(dir), []);
    } finally {
      releaseFirstRename();
    }
  });
});

test('a failed save removes its temp file and does not hold up the next save', async () => {
  await withTempDir(async (dir) => {
    let writes = 0;
    const store = new Store(dir, {
      writeFile: async (file, text) => {
        // The first save gets part of its temp file written, then fails.
        if (++writes === 1) {
          await fs.writeFile(file, text.slice(0, 5), 'utf8');
          throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
        }
        await fs.writeFile(file, text, 'utf8');
      },
      rename: (from, to) => fs.rename(from, to),
    });

    const failed = store.saveSessions([session('failed')]);
    const next = store.saveSessions([session('next')]);
    await assert.rejects(failed, { code: 'ENOSPC' });
    await next;

    assert.deepEqual(
      (await store.loadSessions()).map((s) => s.id),
      ['next'],
    );
    assert.deepEqual(await tempFilesIn(dir), []);
  });
});

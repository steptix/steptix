/**
 * The runtime folders and the records beside them
 * (docs/specs/SPEC-install.md §4.1–§4.3, §4.7, §8.3).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanUp,
  InstallError,
  installPackage,
  listRuntimes,
  markInUse,
  readChoice,
  readClientRecords,
  removeRuntimes,
  renamePatiently,
  selectRuntime,
  versionsInUse,
  versionsToKeep,
  withInstallLock,
  writeChoice,
  writeClientRecord,
  type Layout,
  type Runtime,
} from '../src/launcher/runtimes.js';
import { makeScratch, npmPackageDir, removeScratch, scratchLayout, writeFakePackage, writeFakeRuntime } from './launcher-helpers.js';

let scratch: string;
let layout: Layout;

beforeEach(() => {
  scratch = makeScratch('steptix-runtimes-');
  layout = scratchLayout(scratch);
});

afterEach(() => removeScratch(scratch));

const runtime = (version: string): Runtime => ({ version, dir: `/r/${version}`, source: 'npm' });

describe('listRuntimes', () => {
  it('lists only complete steptix packages named by their version, oldest first', () => {
    writeFakeRuntime(layout, '1.0.2');
    writeFakeRuntime(layout, '1.0.10');
    // A folder from the retired Windows installer: the package is under server/.
    writeFakePackage(path.join(layout.runtimesDir, '0.9.0', 'server'), { version: '0.9.0' });
    // A package whose version is not its folder's name.
    writeFakePackage(path.join(layout.runtimesDir, '1.0.3'), { version: '1.0.4' });
    // A partial copy.
    writeFakePackage(path.join(layout.runtimesDir, '.partial-1.0.5-1-ab'), { version: '1.0.5' });

    expect(listRuntimes(layout).map((r) => [r.version, r.source])).toEqual([
      ['1.0.2', 'npm'],
      ['1.0.10', 'npm'],
    ]);
  });

  it('is empty when there is no runtimes folder', () => {
    expect(listRuntimes(layout)).toEqual([]);
  });
});

describe('installPackage', () => {
  it('copies the package under a temporary name, renames it into place, and records where it came from', async () => {
    const pkg = writeFakePackage(npmPackageDir(scratch), { version: '1.2.3', dependencies: { dep: '^1' }, bundled: ['dep'] });
    const copied: string[] = [];

    const result = await installPackage(pkg, layout, { onCopy: (v) => copied.push(v) });

    expect(result.installed).toBe(true);
    expect(result.runtime).toMatchObject({ version: '1.2.3', source: 'npm' });
    expect(copied).toEqual(['1.2.3']);
    expect(fs.existsSync(path.join(layout.runtimesDir, '1.2.3', 'node_modules', 'dep', 'package.json'))).toBe(true);
    expect(fs.readdirSync(layout.runtimesDir).filter((n) => n.startsWith('.partial-'))).toEqual([]);
  });

  it('copies nothing when that version is installed already', async () => {
    const pkg = writeFakePackage(npmPackageDir(scratch), { version: '1.2.3' });
    writeFakeRuntime(layout, '1.2.3', 'extension');
    const copied: string[] = [];

    const result = await installPackage(pkg, layout, { onCopy: (v) => copied.push(v) });

    expect(result).toMatchObject({ installed: false, runtime: { version: '1.2.3', source: 'extension' } });
    expect(copied).toEqual([]);
  });

  it('records an offline file as its source', async () => {
    const pkg = writeFakePackage(npmPackageDir(scratch), { version: '1.2.3', extra: { steptixDistribution: 'offline' } });
    expect((await installPackage(pkg, layout)).runtime.source).toBe('offline file');
  });

  it('refuses a package whose dependencies would not travel with the copy', async () => {
    // A local install: npm hoisted the dependency into the project's node_modules.
    const pkg = writeFakePackage(npmPackageDir(scratch), { version: '1.2.3', dependencies: { hoisted: '^1' } });
    writeFakePackage(path.join(scratch, 'npm', 'node_modules', 'hoisted'), { version: '1.0.0' });

    await expect(installPackage(pkg, layout)).rejects.toThrow(InstallError);
    await expect(installPackage(pkg, layout)).rejects.toThrow(/does not hold its own dependencies \(hoisted\)/);
    expect(listRuntimes(layout)).toEqual([]);
  });

  it('removes what an interrupted install left before copying', async () => {
    const pkg = writeFakePackage(npmPackageDir(scratch), { version: '1.2.3' });
    const leftover = path.join(layout.runtimesDir, '.partial-1.2.3-99-dead');
    writeFakePackage(leftover, { version: '1.2.3' });

    await installPackage(pkg, layout);

    expect(fs.existsSync(leftover)).toBe(false);
  });

  it('waits for another process installing, then uses what it installed', async () => {
    const pkg = writeFakePackage(npmPackageDir(scratch), { version: '1.2.3' });
    const other = 4242;
    fs.mkdirSync(layout.runtimesDir, { recursive: true });
    fs.writeFileSync(layout.lockFile, JSON.stringify({ pid: other, since: Date.now() }));
    let waits = 0;
    const copied: string[] = [];

    const result = await installPackage(pkg, layout, {
      isAlive: (pid) => pid === other,
      onWait: () => waits++,
      onCopy: (v) => copied.push(v),
      // The other process finishes while this one sleeps.
      sleep: async () => {
        writeFakeRuntime(layout, '1.2.3', 'extension');
        fs.rmSync(layout.lockFile);
      },
    });

    expect(waits).toBe(1);
    expect(copied).toEqual([]);
    expect(result).toMatchObject({ installed: false, runtime: { source: 'extension' } });
  });

  it('takes over a lock whose process has gone', async () => {
    const pkg = writeFakePackage(npmPackageDir(scratch), { version: '1.2.3' });
    fs.mkdirSync(layout.runtimesDir, { recursive: true });
    fs.writeFileSync(layout.lockFile, JSON.stringify({ pid: 4242, since: Date.now() }));

    const result = await installPackage(pkg, layout, {
      isAlive: () => false,
      sleep: () => Promise.reject(new Error('should not wait')),
    });

    expect(result.installed).toBe(true);
    expect(fs.existsSync(layout.lockFile)).toBe(false);
  });
});

describe('renamePatiently', () => {
  const busy = () => Object.assign(new Error('operation not permitted'), { code: 'EPERM' });

  it('tries again on Windows while a scanner holds a new file open', async () => {
    const from = path.join(scratch, 'from');
    fs.mkdirSync(from);
    const to = path.join(scratch, 'to');
    const rename = vi.spyOn(fs, 'renameSync');
    rename.mockImplementationOnce(() => { throw busy(); }).mockImplementationOnce(() => { throw busy(); });
    const waits: number[] = [];
    try {
      await renamePatiently(from, to, async (ms) => void waits.push(ms), 'win32');
    } finally {
      rename.mockRestore();
    }
    expect(waits).toEqual([100, 200]);
    expect(fs.existsSync(to)).toBe(true);
  });

  it('gives up at once elsewhere, where EPERM is a permission', async () => {
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw busy(); });
    const waits: number[] = [];
    try {
      await expect(renamePatiently('a', 'b', async (ms) => void waits.push(ms), 'linux')).rejects.toThrow('not permitted');
    } finally {
      rename.mockRestore();
    }
    expect(waits).toEqual([]);
  });
});

describe('withInstallLock', () => {
  it('lets one holder in at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const order: string[] = [];
    // Two holders in one process need two pids, or each would see its own lock.
    const first = withInstallLock(layout, async () => {
      order.push('first in');
      await gate;
      order.push('first out');
    }, { pid: 1 });
    const second = withInstallLock(layout, () => {
      order.push('second in');
    }, {
      pid: 2,
      isAlive: () => true,
      sleep: async () => {
        release();
        await first;
      },
    });

    await Promise.all([first, second]);
    expect(order).toEqual(['first in', 'first out', 'second in']);
  });
});

describe('selectRuntime', () => {
  const installed = ['1.3.9', '1.4.0', '1.4.2', '1.5.0'].map(runtime);

  it('runs the newest of the needed major.minor, never another one', () => {
    expect(selectRuntime(installed, '1.4.0', null)).toMatchObject({ runtime: { version: '1.4.2' }, chosen: false });
    expect(selectRuntime(installed, '1.4.3', null).runtime).toBeNull();
    expect(selectRuntime(installed, '1.6.0', null).runtime).toBeNull();
  });

  it('runs a chosen version whatever its major.minor', () => {
    expect(selectRuntime(installed, '1.4.0', '1.3.9')).toMatchObject({ runtime: { version: '1.3.9' }, chosen: true });
  });

  it('sets aside a chosen version that is no longer installed, and says which', () => {
    expect(selectRuntime(installed, '1.4.0', '1.4.1')).toMatchObject({
      runtime: { version: '1.4.2' },
      chosen: false,
      chosenMissing: '1.4.1',
    });
  });
});

describe('the choice', () => {
  it('is written, read back, and cleared', () => {
    expect(readChoice(layout)).toBeNull();
    writeChoice(layout, '1.4.0');
    expect(readChoice(layout)).toBe('1.4.0');
    writeChoice(layout, null);
    expect(readChoice(layout)).toBeNull();
  });
});

describe('versionsToKeep', () => {
  const runtimes = ['1.3.0', '1.3.1', '1.4.0', '1.4.1', '1.4.2', '1.5.0', '1.5.1'].map(runtime);
  const client = (requires: string) => ({ kind: 'vscode', version: requires, requires, location: '/x' });

  it('keeps the newest of each needed major.minor, the newest and the one before it', () => {
    const keep = versionsToKeep({ runtimes, clients: [client('1.3.0'), client('1.4.0')], choice: null, inUse: new Set() });
    expect([...keep].sort()).toEqual(['1.3.1', '1.4.2', '1.5.0', '1.5.1']);
  });

  it('keeps a chosen version, one in use, and one about to run', () => {
    const keep = versionsToKeep({
      runtimes,
      clients: [],
      choice: '1.3.0',
      inUse: new Set(['1.4.0']),
      extra: ['1.4.1'],
    });
    expect([...keep].sort()).toEqual(['1.3.0', '1.4.0', '1.4.1', '1.5.0', '1.5.1']);
  });
});

describe('in use', () => {
  it('marks a version for as long as its process lives', () => {
    const unmark = markInUse(layout, '1.4.0', { pid: 111 });
    markInUse(layout, '1.4.0', { pid: 222 });
    markInUse(layout, '1.5.0', { pid: 333 });

    const alive = new Set([111, 222]);
    expect(versionsInUse(layout, { isAlive: (pid) => alive.has(pid) })).toEqual(new Map([['1.4.0', [111, 222]]]));
    // The mark of the process that went is cleared on the way.
    expect(fs.readdirSync(layout.inUseDir).sort()).toEqual(['1.4.0@111', '1.4.0@222']);

    unmark();
    expect(versionsInUse(layout, { isAlive: () => true })).toEqual(new Map([['1.4.0', [222]]]));
  });
});

describe('client records', () => {
  it('keeps one record per installed client and drops one whose folder has gone', () => {
    const here = path.join(scratch, 'ext');
    fs.mkdirSync(here);
    writeClientRecord(layout, { kind: 'vscode', version: '1.4.0', requires: '1.4.0', location: here });
    writeClientRecord(layout, { kind: 'vscode', version: '1.4.1', requires: '1.4.0', location: here });
    writeClientRecord(layout, { kind: 'launcher', version: '1.3.0', requires: '1.3.0', location: path.join(scratch, 'gone') });

    expect(readClientRecords(layout)).toEqual([{ kind: 'vscode', version: '1.4.1', requires: '1.4.0', location: here }]);
    expect(fs.readdirSync(layout.clientsDir)).toHaveLength(1);
  });
});

describe('removing', () => {
  it('removes what it is given, except a version in use', () => {
    writeFakeRuntime(layout, '1.4.0');
    writeFakeRuntime(layout, '1.4.1');
    markInUse(layout, '1.4.1', { pid: 555 });

    const result = removeRuntimes(layout, listRuntimes(layout), { isAlive: (pid) => pid === 555 });

    expect(result).toEqual({ removed: ['1.4.0'], skipped: [{ version: '1.4.1', reason: 'running' }] });
    expect(listRuntimes(layout).map((r) => r.version)).toEqual(['1.4.1']);
    expect(fs.readdirSync(layout.runtimesDir).filter((n) => n.startsWith('.removing-'))).toEqual([]);
  });

  it('cleans up only what nothing needs', async () => {
    for (const v of ['1.3.0', '1.4.0', '1.4.1', '1.4.2']) writeFakeRuntime(layout, v);
    const ext = path.join(scratch, 'ext');
    fs.mkdirSync(ext);
    writeClientRecord(layout, { kind: 'vscode', version: '1.3.0', requires: '1.3.0', location: ext });

    const result = await cleanUp(layout, { isAlive: () => false });

    expect(result?.removed).toEqual(['1.4.0']);
    expect(listRuntimes(layout).map((r) => r.version)).toEqual(['1.3.0', '1.4.1', '1.4.2']);
  });

  it('skips the clean-up while another process holds the lock', async () => {
    writeFakeRuntime(layout, '1.4.0');
    writeFakeRuntime(layout, '1.4.1');
    writeFakeRuntime(layout, '1.4.2');
    fs.writeFileSync(layout.lockFile, JSON.stringify({ pid: 4242, since: Date.now() }));

    expect(await cleanUp(layout, { isAlive: () => true })).toBeUndefined();
    expect(listRuntimes(layout)).toHaveLength(3);
  });
});

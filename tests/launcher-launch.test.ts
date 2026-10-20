/**
 * The launch step every `steptix` command starts with
 * (docs/specs/SPEC-install.md §4.2, §5.1, §6.1, §6.5).
 *
 * Each case gives prepareLaunch its own store, so no launch is left on
 * globalThis, and stubs the hooks a real runtime gets.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentLaunch, installKindOf, prepareLaunch, type LaunchDeps } from '../src/launcher/launch.js';
import { listRuntimes, readClientRecords, writeChoice, type Layout } from '../src/launcher/runtimes.js';
import { makeScratch, npmPackageDir, removeScratch, scratchLayout, writeFakePackage, writeFakeRuntime } from './launcher-helpers.js';

let scratch: string;
let layout: Layout;
let logged: string[];
let hooked: string[];
let store: object;

beforeEach(() => {
  scratch = makeScratch('steptix-launch-');
  layout = scratchLayout(scratch);
  logged = [];
  hooked = [];
  store = {};
});

afterEach(() => removeScratch(scratch));

function deps(packageRoot: string): LaunchDeps {
  return {
    packageRoot,
    userRoot: layout.root,
    store,
    log: (line) => logged.push(line),
    applyHooks: async (dir) => {
      hooked.push(dir);
    },
    onExit: () => {},
  };
}

const entryOf = (version: string) => pathToFileURL(path.join(layout.runtimesDir, version, 'dist', 'index.js')).href;

describe('installKindOf', () => {
  it('tells a checkout, an npm install and a runtime apart', () => {
    const checkout = writeFakePackage(path.join(scratch, 'checkout'), { version: '1.0.0' });
    const npm = writeFakePackage(npmPackageDir(scratch), { version: '1.0.0' });
    const runtime = writeFakeRuntime(layout, '1.0.0');
    expect(installKindOf(checkout)).toBe('checkout');
    expect(installKindOf(npm)).toBe('npm');
    expect(installKindOf(runtime)).toBe('runtime');
  });
});

describe('from npm', () => {
  it('sets itself up on the first command, then hands off to the copy', async () => {
    const npm = writeFakePackage(npmPackageDir(scratch), { version: '1.4.0' });

    const plan = await prepareLaunch(['run', 'tests/a.md'], deps(npm));

    expect(logged).toEqual(['Setting up Steptix 1.4.0 (first run only)…']);
    expect(plan).toMatchObject({ kind: 'hand-off', entry: entryOf('1.4.0') });
    expect(hooked).toEqual([path.join(layout.runtimesDir, '1.4.0')]);
    expect(currentLaunch({ store })).toMatchObject({ launcherKind: 'npm', runtime: { version: '1.4.0' }, chosen: false });
  });

  it('records itself, so the clean-up keeps a server it needs', async () => {
    const npm = writeFakePackage(npmPackageDir(scratch), { version: '1.4.0' });
    await prepareLaunch(['--version'], deps(npm));
    expect(readClientRecords(layout)).toEqual([
      { kind: 'launcher', version: '1.4.0', requires: '1.4.0', location: fs.realpathSync.native(npm) },
    ]);
  });

  it('copies nothing on later commands', async () => {
    const npm = writeFakePackage(npmPackageDir(scratch), { version: '1.4.0' });
    await prepareLaunch(['list'], deps(npm));
    logged = [];
    store = {};

    expect(await prepareLaunch(['list'], deps(npm))).toMatchObject({ kind: 'hand-off', entry: entryOf('1.4.0') });
    expect(logged).toEqual([]);
  });

  it('runs a newer patch of its major.minor that is installed, without copying itself', async () => {
    const npm = writeFakePackage(npmPackageDir(scratch), { version: '1.4.0' });
    writeFakeRuntime(layout, '1.4.3', 'extension');

    expect(await prepareLaunch(['list'], deps(npm))).toMatchObject({ kind: 'hand-off', entry: entryOf('1.4.3') });
    expect(listRuntimes(layout).map((r) => r.version)).toEqual(['1.4.3']);
  });

  it('copies itself after npm updated it, beside the version it replaces', async () => {
    writeFakeRuntime(layout, '1.4.0');
    const npm = writeFakePackage(npmPackageDir(scratch), { version: '1.4.1' });

    expect(await prepareLaunch(['list'], deps(npm))).toMatchObject({ kind: 'hand-off', entry: entryOf('1.4.1') });
    expect(listRuntimes(layout).map((r) => r.version)).toEqual(['1.4.0', '1.4.1']);
  });

  it('never runs another major.minor that it did not choose', async () => {
    writeFakeRuntime(layout, '1.5.0');
    const npm = writeFakePackage(npmPackageDir(scratch), { version: '1.4.0' });

    expect(await prepareLaunch(['list'], deps(npm))).toMatchObject({ kind: 'hand-off', entry: entryOf('1.4.0') });
  });

  it('runs the version chosen with steptix server use', async () => {
    writeFakeRuntime(layout, '1.3.0');
    writeChoice(layout, '1.3.0');
    const npm = writeFakePackage(npmPackageDir(scratch), { version: '1.4.0' });

    expect(await prepareLaunch(['list'], deps(npm))).toMatchObject({ kind: 'hand-off', entry: entryOf('1.3.0') });
    expect(currentLaunch({ store })).toMatchObject({ chosen: true });
  });

  it('says so when the chosen version is gone, and runs the newest instead', async () => {
    writeChoice(layout, '1.3.0');
    const npm = writeFakePackage(npmPackageDir(scratch), { version: '1.4.0' });

    expect(await prepareLaunch(['list'], deps(npm))).toMatchObject({ kind: 'hand-off', entry: entryOf('1.4.0') });
    expect(logged.at(-1)).toMatch(/You chose Steptix server 1\.3\.0 .* no longer installed.*steptix server use newest/);
  });

  it('runs from npm\'s folder, saying why, when the Steptix folder cannot be written', async () => {
    const npm = writeFakePackage(npmPackageDir(scratch), { version: '1.4.0' });
    // A file where the runtimes folder should be.
    fs.mkdirSync(layout.root, { recursive: true });
    fs.writeFileSync(layout.runtimesDir, '');

    expect(await prepareLaunch(['list'], deps(npm))).toEqual({ kind: 'here' });
    expect(logged.join('\n')).toMatch(/^Could not set up Steptix 1\.4\.0 in .*\nRunning Steptix from .* this time\.$/);
    expect(hooked).toEqual([npm]);
  });

  describe('a local install, whose dependencies npm hoisted out of it', () => {
    const local = () => {
      writeFakePackage(path.join(scratch, 'npm', 'node_modules', 'hoisted'), { version: '1.0.0' });
      return writeFakePackage(npmPackageDir(scratch), { version: '1.4.0', dependencies: { hoisted: '^1' } });
    };

    it('runs itself, quietly, when no matching runtime is installed', async () => {
      const npm = local();
      expect(await prepareLaunch(['list'], deps(npm))).toEqual({ kind: 'here' });
      expect(logged).toEqual([]);
      expect(hooked).toEqual([npm]);
      expect(listRuntimes(layout)).toEqual([]);
    });

    it('hands off to a matching runtime that is installed', async () => {
      writeFakeRuntime(layout, '1.4.2');
      expect(await prepareLaunch(['list'], deps(local()))).toMatchObject({ kind: 'hand-off', entry: entryOf('1.4.2') });
      expect(logged).toEqual([]);
    });
  });

  it('sets nothing up for the commands that manage the runtimes', async () => {
    const npm = writeFakePackage(npmPackageDir(scratch), { version: '1.4.0' });
    for (const args of [['server', 'list'], ['uninstall']]) {
      store = {};
      expect(await prepareLaunch(args, deps(npm))).toEqual({ kind: 'here' });
    }
    expect(listRuntimes(layout)).toEqual([]);
    expect(hooked).toEqual([]);
  });

  it('removes versions nothing needs once it has picked one', async () => {
    for (const v of ['1.4.0', '1.4.1', '1.4.2']) writeFakeRuntime(layout, v);
    const npm = writeFakePackage(npmPackageDir(scratch), { version: '1.4.2' });

    await prepareLaunch(['list'], deps(npm));

    expect(listRuntimes(layout).map((r) => r.version)).toEqual(['1.4.1', '1.4.2']);
  });
});

describe('from a runtime folder', () => {
  it('runs itself when it is the newest of its major.minor', async () => {
    const dir = writeFakeRuntime(layout, '1.4.0');
    expect(await prepareLaunch(['serve'], deps(dir))).toEqual({ kind: 'here' });
    expect(hooked).toEqual([dir]);
  });

  it('hands off to the chosen version', async () => {
    const dir = writeFakeRuntime(layout, '1.4.0');
    writeFakeRuntime(layout, '1.3.0');
    writeChoice(layout, '1.3.0');
    expect(await prepareLaunch(['list'], deps(dir))).toMatchObject({ kind: 'hand-off', entry: entryOf('1.3.0') });
  });
});

describe('from a checkout', () => {
  it('runs here and touches nothing in the Steptix folder', async () => {
    const checkout = writeFakePackage(path.join(scratch, 'checkout'), { version: '1.4.0' });

    expect(await prepareLaunch(['serve'], deps(checkout))).toEqual({ kind: 'here' });
    expect(fs.existsSync(layout.root)).toBe(false);
    expect(hooked).toEqual([]);
  });
});

describe('a launch already made', () => {
  it('is the runtime it handed off to, which runs here', async () => {
    const npm = writeFakePackage(npmPackageDir(scratch), { version: '1.4.0' });
    await prepareLaunch(['list'], deps(npm));
    logged = [];
    hooked = [];

    // The same store: the runtime's copy of the launcher finds the launch.
    expect(await prepareLaunch(['list'], deps(path.join(layout.runtimesDir, '1.4.0')))).toEqual({ kind: 'here' });
    expect(logged).toEqual([]);
    expect(hooked).toEqual([]);
  });
});

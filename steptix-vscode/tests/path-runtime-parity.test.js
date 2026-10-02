/**
 * `steptix` on PATH runs the runtime the extension starts.
 *
 * The runtime installer puts packaging/runtime/bin/run-newest-runtime.cjs on
 * the user's Path. It chooses among the installed runtimes by a deliberate
 * copy of findInstalledRuntime, because it ships in the installer and not in
 * the extension. If the two drifted, a terminal and VS Code would quietly run
 * different versions. Each case below is a runtimes folder, and both must
 * name the same runtime, or none.
 *
 * The copy is the Windows choice (steptix.cmd is one of its launch files), so
 * it is compared with findInstalledRuntime(dir, 'win32') on every platform.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compareVersions, findInstalledRuntime } from '../src/extension/server-manager.ts';

const require = createRequire(import.meta.url);
const onPath = require('../../packaging/runtime/bin/run-newest-runtime.cjs');

const LAUNCH_FILES = ['runtime-launcher.cjs', 'server/dist/index.js', 'steptix.cmd'];

/** A runtimes folder: each name maps to the launch files its folder holds. */
function runtimesFolder(folders) {
  const dir = mkdtempSync(path.join(tmpdir(), 'steptix-path-runtimes-'));
  for (const [name, files] of Object.entries(folders)) {
    mkdirSync(path.join(dir, name), { recursive: true });
    for (const file of files) {
      const full = path.join(dir, name, ...file.split('/'));
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, '');
    }
  }
  return dir;
}

const complete = (...names) => Object.fromEntries(names.map((name) => [name, LAUNCH_FILES]));

const CASES = {
  'prereleases, by semver rather than by spelling': complete('1.0.0-beta.2', '1.0.0-beta.10', '0.9.0', '1.0.0-alpha.3'),
  'a release outranks its prereleases': complete('1.0.0-beta.1', '1.0.0', '1.0.0-rc.1'),
  'build metadata, and names that are not versions': complete('scratch', '1.0.0+build.5', '0.10.0', '0.9.9'),
  'only names that are not versions': complete('scratch', 'old'),
  'a newer folder an unfinished uninstall left without its launch files': {
    ...complete('1.0.0-beta.1'),
    '1.0.0-beta.2': ['runtime-launcher.cjs'],
  },
  'a folder without steptix.cmd': {
    ...complete('0.9.0'),
    '1.0.0': ['runtime-launcher.cjs', 'server/dist/index.js'],
  },
  'an empty runtimes folder': {},
};

for (const [name, folders] of Object.entries(CASES)) {
  test(`steptix on PATH and the extension pick the same runtime: ${name}`, () => {
    const dir = runtimesFolder(folders);
    assert.deepEqual(onPath.newestRuntime(dir), findInstalledRuntime(dir, 'win32'));
  });
}

test('steptix on PATH and the extension: no runtimes folder at all is null for both', () => {
  const dir = path.join(tmpdir(), 'steptix-no-such-runtimes-dir');
  assert.equal(onPath.newestRuntime(dir), null);
  assert.equal(findInstalledRuntime(dir, 'win32'), null);
});

test('steptix on PATH and the extension order versions the same way', () => {
  const versions = [
    '1.0.0', 'scratch', '1.0.0-beta.2', '1.0.0-beta', '0.10.0', '1.0.0-beta.11', '0.9.9', '1.0.0-beta.alpha',
    '1.0.0-rc.1', '2.0.0-0', '1.0.0+build.7', 'old', '10.0.0', '1.0.0-beta.2.1', '1.0.0-alpha-1',
  ];
  assert.deepEqual([...versions].sort(onPath.compareVersions), [...versions].sort(compareVersions));
});

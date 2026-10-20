/**
 * The rules the extension installs and picks servers by
 * (docs/specs/SPEC-install.md §4.2, §4.6, §5.3, §5.5, §6.5, §6.8, §8.4).
 */
import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  addShellRcLine,
  addToWindowsPath,
  binScripts,
  chooseNode,
  findOnPath,
  globalPackageDir,
  listInstalledServers,
  majorMinorOf,
  nodeArchiveFrom,
  nodeIsNewEnough,
  npmPackageOfCommand,
  npmSpecFor,
  parseNodeVersion,
  pickServer,
  readServerChoice,
  releaseLock,
  removeFromWindowsPath,
  removeShellRcLine,
  serverRequirement,
  serverSatisfies,
  shellRcFile,
  staleTerminalNotice,
  tryTakeLock,
  unsupportedPlatformMessage,
} from '../src/extension/install-core.ts';

const made = [];
function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'steptix-install-core-'));
  made.push(dir);
  return dir;
}
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

/** A runtime folder as the launcher leaves it. */
function writeRuntime(runtimesDir, version, { source = 'npm', record = true } = {}) {
  const dir = path.join(runtimesDir, version);
  mkdirSync(path.join(dir, 'dist'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'steptix', version }));
  writeFileSync(path.join(dir, 'dist', 'index.js'), `console.log('steptix ${version} ran: ' + process.argv.slice(2).join(' '));\n`);
  if (record) writeFileSync(path.join(dir, '.steptix-install.json'), JSON.stringify({ version, source }));
  return dir;
}

test('versions: the same major.minor, at least the patch asked for', () => {
  assert.equal(majorMinorOf('1.4.3'), '1.4');
  assert.equal(majorMinorOf('runtimes'), null);
  assert.equal(serverSatisfies('1.4.3', '1.4.0'), true);
  assert.equal(serverSatisfies('1.4.0', '1.4.2'), false);
  assert.equal(serverSatisfies('1.5.0', '1.4.0'), false);
  assert.equal(serverSatisfies('1.3.9', '1.4.0'), false);
});

test('the requirement: package.json may ask for a patch, else its own major.minor', () => {
  assert.equal(serverRequirement({ version: '1.4.1' }), '1.4.0');
  assert.equal(serverRequirement({ version: '1.4.1', steptixServer: '1.4.2' }), '1.4.2');
  assert.equal(npmSpecFor('1.4.2'), 'steptix@~1.4.2');
});

test('installed servers: only complete ones the launcher recorded, oldest first', () => {
  const dir = scratch();
  writeRuntime(dir, '1.0.10', { source: 'extension' });
  writeRuntime(dir, '1.0.2');
  writeRuntime(dir, '1.0.3', { record: false }); // not set up by an install
  mkdirSync(path.join(dir, '1.0.0-beta.1', 'server', 'dist'), { recursive: true }); // the Windows installer's layout
  writeRuntime(dir, '.partial-1.0.11-1-ab');
  assert.deepEqual(
    listInstalledServers(dir).map((s) => [s.version, s.source]),
    [
      ['1.0.2', 'npm'],
      ['1.0.10', 'extension'],
    ],
  );
});

test('picking: newest match, a chosen one that matches, never another major.minor', () => {
  const s = (version) => ({ version, dir: `/r/${version}`, source: 'npm' });
  const installed = ['1.3.9', '1.4.0', '1.4.2', '1.5.0'].map(s);
  assert.deepEqual(pickServer(installed, '1.4.0', null), { kind: 'run', server: s('1.4.2'), chosen: false });
  assert.deepEqual(pickServer(installed, '1.4.0', '1.4.0'), { kind: 'run', server: s('1.4.0'), chosen: true });
  assert.deepEqual(pickServer(installed, '1.4.0', '1.3.9'), { kind: 'chosen-mismatch', chosen: '1.3.9' });
  // A choice that is no longer installed is set aside, as the launcher does.
  assert.deepEqual(pickServer(installed, '1.4.0', '1.4.1'), { kind: 'run', server: s('1.4.2'), chosen: false });
  assert.deepEqual(pickServer(installed, '1.6.0', null), { kind: 'none' });
});

test('the choice is read from server-choice.json', () => {
  const root = scratch();
  assert.equal(readServerChoice(root), null);
  writeFileSync(path.join(root, 'server-choice.json'), JSON.stringify({ version: '1.3.0' }));
  assert.equal(readServerChoice(root), '1.3.0');
});

test('platforms: Windows x64 first, and a plain sentence for the rest', () => {
  assert.equal(unsupportedPlatformMessage('win32', 'x64'), null);
  assert.equal(
    unsupportedPlatformMessage('linux', 'arm64'),
    'Steptix does not run on Linux on ARM yet. Supported now: Windows x64.',
  );
  assert.equal(unsupportedPlatformMessage('darwin', 'arm64'), 'Steptix does not run on macOS on Apple Silicon yet. Supported now: Windows x64.');
  assert.equal(unsupportedPlatformMessage('linux', 'x64'), 'Steptix does not run on Linux x64 yet. Supported now: Windows x64.');
});

test('Node.js: 22.21 or later', () => {
  assert.equal(parseNodeVersion('v22.21.0\n'), '22.21.0');
  assert.equal(nodeIsNewEnough('22.21.0'), true);
  assert.equal(nodeIsNewEnough('24.1.0'), true);
  assert.equal(nodeIsNewEnough('22.20.9'), false);
  assert.equal(nodeIsNewEnough('20.11.1'), false);
});

test("choosing Node.js: the user's own when new enough, else Steptix's copy, else none", async () => {
  const root = scratch();
  const bin = path.join(root, 'path-bin');
  mkdirSync(bin);
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  writeFileSync(path.join(bin, exe), '');
  const env = { PATH: bin, Path: bin, PATHEXT: '.EXE' };
  const ownDir = path.join(root, 'node', '22.22.0');
  const ownExe = process.platform === 'win32' ? path.join(ownDir, 'node.exe') : path.join(ownDir, 'bin', 'node');
  mkdirSync(path.dirname(ownExe), { recursive: true });
  writeFileSync(ownExe, '');

  const yours = await chooseNode({ userRoot: root, env, platform: process.platform, versionOf: async () => '24.0.0' });
  assert.deepEqual(yours, { exe: path.join(bin, exe), version: '24.0.0', origin: 'yours' });

  const tooOld = await chooseNode({ userRoot: root, env, platform: process.platform, versionOf: async () => '20.11.0' });
  assert.deepEqual(tooOld, { exe: ownExe, version: '22.22.0', origin: 'steptix' });

  rmSync(path.join(root, 'node'), { recursive: true });
  assert.equal(await chooseNode({ userRoot: root, env, platform: process.platform, versionOf: async () => '20.11.0' }), null);
});

test('STEPTIX_NODE names the user\'s Node.js', async () => {
  const root = scratch();
  const named = path.join(root, 'my-node');
  const chosen = await chooseNode({
    userRoot: root,
    env: { STEPTIX_NODE: named, PATH: '' },
    platform: process.platform,
    versionOf: async (exe) => (exe === named ? '22.21.0' : null),
  });
  assert.deepEqual(chosen, { exe: named, version: '22.21.0', origin: 'yours' });
});

test("the Node.js archive to fetch, with the fingerprint nodejs.org publishes", () => {
  const shasums = [
    `${'a'.repeat(64)}  node-v22.22.1-darwin-arm64.tar.gz`,
    `${'b'.repeat(64)}  node-v22.22.1-linux-x64.tar.gz`,
    `${'c'.repeat(64)}  node-v22.22.1-linux-x64.tar.xz`,
    `${'d'.repeat(64)}  node-v22.22.1-win-x64.zip`,
    `${'e'.repeat(64)}  node-v22.22.1-win-x64.7z`,
  ].join('\n');
  assert.deepEqual(nodeArchiveFrom(shasums, 'win32', 'x64'), {
    file: 'node-v22.22.1-win-x64.zip',
    sha256: 'd'.repeat(64),
    version: '22.22.1',
  });
  assert.equal(nodeArchiveFrom(shasums, 'linux', 'x64').file, 'node-v22.22.1-linux-x64.tar.gz');
  assert.equal(nodeArchiveFrom(shasums, 'win32', 'arm64'), null);
});

test("npm's own steptix: found behind the command on PATH, never the extension's own script", () => {
  const root = scratch();
  const prefix = path.join(root, 'npm-prefix');
  const pkg = process.platform === 'win32' ? path.join(prefix, 'node_modules', 'steptix') : path.join(prefix, 'lib', 'node_modules', 'steptix');
  writeRuntime(path.dirname(pkg), 'steptix');
  // writeRuntime names the folder by its version; give it the package's name.
  rmSync(pkg, { recursive: true, force: true });
  mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'steptix', version: '1.4.0' }));
  writeFileSync(path.join(pkg, 'dist', 'index.js'), '');
  assert.equal(globalPackageDir(prefix, process.platform), pkg);

  const ownBin = path.join(root, 'steptix-root', 'bin');
  mkdirSync(ownBin, { recursive: true });
  let command;
  if (process.platform === 'win32') {
    command = path.join(prefix, 'steptix.cmd');
    writeFileSync(command, '');
    writeFileSync(path.join(ownBin, 'steptix.cmd'), '');
  } else {
    mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    command = path.join(prefix, 'bin', 'steptix');
    symlinkSync(path.join(pkg, 'dist', 'index.js'), command);
    writeFileSync(path.join(ownBin, 'steptix'), '');
  }
  const dirs = [ownBin, path.dirname(command)].join(path.delimiter);
  const env = { PATH: dirs, Path: dirs, PATHEXT: '.CMD' };
  const found = findOnPath('steptix', env, process.platform, [ownBin]);
  assert.equal(found, command);
  assert.equal(npmPackageOfCommand(found, process.platform), pkg);
  assert.equal(findOnPath('steptix', { PATH: ownBin, Path: ownBin, PATHEXT: '.CMD' }, process.platform, [ownBin]), null);
});

test('the terminal falls behind: major.minor only, and the other way round', () => {
  assert.equal(
    staleTerminalNotice('1.4.7', '1.5.0'),
    'The steptix command in your terminal is 1.4. VS Code is on 1.5. Update it so both work on your projects the same way: npm i -g steptix',
  );
  assert.equal(staleTerminalNotice('1.5.3', '1.5.0'), null);
  assert.equal(
    staleTerminalNotice('1.5.0', '1.4.1'),
    'The steptix command in your terminal is 1.5, newer than this extension (1.4). Update the extension.',
  );
});

test("the bin script runs the newest server of the extension's major.minor", () => {
  const root = scratch();
  const runtimes = path.join(root, 'runtimes');
  writeRuntime(runtimes, '1.4.0');
  writeRuntime(runtimes, '1.4.2');
  writeRuntime(runtimes, '1.5.0'); // a newer major.minor npm put there
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const scripts = binScripts({ nodeExe: process.execPath, requires: '1.4.0', platform: process.platform });
  for (const [name, file] of Object.entries(scripts)) writeFileSync(path.join(bin, name), file.content, { mode: file.mode });
  assert.ok(scripts[process.platform === 'win32' ? 'steptix.cmd' : 'steptix'], 'writes the command for this platform');
  // The runner itself, as the command starts it.
  const out = execFileSync(process.execPath, [path.join(bin, 'run-newest.mjs'), 'list', '--json'], { encoding: 'utf-8' });
  assert.equal(out.trim(), 'steptix 1.4.2 ran: list --json');
});

test('the Windows command names the Node.js, and the POSIX one quotes it', () => {
  const win = binScripts({ nodeExe: 'C:\\Users\\Ada\\node.exe', requires: '1.0.0', platform: 'win32' });
  assert.equal(win['steptix.cmd'].content, '@echo off\r\n"C:\\Users\\Ada\\node.exe" "%~dp0run-newest.mjs" %*\r\n');
  const posix = binScripts({ nodeExe: "/opt/o'node/bin/node", requires: '1.0.0', platform: 'linux' });
  assert.equal(posix.steptix.content, `#!/bin/sh\nexec '/opt/o'\\''node/bin/node' "$(dirname "$0")/run-newest.mjs" "$@"\n`);
  assert.equal(posix.steptix.mode, 0o755);
});

test("Windows PATH: added at the end once, every other entry kept as written", () => {
  const dir = 'C:\\Users\\Ada\\AppData\\Local\\steptix\\bin';
  assert.equal(addToWindowsPath('%USERPROFILE%\\bin;C:\\tools', dir), `%USERPROFILE%\\bin;C:\\tools;${dir}`);
  assert.equal(addToWindowsPath('', dir), dir);
  assert.equal(addToWindowsPath('C:\\tools;', dir), `C:\\tools;${dir}`);
  assert.equal(addToWindowsPath(`C:\\tools;${dir.toUpperCase()}\\`, dir), null, 'there already, in another spelling');
  assert.equal(removeFromWindowsPath(`%USERPROFILE%\\bin;${dir};C:\\tools`, dir), '%USERPROFILE%\\bin;C:\\tools');
  assert.equal(removeFromWindowsPath('C:\\tools', dir), null);
});

test('macOS and Linux: one marked line in the shell startup file, taken out again', () => {
  const dir = '/home/ada/.steptix/bin';
  const line = 'export PATH="$PATH:/home/ada/.steptix/bin" # added by Steptix';
  assert.equal(addShellRcLine('alias ll="ls -l"\n', dir), `alias ll="ls -l"\n${line}\n`);
  assert.equal(addShellRcLine('alias ll="ls -l"', dir), `alias ll="ls -l"\n${line}\n`);
  assert.equal(addShellRcLine(`${line}\n`, dir), null);
  assert.equal(removeShellRcLine(`a\n${line}\nb\n`, dir), 'a\nb\n');
  assert.equal(removeShellRcLine('a\n', dir), null);
  assert.equal(shellRcFile('/home/ada', '/bin/zsh'), path.join('/home/ada', '.zshrc'));
  assert.equal(shellRcFile('/home/ada', '/bin/bash'), path.join('/home/ada', '.bashrc'));
  assert.equal(shellRcFile('/home/ada', undefined), path.join('/home/ada', '.bashrc'));
});

test('the download lock: one holder, taken over when its process has gone', () => {
  const file = path.join(scratch(), 'runtimes', '.download.lock');
  assert.equal(tryTakeLock(file, { pid: 100, isAlive: () => true }), true);
  assert.equal(tryTakeLock(file, { pid: 200, isAlive: () => true }), false, 'held by a live process');
  assert.equal(tryTakeLock(file, { pid: 200, isAlive: (pid) => pid !== 100 }), true, 'its holder has gone');
  releaseLock(file, 100); // not the holder any more: leaves it
  assert.equal(tryTakeLock(file, { pid: 300, isAlive: () => true }), false);
  releaseLock(file, 200);
  assert.equal(tryTakeLock(file, { pid: 300, isAlive: () => true }), true);
});

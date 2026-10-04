/**
 * packaging/runtime/runtime-scan.ps1: what the runtime installer and
 * uninstaller ask before changing a runtime folder (runtime.nsi).
 *
 * Its version order is a deliberate copy of compareVersions, because Windows
 * PowerShell 5.1 has no semantic version type. The "older" cases hold the
 * two to the same answers. The "blocking" cases run real processes from a
 * runtime folder. Windows only, like the installer.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions } from '../src/extension/server-manager.ts';

const skip = process.platform !== 'win32' && 'runtime-scan.ps1 is for the Windows installer';
const script = fileURLToPath(new URL('../../packaging/runtime/runtime-scan.ps1', import.meta.url));

/** The files that make a folder an installed runtime, in the script's terms. */
const INSTALLED = ['runtime-launcher.cjs', 'server/dist/index.js', 'steptix.cmd', '.steptix-runtime-install', 'Uninstall.exe'];

/** A runtimes folder: each name maps to the files its folder holds. */
function runtimesFolder(folders) {
  const dir = mkdtempSync(path.join(tmpdir(), 'steptix-scan-runtimes-'));
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

const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** Runs the script; its output lines, after checking it ended with "ok". */
function scan(...args) {
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000,
  });
  const lines = result.stdout.split(/\r?\n/).filter((line) => line !== '');
  assert.equal(result.status, 0, `the scan failed: ${result.stdout}${result.stderr}`);
  assert.equal(lines.at(-1), 'ok', `the scan did not finish: ${result.stdout}`);
  return lines.slice(0, -1);
}

function older(runtimes, version) {
  const out = path.join(runtimes, '..', `${path.basename(runtimes)}-older.txt`);
  assert.deepEqual(scan('-Mode', 'older', '-RuntimesDir', runtimes, '-Version', version, '-Out', out), []);
  const text = readFileSync(out).toString('utf16le');
  return text.split(/\r?\n/).filter((line) => line !== '').map((line) => path.basename(line)).sort();
}

test('older: the installed runtimes below a version, in compareVersions order', { skip }, () => {
  const versions = ['0.9.0', '1.0.0-beta.1', '1.0.0-beta.2', '1.0.0-beta.10', '1.0.0-alpha-1', '1.0.0', '1.0.0+build.5', '1.0.1-verify', '2.0.0-0', 'scratch'];
  const runtimes = runtimesFolder(Object.fromEntries(versions.map((name) => [name, INSTALLED])));
  for (const version of ['1.0.0-beta.2', '1.0.0', '1.0.1-verify', '0.0.1', '10.0.0', 'scratch', 'zzz']) {
    const expected = versions.filter((name) => compareVersions(name, version) < 0).sort();
    assert.deepEqual(older(runtimes, version), expected, `older than ${version}`);
  }
});

test('older: only folders this installer made are counted', { skip }, () => {
  const runtimes = runtimesFolder({
    '0.1.0': INSTALLED,
    '0.2.0': INSTALLED.filter((file) => file !== 'Uninstall.exe'),
    '0.3.0': INSTALLED.filter((file) => file !== '.steptix-runtime-install'),
    '0.4.0': ['runtime-launcher.cjs'],
    '0.5.0': [],
  });
  assert.deepEqual(older(runtimes, '1.0.0'), ['0.1.0']);
});

test('older: no runtimes folder at all is nothing to remove', { skip }, () => {
  assert.deepEqual(older(path.join(tmpdir(), 'steptix-no-such-runtimes-dir'), '1.0.0'), []);
});

test('blocking: node running a file from an older runtime, or a named folder, blocks; a newer one and a shell do not', { skip }, async () => {
  const runtimes = runtimesFolder({ '1.0.0': INSTALLED, '2.0.0': INSTALLED });
  const keepAlive = "process.stdout.write('up'); setInterval(() => {}, 1000);\n";
  const children = [];
  /** Starts a process, and resolves once it has printed that it is up. */
  const start = (command, args) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(child);
    return new Promise((resolve, reject) => {
      child.stdout.once('data', () => resolve(child));
      child.once('exit', (code) => reject(new Error(`${path.basename(command)} exited (${code}) before it was up`)));
    });
  };
  try {
    const olderFile = path.join(runtimes, '1.0.0', 'server', 'dist', 'index.js');
    const newerFile = path.join(runtimes, '2.0.0', 'server', 'dist', 'index.js');
    writeFileSync(olderFile, keepAlive);
    writeFileSync(newerFile, keepAlive);
    const [olderServer, newerServer] = await Promise.all([
      start(process.execPath, [olderFile]),
      start(process.execPath, [newerFile]),
      // Not node: its command line names a file in the older runtime, as an
      // editor's would, and it runs nothing from there.
      start(powershell, ['-NoProfile', '-NonInteractive', '-Command', "'up'; Start-Sleep 60 #", olderFile]),
    ]);

    // Installing 1.5.0: the older runtime would be removed, the newer one is left alone.
    assert.deepEqual(scan('-Mode', 'blocking', '-RuntimesDir', runtimes, '-Version', '1.5.0'), [`1.0.0: node.exe (pid ${olderServer.pid})`]);
    // Uninstalling 2.0.0: its own folder.
    assert.deepEqual(scan('-Mode', 'blocking', '-Folder', path.join(runtimes, '2.0.0')), [`2.0.0: node.exe (pid ${newerServer.pid})`]);
    // Installing 0.5.0, a rollback below both: nothing it would change is in use.
    assert.deepEqual(scan('-Mode', 'blocking', '-RuntimesDir', runtimes, '-Version', '0.5.0', '-Folder', path.join(runtimes, '0.5.0')), []);
  } finally {
    for (const child of children) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  }
});

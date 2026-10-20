/**
 * Installing the server and Node.js (docs/specs/SPEC-install.md §4.6, §4.7,
 * §5.2, §6.2, §8), against a fake npm, a fake nodejs.org and a fake tar, so
 * nothing is downloaded. What each fake answers is constructed, not taken
 * from a real npm run; the release test (§10.1) runs the real ones.
 */
import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  downloadNode,
  installServer,
  InstallFailure,
  newestPublishedServer,
  npmReason,
} from '../src/extension/server-installer.ts';
import { downloadLockFile, globalPackageDir, listInstalledServers } from '../src/extension/install-core.ts';

const made = [];
function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'steptix-installer-'));
  made.push(dir);
  return dir;
}
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const platform = process.platform;

/** A Node.js folder with npm's CLI where npmCliBeside looks for it. */
function fakeNode(root) {
  const dir = path.join(root, 'their-node');
  const exe = platform === 'win32' ? path.join(dir, 'node.exe') : path.join(dir, 'bin', 'node');
  const cli =
    platform === 'win32'
      ? path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : path.join(dir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  for (const file of [exe, cli]) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
  }
  return { exe, version: '22.22.0', origin: 'yours' };
}

/** Writes a runtime folder as `steptix server install` leaves one. */
function placeRuntime(userRoot, version, source) {
  const dir = path.join(userRoot, 'runtimes', version);
  mkdirSync(path.join(dir, 'dist'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'steptix', version }));
  writeFileSync(path.join(dir, 'dist', 'index.js'), '');
  writeFileSync(path.join(dir, '.steptix-install.json'), JSON.stringify({ version, source }));
}

/**
 * npm, and the downloaded package's `server install`, as far as the
 * installer sees them. `publish` is the version `npm install` fetches.
 */
function fakeRunner(userRoot, { publish = '1.4.2', npmFails } = {}) {
  const calls = [];
  const run = async (exe, args) => {
    calls.push(args);
    if (args[1] === 'install') {
      if (npmFails) return { code: 1, stdout: '', stderr: npmFails };
      const prefix = args[args.indexOf('--prefix') + 1];
      const pkg = globalPackageDir(prefix, platform);
      mkdirSync(path.join(pkg, 'dist'), { recursive: true });
      writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'steptix', version: publish }));
      writeFileSync(path.join(pkg, 'dist', 'index.js'), '');
      return { code: 0, stdout: `added 300 packages in 9s\n`, stderr: '' };
    }
    if (args[1] === 'server' && args[2] === 'install') {
      const source = args.includes('--source') ? args[args.indexOf('--source') + 1] : 'npm';
      placeRuntime(userRoot, publish, source);
      return {
        code: 0,
        stdout: `${JSON.stringify({ version: publish, dir: path.join(userRoot, 'runtimes', publish), source, installed: true })}\n`,
        stderr: `Setting up Steptix ${publish}…\n`,
      };
    }
    if (args[1] === 'view') return { code: 0, stdout: JSON.stringify(['1.4.0', '1.4.2', '1.4.10', '1.5.0']), stderr: '' };
    throw new Error(`unexpected run: ${exe} ${args.join(' ')}`);
  };
  return { run, calls };
}

function deps(userRoot, extra = {}) {
  const lines = [];
  return {
    lines,
    deps: {
      userRoot,
      platform,
      arch: 'x64',
      env: {},
      log: (line) => lines.push(line),
      sleep: async () => {},
      ...extra,
    },
  };
}

test('installs the newest matching server through npm, then sets it up as the extension\'s', async () => {
  const root = scratch();
  const npm = fakeRunner(root);
  const { deps: d } = deps(root, { run: npm.run });

  const result = await installServer(d, fakeNode(root), '1.4.0');

  assert.equal(result.installed, true);
  assert.equal(result.server.version, '1.4.2');
  assert.equal(result.server.source, 'extension');
  const [install, setUp] = npm.calls;
  assert.deepEqual(install.slice(1, 3), ['install', '-g']);
  assert.ok(install.includes('steptix@~1.4.0'), 'asks npm for the newest 1.4.x');
  assert.deepEqual(setUp.slice(1), ['server', 'install', '--json', '--source', 'extension']);
  // The scratch npm folder is gone, and nothing half-done is left.
  assert.deepEqual(readdirSync(path.join(root, 'runtimes')).filter((n) => n.startsWith('.partial-')), []);
  assert.equal(existsSync(downloadLockFile(root)), false, 'the lock is released');
});

test('installs nothing when a matching server is there already', async () => {
  const root = scratch();
  placeRuntime(root, '1.4.1', 'npm');
  const npm = fakeRunner(root);
  const result = await installServer(deps(root, { run: npm.run }).deps, fakeNode(root), '1.4.0');
  assert.deepEqual(result, { installed: false, server: { version: '1.4.1', dir: path.join(root, 'runtimes', '1.4.1'), source: 'npm' } });
  assert.deepEqual(npm.calls, []);
});

test("npm's failure is reported in its own words, and leaves nothing behind", async () => {
  const root = scratch();
  const npm = fakeRunner(root, {
    npmFails: 'npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/steptix failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org\nnpm error A complete log of this run can be found in: x.log\n',
  });
  await assert.rejects(installServer(deps(root, { run: npm.run }).deps, fakeNode(root), '1.4.0'), (err) => {
    assert.ok(err instanceof InstallFailure);
    assert.equal(err.kind, 'server-download');
    assert.match(err.message, /^network request to https:\/\/registry\.npmjs\.org\/steptix failed/);
    return true;
  });
  assert.deepEqual(listInstalledServers(path.join(root, 'runtimes')), []);
  assert.deepEqual(readdirSync(path.join(root, 'runtimes')).filter((n) => n.startsWith('.partial-')), []);
});

test('a second window waits for the first, then uses what it installed', async () => {
  const root = scratch();
  const lock = downloadLockFile(root);
  mkdirSync(path.dirname(lock), { recursive: true });
  // Another VS Code window, alive, holds the download lock.
  // This test's parent process stands in for it: alive, and not this one.
  writeFileSync(lock, JSON.stringify({ pid: process.ppid, since: Date.now() }));
  const npm = fakeRunner(root);
  let waits = 0;
  const { deps: d } = deps(root, {
    run: npm.run,
    onWait: () => waits++,
    sleep: async () => {
      // That window finishes while this one sleeps.
      placeRuntime(root, '1.4.2', 'extension');
      rmSync(lock);
    },
  });
  const result = await installServer(d, fakeNode(root), '1.4.0');
  assert.equal(waits, 1);
  assert.equal(result.installed, false);
  assert.deepEqual(npm.calls, [], 'downloaded nothing itself');
});

test('the newest published patch of its major.minor', async () => {
  const root = scratch();
  const npm = fakeRunner(root);
  assert.equal(await newestPublishedServer(deps(root, { run: npm.run }).deps, fakeNode(root), '1.4.0'), '1.4.10');
  assert.ok(npm.calls[0].includes('steptix@~1.4.0'));
});

test("npm's reason is its first line that says something", () => {
  assert.equal(npmReason('npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/steptix\n'), '404 Not Found - GET https://registry.npmjs.org/steptix');
  assert.equal(npmReason(''), 'npm failed without saying why');
});

/** nodejs.org, serving one archive. */
function fakeNodejsOrg(bytes, { lie = false } = {}) {
  const suffix = platform === 'win32' ? 'win-x64.zip' : `${platform === 'darwin' ? 'darwin' : 'linux'}-x64.tar.gz`;
  const file = `node-v22.22.1-${suffix}`;
  const sha = createHash('sha256').update(lie ? Buffer.from('something else') : bytes).digest('hex');
  return async (url) => {
    if (url.endsWith('SHASUMS256.txt')) return { ok: true, status: 200, text: async () => `${sha}  ${file}\n`, arrayBuffer: async () => new ArrayBuffer(0) };
    if (url.endsWith(file)) return { ok: true, status: 200, text: async () => '', arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
  };
}

/** tar, unpacking the archive into the folder nodejs.org's archives hold. */
async function fakeTar(_exe, args) {
  const into = args[args.indexOf('-C') + 1];
  const top = path.join(into, `node-v22.22.1-${platform === 'win32' ? 'win' : platform}-x64`);
  const exe = platform === 'win32' ? path.join(top, 'node.exe') : path.join(top, 'bin', 'node');
  mkdirSync(path.dirname(exe), { recursive: true });
  writeFileSync(exe, '');
  return { code: 0, stdout: '', stderr: '' };
}

test('downloads Node.js into the Steptix folder when its fingerprint matches', async () => {
  const root = scratch();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const { deps: d } = deps(root, { fetch: fakeNodejsOrg(bytes), run: fakeTar, probe: async (exe) => ({ version: '22.22.1', exe }), arch: 'x64' });

  const node = await downloadNode(d);

  const dir = path.join(root, 'node', '22.22.1');
  assert.equal(node.origin, 'steptix');
  assert.equal(node.version, '22.22.1');
  assert.equal(node.exe, platform === 'win32' ? path.join(dir, 'node.exe') : path.join(dir, 'bin', 'node'));
  assert.deepEqual(readdirSync(path.join(root, 'node')), ['22.22.1'], 'no partial folder left');
});

test('refuses a Node.js download that does not match its fingerprint', async () => {
  const root = scratch();
  const { deps: d } = deps(root, { fetch: fakeNodejsOrg(new Uint8Array([1, 2, 3]), { lie: true }), run: fakeTar, probe: async (exe) => ({ version: '22.22.1', exe }) });
  await assert.rejects(downloadNode(d), (err) => {
    assert.equal(err.kind, 'node-download');
    assert.match(err.message, /did not match the fingerprint nodejs\.org publishes/);
    return true;
  });
  assert.deepEqual(existsSync(path.join(root, 'node')) ? readdirSync(path.join(root, 'node')) : [], []);
});

test('nodejs.org out of reach is a node-download failure', async () => {
  const root = scratch();
  const { deps: d } = deps(root, {
    fetch: async () => {
      throw new Error('getaddrinfo ENOTFOUND nodejs.org');
    },
  });
  await assert.rejects(downloadNode(d), (err) => err.kind === 'node-download' && /ENOTFOUND nodejs\.org/.test(err.message));
});

/**
 * Installing the server and Node.js (docs/specs/SPEC-install.md §4.6, §4.7,
 * §5.2, §6.2, §8), against a fake npm, a fake nodejs.org and a fake tar, so
 * nothing is downloaded. What each fake answers is constructed, not taken
 * from a real npm run; the release test (§10.1) runs the real ones.
 */
import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  defaultRunner,
  describeSpec,
  downloadNode,
  installServer,
  InstallFailure,
  newestPublishedServer,
  npmNotPublished,
  npmReason,
} from '../src/extension/server-installer.ts';
import { downloadLockFile, globalPackageDir, listInstalledServers, pidAlive } from '../src/extension/install-core.ts';

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
function fakeRunner(userRoot, { publish = '1.4.2', npmFails, registry = 'https://registry.npmjs.org/' } = {}) {
  const calls = [];
  const run = async (exe, args) => {
    calls.push(args);
    if (args[1] === 'config' && args[2] === 'get' && args[3] === 'registry') return { code: 0, stdout: `${registry}\n`, stderr: '' };
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

test('a registry that answers but has no matching release says so, and names the registry', async () => {
  const root = scratch();
  const npm = fakeRunner(root, {
    registry: 'https://npm.example.test/',
    npmFails:
      'npm error code ETARGET\nnpm error notarget No matching version found for steptix@~1.4.0.\n' +
      'npm error notarget In most cases you or one of your dependencies are requesting\nnpm error A complete log of this run can be found in: x.log\n',
  });
  await assert.rejects(installServer(deps(root, { run: npm.run }).deps, fakeNode(root), '1.4.0'), (err) => {
    assert.ok(err instanceof InstallFailure);
    // Not a network problem, so not the network message.
    assert.equal(err.kind, 'not-published');
    assert.equal(err.message, 'no 1.4 release of steptix is published on https://npm.example.test/');
    assert.match(err.details, /ETARGET/);
    return true;
  });
  assert.deepEqual(readdirSync(path.join(root, 'runtimes')).filter((n) => n.startsWith('.partial-')), []);
});

test("which npm failures mean the version is not published there", () => {
  assert.equal(npmNotPublished('npm error code ETARGET\nnpm error notarget No matching version found for steptix@~1.0.0.\n'), true);
  assert.equal(npmNotPublished('npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/steptix - Not found\n'), true);
  // A dependency missing is a broken registry, not a missing Steptix.
  assert.equal(npmNotPublished('npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/steptix-helper - Not found\n'), false);
  assert.equal(npmNotPublished('npm error code ENOTFOUND\nnpm error network request failed\n'), false);
  assert.equal(describeSpec('steptix@~1.4.0'), '1.4');
  assert.equal(describeSpec('steptix@1.4.2'), '1.4.2');
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

// ---------------------------------------------------------------------------
// Cancel (§5.2): the download stops and nothing half-done is left
// ---------------------------------------------------------------------------

const partials = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith('.partial-')) : []);
const cancelled = (err) => err instanceof InstallFailure && err.kind === 'cancelled';

/** The pid of a process that has exited. */
function goneProcessPid() {
  const { pid } = spawnSync(process.execPath, ['-e', '']);
  assert.equal(pidAlive(pid), false, `pid ${pid} was taken again at once; run the test again`);
  return pid;
}

/** Poll until `predicate` holds, failing after a generous ceiling. */
async function until(label, predicate) {
  for (let polls = 0; !predicate(); polls++) {
    if (polls > 1_500) throw new Error(`gave up waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('Cancel while npm downloads ends the install as cancelled, and leaves nothing behind', async () => {
  const root = scratch();
  const cancel = new AbortController();
  const run = async (_exe, args, opts) => {
    assert.equal(args[1], 'install', `unexpected run: ${args.join(' ')}`);
    assert.equal(opts.signal, cancel.signal, 'npm is given Cancel');
    // npm part way through: some of the package is in its folder.
    const pkg = globalPackageDir(args[args.indexOf('--prefix') + 1], platform);
    mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'steptix', version: '1.4.2' }));
    cancel.abort();
    // Stopped, npm exits as a stopped program does, without saying why.
    return { code: 1, stdout: '', stderr: '' };
  };
  await assert.rejects(installServer(deps(root, { run, signal: cancel.signal }).deps, fakeNode(root), '1.4.0'), cancelled);
  assert.deepEqual(listInstalledServers(path.join(root, 'runtimes')), []);
  assert.deepEqual(partials(path.join(root, 'runtimes')), []);
  assert.equal(existsSync(downloadLockFile(root)), false, 'the lock is released');
});

test("Cancel during the setup removes the copy the stopped setup left, and no one else's", async () => {
  const root = scratch();
  const runtimes = path.join(root, 'runtimes');
  const cancel = new AbortController();
  // A terminal's own install, copying right now: its process is alive.
  const theirs = `.partial-1.4.2-${process.ppid}-0badc0de`;
  const ours = `.partial-1.4.2-${goneProcessPid()}-c0ffee00`;
  const npm = fakeRunner(root);
  const run = async (exe, args, opts) => {
    if (args[1] !== 'server') return npm.run(exe, args, opts);
    // `server install`, stopped mid-copy: its partial copy stays where it was.
    mkdirSync(path.join(runtimes, ours, 'dist'), { recursive: true });
    mkdirSync(path.join(runtimes, theirs), { recursive: true });
    cancel.abort();
    return { code: 1, stdout: '', stderr: '' };
  };
  await assert.rejects(installServer(deps(root, { run, signal: cancel.signal }).deps, fakeNode(root), '1.4.0'), cancelled);
  assert.deepEqual(partials(runtimes), [theirs]);
  assert.deepEqual(listInstalledServers(runtimes), []);
});

test('Cancel while Node.js downloads ends the install as cancelled, not as nodejs.org out of reach', async () => {
  const root = scratch();
  const cancel = new AbortController();
  const { deps: d } = deps(root, {
    signal: cancel.signal,
    fetch: async (_url, init) => {
      assert.equal(init.signal, cancel.signal, 'the download is given Cancel');
      cancel.abort();
      throw new DOMException('This operation was aborted', 'AbortError');
    },
  });
  await assert.rejects(downloadNode(d), cancelled);
  assert.deepEqual(existsSync(path.join(root, 'node')) ? readdirSync(path.join(root, 'node')) : [], []);
});

test('Cancel while Node.js unpacks removes the half-unpacked copy', async () => {
  const root = scratch();
  const cancel = new AbortController();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const { deps: d } = deps(root, {
    signal: cancel.signal,
    fetch: fakeNodejsOrg(bytes),
    probe: async (exe) => ({ version: '22.22.1', exe }),
    run: async (exe, args, opts) => {
      assert.equal(opts.signal, cancel.signal, 'tar is given Cancel');
      await fakeTar(exe, args);
      cancel.abort();
      return { code: 1, stdout: '', stderr: '' };
    },
  });
  await assert.rejects(downloadNode(d), cancelled);
  assert.deepEqual(readdirSync(path.join(root, 'node')), [], 'no partial folder, and no Node.js');
});

test('Cancel stops the program and every program it started, as npm starts install scripts through a shell', async () => {
  const dir = scratch();
  const pidFile = path.join(dir, 'script.pid');
  // A package's install script, which says where it runs and keeps running.
  const script = path.join(dir, 'install-script.cjs');
  writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
  // npm, as far as this goes: it runs the script through the shell (cmd.exe
  // on Windows, whose own children outlive it), then waits.
  const npm = path.join(dir, 'npm-stand-in.cjs');
  writeFileSync(
    npm,
    `require('node:child_process').spawn(${JSON.stringify(`"${process.execPath}" "${script}"`)}, { shell: true, stdio: 'ignore' });\n` +
      'setInterval(() => {}, 1000);\n',
  );
  const cancel = new AbortController();
  const running = defaultRunner(process.execPath, [npm], { signal: cancel.signal });
  let scriptPid = 0;
  try {
    await until('the install script to start', () => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '');
    scriptPid = Number(readFileSync(pidFile, 'utf8'));
    cancel.abort();
    const result = await running;
    assert.notEqual(result.code, 0);
    await until('the install script to stop', () => !pidAlive(scriptPid));
  } finally {
    cancel.abort();
    await running;
    if (scriptPid && pidAlive(scriptPid)) process.kill(scriptPid);
  }
});

test('a program Cancel came before does not start', async () => {
  const result = await defaultRunner(process.execPath, ['-e', 'console.log("ran")'], { signal: AbortSignal.abort() });
  assert.equal(result.code, null);
  assert.equal(result.stdout, '');
});

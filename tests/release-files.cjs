// Opening the files a release publishes, for the release and install tests
// (scripts/release-test.mjs, steptix-vscode/tests/integration/runInstallTest.cjs).
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function run(command, args, opts) {
  const result = cp.spawnSync(command, args, { encoding: 'utf8', ...opts });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

/**
 * A `.vsix` unpacked into `dir`. It is a zip whose `extension/` folder is the
 * extension as VS Code installs it; the path of that folder is returned.
 */
function unpackVsix(vsix, dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(vsix, path.join(dir, 'extension.zip'));
  if (process.platform === 'win32') {
    run('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -Force extension.zip -DestinationPath .'], { cwd: dir });
  } else {
    run('unzip', ['-q', '-o', 'extension.zip'], { cwd: dir });
  }
  return path.join(dir, 'extension');
}

/**
 * Unpack a `.tgz` into `dir`. By a bare name from inside it: GNU tar (Git for
 * Windows puts one on PATH) reads the `C:` of an absolute Windows path as a
 * remote host. `only` limits it to one member.
 */
function untar(tarball, dir, only) {
  fs.mkdirSync(dir, { recursive: true });
  const copy = path.join(dir, path.basename(tarball));
  if (path.resolve(tarball) !== path.resolve(copy)) fs.copyFileSync(tarball, copy);
  run('tar', ['-xzf', path.basename(copy), ...(only ? [only] : [])], { cwd: dir });
}

/** The version inside a packed `steptix` tarball, unpacking into `dir`. */
function packageVersionOf(tarball, dir) {
  untar(tarball, dir, 'package/package.json');
  return JSON.parse(fs.readFileSync(path.join(dir, 'package', 'package.json'), 'utf8')).version;
}

module.exports = { packageVersionOf, unpackVsix, untar };

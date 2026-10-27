#!/usr/bin/env node
// Builds the files a release publishes (docs/specs/SPEC-install.md §3.1, §10),
// from this checkout, into one folder:
//
//   steptix-<version>.tgz                    the npm package
//   steptix-<version>-<platform>-<arch>.tgz  the offline file for THIS machine (§5.6)
//   steptix-<version>.vsix                   the VS Code extension
//
//   node scripts/build-release.mjs [--out <dir>]     (default: dist-release/)
//
// The offline file is built on the platform it is for, because a few
// dependencies (desktop automation, esbuild) install a separate build per
// operating system. It is the npm package with its dependencies installed
// from npm-shrinkwrap.json and packed inside it (`bundleDependencies`), so
// `npm i -g ./steptix-<version>-<platform>-<arch>.tgz` fetches nothing. Its
// `os` and `cpu` fields make npm refuse it on another platform, naming the
// one it is for, and `steptixDistribution: "offline"` is what the launcher
// records as its source (src/launcher/runtimes.ts).
//
// Nothing here publishes. scripts/release-test.mjs tests what this builds,
// and .github/workflows/release.yml publishes it once that passes.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const out = path.resolve(outArg >= 0 ? process.argv[outArg + 1] : path.join(root, 'dist-release'));

/** npm through a shell on Windows, where it is npm.cmd. */
function npm(args, cwd) {
  return execFileSync('npm', args, { cwd, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'inherit'] });
}

/** The file `npm pack` wrote, from its last line of output. */
function packed(output) {
  return output.trim().split(/\r?\n/).at(-1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const extension = JSON.parse(fs.readFileSync(path.join(root, 'steptix-vscode', 'package.json'), 'utf8'));
const majorMinor = (v) => v.split('.').slice(0, 2).join('.');
// §4.2: the two share major.minor, each with its own patch.
if (majorMinor(pkg.version) !== majorMinor(extension.version)) {
  throw new Error(`steptix ${pkg.version} and steptix-vscode ${extension.version} do not share major.minor (§4.2)`);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// 1. The npm package. `prepack` builds dist/.
const npmFile = packed(npm(['pack', '--pack-destination', out], root));
console.log(`npm package: ${npmFile}`);

// 2. The offline file: the same package, its dependencies inside it.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'steptix-offline-'));
try {
  // By a bare name from inside the folder: GNU tar (Git for Windows puts one
  // on PATH) reads the `C:` of an absolute Windows path as a remote host.
  fs.copyFileSync(path.join(out, npmFile), path.join(work, npmFile));
  execFileSync('tar', ['-xzf', npmFile], { cwd: work, stdio: 'inherit' });
  fs.rmSync(path.join(work, npmFile));
  const dir = path.join(work, 'package');
  // Exactly the tested versions (npm-shrinkwrap.json ships in the package),
  // with install scripts, so each native part builds for this machine.
  npm(['ci', '--omit=dev', '--no-audit', '--no-fund'], dir);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  manifest.bundleDependencies = true;
  manifest.steptixDistribution = 'offline';
  manifest.os = [process.platform];
  manifest.cpu = [process.arch];
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // --ignore-scripts: `prepack` would rebuild dist/ from sources the package
  // does not hold. dist/ is already the one just packed.
  // Packed beside the work, not into `out`: it has the npm package's name.
  const offline = packed(npm(['pack', '--ignore-scripts', '--pack-destination', work], dir));
  const offlineName = `steptix-${pkg.version}-${process.platform}-${process.arch}.tgz`;
  fs.copyFileSync(path.join(work, offline), path.join(out, offlineName));
  console.log(`offline file: ${offlineName}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 });
}

// 3. The extension.
const vsixName = `steptix-${extension.version}.vsix`;
const extensionDir = path.join(root, 'steptix-vscode');
npm(['run', 'build'], extensionDir);
npm(['run', 'package', '--', '--out', path.join(out, vsixName)], extensionDir);
console.log(`extension: ${vsixName}`);

console.log(`release files in ${out}`);

/**
 * The pure parts of how the extension finds, installs and updates the Steptix
 * server (docs/specs/SPEC-install.md §4, §5, §6). No `vscode` import, so the
 * `node --test` suite covers it; server-setup.ts drives it from VS Code.
 *
 * The on-disk layout is the launcher's (src/launcher/runtimes.ts in the
 * framework): `<user root>/runtimes/<version>/` holds a whole `steptix`
 * package with a `.steptix-install.json` beside its `package.json`, and
 * `server-choice.json` holds a `steptix server use` choice. This bundle
 * cannot import the framework, so what it reads of that layout is a
 * deliberate copy, held to the launcher's by
 * tests/install-core-parity.test.ts in the framework.
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Versions (§4.2)
// ---------------------------------------------------------------------------

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Semver precedence: a prerelease sorts below its release, and prerelease
 * identifiers compare numerically when both are numbers. A folder name that is
 * not a version sorts below every one that is. The launcher's order too
 * (src/launcher/versions.ts in the framework).
 */
export function compareVersions(a: string, b: string): number {
  const va = VERSION_PATTERN.exec(a);
  const vb = VERSION_PATTERN.exec(b);
  if (!va || !vb) {
    if (va || vb) return va ? 1 : -1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  for (let i = 1; i <= 3; i++) {
    const diff = Number(va[i]) - Number(vb[i]);
    if (diff !== 0) return diff;
  }
  const pa = va[4]?.split('.') ?? [];
  const pb = vb[4]?.split('.') ?? [];
  // A release outranks every prerelease of itself.
  if (pa.length === 0 || pb.length === 0) return pb.length - pa.length;
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i]!;
    const y = pb[i]!;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) - Number(y);
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
}

/** `1.4` for `1.4.3`, or null for a name that is not a version. */
export function majorMinorOf(version: string): string | null {
  const m = /^(\d+)\.(\d+)\.\d+(?:[-+].*)?$/.exec(version);
  return m ? `${m[1]}.${m[2]}` : null;
}

/** Does server `version` serve an extension that needs `requires`: the same
 *  major.minor, and not older? */
export function serverSatisfies(version: string, requires: string): boolean {
  const mm = majorMinorOf(version);
  return mm !== null && mm === majorMinorOf(requires) && compareVersions(version, requires) >= 0;
}

/**
 * The server this extension needs: `steptixServer` in its package.json when
 * set (a fix of its own that relies on a server fix asks for that patch),
 * else its own major.minor, any patch.
 */
export function serverRequirement(manifest: { version?: unknown; steptixServer?: unknown }): string | null {
  if (typeof manifest.steptixServer === 'string' && majorMinorOf(manifest.steptixServer) !== null) {
    return manifest.steptixServer;
  }
  const m = typeof manifest.version === 'string' ? /^(\d+)\.(\d+)\.\d+/.exec(manifest.version) : null;
  return m ? `${m[1]}.${m[2]}.0` : null;
}

/** The npm spec that fetches the newest server meeting `requires`: `~1.4.0`
 *  is 1.4.0 or later, below 1.5.0. */
export function npmSpecFor(requires: string): string {
  return `steptix@~${requires}`;
}

// ---------------------------------------------------------------------------
// Installed servers
// ---------------------------------------------------------------------------

export type ServerSource = 'npm' | 'extension' | 'offline file';

export interface InstalledServer {
  version: string;
  /** `<user root>/runtimes/<version>`. */
  dir: string;
  source: ServerSource | null;
}

/** Written into each runtime folder by the install that made it. */
export const INSTALL_RECORD = '.steptix-install.json';

/**
 * Every server in `runtimesDir`, oldest first: folders named by a version
 * that hold that version's `steptix` package, its entry point and an install
 * record. Partial copies and the retired Windows installer's folders do not
 * qualify.
 */
export function listInstalledServers(runtimesDir: string): InstalledServer[] {
  let names: string[];
  try {
    names = readdirSync(runtimesDir);
  } catch {
    return [];
  }
  const out: InstalledServer[] = [];
  for (const name of names) {
    if (majorMinorOf(name) === null) continue;
    const dir = path.join(runtimesDir, name);
    let pkg: { name?: unknown; version?: unknown };
    let record: { source?: unknown };
    try {
      pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf-8')) as typeof pkg;
      record = JSON.parse(readFileSync(path.join(dir, INSTALL_RECORD), 'utf-8')) as typeof record;
    } catch {
      continue;
    }
    if (pkg.name !== 'steptix' || pkg.version !== name) continue;
    if (!existsSync(path.join(dir, 'dist', 'index.js'))) continue;
    const source =
      record.source === 'npm' || record.source === 'extension' || record.source === 'offline file'
        ? record.source
        : null;
    out.push({ version: name, dir, source });
  }
  return out.sort((a, b) => compareVersions(a.version, b.version));
}

/** The version chosen with `steptix server use`, or null. */
export function readServerChoice(userRoot: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(userRoot, 'server-choice.json'), 'utf-8')) as { version?: unknown };
    return typeof raw.version === 'string' && majorMinorOf(raw.version) !== null ? raw.version : null;
  } catch {
    return null;
  }
}

/** Undo a `steptix server use` choice, as `steptix server use newest` does. */
export function clearServerChoice(userRoot: string): void {
  rmSync(path.join(userRoot, 'server-choice.json'), { force: true });
}

export type ServerPick =
  /** Run this one. `chosen` when it is the user's `steptix server use` choice. */
  | { kind: 'run'; server: InstalledServer; chosen: boolean }
  /** The user chose a version that does not match this extension (§6.5). */
  | { kind: 'chosen-mismatch'; chosen: string }
  /** Nothing installed matches. */
  | { kind: 'none' };

/**
 * Which installed server the extension runs (§4.2, §6.5): the chosen one when
 * there is a choice it can run, else the newest that meets `requires`. A
 * chosen version of another major.minor is never run; one that is no longer
 * installed is set aside, as the launcher does.
 */
export function pickServer(servers: InstalledServer[], requires: string, choice: string | null): ServerPick {
  if (choice !== null) {
    const picked = servers.find((s) => s.version === choice);
    if (picked) {
      return serverSatisfies(picked.version, requires)
        ? { kind: 'run', server: picked, chosen: true }
        : { kind: 'chosen-mismatch', chosen: picked.version };
    }
  }
  const newest = servers.filter((s) => serverSatisfies(s.version, requires)).at(-1);
  return newest ? { kind: 'run', server: newest, chosen: false } : { kind: 'none' };
}

// ---------------------------------------------------------------------------
// Platforms (§3.2, §8.4)
// ---------------------------------------------------------------------------

/** Platforms whose packages have passed the release test (§10.1). */
export const SUPPORTED_PLATFORMS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'win32-x64', label: 'Windows x64' },
];

function platformLabel(platform: NodeJS.Platform, arch: string): string {
  const os =
    platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform;
  const cpu =
    arch === 'arm64'
      ? platform === 'darwin'
        ? 'Apple Silicon'
        : 'ARM'
      : arch === 'x64'
        ? platform === 'darwin'
          ? 'Intel'
          : 'x64'
        : arch;
  return platform === 'darwin' ? `${os} on ${cpu}` : cpu === 'ARM' ? `${os} on ARM` : `${os} ${cpu}`;
}

/** §8.4's sentence for a platform with no server yet, or null when it has one. */
export function unsupportedPlatformMessage(platform: NodeJS.Platform, arch: string): string | null {
  if (SUPPORTED_PLATFORMS.some((p) => p.id === `${platform}-${arch}`)) return null;
  return (
    `Steptix does not run on ${platformLabel(platform, arch)} yet. ` +
    `Supported now: ${SUPPORTED_PLATFORMS.map((p) => p.label).join(', ')}.`
  );
}

/**
 * About how much the first install downloads, for the install question
 * (§5.2): the package and its dependencies as npm fetches them, compressed.
 * For 1.0.0 the install test (tests/integration/runInstallTest.cjs, which
 * prints npm's cache size) measured 58 MB of package tarballs, plus npm's
 * package metadata, which travels compressed. Node.js adds
 * {@link NODE_DOWNLOAD_MB} when the extension has to fetch it too: its
 * Windows x64 zip is about 30 MB.
 */
export const SERVER_DOWNLOAD_MB = 70;
export const NODE_DOWNLOAD_MB = 30;

// ---------------------------------------------------------------------------
// Node.js (§4.6)
// ---------------------------------------------------------------------------

export const REQUIRED_NODE = { major: 22, minor: 21 };

/** `22.21.0` for `v22.21.0`, or null. */
export function parseNodeVersion(text: string): string | null {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

export function nodeIsNewEnough(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major > REQUIRED_NODE.major || (major === REQUIRED_NODE.major && minor >= REQUIRED_NODE.minor);
}

/** A Node.js the server can run on, and where it came from. */
export interface NodeChoice {
  /** Absolute path of the `node` executable. */
  exe: string;
  version: string;
  /** `yours` is on PATH (or named by STEPTIX_NODE); `steptix` is the copy in
   *  `<user root>/node/`. */
  origin: 'yours' | 'steptix';
}

/** Where a Node.js folder unpacked from nodejs.org keeps `node`. */
export function nodeExeIn(dir: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? path.join(dir, 'node.exe') : path.join(dir, 'bin', 'node');
}

/** npm's own CLI script beside a `node` executable, if it is there: next to
 *  it on Windows, in `../lib/node_modules` elsewhere. Running it with that
 *  `node` needs no shell and no `npm` on PATH. */
export function npmCliBeside(nodeExe: string, platform: NodeJS.Platform): string | null {
  const dir = path.dirname(nodeExe);
  const candidates =
    platform === 'win32'
      ? [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
      : [
          path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
          path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** Steptix's own Node.js copies in `<user root>/node/<version>/`, newest first. */
export function ownNodeCopies(userRoot: string, platform: NodeJS.Platform): Array<{ version: string; exe: string }> {
  let names: string[];
  try {
    names = readdirSync(path.join(userRoot, 'node'));
  } catch {
    return [];
  }
  return names
    .filter((n) => parseNodeVersion(n) === n && nodeIsNewEnough(n))
    .map((n) => ({ version: n, exe: nodeExeIn(path.join(userRoot, 'node', n), platform) }))
    .filter((c) => existsSync(c.exe))
    .sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * Search PATH for an executable, as a shell would, without running one.
 * `exts` narrows Windows' PATHEXT, for a program that must be run without a
 * shell: Node cannot run a `.cmd` that way.
 */
export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exclude: string[] = [],
  exts?: string[],
): string | null {
  const pathVar = platform === 'win32' ? (env['Path'] ?? env['PATH'] ?? '') : (env['PATH'] ?? '');
  const tried =
    platform === 'win32' ? (exts ?? (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)) : [''];
  const fold = (p: string) => (platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p);
  const skip = new Set(exclude.map((d) => fold(path.resolve(d))));
  for (const dir of pathVar.split(platform === 'win32' ? ';' : ':')) {
    const trimmed = dir.trim().replace(/^"(.*)"$/, '$1');
    if (!trimmed || skip.has(fold(path.resolve(trimmed)))) continue;
    for (const ext of tried) {
      const candidate = path.join(trimmed, name + ext.toLowerCase());
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

/** What a Node.js says about itself: its version, and the executable it
 *  really is. */
export type NodeProbe = (exe: string) => Promise<{ version: string; exe: string } | null>;

/**
 * Ask a `node` for its version and its own path. The path is the real
 * executable behind a version manager's shim (Volta, fnm, asdf), which is
 * where npm sits beside it. Null when it cannot be run.
 */
export const probeNode: NodeProbe = (exe) =>
  new Promise((resolve) => {
    execFile(
      exe,
      ['-p', "process.versions.node + ' ' + process.execPath"],
      { timeout: 15_000, windowsHide: true },
      (err, stdout) => {
        // `22.22.0 C:\Program Files\nodejs\node.exe`: the version has no
        // space in it, and the path may.
        const line = String(stdout).trim();
        const space = line.indexOf(' ');
        const parsed = space > 0 ? parseNodeVersion(line.slice(0, space)) : null;
        resolve(err || !parsed ? null : { version: parsed, exe: line.slice(space + 1) });
      },
    );
  });

/**
 * The Node.js to run the server with, in §4.6's order: the user's own (on
 * PATH, or named by STEPTIX_NODE) when 22.21 or later, else Steptix's own
 * copy, else null, which means one has to be downloaded. Checked each time a
 * server starts, so a Node.js the user installs later is used from then on.
 */
export async function chooseNode(args: {
  userRoot: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  probe?: NodeProbe;
}): Promise<NodeChoice | null> {
  const probe = args.probe ?? probeNode;
  const named = args.env['STEPTIX_NODE']?.trim();
  const yours = named || findOnPath('node', args.env, args.platform, [], ['.EXE']);
  if (yours) {
    const found = await probe(yours);
    if (found && nodeIsNewEnough(found.version)) return { exe: found.exe, version: found.version, origin: 'yours' };
  }
  const own = ownNodeCopies(args.userRoot, args.platform)[0];
  return own ? { exe: own.exe, version: own.version, origin: 'steptix' } : null;
}

/**
 * `env` with the folder of `nodeExe` first on PATH, for a process that runs
 * under that Node.js and starts others that expect `node` on PATH: npm runs a
 * package's install script (esbuild's, say) through a shell as `node …`. With
 * Steptix's own Node.js, which is never on the user's PATH (§4.6), that would
 * find no `node`. Windows' variable may be spelled `Path`, and is kept so.
 */
export function withNodeOnPath(env: NodeJS.ProcessEnv, nodeExe: string, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const key = platform === 'win32' ? (Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path') : 'PATH';
  const current = env[key] ?? '';
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const dir = paths.dirname(nodeExe);
  return { ...env, [key]: current ? `${dir}${paths.delimiter}${current}` : dir };
}

/** The archive nodejs.org publishes for a platform, without its version:
 *  `win-x64.zip`, `darwin-arm64.tar.gz`, `linux-x64.tar.gz`. */
export function nodeArchiveSuffix(platform: NodeJS.Platform, arch: string): string | null {
  const os = platform === 'win32' ? 'win' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null;
  if (!os || (arch !== 'x64' && arch !== 'arm64')) return null;
  return `${os}-${arch}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
}

/**
 * The archive to download from a `SHASUMS256.txt` of a nodejs.org release
 * folder, with its SHA-256 and version. These are the fingerprints nodejs.org
 * publishes for each file (§4.6), which the download is checked against.
 */
export function nodeArchiveFrom(
  shasums: string,
  platform: NodeJS.Platform,
  arch: string,
): { file: string; sha256: string; version: string } | null {
  const suffix = nodeArchiveSuffix(platform, arch);
  if (!suffix) return null;
  for (const line of shasums.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+(node-v(\d+\.\d+\.\d+)-(.+))$/.exec(line.trim());
    if (m && m[4] === suffix) return { sha256: m[1]!, file: m[2]!, version: m[3]! };
  }
  return null;
}

export function sha256Of(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// The browser (§7.4)
// ---------------------------------------------------------------------------

/** Where Google Chrome's stable channel installs: the browser Steptix runs
 *  tests in by default (§7.4). The same places as the launcher's first-run
 *  check (chromePaths in the framework's src/launcher/first-run.ts). */
export function chromePaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    return [env['ProgramFiles'], env['ProgramFiles(x86)'], env['LOCALAPPDATA']]
      .filter((dir): dir is string => typeof dir === 'string' && dir !== '')
      .map((dir) => path.win32.join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  if (platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
}

export function chromeFound(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, exists = existsSync): boolean {
  return chromePaths(platform, env).some((p) => exists(p));
}

// ---------------------------------------------------------------------------
// npm's own install of steptix (§5.3, §6.8)
// ---------------------------------------------------------------------------

/**
 * The `steptix` package behind a `steptix` command found on PATH, from how
 * npm lays out a global install: on Windows the shim sits in the prefix and
 * the package in `<prefix>/node_modules/steptix`; elsewhere the command is a
 * link into the package's `dist/index.js`.
 */
export function npmPackageOfCommand(command: string, platform: NodeJS.Platform): string | null {
  let root: string;
  if (platform === 'win32') {
    root = path.join(path.dirname(command), 'node_modules', 'steptix');
  } else {
    let target: string;
    try {
      target = realpathSync(command);
    } catch {
      return null;
    }
    root = path.dirname(path.dirname(target));
  }
  return isSteptixPackage(root) ? root : null;
}

/** npm's global package folder for `prefix` (`npm prefix -g`). */
export function globalPackageDir(prefix: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? path.join(prefix, 'node_modules', 'steptix')
    : path.join(prefix, 'lib', 'node_modules', 'steptix');
}

export function isSteptixPackage(dir: string): boolean {
  return packageVersionAt(dir) !== null && existsSync(path.join(dir, 'dist', 'index.js'));
}

/** The version of the `steptix` package at `dir`, or null. */
export function packageVersionAt(dir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf-8')) as { name?: unknown; version?: unknown };
    return pkg.name === 'steptix' && typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/** §6.8's notice for npm's `steptix` on another major.minor than the
 *  extension, or null when they share one. */
export function staleTerminalNotice(terminalVersion: string, extensionVersion: string): string | null {
  const t = majorMinorOf(terminalVersion);
  const e = majorMinorOf(extensionVersion);
  if (!t || !e || t === e) return null;
  return compareVersions(terminalVersion, extensionVersion) < 0
    ? `The steptix command in your terminal is ${t}. VS Code is on ${e}. ` +
        'Update it so both work on your projects the same way: npm i -g steptix'
    : `The steptix command in your terminal is ${t}, newer than this extension (${e}). Update the extension.`;
}

// ---------------------------------------------------------------------------
// The `steptix` script in <user root>/bin (§5.5)
// ---------------------------------------------------------------------------

/**
 * What the extension writes to `<user root>/bin/`: `steptix.cmd` on Windows,
 * `steptix` elsewhere, both starting `run-newest.mjs` with the Node.js the
 * server uses. That script starts the launcher of the newest server that
 * meets `requires` (or, failing one, the newest of all), which then honours a
 * `steptix server use` choice. It is written again whenever the extension
 * starts, so the Node.js and the requirement it bakes in stay current.
 */
/** In every script the extension writes to bin/, so it never replaces one it
 *  did not write, such as the Windows runtime installer's `steptix.cmd`. */
export const BIN_SCRIPT_MARK = 'Written by the Steptix extension for VS Code';

export function binScripts(args: {
  nodeExe: string;
  requires: string;
  platform: NodeJS.Platform;
  /** Where the scripts go. The command names its runner by this full path,
   *  not by its own folder: Add steptix to PATH may reach it through a link
   *  in another folder (§5.5). */
  binDir: string;
}): Record<string, { content: string; mode?: number }> {
  const runner = `// Written by the Steptix extension for VS Code. It runs the newest Steptix
// server installed in ../runtimes that matches ${args.requires}'s major.minor,
// else the newest of all, by importing its launcher in this process.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REQUIRES = ${JSON.stringify(args.requires)};
const here = path.dirname(fileURLToPath(import.meta.url));
const runtimes = path.join(here, '..', 'runtimes');
const parse = (v) => /^(\\d+)\\.(\\d+)\\.(\\d+)$/.exec(v)?.slice(1).map(Number) ?? null;
const cmp = (a, b) => { const x = parse(a), y = parse(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
let names = [];
try { names = readdirSync(runtimes); } catch {}
const installed = names.filter((n) => {
  if (!parse(n)) return false;
  try {
    const pkg = JSON.parse(readFileSync(path.join(runtimes, n, 'package.json'), 'utf-8'));
    return pkg.name === 'steptix' && pkg.version === n && existsSync(path.join(runtimes, n, 'dist', 'index.js'));
  } catch { return false; }
}).sort(cmp);
const [rm, rn, rp] = parse(REQUIRES);
const matching = installed.filter((n) => { const [m, i, p] = parse(n); return m === rm && i === rn && p >= rp; });
const pick = matching.at(-1) ?? installed.at(-1);
if (!pick) {
  process.stderr.write('No Steptix server is installed in ' + runtimes + '. In VS Code, run "Steptix: Install Server".\\n');
  process.exitCode = 1;
} else {
  process.argv[1] = path.join(runtimes, pick, 'dist', 'index.js');
  await import(pathToFileURL(process.argv[1]).href);
}
`;
  if (args.platform === 'win32') {
    const runnerPath = path.win32.join(args.binDir, 'run-newest.mjs');
    return {
      'run-newest.mjs': { content: runner },
      'steptix.cmd': { content: `@echo off\r\nrem ${BIN_SCRIPT_MARK}\r\n"${args.nodeExe}" "${runnerPath}" %*\r\n` },
    };
  }
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const runnerPath = path.posix.join(args.binDir, 'run-newest.mjs');
  return {
    'run-newest.mjs': { content: runner },
    steptix: { content: `#!/bin/sh\n# ${BIN_SCRIPT_MARK}\nexec ${quote(args.nodeExe)} ${quote(runnerPath)} "$@"\n`, mode: 0o755 },
  };
}

// ---------------------------------------------------------------------------
// PATH for every terminal (§5.5)
// ---------------------------------------------------------------------------

/**
 * A Windows user `Path` value with `dir` added at the end, or null when it is
 * there already in any spelling. Every other entry is kept as written,
 * `%VARIABLE%` entries unexpanded.
 */
export function addToWindowsPath(value: string, dir: string): string | null {
  const entries = value.split(';');
  const norm = (p: string) => p.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '').toLowerCase();
  if (entries.some((e) => norm(e) === norm(dir))) return null;
  const kept = value.replace(/;+$/, '');
  return kept === '' ? dir : `${kept};${dir}`;
}

/** The value with every spelling of `dir` taken out, or null when it was not there. */
export function removeFromWindowsPath(value: string, dir: string): string | null {
  const norm = (p: string) => p.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '').toLowerCase();
  const entries = value.split(';');
  const kept = entries.filter((e) => norm(e) !== norm(dir));
  return kept.length === entries.length ? null : kept.join(';');
}

/** The line added to a shell startup file, marked so it can be found again. */
export function shellRcLine(binDir: string): string {
  return `export PATH="$PATH:${binDir.replace(/(["\\$`])/g, '\\$1')}" # added by Steptix`;
}

/** The startup file content with the line added, or null when it is there. */
export function addShellRcLine(content: string, binDir: string): string | null {
  const line = shellRcLine(binDir);
  if (content.split(/\r?\n/).includes(line)) return null;
  return `${content}${content === '' || content.endsWith('\n') ? '' : '\n'}${line}\n`;
}

/** The content with Steptix's line taken out, or null when it was not there. */
export function removeShellRcLine(content: string, binDir: string): string | null {
  const line = shellRcLine(binDir);
  const lines = content.split('\n');
  const kept = lines.filter((l) => l.replace(/\r$/, '') !== line);
  return kept.length === lines.length ? null : kept.join('\n');
}

/** The startup file for the user's shell: `~/.zshrc` for zsh, else `~/.bashrc`. */
export function shellRcFile(home: string, shell: string | undefined): string {
  return path.join(home, shell && path.basename(shell) === 'zsh' ? '.zshrc' : '.bashrc');
}

/** What Add steptix to PATH changed, so Uninstall Server can undo it (§9.2). */
export interface PathChange {
  kind: 'windows-user-path' | 'link' | 'rc-line';
  /** The folder added, the link made, or the startup file changed. */
  target: string;
}

export function pathChangesFile(userRoot: string): string {
  return path.join(userRoot, 'bin', 'path-changes.json');
}

export function readPathChanges(userRoot: string): PathChange[] {
  try {
    const raw = JSON.parse(readFileSync(pathChangesFile(userRoot), 'utf-8')) as unknown;
    return Array.isArray(raw)
      ? raw.filter(
          (c): c is PathChange =>
            typeof c === 'object' &&
            c !== null &&
            ['windows-user-path', 'link', 'rc-line'].includes((c as PathChange).kind) &&
            typeof (c as PathChange).target === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// One download at a time (§4.7, §6.7)
// ---------------------------------------------------------------------------

/** Held while one window downloads a server or Node.js, so another window
 *  waits for it instead of downloading the same thing. Beside the launcher's
 *  own `runtimes/.lock`, which the copy into place takes. */
export function downloadLockFile(userRoot: string): string {
  return path.join(userRoot, 'runtimes', '.download.lock');
}

const LOCK_MAX_AGE_MS = 60 * 60 * 1000;

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Take the lock if it is free or abandoned. True when this process holds it. */
export function tryTakeLock(
  file: string,
  deps: { pid?: number; now?: () => number; isAlive?: (pid: number) => boolean } = {},
): boolean {
  const pid = deps.pid ?? process.pid;
  const now = deps.now ?? Date.now;
  const isAlive = deps.isAlive ?? pidAlive;
  mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      try {
        writeSync(fd, JSON.stringify({ pid, since: now() }));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    let abandoned: boolean;
    try {
      const owner = JSON.parse(readFileSync(file, 'utf-8')) as { pid?: unknown; since?: unknown };
      abandoned =
        typeof owner.pid !== 'number' ||
        typeof owner.since !== 'number' ||
        !isAlive(owner.pid) ||
        now() - owner.since > LOCK_MAX_AGE_MS;
    } catch (err) {
      // Gone since: free. Being written right now: judged by its age.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') abandoned = true;
      else {
        try {
          abandoned = now() - statSync(file).mtimeMs > 30_000;
        } catch {
          abandoned = true;
        }
      }
    }
    if (!abandoned) return false;
    rmSync(file, { force: true });
  }
  return false;
}

export function releaseLock(file: string, pid: number = process.pid): void {
  try {
    const owner = JSON.parse(readFileSync(file, 'utf-8')) as { pid?: unknown };
    if (owner.pid === pid) rmSync(file, { force: true });
  } catch {
    // Not ours, or gone.
  }
}

/** A name for a scratch folder beside its final place, never picked up as one. */
export function partialName(base: string): string {
  return `.partial-${base}-${process.pid}-${randomBytes(4).toString('hex')}`;
}

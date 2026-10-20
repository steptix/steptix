/**
 * Installing the Steptix server and, when needed, Node.js
 * (docs/specs/SPEC-install.md §4.4, §4.6, §4.7, §4.9, §4.11, §5.2–§5.4, §8).
 *
 * No `vscode` import: server-setup.ts shows the questions and the progress,
 * and this does the work, so the `node --test` suite can drive it with a fake
 * npm and a fake nodejs.org.
 *
 * How a server is installed, every step through the launcher's own code:
 *
 *  1. With the chosen Node.js's own npm, `npm install -g --prefix <scratch>
 *     steptix@~<needed>`. npm reads the user's own `.npmrc`, so a company
 *     registry and proxy apply (§4.11), and `-g` makes npm put the package's
 *     dependencies inside it, as a terminal's `npm i -g` does. The user's own
 *     npm install is never touched (§4.9).
 *  2. That copy's `steptix server install --json --source extension` copies it
 *     into `runtimes/<version>/` under the launcher's lock, temporary name
 *     first (§4.1), exactly as a first terminal command would.
 *  3. The scratch folder goes.
 *
 * One window downloads at a time: the others wait on `runtimes/.download.lock`
 * and then use what it installed (§6.7).
 */

import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  chooseNode,
  compareVersions,
  downloadLockFile,
  globalPackageDir,
  listInstalledServers,
  nodeArchiveFrom,
  nodeExeIn,
  nodeVersionOf,
  npmCliBeside,
  npmSpecFor,
  partialName,
  pickServer,
  readServerChoice,
  releaseLock,
  serverSatisfies,
  sha256Of,
  tryTakeLock,
  type InstalledServer,
  type NodeChoice,
} from './install-core.ts';

/** Why an install failed, and so which of §8's messages fits. */
export type InstallFailureKind =
  /** npm could not fetch or install the server: no network, a blocked registry (§8.1). */
  | 'server-download'
  /** nodejs.org could not be reached, or sent a file that did not match its fingerprint (§8.2). */
  | 'node-download'
  /** Anything else: a full disk, a damaged download, a refused copy. */
  | 'other';

export class InstallFailure extends Error {
  readonly kind: InstallFailureKind;
  /** What npm or the copy printed, for Show details. */
  readonly details: string;
  constructor(kind: InstallFailureKind, message: string, details = '') {
    super(message);
    this.kind = kind;
    this.details = details;
  }
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type Runner = (
  exe: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<RunResult>;

/** Run a program to completion, collecting its output. Never throws for a
 *  non-zero exit; a program that cannot start at all comes back as code null. */
export const defaultRunner: Runner = (exe, args, opts) =>
  new Promise((resolve) => {
    execFile(
      exe,
      args,
      {
        cwd: opts.cwd,
        env: opts.env,
        signal: opts.signal,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') + (code === null && err ? err.message : '') });
      },
    );
  });

export interface InstallerDeps {
  userRoot: string;
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  run?: Runner;
  fetch?: (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;
  sleep?: (ms: number) => Promise<void>;
  /** A line for the Output panel. */
  log: (line: string) => void;
  /** Where the install is, in a few words, for the progress display. */
  onStep?: (text: string) => void;
  /** Called once when another window holds the download lock. */
  onWait?: () => void;
  signal?: AbortSignal;
  /** How a Node.js says its version: `node --version` unless a test fakes it. */
  versionOf?: (exe: string) => Promise<string | null>;
  /** Where nodejs.org's current Node.js 22 folder is. */
  nodeDistUrl?: string;
}

const NODE_DIST_URL = 'https://nodejs.org/dist/latest-v22.x/';
const LOCK_POLL_MS = 500;

function sleeper(deps: InstallerDeps): (ms: number) => Promise<void> {
  return deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

/** Hold the download lock while `fn` runs, waiting for another window first. */
async function withDownloadLock<T>(deps: InstallerDeps, fn: () => Promise<T>): Promise<T> {
  const file = downloadLockFile(deps.userRoot);
  const sleep = sleeper(deps);
  let waited = false;
  while (!tryTakeLock(file)) {
    if (deps.signal?.aborted) throw new InstallFailure('other', 'The install was cancelled.');
    if (!waited) {
      waited = true;
      deps.onWait?.();
    }
    await sleep(LOCK_POLL_MS);
  }
  try {
    return await fn();
  } finally {
    releaseLock(file);
  }
}

/** The output's last line that parses as JSON, as `--json` commands print it. */
function lastJsonLine(text: string): unknown {
  const lines = text.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      // Not this one.
    }
  }
  return undefined;
}

function tail(text: string, lines = 12): string {
  return text.trim().split(/\r?\n/).slice(-lines).join('\n');
}

// ---------------------------------------------------------------------------
// Node.js (§4.6)
// ---------------------------------------------------------------------------

/**
 * Download Node.js from nodejs.org into `<user root>/node/<version>/`,
 * checked against the SHA-256 nodejs.org publishes for the file, and return
 * it. Only the extension does this; the launcher cannot, since it is itself
 * running on Node.js.
 */
export async function downloadNode(deps: InstallerDeps): Promise<NodeChoice> {
  const fetchFn = deps.fetch ?? ((url, init) => fetch(url, init));
  const base = deps.nodeDistUrl ?? NODE_DIST_URL;
  return withDownloadLock(deps, async () => {
    // Another window may have downloaded one while this one waited.
    const present = await chooseNode({
      userRoot: deps.userRoot,
      env: {},
      platform: deps.platform,
      ...(deps.versionOf && { versionOf: deps.versionOf }),
    });
    if (present) return present;

    deps.onStep?.('Downloading Node.js');
    let shasums: string;
    try {
      const res = await fetchFn(`${base}SHASUMS256.txt`, { ...(deps.signal && { signal: deps.signal }) });
      if (!res.ok) throw new Error(`nodejs.org answered HTTP ${res.status}`);
      shasums = await res.text();
    } catch (err) {
      throw new InstallFailure('node-download', `Could not reach nodejs.org: ${(err as Error).message}`);
    }
    const archive = nodeArchiveFrom(shasums, deps.platform, deps.arch);
    if (!archive) {
      throw new InstallFailure('node-download', `nodejs.org lists no Node.js 22 for ${deps.platform}-${deps.arch}.`);
    }
    deps.log(`downloading ${base}${archive.file}`);
    let data: Uint8Array;
    try {
      const res = await fetchFn(`${base}${archive.file}`, { ...(deps.signal && { signal: deps.signal }) });
      if (!res.ok) throw new Error(`nodejs.org answered HTTP ${res.status}`);
      data = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      throw new InstallFailure('node-download', `Could not download ${archive.file}: ${(err as Error).message}`);
    }
    const actual = sha256Of(data);
    if (actual !== archive.sha256) {
      throw new InstallFailure(
        'node-download',
        `The Node.js download did not match the fingerprint nodejs.org publishes for ${archive.file}, so it was not used.`,
        `expected sha256 ${archive.sha256}\nreceived sha256 ${actual}`,
      );
    }

    const nodeRoot = path.join(deps.userRoot, 'node');
    const partial = path.join(nodeRoot, partialName(archive.version));
    const final = path.join(nodeRoot, archive.version);
    mkdirSync(partial, { recursive: true });
    try {
      const archivePath = path.join(partial, archive.file);
      writeFileSync(archivePath, data);
      await extract(deps, archivePath, partial);
      const top = readdirSync(partial).find((n) => n.startsWith('node-v') && n !== archive.file);
      if (!top) throw new InstallFailure('other', `${archive.file} held no Node.js folder.`);
      rmSync(final, { recursive: true, force: true, maxRetries: 3 });
      renameSync(path.join(partial, top), final);
    } finally {
      rmSync(partial, { recursive: true, force: true, maxRetries: 3 });
    }
    const exe = nodeExeIn(final, deps.platform);
    const version = await (deps.versionOf ?? nodeVersionOf)(exe);
    if (version !== archive.version) {
      throw new InstallFailure('other', `The Node.js unpacked into ${final} does not start.`);
    }
    deps.log(`Node.js ${version} is in ${final}`);
    return { exe, version, origin: 'steptix' };
  });
}

/** Unpack a nodejs.org archive with the system's own tar, which also reads a
 *  zip on Windows 10 and later. Windows' own, by full path: a Git for Windows
 *  tar on PATH cannot read a zip. */
async function extract(deps: InstallerDeps, archive: string, into: string): Promise<void> {
  const run = deps.run ?? defaultRunner;
  const tar =
    deps.platform === 'win32'
      ? path.join(deps.env['SystemRoot'] ?? deps.env['SYSTEMROOT'] ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
  const result = await run(tar, ['-xf', archive, '-C', into], { ...(deps.signal && { signal: deps.signal }) });
  if (result.code !== 0) {
    throw new InstallFailure('other', `Could not unpack ${path.basename(archive)}.`, tail(result.stderr));
  }
}

/** The Node.js to install and run the server with, downloading one when the
 *  machine has none new enough and `allowDownload` says the user agreed. */
export async function ensureNode(deps: InstallerDeps, allowDownload: boolean): Promise<NodeChoice | null> {
  const found = await chooseNode({
    userRoot: deps.userRoot,
    env: deps.env,
    platform: deps.platform,
    ...(deps.versionOf && { versionOf: deps.versionOf }),
  });
  if (found || !allowDownload) return found;
  return downloadNode(deps);
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export interface ServerInstallResult {
  server: InstalledServer;
  /** False when a matching one was there already, from another window. */
  installed: boolean;
}

/** Run `steptix server install --json` in the package at `pkgDir`. */
async function setUpPackage(
  deps: InstallerDeps,
  node: NodeChoice,
  pkgDir: string,
  source: 'extension' | undefined,
): Promise<InstalledServer> {
  const run = deps.run ?? defaultRunner;
  const args = [path.join(pkgDir, 'dist', 'index.js'), 'server', 'install', '--json', ...(source ? ['--source', source] : [])];
  const result = await run(node.exe, args, { cwd: pkgDir, env: deps.env, ...(deps.signal && { signal: deps.signal }) });
  const reported = lastJsonLine(result.stdout) as { version?: unknown; dir?: unknown } | undefined;
  if (result.code !== 0 || typeof reported?.version !== 'string') {
    throw new InstallFailure(
      'other',
      `Could not set up the Steptix server from ${pkgDir}.`,
      tail(`${result.stderr}\n${result.stdout}`),
    );
  }
  const server = listInstalledServers(path.join(deps.userRoot, 'runtimes')).find((s) => s.version === reported.version);
  if (!server) {
    throw new InstallFailure('other', `Steptix ${reported.version} was set up but is not in ${path.join(deps.userRoot, 'runtimes')}.`);
  }
  return server;
}

/**
 * Set up npm's own copy of `steptix` (§5.3): what a first terminal command
 * would have done. Nothing is downloaded.
 */
export async function setUpNpmPackage(deps: InstallerDeps, node: NodeChoice, pkgDir: string): Promise<InstalledServer> {
  return setUpPackage(deps, node, pkgDir, undefined);
}

/**
 * Download and install the newest server meeting `requires` into
 * `runtimes/` (§5.2 step 4, §6.2), unless one is there already.
 */
export async function installServer(
  deps: InstallerDeps,
  node: NodeChoice,
  requires: string,
): Promise<ServerInstallResult> {
  return withDownloadLock(deps, async () => {
    const runtimesDir = path.join(deps.userRoot, 'runtimes');
    const already = pickServer(listInstalledServers(runtimesDir), requires, null);
    // Another window may have installed one while this one waited. Only a
    // newer published patch is a reason to go on, and the caller asks for
    // that explicitly with `installServerVersion`.
    if (already.kind === 'run') return { server: already.server, installed: false };
    return { server: await downloadAndSetUp(deps, node, npmSpecFor(requires)), installed: true };
  });
}

/** Install one exact published version, for a newer patch (§6.2). */
export async function installServerVersion(
  deps: InstallerDeps,
  node: NodeChoice,
  version: string,
): Promise<ServerInstallResult> {
  return withDownloadLock(deps, async () => {
    const existing = listInstalledServers(path.join(deps.userRoot, 'runtimes')).find((s) => s.version === version);
    if (existing) return { server: existing, installed: false };
    return { server: await downloadAndSetUp(deps, node, `steptix@${version}`), installed: true };
  });
}

async function downloadAndSetUp(deps: InstallerDeps, node: NodeChoice, spec: string): Promise<InstalledServer> {
  const run = deps.run ?? defaultRunner;
  const npmCli = npmCliBeside(node.exe, deps.platform);
  if (!npmCli) {
    throw new InstallFailure(
      'other',
      `npm was not found beside the Node.js at ${node.exe}. Reinstall Node.js 22.21 or later from nodejs.org, with npm.`,
    );
  }
  const runtimesDir = path.join(deps.userRoot, 'runtimes');
  const scratch = path.join(runtimesDir, partialName('npm'));
  mkdirSync(scratch, { recursive: true });
  try {
    deps.onStep?.(`Downloading ${spec.replace('@~', ' ')}`);
    deps.log(`npm install -g --prefix ${scratch} ${spec}`);
    const result = await run(
      node.exe,
      [npmCli, 'install', '-g', '--prefix', scratch, spec, '--no-audit', '--no-fund', '--loglevel=error'],
      { cwd: scratch, env: deps.env, ...(deps.signal && { signal: deps.signal }) },
    );
    if (result.code !== 0) {
      throw new InstallFailure('server-download', npmReason(result.stderr), tail(`${result.stderr}\n${result.stdout}`, 30));
    }
    deps.onStep?.('Setting up the Steptix server');
    return await setUpPackage(deps, node, globalPackageDir(scratch, deps.platform), 'extension');
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** npm's reason, in a line: its first `npm error` line that says something. */
export function npmReason(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.replace(/^npm (ERR!|error)\s*/, '').trim())
    .filter((l) => l && !/^(A complete log|code |errno |syscall |Log files were not written|$)/.test(l));
  return lines[0] ?? 'npm failed without saying why';
}

/**
 * The newest published version meeting `requires` (§6.2's daily check), from
 * `npm view`. Null when npm could not say (no network); the check simply
 * waits for the next time.
 */
export async function newestPublishedServer(deps: InstallerDeps, node: NodeChoice, requires: string): Promise<string | null> {
  const run = deps.run ?? defaultRunner;
  const npmCli = npmCliBeside(node.exe, deps.platform);
  if (!npmCli) return null;
  const result = await run(node.exe, [npmCli, 'view', npmSpecFor(requires), 'version', '--json'], {
    env: deps.env,
    ...(deps.signal && { signal: deps.signal }),
  });
  if (result.code !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const versions = (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (v): v is string => typeof v === 'string' && serverSatisfies(v, requires),
  );
  return versions.sort(compareVersions).at(-1) ?? null;
}

/** The server the extension would run now, after any install. */
export function currentPick(userRoot: string, requires: string) {
  return pickServer(listInstalledServers(path.join(userRoot, 'runtimes')), requires, readServerChoice(userRoot));
}

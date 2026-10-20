/**
 * The servers in `<Steptix folder>/runtimes/` and the records beside them
 * (docs/specs/SPEC-install.md §3.3, §4.1–§4.3, §4.7).
 *
 * - `runtimes/<version>/` holds one whole `steptix` package. It is copied in
 *   under a temporary name and renamed when complete, so a half-finished copy
 *   is never picked up (§4.1), and nothing ever writes into it afterwards
 *   (§4.3).
 * - `runtimes/.lock` lets one process at a time install or remove (§4.7).
 * - `runtimes/.in-use/<version>@<pid>` says a process is running from that
 *   version, so it is not removed under it (§4.3).
 * - `clients/<kind>-<id>.json` records each extension and launcher on the
 *   machine and the server it needs, so the clean-up knows which major.minor
 *   versions are still wanted (§4.3).
 * - `server-choice.json` holds the version chosen with `steptix server use`
 *   (§6.5).
 *
 * Imports only Node built-ins and modules that import nothing else: the
 * launcher runs before every command, and `steptix mcp` keeps stdout to itself.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isPidAlive } from '../utils/pid-alive.js';
import { compareVersions, parseVersion, satisfies } from './versions.js';

/** Where an installed server came from, as `steptix server list` shows it. */
export type RuntimeSource = 'npm' | 'extension' | 'offline file';

export interface Runtime {
  version: string;
  /** `<Steptix folder>/runtimes/<version>`. */
  dir: string;
  /** Null for a folder that predates the record, or whose record is unreadable. */
  source: RuntimeSource | null;
}

/** Every path the launcher uses under one Steptix folder. */
export interface Layout {
  root: string;
  runtimesDir: string;
  clientsDir: string;
  choiceFile: string;
  inUseDir: string;
  lockFile: string;
}

export function layoutOf(userRoot: string): Layout {
  const runtimesDir = path.join(userRoot, 'runtimes');
  return {
    root: userRoot,
    runtimesDir,
    clientsDir: path.join(userRoot, 'clients'),
    choiceFile: path.join(userRoot, 'server-choice.json'),
    inUseDir: path.join(runtimesDir, '.in-use'),
    lockFile: path.join(runtimesDir, '.lock'),
  };
}

/** Written into a runtime folder before it is renamed into place. */
export const INSTALL_RECORD = '.steptix-install.json';

const PARTIAL_PREFIX = '.partial-';
const REMOVING_PREFIX = '.removing-';

// ---------------------------------------------------------------------------
// Packages and runtime folders
// ---------------------------------------------------------------------------

export interface PackageInfo {
  name: string;
  version: string;
  dependencies: Record<string, string>;
  /** `"offline"` in the offline files (§5.6), absent in the npm package. */
  steptixDistribution?: string;
}

export function readPackageInfo(dir: string): PackageInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) as Record<string, unknown>;
    if (typeof raw['name'] !== 'string' || typeof raw['version'] !== 'string') return null;
    const deps = raw['dependencies'];
    const info: PackageInfo = {
      name: raw['name'],
      version: raw['version'],
      dependencies: typeof deps === 'object' && deps !== null ? (deps as Record<string, string>) : {},
    };
    if (typeof raw['steptixDistribution'] === 'string') info.steptixDistribution = raw['steptixDistribution'];
    return info;
  } catch {
    return null;
  }
}

/**
 * The runtime in `runtimes/<name>`, or null when that folder is not one: a
 * `steptix` package whose version is the folder's name, with its entry point.
 * Anything else there — a partial copy, a folder from the retired Windows
 * installer — is not a server to run or to remove.
 */
export function readRuntime(runtimesDir: string, name: string): Runtime | null {
  if (parseVersion(name) === null) return null;
  const dir = path.join(runtimesDir, name);
  const pkg = readPackageInfo(dir);
  if (pkg?.name !== 'steptix' || pkg.version !== name) return null;
  if (!fs.existsSync(path.join(dir, 'dist', 'index.js'))) return null;
  let source: RuntimeSource | null = null;
  try {
    const record = JSON.parse(fs.readFileSync(path.join(dir, INSTALL_RECORD), 'utf-8')) as { source?: unknown };
    if (record.source === 'npm' || record.source === 'extension' || record.source === 'offline file') {
      source = record.source;
    }
  } catch {
    // No record: shown as an unknown source.
  }
  return { version: name, dir, source };
}

/** Every runtime installed, oldest first. */
export function listRuntimes(layout: Layout): Runtime[] {
  let names: string[];
  try {
    names = fs.readdirSync(layout.runtimesDir);
  } catch {
    return [];
  }
  return names
    .map((name) => readRuntime(layout.runtimesDir, name))
    .filter((r): r is Runtime => r !== null)
    .sort((a, b) => compareVersions(a.version, b.version));
}

// ---------------------------------------------------------------------------
// Which server runs (§4.2, §6.5)
// ---------------------------------------------------------------------------

export interface Selection {
  /** The runtime to run, or null when none is installed that fits. */
  runtime: Runtime | null;
  /** True when `runtime` is the one chosen with `steptix server use`. */
  chosen: boolean;
  /** A chosen version that is no longer installed, so the choice was set aside. */
  chosenMissing: string | null;
}

/**
 * The chosen version when there is one and it is installed, else the newest
 * runtime that satisfies `requires`.
 *
 * A choice wins whatever its major.minor: `steptix server use 1.3.0` is the
 * way back to an older version (§6.5), so the terminal runs what the user
 * chose. The extension is stricter, and refuses a chosen version that does
 * not match it.
 */
export function selectRuntime(runtimes: Runtime[], requires: string, choice: string | null): Selection {
  if (choice !== null) {
    const picked = runtimes.find((r) => r.version === choice);
    if (picked) return { runtime: picked, chosen: true, chosenMissing: null };
  }
  const newest = runtimes.filter((r) => satisfies(r.version, requires)).at(-1) ?? null;
  return { runtime: newest, chosen: false, chosenMissing: choice };
}

export function readChoice(layout: Layout): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(layout.choiceFile, 'utf-8')) as { version?: unknown };
    return typeof raw.version === 'string' && parseVersion(raw.version) !== null ? raw.version : null;
  } catch {
    return null;
  }
}

/** Record `version` as the chosen one, or clear the choice with null. */
export function writeChoice(layout: Layout, version: string | null): void {
  if (version === null) {
    fs.rmSync(layout.choiceFile, { force: true });
    return;
  }
  writeFileAtomic(layout.choiceFile, JSON.stringify({ version }, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

const processAlive = isPidAlive;

export interface ProcessDeps {
  isAlive?: (pid: number) => boolean;
  pid?: number;
}

// ---------------------------------------------------------------------------
// One install at a time (§4.7)
// ---------------------------------------------------------------------------

/** A lock older than this is taken over even when its pid answers, since a
 *  reused pid would otherwise hold it for ever. Installs take minutes at most. */
const LOCK_MAX_AGE_MS = 60 * 60 * 1000;
const LOCK_POLL_MS = 250;

export interface LockDeps extends ProcessDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called once, when the lock is found held by another live process. */
  onWait?: () => void;
}

interface LockOwner {
  pid: number;
  since: number;
}

function readLockOwner(lockFile: string): LockOwner | null | 'unreadable' {
  let text: string;
  try {
    text = fs.readFileSync(lockFile, 'utf-8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable';
  }
  try {
    const owner = JSON.parse(text) as Partial<LockOwner>;
    if (typeof owner.pid === 'number' && typeof owner.since === 'number') return { pid: owner.pid, since: owner.since };
  } catch {
    // Being written right now, or torn: judged by age below.
  }
  return 'unreadable';
}

/** Take the lock if it is free or abandoned. True when this process now holds it. */
function tryTakeLock(layout: Layout, deps: LockDeps): boolean {
  const pid = deps.pid ?? process.pid;
  const now = deps.now ?? Date.now;
  const isAlive = deps.isAlive ?? processAlive;
  fs.mkdirSync(layout.runtimesDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(layout.lockFile, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid, since: now() }));
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const owner = readLockOwner(layout.lockFile);
    let abandoned: boolean;
    if (owner === null) {
      abandoned = true; // released between our open and our read
    } else if (owner === 'unreadable') {
      let age = 0;
      try {
        age = now() - fs.statSync(layout.lockFile).mtimeMs;
      } catch {
        age = Infinity;
      }
      abandoned = age > 30_000;
    } else {
      abandoned = !isAlive(owner.pid) || now() - owner.since > LOCK_MAX_AGE_MS;
    }
    if (!abandoned) return false;
    fs.rmSync(layout.lockFile, { force: true });
  }
  return false;
}

function releaseLock(layout: Layout, deps: LockDeps): void {
  const owner = readLockOwner(layout.lockFile);
  if (owner !== null && owner !== 'unreadable' && owner.pid === (deps.pid ?? process.pid)) {
    fs.rmSync(layout.lockFile, { force: true });
  }
}

/** Run `fn` holding the install lock, waiting for another process to finish first. */
export async function withInstallLock<T>(layout: Layout, fn: () => T | Promise<T>, deps: LockDeps = {}): Promise<T> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let waited = false;
  while (!tryTakeLock(layout, deps)) {
    if (!waited) {
      waited = true;
      deps.onWait?.();
    }
    await sleep(LOCK_POLL_MS);
  }
  try {
    return await fn();
  } finally {
    releaseLock(layout, deps);
  }
}

/** Run `fn` holding the lock if it is free now, else skip it and return undefined. */
export async function ifInstallLockFree<T>(
  layout: Layout,
  fn: () => T | Promise<T>,
  deps: LockDeps = {},
): Promise<T | undefined> {
  if (!tryTakeLock(layout, deps)) return undefined;
  try {
    return await fn();
  } finally {
    releaseLock(layout, deps);
  }
}

// ---------------------------------------------------------------------------
// Installing (§4.1, §5.1)
// ---------------------------------------------------------------------------

export class InstallError extends Error {}

/**
 * The package cannot be copied because its dependencies live outside it: a
 * local install, which npm hoists into the project's own `node_modules`. It
 * works where it is, so the launcher runs it there without a word.
 */
export class NotSelfContainedError extends InstallError {}

/**
 * Dependencies of the package at `packageRoot` that a copy in `targetDir`
 * could not load. npm puts a global package's dependencies inside it, so a
 * copy takes them along. A local install hoists them into the project's own
 * `node_modules`, and a copy of the package alone would not start.
 */
export function missingDependencies(packageRoot: string, pkg: PackageInfo, targetDir: string): string[] {
  const ancestors: string[] = [];
  for (let dir = path.dirname(targetDir); ; dir = path.dirname(dir)) {
    ancestors.push(path.join(dir, 'node_modules'));
    if (path.dirname(dir) === dir) break;
  }
  const found = (name: string, base: string) => fs.existsSync(path.join(base, name, 'package.json'));
  return Object.keys(pkg.dependencies).filter(
    (name) => !found(name, path.join(packageRoot, 'node_modules')) && !ancestors.some((base) => found(name, base)),
  );
}

export interface InstallResult {
  runtime: Runtime;
  /** False when that version was already installed and nothing was copied. */
  installed: boolean;
}

export interface InstallOptions extends LockDeps {
  /** Called just before copying, so the caller can say it is setting up. */
  onCopy?: (version: string) => void;
}

/**
 * Copy the `steptix` package at `packageRoot` into `runtimes/<version>/`,
 * unless that version is there already.
 */
export async function installPackage(
  packageRoot: string,
  layout: Layout,
  opts: InstallOptions = {},
): Promise<InstallResult> {
  const pkg = readPackageInfo(packageRoot);
  if (pkg?.name !== 'steptix' || parseVersion(pkg.version) === null) {
    throw new InstallError(`${packageRoot} does not hold a steptix package.`);
  }
  const version = pkg.version;
  const existing = readRuntime(layout.runtimesDir, version);
  if (existing) return { runtime: existing, installed: false };
  const target = path.join(layout.runtimesDir, version);
  const missing = missingDependencies(packageRoot, pkg, target);
  if (missing.length > 0) {
    throw new NotSelfContainedError(
      `The steptix package in ${packageRoot} does not hold its own dependencies (${missing.slice(0, 3).join(', ')}` +
        `${missing.length > 3 ? ', …' : ''}), so a copy of it would not start. Install it with npm i -g steptix.`,
    );
  }
  return withInstallLock(
    layout,
    async () => {
      // Another process may have installed it while this one waited.
      const now = readRuntime(layout.runtimesDir, version);
      if (now) return { runtime: now, installed: false };
      removeLeftovers(layout);
      opts.onCopy?.(version);
      const partial = path.join(
        layout.runtimesDir,
        `${PARTIAL_PREFIX}${version}-${opts.pid ?? process.pid}-${crypto.randomBytes(4).toString('hex')}`,
      );
      try {
        // verbatimSymlinks: npm's `.bin` links are relative and must stay so,
        // or they would point back into npm's folder.
        fs.cpSync(packageRoot, partial, { recursive: true, verbatimSymlinks: true });
        const source: RuntimeSource = pkg.steptixDistribution === 'offline' ? 'offline file' : 'npm';
        fs.writeFileSync(
          path.join(partial, INSTALL_RECORD),
          JSON.stringify({ version, source, from: packageRoot }, null, 2) + '\n',
        );
        await renamePatiently(partial, target, opts.sleep);
      } catch (err) {
        fs.rmSync(partial, { recursive: true, force: true, maxRetries: 3 });
        throw new InstallError(`Could not copy Steptix ${version} into ${target}: ${(err as Error).message}`);
      }
      const runtime = readRuntime(layout.runtimesDir, version);
      if (!runtime) throw new InstallError(`Steptix ${version} was copied into ${target} but cannot be read back.`);
      return { runtime, installed: true };
    },
    opts,
  );
}

const RENAME_ATTEMPTS = 10;

/**
 * Rename a folder just written, trying again for a while when Windows says it
 * is busy. A virus scanner reads new files as they are written and holds them
 * open for a moment, and a folder holding an open file cannot be renamed:
 * EPERM, EACCES or EBUSY. npm retries the same way. Elsewhere those codes
 * mean a permission that waiting will not change.
 */
export async function renamePatiently(
  from: string,
  to: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const busy = platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY');
      if (!busy || attempt >= RENAME_ATTEMPTS) throw err;
      await sleep(100 * attempt);
    }
  }
}

/**
 * Remove what an interrupted install or removal left (§8.3). Only called
 * holding the lock, and only the lock holder copies or removes, so every
 * partial folder there is abandoned.
 */
function removeLeftovers(layout: Layout): void {
  let names: string[];
  try {
    names = fs.readdirSync(layout.runtimesDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(PARTIAL_PREFIX) || name.startsWith(REMOVING_PREFIX)) {
      try {
        fs.rmSync(path.join(layout.runtimesDir, name), { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // A file still open on Windows: the next attempt tries again.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// In use (§4.3)
// ---------------------------------------------------------------------------

/** Mark `version` as in use by this process until it exits. Returns the unmark. */
export function markInUse(layout: Layout, version: string, deps: ProcessDeps = {}): () => void {
  const file = path.join(layout.inUseDir, `${version}@${deps.pid ?? process.pid}`);
  try {
    fs.mkdirSync(layout.inUseDir, { recursive: true });
    fs.writeFileSync(file, '');
  } catch {
    // Unmarked, it may be removed under us by a clean-up, which only
    // removes versions nothing needs.
    return () => {};
  }
  return () => fs.rmSync(file, { force: true });
}

/** Versions some live process runs from, each with its pids. Marks left by
 *  processes that have gone are removed on the way. */
export function versionsInUse(layout: Layout, deps: ProcessDeps = {}): Map<string, number[]> {
  const isAlive = deps.isAlive ?? processAlive;
  const out = new Map<string, number[]>();
  let names: string[];
  try {
    names = fs.readdirSync(layout.inUseDir);
  } catch {
    return out;
  }
  for (const name of names) {
    const at = name.lastIndexOf('@');
    const pid = Number(name.slice(at + 1));
    const version = name.slice(0, at);
    if (at <= 0 || !Number.isInteger(pid) || pid <= 0) continue;
    if (!isAlive(pid)) {
      fs.rmSync(path.join(layout.inUseDir, name), { force: true });
      continue;
    }
    out.set(version, [...(out.get(version) ?? []), pid]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Clients (§4.3)
// ---------------------------------------------------------------------------

export interface ClientRecord {
  /** `launcher` for a `steptix` command, `vscode` for the VS Code extension. */
  kind: string;
  version: string;
  /** The server it needs: this major.minor, at least this patch. */
  requires: string;
  /** Where the client is installed. A record whose location has gone is dropped. */
  location: string;
}

function clientFile(layout: Layout, kind: string, location: string): string {
  // One file per place a client is installed. Folded on the file systems
  // that ignore case, so two spellings of one folder share a record.
  const resolved = path.resolve(location);
  const key = process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
  const id = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  return path.join(layout.clientsDir, `${kind}-${id}.json`);
}

/** Record a client, rewriting its file only when something changed. */
export function writeClientRecord(layout: Layout, record: ClientRecord): void {
  const file = clientFile(layout, record.kind, record.location);
  const content = JSON.stringify(record, null, 2) + '\n';
  try {
    if (fs.readFileSync(file, 'utf-8') === content) return;
  } catch {
    // Not there yet.
  }
  fs.mkdirSync(layout.clientsDir, { recursive: true });
  writeFileAtomic(file, content);
}

/** Every recorded client still installed. Records of clients that have gone
 *  (an uninstalled extension, `npm rm -g steptix`) are removed on the way. */
export function readClientRecords(layout: Layout): ClientRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(layout.clientsDir);
  } catch {
    return [];
  }
  const out: ClientRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(layout.clientsDir, name);
    let record: Partial<ClientRecord>;
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<ClientRecord>;
    } catch {
      continue;
    }
    if (
      typeof record.kind !== 'string' ||
      typeof record.version !== 'string' ||
      typeof record.requires !== 'string' ||
      typeof record.location !== 'string'
    ) {
      continue;
    }
    if (!fs.existsSync(record.location)) {
      fs.rmSync(file, { force: true });
      continue;
    }
    out.push(record as ClientRecord);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Clean-up (§4.3)
// ---------------------------------------------------------------------------

export interface KeepInput {
  runtimes: Runtime[];
  clients: ClientRecord[];
  choice: string | null;
  inUse: ReadonlySet<string>;
  /** Also kept, such as the version this process is about to run. */
  extra?: Iterable<string>;
}

/**
 * Which installed versions stay:
 * - for each client's need, the newest server that meets it,
 * - the newest of all, and the one before it, so going back needs no
 *   download (§6.5),
 * - the chosen one,
 * - any that something runs from; those go the next time Steptix checks.
 */
export function versionsToKeep(input: KeepInput): Set<string> {
  const versions = input.runtimes.map((r) => r.version).sort(compareVersions);
  const keep = new Set<string>([...input.inUse, ...(input.extra ?? [])]);
  for (const client of input.clients) {
    const newest = versions.filter((v) => satisfies(v, client.requires)).at(-1);
    if (newest) keep.add(newest);
  }
  for (const v of versions.slice(-2)) keep.add(v);
  if (input.choice !== null) keep.add(input.choice);
  return keep;
}

export interface RemoveResult {
  removed: string[];
  /** Versions that could not be removed now, with why. */
  skipped: Array<{ version: string; reason: string }>;
}

/**
 * Remove `runtimes` from disk, each renamed out of the way first so nothing
 * picks it up half-deleted. Call holding the lock. A version in use is
 * skipped.
 */
export function removeRuntimes(layout: Layout, runtimes: Runtime[], deps: ProcessDeps = {}): RemoveResult {
  const inUse = versionsInUse(layout, deps);
  const result: RemoveResult = { removed: [], skipped: [] };
  for (const runtime of runtimes) {
    if (inUse.has(runtime.version)) {
      result.skipped.push({ version: runtime.version, reason: 'running' });
      continue;
    }
    const aside = path.join(
      layout.runtimesDir,
      `${REMOVING_PREFIX}${runtime.version}-${deps.pid ?? process.pid}-${crypto.randomBytes(4).toString('hex')}`,
    );
    try {
      fs.renameSync(runtime.dir, aside);
    } catch (err) {
      // On Windows a file held open (a running esbuild, say) blocks the rename.
      result.skipped.push({ version: runtime.version, reason: (err as Error).message });
      continue;
    }
    result.removed.push(runtime.version);
    try {
      fs.rmSync(aside, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Out of the way already; the next clean-up finishes it.
    }
  }
  removeLeftovers(layout);
  return result;
}

/** The installed runtimes nothing needs any more. */
function unneededRuntimes(layout: Layout, runtimes: Runtime[], opts: ProcessDeps & { keep?: Iterable<string> }): Runtime[] {
  const keep = versionsToKeep({
    runtimes,
    clients: readClientRecords(layout),
    choice: readChoice(layout),
    inUse: new Set(versionsInUse(layout, opts).keys()),
    ...(opts.keep ? { extra: opts.keep } : {}),
  });
  return runtimes.filter((r) => !keep.has(r.version));
}

/**
 * Remove the versions nothing needs any more, if no other process holds the
 * lock right now. Returns what was removed, or undefined when it was skipped.
 *
 * Usually there is nothing to remove, so that is worked out first, without the
 * lock, from `runtimes` when the caller has just listed them. Only when there
 * is something does it take the lock, and then it works it out again.
 */
export async function cleanUp(
  layout: Layout,
  opts: LockDeps & { keep?: Iterable<string>; runtimes?: Runtime[] } = {},
): Promise<RemoveResult | undefined> {
  if (unneededRuntimes(layout, opts.runtimes ?? listRuntimes(layout), opts).length === 0) {
    return { removed: [], skipped: [] };
  }
  return ifInstallLockFree(
    layout,
    () => {
      const remove = unneededRuntimes(layout, listRuntimes(layout), opts);
      return remove.length === 0 ? { removed: [], skipped: [] } : removeRuntimes(layout, remove, opts);
    },
    opts,
  );
}

// ---------------------------------------------------------------------------

function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Browser launcher — resolve Chrome/Edge binaries per OS and spawn one with
 * `--remote-debugging-port=0` against a framework-owned profile directory, then
 * read back the port Chromium chose.
 *
 * Ported from `flick-vscode/src/extension/browser-launcher.ts`
 * (stories/mcp-cdp-browser.md §9). Two things changed on the way, both
 * load-bearing:
 *
 * 1. **The port is 0.** The extension passed a fixed port it had picked. The
 *    usual alternative — bind 0 in this process, read the number, close, hand
 *    it to the child — races: between the close and the child's bind, anything
 *    can take it. Passing 0 *to the child* makes collision impossible rather
 *    than merely unlikely, because the process that chooses the port is the
 *    one that holds it.
 * 2. **Readiness has two halves.** Not knowing the port, we cannot poll it.
 *    So: wait for `DevToolsActivePort` to learn the number, *then* poll that
 *    number to learn it is listening. W0 measured the gap between the two at
 *    212–321 ms across Chrome 150 and Edge 151 — a readiness check that stops
 *    at "the file exists" hands back a port that is not accepting connections
 *    yet, and the caller's first `connectOverCDP` fails against a browser that
 *    was perfectly healthy.
 *
 * One optional flag was added later, after the extension's set was ported:
 * `--disable-blink-features=AutomationControlled`, because a Chrome started
 * with `--remote-debugging-port` otherwise tells every page it is automated
 * (`navigator.webdriver === true`). It is opt-in through
 * `browser.cdp.hideAutomation` in `steptix.config.json` — see
 * `AUTOMATION_CONTROLLED_FLAG` and `LaunchOptions.hideAutomation`.
 *
 * All deps are injectable so tests can stub fs / spawn / fetch / sleep without
 * touching the real machine.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { probePort, type LaunchableEngine } from './cdp-discovery.js';
import { PRIVATE_DIR_MODE } from '../env/user-root.js';

export type { LaunchableEngine };

export interface InstalledBinaries {
  chrome: string | null;
  edge: string | null;
}

export interface LauncherDeps {
  /** Default: process.platform. Override for cross-platform tests. */
  platform?: NodeJS.Platform;
  /** Default: process.env. Tests inject %LOCALAPPDATA% etc. */
  env?: NodeJS.ProcessEnv;
  /** Default: fs.existsSync. */
  existsSync?: (p: string) => boolean;
  /** Default: fs.readFileSync (utf8). */
  readFileSync?: (p: string) => string;
  /** Default: which() helper (PATH lookup via child_process). */
  which?: (cmd: string) => string | null;
  /** Default: fs.mkdirSync. */
  mkdirSync?: (p: string, opts: { recursive: boolean; mode: number }) => void;
  /** Default: child_process.spawn. */
  spawn?: typeof import('node:child_process').spawn;
  /** Default: the real port probe. */
  probe?: typeof probePort;
  /** Default: setTimeout-based sleep. Tests inject a synchronous fast-forward. */
  sleep?: (ms: number) => Promise<void>;
  /** Default: LAUNCH_TIMEOUT_MS. Test-only knob to keep timeouts fast. */
  launchTimeoutMs?: number;
}

export interface LaunchOptions {
  engine: LaunchableEngine;
  /** Absolute path to the profile dir. Created if absent. */
  profileDir: string;
  /** Add `AUTOMATION_CONTROLLED_FLAG` to the launch. Off unless the config
   *  that governs this launch says otherwise (`browser.cdp.hideAutomation`). */
  hideAutomation?: boolean | undefined;
}

export type LaunchResult =
  | { ok: true; port: number; pid: number | undefined; binary: string }
  | { ok: false; error: string };

/** Total budget from spawn to "the port answers". W0 saw 473–1344 ms on a warm
 *  machine, so this has real headroom — but not enough to cut, and a cold
 *  first launch into a brand-new profile is the slow case. */
export const LAUNCH_TIMEOUT_MS = 5000;
/** Interval for the DevToolsActivePort poll. Deliberately tighter than the
 *  port poll: at 200 ms this alone would burn most of the ~300 ms gap it
 *  exists to detect. */
export const FILE_POLL_INTERVAL_MS = 50;
/** Interval for the /json/version poll once the port is known. */
export const PORT_POLL_INTERVAL_MS = 100;

/** Chromium writes the port it chose here, inside the user-data-dir. */
export const DEVTOOLS_PORT_FILE = 'DevToolsActivePort';

let cachedDetection: InstalledBinaries | null = null;

/** Clears the module-level cache. Tests call this between cases; production
 *  code never needs it since installed-binary paths don't change mid-session. */
export function clearDetectionCache(): void {
  cachedDetection = null;
}

export function detectInstalled(deps?: LauncherDeps): InstalledBinaries {
  const hasOverrides = deps !== undefined && Object.keys(deps).length > 0;
  if (!hasOverrides && cachedDetection) {
    return cachedDetection;
  }

  const platform = deps?.platform ?? process.platform;
  const env = deps?.env ?? process.env;
  const existsSync = deps?.existsSync ?? fs.existsSync;
  const which = deps?.which ?? defaultWhich;

  const result: InstalledBinaries = {
    chrome: resolveChrome(platform, env, existsSync, which),
    edge: resolveEdge(platform, env, existsSync, which),
  };

  if (!hasOverrides) cachedDetection = result;
  return result;
}

/** Every path `detectInstalled` looked at, for the §7 "engine not installed"
 *  message — an error that names the paths searched is actionable; one that
 *  says "Chrome not found" is not. */
export function searchedPaths(engine: LaunchableEngine, deps?: LauncherDeps): string[] {
  const platform = deps?.platform ?? process.platform;
  const env = deps?.env ?? process.env;
  if (platform === 'win32') {
    return windowsCandidates(engine, env);
  }
  if (platform === 'darwin') {
    return macCandidates(engine);
  }
  return linuxCommands(engine).map((cmd) => `${cmd} (on PATH)`);
}

function resolveChrome(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  existsSync: (p: string) => boolean,
  which: (cmd: string) => string | null,
): string | null {
  if (platform === 'win32') return firstExisting(windowsCandidates('chrome', env), existsSync);
  if (platform === 'darwin') return firstExisting(macCandidates('chrome'), existsSync);
  for (const cmd of linuxCommands('chrome')) {
    const found = which(cmd);
    if (found) return found;
  }
  return null;
}

function resolveEdge(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  existsSync: (p: string) => boolean,
  which: (cmd: string) => string | null,
): string | null {
  if (platform === 'win32') return firstExisting(windowsCandidates('edge', env), existsSync);
  if (platform === 'darwin') return firstExisting(macCandidates('edge'), existsSync);
  for (const cmd of linuxCommands('edge')) {
    const found = which(cmd);
    if (found) return found;
  }
  return null;
}

function windowsCandidates(engine: LaunchableEngine, env: NodeJS.ProcessEnv): string[] {
  // Resolution order is per-engine and inherited from the extension: Chrome is
  // most often per-user, Edge is system-wide.
  const tail =
    engine === 'chrome'
      ? 'Google\\Chrome\\Application\\chrome.exe'
      : 'Microsoft\\Edge\\Application\\msedge.exe';
  const bases =
    engine === 'chrome'
      ? [env['LOCALAPPDATA'], env['PROGRAMFILES'], env['PROGRAMFILES(X86)']]
      : [env['PROGRAMFILES(X86)'], env['PROGRAMFILES'], env['LOCALAPPDATA']];
  return bases.filter((b): b is string => Boolean(b)).map((b) => joinWindows(b, tail));
}

function macCandidates(engine: LaunchableEngine): string[] {
  return engine === 'chrome'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
}

function linuxCommands(engine: LaunchableEngine): string[] {
  return engine === 'chrome'
    ? ['google-chrome', 'google-chrome-stable', 'chromium']
    : ['microsoft-edge', 'microsoft-edge-stable'];
}

function firstExisting(candidates: string[], existsSync: (p: string) => boolean): string | null {
  return candidates.find((p) => existsSync(p)) ?? null;
}

function joinWindows(base: string, tail: string): string {
  return base.endsWith('\\') ? `${base}${tail}` : `${base}\\${tail}`;
}

function defaultWhich(cmd: string): string | null {
  try {
    const out = childProcess
      .spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' })
      .stdout?.toString()
      .trim();
    if (!out) return null;
    return out.split(/\r?\n/)[0] ?? null;
  } catch {
    return null;
  }
}

/** Human label for an engine, for error prose. */
export function engineLabel(engine: LaunchableEngine): string {
  return engine === 'chrome' ? 'Chrome' : 'Edge';
}

/**
 * Keeps `navigator.webdriver` at `false` in a remote-debuggable Chrome. See
 * the comment at the spawn site for why it exists and what it costs.
 */
export const AUTOMATION_CONTROLLED_FLAG = '--disable-blink-features=AutomationControlled';

/** The command a human can paste to do this by hand — the same flags the
 *  launch would use, so a hand-started browser is not a different browser. */
export function manualCommand(
  engine: LaunchableEngine,
  profileDir: string,
  opts?: { hideAutomation?: boolean | undefined },
): string {
  const cmd = engine === 'chrome' ? 'chrome' : 'msedge';
  const flag = opts?.hideAutomation === true ? ` ${AUTOMATION_CONTROLLED_FLAG}` : '';
  return `${cmd} --remote-debugging-port=0 --user-data-dir="${profileDir}"${flag}`;
}

/**
 * Read `DevToolsActivePort` from a profile dir.
 *
 * Returns null when absent, unreadable or malformed — never throws. The file
 * is a claim written by a process we do not control, so a caller must treat
 * "unreadable" and "stale" identically: neither proves a browser is there.
 * That is why liveness is a separate probe (§2).
 */
export function readDevToolsPort(profileDir: string, deps?: LauncherDeps): number | null {
  const readFileSync = deps?.readFileSync ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  try {
    const raw = readFileSync(path.join(profileDir, DEVTOOLS_PORT_FILE));
    const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? '';
    const port = Number(firstLine);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return port;
  } catch {
    return null;
  }
}

/**
 * Spawn `engine` against `profileDir` and return the port it chose.
 *
 * The caller is responsible for having established that nothing is already
 * running on this profile, and for deleting any stale `DevToolsActivePort`
 * first — see `cdp-registry.ts`. Both are branch-scoped decisions that need
 * the registry's view of the world, so they are deliberately not made here.
 */
export async function launchCdpBrowser(
  opts: LaunchOptions,
  deps?: LauncherDeps,
): Promise<LaunchResult> {
  const installed = detectInstalled(deps);
  const binary = installed[opts.engine];
  if (!binary) {
    const label = engineLabel(opts.engine);
    return {
      ok: false,
      error:
        `${label} is not installed, or is not where this framework looks for it.\n` +
        `Searched:\n${searchedPaths(opts.engine, deps).map((p) => `  ${p}`).join('\n')}\n\n` +
        `Install ${label}, or use the other engine. To check by hand:\n` +
        `  ${manualCommand(opts.engine, opts.profileDir, { hideAutomation: opts.hideAutomation })}`,
    };
  }

  const mkdirSync = deps?.mkdirSync ?? fs.mkdirSync;
  const spawn = deps?.spawn ?? childProcess.spawn;
  const probe = deps?.probe ?? probePort;
  const sleep = deps?.sleep ?? defaultSleep;
  const budget = deps?.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS;

  try {
    // Private: a profile holds signed-in sessions, and in project-less mode
    // this can be what creates the user root (src/env/user-root.ts).
    mkdirSync(opts.profileDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  } catch (err) {
    return {
      ok: false,
      error:
        `Cannot create the browser profile directory ${opts.profileDir}: ` +
        `${err instanceof Error ? err.message : String(err)}\n` +
        'Fix permissions on .steptix/cdp-profiles/ and retry.',
    };
  }

  let pid: number | undefined;
  try {
    // Array form is mandatory. String concat would be a command-injection
    // vector the moment `profileDir` contains a space or a quote, and it can:
    // the project root is user-chosen and the profile name reaches this path
    // from an MCP tool argument.
    //
    // `--user-data-dir` is not optional either — it is the official
    // Chrome 122+/Edge workaround for `--remote-debugging-port` being rejected
    // on the default profile, which is why attaching to someone's everyday
    // browser is impossible and this whole module exists.
    //
    // `--disable-blink-features=AutomationControlled` exists because
    // `--remote-debugging-port` on its own makes every page read
    // `navigator.webdriver === true` — measured on Chrome 151 with nothing
    // attached, where the same profile without the port flag reads `false`.
    // Some sites refuse a browser that says that, and a CDP browser exists to
    // be a real browser the user signs into by hand. It is opt-in
    // (`browser.cdp.hideAutomation`) rather than the default: whether a
    // browser should stop announcing itself is the user's call to make in
    // their config, not this module's — and it costs Chrome's yellow
    // "unsupported command-line flag" bar on launch, which they can dismiss.
    const child = spawn(
      binary,
      [
        '--remote-debugging-port=0',
        `--user-data-dir=${opts.profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        ...(opts.hideAutomation === true ? [AUTOMATION_CONTROLLED_FLAG] : []),
      ],
      { detached: true, stdio: 'ignore' },
    );
    pid = child.pid;
    child.unref?.();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const deadline = Date.now() + budget;

  // --- half 1: wait for the file, to learn the port --------------------------
  let port: number | null = null;
  while (Date.now() < deadline) {
    port = readDevToolsPort(opts.profileDir, deps);
    if (port !== null) break;
    await sleep(FILE_POLL_INTERVAL_MS);
  }
  if (port === null) {
    // Deliberately names the file rather than saying "the browser did not
    // start". The browser almost certainly did start; what failed is §3's
    // mechanism, and a caller told "browser did not start" will retry forever
    // while a caller told this can report something actionable.
    return {
      ok: false,
      error:
        `${engineLabel(opts.engine)} was spawned (pid ${pid ?? 'unknown'}) but never wrote ` +
        `${DEVTOOLS_PORT_FILE} into ${opts.profileDir} within ${budget}ms.\n` +
        'That file is how this framework learns which port the browser chose, so ' +
        'there is no way to reach the browser without it.\n' +
        'Retry. If it keeps happening, the port-file mechanism is not working on ' +
        'this machine or browser build — that is worth reporting rather than ' +
        'working around.',
    };
  }

  // --- half 2: wait for that port to actually answer -------------------------
  let lastError = 'no response';
  while (Date.now() < deadline) {
    const probed = await probe(port, Math.max(250, deadline - Date.now()));
    if (probed.reachable) {
      return { ok: true, port, pid, binary };
    }
    lastError = probed.error ?? 'not reachable';
    await sleep(PORT_POLL_INTERVAL_MS);
  }

  return {
    ok: false,
    error:
      `${engineLabel(opts.engine)} wrote ${DEVTOOLS_PORT_FILE} naming port ${port}, but that ` +
      `port did not answer within ${budget}ms (last error: ${lastError}).\n` +
      'Retry — the usual cause is a stale port file from a browser that crashed, ' +
      'and the next launch clears it.',
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Browser launcher — detects whether Chrome and Edge are installed and spawns
// either with `--remote-debugging-port`/`--user-data-dir` so that flick-vscode
// can attach via CDP. See spec at stories/flick-vscode-cdp-attach.md
// "Extension: Browser launcher" and "Locked decisions" row 4.
//
// Resolution order is per-OS and per-engine; the first matching path wins.
// All deps are injectable so tests can stub fs / spawn / fetch / sleep without
// hitting the real machine.

import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';

export type CdpLaunchEngine = 'chrome' | 'edge';

export interface InstalledBinaries {
  chrome: string | null;
  edge: string | null;
}

export interface LaunchResult {
  ok: boolean;
  pid?: number;
  /** Resolved binary path that was spawned (for logs / errors). */
  binary?: string;
  error?: string;
}

export interface LauncherDeps {
  /** Default: process.platform. Override for cross-platform tests. */
  platform?: NodeJS.Platform;
  /** Default: process.env. Tests inject %LOCALAPPDATA% etc. */
  env?: NodeJS.ProcessEnv;
  /** Default: fs.existsSync. Tests inject a fake. */
  existsSync?: (p: string) => boolean;
  /** Default: which() helper (PATH lookup via child_process). */
  which?: (cmd: string) => string | null;
  /** Default: fs.mkdirSync. */
  mkdirSync?: (p: string, opts: { recursive: boolean }) => void;
  /** Default: child_process.spawn. */
  spawn?: typeof import('node:child_process').spawn;
  /** Default: real fetch — used for the post-spawn /json/version poll. */
  fetchFn?: typeof fetch;
  /** Default: setTimeout-based sleep. Tests inject a synchronous fast-forward. */
  sleep?: (ms: number) => Promise<void>;
  /** Default: POLL_TIMEOUT_MS. Test-only knob to keep timeouts fast. */
  pollTimeoutMs?: number;
}

export interface LaunchOptions {
  engine: CdpLaunchEngine;
  port: number;
  profileDir: string;
}

/** Public total budget for the post-spawn readiness poll. */
export const POLL_TIMEOUT_MS = 5000;
/** Interval between /json/version polls. */
export const POLL_INTERVAL_MS = 200;

let cachedDetection: InstalledBinaries | null = null;

/** Clears the module-level cache. Tests call this between cases; production
 *  code never needs it since installed-binary paths don't change mid-session. */
export function clearDetectionCache(): void {
  cachedDetection = null;
}

/** What the module cache holds — tests only, to see that a call with injected
 *  deps never writes its fake answer where a real caller would read it. */
export function __testCachedDetection(): InstalledBinaries | null {
  return cachedDetection;
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

  const chrome = resolveChrome(platform, env, existsSync, which);
  const edge = resolveEdge(platform, env, existsSync, which);
  const result: InstalledBinaries = { chrome, edge };

  if (!hasOverrides) {
    cachedDetection = result;
  }
  return result;
}

function resolveChrome(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  existsSync: (p: string) => boolean,
  which: (cmd: string) => string | null,
): string | null {
  if (platform === 'win32') {
    const candidates: Array<[string | undefined, string]> = [
      [env['LOCALAPPDATA'], 'Google\\Chrome\\Application\\chrome.exe'],
      [env['PROGRAMFILES'], 'Google\\Chrome\\Application\\chrome.exe'],
      [env['PROGRAMFILES(X86)'], 'Google\\Chrome\\Application\\chrome.exe'],
    ];
    return firstExisting(candidates, existsSync);
  }
  if (platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    return null;
  }
  // Linux + everything else: PATH lookup.
  for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium']) {
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
  if (platform === 'win32') {
    const candidates: Array<[string | undefined, string]> = [
      [env['PROGRAMFILES(X86)'], 'Microsoft\\Edge\\Application\\msedge.exe'],
      [env['PROGRAMFILES'], 'Microsoft\\Edge\\Application\\msedge.exe'],
      [env['LOCALAPPDATA'], 'Microsoft\\Edge\\Application\\msedge.exe'],
    ];
    return firstExisting(candidates, existsSync);
  }
  if (platform === 'darwin') {
    const candidates = ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    return null;
  }
  for (const cmd of ['microsoft-edge', 'microsoft-edge-stable']) {
    const found = which(cmd);
    if (found) return found;
  }
  return null;
}

function firstExisting(
  candidates: Array<[string | undefined, string]>,
  existsSync: (p: string) => boolean,
): string | null {
  for (const [base, tail] of candidates) {
    if (!base) continue;
    const full = joinWindows(base, tail);
    if (existsSync(full)) return full;
  }
  return null;
}

function joinWindows(base: string, tail: string): string {
  return base.endsWith('\\') ? `${base}${tail}` : `${base}\\${tail}`;
}

function defaultWhich(cmd: string): string | null {
  try {
    const out = childProcess
      .spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
        encoding: 'utf8',
      })
      .stdout?.toString()
      .trim();
    if (!out) return null;
    return out.split(/\r?\n/)[0] ?? null;
  } catch {
    return null;
  }
}

export async function launchBrowserWithCdp(
  opts: LaunchOptions,
  deps?: LauncherDeps,
): Promise<LaunchResult> {
  const installed = detectInstalled(deps);
  const binary = installed[opts.engine];
  if (!binary) {
    const label = opts.engine === 'chrome' ? 'Chrome' : 'Edge';
    const cmd = opts.engine === 'chrome' ? 'chrome' : 'msedge';
    return {
      ok: false,
      error:
        `${label} not found. Install it, then re-open the dropdown.\n\n` +
        `Or launch it manually:\n` +
        `  ${cmd} --remote-debugging-port=${opts.port} --user-data-dir=${opts.profileDir}`,
    };
  }

  const mkdirSync = deps?.mkdirSync ?? fs.mkdirSync;
  const spawn = deps?.spawn ?? childProcess.spawn;
  const fetchFn = deps?.fetchFn ?? fetch;
  const sleep = deps?.sleep ?? defaultSleep;
  const pollTimeoutMs = deps?.pollTimeoutMs ?? POLL_TIMEOUT_MS;

  mkdirSync(opts.profileDir, { recursive: true });

  let pid: number | undefined;
  try {
    // `--user-data-dir` is the official Chrome 122+ / Edge workaround for
    // `--remote-debugging-port` being rejected on the default profile (see
    // Risks / open #1 in stories/flick-vscode-cdp-attach.md). Array form is
    // mandatory — string concat would be a command-injection vector if
    // profileDir ever contained spaces or quotes.
    const child = spawn(
      binary,
      [
        `--remote-debugging-port=${opts.port}`,
        `--user-data-dir=${opts.profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
      { detached: true, stdio: 'ignore' },
    );
    pid = child.pid;
    if (typeof child.unref === 'function') child.unref();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Poll /json/version until success or deadline.
  const deadline = Date.now() + pollTimeoutMs;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    try {
      const res = await fetchFn(`http://127.0.0.1:${opts.port}/json/version`);
      if (res.ok) {
        return { ok: true, pid, binary };
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  return {
    ok: false,
    error:
      `Browser launched (pid ${pid}) but did not start responding on port ` +
      `${opts.port} within 5s. It may need a moment — try the dropdown ⟳ ` +
      `button. (Last error: ${lastError})`,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

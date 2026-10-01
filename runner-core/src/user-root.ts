/**
 * The machine key and the machine `SERVER_URL`, read from the user root's
 * `.env` (stories/machine-key.md and stories/machine-server-url.md in the
 * Steptix repo).
 *
 * READ-ONLY on purpose. Generation belongs to the processes that *start* the
 * Sessions API server (`steptix serve`, the MCP server's auto-start) — a key
 * that Steptix invented would be one no running server holds, and every
 * request sent with it would 401. This module only answers "what key does
 * this machine have?", as the last step of the client chain:
 *
 *   project `.env` (walk-up)  →  process.env  →  the machine key
 *
 * A deliberate duplicate of `src/env/user-root.ts` in the framework repo:
 * runner-core is a separate bundle shipped inside the Steptix VSIXes, and
 * cannot import from the framework — the same reason `server-manager.ts`
 * ported auto-start rather than importing it.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseEnv } from './env-file.js';

export const MACHINE_KEY_VAR = 'STEPTIX_SERVER_API_KEY';

/** Injection seam for tests — the path derives entirely from these. */
export interface UserRootDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: () => string;
}

/** `%LOCALAPPDATA%\steptix\.env` / `$XDG_CONFIG_HOME/steptix/.env` / `~/.steptix/.env`. */
export function userRootEnvPath(deps?: UserRootDeps): string {
  const env = deps?.env ?? process.env;
  const platform = deps?.platform ?? process.platform;
  const homedir = deps?.homedir ?? os.homedir;

  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA'];
    const base =
      localAppData !== undefined && localAppData.trim() !== ''
        ? localAppData
        : path.join(homedir(), 'AppData', 'Local');
    return path.join(base, 'steptix', '.env');
  }

  const xdg = env['XDG_CONFIG_HOME'];
  if (xdg !== undefined && xdg.trim() !== '') return path.join(xdg, 'steptix', '.env');
  return path.join(homedir(), '.steptix', '.env');
}

/** The user root's `.env` parsed, `{}` when the file is absent. Anything but
 *  ENOENT (EACCES, EISDIR, an EBUSY lock) throws. */
function readUserRootEnv(deps?: UserRootDeps): Record<string, string> {
  let content: string;
  try {
    content = fs.readFileSync(userRootEnvPath(deps), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  return parseEnv(content);
}

/** `KEY` from the user root's `.env`, trimmed; null when absent or blank. */
function readUserRootValue(key: string, deps?: UserRootDeps): string | null {
  const value = readUserRootEnv(deps)[key];
  if (value === undefined || value.trim() === '') return null;
  return value.trim();
}

/**
 * The machine key, or null when the file is absent or has no usable value.
 * Trimmed-empty reads as absent — a blanked-out `STEPTIX_SERVER_API_KEY=` line
 * must not become the literal empty-string key every request fails to match.
 */
export function readMachineKey(deps?: UserRootDeps): string | null {
  return readUserRootValue(MACHINE_KEY_VAR, deps);
}

// ---------------------------------------------------------------------------
// The machine's server (stories/machine-server-url.md in the Steptix repo)
// ---------------------------------------------------------------------------
//
// Mirrors `src/env/server-url.ts` in the framework, for the same reason the
// key reader above mirrors `src/env/user-root.ts`. The two must agree: a bare
// `steptix serve` listens on the port this file's `SERVER_URL` names (else
// 3100), and a client with no project `SERVER_URL` connects to that URL (else
// the default) — which is why neither side has to tell the other.

export const DEFAULT_SERVER_PORT = 3100;

/** Loopback by address, so it names exactly what a default `serve` binds
 *  whichever address family `localhost` resolves to first. */
export const DEFAULT_SERVER_URL = `http://127.0.0.1:${DEFAULT_SERVER_PORT}`;

/** `SERVER_URL` from the user root's `.env`, or null when absent or blank. */
export function readMachineServerUrl(deps?: UserRootDeps): string | null {
  return readUserRootValue('SERVER_URL', deps);
}

/** Which server a client uses, and the file (or default) that said so. */
export interface ServerUrlChoice {
  serverUrl: string;
  /** For logs and error text: `SERVER_URL in <path>`, or `the default`. */
  source: string;
  /** The file it came from; null for the default. */
  path: string | null;
}

/**
 * A client's `SERVER_URL`: the project's, else the machine `.env`'s, else
 * {@link DEFAULT_SERVER_URL}. `projectEnvPath` names the file the project map
 * was read from, for `source`.
 *
 * Throws only when the machine `.env` exists and cannot be read — the caller
 * reports that against {@link userRootEnvPath}.
 */
export function chooseServerUrl(
  projectEnv: Readonly<Record<string, string>>,
  projectEnvPath: string | null,
  deps?: UserRootDeps,
): ServerUrlChoice {
  const fromProject = projectEnv['SERVER_URL']?.trim();
  if (fromProject) {
    return {
      serverUrl: fromProject,
      source: `SERVER_URL in ${projectEnvPath ?? "the project's .env"}`,
      path: projectEnvPath,
    };
  }
  const fromMachine = readMachineServerUrl(deps);
  if (fromMachine !== null) {
    const machinePath = userRootEnvPath(deps);
    return { serverUrl: fromMachine, source: `SERVER_URL in ${machinePath}`, path: machinePath };
  }
  return { serverUrl: DEFAULT_SERVER_URL, source: 'the default', path: null };
}

/** Where a `steptix serve` started without `-p` will listen, and why. */
export type BareServePort =
  | { ok: true; port: number; source: string }
  /** The machine `SERVER_URL` is set but names no usable port: that `serve`
   *  refuses to start, for this reason. */
  | { ok: false; reason: string };

/**
 * The port a bare `serve` takes: the machine `SERVER_URL`'s, else
 * {@link DEFAULT_SERVER_PORT}. The same rule as `resolveServePort` in the
 * framework minus `-p`, which only the caller can know about.
 */
export function bareServePort(deps?: UserRootDeps): BareServePort {
  const machineUrl = readMachineServerUrl(deps);
  if (machineUrl === null) return { ok: true, port: DEFAULT_SERVER_PORT, source: 'the default' };
  const where = `SERVER_URL in ${userRootEnvPath(deps)}`;
  let url: URL;
  try {
    url = new URL(machineUrl);
  } catch {
    return { ok: false, reason: `${where} is not a valid URL: "${machineUrl}"` };
  }
  const port = Number(url.port);
  if (url.port === '' || port === 0) {
    return { ok: false, reason: `${where} has no port: "${machineUrl}"` };
  }
  return { ok: true, port, source: where };
}

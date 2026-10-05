/**
 * The user root's `.env` (stories/machine-key.md in the Steptix repo): the
 * machine key, and the machine's `STEPTIX_SERVER_URL`.
 *
 * READ-ONLY on purpose. Generation belongs to the processes that *start* the
 * Sessions API server (`steptix serve`, the MCP server's auto-start) — a key
 * that Steptix invented would be one no running server holds, and every
 * request sent with it would 401. This module only answers "what does this
 * machine say?", as the last step of each client chain:
 *
 *   project `.env` (walk-up)  →  process.env  →  the user root's `.env`
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
export const MACHINE_SERVER_URL_VAR = 'STEPTIX_SERVER_URL';

/** Injection seam for tests — the path derives entirely from these. */
export interface UserRootDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: () => string;
}

/** `%LOCALAPPDATA%\steptix` / `$XDG_CONFIG_HOME/steptix` / `~/.steptix`. */
export function userRootDir(deps?: UserRootDeps): string {
  const env = deps?.env ?? process.env;
  const platform = deps?.platform ?? process.platform;
  const homedir = deps?.homedir ?? os.homedir;

  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA'];
    const base =
      localAppData !== undefined && localAppData.trim() !== ''
        ? localAppData
        : path.join(homedir(), 'AppData', 'Local');
    return path.join(base, 'steptix');
  }

  const xdg = env['XDG_CONFIG_HOME'];
  if (xdg !== undefined && xdg.trim() !== '') return path.join(xdg, 'steptix');
  return path.join(homedir(), '.steptix');
}

/** `%LOCALAPPDATA%\steptix\.env` / `$XDG_CONFIG_HOME/steptix/.env` / `~/.steptix/.env`. */
export function userRootEnvPath(deps?: UserRootDeps): string {
  return path.join(userRootDir(deps), '.env');
}

/**
 * One value from the user root's `.env`, or null when the file is absent or
 * has no usable value. Trimmed-empty reads as absent — a blanked-out line must
 * not become the literal empty string.
 *
 * Throws on any read error but "no such file" (EACCES, EISDIR, an EBUSY lock)
 * and on a malformed line: the value may well be in there, and "absent" would
 * send the caller down the wrong branch.
 */
function readUserRootValue(key: string, deps?: UserRootDeps): string | null {
  let content: string;
  try {
    content = fs.readFileSync(userRootEnvPath(deps), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const value = parseEnv(content)[key];
  if (value === undefined || value.trim() === '') return null;
  return value.trim();
}

/** The machine key, or null when there is none. */
export function readMachineKey(deps?: UserRootDeps): string | null {
  return readUserRootValue(MACHINE_KEY_VAR, deps);
}

/**
 * The machine's `STEPTIX_SERVER_URL`, or null when there is none — the server every
 * project on this machine talks to unless its own `.env` names another.
 */
export function readMachineServerUrl(deps?: UserRootDeps): string | null {
  return readUserRootValue(MACHINE_SERVER_URL_VAR, deps);
}

/**
 * True when the user root's `.env` exists and other local users can read it
 * (any group or other permission bit). Always false on Windows, where
 * `%LOCALAPPDATA%` is private to the account and Node reports no such bits.
 *
 * The framework creates the file `0600`; this catches one made by hand to add
 * `AI_API_KEY`, so Steptix can say `chmod 600` instead of leaving the keys
 * readable (stories/machine-server-url.md). Never throws.
 */
export function userRootEnvExposed(deps?: UserRootDeps): boolean {
  if ((deps?.platform ?? process.platform) === 'win32') return false;
  try {
    return (fs.statSync(userRootEnvPath(deps)).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Where a bare `steptix serve` listens (stories/machine-server-url.md)
// ---------------------------------------------------------------------------
//
// Mirrors `resolveServePort` in the framework's `src/env/server-url.ts`, for
// the same reason the readers above mirror `src/env/user-root.ts`. The two
// must agree: a bare `serve` listens on the port of this file's
// `STEPTIX_SERVER_URL` (else 3100), and a client with no project
// `STEPTIX_SERVER_URL` connects to that URL (else the default) — which is why
// neither side has to tell the other.

export const DEFAULT_SERVER_PORT = 3100;

/** Where a `steptix serve` started without `-p` will listen, and why. */
export type BareServePort =
  | { ok: true; port: number; source: string }
  /** The machine `STEPTIX_SERVER_URL` is set but names no usable port: that
   *  `serve` refuses to start, for this reason. */
  | { ok: false; reason: string };

/**
 * The port a bare `serve` takes: the machine `STEPTIX_SERVER_URL`'s, else
 * {@link DEFAULT_SERVER_PORT}. The same rule as `resolveServePort` in the
 * framework minus `-p`, which only the caller can know about.
 *
 * Throws what {@link readMachineServerUrl} throws: an unreadable machine `.env`.
 */
export function bareServePort(deps?: UserRootDeps): BareServePort {
  const machineUrl = readMachineServerUrl(deps);
  if (machineUrl === null) return { ok: true, port: DEFAULT_SERVER_PORT, source: 'the default' };
  const where = `${MACHINE_SERVER_URL_VAR} in ${userRootEnvPath(deps)}`;
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

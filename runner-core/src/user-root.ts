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

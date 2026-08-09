/**
 * The machine key, read from the user root's `.env` (stories/machine-key.md
 * in the ai-ui-automation repo).
 *
 * READ-ONLY on purpose. Generation belongs to the processes that *start* the
 * Sessions API server (`aiui serve`, the MCP server's auto-start) — a key
 * that TestBench invented would be one no running server holds, and every
 * request sent with it would 401. This module only answers "what key does
 * this machine have?", as the last step of the client chain:
 *
 *   project `.env` (walk-up)  →  process.env  →  the machine key
 *
 * A deliberate duplicate of `src/env/user-root.ts` in the framework repo:
 * runner-core is a separate bundle shipped inside the TestBench VSIXes, and
 * cannot import from the framework — the same reason `server-manager.ts`
 * ported auto-start rather than importing it.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseEnv } from './env-file.js';

export const MACHINE_KEY_VAR = 'AIUI_SERVER_API_KEY';

/** Injection seam for tests — the path derives entirely from these. */
export interface UserRootDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: () => string;
}

/** `%LOCALAPPDATA%\aiui\.env` / `$XDG_CONFIG_HOME/aiui/.env` / `~/.aiui/.env`. */
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
    return path.join(base, 'aiui', '.env');
  }

  const xdg = env['XDG_CONFIG_HOME'];
  if (xdg !== undefined && xdg.trim() !== '') return path.join(xdg, 'aiui', '.env');
  return path.join(homedir(), '.aiui', '.env');
}

/**
 * The machine key, or null when the file is absent or has no usable value.
 * Trimmed-empty reads as absent — a blanked-out `AIUI_SERVER_API_KEY=` line
 * must not become the literal empty-string key every request fails to match.
 */
export function readMachineKey(deps?: UserRootDeps): string | null {
  let content: string;
  try {
    content = fs.readFileSync(userRootEnvPath(deps), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const value = parseEnv(content)[MACHINE_KEY_VAR];
  if (value === undefined || value.trim() === '') return null;
  return value.trim();
}

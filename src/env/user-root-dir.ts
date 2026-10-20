/**
 * Where the user root is — the per-user Steptix folder that holds the machine
 * key, `runtimes/` and the launcher's records (docs/specs/SPEC-install.md §3.3).
 *
 * Its own module, importing only Node built-ins, because the launcher
 * (src/launcher/) runs before every `steptix` command, `steptix mcp`
 * included, and must not load the logger or anything else that could print.
 * `src/env/user-root.ts` re-exports it.
 */

import os from 'node:os';
import path from 'node:path';

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

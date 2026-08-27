/**
 * The user root's `.env` — the machine-level home of `AIUI_SERVER_API_KEY`
 * (stories/machine-key.md).
 *
 * The key is a shared secret between local processes, not user
 * authentication, and nothing issues it: auto-start hands it to the server it
 * spawns through the environment, so the two sides agree because one gave the
 * string to the other. That is what makes a generated random string exactly
 * as good as a typed one — and why this module may *create* the key when
 * nobody has one.
 *
 * Location: `%LOCALAPPDATA%\aiui\.env` on Windows, `$XDG_CONFIG_HOME/aiui/`
 * or `~/.aiui/` elsewhere. One path per machine on purpose — a framework
 * *checkout* is not unique (worktrees each carry a copied `.env`, an npm
 * install has no checkout at all), so the checkout can never be the key's
 * address.
 *
 * Everything here is synchronous: `withServerDiscovery` (src/mcp/project.ts)
 * is a sync function and sits on the read path.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnvFile } from './loader.js';

export const MACHINE_KEY_VAR = 'AIUI_SERVER_API_KEY';

/** Injection seam for tests — the path derives entirely from these. */
export interface UserRootDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: () => string;
}

/** `%LOCALAPPDATA%\aiui` / `$XDG_CONFIG_HOME/aiui` / `~/.aiui`. */
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
    return path.join(base, 'aiui');
  }

  const xdg = env['XDG_CONFIG_HOME'];
  if (xdg !== undefined && xdg.trim() !== '') return path.join(xdg, 'aiui');
  return path.join(homedir(), '.aiui');
}

export function userRootEnvPath(deps?: UserRootDeps): string {
  return path.join(userRootDir(deps), '.env');
}

/**
 * Parsed contents of the user root's `.env`, `{}` when absent.
 *
 * Absent and empty read the same on purpose: both mean "no machine values",
 * and every caller sits at the *bottom* of a resolution chain where the only
 * question is whether a value exists.
 */
export function readUserRootEnv(deps?: UserRootDeps): Record<string, string> {
  let content: string;
  try {
    content = fs.readFileSync(userRootEnvPath(deps), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  return parseEnvFile(content);
}

/**
 * The machine key from the user root's `.env`, or null when there is none.
 * Trimmed-empty reads as absent — an `AIUI_SERVER_API_KEY=` line someone
 * blanked out must not become the literal empty-string key that every
 * request then fails to match.
 */
export function readMachineKey(deps?: UserRootDeps): string | null {
  const value = readUserRootEnv(deps)[MACHINE_KEY_VAR];
  if (value === undefined || value.trim() === '') return null;
  return value.trim();
}

/**
 * The machine key, generated and persisted if there is none.
 *
 * The write is **create-or-append, never rewrite**: an existing file may
 * carry values the user added by hand (`AI_API_KEY`, `AI_MODEL`,
 * `AI_GATEWAY_URL` — machine defaults are typed into this same file, and
 * `withMachineAiFloor` reads them back), and an existing key is never
 * replaced — replacing it would orphan every client holding the old value.
 * Appending a line the file lacks clobbers neither.
 *
 * Callers decide *whether* generation is allowed — stories/machine-key.md
 * permits it only where we are the process that starts the server (`serve`
 * on a bare start, the MCP server before an arm-4 spawn). This function only
 * knows how.
 */
export function ensureMachineKey(deps?: UserRootDeps): {
  key: string;
  created: boolean;
  path: string;
} {
  const envPath = userRootEnvPath(deps);

  const existing = readMachineKey(deps);
  if (existing !== null) return { key: existing, created: false, path: envPath };

  // 32 bytes of entropy; the prefix marks provenance in logs and .env files
  // without any parser anywhere caring about the shape.
  const key = `aiui_${crypto.randomBytes(32).toString('hex')}`;

  fs.mkdirSync(path.dirname(envPath), { recursive: true });

  const line =
    `# Machine key for the ai-ui-automation Sessions API server.\n` +
    `# Generated ${new Date().toISOString()} — see stories/machine-key.md.\n` +
    `${MACHINE_KEY_VAR}=${key}\n`;

  if (fs.existsSync(envPath)) {
    // The file exists but has no (usable) key: append, preserving whatever
    // the user put there. Guard the joining newline rather than assuming one.
    const content = fs.readFileSync(envPath, 'utf-8');
    const joiner = content === '' || content.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(envPath, `${joiner}${line}`);
  } else {
    fs.writeFileSync(envPath, line);
  }

  return { key, created: true, path: envPath };
}

import chalk from 'chalk';
import { loadConfig } from '../config/loader.js';
import { DEFAULT_SERVER_PORT, readMachineServerUrl } from '../env/server-url.js';
import { userRootEnvPath } from '../env/user-root.js';
import { normalizeBaseUrl } from '../server/health.js';

export interface ServerTargetOptions {
  config?: string;
  url?: string;
}

/**
 * Resolve which server `status` / `stop` are talking about, in the order
 * `serve` picks its port (stories/machine-server-url.md): `--url` if given,
 * else the user root's `STEPTIX_SERVER_URL`, else the default port on the loaded
 * config's `server.host`.
 *
 * A server started with an explicit `-p` is not found this way — `steptix
 * serve -p 4000` needs `steptix status --url http://127.0.0.1:4000`, exactly as
 * `-p` overrides the other two when serving. Lives here rather than in either
 * command so the two can never disagree about the target, and so a third
 * caller doesn't have to import from a sibling command module.
 *
 * Null, with the reason already printed, when the user root's `.env` exists
 * but cannot be read: the URL may well be in there, so falling through to the
 * default would be a guess about which server to report on or stop.
 */
export async function resolveServerUrl(opts: ServerTargetOptions): Promise<string | null> {
  if (opts.url) return normalizeBaseUrl(opts.url);
  let machineUrl: string | null;
  try {
    machineUrl = readMachineServerUrl();
  } catch (err) {
    console.error(
      chalk.red(`Could not read ${userRootEnvPath()}`) +
        ` (${err instanceof Error ? err.message : String(err)}), which may name the server. ` +
        'Fix the file, or name the server with --url.',
    );
    return null;
  }
  if (machineUrl !== null) return normalizeBaseUrl(machineUrl);
  const config = await loadConfig(opts.config);
  return `http://${config.server.host}:${DEFAULT_SERVER_PORT}`;
}

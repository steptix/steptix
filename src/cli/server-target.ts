import { loadConfig } from '../config/loader.js';
import { DEFAULT_SERVER_PORT, readMachineServerUrl } from '../env/server-url.js';
import { normalizeBaseUrl } from '../server/health.js';

export interface ServerTargetOptions {
  config?: string;
  url?: string;
}

/**
 * Resolve which server `status` / `stop` are talking about, in the order
 * `serve` picks its port (stories/machine-server-url.md): `--url` if given,
 * else the user root's `SERVER_URL`, else the default port on the loaded
 * config's `server.host`.
 *
 * A server started with an explicit `-p` is not found this way — `steptix
 * serve -p 4000` needs `steptix status --url http://127.0.0.1:4000`, exactly as
 * `-p` overrides the other two when serving. Lives here rather than in either
 * command so the two can never disagree about the target, and so a third
 * caller doesn't have to import from a sibling command module.
 */
export async function resolveServerUrl(opts: ServerTargetOptions): Promise<string> {
  if (opts.url) return normalizeBaseUrl(opts.url);
  const machineUrl = readMachineServerUrl();
  if (machineUrl !== null) return normalizeBaseUrl(machineUrl);
  const config = await loadConfig(opts.config);
  return `http://${config.server.host}:${DEFAULT_SERVER_PORT}`;
}

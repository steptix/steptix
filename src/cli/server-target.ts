import { loadConfig } from '../config/loader.js';
import { normalizeBaseUrl } from '../server/health.js';

export interface ServerTargetOptions {
  config?: string;
  url?: string;
}

/**
 * Resolve which server `status` / `stop` are talking about: `--url` if given,
 * else the loaded config's `server.host`/`server.port` — the same config
 * fields `serve` binds to (story server-lifecycle §4).
 *
 * Note this deliberately does not know about `serve`'s `--port`/`--host`
 * overrides: a server started with `steptix serve --port 4000` needs
 * `steptix status --url http://127.0.0.1:4000`. Lives here rather than in either
 * command so the two can never disagree about the target, and so a third
 * caller doesn't have to import from a sibling command module.
 */
export async function resolveServerUrl(opts: ServerTargetOptions): Promise<string> {
  if (opts.url) return normalizeBaseUrl(opts.url);
  const config = await loadConfig(opts.config);
  return `http://${config.server.host}:${config.server.port}`;
}

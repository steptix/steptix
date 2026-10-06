import chalk from 'chalk';
import type { Command } from 'commander';
import { probeHealth } from '../../server/health.js';
import { describeVersion } from '../../utils/version.js';
import { resolveServerUrl, type ServerTargetOptions } from '../server-target.js';

export interface StatusOptions extends ServerTargetOptions {
  json?: boolean;
}

/** How long to wait for `/health`. A local server answers in single-digit ms;
 *  anything slower is indistinguishable from down for a status check. */
const PROBE_TIMEOUT_MS = 2_000;

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Report whether the Sessions API server is running')
    .option('-c, --config <path>', 'Path to config file (default: auto-discover steptix.config.json)')
    .option('--url <url>', 'Server base URL (default: STEPTIX_SERVER_URL in the machine .env, else port 3100)')
    .option('--json', 'Emit the raw /health body as JSON', false)
    .action(async (opts: StatusOptions) => {
      process.exit(await statusCommand(opts));
    });
}

/**
 * Returns the process exit code rather than calling `process.exit` itself, so
 * the exit-code contract (0 running / 1 down / 2 unrecognized) is testable
 * without spawning a CLI.
 */
export async function statusCommand(opts: StatusOptions): Promise<number> {
  const baseUrl = await resolveServerUrl(opts);
  if (baseUrl === null) return 1;
  const result = await probeHealth(baseUrl, PROBE_TIMEOUT_MS);

  if (result.kind !== 'ok') {
    // Both failure arms share one envelope, with `unrecognized` telling
    // "nothing there" from "something there that isn't us". The success
    // payload is the raw health body (§4), so scripts key off the exit code
    // — 0/1/2 — not off a field common to all three.
    const unrecognized = result.kind === 'unrecognized';
    if (opts.json) {
      console.log(
        JSON.stringify({ running: false, unrecognized, url: baseUrl, detail: result.detail }, null, 2),
      );
    } else if (unrecognized) {
      // Reachable but not recognizably ours. Could genuinely be a foreign
      // process on the port, or a Steptix server predating /health — the probe
      // cannot tell, and the message must not claim it can.
      console.log(
        `${chalk.yellow('unrecognized')} — ${baseUrl} answered (${result.detail}) but is not a ` +
          'Steptix server: the port is occupied by another process (or an older ' +
          'Steptix server without /health)',
      );
    } else {
      console.log(`${chalk.red('not running')} — nothing listening on ${baseUrl}`);
    }
    return unrecognized ? 2 : 1;
  }

  const h = result.health;
  if (opts.json) {
    console.log(JSON.stringify(h, null, 2));
    return 0;
  }

  // `??` throughout, not just for the documented-nullable fields: the probe
  // only verifies `service` + `ok`, so a Steptix build whose /health predates a
  // field must degrade to "unknown" rather than printing `undefined` (or,
  // worse, `undefinedm`).
  const unknown = chalk.dim('unknown');
  console.log(`${chalk.green('running')} — ${baseUrl}`);
  console.log(`  version          ${h.version == null ? unknown : describeVersion(h)}`);
  console.log(`  pid              ${h.pid ?? unknown}`);
  console.log(`  uptime           ${formatUptime(Date.now() - Date.parse(h.startedAt))}`);
  console.log(`  open sessions    ${h.openSessions ?? unknown}`);
  console.log(`  runs in flight   ${h.runsInFlight ?? unknown}`);
  console.log(`  inspector        ${h.inspector ?? chalk.dim('none')}`);
  console.log(
    `  idle timeout     ${h.idleTimeoutMinutes == null ? chalk.dim('off') : `${h.idleTimeoutMinutes}m`}`,
  );
  return 0;
}

/** `2h 5m` / `5m 3s` / `12s`. NaN-safe — a malformed `startedAt` prints
 *  `unknown` rather than `NaNs`. */
export function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

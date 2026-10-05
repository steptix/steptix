import path from 'node:path';
import chalk from 'chalk';
import type { Command } from 'commander';
import { readMachineKey, userRootEnvPath } from '../../env/user-root.js';
import { probeHealth } from '../../server/health.js';
import { resolveServerUrl, type ServerTargetOptions } from '../server-target.js';

export interface StopOptions extends ServerTargetOptions {
  force?: boolean;
  /** Confirm-poll budget; injectable so tests don't burn the real one. */
  confirmTimeoutMs?: number;
  confirmPollMs?: number;
}

/** Timeout for the identity probe that runs before the key is sent. */
const PROBE_TIMEOUT_MS = 2_000;
/** Timeout for the shutdown POST itself. */
const REQUEST_TIMEOUT_MS = 5_000;
/** How long to wait for the process to actually disappear after a 200. */
const CONFIRM_TIMEOUT_MS = 6_000;
const CONFIRM_POLL_MS = 200;
/** Per-probe timeout inside the confirm loop — short, since a server that is
 *  still up answers /health immediately. */
const CONFIRM_PROBE_TIMEOUT_MS = 1_000;

export function registerStopCommand(program: Command): void {
  program
    .command('stop')
    .description('Stop a running Sessions API server (closing any open sessions)')
    .option('-c, --config <path>', 'Path to config file (default: auto-discover steptix.config.json)')
    .option('--url <url>', 'Server base URL (default: STEPTIX_SERVER_URL in the machine .env, else port 3100)')
    .option('--force', 'Stop even while a run is executing', false)
    .action(async (opts: StopOptions) => {
      process.exit(await stopCommand(opts));
    });
}

/**
 * Returns the exit code (0 accepted, 1 otherwise) instead of exiting, so the
 * refusal/auth paths are testable against a stub server.
 */
export async function stopCommand(opts: StopOptions): Promise<number> {
  // Same chain as every client (stories/machine-key.md): the environment,
  // then the machine key — which is what lets a bare shell stop a server
  // `serve` started bare. Never generated here: a key that no server holds
  // stops nothing.
  const envKey = process.env['STEPTIX_SERVER_API_KEY'];
  const apiKey = envKey ?? readMachineKey() ?? undefined;
  /** Where the key came from, for the 401 message — naming the actual source
   *  is what makes a mismatch diagnosable instead of a hunt. The CLI entry
   *  folds `./.env` into process.env at startup, so a defined env var may
   *  really be the working directory's project key; name both candidates. */
  const keySource =
    envKey !== undefined
      ? `the environment (the shell, or ${path.join(process.cwd(), '.env')})`
      : `the machine key at ${userRootEnvPath()}`;
  if (!apiKey) {
    console.error(
      chalk.red('No STEPTIX_SERVER_API_KEY available') +
        ` — none in the environment, and ${userRootEnvPath()} has none. ` +
        'The stop request cannot authenticate without the key the server was started with.',
    );
    return 1;
  }

  const baseUrl = await resolveServerUrl(opts);

  // §1: clients MUST check `service` before treating a port as ours. Without
  // this, a foreign process squatting the configured port is handed
  // STEPTIX_SERVER_API_KEY in a request it could never honour anyway. A pre-/health
  // steptix server also lands here — it has no /admin/shutdown either, so
  // refusing with a clear message beats posting a key at a 404.
  const probe = await probeHealth(baseUrl, PROBE_TIMEOUT_MS);
  if (probe.kind === 'down') {
    console.log(
      `${chalk.yellow('not running')} — nothing listening on ${baseUrl} ` +
        chalk.dim(`(${probe.detail})`),
    );
    return 1;
  }
  if (probe.kind === 'unrecognized') {
    console.error(
      chalk.yellow(`Refusing to send the API key: ${baseUrl} answered (${probe.detail}) but is not a `) +
        'Steptix server — the port is occupied by another process (or an older ' +
        'Steptix server without /health, which has no shutdown endpoint either).',
    );
    return 1;
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/admin/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ force: opts.force === true }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    console.log(
      `${chalk.yellow('not running')} — nothing listening on ${baseUrl} ` +
        chalk.dim(`(${err instanceof Error ? err.message : String(err)})`),
    );
    return 1;
  }

  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      runsInFlight?: number;
      openSessions?: number;
    };
    console.error(
      chalk.yellow(`Refused: ${body.runsInFlight ?? '?'} run(s) executing`) +
        ` (${body.openSessions ?? '?'} session(s) open).`,
    );
    console.error(
      chalk.dim(
        'Open Steptix extension sessions alone never block a stop — they are closed as part of it. ' +
          'Only a run that is actually executing does.',
      ),
    );
    console.error(`Re-run with ${chalk.bold('--force')} to stop anyway (the running test will fail).`);
    return 1;
  }

  if (res.status === 401) {
    // The likeliest cause: the server was launched with an explicit
    // --env-file or exported key that never reached the machine key file.
    // Name the source actually consulted so the fix is obvious, not a hunt.
    console.error(chalk.red('Unauthorized (401) — the API key sent does not match the server\'s.'));
    console.error(
      chalk.dim(
        `  this CLI sent STEPTIX_SERVER_API_KEY from ${keySource}\n` +
          `  the server at ${baseUrl} holds whatever key it was started with (an explicit --env-file, say)\n` +
          '  export that key in this shell, or restart the server bare so it uses the machine key.',
      ),
    );
    return 1;
  }

  const alreadyStopping = res.status === 503;
  if (!res.ok && !alreadyStopping) {
    const detail = await res.text().catch(() => '');
    console.error(chalk.red(`Stop failed: HTTP ${res.status}`) + (detail ? ` — ${detail.slice(0, 500)}` : ''));
    return 1;
  }

  // 503 means the shutdown gate is already up — an idle expiry, or another
  // `steptix stop`, got there first. The server is doing exactly what was asked,
  // so this is a success — but it still has to be *confirmed*, or a wrapper
  // doing `steptix stop && start-server` races the teardown into EADDRINUSE.
  console.log(
    alreadyStopping
      ? `${baseUrl} is already shutting down — waiting for it to exit...`
      : `Stop accepted by ${baseUrl} — waiting for it to exit...`,
  );

  // The server answers 200 and *then* tears down, so a bare 200 doesn't prove
  // it's gone. Poll /health until it stops answering. Probe first, then sleep,
  // so an already-gone server costs no extra wait.
  const deadline = Date.now() + (opts.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS);
  do {
    const probe = await probeHealth(baseUrl, CONFIRM_PROBE_TIMEOUT_MS);
    if (probe.kind === 'down') {
      console.log(chalk.green('Server stopped.'));
      return 0;
    }
    await new Promise((r) => setTimeout(r, opts.confirmPollMs ?? CONFIRM_POLL_MS));
  } while (Date.now() < deadline);

  // Teardown has a 10s hard-exit backstop, so this is "slower than we waited",
  // not "failed" — say exactly that rather than implying an error.
  console.log(
    chalk.yellow('Stop accepted, but the server is still answering — it may still be shutting down.'),
  );
  console.log(chalk.dim(`Re-check with ${chalk.bold('steptix status')}.`));
  return 0;
}

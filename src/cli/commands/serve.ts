import chalk from 'chalk';
import type { Command } from 'commander';
import { loadConfig } from '../../config/loader.js';
import { DEFAULT_CONFIG } from '../../config/defaults.js';
import { ensureMachineKey, readMachineKey } from '../../env/user-root.js';
import { nonNegativeInt } from '../parse-args.js';
import { startServer } from '../../server/api-server.js';
import { setLogLevel, type ConsoleLogLevel } from '../../utils/logger.js';
import type { LoggingConfig } from '../../config/types.js';

const VALID_LEVELS: readonly ConsoleLogLevel[] = ['silent', 'error', 'warn', 'info', 'debug'];
const VALID_FILES: readonly LoggingConfig['serverFileLogLevel'][] = ['off', 'compact', 'full'];


export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Start the Sessions API server')
    .option('-c, --config <path>', 'Path to config file (default: auto-discover aiui.config.json)')
    .option('-p, --port <number>', 'Port to listen on', parseInt)
    .option('-H, --host <host>', 'Host to bind to')
    .option(
      '--console-log-level <level>',
      `Console + SSE threshold: ${VALID_LEVELS.join('|')}. Overrides config.logging.consoleLogLevel`,
    )
    .option(
      '--server-file-log-level <mode>',
      `Per-run server log file: ${VALID_FILES.join('|')}. Overrides config.logging.serverFileLogLevel`,
    )
    .option(
      '--idle-timeout <minutes>',
      'Shut down after N minutes with no run in flight and no authenticated API request ' +
        '(open sessions are closed on the way out). Omit or 0 to run forever. ' +
        'Overrides config.server.idleTimeoutMinutes',
      nonNegativeInt,
    )
    .action(async (opts) => {
      const config = await loadConfig(opts.config);

      // The key chain (stories/machine-key.md): process.env (incl. --env-file,
      // which lands there before this code runs) → the config file → the user
      // root's .env → generate. The loader already applied the first two; what
      // is left here is the machine floor and, below it, self-provisioning.
      //
      // `dev-api-key` is DEFAULT_CONFIG's placeholder, not a source: the old
      // hard-exit guard existed precisely so it could never become the
      // operative key, and generation now serves the same purpose without
      // refusing. (Its message was also wrong — it said "add it to your .env
      // file", a file this command never reads.)
      if (config.server.apiKey === DEFAULT_CONFIG.server.apiKey) {
        const fromUserRoot = readMachineKey();
        if (fromUserRoot !== null) {
          config.server.apiKey = fromUserRoot;
        } else {
          // Bare `serve` binds the port itself, so generating here can never
          // disagree with an already-running server the way the MCP side
          // could — see stories/machine-key.md.
          const generated = ensureMachineKey();
          config.server.apiKey = generated.key;
          console.log(
            chalk.green('Generated a machine key') +
              ` and wrote it to ${generated.path} — every local client reads it from there.`,
          );
        }
      }
      if (opts.port !== undefined) config.server.port = opts.port;
      if (opts.host !== undefined) config.server.host = opts.host;
      if (opts.idleTimeout !== undefined) config.server.idleTimeoutMinutes = opts.idleTimeout;

      if (opts.consoleLogLevel !== undefined) {
        if (!VALID_LEVELS.includes(opts.consoleLogLevel)) {
          console.error(chalk.red(`Invalid --console-log-level "${opts.consoleLogLevel}". Use one of: ${VALID_LEVELS.join(', ')}`));
          process.exit(1);
        }
        config.logging.consoleLogLevel = opts.consoleLogLevel;
      }
      if (opts.serverFileLogLevel !== undefined) {
        if (!VALID_FILES.includes(opts.serverFileLogLevel)) {
          console.error(chalk.red(`Invalid --server-file-log-level "${opts.serverFileLogLevel}". Use one of: ${VALID_FILES.join(', ')}`));
          process.exit(1);
        }
        config.logging.serverFileLogLevel = opts.serverFileLogLevel;
      }

      // Apply the configured threshold to the logger before any session runs.
      setLogLevel(config.logging.consoleLogLevel);

      await startServer(config);
    });
}

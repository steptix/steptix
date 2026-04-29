import chalk from 'chalk';
import type { Command } from 'commander';
import { loadConfig } from '../../config/loader.js';
import { startServer } from '../../server/api-server.js';
import { setLogLevel, type ConsoleLogLevel } from '../../utils/logger.js';
import type { LoggingConfig } from '../../config/types.js';

const VALID_LEVELS: readonly ConsoleLogLevel[] = ['silent', 'error', 'warn', 'info', 'debug'];
const VALID_FILES: readonly LoggingConfig['serverFileLogLevel'][] = ['off', 'compact', 'full'];

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Start the Sessions API server')
    .option('-c, --config <path>', 'Path to config file', 'ai-ui-auto.config.ts')
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
    .action(async (opts) => {
      if (!process.env['SERVER_API_KEY']) {
        console.error(chalk.red('SERVER_API_KEY is not set — add it to your .env file'));
        process.exit(1);
      }
      const config = await loadConfig(opts.config);
      if (opts.port !== undefined) config.server.port = opts.port;
      if (opts.host !== undefined) config.server.host = opts.host;

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

import chalk from 'chalk';
import type { Command } from 'commander';
import { loadConfig } from '../../config/loader.js';
import { startServer } from '../../server/api-server.js';

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Start the Sessions API server')
    .option('-c, --config <path>', 'Path to config file', 'ai-ui-auto.config.ts')
    .option('-p, --port <number>', 'Port to listen on', parseInt)
    .option('-H, --host <host>', 'Host to bind to')
    .action(async (opts) => {
      if (!process.env['SERVER_API_KEY']) {
        console.error(chalk.red('SERVER_API_KEY is not set — add it to your .env file'));
        process.exit(1);
      }
      const config = await loadConfig(opts.config);
      if (opts.port !== undefined) config.server.port = opts.port;
      if (opts.host !== undefined) config.server.host = opts.host;
      await startServer(config);
    });
}

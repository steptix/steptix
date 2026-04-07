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
      const config = await loadConfig(opts.config);
      if (opts.port !== undefined) config.server.port = opts.port;
      if (opts.host !== undefined) config.server.host = opts.host;
      await startServer(config);
    });
}

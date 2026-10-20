import { loadDefaultEnvFileSync, warnIfDeprecatedDataDirEnv } from '../env/loader.js';
loadDefaultEnvFileSync();
warnIfDeprecatedDataDirEnv();

import { Command } from 'commander';
import { registerRunCommand } from './commands/run.js';
import { registerServerCommand, registerUninstallCommand, versionDetails } from './commands/server.js';
import { registerCompileCommand } from './commands/compile.js';
import { registerInitCommand } from './commands/init.js';
import { registerListCommand } from './commands/list.js';
import { registerSpecsCommand } from './commands/specs.js';
import { registerUiCommand } from './commands/ui.js';
import { registerServeCommand } from './commands/serve.js';
import { registerStatusCommand } from './commands/status.js';
import { registerStopCommand } from './commands/stop.js';
import { registerStatsCommand } from './commands/stats.js';

export function createCli(): Command {
  const program = new Command();

  program
    .name('steptix')
    .description('AI-powered UI test automation using natural language Markdown test files')
    // Worked out only when asked for: it reads the installed runtimes. Exits
    // straight away, as commander's own .version() does.
    .option('-V, --version', 'output the version, and the server it runs')
    .on('option:version', () => {
      process.stdout.write(versionDetails());
      process.exit(0);
    });

  registerRunCommand(program);
  registerCompileCommand(program);
  registerInitCommand(program);
  registerListCommand(program);
  registerSpecsCommand(program);
  registerUiCommand(program);
  registerServeCommand(program);
  registerStatusCommand(program);
  registerStopCommand(program);
  registerStatsCommand(program);
  registerServerCommand(program);
  registerUninstallCommand(program);

  // Listed so `steptix --help` shows it, but deliberately given no action: the
  // real `mcp` entry is intercepted in `src/index.ts` before commander is
  // ever built (see the comment there — it exists to keep playwright out of
  // the MCP server's module graph). This stub is therefore unreachable in
  // practice, and points at the canonical help rather than duplicating it.
  program
    .command('mcp')
    .description('Run as an MCP server over stdio (see: steptix mcp --help)');

  return program;
}

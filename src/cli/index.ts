import { loadDefaultEnvFileSync, warnIfDeprecatedDataDirEnv } from '../env/loader.js';
loadDefaultEnvFileSync();
warnIfDeprecatedDataDirEnv();

import { Command } from 'commander';
import { getPackageVersion } from '../utils/version.js';
import { registerRunCommand } from './commands/run.js';
import { registerInitCommand } from './commands/init.js';
import { registerListCommand } from './commands/list.js';
import { registerSpecsCommand } from './commands/specs.js';
import { registerUiCommand } from './commands/ui.js';
import { registerServeCommand } from './commands/serve.js';
import { registerStatusCommand } from './commands/status.js';
import { registerStopCommand } from './commands/stop.js';

export function createCli(): Command {
  const program = new Command();

  program
    .name('aiui')
    .description('AI-powered UI test automation using natural language Markdown test files')
    .version(getPackageVersion());

  registerRunCommand(program);
  registerInitCommand(program);
  registerListCommand(program);
  registerSpecsCommand(program);
  registerUiCommand(program);
  registerServeCommand(program);
  registerStatusCommand(program);
  registerStopCommand(program);

  // Listed so `aiui --help` shows it, but deliberately given no action: the
  // real `mcp` entry is intercepted in `src/index.ts` before commander is
  // ever built (see the comment there — it exists to keep playwright out of
  // the MCP server's module graph). This stub is therefore unreachable in
  // practice, and points at the canonical help rather than duplicating it.
  program
    .command('mcp')
    .description('Run as an MCP server over stdio (see: aiui mcp --help)');

  return program;
}

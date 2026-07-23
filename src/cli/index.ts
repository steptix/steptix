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

  return program;
}

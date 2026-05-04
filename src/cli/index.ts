import { loadDefaultEnvFileSync } from '../env/loader.js';
loadDefaultEnvFileSync();

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { registerRunCommand } from './commands/run.js';
import { registerInitCommand } from './commands/init.js';
import { registerListCommand } from './commands/list.js';
import { registerSpecsCommand } from './commands/specs.js';
import { registerUiCommand } from './commands/ui.js';
import { registerServeCommand } from './commands/serve.js';

export function createCli(): Command {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  let version = '1.0.0';
  try {
    const pkgPath = join(__dirname, '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    version = pkg.version ?? '1.0.0';
  } catch {
    // ignore — version fallback
  }

  const program = new Command();

  program
    .name('aiui')
    .description('AI-powered UI test automation using natural language Markdown test files')
    .version(version);

  registerRunCommand(program);
  registerInitCommand(program);
  registerListCommand(program);
  registerSpecsCommand(program);
  registerUiCommand(program);
  registerServeCommand(program);

  return program;
}

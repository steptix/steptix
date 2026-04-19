import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import chalk from 'chalk';
import type { Command } from 'commander';
import { loadConfig } from '../../config/loader.js';
import { loadEnvFile } from '../../env/loader.js';

export interface UiOptions {
  config?: string;
  env?: string;
}

export function registerUiCommand(program: Command): void {
  program
    .command('ui [directory]')
    .description('Launch the Runner UI. Optionally specify a tests directory.')
    .option('-c, --config <path>', 'Path to config file', 'ai-ui-auto.config.ts')
    .option('--env <name>', 'Environment name — loads .env.<name> from project root')
    .action(async (directory: string | undefined, opts: UiOptions) => {
      await uiCommand(directory, opts);
    });
}

async function uiCommand(
  directory: string | undefined,
  opts: UiOptions,
): Promise<void> {
  // Load environment file if --env was specified
  if (opts.env) {
    try {
      await loadEnvFile(opts.env, process.cwd());
    } catch (err) {
      console.error(chalk.red(`Error: ${String(err)}`));
      process.exit(1);
    }
  }

  // Load config to resolve default tests directory
  let config;
  try {
    config = await loadConfig(opts.config);
  } catch (err) {
    console.error(chalk.red(`Failed to load config: ${String(err)}`));
    process.exit(1);
  }

  // Resolve the target tests directory
  const testsDir = path.resolve(directory ?? config.tests.dir);
  const configPath = path.resolve(opts.config ?? 'ai-ui-auto.config.ts');

  // Locate the electron binary from the installed electron package
  const require = createRequire(import.meta.url);
  let electronPath: string;
  try {
    electronPath = require('electron') as unknown as string;
  } catch {
    console.error(
      chalk.red('Error: Could not find the electron package. Make sure it is installed.'),
    );
    process.exit(1);
  }

  // The Electron main process entry point (relative to dist)
  const electronEntry = path.resolve(
    path.dirname(require.resolve('../../ui/main/index.js')),
    'index.cjs',
  );

  console.log(chalk.blue('Launching Runner UI...'));
  console.log(chalk.dim(`  Tests directory: ${testsDir}`));
  console.log(chalk.dim(`  Config: ${configPath}`));

  // Spawn the Electron process
  // Unset ELECTRON_RUN_AS_NODE so Electron runs as a full app, not a Node.js subprocess.
  // On Linux, --no-sandbox is required for display. --ozone-platform-hint=auto
  // lets Electron pick Wayland when available and fall back to X11.
  const spawnEnv = { ...process.env };
  delete spawnEnv['ELECTRON_RUN_AS_NODE'];

  const extraFlags = process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform-hint=auto'] : [];

  const child = spawn(electronPath, [...extraFlags, electronEntry, '--testsDir', testsDir, '--configPath', configPath], {
    stdio: 'inherit',
    env: spawnEnv,
  });

  child.on('error', (err) => {
    console.error(chalk.red(`Failed to launch Electron: ${err.message}`));
    process.exit(1);
  });

  child.on('close', (code) => {
    process.exit(code ?? 0);
  });
}

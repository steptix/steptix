import path from 'node:path';
import chalk from 'chalk';
import type { Command } from 'commander';
import { loadConfig } from '../../config/loader.js';
import { loadContextFiles } from '../../context/loader.js';
import { downloadSpec, listCachedSpecs, extractSpecUrlsFromContext } from '../../api/spec-loader.js';

export function registerSpecsCommand(program: Command): void {
  const specs = program
    .command('specs')
    .description('Manage cached OpenAPI/Swagger specs referenced in context files');

  specs
    .command('sync [name]')
    .description('Download / re-download specs. Optionally filter by partial name match.')
    .option('-c, --config <path>', 'Path to config file (default: auto-discover aiui.config.json)')
    .action(async (name: string | undefined, opts: { config?: string }) => {
      await syncSpecs(name, opts.config);
    });

  specs
    .command('list')
    .description('List all cached specs with source URLs and last-synced date')
    .option('-c, --config <path>', 'Path to config file (default: auto-discover aiui.config.json)')
    .action(async (opts: { config?: string }) => {
      await listSpecs(opts.config);
    });
}

async function syncSpecs(
  filterName: string | undefined,
  configPath?: string,
): Promise<void> {
  const config = await loadConfig(configPath);
  const specsDir = config.api?.specsDir ?? './specs';

  // Discover spec URLs from context files
  const context = await loadContextFiles(config.tests.contextDir);
  const allUrls = extractSpecUrlsFromContext(context.combined);

  if (allUrls.length === 0) {
    console.log(chalk.yellow('No "Spec URL:" entries found in context files.'));
    console.log(chalk.dim('Add "Spec URL: https://..." lines to your API context files.'));
    return;
  }

  const toSync = filterName
    ? allUrls.filter((u) => u.toLowerCase().includes(filterName.toLowerCase()))
    : allUrls;

  if (toSync.length === 0) {
    console.log(chalk.yellow(`No spec URLs matching "${filterName}"`));
    return;
  }

  console.log(chalk.bold(`\nSyncing ${toSync.length} spec(s) to ${specsDir}/...\n`));

  let synced = 0;
  let failed = 0;

  for (const url of toSync) {
    process.stdout.write(`  ${url}  `);
    try {
      await downloadSpec(url, path.resolve(specsDir));
      console.log(chalk.green('✓'));
      synced++;
    } catch (err) {
      console.log(chalk.red(`✗ ${String(err)}`));
      failed++;
    }
  }

  console.log();
  if (failed === 0) {
    console.log(chalk.green(`✓ ${synced} spec(s) synced`));
  } else {
    console.log(`${chalk.green(`${synced} synced`)}, ${chalk.red(`${failed} failed`)}`);
    process.exitCode = 1;
  }
}

async function listSpecs(configPath?: string): Promise<void> {
  const config = await loadConfig(configPath);
  const specsDir = config.api?.specsDir ?? './specs';

  const summaries = await listCachedSpecs(specsDir);

  if (summaries.length === 0) {
    console.log(chalk.yellow('No cached specs found.'));
    console.log(chalk.dim('Run "aiui specs sync" to download them.'));
    return;
  }

  console.log(chalk.bold(`\nCached specs (${summaries.length}) in ${specsDir}/:\n`));

  for (const s of summaries) {
    const date = new Date(s.cachedAt).toLocaleString('en-AU', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    console.log(`  ${chalk.cyan(s.name)}`);
    console.log(`    Source:  ${chalk.dim(s.url)}`);
    console.log(`    Cached:  ${date}`);
    console.log();
  }
}

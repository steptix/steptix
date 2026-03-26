import path from 'node:path';
import chalk from 'chalk';
import type { Command } from 'commander';
import { loadConfig } from '../../config/loader.js';
import { discoverTestFiles } from '../../parser/markdown.js';
import { parseFrontmatter } from '../../parser/frontmatter.js';
import { logger } from '../../utils/logger.js';
import fs from 'node:fs/promises';

export interface ListOptions {
  config?: string;
  tag?: string;
  json?: boolean;
}

export function registerListCommand(program: Command): void {
  program
    .command('list [target]')
    .description('List discovered test files with their tags and metadata')
    .option('-c, --config <path>', 'Path to config file', 'ai-ui-auto.config.ts')
    .option('-t, --tag <tags>', 'Filter tests by tag (comma-separated, AND logic)')
    .option('--json', 'Output as JSON', false)
    .action(async (target: string | undefined, opts: ListOptions) => {
      await listCommand(target, opts);
    });
}

interface TestFileSummary {
  filePath: string;
  relativePath: string;
  title: string;
  tags: string[];
  hasDataFile: boolean;
  timeout?: string;
}

async function listCommand(
  target: string | undefined,
  opts: ListOptions,
): Promise<void> {
  const config = await loadConfig(opts.config);

  const testDir = target ? path.resolve(target) : path.resolve(config.tests.dir);
  const pattern = config.tests.pattern;

  logger.debug(`Discovering tests in: ${testDir}`);

  let files: string[];
  try {
    files = await discoverTestFiles(testDir, pattern);
  } catch {
    console.log(chalk.yellow(`No test directory found at: ${testDir}`));
    process.exit(0);
  }

  if (files.length === 0) {
    console.log(chalk.yellow('No test files found.'));
    process.exit(0);
  }

  // Parse frontmatter for each file (lightweight — no full markdown parse needed)
  const summaries: TestFileSummary[] = [];
  for (const filePath of files) {
    const summary = await readTestSummary(filePath, testDir);
    summaries.push(summary);
  }

  // Apply tag filter
  const filterTags = opts.tag
    ? opts.tag.split(',').map((t) => t.trim()).filter(Boolean)
    : [];

  const filtered = filterTags.length > 0
    ? summaries.filter((s) => filterTags.every((tag) => s.tags.includes(tag)))
    : summaries;

  if (filtered.length === 0) {
    const tagInfo = filterTags.length > 0 ? ` matching tags: ${filterTags.join(', ')}` : '';
    console.log(chalk.yellow(`No tests found${tagInfo}`));
    process.exit(0);
  }

  if (opts.json) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  // Human-readable output
  const tagFilterInfo = filterTags.length > 0
    ? chalk.dim(` (filtered by: ${filterTags.join(', ')})`)
    : '';

  console.log(chalk.bold(`\nFound ${filtered.length} test file(s)${tagFilterInfo}:\n`));

  for (const summary of filtered) {
    const tagsStr = summary.tags.length > 0
      ? chalk.cyan(` [${summary.tags.join(', ')}]`)
      : chalk.dim(' [no tags]');

    const extras: string[] = [];
    if (summary.hasDataFile) extras.push(chalk.magenta('data-driven'));
    if (summary.timeout) extras.push(chalk.dim(`timeout: ${summary.timeout}`));
    const extrasStr = extras.length > 0 ? `  ${extras.join('  ')}` : '';

    console.log(`  ${chalk.bold(summary.title)}${tagsStr}`);
    console.log(`  ${chalk.dim(summary.relativePath)}${extrasStr}`);
    console.log('');
  }
}

async function readTestSummary(
  filePath: string,
  baseDir: string,
): Promise<TestFileSummary> {
  let rawContent = '';
  try {
    rawContent = await fs.readFile(filePath, 'utf-8');
  } catch {
    // Return minimal summary if file can't be read
    return {
      filePath,
      relativePath: path.relative(baseDir, filePath),
      title: path.basename(filePath, '.md'),
      tags: [],
      hasDataFile: false,
    };
  }

  const { frontmatter, body } = parseFrontmatter(rawContent);

  // Extract title from first H1 heading (cheap scan without full markdown parse)
  const h1Match = body.match(/^#\s+(.+)$/m);
  const title = h1Match?.[1]?.trim() ?? path.basename(filePath, '.md');

  const summary: TestFileSummary = {
    filePath,
    relativePath: path.relative(baseDir, filePath),
    title,
    tags: frontmatter.tags,
    hasDataFile: Boolean(frontmatter.dataFile),
  };

  if (frontmatter.timeout !== undefined) {
    summary.timeout = frontmatter.timeout;
  }

  return summary;
}

import path from 'node:path';
import chalk from 'chalk';
import ora from 'ora';
import type { Command } from 'commander';
import { loadConfig, applyCliOverrides } from '../../config/loader.js';
import { parseTestFile, discoverTestFiles } from '../../parser/markdown.js';
import { filterByTags, runTests } from '../../runner/test-runner.js';
import { setVerbose, logger } from '../../utils/logger.js';
import type { RunSummary } from '../../report/types.js';

export interface RunOptions {
  config?: string;
  tag?: string;
  headless?: boolean;
  timeout?: number;
  verbose?: boolean;
  bail?: boolean;
  browser?: 'chromium' | 'firefox' | 'webkit';
  reporter?: string;
}

export function registerRunCommand(program: Command): void {
  program
    .command('run [target]')
    .description('Run test files. Target can be a file path or directory.')
    .option('-c, --config <path>', 'Path to config file', 'ai-ui-auto.config.ts')
    .option('-t, --tag <tags>', 'Filter tests by tag (comma-separated, AND logic)')
    .option('--headless', 'Run browser in headless mode', false)
    .option('--timeout <ms>', 'Test timeout in milliseconds', parseInt)
    .option('--verbose', 'Verbose console output', false)
    .option('--bail', 'Stop on first test failure', false)
    .option('--browser <engine>', 'Browser engine: chromium, firefox, webkit')
    .option('--reporter <type>', 'Reporter type (html)', 'html')
    .action(async (target: string | undefined, opts: RunOptions) => {
      await runCommand(target, opts);
    });
}

async function runCommand(
  target: string | undefined,
  opts: RunOptions,
): Promise<void> {
  if (opts.verbose) {
    setVerbose(true);
  }

  // Load config
  const spinner = ora('Loading configuration...').start();
  let config = await loadConfig(opts.config);

  config = applyCliOverrides(config, {
    ...(opts.headless !== undefined && { headless: opts.headless }),
    ...(opts.timeout !== undefined && { timeout: opts.timeout }),
    ...(opts.browser !== undefined && { browser: opts.browser }),
  });

  spinner.succeed('Configuration loaded');

  // Discover test files
  const testFiles = await resolveTestFiles(target, config.tests.dir, config.tests.pattern);

  if (testFiles.length === 0) {
    console.log(chalk.yellow('No test files found.'));
    process.exit(0);
  }

  // Parse test files
  logger.info(`Discovering tests from ${testFiles.length} file(s)...`);
  const parsedTests = await Promise.all(testFiles.map(parseTestFile));

  // Filter by tags
  const tags = opts.tag
    ? opts.tag.split(',').map((t) => t.trim()).filter(Boolean)
    : [];
  const filteredTests = filterByTags(parsedTests, tags);

  if (filteredTests.length === 0) {
    const tagInfo = tags.length > 0 ? ` matching tags: ${tags.join(', ')}` : '';
    console.log(chalk.yellow(`No tests found${tagInfo}`));
    process.exit(0);
  }

  console.log(chalk.bold(`\nRunning ${filteredTests.length} test(s)...\n`));

  // Run tests
  let summary: RunSummary;
  try {
    summary = await runTests(filteredTests, config, {
      ...(opts.bail !== undefined && { bail: opts.bail }),
      ...(opts.verbose !== undefined && { verbose: opts.verbose }),
    });
  } catch (err) {
    logger.error(`Fatal error during test run: ${String(err)}`);
    process.exit(1);
  }

  // Print summary
  printSummary(summary);

  // Exit with code 1 if any tests failed
  process.exit(summary.failedTests > 0 ? 1 : 0);
}

async function resolveTestFiles(
  target: string | undefined,
  defaultDir: string,
  pattern: string,
): Promise<string[]> {
  if (!target) {
    return discoverTestFiles(defaultDir, pattern);
  }

  const absTarget = path.resolve(target);

  try {
    const { default: fs } = await import('node:fs/promises');
    const stat = await fs.stat(absTarget);

    if (stat.isFile()) {
      return [absTarget];
    }

    if (stat.isDirectory()) {
      return discoverTestFiles(absTarget, pattern);
    }
  } catch {
    // Target not found — treat as glob pattern
  }

  return discoverTestFiles(path.dirname(absTarget), path.basename(absTarget));
}

function printSummary(summary: RunSummary): void {
  console.log(chalk.bold(`\n${'═'.repeat(60)}`));
  console.log(chalk.bold('  TEST RUN SUMMARY'));
  console.log(chalk.bold(`${'═'.repeat(60)}`));

  console.log(`  Total:    ${summary.totalTests}`);
  console.log(`  ${chalk.green('Passed:')}   ${chalk.green(String(summary.passedTests))}`);
  console.log(`  ${chalk.red('Failed:')}   ${chalk.red(String(summary.failedTests))}`);
  console.log(`  Duration: ${(summary.totalDurationMs / 1000).toFixed(1)}s`);
  console.log(`  Tokens:   ${summary.totalTokensUsed.toLocaleString()}`);

  if (summary.failedTests > 0) {
    console.log();
    console.log(chalk.red('  FAILED TESTS:'));
    for (const report of summary.reports) {
      if (report.status === 'failed') {
        const failedSteps = report.steps
          .filter((s) => s.status === 'failed')
          .map((s) => `Step ${s.index}: ${s.instruction}`)
          .join(', ');
        console.log(chalk.red(`  ✗ ${report.testName}`));
        if (failedSteps) {
          console.log(chalk.dim(`    ${failedSteps}`));
        }
      }
    }
  }

  console.log(chalk.bold(`${'═'.repeat(60)}\n`));
}

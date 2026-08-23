import path from 'node:path';
import chalk from 'chalk';
import ora from 'ora';
import type { Command } from 'commander';
import { loadConfig, applyCliOverrides } from '../../config/loader.js';
import { parseTestFile, discoverTestFiles } from '../../parser/markdown.js';
import { filterByTags, runTests } from '../../runner/test-runner.js';
import { setVerbose, logger } from '../../utils/logger.js';
import type { RunSummary } from '../../report/types.js';
import { countStepOrigins } from '../../report/generator.js';
import { resolveEnvBundle } from '../../env/resolve-bundle.js';

export interface RunOptions {
  config?: string;
  tag?: string;
  headless?: boolean;
  timeout?: number;
  verbose?: boolean;
  bail?: boolean;
  browser?: 'chromium' | 'firefox' | 'webkit';
  reporter?: string;
  env?: string;
}

export function registerRunCommand(program: Command): void {
  program
    .command('run [target]')
    .description('Run test files. Target can be a file path or directory.')
    .option('-c, --config <path>', 'Path to config file (default: auto-discover aiui.config.json)')
    .option('-t, --tag <tags>', 'Filter tests by tag (comma-separated, AND logic)')
    .option('--headless', 'Run browser in headless mode', false)
    .option('--timeout <ms>', 'Test timeout in milliseconds', parseInt)
    .option('--verbose', 'Verbose console output', false)
    .option('--bail', 'Stop on first test failure', false)
    .option('--browser <engine>', 'Browser engine: chromium, firefox, webkit')
    .option('--reporter <type>', 'Reporter type (html)', 'html')
    .option('--env <name>', 'Environment name — loads .env.<name> from project root')
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

  // Resolve env name with precedence: --env flag > AUTOMATION_ENV envvar > unset.
  // (Per-test frontmatter `env:` overrides come into play below, when no
  // run-wide selector was supplied.)
  const cliEnvName = opts.env?.trim() || process.env['AUTOMATION_ENV']?.trim() || undefined;

  // Load config first — env/data resolution needs `tests.dataDir`.
  const spinner = ora('Loading configuration...').start();
  let config = await loadConfig(opts.config);

  config = applyCliOverrides(config, {
    ...(opts.headless !== undefined && { headless: opts.headless }),
    ...(opts.timeout !== undefined && { timeout: opts.timeout }),
    ...(opts.browser !== undefined && { browser: opts.browser }),
  });

  spinner.succeed('Configuration loaded');

  // Load env+data bundle for the run-wide selector, if any. Per-test
  // overrides (frontmatter `env:`) get loaded on demand below. The CLI is
  // single-project, so mutate process.env — consumers that read it directly
  // (API auth, param `$VAR`) still see project values.
  let runBundle;
  try {
    runBundle = await resolveEnvBundle({
      envName: cliEnvName,
      projectRoot: process.cwd(),
      dataDir: config.tests.dataDir,
      mutateProcessEnv: true,
    });
  } catch (err) {
    console.error(chalk.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }

  // Discover test files
  const testFiles = await resolveTestFiles(target, config.tests.dir, config.tests.pattern);

  if (testFiles.length === 0) {
    console.log(chalk.yellow('No test files found.'));
    process.exit(0);
  }

  // Parse test files (expanding any [skill: ...] references).
  //
  // Two-pass strategy when there's no run-wide --env: parse once with the
  // (possibly empty) bundle so we can read frontmatter, then re-parse any
  // test that declared its own `env:` override with that test's bundle. This
  // avoids loading a per-test env until we know we need it.
  logger.info(`Discovering tests from ${testFiles.length} file(s)...`);
  const skillsDir = path.resolve(process.cwd(), config.tests.skillsDir);
  const envDataCtx = cliEnvName
    ? { env: runBundle.env, data: runBundle.data, envName: runBundle.envName }
    : undefined;
  const parsedAll = await Promise.all(
    testFiles.map(async (f) => {
      const initial = await parseTestFile(f, {
        skillsDir,
        ...(envDataCtx && { envData: envDataCtx }),
      });
      // Honour frontmatter env: only when CLI/envvar didn't pin one already.
      if (!cliEnvName && initial.frontmatter.env) {
        const perTestBundle = await resolveEnvBundle({
          envName: initial.frontmatter.env,
          projectRoot: process.cwd(),
          dataDir: config.tests.dataDir,
          mutateProcessEnv: true,
        });
        return parseTestFile(f, {
          skillsDir,
          envData: {
            env: perTestBundle.env,
            data: perTestBundle.data,
            envName: perTestBundle.envName,
          },
        });
      }
      return initial;
    }),
  );
  // Skip files marked as skills — they're library code, not runnable tests.
  const parsedTests = parsedAll.filter((t) => t.frontmatter.type !== 'skill');

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
      // The run-wide env (--env / AUTOMATION_ENV) the cache must key under.
      // When unset, runTest falls back to each test's frontmatter env, matching
      // this command's two-pass env precedence above.
      ...(cliEnvName !== undefined && { runEnvName: cliEnvName }),
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

  // How the steps got done. Shown only once code-behind is in play — on a test
  // with none, "0 code-behind, 9 AI, 0 stale" is a line that says nothing.
  const origins = summary.reports
    .map((r) => countStepOrigins(r.steps))
    .reduce(
      (acc, o) => ({ code: acc.code + o.code, ai: acc.ai + o.ai, stale: acc.stale + o.stale }),
      { code: 0, ai: 0, stale: 0 },
    );
  if (origins.code > 0 || origins.stale > 0) {
    const total = origins.code + origins.ai + origins.stale;
    const staleText = `${origins.stale} stale`;
    console.log(
      `  Steps:    ${total} — ${origins.code} code-behind, ${origins.ai} AI, ` +
        (origins.stale > 0 ? chalk.yellow(staleText) : staleText),
    );
    if (origins.stale > 0) {
      console.log(
        chalk.yellow(
          `            ${origins.stale} step(s) ran under AI because their code-behind failed — ` +
            `recompile with \`aiui compile <test.md> --only-stale\`.`,
        ),
      );
    }
  }

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

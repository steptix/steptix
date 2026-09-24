import path from 'node:path';
import chalk from 'chalk';
import ora from 'ora';
import type { Command } from 'commander';
import { loadConfig, applyCliOverrides } from '../../config/loader.js';
import { parseTestFile, discoverTestFiles } from '../../parser/markdown.js';
import { filterByTags, runTests } from '../../runner/test-runner.js';
import { setVerbose, logger } from '../../utils/logger.js';
import type { RunSummary } from '../../report/types.js';
import { countStepOrigins, formatTokenCount } from '../../report/generator.js';
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
  failOnHealed?: boolean;
  row?: number;
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
    // 1-based, matching the row numbers the report shows. Narrows a
    // data-driven test to one row for a debugging loop; the surviving instance
    // keeps its original index, so it still reports "row 3 of 5".
    .option('--row <n>', 'Run only this data row (1-based) of a data-driven test', parseInt)
    // Off by default: a healed run passes today and must keep passing today.
    // The flag is how CI opts into treating "passed, but four broken entries
    // healed under AI" as a build failure
    // (stories/codebehind-selector-ambiguity.md).
    .option('--fail-on-healed', 'Exit non-zero when a step healed under AI after its code-behind failed', false)
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

  // `--row` names a row of one test. Against a glob it would mean "row 3 of
  // whichever files happen to have three rows", and abort the rest at the
  // first file that has fewer — so it is refused rather than interpreted.
  if (opts.row !== undefined && filteredTests.length > 1) {
    logger.error(
      `--row applies to a single test, but ${filteredTests.length} files matched. ` +
        `Name one test file.`,
    );
    process.exit(1);
  }

  console.log(chalk.bold(`\nRunning ${filteredTests.length} test(s)...\n`));

  // Run tests
  let summary: RunSummary;
  try {
    summary = await runTests(filteredTests, config, {
      ...(opts.bail !== undefined && { bail: opts.bail }),
      ...(opts.verbose !== undefined && { verbose: opts.verbose }),
      ...(opts.row !== undefined && { row: opts.row }),
    });
  } catch (err) {
    logger.error(`Fatal error during test run: ${String(err)}`);
    process.exit(1);
  }

  // Print summary
  printSummary(summary);

  // A run that healed broken code-behind is green today and stays green
  // unless the author asked otherwise. With `--fail-on-healed` it is a
  // failure, so CI can gate on the cost instead of paying it silently.
  const healed = countHealedSteps(summary);
  if (opts.failOnHealed && healed > 0) {
    console.log(
      chalk.red(
        `  FAILING: ${healed} step(s) healed under AI (--fail-on-healed).`,
      ),
    );
    console.log();
  }

  process.exit(exitCodeFor(summary, opts.failOnHealed === true));
}

/**
 * How many steps across the run healed under AI after their code-behind
 * entry threw.
 *
 * `healedSteps` where the runner set it, and the count off the steps
 * otherwise — a report from an older path is still gated correctly.
 */
export function countHealedSteps(summary: RunSummary): number {
  return summary.reports.reduce(
    (n, r) => n + (r.healedSteps ?? countStepOrigins(r.steps).stale),
    0,
  );
}

/**
 * The process exit code for a finished run: 1 on any failed test, as always,
 * and — only under `--fail-on-healed` — 1 on a run that passed by healing
 * broken code-behind entries under AI.
 *
 * Split out so the gate is testable without driving a whole run, and so the
 * "without the flag, nothing changed" half is an assertion rather than a
 * reading of the expression.
 */
export function exitCodeFor(summary: RunSummary, failOnHealed: boolean): number {
  if (summary.failedTests > 0) return 1;
  return failOnHealed && countHealedSteps(summary) > 0 ? 1 : 0;
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
  // A data-driven test counts once in Total, so without this line five rows
  // would be invisible behind "Total: 1".
  const rowLines = summary.reports.flatMap((r) => r.rows ?? []);
  if (rowLines.length > 0) {
    const passed = rowLines.filter((r) => r.status === 'passed').length;
    const failed = rowLines.filter((r) => r.status === 'failed').length;
    const notRun = rowLines.filter((r) => r.status === 'skipped').length;
    const parts = [`${passed} passed`, `${failed} failed`];
    if (notRun > 0) parts.push(`${notRun} not run`);
    console.log(`  Rows:     ${rowLines.length} — ${parts.join(', ')}`);
  }
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
      // The token figure is what makes the hint land: it is the price of
      // leaving the entries broken, charged again on every run.
      const healedTokens = summary.reports.reduce((n, r) => n + (r.healedTokens ?? 0), 0);
      const cost = healedTokens > 0 ? ` (${formatTokenCount(healedTokens)} tokens)` : '';
      console.log(
        chalk.yellow(
          `            ${origins.stale} step(s) ran under AI because their code-behind failed${cost} — ` +
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
        // `!s.tolerated`: this list answers "what went wrong in this test", and a
        // step the author said to carry past stopped nothing (decision 6). Naming it
        // would put it under FAILED TESTS beside the failure that ended the run.
        const failedSteps = report.steps
          .filter((s) => s.status === 'failed' && !s.tolerated)
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

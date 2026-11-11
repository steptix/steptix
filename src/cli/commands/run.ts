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
import { nonNegativeInt } from '../parse-args.js';
import { COPILOT_IN_TERMINAL, copilotOutOfReach } from '../../ai/copilot-terminal.js';
import { chooseReporters, ReporterNameError } from '../../report/reporters/names.js';
import {
  removeAllResultFiles,
  RunReporters,
  suiteNameFor,
  wantsResultFiles,
  type ParseOutcome,
  type RunReportersOptions,
} from '../../report/reporters/run-reporters.js';
import type { ReporterName } from '../../report/reporters/types.js';
import type { ParsedTest } from '../../parser/types.js';

export interface RunOptions {
  config?: string;
  tag?: string;
  headless?: boolean;
  timeout?: number;
  verbose?: boolean;
  bail?: boolean;
  browser?: 'chromium' | 'firefox' | 'webkit';
  /** Each `--reporter` given, in order; absent when the option was not given. */
  reporter?: string[];
  env?: string;
  failOnHealed?: boolean;
  row?: number;
}

export function registerRunCommand(program: Command): void {
  program
    .command('run [target]')
    .description('Run test files. Target can be a file path or directory.')
    .option('-c, --config <path>', 'Path to config file (default: auto-discover steptix.config.json)')
    .option('-t, --tag <tags>', 'Filter tests by tag (comma-separated, AND logic)')
    .option('--headless', 'Run browser in headless mode', false)
    // `nonNegativeInt`, not `parseInt`: `--timeout abc` parsed to NaN, and
    // since the timeout became a real deadline (steptix/steptix#47) a NaN
    // budget must not reach the runner looking like a number. Refused here
    // with commander's usage error and exit 1, as `serve --idle-timeout` is.
    .option('--timeout <ms>', 'Test timeout in milliseconds', nonNegativeInt)
    .option('--verbose', 'Verbose console output', false)
    .option('--bail', 'Stop on first test failure', false)
    .option('--browser <engine>', 'Browser engine: chromium, firefox, webkit')
    // Repeatable, and with no default: "not given" has to differ from "given
    // as html", because a given flag replaces `reports.reporters`
    // (docs/specs/SPEC-reporters.md §4).
    .option(
      '--reporter <names>',
      'Results files to write as well as the HTML reports: junit, json (comma-separated, repeatable; html is always written)',
      collectReporter,
    )
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
    .action(async (target: string | undefined, opts: RunOptions, cmd: Command) => {
      await runCommand(target, opts, { usageError: (message) => cmd.error(message) });
    });
}

/** Commander's collector for the repeatable `--reporter`. */
function collectReporter(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

/** What {@link runCommand} takes besides its options; the optional ones are seams for a test. */
export interface RunCommandDeps {
  /** Print a usage error as commander does and exit 1. Does not return. */
  usageError: (message: string) => never;
  /** Ends the process; `process.exit` unless a test stands in. */
  exit?: (code: number) => never;
  /** Stands in for the real runner, as `runTests` allows. */
  runTestFn?: NonNullable<Parameters<typeof runTests>[2]>['runTestFn'];
  /** Overrides for the reporter files' seams (render functions, clock, file operations). */
  reporterOptions?: Partial<RunReportersOptions>;
}

export async function runCommand(
  target: string | undefined,
  opts: RunOptions,
  deps: RunCommandDeps,
): Promise<void> {
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
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

  // Where `junit.xml` and `run.json` go, resolved as `generateReport` resolves
  // it, so the files sit beside the HTML reports they link to.
  const resultsDir = path.resolve(config.reports.outputDir);
  // Checked before anything runs, so a misspelt name does not cost a run to
  // find out about (§4).
  let reporterNames: ReporterName[];
  try {
    reporterNames = chooseReporters(
      opts.reporter,
      config.reports.reporters,
      opts.config ?? 'steptix.config.json',
    );
  } catch (err) {
    if (!(err instanceof ReporterNameError)) throw err;
    // Which files were meant is unknown, so neither file an earlier run left
    // is kept for CI to publish as this run's (§4, §5).
    await removeAllResultFiles({
      outputDir: resultsDir,
      cwd: process.cwd(),
      ...deps.reporterOptions,
    });
    return deps.usageError(err.message);
  }
  // Null with neither `junit` nor `json` on: the run is then exactly the run
  // it was before these files existed.
  const reporters = wantsResultFiles(reporterNames)
    ? new RunReporters({
        reporters: reporterNames,
        outputDir: resultsDir,
        failOnHealed: opts.failOnHealed === true,
        suiteName: await suiteNameFor(process.cwd()),
        cwd: process.cwd(),
        ...deps.reporterOptions,
      })
    : null;
  // Gone before anything else can stop the run, so CI never publishes the
  // previous run's files as this one's (§5).
  await reporters?.removeStale();
  // Compiled steps still run; the ones that need the AI would fail to connect.
  if (await copilotOutOfReach(config.ai)) console.warn(chalk.yellow(COPILOT_IN_TERMINAL));

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
    return exit(1);
  }

  // Discover test files
  const testFiles = await resolveTestFiles(target, config.tests.dir, config.tests.pattern);

  if (testFiles.length === 0) {
    console.log(chalk.yellow('No test files found.'));
    return exit(await endReporters(reporters, 0));
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
  const parsing = testFiles.map(async (f) => {
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
  });
  // Filter by tags
  const tags = opts.tag
    ? opts.tag.split(',').map((t) => t.trim()).filter(Boolean)
    : [];
  let parsedAll: ParsedTest[];
  try {
    parsedAll = await Promise.all(parsing);
  } catch (err) {
    // The files say why nothing ran (§8.1). Then the error goes on exactly as
    // it did before there were files to write.
    if (reporters) await reportParseFailure(reporters, testFiles, parsing, tags);
    throw err;
  }
  // Skip files marked as skills — they're library code, not runnable tests.
  const parsedTests = parsedAll.filter((t) => t.frontmatter.type !== 'skill');

  const filteredTests = filterByTags(parsedTests, tags);

  if (filteredTests.length === 0) {
    const tagInfo = tags.length > 0 ? ` matching tags: ${tags.join(', ')}` : '';
    console.log(chalk.yellow(`No tests found${tagInfo}`));
    return exit(await endReporters(reporters, 0));
  }

  // `--row` names a row of one test. Against a glob it would mean "row 3 of
  // whichever files happen to have three rows", and abort the rest at the
  // first file that has fewer — so it is refused rather than interpreted.
  // With reporters on, the stale files were already removed above, and none
  // are written for a run that never started.
  if (opts.row !== undefined && filteredTests.length > 1) {
    logger.error(
      `--row applies to a single test, but ${filteredTests.length} files matched. ` +
        `Name one test file.`,
    );
    return exit(1);
  }

  console.log(chalk.bold(`\nRunning ${filteredTests.length} test(s)...\n`));

  // Run tests
  let summary: RunSummary;
  const disarmUnfinishedRunGuard = guardUnfinishedRun();
  try {
    summary = await runTests(filteredTests, config, {
      ...(opts.bail !== undefined && { bail: opts.bail }),
      ...(opts.verbose !== undefined && { verbose: opts.verbose }),
      ...(opts.row !== undefined && { row: opts.row }),
      ...(reporters && { observer: reporters.observer }),
      ...(deps.runTestFn && { runTestFn: deps.runTestFn }),
    });
  } catch (err) {
    logger.error(`Fatal error during test run: ${String(err)}`);
    return exit(await endReporters(reporters, 1));
  } finally {
    // Reached when `runTests` returns. On a throw, the catch above writes the
    // files (when reporters are on) and then `exit(1)` ends the process
    // before this runs — and an explicit exit never emits `beforeExit`, so the
    // guard cannot fire on that path either. A stand-in `exit` that throws
    // reaches here after the catch.
    disarmUnfinishedRunGuard();
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

  return exit(await endReporters(reporters, exitCodeFor(summary, opts.failOnHealed === true)));
}

/**
 * The reporters' last write (§8, step 3), then a line for each file it wrote
 * (§9). Returns the exit code to end with: `exitCode`, or 1 where that was 0
 * and a file could not be written (§8.2). With no reporters, `exitCode`.
 */
async function endReporters(reporters: RunReporters | null, exitCode: number): Promise<number> {
  if (!reporters) return exitCode;
  const code = await reporters.end(exitCode);
  const lines = reporters.summaryLines();
  for (const line of lines) console.log(line);
  if (lines.length > 0) console.log();
  return code;
}

/**
 * A test file failed to parse, so nothing will run (§8.1): write the files
 * with one parse error per file that failed and the tests that parsed listed
 * as not run, and end them with exit code 1, the code the error ends the run
 * with. Waits for every file's parse to settle first, so each failure is
 * listed and not only the first.
 */
async function reportParseFailure(
  reporters: RunReporters,
  testFiles: readonly string[],
  parsing: readonly Promise<ParsedTest>[],
  tags: readonly string[],
): Promise<void> {
  const settled = await Promise.allSettled(parsing);
  const outcomes: ParseOutcome[] = [];
  settled.forEach((result, i) => {
    const filePath = testFiles[i]!;
    if (result.status === 'rejected') {
      outcomes.push({ filePath, error: result.reason });
    } else if (
      result.value.frontmatter.type !== 'skill' &&
      filterByTags([result.value], [...tags]).length > 0
    ) {
      outcomes.push({ filePath, test: result.value });
    }
  });
  await reporters.parseFailed(outcomes);
  await endReporters(reporters, 1);
}

/** What {@link guardUnfinishedRun} needs of `process` — a stand-in in a test. */
export interface UnfinishedRunTarget {
  exitCode?: number | string | null | undefined;
  once(event: 'beforeExit', listener: () => void): unknown;
  removeListener(event: 'beforeExit', listener: () => void): unknown;
}

/** What {@link guardUnfinishedRun} logs when it fires. */
export const UNFINISHED_RUN_MESSAGE =
  'The run ended before it finished: it was still waiting for something ' +
  'that can no longer arrive (input at a prompt, say). Exiting with code 1 ' +
  'so this is not read as a pass.';

/**
 * Make sure a run that never finished cannot exit 0 (#46). Returns the disarm,
 * for when `runTests` returns.
 *
 * `runCommand` ends every run that finishes with an explicit `process.exit` —
 * the summary's code, or 1 from the catch. Node emits `beforeExit` only when
 * the event loop runs dry WITHOUT that call: nothing left to do while the
 * promise `runTests` returned is still pending, so nothing can ever settle it.
 * Node's exit code for running dry is 0, and CI reads 0 as a pass. That is
 * how a parameter prompt on an ended stdin passed a pipeline that had run
 * nothing.
 *
 * That prompt no longer waits, but it was one `await` among many between here
 * and the summary, and any of them waiting on something that cannot come would
 * do the same. This answers the whole class: whatever the cause, a run that
 * ends without a result exits 1 and says so. It is no help with a hang — a
 * wait the loop is still alive for never empties it — only with a silent exit.
 *
 * `once`, because the log line can wake the loop again — stderr writes are
 * asynchronous for some kinds of stream on some platforms, and one keeps the
 * loop alive until it flushes — and the loop running dry a second time must
 * exit, not log again. An exit code
 * something else already set is kept: only success is wrong here. A listener
 * holds no handle, so the guard never keeps the process alive by itself.
 */
export function guardUnfinishedRun(
  proc: UnfinishedRunTarget = process,
  log: (message: string) => void = (message) => logger.error(message),
): () => void {
  const onBeforeExit = (): void => {
    if (!proc.exitCode) proc.exitCode = 1;
    log(UNFINISHED_RUN_MESSAGE);
  };
  proc.once('beforeExit', onBeforeExit);
  return () => {
    proc.removeListener('beforeExit', onBeforeExit);
  };
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
            `recompile with \`steptix compile <test.md> --only-stale\`.`,
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

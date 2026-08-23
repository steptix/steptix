import path from 'node:path';
import chalk from 'chalk';
import type { Command } from 'commander';
import { loadConfig, applyCliOverrides } from '../../config/loader.js';
import { parseTestFile } from '../../parser/markdown.js';
import { loadContextFiles } from '../../context/loader.js';
import { resolveEnvBundle } from '../../env/resolve-bundle.js';
import { AiClient } from '../../ai/client.js';
import { TokenTracker } from '../../utils/tokens.js';
import { setVerbose, logger } from '../../utils/logger.js';
import {
  compileTest,
  type CompileEvent,
  type CompileResult,
  type CompileSelect,
  firstDataRow,
} from '../../codebehind/compile.js';

/**
 * `aiui compile <test.md>` — write a test's code-behind
 * (stories/codebehind-compile.md, "What the author runs").
 *
 * The scriptable half of the feature: it writes the files directly, where
 * TestBench will offer a diff. Exit 0 on green, 1 otherwise, so it drops into
 * a script or a pre-commit hook without ceremony.
 */

export interface CompileOptions {
  config?: string;
  env?: string;
  headless?: boolean;
  onlyStale?: boolean;
  all?: boolean;
  steps?: string;
  dryRun?: boolean;
  maxRounds?: number;
  verbose?: boolean;
}

export function registerCompileCommand(program: Command): void {
  program
    .command('compile <test>')
    .description(
      'Compile a test\'s steps into its code-behind: record under AI, generate, ' +
        'review, replay as pure code until green, then write the .steps.ts.',
    )
    .option('-c, --config <path>', 'Path to config file (default: auto-discover aiui.config.json)')
    .option('--env <name>', 'Environment name — loads .env.<name> from project root')
    .option('--headless', 'Run the browser headless for the record and replay runs', false)
    .option('--only-stale', 'Only steps a previous run flagged as failed code-behind', false)
    .option('--all', 'Every eligible step, including ones with working entries', false)
    .option('--steps <range>', 'Step numbers to compile, e.g. 5 or 3-5 or 3-5,8')
    .option('--dry-run', 'Run everything but the write, and print the candidate', false)
    .option('--max-rounds <n>', 'Replay rounds before a step is written off as AI', parseInt)
    .option('--verbose', 'Verbose console output', false)
    .action(async (test: string, opts: CompileOptions) => {
      await compileCommand(test, opts);
    });
}

async function compileCommand(target: string, opts: CompileOptions): Promise<void> {
  if (opts.verbose) setVerbose(true);

  if (opts.onlyStale && opts.all) {
    console.error(chalk.red('Error: --only-stale and --all select opposite things; pick one.'));
    process.exit(1);
  }

  let select: CompileSelect;
  try {
    select = buildSelect(opts);
  } catch (err) {
    console.error(chalk.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }

  let config = await loadConfig(opts.config);
  config = applyCliOverrides(config, {
    ...(opts.headless !== undefined && { headless: opts.headless }),
  });

  const envName = opts.env?.trim() || process.env['AUTOMATION_ENV']?.trim() || undefined;
  let bundle;
  try {
    bundle = await resolveEnvBundle({
      ...(envName !== undefined && { envName }),
      projectRoot: process.cwd(),
      dataDir: config.tests.dataDir,
      mutateProcessEnv: true,
    });
  } catch (err) {
    console.error(chalk.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }

  const testFile = path.resolve(target);
  const test = await parseTestFile(testFile, {
    skillsDir: path.resolve(process.cwd(), config.tests.skillsDir),
    ...(envName && {
      envData: { env: bundle.env, data: bundle.data, envName: bundle.envName },
    }),
  });

  const context = await loadContextFiles(config.tests.contextDir);
  const tokenTracker = new TokenTracker();
  const aiClient = new AiClient(config.ai, tokenTracker);

  console.log(chalk.bold(`\nCompile ${path.basename(testFile)}`));

  // The first data row, as `aiui run` would start its first instance.
  const dataRow = await firstDataRow(test, process.cwd());
  if (dataRow) {
    console.log(
      `  ${chalk.cyan('Data'.padEnd(11))} ${test.frontmatter.dataFile}: compiling with row 1 of ${dataRow.of}`,
    );
  }

  let result: CompileResult;
  try {
    result = await compileTest({
      test,
      config,
      contextContent: context.combined,
      aiClient,
      tokenTracker,
      // `$VAR` parameters resolve against the same map `aiui run` would use —
      // the process env with the project's layers merged in above.
      env: bundle.env,
      ...(dataRow && { dataRow: dataRow.row }),
      select,
      ...(opts.maxRounds !== undefined && { maxRounds: opts.maxRounds }),
      ...(opts.dryRun !== undefined && { dryRun: opts.dryRun }),
      onEvent: printEvent,
    });
  } catch (err) {
    logger.error(`Compile failed: ${String(err)}`);
    process.exit(1);
  }

  printSummary(result, Boolean(opts.dryRun));
  process.exit(exitCodeFor(result.status));
}

/**
 * 0 green, 2 partial, 1 failed — so a script can tell "everything compiled"
 * from "some did, and the files are written" from "nothing did"
 * (stories/codebehind-compile-as-a-run.md §Write what passed).
 */
export function exitCodeFor(status: CompileResult['status']): number {
  return status === 'green' ? 0 : status === 'partial' ? 2 : 1;
}

/**
 * `--steps 3-5,8` → [3,4,5,8]. Flags that mean "pick for me" are mutually
 * exclusive with naming steps by hand, and naming wins — an author who typed
 * step numbers meant them.
 */
export function buildSelect(opts: CompileOptions): CompileSelect {
  const select: CompileSelect = {};
  if (opts.onlyStale) select.onlyStale = true;
  if (opts.all) select.all = true;
  if (opts.steps) select.steps = parseStepRange(opts.steps);
  if (opts.maxRounds !== undefined && (!Number.isInteger(opts.maxRounds) || opts.maxRounds < 1)) {
    throw new Error(`--max-rounds must be a positive integer, got "${opts.maxRounds}"`);
  }
  return select;
}

export function parseStepRange(spec: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to < from) throw new Error(`--steps range "${trimmed}" runs backwards`);
      for (let n = from; n <= to; n++) out.add(n);
      continue;
    }
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(`--steps expects numbers or ranges like 3-5, got "${trimmed}"`);
    }
    out.add(Number(trimmed));
  }
  if (out.size === 0) throw new Error('--steps named no steps');
  return [...out].sort((a, b) => a - b);
}

const PHASE_LABEL: Record<string, string> = {
  record: 'Record',
  select: 'Select',
  generate: 'Generate',
  review: 'Review',
  replay: 'Replay',
  repair: 'Repair',
  write: 'Write',
};

function printEvent(event: CompileEvent): void {
  if (event.kind === 'done') return;
  if (event.kind === 'note') {
    console.log(`  ${event.level === 'warn' ? chalk.yellow('[warn]') : chalk.dim('[info]')} ${event.message}`);
    return;
  }
  if (event.kind === 'phase') {
    const label = event.round
      ? `${PHASE_LABEL[event.phase]} ${event.round}`
      : PHASE_LABEL[event.phase] ?? event.phase;
    console.log(`  ${chalk.cyan(label.padEnd(11))} ${event.message}`);
    return;
  }
  console.log(`  ${' '.repeat(11)} ${chalk.dim(`step ${event.step}`)} ${event.message}`);
}

function printSummary(result: CompileResult, dryRun: boolean): void {
  const s = result.summary;
  console.log();
  if (result.status !== 'failed') {
    const written = dryRun
      ? 'nothing written (dry run)'
      : s.written.length === 0
        ? 'nothing to write'
        : s.written.map((f) => path.relative(process.cwd(), f)).join(', ');
    const headline =
      `Compiled ${path.basename(s.test)}: ${s.compiled} of ${s.totalSteps} step(s) as code` +
      (s.keptAi > 0 ? `, ${s.keptAi} kept AI` : '') +
      (s.kept > 0 ? `, ${s.kept} unchanged` : '');
    console.log(result.status === 'green' ? chalk.green(`✓ ${headline}`) : chalk.yellow(`◐ ${headline}`));
    if (s.stoppedAt) {
      console.log(
        chalk.yellow(`  Step ${s.stoppedAt.step} failed under AI — ${s.stoppedAt.error}`) +
          (s.notAttempted.length > 0 ? ` Not attempted: ${listSteps(s.notAttempted)}.` : ''),
      );
      console.log('  Fix that step, run, and compile again for the rest.');
    }
    if (s.writtenOffAi.length > 0) {
      console.log(
        `  Kept AI after replay failures: ${listSteps(s.writtenOffAi)} — ` +
          'fix the cause, then Compile This Step (or --steps) to try again.',
      );
    }
    if (s.unproven.length > 0) {
      console.log(
        `  Unproven: ${listSteps(s.unproven)} — written as code; the next run proves or flags them.`,
      );
    }
    if (result.status === 'partial' && s.error) console.log(`  Reason:   ${s.error}`);
    console.log(`  Written:  ${written}`);
  } else {
    console.log(chalk.red(`✗ Compile failed: ${s.error ?? 'unknown error'}`));
    if (s.candidatePath) {
      console.log(
        `  Candidate left at ${path.relative(process.cwd(), s.candidatePath)} — entries can be salvaged by hand.`,
      );
    }
  }
  console.log(`  Rounds:   ${s.rounds}`);
  console.log(`  Tokens:   ${s.tokensUsed.toLocaleString()}`);
  if (result.status !== 'failed' && dryRun) {
    for (const [file, content] of Object.entries(result.files)) {
      console.log(chalk.bold(`\n--- ${path.relative(process.cwd(), file)} (candidate) ---`));
      console.log(content);
    }
  }
  console.log();
}

/** "steps 6–9", "step 4", "steps 2, 5". */
function listSteps(numbers: number[]): string {
  if (numbers.length === 1) return `step ${numbers[0]}`;
  const sorted = [...numbers].sort((a, b) => a - b);
  const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1]! + 1);
  return contiguous && sorted.length > 1
    ? `steps ${sorted[0]}–${sorted[sorted.length - 1]}`
    : `steps ${sorted.join(', ')}`;
}

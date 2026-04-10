import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Config } from '../config/types.js';
import type { ParsedTest, TestInstance } from '../parser/types.js';
import type { TestReport, StepResult, RunSummary } from '../report/types.js';
import { AiClient } from '../ai/client.js';
import { TokenTracker } from '../utils/tokens.js';
import { launchBrowser, closeBrowser } from '../browser/manager.js';
import { executeStep, executeBranchedStep } from './step-executor.js';
import { identifyStepGroups } from './step-grouper.js';
import { loadContextFiles } from '../context/loader.js';
import { resolveParameters, loadDataFile, interpolate } from '../parser/parameters.js';
import { generateReport } from '../report/generator.js';
import { formatStepHistoryEntry } from '../ai/prompts.js';
import { logger } from '../utils/logger.js';
import { ApiResponseStore } from '../api/response-store.js';
import { StepCache } from '../cache/step-cache.js';

/** Pattern for [input: variable_name] steps that pause for user input */
const INPUT_STEP_PATTERN = /^\[input:\s*(\w+)\]\s*(.*)/;

/** Pattern for [interactive] steps that open a REPL for free-form instructions */
const INTERACTIVE_STEP_PATTERN = /^\[interactive\]\s*(.*)/i;

/** Pattern for [output: variable_name] steps that capture a DOM value into a variable */
const OUTPUT_STEP_PATTERN = /^\[output:\s*(\w+)\]\s*(.*)/i;

/**
 * Check if a step instruction is an input prompt step.
 * Returns the variable name and prompt text if it matches, or null otherwise.
 */
function parseInputStep(instruction: string): { variable: string; promptText: string } | null {
  const match = instruction.match(INPUT_STEP_PATTERN);
  if (!match) return null;
  return { variable: match[1]!, promptText: match[2]?.trim() || `Enter value for "${match[1]}"` };
}

/**
 * Check if a step instruction is an interactive prompt step.
 * Returns the optional hint text if it matches, or null otherwise.
 */
function parseInteractiveStep(instruction: string): { hint: string } | null {
  const match = instruction.match(INTERACTIVE_STEP_PATTERN);
  if (!match) return null;
  return { hint: match[1]?.trim() || '' };
}

/**
 * Check if a step instruction is an output capture step.
 * Returns the variable name and the instruction text (with variable hint appended) if it matches.
 */
function parseOutputStep(instruction: string): { variable: string; enrichedInstruction: string } | null {
  const match = instruction.match(OUTPUT_STEP_PATTERN);
  if (!match) return null;
  const variable = match[1]!;
  const text = match[2]?.trim() || `Capture value into "${variable}"`;
  return {
    variable,
    enrichedInstruction: `${text} [store as: ${variable}]`,
  };
}

/** Prompt the user for a value during test execution */
async function promptUserForInput(promptText: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    console.log(`\n🔑 User input required:`);
    const answer = await rl.question(`  ${promptText}: `);
    return answer.trim();
  } finally {
    rl.close();
  }
}

/** Prompt the user for a free-form instruction in interactive mode */
async function promptInteractive(hint: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    if (hint) {
      console.log(`\n🎮 Interactive mode — ${hint}`);
    } else {
      console.log(`\n🎮 Interactive mode — type instructions to execute, "done" to continue`);
    }
    const answer = await rl.question(`  > `);
    return answer.trim();
  } finally {
    rl.close();
  }
}

/**
 * Run a single test instance (ParsedTest with resolved parameters).
 * Handles browser lifecycle, step execution, and report generation.
 */
export async function runTest(
  instance: TestInstance,
  config: Config,
  contextContent: string,
): Promise<TestReport> {
  const { test, resolvedParameters, dataRowIndex } = instance;
  const startTime = Date.now();

  logger.testStart(
    dataRowIndex !== undefined
      ? `${test.title} (row ${dataRowIndex + 1})`
      : test.title,
  );

  const tokenTracker = new TokenTracker();
  const aiClient = new AiClient(config.ai, tokenTracker);
  const apiResponseStore = new ApiResponseStore();

  const baseUrl = test.config.baseUrl;
  const conversationHistory: string[] = [];
  const csrfTokens: Record<string, string> = {};

  // Initialize step cache if enabled
  const stepCache = config.cache.enabled
    ? await StepCache.initialize(config.cache.dir, test.title, test.steps)
    : undefined;

  // Determine timeout: frontmatter > config section > global default
  const testTimeout = parseTimeoutMs(test.frontmatter.timeout ?? test.config.timeout)
    ?? config.execution.timeout;

  const session = await launchBrowser(config.browser);

  try {
    // Navigate to base URL if provided
    if (baseUrl) {
      logger.info(`Navigating to base URL: ${baseUrl}`);
      await session.page.goto(baseUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
    }

    const stepResults = [];
    let timeoutDeadline = Date.now() + testTimeout;
    let bail = false;

    // Detect conditional step groups for multi-outcome branching
    const stepGroups = identifyStepGroups(test.steps);

    for (let i = 0; i < test.steps.length; i++) {
      if (bail) break;

      if (Date.now() > timeoutDeadline) {
        logger.error(`Test timeout after ${testTimeout}ms at step ${i + 1}`);
        break;
      }

      // Check if this step is part of a conditional group
      const group = stepGroups.get(i);
      if (group && i === group.conditionalSteps[0]!.index) {
        // Start of a conditional group — execute as branched step
        logger.info(`Conditional group detected at step ${i + 1}: ${group.conditionalSteps.length} conditional + 1 continuation`);

        const branchedResults = await executeBranchedStep(group, test.steps.length, {
          page: session.page,
          config,
          aiClient,
          contextContent,
          testName: test.title,
          ...(baseUrl !== undefined && { baseUrl }),
          conversationHistory: [...conversationHistory],
          apiResponseStore,
          csrfTokens,
          resolvedParameters,
          pageTracker: session.pageTracker,
          ...(stepCache !== undefined && { stepCache }),
        });

        for (const result of branchedResults) {
          stepResults.push(result);
          const url = session.page.url();
          conversationHistory.push(
            formatStepHistoryEntry(result.index, result.instruction, result.status === 'passed', url),
          );

          if (result.status === 'failed') {
            logger.error(`Step ${result.index} FAILED: ${result.error ?? 'unknown error'}`);
            bail = true;
          } else if (result.status === 'skipped') {
            logger.info(`Step ${result.index} skipped (conditional not matched)`);
          } else {
            logger.success(`Step ${result.index} passed`);
          }
        }

        // Skip past all steps in this group (they've been handled)
        i = group.continuationStep.index;
        tokenTracker.resetStep();
        continue;
      }

      if (group && i !== group.conditionalSteps[0]!.index) {
        // This step is part of a group but not the first — already handled
        continue;
      }

      const rawInstruction = test.steps[i] ?? '';
      // Interpolate {{placeholders}} in step text
      const instruction = interpolate(rawInstruction, resolvedParameters);

      logger.step(i + 1, test.steps.length, instruction);

      // Handle [input: variable_name] steps — pause for user input
      const inputStep = parseInputStep(instruction);
      const interactiveStep = !inputStep ? parseInteractiveStep(instruction) : null;
      const outputStep = !inputStep && !interactiveStep ? parseOutputStep(instruction) : null;
      let stepResult: StepResult;

      if (inputStep) {
        const stepStartTime = Date.now();
        const value = await promptUserForInput(inputStep.promptText);
        resolvedParameters[inputStep.variable] = value;
        logger.info(`Stored user input as parameter "{{${inputStep.variable}}}"`);

        // Don't count user input time against the test timeout
        const inputDuration = Date.now() - stepStartTime;
        timeoutDeadline += inputDuration;

        stepResult = {
          index: i + 1,
          instruction,
          status: 'passed',
          turns: [],
          durationMs: inputDuration,
          retried: false,
          aiExplanation: `User provided input for "${inputStep.variable}"`,
        };
      } else if (interactiveStep) {
        // Interactive REPL — user types instructions that execute as AI steps
        const stepStartTime = Date.now();
        const interactiveResults: StepResult[] = [];
        let interactiveIndex = 1;

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const userInstruction = await promptInteractive(interactiveStep.hint);
          if (!userInstruction || userInstruction.toLowerCase() === 'done') break;

          logger.step(i + 1, test.steps.length, `(interactive ${interactiveIndex}) ${userInstruction}`);

          const result = await executeStep(i + 1, test.steps.length, userInstruction, {
            page: session.page,
            config,
            aiClient,
            contextContent,
            testName: test.title,
            ...(baseUrl !== undefined && { baseUrl }),
            conversationHistory: [...conversationHistory],
            apiResponseStore,
            csrfTokens,
            pageTracker: session.pageTracker,
            // No stepCache — interactive commands are ad-hoc user instructions,
            // not cacheable steps (and they all share the same stepIndex)
          });

          interactiveResults.push(result);

          // Add to conversation history so subsequent interactive commands have context
          const currentUrl = session.page.url();
          conversationHistory.push(
            formatStepHistoryEntry(
              i + 1,
              `(interactive) ${userInstruction}`,
              result.status === 'passed',
              currentUrl,
            ),
          );

          if (result.status === 'passed') {
            logger.success(`Interactive command passed`);
          } else {
            logger.error(`Interactive command failed: ${result.error ?? 'unknown error'}`);
          }

          interactiveIndex++;
        }

        const anyFailed = interactiveResults.some((r) => r.status === 'failed');
        const allTurns = interactiveResults.flatMap((r) => r.turns);

        stepResult = {
          index: i + 1,
          instruction,
          status: anyFailed ? 'failed' : 'passed',
          turns: allTurns,
          durationMs: Date.now() - stepStartTime,
          retried: false,
          aiExplanation: `Interactive mode: executed ${interactiveResults.length} command(s)`,
          ...(anyFailed && { error: 'One or more interactive commands failed' }),
        };
      } else if (outputStep) {
        stepResult = await executeStep(i + 1, test.steps.length, outputStep.enrichedInstruction, {
          page: session.page,
          config,
          aiClient,
          contextContent,
          testName: test.title,
          ...(baseUrl !== undefined && { baseUrl }),
          conversationHistory: [...conversationHistory],
          apiResponseStore,
          csrfTokens,
          resolvedParameters,
          pageTracker: session.pageTracker,
          ...(stepCache !== undefined && { stepCache }),
        });
        if (stepResult.status === 'passed') {
          logger.info(`[output: ${outputStep.variable}] = "${resolvedParameters[outputStep.variable] ?? '(not captured)'}"`);
        }
      } else {
        stepResult = await executeStep(i + 1, test.steps.length, instruction, {
          page: session.page,
          config,
          aiClient,
          contextContent,
          testName: test.title,
          ...(baseUrl !== undefined && { baseUrl }),
          conversationHistory: [...conversationHistory],
          apiResponseStore,
          csrfTokens,
          resolvedParameters,
          pageTracker: session.pageTracker,
          ...(stepCache !== undefined && { stepCache }),
        });
      }

      stepResults.push(stepResult);

      // Add to conversation history (text summary only)
      const currentUrl = session.page.url();
      conversationHistory.push(
        formatStepHistoryEntry(
          i + 1,
          instruction,
          stepResult.status === 'passed',
          currentUrl,
        ),
      );

      if (stepResult.status === 'failed') {
        logger.error(`Step ${i + 1} FAILED: ${stepResult.error ?? 'unknown error'}`);
        bail = true;
      } else {
        logger.success(`Step ${i + 1} passed`);
      }

      tokenTracker.resetStep();
    }

    const durationMs = Date.now() - startTime;
    const passedSteps = stepResults.filter((s) => s.status === 'passed').length;
    const failedSteps = stepResults.filter((s) => s.status === 'failed').length;
    const totalSubActions = stepResults.reduce((sum, s) => sum + s.turns.reduce((tSum, t) => tSum + t.subActions.length, 0), 0);
    const timedOut = stepResults.length < test.steps.length && !bail;
    const overallStatus = failedSteps > 0 || timedOut ? 'failed' : 'passed';

    logger.testEnd(test.title, overallStatus === 'passed', durationMs);
    logger.info(`Tokens used: ${tokenTracker.getSummary()}`);

    const dataRowVal = dataRowIndex !== undefined ? dataRowIndex + 1 : undefined;
    const report: TestReport = {
      testName: test.title,
      filePath: test.filePath,
      tags: test.frontmatter.tags,
      status: overallStatus,
      steps: stepResults,
      totalSteps: test.steps.length,
      passedSteps,
      failedSteps,
      totalSubActions,
      durationMs,
      tokensUsed: tokenTracker.total,
      inputTokens: tokenTracker.inputTotal,
      outputTokens: tokenTracker.outputTotal,
      date: new Date().toISOString(),
      ...(baseUrl !== undefined && { baseUrl }),
      ...(Object.keys(resolvedParameters).length > 0 && { parameters: resolvedParameters }),
      ...(dataRowVal !== undefined && { dataRow: dataRowVal }),
    };

    return report;
  } finally {
    await closeBrowser(session);
  }
}

/**
 * Expand a ParsedTest into one or more TestInstances.
 * Data-driven tests (with dataFile) produce one instance per data row.
 */
export async function expandTestInstances(
  test: ParsedTest,
  config: Config,
): Promise<TestInstance[]> {
  const projectRoot = process.cwd();

  // Load data file rows if specified
  let dataRows: Array<Record<string, string>> | undefined;
  if (test.frontmatter.dataFile) {
    const dataFilePath = test.frontmatter.dataFile;
    dataRows = await loadDataFile(dataFilePath, projectRoot);
    logger.info(`Data file: ${dataFilePath} (${dataRows.length} rows)`);
  }

  if (dataRows && dataRows.length > 0) {
    // Create one instance per data row
    return Promise.all(
      dataRows.map(async (row, index) => {
        const resolvedParameters = await resolveParameters(
          test.parameters,
          row,
          false, // Don't prompt user during data-driven expansion
        );
        return {
          test,
          dataRowIndex: index,
          resolvedParameters,
        };
      }),
    );
  }

  // Single instance
  const resolvedParameters = await resolveParameters(test.parameters, undefined, true);
  return [{ test, resolvedParameters }];
}

/**
 * Run multiple tests and produce a summary.
 * Respects the --bail flag by stopping on the first failure.
 */
export async function runTests(
  tests: ParsedTest[],
  config: Config,
  options: { bail?: boolean; verbose?: boolean } = {},
): Promise<RunSummary> {
  const context = await loadContextFiles(config.tests.contextDir);

  if (context.files.length > 0) {
    logger.info(`Loaded ${context.files.length} context file(s)`);
  }

  const reports: TestReport[] = [];
  let bailed = false;

  for (const test of tests) {
    if (bailed) break;

    const instances = await expandTestInstances(test, config);

    for (const instance of instances) {
      if (bailed) break;

      const report = await runTest(instance, config, context.combined);
      reports.push(report);

      // Save HTML report
      const reportPath = await generateReport(report, config.reports.outputDir);
      logger.info(`Report saved: ${path.relative(process.cwd(), reportPath)}`);

      if (report.status === 'failed' && options.bail) {
        logger.warn('Bailing on first failure (--bail flag set)');
        bailed = true;
      }
    }
  }

  const totalTests = reports.length;
  const passedTests = reports.filter((r) => r.status === 'passed').length;
  const failedTests = reports.filter((r) => r.status === 'failed').length;
  const totalDurationMs = reports.reduce((sum, r) => sum + r.durationMs, 0);
  const totalTokensUsed = reports.reduce((sum, r) => sum + r.tokensUsed, 0);
  const totalInputTokens = reports.reduce((sum, r) => sum + r.inputTokens, 0);
  const totalOutputTokens = reports.reduce((sum, r) => sum + r.outputTokens, 0);

  return {
    totalTests,
    passedTests,
    failedTests,
    totalDurationMs,
    totalTokensUsed,
    totalInputTokens,
    totalOutputTokens,
    reports,
  };
}

/**
 * Filter a list of parsed tests by required tags.
 * All specified tags must match (AND logic).
 */
export function filterByTags(tests: ParsedTest[], tags: string[]): ParsedTest[] {
  if (tags.length === 0) return tests;
  return tests.filter((test) =>
    tags.every((tag) => test.frontmatter.tags.includes(tag)),
  );
}

/** Parse a timeout string like "60s" or "2m" into milliseconds */
export function parseTimeoutMs(timeout?: string): number | undefined {
  if (!timeout) return undefined;

  const match = timeout.match(/^(\d+(?:\.\d+)?)\s*(s|m|ms)?$/i);
  if (!match) return undefined;

  const value = parseFloat(match[1] ?? '0');
  const unit = (match[2] ?? 'ms').toLowerCase();

  switch (unit) {
    case 's': return Math.round(value * 1_000);
    case 'm': return Math.round(value * 60_000);
    case 'ms':
    default: return Math.round(value);
  }
}

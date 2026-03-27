import path from 'node:path';
import type { Config } from '../config/types.js';
import type { ParsedTest, TestInstance } from '../parser/types.js';
import type { TestReport, RunSummary } from '../report/types.js';
import { AiClient } from '../ai/client.js';
import { TokenTracker } from '../utils/tokens.js';
import { launchBrowser, closeBrowser } from '../browser/manager.js';
import { executeStep } from './step-executor.js';
import { loadContextFiles } from '../context/loader.js';
import { resolveParameters, loadDataFile, interpolate } from '../parser/parameters.js';
import { generateReport } from '../report/generator.js';
import { formatStepHistoryEntry } from '../ai/prompts.js';
import { logger } from '../utils/logger.js';
import { ApiResponseStore } from '../api/response-store.js';

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
    const timeoutDeadline = Date.now() + testTimeout;
    let bail = false;

    for (let i = 0; i < test.steps.length; i++) {
      if (bail) break;

      if (Date.now() > timeoutDeadline) {
        logger.error(`Test timeout after ${testTimeout}ms at step ${i + 1}`);
        break;
      }

      const rawInstruction = test.steps[i] ?? '';
      // Interpolate {{placeholders}} in step text
      const instruction = interpolate(rawInstruction, resolvedParameters);

      logger.step(i + 1, test.steps.length, instruction);

      const stepResult = await executeStep(i + 1, test.steps.length, instruction, {
        page: session.page,
        config,
        aiClient,
        contextContent,
        testName: test.title,
        ...(baseUrl !== undefined && { baseUrl }),
        conversationHistory: [...conversationHistory],
        apiResponseStore,
      });

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
    const totalSubActions = stepResults.reduce((sum, s) => sum + s.subActions.length, 0);
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

import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';
import type { Config } from '../config/types.js';
import type { ParsedTest, TestConfig, TestInstance } from '../parser/types.js';
import type { TestReport, StepResult, RunSummary } from '../report/types.js';
import { AiClient } from '../ai/client.js';
import { TokenTracker } from '../utils/tokens.js';
import { launchBrowser, closeBrowser, type CdpLaunchOptions } from '../browser/manager.js';
import { executeStep, executeBranchedStep } from './step-executor.js';
import type { StepExecutorOptions } from './step-executor.js';
import { identifyStepGroups } from './step-grouper.js';
import { resolveHooks, type ResolvedHooks } from './hooks.js';
import { runInteractiveRepl } from './interactive-repl.js';
import { loadContextFiles } from '../context/loader.js';
import { resolveParameters, loadDataFile, interpolate } from '../parser/parameters.js';
import { generateReport, getPrimaryModel } from '../report/generator.js';
import { appendRunHistory } from '../report/history-appender.js';
import { formatStepHistoryEntry } from '../ai/prompts.js';
import { diagnoseFailure } from '../ai/diagnose.js';
import { logger, setLogLevel, getLogLevel, type ConsoleLogLevel } from '../utils/logger.js';
import { openRunLogFile, attachRunLogBridges } from '../utils/run-log.js';
import { ApiResponseStore } from '../api/response-store.js';
import { StepCache } from '../cache/step-cache.js';
import { loadToolCatalogue, ToolCatalogue } from '../tools/registry.js';
import { executeToolStep } from '../tools/executor.js';
import type { ToolCall } from '../tools/types.js';

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

/**
 * Read `cdp:` and `cdpTab:` from a test's `## Config` block. Returns
 * `undefined` (the launchBrowser default) when CDP is not requested. Throws
 * with a clear error if the port value is malformed — better to fail fast
 * here than after the browser has been touched.
 */
function parseCdpOptionsFromTestConfig(testConfig: TestConfig): CdpLaunchOptions | undefined {
  const raw = testConfig.cdp?.trim();
  if (!raw) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(
      `Invalid '## Config: cdp: ${raw}' — expected a TCP port number ` +
      `(e.g. \`cdp: 9222\` to attach to Chrome started with --remote-debugging-port=9222).`,
    );
  }
  const tab = testConfig.cdpTab?.trim();
  return tab ? { port, tab } : { port };
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

  // Always initialize cache — used for assertion code even when action caching is off.
  // StepCache.initialize is idempotent (creates dir, writes meta). The stepCache
  // reference is passed to all steps; action caching is further gated by config.cache.enabled.
  const stepCache = await StepCache.initialize(config.cache.dir, test.title, test.steps);

  // Determine timeout: frontmatter > config section > global default
  const testTimeout = parseTimeoutMs(test.frontmatter.timeout ?? test.config.timeout)
    ?? config.execution.timeout;

  const hooks = await resolveHooks(test, config);

  // Per-test logging overrides from the test's `## Config` block. The block
  // can carry `consoleLogLevel:` and `serverFileLogLevel:` keys; either falls
  // back to the global `config.logging.*` when absent or invalid. Validated
  // against the same allow-lists the CLI / server use elsewhere.
  const VALID_LEVELS: readonly ConsoleLogLevel[] = ['silent', 'error', 'warn', 'info', 'debug'];
  const VALID_FILES: readonly Config['logging']['serverFileLogLevel'][] = ['off', 'compact', 'full'];
  const testLevel = test.config.consoleLogLevel?.trim();
  const testFile = test.config.serverFileLogLevel?.trim();
  const effectiveLevel: ConsoleLogLevel =
    (testLevel && VALID_LEVELS.includes(testLevel as ConsoleLogLevel))
      ? (testLevel as ConsoleLogLevel)
      : config.logging.consoleLogLevel;
  const fileMode: Config['logging']['serverFileLogLevel'] =
    (testFile && VALID_FILES.includes(testFile as Config['logging']['serverFileLogLevel']))
      ? (testFile as Config['logging']['serverFileLogLevel'])
      : config.logging.serverFileLogLevel;
  if (testLevel && !VALID_LEVELS.includes(testLevel as ConsoleLogLevel)) {
    logger.warn(`Ignoring invalid '## Config: consoleLogLevel: ${testLevel}' — expected one of: ${VALID_LEVELS.join(', ')}`);
  }
  if (testFile && !VALID_FILES.includes(testFile as Config['logging']['serverFileLogLevel'])) {
    logger.warn(`Ignoring invalid '## Config: serverFileLogLevel: ${testFile}' — expected one of: ${VALID_FILES.join(', ')}`);
  }
  const previousLevel = getLogLevel();
  setLogLevel(effectiveLevel);

  // Per-run log file. Mirrors the server-side path (SessionManager) so a
  // direct CLI run leaves the same forensic trail under `<reportsDir>/logs/`.
  // failures to open are swallowed and never break the run.
  const runLog = fileMode === 'off'
    ? null
    : openRunLogFile(test.title, config.reports.outputDir);
  if (runLog) {
    runLog.stream.write(
      `# test=${test.title} startedAt=${new Date().toISOString()} steps=${test.steps.length} mode=${fileMode}\n`,
    );
    logger.info(`Run log: ${runLog.path}`);
  }
  const removeFileBridges = runLog
    ? attachRunLogBridges(runLog, fileMode)
    : () => {};

  const cdpOptions = parseCdpOptionsFromTestConfig(test.config);
  const session = await launchBrowser(config.browser, cdpOptions);

  // Load the tool catalogue once per test. Node caches dynamic imports so
  // subsequent loads are cheap; failures are surfaced as a fatal startup
  // error so a misconfigured tools/ dir doesn't silently degrade tool calls
  // into "tool not found" runtime errors.
  let toolCatalogue: ToolCatalogue;
  try {
    const toolsDir = path.resolve(process.cwd(), config.tests.toolsDir);
    toolCatalogue = await loadToolCatalogue(toolsDir);
  } catch (err) {
    logger.error(`Failed to load tool catalogue: ${(err as Error).message}`);
    throw err;
  }

  try {
    // Navigate to base URL if provided
    if (baseUrl) {
      logger.info(`Navigating to base URL: ${baseUrl}`);
      await session.page.goto(baseUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
    }

    const stepResults: StepResult[] = [];
    let timeoutDeadline = Date.now() + testTimeout;
    let bail = false;
    let humanIntervened = false;

    /**
     * Run a `[tool: ...]` invocation and shape the outcome as a StepResult.
     * Used for tool-step dispatch in both the main step loop and inside
     * hook scopes so the dispatch path is identical everywhere.
     */
    const runToolStep = async (
      call: ToolCall,
      instruction: string,
      stepIndex: number,
    ): Promise<StepResult> => {
      const startedAt = Date.now();
      const activePage = session.pageTracker.getActive();
      const outcome = await executeToolStep(call, {
        page: activePage,
        context: session.context,
        browser: session.browser,
        resolvedParameters,
        catalogue: toolCatalogue,
      });
      const passed = outcome.status === 'passed';
      if (passed) {
        logger.success(`[tool: ${call.name}] passed in ${outcome.durationMs}ms`);
      } else {
        logger.error(`[tool: ${call.name}] failed: ${outcome.error ?? 'unknown error'}`);
      }
      return {
        index: stepIndex,
        instruction,
        status: passed ? 'passed' : 'failed',
        turns: [],
        durationMs: Date.now() - startedAt,
        retried: false,
        ...(outcome.error !== undefined && { error: outcome.error }),
        aiExplanation: passed
          ? `Tool "${call.name}" produced outputs: ${
              Object.keys(outcome.outputs).length
                ? Object.entries(outcome.outputs)
                    .map(([k, v]) => `${k}="${v}"`)
                    .join(', ')
                : '(none)'
            }`
          : `Tool "${call.name}" failed`,
        toolStep: {
          name: outcome.toolName,
          args: outcome.args,
          outputs: outcome.outputs,
          logs: outcome.logs,
        },
      };
    };

    /** Execute every hook instruction in a scope. Returns true on first failure. */
    const runHookScope = async (
      scope: 'before' | 'beforeEach' | 'afterEach' | 'after',
      instructions: string[],
      toolCalls: (ToolCall | null)[],
      sourceSkills: (string | null)[],
      hookIndex: number,
    ): Promise<{ failed: boolean; error?: string }> => {
      for (let idx = 0; idx < instructions.length; idx++) {
        const raw = instructions[idx]!;
        const toolCall = toolCalls[idx] ?? null;
        const sourceSkill = sourceSkills[idx] ?? null;
        const hookInstruction = interpolate(raw, resolvedParameters);

        let result: StepResult;
        if (toolCall) {
          logger.info(`Running ${scope} hook (tool): ${hookInstruction}`);
          result = await runToolStep(toolCall, hookInstruction, hookIndex);
        } else {
          logger.info(`Running ${scope} hook: ${hookInstruction}`);
          result = await executeStep(hookIndex, test.steps.length, hookInstruction, {
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
            dismissalGuidance: hooks.hasAny,
            // No stepCache — hook results are usually page-state-dependent
            // (e.g., "accept cookie banner if visible") and shouldn't be replayed blindly.
          });
        }

        result.hookScope = scope;
        if (sourceSkill) result.sourceSkill = sourceSkill;
        stepResults.push(result);
        tokenTracker.resetStep();

        // `before` hooks inform the AI's context for later steps; per-step
        // hooks are plumbing and would just pollute the conversation history.
        if (scope === 'before') {
          conversationHistory.push(
            formatStepHistoryEntry(
              hookIndex,
              `(${scope} hook) ${hookInstruction}`,
              result.status === 'passed',
              session.page.url(),
            ),
          );
        }

        if (result.status === 'failed') {
          return {
            failed: true,
            error: result.error ?? `${scope} hook failed`,
          };
        }
      }
      return { failed: false };
    };

    // Run `before` hooks (once per test, before any step runs)
    if (hooks.before.length > 0) {
      const beforeResult = await runHookScope(
        'before',
        hooks.before,
        hooks.toolCalls.before,
        hooks.sourceSkills.before,
        0,
      );
      if (beforeResult.failed) {
        logger.error(`'before' hook failed — aborting test: ${beforeResult.error}`);
        bail = true;
      }
    }

    // Detect conditional step groups for multi-outcome branching
    const stepGroups = identifyStepGroups(test.steps);

    for (let i = 0; i < test.steps.length; i++) {
      if (bail) break;

      if (Date.now() > timeoutDeadline) {
        logger.error(`Test timeout after ${testTimeout}ms at step ${i + 1}`);
        break;
      }

      const stepSkipsHooks = test.skipHooks[i] ?? false;

      // Run `beforeEach` hooks (skipped when the step is marked [no-hooks])
      if (hooks.beforeEach.length > 0 && !stepSkipsHooks) {
        const preResult = await runHookScope(
          'beforeEach',
          hooks.beforeEach,
          hooks.toolCalls.beforeEach,
          hooks.sourceSkills.beforeEach,
          i + 1,
        );
        if (preResult.failed) {
          logger.error(`'beforeEach' hook before step ${i + 1} failed — aborting test: ${preResult.error}`);
          bail = true;
          break;
        }
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
          stepCache,
          cacheEnabled: config.cache.enabled,
          dismissalGuidance: hooks.hasAny,
        });

        for (const result of branchedResults) {
          // Tag with originating skill if any (result.index is 1-based).
          const branchSourceSkill = test.sourceSkills[result.index - 1] ?? null;
          if (branchSourceSkill) result.sourceSkill = branchSourceSkill;
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
      let interactiveResults: StepResult[] = [];

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
        // Planned interactive step — hand off to the unified REPL.
        const stepStartTime = Date.now();
        humanIntervened = true;

        const adHocResults: StepResult[] = [];
        const decision = await runInteractiveRepl({
          page: session.page,
          testSteps: test.steps,
          currentStepIndex: i + 1,
          entryReason: 'planned',
          ...(interactiveStep.hint && { hint: interactiveStep.hint }),
          executorOptions: {
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
            dismissalGuidance: hooks.hasAny,
          },
          adHocResults,
        });

        // Re-shape the ad-hoc results so the report renderer can group them
        // under the [interactive] banner and number them as Step N.M.
        let childIdx = 1;
        for (const ad of adHocResults) {
          // Skip /screenshot synthetic rows from the interactive-child grouping —
          // they keep their `interactiveAdHoc` flag and render as standalone entries.
          if (ad.instruction === '[interactive: screenshot]') continue;
          ad.instruction = `(interactive ${childIdx}) ${ad.instruction}`;
          ad.interactiveChild = true;
          conversationHistory.push(
            formatStepHistoryEntry(
              i + 1,
              ad.instruction,
              ad.status === 'passed',
              session.page.url(),
            ),
          );
          childIdx++;
        }
        interactiveResults = adHocResults;

        const anyFailed = interactiveResults.some((r) => r.status === 'failed');
        const allTurns = interactiveResults.flatMap((r) => r.turns);

        const explanation =
          decision.kind === 'exit'
            ? `Interactive mode: user exited after ${interactiveResults.length} command(s)`
            : decision.kind === 'resume'
              ? `Interactive mode: user resumed at step ${decision.fromStepIndex} after ${interactiveResults.length} command(s)`
              : `Interactive mode: executed ${interactiveResults.length} command(s)`;

        stepResult = {
          index: i + 1,
          instruction,
          status: anyFailed ? 'failed' : 'passed',
          turns: allTurns,
          durationMs: Date.now() - stepStartTime,
          retried: false,
          aiExplanation: explanation,
          ...(anyFailed && { error: 'One or more interactive commands failed' }),
          ...(decision.kind === 'resume' && { interactiveResumed: true }),
        };

        if (decision.kind === 'exit') {
          logger.info('Interactive mode: user exited — stopping test and generating report');
          bail = true;
        } else if (decision.kind === 'resume') {
          // Push the parent + children before jumping so the report stays in order.
          stepResults.push(stepResult);
          stepResults.push(...interactiveResults);
          conversationHistory.push(
            formatStepHistoryEntry(
              i + 1,
              instruction,
              stepResult.status === 'passed',
              session.page.url(),
            ),
          );
          conversationHistory.push(
            `[interactive] user resumed test at step ${decision.fromStepIndex}`,
          );
          // Refresh the timeout — debugging shouldn't be billed against the test.
          timeoutDeadline = Date.now() + testTimeout;
          // Pre-decrement so the loop's `i++` lands on the chosen index.
          i = decision.fromStepIndex - 2;
          tokenTracker.resetStep();
          continue;
        }
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
          stepCache,
          cacheEnabled: config.cache.enabled,
          dismissalGuidance: hooks.hasAny,
          testSteps: test.steps,
        });
        if (stepResult.status === 'passed') {
          logger.info(`[output: ${outputStep.variable}] = "${resolvedParameters[outputStep.variable] ?? '(not captured)'}"`);
        }
      } else if (test.toolCalls[i]) {
        // [tool: ...] step — dispatch deterministic code with live page/context/browser.
        // Same path the hook executor uses; see runToolStep above.
        stepResult = await runToolStep(test.toolCalls[i]!, instruction, i + 1);
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
          stepCache,
          cacheEnabled: config.cache.enabled,
          dismissalGuidance: hooks.hasAny,
          testSteps: test.steps,
        });
      }

      // Tag the step with its originating skill (if any) so the report can
      // show a "from skill X" chip even after parse-time expansion has
      // flattened the call.
      const stepSourceSkill = test.sourceSkills[i] ?? null;
      if (stepSourceSkill) stepResult.sourceSkill = stepSourceSkill;

      stepResults.push(stepResult);
      if (interactiveStep) {
        stepResults.push(...interactiveResults);
      }

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

      // ── runnerControl from the AI clarification REPL ───────────────────────
      // The user took control inside the clarification prompt (typed /repl,
      // then /resume or /exit). Honour that BEFORE the failure-handoff path —
      // a /exit must be final, not re-trigger the failure REPL on top.
      if (stepResult.runnerControl) {
        humanIntervened = true;
        if (stepResult.runnerControl.adHocResults) {
          stepResults.push(...stepResult.runnerControl.adHocResults);
          for (const ad of stepResult.runnerControl.adHocResults) {
            conversationHistory.push(
              formatStepHistoryEntry(
                ad.index,
                `(interactive) ${ad.instruction}`,
                ad.status === 'passed',
                session.page.url(),
              ),
            );
          }
        }
        if (stepResult.runnerControl.kind === 'resume') {
          conversationHistory.push(
            `[interactive] user resumed test at step ${stepResult.runnerControl.fromStepIndex} from clarification REPL`,
          );
          timeoutDeadline = Date.now() + testTimeout;
          i = stepResult.runnerControl.fromStepIndex - 2;
          tokenTracker.resetStep();
          continue;
        }
        // kind === 'exit' — user chose to abort. Don't drop into the failure REPL.
        bail = true;
        continue;
      }

      if (stepResult.status === 'failed') {
        logger.error(`Step ${i + 1} FAILED: ${stepResult.error ?? 'unknown error'}`);

        const canEnterRepl =
          config.execution.interactiveOnFailure &&
          config.browser.headed &&
          Boolean(process.stdout.isTTY);

        if (canEnterRepl) {
          humanIntervened = true;
          const executorOptions: StepExecutorOptions = {
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
            dismissalGuidance: hooks.hasAny,
          };
          const adHocResults: StepResult[] = [];
          const decision = await runInteractiveRepl({
            page: session.page,
            testSteps: test.steps,
            currentStepIndex: i + 1,
            entryReason: 'failure',
            executorOptions,
            adHocResults,
          });

          stepResults.push(...adHocResults);
          for (const ad of adHocResults) {
            conversationHistory.push(
              formatStepHistoryEntry(
                ad.index,
                `(interactive) ${ad.instruction}`,
                ad.status === 'passed',
                session.page.url(),
              ),
            );
          }

          if (decision.kind === 'resume') {
            stepResult.interactiveResumed = true;
            conversationHistory.push(
              `[interactive] user resumed test at step ${decision.fromStepIndex}`,
            );
            // Extend the test timeout so the user's debugging time isn't billed against it
            timeoutDeadline = Date.now() + testTimeout;
            // Pre-decrement so the next `i++` lands on the chosen index
            i = decision.fromStepIndex - 2;
            tokenTracker.resetStep();
            continue;
          }

          if (decision.kind === 'continue') {
            // User chose to leave the failed step as failed and proceed with
            // the next step anyway. Don't bail — fall through to the normal loop.
            conversationHistory.push(
              `[interactive] user continued past failed step ${i + 1}`,
            );
            timeoutDeadline = Date.now() + testTimeout;
          } else {
            // /exit — abort the run.
            bail = true;
          }
        } else {
          bail = true;
        }
      } else {
        logger.success(`Step ${i + 1} passed`);
      }

      // Run `afterEach` hooks — skipped on [no-hooks] steps or if the step
      // bailed (we're about to abort anyway).
      if (!bail && hooks.afterEach.length > 0 && !stepSkipsHooks) {
        const postResult = await runHookScope(
          'afterEach',
          hooks.afterEach,
          hooks.toolCalls.afterEach,
          hooks.sourceSkills.afterEach,
          i + 1,
        );
        if (postResult.failed) {
          logger.error(`'afterEach' hook after step ${i + 1} failed — aborting test: ${postResult.error}`);
          bail = true;
        }
      }

      tokenTracker.resetStep();
    }

    // Run `after` hooks — best effort, failures logged but don't flip test status.
    if (hooks.after.length > 0) {
      const afterResult = await runHookScope(
        'after',
        hooks.after,
        hooks.toolCalls.after,
        hooks.sourceSkills.after,
        test.steps.length + 1,
      );
      if (afterResult.failed) {
        logger.warn(`'after' hook failed (test status unchanged): ${afterResult.error}`);
      }
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
      ...(humanIntervened && { humanIntervened: true }),
    };

    if (overallStatus === 'failed' && config.ai.diagnoseFailures) {
      logger.info('Running failure diagnosis…');
      const diagnosis = await diagnoseFailure(report, session.page, aiClient, contextContent, {
        ...config.browser.domNoiseReduction,
        maxIframeDepth: config.browser.maxIframeDepth,
        domSnapshotCharLimit: config.browser.domSnapshotCharLimit,
      });
      if (diagnosis) {
        report.diagnosis = diagnosis;
        report.tokensUsed = tokenTracker.total;
        report.inputTokens = tokenTracker.inputTotal;
        report.outputTokens = tokenTracker.outputTotal;
        logger.info(`Likely cause (${diagnosis.faultCategory}, ${diagnosis.confidence} confidence): ${diagnosis.rootCause}`);
      }
    }

    return report;
  } finally {
    await closeBrowser(session);
    removeFileBridges();
    setLogLevel(previousLevel);
    if (runLog) {
      runLog.stream.write(`# endedAt=${new Date().toISOString()}\n`);
      runLog.dispose();
    }
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
  let lastReportPath: string | undefined;

  for (const test of tests) {
    if (bailed) break;

    const instances = await expandTestInstances(test, config);

    for (const instance of instances) {
      if (bailed) break;

      const report = await runTest(instance, config, context.combined);
      reports.push(report);

      // Save HTML report
      const reportPath = await generateReport(report, config.reports.outputDir);
      lastReportPath = reportPath;
      logger.info(`Report saved: ${path.relative(process.cwd(), reportPath)}`);

      if (config.reports.appendRunHistoryToTestFile) {
        await appendRunHistory(instance.test.filePath, reportPath, report.status, report.date, getPrimaryModel(report));
      }

      if (report.status === 'failed' && options.bail) {
        logger.warn('Bailing on first failure (--bail flag set)');
        bailed = true;
      }
    }
  }

  if (lastReportPath && config.reports.openInBrowserAfterRun && !process.env['CI']) {
    openInDefaultBrowser(lastReportPath);
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

function openInDefaultBrowser(filePath: string): void {
  try {
    const platform = process.platform;
    if (platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', filePath], { detached: true, stdio: 'ignore' }).unref();
    } else if (platform === 'darwin') {
      spawn('open', [filePath], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [filePath], { detached: true, stdio: 'ignore' }).unref();
    }
    logger.info(`Opening report in default browser: ${path.relative(process.cwd(), filePath)}`);
  } catch (err) {
    logger.warn(`Failed to open report in browser: ${String(err)}`);
  }
}

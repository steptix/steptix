import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Page } from 'playwright';
import type { Config } from '../config/types.js';
import type { AIAction } from '../ai/types.js';
import type { StepResult, SubActionResult } from '../report/types.js';
import { AiClient } from '../ai/client.js';
import {
  buildSystemPrompt,
  buildStepMessage,
  buildClarificationMessage,
  buildAssertionMessage,
} from '../ai/prompts.js';
import { parseAIResponse, parseAssertionEvaluation } from '../ai/action-parser.js';
import { captureDomSnapshot } from '../browser/dom-cleaner.js';
import { captureScreenshot } from '../browser/screenshot.js';
import { executeAction } from '../browser/actions.js';
import { handleObstacles } from '../browser/obstacle-handler.js';
import { withRetry } from './retry.js';
import { logger } from '../utils/logger.js';

export interface StepExecutorOptions {
  page: Page;
  config: Config;
  aiClient: AiClient;
  contextContent: string;
  testName: string;
  baseUrl?: string;
  conversationHistory: string[];
}

/** Determine if a step instruction likely contains an assertion */
function isAssertionStep(instruction: string): boolean {
  const assertionKeywords = [
    'verify', 'assert', 'check', 'confirm', 'ensure', 'should',
    'must', 'expect', 'validate', 'see', 'shows', 'displays',
    'contains', 'greater than', 'less than', 'equal to',
  ];
  const lower = instruction.toLowerCase();
  return assertionKeywords.some((kw) => lower.includes(kw));
}

/**
 * Execute a single test step with retry logic.
 * Returns a StepResult regardless of pass/fail.
 */
export async function executeStep(
  stepIndex: number,
  totalSteps: number,
  instruction: string,
  opts: StepExecutorOptions,
): Promise<StepResult> {
  const startTime = Date.now();
  let retried = false;

  const attempt = async (attemptNumber: number): Promise<StepResult> => {
    if (attemptNumber === 2) retried = true;

    return executeStepAttempt(
      stepIndex,
      totalSteps,
      instruction,
      opts,
      startTime,
      retried,
    );
  };

  try {
    return await withRetry(attempt, {
      maxRetries: opts.config.execution.retries,
      label: `step ${stepIndex}`,
    });
  } catch (err) {
    // Both attempts failed
    const durationMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);

    logger.error(`Step ${stepIndex} FAILED after retry: ${errorMessage}`);

    // Capture failure screenshot
    let failureScreenshot: string | undefined;
    if (opts.config.execution.screenshotOnFailure) {
      const shot = await captureScreenshot(opts.page);
      failureScreenshot = shot?.base64;
    }

    return {
      index: stepIndex,
      instruction,
      status: 'failed',
      subActions: [],
      durationMs,
      retried: true,
      ...(failureScreenshot !== undefined && { screenshotBase64: failureScreenshot }),
      error: errorMessage,
      aiExplanation: `Failed to execute step after ${opts.config.execution.retries + 1} attempts. Last error: ${errorMessage}`,
    };
  }
}

async function executeStepAttempt(
  stepIndex: number,
  totalSteps: number,
  instruction: string,
  opts: StepExecutorOptions,
  startTime: number,
  retried: boolean,
): Promise<StepResult> {
  const { page, config, aiClient, contextContent, testName, baseUrl, conversationHistory } = opts;

  // 1. Auto-dismiss any unexpected obstacles
  if (config.execution.dismissObstacles) {
    await handleObstacles(page);
  }

  // 2. Capture current page state
  const domSnapshot = await captureDomSnapshot(page);
  const screenshot = await captureScreenshot(page);
  const screenshotBase64 = screenshot?.base64;

  // 3. Build messages for the AI
  const systemPrompt = buildSystemPrompt(
    contextContent,
    testName,
    baseUrl,
    stepIndex,
    totalSteps,
  );

  const userMessage = buildStepMessage(
    instruction,
    domSnapshot,
    screenshotBase64 ?? null,
    conversationHistory,
  );

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    userMessage,
  ];

  // 4. Get AI action plan
  const rawResponse = await aiClient.complete(messages);
  let aiResponse = parseAIResponse(rawResponse);

  logger.debug(`AI reasoning: ${aiResponse.reasoning}`);

  // 5. Handle prompt actions (ambiguity resolution)
  const promptAction = aiResponse.actions.find((a) => a.action === 'prompt');
  if (promptAction && config.execution.promptOnAmbiguity) {
    const userAnswer = await promptUser(promptAction.question ?? promptAction.description);
    const clarificationMsg = buildClarificationMessage(
      promptAction.question ?? promptAction.description,
      userAnswer,
    );
    const clarifiedResponse = await aiClient.complete([
      { role: 'system', content: systemPrompt },
      userMessage,
      { role: 'assistant', content: rawResponse },
      clarificationMsg,
    ]);
    aiResponse = parseAIResponse(clarifiedResponse);
  }

  // 6. Execute each sub-action
  const subActions: SubActionResult[] = [];
  let stepFailed = false;
  let stepError: string | undefined;
  let assertionResult: StepResult['assertion'];

  for (const action of aiResponse.actions) {
    if (action.action === 'assert') {
      // Handled after all other actions
      continue;
    }
    if (action.action === 'prompt') {
      // Already handled above
      continue;
    }

    const subStartTime = Date.now();
    const result = await executeAction(page, action, baseUrl);
    const subDuration = Date.now() - subStartTime;

    // Capture state after action
    const postDom = await captureDomSnapshot(page).catch(() => '');
    const postShot = await captureScreenshot(page);

    const postShotBase64 = postShot?.base64;
    const domSnapshotVal = config.reports.includeDomSnapshots ? postDom : undefined;
    const aiReasoningVal = config.reports.includeAiReasoning ? aiResponse.reasoning : undefined;
    subActions.push({
      index: subActions.length + 1,
      action,
      ...(postShotBase64 !== undefined && { screenshotBase64: postShotBase64 }),
      ...(domSnapshotVal !== undefined && { domSnapshot: domSnapshotVal }),
      ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
      durationMs: subDuration,
      ...(result.error !== undefined && { error: result.error }),
    });

    if (!result.success) {
      stepFailed = true;
      stepError = result.error;
      break;
    }
  }

  // 7. Evaluate assertion if step has one
  if (!stepFailed && isAssertionStep(instruction)) {
    const finalDom = await captureDomSnapshot(page);
    const finalShot = await captureScreenshot(page);

    const assertAction = aiResponse.actions.find((a) => a.action === 'assert');

    const assertMsg = buildAssertionMessage(
      instruction,
      finalDom,
      finalShot?.base64 ?? null,
    );

    const assertSystemPrompt = buildSystemPrompt(contextContent, testName, baseUrl);
    const assertRaw = await aiClient.complete([
      { role: 'system', content: assertSystemPrompt },
      assertMsg,
    ]);

    const evaluation = parseAssertionEvaluation(assertRaw);

    assertionResult = {
      pass: evaluation.pass,
      actual: evaluation.actual,
      expected: assertAction?.expected ?? instruction,
      explanation: evaluation.explanation,
    };

    logger.assertion(evaluation.pass, evaluation.actual, assertionResult.expected);

    if (!evaluation.pass) {
      stepFailed = true;
      stepError = `Assertion failed: ${evaluation.explanation}`;
    }
  }

  const durationMs = Date.now() - startTime;
  const status = stepFailed ? 'failed' : 'passed';

  if (stepFailed) {
    throw new Error(stepError ?? 'Step failed');
  }

  const domSnapshotForStep = config.reports.includeDomSnapshots ? domSnapshot : undefined;
  return {
    index: stepIndex,
    instruction,
    status,
    subActions,
    ...(assertionResult !== undefined && { assertion: assertionResult }),
    ...(screenshotBase64 !== undefined && { screenshotBase64 }),
    ...(domSnapshotForStep !== undefined && { domSnapshot: domSnapshotForStep }),
    durationMs,
    retried,
    ...(stepError !== undefined && { error: stepError }),
    aiExplanation: aiResponse.reasoning,
  };
}

async function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    console.log(`\n⚠  AI needs clarification:`);
    const answer = await rl.question(`  ${question}\n  Your answer: `);
    return answer.trim();
  } finally {
    rl.close();
  }
}

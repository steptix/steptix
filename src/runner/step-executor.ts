import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Page } from 'playwright';
import type { Config } from '../config/types.js';
import type { AIAction } from '../ai/types.js';
import type { StepResult, SubActionResult, AiInteraction, ApiCallData } from '../report/types.js';
import { AiClient } from '../ai/client.js';
import {
  buildSystemPrompt,
  buildStepMessage,
  buildClarificationMessage,
  buildAssertionMessage,
  buildRetryContext,
} from '../ai/prompts.js';
import type { PriorFailureContext, ApiPromptContext } from '../ai/prompts.js';
import { parseAIResponse, parseAssertionEvaluation } from '../ai/action-parser.js';
import { captureDomSnapshot } from '../browser/dom-cleaner.js';
import { captureScreenshot } from '../browser/screenshot.js';
import { executeAction } from '../browser/actions.js';
import { handleObstacles } from '../browser/obstacle-handler.js';
import { withRetry } from './retry.js';
import { logger } from '../utils/logger.js';
import { callApiStandalone, callApiBrowserContext } from '../api/client.js';
import { extractCsrfToken } from '../api/csrf-handler.js';
import type { ApiResponseStore } from '../api/response-store.js';

export interface StepExecutorOptions {
  page: Page;
  config: Config;
  aiClient: AiClient;
  contextContent: string;
  testName: string;
  baseUrl?: string;
  conversationHistory: string[];
  apiResponseStore?: ApiResponseStore;
}

/** Error subclass that carries failure context for retry enrichment */
class StepFailureError extends Error {
  failures: PriorFailureContext[];
  aiResponses: AiInteraction[];
  constructor(message: string, failures: PriorFailureContext[], aiResponses: AiInteraction[] = []) {
    super(message);
    this.name = 'StepFailureError';
    this.failures = failures;
    this.aiResponses = aiResponses;
  }
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
  let priorFailures: PriorFailureContext[] = [];
  let allAiResponses: AiInteraction[] = [];

  const attempt = async (attemptNumber: number): Promise<StepResult> => {
    if (attemptNumber === 2) retried = true;

    return executeStepAttempt(
      stepIndex,
      totalSteps,
      instruction,
      opts,
      startTime,
      retried,
      priorFailures,
    );
  };

  try {
    return await withRetry(attempt, {
      maxRetries: opts.config.execution.retries,
      label: `step ${stepIndex}`,
      onFailure: (err) => {
        // Collect failure context and AI responses from the attempt for the next retry
        if (err instanceof StepFailureError) {
          priorFailures = [...priorFailures, ...err.failures];
          allAiResponses = [...allAiResponses, ...err.aiResponses];
        }
      },
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

    // Collect AI responses from the final failed attempt too
    if (err instanceof StepFailureError) {
      allAiResponses = [...allAiResponses, ...err.aiResponses];
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
      ...(allAiResponses.length > 0 && { aiResponses: allAiResponses }),
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
  priorFailures: PriorFailureContext[] = [],
): Promise<StepResult> {
  const { page, config, aiClient, contextContent, testName, baseUrl, conversationHistory, apiResponseStore } = opts;

  // 1. Auto-dismiss any unexpected obstacles
  if (config.execution.dismissObstacles) {
    await handleObstacles(page);
  }

  // 2. Capture current page state
  const domSnapshot = await captureDomSnapshot(page);
  const screenshot = await captureScreenshot(page);
  const screenshotBase64 = screenshot?.base64;

  // 3. Build API context if we have response history
  const apiContext: ApiPromptContext | undefined = contextContent.includes('Type:')
    ? {
        hasApiContext: true,
        responseHistory: apiResponseStore?.hasResponses()
          ? apiResponseStore.formatForContext()
          : '',
      }
    : undefined;

  // 4. Build messages for the AI
  const systemPrompt = buildSystemPrompt(
    contextContent,
    testName,
    baseUrl,
    stepIndex,
    totalSteps,
    config.browser.viewport,
    apiContext,
  );

  // Append retry context so the AI knows what was already tried
  const retryHint = buildRetryContext(priorFailures);
  const enrichedInstruction = retryHint
    ? `${instruction}${retryHint}`
    : instruction;

  const userMessage = buildStepMessage(
    enrichedInstruction,
    domSnapshot,
    screenshotBase64 ?? null,
    conversationHistory,
  );

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    userMessage,
  ];

  // Track all AI responses for the report
  const aiResponses: AiInteraction[] = [];

  // 4. Get AI action plan
  const rawResponse = await aiClient.complete(messages);
  let aiResponse = parseAIResponse(rawResponse);
  aiResponses.push({ purpose: 'action-plan', response: rawResponse });

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
    aiResponses.push({ purpose: 'clarification', response: clarifiedResponse });
    aiResponse = parseAIResponse(clarifiedResponse);
  }

  // 6. Execute each sub-action
  const subActions: SubActionResult[] = [];
  let stepFailed = false;
  let stepError: string | undefined;
  let assertionResult: StepResult['assertion'];
  const collectedFailures: PriorFailureContext[] = [];

  // Accumulated CSRF tokens keyed by selector, available to subsequent api_call actions
  const csrfTokens: Record<string, string> = {};

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
    const aiReasoningVal = config.reports.includeAiReasoning ? aiResponse.reasoning : undefined;

    // ── API action types ─────────────────────────────────────────────────────
    if (action.action === 'extract_csrf') {
      const csrfResult = await extractCsrfToken(
        page,
        action.selector ?? action.source ?? '',
        action.source,
      ).catch((err) => {
        logger.warn(`CSRF extraction failed: ${String(err)}`);
        return undefined;
      });

      const subDuration = Date.now() - subStartTime;
      const subActionResult: SubActionResult = {
        index: subActions.length + 1,
        action,
        durationMs: subDuration,
        ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
      };

      if (csrfResult) {
        csrfTokens[csrfResult.selector] = csrfResult.token;
        // Store under a generic key so the next api_call can find it
        csrfTokens['__latest__'] = csrfResult.token;
      } else {
        subActionResult.error = 'CSRF token could not be extracted';
        stepFailed = true;
        stepError = subActionResult.error;
      }

      subActions.push(subActionResult);
      if (stepFailed) break;
      continue;
    }

    if (action.action === 'extract_value') {
      // Extraction from prior API responses is handled implicitly by the AI's context —
      // log it as a no-op sub-action so it appears in the report.
      subActions.push({
        index: subActions.length + 1,
        action,
        durationMs: Date.now() - subStartTime,
        ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
      });
      continue;
    }

    if (action.action === 'api_call') {
      // If context describes a Front Proxy or Experience API and the AI didn't set apiMode,
      // default to "browser" so the request carries browser session cookies.
      if (!action.apiMode && contextContent.match(/Type:\s*(Front Proxy|Experience)/i)) {
        action.apiMode = 'browser';
        logger.debug('Auto-set apiMode to "browser" based on Front Proxy/Experience context');
      }

      const apiSubResult = await executeApiCallAction(
        action,
        page,
        stepIndex,
        csrfTokens,
        config.api?.requestTimeout,
        apiResponseStore,
        baseUrl,
      );

      const subDuration = Date.now() - subStartTime;
      const subActionResult: SubActionResult = {
        index: subActions.length + 1,
        action,
        durationMs: subDuration,
        ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
        ...(apiSubResult.apiCallData !== undefined && { apiCallData: apiSubResult.apiCallData }),
        ...(apiSubResult.error !== undefined && { error: apiSubResult.error }),
      };
      subActions.push(subActionResult);

      if (apiSubResult.failed) {
        stepFailed = true;
        stepError = apiSubResult.error;
        break;
      }
      continue;
    }

    // ── Browser action types ─────────────────────────────────────────────────
    const result = await executeAction(page, action, baseUrl);
    const subDuration = Date.now() - subStartTime;

    // Capture state after action
    const postDom = await captureDomSnapshot(page).catch(() => '');
    const postShot = await captureScreenshot(page);

    const postShotBase64 = postShot?.base64;
    const domSnapshotVal = config.reports.includeDomSnapshots ? postDom : undefined;
    subActions.push({
      index: subActions.length + 1,
      action,
      ...(postShotBase64 !== undefined && { screenshotBase64: postShotBase64 }),
      ...(domSnapshotVal !== undefined && { domSnapshot: domSnapshotVal }),
      ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
      durationMs: subDuration,
      ...(result.error !== undefined && { error: result.error }),
    });

    // After a successful "wait" on a CSRF-related selector, automatically extract and
    // cache the token value so a subsequent api_call can inject it without needing an
    // explicit extract_csrf action from the AI.
    if (result.success && action.action === 'wait') {
      const waitSelector = action.condition ?? action.value ?? '';
      if (/csrf|__RequestVerificationToken/i.test(waitSelector)) {
        const csrfResult = await extractCsrfToken(page, waitSelector).catch(() => undefined);
        if (csrfResult) {
          csrfTokens[csrfResult.selector] = csrfResult.token;
          csrfTokens['__latest__'] = csrfResult.token;
          logger.debug(`Auto-extracted CSRF token after wait on: ${waitSelector}`);
        }
      }
    }

    if (!result.success) {
      stepFailed = true;
      stepError = result.error;

      // Collect failure context so retry gets richer info
      if (result.failedSelector) {
        collectedFailures.push({
          selector: result.failedSelector,
          error: result.error ?? 'Unknown error',
          ...(result.matchCount !== undefined && { matchCount: result.matchCount }),
          actionType: action.action,
        });
      }
      break;
    }
  }

  // 7. Evaluate assertion if step has one
  if (!stepFailed && isAssertionStep(instruction)) {
    const finalDom = await captureDomSnapshot(page);
    const finalShot = await captureScreenshot(page);

    const assertAction = aiResponse.actions.find((a) => a.action === 'assert');

    const apiHistory = apiContext?.responseHistory;
    logger.info(`Assertion context — API response history present: ${!!apiHistory}, length: ${apiHistory?.length ?? 0}`);
    if (apiHistory) {
      logger.info(`API response history: ${apiHistory.substring(0, 300)}`);
    }

    const assertMsg = buildAssertionMessage(
      instruction,
      finalDom,
      finalShot?.base64 ?? null,
      apiHistory,
    );

    const assertSystemPrompt = buildSystemPrompt(contextContent, testName, baseUrl, undefined, undefined, undefined, apiContext);
    const assertRaw = await aiClient.complete([
      { role: 'system', content: assertSystemPrompt },
      assertMsg,
    ]);
    aiResponses.push({ purpose: 'assertion', response: assertRaw });

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
    throw new StepFailureError(stepError ?? 'Step failed', collectedFailures, aiResponses);
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
    ...(aiResponses.length > 0 && { aiResponses }),
  };
}

interface ApiCallSubResult {
  failed: boolean;
  error?: string;
  apiCallData?: ApiCallData;
}

/**
 * Execute an api_call action using either the Playwright browser context or standalone fetch.
 * Stores the response in the provided ApiResponseStore for subsequent steps.
 */
async function executeApiCallAction(
  action: AIAction,
  page: Page,
  stepIndex: number,
  csrfTokens: Record<string, string>,
  requestTimeout: number | undefined,
  apiResponseStore?: ApiResponseStore,
  baseUrl?: string,
): Promise<ApiCallSubResult> {
  const method = (action.method ?? 'GET').toUpperCase();
  let url = action.url ?? '';

  // Resolve relative URLs against baseUrl or the current page URL
  if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
    const base = baseUrl ?? page.url();
    if (base) {
      try {
        url = new URL(url, base).toString();
        logger.debug(`Resolved relative API URL to: ${url}`);
      } catch {
        // If URL resolution fails, leave as-is and let the fetch fail with a clear error
      }
    }
  }

  if (!url) {
    return { failed: true, error: 'api_call action missing required "url" field' };
  }

  // Merge AI-provided headers with any extracted CSRF token
  const headers: Record<string, string> = { ...(action.apiHeaders ?? {}) };

  // The AI sometimes emits template placeholders like {{csrfToken}} instead of the real
  // value.  Strip out any such placeholder so the injection logic below can fill it in.
  const csrfHeaderKey = Object.keys(headers).find(
    (k) => k.toLowerCase() === 'x-csrf-token',
  );
  if (csrfHeaderKey && /^\{\{.*\}\}$/.test(headers[csrfHeaderKey] ?? '')) {
    logger.info(`Replacing CSRF placeholder "${headers[csrfHeaderKey]}" with real token`);
    delete headers[csrfHeaderKey];
  }

  // If no CSRF token has been captured yet, opportunistically try to extract one from
  // the current page.  This handles the case where the AI skips the navigate/wait steps
  // and goes straight to the api_call without an explicit extract_csrf action.
  if (!csrfTokens['__latest__'] && !headers['x-csrf-token'] && !headers['X-CSRF-Token']) {
    const autoResult = await extractCsrfToken(page, '').catch(() => undefined);
    if (autoResult) {
      csrfTokens[autoResult.selector] = autoResult.token;
      csrfTokens['__latest__'] = autoResult.token;
      logger.debug(`Pre-flight CSRF extraction succeeded via: ${autoResult.selector}`);
    }
  }

  // Inject the latest CSRF token if the AI hasn't already provided one
  const csrfToken = csrfTokens['__latest__'];
  if (csrfToken && !headers['x-csrf-token'] && !headers['X-CSRF-Token']) {
    headers['x-csrf-token'] = csrfToken;
  }

  const callOpts = {
    method,
    url,
    headers,
    body: action.body,
    timeoutMs: requestTimeout ?? 30_000,
  };

  logger.subAction(`API ${method} ${url}`);

  try {
    const apiResult = action.apiMode === 'browser'
      ? await callApiBrowserContext(page, callOpts)
      : await callApiStandalone(callOpts);

    // Store in response store for subsequent steps
    if (apiResponseStore) {
      const endpointPath = extractEndpointPath(url);
      apiResponseStore.add({
        stepNumber: stepIndex,
        endpoint: endpointPath,
        method,
        url,
        ...(action.body !== undefined && { requestBody: action.body }),
        status: apiResult.status,
        headers: apiResult.headers,
        body: apiResult.body,
        timestamp: Date.now(),
      });
    }

    const apiCallData: ApiCallData = {
      method,
      url,
      ...(action.body !== undefined && { requestBody: action.body }),
      ...(Object.keys(headers).length > 0 && { requestHeaders: headers }),
      status: apiResult.status,
      responseHeaders: apiResult.headers,
      responseBody: apiResult.body,
    };

    logger.info(`API response: ${apiResult.status} (${apiResult.durationMs}ms) — mode: ${action.apiMode ?? 'standalone'}`);
    logger.info(`API response body preview: ${JSON.stringify(apiResult.body).substring(0, 200)}`);

    return { failed: false, apiCallData };
  } catch (err) {
    const errorMsg = `API call failed: ${String(err)}`;
    logger.error(errorMsg);
    return { failed: true, error: errorMsg };
  }
}

/** Extract just the path portion from a full URL for display purposes */
function extractEndpointPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
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

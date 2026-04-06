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
  buildContinuationMessage,
  buildAssertionMessage,
  buildRetryContext,
} from '../ai/prompts.js';
import type { PriorFailureContext, ApiPromptContext } from '../ai/prompts.js';
import type { ChatMessage } from '../ai/types.js';
import { parseAIResponse, parseAssertionEvaluation } from '../ai/action-parser.js';
import { captureDomSnapshot } from '../browser/dom-cleaner.js';
import { captureScreenshot } from '../browser/screenshot.js';
import { executeAction } from '../browser/actions.js';
import { handleObstacles } from '../browser/obstacle-handler.js';
import type { PageTracker } from '../browser/manager.js';
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
  /** CSRF tokens accumulated across steps — keyed by selector, with '__latest__' for the most recent */
  csrfTokens: Record<string, string>;
  /** Live parameter map — read actions write captured values here for use in later steps */
  resolvedParameters?: Record<string, string>;
  /** Tracks all open pages (popups, tabs) — enables switchPage actions */
  pageTracker?: PageTracker;
}

/** Extract text-only content from a ChatMessage (strips base64 image blocks) */
function extractTextFromMessage(msg: ChatMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  return msg.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
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

/** Determine if a step instruction likely contains an assertion.
 * Matches only when an assertion verb is the primary intent — i.e. at the start of the
 * instruction (after stripping optional [prefix] markers like [input: x]).
 * This avoids false positives from button/element names that happen to contain
 * assertion words (e.g. "Click the Verify Code button"). */
function isAssertionStep(instruction: string): boolean {
  // Strip leading [prefix] markers such as [input: x] or [interactive]
  const stripped = instruction.replace(/^\[.*?\]\s*/i, '').toLowerCase();
  return /^(verify|assert|check|confirm|ensure|should|must|expect|validate|greater than|less than|equal to)/.test(stripped);
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
      attemptNumber,
    );
  };

  try {
    const result = await withRetry(attempt, {
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

    // If a prior attempt failed, merge its AI interactions into the successful result
    // so the report shows all attempts, not just the one that succeeded
    if (allAiResponses.length > 0) {
      return {
        ...result,
        aiResponses: [...allAiResponses, ...(result.aiResponses ?? [])],
      };
    }
    return result;
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

/** Tag AI interactions with turn numbers for multi-turn steps; omit turnNumber for single-turn steps. */
function tagAiResponses(
  buffer: Array<{ interaction: AiInteraction; turn: number }>,
  isMultiTurn: boolean,
): AiInteraction[] {
  return buffer.map(({ interaction, turn }) =>
    isMultiTurn ? { ...interaction, turnNumber: turn } : interaction,
  );
}

async function executeStepAttempt(
  stepIndex: number,
  totalSteps: number,
  instruction: string,
  opts: StepExecutorOptions,
  startTime: number,
  retried: boolean,
  priorFailures: PriorFailureContext[] = [],
  attemptNumber: number = 1,
): Promise<StepResult> {
  const { config, aiClient, contextContent, testName, baseUrl, conversationHistory, apiResponseStore, csrfTokens, pageTracker } = opts;
  let page = pageTracker ? pageTracker.getActive() : opts.page;
  const maxTurns = config.execution.maxTurns;

  // Accumulated across all turns
  const aiResponseBuffer: Array<{ interaction: AiInteraction; turn: number }> = [];
  const allSubActions: SubActionResult[] = [];
  const allCompletedActions: Array<{ description: string }> = [];
  const collectedFailures: PriorFailureContext[] = [];
  const urlHistory: string[] = [];

  // First-turn state is used for the step result (screenshot / DOM taken at step start)
  let firstTurnDomSnapshot = '';
  let firstTurnScreenshot: string | undefined;

  // Retained from the final turn for aiExplanation and assertion context
  let lastAiResponse: ReturnType<typeof parseAIResponse> | null = null;
  let lastApiContext: ApiPromptContext | undefined;

  let assertionResult: StepResult['assertion'];
  let stepFailed = false;
  let stepError: string | undefined;
  let completedTurns = 0;

  for (let currentTurn = 1; currentTurn <= maxTurns; currentTurn++) {
    completedTurns = currentTurn;

    // 0. Refresh active page from tracker (handles switchPage from prior turn)
    if (pageTracker) {
      page = pageTracker.getActive();
    }

    // 1. Auto-dismiss obstacles (first turn only)
    if (currentTurn === 1 && config.execution.dismissObstacles) {
      await handleObstacles(page);
    }

    // 2. Capture current page state
    const domSnapshot = await captureDomSnapshot(page);
    const screenshot = await captureScreenshot(page);
    const screenshotBase64 = screenshot?.base64;
    const currentUrl = page.url();

    if (currentTurn === 1) {
      firstTurnDomSnapshot = domSnapshot;
      firstTurnScreenshot = screenshotBase64;
    }

    // 3. Cycle detection: abort if current URL matches URL from two turns ago
    if (urlHistory.length >= 2 && currentUrl === urlHistory[urlHistory.length - 2]) {
      throw new StepFailureError(
        `Step failed: navigation cycle detected — stuck at ${currentUrl}`,
        [],
        tagAiResponses(aiResponseBuffer, completedTurns > 1),
      );
    }
    urlHistory.push(currentUrl);

    // 4. Build API context and system prompt (rebuilt each turn so API history stays current)
    const apiContext: ApiPromptContext | undefined = contextContent.includes('Type:')
      ? {
          hasApiContext: true,
          responseHistory: apiResponseStore?.hasResponses()
            ? apiResponseStore.formatForContext()
            : '',
        }
      : undefined;
    lastApiContext = apiContext;

    const systemPrompt = buildSystemPrompt(
      contextContent,
      testName,
      baseUrl,
      stepIndex,
      totalSteps,
      config.browser.headed ? config.browser.windowSize : config.browser.viewport,
      apiContext,
    );

    // 5. Build user message (first turn: normal step message; subsequent: continuation prompt)
    const openPages = pageTracker && pageTracker.count > 1
      ? await pageTracker.getPageListWithTitles()
      : undefined;

    let userMessage: ChatMessage;
    const screenshotForAi = config.ai.sendScreenshots ? (screenshotBase64 ?? null) : null;

    if (currentTurn === 1) {
      const retryHint = buildRetryContext(priorFailures);
      const enrichedInstruction = retryHint ? `${instruction}${retryHint}` : instruction;
      userMessage = buildStepMessage(
        enrichedInstruction,
        domSnapshot,
        screenshotForAi,
        conversationHistory,
        openPages,
      );
    } else {
      userMessage = buildContinuationMessage(
        instruction,
        allCompletedActions,
        opts.resolvedParameters ?? {},
        currentUrl,
        domSnapshot,
        screenshotForAi,
        currentTurn,
        openPages,
      );
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      userMessage,
    ];

    // 6. Get AI action plan
    const rawResponse = await aiClient.complete(messages);
    let aiResponse = parseAIResponse(rawResponse);
    lastAiResponse = aiResponse;
    aiResponseBuffer.push({
      interaction: {
        purpose: 'action-plan',
        attemptNumber,
        requestMessages: messages.map((m) => ({ role: m.role, content: extractTextFromMessage(m) })),
        response: rawResponse,
      },
      turn: currentTurn,
    });

    logger.debug(`AI reasoning (turn ${currentTurn}): ${aiResponse.reasoning}`);

    // 7. Handle prompt actions (ambiguity resolution)
    const promptAction = aiResponse.actions.find((a) => a.action === 'prompt');
    if (promptAction && config.execution.promptOnAmbiguity) {
      const userAnswer = await promptUser(promptAction.question ?? promptAction.description);
      const clarificationMsg = buildClarificationMessage(
        promptAction.question ?? promptAction.description,
        userAnswer,
      );
      const clarificationMessages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        userMessage,
        { role: 'assistant', content: rawResponse },
        clarificationMsg,
      ];
      const clarifiedResponse = await aiClient.complete(clarificationMessages);
      aiResponseBuffer.push({
        interaction: {
          purpose: 'clarification',
          attemptNumber,
          requestMessages: clarificationMessages.map((m) => ({ role: m.role, content: extractTextFromMessage(m) })),
          response: clarifiedResponse,
        },
        turn: currentTurn,
      });
      aiResponse = parseAIResponse(clarifiedResponse);
      lastAiResponse = aiResponse;
    }

    // 8. Execute each sub-action
    let turnFailed = false;
    let turnError: string | undefined;

    for (const action of aiResponse.actions) {
      if (action.action === 'assert') continue;
      if (action.action === 'prompt') continue;

      const subStartTime = Date.now();
      const aiReasoningVal = config.reports.includeAiReasoning ? aiResponse.reasoning : undefined;

      // ── switchPage action ──────────────────────────────────────────────────
      if (action.action === 'switchPage') {
        let switchError: string | undefined;
        if (pageTracker && action.page) {
          const targetPage = await pageTracker.switchToAsync(action.page);
          if (targetPage) {
            page = targetPage;
            logger.info(`Switched to page: ${action.page} (${targetPage.url()})`);
          } else {
            switchError = `switchPage failed: no page matching "${action.page}"`;
            logger.warn(switchError);
          }
        } else if (!pageTracker) {
          switchError = 'switchPage failed: page tracking is not enabled';
          logger.warn(switchError);
        } else {
          switchError = 'switchPage failed: no "page" field specified';
          logger.warn(switchError);
        }

        allSubActions.push({
          index: allSubActions.length + 1,
          action,
          durationMs: Date.now() - subStartTime,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          ...(switchError !== undefined && { error: switchError }),
        });

        if (switchError) {
          turnFailed = true;
          turnError = switchError;
          break;
        }
        continue;
      }

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
          index: allSubActions.length + 1,
          action,
          durationMs: subDuration,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
        };

        if (csrfResult) {
          csrfTokens[csrfResult.selector] = csrfResult.token;
          csrfTokens['__latest__'] = csrfResult.token;
        } else {
          subActionResult.error = 'CSRF token could not be extracted';
          turnFailed = true;
          turnError = subActionResult.error;
        }

        allSubActions.push(subActionResult);
        if (turnFailed) break;
        continue;
      }

      if (action.action === 'extract_value') {
        // Extraction from prior API responses is handled implicitly by the AI's context —
        // log it as a no-op sub-action so it appears in the report.
        allSubActions.push({
          index: allSubActions.length + 1,
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
          index: allSubActions.length + 1,
          action,
          durationMs: subDuration,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          ...(apiSubResult.apiCallData !== undefined && { apiCallData: apiSubResult.apiCallData }),
          ...(apiSubResult.error !== undefined && { error: apiSubResult.error }),
        };
        allSubActions.push(subActionResult);

        if (apiSubResult.failed) {
          turnFailed = true;
          turnError = apiSubResult.error;
          break;
        }
        continue;
      }

      // ── Browser action types ─────────────────────────────────────────────────
      const result = await executeAction(page, action, baseUrl);
      const subDuration = Date.now() - subStartTime;

      // Store captured value from "read" / "count" actions into the live parameter map
      if (result.capturedValue !== undefined && action.as && opts.resolvedParameters) {
        opts.resolvedParameters[action.as] = result.capturedValue;
        logger.info(`Stored captured value as "{{${action.as}}}": "${result.capturedValue}"`);
      }

      // Capture state after action
      const postDom = await captureDomSnapshot(page).catch(() => '');
      const postShot = await captureScreenshot(page);
      const postShotBase64 = postShot?.base64;
      const domSnapshotVal = config.reports.includeDomSnapshots ? postDom : undefined;
      allSubActions.push({
        index: allSubActions.length + 1,
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
        turnFailed = true;
        turnError = result.error;

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

    // Track non-assert/prompt actions for the continuation prompt on the next turn
    allCompletedActions.push(
      ...aiResponse.actions.filter((a) => a.action !== 'assert' && a.action !== 'prompt'),
    );

    if (turnFailed) {
      throw new StepFailureError(
        turnError ?? 'Step failed',
        collectedFailures,
        tagAiResponses(aiResponseBuffer, completedTurns > 1),
      );
    }

    // 9a. Check needs_reeval: if false/absent, the step is complete after this turn
    if (!aiResponse.needs_reeval) {
      break;
    }

    // needs_reeval is true — enforce the turn cap
    if (currentTurn === maxTurns) {
      throw new StepFailureError(
        `Step failed: multi-turn limit reached (${maxTurns} turns).\nLast URL: ${page.url()}`,
        [],
        tagAiResponses(aiResponseBuffer, true),
      );
    }

    logger.info(`Turn ${currentTurn} complete (needs_reeval=true) — starting turn ${currentTurn + 1}`);
  }

  // 9b. Evaluate assertion if step has one (runs after all turns complete successfully)
  if (!stepFailed && isAssertionStep(instruction)) {
    const finalDom = await captureDomSnapshot(page);
    const finalShot = await captureScreenshot(page);

    const assertAction = lastAiResponse?.actions.find((a) => a.action === 'assert');

    const apiHistory = lastApiContext?.responseHistory;
    logger.info(`Assertion context — API response history present: ${!!apiHistory}, length: ${apiHistory?.length ?? 0}`);
    if (apiHistory) {
      logger.info(`API response history: ${apiHistory.substring(0, 300)}`);
    }

    const assertMsg = buildAssertionMessage(
      instruction,
      finalDom,
      config.ai.sendScreenshots ? (finalShot?.base64 ?? null) : null,
      apiHistory,
    );

    const assertSystemPrompt = buildSystemPrompt(contextContent, testName, baseUrl, undefined, undefined, undefined, lastApiContext);
    const assertMessages: ChatMessage[] = [
      { role: 'system', content: assertSystemPrompt },
      assertMsg,
    ];
    const assertRaw = await aiClient.complete(assertMessages);
    aiResponseBuffer.push({
      interaction: {
        purpose: 'assertion',
        attemptNumber,
        requestMessages: assertMessages.map((m) => ({ role: m.role, content: extractTextFromMessage(m) })),
        response: assertRaw,
      },
      turn: completedTurns,
    });

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
  const isMultiTurn = completedTurns > 1;
  const aiResponses = tagAiResponses(aiResponseBuffer, isMultiTurn);

  if (stepFailed) {
    throw new StepFailureError(stepError ?? 'Step failed', collectedFailures, aiResponses);
  }

  const domSnapshotForStep = config.reports.includeDomSnapshots ? firstTurnDomSnapshot : undefined;
  return {
    index: stepIndex,
    instruction,
    status: 'passed',
    subActions: allSubActions,
    ...(assertionResult !== undefined && { assertion: assertionResult }),
    ...(firstTurnScreenshot !== undefined && { screenshotBase64: firstTurnScreenshot }),
    ...(domSnapshotForStep !== undefined && { domSnapshot: domSnapshotForStep }),
    durationMs,
    retried,
    aiExplanation: lastAiResponse?.reasoning ?? 'No reasoning provided',
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

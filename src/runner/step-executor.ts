import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Page } from 'playwright';
import type { Config } from '../config/types.js';
import type { AIAction, BranchedAIResponse } from '../ai/types.js';
import type { StepResult, SubActionResult, AiInteraction, TurnResult, ApiCallData } from '../report/types.js';
import { AiClient } from '../ai/client.js';
import {
  buildSystemPrompt,
  buildStepMessage,
  buildClarificationMessage,
  buildContinuationMessage,
  buildAssertionCodePrompt,
  buildRetryContext,
  buildBranchedStepMessage,
  formatTestInfo,
} from '../ai/prompts.js';
import type { PriorFailureContext, RetryDiagnostics, ApiPromptContext, BranchOutcome } from '../ai/prompts.js';
import { diagnosePageState, waitForPageStability, waitForPostActionSettle, capturePageSignal, PageActivityTracker } from '../browser/page-state.js';
import type { PageStateDiagnosis } from '../browser/page-state.js';
import type { ChatMessage } from '../ai/types.js';
import { parseAIResponse, parseAssertionCode, parseBranchedResponse } from '../ai/action-parser.js';
import { captureDomSnapshot, findInDom, expandDomSubtree, formatFindResults, formatExpandResult } from '../browser/dom-cleaner.js';
import { captureScreenshot } from '../browser/screenshot.js';
import { executeAction } from '../browser/actions.js';
import type { PageTracker } from '../browser/manager.js';
import { withRetry } from './retry.js';
import { logger } from '../utils/logger.js';
import { callApiStandalone, callApiBrowserContext } from '../api/client.js';
import { extractCsrfToken } from '../api/csrf-handler.js';
import type { ApiResponseStore } from '../api/response-store.js';
import type { StepCache, CachedStepData } from '../cache/step-cache.js';
import type { StepGroup } from './step-grouper.js';

/**
 * Actions that may mutate the page and therefore warrant a post-action settle
 * to let the SPA/legacy app react before we snapshot for the next turn.
 * Observational / control-flow actions are excluded — they don't trigger
 * page changes so a settle is pure overhead.
 */
const MUTATING_ACTIONS: ReadonlySet<AIAction['action']> = new Set([
  'click',
  'type',
  'select',
  'navigate',
  'upload',
  'hover',
  'keyboard',
  'keypress',
  'dismiss',
  'scroll',
  'wait',
]);

function isMutatingAction(action: AIAction): boolean {
  return MUTATING_ACTIONS.has(action.action);
}

/** Mutable ref for capturing all AI turns for cache writing. */
export interface CacheCapture {
  turns: CachedStepData[];
}

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
  /** Pre-initialized step cache — always present; action caching gated by cacheEnabled */
  stepCache?: StepCache;
  /** When true, step action responses are read from / written to the step cache */
  cacheEnabled?: boolean;
  /** When true, include dismissal-related guidance in the system prompt and
   *  retry hints. Enabled by the runner when the test has hooks configured. */
  dismissalGuidance?: boolean;
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
  turns: TurnResult[];
  constructor(message: string, failures: PriorFailureContext[], turns: TurnResult[] = []) {
    super(message);
    this.name = 'StepFailureError';
    this.failures = failures;
    this.turns = turns;
  }
}

/** Determine if a step instruction likely contains an assertion.
 * Matches only when an assertion verb is the primary intent — i.e. at the start of the
 * instruction (after stripping optional [prefix] markers like [input: x]).
 * This avoids false positives from button/element names that happen to contain
 * assertion words (e.g. "Click the Verify Code button"). */
export function isAssertionStep(instruction: string): boolean {
  // Strip leading [prefix] markers such as [input: x] or [interactive]
  const stripped = instruction.replace(/^\[.*?\]\s*/i, '').toLowerCase();
  return /^(verify|assert|check|confirm|ensure|should|must|expect|validate|greater than|less than|equal to)/.test(stripped);
}

/** Determine if a step instruction is asking to extract, read, or capture values from the page.
 * When true, a richer "readable" DOM snapshot is sent that preserves visible text content
 * (table cells, paragraphs, spans, etc.) instead of the compact action-oriented DOM.
 *
 * Detection heuristics:
 *  1. Explicit variable storage patterns: [store as: ...], store/save as {{...}}
 *  2. Extraction verbs at start: get, capture, read, extract, note, record, etc.
 *  3. Question patterns: "what is the", "how many", "what are the"
 */
export function isExtractionStep(instruction: string): boolean {
  const lower = instruction.toLowerCase();

  // Explicit variable storage patterns (anywhere in instruction)
  if (/\[store as:/.test(lower)) return true;
  if (/store\s+(it\s+)?as\s+\{\{/.test(lower)) return true;
  if (/save\s+(it\s+)?as\s+\{\{/.test(lower)) return true;

  // Strip leading [prefix] markers to check intent verbs
  const stripped = instruction.replace(/^\[.*?\]\s*/i, '').toLowerCase();

  // Extraction verbs at start of the instruction
  if (/^(get|capture|read|extract|note|record|store|save|retrieve|collect|grab|copy|take note|what is|what are|how many)/.test(stripped)) {
    return true;
  }

  return false;
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
  let priorAttemptTurns: TurnResult[] = [];
  // --- Cache attempt (before normal AI flow) ---
  if (opts.stepCache && opts.cacheEnabled) {
    const cached = await opts.stepCache.read(stepIndex, opts.resolvedParameters ?? {});
    if (cached) {
      logger.info(`Cache HIT for step ${stepIndex} — replaying ${cached.length} cached turn(s)`);
      try {
        const result = await executeStepAttempt(
          stepIndex,
          totalSteps,
          instruction,
          opts,
          startTime,
          false,
          [],
          1,
          cached,
        );
        logger.success(`Step ${stepIndex} passed (from cache)`);
        return result;
      } catch (err) {
        logger.warn(`Cached actions failed for step ${stepIndex} — invalidating and falling through to AI`);
        await opts.stepCache.invalidateStep(stepIndex);
        // Do NOT propagate failure context — give AI a clean slate
      }
    } else {
      logger.debug(`Cache MISS for step ${stepIndex}`);
    }
  }

  // --- Normal AI flow (with cache-write on success) ---
  const cacheCapture: CacheCapture = { turns: [] };

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
      undefined,
      cacheCapture,
    );
  };

  try {
    const result = await withRetry(attempt, {
      maxRetries: opts.config.execution.retries,
      label: `step ${stepIndex}`,
      onFailure: (err) => {
        // Collect failure context and turns from the attempt for the next retry
        if (err instanceof StepFailureError) {
          priorFailures = [...priorFailures, ...err.failures];
          priorAttemptTurns = [...priorAttemptTurns, ...err.turns];
        }
      },
    });

    // Write all turns to cache on success (non-assertion steps only)
    if (opts.stepCache && opts.cacheEnabled && cacheCapture.turns.length > 0) {
      await opts.stepCache.write(
        stepIndex,
        cacheCapture.turns,
        opts.resolvedParameters ?? {},
      );
    }

    // If a prior attempt failed, merge its turns into the successful result
    // so the report shows all attempts, not just the one that succeeded
    if (priorAttemptTurns.length > 0) {
      return {
        ...result,
        turns: [...priorAttemptTurns, ...result.turns],
      };
    }
    return result;
  } catch (err) {
    // All attempts failed
    const durationMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);

    logger.error(`Step ${stepIndex} FAILED after retry: ${errorMessage}`);

    // Capture failure screenshot (full-page for report visibility)
    let failureScreenshot: string | undefined;
    if (opts.config.execution.screenshotOnFailure) {
      const shot = await captureScreenshot(opts.page, opts.config.browser.fullPageScreenshots);
      failureScreenshot = shot?.base64;
    }

    // Collect turns from the final failed attempt too
    if (err instanceof StepFailureError) {
      priorAttemptTurns = [...priorAttemptTurns, ...err.turns];
    }

    return {
      index: stepIndex,
      instruction,
      status: 'failed',
      turns: priorAttemptTurns,
      durationMs,
      retried: true,
      ...(failureScreenshot !== undefined && { screenshotBase64: failureScreenshot }),
      pageUrl: opts.page.url(),
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
  priorFailures: PriorFailureContext[] = [],
  attemptNumber: number = 1,
  cachedTurns?: CachedStepData[],
  cacheCapture?: CacheCapture,
): Promise<StepResult> {
  const { config, aiClient, contextContent, testName, baseUrl, conversationHistory, apiResponseStore, csrfTokens, pageTracker } = opts;
  let page = pageTracker ? pageTracker.getActive() : opts.page;
  const maxTurns = config.execution.maxTurns;

  // Accumulated across all turns
  const allTurns: TurnResult[] = [];
  const allCompletedActions: Array<{ action: string; description: string; selector?: string }> = [];
  const collectedFailures: PriorFailureContext[] = [];
  const attemptStartUrl = page.url();
  /** Results from find/expand exploration actions — included in the continuation message */
  const explorationResults: string[] = [];

  // Stall detection: if the AI keeps issuing "wait" actions but the page
  // (URL + DOM) is unchanged AND the network is idle, the prior action likely
  // didn't register. Fail fast instead of burning turns on a stuck page.
  let activityTrackers = new Map<Page, PageActivityTracker>();
  const trackerFor = (p: Page): PageActivityTracker => {
    let t = activityTrackers.get(p);
    if (!t) { t = new PageActivityTracker(p); activityTrackers.set(p, t); }
    return t;
  };
  trackerFor(page); // attach to initial page
  let prevPageFingerprint: string | undefined;
  let lastActionWasWait = false;
  let stallCount = 0;
  const STALL_LIMIT = 2;

  // Global sub-action counter (1-based, spans all turns)
  let globalSubActionIndex = 0;

  // First-turn state is used for the step result (DOM taken at step start)
  let firstTurnDomSnapshot = '';

  // Retained from the final turn for aiExplanation and assertion context
  let lastAiResponse: ReturnType<typeof parseAIResponse> | null = null;
  let lastApiContext: ApiPromptContext | undefined;

  let assertionResult: StepResult['assertion'];
  let assertionAiInteraction: AiInteraction | undefined;
  let stepFailed = false;
  let stepError: string | undefined;
  let completedTurns = 0;

  try {
  for (let currentTurn = 1; currentTurn <= maxTurns; currentTurn++) {
    completedTurns = currentTurn;

    // 0. Refresh active page from tracker (handles switchPage from prior turn)
    if (pageTracker) {
      page = pageTracker.getActive();
    }
    const tracker = trackerFor(page);

    // 1b. On retry attempts, diagnose page state and auto-wait if loading
    let pageDiagnosis: PageStateDiagnosis | undefined;
    if (attemptNumber > 1 && currentTurn === 1) {
      pageDiagnosis = await diagnosePageState(page);
      if (pageDiagnosis.isLoading) {
        logger.info('Page appears to be loading on retry — waiting for networkidle (up to 5s)');
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
          logger.debug('networkidle wait timed out after 5s — proceeding anyway');
        });
        // Re-diagnose after waiting
        pageDiagnosis = await diagnosePageState(page);
      }
    }

    // 2. Capture current page state (full-page so AI sees content below the fold)
    const turnTimestamp = new Date().toISOString();
    const domSnapshot = await captureDomSnapshot(page, { collapseRepetitiveDom: config.browser.collapseRepetitiveDom, compactSvg: config.browser.compactSvg });
    const screenshot = await captureScreenshot(page, config.browser.fullPageScreenshots);
    const screenshotBase64 = screenshot?.base64;
    const currentUrl = page.url();

    if (currentTurn === 1) {
      firstTurnDomSnapshot = domSnapshot;
    }

    // Stall detection: if the prior turn's action was a "wait" and neither the
    // page (URL + DOM) nor the network moved since then, the preceding click
    // (or whatever triggered the wait) likely didn't register. Bail out instead
    // of burning more turns.
    const pageFingerprint = `${currentUrl}\n${domSnapshot}`;
    if (currentTurn > 1 && lastActionWasWait) {
      const unchanged = pageFingerprint === prevPageFingerprint;
      const networkIdle = tracker.isIdle();
      if (unchanged && networkIdle) {
        stallCount++;
        logger.warn(
          `Stall detected (${stallCount}/${STALL_LIMIT}): page unchanged since last turn, network idle, last action was "wait" — prior action may not have registered`,
        );
        if (stallCount >= STALL_LIMIT) {
          throw new StepFailureError(
            `Step stalled: page did not advance after prior action across ${stallCount + 1} turns (URL, DOM, and network all quiet). The preceding action may not have registered — check selector targeting and element interactability.`,
            [],
            allTurns,
          );
        }
      } else {
        stallCount = 0;
      }
    }
    prevPageFingerprint = pageFingerprint;

    // Per-turn accumulators
    const turnAiInteractions: AiInteraction[] = [];
    const turnSubActions: SubActionResult[] = [];



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

    const systemPrompt = buildSystemPrompt(contextContent, apiContext, {
      dismissalGuidance: opts.dismissalGuidance ?? false,
    });
    const testInfo = formatTestInfo(
      testName,
      baseUrl,
      stepIndex,
      totalSteps,
      config.browser.headed ? config.browser.windowSize : config.browser.viewport,
    );

    // 5. Build user message (first turn: normal step message; subsequent: continuation prompt)
    const openPages = pageTracker && pageTracker.count > 1
      ? await pageTracker.getPageListWithTitles()
      : undefined;

    let userMessage: ChatMessage;
    const screenshotForAi = config.ai.sendScreenshots ? (screenshotBase64 ?? null) : null;

    if (currentTurn === 1) {
      const retryInput: RetryDiagnostics | undefined = priorFailures.length > 0
        ? {
            failures: priorFailures,
            ...(pageDiagnosis ? { pageState: pageDiagnosis } : {}),
            attemptNumber,
            dismissalGuidance: opts.dismissalGuidance ?? false,
          }
        : undefined;
      const retryHint = retryInput ? buildRetryContext(retryInput) : '';
      const enrichedInstruction = retryHint ? `${instruction}${retryHint}` : instruction;
      userMessage = buildStepMessage(
        enrichedInstruction,
        domSnapshot,
        screenshotForAi,
        conversationHistory,
        openPages,
        testInfo,
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
        explorationResults.length > 0 ? explorationResults : undefined,
        testInfo,
      );
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      userMessage,
    ];

    // 6. Get AI action plan (from cache on turn 1 if available, otherwise call AI)
    let rawResponse: string;
    let aiResponse: ReturnType<typeof parseAIResponse>;

    const cachedTurn = cachedTurns?.[currentTurn - 1];
    if (cachedTurn) {
      rawResponse = cachedTurn.rawResponse;
      aiResponse = {
        actions: cachedTurn.actions,
        reasoning: cachedTurn.reasoning,
        ...(cachedTurn.needs_reeval !== undefined && { needs_reeval: cachedTurn.needs_reeval }),
      };
      turnAiInteractions.push({
        purpose: 'action-plan (cached)',
        attemptNumber,
        requestMessages: [],
        response: rawResponse,
        ...(screenshotBase64 !== undefined && { screenshotBase64 }),
        pageUrl: currentUrl,
        timestamp: turnTimestamp,
      });
    } else {
      const completion = await aiClient.complete(messages);
      rawResponse = completion.text;
      aiResponse = parseAIResponse(rawResponse);

      turnAiInteractions.push({
        purpose: 'action-plan',
        attemptNumber,
        requestMessages: messages.map((m) => ({ role: m.role, content: extractTextFromMessage(m) })),
        response: rawResponse,
        model: completion.model,
        ...(screenshotBase64 !== undefined && { screenshotBase64 }),
        pageUrl: currentUrl,
        timestamp: turnTimestamp,
      });
    }

    // Capture this turn for cache writing
    if (cacheCapture) {
      cacheCapture.turns.push({
        rawResponse,
        actions: aiResponse.actions,
        reasoning: aiResponse.reasoning,
        ...(aiResponse.needs_reeval !== undefined && { needs_reeval: aiResponse.needs_reeval }),
      });
    }

    lastAiResponse = aiResponse;

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
      const clarifiedCompletion = await aiClient.complete(clarificationMessages);
      const clarifiedResponse = clarifiedCompletion.text;
      turnAiInteractions.push({
        purpose: 'clarification',
        attemptNumber,
        requestMessages: clarificationMessages.map((m) => ({ role: m.role, content: extractTextFromMessage(m) })),
        response: clarifiedResponse,
        model: clarifiedCompletion.model,
        timestamp: new Date().toISOString(),
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

        // Capture screenshot on failure for debugging
        let switchShot: string | undefined;
        let switchUrl: string | undefined;
        if (switchError) {
          const shot = await captureScreenshot(page, config.browser.fullPageScreenshots);
          switchShot = shot?.base64;
          switchUrl = page.url();
        }

        turnSubActions.push({
          index: ++globalSubActionIndex,
          action,
          durationMs: Date.now() - subStartTime,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          ...(switchError !== undefined && { error: switchError }),
          ...(switchShot !== undefined && { screenshotBase64: switchShot }),
          ...(switchUrl !== undefined && { pageUrl: switchUrl }),
          timestamp: new Date().toISOString(),
        });

        if (switchError) {
          turnFailed = true;
          turnError = switchError;
          break;
        }
        continue;
      }

      // ── closePage action ──────────────────────────────────────────────────
      if (action.action === 'closePage') {
        let closeError: string | undefined;
        if (pageTracker && action.page) {
          const result = await pageTracker.closePage(action.page);
          if (result.closed) {
            page = result.activePage;
            logger.info(`Closed page: ${action.page} — active page is now ${page.url()}`);
          } else {
            closeError = `closePage failed: ${result.error}`;
            logger.warn(closeError);
          }
        } else if (!pageTracker) {
          closeError = 'closePage failed: page tracking is not enabled';
          logger.warn(closeError);
        } else {
          closeError = 'closePage failed: no "page" field specified';
          logger.warn(closeError);
        }

        // Capture screenshot on failure for debugging
        let closeShot: string | undefined;
        let closeUrl: string | undefined;
        if (closeError) {
          const shot = await captureScreenshot(page, config.browser.fullPageScreenshots);
          closeShot = shot?.base64;
          closeUrl = page.url();
        }

        turnSubActions.push({
          index: ++globalSubActionIndex,
          action,
          durationMs: Date.now() - subStartTime,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          ...(closeError !== undefined && { error: closeError }),
          ...(closeShot !== undefined && { screenshotBase64: closeShot }),
          ...(closeUrl !== undefined && { pageUrl: closeUrl }),
          timestamp: new Date().toISOString(),
        });

        if (closeError) {
          turnFailed = true;
          turnError = closeError;
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
          index: ++globalSubActionIndex,
          action,
          durationMs: subDuration,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          timestamp: new Date().toISOString(),
        };

        if (csrfResult) {
          csrfTokens[csrfResult.selector] = csrfResult.token;
          csrfTokens['__latest__'] = csrfResult.token;
        } else {
          subActionResult.error = 'CSRF token could not be extracted';
          const shot = await captureScreenshot(page, config.browser.fullPageScreenshots);
          if (shot) { subActionResult.screenshotBase64 = shot.base64; }
          subActionResult.pageUrl = page.url();
          turnFailed = true;
          turnError = subActionResult.error;
        }

        turnSubActions.push(subActionResult);
        if (turnFailed) break;
        continue;
      }

      if (action.action === 'extract_value') {
        // Extraction from prior API responses is handled implicitly by the AI's context —
        // log it as a no-op sub-action so it appears in the report.
        turnSubActions.push({
          index: ++globalSubActionIndex,
          action,
          durationMs: Date.now() - subStartTime,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          timestamp: new Date().toISOString(),
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
          index: ++globalSubActionIndex,
          action,
          durationMs: subDuration,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          ...(apiSubResult.apiCallData !== undefined && { apiCallData: apiSubResult.apiCallData }),
          ...(apiSubResult.error !== undefined && { error: apiSubResult.error }),
          timestamp: new Date().toISOString(),
        };

        if (apiSubResult.failed) {
          const shot = await captureScreenshot(page, config.browser.fullPageScreenshots);
          if (shot) { subActionResult.screenshotBase64 = shot.base64; }
          subActionResult.pageUrl = page.url();
        }

        turnSubActions.push(subActionResult);

        if (apiSubResult.failed) {
          turnFailed = true;
          turnError = apiSubResult.error;
          break;
        }
        continue;
      }

      // ── DOM exploration actions (find/expand) ──────────────────────────────────
      if (action.action === 'find') {
        const searchText = action.value ?? action.condition ?? '';
        const scope = action.selector;
        const result = await findInDom(page, searchText, scope);
        const formatted = formatFindResults(result, searchText, scope);
        explorationResults.push(formatted);
        const scopeLog = scope ? ` in "${scope}"` : '';
        const totalLabel = result.hitHardMax ? `${result.totalMatches}+` : `${result.totalMatches}`;
        logger.info(`find "${searchText}"${scopeLog}: ${result.matches.length} shown / ${totalLabel} total`);

        turnSubActions.push({
          index: ++globalSubActionIndex,
          action,
          durationMs: Date.now() - subStartTime,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          timestamp: new Date().toISOString(),
        });
        // Force needs_reeval so the AI sees the results on the next turn
        aiResponse.needs_reeval = true;
        continue;
      }

      if (action.action === 'expand') {
        const expandSelector = action.selector ?? '';
        const subtree = await expandDomSubtree(page, expandSelector);
        const formatted = formatExpandResult(subtree, expandSelector);
        explorationResults.push(formatted);
        logger.info(`expand "${expandSelector}": ${subtree.length} chars`);

        turnSubActions.push({
          index: ++globalSubActionIndex,
          action,
          durationMs: Date.now() - subStartTime,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          timestamp: new Date().toISOString(),
        });
        // Force needs_reeval so the AI sees the expanded content on the next turn
        aiResponse.needs_reeval = true;
        continue;
      }

      // ── Browser action types ─────────────────────────────────────────────────
      // Capture a pre-action page signal (cheap URL + DOM fingerprint) so we can
      // detect "did anything actually change" after the action runs. Skip for
      // observational / control-flow actions that don't mutate the page.
      const preSignal = isMutatingAction(action)
        ? await capturePageSignal(page).catch(() => undefined)
        : undefined;

      const result = await executeAction(page, action, baseUrl);
      const subDuration = Date.now() - subStartTime;

      // Post-action settle: waits for the page to reflect the action's effect
      // (SPA route swap, redirect chain, toast render, etc.) before we capture
      // the next snapshot. Exits early on "no change at all" (no-op) or once
      // the signal has been stable for settleMs. See waitForPostActionSettle.
      if (preSignal && result.success) {
        await waitForPostActionSettle(page, { preSignal }).catch(() => {
          /* settle errors are non-fatal — proceed to capture post-state */
        });
      }

      // Store captured value from "read" / "count" actions into the live parameter map
      if (result.capturedValue !== undefined && action.as && opts.resolvedParameters) {
        opts.resolvedParameters[action.as] = result.capturedValue;
        logger.info(`Stored captured value as "{{${action.as}}}": "${result.capturedValue}"`);
      }

      // Capture state after action (full-page for report visibility)
      const postDom = await captureDomSnapshot(page, { collapseRepetitiveDom: config.browser.collapseRepetitiveDom, compactSvg: config.browser.compactSvg }).catch(() => '');
      const postShot = await captureScreenshot(page, config.browser.fullPageScreenshots);
      const postShotBase64 = postShot?.base64;
      const postUrl = page.url();
      const domSnapshotVal = config.reports.includeDomSnapshots ? postDom : undefined;
      turnSubActions.push({
        index: ++globalSubActionIndex,
        action,
        ...(postShotBase64 !== undefined && { screenshotBase64: postShotBase64 }),
        ...(domSnapshotVal !== undefined && { domSnapshot: domSnapshotVal }),
        ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
        durationMs: subDuration,
        ...(result.error !== undefined && { error: result.error }),
        pageUrl: postUrl,
        timestamp: new Date().toISOString(),
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

        // Build list of actions that succeeded before this failure
        const currentTurnSucceeded = aiResponse.actions
          .slice(0, aiResponse.actions.indexOf(action))
          .filter((a) => a.action !== 'assert' && a.action !== 'prompt')
          .map((a) => ({ action: a.action, description: a.description }));
        const allSucceeded = [
          ...allCompletedActions.map((a) => ({ action: a.action, description: a.description })),
          ...currentTurnSucceeded,
        ];

        // Collect failure context so retry gets richer info
        const currentUrl = page.url();
        collectedFailures.push({
          selector: result.failedSelector ?? action.selector ?? '',
          error: result.error ?? 'Unknown error',
          ...(result.matchCount !== undefined && { matchCount: result.matchCount }),
          actionType: action.action,
          ...(allSucceeded.length > 0 && { completedActions: allSucceeded }),
          startUrl: attemptStartUrl,
          failureUrl: currentUrl,
          navigated: currentUrl !== attemptStartUrl,
        });
        break;
      }
    }

    // Track non-assert/prompt actions for the continuation prompt on the next turn
    allCompletedActions.push(
      ...aiResponse.actions
        .filter((a) => a.action !== 'assert' && a.action !== 'prompt')
        .map((a) => ({
          action: a.action,
          description: a.description,
          ...(a.selector ? { selector: a.selector } : {}),
        })),
    );

    // Remember whether this turn's effective action was a "wait" so next turn
    // can detect a stall (wait → nothing changed → wait again).
    lastActionWasWait = aiResponse.actions.some((a) => a.action === 'wait');

    // Finalize this turn
    allTurns.push({
      turnNumber: currentTurn,
      attemptNumber,
      timestamp: turnTimestamp,
      aiInteractions: turnAiInteractions,
      subActions: turnSubActions,
    });

    if (turnFailed) {
      throw new StepFailureError(
        turnError ?? 'Step failed',
        collectedFailures,
        allTurns,
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
        allTurns,
      );
    }

    logger.info(`Turn ${currentTurn} complete (needs_reeval=true) — starting turn ${currentTurn + 1}`);
  }

  // 9b. Evaluate assertion if step has one (runs after all turns complete successfully)
  if (!stepFailed && isAssertionStep(instruction)) {
    const MAX_ASSERTION_ATTEMPTS = 2;
    let assertionAttempt = 0;

    while (assertionResult === undefined && assertionAttempt < MAX_ASSERTION_ATTEMPTS) {
      assertionAttempt++;

      // Try assertion code cache on first attempt only
      let assertionCode = assertionAttempt === 1 && opts.stepCache
        ? await opts.stepCache.readAssertionCode(stepIndex, opts.resolvedParameters ?? {})
        : null;
      const fromCache = assertionCode !== null;

      if (!assertionCode) {
        // Cache miss or retry: capture full uncompacted DOM and ask AI to write assertion code
        const fullDom = await captureDomSnapshot(page, { collapseRepetitiveDom: false, compactSvg: false });
        const finalShot = config.ai.sendScreenshots
          ? await captureScreenshot(page, config.browser.fullPageScreenshots)
          : null;

        const assertTestInfo = formatTestInfo(testName, baseUrl);
        const codeMsg = buildAssertionCodePrompt(
          instruction,
          fullDom,
          finalShot?.base64 ?? null,
          assertTestInfo,
        );
        const assertSystemPrompt = buildSystemPrompt(contextContent, lastApiContext, {
          dismissalGuidance: opts.dismissalGuidance ?? false,
        });
        const codeCompletion = await aiClient.complete([
          { role: 'system', content: assertSystemPrompt },
          codeMsg,
        ]);

        assertionAiInteraction = {
          purpose: 'assertion',
          attemptNumber,
          requestMessages: [
            { role: 'system', content: extractTextFromMessage({ role: 'system', content: assertSystemPrompt }) },
            { role: 'user', content: extractTextFromMessage(codeMsg) },
          ],
          response: codeCompletion.text,
          model: codeCompletion.model,
          ...(finalShot?.base64 !== undefined && { screenshotBase64: finalShot.base64 }),
          pageUrl: page.url(),
          timestamp: new Date().toISOString(),
        };

        assertionCode = parseAssertionCode(codeCompletion.text);
        if (opts.stepCache) {
          await opts.stepCache.writeAssertionCode(stepIndex, assertionCode, opts.resolvedParameters ?? {});
        }
      }

      // Run the assertion code in the browser
      let evalResult: { pass: boolean; actual: string } | null = null;
      try {
        evalResult = await page.evaluate(assertionCode) as { pass: boolean; actual: string } | null;
        if (!evalResult || typeof evalResult.pass !== 'boolean' || typeof evalResult.actual !== 'string') {
          throw new Error(`Assertion code returned unexpected shape: ${JSON.stringify(evalResult)}`);
        }
      } catch (codeErr) {
        logger.warn(`Assertion code failed (attempt ${assertionAttempt}/${MAX_ASSERTION_ATTEMPTS}): ${String(codeErr)}`);
        if (opts.stepCache) await opts.stepCache.invalidateAssertionCode(stepIndex);
        if (assertionAttempt >= MAX_ASSERTION_ATTEMPTS) {
          throw new Error(`Assertion code failed after ${MAX_ASSERTION_ATTEMPTS} attempts: ${String(codeErr)}`);
        }
        continue;
      }

      assertionResult = {
        pass: evalResult.pass,
        actual: evalResult.actual,
        expected: instruction,
        explanation: evalResult.pass
          ? 'Assertion passed'
          : `Assertion failed — got: ${evalResult.actual}`,
        fromCache,
        assertionCode,
      };

      logger.assertion(evalResult.pass, evalResult.actual, instruction);

      if (!evalResult.pass) {
        stepFailed = true;
        stepError = `Assertion failed: ${assertionResult.explanation}`;
      }
    } // end while
  } // end isAssertionStep

  } catch (err) {
    if (err instanceof StepFailureError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new StepFailureError(message, collectedFailures, allTurns);
  } finally {
    for (const t of activityTrackers.values()) t.dispose();
    activityTrackers = new Map();
  }

  const durationMs = Date.now() - startTime;

  if (stepFailed) {
    throw new StepFailureError(stepError ?? 'Step failed', collectedFailures, allTurns);
  }

  // Capture end-of-step screenshot (full-page for report visibility)
  const endScreenshot = await captureScreenshot(page, config.browser.fullPageScreenshots);
  const endScreenshotBase64 = endScreenshot?.base64;
  const endPageUrl = page.url();

  const domSnapshotForStep = config.reports.includeDomSnapshots ? firstTurnDomSnapshot : undefined;
  return {
    index: stepIndex,
    instruction,
    status: 'passed',
    turns: allTurns,
    ...(assertionResult !== undefined && { assertion: assertionResult }),
    ...(assertionAiInteraction !== undefined && { assertionAiInteraction }),
    ...(endScreenshotBase64 !== undefined && { screenshotBase64: endScreenshotBase64 }),
    pageUrl: endPageUrl,
    ...(domSnapshotForStep !== undefined && { domSnapshot: domSnapshotForStep }),
    durationMs,
    retried,
    aiExplanation: lastAiResponse?.reasoning ?? 'No reasoning provided',
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

/**
 * Execute a group of conditional steps as a multi-outcome branch.
 *
 * Waits for the page to settle, then asks the AI which outcome appeared and
 * executes the matching step. Steps that don't match are marked "skipped".
 *
 * Returns one StepResult per step in the group plus the index of the last
 * step consumed (so the caller can skip ahead).
 */
export async function executeBranchedStep(
  group: StepGroup,
  totalSteps: number,
  opts: StepExecutorOptions,
): Promise<StepResult[]> {
  const startTime = Date.now();
  const { config, aiClient, contextContent, testName, baseUrl, conversationHistory, pageTracker } = opts;
  const page = pageTracker ? pageTracker.getActive() : opts.page;
  const timeout = config.execution.timeout * 1000; // seconds → ms
  const pollInterval = 3000; // 3s between polls
  const deadline = Date.now() + timeout;

  // Build outcome labels: conditionals first, then continuation
  const outcomes: BranchOutcome[] = [];
  const labelMap = new Map<string, { index: number; instruction: string; isConditional: boolean }>();
  let labelChar = 65; // 'A'

  for (const cs of group.conditionalSteps) {
    const label = String.fromCharCode(labelChar++);
    outcomes.push({ label, instruction: cs.instruction, isConditional: true });
    labelMap.set(label, { index: cs.index, instruction: cs.instruction, isConditional: true });
  }
  {
    const label = String.fromCharCode(labelChar);
    outcomes.push({ label, instruction: group.continuationStep.instruction, isConditional: false });
    labelMap.set(label, { index: group.continuationStep.index, instruction: group.continuationStep.instruction, isConditional: false });
  }

  logger.info(`Branched step: ${outcomes.length} outcomes (${group.conditionalSteps.length} conditional + 1 continuation)`);

  // Wait for page stability before the first evaluation
  await waitForPageStability(page, {
    timeoutMs: Math.min(10_000, timeout),
    quiesceMs: 1000,
  });

  // Polling loop: ask AI which outcome matches
  let matched: BranchedAIResponse | null = null;
  let pollCount = 0;
  const maxPolls = Math.max(1, Math.ceil(timeout / pollInterval));

  while (Date.now() < deadline && pollCount < maxPolls) {
    pollCount++;

    const domSnapshot = await captureDomSnapshot(page, { collapseRepetitiveDom: config.browser.collapseRepetitiveDom, compactSvg: config.browser.compactSvg });
    const screenshot = await captureScreenshot(page, config.browser.fullPageScreenshots);
    const screenshotBase64 = screenshot?.base64;

    const openPages = pageTracker && pageTracker.count > 1
      ? await pageTracker.getPageListWithTitles()
      : undefined;

    const screenshotForAi = config.ai.sendScreenshots ? (screenshotBase64 ?? null) : null;
    const branchedTestInfo = formatTestInfo(
      testName,
      baseUrl,
      group.conditionalSteps[0]!.index,
      totalSteps,
      config.browser.headed ? config.browser.windowSize : config.browser.viewport,
    );
    const userMessage = buildBranchedStepMessage(
      outcomes,
      domSnapshot,
      screenshotForAi,
      conversationHistory,
      openPages,
      branchedTestInfo,
    );

    const systemPrompt = buildSystemPrompt(contextContent, undefined, {
      dismissalGuidance: opts.dismissalGuidance ?? false,
    });

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      userMessage,
    ];

    const { text: rawResponse } = await aiClient.complete(messages);
    const branchedResponse = parseBranchedResponse(rawResponse);

    logger.debug(`Branch poll ${pollCount}: matched="${branchedResponse.matched}" — ${branchedResponse.reasoning}`);

    if (branchedResponse.matched !== 'waiting') {
      matched = branchedResponse;
      break;
    }

    // Wait before polling again
    if (Date.now() + pollInterval < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      // Wait for any page changes to settle
      await waitForPageStability(page, {
        timeoutMs: Math.min(5000, deadline - Date.now()),
        quiesceMs: 500,
      });
    }
  }

  // Build results
  const results: StepResult[] = [];

  if (!matched) {
    // Timed out waiting — fail all steps in the group
    const durationMs = Date.now() - startTime;
    for (const cs of group.conditionalSteps) {
      results.push({
        index: cs.index,
        instruction: cs.instruction,
        status: 'failed',
        turns: [],
        durationMs,
        retried: false,
        error: `Branched step timed out after ${pollCount} polls — page never settled into a recognisable state`,
        aiExplanation: 'Timed out waiting for page to settle into one of the expected outcomes',
      });
    }
    results.push({
      index: group.continuationStep.index,
      instruction: group.continuationStep.instruction,
      status: 'failed',
      turns: [],
      durationMs,
      retried: false,
      error: 'Branched step timed out — continuation not reached',
      aiExplanation: 'Timed out waiting for conditional resolution',
    });
    return results;
  }

  // Matched an outcome — execute it through the normal step executor
  const matchedOutcome = labelMap.get(matched.matched.toUpperCase());
  if (!matchedOutcome) {
    // AI returned an unexpected label — treat as failure
    const durationMs = Date.now() - startTime;
    for (const cs of group.conditionalSteps) {
      results.push({
        index: cs.index,
        instruction: cs.instruction,
        status: 'failed',
        turns: [],
        durationMs,
        retried: false,
        error: `AI returned unknown outcome label "${matched.matched}"`,
        aiExplanation: matched.reasoning,
      });
    }
    return results;
  }

  logger.info(`Branched step resolved: outcome ${matched.matched} → step ${matchedOutcome.index} "${matchedOutcome.instruction}"`);

  // Execute the matched step normally (the AI already returned actions)
  let matchedResult: StepResult;
  if (matched.actions.length > 0) {
    // Execute the actions the AI returned in the branch response
    matchedResult = await executeStep(
      matchedOutcome.index,
      totalSteps,
      matchedOutcome.instruction,
      opts,
    );
  } else {
    // No actions needed (e.g. continuation step = "Wait for dashboard" and dashboard is already loaded)
    matchedResult = {
      index: matchedOutcome.index,
      instruction: matchedOutcome.instruction,
      status: 'passed',
      turns: [],
      durationMs: Date.now() - startTime,
      retried: false,
      aiExplanation: matched.reasoning,
    };
  }

  // Build results for all steps in the group
  for (const cs of group.conditionalSteps) {
    if (cs.index === matchedOutcome.index) {
      results.push(matchedResult);
    } else {
      results.push({
        index: cs.index,
        instruction: cs.instruction,
        status: 'skipped',
        turns: [],
        durationMs: 0,
        retried: false,
        aiExplanation: `Skipped: outcome ${matched.matched} matched instead`,
      });
    }
  }

  // Continuation step
  if (group.continuationStep.index === matchedOutcome.index) {
    results.push(matchedResult);
  } else if (matchedOutcome.isConditional) {
    // A conditional was matched — still need to execute the continuation step after
    const contResult = await executeStep(
      group.continuationStep.index,
      totalSteps,
      group.continuationStep.instruction,
      opts,
    );
    results.push(contResult);
  } else {
    // Continuation was the matched outcome (no conditional fired)
    results.push(matchedResult);
  }

  return results;
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

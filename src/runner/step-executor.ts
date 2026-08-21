import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Browser, BrowserContext, Page } from 'playwright';
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
import type { PriorFailureContext, RetryDiagnostics, ApiPromptContext, BranchOutcome, ScrollPositionInfo } from '../ai/prompts.js';
import { diagnosePageState, waitForPageStability, waitForPostActionSettle, capturePageSignal, PageActivityTracker } from '../browser/page-state.js';
import type { PageStateDiagnosis } from '../browser/page-state.js';
import type { ChatMessage } from '../ai/types.js';
import { parseAIResponse, parseAssertionCode, parseBranchedResponse } from '../ai/action-parser.js';
import { captureDomSnapshot, findInDom, expandDomSubtree, formatFindResults, formatExpandResult } from '../browser/dom-cleaner.js';
import { captureScreenshot } from '../browser/screenshot.js';
import { executeAction } from '../browser/actions.js';
import { launchBrowser, type PageTracker, type BrowserTracker, type LaunchOverrides } from '../browser/manager.js';
import { withRetry } from './retry.js';
import { runInteractiveRepl } from './interactive-repl.js';
import type { InteractiveReader } from './interactive-repl.js';
import { logger, traceOp } from '../utils/logger.js';
import { callApiStandalone, callApiBrowserContext } from '../api/client.js';
import { extractCsrfToken } from '../api/csrf-handler.js';
import type { ApiResponseStore } from '../api/response-store.js';
import type { StepCache, CachedStepData, StepCacheKey } from '../cache/step-cache.js';
import { fingerprintAssertion } from '../cache/step-cache.js';
import type { CodeBehindBinding } from '../codebehind/loader.js';
import { entrySourceText, runCodeBehindEntry } from '../codebehind/execute.js';
import { generateCodeBehind } from '../codebehind/generate.js';
import type { StepGroup } from './step-grouper.js';
import type { AssertionResult } from '../report/types.js';

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
  /** Tracks all opened browser sessions — enables openBrowser/switchBrowser/
   *  closeBrowser actions. When undefined, only the single browser passed via
   *  `page`/`pageTracker` is in play (back-compat with single-browser tests). */
  browserTracker?: BrowserTracker;
  /** Pre-initialized step cache — always present; action caching gated by cacheEnabled */
  stepCache?: StepCache;
  /** When true, step action responses are read from / written to the step cache */
  cacheEnabled?: boolean;
  /** On-disk cache identity for this step's files (`step-<cacheKey>.json`). The
   *  server passes a frame-scoped key (`f1-17`) so skill-body steps and repeated
   *  invocations don't collide on a shared source line (issue 016). When absent
   *  (CLI path), the cache falls back to `stepIndex` — the legacy behaviour. */
  cacheKey?: StepCacheKey;
  /** When true, include dismissal-related guidance in the system prompt and
   *  retry hints. Enabled by the runner when the test has hooks configured. */
  dismissalGuidance?: boolean;
  /** Full ordered step list for the test. Forwarded to the AI clarification
   *  REPL so its `/list` and `/resume` menus can drive the outer step loop.
   *  Optional — when absent, the REPL still works but `/resume` only allows
   *  the immediate-next-step default. */
  testSteps?: string[];
  /** When true, there is no interactive console attached to this run (e.g.
   *  it's driven by the Sessions API server, not the CLI). The AI
   *  clarification prompt reads its answer from `process.stdin` via
   *  `readline`; with no console that blocks forever and hangs the run. In
   *  this mode a clarification request fails the step fast instead, with the
   *  AI's question surfaced as the error so the client can show it. See
   *  issues/014. */
  nonInteractive?: boolean;
  /** Run abort signal (client "stop"). Threaded into every AI call so an
   *  in-flight request cancels immediately, checked at the top of each turn so a
   *  stopped step stops spawning turns, and consulted in the catch so an aborted
   *  step reports as aborted (not a spurious failure). See issues/020. */
  signal?: AbortSignal;
  /**
   * This step's code-behind binding, resolved at test load
   * (stories/step-codebehind.md). When it carries an entry, the entry runs in
   * place of the AI; when it doesn't, it names where a generated entry would
   * go. Mutable: a failing entry is discarded here for the rest of the run.
   */
  codeBehind?: CodeBehindBinding;
  /**
   * `codebehind.generate` for the project this test belongs to. On the server
   * path this MUST come from the per-request project bundle, not the server's
   * startup config — a per-project value read off startup config silently
   * no-ops (the trap `resolveProjectBundle` exists to avoid).
   */
  codeBehindGenerate?: boolean;
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


/**
 * Whether **this page** belongs to a browser with a window a human can watch.
 *
 * Asked of the page rather than of the run, because `openBrowser` can override
 * `headed` per browser: one run can hold a headed browser and a headless one at
 * the same time, and "should this window be raised" is a question about the
 * window, not about the run.
 *
 * **Identified by context, and that is the point.** An earlier version read
 * `browserTracker.getActive()`, which is a *different browser* from the one
 * whose tab is being raised: `switchPage` and `openPage` resolve through
 * `opts.pageTracker` — the tracker the step executor was handed — while
 * `add()` auto-promotes the active pointer to whatever `openBrowser` opened
 * last. So a headed run that opened a headless worker browser and then ran
 * `switchTab` consulted the worker, concluded headless, and left the tab
 * unraised on the browser the human was actually watching. A page belongs to
 * exactly one `BrowserContext`, so comparing contexts asks about the right
 * browser however the pointers happen to sit.
 *
 * Falls back to the shared config for the single-browser paths (and the tests)
 * that synthesize a session without going through `launchBrowser`, and for the
 * case where nothing tracked owns this page.
 */
function isPageHeaded(page: Page, opts: StepExecutorOptions): boolean {
  try {
    const context = page.context();
    for (const session of opts.browserTracker?.all() ?? []) {
      if (session.context === context && session.headed !== undefined) return session.headed;
    }
  } catch {
    // `page.context()` throws on a closed page, and `all()` is absent on the
    // hand-built trackers older tests pass. The config is the right answer
    // then, not a crash inside a focus call.
  }
  return opts.config.browser.headed;
}

/**
 * Bring the tab the automation just moved to onto the screen
 * (stories/cdp-tab-focus.md §4).
 *
 * `switchToAsync` moves the tracker's index and returns the Page; nothing
 * raises it. In a headed run that means a `switchTab` step moves the
 * automation *behind* the tab the user is looking at, and the visible tab
 * stops changing while the run continues.
 *
 * **Gated on headed, in both browser modes** — not headed-CDP-only. `headed`
 * defaults to true, a launch-mode run's pages open as tabs in one visible
 * window, and a human watching that has the identical complaint. Headless is
 * the only place the call is pointless, and the only thing it is gated
 * against.
 *
 * Lives here rather than inside `switchToAsync` for layering: `PageTracker`'s
 * constructor takes `(page, ignoredPages)` and knows nothing about headedness
 * or CDP, while the step executor already holds the config and can reach the
 * browsers.
 *
 * Non-fatal, like every other `bringToFront` in the codebase: an OS that
 * declines to raise a window must not fail a step that otherwise worked.
 */
async function showTab(page: Page, opts: StepExecutorOptions): Promise<void> {
  if (!isPageHeaded(page, opts)) return;
  try {
    await page.bringToFront();
  } catch {
    /* non-fatal */
  }
}

/**
 * Snapshot the current state of the browser tracker into the shape
 * `formatTestInfo` consumes. Returns undefined when single-browser mode is
 * in play (no tracker, or only one session) so the prompt's browser block
 * stays empty for those tests.
 */
function buildActiveBrowserInfo(tracker: BrowserTracker | undefined) {
  if (!tracker || tracker.count <= 1) return undefined;
  const list = tracker.list();
  const active = list.find((b) => b.isActive);
  if (!active) return undefined;
  const others = list.filter((b) => !b.isActive).map((b) => ({
    label: b.label,
    engine: b.engine,
    ...(b.channel !== undefined && { channel: b.channel }),
  }));
  return {
    label: active.label,
    engine: active.engine,
    ...(active.channel !== undefined && { channel: active.channel }),
    others,
  };
}

/**
 * Read the document scroller's geometry, for the scroll-position line in the
 * step/continuation messages.
 *
 * Non-fatal by the same policy as screenshot capture: a page mid-navigation (or
 * one that has gone away) yields `undefined`, and the message simply carries no
 * position line that turn rather than the step failing over it.
 */
async function captureScrollPosition(page: Page): Promise<ScrollPositionInfo | undefined> {
  try {
    return await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = (globalThis as any).document;
      const el = doc.scrollingElement ?? doc.documentElement;
      return {
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      };
    }) as ScrollPositionInfo;
  } catch (err) {
    logger.debug(`Scroll position capture failed: ${String(err)}`);
    return undefined;
  }
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
  // Cache files are named by the frame-scoped key when the server supplies one
  // (skill-body steps, repeated invocations); otherwise by stepIndex (CLI path).
  const cacheKey: StepCacheKey = opts.cacheKey ?? stepIndex;

  // --- Code-behind attempt (ahead of the cache) ---
  //
  // Order matters and is the story's: a step with an entry runs as code with
  // no model call, no DOM snapshot and no stall detection — the same bypasses
  // a cache hit gets — and it neither reads nor writes the action cache.
  const binding = opts.codeBehind;
  if (binding?.entry && binding.entry.ai !== true) {
    const codeResult = await runCodeBehindStep(stepIndex, instruction, binding, opts, startTime);
    if (codeResult) return codeResult;
    // Fell through: the entry threw and has been discarded for this run. The
    // page is already in the right state, so the AI flow below starts clean —
    // exactly the contract the cache's invalidate-and-fall-through has.
  }

  // --- Cache attempt (before normal AI flow) ---
  if (opts.stepCache && opts.cacheEnabled) {
    const cached = await opts.stepCache.read(cacheKey, opts.resolvedParameters ?? {});
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
        // Mark the result so the server's RunEvent emitter can attach
        // `fromCache: true` to the step:pass wire event. Without this,
        // every cache-hit step would look identical to an AI-run step on
        // the client side — and the ⚡ glyph / `(cached)` log marker
        // wouldn't render.
        return { ...result, fromCache: true };
      } catch (err) {
        logger.warn(`Cached actions failed for step ${stepIndex} — invalidating and falling through to AI`);
        await opts.stepCache.invalidateStep(cacheKey);
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
      ...(opts.signal && { signal: opts.signal }),
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
        cacheKey,
        cacheCapture.turns,
        opts.resolvedParameters ?? {},
      );
    }

    // Write the step's code-behind, when generation is on and the step has no
    // valid entry — a new step, an edited one, or one whose entry just failed
    // and was healed above. An `ai: true` entry leaves `binding.entry` set, so
    // the author's opt-out is honoured here too.
    if (opts.codeBehindGenerate && binding && !binding.entry) {
      await generateCodeBehind({
        binding,
        turns: cacheCapture.turns,
        ...(result.assertions && { assertions: result.assertions }),
        resolvedParameters: opts.resolvedParameters ?? {},
        aiClient: opts.aiClient,
        contextContent: opts.contextContent,
        testName: opts.testName,
        ...(opts.baseUrl !== undefined && { baseUrl: opts.baseUrl }),
        ...(opts.signal && { signal: opts.signal }),
      });
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

    // Aborted (client "stop") — not a real failure. Don't log it as a failure
    // or snap a failure screenshot (the page may already be closing); the run
    // loop detects `signal.aborted` after this returns and records the run as
    // aborted, bypassing the step:fail path. See issues/020.
    if (opts.signal?.aborted) {
      return {
        index: stepIndex,
        instruction,
        status: 'failed',
        turns: priorAttemptTurns,
        durationMs,
        retried: true,
        pageUrl: opts.page.url(),
        error: 'Aborted by client',
        aiExplanation: 'Step aborted by client (run stopped).',
      };
    }

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

/** The tracker's active browser session, or undefined when there is no
 *  tracker (single-browser paths and the tests that synthesize a session). */
function tryGetActiveSession(
  opts: StepExecutorOptions,
): { browser: Browser; context: BrowserContext } | undefined {
  try {
    return opts.browserTracker?.getActive();
  } catch {
    // `getActive` throws once `closeBrowser` has left zero browsers tracked.
    return undefined;
  }
}

/**
 * Run a step's code-behind entry.
 *
 * Returns a `StepResult` when the step is decided — passed, or failed by a
 * `step.expect` — and `null` when the entry threw, which discards it for the
 * rest of the run and hands the step to the AI flow with a clean slate.
 *
 * The `expect` distinction is the assertion code cache's rule, lifted: broken
 * code heals, a failed assertion fails.
 */
async function runCodeBehindStep(
  stepIndex: number,
  instruction: string,
  binding: CodeBehindBinding,
  opts: StepExecutorOptions,
  startTime: number,
): Promise<StepResult | null> {
  const entry = binding.entry;
  if (!entry) return null;
  const page = opts.pageTracker ? opts.pageTracker.getActive() : opts.page;
  const code = entrySourceText(entry);
  // Ask the tracker for the browser when there is one: `context.browser()` is
  // null for a persistent context, which is what the CDP path can hand us.
  // The `!` is the same shape `executeToolStep`'s callers already rely on for
  // the tracker-less paths.
  const active = tryGetActiveSession(opts);

  const outcome = await runCodeBehindEntry({
    binding,
    page,
    context: active?.context ?? page.context(),
    browser: active?.browser ?? page.context().browser()!,
    resolvedParameters: opts.resolvedParameters ?? {},
    ...(opts.baseUrl !== undefined && { baseUrl: opts.baseUrl }),
    label: `codebehind:${stepIndex}`,
  });

  if (outcome.status === 'failed' && !outcome.expectationFailed) {
    logger.warn(
      `Code-behind failed for step ${stepIndex} — falling through to AI: ${outcome.error ?? 'unknown error'}`,
    );
    binding.entry = undefined;
    return null;
  }

  // Same capture policy as any other step end: no DOM snapshot (nothing reads
  // it when no AI call is made), screenshot only when the user asked for
  // per-action captures or the step failed.
  const wantShot = opts.config.browser.captureScreenshotsPerAction !== false
    || outcome.status === 'failed';
  const shot = wantShot
    ? await captureScreenshot(page, opts.config.browser.fullPageScreenshots)
    : null;

  const base: StepResult = {
    index: stepIndex,
    instruction,
    status: outcome.status,
    turns: [],
    durationMs: Date.now() - startTime,
    retried: false,
    pageUrl: page.url(),
    ...(shot?.base64 !== undefined && { screenshotBase64: shot.base64 }),
    fromCodeBehind: true,
    codeBehind: { file: binding.file, code, logs: outcome.logs },
  };

  if (outcome.status === 'passed') {
    logger.success(`Step ${stepIndex} passed (code-behind)`);
    return { ...base, aiExplanation: 'Ran this step\'s code-behind — no AI call.' };
  }

  logger.error(`Step ${stepIndex} FAILED (code-behind assertion): ${outcome.error ?? ''}`);
  return {
    ...base,
    error: outcome.error ?? 'Code-behind expectation failed',
    aiExplanation:
      'A `step.expect` in this step\'s code-behind failed. That is a real ' +
      'assertion failure, not broken code, so the step was not re-run under AI.',
  };
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

  /** Accumulated assertion results across all turns of this step */
  const assertionResults: AssertionResult[] = [];
  /** Running counter for assertIndex within this step (0-based) */
  let assertCounter = 0;
  let stepFailed = false;
  let stepError: string | undefined;
  let completedTurns = 0;
  /** Set when the user takes control inside the AI clarification REPL. The post-loop
   *  return uses this to short-circuit with the right `runnerControl` payload so the
   *  test-runner doesn't double-prompt. */
  let controlSignal:
    | { kind: 'resume'; fromStepIndex: number }
    | { kind: 'exit' }
    | { kind: 'clarification-unavailable'; question: string }
    | null = null;
  /** Ad-hoc StepResults produced inside the clarification REPL (typed Flick steps,
   *  /screenshot captures). Returned via a side-channel for the runner to merge. */
  const clarificationAdHoc: StepResult[] = [];

  try {
  for (let currentTurn = 1; currentTurn <= maxTurns; currentTurn++) {
    completedTurns = currentTurn;

    // Abort check — bail before doing any work on this turn if the run was
    // stopped, so a multi-turn step stops spawning AI calls. Throwing unwinds
    // to withRetry (which won't retry an aborted op) and then to executeStep's
    // catch, which returns an aborted result. See issues/020.
    if (opts.signal?.aborted) {
      throw new DOMException('Run aborted by client', 'AbortError');
    }

    // 0. Refresh active page from tracker (handles switchPage and
    //    openBrowser/switchBrowser/closeBrowser from prior turn).
    if (opts.browserTracker) {
      try { page = opts.browserTracker.getActivePage(); }
      catch { /* no active browser — let downstream fail with clear error */ }
    } else if (pageTracker) {
      page = pageTracker.getActive();
    }
    const tracker = trackerFor(page);

    // 1b. On retry attempts, diagnose page state and auto-wait if loading
    let pageDiagnosis: PageStateDiagnosis | undefined;
    if (attemptNumber > 1 && currentTurn === 1) {
      pageDiagnosis = await traceOp(`page.diagnose (turn ${currentTurn})`, () => diagnosePageState(page));
      if (pageDiagnosis.isLoading) {
        logger.info('Page appears to be loading on retry — waiting for networkidle (up to 5s)');
        await traceOp('page.waitForLoadState networkidle (5s cap)', () =>
          page.waitForLoadState('networkidle', { timeout: 5000 }),
        ).catch(() => {
          logger.debug('networkidle wait timed out after 5s — proceeding anyway');
        });
        // Re-diagnose after waiting
        pageDiagnosis = await traceOp(`page.diagnose (post-wait, turn ${currentTurn})`, () => diagnosePageState(page));
      }
    }

    // 2. Capture current page state. The DOM snapshot is *only* AI input —
    // once a turn is served from cache, the snapshot has no consumer (the
    // cached action plan was already decided, and cached assertions run
    // against the live DOM via Playwright, not against the snapshot string).
    // Skipping the snapshot on cache hits is the single biggest wall-clock
    // win for cached replays — captureDomSnapshot is typically 200ms–2s.
    //
    // Screenshots are kept on cache hits when the user has opted into the
    // per-action filmstrip (`captureScreenshotsPerAction`). The `sendScreenshots`
    // setting only feeds the AI, so it's irrelevant when we're not calling AI.
    const turnTimestamp = new Date().toISOString();
    const cachedTurnForCapture = cachedTurns?.[currentTurn - 1];
    const domSnapshot = cachedTurnForCapture
      ? ''
      : await traceOp(`captureDomSnapshot (turn ${currentTurn})`, () =>
          captureDomSnapshot(page, {
            ...config.browser.domNoiseReduction,
            maxIframeDepth: config.browser.maxIframeDepth,
            domSnapshotCharLimit: config.browser.domSnapshotCharLimit,
          }),
        );
    const wantPreTurnShot = cachedTurnForCapture
      ? config.browser.captureScreenshotsPerAction !== false
      : config.ai.sendScreenshots || config.browser.captureScreenshotsPerAction !== false;
    const screenshot = wantPreTurnShot
      ? await traceOp(`captureScreenshot (turn ${currentTurn})`, () =>
          captureScreenshot(page, config.browser.fullPageScreenshots),
        )
      : null;
    const screenshotBase64 = screenshot?.base64;
    const currentUrl = page.url();
    // Where the viewport actually is, in text. The DOM snapshot carries no
    // coordinates, so this is the model's only evidence that a scroll landed
    // when screenshots are off — or when they're full-page, and therefore
    // identical at every scroll position. Skipped on cache hits for the same
    // reason as the DOM snapshot: no AI call, so no consumer.
    const scrollPosition = cachedTurnForCapture
      ? undefined
      : await traceOp(`captureScrollPosition (turn ${currentTurn})`, () =>
          captureScrollPosition(page),
        );

    if (currentTurn === 1) {
      firstTurnDomSnapshot = domSnapshot;
    }

    // Stall detection: if the prior turn's action was a "wait" and neither the
    // page (URL + DOM) nor the network moved since then, the preceding click
    // (or whatever triggered the wait) likely didn't register. Bail out instead
    // of burning more turns. Skipped on cached turns — the cached action plan
    // is deterministic, "wait" decisions are not in play, and we don't have a
    // DOM snapshot to fingerprint against anyway.
    if (!cachedTurnForCapture) {
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
    }

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
    const systemPrompt = buildSystemPrompt(contextContent, apiContext, {
      dismissalGuidance: opts.dismissalGuidance ?? false,
    });
    const testInfo = formatTestInfo(
      testName,
      baseUrl,
      stepIndex,
      totalSteps,
      config.browser.headed ? config.browser.windowSize : config.browser.viewport,
      buildActiveBrowserInfo(opts.browserTracker),
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
        scrollPosition,
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
        scrollPosition,
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
      const completion = await traceOp(`ai.complete (turn ${currentTurn})`, () => aiClient.complete(messages, opts.signal));
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
      const question = promptAction.question ?? promptAction.description;
      if (opts.nonInteractive) {
        // No console to read an answer from (server-driven run). Asking via
        // readline would block on stdin forever and hang the test. Fail the
        // step fast, carrying the AI's question as the error so the client
        // can surface it. See issues/014.
        controlSignal = { kind: 'clarification-unavailable', question };
        allTurns.push({
          turnNumber: currentTurn,
          attemptNumber,
          timestamp: turnTimestamp,
          aiInteractions: turnAiInteractions,
          subActions: turnSubActions,
        });
        break;
      }
      const outcome = await promptUserWithReplEscape({
        question,
        page,
        testSteps: opts.testSteps ?? [],
        currentStepIndex: stepIndex,
        executorOptions: opts,
        adHocResults: clarificationAdHoc,
      });

      if (outcome.kind === 'exit' || outcome.kind === 'resume') {
        controlSignal = outcome.kind === 'exit'
          ? { kind: 'exit' }
          : { kind: 'resume', fromStepIndex: outcome.fromStepIndex };
        // Push the (incomplete) turn so the report retains the AI's question.
        allTurns.push({
          turnNumber: currentTurn,
          attemptNumber,
          timestamp: turnTimestamp,
          aiInteractions: turnAiInteractions,
          subActions: turnSubActions,
        });
        break;
      }

      const userAnswer = outcome.text;
      const clarificationMsg = buildClarificationMessage(question, userAnswer);
      const clarificationMessages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        userMessage,
        { role: 'assistant', content: rawResponse },
        clarificationMsg,
      ];
      const clarifiedCompletion = await aiClient.complete(clarificationMessages, opts.signal);
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
      if (action.action === 'prompt') continue;

      const subStartTime = Date.now();
      const aiReasoningVal = config.reports.includeAiReasoning ? aiResponse.reasoning : undefined;

      // ── assert action: evaluate inline against current page state ────────
      if (action.action === 'assert') {
        const myAssertIndex = assertCounter++;
        const condition = action.condition ?? '';
        // Preserve `undefined` for predicate mode — the fingerprint, cache,
        // and code generator all distinguish "no expected" from "expected: ''".
        const against = action.against ?? 'dom';
        const expected = against === 'predicate' ? undefined : (action.expected ?? '');
        const description = action.description;

        const assertResult = await evaluateAssertion({
          page,
          stepIndex,
          cacheKey: opts.cacheKey ?? stepIndex,
          assertIndex: myAssertIndex,
          turnNumber: currentTurn,
          subActionIndex: ++globalSubActionIndex,
          condition,
          expected,
          description,
          against,
          poll: action.poll,
          contextContent,
          testName,
          baseUrl,
          aiClient,
          stepCache: opts.stepCache,
          cacheEnabled: opts.cacheEnabled === true,
          resolvedParams: opts.resolvedParameters ?? {},
          apiResponseStore,
          attemptNumber,
          dismissalGuidance: opts.dismissalGuidance ?? false,
          fullPageScreenshots: config.browser.fullPageScreenshots,
          sendScreenshots: config.ai.sendScreenshots,
          ...(opts.signal && { signal: opts.signal }),
        });

        assertionResults.push(assertResult);

        // Record as a sub-action for execution-order interleaving in the report
        turnSubActions.push({
          index: assertResult.subActionIndex,
          action,
          durationMs: Date.now() - subStartTime,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          timestamp: new Date().toISOString(),
          ...(!assertResult.pass && { error: `Assertion failed: ${assertResult.description} — got "${assertResult.actual}"` }),
        });

        if (!assertResult.pass) {
          turnFailed = true;
          turnError = `Assertion failed: ${assertResult.description} — expected "${assertResult.expected}", got "${assertResult.actual}"`;
          break;
        }
        continue;
      }

      // ── openPage action ───────────────────────────────────────────────────
      // Spawn a brand-new tab/window at a URL the test specifies (vs. waiting
      // for the application to open one via window.open / target="_blank").
      // The new page registers automatically via context.on('page') from
      // browser/manager.ts, then we promote it to active so subsequent
      // actions in the test target it without an explicit switchPage turn.
      if (action.action === 'openPage') {
        let openError: string | undefined;
        const targetUrl = action.url ?? action.value ?? '';
        if (!targetUrl) {
          openError = 'openPage failed: no "url" field specified';
          logger.warn(openError);
        } else if (!pageTracker) {
          openError = 'openPage failed: page tracking is not enabled';
          logger.warn(openError);
        } else {
          try {
            const newPage = await page.context().newPage();
            // This session asked for this tab, so it is not an "unexpected"
            // one in the report. Needed because our own `newPage()` and
            // another session's are indistinguishable from the
            // `context.on('page')` handler's side — both arrive with a null
            // opener — and on a shared CDP browser we see both.
            pageTracker.markExpected(newPage);
            await newPage.goto(targetUrl, {
              waitUntil: 'domcontentloaded',
              timeout: 30_000,
            });
            // The context.on('page') handler in browser/manager.ts already
            // registered this page with an auto-label (`page:N`). When the
            // author supplied `as`, replace that with the custom label so
            // subsequent switchPage calls can target this page by name —
            // deterministic across re-runs and immune to "two tabs with the
            // same title" disambiguation.
            if (action.as) {
              try {
                pageTracker.relabelPage(newPage, action.as);
              } catch (relabelErr) {
                openError = `openPage failed: ${(relabelErr as Error).message}`;
                logger.warn(openError);
                await newPage.close();
                throw relabelErr;
              }
            }
            // Switching to it makes it active for the rest of this turn and
            // every subsequent step.
            const switched = await pageTracker.switchToAsync(newPage.url());
            if (switched) page = switched;
            else page = newPage;
            // A newly opened tab the run is about to drive should be the one on
            // screen (§4).
            await showTab(page, opts);
            logger.info(`Opened new page → ${newPage.url()}${action.as ? ` (as "${action.as}")` : ''}`);
          } catch (err) {
            if (!openError) {
              openError = `openPage failed: ${(err as Error).message}`;
              logger.warn(openError);
            }
          }
        }

        let openShot: string | undefined;
        let openUrl: string | undefined;
        if (openError) {
          const shot = await captureScreenshot(page, config.browser.fullPageScreenshots);
          openShot = shot?.base64;
          openUrl = page.url();
        } else {
          openUrl = page.url();
        }

        turnSubActions.push({
          index: ++globalSubActionIndex,
          action,
          durationMs: Date.now() - subStartTime,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          ...(openError !== undefined && { error: openError }),
          ...(openShot !== undefined && { screenshotBase64: openShot }),
          ...(openUrl !== undefined && { pageUrl: openUrl }),
          timestamp: new Date().toISOString(),
        });

        if (openError) {
          turnFailed = true;
          turnError = openError;
          break;
        }
        continue;
      }

      // ── openBrowser action ────────────────────────────────────────────────
      // Spawn a new isolated `Browser` instance and register it on the
      // BrowserTracker. Auto-promotes to active (mirrors openPage's
      // promote-to-active behaviour) so subsequent steps target it without
      // an explicit switchBrowser turn.
      if (action.action === 'openBrowser') {
        let openErr: string | undefined;
        if (!opts.browserTracker) {
          openErr = 'openBrowser failed: browser tracking is not enabled';
          logger.warn(openErr);
        } else if (!action.browserLabel) {
          openErr = 'openBrowser failed: missing required "as" field (label)';
          logger.warn(openErr);
        } else if (opts.browserTracker.has(action.browserLabel)) {
          openErr = `openBrowser failed: label "${action.browserLabel}" is already in use`;
          logger.warn(openErr);
        } else {
          try {
            const overrides: LaunchOverrides = {};
            if (action.engine) overrides.engine = action.engine;
            if (action.channel) overrides.channel = action.channel;
            if (action.headed !== undefined) overrides.headed = action.headed;
            // No `videoDir`: Tier 1 video records only the MAIN page. Omitting it
            // keeps secondary `openBrowser` contexts from writing stray .webm
            // files into videos/ (the report links the main page's video only).
            const newSession = await launchBrowser(config.browser, undefined, overrides);
            opts.browserTracker.add(action.browserLabel, newSession);
            // Active session changed — refresh local `page` so the rest of
            // this turn targets the new browser's active page.
            page = opts.browserTracker.getActivePage();
            logger.info(
              `Opened browser "${action.browserLabel}" (${newSession.engine ?? '?'}${newSession.channel ? '/' + newSession.channel : ''}) — auto-switched to active`,
            );
          } catch (err) {
            openErr = `openBrowser failed: ${(err as Error).message}`;
            logger.warn(openErr);
          }
        }

        turnSubActions.push({
          index: ++globalSubActionIndex,
          action,
          durationMs: Date.now() - subStartTime,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          ...(openErr !== undefined && { error: openErr }),
          pageUrl: page.url(),
          timestamp: new Date().toISOString(),
        });

        if (openErr) {
          turnFailed = true;
          turnError = openErr;
          break;
        }
        continue;
      }

      // ── switchBrowser action ─────────────────────────────────────────────
      if (action.action === 'switchBrowser') {
        let switchBrErr: string | undefined;
        if (!opts.browserTracker) {
          switchBrErr = 'switchBrowser failed: browser tracking is not enabled';
        } else if (!action.browserLabel) {
          switchBrErr = 'switchBrowser failed: missing required "to" field';
        } else {
          try {
            opts.browserTracker.switchTo(action.browserLabel);
            page = opts.browserTracker.getActivePage();
            logger.info(`Switched to browser "${action.browserLabel}" (${page.url()})`);
          } catch (err) {
            switchBrErr = `switchBrowser failed: ${(err as Error).message}`;
          }
        }
        if (switchBrErr) logger.warn(switchBrErr);

        turnSubActions.push({
          index: ++globalSubActionIndex,
          action,
          durationMs: Date.now() - subStartTime,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          ...(switchBrErr !== undefined && { error: switchBrErr }),
          pageUrl: page.url(),
          timestamp: new Date().toISOString(),
        });

        if (switchBrErr) {
          turnFailed = true;
          turnError = switchBrErr;
          break;
        }
        continue;
      }

      // ── closeBrowser action ──────────────────────────────────────────────
      // Permissive — closes whatever label you point it at, including
      // `default` and including the last remaining browser. If the close
      // leaves no active browser, the next step fails naturally with
      // `getActive()`'s "no active browser session" error.
      if (action.action === 'closeBrowser') {
        let closeBrErr: string | undefined;
        if (!opts.browserTracker) {
          closeBrErr = 'closeBrowser failed: browser tracking is not enabled';
        } else if (!action.browserLabel) {
          closeBrErr = 'closeBrowser failed: missing required "as" field';
        } else {
          try {
            await opts.browserTracker.close(action.browserLabel);
            // Best-effort: if the active browser is still alive, refresh
            // `page`. If it's not (we just closed the only browser), keep
            // the stale page reference — the following step will fail with
            // a clear error from getActive() on its next refresh.
            try { page = opts.browserTracker.getActivePage(); } catch { /* no active session */ }
            logger.info(`Closed browser "${action.browserLabel}"`);
          } catch (err) {
            closeBrErr = `closeBrowser failed: ${(err as Error).message}`;
          }
        }
        if (closeBrErr) logger.warn(closeBrErr);

        turnSubActions.push({
          index: ++globalSubActionIndex,
          action,
          durationMs: Date.now() - subStartTime,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          ...(closeBrErr !== undefined && { error: closeBrErr }),
          pageUrl: (() => { try { return page.url(); } catch { return ''; } })(),
          timestamp: new Date().toISOString(),
        });

        if (closeBrErr) {
          turnFailed = true;
          turnError = closeBrErr;
          break;
        }
        continue;
      }

      // ── switchPage action ──────────────────────────────────────────────────
      if (action.action === 'switchPage') {
        let switchError: string | undefined;
        if (pageTracker && action.page) {
          const targetPage = await pageTracker.switchToAsync(action.page);
          if (targetPage) {
            page = targetPage;
            // The tracker moved where automation goes; this moves what is on
            // screen, so a watching human sees the tab being driven (§4).
            await showTab(page, opts);
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

      const result = await traceOp(`action.${action.action}: ${action.description}`, () =>
        executeAction(page, action, baseUrl, opts.signal),
      );
      const subDuration = Date.now() - subStartTime;

      // Post-action settle: waits for the page to reflect the action's effect
      // (SPA route swap, redirect chain, toast render, etc.) before we capture
      // the next snapshot. Exits early on "no change at all" (no-op) or once
      // the signal has been stable for settleMs. See waitForPostActionSettle.
      if (preSignal && result.success) {
        await traceOp(`settle.post-action (${action.action})`, () =>
          waitForPostActionSettle(page, { preSignal }),
        ).catch(() => {
          /* settle errors are non-fatal — proceed to capture post-state */
        });
      }

      // Store captured value from "read" / "count" actions into the live parameter map
      if (result.capturedValues !== undefined && action.as && opts.resolvedParameters) {
        // List capture (read multiple: true) — JSON-encode so it round-trips
        // through the string-valued param map. Tools that declare an
        // array-typed parameter decode this back into a typed array at the
        // bridge boundary.
        const json = JSON.stringify(result.capturedValues);
        opts.resolvedParameters[action.as] = json;
        logger.info(
          `Stored ${result.capturedValues.length} captured value${
            result.capturedValues.length === 1 ? '' : 's'
          } as "{{${action.as}}}"`,
        );
      } else if (result.capturedValue !== undefined && action.as && opts.resolvedParameters) {
        opts.resolvedParameters[action.as] = result.capturedValue;
        logger.info(`Stored captured value as "{{${action.as}}}": "${result.capturedValue}"`);
      }

      // Capture state after action (full-page for report visibility).
      // Skipped on cache replay — the per-action DOM is only consumed by
      // the report's sub-action filmstrip, and matches the pre-turn rule:
      // when the AI plan came from cache, we don't pay for DOM serialisation.
      // The post-action screenshot below still runs when the user has opted
      // into the filmstrip, since that's the cheap-and-useful half.
      const postDom = cachedTurnForCapture
        ? ''
        : await traceOp(`captureDomSnapshot (post-${action.action})`, () =>
            captureDomSnapshot(page, {
              ...config.browser.domNoiseReduction,
              maxIframeDepth: config.browser.maxIframeDepth,
              domSnapshotCharLimit: config.browser.domSnapshotCharLimit,
            }),
          ).catch(() => '');
      // The post-action shot is only consumed by the report filmstrip — the AI
      // sees the next pre-turn capture rather than this one — so it gates only
      // on captureScreenshotsPerAction, not on ai.sendScreenshots.
      const postShot = config.browser.captureScreenshotsPerAction !== false
        ? await traceOp(`captureScreenshot (post-${action.action})`, () =>
            captureScreenshot(page, config.browser.fullPageScreenshots),
          )
        : null;
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

  // (Assertions are evaluated inline within the action loop above — no
  // post-turn assertion phase.)

  } catch (err) {
    if (err instanceof StepFailureError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new StepFailureError(message, collectedFailures, allTurns);
  } finally {
    for (const t of activityTrackers.values()) t.dispose();
    activityTrackers = new Map();
  }

  const durationMs = Date.now() - startTime;

  if (controlSignal && controlSignal.kind === 'clarification-unavailable') {
    // Server-driven run with no interactive console: the AI asked a
    // question we can't answer here. Fail the step with the question as the
    // error rather than blocking on stdin. See issues/014.
    return {
      index: stepIndex,
      instruction,
      status: 'failed',
      turns: allTurns,
      ...(assertionResults.length > 0 && { assertions: assertionResults }),
      pageUrl: page.url(),
      durationMs,
      retried,
      aiExplanation: `AI asked for clarification: ${controlSignal.question}`,
      error:
        `AI needs clarification, but this run has no interactive prompt ` +
        `to answer it: ${controlSignal.question}`,
    };
  }

  if (controlSignal) {
    // User took control inside the AI clarification REPL. Return a fully
    // formed StepResult with `runnerControl` set so the test-runner can
    // jump or bail without re-entering the failure-handoff REPL on top.
    const isExit = controlSignal.kind === 'exit';
    const endPageUrl = page.url();
    const adHocPayload = clarificationAdHoc.length > 0
      ? { adHocResults: clarificationAdHoc }
      : {};
    const runnerControl: StepResult['runnerControl'] = isExit
      ? { kind: 'exit', ...adHocPayload }
      : {
          kind: 'resume',
          fromStepIndex: (controlSignal as { kind: 'resume'; fromStepIndex: number }).fromStepIndex,
          ...adHocPayload,
        };
    return {
      index: stepIndex,
      instruction,
      status: isExit ? 'failed' : 'passed',
      turns: allTurns,
      ...(assertionResults.length > 0 && { assertions: assertionResults }),
      pageUrl: endPageUrl,
      durationMs,
      retried,
      aiExplanation: isExit
        ? 'User exited the AI clarification REPL'
        : `User resumed from the AI clarification REPL at step ${(controlSignal as { kind: 'resume'; fromStepIndex: number }).fromStepIndex}`,
      ...(isExit && { error: 'user exited from clarification REPL' }),
      ...(controlSignal.kind === 'resume' && { interactiveResumed: true }),
      runnerControl,
    };
  }

  if (stepFailed) {
    throw new StepFailureError(stepError ?? 'Step failed', collectedFailures, allTurns);
  }

  // Capture end-of-step screenshot (full-page for report visibility).
  // Gated by captureScreenshotsPerAction so users can fully suppress non-failure
  // captures. On-failure / diagnose captures still fire.
  const endScreenshot = config.browser.captureScreenshotsPerAction !== false
    ? await captureScreenshot(page, config.browser.fullPageScreenshots)
    : null;
  const endScreenshotBase64 = endScreenshot?.base64;
  const endPageUrl = page.url();

  const domSnapshotForStep = config.reports.includeDomSnapshots ? firstTurnDomSnapshot : undefined;
  return {
    index: stepIndex,
    instruction,
    status: 'passed',
    turns: allTurns,
    ...(assertionResults.length > 0 && { assertions: assertionResults }),
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

interface EvaluateAssertionParams {
  page: Page;
  stepIndex: number;
  /** Frame-scoped on-disk cache id for this step's assertion files
   *  (`step-<cacheKey>-asserts.json`); see `StepExecutorOptions.cacheKey`.
   *  Distinct from `stepIndex`, which is the display/source line. */
  cacheKey: StepCacheKey;
  assertIndex: number;
  turnNumber: number;
  subActionIndex: number;
  condition: string;
  expected: string | undefined;
  description: string;
  against: 'dom' | 'api' | 'both' | 'predicate';
  poll: { timeoutMs?: number; intervalMs?: number } | undefined;
  contextContent: string;
  testName: string;
  baseUrl: string | undefined;
  aiClient: AiClient;
  stepCache: StepCache | undefined;
  cacheEnabled: boolean;
  resolvedParams: Record<string, string>;
  apiResponseStore: ApiResponseStore | undefined;
  attemptNumber: number;
  dismissalGuidance: boolean;
  fullPageScreenshots: boolean;
  sendScreenshots: boolean;
  /** Run abort signal — forwarded to the assertion code-gen AI call. See issues/020. */
  signal?: AbortSignal;
}

const DEFAULT_POLL_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const MAX_ASSERTION_CODE_ATTEMPTS = 2;

/**
 * Evaluate a single `assert` action inline against the current page state.
 *
 * Cache-first: looks up cached JS code by (stepIndex, assertIndex, fingerprint).
 * On a cache hit, runs `page.evaluate(code)` directly — zero AI calls.
 * On a miss, asks the AI for evaluation code, caches it, runs it.
 *
 * If `poll` is set, the JS code is re-run in a loop until `pass: true` or the
 * timeout. If the JS throws or returns the wrong shape, the cached code is
 * invalidated and regenerated — up to 2 attempts.
 */
async function evaluateAssertion(p: EvaluateAssertionParams): Promise<AssertionResult> {
  const fingerprint = fingerprintAssertion(p.condition, p.expected, p.assertIndex);

  // 1. Try cache
  let assertionCode: string | null = null;
  let fromCache = false;
  if (p.stepCache && p.cacheEnabled) {
    assertionCode = await p.stepCache.readAssertion(p.cacheKey, p.assertIndex, fingerprint, p.resolvedParams);
    fromCache = assertionCode !== null;
  }

  let aiInteraction: AiInteraction | undefined;
  let evalResult: { pass: boolean; actual: string } | null = null;
  let lastErr: string | undefined;

  for (let attempt = 1; attempt <= MAX_ASSERTION_CODE_ATTEMPTS; attempt++) {
    // 2. Generate code on cache miss / regenerate on failure
    if (!assertionCode) {
      // Predicate mode: nothing in the DOM or API needs to be fetched —
      // both sides of the comparison are already in `condition`. Skip
      // DOM capture, screenshot, and API history entirely. Saves tokens
      // and removes irrelevant context from the AI's prompt.
      const skipDomAndScreenshot = p.against === 'api' || p.against === 'predicate';
      const fullDom = skipDomAndScreenshot
        ? null
        : await captureDomSnapshot(p.page, {
            collapseRepetitiveDom: false,
            compactSvg: false,
            hideHiddenInputs: false,
            hideDisplayNoneElements: false,
            hideAriaHiddenElements: false,
            useDomAttributeAllowlist: false,
            dropUnstableIds: false,
          });
      const finalShot = p.sendScreenshots && !skipDomAndScreenshot
        ? await captureScreenshot(p.page, p.fullPageScreenshots)
        : null;

      const apiHistory = p.apiResponseStore?.hasResponses()
        ? p.apiResponseStore.formatForContext()
        : undefined;

      const codeMsg = buildAssertionCodePrompt(
        p.description,
        p.condition,
        p.expected,
        fullDom,
        finalShot?.base64 ?? null,
        apiHistory,
        p.against,
        formatTestInfo(p.testName, p.baseUrl),
      );

      const apiContext: ApiPromptContext | undefined = p.contextContent.includes('Type:')
        ? { hasApiContext: true, responseHistory: apiHistory ?? '' }
        : undefined;

      const assertSystemPrompt = buildSystemPrompt(p.contextContent, apiContext, {
        dismissalGuidance: p.dismissalGuidance,
      });
      const codeCompletion = await p.aiClient.complete([
        { role: 'system', content: assertSystemPrompt },
        codeMsg,
      ], p.signal);

      aiInteraction = {
        purpose: `assertion[${p.assertIndex}]`,
        attemptNumber: p.attemptNumber,
        requestMessages: [
          { role: 'system', content: extractTextFromMessage({ role: 'system', content: assertSystemPrompt }) },
          { role: 'user', content: extractTextFromMessage(codeMsg) },
        ],
        response: codeCompletion.text,
        model: codeCompletion.model,
        ...(finalShot?.base64 !== undefined && { screenshotBase64: finalShot.base64 }),
        pageUrl: p.page.url(),
        timestamp: new Date().toISOString(),
      };

      try {
        assertionCode = parseAssertionCode(codeCompletion.text);
      } catch (parseErr) {
        lastErr = `Could not parse assertion code: ${String(parseErr)}`;
        continue;
      }

      if (p.stepCache && p.cacheEnabled) {
        await p.stepCache.writeAssertion(
          p.cacheKey,
          p.assertIndex,
          fingerprint,
          assertionCode,
          p.resolvedParams,
        );
      }
    }

    // 3. Run the JS — with optional polling
    try {
      evalResult = await runAssertionCode(p.page, assertionCode, p.poll);
      if (!evalResult || typeof evalResult.pass !== 'boolean' || typeof evalResult.actual !== 'string') {
        throw new Error(`Assertion code returned unexpected shape: ${JSON.stringify(evalResult)}`);
      }
      break; // success — got a structured result (pass or fail)
    } catch (codeErr) {
      lastErr = String(codeErr);
      logger.warn(`Assertion code failed (attempt ${attempt}/${MAX_ASSERTION_CODE_ATTEMPTS}): ${lastErr}`);
      if (p.stepCache) await p.stepCache.invalidateAssertion(p.cacheKey, p.assertIndex);
      assertionCode = null; // force regeneration on next loop iteration
      fromCache = false;
    }
  }

  if (!evalResult) {
    throw new Error(`Assertion code failed after ${MAX_ASSERTION_CODE_ATTEMPTS} attempts: ${lastErr ?? 'unknown error'}`);
  }

  logger.assertion(evalResult.pass, evalResult.actual, p.description);

  // Predicate-mode failures don't have a literal `expected` to quote — the
  // explanation references the predicate text itself instead.
  const failureExplanation = p.against === 'predicate'
    ? `Predicate "${p.condition}" was false: ${evalResult.actual}`
    : `Expected "${p.expected ?? ''}", got "${evalResult.actual}"`;

  return {
    assertIndex: p.assertIndex,
    turnNumber: p.turnNumber,
    subActionIndex: p.subActionIndex,
    description: p.description,
    condition: p.condition,
    expected: p.expected,
    against: p.against,
    actual: evalResult.actual,
    pass: evalResult.pass,
    explanation: evalResult.pass ? 'Assertion passed' : failureExplanation,
    fromCache,
    ...(assertionCode !== null && { assertionCode }),
    ...(aiInteraction !== undefined && { aiInteraction }),
  };
}

/** Run assertion JS code, optionally polling until pass or timeout. */
async function runAssertionCode(
  page: Page,
  code: string,
  poll: { timeoutMs?: number; intervalMs?: number } | undefined,
): Promise<{ pass: boolean; actual: string }> {
  if (!poll) {
    return await page.evaluate(code) as { pass: boolean; actual: string };
  }

  const timeoutMs = poll.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const intervalMs = poll.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  let lastResult = await page.evaluate(code) as { pass: boolean; actual: string };
  while (!lastResult.pass && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    lastResult = await page.evaluate(code) as { pass: boolean; actual: string };
  }
  return lastResult;
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

    // Abort check — stop polling immediately if the run was stopped. See issues/020.
    if (opts.signal?.aborted) {
      throw new DOMException('Run aborted by client', 'AbortError');
    }

    const domSnapshot = await captureDomSnapshot(page, {
      ...config.browser.domNoiseReduction,
      maxIframeDepth: config.browser.maxIframeDepth,
      domSnapshotCharLimit: config.browser.domSnapshotCharLimit,
    });
    // Capture if either consumer needs it: AI (sees this frame on this poll)
    // or report (per-action filmstrip via captureScreenshotsPerAction).
    const wantPollShot = config.ai.sendScreenshots || config.browser.captureScreenshotsPerAction !== false;
    const screenshot = wantPollShot
      ? await captureScreenshot(page, config.browser.fullPageScreenshots)
      : null;
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
      buildActiveBrowserInfo(opts.browserTracker),
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

    const { text: rawResponse } = await aiClient.complete(messages, opts.signal);
    let branchedResponse: BranchedAIResponse;
    try {
      branchedResponse = parseBranchedResponse(rawResponse);
    } catch (err) {
      // The LLM occasionally returns a malformed branched response (e.g. omits
      // the required `matched` field). Treat as a failed poll and continue —
      // never let parser errors escape and crash the CLI.
      logger.warn(
        `Branch poll ${pollCount}: malformed AI response — ${(err as Error).message}. Retrying.`,
      );
      if (Date.now() + pollInterval < deadline) {
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        await waitForPageStability(page, {
          timeoutMs: Math.min(5000, deadline - Date.now()),
          quiesceMs: 500,
        });
      }
      continue;
    }

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
      // Cache by the 1-based step identity (issue 017). `matchedOutcome.index`
      // is the group's 0-based array index, but the normal step loop keys the
      // cache as `executeStep(i + 1, …)`; without this override a branched step
      // and a normal step one position apart would share `step-<n>.json`.
      // `result.index` stays 0-based for the skip/display logic below.
      { ...opts, cacheKey: matchedOutcome.index + 1 },
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
      // 1-based cache identity, matching the normal step loop (issue 017).
      { ...opts, cacheKey: group.continuationStep.index + 1 },
    );
    results.push(contResult);
  } else {
    // Continuation was the matched outcome (no conditional fired)
    results.push(matchedResult);
  }

  return results;
}

/**
 * Outcome of the AI clarification prompt. The caller switches on `kind`:
 *  - `answer`  → today's flow: build clarification message, re-call AI.
 *  - `resume`  → bubble up to the test-runner via `runnerControl.resume`.
 *  - `exit`    → bubble up to the test-runner via `runnerControl.exit`.
 */
export type ClarificationOutcome =
  | { kind: 'answer'; text: string }
  | { kind: 'resume'; fromStepIndex: number }
  | { kind: 'exit' };

export interface PromptUserWithReplEscapeContext {
  question: string;
  page: Page;
  testSteps: string[];
  /** 1-based index of the step the AI asked the question about. */
  currentStepIndex: number;
  /** Forwarded to runInteractiveRepl for ad-hoc Flick steps. */
  executorOptions: StepExecutorOptions;
  /** Accumulator for ad-hoc REPL StepResults. Caller appends them to the run. */
  adHocResults: StepResult[];
  /** Optional injected reader (tests). When set, wrapper does NOT close it. */
  reader?: InteractiveReader;
  /** Optional output sink (tests). Defaults to console.log. */
  write?: (line: string) => void;
}

/**
 * One-shot clarification prompt with a `/repl` escape hatch.
 *
 * The prompt accepts exactly two kinds of input:
 *  - `/repl` (case-insensitive) → opens the unified interactive REPL with
 *    `entryReason: 'clarification'`.
 *  - anything else → treated verbatim as the answer text and returned to the
 *    caller for the existing AI re-prompt round-trip.
 *
 * Other slash commands are NOT recognised at this prompt — typing `/exit`
 * here returns it as the literal answer. Rationale: the prompt is "the AI
 * is waiting for your answer"; mixing commands at that level blurs what
 * input the system expects. Use `/repl` to take control.
 */
export async function promptUserWithReplEscape(
  ctx: PromptUserWithReplEscapeContext,
): Promise<ClarificationOutcome> {
  const ownsReader = ctx.reader === undefined;
  const reader: InteractiveReader = ctx.reader ?? (() => {
    const rl = readline.createInterface({ input, output });
    return {
      question: (prompt: string) => rl.question(prompt),
      close: () => rl.close(),
    };
  })();
  const write = ctx.write ?? ((s: string): void => { console.log(s); });

  try {
    write('');
    write('⚠  AI needs clarification:');
    if (ctx.question) write(`  ${ctx.question}`);
    write('  Type your answer, or /repl to take control.');
    const raw = await reader.question('  Your answer: ');
    const trimmed = raw.trim();

    if (trimmed.toLowerCase() === '/repl') {
      const decision = await runInteractiveRepl({
        page: ctx.page,
        testSteps: ctx.testSteps,
        currentStepIndex: ctx.currentStepIndex,
        entryReason: 'clarification',
        clarificationQuestion: ctx.question,
        executorOptions: ctx.executorOptions,
        adHocResults: ctx.adHocResults,
        // Always hand a reader to the REPL so it doesn't open a second readline
        // on the same stdin — share whichever one we own.
        reader,
        ...(ctx.write !== undefined && { write: ctx.write }),
      });
      if (decision.kind === 'continue') return { kind: 'answer', text: '' };
      if (decision.kind === 'resume') {
        return { kind: 'resume', fromStepIndex: decision.fromStepIndex };
      }
      return { kind: 'exit' };
    }

    return { kind: 'answer', text: trimmed };
  } finally {
    if (ownsReader) {
      reader.close();
    }
  }
}

/** @deprecated Kept for callers that still want the bare prompt. New code should use `promptUserWithReplEscape`. */
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
// Suppress unused-export warning — kept intentionally as a deprecated fallback.
void promptUser;

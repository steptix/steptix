import type { Config } from '../config/types.js';
import type { StepResult } from '../report/types.js';
import { AiClient } from '../ai/client.js';
import { TokenTracker } from '../utils/tokens.js';
import { launchBrowser, closeBrowser, type BrowserSession } from '../browser/manager.js';
import { executeStep, executeBranchedStep } from '../runner/step-executor.js';
import { identifyStepGroups } from '../runner/step-grouper.js';
import { loadContextFiles } from '../context/loader.js';
import { interpolate } from '../parser/parameters.js';
import { formatStepHistoryEntry } from '../ai/prompts.js';
import { captureScreenshot } from '../browser/screenshot.js';
import { ApiResponseStore } from '../api/response-store.js';
import { parseTimeoutMs } from '../runner/test-runner.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StepRequest {
  config?: { baseUrl?: string; timeout?: string };
  steps: string[];
  parameters?: Record<string, string>;
  /**
   * Per-request environment variables (e.g. AI_API_KEY, AI_MODEL). Applied to
   * the session's config only — never written to the server's process.env, so
   * concurrent sessions and the server itself remain isolated.
   */
  env?: Record<string, string>;
  /**
   * Reserved for future breakpoint pause/resume support. Currently logged and
   * ignored — the run executes to completion.
   */
  breakpoints?: number[];
  /**
   * 1-based source-document line for each entry in `steps`. When present,
   * step events carry the original line so the client can render gutter
   * status against the document. Defaults to step index when omitted.
   */
  sourceLines?: number[];
}

/**
 * Run-time event the session manager emits per step. The streaming HTTP
 * endpoint converts these to SSE frames; the non-streaming endpoint ignores
 * them.
 */
export type RunEvent =
  | { type: 'step:start'; line: number }
  | { type: 'step:pass'; line: number; output?: string; screenshot?: string }
  | { type: 'step:fail'; line: number; error: string; screenshot?: string }
  | { type: 'output'; msg: string; kind: 'info' | 'warn' | 'error' }
  | { type: 'capture'; line: number; name: string; value: string }
  | { type: 'done'; status: 'passed' | 'failed' | 'error' | 'aborted' };

export type RunEventListener = (event: RunEvent) => void;

export interface StepResultResponse {
  step: string;
  status: 'passed' | 'failed' | 'error';
  actions: unknown[];
  screenshot: string;
  reasoning: string;
  outputs: Record<string, string>;
}

export interface StepResponse {
  sessionId: string;
  status: 'passed' | 'failed' | 'error';
  stepsCompleted: number;
  stepsTotal: number;
  results: StepResultResponse[];
  outputs: Record<string, string>;
  error: { step: number; message: string } | null;
  pageTitle: string;
}

export interface SessionState {
  sessionId: string;
  status: 'active' | 'executing' | 'queued';
  currentUrl: string;
  pageTitle: string;
  screenshot: string;
  outputs: Record<string, string>;
  totalStepsExecuted: number;
}

export interface SessionListItem {
  sessionId: string;
  status: 'active' | 'executing';
  currentUrl: string;
  pageTitle: string;
  totalStepsExecuted: number;
}

// ---------------------------------------------------------------------------
// Internal session data
// ---------------------------------------------------------------------------

/** Pattern for [input: variable_name] steps */
const INPUT_STEP_PATTERN = /^\[input:\s*\w+\]/i;

/** Pattern for [interactive] steps */
const INTERACTIVE_STEP_PATTERN = /^\[interactive\]/i;

/** Pattern for a single [output: variable_name] prefix */
const OUTPUT_PREFIX_PATTERN = /\[output:\s*(\w+)\]/gi;

interface ManagedSession {
  id: string;
  browserSession: BrowserSession;
  status: 'active' | 'executing' | 'closed';
  sessionConfig: { baseUrl?: string; timeout?: string };
  configSet: boolean;
  outputs: Record<string, string>;
  totalStepsExecuted: number;
  conversationHistory: string[];
  aiClient: AiClient;
  tokenTracker: TokenTracker;
  apiResponseStore: ApiResponseStore;
  csrfTokens: Record<string, string>;
  contextContent: string;
  queueTail: Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse all [output: varname] prefixes from a step instruction.
 * Returns the variable names and the cleaned instruction with output prefixes removed.
 */
function parseOutputPrefixes(instruction: string): {
  variables: string[];
  cleanedInstruction: string;
} {
  const variables: string[] = [];
  let cleaned = instruction;

  // Collect all [output: varname] matches
  let match: RegExpExecArray | null;
  // Reset lastIndex since the regex has the global flag
  OUTPUT_PREFIX_PATTERN.lastIndex = 0;
  while ((match = OUTPUT_PREFIX_PATTERN.exec(instruction)) !== null) {
    variables.push(match[1]!);
  }

  if (variables.length === 0) {
    return { variables: [], cleanedInstruction: instruction };
  }

  // Strip all [output: ...] prefixes from the instruction
  cleaned = instruction.replace(OUTPUT_PREFIX_PATTERN, '').trim();

  if (!cleaned) {
    cleaned = `Capture value into "${variables.join(', ')}"`;
  }

  return { variables, cleanedInstruction: cleaned };
}

/**
 * Build the enriched instruction that tells the AI to capture output values.
 * Appends `[store as: var1, var2]` matching the existing pattern from test-runner.
 */
function buildEnrichedInstruction(
  cleanedInstruction: string,
  variables: string[],
): string {
  return `${cleanedInstruction} [store as: ${variables.join(', ')}]`;
}

/**
 * Check if a step instruction is an input step or interactive step (to be skipped in API mode).
 */
function isSkippableStep(instruction: string): boolean {
  return INPUT_STEP_PATTERN.test(instruction) || INTERACTIVE_STEP_PATTERN.test(instruction);
}

/**
 * Build a per-session AiConfig with optional env overrides applied. Only
 * `apiKey` and `model` are honoured today — these are the env knobs a `.env`
 * shipped from a client realistically wants to override per session. Server
 * process.env is never mutated.
 */
function applyEnvToAiConfig(
  baseConfig: import('../config/types.js').AiConfig,
  envOverrides: Record<string, string> | undefined,
): import('../config/types.js').AiConfig {
  if (!envOverrides) return baseConfig;
  const next = { ...baseConfig };
  const apiKey = envOverrides['AI_API_KEY'];
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    next.apiKey = apiKey;
  }
  const model = envOverrides['AI_MODEL'];
  if (typeof model === 'string' && model.trim().length > 0) {
    next.model = model.trim();
  }
  return next;
}

/**
 * Check if the browser context has been closed (e.g. after a "Close the browser" step).
 */
function isBrowserClosed(browserSession: BrowserSession): boolean {
  try {
    // Accessing browser.isConnected() is the reliable way to check
    return !browserSession.browser.isConnected();
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Execute a batch of steps within a named session.
   * Creates the session on first use. Queues requests if the session is busy.
   *
   * Pass `onEvent` to receive per-step events as they happen (used by the
   * streaming endpoint). The returned promise still resolves with the full
   * StepResponse on completion.
   */
  async executeSteps(
    sessionId: string,
    request: StepRequest,
    onEvent?: RunEventListener,
    signal?: AbortSignal,
  ): Promise<StepResponse> {
    let session = this.sessions.get(sessionId);

    // If session exists but is closed, remove it so a fresh one is created
    if (session && session.status === 'closed') {
      this.sessions.delete(sessionId);
      session = undefined;
    }

    // Validate config on existing session
    if (session && request.config) {
      throw new Error(
        'Config can only be provided on the first request for a session. ' +
          'This session already has a config set.',
      );
    }

    // Create session if it does not exist. Per-request env is applied at
    // session-creation time only — once an AiClient is bound to a session,
    // changing env mid-session is intentionally not supported.
    if (!session) {
      session = await this.createSession(sessionId, request.config, request.env);
    }

    if (request.breakpoints && request.breakpoints.length > 0) {
      logger.warn(
        `Session "${sessionId}": ${request.breakpoints.length} breakpoint(s) requested but ` +
          `pause/resume is not yet implemented — run will execute to completion.`,
      );
    }

    // Queue the work onto the session's promise chain so requests execute sequentially
    const resultPromise = new Promise<StepResponse>((resolve, reject) => {
      session.queueTail = session.queueTail
        .then(() => this.executeStepsInternal(session, sessionId, request, onEvent, signal))
        .then(resolve, reject);
    });

    return resultPromise;
  }

  /**
   * Get the current state of a session. Returns null if the session does not exist.
   */
  async getSession(sessionId: string): Promise<SessionState | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'closed') {
      return null;
    }

    const page = session.browserSession.pageTracker.getActive();
    let currentUrl = '';
    let pageTitle = '';
    let screenshotBase64 = '';

    try {
      currentUrl = page.url();
      pageTitle = await page.title();
      const shot = await captureScreenshot(page);
      screenshotBase64 = shot?.base64
        ? `data:image/png;base64,${shot.base64}`
        : '';
    } catch {
      // Browser may be in an intermediate state
    }

    // Determine display status: if queueTail is still pending, we have queued work
    let displayStatus: 'active' | 'executing' | 'queued' = session.status === 'executing'
      ? 'executing'
      : 'active';

    // A rough heuristic: if executing and queueTail isn't resolved, mark as queued
    // We track this by checking if there are pending promises beyond the current execution
    // For simplicity, the session.status covers the primary state
    if (session.status === 'executing') {
      displayStatus = 'executing';
    }

    return {
      sessionId,
      status: displayStatus,
      currentUrl,
      pageTitle,
      screenshot: screenshotBase64,
      outputs: { ...session.outputs },
      totalStepsExecuted: session.totalStepsExecuted,
    };
  }

  /**
   * List all active (non-closed) sessions.
   */
  getActiveSessions(): SessionListItem[] {
    const items: SessionListItem[] = [];

    for (const [id, session] of this.sessions) {
      if (session.status === 'closed') continue;

      const page = session.browserSession.pageTracker.getActive();
      let currentUrl = '';
      let pageTitle = '';

      try {
        currentUrl = page.url();
        // page.title() is async but we need sync here; use URL as fallback
      } catch {
        // ignore
      }

      items.push({
        sessionId: id,
        status: session.status === 'executing' ? 'executing' : 'active',
        currentUrl,
        pageTitle,
        totalStepsExecuted: session.totalStepsExecuted,
      });
    }

    return items;
  }

  /**
   * List all active sessions with async page title resolution.
   */
  async getActiveSessionsWithTitles(): Promise<SessionListItem[]> {
    const items: SessionListItem[] = [];

    for (const [id, session] of this.sessions) {
      if (session.status === 'closed') continue;

      const page = session.browserSession.pageTracker.getActive();
      let currentUrl = '';
      let pageTitle = '';

      try {
        currentUrl = page.url();
        pageTitle = await page.title();
      } catch {
        // ignore
      }

      items.push({
        sessionId: id,
        status: session.status === 'executing' ? 'executing' : 'active',
        currentUrl,
        pageTitle,
        totalStepsExecuted: session.totalStepsExecuted,
      });
    }

    return items;
  }

  /**
   * Close a session: shut down the browser and remove it from the map.
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      await closeBrowser(session.browserSession);
    } catch {
      // Best effort
    }

    session.status = 'closed';
    this.sessions.delete(sessionId);
    logger.info(`Session "${sessionId}" closed and removed`);
  }

  /**
   * Close all sessions. Useful for server shutdown.
   */
  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.closeSession(id)));
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async createSession(
    sessionId: string,
    sessionConfig?: { baseUrl?: string; timeout?: string },
    envOverrides?: Record<string, string>,
  ): Promise<ManagedSession> {
    logger.info(`Creating session "${sessionId}"`);

    // Apply per-request env to a fresh ai config copy. Server's process.env is
    // never mutated; concurrent sessions stay isolated.
    const aiConfig = applyEnvToAiConfig(this.config.ai, envOverrides);

    const browserSession = await launchBrowser(this.config.browser);
    const tokenTracker = new TokenTracker();
    const aiClient = new AiClient(aiConfig, tokenTracker);
    const apiResponseStore = new ApiResponseStore();

    // Load context files once per session
    const context = await loadContextFiles(this.config.tests.contextDir);
    if (context.files.length > 0) {
      logger.info(`Session "${sessionId}": loaded ${context.files.length} context file(s)`);
    }

    // Navigate to baseUrl if provided
    if (sessionConfig?.baseUrl) {
      logger.info(`Session "${sessionId}": navigating to base URL ${sessionConfig.baseUrl}`);
      await browserSession.page.goto(sessionConfig.baseUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
    }

    const session: ManagedSession = {
      id: sessionId,
      browserSession,
      status: 'active',
      sessionConfig: sessionConfig ?? {},
      configSet: sessionConfig !== undefined,
      outputs: {},
      totalStepsExecuted: 0,
      conversationHistory: [],
      aiClient,
      tokenTracker,
      apiResponseStore,
      csrfTokens: {},
      contextContent: context.combined,
      queueTail: Promise.resolve(),
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  private async executeStepsInternal(
    session: ManagedSession,
    sessionId: string,
    request: StepRequest,
    onEvent?: RunEventListener,
    signal?: AbortSignal,
  ): Promise<StepResponse> {
    session.status = 'executing';

    const results: StepResultResponse[] = [];
    const stepsTotal = request.steps.length;
    let stepsCompleted = 0;
    let overallStatus: 'passed' | 'failed' | 'error' | 'aborted' = 'passed';
    let errorInfo: { step: number; message: string } | null = null;

    // Map a 1-based step index to the source-document line. When the client
    // doesn't supply sourceLines we echo the step index — some clients (e.g.
    // headless runners) don't track source positions.
    const sourceLineFor = (stepIndex0: number): number => {
      const explicit = request.sourceLines?.[stepIndex0];
      return typeof explicit === 'number' ? explicit : stepIndex0 + 1;
    };

    const emit = (event: RunEvent): void => {
      if (!onEvent) return;
      try {
        onEvent(event);
      } catch (err) {
        // A failing listener must not crash the run.
        logger.warn(`Session "${sessionId}": run-event listener threw: ${String(err)}`);
      }
    };

    // Build the parameter map: session outputs as base, request parameters as overrides
    const resolvedParameters: Record<string, string> = {
      ...session.outputs,
      ...(request.parameters ?? {}),
    };

    // Determine per-step timeout
    const stepTimeout = parseTimeoutMs(session.sessionConfig.timeout)
      ?? this.config.execution.timeout;

    // Detect conditional step groups for multi-outcome branching
    const stepGroups = identifyStepGroups(request.steps);

    try {
      for (let i = 0; i < request.steps.length; i++) {
        // Check abort BEFORE starting each step. We don't try to interrupt
        // a step mid-flight (Playwright actions / AI calls aren't reliably
        // cancelable today) — between-step granularity is the contract.
        if (signal?.aborted) {
          overallStatus = 'aborted';
          logger.info(`Session "${sessionId}": run aborted by client at step ${i + 1}/${stepsTotal}`);
          break;
        }
        const originalStep = request.steps[i]!;

        // Interpolate {{variable}} placeholders
        const interpolated = interpolate(originalStep, resolvedParameters);

        // Check if this step is part of a conditional group
        const group = stepGroups.get(i);
        if (group && i === group.conditionalSteps[0]!.index) {
          logger.info(`Session "${sessionId}": conditional group at step ${i + 1}`);

          const branchedResults = await executeBranchedStep(group, stepsTotal, {
            page: session.browserSession.pageTracker.getActive(),
            config: this.config,
            aiClient: session.aiClient,
            contextContent: session.contextContent,
            testName: `session:${sessionId}`,
            ...(session.sessionConfig.baseUrl !== undefined && {
              baseUrl: session.sessionConfig.baseUrl,
            }),
            conversationHistory: [...session.conversationHistory],
            apiResponseStore: session.apiResponseStore,
            csrfTokens: session.csrfTokens,
            resolvedParameters,
            pageTracker: session.browserSession.pageTracker,
          });

          let branchFailed = false;
          for (const result of branchedResults) {
            const screenshotValue = result.screenshotBase64
              ? `data:image/png;base64,${result.screenshotBase64}`
              : '';
            const resultStatus: 'passed' | 'failed' | 'error' =
              result.status === 'skipped' ? 'passed' : result.status;

            results.push({
              step: request.steps[result.index] ?? result.instruction,
              status: resultStatus,
              actions: result.turns.flatMap((t) => t.subActions).map((sa) => sa.action),
              screenshot: screenshotValue,
              reasoning: result.aiExplanation ?? '',
              outputs: {},
            });

            let currentUrl = '';
            try {
              currentUrl = session.browserSession.pageTracker.getActive().url();
            } catch { /* ignore */ }

            session.conversationHistory.push(
              formatStepHistoryEntry(
                session.totalStepsExecuted + 1,
                result.instruction,
                result.status === 'passed',
                currentUrl,
              ),
            );
            session.tokenTracker.resetStep();
            session.totalStepsExecuted++;

            if (result.status === 'failed') {
              overallStatus = 'failed';
              errorInfo = { step: result.index, message: result.error ?? 'Step failed' };
              branchFailed = true;
            } else {
              stepsCompleted++;
            }
          }

          // Skip past all steps in this group
          i = group.continuationStep.index;

          if (branchFailed) break;
          continue;
        }

        if (group && i !== group.conditionalSteps[0]!.index) {
          // Part of a group but not the first — already handled
          continue;
        }

        // Check for skippable steps ([input:] and [interactive])
        if (isSkippableStep(interpolated)) {
          logger.info(`Session "${sessionId}": skipping step ${i + 1} (input/interactive not supported in API mode)`);
          emit({ type: 'step:start', line: sourceLineFor(i) });
          results.push({
            step: originalStep,
            status: 'passed',
            actions: [],
            screenshot: '',
            reasoning: 'Skipped: [input] and [interactive] steps are not supported in API mode',
            outputs: {},
          });
          emit({ type: 'step:pass', line: sourceLineFor(i), output: 'skipped' });
          stepsCompleted++;
          session.totalStepsExecuted++;
          continue;
        }

        // Parse [output: var] prefixes
        const { variables: outputVars, cleanedInstruction } = parseOutputPrefixes(interpolated);

        // Build the instruction to send to executeStep
        let stepInstruction: string;
        if (outputVars.length > 0) {
          stepInstruction = buildEnrichedInstruction(cleanedInstruction, outputVars);
        } else {
          stepInstruction = interpolated;
        }

        logger.step(
          session.totalStepsExecuted + 1,
          session.totalStepsExecuted + stepsTotal - i,
          stepInstruction,
        );

        emit({ type: 'step:start', line: sourceLineFor(i) });

        // Execute the step
        let stepResult: StepResult;
        try {
          stepResult = await executeStep(
            i + 1,
            stepsTotal,
            stepInstruction,
            {
              page: session.browserSession.pageTracker.getActive(),
              config: this.config,
              aiClient: session.aiClient,
              contextContent: session.contextContent,
              testName: `session:${sessionId}`,
              ...(session.sessionConfig.baseUrl !== undefined && {
                baseUrl: session.sessionConfig.baseUrl,
              }),
              conversationHistory: [...session.conversationHistory],
              apiResponseStore: session.apiResponseStore,
              csrfTokens: session.csrfTokens,
              resolvedParameters,
              pageTracker: session.browserSession.pageTracker,
            },
          );
        } catch (err) {
          // Unexpected error during step execution
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`Session "${sessionId}" step ${i + 1} error: ${message}`);

          // Capture screenshot on error if possible
          let errorScreenshot = '';
          try {
            const shot = await captureScreenshot(
              session.browserSession.pageTracker.getActive(),
            );
            errorScreenshot = shot?.base64
              ? `data:image/png;base64,${shot.base64}`
              : '';
          } catch {
            // ignore
          }

          results.push({
            step: originalStep,
            status: 'error',
            actions: [],
            screenshot: errorScreenshot,
            reasoning: message,
            outputs: {},
          });

          emit({
            type: 'step:fail',
            line: sourceLineFor(i),
            error: message,
            ...(errorScreenshot && { screenshot: errorScreenshot }),
          });

          overallStatus = 'error';
          errorInfo = { step: i, message };
          break;
        }

        // Collect per-step output captures from resolvedParameters
        const stepOutputs: Record<string, string> = {};
        for (const varName of outputVars) {
          if (varName in resolvedParameters) {
            stepOutputs[varName] = resolvedParameters[varName]!;
            // Accumulate into session outputs
            session.outputs[varName] = resolvedParameters[varName]!;
            // Surface the capture to streaming clients so the Variables
            // panel can update live. We only emit for values that were
            // actually set — missing extractions stay silent.
            emit({
              type: 'capture',
              line: sourceLineFor(i),
              name: varName,
              value: resolvedParameters[varName]!,
            });
          }
        }

        // Build the screenshot for the response
        const screenshotValue = stepResult.screenshotBase64
          ? `data:image/png;base64,${stepResult.screenshotBase64}`
          : '';

        // Map internal StepResult to API response format
        const resultStatus: 'passed' | 'failed' | 'error' =
          stepResult.status === 'skipped' ? 'passed' : stepResult.status;

        results.push({
          step: originalStep,
          status: resultStatus,
          actions: stepResult.turns.flatMap((t) => t.subActions).map((sa) => sa.action),
          screenshot: screenshotValue,
          reasoning: stepResult.aiExplanation ?? '',
          outputs: stepOutputs,
        });

        // Update conversation history
        let currentUrl = '';
        try {
          currentUrl = session.browserSession.pageTracker.getActive().url();
        } catch {
          // ignore
        }

        session.conversationHistory.push(
          formatStepHistoryEntry(
            session.totalStepsExecuted + 1,
            interpolated,
            stepResult.status === 'passed',
            currentUrl,
          ),
        );

        session.tokenTracker.resetStep();
        session.totalStepsExecuted++;

        if (stepResult.status === 'passed') {
          stepsCompleted++;
          logger.success(
            `Session "${sessionId}" step ${i + 1} passed`,
          );
          emit({
            type: 'step:pass',
            line: sourceLineFor(i),
            ...(stepResult.aiExplanation && { output: stepResult.aiExplanation }),
            ...(screenshotValue && { screenshot: screenshotValue }),
          });
        } else {
          // Step failed
          overallStatus = 'failed';
          errorInfo = {
            step: i,
            message: stepResult.error ?? 'Step failed',
          };
          logger.error(
            `Session "${sessionId}" step ${i + 1} FAILED: ${stepResult.error ?? 'unknown'}`,
          );
          emit({
            type: 'step:fail',
            line: sourceLineFor(i),
            error: stepResult.error ?? 'Step failed',
            ...(screenshotValue && { screenshot: screenshotValue }),
          });
          break;
        }

        // Check if the browser was closed by the step (e.g. "Close the browser")
        if (isBrowserClosed(session.browserSession)) {
          logger.info(`Session "${sessionId}": browser closed by step, removing session`);
          session.status = 'closed';
          this.sessions.delete(sessionId);
          break;
        }
      }
    } finally {
      // Restore status unless session was closed
      if (session.status !== 'closed') {
        session.status = 'active';
      }
    }

    // Resolve page title if session is still open
    let pageTitle = '';
    if (session.status !== 'closed') {
      try {
        pageTitle = await session.browserSession.pageTracker.getActive().title();
      } catch {
        // browser may be in an intermediate state
      }
    }

    emit({ type: 'done', status: overallStatus });

    return {
      sessionId,
      status: overallStatus,
      stepsCompleted,
      stepsTotal,
      results,
      outputs: { ...session.outputs },
      error: errorInfo,
      pageTitle,
    };
  }
}

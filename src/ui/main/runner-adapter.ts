/**
 * UIRunnerAdapter — wraps the existing test runner with IPC event emission,
 * breakpoint support, pointer movement, and steering for the Runner UI.
 *
 * Accepts a generic `emit(channel, data)` callback so it does not depend on
 * Electron's BrowserWindow directly.  This makes the adapter testable and
 * portable to a future WebSocket backend.
 */

import type { Page } from 'playwright';
import type { Config } from '../../config/types.js';
import type { ParsedTest, TestInstance } from '../../parser/types.js';
import type { StepResult, SubActionResult } from '../../report/types.js';
import type { MainToRendererEvents } from '../ipc-types.js';
import type { BrowserSession } from '../../browser/manager.js';

import { loadConfig } from '../../config/loader.js';
import { parseTestFile } from '../../parser/markdown.js';
import { expandTestInstances, parseTimeoutMs } from '../../runner/test-runner.js';
import { executeStep } from '../../runner/step-executor.js';
import { launchBrowser, closeBrowser } from '../../browser/manager.js';
import { loadContextFiles } from '../../context/loader.js';
import { interpolate } from '../../parser/parameters.js';
import { AiClient } from '../../ai/client.js';
import { formatStepHistoryEntry } from '../../ai/prompts.js';
import { TokenTracker } from '../../utils/tokens.js';
import { ApiResponseStore } from '../../api/response-store.js';
import { generateReport } from '../../report/generator.js';
import { setLogCallback } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Patterns mirrored from test-runner.ts (not exported there)
// ---------------------------------------------------------------------------
const INPUT_STEP_PATTERN = /^\[input:\s*(\w+)\]\s*(.*)/;
const INTERACTIVE_STEP_PATTERN = /^\[interactive\]\s*(.*)/i;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Generic event emitter callback — maps to BrowserWindow.webContents.send */
export type EmitFn = <K extends keyof MainToRendererEvents>(
  channel: K,
  data: MainToRendererEvents[K],
) => void;

/**
 * Deferred-resolution helper used to suspend the run loop when paused.
 * The adapter creates one of these each time it pauses, then awaits it.
 * External callers (resume / stepOver / stop / steer / inputResponse)
 * resolve or reject the underlying promise to unblock the loop.
 */
interface PauseHandle {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

function createPauseHandle(): PauseHandle {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class UIRunnerAdapter {
  private readonly emit: EmitFn;

  // --- Run state ---
  private running = false;
  private stopped = false;
  private breakpoints = new Set<number>();
  private stepOverNext = false;
  private currentStepIndex = 0;
  private pointerOverride: number | undefined;

  // --- Pause machinery ---
  private pauseHandle: PauseHandle | null = null;
  private currentPauseReason: 'breakpoint' | 'interactive' | 'stepover' | null = null;

  // --- Input step response ---
  private inputResolve: ((value: string) => void) | null = null;

  // --- Steering ---
  private steerResolve: ((instruction: string) => void) | null = null;

  // --- Accumulated step results (includes steering steps in execution order) ---
  private stepResults: StepResult[] = [];
  private steeringCount = 0;

  // --- Browser / AI state (set during a run) ---
  private session: BrowserSession | null = null;
  private page: Page | null = null;
  private config: Config | null = null;
  private aiClient: AiClient | null = null;
  private tokenTracker: TokenTracker | null = null;
  private apiResponseStore: ApiResponseStore | null = null;
  private contextContent = '';
  private conversationHistory: string[] = [];
  private csrfTokens: Record<string, string> = {};
  private resolvedParameters: Record<string, string> = {};
  private test: ParsedTest | null = null;

  constructor(emit: EmitFn) {
    this.emit = emit;
  }

  // -----------------------------------------------------------------------
  // Public API — called from the IPC handler
  // -----------------------------------------------------------------------

  /**
   * Start a test run.  Returns when the run is complete (or stopped).
   */
  async start(filePath: string, breakpoints: number[]): Promise<void> {
    if (this.running) return;

    this.reset();
    this.running = true;
    this.stopped = false;
    this.breakpoints = new Set(breakpoints);

    setLogCallback((level, message) => {
      this.emit('runner:log', { level, message });
    });

    try {
      await this.executeRun(filePath);
    } catch (err) {
      if (!this.stopped) {
        const message = err instanceof Error ? err.message : String(err);
        this.emit('runner:error', { message });
      }
    } finally {
      setLogCallback(null);
      await this.cleanup();
    }
  }

  /** Cancel the current run. */
  stop(): void {
    this.stopped = true;
    // Unblock any pending pause
    if (this.pauseHandle) {
      this.pauseHandle.reject(new Error('Run stopped by user'));
      this.pauseHandle = null;
    }
    // Unblock any pending input
    if (this.inputResolve) {
      this.inputResolve('');
      this.inputResolve = null;
    }
    // Unblock any pending steer wait
    if (this.steerResolve) {
      this.steerResolve('');
      this.steerResolve = null;
    }
  }

  /** Resume execution from a pause. */
  resume(): void {
    this.stepOverNext = false;
    this.unpause();
  }

  /** Execute one step then pause again. */
  stepOver(): void {
    this.stepOverNext = true;
    this.unpause();
  }

  /** Move the execution pointer to a different step (1-based). */
  movePointer(toStepIndex: number): void {
    this.pointerOverride = toStepIndex;
  }

  /** Update breakpoints mid-run. */
  updateBreakpoints(breakpoints: number[]): void {
    this.breakpoints = new Set(breakpoints);
  }

  /** Execute a manual steering instruction while paused. */
  async steer(instruction: string): Promise<void> {
    if (!this.page || !this.config || !this.aiClient || !this.test) return;

    const stepIndex = this.currentStepIndex;
    const totalSteps = this.test.steps.length;
    const resolvedInstruction = interpolate(instruction, this.resolvedParameters);

    // Emit step-start for the steering step
    this.emit('runner:step-start', {
      stepIndex,
      instruction: `(steering) ${resolvedInstruction}`,
      totalSteps,
    });

    const result = await executeStep(stepIndex, totalSteps, resolvedInstruction, {
      page: this.page,
      config: this.config,
      aiClient: this.aiClient,
      contextContent: this.contextContent,
      testName: this.test.title,
      ...(this.test.config.baseUrl !== undefined && { baseUrl: this.test.config.baseUrl }),
      conversationHistory: [...this.conversationHistory],
      ...(this.apiResponseStore != null && { apiResponseStore: this.apiResponseStore }),
      csrfTokens: this.csrfTokens,
      resolvedParameters: this.resolvedParameters,
      ...(this.session?.pageTracker && { pageTracker: this.session.pageTracker }),
    });

    // Emit sub-actions and screenshots
    this.emitStepDetails(stepIndex, result);

    // Emit AI reasoning
    if (result.aiExplanation) {
      this.emit('runner:ai-reasoning', { stepIndex, text: result.aiExplanation });
    }

    // Emit step-complete
    this.emit('runner:step-complete', {
      stepIndex,
      status: result.status === 'passed' ? 'passed' : 'failed',
      durationMs: result.durationMs,
      ...(result.error !== undefined && { error: result.error }),
    });

    // Record in step results so steering shows up in the report
    const steeringIndex = (this.test?.steps.length ?? 0) + (++this.steeringCount);
    this.stepResults.push({ ...result, index: steeringIndex, instruction: `[steering] ${resolvedInstruction}` });

    // Add to conversation history (do NOT modify test steps array)
    const currentUrl = this.page.url();
    this.conversationHistory.push(
      formatStepHistoryEntry(
        stepIndex,
        `(steering) ${resolvedInstruction}`,
        result.status === 'passed',
        currentUrl,
      ),
    );

    this.tokenTracker?.resetStep();

    // Restore paused state on the renderer — the run loop is still awaiting the pause handle
    if (this.pauseHandle && this.currentPauseReason) {
      this.emit('runner:paused', { stepIndex, reason: this.currentPauseReason });
    }
  }

  /** Respond to an [input: variable] prompt. */
  inputResponse(variable: string, value: string): void {
    this.resolvedParameters[variable] = value;
    if (this.inputResolve) {
      this.inputResolve(value);
      this.inputResolve = null;
    }
  }

  // -----------------------------------------------------------------------
  // Internal — run loop
  // -----------------------------------------------------------------------

  private async executeRun(filePath: string): Promise<void> {
    const runStartTime = Date.now();

    // 1. Load config
    this.config = await loadConfig();

    // 2. Parse the test file
    const parsedTest = await parseTestFile(filePath);
    this.test = parsedTest;

    // 3. Expand test instances (take first for the UI — no data-driven in UI v1)
    const instances = await expandTestInstances(parsedTest, this.config);
    const instance: TestInstance = instances[0]!;
    this.resolvedParameters = { ...instance.resolvedParameters };

    // 4. Launch browser
    this.session = await launchBrowser(this.config.browser);
    this.page = this.session.page;

    // 5. Load context files
    const context = await loadContextFiles(this.config.tests.contextDir);
    this.contextContent = context.combined;

    // 6. Set up AI client and token tracker
    this.tokenTracker = new TokenTracker();
    this.aiClient = new AiClient(this.config.ai, this.tokenTracker);
    this.apiResponseStore = new ApiResponseStore();

    // 7. Navigate to base URL if provided
    const baseUrl = parsedTest.config.baseUrl;
    if (baseUrl && this.page) {
      await this.page.goto(baseUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
    }

    // 8. Determine timeout
    const testTimeout =
      parseTimeoutMs(parsedTest.frontmatter.timeout ?? parsedTest.config.timeout) ??
      this.config.execution.timeout;
    const timeoutDeadline = Date.now() + testTimeout;

    // 9. Step execution loop
    this.stepResults = [];
    const totalSteps = parsedTest.steps.length;
    let bail = false;
    let i = 0;

    while (i < totalSteps) {
      if (this.stopped || bail) break;

      // Check pointer override (movePointer sets the next step)
      if (this.pointerOverride !== undefined) {
        // Convert 1-based step index to 0-based loop counter
        i = this.pointerOverride - 1;
        this.pointerOverride = undefined;
        if (i < 0 || i >= totalSteps) break;
      }

      if (Date.now() > timeoutDeadline) {
        this.emit('runner:error', {
          message: `Test timeout after ${testTimeout}ms at step ${i + 1}`,
        });
        break;
      }

      const stepIndex = i + 1; // 1-based
      this.currentStepIndex = stepIndex;

      const rawInstruction = parsedTest.steps[i] ?? '';
      const instruction = interpolate(rawInstruction, this.resolvedParameters);

      // --- Check for breakpoint or stepOverNext BEFORE executing ---
      if (this.breakpoints.has(stepIndex) || this.stepOverNext) {
        const reason = this.stepOverNext ? 'stepover' as const : 'breakpoint' as const;
        this.stepOverNext = false;
        await this.pause(stepIndex, reason);
        // After resuming, re-check stopped and pointer override
        if (this.stopped) break;
        if (this.pointerOverride !== undefined) continue; // loop will pick up override
      }

      // --- Handle [input: variable] steps ---
      const inputMatch = instruction.match(INPUT_STEP_PATTERN);
      if (inputMatch) {
        const variable = inputMatch[1]!;
        const promptText = inputMatch[2]?.trim() || `Enter value for "${variable}"`;
        const stepStartTime = Date.now();

        this.emit('runner:step-start', { stepIndex, instruction, totalSteps });

        // Pause and wait for user input
        this.emit('runner:paused', {
          stepIndex,
          reason: 'input',
          inputPrompt: promptText,
          inputVariable: variable,
        });

        const value = await this.waitForInput();
        if (this.stopped) break;

        this.resolvedParameters[variable] = value;

        this.emit('runner:resumed', {});

        const stepResult: StepResult = {
          index: stepIndex,
          instruction,
          status: 'passed',
          subActions: [],
          durationMs: Date.now() - stepStartTime,
          retried: false,
          aiExplanation: `User provided input for "${variable}"`,
        };

        this.stepResults.push(stepResult);

        this.emit('runner:step-complete', {
          stepIndex,
          status: 'passed',
          durationMs: stepResult.durationMs,
        });

        // Add to conversation history
        this.conversationHistory.push(
          formatStepHistoryEntry(stepIndex, instruction, true, this.page?.url()),
        );

        i++;
        continue;
      }

      // --- Handle [interactive] steps ---
      const interactiveMatch = instruction.match(INTERACTIVE_STEP_PATTERN);
      if (interactiveMatch) {
        this.emit('runner:step-start', { stepIndex, instruction, totalSteps });

        // Pause for interactive steering
        await this.pause(stepIndex, 'interactive');
        if (this.stopped) break;

        // Interactive step is complete when resume() is called
        const stepResult: StepResult = {
          index: stepIndex,
          instruction,
          status: 'passed',
          subActions: [],
          durationMs: 0,
          retried: false,
          aiExplanation: 'Interactive mode completed',
        };

        this.stepResults.push(stepResult);

        this.emit('runner:step-complete', {
          stepIndex,
          status: 'passed',
          durationMs: 0,
        });

        this.conversationHistory.push(
          formatStepHistoryEntry(stepIndex, instruction, true, this.page?.url()),
        );

        i++;
        continue;
      }

      // --- Normal step execution ---
      this.emit('runner:step-start', { stepIndex, instruction, totalSteps });

      const result = await executeStep(stepIndex, totalSteps, instruction, {
        page: this.page,
        config: this.config,
        aiClient: this.aiClient,
        contextContent: this.contextContent,
        testName: parsedTest.title,
        ...(baseUrl !== undefined && { baseUrl }),
        conversationHistory: [...this.conversationHistory],
        apiResponseStore: this.apiResponseStore,
        csrfTokens: this.csrfTokens,
        resolvedParameters: this.resolvedParameters,
        ...(this.session?.pageTracker && { pageTracker: this.session.pageTracker }),
      });

      // Emit sub-actions and screenshots
      this.emitStepDetails(stepIndex, result);

      // Emit AI reasoning
      if (result.aiExplanation) {
        this.emit('runner:ai-reasoning', { stepIndex, text: result.aiExplanation });
      }

      // Emit step-complete
      this.emit('runner:step-complete', {
        stepIndex,
        status: result.status === 'passed' ? 'passed' : 'failed',
        durationMs: result.durationMs,
        ...(result.error !== undefined && { error: result.error }),
      });

      this.stepResults.push(result);

      // Add to conversation history
      const currentUrl = this.page.url();
      this.conversationHistory.push(
        formatStepHistoryEntry(stepIndex, instruction, result.status === 'passed', currentUrl),
      );

      if (result.status === 'failed') {
        bail = true;
      }

      this.tokenTracker.resetStep();
      i++;
    }

    // 10. Emit completion
    const failedSteps = this.stepResults.filter((s) => s.status === 'failed').length;
    const overallStatus: 'passed' | 'failed' =
      failedSteps > 0 || this.stopped ? 'failed' : 'passed';

    // 11. Generate HTML report
    let reportPath: string | undefined;
    if (this.config && this.tokenTracker) {
      try {
        const durationMs = Date.now() - runStartTime;
        const report = {
          testName: parsedTest.title,
          filePath,
          tags: parsedTest.frontmatter.tags,
          status: overallStatus,
          steps: this.stepResults,
          totalSteps: this.stepResults.length,
          passedSteps: this.stepResults.filter((s) => s.status === 'passed').length,
          failedSteps,
          totalSubActions: this.stepResults.reduce((sum, s) => sum + s.subActions.length, 0),
          durationMs,
          tokensUsed: this.tokenTracker.total,
          inputTokens: this.tokenTracker.inputTotal,
          outputTokens: this.tokenTracker.outputTotal,
          date: new Date().toISOString(),
          ...(parsedTest.config.baseUrl !== undefined && { baseUrl: parsedTest.config.baseUrl }),
          ...(Object.keys(this.resolvedParameters).length > 0 && { parameters: this.resolvedParameters }),
        };
        reportPath = await generateReport(report, this.config.reports.outputDir);
      } catch {
        // Report generation failure should not affect run result
      }
    }

    this.emit('runner:complete', { status: overallStatus, ...(reportPath !== undefined && { reportPath }) });
  }

  // -----------------------------------------------------------------------
  // Internal — pause / resume helpers
  // -----------------------------------------------------------------------

  private async pause(stepIndex: number, reason: 'breakpoint' | 'interactive' | 'stepover'): Promise<void> {
    this.pauseHandle = createPauseHandle();
    this.currentPauseReason = reason;
    this.emit('runner:paused', { stepIndex, reason });

    try {
      await this.pauseHandle.promise;
    } catch {
      // Rejected means stop() was called — swallow, caller checks this.stopped
    } finally {
      this.pauseHandle = null;
    }

    if (!this.stopped) {
      this.emit('runner:resumed', {});
    }
  }

  private unpause(): void {
    if (this.pauseHandle) {
      this.pauseHandle.resolve();
      this.pauseHandle = null;
    }
  }

  private waitForInput(): Promise<string> {
    return new Promise<string>((resolve) => {
      this.inputResolve = resolve;
    });
  }

  // -----------------------------------------------------------------------
  // Internal — event emission helpers
  // -----------------------------------------------------------------------

  /**
   * Emit sub-action and screenshot events for a completed step.
   */
  private emitStepDetails(stepIndex: number, result: StepResult): void {
    for (const subAction of result.subActions) {
      this.emit('runner:subaction', { stepIndex, subAction });

      if (subAction.screenshotBase64) {
        this.emit('runner:screenshot', {
          stepIndex,
          dataUrl: `data:image/png;base64,${subAction.screenshotBase64}`,
        });
      }
    }

    // Emit the step-level screenshot if present and no sub-action screenshots were emitted
    if (result.screenshotBase64 && result.subActions.every((s) => !s.screenshotBase64)) {
      this.emit('runner:screenshot', {
        stepIndex,
        dataUrl: `data:image/png;base64,${result.screenshotBase64}`,
      });
    }

    // Emit full AI interactions (raw responses + DOM context)
    if (result.aiResponses && result.aiResponses.length > 0) {
      this.emit('runner:ai-interactions', {
        stepIndex,
        aiInteractions: result.aiResponses,
        ...(result.domSnapshot !== undefined && { domSnapshot: result.domSnapshot }),
      });
    }
  }

  // -----------------------------------------------------------------------
  // Internal — lifecycle
  // -----------------------------------------------------------------------

  private reset(): void {
    this.stopped = false;
    this.stepOverNext = false;
    this.currentStepIndex = 0;
    this.pointerOverride = undefined;
    this.pauseHandle = null;
    this.currentPauseReason = null;
    this.inputResolve = null;
    this.steerResolve = null;
    this.stepResults = [];
    this.steeringCount = 0;
    this.conversationHistory = [];
    this.csrfTokens = {};
    this.resolvedParameters = {};
    this.test = null;
    this.config = null;
    this.aiClient = null;
    this.tokenTracker = null;
    this.apiResponseStore = null;
    this.contextContent = '';
    this.session = null;
    this.page = null;
  }

  private async cleanup(): Promise<void> {
    this.running = false;
    if (this.session) {
      await closeBrowser(this.session).catch(() => {});
      this.session = null;
      this.page = null;
    }
  }
}

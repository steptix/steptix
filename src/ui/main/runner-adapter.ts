/**
 * UIRunnerAdapter — wraps the existing test runner with IPC event emission,
 * breakpoint support, pointer movement, and steering for the Runner UI.
 *
 * Accepts a generic `emit(channel, data)` callback so it does not depend on
 * Electron's BrowserWindow directly.  This makes the adapter testable and
 * portable to a future WebSocket backend.
 */

import { resolve as pathResolve, dirname as pathDirname } from 'node:path';
import { resolveProjectRoot } from '../../server/project-root.js';
import type { Page } from 'playwright';
import type { Config } from '../../config/types.js';
import type { ParsedTest, TestInstance } from '../../parser/types.js';
import type { StepResult, SubActionResult } from '../../report/types.js';
import type { MainToRendererEvents } from '../ipc-types.js';
import type { BrowserSession } from '../../browser/manager.js';

import { aiConfigured, loadConfig } from '../../config/loader.js';
import { parseTestFile } from '../../parser/markdown.js';
import { clearSkillCache } from '../../skills/expander.js';
import { expandTestInstances, parseTimeoutMs } from '../../runner/test-runner.js';
import { executeStep } from '../../runner/step-executor.js';
import { launchBrowser, closeBrowser } from '../../browser/manager.js';
import { loadContextFiles } from '../../context/loader.js';
import { interpolate } from '../../parser/parameters.js';
import { interpolateEnvData, type EnvDataContext } from '../../parser/interpolate-env-data.js';
import { parseSetStep } from '../../parser/set-step.js';
import { resolveEnvBundle } from '../../env/resolve-bundle.js';
import { runSetStep } from '../../runner/set-step-runner.js';
import { redactReport, runSecrets } from '../../utils/secrets.js';
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

/**
 * Does this run have no AI — for want of a key, or because the project forbids
 * it? Mirrored from the CLI runner, which is the closer sibling than the server:
 * neither resolves run settings, so `runSettings.ai` never reaches either and
 * `ai.allowInRuns` in `aiui.config.json` is the whole switch.
 *
 * Honoured here as well as in the CLI on purpose. Before
 * stories/bedrock-provider.md the rule was clean — "the non-server paths ignore
 * it" — and fixing only the CLI would replace it with "everything except the
 * Electron UI", an exception nobody could derive from the config file. It also
 * costs the same one line: a project whose provider self-authenticates has no
 * key to blank here either.
 */
function runIsKeyless(config: Config): boolean {
  return !aiConfigured(config.ai) || config.ai.allowInRuns === false;
}

/**
 * The env/data context for one named environment, composed the way `aiui run`
 * composes it: this process's environment, the project's base `.env` for
 * anything missing, `.env.<name>` on top, and `data/<name>.json`. The project
 * is the working directory, as it already is for `skillsDir` and `loadConfig`
 * in this runner.
 *
 * `mutateProcessEnv` because a `## Parameters` `$VAR` reads `process.env`
 * directly (`resolveEnvRef`, src/parser/parameters.ts) and `expandTestInstances`
 * hands it no per-run map — the CLI's reason, and its choice. The overlay
 * outlives the run in this long-lived process; `aiui ui --env` had already
 * made that true for the whole window before this runner read the name.
 */
async function envContextFor(envName: string, dataDir: string): Promise<EnvDataContext> {
  const bundle = await resolveEnvBundle({
    envName,
    projectRoot: process.cwd(),
    dataDir,
    mutateProcessEnv: true,
  });
  return { env: bundle.env, data: bundle.data, envName: bundle.envName };
}

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
  /** The project root an upload path is fenced by. Resolved once per run,
   *  because the options literals below are built synchronously — and without
   *  it the fence would collapse to the test's own folder, refusing a
   *  `../shared/logo.png` the CLI accepts. */
  private uploadProjectRoot: string | null = null;

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
    const resolvedInstruction = this.resolveStepText(instruction);

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
      // An upload step resolves its path beside the test file being run.
      ...(this.test && {
        uploadPaths: {
          baseDir: pathDirname(this.test.filePath),
          projectRoot: this.uploadProjectRoot,
        },
      }),
      resolvedParameters: this.resolvedParameters,
      ...(this.test.envData && { envData: this.test.envData }),
      ...(this.session?.pageTracker && { pageTracker: this.session.pageTracker }),
      // A broken entry fails with the heal-skip copy instead of reaching AI
      // (stories/keyless-replay-and-gateway-env.md §Part B). Read off
      // `this.config.ai` — `loadConfig()` has already applied env, the project
      // `.env`, the config file and the machine floor, and it is the same
      // object `this.aiClient` was built from, so the flag cannot disagree
      // with the client it is speaking for. The third executeStep call-site
      // family: without this the UI path gets the reactive
      // `AiNotConfiguredError` where the other two get the plain explanation.
      ...(runIsKeyless(this.config) && { keyless: true }),
      // Which explanation the skipped step carries. Policy first when both
      // hold, matching the server and the CLI: a key IS present on the policy
      // path, so "no key" would send the reader to fix a correct line.
      ...(this.config.ai.allowInRuns === false && { keylessReason: 'policy' as const }),
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

  /**
   * A step's text as the model reads it: `${env.X}` / `${data.x}` first —
   * fixed for the run, against the context the parser validated the file
   * with — then the runtime `{{name}}` pass. The CLI's order. The parser
   * keeps both kinds of token in `parsedTest.steps` so a compile can show
   * the authored line (stories/placeholder-preserving-actions.md), which is
   * why the substitution has to happen here, per step, and why a runner
   * that skips the first pass sends `${env.BASE_URL}` to the model verbatim
   * (issues/resolved/052). With no context — no environment selected — a
   * `${…}` is left as written, as `aiui run` without `--env` leaves it.
   */
  private resolveStepText(raw: string): string {
    const envData = this.test?.envData;
    return interpolate(envData ? interpolateEnvData(raw, envData) : raw, this.resolvedParameters);
  }

  private async executeRun(filePath: string): Promise<void> {
    const runStartTime = Date.now();

    // 1. Load config
    this.config = await loadConfig();

    // Clear the module-level skill cache at run-start so disk edits to skill
    // files in the dev loop are picked up — the UI server is long-lived, so
    // without this an edited skill stays masked by its earlier-cached parse.
    clearSkillCache();

    // 2. Parse the test file (expanding any [skill: ...] references), with the
    // run's env/data context when an environment is selected.
    //
    // The parser resolves `${env.X}` / `${data.x}` — validating them, loading
    // `dataSources`, and recording `parsedTest.envData` for the run — only when
    // it is handed a context. This runner never handed it one, so those
    // references reached the model as literal text on every run since the
    // feature landed (issues/resolved/052). Same precedence as `aiui run`:
    // AUTOMATION_ENV, which `aiui ui --env` sets for this process, then the
    // test's own `env:` frontmatter, then none — and none leaves a `${…}` as
    // written, exactly as the CLI does without `--env`.
    const skillsDir = pathResolve(process.cwd(), this.config.tests.skillsDir);
    const dataDir = this.config.tests.dataDir;
    const runEnvName = process.env['AUTOMATION_ENV']?.trim() || undefined;
    const initial = await parseTestFile(filePath, {
      skillsDir,
      ...(runEnvName && { envData: await envContextFor(runEnvName, dataDir) }),
    });
    // Frontmatter `env:` is honoured only when nothing run-wide pinned one —
    // the CLI's second pass, for the same reason: the first parse is how the
    // frontmatter is read at all.
    const parsedTest =
      !runEnvName && initial.frontmatter.env
        ? await parseTestFile(filePath, {
            skillsDir,
            envData: await envContextFor(initial.frontmatter.env, dataDir),
          })
        : initial;
    this.test = parsedTest;
    this.uploadProjectRoot = await resolveProjectRoot(parsedTest.filePath);

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
    // Lowered for the same reason the server lowers it: with a key present,
    // `AiNotConfiguredError`'s advice ("set AI_API_KEY") would be a false
    // statement about a correct config. Set once — the UI path has no per-batch
    // run settings to re-resolve.
    this.aiClient.setAiPolicy(this.config.ai.allowInRuns !== false);
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
    let timeoutDeadline = Date.now() + testTimeout;

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
      // Read off the AUTHORED step and never interpolated — `interpolate`
      // would replace the TARGET with its own value once it holds one
      // (stories/variable-assignment.md §Locked).
      const setStep = parseSetStep(rawInstruction);
      const instruction = setStep ? rawInstruction : this.resolveStepText(rawInstruction);

      // --- Check for breakpoint or stepOverNext BEFORE executing ---
      if (this.breakpoints.has(stepIndex) || this.stepOverNext) {
        const reason = this.stepOverNext ? 'stepover' as const : 'breakpoint' as const;
        this.stepOverNext = false;
        await this.pause(stepIndex, reason);
        // After resuming, re-check stopped and pointer override
        if (this.stopped) break;
        if (this.pointerOverride !== undefined) continue; // loop will pick up override
      }

      // --- Handle `Set {{name}} to "…"` steps ---
      // `parsedTest.envData` is threaded through so a `${…}` inside the
      // template resolves against the same context as every other step. It
      // was threaded before the rest of this runner resolved `${…}` at all,
      // and sat inert until the parse above started building that context
      // (issues/resolved/052).
      if (setStep) {
        this.emit('runner:step-start', { stepIndex, instruction, totalSteps });
        const outcome = runSetStep(
          setStep,
          instruction,
          stepIndex,
          this.resolvedParameters,
          parsedTest.envData,
        );
        this.stepResults.push(outcome.result);
        this.emit('runner:step-complete', {
          stepIndex,
          // A Set step is only ever passed or failed — it has nothing to skip.
          status: outcome.result.status === 'passed' ? 'passed' : 'failed',
          durationMs: outcome.result.durationMs,
        });
        this.conversationHistory.push(
          formatStepHistoryEntry(
            stepIndex,
            instruction,
            outcome.result.status === 'passed',
            this.page?.url(),
          ),
        );
        if (outcome.result.status === 'failed') {
          this.emit('runner:error', { message: outcome.result.error ?? 'Set step failed' });
          break;
        }
        i++;
        continue;
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

        // Don't count user input time against the test timeout
        const inputDuration = Date.now() - stepStartTime;
        timeoutDeadline += inputDuration;

        const stepResult: StepResult = {
          index: stepIndex,
          instruction,
          status: 'passed',
          turns: [],
          durationMs: inputDuration,
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
          turns: [],
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
      // An upload step resolves its path beside the test file being run.
      ...(this.test && {
        uploadPaths: {
          baseDir: pathDirname(this.test.filePath),
          projectRoot: this.uploadProjectRoot,
        },
      }),
        resolvedParameters: this.resolvedParameters,
        // The context the step text resolved against, so the executor's
        // `## Values` block, its action substitution, a code-behind
        // `step.getVar('data.x')` and secret masking read the same values.
        ...(parsedTest.envData && { envData: parsedTest.envData }),
        ...(this.session?.pageTracker && { pageTracker: this.session.pageTracker }),
        // Keyless, same as the steering call above — both call sites or
        // neither: a run and a steer on the same machine must not disagree
        // about whether there is AI to heal with.
        ...(runIsKeyless(this.config) && { keyless: true }),
        ...(this.config.ai.allowInRuns === false && { keylessReason: 'policy' as const }),
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
          totalSubActions: this.stepResults.reduce((sum, s) => sum + s.turns.reduce((tSum, t) => tSum + t.subActions.length, 0), 0),
          durationMs,
          tokensUsed: this.tokenTracker.total,
          inputTokens: this.tokenTracker.inputTotal,
          outputTokens: this.tokenTracker.outputTotal,
          date: new Date().toISOString(),
          ...(parsedTest.config.baseUrl !== undefined && { baseUrl: parsedTest.config.baseUrl }),
          ...(Object.keys(this.resolvedParameters).length > 0 && { parameters: this.resolvedParameters }),
        };
        reportPath = await generateReport(
          redactReport(report, runSecrets({ parameters: this.resolvedParameters, envData: parsedTest.envData })),
          this.config.reports.outputDir,
        );
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
    const allSubActions = result.turns.flatMap((t) => t.subActions);
    const allAiInteractions = result.turns.flatMap((t) => t.aiInteractions);

    for (const subAction of allSubActions) {
      this.emit('runner:subaction', { stepIndex, subAction });

      if (subAction.screenshotBase64) {
        this.emit('runner:screenshot', {
          stepIndex,
          dataUrl: `data:image/png;base64,${subAction.screenshotBase64}`,
        });
      }
    }

    // Emit the step-level screenshot if present and no sub-action screenshots were emitted
    if (result.screenshotBase64 && allSubActions.every((s) => !s.screenshotBase64)) {
      this.emit('runner:screenshot', {
        stepIndex,
        dataUrl: `data:image/png;base64,${result.screenshotBase64}`,
      });
    }

    // Emit full AI interactions (raw responses + DOM context)
    if (allAiInteractions.length > 0) {
      this.emit('runner:ai-interactions', {
        stepIndex,
        aiInteractions: allAiInteractions,
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

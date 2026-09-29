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
import { captureScreenshot } from '../../browser/screenshot.js';
import { loadContextFiles } from '../../context/loader.js';
import { bindVariable, interpolate } from '../../parser/parameters.js';
import { interpolateEnvData, type EnvDataContext } from '../../parser/interpolate-env-data.js';
import { parseSetStep } from '../../parser/set-step.js';
import { parseUseAiStep } from '../../parser/use-step.js';
import { controlLineDefines } from '../../parser/control-line.js';
import { isReturnClaim, parseFlowControlStep } from '../../parser/flow-control-step.js';
import {
  failureTailContradictionError,
  isFailureTailContradiction,
  parseFailureTail,
} from '../../parser/failure-tail.js';
import {
  deliberateFailError,
  deliberateFailResult,
  flowControlExplanation,
  frameExitIndex,
  frameLabel,
  skippedByReturn,
  toleratedHistoryLine,
} from '../../runner/flow-control.js';
import { resolveEnvBundle } from '../../env/resolve-bundle.js';
import { runSetStep } from '../../runner/set-step-runner.js';
import { runUseAiStep } from '../../runner/use-ai-step-runner.js';
import { createStructureMemo, type StructureMemo } from '../../runner/structure-memo.js';
import {
  createControlState,
  forEachPassOf,
  guardVisitEvaluates,
  planAfterStep,
  planForStart,
  returnExit,
  type ControlRecord,
} from '../../runner/control-flow.js';
import { dottedReferenceError } from '../../runner/placeholder-substitution.js';
import {
  applyPassBindings,
  eachSkipped,
  evaluateGuard,
  guardHistoryLines,
  guardResult,
  guardRows,
  isLoopRecord,
  LoopRuntime,
  skipReasonFor,
  skippedResult,
  SkipQueue,
} from '../../runner/control-runtime.js';
import { redact, redactReport, runSecretsWithInputs } from '../../utils/secrets.js';
import { AiClient } from '../../ai/client.js';
import { formatStepHistoryEntry } from '../../ai/prompts.js';
import { TokenTracker } from '../../utils/tokens.js';
import { ApiResponseStore } from '../../api/response-store.js';
import { generateReport } from '../../report/generator.js';
import { setLogCallback } from '../../utils/logger.js';
import { openRunStats, projectStatsSwitch, recordRunEnd, type RunStats } from '../../runner/run-stats.js';

// ---------------------------------------------------------------------------
// Patterns mirrored from test-runner.ts (not exported there)
// ---------------------------------------------------------------------------
const INPUT_STEP_PATTERN = /^\[input:\s*(\w+)\]\s*(.*)/;
const INTERACTIVE_STEP_PATTERN = /^\[interactive\]\s*(.*)/i;

/**
 * Does this run have no AI — for want of a key, or because the project forbids
 * it? Mirrored from the CLI runner, which is the closer sibling than the server:
 * neither resolves run settings, so `runSettings.ai` never reaches either and
 * `ai.allowInRuns` in `steptix.config.json` is the whole switch.
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
 * The env/data context for one named environment, composed the way `steptix run`
 * composes it: this process's environment, the project's base `.env` for
 * anything missing, `.env.<name>` on top, and `data/<name>.json`. The project
 * is the working directory, as it already is for `skillsDir` and `loadConfig`
 * in this runner.
 *
 * `mutateProcessEnv` because a `## Parameters` `$VAR` reads `process.env`
 * directly (`resolveEnvRef`, src/parser/parameters.ts) and `expandTestInstances`
 * hands it no per-run map — the CLI's reason, and its choice. The CLI's
 * process then exits; this one does not, so `start()` puts `process.env`
 * back when the run ends (`restoreProcessEnv`). Left in place, the overlay
 * would win over the base `.env` on the NEXT run — `resolveEnvBundle` fills
 * base keys only where the baseline lacks them — so a run pinned to `prod`
 * after one pinned to `uat` would keep `uat`'s values for every key the two
 * files share, resolve a `${env.X}` that exists only in `.env.uat`, and hand
 * `loadConfig()` an `AI_MODEL` from a file the test never named.
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

/** `process.env` exactly as it was when the snapshot was taken: keys added
 *  since are removed, values changed since are put back. */
function restoreProcessEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (value !== undefined) process.env[key] = value;
  }
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
  /**
   * What this run has learned about a region's structure
   * (SPEC-structured-table-reads.md §7.10, src/runner/structure-memo.ts).
   *
   * Run state, beside `conversationHistory` and `csrfTokens`, and cleared with
   * them in `reset()`: §7.10 budgets ONE structure question per structure per
   * run, and a debug session that reads the same odd grid at step 2 and again
   * at step 10 otherwise pays for it twice — in an interactive window, where
   * the second wait is the one the user is watching. Shared with the STEERING
   * call as well, because a steer is a step of this same run against this same
   * page.
   */
  private structureMemo: StructureMemo = createStructureMemo();
  private resolvedParameters: Record<string, string> = {};
  private test: ParsedTest | null = null;
  /** The project root an upload path is fenced by. Resolved once per run,
   *  because the options literals below are built synchronously — and without
   *  it the fence would collapse to the test's own folder, refusing a
   *  `../shared/logo.png` the CLI accepts. */
  private uploadProjectRoot: string | null = null;
  /** The run, for the scoreboard (docs/specs/SPEC-scoreboard.md §7): opened
   *  once the test is parsed, carried on every step's options, and closed with
   *  the run line beside the report. Steers are steps of the same run. */
  private runStats: RunStats | undefined;

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

    // The environment this window was launched with — `steptix ui --env` and
    // the shell — which a run pinned to an environment overlays for its own
    // duration (`envContextFor`) and must not leave behind for the next one.
    const envBefore = { ...process.env };
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
      restoreProcessEnv(envBefore);
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
    // A `${…}` the environment cannot answer is refused here, as it is at
    // parse time for a test step — but as a log line, not `runner:error`:
    // that event ends the run in the panel, and the run is still paused at
    // this breakpoint waiting for a steer that resolves. Thrown, it would
    // reject the `runner:steer` invoke, which the renderer neither awaits
    // nor catches, and the instruction would vanish without a word.
    let resolvedInstruction: string;
    try {
      resolvedInstruction = this.resolveStepText(instruction);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit('runner:log', { level: 'error', message: `Steering instruction not run: ${message}` });
      return;
    }

    // The steer as everything outside the run may see it. Same rule as the
    // run loop's `shown` (§7.6): the executor is handed the resolved text
    // because it has to act on it, and the panel and the model are handed the
    // masked one — a `${env.PASSWORD}` typed into a steer was going to both.
    const shownSteer = (): string =>
      `(steering) ${redact(
        resolvedInstruction,
        this.secretsNow(),
      )}`;

    // Emit step-start for the steering step
    this.emit('runner:step-start', {
      stepIndex,
      instruction: shownSteer(),
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
      structureMemo: this.structureMemo,
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
      // The report files a steer under a slot past the test's last step (the
      // push below), so its lines are filed there too.
      stats: this.statsNow((this.test?.steps.length ?? 0) + this.steeringCount + 1),
    },
    // The steer as TYPED, tokens intact, for the run loop's reason: a
    // `${env.PASSWORD}` typed here is shown to the model masked, not resolved.
    instruction);

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
        shownSteer(),
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
    // Through the one helper, like every other write into this map: an
    // `[input: order]` after a `For each {{order}} …` rebinds that root, and
    // §8.2 says a rebind erases the root's dotted keys — otherwise the last
    // pass's `order.id` answers every later `{{order.id}}`.
    bindVariable(this.resolvedParameters, variable, value);
    if (this.inputResolve) {
      this.inputResolve(value);
      this.inputResolve = null;
    }
  }

  // -----------------------------------------------------------------------
  // Internal — run loop
  // -----------------------------------------------------------------------

  /**
   * What this run must never print, as it stands now: its secret-named
   * parameters and env/data secrets (`runSecrets`), plus the secrets among the
   * values expansion wrote into STEP TEXT — each skill call's arguments and
   * each looped section's row (`ExpandedFrame.inputs`). No variable map holds
   * those, so without them a `password` column printed in clear in the panel,
   * the model's `## Prior Steps`, the report and the scoreboard (issue 060).
   * The CLI's `secretsNow` and the server's are the same set. Read per call:
   * captures and `[input:]` answers grow it.
   */
  private secretsNow(): string[] {
    const test = this.test;
    const frameInputs = Object.values(test?.expansion?.frames ?? {}).flatMap((frame) =>
      frame.inputs ? [frame.inputs] : [],
    );
    return runSecretsWithInputs({ parameters: this.resolvedParameters, envData: test?.envData }, frameInputs);
  }

  /** What each step's options carry: this run, masked with its secrets as they
   *  are now — the executor adds what the step itself captures. `reportAs` is
   *  the number the report files the step under, when that is not the one the
   *  executor is handed (a steer). */
  private statsNow(reportAs?: number): RunStats | undefined {
    const stats = this.runStats;
    if (stats === undefined) return undefined;
    return {
      ...stats,
      ...(stats.enabled && { maskValues: this.secretsNow() }),
      ...(reportAs !== undefined && { reportIndex: () => reportAs }),
    };
  }

  /**
   * A step's text as the model reads it: `${env.X}` / `${data.x}` first —
   * fixed for the run, against the context the parser validated the file
   * with — then the runtime `{{name}}` pass. The CLI's order. The parser
   * keeps both kinds of token in `parsedTest.steps` so a compile can show
   * the authored line (stories/placeholder-preserving-actions.md), which is
   * why the substitution has to happen here, per step, and why a runner
   * that skips the first pass sends `${env.BASE_URL}` to the model verbatim
   * (issues/resolved/052). With no context — no environment selected — a
   * `${…}` is left as written, as `steptix run` without `--env` leaves it.
   */
  private resolveStepText(raw: string): string {
    const envData = this.test?.envData;
    // The names the LINE defines are exempt from the unresolved warning: this
    // loop, like the server's, resolves every step before the control
    // dispatch, so a `For each {{payment}} in {{payments}}` header would warn
    // about the item it is about to bind, once per correct table loop
    // (`controlLineDefines`, src/parser/control-line.ts).
    return interpolate(
      envData ? interpolateEnvData(raw, envData) : raw,
      this.resolvedParameters,
      controlLineDefines(raw),
    );
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
    // feature landed (issues/resolved/052). Same precedence as `steptix run`:
    // AUTOMATION_ENV, which `steptix ui --env` sets for this process, then the
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
    this.runStats = openRunStats({
      projectRoot: this.uploadProjectRoot,
      testFilePath: parsedTest.filePath,
      // The TEST's project's switch: `loadConfig()` above read the working
      // directory's config, and this test's lines are filed under the root its
      // own path resolves to — the CLI's rule (§6.4).
      projectEnabled: await projectStatsSwitch(this.uploadProjectRoot, this.config),
    });

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

    // ── Control flow (stories/control-flow.md) ─────────────────────────────
    //
    // The Runner UI is the fourth copy of the step loop and gets the same three
    // hooks the other two do, or the story is three-quarters done. Everything
    // decision-shaped lives in the shared planner and `control-runtime`; what
    // is local here is how a row reaches the renderer.
    const controls: (ControlRecord | null)[] =
      parsedTest.expansion?.controls ?? parsedTest.steps.map(() => null);
    const hasControls = controls.some((record) => record !== null);
    const controlState = createControlState(this.config.execution.maxLoopIterations);
    const loops = new LoopRuntime();
    const skipQueue = new SkipQueue();
    const skipReasons = new Map<number, string>();
    /** Record every queued skipped step the run has now moved past, so the
     *  report reads in file order rather than in decision order. */
    const flushSkips = (before: number | 'all'): void => {
      const due = before === 'all' ? skipQueue.takeAll() : skipQueue.take(before);
      for (const k of due) {
        const reason = skipReasons.get(k) ?? 'Skipped';
        const result = skippedResult({
          index: k + 1,
          instruction: parsedTest.steps[k] ?? '',
          reason,
          loop: loops.markerFor(k),
        });
        this.stepResults.push(result);
        // `skipped`, not `passed`: the untaken half of a decision is the one
        // thing a chain leaves behind for the reader, and painting it green
        // says the opposite of what happened. The reason rides along on the
        // same field a `return`'s skips use, so the renderer's log says why
        // in one sentence whichever kind of skip this was.
        this.emit('runner:step-complete', {
          stepIndex: k + 1,
          status: 'skipped',
          durationMs: 0,
          reason,
        });
      }
    };
    /**
     * Where the run goes after step `i`: the next line, or back to a loop's
     * guard when `i` closed its body.
     *
     * Every path that advances the pointer goes through this — the CLI and the
     * server have the same helper for the same reason. A bare `i++` on the
     * `Set` / `[input:]` / `[interactive]` paths meant a loop whose body ENDS
     * in one of them ran exactly one pass and left silently, which no other
     * run loop did.
     */
    const advance = (from: number): number => {
      if (!hasControls) return from + 1;
      const after = planAfterStep(controls, from, controlState);
      return after ? after.next : from + 1;
    };

    while (i < totalSteps) {
      if (this.stopped || bail) break;

      // Check pointer override (movePointer sets the next step)
      if (this.pointerOverride !== undefined) {
        // Convert 1-based step index to 0-based loop counter
        i = this.pointerOverride - 1;
        this.pointerOverride = undefined;
        if (i < 0 || i >= totalSteps) break;
        // `planForStart`, the third planner hook — applied here because this
        // is where this runner's pointer can move. The debugger's jump-to-step
        // can land INSIDE a tail or a loop body, and without this the chain's
        // other members are never marked skipped and the loop's pass counter
        // is never seeded, so the first pass after the jump reports as pass 1
        // of a loop that has already run (stories/control-flow.md §"Runs that
        // start or end mid-structure" — the same treatment a `startAt` gets on
        // the server).
        if (hasControls) {
          // A jump INTO a loop body starts that body again, and this visit
          // owes the rows every other visit of it emits. `released` is the
          // run's memory of what has already been reported, so the loop's own
          // range is forgotten here — the same range, and the same reason, as
          // `rearmLoopBreakpoints` on the server. Without it a jump back into
          // a body holding a chain reported the taken rows and none of the
          // skipped ones, because an earlier pass had already released those
          // indices (review 4, finding 5).
          for (let g = 0; g < controls.length; g++) {
            const record = controls[g];
            if (!record || !isLoopRecord(record)) continue;
            if (i < record.bodyStart || i > record.bodyEnd) continue;
            skipQueue.rearm(record.bodyStart, record.bodyEnd);
          }
          const jumped = planForStart(controls, i, controlState);
          for (const k of eachSkipped(jumped.skip)) {
            skipReasons.set(k, 'Skipped: the run jumped into another branch of this decision');
            // `addOnce`: a jump BACKWARDS re-plans ranges an earlier decision
            // already skipped, and this is the one caller that can hand the
            // queue the same index twice for the same reason. Everywhere else
            // a repeated index is a repeated pass and belongs in the report
            // twice (control-runtime.ts, SkipQueue.addOnce).
            skipQueue.addOnce([k]);
          }
        }
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
      // `[use ai] <step>` (stories/use-ai-step.md), off the AUTHORED line and
      // never interpolated, for `Set`'s reasons.
      const useAiStep = setStep ? null : parseUseAiStep(rawInstruction);
      // The flow-control claim, read off the AUTHORED line like `Set`
      // (stories/step-flow-control.md, decision 2).
      const flowControlClaim = setStep || useAiStep ? null : parseFlowControlStep(rawInstruction);
      // The `… otherwise fail …` / `… otherwise continue` tail, off the same
      // AUTHORED line and with the exclusions the other three loops apply
      // (stories/step-failure-outcomes.md, decision 12). `[input:]` and
      // `[interactive]` are matched further down, off the interpolated text, and
      // both take their own branch before the executor is reached.
      const failureTail = setStep || flowControlClaim ? null : parseFailureTail(rawInstruction);
      // Decision 8's backstop: the Runner UI parses the file for real, so the
      // validator normally catches this first — but a `[skill: …]` body read at
      // run time never passed it.
      const failureTailContradiction =
        setStep || flowControlClaim ? false : isFailureTailContradiction(rawInstruction);
      const instruction =
        setStep || useAiStep ? rawInstruction : this.resolveStepText(rawInstruction);
      /**
       * The same line as everything OUTSIDE the run may see it.
       *
       * `resolveStepText` is interpolation and nothing else, so `instruction`
       * holds the real values — which is right, it is what the executor acts
       * on. But it was also what this loop handed the renderer
       * (`runner:step-start`) and the model (`formatStepHistoryEntry`, whose
       * docstring asks for the MASKED text), so a `Type {{password}} into the
       * field` step put the password in the panel and then in every later
       * step's `## Prior Steps`. The CLI masks at its own seam
       * (test-runner.ts) and so does the server (session-manager.ts); this
       * loop was the one that did not (§7.6).
       *
       * Read per call, not once: a `[store as: …]` capture or an `[input:]`
       * answer during this step adds a secret the lines after it must hide.
       */
      const shown = (text: string): string =>
        redact(text, this.secretsNow());

      // ── Flow control, in two halves (stories/step-flow-control.md) ───────
      // Split because the ORDER matters to a watching UI: the returning step
      // has to be named before its `ai-reasoning` is emitted, and its own
      // step-complete has to land before the skipped ones that follow it.
      const flowFrame = (): string | null =>
        frameLabel(parsedTest.expansion?.origins, parsedTest.expansion?.frames, i);

      /** Name the flow on the returning step, in place. The executor produced
       *  the model's own account and nothing more — it holds no expansion, so
       *  it cannot know which flow this is. */
      const nameFlow = (result: StepResult, label: string | null): void => {
        result.aiExplanation = flowControlExplanation(label, result.aiExplanation);
      };

      /** Push and emit a `skipped` result for every step the return leaves
       *  behind, and answer with the index to resume from. */
      const skipRestOfFlow = (label: string | null): number => {
        // The frame's answer, clamped to the innermost control body around the
        // returning step — an iteration is a flow too, so a return inside a
        // loop body ends the PASS rather than the run. `enclosed` is what says
        // the planner gets the last word on where to resume: back to the
        // loop's guard, or out past a chain (`returnExit`,
        // src/runner/control-flow.ts).
        const { exit, enclosed } = returnExit(
          controls,
          i,
          frameExitIndex(
            parsedTest.expansion?.origins,
            parsedTest.expansion?.frames,
            i,
            totalSteps,
          ),
        );
        // The reason string carries the returning step's line so it is findable
        // from the editor, which does not number by the expanded index the
        // reason's `step N` uses.
        //
        // `expansion.rawSteps`, not `rawInstruction`: `parsedTest.steps[i]` is
        // the EXPANDED list, so inside a skill body it has already had the
        // call's arguments interpolated into it — `[skill: Login
        // password="hunter2"]` over a body step `If {{password}} is remembered
        // then return` would otherwise write the literal password into a run
        // log, a report cell and an IPC message. `rawSteps` is the match side,
        // which the expander never interpolates. Same fallback as the CLI and
        // the server take, and for the same reason.
        const returningText = parsedTest.expansion?.rawSteps[i] ?? rawInstruction;
        for (let j = i + 1; j <= exit; j++) {
          const skipped = skippedByReturn(j, parsedTest.steps[j] ?? '', i, label, returningText);
          // The pass these rows belong to, stamped as `flushSkips` and the
          // ordinary step path both stamp it — without it the report's
          // iteration band broke at exactly the rows a return produced.
          const skippedLoop = loops.markerFor(j);
          if (skippedLoop) skipped.loop = skippedLoop;
          this.stepResults.push(skipped);
          this.emit('runner:step-complete', {
            stepIndex: j + 1,
            status: 'skipped',
            durationMs: 0,
            ...(skipped.aiExplanation !== undefined && { reason: skipped.aiExplanation }),
          });
        }
        return enclosed ? advance(exit) : exit + 1;
      };

      // --- Check for breakpoint or stepOverNext BEFORE executing ---
      //
      // No per-index memory of what has already paused, deliberately: a loop
      // body re-runs the SAME `stepIndex` on every pass, so a set of consumed
      // indices would silently disarm the author's breakpoint after pass 1 —
      // which is exactly what the server did until `rearmLoopBreakpoints`
      // (session-manager.ts). The contract is "a breakpoint on a body line
      // fires on every pass" (stories/control-flow.md §"Painting, frames and
      // the report"), and here it does by construction.
      if (this.breakpoints.has(stepIndex) || this.stepOverNext) {
        const reason = this.stepOverNext ? 'stepover' as const : 'breakpoint' as const;
        this.stepOverNext = false;
        await this.pause(stepIndex, reason);
        // After resuming, re-check stopped and pointer override
        if (this.stopped) break;
        if (this.pointerOverride !== undefined) continue; // loop will pick up override
      }

      // --- Control flow: evaluate the guard, then follow the plan ---
      // After the breakpoint check, so a breakpoint on a guard line pauses
      // BEFORE the decision (stories/control-flow.md §"Painting, frames and
      // the report").
      const controlRecord = hasControls ? (controls[i] ?? null) : null;
      if (controlRecord) {
        // Only a visit that will produce a guard row announces itself. The
        // `runner:step-complete` below is inside `if (rows.guard)`, and a visit
        // that asks nobody produces no row — a `Repeat`'s first pass, every
        // revisit of a `For each` — so a start emitted there is never
        // completed and the renderer's row stays spinning
        // (stories/control-flow.md §"What the live run found").
        if (guardVisitEvaluates(controls, i, controlState)) {
          this.emit('runner:step-start', { stepIndex, instruction: rawInstruction, totalSteps });
        }

        const evaluation = await evaluateGuard({
          controls,
          index: i,
          state: controlState,
          resolvedParameters: this.resolvedParameters,
          // A locally decided condition's reasoning is built from the
          // SUBSTITUTED text, so it can carry a secret the judge's reasoning
          // never could. Masked on the same terms as every other string this
          // runner emits.
          redact: (text) =>
            redact(text, this.secretsNow()),
          executorOptions: {
            page: this.page,
            config: this.config,
            aiClient: this.aiClient,
            contextContent: this.contextContent,
            testName: parsedTest.title,
            ...(baseUrl !== undefined && { baseUrl }),
            conversationHistory: [...this.conversationHistory],
            ...(this.apiResponseStore != null && { apiResponseStore: this.apiResponseStore }),
            csrfTokens: this.csrfTokens,
            resolvedParameters: this.resolvedParameters,
            ...(parsedTest.envData && { envData: parsedTest.envData }),
            ...(this.session?.pageTracker && { pageTracker: this.session.pageTracker }),
          },
        });
        const { plan } = evaluation;

        const marker =
          plan.pass && isLoopRecord(controlRecord)
            ? loops.beginPass(i, controlRecord, plan.pass)
            : undefined;
        // `applyPassBindings`, not `Object.assign`: a row that omits a property
        // the last row had must not inherit its value, and this runner's
        // jump-to-step can restart a body mid-loop (control-runtime.ts).
        if (plan.pass?.bindings) applyPassBindings(this.resolvedParameters, plan.pass.bindings);
        if (plan.loopEnded) loops.endLoop(plan.loopEnded);

        const rows = guardRows(controlRecord, i, evaluation);
        const reason = skipReasonFor(controlRecord, plan);
        for (const k of rows.skip) skipReasons.set(k, reason);
        skipQueue.add(rows.skip);

        if (rows.guard) {
          flushSkips(rows.guard.index);
          const result = guardResult({
            index: rows.guard.index + 1,
            instruction: parsedTest.steps[rows.guard.index] ?? rawInstruction,
            status: rows.guard.status,
            durationMs: evaluation.durationMs,
            reasoning: evaluation.reasoning,
            error: evaluation.error,
            aiInteractions: evaluation.aiInteractions,
            loop: marker,
          });
          this.stepResults.push(result);
          if (evaluation.reasoning) {
            this.emit('runner:ai-reasoning', {
              stepIndex: rows.guard.index + 1,
              text: evaluation.reasoning,
            });
          }
          this.emit('runner:step-complete', {
            stepIndex: rows.guard.index + 1,
            // A guard reports what it recorded, `skipped` included: a chain
            // that decided nothing held is the row that says so — and it says
            // WHY, on the same field `flushSkips` uses for the rows beside it.
            // Without the reason the renderer printed `◌ Step 5 skipped` for
            // the guard and `◌ Step 6 skipped — no condition in this decision
            // held` for the row immediately under it, from one decision.
            status: rows.guard.status,
            durationMs: evaluation.durationMs,
            ...(rows.guard.status === 'skipped' && { reason }),
            ...(evaluation.error !== undefined && { error: evaluation.error }),
          });
          // The SELECTED member's line, plus a `did not hold` line for each
          // alternative the judge ruled out — `rawInstruction` is only where
          // the question was asked from. Masked like every other history line
          // this runner writes: the comment here used to say the opposite,
          // "unredacted, matching every other history line", and that stopped
          // being true when those lines started being masked. Both of the
          // other loops that write these already wrap this callback —
          // `redact(test.steps[k] …)` in test-runner.ts,
          // `redact(effectiveSteps[k] …)` in session-manager.ts — and a
          // guard line is a step's text like any other: whatever a value the
          // mask set holds is doing in it, the model's `## Prior Steps` is
          // not where it should turn up.
          this.conversationHistory.push(
            ...guardHistoryLines({
              controls,
              index: i,
              rows,
              plan,
              text: (k) => shown(parsedTest.steps[k] ?? rawInstruction),
            }),
          );
        }

        this.tokenTracker?.resetStep();

        if (evaluation.error) {
          if (isLoopRecord(controlRecord)) {
            loops.abandon(i, controlState.passes.get(i) ?? 0);
          }
          this.emit('runner:error', { message: evaluation.error });
          bail = true;
          break;
        }

        i = plan.next;
        continue;
      }

      // --- Handle `Set {{name}} to "…"` steps ---
      // `parsedTest.envData` is threaded through so a `${…}` inside the
      // template resolves against the same context as every other step. It
      // was threaded before the rest of this runner resolved `${…}` at all,
      // and sat inert until the parse above started building that context
      // (issues/resolved/052).
      if (setStep) {
        this.emit('runner:step-start', { stepIndex, instruction: shown(instruction), totalSteps });
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
            shown(instruction),
            outcome.result.status === 'passed',
            this.page?.url(),
          ),
        );
        if (outcome.result.status === 'failed') {
          this.emit('runner:error', { message: outcome.result.error ?? 'Set step failed' });
          break;
        }
        i = advance(i);
        continue;
      }

      // --- Handle `[use ai] <step>` steps (stories/use-ai-step.md) ---
      // Beside `Set` and with its bookkeeping. There is no variables event on
      // this runner, so nothing is emitted for the value itself; the report
      // row carries it. Unlike `Set`, the step takes an `… otherwise …` tail
      // (decision 10), so a tolerated failure carries on as it does below.
      if (useAiStep) {
        flushSkips(i);
        this.emit('runner:step-start', { stepIndex, instruction: shown(instruction), totalSteps });
        const outcome = await runUseAiStep({
          parsed: useAiStep,
          index: stepIndex,
          instruction,
          scope: this.resolvedParameters,
          envData: parsedTest.envData,
          // With the skill arguments and looped-section rows the expander
          // wrote into step text, which no variable map holds — the runner
          // masks them in the text it sends (issue 060).
          secrets: this.secretsNow(),
          aiClient: this.aiClient!,
          retries: this.config.execution.retries,
          failureTail,
          stats: this.statsNow(),
        });
        const result = outcome.result;
        const stepLoop = loops.markerFor(i);
        if (stepLoop) result.loop = stepLoop;
        this.stepResults.push(result);
        this.emit('runner:step-complete', {
          stepIndex,
          status: result.status === 'passed' ? 'passed' : 'failed',
          durationMs: result.durationMs,
          ...(result.error !== undefined && { error: result.error }),
          ...(result.tolerated && { tolerated: true }),
          ...(result.warning !== undefined && { warning: result.warning }),
        });
        this.conversationHistory.push(
          formatStepHistoryEntry(
            stepIndex,
            shown(instruction),
            result.status === 'passed',
            this.page?.url(),
          ),
        );
        if (result.tolerated) this.conversationHistory.push(toleratedHistoryLine(stepIndex));
        if (result.status === 'failed' && !result.tolerated) {
          this.emit('runner:error', { message: result.error ?? '[use ai] step failed' });
          break;
        }
        this.tokenTracker?.resetStep();
        i = advance(i);
        continue;
      }

      // --- A dotted reference this pass cannot answer ---
      // `{{order.statuz}}` where the row has `status`
      // (docs/specs/SPEC-structured-table-reads.md §8.3). Refused before the
      // model call, in the same shape as the contradiction below, and read off
      // the AUTHORED line — `resolveStepText` has already replaced every
      // reference it could answer. Dotted only; a flat name keeps its warning.
      // Masked on the same terms as every other string this runner emits: the
      // refusal is written from the run's own values — the properties the row
      // holds, the keys the loop dropped — and it reaches the IPC event, the
      // report and the log verbatim.
      const dottedRefError = setStep
        ? undefined
        : dottedReferenceError(
            rawInstruction,
            this.resolvedParameters,
            (item) => forEachPassOf(controls, controlState, item),
            (text) =>
              redact(
                text,
                this.secretsNow(),
              ),
          );
      if (dottedRefError) {
        flushSkips(i);
        this.emit('runner:step-start', { stepIndex, instruction: shown(instruction), totalSteps });
        const stepResult: StepResult = {
          index: stepIndex,
          instruction,
          status: 'failed',
          turns: [],
          durationMs: 0,
          retried: false,
          error: dottedRefError,
          aiExplanation: dottedRefError,
        };
        this.stepResults.push(stepResult);
        this.emit('runner:step-complete', {
          stepIndex,
          status: 'failed',
          durationMs: 0,
          error: dottedRefError,
        });
        this.emit('runner:error', { message: dottedRefError });
        this.conversationHistory.push(
          formatStepHistoryEntry(stepIndex, shown(instruction), false, this.page?.url()),
        );
        break;
      }

      // --- The contradiction of decision 8 ---
      // Refused rather than resolved, with no model call: the line asks to both
      // end the flow and to tolerate its own failure. The same sentence the
      // validator and the other three loops use.
      if (failureTailContradiction) {
        flushSkips(i);
        this.emit('runner:step-start', { stepIndex, instruction: shown(instruction), totalSteps });
        const error = failureTailContradictionError(rawInstruction);
        const stepResult: StepResult = {
          index: stepIndex,
          instruction,
          status: 'failed',
          turns: [],
          durationMs: 0,
          retried: false,
          error,
          aiExplanation: error,
        };
        this.stepResults.push(stepResult);
        this.emit('runner:step-complete', { stepIndex, status: 'failed', durationMs: 0, error });
        this.emit('runner:error', { message: error });
        this.conversationHistory.push(
          formatStepHistoryEntry(stepIndex, shown(instruction), false, this.page?.url()),
        );
        break;
      }

      // --- Handle a bare `Fail the test with error "…"` step ---
      // No condition to judge, so no model call and no page snapshot — the
      // same dispatch `Return` gets, one branch up
      // (stories/step-failure-outcomes.md, decisions 1 and 3).
      if (flowControlClaim && flowControlClaim.body === undefined && flowControlClaim.verb === 'fail') {
        flushSkips(i);
        this.emit('runner:step-start', { stepIndex, instruction: shown(instruction), totalSteps });
        // Masked here, where the message first becomes the thing the IPC
        // event, the report and the log carry — the same seam the CLI, the
        // Sessions API and the errand runner mask at. The message is the
        // author's and is interpolated with the rest of the line, so a
        // `{{password}}` written into one reaches this point resolved.
        const stepResult = deliberateFailResult(
          stepIndex,
          instruction,
          redact(
            deliberateFailError(flowControlClaim, instruction),
            this.secretsNow(),
          ),
        );
        if (this.config?.execution.screenshotOnFailure && this.page) {
          try {
            const shot = await captureScreenshot(this.page, this.config.browser.fullPageScreenshots);
            if (shot?.base64) stepResult.screenshotBase64 = shot.base64;
          } catch {
            // A missing screenshot must not turn the author's failure into a
            // runner error.
          }
        }
        const stepLoopMarker = loops.markerFor(i);
        if (stepLoopMarker) stepResult.loop = stepLoopMarker;
        this.stepResults.push(stepResult);
        this.emitStepDetails(stepIndex, stepResult);
        this.emit('runner:step-complete', {
          stepIndex,
          status: 'failed',
          durationMs: 0,
          ...(stepResult.error !== undefined && { error: stepResult.error }),
          deliberate: true,
        });
        this.conversationHistory.push(
          formatStepHistoryEntry(stepIndex, shown(instruction), false, this.page?.url()),
        );
        bail = true;
        continue;
      }

      // --- Handle a bare `Return` / `Stop` step ---
      // No condition to judge, so no model call, no page snapshot
      // (stories/step-flow-control.md, decision 3).
      if (flowControlClaim && flowControlClaim.body === undefined) {
        // Skipped lines BELOW this one first, exactly as the ordinary step
        // path does — a chain's untaken members sit on both sides of the taken
        // one, and a `Return` written as a chain tail is a step like any other
        // as far as ordering goes.
        flushSkips(i);
        this.emit('runner:step-start', { stepIndex, instruction: shown(instruction), totalSteps });
        const stepResult: StepResult = {
          index: stepIndex,
          instruction,
          status: 'passed',
          turns: [],
          durationMs: 0,
          retried: false,
          // `isReturnClaim` narrows the union: a `flowControl` record means the
          // step ended the flow as a PASS, which a `fail` claim never does — it
          // took the branch above (stories/step-failure-outcomes.md, decision 1).
          ...(isReturnClaim(flowControlClaim) && {
            flowControl: { kind: 'return' as const, verb: flowControlClaim.verb },
          }),
        };
        const label = flowFrame();
        nameFlow(stepResult, label);
        this.stepResults.push(stepResult);
        this.emit('runner:step-complete', { stepIndex, status: 'passed', durationMs: 0 });
        i = skipRestOfFlow(label);
        this.conversationHistory.push(
          formatStepHistoryEntry(stepIndex, shown(instruction), true, this.page?.url()),
        );
        this.conversationHistory.push(
          `[flow] step ${stepIndex} ${stepResult.aiExplanation} — the rest of that flow was skipped`,
        );
        continue;
      }

      // --- Handle [input: variable] steps ---
      const inputMatch = instruction.match(INPUT_STEP_PATTERN);
      if (inputMatch) {
        const variable = inputMatch[1]!;
        const promptText = inputMatch[2]?.trim() || `Enter value for "${variable}"`;
        const stepStartTime = Date.now();

        this.emit('runner:step-start', { stepIndex, instruction: shown(instruction), totalSteps });

        // Pause and wait for user input
        this.emit('runner:paused', {
          stepIndex,
          reason: 'input',
          inputPrompt: promptText,
          inputVariable: variable,
        });

        const value = await this.waitForInput();
        if (this.stopped) break;

        // Same rule as `inputResponse` above, at the loop's own end of the
        // handshake.
        bindVariable(this.resolvedParameters, variable, value);

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
          formatStepHistoryEntry(stepIndex, shown(instruction), true, this.page?.url()),
        );

        i = advance(i);
        continue;
      }

      // --- Handle [interactive] steps ---
      const interactiveMatch = instruction.match(INTERACTIVE_STEP_PATTERN);
      if (interactiveMatch) {
        this.emit('runner:step-start', { stepIndex, instruction: shown(instruction), totalSteps });

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
          formatStepHistoryEntry(stepIndex, shown(instruction), true, this.page?.url()),
        );

        i = advance(i);
        continue;
      }

      // --- Normal step execution ---
      this.emit('runner:step-start', { stepIndex, instruction: shown(instruction), totalSteps });

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
        structureMemo: this.structureMemo,
        // Keyless, same as the steering call above — both call sites or
        // neither: a run and a steer on the same machine must not disagree
        // about whether there is AI to heal with.
        ...(runIsKeyless(this.config) && { keyless: true }),
        ...(this.config.ai.allowInRuns === false && { keylessReason: 'policy' as const }),
        // What lets the model's `return` action end the step. Only the
        // conditional form reaches here (stories/step-flow-control.md), and
        // since stories/step-failure-outcomes.md decision 1 the same field
        // carries a conditional `fail` claim.
        ...(flowControlClaim && { flowControlClaim }),
        // This step's `… otherwise …` tail, applied at one seam over a step
        // that has finally failed (decision 4).
        ...(failureTail && { failureTail }),
        stats: this.statsNow(),
      },
      // The step as AUTHORED, tokens intact: what the model reads, beside a
      // `## Values` block in which a secret is masked. Without it the executor
      // falls back to the substituted text above and shows the model the
      // password itself. The CLI passes the same argument.
      rawInstruction);

      // Skipped lines BELOW this one, before anything of this step is said.
      // A chain's untaken members sit on both sides of the taken one, so the
      // ones behind us are released here — and released before this step's own
      // events, or the renderer's log reads 1, 2, 6, 3, 4, 5 for a chain whose
      // first branch was taken. The results array was always in order (this
      // ran before the push); the events were not.
      flushSkips(i);

      // Emit sub-actions and screenshots
      this.emitStepDetails(stepIndex, result);

      // Named before `ai-reasoning` is emitted, so the UI shows "Returned
      // from …" rather than the model's bare fragment.
      const flowLabel = result.flowControl ? flowFrame() : null;
      if (result.flowControl) nameFlow(result, flowLabel);

      // Which loop pass this step belongs to — the band the report draws
      // around it. Stamped before the push, which is the only chance: the
      // array holds the object, and the report is generated off it.
      const stepLoop = loops.markerFor(i);
      if (stepLoop) result.loop = stepLoop;

      // Pushed before the skipped steps so the report keeps its order.
      this.stepResults.push(result);

      // Emit AI reasoning
      if (result.aiExplanation) {
        this.emit('runner:ai-reasoning', { stepIndex, text: result.aiExplanation });
      }

      // Emit step-complete. `status` stays `'failed'` for a tolerated step —
      // it did not do what it said — and the two flags beside it are what let
      // the panel paint amber and word the log line
      // (stories/step-failure-outcomes.md, decisions 6 and 9).
      this.emit('runner:step-complete', {
        stepIndex,
        status: result.status === 'passed' ? 'passed' : 'failed',
        durationMs: result.durationMs,
        ...(result.error !== undefined && { error: result.error }),
        ...(result.tolerated && { tolerated: true }),
        // The author's sentence. `error` reaches the panel already; the
        // warning only does if it is carried explicitly, because the row's
        // explanation that also holds it never crosses the IPC boundary.
        ...(result.warning !== undefined && { warning: result.warning }),
        ...(result.deliberate && { deliberate: true }),
      });

      // The skipped steps come after the returning step's own completion.
      // `advance(i)` is the ordinary answer: a step that closes a loop body
      // jumps back to its guard rather than to the next line.
      const resumeAt = result.flowControl ? skipRestOfFlow(flowLabel) : advance(i);

      // Add to conversation history
      const currentUrl = this.page.url();
      this.conversationHistory.push(
        formatStepHistoryEntry(stepIndex, shown(instruction), result.status === 'passed', currentUrl),
      );
      // The skipped steps are not in the history, so the returning step's own
      // line has to explain the gap (story decision 4).
      if (result.flowControl) {
        this.conversationHistory.push(
          `[flow] step ${stepIndex} ${result.aiExplanation ?? 'returned'} — the rest of that flow was skipped`,
        );
      }

      // The step failed and the run carries on past it — the entry above says
      // it failed, so without this line the model's `## Prior Steps` reads a
      // framework that ignored a failure (decision 6).
      if (result.tolerated) {
        this.conversationHistory.push(toleratedHistoryLine(stepIndex));
      }

      // `!result.tolerated`: the author said to carry on, so no bail
      // (stories/step-failure-outcomes.md, decision 6). The row stays a
      // failure and `toleratedSteps` below counts it.
      if (result.status === 'failed' && !result.tolerated) {
        bail = true;
      }

      this.tokenTracker.resetStep();
      i = resumeAt;
    }

    if (hasControls) flushSkips('all');

    // 10. Emit completion
    // `!s.tolerated`: a failure the author said to carry past is not what makes
    // a run red (stories/step-failure-outcomes.md, decision 6). Counted
    // separately below rather than dropped — the row still says `failed`.
    const failedSteps = this.stepResults.filter(
      (s) => s.status === 'failed' && !s.tolerated,
    ).length;
    const toleratedSteps = this.stepResults.filter(
      (s) => s.status === 'failed' && s.tolerated,
    ).length;
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
          // Steps a `return` left behind. Omitted (not 0) when there were
          // none (stories/step-flow-control.md, decision 15).
          ...(this.stepResults.some((s) => s.status === 'skipped') && {
            skippedSteps: this.stepResults.filter((s) => s.status === 'skipped').length,
          }),
          // Omitted (not 0) when nothing was tolerated, the rule
          // `skippedSteps` sets one line up
          // (stories/step-failure-outcomes.md, decision 6).
          ...(toleratedSteps > 0 && { toleratedSteps }),
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
          redactReport(report, this.secretsNow()),
          this.config.reports.outputDir,
        );
      } catch {
        // Report generation failure should not affect run result
      }
    }

    // The run line, beside the report it links (docs/specs/SPEC-scoreboard.md
    // §8.2), with the report's own token totals.
    recordRunEnd(this.runStats, {
      status: overallStatus,
      aborted: this.stopped,
      ...(this.tokenTracker && {
        tokensIn: this.tokenTracker.inputTotal,
        tokensOut: this.tokenTracker.outputTotal,
      }),
      report: reportPath !== undefined ? pathResolve(reportPath) : null,
    });

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
    this.structureMemo = createStructureMemo();
    this.resolvedParameters = {};
    this.test = null;
    this.runStats = undefined;
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

import { randomUUID } from 'node:crypto';
import { basename, resolve as pathResolve } from 'node:path';
import type { Config } from '../config/types.js';
import type { ParsedTest } from '../parser/types.js';
import { parseTestFile } from '../parser/markdown.js';
import { loadContextFiles } from '../context/loader.js';
import { AiClient } from '../ai/client.js';
import { TokenTracker } from '../utils/tokens.js';
import { logger } from '../utils/logger.js';
import {
  compileTest,
  type CompileEvent,
  type CompilePhase,
  type CompileResult,
  type CompileRunOutcome,
  type CompileRunner as CompileRunnerFn,
  type CompileSelect,
  type CompileStatus,
  type CompileSummary,
} from '../codebehind/compile.js';
import { applyEnvToAiConfig } from './run-helpers.js';
import type { ProjectBundle, ProjectBundleResolver } from './project-bundle.js';
import type { SessionManager, StepRequest } from './session-manager.js';

/**
 * `POST /codebehind/compile` (stories/codebehind-compile.md §Server).
 *
 * The compile core with a server around it: it resolves the project the same
 * way a run does, drives Record and Replay through the session machinery so
 * they use the project's browser and appear in `GET /sessions` like any other
 * run, and streams the phases out. It writes nothing under the project except
 * the gitignored candidate — `dryRun` is forced on, and the proposed files go
 * back on the wire for TestBench to apply through a diff.
 */

export interface CompileRequest {
  /** Absolute path of the test file. */
  testFilePath: string;
  /**
   * The editor's steps, for the mismatch guard below. Compile parses the file
   * from disk (it needs the whole expansion — parameters, skills, sections —
   * and the replay runs the file itself), so an unsaved buffer would compile
   * against something the author cannot see.
   */
  steps?: string[];
  /** Inline section bodies, same shape as the step route's. Accepted for the
   *  same guard; the parse reads the file's own sections. */
  sections?: Record<string, { name: string; headingLine: number; steps: string[]; stepLines: number[] }>;
  envName?: string;
  /** Compile from this open session's last run instead of recording. */
  fromSessionId?: string;
  select?: CompileSelect;
  maxRounds?: number;
  /** Accepted and echoed, but the server always compiles dry — see the class
   *  comment. A client asking for `dryRun: false` gets the files, not a write. */
  dryRun?: boolean;
}

/**
 * What the compile stream carries.
 *
 * Same framing as the step stream — one SSE frame per event, `type` naming it —
 * but its own event names, because a compile is not a run: nothing here has a
 * line number, and a client that renders `step:pass` in the gutter must not
 * render "step 4 generated" there.
 */
export type CompileWireEvent =
  | { type: 'compile:phase'; phase: CompilePhase; round?: number; message: string }
  | { type: 'compile:step'; phase: CompilePhase; step: number; message: string }
  | { type: 'compile:done'; status: CompileStatus; message: string }
  | {
      type: 'compile:result';
      status: CompileStatus;
      /** Proposed content by absolute `.steps.ts` path. Empty unless green. */
      files: Record<string, string>;
      summary: CompileSummary;
    }
  | { type: 'output'; msg: string; kind: 'info' | 'warn' | 'error' };

export type CompileEventListener = (event: CompileWireEvent) => void;

/** Refusals the route turns into a status code rather than a stream. */
export class CompileRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CompileRefused';
  }
}

export class CodeBehindCompiler {
  /** Test files being compiled right now — one compile per file at a time. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly config: Config,
    private readonly sessions: SessionManager,
    private readonly projectBundles: ProjectBundleResolver,
  ) {}

  /**
   * Is a compile of this file running?
   *
   * Read by the route before it opens the stream — a 409 has to be a status
   * code, and once the headers are flushed the answer is a 200 whatever
   * happens. `compile` checks again for the same reason `executeSteps` queues:
   * two callers can both read false.
   */
  isCompiling(testFilePath: string): boolean {
    return this.inFlight.has(pathResolve(testFilePath));
  }

  /**
   * Compile one test.
   *
   * Throws `CompileRefused` for anything the caller could have avoided (a
   * second compile of the same file, a test file that will not parse); every
   * other outcome — including a red compile — is a resolved `CompileResult`,
   * because "the replay never went green" is an answer, not an error.
   */
  async compile(
    request: CompileRequest,
    emit: CompileEventListener,
    signal?: AbortSignal,
  ): Promise<CompileResult> {
    const testFilePath = pathResolve(request.testFilePath);
    if (this.inFlight.has(testFilePath)) {
      throw new CompileRefused(
        409,
        `A compile of ${basename(testFilePath)} is already running. ` +
          'One compile per test file at a time.',
      );
    }
    this.inFlight.add(testFilePath);
    // Counted as a run in flight for the whole compile, exactly as an errand is
    // (stories/errands.md §The wheel): a compile drives browsers and spends
    // tokens for minutes, and a server that reaped itself halfway through would
    // lose all of it.
    const releaseRun = this.sessions.beginExternalRun();
    try {
      return await this.compileLocked(testFilePath, request, emit, signal);
    } finally {
      releaseRun();
      this.inFlight.delete(testFilePath);
    }
  }

  private async compileLocked(
    testFilePath: string,
    request: CompileRequest,
    emit: CompileEventListener,
    signal?: AbortSignal,
  ): Promise<CompileResult> {
    const envName = request.envName?.trim() || null;
    const bundle = await this.projectBundles.resolve(testFilePath, envName);
    const projectRoot = bundle.projectRoot ?? process.cwd();

    let test: ParsedTest;
    try {
      test = await parseTestFile(testFilePath, {
        skillsDir: pathResolve(projectRoot, bundle.config.tests.skillsDir),
        ...(bundle.envBundle && {
          envData: {
            env: bundle.envBundle.env,
            data: bundle.envBundle.data,
            envName: bundle.envBundle.envName,
          },
        }),
      });
    } catch (err) {
      throw new CompileRefused(400, `Could not parse ${basename(testFilePath)}: ${String(err)}`);
    }

    // The buffer-vs-disk guard. Not fatal — the author may have reordered a
    // step the compiler does not care about — but silence here means compiling
    // a file the author is not looking at.
    if (request.steps && request.steps.length !== test.steps.length) {
      emit({
        type: 'output',
        kind: 'warn',
        msg:
          `The editor sent ${request.steps.length} step(s) and ${basename(testFilePath)} has ` +
          `${test.steps.length} on disk — compiling what is on disk. Save the file first.`,
      });
    }

    const context = await loadContextFiles(pathResolve(projectRoot, bundle.config.tests.contextDir));
    const tokenTracker = new TokenTracker();
    const aiClient = new AiClient(
      applyEnvToAiConfig(bundle.config.ai, bundle.envBundle?.env),
      tokenTracker,
    );

    const recorded = this.reuseRun(request.fromSessionId, test, emit);

    return compileTest({
      test,
      config: bundle.config,
      contextContent: context.combined,
      aiClient,
      tokenTracker,
      ...(request.select && { select: request.select }),
      ...(request.maxRounds !== undefined && { maxRounds: request.maxRounds }),
      // Always. The server writes nothing under the project; the proposed files
      // ride back on `compile:result` and TestBench applies them through a diff
      // so the write is undoable and shows up in Source Control.
      dryRun: true,
      ...(recorded && { recorded }),
      onEvent: (event) => emit(toWireEvent(event)),
      ...(signal && { signal }),
      runner: this.sessionRunner(test, bundle, envName, emit),
    });
  }

  /**
   * The "Compile from this run" input, when the named session can supply one.
   *
   * Valid only while that session is open, only if the run passed, and only if
   * its steps carry the DOM either side — an ordinary run captures no step
   * context, so most sessions cannot answer and the compile records instead.
   * Every refusal says which, because "it recorded anyway" is otherwise a
   * silent extra AI run of the whole test.
   */
  private reuseRun(
    fromSessionId: string | undefined,
    test: ParsedTest,
    emit: CompileEventListener,
  ): CompileRunOutcome | undefined {
    if (!fromSessionId) return undefined;
    const decline = (why: string): undefined => {
      emit({
        type: 'output',
        kind: 'warn',
        msg: `Cannot compile from session ${fromSessionId}: ${why}. Recording instead.`,
      });
      return undefined;
    };

    const details = this.sessions.lastRunDetails(fromSessionId);
    if (!details) return decline('it is closed, gone, or has not run');
    if (details.status !== 'passed') return decline('that run did not pass');
    const steps: CompileRunOutcome['steps'] = new Array(test.steps.length).fill(undefined);
    for (const step of details.steps) {
      if (step.hookScope || step.interactiveAdHoc || step.interactiveChild) continue;
      const at = step.index - 1;
      if (at >= 0 && at < steps.length) steps[at] = step;
    }
    const captured = steps.filter((s) => s?.stepContext?.domBefore !== undefined).length;
    if (captured === 0) return decline('its step results carry no DOM snapshots');

    emit({
      type: 'output',
      kind: 'info',
      msg: `Compiling from session ${fromSessionId} (${captured} step(s) with page context).`,
    });
    return {
      status: 'passed',
      steps,
      resolvedParameters: details.parameters,
      tokensUsed: details.tokens,
    };
  }

  /**
   * Run the test through the session machinery, once per Record/Replay.
   *
   * A fresh session per run and closed after: a compile's Record must not
   * inherit a page some earlier run left behind, and its Replay must not
   * inherit the Record's.
   *
   * The steps go out already expanded, with the compiler's own expansion handed
   * over for the code-behind registry. Re-expanding server-side would be a
   * second answer to "which `.steps.ts` does step 7 bind into", and the two
   * only have to disagree once for a skill's entries to land in the test's file.
   */
  private sessionRunner(
    test: ParsedTest,
    bundle: ProjectBundle,
    envName: string | null,
    emit: CompileEventListener,
  ): CompileRunnerFn {
    return async (run) => {
      const label = run.purpose === 'record' ? 'Record' : `Replay ${run.round ?? 1}`;
      const sessionId = `compile:${randomUUID()}`;
      const stepRequest: StepRequest = {
        steps: test.steps,
        parameters: { ...test.parameters },
        testFilePath: test.filePath,
        sourceLines: test.stepLines,
        ...(envName && { envName }),
        ...(bundle.envBundle && { env: bundle.envBundle.env }),
        // The action cache is off for both phases on purpose: a Record wants
        // the model's actual transcript, and a Replay wants the entry to run.
        cacheEnabled: false,
        config: {
          ...(test.config.baseUrl !== undefined && { baseUrl: test.config.baseUrl }),
          ...(test.config.timeout !== undefined && { timeout: test.config.timeout }),
        },
      };

      let details: CompileRunOutcome | undefined;
      try {
        const response = await this.sessions.executeSteps(
          sessionId,
          stepRequest,
          (event) => {
            if (event.type === 'step:fail') {
              emit({ type: 'output', kind: 'warn', msg: `${label}: step failed — ${event.error}` });
            }
          },
          run.signal,
          {
            codeBehind: {
              expansion: {
                steps: test.steps,
                rawSteps: test.expansion?.rawSteps ?? test.steps,
                origins:
                  test.expansion?.origins ?? test.steps.map((_, i) => ({ inputIndex: i, frameId: '' })),
                frames: test.expansion?.frames ?? {},
              },
              ...(run.candidateFiles && { candidateFiles: run.candidateFiles }),
              ...(run.disableCodeBehind && { disabled: true }),
              strict: run.strict,
              captureContext: run.captureContext,
            },
            onRunDetails: (d) => {
              const steps: CompileRunOutcome['steps'] = new Array(test.steps.length).fill(undefined);
              for (const step of d.steps) {
                if (step.hookScope || step.interactiveAdHoc || step.interactiveChild) continue;
                const at = step.index - 1;
                if (at >= 0 && at < steps.length) steps[at] = step;
              }
              details = {
                status: 'failed',
                steps,
                resolvedParameters: d.parameters,
                tokensUsed: d.tokens,
              };
            },
          },
        );
        return {
          status: response.status === 'passed' ? 'passed' : 'failed',
          steps: details?.steps ?? [],
          resolvedParameters: details?.resolvedParameters ?? {},
          tokensUsed: details?.tokensUsed ?? 0,
        };
      } finally {
        // Best-effort: a browser the compile leaves open outlives the compile.
        await this.sessions.closeSession(sessionId).catch((err: unknown) => {
          logger.debug(`Could not close compile session ${sessionId}: ${String(err)}`);
        });
      }
    };
  }
}

function toWireEvent(event: CompileEvent): CompileWireEvent {
  if (event.kind === 'phase') {
    return {
      type: 'compile:phase',
      phase: event.phase,
      ...(event.round !== undefined && { round: event.round }),
      message: event.message,
    };
  }
  if (event.kind === 'step') {
    return {
      type: 'compile:step',
      phase: event.phase,
      step: event.step,
      message: event.message,
    };
  }
  return { type: 'compile:done', status: event.status, message: event.message };
}

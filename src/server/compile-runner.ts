import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { basename, dirname, join as pathJoin, resolve as pathResolve } from 'node:path';
import type { Config } from '../config/types.js';
import type { ParsedTest } from '../parser/types.js';
import { parseTestFile } from '../parser/markdown.js';
import { loadContextFiles } from '../context/loader.js';
import { AiClient } from '../ai/client.js';
import { TokenTracker } from '../utils/tokens.js';
import { logger } from '../utils/logger.js';
import { readDefaultEnvVars, readEnvFileVars } from '../env/loader.js';
import {
  compileTest,
  firstDataRow,
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
import type { RunDetails, RunEvent, SessionManager, StepRequest } from './session-manager.js';

/**
 * `POST /codebehind/compile` (stories/codebehind-compile.md §Server, amended by
 * stories/codebehind-compile-as-a-run.md).
 *
 * The compile core with a server around it: it resolves the project the same
 * way a run does, drives Record and Replay through the session machinery so
 * they use the project's browser and appear in `GET /sessions` like any other
 * run, and streams the phases out — every inner run's events included, so a
 * client paints a compile the way it paints a run. It writes nothing under the
 * project except the gitignored candidate — `dryRun` is forced on, and the
 * proposed files go back on the wire for TestBench to apply through a diff.
 *
 * Given the caller's session, it compiles from that session's last run when
 * the run can serve as a recording — green, or red as a prefix — and records
 * *in* that session when it cannot, leaving it open where the run ended, as a
 * Run would.
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
  /**
   * Inline section bodies, same shape as the step route's. Accepted and
   * validated, and then not used: the parse above reads the file's own
   * sections, so a client that sends these is describing the same thing. On
   * the allow-list because the story's request shape names it and a field the
   * route silently swallowed would be worse than one it declares.
   */
  sections?: Record<string, { name: string; headingLine: number; steps: string[]; stepLines: number[] }>;
  envName?: string;
  /**
   * The caller's session — the one TestBench runs this test in. Its last run
   * is the recording when it can be (it started at step 1 and kept the DOM
   * either side of its steps), and otherwise Record runs in it, not in a
   * throwaway session, and leaves it open. Without it, Record runs in a fresh
   * session that is closed afterwards.
   */
  sessionId?: string;
  select?: CompileSelect;
  maxRounds?: number;
  /**
   * Accepted for parity with `aiui compile --dry-run`, and ignored: the server
   * always compiles dry because it never writes under the project. A client
   * asking for `dryRun: false` gets the proposed files, not a write.
   */
  dryRun?: boolean;
}

/**
 * What the compile stream carries.
 *
 * Same framing as the step stream — one SSE frame per event, `type` naming it —
 * with its own event names for the compile's own phases. A Record or Replay is
 * a real run of the test, though, and its events ride along unchanged inside
 * `compile:run`, where a client folds them exactly as it folds a run's.
 */
export type CompileWireEvent =
  | { type: 'compile:phase'; phase: CompilePhase; round?: number; message: string }
  | { type: 'compile:step'; phase: CompilePhase; step: number; line?: number; message: string }
  | { type: 'compile:done'; status: CompileStatus; message: string }
  | {
      type: 'compile:result';
      status: CompileStatus;
      /** Proposed content by absolute `.steps.ts` path. Empty when failed. */
      files: Record<string, string>;
      summary: CompileSummary;
    }
  | {
      type: 'compile:run';
      /** Which of the compile's runs this event belongs to. */
      phase: 'record' | 'replay';
      /** 1-based replay round. */
      round?: number;
      /** The run's own event, untouched. */
      event: RunEvent;
    }
  | { type: 'output'; msg: string; kind: 'info' | 'warn' | 'error' };

export type CompileEventListener = (event: CompileWireEvent) => void;

/**
 * A refusal with a status code attached.
 *
 * The code is honoured only for a refusal the route can see BEFORE it opens
 * the stream — in practice the 409, which is why the route asks
 * `isCompiling` itself. Anything raised once the compile is under way arrives
 * as an error frame instead: the headers are long gone by then.
 */
export class CompileRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CompileRefused';
  }
}

/**
 * The lock key for a test file.
 *
 * `path.resolve` alone is not enough on Windows, where it preserves the
 * drive-letter case it was handed: TestBench's paths come from `uri.fsPath`,
 * which lower-cases the drive, while a CLI or MCP caller's usually does not.
 * Two spellings of one file would then take two locks and compile the same
 * test twice, concurrently, each proposing a whole `.steps.ts` for it.
 */
function lockKey(testFilePath: string): string {
  const resolved = pathResolve(testFilePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
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
    return this.inFlight.has(lockKey(testFilePath));
  }

  /**
   * Compile one test.
   *
   * Throws `CompileRefused` for anything the caller could have avoided (a
   * second compile of the same file, a test file that will not parse, a
   * session with a run in flight); every other outcome — including a red
   * compile — is a resolved `CompileResult`, because "the replay never went
   * green" is an answer, not an error.
   */
  async compile(
    request: CompileRequest,
    emit: CompileEventListener,
    signal?: AbortSignal,
  ): Promise<CompileResult> {
    const testFilePath = pathResolve(request.testFilePath);
    const key = lockKey(testFilePath);
    if (this.inFlight.has(key)) {
      throw new CompileRefused(
        409,
        `A compile of ${basename(testFilePath)} is already running. ` +
          'One compile per test file at a time.',
      );
    }
    this.inFlight.add(key);
    // Counted as a run in flight for the whole compile, exactly as an errand is
    // (stories/errands.md §The wheel): a compile drives browsers and spends
    // tokens for minutes, and a server that reaped itself halfway through would
    // lose all of it.
    const releaseRun = this.sessions.beginExternalRun();
    try {
      return await this.compileLocked(testFilePath, request, emit, signal);
    } finally {
      releaseRun();
      this.inFlight.delete(key);
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
    // The server's own `ai` config, with the project's env over it — the same
    // client a session builds, and deliberately NOT the project config's `ai`
    // block. A compile is a run plus some prompts, and a compile that called a
    // different model (or gateway) than the run it is compiling would be
    // generating code for a recording it could not have made. Caught live:
    // a project pinning a placeholder gatewayUrl recorded fine through the
    // session and then failed at Generate with "Connection error".
    const aiClient = new AiClient(
      applyEnvToAiConfig(this.config.ai, bundle.envBundle?.env),
      tokenTracker,
    );

    const recorded = this.reuseRun(request.sessionId, test, emit);

    // What a Run resolves `$VAR` parameters against. TestBench composes it on
    // the client: the nearest `.env` walking up from the test file, with
    // `.env.<name>` overlaid when an env is active. The server's env bundle
    // reads `<projectRoot>/.env` only — and nothing at all for a nameless
    // run — so the map is composed here the way the client composes it.
    const { env, dotenv } = await runEnvFor(testFilePath, bundle.projectRoot, envName);
    if (!dotenv) {
      emit({
        type: 'output',
        kind: 'warn',
        msg:
          `No .env found above ${basename(testFilePath)} — $VAR parameters resolve from the ` +
          "server's own environment only.",
      });
    } else if (bundle.projectRoot && dirname(dotenv) !== pathResolve(bundle.projectRoot)) {
      emit({
        type: 'output',
        kind: 'info',
        msg: `$VAR parameters resolve from ${dotenv} (not beside the project's aiui.config.json).`,
      });
    }
    const dataRow = bundle.projectRoot ? await firstDataRow(test, bundle.projectRoot) : undefined;
    if (dataRow) {
      emit({
        type: 'output',
        kind: 'info',
        msg: `Data file ${test.frontmatter.dataFile}: compiling with row 1 of ${dataRow.of}.`,
      });
    }

    return compileTest({
      test,
      config: bundle.config,
      contextContent: context.combined,
      aiClient,
      tokenTracker,
      env,
      ...(dataRow && { dataRow: dataRow.row }),
      ...(request.select && { select: request.select }),
      ...(request.maxRounds !== undefined && { maxRounds: request.maxRounds }),
      // Always. The server writes nothing under the project; the proposed files
      // ride back on `compile:result` and TestBench applies them through a diff
      // so the write is undoable and shows up in Source Control.
      dryRun: true,
      ...(recorded && { recorded }),
      onEvent: (event) => emit(toWireEvent(event)),
      ...(signal && { signal }),
      runner: this.sessionRunner(test, bundle, envName, emit, request.sessionId),
    });
  }

  /**
   * The caller's last run, when it can serve as the recording.
   *
   * It can when it started at step 1 — the whole test, or a prefix of it — and
   * its steps carry the DOM either side, which a run captures when the client
   * asked it to (`StepRequest.captureStepContext`). Green or red: a run that
   * stopped at step k is a recording of 1..k-1, and the core compiles that
   * prefix. Every refusal says which, because "it recorded anyway" is
   * otherwise a silent extra run of the whole test.
   */
  private reuseRun(
    sessionId: string | undefined,
    test: ParsedTest,
    emit: CompileEventListener,
  ): CompileRunOutcome | undefined {
    if (!sessionId) return undefined;
    const decline = (why: string): undefined => {
      emit({
        type: 'output',
        kind: 'warn',
        msg: `Cannot compile from session ${sessionId}'s last run: ${why}. Recording in it instead.`,
      });
      return undefined;
    };

    const details = this.sessions.lastRunDetails(sessionId);
    if (!details) {
      emit({
        type: 'output',
        kind: 'info',
        msg: `Session ${sessionId} has no run to compile from — recording in it.`,
      });
      return undefined;
    }
    if (details.coverage === 'partial') return decline('it started partway into the test');
    const steps = outcomeSteps(details, test.steps.length);
    const captured = steps.filter((s) => s?.stepContext?.domBefore !== undefined).length;
    if (captured === 0) return decline('its step results carry no DOM snapshots');
    const ran = steps.filter((s) => s !== undefined).length;
    if (details.coverage === 'whole' && details.status === 'passed' && ran !== test.steps.length) {
      return decline(`it ran ${ran} step(s) and the test has ${test.steps.length} now`);
    }

    const passed = steps.findIndex((s) => s?.status !== 'passed');
    emit({
      type: 'output',
      kind: 'info',
      msg:
        details.status === 'passed' && passed < 0
          ? `Compiling from session ${sessionId}'s last run (${ran} step(s), green, ${captured} with page context).`
          : `Compiling from session ${sessionId}'s last run — it stopped at step ${passed + 1}; ` +
            'the steps before it are the recording.',
    });
    return {
      status: details.status,
      steps,
      resolvedParameters: details.parameters,
      tokensUsed: details.tokens,
    };
  }

  /**
   * Run the test through the session machinery, once per Record/Replay.
   *
   * Record runs in the caller's session when one is named — the browser the
   * author watches, left open where the run ended — and in a fresh session
   * closed afterwards when none is. Replay always gets a fresh session, closed
   * after the round: a round must start from a clean page, and a replay in the
   * caller's session would overwrite the recording the compile is working from
   * with a run that has no transcripts.
   *
   * The steps go out already expanded, with the compiler's own expansion handed
   * over for the code-behind registry. Re-expanding server-side would be a
   * second answer to "which `.steps.ts` does step 7 bind into", and the two
   * only have to disagree once for a skill's entries to land in the test's file.
   * A prefix replay sends fewer steps; the expansion's indices still line up.
   *
   * Every event the run emits rides the compile stream inside `compile:run`.
   */
  private sessionRunner(
    test: ParsedTest,
    bundle: ProjectBundle,
    envName: string | null,
    emit: CompileEventListener,
    callerSessionId: string | undefined,
  ): CompileRunnerFn {
    return async (run) => {
      const inCallerSession = run.purpose === 'record' && callerSessionId !== undefined;
      const sessionId = inCallerSession ? callerSessionId : `compile:${randomUUID()}`;
      const count = run.throughStep !== undefined ? run.throughStep : test.steps.length;

      if (inCallerSession) {
        const status = this.sessions.sessionStatus(sessionId);
        if (status === 'executing') {
          throw new CompileRefused(
            409,
            `Session ${sessionId} is busy — a run is executing or paused in it. ` +
              'Let it finish, or stop it, then compile.',
          );
        }
        emit({
          type: 'output',
          kind: 'info',
          msg:
            status === null
              ? `Recording in session ${sessionId} (opening it).`
              : `Recording in session ${sessionId}.`,
        });
      }

      const stepRequest: StepRequest = {
        steps: test.steps.slice(0, count),
        // The compile's resolved map, never the parsed test's raw values.
        parameters: { ...run.parameters },
        testFilePath: test.filePath,
        sourceLines: test.stepLines.slice(0, count),
        ...(envName && { envName }),
        ...(bundle.envBundle && { env: bundle.envBundle.env }),
        // A Record in the caller's session is an ordinary run, cache as the
        // project has it: a cached transcript is the model's own actions,
        // recorded earlier, and with `captureStepContext` it comes with the
        // DOM either side. A Replay wants the entry to run, so the cache is
        // off; so is a Record in a throwaway session, as it always was.
        cacheEnabled: inCallerSession && bundle.config.cache.enabled,
        captureStepContext: run.captureContext,
        // Config belongs to a session's first request only. A caller's session
        // that already exists has one; a fresh one — compile's own, or the
        // caller's when they never ran — takes the test's.
        ...(!(inCallerSession && this.sessions.sessionStatus(sessionId) !== null) && {
          config: {
            ...(test.config.baseUrl !== undefined && { baseUrl: test.config.baseUrl }),
            ...(test.config.timeout !== undefined && { timeout: test.config.timeout }),
          },
        }),
      };

      let details: CompileRunOutcome | undefined;
      try {
        const response = await this.sessions.executeSteps(
          sessionId,
          stepRequest,
          (event) => {
            emit({
              type: 'compile:run',
              phase: run.purpose,
              ...(run.round !== undefined && { round: run.round }),
              event,
            });
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
            },
            onRunDetails: (d) => {
              details = {
                status: 'failed',
                steps: outcomeSteps(d, test.steps.length),
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
        // The caller's session is theirs and stays open, as after a Run. A
        // compile's own session is closed: best-effort, because a browser the
        // compile leaves open outlives the compile.
        if (!inCallerSession) {
          await this.sessions.closeSession(sessionId).catch((err: unknown) => {
            logger.debug(`Could not close compile session ${sessionId}: ${String(err)}`);
          });
        }
      }
    };
  }
}

/**
 * A run's step records, indexed by expanded step (`index - 1`) and sparse
 * where the run has nothing. Hook results and interactive rows share the index
 * space with real steps, so they are dropped rather than allowed to overwrite
 * one.
 */
function outcomeSteps(details: RunDetails, totalSteps: number): CompileRunOutcome['steps'] {
  const steps: CompileRunOutcome['steps'] = new Array(totalSteps).fill(undefined);
  for (const step of details.steps) {
    if (step.hookScope || step.interactiveAdHoc || step.interactiveChild) continue;
    const at = step.index - 1;
    if (at >= 0 && at < totalSteps) steps[at] = step;
  }
  return steps;
}

/**
 * The env map a Run of this test resolves `$VAR` parameters against, composed
 * the way the env bundle composes — process baseline lowest, then the base
 * `.env`, then `.env.<name>` highest — except that the base `.env` is the one
 * TestBench would find: the nearest one walking up from the test file, which
 * in a normal project is `<projectRoot>/.env` and in a workspace that keeps
 * its `.env` above the project is that one. `.env.<name>` is read from the
 * project root, where the env selector enumerates them.
 */
async function runEnvFor(
  testFilePath: string,
  projectRoot: string | null,
  envName: string | null,
): Promise<{ env: Record<string, string>; dotenv: string | null }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  const dotenv = await nearestDotEnv(dirname(testFilePath));
  if (dotenv) {
    for (const [k, v] of Object.entries(await readDefaultEnvVars(dirname(dotenv)))) {
      if (!(k in env)) env[k] = v;
    }
  }
  if (envName && projectRoot) {
    Object.assign(env, await readEnvFileVars(envName, projectRoot));
  }
  return { env, dotenv };
}

/** The nearest `.env` in `dir` or any directory above it, or null. */
async function nearestDotEnv(dir: string): Promise<string | null> {
  let current = pathResolve(dir);
  for (let i = 0; i < 64; i++) {
    const candidate = pathJoin(current, '.env');
    try {
      await access(candidate);
      return candidate;
    } catch {
      // keep walking
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function toWireEvent(event: CompileEvent): CompileWireEvent {
  if (event.kind === 'note') {
    return { type: 'output', kind: event.level, msg: event.message };
  }
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
      ...(event.line !== undefined && { line: event.line }),
      message: event.message,
    };
  }
  return { type: 'compile:done', status: event.status, message: event.message };
}

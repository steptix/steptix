import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AiClient } from '../ai/client.js';
import type { Config } from '../config/types.js';
import type { ParsedTest } from '../parser/types.js';
import type { StepResult, TestReport } from '../report/types.js';
import type { TokenTracker } from '../utils/tokens.js';
import { logger } from '../utils/logger.js';
import {
  buildCodeBehindRegistry,
  resolveCodeBehindCacheDir,
  type CodeBehindBinding,
} from './loader.js';
import {
  aiEntryFor,
  askForEntry,
  generateStepEntry,
  stepParameters,
  type GeneratedEntry,
} from './generate.js';
import { buildRepairPrompt } from './repair.js';
import { buildFileReviewPrompt, parseFileRevision } from './review.js';
import { clearStale, readLastRun } from './last-run.js';
import {
  createFile,
  listEntries,
  spliceEntry,
  validateCodeBehindSource,
  writeCodeBehindFile,
  type WriteEntryRequest,
} from './writer.js';
import { findInlinedParameterValue } from '../ai/action-parser.js';
import { loadDataFile } from '../parser/parameters.js';
import { recordingDirFor, writeReplayFailure } from './recording.js';

/**
 * The compiler (stories/codebehind-compile.md, "The compile pipeline").
 *
 * Record → Select → Generate → Review → Replay → Write, one core used by the
 * CLI in-process and, later, by the server for TestBench. It prints nothing
 * and writes nothing outside the gitignored candidate until the last phase:
 * callers observe progress through `onEvent` and decide what to do with the
 * proposed files.
 */

export type CompilePhase =
  | 'record'
  | 'select'
  | 'generate'
  | 'review'
  | 'replay'
  | 'repair'
  | 'write';

export type CompileEvent =
  /** A phase started, or reported its result. */
  | { kind: 'phase'; phase: CompilePhase; round?: number; message: string }
  /** Something happened to one step, 1-based. `line` is the step's source
   *  line in the test file when the test knows it — a client paints ▶ on it
   *  while the model works on that step. */
  | { kind: 'step'; phase: CompilePhase; step: number; line?: number; message: string }
  /** Something the author should know that belongs to no phase — an
   *  unresolved parameter, a data row chosen. The server carries it as an
   *  `output` frame; the CLI prints it as one. */
  | { kind: 'note'; level: 'info' | 'warn'; message: string }
  /** Terminal. Always emitted exactly once. */
  | { kind: 'done'; status: CompileStatus; message: string };

/**
 * `partial` (stories/codebehind-compile-as-a-run.md §Write what passed): the
 * compile proposes what it has — proven entries, write-offs, entries no round
 * reached — and the summary says which is which. `failed` proposes nothing.
 */
export type CompileStatus = 'green' | 'partial' | 'failed';

/** Which steps get (re)generated. Empty selects "no entry, or flagged stale". */
export interface CompileSelect {
  /** Only steps a previous run flagged `codeBehindStale`. */
  onlyStale?: boolean;
  /** Every eligible step, including ones with working entries. */
  all?: boolean;
  /** Explicit 1-based step numbers. */
  steps?: number[];
}

export interface CompileSummary {
  /** Absolute path of the test file. */
  test: string;
  totalSteps: number;
  /** Steps whose entries this pass generated. */
  compiled: number;
  /** Steps whose existing entries were kept verbatim. */
  kept: number;
  /** Steps that stay AI — existing `ai: true` entries plus new declines. */
  keptAi: number;
  /** Replay rounds run (including the confirming round). */
  rounds: number;
  /** Tokens the whole compile spent, runs included. */
  tokensUsed: number;
  /** Absolute paths written. Empty on a dry run or a failure. */
  written: string[];
  /** Where the candidate was left when nothing was written. */
  candidatePath?: string | undefined;
  /** Why the compile is not green. */
  error?: string | undefined;
  /**
   * Steps (1-based) whose new entries no replay round executed to a pass.
   * Proposed as code all the same: the next run proves each one (⚙) or flags
   * it (⚠), which is the loop that already handles entries that rot.
   */
  unproven: number[];
  /** Steps (1-based) this compile wrote off as `ai: true` after a replay
   *  failure — with the error as the entry's comment. */
  writtenOffAi: number[];
  /** Where the recording stopped, when it did not reach the end of the test.
   *  The compile was then a prefix compile of the steps before it. */
  stoppedAt?: { step: number; error: string } | undefined;
  /** Selected steps the prefix never reached, so nothing was generated for
   *  them. They have no entry, and the next compile's default selection takes
   *  them. */
  notAttempted: number[];
  /** Where the recording — and the candidate, and any replay failure — were
   *  written: the test's `.aiui-codebehind-cache/<name>.recording/`. */
  recordingDir: string;
}

export interface CompileResult {
  status: CompileStatus;
  /** Proposed content, keyed by absolute `.steps.ts` path. A test that invokes
   *  skills compiles into the skills' own files, so this can span several. */
  files: Record<string, string>;
  summary: CompileSummary;
}

/** One run the compiler asked for. */
export interface CompileRunRequest {
  /** `record` runs under AI; `replay` runs the candidate as strict code. */
  purpose: 'record' | 'replay';
  /**
   * The parameter map the run starts from — the test's `## Parameters` with
   * `$VAR` values resolved and the data row applied, exactly what a Run
   * sends. A runner must use this and not the parsed test's raw values:
   * the parser keeps `$GITHUB_USERNAME` as written, and a run started from
   * that types it into the page.
   */
  parameters: Record<string, string>;
  /** 1-based replay round, for logs. */
  round?: number;
  /** Canonical `.steps.ts` path → the path to load instead. */
  candidateFiles?: Record<string, string>;
  /**
   * Ignore existing entries entirely (Record only). A step served by its own
   * code-behind leaves no transcript, and generation would then have nothing
   * to work from.
   */
  disableCodeBehind?: boolean;
  strict: boolean;
  /** Capture DOM + URL either side of each step (record only). */
  captureContext: boolean;
  /**
   * Run the first N steps only (replay of a prefix compile). The outcome is
   * still indexed by expanded step, sparse from N on.
   */
  throughStep?: number;
  signal?: AbortSignal | undefined;
}

export interface CompileRunOutcome {
  status: 'passed' | 'failed';
  /** One entry per expanded step, indexed by `step.index - 1`. Sparse when a
   *  run bailed early. */
  steps: (StepResult | undefined)[];
  /** The run's final parameter map, for the leak guard and the prompt. */
  resolvedParameters: Record<string, string>;
  tokensUsed: number;
}

/** How the compiler executes the test. Injected so the pipeline is testable
 *  without a browser, and so phase B's server can drive its own session. */
export type CompileRunner = (request: CompileRunRequest) => Promise<CompileRunOutcome>;

export interface CompileOptions {
  /** The parsed test, already skill/section-expanded. */
  test: ParsedTest;
  config: Config;
  contextContent: string;
  aiClient: AiClient;
  /** Reads the compile's own prompt tokens; the runs report theirs. */
  tokenTracker?: TokenTracker | undefined;
  select?: CompileSelect | undefined;
  /**
   * The env map `$VAR` parameter values resolve against — the project's
   * `.env` layers, composed the way the caller's runs compose them. A Run
   * resolves these before it starts (TestBench on the client, `aiui run`
   * from `process.env`); the compile has to do the same for its own runs,
   * and nothing downstream does it.
   */
  env?: Record<string, string> | undefined;
  /**
   * A data-file row to apply over the parameters, as `aiui run` does for a
   * test with `dataFile:` in its frontmatter. A compile records once, so the
   * caller picks a row — `firstDataRow` picks the first.
   */
  dataRow?: Record<string, string> | undefined;
  /** Replay rounds before a step is written off as AI. Default 3. */
  maxRounds?: number | undefined;
  /** Run everything but Write. */
  dryRun?: boolean | undefined;
  /**
   * A run to compile from, instead of recording a fresh one. Green, or red or
   * stopped: a run that did not reach the end is a recording of the steps it
   * did reach, and the compile is a prefix compile of those.
   */
  recorded?: CompileRunOutcome | undefined;
  onEvent?: ((event: CompileEvent) => void) | undefined;
  signal?: AbortSignal | undefined;
  /** Overrides the default `runTest`-backed runner. */
  runner?: CompileRunner | undefined;
}

const DEFAULT_MAX_ROUNDS = 3;

/**
 * One step's place in the compile.
 *
 * `key` identifies the *entry*, not the step: a section or skill body is
 * defined once and inlined many times, so several expanded steps can share one
 * entry. Generation is keyed by entry, which is why the same body compiles once
 * however many times it is called.
 */
interface CompileStep {
  /** 0-based expanded index. */
  index: number;
  /** 1-based display number. */
  number: number;
  /** Authored text — an entry's `source`. */
  text: string;
  binding?: CodeBehindBinding | undefined;
  key?: string | undefined;
  hasEntry: boolean;
  isAiEntry: boolean;
  /** Why this step can never be in S, when it can't. */
  ineligible?: string | undefined;
}

export async function compileTest(options: CompileOptions): Promise<CompileResult> {
  const emit = options.onEvent ?? ((): void => {});
  const test = options.test;
  const maxRounds = Math.max(1, options.maxRounds ?? DEFAULT_MAX_ROUNDS);
  const runner = options.runner ?? createTestFileRunner(options);
  const candidate = new Candidate();
  let runTokens = 0;
  let rounds = 0;

  /** A step event, with the step's source line when the test knows it. */
  const stepEvent = (phase: CompilePhase, step: CompileStep, message: string): void => {
    const line = test.stepLines[step.index];
    emit({
      kind: 'step',
      phase,
      step: step.number,
      ...(typeof line === 'number' && line > 0 && { line }),
      message,
    });
  };

  // The parameters every run starts from. Resolved here, once, through the
  // same chain a run uses — data row, `$VAR` from the env, the inline value —
  // because a recording made with `$GITHUB_USERNAME` typed into the username
  // field is a recording of nothing, and a replay started from it fails at
  // the same place.
  const resolvedParameters = resolveCompileParameters(
    test.parameters,
    options.env ?? {},
    options.dataRow,
  );
  for (const key of resolvedParameters.unresolved) {
    emit({
      kind: 'note',
      level: 'warn',
      message:
        `parameter "${key}" is ${test.parameters[key]} and nothing in the environment defines it — ` +
        'the runs will use that literal',
    });
  }
  const parameters = resolvedParameters.values;

  const tokens = (): number => (options.tokenTracker?.total ?? 0) + runTokens;
  const finish = (
    status: CompileStatus,
    summary: Partial<Omit<CompileSummary, 'test' | 'totalSteps' | 'tokensUsed' | 'rounds'>> &
      Pick<CompileSummary, 'compiled' | 'kept' | 'keptAi' | 'written'>,
    message: string,
  ): CompileResult => {
    emit({ kind: 'done', status, message });
    return {
      status,
      // What passed is proposed (stories/codebehind-compile-as-a-run.md §Write
      // what passed): a partial compile hands back the candidate as it stands,
      // and only a failed one — nothing generated, or nothing trustworthy —
      // hands back nothing.
      files: status === 'failed' ? {} : candidate.changedFiles(),
      summary: {
        test: test.filePath,
        totalSteps: test.steps.length,
        rounds,
        tokensUsed: tokens(),
        unproven: [],
        writtenOffAi: [],
        notAttempted: [],
        recordingDir: recordingDirFor(test.filePath),
        ...summary,
      },
    };
  };

  // ─── 1. Select ────────────────────────────────────────────────────────────
  //
  // Ahead of Record, not after it as the story's phase order suggests: Record
  // is a full AI run of the test, and running one to discover there was nothing
  // to compile is the most expensive way to learn that. Everything selection
  // needs — which steps have entries, and which a previous run flagged — is
  // already on disk in the file and the last-run sidecar.
  const steps = await describeSteps(test);
  const staleKeys = await collectStaleKeys(test, options.recorded, steps);
  let selection = selectSteps(steps, options.select ?? {}, staleKeys);
  if (selection.errors.length > 0) {
    return finish(
      'failed',
      { compiled: 0, kept: 0, keptAi: 0, written: [], error: selection.errors[0]! },
      selection.errors[0]!,
    );
  }
  const keptAiExisting = steps.filter((s) => s.isAiEntry).length;
  const keptExistingFor = (sel: Selection): number =>
    steps.filter((s) => s.hasEntry && !s.isAiEntry && s.key !== undefined && !sel.keys.has(s.key))
      .length;
  let keptExisting = keptExistingFor(selection);
  emit({
    kind: 'phase',
    phase: 'select',
    message:
      `${selection.order.length} step(s) to generate, ` +
      `${keptExisting} kept, ${keptAiExisting} already AI`,
  });
  if (selection.order.length === 0) {
    // Nothing to do is a green outcome, not a failure — `compile` after a clean
    // run should say "already compiled", not exit 1.
    return finish(
      'green',
      { compiled: 0, kept: keptExisting, keptAi: keptAiExisting, written: [] },
      'Nothing to compile — every step already has code-behind.',
    );
  }

  // ─── 2. Record ────────────────────────────────────────────────────────────
  //
  // Code-behind stays ON unless the selection includes a step that already has
  // a working entry (`--all`, or `--steps` naming one): only then does a step
  // served by its entry hide the transcript generation needs. With it on, a
  // Record of a half-compiled test runs the compiled half as code — and is an
  // ordinary run in every respect, sidecar included.
  let record = options.recorded;
  if (record) {
    emit({ kind: 'phase', phase: 'record', message: 'reusing the supplied run' });
  } else {
    const needsAllTranscripts = selection.order.some((s) => s.hasEntry && !s.isAiEntry);
    emit({
      kind: 'phase',
      phase: 'record',
      message: needsAllTranscripts
        ? `running ${test.steps.length} step(s) under AI (code-behind off)`
        : `running ${test.steps.length} step(s)`,
    });
    record = await runner({
      purpose: 'record',
      parameters: { ...parameters },
      strict: false,
      captureContext: true,
      ...(needsAllTranscripts && { disableCodeBehind: true }),
      ...(options.signal && { signal: options.signal }),
    });
    runTokens += record.tokensUsed;
  }

  // A Record with code-behind on can flag an entry stale — it threw and the
  // step healed under AI — and that step now has a transcript to regenerate
  // from. It joins the selection the way a sidecar flag would have, which the
  // modes honour as they do any stale flag: the default and `--only-stale`
  // take it, `--steps` ignores it.
  const recordStale = new Set(staleKeys);
  for (const step of steps) {
    if (step.key && record.steps[step.index]?.codeBehindStale) recordStale.add(step.key);
  }
  if (recordStale.size > staleKeys.size) {
    const widened = selectSteps(steps, options.select ?? {}, recordStale);
    for (const step of widened.order) {
      if (!selection.keys.has(step.key!)) {
        stepEvent('select', step, 'joined the selection: its entry failed during Record');
      }
    }
    selection = widened;
    keptExisting = keptExistingFor(selection);
  }

  // Where the recording stopped. A run that failed or was stopped at step k is
  // a recording of steps 1..k-1, and the compile is a prefix compile: what
  // those steps produced is worth keeping, and the rest has no transcript at
  // all (stories/codebehind-compile-as-a-run.md §Write what passed).
  const prefixEnd = leadingPassed(record.steps);
  let stoppedAt: CompileSummary['stoppedAt'];
  let notAttempted: number[] = [];
  /** How many steps a replay runs — the prefix, or the whole test. */
  let throughStep: number | undefined;
  if (prefixEnd < test.steps.length) {
    const stoppedStep = record.steps[prefixEnd];
    const error =
      stoppedStep?.error ??
      (record.status === 'passed'
        ? 'the run stopped before this step'
        : 'the run failed before this step');
    stoppedAt = { step: prefixEnd + 1, error };
    const inPrefix = selection.order.filter((s) => s.number <= prefixEnd);
    notAttempted = selection.order.filter((s) => s.number > prefixEnd).map((s) => s.number);
    if (inPrefix.length === 0) {
      return finish(
        'failed',
        {
          compiled: 0,
          kept: keptExisting,
          keptAi: keptAiExisting,
          written: [],
          stoppedAt,
          notAttempted,
          error: `the recording stopped at step ${stoppedAt.step} (${error}) and no step before it needs compiling`,
        },
        `Record stopped at step ${stoppedAt.step} — ${error}. Nothing before it needs compiling; ` +
          'fix that step, run, and compile again.',
      );
    }
    emit({
      kind: 'phase',
      phase: 'record',
      message:
        `stopped at step ${stoppedAt.step} — ${error}; compiling ${inPrefix.length} step(s) before it` +
        (notAttempted.length > 0 ? ` (${listSteps(notAttempted)} not attempted)` : ''),
    });
    selection = { keys: new Set(inPrefix.map((s) => s.key!)), order: inPrefix, errors: [] };
    keptExisting = keptExistingFor(selection);
    throughStep = prefixEnd;
  }

  // ─── 3. Generate ──────────────────────────────────────────────────────────
  emit({ kind: 'phase', phase: 'generate', message: `${selection.order.length} step(s)` });
  let declined = 0;
  /** Steps this compile wrote off as `ai: true` after a replay failure. */
  const writtenOffAi: number[] = [];
  for (const step of selection.order) {
    if (options.signal?.aborted) {
      return finish('failed', { compiled: 0, kept: keptExisting, keptAi: keptAiExisting, written: [], error: 'aborted' }, 'Compile aborted.');
    }
    const result = record.steps[step.index];
    const generated = await generateStepEntry({
      binding: step.binding!,
      actions: actionsOf(result),
      ...(result?.assertions && { assertions: result.assertions }),
      resolvedParameters: record.resolvedParameters,
      aiClient: options.aiClient,
      contextContent: options.contextContent,
      testName: test.title,
      ...(test.config.baseUrl !== undefined && { baseUrl: test.config.baseUrl }),
      ...(options.signal && { signal: options.signal }),
      wholeTest: wholeTestFor(steps, selection.keys, step),
      candidateFile: (await candidate.read(step.binding!.file)) ?? undefined,
      ...contextOf(result),
    });
    const applied = applyGenerated(candidate, step, generated, stepEvent, 'generate');
    if (applied.kind === 'declined') declined++;
    if (applied.kind === 'error') {
      return finish(
        'failed',
        {
          compiled: 0,
          kept: keptExisting,
          keptAi: keptAiExisting,
          written: [],
          candidatePath: await candidate.persist(),
          error: `generation failed for step ${step.number}: ${applied.message}`,
        },
        `Generate failed at step ${step.number}: ${applied.message}`,
      );
    }
  }

  // The candidate trail (stories/codebehind-recording-on-disk.md): what the
  // compile has so far, on disk beside the recording, after every stage.
  await candidate.persist();

  // ─── 4. Review ────────────────────────────────────────────────────────────
  await reviewCandidate(candidate, test, parameters, options, emit);
  await candidate.persist();

  // ─── 5. Replay ────────────────────────────────────────────────────────────
  //
  // Every entry in S ends up proven (passed as code in the last round that
  // reached it, not regenerated since), written off (`ai: true` with the
  // error), or unreached. All three are proposed; the summary says which is
  // which (stories/codebehind-compile-as-a-run.md §Write what passed).
  let green = false;
  let lastFailure: { step: CompileStep; error: string; result?: StepResult | undefined } | undefined;
  /** Why the compile is not green, when it is not. */
  let failure: string | undefined;
  const proven = new Set<string>();
  const stepsInS = (): CompileStep[] => steps.filter((s) => s.key && selection.keys.has(s.key));
  const markRound = (outcome: CompileRunOutcome): void => {
    for (const step of stepsInS()) {
      if (outcome.steps[step.index]?.status === 'passed') proven.add(step.key!);
    }
  };
  const replay = async (round: number): Promise<CompileRunOutcome> => {
    rounds = round;
    const overrides = await candidate.materialise();
    emit({
      kind: 'phase',
      phase: 'replay',
      round,
      message: `running ${throughStep ?? test.steps.length} step(s) as code`,
    });
    const outcome = await runner({
      purpose: 'replay',
      parameters: { ...parameters },
      round,
      strict: true,
      captureContext: false,
      candidateFiles: overrides,
      ...(throughStep !== undefined && { throughStep }),
      ...(options.signal && { signal: options.signal }),
    });
    runTokens += outcome.tokensUsed;
    await candidate.clearMaterialised();
    markRound(outcome);
    return outcome;
  };
  const replayTotal = throughStep ?? test.steps.length;
  /** Where a replay failed, or undefined when the run failed without a step. */
  const failureOf = (
    outcome: CompileRunOutcome,
  ): { step: CompileStep | undefined; result: StepResult | undefined; error: string } => {
    const failedAt = outcome.steps.findIndex((s) => s?.status === 'failed');
    const result = failedAt >= 0 ? outcome.steps[failedAt] : undefined;
    return {
      step: failedAt >= 0 ? steps[failedAt] : undefined,
      result,
      error: result?.error ?? 'the run failed without naming a step',
    };
  };
  const writeOff = async (step: CompileStep, error: string, after: string): Promise<void> => {
    stepEvent('replay', step, `kept as AI ${after}: ${error}`);
    candidate.apply(step, aiEntryFor(step.text, `replay kept failing — ${error}`));
    await candidate.persist();
    proven.delete(step.key!);
    declined++;
    writtenOffAi.push(step.number);
  };

  for (let round = 1; round <= maxRounds; round++) {
    const outcome = await replay(round);
    if (outcome.status === 'passed') {
      emit({ kind: 'phase', phase: 'replay', round, message: `${replayTotal}/${replayTotal} passed as code` });
      green = true;
      break;
    }

    const failed = failureOf(outcome);
    emit({
      kind: 'phase',
      phase: 'replay',
      round,
      message: failed.step ? `✗ step ${failed.step.number} — ${failed.error}` : `✗ ${failed.error}`,
    });

    if (!failed.step || !failed.step.key) {
      return finish(
        'failed',
        {
          compiled: selection.order.length,
          kept: keptExisting,
          keptAi: keptAiExisting + declined,
          written: [],
          candidatePath: await candidate.persist(),
          error: failed.error,
        },
        `Replay failed and no step owns the failure: ${failed.error}`,
      );
    }

    // A failure on an entry the author owns is not the compiler's to rewrite.
    // The rounds stop here; what was proven before it is still proposed.
    if (!selection.keys.has(failed.step.key)) {
      failure =
        `existing entry for step ${failed.step.number} fails; recompile it with ` +
        `\`--steps ${failed.step.number}\` (or Compile This Step)`;
      break;
    }

    lastFailure = { step: failed.step, error: failed.error, result: failed.result };
    await writeReplayFailure(
      test.filePath,
      {
        round,
        step: failed.step.number,
        ...(typeof test.stepLines[failed.step.index] === 'number' && { line: test.stepLines[failed.step.index] }),
        error: failed.error,
        ...(failed.result?.pageUrl !== undefined && { url: failed.result.pageUrl }),
        ...(failed.result?.screenshotBase64 !== undefined && { screenshotBase64: failed.result.screenshotBase64 }),
        ...(failed.result?.domSnapshot !== undefined && { dom: failed.result.domSnapshot }),
      },
      parameters,
    );
    if (round === maxRounds) break;

    stepEvent('repair', failed.step, 'regenerating from the failure');
    const repaired = await repairStep(failed.step, failed.error, failed.result, record, options, candidate, {
      number: round,
      max: maxRounds,
    });
    proven.delete(failed.step.key);
    const applied = applyGenerated(candidate, failed.step, repaired, stepEvent, 'repair');
    await candidate.persist();
    if (applied.kind === 'declined') declined++;
    if (applied.kind === 'error') {
      return finish(
        'failed',
        {
          compiled: selection.order.length,
          kept: keptExisting,
          keptAi: keptAiExisting + declined,
          written: [],
          candidatePath: await candidate.persist(),
          error: `repair failed for step ${failed.step.number}: ${applied.message}`,
        },
        `Repair failed at step ${failed.step.number}: ${applied.message}`,
      );
    }
  }

  // A step that failed every round is written off: `ai: true` with the last
  // error as its comment, then one round to confirm the rest still passes.
  if (!green && !failure && lastFailure) {
    const { step, error } = lastFailure;
    await writeOff(step, error, `after ${maxRounds} round(s)`);
    const outcome = await replay(rounds + 1);
    green = outcome.status === 'passed';
    if (green) {
      emit({
        kind: 'phase',
        phase: 'replay',
        round: rounds,
        message: `${replayTotal}/${replayTotal} passed (step ${step.number} under AI)`,
      });
    } else {
      // The confirming round failed somewhere else. No further rounds — the
      // budget is spent — but the step it failed on gets the same answer the
      // first one did, and everything proven stays proven.
      const failed = failureOf(outcome);
      emit({
        kind: 'phase',
        phase: 'replay',
        round: rounds,
        message: failed.step
          ? `✗ step ${failed.step.number} — ${failed.error} (after keeping step ${step.number} as AI)`
          : `✗ ${failed.error}`,
      });
      if (!failed.step || !failed.step.key) {
        return finish(
          'failed',
          {
            compiled: selection.order.length - declined,
            kept: keptExisting,
            keptAi: keptAiExisting + declined,
            written: [],
            candidatePath: await candidate.persist(),
            error: failed.error,
          },
          `Replay failed and no step owns the failure: ${failed.error}`,
        );
      }
      if (!selection.keys.has(failed.step.key)) {
        failure =
          `existing entry for step ${failed.step.number} fails; recompile it with ` +
          `\`--steps ${failed.step.number}\` (or Compile This Step)`;
      } else {
        await writeReplayFailure(
          test.filePath,
          {
            round: rounds,
            step: failed.step.number,
            error: failed.error,
            ...(failed.result?.pageUrl !== undefined && { url: failed.result.pageUrl }),
            ...(failed.result?.screenshotBase64 !== undefined && { screenshotBase64: failed.result.screenshotBase64 }),
          },
          parameters,
        );
        if (failed.step.key !== step.key) await writeOff(failed.step, failed.error, 'in the confirming round');
        failure = `step ${failed.step.number} still fails as code: ${failed.error}`;
      }
    }
  }

  // ─── 6. Write ─────────────────────────────────────────────────────────────
  const compiled = selection.order.length - declined;
  const unproven = selection.order
    .filter((s) => !proven.has(s.key!) && !writtenOffAi.includes(s.number))
    .map((s) => s.number);
  // Green means the whole test replayed as code. A prefix compile that went
  // green only proved the prefix; the rest of the test is still to do.
  const status: CompileStatus = green && !stoppedAt ? 'green' : 'partial';
  const keptAi = keptAiExisting + declined;
  const tail = [
    writtenOffAi.length > 0 ? `${writtenOffAi.length} kept AI after replay failures` : '',
    unproven.length > 0 ? `${unproven.length} unproven (${listSteps(unproven)})` : '',
    stoppedAt ? `stopped at step ${stoppedAt.step}` : '',
  ].filter((s) => s !== '');
  const headline =
    `Compiled ${test.title}: ${compiled} step(s) as code, ${keptAi} kept AI` +
    (tail.length > 0 ? ` — ${tail.join(', ')}` : '') +
    '.';
  const extras = {
    unproven,
    writtenOffAi,
    ...(stoppedAt && { stoppedAt }),
    notAttempted,
    ...(failure !== undefined && { error: failure }),
  };

  const files = candidate.changedFiles();
  if (options.dryRun) {
    emit({ kind: 'phase', phase: 'write', message: 'dry run — nothing written' });
    return finish(
      status,
      { compiled, kept: keptExisting, keptAi, written: [], ...extras },
      green ? 'Compiled (dry run) — nothing written.' : `${headline} Dry run — nothing written.`,
    );
  }

  const written: string[] = [];
  for (const [file, content] of Object.entries(files)) {
    try {
      await writeCodeBehindFile(file, content);
    } catch (err) {
      return finish(
        'failed',
        {
          compiled,
          kept: keptExisting,
          keptAi,
          written,
          candidatePath: await candidate.persist(),
          error: (err as Error).message,
        },
        `Write failed: ${(err as Error).message}`,
      );
    }
    written.push(file);
    emit({ kind: 'phase', phase: 'write', message: `${path.basename(file)}` });
  }
  // The flags the compile acted on have been acted on: a proven entry replaced
  // the broken one, and a write-off is an `ai: true` entry the selection skips
  // anyway. An unproven entry keeps its flag — the next run decides.
  await clearStale(
    test.filePath,
    steps
      .filter(
        (s) => s.key && selection.keys.has(s.key) && (proven.has(s.key) || writtenOffAi.includes(s.number)),
      )
      .map((s) => s.number),
  );
  return finish(status, { compiled, kept: keptExisting, keptAi, written, ...extras }, headline);
}

/** How many leading steps of a run passed — the recording's usable prefix. */
function leadingPassed(steps: (StepResult | undefined)[]): number {
  let n = 0;
  for (const step of steps) {
    if (step?.status !== 'passed') break;
    n++;
  }
  return n;
}

/** "steps 6–9", "step 4", "steps 2, 5" — for messages. */
function listSteps(numbers: number[]): string {
  if (numbers.length === 0) return 'no steps';
  if (numbers.length === 1) return `step ${numbers[0]}`;
  const sorted = [...numbers].sort((a, b) => a - b);
  const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1]! + 1);
  return contiguous
    ? `steps ${sorted[0]}–${sorted[sorted.length - 1]}`
    : `steps ${sorted.join(', ')}`;
}

// ───────────────────────────────────────────────────────────────────────────
// Selection
// ───────────────────────────────────────────────────────────────────────────

/** Every expanded step, with its binding and why it can or cannot be in S. */
async function describeSteps(test: ParsedTest): Promise<CompileStep[]> {
  const registry = test.expansion
    ? await buildCodeBehindRegistry(
        {
          steps: test.steps,
          rawSteps: test.expansion.rawSteps,
          origins: test.expansion.origins,
          frames: test.expansion.frames,
        },
        { testFilePath: test.filePath, onWarn: () => {} },
      )
    : undefined;

  return test.steps.map((step, i) => {
    const binding = registry?.bindingFor(i);
    const text = binding?.source ?? test.expansion?.rawSteps[i] ?? step;
    const isAiEntry = binding?.entry?.ai === true;
    const ineligible = test.toolCalls[i]
      ? 'a [tool:] step is dispatched, not compiled'
      : !binding
        ? 'the step has no code-behind file to bind into'
        : undefined;
    return {
      index: i,
      number: i + 1,
      text,
      binding,
      ...(binding && { key: entryKeyOf(binding) }),
      hasEntry: binding?.entry !== undefined,
      isAiEntry,
      ...(ineligible !== undefined && { ineligible }),
    };
  });
}

/** Joins the parts of an entry key. NUL because it is the one character
 *  neither a path, a section name nor step text can contain — the same choice
 *  the loader's own index makes, and written as an escape so the file stays
 *  text as far as git is concerned. */
const KEY_SEP = '\u0000';

/** Identifies the entry a step binds to. Two inlinings of one body share it. */
function entryKeyOf(binding: CodeBehindBinding): string {
  return [binding.file, binding.section ?? '', binding.source, binding.occurrence].join(KEY_SEP);
}

/**
 * Keys of entries a run flagged as stale.
 *
 * Normally that is the last-run sidecar — the author ran the test, saw a ⚠,
 * and came here — or the supplied run, when the client passed one. Compile's
 * own Record is too late for this pass (selection runs first) and contributes
 * its flags afterwards, in `compileTest`.
 */
async function collectStaleKeys(
  test: ParsedTest,
  recorded: CompileRunOutcome | undefined,
  steps: CompileStep[],
): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const step of steps) {
    if (step.key && recorded?.steps[step.index]?.codeBehindStale) keys.add(step.key);
  }
  const sidecar = await readLastRun(test.filePath);
  for (const entry of sidecar?.steps ?? []) {
    if (!entry.stale) continue;
    const step = steps[entry.index - 1];
    if (step?.key && step.text === entry.source) keys.add(step.key);
  }
  return keys;
}

interface Selection {
  /** Entry keys in S. */
  keys: Set<string>;
  /** One representative step per key, in step order — the generation order. */
  order: CompileStep[];
  errors: string[];
}

/**
 * The selection set S (stories/codebehind-compile.md, "Select").
 *
 * Steps with no entry, steps flagged stale, and steps the author named.
 * Existing passing entries and every `ai: true` entry are kept verbatim;
 * `[tool:]` steps and steps with no defining file are never in S.
 */
export function selectSteps(
  steps: CompileStep[],
  select: CompileSelect,
  staleKeys: Set<string>,
): Selection {
  const errors: string[] = [];
  const named = new Set(select.steps ?? []);
  for (const n of named) {
    if (n < 1 || n > steps.length) {
      errors.push(`--steps names step ${n}, but this test has ${steps.length} step(s)`);
    }
  }

  const wanted = (step: CompileStep): boolean => {
    if (named.size > 0) return named.has(step.number);
    if (select.all) return true;
    if (select.onlyStale) return step.key !== undefined && staleKeys.has(step.key);
    return !step.hasEntry || (step.key !== undefined && staleKeys.has(step.key));
  };

  const keys = new Set<string>();
  const order: CompileStep[] = [];
  for (const step of steps) {
    if (!wanted(step)) continue;
    if (step.ineligible !== undefined) {
      // Naming an ineligible step explicitly deserves an answer, not silence.
      if (named.has(step.number)) {
        errors.push(`step ${step.number} cannot be compiled: ${step.ineligible}`);
      }
      continue;
    }
    // An `ai: true` entry is the author's opt-out. `--all` doesn't override it;
    // deleting the entry does.
    if (step.isAiEntry) continue;
    if (!step.key || keys.has(step.key)) continue;
    keys.add(step.key);
    order.push(step);
  }
  return { keys, order, errors };
}

/** The whole-test block for one generation prompt. */
function wholeTestFor(
  steps: CompileStep[],
  inScope: Set<string>,
  current: CompileStep,
): Array<{ index: number; text: string; inScope: boolean; isThisStep: boolean }> {
  return steps.map((s) => ({
    index: s.number,
    text: s.text,
    inScope: s.key !== undefined && inScope.has(s.key),
    isThisStep: s.index === current.index,
  }));
}

// ───────────────────────────────────────────────────────────────────────────
// Generation plumbing
// ───────────────────────────────────────────────────────────────────────────

function actionsOf(result: StepResult | undefined) {
  return (result?.turns ?? [])
    .flatMap((t) => t.subActions)
    .filter((sa) => !sa.error)
    .map((sa) => sa.action);
}

function contextOf(result: StepResult | undefined): {
  domBefore?: string;
  urlBefore?: string;
  domAfter?: string;
  urlAfter?: string;
} {
  const ctx = result?.stepContext;
  if (!ctx) return {};
  return {
    ...(ctx.domBefore !== undefined && { domBefore: ctx.domBefore }),
    ...(ctx.urlBefore !== undefined && { urlBefore: ctx.urlBefore }),
    ...(ctx.domAfter !== undefined && { domAfter: ctx.domAfter }),
    ...(ctx.urlAfter !== undefined && { urlAfter: ctx.urlAfter }),
  };
}

/**
 * Splice one generation answer into the candidate and say what happened.
 *
 * Returns the answer, except that a splice the writer refuses — an entry that
 * is not an object literal, a file with no `defineSteps([...])` to append to —
 * becomes an `error`, which every caller already treats as "stop, leave the
 * candidate, report". A throw here would escape `compileTest` entirely.
 */
function applyGenerated(
  candidate: Candidate,
  step: CompileStep,
  generated: GeneratedEntry,
  stepEvent: (phase: CompilePhase, step: CompileStep, message: string) => void,
  phase: CompilePhase,
): GeneratedEntry {
  try {
    if (generated.kind === 'entry') {
      candidate.apply(step, generated.code);
      stepEvent(phase, step, phase === 'repair' ? 'repaired' : 'generated');
    } else if (generated.kind === 'declined') {
      candidate.apply(step, aiEntryFor(step.text, generated.reason));
      stepEvent(phase, step, `kept as AI: ${generated.reason}`);
    }
    return generated;
  } catch (err) {
    return { kind: 'error', message: (err as Error).message };
  }
}

async function repairStep(
  step: CompileStep,
  error: string,
  failedResult: StepResult | undefined,
  record: CompileRunOutcome,
  options: CompileOptions,
  candidate: Candidate,
  round: { number: number; max: number },
): Promise<GeneratedEntry> {
  const parameters = stepParameters(step.binding!, record.resolvedParameters);
  const prompt = buildRepairPrompt({
    rawStepText: step.text,
    stepIndex: step.number,
    entryCode: candidate.entryTextFor(step) ?? '(entry unavailable)',
    error,
    ...(failedResult?.domSnapshot !== undefined && { dom: failedResult.domSnapshot }),
    ...(failedResult?.pageUrl !== undefined && { url: failedResult.pageUrl }),
    ...(failedResult?.screenshotBase64 !== undefined && {
      screenshotBase64: failedResult.screenshotBase64,
    }),
    parameters,
    round,
  });
  return askForEntry(
    options.aiClient,
    options.contextContent,
    prompt,
    parameters,
    options.signal,
  );
}

/**
 * The review pass. Non-fatal by construction: a revision that will not compile,
 * or that smuggles a parameter value in, is discarded and the pre-review
 * candidate stands.
 */
async function reviewCandidate(
  candidate: Candidate,
  test: ParsedTest,
  parameters: Record<string, string>,
  options: CompileOptions,
  emit: (event: CompileEvent) => void,
): Promise<void> {
  for (const file of candidate.touchedFiles()) {
    const before = candidate.contentOf(file);
    if (before === undefined) continue;
    let revised: string;
    try {
      const completion = await options.aiClient.complete(
        [
          buildFileReviewPrompt({
            markdownName: path.basename(test.filePath),
            file: before,
            steps: test.steps,
          }),
        ],
        options.signal,
      );
      revised = parseFileRevision(completion.text);
    } catch (err) {
      emit({
        kind: 'phase',
        phase: 'review',
        message: `skipped for ${path.basename(file)} (${(err as Error).message}) — the generated file stands`,
      });
      continue;
    }

    if (revised.trim() === before.trim()) {
      emit({ kind: 'phase', phase: 'review', message: `no changes to ${path.basename(file)}` });
      continue;
    }

    const leaked = findInlinedParameterValue(revised, allParameters(parameters));
    if (leaked) {
      emit({
        kind: 'phase',
        phase: 'review',
        message: `rejected: the revision inlines {{${leaked}}} — the generated file stands`,
      });
      continue;
    }
    // The reviewer edits entries; it does not decide which steps have one.
    // Caught live: given the whole test, it wrote an entry for the step a
    // prefix compile had deliberately left alone — code for a step nobody
    // recorded, which the next compile would then skip as "already has one".
    const entriesChanged = describeEntryChange(listEntries(before), listEntries(revised));
    if (entriesChanged) {
      emit({
        kind: 'phase',
        phase: 'review',
        message: `rejected: the revision ${entriesChanged} — the generated file stands`,
      });
      continue;
    }
    const invalid = await validateCodeBehindSource(file, revised);
    if (invalid) {
      emit({
        kind: 'phase',
        phase: 'review',
        message: `rejected: the revision does not compile (${invalid}) — the generated file stands`,
      });
      continue;
    }
    candidate.replaceFile(file, revised);
    emit({ kind: 'phase', phase: 'review', message: `revised ${path.basename(file)}` });
  }
}

/**
 * How a revision changed the SET of entries, or null when it did not. Order
 * and code are the reviewer's to change; which steps have an entry is not.
 */
function describeEntryChange(
  before: Array<{ source: string; section: string }>,
  after: Array<{ source: string; section: string }>,
): string | null {
  const key = (e: { source: string; section: string }): string => `${e.section}\u0000${e.source}`;
  const was = new Map<string, number>();
  for (const e of before) was.set(key(e), (was.get(key(e)) ?? 0) + 1);
  const now = new Map<string, number>();
  for (const e of after) now.set(key(e), (now.get(key(e)) ?? 0) + 1);
  const added = after.filter((e) => (now.get(key(e)) ?? 0) > (was.get(key(e)) ?? 0)).map((e) => e.source);
  const removed = before.filter((e) => (was.get(key(e)) ?? 0) > (now.get(key(e)) ?? 0)).map((e) => e.source);
  const quote = (sources: string[]): string => [...new Set(sources)].map((s) => JSON.stringify(s)).join(', ');
  if (added.length > 0 && removed.length > 0) {
    return `adds an entry for ${quote(added)} and removes ${quote(removed)}`;
  }
  if (added.length > 0) return `adds an entry for ${quote(added)}`;
  if (removed.length > 0) return `removes the entry for ${quote(removed)}`;
  return null;
}

/** Every parameter value in play, for the review's leak guard. Unlike the
 *  per-step guard this is deliberately broad: a whole-file rewrite can move a
 *  literal into any entry, so the check has to cover them all. The RESOLVED
 *  values: a guard that looked for `$GITHUB_PASSWORD` would wave the real
 *  password through. */
function allParameters(parameters: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(parameters).map(([name, value]) => ({ name, value }));
}

// ───────────────────────────────────────────────────────────────────────────
// Parameters
// ───────────────────────────────────────────────────────────────────────────

/**
 * The parameter map a compile's runs start from.
 *
 * The same chain `resolveParameters` walks for `aiui run`, minus the prompt —
 * a compile never asks — and against an explicit env map rather than
 * `process.env`, because on the server `process.env` is deliberately not the
 * project's: a data-row value wins, then a `$VAR` looks itself up in the env,
 * then the inline value stands. Extra row keys are merged in, as the runner
 * merges them. Names that were `$VAR` and found nothing come back in
 * `unresolved`, with the literal left in place so the caller can say so.
 */
export function resolveCompileParameters(
  raw: Record<string, string>,
  env: Record<string, string>,
  dataRow?: Record<string, string>,
): { values: Record<string, string>; unresolved: string[] } {
  const values: Record<string, string> = {};
  const unresolved: string[] = [];
  for (const [key, rawValue] of Object.entries(raw)) {
    if (dataRow && dataRow[key] !== undefined) {
      values[key] = dataRow[key]!;
      continue;
    }
    if (rawValue.startsWith('$')) {
      const fromEnv = env[rawValue.slice(1)];
      if (fromEnv !== undefined) {
        values[key] = fromEnv;
        continue;
      }
      unresolved.push(key);
    }
    values[key] = rawValue;
  }
  if (dataRow) {
    for (const [key, value] of Object.entries(dataRow)) {
      if (!(key in values)) values[key] = value;
    }
  }
  return { values, unresolved };
}

/**
 * The first row of the test's data file, when it names one, as the row a
 * compile records with. `aiui run` runs one instance per row; a compile
 * records once, and the entries it writes read parameters through
 * `step.getVar`, so they are the same code for every row.
 */
export async function firstDataRow(
  test: ParsedTest,
  projectRoot: string,
): Promise<{ row: Record<string, string>; of: number } | undefined> {
  const dataFile = test.frontmatter.dataFile;
  if (!dataFile) return undefined;
  const rows = await loadDataFile(dataFile, projectRoot);
  const row = rows[0];
  return row ? { row, of: rows.length } : undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// The candidate
// ───────────────────────────────────────────────────────────────────────────

/**
 * The proposed `.steps.ts` files, in memory.
 *
 * Nothing here touches the author's tree. Entries are spliced with the same
 * writer the runtime used to use, so hand edits elsewhere in a file survive
 * byte-for-byte; the files only reach disk in the Write phase, and the
 * gitignored `.candidate` copy only when a compile ends red.
 */
class Candidate {
  private readonly original = new Map<string, string | null>();
  private readonly current = new Map<string, string>();
  private readonly entryText = new Map<string, string>();
  private materialised: string[] = [];
  private persisted: string[] = [];

  /** The file as it stands, loading the on-disk original the first time. */
  async read(file: string): Promise<string | null> {
    if (!this.original.has(file)) {
      this.original.set(file, await readIfExists(file));
    }
    return this.current.get(file) ?? this.original.get(file) ?? null;
  }

  contentOf(file: string): string | undefined {
    return this.current.get(file);
  }

  touchedFiles(): string[] {
    return [...this.current.keys()];
  }

  /** Splice one entry in (or create the file). The section scope is the
   *  runner's, stamped by the writer — never the model's. */
  apply(step: CompileStep, entryCode: string): void {
    const binding = step.binding!;
    const request: WriteEntryRequest = {
      file: binding.file,
      source: binding.source,
      ...(binding.section !== undefined && { section: binding.section }),
      occurrence: binding.occurrence,
      entryCode,
      // The header names the file this code-behind belongs to — which for a
      // skill's entries is the skill, not the test that pulled it in.
      markdownFile: binding.file.replace(/\.steps\.ts$/, '.md'),
    };
    const before = this.current.get(binding.file) ?? this.original.get(binding.file) ?? null;
    this.current.set(
      binding.file,
      before === null ? createFile(request) : spliceEntry(before, request).text,
    );
    this.entryText.set(entryKeyOf(binding), entryCode);
  }

  /** The entry as last written into the candidate — the repair prompt's input. */
  entryTextFor(step: CompileStep): string | undefined {
    return step.key ? this.entryText.get(step.key) : undefined;
  }

  replaceFile(file: string, content: string): void {
    this.current.set(file, content);
  }

  /** Files whose content differs from what is on disk today. */
  changedFiles(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [file, content] of this.current) {
      if (content !== this.original.get(file)) out[file] = content;
    }
    return out;
  }

  /**
   * Write the candidates somewhere the loader can import them, and return the
   * override map. `.ts` because esbuild picks its loader by extension; inside
   * the gitignored cache dir beside the real file, because a `node_modules`
   * path segment would break the `ai-ui-automation/codebehind` self-reference.
   */
  async materialise(): Promise<Record<string, string>> {
    const overrides: Record<string, string> = {};
    for (const [file, content] of this.current) {
      const dir = resolveCodeBehindCacheDir(file);
      const target = path.join(
        dir,
        `${path.basename(file, '.ts')}.${randomUUID().slice(0, 8)}.candidate.ts`,
      );
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(target, content, 'utf-8');
      overrides[file] = target;
      this.materialised.push(target);
    }
    return overrides;
  }

  /** Remove the transient copies a replay round imported. */
  async clearMaterialised(): Promise<void> {
    for (const file of this.materialised) {
      await fs.rm(file, { force: true }).catch(() => {});
    }
    this.materialised = [];
  }

  /**
   * Write the candidate where the author can read it — the recording dir,
   * under the name the story gives it — and return the first path (what the
   * summary points at). Called after every stage, so the file is always the
   * compile's latest proposal; after Apply it is identical to the real file.
   */
  async persist(): Promise<string | undefined> {
    this.persisted = [];
    for (const [file, content] of this.current) {
      const target = path.join(
        resolveCodeBehindCacheDir(file),
        `${path.basename(file)}.candidate`,
      );
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, 'utf-8');
        this.persisted.push(target);
      } catch (err) {
        logger.debug(`Could not write the compile candidate at ${target}: ${String(err)}`);
      }
    }
    return this.persisted[0];
  }
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// The default runner
// ───────────────────────────────────────────────────────────────────────────

/**
 * Drive the real `runTest` in-process, once per phase that needs a run.
 *
 * Imported lazily so the pipeline — and its tests — never pull a browser into
 * the module graph unless a real run is actually asked for.
 */
export function createTestFileRunner(options: CompileOptions): CompileRunner {
  return async (request) => {
    const { runTest } = await import('../runner/test-runner.js');
    const report: TestReport = await runTest(
      {
        test: options.test,
        // The compile's resolved map, a fresh copy per run: `runTest` writes
        // captured values into it, and a replay must not start with the
        // record's leftovers.
        resolvedParameters: { ...request.parameters },
      },
      options.config,
      options.contextContent,
      undefined,
      {
        ...(request.candidateFiles && { codeBehindCandidates: request.candidateFiles }),
        ...(request.disableCodeBehind && { codeBehindDisabled: true }),
        codeBehindStrict: request.strict,
        captureStepContext: request.captureContext,
        ...(request.throughStep !== undefined && { stopAfterStep: request.throughStep }),
        ...(request.signal && { signal: request.signal }),
      },
    );
    return reportToOutcome(report, options.test.steps.length);
  };
}

/**
 * A run's report, reduced to what the compiler indexes by expanded step.
 *
 * Hook results and interactive ad-hoc rows share the `index` space with real
 * steps, so they are dropped rather than allowed to overwrite one.
 */
export function reportToOutcome(report: TestReport, totalSteps: number): CompileRunOutcome {
  const steps: (StepResult | undefined)[] = new Array(totalSteps).fill(undefined);
  for (const step of report.steps) {
    if (step.hookScope || step.interactiveAdHoc || step.interactiveChild) continue;
    const at = step.index - 1;
    if (at >= 0 && at < totalSteps) steps[at] = step;
  }
  return {
    status: report.status === 'passed' ? 'passed' : 'failed',
    steps,
    resolvedParameters: report.parameters ?? {},
    tokensUsed: report.tokensUsed,
  };
}

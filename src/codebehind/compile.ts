import path from 'node:path';
import type { AiClient } from '../ai/client.js';
import type { Config } from '../config/types.js';
import type { ParsedTest } from '../parser/types.js';
import type { StepResult, TestReport } from '../report/types.js';
import type { TokenTracker } from '../utils/tokens.js';
import { parseSetStep } from '../parser/set-step.js';
import { parseFlowControlStep } from '../parser/flow-control-step.js';
import { parseUseStep } from '../parser/use-step.js';
import { loopCompileRefusal } from '../runner/control-flow.js';
import { buildCodeBehindRegistry } from './loader.js';
import {
  aiEntryFor,
  anyActionCarriesPlaceholder,
  askForEntry,
  generateStepEntry,
  guardedValues,
  stepEnvRefs,
  stepParameters,
  SURFACE_SWITCH_NOT_COMPILED,
  valueMatchWarning,
  type GeneratedEntry,
} from './generate.js';
import { buildRepairPrompt } from './repair.js';
import { reviewCandidate } from './review.js';
// The two refusals both compilers say; they live beside `generationRefusal`.
// Safe in this direction because live-compile.ts's only reference back here is
// an `import type` (stories/step-failure-outcomes.md, decisions 10 and 11).
import {
  clipLine,
  DISPATCHED_NOT_COMPILED,
  endedAsWrittenReason,
  TOLERATED_FAILURE_REFUSAL,
} from './live-compile.js';
import { clearStale, readLastRun } from './last-run.js';
import { writeCodeBehindFile } from './writer.js';
import {
  actionsOf,
  applyGenerated,
  Candidate,
  contextOf,
  entryKeyOf,
  wholeTestFor,
  type CompilePhase,
  type CompileStep,
} from './candidate.js';
import {
  envDataRefsIn,
  envDataSecretValues,
  resolveEnvDataRef,
} from '../parser/interpolate-env-data.js';
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

export type { CompilePhase, CompileStep };

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
   * Proposed as code all the same: the next run proves each one (the code mark) or flags
   * it (⚠), which is the loop that already handles entries that rot.
   */
  unproven: number[];
  /** Steps (1-based) this compile wrote off as `ai: true` after a replay
   *  failure — with the error as the entry's comment. */
  writtenOffAi: number[];
  /** Where the recording stopped, when it did not reach the end of the test.
   *  The compile was then a prefix compile of the steps before it. */
  stoppedAt?: { step: number; error: string } | undefined;
  /**
   * Where the recording ENDED because a step's own text said to — the `fail`
   * verb (stories/step-failure-outcomes.md, decisions 1–3).
   *
   * Beside {@link stoppedAt} rather than inside it, and never both: every reader
   * of `stoppedAt` words itself "failed under AI — fix it, run, and compile
   * again", which is right for a recording that broke and wrong for one that
   * finished where the test says it finishes. A reader that knows only
   * `stoppedAt` therefore says nothing rather than the wrong thing.
   *
   * `line` is the ending step's authored text, for the parenthetical every
   * surface puts after the sentence.
   */
  endedAsWritten?: { step: number; error: string; line: string } | undefined;
  /** Selected steps the prefix never reached, so nothing was generated for
   *  them. They have no entry, and the next compile's default selection takes
   *  them. */
  notAttempted: number[];
  /** Where the recording — and the candidate, and any replay failure — were
   *  written: the test's `.aiui-codebehind-cache/<name>.recording/`. */
  recordingDir: string;
  /**
   * References the model did not name in its actions and the compile recovered
   * by comparing a recorded literal against the resolved value
   * (stories/placeholder-preserving-actions.md, decision 6).
   *
   * The compliance metric, and the only one: the sweep that decides the
   * fallback's fate is `aiui compile` over `templates/init/tests/*.md` and
   * `fixtures/tests/*.md`, summing this field. Empty is the goal.
   *
   * Optional so every existing producer of a summary — the server's failure
   * frame among them — still typechecks; the two compilers always set it.
   */
  recoveredByValue?: Array<{ step: number; name: string }> | undefined;
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
  /** Why the run failed when no step did — a candidate that could not be
   *  loaded. The compile reports it instead of "no step owns the failure". */
  error?: string;
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

export async function compileTest(options: CompileOptions): Promise<CompileResult> {
  const emit = options.onEvent ?? ((): void => {});
  const test = options.test;
  const maxRounds = Math.max(1, options.maxRounds ?? DEFAULT_MAX_ROUNDS);
  const runner = options.runner ?? createTestFileRunner(options);
  const candidate = new Candidate();
  let runTokens = 0;
  let rounds = 0;
  /** References the model did not name, recovered by value match — the
   *  compliance metric (stories/placeholder-preserving-actions.md §6). Read by
   *  `finish` at call time, so it is whatever Generate had reached. */
  const recoveredByValue: Array<{ step: number; name: string }> = [];

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
        recoveredByValue,
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
  // A loop is refused outright, before anything runs
  // (stories/control-flow.md). A compile places an entry at
  // `spans[occurrence]`, and occurrence is counted per step line — but a loop
  // body runs the same lines a number of times only the page decides, so the
  // Record produces N transcripts for one slot and the plan's "not attempted"
  // arithmetic counts a step that ran three times as one. Refusing is honest
  // and cheap; supporting it properly is its own story. A CHAIN compiles
  // normally: its steps run at most once, and the untaken branch is simply not
  // attempted, which the summary already has a word for.
  const loopLine = firstLoopGuard(test);
  if (loopLine !== undefined) {
    // `aiui compile` compiles a whole FILE — there is no slice to scope this
    // to, which is why the refusal stands here where the server's is now
    // bounded to the batch's own range. The wording is shared so the two
    // surfaces say the same thing about the same file.
    const message = loopCompileRefusal(loopLine);
    return finish('failed', { compiled: 0, kept: 0, keptAi: 0, written: [], error: message }, message);
  }

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

  // Where the recording stopped — or ENDED, which is a different thing. A run
  // that failed or was stopped at step k is a recording of steps 1..k-1, so the
  // compile is a prefix compile (stories/codebehind-compile-as-a-run.md §Write
  // what passed); a run a step's own text ended is a recording of 1..k
  // INCLUSIVE, because that step worked (stories/step-failure-outcomes.md,
  // decisions 1–3). Told apart here, once, because everything downstream words
  // itself off which happened.
  const prefixEnd = usablePrefix(record.steps);
  let stoppedAt: CompileSummary['stoppedAt'];
  /**
   * The step whose own text ended the recording, when one did
   * (stories/step-failure-outcomes.md, decisions 1–3).
   *
   * A field of its own rather than a `stoppedAt` with different words, because
   * every reader of `stoppedAt` says "failed under AI — fix that step, run, and
   * compile again" (src/cli/commands/compile.ts), and there is nothing to fix
   * here.
   *
   * Set ONLY when steps remain after the ending one — the whole branch below is
   * inside `prefixEnd < test.steps.length` — because that is the question the
   * field answers ("why has step 10 no entry"). The live compiler now narrows to
   * the same rule (`finish`, src/codebehind/live-compile.ts): setting it
   * whenever the loop reported one is how a `green` summary came to carry an
   * `error` on one path and nothing on the other.
   */
  let endedAsWritten: { step: number; error: string; line: string } | undefined;
  let notAttempted: number[] = [];
  /** How many steps a replay runs — the prefix, or the whole test. */
  let throughStep: number | undefined;
  if (prefixEnd < test.steps.length) {
    // `usablePrefix` counts a deliberate failure IN, so when one ended the
    // recording it is the last step of the prefix rather than the first one past
    // it — which is why one branch below names the step that broke and the other
    // names the step that finished.
    const endedIndex =
      prefixEnd > 0 && deliberateFailure(record.steps[prefixEnd - 1]) ? prefixEnd - 1 : -1;
    const stoppedStep = record.steps[prefixEnd];
    const error =
      endedIndex >= 0
        ? record.steps[endedIndex]?.error ?? 'the step failed as its text says'
        : stoppedStep?.error ??
          (record.status === 'passed'
            ? 'the run stopped before this step'
            : 'the run failed before this step');
    if (endedIndex >= 0) {
      endedAsWritten = {
        step: endedIndex + 1,
        error,
        line: steps[endedIndex]?.text ?? test.steps[endedIndex] ?? '',
      };
    } else {
      stoppedAt = { step: prefixEnd + 1, error };
    }
    const inPrefix = selection.order.filter((s) => s.number <= prefixEnd);
    notAttempted = selection.order.filter((s) => s.number > prefixEnd).map((s) => s.number);
    // Named one by one, not only counted: this is the author's answer to "why has
    // step 10 no entry" (stories/step-flow-control.md, decision 12, applied to
    // the other way a run can end early).
    if (endedAsWritten) {
      for (const step of selection.order.filter((s) => s.number > prefixEnd)) {
        stepEvent(
          'select',
          step,
          `not attempted: ${endedAsWrittenReason('run', endedAsWritten.step)} ` +
            `(${clipLine(endedAsWritten.line)})`,
        );
      }
    }
    if (inPrefix.length === 0) {
      if (endedAsWritten) {
        // `partial`, not `failed`: nothing went wrong — the recording ran to the
        // end the test declares, and the steps past it are work a later run has
        // to reach.
        return finish(
          'partial',
          {
            compiled: 0,
            kept: keptExisting,
            keptAi: keptAiExisting,
            written: [],
            notAttempted,
            endedAsWritten,
            error:
              `${endedAsWrittenReason('run', endedAsWritten.step)} ` +
              `(${clipLine(endedAsWritten.line)}) and no step up to it needs compiling`,
          },
          `Record ended at step ${endedAsWritten.step} as its text says — ${error}. ` +
            'Nothing up to it needs compiling' +
            (notAttempted.length > 0 ? `; ${listSteps(notAttempted)} did not run.` : '.'),
        );
      }
      return finish(
        'failed',
        {
          compiled: 0,
          kept: keptExisting,
          keptAi: keptAiExisting,
          written: [],
          stoppedAt: stoppedAt!,
          notAttempted,
          error: `the recording stopped at step ${stoppedAt!.step} (${error}) and no step before it needs compiling`,
        },
        `Record stopped at step ${stoppedAt!.step} — ${error}. Nothing before it needs compiling; ` +
          'fix that step, run, and compile again.',
      );
    }
    emit({
      kind: 'phase',
      phase: 'record',
      message:
        (endedAsWritten
          ? `ended at step ${endedAsWritten.step} as its text says — ${error}; ` +
            `compiling ${inPrefix.length} step(s) up to it`
          : `stopped at step ${stoppedAt!.step} — ${error}; compiling ${inPrefix.length} step(s) before it`) +
        (notAttempted.length > 0 ? ` (${listSteps(notAttempted)} not attempted)` : ''),
    });
    selection = { keys: new Set(inPrefix.map((s) => s.key!)), order: inPrefix, errors: [] };
    keptExisting = keptExistingFor(selection);
    throughStep = prefixEnd;
  }

  // A step the recording SKIPPED has no transcript at all: a return earlier in
  // its flow ended the flow before it ran (stories/step-flow-control.md,
  // decision 12). No transcript is no evidence, and generating from none is
  // worse than not generating: the model would be asked to write code for a
  // step nobody watched, and `refuseReason` would answer "the recorded run
  // performed no page actions" and write an `ai: true` entry claiming the step
  // cannot be code — a claim this compile never tested, and one a later compile
  // then leaves alone forever.
  //
  // Dropped from the selection and reported not attempted, exactly as a step
  // past the end of a stopped recording is. It does NOT end the prefix
  // (`usablePrefix` steps over it), so the steps after the returned flow — the
  // ones that did run — still compile.
  //
  // A step that FAILED and was TOLERATED is the same case with the opposite
  // history (stories/step-failure-outcomes.md, decision 11): it ran, and left a
  // transcript of the failure, so it is no evidence either and is dropped on the
  // same terms — `usablePrefix` steps over it, so the steps AFTER it compile.
  const skippedInRecording = selection.order.filter(
    (s) => record.steps[s.index]?.status === 'skipped',
  );
  const toleratedInRecording = selection.order.filter((s) => toleratedFailure(record.steps[s.index]));
  const noEvidence = new Set([...skippedInRecording, ...toleratedInRecording]);
  if (noEvidence.size > 0) {
    for (const step of skippedInRecording) {
      stepEvent('select', step, notRunOnRecordingReason(record.steps[step.index]));
    }
    for (const step of toleratedInRecording) {
      stepEvent('select', step, TOLERATED_FAILURE_REFUSAL);
    }
    notAttempted = [
      ...new Set([...notAttempted, ...[...noEvidence].map((s) => s.number)]),
    ].sort((a, b) => a - b);
    const attemptable = selection.order.filter((s) => !noEvidence.has(s));
    if (attemptable.length === 0) {
      // Every selected step was behind the return, or failed and was tolerated:
      // nothing to generate, and `partial` rather than `green`, which would say
      // "already compiled" about work that has not started.
      //
      // A clause per cause, each over ITS OWN steps, because the two are opposite
      // facts: a step behind a return never ran, a tolerated one ran and failed.
      // Told in one list, an author sent to "run the test so they execute" over a
      // step that DID execute looks for the wrong thing.
      const toleratedNumbers = toleratedInRecording.map((s) => s.number);
      // Everything else in `notAttempted`: the skipped rows, plus the post-prefix
      // steps of a recording that stopped — neither ran, so one sentence covers
      // both.
      const didNotRun = notAttempted.filter((n) => !toleratedNumbers.includes(n));
      const cause = [
        didNotRun.length > 0
          ? `${listSteps(didNotRun)} did not run on the recording run` +
            `${stoppedAt || endedAsWritten ? '' : describeRecordingSkips(skippedInRecording.map((s) => record.steps[s.index]))}`
          : '',
        toleratedNumbers.length > 0
          ? `${listSteps(toleratedNumbers)} failed on the recording run and was tolerated ` +
            '(otherwise continue)'
          : '',
      ]
        .filter((c) => c !== '')
        .join(', and ');
      const next =
        didNotRun.length > 0
          ? 'Run the test so they execute, then compile again.'
          : 'Make it pass, then compile again.';
      return finish(
        'partial',
        {
          compiled: 0,
          kept: keptExisting,
          keptAi: keptAiExisting,
          written: [],
          notAttempted,
          ...(stoppedAt && { stoppedAt }),
        },
        // The clause names the cause only when every skipped row agrees on
        // one, because the message asserts it as fact. A chain's untaken half
        // reaches here too, and "a return ended the flow before them" over it
        // is simply false — no return happened.
        //
        // And only when the recording did not STOP: `notAttempted` was already
        // populated above with the post-prefix steps of a stopped recording,
        // which no skipped row says anything about, so a clause derived from
        // `skippedInRecording` would be asserted over steps that were not
        // attempted for an entirely different reason. Those runs carry
        // `stoppedAt` in the summary, and the `record` phase line above has
        // already said "stopped at step N — <error>".
        `Nothing to compile: ${cause}. ${next}`,
      );
    }
    selection = {
      keys: new Set(attemptable.map((s) => s.key!)),
      order: attemptable,
      errors: [],
    };
    keptExisting = keptExistingFor(selection);
  }

  // ─── 3. Generate ──────────────────────────────────────────────────────────
  emit({ kind: 'phase', phase: 'generate', message: `${selection.order.length} step(s)` });
  // Asked of the WHOLE recording, once: the exact reference rule can only read
  // what the model named, and a recording made before the model was asked to
  // name placeholders carries values everywhere — a secret's already redacted
  // to `***` — so every reference would look unaccounted
  // (stories/placeholder-preserving-actions.md, decision 6).
  const recordingCarriesPlaceholders = record.steps.some((s) =>
    anyActionCarriesPlaceholder(actionsOf(s)),
  );
  /** The pre-change notice is worth saying once, and only when it changed an
   *  answer — a test that references nothing is unaffected by the rule. */
  let saidPreChange = false;
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
      recordingCarriesPlaceholders,
      // What `${data.url}` and kin resolved to, so the generator can say
      // "read it with step.getVar('data.url')" and the guard can catch the
      // value inlined (stories/codebehind-env-data.md).
      ...(test.envData && { envData: test.envData }),
      aiClient: options.aiClient,
      contextContent: options.contextContent,
      testName: test.title,
      ...(test.config.baseUrl !== undefined && { baseUrl: test.config.baseUrl }),
      ...(options.signal && { signal: options.signal }),
      wholeTest: wholeTestFor(steps, selection.keys, step),
      candidateFile: (await candidate.read(step.binding!.file)) ?? undefined,
      ...contextOf(result),
    });
    const applied = await applyGenerated(candidate, step, generated, stepEvent, 'generate');
    if (applied.kind === 'entry' && applied.references) {
      for (const name of applied.references.recoveredByValue) {
        recoveredByValue.push({ step: step.number, name });
        emit({ kind: 'note', level: 'warn', message: `step ${step.number}: ${valueMatchWarning(name)}` });
      }
      if (applied.references.preChangeFallback && !saidPreChange) {
        saidPreChange = true;
        emit({
          kind: 'note',
          level: 'info',
          message:
            'this recording predates placeholder-preserving actions — no action names a ' +
            'placeholder, so the compile identified values by string match. Re-record the test ' +
            'to compile under the exact rule.',
        });
      }
    }
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
  await reviewCandidate(
    candidate,
    {
      markdownName: path.basename(test.filePath),
      // The authored text, not the interpolated: it is what every `source` in
      // the file has to match, and the interpolated text would put resolved
      // `${env.X}` values in front of a reviewer that has no business seeing
      // them.
      steps: test.expansion?.rawSteps ?? test.steps,
      guarded: [...allParameters(parameters), ...allEnvRefs(test)],
      aiClient: options.aiClient,
      ...(options.signal && { signal: options.signal }),
    },
    (message) => emit({ kind: 'phase', phase: 'review', message }),
  );
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
  /**
   * Selected steps the LAST replay never reached, because a return earlier in
   * the run ended their flow (stories/step-flow-control.md, decision 12).
   *
   * Neither proven nor failed: the round said nothing about them. Recomputed
   * per round rather than accumulated, because the round that decides is the
   * last one — a repair that changes which branch an earlier return takes
   * changes which steps the next round reaches.
   */
  let unreached: Array<{ step: number; reason: string }> = [];
  /**
   * Selected steps the LAST replay ran, failed, and TOLERATED
   * (stories/step-failure-outcomes.md, decision 11).
   *
   * Neither proven nor failed, and the second half is the load-bearing one: the
   * entry did not do what the step says, so it cannot be proven, but the run
   * carried on exactly as the author asked, so no repair round is owed. What it
   * costs the compile is `green` — the entry is proposed, unproven, and named.
   *
   * Recomputed per round beside `unreached`: the round that decides is the last.
   */
  let toleratedInReplay: Array<{ step: number; reason: string }> = [];
  /**
   * Where the LAST replay ended because a step's own text said to — a
   * deliberate failure at a step the RECORDING failed deliberately at too
   * (stories/step-failure-outcomes.md, decisions 1–3 and 10).
   *
   * Both halves are the rule: the entry reproduced the recording's outcome
   * exactly, which is all a proving replay is asked to do, so the round is as
   * complete as a passing one and the step is PROVEN. A deliberate failure where
   * the recording had none means the condition flipped between the two runs, and
   * stays an ordinary replay failure.
   */
  let endedInReplay: { step: number } | undefined;
  /** The recording's rows, for the comparison above. A const because
   *  `markRound` is a closure and `record` is a `let`. */
  const recordedSteps = record.steps;
  const stepsInS = (): CompileStep[] => steps.filter((s) => s.key && selection.keys.has(s.key));
  const markRound = (outcome: CompileRunOutcome): void => {
    unreached = [];
    toleratedInReplay = [];
    endedInReplay = undefined;
    const endedAt = outcome.steps.findIndex(
      (s, i) => deliberateFailure(s) && deliberateFailure(recordedSteps[i]),
    );
    if (endedAt >= 0) endedInReplay = { step: endedAt + 1 };
    for (const step of stepsInS()) {
      const result = outcome.steps[step.index];
      if (result?.status === 'passed') proven.add(step.key!);
      // The entry failed the run in the author's words where the recording's AI
      // turn did the same: the entry working, not breaking.
      if (deliberateFailure(result) && deliberateFailure(recordedSteps[step.index])) {
        proven.add(step.key!);
      }
      if (toleratedFailure(result)) {
        toleratedInReplay.push({
          step: step.number,
          // The step's own error, so the compile's summary and the run's
          // report say the same thing about the same step.
          reason: result?.error?.trim() || 'the step failed and the run continued',
        });
      }
      if (result?.status === 'skipped') {
        unreached.push({
          step: step.number,
          // The runner's own sentence — `Not run: step 3 returned from "Sign
          // in"` — so the compile's summary and the run's report say the same
          // thing about the same step.
          reason: result.aiExplanation?.trim() || 'a return ended its flow',
        });
      }
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
    // `!tolerated`: a tolerated failure carries `status: 'failed'` and the run
    // went past it (stories/step-failure-outcomes.md, decision 6), so taking it
    // as THE failure would repair — and eventually write off as `ai: true` — a
    // step whose own text says it may fail. And not a DELIBERATE failure the
    // recording made too (decisions 1–3): repairing that would ask the model to
    // stop a step from failing when failing is what its text says to do, and the
    // write-off after `maxRounds` would bury the author's own line.
    const failedAt = outcome.steps.findIndex(
      (s, i) =>
        s?.status === 'failed'
        && !s.tolerated
        && !(deliberateFailure(s) && deliberateFailure(recordedSteps[i])),
    );
    const result = failedAt >= 0 ? outcome.steps[failedAt] : undefined;
    return {
      step: failedAt >= 0 ? steps[failedAt] : undefined,
      result,
      error: result?.error ?? outcome.error ?? 'the run failed without naming a step',
    };
  };
  const writeOff = async (step: CompileStep, error: string, after: string): Promise<void> => {
    stepEvent('replay', step, `kept as AI ${after}: ${error}`);
    await candidate.apply(step, aiEntryFor(step.text, `replay kept failing — ${error}`));
    await candidate.persist();
    proven.delete(step.key!);
    declined++;
    writtenOffAi.push(step.number);
  };

  for (let round = 1; round <= maxRounds; round++) {
    const outcome = await replay(round);
    const failed = failureOf(outcome);
    // The run is red and nothing broke: a step failed the run in the author's
    // words, exactly where the recording did (stories/step-failure-outcomes.md,
    // decisions 1–3). `outcome.status` cannot say that, so the round's
    // completeness is read off the rows instead.
    const endedAsAsked = endedInReplay !== undefined && failed.result === undefined;
    if (outcome.status === 'passed' || endedAsAsked) {
      emit({
        kind: 'phase',
        phase: 'replay',
        round,
        // A run that returned executed fewer steps than it has, and saying
        // "N/N passed as code" for it would count entries nothing ran. A
        // tolerated failure is the other way round — the entry ran and did not
        // work (decision 11) — and a run that ended as written is a third shape:
        // every step ran and the last failed on purpose, so "passed as code" is
        // the one word that cannot be used.
        message:
          describeReplayGaps(unreached, toleratedInReplay)
          ?? (endedAsAsked
            ? `${replayTotal}/${replayTotal} replayed as code — ` +
              `${endedAsWrittenReason('run', endedInReplay!.step)}`
            : `${replayTotal}/${replayTotal} passed as code`),
      });
      green = true;
      break;
    }

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
      test.envData ? envDataSecretValues(test.envData) : [],
    );
    if (round === maxRounds) break;

    stepEvent('repair', failed.step, 'regenerating from the failure');
    const repaired = await repairStep(failed.step, failed.error, failed.result, record, options, candidate, {
      number: round,
      max: maxRounds,
    });
    proven.delete(failed.step.key);
    const applied = await applyGenerated(candidate, failed.step, repaired, stepEvent, 'repair');
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
    const failed = failureOf(outcome);
    // The same two ways a round can be complete as the loop above: a test can
    // hold both a written-off step and a step whose text ends the run.
    const endedAsAsked = endedInReplay !== undefined && failed.result === undefined;
    green = outcome.status === 'passed' || endedAsAsked;
    if (green) {
      const gaps = describeReplayGaps(unreached, toleratedInReplay);
      emit({
        kind: 'phase',
        phase: 'replay',
        round: rounds,
        // Same honesty as the first round's line: the confirming round can also
        // leave steps unreached or tolerated, and "N/N passed" over either is a
        // claim nothing made.
        message: gaps
          ? `${gaps}; step ${step.number} under AI`
          : endedAsAsked
            ? `${replayTotal}/${replayTotal} replayed as code — ` +
              `${endedAsWrittenReason('run', endedInReplay!.step)} (step ${step.number} under AI)`
            : `${replayTotal}/${replayTotal} passed (step ${step.number} under AI)`,
      });
    } else {
      // The confirming round failed somewhere else. No further rounds — the
      // budget is spent — but the step it failed on gets the same answer the
      // first one did, and everything proven stays proven.
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
  // A replay that returned proved only the steps it reached
  // (stories/step-flow-control.md, decision 12). Those entries are still
  // proposed — they are unproven, which the next run settles — but the compile
  // must not read as green, and it has to say which steps and why.
  if (unreached.length > 0 && failure === undefined) {
    failure =
      `the replay never reached ${listSteps(unreached.map((u) => u.step))} — ` +
      `${unreached[0]!.reason}; those entries are proposed but unproven`;
  }
  // The same accounting for a step the replay TOLERATED (decision 11): the entry
  // ran and did not do what the step says, so nothing proved it — but the run is
  // not failed by it, so this is a `partial` with a name in it.
  if (toleratedInReplay.length > 0 && failure === undefined) {
    failure =
      `the replay's ${listSteps(toleratedInReplay.map((t) => t.step))} failed and was tolerated ` +
      `(otherwise continue) — ${toleratedInReplay[0]!.reason}; ` +
      'that entry is proposed but unproven';
  }
  // The recording ended where the test says it ends, and the steps past that
  // point are still to compile (decisions 1–3). Said in the summary's own words
  // because on the CLI this is the `Reason:` line, the only place a partial
  // compile explains itself.
  if (endedAsWritten !== undefined && failure === undefined) {
    failure =
      `${endedAsWrittenReason('run', endedAsWritten.step)} (${clipLine(endedAsWritten.line)})` +
      (notAttempted.length > 0 ? `; not attempted: ${listSteps(notAttempted)}` : '');
  }
  // Green means the whole test replayed as code. A prefix compile that went
  // green only proved the prefix; the rest of the test is still to do — and so
  // does a compile that left steps unattempted because the recording never ran
  // them, whether a return ended their flow or a decision took another branch.
  // That is a `notAttempted` with no `stoppedAt` behind it
  // (stories/step-flow-control.md, decision 12).
  //
  // A recording that ended AS WRITTEN is the same arithmetic for a different
  // reason: nothing is broken, but the steps after the ending step never ran, so
  // the test does not replay as code end to end. When the ending step is the LAST
  // one there is no gap, `endedAsWritten` is never set, and green is honest.
  const status: CompileStatus =
    green
    && !stoppedAt
    && endedAsWritten === undefined
    && unreached.length === 0
    && toleratedInReplay.length === 0
    && notAttempted.length === 0
      ? 'green'
      : 'partial';
  const keptAi = keptAiExisting + declined;
  /** Why the recording did not attempt them, when every skipped row agrees on
   *  one cause. Undefined when they disagree, which is what keeps the headline
   *  from picking a winner among rows it would then be wrong about. */
  //
  // A tolerated failure is a THIRD cause and a run that ended as written a FOURTH
  // (decisions 1–3 and 11), each asserted only when it is the only one present: a
  // mixed set gets no clause, the rule `recordingSkipCause` already applies to
  // its own producers, because the sentence states its cause as fact.
  const causesPresent = [
    endedAsWritten !== undefined,
    toleratedInRecording.length > 0,
    skippedInRecording.length > 0,
  ].filter(Boolean).length;
  const notAttemptedCause =
    causesPresent !== 1
      ? undefined
      : endedAsWritten !== undefined
        ? endedAsWrittenReason('run', endedAsWritten.step)
        : toleratedInRecording.length > 0
          ? 'they failed on the recording run and were tolerated'
          : recordingSkipCause(skippedInRecording.map((s) => record.steps[s.index]));
  const tail = [
    writtenOffAi.length > 0 ? `${writtenOffAi.length} kept AI after replay failures` : '',
    unproven.length > 0 ? `${unproven.length} unproven (${listSteps(unproven)})` : '',
    unreached.length > 0
      ? `${listSteps(unreached.map((u) => u.step))} not reached by the replay ` +
        `(${unreached[0]!.reason})`
      : '',
    toleratedInReplay.length > 0
      ? `${listSteps(toleratedInReplay.map((t) => t.step))} failed and was tolerated by the replay ` +
        `(${toleratedInReplay[0]!.reason})`
      : '',
    // A stopped recording already says "stopped at step N" below, and the CLI
    // prints the list either way; this is the case with no stop behind it,
    // which is exactly when `notAttempted` holds the recording's skipped rows
    // and nothing else. The cause is READ OFF those rows rather than asserted:
    // the ordinary chain compile reaches here with no return anywhere in the
    // run, and "a return skipped them" over it is simply false — the same
    // correction `notRunOnRecordingReason` and the "Nothing to compile"
    // refusal already carry (stories/step-flow-control.md, decision 12).
    notAttempted.length > 0 && !stoppedAt
      ? `${listSteps(notAttempted)} not attempted on the recording run` +
        (notAttemptedCause === undefined ? '' : ` (${notAttemptedCause})`)
      : '',
    // The compliance signal, in front of whoever ran the compile rather than
    // only in the summary object (stories/placeholder-preserving-actions.md §6).
    recoveredByValue.length > 0
      ? `${recoveredByValue.length} recovered by value match`
      : '',
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
    // The fact, not only its wording: `error` and the per-step `select` lines are
    // all the CLI needs, but the field is what a CLIENT reads. Set here so the
    // two compilers hand back the same shape for the same recording.
    ...(endedAsWritten && { endedAsWritten }),
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

/**
 * How many leading steps of a run the compile can work from — the recording's
 * usable prefix.
 *
 * A `skipped` step is NEUTRAL here, not the end of the prefix
 * (stories/step-flow-control.md, decision 12). A return ended its flow, which
 * says nothing about the steps after that flow: those ran, under AI, and their
 * transcripts are as good as any other step's. Ending the prefix at the first
 * skipped step would throw all of them away because an earlier section
 * returned. Only a failure, an error, or a step with no result at all — a run
 * that stopped — ends it.
 *
 * A TOLERATED failure is neutral for the same reason
 * (stories/step-failure-outcomes.md, decision 11): the run carried on past it, so
 * the steps after it ran in a browser that kept going and their transcripts are
 * as usable as any other's. Ending the prefix there would throw away the rest of
 * the test over a failure the author declared harmless.
 *
 * A DELIBERATE failure is the third case, and the only one that ends the prefix
 * AFTER itself rather than before it (decisions 1–3): the step did exactly what
 * its text says, so its transcript is evidence and it belongs INSIDE the prefix,
 * while nothing after it ran.
 *
 * The skipped and tolerated steps themselves are dropped from the selection
 * separately, with a reason: inside the prefix, but no evidence. The deliberate
 * one is not dropped — it compiles.
 */
function usablePrefix(steps: (StepResult | undefined)[]): number {
  let n = 0;
  for (const step of steps) {
    if (step?.status !== 'passed' && step?.status !== 'skipped' && !toleratedFailure(step)) {
      if (deliberateFailure(step)) n++;
      break;
    }
    n++;
  }
  return n;
}

/**
 * A failure the step's own text asked for — `If … then fail the test with error
 * "…"`, judged true on this run (stories/step-failure-outcomes.md, decisions
 * 1–3). `status` is a plain `'failed'`, so the flag is what separates "the run
 * ended where the test says it ends" from "something broke", and the compile has
 * to ask or it reports a step that worked as one the author must go and fix.
 */
function deliberateFailure(result: StepResult | undefined): boolean {
  return result?.status === 'failed' && result.deliberate === true;
}

/**
 * A failure the step's own `otherwise continue` tail let the run past
 * (stories/step-failure-outcomes.md, decision 6). `status` is a plain `'failed'`
 * — nothing that did not do its work is painted green — so every site meaning
 * "a failure the compile must stop at" has to ask for the flag too, or a run the
 * author declared survivable reads here as a run that died.
 */
function toleratedFailure(result: StepResult | undefined): boolean {
  return result?.status === 'failed' && result.tolerated === true;
}

/**
 * Why a step the recording skipped was not attempted
 * (stories/step-flow-control.md, decision 12).
 *
 * TWO producers write a `skipped` row and they were not skipped for the same
 * reason, so neither may be described in the other's words. Both already say
 * their own cause in a sentence with a known prefix, and both are read off
 * that sentence rather than recomputed from the expansion — which the compile
 * would have to walk again and could disagree with:
 *
 *  - `Not run: step 3 returned from "Sign in"` — a return
 *    (`skippedByReturnReason`, src/runner/flow-control.ts);
 *  - `Skipped: another branch of this decision was taken`, `Skipped: the loop
 *    ran no passes` — a decision (`skipReasonFor`,
 *    src/runner/control-runtime.ts). A chain COMPILES (only loops are refused),
 *    so this is reachable on the shape control flow is mostly about, and it
 *    used to read "a return ended its flow" when no return had happened.
 *
 * Both prefixes are anchored, so only those sentences are read; a result
 * skipped for some future reason falls back to a phrasing that asserts no
 * cause at all rather than quoting one out of unrelated prose.
 */
export function notRunOnRecordingReason(result: StepResult | undefined): string {
  const explanation = result?.aiExplanation ?? '';
  const at = /^Not run: step (\d+)\b/.exec(explanation)?.[1];
  if (at !== undefined) return `not run on the recording run (step ${at} returned)`;
  const decided = /^Skipped:\s*(\S.*)$/.exec(explanation)?.[1];
  if (decided !== undefined) return `not run on the recording run (${decided})`;
  return 'not run on the recording run';
}

/** Was this skipped row a `return`'s doing, rather than a decision's? Reads
 *  the one formatter's prefix, exactly as {@link notRunOnRecordingReason}. */
function skippedByAReturn(result: StepResult | undefined): boolean {
  return /^Not run: step \d+\b/.test(result?.aiExplanation ?? '');
}

/**
 * The one clause that describes a whole set of skipped rows, or nothing.
 *
 * Said only when every row agrees, because the sentence it joins asserts it as
 * fact. A mixed set — a decision skipped some, a return skipped the rest —
 * gets no clause: the per-step `select` lines above have already named each
 * one individually, and a summary that picks a winner would be wrong about the
 * others.
 */
function describeRecordingSkips(results: (StepResult | undefined)[]): string {
  const cause = recordingSkipCause(results);
  return cause === undefined ? '' : ` — ${cause}`;
}

/**
 * The cause clause on its own, for the message that parenthesises it rather
 * than joining it with a dash.
 *
 * Same rule, one implementation: the end-of-compile headline used to assert
 * "a return skipped them on the recording run" unconditionally, which is false
 * of the ordinary chain compile — an untaken branch is dropped from the
 * selection and everything around it still compiles, so `notAttempted` is
 * non-empty with no return anywhere in the run.
 */
function recordingSkipCause(results: (StepResult | undefined)[]): string | undefined {
  if (results.length === 0) return undefined;
  if (results.every((r) => skippedByAReturn(r))) return 'a return ended the flow before them';
  if (results.every((r) => !skippedByAReturn(r))) return 'the run decided against them';
  return undefined;
}

/**
 * What a replay round did NOT prove, as one clause, or null when it proved
 * everything it ran.
 *
 * Two producers with opposite histories — a step the run never reached, and one
 * it ran and tolerated (stories/step-flow-control.md decision 12;
 * stories/step-failure-outcomes.md decision 11) — both sayable in one line,
 * because a round can do both and "N/N passed as code" would be false twice over.
 */
function describeReplayGaps(
  unreached: Array<{ step: number; reason: string }>,
  tolerated: Array<{ step: number; reason: string }>,
): string | null {
  const clauses = [
    unreached.length > 0
      ? `${listSteps(unreached.map((u) => u.step))} not reached (${unreached[0]!.reason})`
      : '',
    tolerated.length > 0
      ? `${listSteps(tolerated.map((t) => t.step))} failed and was tolerated ` +
        `(${tolerated[0]!.reason})`
      : '',
  ].filter((c) => c !== '');
  return clauses.length === 0 ? null : `replayed as code — ${clauses.join(', ')}`;
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

/**
 * The first `While` / `Repeat … until` / `For each` guard line in the test, or
 * undefined when it has none (stories/control-flow.md, decision 12).
 *
 * Reads the expansion's control records rather than re-parsing: a loop can be
 * written inside a section body or a skill, and only the expander knows the
 * flat list those became.
 */
function firstLoopGuard(test: ParsedTest): string | undefined {
  const controls = test.expansion?.controls ?? [];
  for (let i = 0; i < controls.length; i++) {
    const record = controls[i];
    if (!record) continue;
    if (record.kind === 'while' || record.kind === 'repeat' || record.kind === 'foreach') {
      return test.expansion?.rawSteps[i] ?? test.steps[i] ?? record.label;
    }
  }
  return undefined;
}

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

  const controls = test.expansion?.controls ?? [];

  return test.steps.map((step, i) => {
    const binding = registry?.bindingFor(i);
    const text = binding?.source ?? test.expansion?.rawSteps[i] ?? step;
    const isAiEntry = binding?.entry?.ai === true;
    // The UNCONDITIONAL `Return` / `Stop` / `Fail` only (`body === undefined`).
    // The conditional form compiles — `if (…) step.exit()`, or `if (…)
    // step.fail('…')` for the `fail` verb (stories/step-failure-outcomes.md,
    // decision 10) — while the unconditional one is dispatched by the loop with
    // no model call, exactly as `Set` is, so there is nothing to record
    // (stories/step-flow-control.md, decisions 3 and 11).
    //
    // `If <condition>, then return` is a flow-control step and NOT a control
    // line, so `controls[i]` is null on it and it takes the conditional branch
    // above: the compiler writes it, rather than refusing it as a guard
    // (stories/control-flow.md §"Composition with `If … then return`").
    const flowControl = parseFlowControlStep(text);
    const ineligible = controls[i]
      ? // The guard is dispatched by the framework — it asks a model a
        // question and performs nothing — so there is no transcript to
        // generate from and nothing for an entry to replace. Its TAIL is an
        // ordinary step and compiles normally (stories/control-flow.md,
        // decision 12).
        'a control line is dispatched, not compiled'
      : test.toolCalls[i]
      ? 'a [tool:] step is dispatched, not compiled'
      // `text` can be a RAW authored line still carrying a `[no-hooks]`
      // prefix (`rawSteps` keeps it). No strip needed: `parseSetStep`
      // normalises the marker itself, and does it better than a strip here
      // could — `NO_HOOKS_MARKER` is `^`-anchored with no leading `\s*`, so
      // it would miss an indented line that `normalise` handles. This used to
      // strip first, with a comment claiming the check would otherwise miss
      // such a step; that stopped being true when the marker moved into the
      // parser, and the line survived as dead code defended by a false
      // rationale.
      : parseSetStep(text)
      ? 'a Set step is dispatched, not compiled'
      // A `[use computer]` / `[use browser]` line, on the same terms as `Set`
      // and the unconditional flow-control step: the loop dispatches it with
      // no model call, so there is nothing recorded for an entry to replace
      // (SPEC-use-computer.md §9). `parseUseStep` normalises the `[no-hooks]`
      // marker itself, which matters here because `text` can be a RAW authored
      // line still carrying one — the same reason `parseSetStep` is asked the
      // raw text a line above.
      : parseUseStep(text)
      ? SURFACE_SWITCH_NOT_COMPILED
      : flowControl && flowControl.body === undefined
      ? DISPATCHED_NOT_COMPILED
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

// ───────────────────────────────────────────────────────────────────────────
// Generation plumbing
// ───────────────────────────────────────────────────────────────────────────

async function repairStep(
  step: CompileStep,
  error: string,
  failedResult: StepResult | undefined,
  record: CompileRunOutcome,
  options: CompileOptions,
  candidate: Candidate,
  round: { number: number; max: number },
): Promise<GeneratedEntry> {
  const parameters = stepParameters(step.binding!, record.resolvedParameters, options.test.envData);
  // The step passed Generate, so every reference it makes resolved there;
  // the repair sees the same list, and the same guard.
  const envRefs = stepEnvRefs(step.binding!, options.test.envData).resolved;
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
    ...(envRefs.length > 0 && { envRefs }),
    round,
  });
  return askForEntry(
    options.aiClient,
    options.contextContent,
    prompt,
    // The authored line, exactly as generation passes it: a value the author
    // QUOTED in the step is the author's, so an entry echoing it is repeating the
    // step rather than inlining a resolved value (`guardedValues` /
    // `authorQuotedLiterals`, generate.ts). Without it, `If {{a}} is "peanuts"
    // then fail …` with `{{a}}` = `peanuts` cannot be repaired at all — every
    // candidate contains `peanuts`, so each was discarded as a leak and the step
    // was written off `ai: true` after `maxRounds`
    // (stories/step-failure-outcomes.md, decisions 3 and 10).
    guardedValues(parameters, envRefs, step.text),
    options.signal,
  );
}

/** Every parameter value in play, for the review's leak guard. Unlike the
 *  per-step guard this is deliberately broad: a whole-file rewrite can move a
 *  literal into any entry, so the check has to cover them all. The RESOLVED
 *  values: a guard that looked for `$GITHUB_PASSWORD` would wave the real
 *  password through. */
function allParameters(parameters: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(parameters).map(([name, value]) => ({ name, value }));
}

/** Every environment value the test's steps reference, for the same guard:
 *  `${env.GITHUB_PASSWORD}` resolved is as much a secret as `{{password}}`,
 *  and `${data.url}` resolved is a file that runs in one environment only. */
function allEnvRefs(test: ParsedTest): Array<{ name: string; value: string }> {
  if (!test.envData) return [];
  const out: Array<{ name: string; value: string }> = [];
  const seen = new Set<string>();
  for (const text of test.expansion?.rawSteps ?? test.steps) {
    for (const ref of envDataRefsIn(text)) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      const value = resolveEnvDataRef(ref, test.envData);
      if (value !== undefined) out.push({ name: `\${${ref}}`, value });
    }
  }
  return out;
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
      // Through the `$VAR` rule, as the runner resolves it — a cell that
      // resolved one way at compile and another at run would generate code
      // against a value the run never sees.
      const cell = dataRow[key]!;
      if (cell.startsWith('$')) {
        const fromEnv = env[cell.slice(1)];
        if (fromEnv !== undefined) {
          values[key] = fromEnv;
          continue;
        }
        unresolved.push(key);
      }
      values[key] = cell;
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
  // An inline table under `## Steps` needs no project root — it was parsed
  // out of the file itself. Checked first, and the parser refuses a file that
  // has both, so the order only decides which branch runs, never which wins.
  if (test.dataRows) {
    const inline = test.dataRows[0];
    return inline ? { row: inline, of: test.dataRows.length } : undefined;
  }
  const dataFile = test.frontmatter.dataFile;
  if (!dataFile) return undefined;
  const rows = await loadDataFile(dataFile, projectRoot);
  const row = rows[0];
  return row ? { row, of: rows.length } : undefined;
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
        // Always, the way src/server/compile-runner.ts always sets it on its
        // own runner. A compile is a request FOR AI (stories/run-settings.md
        // §9), so `ai.allowInRuns: false` must not gate it — otherwise `aiui
        // compile` refuses every step and writes nothing on precisely the
        // projects that turned the switch off so they would have compiled
        // steps to replay.
        bypassAiPolicy: true,
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
    ...(report.error !== undefined && { error: report.error }),
    steps,
    resolvedParameters: report.parameters ?? {},
    tokensUsed: report.tokensUsed,
  };
}

import path from 'node:path';
import type { AiClient } from '../ai/client.js';
import type { Config } from '../config/types.js';
import type { ParsedTest } from '../parser/types.js';
import type { StepResult, TestReport } from '../report/types.js';
import type { TokenTracker } from '../utils/tokens.js';
import { parseSetStep } from '../parser/set-step.js';
import { parseFlowControlStep } from '../parser/flow-control-step.js';
import { parseUseAiStep, parseUseStep } from '../parser/use-step.js';
import {
  chainMembers,
  innermostLoopGuard,
  isChainRecord,
  type ControlRecord,
} from '../runner/control-flow.js';
import { buildCodeBehindRegistry, type CodeBehindBinding } from './loader.js';
import {
  aiEntryFor,
  anyActionCarriesPlaceholder,
  askWithCaptureRetry,
  capturedValueGuards,
  compilePromptSecrets,
  compilableCondition,
  generateConditionEntry,
  generateStepEntry,
  guardedValues,
  loopContextFor,
  pickConditionObservations,
  recordedCapturesOf,
  refuseReason,
  stepEnvRefs,
  stepParameters,
  unresolvedRefsReason,
  SET_STEP_NOT_COMPILED,
  SURFACE_SWITCH_NOT_COMPILED,
  USE_AI_NOT_COMPILED,
  valueMatchWarning,
  type ConditionObservation,
  type GeneratedEntry,
} from './generate.js';
import { maskValueForPrompt, type LoopContext } from '../ai/prompts.js';
import { buildRepairPrompt, type RepairPromptInput } from './repair.js';
import { reviewCandidate } from './review.js';
// The two refusals both compilers say; they live beside `generationRefusal`.
// Safe in this direction because live-compile.ts's only reference back here is
// an `import type` (stories/step-failure-outcomes.md, decisions 10 and 11).
import {
  clipLine,
  DISPATCHED_NOT_COMPILED,
  endedAsWrittenReason,
  COMPUTER_MODE_STAYS_AI,
  hasEntryOfKind,
  TOLERATED_FAILURE_REFUSAL,
} from './live-compile.js';
import { clearStale, readLastRun } from './last-run.js';
import { entryTextIn, writeCodeBehindFile } from './writer.js';
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
import { bindVariable, clearDottedKeys, loadDataFile, placeholderRoot } from '../parser/parameters.js';
import { evidenceRows, recordingDirFor, writeReplayFailure } from './recording.js';
import {
  inheritLoopBindings,
  isSecretParameterName,
  markLoopBindings,
  MASK,
  redact,
  redactMap,
  runSecrets,
} from '../utils/secrets.js';

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
  /**
   * What the last replay's pass-count check noticed and the compile does not
   * own (stories/codebehind-loops-and-conditions.md, decision 11): a runtime
   * loop that ran a different number of passes from the recording's — or a
   * `For each` that ran as many over a different list — where no entry this
   * compile wrote is to blame. One sentence each, naming the loop and both
   * counts. Said, never failed on: absent when there is nothing to say.
   */
  warnings?: string[] | undefined;
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
  /**
   * The EVIDENCE row per expanded step, indexed by `step.index - 1`: the first
   * pass that passed, else the first row of all (`evidenceRows`, the row the
   * recording on disk keeps too — stories/codebehind-loops-and-conditions.md,
   * decisions 1 and 14). A step outside every runtime loop has one row and
   * this is it. Sparse when a run bailed early.
   */
  steps: (StepResult | undefined)[];
  /**
   * EVERY row per expanded step, in execution order — a `While` body index
   * holds one row per pass, a guard one per visit (decision 3). What a replay
   * is proven by, and what a Record's prefix is judged by. Absent on an
   * outcome built by hand, which then means one row per index: `steps`.
   * {@link outcomeRows} builds this, `steps` and `rows` together.
   */
  passes?: StepResult[][] | undefined;
  /**
   * Every step row of the run, in execution order across indices — what the
   * replay's condition check walks visit by visit (decision 11), and what a
   * guard's observations are read off in order. Absent means `passes`,
   * flattened in index order.
   */
  rows?: StepResult[] | undefined;
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
  //
  // A file that LOOPS compiles like any other
  // (stories/codebehind-loops-and-conditions.md). A loop body re-runs the same
  // expanded indices, so the Record hands back several rows for one index:
  // the entry is generated from the first pass that passed (decision 1), and
  // the replay proves it on every pass (decision 3). A guard whose condition
  // the model decides — `If`, `Else if`, `While`, `Repeat … until` — is a
  // compile step of its own, generated from the pages the judge decided on
  // (decisions 4 and 9).
  const controls: readonly (ControlRecord | null)[] = test.expansion?.controls ?? [];
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
  for (const key of staleKeysIn(record, steps)) recordStale.add(key);
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
  //
  // Judged on EVERY row of an index, not its evidence row: a body step that
  // passed on pass 1 and failed on pass 2 is a step the recording broke at,
  // however good pass 1's transcript is.
  /** The Record's rows, per index and in execution order. A const because the
   *  replay's closures read it and `record` is a `let`. */
  const recorded = runRows(record);
  const recordedAt = (index: number): StepResult[] => recorded.passes[index] ?? [];
  const prefixEnd = usablePrefix(recorded.passes);
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
      prefixEnd > 0 && recordedAt(prefixEnd - 1).some(deliberateFailure) ? prefixEnd - 1 : -1;
    const error =
      endedIndex >= 0
        ? recordedAt(endedIndex).find(deliberateFailure)?.error ?? 'the step failed as its text says'
        : breakingRow(recordedAt(prefixEnd))?.error ??
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
  //
  // Per INDEX, across every pass (stories/codebehind-loops-and-conditions.md,
  // decision 3): a body step skipped on pass 1 by a return and run on pass 2
  // has evidence, and one skipped on every pass has none.
  //
  // A CONDITION line is judged differently: it has no transcript at all. Its
  // evidence is the pages the judge decided on, read off the Record's guard
  // rows (decision 9) — which exist only in memory, because the recording on
  // disk keeps a guard row's decision and never its page. A condition no visit
  // ever asked has nothing to generate from and is not attempted.
  const recordVisits = guardVisits(recorded.rows, controls);
  const snapshots = passSnapshots(recorded.rows, parameters, record.resolvedParameters, test.envData);
  /**
   * Secrets a run's REDACTED final map shows masked inside a starting value —
   * `cb: https://app.test/cb?t=***` where a later `[store as: api_token]`
   * captured `abcd1234` — recovered by {@link passSnapshots}. The snapshots
   * keep the real start value (the leak guard must hold real values), so the
   * prompts are handed these to mask it with, as the run's own were.
   */
  const recoveredSecrets = new Set<string>(snapshots.recovered);
  /**
   * The mask set a prompt built from `values` for one binding is masked with —
   * the run's (`runSecrets`), that binding's frame inputs (the run's own
   * `secretsNow` merges them: `[skill: api header="Bearer <key>"]`), and the
   * recovered secrets above.
   */
  const promptSecretsFor = (values: Record<string, string>, binding: CodeBehindBinding | undefined): string[] =>
    compilePromptSecrets(values, test.envData, binding ? [binding] : [], [...recoveredSecrets]);
  /** The same for the compile's own words — warnings, errors, write-off
   *  comments — over EVERY frame's inputs, as the run masks its report. */
  const summarySecrets = (values: Record<string, string>): string[] =>
    compilePromptSecrets(values, test.envData, steps.map((s) => s.binding), [...recoveredSecrets]);
  /** A run's error text, as the compile repeats it: masked with that set, as
   *  of the map the run started from. */
  const sayMasked = (text: string): string => redact(text, summarySecrets(snapshots.at(undefined)));
  /** The recording's loop entries and their passes, for the replay's
   *  pass-count check (decision 11). */
  const recordLoops = loopEntries(recorded.rows, controls);
  const observationsFor = (member: number): RecordedObservation[] =>
    observationsOf(recordVisits, member, snapshots);
  const stepKinds = selection.order.filter((s) => s.kind !== 'condition');
  const skippedInRecording = stepKinds.filter((s) => {
    const rows = recordedAt(s.index);
    return rows.length > 0 && rows.every((r) => r.status === 'skipped');
  });
  const toleratedInRecording = stepKinds.filter((s) => {
    const rows = recordedAt(s.index);
    return !rows.some((r) => r.status === 'passed') && rows.some((r) => toleratedFailure(r));
  });
  const neverAsked = selection.order.filter(
    (s) => s.kind === 'condition' && observationsFor(s.index).length === 0,
  );
  const noEvidence = new Set([...skippedInRecording, ...toleratedInRecording, ...neverAsked]);
  /** What the recording's skip cause is read off: each skipped step's first
   *  row, and a never-asked condition's own row — skipped too, by the same
   *  decision or return that skipped the structure it opens. */
  const skipCauseRows = [...skippedInRecording, ...neverAsked].map((s) => recordedAt(s.index)[0]);
  if (noEvidence.size > 0) {
    for (const step of skippedInRecording) {
      stepEvent('select', step, notRunOnRecordingReason(recordedAt(step.index)[0]));
    }
    for (const step of toleratedInRecording) {
      stepEvent('select', step, TOLERATED_FAILURE_REFUSAL);
    }
    for (const step of neverAsked) {
      stepEvent('select', step, neverAskedReason(recordedAt(step.index)));
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
            `${stoppedAt || endedAsWritten ? '' : describeRecordingSkips(skipCauseRows)}`
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
  const recordingCarriesPlaceholders = recorded.rows.some((s) =>
    anyActionCarriesPlaceholder(actionsOf(s)),
  );
  /** The pre-change notice is worth saying once, and only when it changed an
   *  answer — a test that references nothing is unaffected by the rule. */
  let saidPreChange = false;
  let declined = 0;
  /**
   * Condition lines whose entry in the candidate is `ai: true` — declined at
   * generation (judged with no DOM) or at a repair. The model decides them in
   * the replay, so no visit of theirs is decided by code; what proves them is
   * a visit that did not fail, as a declined step is proven by passing under AI.
   */
  const keptAiConditions = new Set<string>();
  /** Steps this compile wrote off as `ai: true` after a replay failure. */
  const writtenOffAi: number[] = [];
  /**
   * Condition lines whose generation came back as an error — most often the
   * read-only rule (`conditionEntryComplaint`) refusing both answers.
   *
   * NOT fatal to the compile, unlike a step's generation error. That rule is a
   * textual heuristic over generated code, and it has known false positives
   * (a `reduce` accumulator written inside `page.evaluate`, say); a heuristic
   * must not be able to fail a whole compile and write nothing. So the line gets
   * no entry this time — the model keeps deciding it — it leaves the selection,
   * so no replay round expects code from it, and the summary names it. Nothing
   * is written for it either, so the next compile tries again, where an
   * `ai: true` write-off would stop every later compile from retrying.
   */
  const conditionsNotCompiled: Array<{ number: number; message: string }> = [];
  /**
   * The runtime loop a line sits in the body of, as the prompts name it
   * (decision 2): its authored guard line, and a `For each`'s runtime item.
   * The live compiler's plan asks the same `innermostLoopGuard`.
   */
  const loopAt = (index: number): { line: string; runtimeItem?: string } | undefined => {
    const guard = innermostLoopGuard(controls, index);
    if (guard === undefined) return undefined;
    const loop = controls[guard];
    return {
      line: steps[guard]?.text ?? test.steps[guard] ?? '',
      ...(loop?.kind === 'foreach' && { runtimeItem: loop.item }),
    };
  };
  /** The same for a whole generation: the loop block, from the values of the
   *  pass whose evidence the prompt shows. */
  const loopContextAt = (index: number, passValues: Record<string, string>): LoopContext | undefined => {
    const loop = loopAt(index);
    return loop ? loopContextFor(loop.line, passValues, loop.runtimeItem) : undefined;
  };
  /** A condition line's generation — the first one, or a repair — from the
   *  Record's observations of it. */
  const askCondition = async (
    step: CompileStep,
    observations: RecordedObservation[],
    repair?: { entryCode: string; error: string },
  ): Promise<GeneratedEntry> => {
    // The visit whose values the prompt reads: the first one it is shown.
    const shown = pickConditionObservations(observations)[0] ?? observations[0];
    const values = shown?.parameters ?? snapshots.at(undefined);
    const loop = loopContextAt(step.index, values);
    return generateConditionEntry({
      binding: step.binding!,
      observations,
      resolvedParameters: values,
      // The fold's own snapshot, marks and all, and the run's mask set as of
      // it — so the prompt masks exactly what the run's own prompts did.
      parameterMap: values,
      secrets: promptSecretsFor(values, step.binding),
      ...(test.envData && { envData: test.envData }),
      aiClient: options.aiClient,
      contextContent: options.contextContent,
      testName: test.title,
      ...(test.config.baseUrl !== undefined && { baseUrl: test.config.baseUrl }),
      ...(options.signal && { signal: options.signal }),
      wholeTest: wholeTestFor(steps, selection.keys, step),
      candidateFile: (await candidate.read(step.binding!.file)) ?? undefined,
      ...(loop && { loop }),
      ...(repair && { repair }),
    });
  };
  for (const step of selection.order) {
    if (options.signal?.aborted) {
      return finish('failed', { compiled: 0, kept: keptExisting, keptAi: keptAiExisting, written: [], error: 'aborted' }, 'Compile aborted.');
    }

    // ── A condition line: its entry answers the question the judge answered
    // (decisions 4 and 9), from the first page it held on and the first it
    // did not. One judged without a DOM — the computer surface — is declined
    // by the generator itself, as `ai: true` with the reason (decision 10).
    if (step.kind === 'condition') {
      const applied = await applyGenerated(
        candidate,
        step,
        await askCondition(step, observationsFor(step.index)),
        stepEvent,
        'generate',
      );
      if (applied.kind === 'declined') {
        declined++;
        keptAiConditions.add(step.key!);
      }
      if (applied.kind === 'error') {
        // See `conditionsNotCompiled`: this line stays AI for now, and the
        // compile carries on with everything else.
        conditionsNotCompiled.push({ number: step.number, message: applied.message });
        stepEvent(
          'generate',
          step,
          `not compiled — ${applied.message}; the model keeps deciding this line, and the next compile tries again`,
        );
      }
      continue;
    }

    // The EVIDENCE row: the first pass that passed (decision 1).
    const result = record.steps[step.index];
    // …read with that pass's own values (decision 2). The run's final map
    // holds the LAST pass's `For each` item, which is not the item on the page
    // this transcript was recorded against.
    const passValues = snapshots.at(result);

    // ── A step that EXECUTED in computer mode stays AI (§9) ──────────────
    //
    // Judged from the RUN's recording rather than from the file, and that is
    // the whole reason it is here and not in `describeSteps`: a shared
    // `### Section` or a skill body runs on whatever surface its caller was
    // on, so the file cannot know. `ai: true` with the reason, and no model
    // call — generation would be asked to write a `page.mouse.click(812, 544)`
    // that means something else on the next machine.
    if (result?.surface === 'computer') {
      stepEvent('generate', step, COMPUTER_MODE_STAYS_AI);
      await candidate.apply(step, aiEntryFor(step.text, COMPUTER_MODE_STAYS_AI));
      await candidate.persist();
      declined++;
      continue;
    }

    const loop = loopContextAt(step.index, result?.loop?.values ?? passValues);
    // An evidence pass that HEALED — its entry threw and the step ran under AI,
    // which is how a stale step joins the selection — is repaired rather than
    // generated from scratch, as the live compiler does it: shown the entry
    // that broke, what it threw, and the page it threw on. Plain generation
    // hands the model the same page and lets it write the same broken selector
    // again. No entry text to repair from (the file was edited) falls through.
    const healed = result?.codeBehindStale
      ? await repairHealedStep(step, result, passValues, promptSecretsFor(passValues, step.binding), options, candidate, loop)
      : undefined;
    const generated = healed ?? await generateStepEntry({
      binding: step.binding!,
      actions: actionsOf(result),
      ...(result?.assertions && { assertions: result.assertions }),
      resolvedParameters: passValues,
      // The fold's snapshot is the map these values came out of, with the
      // loop marks each pass made (§7.6), and the mask set the run had then:
      // the prompt masks what the run's own prompts masked, a data file's
      // `user.apikey` heading and a secret inside a non-secret value included.
      parameterMap: passValues,
      // …with the step's frame inputs and anything the final map shows the
      // run masked inside a starting value.
      secrets: promptSecretsFor(passValues, step.binding),
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
      ...(loop && { loop }),
      // What the evidence pass captured: the result the entry must reproduce,
      // and a value the leak guard refuses to see written in.
      recordedCaptures: recordedCapturesOf(step.binding, result?.outputs),
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

  // A condition that got no entry leaves the selection: no replay round may
  // expect code from it, and `compiled` counts entries this compile wrote.
  if (conditionsNotCompiled.length > 0) {
    const dropped = new Set(conditionsNotCompiled.map((c) => c.number));
    const order = selection.order.filter((s) => !dropped.has(s.number));
    selection = { keys: new Set(order.map((s) => s.key!)), order, errors: [] };
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
  let lastFailure: (ReplayFailure & { step: CompileStep }) | undefined;
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
   * What the LAST replay's pass-count check noticed (decision 11): a `For
   * each` that ran a different number of passes — or the same number over
   * different values — whoever wrote its list, and a `While` / `Repeat` whose
   * passes differ with no condition to blame. Warnings, never failures: a
   * count cannot tell a wrong selector from a list that changed between the
   * two runs (a test that creates a record and then loops over every record
   * sees one more each run; a loop that consumes its list sees `[]` on the
   * replay), so nothing here is repaired or written off. A list an entry of
   * this compile captured names that entry, for the author to check.
   * Recomputed per round beside `unreached`.
   */
  let loopWarnings: string[] = [];
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
  /** Did the RECORDING fail at this index in the author's words? Read off every
   *  pass, for the comparison above. */
  const recordedDeliberate = (index: number): boolean => recordedAt(index).some(deliberateFailure);
  const stepsInS = (): CompileStep[] => steps.filter((s) => s.key && selection.keys.has(s.key));
  /**
   * A replay round's rows and what they say about the conditions: every visit
   * to a guard, and the first where the replay's CODE answered differently from
   * the recording (decision 11). Computed per call — it is a pure reading of
   * the outcome — so `markRound` and `failureOf` cannot disagree.
   */
  const readRound = (
    outcome: CompileRunOutcome,
  ): RunRows & {
    visits: GuardVisit[];
    mismatch: DecisionMismatch | undefined;
    loopWarnings: string[];
  } => {
    const run = runRows(outcome);
    const visits = guardVisits(run.rows, controls);
    const decisions = compareDecisions(recordVisits, visits, steps);
    // …and every loop's passes (decision 11's other half): a `For each`
    // decides nothing, so a list captured with six items where the recording
    // had three runs six passes with every condition answering as recorded.
    const replaySnapshots = passSnapshots(run.rows, parameters, outcome.resolvedParameters, test.envData);
    for (const secret of replaySnapshots.recovered) recoveredSecrets.add(secret);
    const findings = compareLoopPasses({
      recorded: { entries: recordLoops, rows: recorded.rows, snapshots },
      replay: { entries: loopEntries(run.rows, controls), rows: run.rows, snapshots: replaySnapshots },
      controls,
      divergedAt: decisions.divergedAt,
    });
    const loopWarnings: string[] = [];
    for (const finding of findings) {
      // A loop whose own condition entry the decision check already blamed has
      // said everything there is to say about its passes.
      if (finding.kind !== 'foreach' && decisions.mismatch?.member === finding.guard) continue;
      // The list came from an entry THIS compile wrote, and it ran as code:
      // the warning names that entry, because a selector that matches too much
      // (or too little) is the first thing to rule out. It stays a warning —
      // the same count difference is what a list that legitimately changed
      // between the two runs looks like, and a correct entry repaired (then
      // written off `ai: true`) over it is worse than a word to the author.
      const writer = finding.writer;
      const owner = writer ? steps[writer.index - 1] : undefined;
      const owned =
        finding.kind === 'foreach'
        && writer?.fromCodeBehind === true
        && owner !== undefined
        && owner.kind !== 'condition'
        && owner.key !== undefined
        && selection.keys.has(owner.key);
      // A value as the warning prints it: masked as a prompt masks it, with
      // every frame's inputs.
      const shown = (value: string | undefined, at: Record<string, string>): string | undefined =>
        value === undefined ? undefined : maskedForSummary(finding.list!, value, at, summarySecrets(at));
      loopWarnings.push(
        loopPassWarning(
          finding,
          steps,
          {
            recorded: shown(finding.recordedValue, snapshots.at(finding.recordedRow)),
            replay: shown(finding.replayValue, replaySnapshots.at(finding.replayRow)),
          },
          owned,
        ),
      );
    }
    return { ...run, visits, mismatch: decisions.mismatch, loopWarnings };
  };
  const markRound = (outcome: CompileRunOutcome): void => {
    unreached = [];
    toleratedInReplay = [];
    endedInReplay = undefined;
    const round = readRound(outcome);
    loopWarnings = round.loopWarnings;
    const ended = round.rows.find((r) => deliberateFailure(r) && recordedDeliberate(r.index - 1));
    if (ended) endedInReplay = { step: ended.index };
    for (const step of stepsInS()) {
      if (step.kind === 'condition') {
        // Proven when its code decided a visit cleanly and the decisions it made
        // match the recording's — a replay whose decisions match is proof for
        // the entries that decided them (decision 11). A member its chain's
        // winner kept from ever running proves nothing, and stays unproven.
        const clean = keptAiConditions.has(step.key!)
          ? askedCleanly(round.visits, step.index)
          : codeDecidedCleanly(round.visits, step.index);
        if (clean && round.mismatch?.member !== step.index) {
          proven.add(step.key!);
        }
        continue;
      }
      // Every pass, not the last (decision 3): proven only when every pass
      // that ran ran cleanly. A pass a `return` skipped is no evidence against
      // the ones that ran.
      const rows = round.passes[step.index] ?? [];
      const ran = rows.filter((r) => r.status !== 'skipped');
      if (
        ran.length > 0
        && ran.every(
          (r) =>
            r.status === 'passed'
            // The entry failed the run in the author's words where the
            // recording's AI turn did the same: the entry working, not breaking.
            || (deliberateFailure(r) && recordedDeliberate(step.index)),
        )
      ) {
        proven.add(step.key!);
      }
      const tolerated = ran.find((r) => toleratedFailure(r));
      if (tolerated) {
        toleratedInReplay.push({
          step: step.number,
          // The step's own error, so the compile's summary and the run's
          // report say the same thing about the same step.
          reason: tolerated.error?.trim() || 'the step failed and the run continued',
        });
      }
      if (rows.length > 0 && ran.length === 0) {
        unreached.push({
          step: step.number,
          // The runner's own sentence — `Not run: step 3 returned from "Sign
          // in"` — so the compile's summary and the run's report say the same
          // thing about the same step.
          reason: rows[0]!.aiExplanation?.trim() || 'a return ended its flow',
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
  /**
   * Where a replay failed: the first failure in EXECUTION order (decision 3) —
   * a step's failed pass, a guard that failed, or a condition that answered
   * differently from the recording (decision 11), whichever the run reached
   * first. A wrong answer comes first when it and the failure it caused are
   * the same visit: a `While` whose code says "carry on" where the recording
   * stopped is what then breaches the cap, or fails the pass it should never
   * have run. A loop that ran a different number of passes is never a failure
   * here — it is a warning (`loopWarnings`).
   */
  const failureOf = (outcome: CompileRunOutcome): ReplayFailure => {
    const round = readRound(outcome);
    // `!tolerated`: a tolerated failure carries `status: 'failed'` and the run
    // went past it (stories/step-failure-outcomes.md, decision 6), so taking it
    // as THE failure would repair — and eventually write off as `ai: true` — a
    // step whose own text says it may fail. And not a DELIBERATE failure the
    // recording made too (decisions 1–3): repairing that would ask the model to
    // stop a step from failing when failing is what its text says to do, and the
    // write-off after `maxRounds` would bury the author's own line.
    const failedAt = round.rows.findIndex(
      (r) =>
        r.status === 'failed'
        && !r.tolerated
        && !(deliberateFailure(r) && recordedDeliberate(r.index - 1)),
    );
    const mismatch = round.mismatch;
    if (mismatch && (failedAt < 0 || mismatch.position <= failedAt)) {
      return {
        step: steps[mismatch.member],
        result: mismatch.replayed.row,
        error: mismatchError(mismatch, steps),
        mismatch,
      };
    }
    const result = failedAt >= 0 ? round.rows[failedAt] : undefined;
    // The run's own words, masked as the compile's words are — everywhere this
    // error goes next (the summary, the repair prompt, a write-off comment in a
    // committed file) — with every frame's inputs, which the CLI run's error
    // text was never masked with.
    const error = sayMasked(result?.error ?? outcome.error ?? 'the run failed without naming a step');
    if (!result) return { step: undefined, result, error };
    const at = result.index - 1;
    const control = controls[at];
    if (!control) return { step: steps[at], result, error };
    // A guard row. Its CONDITION entry is to blame only when code decided the
    // guard: the member whose code failed (a chain's is named on the row), or a
    // loop's own line. Anything else — the model could not decide, a `For each`
    // over a non-list, a cap the MODEL kept saying "carry on" to — failed with
    // no entry of this compile's deciding it.
    if (result.guard?.decidedBy === 'code') {
      const member = result.guard.failedMember ?? (isChainRecord(control) ? undefined : at);
      const owner = member !== undefined ? steps[member] : undefined;
      if (owner?.kind === 'condition') return { step: owner, result, error };
    }
    return { step: steps[at], result, error, guardFailure: true, bodyRows: round.rows };
  };
  /**
   * What the compile says about a failure it does not own, or undefined when it
   * owns it — an entry in S, which the rounds repair. Worded for what actually
   * happened, because "recompile it with `--steps N`" over a step with no entry
   * — a guard the model decided, a step that never ran on the recording — sends
   * the author to a command that cannot help.
   */
  const unownedFailure = (failed: ReplayFailure): string | undefined => {
    const step = failed.step!;
    if (failed.guardFailure) {
      return `step ${step.number} failed on the replay — ${failed.error}${capBodyNote(step, failed, controls)}`;
    }
    if (step.key !== undefined && selection.keys.has(step.key)) return undefined;
    if (step.ineligible !== undefined) {
      return `step ${step.number} failed on the replay — ${failed.error} (${step.ineligible})`;
    }
    if (step.isAiEntry) {
      return `step ${step.number} failed on the replay under AI (its entry is \`ai: true\`) — ${failed.error}`;
    }
    if (!step.hasEntry) {
      return (
        `step ${step.number} failed on the replay under AI, and this compile wrote no entry ` +
        `for it — ${failed.error}`
      );
    }
    return (
      `existing entry for step ${step.number} ` +
      `${failed.mismatch ? 'answers differently from the recording' : 'fails'}; recompile it with ` +
      `\`--steps ${step.number}\` (or Compile This Step)`
    );
  };
  /** Regenerate a condition line's entry after its replay failure: shown the
   *  entry, what went wrong, and the recording's pages — the visit that
   *  disagreed first, when one did (decision 11). */
  const repairCondition = async (step: CompileStep, failed: ReplayFailure): Promise<GeneratedEntry> => {
    const all = observationsFor(step.index);
    const disagreed = failed.mismatch?.recorded.row;
    const first = disagreed ? all.find((o) => o.row === disagreed) : undefined;
    const observations = first ? [first, ...all.filter((o) => o !== first)] : all;
    const entryCode = candidate.entryTextFor(step);
    return askCondition(
      step,
      observations,
      entryCode !== undefined ? { entryCode, error: failed.error } : undefined,
    );
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
    // …and a run whose conditions answered as the recording's did: a passing
    // run whose `If` took the other branch is not the recording replayed. (A
    // `For each` that ran a different number of passes is a warning, not this:
    // the list may have changed between the runs.)
    if (failed.mismatch === undefined && (outcome.status === 'passed' || endedAsAsked)) {
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

    if (!failed.step || (!failed.guardFailure && !failed.step.key)) {
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

    // A failure on an entry the author owns is not the compiler's to rewrite,
    // and one on a line with no entry of this compile's has nothing to repair.
    // The rounds stop here; what was proven before it is still proposed.
    const notOurs = unownedFailure(failed);
    if (notOurs !== undefined) {
      failure = notOurs;
      break;
    }

    lastFailure = failed as ReplayFailure & { step: CompileStep };
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
    // The failing pass's values, from the same fold generation reads — over
    // THIS replay's rows, whose pass failed. Its whole map, not its innermost
    // marker alone: a body step of a `While` inside a `For each` needs the
    // outer item too, which the innermost marker does not carry.
    const failedSnapshots = passSnapshots(
      runRows(outcome).rows,
      parameters,
      outcome.resolvedParameters,
      test.envData,
    );
    for (const secret of failedSnapshots.recovered) recoveredSecrets.add(secret);
    const failedValues = failedSnapshots.at(failed.result);
    const repaired =
      failed.step.kind === 'condition'
        ? await repairCondition(failed.step, failed)
        : await repairStep(
            failed.step,
            failed.error,
            failed.result,
            failedValues,
            options,
            candidate,
            { number: round, max: maxRounds },
            {
              secrets: promptSecretsFor(failedValues, failed.step.binding),
              // The loop the step repeats in, as generation told it
              // (decision 2): a repair that forgets it writes the failing
              // pass's item into the code.
              loop: loopContextAt(failed.step.index, failed.result?.loop?.values ?? failedValues),
              // What the RECORDING captured on the pass that failed — never
              // the failing row's own outputs, which are what the broken
              // entry stored.
              recordedCaptures: recordedCapturesAt(
                failed.step,
                failed.result,
                runRows(outcome).passes[failed.step.index] ?? [],
                recordedAt(failed.step.index),
                record.steps[failed.step.index],
              ),
            },
          );
    proven.delete(failed.step.key!);
    const applied = await applyGenerated(candidate, failed.step, repaired, stepEvent, 'repair');
    await candidate.persist();
    if (applied.kind === 'declined') declined++;
    if (failed.step.kind === 'condition') {
      if (applied.kind === 'declined') keptAiConditions.add(failed.step.key!);
      if (applied.kind === 'entry') keptAiConditions.delete(failed.step.key!);
    }
    if (applied.kind === 'error' && failed.step.kind === 'condition') {
      // A condition's repair that produced nothing usable — most often the
      // read-only rule refusing both answers — does not end the compile: that
      // rule is a heuristic (see `conditionsNotCompiled`). The entry it was
      // repairing is known wrong (it failed this replay), so it is written off
      // here, as a step that fails every round would be, and the rounds carry
      // on with everything else.
      await writeOff(failed.step, applied.message, 'because its repair produced no usable condition');
      keptAiConditions.add(failed.step.key!);
      continue;
    }
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
    green = failed.mismatch === undefined && (outcome.status === 'passed' || endedAsAsked);
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
      if (!failed.step || (!failed.guardFailure && !failed.step.key)) {
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
      const notOurs = unownedFailure(failed);
      if (notOurs !== undefined) {
        failure = notOurs;
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
    && conditionsNotCompiled.length === 0
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
    skippedInRecording.length > 0 || neverAsked.length > 0,
  ].filter(Boolean).length;
  const notAttemptedCause =
    causesPresent !== 1
      ? undefined
      : endedAsWritten !== undefined
        ? endedAsWrittenReason('run', endedAsWritten.step)
        : toleratedInRecording.length > 0
          ? 'they failed on the recording run and were tolerated'
          : recordingSkipCause(skipCauseRows);
  const tail = [
    writtenOffAi.length > 0 ? `${writtenOffAi.length} kept AI after replay failures` : '',
    conditionsNotCompiled.length > 0
      ? `${listSteps(conditionsNotCompiled.map((c) => c.number))} not compiled ` +
        `(${conditionsNotCompiled[0]!.message})`
      : '',
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
    ...((loopWarnings.length > 0 || conditionsNotCompiled.length > 0) && {
      warnings: [
        ...loopWarnings,
        ...conditionsNotCompiled.map(
          (c) =>
            `step ${c.number}'s condition was not compiled: ${c.message}. The model keeps ` +
            'deciding it; compile again to retry.',
        ),
      ],
    }),
  };
  // Said as they are decided — once, for the round that decides — so the CLI
  // prints them and the server carries them as `output` frames, the way an
  // unresolved parameter is said.
  for (const message of loopWarnings) emit({ kind: 'note', level: 'warn', message });

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
 *
 * Judged over EVERY row an index has (stories/codebehind-loops-and-conditions.md,
 * decision 3): a loop body's step that passed on pass 1 and broke on pass 2 is
 * where the recording broke, and an index no row reached is where it stopped.
 */
function usablePrefix(passes: readonly (readonly StepResult[] | undefined)[]): number {
  let n = 0;
  for (const rows of passes) {
    const breaking = breakingRow(rows ?? []);
    if ((rows ?? []).length === 0 || breaking) {
      if (breaking && deliberateFailure(breaking)) n++;
      break;
    }
    n++;
  }
  return n;
}

/** A row that neither ends a recording nor is evidence against it: a pass, a
 *  skip, a tolerated failure. */
function neutralRow(row: StepResult): boolean {
  return row.status === 'passed' || row.status === 'skipped' || toleratedFailure(row);
}

/** The first of an index's rows that ends a recording there — a failure the run
 *  did not tolerate, in execution order — or undefined. */
function breakingRow(rows: readonly StepResult[]): StepResult | undefined {
  return rows.find((row) => !neutralRow(row));
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
 *    src/runner/control-runtime.ts). Chains and loops both compile, so this is
 *    reachable on the shape control flow is mostly about, and it used to read
 *    "a return ended its flow" when no return had happened.
 *
 * Both prefixes are anchored, so only those sentences are read; a result
 * skipped for some future reason falls back to a phrasing that asserts no
 * cause at all rather than quoting one out of unrelated prose.
 */
export function notRunOnRecordingReason(result: StepResult | undefined): string {
  const cause = recordingSkipDetail(result);
  return cause === undefined ? 'not run on the recording run' : `not run on the recording run (${cause})`;
}

/** The cause a skipped row states for itself — `step 3 returned`, `the loop
 *  ran no passes` — or undefined when it states none this reads. */
function recordingSkipDetail(result: StepResult | undefined): string | undefined {
  const explanation = result?.aiExplanation ?? '';
  const at = /^Not run: step (\d+)\b/.exec(explanation)?.[1];
  if (at !== undefined) return `step ${at} returned`;
  return /^Skipped:\s*(\S.*)$/.exec(explanation)?.[1];
}

/**
 * Why a condition line is not attempted: no visit on the recording run asked
 * it, so there is no page to generate its entry from
 * (stories/codebehind-loops-and-conditions.md, "Boxed compile"). Its own rows
 * say why when the structure it opens was skipped whole — an untaken branch, a
 * loop around it that ran no passes, a return — and that cause is carried.
 */
function neverAskedReason(rows: readonly StepResult[]): string {
  const cause = rows.length > 0 && rows.every((r) => r.status === 'skipped')
    ? recordingSkipDetail(rows[0])
    : undefined;
  return `the condition was never asked on the recording run${cause === undefined ? '' : ` (${cause})`}`;
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
    // A guard whose condition the MODEL decides — `If`, `Else if`, `While`,
    // `Repeat … until` — compiles to a `condition` entry
    // (stories/codebehind-loops-and-conditions.md, decision 4). Read off the
    // authored line, so a skill body's `{{order}}` is the author's.
    const condition = controls[i] ? compilableCondition(text) !== undefined : false;
    const ineligible = controls[i] && !condition
      ? // `Otherwise` has no condition, `For each` reads a list and never asks
        // a model, and a condition decided from its own values is free already
        // (decision 10): the framework dispatches the line, and there is
        // nothing for an entry to replace. Its TAIL is an ordinary step and
        // compiles normally (stories/control-flow.md, decision 12).
        'a control line is dispatched, not compiled'
      : condition
      ? !binding
        ? 'the step has no code-behind file to bind into'
        : undefined
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
      ? SET_STEP_NOT_COMPILED
      // A `[use ai]` step, beside `Set` where the loops dispatch it — but for
      // the opposite reason: not because it costs nothing, but because the
      // model is to be asked on every run (stories/use-ai-step.md, decision 1).
      : parseUseAiStep(text)
      ? USE_AI_NOT_COMPILED
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
      // Kind-aware, as the live compiler's plan is (`hasEntryOfKind`): an
      // entry of the other kind is in the wrong place — the runtime warns and
      // runs the line under AI — so the line is owed one of its own.
      hasEntry: hasEntryOfKind(binding?.entry, condition ? 'condition' : 'step'),
      isAiEntry,
      ...(ineligible !== undefined && { ineligible }),
      ...(condition && { kind: 'condition' as const }),
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
  const keys = new Set<string>(recorded ? staleKeysIn(recorded, steps) : []);
  const sidecar = await readLastRun(test.filePath);
  for (const entry of sidecar?.steps ?? []) {
    if (!entry.stale) continue;
    const step = steps[entry.index - 1];
    if (step?.key && step.text === entry.source) keys.add(step.key);
  }
  return keys;
}

/**
 * Keys of entries a run's rows flagged stale — every pass of every index.
 *
 * Keyed by the MEMBER whose entry broke, not the row it rides: a chain's guard
 * row belongs to the member that held, while its `codeBehindStale` can name a
 * member before it whose code threw (`guard.staleMember`). Reading the row's
 * own index would regenerate the member that worked and leave the broken one.
 */
function staleKeysIn(outcome: CompileRunOutcome, steps: CompileStep[]): string[] {
  const keys: string[] = [];
  for (const row of runRows(outcome).rows) {
    if (!row.codeBehindStale) continue;
    const key = steps[row.guard?.staleMember ?? row.index - 1]?.key;
    if (key !== undefined) keys.push(key);
  }
  return keys;
}

// ───────────────────────────────────────────────────────────────────────────
// Loops and conditions (stories/codebehind-loops-and-conditions.md)
// ───────────────────────────────────────────────────────────────────────────

/** A run's rows, both ways the compile reads them. */
interface RunRows {
  /** Per expanded index, in execution order. */
  passes: StepResult[][];
  /** Across indices, in execution order. */
  rows: StepResult[];
}

/**
 * A run's step rows as the compiler indexes them: the evidence row per
 * expanded step, every row per step, and every row in execution order
 * (stories/codebehind-loops-and-conditions.md, decisions 1 and 3).
 *
 * The one reduction both producers of a {@link CompileRunOutcome} use — the
 * CLI's `reportToOutcome` and the server's compile runner — so the boxed
 * compile reads the same rows whichever ran it. The evidence row is
 * `evidenceRows`' choice, which is also the row the recording on disk keeps
 * and the live compiler generates from (its `takenKeys`).
 *
 * Hook results and interactive ad-hoc rows share the `index` space with real
 * steps, so they are dropped rather than allowed to stand in for one.
 */
export function outcomeRows(
  results: readonly StepResult[],
  totalSteps: number,
): { steps: (StepResult | undefined)[]; passes: StepResult[][]; rows: StepResult[] } {
  const rows = results.filter(
    (r) =>
      !r.hookScope && !r.interactiveAdHoc && !r.interactiveChild && r.index >= 1 && r.index <= totalSteps,
  );
  const passes: StepResult[][] = Array.from({ length: totalSteps }, () => []);
  for (const row of rows) passes[row.index - 1]!.push(row);
  const steps: (StepResult | undefined)[] = new Array(totalSteps).fill(undefined);
  for (const row of evidenceRows(rows)) steps[row.index - 1] = row;
  return { steps, passes, rows };
}

/** An outcome's rows, whether its producer kept every pass or (built by hand)
 *  only the evidence row per index. */
function runRows(outcome: CompileRunOutcome): RunRows {
  if (outcome.passes) return { passes: outcome.passes, rows: outcome.rows ?? outcome.passes.flat() };
  if (outcome.rows) return { passes: outcomeRows(outcome.rows, outcome.steps.length).passes, rows: outcome.rows };
  const passes = outcome.steps.map((s) => (s ? [s] : []));
  return { passes, rows: passes.flat() };
}

/** The variable writes one row reports: its captures, `Set` / `[use ai]`
 *  values and code-behind `setVar`s (`outputs`), and a `[tool:]` step's
 *  (`toolStep.outputs`). An `[input:]` answer and a hook's capture ride no row
 *  the compile reads — the fold's final-value rule covers those. */
function rowWrites(row: StepResult): Array<[string, string]> {
  return [...Object.entries(row.outputs ?? {}), ...Object.entries(row.toolStep?.outputs ?? {})];
}

/** Define `name` on `map` as an own property — never through a setter, so a
 *  name like `__proto__` is a key like any other. */
function defineValue(map: Record<string, string>, name: string, value: string): void {
  Object.defineProperty(map, name, { value, writable: true, enumerable: true, configurable: true });
}

/** The fold's answer: the map as it stood at each row. */
interface PassSnapshots {
  /**
   * The map at `row`: its own object, carrying the loop-binding marks the fold
   * made, so the prompts' parameter block can tell a pass's `row.keyword` from
   * a data file's `user.apikey` heading (§7.6). A row the fold never saw — or
   * none — gets the map before the first row.
   */
  at(row: StepResult | undefined): Record<string, string>;
  /**
   * What the final map shows MASKED inside a starting value no row wrote —
   * the spans of the real start value that the run's end-of-run mask set
   * replaced (`cb: https://app.test/cb?t=abcd1234` against the CLI's redacted
   * `…?t=***` recovers `abcd1234`, which a later `[store as: api_token]`
   * captured). The snapshots keep the real value; these are for the prompts'
   * mask set, so the prompt masks what the run's own prompts did.
   */
  recovered: string[];
}

/** The fewest characters a recovered secret may have. A span is inferred from
 *  where the mask sits, and a one- or two-character one would mask every such
 *  run of text in a prompt on a guess. */
const MIN_RECOVERED_SECRET_LENGTH = 3;

/**
 * When `shown` is `start` with some spans replaced by the mask and nothing else
 * changed — the way `redact` masks a secret inside a value — the spans of
 * `start` it replaced, in order; otherwise undefined.
 *
 * What a redacted final map is compared with a starting value by: the CLI's
 * `report.parameters` is redacted with the END-of-run mask set, which may hold
 * a secret the run captured after it started, so "only the start value,
 * masked" cannot be told by redacting the start value with any mask set the
 * compile can build — the secret's real value is gone from every map it has.
 */
function maskedSpans(shown: string, start: string): string[] | undefined {
  if (!shown.includes(MASK)) return undefined;
  const pieces = shown.split(MASK);
  // A bound on the pattern's backtracking, far above any real value.
  if (pieces.length > 17 || start.length > 20_000) return undefined;
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^${pieces.map(escape).join('([\\s\\S]+?)')}$`).exec(start);
  return match ? match.slice(1) : undefined;
}

/**
 * The parameter map as it stood at each row, as near as the rows can say —
 * the ONE snapshot generation, repair and the condition prompts read a pass's
 * values from (stories/codebehind-loops-and-conditions.md, decisions 2 and 3).
 *
 * Folded forward in EXECUTION order from the map the run started with: each
 * row's loop marker binds its pass's item (clearing the last pass's dotted
 * keys first, and marking what it bound, as `applyPassBindings` does), the
 * row is snapshotted, and then its writes — `outputs` and a tool's
 * `toolStep.outputs` ({@link rowWrites}) — are bound for the rows after it.
 * So a `[store as: total]` inside a loop body reaches pass 1's `Type
 * {{total}}` as pass 1's total, and a `[tool: create_order]`'s `order_id`
 * reaches the step after it as the tool's value rather than the `none` the
 * parameters started with.
 *
 * `final` is the run's final map, and it answers two things the rows cannot:
 *
 *  - a name no row reports at all — a skill-internal capture, which `outputs`
 *    never carries — filled into every snapshot that lacks it, never under a
 *    root the fold has bound (so the last pass's `order.note` cannot leak into
 *    a pass whose row had no note);
 *  - a STARTING name whose final value differs from where it started though no
 *    row wrote it — an `[input:]` answer, a hook's capture — which takes the
 *    final value from the first row on, as every snapshot did before the fold
 *    existed. Not a name whose final value is only the start value MASKED:
 *    the CLI's final map is the report's redacted copy, and `password` → `***`
 *    is not a write. The report is redacted with the END-of-run mask set, so a
 *    start value holding a secret the run captured LATER — `cb:
 *    https://app.test/cb?t=abcd1234`, then `[store as: api_token]` reads
 *    `abcd1234` — comes back as `…?t=***`: the start value masked, never a
 *    write ({@link maskedSpans}). Taken as one, the snapshots held `…?t=***`
 *    and the leak guard with them, and an entry hard-coding the real URL
 *    passed it. The snapshots keep the REAL start value — the leak guard must
 *    hold real values — and the masked spans go to `recovered`, for the
 *    prompts to mask it with.
 *
 * A row with no marker of its own — a chain's guard row — reads the bindings
 * of the pass the run was last seen in.
 */
function passSnapshots(
  rows: readonly StepResult[],
  start: Record<string, string>,
  final: Record<string, string>,
  envData: ParsedTest['envData'] | undefined,
): PassSnapshots {
  const written = new Set<string>();
  for (const row of rows) {
    for (const [name] of rowWrites(row)) written.add(name);
    for (const name of Object.keys(row.loop?.values ?? {})) written.add(name);
  }
  // The start map as a report would print it, to tell a real change from the
  // redaction of an unchanged value — with the start map's mask set and the
  // final map's, which is the set the report was redacted with (and holds
  // real values where the final map does: the server's, not the CLI's).
  const maskedStart = redactMap(
    { ...start },
    [...runSecrets({ parameters: start, envData }), ...runSecrets({ parameters: final, envData })],
  );
  // Copied as-is — not through `bindVariable`, whose rebind rule would let a
  // flat `user` erase a data file's own `user.apikey` heading depending on key
  // order. The start map is one map, not a sequence of writes.
  const live: Record<string, string> = {};
  for (const [name, value] of Object.entries(start)) defineValue(live, name, value);
  const recovered = new Set<string>();
  for (const [name, value] of Object.entries(final)) {
    if (!Object.hasOwn(start, name) || written.has(name)) continue;
    if (value === start[name] || value === maskedStart[name]) continue;
    const spans = maskedSpans(value, start[name]!);
    if (spans !== undefined) {
      for (const span of spans) if (span.length >= MIN_RECOVERED_SECRET_LENGTH) recovered.add(span);
      continue;
    }
    defineValue(live, name, value);
  }
  const snapshotOf = (): Record<string, string> => {
    const snapshot: Record<string, string> = { ...live };
    inheritLoopBindings(live, snapshot);
    const roots = new Set(Object.keys(live).map(placeholderRoot));
    for (const [name, value] of Object.entries(final)) {
      if (Object.hasOwn(snapshot, name) || roots.has(placeholderRoot(name))) continue;
      defineValue(snapshot, name, value);
    }
    return snapshot;
  };
  const before = snapshotOf();
  const out = new Map<StepResult, Record<string, string>>();
  for (const row of rows) {
    const values = row.loop?.values;
    if (values) {
      clearDottedKeys(live, new Set(Object.keys(values).map(placeholderRoot)));
      for (const [name, value] of Object.entries(values)) defineValue(live, name, value);
      markLoopBindings(live, Object.keys(values).filter((key) => key.includes('.')));
    }
    out.set(row, snapshotOf());
    for (const [name, value] of rowWrites(row)) bindVariable(live, name, value);
  }
  return {
    at: (row) => (row !== undefined ? out.get(row) : undefined) ?? before,
    recovered: [...recovered],
  };
}

/**
 * One decision a guard made: a visit to a chain or a loop condition
 * (stories/codebehind-loops-and-conditions.md, decision 11). `For each` visits
 * are not decisions — the list is read, never asked — and are not visits here.
 */
interface GuardVisit {
  /** The structure: a chain's FIRST member, or the loop's guard. A chain's
   *  rows sit on whichever member held, so this is what groups them. */
  head: number;
  row: StepResult;
  /** The row's position in the run's rows, in execution order. */
  position: number;
  /** Each member asked, in order, with its answer — `true`, `false`, or
   *  absent for a member after the one that held (never asked). A loop has
   *  one member: the guard itself. */
  members: Array<{ index: number; holds?: boolean }>;
  /** Whether anything was decided — a guard that failed before a decision
   *  (the judge could not decide) has none. */
  decided: boolean;
}

/**
 * Every guard visit in a run, in execution order.
 *
 * A guard row is a row at a control index that carries a decision or failed:
 * an untaken member's plain `skipped` row is not a visit. A chain's answers
 * come off the judge's evidence when the row kept it, and otherwise off
 * `selected` and the chain's own members — first-holds-wins, which is how the
 * judge was asked.
 */
function guardVisits(
  rows: readonly StepResult[],
  controls: readonly (ControlRecord | null)[],
): GuardVisit[] {
  const out: GuardVisit[] = [];
  rows.forEach((row, position) => {
    const at = row.index - 1;
    const record = controls[at];
    if (!record || record.kind === 'foreach') return;
    if (row.guard === undefined && row.status !== 'failed') return;
    const guard = row.guard;
    if (isChainRecord(record)) {
      const all = chainMembers(controls, at);
      const asked = all.filter((m) => controls[m]?.kind !== 'else');
      const selected = guard?.selected;
      const decided = selected !== undefined;
      const heldAt = selected === null || selected === undefined ? -1 : asked.indexOf(selected);
      out.push({
        head: all[0] ?? at,
        row,
        position,
        members:
          guard?.evidence?.members ??
          asked.map((index, i) =>
            !decided
              ? { index }
              : heldAt < 0 || i < heldAt
                ? { index, holds: false }
                : i === heldAt
                  ? { index, holds: true }
                  : { index },
          ),
        decided,
      });
      return;
    }
    const decided = guard?.holds !== undefined;
    out.push({
      head: at,
      row,
      position,
      members: [{ index: at, ...(decided && { holds: guard!.holds }) }],
      decided,
    });
  });
  return out;
}

/** One visit on which the recording's MODEL decided a condition — what its
 *  entry is generated from (decision 9) — with the visit's row and values. */
interface RecordedObservation extends ConditionObservation {
  row: StepResult;
  parameters: Record<string, string>;
}

/**
 * Every recorded observation of one condition line, in visit order: each
 * decided visit that asked it and was decided by the model (the judge's page
 * rides the row only then). `generateConditionEntry` is shown the first held
 * and the first not-held of them. A visit judged with no DOM — the computer
 * surface — is still an observation, with no page: the generator declines it
 * (decision 10).
 */
function observationsOf(
  visits: readonly GuardVisit[],
  member: number,
  snapshots: PassSnapshots,
): RecordedObservation[] {
  const out: RecordedObservation[] = [];
  for (const visit of visits) {
    if (!visit.decided) continue;
    const guard = visit.row.guard;
    if (guard?.decidedBy !== 'model' && guard?.evidence === undefined) continue;
    const asked = visit.members.find((m) => m.index === member);
    if (!asked) continue;
    out.push({
      holds: asked.holds,
      ...(guard?.evidence?.dom !== undefined && { dom: guard.evidence.dom }),
      ...(guard?.evidence?.url !== undefined && { url: guard.evidence.url }),
      row: visit.row,
      parameters: snapshots.at(visit.row),
    });
  }
  return out;
}

/** Was this condition line asked on at least one replay visit that did not
 *  fail, whoever decided it? What proves an `ai: true` condition entry. */
function askedCleanly(visits: readonly GuardVisit[], member: number): boolean {
  return visits.some(
    (v) =>
      v.decided
      && v.row.status !== 'failed'
      && v.members.some((m) => m.index === member && m.holds !== undefined),
  );
}

/** Did this condition line's CODE answer at least one replay visit cleanly —
 *  it ran (it was reached, first-holds-wins) and the guard did not fail? */
function codeDecidedCleanly(visits: readonly GuardVisit[], member: number): boolean {
  return visits.some(
    (v) =>
      v.row.guard?.decidedBy === 'code'
      && v.row.status !== 'failed'
      && v.members.some((m) => m.index === member && m.holds !== undefined),
  );
}

/** The first visit where a replay's CODE answered a condition differently
 *  from the recording (decision 11). */
interface DecisionMismatch {
  /** The member whose entry answered wrongly — the first member whose answers
   *  differ, first-holds-wins. */
  member: number;
  /** 1-based visit of the structure (a chain's, or a loop's). */
  visit: number;
  /** The replay row's position in execution order. */
  position: number;
  recorded: GuardVisit;
  replayed: GuardVisit;
  recordedHolds: boolean;
  replayHolds: boolean;
}

/**
 * Compare a replay's guard decisions with the recording's, visit by visit per
 * structure, in the replay's execution order (decision 11).
 *
 * The first difference ends the comparison, whoever made it: after one, the
 * two runs are on different paths and nothing later is comparable. It is a
 * MISMATCH — the entry's fault — only when the replay's code decided that
 * visit and the member that differs is a condition line (not one answered from
 * its values). A visit the model decided in the replay proves nothing about an
 * entry, and a run that ended or failed before a visit the recording had simply
 * has fewer to compare.
 *
 * `divergedAt` is the replay position where the comparison stopped — a
 * mismatch, a difference someone else made, or a visit the other run did not
 * have — or undefined when every visit compared equal. Past it the two runs
 * are on different paths, and the pass-count check reads nothing there.
 */
function compareDecisions(
  recorded: readonly GuardVisit[],
  replayed: readonly GuardVisit[],
  steps: readonly CompileStep[],
): { mismatch?: DecisionMismatch; divergedAt?: number } {
  const byHead = new Map<number, GuardVisit[]>();
  for (const visit of recorded) {
    const list = byHead.get(visit.head) ?? [];
    list.push(visit);
    byHead.set(visit.head, list);
  }
  const seen = new Map<number, number>();
  for (const visit of replayed) {
    const k = seen.get(visit.head) ?? 0;
    seen.set(visit.head, k + 1);
    const was = byHead.get(visit.head)?.[k];
    if (!was || !was.decided || !visit.decided) return { divergedAt: visit.position };
    const differs = was.members.find(
      (m) => m.holds !== visit.members.find((r) => r.index === m.index)?.holds,
    );
    if (!differs) continue;
    const replayHolds = visit.members.find((r) => r.index === differs.index)?.holds;
    if (
      visit.row.guard?.decidedBy !== 'code'
      || steps[differs.index]?.kind !== 'condition'
      || differs.holds === undefined
      || replayHolds === undefined
    ) {
      return { divergedAt: visit.position };
    }
    return {
      mismatch: {
        member: differs.index,
        visit: k + 1,
        position: visit.position,
        recorded: was,
        replayed: visit,
        recordedHolds: differs.holds,
        replayHolds,
      },
      divergedAt: visit.position,
    };
  }
  return {};
}

/**
 * What a mismatch says, in one sentence: both answers, for the condition as
 * authored. The repair is shown it beside the page the recording decided on.
 */
function mismatchError(mismatch: DecisionMismatch, steps: readonly CompileStep[]): string {
  const text = steps[mismatch.member]?.text ?? '';
  const condition = compilableCondition(text)?.condition ?? text;
  const said = (holds: boolean): string => (holds ? 'held' : 'did not hold');
  return (
    `the code said "${condition}" ${said(mismatch.replayHolds)} on visit ${mismatch.visit}; ` +
    `on the recording it ${said(mismatch.recordedHolds)} there`
  );
}

// ── Pass counts (decision 11, the loops' half) ──────────────────────────────

/**
 * One ENTRY into a runtime loop — a `For each` reading its list, or a `While` /
 * `Repeat` from its first pass to the decision that ended it — as a run's rows
 * show it. A loop inside another's body is entered once per outer pass.
 */
interface LoopEntry {
  /** The loop's guard, absolute 0-based. */
  guard: number;
  kind: 'while' | 'repeat' | 'foreach';
  /** Where the entry starts in the run's rows: a `For each`'s list-reading
   *  row, a `While` / `Repeat`'s first decision row. */
  row: StepResult;
  position: number;
  /**
   * How many passes: a `For each`'s list length (its pass-1 marker's `count`,
   * or none for an empty list); a `While` / `Repeat`'s passes, counted off its
   * decisions. Undefined when the rows cannot say — a hand-built marker with
   * no count.
   */
  passes: number | undefined;
  /** A `While` / `Repeat` that ended on its own decision — not at a cap, a
   *  failed guard, or the end of a run that stopped. Always true for a
   *  `For each`, whose count is known on entry. */
  ended: boolean;
}

/**
 * Every loop entry in a run, in execution order.
 *
 * A `For each` makes one row per entry — the visit that reads the list; its
 * revisits ask nobody and record nothing — and its pass-1 marker carries the
 * list's length. A `While` / `Repeat` is counted off its guard rows' decisions,
 * not its markers: a `While` row that holds begins a pass, a `Repeat` row that
 * does NOT hold begins one (its first pass ran before anything was asked), and
 * the first answer the other way ends the entry. A failed guard row ends it
 * without an ending of its own.
 */
function loopEntries(
  rows: readonly StepResult[],
  controls: readonly (ControlRecord | null)[],
): LoopEntry[] {
  const out: LoopEntry[] = [];
  const open = new Map<number, LoopEntry>();
  rows.forEach((row, position) => {
    const guard = row.index - 1;
    const record = controls[guard];
    if (!record || isChainRecord(record)) return;
    if (record.kind === 'foreach') {
      if (row.status !== 'passed') return;
      out.push({
        guard,
        kind: 'foreach',
        row,
        position,
        passes: row.loop ? row.loop.count : 0,
        ended: true,
      });
      return;
    }
    const current = open.get(guard);
    if (row.status === 'failed') {
      if (current) out.push(current);
      open.delete(guard);
      return;
    }
    const holds = row.guard?.holds;
    if (holds === undefined) return;
    const entry =
      current ?? { guard, kind: record.kind, row, position, passes: record.kind === 'repeat' ? 1 : 0, ended: false };
    const carriesOn = record.kind === 'while' ? holds : !holds;
    if (carriesOn) {
      entry.passes = (entry.passes ?? 0) + 1;
      open.set(guard, entry);
      return;
    }
    out.push({ ...entry, ended: true });
    open.delete(guard);
  });
  for (const entry of open.values()) out.push(entry);
  return out.sort((a, b) => a.position - b.position);
}

/** A loop entry whose passes differ from the recording's, or a `For each` that
 *  ran as many passes over a different list. */
interface LoopPassFinding {
  guard: number;
  kind: LoopEntry['kind'];
  /** 1-based entry of this loop in the run. */
  visit: number;
  /** The replay's entry row, in execution order. */
  position: number;
  recordedPasses: number;
  replayPasses: number;
  /** The two entry rows compared — the recording's, and the replay's. */
  recordedRow: StepResult;
  replayRow: StepResult;
  /** A `For each`'s list variable, as the run knows it. */
  list?: string;
  /** Its value on entry, on each run, as the fold has it. */
  recordedValue?: string;
  replayValue?: string;
  /** Equal pass counts, a different list. */
  valuesOnly?: boolean;
  /** The last row BEFORE the replay's entry that wrote the list — outputs or a
   *  tool's outputs. */
  writer?: StepResult;
}

/** The last row before `position` that wrote `name`, in execution order. */
function lastWriterBefore(rows: readonly StepResult[], position: number, name: string): StepResult | undefined {
  for (let p = position - 1; p >= 0; p--) {
    if (rowWrites(rows[p]!).some(([written]) => written === name)) return rows[p];
  }
  return undefined;
}

/**
 * Compare every runtime loop's passes on a replay with the recording's, entry
 * by entry per loop (stories/codebehind-loops-and-conditions.md, decision 11).
 *
 * The condition check cannot see this: a `For each` never asks anything, so a
 * list captured with six items where the recording had three runs six passes
 * with every condition along the way answering as the recording's did. Only
 * entries that START before the decisions diverged (`divergedAt`) are compared
 * — past that the runs are on different paths — and the first pass-count
 * difference ends the comparison for the same reason; a `For each` whose count
 * matches but whose list does not is noted and the comparison goes on.
 * A `While` / `Repeat` is compared only when both runs ended it on its own
 * decision: one a failure cut short already has its failure.
 */
function compareLoopPasses(input: {
  recorded: { entries: readonly LoopEntry[]; rows: readonly StepResult[]; snapshots: PassSnapshots };
  replay: { entries: readonly LoopEntry[]; rows: readonly StepResult[]; snapshots: PassSnapshots };
  controls: readonly (ControlRecord | null)[];
  divergedAt: number | undefined;
}): LoopPassFinding[] {
  const { recorded, replay, controls, divergedAt } = input;
  const byGuard = new Map<number, LoopEntry[]>();
  for (const entry of recorded.entries) {
    const list = byGuard.get(entry.guard) ?? [];
    list.push(entry);
    byGuard.set(entry.guard, list);
  }
  const seen = new Map<number, number>();
  const out: LoopPassFinding[] = [];
  for (const entry of replay.entries) {
    const k = seen.get(entry.guard) ?? 0;
    seen.set(entry.guard, k + 1);
    if (divergedAt !== undefined && entry.position > divergedAt) break;
    const was = byGuard.get(entry.guard)?.[k];
    if (!was || was.passes === undefined || entry.passes === undefined) continue;
    if (!was.ended || !entry.ended) continue;
    const base = {
      guard: entry.guard,
      kind: entry.kind,
      visit: k + 1,
      position: entry.position,
      recordedPasses: was.passes,
      replayPasses: entry.passes,
      recordedRow: was.row,
      replayRow: entry.row,
    };
    const record = controls[entry.guard];
    if (record?.kind !== 'foreach') {
      if (was.passes !== entry.passes) {
        out.push(base);
        break;
      }
      continue;
    }
    const list = record.list;
    const recordedValue = recorded.snapshots.at(was.row)[list];
    const replayValue = replay.snapshots.at(entry.row)[list];
    const writer = lastWriterBefore(replay.rows, entry.position, list);
    const finding: LoopPassFinding = {
      ...base,
      list,
      ...(recordedValue !== undefined && { recordedValue }),
      ...(replayValue !== undefined && { replayValue }),
      ...(writer && { writer }),
    };
    if (was.passes !== entry.passes) {
      out.push(finding);
      break;
    }
    if (recordedValue !== undefined && replayValue !== undefined && recordedValue !== replayValue) {
      out.push({ ...finding, valuesOnly: true });
    }
  }
  return out;
}

/** A value as a compile's own words may print it: masked the way the prompt
 *  masks it — by name, by record shape, by `secrets` (the run's mask set with
 *  every frame's inputs) — and clipped. */
function maskedForSummary(
  name: string,
  value: string,
  snapshot: Record<string, string>,
  secrets: string[],
  limit = 160,
): string {
  const masked = maskValueForPrompt(isSecretParameterName(name, snapshot), name, value, new Set<string>(), secrets);
  return masked.length > limit ? `${masked.slice(0, limit - 1)}…` : masked;
}

/** `step 12 ("For each {{account}} in {{accounts}}")` — a loop, named. */
function loopName(guard: number, steps: readonly CompileStep[]): string {
  return `step ${guard + 1} ("${clipLine(steps[guard]?.text ?? '')}")`;
}

/**
 * The warning line for a pass-count finding (decision 11). `owned`: the list
 * came from an entry this compile wrote, which ran as code — the line names
 * it, for the author to check, and says the other explanation too, because a
 * count cannot tell a selector that matches too much from a list that changed
 * between the two runs.
 */
function loopPassWarning(
  finding: LoopPassFinding,
  steps: readonly CompileStep[],
  values: { recorded: string | undefined; replay: string | undefined },
  owned = false,
): string {
  const loop = loopName(finding.guard, steps);
  const passes = (n: number): string => `${n} pass${n === 1 ? '' : 'es'}`;
  if (finding.valuesOnly) {
    return (
      `${loop} ran ${passes(finding.replayPasses)} on the replay, as on the recording, over a different ` +
      `{{${finding.list}}}: ${values.replay ?? '(unknown)'} where the recording's was ` +
      `${values.recorded ?? '(unknown)'}`
    );
  }
  const head =
    `${loop} ran ${passes(finding.replayPasses)} on the replay and ${passes(finding.recordedPasses)} ` +
    'on the recording';
  if (finding.kind !== 'foreach') return head;
  const writer = finding.writer;
  if (owned && writer) {
    return (
      `${head} — check the entry for step ${writer.index} ("${clipLine(steps[writer.index - 1]?.text ?? '')}"), ` +
      `which captured the list: {{${finding.list}}} was ${values.recorded ?? '(unknown)'} on the recording ` +
      `and ${values.replay ?? '(unknown)'} on the replay (a list that changed between the two runs does ` +
      'this too, and then the entry is right)'
    );
  }
  const source = writer
    ? `{{${finding.list}}} came from step ${writer.index} ("${clipLine(steps[writer.index - 1]?.text ?? '')}"), ` +
      'which is not an entry this compile wrote'
    : `nothing in the replay wrote {{${finding.list}}} before it`;
  return `${head}: ${source}`;
}

/**
 * The clause a loop's failed guard adds when it breached its cap with its body
 * running as code on every pass: the loop never ended, and what did not move
 * the page on is the body, not the (model-decided) condition.
 */
function capBodyNote(
  step: CompileStep,
  failed: ReplayFailure,
  controls: readonly (ControlRecord | null)[],
): string {
  const record = controls[step.index];
  if (!record || isChainRecord(record) || record.kind === 'foreach') return '';
  if (failed.result?.guard?.holds === undefined) return '';
  const body = (failed.bodyRows ?? []).filter(
    (r) => r.index - 1 >= record.bodyStart && r.index - 1 <= record.bodyEnd && r.status !== 'skipped',
  );
  if (body.length === 0 || !body.every((r) => r.status === 'passed' && r.fromCodeBehind)) return '';
  const numbers = [];
  for (let i = record.bodyStart; i <= record.bodyEnd; i++) numbers.push(i + 1);
  return (
    `; its body (${listSteps(numbers)}) ran as code on every pass and never ended the loop — ` +
    'check that the body moves the page on'
  );
}

/** Where a replay round failed (see `failureOf` in `compileTest`). */
interface ReplayFailure {
  /** The entry the failure is blamed on — a step's, or a condition line's —
   *  or, with `guardFailure`, the guard that failed. Undefined when no step
   *  owns the failure. */
  step: CompileStep | undefined;
  /** The replay row that failed; for a mismatch, the guard row of the visit. */
  result: StepResult | undefined;
  error: string;
  /** A condition answered differently from the recording (decision 11). */
  mismatch?: DecisionMismatch | undefined;
  /** A guard failed and no condition entry decided it: nothing of this
   *  compile's to repair. */
  guardFailure?: boolean | undefined;
  /** The round's rows, for what a failed guard's sentence says about its body. */
  bodyRows?: readonly StepResult[] | undefined;
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
  /** The failing PASS's own values (stories/codebehind-loops-and-conditions.md,
   *  decision 3): pass 2 of a `For each` failed on Savings, and a repair told it
   *  was Travel — the Record's final map — would fix the wrong row. The
   *  caller's `passSnapshots` fold, so an enclosing loop's item is right too. */
  values: Record<string, string>,
  options: CompileOptions,
  candidate: Candidate,
  round: { number: number; max: number },
  extras: {
    /** The prompt's mask set: the run's as of `values`, the step's frame
     *  inputs, and what the final map showed masked (`promptSecretsFor`). */
    secrets: string[];
    loop?: LoopContext | undefined;
    /** What the recording captured on the failing pass, RAW, by authored
     *  capture name ({@link recordedCapturesAt}). */
    recordedCaptures?: Record<string, string> | undefined;
  },
): Promise<GeneratedEntry> {
  const parameters = stepParameters(step.binding!, values, options.test.envData);
  // The step passed Generate, so every reference it makes resolved there;
  // the repair sees the same list, and the same guard.
  const envRefs = stepEnvRefs(step.binding!, options.test.envData).resolved;
  const repairInput: RepairPromptInput = {
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
    // The fold's snapshot and the run's mask set as of it, as generation has
    // them — so the repair masks what the run's own prompts masked.
    parameterMap: values,
    secrets: extras.secrets,
    ...(envRefs.length > 0 && { envRefs }),
    round,
    ...(extras.loop && { loop: extras.loop }),
    ...(extras.recordedCaptures && { recordedCaptures: extras.recordedCaptures }),
  };
  const { result } = await askWithCaptureRetry(
    options.aiClient,
    options.contextContent,
    (retry) => buildRepairPrompt({ ...repairInput, ...(retry && { retry }) }),
    [
      // The authored line, exactly as generation passes it: a value the author
      // QUOTED in the step is the author's, so an entry echoing it is repeating the
      // step rather than inlining a resolved value (`guardedValues` /
      // `authorQuotedLiterals`, generate.ts). Without it, `If {{a}} is "peanuts"
      // then fail …` with `{{a}}` = `peanuts` cannot be repaired at all — every
      // candidate contains `peanuts`, so each was discarded as a leak and the step
      // was written off `ai: true` after `maxRounds`
      // (stories/step-failure-outcomes.md, decisions 3 and 10).
      ...guardedValues(parameters, envRefs, step.text),
      // …and what the recording captured, which a repair shown it must read
      // from the page rather than store.
      ...capturedValueGuards(extras.recordedCaptures, step.text),
    ],
    options.signal,
  );
  return result;
}

/**
 * What the RECORDING captured for a step whose replay failed on `failedRow` —
 * the result its repair must reproduce.
 *
 * The recording's row for the SAME pass: the failing row's place among the
 * replay's rows for this index, then that place among the recording's. A body
 * step reading the amount due on pass 2 of a `While` is repaired against pass
 * 2's page, and pass 1's value would tell it to produce the wrong one. When
 * the recording has no row at that place, or it captured nothing, the evidence
 * row — the one generation was shown — answers.
 *
 * Never the failing row's own `outputs`: those are what the broken entry
 * stored.
 */
function recordedCapturesAt(
  step: CompileStep,
  failedRow: StepResult | undefined,
  replayRows: readonly StepResult[],
  recordedRows: readonly StepResult[],
  evidenceRow: StepResult | undefined,
): Record<string, string> | undefined {
  const at = failedRow !== undefined ? replayRows.indexOf(failedRow) : -1;
  const samePass = at >= 0 ? recordedRows[at] : undefined;
  return (
    recordedCapturesOf(step.binding, samePass?.outputs)
    ?? recordedCapturesOf(step.binding, evidenceRow?.outputs)
  );
}

/**
 * Regenerate a step whose evidence pass healed — its entry threw on that pass
 * and the step ran under AI — through the repair prompt, as the live compiler's
 * `askForRepair` does: the entry as it stands in the file (the code that
 * broke), the error it threw (`codeBehindStale`), and the page BEFORE the step
 * on that pass, which is the page the entry threw on. The pass's own values,
 * from the same snapshot generation reads (`passSnapshots`).
 *
 * Undefined when the entry's text cannot be found — the caller then generates
 * normally. The pre-checks mirror generation's: a transcript that changed
 * runner state, or a reference this run cannot answer, declines here too.
 */
async function repairHealedStep(
  step: CompileStep,
  result: StepResult,
  values: Record<string, string>,
  /** The prompt's mask set, as generation's (`promptSecretsFor`). */
  secrets: string[],
  options: CompileOptions,
  candidate: Candidate,
  /** The loop the step repeats in, as generation is told it (decision 2). */
  loop: LoopContext | undefined,
): Promise<GeneratedEntry | undefined> {
  const binding = step.binding!;
  const thrown = result.codeBehindStale?.error;
  if (thrown === undefined) return undefined;
  const error = redact(thrown, secrets);
  const file = await candidate.read(binding.file);
  if (file === null) return undefined;
  const entryCode = entryTextIn(file, binding.source, binding.section, binding.occurrence);
  if (entryCode === undefined) return undefined;

  const refused = refuseReason(binding.source, actionsOf(result));
  if (refused) return { kind: 'declined', reason: refused };
  const envRefs = stepEnvRefs(binding, options.test.envData);
  if (envRefs.unresolved.length > 0) {
    return { kind: 'declined', reason: unresolvedRefsReason(envRefs.unresolved, options.test.envData) };
  }
  const parameters = stepParameters(binding, values, options.test.envData);
  const ctx = result.stepContext;
  // What the healed pass captured under AI — the answer the broken entry was
  // meant to produce, which the repair must reproduce and must not write in.
  const recordedCaptures = recordedCapturesOf(binding, result.outputs);
  const repairInput: RepairPromptInput = {
    rawStepText: step.text,
    stepIndex: step.number,
    entryCode,
    error,
    ...(ctx?.domBefore !== undefined && { dom: ctx.domBefore }),
    ...(ctx?.urlBefore !== undefined && { url: ctx.urlBefore }),
    parameters,
    parameterMap: values,
    secrets,
    ...(envRefs.resolved.length > 0 && { envRefs: envRefs.resolved }),
    ...(loop && { loop }),
    ...(recordedCaptures && { recordedCaptures }),
  };
  const { result: repaired } = await askWithCaptureRetry(
    options.aiClient,
    options.contextContent,
    (retry) => buildRepairPrompt({ ...repairInput, ...(retry && { retry }) }),
    [
      ...guardedValues(parameters, envRefs.resolved, binding.source),
      ...capturedValueGuards(recordedCaptures, binding.source),
    ],
    options.signal,
  );
  return repaired;
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
 * A run's report, reduced to what the compiler indexes by expanded step —
 * through {@link outcomeRows}, as the server's compile runner reduces its own.
 */
export function reportToOutcome(report: TestReport, totalSteps: number): CompileRunOutcome {
  return {
    status: report.status === 'passed' ? 'passed' : 'failed',
    ...(report.error !== undefined && { error: report.error }),
    ...outcomeRows(report.steps, totalSteps),
    resolvedParameters: report.parameters ?? {},
    tokensUsed: report.tokensUsed,
  };
}

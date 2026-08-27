import path from 'node:path';
import type { AiClient } from '../ai/client.js';
import type { StepResult, StepStatus } from '../report/types.js';
import {
  envDataRefsIn,
  resolveEnvDataRef,
  type EnvDataContext,
} from '../parser/interpolate-env-data.js';
import { isCodeStep } from '../parser/invocation-parser.js';
import { logger } from '../utils/logger.js';
import {
  actionsOf,
  applyGenerated,
  Candidate,
  contextOf,
  entryKeyOf,
  type CompilePhase,
  type CompileStep,
} from './candidate.js';
import {
  askForEntry,
  generateStepEntry,
  guardedValues,
  refuseReason,
  stepEnvRefs,
  stepParameters,
  unresolvedRefsReason,
  type GeneratedEntry,
} from './generate.js';
import { buildRepairPrompt } from './repair.js';
import { readLastRun, type LastRunStep } from './last-run.js';
import { entryTextIn } from './writer.js';
import type { CodeBehindBinding } from './loader.js';
import { codeBehindFileKey as fileKey, recordingDirFor } from './recording.js';
import { reviewCandidate } from './review.js';
import type { CompileStatus, CompileSummary } from './compile.js';

/**
 * Compiling as the run goes (stories/compile-as-you-go.md).
 *
 * The boxed pipeline in `compile.ts` records the test, generates, reviews and
 * then replays until green. This one has no box: a run the author asked for
 * carries the flag, each step that finished under AI is queued for generation
 * while the browser moves on, and when the run ends the queue drains and the
 * proposal goes back on the run's own stream. There is no Record — the run
 * *is* the recording — and no Replay: the author's next ordinary run proves
 * each entry (the code mark) or flags it (⚠ stale), which is the rot loop the
 * runtime already runs.
 *
 * Two modes, because the server behaves differently per mode:
 *
 * - `'run'` — Run & Compile. The whole test; the Review pass runs over each
 *   touched candidate file at the end; the recording replaces wholesale.
 * - `'steps'` — Compile This Step. Just the sent steps, code-behind execution
 *   disabled for the request so a broken entry re-records under AI; no Review,
 *   because a one-entry diff that arrives reflowed end to end buries the
 *   change the author asked for; the recording splices.
 *
 * The queue is serialized in step order on purpose: entry *k* reads the
 * candidate file as it stands and may reuse a helper entry *k−1* introduced.
 * The run never waits on it.
 */

export type LiveCompileMode = 'run' | 'steps';

/** The `compile:step` frame, shaped like the compile stream's so a client's
 *  folding carries over (stories/compile-as-you-go.md §On the wire). */
export interface LiveCompileStepEvent {
  type: 'compile:step';
  phase: CompilePhase;
  /** 1-based expanded step. */
  step: number;
  /** The step's source line, for the gutter. */
  line?: number;
  message: string;
}

/**
 * How far the tail has got (stories/compile-tail-progress.md), as numbers.
 *
 * The client's counts must not come from matching the prose on
 * `compile:step` — that would mirror the server's wording and rot the first
 * time it changes — so they ride their own frame.
 */
export interface LiveCompileProgressEvent {
  type: 'compile:progress';
  /** Enqueued entries that reached a terminal state — generated, kept as AI,
   *  errored, or skipped by a stop. */
  done: number;
  /** Entries enqueued so far; final once the run's last step has ended. */
  total: number;
  phase: 'generate' | 'review';
  /** 1-based step being generated right now, when `phase` is `'generate'`. */
  step?: number;
  line?: number;
  /** A Review pass is still owed ('run' mode only). */
  reviewPending?: boolean;
  /** The run's last step has just ended; everything from here is tail. */
  runEnded?: boolean;
}

/** Everything the compiler puts on the run's stream. */
export type LiveCompileEvent = LiveCompileStepEvent | LiveCompileProgressEvent;

export interface LiveCompileOptions {
  mode: LiveCompileMode;
  /** Absolute path of the test file. */
  testFilePath: string;
  /**
   * The SESSION's client — the one that drove the run, not a compile-built
   * one. This is what makes a session's `runSettings.model` override cover
   * generation as well as the run, which it never did on the boxed path.
   */
  aiClient: AiClient;
  /** The session's context files, as the run used them. */
  contextContent: string;
  /** For the prompt's test-info block. The run never parses the markdown
   *  title, so this is the file's basename. */
  testName: string;
  baseUrl?: string | undefined;
  envData?: EnvDataContext | undefined;
  /**
   * Every expanded step in this request, in order: the authored text and
   * whether it is one this compile means to write. `inScope` is decided
   * statically, before the run — a step with no entry, or every sent step in
   * `'steps'` mode — because the prompt's whole-test block has to be the same
   * for step 1 as for step 9, and what step 9 will turn out to need is not
   * known when step 1 is generated.
   */
  plan: PlanEntry[];
  /** The run's abort signal. A stop skips generations not yet started.
   *  Replaced per block by `beginBlock` — a retained compiler outlives the
   *  request that created it, and block 1's signal is spent by then. */
  signal?: AbortSignal | undefined;
  emit: (event: LiveCompileEvent) => void;
  /** Something the author should know that belongs to no step. */
  note?: ((message: string, level: 'info' | 'warn') => void) | undefined;
}

/** One expanded step, as the compile sees it. */
export interface PlanEntry {
  /** The step's authored text — what an entry's `source` must match. */
  text: string;
  /** Whether this compile means to write an entry for it (the whole-test
   *  prompt's scope marking). */
  inScope: boolean;
  /** 1-based source line, for the gutter and the run log. */
  line?: number | undefined;
}

/** One finished step, offered to the compiler as the run moves on. */
export interface LiveStepInput {
  /** 0-based expanded index WITHIN THE CURRENT BLOCK. The compiler adds the
   *  block's offset to get the step's place in the whole run. */
  index: number;
  /** The step's code-behind binding, from the generation registry. */
  binding?: CodeBehindBinding | undefined;
  /** The step's full record — transcript, assertions, DOM either side. */
  result: StepResult;
  /** A SNAPSHOT of the live parameter map. The run keeps writing to its own. */
  resolvedParameters: Record<string, string>;
}

export interface LiveCompileOutcome {
  status: CompileStatus;
  /** Proposed content by absolute `.steps.ts` path. */
  files: Record<string, string>;
  summary: CompileSummary;
}

/** What the run knows at the end that the step-by-step feed cannot. */
export interface LiveCompileFinish {
  tokensUsed: number;
  /** Where the run stopped, when it did not reach the end of the request. */
  stoppedAt?: { step: number; error: string } | undefined;
  /** 1-based expanded steps the run never reached. */
  notAttempted?: number[] | undefined;
  /** The run was stopped by the client. */
  aborted?: boolean | undefined;
}

/**
 * Why a step is not generated from, or undefined when it is.
 *
 * Mirrors `compileTest`'s selection rules, decided per step from what the run
 * actually did rather than from the file alone:
 *
 * - **no binding** — nothing to write into; `[tool:]` and `[skill:]` markers
 *   are expanded or dispatched before the AI loop and are never generated.
 * - **did not pass** — a failed step's transcript is a recording of the
 *   failure; the boxed pipeline stops at the same place.
 * - **ran as code** — it needs no transcript, because its code already is the
 *   answer. This is the default selection ("no entry, or flagged stale")
 *   falling out of run behaviour for free.
 * - **`ai: true`** — the author's opt-out. Deleting the entry undoes it.
 */
export function generationRefusal(input: {
  binding?: CodeBehindBinding | undefined;
  text: string;
  status: StepStatus;
  fromCodeBehind?: boolean | undefined;
  codeBehindStale?: unknown;
}): string | undefined {
  // `[skill` / `[tool` calls only — `[input:]`, `[output:]` and
  // `[interactive]` DO reach generation and are declined there, with the
  // reason, by `refuseReason`; those are still the author's step and deserve
  // an `ai: true` entry saying why.
  //
  // The parser, not a look-alike pattern. The regex this replaces was wrong
  // in both directions: `\s` claimed `[skill<NBSP>login]`, which the scanner
  // calls prose (so the step was refused generation for a reason that wasn't
  // true, permanently), while the `^` anchor missed every LABELLED call —
  // `Seed the cart [tool: seed_cart]` is dispatched to the tool, yet the
  // compiler paid to generate a Playwright entry for it on every run.
  if (isCodeStep(input.text.trim())) {
    return 'a [skill:] or [tool:] step is expanded or dispatched, never generated';
  }
  if (!input.binding) return 'the step has no code-behind file to bind into';
  if (input.status !== 'passed') return 'the step did not pass';
  if (input.binding.entry?.ai === true) return 'the entry is marked `ai: true`';
  // An entry that threw and healed under AI produced a transcript and is
  // flagged stale — exactly the case a recompile exists for.
  if (input.fromCodeBehind === true && !input.codeBehindStale) return 'the step ran as code';
  return undefined;
}

export class LiveCompiler {
  private readonly candidate = new Candidate();
  /** The serialized generation queue. Entry k may reuse a helper from k−1. */
  private tail: Promise<void> = Promise.resolve();
  private readonly compiled: number[] = [];
  private readonly declined: number[] = [];
  private readonly skippedByStop: number[] = [];
  private kept = 0;
  private keptAiExisting = 0;
  private errors = 0;
  /**
   * Entries put on the queue — the tail's `total`.
   *
   * Counted at `offer` time rather than derived from the outcome lists,
   * because the whole point of the number is to be known BEFORE the work is
   * done. It is final once the run's last step has been offered, which is
   * exactly when `runStepsEnded` forecasts with it.
   */
  private enqueued = 0;
  /** Every parameter value the run resolved, merged across steps, for the
   *  review's leak guard. */
  private readonly parameters: Record<string, string> = {};
  /**
   * The whole run's steps, growing a block at a time.
   *
   * A logical run reaches the server as several requests whenever it is split
   * — an `[input:]` or `[interactive]` step between two stretches of steps, or
   * a breakpoint that ends one batch and leaves Continue to send the next. The
   * compiler is retained on the session across those, so the candidate is one
   * file the entries accumulate into rather than a fresh read of the
   * (unapplied) file per block, and so step numbers stay the run's own.
   */
  private plan: PlanEntry[];
  /** Where the CURRENT block's step 0 sits in `plan`. */
  private offset = 0;
  /** This block's abort signal (block 1's is spent by block 2's time). */
  private signal: AbortSignal | undefined;
  /**
   * Where this block's frames go.
   *
   * Per block for the same reason the signal is: a retained compiler outlives
   * the request that created it, and block 1's `emit` writes to an SSE stream
   * that closed when block 1 answered. Caught by the split-run seam test,
   * which saw a correct summary and not one `compile:step` frame.
   */
  private emit: (event: LiveCompileEvent) => void;
  private note: ((message: string, level: 'info' | 'warn') => void) | undefined;
  /** Set by `dispose`: skip generations not yet started and propose nothing. */
  private disposed = false;
  /** Content last handed to the reviewer, per file, so a second block does
   *  not pay to review a file it did not change. */
  private readonly reviewed = new Map<string, string>();
  /** The last-run sidecar's rows, read once and shared by every step. */
  private lastRun: Promise<LastRunStep[]> | undefined;

  /** How many steps this compile is FOR, blocks included — the summary's
   *  `totalSteps`. Starts as the plan's length and shrinks when a block is
   *  bounded to a slice (`setSlice`): a single-step compile of a six-step
   *  skill is "1 of 1", not "1 of 6". */
  private scopedTotal: number;

  constructor(private readonly options: LiveCompileOptions) {
    this.plan = [...options.plan];
    this.scopedTotal = this.plan.length;
    this.signal = options.signal;
    this.emit = options.emit;
    this.note = options.note;
  }

  /**
   * Start another block of the same logical run: extend the plan with the
   * steps this request carries and take its abort signal. Returns nothing —
   * the offset is the compiler's own business.
   */
  beginBlock(
    plan: PlanEntry[],
    signal?: AbortSignal | undefined,
    stream?: {
      emit: (event: LiveCompileEvent) => void;
      note?: ((message: string, level: 'info' | 'warn') => void) | undefined;
    },
  ): void {
    this.offset = this.plan.length;
    this.plan.push(...plan);
    this.scopedTotal += plan.length;
    this.signal = signal;
    if (stream) {
      this.emit = stream.emit;
      this.note = stream.note;
    }
  }

  /**
   * Bound the CURRENT block to a slice: the request expanded the whole
   * document (occurrence counting and the whole-test prompt need it all) but
   * executes only `[startIndex, endIndex]` of it — a skill-file single-step
   * run/compile, or any `startAt`/`endAt` re-run with `compile` riding it.
   *
   * The plan stays full-length — `offer` and `stepEvent` index it by absolute
   * position — but out-of-slice steps drop out of scope, and the summary's
   * `totalSteps` counts only the slice. Indexes are 0-based within this
   * block's own plan segment. Called before any of the block's steps is
   * offered.
   */
  setSlice(startIndex: number, endIndex: number): void {
    const blockLen = this.plan.length - this.offset;
    const start = Math.max(0, startIndex);
    const end = Math.min(blockLen - 1, endIndex);
    for (let i = 0; i < blockLen; i++) {
      if (i < start || i > end) this.plan[this.offset + i]!.inScope = false;
    }
    const size = Math.max(0, end - start + 1);
    this.scopedTotal += size - blockLen;
  }

  /** How many steps of this run the compiler has seen, blocks included. Used
   *  by the caller to number the next block's steps and its recording. */
  get stepsSoFar(): number {
    return this.plan.length;
  }

  /** The offset the current block started at. */
  get blockOffset(): number {
    return this.offset;
  }

  /**
   * Abandon the compile without a result.
   *
   * The queue is the reason this exists: it is spending model calls on the
   * caller's behalf, and a run that threw between "the compiler exists" and
   * "the compiler is finished" would leave it doing that with nobody left to
   * receive the answer. Skips generations not yet started and waits for the
   * one in flight, whose call is already paid for.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.tail.catch(() => {});
  }

  /** True when at least one step is queued or already generated. */
  get attempted(): number {
    return this.compiled.length + this.declined.length + this.errors;
  }

  /**
   * Enqueued entries that will produce nothing more — the tail's `done`.
   *
   * `attempted` plus what a stop skipped. Those two are the same number on
   * every path but a stop, which is the one case where an entry ends without
   * an outcome; counting it keeps the progress bar from freezing part-way
   * while the run winds down.
   */
  private get settled(): number {
    return this.attempted + this.skippedByStop.length;
  }

  /**
   * Put the tail's counts on the stream.
   *
   * `reviewPending` is a forecast, not a fact: it says a Review pass is owed
   * if the compile gets that far. A `'steps'` compile never owes one.
   */
  private emitProgress(
    phase: 'generate' | 'review',
    current?: { step: number; line?: number | undefined },
    runEnded?: boolean,
  ): void {
    this.emit({
      type: 'compile:progress',
      done: this.settled,
      total: this.enqueued,
      phase,
      ...(current && { step: current.step }),
      ...(current && typeof current.line === 'number' && current.line > 0 && { line: current.line }),
      ...(phase === 'generate' && this.options.mode === 'run' && { reviewPending: true }),
      ...(runEnded === true && { runEnded: true }),
    });
  }

  /**
   * The run's last step has ended; everything left is tail
   * (stories/compile-tail-progress.md).
   *
   * This is the moment `total` becomes final — every step has been offered —
   * and the moment the author most needs to be told what is still owed, because
   * the steps have stopped painting and nothing else is about to speak for up
   * to a minute. Called by the server once per BLOCK: a run split by a
   * breakpoint drains its queue at the end of each block, so each block has its
   * own tail and its own forecast.
   *
   * Silent when there is no tail to forecast — an all-cached run that enqueued
   * nothing and owes no Review has nothing to wait for, and saying "0 entries
   * still to generate" would be noise.
   *
   * A run stopped before its last step is the other wording: what is queued
   * will be skipped, not generated, and `finish` runs no Review on an aborted
   * compile — so promising one here would be a forecast of something that
   * cannot happen.
   */
  runStepsEnded(): void {
    const stopped = this.disposed || this.signal?.aborted === true;
    const outstanding = this.enqueued - this.settled;
    const reviewOwed = this.options.mode === 'run' && this.enqueued > 0 && !stopped;
    if (outstanding === 0 && !reviewOwed) return;
    this.emitProgress('generate', undefined, true);
    const plural = outstanding === 1 ? 'entry' : 'entries';
    if (stopped) {
      if (outstanding > 0) {
        this.note?.(
          `Run stopped — ${outstanding} queued ${plural} will not be generated`,
          'info',
        );
      }
      return;
    }
    const entries = `${outstanding} ${plural} still to generate`;
    this.note?.(
      reviewOwed
        ? `Run finished — ${entries}, then a review pass`
        : `Run finished — ${entries}`,
      'info',
    );
  }

  /**
   * Offer a finished step. Returns immediately — the browser never waits on
   * generation. Called for EVERY step, eligible or not, so the summary can
   * say how many were kept as code and how many were already AI.
   */
  offer(input: LiveStepInput): void {
    // Merged across EVERY offered step, eligible or not, and before the
    // refusal below returns. The review's leak guard is a whole-file check —
    // a rewrite can move a literal into any entry — so it has to see every
    // value the run resolved, not the last eligible step's snapshot. A step
    // that captured a password and was then skipped as "ran as code" still
    // put that password in the run's scope.
    Object.assign(this.parameters, input.resolvedParameters);
    const at = this.offset + input.index;
    const text = input.binding?.source ?? this.plan[at]?.text ?? input.result.instruction;
    const refusal = generationRefusal({
      binding: input.binding,
      text,
      status: input.result.status,
      fromCodeBehind: input.result.fromCodeBehind,
      codeBehindStale: input.result.codeBehindStale,
    });
    if (refusal !== undefined) {
      if (refusal === 'the step ran as code') this.kept++;
      if (refusal === 'the entry is marked `ai: true`') this.keptAiExisting++;
      logger.debug(`Compile-as-you-go skipped step ${input.index + 1}: ${refusal}`);
      return;
    }
    const step: CompileStep = {
      index: at,
      number: at + 1,
      text,
      binding: input.binding,
      key: entryKeyOf(input.binding!),
      hasEntry: input.binding!.entry !== undefined,
      isAiEntry: false,
    };
    this.enqueued++;
    // Each link is isolated. A rejected link would otherwise poison the rest
    // of the chain — `.then` on a rejected promise is skipped — so one
    // unexpected throw at step 2 would silently lose steps 3..n, which is
    // exactly the "a run must not fail over its own bookkeeping" rule at the
    // level below the one `generate` already guards.
    this.tail = this.tail
      .then(() => this.generate(step, input))
      .catch((err: unknown) => {
        this.errors++;
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Code-behind generation threw for step ${step.number}: ${message}`);
        this.note?.(
          `Code-behind generation failed for step ${step.number}: ${message}. ` +
            'The step stays AI; nothing was written for it.',
          'warn',
        );
        // `generate` threw before its own progress emit, so this entry would
        // otherwise never be counted settled.
        this.emitProgress('generate');
      });
  }

  private stepEvent = (phase: CompilePhase, step: CompileStep, message: string): void => {
    const line = this.plan[step.index]?.line;
    this.emit({
      type: 'compile:step',
      phase,
      step: step.number,
      ...(typeof line === 'number' && line > 0 && { line }),
      message,
    });
  };

  /**
   * What this step's entry threw last time, or undefined when it did not.
   *
   * Two sources, and which one is available depends on the mode:
   *
   * - **`'run'`** — the entry ran in THIS run, threw, and the step healed
   *   under AI, so the failure arrives in band on the step result. Freshest,
   *   and it wins.
   * - **`'steps'`** — code-behind execution is disabled for the request (that
   *   is what makes the step re-record under AI), so the entry never runs and
   *   never throws. There is no in-band failure to have. The last-run sidecar
   *   on disk is where the ⚠ the author is looking at came from, and it is the
   *   only record of what broke.
   *
   * Neither means no prior failure: generate normally.
   */
  private async priorFailure(
    binding: CodeBehindBinding,
    result: StepResult,
  ): Promise<string | undefined> {
    if (result.codeBehindStale) return result.codeBehindStale.error;
    const rows = await this.lastRunRows();
    // Matched by the identity the binding uses — section scope, authored text,
    // and the occurrence of that pair — because a body that says the same
    // thing twice has two rows and only one of them failed. The target file
    // joins the match where both sides carry it: a skill-body step and a
    // test-frame step can share text and (empty) section, and without the
    // file the repair could be fed the other one's failure. A row written
    // before the field existed matches as it always did.
    const want = fileKey(binding.file);
    const same = rows.filter(
      (r) =>
        (r.section ?? '') === (binding.section ?? '') &&
        r.source === binding.source &&
        (r.file === undefined || fileKey(r.file) === want),
    );
    const row = same[binding.occurrence];
    return row?.stale ? (row.error ?? 'the entry failed on the last run') : undefined;
  }

  /** The last-run sidecar's rows, read once per compile. */
  private async lastRunRows(): Promise<LastRunStep[]> {
    if (this.lastRun === undefined) {
      this.lastRun = readLastRun(this.options.testFilePath)
        .then((s) => s?.steps ?? [])
        .catch(() => []);
    }
    return this.lastRun;
  }

  /**
   * One model call for one step: a repair when the step is healing a broken
   * entry, a plain generation otherwise.
   *
   * The repair branch is the parity the boxed pipeline has always had. A step
   * whose entry threw ran under AI *because it threw*, and generating from the
   * plain prompt hands the model the same page and lets it write the same
   * broken selector again — which is exactly what happened live: a recorded
   * `a[href="/login"]` click compiled to a strict locator that resolved to 2
   * elements, healed under AI, and regenerated identically. The repair prompt
   * shows it the code that failed and what it threw. Where the failure comes
   * from depends on the mode — see `priorFailure`.
   */
  private async askModel(step: CompileStep, input: LiveStepInput): Promise<GeneratedEntry> {
    const binding = step.binding!;
    const failed = await this.priorFailure(binding, input.result);
    if (failed !== undefined) {
      const repaired = await this.askForRepair(step, input, failed);
      if (repaired) return repaired;
      // No entry text to repair FROM — the file was edited, or the span could
      // not be found. Fall through and generate as if from scratch.
    }
    return generateStepEntry({
      binding,
      actions: actionsOf(input.result),
      ...(input.result.assertions && { assertions: input.result.assertions }),
      resolvedParameters: input.resolvedParameters,
      ...(this.options.envData && { envData: this.options.envData }),
      aiClient: this.options.aiClient,
      contextContent: this.options.contextContent,
      testName: this.options.testName,
      ...(this.options.baseUrl !== undefined && { baseUrl: this.options.baseUrl }),
      wholeTest: this.plan.map((p, i) => ({
        index: i + 1,
        text: p.text,
        inScope: p.inScope,
        isThisStep: i === step.index,
      })),
      candidateFile: (await this.candidate.read(binding.file)) ?? undefined,
      ...contextOf(input.result),
    });
  }

  /**
   * Regenerate a stale step from its failure, through the same repair prompt
   * the boxed pipeline's replay rounds use. Null when the failed entry's text
   * cannot be recovered, which leaves the caller to generate normally.
   *
   * The pre-checks mirror `generateStepEntry`'s own: a transcript that changed
   * runner state, or a reference this run cannot answer, declines here too —
   * a repair is still a generation and the same things make it impossible.
   */
  private async askForRepair(
    step: CompileStep,
    input: LiveStepInput,
    error: string,
  ): Promise<GeneratedEntry | null> {
    const binding = step.binding!;
    const file = await this.candidate.read(binding.file);
    if (file === null) return null;
    const entryCode = entryTextIn(file, binding.source, binding.section, binding.occurrence);
    if (entryCode === undefined) return null;

    const refused = refuseReason(binding.source, actionsOf(input.result));
    if (refused) return { kind: 'declined', reason: refused };
    const envRefs = stepEnvRefs(binding, this.options.envData);
    if (envRefs.unresolved.length > 0) {
      return {
        kind: 'declined',
        reason: unresolvedRefsReason(envRefs.unresolved, this.options.envData),
      };
    }

    const parameters = stepParameters(binding, input.resolvedParameters, this.options.envData);
    const ctx = input.result.stepContext;
    const prompt = buildRepairPrompt({
      rawStepText: step.text,
      stepIndex: step.number,
      entryCode,
      error,
      // The page BEFORE the step is the page the entry threw on: the entry
      // runs first, and the AI heal that follows is what moved it on.
      ...(ctx?.domBefore !== undefined && { dom: ctx.domBefore }),
      ...(ctx?.urlBefore !== undefined && { url: ctx.urlBefore }),
      parameters,
      ...(envRefs.resolved.length > 0 && { envRefs: envRefs.resolved }),
    });
    return askForEntry(
      this.options.aiClient,
      this.options.contextContent,
      prompt,
      guardedValues(parameters, envRefs.resolved),
      this.signal,
    );
  }

  private async generate(step: CompileStep, input: LiveStepInput): Promise<void> {
    // A stopped run skips what has not started. The in-flight one finishes:
    // its model call is already paid for, and its entry is work the author
    // asked for.
    if (this.disposed || this.signal?.aborted) {
      this.skippedByStop.push(step.number);
      // Still progress: the entry is settled, in the only way a stopped one
      // can be. Without this the bar stalls one short for every skip.
      this.emitProgress('generate');
      return;
    }
    // BEFORE the model call, which is the whole point: the completion frame
    // below arrives one model call later, and that gap is the silence this
    // story exists to fill.
    //
    // The structured frame LEADS the prose, and the order is load-bearing: a
    // client tells a current server from an older one by whether any
    // `compile:progress` has arrived, and generation starts while the run is
    // still executing later steps. Emit the prose first and the client sees a
    // `compile:step` with no progress yet, reads it as an older server, and
    // raises its tail UI mid-run — which is exactly the state the run's own
    // steps are already reporting.
    this.emitProgress('generate', { step: step.number, line: this.plan[step.index]?.line });
    this.stepEvent('generate', step, 'generating…');
    const generated = await this.askModel(step, input);
    const applied = await applyGenerated(this.candidate, step, generated, this.stepEvent, 'generate');
    if (applied.kind === 'entry') this.compiled.push(step.number);
    else if (applied.kind === 'declined') this.declined.push(step.number);
    else {
      // A generation error must never abort the run — a run cannot fail over
      // its own bookkeeping. The step stays AI with no entry written, a note
      // says why, and the next compile's default selection takes it again.
      // (The boxed Generate phase fails the whole compile here; this path
      // deliberately does not.)
      this.errors++;
      this.stepEvent('generate', step, `no entry: ${applied.message}`);
      this.note?.(
        `Code-behind generation failed for step ${step.number}: ${applied.message}. ` +
          'The step stays AI; nothing was written for it.',
        'warn',
      );
    }
    this.emitProgress('generate');
  }

  /**
   * Drain the queue, run Review (on the Run & Compile path only), and hand
   * back the proposal. The server never writes under the project on this
   * path: the files ride the wire and TestBench applies them through the diff.
   */
  async finish(final: LiveCompileFinish): Promise<LiveCompileOutcome> {
    await this.tail.catch((err: unknown) => {
      logger.warn(`Code-behind generation queue failed: ${String(err)}`);
    });

    // A split run finishes once per block, so the reviewer would otherwise be
    // asked to re-read a file it has already passed. It only sees a file whose
    // content has actually changed since it last saw it.
    const unreviewed = this.candidate
      .touchedFiles()
      .filter((f) => this.reviewed.get(f) !== this.candidate.contentOf(f));
    if (this.options.mode === 'run' && !final.aborted && unreviewed.length > 0) {
      this.emitProgress('review');
      await reviewCandidate(
        this.candidate,
        {
          markdownName: path.basename(this.options.testFilePath),
          steps: this.plan.map((p) => p.text),
          guarded: this.guardedValues(),
          aiClient: this.options.aiClient,
          ...(this.signal && { signal: this.signal }),
        },
        (message) => {
          this.emit({
            type: 'compile:step',
            phase: 'review',
            step: 0,
            message,
          });
        },
        unreviewed,
      );
      for (const file of unreviewed) {
        const after = this.candidate.contentOf(file);
        if (after !== undefined) this.reviewed.set(file, after);
      }
    }
    // The candidate on disk, and where it went: the notification's "Open
    // candidate" action exists for exactly this path, and a summary that never
    // carried it left the button with nothing to open.
    const candidatePath = await this.candidate.persist();

    const files = this.candidate.changedFiles();
    const notAttempted = [...new Set([...(final.notAttempted ?? []), ...this.skippedByStop])].sort(
      (a, b) => a - b,
    );
    const nothingToDo = this.attempted === 0 && final.stoppedAt === undefined && !final.aborted;
    const summary: CompileSummary = {
      test: this.options.testFilePath,
      totalSteps: this.scopedTotal,
      compiled: this.compiled.length,
      kept: this.kept,
      keptAi: this.keptAiExisting + this.declined.length,
      rounds: 0,
      tokensUsed: final.tokensUsed,
      written: [],
      // Every entry this path produces is born unproven: there is no Replay,
      // and the author's next ordinary run is the proof.
      unproven: [...this.compiled].sort((a, b) => a - b),
      writtenOffAi: [],
      notAttempted,
      recordingDir: recordingDirFor(this.options.testFilePath),
      ...(candidatePath !== undefined && { candidatePath }),
      ...(final.stoppedAt && { stoppedAt: final.stoppedAt }),
      ...(this.errors > 0 && {
        error: `${this.errors} step(s) could not be generated; they stay AI`,
      }),
    };
    return {
      // `green` would claim the test compiles and replays as code, which
      // nothing here proved. Anything this path writes is unproven, so a pass
      // that produced entries is `partial` — which is also what puts ◐ and
      // "the next run proves them" in front of the author.
      status: nothingToDo ? 'green' : 'partial',
      files,
      summary,
    };
  }

  /** Every value the review's revision must not inline: the run's parameters
   *  and the environment references its steps make, resolved. */
  private guardedValues(): Array<{ name: string; value: string }> {
    const out = Object.entries(this.parameters).map(([name, value]) => ({ name, value }));
    const envData = this.options.envData;
    if (!envData) return out;
    const seen = new Set<string>();
    for (const { text } of this.plan) {
      for (const ref of envDataRefsIn(text)) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        const value = resolveEnvDataRef(ref, envData);
        if (value !== undefined) out.push({ name: `\${${ref}}`, value });
      }
    }
    return out;
  }
}

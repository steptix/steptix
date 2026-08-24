import path from 'node:path';
import type { AiClient } from '../ai/client.js';
import type { StepResult, StepStatus } from '../report/types.js';
import {
  envDataRefsIn,
  resolveEnvDataRef,
  type EnvDataContext,
} from '../parser/interpolate-env-data.js';
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
import { generateStepEntry } from './generate.js';
import type { CodeBehindBinding } from './loader.js';
import { recordingDirFor } from './recording.js';
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
  plan: Array<{ text: string; inScope: boolean }>;
  /** 1-based source line per 0-based expanded index, for the gutter. */
  sourceLines?: (number | undefined)[] | undefined;
  /** The run's abort signal. A stop skips generations not yet started. */
  signal?: AbortSignal | undefined;
  emit: (event: LiveCompileStepEvent) => void;
  /** Something the author should know that belongs to no step. */
  note?: ((message: string, level: 'info' | 'warn') => void) | undefined;
}

/** One finished step, offered to the compiler as the run moves on. */
export interface LiveStepInput {
  /** 0-based expanded index. */
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
  if (BRACKET_CALL_STEP.test(input.text.trim())) {
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

/** `[skill:` and `[tool:` only. `[input:]`, `[output:]` and `[interactive]`
 *  DO reach generation and are declined there, with the reason, by
 *  `refuseReason` — the difference is that those are still the author's step
 *  and deserve an `ai: true` entry saying why. */
const BRACKET_CALL_STEP = /^\[\s*(skill|tool)\s*:/i;

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
  /** The most recent parameter snapshot, for the review's leak guard. */
  private parameters: Record<string, string> = {};

  constructor(private readonly options: LiveCompileOptions) {}

  /** True when at least one step is queued or already generated. */
  get attempted(): number {
    return this.compiled.length + this.declined.length + this.errors;
  }

  /**
   * Offer a finished step. Returns immediately — the browser never waits on
   * generation. Called for EVERY step, eligible or not, so the summary can
   * say how many were kept as code and how many were already AI.
   */
  offer(input: LiveStepInput): void {
    const text = input.binding?.source ?? this.options.plan[input.index]?.text ?? input.result.instruction;
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
    this.parameters = input.resolvedParameters;
    const step: CompileStep = {
      index: input.index,
      number: input.index + 1,
      text,
      binding: input.binding,
      key: entryKeyOf(input.binding!),
      hasEntry: input.binding!.entry !== undefined,
      isAiEntry: false,
    };
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
        this.options.note?.(
          `Code-behind generation failed for step ${step.number}: ${message}. ` +
            'The step stays AI; nothing was written for it.',
          'warn',
        );
      });
  }

  private stepEvent = (phase: CompilePhase, step: CompileStep, message: string): void => {
    const line = this.options.sourceLines?.[step.index];
    this.options.emit({
      type: 'compile:step',
      phase,
      step: step.number,
      ...(typeof line === 'number' && line > 0 && { line }),
      message,
    });
  };

  private async generate(step: CompileStep, input: LiveStepInput): Promise<void> {
    // A stopped run skips what has not started. The in-flight one finishes:
    // its model call is already paid for, and its entry is work the author
    // asked for.
    if (this.options.signal?.aborted) {
      this.skippedByStop.push(step.number);
      return;
    }
    const generated = await generateStepEntry({
      binding: step.binding!,
      actions: actionsOf(input.result),
      ...(input.result.assertions && { assertions: input.result.assertions }),
      resolvedParameters: input.resolvedParameters,
      ...(this.options.envData && { envData: this.options.envData }),
      aiClient: this.options.aiClient,
      contextContent: this.options.contextContent,
      testName: this.options.testName,
      ...(this.options.baseUrl !== undefined && { baseUrl: this.options.baseUrl }),
      wholeTest: this.options.plan.map((p, i) => ({
        index: i + 1,
        text: p.text,
        inScope: p.inScope,
        isThisStep: i === step.index,
      })),
      candidateFile: (await this.candidate.read(step.binding!.file)) ?? undefined,
      ...contextOf(input.result),
    });
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
      this.options.note?.(
        `Code-behind generation failed for step ${step.number}: ${applied.message}. ` +
          'The step stays AI; nothing was written for it.',
        'warn',
      );
    }
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

    if (this.options.mode === 'run' && !final.aborted && this.candidate.touchedFiles().length > 0) {
      await reviewCandidate(
        this.candidate,
        {
          markdownName: path.basename(this.options.testFilePath),
          steps: this.options.plan.map((p) => p.text),
          guarded: this.guardedValues(),
          aiClient: this.options.aiClient,
          ...(this.options.signal && { signal: this.options.signal }),
        },
        (message) => {
          this.options.emit({
            type: 'compile:step',
            phase: 'review',
            step: 0,
            message,
          });
        },
      );
    }
    await this.candidate.persist();

    const files = this.candidate.changedFiles();
    const notAttempted = [...new Set([...(final.notAttempted ?? []), ...this.skippedByStop])].sort(
      (a, b) => a - b,
    );
    const nothingToDo = this.attempted === 0 && final.stoppedAt === undefined && !final.aborted;
    const summary: CompileSummary = {
      test: this.options.testFilePath,
      totalSteps: this.options.plan.length,
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
    for (const { text } of this.options.plan) {
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

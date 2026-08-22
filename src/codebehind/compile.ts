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
  spliceEntry,
  validateCodeBehindSource,
  writeCodeBehindFile,
  type WriteEntryRequest,
} from './writer.js';
import { findInlinedParameterValue } from '../ai/action-parser.js';

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
  /** Something happened to one step, 1-based. */
  | { kind: 'step'; phase: CompilePhase; step: number; message: string }
  /** Terminal. Always emitted exactly once. */
  | { kind: 'done'; status: CompileStatus; message: string };

export type CompileStatus = 'green' | 'failed';

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
  /** Replay rounds before a step is written off as AI. Default 3. */
  maxRounds?: number | undefined;
  /** Run everything but Write. */
  dryRun?: boolean | undefined;
  /** A green run to compile from, instead of recording a fresh one. */
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

  const tokens = (): number => (options.tokenTracker?.total ?? 0) + runTokens;
  const finish = (
    status: CompileStatus,
    summary: Omit<CompileSummary, 'test' | 'totalSteps' | 'tokensUsed' | 'rounds'>,
    message: string,
  ): CompileResult => {
    emit({ kind: 'done', status, message });
    return {
      status,
      files: status === 'green' ? candidate.changedFiles() : {},
      summary: {
        test: test.filePath,
        totalSteps: test.steps.length,
        rounds,
        tokensUsed: tokens(),
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
  const selection = selectSteps(steps, options.select ?? {}, staleKeys);
  if (selection.errors.length > 0) {
    return finish(
      'failed',
      { compiled: 0, kept: 0, keptAi: 0, written: [], error: selection.errors[0]! },
      selection.errors[0]!,
    );
  }
  const keptAiExisting = steps.filter((s) => s.isAiEntry).length;
  const keptExisting = steps.filter(
    (s) => s.hasEntry && !s.isAiEntry && s.key !== undefined && !selection.keys.has(s.key),
  ).length;
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
  let record = options.recorded;
  if (record) {
    emit({ kind: 'phase', phase: 'record', message: 'reusing the supplied run' });
  } else {
    emit({ kind: 'phase', phase: 'record', message: `running ${test.steps.length} step(s) under AI` });
    record = await runner({
      purpose: 'record',
      strict: false,
      captureContext: true,
      // Under AI, all of it. A step served by its existing entry produces no
      // transcript, and generation would have nothing to work from.
      disableCodeBehind: true,
      ...(options.signal && { signal: options.signal }),
    });
    runTokens += record.tokensUsed;
  }
  if (record.status !== 'passed') {
    const failed = record.steps.find((s) => s?.status === 'failed');
    const detail = failed ? ` — step ${failed.index}: ${failed.error ?? 'failed'}` : '';
    return finish(
      'failed',
      {
        compiled: 0,
        kept: keptExisting,
        keptAi: keptAiExisting,
        written: [],
        error: `the recording run did not pass${detail}`,
      },
      `Record failed${detail}. There is nothing to compile until the test passes under AI.`,
    );
  }

  // ─── 3. Generate ──────────────────────────────────────────────────────────
  emit({ kind: 'phase', phase: 'generate', message: `${selection.order.length} step(s)` });
  let declined = 0;
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
    const applied = applyGenerated(candidate, step, generated, emit, 'generate');
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

  // ─── 4. Review ────────────────────────────────────────────────────────────
  await reviewCandidate(candidate, test, options, emit);

  // ─── 5. Replay ────────────────────────────────────────────────────────────
  let green = false;
  let lastFailure: { step: CompileStep; error: string; result?: StepResult | undefined } | undefined;

  for (let round = 1; round <= maxRounds; round++) {
    rounds = round;
    const overrides = await candidate.materialise();
    const outcome = await runner({
      purpose: 'replay',
      round,
      strict: true,
      captureContext: false,
      candidateFiles: overrides,
      ...(options.signal && { signal: options.signal }),
    });
    runTokens += outcome.tokensUsed;
    await candidate.clearMaterialised();

    if (outcome.status === 'passed') {
      emit({ kind: 'phase', phase: 'replay', round, message: `${test.steps.length}/${test.steps.length} passed as code` });
      green = true;
      break;
    }

    const failedAt = outcome.steps.findIndex((s) => s?.status === 'failed');
    const failedStep = failedAt >= 0 ? steps[failedAt] : undefined;
    const failedResult = failedAt >= 0 ? outcome.steps[failedAt] : undefined;
    const error = failedResult?.error ?? 'the run failed without naming a step';
    emit({
      kind: 'phase',
      phase: 'replay',
      round,
      message: failedStep ? `✗ step ${failedStep.number} — ${error}` : `✗ ${error}`,
    });

    if (!failedStep || !failedStep.key) {
      return finish(
        'failed',
        {
          compiled: selection.order.length,
          kept: keptExisting,
          keptAi: keptAiExisting + declined,
          written: [],
          candidatePath: await candidate.persist(),
          error,
        },
        `Replay failed and no step owns the failure: ${error}`,
      );
    }

    // A failure on an entry the author owns is not the compiler's to rewrite.
    if (!selection.keys.has(failedStep.key)) {
      return finish(
        'failed',
        {
          compiled: selection.order.length,
          kept: keptExisting,
          keptAi: keptAiExisting + declined,
          written: [],
          candidatePath: await candidate.persist(),
          error: `existing entry for step ${failedStep.number} fails`,
        },
        `existing entry for step ${failedStep.number} fails; recompile it with ` +
          `\`--steps ${failedStep.number}\` (or Compile This Step)`,
      );
    }

    lastFailure = { step: failedStep, error, result: failedResult };
    if (round === maxRounds) break;

    emit({ kind: 'step', phase: 'repair', step: failedStep.number, message: 'regenerating from the failure' });
    const repaired = await repairStep(failedStep, error, failedResult, record, options, candidate, {
      number: round,
      max: maxRounds,
    });
    const applied = applyGenerated(candidate, failedStep, repaired, emit, 'repair');
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
          error: `repair failed for step ${failedStep.number}: ${applied.message}`,
        },
        `Repair failed at step ${failedStep.number}: ${applied.message}`,
      );
    }
  }

  // A step that failed every round is written off: `ai: true` with the last
  // error as its comment, then one round to confirm the rest still passes.
  if (!green && lastFailure) {
    const { step, error } = lastFailure;
    emit({
      kind: 'step',
      phase: 'replay',
      step: step.number,
      message: `kept as AI after ${maxRounds} round(s): ${error}`,
    });
    candidate.apply(step, aiEntryFor(step.text, `replay kept failing — ${error}`));
    declined++;
    rounds++;
    const overrides = await candidate.materialise();
    const outcome = await runner({
      purpose: 'replay',
      round: rounds,
      strict: true,
      captureContext: false,
      candidateFiles: overrides,
      ...(options.signal && { signal: options.signal }),
    });
    runTokens += outcome.tokensUsed;
    await candidate.clearMaterialised();
    green = outcome.status === 'passed';
    emit({
      kind: 'phase',
      phase: 'replay',
      round: rounds,
      message: green
        ? `${test.steps.length}/${test.steps.length} passed (step ${step.number} under AI)`
        : `✗ still failing after keeping step ${step.number} as AI`,
    });
  }

  const compiled = selection.order.length - declined;
  if (!green) {
    return finish(
      'failed',
      {
        compiled,
        kept: keptExisting,
        keptAi: keptAiExisting + declined,
        written: [],
        candidatePath: await candidate.persist(),
        error: lastFailure ? lastFailure.error : 'replay never went green',
      },
      'Replay never went green — nothing was written.',
    );
  }

  // ─── 6. Write ─────────────────────────────────────────────────────────────
  const files = candidate.changedFiles();
  if (options.dryRun) {
    emit({ kind: 'phase', phase: 'write', message: 'dry run — nothing written' });
    return finish(
      'green',
      { compiled, kept: keptExisting, keptAi: keptAiExisting + declined, written: [] },
      'Compiled (dry run) — nothing written.',
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
          keptAi: keptAiExisting + declined,
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
  await candidate.discardPersisted();
  // The flag the author acted on has been acted on. Leaving it set would make
  // the next `--only-stale` regenerate the same steps for no reason.
  await clearStale(
    test.filePath,
    steps.filter((s) => s.key && selection.keys.has(s.key)).map((s) => s.number),
  );
  return finish(
    'green',
    { compiled, kept: keptExisting, keptAi: keptAiExisting + declined, written },
    `Compiled ${test.title}: ${compiled} step(s) as code, ${keptAiExisting + declined} kept AI.`,
  );
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

/** Identifies the entry a step binds to. Two inlinings of one body share it. */
function entryKeyOf(binding: CodeBehindBinding): string {
  return `${binding.file} ${binding.section ?? ''} ${binding.source} ${binding.occurrence}`;
}

/**
 * Keys of entries a run flagged as stale.
 *
 * Normally that is the last-run sidecar — the author ran the test, saw a ⚠,
 * and came here. Compile's own Record cannot contribute: it deliberately runs
 * with code-behind off, so no entry gets the chance to fail. A supplied run
 * ("Compile from this run") can, because that one did use code-behind.
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
  emit: (event: CompileEvent) => void,
  phase: CompilePhase,
): GeneratedEntry {
  try {
    if (generated.kind === 'entry') {
      candidate.apply(step, generated.code);
      emit({
        kind: 'step',
        phase,
        step: step.number,
        message: phase === 'repair' ? 'repaired' : 'generated',
      });
    } else if (generated.kind === 'declined') {
      candidate.apply(step, aiEntryFor(step.text, generated.reason));
      emit({ kind: 'step', phase, step: step.number, message: `kept as AI: ${generated.reason}` });
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

    const leaked = findInlinedParameterValue(revised, allParameters(test));
    if (leaked) {
      emit({
        kind: 'phase',
        phase: 'review',
        message: `rejected: the revision inlines {{${leaked}}} — the generated file stands`,
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

/** Every parameter value in play, for the review's leak guard. Unlike the
 *  per-step guard this is deliberately broad: a whole-file rewrite can move a
 *  literal into any entry, so the check has to cover them all. */
function allParameters(test: ParsedTest): Array<{ name: string; value: string }> {
  return Object.entries(test.parameters).map(([name, value]) => ({ name, value }));
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
   * Leave the candidate on disk for salvage after a red compile, at the path
   * the story names, and return the first one (what the summary points at).
   */
  async persist(): Promise<string | undefined> {
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
        logger.debug(`Could not leave the compile candidate at ${target}: ${String(err)}`);
      }
    }
    return this.persisted[0];
  }

  /** Drop a candidate from an earlier red compile once a green one has
   *  written the real files — otherwise it reads as current and is not. */
  async discardPersisted(): Promise<void> {
    for (const file of this.current.keys()) {
      const target = path.join(
        resolveCodeBehindCacheDir(file),
        `${path.basename(file)}.candidate`,
      );
      await fs.rm(target, { force: true }).catch(() => {});
    }
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
        // A fresh copy per run: `runTest` writes captured values into this map,
        // and a replay must not start with the record's leftovers.
        resolvedParameters: { ...options.test.parameters },
      },
      options.config,
      options.contextContent,
      undefined,
      {
        ...(request.candidateFiles && { codeBehindCandidates: request.candidateFiles }),
        ...(request.disableCodeBehind && { codeBehindDisabled: true }),
        codeBehindStrict: request.strict,
        captureStepContext: request.captureContext,
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

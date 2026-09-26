import path from 'node:path';
import type { AiClient } from '../ai/client.js';
import type { StepResult, StepStatus } from '../report/types.js';
import {
  envDataRefsIn,
  resolveEnvDataRef,
  type EnvDataContext,
} from '../parser/interpolate-env-data.js';
import { isCodeStep } from '../parser/invocation-parser.js';
import { parseFlowControlStep } from '../parser/flow-control-step.js';
import { parseControlLine } from '../parser/control-line.js';
import { parseSetStep } from '../parser/set-step.js';
import { parseUseAiStep, parseUseStep } from '../parser/use-step.js';
import { logger } from '../utils/logger.js';
import { runSecrets } from '../utils/secrets.js';
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
  anyActionCarriesPlaceholder,
  askWithCaptureRetry,
  capturedValueGuards,
  compilableCondition,
  generateConditionEntry,
  generateStepEntry,
  guardedValues,
  loopContextFor,
  recordedCapturesOf,
  refuseReason,
  SET_STEP_NOT_COMPILED,
  SURFACE_SWITCH_NOT_COMPILED,
  USE_AI_NOT_COMPILED,
  stepEnvRefs,
  stepParameters,
  unresolvedRefsReason,
  valueMatchWarning,
  type ConditionObservation,
  type GeneratedEntry,
} from './generate.js';
import type { StepCodeEntry } from './types.js';
import { isConditionCode, isStepCode } from './execute.js';
import { buildRepairPrompt, type RepairPromptInput } from './repair.js';
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
  /**
   * The framework performs this step itself, so it is not a step a compile
   * could ever write — a control line's guard, which is dispatched rather than
   * executed (stories/control-flow.md, decision 12).
   *
   * Separate from `inScope: false`, which a step that already HAS an entry
   * also carries: that step is one this compile could write and is choosing
   * not to, and the summary's denominator has always counted it. A dispatched
   * step is not in the denominator at all, or a two-branch chain reports
   * "2 of 4" for a test with two compilable steps in it.
   */
  dispatched?: boolean | undefined;
  /** 1-based source line, for the gutter and the run log. */
  line?: number | undefined;
  /**
   * The innermost runtime loop — `While`, `Repeat … until`, `For each` — this
   * step sits in the body of (stories/codebehind-loops-and-conditions.md,
   * decision 2): the loop's AUTHORED guard line, and for a `For each` the item
   * name the run binds, which a skill body renames (`__skill1_order`). Static,
   * from the expansion's control records; the per-pass names are read off the
   * evidence pass when the step is generated (`loopContextFor`). Absent
   * outside every runtime loop, and for a table-row `### Section` loop, which
   * is unrolled rather than run.
   */
  loop?: { line: string; runtimeItem?: string | undefined } | undefined;
}

/**
 * Does this line already have an entry of ITS kind?
 * (stories/codebehind-loops-and-conditions.md — "make the live path's
 * `hasEntry` kind-aware").
 *
 * A condition line's entry is a `condition`; every other line's is a `run`.
 * An entry of the other kind is in the wrong place — the runtime warns once
 * and runs the line under AI — so it is not an entry this compile should
 * leave alone: the line is in scope, and the generated entry replaces it. An
 * `ai: true` entry is the author's opt-out on either kind of line.
 */
export function hasEntryOfKind(entry: StepCodeEntry | undefined, line: 'step' | 'condition'): boolean {
  if (entry === undefined) return false;
  if (entry.ai === true) return true;
  return line === 'condition' ? isConditionCode(entry) : isStepCode(entry);
}

/** How many of these steps a compile counts — everything it did not dispatch. */
function countable(entries: readonly PlanEntry[]): number {
  return entries.reduce((n, entry) => n + (entry.dispatched === true ? 0 : 1), 0);
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
  /**
   * Why a `status: 'skipped'` row never ran — the CAUSE, structurally, so
   * nothing downstream has to read it out of the row's prose:
   *
   * - `'return'` — a return ended its flow (stories/step-flow-control.md,
   *   decision 12). What an absent field means too, for a caller written
   *   before the second cause existed.
   * - `'decision'` — the run decided against it: an untaken branch, a loop
   *   that ran no passes, an exhausted or empty `For each`
   *   (stories/codebehind-loops-and-conditions.md, decision 12; issue 053).
   */
  skipped?: 'return' | 'decision' | undefined;
}

/**
 * One visit to a guard, offered to the compiler (`offerGuard`) — the evidence
 * a `condition` entry is generated from
 * (stories/codebehind-loops-and-conditions.md, "Live compile").
 */
export interface LiveGuardInput {
  /**
   * Every member ASKED on this visit, in chain order — a loop's guard alone
   * for a `While` / `Repeat`. 0-based expanded indices WITHIN THE CURRENT
   * BLOCK, in the same index space as the row's `guard.selected`,
   * `guard.staleMember` and `guard.evidence.members`. Each with its binding
   * from the generation registry, which is where the authored line comes from.
   */
  members: Array<{ index: number; binding?: CodeBehindBinding | undefined }>;
  /** The guard row. `result.guard` carries the structured decision and, on a
   *  compiling run where the model decided, the page it decided on. */
  result: StepResult;
  /** A SNAPSHOT of the live parameter map at the visit. */
  resolvedParameters: Record<string, string>;
  /** The surface the visit was judged on. A condition judged on the computer
   *  surface stays AI (decision 10): no DOM, and a screen read is not portable. */
  surface?: 'browser' | 'computer' | undefined;
}

/** What the compiler keeps about one condition LINE across its visits. */
interface GuardAccumulator {
  key: string;
  /** Absolute 0-based expanded index of the line — its first visit's. */
  index: number;
  binding: CodeBehindBinding;
  /** The first held, first not-held and first not-asked observation, each
   *  with the parameter snapshot of its visit (decision 9). */
  observations: Array<ConditionObservation & { parameters: Record<string, string> }>;
  /** The LATEST error its condition entry produced on this run — what a
   *  repair is shown. */
  stale?: string | undefined;
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
  /**
   * Where the run ENDED because a step's own text said to — the `fail` verb
   * (stories/step-failure-outcomes.md, decisions 1–3).
   *
   * The loop passes this INSTEAD of `stoppedAt`, never as well: every renderer
   * downstream words itself off which one arrived, and a deliberate failure in
   * `stoppedAt` is how a Run & Compile came to tell an author to fix a step that
   * did exactly what its line says. No `line`, because the compiler reads the
   * authored text off the plan and cannot then be handed a line that disagrees.
   */
  endedAsWritten?: { step: number; error: string } | undefined;
  /** 1-based expanded steps the run never reached. */
  notAttempted?: number[] | undefined;
  /** The run was stopped by the client. */
  aborted?: boolean | undefined;
}

/**
 * A step a return left unrun (stories/step-flow-control.md, decision 12).
 *
 * Its own reason, rather than the general "did not pass": a skipped step did
 * not fail, it never ran, and the two lead an author to different places. It is
 * also the string `offer` keys its `notAttempted` bookkeeping off, which is why
 * it is a const rather than a literal in two places.
 */
export const SKIPPED_BY_RETURN_REFUSAL = 'the step did not run — a return ended its flow';

/**
 * A step the run DECIDED not to take — an untaken branch of a chain, the body
 * of a loop that ran no passes, an exhausted or empty `For each`
 * (stories/codebehind-loops-and-conditions.md, decision 12; closes issue 053).
 *
 * The sibling of {@link SKIPPED_BY_RETURN_REFUSAL}, and kept apart from it for
 * the author's sake: "a return ended its flow" sends them to the step that
 * returned, while this one says the run chose a different path, so the step
 * needs a run that goes down it. Chosen by the offer's `skipped` cause, never
 * by reading the row's prose.
 */
export const SKIPPED_BY_DECISION_REFUSAL = 'the step did not run — the run decided against it';

/**
 * A step that failed and whose own `otherwise continue` tail let the run past it
 * (stories/step-failure-outcomes.md, decision 11).
 *
 * Its own reason, on the fact opposite {@link SKIPPED_BY_RETURN_REFUSAL}'s: this
 * step DID run, and what it produced is a recording of a failure, so it is no
 * evidence either. Shared with the boxed pipeline so the two compilers say one
 * sentence about one situation.
 */
export const TOLERATED_FAILURE_REFUSAL =
  'the step failed on the recording run and was tolerated (otherwise continue)';

/**
 * The same tolerated failure, on a step whose OWN entry ran it
 * (stories/step-failure-outcomes.md, decision 11).
 *
 * The fact the sentence above cannot carry: this step HAS an entry, and the failure
 * the run tolerated is the one that entry reported. Nothing to generate and nothing
 * missing, so it counts `kept` rather than landing in `notAttempted` — "not
 * attempted" over a line whose code sits in the author's file is the complaint this
 * reason answers. An entry that BROKE instead of asserting is unchanged: flagged
 * stale, it falls to {@link TOLERATED_FAILURE_REFUSAL} and is still owed one.
 */
export const TOLERATED_CODE_BEHIND_REFUSAL =
  'the step ran as code and its failure was tolerated (otherwise continue) — the entry stands';

/**
 * A step that EXECUTED on the computer surface (SPEC-use-computer.md §9).
 *
 * The other half of {@link SURFACE_SWITCH_NOT_COMPILED}, and a different rule
 * from it: that one is about the `[use …]` LINE, which performs nothing; this
 * one is about an ordinary step that happened to run while the surface was
 * `computer`. Its transcript is a list of screen coordinates, and a coordinate
 * is specific to one machine's resolution, scaling and window layout — so it
 * becomes an `ai: true` entry carrying this sentence rather than code that
 * would click somewhere plausible and wrong on the next machine.
 *
 * Judged from the RUN, never from the file: a shared `### Section` or a skill
 * body runs on whatever surface its caller was on.
 */
export const COMPUTER_MODE_STAYS_AI = 'computer-mode step; coordinates are not portable';

/**
 * The unconditional `Return` / `Stop` / `Fail` — a line the run loops dispatch
 * with no model call at all, as they dispatch `Set`
 * (stories/step-flow-control.md, decision 3; stories/step-failure-outcomes.md,
 * decision 10). No transcript to generate from, so both compilers refuse it and
 * both say this, from here, so an author meeting the refusal in `aiui compile`
 * and again in a Run & Compile reads one rule about one line.
 */
export const DISPATCHED_NOT_COMPILED = 'a Return/Stop/Fail step is dispatched, not compiled';

/** How much of the ending step's own line rides along on a reason string —
 *  `RETURNING_TEXT_LIMIT` in src/runner/flow-control.ts, to the same ceiling:
 *  long enough for a realistic `If … then fail the test with error "…"`, short
 *  enough that a log line stays one line. */
export const ENDING_TEXT_LIMIT = 80;

/** The ending step's authored line, clipped to {@link ENDING_TEXT_LIMIT}
 *  characters INCLUDING the ellipsis. */
export function clipLine(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > ENDING_TEXT_LIMIT
    ? `${trimmed.slice(0, ENDING_TEXT_LIMIT - 1)}…`
    : trimmed;
}

/**
 * The one sentence for a run that ended because a step's own text said to
 * (stories/step-failure-outcomes.md, decisions 1–3).
 *
 * Used by the record phase, the per-step lines, the headline and the summary's
 * reason, so a second spelling cannot drift — a private copy per compiler is how it
 * came to be missing from Run & Compile entirely. Deliberately NOT the vocabulary
 * of a stopped recording ("stopped at step 9", "fix that step"), which would send
 * an author to repair a step that did precisely what they wrote.
 */
export function endedAsWrittenReason(subject: 'run' | 'replay', step: number): string {
  return `the ${subject} ended at step ${step} as its text says`;
}

/**
 * Why a step is not generated from, or undefined when it is.
 *
 * Mirrors `compileTest`'s selection rules, decided per step from what the run
 * actually did rather than from the file alone:
 *
 * - **no binding** — nothing to write into; `[tool:]` and `[skill:]` markers
 *   are expanded or dispatched before the AI loop and are never generated.
 * - **an unconditional `Return` / `Stop` / `Fail`** — dispatched by the loop
 *   with no model call, as `Set` is, so there is nothing to record and nothing
 *   to make cheaper (stories/step-flow-control.md, decisions 3 and 11;
 *   stories/step-failure-outcomes.md, decision 10). The CONDITIONAL form of
 *   either is not refused: it compiles to `if (…) step.exit()` or
 *   `if (…) step.fail('…')`.
 * - **a `Set` step, and a `[use ai]` step** — both dispatched beside each
 *   other before the AI loop. `Set` has nothing to compile; `[use ai]` asks
 *   the model on every run by the author's choice (stories/use-ai-step.md,
 *   decision 1). Neither may become an `ai: true` entry, which is what the
 *   generator's "no page actions" decline would write.
 * - **skipped** — a return ended its flow before it ran, or the run decided
 *   against it (an untaken branch, a loop that ran no passes), so there is no
 *   transcript to generate from. Which of the two is the offer's `skipped`
 *   cause, and each has its own sentence.
 * - **tolerated** — it failed and its `otherwise continue` tail let the run
 *   carry on, so it has a transcript of the failure and no evidence of the step
 *   working (decision 11). Asked BEFORE "did not pass", because the status of a
 *   tolerated failure is `failed` and the general reason would send the author
 *   hunting a bug in a step whose text says it may fail.
 * - **did not pass** — a failed step's transcript is a recording of the
 *   failure; the boxed pipeline stops at the same place. One exception, the
 *   opposite of the tolerated case: a DELIBERATE failure is a step that did
 *   exactly what its text says (decisions 1–3), and its transcript holds the
 *   model's `fail` action the way a return's holds `return`, so refusing it
 *   would leave the one step this feature exists for permanently uncompiled.
 * - **ran as code** — it needs no transcript, because its code already is the
 *   answer. This is the default selection ("no entry, or flagged stale")
 *   falling out of run behaviour for free.
 * - **`ai: true`** — the author's opt-out. Deleting the entry undoes it.
 */
export function generationRefusal(input: {
  binding?: CodeBehindBinding | undefined;
  text: string;
  status: StepStatus;
  /** `StepResult.tolerated` — the step failed and the run continued past it
   *  (stories/step-failure-outcomes.md, decision 6). */
  tolerated?: boolean | undefined;
  /** `StepResult.deliberate` — the step failed because its own text says to
   *  (stories/step-failure-outcomes.md, decisions 1–3). */
  deliberate?: boolean | undefined;
  fromCodeBehind?: boolean | undefined;
  codeBehindStale?: unknown;
  /** `StepResult.surface` — which surface answered the step
   *  (SPEC-use-computer.md §9). Absent means `browser`. */
  surface?: 'browser' | 'computer' | undefined;
  /** Why a `skipped` step never ran — see {@link LiveStepInput.skipped}.
   *  Absent reads as a return, the one cause there was before decisions. */
  skipped?: 'return' | 'decision' | undefined;
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
  // Flow control is asked BEFORE the control line, because the two grammars
  // overlap on `If <condition>, then return` and flow control owns that line
  // (stories/control-flow.md §"Composition with `If … then return`"). Only
  // the UNCONDITIONAL form is refused: the conditional one compiles, into
  // `if (…) step.exit()` — or, for the `fail` verb, `if (…) step.fail('…')`
  // (stories/step-failure-outcomes.md, decision 10).
  const flowControl = parseFlowControlStep(input.text.trim());
  if (flowControl && flowControl.body === undefined) {
    return DISPATCHED_NOT_COMPILED;
  }
  // A control line, for the same reason: the framework asks a model whether a
  // condition holds and performs nothing, so there is no transcript to
  // generate a `run` entry from (stories/control-flow.md, decision 12). A
  // condition line's entry is a `condition`, generated from the page the
  // model decided on — which reaches the compiler through `offerGuard`, never
  // through here (stories/codebehind-loops-and-conditions.md). Belt and
  // braces — the run loops offer a guard only as a decision-skipped row,
  // which `offer` settles before asking this — but `offer` is public, and a
  // `run` entry generated for an `If` line would replace the decision with
  // code that acts.
  if (parseControlLine(input.text.trim())) {
    return 'a control line is dispatched, never generated';
  }
  // A surface switch, for the third time and the same reason
  // (SPEC-use-computer.md §9): `[use computer]` / `[use browser]` is a
  // run-loop signal that performs nothing on any surface, so there is no
  // transcript to generate an entry from. Belt and braces beside the two
  // above — the run loops never offer one — but `offer` is public, and a
  // generated entry for a `[use …]` line would replace the switch with code
  // that acts on the surface the test was leaving.
  if (parseUseStep(input.text)) {
    return SURFACE_SWITCH_NOT_COMPILED;
  }
  // A `[use ai]` step asks the model on every run, by the author's choice
  // (stories/use-ai-step.md, decision 1). Refused here, where it matters on
  // its own terms: past this function the step would reach `refuseReason`,
  // whose "no page actions" answer is DECLINED — written into the file as an
  // `ai: true` entry for a step that must never have one.
  if (parseUseAiStep(input.text)) {
    return USE_AI_NOT_COMPILED;
  }
  // …and `Set`, which was missing here and is the same missing check. The
  // boxed classifier (`describeSteps`) has always refused it; this one let a
  // passed Set step through to generation, where the transcript's empty
  // action list was declined and written as an `ai: true` entry — a
  // write-off for a step that costs nothing and never had a model call to
  // save (stories/variable-assignment.md, rule 8).
  if (parseSetStep(input.text)) {
    return SET_STEP_NOT_COMPILED;
  }
  // …and the other half of §9: an ORDINARY step that ran while the surface was
  // `computer`. Ahead of the binding check, because the answer does not depend
  // on there being a file to bind into — the step stays AI either way.
  if (input.surface === 'computer') return COMPUTER_MODE_STAYS_AI;
  if (!input.binding) return 'the step has no code-behind file to bind into';
  if (input.status === 'skipped') {
    return input.skipped === 'decision' ? SKIPPED_BY_DECISION_REFUSAL : SKIPPED_BY_RETURN_REFUSAL;
  }
  // Which of the two tolerated reasons depends on what ran it. An entry that ran
  // and reported the failure leaves nothing owed, so it answers AHEAD of the
  // "ran as code" rule below: behind it the step landed in `notAttempted` — the
  // list of lines with no entry — while its entry sat in the author's file. A
  // stale entry (it threw, and AI healed the step) is still owed one.
  if (input.tolerated === true) {
    return input.fromCodeBehind === true && !input.codeBehindStale
      ? TOLERATED_CODE_BEHIND_REFUSAL
      : TOLERATED_FAILURE_REFUSAL;
  }
  // A deliberate failure is a `failed` status that means the step WORKED, so it
  // is excused from the general rule rather than caught by it (decisions 1–3).
  // Everything below still applies to it.
  const asWritten = input.status === 'failed' && input.deliberate === true;
  if (input.status !== 'passed' && !asWritten) return 'the step did not pass';
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
  /**
   * Steps a return left unrun (stories/step-flow-control.md, decision 12).
   *
   * The same bookkeeping `skippedByStop` gets, for the same reason: an entry
   * that never got a transcript has to be NAMED in `notAttempted`, or the
   * author is left with a step that quietly has no entry and no explanation.
   * The difference is where the skip came from — a stop is the client's, a
   * return is the test's own — and both end with a step nobody recorded.
   *
   * Held as (step number, entry key) pairs rather than bare numbers because a
   * loop can answer both ways about ONE entry: iteration 1 runs the step and
   * generates from it, iteration 2 returns before reaching it. The entry then
   * exists, and naming iteration 2's expanded number as not-attempted would
   * tell the author a step has no entry when it has the one they just paid
   * for. `finish` drops the pairs whose key ended up WRITTEN (`writtenKeys`)
   * — not merely queued — the same rule the `kept` getter applies, for the
   * same reason.
   *
   * The OTHER skip producer — control flow's untaken branch, a loop that ran
   * no passes — files into {@link skippedByDecision}, by the offer's
   * `skipped` cause (issue 053, resolved).
   */
  private readonly skippedByReturn: { number: number; key: string }[] = [];
  /**
   * Steps the run DECIDED not to take — an untaken branch, a loop that ran no
   * passes, an exhausted or empty `For each`
   * (stories/codebehind-loops-and-conditions.md, decision 12; issue 053).
   *
   * Their own list for their own sentence ({@link SKIPPED_BY_DECISION_REFUSAL}),
   * netted exactly as {@link skippedByReturn} is: against `writtenKeys`, so a
   * body line one pass skipped and another pass compiled owes nothing, and a
   * condition line an outer decision skipped here but that was observed (and
   * written) on another visit owes nothing either.
   *
   * A step that already has an entry is NOT filed — decision 12 says it is
   * left exactly as it is — and it lands in no count at all beyond
   * `totalSteps`: not `kept` (its code did not run), not `keptAi`, not
   * `unproven`, and never `notAttempted`, which is the list of lines that end
   * the compile with no entry.
   */
  private readonly skippedByDecision: { number: number; key: string; guard?: boolean }[] = [];
  /** Entry keys whose "did not run" line has already gone out — at most once
   *  per entry, however many passes skip it (`offerDecisionSkip`). */
  private readonly saidDecisionSkip = new Set<string>();
  /**
   * Steps that failed and were tolerated (stories/step-failure-outcomes.md,
   * decision 11).
   *
   * The same (number, key) pairs and the same netting as `skippedByReturn`
   * above, for the same reason: a looped body is ONE entry and one row per
   * iteration, so an iteration tolerated after another compiled the body owes
   * nothing. Kept separate from `skippedByReturn` because the two are different
   * facts — one never ran, the other ran and failed — and the per-step line the
   * author reads has to say which.
   */
  private readonly toleratedFailures: { number: number; key: string }[] = [];
  /**
   * Entry keys this compile has already queued — the per-key dedupe the boxed
   * pipeline gets from `selectSteps` (compile.ts), which keeps a `keys` Set
   * and takes the first step per key.
   *
   * An entry is defined once and inlined many times: a looped `### Section`
   * runs its body once per row, and a data-driven run replays the whole flow
   * once per row. Every one of those expanded steps binds to the SAME entry —
   * `entryKeyOf` is (file, section, authored text, occurrence), and occurrence
   * restarts per frame instance — so generating from each of them would pay
   * for one model call per row and splice the same slot over and over. The
   * first occurrence to reach here generates (or declines, or repairs); every
   * later one is the same entry arriving again, and is skipped.
   *
   * WHICH iteration that is falls out of the refusals above the check rather
   * than out of arrival order: a clean code run is refused as "ran as code"
   * and takes no key at all, so the holder is the first iteration whose entry
   * BROKE (`codeBehindStale`) — or, when there is no entry yet, simply the
   * first. That is what keeps a repair fully paired: the code it reads, the
   * error it is given and the page it is shown all belong to one iteration,
   * for one model call.
   *
   * It is also the rule's one cost, and it is deliberate: an iteration that
   * breaks DIFFERENTLY later in the loop is skipped, so the entry is repaired
   * from the first break only.
   *
   * That is the in-band half. The cross-RUN half is the last-run sidecar: its
   * rows carry their binding's `occurrence` so a repair on the `'steps'` path
   * can find the failure a previous run's iteration 3 left behind
   * (`priorFailure`).
   *
   * On the instance, not per block, so the dedupe holds across a row loop that
   * arrives as several requests on one kept session as well as within a single
   * batch. That is what makes "the compile records row 1" true of the server
   * rather than of any one client — a client that drives the server this way
   * gets the same answer (tests/api-server-rows-compile.test.ts does;
   * TestBench does not).
   */
  private readonly takenKeys = new Set<string>();
  /**
   * Entry keys this compile actually PUT SOMETHING in the candidate for — a
   * generated entry or an `ai: true` decline, both of which `applyGenerated`
   * splices into the file.
   *
   * A second set rather than a reuse of `takenKeys`, because the two answer
   * different questions and only one of them is about the author's file.
   * `takenKeys` is the dedupe gate: it is added to at `offer` time, BEFORE the
   * model call, and its job is that nobody pays twice for one entry. Whether
   * that one payment produced anything is settled a model call later, and it
   * need not have: `applyGenerated` can come back `kind: 'error'` (the model
   * answered nothing usable, or the splice threw), and then the key is taken
   * and the file is unchanged.
   *
   * Everything that reconciles two iterations of one entry has to net against
   * THIS set. A looped body called twice, where call 1 ran the body and its
   * generation errored and call 2 returned before reaching it, is one entry
   * with no code: netting against `takenKeys` dropped call 2 from
   * `notAttempted` and the summary said nothing at all about a line that ends
   * the compile with no entry. Netting against what was written names it.
   */
  private readonly writtenKeys = new Set<string>();
  /**
   * Offered steps that ran as code, per entry key — the raw material for
   * `kept`, which is a count of STEPS (the boxed `keptExistingFor` counts them
   * that way too, so a body called three times whose entry is clean is 3).
   *
   * A set of absolute expanded INDICES per key, not a tally of offers
   * (stories/codebehind-loops-and-conditions.md, decision 13): a runtime loop
   * re-runs the same index once per pass, and a body line whose entry ran
   * cleanly on three passes is one kept step, not three. A table-row section
   * loop is unrolled at expansion — one index per iteration — so it still
   * counts per iteration, which is the parity above.
   *
   * Kept per key rather than as a running total because the two answers about
   * one key are decided at different times and in either order. A looped body
   * whose entry is clean on iteration 1 and stale on iteration 2 refuses
   * iteration 1 as "ran as code" (a kept step) and then generates from
   * iteration 2 (a taken key) — and `compiled 1, kept 1` for a single entry is
   * one entry counted twice, where the boxed pipeline's `keptExistingFor`
   * excludes every step whose key is in the selection and says `kept 0`.
   */
  private readonly keptByKey = new Map<string, Set<number>>();
  /** Expanded indices whose `ai: true` entry the run honoured — distinct, for
   *  the reason {@link keptByKey} is (decision 13). */
  private readonly keptAiExisting = new Set<number>();
  /**
   * Condition lines seen on this run, per entry key, with what their visits
   * showed (stories/codebehind-loops-and-conditions.md, "Live compile"). A
   * `While` visited 25 times is offered 25 times; generation waits for
   * `runStepsEnded`, when every visit of the block has been seen, so it can be
   * shown the first held AND the first not-held page.
   */
  private readonly guards = new Map<string, GuardAccumulator>();
  /**
   * Absolute indices a Compile This Step was NOT asked to compile (`setSlice`,
   * `'steps'` mode only) — and yet may run, now that loops compile: a
   * selection of a `While` line runs the body the guard opens, and a selection
   * inside a loop's body returns to its guard and runs further passes. What
   * runs outside the selection is not generated, named or counted.
   *
   * Not kept for a `'run'` compile, whose slice is a continuation block's
   * bound: there, a step a loop runs from before the block's start is still
   * part of the logical run the author asked to compile.
   */
  private readonly outside = new Set<number>();
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
   * Whether any action this run has offered so far named a placeholder
   * (stories/placeholder-preserving-actions.md, decision 6).
   *
   * The boxed pipeline asks this of the whole recording at once; here the run
   * is still happening, so it is what has been SEEN — set from every offered
   * step, eligible or not, before the step is queued. A step generated before
   * any placeholder has appeared is judged the old way, which is the safe
   * direction: the cost is a missed warning, where the other direction is a
   * decline the author has to chase.
   */
  private sawPlaceholder = false;
  /** The compliance metric, per generated entry. */
  private readonly recoveredByValue: Array<{ step: number; name: string }> = [];
  /** The pre-change notice is said once, and only when it changed an answer. */
  private saidPreChange = false;
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
   *  `totalSteps`. Starts as the plan's countable length and shrinks when a
   *  block is bounded to a slice (`setSlice`): a single-step compile of a
   *  six-step skill is "1 of 1", not "1 of 6". */
  private scopedTotal: number;

  constructor(private readonly options: LiveCompileOptions) {
    this.plan = [...options.plan];
    this.scopedTotal = countable(this.plan);
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
    this.scopedTotal += countable(plan);
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
      if (i < start || i > end) {
        this.plan[this.offset + i]!.inScope = false;
        if (this.options.mode === 'steps') this.outside.add(this.offset + i);
      }
    }
    const block = this.plan.slice(this.offset);
    this.scopedTotal += countable(block.slice(start, end + 1)) - countable(block);
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

  /**
   * Steps that ran as code and whose entry this compile did not rewrite.
   *
   * "kept" means the entry stands as it is, so a key that ends up generated —
   * whichever iteration asked for it, and whichever order the two arrived in
   * — is not kept at all. Parity with the boxed pipeline's `keptExistingFor`,
   * which drops every step whose key is in the selection.
   *
   * Against `writtenKeys` rather than `takenKeys`: an entry whose one
   * generation errored was queued but never rewritten, so it does still stand
   * as it is and the iterations that ran it as code are kept.
   */
  private get kept(): number {
    let total = 0;
    for (const [key, indices] of this.keptByKey) {
      if (!this.writtenKeys.has(key)) total += indices.size;
    }
    return total;
  }

  /** Record that the entry `key` ran as code at absolute index `at`. */
  private keep(key: string, at: number): void {
    const indices = this.keptByKey.get(key) ?? new Set<number>();
    indices.add(at);
    this.keptByKey.set(key, indices);
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
   * while the run winds down. One enqueued entry is one generation — the
   * dedupe (`takenKeys`) queues each key at most once — so units and outcomes
   * cannot drift.
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
   * Silent when there is no tail to forecast — a run that enqueued nothing
   * and owes no Review has nothing to wait for, and saying "0 entries
   * still to generate" would be noise.
   *
   * A run stopped before its last step is the other wording: what is queued
   * will be skipped, not generated, and `finish` runs no Review on an aborted
   * compile — so promising one here would be a forecast of something that
   * cannot happen.
   */
  runStepsEnded(): void {
    // The conditions first, so the forecast below counts them: every visit of
    // this block has now been seen, which is what a condition waits for
    // (decision 9 — the first held AND the first not-held page).
    this.enqueueConditions();
    const stopped = this.disposed || this.signal?.aborted === true;
    const outstanding = this.enqueued - this.settled;
    // Owed by what `finish` will actually do, not by "this compiler has ever
    // enqueued anything". `finish` reviews the files whose content has changed
    // since the reviewer last saw them, so a block that queued nothing and
    // changed nothing owes no Review — and `this.enqueued > 0` (an INSTANCE
    // counter) said one was coming anyway. The shape that reaches: a client
    // that drives the server this way — one kept session, row 2's steps sent
    // with `compileContinues`, all of them the same entries again
    // (`takenKeys`). tests/api-server-rows-compile.test.ts drives it;
    // TestBench does not — run-controller.ts sends the compile fields on the
    // first planned row's batches only, and recycles the session between rows.
    // Row 2 announced "Run finished — 0 entries still to generate, then a
    // review pass" and then reviewed nothing, which is a forecast of something
    // that cannot happen — the thing this method's own stopped-run branch
    // refuses to do.
    //
    // Queued work counts as owing one because it is about to change a file;
    // that a generation may decline is the same forecast the old code made and
    // is not worth being exact about.
    const reviewOwed =
      this.options.mode === 'run' &&
      !stopped &&
      (outstanding > 0 || this.unreviewedFiles().length > 0);
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
   * say how many were kept as code and how many were already AI — and at most
   * once per ENTRY, because the second inlining of a body is the same entry
   * arriving again (`takenKeys`).
   */
  offer(input: LiveStepInput): void {
    // Merged across EVERY offered step, eligible or not, and before the
    // refusal below returns. The review's leak guard is a whole-file check —
    // a rewrite can move a literal into any entry — so it has to see every
    // value the run resolved, not the last eligible step's snapshot. A step
    // that captured a password and was then skipped as "ran as code" still
    // put that password in the run's scope.
    Object.assign(this.parameters, input.resolvedParameters);
    // Before the refusal below, for the reason the merge above is: a step the
    // compile skips still proves what the model does with placeholders on this
    // run.
    if (!this.sawPlaceholder && anyActionCarriesPlaceholder(actionsOf(input.result))) {
      this.sawPlaceholder = true;
    }
    const at = this.offset + input.index;
    // Ran, but was not selected: a Compile This Step compiles its selection
    // and no more — see `outside`.
    if (this.outside.has(at)) {
      logger.debug(`Compile-as-you-go skipped step ${at + 1}: outside the selection being compiled`);
      return;
    }
    const text = input.binding?.source ?? this.plan[at]?.text ?? input.result.instruction;
    // A row the run DECIDED not to take (issue 053) is settled on its own
    // terms, before anything that reads it as a step that could have run.
    if (input.result.status === 'skipped' && input.skipped === 'decision') {
      this.offerDecisionSkip(input, at, text);
      return;
    }
    const refusal = generationRefusal({
      binding: input.binding,
      text,
      status: input.result.status,
      tolerated: input.result.tolerated,
      deliberate: input.result.deliberate,
      fromCodeBehind: input.result.fromCodeBehind,
      codeBehindStale: input.result.codeBehindStale,
      surface: input.result.surface,
      skipped: input.skipped,
    });
    if (refusal !== undefined) {
      // Both "ran as code" reasons: the entry ran, so the step is one this
      // compile kept rather than one it owes. The tolerated variant is counted
      // here rather than in the `notAttempted` branch below because the entry
      // the author would be told is missing is in their file.
      if (refusal === 'the step ran as code' || refusal === TOLERATED_CODE_BEHIND_REFUSAL) {
        // The binding is there: every refusal that could reach here without
        // one (`[skill:]`/`[tool:]`, no binding at all) is decided above this.
        this.keep(entryKeyOf(input.binding!), at);
      }
      if (refusal === 'the entry is marked `ai: true`') this.keptAiExisting.add(at);
      // Named in the summary rather than only counted, exactly as a
      // stop-skipped entry is: "3 step(s) not attempted" does not tell the
      // author WHICH of their steps still has no entry
      // (stories/step-flow-control.md, decision 12).
      if (refusal === SKIPPED_BY_RETURN_REFUSAL) {
        // With the key, so `finish` can tell "this step has no entry" from
        // "another iteration of this step already generated its entry" — see
        // the field. The binding is there for the same reason the kept branch
        // above can assert it: `generationRefusal` decides `!input.binding`
        // before it decides `skipped`.
        this.skippedByReturn.push({ number: at + 1, key: entryKeyOf(input.binding!) });
        this.stepEvent('generate', { index: at, number: at + 1, text, hasEntry: false, isAiEntry: false }, refusal);
      }
      // Named and netted exactly as the skipped case above, and for the same
      // reason (decision 11): a step this compile could not generate from has to
      // be named by number, not left to discover as a gap in the file. The
      // binding is there — `generationRefusal` decides `!input.binding` first.
      if (refusal === TOLERATED_FAILURE_REFUSAL) {
        this.toleratedFailures.push({ number: at + 1, key: entryKeyOf(input.binding!) });
        this.stepEvent('generate', { index: at, number: at + 1, text, hasEntry: false, isAiEntry: false }, refusal);
      }
      logger.debug(`Compile-as-you-go skipped step ${input.index + 1}: ${refusal}`);
      return;
    }
    const key = entryKeyOf(input.binding!);
    // The dedupe, and it is deliberately BEFORE `enqueued++`: a skipped repeat
    // is not work the tail owes, so counting it would leave the progress bar's
    // `total` promising generations that will never happen and `done` never
    // reaching it. Nothing else counts it either — not `kept` (that means "ran
    // as code"), not `keptAi`, not `notAttempted` — which is exactly the
    // boxed pipeline's arithmetic for a body called twice: `totalSteps` counts
    // every expanded step, `compiled` counts entries.
    //
    // Unconditional, an iteration whose own entry threw in this run included.
    // The key holder is ALREADY the first iteration that broke — a clean code
    // run is refused as "ran as code" above and never gets here — so the
    // repair that key queued is the well-founded one: the failing iteration's
    // code, its error and its page, together. Letting a later break re-open
    // the key would ask for a second repair over the entry the first one just
    // wrote, pairing code that never ran with the error the OLD entry threw,
    // and the last and least-informed answer would win — at one model call per
    // row for the common shape, an entry that breaks identically on every row.
    // The cost of skipping is the narrow case instead: an iteration that
    // breaks DIFFERENTLY later in the loop contributes nothing, and the entry
    // is repaired from the first break only.
    if (this.takenKeys.has(key)) {
      logger.debug(
        `Compile-as-you-go skipped step ${input.index + 1}: an earlier ` +
          `iteration of this step already produced its entry`,
      );
      return;
    }
    this.takenKeys.add(key);
    const step: CompileStep = {
      index: at,
      number: at + 1,
      text,
      binding: input.binding,
      key,
      // Kind-aware: a `condition` entry on an ordinary step is not its entry
      // (the runtime ran the step under AI), so it is generated over.
      hasEntry: hasEntryOfKind(input.binding!.entry, 'step'),
      isAiEntry: false,
    };
    this.enqueue(step, () => this.askModel(step, input));
  }

  /**
   * Put one generation on the serialized queue — a step's (`offer`) or a
   * condition's (`enqueueConditions`); both count in `enqueued`, `compiled`,
   * `declined`, `errors` and the progress frames alike.
   */
  private enqueue(step: CompileStep, ask: () => Promise<GeneratedEntry>): void {
    this.enqueued++;
    // Each link is isolated. A rejected link would otherwise poison the rest
    // of the chain — `.then` on a rejected promise is skipped — so one
    // unexpected throw at step 2 would silently lose steps 3..n, which is
    // exactly the "a run must not fail over its own bookkeeping" rule at the
    // level below the one `generate` already guards.
    this.tail = this.tail
      .then(() => this.generate(step, ask))
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

  /**
   * A row the run decided not to take — an untaken branch, a loop that ran no
   * passes, an exhausted or empty `For each`
   * (stories/codebehind-loops-and-conditions.md, decision 12; issue 053).
   *
   * Nothing ran, so nothing is generated. What is decided here is whether the
   * line is OWED an entry — named in `notAttempted` with
   * {@link SKIPPED_BY_DECISION_REFUSAL} — or not the compile's business:
   *
   * - outside a Compile This Step's selection: never asked about (settled by
   *   `offer` before this);
   * - it already has an entry (any kind): left exactly as it is, counted
   *   nowhere but `totalSteps` — see {@link skippedByDecision};
   * - a condition line with no entry: owed, unless another visit of it is
   *   observed and generated (netted at `finish`). Its observations arrive
   *   through `offerGuard`, never here;
   * - a line the framework dispatches (`Otherwise`, `For each`, a literal
   *   condition, `Set`, `[use …]`, an unconditional `Return`, a `[tool:]` or
   *   `[skill:]` call) or with no file to bind into: not owed, silently —
   *   `generationRefusal` answers for all of them;
   * - any other step with no entry: owed.
   */
  private offerDecisionSkip(input: LiveStepInput, at: number, text: string): void {
    const binding = input.binding;
    if (binding?.entry !== undefined) return;
    const number = at + 1;
    const owed = (): void => {
      const key = entryKeyOf(binding!);
      this.skippedByDecision.push({ number, key });
      // Said once per entry, and only while nothing has been generated for it:
      // a body line generated on pass 1 and decided against on pass 2 owes
      // nothing (`finish` nets it off), and "the step did not run" after its
      // own "generated" line reads as if the entry were lost.
      if (this.takenKeys.has(key) || this.writtenKeys.has(key) || this.saidDecisionSkip.has(key)) return;
      this.saidDecisionSkip.add(key);
      this.stepEvent(
        'generate',
        { index: at, number, text, hasEntry: false, isAiEntry: false },
        SKIPPED_BY_DECISION_REFUSAL,
      );
    };
    if (binding && compilableCondition(text)) {
      // Filed, but not SAID yet: a chain member skipped here may be the one
      // after the member that held — never asked, and generated anyway from
      // the not-asked page `offerGuard` keeps for it (decision 9). Whether it
      // ends the compile owed is only known at `finish`, which says it then.
      this.skippedByDecision.push({ number, key: entryKeyOf(binding), guard: true });
      return;
    }
    const refusal = generationRefusal({
      binding,
      text,
      status: 'skipped',
      skipped: 'decision',
      surface: input.result.surface,
    });
    if (refusal === SKIPPED_BY_DECISION_REFUSAL) owed();
    else logger.debug(`Compile-as-you-go skipped step ${number}: ${refusal ?? 'not taken'}`);
  }

  /**
   * Offer one visit to a guard — the evidence a `condition` entry is
   * generated from (stories/codebehind-loops-and-conditions.md, "Live
   * compile"). Returns immediately, and generates NOTHING: a condition is
   * generated once every visit of the block has been seen
   * (`runStepsEnded`), so it can be shown the first held AND the first
   * not-held page.
   *
   * Per member that was asked on this visit:
   *
   * - decided from its VALUES — not offered: a literal condition is free and
   *   is never compiled (decision 10), and its line is dispatched in the plan;
   * - decided by its CODE, cleanly — a kept step, counted once per expanded
   *   index however many times a loop visits it (decision 13). In a chain,
   *   only the members whose code ran: up to the one that held;
   * - decided by the MODEL — an observation, kept per member KEY: the first
   *   held, the first not-held and the first not-asked (a member after the one
   *   that held; decision 9), each with its parameter snapshot. A member whose
   *   entry broke on this visit (`guard.staleMember`, which is the member's
   *   own index — the row may belong to another member, the one that held)
   *   carries the latest error, so its generation is a repair;
   * - an `ai: true` entry — the author's opt-out, honoured: counted `keptAi`;
   * - judged on the computer surface — stays AI, as a computer-mode step does
   *   (decision 10): no DOM, and a screen read is not portable.
   */
  offerGuard(input: LiveGuardInput): void {
    Object.assign(this.parameters, input.resolvedParameters);
    const decision = input.result.guard;
    if (!decision || decision.decidedBy === 'values') return;
    if (input.surface === 'computer') return;

    const staleError = input.result.codeBehindStale?.error ?? input.result.codeBehindHealSkipped?.error;
    /** Whether anything was actually DECIDED — a loop's `holds` or a chain's
     *  `selected`. A guard whose entry broke and whose judge then could not
     *  decide either carries the stale member and nothing else: its error is
     *  worth keeping for the repair, but it is no observation. */
    const decided = decision.holds !== undefined || decision.selected !== undefined;
    const isLoop = decision.holds !== undefined;
    /** Position of the member that held within `members`, or null for none. */
    const selectedAt = input.members.findIndex((m) => m.index === decision.selected);
    const heldAt = isLoop ? (decision.holds === true ? 0 : null) : selectedAt >= 0 ? selectedAt : null;

    input.members.forEach((member, position) => {
      const binding = member.binding;
      if (!binding || !compilableCondition(binding.source)) return;
      const at = this.offset + member.index;
      const key = entryKeyOf(binding);
      const broke = staleError !== undefined && decision.staleMember === member.index;

      if (decision.decidedBy === 'code') {
        // Code answered every member it reached, first-holds-wins: all of them
        // when none held, those up to the winner otherwise. A guard whose code
        // FAILED for real (`step.expect`, a refused `step.exit()`) is no
        // evidence that the entry stands; one that broke is no observation.
        const reached = heldAt === null || position <= heldAt;
        if (!broke && input.result.error === undefined && reached && isConditionCode(binding.entry)) {
          this.keep(key, at);
        }
        return;
      }

      // The model decided.
      if (binding.entry?.ai === true) {
        this.keptAiExisting.add(at);
        return;
      }
      const acc = this.guards.get(key) ?? { key, index: at, binding, observations: [] };
      this.guards.set(key, acc);
      if (broke) acc.stale = staleError;
      if (!decided) return;
      const holds: boolean | undefined = isLoop
        ? decision.holds
        : heldAt === null
          ? false
          : position < heldAt
            ? false
            : position === heldAt
              ? true
              : undefined;
      // The first of each verdict only (decision 9) — a `While` visited 25
      // times keeps two pages, not 25.
      if (acc.observations.some((o) => o.holds === holds)) return;
      const evidence = decision.evidence;
      acc.observations.push({
        holds,
        ...(evidence?.dom !== undefined && { dom: evidence.dom }),
        ...(evidence?.url !== undefined && { url: evidence.url }),
        parameters: input.resolvedParameters,
      });
    });
  }

  /**
   * Queue a `condition` entry for every condition line this block observed and
   * owes one (stories/codebehind-loops-and-conditions.md, "Live compile").
   * Called by `runStepsEnded` — every visit of the block has been seen — and
   * again by `finish`, so a block that never reached `runStepsEnded` still
   * generates what it observed. Idempotent: a queued key is taken.
   *
   * Owed means: observed at least once (a line never asked on this run has
   * nothing to generate from and is not generated), inside the slice, not
   * already queued (`takenKeys`, shared with steps), and — on the Run &
   * Compile path — without a working `condition` entry of its own, unless
   * that entry broke on this run. A member that has one and was not run
   * (its chain went to the model because a SIBLING has none) is left as it
   * stands. Compile This Step recompiles what it was sent, entry or not,
   * which is why its execution runs with code-behind off.
   */
  private enqueueConditions(): void {
    const owed = [...this.guards.values()]
      .filter((acc) => {
        if (this.takenKeys.has(acc.key) || this.outside.has(acc.index)) return false;
        if (acc.observations.length === 0) return false;
        if (this.options.mode === 'run' && acc.stale === undefined && isConditionCode(acc.binding.entry)) {
          return false;
        }
        return true;
      })
      .sort((a, b) => a.index - b.index);
    for (const acc of owed) {
      this.takenKeys.add(acc.key);
      this.guards.delete(acc.key);
      const step: CompileStep = {
        index: acc.index,
        number: acc.index + 1,
        text: acc.binding.source,
        binding: acc.binding,
        key: acc.key,
        hasEntry: hasEntryOfKind(acc.binding.entry, 'condition'),
        isAiEntry: false,
      };
      this.enqueue(step, () => this.askCondition(step, acc));
    }
  }

  /**
   * One model call for one condition line: a repair when its entry broke — on
   * this run (in band), or on the last one (the sidecar, for Compile This
   * Step, which runs with code-behind off) — a plain generation otherwise.
   * The repair is `generateConditionEntry`'s variant, shown the entry as it
   * stands in the candidate and what went wrong with it.
   */
  private async askCondition(step: CompileStep, acc: GuardAccumulator): Promise<GeneratedEntry> {
    const binding = acc.binding;
    const failed = await this.priorFailure(binding, acc.stale);
    let repair: { entryCode: string; error: string } | undefined;
    if (failed !== undefined) {
      const file = await this.candidate.read(binding.file);
      const entryCode =
        file === null ? undefined : entryTextIn(file, binding.source, binding.section, binding.occurrence);
      // No entry text to repair FROM — the file was edited, or the span could
      // not be found: generate as if from scratch, as a step does.
      if (entryCode !== undefined) repair = { entryCode, error: failed };
    }
    // The evidence the prompt is shown, and the visit whose values it reads.
    const first = acc.observations[0]!;
    const loop = this.plan[acc.index]?.loop;
    return generateConditionEntry({
      binding,
      observations: acc.observations,
      resolvedParameters: first.parameters,
      parameterMap: first.parameters,
      secrets: this.promptSecrets(first.parameters),
      ...(this.options.envData && { envData: this.options.envData }),
      aiClient: this.options.aiClient,
      contextContent: this.options.contextContent,
      testName: this.options.testName,
      ...(this.options.baseUrl !== undefined && { baseUrl: this.options.baseUrl }),
      ...(this.signal && { signal: this.signal }),
      wholeTest: this.wholeTestFor(step.index),
      candidateFile: (await this.candidate.read(binding.file)) ?? undefined,
      ...(loop && { loop: loopContextFor(loop.line, first.parameters, loop.runtimeItem) }),
      ...(repair && { repair }),
    });
  }

  /**
   * The run's free-text mask set as of a snapshot — `runSecrets`, as the run's
   * own `secretsNow()` computes it — for every prompt this compiler builds
   * from that snapshot: a secret inside a value no key names as secret
   * (`auth: "Bearer <the key>"`) is masked there as it is in the run's own
   * step prompts. The boxed compile hands its prompts the same set.
   */
  private promptSecrets(values: Record<string, string>): string[] {
    return runSecrets({ parameters: values, envData: this.options.envData });
  }

  /** The prompt's whole-test block, marked for the step at `index`. */
  private wholeTestFor(index: number): Array<{ index: number; text: string; inScope: boolean; isThisStep: boolean }> {
    return this.plan.map((p, i) => ({
      index: i + 1,
      text: p.text,
      inScope: p.inScope,
      isThisStep: i === index,
    }));
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
   *
   * The two are not equally well informed, and the difference shows in a loop.
   * An in-band failure is fully paired: it arrives on the step being offered,
   * and the step being offered is the first iteration that BROKE (`takenKeys`
   * — a clean code run takes no key), so the code the repair reads, the error
   * it is given and the page it is shown all belong to that one iteration. A
   * sidecar failure belongs to some iteration of a PREVIOUS run — possibly
   * iteration 3 — while the DOM and URL in the prompt come from the iteration
   * this compile was offered, normally the first. That mismatch is the price
   * of repairing at all on the `'steps'` path (nothing else knows what broke)
   * and it is bounded: the code and the error are the failing iteration's,
   * only the page is not.
   */
  private async priorFailure(
    binding: CodeBehindBinding,
    /** What the entry threw in THIS run, when it did — a step's
     *  `codeBehindStale.error`, a condition's latest stale error. */
    inBand: string | undefined,
  ): Promise<string | undefined> {
    if (inBand !== undefined) return inBand;
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
    // One entry serves every iteration of a looped body, and this compile is
    // offered ONE of them (`takenKeys`) — but the sidecar holds a row per
    // iteration, in execution order. So `same[occurrence]` is iteration 1's
    // row and only iteration 1's: an entry that threw on row 3 read back
    // clean, and the step generated from scratch instead of going through the
    // repair prompt that would have been shown the code and its error.
    //
    // With `occurrence` on the rows the question is answerable directly —
    // every row that IS this occurrence, whichever iteration wrote it, and the
    // first of them that failed. Not "any stale row of this identity": a body
    // saying the same thing twice has occurrence 0 and 1 per iteration, and
    // repairing 0 from 1's failure is a misattribution the old code did not
    // make.
    const byOccurrence = same.filter((r) => r.occurrence === binding.occurrence);
    // Nothing matched. The positional read is the pre-`occurrence` sidecar's
    // only answer, so it stands in for exactly that — rows that carry no
    // `occurrence` AT ALL, which is right for iteration 1 and so for every
    // non-looped test. It must not stand in when the rows do carry the field
    // and none of them is this occurrence: a body that gained a second
    // identically-worded line, was compiled (a compile writes entries and no
    // sidecar) and not re-run has an entry at occurrence 1 and no row for it,
    // and `same[1]` would hand that entry another iteration's occurrence-0
    // failure to repair from. No row for this occurrence means no prior
    // failure; the step generates from scratch.
    const positional = same.every((r) => r.occurrence === undefined);
    const row =
      byOccurrence.length > 0
        ? (byOccurrence.find((r) => r.stale) ?? byOccurrence[0])
        : positional
          ? same[binding.occurrence]
          : undefined;
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
   * shows it the code that failed and what it threw — the entry as it stands
   * in the candidate, which IS the code that failed, because a key is queued
   * at most once (`takenKeys`) and so nothing has rewritten it first. Where
   * the failure comes from depends on the mode — see `priorFailure`.
   */
  private async askModel(step: CompileStep, input: LiveStepInput): Promise<GeneratedEntry> {
    const binding = step.binding!;
    const failed = await this.priorFailure(binding, input.result.codeBehindStale?.error);
    if (failed !== undefined) {
      const repaired = await this.askForRepair(step, input, failed);
      if (repaired) return repaired;
      // No entry text to repair FROM — the file was edited, or the span could
      // not be found. Fall through and generate as if from scratch.
    }
    // The loop this step repeats in, and what changes per pass (decision 2):
    // the evidence pass's own bindings, which ride its loop marker — the same
    // pass whose transcript and snapshot this generation reads, because the
    // first iteration to reach `offer` is the one that took the key.
    const loopAt = this.plan[step.index]?.loop;
    const loop = loopAt
      ? loopContextFor(loopAt.line, input.result.loop?.values ?? input.resolvedParameters, loopAt.runtimeItem)
      : undefined;
    return generateStepEntry({
      binding,
      actions: actionsOf(input.result),
      ...(input.result.assertions && { assertions: input.result.assertions }),
      resolvedParameters: input.resolvedParameters,
      // The snapshot carries the live map's loop-binding marks
      // (`liveCompileSnapshot`), so the prompt's parameter block can tell a
      // pass's `row.keyword` from an author's `user.apikey` (§7.6).
      parameterMap: input.resolvedParameters,
      // …and the run's mask set as of that snapshot, so a secret inside a value
      // no key names as secret is masked as the run's own prompts mask it.
      secrets: this.promptSecrets(input.resolvedParameters),
      recordingCarriesPlaceholders: this.sawPlaceholder,
      ...(this.options.envData && { envData: this.options.envData }),
      aiClient: this.options.aiClient,
      contextContent: this.options.contextContent,
      testName: this.options.testName,
      ...(this.options.baseUrl !== undefined && { baseUrl: this.options.baseUrl }),
      wholeTest: this.wholeTestFor(step.index),
      candidateFile: (await this.candidate.read(binding.file)) ?? undefined,
      ...contextOf(input.result),
      ...(loop && { loop }),
      // What this pass captured — the result the entry must reproduce, and a
      // value the leak guard refuses to see written in.
      recordedCaptures: recordedCapturesOf(binding, input.result.outputs),
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
    const loopAt = this.plan[step.index]?.loop;
    const loop = loopAt
      ? loopContextFor(loopAt.line, input.result.loop?.values ?? input.resolvedParameters, loopAt.runtimeItem)
      : undefined;
    const ctx = input.result.stepContext;
    // What the healed pass captured under AI — the answer the broken entry was
    // meant to produce, which the repair must reproduce and must not write in.
    const recordedCaptures = recordedCapturesOf(binding, input.result.outputs);
    const repairInput: RepairPromptInput = {
      rawStepText: step.text,
      stepIndex: step.number,
      entryCode,
      error,
      // The page BEFORE the step is the page the entry threw on: the entry
      // runs first, and the AI heal that follows is what moved it on.
      ...(ctx?.domBefore !== undefined && { dom: ctx.domBefore }),
      ...(ctx?.urlBefore !== undefined && { url: ctx.urlBefore }),
      parameters,
      // The map those values came out of, so a dotted name in it is decided
      // by whose it is: a `For each` pass's `payment.keyword` by its two
      // segments, a data file's own `user.apikey` heading by the author rule
      // (§7.6). Without it the block asked the binding rule about both and
      // wrote the credential into the prompt in clear.
      parameterMap: input.resolvedParameters,
      secrets: this.promptSecrets(input.resolvedParameters),
      ...(envRefs.resolved.length > 0 && { envRefs: envRefs.resolved }),
      // The loop the step repeats in, as generation is told it (decision 2):
      // the repaired entry replays on every pass, so what changes per pass is
      // read with `step.getVar`, never the healed pass's item.
      ...(loop && { loop }),
      ...(recordedCaptures && { recordedCaptures }),
    };
    const { result } = await askWithCaptureRetry(
      this.options.aiClient,
      this.options.contextContent,
      (retry) => buildRepairPrompt({ ...repairInput, ...(retry && { retry }) }),
      [
        // The authored line, exactly as generation passes it (`askModel` below,
        // and `guardedValues` / `authorQuotedLiterals` in generate.ts): a value the
        // AUTHOR quoted in the step is the author's, so an entry echoing it is
        // repeating the step rather than inlining a resolved value. Without it a
        // stale `If {{a}} is "peanuts" then fail …` could not be repaired at all —
        // every candidate contains `peanuts`, so every one was discarded as a leak
        // (stories/step-failure-outcomes.md, decisions 3 and 10).
        ...guardedValues(parameters, envRefs.resolved, binding.source),
        ...capturedValueGuards(recordedCaptures, binding.source),
      ],
      this.signal,
    );
    return result;
  }

  private async generate(step: CompileStep, ask: () => Promise<GeneratedEntry>): Promise<void> {
    // A stopped run skips what has not started. The in-flight one finishes:
    // its model call is already paid for, and its entry is work the author
    // asked for.
    if (this.disposed || this.signal?.aborted) {
      this.skippedByStop.push(step.number);
      // Named, not merely counted: the summary's `notAttempted` is a list of
      // numbers a client renders as a total, and "3 step(s) not attempted"
      // does not tell the author WHICH of their steps still has no entry.
      this.stepEvent('generate', step, 'skipped — the run was stopped');
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
    const generated = await ask();
    const applied = await applyGenerated(this.candidate, step, generated, this.stepEvent, 'generate');
    if (applied.kind === 'entry' && applied.references) {
      for (const name of applied.references.recoveredByValue) {
        this.recoveredByValue.push({ step: step.number, name });
        this.note?.(`Step ${step.number}: ${valueMatchWarning(name)}`, 'warn');
      }
      if (applied.references.preChangeFallback && !this.saidPreChange) {
        this.saidPreChange = true;
        this.note?.(
          'No action in this run names a placeholder, so the compile identified values by ' +
            'string match — the behaviour from before placeholder-preserving actions.',
          'info',
        );
      }
    }
    // Written, not merely queued: both of these spliced something into the
    // candidate (an entry, or an `ai: true` decline carrying the reason), so
    // this entry's slot is answered and the reconciliations in `finish` and in
    // `kept` may net an iteration off against it. The `error` branch below
    // deliberately does NOT record the key — see `writtenKeys`.
    const wrote = applied.kind === 'entry' || applied.kind === 'declined';
    if (wrote && step.key !== undefined) this.writtenKeys.add(step.key);
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
   * Candidate files the reviewer has not seen in their current state.
   *
   * A split run finishes once per block, so the reviewer would otherwise be
   * asked to re-read a file it has already passed. It only sees a file whose
   * content has actually changed since it last saw it — which is also what
   * `runStepsEnded` forecasts on, so the note and the pass agree.
   */
  private unreviewedFiles(): string[] {
    return this.candidate
      .touchedFiles()
      .filter((f) => this.reviewed.get(f) !== this.candidate.contentOf(f));
  }

  /**
   * Drain the queue, run Review (on the Run & Compile path only), and hand
   * back the proposal. The server never writes under the project on this
   * path: the files ride the wire and TestBench applies them through the diff.
   */
  async finish(final: LiveCompileFinish): Promise<LiveCompileOutcome> {
    // Normally a no-op — `runStepsEnded` queued them — but a block that ended
    // without reaching it must not lose the conditions it observed.
    this.enqueueConditions();
    await this.tail.catch((err: unknown) => {
      logger.warn(`Code-behind generation queue failed: ${String(err)}`);
    });

    const unreviewed = this.unreviewedFiles();
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

    // This path has no headline of its own — the summary rides the wire — so
    // the compliance count says itself here, once, the way the boxed
    // pipeline's headline tail does.
    if (this.recoveredByValue.length > 0) {
      const n = this.recoveredByValue.length;
      this.note?.(
        `${n} placeholder reference${n === 1 ? '' : 's'} recovered by value match — the model ` +
          'did not name them in its actions.',
        'warn',
      );
    }

    const files = this.candidate.changedFiles();
    // A step a return left unrun owes an entry — unless ANOTHER inlining of the
    // same entry ran and generated it. A looped body is one entry per authored
    // line and one skip per iteration, so an iteration that returns early after
    // an earlier one compiled the body would otherwise name steps as having no
    // entry when the entry is in the very proposal being handed back. Same rule
    // as the `kept` getter's, decided here rather than at `offer` time because
    // the two answers about one key arrive in either order.
    //
    // WRITTEN, not merely queued (`writtenKeys`, not `takenKeys`): the debt is
    // "this line ends the compile with no entry", and an iteration whose
    // generation errored produced none. Netting it off would leave the author
    // with a proposal silently missing that line.
    const skippedByReturnOwed = this.skippedByReturn
      .filter((s) => !this.writtenKeys.has(s.key))
      .map((s) => s.number);
    // A tolerated failure owes an entry on exactly the same terms
    // (stories/step-failure-outcomes.md, decision 11): it produced no evidence
    // of the step working, unless another inlining of the same entry did.
    const toleratedOwed = this.toleratedFailures
      .filter((s) => !this.writtenKeys.has(s.key))
      .map((s) => s.number);
    // A step the run decided against owes an entry on the same terms
    // (stories/codebehind-loops-and-conditions.md, decision 12; issue 053): a
    // body line one pass skipped and another compiled owes nothing.
    const decisionOwed = this.skippedByDecision.filter((s) => !this.writtenKeys.has(s.key));
    // A condition line's sentence is said only now, once it is known that no
    // visit of it was generated (see `offerDecisionSkip`). Once per line: a
    // chain member an outer loop skipped on three passes is one line owed.
    const saidGuards = new Set<number>();
    for (const s of decisionOwed) {
      if (!s.guard || saidGuards.has(s.number)) continue;
      saidGuards.add(s.number);
      this.stepEvent(
        'generate',
        { index: s.number - 1, number: s.number, text: this.plan[s.number - 1]?.text ?? '', hasEntry: false, isAiEntry: false },
        SKIPPED_BY_DECISION_REFUSAL,
      );
    }
    const skippedByDecisionOwed = decisionOwed.map((s) => s.number);
    const notAttempted = [
      ...new Set([
        ...(final.notAttempted ?? []),
        ...this.skippedByStop,
        ...skippedByReturnOwed,
        ...toleratedOwed,
        ...skippedByDecisionOwed,
      ]),
    ].sort((a, b) => a - b);
    /**
     * The ending step's own line, and the one sentence both compilers say about
     * it (stories/step-failure-outcomes.md, decisions 1–3). Read off the plan
     * rather than taken from the loop, for the reason
     * {@link LiveCompileFinish.endedAsWritten} gives.
     *
     * It travels only when the ending step left steps BEHIND it, which is the
     * boxed pipeline's rule: the field answers "why has step 10 no entry", so
     * with no gap there is no question — and carrying it anyway put an `error`
     * and an "ended at…" clause on a `green` summary, which is how
     * `compileResultLine` came to print "◐ Compiled nothing…" over a green
     * status. `final.notAttempted` is the gap as the LOOP sees it, rather than
     * the union below, which also holds steps that ran and were tolerated.
     */
    const endedFact = final.endedAsWritten;
    const endedAsWritten =
      endedFact === undefined || (final.notAttempted ?? []).length === 0
        ? undefined
        : {
            step: endedFact.step,
            error: endedFact.error,
            line: this.plan[endedFact.step - 1]?.text ?? '',
          };
    // A step a return left unrun is work still owed, so a compile that
    // attempted nothing BECAUSE of a return is not "already compiled"
    // (stories/step-flow-control.md, decision 12) — the same reason a stopped
    // run is not, and the same reason a tolerated failure is owed
    // (stories/step-failure-outcomes.md, decision 11).
    //
    // A run that ENDED as written has to enter this expression too, and only
    // through `notAttempted`. Dropping `stoppedAt` for it without this clause is
    // how a fully-compiled test whose FIRST step fails deliberately came back
    // `green` with every later step named "not attempted". When the ending step
    // was the LAST one there is no such gap and `green` is honest, which is why
    // the clause asks about the gap rather than about the ending. Off the FACT,
    // not the field: the field is narrowed to the boxed rule above.
    const endedWithStepsLeft = endedFact !== undefined && notAttempted.length > 0;
    const nothingToDo =
      this.attempted === 0
      && final.stoppedAt === undefined
      && !endedWithStepsLeft
      && !final.aborted
      && skippedByReturnOwed.length === 0
      && toleratedOwed.length === 0
      // …and an untaken branch: a file whose only uncompiled steps sit in it
      // is not "already compiled" (decision 12).
      && skippedByDecisionOwed.length === 0;
    const summary: CompileSummary = {
      test: this.options.testFilePath,
      totalSteps: this.scopedTotal,
      // ENTRIES, and generations are the same thing here: the dedupe queues
      // each entry key at most once, so this counts the proposal's entries the
      // way the boxed pipeline counts `selection.order.length`.
      compiled: this.compiled.length,
      kept: this.kept,
      keptAi: this.keptAiExisting.size + this.declined.length,
      rounds: 0,
      tokensUsed: final.tokensUsed,
      written: [],
      // Every entry this path produces is born unproven: there is no Replay,
      // and the author's next ordinary run is the proof. One number per entry
      // — the iteration that generated it, for an entry a loop inlines many
      // times.
      unproven: [...this.compiled].sort((a, b) => a - b),
      writtenOffAi: [],
      notAttempted,
      recordingDir: recordingDirFor(this.options.testFilePath),
      recoveredByValue: [...this.recoveredByValue],
      ...(candidatePath !== undefined && { candidatePath }),
      ...(final.stoppedAt && { stoppedAt: final.stoppedAt }),
      ...(endedAsWritten && { endedAsWritten }),
      // Why this compile is not green, in the boxed pipeline's own words and its
      // own order: a generation error is the actionable one and keeps the slot,
      // and the run ending as written takes it only when nothing went wrong.
      // Said here at all because a client with no headline of its own reads
      // `error` as the reason line.
      ...(this.errors > 0
        ? { error: `${this.errors} step(s) could not be generated; they stay AI` }
        : endedAsWritten
          ? {
              error:
                `${endedAsWrittenReason('run', endedAsWritten.step)}` +
                (endedAsWritten.line === '' ? '' : ` (${clipLine(endedAsWritten.line)})`),
            }
          : {}),
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

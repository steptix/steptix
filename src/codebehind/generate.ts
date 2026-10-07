import type { AiClient } from '../ai/client.js';
import { normaliseUploadPath } from '../browser/upload-paths.js';
import { MIN_GUARDED_VALUE_LENGTH, findInlinedParameterValue, parseStepCodeOrDecline } from '../ai/action-parser.js';
import {
  buildConditionCodePrompt,
  buildStepCodePrompt,
  buildSystemPrompt,
  formatTestInfo,
  isSingularTarget,
  type ConditionCodePromptInput,
  type LoopContext,
  type StepCodePromptInput,
} from '../ai/prompts.js';
import { parseControlLine } from '../parser/control-line.js';
import { isLiteralCondition } from '../runner/literal-decision.js';
import type { AIAction, ChatMessage } from '../ai/types.js';
import {
  envDataRefsIn,
  interpolateEnvData,
  resolveEnvDataRef,
  type EnvDataContext,
} from '../parser/interpolate-env-data.js';
import { parseFlowControlStep } from '../parser/flow-control-step.js';
import { parseUseAiStep, parseUseStep } from '../parser/use-step.js';
import { WIDE_PLACEHOLDER_SOURCE, dottedThroughRename, interpolate } from '../parser/parameters.js';
import { boundValue } from '../runner/placeholder-substitution.js';
import type { AssertionResult } from '../report/types.js';
import { referencedVariableNames } from '../skills/expander.js';
import { logger } from '../utils/logger.js';
import { EMPTY, MASK, inheritLoopBindings, redact, runSecrets, secretValues } from '../utils/secrets.js';
import { actingCalls, codeText } from './entry-actions.js';
import type { CodeBehindBinding } from './loader.js';
import type { RecordedAction } from './recording.js';
import { CODE, COMMENT, TEMPLATE, matchForward, scan, type StringToken } from './tokenizer.js';

/**
 * Turning one recorded step into its code-behind entry
 * (stories/codebehind-compile.md, "Generate").
 *
 * One model call, given the whole test, the candidate file so far, and the
 * step's transcript with the DOM either side of it. Nothing here touches the
 * filesystem: the compiler splices the answer into its in-memory candidate and
 * only writes once replay is green.
 */

/**
 * Actions that mutate **runner** state rather than the page and have no
 * `ctx` equivalent, so a transcript containing one is not expressible as a
 * `run(ctx)` body.
 *
 * This list used to hold all six tab and browser actions, on the true grounds
 * that an entry had no way to say "the active page is that one now". It does
 * now — `ctx.tabs` and `ctx.browsers` drive the run's own trackers
 * (stories/codebehind-framework-actions.md) — so what is left is the one
 * action that waits on a human at a terminal. There is no code for that.
 */
/**
 * Actions a generated entry cannot express, so a step that used one stays AI.
 *
 * `readTable` is here TEMPORARILY, and the spec says so out loud: it is
 * deterministic and it is meant to compile, through the shared `tables.read`
 * context helper of docs/specs/SPEC-structured-table-reads.md §9.2 — one
 * extractor, shared with the AI action, rather than a second header algorithm
 * the code-generation model invents. That helper is phase 3. Until it exists,
 * a compiled `readTable` would be exactly the reinvention §9.2 forbids, so the
 * step keeps its model call and says why in the entry's comment. Deleting this
 * line is part of phase 3, not a cleanup.
 *
 * TODO(phase 3): remove `'readTable'` when `tables.read` lands (§9.2).
 */
const FRAMEWORK_ACTIONS: ReadonlySet<AIAction['action']> = new Set(['prompt', 'readTable']);

/**
 * Steps whose text opens with a bracket token.
 *
 * `[skill:]` and `[tool:]` are expanded or dispatched before the AI loop, so
 * they cannot reach here anyway. `[output:]`, `[input:]` and `[interactive]`
 * CAN: the runner rewrites the instruction and hands the result to
 * `executeStep`, so the authored text still arrives with its marker. Compiling
 * one would be worse than leaving it alone — a generated entry could quietly
 * stop making the capture or prompt the marker exists for. Code-behind for
 * these is a stated non-goal (stories/step-codebehind.md, "Non-goals");
 * execution of a hand-written entry still works, only generation is refused.
 */
const BRACKET_TOKEN_STEP = /^\[(skill|tool|input|output|interactive)\b/i;

/**
 * The one wording for a `[use computer]` / `[use browser]` line, used by all
 * three classifiers (SPEC-use-computer.md §9).
 *
 * Defined HERE rather than beside `DISPATCHED_NOT_COMPILED` in
 * `live-compile.ts` because `live-compile.ts` imports this module: the reason
 * has to live in the deepest of the three, or the import graph gains a cycle.
 *
 * A surface switch is a run-loop signal, like flow control — it performs
 * nothing on any surface, so there is no transcript to generate an entry from
 * and nothing for an entry to replace. Note this is NOT the other half of §9,
 * the rule that a step which EXECUTED in computer mode compiles to `ai: true`;
 * that is judged from the run's recording, which knows the surface, rather
 * than from the file, which cannot know what surface a shared section ran on.
 */
export const SURFACE_SWITCH_NOT_COMPILED =
  'a [use ...] step is a surface switch, dispatched and never compiled';

/**
 * The one wording for a `[use ai] <step>` line, used by all three classifiers
 * (stories/use-ai-step.md, decision 1) and defined here for the reason
 * {@link SURFACE_SWITCH_NOT_COMPILED} is.
 *
 * Not "dispatched, not compiled" like a `Set`: the difference is the point.
 * A `Set` has nothing to compile because it costs nothing; a `[use ai]` step
 * costs a model call on every run and is kept that way ON PURPOSE — whether a
 * value should be the same every time is the author's decision, and an
 * author who wants that writes a `[tool:]`.
 */
export const USE_AI_NOT_COMPILED = 'a [use ai] step asks the model on every run';

/**
 * A `Set {{name}} to "…"` step's wording, shared by the boxed classifier
 * (`describeSteps`) and the live one (`generationRefusal`), which did not
 * have it — see the latter.
 */
export const SET_STEP_NOT_COMPILED = 'a Set step is dispatched, not compiled';

/**
 * Why a step can't be compiled, or undefined when it can.
 *
 * Checked before the model call so the compiler never pays for an answer it
 * would have to throw away, and so the reason is the same whether the refusal
 * came from the framework or from the model.
 */
export function refuseReason(
  source: string,
  actions: AIAction[],
): string | undefined {
  // Ahead of {@link BRACKET_TOKEN_STEP}, which would otherwise claim it and
  // blame "a bracket marker whose contract generated code cannot honour" — a
  // sentence about captures and prompts that says nothing true about a
  // surface switch.
  if (parseUseStep(source)) {
    return SURFACE_SWITCH_NOT_COMPILED;
  }
  // …and a `[use ai]` step, for the same ordering reason and before the
  // "no page actions" rule below, which would be true and beside the point:
  // the step is never compiled because the author wants the model asked.
  if (parseUseAiStep(source)) {
    return USE_AI_NOT_COMPILED;
  }
  if (BRACKET_TOKEN_STEP.test(source.trim())) {
    return 'the step carries a bracket marker whose contract generated code cannot honour';
  }
  const framework = actions.find((a) => FRAMEWORK_ACTIONS.has(a.action));
  if (framework) {
    return `the step used "${framework.action}", which waits on a person rather than the page`;
  }
  if (actions.length === 0) {
    return 'the recorded run performed no page actions for this step';
  }
  return undefined;
}

export interface GenerateStepEntryOptions {
  binding: CodeBehindBinding;
  /** The recorded run's actions for this step, in execution order, each
   *  carrying the `targeting` the runtime measured for it when there was one
   *  (stories/codebehind-selector-ambiguity.md). */
  actions: RecordedAction[];
  /**
   * Whether ANY action of the whole recording carried a placeholder token
   * (stories/placeholder-preserving-actions.md, decision 6).
   *
   * The exact rule reads what the model NAMED, so it can only be applied to a
   * recording made by a model that was asked to name placeholders. A recording
   * made before that change carries values everywhere — and, for a secret, the
   * redacted `***` — so every reference would look unaccounted and every step
   * with a parameter would decline. False (the default) keeps the old value
   * match for every reference, silently; the caller says so once in the
   * compile's summary. `anyActionCarriesPlaceholder` is the test, applied
   * across the run rather than per step: one step naming a placeholder proves
   * the whole recording is a post-change one.
   */
  recordingCarriesPlaceholders?: boolean | undefined;
  /** Assertions the step evaluated, if any. */
  assertions?: AssertionResult[] | undefined;
  /** Live parameter map from the recording, for resolving `{{param}}`. */
  resolvedParameters: Record<string, string>;
  /**
   * The map whose loop-binding marks decide which dotted names in the
   * prompt's parameter block are a pass's (`row.keyword`, record rule) and
   * which are the author's (`user.apikey`, whole-key rule) — §7.6. The live
   * compiler passes its snapshot, which `liveCompileSnapshot` marks; the
   * boxed compile passes its `passSnapshots` fold, which marks what each
   * pass bound the way `applyPassBindings` does.
   */
  parameterMap?: Record<string, string> | undefined;
  /**
   * The run's free-text mask set (`runSecrets` over that map), so a value no
   * key names as secret still has a secret inside it masked in the prompt —
   * `auth: "Bearer <the key>"`. Both compilers pass it.
   */
  secrets?: string[] | undefined;
  /**
   * The env/data context the test was parsed with, for resolving `${data.url}`
   * and kin (stories/codebehind-env-data.md). Absent when the compile ran
   * without an environment — a step making such a reference is then declined.
   */
  envData?: EnvDataContext | undefined;
  aiClient: AiClient;
  contextContent: string;
  testName: string;
  baseUrl?: string | undefined;
  signal?: AbortSignal | undefined;
  /** Whole-test context — every step, marked with what is being compiled. */
  wholeTest?: Array<{ index: number; text: string; inScope: boolean; isThisStep: boolean }>;
  /** The candidate file as it stands, so selectors and helpers stay consistent. */
  candidateFile?: string | undefined;
  /** Page state either side of the step, from the record's `stepContext`. */
  domBefore?: string | undefined;
  urlBefore?: string | undefined;
  domAfter?: string | undefined;
  urlAfter?: string | undefined;
  /**
   * The runtime loop the step sits in the body of, when it does
   * (stories/codebehind-loops-and-conditions.md, decision 2): the prompt then
   * says the line repeats and names what changes per pass. The caller builds
   * it with {@link loopContextFor}.
   */
  loop?: LoopContext | undefined;
  /**
   * What each capture this step makes held on the evidence pass, by the
   * AUTHORED capture name — RAW, as the run stored it. Both compilers fill it
   * with {@link recordedCapturesOf} from the evidence row's `outputs`. The
   * prompt shows each value (masked, beside its `step.setVar`) as the result
   * the entry must reproduce, and the leak guard refuses an entry that writes
   * it into the code ({@link capturedValueGuards}). Names the step does not
   * capture are ignored.
   */
  recordedCaptures?: Record<string, string> | undefined;
}

/**
 * The captures a step makes, with what each held on one recorded row — by the
 * name the AUTHOR wrote in `[store as: …]`, the name the prompt lists and the
 * entry's `step.setVar` writes.
 *
 * A row's `outputs` are keyed by the name the RUN wrote, which inside a skill
 * body is the frame's rename of the authored one; it is read through the
 * rename first, then by the authored name. A skill-internal `__skill*` capture
 * never reaches `outputs`, so it has no recorded value here and is listed in
 * the prompt by name alone, as before.
 *
 * Only names the step's own line captures: a row's `outputs` can carry a name
 * the step did not declare (a model's own `as`), and the entry is not asked to
 * write that.
 */
export function recordedCapturesOf(
  binding: CodeBehindBinding | undefined,
  outputs: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (binding === undefined || outputs === undefined) return undefined;
  const found: Array<[string, string]> = [];
  for (const name of referencedVariableNames(binding.source).captures) {
    const renamed = boundValue(binding.scope.renames, name);
    const value = (renamed !== undefined ? boundValue(outputs, renamed) : undefined) ?? boundValue(outputs, name);
    if (typeof value === 'string') found.push([name, value]);
  }
  // `fromEntries` defines each key, so a capture named `__proto__` is a key.
  return found.length > 0 ? Object.fromEntries(found) : undefined;
}

/** `recorded`, narrowed to the names in `captures` — or undefined when none is left. */
function recordedFor(
  captures: readonly string[],
  recorded: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (recorded === undefined) return undefined;
  const kept = captures
    .filter((name) => Object.hasOwn(recorded, name) && typeof recorded[name] === 'string')
    .map((name): [string, string] => [name, recorded[name]!]);
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/**
 * What the placeholder rule had to do to let this step compile
 * (stories/placeholder-preserving-actions.md, decision 6).
 *
 * Present on an entry only when there is something to say, so the common case
 * — every reference named by the model — carries no field at all.
 */
export interface PlaceholderReport {
  /**
   * References the model did NOT name and the compile recovered by comparing
   * a recorded literal against the resolved value. Named as written:
   * `email` for `{{email}}`, `${data.url}` for an environment reference.
   *
   * This is the compliance metric, and the only one: it is how "the model
   * names the placeholder most of the time" gets measured rather than
   * trusted.
   */
  recoveredByValue: string[];
  /**
   * The exact rule was not applied to this step because the recording carries
   * no placeholder token anywhere — it predates the change — and the step
   * makes at least one reference the rule would otherwise have judged.
   */
  preChangeFallback: boolean;
}

/** What one generation call produced. */
export type GeneratedEntry =
  /** Code, guard-checked, ready for the candidate. `fromRecording`: written
   *  from the step's recording with no model (§6.6, `entryFromRecording`). */
  | { kind: 'entry'; code: string; references?: PlaceholderReport; fromRecording?: true }
  /** Not expressible as code — becomes an `ai: true` entry with this reason. */
  | { kind: 'declined'; reason: string }
  /**
   * The call itself failed. The compiler reports it and moves on.
   *
   * `refusedCapture` is set only by {@link askForEntry}, when the leak guard
   * refused the answer for writing in a value the RECORDING captured — the
   * one refusal {@link askWithCaptureRetry} re-asks over. It never leaves that
   * helper: the code it holds is the refused answer.
   *
   * `withheld` marks an answer that came back but must not be kept, and must
   * not be replaced by an `ai: true` entry either
   * (docs/specs/SPEC-codebehind-robustness.md §6.2): its code still read with
   * a different selector from the one the run read with after its one
   * re-ask. The step gets NO entry — it runs on AI, which reads what the run
   * read, and the next compile tries it again. Not fatal to any compile.
   */
  | {
      kind: 'error';
      message: string;
      refusedCapture?: { name: string; code: string };
      withheld?: true;
    };

/**
 * One value the leak guard refuses to see in generated code.
 *
 * `captured` marks a value the RECORDING captured ({@link capturedValueGuards})
 * rather than one the step was given: it is matched as a whole token, and an
 * answer it refuses is worth one re-ask. Everything else — a parameter, an
 * environment value — is the guard as it always was.
 */
export interface GuardedValue {
  name: string;
  value: string;
  captured?: true;
}

/** Generate one entry. Never throws — a failed call is a result, not a crash. */
export async function generateStepEntry(
  options: GenerateStepEntryOptions,
): Promise<GeneratedEntry> {
  const { binding } = options;

  const refused = refuseReason(binding.source, options.actions);
  if (refused) return { kind: 'declined', reason: refused };

  const parameters = stepParameters(binding, options.resolvedParameters, options.envData);
  const { captures } = referencedVariableNames(binding.source);
  const envRefs = stepEnvRefs(binding, options.envData);
  // A reference the run cannot answer is declined before the model is asked:
  // the code it would write calls `getVar` for a value that does not exist,
  // and the replay would only discover that one round later.
  if (envRefs.unresolved.length > 0) {
    return { kind: 'declined', reason: unresolvedRefsReason(envRefs.unresolved, options.envData) };
  }
  // The same rule for a caller ARGUMENT that is an env-data reference: the
  // frame's `inputs` carry the argument raw (interpolation runs after
  // expansion), and a mapping the run cannot resolve would put the raw
  // placeholder in front of the model and the leak guard alike.
  const unresolvedInputs = unresolvedInputRefs(binding, options.resolvedParameters, options.envData);
  if (unresolvedInputs.length > 0) {
    return { kind: 'declined', reason: unresolvedRefsReason(unresolvedInputs, options.envData) };
  }
  // The exact rule (stories/placeholder-preserving-actions.md, decisions 5 and
  // 6). Last of the pre-checks, because it is the most specific: a step that
  // could never be code at all, or whose environment reference this run cannot
  // answer, deserves the reason it actually failed on rather than "the model
  // did not name a placeholder".
  const accounting = accountPlaceholders({
    binding,
    actions: options.actions,
    resolvedParameters: options.resolvedParameters,
    ...(options.envData && { envData: options.envData }),
    recordingCarriesPlaceholders: options.recordingCarriesPlaceholders === true,
  });
  if (accounting.decline !== undefined) {
    return { kind: 'declined', reason: accounting.decline };
  }
  for (const name of accounting.recoveredByValue) {
    logger.debug(`Code-behind for "${binding.source}": ${valueMatchWarning(name)}`);
  }
  const references: PlaceholderReport | undefined =
    accounting.recoveredByValue.length > 0 || accounting.preChangeFallback
      ? { recoveredByValue: accounting.recoveredByValue, preChangeFallback: accounting.preChangeFallback }
      : undefined;
  /** Carry the accounting out on whatever entry the model ends up producing. */
  const reported = (result: GeneratedEntry): GeneratedEntry =>
    result.kind === 'entry' && references !== undefined ? { ...result, references } : result;
  // What the recording captured, for the captures this line declares.
  const recordedCaptures = recordedFor(captures, options.recordedCaptures);

  const promptInput: StepCodePromptInput = {
    rawStepText: binding.source,
    parameters,
    ...(options.parameterMap && { parameterMap: options.parameterMap }),
    ...(options.secrets && options.secrets.length > 0 && { secrets: options.secrets }),
    ...(envRefs.resolved.length > 0 && { envRefs: envRefs.resolved }),
    actions: options.actions,
    ...(options.assertions && options.assertions.length > 0 && {
      assertions: options.assertions.map((a) => ({
        condition: a.condition,
        expected: a.expected,
        actual: a.actual,
        pass: a.pass,
      })),
    }),
    ...(captures.length > 0 && { captures }),
    ...(recordedCaptures && { recordedCaptures }),
    testInfoSection: formatTestInfo(options.testName, options.baseUrl),
    ...(options.wholeTest && { wholeTest: options.wholeTest }),
    ...(options.candidateFile !== undefined && { candidateFile: options.candidateFile }),
    ...(options.domBefore !== undefined && { domBefore: options.domBefore }),
    ...(options.urlBefore !== undefined && { urlBefore: options.urlBefore }),
    ...(options.domAfter !== undefined && { domAfter: options.domAfter }),
    ...(options.urlAfter !== undefined && { urlAfter: options.urlAfter }),
    ...(options.loop && { loop: options.loop }),
  };
  // The authored line goes in so a value the author quoted in it is not read
  // as a leak: see `guardedValues` / `authorQuotedLiterals`. The recorded
  // captures join it: an entry that stores the recording's answer as a
  // constant (`step.setVar('accounts', '["Everyday",…]')`) passes on every
  // replay of a page that happens to agree, and captures nothing.
  const guarded: GuardedValue[] = [
    ...guardedValues(parameters, envRefs.resolved, binding.source),
    ...capturedValueGuards(recordedCaptures, binding.source),
  ];
  return reported(
    await askChecked(
      options.aiClient,
      options.contextContent,
      (retry) => buildStepCodePrompt({ ...promptInput, ...(retry && { retry }) }),
      guarded,
      {
        binding,
        actions: options.actions,
        substitute: stepSubstitution(binding, options.resolvedParameters, options.envData),
        ...(recordedCaptures && { recordedCaptures }),
        ...(options.secrets && { secrets: options.secrets }),
      },
      options.signal,
    ),
  );
}

/**
 * Every value a step's references resolved to, keyed by the name the MODEL
 * would have written in an action: the authored name, the run-time name a
 * skill rename gave it, and each `${…}` reference. Reads a placeholder-bearing
 * selector the way the runtime read it — see `ambiguousSelectorComplaint` and
 * `recordedReadMismatch`. Exported for the review pass, which checks a
 * revision against the values of the pass each entry was generated from.
 */
export function stepSubstitution(
  binding: CodeBehindBinding,
  resolvedParameters: Record<string, string>,
  envData?: EnvDataContext | undefined,
): (text: string) => string {
  const parameters = stepParameters(binding, resolvedParameters, envData);
  const envRefs = stepEnvRefs(binding, envData).resolved;
  const values = { ...resolvedParameters, ...Object.fromEntries(parameters.map((p) => [p.name, p.value])) };
  return (text: string): string => applyKnownValues(text, values, envRefs);
}

/** What one entry answer is checked against before it is kept. */
export interface EntryCheckContext {
  binding: CodeBehindBinding;
  /** The recorded run's actions for the step — the pass the answer is for. */
  actions: RecordedAction[];
  /** {@link stepSubstitution} for that pass. */
  substitute?: ((text: string) => string) | undefined;
  /** What the pass captured, by authored name — for the read check's words. */
  recordedCaptures?: Record<string, string> | undefined;
  /** The run's mask set, applied to anything the checks quote. */
  secrets?: readonly string[] | undefined;
}

/**
 * The static backstops an entry answer goes through, one re-ask shared between
 * them, and which answer wins (docs/specs/SPEC-codebehind-robustness.md §6.2).
 * Generation and both compilers' repairs come through here, so a repaired
 * entry is held to what a generated one is.
 *
 * All of the checks are for the case the prompt cannot cover: the model was
 * told the thing and wrote it the other way anyway. Two grades:
 *
 *  - **The read check** ({@link recordedReadMismatch}). A read with a
 *    different selector does not throw; it returns different data, and no
 *    later step can tell. An answer that still fails it after the one re-ask
 *    is WITHHELD: the step gets no entry at all. Keeping it would replay a
 *    wrong read; an `ai: true` entry would keep the step on AI for good.
 *  - **The others** — selector ambiguity (it throws on replay, so it is
 *    self-announcing), a literal upload path, an undeclared context property,
 *    a stale tab handle (it drives the wrong tab and PASSES), a read that
 *    races its own action. One re-ask, then take what we get, warned about.
 *
 * Which answer is kept:
 *
 * | First answer              | Re-ask                               | Kept                     |
 * |---------------------------|--------------------------------------|--------------------------|
 * | passes every check        | (not asked)                          | first                    |
 * | fails the read check      | fixes it                             | re-ask (warned)          |
 * | fails the read check      | still fails it, or no entry          | neither: withheld        |
 * | fails another check only  | keeps the read                       | re-ask (warned)          |
 * | fails another check only  | breaks the read, or no entry         | first (warned)           |
 *
 * A recorded value written into the answer costs the one re-ask first, before
 * anything else looks at it (`askWithCaptureRetry`). If that one was spent,
 * the static faults are said rather than asked about — except a failed read,
 * which is withheld.
 */
async function askChecked(
  aiClient: AiClient,
  contextContent: string,
  prompt: (retry?: EntryRetry) => ChatMessage,
  guarded: readonly GuardedValue[],
  checks: EntryCheckContext,
  signal?: AbortSignal | undefined,
): Promise<GeneratedEntry> {
  const label = checks.binding.source;
  const asked = await askWithCaptureRetry(aiClient, contextContent, prompt, guarded, signal);
  const first = asked.result;
  if (first.kind !== 'entry') return first;

  const readFault = (code: string): ReadMismatch | undefined =>
    recordedReadMismatch(code, checks.actions, {
      source: checks.binding.source,
      ...(checks.substitute && { substitute: checks.substitute }),
      ...(checks.recordedCaptures && { recordedCaptures: checks.recordedCaptures }),
      ...(checks.secrets && { secrets: checks.secrets }),
    });
  const otherFault = (code: string): string | undefined =>
    staticEntryComplaint(code, checks.actions, checks.substitute) ??
    undeclaredContextComplaint(code) ??
    staleHandleComplaint(code) ??
    unwaitedReadComplaint(code) ??
    selfCheckInActingEntryComplaint(code) ??
    unwaitedNavigationComplaint(code, checks.actions, checks.secrets);

  const firstRead = readFault(first.code);
  const firstOther = otherFault(first.code);
  if (firstRead === undefined && firstOther === undefined) return first;

  if (asked.reasked) {
    if (firstRead !== undefined) return withheldForRead(label, firstRead, 'its one re-ask went to a recorded value it had written in');
    logger.warn(
      `Code-behind for "${label}" has a fault the static check can see, and its one ` +
        `re-ask went to a recorded value it had written in. ${firstOther}`,
    );
    return first;
  }

  const complaint = [firstRead?.complaint, firstOther].filter((c) => c !== undefined).join('\n\n');
  // Said at info, in a line: a re-ask is a second model call, and how often
  // a compile needs one is what decides which model it should use
  // (docs/specs/SPEC-codebehind-robustness.md §6.10). The whole complaint stays
  // at debug.
  logger.info(`Code-behind for "${label}" was asked once more: ${firstSentence(complaint)}`);
  logger.debug(`Code-behind re-asking for "${label}": ${complaint}`);
  const second = await askForEntry(
    aiClient,
    contextContent,
    prompt({ previousEntry: first.code, complaint }),
    guarded,
    signal,
  );

  // ONE re-ask, then decide. The second answer is never re-asked about, so
  // this cannot spin. A re-ask that errors (the call failed, or the new code
  // tripped the leak guard) or declines falls back to the first answer — unless
  // that one read with the wrong selector, which no fallback can keep.
  if (second.kind !== 'entry') {
    const why = second.kind === 'error' ? second.message : second.reason;
    if (firstRead !== undefined) return withheldForRead(label, firstRead, `the re-ask produced no entry (${why})`);
    logger.debug(`The re-ask for "${label}" produced no entry (${why}); keeping the first answer`);
    return first;
  }
  const secondRead = readFault(second.code);
  if (secondRead !== undefined) {
    if (firstRead !== undefined) return withheldForRead(label, secondRead, 'the re-ask still did');
    // The re-ask broke the read the first answer had right: the first answer
    // stands, with the fault it was re-asked about said out loud.
    logger.warn(
      `Code-behind for "${label}": the re-ask changed the selector the run read with, so the first ` +
        `answer is kept. ${firstOther ?? ''}`.trimEnd(),
    );
    return first;
  }
  warnRemainingFaults(second.code, label, checks);
  return second;
}

/** A complaint's first sentence, for a one-line log. */
function firstSentence(text: string): string {
  const line = text.split('\n')[0]!.trim();
  const end = /\.(?:\s|$)/.exec(line);
  const sentence = end ? line.slice(0, end.index + 1) : line;
  return sentence.length > 240 ? `${sentence.slice(0, 239)}…` : sentence;
}

/** The withheld outcome for a read that did not keep the run's selector. */
function withheldForRead(
  label: string,
  mismatch: ReadMismatch,
  why: string,
): GeneratedEntry {
  logger.warn(
    `Code-behind for "${label}" was not written: ${READ_SELECTOR_WITHHELD} ` +
      `(${mismatch.selector}), and ${why}. The step stays AI; the next compile tries again.`,
  );
  return {
    kind: 'error',
    message: `${READ_SELECTOR_WITHHELD} (${mismatch.selector})`,
    withheld: true,
  };
}

/**
 * Why a step is left without code when its read did not keep the run's
 * selector — the words both compilers' summaries and notes carry
 * (docs/specs/SPEC-codebehind-robustness.md §6.2).
 */
export const READ_SELECTOR_WITHHELD = 'its code did not read with the selector the run used';

/** Today's warnings for faults an answer kept after its re-ask still has. */
function warnRemainingFaults(code: string, label: string, checks: EntryCheckContext): void {
  const stillWrong = staticEntryComplaint(code, checks.actions, checks.substitute);
  if (stillWrong !== undefined) {
    logger.warn(
      `Code-behind for "${label}" still has a fault the static check can see; ` +
        `it may throw or hard-code a path on replay. ${stillWrong}`,
    );
  }
  const stillUndeclared = undeclaredContextComplaint(code);
  if (stillUndeclared !== undefined) {
    logger.warn(
      `Code-behind for "${label}" still uses a context property it does not ` +
        `destructure; it will throw on replay. ${stillUndeclared}`,
    );
  }
  const stillStale = staleHandleComplaint(code);
  if (stillStale !== undefined) {
    logger.warn(
      `Code-behind for "${label}" still uses \`page\` after switching tab or browser; ` +
        `it may drive the tab the step left. ${stillStale}`,
    );
  }
  const stillUnwaited = unwaitedReadComplaint(code);
  if (stillUnwaited !== undefined) {
    logger.warn(
      `Code-behind for "${label}" still asserts on a page value it never waited for; ` +
        `it may read the state from before the step. ${stillUnwaited}`,
    );
  }
  const stillSelfCheck = selfCheckInActingEntryComplaint(code);
  if (stillSelfCheck !== undefined) {
    logger.warn(
      `Code-behind for "${label}" still self-checks in an entry that acts; the runtime fails that ` +
        `check as an assertion. ${stillSelfCheck}`,
    );
  }
  const stillUnwaitedNavigation = unwaitedNavigationComplaint(code, checks.actions, checks.secrets);
  if (stillUnwaitedNavigation !== undefined) {
    logger.warn(
      `Code-behind for "${label}" still does not wait after an action that leads to another page; ` +
        `the runtime's own wait after the entry is all that covers it. ${stillUnwaitedNavigation}`,
    );
  }
}

/** One static check's finding about one entry. */
export interface EntryFault {
  check:
    | 'read'
    | 'ambiguous-selector'
    | 'upload-path'
    | 'undeclared-context'
    | 'stale-handle'
    | 'unwaited-read'
    | 'self-check-in-acting-entry'
    | 'unwaited-navigation';
  complaint: string;
  /** The recorded selector, for a `read` fault. */
  selector?: string;
}

/**
 * Every static fault of one entry, by check — what the review pass compares
 * before and after a revision (docs/specs/SPEC-codebehind-robustness.md §6.2):
 * a revision may not bring into an entry a fault the generated entry did not
 * have. The checks that need the recording — the read check, selector
 * ambiguity, a literal upload path — run only when `actions` are given.
 */
export function entryFaults(
  code: string,
  ctx: {
    source: string;
    actions?: readonly RecordedAction[] | undefined;
    substitute?: ((text: string) => string) | undefined;
    recordedCaptures?: Record<string, string> | undefined;
    secrets?: readonly string[] | undefined;
  },
): EntryFault[] {
  const actions = [...(ctx.actions ?? [])];
  const out: EntryFault[] = [];
  const read = recordedReadMismatch(code, actions, {
    source: ctx.source,
    ...(ctx.substitute && { substitute: ctx.substitute }),
    ...(ctx.recordedCaptures && { recordedCaptures: ctx.recordedCaptures }),
    ...(ctx.secrets && { secrets: ctx.secrets }),
  });
  if (read) out.push({ check: 'read', complaint: read.complaint, selector: read.selector });
  const found: Array<[EntryFault['check'], string | undefined]> = [
    ['ambiguous-selector', ambiguousSelectorComplaint(code, actions, ctx.substitute)],
    ['upload-path', literalUploadPathComplaint(code, actions)],
    ['undeclared-context', undeclaredContextComplaint(code)],
    ['stale-handle', staleHandleComplaint(code)],
    ['unwaited-read', unwaitedReadComplaint(code)],
    ['self-check-in-acting-entry', selfCheckInActingEntryComplaint(code)],
    ['unwaited-navigation', unwaitedNavigationComplaint(code, actions, ctx.secrets)],
  ];
  for (const [check, complaint] of found) {
    if (complaint !== undefined) out.push({ check, complaint });
  }
  return out;
}

/**
 * A REPAIR answer, held to what a generated one is
 * (docs/specs/SPEC-codebehind-robustness.md §6.2): the leak guard and its
 * recorded-value re-ask as before, then generation's static checks — the read
 * check included — with the same one re-ask, the same precedence and the same
 * withheld outcome. Under §6.5 this is the path a wrong read is regenerated
 * through, so it cannot be the one path that never looks at the read.
 *
 * `prompt` builds the repair prompt; its `retry` block carries the complaint.
 */
export async function askCheckedRepair(
  aiClient: AiClient,
  contextContent: string,
  prompt: (retry?: EntryRetry) => ChatMessage,
  guarded: readonly GuardedValue[],
  checks: EntryCheckContext,
  signal?: AbortSignal | undefined,
): Promise<GeneratedEntry> {
  return askChecked(aiClient, contextContent, prompt, guarded, checks, signal);
}

// ───────────────────────────────────────────────────────────────────────────
// The read check (docs/specs/SPEC-codebehind-robustness.md §6.2)
// ───────────────────────────────────────────────────────────────────────────

/** A recorded read the entry does not read with, and the re-ask's words. */
export interface ReadMismatch {
  /** The recorded selector, masked. */
  selector: string;
  complaint: string;
}

/**
 * The first recorded `read` or `count` whose selector the entry does not
 * contain, or undefined when it reads with every one of them.
 *
 * Reads are the one action where a wrong selector fails silently: a click on
 * the wrong element throws or visibly does the wrong thing, while a read that
 * matches more elements, or fewer, just returns different data. Failure B of
 * the robustness spec read each account row's name AND its masked number —
 * six values for three rows — because a rewrite dropped one `:first-child`.
 *
 * "Contains" is textual, and compares what the run read with against what the
 * code holds as a string — single- or double-quoted, or a template literal —
 * after normalising whitespace and quote style. Accepted spellings: the
 * selector as recorded, after parameter substitution, or the action's verified
 * `targeting.resolvedSelector`; a selector split across a chain
 * (`frameLocator(a).locator(b)`, `locator(a).locator(b)`) counts when every
 * part is there. A template literal whose only expressions are
 * `step.getVar('name')` is read as `{{name}}` and substituted, so a locator
 * built from a parameter matches a recording that holds the parameter's value.
 *
 * What it cannot tell: whether a DIFFERENT selector would have read the same
 * elements. `#account-list .account-name` would have; it is refused all the
 * same — the run is the only reference compile has, and the cost of refusing
 * an equivalent is one re-ask.
 *
 * Two exemptions:
 *  - a selector holding a `{{placeholder}}` or `${…}`: the entry builds it from
 *    `step.getVar`, and the placeholder rule judges that;
 *  - the selector story's carve-out: a read whose `resolvedBy` is `positional`
 *    while the step names what distinguishes its target — a parameter, or a
 *    quoted value — where the entry must build a data-driven locator
 *    instead (stories/codebehind-selector-ambiguity.md, "What generation does
 *    with it").
 */
export function recordedReadMismatch(
  code: string,
  actions: readonly RecordedAction[],
  ctx: {
    /** The step's authored line, for the positional carve-out. */
    source: string;
    substitute?: (text: string) => string;
    recordedCaptures?: Record<string, string>;
    secrets?: readonly string[];
  },
): ReadMismatch | undefined {
  let held: Set<string> | undefined;
  const asked = new Set<string>();
  for (const action of actions) {
    if (action.action !== 'read' && action.action !== 'count') continue;
    const selector = action.selector;
    if (typeof selector !== 'string' || selector.trim() === '') continue;
    if (ANY_PLACEHOLDER_RE.test(selector) || envDataRefsIn(selector).length > 0) continue;
    if (action.targeting?.resolvedBy === 'positional' && namesItsTarget(ctx.source)) continue;
    if (asked.has(selector)) continue;
    asked.add(selector);

    held ??= selectorStringsIn(code, ctx.substitute);
    const spellings = [selector, ctx.substitute?.(selector), action.targeting?.resolvedSelector]
      .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
      .map(normaliseSelector);
    if (spellings.some((s) => coveredBy(s, held!))) continue;

    const masked = redact(selector, [...(ctx.secrets ?? [])]);
    return { selector: masked, complaint: readMismatchComplaint(action, masked, ctx) };
  }
  return undefined;
}

/** Does the step name what distinguishes its target — a parameter, an
 *  environment reference, or a value the author quoted? */
function namesItsTarget(source: string): boolean {
  return (
    placeholderNamesIn(source).length > 0 ||
    envDataRefsIn(source).length > 0 ||
    authorQuotedLiterals(source).size > 0
  );
}

/** The re-ask's words for one read the entry does not keep. */
function readMismatchComplaint(
  action: RecordedAction,
  selector: string,
  ctx: { recordedCaptures?: Record<string, string>; secrets?: readonly string[] },
): string {
  const counts = action.action === 'count';
  const matched = action.targeting?.matchCount;
  const captured = counts ? undefined : capturedCount(action, ctx.recordedCaptures);
  const facts = [
    matched !== undefined ? `matched ${matched} element${matched === 1 ? '' : 's'}` : '',
    captured !== undefined ? `captured ${captured === 1 ? 'one value' : `${captured} values`}` : '',
  ].filter(Boolean).join(' and ');
  const resolved = action.targeting?.resolvedSelector;
  return (
    `The recorded run ${counts ? 'counted' : 'read'} with \`${selector}\`${facts ? `, which ${facts}` : ''}. ` +
    `Your entry ${counts ? 'counts' : 'reads'} with a different selector. A ${counts ? 'count' : 'read'} ` +
    'that matches more or fewer elements does not throw; it returns different data. Use the recorded ' +
    `selector as written${resolved !== undefined ? ` (or its verified resolvedSelector \`${redact(resolved, [...(ctx.secrets ?? [])])}\`)` : ''} — ` +
    'every part of it, `:first-child` and `:nth-of-type` included. Narrow or wait around it if you need ' +
    'to, but read with it.'
  );
}

/** How many values the run captured for this read, when the step captured it. */
function capturedCount(
  action: RecordedAction,
  recorded: Record<string, string> | undefined,
): number | undefined {
  if (recorded === undefined || typeof action.as !== 'string') return undefined;
  const names = [action.as, action.as.replace(/^__skill\d+_/, '')];
  const name = names.find((n) => Object.hasOwn(recorded, n));
  if (name === undefined) return undefined;
  const value = recorded[name]!;
  const items = jsonStringItems(value);
  if (items.length > 0 || /^\s*\[\s*\]\s*$/.test(value)) return items.length;
  return 1;
}

/** A selector in the one spelling two equal selectors share: whitespace runs
 *  collapsed, none around a combinator, single quotes as double. */
function normaliseSelector(selector: string): string {
  return selector
    .trim()
    .replace(/'/g, '"')
    .replace(/\s+/g, ' ')
    .replace(/\s*(>>|[>+~,])\s*/g, '$1');
}

/**
 * Is `selector` (normalised) one of `held`, or a chain of them — a head that is
 * held, then a descendant combinator or a `>>`, then a tail that is covered in
 * turn? What `page.locator(a).locator(b)` and a frame's `frameLocator(a)
 * .locator(b)` read with, where the run wrote `a b`.
 */
function coveredBy(selector: string, held: ReadonlySet<string>): boolean {
  if (held.has(selector)) return true;
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]!;
    if (quote !== undefined) {
      if (c === '\\') i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"') {
      quote = c;
      continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (depth !== 0) continue;
    const split =
      c === ' ' ? { head: i, tail: i + 1 } : selector.startsWith('>>', i) ? { head: i, tail: i + 2 } : undefined;
    if (split === undefined) continue;
    const head = selector.slice(0, split.head);
    if (head !== '' && held.has(head) && coveredBy(selector.slice(split.tail), held)) return true;
  }
  return false;
}

/**
 * Every string the entry holds that could be a selector, normalised: each
 * single- or double-quoted literal, and each template literal that is plain
 * text or whose only expressions are `step.getVar('name')` — read as
 * `{{name}}`, then substituted the way the recording's selector is.
 */
function selectorStringsIn(
  code: string,
  substitute: ((text: string) => string) | undefined,
): Set<string> {
  const s = scan(code);
  const out = new Set<string>();
  for (const token of s.strings) out.add(normaliseSelector(token.value));
  for (let i = 0; i < code.length; i++) {
    if (s.mask[i] !== TEMPLATE || code[i] !== '`' || (i > 0 && s.mask[i - 1] === TEMPLATE)) continue;
    let end = i + 1;
    while (end < code.length && s.mask[end] === TEMPLATE) end++;
    const body = code
      .slice(i + 1, end - 1)
      .replace(
        /\$\{\s*(?:await\s+)?step\s*\.\s*getVar\s*\(\s*(['"])([^'"]+)\1\s*\)\s*!?\s*(?:\?\?\s*(?:''|""))?\s*\}/g,
        (_m, _q: string, name: string) => `{{${name}}}`,
      );
    if (body.includes('${')) continue;
    out.add(normaliseSelector(body));
    if (substitute) out.add(normaliseSelector(substitute(body)));
    i = end - 1;
  }
  return out;
}

/**
 * Every static fault worth one re-ask, in the order they are checked.
 *
 * Selector ambiguity comes first deliberately: it is the fault the model gets
 * wrong more often, and a bare selector throws on replay where a literal path
 * merely breaks on the next machine.
 */
export function staticEntryComplaint(
  code: string,
  actions: RecordedAction[],
  substitute?: ((text: string) => string) | undefined,
): string | undefined {
  return (
    ambiguousSelectorComplaint(code, actions, substitute) ??
    literalUploadPathComplaint(code, actions)
  );
}

/**
 * `setInputFiles('attachments/logo.png')` — a path frozen into the file.
 *
 * Generated code must route every upload path through `step.filePath(...)`,
 * which resolves it against the TEST FILE's folder at replay time. A literal
 * is resolved by Playwright against the server process's working directory
 * instead, so the entry works on the machine that compiled it and fails
 * everywhere else — the exact portability failure code-behind exists to avoid.
 * An absolute literal is the same fault, caught by the same check.
 */
const LITERAL_FILE_ARG = /\.\s*(?:setInputFiles|setFiles)\s*\(\s*(['"`]|\[\s*['"`])/;

export function literalUploadPathComplaint(
  code: string,
  actions: RecordedAction[],
): string | undefined {
  if (!actions.some((a) => a.action === 'upload')) return undefined;
  if (!LITERAL_FILE_ARG.test(code)) return undefined;
  return (
    'The entry passes a string literal to setInputFiles/setFiles. An upload path in a step is '
    + "relative to the test file's folder, so it must go through step.filePath('…') — which "
    + 'resolves it at replay time and fails loudly if the file is missing. A literal path (relative '
    + 'or absolute) only works on the machine that compiled it.'
  );
}

/**
 * Why this entry must not be written as it stands, or undefined when it may.
 *
 * The deterministic half of the selector rule: the transcript measured more
 * than one match for a singular action, and the generated entry uses that
 * exact selector bare — no `resolvedSelector`, no `.first()`, no scoping — so
 * strict mode throws on the second match the moment it replays. Costs nothing,
 * needs no model, and covers the case the prompt cannot: the model read the
 * measurement and ignored it.
 *
 * It fires only when a count is present, and only for a SINGULAR action —
 * `read multiple` and `count` record a `matchCount` too, and many matches is
 * their purpose. Absence means the check does not run, never that it fails —
 * the same first-class absence the prompt rule has.
 *
 * Deliberately one-directional in what it will miss: the receiver has to be
 * `page`/`frame` itself, so anything already chained off a scoped locator is
 * left alone, and a narrowing later in the same statement (or on the variable
 * the locator was bound to) counts. It can still ask again about an entry that
 * narrows on some further line — one model call, no correctness lost, and the
 * caller keeps the first answer if the second is no better.
 */
export function ambiguousSelectorComplaint(
  code: string,
  actions: RecordedAction[],
  substitute?: ((text: string) => string) | undefined,
): string | undefined {
  let strings: StringToken[] | undefined;
  for (const action of actions) {
    const selector = action.selector;
    const count = action.targeting?.matchCount;
    if (selector === undefined || count === undefined || count <= 1) continue;
    if (!isSingularTarget(action)) continue;
    strings ??= scan(code).strings;
    // Both spellings (stories/placeholder-preserving-actions.md §"Generator
    // and compile"): a model that named the placeholder records
    // `text={{plan}}` while the code it writes — and the measurement beside
    // it — is the concrete `text=Premium`. Comparing only the recorded
    // spelling makes the whole check blind on exactly the steps placeholders
    // were introduced for.
    const substituted = substitute?.(selector);
    const spellings =
      substituted !== undefined && substituted !== selector ? [selector, substituted] : [selector];
    if (!strings.some((token) => spellings.includes(token.value) && isBareUse(code, token))) continue;

    const resolved = action.targeting?.resolvedSelector;
    return (
      `The entry uses ${JSON.stringify(selector)} bare, but this run measured ${count} elements ` +
      `matching it — generated code is strict and throws on the second. ` +
      (resolved !== undefined
        ? `Use the verified resolvedSelector ${JSON.stringify(resolved)}`
        : `Scope it to an ancestor that makes it unique`) +
      `, or reproduce the runtime's tolerance with .locator('visible=true').first().`
    );
  }
  return undefined;
}

/**
 * A call that changes which tab or browser is active, and therefore makes the
 * `page` the entry destructured a handle on somewhere the step has left.
 * `tabs.list`, `tabs.active` and the two `list()`s are absent on purpose —
 * they read, they do not move.
 */
const SWITCHER_CALL =
  /(?:^|[^\w$.])(?:tabs\s*\.\s*(?:open|openedBy|switchTo|close)|browsers\s*\.\s*(?:open|switchTo))\s*\(/;

/** A use of the stale handle: any property access on the bare `page` or
 *  `context` binding. `page.url()` is included — after a switch it reports the
 *  tab the step left, which is exactly the wrong answer to log or assert on. */
const STALE_HANDLE_USE = /(?:^|[^\w$.])(page|context)\s*\.\s*\w/;

/**
 * Why this entry must not be written as it stands, or undefined when it may —
 * the stale-handle half (stories/codebehind-framework-actions.md, "Two static
 * backstops").
 *
 * `run({ page })` destructures, and destructuring reads once. After
 * `await tabs.switchTo(...)` the `page` binding still points at the tab the
 * step left, so `page.locator(...)` on the next line silently drives the wrong
 * tab — and passes, because the old tab is still a real page with real
 * content. Nothing throws. That is what makes this worth a static check
 * rather than trusting the replay to catch it.
 *
 * Line-based, and deliberately one-directional in what it misses: a `page` use
 * BEFORE the first switcher is correct and left alone (it is how `openedBy`'s
 * own trigger is written), a handle passed into a helper is not tracked, and
 * two statements on one line read as one. Catching the common case for free
 * beats catching every case with a parser — and the caller keeps the first
 * answer if the re-ask comes back no better.
 */
export function staleHandleComplaint(code: string): string | undefined {
  const lines = code.split('\n');
  const switchedAt = lines.findIndex((line) => SWITCHER_CALL.test(line));
  if (switchedAt === -1) return undefined;
  // The switching line itself may legitimately mention `page` — it is where
  // `openedBy(() => page.click(...))` lives, and the trigger runs before the
  // tab exists.
  for (let i = switchedAt + 1; i < lines.length; i++) {
    const match = STALE_HANDLE_USE.exec(lines[i]!);
    if (!match) continue;
    const handle = match[1];
    return (
      `The entry calls a tab or browser switcher and then uses \`${handle}\` on a later line. ` +
      `\`run({ page })\` destructures once, so that binding still points at the tab the step ` +
      `left — it will drive the wrong tab and pass. Name the page the switcher returned ` +
      `(\`const opened = await tabs.switchTo(...)\`) and use that handle instead.`
    );
  }
  return undefined;
}

/** Reads that take whatever the DOM holds at that instant. None of them
 *  retries, so each is only as correct as the wait in front of it. `title()`
 *  and `isVisible()` joined after failure A of
 *  docs/specs/SPEC-codebehind-robustness.md §3.1: a sign-in click's entry read
 *  both 57 ms after the click and passed on the page it was leaving. */
const INSTANT_READ =
  /\.\s*(?:textContent|innerText|innerHTML|inputValue|allTextContents|allInnerTexts|getAttribute|title|url|isVisible|isHidden|isEnabled|isDisabled|isChecked|isEditable|count)\s*\(/g;

/**
 * Constructs that block until the page reaches a NAMED state.
 *
 * A bare `waitFor()` is deliberately not one of them, and neither is
 * `waitFor({ state: 'visible' })`: `visible` is the default, and on an element
 * that is already on the page it returns at once having proved nothing. The
 * transition states (`hidden`, `attached`, `detached`) are real waits, as are
 * a text filter, a predicate, and a response.
 */
const WAITS_FOR_STATE = new RegExp(
  [
    'hasText',
    'hasNotText',
    'waitForFunction',
    'waitForSelector',
    'waitForResponse',
    'waitForRequest',
    'waitForURL',
    'waitForLoadState',
    String.raw`waitFor\s*\(\s*\{[^}]*state\s*:\s*['"](?:hidden|attached|detached)['"]`,
    String.raw`\.\s*goto\s*\(`,
    'toHaveText',
    'toContainText',
    'toHaveValue',
    'toHaveCount',
    // The wait after an action, on the entry's own watcher
    // (docs/specs/SPEC-codebehind-robustness.md §6.4): every first-party
    // request the action started, then the page quiet.
    String.raw`\bstep\s*\.\s*settle\s*\(`,
  ].join('|'),
);

/**
 * Why this entry must not be written as it stands, or undefined when it may —
 * the read-that-does-not-wait case (stories/upload-action.md, "The compiled
 * post-condition has to wait").
 *
 * The shape: the entry pulls a value out of the page with a one-shot read and
 * feeds it to `step.expect`, having never waited for the state it is about to
 * assert. `step.expect` does not retry and the read does not either, so the
 * comparison happens milliseconds after the click that triggered the change —
 * with the request that produces it still in flight. It reads the value the
 * page had BEFORE the step and fails.
 *
 * It is invisible under AI, which is what makes it worth a static check: the
 * runner settles the page after each action and the next model turn costs
 * seconds of think time, so the value has always arrived by the time the AI
 * looks. Only the compiled entry is fast enough to lose. Measured on
 * `securebank-upload.md`, whose `#upload-status` is one element that keeps the
 * PREVIOUS step's message: the assertion read "All documents cleared" while
 * the upload it was asserting on was still uploading.
 *
 * Conservative in both directions. It needs a `step.expect` AND an instant
 * read AND no state wait anywhere in the entry, so an entry that waits on some
 * unrelated line is left alone — and, like its siblings, absence of the
 * pattern means the check did not run, never that the entry is proven safe.
 *
 * And it fires only on a read that comes AFTER an action (`actingCalls`,
 * docs/specs/SPEC-codebehind-robustness.md §6.3). The fault is a read racing
 * what the entry's own action caused; an entry that takes no action caused
 * nothing, and the runner has already settled the page before it. Firing on
 * one anyway is what started failure B of that spec: a read-only capture was
 * re-asked, rewritten, and lost the selector the recording read with.
 */
export function unwaitedReadComplaint(code: string): string | undefined {
  // `step.check` is an assertion too (§6.5) — and it never belongs after an
  // action, which `selfCheckInActingEntryComplaint` says separately.
  if (!/\bstep\s*\.\s*(?:expect|check)\s*\(/.test(code)) return undefined;
  if (WAITS_FOR_STATE.test(code)) return undefined;
  const action = actingCalls(code)[0];
  if (action === undefined) return undefined;
  const text = codeText(code);
  const readAfter = [...text.matchAll(INSTANT_READ)].some((m) => m.index! > action.index);
  if (!readAfter) return undefined;
  return (
    `The entry acts on the page (\`${action.call}\`) and then reads a value out of it and asserts on `
    + 'it, without ever waiting for the state it asserts. `step.expect` does not retry and the read '
    + 'does not either, so on replay this compares whatever the page held a millisecond after the '
    + 'action — which, when a request is still in flight, is the value from BEFORE the step. Wait '
    + "for the NEW state first: `await page.locator('#upload-status', { hasText: 'Uploaded logo.png' })"
    + ".waitFor()` (or `.filter({ hasText: ... })` on a locator you already have) does not resolve "
    + 'until that text is present, and `page.waitForFunction` covers what a text filter cannot. '
    + 'When the action leads to another page, or starts a request, `await step.settle()` straight '
    + 'after it: it waits for every request the action started — the navigation a login answer '
    + 'begins included — and then for the page to hold still. Never wait with a URL taken from one '
    + 'data row: other rows of the same test may stay on this page. Read the value into '
    + '`step.expect` after that, not instead of it.'
  );
}

/**
 * Why this entry must not be written as it stands, or undefined when it may —
 * a `step.check` in an entry that acts (docs/specs/SPEC-codebehind-robustness.md
 * §6.5).
 *
 * A failed self-check heals: the step re-runs under AI. After a click that can
 * submit twice, so the runtime fails an acting entry's `step.check` like a
 * `step.expect` — and this says so at compile time, where the model can still
 * write the assertion it meant. "Acting" is `entryActs`'s, so a call to a
 * helper counts.
 */
export function selfCheckInActingEntryComplaint(code: string): string | undefined {
  if (!/\bstep\s*\.\s*check\s*\(/.test(codeText(code))) return undefined;
  const action = actingCalls(code)[0];
  if (action === undefined) return undefined;
  return (
    `The entry calls \`step.check\` and also acts on the page (\`${action.call}\`). \`step.check\` is ` +
    'the self-check of an entry that only reads: when it fails the step re-runs under AI, and after an ' +
    'action that would do the action twice. In an entry that acts, assert with `step.expect(…)`.'
  );
}

/** What a navigation counts as waited for: every state wait, plus the
 *  web-first assertions on a URL or a title, and Playwright's own navigation
 *  wait. */
const WAITS_FOR_NAVIGATION = new RegExp(`${WAITS_FOR_STATE.source}|waitForNavigation|toHaveURL|toHaveTitle`);

/**
 * Why this entry must not be written as it stands, or undefined when it may —
 * an action NAVIGATED on the recorded run, and the entry does not wait after
 * its last action (docs/specs/SPEC-codebehind-robustness.md §6.7).
 *
 * Compiled code is fast enough to read the page it is leaving: failure A's
 * sign-in entry read the title 57 ms after its click, while the login request
 * that would move the page was still in flight. The prompt's legend says to
 * wait with `step.settle()`; this is the backstop for an answer that did not.
 *
 * "After its last action" because the transcript cannot say which call in the
 * code is the one that navigated, and a step's navigation is its last action
 * far more often than not. A `goto` (or `reload`, `goBack`, `goForward`) as the
 * last action waits for its page by itself.
 */
export function unwaitedNavigationComplaint(
  code: string,
  actions: readonly RecordedAction[],
  secrets: readonly string[] = [],
): string | undefined {
  const moved = actions.find((a) => a.navigated !== undefined);
  if (moved?.navigated === undefined) return undefined;
  const calls = actingCalls(code);
  const last = calls[calls.length - 1];
  if (last === undefined || last.kind === 'navigation') return undefined;
  if (WAITS_FOR_NAVIGATION.test(code.slice(last.index))) return undefined;
  const mask = (url: string): string => redact(url, [...secrets]);
  return (
    `On the recorded run, the \`${moved.action}\` action changed the page's URL, from ${mask(moved.navigated.from)} ` +
    `to ${mask(moved.navigated.to)}, and this entry does not wait after its last action (\`${last.call}\`). ` +
    'Compiled code runs in milliseconds, so without a wait whatever comes next reads or acts on the page being ' +
    'left. Put `await step.settle()` straight after the action that leads to another page: it waits for every ' +
    'request the action started and the navigation they begin, then for the page to hold still. Do not wait ' +
    'for that URL by name: other rows of a data table may not navigate.'
  );
}

/** Everything `run`'s context object carries. Used bare, each of these is a
 *  `ReferenceError` unless the entry destructured it. */
const CONTEXT_PROPERTIES = ['page', 'context', 'browser', 'step', 'log', 'tabs', 'browsers'] as const;

/** The context's plain values — used bare as values, not through a `.`. */
const CONTEXT_VALUES = ['baseUrl'] as const;

/** The destructured parameter list of `async run({ ... })` — or of `async
 *  condition({ ... })`, which receives the same context object
 *  (stories/codebehind-loops-and-conditions.md). Group 1 is which function,
 *  group 2 the list. Undefined when the entry took the context as a whole
 *  (`run(ctx)`), where there is nothing to check — `ctx.tabs` cannot be
 *  undeclared. */
const RUN_DESTRUCTURE = /\b(run|condition)\s*\(\s*\{([^}]*)\}/;

/**
 * Why this entry must not be written as it stands, or undefined when it may —
 * the "used it without asking for it" case.
 *
 * The prompt shows the entry shape as `async run({ page, step, log })`, and a
 * model adding a `browsers.open(...)` call sometimes leaves that list alone.
 * The result is `ReferenceError: browsers is not defined` at replay — which
 * heals to AI, so the step passes and the author sees a ⚠ they have to chase.
 * Observed on the first live run of `compile-browsers.md`: all three browser
 * entries generated correctly and all three threw on exactly this.
 *
 * Cheap, deterministic, and it cannot fire on a correct entry: the names are
 * fixed, and a locally-declared binding of the same name is exempted.
 */
export function undeclaredContextComplaint(code: string): string | undefined {
  const params = RUN_DESTRUCTURE.exec(code);
  if (!params) return undefined;
  const fn = params[1]!;
  const declared = new Set(
    params[2]!
      // `{ page, step: s, log }` — the property name is what is in scope only
      // when there is no rename, and a rename means the author asked for it
      // either way, so the property half is the right half to read.
      .split(',')
      .map((part) => part.split(':')[0]!.trim())
      .filter(Boolean),
  );
  const complaint = (name: string): string =>
    `The entry uses \`${name}\` but \`${fn}\` does not destructure it — the parameter list is ` +
    `\`{ ${[...declared].join(', ')} }\`, so this throws \`ReferenceError: ${name} is not defined\` ` +
    `on the first replay. Add \`${name}\` to the destructured context object.`;
  for (const name of CONTEXT_PROPERTIES) {
    if (declared.has(name)) continue;
    if (!new RegExp(`(?:^|[^\\w$.])${name}\\s*\\.`).test(code)) continue;
    // A local of the same name is defined, whatever the parameter list says.
    if (new RegExp(`(?:const|let|var)\\s+${name}\\b`).test(code)) continue;
    return complaint(name);
  }
  // The context's VALUES are used bare, not through a member access —
  // `page.goto(baseUrl)`, `${baseUrl}/login` — so they are looked for as a
  // name on its own, outside strings and comments, and not as an object key.
  // Measured live: an entry for "Navigate to the baseUrl" called
  // `page.goto(baseUrl)` from `run({ page, step })`, and threw on replay.
  const text = codeText(code);
  for (const name of CONTEXT_VALUES) {
    if (declared.has(name)) continue;
    if (!new RegExp(`(?:^|[^\\w$.])${name}\\b(?!\\s*:)`).test(text)) continue;
    if (new RegExp(`(?:const|let|var|function)\\s+${name}\\b`).test(text)) continue;
    return complaint(name);
  }
  return undefined;
}

/** `page.locator(` / `await frame.click(` — a strict-mode call on the raw page.
 *  Anchored at the end, so it describes the call this literal is an argument
 *  to. Tolerant APIs (`waitForSelector`, `$`, `$$`) are absent on purpose:
 *  they take the first match without throwing, so a bare selector in one is
 *  not the fault being looked for. */
const STRICT_TARGET_CALL =
  /(?:^|[^\w$.])(?:page|frame)\s*\.\s*(?:locator|click|dblclick|fill|type|press|check|uncheck|selectOption|hover|focus|tap|setInputFiles|textContent|innerText|innerHTML|inputValue|getAttribute|isVisible|isHidden|isChecked|isEnabled|isDisabled|isEditable)\s*\(\s*$/;

/** `const link = page.locator(` — the name a locator was bound to, so a
 *  narrowing applied to the variable on a later line still counts. */
const BOUND_NAME = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/;

/** Anything that narrows a locator to one element. */
const NARROWING = /\.\s*(?:first|last|nth|filter|locator|getBy[A-Za-z]+)\s*\(/;

/** Is this string literal the selector of a strict call that narrows nothing? */
function isBareUse(code: string, token: StringToken): boolean {
  const before = code.slice(Math.max(0, token.start - 120), token.start);
  const call = STRICT_TARGET_CALL.exec(before);
  if (!call) return false;

  // The rest of this statement: `).first().click()` narrows, `).click()` does not.
  const after = code.slice(token.end, token.end + 400);
  const statement = after.split(/[;\n]/, 1)[0] ?? after;
  if (NARROWING.test(statement)) return false;

  const name = BOUND_NAME.exec(before.slice(0, call.index))?.[1];
  if (name === undefined) return true;
  return !new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\s*${NARROWING.source}`).test(code);
}

/**
 * One model round-trip that must come back as an entry, a decline, or an
 * error. Shared by generation and repair — the envelope, the parse and the
 * leak guard are identical, and only the prompt differs.
 *
 * `guarded` is every value the answer must not contain as a literal: the
 * step's parameters and its environment references, from `guardedValues`, and
 * what the recording captured, from `capturedValueGuards`. An answer refused
 * for the last kind carries `refusedCapture`; call it through
 * {@link askWithCaptureRetry}, which re-asks once over exactly that.
 */
export async function askForEntry(
  aiClient: AiClient,
  contextContent: string,
  prompt: ChatMessage,
  guarded: readonly GuardedValue[],
  signal?: AbortSignal | undefined,
  /** The function the entry must define — `condition` for a condition line's
   *  entry (`generateConditionEntry`), `run` for everything else. */
  expect: 'run' | 'condition' = 'run',
): Promise<GeneratedEntry> {
  let answer;
  try {
    const completion = await aiClient.complete(
      [{ role: 'system', content: buildSystemPrompt(contextContent) }, prompt],
      signal,
      { profile: 'compile' },
    );
    answer = parseStepCodeOrDecline(completion.text, expect);
  } catch (err) {
    return { kind: 'error', message: (err as Error).message };
  }

  if (answer.kind === 'declined') return { kind: 'declined', reason: answer.reason };

  // The non-negotiable guard. A parameter value reaching a committed file as
  // a literal is exactly the failure this feature must not introduce, and a
  // password is the case that makes it non-negotiable. An environment value
  // is the same failure with a different name: `${env.GITHUB_PASSWORD}` hands
  // the model the real password in the transcript, and `${data.url}` inlined
  // is a file that runs against one environment only.
  const leaked = findInlinedParameterValue(answer.entry, guarded.filter((g) => g.captured !== true));
  if (leaked) {
    return {
      kind: 'error',
      message:
        `the generated code contains the resolved value of ${describeGuardedName(leaked)} as a literal, ` +
        `so it was discarded`,
    };
  }
  // A value the recording captured, written in: refused as any leaked value
  // is, and marked so `askWithCaptureRetry` can ask once more.
  const captured = guarded.find((g) => g.captured === true && containsAsToken(answer.entry, g.value));
  if (captured) {
    return {
      kind: 'error',
      message:
        `the generated code contains the value the recording captured into ` +
        `${describeGuardedName(captured.name)} as a literal, so it was discarded`,
      refusedCapture: { name: captured.name, code: answer.entry },
    };
  }

  return { kind: 'entry', code: answer.entry };
}

/** The re-ask block a refused answer goes back with (`StepCodePromptInput.retry`,
 *  `RepairPromptInput.retry`). */
export type EntryRetry = { previousEntry: string; complaint: string };

/**
 * {@link askForEntry}, with ONE re-ask when the answer was refused for writing
 * in a value the recording captured.
 *
 * Those values joined the guard after a real-model Run & Compile stored nine
 * values where the recording read three, and the prompt now SHOWS them — which
 * is exactly what tempts a model to write the answer in rather than read it.
 * A refusal alone would turn that into a failed generation (fatal for the whole
 * boxed compile), where one re-ask, told what it did and shown its own answer
 * with the value masked out, usually reads the page instead. Every other
 * refusal is returned as it was, unasked: a parameter or environment value
 * written in is what rule 1 already forbids, and its refusal is unchanged.
 *
 * `prompt(retry)` builds the prompt; the second call gets the retry block. The
 * result never carries the refused code (`refusedCapture` is stripped), and
 * `reasked` says whether the re-ask was spent — a caller with its own one
 * re-ask (generation's static backstops) shares it.
 */
export async function askWithCaptureRetry(
  aiClient: AiClient,
  contextContent: string,
  prompt: (retry?: EntryRetry) => ChatMessage,
  guarded: readonly GuardedValue[],
  signal?: AbortSignal | undefined,
): Promise<{ result: GeneratedEntry; reasked: boolean }> {
  const first = await askForEntry(aiClient, contextContent, prompt(), guarded, signal);
  if (first.kind !== 'error' || first.refusedCapture === undefined) return { result: first, reasked: false };
  const retry = capturedValueRetry(first.refusedCapture, guarded);
  logger.debug(`Code-behind re-asking: ${retry.complaint}`);
  const second = await askForEntry(aiClient, contextContent, prompt(retry), guarded, signal);
  return {
    result: second.kind === 'error' ? { kind: 'error', message: second.message } : second,
    reasked: true,
  };
}

/**
 * The retry block for an answer that wrote a recorded value in: why, and the
 * answer itself with every recorded value masked — so the prompt carries no
 * value the prompt's own capture block would have masked, and the model sees
 * where it went wrong without being handed the literal to copy again.
 */
function capturedValueRetry(
  refused: { name: string; code: string },
  guarded: readonly GuardedValue[],
): EntryRetry {
  const values = guarded
    .filter((g) => g.captured === true)
    .map((g) => g.value.trim())
    .filter((v) => v.length >= MIN_GUARDED_VALUE_LENGTH);
  return {
    previousEntry: redact(refused.code, values),
    complaint:
      `The entry writes the value the recording captured into ${describeGuardedName(refused.name)} ` +
      `into the code as a literal — it is shown as ${MASK} in the answer below. That value is what this ` +
      `step must READ off the page: on the next run the page may hold something else, and a constant ` +
      `stores the recording's answer whatever the page says. Read it with a locator that matches exactly ` +
      `what was captured, and write neither the value nor any item of it anywhere in the entry — not in a ` +
      `string, a selector, a regex or a comment.`,
  };
}

/**
 * Does `code` contain `value` as a whole token — not glued to a word character
 * on a side where the value itself begins or ends with one?
 *
 * The recorded-value half of the leak guard. A parameter keeps the bare
 * substring test ({@link findInlinedParameterValue}); a captured value is
 * page text, often a plain word (`Savings`, `Travel`), and the substring test
 * would refuse an entry for a `savingsTotal`-shaped identifier or a `1000` that
 * holds a captured `100`. A value written in as a value — in quotes, in a
 * selector, in a comment, in a JSON literal — is always delimited, so nothing
 * that matters is missed.
 */
function containsAsToken(code: string, value: string): boolean {
  const needle = value.trim();
  if (needle.length < MIN_GUARDED_VALUE_LENGTH) return false;
  const wordAtStart = /\w/.test(needle[0]!);
  const wordAtEnd = /\w/.test(needle[needle.length - 1]!);
  for (let at = code.indexOf(needle); at !== -1; at = code.indexOf(needle, at + 1)) {
    const before = at > 0 ? code[at - 1]! : '';
    const after = code[at + needle.length] ?? '';
    if (wordAtStart && /\w/.test(before)) continue;
    if (wordAtEnd && /\w/.test(after)) continue;
    return true;
  }
  return false;
}

/** Values the recorded-value guard never holds: the mask and the empty marker
 *  (a recording read back from a redacted report holds these, not the value),
 *  and JSON's literal words, which any entry may contain as code. */
const UNGUARDED_CAPTURES = new Set([MASK, EMPTY, 'true', 'false', 'null']);

/**
 * The recorded captures, as leak-guard entries
 * (stories/codebehind-loops-and-conditions.md, "What the live half decided").
 *
 * Each value whole, and — for a JSON list, which is what a multi-element read
 * stores — each string item too, because an entry that inlines the list is as
 * likely to write the items one by one (`['Everyday', 'Savings', 'Travel']`) as
 * the JSON the run stored. {@link MIN_GUARDED_VALUE_LENGTH} applies to both, as
 * it does to every guarded value.
 *
 * A value the AUTHOR wrote in the step's own line is exempt: an entry echoing
 * the step's words is repeating the step, not storing the recording's answer.
 * That is {@link authorQuotedLiterals}'s exemption — `Read the status "Active"
 * [store as: status]` may say `'Active'` — and one step wider, because a
 * capture's value is page text the author may name without quotes: `Read the
 * label of the Submit button [store as: label]` recorded `Submit`, and an entry
 * finding that button by its name is right. Matched as {@link containsAsToken}
 * matches the code, so a quoted mention is covered by the same test.
 */
export function capturedValueGuards(
  recorded: Record<string, string> | undefined,
  authoredSource: string,
): GuardedValue[] {
  if (recorded === undefined) return [];
  const quoted = authorQuotedLiterals(authoredSource);
  const out: GuardedValue[] = [];
  const add = (name: string, value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length < MIN_GUARDED_VALUE_LENGTH || UNGUARDED_CAPTURES.has(trimmed)) return;
    if (quoted.has(trimmed) || containsAsToken(authoredSource, trimmed)) return;
    if (out.some((g) => g.value.trim() === trimmed)) return;
    out.push({ name, value, captured: true });
  };
  for (const [name, value] of Object.entries(recorded)) {
    if (typeof value !== 'string') continue;
    add(name, value);
    for (const item of jsonStringItems(value)) add(name, item);
  }
  return out;
}

/** The string items of a JSON-list value, or none when it is not one. */
function jsonStringItems(value: string): string[] {
  if (!/^\s*\[/.test(value)) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The environment references a step makes, split by whether the run's
 * context answers them (stories/codebehind-env-data.md).
 *
 * Resolved ones go into the prompt with their values and into the leak guard;
 * an unresolved one declines the step. Scoped to the step's own references,
 * as `stepParameters` is, and for the same reasons.
 */
export function stepEnvRefs(
  binding: CodeBehindBinding,
  envData: EnvDataContext | undefined,
): { resolved: Array<{ ref: string; value: string }>; unresolved: string[] } {
  const resolved: Array<{ ref: string; value: string }> = [];
  const unresolved: string[] = [];
  for (const ref of envDataRefsIn(binding.source)) {
    const value = envData ? resolveEnvDataRef(ref, envData) : undefined;
    if (value === undefined) unresolved.push(ref);
    else resolved.push({ ref, value });
  }
  return { resolved, unresolved };
}

/**
 * Why a step with a reference the run cannot answer stays AI. The reason
 * lands in the file as the entry's comment, so it names the reference and
 * the likely cause rather than just "undefined".
 */
export function unresolvedRefsReason(refs: string[], envData: EnvDataContext | undefined): string {
  const list = refs.map((r) => `\${${r}}`).join(', ');
  const cause = envData
    ? 'nothing in this environment defines it — a skill-private data source is ' +
      'resolved inside the skill and has no run-time name'
    : 'the compile ran without an environment';
  return `the step references ${list}, which code-behind cannot read at run time: ${cause}`;
}

/**
 * Every value the generated code must not contain as a literal: the step's
 * parameters under their `{{name}}` and its environment references under
 * their `${ref}`, so the rejection message can name either as written.
 *
 * `authoredSource` is the step's own line with its `{{name}}` placeholders intact,
 * and passing it exempts any value the AUTHOR quoted there verbatim — see
 * `authorQuotedLiterals`. EVERY caller asking a model for one step's entry passes
 * it: generation here, the boxed pipeline's repair round (`repairStep`,
 * compile.ts) and the live compiler's repair (`askForRepair`, live-compile.ts).
 * The two repair sites that once omitted it could not repair the one step shape
 * that needs the exemption — `If {{a}} is "peanuts" then fail …`, where every
 * candidate must contain `peanuts` and each was discarded as a leak until the
 * rounds ran out and the step was written off `ai: true`.
 *
 * Optional only for a caller guarding something WIDER than one step — a
 * whole-file review has no single authored line to read.
 */
export function guardedValues(
  parameters: Array<{ name: string; value: string }>,
  envRefs: Array<{ ref: string; value: string }>,
  authoredSource?: string,
): Array<{ name: string; value: string }> {
  const base = [
    ...parameters,
    ...envRefs.map((r) => ({ name: `\${${r.ref}}`, value: r.value })),
  ];
  // A path parameter reaches the model already interpolated into the step, and
  // the model writes it back NORMALISED — `\attachments\march.pdf` comes back
  // as `attachments/march.pdf`. Guarding only the raw spelling would let that
  // frozen path through the leak check (stories/upload-action.md §6).
  // Path-shaped only. `findInlinedParameterValue` is a bare substring test, so
  // widening an ordinary parameter like `route: "/logs"` into the token `logs`
  // would start reporting any entry containing that word as a leak.
  // The leading separator is dropped HERE although normalisation keeps it: the
  // model may write `attachments/march.pdf` for a rooted value, and the
  // unrooted form is a substring of the rooted one, so it catches both.
  const normalised = base
    .map((g) => ({ name: g.name, value: normaliseUploadPath(g.value).replace(/^\//, '') }))
    .filter((g, i) => g.value !== base[i]!.value && g.value.includes('/'));
  const all = [...base, ...normalised];
  if (authoredSource === undefined) return all;
  // Uniformly BY VALUE, which is what keeps the normalised entries honest:
  // `attachments/march.pdf` stays guarded unless the author quoted that
  // spelling too, even when its raw `\attachments\march.pdf` sibling is exempt.
  const quoted = authorQuotedLiterals(authoredSource);
  return all.filter((g) => !quoted.has(g.value.trim()));
}

/** One `"…"` or `'…'` of the authored line. The single-quoted alternative is
 *  fenced off from word characters so the apostrophe in `the user's password`
 *  opens no quote. */
const AUTHOR_QUOTED = /"([^"\n]*)"|(?<!\w)'([^'\n]*)'(?!\w)/g;

/**
 * The strings the author QUOTED in the step's own line — `"…"` or `'…'`, read
 * off the authored text with its `{{name}}` placeholders still in place.
 *
 * A value that matches one of these is exempt from the leak guard, because a
 * literal the author wrote is the author's: an entry echoing it is repeating the
 * step, not inlining the value the step resolved to. `If {{a}} is "peanuts" then
 * fail the test with error "The variable value was peanuts. Expected apples"` is
 * the measured case (stories/step-failure-outcomes.md, decisions 3 and 10) — the
 * correct entry HAS to contain `peanuts`. The secret direction is untouched: an
 * author using `{{password}}` does not also write the password into the line as a
 * quoted literal, and a value appearing only unquoted, or only as `{{name}}` /
 * `${ref}`, is not exempted.
 *
 * Exact and case-sensitive, against the WHOLE quoted content: `"Peanuts"` and
 * `"peanuts and more"` leave `peanuts` guarded.
 */
function authorQuotedLiterals(source: string): Set<string> {
  const out = new Set<string>();
  for (const match of source.matchAll(AUTHOR_QUOTED)) {
    const content = match[1] ?? match[2];
    if (content !== undefined && content.length > 0) out.add(content);
  }
  return out;
}

/** `{{username}}` for a parameter, `${data.url}` for an environment reference. */
export function describeGuardedName(name: string): string {
  return name.startsWith('${') ? name : `{{${name}}}`;
}

/**
 * The parameters this step actually references, resolved to their values.
 *
 * Scoped to the step's own `{{name}}` references rather than the whole
 * variable map, for two reasons: it is what the model needs to map transcript
 * literals back to `getVar` calls, and it keeps the leak guard from tripping
 * on an unrelated variable whose value happens to be a substring of a
 * legitimate selector or URL.
 */
export function stepParameters(
  binding: CodeBehindBinding,
  resolvedParameters: Record<string, string>,
  envData?: EnvDataContext | undefined,
): StepParameter[] {
  const { placeholders } = referencedVariableNames(binding.source);
  const out: StepParameter[] = [];
  for (const name of placeholders) {
    // `boundValue` on all three maps, not a bare index. Two prototype reads
    // sat here and cancelled each other into the wrong answer: `renames[name]`
    // answered `{{constructor}}` with the `Object` function, so the rename
    // branch was taken and `resolvedParameters[thatFunction]` came back
    // undefined — a variable the run really did bind under the name
    // `constructor` (a `[store as: constructor]` capture) was dropped from the
    // prompt AND from the leak guard, which is how a real value reaches a
    // committed file. Uncancel one of them — a genuine rename onto `toString`
    // — and the FUNCTION became the `value` instead: rendered `resolved to
    // undefined` (`JSON.stringify` of a function), and handed to the guard as
    // the text to search for.
    const renamed = boundValue(binding.scope.renames, name);
    const input = boundValue(binding.scope.inputs, name);
    // A DOTTED name whose root the frame renames — `{{order.id}}` in a skill
    // body whose `For each {{order}}` the expander rewrote — resolves through
    // that rename, in the order `step.getVar` asks (execute.ts): the pass
    // bound `__skill1_order.id`, and no map holds `order.id` under the name
    // the step wrote. Missed, the prompt said "this step uses no parameters"
    // and the leak guard held nothing, so an entry hard-coding the item's id
    // was accepted — the one inlined value a loop exists to vary.
    const scoped =
      renamed === undefined && input === undefined
        ? dottedThroughRename(name, binding.scope.renames)
        : undefined;
    const value = renamed !== undefined
      ? boundValue(resolvedParameters, renamed)
      : input !== undefined
        ? resolveInputValue(input, resolvedParameters, envData)
        : scoped !== undefined
          ? boundValue(resolvedParameters, scoped)
          : boundValue(resolvedParameters, name);
    // The scoped key rides along, so the prompt asks the map's loop marks
    // about the name the map HOLDS: the pass marked `__skill1_row.keyword`,
    // never the authored `row.keyword`, and asked about that one the author
    // rule answered — `keyword` matches `key`, and `AU` was masked out of the
    // block the model writes its selector from.
    if (value !== undefined) out.push({ name, value, ...(scoped !== undefined && { bound: scoped }) });
  }
  return out;
}

/** One parameter a step references, as {@link stepParameters} resolves it. */
export interface StepParameter {
  /** The name as the step wrote it — what the prompt shows and `getVar` reads. */
  name: string;
  value: string;
  /** The key the value is held under in the map, when it is not `name`: a
   *  dotted name in a skill body, resolved through its root's rename
   *  (`row.keyword` → `__skill1_row.keyword`). What a loop mark is keyed by. */
  bound?: string;
}

/**
 * The caller-supplied inputs of a binding's frames, resolved the way the step's
 * own references resolve them ({@link resolveInputValue}): `[skill: api
 * token="uk_live_1234" header="Bearer uk_live_1234"]` inlined both into the
 * body's text, so they exist under no name in the run's map — only here.
 */
function resolvedFrameInputs(
  binding: CodeBehindBinding,
  resolvedParameters: Record<string, string>,
  envData: EnvDataContext | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, input] of Object.entries(binding.scope.inputs)) {
    Object.defineProperty(out, name, {
      value: resolveInputValue(input, resolvedParameters, envData),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * The mask set a compile's prompt — or its own words — built from `values` is
 * masked with, so it masks what the run's own prompts masked:
 *
 *  - the run's (`runSecrets`): its secret-named entries, decided by the
 *    snapshot's own loop marks, and the env/data secrets — a secret inside a
 *    value no key names as secret (`auth: "Bearer <the key>"`) included;
 *  - each binding's frame inputs, resolved ({@link resolvedFrameInputs}) and
 *    judged by their names as the run's `secretsNow` judges them — which
 *    merges every frame's inputs into the set, so `[skill: api token="<key>"
 *    header="Bearer <key>"]` masks the key inside `{{header}}` too;
 *  - `extra`: secrets the caller knows some other way (the boxed compile's
 *    values recovered from a redacted final map).
 *
 * Shared by both compilers.
 */
export function compilePromptSecrets(
  values: Record<string, string>,
  envData: EnvDataContext | undefined,
  bindings: ReadonlyArray<CodeBehindBinding | undefined> = [],
  extra: readonly string[] = [],
): string[] {
  const out = new Set(runSecrets({ parameters: values, envData }));
  const seen = new Set<Record<string, string>>();
  for (const binding of bindings) {
    const inputs = binding?.scope.inputs;
    if (inputs === undefined || seen.has(inputs) || Object.keys(inputs).length === 0) continue;
    seen.add(inputs);
    const layer = resolvedFrameInputs(binding!, values, envData);
    // A dotted input a pass bound is the pass's: its marks come from the map.
    inheritLoopBindings(values, layer);
    for (const secret of secretValues(layer)) out.add(secret);
  }
  for (const secret of extra) if (secret.length > 0) out.add(secret);
  return [...out];
}

/**
 * A caller's argument, resolved the way the runtime resolves it: `{{outer}}`
 * through the live parameter map first, then `${env.X}` / `${data.X}` against
 * the run's environment.
 *
 * The second half exists because the expander captures the argument TEXT and
 * env-data interpolation runs after expansion without ever walking the
 * frames' `inputs` — so `[skill: greet username="${data.username}"]` reaches
 * the binding as the raw placeholder while the transcript typed the value. A
 * prompt fed the raw text cannot tell the model which name the literal
 * belongs to, and a leak guard holding the raw text waves the literal
 * through — the environment-specific value then lands in a committed file,
 * which is the exact failure the guard exists to stop.
 *
 * A reference the context cannot answer is left in place;
 * `unresolvedInputRefs` reports it and `generateStepEntry` declines over it.
 */
function resolveInputValue(
  input: string,
  resolvedParameters: Record<string, string>,
  envData: EnvDataContext | undefined,
): string {
  const interpolated = interpolate(input, resolvedParameters);
  if (!envData || envDataRefsIn(interpolated).length === 0) return interpolated;
  try {
    return interpolateEnvData(interpolated, envData);
  } catch {
    return interpolated;
  }
}

/**
 * The `${...}` references left unresolved in the step's INPUT-sourced
 * parameter values — a caller argument like `${data.username}` that this
 * run's context cannot answer. Scoped to input-sourced names on purpose: a
 * renamed or bare parameter's VALUE is runtime data, and data that happens
 * to contain `${...}`-shaped text is not a reference.
 */
export function unresolvedInputRefs(
  binding: CodeBehindBinding,
  resolvedParameters: Record<string, string>,
  envData: EnvDataContext | undefined,
): string[] {
  const { placeholders } = referencedVariableNames(binding.source);
  const out: string[] = [];
  for (const name of placeholders) {
    // `boundValue` on both scope maps, for the reason `stepParameters` states
    // above: `renames['constructor']` is the `Object` function on a scope that
    // renames nothing, so `{{constructor}}` took the rename branch and this
    // function returned before ever looking at the input. A skill called with
    // `constructor="${data.username}"` in a run with no environment was then
    // reported as having no unresolved reference at all — and `generateStepEntry`,
    // which declines over exactly this list, compiled the step with the
    // literal `${data.username}` text frozen into it.
    if (boundValue(binding.scope.renames, name) !== undefined) continue;
    const input = boundValue(binding.scope.inputs, name);
    if (input === undefined) continue;
    for (const ref of envDataRefsIn(resolveInputValue(input, resolvedParameters, envData))) {
      if (!out.includes(ref)) out.push(ref);
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// The exact rule (stories/placeholder-preserving-actions.md, decisions 5 & 6)
// ───────────────────────────────────────────────────────────────────────────

/**
 * A `{{name}}` / `{{name.property}}` reference, in the wider grammar the
 * placeholder story's checker uses (decision 4).
 *
 * Wider than the substituter's on purpose: the model is shown the authored
 * step and writes the placeholder back itself, so `{{ email }}` is a thing it
 * can produce. Reading it as a reference is what lets the rule answer with the
 * name rather than with silence.
 *
 * A dotted reference is one token here, not a root plus stray text
 * (docs/specs/SPEC-structured-table-reads.md §9.3): `{{order.id}}` names the
 * dotted runtime binding a `For each` pass writes, so the leak guard carries
 * that pass's value and refuses an entry that inlined it, and the accounting
 * looks for the token the model was shown rather than declaring `order`
 * unknown.
 */
const PLACEHOLDER_REF_RE = new RegExp(WIDE_PLACEHOLDER_SOURCE, 'g');

/** The same, for a yes/no question about one string. Non-global: `.test` on a
 *  global regex carries `lastIndex` between calls and would answer false every
 *  other time. */
const ANY_PLACEHOLDER_RE = new RegExp(WIDE_PLACEHOLDER_SOURCE);

/**
 * A placeholder that DEFINES a variable rather than reading one:
 * `Read the balance and store as {{balance}}`.
 *
 * A definition is not a reference — nothing has that value yet when the step
 * starts — so the rule must not ask which action carried it, or every capture
 * step would decline (decision 4, "Capture definitions are never references").
 *
 * Flat, and staying flat: a step writes a variable, never one property of one.
 */
const CAPTURE_DEFINITION_RE = /\b(?:store|save)\s+as:?\s*\{\{\s*(\w+)\s*\}\}/gi;

/**
 * The `{{name}}` references a piece of text makes, in source order, deduped,
 * capture definitions excluded.
 */
export function placeholderNamesIn(text: string): string[] {
  const defined = new Set<string>();
  for (const m of text.matchAll(CAPTURE_DEFINITION_RE)) defined.add(m[1]!);
  const out: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER_REF_RE)) {
    const name = m[1]!;
    if (defined.has(name) || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/** Every string leaf under `value` — arrays and nested objects included, which
 *  is what `body` and `apiHeaders` need. */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}

/**
 * Actions that look at the page rather than act on it. They are in the
 * transcript and nothing replayable carries them, so a token in one vouches
 * for nothing — decision 5, "Exploration actions never vouch".
 */
const EXPLORATION_ACTIONS: ReadonlySet<AIAction['action']> = new Set(['find', 'expand']);

/**
 * The fields of one recorded action a placeholder may vouch from: what the
 * step typed, uploaded, navigated to, targeted, pressed, sent or expected.
 *
 * `condition` is here only for a predicate assertion, where the comparison is
 * over values the step itself carries rather than over the model's reading of
 * the page. Everywhere else `condition` is prose.
 */
function valueBearingStrings(action: RecordedAction): string[] {
  if (EXPLORATION_ACTIONS.has(action.action)) return [];
  const out: string[] = [];
  const push = (value: string | undefined): void => {
    if (typeof value === 'string') out.push(value);
  };
  push(action.value);
  push(action.filePath);
  for (const p of action.filePaths ?? []) push(p);
  push(action.url);
  push(action.selector);
  push(action.expected);
  push(action.key);
  if (action.against === 'predicate') push(action.condition);
  collectStrings(action.body, out);
  for (const header of Object.values(action.apiHeaders ?? {})) push(header);
  return out;
}

/**
 * The fields that hold the model's own words. A reference that landed only
 * here means the model read the sentence and deferred the interpretation to
 * run time, which is the one thing code cannot express.
 */
function freeTextStrings(action: RecordedAction, field: 'condition' | 'description'): string[] {
  if (EXPLORATION_ACTIONS.has(action.action)) return [];
  if (field === 'condition') {
    return action.against !== 'predicate' && typeof action.condition === 'string'
      ? [action.condition]
      : [];
  }
  return typeof action.description === 'string' ? [action.description] : [];
}

/** Every reference a set of recorded strings carries, keyed the way
 *  `accountPlaceholders` keys them: `email`, or `${data.url}`. */
function referencesIn(strings: string[]): Set<string> {
  const out = new Set<string>();
  for (const text of strings) {
    for (const name of placeholderNamesIn(text)) out.add(name);
    for (const ref of envDataRefsIn(text)) out.add(`\${${ref}}`);
  }
  return out;
}

/**
 * Did the model name a placeholder anywhere in these actions?
 *
 * The whole-recording question decision 6 turns on, asked of one step's
 * actions and OR-ed across the run by the caller. Deliberately the widest
 * possible read — every string leaf of every action, exploration actions
 * included — because a false "post-change" is a decline the author has to
 * chase, while a false "pre-change" only costs the warning.
 */
export function anyActionCarriesPlaceholder(actions: RecordedAction[]): boolean {
  const strings: string[] = [];
  for (const action of actions) collectStrings(action, strings);
  return strings.some((s) => ANY_PLACEHOLDER_RE.test(s) || envDataRefsIn(s).length > 0);
}

/** The compliance warning, in one place so the note, the log and the tests
 *  cannot drift. */
export function valueMatchWarning(name: string): string {
  return `recovered ${describeGuardedName(name)} by value match; the model did not name it`;
}

/** What the rule decided for one step. */
export interface PlaceholderAccounting extends PlaceholderReport {
  /** Why the step must stay AI, or undefined when it may compile. */
  decline?: string;
}

/**
 * Whether every reference the step makes is accounted for
 * (stories/placeholder-preserving-actions.md, decisions 5 and 6).
 *
 * The exact rule: a step compiles only if each reference its authored text
 * makes appears, AS A TOKEN, in a value-bearing field of some recorded action.
 * A token only in free text means the model deferred the interpretation to run
 * time; a token nowhere means it interpreted the value into something else.
 * No string comparison, no three-character floor, and no risk from a
 * coincidental `Dashboard` — the test is for the token, not for the value.
 *
 * Two carve-outs, both deliberate:
 *
 * - **Scope-supplied names** (decision 6). A name the binding's scope answers
 *   — a skill argument, a part B section row — is interpolated into the body
 *   text by the expander, so the runtime never sees a placeholder and the
 *   model cannot name one. Those keep today's value match, silently, until
 *   phase 2 moves them onto the runtime map. Warning them would drown the
 *   measurement in cases nobody can act on.
 * - **Pre-change recordings** (`recordingCarriesPlaceholders: false`). Same
 *   value match, for every reference, plus a note from the caller.
 * - **Flow-control steps** (stories/step-flow-control.md, decisions 2 and 11).
 *   See below.
 *
 * A skill RENAME is not a carve-out: the expander rewrites the step text to
 * `{{__skill1_username}}` and the runtime substitutes that at run time, so the
 * model is shown a placeholder and can name it. The token looked for is the
 * renamed one; the reason names the authored one, which is what the author
 * wrote.
 */
export function accountPlaceholders(options: {
  binding: CodeBehindBinding;
  actions: RecordedAction[];
  resolvedParameters: Record<string, string>;
  envData?: EnvDataContext | undefined;
  recordingCarriesPlaceholders: boolean;
}): PlaceholderAccounting {
  const { binding, actions } = options;
  /**
   * A step whose text CLAIMS the flow-control form is exempt from the
   * accounting (stories/step-flow-control.md, decisions 2 and 11).
   *
   * The accounting exists to stop the model freezing a resolved VALUE into
   * code: a reference is only vouched for by a value-bearing field of a
   * recorded action, because that is where a value the model typed would show
   * up. A flow-control step has no such field to vouch from — its recorded
   * action is `return` or `noop`, which carry no value, no selector, no url and
   * no expected — so `If {{username}} is shown then return` would decline with
   * "{{username}} appears in no recorded action" and be written a permanent
   * `ai: true` entry. It could never compile, which contradicts the handbook
   * and the story's own worked example.
   *
   * The exemption is safe precisely because there is nothing to freeze: the
   * body of a flow-control step is JUDGED by the model against the live page,
   * never typed into it. And it is only the ACCOUNTING that is lifted, not the
   * leak guard — `guardedValues` still carries every resolved value into
   * `findInlinedParameterValue`, so generated code that inlines the username's
   * value is still rejected and re-asked. That guard is what actually protects
   * the failure direction this rule was written for.
   */
  if (parseFlowControlStep(binding.source.trim())) {
    return { recoveredByValue: [], preChangeFallback: false };
  }
  const literals = actions.flatMap(valueBearingStrings);
  const vouched = referencesIn(literals);
  const inCondition = referencesIn(actions.flatMap((a) => freeTextStrings(a, 'condition')));
  const inDescription = referencesIn(actions.flatMap((a) => freeTextStrings(a, 'description')));

  const recoveredByValue: string[] = [];
  let judged = false;
  let decline: string | undefined;

  /** One reference: the name the author wrote, the token the model would have
   *  written, and the value this run resolved it to. */
  const judge = (name: string, token: string, value: string | undefined): void => {
    judged = true;
    if (decline !== undefined || !options.recordingCarriesPlaceholders) return;
    if (vouched.has(token)) return;
    if (inCondition.has(token)) {
      decline =
        `${describeGuardedName(name)} appears only in an assertion's condition, which is ` +
        'interpreted at run time and cannot be compiled';
      return;
    }
    if (inDescription.has(token)) {
      decline =
        `${describeGuardedName(name)} appears only in an action's description, which is the ` +
        "model's own words rather than a value it used";
      return;
    }
    // The fallback the story keeps for phase 1: the model ignored the rule and
    // wrote the value. Recovering it keeps the step compiling; the warning is
    // how often that happens gets measured.
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed.length >= MIN_GUARDED_VALUE_LENGTH) {
      if (literals.some((literal) => literal.trim() === trimmed)) {
        recoveredByValue.push(name);
        return;
      }
    }
    decline = `${describeGuardedName(name)} appears in no recorded action`;
  };

  for (const name of placeholderNamesIn(binding.source)) {
    // `boundValue` on all three maps, as `stepParameters` does. Bare, the
    // rename map answered `{{constructor}}` with the `Object` FUNCTION, and
    // the function then travelled the whole way through: as the TOKEN looked
    // for in the recorded actions, which no recorded string can equal, so a
    // step that names its value correctly declined with "appears in no
    // recorded action"; and as the VALUE, where `value?.trim()` threw a
    // TypeError out of the compile rather than declining at all.
    const renamed = boundValue(binding.scope.renames, name);
    // Decision 6: the expander baked this one into the text, so no token can
    // exist. Today's behaviour, no warning, no decline.
    if (renamed === undefined && boundValue(binding.scope.inputs, name) !== undefined) continue;
    // A DOTTED name whose root the frame renames — `{{order.id}}` in a skill
    // body whose `For each {{order}}` the expander rewrote — is shown to the
    // model, and so named back by it, as `{{__skill1_order.id}}`: the renamed
    // root plus the property. The same `dottedThroughRename` `stepParameters`
    // resolves its value through, in the same precedence (a full-name rename
    // or an input wins). Looking for the authored `order.id` instead declined
    // every such step "appears in no recorded action" and wrote it `ai: true`
    // before its prompt was ever built.
    const token = renamed ?? dottedThroughRename(name, binding.scope.renames) ?? name;
    judge(name, token, boundValue(options.resolvedParameters, token));
  }
  for (const ref of envDataRefsIn(binding.source)) {
    judge(
      `\${${ref}}`,
      `\${${ref}}`,
      options.envData ? resolveEnvDataRef(ref, options.envData) : undefined,
    );
  }

  return {
    recoveredByValue,
    preChangeFallback: judged && !options.recordingCarriesPlaceholders,
    ...(decline !== undefined && { decline }),
  };
}


/**
 * Resolve the placeholders in a recorded string the way the runtime resolved
 * them, leaving anything this run cannot answer exactly as written.
 *
 * Not `interpolate`: that one warns about every placeholder it cannot resolve,
 * and here an unresolved one is ordinary — a recorded selector may mention a
 * variable a later step captures.
 */
function applyKnownValues(
  text: string,
  values: Record<string, string>,
  envRefs: Array<{ ref: string; value: string }>,
): string {
  let out = text.replace(PLACEHOLDER_REF_RE, (match, name: string) =>
    Object.hasOwn(values, name) ? (values[name] ?? match) : match,
  );
  for (const { ref, value } of envRefs) {
    out = out.split(`\${${ref}}`).join(value);
  }
  return out;
}

/**
 * An `ai: true` entry carrying the reason the step stayed AI.
 *
 * The comment is the point: an author reading the file learns why this one
 * step still costs a model call, and a later compile leaves the entry alone
 * (an `ai: true` entry is never in the selection set).
 */
export function aiEntryFor(source: string, reason: string): string {
  logger.debug(`Code-behind keeps "${source}" on AI: ${reason}`);
  return [
    `{`,
    `  // Kept as AI by \`steptix compile\`: ${sanitiseComment(reason)}`,
    `  source: ${JSON.stringify(source)},`,
    `  ai: true,`,
    `}`,
  ].join('\n');
}

/** One line, no comment terminator, no surprises in a generated file. */
function sanitiseComment(reason: string): string {
  return reason.replace(/\r?\n/g, ' ').replace(/\*\//g, '* /').trim();
}

// ───────────────────────────────────────────────────────────────────────────
// Condition entries (stories/codebehind-loops-and-conditions.md, "Generation")
// ───────────────────────────────────────────────────────────────────────────

/** A control line that compiles to a `condition` entry, parsed. */
export interface CompilableCondition {
  kind: 'if' | 'elseif' | 'while' | 'repeat';
  /** The condition part, AUTHORED — `{{plan}}`, never a skill's renamed form. */
  condition: string;
  /** What the line does when the condition holds (a loop: its body). */
  tail: string;
}

/**
 * The condition a line compiles to a `condition` entry for, or undefined when
 * it compiles to none (decisions 4 and 10).
 *
 * `If`, `Else if`, `While` and `Repeat … until` get one. `Otherwise` has no
 * condition, `For each` reads a list and never asks a model, the flow-control
 * `If … then return|stop|fail` is a STEP (`parseControlLine` declines it, so
 * it never reaches here as a guard), and a condition decided from its own
 * values is free already and would only be made worse by code
 * (`isLiteralCondition`).
 *
 * Read off the AUTHORED line — the binding's `source` — so a skill body's
 * condition is the author's `{{order}}` rather than the `{{__skill1_order}}`
 * the run judged it by. The live compiler asks it for its plan and for
 * `offerGuard`; the boxed `describeSteps` is meant to ask it too.
 */
export function compilableCondition(line: string): CompilableCondition | undefined {
  const parsed = parseControlLine(line.trim());
  if (!parsed) return undefined;
  if (parsed.kind === 'else' || parsed.kind === 'foreach') return undefined;
  if (isLiteralCondition(parsed.condition)) return undefined;
  return { kind: parsed.kind, condition: parsed.condition, tail: parsed.tail };
}

/**
 * The runtime loop a line sits in the body of, as the generation prompts
 * describe it (decision 2) — or undefined when `guardLine` is not a loop.
 *
 * `guardLine` is the loop's AUTHORED line. `passValues` is the evidence pass's
 * own bindings (`StepResult.loop.values`): its dotted keys are the `item.key`
 * bindings a `For each` over records made, and they are named under the
 * AUTHORED item, which is the name `step.getVar` reads — `runtimeItem` is the
 * name the run bound them under when that differs (a skill body's
 * `__skill1_order`), so both roots are recognised.
 */
export function loopContextFor(
  guardLine: string,
  passValues?: Record<string, string> | undefined,
  runtimeItem?: string | undefined,
): LoopContext | undefined {
  const parsed = parseControlLine(guardLine.trim());
  if (!parsed) return undefined;
  if (parsed.kind === 'while' || parsed.kind === 'repeat') {
    return { line: guardLine.trim(), kind: parsed.kind, perPass: [] };
  }
  if (parsed.kind !== 'foreach') return undefined;
  const names = new Set<string>([parsed.item]);
  for (const key of Object.keys(passValues ?? {})) {
    const dot = key.indexOf('.');
    if (dot < 0) continue;
    const root = key.slice(0, dot);
    if (root === parsed.item || (runtimeItem !== undefined && root === runtimeItem)) {
      names.add(`${parsed.item}${key.slice(dot)}`);
    }
  }
  return { line: guardLine.trim(), kind: 'foreach', perPass: [...names] };
}

/**
 * One visit on which the model decided a condition — what a `condition` entry
 * is generated from (decision 9). `holds` undefined is a chain member after
 * the one that held: never asked, first-holds-wins.
 */
export interface ConditionObservation {
  holds: boolean | undefined;
  /** The DOM the judge was shown, already masked for the model. Absent on the
   *  computer surface, where there is none. */
  dom?: string | undefined;
  url?: string | undefined;
}

/**
 * Which observations a generation is shown (decision 9): the first where the
 * condition held and the first where it did not — a `While` generated from
 * "enabled on page 1" AND "disabled on page 4" writes a better check than one
 * generated from either — or, when there is neither, the first not-asked one.
 *
 * Order-preserving over `all`, which the caller keeps in visit order, and
 * generic so a caller may hang its own facts (a parameter snapshot) on each.
 */
export function pickConditionObservations<T extends { holds: boolean | undefined }>(
  all: readonly T[],
): T[] {
  const held = all.find((o) => o.holds === true);
  const notHeld = all.find((o) => o.holds === false);
  const picked = all.filter((o) => o === held || o === notHeld);
  if (picked.length > 0) return picked;
  const unasked = all.find((o) => o.holds === undefined);
  return unasked ? [unasked] : [];
}

/**
 * Why a condition judged on the computer surface stays AI
 * (SPEC-use-computer.md §9, decision 10): there is no DOM to generate from,
 * and a read of the screen is not portable.
 */
export const CONDITION_WITHOUT_DOM =
  'the condition was judged without a DOM (computer mode); a screen read is not portable';

/** Where the tab and browser rule sits among {@link CONDITION_FORBIDDEN}; the
 *  rule itself is built per entry ({@link tabCallRule}). */
const TAB_CALLS_SLOT: { re: RegExp; why: string } = { re: /(?!)/, why: '' };

const TAB_CALLS_WHY = 'opens, switches or closes a tab or browser. A condition reads the page the run is on';

/**
 * The names an entry reaches the context's `tabs` (or `browsers`) by: the
 * property itself, a destructure that renames it (`{ tabs: tb }` — the
 * condition's own parameter, or `const { tabs: tb } = ctx`), and any local
 * bound to one of those or to a member ending in it (`const t = tabs`,
 * `let t; t = ctx.tabs`), to a fixpoint. A method destructured off it
 * (`const { close } = tabs`) is not followed.
 */
function contextAliases(text: string, property: 'tabs' | 'browsers'): Set<string> {
  const names = new Set<string>([property]);
  for (const m of text.matchAll(new RegExp(String.raw`(?:^|[^\w$.])${property}\s*:\s*([A-Za-z_$][\w$]*)`, 'g'))) {
    names.add(m[1]!);
  }
  const bindings: Array<{ target: string; rhs: string }> = [];
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*([^;\n]+)/g)) {
    bindings.push({ target: m[1]!, rhs: m[2]! });
  }
  for (const m of text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])\s*([^;\n]+)/g)) {
    bindings.push({ target: m[1]!, rhs: m[2]! });
  }
  const memberOf = new RegExp(String.raw`^[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*\s*\??\.\s*${property}$`);
  for (let changed = true; changed; ) {
    changed = false;
    for (const { target, rhs } of bindings) {
      if (names.has(target)) continue;
      const e = unwrapExpression(rhs);
      if (names.has(e) || memberOf.test(e)) {
        names.add(target);
        changed = true;
      }
    }
  }
  return names;
}

/**
 * The tab and browser calls that CHANGE which page the run is on
 * (src/codebehind/types.ts) — `tabs.open` / `openedBy` / `switchTo` / `close`,
 * `browsers.open` / `switchTo` / `close` — on the context's own object however
 * the entry reaches it: destructured, `ctx.tabs.…`, renamed in a destructure,
 * or through a local alias ({@link contextAliases}). The read-only ones —
 * `tabs.list()`, `tabs.active()`, `browsers.list()`, `browsers.activeLabel()`
 * — answer a question about the run, which is a condition's business (`If a
 * second tab is open, …`).
 */
function tabCallRule(text: string): { re: RegExp; why: string } {
  const alt = (names: Set<string>): string => [...names].map((n) => n.replace(/\$/g, '\\$')).join('|');
  return {
    re: new RegExp(
      String.raw`(?:^|[^\w$])(?:(?:${alt(contextAliases(text, 'tabs'))})\s*\.\s*(?:open|openedBy|switchTo|close)|` +
        String.raw`(?:${alt(contextAliases(text, 'browsers'))})\s*\.\s*(?:open|switchTo|close))\s*\(`,
    ),
    why: TAB_CALLS_WHY,
  };
}

/** The code of an entry with every string, template text, comment and regex
 *  blanked out, so a check for a CALL cannot fire on `'Click me'`. */
function codeOnly(code: string): string {
  const s = scan(code);
  let out = '';
  for (let i = 0; i < code.length; i++) out += s.mask[i] === CODE ? code[i] : ' ';
  return out;
}

/**
 * Calls a condition entry must not make whatever they are called on (the
 * story's rules: read only, and about the page NOW). Each is a precise call
 * shape rather than a word, so `isChecked()` is not `check(` and
 * `getByRole('button', { name: 'Click' })` is not `click(` — the entry is
 * scanned with its strings blanked first.
 *
 * The page ACTIONS are not here: `fill`, `clear`, `click` and the rest are
 * also the names of ordinary methods (`new Array(3).fill(0)`, `map.clear()`),
 * so they are refused only on a Playwright receiver — see
 * {@link CONDITION_PAGE_ACTIONS}.
 */
const CONDITION_FORBIDDEN: ReadonlyArray<{ re: RegExp; why: string }> = [
  // First, so `page.keyboard.press(` is named as the keyboard it is rather
  // than as the `.press(` the action rule would also match.
  {
    re: /\.\s*(?:keyboard|mouse|touchscreen)\s*\./,
    why: 'drives the keyboard or mouse. A condition reads the page; it never types or points',
  },
  {
    re: /\.\s*(?:goto|goBack|goForward|reload)\s*\(/,
    why: 'navigates. A condition is asked about the page the run is on, and must leave it there',
  },
  {
    // `step.settle()` too (docs/specs/SPEC-codebehind-robustness.md §6.4): it
    // waits for an entry's own actions, and a condition takes none.
    re: /\.\s*(?:waitFor\w*|settle)\s*\(/,
    why:
      'waits. The framework has already waited for the page to settle before it asks, so answer ' +
      'about the page now — an absent element is an answer, so check `await locator.count()` first',
  },
  {
    re: /(?:^|[^\w$.])setTimeout\s*\(/,
    why: 'sleeps. The page has already settled; answer about it now',
  },
  // The tab and browser calls that CHANGE which page the run is on
  // (src/codebehind/types.ts) go here, in this order — built per entry, since
  // they follow the entry's own aliases ({@link tabCallRule}).
  TAB_CALLS_SLOT,
  // On any receiver: `step.setVar(`, `ctx.step.setVar(`, a destructured `setVar(`.
  {
    re: /(?:^|[^\w$])(?:step\s*\.\s*)?setVar\s*\(/,
    why: "writes a variable. A condition only answers; it does not change the test's scope",
  },
];

/**
 * Playwright calls that act on the page — or on the page's context, which is
 * the page's next state — refused on a Playwright RECEIVER
 * ({@link isPlaywrightReceiver}): `page.close()`, `locator.fill('x')`,
 * `page.getByLabel('Cash').check()`, `page.setContent(…)`,
 * `context.clearCookies()`. The same names on anything else — an array, a map,
 * a helper object — are ordinary JavaScript.
 */
const CONDITION_PAGE_ACTIONS =
  /\.\s*(click|dblclick|fill|type|press|pressSequentially|check|uncheck|setChecked|selectOption|selectText|setInputFiles|hover|tap|focus|blur|dragTo|dragAndDrop|dispatchEvent|clear|scrollIntoViewIfNeeded|close|setContent|addScriptTag|addStyleTag|addInitScript|setViewportSize|bringToFront|route|unroute|newPage|newContext|clearCookies|addCookies|setExtraHTTPHeaders|emulateMedia|exposeFunction|exposeBinding|setGeolocation|grantPermissions|clearPermissions|setOffline)\s*\(/g;

const CONDITION_PAGE_ACTION_WHY =
  'acts on the page. A condition answers a question about the page and must not change the ' +
  'page it is asked about: read the state instead — `isChecked()`, `isEnabled()`, `count()`, ' +
  '`textContent()` after a `count()` check';

/** Identifiers that name a Playwright page-level object when they root a chain. */
const PLAYWRIGHT_ROOTS = new Set(['page', 'frame', 'context', 'browser']);

/** A call that makes a Playwright locator, element handle or page out of
 *  anything — `tabs.active()` included, which hands back the active page. */
const PLAYWRIGHT_MAKER =
  /(?:^|[^\w$])(?:locator|getBy[A-Za-z]+|frameLocator|contentFrame|\$\$?)\s*\(|(?:^|[^\w$])tabs\s*\.\s*active\s*\(/;

/**
 * Calls — and one property — whose RESULT is a value read off the page, never
 * a Playwright object: `await page.locator('li').count()` is a number,
 * `await locator.allTextContents()` an array of strings, `texts.length` a
 * number. A name bound from one is data. The page-object half (`all()`,
 * `first()`, `$()`, `elementHandle()`, …) is deliberately absent: those hand
 * back receivers.
 */
const VALUE_READS = new Set([
  // Playwright reads.
  'count', 'textContent', 'innerText', 'innerHTML', 'inputValue', 'getAttribute',
  'isChecked', 'isVisible', 'isHidden', 'isEnabled', 'isDisabled', 'isEditable',
  'allTextContents', 'allInnerTexts', 'title', 'url', 'content', 'boundingBox',
  'evaluate', 'evaluateAll', '$eval', '$$eval', 'ariaSnapshot', 'jsonValue',
  // JavaScript that answers with a primitive.
  'length', 'toString', 'trim', 'toLowerCase', 'toUpperCase', 'includes', 'startsWith',
  'endsWith', 'indexOf', 'test', 'join', 'some', 'every',
]);

/**
 * The receiver of the call whose `.` is at `dot`, read backwards over the
 * member chain — identifiers, `.`/`?.`, `!`, and balanced `( )` / `[ ]` groups
 * — in code whose strings are already blanked. `page.getByLabel(…).first()`
 * for `….first().check(`; `(await page.$('#a'))` for `(await page.$('#a')).click(`;
 * `el` for `el?.check(` — optional chaining is still a call on `el`.
 * Returns the chain and whether a `new` precedes it (a freshly constructed
 * object — `new Array(3).fill(0)` — is never the page).
 */
function receiverBefore(text: string, dot: number): { chain: string; constructed: boolean } {
  let i = dot - 1;
  const skipSpace = (): void => {
    while (i >= 0 && /\s/.test(text[i]!)) i--;
  };
  // `el?.check(`: the `?` of the call's own `?.`.
  if (text[i] === '?') i--;
  skipSpace();
  for (;;) {
    while (i >= 0 && text[i] === '!') i--; // TS non-null
    const c = text[i];
    if (c === ')' || c === ']') {
      const open = c === ')' ? '(' : '[';
      let depth = 0;
      for (; i >= 0; i--) {
        if (text[i] === c) depth++;
        else if (text[i] === open && --depth === 0) break;
      }
      i--;
    } else if (c !== undefined && /[\w$]/.test(c)) {
      while (i >= 0 && /[\w$]/.test(text[i]!)) i--;
    } else {
      break;
    }
    skipSpace();
    if (text[i] === '.') {
      i--;
      if (text[i] === '?') i--;
      skipSpace();
      continue;
    }
    // `locator(…)`, `items[0]` — what a call or index group is applied to is
    // part of the chain.
    if ((c === ')' || c === ']') && i >= 0 && /[\w$)\]]/.test(text[i]!)) continue;
    break;
  }
  const chain = text.slice(i + 1, dot).replace(/\?\s*$/, '').trim();
  const before = text.slice(Math.max(0, i - 8), i + 1);
  return { chain, constructed: /(?:^|[^\w$])new\s*$/.test(before) };
}

/** Split `text` at its depth-0 commas (strings are already blanked). */
function topLevelParts(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k < text.length; k++) {
    const c = text[k]!;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, k));
      start = k + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

/** The index of the bracket closing the one at `open`, or -1. */
function closingOf(text: string, open: number): number {
  const o = text[open]!;
  const c = o === '(' ? ')' : o === '[' ? ']' : '}';
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    if (text[k] === o) depth++;
    else if (text[k] === c && --depth === 0) return k;
  }
  return -1;
}

/** An expression with the wrapping it cannot be told apart by stripped:
 *  leading `await`s, a trailing TS `!` / `as T`, and parentheses round the
 *  whole of it. */
function unwrapExpression(expr: string): string {
  let e = expr.trim().replace(/;\s*$/, '');
  for (;;) {
    const before = e;
    e = e.replace(/^await\s+/, '').replace(/\s+as\s+[\w$.<>[\], ]+$/, '').replace(/!+$/, '').trim();
    if (e.startsWith('(') && closingOf(e, 0) === e.length - 1) e = e.slice(1, -1).trim();
    if (e === before) return e;
  }
}

/** The member name of an expression's LAST depth-0 access — `count` for
 *  `page.locator('li').count()`, `length` for `texts.length` — or undefined. */
function lastTopLevelMember(expr: string): string | undefined {
  let depth = 0;
  let last: string | undefined;
  for (let k = 0; k < expr.length; k++) {
    const c = expr[k]!;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === '.' && depth === 0) {
      const m = /^\.\s*([A-Za-z_$][\w$]*)/.exec(expr.slice(k));
      if (m) last = m[1];
    }
  }
  return last;
}

/**
 * Where a TypeScript type-argument list that starts at `at` (a `<` right after
 * an identifier) ends, when it is one — `<HTMLElement>` in
 * `page.evaluateHandle<HTMLElement>(…)`, `<Array<string>>` — and a call
 * follows it; otherwise -1. Read as a type only when every character inside is
 * one a type is spelled with and the closing `>` is followed by `(`, so
 * `n < m` and `a < b && c > d` stay comparisons.
 */
function typeArgumentsEnd(expr: string, at: number): number {
  if (expr[at] !== '<' || !/[\w$]/.test(expr[at - 1] ?? '')) return -1;
  let depth = 0;
  for (let k = at; k < expr.length; k++) {
    const c = expr[k]!;
    if (c === '<') depth++;
    else if (c === '>') {
      if (--depth === 0) return /^\s*\(/.test(expr.slice(k + 1)) ? k : -1;
    } else if (!/[\w$.\s,[\]|&{}:;?'"`]/.test(c)) return -1;
  }
  return -1;
}

/** Does the expression compute a primitive at its top level — a comparison,
 *  arithmetic, a negation, `typeof`? Its result is then data whatever it read.
 *  A TypeScript type argument (`evaluateHandle<HTMLElement>(`) is not a
 *  comparison. */
function computesPrimitive(expr: string): boolean {
  if (/^(?:!(?!=)|typeof\b|void\b|-|\+(?!\+))/.test(expr)) return true;
  let depth = 0;
  for (let k = 0; k < expr.length; k++) {
    const c = expr[k]!;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0) {
      const typeEnd = typeArgumentsEnd(expr, k);
      if (typeEnd >= 0) {
        k = typeEnd;
        continue;
      }
      const rest = expr.slice(k, k + 3);
      if (/^(?:===|!==|==|!=|<=|>=)/.test(rest)) return true;
      if ((c === '<' || c === '>') && expr[k - 1] !== '=' && expr[k + 1] !== '>') return true;
      if ('*/%'.includes(c) && expr[k + 1] !== '*' && expr[k - 1] !== '*') return true;
      if ((c === '+' || c === '-') && expr[k + 1] !== c && expr[k - 1] !== c) return true;
    }
  }
  return false;
}

/**
 * The branches of a depth-0 conditional expression — `a` and `b` of
 * `cond ? a : b` — or undefined when the expression is not one. `?.` and `??`
 * are not its `?`; a nested conditional in either branch is left for the
 * caller to split again.
 */
function conditionalBranches(expr: string): [string, string] | undefined {
  let depth = 0;
  let question = -1;
  let pending = 0;
  for (let k = 0; k < expr.length; k++) {
    const c = expr[k]!;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth !== 0) continue;
    else if (c === '?') {
      const next = expr[k + 1];
      // `?.` (not `?.5`, a conditional over a number) and `??` are not it.
      if ((next === '.' && !/\d/.test(expr[k + 2] ?? '')) || next === '?' || expr[k - 1] === '?') continue;
      if (question < 0) question = k;
      else pending++;
    } else if (c === ':' && question >= 0) {
      if (pending > 0) {
        pending--;
        continue;
      }
      return [expr.slice(question + 1, k), expr.slice(k + 1)];
    }
  }
  return undefined;
}

/** The operands of a depth-0 `&&` / `||` / `??` chain, or undefined when the
 *  expression has none of them at its top level. */
function logicalOperands(expr: string): string[] | undefined {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k < expr.length - 1; k++) {
    const c = expr[k]!;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0) {
      const two = expr.slice(k, k + 2);
      if ((two === '&&' || two === '||' || two === '??') && expr[k + 2] !== '=') {
        parts.push(expr.slice(start, k));
        start = k + 2;
        k++;
      }
    }
  }
  if (parts.length === 0) return undefined;
  parts.push(expr.slice(start));
  return parts;
}

/**
 * Is a binding's right-hand side a Playwright page, frame, locator or handle —
 * or a thing that holds one? A fresh `new …` is not; an array literal is when
 * one of its elements is (`[page.locator('a')]`, never `[]` or `[false]`); a
 * value READ is not, however it was reached (`await page.locator('li').count()`
 * is a number); anything else is when {@link isPlaywrightReceiver} says so. An
 * arrow function is judged by what it returns, so `(s) => page.locator(s)`
 * binds a locator-maker and `(s) => s.length > 0` does not.
 *
 * A value that is one of several — `n > 1 ? rows.nth(1) : rows.first()`,
 * `n > 0 && page.locator('tr').first()`, `a || page.getByRole('row')` — is a
 * receiver when any branch or operand it can be is one: the comparison inside
 * it decides WHICH value, not that the value is data (review round 3). Only
 * then is the top level read for a comparison or arithmetic.
 */
function rhsIsReceiver(rhs: string, names: ReadonlySet<string>): boolean {
  let e = unwrapExpression(rhs);
  const arrow = /^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*/.exec(e);
  if (arrow) e = unwrapExpression(e.slice(arrow[0].length));
  if (/^new\b/.test(e)) return false;
  if (e.startsWith('[') && closingOf(e, 0) === e.length - 1) {
    return topLevelParts(e.slice(1, -1)).some((part) => rhsIsReceiver(part, names));
  }
  const branches = conditionalBranches(e);
  if (branches) return branches.some((branch) => rhsIsReceiver(branch, names));
  const operands = logicalOperands(e);
  if (operands) return operands.some((operand) => rhsIsReceiver(operand, names));
  if (computesPrimitive(e)) return false;
  const last = lastTopLevelMember(e);
  if (last !== undefined && VALUE_READS.has(last)) return false;
  return isPlaywrightReceiver(e, names);
}

/**
 * Names bound to a Playwright page, frame, locator or handle anywhere in the
 * entry, to a fixpoint: a `page` alias from the destructure (`{ page: p }`),
 * `const next = page.getByRole(…)`, `let b; b = page.locator(…)`,
 * `const rows = await next.all()`, `const locs = [page.locator('a')]`, and the
 * loop variable of `for (const row of await rows…)`. A name bound from a value
 * READ is data, not a receiver ({@link rhsIsReceiver}). Approximate by design —
 * a right-hand side is read to the end of its line — and generous otherwise: a
 * name it wrongly marks only matters if the entry then calls a page action on
 * it.
 */
function playwrightNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/\bpage\s*:\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]!);
  const bindings: Array<{ targets: string[]; rhs: string }> = [];
  // A TypeScript annotation between the name and the `=` is read past:
  // `const btn: Locator = page.locator('#a')` binds `btn` as surely as the
  // untyped form does.
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*|\[[^\]]*\]|\{[^}]*\})\s*(?::[^=;\n]+)?=\s*([^;\n]+)/g)) {
    bindings.push({ targets: [...m[1]!.matchAll(/[A-Za-z_$][\w$]*/g)].map((t) => t[0]), rhs: m[2]! });
  }
  // A plain assignment after the declaration — `let b; b = page.locator(…)`.
  // Not a property write (`r.count = …`), not `==` / `=>` / `+=`.
  for (const m of text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])\s*([^;\n]+)/g)) {
    bindings.push({ targets: [m[1]!], rhs: m[2]! });
  }
  // `for (const row of <iterable>)` — the iterable is the header up to the
  // parenthesis that closes it, not the rest of the line.
  for (const m of text.matchAll(/\bfor\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = closingOf(text, open);
    if (close < 0) continue;
    const header = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+([\s\S]+)$/.exec(text.slice(open + 1, close));
    if (header) bindings.push({ targets: [header[1]!], rhs: header[2]! });
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const { targets, rhs } of bindings) {
      if (!rhsIsReceiver(rhs, names)) continue;
      for (const t of targets) {
        if (!names.has(t)) {
          names.add(t);
          changed = true;
        }
      }
    }
  }
  return names;
}

/**
 * Is this receiver chain a Playwright page, frame, locator or handle? Yes
 * when it is rooted at (or passes through) `page` / `frame` / `context` /
 * `browser` — `ctx.page` included — when it makes a locator or a page
 * (`locator(`, `getBy…(`, `frameLocator(`, `$(`, `tabs.active(`), or when it
 * uses a name {@link playwrightNames} bound to one. A receiver nothing
 * identifies — a helper's return value, a callback parameter — is NOT treated
 * as one: this is a static backstop for what a model writes, not a type
 * checker, and the next run is the proof either way.
 */
function isPlaywrightReceiver(chain: string, names: ReadonlySet<string>): boolean {
  if (PLAYWRIGHT_MAKER.test(chain)) return true;
  for (const [word] of chain.matchAll(/[A-Za-z_$][\w$]*/g)) {
    if (PLAYWRIGHT_ROOTS.has(word) || names.has(word)) return true;
  }
  return false;
}

/** `window.` / `document.` / `self.` / `globalThis.` / `top.` / `parent.`
 *  before a name: the global it names, whatever the page function declared. */
const GLOBAL_OWNER = String.raw`\b(?:window|document|self|globalThis|top|parent)\s*\.\s*`;

/**
 * Inside a function the PAGE runs — `page.evaluate(…)`, `locator.evaluate(…)`,
 * `evaluateAll`, `evaluateHandle`, `$eval` / `$$eval` — every DOM object is
 * the live page, so these calls change it. Checked over the page function
 * whether it is written as a function, as a string of code, or as the name of
 * a function the entry defines.
 */
const EVALUATE_MUTATING_CALLS: ReadonlyArray<RegExp> = [
  /\.\s*(?:click|submit|requestSubmit|dispatchEvent|focus|blur|select|reset|remove|removeChild|append|appendChild|prepend|before|after|replaceWith|replaceChildren|insertAdjacentHTML|insertAdjacentElement|insertAdjacentText|insertBefore|setAttribute|removeAttribute|toggleAttribute|setSelectionRange|setRangeText|showModal|showPicker|execCommand|scrollIntoView|scrollTo|scrollBy|setProperty|removeProperty)\s*\(/,
  /\bclassList\s*\.\s*(?:add|remove|toggle|replace)\s*\(/,
  /\bhistory\s*\.\s*(?:back|forward|go|pushState|replaceState)\s*\(/,
  // The location's own moves, on the global reached by name — a bare
  // `location.` is judged apart ({@link locationMutation}), since a page
  // function may name a local `location`.
  new RegExp(String.raw`${GLOBAL_OWNER}location\s*\.\s*(?:assign|replace|reload)\s*\(`),
  /\bwindow\s*\.\s*open\s*\(/,
  /\bdocument\s*\.\s*(?:write|writeln|open|close)\s*\(/,
  /\b(?:localStorage|sessionStorage)\s*\.\s*(?:setItem|removeItem|clear)\s*\(/,
];

/** An assignment operator, compound forms included — not `===`, `==`, `=>`. */
const ASSIGN = String.raw`\s*(?:[-+*/%|&^]|\*\*|<<|>>>?|\?\?|&&|\|\|)?=(?![=>])`;

/**
 * The DOM properties whose WRITE changes what the page shows, holds or
 * submits. A property assignment is refused only when it names one of these
 * (or `style.*` / `dataset.*`, or the location): a page function may keep its
 * own locals — `acc[k] = …`, `r.count = …`, `const [next] = …` — and those
 * change nothing.
 */
const DOM_STATE_PROPERTIES =
  'checked|value|selected|selectedIndex|disabled|readOnly|required|indeterminate|defaultValue|' +
  'defaultChecked|textContent|innerText|outerText|innerHTML|outerHTML|nodeValue|className|id|' +
  'hidden|src|href|action|method|type|placeholder|title|name|scrollTop|scrollLeft|open|' +
  'contentEditable|tabIndex|cookie|on[a-z]+';

const DOM_WRITES: ReadonlyArray<RegExp> = [
  // `el.checked = true`, `(el as HTMLInputElement).value += 'x'`, `document.title = …`.
  new RegExp(String.raw`\.\s*(?:${DOM_STATE_PROPERTIES})\b${ASSIGN}`),
  // `el.style.display = 'none'`, `el.dataset['state'] = …`, `el.style = …`, `el.classList = …`.
  new RegExp(String.raw`\.\s*(?:style|dataset)\s*(?:\.\s*[\w$]+|\[[^\]]*\])${ASSIGN}`),
  new RegExp(String.raw`\.\s*(?:style|dataset|classList)${ASSIGN}`),
  // `el['value'] = …` — the bracket form of a property above.
  new RegExp(String.raw`\[\s*(['"\x60])(?:${DOM_STATE_PROPERTIES})\1\s*\]${ASSIGN}`),
  // The location reached through the global: `window.location = …`,
  // `document.location.href = …`. A bare `location` is judged apart
  // ({@link locationMutation}).
  new RegExp(String.raw`${GLOBAL_OWNER}location(?:\s*\.\s*[\w$]+|\s*\[[^\]]*\])?${ASSIGN}`),
];

/**
 * A bare `location` the page function writes or moves — `location = …`,
 * `location.href = …`, `location.assign(…)` — named, or undefined.
 *
 * Bare, the name is the page's location only when the page function has not
 * declared its own: `const location = document.querySelector('.loc')
 * .textContent; return location === 'Sydney'` reads a label, and refusing its
 * declaration as a navigation (review round 3) cost a compiled condition. So
 * a declaration of a local named `location` is never a write, and once one
 * exists, every bare `location` is that local. `window.location` and its kin
 * stay the global's either way ({@link DOM_WRITES}, {@link EVALUATE_MUTATING_CALLS}).
 */
function locationMutation(body: string): string | undefined {
  if (/(?:^|[^\w$.])(?:const|let|var)\s+location\b/.test(body)) return undefined;
  const bare = String.raw`(?:^|[^\w$.])location`;
  const write = new RegExp(String.raw`${bare}(?:\s*\.\s*[\w$]+|\s*\[[^\]]*\])?${ASSIGN}`).exec(body);
  if (write) return write[0].replace(/^[^\w$]/, '').replace(/\s+/g, '');
  const move = new RegExp(String.raw`${bare}\s*\.\s*(?:assign|replace|reload)\s*\(`).exec(body);
  return move ? move[0].replace(/^[^\w$]/, '').replace(/\s+/g, '') : undefined;
}

/**
 * An expression that yields DOM nodes: a query (`querySelectorAll(…)`,
 * `getElementById(…)`, `closest(…)`, `elementFromPoint(…)`), a node's
 * neighbours (`children`, `parentElement`, `nextElementSibling`, …), or a
 * document collection (`document.body`, `forms`, `elements`, `options`,
 * `rows`, `cells`, `activeElement`). Not `document.title` — a string.
 */
const YIELDS_DOM_NODES =
  /\b(?:querySelector(?:All)?|getElementById|getElementsBy[A-Za-z]+|closest|elementsFromPoint|elementFromPoint)\s*\(|\.\s*(?:children|childNodes|(?:first|last)(?:Element)?Child|(?:next|previous)(?:Element)?Sibling|parent(?:Element|Node)|body|forms|elements|options|selectedOptions|rows|cells|tBodies|activeElement|labels|files)\b/;

/**
 * Is the write whose `.` (or `[`) is at `at` into a LOCAL the page function
 * built itself — `const r = {}`, `let out = []`, `new Map()`, a literal? Then
 * it changes nothing on the page, whatever the property is called.
 *
 * Not when that local was built FROM the page's nodes (review round 3):
 * `const boxes = [...document.querySelectorAll('input')]` is an array, but
 * `boxes[0].checked = true` ticks a box on the page — and so does it through
 * `[document.getElementById('a')]`. Only a write through such a local is
 * refused; `boxes.sort()` reorders a JavaScript array and touches no node.
 */
function writesToLocal(body: string, at: number): boolean {
  const { chain } = receiverBefore(body, at);
  const root = /^[\s(]*([A-Za-z_$][\w$]*)/.exec(chain)?.[1];
  if (root === undefined || root === 'document' || root === 'window') return false;
  const declared = new RegExp(
    String.raw`(?:const|let|var)\s+${root.replace(/\$/g, '\\$')}\s*=\s*(?=\{|\[|new\s+(?:Map|Set|WeakMap|Object|Array)\b|['"\x60\d])`,
  ).exec(body);
  if (!declared) return false;
  return !YIELDS_DOM_NODES.test(initialiserAt(body, declared.index + declared[0].length));
}

/** The initialiser that starts at `start`: up to its depth-0 `;`, line break
 *  or `,`, or the close of the block it sits in. */
function initialiserAt(body: string, start: number): string {
  let depth = 0;
  for (let k = start; k < body.length; k++) {
    const c = body[k]!;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (--depth < 0) return body.slice(start, k);
    } else if (depth === 0 && (c === ';' || c === '\n' || c === ',')) {
      return body.slice(start, k);
    }
  }
  return body.slice(start);
}

/** What a page function does that changes the page, named, or undefined. */
function pageFunctionMutation(body: string): string | undefined {
  for (const re of EVALUATE_MUTATING_CALLS) {
    const hit = re.exec(body);
    if (hit) return hit[0].replace(/\s+/g, '');
  }
  for (const re of DOM_WRITES) {
    const g = new RegExp(re.source, 'g');
    for (const hit of body.matchAll(g)) {
      const dot = hit[0].search(/[.[]/);
      if (dot >= 0 && writesToLocal(body, hit.index! + dot)) continue;
      return hit[0].replace(/^[^\w$.[]/, '').replace(/\s+/g, '');
    }
  }
  return locationMutation(body);
}

const EVALUATE_CALL = /\.\s*(evaluate|evaluateAll|evaluateHandle|\$eval|\$\$eval)\s*\(/g;

/**
 * The text of the function `name` the entry defines — `const act = () => …`,
 * `let act = function () { … }`, `function act() { … }` — raw, comments
 * blanked, strings kept, or undefined when the entry defines no such function.
 * Read to the end of its statement: a depth-0 `;`, the end of the block it
 * sits in, or a depth-0 line break that starts another statement.
 */
function definitionOf(code: string, text: string, scanned: ReturnType<typeof scan>, name: string): string | undefined {
  const escaped = name.replace(/\$/g, '\\$');
  const declared = new RegExp(String.raw`(?:const|let|var)\s+${escaped}\s*=\s*`).exec(text);
  const fn = new RegExp(String.raw`\bfunction\s*\*?\s*${escaped}\s*\(`).exec(text);
  const start = declared ? declared.index + declared[0].length : fn ? fn.index : -1;
  if (start < 0) return undefined;
  let depth = 0;
  let end = code.length;
  for (let k = start; k < code.length; k++) {
    if (scanned.mask[k] !== CODE) continue;
    const c = code[k]!;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      depth--;
      if (depth < 0) {
        end = k;
        break;
      }
      // `function act() { … }` ends at its own body's brace.
      if (depth === 0 && c === '}' && !declared) {
        end = k + 1;
        break;
      }
    } else if (depth === 0 && c === ';') {
      end = k;
      break;
    } else if (
      depth === 0
      && c === '\n'
      && /^\s*(?:const|let|var|return|await|if|for|while|function|throw)\b/.test(text.slice(k + 1))
    ) {
      end = k;
      break;
    }
  }
  let body = '';
  for (let k = start; k < end; k++) body += scanned.mask[k] === COMMENT ? ' ' : code[k];
  return body;
}

/**
 * The page function of every evaluate call — the first argument, or the second
 * for `$eval` / `$$eval`, whose first is a selector — as raw text with the
 * comments blanked and the strings KEPT, since a page function can be a string
 * of code. Only the page function: a string passed as the evaluate's `arg` is
 * data, and a selector like `'a[href=x]'` must not read as an assignment.
 *
 * A page function passed by NAME — `const act = () => …; page.evaluate(act)` —
 * is the function the entry defines under that name (resolved a few levels
 * deep, for a name bound to another name), so a click cannot be moved out of
 * the call to get past the check.
 */
function evaluateBodies(code: string, text: string, scanned: ReturnType<typeof scan>): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(EVALUATE_CALL)) {
    const open = m.index! + m[0].length - 1;
    const close = matchForward(scanned, open, '(', ')');
    const end = close === -1 ? code.length : close;
    // Split the arguments at depth-0 commas in CODE.
    const args: Array<[number, number]> = [];
    let depth = 0;
    let start = open + 1;
    for (let k = open + 1; k < end; k++) {
      if (scanned.mask[k] !== CODE) continue;
      const c = code[k]!;
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      else if (c === ',' && depth === 0) {
        args.push([start, k]);
        start = k + 1;
      }
    }
    args.push([start, end]);
    const which = m[1]!.startsWith('$') ? 1 : 0;
    const span = args[which];
    if (!span) continue;
    let body = '';
    for (let k = span[0]; k < span[1]; k++) body += scanned.mask[k] === COMMENT ? ' ' : code[k];
    for (let hops = 0; hops < 4; hops++) {
      const name = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(body)?.[1];
      if (name === undefined) break;
      const defined = definitionOf(code, text, scanned, name);
      if (defined === undefined) break;
      body = defined;
    }
    out.push(body);
  }
  return out;
}

/** The first forbidden call in the entry, named, with why — or undefined. */
function forbiddenCall(code: string, text: string): string | undefined {
  for (const rule of CONDITION_FORBIDDEN) {
    const { re, why } = rule === TAB_CALLS_SLOT ? tabCallRule(text) : rule;
    const match = re.exec(text);
    if (!match) continue;
    const call = match[0].replace(/^[^\w$.]/, '').replace(/\s+/g, '');
    return `The entry calls \`${call}\`, which ${why}.`;
  }

  const names = playwrightNames(text);
  for (const match of text.matchAll(CONDITION_PAGE_ACTIONS)) {
    const { chain, constructed } = receiverBefore(text, match.index!);
    if (constructed || !isPlaywrightReceiver(chain, names)) continue;
    return `The entry calls \`.${match[1]}(\`, which ${CONDITION_PAGE_ACTION_WHY}.`;
  }

  const scanned = scan(code);
  for (const body of evaluateBodies(code, text, scanned)) {
    const what = pageFunctionMutation(body);
    if (what === undefined) continue;
    return (
      `The entry's page function (\`evaluate\`) does \`${what}\`, which changes the page. A ` +
      'condition only reads: a page function may return what it finds, never click, submit, ' +
      'dispatch, focus or write to the DOM.'
    );
  }
  return undefined;
}

/**
 * The names an entry object literal defines at its OWN top level —
 * `run` and `condition` in `{ source, async run() {…}, condition: … }` — read
 * with the tokenizer, so `helpers.run(page)` inside a body and `x ? run : y`
 * are not definitions. Undefined when the code holds no object literal.
 */
function entryKeys(code: string): Set<string> | undefined {
  const s = scan(code);
  let open = -1;
  for (let i = 0; i < code.length; i++) {
    if (s.mask[i] === CODE && code[i] === '{') {
      open = i;
      break;
    }
  }
  if (open === -1) return undefined;
  const closeAt = matchForward(s, open, '{', '}');
  const end = closeAt === -1 ? code.length : closeAt;
  const keys = new Set<string>();
  let depth = 0;
  let expectKey = true;
  for (let i = open + 1; i < end; i++) {
    const kind = s.mask[i];
    if (kind !== CODE) {
      if (kind === COMMENT) continue;
      // A quoted key: `'run': …` / `"condition"() {…}`.
      const token = s.strings.find((t) => t.start === i);
      if (token && depth === 0 && expectKey) {
        let k = token.end;
        while (k < end && /\s/.test(code[k]!)) k++;
        if (code[k] === ':' || code[k] === '(') keys.add(token.value);
        expectKey = false;
        i = token.end - 1;
      }
      continue;
    }
    const c = code[i]!;
    if ('([{'.includes(c)) {
      depth++;
      expectKey = false;
      continue;
    }
    if (')]}'.includes(c)) {
      depth--;
      continue;
    }
    if (depth !== 0 || /\s/.test(c)) continue;
    if (c === ',') {
      expectKey = true;
      continue;
    }
    if (c === '*' && expectKey) continue;
    if (/[A-Za-z_$]/.test(c) && expectKey) {
      let j = i;
      while (j < end && /[\w$]/.test(code[j]!)) j++;
      const word = code.slice(i, j);
      let k = j;
      while (k < end && /\s/.test(code[k]!)) k++;
      const next = code[k];
      // `async run(`, `get x(` — a modifier, and the key follows it.
      if ((word === 'async' || word === 'get' || word === 'set') && next !== undefined && /[A-Za-z_$*]/.test(next)) {
        i = j - 1;
        continue;
      }
      if (next === '(' || next === ':' || next === ',' || next === '}' || next === undefined) keys.add(word);
      expectKey = false;
      i = j - 1;
      continue;
    }
    expectKey = false;
  }
  return keys;
}

/**
 * Does this entry object literal define a `condition` function at its own top
 * level? What makes an entry a condition entry — the review pass asks it of
 * every entry before a revision, so each one it finds must still be one after.
 */
export function entryDefinesCondition(code: string): boolean {
  const keys = entryKeys(code);
  return keys ? keys.has('condition') : /\bcondition\s*[(:]/.test(codeOnly(code));
}

/**
 * Why a generated CONDITION entry must not be written as it stands, or
 * undefined when it may — the condition's own static backstop, sharing one
 * re-ask with `undeclaredContextComplaint` as the step's checks do
 * (stories/codebehind-loops-and-conditions.md, "Generation").
 *
 * The shape first: a condition line's entry defines `condition` and never
 * `run` — the loader drops an entry with both, so it would silently be no
 * entry at all. Read off the object's OWN keys, so a `helpers.run(page)` call
 * or a `run` variable in the body is not a `run` definition. Then the calls a
 * condition must not make:
 *
 *  - the keyboard, the mouse, navigation, waits, sleeps, a tab or browser
 *    call that changes which page the run is on (`tabs.open` / `openedBy` /
 *    `switchTo` / `close`, `browsers.open` / `switchTo` / `close` — the reads
 *    `list()`, `active()` and `activeLabel()` are allowed) and any `setVar`,
 *    on whatever receiver;
 *  - a page ACTION (`click`, `fill`, `check`, `clear`, `close`, `setContent`,
 *    `route`, `clearCookies`, …) only on a Playwright receiver — `page`,
 *    `frame`, `context`, `browser`, a `locator(…)` / `getBy…(…)` /
 *    `frameLocator(…)` / `$(…)` / `tabs.active()` chain, or a name bound from
 *    one (declared, assigned later, destructured, held in an array literal, or
 *    a `for … of` item), called directly or through `?.` — because
 *    `new Array(3).fill(0)` and `map.clear()` are ordinary JavaScript. A name
 *    bound from a value READ (`await locator.count()`, `allTextContents()`,
 *    `title()`, a comparison) is data, not a receiver. A receiver nothing
 *    identifies (a helper's return value, a callback parameter) is let
 *    through: this is a backstop for what a model writes, not a type checker;
 *  - inside a page function (`evaluate`, `evaluateAll`, `evaluateHandle`,
 *    `$eval`, `$$eval` — a function, a string of code, or the NAME of a
 *    function the entry defines): a click, submit, dispatch, focus, DOM
 *    insertion or removal, attribute or style write, history or location move,
 *    storage write, or an assignment to a DOM property that holds page state
 *    (`el.checked = true`, `el.value = …`, `el.style.display = …`,
 *    `location.href = …`). An assignment to the page function's own locals —
 *    `acc[k] = …`, `r.count = …`, `const [next] = …` — changes nothing and is
 *    allowed.
 *
 * Since `generateConditionEntry` refuses an entry that still breaks one of
 * these after its re-ask, a false positive here costs a compiled condition —
 * which is why the action rule reads the receiver rather than the word.
 */
export function conditionEntryComplaint(code: string): string | undefined {
  const text = codeOnly(code);
  const keys = entryKeys(code);
  const definesRun = keys ? keys.has('run') : /\brun\s*[(:]/.test(text);
  const definesCondition = entryDefinesCondition(code);
  if (definesRun) {
    return (
      "The entry defines `run`. A condition line's entry defines `condition` ONLY — " +
      '`async condition({ page, step }) { … return true or false; }` — and never `run`: an entry ' +
      'with both is dropped when the file loads, and a `run` on a condition line never decides it.'
    );
  }
  if (!definesCondition) {
    return (
      'The entry defines no `condition` function. Write `async condition({ page, step })` and ' +
      'return true when the condition, as written, holds on the page now, false when it does not.'
    );
  }
  return forbiddenCall(code, text);
}

export interface GenerateConditionEntryOptions {
  /** The binding of the condition LINE — its `source` is the whole authored
   *  line, and is what the entry binds by. */
  binding: CodeBehindBinding;
  /** Every observation the caller kept, in visit order; the generator shows
   *  {@link pickConditionObservations} of them. */
  observations: ConditionObservation[];
  /** The live map at the observation, for the condition's references. */
  resolvedParameters: Record<string, string>;
  /** The map with the loop marks, for §7.6's dotted-name rule — see
   *  `GenerateStepEntryOptions.parameterMap`. */
  parameterMap?: Record<string, string> | undefined;
  /** The run's free-text mask set — see `GenerateStepEntryOptions.secrets`. */
  secrets?: string[] | undefined;
  envData?: EnvDataContext | undefined;
  aiClient: AiClient;
  contextContent: string;
  testName: string;
  baseUrl?: string | undefined;
  signal?: AbortSignal | undefined;
  wholeTest?: Array<{ index: number; text: string; inScope: boolean; isThisStep: boolean }>;
  candidateFile?: string | undefined;
  /** The loop this line sits in the body of, if any (decision 2). */
  loop?: LoopContext | undefined;
  /**
   * The repair variant: the line already has a `condition` entry and it broke
   * — it threw, returned a non-boolean, or said "carry on" at a loop's cap
   * where the model said stop. The prompt shows the code and what went wrong.
   */
  repair?: { entryCode: string; error: string } | undefined;
}

/**
 * Generate one condition line's `condition` entry. Never throws — a failed
 * call is a result, as for a step.
 *
 * The pre-checks mirror `generateStepEntry`'s and decline for the same
 * reasons: a condition with no DOM to read (decision 10), and a reference the
 * run cannot answer. The parameters, the env references and the leak guard
 * are scoped to the CONDITION rather than the whole line — the tail's values
 * are the tail's business — and go through the same `stepParameters` /
 * `stepEnvRefs` / `guardedValues`, so `getVar` names, env refs and the leak
 * guard behave exactly as they do for a step.
 */
export async function generateConditionEntry(
  options: GenerateConditionEntryOptions,
): Promise<GeneratedEntry> {
  const { binding } = options;
  const line = compilableCondition(binding.source);
  if (!line) {
    return { kind: 'error', message: 'the line has no condition a `condition` entry could answer' };
  }
  const observations = pickConditionObservations(options.observations);
  if (observations.length === 0) {
    return { kind: 'error', message: 'the run observed no decision of this condition to generate from' };
  }
  if (observations.every((o) => o.dom === undefined)) {
    return { kind: 'declined', reason: CONDITION_WITHOUT_DOM };
  }

  // The condition's own references, read through the line's binding scope —
  // a skill body's `{{order}}` is renamed exactly as it is on the whole line.
  const conditionBinding: CodeBehindBinding = { ...binding, source: line.condition };
  const parameters = stepParameters(conditionBinding, options.resolvedParameters, options.envData);
  const envRefs = stepEnvRefs(conditionBinding, options.envData);
  if (envRefs.unresolved.length > 0) {
    return { kind: 'declined', reason: unresolvedRefsReason(envRefs.unresolved, options.envData) };
  }
  const unresolvedInputs = unresolvedInputRefs(conditionBinding, options.resolvedParameters, options.envData);
  if (unresolvedInputs.length > 0) {
    return { kind: 'declined', reason: unresolvedRefsReason(unresolvedInputs, options.envData) };
  }

  const promptInput: ConditionCodePromptInput = {
    rawLine: binding.source,
    kind: line.kind,
    condition: line.condition,
    tail: line.tail,
    observations: observations.map((o) => ({
      holds: o.holds,
      ...(o.dom !== undefined && { dom: o.dom }),
      ...(o.url !== undefined && { url: o.url }),
    })),
    parameters,
    ...(options.parameterMap && { parameterMap: options.parameterMap }),
    ...(options.secrets && options.secrets.length > 0 && { secrets: options.secrets }),
    ...(envRefs.resolved.length > 0 && { envRefs: envRefs.resolved }),
    testInfoSection: formatTestInfo(options.testName, options.baseUrl),
    ...(options.wholeTest && { wholeTest: options.wholeTest }),
    ...(options.candidateFile !== undefined && { candidateFile: options.candidateFile }),
    ...(options.loop && { loop: options.loop }),
    ...(options.repair && { repair: options.repair }),
  };
  // The condition text, so a value the author QUOTED in it is the author's
  // (`guardedValues` / `authorQuotedLiterals`).
  const guarded = guardedValues(parameters, envRefs.resolved, line.condition);

  const first = await askForEntry(
    options.aiClient,
    options.contextContent,
    buildConditionCodePrompt(promptInput),
    guarded,
    options.signal,
    'condition',
  );
  if (first.kind !== 'entry') return first;

  // Two grades of complaint. A HARD one breaks a rule of what a condition is
  // (`conditionEntryComplaint`: a `run`, no `condition`, a call that acts,
  // navigates, types, waits, switches a tab or writes a variable) — such an
  // entry is never returned: a condition that clicks changes the page it is
  // asked about, and one with both `run` and `condition` is dropped by the
  // loader, so it would count as compiled while its guard stayed AI. A SOFT
  // one (`undeclaredContextComplaint`) is the step path's: one re-ask, then
  // take what we get, and the next run shows whether it holds.
  const firstHard = conditionEntryComplaint(first.code);
  const complaint = firstHard ?? undeclaredContextComplaint(first.code);
  if (complaint === undefined) return first;

  logger.info(`Code-behind for condition "${binding.source}" was asked once more: ${firstSentence(complaint)}`);
  logger.debug(`Code-behind re-asking for condition "${binding.source}": ${complaint}`);
  const second = await askForEntry(
    options.aiClient,
    options.contextContent,
    buildConditionCodePrompt({ ...promptInput, retry: { previousEntry: first.code, complaint } }),
    guarded,
    options.signal,
    'condition',
  );
  if (second.kind !== 'entry') {
    const why = second.kind === 'error' ? second.message : second.reason;
    if (firstHard !== undefined) {
      return {
        kind: 'error',
        message:
          `the generated condition broke a rule a condition must keep, and the re-ask produced no ` +
          `entry (${why}): ${firstHard}`,
      };
    }
    logger.debug(
      `The re-ask for condition "${binding.source}" produced no entry (${why}); keeping the first answer`,
    );
    return first;
  }
  const secondHard = conditionEntryComplaint(second.code);
  if (secondHard !== undefined) {
    // Neither answer is clean. The first one may still be — of hard faults:
    // its complaint was only the soft one.
    if (firstHard === undefined) {
      logger.warn(
        `Code-behind for condition "${binding.source}": the re-ask broke a rule (${secondHard}); ` +
          `keeping the first answer, whose only fault the next run will show. ${complaint}`,
      );
      return first;
    }
    return {
      kind: 'error',
      message: `the generated condition still broke a rule a condition must keep after one re-ask: ${secondHard}`,
    };
  }
  const stillWrong = undeclaredContextComplaint(second.code);
  if (stillWrong !== undefined) {
    logger.warn(
      `Code-behind for condition "${binding.source}" still has a fault the static check can see; ` +
        `the next run will show whether it holds. ${stillWrong}`,
    );
  }
  return second;
}

// ───────────────────────────────────────────────────────────────────────────
// Steps that only read, written from the recording
// (docs/specs/SPEC-codebehind-robustness.md §6.6)
// ───────────────────────────────────────────────────────────────────────────

/** What a step that only reads is compiled from: its pass's transcript and values. */
export interface RecordingEntryInput {
  binding: CodeBehindBinding;
  actions: RecordedAction[];
  resolvedParameters: Record<string, string>;
  envData?: EnvDataContext | undefined;
  /** The surface the step ran on; a computer-mode step never qualifies. */
  surface?: 'browser' | 'computer' | undefined;
}

/**
 * The entry for a step that only reads or counts, written from its recording
 * with NO model — or undefined when the step does not qualify, and goes to the
 * model as before (docs/specs/SPEC-codebehind-robustness.md §6.6, D7).
 *
 * When the AI performed such a step it did not write code: it chose a `read`
 * or `count` action, and Steptix carried it out — cleaned the selector,
 * resolved its frame, read each match, stored the result. The model chose only
 * the action's fields, and the recording keeps them exactly. So the entry is
 * those fields handed to `step.read` / `step.count`, which run the same path:
 * on the same page it produces exactly what the run produced, and failure B —
 * a compiled read whose selector lost a `:first-child` — cannot happen.
 *
 * A step qualifies when ALL of these hold:
 *  - it ran on the browser surface, and nothing refuses it (`refuseReason`);
 *  - every recorded action is a `read` or a `count` (`find` and `expand` only
 *    showed the model the page, and are left out), each with a selector;
 *  - each of them stores into a capture the step's own line declares, and
 *    every capture the line declares is stored by one of them — so the entry
 *    stores exactly what the run stored;
 *  - no recorded field holds a resolved parameter value: a model that wrote
 *    row 1's value where `{{account}}` belonged would freeze row 1 into the
 *    file. The leak guard decides, as it does for generated code;
 *  - no read falls under the selector story's positional carve-out — a
 *    positional target the step distinguishes by name. That one needs the
 *    model, to build a locator from the value.
 *
 * Names: the recorded `as` and any `{{placeholder}}` in a recorded field are
 * the RUN's names, which a skill body or a looped section renames
 * (`__skill1_total`). They are written back as the authored names
 * (`binding.scope.renames`), which `step.read` resolves through the frame at
 * replay.
 */
export function entryFromRecording(input: RecordingEntryInput): string | undefined {
  const { binding } = input;
  if (input.surface === 'computer') return undefined;
  if (refuseReason(binding.source, input.actions) !== undefined) return undefined;
  if (parseFlowControlStep(binding.source.trim())) return undefined;

  const reads = input.actions.filter((a) => !EXPLORATION_ACTIONS.has(a.action));
  if (reads.length === 0) return undefined;
  if (!reads.every((a) => a.action === 'read' || a.action === 'count')) return undefined;

  const authored = authoredNameOf(binding);
  const { captures } = referencedVariableNames(binding.source);
  const declared = new Set([...captures, ...inlineCaptureNames(binding.source)]);
  if (declared.size === 0) return undefined;
  const stored = new Set<string>();
  for (const action of reads) {
    if (typeof action.selector !== 'string' || action.selector.trim() === '') return undefined;
    if (typeof action.as !== 'string' || action.as.trim() === '') return undefined;
    const name = authored(action.as);
    if (!declared.has(name)) return undefined;
    stored.add(name);
    if (action.targeting?.resolvedBy === 'positional' && namesItsTarget(binding.source)) return undefined;
  }
  for (const name of declared) if (!stored.has(name)) return undefined;

  // The leak guard over the recorded fields, exactly as over generated code.
  const parameters = stepParameters(binding, input.resolvedParameters, input.envData);
  const envRefs = stepEnvRefs(binding, input.envData);
  if (envRefs.unresolved.length > 0) return undefined;
  const guarded = guardedValues(parameters, envRefs.resolved, binding.source);
  const fieldText = reads
    .map((a) => [a.selector, a.attribute, a.pattern, a.frame].filter((f) => typeof f === 'string').join('\n'))
    .join('\n');
  if (findInlinedParameterValue(fieldText, guarded)) return undefined;

  const calls = reads.flatMap((action) => {
    const fields: string[] = [`selector: ${tsString(authoredPlaceholders(action.selector!, binding))}`];
    if (action.action === 'read' && action.multiple === true) fields.push('multiple: true');
    if (action.action === 'read' && typeof action.attribute === 'string') {
      fields.push(`attribute: ${tsString(authoredPlaceholders(action.attribute, binding))}`);
    }
    if (action.action === 'read' && typeof action.pattern === 'string') {
      fields.push(`pattern: ${tsString(authoredPlaceholders(action.pattern, binding))}`);
    }
    if (typeof action.frame === 'string') fields.push(`frame: ${tsString(authoredPlaceholders(action.frame, binding))}`);
    fields.push(`as: ${tsString(authored(action.as!))}`);
    const kinds = action.targeting?.kinds;
    if (kinds !== undefined && kinds.length > 0) fields.push(`kinds: [${kinds.map(tsString).join(', ')}]`);
    return [
      `    await step.${action.action === 'count' ? 'count' : 'read'}({`,
      ...fields.map((field) => `      ${field},`),
      '    });',
    ];
  });

  return [
    '{',
    `  source: ${tsString(binding.source)},`,
    '  fromRecording: true,',
    '  async run({ step }) {',
    ...calls,
    '  },',
    '}',
  ].join('\n');
}

/** A single-quoted TypeScript string literal for `text` — the file's own
 *  style, and a selector's `[data-testid="x"]` stays readable. */
function tsString(text: string): string {
  const body = text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  return `'${body}'`;
}

/** The authored name for a run name the binding's frame renamed — or the
 *  name itself, when nothing renamed it. */
function authoredNameOf(binding: CodeBehindBinding): (runName: string) => string {
  const back = new Map<string, string>();
  for (const [authored, run] of Object.entries(binding.scope.renames)) back.set(run, authored);
  return (runName: string): string => back.get(runName) ?? runName;
}

/** `text` with every `{{run_name}}` (or `{{run_name.prop}}`) written back as
 *  the authored name. */
function authoredPlaceholders(text: string, binding: CodeBehindBinding): string {
  const authored = authoredNameOf(binding);
  return text.replace(PLACEHOLDER_REF_RE, (match, name: string) => {
    const dot = name.indexOf('.');
    const root = dot < 0 ? name : name.slice(0, dot);
    const mapped = authored(root);
    if (mapped === root) return match;
    return `{{${mapped}${dot < 0 ? '' : name.slice(dot)}}}`;
  });
}

/** `store as {{x}}` names in the step's own words. */
function inlineCaptureNames(source: string): string[] {
  return [...source.matchAll(CAPTURE_DEFINITION_RE)].map((m) => m[1]!);
}

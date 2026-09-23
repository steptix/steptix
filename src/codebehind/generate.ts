import type { AiClient } from '../ai/client.js';
import { normaliseUploadPath } from '../browser/upload-paths.js';
import { MIN_GUARDED_VALUE_LENGTH, findInlinedParameterValue, parseStepCodeOrDecline } from '../ai/action-parser.js';
import {
  buildStepCodePrompt,
  buildSystemPrompt,
  formatTestInfo,
  isSingularTarget,
  type StepCodePromptInput,
} from '../ai/prompts.js';
import type { AIAction, ChatMessage } from '../ai/types.js';
import {
  envDataRefsIn,
  interpolateEnvData,
  resolveEnvDataRef,
  type EnvDataContext,
} from '../parser/interpolate-env-data.js';
import { parseFlowControlStep } from '../parser/flow-control-step.js';
import { parseUseStep } from '../parser/use-step.js';
import { WIDE_PLACEHOLDER_SOURCE, interpolate } from '../parser/parameters.js';
import { boundValue } from '../runner/placeholder-substitution.js';
import type { AssertionResult } from '../report/types.js';
import { referencedVariableNames } from '../skills/expander.js';
import { logger } from '../utils/logger.js';
import type { CodeBehindBinding } from './loader.js';
import type { RecordedAction } from './recording.js';
import { scan, type StringToken } from './tokenizer.js';

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
   * compiler passes its snapshot, which `liveCompileSnapshot` marks. The
   * boxed compile passes nothing: its `resolvedParameters` is
   * `report.parameters`, an unmarked copy of the already-redacted map, and
   * handing that over would put `row.keyword` under the author rule.
   */
  parameterMap?: Record<string, string> | undefined;
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
  /** Code, guard-checked, ready for the candidate. */
  | { kind: 'entry'; code: string; references?: PlaceholderReport }
  /** Not expressible as code — becomes an `ai: true` entry with this reason. */
  | { kind: 'declined'; reason: string }
  /** The call itself failed. The compiler reports it and moves on. */
  | { kind: 'error'; message: string };

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

  const promptInput: StepCodePromptInput = {
    rawStepText: binding.source,
    parameters,
    ...(options.parameterMap && { parameterMap: options.parameterMap }),
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
    testInfoSection: formatTestInfo(options.testName, options.baseUrl),
    ...(options.wholeTest && { wholeTest: options.wholeTest }),
    ...(options.candidateFile !== undefined && { candidateFile: options.candidateFile }),
    ...(options.domBefore !== undefined && { domBefore: options.domBefore }),
    ...(options.urlBefore !== undefined && { urlBefore: options.urlBefore }),
    ...(options.domAfter !== undefined && { domAfter: options.domAfter }),
    ...(options.urlAfter !== undefined && { urlAfter: options.urlAfter }),
  };
  // The authored line goes in so a value the author quoted in it is not read
  // as a leak: see `guardedValues` / `authorQuotedLiterals`.
  const guarded = guardedValues(parameters, envRefs.resolved, binding.source);
  // Every value this step's references resolved to, keyed by the name the
  // MODEL would have written in an action: the authored name, the run-time
  // name a skill rename gave it, and each `${…}` reference. Used to read a
  // placeholder-bearing selector the way the runtime read it — see
  // `ambiguousSelectorComplaint`.
  const substitute = (text: string): string =>
    applyKnownValues(
      text,
      { ...options.resolvedParameters, ...Object.fromEntries(parameters.map((p) => [p.name, p.value])) },
      envRefs.resolved,
    );

  const first = await askForEntry(
    options.aiClient,
    options.contextContent,
    buildStepCodePrompt(promptInput),
    guarded,
    options.signal,
  );
  if (first.kind !== 'entry') return first;

  // ── The static backstops ──────────────────────────────────────────────────
  // All of them are for the case the prompt cannot cover: the model was told
  // the thing and wrote it the other way anyway.
  //
  // Selector ambiguity first (stories/codebehind-selector-ambiguity.md) — it
  // throws on replay, so it is self-announcing, where a stale handle
  // (stories/codebehind-framework-actions.md) drives the wrong tab and PASSES.
  // One re-ask is shared between them all: more would multiply a compile's
  // model calls for a handful of heuristics, and the complaint text carries
  // whichever fault fired.
  const complaint =
    staticEntryComplaint(first.code, options.actions, substitute) ??
    undeclaredContextComplaint(first.code) ??
    staleHandleComplaint(first.code) ??
    unwaitedReadComplaint(first.code);
  if (complaint === undefined) return reported(first);

  logger.debug(`Code-behind re-asking for "${binding.source}": ${complaint}`);
  const second = await askForEntry(
    options.aiClient,
    options.contextContent,
    buildStepCodePrompt({ ...promptInput, retry: { previousEntry: first.code, complaint } }),
    guarded,
    options.signal,
  );

  // ONE re-ask, then take what we get. The second answer is never re-checked
  // for the same fault, so this cannot spin — and it is never allowed to be
  // worse than the first: a re-ask that errors (the call failed, or the new
  // code tripped the leak guard) or declines falls back to the answer that
  // already passed every guard, rather than turning a heuristic into a failed
  // compile. `compileTest` treats a generation error as fatal for the whole
  // run, which is not a power a textual check over generated code should have.
  if (second.kind !== 'entry') {
    logger.debug(
      `The re-ask for "${binding.source}" produced no entry ` +
        `(${second.kind === 'error' ? second.message : second.reason}); keeping the first answer`,
    );
    return reported(first);
  }
  const stillWrong = staticEntryComplaint(second.code, options.actions, substitute);
  if (stillWrong !== undefined) {
    logger.warn(
      `Code-behind for "${binding.source}" still has a fault the static check can see; ` +
        `it may throw or hard-code a path on replay. ${stillWrong}`,
    );
  }
  const stillUndeclared = undeclaredContextComplaint(second.code);
  if (stillUndeclared !== undefined) {
    logger.warn(
      `Code-behind for "${binding.source}" still uses a context property it does not ` +
        `destructure; it will throw on replay. ${stillUndeclared}`,
    );
  }
  if (staleHandleComplaint(second.code) !== undefined) {
    logger.warn(
      `Code-behind for "${binding.source}" still uses \`page\` after switching tab or browser; ` +
        `it may drive the tab the step left. ${complaint}`,
    );
  }
  const stillUnwaited = unwaitedReadComplaint(second.code);
  if (stillUnwaited !== undefined) {
    logger.warn(
      `Code-behind for "${binding.source}" still asserts on a page value it never waited for; ` +
        `it may read the state from before the step. ${stillUnwaited}`,
    );
  }
  return reported(second);
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
 *  retries, so each is only as correct as the wait in front of it. */
const INSTANT_READ =
  /\.\s*(?:textContent|innerText|inputValue|allTextContents|allInnerTexts|getAttribute)\s*\(/;

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
 */
export function unwaitedReadComplaint(code: string): string | undefined {
  if (!/\bstep\s*\.\s*expect\s*\(/.test(code)) return undefined;
  if (!INSTANT_READ.test(code)) return undefined;
  if (WAITS_FOR_STATE.test(code)) return undefined;
  return (
    'The entry reads a value out of the page and asserts on it without ever waiting for the '
    + 'state it asserts. `step.expect` does not retry and the read does not either, so on replay '
    + 'this compares whatever the page held a millisecond after the action — which, when a '
    + 'request is still in flight, is the value from BEFORE the step. Wait for the NEW state '
    + "first: `await page.locator('#upload-status', { hasText: 'Uploaded logo.png' }).waitFor()` "
    + '(or `.filter({ hasText: ... })` on a locator you already have) does not resolve until that '
    + 'text is present, and `page.waitForFunction` covers what a text filter cannot. Read the '
    + 'value into `step.expect` after that, not instead of it.'
  );
}

/** Everything `run`'s context object carries. Used bare, each of these is a
 *  `ReferenceError` unless the entry destructured it. */
const CONTEXT_PROPERTIES = ['page', 'context', 'browser', 'step', 'log', 'tabs', 'browsers'] as const;

/** The destructured parameter list of `async run({ ... })`. Undefined when the
 *  entry took the context as a whole (`run(ctx)`), where there is nothing to
 *  check — `ctx.tabs` cannot be undeclared. */
const RUN_DESTRUCTURE = /\brun\s*\(\s*\{([^}]*)\}/;

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
  const declared = new Set(
    params[1]!
      // `{ page, step: s, log }` — the property name is what is in scope only
      // when there is no rename, and a rename means the author asked for it
      // either way, so the property half is the right half to read.
      .split(',')
      .map((part) => part.split(':')[0]!.trim())
      .filter(Boolean),
  );
  for (const name of CONTEXT_PROPERTIES) {
    if (declared.has(name)) continue;
    if (!new RegExp(`(?:^|[^\\w$.])${name}\\s*\\.`).test(code)) continue;
    // A local of the same name is defined, whatever the parameter list says.
    if (new RegExp(`(?:const|let|var)\\s+${name}\\b`).test(code)) continue;
    return (
      `The entry uses \`${name}\` but \`run\` does not destructure it — the parameter list is ` +
      `\`{ ${[...declared].join(', ')} }\`, so this throws \`ReferenceError: ${name} is not defined\` ` +
      `on the first replay. Add \`${name}\` to the destructured context object.`
    );
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
 * step's parameters and its environment references, from `guardedValues`.
 */
export async function askForEntry(
  aiClient: AiClient,
  contextContent: string,
  prompt: ChatMessage,
  guarded: Array<{ name: string; value: string }>,
  signal?: AbortSignal | undefined,
): Promise<GeneratedEntry> {
  let answer;
  try {
    const completion = await aiClient.complete(
      [{ role: 'system', content: buildSystemPrompt(contextContent) }, prompt],
      signal,
      { profile: 'authoring' },
    );
    answer = parseStepCodeOrDecline(completion.text);
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
  const leaked = findInlinedParameterValue(answer.entry, guarded);
  if (leaked) {
    return {
      kind: 'error',
      message:
        `the generated code contains the resolved value of ${describeGuardedName(leaked)} as a literal, ` +
        `so it was discarded`,
    };
  }

  return { kind: 'entry', code: answer.entry };
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
  const normalised = base
    .map((g) => ({ name: g.name, value: normaliseUploadPath(g.value) }))
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
): Array<{ name: string; value: string }> {
  const { placeholders } = referencedVariableNames(binding.source);
  const out: Array<{ name: string; value: string }> = [];
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
    const value = renamed !== undefined
      ? boundValue(resolvedParameters, renamed)
      : input !== undefined
        ? resolveInputValue(input, resolvedParameters, envData)
        : boundValue(resolvedParameters, name);
    if (value !== undefined) out.push({ name, value });
  }
  return out;
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
    judge(name, renamed ?? name, boundValue(options.resolvedParameters, renamed ?? name));
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
    `  // Kept as AI by \`aiui compile\`: ${sanitiseComment(reason)}`,
    `  source: ${JSON.stringify(source)},`,
    `  ai: true,`,
    `}`,
  ].join('\n');
}

/** One line, no comment terminator, no surprises in a generated file. */
function sanitiseComment(reason: string): string {
  return reason.replace(/\r?\n/g, ' ').replace(/\*\//g, '* /').trim();
}

import type { AiClient } from '../ai/client.js';
import { normaliseUploadPath } from '../browser/upload-paths.js';
import { findInlinedParameterValue, parseStepCodeOrDecline } from '../ai/action-parser.js';
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
import { interpolate } from '../parser/parameters.js';
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
const FRAMEWORK_ACTIONS: ReadonlySet<AIAction['action']> = new Set(['prompt']);

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
  /** Assertions the step evaluated, if any. */
  assertions?: AssertionResult[] | undefined;
  /** Live parameter map from the recording, for resolving `{{param}}`. */
  resolvedParameters: Record<string, string>;
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

/** What one generation call produced. */
export type GeneratedEntry =
  /** Code, guard-checked, ready for the candidate. */
  | { kind: 'entry'; code: string }
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

  const promptInput: StepCodePromptInput = {
    rawStepText: binding.source,
    parameters,
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
  const guarded = guardedValues(parameters, envRefs.resolved);

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
    staticEntryComplaint(first.code, options.actions) ??
    undeclaredContextComplaint(first.code) ??
    staleHandleComplaint(first.code);
  if (complaint === undefined) return first;

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
    return first;
  }
  const stillWrong = staticEntryComplaint(second.code, options.actions);
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
  return second;
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
): string | undefined {
  return ambiguousSelectorComplaint(code, actions) ?? literalUploadPathComplaint(code, actions);
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
): string | undefined {
  let strings: StringToken[] | undefined;
  for (const action of actions) {
    const selector = action.selector;
    const count = action.targeting?.matchCount;
    if (selector === undefined || count === undefined || count <= 1) continue;
    if (!isSingularTarget(action)) continue;
    strings ??= scan(code).strings;
    if (!strings.some((token) => token.value === selector && isBareUse(code, token))) continue;

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
 */
export function guardedValues(
  parameters: Array<{ name: string; value: string }>,
  envRefs: Array<{ ref: string; value: string }>,
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
  return [...base, ...normalised];
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
    const renamed = binding.scope.renames[name];
    const input = binding.scope.inputs[name];
    const value = renamed !== undefined
      ? resolvedParameters[renamed]
      : input !== undefined
        ? resolveInputValue(input, resolvedParameters, envData)
        : resolvedParameters[name];
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
    if (binding.scope.renames[name] !== undefined) continue;
    const input = binding.scope.inputs[name];
    if (input === undefined) continue;
    for (const ref of envDataRefsIn(resolveInputValue(input, resolvedParameters, envData))) {
      if (!out.includes(ref)) out.push(ref);
    }
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

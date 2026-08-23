import type { AiClient } from '../ai/client.js';
import { findInlinedParameterValue, parseStepCodeOrDecline } from '../ai/action-parser.js';
import { buildStepCodePrompt, buildSystemPrompt, formatTestInfo } from '../ai/prompts.js';
import type { AIAction, ChatMessage } from '../ai/types.js';
import {
  envDataRefsIn,
  resolveEnvDataRef,
  type EnvDataContext,
} from '../parser/interpolate-env-data.js';
import { interpolate } from '../parser/parameters.js';
import type { AssertionResult } from '../report/types.js';
import { referencedVariableNames } from '../skills/expander.js';
import { logger } from '../utils/logger.js';
import type { CodeBehindBinding } from './loader.js';

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
 * Actions that mutate **runner** state rather than the page. A transcript
 * containing one of these is not expressible as a `run(ctx)` body — the entry
 * would have no way to swap the active browser or answer a prompt — so the
 * step stays AI.
 */
const FRAMEWORK_ACTIONS: ReadonlySet<AIAction['action']> = new Set([
  'openBrowser',
  'switchBrowser',
  'closeBrowser',
  'openPage',
  'closePage',
  'switchPage',
  'prompt',
]);

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
    return `the step used "${framework.action}", which changes runner state rather than the page`;
  }
  if (actions.length === 0) {
    return 'the recorded run performed no page actions for this step';
  }
  return undefined;
}

export interface GenerateStepEntryOptions {
  binding: CodeBehindBinding;
  /** The recorded run's actions for this step, in execution order. */
  actions: AIAction[];
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

  const parameters = stepParameters(binding, options.resolvedParameters);
  const { captures } = referencedVariableNames(binding.source);
  const envRefs = stepEnvRefs(binding, options.envData);
  // A reference the run cannot answer is declined before the model is asked:
  // the code it would write calls `getVar` for a value that does not exist,
  // and the replay would only discover that one round later.
  if (envRefs.unresolved.length > 0) {
    return { kind: 'declined', reason: unresolvedRefsReason(envRefs.unresolved, options.envData) };
  }

  const prompt = buildStepCodePrompt({
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
  });

  return askForEntry(
    options.aiClient,
    options.contextContent,
    prompt,
    guardedValues(parameters, envRefs.resolved),
    options.signal,
  );
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
  return [
    ...parameters,
    ...envRefs.map((r) => ({ name: `\${${r.ref}}`, value: r.value })),
  ];
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
): Array<{ name: string; value: string }> {
  const { placeholders } = referencedVariableNames(binding.source);
  const out: Array<{ name: string; value: string }> = [];
  for (const name of placeholders) {
    const renamed = binding.scope.renames[name];
    const input = binding.scope.inputs[name];
    const value = renamed !== undefined
      ? resolvedParameters[renamed]
      : input !== undefined
        ? interpolate(input, resolvedParameters)
        : resolvedParameters[name];
    if (value !== undefined) out.push({ name, value });
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

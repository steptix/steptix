import path from 'node:path';
import type { AiClient } from '../ai/client.js';
import { findInlinedParameterValue, parseStepCode } from '../ai/action-parser.js';
import { buildStepCodePrompt, buildSystemPrompt, formatTestInfo } from '../ai/prompts.js';
import type { AIAction } from '../ai/types.js';
import type { CachedStepData } from '../cache/step-cache.js';
import { interpolate } from '../parser/parameters.js';
import type { AssertionResult } from '../report/types.js';
import { referencedVariableNames } from '../skills/expander.js';
import { logger } from '../utils/logger.js';
import type { CodeBehindBinding } from './loader.js';
import { tryWriteCodeBehindEntry, type WriteEntryAction } from './writer.js';

/**
 * Turning a successful AI run of a step into its code-behind entry
 * (stories/step-codebehind.md, "Generation").
 *
 * One extra model call, on the step's success path, gated by
 * `codebehind.generate` in the project's config. Everything here is
 * best-effort: a step that already passed must never fail because its
 * code-behind couldn't be written.
 */

/**
 * Actions that mutate **runner** state rather than the page. A transcript
 * containing one of these is not expressible as a `run(ctx)` body — the entry
 * would have no way to swap the active browser or answer a prompt — so the
 * step keeps running under AI/cache and nothing is written.
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
 * `executeStep`, so the authored text still arrives with its marker. Writing
 * an entry for one would be worse than writing none — the prompt describes
 * the marker's contract to nobody, so a generated entry could quietly stop
 * making the capture the marker exists to make. Code-behind for these is a
 * stated non-goal (stories/step-codebehind.md, "Non-goals"); execution of a
 * hand-written entry still works, only generation is refused.
 */
const BRACKET_TOKEN_STEP = /^\[(skill|tool|input|output|interactive)\b/i;

export interface GenerateCodeBehindOptions {
  binding: CodeBehindBinding;
  /** The successful run's turns — the transcript the prompt is built from. */
  turns: CachedStepData[];
  /** Assertions the step evaluated, if any. */
  assertions?: AssertionResult[] | undefined;
  /** Live parameter map, for resolving the step's `{{param}}` references. */
  resolvedParameters: Record<string, string>;
  aiClient: AiClient;
  contextContent: string;
  testName: string;
  baseUrl?: string | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Generate and write one entry. Returns what the writer did, or null when
 * generation was skipped or refused.
 */
export async function generateCodeBehind(
  options: GenerateCodeBehindOptions,
): Promise<WriteEntryAction | null> {
  const { binding } = options;
  const actions = options.turns.flatMap((t) => t.actions ?? []);

  if (actions.length === 0) {
    logger.debug(`Code-behind generation skipped for "${binding.source}" — no recorded actions`);
    return null;
  }
  if (BRACKET_TOKEN_STEP.test(binding.source.trim())) {
    logger.debug(`Code-behind generation skipped for "${binding.source}" — bracket-token step`);
    return null;
  }
  const framework = actions.find((a) => FRAMEWORK_ACTIONS.has(a.action));
  if (framework) {
    logger.info(
      `Code-behind generation skipped for "${binding.source}" — the step used ` +
        `"${framework.action}", which changes runner state rather than the page. ` +
        `It keeps running under AI.`,
    );
    return null;
  }

  const parameters = stepParameters(binding, options.resolvedParameters);
  const { captures } = referencedVariableNames(binding.source);

  const prompt = buildStepCodePrompt({
    rawStepText: binding.source,
    parameters,
    actions,
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
  });

  let entryCode: string;
  try {
    const completion = await options.aiClient.complete(
      [
        { role: 'system', content: buildSystemPrompt(options.contextContent) },
        prompt,
      ],
      options.signal,
    );
    entryCode = parseStepCode(completion.text);
  } catch (err) {
    logger.warn(
      `Code-behind generation failed for "${binding.source}": ${(err as Error).message}`,
    );
    return null;
  }

  // The non-negotiable guard. A parameter value reaching a committed file as
  // a literal is exactly the failure this feature must not introduce, and a
  // password is the case that makes it non-negotiable.
  const leaked = findInlinedParameterValue(entryCode, parameters);
  if (leaked) {
    logger.warn(
      `Code-behind generation refused for "${binding.source}": the generated code ` +
        `contains the resolved value of {{${leaked}}} as a literal. Nothing was ` +
        `written — the step keeps running under AI.`,
    );
    return null;
  }

  const action = await tryWriteCodeBehindEntry({
    file: binding.file,
    source: binding.source,
    section: binding.section,
    occurrence: binding.occurrence,
    entryCode,
    markdownFile: markdownPathFor(binding.file),
  });
  if (action) {
    logger.success(
      `Code-behind ${action} for "${binding.source}" in ${path.basename(binding.file)}`,
    );
  }
  return action;
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
function stepParameters(
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

/** `tests/github.steps.ts` → `tests/github.md`, for the created-file header. */
function markdownPathFor(stepsFile: string): string {
  return stepsFile.replace(/\.steps\.ts$/, '.md');
}

import type { AiInteraction, StepResult, TurnResult } from '../report/types.js';
import type { ChatMessage } from '../ai/types.js';
import type { EnvDataContext } from '../parser/interpolate-env-data.js';
import { stripFailureTail, type ParsedFailureTail } from '../parser/failure-tail.js';
import { useStepError, type ParsedUseAiStep } from '../parser/use-step.js';
// From the PARSER's light module, as `runSetStep` does — see its comment.
import { bindVariable } from '../parser/parameters.js';
import { resolveUseAiText, substituteText } from './placeholder-substitution.js';
import { buildUseAiPrompt, contentBlocksToText, maskValueForPrompt } from '../ai/prompts.js';
import { parseUseAiReply } from '../ai/action-parser.js';
import { isSecretParameterName, isSecretRef, redact } from '../utils/secrets.js';
import { applyTailOutcome } from './failure-tail-outcome.js';
import { logger } from '../utils/logger.js';

/**
 * Running one `[use ai] <step>` (stories/use-ai-step.md).
 *
 * The step's text, placeholders filled and secrets masked, goes to the model
 * ON ITS OWN — no page, no DOM, no screenshot, no history, no date — and the
 * value it answers with is stored as a variable. Shared by all four step
 * loops (the CLI runner's main flow and hook scopes, the Sessions API, the
 * errand runner and the Electron runner) for `runSetStep`'s reason: a second
 * copy is how one of them starts disagreeing about what the step costs or
 * what it reports.
 *
 * What it deliberately does not have, and why each absence is the feature:
 *
 *  - **No cache and no code-behind.** It is dispatched where `Set` is, before
 *    `executeStep`, which is the only reader and writer of the step cache and
 *    the only thing that runs a `.steps.ts` entry. The model answers on every
 *    run; an author who wants the same value every time writes a `[tool:]`.
 *  - **No page, and no import of the executor.** Nothing here can reach a
 *    browser, and the computer lock is never taken for it (`stepReadsScreen`
 *    says no).
 *  - **No masking of its own RESULT.** The value is stored as the model wrote
 *    it and reported the way a `Set` value is; masking outputs is each loop's
 *    existing job. What IS masked here is what goes OUT to the model.
 */

/** The four fields a loop reads back. `name` / `value` are present only when
 *  a value was stored under a reportable name — a skill-internal `__skill*`
 *  name is bound and never reported, exactly as `runSetStep` does it. */
export interface UseAiStepOutcome {
  result: StepResult;
  name?: string;
  value?: string;
}

/** The one method of `AiClient` this step needs, so a caller — or a test —
 *  can hand over anything that answers it. */
export interface UseAiModel {
  complete(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<{ text: string; model?: string | undefined }>;
}

export interface UseAiStepArgs {
  /** The line, parsed. The loop parsed it to decide to come here. */
  parsed: ParsedUseAiStep;
  /** 1-based, like every `StepResult.index`. */
  index: number;
  /** The AUTHORED line, which is also what the report shows — a `[use ai]`
   *  step, like a `Set`, is never interpolated before it runs. */
  instruction: string;
  /** The live variable map: read for the placeholders, written with the value. */
  scope: Record<string, string>;
  envData?: EnvDataContext | null | undefined;
  /** The loop's free-text mask set (`secretsNow()`), which `maskValueForPrompt`
   *  applies inside a value whose NAME says nothing. */
  secrets: readonly string[];
  /** The test's `## Config: unmask:` names, exempt from every rule. */
  unmask?: ReadonlySet<string> | undefined;
  aiClient: UseAiModel;
  /** `execution.retries` — formatting failures are retried within it. */
  retries: number;
  signal?: AbortSignal | undefined;
  /** The line's `… otherwise …` tail, parsed off the authored line by the
   *  loop. Stripped from what the model reads and applied to the outcome. */
  failureTail?: ParsedFailureTail | null | undefined;
}

/** The errors that are about THIS MACHINE, not the reply: asking again cannot
 *  help, so they fail the step on the first attempt. Matched by name so this
 *  module does not import the AI client (and its gateway library). */
const NOT_RETRIED = new Set([
  'AiNotConfiguredError',
  'AiForbiddenByPolicyError',
  'GatewayUrlRequiredError',
]);

/** The fixes the name check names, written once. */
const NAME_FIXES = 'say what to call it in the step, or add `[store as: name]`';

/**
 * The name to store under when the step pinned none: the model's `as`, but
 * only when the step's own words contain it as a whole word
 * (case-insensitive) — and then in the STEP's spelling, since that is the
 * spelling a later `{{…}}` was written with.
 *
 * The check exists because an unbound plain `{{name}}` in a later step is
 * left literal with only a warning, so a name the author did not expect would
 * fail silently three steps later rather than here.
 */
function nameTheStepGives(
  as: string | undefined,
  text: string,
): { name: string } | { why: string } {
  if (as === undefined) {
    return { why: `the reply named no variable ("as"), and the step names none either; ${NAME_FIXES}` };
  }
  if (!/^\w+$/.test(as)) {
    return { why: `the model named the value \`${as}\`, which is not a variable name; ${NAME_FIXES}` };
  }
  const found = new RegExp(`\\b${as}\\b`, 'i').exec(text);
  if (!found) {
    return { why: `the model named the value \`${as}\`, which the step does not mention; ${NAME_FIXES}` };
  }
  return { name: found[0] };
}

export async function runUseAiStep(args: UseAiStepArgs): Promise<UseAiStepOutcome> {
  const startedAt = Date.now();
  const { parsed, index, instruction, scope, signal } = args;
  const values = { parameters: scope, ...(args.envData ? { envData: args.envData } : {}) };
  const turns: TurnResult[] = [];
  let attemptsMade = 0;

  /** The tail's message, `{{…}}` resolved against the run and masked — the
   *  shape `applyTailOutcome` expects, and what `applyFailureTail` builds for
   *  a page step. */
  const tailMessage = (): string | undefined => {
    const message = args.failureTail?.message;
    if (!message) return undefined;
    return redact(substituteText(message, values), [...args.secrets]);
  };

  const failed = (error: string, explanation: string): UseAiStepOutcome => ({
    result: applyTailOutcome(
      {
        index,
        instruction,
        status: 'failed',
        turns,
        durationMs: Date.now() - startedAt,
        retried: attemptsMade > 1,
        error,
        aiExplanation: explanation,
      },
      args.failureTail,
      tailMessage(),
    ),
  });

  // 1. The refusals a parser would have made, on the paths no parser runs —
  //    a Sessions API POST, an errand, a hook line. Same message, same words.
  const refusal = useStepError(instruction);
  if (refusal !== null) return failed(refusal, 'The [use ai] step was not sent to the model');

  // 2. What the model reads: the step minus its tail (decision 10), with
  //    every reference filled in and every secret-named value masked by the
  //    `## Values` block's own membership rule (decision 4).
  const question = stripFailureTail(parsed.text);
  const unmask = args.unmask ?? new Set<string>();
  const secrets = [...args.secrets];
  const resolved = resolveUseAiText(question, values, {
    defines: new Set(parsed.defines),
    show: (kind, name, value) =>
      maskValueForPrompt(
        kind === 'placeholder' ? isSecretParameterName(name, scope) : isSecretRef(name),
        name,
        value,
        unmask,
        secrets,
      ),
  });
  if ('error' in resolved) {
    return failed(resolved.error, 'The [use ai] step was not sent to the model');
  }

  // 3. Ask, within `execution.retries`. Exactly one explicit name is
  //    authoritative; with none, the model's `as` is checked against the
  //    step's words (decision 6).
  const explicitName = parsed.explicitNames[0];
  const attempts = Math.max(0, Math.floor(args.retries)) + 1;
  /** Why the last reply could not be used — for the model, on the retry. */
  let retryNote: string | undefined;
  /** …and for the step's error, if no attempt succeeds. */
  let lastFailure = 'the model was not asked';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    attemptsMade = attempt;
    const messages = buildUseAiPrompt(resolved.text, explicitName, retryNote);
    const timestamp = new Date().toISOString();

    let completion: { text: string; model?: string | undefined };
    try {
      completion = await args.aiClient.complete(messages, signal);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      // A stop is a stop, not a failure: no tail, no retry. The loops read
      // `signal.aborted` after the step and record the run as aborted.
      if (signal?.aborted || error.name === 'AbortError') {
        return {
          result: {
            index,
            instruction,
            status: 'failed',
            turns,
            durationMs: Date.now() - startedAt,
            retried: attempt > 1,
            error: 'Aborted by client',
            aiExplanation: 'Step aborted by client (run stopped).',
          },
        };
      }
      if (NOT_RETRIED.has(error.name)) {
        return failed(error.message, 'The [use ai] step could not ask the model');
      }
      // A transport failure is not the model's reply, so it says nothing the
      // retry prompt should repeat back to it.
      lastFailure = `the model call failed: ${error.message}`;
      if (attempt < attempts) logger.warn(`[use ai] step ${index}: ${lastFailure} — retrying`);
      continue;
    }

    const interaction: AiInteraction = {
      purpose: 'use-ai',
      attemptNumber: attempt,
      requestMessages: messages.map((m) => ({ role: m.role, content: contentBlocksToText(m.content) })),
      response: completion.text,
      ...(completion.model !== undefined && { model: completion.model }),
      timestamp,
    };
    // One turn per attempt, holding the call and no actions — the `guardResult`
    // shape (control-runtime.ts), so the report's ordinary turn block shows
    // the model's raw answer here as it does on any step.
    turns.push({
      turnNumber: attempt,
      attemptNumber: attempt,
      timestamp,
      aiInteractions: [interaction],
      subActions: [],
    });

    const reply = parseUseAiReply(completion.text);
    if (reply.kind === 'error') {
      // A real outcome, NOT retried: asking again until the model stops
      // refusing is how a guess gets stored (decision 5).
      return failed(
        `The model could not do the [use ai] step as written: ${reply.reason}`,
        `The model declined: ${reply.reason}`,
      );
    }
    if (reply.kind === 'malformed') {
      retryNote = reply.why;
      lastFailure = `the model's reply could not be used: ${reply.why}`;
      if (attempt < attempts) logger.warn(`[use ai] step ${index}: ${lastFailure} — retrying`);
      continue;
    }

    const named =
      explicitName !== undefined ? { name: explicitName } : nameTheStepGives(reply.as, question);
    if ('why' in named) {
      // Retried like any formatting failure: a model that misspelled a name
      // the step does give will usually correct it when told.
      retryNote = named.why;
      lastFailure = named.why;
      if (attempt < attempts) logger.warn(`[use ai] step ${index}: ${lastFailure} — retrying`);
      continue;
    }

    // The write — the same helper every other writer uses, so a rebind of a
    // loop's item name clears its dotted keys here too.
    bindVariable(scope, named.name, reply.value);
    const reportable = !named.name.startsWith('__skill');
    return {
      result: {
        index,
        instruction,
        status: 'passed',
        turns,
        durationMs: Date.now() - startedAt,
        retried: attempt > 1,
        ...(reportable && { outputs: { [named.name]: reply.value } }),
        aiExplanation: `[use ai] ${named.name} = "${reply.value}"`,
      },
      ...(reportable && { name: named.name, value: reply.value }),
    };
  }

  return failed(
    `The [use ai] step stored nothing: ${lastFailure}`,
    attemptsMade > 1
      ? `No usable reply in ${attemptsMade} attempts`
      : 'The reply could not be used',
  );
}

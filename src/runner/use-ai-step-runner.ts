import type { AiInteraction, StepResult, TurnResult } from '../report/types.js';
import type { ChatMessage } from '../ai/types.js';
import type { EnvDataContext } from '../parser/interpolate-env-data.js';
import { stripFailureTail, type ParsedFailureTail } from '../parser/failure-tail.js';
import { useStepError, type ParsedUseAiStep } from '../parser/use-step.js';
// From the PARSER's light module, as `runSetStep` does — see its comment.
import { bindVariable } from '../parser/parameters.js';
import {
  boundValue,
  resolveUseAiText,
  substituteText,
  type PlaceholderValues,
} from './placeholder-substitution.js';
import { buildUseAiPrompt, contentBlocksToText, maskValueForPrompt } from '../ai/prompts.js';
import { parseUseAiReply } from '../ai/action-parser.js';
import { resolveEnvDataRef } from '../parser/interpolate-env-data.js';
import {
  isSecretName,
  isSecretParameterName,
  isSecretRef,
  MASK,
  redact,
} from '../utils/secrets.js';
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
 *  - **No code-behind.** It is dispatched where `Set` is, before
 *    `executeStep`, which is the only thing that runs a `.steps.ts` entry. The model answers on every
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
   *  applies inside a value whose NAME says nothing, and which is applied to
   *  the step's own words too — where a skill argument or a looped section's
   *  row value was written in, so the set must carry those
   *  (`runSecretsWithInputs`). */
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

/**
 * How a reference's value was kept from the model (issue 060):
 *
 *  - `name` — whole, because its NAME marks it secret. The one kind renaming
 *    the variable would lift, and the one with a likely false positive:
 *    `{{keyword}}` contains `key`.
 *  - `whole` — whole, because the value IS a secret the run knows under
 *    another name.
 *  - `part` — a record's secret column, or a known secret inside a longer
 *    value. Said to be part, because the reference's name says nothing secret
 *    and the author would otherwise look for a secret that is not there.
 */
type HiddenKind = 'name' | 'whole' | 'part';

/** What this step kept from the model: each reference, as the author spells
 *  it, once, in the step's order — and whether its own words held a secret. */
interface HiddenFromModel {
  refs: Map<string, { kind: HiddenKind; name: string }>;
  inText: boolean;
}

const hidAnything = (hidden: HiddenFromModel): boolean => hidden.refs.size > 0 || hidden.inText;

/**
 * A skill body's variable as the AUTHOR wrote it. `applySkillScope`
 * (src/skills/expander.ts) renames each skill-internal name to
 * `__skill<N>_<name>`, a spelling the author never wrote and cannot search the
 * skill for. Only that prefix is removed, as often as it was applied.
 */
function authoredName(name: string): string {
  return name.replace(/^(?:__skill\d+_)+/, '');
}

/** `a`, `a and b`, `a, b and c`. */
function listed(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]!}`;
}

/**
 * The shortest stretch of `name` that the author rule calls secret — `key` in
 * `keyword`, `token` in `api_token` — found by asking `isSecretName` itself
 * rather than a copy of its word list, so the two cannot drift. Undefined for
 * a name only the record rule marks (`order.otp`), which says no such word.
 */
function secretWordIn(name: string): string | undefined {
  for (let length = 1; length <= name.length; length++) {
    for (let at = 0; at + length <= name.length; at++) {
      const piece = name.slice(at, at + length);
      if (isSecretName(piece)) return piece;
    }
  }
  return undefined;
}

/** What was hidden, as the step's errors name it: never a value. */
function hiddenList(hidden: HiddenFromModel): string {
  const items = [...hidden.refs].map(([ref, { kind }]) =>
    kind === 'part' ? `part of \`${ref}\`` : `\`${ref}\``,
  );
  if (hidden.inText) items.push("a secret written into the step's text");
  return listed(items);
}

/**
 * The sentences that say how to lift a mask, after either error.
 *
 * A name-rule mask says the name is the reason, because renaming is then the
 * whole fix and nothing else in the message points at it. Not `unmask:`: only
 * `aiui run` sends it, so it is no fix under TestBench, MCP or Flick.
 *
 * A secret in the step's own words is explained, because the author usually
 * wrote `{{password}}` in a section body or a skill and is looking at a
 * placeholder, not at text — and when the author's own word merely equals a
 * short secret, the same sentence says why that word was masked.
 */
function hiddenHints(hidden: HiddenFromModel): string {
  const hints: string[] = [];
  const byName = [...hidden.refs].filter(([, { kind }]) => kind === 'name');
  if (byName.length > 0) {
    const one = byName.length === 1;
    const refs = listed(byName.map(([ref]) => `\`${ref}\``));
    const words = byName.map(([, { name }]) => secretWordIn(name));
    const which = words.every((word) => word !== undefined)
      ? `, which ${one ? 'contains' : 'contain'} ${listed(words.map((word) => `"${word}"`))}`
      : '';
    hints.push(
      `${refs} ${one ? 'is hidden by its name' : 'are hidden by their names'}${which}; ` +
        `${one ? 'if it is not a secret, rename it' : 'rename any that is not a secret'}.`,
    );
  }
  if (hidden.inText) {
    hints.push(
      "A secret's value is masked wherever it appears in the step's text, including where a " +
        "skill's argument or a looped section's row put it.",
    );
  }
  return hints.length === 0 ? '' : ` ${hints.join(' ')}`;
}

/**
 * The step's error when the model's value holds the mask (issue 060). Names
 * what was hidden as the step spells it — `{{password}}`, `${env.API_KEY}` —
 * and never its value.
 */
function hiddenValueError(hidden: HiddenFromModel): string {
  const one = hidden.refs.size + (hidden.inText ? 1 : 0) === 1;
  return (
    `The value contains \`${MASK}\` — the mask for ${hiddenList(hidden)}, which ` +
    `${one ? 'is' : 'are'} hidden from the model; a [use ai] step cannot use a secret.` +
    hiddenHints(hidden)
  );
}

/**
 * The step's error when the model declined. Once something was hidden, the
 * model's reason ("The value to repeat is hidden.") says THAT and not WHAT,
 * so the framework adds the what — the same names the backstop's error uses.
 */
function declinedError(reason: string, hidden: HiddenFromModel): string {
  const said = `The model could not do the [use ai] step as written: ${reason}`;
  if (!hidAnything(hidden)) return said;
  const stop = /[.!?]$/.test(reason) ? '' : '.';
  return `${said}${stop} (Hidden from the model: ${hiddenList(hidden)}.)${hiddenHints(hidden)}`;
}

/**
 * Does the value hold the mask in any spelling a model uses to echo it?
 *
 * The same three asterisks, written the ways that are not the three ASCII
 * characters: spaced (`* * *`), Markdown-escaped (`\*\*\*`), punctuated
 * (`*-*-*`), or in a lookalike — fullwidth `＊` (U+FF0A), `∗` (U+2217),
 * `⁎` (U+204E), `✱` (U+2731), small `﹡` (U+FE61), and `⁂` (U+2042, three
 * asterisks in one character) and `⁑` (U+2051, two). So: lookalikes to `*`,
 * backslashes out, and between two asterisks any whitespace or ONE other
 * punctuation mark or symbol dropped — then the plain substring test.
 *
 * Called only once something WAS hidden, so an author's own `**bold**` with
 * nothing hidden is never asked about. With something hidden it passes too:
 * two asterisks are not three. What it widens is the trade-off the caller
 * describes: `**a** **b**` closes up to `**a****b**` and fails.
 */
function holdsMask(value: string): boolean {
  const plain = value
    .replace(/\u2042/g, '***')
    .replace(/\u2051/g, '**')
    .replace(/[\uFF0A\u2217\u204E\u2731\uFE61]/g, '*')
    .replace(/\\/g, '')
    .replace(/\*\s*(?:(?!\*)[\p{P}\p{S}])?\s*(?=\*)/gu, '*');
  return plain.includes(MASK);
}

/**
 * The run's mask set, minus what an `## Config: unmask:` name holds.
 *
 * For the step's own words, which the mask set is applied to directly: a
 * value `show` receives under an unmasked name is shown as itself before any
 * set is consulted, but a word of the text has no name to ask about. Left in,
 * `unmask: keyword` with `keyword` = `AU` would still turn a written
 * "AUstralia" into "***stralia" — the set is built for the report, which
 * ignores `unmask:` on purpose. Only names the runner can look up are
 * exempted: a skill argument or a section column under an unmasked name is
 * not in the variable map, so its value stays masked in the text.
 */
function textMaskSet(
  secrets: readonly string[],
  unmask: ReadonlySet<string>,
  values: PlaceholderValues,
): string[] {
  if (unmask.size === 0) return [...secrets];
  const exempt = new Set<string>();
  for (const name of unmask) {
    const value =
      boundValue(values.parameters, name) ??
      (values.envData ? resolveEnvDataRef(name, values.envData) : undefined);
    if (value === undefined || value === '') continue;
    // Both spellings, as the set holds both (`pushBothForms`).
    exempt.add(value);
    exempt.add(JSON.stringify(value).slice(1, -1));
  }
  return secrets.filter((secret) => !exempt.has(secret));
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
  //    `## Values` block's own membership rule (decision 4) — and the step's
  //    own words masked with the run's mask set, because a skill argument or
  //    a looped section's row value is written into them at expansion, where
  //    no `{{…}}` is left to name it (issue 060).
  const question = stripFailureTail(parsed.text);
  const unmask = args.unmask ?? new Set<string>();
  const secrets = [...args.secrets];
  const textSecrets = textMaskSet(secrets, unmask, values);
  /** What the model is not shown as it is. The prompt's `***` sentence and
   *  the backstop in step 3 both key on it (issue 060), and both errors name
   *  it. */
  const hidden: HiddenFromModel = { refs: new Map(), inText: false };
  const resolved = resolveUseAiText(question, values, {
    defines: new Set(parsed.defines),
    show: (kind, name, value) => {
      const byName = kind === 'placeholder' ? isSecretParameterName(name, scope) : isSecretRef(name);
      const shown = maskValueForPrompt(byName, name, value, unmask, secrets);
      // Judged by what the model is SHOWN, not by the name rule: a reference
      // is hidden when masking changed its value and left the mask in it,
      // which is what each of `maskValueForPrompt`'s three rules does (the
      // whole value for a secret name, a record's secret column, a known
      // secret inside a longer value). A value that comes through unchanged
      // hid nothing, whatever its name: an `unmask:` name, or one that simply
      // holds asterisks. The name rule only says WHICH rule hid it — and it
      // cannot have been an unmasked name, whose value comes back as itself.
      if (shown !== value && shown.includes(MASK)) {
        const ref = kind === 'placeholder' ? `{{${authoredName(name)}}}` : `\${${name}}`;
        if (!hidden.refs.has(ref)) {
          const kindOf: HiddenKind = byName ? 'name' : shown === MASK ? 'whole' : 'part';
          hidden.refs.set(ref, { kind: kindOf, name: kind === 'placeholder' ? authoredName(name) : name });
        }
      }
      return shown;
    },
    // The same set the report is masked with, and so the same floor: a value
    // off the page (a record cell, a loop's `row.token`) joins it only from
    // four characters up, but a value under a name the author chose — a
    // parameter, a section column, a skill parameter — joins it at any
    // length, because that name is the instruction (`joinsMaskSet`,
    // src/utils/secrets.ts). So, as in the report, a short secret is masked
    // wherever its characters occur: a `password` of `test` hides the word
    // "test" too, and that step is then told a value is hidden from it.
    literal: (words) => {
      const shown = redact(words, textSecrets);
      if (shown !== words) hidden.inText = true;
      return shown;
    },
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
    const messages = buildUseAiPrompt(resolved.text, explicitName, retryNote, hidAnything(hidden));
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
      return failed(declinedError(reply.reason, hidden), `The model declined: ${reply.reason}`);
    }
    if (reply.kind === 'malformed') {
      retryNote = reply.why;
      lastFailure = `the model's reply could not be used: ${reply.why}`;
      if (attempt < attempts) logger.warn(`[use ai] step ${index}: ${lastFailure} — retrying`);
      continue;
    }

    // The backstop behind the prompt's `***` sentence (issue 060), since a
    // prompt only steers. A model asked to "repeat {{password}}" was shown
    // `***`, and storing its echo would pass the step with three asterisks
    // in the variable — the silent wrong value this codebase ranks worst,
    // because every later step then types or compares `***` and fails
    // somewhere else, or passes against the wrong thing. So a value holding
    // the mask fails the step, but only when THIS step's own masking put a
    // mask into the text: with nothing hidden, `***` in an answer is the
    // author's (a bold-italic word, a row of stars) and is stored.
    //
    // The trade-off, chosen: once a value WAS hidden, this cannot tell an
    // echo of the mask from asterisks the model wrote for reasons of its own,
    // and fails both. That false failure is loud, names what was hidden, and
    // has a fix — keep the secret out of that step, or rename a variable
    // whose name only looks secret — where the false pass it rules out was
    // silent. (`unmask:` is no general fix: only `aiui run` sends it.)
    //
    // The value is one string — a list or an object in "value" is malformed
    // (above) — and `holdsMask` looks for the mask in the spellings an echo
    // takes: spaced, Markdown-escaped, punctuated, or in a lookalike
    // character. What no test of the value can see is a COMPUTED or PARTIAL
    // form — the mask's length "3", one asterisk of the three, an encoding of
    // it — which is indistinguishable from an answer. Those are the prompt
    // sentence's job, not this one's.
    //
    // Not retried, for the reason an `error` reply is not: the step needs a
    // value no attempt will be shown, and asking until the model stops
    // echoing is how a guess gets stored.
    if (hidAnything(hidden) && holdsMask(reply.value)) {
      return failed(
        hiddenValueError(hidden),
        `The model's value holds ${MASK}, the mask for a value it was not shown`,
      );
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

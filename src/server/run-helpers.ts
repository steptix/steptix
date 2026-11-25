import type { BrowserSession } from '../browser/manager.js';
import { aiConfigNow, type BaseModelSource } from '../config/loader.js';
import type { AiConfig, Config } from '../config/types.js';
import type { StepResult } from '../report/types.js';

/**
 * Pure step-loop helpers shared by the two things that drive steps server-side:
 * `SessionManager` (a session) and `ErrandRunner` (an errand).
 *
 * Extracted rather than copied. Each of these encodes a rule whose *reason*
 * lives in a comment, and a second copy is how the two loops start disagreeing
 * about what a capture is or which steps are skippable.
 */

/** Pattern for [input: variable_name] steps */
const INPUT_STEP_PATTERN = /^\[input:\s*\w+\]/i;

/** Pattern for [interactive] steps */
const INTERACTIVE_STEP_PATTERN = /^\[interactive\]/i;

/** Pattern for a single [output: variable_name] prefix */
const OUTPUT_PREFIX_PATTERN = /\[output:\s*(\w+)\]/gi;

/**
 * Parse all [output: varname] prefixes from a step instruction.
 * Returns the variable names and the cleaned instruction with output prefixes removed.
 */
export function parseOutputPrefixes(instruction: string): {
  variables: string[];
  cleanedInstruction: string;
} {
  const variables: string[] = [];
  let cleaned = instruction;

  // Collect all [output: varname] matches
  let match: RegExpExecArray | null;
  // Reset lastIndex since the regex has the global flag
  OUTPUT_PREFIX_PATTERN.lastIndex = 0;
  while ((match = OUTPUT_PREFIX_PATTERN.exec(instruction)) !== null) {
    variables.push(match[1]!);
  }

  if (variables.length === 0) {
    return { variables: [], cleanedInstruction: instruction };
  }

  // Strip all [output: ...] prefixes from the instruction
  cleaned = instruction.replace(OUTPUT_PREFIX_PATTERN, '').trim();

  if (!cleaned) {
    cleaned = `Capture value into "${variables.join(', ')}"`;
  }

  return { variables, cleanedInstruction: cleaned };
}

/**
 * Build the enriched instruction that tells the AI to capture output values.
 * Appends `[store as: var1, var2]` matching the existing pattern from test-runner.
 */
export function buildEnrichedInstruction(
  cleanedInstruction: string,
  variables: string[],
): string {
  return `${cleanedInstruction} [store as: ${variables.join(', ')}]`;
}

/**
 * Check if a step instruction is an input step or interactive step (to be skipped in API mode).
 */
export function isSkippableStep(instruction: string): boolean {
  return INPUT_STEP_PATTERN.test(instruction) || INTERACTIVE_STEP_PATTERN.test(instruction);
}

/**
 * What a step {@link isSkippableStep} declined reports about itself.
 *
 * One constant rather than the same sentence typed in the session manager and
 * the errand runner, because it is now on the WIRE as well as in the report
 * (`step:pass` + `output: 'skipped'` carries it as `reason`), and two copies
 * of a sentence a client prints is exactly the drift
 * `stories/control-flow.md` §"Steptix paints one skip" describes.
 */
export const UNATTENDED_SKIP_REASON =
  'Skipped: [input] and [interactive] steps are not supported in API mode';

/**
 * The server's startup config with its AI values re-read from the machine
 * `.env` — what every run, errand, compile and settings report builds on
 * (issue #128).
 *
 * The server loads its config once, but the machine file is written while it
 * runs (Copilot setup in VS Code, a hand edit). Reading it here, once per
 * request, is what makes such a change reach the next run the way a saved
 * project `.env` already does. Which values the file may fill is still what
 * the load decided, so a model the server's own environment or config file set
 * keeps beating it (`aiConfigNow`, src/config/loader.ts).
 *
 * Call it once per request and use the result throughout: two reads in one
 * batch could straddle an edit and disagree with each other.
 */
export function serverConfigNow(config: Config): { config: Config; modelFrom: BaseModelSource } {
  const now = aiConfigNow(config.ai);
  return { config: { ...config, ai: now.ai }, modelFrom: now.modelFrom };
}

/** Where a run's model came from, as {@link modelForRunLine} names it. */
export type RunModelSource = 'session' | 'project-env' | BaseModelSource;

/**
 * The one line a run writes about its model (issue #128): which model, and
 * which setting chose it, so a model the user did not expect points at the
 * file to change.
 *
 * `machineEnvPath` is named in full only for the machine file, because that
 * is the one a user cannot find by looking beside the test.
 */
export function modelForRunLine(model: string, source: RunModelSource, machineEnvPath: string): string {
  const from =
    source === 'session'
      ? 'set for this session'
      : source === 'project-env'
        ? "from this project's .env file"
        : source === 'machine-file'
          ? `from the machine-wide settings file (${machineEnvPath})`
          : source === 'server-settings'
            ? "from the server's own settings (the environment it was started with, or its steptix.config.json)"
            : "Steptix's built-in default — no settings file names a model";
  return `AI model for this run: ${model}, ${from}.`;
}

/**
 * Build an AiConfig with optional env overrides applied over a base. Only
 * `apiKey`, `model` and `gatewayUrl` are honoured today — these are the env
 * knobs a `.env` shipped from a client realistically wants to override, and
 * this is the ONLY place they land on the server path: the loader's
 * `withEnvDefaults` reads the server's own process env, which is not where a
 * client's `.env` arrives. A var added there and not here works in every
 * loader unit test and does nothing at all through Steptix.
 *
 * Always pass the server base as {@link serverConfigNow} gives it for this
 * request as `baseConfig`, never a session's current config: overrides apply
 * only on non-empty values, so basing on the server config lets a removed
 * `.env` line revert cleanly instead of sticking on the prior override. Server
 * process.env is never mutated.
 *
 * **Always returns a fresh object, even with nothing to apply.** It used to
 * return `baseConfig` itself on the no-overrides path, which handed
 * `new AiClient(...)` a reference to the SERVER's `config.ai` — and `syncAuth`
 * mutates its config in place, so a model change on one session rewrote the
 * server's startup model for every session created afterwards. Caught live: a
 * `runSettings.model` override on one session moved `GET /config`'s reported
 * server base with it, which is exactly the process-wide leak the whole feature
 * is scoped to avoid. Copying is what keeps the sessions isolated; nothing here
 * relies on the identity.
 */
export function applyEnvToAiConfig(
  baseConfig: AiConfig,
  envOverrides: Record<string, string> | undefined,
): AiConfig {
  const next = { ...baseConfig };
  if (!envOverrides) return next;
  // Present-but-empty is a VALUE, not an absence. A blank `AI_API_KEY=` line is
  // how a project pins itself keyless — it blocks the machine-wide key from
  // `%LOCALAPPDATA%\steptix\.env` (keyless-replay-and-gateway-env.md), and it is
  // what the Bedrock SigV4 setup depends on, since an explicit key outranks
  // every AWS credential source in the client's precedence. Skipping the empty
  // string here made this path disagree with the CLI, where `withEnvDefaults`
  // sets `''` and the machine floor only fills `undefined`: the server kept its
  // own key and handed it to whatever the project's model resolved to. For a
  // Bedrock project that meant the machine's gateway key travelling to AWS as a
  // bearer token, with SigV4 never running.
  //
  // Only the key has this semantic. A blank `AI_MODEL` or `AI_GATEWAY_URL`
  // means "not set here, fall back", because neither has a meaningful empty
  // value to select.
  const apiKey = envOverrides['AI_API_KEY'];
  if (typeof apiKey === 'string') {
    next.apiKey = apiKey;
  }
  const model = envOverrides['AI_MODEL'];
  if (typeof model === 'string' && model.trim().length > 0) {
    next.model = model.trim();
  }
  // `aibroker/` models route through whatever endpoint this names
  // (stories/keyless-replay-and-gateway-env.md). A corporate project points at
  // its org's internal gateway from its own `.env`, so the value has to travel
  // with the rest of that `.env` rather than being pinned in the server's
  // startup config — the server may not even be in the same repo.
  const gatewayUrl = envOverrides['AI_GATEWAY_URL'];
  if (typeof gatewayUrl === 'string' && gatewayUrl.trim().length > 0) {
    next.gatewayUrl = gatewayUrl.trim();
  }
  return next;
}

/**
 * Check if the browser context has been closed (e.g. after a "Close the browser" step).
 */
export function isBrowserClosed(browserSession: BrowserSession): boolean {
  try {
    // Accessing browser.isConnected() is the reliable way to check
    return !browserSession.browser.isConnected();
  } catch {
    return true;
  }
}

/**
 * The `as` names one step's own successful read/count actions wrote, which are
 * captures even with no `[output:]` prefix on the instruction (issue 042).
 *
 * Restricted to read/count (the only actions that write `as` into
 * resolvedParameters — see step-executor.ts) with no `.error`, for two reasons:
 * (1) other `as` uses aren't captures at all — e.g. openPage's tab-label `as`
 * shares the same namespace but never writes resolvedParameters, and
 * extract_value's `as` is currently a documented no-op sub-action; (2) the
 * parameter map persists across steps, so an unfiltered failed action's `as`
 * could still be present from an *earlier* step and wrongly emit a stale value
 * attributed to this one. `__macro*`-namespaced names are always excluded —
 * those are macro-internal (see the `__macro*` invariant in expander.ts) and
 * must never reach session outputs, an errand receipt, or the next batch's seed.
 */
export function autoCapturedNames(stepResult: StepResult): string[] {
  return stepResult.turns
    .flatMap((t) => t.subActions)
    .filter((sa) => !sa.error && (sa.action.action === 'read' || sa.action.action === 'count'
      // A structured table read writes its `as` too (SPEC-structured-table-reads.md §9.3).
      || sa.action.action === 'readTable'))
    .map((sa) => sa.action.as)
    .filter((name): name is string => !!name && !name.startsWith('__macro'));
}

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { AIGateway } from '@pkent/aigateway';
import { DEFAULT_CONFIG } from './defaults.js';
import type { AiConfig, Config, UserConfig } from './types.js';
import { parseBoolEnv } from '../env/loader.js';
import { readUserRootEnv } from '../env/user-root.js';
import { logger } from '../utils/logger.js';

/** True for a non-null, non-array object literal. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively merge `override` over `base`. Plain objects are merged
 * key-by-key (so a partial nested object inherits its sibling defaults);
 * arrays and primitives replace wholesale; an `undefined` override is skipped
 * (falling through to the base value).
 */
function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : (override as T));
  }

  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const overrideVal = override[key];
    if (overrideVal === undefined) continue;

    const baseVal = result[key];
    if (isPlainObject(baseVal) && isPlainObject(overrideVal)) {
      result[key] = deepMerge(baseVal, overrideVal);
    } else {
      result[key] = overrideVal;
    }
  }
  return result as T;
}

/** Recursively merge user config over defaults. */
function mergeConfig(defaults: Config, overrides: UserConfig): Config {
  return deepMerge(defaults, overrides);
}

/**
 * Resolve the config file path. With an explicit `configPath` (from `--config`)
 * that path is used as-is; otherwise we look for `aiui.config.json` in the cwd.
 * Returns `null` when no config file is present (an unconfigured project is
 * valid and falls back to defaults).
 */
function resolveConfigPath(configPath?: string, projectRoot: string = process.cwd()): string | null {
  if (configPath) {
    // An explicit `--config` stays resolved against the cwd (today's
    // semantics) — only auto-discovery follows the project root.
    return path.resolve(process.cwd(), configPath);
  }

  const candidate = path.resolve(projectRoot, 'aiui.config.json');
  return existsSync(candidate) ? candidate : null;
}

/**
 * Apply environment-derived defaults that must be read after `.env` has been
 * loaded. Keeping this out of `DEFAULT_CONFIG` avoids ESM import-order issues
 * where `defaults.ts` evaluates before `loadDefaultEnvFileSync()` runs.
 */
function withEnvDefaults(config: Config): Config {
  let result = config;

  const apiKey = process.env['AI_API_KEY'];
  if (apiKey !== undefined && result.ai.apiKey === undefined) {
    result = { ...result, ai: { ...result.ai, apiKey } };
  }

  const model = process.env['AI_MODEL'];
  if (model !== undefined && model.trim().length > 0) {
    result = { ...result, ai: { ...result.ai, model: model.trim() } };
  }

  // The org's own OpenAI-compatible endpoint, for `aibroker/` models
  // (stories/keyless-replay-and-gateway-env.md). It takes `model`'s
  // precedence — overriding the config file — rather than `apiKey`'s fill-only
  // rule: this is non-secret routing the caller may deliberately export, and
  // pointing a run at a different gateway for one command is the same kind of
  // act as pointing it at a different model.
  const gatewayUrl = process.env['AI_GATEWAY_URL'];
  if (gatewayUrl !== undefined && gatewayUrl.trim().length > 0) {
    result = { ...result, ai: { ...result.ai, gatewayUrl: gatewayUrl.trim() } };
  }

  // Reasoning effort for routine steps. Deliberately NOT validated here: the
  // gateway owns the vocabulary and throws AIGatewayError ('invalid_effort') on
  // the first call, which the existing AI error path already surfaces. A second
  // list here would go stale the next time a provider adds a level.
  const effort = process.env['AI_EFFORT'];
  if (effort !== undefined && effort.trim().length > 0) {
    result = { ...result, ai: { ...result.ai, effort: effort.trim() as NonNullable<AiConfig['effort']> } };
  }

  const serverApiKey = process.env['AIUI_SERVER_API_KEY'];
  if (serverApiKey !== undefined) {
    result = { ...result, server: { ...result.server, apiKey: serverApiKey } };
  }

  const interactiveOnFailure = parseBoolEnv(process.env['INTERACTIVE_ON_FAILURE']);
  if (interactiveOnFailure !== undefined) {
    result = {
      ...result,
      execution: { ...result.execution, interactiveOnFailure },
    };
  }

  const openInBrowserAfterRun = parseBoolEnv(process.env['OPEN_REPORT_IN_BROWSER_AFTER_RUN']);
  if (openInBrowserAfterRun !== undefined) {
    result = {
      ...result,
      reports: { ...result.reports, openInBrowserAfterRun },
    };
  }

  const appendRunHistoryToTestFile = parseBoolEnv(process.env['APPEND_RUN_HISTORY_TO_TEST_FILE']);
  if (appendRunHistoryToTestFile !== undefined) {
    result = {
      ...result,
      reports: { ...result.reports, appendRunHistoryToTestFile },
    };
  }

  return result;
}

/**
 * The machine floor for the AI settings (stories/machine-key.md): values from
 * the user root's `.env` apply only when neither the environment nor the
 * project's config file set one.
 *
 * `project .env → project aiui.config.json → user-root .env → built-in`
 *
 * This is deliberately NOT a `process.env` preload. `withEnvDefaults` lets an
 * env `AI_MODEL` override the config file — correct for a value the caller
 * explicitly exported or `--env-file`d, wrong for a machine-wide default,
 * which would then silently override every project's configured model. A
 * default that beats explicit project config is not a default, so the floor
 * is applied last and only into gaps (verification rule 9: a floor, never an
 * override).
 *
 * `fileAi` is the *raw* user config, pre-merge — after the merge a file model
 * (or gatewayUrl) and the built-in default are indistinguishable on the result.
 */
function withMachineAiFloor(config: Config, fileAi: UserConfig['ai'] | null): Config {
  const userRoot = readUserRootEnv();
  let result = config;

  // `undefined` here means neither the config file nor the environment
  // supplied one — `withEnvDefaults` only fills this key, never clears it.
  const machineApiKey = userRoot['AI_API_KEY'];
  if (
    result.ai.apiKey === undefined &&
    machineApiKey !== undefined &&
    machineApiKey.trim() !== ''
  ) {
    result = { ...result, ai: { ...result.ai, apiKey: machineApiKey.trim() } };
  }

  const envModel = process.env['AI_MODEL'];
  const envSetModel = envModel !== undefined && envModel.trim() !== '';
  const fileModel = fileAi?.model;
  const fileSetModel = typeof fileModel === 'string' && fileModel.trim() !== '';
  const machineModel = userRoot['AI_MODEL'];
  if (
    !envSetModel &&
    !fileSetModel &&
    machineModel !== undefined &&
    machineModel.trim() !== ''
  ) {
    result = { ...result, ai: { ...result.ai, model: machineModel.trim() } };
  }

  // Same floor, same shape — and the same trap, only sharper: `gatewayUrl` has
  // a built-in default, so `result.ai.gatewayUrl` is never undefined and a
  // "did anyone set this?" check against the merged config can only ever
  // answer yes. The question has to be asked of the RAW file config, or a
  // machine-wide gateway would quietly beat every project that pinned one.
  const envGatewayUrl = process.env['AI_GATEWAY_URL'];
  const envSetGatewayUrl = envGatewayUrl !== undefined && envGatewayUrl.trim() !== '';
  const fileGatewayUrl = fileAi?.gatewayUrl;
  const fileSetGatewayUrl = typeof fileGatewayUrl === 'string' && fileGatewayUrl.trim() !== '';
  const machineGatewayUrl = userRoot['AI_GATEWAY_URL'];
  if (
    !envSetGatewayUrl &&
    !fileSetGatewayUrl &&
    machineGatewayUrl !== undefined &&
    machineGatewayUrl.trim() !== ''
  ) {
    result = { ...result, ai: { ...result.ai, gatewayUrl: machineGatewayUrl.trim() } };
  }

  return result;
}

/**
 * Does this model route to a provider that supplies its own credentials?
 *
 * Asked of the library rather than answered here, because the alternative is a
 * second list of key-free prefixes in this repo drifting against the real one
 * (stories/bedrock-provider.md §"Declaring that the provider self-authenticates").
 *
 * Guarded for the tests, not for the pin. The pinned `1.4.0-beta.2` DOES have
 * `providers()`; so does every other version, which has carried it since the
 * library's first commit. No real version reaches the fallback. What reaches it is
 * `tests/ai-client.test.ts` and `tests/ai-effort.test.ts`, which replace the
 * whole module with a fake gateway class carrying no statics at all: remove the
 * guard and seven cases in the first die on `AIGateway.providers is not a
 * function`. Stating that precisely matters, because a guard whose stated
 * reason has expired is a guard someone deletes.
 *
 * The fallback is "nothing self-authenticates", i.e. the key-only behaviour
 * that predates this — safe in the direction that matters, since it can only
 * refuse an AI call, never send one somewhere unintended. But note what it
 * means inside those two suites, and `ai-effort.test.ts` is the live example
 * even though it passes today only because nothing in it reaches this branch:
 * `aiConfigured` answers `false` for a keyless `bedrock/` model there, silently
 * and with nothing to read as a failure. A Bedrock case added to either would
 * test the fallback and call it the feature.
 * `tests/bedrock-keyless.test.ts` and `tests/api-server-run-settings.test.ts`
 * are the suites that stub `providers()` for real, and are where such a case
 * belongs.
 */
function selfAuthenticatingModel(model: string): boolean {
  const list = typeof AIGateway.providers === 'function' ? AIGateway.providers() : [];
  return list.some((provider) => provider.selfAuthenticating === true && model.startsWith(provider.prefix));
}

/**
 * Can this config make an AI request?
 *
 * Almost always "is there a key", and for every provider that holds a key that
 * is the whole answer: whitespace counts as absent — an `AI_API_KEY=` line with
 * a stray space is the same "no key" the author meant, and letting it through
 * would only move the failure to the gateway.
 *
 * The exception is a provider that authenticates itself. A Bedrock project
 * signing with the AWS credential chain has no `AI_API_KEY` and never will
 * (stories/bedrock-provider.md §Part B), so a key-only predicate would refuse
 * every AI call on a correctly configured machine and advise setting a key
 * Bedrock has no use for.
 *
 * So the answer is no longer purely detected: the key half still is, but the
 * second half is DECLARED — by the library, in its provider registry, not by
 * anything in this repo. That is the property worth keeping. There is still no
 * `ai.enabled` flag for a user to set and drift out of sync with reality; the
 * declaration lives with the code that knows whether a credential is needed.
 *
 * It lives here, beside the three sources it is asking about — the env
 * overlay, the config file and the machine floor above — rather than on the
 * AI client, for two reasons. It is a question about a config, not about a
 * client; and the runners hold stub clients in a great many tests, so a
 * predicate that lived on the client could be mocked into lying about whether
 * the run has AI.
 *
 * Callers pass the config the run will ACTUALLY use — both halves of it. On the
 * server path the key is `applyEnvToAiConfig`'s result rather than the server's
 * startup `config.ai` (the two differ whenever a client ships its own `.env`),
 * and the model must be the one after any session override, not the one the
 * project's `.env` named. A keyless `bedrock/` project whose session overrides
 * the model to `anthropic/…` has no AI, and asking with the pre-override model
 * would report `AI: on` and then die with an empty key.
 */
export function aiConfigured(ai: AiConfig): boolean {
  return (ai.apiKey ?? '').trim() !== '' || selfAuthenticatingModel(ai.model);
}

/**
 * Load and merge configuration from `aiui.config.json` + defaults.
 *
 * A missing config file is valid — the project runs on defaults. A config
 * file that exists but contains malformed JSON (or a non-object top level) is
 * a hard error: a typo in the sole config source should fail loudly rather
 * than silently changing how every test runs.
 */
export async function loadConfig(configPath?: string, projectRoot: string = process.cwd()): Promise<Config> {
  const explicit = configPath !== undefined;

  if (explicit && !configPath!.endsWith('.json')) {
    throw new Error(
      `Config path must point to a .json file (got "${configPath!}").`,
    );
  }

  const resolvedPath = resolveConfigPath(configPath, projectRoot);

  // Fresh copy of the defaults so the resolved config never aliases (and can
  // never be mutated back into) the shared DEFAULT_CONFIG singleton.
  const baseDefaults = structuredClone(DEFAULT_CONFIG);

  if (!resolvedPath) {
    logger.debug('No config file found, using defaults');
    return withMachineAiFloor(withEnvDefaults(baseDefaults), null);
  }

  logger.debug(`Loading config from: ${resolvedPath}`);

  let raw: string;
  try {
    raw = await fs.readFile(resolvedPath, 'utf8');
  } catch (err) {
    // An explicit --config path that doesn't exist is a user error — fail
    // loudly. An implicit (auto-discovered) miss means an unconfigured
    // project, which is valid and falls back to defaults.
    if (explicit) {
      throw new Error(`Config file not found: ${resolvedPath}`);
    }
    logger.debug(`Config file not readable, using defaults: ${String(err)}`);
    return withMachineAiFloor(withEnvDefaults(baseDefaults), null);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse config file ${resolvedPath}: ${(err as Error).message}`,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`Config file ${resolvedPath} must contain a JSON object.`);
  }

  // `$schema` is an editor-only hint (autocomplete/validation), not a Config
  // field — strip it before merging so it never reaches the resolved config.
  const { $schema: _schema, ...userConfig } = parsed;
  const typed = userConfig as UserConfig;
  return withMachineAiFloor(withEnvDefaults(mergeConfig(baseDefaults, typed)), typed.ai ?? null);
}

/** Apply CLI flag overrides onto an already-loaded config */
export function applyCliOverrides(
  config: Config,
  overrides: {
    headless?: boolean;
    timeout?: number;
    browser?: 'chromium' | 'firefox' | 'webkit';
    verbose?: boolean;
  },
): Config {
  const result = { ...config };

  if (overrides.headless === true) {
    result.browser = { ...result.browser, headed: false };
  }

  if (overrides.timeout !== undefined) {
    result.execution = { ...result.execution, timeout: overrides.timeout };
  }

  if (overrides.browser !== undefined) {
    result.browser = { ...result.browser, browser: overrides.browser };
  }

  return result;
}

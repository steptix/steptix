import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG } from './defaults.js';
import type { Config, UserConfig } from './types.js';
import { parseBoolEnv } from '../env/loader.js';
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

  const serverApiKey = process.env['SERVER_API_KEY'];
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
    return withEnvDefaults(baseDefaults);
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
    return withEnvDefaults(baseDefaults);
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
  return withEnvDefaults(mergeConfig(baseDefaults, userConfig as UserConfig));
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

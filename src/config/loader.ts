import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_CONFIG } from './defaults.js';
import type { Config, UserConfig } from './types.js';
import { parseBoolEnv } from '../env/loader.js';
import { logger } from '../utils/logger.js';

/** Recursively merge user config over defaults */
function mergeConfig(defaults: Config, overrides: UserConfig): Config {
  const result = { ...defaults };

  for (const key of Object.keys(overrides) as Array<keyof UserConfig>) {
    const override = overrides[key];
    if (override === undefined) continue;

    const defaultVal = defaults[key];
    if (
      typeof override === 'object' &&
      !Array.isArray(override) &&
      typeof defaultVal === 'object' &&
      !Array.isArray(defaultVal)
    ) {
      // @ts-expect-error — recursive merge of matching sub-object types
      result[key] = { ...defaultVal, ...override };
    } else {
      // @ts-expect-error — direct assignment of overriding primitive
      result[key] = override;
    }
  }

  return result;
}

/** Resolve a config file path, searching common locations */
function resolveConfigPath(configPath?: string): string | null {
  const cwd = process.cwd();

  if (configPath) {
    return path.resolve(cwd, configPath);
  }

  // Search for default config filenames
  const candidates = [
    'ai-ui-auto.config.ts',
    'ai-ui-auto.config.js',
    'ai-ui-auto.config.mjs',
  ];

  for (const candidate of candidates) {
    const fullPath = path.resolve(cwd, candidate);
    try {
      // Check existence by attempting a require resolve
      createRequire(import.meta.url).resolve(fullPath);
      return fullPath;
    } catch {
      // File doesn't exist, try next
    }
  }

  return null;
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

/** Load and merge configuration from file + defaults */
export async function loadConfig(configPath?: string): Promise<Config> {
  const resolvedPath = resolveConfigPath(configPath);

  if (!resolvedPath) {
    logger.debug('No config file found, using defaults');
    return withEnvDefaults(DEFAULT_CONFIG);
  }

  logger.debug(`Loading config from: ${resolvedPath}`);

  try {
    const fileUrl = pathToFileURL(resolvedPath).href;

    // Use tsx to handle TypeScript config files at runtime
    let module: { default?: UserConfig };

    if (resolvedPath.endsWith('.ts')) {
      // tsx registers TypeScript handling — import works directly in tsx context
      module = await import(fileUrl) as { default?: UserConfig };
    } else {
      module = await import(fileUrl) as { default?: UserConfig };
    }

    const userConfig = module.default ?? {};
    return withEnvDefaults(mergeConfig(DEFAULT_CONFIG, userConfig));
  } catch (err) {
    logger.warn(`Failed to load config from ${resolvedPath}: ${String(err)}`);
    logger.warn('Falling back to default configuration');
    return withEnvDefaults(DEFAULT_CONFIG);
  }
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

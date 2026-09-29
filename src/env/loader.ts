import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';

/**
 * Load environment variables from a `.env.<name>` file and merge them into process.env.
 * Values from the env file take precedence over existing process.env values.
 *
 * @param envName — the environment name, e.g. "t1" loads ".env.t1"
 * @param projectRoot — directory to search for the env file (defaults to cwd)
 */
export async function loadEnvFile(
  envName: string,
  projectRoot: string = process.cwd(),
): Promise<void> {
  const vars = await readEnvFileVars(envName, projectRoot);
  for (const [key, value] of Object.entries(vars)) {
    process.env[key] = value;
  }
  logger.info(`Loaded environment "${envName}" (${Object.keys(vars).length} variables)`);
}

/**
 * Pure read of `.env.<envName>` into a parsed key-value map. Throws when the
 * file is missing (a named env with no file is a caller error, matching
 * `loadEnvFile`). Unlike `loadEnvFile`, this does **NOT** mutate `process.env`
 * — the shared server composes per-project env maps without touching the
 * global, so concurrent runs for different projects can't contaminate each
 * other. See stories/project-scoped-data-dir-and-env.md.
 */
export async function readEnvFileVars(
  envName: string,
  projectRoot: string = process.cwd(),
): Promise<Record<string, string>> {
  const filePath = path.resolve(projectRoot, `.env.${envName}`);

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Environment file not found: ${filePath}`);
    }
    throw err;
  }

  return parseEnvFile(content);
}

/**
 * Pure read of the base `.env` into a parsed key-value map. Returns `{}` when
 * the file is absent. Does **NOT** mutate `process.env` (see `readEnvFileVars`).
 */
export async function readDefaultEnvVars(
  projectRoot: string = process.cwd(),
): Promise<Record<string, string>> {
  const filePath = path.resolve(projectRoot, '.env');

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }

  return parseEnvFile(content);
}

/**
 * Synchronously load the base `.env` file from `projectRoot` and merge values
 * into `process.env`. Silently no-ops if the file does not exist.
 *
 * Existing `process.env` values are NOT overridden — shell-provided env vars
 * take precedence. This matches the previous `dotenv/config` behaviour.
 */
export function loadDefaultEnvFileSync(projectRoot: string = process.cwd()): void {
  const filePath = path.resolve(projectRoot, '.env');

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  const vars = parseEnvFile(content);
  for (const [key, value] of Object.entries(vars)) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

/**
 * One-time warning if the removed `STEPTIX_DATA_DIR` env var is still set. The
 * per-environment data directory is now configured via `tests.dataDir` in
 * `steptix.config.json` (default `data`). Surfaces stale `.env` entries loudly
 * instead of silently ignoring them. See
 * stories/project-scoped-data-dir-and-env.md.
 */
export function warnIfDeprecatedDataDirEnv(): void {
  if (process.env['STEPTIX_DATA_DIR'] !== undefined) {
    logger.warn(
      'STEPTIX_DATA_DIR is no longer supported and is ignored — set `tests.dataDir` ' +
        'in steptix.config.json instead (default: `data`).',
    );
  }
}

/**
 * Parse an env var string as a boolean. Truthy values: "true", "1", "yes", "on"
 * (case-insensitive). Falsy values: "false", "0", "no", "off". Anything else —
 * including `undefined` or whitespace — returns `undefined` so callers can
 * distinguish "not set" from "explicitly false".
 */
export function parseBoolEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return undefined;
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

/**
 * Parse a `.env` file into a key-value map.
 *
 * - Lines starting with `#` are comments and are ignored
 * - Blank lines are ignored
 * - `KEY=value` assigns value to key
 * - Values may be quoted with single or double quotes (quotes are stripped)
 * - Inline comments after the value are NOT stripped (matches dotenv behaviour)
 */
export function parseEnvFile(content: string): Record<string, string> {
  const vars: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    // Skip blank lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex < 1) continue;

    const key = trimmed.substring(0, eqIndex).trim();
    let value = trimmed.substring(eqIndex + 1).trim();

    // Strip surrounding quotes (single or double)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) {
      vars[key] = value;
    }
  }

  return vars;
}

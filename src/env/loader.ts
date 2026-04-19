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
  const fileName = `.env.${envName}`;
  const filePath = path.resolve(projectRoot, fileName);

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Environment file not found: ${filePath}`);
    }
    throw err;
  }

  const vars = parseEnvFile(content);

  for (const [key, value] of Object.entries(vars)) {
    process.env[key] = value;
  }

  logger.info(`Loaded environment "${envName}" (${Object.keys(vars).length} variables)`);
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

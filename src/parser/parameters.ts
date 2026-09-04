import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { logger } from '../utils/logger.js';

/**
 * Resolve parameter values using the priority chain:
 * 1. Inline value (already in the map)
 * 2. Environment variable ($VAR_NAME)
 * 3. Data file row (injected externally)
 * 4. Prompt user at runtime
 */
export async function resolveParameters(
  rawParams: Record<string, string>,
  dataRow?: Record<string, string>,
  promptUser = true,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};

  for (const [key, rawValue] of Object.entries(rawParams)) {
    resolved[key] = await resolveValue(key, rawValue, dataRow, promptUser);
  }

  // Merge any additional keys from the data row that weren't in rawParams
  if (dataRow) {
    for (const [key, value] of Object.entries(dataRow)) {
      if (!(key in resolved)) {
        resolved[key] = resolveEnvRef(key, value);
      }
    }
  }

  return resolved;
}

/**
 * Apply the `$VAR` rule to a value: a leading `$` names an environment
 * variable, anything else is a literal.
 *
 * A row's cell goes through this for the same reason a `## Parameters` value
 * does — so a password can live in `.env` and the table can hold
 * `$TEST_PASSWORD` rather than the secret. Until data-driven rows this was
 * skipped for rows entirely: `resolveValue` returned a row's cell before it
 * reached the `$` branch, so a `dataFile:` row holding `$TEST_PASSWORD` typed
 * that literal string into the page.
 *
 * An unset variable stays literal with a warning rather than becoming empty:
 * an empty password submits a form and fails somewhere far from the cause.
 */
function resolveEnvRef(key: string, rawValue: string): string {
  if (!rawValue.startsWith('$')) return rawValue;
  const envVarName = rawValue.slice(1);
  const envValue = process.env[envVarName];
  if (envValue !== undefined) {
    logger.debug(`Parameter "${key}" resolved from env var $${envVarName}`);
    return envValue;
  }
  logger.warn(`Environment variable $${envVarName} not set for parameter "${key}"`);
  return rawValue;
}

async function resolveValue(
  key: string,
  rawValue: string,
  dataRow?: Record<string, string>,
  promptUser = true,
): Promise<string> {
  // 1. Check data row override (highest priority for data-driven tests).
  //     The cell still goes through the `$VAR` rule — a row is a set of
  //     parameter values that happens to arrive in a table, and a cell that
  //     resolved differently from the `## Parameters` line it shadows would
  //     be a trap rather than a shorthand.
  if (dataRow && key in dataRow) {
    const dataValue = dataRow[key];
    if (dataValue !== undefined) {
      const resolvedValue = resolveEnvRef(key, dataValue);
      logger.debug(`Parameter "${key}" resolved from data row: ${maskSecret(key, resolvedValue)}`);
      return resolvedValue;
    }
  }

  // 2. Environment variable: value starts with $
  if (rawValue.startsWith('$')) {
    const envVarName = rawValue.slice(1);
    const envValue = process.env[envVarName];
    if (envValue !== undefined) {
      logger.debug(`Parameter "${key}" resolved from env var $${envVarName}`);
      return envValue;
    }
    logger.warn(`Environment variable $${envVarName} not set for parameter "${key}"`);
  }

  // 3. Inline value (non-empty, not a reference)
  if (rawValue && !rawValue.startsWith('$') && rawValue !== '{{' + key + '}}') {
    logger.debug(`Parameter "${key}" resolved from inline value`);
    return rawValue;
  }

  // 4. Prompt user
  if (promptUser) {
    const value = await promptForValue(key);
    return value;
  }

  logger.warn(`Parameter "${key}" could not be resolved, using empty string`);
  return '';
}

/**
 * Names that mark a value as a secret: hidden at the prompt, masked in logs,
 * redacted from a compile's recording. One rule, so a name the prompt hides
 * is a name the recording redacts.
 */
export function isSecretName(name: string): boolean {
  return /password|secret|token|key/i.test(name);
}

async function promptForValue(key: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    const isSecret = isSecretName(key);
    const hint = isSecret ? ' (input hidden)' : '';
    const answer = await rl.question(`  Enter value for "${key}"${hint}: `);
    return answer.trim();
  } finally {
    rl.close();
  }
}

/** Substitute {{placeholders}} in a string with resolved parameter values */
export function interpolate(text: string, params: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    if (key in params) {
      return params[key] ?? match;
    }
    logger.warn(`Unresolved placeholder: {{${key}}}`);
    return match;
  });
}

/** Load a data file and return an array of parameter rows */
export async function loadDataFile(
  dataFilePath: string,
  projectRoot: string,
): Promise<Array<Record<string, string>>> {
  const absPath = path.resolve(projectRoot, dataFilePath);

  let content: string;
  try {
    content = await fs.readFile(absPath, 'utf-8');
  } catch {
    throw new Error(`Data file not found: ${absPath}`);
  }

  if (dataFilePath.endsWith('.json')) {
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`Data file must contain a JSON array: ${absPath}`);
    }
    return parsed.map((row, i) => {
      if (typeof row !== 'object' || row === null) {
        throw new Error(`Data file row ${i} is not an object: ${absPath}`);
      }
      return Object.fromEntries(
        Object.entries(row as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
    });
  }

  if (dataFilePath.endsWith('.csv')) {
    return parseCsv(content);
  }

  throw new Error(`Unsupported data file format (expected .json or .csv): ${absPath}`);
}

function parseCsv(content: string): Array<Record<string, string>> {
  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = (lines[0] ?? '').split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(',').map((v) => v.trim());
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']));
  });
}

function maskSecret(key: string, value: string): string {
  if (isSecretName(key)) {
    return value.length > 0 ? '***' : '(empty)';
  }
  return value;
}

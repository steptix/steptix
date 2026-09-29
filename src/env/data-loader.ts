import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../utils/logger.js';

/** Recursive JSON value shape used inside test-data files. */
export type DataValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: DataValue }
  | DataValue[];

export type DataObject = { [key: string]: DataValue };

/** A read-only env map for resolving `$VAR` secret leaves. Accepts both a
 *  composed per-project map (`Record<string, string>`) and `process.env`
 *  (`string | undefined` values). */
export type EnvLookup = Record<string, string | undefined>;

/**
 * Load `<dataDir>/<envName>.json` from `projectRoot`. `dataDir` comes from
 * `tests.dataDir` in `steptix.config.json` (default `data`) — the former
 * `STEPTIX_DATA_DIR` env var is gone. `$VAR` string leaves resolve against
 * `envMap` (the per-project env map on the server; `process.env` on the CLI).
 * Missing file returns an empty object (caller decides whether that's an
 * error — interpolation throws on first use).
 */
export async function loadDataFile(
  envName: string,
  projectRoot: string,
  dataDir: string,
  envMap: EnvLookup = process.env,
): Promise<DataObject> {
  const filePath = path.resolve(projectRoot, dataDir, `${envName}.json`);

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.info(`No test-data file at ${filePath} — \${data.*} references will fail at parse time if used`);
      return {};
    }
    throw err;
  }

  const resolved = parseAndResolve(content, filePath, envMap);
  const n = countLeaves(resolved);
  logger.info(`Loaded test data "${envName}" (${n} value${n === 1 ? '' : 's'})`);
  return resolved;
}

/**
 * Load a JSON data file from an absolute path, parse it, validate it's an
 * object at the top level, and resolve `$VAR` leaves against `process.env`.
 * Used by per-test `dataSources` namespaces, where the author has explicitly
 * named a file (so a missing file is a hard error, unlike the env default).
 */
export async function loadDataFromPath(
  absPath: string,
  envMap: EnvLookup = process.env,
): Promise<DataObject> {
  let content: string;
  try {
    content = await fs.readFile(absPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Data source file not found: ${absPath}`);
    }
    throw err;
  }

  const resolved = parseAndResolve(content, absPath, envMap);
  const n = countLeaves(resolved);
  logger.info(`Loaded data source ${absPath} (${n} value${n === 1 ? '' : 's'})`);
  return resolved;
}

/**
 * Parse a JSON string, validate it's a plain object at the top level, and
 * walk its leaves resolving `$VAR` references. The shared core of
 * `loadDataFile` and `loadDataFromPath`.
 */
function parseAndResolve(content: string, filePath: string, envMap: EnvLookup): DataObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Invalid JSON in ${filePath}: ${(err as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Test data file must be a JSON object at the top level: ${filePath}`);
  }

  return resolveSecrets(parsed as DataObject, envMap) as DataObject;
}

/**
 * Walk a JSON tree and replace any string leaf of the form `$NAME` with the
 * value of `envMap.NAME`. If the var isn't set, the literal `$NAME` is kept and
 * a warning is logged — matches the behaviour of `## Parameters` `$VAR`
 * resolution. `envMap` is the per-project env map on the server (so a project's
 * secrets never leak across projects) or `process.env` on the CLI.
 */
function resolveSecrets(value: DataValue, envMap: EnvLookup): DataValue {
  if (typeof value === 'string') {
    if (value.startsWith('$') && /^\$[A-Z_][A-Z0-9_]*$/i.test(value)) {
      const name = value.slice(1);
      const env = envMap[name];
      if (env !== undefined) return env;
      logger.warn(`Test data references $${name} but the env var is not set — using literal "$${name}"`);
      return value;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveSecrets(v, envMap));
  }
  if (value && typeof value === 'object') {
    const out: DataObject = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolveSecrets(v, envMap);
    }
    return out;
  }
  return value;
}

function countLeaves(value: DataValue): number {
  if (value === null) return 1;
  if (typeof value !== 'object') return 1;
  if (Array.isArray(value)) {
    return value.reduce<number>((n, v) => n + countLeaves(v), 0);
  }
  return Object.values(value).reduce<number>((n, v) => n + countLeaves(v), 0);
}

/**
 * Walk a dotted path through a parsed data object. Returns `undefined` when
 * any step doesn't exist (caller produces the user-facing error so it can
 * include the surrounding step text). Numeric indices into arrays work
 * naturally — `users.0.email`.
 */
export function lookupDataPath(data: DataObject, dottedPath: string): DataValue | undefined {
  if (!dottedPath) return undefined;
  const parts = dottedPath.split('.');
  let cur: DataValue | undefined = data;
  for (const part of parts) {
    if (cur === undefined || cur === null) return undefined;
    if (typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else {
      if (!(part in cur)) return undefined;
      cur = cur[part];
    }
  }
  return cur;
}

import { lookupDataPath, type DataObject, type DataValue } from '../env/data-loader.js';

export interface EnvDataContext {
  /** Snapshot of resolved env vars (typically a frozen process.env clone). */
  env: Record<string, string>;
  /** Parsed `data/<env>.json` object. */
  data: DataObject;
  /** File path used in error messages (test or skill markdown path). */
  filePath?: string;
}

/**
 * Replace `${env.NAME}` and `${data.path.to.value}` in `text` against the
 * supplied env+data context. Throws a descriptive error on unknown refs so
 * the runner fails fast with a precise pointer (file path) rather than
 * sending an unresolved `${...}` string to the AI.
 *
 * Existing `{{parameter}}` interpolation is untouched — that pass runs later
 * (at runtime, per-step) inside test-runner.ts. Two distinct namespaces:
 *
 *  - `${env.X}` / `${data.X}` — resolved at parse time; values fixed for the
 *    whole run; right for env+structured-data substitution.
 *  - `{{X}}` — resolved per step at runtime; right for input prompts and
 *    data-driven row values.
 */
export function interpolateEnvData(text: string, ctx: EnvDataContext): string {
  // Match `${env.X}` or `${data.a.b.c}`. Whitespace inside braces tolerated.
  const PATTERN = /\$\{\s*(env|data)\.([A-Za-z0-9_.\-]+)\s*\}/g;

  return text.replace(PATTERN, (match, kind: string, ref: string) => {
    if (kind === 'env') {
      const value = ctx.env[ref];
      if (value === undefined) {
        throw new Error(formatRefError('env', ref, text, ctx.filePath));
      }
      return value;
    }
    // kind === 'data'
    const value = lookupDataPath(ctx.data, ref);
    if (value === undefined) {
      throw new Error(formatRefError('data', ref, text, ctx.filePath));
    }
    return stringifyDataValue(value);
  });
}

/** Walk an object/array tree and interpolate every string leaf in place (returns a new tree). */
export function interpolateEnvDataDeep<T>(value: T, ctx: EnvDataContext): T {
  if (typeof value === 'string') {
    return interpolateEnvData(value, ctx) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolateEnvDataDeep(v, ctx)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolateEnvDataDeep(v, ctx);
    }
    return out as unknown as T;
  }
  return value;
}

function stringifyDataValue(v: DataValue): string {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // Object / array — JSON-encode; a step author who interpolates a whole
  // subtree probably wants something predictable rather than `[object Object]`.
  return JSON.stringify(v);
}

function formatRefError(
  kind: 'env' | 'data',
  ref: string,
  text: string,
  filePath?: string,
): string {
  const where = filePath ? ` in ${filePath}` : '';
  const namespace = kind === 'env' ? 'environment variable' : 'data path';
  return `Unknown ${namespace} '${ref}'${where} — referenced as \${${kind}.${ref}} in: "${text.trim()}"`;
}

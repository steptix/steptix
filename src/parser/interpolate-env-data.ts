import { lookupDataPath, type DataObject, type DataValue } from '../env/data-loader.js';

export interface EnvDataContext {
  /** Snapshot of resolved env vars (typically a frozen process.env clone). */
  env: Record<string, string>;
  /** Parsed `data/<env>.json` object. */
  data: DataObject;
  /**
   * Additional named JSON namespaces declared by the test's `dataSources`
   * frontmatter, keyed by namespace name (e.g. `vip`, `local`). Each value
   * is the parsed-and-secret-resolved JSON tree for that source. References
   * `${<name>.path.to.value}` resolve against the matching tree. Names here
   * never collide with `env`/`data` (rejected at frontmatter parse time).
   */
  extraData?: Record<string, DataObject>;
  /** File path used in error messages (test or skill markdown path). */
  filePath?: string;
}

/**
 * Replace `${env.NAME}`, `${data.path.to.value}`, and any
 * `${<source>.path.to.value}` against the supplied env+data context. Throws a
 * descriptive error on a known namespace with an unknown ref so the runner
 * fails fast with a precise pointer (file path) rather than sending an
 * unresolved `${...}` string to the AI.
 *
 * Backwards compatibility: namespaces are matched dynamically. When
 * `ctx.extraData` is empty/absent the matching pattern is exactly today's
 * `${env.X}|${data.X}` regex — placeholders for unknown namespaces pass
 * through literally, same as before.
 *
 * Existing `{{parameter}}` interpolation is untouched — that pass runs later
 * (at runtime, per-step) inside test-runner.ts. Two distinct namespaces:
 *
 *  - `${env.X}` / `${data.X}` / `${<source>.X}` — resolved at parse time;
 *    values fixed for the whole run; right for env+structured-data
 *    substitution.
 *  - `{{X}}` — resolved per step at runtime; right for input prompts and
 *    data-driven row values.
 */
export function interpolateEnvData(text: string, ctx: EnvDataContext): string {
  const pattern = buildPattern(ctx);

  return text.replace(pattern, (_match, kind: string, ref: string) => {
    if (kind === 'env') {
      const value = ctx.env[ref];
      if (value === undefined) {
        throw new Error(formatRefError('env', ref, text, ctx.filePath));
      }
      return value;
    }
    if (kind === 'data') {
      const value = lookupDataPath(ctx.data, ref);
      if (value === undefined) {
        throw new Error(formatRefError('data', ref, text, ctx.filePath));
      }
      return stringifyDataValue(value);
    }
    // Must be a registered extraData namespace — buildPattern only emits
    // alternatives for those, so any other `kind` would never match.
    const tree = ctx.extraData?.[kind];
    // istanbul ignore next — defensive; pattern can't match unknown names.
    if (!tree) throw new Error(`Internal: namespace "${kind}" not registered`);
    const value = lookupDataPath(tree, ref);
    if (value === undefined) {
      throw new Error(formatRefError(kind, ref, text, ctx.filePath));
    }
    return stringifyDataValue(value);
  });
}

/**
 * Build the `${<ns>.<path>}` matching regex from the namespaces actually
 * available in `ctx`. Keeps the regex tight to known namespaces so unknown
 * placeholders (e.g. `${foo.bar}` in a test that doesn't declare `foo`) pass
 * through literally — matching today's behaviour for non-`env`/`data` refs.
 */
function buildPattern(ctx: EnvDataContext): RegExp {
  const names = ['env', 'data', ...Object.keys(ctx.extraData ?? {})];
  // Names are validated at frontmatter parse time to match
  // /^[A-Za-z_][A-Za-z0-9_]*$/, so they need no regex-escaping here.
  const alt = names.join('|');
  return new RegExp(`\\$\\{\\s*(${alt})\\.([A-Za-z0-9_.\\-]+)\\s*\\}`, 'g');
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
  kind: string,
  ref: string,
  text: string,
  filePath?: string,
): string {
  const where = filePath ? ` in ${filePath}` : '';
  const namespace =
    kind === 'env' ? 'environment variable'
    : kind === 'data' ? 'data path'
    : `data path in '${kind}'`;
  return `Unknown ${namespace} '${ref}'${where} — referenced as \${${kind}.${ref}} in: "${text.trim()}"`;
}

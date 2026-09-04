import { lookupDataPath, type DataObject, type DataValue } from '../env/data-loader.js';
import { isSecretName } from './parameters.js';

export interface EnvDataContext {
  /** Snapshot of resolved env vars (typically a frozen process.env clone). */
  env: Record<string, string>;
  /**
   * Parsed `data/<env>.json` object. Optional — when omitted, the
   * interpolation regex won't match `${data.X}` and those references pass
   * through literally. Skill-level interpolation deliberately leaves `data`
   * unset so a skill never reaches into the caller's env-default data file.
   */
  data?: DataObject;
  /**
   * Additional named JSON namespaces declared by the test's or skill's
   * `dataSources` frontmatter, keyed by namespace name (e.g. `vip`,
   * `endpoints`). Each value is the parsed-and-secret-resolved JSON tree
   * for that source. References `${<name>.path.to.value}` resolve against
   * the matching tree. Names never collide with `env`/`data` (rejected at
   * frontmatter parse time).
   */
  extraData?: Record<string, DataObject>;
  /**
   * Active env name (the `--env <name>` flag, or null when no env was
   * selected). Surfaced as a `${envName}` (no-dot) placeholder, mostly for
   * `dataSources` paths like `../data/${envName}-endpoints.json`.
   */
  envName?: string | null;
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
  // ${envName} (no dot) — special token resolved before the dotted pattern so
  // it doesn't compete with the namespace alternation. The replace callback
  // throws on the first match if no env name is selected, so a placeholder
  // that's actually present cannot silently pass through. Strings that don't
  // contain the placeholder cost only a regex sweep.
  const out = text.replace(ENV_NAME_TOKEN_RE, () => {
    if (!ctx.envName) throw envNameUnsetError(ctx.filePath);
    return ctx.envName;
  });

  const pattern = buildPattern(ctx);
  return out.replace(pattern, (_match, kind: string, ref: string) => {
    if (kind === 'env') {
      const value = ctx.env[ref];
      if (value === undefined) {
        throw new Error(formatRefError('env', ref, text, ctx.filePath));
      }
      return value;
    }
    if (kind === 'data') {
      // buildPattern only includes 'data' when ctx.data is set.
      const value = lookupDataPath(ctx.data!, ref);
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
 * Resolve the narrow set of placeholders allowed inside a `dataSources`
 * **path string**: `${env.NAME}` and `${envName}`. Any other placeholder
 * (`${data.X}`, `${<source>.X}`) is rejected with an error, because at the
 * point a path is being resolved no JSON data file has been loaded yet —
 * referencing one would be a chicken-and-egg loop.
 *
 * Used by skill and test parsers when computing the absolute filesystem
 * path of each declared `dataSources` entry.
 */
export function interpolateDataSourcePath(
  text: string,
  ctx: { env: Record<string, string>; envName?: string | null; filePath?: string },
): string {
  const out = text.replace(ENV_NAME_TOKEN_RE, () => {
    if (!ctx.envName) throw envNameUnsetError(ctx.filePath);
    return ctx.envName;
  });
  return out.replace(DATA_SOURCE_PATH_PATTERN, (_match, kind: string, ref: string) => {
    if (kind === 'env') {
      const value = ctx.env[ref];
      if (value === undefined) {
        throw new Error(formatRefError('env', ref, text, ctx.filePath));
      }
      return value;
    }
    // Any non-`env` namespace is invalid inside a path string.
    throw new Error(
      `Cannot reference \${${kind}.${ref}} inside a dataSources path` +
      `${ctx.filePath ? ` in ${ctx.filePath}` : ''} — only \${env.X} and ` +
      `\${envName} are allowed (data files aren't loaded yet at path-resolution time).`,
    );
  });
}

/** `${envName}` — the no-dot, single-token form. Allows surrounding whitespace. */
const ENV_NAME_TOKEN_RE = /\$\{\s*envName\s*\}/g;

/**
 * Every placeholder of the grammar above, whatever its namespace: `envName`
 * and `<word>.<dotted-path>` — as a pattern SOURCE with one capturing group,
 * so the one grammar can be composed into a larger alternation instead of
 * copied. The executor's substituter does exactly that: it resolves `{{name}}`
 * and `${…}` in a single pass, which is what stops it re-scanning a value it
 * just inserted (stories/placeholder-preserving-actions.md, decision 3).
 */
export const ENV_DATA_REF_SOURCE =
  '\\$\\{\\s*(envName|[A-Za-z_][A-Za-z0-9_]*\\.[A-Za-z0-9_.\\-]+)\\s*\\}';

/**
 * Used to find the references in a step's authored text without a context in
 * hand — a namespace nothing declares is a reference too, one
 * `resolveEnvDataRef` answers with `undefined`.
 */
const ANY_REF_RE = new RegExp(ENV_DATA_REF_SOURCE, 'g');

/**
 * The `${...}` references a step makes, as the bare name inside the braces
 * (`data.url`, `env.BASE_URL`, `endpoints.api.url`, `envName`), in source
 * order, deduped. `{{name}}` placeholders are a different grammar and are
 * not reported here — see `referencedVariableNames`.
 *
 * This is the name `step.getVar` takes for the same reference at run time
 * (stories/codebehind-env-data.md): whatever is inside `${...}` in the step
 * is what the code passes to `getVar`.
 */
export function envDataRefsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ANY_REF_RE)) {
    const ref = m[1]!;
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
}

/**
 * Resolve one reference the way `interpolateEnvData` would — same namespace
 * rules, same path walk, same stringification of a non-string leaf — except
 * that a miss is `undefined` rather than a throw: at run time the caller is
 * generated code asking for a value, and "not defined" is an answer.
 *
 * `data` resolves only when the context carries it (skill-level contexts
 * deliberately omit it); any other namespace must be a declared source.
 */
export function resolveEnvDataRef(name: string, ctx: EnvDataContext): string | undefined {
  const ref = name.trim();
  if (ref === 'envName') return ctx.envName ?? undefined;
  const dot = ref.indexOf('.');
  if (dot <= 0 || dot === ref.length - 1) return undefined;
  const namespace = ref.slice(0, dot);
  const dataPath = ref.slice(dot + 1);
  if (namespace === 'env') return ctx.env[dataPath];
  const tree = namespace === 'data' ? ctx.data : ctx.extraData?.[namespace];
  if (!tree) return undefined;
  const value = lookupDataPath(tree, dataPath);
  return value === undefined ? undefined : stringifyDataValue(value);
}

/**
 * The environment's secret values: every env var with a secret-looking name,
 * and every string leaf of the data trees that sits under a secret-looking
 * key anywhere on its path (`users.admin.password`). What a recording on disk
 * redacts besides the secret-named parameters
 * (stories/codebehind-env-data.md, "The recording redacts environment
 * secrets"). Non-empty strings only: a numeric `pin` would not match the
 * name rule anyway, and redacting `""` is a no-op that costs a split.
 */
export function envDataSecretValues(ctx: EnvDataContext): string[] {
  const out = new Set<string>();
  for (const [name, value] of Object.entries(ctx.env)) {
    if (isSecretName(name) && value.length > 0) out.add(value);
  }
  const walk = (value: DataValue, underSecret: boolean): void => {
    if (typeof value === 'string') {
      if (underSecret && value.length > 0) out.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, underSecret);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        walk(child, underSecret || isSecretName(key));
      }
    }
  };
  if (ctx.data) walk(ctx.data, false);
  for (const tree of Object.values(ctx.extraData ?? {})) walk(tree, false);
  return [...out];
}

function envNameUnsetError(filePath?: string): Error {
  return new Error(
    `Cannot resolve \${envName}${filePath ? ` in ${filePath}` : ''} — ` +
    `no environment selected for this run (pass --env <name>).`,
  );
}

/**
 * Path-string interpolation regex. Matches any `${<word>.<dotted-path>}`
 * placeholder so we can produce a clear "not allowed in paths" error for
 * non-`env` namespaces, rather than letting them silently pass through.
 */
const DATA_SOURCE_PATH_PATTERN = /\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z0-9_.\-]+)\s*\}/g;

/**
 * Build the `${<ns>.<path>}` matching regex from the namespaces actually
 * available in `ctx`. Keeps the regex tight to known namespaces so unknown
 * placeholders (e.g. `${foo.bar}` in a test that doesn't declare `foo`) pass
 * through literally — matching today's behaviour for non-`env`/`data` refs.
 */
function buildPattern(ctx: EnvDataContext): RegExp {
  const names = [
    'env',
    ...(ctx.data !== undefined ? ['data'] : []),
    ...Object.keys(ctx.extraData ?? {}),
  ];
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

/** A data leaf as step text sees it: strings as they are, scalars via
 *  `String`, a subtree JSON-encoded. Shared with `resolveEnvDataRef` so
 *  `step.getVar('data.fixtures')` reads what `${data.fixtures}` would. */
export function stringifyDataValue(v: DataValue): string {
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

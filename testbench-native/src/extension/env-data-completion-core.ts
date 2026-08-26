/**
 * IntelliSense for `${env.X}` / `${data.X.Y}` / `${<source>.X}` / `${envName}`
 * references — the vscode-free half, so the cursor-context parse, the JSON
 * tree walk, and the secret masking are unit-testable under `node --test`.
 *
 * The grammar mirrored here is the runtime's, from
 * src/parser/interpolate-env-data.ts:
 *
 *   ${ <namespace> . <dotted-path> }     namespace: [A-Za-z_][A-Za-z0-9_]*
 *                                        path segs: [A-Za-z0-9_-]* ('.'-joined)
 *   ${ envName }                         the one no-dot token
 *
 * with optional whitespace just inside the braces. Where the runtime and this
 * file could disagree about what a reference is, the runtime wins — completion
 * only ever *offers*; it never validates.
 */
import { classifyLines, resolveValueFromEnv } from 'ai-ui-automation-runner-core';

// ---------------------------------------------------------------------------
// Data tree shape (mirrors src/env/data-loader.ts — the extension package
// can't import it, and the shape is just "parsed JSON").
// ---------------------------------------------------------------------------

export type DataValue =
  | string
  | number
  | boolean
  | null
  | DataValue[]
  | { [key: string]: DataValue };

export type DataObject = { [key: string]: DataValue };

// ---------------------------------------------------------------------------
// Cursor context — what is being completed at a position
// ---------------------------------------------------------------------------

/** Cursor is typing the namespace itself: `${`, `${da`, `${ en`. */
export interface NamespaceContext {
  kind: 'namespace';
  /** Characters typed so far (`da` in `${da`). */
  partial: string;
  /** 0-based column where the partial starts (just past `${` + whitespace). */
  replaceStart: number;
}

/** Cursor is typing a dotted path inside a known namespace: `${data.us`,
 *  `${data.users.`, `${endpoints.api.ur`. */
export interface PathContext {
  kind: 'path';
  namespace: string;
  /** Complete segments between the namespace and the one being typed
   *  (`['users']` in `${data.users.ad`). */
  parentPath: string[];
  /** The segment being typed (may be empty, right after a `.`). */
  partial: string;
  /** 0-based column where the partial segment starts. */
  replaceStart: number;
}

export type RefContext = NamespaceContext | PathContext;

/** Namespace: letter/underscore first — same as the runtime's `buildPattern`
 *  input rule. Path segments additionally admit digits-first (`users.0`) and
 *  hyphens, same as the runtime's `[A-Za-z0-9_.\-]+` path class. */
const BODY_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_-]*)*$/;

/** One path segment as the runtime can address it: `lookupDataPath` splits
 *  the reference on `.`, so a completable key must be a single non-empty run
 *  of this class — a key containing a dot, space, or `@` has no reference
 *  that reaches it and must not be offered. */
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

/**
 * What `${...` reference, if any, the cursor at `character` is inside on
 * `line`. Null when the cursor is not inside an open reference (no `${`
 * before it, a `}` already closed it, or the text since `${` isn't a
 * reference prefix). References never span lines, so line-local is exact.
 */
export function refContextAt(line: string, character: number): RefContext | null {
  const before = line.slice(0, character);
  const open = before.lastIndexOf('${');
  if (open === -1) return null;
  const inner = before.slice(open + 2);
  if (inner.includes('}')) return null;

  // `${\s*` — the runtime tolerates whitespace after the brace.
  const ws = /^\s*/.exec(inner)![0].length;
  const body = inner.slice(ws);
  const bodyStart = open + 2 + ws;

  if (body === '') return { kind: 'namespace', partial: '', replaceStart: bodyStart };
  if (!BODY_RE.test(body)) return null;

  const segments = body.split('.');
  if (segments.length === 1) {
    return { kind: 'namespace', partial: segments[0]!, replaceStart: bodyStart };
  }
  const partial = segments[segments.length - 1]!;
  return {
    kind: 'path',
    namespace: segments[0]!,
    parentPath: segments.slice(1, -1),
    partial,
    replaceStart: character - partial.length,
  };
}

// ---------------------------------------------------------------------------
// Frontmatter span (for the skill dataSources-path special case)
// ---------------------------------------------------------------------------

/**
 * Whether 0-based `lineIdx` sits inside the YAML frontmatter block, per
 * runner-core's `classifyLines` — the same span every other editor feature
 * uses (decorations, diagnostics, step regions), so completion cannot invent
 * a fourth frontmatter grammar. Delimiter lines count as inside; that is
 * immaterial here because a `---` fence line can never also contain the open
 * `${` that gets this function consulted.
 *
 * Inside the span, `${...}` is a *path* placeholder (skill `dataSources:`
 * values), where the runtime allows only `${env.X}` and `${envName}` — and
 * only for skills.
 */
export function inFrontmatter(text: string, lineIdx: number): boolean {
  return classifyLines(text)[lineIdx]?.kind === 'frontmatter';
}

// ---------------------------------------------------------------------------
// Tree walking + `$VAR` leaf resolution
// ---------------------------------------------------------------------------

/**
 * Walk `parts` into a parsed data tree — the same semantics as the runtime's
 * `lookupDataPath` (arrays take integer segments), except over a whole
 * prefix rather than a full reference. Undefined on any miss.
 */
export function walkTree(tree: DataValue | undefined, parts: string[]): DataValue | undefined {
  let cur: DataValue | undefined = tree;
  for (const part of parts) {
    if (cur === undefined || cur === null || typeof cur !== 'object') return undefined;
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

/**
 * Replace `$NAME` string leaves with the env var's value, so previews show
 * what the run would substitute (the loader's `resolveSecrets`). Leaves
 * delegate to runner-core's `resolveValueFromEnv` — the same lookup the
 * `## Parameters` `$VAR` path uses; an unset var keeps the literal, same as
 * the runtime. (The loader's `/^\$[A-Z_][A-Z0-9_]*$/i` gate is observably
 * equivalent here: these env maps come from `parseEnv`, whose keys are
 * always identifier-shaped.)
 */
export function resolveDataTree(value: DataValue, env: Record<string, string>): DataValue {
  if (typeof value === 'string') return resolveValueFromEnv(value, env);
  if (Array.isArray(value)) return value.map((v) => resolveDataTree(v, env));
  if (value && typeof value === 'object') {
    const out: DataObject = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveDataTree(v, env);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Secret masking
// ---------------------------------------------------------------------------

/**
 * The runtime's one rule for what a secret is — `isSecretName` in
 * src/parser/parameters.ts (and src/utils/secrets.ts), which matches bare
 * "key" (`MACHINE_KEY`, `privateKey`) on top of the obvious names. The
 * dropdown must mask everything a recording or report would redact, so this
 * deliberately does NOT reuse runner-core's narrower `maskIfSecret` pattern
 * (no bare "key") — a completion detail is as public as a report.
 */
const SECRET_NAME_RE = /password|secret|token|key/i;

/** Star-mask in the same shape `maskIfSecret` renders elsewhere. */
function maskValue(value: string): string {
  if (value.length === 0) return '(empty)';
  return '*'.repeat(Math.min(value.length, 8));
}

/** Mask `value` when the name (a single env var, or a '.'-joined data path)
 *  is secret-shaped anywhere along it — matching the runtime's
 *  `envDataSecretValues`, which treats a secret-named key as tainting
 *  everything beneath it. Works on the joined path because no pattern word
 *  contains '.'. */
function maskIfSecretName(name: string, value: string): string {
  return SECRET_NAME_RE.test(name) ? maskValue(value) : value;
}

// ---------------------------------------------------------------------------
// Plain completion descriptors (mapped to vscode.CompletionItem by the caller)
// ---------------------------------------------------------------------------

export interface PlainCompletion {
  label: string;
  kind: 'namespace' | 'env-var' | 'branch' | 'leaf' | 'env-name';
  /** Short right-hand text: a masked value preview or the node shape. */
  detail?: string;
  /** Text to insert when it differs from the label (`data.` for a namespace). */
  insertText?: string;
  /** Re-open the suggest widget after accepting (namespace items, whose
   *  mandatory `.` was just inserted). */
  chain?: boolean;
  sortText: string;
}

const PREVIEW_MAX = 48;

/** A leaf as step text would receive it (runtime `stringifyDataValue`),
 *  flattened + truncated for a one-line detail. */
function previewValue(v: DataValue): string {
  const s =
    v === null ? ''
    : typeof v === 'string' ? v
    : typeof v === 'object' ? JSON.stringify(v)
    : String(v);
  const flat = s.replace(/\r?\n/g, '␤');
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX)}…` : flat;
}

/**
 * Completions for the node at `parentPath` inside `tree`: the keys of an
 * object, the indices of an array, nothing for a leaf (there is nothing
 * deeper to type). Keys the reference grammar cannot address (a dot, space,
 * `@`, …) are not offered — accepting one would author a reference the
 * runtime can never resolve. `namespace` is the already-typed lead-in,
 * required because it participates in secret masking (a source *named*
 * `passwords` taints its whole tree).
 */
export function treeCompletions(
  tree: DataValue | undefined,
  parentPath: string[],
  namespace: string,
): PlainCompletion[] {
  const node = walkTree(tree, parentPath);
  if (node === undefined || node === null || typeof node !== 'object') return [];

  const entries: Array<[string, DataValue]> = Array.isArray(node)
    ? node.map((v, i) => [String(i), v] as [string, DataValue])
    : Object.entries(node).filter(([key]) => SEGMENT_RE.test(key));

  return entries.map(([key, value], i) => {
    const isBranch = value !== null && typeof value === 'object';
    const fullPath = [namespace, ...parentPath, key].join('.');
    return {
      label: key,
      kind: isBranch ? 'branch' : 'leaf',
      detail: isBranch
        ? Array.isArray(value)
          ? `[${value.length} item${value.length === 1 ? '' : 's'}]`
          : `{${Object.keys(value).length} key${Object.keys(value).length === 1 ? '' : 's'}}`
        : maskIfSecretName(fullPath, previewValue(value)),
      // JSON author order, not alphabetical — data files group related keys.
      sortText: String(i).padStart(4, '0'),
    };
  });
}

/** Completions for `${env.` — every key of the composed env map, masked. */
export function envVarCompletions(env: Record<string, string>): PlainCompletion[] {
  return Object.keys(env)
    .sort((a, b) => a.localeCompare(b))
    .map((name, i) => ({
      label: name,
      kind: 'env-var' as const,
      detail: maskIfSecretName(name, previewValue(env[name]!)),
      sortText: String(i).padStart(4, '0'),
    }));
}

export interface NamespaceOptions {
  /** Active env name. Callers only ask for completions when an env is
   *  selected — with none, a run interpolates nothing, so nothing is
   *  offerable (the wiring returns [] before reaching here). */
  envName: string;
  /** Detail for the `data` item, e.g. `fixtures/data/local.json` (possibly
   *  suffixed ` (not found)`). Null suppresses the item — the caller passes
   *  null for skills, which never see the caller-env data file. */
  dataDetail: string | null;
  /** Declared `dataSources` names with their declared paths as detail. */
  sources: Array<{ name: string; detail: string }>;
  /** Detail for the `env` item (which .env file(s) feed it). */
  envDetail: string;
  /** Restrict to what a dataSources *path string* may reference (`env` +
   *  `envName` only) — set inside a skill's frontmatter. */
  pathPosition?: boolean;
}

/**
 * The namespace-level completions for `${` — `data`, each declared source,
 * `env`, and `envName`. Namespace items insert their trailing `.` (it is
 * mandatory in the grammar) and chain straight into the next level.
 */
export function namespaceCompletions(opts: NamespaceOptions): PlainCompletion[] {
  const out: PlainCompletion[] = [];
  if (!opts.pathPosition) {
    if (opts.dataDetail !== null) {
      out.push({
        label: 'data',
        kind: 'namespace',
        detail: opts.dataDetail,
        insertText: 'data.',
        chain: true,
        sortText: '0',
      });
    }
    for (const [i, s] of opts.sources.entries()) {
      out.push({
        label: s.name,
        kind: 'namespace',
        detail: s.detail,
        insertText: `${s.name}.`,
        chain: true,
        sortText: `1_${String(i).padStart(2, '0')}`,
      });
    }
  }
  out.push({
    label: 'env',
    kind: 'namespace',
    detail: opts.envDetail,
    insertText: 'env.',
    chain: true,
    sortText: '2',
  });
  out.push({
    label: 'envName',
    kind: 'env-name',
    detail: opts.envName,
    sortText: '3',
  });
  return out;
}

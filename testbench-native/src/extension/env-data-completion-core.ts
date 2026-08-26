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
import { maskIfSecret } from 'ai-ui-automation-runner-core';

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
 * Whether 0-based `lineIdx` sits inside the YAML frontmatter block. Inside
 * it, `${...}` is a *path* placeholder (skill `dataSources:` values), where
 * the runtime allows only `${env.X}` and `${envName}` — and only for skills.
 */
export function inFrontmatter(text: string, lineIdx: number): boolean {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') return false;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i]!)) return lineIdx > 0 && lineIdx < i;
  }
  return false;
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
 * Replace `$NAME` string leaves with the env var's value, like the loader's
 * `resolveSecrets`, so previews show what the run would substitute. An unset
 * var keeps the literal — same as the runtime.
 */
export function resolveDataTree(value: DataValue, env: Record<string, string>): DataValue {
  if (typeof value === 'string') {
    if (/^\$[A-Z_][A-Z0-9_]*$/i.test(value)) {
      const resolved = env[value.slice(1)];
      if (resolved !== undefined) return resolved;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveDataTree(v, env));
  if (value && typeof value === 'object') {
    const out: DataObject = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveDataTree(v, env);
    return out;
  }
  return value;
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
 * Value preview for `path` (the full dotted path including the leaf key),
 * masked when any part of the path is secret-named. Delegating the name test
 * to `maskIfSecret` over the '.'-joined path gives ancestor masking for free:
 * `users.admin.password` and `passwords.admin` both match, exactly like the
 * runtime's `envDataSecretValues` walk treats a secret-named key as tainting
 * everything beneath it.
 */
function maskedPreview(pathName: string, v: DataValue): string {
  return maskIfSecret(pathName, previewValue(v));
}

/**
 * Completions for the node at `parentPath` inside `tree`: the keys of an
 * object, the indices of an array, nothing for a leaf (there is nothing
 * deeper to type). `pathPrefix` is the already-typed lead-in used only for
 * secret masking (namespace included is fine — extra context never unmasks).
 */
export function treeCompletions(
  tree: DataValue | undefined,
  parentPath: string[],
  pathPrefix: string[] = [],
): PlainCompletion[] {
  const node = walkTree(tree, parentPath);
  if (node === undefined || node === null || typeof node !== 'object') return [];

  const entries: Array<[string, DataValue]> = Array.isArray(node)
    ? node.map((v, i) => [String(i), v] as [string, DataValue])
    : Object.entries(node);

  return entries.map(([key, value], i) => {
    const isBranch = value !== null && typeof value === 'object';
    const fullPath = [...pathPrefix, ...parentPath, key].join('.');
    return {
      label: key,
      kind: isBranch ? 'branch' : 'leaf',
      detail: isBranch
        ? Array.isArray(value)
          ? `[${value.length} item${value.length === 1 ? '' : 's'}]`
          : `{${Object.keys(value).length} key${Object.keys(value).length === 1 ? '' : 's'}}`
        : maskedPreview(fullPath, value),
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
      detail: maskIfSecret(name, previewValue(env[name]!)),
      sortText: String(i).padStart(4, '0'),
    }));
}

export interface NamespaceOptions {
  /** Active env name (frontmatter pin, else the EnvSelector) — null if none. */
  envName: string | null;
  /** `type: skill` file — no `data` namespace (skills never see the caller's
   *  env-default data file). */
  isSkill: boolean;
  /** Detail for the `data` item, e.g. `fixtures/data/local.json` (possibly
   *  suffixed ` (not found)`). Null suppresses the item (no env / a skill). */
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
    if (opts.dataDetail !== null && !opts.isSkill && opts.envName) {
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
  if (opts.envName) {
    out.push({
      label: 'envName',
      kind: 'env-name',
      detail: opts.envName,
      sortText: '3',
    });
  }
  return out;
}

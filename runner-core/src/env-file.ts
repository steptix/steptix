/**
 * `.env` resolver and parser.
 *
 * Resolution rule: walk up from the test file to the nearest ancestor
 * containing `.env`, stopping at (and including) the workspace root. If none
 * found, fall back to a workspace-level `defaultEnvFile` setting. If still
 * none, return a miss with the search path so the caller can render TB001.
 *
 * Parser is a small subset of the canonical `.env` format: KEY=VALUE per line,
 * `#` comments, optional surrounding single or double quotes (stripped), no
 * variable interpolation, no `export` prefix support.
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

export interface ResolveEnvHit {
  hit: true;
  /** Absolute path to the `.env` we resolved. */
  path: string;
  /** Where this file came from. */
  source: 'walkup' | 'fallback';
  /** Directories we inspected (in walk-up order) before resolving. */
  searchedDirs: string[];
}

export interface ResolveEnvMiss {
  hit: false;
  /** Directories we inspected (in walk-up order). */
  searchedDirs: string[];
  /** Value of the fallback setting we tried (empty string if unset). */
  fallbackPath: string;
}

export type ResolveEnvResult = ResolveEnvHit | ResolveEnvMiss;

export interface ResolveEnvOptions {
  /** Absolute path of the test file the run was triggered for. */
  testFile: string;
  /** Absolute path of the workspace root. Walk-up stops here (inclusive). */
  workspaceRoot: string;
  /**
   * Optional fallback path. May be absolute or workspace-relative. If empty
   * or undefined, the fallback step is skipped.
   */
  fallbackPath?: string;
  /** Override for tests — defaults to `fs.access`. */
  exists?: (p: string) => Promise<boolean>;
}

/**
 * Walk up from the test file's directory looking for a `.env`, stopping at
 * the workspace root (inclusive). If none found, try `fallbackPath`.
 */
export async function resolveEnvFile(opts: ResolveEnvOptions): Promise<ResolveEnvResult> {
  const exists = opts.exists ?? defaultExists;
  const testFile = path.resolve(opts.testFile);
  const workspaceRoot = path.resolve(opts.workspaceRoot);

  const searchedDirs: string[] = [];

  // Build the walk-up list: testFile's dir → ... → workspaceRoot.
  let dir = path.dirname(testFile);
  const seen = new Set<string>();
  // Hard cap on depth (defensive — should never trigger in normal layouts).
  for (let i = 0; i < 64; i++) {
    if (seen.has(dir)) break;
    seen.add(dir);
    searchedDirs.push(dir);

    const candidate = path.join(dir, '.env');
    if (await exists(candidate)) {
      return { hit: true, path: candidate, source: 'walkup', searchedDirs };
    }

    if (dir === workspaceRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) break; // hit filesystem root
    // If we've walked past the workspace root, stop.
    if (!isInside(parent, workspaceRoot) && parent !== workspaceRoot) break;
    dir = parent;
  }

  const fallback = (opts.fallbackPath ?? '').trim();
  if (fallback.length > 0) {
    const resolved = path.isAbsolute(fallback)
      ? fallback
      : path.resolve(workspaceRoot, fallback);
    if (await exists(resolved)) {
      return { hit: true, path: resolved, source: 'fallback', searchedDirs };
    }
  }

  return { hit: false, searchedDirs, fallbackPath: fallback };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export class EnvParseError extends Error {
  override readonly name = 'EnvParseError';
  /** 1-based line number of the offending line. */
  readonly lineNumber: number;
  /** The raw source line that failed to parse. */
  readonly line: string;

  constructor(lineNumber: number, line: string, message: string) {
    super(message);
    this.lineNumber = lineNumber;
    this.line = line;
  }
}

/**
 * Parse a `.env` file's contents into a flat map.
 * Throws `EnvParseError` on a malformed line, with line number + raw text
 * suitable for TB005.
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // Strip optional `export ` prefix to be friendly.
    const stripped = trimmed.startsWith('export ') ? trimmed.slice('export '.length) : trimmed;

    const eq = stripped.indexOf('=');
    if (eq <= 0) {
      throw new EnvParseError(i + 1, raw, 'expected KEY=VALUE');
    }

    const key = stripped.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new EnvParseError(i + 1, raw, `invalid key "${key}"`);
    }

    let value = stripped.slice(eq + 1).trim();

    // Strip a trailing inline comment for unquoted values only.
    if (!isQuoted(value)) {
      const hashAt = value.indexOf(' #');
      if (hashAt >= 0) value = value.slice(0, hashAt).trim();
    }

    if (isQuoted(value)) {
      const quote = value[0]!;
      if (value.length < 2 || value[value.length - 1] !== quote) {
        throw new EnvParseError(i + 1, raw, 'unterminated quoted value');
      }
      value = value.slice(1, -1);
    }

    out[key] = value;
  }

  return out;
}

/** One `KEY=value` assignment located in `.env` source text. */
export interface ServerEnvAssignment {
  key: string;
  value: string;
  /** 0-based line index of the assignment. */
  line: number;
  /** 0-based column where the key token starts, and its length — so an
   *  editor can select exactly the key. */
  column: number;
  length: number;
}

/**
 * Scan `.env` text the way the SERVER does when it resolves `${env.X}` for a
 * run — `parseEnvFile` in src/env/loader.ts, reached via `resolveEnvBundle`.
 * That parser is deliberately NOT `parseEnv` above, and differs from it in
 * every way that matters to a reader of a real `.env`:
 *
 *  - no `export ` prefix handling: `export FOO=1` keys as `export FOO`;
 *  - no key validation, and a malformed line is SKIPPED, never thrown on;
 *  - inline `#` comments are not stripped (dotenv behaviour), so
 *    `FOO=1 # note` has the value `1 # note`;
 *  - surrounding quotes are stripped only when both ends match.
 *
 * `parseEnv` stays as it is: it backs the client-side `$VAR` parameter pass
 * and its TB005 diagnostics, which want the strict, throwing reading.
 *
 * Returning positions alongside values lets one scan answer both "what would
 * a run see" and "where is this written", so the two cannot drift.
 */
export function scanServerEnv(text: string): ServerEnvAssignment[] {
  const out: ServerEnvAssignment[] = [];
  // The server splits on '\n' alone; a trailing '\r' is absorbed by the
  // per-line trim, which is why CRLF files parse the same either way.
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;

    const key = trimmed.substring(0, eq).trim();
    if (!key) continue;

    let value = trimmed.substring(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Column of the key's first character in the RAW line: the leading
    // whitespace the trim removed, plus any the key itself was padded with.
    const column =
      raw.length - raw.trimStart().length + (trimmed.length - trimmed.trimStart().length);
    out.push({ key, value, line: i, column, length: key.length });
  }
  return out;
}

/**
 * `.env` text → the map a run would see, under the server's grammar above.
 * Later assignments win, as they do in the server's own loop.
 */
export function parseServerEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of scanServerEnv(text)) out[key] = value;
  return out;
}

/**
 * Read + parse `.env` at `absPath`. Errors are surfaced as `EnvParseError`
 * with line metadata. I/O errors propagate as-is.
 */
export async function readEnvFile(absPath: string): Promise<Record<string, string>> {
  const text = await fsp.readFile(absPath, 'utf8');
  return parseEnv(text);
}

/**
 * Read the per-environment overlay `.env.<name>` from `dir` (the project root —
 * where envs are enumerated and where the CLI/server read `.env.<name>`).
 *
 * Returns `null` when the overlay file does not exist; the caller decides
 * whether a missing overlay is an error (the extension treats an explicit env
 * selection with no matching file as a hard failure — TB006). Throws
 * `EnvParseError` on a malformed line, exactly like `readEnvFile`.
 *
 * `envName` is trimmed before forming the filename, so a name with stray
 * surrounding whitespace (e.g. a quoted `env: " t2 "` in frontmatter) still
 * maps to `.env.t2` rather than a spuriously-missing `.env. t2 `.
 *
 * The overlay is read on top of the base `.env`; see `composeEnv`.
 */
export async function readEnvOverlayFile(
  dir: string,
  envName: string,
): Promise<Record<string, string> | null> {
  const candidate = path.join(dir, `.env.${envName.trim()}`);
  if (!(await defaultExists(candidate))) return null;
  return readEnvFile(candidate);
}

/**
 * Compose a base `.env` map with a per-environment overlay. The overlay wins
 * on conflicting keys; keys only in the base survive — the same way
 * `.env.<name>` overrides base `.env` on the server (`resolveEnvBundle`) and
 * the CLI (`process.env` overlay). (Those entry points add a `process.env`
 * baseline layer that the extension has no equivalent of; only the
 * overlay-beats-base relationship is shared here.)
 */
export function composeEnv(
  base: Record<string, string>,
  overlay: Record<string, string>,
): Record<string, string> {
  return { ...base, ...overlay };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function defaultExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function isQuoted(s: string): boolean {
  return s.length >= 2 && (s[0] === '"' || s[0] === "'");
}

/** Cross-platform "is `child` inside or equal to `parent`?" */
function isInside(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

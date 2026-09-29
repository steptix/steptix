/**
 * Shared file/env resolution for the `${env.X}` / `${data.X.Y}` /
 * `${<source>.X}` editor features (completion and go-to-definition): which env
 * is in force for a document, which files a run would read it from, and
 * mtime-cached reads of those files.
 *
 * Extracted from env-data-completion.ts so the definition provider answers the
 * same two questions the completion provider does — which env, which files —
 * from one implementation. The semantics mirror the SERVER's (the component
 * that actually resolves these references): env files and the data file
 * resolve against the `steptix.config.json` directory with NO walk-up, and
 * `dataSources` paths resolve against the declaring file (skills additionally
 * interpolating `${env.X}` / `${envName}`).
 *
 * That parity extends to the env GRAMMAR, which is easy to get wrong: the
 * server reads these files with `parseEnvFile` (src/env/loader.ts), not with
 * runner-core's stricter `parseEnv`, so `runner-core`'s `parseServerEnv`
 * mirror is what belongs here. Using `parseEnv` would make the editor affirm
 * references a run cannot resolve — `export FOO=1` keys as `export FOO` on the
 * server — and would blank the whole map on one malformed line the server
 * simply skips.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { parseServerEnv, type TestFrontmatter } from 'steptix-runner-core';
import { EnvSelector } from './env-selector.js';
import { resolveProjectDirs } from './steptix-config.js';
import { resolveDataTree, type DataObject } from './env-data-completion-core.js';

/**
 * The env in force for a file. A present `env:` key pins it — even a blank
 * one, which pins "no env": the batch runner sends the pin verbatim and blank
 * trims to none. Only when the key is absent does the workspace EnvSelector
 * apply.
 */
export function activeEnvFor(fm: TestFrontmatter): string | null {
  return (fm.env !== undefined ? fm.env.trim() : EnvSelector.activeEnv()) || null;
}

/**
 * Where a run would read this file's env from. The server resolves `.env`,
 * `.env.<name>`, and `<dataDir>/<name>.json` against the steptix.config.json
 * directory (= the workspace root in the common layout, which is also where
 * the EnvSelector enumerates) with no walk-up, so `projectRoot` is that
 * directory and nothing else.
 *
 * `overlayPath` is null when no env is selected: there is no `.env.<name>` to
 * name, and `composedEnv` then yields the base file alone.
 */
export function envPaths(
  document: vscode.TextDocument,
  envName: string | null,
): {
  dirs: ReturnType<typeof resolveProjectDirs>;
  projectRoot: string;
  baseEnvPath: string;
  overlayPath: string | null;
} {
  const dirs = resolveProjectDirs(document.uri);
  const workspaceRoot =
    vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ??
    path.dirname(document.uri.fsPath);
  const projectRoot = dirs ? path.dirname(dirs.configPath) : workspaceRoot;
  return {
    dirs,
    projectRoot,
    baseEnvPath: path.join(projectRoot, '.env'),
    overlayPath: envName === null ? null : path.join(projectRoot, `.env.${envName}`),
  };
}

// ---------------------------------------------------------------------------
// mtime-cached file reads (same idea as readProjectDirs in steptix-config-parse)
// ---------------------------------------------------------------------------

/**
 * A reader for one parse of a file, cached by absolute path + mtime. Each
 * parse gets its own cache map so two readers of the SAME path (e.g. the raw
 * text and the parsed JSON of one data file) can't hand each other the wrong
 * value type. Entries for missing files are not kept — a stat miss is cheap
 * and the file may appear.
 *
 * Returns undefined when the file is missing, unreadable, or `parse` throws —
 * the lenient shape every consumer here wants on a keystroke/hover path.
 */
function makeCachedReader<T>(parse: (text: string) => T): (absPath: string) => T | undefined {
  const cache = new Map<string, { mtimeMs: number; value: T }>();
  return (absPath) => {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(absPath).mtimeMs;
    } catch {
      cache.delete(absPath);
      return undefined;
    }
    const cached = cache.get(absPath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.value;
    let value: T;
    try {
      value = parse(fs.readFileSync(absPath, 'utf8'));
    } catch {
      return undefined;
    }
    cache.set(absPath, { mtimeMs, value });
    return value;
  };
}

/** Raw text of a file, or undefined when it doesn't exist / can't be read. */
export const readTextCached = makeCachedReader((text) => text);

/** Parsed JSON of a file; undefined for missing files AND malformed JSON —
 *  pair with `readTextCached` to tell the two apart. */
export const readJsonCached = makeCachedReader<unknown>(JSON.parse);

const readEnvCached = makeCachedReader(parseServerEnv);

/** `.env`-format file → map under the server's grammar; a missing file reads
 *  as empty (a malformed LINE can't blank the map — the server skips it). */
export function readEnvLenient(absPath: string): Record<string, string> {
  return readEnvCached(absPath) ?? {};
}

/**
 * Base `.env` + `.env.<name>` overlay composed, overlay winning — the same
 * relationship `composeEnv` establishes on the run paths.
 *
 * A null overlay (no env selected) leaves the base file standing alone. Note
 * that is NOT what a run with no env composes: `resolveEnvBundle` gates the
 * whole bundle on `if (envName)` and reads neither project file, so a run
 * interpolates no `${env.X}` at all. Both `${...}` editor features refuse
 * outright with no env for exactly that reason, so this base-only map is only
 * ever consumed by the `{{}}` half, where it previews what a `$VAR` parameter
 * would resolve to.
 */
export function composedEnv(baseEnvPath: string, overlayPath: string | null): Record<string, string> {
  return {
    ...readEnvLenient(baseEnvPath),
    ...(overlayPath === null ? {} : readEnvLenient(overlayPath)),
  };
}

/** JSON data file → `$VAR`-resolved tree; missing / bad JSON / non-object
 *  top level all read as "no tree" (undefined → no suggestions). The raw
 *  parse is cached by mtime; `$VAR` resolution runs per call because it
 *  depends on the composed env, and the trees are small. */
export function readDataJson(absPath: string, env: Record<string, string>): DataObject | undefined {
  const parsed = readJsonCached(absPath);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  return resolveDataTree(parsed as DataObject, env) as DataObject;
}

/**
 * A declared dataSources path → absolute, the way the parser resolves it:
 * `~` expanded, relative against the declaring file's directory. Skill paths
 * first interpolate `${env.X}` / `${envName}` (test paths are literal); a
 * placeholder that can't resolve makes the source unavailable (null).
 */
export function resolveSourcePath(
  declared: string,
  declaringFile: string,
  isSkill: boolean,
  env: Record<string, string>,
  envName: string,
): string | null {
  let p = declared;
  if (isSkill) {
    let failed = false;
    p = p
      .replace(/\$\{\s*envName\s*\}/g, () => envName)
      .replace(/\$\{\s*env\.([A-Za-z0-9_]+)\s*\}/g, (_m, name: string) => {
        const v = env[name];
        if (v === undefined) failed = true;
        return v ?? '';
      });
    if (failed) return null;
  }
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  return path.isAbsolute(p) ? p : path.resolve(path.dirname(declaringFile), p);
}

/** Project-relative display form of an absolute path (forward slashes),
 *  falling back to the absolute path outside the root. */
export function displayPath(absPath: string, projectRoot: string): string {
  const rel = path.relative(projectRoot, absPath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return absPath;
  return rel.replace(/\\/g, '/');
}

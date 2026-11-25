// @ts-check
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * @typedef {Object} ProjectDirs
 * @property {string} configPath  Absolute path to the config file these dirs came from.
 * @property {string | null} macrosDir  Absolute path to the macros directory. From {@link parseProjectDirs}: null if undeclared. From {@link readProjectDirs}: the default `./macros` when undeclared and that folder exists, else null.
 * @property {string | null} toolsDir   Absolute path to the tools directory. Same rule as `macrosDir`, with the default `./tools/src`.
 * @property {string | null} dataDir    Raw `tests.dataDir` string (relative to the config dir, or absolute), or null if undeclared. The caller applies the `data` default.
 * @property {string | null} testsDir   Absolute path to `tests.dir`, or null if undeclared.
 */

/**
 * Default data directory when `tests.dataDir` is undeclared — the loader's
 * default (src/config/defaults.ts). `ProjectDirs.dataDir` is null in that
 * case and every caller applies this; exported so the EnvSelector's env
 * discovery and the `${data.*}` completion can never disagree about it.
 */
export const DEFAULT_DATA_DIR = 'data';

/**
 * Default macros and tools directories when `tests.macrosDir` /
 * `tests.toolsDir` are undeclared — the loader's defaults
 * (src/config/defaults.ts), which the CLI and MCP apply too
 * (`resolveProjectDir`, src/mcp/project.ts). Pinned to that file by
 * tests/steptix-config-parse.test.js.
 */
export const DEFAULT_MACROS_DIR = './macros';
export const DEFAULT_TOOLS_DIR = './tools/src';

/**
 * `dirs` with each undeclared macros/tools directory replaced by its default
 * beside the config, when that folder exists (docs/specs/SPEC-macros.md §6).
 * A declared directory is kept as written, existing or not, so a wrong path
 * still fails loudly at the call that uses it.
 *
 * Asked on every read rather than cached with the parse: a `macros/` folder
 * created after the config was first read must be found without a config
 * edit. Returns `dirs` itself when nothing was defaulted, so the parse cache's
 * object identity holds for a project that declares both.
 *
 * @param {ProjectDirs} dirs
 * @returns {ProjectDirs}
 */
export function withDefaultDirs(dirs) {
  const configDir = path.dirname(dirs.configPath);
  /** @param {string | null} declared @param {string} fallback */
  const pick = (declared, fallback) => {
    if (declared !== null) return declared;
    const candidate = path.resolve(configDir, fallback);
    return fs.existsSync(candidate) ? candidate : null;
  };
  const macrosDir = pick(dirs.macrosDir, DEFAULT_MACROS_DIR);
  const toolsDir = pick(dirs.toolsDir, DEFAULT_TOOLS_DIR);
  if (macrosDir === dirs.macrosDir && toolsDir === dirs.toolsDir) return dirs;
  return { ...dirs, macrosDir, toolsDir };
}

/**
 * Resolve a declared directory value against `configDir`. Returns an absolute
 * path for a non-empty string, otherwise null (missing / non-string / empty).
 *
 * @param {unknown} value
 * @param {string} configDir
 * @returns {string | null}
 */
export function resolveDir(value, configDir) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return path.resolve(configDir, value);
}

/**
 * Parse a `steptix.config.json` text and pull the canonical `tests.macrosDir`
 * and `tests.toolsDir` out of it, resolving each against `configDir`.
 *
 * The config is plain JSON, so this runs a real `JSON.parse`. A malformed
 * file is treated as "no config found" (returns null) with a console warning
 * rather than a thrown exception, so F12 / run never break on a bad config.
 *
 * @param {string} text  Raw config file contents.
 * @param {string} configPath  Absolute path to the config file (used for the dir + warning).
 * @returns {ProjectDirs | null}
 */
export function parseProjectDirs(text, configPath) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.warn(
      `Steptix: failed to parse ${configPath} as JSON — treating as no config. ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  const configDir = path.dirname(configPath);
  const rawDataDir = parsed?.tests?.dataDir;
  return {
    configPath,
    macrosDir: resolveDir(parsed?.tests?.macrosDir, configDir),
    toolsDir: resolveDir(parsed?.tests?.toolsDir, configDir),
    // Where the project's tests live — Record New Test creates its file here
    // (stories/steptix-record-steps.md).
    testsDir: resolveDir(parsed?.tests?.dir, configDir),
    dataDir: typeof rawDataDir === 'string' && rawDataDir.trim() !== '' ? rawDataDir.trim() : null,
  };
}

/** Cache keyed by config path → { mtimeMs, dirs }. Avoids re-reading the
 *  config file on every F12. Invalidated when the file's mtime changes.
 *  @type {Map<string, { mtimeMs: number; dirs: ProjectDirs }>} */
const cache = new Map();

/**
 * Read + parse the config file at `configPath`, with an mtime cache, then
 * apply the default macros/tools directories ({@link withDefaultDirs}). The
 * parse is cached; the defaults are not, since they depend on folders that can
 * appear later. Returns the same cached `ProjectDirs` object on a second call
 * while the file's mtime is unchanged and no default was applied. Returns null
 * if the file can't be stat'd / read, or doesn't parse as JSON. Pure (no
 * vscode dependency) so it can be unit-tested directly.
 *
 * @param {string} configPath  Absolute path to a `steptix.config.json`.
 * @returns {ProjectDirs | null}
 */
export function readProjectDirs(configPath) {
  const dirs = readDeclaredDirs(configPath);
  return dirs ? withDefaultDirs(dirs) : null;
}

/**
 * The config's declared directories, mtime-cached.
 *
 * @param {string} configPath
 * @returns {ProjectDirs | null}
 */
function readDeclaredDirs(configPath) {
  /** @type {import('node:fs').Stats} */
  let stat;
  try {
    stat = fs.statSync(configPath);
  } catch {
    return null;
  }

  const cached = cache.get(configPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.dirs;

  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch {
    return null;
  }

  const dirs = parseProjectDirs(text, configPath);
  if (!dirs) return null;
  cache.set(configPath, { mtimeMs: stat.mtimeMs, dirs });
  return dirs;
}

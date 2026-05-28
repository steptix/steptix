// @ts-check
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * @typedef {Object} ProjectDirs
 * @property {string} configPath  Absolute path to the config file these dirs came from.
 * @property {string | null} skillsDir  Absolute path to the skills directory, or null if undeclared.
 * @property {string | null} toolsDir   Absolute path to the tools directory, or null if undeclared.
 * @property {string | null} dataDir    Raw `tests.dataDir` string (relative to the config dir, or absolute), or null if undeclared. The caller applies the `data` default.
 * @property {boolean} cacheEnabled  Whether the step cache is opted in via `cache.enabled === true`. Defaults false (absent / non-boolean / false → off).
 */

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
 * Parse an `aiui.config.json` text and pull the canonical `tests.skillsDir`
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
      `TestBench: failed to parse ${configPath} as JSON — treating as no config. ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  const configDir = path.dirname(configPath);
  const rawDataDir = parsed?.tests?.dataDir;
  return {
    configPath,
    skillsDir: resolveDir(parsed?.tests?.skillsDir, configDir),
    toolsDir: resolveDir(parsed?.tests?.toolsDir, configDir),
    dataDir: typeof rawDataDir === 'string' && rawDataDir.trim() !== '' ? rawDataDir.trim() : null,
    // Opt-in: only an explicit `cache.enabled: true` turns the step cache on.
    // Absent config, a missing `cache` block, or any non-`true` value → off.
    cacheEnabled: parsed?.cache?.enabled === true,
  };
}

/** Cache keyed by config path → { mtimeMs, dirs }. Avoids re-reading the
 *  config file on every F12. Invalidated when the file's mtime changes.
 *  @type {Map<string, { mtimeMs: number; dirs: ProjectDirs }>} */
const cache = new Map();

/**
 * Read + parse the config file at `configPath`, with an mtime cache. Returns
 * the same cached `ProjectDirs` object on a second call while the file's mtime
 * is unchanged. Returns null if the file can't be stat'd / read, or doesn't
 * parse as JSON. Pure (no vscode dependency) so it can be unit-tested directly.
 *
 * @param {string} configPath  Absolute path to an `aiui.config.json`.
 * @returns {ProjectDirs | null}
 */
export function readProjectDirs(configPath) {
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

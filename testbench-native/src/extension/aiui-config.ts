import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Resolved project directories pulled from an `aiui.config.*` file.
 * Paths are absolute. Either field may be null if the config file
 * didn't declare it.
 */
export interface ProjectDirs {
  /** Absolute path to the config file these dirs came from. */
  configPath: string;
  /** Absolute path to the skills directory, or null if undeclared. */
  skillsDir: string | null;
  /** Absolute path to the tools directory, or null if undeclared. */
  toolsDir: string | null;
}

const CONFIG_FILENAMES = ['aiui.config.ts', 'aiui.config.js', 'aiui.config.mjs'];

/** Cache keyed by config path → { mtimeMs, dirs }. Avoids re-reading the
 *  config file on every F12. Invalidated when the file's mtime changes. */
const cache = new Map<string, { mtimeMs: number; dirs: ProjectDirs }>();

/**
 * Walk up from the directory containing `fileUri` looking for an
 * `aiui.config.*` file. Returns the parsed skills/tools directories, or
 * null if no config file is found before hitting the filesystem root.
 */
export function resolveProjectDirs(fileUri: vscode.Uri): ProjectDirs | null {
  const configPath = findConfigFile(fileUri.fsPath);
  if (!configPath) return null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(configPath);
  } catch {
    return null;
  }

  const cached = cache.get(configPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.dirs;

  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch {
    return null;
  }

  const configDir = path.dirname(configPath);
  const dirs: ProjectDirs = {
    configPath,
    skillsDir: resolveDeclared(text, 'skillsDir', configDir),
    toolsDir: resolveDeclared(text, 'toolsDir', configDir),
  };
  cache.set(configPath, { mtimeMs: stat.mtimeMs, dirs });
  return dirs;
}

/** Walk up the directory tree from `startPath` (a file) to the root. */
function findConfigFile(startPath: string): string | null {
  let dir = path.dirname(startPath);
  while (true) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Pull a `key: 'value'` string literal out of the config source and resolve
 * it against `configDir`. Deliberately a regex rather than executing the
 * module — the config is TypeScript and importing it from the extension
 * host would mean compiling it. The common case (`skillsDir: './skills'`)
 * is a plain string literal, which this matches.
 */
function resolveDeclared(text: string, key: string, configDir: string): string | null {
  const re = new RegExp(`\\b${key}\\s*:\\s*(['"\`])([^'"\`]+)\\1`);
  const m = re.exec(text);
  if (!m || !m[2]) return null;
  return path.resolve(configDir, m[2]);
}

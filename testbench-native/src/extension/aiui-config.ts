import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { readProjectDirs } from './aiui-config-parse.js';

/**
 * Resolved project directories pulled from an `aiui.config.json` file.
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
  /**
   * Whether the step cache is opted in via `cache.enabled === true` in the
   * config. Defaults false — absent config, a missing `cache` block, or any
   * non-`true` value leaves the cache off (the run sends no `cacheEnabled`).
   */
  cacheEnabled: boolean;
}

const CONFIG_FILENAMES = ['aiui.config.json'];

/**
 * Walk up from the directory containing `fileUri` looking for an
 * `aiui.config.json` file. Returns the skills/tools directories parsed out of
 * it, or null if no config file is found before hitting the filesystem root
 * (or if the file can't be read / parsed as JSON).
 *
 * Thin vscode wrapper: the actual JSON parse + `tests.skillsDir`/`tests.toolsDir`
 * resolution + mtime cache live in the pure `aiui-config-parse.js` helper so
 * they can be unit-tested without a vscode mock.
 */
export function resolveProjectDirs(fileUri: vscode.Uri): ProjectDirs | null {
  const configPath = findConfigFile(fileUri.fsPath);
  if (!configPath) return null;
  return readProjectDirs(configPath) as ProjectDirs | null;
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

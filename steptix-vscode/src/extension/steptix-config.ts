import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { readProjectDirs } from './steptix-config-parse.js';

/**
 * Resolved project directories pulled from a `steptix.config.json` file.
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
  /** Raw `tests.dataDir` string (relative to the config dir, or absolute), or
   *  null if undeclared. The caller applies the `data` default. */
  dataDir: string | null;
  /** Absolute path to `tests.dir`, or null if undeclared — where Record New
   *  Test creates its file (stories/steptix-record-steps.md). */
  testsDir: string | null;
}

const CONFIG_FILENAMES = ['steptix.config.json'];

/**
 * Walk up from the directory containing `fileUri` looking for a
 * `steptix.config.json` file. Returns the skills/tools directories parsed out of
 * it, or null if no config file is found before hitting the filesystem root
 * (or if the file can't be read / parsed as JSON).
 *
 * Thin vscode wrapper: the actual JSON parse + `tests.skillsDir`/`tests.toolsDir`
 * resolution + mtime cache live in the pure `steptix-config-parse.js` helper so
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

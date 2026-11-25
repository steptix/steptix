import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { readProjectDirs } from './steptix-config-parse.js';

/**
 * Resolved project directories pulled from a `steptix.config.json` file.
 * Paths are absolute. A directory field is null when the config file does
 * not declare it and, for macros and tools, has no default folder beside it
 * (`withDefaultDirs`, docs/specs/SPEC-macros.md §6).
 */
export interface ProjectDirs {
  /** Absolute path to the config file these dirs came from. */
  configPath: string;
  /** Absolute path to the macros directory: declared, else `./macros` beside
   *  the config when it exists, else null. */
  macrosDir: string | null;
  /** Absolute path to the tools directory: declared, else `./tools/src`
   *  beside the config when it exists, else null. */
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
 * `steptix.config.json` file. Returns the macros/tools directories parsed out of
 * it, or null if no config file is found before hitting the filesystem root
 * (or if the file can't be read / parsed as JSON).
 *
 * Thin vscode wrapper: the actual JSON parse + `tests.macrosDir`/`tests.toolsDir`
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

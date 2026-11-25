/**
 * The run's workspace and the folders an agent may touch
 * (docs/specs/SPEC-use-agent.md §6.2).
 *
 * Each run gets an empty folder, `.steptix/agent/<run id>/` under the project,
 * shared by every agent step in the run. `read_file`, `write_file` and
 * `list_dir` reach it and the folders in `agent.folders`, and nothing else;
 * the skills folder is readable too (§7), never writable.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface AgentWorkspace {
  /** Absolute path of the run's folder. */
  dir: string;
  /** The project root the run resolves `agent.folders` against. */
  projectRoot: string;
  /** Absolute paths of `agent.folders`, read and write. */
  folders: string[];
  /** Absolute path of the skills folder, read only, when it exists. */
  skillsDir?: string;
}

/** The workspace folder for a run, created empty. */
export function createWorkspace(args: {
  projectRoot: string;
  runId: string;
  folders: readonly string[];
  skillsDir?: string | undefined;
}): AgentWorkspace {
  const safeId = args.runId.replace(/[^A-Za-z0-9._-]/g, '_');
  const dir = path.join(args.projectRoot, '.steptix', 'agent', safeId);
  fs.mkdirSync(dir, { recursive: true });
  const folders = args.folders.map((f) => path.resolve(args.projectRoot, f));
  for (const folder of folders) fs.mkdirSync(folder, { recursive: true });
  return {
    dir,
    projectRoot: args.projectRoot,
    folders,
    ...(args.skillsDir !== undefined && { skillsDir: path.resolve(args.projectRoot, args.skillsDir) }),
  };
}

/** Remove the workspace folder. Never throws: a run must not fail at its end
 *  because a script still holds a file open. */
export function removeWorkspace(ws: AgentWorkspace): void {
  try {
    fs.rmSync(ws.dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // left behind; harmless
  }
}

/** True when `child` is `parent` or inside it. */
function within(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The real path of `p`, or of its nearest existing parent with the rest
 *  appended, so a symlink inside the workspace cannot point outside it. */
function realish(p: string): string {
  let current = p;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return rest.length === 0 ? real : path.join(real, ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return p;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/** An installer's bin folder, relative to a root: `.venv/Scripts`,
 *  `venv/bin`, `node_modules/.bin` — anywhere under it. */
const INSTALLED_BIN_DIR_RE = /(?:^|[\\/])(?:\.?venv[\\/](?:Scripts|bin)|node_modules[\\/]\.bin)(?:[\\/]|$)/i;

export type PathCheck =
  | { ok: true; absolute: string; where: string }
  | { ok: false; reason: string };

/**
 * Where a path an action names resolves, and whether the agent may use it
 * there. A relative path resolves against the workspace. `write` refuses the
 * skills folder, which is read only.
 */
export function resolveAgentPath(ws: AgentWorkspace, requested: string, mode: 'read' | 'write'): PathCheck {
  if (typeof requested !== 'string' || requested.trim() === '') {
    return { ok: false, reason: 'no path was given' };
  }
  const absolute = path.resolve(ws.dir, requested.trim());
  const real = realish(absolute);
  const roots: { root: string; where: string; writable: boolean }[] = [
    { root: ws.dir, where: 'workspace', writable: true },
    ...ws.folders.map((f) => ({
      root: f,
      where: path.relative(ws.projectRoot, f).split(path.sep).join('/') || f,
      writable: true,
    })),
    ...(ws.skillsDir !== undefined ? [{ root: ws.skillsDir, where: 'skills', writable: false }] : []),
  ];
  for (const r of roots) {
    const realRoot = realish(r.root);
    if (within(r.root, absolute) && within(realRoot, real)) {
      // A program in a virtual environment's or `node_modules`' bin folder is
      // the program it is named after to the allow list (`programName`), so
      // the agent may not put one there itself: `.venv/Scripts/git.cmd` would
      // pass as `git`. Installers write those folders; `write_file` does not.
      if (mode === 'write' && INSTALLED_BIN_DIR_RE.test(path.relative(r.root, absolute))) {
        return { ok: false, reason: `${requested} is in an installer's bin folder, which only an installer may write` };
      }
      if (mode === 'write' && !r.writable) {
        return { ok: false, reason: `${requested} is in the skills folder, which the agent may read but not change` };
      }
      return { ok: true, absolute, where: r.where };
    }
  }
  return {
    ok: false,
    reason: `${requested} is outside the workspace and the folders in agent.folders`,
  };
}

/** Folders a listing and the report's file copies skip: installed packages,
 *  which would dwarf the rest (§8.5). */
export const SKIPPED_DIRS = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.git']);

/** Every file under `root`, skipping {@link SKIPPED_DIRS}, as absolute path →
 *  `size:mtime`. Bounded, so a huge folder costs a capped walk. */
export function fileStates(root: string, limit = 5000): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    if (out.size >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.size >= limit) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIPPED_DIRS.has(e.name)) walk(full);
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(full);
          out.set(full, `${st.size}:${st.mtimeMs}`);
        } catch {
          // vanished mid-walk
        }
      }
    }
  };
  walk(root);
  return out;
}

/** The writable roots of a workspace, for change tracking. */
export function writableRoots(ws: AgentWorkspace): string[] {
  return [ws.dir, ...ws.folders];
}

/** An allowed folder's name as the report shows it: relative to the project
 *  when inside it, else its own name — never a `..` path, which would let a
 *  copy named after it climb out of the folder it is staged in. */
function folderLabel(ws: AgentWorkspace, folder: string): string {
  const rel = path.relative(ws.projectRoot, folder);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : path.basename(folder);
}

/** Which root a file belongs to, for the report's "where" column. */
export function whereOf(ws: AgentWorkspace, file: string): string {
  if (within(ws.dir, file)) return 'workspace';
  for (const f of ws.folders) {
    if (within(f, file)) return folderLabel(ws, f);
  }
  return path.basename(path.dirname(file));
}

/** A file's path as the report shows it: relative to the workspace, or the
 *  allowed folder's label and the path inside it. Never starts with `..`. */
export function displayPath(ws: AgentWorkspace, file: string): string {
  if (within(ws.dir, file)) return path.relative(ws.dir, file).split(path.sep).join('/');
  for (const f of ws.folders) {
    if (within(f, file)) return [folderLabel(ws, f), path.relative(f, file).split(path.sep).join('/')].filter(Boolean).join('/');
  }
  return path.basename(file);
}

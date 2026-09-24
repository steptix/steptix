import fs from 'node:fs/promises';
import path from 'node:path';
import { userRootDir } from '../env/user-root.js';

/** File names that identify a project root when walking up from a test file. */
const PROJECT_MARKERS = ['aiui.config.json'];

/**
 * win32 path comparison folds case; every other platform does not.
 *
 * Exported because the upload-path fence (stories/upload-action.md §3) has to
 * compare a resolved file against a project root the SAME way this walk found
 * it. Deliberately lexical — no `realpath` — so a junctioned worktree's files
 * compare as in-tree rather than resolving out to the checkout they point at.
 */
export function comparable(target: string): string {
  return process.platform === 'win32' ? path.resolve(target).toLowerCase() : path.resolve(target);
}

/**
 * Walk up from `testFilePath` looking for a project marker. Returns the
 * absolute path of the first directory containing one, or `null` if the
 * walk hits the filesystem root without finding one.
 *
 * Used to anchor per-project resolution — config, env/data, the upload
 * fence — against the test's project, NOT against the server's CWD, which may
 * be elsewhere (testbench-native embeds the server and launches it from the
 * user's workspace, but third-party callers may invoke it from anywhere).
 *
 * **The machine-wide user root is a boundary** (stories/mcp-no-project.md):
 * when the walk reaches it, it is returned whether or not a marker is there.
 * The user root is a real root — project-less MCP runs anchor their synthetic
 * test path inside it — and its `aiui.config.json` legitimately may not exist,
 * since nothing machine-writes it. Without the boundary the walk would carry
 * on into `%LOCALAPPDATA%` and the home directory, and a stray config file
 * anywhere up there would silently become the "project" whose `.env` and
 * report directory a project-less run uses.
 *
 * Falls back to `null` rather than throwing, so a caller can decide what a
 * project-less request means rather than guessing at a phantom root next to
 * the server process.
 */
export async function resolveProjectRoot(testFilePath: string): Promise<string | null> {
  const userRoot = comparable(userRootDir());
  let dir = path.dirname(path.resolve(testFilePath));
  // 50 levels is far more than any realistic depth; the guard is defensive
  // against symlink loops or pathological inputs that defeat the parent
  // check below.
  for (let i = 0; i < 50; i++) {
    for (const marker of PROJECT_MARKERS) {
      try {
        await fs.access(path.join(dir, marker));
        return dir;
      } catch {
        // marker not at this level — keep walking
      }
    }
    if (comparable(dir) === userRoot) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // hit filesystem root
    dir = parent;
  }
  return null;
}

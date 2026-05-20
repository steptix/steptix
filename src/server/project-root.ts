import fs from 'node:fs/promises';
import path from 'node:path';

/** File names that identify a project root when walking up from a test file. */
const PROJECT_MARKERS = ['aiui.config.json'];

/**
 * Walk up from `testFilePath` looking for a project marker. Returns the
 * absolute path of the first directory containing one, or `null` if the
 * walk hits the filesystem root without finding one.
 *
 * Used by the server-side StepCache wiring to anchor `<project-root>/.cache`
 * against the test's project — NOT against the server's CWD, which may be
 * elsewhere (testbench-native embeds the server and launches it from the
 * user's workspace, but third-party callers may invoke it from anywhere).
 *
 * Falls back to `null` rather than throwing. Callers should disable the
 * cache for that request with a one-time log warning rather than writing
 * to a phantom `.cache` next to the server process.
 */
export async function resolveProjectRoot(testFilePath: string): Promise<string | null> {
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
    const parent = path.dirname(dir);
    if (parent === dir) return null; // hit filesystem root
    dir = parent;
  }
  return null;
}

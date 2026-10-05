/**
 * A scratch directory for one run of a code-behind suite.
 *
 * In the repo, under `tests/`, because a `.steps.ts` imports
 * `steptix/codebehind` and that resolves by package self-reference — walking
 * up from the file to this repo's `package.json`. `os.tmpdir()` has no such
 * ancestor.
 *
 * Fresh every run (`mkdtemp`). These suites used a fixed name and a `t0…tN`
 * counter that restarts at 0, cleaned only in `afterAll`: a run that was killed,
 * or whose teardown lost to a Windows lock, left `t0/booking.steps.ts` and its
 * last-run sidecar behind, and the next run read them as input — the compile
 * found every step already had code and failed the same way until someone
 * deleted the folder. Two runs in one checkout at once (a `--watch` beside a
 * full run) also deleted each other's files.
 *
 * Pins the house Prettier style with a `.prettierrc` at its root.
 * `formatCodeBehindSource` lets a project's own config win, found upward from
 * the file the way Prettier finds it, and this repo has none — so a config in
 * any folder above the checkout (a home directory, a CI workspace) would
 * restyle every file a compile writes, and the `source: '…'` asserts would
 * fail on that machine alone. The search stops at the first config, this one.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The house style: the defaults `formatCodeBehindSource` (src/codebehind/writer.ts) starts from. */
const HOUSE_PRETTIER = { singleQuote: true, printWidth: 100, trailingComma: 'all' };

/** Make `tests/.tmp-<name>-XXXXXX/` with the house `.prettierrc` in it. */
export async function makeScratchBase(name: string): Promise<string> {
  const base = await fs.mkdtemp(path.join(repoRoot, 'tests', `.tmp-${name}-`));
  await fs.writeFile(path.join(base, '.prettierrc'), JSON.stringify(HOUSE_PRETTIER), 'utf-8');
  return base;
}

/** Remove it, riding out the brief lock Windows can hold on a file just written. */
export async function removeScratchBase(base: string | undefined): Promise<void> {
  if (base) await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

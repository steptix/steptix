/**
 * Which rules, and which build, a line was written under (§5.5) — so a change
 * to the step prompt can be judged by the lines on either side of it
 * (`aiui stats --by prompt`).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSystemPrompt, contentBlocksToText, type SystemPromptOptions } from '../ai/prompts.js';
import { getPackageVersion } from '../utils/version.js';

const fingerprints = new Map<string, string>();

/**
 * `p-` and the first 6 hex digits of the SHA-256 of the step prompt's RULES:
 * `buildSystemPrompt('')` under the run's own options.
 *
 * The first argument is where a project's context files go, so leaving it
 * empty is what makes the fingerprint change exactly when the framework's
 * rules change, and lets two projects on the same rules share one. The rules
 * text is built to be byte-identical on every call (providers cache it,
 * src/ai/prompts.ts), so it is computed once per process and option set.
 */
export function rulesFingerprint(opts: SystemPromptOptions = {}): string {
  const key = optionKey(opts);
  const known = fingerprints.get(key);
  if (known !== undefined) return known;
  const rules = contentBlocksToText(buildSystemPrompt('', undefined, opts));
  const fingerprint = `p-${crypto.createHash('sha256').update(rules).digest('hex').slice(0, 6)}`;
  fingerprints.set(key, fingerprint);
  return fingerprint;
}

/** The option set as a cache key: the options that are set, in name order —
 *  so an option added to `SystemPromptOptions` later is keyed without this
 *  file changing. `{}` and `{ dismissalGuidance: false }` key apart and hash
 *  alike, which costs one extra entry and nothing else. */
function optionKey(opts: SystemPromptOptions): string {
  const set = Object.entries(opts).filter(([, value]) => value !== undefined);
  set.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(set);
}

/**
 * The framework's root. `src/stats/` and `dist/stats/` both sit two levels
 * under it — the same walk `getPackageVersion` makes from `src/utils/`.
 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let version: { value: string | undefined } | undefined;

/**
 * The package version, plus `+<short commit>` when the framework runs from a
 * git checkout: `1.0.0+b700473`. Read once per process.
 *
 * `undefined` when the version is unknown — absent, never guessed (§5.5). An
 * npm install has no checkout and reports the version alone.
 */
export function frameworkVersion(): string | undefined {
  if (version === undefined) {
    const pkg = getPackageVersion();
    const known = pkg === 'unknown' ? undefined : pkg;
    const commit = known === undefined ? undefined : gitCommitAt(PACKAGE_ROOT);
    version = { value: known !== undefined && commit !== undefined ? `${known}+${commit}` : known };
  }
  return version.value;
}

/** A full object name: SHA-1, or SHA-256 in a repository that uses it. */
const OBJECT_NAME = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * The first 7 hex digits of the commit checked out at `root`, read from
 * `<root>/.git` without spawning git; `undefined` when there is no checkout or
 * it cannot be read. Never throws.
 *
 * Only `root` itself is asked, never a parent: an npm install inside someone
 * else's repository must not report THEIR commit as the framework's.
 *
 * Handles a worktree, where `.git` is a FILE (`gitdir: <path>`) and the
 * gitdir it names keeps its own `HEAD` but shares branches through
 * `commondir`; a detached `HEAD`; and a branch that lives only in
 * `packed-refs`. Uncommitted changes are not reflected — the commit is the one
 * checked out, not the tree on disk.
 */
export function gitCommitAt(root: string): string | undefined {
  try {
    const gitDir = gitDirOf(root);
    if (gitDir === undefined) return undefined;
    const sha = resolveRef(gitDir, 'HEAD', 0);
    return sha !== undefined && OBJECT_NAME.test(sha) ? sha.slice(0, 7) : undefined;
  } catch {
    return undefined;
  }
}

function gitDirOf(root: string): string | undefined {
  const dotGit = path.join(root, '.git');
  const stat = fs.statSync(dotGit, { throwIfNoEntry: false });
  if (stat === undefined) return undefined;
  if (stat.isDirectory()) return dotGit;
  // Relative in a submodule (`gitdir: ../.git/modules/x`), absolute in a
  // worktree; either way relative to the folder holding the file.
  const named = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf-8'));
  return named ? path.resolve(root, named[1]!) : undefined;
}

/** A worktree's gitdir names the repository's shared one in `commondir`
 *  (usually `../..`); an ordinary gitdir has no such file and is its own. */
function commonDirOf(gitDir: string): string {
  const common = readTrimmed(path.join(gitDir, 'commondir'));
  return common === undefined || common === '' ? gitDir : path.resolve(gitDir, common);
}

/** `HEAD`, or a ref it points at, as an object name. Follows a symbolic ref a
 *  few levels, which is more than git itself ever writes. */
function resolveRef(gitDir: string, ref: string, depth: number): string | undefined {
  if (depth > 4) return undefined;
  const common = commonDirOf(gitDir);
  // HEAD (and refs under `refs/worktree/`) are per worktree; branches are
  // shared. HEAD comes from the worktree's own gitdir only — the shared one
  // holds the MAIN checkout's HEAD — and a ref from there first, then the
  // shared one.
  const dirs = ref === 'HEAD' || common === gitDir ? [gitDir] : [gitDir, common];
  for (const dir of dirs) {
    const loose = readTrimmed(path.join(dir, ref));
    if (loose === undefined) continue;
    return loose.startsWith('ref:') ? resolveRef(gitDir, loose.slice(4).trim(), depth + 1) : loose;
  }
  return packedRef(common, ref);
}

/** A ref from `packed-refs`, where `git gc` moves branches nobody has touched
 *  since. Lines are `<sha> <ref>`; `#` headers and `^<sha>` peel lines are
 *  skipped by the shape. */
function packedRef(commonDir: string, ref: string): string | undefined {
  const packed = readTrimmed(path.join(commonDir, 'packed-refs'));
  if (packed === undefined) return undefined;
  for (const line of packed.split('\n')) {
    const entry = /^([0-9a-f]{40,64}) (.+?)\s*$/.exec(line);
    if (entry && entry[2] === ref) return entry[1];
  }
  return undefined;
}

function readTrimmed(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf-8').trim();
  } catch {
    return undefined;
  }
}

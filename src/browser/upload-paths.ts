/**
 * Where a file named in a test step actually lives.
 *
 * A step writes `Upload file \attachments\logo.png`. That path is relative to
 * the folder of the TEST FILE being run (stories/upload-action.md, decision 4)
 * — not the server's working directory, which is where Playwright would
 * otherwise resolve it, and not the project root. The rule makes a test
 * portable: move the `.md` with its `attachments/` folder, or zip it and send
 * it to someone else, and the same step still finds the same file.
 *
 * This module is pure — no Playwright, no AI types — so the executor, the
 * parser, the step cache and code-behind's `step.filePath` can all share one
 * definition of "what does this path mean".
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparable } from '../server/project-root.js';

/** The action fields a path can arrive in. Structural, so this module needs no
 *  dependency on `AIAction`. */
export interface UploadPathFields {
  filePath?: string | undefined;
  filePaths?: string[] | undefined;
}

/**
 * Read an upload action's paths as one shape. `filePaths` wins when both are
 * present — the parser drops the loser, but replaying a cache entry written by
 * an older build could still hand us both.
 */
export function uploadPathsOf(action: UploadPathFields): string[] {
  if (action.filePaths !== undefined && action.filePaths.length > 0) return action.filePaths;
  if (action.filePath !== undefined && action.filePath !== '') return [action.filePath];
  return [];
}

export interface UploadPathContext {
  /** Folder of the test file being run. Undefined when the run has no test
   *  file — Flick never sends one, and the Sessions API's `testFilePath` is
   *  optional — in which case only absolute paths can resolve. */
  baseDir?: string | undefined;
  /** Folder holding `aiui.config.json`; `null` when the walk found none. The
   *  fence falls back to `baseDir`, and with neither there is no fence. */
  projectRoot?: string | null | undefined;
}

export type UploadPathResult =
  | { ok: true; absolute: string[] }
  /** `retryable: false` is load-bearing where it appears: no amount of
   *  re-planning makes a missing file appear, so the step must fail without
   *  spending its retries (stories/upload-action.md §5). It is ABSENT for a
   *  malformed action — a model that put the path in the wrong field can fix
   *  that on its next turn, which is exactly what a retry is for. */
  | { ok: false; error: string; retryable?: false };

/** `C:/…` or `D:/…` — a Windows drive-letter path, after separator folding. */
const DRIVE_LETTER = /^[A-Za-z]:\//;

/**
 * The form a path takes inside an action: forward slashes, no leading
 * separator, trimmed.
 *
 * Runs in three places, and has to, because each sees a path the others do not:
 * the parser (what the model emitted), the executor (what a `{{param}}`
 * interpolated to, which the parser never saw) and `step.filePath` (what
 * compiled code passed in).
 *
 * A leading separator is stripped, so the `\attachments\logo.png` spelling a
 * Windows author naturally writes means "relative to the test file". The
 * consequence, accepted deliberately: a genuine POSIX absolute path
 * (`/srv/files/x.png`) is indistinguishable from that spelling and is treated
 * as relative too. Absolute paths that survive as absolute are drive-letter,
 * UNC (`//server/share`) and `file://` URLs. The E3 message names the path it
 * actually tried, so the mistake is visible rather than mysterious.
 */
export function normaliseUploadPath(raw: string): string {
  const trimmed = raw.trim();
  // A URL is not a path. Leave every `scheme://…` alone — including the
  // `file://` form we do accept, and `https://…`, which is not an upload source
  // but IS a common parameter value: collapsing its `//` would corrupt it, and
  // this function is also used to widen the code-behind leak guard over every
  // guarded value, not only over paths.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) return trimmed;

  const slashed = trimmed.replace(/\\/g, '/');
  if (slashed.startsWith('//') || DRIVE_LETTER.test(slashed)) return slashed;
  // Collapse repeated separators, then drop one leading separator.
  return slashed.replace(/\/{2,}/g, '/').replace(/^\//, '');
}

/** Is this path absolute in a way we must not re-base?
 *
 *  The `path.isAbsolute` arm is unreachable for a normalised path — that is
 *  the point of stripping the leading separator — and is kept as a guard for
 *  any future caller that reaches here without normalising first. */
function isAbsoluteUploadPath(p: string): boolean {
  return p.startsWith('//') || DRIVE_LETTER.test(p) || path.isAbsolute(p);
}

/**
 * Resolve every path an upload action names, or explain the first failure.
 *
 * All paths are resolved before any is judged, so a two-file upload reports the
 * same error whichever file is missing. Every failure about the FILE is
 * non-retryable; a malformed action (no path at all) is not.
 */
export async function resolveUploadPaths(
  paths: string[],
  ctx: UploadPathContext,
): Promise<UploadPathResult> {
  if (paths.length === 0) {
    // Deliberately retryable: the action is malformed, not the world.
    return {
      ok: false,
      error: 'upload action requires "filePath" or "filePaths". Name the file to upload',
    };
  }

  const fail = (error: string): UploadPathResult => ({ ok: false, retryable: false, error });
  const fence = ctx.projectRoot ?? ctx.baseDir;
  const absolute: string[] = [];

  for (const input of paths) {
    const rel = normaliseUploadPath(input);
    let abs: string;
    let wasRelative = false;

    // ── Classify ────────────────────────────────────────────────────────────
    if (/^file:\/\//i.test(rel)) {
      // Node drops a fragment silently, which would name a DIFFERENT file than
      // the one written — refuse rather than upload the wrong thing.
      if (rel.includes('#') || rel.includes('?')) {
        return fail(
          `Upload path "${rel}" is a file URL the server cannot read: `
          + `a "?" or "#" in a file URL is dropped, so it would name a different file. Use a plain path`,
        );
      }
      try {
        abs = fileURLToPath(rel);
      } catch (err) {
        return fail(
          `Upload path "${rel}" is a file URL the server cannot read: `
          + `${err instanceof Error ? err.message : String(err)}. Use a plain path`,
        );
      }
    } else if (isAbsoluteUploadPath(rel)) {
      abs = path.resolve(rel);
    } else {
      wasRelative = true;
      if (ctx.baseDir === undefined) {
        return fail(
          `Upload path "${rel}" is relative but this run has no test file to resolve it against. `
          + `Run the step from a test file, or use an absolute path`,
        );
      }
      abs = path.resolve(ctx.baseDir, rel);
    }

    /** The " (resolved from …)" clause, which only makes sense for a path we re-based. */
    const from =
      wasRelative && ctx.baseDir !== undefined
        ? ` (resolved from "${rel}" against the test file's folder ${ctx.baseDir})`
        : '';

    // ── Fence ───────────────────────────────────────────────────────────────
    // Lexical, and not a security control: `testFilePath` is whatever the
    // client sent, and a client past the API key can already run tools. This
    // catches a test author's mistake — a `..` that walked out of the project
    // — before the server reads a file nobody meant to share.
    if (fence !== undefined && fence !== null) {
      const within = path.relative(comparable(fence), comparable(abs));
      // NOT `startsWith('..')`: a folder legitimately named `..cache` inside
      // the project would then be refused.
      if (path.isAbsolute(within) || within === '..' || within.startsWith(`..${path.sep}`)) {
        return fail(
          `Upload path "${rel}" resolves to ${abs}, outside the project folder ${fence}. `
          + `Keep upload files inside the project`,
        );
      }
    }

    // ── Exists, and is a file ───────────────────────────────────────────────
    try {
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) {
        return fail(
          `Upload path ${abs} is a folder, not a file${from}. Name a file inside it`,
        );
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return fail(
          `Upload file not found: ${abs}${from}. Put the file there or correct the step's path`,
        );
      }
      return fail(
        `Upload file ${abs} cannot be read: ${err instanceof Error ? err.message : String(err)}. `
        + `Check the file's permissions`,
      );
    }

    absolute.push(abs);
  }

  return { ok: true, absolute };
}

/**
 * The synchronous half, for code-behind's `step.filePath` — an entry reads best
 * as one expression, and a `statSync` costs microseconds
 * (stories/upload-action.md, decision after review 1).
 *
 * Throws on failure, with the same text the AI path returns and a
 * `retryable: false` tag so the heal path can tell "your code is broken" from
 * "the file is missing".
 */
export function resolveUploadPathSync(input: string, ctx: UploadPathContext): string {
  const rel = normaliseUploadPath(input);
  const fence = ctx.projectRoot ?? ctx.baseDir;
  let abs: string;
  let wasRelative = false;

  if (/^file:\/\//i.test(rel)) {
    if (rel.includes('#') || rel.includes('?')) {
      throw nonRetryable(
        `Upload path "${rel}" is a file URL the server cannot read: `
        + `a "?" or "#" in a file URL is dropped, so it would name a different file. Use a plain path`,
      );
    }
    try {
      abs = fileURLToPath(rel);
    } catch (err) {
      throw nonRetryable(
        `Upload path "${rel}" is a file URL the server cannot read: `
        + `${err instanceof Error ? err.message : String(err)}. Use a plain path`,
      );
    }
  } else if (isAbsoluteUploadPath(rel)) {
    abs = path.resolve(rel);
  } else {
    wasRelative = true;
    if (ctx.baseDir === undefined) {
      throw nonRetryable(
        `Upload path "${rel}" is relative but this run has no test file to resolve it against. `
        + `Run the step from a test file, or use an absolute path`,
      );
    }
    abs = path.resolve(ctx.baseDir, rel);
  }

  const from =
    wasRelative && ctx.baseDir !== undefined
      ? ` (resolved from "${rel}" against the test file's folder ${ctx.baseDir})`
      : '';

  if (fence !== undefined && fence !== null) {
    const within = path.relative(comparable(fence), comparable(abs));
    if (path.isAbsolute(within) || within === '..' || within.startsWith(`..${path.sep}`)) {
      throw nonRetryable(
        `Upload path "${rel}" resolves to ${abs}, outside the project folder ${fence}. `
        + `Keep upload files inside the project`,
      );
    }
  }

  try {
    if (fsSync.statSync(abs).isDirectory()) {
      throw nonRetryable(`Upload path ${abs} is a folder, not a file${from}. Name a file inside it`);
    }
  } catch (err) {
    if (isNonRetryable(err)) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw nonRetryable(
        `Upload file not found: ${abs}${from}. Put the file there or correct the step's path`,
      );
    }
    throw nonRetryable(
      `Upload file ${abs} cannot be read: ${err instanceof Error ? err.message : String(err)}. `
      + `Check the file's permissions`,
    );
  }

  return abs;
}

/** An error the runner must not retry or heal — the code is fine, the file is not. */
export function nonRetryable(message: string): Error & { retryable: false } {
  return Object.assign(new Error(message), { retryable: false as const });
}

export function isNonRetryable(err: unknown): boolean {
  return (
    typeof err === 'object'
    && err !== null
    && (err as { retryable?: unknown }).retryable === false
  );
}
